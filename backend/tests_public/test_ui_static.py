"""main.py serves the built UI (frontend/dist) at / when the server is not in dev mode, since a release install has no
Vite: the three pages and their assets with their content types, index.html for a
client-side route, /api untouched (its unknown paths stay 404), nothing mounted without a build or in dev mode."""
from __future__ import annotations

import os

import pytest
from fastapi.testclient import TestClient

from app import config, main


def _health(c: TestClient) -> dict:
    """/api/health without `home` and `app`, the install it names (test_cli covers those), which must be there."""
    body = c.get("/api/health").json()
    assert body.pop("home") and body.pop("app")
    return body

@pytest.fixture()
def dist(tmp_path, monkeypatch):
    d = tmp_path / "dist"
    (d / "assets").mkdir(parents=True)
    (d / "index.html").write_text("<!doctype html><title>thimble</title><div id=root></div>")
    (d / "prompts.html").write_text("<!doctype html><title>thimble · prompts</title>")
    (d / "explain.html").write_text("<!doctype html><title>thimble · explain</title>")
    (d / "assets" / "main-abc123.js").write_text("console.log(1)")
    (d / "assets" / "main-abc123.css").write_text("body{}")
    (d / "thimble.svg").write_text("<svg xmlns='http://www.w3.org/2000/svg'/>")
    monkeypatch.setattr(config, "FRONTEND_DIST", d)
    monkeypatch.delenv("THIMBLE_DEV", raising=False)
    return d


def test_pages_assets_and_spa_fallback_are_served_when_a_build_exists(dist):
    c = TestClient(main.create_app())
    for path, title in (("/", "thimble"), ("/?ws=mini", "thimble"), ("/prompts.html", "thimble · prompts"),
                        ("/explain.html", "thimble · explain")):
        r = c.get(path)
        assert r.status_code == 200 and r.headers["content-type"].startswith("text/html"), path
        assert f"<title>{title}</title>" in r.text, path
    r = c.get("/assets/main-abc123.js")
    assert r.status_code == 200 and "javascript" in r.headers["content-type"] and r.text == "console.log(1)"
    r = c.get("/assets/main-abc123.css")
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/css")
    r = c.get("/thimble.svg")
    assert r.status_code == 200 and r.headers["content-type"].startswith("image/svg+xml")
    # a client-side route (no extension) gets index.html; a missing asset does not
    r = c.get("/ws/mini/report")
    assert r.status_code == 200 and "<div id=root>" in r.text
    assert c.get("/assets/missing-000.js").status_code == 404
    # the API is unaffected: its routes answer, its unknown paths are JSON 404s, never index.html
    # `boot` is new for each start of the server's code, `ui` names the build it serves so an open tab sees a new one
    assert _health(c) == {"ok": True, "leader": os.getsid(0), "boot": config.BOOT_ID,
                                           "ui": main.ui_build()} and main.ui_build()
    r = c.get("/api/no-such-route")
    assert r.status_code == 404 and "<div id=root>" not in r.text
    assert r.headers["content-type"].startswith("application/json")
    # whatever the method: a static server would answer 405 to DELETE/POST, where the routers answer 404
    assert c.delete("/api/ws/a%2Fb").status_code == 404 and c.post("/api/no-such-route").status_code == 404
    assert c.get("/api").status_code == 404
