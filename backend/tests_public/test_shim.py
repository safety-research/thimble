"""plugin/bin/thimble-mcp: before thimble is on in a session it lists load_thimble alone, deferred, with its search
hint, gives no instructions in any session and makes no request; a call of load_thimble turns thimble on, lists main's
tools in its place with one list_changed, records the tools/list that follows (listed.json) and answers thimble's
guidance, marked sent only when no mod runs in the session. Once thimble is on, each call runs by the session's
transport, read per call: in the shim's own process before the press, posted to the server after it, where the shim
also subscribes to the server's `GET /api/events` with its folder, its session id, its parent's pid and the route its
session hears events by (`hook`, or `monitor` where Claude Code's settings turn hooks off, app.cc_plugin.route). It
passes each tool call on with the id Claude Code gave it. Every request proves the token in server.json and the shim
believes only an answer that proves it too (app/hook_auth.py). The server here is a stand-in, but for the tests of
the server's own routes, which answer the shim only when the request proves the token, and of the analyst's cookie."""
from __future__ import annotations

import json
import os
import select
import signal
import subprocess
import sys
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app import config, hook_auth
from app.main import create_app
from conftest import MINI, fake_claude_bin

SHIM = config.REPO_ROOT / "plugin" / "bin" / "thimble-mcp"
TOKEN = "t0ken-of-this-install"  # the one _start records in server.json


def proof(handler: BaseHTTPRequestHandler, token: str | None = TOKEN) -> str | None:
    """The proof header a server holding `token` puts on its answer to the request `handler` reads, as
    app/hook_auth.py does; None when the request does not prove `token` (thimble's server would answer 401), or with
    `token` None (a process that is not thimble's)."""
    nonce = handler.headers.get(hook_auth.NONCE_HEADER) or ""
    want = hook_auth.request_proof(token or "", handler.server.server_port, nonce)
    if not token or not nonce or handler.headers.get(hook_auth.AUTH_HEADER) != want:
        return None
    return hook_auth.sign(token, "server", nonce)


class _Server:
    """GET /api/events: a `ready` event and a keep-alive, then held open; every query string is kept. Each answer proves
    `token` (none with None); a request that does not prove it is kept in `refused` and answered 401."""

    def __init__(self, token: str | None = TOKEN) -> None:
        self.token = token
        self.refused: list[str] = []
        self.queries: list[dict] = []
        self.calls: list[tuple[str, dict]] = []  # (tool, body) of each POST /api/tools/<tool>
        outer = self

        class H(BaseHTTPRequestHandler):
            def do_POST(self):  # noqa: N802
                body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
                path = urllib.parse.urlsplit(self.path).path
                if self._refused():
                    return
                answer = b"{}"
                if path.startswith("/api/tools/"):
                    outer.calls.append((path.rsplit("/", 1)[-1], json.loads(body)))
                    answer = json.dumps({"content": [{"type": "text", "text": "ok"}], "is_error": False}).encode()
                self.send_response(200)
                self._proof()
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(answer)

            def do_GET(self):  # noqa: N802
                u = urllib.parse.urlsplit(self.path)
                if u.path != "/api/events":
                    self.send_response(404)
                    self.end_headers()
                    return
                if self._refused():
                    return
                outer.queries.append(dict(urllib.parse.parse_qsl(u.query)))
                self.send_response(200)
                self._proof()
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()
                self.wfile.write(b'event: ready\ndata: {"workspace": "mini"}\n\n')
                self.wfile.write(b": ping\n\n")
                self.wfile.flush()
                time.sleep(3)

            def _refused(self) -> bool:
                if outer.token and proof(self, outer.token) is None:
                    outer.refused.append(self.path)
                    self.send_response(401)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return True
                return False

            def _proof(self) -> None:
                if outer.token:
                    self.send_header(hook_auth.PROOF_HEADER, proof(self, outer.token) or "")

            def log_message(self, *a):
                pass

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.port = self.httpd.server_address[1]
        threading.Thread(target=self.httpd.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True).start()

    def close(self) -> None:
        self.httpd.shutdown()


@pytest.fixture()
def server():
    s = _Server()
    yield s
    s.close()


PARENT = "import subprocess, sys; sys.exit(subprocess.call([sys.argv[1]]))"  # a stand-in `claude`: the shim as its child


