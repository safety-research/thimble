"""The canvas's history: one line per change to a card, with the card as it stood after the change, in
workspaces/<c>/canvas-history.jsonl, so earlier versions and deleted cards are kept (export.py reads it).

notebook._emit calls record() on every change; a line is appended only when the card's content differs from the last
line written for it. A line is `{ts, op, card, group, by, changed, h, state}`: `op` is `created`, `seen` (first line of
an older card), `edited`, `ran`, `credited`, `moved` or `deleted`; `changed` names the fields that differ; `h` is the
content's digest. A group moved as a whole writes `{ts, op: "group-moved", group, title, by, from, to, cards}`.
Failures are logged and swallowed: the history never blocks a change to the canvas.

The same hook feeds the undo history (undo.py): `_snaps` keeps each card after its last change and the card before it
in its group, and each change that is an undo step goes to undo.card_changed (a bare run to undo.card_ran).
"""
from __future__ import annotations

import asyncio
import contextvars
import copy
import hashlib
import json
import logging
import threading
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

from . import config, ledger, undo

log = logging.getLogger("thimble.canvas_history")

LOG_NAME = "canvas-history.jsonl"
TEXT_CHARS = 4000  # of each text output kept in a line
CONTENT_KEYS = ("kind", "title", "code", "payload", "takeaway", "takeaway_author", "labels", "locked", "starred")
RUN_KEYS = ("status", "exec_count", "outputs")
MAKER_KEY = "created_by"
PLACE_KEYS = ("notebook", "pos")
TEXT_MIMES = ("text/plain", "text/markdown")

# the caller a thimble tool runs for and the task running the call, set by tools.call around the handler (acting); unset
# on the browser's routes. A task the call starts (the orientation's follower, a job) inherits the context, so the author
# holds only in the calling task itself or in a worker thread (asyncio.to_thread, where there is no current task).
AUTHOR: contextvars.ContextVar[tuple[str, Any] | None] = contextvars.ContextVar("thimble_canvas_author", default=None)

_lock = threading.Lock()
_loaded: set[str] = set()  # workspaces whose log has been read into _last
_last: dict[tuple[str, str], dict[str, Any]] = {}  # (workspace, card) -> {h, parts} of the last line written
# (workspace, card) -> {cell, prior}: for undo, the card as it stood after its last change and the card before it
_snaps: dict[tuple[str, str], dict[str, Any]] = {}
# the fields whose change is an undo step (undo.CARD_FIELDS), by what the step is
EDIT_FIELDS = ("title", "slug", "code", "payload", "text", "labels", "takeaway", "takeaway_author", "locked", "starred", "kind")
MOVE_FIELDS = ("notebook", "pos")
SIZE_FIELDS = ("width", "height")
_started = datetime.now(timezone.utc)


@contextmanager
def acting(author: str | None) -> Iterator[None]:
    """Name who a tool call acts for, for the lines its changes write."""
    token = AUTHOR.set((author, _task()) if author else None)
    try:
        yield
    finally:
        AUTHOR.reset(token)


def _task() -> Any:
    try:
        return asyncio.current_task()
    except RuntimeError:  # no running loop: a worker thread
        return None


def author() -> str | None:
    """Who the tool call running here acts for (AUTHOR), or None outside one."""
    held = AUTHOR.get()
    if not held:
        return None
    who, task = held
    now = _task()
    return who if now is None or task is None or now is task else None


def log_path(c: str) -> Path:
    return config.workspace_dir(c) / LOG_NAME


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def group_moved(c: str, group: str, *, title: str, by: str, from_parent: str | None, to_parent: str | None,
                cards: list[str]) -> None:
    """Append the line of a group moved as a whole (the docstring above). Never raises."""
    try:
        line = {"ts": _now(), "op": "group-moved", "group": group, "title": title, "by": by, "from": from_parent,
                "to": to_parent, "cards": list(cards)}
        with _lock:
            ledger.append_jsonl_locked(log_path(c), line)
    except Exception:  # noqa: BLE001 — the history never blocks a change
        log.exception("%s: could not record the move of group %s", c, group)


def outputs_summary(outputs: Any) -> list[dict[str, Any]]:
    """Each output as {mimes, text?, bytes}: the start of its text, and the size of what is not text."""
    out: list[dict[str, Any]] = []
    for o in outputs if isinstance(outputs, list) else []:
        if not isinstance(o, dict):
            continue
        entry: dict[str, Any] = {"mimes": sorted(str(k) for k in o)}
        text = next((o[m] for m in TEXT_MIMES if isinstance(o.get(m), str)), None)
        if text is None and isinstance(o.get("text"), str):
            text = o["text"]
        if text is not None:
            entry["text"] = text if len(text) <= TEXT_CHARS else text[:TEXT_CHARS] + f"\n[… {len(text) - TEXT_CHARS} chars cut]"
        try:
            entry["bytes"] = len(json.dumps(o, ensure_ascii=False, default=str).encode("utf-8"))
        except (TypeError, ValueError):
            entry["bytes"] = None
        out.append(entry)
    return out


