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


def test_import_cli_never_imports_notebook_or_dev():
    code = ("import app.cli, sys; "
            "assert 'app.notebook' not in sys.modules, 'notebook'; "
            "assert 'app.dev' not in sys.modules, 'dev'; print('ok')")
    out = subprocess.run([sys.executable, "-c", code], cwd=BACKEND, capture_output=True, text=True, timeout=60)
    assert out.returncode == 0 and out.stdout.strip() == "ok", out.stderr


def test_plugin_wrapper_launches_claude_with_the_plugin_as_a_channel_and_main_s_prompt():
    """`thimble` starts Claude Code in the folder with the plugin loaded and registered as a channel, main's prompt
    appended (rendered by `launch-args`, the folder captured before the cd to backend/), the thimble tools allowed,
    THIMBLE_CHANNEL exported for the shim and /thimble, and /thimble as the first prompt."""
    script = config.REPO_ROOT / "plugin" / "bin" / "thimble"
    text = script.read_text()
    assert os.access(script, os.X_OK)
    assert "-m app.cli" in text and 'cd "$repo/backend"' in text and "THIMBLE_CALLER_CWD" in text
    assert 'channel="${out%%$\'\\n\'*}"' in text and 'export THIMBLE_CHANNEL="$channel"' in text
    assert '[ "$channel" != "plugin:thimble@inline" ] || load=(--plugin-dir "$plugin")' in text
    assert 'cwd="$PWD"' in text and 'launch-args ${ask[@]+"${ask[@]}"} --cwd "$cwd"' in text
    assert 'tools=(--allowedTools "$allowed")' in text and "--disallowedTools" not in text
    assert '[ -z "$effort" ] || tools+=(--effort "$effort")' in text
    exec_line = next(ln for ln in text.splitlines() if ln.lstrip().startswith("exec claude "))
    assert '${load[@]+"${load[@]}"}' in exec_line and '"$channel"' in exec_line and '"${tools[@]}"' in exec_line
    assert '--append-system-prompt "$prompt" "$@" -- /thimble' in text
    for widening in ("--mcp-config", "--settings", "--dangerously-skip-permissions"):
        assert widening not in text, "the launcher never overrides the analyst's settings or permissions"
    line = next(ln for ln in text.splitlines() if ln.startswith("SUPERVISOR_COMMANDS="))
    assert line == 'SUPERVISOR_COMMANDS=" server up ensure stop restart doctor fix revert update list purge launch-args prompt "'
    assert '  feedback)\n    shift; feedback "$@";;' in text, "feedback runs feedback.py alone, not through the supervisor"
    alias = config.REPO_ROOT / "plugin" / "bin" / "thimble-server"
    assert os.access(alias, os.X_OK) and 'exec "$here/thimble" "$@"' in alias.read_text()


def test_the_dispatcher_runs_uninstall_itself_and_resolves_its_own_symlink():
    text = (config.REPO_ROOT / "plugin" / "bin" / "thimble").read_text()
    assert "\nuninstall() {" in text and "\n  uninstall)\n" in text
    assert "resolve_link()" in text and 'self="$(resolve_link "${BASH_SOURCE[0]}")"' in text
    assert "uninstall" in (config.REPO_ROOT / "plugin" / "bin" / "thimble-server").read_text().split("usage:")[1].splitlines()[0]
    skill = (config.REPO_ROOT / "plugin" / "skills" / "thimble" / "SKILL.md").read_text()
    assert "uninstall" not in skill and "--value" not in skill and "--session" in skill
    assert "server up --cwd" in skill and "block-bash" not in skill and "threads" not in skill


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


def test_server_json_carries_names_never_the_key(fake, home, monkeypatch, tmp_path):
    monkeypatch.setenv("ANTHROPIC_API_KEY", SECRET)
    monkeypatch.setenv("THIMBLE_DATA_DIR", str(tmp_path / "d"))
    monkeypatch.setenv("THIMBLE_WORKSPACES_DIR", str(tmp_path / "w"))
    monkeypatch.setenv("CLAUDE_PLUGIN_ROOT", "/x/plugin")
    monkeypatch.setenv("CLAUDECODE", "1")
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", "/x/cfg")
    monkeypatch.setenv("THIMBLE_PORT", "8399")
    st = cli.start()
    text = (home / "server.json").read_text()
    assert SECRET not in text
    assert st["port"] == 8399 and st["env"] == {
        "data_dir": str(tmp_path / "d"), "workspaces_dir": str(tmp_path / "w"),
        "plugin_dir": str(config.REPO_ROOT / "plugin"), "home": str(home)}
    assert st["url"] == "http://127.0.0.1:8399"
    env = fake.calls[0]["env"]
    assert env["THIMBLE_PORT"] == "8399" and env["THIMBLE_HOME"] == str(home) and env["THIMBLE_DEV"] == "0"
    assert env["ANTHROPIC_API_KEY"] == SECRET, "the shell's credential reaches the server as it reaches `claude`"
    assert env["THIMBLE_DATA_DIR"] == str(tmp_path / "d") and env["THIMBLE_FRONTEND_URL"] == "http://127.0.0.1:5300"
    assert "CLAUDE_PLUGIN_ROOT" not in env and "CLAUDECODE" not in env and env["CLAUDE_CONFIG_DIR"] == "/x/cfg"
    log = (home / "server.log").read_text()
    assert SECRET not in log and "auth" in log
    assert fake.calls[0]["cmd"][1:4] == ["-m", "uvicorn", "app.main:app"] and "--reload" not in fake.calls[0]["cmd"]
    assert fake.calls[0]["cwd"] == str(config.REPO_ROOT / "backend")


