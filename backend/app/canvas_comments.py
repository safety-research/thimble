"""Comments on the canvas: a note beside a card, or beside one step of a plan card, which a check's run over the cards
leaves (checks.py, the run target CANVAS) or main leaves with add_comment. The analyst reads each beside what it is
about while its check is on, and Done or Know it resolves it, which hides it.

The store is `workspaces/<c>/canvas-comments.json` = {comments: [Comment]}, changed under its lock (ledger.update_json).
A comment has the fields a document's comment has, with `card` and `step` in place of `sentence_id`:

    {id, card, step, check, run, author, tag, title, body, text, evidence, fp, ts, status, resolution}

`step` is the stable id of a plan card's step (payload.steps[i].id, else `s<n>`), named to a model as
`card:<id>#step-<n>` by its place. `author` is `check` for a run's comment and `claude` for main's. `text` is the comment
as written, citations flattened for reading and kept as `evidence`; a leading "Heads up:" or "You should know:" sets
`tag`, the next sentence is `title` and the rest `body` (parse_note), so a check's prompt asks for that shape in its
own words. `status` is `open` or `dismissed` (report.SETTLED_STATUS) and `resolution` says why: `done` or `known` (the
analyst's Done and Know it), `superseded` (a later run of its check covered its card or step). A comment on a card that
is gone is not served.

The passages of the canvas (passages()) are the cards a check covers, in the tree's order, each followed by its steps:
the cards of the analyst's groups and the threads' (not the orientation's deck, a document's figures or labels' cards).
A card is fingerprinted on what a reader of it sees (checkstore.basis, a plan's steps left out), a step on its text,
status and note. Each change emits `canvas-comments` on the workspace's stream.
"""
from __future__ import annotations

import hashlib
import logging
import math
import re
import secrets
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from . import cite, config, investigation
from .ledger import read_json, update_json

log = logging.getLogger("thimble.canvas_comments")
router = APIRouter()

FILE = "canvas-comments.json"
CANVAS = "@canvas"  # the run target of a check over the cards, among a check's runs beside the documents' slugs
EVENT = "canvas-comments"  # the stream record a change emits
TAGS = ("Heads up", "You should know")
HOWS = ("done", "known")  # how the analyst resolved a comment: Done, Know it
RESOLUTION_SUPERSEDED = "superseded"
SETTLED = "dismissed"  # report.SETTLED_STATUS
CHECK_AUTHOR = "check"
CLAUDE = "claude"
COVERED_ROLES = ("analyst",)  # notebook.DEFAULT_ROLE: the analyst's groups and every thread's
SKIPPED_KINDS = ("label",)  # a label's card is the label's review, which its own pane shows
TITLE_CHARS = 140  # a first sentence longer than this is no title
KNOWN_MAX = 30  # the titles a run's task lists as known
_REF_RE = re.compile(r"^(?:card|cell):([A-Za-z0-9_-]+)(?:#step-(\d+))?$")
_TAG_RE = re.compile(r"^\s*\**\s*(heads[ -]up|you should know)\s*\**\s*[:—–-]\s*\**\s*", re.I)
_SENTENCE_END_RE = re.compile(r"[.!?](?=\s+[\"'“(\[]?[A-Z0-9]|\s*$)")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _collapse(v: Any) -> str:
    return " ".join(str(v or "").split())


def _path(c: str) -> Path:
    return config.workspace_dir(c) / FILE


# --------------------------------------------------------------------------- what a comment says


def parse_note(text: str) -> dict[str, Any]:
    """{tag, title, body} of a comment's text: a leading "Heads up:" or "You should know:" sets `tag`, the first sentence
    after it is `title` (without its full stop, its first letter capitalized) and the rest is `body`. A text with no tag,
    or whose first sentence is longer than TITLE_CHARS, has no title, and its body is the text after the tag."""
    text = _collapse(text)
    m = _TAG_RE.match(text)
    if not m:
        return {"tag": None, "title": None, "body": text}
    tag = TAGS[0] if m.group(1).lower().startswith("heads") else TAGS[1]
    rest = text[m.end():].strip().strip("*").strip()
    end = _SENTENCE_END_RE.search(rest)
    first = rest[: end.end()] if end else rest
    if not first or len(first) > TITLE_CHARS:
        return {"tag": tag, "title": None, "body": rest}
    title = first.rstrip(".").strip()
    title = title[:1].upper() + title[1:]
    return {"tag": tag, "title": title, "body": rest[len(first):].strip()}


# --------------------------------------------------------------------------- the cards a check covers


def parse_ref(ref: str) -> tuple[str, int | None] | None:
    """(card id, step number or None) of `card:<id>` or `card:<id>#step-<n>`; None for another ref."""
    m = _REF_RE.match(str(ref or "").strip().strip("[]").strip())
    if not m:
        return None
    return m.group(1), (int(m.group(2)) if m.group(2) else None)


