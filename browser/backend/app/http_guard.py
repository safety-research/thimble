"""What a browser page may ask of this server, and the headers every response carries.

The API is unauthenticated on a loopback port and some routes run code, so neither a page on another site nor HTML a
model or corpus wrote (shown in sandboxed frames with `Origin: null`) may reach them.

- OriginCheck refuses a state-changing request (any method but GET, HEAD, OPTIONS) whose Origin is present and not this
  server's own (or, under THIMBLE_DEV, the Vite origin), or which has no Origin and Sec-Fetch-Site cross-site. A request
  with neither header (CLI, MCP shim, hooks' curl) passes. The plugin's routes (/api/events and under it) refuse, on
  every method, any request that carries an Origin or a Sec-Fetch-* header, which a browser sends and the shim and hooks
  never do: the shim's subscription GET attaches the session it names, the watcher's pull takes main's events, and even
  the app's own page (an <img> in markdown a model wrote) sends GETs.
- SecurityHeaders gives every response nosniff, frame-ancestors 'self' (and X-Frame-Options) and a CSP unless the
  route set its own: APP_CSP on the built UI, API_CSP on /api.
- dev_origins: the Vite origins that CORS and OriginCheck accept under THIMBLE_DEV.

Both middlewares are pure ASGI, so the SSE routes' bodies pass through untouched.
"""
from __future__ import annotations

import json
import logging
import os
from urllib.parse import urlsplit

from starlette.datastructures import Headers, MutableHeaders

log = logging.getLogger("thimble.guard")

SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})
DEFAULT_UI_PORT = 5300  # cli.DEFAULT_UI_PORT, the Vite port when THIMBLE_UI_PORT is unset

# The built UI's policy. Why each source is there:
# - script-src 'unsafe-inline' 'unsafe-eval': a srcdoc frame inherits the policy of the page that embeds it, and the
#   views' pages, custom cards and scripted outputs run inline script in such frames (sandboxed, without
#   allow-same-origin); Vega compiles its expressions with Function. No host is listed, so no script loads from the web.
# - style-src 'unsafe-inline': React and BlockNote set inline styles, and the frames carry the theme as a <style>.
# - img-src, media-src, font-src: the app's own files and data: or blob: URLs, never another host, so HTML or markdown
#   a model wrote cannot send what it read to a server by loading an image.
# - connect-src: the API, and data: or blob: URLs, which Vega's loader and the frames' font inlining fetch.
APP_CSP = "; ".join((
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self' data: blob:",
    "worker-src 'self' blob:",
    "frame-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
))
# An API response is data the app fetches, never a page: opened in a tab (a view's frame document, a screenshot), it
# runs no script and loads nothing but itself.
API_CSP = "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; frame-ancestors 'self'; sandbox"
BASE_HEADERS = (("X-Content-Type-Options", "nosniff"), ("X-Frame-Options", "SAMEORIGIN"),
                ("Referrer-Policy", "same-origin"))


def truthy(v: str | None) -> bool:
    return (v or "").strip().lower() in ("1", "true", "yes", "on")


def dev_origins(dev: bool | None = None) -> list[str]:
    """The origins of the Vite server that serves the UI in dev mode (THIMBLE_UI_PORT, else 5300), by both loopback
    names; [] outside dev mode. `dev` defaults to THIMBLE_DEV."""
    if dev is None:
        dev = truthy(os.environ.get("THIMBLE_DEV"))
    if not dev:
        return []
    v = os.environ.get("THIMBLE_UI_PORT", "")
    port = int(v) if v.isdigit() else DEFAULT_UI_PORT
    return [f"http://localhost:{port}", f"http://127.0.0.1:{port}"]


def same_origin(origin: str, host: str) -> bool:
    """Whether `origin` is this server as the browser reached it: an http(s) origin whose host and port are the request's
    Host header (TrustedHostMiddleware has already limited Host to the allowed names)."""
    try:
        u = urlsplit(origin)
    except ValueError:
        return False
    return u.scheme in ("http", "https") and bool(host) and u.netloc.lower() == host.lower() and not u.path.strip("/")


class OriginCheck:
    """Refuses a state-changing request a browser sent from another origin, with 403."""

    def __init__(self, app, extra_origins: list[str] | None = None) -> None:
        self.app = app
        self.extra = {o.lower() for o in (dev_origins() if extra_origins is None else extra_origins)}

    def allowed(self, origin: str, host: str) -> bool:
        return origin.lower() in self.extra or same_origin(origin, host)

    async def __call__(self, scope, receive, send) -> None:
        plugin = is_plugin_route(scope.get("path", ""))
        if scope["type"] != "http" or (scope.get("method", "GET") in SAFE_METHODS and not plugin):
            await self.app(scope, receive, send)
            return
        h = Headers(scope=scope)
        origin = h.get("origin")
        site = h.get("sec-fetch-site")
        if plugin:
            browser = origin is not None or any(k.startswith("sec-fetch-") for k in h.keys())
            why = "a web page may not reach the plugin's routes" if browser else None
        elif origin is not None:
            why = None if self.allowed(origin, h.get("host", "")) else f"a page at {origin} may not change state here"
        else:
            why = "a cross-site page may not change state here" if site == "cross-site" else None
        if why is None:
            await self.app(scope, receive, send)
            return
        log.warning("refused %s %s: %s", scope.get("method"), scope.get("path"), why)
        body = json.dumps({"detail": why}).encode()
        await send({"type": "http.response.start", "status": 403,
                    "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())]})
        await send({"type": "http.response.body", "body": body})


def is_api(path: str) -> bool:
    return path == "/api" or path.startswith("/api/")


def is_plugin_route(path: str) -> bool:
    """The routes only the plugin's shim and hooks call (events.py), which OriginCheck guards on every method."""
    return path == "/api/events" or path.startswith("/api/events/")


class SecurityHeaders:
    """nosniff, frame-ancestors and a policy on every response; a header a route set is kept."""

    def __init__(self, app) -> None:
        self.app = app

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        csp = API_CSP if is_api(scope.get("path", "")) else APP_CSP

        async def send_with_headers(message) -> None:
            if message["type"] == "http.response.start":
                h = MutableHeaders(scope=message)
                for k, v in BASE_HEADERS:
                    if k not in h:
                        h[k] = v
                if "content-security-policy" not in h:
                    h["Content-Security-Policy"] = csp
            await send(message)

        await self.app(scope, receive, send_with_headers)
