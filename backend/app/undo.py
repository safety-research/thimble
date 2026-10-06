"""Undo and redo over the workspace's changes, whoever made them.

A step is one change to a card (recorded by canvas_history.record via notebook._emit: add, delete, edit, move,
resize;
a code change keeps the outputs on either side, RUN_FIELDS) or one saved edit of a document's text
(report_types.write_doc/write_frame). Labels, groups and frames are not undoable. Steps made inside batching() share
a
`batch` (an orientation follow-up), and one Undo reverts the whole batch. Steps of a session thimble started carry
its
THIMBLE_SESSION; while it runs, Undo passes over them, refusing when one of them changed the same target above.

The journal, workspaces/<c>/undo.jsonl, holds `step`, `undo`, `redo` and `ran` lines, replayed into the two stacks
and
rewritten to MAX_STEPS per stack past MAX_LINES lines. In terminal mode a second process writes it (`thimble-run`, whose
runs fill in `ran` lines), so each line is appended under the journal's lock (ledger.locked), and the stacks held in
memory are replayed again when the file is not as this process left it. POST /ws/{c}/undo and /redo apply a step inside `applying()`,
so those writes make no step of their own; GET /ws/{c}/undo names {undo, redo, held}."""
from __future__ import annotations

import asyncio
import contextvars
import copy
import hashlib
import json
import logging
import os
import secrets
import threading
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

from fastapi import APIRouter, HTTPException

from . import config, ledger

log = logging.getLogger("thimble.undo")
router = APIRouter()

LOG_NAME = "undo.jsonl"
MAX_STEPS = 100  # kept on each stack when the journal is rewritten
MAX_LINES = 400  # the journal's length that makes it rewritten
# the card's fields a step restores: what an edit, a move or a resize changes, with the fields derived from them
CARD_FIELDS = ("title", "slug", "code", "payload", "text", "labels", "takeaway", "takeaway_author", "locked", "starred",
               "kind", "notebook", "pos", "width", "height")
# A run is no step, but a step that changes a card's code carries the outputs and status on either side of it, so an
# undo or redo shows the drawing of the code it restores. The browser saves code before running it, so card_ran fills in
# the step's after side once that run lands. The labels' revisions a run read go with its outputs.
RUN_FIELDS = ("outputs", "status", "label_revs")
# a document's keys that are not its text: a write that changes only these is not a step
DOC_VOLATILE = {"comments", "locked", "lock_reverts", "generation", "generated_at", "verified", "verified_at", "snapshot",
                "model", "written_by", "words", "title_ok", "history", "tags", "tag_notes", "rewritten_at", "status",
                "partial", "ts", "by", "actor", "was_on"}

_APPLYING: contextvars.ContextVar[bool] = contextvars.ContextVar("thimble_undo_applying", default=False)
_BATCH: contextvars.ContextVar[tuple[str, str] | None] = contextvars.ContextVar("thimble_undo_batch", default=None)
# (THIMBLE_SESSION, the task running the call) of a session's tool call (acting_session); the session holds only in the
# calling task itself or in a worker thread, as in canvas_history.author
_SESSION: contextvars.ContextVar[tuple[str, Any] | None] = contextvars.ContextVar("thimble_undo_session", default=None)
# the `by` of a change that names no author of its own, which a session's step replaces with the session
GENERIC_BY = ("", "terminal", "analyst")
_lock = threading.RLock()
_stacks: dict[str, tuple[list[dict[str, Any]], list[dict[str, Any]]]] = {}  # workspace -> (undo, redo)
_sigs: dict[str, tuple[int, int, int] | None] = {}  # workspace -> its journal's (inode, size, mtime) as _stacks holds it


@contextmanager
def applying() -> Iterator[None]:
    """Mark the writes of an undo or a redo, which make no step of their own."""
    token = _APPLYING.set(True)
    try:
        yield
    finally:
        _APPLYING.reset(token)


def is_applying() -> bool:
    return _APPLYING.get()


@contextmanager
def batching(batch: tuple[str, str] | None) -> Iterator[None]:
    """Stamp the steps made inside with `batch`, (id, label), the one change they are part of (module note, batches);
    None stamps nothing."""
    token = _BATCH.set(batch) if batch else None
    try:
        yield
    finally:
        if token is not None:
            _BATCH.reset(token)


