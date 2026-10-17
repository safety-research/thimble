"""Delivery through the plugin's hooks. The server side (events.py): an event for the session that is main is taken by
one watcher, in flight until acknowledged, a message main has not got yet shows on its statusline, and the
PermissionRequest hook's note is answered at once with no decision while its prompt shows on main's card, which the
browser cannot answer (0.9.0: Claude Code asks in the terminal). The server answers a hook route only to a request that
proves the token, and the hooks, run against a stand-in server, do nothing without server.json or with a server that
cannot prove the token, never print a permission decision, and reach the local server past a shell's proxy."""
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


def test_the_permission_hook_s_note_is_answered_at_once_and_the_browser_cannot_answer_the_prompt(monkeypatch, tmp_path):
    """D47: the hook only tells the server a prompt waits; the answer is `behavior: null` at once, the prompt shows on
    main's card without buttons, and the browser's answer is refused, with the cookie or without it. Answered in the
    terminal, the card goes; each request is in the permission log a problem report carries."""
    monkeypatch.setenv("THIMBLE_HOME", str(tmp_path / "thome"))
    _record_token(tmp_path / "thome")
    client = TestClient(__import__("app.main", fromlist=["app"]).app, base_url="http://127.0.0.1")
    session.attach(CORPUS, SID, _cwd(), None)
    body = {"cwd": _cwd(), "session": SID, "tool_name": "Bash",
            "tool_input": {"command": "touch x", "description": "Create x"}}
    with client:
        answer = client.post("/api/events/permission", json=body, headers=_signed()[0])
        assert answer.status_code == 200 and answer.json()["behavior"] is None
        held = (agents.meta_or_none(CORPUS, agents.MAIN_ID) or {}).get("permissions") or []
        assert held and held[0]["tool"] == "Bash" and held[0]["what"] == "Create x" and '"touch x"' in held[0]["input"]
        assert held[0]["terminal"] is True and "always" not in held[0]
        r = client.post(f"/api/ws/{CORPUS}/permission", json={"id": held[0]["id"], "allow": True})
        assert r.status_code == 403
        claimed = client.post("/api/ui/key", json={"code": hook_auth.mint(CORPUS)})
        assert claimed.status_code == 200
        page = f"/b/{claimed.json()['key']}"  # the page asks under its key's path, where its cookie goes (hook_auth)
        r = client.post(f"{page}/api/ws/{CORPUS}/permission", json={"id": held[0]["id"], "allow": True})
        assert r.status_code == 409 and r.json()["detail"] == events.ANSWER_IN_TERMINAL
        assert (agents.meta_or_none(CORPUS, agents.MAIN_ID) or {}).get("permissions") == held, "the card stays"
        # answered in the terminal: the session moved on, and the card goes
        events.clear_permissions(CORPUS)
        assert not agents.meta_or_none(CORPUS, agents.MAIN_ID).get("permissions")
        log = [json.loads(ln) for ln in (config.workspace_dir(CORPUS) / agents.PERMISSIONS_LOG).read_text().splitlines()]
        assert [(r["event"], r.get("tool"), r.get("answer")) for r in log] == [
            ("asked", "Bash", None), ("answered", None, events.GONE_ANSWER)]
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
    env = {k: v for k, v in os.environ.items() if k not in ("THIMBLE_SESSION", "CLAUDE_PROJECT_DIR", "CLAUDE_PID",
                                                            "CLAUDE_CODE_SESSION_ID")}
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


def test_main_s_stop_hook_shows_the_notes_left_for_the_terminal_once_and_never_a_link(tmp_path):
    """Main's Stop hook shows the notes left for the session's terminal (cli.leave_notes, session.tell_terminal) once,
    as a systemMessage, which Claude Code shows the analyst and keeps in the transcript: never a link, and it asks the
    server for no sign-in code (bug hunt 7, H9). A link an older build left on the first line is not shown."""
    links = tmp_path / "thome" / "links"
    links.mkdir(parents=True)
    note = "thimble: WARNING - a note for the terminal"
    (links / SID).write_text(f"\n{note}")
    stop = {"session_id": SID, "cwd": "/data/mini", "hook_event_name": "Stop", "permission_mode": "default"}
    stand = _Stand([])
    try:
        assert _watch(tmp_path, stand.port, {**stop, "hook_event_name": "UserPromptSubmit"}, "--mode").stdout == ""
        assert json.loads(_watch(tmp_path, stand.port, stop, "--mode").stdout) == {"systemMessage": note}
        assert _watch(tmp_path, stand.port, stop, "--mode").stdout == "", "once"
        (links / SID).write_text(f"http://127.0.0.1:8300/?ws=mini\n{note}")
        assert json.loads(_watch(tmp_path, stand.port, stop, "--mode").stdout) == {"systemMessage": note}
        (links / SID).write_text("http://127.0.0.1:8300/")
        assert _watch(tmp_path, stand.port, stop, "--mode").stdout == ""
        assert not [x for x in stand.seen if x[1] == "/api/ui/pair"], "no sign-in code is asked for"
    finally:
        stand.close()


