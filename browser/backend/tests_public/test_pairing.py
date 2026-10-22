"""Signing a browser in to thimble (hook_auth: mint, claim, the signed-in browsers; main: the /api/ui routes and
signed_in). The dashboard link carries a one-time code after `#p=`, made when the link is shown; the page trades it for
a cookie and a key, and the server keeps only the sha256 of each code, cookie and key, so no file, transcript or link
holds a credential that lasts. The cookie is scoped to the path of that browser's key, /b/<key>/api/, and counts only
there. Each new sign-in shows twice: a notice with Sign it out, and a line under main's next reply."""
from __future__ import annotations

import importlib
import json
import re

import pytest
from fastapi.testclient import TestClient

from app import hook_auth, main, notices, session
from conftest import sign_in

CORPUS = "mini"
SID = "5e55a000-0000-4000-8000-0000000000b1"


@pytest.fixture()
def client(monkeypatch):
    monkeypatch.setenv("THIMBLE_PORT", "8300")
    monkeypatch.delenv("THIMBLE_DEV", raising=False)
    return TestClient(main.create_app(), base_url="http://testserver")


@pytest.fixture(autouse=True)
def _no_main():
    session._live.clear()
    yield
    session._live.clear()


def _claim(code: object, cookie: str | None = None, key: str | None = None):
    """hook_auth.claim of `code` from a page that holds `cookie` and asks under the path of `key` (None: neither)."""
    from starlette.requests import Request

    headers = [(b"cookie", f"{hook_auth.ui_cookie()}={cookie}".encode())] if cookie else []
    state = {hook_auth.BROWSER_KEY_SCOPE: key} if key else {}
    return hook_auth.claim({"code": code}, Request({"type": "http", "headers": headers, "state": state}))


def _set_cookies(r) -> list[str]:
    return [v.decode() for k, v in r.raw_headers if k == b"set-cookie"]


def _cookie_of(r) -> str:
    """The value of the cookie a claim's answer sets, the one scoped to a browser's path (beside the deletion of an
    earlier build's cookie)."""
    [value] = [c.split(";", 1)[0].split("=", 1)[1] for c in _set_cookies(r) if "Path=/b/" in c]
    return value


def _key_of(r) -> str:
    return json.loads(r.body)["key"]


def _signed(r) -> tuple[str, str]:
    """(the cookie, the key) a claim's answer gives."""
    return _cookie_of(r), _key_of(r)


def _gone(r) -> bool:
    return r.status_code == 410 and json.loads(r.body) == {"detail": hook_auth.CODE_GONE}


def test_a_code_works_once():
    code = hook_auth.mint(CORPUS)
    r, browser = _claim(code)
    assert r.status_code == 200 and re.fullmatch(r"[0-9a-f]{12}", browser)
    cookie, key = _signed(r)
    assert len(cookie) >= 40, "a random cookie of 32 bytes"
    assert re.fullmatch(r"[A-Za-z0-9_-]{32}", key), "a random key of 24 bytes"
    again, none = _claim(code)
    assert _gone(again) and none == ""
    assert hook_auth.CODE_GONE == ("This sign-in link was already used or has expired. Run `thimble up` in a shell for"
                                   " a new one, or type /thimble in your terminal.")


def test_a_code_expires_and_a_newer_code_for_the_workspace_voids_it(monkeypatch):
    now = [1000.0]
    monkeypatch.setattr(hook_auth, "_now", lambda: now[0])
    old = hook_auth.mint(CORPUS)
    now[0] += hook_auth.PAIR_TTL_S + 1
    assert _gone(_claim(old)[0]), "older than PAIR_TTL_S"
    assert hook_auth.PAIR_TTL_S == 300
    first = hook_auth.mint(CORPUS)
    start = hook_auth.mint("")
    other = hook_auth.mint("other")
    newer = hook_auth.mint(CORPUS)
    assert _gone(_claim(first)[0]), "the newer code for the same workspace voided it"
    for code in (start, other, newer):
        assert _claim(code)[0].status_code == 200, "codes for other workspaces stay alive"