@contextmanager
def acting_session(key: str | None) -> Iterator[None]:
    """Stamp the steps made inside with the session `key` (a THIMBLE_SESSION; module note, sessions); None stamps
    nothing."""
    token = _SESSION.set((key, _task())) if key else None
    try:
        yield
    finally:
        if token is not None:
            _SESSION.reset(token)


def _task() -> Any:
    try:
        return asyncio.current_task()
    except RuntimeError:  # no running loop: a worker thread
        return None


def _acting() -> str | None:
    """The session whose tool call runs here, or None outside one."""
    held = _SESSION.get()
    if not held:
        return None
    key, task = held
    now = _task()
    return key if now is None or task is None or now is task else None


def current_batch() -> tuple[str, str] | None:
    """The batch that steps made here are stamped with (batching), for work queued now that writes later in another
    task, such as the links job (module note, batches)."""
    return _BATCH.get()


def log_path(c: str) -> Path:
    return config.workspace_dir(c) / LOG_NAME


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


# --------------------------------------------------------------------------- the stacks


def _sig(c: str) -> tuple[int, int, int] | None:
    try:
        st = log_path(c).stat()
    except (OSError, ValueError, HTTPException):
        return None
    return st.st_ino, st.st_size, st.st_mtime_ns


def _load(c: str) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """The workspace's stacks, replayed from its journal on first use and again when another process changed the
    journal since (module note)."""
    if c in _stacks and _sigs.get(c) == _sig(c):
        return _stacks[c]
    undo: list[dict[str, Any]] = []
    redo: list[dict[str, Any]] = []
    lines = 0
    try:
        path = log_path(c)
        text = path.read_text("utf-8") if path.is_file() else ""
    except (OSError, ValueError, HTTPException):
        text = ""
    for raw in text.splitlines():
        try:
            r = json.loads(raw)
        except ValueError:
            continue
        if not isinstance(r, dict):
            continue
        lines += 1
        if r.get("type") == "step" and r.get("stack") == "redo":
            redo.append(r)  # a rewritten journal's redo stack, bottom first
        elif r.get("type") == "step":
            undo.append(r)
            redo.clear()
        elif r.get("type") == "undo" and (at := _index(undo, r.get("step"))) is not None:
            redo.append(undo.pop(at))  # below the top when a running session's steps were passed over
        elif r.get("type") == "redo" and redo and redo[-1].get("id") == r.get("step"):
            undo.append(redo.pop())
        elif r.get("type") == "ran" and isinstance(r.get("after"), dict):
            step = next((s for s in reversed(undo) if s.get("id") == r.get("step")), None)
            if step is not None and isinstance(step.get("after"), dict):
                step["after"].update(r["after"])
    _stacks[c] = (undo, redo)
    _sigs[c] = _sig(c)
    if lines > MAX_LINES:
        _rewrite(c)
    return _stacks[c]


def _index(stack: list[dict[str, Any]], step_id: Any) -> int | None:
    """Where the step `step_id` sits on `stack`, looked for from the top; None when it is not there."""
    return next((i for i in range(len(stack) - 1, -1, -1) if stack[i].get("id") == step_id), None)


def _rewrite(c: str) -> None:
    """The journal as the newest MAX_STEPS steps of each stack, each in order: the undo stack's, then the redo stack's
    marked for it."""
    with ledger.locked(log_path(c)):
        if _sigs.get(c) != _sig(c):
            _stacks.pop(c, None)
            _load(c)  # another process's lines first: the rewrite keeps them
        undo, redo = _stacks[c]
        del undo[:-MAX_STEPS]
        del redo[:-MAX_STEPS]
        plain = lambda s: {k: v for k, v in s.items() if k != "stack"}  # noqa: E731
        lines = [json.dumps(plain(s), ensure_ascii=False) for s in undo]
        lines += [json.dumps({**plain(s), "stack": "redo"}, ensure_ascii=False) for s in redo]
        ledger.atomic_write_text(log_path(c), "\n".join(lines) + ("\n" if lines else ""))
        _sigs[c] = _sig(c)


def _append(c: str, line: dict[str, Any]) -> None:
    """Append a line under the journal's lock. When another process wrote the journal since this one read it, the
    stacks are dropped, to be replayed with both processes' lines at their next use."""
    path = log_path(c)
    with ledger.locked(path):
        before = _sig(c)
        ledger.heal_tail(path)
        ledger.append_jsonl(path, line)
        if c in _stacks and before == _sigs.get(c):
            _sigs[c] = _sig(c)
        else:
            _stacks.pop(c, None)


