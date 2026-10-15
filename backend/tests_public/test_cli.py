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
NAME_SESSION = cli.name_session  # the named_sessions fixture replaces it; a test of what it sends puts it back
INSTALLED_COPY = cli.installed_copy  # before conftest's autouse fixture stands it in
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


def test_up_gives_a_new_session_the_precached_context_once(home, data, monkeypatch, capsys):
    """/thimble in a session new to a workspace `thimble demo` installed from a pre-cache: the line says the session
    starts fresh from the orientation's cards and report, and the context the server rendered follows the lines the
    model repeats (precached.take_context answers it once per session)."""
    _healthy_no_process(monkeypatch)
    asked = []

    def request(m, u, b=None, timeout=5.0):
        if m == "POST" and u.endswith("/api/ws/mini/precached/context"):
            asked.append(b["session"])
            return 200, {"text": "This workspace was installed from a pre-cache.\n\n## The canvas\n\n- card:c1" if len(asked) == 1 else ""}
        return 404, {"detail": "Not Found"}

    monkeypatch.setattr(cli, "_request", request)
    assert cli.main(["up", "--cwd", str(data / "mini" / "agents"), "--session", "s9"]) == 0
    out = capsys.readouterr().out
    assert out.splitlines()[:2] == [cli.LINK_LINE, cli.PRECACHED_LINE] and out.rstrip().endswith("- card:c1")
    assert cli.main(["up", "--cwd", str(data / "mini" / "agents"), "--session", "s9"]) == 0
    assert capsys.readouterr().out.splitlines() == [cli.LINK_LINE] and asked == ["s9", "s9"]
    # a bare `thimble up` in a shell is no session: nothing is asked
    assert cli.main(["up", "--cwd", str(data / "mini" / "agents")]) == 0
    assert asked == ["s9", "s9"]


def test_a_server_that_runs_but_does_not_answer_is_named_with_the_command_that_restarts_it(home, monkeypatch):
    """thimble's own server alive on its port but not answering (out of file descriptors, as on a Mac whose views'
    kernels took its 256): start_failure, the doctor's port line and `thimble demo` name it and say
    `thimble server restart`, rather than "see the log" or "another program". Its own new server is still starting,
    and server.json's server that started moments ago is not called stuck."""
    from app import demo  # noqa: PLC0415

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
    said: list[str] = []
    assert demo._server(said.append)[0] is None and said == [f"  no thimble server answers: {line}"]

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


def test_slash_thimble_in_a_plain_claude_says_what_its_environment_lacks_and_leaves_it_for_the_stop_hook(
        home, data, monkeypatch, capsys, tmp_path):
    """/thimble in a plain `claude` opens thimble as the launcher does. What the launcher would have given main and the
    session lacks gets a line each, printed (the model relays thimble: lines) and left under the link for the Stop hook
    (live check L15: a reply may leave a line out): an effort or subagent model variable set in the environment or in an
    `env` block of the analyst's settings, and a proxy that no NO_PROXY keeps off 127.0.0.1. The server gets their
    keys and writes its own words. A launched main gets the link alone."""
    _healthy_no_process(monkeypatch)
    told = []

    def request(m, u, b=None, timeout=5.0):
        if u.endswith("/session"):
            told.append(b)
            return 200, {}
        return 404, {}

    monkeypatch.setattr(cli, "_request", request)
    monkeypatch.setattr(cli, "launched", lambda: False)
    monkeypatch.setattr(cli.cc_plugin, "claude_pid", lambda environ=None: None)
    monkeypatch.setattr(cli, "name_session", NAME_SESSION)
    for name in (*cli.UNSET_VARS, *cli.PROXY_VARS):
        monkeypatch.delenv(name, raising=False)
    for name in cli.NO_PROXY_VARS:  # as the session gave them to this process (config.GIVEN_NO_PROXY)
        monkeypatch.setitem(cli.config.GIVEN_NO_PROXY, name, "")
    assert cli.main(["up", "--cwd", str(data / "mini" / "agents"), "--session", "s7"]) == 0
    assert capsys.readouterr().out.splitlines() == [cli.LINK_LINE]
    assert "\n" not in (home / "links" / "s7").read_text() and told[-1]["warnings"] == []
    monkeypatch.setenv("CLAUDE_CODE_SUBAGENT_MODEL", "haiku")
    monkeypatch.setenv("HTTPS_PROXY", "http://proxy.example:3128")
    monkeypatch.setitem(cli.config.GIVEN_NO_PROXY, "NO_PROXY", "corp.example")
    # what config made of it as it loaded, which keeps thimble's own requests off the proxy but not the plugin's
    monkeypatch.setenv("NO_PROXY", "corp.example,127.0.0.1,localhost")
    (tmp_path / "claude-home" / "settings.json").write_text(json.dumps({"env": {cli.EFFORT_ENV: "high"}}))
    assert cli.main(["up", "--cwd", str(data / "mini" / "agents"), "--session", "s7"]) == 0
    lines = [cli.SETUP_ENV_LINE.format(name=cli.EFFORT_ENV),
             cli.SETUP_ENV_LINE.format(name="CLAUDE_CODE_SUBAGENT_MODEL"), cli.SETUP_PROXY_LINE]
    assert capsys.readouterr().out.splitlines() == [cli.LINK_LINE, *lines]
    assert (home / "links" / "s7").read_text().split("\n") == ["http://127.0.0.1:5300/?ws=mini", *lines]
    assert told[-1]["warnings"] == [f"env:{cli.EFFORT_ENV}", "env:CLAUDE_CODE_SUBAGENT_MODEL", "proxy"]
    assert not [w for w in told[-1]["warnings"] if " " in w], "keys only: the server writes the words"
    monkeypatch.setitem(cli.config.GIVEN_NO_PROXY, "NO_PROXY", "corp.example, localhost")
    assert cli.proxy_unsafe() is False and cli.setup_warnings(data) == [f"env:{cli.EFFORT_ENV}",
                                                                         "env:CLAUDE_CODE_SUBAGENT_MODEL"]
    monkeypatch.setattr(cli, "launched", lambda: True)
    assert cli.main(["up", "--cwd", str(data / "mini" / "agents"), "--session", "s6"]) == 0
    assert capsys.readouterr().out.splitlines() == [cli.LINK_LINE]
    assert "\n" not in (home / "links" / "s6").read_text() and told[-1]["warnings"] == []


