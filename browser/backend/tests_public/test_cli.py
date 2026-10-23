"""The supervisor (app.cli): `thimble server up | stop` and doctor. `server up` prints the url and opens a folder's
workspace, refuses $HOME and /, and starts one server when two race; stop signals only a pid whose command line is this
checkout's server. Unit tests fake `spawn`, `healthy` and `_request`; one integration test starts a real uvicorn on a
free port under a scratch THIMBLE_HOME. `doctor` says what `claude auth status` reports, never a credential's value."""
from __future__ import annotations

import contextlib
import json
import os
import re
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


def test_a_server_that_runs_but_does_not_answer_is_named_with_the_command_that_restarts_it(home, monkeypatch):
    """thimble's own server alive on its port but not answering (out of file descriptors, as on a Mac whose views'
    kernels took its 256): start_failure and the doctor's port line name it and say `thimble server restart`, rather
    than "see the log" or "another program". Its own new server is still starting, and server.json's server that started
    moments ago is not called stuck."""
    p = cli.port()
    monkeypatch.setattr(cli, "listening", lambda q: q == p)
    monkeypatch.setattr(cli, "healthy", lambda url=None, timeout=1.0: False)
    monkeypatch.setattr(procs, "listener", lambda q: 4242 if q == p else None)
    monkeypatch.setattr(cli, "is_server", lambda pid, q, repo=None: pid == 4242 and q == p)
    monkeypatch.setattr(cli, "refuse_foreign", lambda url: False)
    monkeypatch.setattr(cli, "foreign_home", lambda url=None: None)
    monkeypatch.setattr(cli, "ensure_running", lambda wait: False)
    cli.write_state({"port": p, "pid": 4242, "started": "2026-01-01T00:00:00+00:00"})
    cli.LAST_START.clear()
    line = cli.STUCK_LINE.format(pid=4242)
    assert "thimble server restart" in line
    assert cli.stuck_server() == 4242 and cli.start_failure(cli.api_url()) == line
    assert cli.port_line(p, False).startswith(f"{p} is held by thimble's server (pid 4242)")
    assert "thimble server restart" in cli.port_line(p, False)

    cli.LAST_START.update(pid=4242, port=p)
    monkeypatch.setattr(cli, "spawned_exited", lambda pid: False)
    assert "is still starting" in cli.start_failure(cli.api_url())
    cli.LAST_START.clear()
    monkeypatch.setattr(cli, "listening", lambda q: False)
    assert cli.stuck_server() == 4242, "server.json names it though the port's holder cannot be seen"
    cli.write_state({"port": p, "pid": 4242, "started": cli._now()})
    assert cli.stuck_server() is None and cli.start_failure(cli.api_url()) == ""


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
        posted.append((u, b))
        if u.endswith("/api/ui/pair"):  # a server that makes no sign-in codes
            return 404, {"detail": "Not Found"}
        return 201, {"name": Path(b["path"]).name}

    monkeypatch.setattr(cli, "_request", request)
    rc = cli.main(["up", "--cwd", str(data / "mini" / "agents"), "--session", "s9"])
    # what the skill puts in the model's context holds no link: the session's Stop hook shows the link it left, with a
    # sign-in code it gets as it shows it, so the file holds none
    assert rc == 0 and capsys.readouterr().out.splitlines() == [cli.LINK_LINE]
    assert (home / "links" / "s9").read_text() == "http://127.0.0.1:5300/?ws=mini"
    assert "ui_key" not in json.loads((home / "server.json").read_text())
    posted.clear()  # the session's name and the like, told to the server
    folder = tmp_path / "calls"
    folder.mkdir()
    assert cli.main(["ensure", "--cwd", str(folder), "--session", "s9"]) == 0
    assert capsys.readouterr().out.splitlines() == [cli.LINK_LINE]
    assert (home / "links" / "s9").read_text() == "http://127.0.0.1:5300/?ws=calls"
    assert posted[0] == ("http://127.0.0.1:8300/api/corpora/register", {"path": str(folder), "exact": True})
    posted.clear()
    (tmp_path / "cc").mkdir()
    (tmp_path / "cc" / "settings.json").write_text(json.dumps({"disableAllHooks": True}))
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "cc"))
    assert cli.main(["ensure", "--cwd", str(folder), "--session", "s8"]) == 0
    url, note, mark = capsys.readouterr().out.splitlines()
    assert url == "thimble: http://127.0.0.1:5300/?ws=calls", "no hook to show it"
    assert note == cli.MONITOR_NOTE and mark.startswith(cli.MONITOR_MARK), "main's Monitor brings the browser's events"
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