def test_the_watcher_reaches_the_local_server_past_a_shell_s_proxy(tmp_path):
    """A shell's HTTP_PROXY would send urllib's requests to 127.0.0.1 through the proxy: the watcher opens its requests
    without one (LOOPBACK), so the mode hook still reaches the server, and the Stop hook shows its line under the
    notes."""
    (tmp_path / "thome" / "links").mkdir(parents=True)
    (tmp_path / "thome" / "links" / SID).write_text("\nthimble: a note")
    stop = {"session_id": SID, "cwd": "/data/mini", "hook_event_name": "Stop", "permission_mode": "default"}
    stand = _Stand([], mode=(200, {"terminal": "thimble: the line"}))
    proxy = {"HTTP_PROXY": "http://127.0.0.1:9", "http_proxy": "http://127.0.0.1:9", "NO_PROXY": "", "no_proxy": ""}
    try:
        out = _watch(tmp_path, stand.port, stop, "--mode", extra=proxy).stdout
        assert json.loads(out) == {"systemMessage": "thimble: a note\nthimble: the line"}
    finally:
        stand.close()


CODE = "s1gn-1n-c0de-of-the-stand"  # what the stand-in server's sign-in route gives at every ask


def test_no_thimble_command_shows_a_sign_in_code_where_a_model_can_read_it(home, data, monkeypatch, capsys, tmp_path):
    """Bug hunt 7, H9: /thimble fresh and restore showed a working sign-in link under main's reply, which Claude Code
    keeps in the transcript, where a model reads it. For each action of the /thimble skill, neither what its `up` prints
    (the skill's text, which the model reads) nor what main's Stop hook shows after the reply (a systemMessage, which
    the transcript keeps) holds a sign-in code, though the server gives one at every ask. A press that writes a one-time
    link for the clipboard (`copy link`) says only where it is. What the session's environment lacks still reaches the
    terminal."""
    from app import cli

    monkeypatch.setenv("THIMBLE_HOME", str(tmp_path / "thome"))  # the watcher's (_watch)
    monkeypatch.delenv("CLAUDE_CODE_SESSION_ID", raising=False)
    monkeypatch.setattr(cli, "ensure_running", lambda wait: True)
    monkeypatch.setattr(cli, "healthy", lambda url=None, timeout=1.0: True)
    monkeypatch.setattr(cli, "listening", lambda p: False)
    monkeypatch.setattr(cli, "made_main", lambda *a, **kw: None)
    monkeypatch.setattr(cli, "name_session", lambda *a, **kw: None)
    note = "thimble: WARNING - a note for the terminal"
    monkeypatch.setattr(cli, "setup_lines", lambda cwd: [note])
    archive = "mini-2026-10-17-170404"
    archived = str(tmp_path / "ws" / ".archive" / archive)

    def request(method, url, body=None, timeout=5.0, **kw):
        path = urllib.parse.urlsplit(url).path
        if path == "/api/ui/pair":
            return 200, {"code": CODE, "expires_s": 300}
        if path == "/api/corpora/register":
            return 201, {"name": CORPUS}
        if path.endswith("/archive"):
            return 200, {"archived": archived}
        if path.endswith("/restore"):
            return 200, {"restored": archived, "archived": f"{archived}-2"}
        if path.endswith("/archives"):
            return 200, {"archives": [archive]}
        if path.endswith("/precached/context"):
            return 200, {"text": ""}
        return 404, {"detail": "Not Found"}

    monkeypatch.setattr(cli, "_request", request)
    # a press where no browser opens: the one-time link, with its code, in a file only the analyst's account reads
    link_file = tmp_path / "thome" / "links" / f"{SID}.json"

    def press(session, cwd, hook=False):
        link_file.parent.mkdir(parents=True, exist_ok=True)
        link_file.write_text(json.dumps({"url": f"http://127.0.0.1:8300/?ws={CORPUS}#p={CODE}"}))
        return {"ok": True, "port": 8300, "url": f"http://127.0.0.1:8300/?ws={CORPUS}", "opened": False,
                "remote": True, "tunnel": "ssh -N -L 8300:127.0.0.1:8300 <your ssh host>", "et": None,
                "link_file": str(link_file), "claim_file": str(tmp_path / "claimed"), "proxy": False}

    monkeypatch.setattr(cli, "run_open", press)
    stop = {"session_id": SID, "cwd": "/data/mini", "hook_event_name": "Stop", "permission_mode": "default"}
    stand = _Stand([], pair=(200, {"code": CODE, "expires_s": 300}))
    shown: dict[str, str] = {}
    try:
        for words in ([], ["fresh"], ["restore"], ["restore", archive], ["resume", archive], ["status"], ["browser"]):
            cli.write_state({"port": 8300, "url": "http://127.0.0.1:8300", "env": {}})
            action, name = (words + ["", ""])[:2]
            assert cli.main(["up", "--cwd", str(data / "mini"), "--session", SID, "--action", action,
                             "--archive", name]) == 0
            said = capsys.readouterr().out
            hook = _watch(tmp_path, stand.port, stop, "--mode").stdout
            for text in (said, hook):
                assert CODE not in text and "#p=" not in text, (words, text)
            shown[" ".join(words)] = hook
    finally:
        stand.close()
    assert not [x for x in stand.seen if x[1] == "/api/ui/pair"], "no hook asks for a sign-in code"
    assert note in shown["fresh"] and note in shown[f"restore {archive}"], "the notes still reach the terminal"


def test_the_hooks_do_nothing_without_server_json_or_with_a_server_that_cannot_prove_the_token(tmp_path):
    """The hooks run in every Claude Code session with the plugin: with no server.json, or one without a token, they
    reach no port at all (not THIMBLE_PORT, not 8300); a process that answers on the recorded port without the
    server's proof is not believed. The permission hook prints no decision even from thimble's own server."""
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
    assert r.returncode == 0 and r.stdout == "" and stand.unproven == 0, "no decision, whatever the server says"