def test_slash_thimble_makes_its_session_main_with_a_launch_record_and_marks_the_folder(home, data, monkeypatch,
                                                                                        capsys, tmp_path):
    """/thimble in a session the launcher did not start writes launch.json for it (`via: skill`, its `claude` process,
    its CLAUDE_CONFIG_DIR), which the hooks module's bridge reads; a record that names the same `claude` already, as
    the launcher's does, is left alone. The folder is marked active, as itself and as its real path, for the plugin's
    watcher, and the server hears whether Claude Code's own sandbox is on."""
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
    assert cli.main(["up", "--cwd", str(link), "--session", "s5"]) == 0
    assert capsys.readouterr().out.splitlines() == [cli.LINK_LINE]
    assert told[-1] == {"session": "s5", "cwd": str(link), "warnings": [], "sandbox": True}
    with cli.server_dirs():
        rec = cli.read_launch("mini")
    assert {k: rec[k] for k in ("session", "pid", "via", "mode", "config_dir")} == {
        "session": "s5", "pid": 4242, "via": "skill", "mode": "browser", "config_dir": str(tmp_path / "claude-home")}
    assert "fenced" not in rec
    marks = {p.name for p in (home / cli.ACTIVE_DIR).iterdir()}
    assert marks == {str(link).replace("/", "%"), str((data / "mini").resolve()).replace("/", "%")}
    with cli.server_dirs():
        path = config.workspace_path("mini") / cli.LAUNCH_FILE
    path.write_text(json.dumps({**rec, "at": "kept", "via": "launcher's"}))
    assert cli.main(["up", "--cwd", str(link), "--session", "s5"]) == 0
    assert json.loads(path.read_text())["at"] == "kept", "the same claude: the record is left alone"


def test_a_launch_record_from_slash_thimble_is_live_while_its_claude_runs_that_session_or_one_it_moved_to(
        home, data, tmp_path):
    """open_elsewhere reads launch.json's `claude`: a record /thimble wrote (`via: skill`) names a `claude` whose
    command line need not name its session, so Claude Code's own record of that process
    (<config_dir>/sessions/<pid>.json) must name the record's session, or one subagents.json records as moved from it
    (/clear)."""
    from app import subagent_files

    cc = tmp_path / "cc"
    (cc / "sessions").mkdir(parents=True)
    main = _claude_process(tmp_path, "--permission-mode", "auto")
    try:
        rec = {"session": "s1", "pid": main.pid, "via": "skill", "config_dir": str(cc), "mode": "terminal"}
        assert cli.live_launch(rec) is False, "no record of the process"
        (cc / "sessions" / f"{main.pid}.json").write_text(json.dumps({"pid": main.pid, "sessionId": "s1"}))
        assert cli.live_launch(rec) is True
        (cc / "sessions" / f"{main.pid}.json").write_text(json.dumps({"pid": main.pid, "sessionId": "s2"}))
        assert cli.live_launch(rec, "mini") is False, "another session"
        with cli.server_dirs():
            ws = config.workspace_dir("mini")
            state = subagent_files.read(ws)
            subagent_files.rekey(state, "s1", "s2")
            subagent_files.state_path(ws).write_text(json.dumps(state))
            assert cli.live_launch(rec, "mini") is True, "/clear moved the session"
            (ws / cli.LAUNCH_FILE).write_text(json.dumps(rec))
            assert cli.open_elsewhere("mini", "browser") == cli.OPEN_ELSEWHERE_LINE.format(mode="terminal")
        assert cli.live_launch({**rec, "via": ""}) is False, "the launcher's record needs its session in argv"
    finally:
        main.kill()
        main.wait()
    assert cli.live_launch(rec, "mini") is False, "gone"


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


def test_write_state_drops_a_ui_key_an_earlier_build_kept(home):
    cli.write_state({"port": 8300, "token": "t", "ui_key": "old"})
    assert "ui_key" not in cli.read_state()
    (home / "server.json").write_text(json.dumps({"port": 8300, "token": "t", "ui_key": "old"}))
    cli.write_state({"port": 8301})
    assert cli.read_state() == {"port": 8301, "token": "t"}


def test_the_launcher_and_slash_thimble_say_nothing_of_claude_code_s_trust(home, data, monkeypatch, capsys,
                                                                       claude_global_config):
    """Neither the launcher nor /thimble warns about trust, whatever Claude Code's config says. Only the doctor's hooks
    module line names an untrusted folder, since Claude Code loads thimble's module only in a folder it trusts."""
    _healthy_no_process(monkeypatch)
    monkeypatch.setattr(cli, "_request", lambda m, u, b=None, timeout=5.0: (404, {}))
    claude_global_config.write_text("{}")
    assert cli.main(["up", "--cwd", str(data / "mini" / "agents"), "--session", "s9"]) == 0
    assert capsys.readouterr().out.splitlines() == [cli.LINK_LINE]
    assert (home / "links" / "s9").read_text().strip().count("\n") == 0, "the Stop hook shows the link alone"
    monkeypatch.setattr(cli, "launch_args", lambda cwd, resume=False, settings="", **kw: "args")
    monkeypatch.setattr(cli, "claude_code_warning", lambda v, once=True: None)
    assert cli.main(["launch-args", "--cwd", str(data / "mini")]) == 0
    assert capsys.readouterr().err == ""
    text = cli.doctor_text()
    assert not hasattr(cli, "trust_command")
    assert [ln for ln in text.splitlines() if "trust" in ln] == [line(text, "hooks module")]


def line(text: str, key: str) -> str:
    """The first line of doctor's text that starts with `key`."""
    return next(ln for ln in text.splitlines() if ln.strip().startswith(key))


def test_install_md_and_readme_name_the_claude_code_version_thimble_is_tested_with():
    root = BACKEND.parent
    for doc in ("INSTALL.md", "README.md"):
        named = re.findall(r"tested with (\d+\.\d+\.\d+)", (root / doc).read_text("utf-8"))
        assert named and set(named) == {cli.TESTED_CLAUDE_CODE}, f"{doc} names {named}, cli.py {cli.TESTED_CLAUDE_CODE}"