def push(c: str, step: dict[str, Any]) -> None:
    """Add a step: onto the undo stack, into the journal; a new change empties the redo stack. Never raises."""
    try:
        with _lock, ledger.locked(log_path(c)):
            undo, redo = _load(c)
            step = {"type": "step", "id": secrets.token_hex(4), "ts": _now(), **step}
            batch = _BATCH.get()
            if batch and "batch" not in step:
                step["batch"], step["batch_label"] = batch
            session = _acting()
            if session and "session" not in step:
                step["session"] = session
                if str(step.get("by") or "") in GENERIC_BY:
                    step["by"] = session
            undo.append(step)
            redo.clear()
            _append(c, step)
            if len(undo) > MAX_STEPS * 2:
                _rewrite(c)
    except Exception:  # noqa: BLE001 — the history never stops a change
        log.exception("%s: an undo step was not recorded", c)


def _label(step: dict[str, Any]) -> str:
    return str(step.get("batch_label") or step["label"]) if step.get("batch") else str(step["label"])


def _run_of(stack: list[dict[str, Any]], top: int | None = None) -> list[dict[str, Any]]:
    """The steps one undo or redo applies from `stack` at `top` (its top by default) down, top first: that step, and
    with a batch every step under it with the same batch (module note, batches)."""
    if not stack:
        return []
    at = len(stack) - 1 if top is None else top
    first = stack[at]
    if not first.get("batch"):
        return [first]
    out = []
    for step in reversed(stack[:at + 1]):
        if step.get("batch") != first["batch"]:
            break
        out.append(step)
    return out


def _running(c: str, stack: list[dict[str, Any]]) -> set[str]:
    """The sessions of the steps on `stack` that still run (module note, sessions)."""
    keys = {str(s["session"]) for s in stack if s.get("session")}
    if not keys:
        return set()
    from . import subagents  # noqa: PLC0415 — subagents reaches this module through the tools its agents call

    return {k for k in keys if subagents.running(c, k)}


def session_name(key: str) -> str:
    """A THIMBLE_SESSION as the analyst reads it: the orientation, the writer of the report, the critique, a check."""
    kind, _, rest = str(key).partition(":")
    if kind == "writer":
        return f"the writer of the {rest}" if rest else "the writer"
    return {"orient": "the orientation", "critique": "the critique", "check": "a report check"}.get(kind, f"the session {key}")


def _pick(c: str, stack: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], str | None]:
    """(the steps one undo reverts, top first; why it cannot, or None): the newest step no running session made, with
    its
    batch, refused when a running session's step above it changed the same card or document."""
    live = _running(c, stack)
    at = next((i for i in range(len(stack) - 1, -1, -1) if stack[i].get("session") not in live), None) if live else len(stack) - 1
    if at is None:
        return [], f"{session_name(sorted(live)[0])} is still running; what it changed can be undone once it ends"
    group = _run_of(stack, at)
    touched = {(s.get("kind"), str(s.get("target"))) for s in group}
    for later in stack[at + 1:]:
        if (later.get("kind"), str(later.get("target"))) in touched:
            what = f"the {later['target']}" if later.get("kind") == "doc" else f"card {later.get('target')}"
            return [], f"{session_name(str(later.get('session')))} has changed {what} since and is still running; undo it once that ends"
    return group, None


def labels(c: str) -> dict[str, str | None]:
    """{undo, redo, undo_run, held}: the label of the step or batch each would apply, the batch the undo would revert
    (`<chat>/<run>`), and why a running session holds the undo; each None when absent."""
    with _lock:
        undo, redo = _load(c)
        group, held = _pick(c, undo) if undo else ([], None)
        first = group[0] if group else None
        return {"undo": _label(first) if first else None, "redo": _label(redo[-1]) if redo else None,
                "undo_run": str(first["batch"]) if first and first.get("batch") else None, "held": held}


def batch_steps(c: str, batch: str) -> list[dict[str, Any]]:
    """Every step the journal holds with the batch `batch`, oldest first, whichever stack it is on now: what a
    follow-up of the orientation changed (orient_session counts them)."""
    try:
        path = log_path(c)
        text = path.read_text("utf-8") if path.is_file() else ""
    except (OSError, HTTPException):
        return []
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for raw in text.splitlines():
        try:
            r = json.loads(raw)
        except ValueError:
            continue
        if isinstance(r, dict) and r.get("type") == "step" and r.get("batch") == batch and r.get("id") not in seen:
            seen.add(str(r.get("id")))
            out.append(r)
    return out