def test_resolve_env_reuses_server_json_names_and_records_nothing_about_auth(home, monkeypatch):
    assert sorted(cli.resolve_env()) == ["data_dir", "dev", "home", "plugin_dir", "workspaces_dir"]
    cli.write_state({"port": 8300, "env": {"data_dir": "/d", "workspaces_dir": "/w", "key_ref_name": "old-ref"}})
    env = cli.resolve_env()
    assert env["data_dir"] == "/d" and env["workspaces_dir"] == "/w" and "key_ref_name" not in env
    monkeypatch.setenv("THIMBLE_DATA_DIR", "/d2")
    assert cli.resolve_env()["data_dir"] == "/d2"


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


def test_up_says_what_failed_instead_of_the_url_and_warns_before_start(home, data, monkeypatch, capsys, tmp_path):
    _healthy_no_process(monkeypatch)
    folder = tmp_path / "calls"
    folder.mkdir()
    answers = {"/corpora/register": (500, {"detail": "disk full"})}
    monkeypatch.setattr(cli, "_request", lambda m, u, b=None, timeout=5.0: answers[u.split("/api", 1)[1]])
    assert cli.main(["server", "up", "--cwd", str(folder), "--session", "s1"]) == 0
    line = cli.REGISTER_FAILED_LINE.format(path=folder, log=cli.log_path())
    assert capsys.readouterr().out.splitlines() == [line] and "http://" not in line and str(folder) in line
    assert "disk full" in cli.log_path().read_text()
    assert cli.main(["server", "up", "--cwd", str(folder)]) == 0
    assert capsys.readouterr().out.splitlines() == ["thimble: http://127.0.0.1:5300/"]
    answers["/corpora/register"] = (201, {"name": "calls"})
    dist = Path(os.environ["THIMBLE_FRONTEND_DIST"])
    (dist / "index.html").unlink()
    assert cli.main(["server", "up", "--cwd", str(folder), "--session", "s1"]) == 0
    assert capsys.readouterr().out.splitlines() == ["thimble: http://127.0.0.1:5300/?ws=calls", cli.NO_UI_LINE]
    assert config.NO_UI_BUILD_HINT in cli.log_path().read_text()
    (dist / "index.html").write_text("<html></html>")
    monkeypatch.delenv("THIMBLE_SKIP_KEY", raising=False)
    for k in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"):
        monkeypatch.delenv(k, raising=False)
    assert cli.auth_missing() is True
    assert cli.main(["server", "up", "--cwd", str(folder), "--session", "s1"]) == 0
    assert capsys.readouterr().out.splitlines() == ["thimble: http://127.0.0.1:5300/?ws=calls", cli.NO_AUTH_LINE]
    monkeypatch.setenv("ANTHROPIC_API_KEY", SECRET)
    assert cli.auth_missing() is False
    assert cli.main(["server", "up", "--cwd", str(folder), "--session", "s1"]) == 0
    assert capsys.readouterr().out.splitlines() == ["thimble: http://127.0.0.1:5300/?ws=calls"]
    assert SECRET not in cli.log_path().read_text()
    monkeypatch.delenv("ANTHROPIC_API_KEY")
    monkeypatch.setenv("THIMBLE_SKIP_KEY", "1")
    assert cli.auth_missing() is False
    cli.NOTICES.clear()
    monkeypatch.setattr(cli, "ensure_running",
                        lambda wait: (cli.NOTICES.append(cli.NOT_RESTARTED_LINE.format(reason="a job is running")), True)[1])
    assert cli.main(["server", "up", "--cwd", str(folder), "--session", "s1"]) == 0
    assert capsys.readouterr().out.splitlines() == ["thimble: http://127.0.0.1:5300/?ws=calls",
                                                    "thimble: source changed since the server started; not restarting while a job is running"]
    assert cli.NOTICES == []


def test_up_with_the_server_down_says_so(home, data, monkeypatch, capsys):
    monkeypatch.setattr(cli, "ensure_running", lambda wait: False)
    monkeypatch.setattr(cli, "healthy", lambda url=None, timeout=1.0: False)
    assert cli.main(["up", "--cwd", str(data / "mini"), "--session", "s1"]) == 0
    out = capsys.readouterr().out.splitlines()
    assert out[0].startswith("thimble: the server did not start within") and "thimble doctor" in out[1]
    assert out[2] == cli.REPORT_LINE and "/thimble feedback" in out[2]


def test_uninstall_and_unknown_actions_start_nothing(home, data, monkeypatch, capsys, tmp_path):
    def never(wait):
        raise AssertionError("must not start the server")

    monkeypatch.setattr(cli, "ensure_running", never)
    monkeypatch.setattr(cli, "_request", lambda *a, **k: (_ for _ in ()).throw(AssertionError("no request")))
    cwd = str(data / "mini")
    for argv in (["ensure", "--cwd", cwd, "--session", "abc", "--action", "uninstall"],
                 ["server", "up", "--cwd", cwd, "--session", "abc", "--action", "uninstall"]):
        assert cli.main(argv) == 0
        assert capsys.readouterr().out.strip() == cli.UNINSTALL_SHELL_LINE
    assert not (tmp_path / "ws").exists() and not (home / "server.json").exists()
    monkeypatch.setattr(cli, "ensure_running", lambda wait: True)
    monkeypatch.setattr(cli, "healthy", lambda url=None, timeout=1.0: True)
    assert cli.main(["ensure", "--cwd", cwd, "--action", "orient"]) == 0
    assert capsys.readouterr().out.strip() == "thimble: unknown action 'orient'; one of status, fix, fresh, restore, feedback."


