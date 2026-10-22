"""The MCP shim's routes take the proof the plugin's hooks give (app/hook_auth.py): the server answers a tool call and
the event subscription only when the request proves the token in server.json, and proves it back; the shim
(plugin/bin/thimble-mcp) believes no answer without that proof."""
from __future__ import annotations

import time

from fastapi.testclient import TestClient
from test_shim import INITIALIZE, INITIALIZED, _read, _send, _Server, _start, _stop

from app import config, hook_auth
from app.main import create_app

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
