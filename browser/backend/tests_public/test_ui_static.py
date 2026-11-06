"""main.py serves the built UI (frontend/dist) at / when the server is not in dev mode, since a release install has no
Vite: the pages and their assets with their content types, and index.html for a client-side route, each with a policy
that lets nothing the page loads or sends leave the machine."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app import config, main


@pytest.fixture()
def dist(tmp_path, monkeypatch):
    d = tmp_path / "dist"
    (d / "assets").mkdir(parents=True)
    (d / "index.html").write_text("<!doctype html><title>thimble</title><div id=root></div>")
    (d / "assets" / "main-abc123.js").write_text("console.log(1)")
    (d / "assets" / "main-abc123.css").write_text("body{}")
    monkeypatch.setattr(config, "FRONTEND_DIST", d)
    monkeypatch.delenv("THIMBLE_DEV", raising=False)
    return d


def directives(csp: str) -> dict[str, str]:
    return {p.strip().split(" ", 1)[0]: (p.strip().split(" ", 1) + [""])[1] for p in csp.split(";") if p.strip()}


def test_the_page_and_its_assets_are_served_with_a_policy_that_keeps_them_on_the_machine(dist):
    c = TestClient(main.create_app())
    for path in ("/", "/?ws=mini", "/ws/mini/report"):  # a client-side route gets index.html
        r = c.get(path)
        assert r.status_code == 200 and r.headers["content-type"].startswith("text/html"), path
        assert "<div id=root>" in r.text, path
    r = c.get("/assets/main-abc123.js")
    assert r.status_code == 200 and "javascript" in r.headers["content-type"] and r.text == "console.log(1)"
    assert c.get("/assets/main-abc123.css").headers["content-type"].startswith("text/css")
    assert c.get("/assets/missing-000.js").status_code == 404
    for path in ("/", "/assets/main-abc123.js"):
        r = c.get(path)
        assert r.headers["x-content-type-options"] == "nosniff" and r.headers["x-frame-options"] == "SAMEORIGIN"
        d = directives(r.headers["content-security-policy"])
        assert d["frame-ancestors"] == "'self'" and d["object-src"] == "'none'"
        for k in ("default-src", "script-src", "style-src", "img-src", "font-src", "connect-src", "media-src", "frame-src"):
            assert "http" not in d[k] and "*" not in d[k], (k, d[k])
    # the API is unaffected: its unknown paths are JSON 404s, never index.html, with the API's own policy
    r = c.get("/api/no-such-route")
    assert r.status_code == 404 and r.headers["content-type"].startswith("application/json")
    d = directives(r.headers["content-security-policy"])
    assert d["default-src"] == "'none'" and "sandbox" in d
    assert c.get("/api/health").json()["ok"] is True