def forget(c: str | None = None) -> None:
    """Drop the stacks held for a workspace (every workspace when None), for tests and a reset."""
    with _lock:
        if c is None:
            _stacks.clear()
            _sigs.clear()
        else:
            _stacks.pop(c, None)
            _sigs.pop(c, None)


# --------------------------------------------------------------------------- recording


def _name(c: str, cell: dict[str, Any]) -> str:
    """A card's name as the analyst reads it (notebook's slug, runs-one-end), its id for a card that has none."""
    cid = str(cell.get("id") or "")
    if cell.get("slug"):
        return str(cell["slug"])
    try:
        from . import notebook  # noqa: PLC0415

        # a deleted card is off the canvas: the name its question makes
        return notebook.cell_slugs(config.workspace_dir(c)).get(cid) or (notebook.slug_of(cell.get("title") or "") if cell.get("title") else cid)
    except Exception:  # noqa: BLE001
        return cid


def _card_label(c: str, op: str, fields: set[str], before: dict[str, Any], after: dict[str, Any]) -> str:
    name = _name(c, after or before)
    if op == "created":
        return f"add card {name}"
    if op == "deleted":
        return f"delete card {name}"
    if op == "resized":
        return f"resize card {name}"
    if op == "moved":
        return f"move card {name}"
    if fields == {"starred"}:
        return f"{'star' if after.get('starred') else 'unstar'} card {name}"
    if fields == {"locked"}:
        return f"{'lock' if after.get('locked') else 'unlock'} card {name}"
    fields = fields - set(RUN_FIELDS)
    for key, words in (("takeaway", "the takeaway of"), ("title", "the question of"), ("code", "the code of")):
        if key in fields and not (fields - {key, "takeaway_author", "slug"}):
            return f"edit {words} card {name}"
    return f"edit card {name}"


def card_changed(c: str, op: str, before: dict[str, Any] | None, after: dict[str, Any], changed: list[str],
                 by: str, after_card: str | None = None) -> None:
    """A change to a card that canvas_history.record saw: `op` created, deleted, edited, moved or resized;
    `before`/`after`
    the card; `changed` the fields that differ; `after_card` where a delete's undo puts it back. Never raises."""
    if is_applying():
        return
    try:
        cid = str(after.get("id") or "")
        if not cid:
            return
        step: dict[str, Any] = {"kind": "card", "op": op, "target": cid, "by": by, "group": after.get("notebook")}
        if op in ("created", "deleted"):
            step.update(before=copy.deepcopy(before) if op == "deleted" else None,
                        after=copy.deepcopy(after) if op == "created" else None, after_card=after_card)
            step["label"] = _card_label(c, op, set(), before or {}, after)
        else:
            if before is None:
                return  # a change to a card known only from before this server started, with nothing to restore
            fields = {f for f in changed if f in CARD_FIELDS and before.get(f) != after.get(f)}
            if not fields:
                return
            if "code" in fields:
                fields |= {f for f in RUN_FIELDS if f in before or f in after}
            step.update(before={f: copy.deepcopy(before.get(f)) for f in fields},
                        after={f: copy.deepcopy(after.get(f)) for f in fields}, after_card=after_card)
            step["label"] = _card_label(c, op, fields, before, after)
        push(c, step)
    except Exception:  # noqa: BLE001
        log.exception("%s: the change to card %s made no undo step", c, after.get("id"))


def card_ran(c: str, cell: dict[str, Any]) -> None:
    """A run of a card's code landed with no other change: when the newest undo step on that card changed its code to
    the code
    that ran, the run's outputs become that step's after side (RUN_FIELDS). Never raises."""
    if is_applying():
        return
    try:
        cid = str(cell.get("id") or "")
        with _lock, ledger.locked(log_path(c)):
            undo_stack, _ = _load(c)
            step = next((s for s in reversed(undo_stack) if s.get("kind") == "card" and s.get("target") == cid), None)
            after = step.get("after") if step is not None else None
            if not isinstance(after, dict) or "code" not in after or after.get("code") != cell.get("code"):
                return
            ran = {f: copy.deepcopy(cell.get(f)) for f in RUN_FIELDS}
            if all(after.get(f) == v for f, v in ran.items()):
                return
            after.update(ran)
            _append(c, {"type": "ran", "step": step["id"], "ts": _now(), "after": ran})
    except Exception:  # noqa: BLE001
        log.exception("%s: the run of card %s was not kept with its undo step", c, cell.get("id"))