def state_of(cell: dict[str, Any]) -> dict[str, Any]:
    """The card's content as a line records it."""
    st: dict[str, Any] = {k: cell.get(k) for k in CONTENT_KEYS if k in cell}
    for k in ("status", "exec_count", MAKER_KEY, "created_ts", "created_at_event", "pos"):
        if cell.get(k) is not None:
            st[k] = cell.get(k)
    st["outputs"] = outputs_summary(cell.get("outputs"))
    return st


def _digest(obj: Any) -> str:
    return hashlib.sha1(json.dumps(obj, sort_keys=True, ensure_ascii=False, default=str).encode("utf-8")).hexdigest()[:16]


def _parts(cell: dict[str, Any], state: dict[str, Any]) -> dict[str, str]:
    """One digest per field a line compares, so `changed` can name what differs."""
    parts = {k: _digest(state.get(k)) for k in CONTENT_KEYS}
    parts.update({k: _digest(state.get(k) if k != "outputs" else state["outputs"]) for k in RUN_KEYS})
    parts[MAKER_KEY] = _digest(cell.get(MAKER_KEY))
    parts.update({k: _digest(cell.get(k)) for k in PLACE_KEYS})
    return parts


def _load(c: str, path: Path) -> None:
    """Read the workspace's log once per process, so the first change after a restart compares with the last line."""
    if c in _loaded:
        return
    _loaded.add(c)
    try:
        lines = path.read_text("utf-8").splitlines() if path.is_file() else []
    except OSError:
        lines = []
    for line in lines:
        try:
            r = json.loads(line)
        except ValueError:
            continue
        if not isinstance(r, dict) or not r.get("card"):
            continue
        key = (c, str(r["card"]))
        if r.get("op") == "deleted":
            _last.pop(key, None)
        elif isinstance(r.get("state"), dict):
            state = r["state"]
            _last[key] = {"h": r.get("h"), "parts": _parts({**state, "notebook": r.get("group")}, state)}


def _is_new(cell: dict[str, Any]) -> bool:
    """Made since this process started: the first line of such a card is its creation."""
    raw = str(cell.get("created_ts") or cell.get("ts") or "")
    try:
        made = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return False
    if made.tzinfo is None:
        made = made.replace(tzinfo=timezone.utc)
    return made.replace(microsecond=0) >= _started.replace(microsecond=0)


def _by(cell: dict[str, Any], op: str, changed: list[str]) -> str:
    if op in ("created", "seen", "credited"):
        return str(cell.get(MAKER_KEY) or author() or "analyst")
    who = author()
    if who:
        return who
    if op == "edited":
        edited = cell.get("edited")
        if set(changed) & {"title", "code", "payload", "kind"} and isinstance(edited, list) and edited \
                and isinstance(edited[-1], dict) and edited[-1].get("by"):
            return str(edited[-1]["by"])
        if "takeaway" in changed and cell.get("takeaway_author") not in (None, "analyst"):
            return str(cell["takeaway_author"])
    return "analyst"


def record(c: str, cell: dict[str, Any], what: str | None = None) -> str | None:
    """Write the line this change to `cell` calls for, if any, and hand a change that is an undo step to undo.py
    (module note). Returns the line's `op`, None when no line was written (nothing the history records changed) or
    the write failed. Never raises."""
    try:
        step, ran, op = _record(c, cell, what)
    except Exception:  # noqa: BLE001 — the history never stops a change to the canvas
        log.exception("canvas history: the change to card %s was not recorded", cell.get("id"))
        return None
    # outside the lock: an undo applying a step holds its own lock while its writes come back through here
    if step is not None:
        undo.card_changed(c, *step)
    elif ran:
        undo.card_ran(c, cell)
    return op


def _prior(c: str, cell: dict[str, Any]) -> str | None:
    """The id of the card before `cell` in its group's flow, where the undo of its delete puts it back; None when it is
    first or its group cannot be read."""
    from . import notebook  # noqa: PLC0415 — notebook imports this module

    try:
        nb = notebook.read_notebook(config.workspace_dir(c), str(cell.get("notebook") or ""))
    except Exception:  # noqa: BLE001
        return None
    ids = [str(x.get("id")) for x in (nb or {}).get("cells") or []]
    i = ids.index(str(cell.get("id"))) if str(cell.get("id")) in ids else -1
    return ids[i - 1] if i > 0 else None


