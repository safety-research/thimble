"""thimble's own work while it runs, for the top bar's indicator (frontend lib/busy.ts): each job says a word or two
("marking", "labeling") when it starts and when it ends, as {"type": "busy", "id", "word", "on"} on the workspace's
stream. A job ends (on false) when its work ends or fails; a failure says itself where it happened, as before.

    async with working(ws, "marking"):
        ...
"""
from __future__ import annotations

import secrets
from contextlib import asynccontextmanager
from typing import AsyncIterator

from .hub import hub


@asynccontextmanager
async def working(ws: str, word: str) -> AsyncIterator[None]:
    jid = secrets.token_hex(4)
    hub.publish(ws, {"type": "busy", "id": jid, "word": word, "on": True})
    try:
        yield
    finally:
        hub.publish(ws, {"type": "busy", "id": jid, "word": word, "on": False})
