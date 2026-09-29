"""The supervisor (app.cli): `thimble server up | stop` and doctor. `server up` prints the url and opens a folder's
workspace, refuses $HOME and /, and starts one server when two race; stop signals only a pid whose command line is this
checkout's server. Unit tests fake `spawn`, `healthy` and `_request`; one integration test starts a real uvicorn on a
free port under a scratch THIMBLE_HOME. `doctor` says what `claude auth status` reports, never a credential's value."""
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
from pathlib import Path

import pytest

from app import cli, procs

SECRET = "sk-ant-test-secret-never-written"  # gitleaks:allow  a fake key asserting nothing writes it
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
    key = json.loads((home / "server.json").read_text())["ui_key"]
    # the link carries the key to the analyst's cookie, so what the skill puts in the model's context holds none: the
    # session's Stop hook shows the link it left
    assert rc == 0 and capsys.readouterr().out.splitlines() == [cli.LINK_LINE]
    assert (home / "links" / "s9").read_text() == f"http://127.0.0.1:5300/?ws=mini#k={key}"
    assert posted == [], "a folder inside the data dir is known already"
    folder = tmp_path / "calls"
    folder.mkdir()
    assert cli.main(["ensure", "--cwd", str(folder), "--session", "s9"]) == 0
    assert capsys.readouterr().out.splitlines() == [cli.LINK_LINE]
    assert (home / "links" / "s9").read_text() == f"http://127.0.0.1:5300/?ws=calls#k={key}"
    assert posted == [("http://127.0.0.1:8300/api/corpora/register", {"path": str(folder), "exact": True})]
    (tmp_path / "cc").mkdir()
    (tmp_path / "cc" / "settings.json").write_text(json.dumps({"disableAllHooks": True}))
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "cc"))
    assert cli.main(["ensure", "--cwd", str(folder), "--session", "s8"]) == 0
    assert capsys.readouterr().out.splitlines() == ["thimble: http://127.0.0.1:5300/?ws=calls"], "no hook to show it"
    assert cli.main(["up", "--cwd", str(folder)]) == 0, "a bare up read by a program"
    assert capsys.readouterr().out.splitlines() == ["thimble: http://127.0.0.1:5300/"] and len(posted) == 2
    monkeypatch.setattr(cli, "to_terminal", lambda: True)
    assert cli.main(["up", "--cwd", str(folder)]) == 0, "a bare up from a shell"
    assert capsys.readouterr().out.splitlines() == [f"thimble: http://127.0.0.1:5300/#k={key}"]
    assert cli.build_parser().parse_args(["up"]).cmd == "up" and cli.build_parser().parse_args(["ensure"]).cmd == "ensure"


def line(text: str, key: str) -> str:
    """The first line of doctor's text that starts with `key`."""
    return next(ln for ln in text.splitlines() if ln.strip().startswith(key))


def test_doctor_says_what_claude_reports_about_its_login_and_never_a_value(home, monkeypatch, fake_claude):
    monkeypatch.setenv("ANTHROPIC_API_KEY", SECRET)
    monkeypatch.setattr(cli, "healthy", lambda url=None, timeout=1.0: False)
    monkeypatch.setattr(cli, "listening", lambda p: False)
    fake_claude.write_text(json.dumps({"loggedIn": True, "authMethod": "api_key", "apiProvider": "firstParty"}))
    text = cli.doctor_text()
    assert SECRET not in text and "down" in line(text, "server:")
    assert all(word in line(text, "auth:") for word in ("api_key", "firstParty"))
    fake_claude.write_text(json.dumps({"loggedIn": False, "authMethod": "none"}))
    assert "not logged in" in line(cli.doctor_text(), "auth:")


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


