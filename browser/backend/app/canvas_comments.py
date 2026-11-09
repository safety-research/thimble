"""Comments on the canvas: a note beside a card, which a check's run over the cards leaves (checks.py, the run target
CANVAS) or main leaves with add_comment. The analyst reads each beside its card while its check is on, and Done resolves
it, which hides it.

The store is `workspaces/<c>/canvas-comments.json` = {comments: [Comment]}, changed under its lock (ledger.update_json).
A comment has the fields a document's comment has, with `card` in place of `sentence_id`:

    {id, card, check, run, author, text, details, evidence, fp, ts, status, resolution}

`author` is `check` for a run's comment and `claude` for main's. Every comment is a short statement, `text`, which the
analyst reads first, and optional `details`, which they open on request: `text` has its citations flattened for
reading, `details` keeps them as chips, and both cite into `evidence`. A leading copy of its check's name with a colon is
dropped, since a comment shows its check's name. `status` is `open` or `dismissed` (report.SETTLED_STATUS) and
`resolution` says why: `done` (the analyst's Done) or `superseded` (a later run of its check covered its card). A
comment on a card that is gone is not served. A comment of thimble 0.10.11 or before on a step of a plan card (`step`)
stands beside the card, which reads as a note now (notebook._normalize_cell).

The passages of the canvas (passages()) are the cards a check covers, in the tree's order: the cards of the analyst's
groups and the threads' (not the orientation's deck, a document's figures or labels' cards). A card is fingerprinted on
what a reader of it sees (checkstore.basis). Each change emits `canvas-comments` on the workspace's stream.
"""
from __future__ import annotations

import logging
import math
import re
import secrets
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException

from . import cite, config, investigation
from .ledger import read_json, update_json

log = logging.getLogger("thimble.canvas_comments")
router = APIRouter()

FILE = "canvas-comments.json"
CANVAS = "@canvas"  # the run target of a check over the cards, among a check's runs beside the documents' slugs
EVENT = "canvas-comments"  # the stream record a change emits
RESOLUTION_DONE = "done"  # the analyst's Done, or main's resolve_comment
RESOLUTION_SUPERSEDED = "superseded"
SETTLED = "dismissed"  # report.SETTLED_STATUS
CLAUDE = "claude"
COVERED_ROLES = ("analyst",)  # notebook.DEFAULT_ROLE: the analyst's groups and every thread's
SKIPPED_KINDS = ("label",)  # a label's card is the label's review, which its own pane shows
DETAILS_CHARS = 2_000  # of a comment's details, kept
WHOLE_AUTHORS = ("analyst", "terminal")  # the analyst's own comments, read whole: never split into statement and details
_REF_RE = re.compile(r"^(?:card|cell):([A-Za-z0-9_-]+)$")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _collapse(v: Any) -> str:
    return " ".join(str(v or "").split())


def _path(c: str) -> Path:
    return config.workspace_dir(c) / FILE


# --------------------------------------------------------------------------- what a comment says


def _untagged(text: str, name: str = "") -> str:
    """`text` on one line without a leading copy of its check's name `name` and a colon, such as "Judgment calls: …" (in
    bold or not), its first letter capitalized when the name stood before it."""
    text, name = _collapse(text), _collapse(name)
    m = re.match(r"\**\s*" + re.escape(name) + r"\s*\**\s*:\s*\**\s*", text, re.I) if name else None
    if not m:
        return text
    rest = text[m.end():].strip()
    lead = "**" if rest.startswith("**") else ""
    rest = rest[len(lead):]
    return lead + rest[:1].upper() + rest[1:]


def clean_details(details: Any) -> str:
    """A comment's details as kept: its lines without trailing space, no run of blank lines, cut at DETAILS_CHARS."""
    lines = [ln.rstrip() for ln in str(details or "").replace("\r\n", "\n").replace("\r", "\n").split("\n")]
    out = re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()
    return out if len(out) <= DETAILS_CHARS else out[:DETAILS_CHARS].rstrip() + " …"


def note_of(cm: dict[str, Any], name: str = "") -> dict[str, str]:
    """{text, details} of a stored comment as the analyst reads it: its statement and its details. The analyst's own
    comment is whole; a check's or Claude's is its `text` without a leading copy of its check's name `name`."""
    text = str(cm.get("text") or "")
    if str(cm.get("author") or "") in WHOLE_AUTHORS:
        return {"text": _collapse(text), "details": clean_details(cm.get("details"))}
    return {"text": _untagged(text, name), "details": clean_details(cm.get("details"))}


