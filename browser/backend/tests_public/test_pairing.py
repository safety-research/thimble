"""Signing a browser in to thimble (hook_auth: link_key, claim, the signed-in browsers; main: the /api/ui routes and
signed_in). The dashboard link carries the install's sign-in key after `#p=`, the same every time and good in any
browser until `thimble unpair` changes it; the page trades it for a cookie and a key, and the server keeps only the
sha256 of each cookie and key. The cookie is scoped to the path of that browser's key, /b/<key>/api/, and counts only
there. Each new sign-in shows twice: a notice with Sign it out, and a line under main's next reply."""
from __future__ import annotations

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


@pytest.mark.real_read_guard
def test_a_browser_reads_once_it_signs_in_with_its_link_s_key_and_nothing_after_unpair(client, plugin_headers):
    """hook_auth.LocalReadGuard: a browser without the cookie reads no data (401 and the body that tells the page to
    show its sign-in line), only whether it is signed in and the health check; it reads once it traded its link's
    key, which signs in another browser too; `thimble unpair` takes both back and changes the key, so the old link
    signs no browser in and the new one does, while the CLI's proof still reads."""
    refused = {"detail": hook_auth.SIGN_IN_NEEDED, "signin": True}
    r = client.get(f"/api/ws/{CORPUS}/canvas")
    assert (r.status_code, r.json()) == (401, refused)
    assert client.get("/api/ui/paired").json() == {"paired": False, "id": "", "at": ""}
    assert set(client.get("/api/health").json()) == {"ok", "boot", "ui"}, "no path or pid without the token"
    code = client.post("/api/ui/pair", headers=plugin_headers()).json()["code"]
    assert code == hook_auth.link_key() == client.post("/api/ui/pair", headers=plugin_headers()).json()["code"], \
        "the same link every time"
    sign_in(client, code)
    assert client.get("/api/ui/paired").json()["paired"] is True
    assert client.get("/api/corpora").status_code == 200
    assert client.get(f"/api/ws/{CORPUS}/canvas").status_code == 200
    other = TestClient(client.app, base_url="http://testserver")
    sign_in(other, code)
    assert other.get("/api/corpora").status_code == 200, "the link signs in another browser too"
    assert client.post("/api/ui/unpair", headers=plugin_headers()).status_code == 204
    for browser in (client, other):
        r = browser.get("/api/corpora")
        assert (r.status_code, r.json()) == (401, refused)
    assert client.get("/api/corpora", headers=plugin_headers()).status_code == 200
    third = TestClient(client.app, base_url="http://testserver")
    old = third.post("/api/ui/key", json={"code": code})
    assert (old.status_code, old.json()) == (410, {"detail": hook_auth.CODE_GONE}), "unpair ends the old link"
    new = hook_auth.link_key()
    assert new and new != code
    sign_in(third, new)
    assert third.get("/api/corpora").status_code == 200


def test_the_link_s_key_is_kept_for_its_owner_alone_and_changed_in_place():
    """<home>/link.key is made once, readable by its owner alone, and hidden from every session thimble starts;
    unpair writes a new key into the same file (its inode stays), so a sandbox that hides the file keeps hiding it."""
    from app import runtime, userconf

    key = hook_auth.link_key()
    path = hook_auth.home() / hook_auth.LINK_KEY
    assert path.read_text("utf-8") == key and (path.stat().st_mode & 0o777) == 0o600
    assert hook_auth.LINK_KEY in runtime.PRIVATE_FILES and str(path) in userconf.private_paths()
    inode = path.stat().st_ino
    hook_auth.unpair()
    assert hook_auth.link_key() != key and path.stat().st_ino == inode
    assert (path.stat().st_mode & 0o777) == 0o600


@pytest.mark.real_read_guard
@pytest.mark.real_write_guard
def test_a_new_sign_in_shows_a_notice_whose_sign_it_out_signs_that_browser_out(client):
    """Each new sign-in shows a notice with Sign it out in the workspace; Sign it out, a click of a signed-in browser,
    signs that browser out and takes its notice away, and the browser that clicked stays signed in."""
    session.attach(CORPUS, SID, "/data/mini")
    other = TestClient(client.app, base_url="http://testserver")
    sign_in(client, hook_auth.link_key(), CORPUS)
    sign_in(other, hook_auth.link_key(), CORPUS)
    theirs = other.get("/api/ui/paired").json()["id"]
    [n] = [n for n in notices.open_notices(CORPUS) if n["key"] == f"sign-in:{theirs}"]
    assert n["kind"] == "sign-in" and n["action"] == {"label": "Sign it out", "do": "sign-out", "slug": theirs}
    assert client.post("/api/ui/signout", json={"id": theirs, "ws": CORPUS}).json() == {"signed_out": True}
    assert other.get("/api/ui/paired").json()["paired"] is False and client.get("/api/ui/paired").json()["paired"]
    assert other.get(f"/api/ws/{CORPUS}/canvas").status_code == 401
    assert not [n for n in notices.open_notices(CORPUS) if n["key"] == f"sign-in:{theirs}"], "its notice went"