def test_real_up_starts_a_detached_server_idempotently_and_stop_ends_it(home, data, tmp_path, fake_claude):
    probe = subprocess.run([sys.executable, "-c", "import app.main"], cwd=BACKEND, capture_output=True, text=True, timeout=120,
                           env={**os.environ, "THIMBLE_SKIP_KEY": "1"})
    if probe.returncode != 0:
        pytest.skip("app.main does not import in this tree: " + probe.stderr.strip().splitlines()[-1][:200])
    port = _free_port()
    # a claude.ai login (fake_claude), so the launcher's channel stands and /thimble prints the URL alone
    env = {**os.environ, "THIMBLE_HOME": str(home), "THIMBLE_PORT": str(port),
           "THIMBLE_DATA_DIR": str(data), "THIMBLE_WORKSPACES_DIR": str(tmp_path / "ws")}
    env.pop("THIMBLE_DEV", None)
    for k in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_PROFILE"):
        env.pop(k, None)
    cmd = [sys.executable, "-m", "app.cli", "server", "up", "--cwd", str(data / "mini"), "--session", "it-1"]
    pid = None
    try:
        t0 = time.monotonic()
        out = subprocess.run(cmd, cwd=BACKEND, env=env, capture_output=True, text=True, timeout=90)
        first = time.monotonic() - t0
        lines = out.stdout.splitlines()
        # the link's line alone: the workspace holds nothing from an earlier run, so there is nothing to resume
        st = json.loads((home / "server.json").read_text())
        assert out.returncode == 0 and lines == [cli.LINK_LINE], out
        assert (home / "links" / "it-1").read_text() == f"http://127.0.0.1:{port}/?ws=mini#k={st['ui_key']}"
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


def test_up_in_the_bash_sandbox_prints_what_the_hook_did_outside_it(home, data, monkeypatch, capsys, tmp_path):
    """/thimble's UserPromptExpansion hook runs `up` outside Claude Code's Bash sandbox and prints nothing; the skill's
    `up` in the sandbox prints what the hook's did and starts nothing. With no result left for it, it names the
    exclusions that would run it outside instead (the watcher's too when hooks are off), and a result for other
    arguments is not taken."""
    _healthy_no_process(monkeypatch)
    monkeypatch.setattr(cli, "_request", lambda m, u, b=None, timeout=5.0:
                        (201, {"name": Path(b["path"]).name}) if m == "POST" else (404, {}))
    folder = tmp_path / "calls"
    folder.mkdir()
    monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(folder))
    hook = {"session_id": "s7", "cwd": str(folder), "command_name": "thimble:thimble", "command_args": ""}
    assert cli.hook_up(json.dumps(hook)) == 0 and capsys.readouterr().out == ""
    started = []
    monkeypatch.setattr(cli, "ensure_running", lambda wait: started.append(1) or True)
    monkeypatch.setenv(cli.SANDBOX_ENV, "1")
    skill = ["server", "up", "--cwd", str(folder), "--session", "s7", "--action", "", "--archive", ""]
    assert cli.main(skill) == 0 and capsys.readouterr().out.splitlines() == [cli.LINK_LINE]
    assert cli.main(skill) == 0
    out = capsys.readouterr().out
    assert out.startswith("thimble: WARNING") and f'"{cli.sandbox_rule()}"' in out and started == []
    settings = tmp_path / "claude-home" / "settings.json"
    settings.write_text(json.dumps({"disableAllHooks": True}))
    assert cli.main(skill) == 0
    out = capsys.readouterr().out
    assert f'"{cli.sandbox_rule()}"' in out and f'"{cli.watch_rule()}"' in out and started == []
    settings.unlink()
    monkeypatch.delenv(cli.SANDBOX_ENV)
    assert cli.hook_up(json.dumps(hook)) == 0 and started == [1]
    started.clear()
    monkeypatch.setenv(cli.SANDBOX_ENV, "1")
    assert cli.main([*skill[:-3], "fresh", "--archive", ""]) == 0
    assert capsys.readouterr().out.startswith("thimble: WARNING") and started == []
