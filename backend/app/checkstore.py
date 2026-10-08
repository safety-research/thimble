"""Where a card's check keeps what it found and what it changed (card_check.py).

`cell.check` is a card's latest check. begin() opens it `pending` in the `queued` phase, phase() says what it does
while pending, stage() adds the results of the drawing and the model's reading, and finish() ends it `ok`, `fixed`,
`error` or `stopped`. A record keeps the `basis` it read (a digest of the card's content); once the card changes, the
stale record is refused, so a slow check never writes over a newer card.

`cell.fixes` lists the changes checks made, oldest first. A fix is tried on a candidate first (candidate()), then
apply_fix() stores it as one undo step with actor `check`, only on an unlocked card a model made. undo_fix() puts the
card back; outputs a code fix replaced are kept in workspaces/<c>/card-checks/<card>/<fix>-before.json.
"""
from __future__ import annotations

import copy
import hashlib
import json
import logging
import secrets
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from fastapi import APIRouter, HTTPException

from . import cite, config, frames

log = logging.getLogger("thimble.checkstore")
router = APIRouter()

STAGES = ("render", "critique")
STATUSES = ("pending", "ok", "fixed", "error", "stopped")
FINISHED = ("ok", "fixed", "error", "stopped")
# what a pending check does: waits for a free slot, draws and reads the card, waits for API capacity, tries its revision
PHASES = ("queued", "checking", "waiting", "revising")
REASON_CHARS = 300
INTERRUPTED_REASON = "the server stopped while the check ran"
READ = ("ok", "fixed")  # a check that read the card to the end: the same card is not read again (begin)
FIX_FIELDS = ("title", "code", "takeaway")  # the question, the code and the takeaway, as the card stores them
ACTOR = "check"  # who a fix is by: the canvas history's author and the undo step's
AI_AUTHORS = ("model", "thimble")  # heal.AI_AUTHORS: the takeaway authors whose words a fix may change
ANALYST_MAKER = "user"  # created_by of a card the analyst made by hand, which a fix never changes
SHOTS_DIR = "card-checks"  # card_check.SHOTS_DIR: under the workspace, a folder per card


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _id(prefix: str) -> str:
    return f"{prefix}_{secrets.token_hex(6)}"


def basis(cell: dict) -> str:
    """A digest of what a check of `cell` reads: its kind, code or payload, the outputs it shows, question and takeaway
    (its words, not where its citations point). The check's own record and fixes are left out, so writing them keeps
    the basis."""
    outs = []
    for b in cell.get("outputs") or []:
        if not isinstance(b, dict):
            continue
        f = frames.frame_of(b)
        if f is not None:
            outs.append({"frame": [f.get("columns"), len(f.get("rows") or []), f.get("total"),
                                   hashlib.sha1(json.dumps(f.get("rows"), default=str).encode()).hexdigest()[:12]]})
        else:
            outs.append({k: (v if k != "text/plain" else str(v)[:4000]) for k, v in b.items()
                         if not str(k).startswith("image/") and k != "truncated"})
    # the takeaway as the analyst reads it: the links job re-points or unwraps a citation after the check has begun,
    # which changes no word, so it must not make the check stale (a stale check would shimmer until the next change)
    takeaway = cite._prose(str(cell.get("takeaway") or ""))
    doc = {"kind": cell.get("kind"), "code": cell.get("code"), "payload": cell.get("payload"), "title": cell.get("title"),
           "takeaway": takeaway, "outputs": outs}
    return hashlib.sha1(json.dumps(doc, sort_keys=True, ensure_ascii=False, default=str).encode("utf-8")).hexdigest()[:16]


def _changes(fn: Any) -> Any:
    """Run a change to a card's check record under the groups' lock (notebook.editing), from the card's read to its
    write, since the card check and `thimble-run` (terminal mode) write the same groups from two processes."""
    import functools  # noqa: PLC0415

    @functools.wraps(fn)
    def wrapper(c: str, *args: Any, **kwargs: Any) -> Any:
        from . import notebook  # noqa: PLC0415 — notebook imports the kernel machinery

        with notebook.editing(config.workspace_dir(c)):
            return fn(c, *args, **kwargs)

    return wrapper


