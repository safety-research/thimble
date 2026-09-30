"""http_guard: a state-changing request a browser sends from another origin is refused, the channel refuses a web page
even on a GET, a JSON route refuses a body without a JSON content type, and every response carries nosniff,
frame-ancestors and a policy (the built UI's, or the API's)."""
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


def test_a_post_from_another_origin_is_refused_before_it_reaches_the_route(app_prod, monkeypatch):
    c = TestClient(app_prod)
    from app import dev

    reverted = []
    monkeypatch.setattr(dev, "revert_last_apply", lambda: reverted.append(1) or {"ok": False})
    for origin in ("https://evil.example", "http://localhost:5173", "http://127.0.0.1:5300", "null",
                   "http://testserver.evil.example", "http://127.0.0.1:1"):
        r = c.post("/api/dev/revert", headers={"Origin": origin})
        assert r.status_code == 403, origin
        assert "may not change state" in r.json()["detail"]
        r = c.put(THEME_PATH, json=THEME, headers={"Origin": origin})
        assert r.status_code == 403, origin
    assert not reverted
    assert not (config.WORKSPACES_DIR / "mini" / "render-theme.json").exists()
    # a cross-site request that carries no Origin is refused on Sec-Fetch-Site alone
    r = c.put(THEME_PATH, json=THEME, headers={"Sec-Fetch-Site": "cross-site"})
    assert r.status_code == 403


def test_the_channel_refuses_a_web_page_on_a_get_too(app_prod, monkeypatch):
    """The shim's subscription is a GET that makes the session it names main (channel.subscribe): no browser request
    may reach it, not even the app's own page (an <img> in markdown a model wrote sends Sec-Fetch-Site: same-origin and
    no Origin). The shim and the hooks send no Origin and no Sec-Fetch-* header, and pass."""
    from app import channel, session

    attached = []
    monkeypatch.setattr(config, "workspace_for_cwd", lambda cwd: "mini")
    monkeypatch.setattr(session, "connected", lambda *a, **k: attached.append(a))
    monkeypatch.setattr(session, "main_pid", lambda c: 4242)
    c = TestClient(app_prod)
    q = "cwd=/corpus&session=evil&pid=1&delivery=channel"
    for headers in ({"Origin": "https://evil.example"}, {"Origin": "null"}, {"Origin": "http://127.0.0.1:1"},
                    {"Origin": "http://testserver"}, {"Sec-Fetch-Site": "cross-site"}, {"Sec-Fetch-Site": "same-site"},
                    {"Sec-Fetch-Site": "none"}, {"Sec-Fetch-Site": "same-origin"}, {"Sec-Fetch-Dest": "image"},
                    {"Sec-Fetch-Mode": "no-cors"}):
        # the subscription last: were it served, its stream would not end
        for path in ("/api/channel/main?cwd=/corpus&pid=4242", f"/api/channel/pull?{q}&wait=0", f"/api/channel?{q}"):
            r = c.get(path, headers=headers)
            assert r.status_code == 403, (path, headers)
    assert not attached and not channel._subs.get("mini")
    # the hooks' curl: no Origin, no Sec-Fetch-Site
    assert c.get("/api/channel/main?cwd=/corpus&pid=4242").json() == {"workspace": "mini", "main": True}
    assert c.post("/api/channel/ack", json={"cwd": "/corpus", "id": "x"},
                  headers={"Origin": "http://testserver", "Sec-Fetch-Site": "same-origin"}).status_code == 403
    # a read elsewhere is still never refused
    assert c.get("/api/health", headers={"Sec-Fetch-Site": "same-site"}).status_code == 200


def test_a_json_route_refuses_a_body_without_a_json_content_type(app_prod):
    """The second defence behind the Origin check (pyproject's fastapi>=0.132): a no-cors fetch or a form can send a
    body with no Content-Type or a text one, and a JSON route does not read it."""
    c = TestClient(app_prod)
    body = b'{"paper":"warm","accent":"pink"}'
    assert c.put(THEME_PATH, content=body).status_code == 422
    assert c.put(THEME_PATH, content=body, headers={"Content-Type": "text/plain"}).status_code == 422
    assert c.put(THEME_PATH, content=body, headers={"Content-Type": "application/json"}).status_code == 200


@pytest.fixture()
def dist(tmp_path, monkeypatch):
    d = tmp_path / "dist"
    (d / "assets").mkdir(parents=True)
    (d / "index.html").write_text("<!doctype html><title>thimble</title><div id=root></div>")
    (d / "assets" / "main-abc123.js").write_text("console.log(1)")
    monkeypatch.setattr(config, "FRONTEND_DIST", d)
    monkeypatch.delenv("THIMBLE_DEV", raising=False)
    return d