# --------------------------------------------------------------------------- the cards a check covers


def parse_ref(ref: str) -> str | None:
    """The card id of `card:<id>`; None for another ref."""
    m = _REF_RE.match(str(ref or "").strip().strip("[]").strip())
    return m.group(1) if m else None


def card_ref(card: str) -> str:
    return f"card:{card}"


def _card_fp(cell: dict[str, Any]) -> str:
    from . import checkstore  # noqa: PLC0415 — checkstore imports the notebook lazily

    return "c" + checkstore.basis(cell)


def _changed(cell: dict[str, Any]) -> str:
    """When the card last changed: its latest of created, run and edited."""
    stamps = [str(cell.get("created_ts") or ""), str(cell.get("ts") or "")]
    stamps += [str(e.get("ts") or "") for e in cell.get("edited") or [] if isinstance(e, dict)]
    return max((s for s in stamps if s), key=_stamp, default="")


def _stamp(s: str) -> float:
    try:
        d = datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except ValueError:
        return 0.0
    if d.tzinfo is None:
        d = d.replace(tzinfo=timezone.utc)
    return d.timestamp()


def after(stamp: str, since: str | None) -> bool:
    """Whether `stamp` is at or after `since` (always, with no `since`), to the second: a card's times are kept to the
    second, so a card of the second `since` falls in counts."""
    return not since or _stamp(stamp) >= math.floor(_stamp(since))


def _covered_groups(c: str) -> list[tuple[dict, dict]]:
    """[(group row, group)] of the groups a check covers, in the tree's order: role analyst, under no exploration group
    (the orientation's deck) and not a document's figures."""
    from . import notebook  # noqa: PLC0415 — notebook imports the kernel machinery

    ws = config.workspace_dir(c)
    rows = notebook.tree_order(notebook.list_notebooks(ws, figures=False))
    by_id = {str(r["id"]): r for r in rows}

    def in_deck(r: dict) -> bool:
        seen: set[str] = set()
        cur: dict | None = r
        while cur is not None and str(cur["id"]) not in seen:
            seen.add(str(cur["id"]))
            if (cur.get("role") or notebook.DEFAULT_ROLE) not in COVERED_ROLES:
                return True
            cur = by_id.get(str(cur.get("parent") or ""))
        return False

    out = []
    for r in rows:
        if in_deck(r):
            continue
        nb = notebook.read_notebook(ws, str(r["id"]))
        if nb:
            out.append((r, nb))
    return out


def passages(c: str, since: str | None = None) -> list[dict[str, Any]]:
    """The passages of the canvas a check covers, in the tree's order: each card {ref, kind: card, card, fp, changed};
    with `since`, only the cards that changed at or after it (after), so a turn's end fingerprints only those. Every
    passage carries `locked` (never: the analyst's lock on a card keeps models from changing it, not from reading it),
    `anchor` (the card) and `ids` (its ref), as a document's passages do."""
    out: list[dict[str, Any]] = []
    try:
        groups = _covered_groups(c)
    except (OSError, ValueError):
        return out
    for _, nb in groups:
        for cell in nb.get("cells") or []:
            if not isinstance(cell, dict) or not cell.get("id") or cell.get("kind") in SKIPPED_KINDS:
                continue
            cid = str(cell["id"])
            changed = _changed(cell)
            if not after(changed, since):
                continue
            out.append({"card": cid, "changed": changed, "locked": False, "anchor": cid, "group": str(nb.get("id") or ""),
                        "ref": card_ref(cid), "kind": "card", "fp": _card_fp(cell), "ids": [card_ref(cid)]})
    return out


def passage_of(c: str, ref: str, ps: list[dict[str, Any]] | None = None) -> dict[str, Any] | None:
    """The passage `ref` names among the covered cards, or None."""
    card = parse_ref(ref)
    if card is None:
        return None
    return next((p for p in (passages(c) if ps is None else ps) if p["card"] == card), None)


def key_of(p: dict[str, Any]) -> str:
    """A passage's or a comment's key: its card."""
    return str(p.get("card") or "")


