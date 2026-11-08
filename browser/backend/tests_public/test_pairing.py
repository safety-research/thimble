"""Signing a browser in to thimble (hook_auth: link_key, claim, the signed-in browsers; main: the /api/ui routes and
signed_in). The dashboard link carries the install's sign-in key after `#p=`, the same every time and good in any
browser until `thimble-browser --unpair` changes it; the page trades it for a cookie and a key, and the server keeps only the
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
    key, which signs in another browser too; `thimble-browser --unpair` takes both back and changes the key, so the old link
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
    path.write_text("")  # a write cut short: the key is made again in the same file, never in a new one
    assert hook_auth.link_key() and path.stat().st_ino == inode


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


@pytest.mark.real_read_guard
def test_a_restart_keeps_the_link_and_every_signed_in_browser(client, plugin_headers):
    """A server that starts again reads the signed-in browsers from paired.json and the key from link.key: the link
    thimble-browser prints is the one it printed before, and a browser signed in before reads with no new sign-in."""
    code = client.post("/api/ui/pair", headers=plugin_headers()).json()["code"]
    sign_in(client, code)
    hook_auth._paired = None  # what a new server knows: the files alone
    assert client.post("/api/ui/pair", headers=plugin_headers()).json()["code"] == code
    assert client.get("/api/corpora").status_code == 200


def test_after_unpair_the_next_signed_out_page_has_the_new_link_printed_at_once(client, plugin_headers):
    """want_link counts a page that is not signed in at most once a minute; unpair counts the next one at once, so the
    pages it signed out have thimble-browser print the new link right away, not a minute after an earlier ask."""
    assert client.get("/api/ui/paired").json()["paired"] is False
    assert client.get("/api/ui/paired").json()["paired"] is False
    assert hook_auth.links_wanted() == 1, "a page that reloads counts once a minute"
    assert client.post("/api/ui/unpair", headers=plugin_headers()).status_code == 204
    client.get("/api/ui/paired")
    assert hook_auth.links_wanted() == 2


def test_the_terminal_prints_the_link_again_only_once_it_changed(monkeypatch):
    """cli.new_links: each answer of /api/ui/link-wanted with a higher count is a browser that is not signed in; the
    link is printed for it only when it differs from the one printed last (`thimble-browser --unpair` changed the key)."""
    import threading

    from app import cli

    stop = threading.Event()
    answers = iter([1, 2, 3, 4])
    links = iter(["http://x/#p=a", "http://x/#p=b", "http://x/#p=b"])
    printed: list[str] = []

    def request(method, url, body=None, timeout=None):
        n = next(answers, None)
        if n is None:
            stop.set()
            return 0, {}
        return 200, {"boot": "1", "wanted": n}

    monkeypatch.setattr(cli, "_request", request)
    monkeypatch.setattr(cli, "ui_url", lambda name, pair=False: next(links))
    monkeypatch.setattr(cli, "_say", lambda *lines: printed.extend(lines))
    cli.new_links("w", stop, "http://x/#p=a")
    assert printed == [cli.BROWSER_LINE.format(what=cli.NEW_LINK_LINE.format(link="http://x/#p=b"))]


def test_unpair_with_the_server_down_signs_out_and_changes_the_link(monkeypatch, capsys):
    """`thimble-browser --unpair` while no server answers: paired.json goes and link.key holds a new key in the same file, so a
    server that starts later knows no browser and no earlier link. With a server that answers, the server changes the
    key and the CLI leaves it, so a link printed for a page signed out at that moment is not changed under it."""
    import argparse

    from app import cli

    key = hook_auth.link_key()
    path = hook_auth.home() / hook_auth.LINK_KEY
    (hook_auth.home() / hook_auth.PAIRED_FILE).write_text("[]")
    monkeypatch.setattr(cli, "healthy", lambda url=None, timeout=None: False)
    assert cli.cmd_unpair(argparse.Namespace()) == 0
    assert capsys.readouterr().out.strip() == cli.UNPAIRED_LINE
    assert not (hook_auth.home() / hook_auth.PAIRED_FILE).exists()
    assert hook_auth.link_key() not in ("", key) and path.stat().st_mode & 0o777 == 0o600
    served = hook_auth.link_key()
    monkeypatch.setattr(cli, "healthy", lambda url=None, timeout=None: True)
    monkeypatch.setattr(cli, "_request", lambda *a, **k: (204, {}))
    assert cli.cmd_unpair(argparse.Namespace()) == 0
    assert hook_auth.link_key() == served, "the server changed it, not the CLI a second time"