def _locate(c: str, cid: str) -> tuple[dict, dict] | None:
    from . import notebook  # noqa: PLC0415 — notebook imports the kernel machinery

    return notebook._locate(config.workspace_dir(c), cid)


def _save(c: str, nb: dict, cell: dict) -> None:
    from . import notebook  # noqa: PLC0415

    notebook.write_notebook(config.workspace_dir(c), nb)
    notebook._emit(c, cell)


def current(c: str, cid: str) -> dict | None:
    """The card's check record as stored, or None."""
    hit = _locate(c, cid)
    rec = hit[1].get("check") if hit else None
    return copy.deepcopy(rec) if isinstance(rec, dict) else None


@_changes
def begin(c: str, cid: str, *, author: str | None = None, again: bool = False) -> str | None:
    """Open a check of card `cid`: a fresh `pending` record naming the `author` whose work led to the card. Returns the
    check's id; None for a card that is gone, or one already read to the end as it stands, unless asked `again`."""
    hit = _locate(c, cid)
    if hit is None:
        return None
    nb, cell = hit
    rec = cell.get("check") if isinstance(cell.get("check"), dict) else None
    now = basis(cell)
    if not again and rec is not None and rec.get("basis") == now and rec.get("status") in READ:
        return None
    rec = {"id": _id("chk"), "basis": now, "status": "pending", "phase": "queued", "stages": {}, "started": _now(),
           "ended": None, **({"author": author} if author else {})}
    cell["check"] = rec
    _save(c, nb, cell)
    return str(rec["id"])


@_changes
def drop_stale(c: str, cid: str) -> bool:
    """Take a stale record off card `cid` when no new check begins on it; True when one was dropped."""
    hit = _locate(c, cid)
    if hit is None:
        return False
    nb, cell = hit
    rec = cell.get("check") if isinstance(cell.get("check"), dict) else None
    if rec is None or rec.get("basis") == basis(cell):
        return False
    cell.pop("check", None)
    _save(c, nb, cell)
    return True


@_changes
def discard(c: str, cid: str, check_id: str) -> bool:
    """Take check `check_id`'s record off card `cid` while it is pending, as if it never began; True when it did."""
    hit = _locate(c, cid)
    if hit is None:
        return False
    nb, cell = hit
    rec = cell.get("check") if isinstance(cell.get("check"), dict) else None
    if rec is None or rec.get("id") != check_id or rec.get("status") != "pending":
        return False
    cell.pop("check", None)
    _save(c, nb, cell)
    return True


def _live(cell: dict, check_id: str) -> dict | None:
    """The card's record when it is check `check_id` and the card is as that check read it, else None (stale)."""
    rec = cell.get("check") if isinstance(cell.get("check"), dict) else None
    if rec is None or rec.get("id") != check_id or rec.get("basis") != basis(cell):
        return None
    return rec


@_changes
def stage(c: str, cid: str, check_id: str, name: str, result: dict) -> bool:
    """Record one stage's result ($defs.stage) on check `check_id`. False, recording nothing, when the check is
    stale (the card changed since it began, or a newer check began), so the caller drops what it found."""
    if name not in STAGES:
        raise ValueError(f"no stage {name!r}; the stages are {', '.join(STAGES)}")
    hit = _locate(c, cid)
    if hit is None:
        return False
    nb, cell = hit
    rec = _live(cell, check_id)
    if rec is None:
        return False
    res = dict(result or {})
    res.setdefault("status", "ok")
    rec.setdefault("stages", {})[name] = res
    _save(c, nb, cell)
    return True


@_changes
def phase(c: str, cid: str, check_id: str, name: str, *, until: str | None = None, note: str = "") -> bool:
    """Say what pending check `check_id` does now (PHASES): `waiting` takes `until`, when it reads again, and `note`,
    why it waits. False, recording nothing, when the check is stale or has ended."""
    if name not in PHASES:
        raise ValueError(f"no phase {name!r}; the phases are {', '.join(PHASES)}")
    hit = _locate(c, cid)
    if hit is None:
        return False
    nb, cell = hit
    rec = _live(cell, check_id)
    if rec is None or rec.get("status") != "pending":
        return False
    _clear_phase(rec)
    rec["phase"] = name
    if until:
        rec["until"] = until
    if note:
        rec["note"] = _short(note)
    _save(c, nb, cell)
    return True


