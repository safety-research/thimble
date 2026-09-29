"""plugin/bin/thimble-mcp as a channel: it declares Claude Code's `claude/channel` capability, and in a session with the
channel (THIMBLE_CHANNEL in its environment, which the launcher exports, or the channel flag naming this plugin copy on
its parent's command line, app.cc_channel) it subscribes to the server's `GET /api/channel` with its folder,
its session id and its parent's pid, and writes each `channel` event as a `notifications/claude/channel` on stdout, none
before the MCP handshake is done. That session also relays its permission prompts: it declares
`claude/channel/permission`, posts each `notifications/claude/channel/permission_request` to
`POST /api/channel/permission`, and writes each `permission` event of the stream as
`notifications/claude/channel/permission`. Every request proves the token in server.json and the shim believes only an
answer that proves it too (app/hook_auth.py). The server here is a stand-in that serves one event of each kind."""
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

from app import config, hook_auth
from conftest import fake_claude_bin

SHIM = config.REPO_ROOT / "plugin" / "bin" / "thimble-mcp"
NOTE = {"content": "question: why?", "meta": {"kind": "thread", "event": "e1", "thread": "t1"}}
VERDICT = {"request_id": "swagd", "behavior": "allow"}
REQUEST = {"request_id": "abcde", "tool_name": "Bash", "description": "Create x", "input_preview": '{"command": "touch x"}'}
TOKEN = "t0ken-of-this-install"  # the one _start records in server.json


def proof(handler: BaseHTTPRequestHandler, token: str | None = TOKEN) -> str | None:
    """The proof header a server holding `token` puts on its answer to the request `handler` reads, as
    app/hook_auth.py does; None when the request does not prove `token` (thimble's server would answer 401), or with
    `token` None (a process that is not thimble's)."""
    nonce = handler.headers.get(hook_auth.NONCE_HEADER) or ""
    if not token or not nonce or handler.headers.get(hook_auth.AUTH_HEADER) != hook_auth.sign(token, "hook", nonce):
        return None
    return hook_auth.sign(token, "server", nonce)


class _Server:
    """GET /api/channel: a `ready` event, one `channel` event, then held open; every query string is kept. Each answer
    proves `token` (none with None); a request that does not prove it is kept in `refused` and answered 401."""

    def __init__(self, token: str | None = TOKEN) -> None:
        self.token = token
        self.refused: list[str] = []
        self.queries: list[dict] = []
        self.posts: list[dict] = []
        self.calls: list[tuple[str, dict]] = []  # (tool, body) of each POST /api/tools/<tool>
        outer = self

        class H(BaseHTTPRequestHandler):
            def do_POST(self):  # noqa: N802
                body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
                path = urllib.parse.urlsplit(self.path).path
                if self._refused():
                    return
                if path == "/api/channel/permission":
                    outer.posts.append(json.loads(body))
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
                if u.path != "/api/channel":
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
                self.wfile.write(b"event: channel\ndata: " + json.dumps(NOTE).encode() + b"\n\n")
                self.wfile.write(b"event: permission\ndata: " + json.dumps(VERDICT).encode() + b"\n\n")
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


def _run(tmp_path: Path, port: int, channel: bool, wait_s: float, until: Any = "notifications/claude/channel",
         send: list[dict] | None = None, parent: list[str] | None = None, extra: dict | None = None) -> list[dict]:
    """The shim's output until `until` (a method written, or a function that says when) or `wait_s`, after the MCP
    handshake and the messages in `send`; with `parent`, the shim runs as the child of a stand-in `claude` process whose
    command line carries those arguments; `extra` adds to its environment."""
    p = _start(tmp_path, port, channel, parent=parent, extra=extra)
    _send(p, [INITIALIZE, INITIALIZED, *(send or [])])
    try:
        return _read(p, until, wait_s)
    finally:
        _stop(p)