def claude_at(tmp_path: Path, monkeypatch, version: str) -> None:
    """A stand-in `claude` that names itself `version`, as config.CLI_PATH."""
    exe = tmp_path / f"claude-{version}"
    exe.write_text(f'#!/bin/sh\n[ "$1" = --version ] && echo "{version} (Claude Code)"\nexit 0\n')
    exe.chmod(0o755)
    monkeypatch.setattr(config, "CLI_PATH", str(exe))


def version_key(v: str) -> tuple[int, ...]:
    return tuple(int(x) for x in v.split("."))


def test_claude_code_too_old_for_mods_older_or_newer_than_tested_each_get_their_line(home, monkeypatch, tmp_path):
    """Below 2.1.287 Claude Code does not load plugin mods by default, so thimble's agents cannot start; below the tested
    version thimble may fail; above it, a hint that comes once per version on this machine, recorded in THIMBLE_HOME,
    and every time in the doctor. The tested version itself gets none."""
    tested = cli.TESTED_CLAUDE_CODE
    thimble = json.loads((BACKEND.parent / "plugin" / ".claude-plugin" / "plugin.json").read_text())["version"]
    assert version_key(cli.MODS_CLAUDE_CODE) == (2, 1, 287) and version_key(tested) >= (2, 1, 291)
    assert cli.claude_code_warning("2.1.285") == (
        "thimble: WARNING - Claude Code 2.1.285 does not load plugin mods by default (2.1.287 or later does), so "
        "thimble's agents cannot start. Run `claude update`, or `claude install latest` if you follow the stable channel.")
    assert cli.claude_code_warning("1.0.99").startswith("thimble: WARNING - Claude Code 1.0.99 does not")
    for v in ("2.1.287", "2.1.290"):
        assert cli.claude_code_warning(v) == (f"thimble: WARNING - Claude Code {v} is older than {tested}, the version "
                                              "thimble is tested with; if something fails, run `claude update` and start "
                                              "thimble again.")
    assert cli.claude_code_warning(tested) is None and cli.claude_code_warning(None) is None
    assert cli.claude_code_warning("no version") is None
    newer = (f"thimble: Claude Code 2.1.302 is newer than {tested}, the version thimble {thimble} was tested with. If "
             "agents do not start or their chats stop updating, run `thimble doctor` and report it.")
    seen = home / cli.CLAUDE_CODE_SEEN_FILE
    assert not seen.exists()
    assert cli.claude_code_warning("2.1.302") == newer
    assert json.loads(seen.read_text()) == {"newer_told": ["2.1.302"]}
    assert cli.claude_code_warning("2.1.302") is None, "once per version on this machine"
    assert cli.claude_code_warning("2.1.302", once=False) == newer, "the doctor's, each time"
    assert cli.claude_code_warning("2.1.303") == newer.replace("2.1.302", "2.1.303"), "a newer one is told again"
    assert cli.claude_code_warning("2.1.302") is None and json.loads(seen.read_text())["newer_told"] == ["2.1.302", "2.1.303"]
    seen.write_text("not json")
    assert cli.claude_code_warning("2.1.302") == newer, "an unreadable record tells again"
    monkeypatch.setattr(cli, "healthy", lambda url=None, timeout=1.0: False)
    monkeypatch.setattr(cli, "listening", lambda p: False)
    for v, doctor, for_a_model in (
            ("2.1.285", "Claude Code 2.1.285 does not load plugin mods by default (2.1.287 or later does), so thimble's "
                        "agents cannot start. Run `claude update`, or `claude install latest` if you follow the stable "
                        "channel.",
             "2.1.285, older than 2.1.287, the first version that loads plugin mods by default, so thimble's agents "
             "cannot start"),
            ("2.1.290", f"Claude Code 2.1.290 is older than {tested}, the version thimble is tested with; if something "
                        "fails, run `claude update` and start thimble again.",
             f"2.1.290, older than {tested}, the version thimble is tested with"),
            ("2.1.302", f"Claude Code 2.1.302 is newer than {tested}, the version thimble {thimble} was tested with. If "
                        "agents do not start or their chats stop updating, report it (`thimble feedback`).",
             f"2.1.302, newer than {tested}, the version thimble {thimble} was tested with"),
            (tested, f"{tested} (thimble is tested with {tested})", f"{tested} (thimble is tested with {tested})")):
        claude_at(tmp_path, monkeypatch, v)
        assert line(cli.doctor_text(), "claude code:") == f"  claude code: {doctor}"
        text = cli.doctor_text(commands=False)
        assert line(text, "claude code:") == f"  claude code: {for_a_model}"
        assert not cli._INSTALL_COMMAND.search(text) and "claude update" not in text and "claude install" not in text


def test_the_launcher_and_slash_thimble_say_how_claude_code_s_version_stands(home, data, monkeypatch, capsys, tmp_path):
    """The launcher prints the version's line on the terminal before Claude Code starts, and /thimble in its output;
    a newer Claude Code's hint comes once, at whichever shows it first."""
    _healthy_no_process(monkeypatch)
    monkeypatch.setattr(cli, "_request", lambda m, u, b=None, timeout=5.0: (404, {}))
    monkeypatch.setattr(cli, "launch_args", lambda cwd, resume=False, settings="", **kw: "args")

    def launch() -> str:
        assert cli.main(["launch-args", "--cwd", str(data / "mini")]) == 0
        return capsys.readouterr().err

    def slash_thimble() -> list[str]:
        assert cli.main(["up", "--cwd", str(data / "mini" / "agents"), "--session", "s9"]) == 0
        return capsys.readouterr().out.splitlines()

    for v in ("2.1.285", "2.1.290"):
        claude_at(tmp_path, monkeypatch, v)
        warning = cli.claude_code_warning(v)
        assert warning.startswith("thimble: WARNING - ")
        assert launch() == warning + "\n" and launch() == warning + "\n", "each launch"
        assert slash_thimble() == [cli.LINK_LINE, warning]
    claude_at(tmp_path, monkeypatch, cli.TESTED_CLAUDE_CODE)
    assert launch() == "" and slash_thimble() == [cli.LINK_LINE]
    claude_at(tmp_path, monkeypatch, "2.1.302")
    newer = cli.claude_code_warning("2.1.302", once=False)
    assert launch() == newer + "\n"
    assert launch() == "" and slash_thimble() == [cli.LINK_LINE], "told once on this machine"
    claude_at(tmp_path, monkeypatch, "2.1.303")
    assert slash_thimble() == [cli.LINK_LINE, newer.replace("2.1.302", "2.1.303")] and launch() == ""
    assert "2.1.303 is newer" in line(cli.doctor_text(), "claude code:"), "the doctor says it each time"


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