def _short(text: str) -> str:
    one = " ".join(str(text or "").split())
    return one if len(one) <= REASON_CHARS else one[: REASON_CHARS - 1].rstrip() + "…"


def _clear_phase(rec: dict) -> None:
    for k in ("phase", "until", "note"):
        rec.pop(k, None)


@_changes
def finish(c: str, cid: str, check_id: str, status: str, reason: str = "", note: str = "") -> bool:
    """End check `check_id`: `ok`, `fixed`, `error` or `stopped`, with `reason` for an error or a stop and `note` for a line
    whatever the outcome, both shown in the card's details. False when the check is stale."""
    if status not in FINISHED:
        raise ValueError(f"a check ends {', '.join(FINISHED)}, not {status!r}")
    hit = _locate(c, cid)
    if hit is None:
        return False
    nb, cell = hit
    rec = _live(cell, check_id)
    if rec is None:
        return False
    rec.update(status=status, ended=_now())
    _clear_phase(rec)
    if reason and status in ("error", "stopped"):
        rec["reason"] = _short(reason)
    if note:
        rec["note"] = _short(note)
    _save(c, nb, cell)
    return True


@_changes
def end_pending(c: str, cid: str, status: str, reason: str, check_id: str | None = None) -> bool:
    """End the card's record when it is still pending, whether or not the card changed since (the analyst's Stop, or a check
    that found the card changed under it). True when it ended one."""
    if status not in FINISHED:
        raise ValueError(f"a check ends {', '.join(FINISHED)}, not {status!r}")
    hit = _locate(c, cid)
    if hit is None:
        return False
    nb, cell = hit
    rec = cell.get("check") if isinstance(cell.get("check"), dict) else None
    if rec is None or rec.get("status") != "pending" or (check_id is not None and rec.get("id") != check_id):
        return False
    rec.update(status=status, ended=_now(), reason=_short(reason))
    _clear_phase(rec)
    _save(c, nb, cell)
    return True


def interrupted(cell: dict) -> bool:
    """End a record a previous server left pending as `error` (INTERRUPTED_REASON), in place on `cell`; True when it did.
    Called for every stored card at server start."""
    rec = cell.get("check") if isinstance(cell.get("check"), dict) else None
    if rec is None or rec.get("status") != "pending":
        return False
    rec.update(status="error", ended=_now(), reason=INTERRUPTED_REASON)
    _clear_phase(rec)
    return True


# ----------------------------------------------------------------------------------------------------------
# fixes
# ----------------------------------------------------------------------------------------------------------


def _patch_fields(patch: dict) -> list[str]:
    fields = [f for f in FIX_FIELDS if f in (patch or {})]
    if not fields:
        raise ValueError("a fix changes `title`, `code`, `takeaway` or several of them")
    return fields


def _resolved(cell: dict, takeaway: str) -> str:
    """A takeaway as tools._attach_takeaway stores one: its markup normalised and its values linked to what `cell`
    shows."""
    from . import notebook  # noqa: PLC0415

    cid = str(cell.get("id") or "")
    text = cite.quote_refs(cell, cite.qualify_bare_spans(cid, cite.normalise_markup(str(takeaway or ""))))
    if notebook.runnable(cell):
        text = cite.resolve(cid, text, cell.get("outputs")).annotated
    return text.strip()