INITIALIZE = {"jsonrpc": "2.0", "id": 0, "method": "initialize",
              "params": {"protocolVersion": "2025-11-25", "capabilities": {}, "clientInfo": {"name": "t", "version": "1"}}}
INITIALIZED = {"jsonrpc": "2.0", "method": "notifications/initialized"}


SID = "s-123"  # the session the shims below serve (CLAUDE_CODE_SESSION_ID)
CORPUS = "mini"


def _on(tmp_path: Path, transport: str | None, sid: str = SID, mod: bool = False) -> Path:
    """Thimble on for session `sid` in the workspace of MINI, as activate.activate leaves it: the session marker in the
    test's home and launch.json naming the session main on `transport` (local or server); with None, thimble is off.
    The workspaces folder, which the shim's environment names (THIMBLE_WORKSPACES_DIR)."""
    ws = tmp_path / "ws"
    (ws / "mini" / "trusted").mkdir(parents=True, exist_ok=True)
    if transport is None:
        return ws
    up = tmp_path / "home" / "up"
    up.mkdir(parents=True, exist_ok=True)
    (up / f"{sid}.active").write_text(json.dumps({"cwd": str(MINI), "ws": "mini", "path": str(ws / "mini"),
                                                   "via": "command", "role": "main", "mod": mod, "at": time.time()}))
    (ws / "mini" / "trusted" / "launch.json").write_text(json.dumps(
        {"session": sid, "transport": transport, "mode": "terminal" if transport == "local" else "browser"}))
    return ws


def _start(tmp_path: Path, port: int | None, parent: list[str] | None = None,
           extra: dict | None = None, on: str | None = "server") -> subprocess.Popen:
    """The shim as a child process (of a stand-in `claude` with `parent`), its server the stand-in on `port`, recorded
    in server.json with TOKEN; with `port` None there is no server.json. `on` is the transport of the session thimble is
    on in (_on): the server's by default, as after a press; None for a session thimble is off in."""
    home = tmp_path / "home"
    home.mkdir(exist_ok=True)
    ws = _on(tmp_path, on)
    if port is not None:
        (home / "server.json").write_text(json.dumps({"port": port, "api": f"http://127.0.0.1:{port}", "token": TOKEN}))
    claude = fake_claude_bin(home, {"loggedIn": True, "authMethod": "claude.ai"})
    (tmp_path / "cc").mkdir(exist_ok=True)
    env = {**os.environ, "THIMBLE_HOME": str(home), "THIMBLE_CWD": str(MINI), "CLAUDE_CONFIG_DIR": str(tmp_path / "cc"),
           "CLAUDE_CODE_SESSION_ID": SID, "THIMBLE_CLAUDE_BIN": str(claude), "THIMBLE_WORKSPACES_DIR": str(ws)}
    env.pop("THIMBLE_SKIP_KEY", None)
    env.pop("THIMBLE_MODE", None)
    for k in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_PROFILE"):
        env.pop(k, None)
    env.pop("THIMBLE_SESSION", None)
    env.update(extra or {})
    cmd = [str(SHIM)] if parent is None else [sys.executable, "-c", PARENT, str(SHIM), *parent]
    p = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=env,
                         start_new_session=True)
    p.pending = b""  # type: ignore[attr-defined]  # a line of its stdout not yet whole
    return p


def _send(p: subprocess.Popen, messages: list[dict]) -> None:
    p.stdin.write("".join(json.dumps(m) + "\n" for m in messages).encode())
    p.stdin.flush()


def _read(p: subprocess.Popen, until: Any, wait_s: float) -> list[dict]:
    """The messages the shim writes until `until` (a method written, or a function that says when) or `wait_s`."""
    out: list[dict] = []
    end = time.monotonic() + wait_s
    while time.monotonic() < end:
        if callable(until) and until():
            break
        r, _, _ = select.select([p.stdout], [], [], 0.2)
        if not r:
            continue
        chunk = os.read(p.stdout.fileno(), 65536)
        if not chunk:
            break
        p.pending += chunk
        while b"\n" in p.pending:
            line, p.pending = p.pending.split(b"\n", 1)
            if line.strip():
                out.append(json.loads(line))
        if any(m.get("method") == until for m in out):
            break
    return out


