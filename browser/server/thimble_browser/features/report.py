"""The report, and the other documents the person makes with New: each a document the analyst owns from the start.
They type notes and headings into it and place cards in it; Claude, the chat agent, writes or revises it when they ask,
in the Report tab ("Write", with instructions) or in the chat, and keeps their notes and the cards they placed. Each
block Claude writes or changes is marked as Claude's until the analyst edits it (report.attribute).

It owns the documents' routes (report.py keeps them, exports.py their exports), the tools read_document,
write_document and edit_document, the `Report` part of the chat agent's prompt (prompts/report.md) and, on the page,
the Report tab and the documents' figures.

    GET  /api/ws/{c}/investigations/main/types              each document: written or not, its name, writing now
    GET  …/types/{slug}                                      a document as the page reads it (empty before any write)
    PUT  …/types/{slug}/blocks                               the editor's blocks, saved as the document
    GET  …/types/{slug}/versions                             the drafts kept around Claude's changes (History)
    GET  …/types/{slug}/versions/{n}                         one of them, as the page reads a document
    POST …/types/{slug}/versions/{n}/restore                 make it the document again, as the person's own save
    POST /api/ws/{c}/report-types/new                        {name}: a new document, empty
    PUT  /api/ws/{c}/report-types/{slug}                     {name}: rename a document of the person's own
    DELETE /api/ws/{c}/report-types/{slug}                   delete one, with its drafts
    POST /api/ws/{c}/write                                  {doc?, text, after_text?}: ask Claude to write or revise a
                                                            document, in the chat; `after_text` is the passage a
                                                            request placed in the document follows
"""
from __future__ import annotations

import logging
from typing import Any

from fastapi import Body, HTTPException

from .. import agent, chats, exports, prompts, report
from ..tools import Result
from . import Feature

log = logging.getLogger("thimble_browser.report")


# ---- the tools

def _doc(t: Any, args: dict[str, Any]) -> tuple[str, str]:
    """The document a call names (`doc`, the report when none) and its name, as the results say it."""
    slug = str(args.get("doc") or report.DOC)
    if not report.exists(t.ws, slug):
        raise KeyError(slug)
    return slug, ("the report" if slug == report.DOC else f'the document "{report.name_of(t.ws, slug)}"')


def _no_doc(t: Any, slug: Any) -> Result:
    names = ", ".join(d["slug"] for d in report.documents(t.ws))
    return Result(f"no document {slug!r}: the documents are {names}", True)


GUIDE_HEAD = "# Writing a report"


def _guide_given(t: Any) -> bool:
    """Whether this chat's conversation holds the writing guide already: a thread holds what main was given before it
    branched."""
    for m in agent.load_messages(t.ws, t.chat):
        for b in m.get("content") or [] if isinstance(m.get("content"), list) else []:
            c = b.get("content") if isinstance(b, dict) and b.get("type") == "tool_result" else None
            text = c if isinstance(c, str) else " ".join(x.get("text", "") for x in c or [] if isinstance(x, dict))
            if GUIDE_HEAD in text:
                return True
    return False


async def read_document(t: Any, args: dict[str, Any]) -> Result:
    """The report as it stands; the first time a chat reads one, the guide to writing a report (prompts/report-guide.md)
    comes after it, so the guide is read when it is used and not with every request."""
    try:
        slug, what = _doc(t, args)
    except KeyError as e:
        return _no_doc(t, e.args[0])
    md = report.markdown(t.ws, slug)
    if md is None or not md.strip().strip("#").strip():
        text = f"{what[0].upper()}{what[1:]} is empty: the analyst has written nothing in it yet."
    else:
        text = md
    if not _guide_given(t):
        text += "\n\n---\n\n" + prompts.render("report-guide.md")
    return Result(text)


def _saved(t: Any, doc: dict[str, Any], what: str) -> Result:
    refs = [r for sec in doc["sections"] for p in sec["paragraphs"] for s in p["sentences"] for r in s["refs"]]
    figs = [f for sec in doc["sections"] for f in sec.get("figures", [])]
    broken = [(r, why) for r in dict.fromkeys(refs) if (why := t.opens(r))]
    broken += [(f"card:{f['cell']}", why) for f in figs if (why := t.opens(f"card:{f['cell']}"))]
    lines = [f"Saved {what}: {len(doc['sections'])} sections, {len(figs)} figures, {len(refs)} citations."]
    if broken:
        lines.append("These citations do not open; fix each and save again:")
        lines += [f"- {r}: {why}" for r, why in broken]
    return Result("\n".join(lines))