def test_up_never_raises_and_exits_zero(home, monkeypatch, capsys):
    def boom(wait):
        raise RuntimeError("lock exploded")

    monkeypatch.setattr(cli, "ensure_running", boom)
    assert cli.main(["ensure"]) == 0
    assert capsys.readouterr().out.startswith("thimble: ensure failed (RuntimeError)")
    assert "lock exploded" in (home / "server.log").read_text()


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


def test_server_identity_is_the_command_line_not_argv0():
    mac = ["/opt/homebrew/Cellar/python@3.12/3.12.6/Frameworks/Python.framework/Versions/3.12/Resources/Python.app/Contents/MacOS/Python",
           "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", "8300", "--timeout-graceful-shutdown", "3"]
    assert cli.server_argv_matches(mac, 8300)
    assert cli.server_argv_matches(cli.backend_cmd(8300), 8300)
    assert cli.server_argv_matches(cli.backend_cmd(8300, dev=True), 8300)
    assert cli.server_argv_matches(["/x/backend/.venv/bin/uvicorn", "app.main:app", "--port=8300"], 8300)
    assert not cli.server_argv_matches(mac, 8301)
    assert not cli.server_argv_matches(mac[:-4] + ["--port", "83000"], 8300)
    assert not cli.server_argv_matches(["sleep", "60"], 8300) and not cli.server_argv_matches([], 8300)
    assert not cli.server_argv_matches([sys.executable, "-m", "uvicorn", "other:app", "--port", "8300"], 8300)


def test_stop_refuses_a_reused_pid_and_says_how_to_stop_by_hand(home):
    other = _started(subprocess.Popen(["sleep", "60"], start_new_session=True), "sleep 60")
    try:
        cli.write_state({"port": 8398, "pid": other.pid, "vite_pid": None})
        line = cli.stop()[1]
        assert line == (f"server: pid {other.pid} is not ours (its command line is 'sleep 60', not uvicorn app.main:app "
                        f"--port 8398); left alone. If it is thimble's server after all, stop it by hand: kill {other.pid}")
        assert other.poll() is None
    finally:
        other.kill()
        other.wait(5)


def test_server_check_refuses_a_server_working_outside_this_checkout_unless_server_json_recorded_it(home, tmp_path):
    elsewhere = tmp_path / "other" / "backend"
    elsewhere.mkdir(parents=True)
    proc = _started(subprocess.Popen(SERVER_LIKE, start_new_session=True, cwd=elsewhere))
    try:
        reason = cli.server_check(8398)(proc.pid)
        assert reason == f"it runs uvicorn app.main:app on port 8398 from {elsewhere.resolve()}, not this checkout ({config.REPO_ROOT})"
        assert cli.server_check(8398, repo=str(tmp_path / "other"))(proc.pid) is None
    finally:
        proc.kill()
        proc.wait(5)


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


def test_a_server_thimble_did_not_start_is_left_alone(home, monkeypatch):
    """A stale server.json (a pid that is no thimble server) beside a healthy server the launcher did not start. The
    stale pid is cleared (cli.reconcile), no restart is spawned, no restart.json is left for the announcement, no notice
    is printed, and the log says why."""
    _healthy_with_state(monkeypatch, "stale", alive=False)
    calls = _restart_seam(monkeypatch)
    monkeypatch.setattr(cli, "busy_reason", lambda url: None)
    cli.NOTICES.clear()
    assert cli.owned() is False
    assert cli.ensure_running(2.0) is True
    assert calls == [] and cli.NOTICES == [] and cli.read_state()["pid"] is None
    assert not (home / "restart.json").exists() and "source_restart" not in cli.read_state()
    log = cli.log_path().read_text()
    assert "server.json named pid 4242, which is not a thimble server on port 8300; cleared" in log
    assert "server.json names no thimble server of this checkout" in log
    # in dev mode with Vite down, a foreign server gets no Vite either
    monkeypatch.setattr(cli, "listening", lambda p: False)
    started = []
    monkeypatch.setattr(cli, "start_vite", lambda ui, p, environ=None: started.append(ui) or 999)
    assert cli.ensure_running(2.0) is True and started == [] and "vite_pid" not in cli.read_state()
    _healthy_with_state(monkeypatch, cli.source_fingerprint(), alive=True)
    monkeypatch.setattr(cli, "listening", lambda p: False)
    assert cli.ensure_running(2.0) is True and started == [5300] and cli.read_state()["vite_pid"] == 999


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


def test_up_refuses_the_server_of_another_install_on_its_port(home, data, monkeypatch, capsys):
    """Two installs use the same port by default. When the server answering there names another THIMBLE_HOME, `server
    up` says so in one line with the two ways out, starts nothing and opens nothing, and `restart` refuses too. This
    install's own server, and a server too old to name its home, are used."""
    monkeypatch.setattr(cli, "foreign_home", REAL_FOREIGN_HOME)
    other = "/elsewhere/.thimble"
    srv = _Health(other)
    try:
        monkeypatch.setenv("THIMBLE_PORT", str(srv.port))
        started: list = []
        monkeypatch.setattr(cli, "ensure_running", lambda wait: started.append(1) or True)
        monkeypatch.setattr(cli, "restart", lambda keep_vite=False: started.append(2) or [])
        assert cli.main(["server", "up", "--cwd", str(data / "mini"), "--session", "s1"]) == 0
        out = capsys.readouterr().out.splitlines()
        assert out == [cli.FOREIGN_LINE.format(port=srv.port, other=other)]
        assert "THIMBLE_PORT" in out[0] and f"THIMBLE_HOME={other} thimble server stop" in out[0]
        assert cli.main(["server", "restart"]) == 1
        assert capsys.readouterr().out.splitlines() == out
        assert started == []
        srv.home = str(home)
        assert cli.foreign_home(cli.api_url()) is None, "this install's own server"
        srv.home = None
        assert cli.foreign_home(cli.api_url()) is None, "a server older than the field"
    finally:
        srv.close()