def prime(c: str) -> None:
    """Keep every card now on the canvas of `c` as it stands, so the first change to each is an undo step with the card
    as it was, where no change since this process started has shown it yet. Never raises."""
    from . import notebook  # noqa: PLC0415

    try:
        ws = config.workspace_dir(c)
        for nb in notebook.list_notebooks(ws):
            full = notebook.read_notebook(ws, str(nb.get("id") or "")) or {}
            prior = None
            for cell in full.get("cells") or []:
                cid = str(cell.get("id") or "")
                if cid:
                    with _lock:
                        _snaps.setdefault((c, cid), {"cell": copy.deepcopy({**cell, "notebook": full.get("id")}), "prior": prior})
                    prior = cid
    except Exception:  # noqa: BLE001
        log.exception("canvas history: %s's cards were not read for undo", c)


def _undo_step(snap: dict[str, Any] | None, cell: dict[str, Any], what: str | None, op: str | None, by: str,
               prior: str | None) -> tuple | None:
    """The arguments of undo.card_changed for this change, or None when it is no step: a card added (not one first seen
    with nothing known of how it was), deleted, edited, moved to another group or place, or resized."""
    before = snap.get("cell") if snap else None
    if what == "deleted":
        return ("deleted", cell, cell, [], by, snap.get("prior") if snap else prior)
    if before is None:
        return ("created", None, cell, [], by, prior) if op == "created" else None
    diff = lambda keys: [k for k in keys if before.get(k) != cell.get(k)]  # noqa: E731
    if diff(EDIT_FIELDS):
        return ("edited", before, cell, diff(EDIT_FIELDS + SIZE_FIELDS), by, prior)
    if diff(MOVE_FIELDS):
        return ("moved", before, cell, diff(MOVE_FIELDS), by, prior)
    if diff(SIZE_FIELDS):
        return ("resized", before, cell, diff(SIZE_FIELDS), by, prior)
    return None


def _record(c: str, cell: dict[str, Any], what: str | None) -> tuple[tuple | None, bool, str | None]:
    """(the arguments of undo.card_changed when the change is an undo step, else None; whether it is a run of the card's
    code and nothing else, a line `ran`, which undo.card_ran keeps with the step that changed that code; the line's
    op, None when no line is written)."""
    cid = str(cell.get("id") or "")
    if not cid:
        return None, False, None
    path = log_path(c)
    key = (c, cid)
    with _lock:
        _load(c, path)
        prev = _last.get(key)
        snapshot = copy.deepcopy(cell)
        op: str | None
        if what == "deleted":
            state = state_of(cell)
            op, changed, parts = "deleted", [], _parts(cell, state)
        else:
            if cell.get("status") == "running" and prev is not None:
                return None, False, None  # the pre-run save: the run's result writes the line
            state = state_of(cell)
            parts = _parts(cell, state)
            if prev is None:
                op, changed = ("created" if _is_new(cell) else "seen"), []
            else:
                changed = [k for k, v in parts.items() if prev["parts"].get(k) != v]
                if not changed:
                    op = None  # nothing a line records; a resize is still an undo step
                elif what == "moved" or (set(changed) <= set(PLACE_KEYS) | set(RUN_KEYS) and "notebook" in changed):
                    op = "moved"
                elif set(changed) <= set(PLACE_KEYS):
                    op = None  # a card dragged to another place in the same frame: layout, not history
                elif set(changed) <= set(RUN_KEYS):
                    op = "ran"
                elif set(changed) <= {MAKER_KEY}:
                    op = "credited"
                else:
                    op = "edited"
                changed = [k for k in changed if k != "pos" or op == "moved"]
        prior = _prior(c, cell) if op != "deleted" else None
        by = _by(cell, op or "edited", changed)
        step = _undo_step(_snaps.get(key), snapshot, what, op, by, prior)
        if op == "deleted":
            _snaps.pop(key, None)
        else:
            _snaps[key] = {"cell": snapshot, "prior": prior}
        if op is None:
            return step, False, None
        h = _digest(parts)
        line = {"ts": _now(), "op": op, "card": cid, "group": cell.get("notebook"), "by": by,
                "changed": changed, "h": h, "state": state}
        ledger.append_jsonl_locked(path, line)  # the shim and the hooks' backend calls write it in terminal mode
        if op == "deleted":
            _last.pop(key, None)
        else:
            _last[key] = {"h": h, "parts": parts}
        return step, op == "ran", op


def forget(c: str | None = None) -> None:
    """Drop what this process remembers of a workspace's log (every workspace when None), for tests and a reset."""
    with _lock:
        for key in [k for k in _last if c is None or k[0] == c]:
            _last.pop(key, None)
        for key in [k for k in _snaps if c is None or k[0] == c]:
            _snaps.pop(key, None)
        if c is None:
            _loaded.clear()
        else:
            _loaded.discard(c)