async def write_document(t: Any, args: dict[str, Any]) -> Result:
    try:
        slug, what = _doc(t, args)
    except KeyError as e:
        return _no_doc(t, e.args[0])
    text = str(args.get("text") or "").strip()
    if not text.startswith("# "):
        return Result(f"{what} starts with its `# ` title", True)
    return _saved(t, report.save(t.ws, text, by=t.maker(), slug=slug), what)


async def edit_document(t: Any, args: dict[str, Any]) -> Result:
    try:
        slug, what = _doc(t, args)
    except KeyError as e:
        return _no_doc(t, e.args[0])
    md = report.markdown(t.ws, slug) or ""
    old, new = str(args.get("old_text") or ""), str(args.get("new_text") or "")
    if not old:
        return Result("old_text is empty: name the words to change, as the document holds them (read_document)", True)
    n = md.count(old)
    if n == 0:
        return Result(f"{what} does not hold old_text word for word: read it again with read_document", True)
    if n > 1:
        return Result(f"{what} holds old_text {n} times: give more of the words around it", True)
    md = md.replace(old, new, 1).strip()
    if not md.startswith("#") or md.startswith("##"):
        return Result(f"{what} starts with its `# ` title, and this change would remove it", True)
    return _saved(t, report.save(t.ws, md, by=t.maker(), slug=slug), what)


# ---- after the chat agent's turn

def _after_turn(session: Any, answer: str, result: str | None) -> None:
    """After a turn that changed a document, its new draft is kept as a version; a write asked for in the Report tab
    ends as generated or failed."""
    for d in report.documents(session.ws):
        slug = d["slug"]
        st = report.state(session.ws, slug)
        if st.get("by") not in (None, "analyst") and str(st.get("generated_at") or "") >= str(session.started_at or ""):
            report.keep_version(session.ws, report.markdown(session.ws, slug), by=str(st.get("by")), slug=slug,
                                instructions=st.get("instructions"))
        if session.chat == "main" and st.get("status") == "generating":
            report.set_status(session.ws, "failed" if result in ("failed", "stopped", "refused") else "generated",
                              slug, instructions=None)


def write_request(text: str, after: str = "", slug: str = report.DOC, name: str = "") -> str:
    """What the chat shows and Claude reads when the analyst asks for a document from the Report tab: their
    instructions, and for a request they placed in the document, the passage it follows."""
    text = " ".join(text.split())
    what = "the report" if slug == report.DOC else f'the document "{name}" (doc: {slug})'
    head = f"Write {what}: {text}" if text else f"Write {what}."
    after = " ".join(after.split())[:400]
    return f'{head}\n(I put this request in it after the passage "{after}".)' if after else head


def version_doc(ws: str, slug: str, n: int) -> dict[str, Any]:
    row = next((v for v in report.versions(ws, slug) if v.get("n") == n), None)
    if row is None:
        raise HTTPException(404, f"no draft {n}")
    return {"id": slug, **report.parse(str(row.get("md") or "")), "generation": n, "frame": False, "comments": []}


# ---- the routes

