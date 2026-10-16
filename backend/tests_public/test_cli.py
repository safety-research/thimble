"""The supervisor (app.cli): `thimble server up | stop` and doctor. `server up` prints the url and opens a folder's
workspace, refuses $HOME and /, and starts one server when two race; stop signals only a pid whose command line is this
checkout's server. Unit tests fake `spawn`, `healthy` and `_request`; one integration test starts a real uvicorn on a
free port under a scratch THIMBLE_HOME. `doctor` says what `claude auth status` reports, never a credential's value."""
from __future__ import annotations

import json
import socket
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request
from pathlib import Path

import pytest

from app import cli, config, procs

SECRET = "sk-ant-test-secret-never-written"  # gitleaks:allow  a fake key asserting nothing writes it
NAME_SESSION = cli.name_session  # the named_sessions fixture replaces it; a test of what it sends puts it back

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
        if u.endswith("/precached/context"):  # no workspace here was installed from a pre-cache
            return 200, {"text": ""}
        if u.endswith("/archive"):  # /thimble fresh in a folder with no workspace yet
            return 200, {"archived": None}
        posted.append((u, b))
        if u.endswith("/api/ui/pair"):  # a server that makes no sign-in codes
            return 404, {"detail": "Not Found"}
        return 201, {"name": Path(b["path"]).name}

    monkeypatch.setattr(cli, "_request", request)
    # 0.9.0: /thimble alone turns thimble on in the session and starts no server; /thimble fresh still opens the
    # session's folder on the server
    assert cli.main(["up", "--cwd", str(data / "mini" / "agents"), "--session", "s9"]) == 0
    assert capsys.readouterr().out.splitlines() == [cli.ON_LINE] and not (home / "links" / "s9").exists()
    assert posted == []
    rc = cli.main(["up", "--cwd", str(data / "mini" / "agents"), "--session", "s9", "--action", "fresh"])
    # what the skill puts in the model's context holds no link: the session's Stop hook shows the link it left, with a
    # sign-in code it gets as it shows it, so the file holds none
    assert rc == 0 and capsys.readouterr().out.splitlines() == [cli.LINK_LINE, cli.NOTHING_ARCHIVED_LINE]
    assert (home / "links" / "s9").read_text() == "http://127.0.0.1:5300/?ws=mini"
    assert "ui_key" not in json.loads((home / "server.json").read_text())
    posted.clear()  # the session's name and the like, told to the server
    folder = tmp_path / "calls"
    folder.mkdir()
    assert cli.main(["ensure", "--cwd", str(folder), "--session", "s9", "--action", "fresh"]) == 0
    assert capsys.readouterr().out.splitlines() == [cli.LINK_LINE, cli.NOTHING_ARCHIVED_LINE]
    assert (home / "links" / "s9").read_text() == "http://127.0.0.1:5300/?ws=calls"
    assert posted[0] == ("http://127.0.0.1:8300/api/corpora/register", {"path": str(folder), "exact": True})
    posted.clear()
    (tmp_path / "cc").mkdir()
    (tmp_path / "cc" / "settings.json").write_text(json.dumps({"disableAllHooks": True}))
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "cc"))
    assert cli.main(["ensure", "--cwd", str(folder), "--session", "s8", "--action", "fresh"]) == 0
    url, second, note, mark = capsys.readouterr().out.splitlines()
    assert url == "thimble: http://127.0.0.1:5300/?ws=calls", "no hook to show it"
    assert second == cli.NOTHING_ARCHIVED_LINE
    assert note == cli.MONITOR_NOTE and mark.startswith(cli.MONITOR_MARK), "main's Monitor brings the browser's events"
    assert cli.main(["ensure", "--cwd", str(data / "mini" / "agents"), "--session", "s8"]) == 0
    on, note2, mark2 = capsys.readouterr().out.splitlines()
    assert on == cli.ON_LINE and note2 == note and mark2.startswith(cli.MONITOR_MARK), "/thimble alone arms it too"
    posted.clear()
    assert cli.main(["up", "--cwd", str(folder)]) == 0, "a bare up read by a program"
    assert capsys.readouterr().out.splitlines() == ["thimble: http://127.0.0.1:5300/"]
    assert posted == [], "no code minted"
    monkeypatch.setattr(cli, "to_terminal", lambda: True)
    assert cli.main(["up", "--cwd", str(folder)]) == 0, "a bare up from a shell"
    # the server gave no code: the plain link, and why it opens read-only
    assert capsys.readouterr().out.splitlines() == ["thimble: http://127.0.0.1:5300/",
                                                    cli.NO_CODE_LINE.format(log=cli.log_path())]
    assert posted == [("http://127.0.0.1:8300/api/ui/pair", {})], "the code is minted at the API, not at Vite"

    def minting(m, u, b=None, timeout=5.0):
        if u.endswith("/api/ui/pair"):
            posted.append((u, b))
            return 200, {"code": f"c{len(posted)}", "expires_s": 300}
        return request(m, u, b, timeout)

    monkeypatch.setattr(cli, "_request", minting)
    posted.clear()
    assert cli.main(["up", "--cwd", str(folder)]) == 0
    assert capsys.readouterr().out.splitlines() == ["thimble: http://127.0.0.1:5300/#p=c1"]
    assert cli.ui_url("calls", pair=True) == "http://127.0.0.1:5300/?ws=calls#p=c2"
    assert posted[-1] == ("http://127.0.0.1:8300/api/ui/pair", {"ws": "calls"})
    assert cli.ui_url("calls") == "http://127.0.0.1:5300/?ws=calls" and len(posted) == 2, "no code unless asked"
    assert cli.build_parser().parse_args(["up"]).cmd == "up" and cli.build_parser().parse_args(["ensure"]).cmd == "ensure"