def test_unpair_signs_every_browser_out_and_says_how_to_sign_in_again(home, monkeypatch, capsys):
    """`thimble unpair` asks the server to forget every browser (POST /api/ui/unpair) and removes paired.json, so a
    server that starts later knows none either. When the server does not do it, the line says so and how to fix it."""
    asked = []
    monkeypatch.setattr(cli, "healthy", lambda url=None, timeout=1.0: True)
    monkeypatch.setattr(cli, "_request", lambda m, u, b=None, timeout=5.0: asked.append((m, u)) or (204, None))
    cli.ensure_home()
    (home / cli.PAIRED_FILE).write_text("[]")
    assert cli.main(["unpair"]) == 0
    assert asked == [("POST", f"{cli.api_url()}/api/ui/unpair")] and not (home / cli.PAIRED_FILE).exists()
    assert capsys.readouterr().out.splitlines() == [cli.UNPAIRED_LINE]
    assert "`thimble up`" in cli.UNPAIRED_LINE
    monkeypatch.setattr(cli, "_request", lambda m, u, b=None, timeout=5.0: (404, {"detail": "Not Found"}))
    assert cli.main(["unpair"]) == 1
    out = capsys.readouterr().out
    assert out.startswith("thimble: the server did not sign the browsers out (it answered 404)")
    assert out.rstrip().endswith("In a shell: thimble server restart")
    monkeypatch.setattr(cli, "healthy", lambda url=None, timeout=1.0: False)
    assert cli.main(["unpair"]) == 0 and capsys.readouterr().out.splitlines() == [cli.UNPAIRED_LINE], "server down"


def test_browser_cookie_mints_a_code_and_trades_it_without_the_token(home, monkeypatch):
    """A script's browser sign-in: a code from POST /api/ui/pair (with the token), traded at POST /api/ui/key with no
    token, as a browser trades it; the cookie it sets comes back as `name=value; Path=/b/<key>/api/`, the path it is
    scoped to (beside the deletion of an earlier build's cookie), and _request sends it there as a browser does, to the
    API path under the browser's key. A refusal raises."""
    import http.server

    key = "k3y-of-the-script-s-browser"
    seen: list[tuple[str, dict, bool]] = []
    gets: list[tuple[str, str]] = []

    class Server(http.server.BaseHTTPRequestHandler):
        def do_POST(self):  # noqa: N802 — http.server's name
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])) or b"{}")
            seen.append((self.path, body, any(k.lower().startswith("x-thimble") for k in self.headers.keys())))
            if self.path == "/api/ui/pair":
                out, cookies = json.dumps({"code": "c0de", "expires_s": 300}).encode(), []
            elif body.get("code") == "c0de":
                out = json.dumps({"key": key}).encode()
                cookies = [f"thimble-ui-8300=s3cret; Max-Age=34560000; Path=/b/{key}/api/; HttpOnly; SameSite=strict",
                           'thimble-ui-8300=""; expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; Path=/api/']
            else:
                self.send_response(410)
                self.end_headers()
                return
            self.send_response(200)
            for cookie in cookies:
                self.send_header("Set-Cookie", cookie)
            self.send_header("Content-Length", str(len(out)))
            self.end_headers()
            self.wfile.write(out)

        def do_GET(self):  # noqa: N802
            gets.append((self.path, self.headers.get("Cookie", "")))
            self.send_response(200)
            self.send_header("Content-Length", "2")
            self.end_headers()
            self.wfile.write(b"[]")

        def log_message(self, *a):
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Server)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        url = f"http://127.0.0.1:{server.server_address[1]}"
        cli.write_state({"port": server.server_address[1]})
        cookie = cli.browser_cookie(url)
        assert cookie == f"thimble-ui-8300=s3cret; Path=/b/{key}/api/"
        assert [(path, body) for path, body, _ in seen] == [("/api/ui/pair", {}), ("/api/ui/key", {"code": "c0de"})]
        assert seen[0][2] is True and seen[1][2] is False, "the mint proves the token, the claim does not"
        assert cli._request("GET", f"{url}/api/ws/mini/concepts?x=1", cookie=cookie) == (200, [])
        assert gets == [(f"/b/{key}/api/ws/mini/concepts?x=1", "thimble-ui-8300=s3cret")]
        bare = "thimble-ui-8300=s3cret"
        assert cli.browser_request(f"{url}/api/x", bare) == (f"{url}/api/x", bare), "a cookie that names no path"
        monkeypatch.setattr(cli, "pair_code", lambda api, name: "spent")
        with pytest.raises(RuntimeError, match="refused the sign-in code"):
            cli.browser_cookie(url)
    finally:
        server.shutdown()
        server.server_close()


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


