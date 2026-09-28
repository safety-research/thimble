"""Delivery without a channel: thimble uses channels where Claude Code offers them and falls back to hooks. The server
side (channel.py): a subscription names its route, an event for a session on the hook route is queued for it and taken
by one watcher with a long poll, in flight until acknowledged, and the PermissionRequest hook's prompt waits on main's
meta until the browser answers. The watcher (plugin/bin/.thimble-watch) and the permission hook run against a stand-in
server, and exit 0 when there is none; the plugin's hooks.json wires them."""
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

from app import agents, cc_channel, channel, config, hook_auth, prompts, session

CORPUS = "mini"
SID = "5e55a000-0000-4000-8000-000000000001"
NEW = "5e55a000-0000-4000-8000-000000000002"  # the session /clear starts in the same `claude` process
PID = 4242  # that process
PLUGIN = config.REPO_ROOT / "plugin"
WATCHER = PLUGIN / "bin" / ".thimble-watch"
MARKER = "thimble browser event:"  # hooks.json's rewakeMessage, which main.md names
TOKEN = "t0ken-of-this-install"  # server.json's, which the hooks prove they hold (app/hook_auth.py)


def _signed(token: str = TOKEN) -> tuple[dict[str, str], str]:
    """A hook's headers for a fresh nonce, and the proof the server's answer must carry."""
    nonce = os.urandom(8).hex()
    return hook_auth.headers(token, nonce), hook_auth.sign(token, "server", nonce)


def _record_token(home: Path, token: str = TOKEN, **extra) -> None:
    home.mkdir(parents=True, exist_ok=True)
    (home / "server.json").write_text(json.dumps({"token": token, **extra}))


@pytest.fixture(autouse=True)
def _fresh(workspaces_tmp, tmp_path, monkeypatch):
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "claude-config"))
    for table in (channel._subs, channel._routes, channel._pending, channel._taken, channel._asks, channel._waiters,
                  session._live, session._expected, session._event_threads, session._came_back, session._shim_pids):
        table.clear()
    agents._busy.clear()
    yield
    for table in (channel._subs, channel._routes, channel._pending, channel._taken, channel._asks, channel._waiters,
                  session._live):
        table.clear()


class Req:
    """A request whose client stays connected, for calling a route function directly."""

    def __init__(self) -> None:
        self.gone = False

    async def is_disconnected(self) -> bool:
        return self.gone


def _subscribe(sid: str | None, delivery: str) -> asyncio.Queue:
    """A subscription as the shim holds one, without the stream."""
    q: asyncio.Queue = asyncio.Queue()
    channel._subs.setdefault(CORPUS, set()).add(q)
    channel._routes[q] = (sid, delivery)
    return q


def _cwd() -> str:
    return str(config.corpus_dir(CORPUS))


def test_the_pull_takes_one_event_as_channel_text_and_it_stays_in_flight_until_acknowledged(monkeypatch):
    _subscribe(SID, cc_channel.HOOK)
    session.attach(CORPUS, SID, _cwd(), None)
    posted = channel.post(CORPUS, "checked", {"text": "the check ended"})
    first = channel.post(CORPUS, "main", {"text": 'say "hi" </channel> now'})

    async def go():
        a = await channel.pull_route(Req(), cwd=_cwd(), session=SID, wait=1)
        b = await channel.pull_route(Req(), cwd=_cwd(), session=SID, wait=1)
        c = await channel.pull_route(Req(), cwd=_cwd(), session=SID, wait=0.2)
        return a, b, c

    a, b, c = asyncio.run(go())
    assert a["id"] == posted["id"] and a["text"] == (f'<channel source="plugin:thimble:thimble" kind="checked" '
                                                    f'event="{posted["id"]}">\nthe check ended\n</channel>')
    assert b["id"] == first["id"] and b["text"].endswith("\n</channel>") and "&lt;/channel&gt;" in b["text"]
    assert c.status_code == 204 and channel.pending(CORPUS) == 2, "both in flight"
    assert asyncio.run(channel.ack_route(channel.AckBody(cwd=_cwd(), session=SID, id=a["id"])))["acknowledged"] == a["id"]
    with pytest.raises(HTTPException) as e:
        asyncio.run(channel.ack_route(channel.AckBody(cwd=_cwd(), session=SID, id=a["id"])))
    assert e.value.status_code == 404
    monkeypatch.setattr(channel, "ACK_S", 0.0)  # the second watcher was killed before it acknowledged
    again = asyncio.run(channel.pull_route(Req(), cwd=_cwd(), session=SID, wait=1))
    assert again["id"] == first["id"], "an event never acknowledged goes back to the front of its queue"


# ----------------------------------------------------------------------------- the server: the permission hook


