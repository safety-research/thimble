"""The MCP shim's routes take the proof the plugin's hooks give (app/hook_auth.py): the server answers a tool call, the
channel subscription and a relayed permission prompt only when the request proves the token in server.json, and the
shim (plugin/bin/thimble-mcp) sends every such request with that proof, believes an answer only when it proves the
server holds the token, and reaches no port at all without server.json. The shim runs against test_shim_channel's
stand-in."""
from __future__ import annotations

import json

from fastapi.testclient import TestClient
from test_shim_channel import INITIALIZE, INITIALIZED, REQUEST, _read, _send, _Server, _start, _stop

from app import config, hook_auth
from app.main import create_app

CORPUS = "mini"
PERMISSION_NOTE = {"jsonrpc": "2.0", "method": "notifications/claude/channel/permission_request", "params": REQUEST}


def _call(i: int) -> dict:
    return {"jsonrpc": "2.0", "id": i, "method": "tools/call",
            "params": {"name": "message_orientation", "arguments": {"message": "more"}}}


def test_the_server_answers_the_shim_s_routes_only_to_a_request_that_proves_the_token(plugin_headers):
    cwd = str(config.corpus_dir(CORPUS))
    tool = {"args": {"ref": "events.jsonl#L1"}, "actor": "analyst", "cwd": cwd}
    asks = [("POST", "/api/tools/read_ref", {"json": tool}), ("GET", "/api/channel", {"params": {"cwd": "/nowhere"}}),
            ("POST", "/api/channel/permission", {"json": {**REQUEST, "cwd": "/nowhere", "session": None}})]
    with TestClient(create_app(), base_url="http://127.0.0.1") as client:
        wrong = hook_auth.headers("another-token", "n0nce")
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


def test_without_server_json_the_shim_reaches_no_port_and_says_no_server_is_recorded(tmp_path):
    stand = _Server(token=None)
    try:
        p = _start(tmp_path, None, channel=True, extra={"THIMBLE_PORT": str(stand.port), "THIMBLE_MCP_RETRY_S": "1"})
        try:
            _send(p, [INITIALIZE, INITIALIZED, PERMISSION_NOTE, _call(1)])
            out = _read(p, lambda: False, 6)
        finally:
            _stop(p)
    finally:
        stand.close()
    answer = next(m for m in out if m.get("id") == 1)["result"]
    assert answer["isError"] and "no thimble server is recorded" in answer["content"][0]["text"]
    assert str(tmp_path / "home" / "server.json") in answer["content"][0]["text"]
    assert not (stand.queries or stand.posts or stand.calls or stand.refused), "not THIMBLE_PORT, not 8300"


def test_the_shim_proves_the_token_and_believes_no_answer_without_the_server_s_proof(tmp_path):
    """Its own server answers every request (none refused). A process on the recorded port that cannot prove the
    token gets the calls but is not believed: its tool answer is never shown, and neither its channel event nor its
    permission verdict reaches Claude Code."""
    good = _Server()
    try:
        p = _start(tmp_path, good.port, channel=True)
        try:
            _send(p, [INITIALIZE, INITIALIZED, PERMISSION_NOTE, _call(1)])
            out = _read(p, lambda: bool(good.posts) and bool(good.calls) and bool(good.queries), 30)
            out += _read(p, "notifications/claude/channel/permission", 5)
        finally:
            _stop(p)
    finally:
        good.close()
    assert good.refused == [] and good.queries and good.posts and good.calls
    assert {m.get("method") for m in out} >= {"notifications/claude/channel", "notifications/claude/channel/permission"}

    rogue = _Server(token=None)
    try:
        p = _start(tmp_path, rogue.port, channel=True, extra={"THIMBLE_MCP_RETRY_S": "1"})
        try:
            _send(p, [INITIALIZE, INITIALIZED, _call(1)])
            out = _read(p, lambda: False, 8)
        finally:
            _stop(p)
    finally:
        rogue.close()
    assert rogue.queries and rogue.calls, "it was asked"
    answer = next(m for m in out if m.get("id") == 1)["result"]
    assert answer["isError"] and "did not prove" in answer["content"][0]["text"]
    assert "ok" not in [c.get("text") for c in answer["content"]]
    assert not [m for m in out if str(m.get("method", "")).startswith("notifications/claude/channel")]


def test_a_refused_call_is_sent_again_with_the_token_server_json_holds_by_then(tmp_path):
    """A restart writes a new token: a call the server refused (401, so it did not run) is sent again with the token
    read afresh, within the retry window."""
    fresh = "the-token-of-the-new-start"
    srv = _Server(token=fresh)
    try:
        p = _start(tmp_path, srv.port, channel=False, extra={"THIMBLE_MCP_RETRY_S": "10"})
        try:
            _send(p, [INITIALIZE, INITIALIZED, _call(1)])
            _read(p, lambda: bool(srv.refused), 15)
            assert srv.refused and not srv.calls, "refused, not run"
            (tmp_path / "home" / "server.json").write_text(json.dumps({"api": f"http://127.0.0.1:{srv.port}", "token": fresh}))
            out = _read(p, lambda: False, 5)
        finally:
            _stop(p)
    finally:
        srv.close()
    answer = next(m for m in out if m.get("id") == 1)["result"]
    assert not answer["isError"] and answer["content"][0]["text"] == "ok" and len(srv.calls) == 1
