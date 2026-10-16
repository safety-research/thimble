"""The MCP shim's routes take the proof the plugin's hooks give (app/hook_auth.py): the server answers a tool call and
the event subscription only when the request proves the token in server.json, and proves it back; the shim
(plugin/bin/thimble-mcp) believes no answer without that proof."""
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


PARENT = "import subprocess, sys; sys.exit(subprocess.call([sys.argv[1]]))"  # a stand-in `claude`: the shim as its child


INITIALIZE = {"jsonrpc": "2.0", "id": 0, "method": "initialize",
              "params": {"protocolVersion": "2025-11-25", "capabilities": {}, "clientInfo": {"name": "t", "version": "1"}}}
INITIALIZED = {"jsonrpc": "2.0", "method": "notifications/initialized"}


SID = "s-123"  # the session the shims below serve (CLAUDE_CODE_SESSION_ID)


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


CORPUS = "mini"


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
