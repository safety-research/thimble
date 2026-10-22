"""Unhandled errors in a request: one log record with the context to debug it, and an answer the browser can show.

ErrorLog catches the exception, gives it a short id, logs method, path, workspace, id and traceback under
`thimble.error`, and answers JSON `{detail, error_id}`. A full disk answers 507, an unreadable file 403, anything else
500. A response that has already started (a stream) cannot be answered again, so the error is logged and re-raised.
"""
from __future__ import annotations

import errno
import json
import logging
import re
import secrets

log = logging.getLogger("thimble.error")

_WORKSPACE_RE = re.compile(r"^/api/(?:ws|corpora)/([^/]+)")


def workspace_of(path: str) -> str:
    """The workspace a request path names (`/api/ws/<c>/…`, `/api/corpora/<c>/…`), or '-'."""
    m = _WORKSPACE_RE.match(path or "")
    return m[1] if m else "-"


def describe(e: BaseException) -> tuple[int, str]:
    """(status, plain detail) for an exception no route handled."""
    if isinstance(e, OSError) and e.errno in (errno.ENOSPC, errno.EDQUOT):
        where = e.filename or "thimble's files"
        return 507, f"the disk that holds {where} is full; free some space and try again"
    if isinstance(e, PermissionError):
        return 403, f"the server may not read or write {e.filename or 'a file it needs'} ({e.strerror or 'permission denied'})"
    text = str(e).strip()
    return 500, f"server error ({type(e).__name__}{': ' + text[:300] if text else ''})"


class ErrorLog:
    """Pure ASGI middleware, placed inside the timing middleware so a failed request is still timed."""

    def __init__(self, app) -> None:
        self.app = app

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        started = False

        async def send_marked(message) -> None:
            nonlocal started
            if message["type"] == "http.response.start":
                started = True
            await send(message)

        try:
            await self.app(scope, receive, send_marked)
        except Exception as e:
            error_id = secrets.token_hex(4)
            path = scope.get("path", "")
            qs = (scope.get("query_string") or b"").decode("latin-1")
            status, detail = describe(e)
            log.exception("request %s failed: %s %s (workspace %s) -> %s", error_id, scope.get("method", "?"),
                          path + (f"?{qs}" if qs else ""), workspace_of(path), status)
            if started:
                raise
            body = json.dumps({"detail": f"{detail}. Logged in server.log as {error_id}.", "error_id": error_id}).encode()
            await send({"type": "http.response.start", "status": status,
                        "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())]})
            await send({"type": "http.response.body", "body": body})
