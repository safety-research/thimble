"""Signing a browser in to thimble (hook_auth: mint, claim, the signed-in browsers; main: the /api/ui routes and
signed_in). The page opens on a one-time code after `#p=`, made when the page is opened (`thimble open`: 60 s) or a
link is shown (300 s); the page trades it for a cookie and a key, and the server keeps only the sha256 of each code,
cookie and key, so no file, transcript or link holds a credential that lasts. The cookie is scoped to the path of that
browser's key, /b/<key>/api/, counts only there, lasts 30 days and is renewed by each signed request. Each new sign-in
shows twice: a notice with Sign it out, and a line under main's next reply. A stale tab asks /api/hello before it sends
its cookie again, and a claim from another account's connection is refused."""
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
    """The Set-Cookie headers of a route's own answer (starlette) or of a TestClient's (httpx)."""
    if hasattr(r, "raw_headers"):
        return [v.decode() for k, v in r.raw_headers if k == b"set-cookie"]
    return r.headers.get_list("set-cookie")


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


def _renewal(cookie: str, key: str) -> str:
    """The Set-Cookie a signed request's answer carries: the same cookie on its key's path for 30 days."""
    return (f"{hook_auth.ui_cookie()}={cookie}; HttpOnly; Max-Age=2592000; Path=/b/{key}/api/; SameSite=strict")


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
    # 0.9.0: no `thimble up` link; the way to a new code is /thimble open or the panel's o
    assert hook_auth.CODE_GONE == ("This sign-in link was already used or has expired. Type `/thimble open` in your"
                                   " Claude Code terminal for a new one, or press o in thimble's panel.")


def test_a_code_expires_and_a_newer_code_for_the_workspace_leaves_it_ten_seconds(monkeypatch):
    """0.9.0: a newer code of the same workspace no longer voids the older one at once, but leaves it OVERLAP_S (10 s),
    so a double press (the mod's and the hook's) keeps both tabs signed in."""
    now = [1000.0]
    monkeypatch.setattr(hook_auth, "_now", lambda: now[0])
    old = hook_auth.mint(CORPUS)
    now[0] += hook_auth.PAIR_TTL_S + 1
    assert _gone(_claim(old)[0]), "older than PAIR_TTL_S"
    assert (hook_auth.PAIR_TTL_S, hook_auth.LINK_TTL_S, hook_auth.PRESS_TTL_S, hook_auth.OVERLAP_S) == (300, 300, 60, 10)
    first = hook_auth.mint(CORPUS)
    start = hook_auth.mint("")
    other = hook_auth.mint("other")
    newer = hook_auth.mint(CORPUS)
    now[0] += 9
    for code in (first, start, other, newer):
        assert _claim(code)[0].status_code == 200, "within 10 s every code works, the older of the workspace too"
    first = hook_auth.mint(CORPUS)
    newer = hook_auth.mint(CORPUS)
    now[0] += hook_auth.OVERLAP_S + 1
    assert _gone(_claim(first)[0]), "10 s after the newer code the older is void"
    assert _claim(newer)[0].status_code == 200