def test_the_doctor_says_what_the_launch_sets_and_whether_the_module_ran(
        home, monkeypatch, fake_claude, tmp_path, claude_global_config):
    """For a session `thimble` starts in the folder: the switches it exports and the variables it unsets, safe mode,
    and thimble's hooks module: off and why (managed settings, THIMBLE_NO_MODULE), its last hello, or why it stayed
    idle, with an untrusted folder named. There is no fence line: thimble adds no sandbox to main's session."""
    from app import cc_plugin

    monkeypatch.setattr(cli, "healthy", lambda url=None, timeout=1.0: False)
    monkeypatch.setattr(cli, "listening", lambda p: False)
    monkeypatch.setattr(cc_plugin, "MANAGED_DIRS", {})
    monkeypatch.setenv("THIMBLE_SANDBOX", "1")
    for name in (*cli.UNSET_VARS, cli.NO_MODULE_ENV, cli.SAFE_MODE_ENV):
        monkeypatch.delenv(name, raising=False)
    data = tmp_path / "data"
    data.mkdir()
    monkeypatch.setenv("THIMBLE_DATA_DIR", str(data))
    monkeypatch.setenv("THIMBLE_WORKSPACES_DIR", str(tmp_path / "ws"))
    corpus = tmp_path / "logs"
    corpus.mkdir()
    monkeypatch.setenv("THIMBLE_CALLER_CWD", str(corpus))
    text = cli.doctor_text()
    assert "fence" not in text
    assert "CLAUDE_CODE_DISABLE_AGENT_VIEW=1" in line(text, "launch switches") and "none set here" in line(text, "launch")
    assert line(text, "safe mode") == "  safe mode: off"
    assert "no session here has run it yet" in line(text, "hooks module")
    with cli.server_dirs():
        config.register_corpus(corpus, exact=True)
        ws = config.workspace_dir("logs")
    (ws / cli.LAUNCH_FILE).write_text(json.dumps({"session": "s1", "at": "2026-10-06T05:00:00"}))
    (ws / "trusted" / "subagents.json").write_text(json.dumps({"module": {"session": "0b9d2f3e-1c2d", "version": "0.6.0",
                                                              "at": "2026-10-06T05:00:01"}}))
    claude_global_config.write_text(json.dumps({"projects": {str(tmp_path): {"hasTrustDialogAccepted": True}}}))
    monkeypatch.setenv("CLAUDE_CODE_EFFORT_LEVEL", "high")
    text = cli.doctor_text()
    assert "unsets CLAUDE_CODE_EFFORT_LEVEL (set here)" in line(text, "launch switches")
    assert line(text, "hooks module").endswith("it ran in the last session (hello from 0b9d2f3e at 2026-10-06T05:00:01, "
                                               "version 0.6.0)")
    (ws / "trusted" / "subagents.json").write_text(json.dumps({"module": {"session": "s2", "at": "t", "idle": "main does not run "
                                                                                                "inside thimble's sandbox"}}))
    claude_global_config.write_text("{}")
    got = line(cli.doctor_text(), "hooks module")
    assert "stayed idle in the last session (t): main does not run inside thimble's sandbox" in got
    assert f"Claude Code does not trust {corpus} yet" in got
    monkeypatch.setenv(cli.NO_MODULE_ENV, "1")
    monkeypatch.setenv(cli.SAFE_MODE_ENV, "1")
    text = cli.doctor_text()
    assert line(text, "hooks module").endswith(f"off: Claude Code's hooks modules are off ({cli.NO_MODULE_ENV} is set), "
                                               "so thimble's agents cannot start in this folder")
    assert line(text, "safe mode").startswith("  safe mode: on")


