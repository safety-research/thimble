"""A card's size. The canvas shows BODY_MAX px of a card's body at rest (frontend canvas/DataViz CARD_BODY_MAX); a body
drawn taller shows that much and Show all. Two places measure a body at the card's width: the page, when it draws a
custom card's page (POST /ws/{c}/cells/{cid}/drawn), and the card check's render (render.Rendered.body, card_check).
A body past BODY_MAX is told to the card's author, once for each version of the card, with the author's next thimble
tool result (tools.call, with_notes), in the words of prompts/tools.md `## card-tall`, as the terminal's card tool tells
Claude that a card is taller than the screen. The author is the card's `created_by`, which is the cell_author of the
calls of the session that made it; a card the analyst made by hand has no author to tell."""
from __future__ import annotations

import hashlib
import json
import logging
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

log = logging.getLogger("thimble.card_size")

BODY_MAX = 800  # px of a card's body the canvas shows at rest: frontend canvas/DataViz CARD_BODY_MAX
HINT = "card-tall"
BY_HAND = frozenset({"", "user"})  # created_by of a card the analyst made: no session to tell
KEPT = 50  # notes kept for one author before its next call; the oldest go first

_told: dict[tuple[str, str], str] = {}  # (workspace, card) -> the version of the card told
_notes: dict[tuple[str, str], dict[str, str]] = {}  # (workspace, author) -> {card: the note}, oldest first


def version(cell: dict[str, Any]) -> str:
    """What the card draws from: its kind, code, payload, outputs' count and width. A new version is told again."""
    raw = json.dumps([cell.get("kind"), cell.get("code"), cell.get("payload"), len(cell.get("outputs") or []),
                      cell.get("width")], sort_keys=True, default=str)
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:16]


def tell(c: str, cell: dict[str, Any] | None, height: float | int | None) -> bool:
    """Keep the note for the author of `cell` when its body draws `height` px tall, past BODY_MAX; True when a note was
    kept now (not for a version already told, a card made by hand, or a body that fits)."""
    if not cell or not isinstance(height, (int, float)) or height <= BODY_MAX:
        return False
    author = str(cell.get("created_by") or "")
    cid = str(cell.get("id") or "")
    if author in BY_HAND or not cid:
        return False
    v = version(cell)
    if _told.get((c, cid)) == v:
        return False
    _told[(c, cid)] = v
    from .tools import hint  # noqa: PLC0415 — tools imports this module

    note = hint(HINT, cid=cid, height=int(round(height)), limit=BODY_MAX)
    if not note:
        return False
    notes = _notes.setdefault((c, author), {})
    notes.pop(cid, None)
    notes[cid] = note
    while len(notes) > KEPT:
        notes.pop(next(iter(notes)))
    log.info("%s: card:%s draws %d px tall; told to %s with its next call", c, cid, height, author)
    return True


def take(c: str, author: str) -> list[str]:
    """The notes waiting for `author`, and no longer waiting."""
    return list((_notes.pop((c, author), None) or {}).values())


def with_notes(c: str, author: str, res: Any) -> Any:
    """`res` (a tools.ToolResult) with the notes waiting for `author` after its text."""
    notes = take(c, author)
    if not notes:
        return res
    extra = "\n\n".join(notes)
    for b in res.content:
        if b.get("type") == "text":
            b["text"] = f"{b.get('text', '')}\n\n{extra}" if str(b.get("text", "")) else extra
            return res
    res.content.append({"type": "text", "text": extra})
    return res


def forget(c: str) -> None:
    """The workspace's notes and versions told, gone (tests; a workspace removed)."""
    for d in (_told, _notes):
        for k in [k for k in d if k[0] == c]:
            d.pop(k, None)


# --------------------------------------------------------------------------- the page's measure


class Drawn(BaseModel):
    height: float


router = APIRouter()


@router.post("/ws/{c}/cells/{cid}/drawn")
async def drawn_route(c: str, cid: str, body: Drawn) -> dict[str, bool]:
    """The page drew card `cid`'s body `height` px tall at the card's width (DataViz CustomFrame): past BODY_MAX, its
    author is told with its next call. 404 for a card that does not exist."""
    from . import notebook  # noqa: PLC0415

    try:
        cell = notebook.get_cell(c, cid)
    except ValueError as e:
        raise HTTPException(404, str(e))
    if cell is None:
        raise HTTPException(404, f"no card {cid}")
    return {"told": tell(c, cell, body.height)}
