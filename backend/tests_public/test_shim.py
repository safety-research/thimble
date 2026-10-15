"""plugin/bin/thimble-mcp: in the analyst's session in a workspace it subscribes to the server's `GET /api/events` with
its folder, its session id, its parent's pid and the route its session hears events by (`hook`, or `monitor` where
Claude Code's settings turn hooks off, app.cc_plugin.route), declares no experimental capability and writes nothing but
its answers. In a folder that is no workspace yet it lists no tools, sends no instructions and makes no request, until
/thimble registers the folder: then it lists the tools and says once that the list changed. It passes each tool call
on to the server with the id Claude Code gave it. Every request proves the token in server.json and the shim believes
only an answer that proves it too (app/hook_auth.py). The server here is a stand-in."""
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
from conftest import MINI, fake_claude_bin

SHIM = config.REPO_ROOT / "plugin" / "bin" / "thimble-mcp"
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


def _run(tmp_path: Path, port: int, wait_s: float, until: Any, send: list[dict] | None = None,
         parent: list[str] | None = None, extra: dict | None = None) -> list[dict]:
    """The shim's output until `until` (a method written, or a function that says when) or `wait_s`, after the MCP
    handshake and the messages in `send`; with `parent`, the shim runs as the child of a stand-in `claude` process whose
    command line carries those arguments; `extra` adds to its environment."""
    p = _start(tmp_path, port, parent=parent, extra=extra)
    _send(p, [INITIALIZE, INITIALIZED, *(send or [])])
    try:
        return _read(p, until, wait_s)
    finally:
        _stop(p)


def _start(tmp_path: Path, port: int | None, parent: list[str] | None = None,
           extra: dict | None = None) -> subprocess.Popen:
    """The shim as a child process (of a stand-in `claude` with `parent`), its server the stand-in on `port`, recorded
    in server.json with TOKEN; with `port` None there is no server.json."""
    home = tmp_path / "home"
    home.mkdir(exist_ok=True)
    if port is not None:
        (home / "server.json").write_text(json.dumps({"port": port, "api": f"http://127.0.0.1:{port}", "token": TOKEN}))
    claude = fake_claude_bin(home, {"loggedIn": True, "authMethod": "claude.ai"})
    (tmp_path / "cc").mkdir(exist_ok=True)
    env = {**os.environ, "THIMBLE_HOME": str(home), "THIMBLE_CWD": str(MINI), "CLAUDE_CONFIG_DIR": str(tmp_path / "cc"),
           "CLAUDE_CODE_SESSION_ID": "s-123", "THIMBLE_CLAUDE_BIN": str(claude)}
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


@pytest.mark.parametrize("hooks", [True, False])
def test_the_shim_subscribes_with_its_route_and_writes_only_its_answers(tmp_path, server, hooks):
    if not hooks:
        (tmp_path / "cc").mkdir(exist_ok=True)
        (tmp_path / "cc" / "settings.json").write_text(json.dumps({"disableAllHooks": True}))
    p = _start(tmp_path, server.port)
    out: list[dict] = []
    try:
        _send(p, [INITIALIZE, INITIALIZED])
        end = time.monotonic() + 30
        while time.monotonic() < end and not (server.queries and any(m.get("id") == 0 for m in out)):
            out += _read(p, lambda: False, 0.2)
        out += _read(p, lambda: False, 1.0)  # a second after both, for anything it would write of its own
    finally:
        _stop(p)
    init = next(m for m in out if m.get("id") == 0)
    assert not init["result"]["capabilities"].get("experimental")
    assert "/thimble" in init["result"]["instructions"] and len(init["result"]["instructions"].encode()) < 2048
    assert init["result"]["capabilities"]["tools"]["listChanged"] is True
    assert not [m for m in out if "method" in m], "no notification of its own"
    q = server.queries[0]
    assert q["cwd"] == str(MINI) and q["session"] == "s-123" and int(q["pid"]) == os.getpid()
    assert q["delivery"] == ("hook" if hooks else "monitor")


def test_a_tool_call_carries_the_id_claude_code_gave_it(tmp_path, server):
    """Claude Code sends each MCP tool call's id in the request's `_meta` as "claudecode/toolUseId"; the shim
    passes it on as `tool_use_id`, so a record the server writes into main while the call runs (the follow-up the call
    resumed) can name the call, and main's chat shows it after the call. The id is no argument of the tool."""
    call = {"jsonrpc": "2.0", "id": 1, "method": "tools/call",
            "params": {"name": "message_orientation", "arguments": {"message": "more"},
                       "_meta": {"claudecode/toolUseId": "toolu_01abc"}}}
    bare = {"jsonrpc": "2.0", "id": 2, "method": "tools/call",
            "params": {"name": "message_orientation", "arguments": {"message": "again"}}}
    _run(tmp_path, server.port, wait_s=15, send=[call, bare], until=lambda: len(server.calls) >= 2)
    got = {body["args"]["message"]: (name, body["tool_use_id"]) for name, body in server.calls}  # the two calls may land in either order
    assert got == {"more": ("message_orientation", "toolu_01abc"), "again": ("message_orientation", None)}