def directives(csp: str) -> dict[str, str]:
    return {p.strip().split(" ", 1)[0]: (p.strip().split(" ", 1) + [""])[1] for p in csp.split(";") if p.strip()}


def test_the_app_shell_and_the_api_carry_the_security_headers(dist):
    c = TestClient(main.create_app())
    for path in ("/", "/ws/mini/report", "/assets/main-abc123.js"):
        r = c.get(path)
        assert r.status_code == 200, path
        assert r.headers["x-content-type-options"] == "nosniff"
        assert r.headers["x-frame-options"] == "SAMEORIGIN"
        d = directives(r.headers["content-security-policy"])
        assert d["frame-ancestors"] == "'self'"
        # nothing the page loads or sends may leave the machine: no host in any fetch directive
        for k in ("default-src", "script-src", "style-src", "img-src", "font-src", "connect-src", "media-src", "frame-src"):
            assert "http" not in d[k] and "*" not in d[k], (k, d[k])
        assert d["img-src"] == "'self' data: blob:" and d["object-src"] == "'none'"
    for path in ("/api/health", "/api/no-such-route"):
        r = c.get(path)
        assert r.headers["x-content-type-options"] == "nosniff", path
        d = directives(r.headers["content-security-policy"])
        assert d["default-src"] == "'none'" and "sandbox" in d and d["frame-ancestors"] == "'self'"
    # a refusal carries them too
    r = c.post("/api/dev/revert", headers={"Origin": "https://evil.example"})
    assert r.status_code == 403 and r.headers["x-content-type-options"] == "nosniff"


@pytest.mark.real_write_guard
def test_a_write_needs_the_browser_cookie_or_the_plugin_proof_so_a_kernel_cannot_reach_the_api(app_prod, plugin_headers):
    """hook_auth.LocalWriteGuard: a write to the local API must prove the ui_key cookie (the browser) or the token (the
    plugin or the CLI). A notebook kernel runs model-authored code with the host's network and can open this server on
    127.0.0.1, but the sandbox hides server.json from it, so it holds neither — and forging a same-origin Origin, which
    slips past the Origin check, does not help. Reads, the browser's key claim and a view's check poster stay reachable."""
    from conftest import UI_KEY, _record

    from app import hook_auth

    _record(ui_key=UI_KEY)  # plugin_headers has already recorded the token
    c = TestClient(app_prod, base_url="http://testserver")

    # the kernel: no cookie, no proof — on several write routes, and even forging the server's own Origin
    for headers in ({}, {"Origin": "http://testserver"}, {"Sec-Fetch-Site": "same-origin"}):
        r = c.put(THEME_PATH, json=THEME, headers=headers)
        assert r.status_code == 403 and r.json()["detail"] == hook_auth.WRITE_REFUSED, headers
    assert c.delete("/api/ws/mini").status_code == 403
    assert c.post("/api/ws/mini/orientation/message", json={"text": "impersonated"}).status_code == 403
    assert c.post("/api/dev/tickets", json={"workspace": "mini", "title": "x", "body": "y", "source": "terminal"}).status_code == 403

    # a local tool proves the token
    assert c.put(THEME_PATH, json=THEME, headers=plugin_headers()).status_code == 200
    # a wrong token is no better than none
    assert c.put(THEME_PATH, json=THEME, headers=hook_auth.headers("wrong-token", "n0nce")).status_code == 403

    # the browser proves the ui_key cookie
    c.cookies.set(hook_auth.UI_COOKIE, UI_KEY)
    assert c.put(THEME_PATH, json=THEME).status_code == 200
    c.cookies.set(hook_auth.UI_COOKIE, "not-the-key")
    assert c.put(THEME_PATH, json=THEME).status_code == 403
    c.cookies.delete(hook_auth.UI_COOKIE)

    # reads are untouched, and the routes the guard exempts stay reachable without either proof: the browser's key claim
    # (which sets the cookie) and a view build's check poster (view_check.py, run in a sandbox that reads no server.json)
    assert c.get("/api/corpora").status_code == 200
    assert c.post("/api/ui/key", json={"key": UI_KEY}).status_code == 204
    assert c.post("/api/ws/mini/views/none/check", json={"locators": []}).json().get("detail") != hook_auth.WRITE_REFUSED
