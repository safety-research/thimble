"""Signing a browser in to thimble (hook_auth: mint, claim, the signed-in browsers; main: the /api/ui routes and
signed_in). The dashboard link carries a one-time code after `#p=`, made when the link is shown; the page trades it for
a cookie and a key, and the server keeps only the sha256 of each code, cookie and key, so no file, transcript or link
holds a credential that lasts. The cookie is scoped to the path of that browser's key, /b/<key>/api/, and counts only
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
def test_a_browser_reads_once_it_signs_in_with_its_link_s_code_and_nothing_after_unpair(client, plugin_headers):
    """hook_auth.LocalReadGuard: a browser without the cookie reads no data (401 and the body that tells the page to
    show its sign-in line), only whether it is signed in and the health check; it reads once it traded its link's
    code, which works once; `thimble unpair` takes that back, while the CLI's proof still reads."""
    refused = {"detail": hook_auth.SIGN_IN_NEEDED, "signin": True}
    r = client.get(f"/api/ws/{CORPUS}/canvas")
    assert (r.status_code, r.json()) == (401, refused)
    assert client.get("/api/ui/paired").json() == {"paired": False, "id": "", "at": ""}
    assert set(client.get("/api/health").json()) == {"ok", "boot", "ui"}, "no path or pid without the token"
    code = hook_auth.mint(CORPUS)
    sign_in(client, code)
    assert client.get("/api/ui/paired").json()["paired"] is True
    assert client.get("/api/corpora").status_code == 200
    assert client.get(f"/api/ws/{CORPUS}/canvas").status_code == 200
    again = TestClient(client.app, base_url="http://testserver").post("/api/ui/key", json={"code": code})
    assert (again.status_code, again.json()) == (410, {"detail": hook_auth.CODE_GONE}), "a code works once"
    assert client.post("/api/ui/unpair", headers=plugin_headers()).status_code == 204
    r = client.get("/api/corpora")
    assert (r.status_code, r.json()) == (401, refused)
    assert client.get("/api/corpora", headers=plugin_headers()).status_code == 200


@pytest.mark.real_read_guard
@pytest.mark.real_write_guard
def test_a_new_sign_in_shows_a_notice_whose_sign_it_out_signs_that_browser_out(client):
    """Each new sign-in shows a notice with Sign it out in the workspace; Sign it out, a click of a signed-in browser,
    signs that browser out and takes its notice away, and the browser that clicked stays signed in."""
    session.attach(CORPUS, SID, "/data/mini")
    other = TestClient(client.app, base_url="http://testserver")
    sign_in(client, hook_auth.mint(CORPUS), CORPUS)
    sign_in(other, hook_auth.mint(CORPUS), CORPUS)
    theirs = other.get("/api/ui/paired").json()["id"]
    [n] = [n for n in notices.open_notices(CORPUS) if n["key"] == f"sign-in:{theirs}"]
    assert n["kind"] == "sign-in" and n["action"] == {"label": "Sign it out", "do": "sign-out", "slug": theirs}
    assert client.post("/api/ui/signout", json={"id": theirs, "ws": CORPUS}).json() == {"signed_out": True}
    assert other.get("/api/ui/paired").json()["paired"] is False and client.get("/api/ui/paired").json()["paired"]
    assert other.get(f"/api/ws/{CORPUS}/canvas").status_code == 401
    assert not [n for n in notices.open_notices(CORPUS) if n["key"] == f"sign-in:{theirs}"], "its notice went"
