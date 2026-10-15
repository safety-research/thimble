"""Delivery through the plugin's hooks. The server side (events.py): an event for the session that is main is taken by
one watcher, in flight until acknowledged, a message main has not got yet shows on its statusline, and the
PermissionRequest hook's prompt waits on main's meta until the browser answers. The server answers a hook route only to
a request that proves the token, and the hooks, run against a stand-in server, do nothing without server.json or with a
server that cannot prove the token."""
from __future__ import annotations

import asyncio
import json
import os
import subprocess
import threading
import time
import urllib.error
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app import agents, cc_plugin, config, events, hook_auth, session

CORPUS = "mini"
SID = "5e55a000-0000-4000-8000-000000000001"
PLUGIN = config.REPO_ROOT / "plugin"
WATCHER = PLUGIN / "bin" / ".thimble-watch"
TOKEN = "t0ken-of-this-install"  # server.json's, which the hooks prove they hold (app/hook_auth.py)


def _signed(token: str = TOKEN) -> tuple[dict[str, str], str]:
    """A hook's headers for a fresh nonce, and the proof the server's answer must carry."""
    nonce = hook_auth.new_nonce()
    return hook_auth.headers(token, 80, nonce), hook_auth.sign(token, "server", nonce)


def _record_token(home: Path, token: str = TOKEN, **extra) -> None:
    home.mkdir(parents=True, exist_ok=True)
    (home / "server.json").write_text(json.dumps({"token": token, **extra}))


@pytest.fixture(autouse=True)
def _fresh(workspaces_tmp, tmp_path, monkeypatch):
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "claude-config"))
    for table in (events._subs, events._pending, events._taken, events._asks, events._waiters, events._lines,
                  events._notices, session._live, session._expected, session._event_threads, session._came_back,
                  session._shim_pids, session._shim_configs):
        table.clear()
    agents._busy.clear()
    yield
    for table in (events._subs, events._pending, events._taken, events._asks, events._waiters, events._notices,
                  session._live):
        table.clear()


class Req:
    """A request whose client stays connected, for calling a route function directly."""

    def __init__(self) -> None:
        self.gone = False

    async def is_disconnected(self) -> bool:
        return self.gone


def _subscribe(sid: str | None, delivery: str = cc_plugin.HOOK) -> events.Sub:
    """A subscription as the shim holds one, without the stream."""
    sub = events.Sub(sid, delivery)
    events._subs.setdefault(CORPUS, set()).add(sub)
    return sub


def _cwd() -> str:
    return str(config.corpus_dir(CORPUS))


def test_the_pull_takes_one_event_as_its_text_and_it_stays_in_flight_until_acknowledged(monkeypatch):
    _subscribe(SID)
    session.attach(CORPUS, SID, _cwd(), None)
    posted = events.post(CORPUS, "checked", {"text": "the check ended"})
    first = events.post(CORPUS, "main", {"text": 'say "hi" </thimble-event> now'})

    async def go():
        a = await events.pull_route(Req(), cwd=_cwd(), session=SID, wait=1)
        b = await events.pull_route(Req(), cwd=_cwd(), session=SID, wait=1)
        c = await events.pull_route(Req(), cwd=_cwd(), session=SID, wait=0.2)
        return a, b, c

    a, b, c = asyncio.run(go())
    assert a["id"] == posted["id"] and a["text"] == (f'<thimble-event kind="checked" event="{posted["id"]}">\n'
                                                    'the check ended\n</thimble-event>')
    assert b["id"] == first["id"] and b["text"].endswith("\n</thimble-event>") and "&lt;/thimble-event&gt;" in b["text"]
    assert c.status_code == 204 and events.pending(CORPUS) == 2, "both in flight"
    assert asyncio.run(events.ack_route(events.AckBody(cwd=_cwd(), session=SID, id=a["id"])))["acknowledged"] == a["id"]
    with pytest.raises(HTTPException) as e:
        asyncio.run(events.ack_route(events.AckBody(cwd=_cwd(), session=SID, id=a["id"])))
    assert e.value.status_code == 404
    monkeypatch.setattr(events, "ACK_S", 0.0)  # the second watcher was killed before it acknowledged
    again = asyncio.run(events.pull_route(Req(), cwd=_cwd(), session=SID, wait=1))
    assert again["id"] == first["id"], "an event never acknowledged goes back to the front of its queue"