def test_slash_thimble_makes_its_session_main_with_a_launch_record_and_marks_the_folder(home, data, monkeypatch,
                                                                                        capsys, tmp_path):
    """`up` for a session makes it main on the server (made_main, H1): launch.json written through activation's one
    writer (activate.take_main and write_launch) with transport `server`, its `claude` process and its
    CLAUDE_CONFIG_DIR, which the hooks module's bridge reads, and no mode; the switch is one way, so a later `up` keeps
    it. The folder is marked active, as itself and as its real path, for the plugin's watcher, and the server hears
    whether Claude Code's own sandbox is on."""
    _healthy_no_process(monkeypatch)
    told = []
    monkeypatch.setattr(cli, "_request", lambda m, u, b=None, timeout=5.0:
                        (told.append(b) or (200, {})) if u.endswith("/session") else (404, {}))
    monkeypatch.setattr(cli.cc_plugin, "claude_pid", lambda environ=None: 4242)
    monkeypatch.setattr(cli, "own_sandbox_here", lambda cwd: True)
    monkeypatch.setattr(cli, "name_session", NAME_SESSION)
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "claude-home"))
    link = tmp_path / "mini-link"
    link.symlink_to(data / "mini", target_is_directory=True)
    assert cli.main(["up", "--cwd", str(link), "--session", "s5", "--action", "fresh"]) == 0
    assert capsys.readouterr().out.splitlines() == [cli.LINK_LINE, cli.ARCHIVE_FAILED_LINE.format(log=cli.log_path())]
    assert told[-1] == {"session": "s5", "cwd": str(link), "warnings": [], "sandbox": True}
    with cli.server_dirs():
        rec = cli.read_launch("mini")
    assert {k: rec[k] for k in ("session", "pid", "via", "transport", "config_dir")} == {
        "session": "s5", "pid": 4242, "via": "press", "transport": "server", "config_dir": str(tmp_path / "claude-home")}
    # activation's writer may still write 0.8.0's `mode` beside `transport` (activate.LEGACY_MODE); it agrees with it
    assert "fenced" not in rec and rec.get("mode") in (None, "browser")
    marks = {p.name for p in (home / cli.ACTIVE_DIR).iterdir()}
    assert marks == {str(link).replace("/", "%"), str((data / "mini").resolve()).replace("/", "%")}
    assert cli.main(["up", "--cwd", str(link), "--session", "s5"]) == 0  # /thimble alone: activation keeps it
    with cli.server_dirs():
        again = cli.read_launch("mini")
    assert again["session"] == "s5" and again["transport"] == "server", "one way: the server stays"


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
    said = line(cli.doctor_text(), "auth:")
    assert config.AUTH_HELP in said and "ANTHROPIC_API_KEY" not in said, "the login and the pointer, nothing longer"


def test_fix_and_revert_run_only_in_a_development_install(home, monkeypatch, capsys):
    """`thimble fix` and `thimble revert` change thimble's own code, which a release install cannot: each says so and
    exits 1 before it asks or touches anything, and /thimble fix says the same to the session."""
    monkeypatch.setattr(cli, "is_git_checkout", lambda: False)
    touched: list[str] = []
    for name in ("healthy", "fix", "revert", "fix_refusal", "restart"):
        monkeypatch.setattr(cli, name, lambda *a, _n=name, **k: touched.append(_n))
    assert cli.main(["fix"]) == 1
    assert capsys.readouterr().out.strip() == cli.DEV_ONLY_LINES["fix"]
    assert cli.main(["revert"]) == 1
    assert capsys.readouterr().out.strip() == cli.DEV_ONLY_LINES["revert"]
    assert cli._action(type("A", (), {"action": "fix"})(), True, "http://127.0.0.1:1") == 0
    assert capsys.readouterr().out.strip() == cli.DEV_ONLY_LINES["fix"]
    assert touched == []


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


def test_requests_to_thimble_s_own_server_skip_the_shell_s_proxy(home, monkeypatch):
    """A shell's HTTP_PROXY with no NO_PROXY for 127.0.0.1 would send urllib's loopback requests to that proxy:
    `_request` and `healthy` open them without any proxy (config.LOOPBACK), so they still reach the local server."""
    import http.server

    class Health(http.server.BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802 — http.server's name
            body = json.dumps({"ok": True}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *a):
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Health)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        url = f"http://127.0.0.1:{server.server_address[1]}"
        for name in ("HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"):
            monkeypatch.setenv(name, "http://127.0.0.1:9")
        for name in ("NO_PROXY", "no_proxy"):
            monkeypatch.delenv(name, raising=False)
        assert urllib.request.getproxies().get("http") == "http://127.0.0.1:9", "the proxy is in effect for urllib"
        assert cli._request("GET", f"{url}/api/health") == (200, {"ok": True})
        assert cli.healthy(url) is True
    finally:
        server.shutdown()
        server.server_close()