def _stop(p: subprocess.Popen) -> None:
    os.killpg(p.pid, signal.SIGKILL)  # the stand-in parent and the shim with it
    p.wait()


LIST = {"jsonrpc": "2.0", "id": 5, "method": "tools/list", "params": {}}
LOAD = {"jsonrpc": "2.0", "id": 7, "method": "tools/call", "params": {"name": "load_thimble", "arguments": {}}}


def _read_id(p: subprocess.Popen, rid: int, wait_s: float) -> list[dict]:
    """The messages the shim writes until its answer to the request `rid`, or `wait_s`."""
    out: list[dict] = []
    end = time.monotonic() + wait_s
    while time.monotonic() < end and not any(m.get("id") == rid for m in out):
        out += _read(p, lambda: False, 0.3)
    return out


def _listed(out: list[dict], rid: int) -> list[dict]:
    return next(m for m in out if m.get("id") == rid)["result"]["tools"]


def _corpus(tmp_path: Path) -> Path:
    d = tmp_path / "corpus"
    d.mkdir()
    (d / "events.jsonl").write_text('{"a": 1}\n')
    return d


def test_load_thimble_turns_thimble_on_in_a_session_it_was_off_in(tmp_path, server):
    """A plain `claude` session in a data folder thimble never opened: until load_thimble is called the shim lists it
    alone, deferred, with its search hint (placement of live check LC12), and gives no instructions, no notification
    and no request to the server, over more than one look for the session marker. A call of load_thimble activates the
    session (via `tool`), lists main's tools in its place with one list_changed, records Claude Code's tools/list that
    follows (listed.json, with `at`) and answers thimble's guidance with the session's lead line, marked sent."""
    folder = _corpus(tmp_path)
    p = _start(tmp_path, server.port, on=None, extra={"THIMBLE_CWD": str(folder)})
    env_home = tmp_path / "home"
    try:
        _send(p, [INITIALIZE, INITIALIZED, LIST])
        out = _read_id(p, 5, 30)
        out += _read(p, lambda: False, 2.5)  # more than one look for the marker (RETRY_S)
        init = next(m for m in out if m.get("id") == 0)
        assert not init["result"].get("instructions")
        assert init["result"]["capabilities"]["tools"]["listChanged"] is True
        [tool] = _listed(out, 5)
        assert tool["name"] == "load_thimble" and tool["inputSchema"] == {"type": "object", "properties": {}}
        assert tool["_meta"] == {"anthropic/searchHint": "card plan chart table label classify records thimble"}
        assert tool["description"].startswith("Turn on thimble in this session.")
        assert not [m for m in out if "method" in m], "no list_changed while thimble is off"
        assert not server.queries and not server.calls and not server.refused, "no request to the server"
        assert not (env_home / "up").exists(), "nothing written"
        started = time.time()
        _send(p, [LOAD])
        out = _read(p, "notifications/tools/list_changed", 60)
        assert [m["method"] for m in out if "method" in m] == ["notifications/tools/list_changed"]
        _send(p, [{**LIST, "id": 8}])
        out += _read_id(p, 7, 30)
        out += _read(p, lambda: False, 0.5)
    finally:
        _stop(p)
    names = [t["name"] for t in _listed(out, 8)]
    assert "load_thimble" not in names and len(names) == 29  # 0.8.0's 36 less the 7 only thimble's agents call
    answer = next(m for m in out if m.get("id") == 7)["result"]
    assert not answer["isError"], answer
    text = answer["content"][0]["text"]
    marker = (env_home / "up" / SID / "guide-marker").read_text().strip()
    assert text.startswith(f"thimble guidance {marker}: thimble is on in this folder.") and "# thimble" in text
    rec = json.loads((env_home / "up" / SID / "listed.json").read_text())
    assert rec["count"] == 29 and rec["at"] >= started
    marker_rec = json.loads((env_home / "up" / f"{SID}.active").read_text())
    assert marker_rec["mod"] is False and marker_rec["via"] == "tool"
    assert json.loads((env_home / "up" / SID / "guide.json").read_text())["digest"]
    assert len([m for m in out if m.get("method") == "notifications/tools/list_changed"]) == 1, "one list_changed"


