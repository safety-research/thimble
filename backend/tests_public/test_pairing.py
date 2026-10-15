"""Signing a browser in to thimble (hook_auth: mint, claim, the signed-in browsers; main: the /api/ui routes and
signed_in). The dashboard link carries a one-time code after `#p=`, made when the link is shown; the page trades it for
a cookie, and the server keeps only the sha256 of each code and each cookie, so no file, transcript or link holds a
credential that lasts. Each new sign-in shows twice: a notice with Sign it out, and a line under main's next reply."""
from __future__ import annotations

import importlib
import json
import re

import pytest
from fastapi.testclient import TestClient

from app import hook_auth, main, notices, session

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


def _claim(code: object, cookie: str | None = None):
    from starlette.requests import Request

    headers = [(b"cookie", f"{hook_auth.ui_cookie()}={cookie}".encode())] if cookie else []
    return hook_auth.claim({"code": code}, Request({"type": "http", "headers": headers}))


def _cookie_of(r) -> str:
    [value] = [v.decode().split(";", 1)[0].split("=", 1)[1] for k, v in r.raw_headers if k == b"set-cookie"]
    return value


def _gone(r) -> bool:
    return r.status_code == 410 and json.loads(r.body) == {"detail": hook_auth.CODE_GONE}


def test_a_code_works_once():
    code = hook_auth.mint(CORPUS)
    r, browser = _claim(code)
    assert r.status_code == 204 and re.fullmatch(r"[0-9a-f]{12}", browser)
    cookie = _cookie_of(r)
    assert len(cookie) >= 40, "a random cookie of 32 bytes"
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
        assert _claim(code)[0].status_code == 204, "codes for other workspaces stay alive"


def test_a_restart_voids_every_code_but_keeps_the_signed_in_browsers():
    code = hook_auth.mint(CORPUS)
    r, _ = _claim(hook_auth.mint("other"))
    cookie = _cookie_of(r)
    importlib.reload(hook_auth)  # a new server process
    try:
        assert _gone(_claim(code)[0]), "codes live in memory alone"
        assert _claim("x", cookie)[0].status_code == 204, "the browser is still signed in (paired.json)"
    finally:
        hook_auth._codes.clear()
        hook_auth._paired = None


def test_every_workspace_s_code_stays_alive_and_no_sign_in_signs_another_browser_out():
    """No count limits the live codes or the signed-in browsers: a code goes only when it is spent, expires or a newer
    one for its workspace is made, and a browser is signed out only by Sign it out or `thimble unpair`."""
    codes = [hook_auth.mint(f"ws{i}") for i in range(40)]
    assert len(hook_auth._codes) == 40
    cookies = [_cookie_of(_claim(c)[0]) for c in codes]
    assert len(hook_auth._entries()) == 40
    assert all(_claim("x", cookie)[0].status_code == 204 for cookie in cookies), "the first browser is still signed in"


def test_a_signed_in_browser_spends_a_code_with_no_cookie_no_entry_and_no_notice(client):
    from conftest import UI_COOKIE_VALUE, _record_paired

    _record_paired(UI_COOKIE_VALUE)
    code = hook_auth.mint(CORPUS)
    client.cookies.set(hook_auth.ui_cookie(), UI_COOKIE_VALUE)
    r = client.post("/api/ui/key", json={"code": code, "ws": CORPUS})
    assert r.status_code == 204 and "set-cookie" not in r.headers
    assert len(hook_auth._entries()) == 1 and notices.open_notices(CORPUS) == []
    assert _gone(_claim(code)[0]), "spent"
    assert client.post("/api/ui/key", json={"code": "old", "ws": CORPUS}).status_code == 204, \
        "a signed-in page that loads with an old code is not refused"


def test_paired_json_holds_only_hashes_readable_by_its_owner(tmp_path):
    r, browser = _claim(hook_auth.mint())
    cookie = _cookie_of(r)
    path = hook_auth.home() / hook_auth.PAIRED_FILE
    text = path.read_text()
    assert cookie not in text and browser in text
    [entry] = json.loads(text)
    assert set(entry) == {"hash", "at"} and re.fullmatch(r"[0-9a-f]{64}", entry["hash"])
    assert path.stat().st_mode & 0o077 == 0


def test_an_edit_of_paired_json_while_the_server_runs_signs_nobody_in():
    _claim(hook_auth.mint())
    path = hook_auth.home() / hook_auth.PAIRED_FILE
    planted = "planted-cookie"
    entries = json.loads(path.read_text()) + [{"hash": hook_auth._sha(planted), "at": "now"}]
    path.write_text(json.dumps(entries))
    assert _claim("x", planted)[0].status_code == 410, "read at start, then kept in memory"


def test_an_old_key_body_gets_410(client):
    for body in ({"key": "the-old-ui-key"}, {}, {"code": 7}, {"code": ""}, {"code": "never-made"}):
        r = client.post("/api/ui/key", json=body)
        assert r.status_code == 410 and r.json() == {"detail": hook_auth.CODE_GONE}, body
        assert "set-cookie" not in r.headers


@pytest.mark.real_write_guard
def test_the_paired_route_says_whether_this_browser_is_signed_in_and_its_id(client):
    assert client.get("/api/ui/paired").json() == {"paired": False, "id": ""}
    r = client.post("/api/ui/key", json={"code": hook_auth.mint()})
    browser = hook_auth._entries()[0]["hash"][:12]
    assert r.status_code == 204
    assert client.get("/api/ui/paired").json() == {"paired": True, "id": browser}
    client.cookies.set(hook_auth.ui_cookie(), "not-signed-in")
    assert client.get("/api/ui/paired").json() == {"paired": False, "id": ""}


@pytest.mark.real_write_guard
def test_the_pair_route_needs_the_token_and_gives_a_code_for_five_minutes(client, plugin_headers):
    assert client.post("/api/ui/pair", json={"ws": CORPUS}).status_code == 401, "a page or a kernel gets none"
    r = client.post("/api/ui/pair", json={"ws": CORPUS}, headers=plugin_headers())
    assert r.status_code == 200 and r.json()["expires_s"] == 300 and r.json()["code"]
    assert client.post("/api/ui/key", json={"code": r.json()["code"], "ws": CORPUS}).status_code == 204
    r = client.post("/api/ui/pair", headers=plugin_headers())
    assert r.status_code == 200 and r.json()["code"], "the start page's code, with no body"


@pytest.mark.real_write_guard
def test_unpair_with_the_token_signs_every_browser_out_and_signout_with_a_cookie_signs_one_out(client, plugin_headers):
    other = TestClient(client.app, base_url="http://testserver")
    assert client.post("/api/ui/key", json={"code": hook_auth.mint()}).status_code == 204
    assert other.post("/api/ui/key", json={"code": hook_auth.mint("other")}).status_code == 204
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
    r = client.post("/api/ui/key", json={"code": hook_auth.mint("other"), "ws": "other"})
    assert r.status_code == 204
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
    assert r.status_code == 204, "a link of no registered workspace still signs in, and tells the attached main"
    assert line != (hook_auth.home() / "links" / SID).read_text()
