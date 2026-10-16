"""Delivery through the plugin's hooks. The server side (events.py): an event for the session that is main is taken by
one watcher, in flight until acknowledged, a message main has not got yet shows on its statusline, and the
PermissionRequest hook's note is answered at once with no decision while its prompt shows on main's card, which the
browser cannot answer (0.9.0: Claude Code asks in the terminal). The server answers a hook route only to a request that
proves the token, and the hooks, run against a stand-in server, do nothing without server.json or with a server that
cannot prove the token, and never print a permission decision."""
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


def test_the_watcher_starts_python_only_in_a_session_thimble_is_on_in(tmp_path):
    """The plugin's hooks run in every Claude Code session: in a session with no marker in <thimble home>/up (the
    session id Claude Code gives a hook, CLAUDE_CODE_SESSION_ID; activation writes up/<sid>.active) the watcher exits in
    its shell line, before Python starts. Where Claude Code gives no session id, the folder's marker in <thimble
    home>/active decides (the path with each / made %, cli.mark_active), and a session that names no folder and a path
    over 200 characters pass; --rekey, whose new session has no marker yet, meets the folder's gate; --stream, --scratch
    and --work-budget are never gated. A session thimble starts itself exits there as before."""
    folder = "/data/some project/mini"
    sid = "5e55a000-0000-4000-8000-0000000000aa"
    assert not _gated(tmp_path, CLAUDE_CODE_SESSION_ID=sid, CLAUDE_PROJECT_DIR=folder)
    assert not _gated(tmp_path, ("--mode",), CLAUDE_CODE_SESSION_ID=sid)
    up = tmp_path / "th" / "up"
    up.mkdir(parents=True)
    (up / f"{sid}.active").write_text("{}")
    assert _gated(tmp_path, CLAUDE_CODE_SESSION_ID=sid, CLAUDE_PROJECT_DIR=folder)
    assert _gated(tmp_path, ("--mode",), CLAUDE_CODE_SESSION_ID=sid)
    assert not _gated(tmp_path, CLAUDE_CODE_SESSION_ID="5e55a000-0000-4000-8000-0000000000bb"), "a marker is its session's"
    # no session id: the folder's marker
    assert not _gated(tmp_path, CLAUDE_PROJECT_DIR=folder)
    active = tmp_path / "th" / "active"
    active.mkdir(parents=True)
    (active / folder.replace("/", "%")).touch()
    assert _gated(tmp_path, CLAUDE_PROJECT_DIR=folder)
    assert not _gated(tmp_path, CLAUDE_PROJECT_DIR=folder + "/sub"), "a marker is for its folder alone"
    assert _gated(tmp_path)
    assert _gated(tmp_path, CLAUDE_PROJECT_DIR="/" + "x" * 200)
    # a coding session's folder thimble opened once: its new sessions start no Python
    assert not _gated(tmp_path, CLAUDE_CODE_SESSION_ID="5e55a000-0000-4000-8000-0000000000cc", CLAUDE_PROJECT_DIR=folder)
    # --rekey: the folder's marker, whatever the new session's id
    assert _gated(tmp_path, ("--rekey",), CLAUDE_CODE_SESSION_ID="5e55a000-0000-4000-8000-0000000000dd",
                  CLAUDE_PROJECT_DIR=folder)
    assert not _gated(tmp_path, ("--rekey",), CLAUDE_CODE_SESSION_ID=sid, CLAUDE_PROJECT_DIR="/elsewhere")
    for flag in ("--stream", "--scratch", "--work-budget"):
        assert _gated(tmp_path, (flag,), CLAUDE_PROJECT_DIR="/elsewhere"), flag
    assert not _gated(tmp_path, CLAUDE_CODE_SESSION_ID=sid, THIMBLE_SESSION="s", THIMBLE_SESSION_TOKEN="t")
    home_default = tmp_path / ".thimble" / "up"
    home_default.mkdir(parents=True)
    (home_default / "other-sid.active").touch()
    base = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": str(tmp_path)}
    bin_dir = tmp_path / "gate-bin"
    ran = tmp_path / "python-ran"
    ran.unlink(missing_ok=True)
    subprocess.run([str(bin_dir / ".thimble-watch")], input="{}", capture_output=True, text=True, timeout=10,
                   env={**base, "CLAUDE_CODE_SESSION_ID": "other-sid"}, check=False)
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


def test_the_permission_hook_tells_the_server_and_decides_nothing(tmp_path):
    """D47: after a press the permission hook tells the server that a prompt waits (with no suggestions, which no card
    offers any more) and prints nothing, so Claude Code asks in its own dialog; it gives the server PERMISSION_WAIT_S
    and no more; on local transport it tells no one."""
    rules = [{"type": "addRules", "rules": [{"toolName": "mcp__plugin_thimble_thimble__add_card"}], "behavior": "allow",
              "destination": "localSettings"}]
    inp = {"session_id": SID, "cwd": "/data/mini", "tool_name": "mcp__plugin_thimble_thimble__add_card",
           "tool_input": {"question": "How many files?"}, "hook_event_name": "PermissionRequest",
           "permission_suggestions": rules}
    stand = _Stand([], permission=(200, {"id": "h1", "behavior": "allow", "updatedPermissions": rules}))
    try:
        r = _watch(tmp_path, stand.port, inp, "--permission")
        assert r.returncode == 0 and r.stdout == "" and r.stderr == ""
        [sent] = [b for _, p, b in stand.seen if p == "/api/events/permission"]
        assert sent["tool_name"] == inp["tool_name"] and "suggestions" not in sent
    finally:
        stand.close()
    watcher = _module()
    assert watcher.PERMISSION_WAIT_S <= 2.0 and not hasattr(watcher, "DENIED")
