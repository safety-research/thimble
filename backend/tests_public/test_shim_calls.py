"""plugin/bin/thimble-mcp's tool calls (call_server, with_progress): calls from one session run concurrently and leave
the channel free, each reports MCP progress while it runs when Claude Code asked for it, a refused connection is tried
again while a restart brings the server back, and a call whose connection drops after it was sent is not sent again.
The server here is a stand-in whose tool calls take as long as a test says."""
from __future__ import annotations

import json
import socket
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from test_shim_channel import INITIALIZE, INITIALIZED, _read, _send, _start, _stop

NOTE = {"content": "question: why?", "meta": {"kind": "thread", "event": "e1", "thread": "t1"}}


class _Slow:
    """POST /api/tools/<tool> answers after `delay` seconds (`drop`: closes the connection instead, once); GET
    /api/channel sends one `channel` event once a call is under way; GET /api/health answers ok."""

    def __init__(self, delay: float, port: int = 0, drop: bool = False, fail: bool = False) -> None:
        self.delay, self.drop, self.fail = delay, drop, fail
        self.boot = "b1"  # /api/health's token; a test changes it to stand for a restart
        self.calls: list[tuple[str, float]] = []  # (tool, the time its request arrived)
        self.started = threading.Event()
        outer = self

        class H(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def do_POST(self):  # noqa: N802
                self.rfile.read(int(self.headers.get("Content-Length") or 0))
                tool = urllib.parse.urlsplit(self.path).path.rsplit("/", 1)[-1]
                outer.calls.append((tool, time.monotonic()))
                outer.started.set()
                if outer.drop:  # a server stopped mid-call; the one answering afterwards is a new start
                    outer.drop = False
                    outer.boot = "b2"
                    self.close_connection = True
                    self.connection.shutdown(socket.SHUT_RDWR)
                    return
                time.sleep(outer.delay)
                if outer.fail:  # what uvicorn answers when a stop cancels the request
                    self._json({"detail": "Internal Server Error"}, 500)
                    return
                self._json({"content": [{"type": "text", "text": f"{tool} done"}], "is_error": False})

            def do_GET(self):  # noqa: N802
                path = urllib.parse.urlsplit(self.path).path
                if path == "/api/health":
                    self._json({"ok": True, "boot": outer.boot})
                    return
                if path != "/api/channel":
                    self.send_response(404)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()
                outer.started.wait(30)
                self.wfile.write(b"event: channel\ndata: " + json.dumps(NOTE).encode() + b"\n\n")
                self.wfile.flush()
                time.sleep(10)

            def _json(self, data: dict, code: int = 200) -> None:
                body = json.dumps(data).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *a):
                pass

        self.httpd = ThreadingHTTPServer(("127.0.0.1", port), H)
        self.httpd.daemon_threads = True
        self.port = self.httpd.server_address[1]
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def close(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()


def _call(i: int, tool: str = "message_orientation", token: str | None = None) -> dict:
    params: dict = {"name": tool, "arguments": {"message": f"m{i}"}}
    if token:
        params["_meta"] = {"progressToken": token}
    return {"jsonrpc": "2.0", "id": i, "method": "tools/call", "params": params}


def _results(out: list[dict], ids: set[int]) -> dict[int, dict]:
    return {m["id"]: m for m in out if m.get("id") in ids and "result" in m}


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture()
def slow():
    s = _Slow(delay=3.0)
    yield s
    s.close()


def test_two_calls_run_at_once_and_the_channel_is_not_held_up(tmp_path, slow):
    """Two 3 s calls sent together both answer in about 3 s, not 6, and the channel event the server sends while they
    run reaches Claude Code before either answers."""
    p = _start(tmp_path, slow.port, channel=True)
    try:
        _send(p, [INITIALIZE, INITIALIZED])
        _read(p, lambda: False, 1.0)  # the handshake's answer
        t0 = time.monotonic()
        _send(p, [_call(1), _call(2)])
        out: list[dict] = []
        while time.monotonic() - t0 < 20 and len(_results(out, {1, 2})) < 2:
            out += _read(p, "", 0.3)
        elapsed = time.monotonic() - t0
    finally:
        _stop(p)
    done = _results(out, {1, 2})
    assert len(done) == 2, out
    assert elapsed < 5.0, f"the calls took {elapsed:.1f} s, so they ran one after the other"
    arrived = [t for _, t in slow.calls]
    assert len(arrived) == 2 and abs(arrived[0] - arrived[1]) < 1.0
    order = [m.get("method") or m.get("id") for m in out]
    assert "notifications/claude/channel" in order
    assert order.index("notifications/claude/channel") < min(order.index(1), order.index(2))


def test_a_long_call_reports_progress_when_claude_code_asks_for_it(tmp_path, slow):
    """With a progress token on the request, the shim sends `notifications/progress` for it while the call runs (every
    THIMBLE_MCP_PROGRESS_S; 60 s by default), which keeps Claude Code's idle timeout from aborting a long call. A call
    without a token gets none."""
    p = _start(tmp_path, slow.port, channel=False, extra={"THIMBLE_MCP_PROGRESS_S": "0.5"})
    try:
        _send(p, [INITIALIZE, INITIALIZED, _call(1, token="tok-1"), _call(2)])
        out: list[dict] = []
        end = time.monotonic() + 20
        while time.monotonic() < end and len(_results(out, {1, 2})) < 2:
            out += _read(p, "", 0.3)
    finally:
        _stop(p)
    assert len(_results(out, {1, 2})) == 2, out
    progress = [m["params"] for m in out if m.get("method") == "notifications/progress"]
    assert len(progress) >= 3, out
    assert {q["progressToken"] for q in progress} == {"tok-1"}
    assert [q["progress"] for q in progress] == sorted(q["progress"] for q in progress)
    assert "still running" in progress[0]["message"]


def test_a_call_made_while_the_server_restarts_waits_for_it(tmp_path):
    """The port is closed when the call is made and a server opens it 1.5 s later: the call reaches that server and
    answers, rather than telling the model the server is down."""
    port = _free_port()
    later: list[_Slow] = []
    timer = threading.Timer(1.5, lambda: later.append(_Slow(delay=0.1, port=port)))
    p = _start(tmp_path, port, channel=False, extra={"THIMBLE_MCP_RETRY_S": "10"})
    try:
        _send(p, [INITIALIZE, INITIALIZED])
        _read(p, lambda: False, 1.0)
        timer.start()
        _send(p, [_call(1)])
        out: list[dict] = []
        end = time.monotonic() + 20
        while time.monotonic() < end and not _results(out, {1}):
            out += _read(p, "", 0.3)
    finally:
        timer.cancel()
        _stop(p)
        for s in later:
            s.close()
    result = _results(out, {1})[1]["result"]
    assert result["isError"] is False and result["content"][0]["text"] == "message_orientation done"


def test_a_call_whose_connection_drops_is_not_sent_again(tmp_path):
    """The server closes the connection after the request arrived, as a server stopped mid-call does, and answers again
    at once: the call is not sent a second time (it may have taken effect), and the model is told the server restarted
    during it."""
    s = _Slow(delay=0.1, drop=True)
    p = _start(tmp_path, s.port, channel=False, extra={"THIMBLE_MCP_RETRY_S": "5"})
    try:
        _send(p, [INITIALIZE, INITIALIZED, _call(1, tool="add_card")])
        out: list[dict] = []
        end = time.monotonic() + 20
        while time.monotonic() < end and not _results(out, {1}):
            out += _read(p, "", 0.3)
    finally:
        _stop(p)
        s.close()
    result = _results(out, {1})[1]["result"]
    assert result["isError"] is True
    assert "restarted while `add_card` ran" in result["content"][0]["text"]
    assert [t for t, _ in s.calls] == ["add_card"]


def test_a_session_thimble_starts_allows_a_long_silent_call():
    """A background session's Claude Code gets a 4 h idle limit on MCP calls in place of the 30 min default, in case it
    ignores the shim's progress; the launcher exports the same value for main (plugin/bin/thimble)."""
    from app import agent_session

    assert agent_session.environ("orient")["CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT"] == "14400000"


def test_a_server_error_from_a_restart_is_told_apart_from_one_of_the_same_server(tmp_path):
    """uvicorn answers 500 to a request its stop cancels. When the server that answers afterwards has another boot
    token, the call was cut off by a restart and the model is told so; a 500 from the server that runs on is its own
    error, passed on as it is."""
    s = _Slow(delay=0.5, fail=True)
    timer = threading.Timer(0.3, lambda: setattr(s, "boot", "b2"))  # the restart, while the call runs
    p = _start(tmp_path, s.port, channel=False, extra={"THIMBLE_MCP_RETRY_S": "5"})
    try:
        _send(p, [INITIALIZE, INITIALIZED])
        _read(p, lambda: False, 1.0)
        timer.start()
        _send(p, [_call(1, tool="add_card")])
        out = _read(p, lambda: False, 0)
        end = time.monotonic() + 20
        while time.monotonic() < end and not _results(out, {1}):
            out += _read(p, "", 0.3)
        timer.join()
        _send(p, [_call(2, tool="add_card")])  # the same server, boot b2 before and after
        while time.monotonic() < end and not _results(out, {2}):
            out += _read(p, "", 0.3)
    finally:
        timer.cancel()
        _stop(p)
        s.close()
    got = _results(out, {1, 2})
    assert "restarted while `add_card` ran" in got[1]["result"]["content"][0]["text"]
    assert got[2]["result"]["content"][0]["text"].startswith("add_card failed on the thimble server (HTTP 500)")