def _text_of(doc: Any) -> Any:
    """A document without what is not its text (DOC_VOLATILE), to tell an edit from a comment or a mark."""
    if isinstance(doc, dict):
        return {k: _text_of(v) for k, v in doc.items() if k not in DOC_VOLATILE}
    if isinstance(doc, list):
        return [_text_of(v) for v in doc]
    return doc


def _digest(obj: Any) -> str:
    return hashlib.sha1(json.dumps(obj, sort_keys=True, ensure_ascii=False, default=str).encode("utf-8")).hexdigest()


def doc_written(c: str, inv_id: str, slug: str, which: str, before: dict[str, Any] | None, after: dict[str, Any],
                by: str = "") -> None:
    """A save of a document (`which` doc, the written one, or frame, the one not written yet) of `slug`: a step when
    its text changed. Never raises."""
    if is_applying():
        return
    try:
        if before is not None and _digest(_text_of(before)) == _digest(_text_of(after)):
            return
        what = "the report" if slug == "report" else f"the {slug}"
        push(c, {"kind": "doc", "op": "edited", "target": slug, "inv": inv_id, "which": which, "by": by,
                 "label": f"edit {what}", "before": copy.deepcopy(before), "after": copy.deepcopy(after)})
    except Exception:  # noqa: BLE001
        log.exception("%s: the save of %s made no undo step", c, slug)


# --------------------------------------------------------------------------- applying


def _put_card(c: str, card: dict[str, Any], after_card: str | None) -> None:
    """A card back into its group (the loose group when that group is gone), after the card that preceded it."""
    from . import notebook  # noqa: PLC0415 — notebook imports canvas_history, which imports this module

    ws = config.workspace_dir(c)
    group = str(card.get("notebook") or "")
    if not notebook.ID_RE.match(group) or notebook.read_notebook(ws, group) is None:
        group = notebook.loose_group(ws)
    nb = notebook.read_notebook(ws, group) or {}
    after = after_card if any(x.get("id") == after_card for x in nb.get("cells") or []) else None
    if notebook.find_cell(ws, str(card["id"])) is not None:
        raise HTTPException(409, f"card {card['id']} is on the canvas already")
    notebook.insert_cell(c, group, copy.deepcopy(card), after=after)


def _set_card(c: str, cid: str, fields: dict[str, Any]) -> None:
    """A card's fields as a step names them, set where the card lives; a change of group goes through move_cells."""
    from . import notebook  # noqa: PLC0415

    ws = config.workspace_dir(c)
    with notebook.editing(ws):
        _set_card_locked(c, ws, cid, fields)


def _set_card_locked(c: str, ws: Path, cid: str, fields: dict[str, Any]) -> None:
    """_set_card with the groups' lock held (notebook.editing)."""
    from . import notebook  # noqa: PLC0415

    hit = notebook._locate(ws, cid)
    if hit is None:
        raise HTTPException(409, f"card {cid} is no longer on the canvas")
    nb, cell = hit
    if "notebook" in fields and fields["notebook"] != nb.get("id"):
        target = str(fields["notebook"] or "")
        exists = notebook.ID_RE.match(target) and notebook.read_notebook(ws, target) is not None
        notebook.move_cells(c, [cid], target if exists else None, pos=fields.get("pos"))
        hit = notebook._locate(ws, cid)
        if hit is None:
            return
        nb, cell = hit
    rest = {k: v for k, v in fields.items() if k != "notebook"}
    if not rest:
        return
    for k, v in rest.items():
        if v is None and k not in ("pos", "width", "height", "takeaway_author"):
            cell.pop(k, None)
        else:
            cell[k] = copy.deepcopy(v)
    # what a payload carries that the card keeps beside it (notebook.edit_cell): a note's text, a label card's label
    payload = rest.get("payload")
    if isinstance(payload, dict) and cell.get("kind") == "note" and "text" not in rest:
        cell["text"] = payload.get("text", "")
    notebook.write_notebook(ws, nb)
    notebook._emit(c, cell, what="edited")


def _delete_card(c: str, cid: str) -> None:
    from . import notebook  # noqa: PLC0415

    if notebook.find_cell(config.workspace_dir(c), cid) is None:
        return  # gone already: the undo of its creation holds
    notebook.delete_cell(c, cid)


