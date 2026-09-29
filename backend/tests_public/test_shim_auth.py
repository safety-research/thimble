"""The MCP shim's routes take the proof the plugin's hooks give (app/hook_auth.py): the server answers a tool call, the
channel subscription and a relayed permission prompt only when the request proves the token in server.json, and proves
it back; the shim (plugin/bin/thimble-mcp) believes no answer without that proof."""
from __future__ import annotations

import time

from conftest import UI_KEY
from fastapi.testclient import TestClient
from test_shim_channel import INITIALIZE, INITIALIZED, REQUEST, _read, _send, _Server, _start, _stop

from app import config, hook_auth
from app.main import create_app

CORPUS = "mini"


def test_the_server_answers_the_shim_s_routes_only_to_a_request_that_proves_the_token(plugin_headers):
    cwd = str(config.corpus_dir(CORPUS))
    tool = {"args": {"ref": "events.jsonl#L1"}, "actor": "analyst", "cwd": cwd}
    asks = [("POST", "/api/tools/read_ref", {"json": tool}), ("GET", "/api/channel", {"params": {"cwd": "/nowhere"}}),
            ("POST", "/api/channel/permission", {"json": {**REQUEST, "cwd": "/nowhere", "session": None}}),
            ("POST", f"/api/ws/{CORPUS}/sessions/permission", {"json": {"session": "orient", "tool_name": "Bash"}})]
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


def test_the_shim_believes_no_answer_without_the_server_s_proof(tmp_path):
    """A process on the recorded port that cannot prove the token gets the shim's requests, but its tool answer is never
    shown, and neither its channel event nor its permission verdict reaches Claude Code."""
    call = {"jsonrpc": "2.0", "id": 1, "method": "tools/call",
            "params": {"name": "message_orientation", "arguments": {"message": "more"}}}
    rogue = _Server(token=None)
    try:
        p = _start(tmp_path, rogue.port, channel=True)
        try:
            _send(p, [INITIALIZE, INITIALIZED, call])
            out: list[dict] = []
            subscribed, end = None, time.monotonic() + 20
            # the stand-in writes both events as it answers the subscription, so a shim that believed it would pass them
            # on within the second after
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
    assert not [m for m in out if str(m.get("method", "")).startswith("notifications/claude/channel")]


def test_the_analyst_s_cookie_goes_only_to_thimble_s_workspace_routes(analyst):
    """The page's key is traded for a cookie scoped to /api/ws/, the path of every route it opens, and the trade clears
    one set for every path, since a browser sends a cookie to every port of its host; another key gets none."""
    r = hook_auth.claim(UI_KEY)
    cookies = [v.decode() for k, v in r.raw_headers if k == b"set-cookie"]
    assert any(c.startswith(f"{hook_auth.UI_COOKIE}={UI_KEY};") and "Path=/api/ws/" in c for c in cookies), cookies
    assert any(c.startswith(f'{hook_auth.UI_COOKIE}="";') and "Path=/;" in c for c in cookies), cookies
    assert hook_auth.claim("another-key").status_code == 403