def test_the_server_names_its_install_in_its_health(home, monkeypatch):
    """/api/health carries the THIMBLE_HOME and the tree the server runs with, which foreign_home compares."""
    from fastapi.testclient import TestClient

    from app import main

    body = TestClient(main.create_app()).get("/api/health").json()
    assert body["ok"] is True and Path(body["home"]) == Path(str(home)).resolve()
    assert Path(body["app"]) == Path(config.REPO_ROOT).resolve()


def test_fresh_archives_the_workspace_and_opens_an_empty_one(home, data, monkeypatch, capsys, tmp_path, named_sessions):
    """`/thimble fresh`: `POST /api/ws/{c}/archive` before the URL, then FRESH_LINE with the folder, where the workspace
    went and the command that brings it back; NOTHING_ARCHIVED_LINE when it had no
    folder, ARCHIVE_FAILED_LINE when the server did not archive it (an older server); no resume line either way. The
    session is named after the archive, so it attaches to the empty workspace."""
    _healthy_no_process(monkeypatch)
    calls: list[tuple] = []
    gone = "/ws/.archive/mini-2026-09-23-153012"
    answer = [(200, {"archived": gone})]

    def request(method, url, body=None, timeout=5.0):
        calls.append((method, url.split("/api", 1)[1], list(named_sessions)))
        if url.endswith("/archive"):
            assert method == "POST" and timeout >= 30
            return answer[0]
        if url.endswith("/corpora/register"):
            return 201, {"name": Path(body["path"]).name}
        pytest.fail(f"no other request: {method} {url}")

    monkeypatch.setattr(cli, "_request", request)
    assert cli.main(["up", "--cwd", str(data / "mini"), "--session", "s9", "--action", "fresh"]) == 0
    assert capsys.readouterr().out.splitlines() == [
        "thimble: http://127.0.0.1:5300/?ws=mini",
        f"thimble: Cleared the session at {data / 'mini'}. The last run is archived at {gone}. To bring it back, run: "
        "/thimble restore mini-2026-09-23-153012"]
    assert calls == [("POST", "/ws/mini/archive", [])] and named_sessions == [("mini", "s9", str(data / "mini"))]
    answer[0] = (200, {"archived": None})
    assert cli.main(["up", "--cwd", str(data / "mini"), "--session", "s9", "--action", "fresh"]) == 0
    assert capsys.readouterr().out.splitlines() == ["thimble: http://127.0.0.1:5300/?ws=mini", cli.NOTHING_ARCHIVED_LINE]
    answer[0] = (404, {"detail": "Not Found"})
    assert cli.main(["up", "--cwd", str(data / "mini"), "--session", "s9", "--action", "fresh"]) == 0
    assert capsys.readouterr().out.splitlines() == ["thimble: http://127.0.0.1:5300/?ws=mini", cli.ARCHIVE_FAILED_LINE.format(log=cli.log_path())]
    assert "archive of mini: 404" in cli.log_path().read_text()
    answer[0] = (200, {"archived": None})
    folder = tmp_path / "calls"
    folder.mkdir()
    calls.clear()
    assert cli.main(["up", "--cwd", str(folder), "--session", "s9", "--action", "fresh"]) == 0
    assert capsys.readouterr().out.splitlines() == ["thimble: http://127.0.0.1:5300/?ws=calls", cli.NOTHING_ARCHIVED_LINE]
    assert [c[1] for c in calls] == ["/corpora/register", "/ws/calls/archive"]
    assert "fresh" in cli.build_parser().parse_args(["server", "up", "--action", "fresh"]).action


def test_up_from_the_launcher_s_session_names_the_session_to_the_server(home, data, monkeypatch, capsys, named_sessions):
    _healthy_no_process(monkeypatch)
    monkeypatch.setattr(cli, "_request", lambda m, u, b=None, timeout=5.0: (404, {"detail": "Not Found"}))
    assert cli.main(["up", "--cwd", str(data / "mini" / "agents"), "--session", "s9"]) == 0
    assert named_sessions == [("mini", "s9", str(data / "mini" / "agents"))]
    assert cli.main(["up", "--cwd", str(data / "mini")]) == 0 and len(named_sessions) == 1, "a bare up names no session"


def test_launch_args_are_the_channel_the_allowed_tools_main_s_effort_then_main_s_prompt(home, data, monkeypatch,
                                                                                        tmp_path):
    """One value per line, as plugin/bin/thimble splits them. With no installed copy the channel is plugin/'s, which the
    launcher loads with --plugin-dir. The effort is thimble's default for main, high, only when the analyst's own
    settings name no effort (cc_settings.main_effort_flag), and nothing else of theirs is overridden: no --settings.
    The rest is main's prompt."""
    cfg = tmp_path / "claude"
    cfg.mkdir()
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(cfg))
    monkeypatch.delenv("CLAUDE_CODE_EFFORT_LEVEL", raising=False)
    monkeypatch.setenv("THIMBLE_WORKSPACES_DIR", str(tmp_path / "ws"))
    out = cli.launch_args(data / "mini")
    channel, tools_line, effort, prompt = out.split("\n", 3)
    assert channel == "plugin:thimble@inline" and effort == "high"
    assert tools_line == (f"mcp__plugin_thimble_thimble,Read(/{(tmp_path / 'ws').resolve()}/*/anchors/**),"
                          f"Bash({cli.PLUGIN_DIR.resolve()}/bin/.thimble-watch *),"
                          + ",".join(cli.skill_rules())), "the Monitor route's re-arming, then the plugin's own skills"
    assert prompt.startswith("# thimble") and str((data / "mini").resolve()) in prompt
    assert "## Events from the browser" in prompt and "## Threads" in prompt and "## Citations" in prompt and "{{" not in prompt
    for settings in ({"ultracode": True}, {"modelSettings": {"claude-opus-5-5": {"effortLevel": "low"}}, "model": "opus"}):
        (cfg / "settings.json").write_text(json.dumps(settings))
        assert cli.launch_args(data / "mini").split("\n", 3)[2] == "", f"{settings} is the analyst's choice"
    # a top-level level in the user's file, which Claude Code reads only for older models, is passed as the flag
    (cfg / "settings.json").write_text(json.dumps({"effortLevel": "xhigh"}))
    assert cli.launch_args(data / "mini").split("\n", 3)[2] == "xhigh"