def test_a_press_code_lasts_sixty_seconds_and_a_link_code_three_hundred(monkeypatch):
    now = [1000.0]
    monkeypatch.setattr(hook_auth, "_now", lambda: now[0])
    press = hook_auth.mint(CORPUS, hook_auth.PRESS_TTL_S)
    link = hook_auth.mint("other", hook_auth.LINK_TTL_S)
    odd = hook_auth.mint("third", 5)  # any other ttl is a link's
    now[0] += 61
    assert _gone(_claim(press)[0]), "a press's code is void after 60 s"
    assert _claim(link)[0].status_code == 200 and _claim(odd)[0].status_code == 200
    late = hook_auth.mint("fourth", hook_auth.LINK_TTL_S)
    now[0] += 301
    assert _gone(_claim(late)[0]), "a link's code is void after 300 s"


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
    # 0.9.0: a signed request renews the browser's own cookie (SlidingCookie), and the claim gives it nothing new
    assert r.status_code == 204 and _set_cookies(r) == [_renewal(UI_COOKIE_VALUE, "key-of-the-test-browser")]
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
    # 0.9.0: `used`, the last use, for the 30-day cap
    assert set(entry) == {"hash", "key", "at", "used"} and re.fullmatch(r"[0-9a-f]{64}", entry["hash"])
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
        # 0.9.0: the notice `signin:new` (one per browser) with the spec's words
        [n] = [n for n in notices.open_notices(c) if n["key"] == f"signin:new:{browser}"]
        assert n["kind"] == "sign-in" and n["action"] == {"label": "Sign it out", "do": "sign-out", "slug": browser}
        assert re.fullmatch(r"A browser signed in to thimble's page at \d\d:\d\d\.", n["text"]), n["text"]
    line = (hook_auth.home() / "links" / SID).read_text()
    assert re.fullmatch(r"\nthimble: a browser signed in to thimble's page at \d\d:\d\d\. If it was not you, run "
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
    assert set(entry) == {"hash", "key", "at", "used"} and entry["hash"] == hook_auth._sha(_cookie_of(r))


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


def test_a_signed_request_renews_the_cookie_for_thirty_days_and_notes_the_browser_s_use(client, monkeypatch):
    """hook_auth.SlidingCookie: each request a signed-in browser makes under its key's path is answered with its cookie
    again for 30 days, and its `used` is written at most once an hour; a request without a valid cookie gets none."""
    from conftest import UI_COOKIE_VALUE, UI_KEY_VALUE, _record_paired, browser_base

    assert hook_auth.UI_COOKIE_AGE_S == 30 * 24 * 3600
    _record_paired(UI_COOKIE_VALUE)
    page = TestClient(client.app, base_url=browser_base())
    page.cookies.set(hook_auth.ui_cookie(), UI_COOKIE_VALUE)
    r = page.get("/api/ui/paired")
    assert r.json()["paired"] is True and _set_cookies(r) == [_renewal(UI_COOKIE_VALUE, UI_KEY_VALUE)]
    stranger = TestClient(client.app, base_url=browser_base())
    stranger.cookies.set(hook_auth.ui_cookie(), "not-a-signed-in-cookie")
    assert _set_cookies(stranger.get("/api/ui/paired")) == [], "no cookie for one that is not signed in"
    assert _set_cookies(client.get("/api/ui/paired")) == [], "none on the API's own path"
    # the last use: written when older than an hour, and not on every request
    path = hook_auth.home() / hook_auth.PAIRED_FILE
    from datetime import datetime, timedelta, timezone

    two_hours_ago = (datetime.now(timezone.utc) - timedelta(hours=2)).isoformat(timespec="seconds")
    entries = json.loads(path.read_text())
    entries[0]["used"] = two_hours_ago
    path.write_text(json.dumps(entries))
    hook_auth._paired = None
    page.get("/api/ui/paired")
    used = json.loads(path.read_text())[0]["used"]
    assert used > two_hours_ago and hook_auth._fresh(json.loads(path.read_text())[0])
    before = path.stat().st_mtime_ns
    page.get("/api/ui/paired")
    assert path.stat().st_mtime_ns == before, "not written again within the hour"


def test_a_browser_unused_for_thirty_days_is_signed_out_and_an_old_entry_counts_from_now(monkeypatch):
    """Paired entries are capped at 30 days from their last use; an entry an earlier version wrote, with no `used`,
    gets one when this version first reads it, written to paired.json, so its 30 days run from then."""
    import time as _time

    real_time = _time.time
    r, _ = _claim(hook_auth.mint())
    cookie, key = _signed(r)
    path = hook_auth.home() / hook_auth.PAIRED_FILE
    [entry] = json.loads(path.read_text())
    assert _claim("x", cookie, key)[0].status_code == 204
    entry["used"] = "2026-01-01T00:00:00+00:00"
    path.write_text(json.dumps([entry]))
    hook_auth._paired = None
    monkeypatch.setattr(_time, "time", lambda: hook_auth._seconds("2026-02-01T00:00:00+00:00"))
    assert _gone(_claim("x", cookie, key)[0]), "31 days unused: signed out"
    monkeypatch.setattr(_time, "time", lambda: hook_auth._seconds("2026-01-30T00:00:00+00:00"))
    assert _claim("x", cookie, key)[0].status_code == 204, "29 days: still signed in"
    monkeypatch.setattr(_time, "time", real_time)
    old = {"hash": entry["hash"], "key": entry["key"], "at": "2025-01-01T00:00:00+00:00"}
    path.write_text(json.dumps([old]))
    hook_auth._paired = None
    assert _claim("x", cookie, key)[0].status_code == 204, "an earlier version's entry counts from now"
    assert json.loads(path.read_text())[0]["used"] > "2026", "its first read here wrote its `used`"


def test_the_claim_of_an_open_s_code_deletes_its_redirect_file_and_writes_the_claim_mark(client):
    """app/opener.py: `thimble open` mints its code with the id of its redirect file (the pair route's `open`); the
    claim deletes that file and writes <home>/open/<id>.claimed, which the terminal watches. A code with no open id, or
    a claim that fails, writes nothing."""
    from app import opener

    oid = opener.new_id()
    page = opener.write_redirect("http://127.0.0.1:8300/?ws=mini#p=x", oid)
    code = hook_auth.mint(CORPUS, hook_auth.PRESS_TTL_S, oid)
    assert hook_auth.code_open(code) == oid and page.exists()
    r = client.post("/api/ui/key", json={"code": code, "ws": CORPUS})
    assert r.status_code == 200 and r.json()["port"] == 80, "the port the server listens on, for the challenge"
    assert not page.exists() and opener.claim_path(oid).exists()
    assert opener.claim_path(oid).stat().st_mode & 0o777 == 0o600
    assert hook_auth.code_open(code) == "", "spent"
    other = opener.new_id()
    plain = TestClient(client.app, base_url="http://testserver")
    assert plain.post("/api/ui/key", json={"code": "never-made", "ws": CORPUS}).status_code == 410
    assert not opener.claim_path(other).exists()


@pytest.mark.real_write_guard
def test_the_pair_route_gives_a_press_sixty_seconds_and_names_its_open(client, plugin_headers):
    r = client.post("/api/ui/pair", json={"ws": CORPUS, "ttl": 60, "open": "abcdefgh12345678"}, headers=plugin_headers())
    assert r.status_code == 200 and r.json()["expires_s"] == 60
    assert hook_auth.code_open(r.json()["code"]) == "abcdefgh12345678"
    r = client.post("/api/ui/pair", json={"ws": CORPUS, "ttl": 9999}, headers=plugin_headers())
    assert r.json()["expires_s"] == 300, "any other ttl is a link's"


@pytest.mark.real_write_guard
def test_unpair_with_a_browser_id_signs_out_that_browser_alone(client, plugin_headers):
    """A sign-in notice's Sign it out in the terminal: `thimble unpair` for one browser (the token route with its id)."""
    other = TestClient(client.app, base_url="http://testserver")
    sign_in(client, hook_auth.mint())
    sign_in(other, hook_auth.mint("other"))
    theirs = other.get("/api/ui/paired").json()["id"]
    assert client.post("/api/ui/unpair", json={"browser": theirs}, headers=plugin_headers()).status_code == 204
    assert other.get("/api/ui/paired").json()["paired"] is False
    assert client.get("/api/ui/paired").json()["paired"] is True


def _hello_answer(key: str, port: int, nonce: str) -> str:
    """What the page computes and expects (frontend lib/stale): HMAC-SHA256 under sha256(key) (hex) of
    "hello:<port>:<nonce>"."""
    import hashlib
    import hmac

    kh = hashlib.sha256(key.encode()).hexdigest()
    return hmac.new(kh.encode(), f"hello:{port}:{nonce}".encode(), hashlib.sha256).hexdigest()


@pytest.mark.real_read_guard
def test_hello_answers_a_signed_in_key_s_challenge_with_no_credential_and_nothing_else(client):
    """/api/hello: open (no cookie, no key in the path), answers HMAC(sha256(key), "hello:<port>:<nonce>") for the
    browser whose key id it names; 404 for an unknown id or no nonce; the answer is bound to the port the server
    listens on, so a relay to a server on another port gets an answer the page refuses."""
    import hashlib

    r, _ = _claim(hook_auth.mint())
    _, key = _signed(r)
    kid = hashlib.sha256(hashlib.sha256(key.encode()).hexdigest().encode()).hexdigest()[:16]
    bare = TestClient(client.app, base_url="http://testserver")
    got = bare.get(f"/api/hello?n=abc123&k={kid}")
    assert got.status_code == 200 and got.json() == {"mac": _hello_answer(key, 80, "abc123")}
    assert got.headers["cache-control"] == "no-store" and "set-cookie" not in got.headers
    assert got.json()["mac"] != _hello_answer(key, 8301, "abc123"), "bound to the port"
    assert bare.get("/api/hello?n=abc123&k=0000000000000000").status_code == 404
    assert bare.get(f"/api/hello?k={kid}").status_code == 404
    assert bare.get(f"/api/hello?n={'x' * 200}&k={kid}").status_code == 404
    hook_auth.unpair()
    assert bare.get(f"/api/hello?n=abc123&k={kid}").status_code == 404, "a signed-out browser gets no answer"


def test_peer_uid_reads_the_owner_of_a_live_loopback_connection():
    """hook_auth.peer_uid on Linux: the account that owns the client end of a real 127.0.0.1 connection is this one."""
    import os
    import socket
    import sys

    if not sys.platform.startswith("linux"):
        pytest.skip("peer_uid reads /proc/net/tcp")
    srv = socket.socket()
    srv.bind(("127.0.0.1", 0))
    srv.listen(1)
    cli = socket.create_connection(srv.getsockname())
    conn, _ = srv.accept()
    try:
        scope = {"client": cli.getsockname(), "server": srv.getsockname()}
        assert hook_auth.peer_uid(scope) == os.getuid()
        assert hook_auth.same_user(scope)
        assert hook_auth.peer_uid({"client": ("127.0.0.1", 1), "server": srv.getsockname()}) is None
        assert hook_auth.peer_uid({}) is None
    finally:
        for s in (conn, cli, srv):
            s.close()


def _proc_tables(tmp_path, uid: int, client_port: int, server_port: int, v6: bool = False):
    """A /proc/net with one TCP line: the client end 127.0.0.1:<client_port> -> 127.0.0.1:<server_port> owned by
    `uid` (IPv4-mapped in tcp6 with `v6`)."""
    def v4(port):
        return f"0100007F:{port:04X}"

    def mapped(port):
        return f"0000000000000000FFFF00000100007F:{port:04X}"

    head = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n"
    addr = mapped if v6 else v4
    line = f"   0: {addr(client_port)} {addr(server_port)} 01 00000000:00000000 00:00000000 00000000  {uid}        0 1\n"
    (tmp_path / "tcp").write_text(head + ("" if v6 else line))
    (tmp_path / "tcp6").write_text(head + (line if v6 else ""))
    return tmp_path


@pytest.mark.parametrize("v6", [False, True])
def test_a_claim_from_another_account_s_connection_is_refused_and_its_code_kept(client, monkeypatch, tmp_path, v6):
    """Same user only: the claim route refuses a claim whose connection another account owns (403 OTHER_USER), before
    the code is spent; the analyst's own connection, or one whose owner cannot be read, claims as before."""
    import os
    import sys

    if sys.byteorder != "little":
        pytest.skip("the table below is written for a little-endian machine")
    monkeypatch.setattr(hook_auth, "PROC_NET", _proc_tables(tmp_path, os.getuid() + 1, 50000, 8300, v6))
    monkeypatch.setattr(hook_auth.sys, "platform", "linux")
    code = hook_auth.mint(CORPUS)
    scope = {"type": "http", "client": ("127.0.0.1", 50000), "server": ("127.0.0.1", 8300), "headers": []}
    assert hook_auth.peer_uid(scope) == os.getuid() + 1 and not hook_auth.same_user(scope)
    from starlette.requests import Request

    def route(scope):
        [r] = [r for r in client.app.routes if getattr(r, "path", "") == "/api/ui/key"]
        return r.endpoint(Request(scope), {"code": code, "ws": CORPUS})

    refused = route(scope)
    assert refused.status_code == 403 and json.loads(refused.body) == {"detail": hook_auth.OTHER_USER}
    assert hook_auth.code_open(code) == "" and code and _sha_alive(code), "the code was not spent"
    monkeypatch.setattr(hook_auth, "PROC_NET", _proc_tables(tmp_path, os.getuid(), 50000, 8300, v6))
    assert route(scope).status_code == 200, "the analyst's own connection signs in"


def _sha_alive(code: str) -> bool:
    return hook_auth._sha(code) in hook_auth._codes


def test_a_claim_through_a_tunnel_host_and_port_signs_in(client):
    """An SSH forward on another local port (ssh -L 9000:127.0.0.1:<port>): the page is on localhost:9000, its claim
    carries Host and Origin localhost:9000, and it signs in."""
    tunnel = TestClient(client.app, base_url="http://localhost:9000")
    r = tunnel.post("/api/ui/key", json={"code": hook_auth.mint(CORPUS), "ws": CORPUS},
                    headers={"origin": "http://localhost:9000"})
    assert r.status_code == 200 and r.json()["key"]


def test_an_event_stream_ends_with_stopping_when_the_server_stops_for_good_and_not_for_a_restart(monkeypatch):
    """main.CompleteStreams: an event stream cut by the server's stop gets `event: stopping` as its last message, which
    stops the page (frontend lib/stale); a restart (the kernel hand-off names this server) ends it empty, so the page
    reconnects. Any other response gets an empty last message."""
    import asyncio
    import os

    from app import cli

    monkeypatch.setattr(session, "_shutting_down", lambda: True)

    async def stream(scope, receive, send):
        await send({"type": "http.response.start", "status": 200,
                    "headers": [(b"content-type", b"text/event-stream; charset=utf-8")]})
        await send({"type": "http.response.body", "body": b": open\n\n", "more_body": True})

    async def page(scope, receive, send):
        await send({"type": "http.response.start", "status": 200, "headers": [(b"content-type", b"text/html")]})
        await send({"type": "http.response.body", "body": b"<p>", "more_body": True})

    def last(app) -> bytes:
        sent: list[dict] = []

        async def send(m):
            sent.append(m)

        asyncio.run(main.CompleteStreams(app)({"type": "http"}, None, send))
        return sent[-1]["body"]

    monkeypatch.setattr(cli, "kernel_handoff", lambda: None)
    assert last(stream) == b"event: stopping\ndata: {}\n\n"
    assert last(page) == b""
    monkeypatch.setattr(cli, "kernel_handoff", lambda: os.getpid())
    assert last(stream) == b"", "a restart: the page reconnects"


def test_session_ended_tells_the_workspace_s_pages(client):
    """main.session_ended: `session-ended` on the workspace's stream, which stops its pages."""
    import asyncio

    from app import investigation

    async def run():
        main.session_ended(CORPUS, SID)

    asyncio.run(run())
    recs = [json.loads(line) for line in (investigation._existing(CORPUS, investigation.MAIN) / "events.jsonl")
            .read_text().splitlines() if line.strip()]
    assert {"type": "session-ended", "session": SID}.items() <= recs[-1].items()
