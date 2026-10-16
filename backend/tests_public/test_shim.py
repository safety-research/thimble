"""plugin/bin/thimble-mcp: before thimble is on in a session it lists load_thimble alone, deferred, with its search
hint, gives no instructions in any session and makes no request; a call of load_thimble turns thimble on, lists main's
tools in its place with one list_changed, records the tools/list that follows (listed.json) and answers thimble's
guidance, marked sent only when no mod runs in the session. Once thimble is on, each call runs by the session's
transport, read per call: in the shim's own process before the press, posted to the server after it, where the shim
also subscribes to the server's `GET /api/events` with its folder, its session id, its parent's pid and the route its
session hears events by (`hook`, or `monitor` where Claude Code's settings turn hooks off, app.cc_plugin.route). It
passes each tool call on with the id Claude Code gave it. Every request proves the token in server.json and the shim
believes only an answer that proves it too (app/hook_auth.py). The server here is a stand-in."""
from __future__ import annotations

import json
import os
import re
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
    assert not init["result"].get("instructions"), "no instructions in any session"
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


def _shim_module():
    """plugin/bin/thimble-mcp loaded as a module, for its functions."""
    import importlib.machinery
    import importlib.util

    loader = importlib.machinery.SourceFileLoader("thimble_mcp_under_test", str(SHIM))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod


def test_the_placement_follows_the_server_s_always_load_in_mcp_json(tmp_path, monkeypatch):
    """plugin/.mcp.json sets no server alwaysLoad (live check LC12's main path), so load_thimble is deferred with its
    search hint and thimble's tools carry alwaysLoad true; with 0.8.0's `alwaysLoad: true` there, the fallback:
    load_thimble's alwaysLoad false and nothing on the others."""
    conf = json.loads((SHIM.parents[1] / ".mcp.json").read_text())
    assert "alwaysLoad" not in conf["mcpServers"]["thimble"]
    mod = _shim_module()
    hint = {"anthropic/searchHint": "card plan chart table label classify records thimble"}
    assert mod.placement() == "lc12"
    assert mod.tool_meta(True) == hint and mod.tool_meta(False) == {"anthropic/alwaysLoad": True}
    (tmp_path / "plugin" / "bin").mkdir(parents=True)
    (tmp_path / "plugin" / ".mcp.json").write_text(json.dumps(
        {"mcpServers": {"thimble": {**conf["mcpServers"]["thimble"], "alwaysLoad": True}}}))
    monkeypatch.setattr(mod, "HERE", tmp_path / "plugin" / "bin" / "thimble-mcp")
    assert mod.placement() == "fallback"
    assert mod.tool_meta(True) == {**hint, "anthropic/alwaysLoad": False} and mod.tool_meta(False) is None


def test_before_thimble_is_on_the_shim_lists_load_thimble_alone_and_asks_nothing(tmp_path, server):
    """A plain `claude` session, here in a registered workspace (MINI) whose session marker is not there: load_thimble
    alone, deferred, with its search hint (placement of live check LC12); no instructions, no notification and no
    request to the server."""
    p = _start(tmp_path, server.port, on=None)
    try:
        _send(p, [INITIALIZE, INITIALIZED, LIST])
        out = _read(p, lambda: False, 3.0)  # more than one look for the marker (RETRY_S)
    finally:
        _stop(p)
    init = next(m for m in out if m.get("id") == 0)
    assert not init["result"].get("instructions")
    assert init["result"]["capabilities"]["tools"]["listChanged"] is True
    [tool] = _listed(out, 5)
    assert tool["name"] == "load_thimble" and tool["inputSchema"] == {"type": "object", "properties": {}}
    assert tool["_meta"] == {"anthropic/searchHint": "card plan chart table label classify records thimble"}
    assert tool["description"].startswith("Turn on thimble in this session.")
    assert not [m for m in out if "method" in m], "no list_changed while thimble is off"
    assert not server.queries and not server.calls and not server.refused, "no request to the server"
    assert not (tmp_path / "home" / "up").exists(), "nothing written"


def test_the_shim_looks_for_the_marker_every_2_s_and_lists_the_tools_once_it_appears(tmp_path, server):
    """An activation made outside the shim (the /thimble skill, a shell): the shim sees the session marker at its next
    look, not sooner than RETRY_S (2 s) between looks, lists the tools with one list_changed and records the tools/list
    that follows in listed.json."""
    assert re.search(r"^RETRY_S = 2\.0\b", SHIM.read_text("utf-8"), re.M), "a look every 2 s, not faster"
    p = _start(tmp_path, server.port, on=None)
    try:
        _send(p, [INITIALIZE, INITIALIZED, LIST])
        out = _read_id(p, 5, 20)
        assert [t["name"] for t in _listed(out, 5)] == ["load_thimble"]
        _on(tmp_path, "local")
        seen = time.monotonic()
        out = _read(p, "notifications/tools/list_changed", 10)
        assert time.monotonic() - seen < 3.5 and [m["method"] for m in out if "method" in m] == [
            "notifications/tools/list_changed"]
        _send(p, [{**LIST, "id": 6}])
        out = _read(p, lambda: False, 1.5)
        names = [t["name"] for t in _listed(out, 6)]
        assert "load_thimble" not in names and "add_card" in names and len(names) == 36
        assert all(t["_meta"] == {"anthropic/alwaysLoad": True} for t in _listed(out, 6))
        rec = json.loads((tmp_path / "home" / "up" / SID / "listed.json").read_text())
        assert rec["names"] == sorted(names) and rec["count"] == 36 and rec["at"] > seen
    finally:
        _stop(p)
    assert not server.queries, "the local transport subscribes to nothing"