def test_main_s_launch_denies_no_read_of_thimble_s_own_tree(home, data, monkeypatch, tmp_path):
    """launch-args prints no denied rules, and the launcher passes no --disallowedTools, so the analyst's settings
    decide what the session reads."""
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "claude"))
    monkeypatch.setenv("THIMBLE_WORKSPACES_DIR", str(tmp_path / "ws"))
    _channel, tools_line, effort, prompt = cli.launch_args(data / "mini").split("\n", 3)
    tree = str(config.REPO_ROOT.resolve())
    assert effort in ("", "high") and prompt.startswith("# thimble")
    assert not any(r.startswith("Read(") and tree in r and "/anchors/" not in r for r in tools_line.split(","))
    assert not hasattr(cli, "fence_rules")
    script = (config.REPO_ROOT / "plugin" / "bin" / "thimble").read_text()
    assert "--disallowedTools" not in script


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


def test_launch_args_load_a_directory_marketplace_of_this_tree_from_plugin_after_a_pull(home, data, monkeypatch,
                                                                                         tmp_path):
    """Claude Code runs a directory marketplace's plugin from the source, not from its cache copy. When the marketplace
    is this tree, main loads it as installed even when the cache copy does not hold plugin/'s files (after a git
    pull): the channel names the marketplace, and the watcher and skill rules name plugin/ itself. A directory
    marketplace of another tree falls back to comparing the cache copy; a disabled plugin loads plugin/ inline."""
    monkeypatch.setenv("THIMBLE_WORKSPACES_DIR", str(tmp_path / "ws"))
    root, entry = _installed_copy(tmp_path, monkeypatch)
    (root / "extra.txt").write_text("the checkout moved since the install")
    plugin = cli.PLUGIN_DIR.resolve()
    _directory_marketplace(tmp_path, monkeypatch, config.REPO_ROOT)
    channel, tools_line, _rest = cli.launch_args(data / "mini").split("\n", 2)
    assert channel == entry
    assert f"Bash({plugin}/bin/.thimble-watch *)" in tools_line.split(",")
    assert all(r in tools_line.split(",") for r in cli.skill_rules(plugin))
    _directory_marketplace(tmp_path, monkeypatch, tmp_path / "another-tree")
    assert cli.launch_args(data / "mini").split("\n", 1)[0] == cli.CHANNEL, "a stale cache copy of another source"
    (root / "extra.txt").unlink()
    channel, tools_line, _rest = cli.launch_args(data / "mini").split("\n", 2)
    assert channel == entry and f"Bash({root}/bin/.thimble-watch *)" in tools_line.split(",")
    _installed_copy(tmp_path / "off", monkeypatch, enabled=False)
    _directory_marketplace(tmp_path, monkeypatch, config.REPO_ROOT)
    assert cli.launch_args(data / "mini").split("\n", 1)[0] == cli.CHANNEL, "a disabled plugin"


def test_launch_args_load_the_installed_copy_when_it_holds_plugin_s_files(home, data, monkeypatch, tmp_path):
    """An install registers this tree's plugin with Claude Code, which copies it. While the copy holds the same files as
    plugin/ and finds this tree, main loads it as installed: the channel entry names its marketplace, and the watcher
    rule names the copy's watcher. Claude Code's startup notice lists a --plugin-dir plugin's channel as `plugin not
    installed`, which an installed copy avoids."""
    monkeypatch.setenv("THIMBLE_WORKSPACES_DIR", str(tmp_path / "ws"))
    root, entry = _installed_copy(tmp_path, monkeypatch)
    channel, tools_line, _effort, _prompt = cli.launch_args(data / "mini").split("\n", 3)
    assert channel == entry and entry != cli.CHANNEL
    assert f"Bash({root}/bin/.thimble-watch *)" in tools_line.split(",")
    assert all(r in tools_line.split(",") for r in cli.skill_rules(root))


