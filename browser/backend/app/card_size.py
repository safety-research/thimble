"""A card's size. About BODY_MAX px of a card's body fit on one laptop screen with its question and takeaway (frontend
canvas/DataViz CARD_BODY_MAX), and a custom card's page taller than that shows that much and Show all. Two places
measure a body at the card's width: the page, when it draws a custom card's page (POST /ws/{c}/cells/{cid}/drawn), and
the card check's render of a card of any kind (render.Rendered.body, card_check).
A body past BODY_MAX is told to the card's author, once for each version of the card, with the author's next thimble
tool result (tools.call, with_notes), in the words of prompts/tools.md `## card-tall`, as the terminal's card tool tells
Claude that a card is taller than the screen. A custom card's page that lays out wider than its frame, which the page
measures as it measures the height, is told the same way, in the words of `## card-wide`, with the page's width and the
frame's. A note keeps the version it was measured on, and is dropped when the card is gone or is another version by
the author's next call. The author is the card's `created_by`, which is the cell_author of the calls of the session
that made it; a card the analyst made by hand has no author to tell."""
from __future__ import annotations

import hashlib
import json
import logging
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

log = logging.getLogger("thimble.card_size")

BODY_MAX = 800  # px of a card's body that fit on a laptop screen with its question and takeaway: DataViz CARD_BODY_MAX
HINT = "card-tall"
WIDE = "card-wide"
BY_HAND = frozenset({"", "user"})  # created_by of a card the analyst made: no session to tell
KEPT = 50  # notes kept for one author before its next call; the oldest go first

_told: dict[tuple[str, str, str], str] = {}  # (workspace, card, hint) -> the version of the card told
# (workspace, author) -> {(card, hint): (the version measured, the note)}, oldest first
_notes: dict[tuple[str, str], dict[tuple[str, str], tuple[str, str]]] = {}


def version(cell: dict[str, Any]) -> str:
    """What the card draws from: its kind, code, payload, outputs' count and width. A new version is told again."""
    raw = json.dumps([cell.get("kind"), cell.get("code"), cell.get("payload"), len(cell.get("outputs") or []),
                      cell.get("width")], sort_keys=True, default=str)
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:16]


def _due(c: str, cell: dict[str, Any], kind: str) -> tuple[str, str, str] | None:
    """(author, card, version) when `cell`'s note of `kind` (a hint's name) is due: it has an author to tell and its
    version was not told that note yet, which it now counts as told; else None."""
    author = str(cell.get("created_by") or "")
    cid = str(cell.get("id") or "")
    if author in BY_HAND or not cid:
        return None
    v = version(cell)
    if _told.get((c, cid, kind)) == v:
        return None
    _told[(c, cid, kind)] = v
    return author, cid, v


def _keep(c: str, author: str, cid: str, v: str, kind: str, note: str) -> bool:
    """Keep `note` for `author`'s next call, in place of the card's earlier note of `kind`; False for no note."""
    if not note:
        return False
    notes = _notes.setdefault((c, author), {})
    notes.pop((cid, kind), None)
    notes[(cid, kind)] = (v, note)
    while len(notes) > KEPT:
        notes.pop(next(iter(notes)))
    return True


def tell(c: str, cell: dict[str, Any] | None, height: float | int | None) -> bool:
    """Keep the note for the author of `cell` when its body draws `height` px tall, past BODY_MAX; True when a note was
    kept now (not for a version already told, a card made by hand, or a body that fits)."""
    if not cell or not isinstance(height, (int, float)) or height <= BODY_MAX:
        return False
    due = _due(c, cell, HINT)
    if not due:
        return False
    from .tools import hint  # noqa: PLC0415 — tools imports this module

    author, cid, v = due
    if not _keep(c, author, cid, v, HINT, hint(HINT, cid=cid, height=int(round(height)), limit=BODY_MAX)):
        return False
    log.info("%s: card:%s draws %d px tall; told to %s with its next call", c, cid, height, author)
    return True


def tell_wide(c: str, cell: dict[str, Any] | None, width: float | int | None, frame: float | int | None) -> bool:
    """Keep the note for the author of `cell` when its page lays out `width` px wide in its frame `frame` px wide (the
    card's width less its sides), wider than the frame; True when a note was kept now (not for a version already told,
    a card made by hand, or a page that fits)."""
    if not cell or not isinstance(width, (int, float)) or not isinstance(frame, (int, float)) or frame <= 0:
        return False
    if width <= frame + 1:  # as the page measures it: a px of rounding is no overflow
        return False
    due = _due(c, cell, WIDE)
    if not due:
        return False
    from .tools import hint  # noqa: PLC0415 — tools imports this module

    author, cid, v = due
    if not _keep(c, author, cid, v, WIDE, hint(WIDE, cid=cid, width=int(round(width)), frame=int(round(frame)))):
        return False
    log.info("%s: card:%s lays out %d px wide in %d px; told to %s with its next call", c, cid, width, frame, author)
    return True


def take(c: str, author: str) -> list[str]:
    """The notes waiting for `author`, and no longer waiting: each whose card is still the version it was measured on.
    A card deleted, or changed into another version, since then is no longer what its note says, so its note is
    dropped, and that version counts as not told (the card changed back to it is told again)."""
    from . import notebook  # noqa: PLC0415

    out = []
    for (cid, kind), (v, note) in (_notes.pop((c, author), None) or {}).items():
        try:
            cell = notebook.get_cell(c, cid)
        except Exception:  # noqa: BLE001 — a workspace that is gone: so is its card
            cell = None
        if cell is not None and version(cell) == v:
            out.append(note)
        elif _told.get((c, cid, kind)) == v:
            _told.pop((c, cid, kind), None)
    return out


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
    height: float | None = None
    width: float | None = None
    frame: float | None = None


router = APIRouter()


@router.post("/ws/{c}/cells/{cid}/drawn")
async def drawn_route(c: str, cid: str, body: Drawn) -> dict[str, bool]:
    """The page drew card `cid`'s body `height` px tall at the card's width, or its page `width` px wide in a frame
    `frame` px wide (DataViz CustomFrame): past BODY_MAX, or wider than the frame, its author is told with its next
    call. `told`: whether a note was kept now. 404 for a card that does not exist."""
    from . import notebook  # noqa: PLC0415

    try:
        cell = notebook.get_cell(c, cid)
    except ValueError as e:
        raise HTTPException(404, str(e))
    if cell is None:
        raise HTTPException(404, f"no card {cid}")
    tall = tell(c, cell, body.height)
    wide = tell_wide(c, cell, body.width, body.frame)
    return {"told": tall or wide}