def test_a_restart_voids_every_code_but_keeps_the_signed_in_browsers():
    code = hook_auth.mint(CORPUS)
    r, _ = _claim(hook_auth.mint("other"))
    cookie, key = _signed(r)
    importlib.reload(hook_auth)  # a new server process
    try:
        assert _gone(_claim(code)[0]), "codes live in memory alone"
        assert _claim("x", cookie, key)[0].status_code == 204, "the browser is still signed in (paired.json)"
    finally:
        hook_auth._codes.clear()
        hook_auth._paired = None


def test_every_workspace_s_code_stays_alive_and_no_sign_in_signs_another_browser_out():
    """No count limits the live codes or the signed-in browsers: a code goes only when it is spent, expires or a newer
    one for its workspace is made, and a browser is signed out only by Sign it out or `thimble unpair`."""
    codes = [hook_auth.mint(f"ws{i}") for i in range(40)]
    assert len(hook_auth._codes) == 40
    signed = [_signed(_claim(c)[0]) for c in codes]
    assert len(hook_auth._entries()) == 40
    assert all(_claim("x", cookie, key)[0].status_code == 204 for cookie, key in signed), \
        "the first browser is still signed in"


def test_a_signed_in_browser_spends_a_code_with_no_cookie_no_entry_and_no_notice(client):
    from conftest import UI_COOKIE_VALUE, _record_paired, browser_base

    _record_paired(UI_COOKIE_VALUE)
    code = hook_auth.mint(CORPUS)
    client.cookies.set(hook_auth.ui_cookie(), UI_COOKIE_VALUE)
    client.base_url = browser_base()  # a signed-in page posts under its key's path, where its cookie goes
    r = client.post("/api/ui/key", json={"code": code, "ws": CORPUS})
    assert r.status_code == 204 and "set-cookie" not in r.headers
    assert len(hook_auth._entries()) == 1 and notices.open_notices(CORPUS) == []
    assert _gone(_claim(code)[0]), "spent"
    assert client.post("/api/ui/key", json={"code": "old", "ws": CORPUS}).status_code == 204, \
        "a signed-in page that loads with an old code is not refused"


def test_paired_json_holds_only_hashes_readable_by_its_owner(tmp_path):
    r, browser = _claim(hook_auth.mint())
    cookie, key = _signed(r)
    path = hook_auth.home() / hook_auth.PAIRED_FILE
    text = path.read_text()
    assert cookie not in text and key not in text and browser in text
    [entry] = json.loads(text)
    assert set(entry) == {"hash", "key", "at"} and re.fullmatch(r"[0-9a-f]{64}", entry["hash"])
    assert entry["key"] == hook_auth._sha(key)
    assert path.stat().st_mode & 0o077 == 0


def test_an_edit_of_paired_json_while_the_server_runs_signs_nobody_in():
    _claim(hook_auth.mint())
    path = hook_auth.home() / hook_auth.PAIRED_FILE
    planted, planted_key = "planted-cookie", "planted-key-0123456789"
    entries = json.loads(path.read_text()) + [{"hash": hook_auth._sha(planted), "key": hook_auth._sha(planted_key),
                                               "at": "now"}]
    path.write_text(json.dumps(entries))
    assert _claim("x", planted, planted_key)[0].status_code == 410, "read at start, then kept in memory"


def test_an_old_key_body_gets_410(client):
    for body in ({"key": "the-old-ui-key"}, {}, {"code": 7}, {"code": ""}, {"code": "never-made"}):
        r = client.post("/api/ui/key", json=body)
        assert r.status_code == 410 and r.json() == {"detail": hook_auth.CODE_GONE}, body
        assert "set-cookie" not in r.headers


@pytest.mark.real_write_guard
def test_the_paired_route_says_whether_this_browser_is_signed_in_and_its_id(client):
    assert client.get("/api/ui/paired").json() == {"paired": False, "id": ""}
    sign_in(client, hook_auth.mint())
    browser = hook_auth._entries()[0]["hash"][:12]
    assert client.get("/api/ui/paired").json() == {"paired": True, "id": browser}
    client.cookies.clear()
    client.cookies.set(hook_auth.ui_cookie(), "not-signed-in")
    assert client.get("/api/ui/paired").json() == {"paired": False, "id": ""}