def _start(tmp_path: Path, port: int | None, channel: bool, parent: list[str] | None = None,
           extra: dict | None = None) -> subprocess.Popen:
    """The shim as a child process (of a stand-in `claude` with `parent`), its server the stand-in on `port`, recorded
    in server.json with TOKEN; with `port` None there is no server.json."""
    home = tmp_path / "home"
    home.mkdir(exist_ok=True)
    if port is not None:
        (home / "server.json").write_text(json.dumps({"port": port, "api": f"http://127.0.0.1:{port}", "token": TOKEN}))
    # a claude.ai login, which channels need (cc_channel.channels_blocked)
    claude = fake_claude_bin(home, {"loggedIn": True, "authMethod": "claude.ai"})
    (tmp_path / "cc").mkdir(exist_ok=True)
    env = {**os.environ, "THIMBLE_HOME": str(home), "THIMBLE_CWD": "/data/mini", "CLAUDE_CONFIG_DIR": str(tmp_path / "cc"),
           "CLAUDE_CODE_SESSION_ID": "s-123", "THIMBLE_CLAUDE_BIN": str(claude)}
    env.pop("THIMBLE_SKIP_KEY", None)
    for k in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_PROFILE", "CLAUDE_CODE_USE_BEDROCK",
              "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"):
        env.pop(k, None)  # the runner's own login must not decide the route the test asserts
    env.pop("THIMBLE_CHANNEL", None)
    env.pop("THIMBLE_SESSION", None)
    if channel:
        env["THIMBLE_CHANNEL"] = "plugin:thimble@inline"
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


def test_the_shim_declares_the_channel_and_forwards_an_event(tmp_path, server):
    out = _run(tmp_path, server.port, channel=True, wait_s=30)
    init = next(m for m in out if m.get("id") == 0)
    assert init["result"]["capabilities"]["experimental"] == {"claude/channel": {}, "claude/channel/permission": {}}
    assert "`thimble`" in init["result"]["instructions"] and len(init["result"]["instructions"].encode()) < 2048
    notes = [m for m in out if m.get("method") == "notifications/claude/channel"]
    assert notes and notes[0]["params"] == NOTE
    q = server.queries[0]
    assert q["cwd"] == "/data/mini" and q["session"] == "s-123" and int(q["pid"]) == os.getpid()


def test_the_launcher_s_session_relays_its_permission_prompts_both_ways(tmp_path, server):
    """Claude Code's request reaches the server with the folder and the session; the browser's answer on the stream
    reaches Claude Code as the verdict notification. The stand-in sends its verdict the moment the shim subscribes,
    which can be before the shim has posted the request, so the shim runs until the post arrives."""
    note = {"jsonrpc": "2.0", "method": "notifications/claude/channel/permission_request", "params": REQUEST}
    p = _start(tmp_path, server.port, channel=True)
    try:
        _send(p, [INITIALIZE, INITIALIZED, note])
        out = _read(p, "notifications/claude/channel/permission", 30)
        _read(p, lambda: bool(server.posts), 30)
    finally:
        _stop(p)
    verdicts = [m for m in out if m.get("method") == "notifications/claude/channel/permission"]
    assert verdicts and verdicts[0]["params"] == VERDICT
    assert server.posts == [{**REQUEST, "cwd": "/data/mini", "session": "s-123"}]


def test_a_tool_call_carries_the_id_claude_code_gave_it(tmp_path, server):
    """Claude Code sends each MCP tool call's id in the request's `_meta` as "claudecode/toolUseId"; the shim
    passes it on as `tool_use_id`, so a record the server writes into main while the call runs (the follow-up the call
    resumed) can name the call, and main's chat shows it after the call. The id is no argument of the tool."""
    call = {"jsonrpc": "2.0", "id": 1, "method": "tools/call",
            "params": {"name": "message_orientation", "arguments": {"message": "more"},
                       "_meta": {"claudecode/toolUseId": "toolu_01abc"}}}
    bare = {"jsonrpc": "2.0", "id": 2, "method": "tools/call",
            "params": {"name": "message_orientation", "arguments": {"message": "again"}}}
    _run(tmp_path, server.port, channel=False, wait_s=15, send=[call, bare],
           until=lambda: len(server.calls) >= 2)
    got = {body["args"]["message"]: (name, body["tool_use_id"]) for name, body in server.calls}  # the two calls may land in either order
    assert got == {"more": ("message_orientation", "toolu_01abc"), "again": ("message_orientation", None)}