def test_the_doctor_names_the_mode_its_source_the_renderer_and_what_terminal_mode_needs(
        home, monkeypatch, fake_claude, tmp_path):
    """For a session `thimble` starts in the folder: its mode and where that comes from, the mode the last launch here
    ran in when that was another, whether terminal mode's renderer can load, and in terminal mode where a card's code
    runs (main's Bash, in Claude Code's sandbox when it can run) and whether its optional card checks run (a headless
    Chromium and the built frontend)."""
    from app import cc_plugin, cc_settings, launch_mode

    monkeypatch.setattr(cli, "healthy", lambda url=None, timeout=1.0: False)
    monkeypatch.setattr(cli, "listening", lambda p: False)
    monkeypatch.setattr(cc_plugin, "MANAGED_DIRS", {})
    monkeypatch.setenv("THIMBLE_SANDBOX", "1")
    data = tmp_path / "data"
    data.mkdir()
    monkeypatch.setenv("THIMBLE_DATA_DIR", str(data))
    monkeypatch.setenv("THIMBLE_WORKSPACES_DIR", str(tmp_path / "ws"))
    corpus = tmp_path / "logs"
    corpus.mkdir()
    monkeypatch.setenv("THIMBLE_CALLER_CWD", str(corpus))
    renderer = tmp_path / "tree" / "mods" / "thimble-term"
    monkeypatch.setattr(cli, "renderer_root", lambda: renderer)
    text = cli.doctor_text()
    assert line(text, "mode (") == (f"  mode (a session in {corpus}): browser (thimble's default; "
                                    "`thimble mode` changes it)")
    assert line(text, "terminal renderer") == (f"  terminal renderer: cannot load ({renderer} is missing), so terminal "
                                               "mode draws none of thimble's work; browser mode does not need it")
    assert "terminal mode's card" not in text, "browser mode needs neither"
    (renderer / ".claude-plugin").mkdir(parents=True)
    (renderer / ".claude-plugin" / "plugin.json").write_text(json.dumps({"name": "thimble-term"}))
    launch_mode.set_folder(corpus, "terminal")
    monkeypatch.setattr(cli, "_browser_choice", lambda: ("bundled", ""))
    monkeypatch.setattr(cli, "headless_fetched", lambda browsers_json: True)
    text = cli.doctor_text()
    assert line(text, "mode (").endswith("terminal (set for this folder; `thimble mode` changes it)")
    assert line(text, "terminal renderer") == f"  terminal renderer: {renderer} (thimble-term), loaded only in terminal mode"
    assert line(text, "terminal mode's card code").endswith(
        "runs in main's Bash with your user's access; Claude Code asks about or judges each thimble-run command, as for "
        "any command; a card check's trial runs in the sandbox runtime where it can run")
    assert line(text, "terminal mode's card checks").endswith("on: a card is checked, and a screenshot drawn, with the "
                                                              "headless Chromium and the built frontend")
    monkeypatch.setattr(cli, "headless_fetched", lambda browsers_json: False)
    monkeypatch.setattr(cli, "has_ui_build", lambda: False)
    monkeypatch.setenv("THIMBLE_SANDBOX", "0")
    text = cli.doctor_text()
    assert line(text, "terminal mode's card checks").endswith("off, since there is no headless Chromium and no "
                                                              "frontend build: cards are not checked and screenshots "
                                                              "are not drawn")
    assert "with your user's access" in line(text, "terminal mode's card code")
    monkeypatch.setattr(cli, "terminal_views_wrap", lambda: "")
    monkeypatch.setattr(cc_settings, "kernel_setup", lambda: (["sudo apt-get install -y bubblewrap"], "set up bubblewrap"))
    assert line(cli.doctor_text(), "terminal mode's views").endswith(
        "can't run (neither the sandbox runtime nor bubblewrap runs here); to add bubblewrap, run: sudo apt-get install "
        "-y bubblewrap")
    assert "apt-get" not in line(cli.doctor_text(commands=False), "terminal mode's views")
    monkeypatch.setattr(cli, "terminal_views_wrap", lambda: "bubblewrap")
    assert line(cli.doctor_text(), "terminal mode's views") == "  terminal mode's views: bubblewrap"
    with cli.server_dirs():
        config.register_corpus(corpus, exact=True)
        ws = config.workspace_dir("logs")
    (ws / cli.LAUNCH_FILE).write_text(json.dumps({"session": "s1", "at": "2026-10-06T05:00:00", "mode": "browser"}))
    assert line(cli.doctor_text(), "mode (").endswith("; the last launch here (2026-10-06T05:00:00) ran in browser mode")
    # after a terminal-mode launch the module reads its roles from roles.json and writes its heartbeat to module.json
    (ws / cli.LAUNCH_FILE).write_text(json.dumps({"session": "s1", "at": "2026-10-06T05:00:00", "mode": "terminal"}))
    got = line(cli.doctor_text(), "hooks module")
    assert "no terminal-mode session here has run it yet" in got and "wrote no roles file" in got
    (ws / cli.ROLES_FILE).write_text(json.dumps({"at": "t", "roles": {}}))
    (ws / cli.MODULE_OUT).write_text(json.dumps({"session": "0b9d2f3e-1c2d", "version": "0.6.0", "beat": "t2",
                                                 "problem": "no roles yet"}))
    got = line(cli.doctor_text(), "hooks module")
    assert ("it ran in the last session (terminal mode; heartbeat from 0b9d2f3e at t2, version 0.6.0); it reported: no "
            "roles yet; Claude Code does not trust") in got and "roles file" not in got
    # the module writes its times in milliseconds since the epoch (plugin/hooks/thimble.ts)
    (ws / cli.MODULE_OUT).write_text(json.dumps({"session": "0b9d2f3e-1c2d", "version": "0.6.0", "beat": 1791262800000}))
    assert "heartbeat from 0b9d2f3e at 2026-10-06T05:00:00+00:00, version 0.6.0)" in line(cli.doctor_text(), "hooks module")


def _claude_process(tmp_path: Path, *args: str) -> subprocess.Popen:
    """A process whose command line is `<tmp_path>/claude <args>`, as /proc shows it: this Python by a link named
    claude, sleeping."""
    link = tmp_path / "claude"
    if not link.exists():
        link.symlink_to(sys.executable)
    p = subprocess.Popen([str(link), "-c", "import time; time.sleep(60)", *args])
    for _ in range(300):
        if procs.argv(p.pid)[-1:] == list(args[-1:]):
            break
        time.sleep(0.01)
    return p


def test_slash_thimble_in_terminal_mode_starts_nothing_and_prints_the_home_hint(home, data, monkeypatch, capsys,
                                                                               tmp_path):
    """In a session the launcher started in terminal mode, /thimble's hook and the skill's `up` start no server and
    open nothing: the skill prints the `thimble-terminal-home` hint, which main repeats while the renderer opens the
    home panel; `/thimble fresh` and the like say they need browser mode. A session that lost THIMBLE_MODE is still
    known by launch.json's mode and session. The control, a browser-mode session, starts the server."""
    from app import tools

    started = []
    monkeypatch.setattr(cli, "ensure_running", lambda wait: started.append(1) or True)
    monkeypatch.setattr(cli, "_request", lambda *a, **k: (500, {}))
    folder = data / "mini"
    monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(folder))
    monkeypatch.setenv("THIMBLE_MODE", "terminal")
    hook = {"session_id": "s7", "cwd": str(folder), "command_name": "thimble:thimble", "command_args": ""}
    assert cli.hook_up(json.dumps(hook)) == 0 and capsys.readouterr().out == ""
    skill = ["server", "up", "--cwd", str(folder), "--session", "s7", "--action", "", "--archive", ""]
    assert cli.main(skill) == 0
    hint = tools.hint(cli.TERMINAL_HOME_HINT).strip()
    assert hint.startswith("thimble: ") and cli.terminal_home_line() == hint, "prompts/tools.md's hint, not the fallback"
    assert capsys.readouterr().out.splitlines() == [hint], "the hook's result"
    monkeypatch.setattr(tools, "descriptions", lambda: {cli.TERMINAL_HOME_HINT: "thimble: terminal mode. The home panel is open."})
    monkeypatch.setenv(cli.SANDBOX_ENV, "1")  # the skill's own `up`, in main's sandbox, with no result of the hook's
    assert cli.main(skill) == 0
    assert capsys.readouterr().out.splitlines() == ["thimble: terminal mode. The home panel is open."]
    assert cli.main([*skill[:-3], "fresh", "--archive", ""]) == 0
    assert capsys.readouterr().out.splitlines() == [cli.TERMINAL_ACTION_LINE.format(action="fresh")]
    assert cli.main(["server", "up", "--cwd", str(folder)]) == 0 and "terminal mode" in capsys.readouterr().out
    assert started == [] and not cli.server_json().exists() and not (home / "links").exists()
    monkeypatch.delenv(cli.SANDBOX_ENV)
    monkeypatch.delenv("THIMBLE_MODE")
    with cli.server_dirs():
        ws = config.workspace_dir("mini")
    (ws / cli.LAUNCH_FILE).write_text(json.dumps({"session": "s7", "mode": "terminal"}))
    assert cli.main(skill) == 0 and capsys.readouterr().out.splitlines()[0].startswith("thimble: terminal mode")
    assert started == []
    (ws / cli.LAUNCH_FILE).write_text(json.dumps({"session": "s7", "mode": "browser"}))
    assert cli.main(skill) == 0 and started == [1], "the control: browser mode starts the server"