def test_a_proxy_in_the_environment_never_carries_the_shim_s_calls_to_the_local_server(tmp_path, server):
    """The shim talks only to thimble's server on 127.0.0.1, so a proxy the analyst's shell sets without NO_PROXY must
    not carry its subscription or its tool calls (httpx would send even 127.0.0.1 through it): here the proxy is a port
    nothing listens on, and both still reach the server."""
    with __import__("socket").socket() as s:
        s.bind(("127.0.0.1", 0))
        dead = f"http://127.0.0.1:{s.getsockname()[1]}"  # closed again before the shim runs
    proxies = {k: dead for k in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy")}
    call = {"jsonrpc": "2.0", "id": 1, "method": "tools/call",
            "params": {"name": "message_orientation", "arguments": {"message": "through"}}}
    saved = {k: os.environ.pop(k) for k in ("NO_PROXY", "no_proxy") if k in os.environ}
    try:
        _run(tmp_path, server.port, wait_s=20, send=[call], until=lambda: bool(server.calls and server.queries),
             extra=proxies)
    finally:
        os.environ.update(saved)
    assert server.queries and [body["args"]["message"] for _, body in server.calls] == ["through"]


def test_a_session_name_counts_only_with_its_token(tmp_path, server):
    """THIMBLE_SESSION without THIMBLE_SESSION_TOKEN is what Claude Code's background service can hand on from one of
    thimble's sessions to the user's own: the shim then calls as the analyst's session. With the token both go to the
    server, which checks it (app/hook_auth.py)."""
    from app import tools

    both = {t["name"] for t in tools.list(tools.ANALYST, session=None)} & \
        {t["name"] for t in tools.list(tools.ANALYST, session="orient")}
    name = sorted(both)[0]
    call = {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": name, "arguments": {}}}
    _run(tmp_path, server.port, wait_s=15, send=[call], until=lambda: bool(server.calls),
         extra={"THIMBLE_SESSION": "orient"})
    _run(tmp_path, server.port, wait_s=15, send=[call], until=lambda: len(server.calls) >= 2,
         extra={"THIMBLE_SESSION": "orient", "THIMBLE_SESSION_TOKEN": "n.m"})
    assert [(body["session"], body["session_token"]) for _, body in server.calls] == [(None, None), ("orient", "n.m")]


LIST = {"jsonrpc": "2.0", "id": 5, "method": "tools/list", "params": {}}


def test_outside_a_workspace_the_shim_lists_nothing_and_asks_nothing_until_the_folder_becomes_one(tmp_path, server):
    """A plain `claude` session in a folder thimble never opened: no tools, no instructions and no request to the
    server, so the session carries none of thimble's tools. Once /thimble registers the folder (here: it becomes a
    corpus folder), the shim says once that its tool list changed, lists the tools and subscribes."""
    data = tmp_path / "data"
    folder = data / "late"
    folder.mkdir(parents=True)
    p = _start(tmp_path, server.port, extra={"THIMBLE_DATA_DIR": str(data), "THIMBLE_CWD": str(folder)})
    try:
        _send(p, [INITIALIZE, INITIALIZED, LIST])
        out = _read(p, lambda: False, 3.0)  # more than one look (RETRY_S)
        init = next(m for m in out if m.get("id") == 0)
        assert "instructions" not in init["result"] or not init["result"]["instructions"]
        assert init["result"]["capabilities"]["tools"]["listChanged"] is True
        assert next(m for m in out if m.get("id") == 5)["result"]["tools"] == []
        assert not [m for m in out if "method" in m], "no list_changed while the folder is no workspace"
        assert not server.queries and not server.calls and not server.refused, "no request to the server"
        (folder / "manifest.json").write_text("{}")
        out = _read(p, "notifications/tools/list_changed", 15)
        assert [m["method"] for m in out if "method" in m] == ["notifications/tools/list_changed"]
        _send(p, [{**LIST, "id": 6}])
        out = _read(p, lambda: False, 1.0)
        assert next(m for m in out if m.get("id") == 6)["result"]["tools"], "the tools are listed now"
        assert not [m for m in out if "method" in m], "said once"
        end = time.monotonic() + 15
        while not server.queries and time.monotonic() < end:
            time.sleep(0.05)
        assert server.queries and server.queries[0]["cwd"] == str(folder)
    finally:
        _stop(p)


def test_a_folder_whose_last_launch_was_in_terminal_mode_is_in_browser_mode_without_thimble_mode(tmp_path, server):
    """The launcher sets THIMBLE_MODE for a session it starts in terminal mode. A plain `claude` session in a folder
    whose launch.json still says terminal mode is in browser mode (/thimble opens the folder so), so the shim
    subscribes to the server, which a terminal-mode shim never does."""
    ws = tmp_path / "ws"
    (ws / "mini" / "trusted").mkdir(parents=True)
    (ws / "mini" / "trusted" / "launch.json").write_text(json.dumps({"session": "s-123", "mode": "terminal"}))
    _run(tmp_path, server.port, wait_s=15, until=lambda: bool(server.queries),
         extra={"THIMBLE_WORKSPACES_DIR": str(ws)})
    assert server.queries and server.queries[0]["cwd"] == str(MINI)
