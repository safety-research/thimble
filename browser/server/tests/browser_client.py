"""A signed-in client of a test server, for route tests: each request goes under the browser's key path with its cookie
and the page's own origin, as the page sends them (auth.py)."""
from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from thimble_browser import home
from thimble_browser.app import build

PORT = 21098
OWN = f"http://127.0.0.1:{PORT}"


class Signed:
    def __init__(self, folder: Any) -> None:
        self.ws = home.open_folder(folder)
        app, auth, self.sessions = build(PORT)
        self.c = TestClient(app, base_url=OWN)
        r = self.c.post("/api/ui/key", json={"code": auth.mint()}, headers={"origin": OWN})
        self.key, self.cookie = r.json()["key"], r.headers["set-cookie"].split(";")[0]

    def __call__(self, method: str, path: str, **kw: Any) -> Any:
        path = path.replace("{ws}", self.ws)
        headers = {"cookie": self.cookie, "origin": OWN, **kw.pop("headers", {})}
        return self.c.request(method, f"/b/{self.key}/api{path}", headers=headers, **kw)
