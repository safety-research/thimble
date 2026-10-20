"""The workspace's event stream: the page opens one GET /api/ws/{c}/events and hears a small record each time
something it shows changes ({"type": "chat", "chat": "main"}, {"type": "cell", "cell": ...}), then reads the thing
again. The records say what changed, never the content, so the stream needs no replay: a page that reconnects reads
everything anew.
"""
from __future__ import annotations

import asyncio
import json
from typing import Any, AsyncIterator

PING_S = 15


class Hub:
    def __init__(self) -> None:
        self._subs: dict[str, set[asyncio.Queue]] = {}
        self._n = 0

    def publish(self, ws: str, record: dict[str, Any]) -> None:
        for q in list(self._subs.get(ws, ())):
            try:
                q.put_nowait(record)
            except asyncio.QueueFull:
                pass

    async def stream(self, ws: str) -> AsyncIterator[bytes]:
        q: asyncio.Queue = asyncio.Queue(maxsize=1000)
        self._subs.setdefault(ws, set()).add(q)
        try:
            yield f"event: live\ndata: {json.dumps({'log': 'browser'})}\n\n".encode()
            while True:
                try:
                    rec = await asyncio.wait_for(q.get(), PING_S)
                except asyncio.TimeoutError:
                    yield b"event: ping\ndata: {}\n\n"
                    continue
                self._n += 1
                yield f"id: {self._n}\ndata: {json.dumps(rec)}\n\n".encode()
        finally:
            self._subs.get(ws, set()).discard(q)


hub = Hub()
