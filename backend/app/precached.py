"""A workspace `thimble demo` installed from a pre-cache (demo.py): its orientation ran in advance, on the same files.
From the outputs alone (`thimble demo --export --outputs-only`, what demos/ holds) its Claude Code session was not
kept; from a full export it was, and the mark says `kept`.

The mark. demo.install writes MARKER (precached.json) in the workspace, and `precached` in the orientation's record
and in its thread's meta. The browser reads the meta: the thread says the orientation ran in advance and offers to
attach a fresh session (frontend chat/Precached.tsx), and while no session was ever attached the page stays open to
read rather than greyed under the card that asks for one (shell/SessionGone). When the session was not kept, a message
to the orientation is refused with `Precached` (orient_session.message); when it was, the record keeps its session and
a message resumes it.

The context. A session attached to the workspace starts fresh, so /thimble (cli.cmd_ensure) gives it what the
orientation left as its context, once per session: POST /api/ws/{c}/precached/context {session} answers with
context_text the first time a session asks, and with '' after that, for a workspace not pre-cached, or once a new
orientation has replaced the pre-cache's (its record no longer is_installed_run). The sessions given it are kept in the
mark's `context_given`.
"""
from __future__ import annotations

import json
import logging
import threading
from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel

from . import config

log = logging.getLogger("thimble.precached")
router = APIRouter()

MARKER = "precached.json"
CONTEXT_CHARS = 200_000  # of the context given a session; the canvas and the documents' text rarely come near it
DOCUMENT_CHARS = 60_000  # of one document's text in it
GIVEN_KEPT = 50  # sessions remembered in `context_given`
_lock = threading.Lock()


class Precached(RuntimeError):
    """The orientation ran in advance and its session was not kept, so it takes no message."""


def read(c: str) -> dict[str, Any] | None:
    """The workspace's mark, None when it was not installed from a pre-cache."""
    try:
        mark = json.loads((config.workspace_path(c) / MARKER).read_text("utf-8"))
    except (OSError, ValueError, LookupError):
        return None
    return mark if isinstance(mark, dict) else None


def is_precached_run(rec: dict[str, Any] | None) -> bool:
    """Whether an orientation's record is a pre-cache's that takes no follow-up: marked, with no session of its own."""
    return bool(rec and rec.get("precached") and not rec.get("session"))


def is_installed_run(rec: dict[str, Any] | None) -> bool:
    """Whether an orientation's record is the one `thimble demo` installed, with its session or without; a new
    orientation writes a record of its own."""
    return bool(rec and rec.get("precached"))


def made_text(mark: dict[str, Any]) -> str:
    """When and with what the orientation ran, in a few words: `on 2026-10-05 with claude-opus-5-5`."""
    when = str(mark.get("ran") or mark.get("created") or "")[:10]
    model = str(mark.get("model") or "").replace("[1m]", "")
    return " ".join(x for x in (f"on {when}" if when else "", f"with {model}" if model else "")) or "in advance"


def documents_text(c: str) -> str:
    """The full text of each written document, under its ref, each cut to DOCUMENT_CHARS."""
    from . import investigation, report_types  # noqa: PLC0415

    blocks = []
    for t in report_types.list_types(c):
        slug = str(t.get("slug") or "")
        doc = report_types.read_doc(c, investigation.MAIN, slug) if slug else None
        if not doc:
            continue
        text = "\n".join(report_types.document_lines(doc))
        if len(text) > DOCUMENT_CHARS:
            text = text[:DOCUMENT_CHARS] + f"\n… (cut; read_ref report:{slug} reads it whole)"
        blocks.append(f"### report:{slug}\n\n{text}")
    return "\n\n".join(blocks)


def context_text(c: str) -> str:
    """What a fresh session on a pre-cached workspace starts from: the lead (prompts/tools.md `precached-context`), then
    the canvas, the views and the documents as the context engine renders them, and each written document's text."""
    from . import context, tools  # noqa: PLC0415

    mark = read(c) or {}
    lead = "precached-context-kept" if mark.get("kept") else "precached-context"
    parts = [tools.hint(lead, made=made_text(mark)).strip(),
             context.render(c, budget=CONTEXT_CHARS, parts=("canvas", "views", "documents"))]
    docs = documents_text(c)
    if docs:
        parts.append("## The documents' text\n\n" + docs)
    text = "\n\n".join(p for p in parts if p)
    return text if len(text) <= CONTEXT_CHARS else text[:CONTEXT_CHARS] + "\n… (cut)"


def take_context(c: str, session: str) -> str:
    """context_text the first time `session` asks on a pre-cached workspace, else ''; the session is remembered."""
    from . import orientation  # noqa: PLC0415
    from .ledger import atomic_write_text  # noqa: PLC0415

    with _lock:
        mark = read(c)
        if mark is None or not is_installed_run(orientation.read_run(c)):
            return ""
        given = [str(s) for s in mark.get("context_given") or []]
        if session and session in given:
            return ""
        if session:
            mark["context_given"] = (given + [session])[-GIVEN_KEPT:]
            try:
                atomic_write_text(config.workspace_path(c) / MARKER, json.dumps(mark, ensure_ascii=False, indent=1))
            except OSError as e:
                log.warning("could not note that session %s had the pre-cache's context: %s", session, e)
    try:
        return context_text(c)
    except Exception:  # noqa: BLE001 — /thimble must open the workspace even when the context cannot be rendered
        log.exception("the pre-cached context of %s could not be rendered", c)
        return ""


class ContextBody(BaseModel):
    session: str = ""


@router.post("/ws/{c}/precached/context")
async def context_route(c: str, body: ContextBody) -> dict[str, Any]:
    """The context a fresh session on a pre-cached workspace starts from (take_context): {text}, '' when there is none
    to give."""
    import asyncio  # noqa: PLC0415

    config.workspace_path(c)
    return {"text": await asyncio.to_thread(take_context, c, body.session.strip()[:128])}
