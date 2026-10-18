"""A demo workspace is read-only: nothing a browser page sends changes its cards, labels, views or documents (bug hunt
F5, where one click on a card's Delete took a pre-cached card away for good).

A demo workspace is one `thimble demo` installed from a pre-cache (precached.MARKER), or a worked example's that
`thimble demo --examples` or the tour opened (demo_examples.PREFIX), while no Claude Code session has attached to its
main: main's meta has neither `attached` nor `ended` (is_demo). The browser shows it as a demo page (frontend lib/demo
isDemoPage) with its editing controls off. A session attached to it makes it the analyst's to change, as any workspace.

DemoReadOnly refuses, 403 with DEMO_REFUSED, a write that a browser page sends to such a workspace's routes
(/api/ws/<c>/...): a request with an Origin or a Sec-Fetch-* header, which a browser sends and thimble's own programs
never do (`thimble demo --examples` defines an example's labels through the server). It lets through:
- the token routes (hook_auth.guarded): a session's attach and its hooks, and the CLI's archive, restore, rename and
  removal of a workspace;
- what only reads, sent as a POST for its body (READS), and what changes only what the page shows or thimble's own
  config (VIEW_STATE: filters, the canvas's active group, the theme cards are drawn in, telemetry, a problem report, a
  notice's ×, Settings, a card's Open as view);
- a label's or a check's switch that only shows or hides it (SHOWS: a body whose one field is `shown`).
Pure ASGI, inside the sign-in checks.
"""
from __future__ import annotations

import json
import logging
import re


log = logging.getLogger("thimble.demo")

DEMO_REFUSED = "This is a demo, so it can't be changed here. To work on your own folder, run thimble in it."
SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})
WS_PATH = re.compile(r"/api/ws/(?P<c>[^/]+)(?P<rest>/.*)?")
READS = re.compile(r"/(views/[^/]+/(records|marks|calls/[^/]+/cancel)|labels/refs|cardtypes/[^/]+/records)")
VIEW_STATE = re.compile(r"/(filters(/.*)?|canvas/active-group|render/theme|telemetry|feedback|notices/[^/]+/dismiss"
                        r"|settings|cells/[^/]+/as-view)")
SHOWS = (("PUT", re.compile(r"/concepts/[^/]+")), ("PATCH", re.compile(r"/checks/[^/]+")))
SHOW_FIELDS = frozenset({"shown"})
BODY_MAX = 64 * 1024  # a switch's body is a few bytes; a larger one is no switch


def is_demo(c: str) -> bool:
    """Whether workspace `c` is a demo workspace now (module note). Never raises."""
    from . import agents, config, demo_examples, precached  # noqa: PLC0415

    try:
        ws = config.workspace_path(c)
        if not ((ws / precached.MARKER).is_file() or c.startswith(demo_examples.PREFIX)):
            return False
        meta = agents.meta_or_none(c, agents.MAIN_ID) or {}
    except Exception:  # noqa: BLE001 — a workspace that cannot be read is no demo's
        return False
    return not meta.get("attached") and not meta.get("ended")


def from_page(scope: dict) -> bool:
    """Whether a request comes from a browser page: it carries an Origin or a Sec-Fetch-* header."""
    return any(k == b"origin" or k.startswith(b"sec-fetch-") for k, _ in scope.get("headers") or ())


def shows_only(body: bytes) -> bool:
    """Whether a JSON body only shows or hides what it names (SHOW_FIELDS)."""
    try:
        got = json.loads(body or b"null")
    except ValueError:
        return False
    return isinstance(got, dict) and bool(got) and set(got) <= SHOW_FIELDS


class DemoReadOnly:
    """403 for a browser page's write to a demo workspace that the module note does not let through."""

    def __init__(self, app) -> None:
        self.app = app

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] != "http" or scope.get("method", "") in SAFE_METHODS or not from_page(scope):
            await self.app(scope, receive, send)
            return
        from . import hook_auth  # noqa: PLC0415

        path, method = scope.get("path", ""), scope.get("method", "")
        m = WS_PATH.fullmatch(path)
        rest = (m.group("rest") or "") if m else ""
        if (m is None or hook_auth.guarded(method, path) or READS.fullmatch(rest) or VIEW_STATE.fullmatch(rest)
                or not is_demo(m.group("c"))):
            await self.app(scope, receive, send)
            return
        if any(method == verb and route.fullmatch(rest) for verb, route in SHOWS):
            body, messages = await _read_body(receive)
            if body is not None and shows_only(body):
                await self.app(scope, _replay(messages, receive), send)
                return
        log.info("%s: %s %s refused: a demo workspace is read-only", m.group("c"), method, path)
        out = json.dumps({"detail": DEMO_REFUSED, "demo": True}).encode()
        await send({"type": "http.response.start", "status": 403,
                    "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(out)).encode())]})
        await send({"type": "http.response.body", "body": out})


async def _read_body(receive) -> tuple[bytes | None, list[dict]]:
    """The request's body and the messages it came in; None for the body past BODY_MAX or a client that left."""
    messages: list[dict] = []
    body = b""
    while True:
        msg = await receive()
        messages.append(msg)
        if msg["type"] != "http.request":
            return None, messages
        body += msg.get("body", b"")
        if len(body) > BODY_MAX:
            return None, messages
        if not msg.get("more_body"):
            return body, messages


def _replay(messages: list[dict], receive):
    """A receive that gives `messages` again first, then the client's own."""
    queue = list(messages)

    async def again() -> dict:
        return queue.pop(0) if queue else await receive()

    return again