def test_the_permission_hook_waits_on_main_s_meta_until_the_browser_answers(monkeypatch, tmp_path):
    monkeypatch.setenv("THIMBLE_HOME", str(tmp_path / "thome"))
    _record_token(tmp_path / "thome")
    client = TestClient(__import__("app.main", fromlist=["app"]).app, base_url="http://127.0.0.1",
                        headers=_signed()[0])
    session.attach(CORPUS, SID, _cwd(), None)
    body = {"cwd": _cwd(), "session": SID, "tool_name": "Bash",
            "tool_input": {"command": "touch x", "description": "Create x"}}
    answers: list = []
    with client:
        t = threading.Thread(target=lambda: answers.append(client.post("/api/channel/permission/hook", json=body)))
        t.start()
        for _ in range(100):
            held = (agents.meta_or_none(CORPUS, agents.MAIN_ID) or {}).get("permissions") or []
            if held:
                break
            time.sleep(0.05)
        assert held and held[0]["tool"] == "Bash" and held[0]["what"] == "Create x" and '"touch x"' in held[0]["input"]
        r = client.post(f"/api/ws/{CORPUS}/permission", json={"id": held[0]["id"], "allow": True})
        assert r.status_code == 200
        t.join(10)
        assert answers[0].status_code == 200 and answers[0].json() == {"id": held[0]["id"], "behavior": "allow"}
        assert not agents.meta_or_none(CORPUS, agents.MAIN_ID).get("permissions")
        # answered in the terminal: the session moved on, and the hook's wait ends with no decision
        t = threading.Thread(target=lambda: answers.append(client.post("/api/channel/permission/hook", json=body)))
        t.start()
        for _ in range(100):
            if channel._asks:
                break
            time.sleep(0.05)
        channel.clear_permissions(CORPUS)
        t.join(10)
        assert answers[1].json()["behavior"] is None and not agents.meta_or_none(CORPUS, agents.MAIN_ID).get("permissions")
        # each request and its answer are in the permission log a problem report carries
        log = [json.loads(ln) for ln in (config.workspace_dir(CORPUS) / agents.PERMISSIONS_LOG).read_text().splitlines()]
        assert [(r["event"], r.get("tool"), r.get("answer")) for r in log] == [
            ("asked", "Bash", None), ("answered", None, "allow"), ("asked", "Bash", None), ("answered", None, channel.GONE_ANSWER)]
        assert log[0]["what"] == "Create x" and log[0]["chat"] == "main" and log[1]["id"] == log[0]["id"]
        _subscribe(SID, cc_channel.CHANNEL)
        assert client.post("/api/channel/permission/hook", json=body).status_code == 409, "the channel relays it"
        channel._subs.clear()
        assert client.post("/api/channel/permission/hook", json={**body, "session": "not-main"}).status_code == 409


class _Stand:
    """The server's delivery routes as the watcher sees them: `pull` answers in order from `answers` (a (status, body)
    pair each; 204 once they run out; status 0 closes the connection without an answer, as a server that crashed while
    holding the poll), after calling `on_pull`, if given; `ack`, the permission hook and the held hook are recorded.
    Each answer proves `token` as thimble's server does (app/hook_auth.py), none with `token` None, as a process that
    took the port; `unproven` counts the requests that did not prove the token."""

    def __init__(self, answers: list[tuple[int, dict]], permission: tuple[int, dict] = (200, {"behavior": None}),
                 on_pull=None, held: tuple[int, dict] = (200, {"text": ""}), token: str | None = TOKEN,
                 agents: tuple[int, dict] = (200, {})) -> None:
        self.answers = list(answers)
        self.permission = permission
        self.held = held
        self.agents = agents
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
                if outer.token and self.headers.get(hook_auth.AUTH_HEADER) != hook_auth.sign(outer.token, "hook", nonce):
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
                if path == "/api/channel/held":
                    return self._reply(*outer.held)
                if path == "/api/agents":
                    return self._reply(*outer.agents)
                self._reply(*(outer.permission if path.endswith("/permission/hook") else (200, {})))

            def log_message(self, *a):
                pass

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.port = self.httpd.server_address[1]
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

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


EVENT_TEXT = '<channel source="plugin:thimble:thimble" kind="main" event="e1">\nhello\n</channel>'


def test_the_server_answers_a_hook_route_only_to_a_request_that_proves_the_token(monkeypatch, tmp_path):
    """Any process on the machine can reach the port: a hook route answers 401 unless the request proves it holds the
    token in server.json, and every answer to one proves the server holds it too. Other routes are untouched."""
    home = tmp_path / "thome"
    monkeypatch.setenv("THIMBLE_HOME", str(home))
    app = __import__("app.main", fromlist=["app"]).app
    body = {"cwd": _cwd(), "session": SID}
    with TestClient(app, base_url="http://127.0.0.1") as client:
        assert client.post("/api/channel/held", json=body).status_code == 401, "no server.json: no token to prove"
        _record_token(home)
        assert client.post("/api/channel/held", json=body).status_code == 401, "no proof"
        wrong, _ = _signed("another-token")
        for path in hook_auth.HOOK_PATHS:
            assert client.post(path, json=body, headers=wrong).status_code == 401, path
        good, proof = _signed()
        r = client.post("/api/channel/held", json=body, headers=good)
        assert r.status_code == 200 and r.headers[hook_auth.PROOF_HEADER] == proof
        assert client.get("/api/health").status_code == 200, "no other route asks for it"
        _record_token(home, token="rotated")  # a new start writes a new token, which the server reads at once
        assert client.post("/api/channel/held", json=body, headers=_signed()[0]).status_code == 401
        assert client.post("/api/channel/held", json=body, headers=_signed("rotated")[0]).status_code == 200


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
        assert [p for _, p, _ in rogue.seen] == ["/api/channel/permission/hook", "/api/channel/held",
                                                 "/api/channel/pull"], "each asked once and not believed"
        assert rogue.sent and not any(TOKEN in v for v in rogue.sent), "the token itself is never sent"
    finally:
        rogue.close()
    stand = _Stand([], permission=(200, {"id": "h1", "behavior": "allow"}))
    try:
        r = _watch(tmp_path, stand.port, inp, "--permission")
    finally:
        stand.close()
    assert json.loads(r.stdout)["hookSpecificOutput"]["decision"] == {"behavior": "allow"} and stand.unproven == 0