def test_slash_thimble_refuses_the_browser_while_the_workspace_is_open_in_terminal_mode(home, data, monkeypatch, capsys,
                                                                                       tmp_path):
    """One mode per workspace at a time: a /thimble that would open the browser on a workspace a terminal-mode session
    runs in another terminal refuses, starting nothing; once that session is gone it opens as before."""
    started = []
    monkeypatch.setattr(cli, "ensure_running", lambda wait: started.append(1) or True)
    monkeypatch.setattr(cli, "_request", lambda *a, **k: (500, {}))
    folder = data / "mini"
    with cli.server_dirs():
        ws = config.workspace_dir("mini")
    sid = "0b9d2f3e-1c2d-4e5f-8a9b-0c1d2e3f4a5b"
    main = _claude_process(tmp_path, "--session-id", sid)
    try:
        (ws / cli.LAUNCH_FILE).write_text(json.dumps({"session": sid, "pid": main.pid, "mode": "terminal"}))
        assert cli.main(["up", "--cwd", str(folder), "--session", "s2"]) == 0
        assert capsys.readouterr().out.splitlines() == [cli.OPEN_ELSEWHERE_LINE.format(mode="terminal")]
        assert started == []
        assert cli.main(["up", "--cwd", str(folder), "--session", "s2", "--action", "status"]) == 0
        assert "open in terminal mode" not in capsys.readouterr().out, "a status line opens nothing"
    finally:
        main.kill()
        main.wait()
    assert cli.main(["up", "--cwd", str(folder), "--session", "s2"]) == 0
    assert "open in terminal mode" not in capsys.readouterr().out and started == [1]


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


def test_slash_thimble_s_hook_leaves_the_session_s_marker_for_the_hooks_module(home, monkeypatch, tmp_path):
    """/thimble's hook leaves <home>/up/<session>.active before its `up` runs, written anew at each /thimble: where an
    organization manages Claude Code, the module's skill.prompt hook does not run, and the module turns on when it finds
    a new marker at the end of main's turn (plugin/hooks/thimble.ts). The result for the skill's `up` is kept as before;
    a hook input with no usable session id leaves nothing."""
    seen = []

    def up(args):
        marker = cli.hook_marker_path(args.session)
        seen.append(marker is not None and marker.is_file())
        print(f"thimble: up {args.action}")

    monkeypatch.setattr(cli, "cmd_server_up", up)
    folder = tmp_path / "calls"
    folder.mkdir()
    monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(folder))
    hook = {"session_id": "s7", "cwd": str(folder), "command_name": "thimble:thimble", "command_args": ""}
    assert cli.hook_up(json.dumps(hook)) == 0
    marker = home / "up" / "s7.active"
    assert cli.hook_marker_path("s7") == marker and seen == [True], "the marker is there before `up` runs"
    first = json.loads(marker.read_text("utf-8"))
    assert first["cwd"] == str(folder) and first["action"] == ""
    assert marker.parent.stat().st_mode & 0o077 == 0, "only its owner reads <home>/up"
    assert cli.hook_up(json.dumps({**hook, "command_args": "status"})) == 0
    second = json.loads(marker.read_text("utf-8"))
    assert second["action"] == "status" and second["at"] > first["at"], "a new marker for each /thimble"
    assert cli.take_hook_result("s7", folder, "status", "") == "thimble: up status\n"
    assert marker.is_file(), "the skill's `up` takes the result and leaves the marker"
    assert cli.hook_up(json.dumps({**hook, "session_id": "../"})) == 0 and len(seen) == 2
    assert sorted(p.name for p in marker.parent.iterdir()) == ["s7.active"]


def test_the_doctor_says_when_the_analyst_s_own_sandbox_makes_a_folder_in_the_corpus(tmp_path, monkeypatch):
    """main's Bash runs in the analyst's own session, so with their Claude Code sandbox on it adds .claude/.cc-writes/
    to the folder `thimble` starts in; thimble leaves that session's settings alone and the doctor says so."""
    from app import cc_settings

    monkeypatch.setattr(cc_settings, "config_dir", lambda: tmp_path / "cc")
    monkeypatch.setattr(cli.cc_plugin, "claude_pid", lambda environ=None: None)
    monkeypatch.setattr(cli.cc_plugin, "managed", lambda environ=None: None)
    monkeypatch.setenv("THIMBLE_SANDBOX", "1")
    corpus = tmp_path / "corpus"
    (corpus / ".claude").mkdir(parents=True)
    off = "off (optional: INSTALL.md shows the settings that turn it on)"
    assert cli.own_sandbox_line(corpus) == off
    (tmp_path / "cc").mkdir()
    (tmp_path / "cc" / "settings.json").write_text(json.dumps({"sandbox": {"enabled": True}}))
    assert ".claude/.cc-writes/" in cli.own_sandbox_line(corpus) and str(corpus) in cli.own_sandbox_line(corpus)
    monkeypatch.setenv("THIMBLE_SANDBOX", "0")
    assert cli.own_sandbox_line(corpus).startswith("on in your settings, but it can't run here")
    monkeypatch.setenv("THIMBLE_SANDBOX", "1")
    (corpus / ".claude" / "settings.local.json").write_text(json.dumps({"sandbox": {"enabled": False}}))
    assert cli.own_sandbox_line(corpus) == off, "a later settings file turns it off"


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