def test_launch_args_keep_plugin_dir_when_the_installed_copy_differs_or_is_off(home, data, monkeypatch, tmp_path):
    """plugin/ itself, with --plugin-dir, whenever the installed copy is not the same plugin: a file edited or not
    executable, a file only one side has, the copy disabled, a copy that finds another tree, or a `claude plugin list`
    that fails or prints something else. Running a copy adds __pycache__, which does not count."""
    monkeypatch.setenv("THIMBLE_WORKSPACES_DIR", str(tmp_path / "ws"))
    root, entry = _installed_copy(tmp_path, monkeypatch)
    inline = f"Bash({cli.PLUGIN_DIR.resolve()}/bin/.thimble-watch *)"

    def loads() -> str:
        channel, tools_line, _rest = cli.launch_args(data / "mini").split("\n", 2)
        assert (channel == cli.CHANNEL) == (inline in tools_line.split(",")), "the channel and the watcher agree"
        return channel

    (root / "bin" / "__pycache__").mkdir()
    (root / "bin" / "__pycache__" / "x.cpython-312.pyc").write_bytes(b"\0")
    assert loads() == entry
    skill = root / "skills" / "thimble" / "SKILL.md"
    kept = skill.read_bytes()
    skill.write_bytes(kept + b"\nedited\n")
    assert loads() == cli.CHANNEL
    skill.write_bytes(kept)
    (root / "extra.txt").write_text("only in the copy")
    assert loads() == cli.CHANNEL
    (root / "extra.txt").unlink()
    watcher = root / "bin" / ".thimble-watch"
    watcher.chmod(0o644)
    assert loads() == cli.CHANNEL
    watcher.chmod(0o755)
    assert loads() == entry
    other = tmp_path / "other-tree"
    (other / "backend").mkdir(parents=True)
    (other / "backend" / "pyproject.toml").write_text("")
    (other / "plugin" / "bin").mkdir(parents=True)
    (Path(os.environ["THIMBLE_HOME"]) / "app-dir").write_text(f"{other}\n")
    assert loads() == cli.CHANNEL, "the copy would run another tree's backend"
    (Path(os.environ["THIMBLE_HOME"]) / "app-dir").write_text(f"{config.REPO_ROOT}\n")
    for listing in ("not json", "[]", json.dumps({"id": entry})):
        Path(os.environ["STUB_LIST"]).write_text(listing)
        assert loads() == cli.CHANNEL, listing
    _installed_copy(tmp_path / "off", monkeypatch, enabled=False)
    assert loads() == cli.CHANNEL, "a disabled copy"


def test_the_launcher_starts_the_installed_copy_without_plugin_dir(tmp_path):
    """The launcher passes --plugin-dir only for plugin/'s own channel; for an installed copy it names the copy's
    channel alone, so Claude Code loads the plugin it installed."""
    env = _launcher_env(tmp_path)
    launcher = str(config.REPO_ROOT / "plugin" / "bin" / "thimble")
    folder = tmp_path / "corpus"
    folder.mkdir()

    def argv() -> list[str]:
        r = subprocess.run([launcher], env=env, cwd=folder, capture_output=True, text=True, timeout=60)
        assert r.returncode == 0, r.stderr
        return (tmp_path / "stub-out" / "argv").read_text().splitlines()

    got = argv()
    assert got[:4] == ["--plugin-dir", str(cli.PLUGIN_DIR.resolve()), "--dangerously-load-development-channels",
                       cli.CHANNEL]
    with pytest.MonkeyPatch.context() as mp:
        for k, v in env.items():
            mp.setenv(k, v)
        root, entry = _installed_copy(tmp_path, mp)
        env.update({k: os.environ[k] for k in ("PATH", "STUB_LIST")})
    got = argv()
    assert "--plugin-dir" not in got and got[:2] == ["--dangerously-load-development-channels", entry]
    assert f"Bash({root}/bin/.thimble-watch *)" in got[got.index("--allowedTools") + 1].split(",")
    (root / "extra.txt").write_text("the checkout moved since the install")
    with pytest.MonkeyPatch.context() as mp:
        _directory_marketplace(tmp_path, mp, config.REPO_ROOT)
        env["STUB_MARKETPLACES"] = os.environ["STUB_MARKETPLACES"]
    got = argv()
    assert "--plugin-dir" not in got and got[:2] == ["--dangerously-load-development-channels", entry]
    watcher = f"Bash({cli.PLUGIN_DIR.resolve()}/bin/.thimble-watch *)"
    assert watcher in got[got.index("--allowedTools") + 1].split(",")


# ----------------------------------------------------------------------------- the Bash sandbox and a stale record


def test_up_inside_claude_code_s_bash_sandbox_starts_nothing_and_says_how_to_run_it_outside(home, data, monkeypatch,
                                                                                          capsys, tmp_path, named_sessions):
    """Claude Code's Bash sandbox has its own network and pid namespace, so a `server up` inside it sees no server and
    would start a second one that dies with the command. Inside the sandbox `up` starts nothing, writes no record and
    prints the warning with the exact `sandbox.excludedCommands` entry and the settings file it goes in."""
    monkeypatch.setenv(cli.SANDBOX_ENV, "1")
    monkeypatch.setenv(cli.PLUGIN_ROOT_ENV, str(tmp_path / "plugin"))
    monkeypatch.setattr(cli, "spawn", lambda *a, **k: pytest.fail("no server starts inside the sandbox"))
    monkeypatch.setattr(cli, "_request", lambda *a, **k: pytest.fail("the host's server is out of reach"))
    for action in ("", "status", "fresh"):
        assert cli.main(["server", "up", "--cwd", str(data / "mini"), "--session", "s1", "--action", action]) == 0
        rule = f"{(tmp_path / 'plugin').resolve()}/bin/thimble server up *"
        assert capsys.readouterr().out.splitlines() == [cli.SANDBOX_LINE.format(
            rule=rule, settings=tmp_path / "claude-home" / "settings.json")]
    assert not (home / "server.json").exists() and named_sessions == []


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