async def candidate(c: str, cid: str, patch: dict) -> dict:
    """Card `cid` as it would be with `patch` ({title?, code?, takeaway?}) applied, not stored, with new code run on the card's
    kernel (notebook.trial_run). KeyError for a card that does not exist, ValueError for code on a card that runs none."""
    from . import notebook  # noqa: PLC0415

    _patch_fields(patch)
    cell = notebook.get_cell(c, cid, full_outputs=True)
    if cell is None:
        raise KeyError(cid)
    out = copy.deepcopy(cell)
    if "code" in patch:
        out = await notebook.trial_run(c, cid, str(patch["code"]))
    if "title" in patch:
        out["title"] = str(patch["title"])
    if "takeaway" in patch:
        out["takeaway"] = _resolved(out, str(patch["takeaway"]))
    out["candidate"] = True  # a copy to draw, never the card (render.request_for leaves the mark out)
    return out


def fixable(cell: dict, fields: Iterable[str]) -> list[str]:
    """The ones of `fields` a fix may change on `cell`: none on a locked card or one the analyst made, no code on a card
    that runs none, and no takeaway the analyst wrote."""
    from . import notebook  # noqa: PLC0415

    if cell.get("locked") is True or cell.get("created_by") == ANALYST_MAKER:
        return []
    out = []
    for f in fields:
        if f == "code" and not notebook.runnable(cell):
            continue
        if f == "takeaway" and str(cell.get("takeaway") or "").strip() and cell.get("takeaway_author") not in AI_AUTHORS:
            continue
        out.append(f)
    return out


def _before_path(c: str, cid: str, fix_id: str) -> Path:
    d = config.workspace_dir(c) / SHOTS_DIR / cid
    d.mkdir(parents=True, exist_ok=True)
    return d / f"{fix_id}-before.json"


@_changes
def apply_fix(c: str, cid: str, check_id: str, patch: dict, cand: dict | None, reason: str) -> dict | None:
    """Apply a kept fix to card `cid` in place as one undo step by `check`, appending it to the card's `fixes`. None, changing
    nothing, when the check is stale, a field may not be fixed, or the code candidate did not run clean."""
    from . import canvas_history, notebook  # noqa: PLC0415

    fields = _patch_fields(patch)
    hit = _locate(c, cid)
    if hit is None:
        return None
    nb, cell = hit
    rec = _live(cell, check_id)
    if rec is None or len(fixable(cell, fields)) < len(fields):
        return None
    if "code" in fields and (cand is None or cand.get("status") != "ok" or cand.get("code") != patch["code"]):
        return None  # a fix never leaves a card that does not run
    ws = config.workspace_dir(c)
    fix_id = _id("fix")
    before = {f: copy.deepcopy(cell.get(f)) for f in fields}
    if "code" in fields:
        _before_path(c, cid, fix_id).write_text(json.dumps({"outputs": cell.get("outputs") or [], "status": cell.get("status"),
                                                            "labels": cell.get("labels") or [],
                                                            "label_revs": cell.get("label_revs") or {}}, default=str), "utf-8")
        notebook.land_run(c, nb, cell, str(patch["code"]), copy.deepcopy(cand["outputs"]), "ok", by=ACTOR,
                          labels=cand.get("labels"), label_revs=cand.get("label_revs"))
    if "title" in fields:
        cell["title"] = str(patch["title"])
    if "takeaway" in fields:
        full = {**cell, "outputs": notebook.hydrate_outputs(ws, cell.get("outputs"))}
        cell["takeaway"] = _resolved(full, str(patch["takeaway"]))
        cell["takeaway_author"] = cell.get("takeaway_author") if cell.get("takeaway_author") in AI_AUTHORS else "model"
        cell.pop(notebook.TAKEAWAY_STALE, None)
        if notebook.runnable(cell) and cell.get("status") == "ok":
            notebook._verify_hook("takeaway", c, nb, cell)
    after = {f: copy.deepcopy(cell.get(f)) for f in fields}
    # a part that stored as it was (a takeaway whose words and links resolve to the card's own) is no part of the fix
    fields = [f for f in fields if not _same(before[f], after[f])] or fields
    before, after = {f: before[f] for f in fields}, {f: after[f] for f in fields}
    fix = {"id": fix_id, "check": check_id, "ts": _now(), "by": ACTOR, "fields": fields, "before": before,
           "after": after, "reason": str(reason or "").strip(), "state": "applied"}
    cell.setdefault("fixes", []).append(fix)
    cell["ts"] = _now()
    rec["basis"] = basis(cell)
    with canvas_history.acting(ACTOR):  # one undo step by `check`, its outputs kept with its code (undo.RUN_FIELDS)
        notebook.write_notebook(ws, nb)
        notebook._emit(c, cell, what="edited")
    return copy.deepcopy(fix)