@pytest.mark.real_write_guard
def test_the_pair_route_needs_the_token_and_gives_a_code_for_five_minutes(client, plugin_headers):
    assert client.post("/api/ui/pair", json={"ws": CORPUS}).status_code == 401, "a page or a kernel gets none"
    r = client.post("/api/ui/pair", json={"ws": CORPUS}, headers=plugin_headers())
    assert r.status_code == 200 and r.json()["expires_s"] == 300 and r.json()["code"]
    assert client.post("/api/ui/key", json={"code": r.json()["code"], "ws": CORPUS}).status_code == 200
    r = client.post("/api/ui/pair", headers=plugin_headers())
    assert r.status_code == 200 and r.json()["code"], "the start page's code, with no body"


@pytest.mark.real_write_guard
def test_unpair_with_the_token_signs_every_browser_out_and_signout_with_a_cookie_signs_one_out(client, plugin_headers):
    other = TestClient(client.app, base_url="http://testserver")
    mine_key = sign_in(client, hook_auth.mint())
    sign_in(other, hook_auth.mint("other"))
    mine, theirs = client.get("/api/ui/paired").json()["id"], other.get("/api/ui/paired").json()["id"]
    assert mine and theirs and mine != theirs
    session.attach(CORPUS, SID, "/data/mini")
    notices.post(CORPUS, kind="sign-in", key=f"sign-in:{theirs}", text="A browser signed in.",
                 action={"label": "Sign it out", "do": "sign-out", "slug": theirs})

    bare = TestClient(client.app, base_url="http://testserver")
    assert bare.post("/api/ui/signout", json={"id": theirs, "ws": CORPUS}, headers=plugin_headers()).status_code == 403, \
        "the token alone signs no one out"
    r = client.post("/api/ui/signout", json={"id": theirs, "ws": CORPUS})
    assert r.json() == {"signed_out": True}
    assert other.get("/api/ui/paired").json()["paired"] is False and client.get("/api/ui/paired").json()["paired"]
    assert not [n for n in notices.open_notices(CORPUS) if n["key"] == f"sign-in:{theirs}"], "its notice went"
    assert client.post("/api/ui/signout", json={"id": theirs}).json() == {"signed_out": False}
    assert client.post("/api/ui/signout", json={"id": ""}).json() == {"signed_out": False}

    assert client.post("/api/ui/unpair").status_code == 401, "a signed-in page cannot sign every browser out"
    assert client.post("/api/ui/unpair", headers=plugin_headers()).status_code == 204
    assert client.get("/api/ui/paired").json() == {"paired": False, "id": ""}
    assert not (hook_auth.home() / hook_auth.PAIRED_FILE).exists()
    # the key went with the cookie: a new sign-in gets a new key, and the old key's path does not count its cookie
    cookie = client.cookies.get(hook_auth.ui_cookie(), path=hook_auth.browser_path(mine_key))
    r, _ = _claim(hook_auth.mint())
    new_cookie, new_key = _signed(r)
    assert new_key != mine_key
    assert _claim("x", cookie, mine_key)[0].status_code == 410, "the old key and cookie are void"
    assert _claim("x", new_cookie, mine_key)[0].status_code == 410, "a new cookie on the old key's path counts nothing"
    assert _claim("x", new_cookie, new_key)[0].status_code == 204