def card_lines(c: str, refs: list[str], ps: list[dict[str, Any]] | None = None) -> str:
    """The cards a canvas run covers, for its task: each card that has a passage in `refs` with its ref, kind and
    question, and its takeaway."""
    from . import notebook  # noqa: PLC0415

    ps = passages(c) if ps is None else ps
    want = set(refs)
    cards = list(dict.fromkeys(p["card"] for p in ps if p["ref"] in want))
    ws = config.workspace_dir(c)
    lines: list[str] = []
    for cid in cards:
        hit = notebook.find_cell(ws, cid)
        if hit is None:
            continue
        cell = hit[1]
        kind = str(cell.get("kind") or notebook.DEFAULT_KIND)
        lines.append(f"- card:{cid} · {kind} · {_collapse(cell.get('title')) or '(untitled)'}")
        takeaway = _collapse(cite.canon_text(str(cell.get("takeaway") or "")))
        if takeaway:
            lines.append(f"  takeaway: {takeaway}")
    return "\n".join(lines)


# --------------------------------------------------------------------------- the store


def _read(c: str) -> list[dict[str, Any]]:
    data = read_json(_path(c), {})
    items = data.get("comments") if isinstance(data, dict) else None
    return [x for x in items or [] if isinstance(x, dict) and x.get("id")]


def _change(c: str, fn: Any) -> Any:
    """Run `fn(comments)` on the stored list under the store's lock and write the list it leaves; returns what fn
    returns."""
    out: dict[str, Any] = {}

    def change(data: Any) -> Any:
        items = data.get("comments") if isinstance(data, dict) else None
        items = [x for x in items or [] if isinstance(x, dict) and x.get("id")]
        out["value"] = fn(items)
        return {"comments": items}

    update_json(_path(c), change, {"comments": []})
    return out.get("value")


def _emit(c: str, **extra: Any) -> None:
    try:
        investigation.emit(c, investigation.MAIN, {"type": EVENT, **extra})
    except Exception:  # noqa: BLE001 — the canvas reads the comments again on its next record
        log.debug("%s: canvas comments record not emitted", c, exc_info=True)


def _cards(c: str) -> dict[str, dict[str, Any]]:
    """{id: cell} of every card in the workspace."""
    from . import notebook  # noqa: PLC0415

    ws = config.workspace_dir(c)
    out: dict[str, dict[str, Any]] = {}
    for row in notebook.list_notebooks(ws):
        nb = notebook.read_notebook(ws, str(row["id"])) or {}
        for cell in nb.get("cells") or []:
            if isinstance(cell, dict) and cell.get("id"):
                out[str(cell["id"])] = cell
    return out


def _served(cm: dict[str, Any], cards: dict[str, dict[str, Any]], names: dict[str, str]) -> dict[str, Any] | None:
    """A comment as the browser and the tools read it, with its `ref` and its statement (`text`) and `details` as the
    analyst reads them (note_of, by its check's name in `names`); None when its card is gone."""
    if str(cm.get("card") or "") not in cards:
        return None
    kept = {k: v for k, v in cm.items() if k not in ("tag", "title", "body", "step")}
    note = note_of(cm, names.get(str(cm.get("check") or ""), ""))
    return {**kept, **note, "ref": card_ref(str(cm["card"]))}


def all_comments(c: str) -> list[dict[str, Any]]:
    """Every stored comment whose card is there, open or resolved, each with its `ref`."""
    from . import checks  # noqa: PLC0415 — checks imports this module

    stored = _read(c)
    if not stored:
        return []
    cards, names = _cards(c), checks.names(c)
    return [s for cm in stored if (s := _served(cm, cards, names)) is not None]


def open_comments(c: str, card: str | None = None) -> list[dict[str, Any]]:
    """The open comments whose card is there, in the order they were left, each with its `ref`; with `card`, that
    card's alone."""
    return [cm for cm in all_comments(c) if (cm.get("status") or "open") == "open" and (card is None or cm["card"] == card)]


def _new_id(used: set[str]) -> str:
    while True:
        i = "k" + secrets.token_hex(4)
        if i not in used:
            return i


