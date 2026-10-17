"""http_guard: a state-changing request a browser sends from another origin is refused, the plugin's routes refuse a web
page even on a GET, a JSON route refuses a body without a JSON content type, and every response carries nosniff,
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


def test_the_plugin_s_routes_refuse_a_web_page_on_a_get_too(app_prod, monkeypatch):
    """The shim's subscription is a GET that attaches the session it names (events.subscribe): no browser request
    may reach it, not even the app's own page (an <img> in markdown a model wrote sends Sec-Fetch-Site: same-origin and
    no Origin). The shim and the hooks send no Origin and no Sec-Fetch-* header, and pass."""
    from app import events, session

    attached = []
    monkeypatch.setattr(config, "workspace_for_cwd", lambda cwd: "mini")
    monkeypatch.setattr(session, "connected", lambda *a, **k: attached.append(a))
    monkeypatch.setattr(session, "main_pid", lambda c: 4242)
    c = TestClient(app_prod)
    q = "cwd=/corpus&session=evil&pid=1&delivery=hook"
    for headers in ({"Origin": "https://evil.example"}, {"Origin": "null"}, {"Origin": "http://127.0.0.1:1"},
                    {"Origin": "http://testserver"}, {"Sec-Fetch-Site": "cross-site"}, {"Sec-Fetch-Site": "same-site"},
                    {"Sec-Fetch-Site": "none"}, {"Sec-Fetch-Site": "same-origin"}, {"Sec-Fetch-Dest": "image"},
                    {"Sec-Fetch-Mode": "no-cors"}):
        # the subscription last: were it served, its stream would not end
        for path in ("/api/events/main?cwd=/corpus&pid=4242", f"/api/events/pull?{q}&wait=0", f"/api/events?{q}"):
            r = c.get(path, headers=headers)
            assert r.status_code == 403, (path, headers)
    assert not attached and not events._subs.get("mini")
    # the hooks' curl: no Origin, no Sec-Fetch-Site
    assert c.get("/api/events/main?cwd=/corpus&pid=4242").json() == {"workspace": "mini", "main": True}
    assert c.post("/api/events/ack", json={"cwd": "/corpus", "id": "x"},
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
@pytest.mark.real_read_guard
def test_a_write_needs_a_signed_in_browser_so_neither_a_kernel_nor_the_token_reaches_an_analyst_route(
        app_prod, plugin_headers, monkeypatch):
    """hook_auth.LocalWriteGuard: a write to an analyst route of the local API must come from a signed-in browser (its
    cookie). A notebook kernel runs model-authored code with the host's network and can open this server on 127.0.0.1,
    but holds no cookie, and forging a same-origin Origin, which slips past the Origin check, does not help. The token
    in server.json, which the plugin and the CLI prove, reaches only the token routes (hook_auth.guarded), so a process
    that reads server.json is refused here too, in the words the page shows today. A read needs the cookie too
    (hook_auth.LocalReadGuard), or the CLI's proof; the browser's claim of a link's code stays open."""
    from conftest import UI_COOKIE_VALUE, UI_KEY_VALUE, _record_paired

    from app import hook_auth

    monkeypatch.setenv("THIMBLE_PORT", "8300")
    _record_paired(UI_COOKIE_VALUE)
    c = TestClient(app_prod, base_url="http://testserver")
    page = f"/b/{UI_KEY_VALUE}"  # where the signed-in browser's page asks (hook_auth.browser_path)

    # the kernel: no cookie, no proof, on several write routes, and even forging the server's own Origin
    for headers in ({}, {"Origin": "http://testserver"}, {"Sec-Fetch-Site": "same-origin"}):
        r = c.put(THEME_PATH, json=THEME, headers=headers)
        assert r.status_code == 403 and r.json()["detail"] == hook_auth.WRITE_REFUSED, headers
    assert c.delete("/api/ws/mini").status_code == 401  # a token route (the CLI's `thimble rm`)
    assert c.post("/api/ws/mini/orientation/message", json={"text": "impersonated"}).status_code == 403
    assert c.post("/api/dev/tickets", json={"workspace": "mini", "title": "x", "body": "y", "source": "terminal"}).status_code == 403
    # a view's check route too: it would keep the kernel's locators on the proposal the build's gate checks
    r = c.post("/api/ws/mini/views/none/check", json={"locators": ["events.jsonl#L1"]})
    assert r.status_code == 403 and r.json()["detail"] == hook_auth.WRITE_REFUSED

    # the token alone is refused on an analyst route, word for word as a page without the cookie is
    r = c.put(THEME_PATH, json=THEME, headers=plugin_headers())
    assert r.status_code == 403 and r.json()["detail"] == hook_auth.WRITE_REFUSED
    assert c.put(THEME_PATH, json=THEME, headers=hook_auth.headers("wrong-token", 80)).status_code == 403
    not_ascii = {hook_auth.NONCE_HEADER: "n", hook_auth.AUTH_HEADER: "\u00e9".encode("latin-1")}
    assert c.put(THEME_PATH, json=THEME, headers=not_ascii).status_code == 403

    # a signed-in browser's cookie, under this server's name, on the path of that browser's key alone
    c.cookies.set(hook_auth.ui_cookie(), UI_COOKIE_VALUE)
    assert c.put(page + THEME_PATH, json=THEME).status_code == 200
    assert c.put(THEME_PATH, json=THEME).status_code == 403, "the cookie on the API's own path"
    c.cookies.set(hook_auth.ui_cookie(), "not-a-signed-in-cookie")
    assert c.put(page + THEME_PATH, json=THEME).status_code == 403
    c.cookies.clear()

    # a read needs the cookie too (it was open before 0.8.0), however the kernel forges its Origin, or the CLI's proof
    for headers in ({}, {"Origin": "http://testserver"}, {"Sec-Fetch-Site": "same-origin"}):
        r = c.get("/api/corpora", headers=headers)
        assert (r.status_code, r.json()) == (401, {"detail": hook_auth.SIGN_IN_NEEDED, "signin": True}), headers
    assert c.get("/api/corpora", headers=plugin_headers()).status_code == 200
    c.cookies.set(hook_auth.ui_cookie(), UI_COOKIE_VALUE)
    assert c.get(page + "/api/corpora").status_code == 200
    assert c.get("/api/corpora").status_code == 401, "the cookie on the API's own path"
    c.cookies.clear()
    # the claim of a link's code needs no credential
    assert c.post("/api/ui/key", json={"code": hook_auth.mint("mini")}).status_code == 200