def test_a_new_sign_in_shows_a_notice_in_the_named_and_the_attached_workspace_and_a_line_in_main_s_terminal(
        client, monkeypatch, tmp_path):
    from app import config

    other_corpus = config.DATA_DIR / "other"
    if not other_corpus.exists():
        import shutil

        shutil.copytree(config.DATA_DIR / CORPUS, tmp_path / "data" / "other")
        shutil.copytree(config.DATA_DIR / CORPUS, tmp_path / "data" / CORPUS)
        monkeypatch.setattr(config, "DATA_DIR", (tmp_path / "data").resolve())
    session.attach(CORPUS, SID, "/data/mini")
    sign_in(client, hook_auth.mint("other"), "other")
    browser = client.get("/api/ui/paired").json()["id"]
    for c in ("other", CORPUS):
        [n] = [n for n in notices.open_notices(c) if n["key"] == f"sign-in:{browser}"]
        assert n["kind"] == "sign-in" and n["action"] == {"label": "Sign it out", "do": "sign-out", "slug": browser}
        assert re.fullmatch(r"A browser signed in to thimble at \d\d:\d\d\. If it was not you, click Sign it out, or "
                            r"run `thimble unpair` in a shell to sign out every browser\.", n["text"]), n["text"]
    line = (hook_auth.home() / "links" / SID).read_text()
    assert re.fullmatch(r"\nthimble: a browser signed in to thimble at \d\d:\d\d\. If it was not you, run "
                        r"`thimble unpair` in a shell\.", line), line
    assert not (hook_auth.home() / "links" / "other").exists()
    another = TestClient(client.app, base_url="http://testserver")
    r = another.post("/api/ui/key", json={"code": hook_auth.mint(), "ws": "no-such-workspace"})
    assert r.status_code == 200, "a link of no registered workspace still signs in, and tells the attached main"
    assert line != (hook_auth.home() / "links" / SID).read_text()


@pytest.mark.real_read_guard
def test_a_browser_reads_nothing_until_it_signs_in_and_nothing_after_unpair(client, plugin_headers):
    """hook_auth.LocalReadGuard: a browser without the cookie reads no data (401 and the body that tells the page to
    show its sign-in line; a HEAD with no body), only whether it is signed in and the health check, and reads once it
    traded its link's code; `thimble unpair` takes that back, while the CLI's proof still reads."""
    refused = {"detail": hook_auth.SIGN_IN_NEEDED, "signin": True}
    r = client.get(f"/api/ws/{CORPUS}/canvas")
    assert (r.status_code, r.json()) == (401, refused)
    head = client.head("/api/corpora")
    assert (head.status_code, head.content, head.headers.get("content-length")) == (401, b"", "0")
    assert client.get("/api/ui/paired").json() == {"paired": False, "id": ""}
    assert set(client.get("/api/health").json()) == {"ok", "boot", "ui"}, "no path or pid without the token"
    sign_in(client, hook_auth.mint(CORPUS))
    assert client.get("/api/corpora").status_code == 200
    assert client.get(f"/api/ws/{CORPUS}/canvas").status_code == 200
    assert client.post("/api/ui/unpair", headers=plugin_headers()).status_code == 204
    r = client.get("/api/corpora")
    assert (r.status_code, r.json()) == (401, refused)
    assert client.get("/api/corpora", headers=plugin_headers()).status_code == 200


@pytest.mark.real_read_guard
@pytest.mark.real_write_guard
def test_a_cookie_counts_only_under_the_path_of_the_key_it_was_given_with(client):
    """hook_auth.BrowserPath and _cookie_hash: a signed-in browser's cookie counts on a request under /b/<its key>/api/
    alone. Sent to the API's own path (as a browser sends a cookie scoped to /api/ to the page of any server on
    127.0.0.1 that asks for its own /api/ paths), under another browser's key, or under a key no browser holds, it reads
    nothing, writes nothing, and the paired route says it is not signed in."""
    first = TestClient(client.app, base_url="http://testserver")
    key = sign_in(first, hook_auth.mint(CORPUS))
    other_key = sign_in(TestClient(client.app, base_url="http://testserver"), hook_auth.mint("other"))
    cookie = first.cookies.get(hook_auth.ui_cookie(), path=hook_auth.browser_path(key))
    assert cookie and key != other_key
    assert first.get("/api/ui/paired").json()["paired"] is True
    assert first.get("http://testserver/api/ui/paired").json()["paired"] is False, \
        "a cookie jar sends the cookie under its key's path alone"
    page = TestClient(client.app, base_url="http://testserver")
    page.cookies.set(hook_auth.ui_cookie(), cookie)  # sent on every path, so each check below is the server's
    refused = {"detail": hook_auth.SIGN_IN_NEEDED, "signin": True}
    for base in ("", f"/b/{other_key}", "/b/no-browser-holds-this-key", f"/b/{key}x"):
        assert page.get(f"{base}/api/ui/paired").json() == {"paired": False, "id": ""}, base
        r = page.get(f"{base}/api/corpora")
        assert (r.status_code, r.json()) == (401, refused), base
        r = page.post(f"{base}/api/ui/signout", json={"id": ""})
        assert (r.status_code, r.json()) == (403, {"detail": hook_auth.WRITE_REFUSED}), base
    assert page.get(f"/b/{key}/api/ui/paired").json()["paired"] is True
    assert page.get(f"/b/{key}/api/corpora").status_code == 200
    assert page.post(f"/b/{key}/api/ui/signout", json={"id": ""}).json() == {"signed_out": False}