def test_slash_thimble_reads_the_sessions_no_proxy_though_config_adds_127_0_0_1_to_its_own(tmp_path):
    """app/config.py adds 127.0.0.1 and localhost to NO_PROXY as it loads, so thimble's own requests skip a proxy, but
    the hooks module's requests go through the proxy the session sets: /thimble's proxy line and `setup` notice read
    NO_PROXY as the session gave it (config.GIVEN_NO_PROXY). Live check 11: with HTTP_PROXY set and no NO_PROXY, a
    process that imported config found no proxy problem, so neither showed. A new process, as /thimble's hook runs it."""
    code = "import os; from app import cli; print(cli.proxy_unsafe(), os.environ['NO_PROXY'])"
    base = {"PATH": "/usr/bin:/bin", "HOME": str(tmp_path), "THIMBLE_HOME": str(tmp_path / "home"),
            "THIMBLE_SKIP_KEY": "1", "HTTP_PROXY": "http://127.0.0.1:9"}

    def run(**extra: str) -> list[str]:
        return subprocess.run([sys.executable, "-c", code], env={**base, **extra}, cwd=BACKEND, capture_output=True,
                              text=True, check=True).stdout.split()

    assert run() == ["True", "127.0.0.1,localhost"], "config keeps its own requests off the proxy all the same"
    assert run(NO_PROXY="corp.example") == ["True", "corp.example,127.0.0.1,localhost"]
    assert run(NO_PROXY="corp.example,localhost")[0] == "False"
    assert run(no_proxy="127.0.0.1")[0] == "False"


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


def test_the_doctor_prints_a_checklist_a_person_can_read(home, monkeypatch, fake_claude, tmp_path, capsys):
    """`thimble doctor`: one line per area, ✓ or !, at most 80 characters, no internal names, and under each problem
    one line with its fix and where to run it; `--verbose` prints today's full text."""
    from app import cc_settings, config, launch_mode

    monkeypatch.setattr(cli, "healthy", lambda url=None, timeout=1.0: False)
    monkeypatch.setattr(cli, "listening", lambda p: False)
    monkeypatch.setattr(cli, "network_probe", lambda status=None, timeout_s=3.0: (True, ""))
    facts = cli.PluginFacts("thimble", cli.own_version(), True, True, cli.PLUGIN_DIR, True)
    monkeypatch.setattr(cli, "plugin_facts", lambda cwd: facts)
    monkeypatch.setattr(cli, "_views_check", lambda: cli.Check(True, "Views and screenshots ready"))
    monkeypatch.setattr(cli.cc_plugin, "claude_pid", lambda environ=None: None)
    monkeypatch.setenv("THIMBLE_SANDBOX", "1")
    corpus = tmp_path / "logs"
    corpus.mkdir()
    rows = checklist(cli.doctor_check_text(corpus))
    assert [mark for mark, _, _ in rows] == ["✓"] * 8, rows
    assert rows[0][1] == f"{cli._thimble_named()} · Claude Code {cli.TESTED_CLAUDE_CODE}"
    assert [line for _, line, _ in rows[1:]] == [
        "Signed in to Claude", "Server not running (it starts with /thimble)", "Plugin on in Claude Code",
        "Claude Code's sandbox: off (optional)", rows[5][1], "Views and screenshots ready",
        "thimble's agents start after /thimble here"]
    assert rows[5][1].startswith("Card code runs")

    # the port taken by another program: no problem without THIMBLE_PORT, since the next start passes over it
    monkeypatch.setattr(cli, "listening", lambda p: True)
    monkeypatch.setattr(cli, "stuck_server", lambda url=None: None)
    assert ("✓", "") == {line: (mark, fix) for mark, line, fix in checklist(cli.doctor_check_text(corpus))}[
        "Server not running (it starts with /thimble)"]
    # the port THIMBLE_PORT names taken by another program; not signed in; the plugin off; Claude Code's sandbox set
    # but unable to run
    monkeypatch.setenv("THIMBLE_PORT", "21101")
    fake_claude.write_text(json.dumps({"loggedIn": False}))
    monkeypatch.setattr(cli, "plugin_facts", lambda cwd: facts._replace(enabled=False))
    monkeypatch.setattr(cli, "own_sandbox_set", lambda cwd: True)
    monkeypatch.setenv("THIMBLE_SANDBOX", "0")
    rows = {line: (mark, fix) for mark, line, fix in checklist(cli.doctor_check_text(corpus))}
    assert rows[f"Port {cli.port()} is taken by another program"] == (
        "!", "In a shell: stop that program, then thimble server restart")
    assert rows["Not signed in to Claude"] == ("!", "In a shell: claude auth login")
    assert rows["Plugin is off in Claude Code"] == ("!", "In the Claude Code terminal: /plugin, then turn thimble on")
    assert rows["Claude Code's sandbox is on in your settings but can't run here"][0] == "!"
    monkeypatch.setattr(cli, "stuck_server", lambda url=None: 4242)
    assert ("!", "In a shell: thimble server restart") in [
        (m, f) for m, line, f in checklist(cli.doctor_check_text(corpus)) if line == "The server is stuck (pid 4242)"]

    # terminal mode with no sandbox for its views; the plugin of another install; a problem past 80 characters
    launch_mode.set_folder(corpus, "terminal")
    monkeypatch.setattr(cli, "terminal_views_wrap", lambda: "")
    monkeypatch.setattr(cli, "plugin_facts", lambda cwd: cli.PluginFacts("other", "0.7.0", True, False, None, False,
                                                                          "/opt/thimble"))
    monkeypatch.setattr(cli, "_version_check", lambda: cli.Check(False, "word " * 30, "In a shell: " + "x " * 60))
    rows = checklist(cli.doctor_check_text(corpus))
    lines = {line: (mark, fix) for mark, line, fix in rows}
    assert lines["Terminal mode can't show views: no sandbox for them here"] == (
        "!", "thimble doctor --verbose names the commands that install bubblewrap")
    assert lines["Another install's plugin is on"] == ("!", "thimble doctor --verbose names the commands that switch it")
    assert rows[0][1].endswith("…") and rows[0][2].endswith("…"), "cut at a word"
    monkeypatch.setattr(cc_settings, "own_sandbox", lambda cwd: False)

    # `--verbose` prints today's text; the checklist names it last
    monkeypatch.setattr(cli, "doctor_text", lambda commands=True: "the full text")
    monkeypatch.setattr(cli, "ship_extensions", lambda: None)
    monkeypatch.setenv("THIMBLE_CALLER_CWD", str(corpus))
    assert cli.main(["doctor", "--verbose"]) == 0 and capsys.readouterr().out == "the full text\n"
    assert cli.main(["doctor"]) == 0 and capsys.readouterr().out.rstrip().endswith(cli.DETAILS_LINE)
    assert config.workspace_for_cwd(str(corpus)) is None, "the doctor registers nothing"