def test_the_launcher_s_own_words_start_no_session(tmp_path):
    """`status` runs `server status`; `help`, `-h` and `--help` print thimble's usage; any other word prints the usage
    and exits 2. None of them starts Claude Code, where the word would have become the session's first prompt."""
    env = _launcher_env(tmp_path)
    launcher = str(config.REPO_ROOT / "plugin" / "bin" / "thimble")
    folder = tmp_path / "corpus"
    folder.mkdir()

    def run(*words: str) -> subprocess.CompletedProcess:
        return subprocess.run([launcher, *words], env=env, cwd=folder, capture_output=True, text=True, timeout=60)

    status = run("status")
    down = f"thimble: server down at http://127.0.0.1:{env['THIMBLE_PORT']}"
    assert status.returncode == 0 and status.stdout.startswith(down), status
    for words in (["help"], ["-h"], ["--help"]):
        r = run(*words)
        assert r.returncode == 0 and r.stdout.startswith("usage: thimble") and "thimble status" in r.stdout, words
        assert "thimble revert " in r.stdout and "thimble fix " in r.stdout, "every command the README names"
    unknown = run("hello")
    assert unknown.returncode == 2 and unknown.stdout == ""
    assert unknown.stderr.startswith("thimble: unknown command hello\nusage: thimble")
    assert not (tmp_path / "stub-out" / "argv").exists(), "no word started Claude Code"


def test_the_launcher_gives_claude_code_a_long_idle_limit_on_thimble_calls(tmp_path):
    """A session the launcher starts gets CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT of 4 h unless the analyst set one, in case
    Claude Code ignores the shim's progress on a long call."""
    env = _launcher_env(tmp_path)
    launcher = str(config.REPO_ROOT / "plugin" / "bin" / "thimble")
    folder = tmp_path / "corpus"
    folder.mkdir()
    r = subprocess.run([launcher], env=env, cwd=folder, capture_output=True, text=True, timeout=60)
    assert r.returncode == 0, r.stderr
    argv = (tmp_path / "stub-out" / "argv").read_text().splitlines()
    assert argv[-2:] == ["--", "/thimble"] and (tmp_path / "stub-out" / "idle").read_text() == "14400000"
    env["CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT"] = "600000"
    subprocess.run([launcher], env=env, cwd=folder, capture_output=True, text=True, timeout=60, check=True)
    assert (tmp_path / "stub-out" / "idle").read_text() == "600000"


def test_the_launcher_passes_main_high_effort_unless_the_analyst_names_one(tmp_path):
    """thimble's default effort for main is high, passed as --effort when the analyst's own settings
    name none; an --effort among the analyst's own flags replaces it, so Claude Code sees theirs alone."""
    env = _launcher_env(tmp_path)
    launcher = str(config.REPO_ROOT / "plugin" / "bin" / "thimble")
    folder = tmp_path / "corpus"
    folder.mkdir()

    def efforts(*words: str) -> list[str]:
        subprocess.run([launcher, *words], env=env, cwd=folder, capture_output=True, text=True, timeout=60, check=True)
        argv = (tmp_path / "stub-out" / "argv").read_text().splitlines()
        return [argv[i + 1] if a == "--effort" else a.split("=", 1)[1] for i, a in enumerate(argv)
                if a == "--effort" or a.startswith("--effort=")]

    assert efforts() == ["high"]
    assert efforts("--effort", "low") == ["low"]
    assert efforts("--effort=max") == ["max"]


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


def test_the_launcher_starts_a_new_session_and_continues_the_folder_s_last_main_session_on_c(tmp_path):
    """As with `claude`, `thimble` alone starts a new session; `-c`/`--continue` resumes the session the folder's
    workspace recorded as main last, by id, and says so on the terminal, so a newer transcript in the folder that is
    not main's (a writer's) is never taken; `-r`/`--resume` and Claude Code's other session flags go to it as they
    are; `--new` is dropped. A transcript Claude Code would not find under its config dir is not offered, and with
    none to continue `--continue` goes to Claude Code, which answers as it does without thimble."""
    env = _launcher_env(tmp_path)
    corpus = tmp_path / "data" / "mini"
    corpus.mkdir(parents=True)
    paths = _main_sessions(tmp_path, env, corpus)
    writer = paths[SID_B].with_name("cccccccc-0000-4000-8000-000000000003.jsonl")
    writer.write_text('{"type": "user"}\n')  # written after main's two, and recorded nowhere as main
    launcher = str(config.REPO_ROOT / "plugin" / "bin" / "thimble")

    def launch(*words: str) -> tuple[list[str], str]:
        r = subprocess.run([launcher, *words], env=env, cwd=corpus, capture_output=True, text=True, timeout=60)
        assert r.returncode == 0, r.stderr
        return (tmp_path / "stub-out" / "argv").read_text().splitlines(), r.stderr

    argv, err = launch()
    assert "--resume" not in argv and "--continue" not in argv and argv[-2:] == ["--", "/thimble"]
    assert "continu" not in err
    for flag in ("-c", "--continue"):
        argv, err = launch(flag, "--model", "opus")
        assert argv.count("--resume") == 1 and argv[argv.index("--resume") + 1] == SID_B, flag
        assert flag not in argv and "--model" in argv and argv[-2:] == ["--", "/thimble"]
        assert f"thimble: continuing the last thimble session in this folder ({SID_B})" in err
    argv, err = launch("--new", "--model", "opus")
    assert "--resume" not in argv and "--new" not in argv and "--model" in argv and "continu" not in err
    argv, _ = launch("--resume", SID_A)
    assert argv.count("--resume") == 1 and argv[argv.index("--resume") + 1] == SID_A
    argv, _ = launch("-r")
    assert argv.count("-r") == 1 and "--resume" not in argv and argv[argv.index("-r") + 1] == "--", "Claude Code's picker"
    for words in (["--session-id", SID_A], ["--resume", SID_A, "--fork-session"], ["-p", "--output-format", "json"],
                  ["-n", "audit", "--model", "opus"]):
        argv, err = launch(*words)
        at = argv.index(words[0])
        assert argv[at:at + len(words)] == words and argv[-2:] == ["--", "/thimble"] and "continu" not in err, words
        assert argv.count("--resume") == words.count("--resume"), words
    argv, _ = launch("-c", "--fork-session")
    assert argv[argv.index("--resume") + 1] == SID_B and "--fork-session" in argv
    paths[SID_B].unlink()
    argv, _ = launch("-c")
    assert argv[argv.index("--resume") + 1] == SID_A, "a session whose transcript is gone is not resumed"
    env["CLAUDE_CONFIG_DIR"] = str(tmp_path / "another-config")
    for flag in ("-c", "--continue"):
        argv, err = launch(flag)
        assert "--resume" not in argv, "Claude Code under another config dir would not find it"
        assert argv.count("--continue") == 1 and "-c" not in argv and argv[-2:] == ["--", "/thimble"], flag
        assert "continu" not in err, "the answer is Claude Code's own"