# --------------------------------------------------------------------------- the token and the cookie


def test_the_server_answers_the_shim_s_routes_only_to_a_request_that_proves_the_token(plugin_headers):
    cwd = str(config.corpus_dir(CORPUS))
    tool = {"args": {"ref": "events.jsonl#L1"}, "actor": "analyst", "cwd": cwd}
    asks = [("POST", "/api/tools/read_ref", {"json": tool}), ("GET", "/api/events", {"params": {"cwd": "/nowhere"}}),
            ("POST", f"/api/ws/{CORPUS}/sessions/permission", {"json": {"session": "orient", "tool_name": "Bash"}})]
    with TestClient(create_app(), base_url="http://127.0.0.1") as client:
        wrong = hook_auth.headers("another-token", 80)
        for method, path, kw in asks:
            assert client.request(method, path, **kw).status_code == 401, path
            assert client.request(method, path, headers=wrong, **kw).status_code == 401, path
        for method, path, kw in asks:
            h = plugin_headers()
            r = client.request(method, path, headers=h, **kw)
            assert r.status_code != 401, path
            assert r.headers[hook_auth.PROOF_HEADER] == hook_auth.sign(hook_auth.token(), "server", h[hook_auth.NONCE_HEADER])
        assert not client.post("/api/tools/read_ref", json=tool, headers=plugin_headers()).json()["is_error"]
        assert client.get("/api/tools/holdings", params={"workspace": CORPUS}).status_code == 200, "the CLI's, open"


def test_the_shim_believes_no_answer_without_the_server_s_proof(tmp_path):
    """A process on the recorded port that cannot prove the token gets the shim's requests, but its tool answer is never
    shown."""
    call = {"jsonrpc": "2.0", "id": 1, "method": "tools/call",
            "params": {"name": "message_orientation", "arguments": {"message": "more"}}}
    rogue = _Server(token=None)
    try:
        p = _start(tmp_path, rogue.port)
        try:
            _send(p, [INITIALIZE, INITIALIZED, call])
            out: list[dict] = []
            subscribed, end = None, time.monotonic() + 20
            while time.monotonic() < end:
                out += _read(p, lambda: False, 0.2)
                subscribed = subscribed or (time.monotonic() if rogue.queries else None)
                if subscribed and time.monotonic() - subscribed > 1 and any(m.get("id") == 1 for m in out):
                    break
        finally:
            _stop(p)
    finally:
        rogue.close()
    assert rogue.queries and rogue.calls, "it was asked"
    answer = next(m for m in out if m.get("id") == 1)["result"]
    assert answer["isError"] and "ok" not in [c.get("text") for c in answer["content"]]


def test_the_analyst_s_cookie_goes_only_to_thimble_s_api_routes_under_the_browser_s_own_path():
    """The link's code is traded for a cookie scoped to the browser's own path, /b/<key>/api/, whose key the answer
    gives that page alone, HttpOnly and SameSite=Strict: a browser sends a cookie to every port of its host, so a cookie
    scoped to /api/ would reach another server's page that asks for its own /api/ paths. The answer also deletes a
    cookie an earlier build scoped to /api/, and sets no other; a code that is not alive gets none."""
    import json

    from starlette.requests import Request

    fresh = Request({"type": "http", "headers": []})
    r, browser = hook_auth.claim({"code": hook_auth.mint()}, fresh)
    key = json.loads(r.body)["key"]
    cookies = [v.decode() for k, v in r.raw_headers if k == b"set-cookie"]
    assert r.status_code == 200 and len(cookies) == 2 and browser, cookies
    [mine] = [c for c in cookies if "Max-Age=0" not in c]
    [old] = [c for c in cookies if "Max-Age=0" in c]
    assert mine.startswith(f"{hook_auth.ui_cookie()}=") and f"Path=/b/{key}/api/;" in mine, mine
    assert "HttpOnly" in mine and "SameSite=strict" in mine, mine
    assert old.startswith(f'{hook_auth.ui_cookie()}=""') and "Path=/api/;" in old, old
    gone, none = hook_auth.claim({"code": "another-code"}, fresh)
    assert gone.status_code == 410 and none == "" and not [k for k, _ in gone.raw_headers if k == b"set-cookie"]
