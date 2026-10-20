"""Who may use the server: only the browser the person signed in with the link the server printed.

The server listens on 127.0.0.1 alone, but any program on this machine, and any web page open in any browser here, can
send requests to 127.0.0.1. So every request passes three checks (Guard):

1. Host. The Host header must name 127.0.0.1 or localhost on this port. A web page that points its own domain name at
   127.0.0.1 (DNS rebinding) sends its own name, and is refused.
2. Sign-in. Every /api request needs this browser's cookie, under its own path. The link carries a one-time code
   (`#p=...`, in the part of the address the browser never sends). The page trades the code for a cookie and a random
   key (POST /api/ui/key). The cookie is HttpOnly and SameSite=Strict, and is scoped to /b/<key>/api/, a path no other
   page knows, so the browser sends it to no other server on 127.0.0.1. A code works once, and for 15 minutes.
3. Origin. A request that changes something must come from this server's own page (its Origin header).

The server keeps only the sha256 of each code, cookie and key.
"""
from __future__ import annotations

import hashlib
import json
import re
import secrets
import threading
import time
from pathlib import Path
from typing import Any, Callable

from . import home

CODE_TTL_S = 15 * 60
COOKIE_AGE_S = 400 * 24 * 3600
OPEN_PATHS = {("GET", "/api/health"), ("POST", "/api/ui/key"), ("GET", "/api/ui/paired")}
BROWSER_PATH = re.compile(r"^/b/([A-Za-z0-9_-]{16,128})(/api(?:/.*)?)$")


def _sha(v: str) -> str:
    return hashlib.sha256(v.encode()).hexdigest()


class Auth:
    def __init__(self, port: int) -> None:
        self.port = port
        self.cookie_name = f"thimble-browser-{port}"
        self._codes: dict[str, float] = {}
        self._lock = threading.Lock()
        self._file = home.root() / "browsers.json"

    # ---- the link's one-time code

    def mint(self) -> str:
        code = secrets.token_urlsafe(24)
        with self._lock:
            now = time.time()
            self._codes = {h: t for h, t in self._codes.items() if t > now}
            self._codes[_sha(code)] = now + CODE_TTL_S
        return code

    def _spend(self, code: str) -> bool:
        with self._lock:
            t = self._codes.pop(_sha(code), None)
        return t is not None and t > time.time()

    # ---- signed-in browsers

    def _entries(self) -> list[dict[str, str]]:
        got = home.read_json(self._file, [])
        return [e for e in got if isinstance(e, dict) and "cookie" in e and "key" in e] if isinstance(got, list) else []

    def claim(self, code: str) -> tuple[str, str] | None:
        """(cookie, key) for a code that is good, once; None otherwise."""
        if not isinstance(code, str) or not self._spend(code):
            return None
        cookie, key = secrets.token_urlsafe(32), secrets.token_urlsafe(24)
        with self._lock:
            entries = self._entries()[-20:]
            entries.append({"cookie": _sha(cookie), "key": _sha(key), "at": home.now()})
            home.write_json(self._file, entries)
            try:
                self._file.chmod(0o600)
            except OSError:
                pass
        return cookie, key

    def browser(self, cookie: str | None, key: str | None) -> str:
        """The id of the signed-in browser holding `cookie` under `key`, '' for none."""
        if not cookie or not key:
            return ""
        c, k = _sha(cookie), _sha(key)
        for e in self._entries():
            if secrets.compare_digest(e["cookie"], c) and secrets.compare_digest(e["key"], k):
                return c[:12]
        return ""

    def sign_out(self, cookie: str | None) -> None:
        if not cookie:
            return
        c = _sha(cookie)
        with self._lock:
            home.write_json(self._file, [e for e in self._entries() if e["cookie"] != c])

    def set_cookie_header(self, cookie: str, key: str) -> str:
        return (f"{self.cookie_name}={cookie}; Path=/b/{key}/api/; Max-Age={COOKIE_AGE_S}; HttpOnly; "
                f"SameSite=Strict")


def _header(scope: dict, name: bytes) -> str:
    for k, v in scope.get("headers") or []:
        if k == name:
            return v.decode("latin-1")
    return ""


def _cookie(scope: dict, name: str) -> str:
    raw = _header(scope, b"cookie")
    for part in raw.split(";"):
        k, _, v = part.strip().partition("=")
        if k == name:
            return v
    return ""


class Guard:
    """The ASGI middleware that makes the three checks (module doc) before any route sees a request. A request under
    /b/<key>/api/... reaches the routes as /api/..., with scope["browser"] set to the signed-in browser's id."""

    def __init__(self, app: Callable, auth: Auth, hosts: set[str]) -> None:
        self.app, self.auth, self.hosts = app, auth, hosts

    async def _deny(self, send: Callable, status: int, detail: str, signin: bool = False) -> None:
        body = json.dumps({"detail": detail, **({"signin": True} if signin else {})}).encode()
        await send({"type": "http.response.start", "status": status,
                    "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())]})
        await send({"type": "http.response.body", "body": body})

    async def __call__(self, scope: dict, receive: Callable, send: Callable) -> Any:
        if scope["type"] not in ("http", "websocket"):
            return await self.app(scope, receive, send)
        host = _header(scope, b"host").lower()
        if host not in self.hosts:
            return await self._deny(send, 403, "this server answers only to 127.0.0.1 and localhost")
        path = scope.get("path", "")
        key = ""
        m = BROWSER_PATH.match(path)
        if m:
            key, path = m.group(1), m.group(2)
            scope = {**scope, "path": path, "raw_path": path.encode()}
        method = scope.get("method", "GET")
        if path == "/api" or path.startswith("/api/"):
            browser = self.auth.browser(_cookie(scope, self.auth.cookie_name), key)
            scope = {**scope, "browser": browser, "browser_key": key}
            if (method, path) not in OPEN_PATHS and not browser:
                return await self._deny(send, 401, "this browser is not signed in: open the link thimble browser printed",
                                        signin=True)
            if method not in ("GET", "HEAD", "OPTIONS"):
                origin = _header(scope, b"origin").lower()
                if origin not in {f"http://{h}" for h in self.hosts}:
                    return await self._deny(send, 403, "a change must come from thimble browser's own page")
        return await self.app(scope, receive, send)