def test_the_doctor_a_model_reads_names_no_install_command_even_when_the_log_does(home, monkeypatch, fake_claude):
    """`thimble fix` hands doctor_text(commands=False) to an agent whose Bash runs unasked, so none of its lines, the
    server log's included, names a command that installs software."""
    monkeypatch.setattr(cli, "healthy", lambda url=None, timeout=1.0: False)
    monkeypatch.setattr(cli, "listening", lambda p: False)
    cli.log_path().parent.mkdir(parents=True, exist_ok=True)
    cli.log_path().write_text("2026-09-29 10:00:00,000 ERROR thimble.notebook: bwrap missing; install bubblewrap (`apt install bubblewrap`)\n"
                              "2026-09-29 10:00:01,000 INFO thimble.cli: not starting Vite (run `npm ci` in frontend/)\n"
                              "2026-09-29 10:00:02,000 WARNING thimble.headless: run `sudo playwright install-deps`\n")
    text = cli.doctor_text(commands=False)
    assert not cli._INSTALL_COMMAND.search(text), text
    assert text.count(cli.LOG_LINE_LEFT_OUT) == 4, "three in the tail, one in the errors"


DEV_LINES = ("turn endings:", "source changed since start:", "validation stack:", "last apply:", "dev tickets:",
             "last ticket error:")


def test_doctor_prints_the_developer_s_lines_only_in_a_development_install(home, monkeypatch, fake_claude):
    """The turn endings, the source changed since start, the validation stack, the last apply and the dev tickets are a
    developer's lines, so a release install's doctor leaves them out and a git clone's prints them."""
    monkeypatch.setattr(cli, "healthy", lambda url=None, timeout=1.0: False)
    monkeypatch.setattr(cli, "listening", lambda p: False)
    monkeypatch.setattr(cli, "is_git_checkout", lambda: False)
    release = cli.doctor_text()
    assert not [k for k in DEV_LINES if f"\n  {k}" in release], release
    assert "\n  server:" in release and "\n  auth:" in release
    monkeypatch.setattr(cli, "is_git_checkout", lambda: True)
    monkeypatch.setattr(cli, "_git", lambda *a: "")
    clone = cli.doctor_text()
    assert all(f"\n  {k}" in clone for k in DEV_LINES), clone


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
    # a session the launcher started, with the plugin's hooks on, so /thimble prints the URL alone
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
        assert (home / "links" / "it-1").read_text() == f"http://127.0.0.1:{port}/?ws=mini", "no code in the file"
        assert "ui_key" not in st
        pid = st["pid"]
        assert cli.pid_alive(pid) and st["port"] == port and st["env"]["data_dir"] == str(data)
        assert os.getsid(pid) == pid, "uvicorn is its own session leader"
        assert int(Path(f"/proc/{pid}/stat").read_text().split()[3]) != os.getpid()
        from app import hook_auth  # noqa: PLC0415

        proven = urllib.request.Request(f"http://127.0.0.1:{port}/api/health",
                                        headers=hook_auth.headers(st["token"], port))
        with urllib.request.urlopen(proven, timeout=5) as r:
            health = json.loads(r.read())
            assert {k: health[k] for k in ("ok", "leader")} == {"ok": True, "leader": pid}, "the server names the pid server.json records"
            assert len(str(health.get("boot") or "")) == 8, "and a boot token new for each start"
            assert health["home"] == str(home.resolve()), "and its home, to the token's holder"
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health", timeout=5) as r:
            assert set(json.loads(r.read())) == {"ok", "boot", "ui"}, "no pid or path to a caller without the token"
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