def _write_doc(c: str, step: dict[str, Any], doc: dict[str, Any] | None) -> None:
    """A document (or its frame) back to `doc`; None removes it, as before its first save."""
    from . import investigation, report_types  # noqa: PLC0415 — report_types calls doc_written

    inv, slug = str(step.get("inv") or investigation.MAIN), str(step["target"])
    if step.get("which") == "frame":
        if doc is None:
            with_path = report_types.frame_file(c, inv, slug)
            if with_path.is_file():
                os.remove(with_path)
        else:
            report_types.write_frame(c, inv, slug, doc)
    elif doc is None:
        path = report_types.doc_file(c, inv, slug)
        if path.is_file():
            os.remove(path)
    else:
        report_types.write_doc(c, inv, slug, doc)
    if inv == investigation.MAIN:
        report_types._emit(c, {"type": "report", "slug": slug, "status": "edited", "by": "undo"})


def _apply(c: str, step: dict[str, Any], forward: bool) -> None:
    """The step again (`forward`), or its inverse."""
    with applying():
        if step["kind"] == "doc":
            _write_doc(c, step, step.get("after") if forward else step.get("before"))
            return
        op, cid = step["op"], str(step["target"])
        if op == "created":
            if forward:
                _put_card(c, step["after"], step.get("after_card"))
            else:
                _delete_card(c, cid)
        elif op == "deleted":
            if forward:
                _delete_card(c, cid)
            else:
                _put_card(c, step["before"], step.get("after_card"))
        else:
            _set_card(c, cid, step["after"] if forward else step["before"])


def undo(c: str) -> dict[str, Any]:
    """Revert the top step of the undo stack, or its batch, passing over the steps of a running session; 409 when there
    is
    none, a running session holds it, or nothing of it can be reverted (then it is dropped)."""
    with _lock:
        stack, redo = _load(c)
        if not stack:
            raise HTTPException(409, "nothing to undo")
        group, held = _pick(c, stack)
        if held:
            raise HTTPException(409, held)
        label, failure, applied = _label(group[0]), None, 0
        for step in group:
            try:
                _apply(c, step, forward=False)
            except HTTPException as e:
                stack.remove(step)
                _append(c, {"type": "undo", "step": step["id"], "ts": _now(), "failed": True})
                failure = failure or e
                continue
            stack.remove(step)
            redo.append(step)
            applied += 1
            _append(c, {"type": "undo", "step": step["id"], "ts": _now()})
        if failure is not None and not applied:
            raise failure
        return {"applied": label, **labels(c)}


def redo(c: str) -> dict[str, Any]:
    """Apply the top step of the redo stack again, or the batch it starts; 409 when there is none or nothing of it can
    be applied (which drops it)."""
    with _lock:
        stack, redo_ = _load(c)
        if not redo_:
            raise HTTPException(409, "nothing to redo")
        group = _run_of(redo_)
        label, failure, applied = _label(group[0]), None, 0
        for step in group:
            try:
                _apply(c, step, forward=True)
            except HTTPException as e:
                redo_.pop()
                failure = failure or e
                continue
            stack.append(redo_.pop())
            applied += 1
            _append(c, {"type": "redo", "step": step["id"], "ts": _now()})
        if failure is not None and not applied:
            raise failure
        return {"applied": label, **labels(c)}


# --------------------------------------------------------------------------- routes


def _check(c: str) -> None:
    try:
        config.workspace_dir(c)
    except (ValueError, HTTPException) as e:
        raise HTTPException(404, f"no such workspace: {c}") from e


# The routes run on the event loop, where the writes' stream records (`cell`, `report`) can be emitted; a card or a
# document write is quick.


@router.get("/ws/{c}/undo")
async def get_undo(c: str) -> dict[str, str | None]:
    """The two labels. The browser asks when it opens the workspace, so the canvas's cards are kept as they stand
    (canvas_history.prime) and the first change to each is a step too."""
    from . import canvas_history  # noqa: PLC0415 — canvas_history imports this module

    _check(c)
    canvas_history.prime(c)
    return labels(c)


@router.post("/ws/{c}/undo")
async def post_undo(c: str) -> dict[str, Any]:
    _check(c)
    return undo(c)


@router.post("/ws/{c}/redo")
async def post_redo(c: str) -> dict[str, Any]:
    _check(c)
    return redo(c)
