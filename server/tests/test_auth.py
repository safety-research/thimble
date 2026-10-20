"""Only the browser signed in with the printed link reaches the API (auth.py)."""
from fastapi.testclient import TestClient

from thimble_browser.app import build

PORT = 21099
OWN = f"http://127.0.0.1:{PORT}"


def client():
    app, auth, _ = build(PORT)
    return TestClient(app, base_url=OWN), auth


def test_another_host_name_is_refused():
    c, _ = client()
    assert c.get("/api/health", headers={"host": f"rebound.example:{PORT}"}).status_code == 403


def test_reads_need_the_cookie():
    c, _ = client()
    r = c.get("/api/workspaces")
    assert r.status_code == 401 and r.json()["signin"] is True


def test_a_code_signs_in_once_and_the_cookie_counts_only_under_its_key():
    c, auth = client()
    code = auth.mint()
    r = c.post("/api/ui/key", json={"code": code}, headers={"origin": OWN})
    assert r.status_code == 200
    key = r.json()["key"]
    assert f"Path=/b/{key}/api/" in r.headers["set-cookie"] and "HttpOnly" in r.headers["set-cookie"]
    cookie = r.headers["set-cookie"].split(";")[0]
    assert c.get(f"/b/{key}/api/workspaces", headers={"cookie": cookie}).status_code == 200
    assert c.get("/api/workspaces", headers={"cookie": cookie}).status_code == 401
    assert c.get("/b/" + "x" * 32 + "/api/workspaces", headers={"cookie": cookie}).status_code == 401
    again = c.post("/api/ui/key", json={"code": code}, headers={"origin": OWN})
    assert again.status_code == 410


def test_changes_need_the_pages_own_origin():
    c, auth = client()
    r = c.post("/api/ui/key", json={"code": auth.mint()}, headers={"origin": OWN})
    key, cookie = r.json()["key"], r.headers["set-cookie"].split(";")[0]
    bad = c.post(f"/b/{key}/api/ui/signout", headers={"cookie": cookie, "origin": "http://evil.example"})
    assert bad.status_code == 403
    ok = c.post(f"/b/{key}/api/ui/signout", headers={"cookie": cookie, "origin": OWN})
    assert ok.status_code == 200