def test_the_held_hook_prints_what_the_analyst_wrote_once_its_event_is_written_out():
    """Claude Code shows a woken turn only as the watcher's fixed summary, so the UserPromptSubmit hook prints the
    analyst's words, each thread's question (named by its first question, never its fork's slug), and a line for each
    quiet event, without ids."""
    _subscribe(SID)
    session.attach(CORPUS, SID, _cwd(), None)
    events.post(CORPUS, "labeled", {"text": "links whose host is api-la", "name": "api-la", "ref": "concept:c0ffee12"})
    asked = events.post(CORPUS, "main", {"text": "Which kinds of link failed today?"})
    thread = agents.new_thread(CORPUS, None, None, "Days the page changed")
    posted = events.post(CORPUS, "thread", {"thread": thread["id"], "text": "On which days did it change?"})

    async def deliver() -> None:
        for _ in range(2):
            got = await events.pull_route(Req(), cwd=_cwd(), session=SID, wait=1)
            await events.ack_route(events.AckBody(cwd=_cwd(), session=SID, id=got["id"], terminal=True))

    asyncio.run(deliver())
    lines = asyncio.run(events.held_route(events.HeldBody(cwd=_cwd(), session=SID)))["terminal"].splitlines()
    assert len(lines) == 3 and "Which kinds of link failed today?" in lines[0] and "api-la" in lines[1]
    assert lines[2] == "› new thread: On which days did it change?" and "days-the-page-changed" not in lines[2]
    assert not any(x in "\n".join(lines) for x in (asked["id"], posted["id"], thread["id"], "c0ffee12"))
    assert not asyncio.run(events.held_route(events.HeldBody(cwd=_cwd(), session=SID)))["terminal"], "printed once"


def test_a_message_main_has_not_got_yet_shows_on_its_statusline_until_its_line_prints():
    """Claude Code gives main a browser message only at its turn's next tool call or once the turn ends, so main's
    statusline shows the analyst's words at once, after QUEUED, until the held hook prints the message's line; an event
    that carries no words of the analyst's shows nothing there, nor does another session's statusline."""
    from app import tray

    _subscribe(SID)
    session.attach(CORPUS, SID, _cwd(), None)
    first = events.post(CORPUS, "main", {"text": "Which kinds of link failed today?"})
    events.post(CORPUS, "checked", {"text": "the check ended"})
    thread = agents.new_thread(CORPUS, None, None, "Days the page changed")
    events.post(CORPUS, "thread", {"thread": thread["id"], "text": "On which days did it change?"})

    def line(sid: str = SID) -> str:
        return asyncio.run(tray.agents_route(tray.AgentsQuery(cwd=_cwd(), session=sid)))["line"]

    assert line() == f"thimble · {events.QUEUED}Which kinds of link failed today? (and 1 more)"
    assert line() == line() and first["id"] not in line(), "it shows until main gets it, without ids"
    assert line("0ther000-0000-4000-8000-000000000001") == ""

    async def deliver() -> None:
        for _ in range(3):
            got = await events.pull_route(Req(), cwd=_cwd(), session=SID, wait=1)
            await events.ack_route(events.AckBody(cwd=_cwd(), session=SID, id=got["id"], terminal=True))

    asyncio.run(deliver())
    said = asyncio.run(events.held_route(events.HeldBody(cwd=_cwd(), session=SID)))["terminal"]
    assert "Which kinds of link failed today?" in said and "On which days did it change?" in said
    assert line() == "", "main got both"


def test_a_queued_message_leaves_the_statusline_on_the_monitor_route_and_when_another_session_is_main():
    """No held hook prints a line on the Monitor route, so the watcher's ack ends the message's place on the
    statusline; a session that is no longer main shows none of the words queued for it, and they go once the new main
    gets a message."""
    from app import tray

    def line(sid: str = SID) -> str:
        return asyncio.run(tray.agents_route(tray.AgentsQuery(cwd=_cwd(), session=sid)))["line"]

    _subscribe(SID, cc_plugin.MONITOR)
    session.attach(CORPUS, SID, _cwd(), None)
    # queued while main's shim had not subscribed yet (events._awaits_shim), which noted it for the statusline
    posted = events.post(CORPUS, "main", {"text": "Which kinds of link failed today?"})
    events._notices[(CORPUS, SID)] = [(posted["id"], "Which kinds of link failed today?"), ("e0", "an older one")]
    assert line() == f"thimble · {events.QUEUED}Which kinds of link failed today? (and 1 more)"

    async def take() -> None:
        got = await events.pull_route(Req(), cwd=_cwd(), session=SID, wait=1)
        await events.ack_route(events.AckBody(cwd=_cwd(), session=SID, id=got["id"], terminal=False))

    asyncio.run(take())
    assert line() == f"thimble · {events.QUEUED}an older one", "the acknowledged one is gone"

    other = "0ther000-0000-4000-8000-000000000001"
    _subscribe(other)
    session.attach(CORPUS, other, _cwd(), None)
    assert line() == "", "SID is not main"
    events.post(CORPUS, "main", {"text": "And yesterday?"})
    assert line(other) == f"thimble · {events.QUEUED}And yesterday?"
    assert (CORPUS, SID) not in events._notices