def _corpus(tmp_path: Path) -> Path:
    d = tmp_path / "corpus"
    d.mkdir()
    (d / "events.jsonl").write_text('{"a": 1}\n')
    return d


@pytest.mark.parametrize("mod", [False, True])
def test_load_thimble_turns_thimble_on_lists_the_tools_and_answers_the_guide(tmp_path, server, mod):
    """A call of load_thimble in a data folder thimble never opened: the session is activated (via `tool`), main's
    tools are listed in load_thimble's place with one list_changed, Claude Code's tools/list that follows is recorded
    (listed.json, with `at`), and the answer is thimble's guidance with the session's lead line. With no mod the shim
    marks the guide sent; where `thimble activate --mod` ran first, the mod marks it once the row is stored, so the
    guide stays owed here."""
    folder = _corpus(tmp_path)
    p = _start(tmp_path, server.port, on=None, extra={"THIMBLE_CWD": str(folder)})
    env_home = tmp_path / "home"
    try:
        _send(p, [INITIALIZE, INITIALIZED])
        _read(p, lambda: False, 0.5)
        if mod:
            subprocess.run([sys.executable, "-m", "app.activate", "activate", "--cwd", str(folder), "--session", SID,
                            "--via", "data", "--mod", "--json"], cwd=str(config.REPO_ROOT / "backend"), check=True,
                           env={**os.environ, "THIMBLE_HOME": str(env_home),
                                "THIMBLE_WORKSPACES_DIR": str(tmp_path / "ws")}, capture_output=True, timeout=60)
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
    assert "load_thimble" not in names and len(names) == 36
    answer = next(m for m in out if m.get("id") == 7)["result"]
    assert not answer["isError"], answer
    text = answer["content"][0]["text"]
    marker = (env_home / "up" / SID / "guide-marker").read_text().strip()
    assert text.startswith(f"thimble guidance {marker}: thimble is on in this folder.") and "# thimble" in text
    rec = json.loads((env_home / "up" / SID / "listed.json").read_text())
    assert rec["count"] == 36 and rec["at"] >= started
    marker_rec = json.loads((env_home / "up" / f"{SID}.active").read_text())
    assert marker_rec["mod"] is mod and marker_rec["via"] == ("data" if mod else "tool")
    sent = json.loads((env_home / "up" / SID / "guide.json").read_text()) if (env_home / "up" / SID / "guide.json").exists() else {}
    assert bool(sent.get("digest")) is (not mod)
    assert len([m for m in out if m.get("method") == "notifications/tools/list_changed"]) == 1, "one list_changed"


def test_load_thimble_in_a_refused_folder_answers_the_refusal(tmp_path, server):
    p = _start(tmp_path, server.port, on=None, extra={"THIMBLE_CWD": "/"})
    try:
        _send(p, [INITIALIZE, INITIALIZED, LOAD])
        out = _read(p, lambda: False, 5.0)
    finally:
        _stop(p)
    answer = next(m for m in out if m.get("id") == 7)["result"]
    assert answer["isError"] and "thimble does not open this folder" in answer["content"][0]["text"]
    assert not [m for m in out if "method" in m]


def test_listed_json_is_written_again_for_a_new_session_id(tmp_path, server):
    """/clear and /resume give the session a new id, which the shim reads from Claude Code's record of its parent:
    it keeps its tools listed and writes listed.json for the new id."""
    p = _start(tmp_path, server.port, parent=["--stand-in"], on="local")
    sessions = tmp_path / "cc" / "sessions"
    sessions.mkdir(parents=True, exist_ok=True)
    try:
        _send(p, [INITIALIZE, INITIALIZED, LIST])
        out = _read_id(p, 5, 20)
        assert len(_listed(out, 5)) == 36, "thimble is on in the session"
        (sessions / f"{p.pid}.json").write_text(json.dumps({"sessionId": "s-new"}))
        path = tmp_path / "home" / "up" / "s-new" / "listed.json"
        end = time.monotonic() + 10
        while not path.exists() and time.monotonic() < end:
            time.sleep(0.1)
        assert path.exists() and json.loads(path.read_text())["count"] == 36
    finally:
        _stop(p)


def test_the_transport_is_read_per_call(tmp_path, server):
    """A session on the server's transport posts its calls to the server; once launch.json names the local transport
    a call runs in the shim's process and reaches no server, with no restart of the shim."""
    call = {"jsonrpc": "2.0", "id": 1, "method": "tools/call",
            "params": {"name": "message_orientation", "arguments": {"message": "first"}}}
    p = _start(tmp_path, server.port, on="server")
    try:
        _send(p, [INITIALIZE, INITIALIZED, call])
        _read(p, lambda: bool(server.calls), 15)
        assert [body["args"]["message"] for _, body in server.calls] == ["first"]
        _on(tmp_path, "local")
        _send(p, [{**call, "id": 2, "params": {**call["params"], "arguments": {"message": "second"}}}])
        out = _read(p, lambda: False, 0.1)
        end = time.monotonic() + 60
        while not any(m.get("id") == 2 for m in out) and time.monotonic() < end:
            out += _read(p, lambda: False, 0.5)
        assert any(m.get("id") == 2 for m in out), "the local call answered"
    finally:
        _stop(p)
    assert [body["args"]["message"] for _, body in server.calls] == ["first"], "the second never reached the server"
