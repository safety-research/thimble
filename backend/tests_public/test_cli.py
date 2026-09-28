"""The supervisor (app.cli): `thimble server up | stop`, doctor, launch-args and the launcher script. `server up` prints
one line and exits 0 whatever happens, refuses $HOME and /, and starts one server when two race; stop signals only a pid
whose command line is this checkout's server. Unit tests fake `spawn`, `healthy` and `_request`; one integration test
starts a real uvicorn on a free port under a scratch THIMBLE_HOME. The supervisor records nothing about auth, and
`doctor` names the path of a credential, never its value."""
from __future__ import annotations

import contextlib
import json
import os
import socket
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from app import cli, config, procs

SECRET = "sk-ant-test-secret-never-written"  # gitleaks:allow  a fake key asserting nothing writes it
REAL_FOREIGN_HOME = cli.foreign_home  # the `home` fixture fakes it; the test of it puts it back
REAL_INSTALLED_COPY = cli.installed_copy  # conftest fakes it; the tests of it put it back
BACKEND = Path(__file__).resolve().parents[1]

pytestmark = pytest.mark.usefixtures("named_sessions")


class FakeSpawn:
    """Records spawns; the first backend spawn flips `up` after `delay` so health probes start succeeding."""

    def __init__(self, delay: float = 0.3):
        self.calls: list[dict] = []
        self.up = False
        self.delay = delay
        self.lock = threading.Lock()

    def __call__(self, cmd, *, cwd, env, log_file):
        with self.lock:
            self.calls.append({"cmd": cmd, "cwd": str(cwd), "env": dict(env), "log": str(log_file)})
            n = len(self.calls)
        if "uvicorn" in cmd:
            def flip():
                time.sleep(self.delay)
                self.up = True
            threading.Thread(target=flip, daemon=True).start()
        return 40000 + n


@pytest.fixture()
def fake(monkeypatch, home):
    sp = FakeSpawn()
    monkeypatch.setattr(cli, "spawn", sp)
    monkeypatch.setattr(cli, "healthy", lambda url=None, timeout=1.0: sp.up)
    monkeypatch.setattr(cli, "pid_alive", lambda pid: False)
    monkeypatch.setattr(cli, "spawned_exited", lambda pid: False)  # its made-up pids run until they answer
    monkeypatch.setattr(cli, "listening", lambda p: False)
    # the uvicorns it spawned are thimble servers once they answer (cli.reconcile keeps their pid)
    monkeypatch.setattr(cli, "is_server", lambda pid, p, repo=None: sp.up and isinstance(pid, int) and 40000 < pid <= 40000 + len(sp.calls))
    return sp


# ----------------------------------------------------------------------------- imports and the plugin's scripts