def test_the_permission_hook_waits_on_main_s_meta_until_the_browser_answers(monkeypatch, tmp_path):
    monkeypatch.setenv("THIMBLE_HOME", str(tmp_path / "thome"))
    _record_token(tmp_path / "thome")
    client = TestClient(__import__("app.main", fromlist=["app"]).app, base_url="http://127.0.0.1")
    session.attach(CORPUS, SID, _cwd(), None)
    body = {"cwd": _cwd(), "session": SID, "tool_name": "Bash",
            "tool_input": {"command": "touch x", "description": "Create x"}}
    answers: list = []
    with client:
        t = threading.Thread(target=lambda: answers.append(client.post("/api/events/permission", json=body,
                                                                       headers=_signed()[0])))
        t.start()
        for _ in range(100):
            held = (agents.meta_or_none(CORPUS, agents.MAIN_ID) or {}).get("permissions") or []
            if held:
                break
            time.sleep(0.05)
        assert held and held[0]["tool"] == "Bash" and held[0]["what"] == "Create x" and '"touch x"' in held[0]["input"]
        # an answer is the analyst's browser's alone: without the cookie the page gets for the link's code it is refused,
        # the hook's proof notwithstanding
        r = client.post(f"/api/ws/{CORPUS}/permission", json={"id": held[0]["id"], "allow": True})
        assert r.status_code == 403
        t.join(0.2)
        assert t.is_alive(), "the hook still waits"
        claimed = client.post("/api/ui/key", json={"code": hook_auth.mint(CORPUS)})
        assert claimed.status_code == 200
        page = f"/b/{claimed.json()['key']}"  # the page asks under its key's path, where its cookie goes (hook_auth)
        r = client.post(f"{page}/api/ws/{CORPUS}/permission", json={"id": held[0]["id"], "allow": True})
        assert r.status_code == 200
        t.join(10)
        assert answers[0].status_code == 200 and answers[0].json() == {"id": held[0]["id"], "behavior": "allow"}
        assert not agents.meta_or_none(CORPUS, agents.MAIN_ID).get("permissions")
        # answered in the terminal: the session moved on, and the hook's wait ends with no decision
        t = threading.Thread(target=lambda: answers.append(client.post("/api/events/permission", json=body,
                                                                       headers=_signed()[0])))
        t.start()
        for _ in range(100):  # the server's loop registers the ask and then puts it on main's meta, apart from this thread
            if events._asks and (agents.meta_or_none(CORPUS, agents.MAIN_ID) or {}).get("permissions"):
                break
            time.sleep(0.05)
        events.clear_permissions(CORPUS)
        t.join(10)
        assert answers[1].json()["behavior"] is None and not agents.meta_or_none(CORPUS, agents.MAIN_ID).get("permissions")
        # each request and its answer are in the permission log a problem report carries
        log = [json.loads(ln) for ln in (config.workspace_dir(CORPUS) / agents.PERMISSIONS_LOG).read_text().splitlines()]
        assert [(r["event"], r.get("tool"), r.get("answer")) for r in log] == [
            ("asked", "Bash", None), ("answered", None, "allow"), ("asked", "Bash", None), ("answered", None, events.GONE_ANSWER)]
        assert log[0]["what"] == "Create x" and log[0]["chat"] == "main" and log[1]["id"] == log[0]["id"]
        assert client.post("/api/events/permission", json={**body, "session": "not-main"},
                           headers=_signed()[0]).status_code == 409