def steps_of(cell: dict[str, Any]) -> list[dict[str, Any]]:
    """A plan card's steps in order, each {id, n, text, status, note}; [] for any other card. A step's id is its stored
    `id`, else `s<n>`."""
    payload = cell.get("payload") if isinstance(cell.get("payload"), dict) else {}
    raw = payload.get("steps") if isinstance(payload.get("steps"), list) else []
    out = []
    for i, s in enumerate(raw, 1):
        s = s if isinstance(s, dict) else {"text": str(s)}
        out.append({"id": str(s.get("id") or f"s{i}"), "n": i, "text": _collapse(s.get("text")),
                    "status": _collapse(s.get("status")) or "not started", "note": _collapse(s.get("note"))})
    return out


def step_ref(card: str, n: int | None) -> str:
    return f"card:{card}" if n is None else f"card:{card}#step-{n}"


def _fp(kind: str, keys: list[str]) -> str:
    return hashlib.sha1("\x1f".join([kind, *keys]).encode("utf-8")).hexdigest()[:16]


def _card_fp(cell: dict[str, Any]) -> str:
    from . import checkstore  # noqa: PLC0415 — checkstore imports the notebook lazily

    payload = cell.get("payload") if isinstance(cell.get("payload"), dict) else None
    if payload is not None and isinstance(payload.get("steps"), list):
        cell = {**cell, "payload": {k: v for k, v in payload.items() if k != "steps"}}
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
    """The passages of the canvas a check covers, in the tree's order: each card {ref, kind: card, card, step: None,
    n: None, fp, changed}, then each of its steps {ref: card:<id>#step-<n>, kind: step, step: its id, n, ...}; with
    `since`, only the cards that changed at or after it (after), so a turn's end fingerprints only those. Every
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
            base = {"card": cid, "changed": changed, "locked": False, "anchor": cid, "group": str(nb.get("id") or "")}
            out.append({**base, "ref": step_ref(cid, None), "kind": "card", "step": None, "n": None,
                        "fp": _card_fp(cell), "ids": [step_ref(cid, None)]})
            for s in steps_of(cell):
                ref = step_ref(cid, s["n"])
                out.append({**base, "ref": ref, "kind": "step", "step": s["id"], "n": s["n"],
                            "fp": _fp("step", [cid, s["text"], s["status"], s["note"]]), "ids": [ref]})
    return out


def passage_of(c: str, ref: str, ps: list[dict[str, Any]] | None = None) -> dict[str, Any] | None:
    """The passage `ref` names among the covered cards, or None."""
    hit = parse_ref(ref)
    if hit is None:
        return None
    want = step_ref(*hit)
    return next((p for p in (passages(c) if ps is None else ps) if p["ref"] == want), None)


def key_of(p: dict[str, Any]) -> tuple[str, str | None]:
    """A passage's or a comment's key, which survives a step's move: (card, step id or None)."""
    return str(p.get("card") or ""), (str(p["step"]) if p.get("step") else None)


def card_lines(c: str, refs: list[str], ps: list[dict[str, Any]] | None = None) -> str:
    """The cards a canvas run covers, for its task: each card that has a passage in `refs` with its ref, kind and
    question, its takeaway, and each step of a plan with its status and note; a step the run does not cover says it was
    checked before."""
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
        for s in steps_of(cell):
            ref = step_ref(cid, s["n"])
            seen = "" if ref in want else " · checked before"
            lines.append(f"  {ref} · {s['status']}{seen} · {s['text']}" + (f" · {s['note']}" if s["note"] else ""))
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


def _served(cm: dict[str, Any], cards: dict[str, dict[str, Any]]) -> dict[str, Any] | None:
    """A comment as the browser and the tools read it, with its `ref`; None when its card, or its step, is gone."""
    cell = cards.get(str(cm.get("card") or ""))
    if cell is None:
        return None
    n = None
    if cm.get("step"):
        n = next((s["n"] for s in steps_of(cell) if s["id"] == cm["step"]), None)
        if n is None:
            return None
    return {**cm, "ref": step_ref(str(cm["card"]), n), "n": n}


def all_comments(c: str) -> list[dict[str, Any]]:
    """Every stored comment whose card is there, open or resolved, each with its `ref`."""
    cards = _cards(c)
    return [s for cm in _read(c) if (s := _served(cm, cards)) is not None]


def open_comments(c: str, card: str | None = None) -> list[dict[str, Any]]:
    """The open comments whose card (and step) is there, in the order they were left, each with its `ref`; with `card`,
    that card's alone."""
    return [cm for cm in all_comments(c) if (cm.get("status") or "open") == "open" and (card is None or cm["card"] == card)]