def test_two_concurrent_ups_start_one_uvicorn(fake, home):
    results: list[bool] = []

    def run():
        results.append(cli.ensure_running(2.0))

    threads = [threading.Thread(target=run) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(10)
    assert results == [True, True]
    assert sum(1 for c in fake.calls if "uvicorn" in c["cmd"]) == 1
    st = json.loads((home / "server.json").read_text())
    assert st["pid"] == 40001 and st["port"] == 8300 and st["api"] == "http://127.0.0.1:8300"


def _healthy_no_process(monkeypatch):
    monkeypatch.setattr(cli, "ensure_running", lambda wait: True)
    monkeypatch.setattr(cli, "healthy", lambda url=None, timeout=1.0: True)
    monkeypatch.setattr(cli, "listening", lambda p: False)
    cli.write_state({"port": 8300, "url": "http://127.0.0.1:5300", "env": {}})


def test_up_prints_the_url_and_opens_a_sessions_folder(home, data, monkeypatch, capsys, tmp_path):
    _healthy_no_process(monkeypatch)
    posted = []  # the registrations; the holdings GET under the URL is answered 404 (an older server) and not recorded

    def request(m, u, b=None, timeout=5.0):
        if m != "POST":
            return 404, {"detail": "Not Found"}
        posted.append((u, b))
        return 201, {"name": Path(b["path"]).name}

    monkeypatch.setattr(cli, "_request", request)
    rc = cli.main(["up", "--cwd", str(data / "mini" / "agents"), "--session", "s9"])
    assert rc == 0 and capsys.readouterr().out.splitlines() == ["thimble: http://127.0.0.1:5300/?ws=mini"]
    assert posted == [], "a folder inside the data dir is known already"
    folder = tmp_path / "calls"
    folder.mkdir()
    assert cli.main(["ensure", "--cwd", str(folder), "--session", "s9"]) == 0
    assert capsys.readouterr().out.splitlines() == ["thimble: http://127.0.0.1:5300/?ws=calls"]
    assert posted == [("http://127.0.0.1:8300/api/corpora/register", {"path": str(folder), "exact": True})]
    assert cli.main(["up", "--cwd", str(folder)]) == 0, "a bare up from a shell"
    assert capsys.readouterr().out.splitlines() == ["thimble: http://127.0.0.1:5300/"] and len(posted) == 1
    assert cli.build_parser().parse_args(["up"]).cmd == "up" and cli.build_parser().parse_args(["ensure"]).cmd == "ensure"
    assert "up (ensure)" in cli.build_parser().format_help()


def test_doctor_with_server_down_names_the_auth_path_and_the_stack_never_a_value(home, monkeypatch, tmp_path):
    monkeypatch.delenv("THIMBLE_SKIP_KEY", raising=False)
    monkeypatch.setattr(config, "REPO_ROOT", tmp_path / "repo")
    monkeypatch.setenv("ANTHROPIC_API_KEY", SECRET)
    monkeypatch.setattr(cli, "healthy", lambda url=None, timeout=1.0: False)
    monkeypatch.setattr(cli, "listening", lambda p: p == 8301)
    home.mkdir(parents=True)
    (home / "server.log").write_text("\n".join(f"line {i}" for i in range(30)) + "\n")
    text = cli.doctor_text()
    assert SECRET not in text
    assert "server: down at http://127.0.0.1:8300" in text
    assert "  auth: env credential (ANTHROPIC_API_KEY)" in text
    assert "validation stack: 8301 busy, 5301 free" in text
    assert "last apply: none" in text and "last ticket error: none" in text
    assert "sessions:" not in text and "bash mode" not in text
    tail = text.split("log tail")[1]
    assert "line 29" in tail and "line 14" not in tail
    monkeypatch.delenv("ANTHROPIC_API_KEY")
    settings = Path(os.environ["CLAUDE_CONFIG_DIR"]) / "settings.json"
    settings.write_text(json.dumps({"apiKeyHelper": "fetch-key secret-ref"}))
    text = cli.doctor_text()
    assert f"  auth: apiKeyHelper in {settings}" in text and "secret-ref" not in text
    settings.unlink()
    (Path(os.environ["CLAUDE_CONFIG_DIR"]) / ".credentials.json").write_text("{}")
    assert "  auth: CLI login (" in cli.doctor_text()
    (Path(os.environ["CLAUDE_CONFIG_DIR"]) / ".credentials.json").unlink()
    assert "  auth: none: no ANTHROPIC_API_KEY, no apiKeyHelper" in cli.doctor_text()


def test_doctor_runs_no_command_for_auth(home, monkeypatch):
    def boom(*a, **k):
        raise AssertionError("doctor must not run a helper")

    monkeypatch.setattr(config.subprocess, "run", boom)
    monkeypatch.setattr(cli, "_git", lambda *a: "")
    monkeypatch.setattr(cli, "git_branch", lambda: "main")
    monkeypatch.setattr(cli, "healthy", lambda url=None, timeout=1.0: False)
    assert "auth:" in cli.doctor_text()


SERVER_LIKE = [sys.executable, "-c", "import time; time.sleep(60)", "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1",
               "--port", "8398", "--timeout-graceful-shutdown", "3"]


def _started(proc: subprocess.Popen, word: str = "8398") -> subprocess.Popen:
    """The child once it has exec'd, when its command line holds `word`. Popen returns as soon as the child is forked,
    and until the exec its command line reads empty or as the parent's."""
    deadline = time.monotonic() + 5
    while word not in " ".join(procs.argv(proc.pid)) and time.monotonic() < deadline:
        time.sleep(0.02)
    return proc


def test_stop_kills_only_a_pid_whose_command_line_is_ours(home):
    ours = _started(subprocess.Popen(SERVER_LIKE, start_new_session=True, cwd=cli.BACKEND_DIR))
    other = _started(subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"], start_new_session=True),
                     "time.sleep(60)")
    try:
        cli.write_state({"port": 8398, "pid": other.pid, "vite_pid": None})
        lines = cli.stop()
        assert lines[0].startswith("kernels: none running") and "not ours" in lines[1] and other.poll() is None
        cli.write_state({"port": 8398, "pid": ours.pid, "vite_pid": None})
        lines = cli.stop()
        assert lines[1] in (f"server: pid {ours.pid} stopped", f"server: pid {ours.pid} killed")
        ours.wait(5)
        assert cli.read_state()["pid"] is None and cli.read_state()["stopped"]
    finally:
        for p in (ours, other):
            if p.poll() is None:
                p.kill()
                p.wait(5)


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _uvicorns_on(p: int) -> list[int]:
    out: list[int] = []
    for entry in Path("/proc").glob("[0-9]*/cmdline"):
        try:
            b = entry.read_bytes()
        except OSError:
            continue
        if b"uvicorn" in b and f"--port\0{p}".encode() in b:
            out.append(int(entry.parent.name))
    return out


def test_real_up_starts_a_detached_server_idempotently_and_stop_ends_it(home, data, tmp_path):
    probe = subprocess.run([sys.executable, "-c", "import app.main"], cwd=BACKEND, capture_output=True, text=True, timeout=120,
                           env={**os.environ, "THIMBLE_SKIP_KEY": "1"})
    if probe.returncode != 0:
        pytest.skip("app.main does not import in this tree: " + probe.stderr.strip().splitlines()[-1][:200])
    port = _free_port()
    env = {**os.environ, "THIMBLE_HOME": str(home), "THIMBLE_PORT": str(port), "THIMBLE_SKIP_KEY": "1",
           "THIMBLE_DATA_DIR": str(data), "THIMBLE_WORKSPACES_DIR": str(tmp_path / "ws")}
    env.pop("THIMBLE_DEV", None)
    # a claude.ai login in the session's config dir, so the launcher's channel stands and /thimble prints the URL alone
    (tmp_path / "claude-home" / ".credentials.json").write_text(json.dumps({"claudeAiOauth": {"accessToken": "t",
                                                                                              "scopes": ["user:inference"]}}))
    for k in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_PROFILE"):
        env.pop(k, None)
    cmd = [sys.executable, "-m", "app.cli", "server", "up", "--cwd", str(data / "mini"), "--session", "it-1"]
    pid = None
    try:
        t0 = time.monotonic()
        out = subprocess.run(cmd, cwd=BACKEND, env=env, capture_output=True, text=True, timeout=90)
        first = time.monotonic() - t0
        lines = out.stdout.splitlines()
        # the URL alone: the workspace holds nothing from an earlier run, so there is nothing to resume
        assert out.returncode == 0 and lines == [f"thimble: http://127.0.0.1:{port}/?ws=mini"], out
        st = json.loads((home / "server.json").read_text())
        pid = st["pid"]
        assert cli.pid_alive(pid) and st["port"] == port and st["env"]["data_dir"] == str(data)
        assert os.getsid(pid) == pid, "uvicorn is its own session leader"
        assert int(Path(f"/proc/{pid}/stat").read_text().split()[3]) != os.getpid()
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health", timeout=5) as r:
            health = json.loads(r.read())
            assert {k: health[k] for k in ("ok", "leader")} == {"ok": True, "leader": pid}, "the server names the pid server.json records"
            assert len(str(health.get("boot") or "")) == 8, "and a boot token new for each start"
        t1 = time.monotonic()
        out2 = subprocess.run(cmd, cwd=BACKEND, env=env, capture_output=True, text=True, timeout=30)
        assert out2.stdout.splitlines() == lines and json.loads((home / "server.json").read_text())["pid"] == pid
        assert time.monotonic() - t1 < first + 1.0, "idempotent: no second start"
        assert len(_uvicorns_on(port)) == 1
        stop = subprocess.run([sys.executable, "-m", "app.cli", "stop"], cwd=BACKEND, env=env, capture_output=True,
                              text=True, timeout=30)
        assert f"pid {pid}" in stop.stdout
        deadline = time.monotonic() + 10
        while cli.pid_alive(pid) and time.monotonic() < deadline:
            time.sleep(0.1)
        assert not cli.pid_alive(pid)
    finally:
        if pid and cli.pid_alive(pid):
            os.kill(pid, 9)
        for q in _uvicorns_on(port):
            with contextlib.suppress(ProcessLookupError, PermissionError):
                os.kill(q, 9)


def _healthy_with_state(monkeypatch, fingerprint: str, pid: int = 4242, alive: bool = True) -> None:
    """A healthy server recorded in server.json, in dev mode (auto-restart is gated on THIMBLE_DEV); `alive` says whether
    the recorded pid (and the restart's 5151) is a live process, i.e. whether the server is ours."""
    monkeypatch.setattr(cli, "healthy", lambda url=None, timeout=1.0: True)
    monkeypatch.setattr(cli, "listening", lambda p: p == cli.DEFAULT_UI_PORT)  # Vite up: nothing to spawn
    monkeypatch.setattr(cli, "pid_alive", lambda q: alive and q in (pid, 5151))
    monkeypatch.setattr(cli, "is_server", lambda q, p, repo=None: alive and q in (pid, 5151))
    monkeypatch.setenv("THIMBLE_DEV", "1")
    cli.write_state({"port": 8300, "pid": pid, "api": "http://127.0.0.1:8300", "url": "http://127.0.0.1:8300",
                     "repo": str(config.REPO_ROOT), "source_fingerprint": fingerprint, "env": {}})


def _restart_seam(monkeypatch) -> list[int]:
    calls: list[int] = []

    def fake_spawn_restart():
        calls.append(1)
        st = cli.read_state()
        st.update({"pid": 5151, "source_fingerprint": cli.source_fingerprint()})
        st.pop("source_restart", None)
        cli.write_state(st)
        return 777

    monkeypatch.setattr(cli, "spawn_restart", fake_spawn_restart)
    return calls


def test_up_refuses_home_and_root_and_starts_nothing(home, data, monkeypatch, capsys, tmp_path):
    started = []
    monkeypatch.setattr(cli, "ensure_running", lambda wait: started.append(1) or True)
    monkeypatch.setattr(cli, "_request", lambda *a, **k: (500, {}))
    for folder in (Path.home(), Path("/"), Path("~")):
        assert cli.refused(folder) is True
        assert cli.main(["up", "--cwd", str(folder), "--session", "s1"]) == 0
        line = capsys.readouterr().out.splitlines()
        assert line == [cli.REFUSED_LINE.format(path=folder)] and "http://" not in line[0], folder
    assert started == [] and not cli.server_json().exists()
    assert cli.refused(data / "mini") is False and cli.refused(tmp_path) is False


class _Health:
    """A stand-in server on a free port whose /api/health names `home` (none when None, as a server older than the
    field answers)."""

    def __init__(self, home: str | None) -> None:
        self.home = home
        outer = self

        class H(BaseHTTPRequestHandler):
            def do_GET(self):  # noqa: N802
                body = json.dumps({"ok": True, **({"home": outer.home} if outer.home else {})}).encode()
                self.send_response(200 if self.path == "/api/health" else 404)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *a):
                pass

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.port = self.httpd.server_address[1]
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def close(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()


def _installed_copy(tmp_path: Path, monkeypatch, enabled: bool = True) -> tuple[Path, str]:
    """A copy of plugin/ where Claude Code keeps an installed plugin, a stand-in `claude` whose `plugin list --json`
    lists it, and the pointer its bin/thimble-app-dir follows to this tree. Returns the copy and its channel entry."""
    name = json.loads(cli.MARKETPLACE_FILE.read_text())["name"]
    root = tmp_path / "claude-home" / "plugins" / "cache" / name / "thimble" / "9.9.9"
    import shutil  # noqa: PLC0415

    shutil.copytree(cli.PLUGIN_DIR, root, ignore=shutil.ignore_patterns("__pycache__", "*.pyc", ".DS_Store"))
    listing = tmp_path / "plugin-list.json"
    listing.write_text(json.dumps([{"id": "other@elsewhere", "enabled": True, "installPath": str(tmp_path)},
                                   {"id": f"thimble@{name}", "enabled": enabled, "installPath": str(root)}]))
    stub = tmp_path / "stub-bin"
    stub.mkdir(exist_ok=True)
    (stub / "claude").write_text(STUB_CLAUDE)
    (stub / "claude").chmod(0o755)
    monkeypatch.setenv("PATH", f"{stub}{os.pathsep}{os.environ.get('PATH', '')}")
    monkeypatch.setenv("STUB_LIST", str(listing))
    monkeypatch.setenv("STUB_OUT", str(tmp_path))
    monkeypatch.delenv("THIMBLE_APP_DIR", raising=False)
    (Path(os.environ["THIMBLE_HOME"])).mkdir(parents=True, exist_ok=True)
    (Path(os.environ["THIMBLE_HOME"]) / "app-dir").write_text(f"{config.REPO_ROOT}\n")
    monkeypatch.delenv("STUB_MARKETPLACES", raising=False)
    monkeypatch.setattr(cli, "installed_copy", REAL_INSTALLED_COPY)
    return root.resolve(), f"plugin:thimble@{name}"


def _directory_marketplace(tmp_path: Path, monkeypatch, source: Path) -> None:
    """The stand-in `claude` lists the marketplace as a directory source at `source`, the way scripts/install.sh
    registers a checkout or a release."""
    name = json.loads(cli.MARKETPLACE_FILE.read_text())["name"]
    listing = tmp_path / "marketplaces.json"
    listing.write_text(json.dumps([{"name": "other", "source": "directory", "path": str(tmp_path)},
                                   {"name": name, "source": "directory", "path": str(source)}]))
    monkeypatch.setenv("STUB_MARKETPLACES", str(listing))


# ----------------------------------------------------------------------------- the Bash sandbox and a stale record


STUB_CLAUDE = """#!/bin/sh
# a stand-in `claude`: `plugin marketplace list --json` prints the file $STUB_MARKETPLACES names and `plugin list
# --json` the file $STUB_LIST names (nothing without one); any other call records its arguments and the idle limit it
# was given, then exits
if [ "$1 $2" = "plugin marketplace" ]; then [ -z "${STUB_MARKETPLACES:-}" ] || cat "$STUB_MARKETPLACES"; exit 0; fi
if [ "$1" = plugin ]; then [ -z "${STUB_LIST:-}" ] || cat "$STUB_LIST"; exit 0; fi
printf '%s\\n' "$@" > "$STUB_OUT/argv"
printf '%s' "${CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT:-}" > "$STUB_OUT/idle"
"""


def _launcher_env(tmp_path: Path) -> dict[str, str]:
    """The launcher's environment with a stand-in `claude` first on PATH, a scratch home and a port nothing uses."""
    stub = tmp_path / "stub-bin"
    stub.mkdir(exist_ok=True)
    (stub / "claude").write_text(STUB_CLAUDE)
    (stub / "claude").chmod(0o755)
    out = tmp_path / "stub-out"
    out.mkdir(exist_ok=True)
    env = {k: v for k, v in os.environ.items() if not k.startswith(("CLAUDE", "THIMBLE_"))}
    env.update({"PATH": f"{stub}{os.pathsep}{os.environ.get('PATH', '')}", "HOME": str(tmp_path),
                "THIMBLE_HOME": str(tmp_path / "home"), "THIMBLE_PORT": str(_free_port()), "STUB_OUT": str(out),
                "CLAUDE_CONFIG_DIR": str(tmp_path / "claude-home")})
    return env


SID_A = "aaaaaaaa-0000-4000-8000-000000000001"
SID_B = "bbbbbbbb-0000-4000-8000-000000000002"


def _main_sessions(tmp_path: Path, env: dict[str, str], corpus: Path) -> dict[str, Path]:
    """The corpus `mini` under a scratch data dir, and its workspace's sessions.json with two ended main sessions whose
    transcripts are in the launcher's Claude Code config dir, B written after A."""
    env.update({"THIMBLE_DATA_DIR": str(corpus.parent), "THIMBLE_WORKSPACES_DIR": str(tmp_path / "ws")})
    (corpus / "manifest.json").write_text('{"name": "mini"}')
    projects = Path(env["CLAUDE_CONFIG_DIR"]) / "projects" / "-corpus"
    projects.mkdir(parents=True, exist_ok=True)
    paths = {}
    for n, sid in enumerate((SID_A, SID_B)):
        paths[sid] = projects / f"{sid}.jsonl"
        paths[sid].write_text('{"type": "user"}\n')
        os.utime(paths[sid], (1_700_000_000 + n, 1_700_000_000 + n))
    recs = {sid: {"session": sid, "cwd": str(corpus), "transcript_path": str(t), "pid": 1, "ended": "t",
                  "since": "2026-09-25T10:00:00+00:00"} for sid, t in paths.items()}
    (tmp_path / "ws" / "mini").mkdir(parents=True, exist_ok=True)
    (tmp_path / "ws" / "mini" / "sessions.json").write_text(json.dumps(recs))
    return paths
