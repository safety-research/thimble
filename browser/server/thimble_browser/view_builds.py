"""The controls of a view's build that the page shows (feature module): Stop in the build's thread, Retry on its chip, a
change typed in its thread, and × on a failed one. A build is the builder agent (agent.AGENTS["dev"]) in a chat of its
own; its row in views/proposals.json says how it stands.

- POST /api/ws/{c}/views/proposals/{slug}/stop: the build stops, and so fails, with Retry.
- POST /api/ws/{c}/views/{slug}/build and POST .../proposals/{slug}/retry: a new build of the same request, in a new
  chat, with its attempts counted afresh.
- POST /api/ws/{c}/views/proposals/{slug}/message: the analyst's change, sent to the builder in its own chat, which
  goes on from where it ended and checks the view again. 409 while it still works.
- DELETE /api/ws/{c}/views/proposals/{slug}: the row is dropped, with the view's files when it was never built.
"""
from __future__ import annotations

import shutil
from typing import Any

from fastapi import Body, HTTPException

from . import chats, home, views
from .hub import hub


def _row(ws: str, slug: str) -> dict[str, Any]:
    row = next((r for r in views.proposals(ws) if r.get("slug") == slug), None)
    if row is None:
        raise HTTPException(404, f"no view build {slug!r}")
    return row


def change_brief(text: str) -> str:
    return ("The analyst asks for this change to the view. Make it with write_view_file, check the view again with "
            f"view_check, then call finish_view.\n\n{text}")


def register(ctx: Any) -> None:
    app, sessions = ctx.app, ctx.sessions

    def running(ws: str, row: dict[str, Any]) -> bool:
        return bool(row.get("chat")) and row["chat"] in sessions.running(ws)

    async def build_again(c: str, slug: str) -> dict[str, Any]:
        from .features.views import start_build  # noqa: PLC0415

        ws = ctx.ws_of(c)
        row = _row(ws, slug)
        if running(ws, row):
            raise HTTPException(409, "this view is being built already")
        cid = await start_build(sessions, ws, slug)
        return {**_row(ws, slug), "agentId": cid}

    @app.post("/api/ws/{c}/views/{slug}/build")
    async def build(c: str, slug: str) -> dict[str, Any]:
        return await build_again(c, slug)

    @app.post("/api/ws/{c}/views/proposals/{slug}/retry")
    async def retry(c: str, slug: str) -> dict[str, Any]:
        return await build_again(c, slug)

    @app.post("/api/ws/{c}/views/proposals/{slug}/stop")
    async def stop(c: str, slug: str) -> dict[str, bool]:
        ws = ctx.ws_of(c)
        row = _row(ws, slug)
        if row.get("chat"):
            await sessions.get(ws, str(row["chat"])).interrupt()
        return {"ok": True}

    @app.post("/api/ws/{c}/views/proposals/{slug}/message")
    async def message(c: str, slug: str, body: dict = Body(...)) -> dict[str, Any]:
        ws = ctx.ws_of(c)
        row = _row(ws, slug)
        text = str(body.get("text") or "").strip()
        if not text:
            raise HTTPException(400, "an empty message")
        if not row.get("chat"):
            raise HTTPException(409, "this view has no build to send it to")
        if running(ws, row):
            raise HTTPException(409, "the builder is still working: wait until it ends, or stop it, then send this")
        cid = str(row["chat"])
        try:
            meta = chats.meta(ws, cid)
        except KeyError:
            raise HTTPException(409, "this view's build is gone: retry it, then send this") from None
        meta.update(status="running")
        chats.save_meta(ws, meta)
        row = views.set_proposal(ws, slug, status="building", attempts=0)
        await sessions.get(ws, cid).send(change_brief(text), shown=text)
        return row

    @app.delete("/api/ws/{c}/views/proposals/{slug}")
    async def drop(c: str, slug: str) -> dict[str, bool]:
        ws = ctx.ws_of(c)
        row = _row(ws, slug)
        if running(ws, row):
            await sessions.get(ws, str(row["chat"])).interrupt()
        rows = [r for r in views.proposals(ws) if r.get("slug") != slug]
        home.write_json(views.views_dir(ws) / "proposals.json", rows)
        d = views.view_dir(ws, slug)
        meta = views.read_meta(d) if d.is_dir() else None
        if d.is_dir() and not (meta or {}).get("built"):
            shutil.rmtree(d)
        hub.publish(ws, {"type": "view", "slug": slug, "status": "deleted"})
        return {"ok": True}