def test_a_browser_an_earlier_build_signed_in_signs_in_again():
    """An entry of paired.json without a key's sha256 (an earlier build's, whose cookie was scoped to /api/) signs no
    browser in, and goes at the next sign-in; the page of that browser holds no key, so it shows its sign-in line, and
    the link signs it in."""
    path = hook_auth.home() / hook_auth.PAIRED_FILE
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps([{"hash": hook_auth._sha("an-earlier-cookie"), "at": "2026-10-01T00:00:00+00:00"}]))
    assert hook_auth._entries() == []
    assert _gone(_claim("x", "an-earlier-cookie")[0])
    r, _ = _claim(hook_auth.mint())
    assert r.status_code == 200
    [entry] = json.loads(path.read_text())
    assert set(entry) == {"hash", "key", "at"} and entry["hash"] == hook_auth._sha(_cookie_of(r))


def test_browser_path_hands_on_the_api_path_with_the_key_in_the_request_s_state():
    """hook_auth.BrowserPath, outermost: /b/<key>/api/... goes on as /api/..., its raw path too, with the key in the
    state (path_key); a path that is not under a key's /api, or whose key is not one the server could have made, goes
    on as it came, with no key."""
    import asyncio

    seen: list[dict] = []

    async def app(scope, receive, send):
        seen.append(scope)

    def through(path: str, kind: str = "http") -> dict:
        seen.clear()
        asyncio.run(hook_auth.BrowserPath(app)({"type": kind, "path": path, "raw_path": path.encode(),
                                                "state": {"x": 1}}, None, None))
        return seen[0]

    key = "Ab3_-" * 6
    s = through(f"/b/{key}/api/ws/mini/canvas")
    assert (s["path"], s["raw_path"], hook_auth.path_key(s), s["state"]["x"]) == (
        "/api/ws/mini/canvas", b"/api/ws/mini/canvas", key, 1)
    assert through(f"/b/{key}/api")["path"] == "/api" and hook_auth.path_key(through(f"/b/{key}/api"))
    assert hook_auth.path_key(through(f"/b/{key}/api/agent/claude", "websocket")) == key
    for path in ("/api/corpora", f"/b/{key}/apix", f"/b/{key}/", "/b/short/api/corpora", f"/b/{key}/b/{key}/api/x",
                 f"/x/b/{key}/api/corpora"):
        s = through(path)
        assert s["path"] == path and hook_auth.path_key(s) == "", path


def test_the_server_log_shows_a_browser_s_key_as_key():
    """uvicorn's access line names the path of every write and every failed request, and the server log goes into a
    problem report: a browser's key in it shows as `<key>` (main.HideMediaKeys, hook_auth.hide_media_keys)."""
    import logging

    key = "Ab3_-" * 6
    record = logging.LogRecord("uvicorn.access", logging.INFO, __file__, 1, '%s - "%s %s HTTP/%s" %d',
                               ("127.0.0.1:5", "POST", f"/b/{key}/api/ws/mini/events?x=1", "1.1", 403), None)
    assert main.HideMediaKeys().filter(record)
    line = record.getMessage()
    assert key not in line and '"POST /b/<key>/api/ws/mini/events?x=1 HTTP/1.1" 403' in line, line
    from app import feedback

    text, n = feedback.redact(f'INFO: 127.0.0.1:5 - "POST /b/{key}/api/ws/mini/events HTTP/1.1" 403')
    assert n == 1 and key not in text and "/b/[redacted:browser-key]/api/ws/mini/events" in text, text