def test_a_session_live_in_another_terminal_is_not_resumed(home, tmp_path, monkeypatch):
    """A session that has not ended and whose `claude` process still runs is someone's open session: resuming it would
    have two processes write one transcript, so the launcher starts a fresh one."""
    env = {"CLAUDE_CONFIG_DIR": str(tmp_path / "claude-home")}
    corpus = tmp_path / "data" / "mini"
    corpus.mkdir(parents=True)
    _main_sessions(tmp_path, env, corpus)
    for k, v in env.items():
        monkeypatch.setenv(k, v)
    assert cli.last_main(corpus) == SID_B
    recs = json.loads((tmp_path / "ws" / "mini" / "sessions.json").read_text())
    live = subprocess.Popen(["sleep", "30"])
    try:
        recs[SID_B].update(ended=None, pid=live.pid)
        (tmp_path / "ws" / "mini" / "sessions.json").write_text(json.dumps(recs))
        monkeypatch.setattr(cli, "_cmdline", lambda pid: "claude --plugin-dir x" if pid == live.pid else "")
        assert cli.last_main(corpus) == SID_A
    finally:
        live.kill()
        live.wait()


def test_doctor_names_the_validation_stack_s_ports_as_the_dev_stack_reads_them(home, monkeypatch):
    """THIMBLE_STACK_PORT and THIMBLE_STACK_UI_PORT move the dev agent's validation stack (dev_stack.sh, dev.py), and
    doctor looks at the ports they name."""
    monkeypatch.delenv("THIMBLE_STACK_PORT", raising=False)
    monkeypatch.delenv("THIMBLE_STACK_UI_PORT", raising=False)
    assert cli.validation_ports() == (8301, 5301)
    monkeypatch.setenv("THIMBLE_STACK_PORT", "8911")
    monkeypatch.setenv("THIMBLE_STACK_UI_PORT", "9011")
    assert cli.validation_ports() == (8911, 9011)
    checked: list[int] = []
    monkeypatch.setattr(cli, "listening", lambda p: checked.append(p) or False)
    monkeypatch.setattr(cli, "healthy", lambda url=None, timeout=1.0: False)
    monkeypatch.setattr(cli, "network_line", lambda timeout_s=3.0: "not checked")
    line = next(ln for ln in cli.doctor_text().splitlines() if "validation stack" in ln)
    assert line.startswith("  validation stack: 8911 free, 9011 free") and 8301 not in checked


def test_the_launcher_s_server_up_exits_zero_even_without_its_tree(tmp_path):
    """A skill's injected command that exits non-zero fails the whole skill, so bin/thimble's
    `server up` prints a thimble: line and exits 0 when it cannot find the thimble tree, while another subcommand still
    fails."""
    bin_dir = tmp_path / "plugin" / "bin"
    bin_dir.mkdir(parents=True)
    for name in ("thimble", "thimble-app-dir", "thimble-python"):
        src = config.REPO_ROOT / "plugin" / "bin" / name
        (bin_dir / name).write_text(src.read_text())
        (bin_dir / name).chmod(0o755)
    env = {"PATH": os.environ.get("PATH", ""), "HOME": str(tmp_path), "THIMBLE_HOME": str(tmp_path / "none")}
    up = subprocess.run([str(bin_dir / "thimble"), "server", "up", "--cwd", str(tmp_path)], env=env, capture_output=True,
                        text=True, timeout=30)
    assert up.returncode == 0 and up.stdout.startswith("thimble: "), up
    doctor = subprocess.run([str(bin_dir / "thimble"), "doctor"], env=env, capture_output=True, text=True, timeout=30)
    assert doctor.returncode != 0


def test_a_start_whose_uvicorn_cannot_bind_leaves_no_dead_pid(fake, home, monkeypatch):
    """A second server that cannot bind the port (another holds it) dies at once, while the one holding the port
    answers the health check: the record names the one that answers, when it is this checkout's, else no pid, never
    the dead one."""
    monkeypatch.setattr(cli, "is_server", lambda pid, p, repo=None: pid == 777)
    monkeypatch.setattr(cli, "health_leader", lambda url=None: 777)
    assert cli.ensure_running(2.0) is True
    assert sum(1 for c in fake.calls if "uvicorn" in c["cmd"]) == 1
    assert cli.read_state()["pid"] == 777, "the server that answers is adopted"
    monkeypatch.setattr(cli, "health_leader", lambda url=None: None)
    cli.write_state({**cli.read_state(), "pid": 40001})
    assert cli.reconcile()["pid"] is None, "a dead pid is never left recorded"