def register(ctx: Any) -> None:
    app = ctx.app
    exports.register(ctx)
    agent.AFTER_TURN.append(_after_turn)

    def doc_of(c: str, slug: str) -> str:
        ws = ctx.ws_of(c)
        if not report.exists(ws, slug):
            raise HTTPException(404, f"no document {slug!r}")
        return ws

    @app.get("/api/ws/{c}/investigations/main/types")
    def doc_types(c: str) -> dict[str, Any]:
        return report.types(ctx.ws_of(c))

    @app.get("/api/ws/{c}/investigations/main/types/{slug}")
    def doc_get(c: str, slug: str) -> dict[str, Any]:
        return report.writeup(doc_of(c, slug), slug)

    @app.put("/api/ws/{c}/investigations/main/types/{slug}/blocks")
    def doc_blocks(c: str, slug: str, body: dict = Body(...)) -> dict[str, Any]:
        return report.from_blocks(doc_of(c, slug), str(body.get("title") or ""), list(body.get("blocks") or []), slug)

    @app.get("/api/ws/{c}/investigations/main/types/{slug}/versions")
    def doc_versions(c: str, slug: str) -> dict[str, Any]:
        ws = doc_of(c, slug)
        rows = report.versions(ws, slug)
        current = report.markdown(ws, slug)
        return {"slug": slug, "generation": len(rows), "versions": [
            {"n": v["n"], "ts": v.get("ts") or "", "source": "analyst" if v.get("by") == "analyst" else str(v.get("by")),
             "instructions": v.get("instructions"), "summary": [], "summary_from": None, "run": None,
             "current": v.get("md") == current, "available": True, "words": len(str(v.get("md") or "").split()),
             "writer": None, "revisions": []} for v in rows]}

    @app.get("/api/ws/{c}/investigations/main/types/{slug}/versions/{n}")
    def doc_version(c: str, slug: str, n: int) -> dict[str, Any]:
        return version_doc(doc_of(c, slug), slug, n)

    @app.post("/api/ws/{c}/investigations/main/types/{slug}/versions/{n}/restore")
    def doc_restore(c: str, slug: str, n: int) -> dict[str, Any]:
        ws = doc_of(c, slug)
        row = next((v for v in report.versions(ws, slug) if v.get("n") == n), None)
        if row is None:
            raise HTTPException(404, f"no draft {n}")
        report.keep_version(ws, report.markdown(ws, slug), by=str(report.state(ws, slug).get("by") or "analyst"),
                            slug=slug)
        return report.save(ws, str(row.get("md") or ""), by="analyst", slug=slug)

    def type_row(ws: str, d: dict[str, Any]) -> dict[str, Any]:
        return {"slug": d["slug"], "name": d["name"], "description": "", "renderer": "document",
                "builtin": d["slug"] == report.DOC}

    @app.post("/api/ws/{c}/report-types/new")
    def doc_new(c: str, body: dict = Body(...)) -> dict[str, Any]:
        ws = ctx.ws_of(c)
        if str(body.get("kind") or "document") != "document":
            raise HTTPException(400, "thimble browser makes documents: a name is all a new one needs")
        return type_row(ws, report.create(ws, str(body.get("name") or "")))

    @app.put("/api/ws/{c}/report-types/{slug}")
    def doc_rename(c: str, slug: str, body: dict = Body(...)) -> dict[str, Any]:
        ws = ctx.ws_of(c)
        try:
            return type_row(ws, report.rename(ws, slug, str(body.get("name") or "")))
        except KeyError:
            raise HTTPException(404, f"no document of your own {slug!r}") from None
        except ValueError as e:
            raise HTTPException(400, str(e)) from None

    @app.delete("/api/ws/{c}/report-types/{slug}")
    def doc_delete(c: str, slug: str) -> dict[str, bool]:
        ws = ctx.ws_of(c)
        try:
            report.delete(ws, slug)
        except KeyError:
            raise HTTPException(404, f"no document of your own {slug!r}") from None
        return {"ok": True}

    @app.post("/api/ws/{c}/write")
    async def write(c: str, body: dict = Body(...)) -> dict[str, Any]:
        slug = str(body.get("doc") or report.DOC)
        ws = doc_of(c, slug)
        main = ctx.sessions.get(ws, "main")
        if main.running:
            return {"chat": "main", "kind": "busy", "reason": "Claude is still answering in the chat"}
        text = write_request(str(body.get("text") or ""), str(body.get("after_text") or ""), slug,
                             report.name_of(ws, slug))
        report.set_status(ws, "generating", slug, instructions=" ".join(str(body.get("text") or "").split()) or None)
        try:
            await main.send(text)
        except RuntimeError as e:
            report.set_status(ws, "idle", slug)
            raise HTTPException(409, str(e)) from None
        chats.hub.publish(ws, {"type": "chat", "chat": "main"})
        return {"chat": "main"}


FEATURE = Feature(
    name="report",
    title="Report",
    does="Documents you write with Claude: your notes and the cards you place, written up when you ask.",
    register=register,
    tools={"read_document": read_document, "write_document": write_document, "edit_document": edit_document},
    main_tools=("read_document", "write_document", "edit_document"),
    prompt="report.md",
    page=("report",),
)