class _Stand:
    """The server's delivery routes as the watcher sees them: `pull` answers in order from `answers` (a (status, body)
    pair each; 204 once they run out; status 0 closes the connection without an answer, as a server that crashed while
    holding the poll), after calling `on_pull`, if given; `ack`, the permission hook, the held hook and the mode hook
    are recorded, the mode hook answered with `mode` and a request for a sign-in code (POST /api/ui/pair) with `pair`.
    Each answer proves `token` as thimble's server does (app/hook_auth.py), none with `token` None, as a process that
    took the port; `unproven` counts the requests that did not prove the token."""

    def __init__(self, answers: list[tuple[int, dict]], permission: tuple[int, dict] = (200, {"behavior": None}),
                 on_pull=None, held: tuple[int, dict] = (200, {"text": ""}), token: str | None = TOKEN,
                 agents: tuple[int, dict] = (200, {}), mode: tuple[int, dict] = (200, {}),
                 pair: tuple[int, dict] = (200, {"code": "c0de", "expires_s": 300})) -> None:
        self.answers = list(answers)
        self.permission = permission
        self.held = held
        self.agents = agents
        self.mode = mode
        self.pair = pair
        self.sent: list[str] = []  # every request's header values
        self.on_pull = on_pull
        self.token = token
        self.unproven = 0
        self.seen: list[tuple[str, str, dict]] = []
        outer = self

        class H(BaseHTTPRequestHandler):
            def _prove(self) -> None:
                outer.sent.extend(self.headers.values())
                nonce = self.headers.get(hook_auth.NONCE_HEADER) or ""
                want = hook_auth.request_proof(outer.token or "", self.server.server_port, nonce)
                if outer.token and self.headers.get(hook_auth.AUTH_HEADER) != want:
                    outer.unproven += 1
                if outer.token:
                    self.send_header(hook_auth.PROOF_HEADER, hook_auth.sign(outer.token, "server", nonce))

            def _reply(self, status: int, body: dict) -> None:
                data = json.dumps(body).encode()
                self.send_response(status)
                self._prove()
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self):  # noqa: N802
                u = urllib.parse.urlsplit(self.path)
                outer.seen.append(("GET", u.path, dict(urllib.parse.parse_qsl(u.query))))
                if u.path == "/api/health":
                    return self._reply(200, {"ok": True})
                if outer.on_pull is not None:
                    outer.on_pull()
                status, body = outer.answers.pop(0) if outer.answers else (204, {})
                if status == 0:
                    self.close_connection = True
                    return
                if status == 204:
                    time.sleep(0.05)
                    self.send_response(204)
                    self._prove()
                    self.end_headers()
                    return
                self._reply(status, body)

            def do_POST(self):  # noqa: N802
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
                path = urllib.parse.urlsplit(self.path).path
                outer.seen.append(("POST", path, body))
                if path == "/api/events/held":
                    return self._reply(*outer.held)
                if path == "/api/agents":
                    return self._reply(*outer.agents)
                if path == "/api/events/mode":
                    return self._reply(*outer.mode)
                if path == "/api/ui/pair":
                    return self._reply(*outer.pair)
                self._reply(*(outer.permission if path == "/api/events/permission" else (200, {})))

            def log_message(self, *a):
                pass

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.port = self.httpd.server_address[1]
        threading.Thread(target=self.httpd.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True).start()

    def close(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()


def _watch(tmp_path: Path, port: int | None, stdin: dict, *args: str, extra: dict | None = None,
           timeout: float = 30) -> subprocess.CompletedProcess:
    home = tmp_path / "thome"
    home.mkdir(exist_ok=True)
    if port:
        _record_token(home, api=f"http://127.0.0.1:{port}")
    # CLAUDE_PID too: a test run from a Claude Code session inherits that session's; a test names one when it wants it
    env = {k: v for k, v in os.environ.items() if k not in ("THIMBLE_SESSION", "CLAUDE_PROJECT_DIR", "CLAUDE_PID")}
    env.update({"THIMBLE_HOME": str(home), "THIMBLE_PORT": "1", **(extra or {})})
    return subprocess.run([str(WATCHER), *args], input=json.dumps(stdin), capture_output=True, text=True, env=env,
                          timeout=timeout)


EVENT_TEXT = '<thimble-event kind="main" event="e1">\nhello\n</thimble-event>'


def test_the_server_answers_a_hook_route_only_to_a_request_that_proves_the_token(monkeypatch, tmp_path):
    """Any process on the machine can reach the port: a hook route answers 401 unless the request proves it holds the
    token in server.json, and every answer to one proves the server holds it too. Other routes are untouched."""
    home = tmp_path / "thome"
    monkeypatch.setenv("THIMBLE_HOME", str(home))
    app = __import__("app.main", fromlist=["app"]).app
    body = {"cwd": _cwd(), "session": SID}
    with TestClient(app, base_url="http://127.0.0.1") as client:
        assert client.post("/api/events/held", json=body).status_code == 401, "no server.json: no token to prove"
        _record_token(home)
        assert client.post("/api/events/held", json=body).status_code == 401, "no proof"
        wrong, _ = _signed("another-token")
        for path in hook_auth.HOOK_PATHS:
            assert client.post(path, json=body, headers=wrong).status_code == 401, path
        good, proof = _signed()
        r = client.post("/api/events/held", json=body, headers=good)
        assert r.status_code == 200 and r.headers[hook_auth.PROOF_HEADER] == proof
        assert client.get("/api/health").status_code == 200, "no other route asks for it"
        # a session started before the update to 0.6.0 calls 0.5.0's routes, which answer as the new ones, proof and all
        assert client.post("/api/channel/held", json=body, headers=wrong).status_code == 401
        assert client.post("/api/channel/held", json=body, headers=good).status_code == 401, "a nonce is taken once"
        good, proof = _signed()
        r = client.post("/api/channel/held", json=body, headers=good)
        assert r.status_code == 200 and r.headers[hook_auth.PROOF_HEADER] == proof
        assert set(events.OLD_PATHS.values()) <= {*hook_auth.HOOK_PATHS, *hook_auth.SHIM_PATHS, "/api/events/main",
                                                  "/api/events/sessions"}
        relay = {"cwd": _cwd(), "request_id": "r1", "tool_name": "Bash"}
        assert client.post("/api/channel/permission", json=relay, headers=_signed()[0]).status_code == 404
        _record_token(home, token="rotated")  # a new start writes a new token, which the server reads at once
        assert client.post("/api/events/held", json=body, headers=_signed()[0]).status_code == 401
        assert client.post("/api/events/held", json=body, headers=_signed("rotated")[0]).status_code == 200


def test_main_s_stop_hook_shows_the_link_thimble_up_left_once_and_only_as_it_ends(tmp_path):
    """/thimble prints no link into the model's context (cli.LINK_LINE): main's Stop hook shows the link `server up` left,
    once, as a systemMessage, which Claude Code shows the analyst and not the model, with a sign-in code the server
    makes as the hook shows it (POST /api/ui/pair for the link's workspace), so the file never holds one."""
    link = "http://127.0.0.1:8300/?ws=mini"
    (tmp_path / "thome" / "links").mkdir(parents=True)
    (tmp_path / "thome" / "links" / SID).write_text(link)
    stop = {"session_id": SID, "cwd": "/data/mini", "hook_event_name": "Stop", "permission_mode": "default"}
    stand = _Stand([])
    try:
        assert _watch(tmp_path, stand.port, {**stop, "hook_event_name": "UserPromptSubmit"}, "--mode").stdout == ""
        assert not [x for x in stand.seen if x[1] == "/api/ui/pair"], "no code before the link is shown"
        assert json.loads(_watch(tmp_path, stand.port, stop, "--mode").stdout) == {
            "systemMessage": f"thimble: {link}#p=c0de"}
        assert ("POST", "/api/ui/pair", {"ws": "mini"}) in stand.seen
        assert _watch(tmp_path, stand.port, stop, "--mode").stdout == "", "once"
        (tmp_path / "thome" / "links" / SID).write_text(f"{link}\nthimble: WARNING - a note for the terminal")
        assert json.loads(_watch(tmp_path, stand.port, stop, "--mode").stdout) == {
            "systemMessage": f"thimble: {link}#p=c0de\nthimble: WARNING - a note for the terminal"}, "the notes under it"
        (tmp_path / "thome" / "links" / SID).write_text("http://127.0.0.1:8300/")
        assert json.loads(_watch(tmp_path, stand.port, stop, "--mode").stdout) == {
            "systemMessage": "thimble: http://127.0.0.1:8300/#p=c0de"}
        assert stand.seen[-2:][0] == ("POST", "/api/ui/pair", {"ws": ""}), "the start page's code"
    finally:
        stand.close()


def test_without_a_sign_in_code_the_stop_hook_shows_the_link_and_how_to_sign_in(tmp_path):
    """A server that gives no code, by an error or by an answer without the server's proof: the hook shows the plain
    link, which opens thimble read-only in a browser that is not signed in, and first under it the line that says how
    to sign one in, before the notes."""
    link = "http://127.0.0.1:8300/?ws=mini"
    links = tmp_path / "thome" / "links"
    links.mkdir(parents=True)
    stop = {"session_id": SID, "cwd": "/data/mini", "hook_event_name": "Stop"}
    watcher = _module()
    want = f"thimble: {link}\n{watcher.NO_CODE_LINE}\nthimble: a note"
    for stand in (_Stand([], pair=(500, {})), _Stand([], token=None)):
        try:
            (links / SID).write_text(f"{link}\nthimble: a note")
            out = _watch(tmp_path, stand.port, stop, "--mode").stdout
            assert json.loads(out) == {"systemMessage": want}, stand.pair
        finally:
            stand.close()


def test_notes_the_server_left_with_no_link_show_under_main_s_next_reply_and_mint_no_code(tmp_path):
    """The server leaves lines for main's terminal with no link (session.tell_terminal: an empty first line, such as a
    new browser's sign-in): the Stop hook shows them and asks for no code."""
    (tmp_path / "thome" / "links").mkdir(parents=True)
    (tmp_path / "thome" / "links" / SID).write_text("\nthimble: a browser signed in to thimble at 10:42.\nthimble: two")
    stop = {"session_id": SID, "cwd": "/data/mini", "hook_event_name": "Stop"}
    stand = _Stand([])
    try:
        assert json.loads(_watch(tmp_path, stand.port, stop, "--mode").stdout) == {
            "systemMessage": "thimble: a browser signed in to thimble at 10:42.\nthimble: two"}
        assert not [x for x in stand.seen if x[1] == "/api/ui/pair"]
        assert not (tmp_path / "thome" / "links" / SID).exists()
    finally:
        stand.close()


def test_the_server_s_terminal_notes_land_after_the_link_or_on_their_own(tmp_path, monkeypatch):
    """session.tell_terminal appends a line to the links file of the workspace's attached main, as a note after the link
    /thimble left, or after an empty first line in a file of its own, readable by its owner alone; with no main
    attached it writes nothing."""
    home = tmp_path / "thome"
    monkeypatch.setenv("THIMBLE_HOME", str(home))
    assert session.tell_terminal(CORPUS, "thimble: one") is False
    session.attach(CORPUS, SID, _cwd(), None)
    assert session.tell_terminal(CORPUS, "thimble: one") is True
    path = home / "links" / SID
    assert path.read_text() == "\nthimble: one" and path.stat().st_mode & 0o077 == 0
    assert session.tell_terminal(CORPUS, "thimble: two")
    assert path.read_text() == "\nthimble: one\nthimble: two"
    path.write_text("http://127.0.0.1:8300/?ws=mini")  # what /thimble leaves (cli.leave_link)
    assert session.tell_terminal(CORPUS, "thimble: three")
    assert path.read_text() == "http://127.0.0.1:8300/?ws=mini\nthimble: three"


def _module():
    """The watcher, loaded as a module (its shell line is a string to Python)."""
    import importlib.machinery
    import importlib.util

    loader = importlib.machinery.SourceFileLoader("thimble_watch_for_test", str(WATCHER))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod


def _gated(tmp_path: Path, args: tuple[str, ...] = (), **env: str) -> bool:
    """Whether a copy of the watcher, whose bin/thimble-python only records that it ran, starts Python for a hook run
    with `env` (and THIMBLE_HOME, the test's)."""
    bin_dir = tmp_path / "gate-bin"
    bin_dir.mkdir(exist_ok=True)
    ran = tmp_path / "python-ran"
    ran.unlink(missing_ok=True)
    (bin_dir / ".thimble-watch").write_text(WATCHER.read_text())
    (bin_dir / ".thimble-watch").chmod(0o755)
    (bin_dir / "thimble-python").write_text(f"#!/bin/sh\ntouch '{ran}'\n")
    (bin_dir / "thimble-python").chmod(0o755)
    base = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": str(tmp_path), "THIMBLE_HOME": str(tmp_path / "th")}
    subprocess.run([str(bin_dir / ".thimble-watch"), *args], input="{}", capture_output=True, text=True,
                   env={**base, **env}, timeout=10, check=False)
    return ran.exists()


def test_the_watcher_starts_python_only_in_a_folder_thimble_opened(tmp_path):
    """The plugin's hooks run in every Claude Code session: in a folder with no marker in <thimble home>/active (the
    path with each / made %, cli.mark_active) the watcher exits in its shell line, before Python starts. The marker lets
    it through, and so do terminal mode (THIMBLE_WS), a session that names no folder and a path over 200 characters,
    which gets no marker; --stream, --scratch and --work-budget are never gated. A session thimble starts itself
    exits there as before."""
    folder = "/data/some project/mini"
    assert not _gated(tmp_path, CLAUDE_PROJECT_DIR=folder)
    assert not _gated(tmp_path, ("--mode",), CLAUDE_PROJECT_DIR=folder)
    active = tmp_path / "th" / "active"
    active.mkdir(parents=True)
    (active / folder.replace("/", "%")).touch()
    assert _gated(tmp_path, CLAUDE_PROJECT_DIR=folder)
    assert _gated(tmp_path, ("--mode",), CLAUDE_PROJECT_DIR=folder)
    assert not _gated(tmp_path, CLAUDE_PROJECT_DIR=folder + "/sub"), "a marker is for its folder alone"
    assert _gated(tmp_path, CLAUDE_PROJECT_DIR="/elsewhere", THIMBLE_WS="/w")
    assert _gated(tmp_path)
    assert _gated(tmp_path, CLAUDE_PROJECT_DIR="/" + "x" * 200)
    for flag in ("--stream", "--scratch", "--work-budget"):
        assert _gated(tmp_path, (flag,), CLAUDE_PROJECT_DIR="/elsewhere"), flag
    assert not _gated(tmp_path, CLAUDE_PROJECT_DIR=folder, THIMBLE_SESSION="s", THIMBLE_SESSION_TOKEN="t")
    home_default = tmp_path / ".thimble" / "active"
    home_default.mkdir(parents=True)
    (home_default / "%other").touch()
    base = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": str(tmp_path)}
    bin_dir = tmp_path / "gate-bin"
    ran = tmp_path / "python-ran"
    ran.unlink(missing_ok=True)
    subprocess.run([str(bin_dir / ".thimble-watch")], input="{}", capture_output=True, text=True, timeout=10,
                   env={**base, "CLAUDE_PROJECT_DIR": "/other"}, check=False)
    assert ran.exists(), "without THIMBLE_HOME the marker is in ~/.thimble"


def test_the_watcher_reaches_the_local_server_past_a_shell_s_proxy(tmp_path):
    """A shell's HTTP_PROXY would send urllib's requests to 127.0.0.1 through the proxy: the watcher opens its requests
    without one (LOOPBACK), so the mode hook still reaches the server and the Stop hook gets its code."""
    link = "http://127.0.0.1:8300/?ws=mini"
    (tmp_path / "thome" / "links").mkdir(parents=True)
    (tmp_path / "thome" / "links" / SID).write_text(link)
    stop = {"session_id": SID, "cwd": "/data/mini", "hook_event_name": "Stop", "permission_mode": "default"}
    stand = _Stand([], mode=(200, {"terminal": "thimble: the line"}))
    proxy = {"HTTP_PROXY": "http://127.0.0.1:9", "http_proxy": "http://127.0.0.1:9", "NO_PROXY": "", "no_proxy": ""}
    try:
        out = _watch(tmp_path, stand.port, stop, "--mode", extra=proxy).stdout
        assert json.loads(out) == {"systemMessage": f"thimble: {link}#p=c0de\nthimble: the line"}
    finally:
        stand.close()


def test_the_mode_hook_shows_the_line_the_server_answers_after_the_link_in_one_system_message(tmp_path):
    """The server answers the mode hook with the line main's terminal shows once per session in Manual mode
    (events.mode_route `terminal`): the hook shows it as its systemMessage, on a turn's start and on its end, after the
    link on a Stop that has one, in the one systemMessage a hook gives; a subagent's report is never sent."""
    line = "thimble: Claude Code is in Manual mode."
    link = "http://127.0.0.1:8300/?ws=mini"
    turn = {"session_id": SID, "cwd": "/data/mini", "hook_event_name": "UserPromptSubmit", "permission_mode": "default"}
    stand = _Stand([], mode=(200, {"terminal": line}))
    try:
        assert json.loads(_watch(tmp_path, stand.port, turn, "--mode").stdout) == {"systemMessage": line}
        sent = {"cwd": "/data/mini", "session": SID, "permission_mode": "default"}
        assert ("POST", "/api/events/mode", sent) in stand.seen
        (tmp_path / "thome" / "links").mkdir(parents=True)
        (tmp_path / "thome" / "links" / SID).write_text(link)
        stop = {**turn, "hook_event_name": "Stop"}
        got = json.loads(_watch(tmp_path, stand.port, stop, "--mode").stdout)
        assert got == {"systemMessage": f"thimble: {link}#p=c0de\n{line}"}
        stand.mode = (200, {})
        assert _watch(tmp_path, stand.port, stop, "--mode").stdout == ""
        before = len(stand.seen)
        assert _watch(tmp_path, stand.port, {**turn, "agent_id": "a1"}, "--mode").stdout == ""
        assert len(stand.seen) == before, "a subagent's mode is not reported"
    finally:
        stand.close()


def test_the_hooks_do_nothing_without_server_json_or_with_a_server_that_cannot_prove_the_token(tmp_path):
    """The hooks run in every Claude Code session with the plugin: with no server.json, or one without a token, they
    reach no port at all (not THIMBLE_PORT, not 8300); a process that answers on the recorded port without the
    server's proof is not believed, so its allow is never printed."""
    inp = {"session_id": SID, "cwd": "/data/mini", "tool_name": "Bash", "tool_input": {"command": "rm -rf x"},
           "hook_event_name": "PermissionRequest"}
    rogue = _Stand([(200, {"id": "e1", "text": EVENT_TEXT})], permission=(200, {"id": "h1", "behavior": "allow"}),
                   held=(200, {"text": "injected"}), token=None)
    try:
        r = _watch(tmp_path, None, inp, "--permission", extra={"THIMBLE_PORT": str(rogue.port)})
        assert r.returncode == 0 and r.stdout == "" and rogue.seen == [], "no server.json: the port is not tried"
        _record_token(tmp_path / "thome", token="", api=f"http://127.0.0.1:{rogue.port}")
        assert _watch(tmp_path, None, inp, "--permission").stdout == "" and rogue.seen == [], "no token"
        for args in (("--permission",), ("--held",), ()):
            r = _watch(tmp_path, rogue.port, {**inp, "hook_event_name": "Stop"} if not args else inp, *args)
            assert r.returncode == 0 and r.stdout == "" and r.stderr == "", args
        assert [p for _, p, _ in rogue.seen] == ["/api/events/permission", "/api/events/held",
                                                 "/api/events/pull"], "each asked once and not believed"
        assert rogue.sent and not any(TOKEN in v for v in rogue.sent), "the token itself is never sent"
    finally:
        rogue.close()
    stand = _Stand([], permission=(200, {"id": "h1", "behavior": "allow"}))
    try:
        r = _watch(tmp_path, stand.port, inp, "--permission")
    finally:
        stand.close()
    assert json.loads(r.stdout)["hookSpecificOutput"]["decision"] == {"behavior": "allow"} and stand.unproven == 0


def test_the_permission_hook_sends_claude_code_s_suggestions_and_passes_on_what_always_allow_names(tmp_path):
    """The permission hook relays the request's permission_suggestions, and an answer from the card's "Always allow"
    names them as updatedPermissions, which the hook passes on in its decision, as Claude Code's own "Yes, and don't ask
    again" applies them; a plain allow and a deny carry none."""
    rules = [{"type": "addRules", "rules": [{"toolName": "mcp__plugin_thimble_thimble__add_card"}], "behavior": "allow",
              "destination": "localSettings"}]
    inp = {"session_id": SID, "cwd": "/data/mini", "tool_name": "mcp__plugin_thimble_thimble__add_card",
           "tool_input": {"question": "How many files?"}, "hook_event_name": "PermissionRequest",
           "permission_suggestions": rules}

    def decision() -> dict:
        return json.loads(_watch(tmp_path, stand.port, inp, "--permission").stdout)["hookSpecificOutput"]["decision"]

    stand = _Stand([], permission=(200, {"id": "h1", "behavior": "allow", "updatedPermissions": rules}))
    try:
        assert decision() == {"behavior": "allow", "updatedPermissions": rules}
        assert [b["suggestions"] for _, p, b in stand.seen if p == "/api/events/permission"] == [rules]
        stand.permission = (200, {"id": "h2", "behavior": "allow"})
        assert decision() == {"behavior": "allow"}
        stand.permission = (200, {"id": "h3", "behavior": "deny", "updatedPermissions": rules})
        assert "updatedPermissions" not in decision()
    finally:
        stand.close()


def test_the_held_hook_lets_each_hand_back_through_and_still_delivers_the_held_events(tmp_path):
    """Q2: the held hook never blocks a prompt. A subagent's hand-back in auto mode (the `isMeta` row with
    `origin.kind: "peer"`, a plugin-started agent's included) and a later run's `<task-notification>` in default mode reach
    main as Claude Code sends them, with the events held for main added as context, as for any prompt."""
    handbacks = [
        "[Subagent hand-back] The orientation (agent a1f0c2d3e4b5a6f7) handed back. The report follows:\n  Done: 14 cards.",
        "<task-notification>\n<task-id>a1f0c2d3e4b5a6f7</task-id>\n<status>completed</status>\n"
        "<summary>Agent \"orientation: the corpus\" completed</summary>\n<result>Revised the deck.</result>\n"
        "</task-notification>",
    ]
    stand = _Stand([], held=(200, {"text": "MEANWHILE\n[kind=\"report\"] the report was written", "terminal": ""}))
    try:
        for prompt in handbacks:
            inp = {"session_id": SID, "cwd": "/data/mini", "hook_event_name": "UserPromptSubmit", "prompt": prompt}
            r = _watch(tmp_path, stand.port, inp, "--held")
            out = json.loads(r.stdout)
            assert r.returncode == 0 and "decision" not in out and "continue" not in out, prompt
            assert out["hookSpecificOutput"]["additionalContext"].startswith("MEANWHILE"), "held events still delivered"
        sub = _watch(tmp_path, stand.port, {**inp, "agent_id": "a1f0c2d3e4b5a6f7"}, "--held")
        assert sub.returncode == 0 and sub.stdout == "", "a subagent's prompt gets nothing"
    finally:
        stand.close()
    assert [p for _, p, _ in stand.seen].count("/api/events/held") == 2