def add(c: str, *, card: str, text: str, author: str, details: str = "", check: str | None = None,
        run: str | None = None, evidence: str = "", fp: str = "") -> tuple[dict[str, Any], bool]:
    """Store a comment, its statement `text` and its `details`, or find the same open one (same author, check, run,
    card and words). Returns (the comment, whether it is new)."""
    text, details = _collapse(text), clean_details(details)

    def fn(items: list[dict[str, Any]]) -> tuple[dict[str, Any], bool]:
        same = next((x for x in items if x.get("card") == card and x.get("author") == author
                     and x.get("check") == check and x.get("run") == run and (x.get("status") or "open") == "open"
                     and _collapse(x.get("text")) == text and clean_details(x.get("details")) == details), None)
        if same is not None:
            return same, False
        cm = {"id": _new_id({str(x["id"]) for x in items}), "card": card, "check": check, "run": run,
              "author": author, "text": text, "details": details, "evidence": evidence, "fp": fp, "ts": _now(),
              "status": "open", "resolution": None}
        items.append(cm)
        return cm, True

    cm, new = _change(c, fn)
    if new:
        _emit(c, card=card)
    return cm, new


def resolve(c: str, ids: list[str], by: str = "analyst") -> list[dict[str, Any]]:
    """Resolve the open comments `ids` as done, by `by`; returns the comments resolved."""
    want = set(ids)

    def fn(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
        out = []
        for x in items:
            if str(x["id"]) in want and (x.get("status") or "open") == "open":
                x.update(status=SETTLED, resolution=RESOLUTION_DONE, resolved_by=by, resolved_ts=_now())
                out.append(dict(x))
        return out

    done = _change(c, fn)
    if done:
        _emit(c)
    return done


def reopen(c: str, ids: list[str]) -> list[dict[str, Any]]:
    """Open the resolved comments `ids` again; returns them."""
    want = set(ids)

    def fn(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
        out = []
        for x in items:
            if str(x["id"]) in want and x.get("status") == SETTLED:
                x["status"] = "open"
                for k in ("resolution", "resolved_by", "resolved_ts", "superseded_by"):
                    x.pop(k, None)
                out.append(dict(x))
        return out

    done = _change(c, fn)
    if done:
        _emit(c)
    return done


def supersede(c: str, check: str, run: str, keys: set[str]) -> int:
    """A run of `check` over the cards ended done: its check's earlier open comments on the cards it covered (`keys`,
    key_of) are superseded. Returns how many."""

    def fn(items: list[dict[str, Any]]) -> int:
        n = 0
        for x in items:
            if (x.get("check") == check and x.get("run") != run and (x.get("status") or "open") == "open"
                    and key_of(x) in keys):
                x.update(status=SETTLED, resolution=RESOLUTION_SUPERSEDED, superseded_by=run)
                n += 1
        return n

    n = _change(c, fn) or 0
    if n:
        _emit(c)
    return n


def count(c: str, check: str, run: str) -> int:
    """How many comments run `run` of `check` left."""
    return sum(1 for x in _read(c) if x.get("check") == check and x.get("run") == run)


def _who(c: str, cm: dict[str, Any]) -> str:
    from . import checks  # noqa: PLC0415 — checks imports this module

    if cm.get("check"):
        return checks.names(c).get(str(cm["check"]), str(cm["check"]))
    return str(cm.get("author") or CLAUDE)


def line(c: str, cm: dict[str, Any]) -> str:
    """One comment as the tools read it: `comment <id> on <ref> · <who> · <statement>`, then ` — <details>` on the same
    line when it has details."""
    who = _who(c, cm)
    note = note_of(cm, who if cm.get("check") else "")
    text = _collapse(cite.canon_text(note["text"]))
    details = _collapse(cite.canon_text(note["details"]))
    return f"comment {cm['id']} on {cm['ref']} · {who} · {text}" + (f" — {details}" if details else "")


def lines(c: str, card: str) -> list[str]:
    """The open comments on one card, a line each, for read_ref."""
    try:
        return [line(c, cm) for cm in open_comments(c, card)]
    except (OSError, ValueError):
        return []


# --------------------------------------------------------------------------- routes


def _ws(c: str) -> None:
    try:
        config.workspace_dir(c)
    except ValueError as e:
        raise HTTPException(404, str(e))


@router.get("/ws/{c}/canvas/comments")
async def list_route(c: str) -> dict[str, Any]:
    """The open comments on the canvas whose card is there, each with its `ref` (`card:<id>`)."""
    _ws(c)
    return {"comments": open_comments(c)}


@router.post("/ws/{c}/canvas/comments/{cid}/resolve")
async def resolve_route(c: str, cid: str) -> dict[str, Any]:
    """The analyst's Done on a comment, which hides it. Answers the open comments; 404 for no open comment of that id."""
    _ws(c)
    if not resolve(c, [cid]):
        raise HTTPException(404, f"no open comment {cid!r}")
    return {"comments": open_comments(c)}
