"""http_guard and hook_auth: a request a web page of another site sends is refused (its Origin or Sec-Fetch-Site, a
JSON body without a JSON content type, a Host that is not this machine's), and a write to an analyst route needs a
signed-in browser's cookie, so neither a notebook kernel, which can reach 127.0.0.1, nor the plugin's token does."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app import config, main

THEME = {"paper": "warm", "accent": "pink"}
THEME_PATH = "/api/ws/mini/render/theme"


@pytest.fixture()
def app_prod(monkeypatch):
    monkeypatch.delenv("THIMBLE_DEV", raising=False)
    monkeypatch.delenv("THIMBLE_UI_PORT", raising=False)
    return main.create_app()


def test_a_request_another_site_sends_is_refused_before_it_reaches_the_route(app_prod, monkeypatch):
    c = TestClient(app_prod)
    from app import dev

    reverted = []
    monkeypatch.setattr(dev, "revert_last_apply", lambda: reverted.append(1) or {"ok": False})
    for origin in ("https://evil.example", "http://localhost:5173", "null", "http://testserver.evil.example"):
        assert c.post("/api/dev/revert", headers={"Origin": origin}).status_code == 403, origin
        assert c.put(THEME_PATH, json=THEME, headers={"Origin": origin}).status_code == 403, origin
    assert not reverted
    assert not (config.WORKSPACES_DIR / "mini" / "render-theme.json").exists()
    # a cross-site request that carries no Origin is refused on Sec-Fetch-Site alone
    assert c.put(THEME_PATH, json=THEME, headers={"Sec-Fetch-Site": "cross-site"}).status_code == 403
    # a no-cors fetch or a form can send a body with no Content-Type or a text one, which a JSON route does not read
    body = b'{"paper":"warm","accent":"pink"}'
    assert c.put(THEME_PATH, content=body).status_code == 422
    assert c.put(THEME_PATH, content=body, headers={"Content-Type": "text/plain"}).status_code == 422
    # DNS rebinding: a page on evil.example resolving to 127.0.0.1 is not same-origin with the API
    assert c.get("/api/corpora", headers={"Host": "evil.example:8000"}).status_code == 400
    assert c.get("/api/corpora", headers={"Host": "127.0.0.1:8000"}).status_code == 200
    assert c.put(THEME_PATH, content=body, headers={"Content-Type": "application/json"}).status_code == 200


@pytest.mark.real_write_guard
def test_a_write_needs_a_signed_in_browser_so_neither_a_kernel_nor_the_token_reaches_an_analyst_route(
        app_prod, plugin_headers, monkeypatch):
    """hook_auth.LocalWriteGuard: a write to an analyst route of the local API must come from a signed-in browser (its
    cookie). A notebook kernel runs model-authored code with the host's network and can open this server on 127.0.0.1,
    but holds no cookie, and forging a same-origin Origin, which slips past the Origin check, does not help. The token
    in server.json, which the plugin and the CLI prove, reaches only the token routes (hook_auth.guarded)."""
    from conftest import UI_COOKIE_VALUE, UI_KEY_VALUE, _record_paired

    from app import hook_auth

    monkeypatch.setenv("THIMBLE_PORT", "8300")
    _record_paired(UI_COOKIE_VALUE)
    c = TestClient(app_prod, base_url="http://testserver")
    page = f"/b/{UI_KEY_VALUE}"  # where the signed-in browser's page asks (hook_auth.browser_path)

    # the kernel: no cookie, no proof, even forging the server's own Origin
    for headers in ({}, {"Origin": "http://testserver"}, {"Sec-Fetch-Site": "same-origin"}):
        r = c.put(THEME_PATH, json=THEME, headers=headers)
        assert r.status_code == 403 and r.json()["detail"] == hook_auth.WRITE_REFUSED, headers
    assert c.delete("/api/ws/mini").status_code == 401  # a token route (the CLI's `thimble rm`)
    assert c.post("/api/dev/tickets", json={"workspace": "mini", "title": "x", "body": "y", "source": "terminal"}).status_code == 403
    # the token alone is refused on an analyst route
    r = c.put(THEME_PATH, json=THEME, headers=plugin_headers())
    assert r.status_code == 403 and r.json()["detail"] == hook_auth.WRITE_REFUSED
    # a signed-in browser's cookie, on the path of that browser's key alone
    c.cookies.set(hook_auth.ui_cookie(), UI_COOKIE_VALUE)
    assert c.put(page + THEME_PATH, json=THEME).status_code == 200
    assert c.put(THEME_PATH, json=THEME).status_code == 403, "the cookie on the API's own path"
    c.cookies.set(hook_auth.ui_cookie(), "not-a-signed-in-cookie")
    assert c.put(page + THEME_PATH, json=THEME).status_code == 403
