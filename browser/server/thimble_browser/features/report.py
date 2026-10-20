"""The report: one document per workspace that the analyst owns from the start. They type notes and headings into it
and place cards in it; Claude, the chat agent, writes or revises it when they ask, in the Report tab ("Write", with
instructions) or in the chat, and keeps their notes and the cards they placed.

It owns the report's routes (report.py keeps the document, exports.py its exports), the tools read_document,
write_document and edit_document, the `Report` part of the chat agent's prompt (prompts/report.md) and, on the page,
the Report tab and the report's figures.

    GET  /api/ws/{c}/investigations/main/types              the report's state: written or not, writing now
    GET  /api/ws/{c}/investigations/main/types/report       the report as the page reads it (404 while empty)
    PUT  /api/ws/{c}/investigations/main/types/report/blocks the editor's blocks, saved as the report
    POST /api/ws/{c}/write                                  {text}: ask Claude to write or revise it, in the chat
"""
from __future__ import annotations

import logging
from typing import Any

from fastapi import Body, HTTPException

from .. import agent, chats, exports, report
from ..tools import Result
from . import Feature

log = logging.getLogger("thimble_browser.report")


# ---- the tools

async def read_document(t: Any, args: dict[str, Any]) -> Result:
    md = report.markdown(t.ws)
    if md is None or not md.strip():
        return Result("The report is empty: the analyst has written nothing in it yet.")
    return Result(md)


def _saved(t: Any, doc: dict[str, Any]) -> Result:
    refs = [r for sec in doc["sections"] for p in sec["paragraphs"] for s in p["sentences"] for r in s["refs"]]
    figs = [f for sec in doc["sections"] for f in sec.get("figures", [])]
    broken = [(r, why) for r in dict.fromkeys(refs) if (why := t.opens(r))]
    broken += [(f"card:{f['cell']}", why) for f in figs if (why := t.opens(f"card:{f['cell']}"))]
    lines = [f"Saved the report: {len(doc['sections'])} sections, {len(figs)} figures, {len(refs)} citations."]
    if broken:
        lines.append("These citations do not open; fix each and save again:")
        lines += [f"- {r}: {why}" for r, why in broken]
    return Result("\n".join(lines))


async def write_document(t: Any, args: dict[str, Any]) -> Result:
    text = str(args.get("text") or "").strip()
    if not text.startswith("# "):
        return Result("the report starts with its `# ` title", True)
    return _saved(t, report.save(t.ws, text, by=t.maker()))


async def edit_document(t: Any, args: dict[str, Any]) -> Result:
    md = report.markdown(t.ws) or ""
    old, new = str(args.get("old_text") or ""), str(args.get("new_text") or "")
    if not old:
        return Result("old_text is empty: name the words to change, as the report holds them (read_document)", True)
    n = md.count(old)
    if n == 0:
        return Result("the report does not hold old_text word for word: read it again with read_document", True)
    if n > 1:
        return Result(f"the report holds old_text {n} times: give more of the words around it", True)
    md = md.replace(old, new, 1).strip()
    if not md.startswith("# "):
        return Result("the report starts with its `# ` title, and this change would remove it", True)
    return _saved(t, report.save(t.ws, md, by=t.maker()))


# ---- after the chat agent's turn: a write the analyst asked for has ended

def _after_turn(session: Any, answer: str, result: str | None) -> None:
    if session.chat != "main" or report.state(session.ws).get("status") != "generating":
        return
    report.set_status(session.ws, "failed" if result in ("failed", "stopped", "refused") else "generated")


def write_request(text: str) -> str:
    """What the chat shows and Claude reads when the analyst asks for the report from the Report tab."""
    text = " ".join(text.split())
    return f"Write the report: {text}" if text else "Write the report."


# ---- the routes

def register(ctx: Any) -> None:
    app = ctx.app
    exports.register(ctx)
    agent.AFTER_TURN.append(_after_turn)

    def doc_slug(slug: str) -> str:
        if slug != report.DOC:
            raise HTTPException(404, f"thimble browser has one document, the report, not {slug!r}")
        return slug

    @app.get("/api/ws/{c}/investigations/main/types")
    def doc_types(c: str) -> dict[str, Any]:
        return report.types(ctx.ws_of(c))

    @app.get("/api/ws/{c}/investigations/main/types/{slug}")
    def doc_get(c: str, slug: str) -> dict[str, Any]:
        doc_slug(slug)
        got = report.writeup(ctx.ws_of(c))
        if got is None:
            raise HTTPException(404, "the report is empty")
        return got

    @app.put("/api/ws/{c}/investigations/main/types/{slug}/blocks")
    def doc_blocks(c: str, slug: str, body: dict = Body(...)) -> dict[str, Any]:
        doc_slug(slug)
        return report.from_blocks(ctx.ws_of(c), str(body.get("title") or ""), list(body.get("blocks") or []))

    @app.post("/api/ws/{c}/write")
    async def write(c: str, body: dict = Body(...)) -> dict[str, Any]:
        ws = ctx.ws_of(c)
        doc_slug(str(body.get("doc") or report.DOC))
        main = ctx.sessions.get(ws, "main")
        if main.running:
            return {"chat": "main", "kind": "busy", "reason": "Claude is still answering in the chat"}
        text = write_request(str(body.get("text") or ""))
        report.set_status(ws, "generating")
        try:
            await main.send(text)
        except RuntimeError as e:
            report.set_status(ws, "idle")
            raise HTTPException(409, str(e)) from None
        chats.hub.publish(ws, {"type": "chat", "chat": "main"})
        return {"chat": "main"}


FEATURE = Feature(
    name="report",
    title="Report",
    does="A document you write with Claude: your notes and the cards you place, written up when you ask.",
    register=register,
    tools={"read_document": read_document, "write_document": write_document, "edit_document": edit_document},
    main_tools=("read_document", "write_document", "edit_document"),
    prompt="report.md",
    page=("report",),
)
