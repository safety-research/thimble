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