@pytest.mark.real_write_guard
def test_two_servers_on_one_machine_keep_their_own_cookies(app_prod, monkeypatch):
    """A cookie is not bound to a port, so each server names its cookie for its port (hook_auth.ui_cookie): the claim
    sets only this server's cookie, and another server's cookie, which the browser also sends here, proves nothing
    here."""
    from app import hook_auth

    monkeypatch.setenv("THIMBLE_PORT", "8300")
    c = TestClient(app_prod, base_url="http://testserver")
    r = c.post("/api/ui/key", json={"code": hook_auth.mint()})
    assert r.status_code == 200
    key = r.json()["key"]
    set_cookies = [h for h in r.headers.get_list("set-cookie") if "Max-Age=0" not in h]  # beside an old one's deletion
    assert len(set_cookies) == 1 and set_cookies[0].startswith("thimble-ui-8300=")
    assert f"Path=/b/{key}/api/" in set_cookies[0]
    assert "HttpOnly" in set_cookies[0] and "SameSite=strict" in set_cookies[0]
    mine = c.cookies.get("thimble-ui-8300", path=hook_auth.browser_path(key))
    page = f"/b/{key}"

    # the other server's cookie, which the browser sends to every port of 127.0.0.1, is not this server's
    c.cookies.clear()
    c.cookies.set("thimble-ui-8302", "the-other-servers-cookie")
    assert c.put(page + THEME_PATH, json=THEME).status_code == 403
    c.cookies.set("thimble-ui-8300", mine)
    assert c.put(page + THEME_PATH, json=THEME).status_code == 200