def test_the_doctor_s_sandbox_line_follows_the_config(monkeypatch):
    """`thimble fix` and extension programs run their Bash in Claude Code's sandbox where it runs; sandbox.use "never"
    turns it off. Without it they run as they are, `thimble fix` asking first and a program posting a notice, unless
    sandbox.enforce refuses them."""
    from app import cc_settings, userconf

    conf = {"sandbox": {"use": "when-available", "enforce": False}}
    monkeypatch.setattr(userconf, "load_or_defaults", lambda c=None: (conf, ""))
    monkeypatch.setattr(cc_settings, "sandbox_missing", lambda: [])
    assert cli.sandbox_lines()[0].startswith("  bash sandbox (thimble fix and extension programs): runs; ")
    assert ".cc-writes" not in cli.sandbox_lines()[0] and "fence" not in cli.sandbox_lines()[0]
    conf["sandbox"]["use"] = "never"
    assert cli.sandbox_lines() == ["  bash sandbox (thimble fix and extension programs): off in thimble's config "
                                   "(sandbox.use \"never\"); they run without it (thimble fix asks you first; an "
                                   "extension program's notice says so)"]
    conf["sandbox"] = {"use": "when-available", "enforce": True}
    monkeypatch.setattr(cc_settings, "sandbox_missing", lambda: ["bubblewrap"])
    monkeypatch.setattr(cc_settings, "sandbox_setup", lambda: ([], ""))
    assert cli.sandbox_lines() == ["  bash sandbox (thimble fix and extension programs): off, missing bubblewrap; "
                                   "thimble's config (sandbox.enforce) refuses to start them without it"]


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


INTERNAL_WORDS = re.compile(r"fence|module|delivery|turn ending|ui_key|server\.json", re.I)


def checklist(text: str) -> list[tuple[str, str, str]]:
    """(mark, line, fix) of each ✓ or ! line of the checklist, the fix line under a problem, '' for none; asserts the
    head, the tail, the lengths and the words."""
    rows = text.splitlines()
    assert rows[0] == "thimble doctor" and rows[-1] == cli.DETAILS_LINE
    out: list[tuple[str, str, str]] = []
    for row in rows[1:-1]:
        assert not INTERNAL_WORDS.search(row), row
        if row.startswith("  "):
            assert out and out[-1][0] == "!" and not out[-1][2] and len(row) <= cli.FIX_LINE_MAX, row
            out[-1] = (*out[-1][:2], row.strip())
        else:
            assert row[:2] in ("✓ ", "! ") and len(row) <= cli.CHECK_LINE_MAX, row
            out.append((row[0], row[2:], ""))
    assert all(fix for mark, _, fix in out if mark == "!"), "a fix line under each problem"
    return out


def test_thimble_fix_asks_before_a_session_with_no_sandbox_edits_thimble_s_code(monkeypatch):
    """`thimble fix` runs a session that edits thimble's code without asking; where it has no sandbox it asks first in
    the terminal (dev.FIX_QUESTION), and anything but yes stops it."""
    from app import dev

    asked: list[str] = []
    monkeypatch.setattr("sys.stdin.isatty", lambda: True)
    monkeypatch.setattr(dev, "fix_contained", lambda: False)
    monkeypatch.setattr("builtins.input", lambda q: asked.append(q) or "y")
    assert cli.fix_refusal() == "" and asked == [f"thimble fix: {dev.FIX_QUESTION} [y/N] "]
    assert "no sandbox" in dev.FIX_QUESTION and dev.FIX_QUESTION != dev.CODE_QUESTION
    monkeypatch.setattr("builtins.input", lambda q: "")
    assert cli.fix_refusal() == cli.FIX_DECLINED
    monkeypatch.setattr(dev, "fix_contained", lambda: True)
    assert cli.fix_refusal() == "", "contained: nothing to ask"


def test_restart_names_the_running_orientations_and_ticket_and_asks_no_route_the_server_lacks(monkeypatch):
    """running_work asked GET /api/sessions/running, a route thimble 0.6.0 removed, so it always fell back; it now reads
    the orientations' run.json and the dev runner's status alone."""
    asked = []

    def request(method, url, body=None, timeout=5.0):
        asked.append(url.split("8300", 1)[1])
        return 200, {"running": True, "current": {"title": "Darker accent", "workspace": "trials"}}

    monkeypatch.setattr(cli, "_request", request)
    monkeypatch.setattr(cli, "_workspace_names", lambda d: ["board-sim", "trials"])
    monkeypatch.setattr(cli, "orient_status", lambda c: "running" if c == "trials" else "done")
    assert cli.running_work("http://127.0.0.1:8300") == ["trials: the orientation", 'trials: the dev ticket "Darker accent"']
    assert asked == ["/api/dev/status"]