def test_the_doctor_s_agents_line_follows_the_last_session(home, monkeypatch, tmp_path, claude_global_config):
    """thimble's agents: they start after /thimble in a folder thimble never opened; once a session said hello, they can
    start; a session where they stayed idle, an untrusted workspace folder, or Claude Code's hooks off each get a
    problem line with its fix."""
    from app import cc_plugin

    monkeypatch.setattr(cc_plugin, "MANAGED_DIRS", {})
    for name in (cli.NO_MODULE_ENV,):
        monkeypatch.delenv(name, raising=False)
    data = tmp_path / "data"
    data.mkdir()
    monkeypatch.setenv("THIMBLE_DATA_DIR", str(data))
    monkeypatch.setenv("THIMBLE_WORKSPACES_DIR", str(tmp_path / "ws"))
    corpus = tmp_path / "logs"
    corpus.mkdir()

    def agents() -> cli.Check:
        with cli.server_dirs():
            return cli._agents_check(corpus)

    assert agents() == cli.Check(True, "thimble's agents start after /thimble here"), "never opened: trust is asked then"
    with cli.server_dirs():
        config.register_corpus(corpus, exact=True)
        ws = config.workspace_dir("logs")
    assert agents() == cli.Check(False, "Claude Code doesn't trust this folder yet",
                                 "In a shell: run claude here and accept the prompt")
    claude_global_config.write_text(json.dumps({"projects": {str(tmp_path): {"hasTrustDialogAccepted": True}}}))
    (ws / "trusted" / "subagents.json").write_text(json.dumps({"module": {"session": "s1", "at": "t"}}))
    assert agents() == cli.Check(True, "thimble's agents can start in this folder")
    (ws / "trusted" / "subagents.json").write_text(json.dumps({"module": {"session": "s1", "idle": "no hooks module"}}))
    got = agents()
    assert not got.ok and got.line == "thimble's agents didn't start in the last session"
    assert got.fix == "In the Claude Code terminal: /thimble; thimble doctor --verbose says why"
    monkeypatch.setenv(cli.NO_MODULE_ENV, "1")
    assert agents() == cli.Check(False, "thimble's agents can't start: Claude Code's hooks are off",
                                 f"In a shell: unset {cli.NO_MODULE_ENV}, then restart claude")
    monkeypatch.delenv(cli.NO_MODULE_ENV)
    (tmp_path / "claude-home" / "settings.json").write_text(json.dumps({"disableAllHooks": True}))
    assert agents().fix == "In your Claude Code settings: remove disableAllHooks, then restart claude"


def test_installed_copy_takes_any_thimble_plugin_of_this_install_and_notes_one_that_differs(home, tmp_path, monkeypatch):
    """Claude Code's thimble plugin, whatever its marketplace's name: a cache copy that finds this tree and whose files
    equal plugin/ but for those a release leaves out (the module's tests, its types, tsconfig.json) is the copy main
    loads; one whose files differ makes the launch load plugin/ too and say how to update it; another install's is not
    this install's. The doctor's plugin line names each case."""
    import shutil as sh

    cache = tmp_path / "cc" / "plugins" / "cache" / "thimble" / "thimble" / "0.8.0"
    sh.copytree(cli.PLUGIN_DIR, cache, ignore=sh.ignore_patterns("thimble.test.ts", "types", "tsconfig.json",
                                                                   "__pycache__", "node_modules"))
    (cache / "bin" / "thimble-app-dir").write_text(f'#!/bin/sh\necho "{config.REPO_ROOT}"\n')
    (cache / "bin" / "thimble-app-dir").chmod(0o755)
    path = tmp_path / "path"
    path.mkdir()
    listed = [{"id": "thimble@thimble", "enabled": True, "version": "0.8.0", "installPath": str(cache)}]
    (tmp_path / "listed.json").write_text(json.dumps(listed))
    (path / "claude").write_text(f'#!/bin/sh\ncase "$*" in *"marketplace list"*) echo "[]";; '
                                 f'*"plugin list"*) cat {tmp_path / "listed.json"};; esac\n')
    (path / "claude").chmod(0o755)
    monkeypatch.setenv("PATH", f"{path}:/usr/bin:/bin")
    # the stand-in's bin/thimble-app-dir names this tree directly, where plugin/'s finds it by its place
    monkeypatch.setattr(cli, "_plugin_files", lambda root, real_files=cli._plugin_files: {
        k: v for k, v in real_files(root).items() if k != "bin/thimble-app-dir"})
    cli.LAUNCH_NOTES.clear()
    assert INSTALLED_COPY(tmp_path) == cli.Installed(cache.resolve(), "thimble")
    assert cli.LAUNCH_NOTES == [] and cli.plugin_line(tmp_path).endswith("0.8.0, on, this install's")
    (cache / "hooks" / "thimble.ts").write_text("// another build\n")
    assert INSTALLED_COPY(tmp_path) is None
    assert cli.LAUNCH_NOTES == [cli.PLUGIN_DIFFERS_LINE.format(name="thimble", version="0.8.0")]
    assert "claude plugin marketplace update thimble && claude plugin update thimble@thimble" in cli.LAUNCH_NOTES[0]
    assert "differ" in cli.plugin_line(tmp_path) and "claude plugin update thimble@thimble" in cli.plugin_line(tmp_path)
    assert "claude plugin" not in cli.plugin_line(tmp_path, commands=False)
    cli.LAUNCH_NOTES.clear()
    (cache / "bin" / "thimble-app-dir").write_text('#!/bin/sh\necho "/opt/other-thimble"\n')
    assert INSTALLED_COPY(tmp_path) is None and cli.LAUNCH_NOTES == []
    assert "from another install (/opt/other-thimble)" in cli.plugin_line(tmp_path)
    (tmp_path / "listed.json").write_text(json.dumps([{**listed[0], "enabled": False}]))
    assert cli.plugin_line(tmp_path).startswith("thimble@thimble 0.8.0, off, from another install")
    (tmp_path / "listed.json").write_text("[]")
    assert cli.plugin_line(tmp_path).startswith(f"not added: bash {config.REPO_ROOT / 'scripts' / 'install.sh'}")
    assert cli.plugin_line(tmp_path, commands=False) == "not added to Claude Code"


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