@_changes
def record_rejected(c: str, cid: str, check_id: str, patch: dict, reason: str) -> dict | None:
    """Record a replacement the check did not keep (its code did not run, or its card did not draw) as a fix
    `rejected`, for the fix rate; the card is not changed. None when the card is gone."""
    fields = _patch_fields(patch)
    hit = _locate(c, cid)
    if hit is None:
        return None
    nb, cell = hit
    fix = {"id": _id("fix"), "check": check_id, "ts": _now(), "by": ACTOR, "fields": fields,
           "before": {f: copy.deepcopy(cell.get(f)) for f in fields},
           "after": {f: copy.deepcopy(patch.get(f)) for f in fields}, "reason": str(reason or "").strip(),
           "state": "rejected"}
    cell.setdefault("fixes", []).append(fix)
    _save(c, nb, cell)
    return copy.deepcopy(fix)


def _same(a: Any, b: Any) -> bool:
    return json.dumps(a, sort_keys=True, default=str) == json.dumps(b, sort_keys=True, default=str)


@_changes
def undo_fix(c: str, cid: str, fix_id: str) -> dict:
    """Put back what fix `fix_id` changed, as the analyst's own step, and mark it `undone`. 404 for a card or fix that does
    not exist, 409 for a fix that is not in effect."""
    from . import notebook  # noqa: PLC0415

    hit = _locate(c, cid)
    if hit is None:
        raise HTTPException(404, f"no such card: {cid}")
    nb, cell = hit
    fix = next((f for f in cell.get("fixes") or [] if isinstance(f, dict) and f.get("id") == fix_id), None)
    if fix is None:
        raise HTTPException(404, f"card {cid} has no fix {fix_id}")
    if fix.get("state") != "applied":
        raise HTTPException(409, f"fix {fix_id} is {fix.get('state')}")
    fields = [f for f in fix.get("fields") or [] if f in FIX_FIELDS]
    if not all(_same(cell.get(f), (fix.get("after") or {}).get(f)) for f in fields):
        raise HTTPException(409, f"card {cid} changed since fix {fix_id}")
    before = fix.get("before") or {}
    if "code" in fields:
        try:
            run = json.loads(_before_path(c, cid, fix_id).read_text("utf-8"))
        except (OSError, ValueError):
            run = None
        cell["code"] = before.get("code") or ""
        if isinstance(run, dict) and isinstance(run.get("outputs"), list):
            cell["outputs"], cell["status"] = run["outputs"], str(run.get("status") or "ok")
            if isinstance(run.get("labels"), list):
                cell["labels"] = [str(x) for x in run["labels"]]
                revs = run.get("label_revs") if isinstance(run.get("label_revs"), dict) else {}
                cell["label_revs"] = {str(k): v for k, v in revs.items() if isinstance(v, int)}
        else:
            # the outputs were not kept: the card shows its code's outputs once it runs again
            cell["status"] = "idle"
    if "title" in fields:
        cell["title"] = before.get("title") or cell.get("title") or ""
    if "takeaway" in fields:
        cell["takeaway"] = before.get("takeaway") or ""
    fix["state"] = "undone"
    fix["undone"] = _now()
    cell["ts"] = _now()
    if notebook.runnable(cell) and cell.get("status") == "ok":
        notebook._verify_hook("ran" if "code" in fields else "takeaway", c, nb, cell)
    notebook.write_notebook(config.workspace_dir(c), nb)
    notebook._emit(c, cell, what="edited")
    return {"cell": cell.get("id"), "fix": copy.deepcopy(fix)}


@router.post("/ws/{c}/cells/{cid}/fixes/{fix_id}/undo")
async def undo_fix_route(c: str, cid: str, fix_id: str) -> dict:
    return undo_fix(c, cid, fix_id)