def _new_id(used: set[str]) -> str:
    while True:
        i = "k" + secrets.token_hex(4)
        if i not in used:
            return i


def add(c: str, *, card: str, step: str | None, text: str, author: str, check: str | None = None,
        run: str | None = None, evidence: str = "", fp: str = "") -> tuple[dict[str, Any], bool]:
    """Store a comment, or find the same open one (same author, check, run, place and words). Returns (the comment,
    whether it is new)."""
    note = parse_note(text)

    def fn(items: list[dict[str, Any]]) -> tuple[dict[str, Any], bool]:
        same = next((x for x in items if x.get("card") == card and x.get("step") == step and x.get("author") == author
                     and x.get("check") == check and x.get("run") == run and (x.get("status") or "open") == "open"
                     and _collapse(x.get("text")) == _collapse(text)), None)
        if same is not None:
            return same, False
        cm = {"id": _new_id({str(x["id"]) for x in items}), "card": card, "step": step, "check": check, "run": run,
              "author": author, **note, "text": _collapse(text), "evidence": evidence, "fp": fp, "ts": _now(),
              "status": "open", "resolution": None}
        items.append(cm)
        return cm, True

    cm, new = _change(c, fn)
    if new:
        _emit(c, card=card)
    return cm, new


def resolve(c: str, ids: list[str], how: str, by: str = "analyst") -> list[dict[str, Any]]:
    """Resolve the open comments `ids` as `how` (done or known), by `by`; returns the comments resolved."""
    if how not in HOWS:
        raise ValueError(f"how is one of {', '.join(HOWS)}")
    want = set(ids)

    def fn(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
        out = []
        for x in items:
            if str(x["id"]) in want and (x.get("status") or "open") == "open":
                x.update(status=SETTLED, resolution=how, resolved_by=by, resolved_ts=_now())
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


def supersede(c: str, check: str, run: str, keys: set[tuple[str, str | None]]) -> int:
    """A run of `check` over the cards ended done: its check's earlier open comments on the cards and steps it covered
    (`keys`, key_of) are superseded. Returns how many."""

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


def known_titles(c: str, check: str) -> list[str]:
    """What the analyst marked Know it among `check`'s comments on the cards, newest first: each comment's title, else
    its text."""
    out = [x for x in _read(c) if x.get("check") == check and x.get("resolution") == "known"]
    out.sort(key=lambda x: str(x.get("resolved_ts") or x.get("ts") or ""), reverse=True)
    return [_collapse(x.get("title") or x.get("text")) for x in out]


def _who(c: str, cm: dict[str, Any]) -> str:
    from . import checks  # noqa: PLC0415 — checks imports this module

    if cm.get("check"):
        return checks.names(c).get(str(cm["check"]), str(cm["check"]))
    return str(cm.get("author") or CLAUDE)


def line(c: str, cm: dict[str, Any]) -> str:
    """One comment as the tools read it: `comment <id> on <ref> · <who> · <text>`."""
    text = _collapse(cite.canon_text(str(cm.get("text") or "")))
    return f"comment {cm['id']} on {cm['ref']} · {_who(c, cm)} · {text}"


def lines(c: str, card: str) -> list[str]:
    """The open comments on one card and its steps, a line each, for read_ref."""
    try:
        return [line(c, cm) for cm in open_comments(c, card)]
    except (OSError, ValueError):
        return []


# --------------------------------------------------------------------------- routes


class ResolveBody(BaseModel):
    how: str = "done"


def _ws(c: str) -> None:
    try:
        config.workspace_dir(c)
    except ValueError as e:
        raise HTTPException(404, str(e))


@router.get("/ws/{c}/canvas/comments")
async def list_route(c: str) -> dict[str, Any]:
    """The open comments on the canvas whose card is there, each with its `ref` (`card:<id>` or `card:<id>#step-<n>`)."""
    _ws(c)
    return {"comments": open_comments(c)}


@router.post("/ws/{c}/canvas/comments/{cid}/resolve")
async def resolve_route(c: str, cid: str, body: ResolveBody) -> dict[str, Any]:
    """The analyst's Done (`how: done`) or Know it (`how: known`) on a comment, which hides it. Answers the open
    comments; 404 for no open comment of that id, 400 for another `how`."""
    _ws(c)
    if body.how not in HOWS:
        raise HTTPException(400, f"how is one of {', '.join(HOWS)}")
    if not resolve(c, [cid], body.how):
        raise HTTPException(404, f"no open comment {cid!r}")
    return {"comments": open_comments(c)}


@router.post("/ws/{c}/canvas/comments/{cid}/reopen")
async def reopen_route(c: str, cid: str) -> dict[str, Any]:
    """A resolved comment open again. Answers the open comments."""
    _ws(c)
    reopen(c, [cid])
    return {"comments": open_comments(c)}
