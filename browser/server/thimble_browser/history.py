"""A card's earlier versions, and Undo and Redo over the workspace's changes, whoever made them.

Versions. Each edit of what a card says (canvas.update_card) adds an entry {by, ts, id, fields} to the card's `edited`
list. This module keeps, for each entry, the card as it stood before that edit: `card-history/<card>.jsonl`, a line
{id, ts, by, fields, was, shown?}, `was` the card's question, kind, code, payload, takeaway and text before the edit,
and `shown` its outputs and status when the edit changed its code or kind. The card before an edit shows the outputs
of the first later edit that kept them, else the card's own.

    GET  /api/ws/{c}/cells/{id}/versions/{entry}           the card as it stood before edit `entry`
    POST /api/ws/{c}/cells/{id}/versions/{entry}/restore   make it so again, as an edit of the analyst's

Undo. A step is one change to a card (added, deleted, edited, moved, resized, starred) or one save of the report,
by the analyst or by Claude. The two stacks are `undo.json` in the workspace, each kept to MAX_STEPS. Claude's edit of a
card it added, with no other step on that card since, joins the step that added it, so a card Claude makes and then
gives its takeaway is one step; a run of a card's code is no step, but its outputs join the step that changed that code,
so an undo or a redo shows the drawing of the code it puts back. While Claude works in the workspace, Undo passes over
Claude's steps to the analyst's newest, and refuses when one of Claude's later steps changed the same card or the
report. The writes of an undo or a redo make no step and no version of their own.

    GET  /api/ws/{c}/undo    {undo, redo, held}: the label of the step each would apply, and why Undo waits
    POST /api/ws/{c}/undo    revert the step; 409 when there is none or it cannot be reverted
    POST /api/ws/{c}/redo    apply the step undone last again
"""
from __future__ import annotations

import copy
import json
import logging
import secrets
import threading
from pathlib import Path
from typing import Any

from fastapi import HTTPException

from . import canvas, home, report
from .hub import hub

log = logging.getLogger("thimble_browser.history")

MAX_STEPS = 100
CONTENT = ("title", "kind", "code", "program", "payload", "takeaway", "text")  # what a version holds of a card
RUN = ("outputs", "status")  # what a run changes, kept with the edit of the code it ran
# the fields a card's step restores, by what the step is
EDIT_FIELDS = ("title", "slug", "kind", "code", "program", "payload", "text", "takeaway", "takeaway_author")
TOGGLE_FIELDS = ("starred",)
PLACE_FIELDS = ("pos", "width", "height")
ANALYST = "analyst"
_lock = threading.RLock()
_sessions: Any = None  # the server's agent.Sessions, to know whether Claude works in a workspace


# --------------------------------------------------------------------------- versions


def _history_path(ws: str, cid: str) -> Path:
    if not home.NAME_RE.match(cid):
        raise KeyError(cid)
    d = home.workspace_dir(ws) / "card-history"
    d.mkdir(parents=True, exist_ok=True)
    return d / f"{cid}.jsonl"


def _records(ws: str, cid: str) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    try:
        with open(_history_path(ws, cid), encoding="utf-8") as f:
            for line in f:
                try:
                    r = json.loads(line)
                except ValueError:
                    continue
                if isinstance(r, dict) and r.get("id"):
                    out[str(r["id"])] = r
    except OSError:
        pass
    return out


def _keep_version(ws: str, before: dict[str, Any], after: dict[str, Any]) -> None:
    """The card as it stood before its newest edit entry, kept under that entry's id."""
    entries = [e for e in after.get("edited") or [] if isinstance(e, dict)]
    if not entries or not entries[-1].get("id"):
        return
    e = entries[-1]
    if len(entries) == len([x for x in before.get("edited") or [] if isinstance(x, dict)]):
        return  # this change added no entry: a move, a star, a lock
    rec: dict[str, Any] = {"id": e["id"], "ts": e.get("ts"), "by": e.get("by"), "fields": e.get("fields") or [],
                           "was": {k: copy.deepcopy(before.get(k)) for k in CONTENT if k in before}}
    if {"code", "program", "kind"} & set(rec["fields"]):
        rec["shown"] = {k: copy.deepcopy(before.get(k)) for k in RUN}
    with _lock, open(_history_path(ws, str(after["id"])), "a", encoding="utf-8") as f:
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")


def version_of(ws: str, cell: dict[str, Any], entry: str) -> dict[str, Any]:
    """{entry, version}: the card as it stood before its edit `entry`. KeyError when the card has no such edit or its
    record was not kept."""
    cid = str(cell["id"])
    entries = [e for e in cell.get("edited") or [] if isinstance(e, dict)]
    at = next((i for i, e in enumerate(entries) if e.get("id") == entry), None)
    recs = _records(ws, cid)
    if at is None or entry not in recs:
        raise KeyError(f"card {cid} has no kept version before the edit {entry}")
    state = copy.deepcopy(recs[entry]["was"])
    shown = next((recs[e["id"]]["shown"] for e in entries[at:] if e.get("id") in recs and "shown" in recs[e["id"]]),
                 None)
    state.update(copy.deepcopy(shown) if shown is not None else {k: copy.deepcopy(cell.get(k)) for k in RUN})
    return {"entry": entries[at], "version": state}


def earlier_outputs(ws: str, cell: dict[str, Any]) -> list[tuple[dict[str, Any], list[Any]]]:
    """canvas.on_earlier: (edit entry, the outputs the card showed before it) for each of the card's kept edits that
    changed what it shows, newest first, so a citation written before an edit still finds the value it cited."""
    recs = _records(ws, str(cell["id"]))
    out = []
    for e in reversed([e for e in cell.get("edited") or [] if isinstance(e, dict)]):
        if e.get("id") in recs and "shown" in recs[e["id"]]:
            outs = (recs[e["id"]]["shown"] or {}).get("outputs")
            if isinstance(outs, list):
                out.append((e, outs))
    return out


def restore(ws: str, cid: str, entry: str) -> dict[str, Any]:
    """Make card `cid` as it stood before its edit `entry`, as an edit of the analyst's, with the outputs it showed
    then, so it shows them without a run. The card."""
    _, cell = canvas.find(ws, cid)
    v = version_of(ws, cell, entry)["version"]
    args: dict[str, Any] = {"question": v.get("title") or cell["title"], "takeaway": v.get("takeaway") or ""}
    if cell["kind"] in canvas.CODE_KINDS:
        args["code"] = v.get("code") or ""
        if v.get("program") is not None:
            args["program"] = v["program"]
        if v.get("kind") in canvas.CODE_KINDS:
            args["kind"] = v["kind"]
    elif cell["kind"] == "note":
        args["text"] = v.get("text") if v.get("text") is not None else (v.get("payload") or {}).get("text", "")
    elif cell["kind"] == "example":
        args["refs"] = (v.get("payload") or {}).get("refs") or []
    elif cell["kind"] == "custom":
        args["html"] = (v.get("payload") or {}).get("html") or ""
    code_changed = cell["kind"] in canvas.CODE_KINDS and ((v.get("code") or "") != (cell.get("code") or "")
                                                          or (v.get("program") or "") != (cell.get("program") or ""))
    cell = canvas.update_card(ws, cid, args, by=ANALYST)
    if code_changed and isinstance(v.get("outputs"), list):
        cell = canvas.set_run(ws, cid, outputs=v["outputs"], status=v.get("status") or "idle")
    return cell


# --------------------------------------------------------------------------- the stacks


def _stacks_path(ws: str) -> Path:
    return home.workspace_dir(ws) / "undo.json"


def _load(ws: str) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    got = home.read_json(_stacks_path(ws), {}) or {}
    return list(got.get("undo") or []), list(got.get("redo") or [])


def _save(ws: str, undo: list[dict[str, Any]], redo: list[dict[str, Any]]) -> None:
    home.write_json(_stacks_path(ws), {"undo": undo[-MAX_STEPS:], "redo": redo[-MAX_STEPS:]})


_applying = threading.local()


def _is_applying() -> bool:
    return bool(getattr(_applying, "on", False))


def _name(card: dict[str, Any] | None) -> str:
    card = card or {}
    return str(card.get("slug") or card.get("id") or "")


def _card_label(op: str, fields: set[str], card: dict[str, Any]) -> str:
    name = _name(card)
    if op == "created":
        return f"add card {name}"
    if op == "deleted":
        return f"delete card {name}"
    if fields == {"starred"}:
        return f"{'star' if card.get('starred') else 'unstar'} card {name}"
    if fields <= {"pos"}:
        return f"move card {name}"
    if fields <= {"width", "height", "pos"}:
        return f"resize card {name}"
    for key, words in (("takeaway", "the takeaway of"), ("title", "the question of"), ("code", "the code of")):
        if key in fields and not (fields - {key, "takeaway_author", "slug"} - set(RUN)):
            return f"edit {words} card {name}"
    return f"edit card {name}"


def _push(ws: str, step: dict[str, Any]) -> None:
    undo, _ = _load(ws)
    undo.append({"id": secrets.token_hex(4), "ts": home.now(), **step})
    _save(ws, undo, [])


def _on_card(ws: str, op: str, before: dict[str, Any] | None, after: dict[str, Any] | None, *, by: str,
             prior: str | None = None) -> None:
    """canvas.on_change: keep the version an edit replaced, and make the change an undo step (module note)."""
    if op == "edited" and before and after:
        _keep_version(ws, before, after)
    if _is_applying():
        return
    with _lock:
        if op == "created" and after:
            _push(ws, {"kind": "card", "op": "created", "target": after["id"], "by": by, "prior": prior,
                       "after": after, "label": _card_label("created", set(), after)})
        elif op == "deleted" and before:
            _push(ws, {"kind": "card", "op": "deleted", "target": before["id"], "by": by, "prior": prior,
                       "before": before, "label": _card_label("deleted", set(), before)})
        elif op == "edited" and before and after:
            _edited(ws, before, after, by)
        elif op == "ran" and after and after.get("status") != "running":
            _ran(ws, after)


def _edited(ws: str, before: dict[str, Any], after: dict[str, Any], by: str) -> None:
    keys = EDIT_FIELDS + TOGGLE_FIELDS + PLACE_FIELDS
    fields = {k for k in keys if before.get(k) != after.get(k)}
    if not fields:
        return
    if {"code", "program"} & fields:
        fields |= set(RUN)
    undo, redo = _load(ws)
    cid = after["id"]
    mine = [i for i, s in enumerate(undo) if s.get("kind") == "card" and s.get("target") == cid]
    if by != ANALYST and mine and undo[mine[-1]].get("op") == "created" and undo[mine[-1]].get("by") == by:
        undo[mine[-1]]["after"] = copy.deepcopy(after)  # Claude's edit of a card it added joins that step
        _save(ws, undo, [])
        return
    _push(ws, {"kind": "card", "op": "edited", "target": cid, "by": by,
               "before": {k: copy.deepcopy(before.get(k)) for k in fields},
               "after": {k: copy.deepcopy(after.get(k)) for k in fields},
               "label": _card_label("edited", fields, after)})


def _ran(ws: str, cell: dict[str, Any]) -> None:
    """A run landed: its outputs join the newest step on the card when that step added the card or changed its code to
    the code that ran."""
    undo, redo = _load(ws)
    step = next((s for s in reversed(undo) if s.get("kind") == "card" and s.get("target") == cell["id"]), None)
    if step is None:
        return
    if step.get("op") == "created" and (step.get("after") or {}).get("code") == cell.get("code"):
        step["after"] = copy.deepcopy(cell)
    elif step.get("op") == "edited" and (step.get("after") or {}).get("code") == cell.get("code") \
            and ("code" in (step.get("after") or {}) or "program" in (step.get("after") or {})):
        step["after"].update({k: copy.deepcopy(cell.get(k)) for k in RUN})
    else:
        return
    _save(ws, undo, redo)


def _on_report(ws: str, before: str | None, after: str, by: str) -> None:
    """report.on_save: a save that changed the text is a step."""
    if _is_applying() or (before or "").strip() == after.strip():
        return
    with _lock:
        _push(ws, {"kind": "doc", "op": "edited", "target": report.DOC, "by": by, "before": before, "after": after,
                   "label": "edit the report" if by == ANALYST else "write the report"})


# --------------------------------------------------------------------------- choosing and applying a step


def _claude_works(ws: str) -> bool:
    try:
        return bool(_sessions and _sessions.running(ws))
    except Exception:  # noqa: BLE001
        return False


def _pick(ws: str, undo: list[dict[str, Any]]) -> tuple[int | None, str | None]:
    """(where the step an undo reverts sits on the stack, why Undo waits): the top step, or while Claude works the
    analyst's newest, refused when a later step of Claude's changed the same card or the report."""
    if not undo:
        return None, None
    if not _claude_works(ws):
        return len(undo) - 1, None
    at = next((i for i in range(len(undo) - 1, -1, -1) if undo[i].get("by") == ANALYST), None)
    if at is None:
        return None, "Claude is still working; what it changed can be undone once it stops"
    target = (undo[at].get("kind"), undo[at].get("target"))
    if any((s.get("kind"), s.get("target")) == target for s in undo[at + 1:]):
        return None, "Claude has changed this since and is still working; undo it once Claude stops"
    return at, None


def labels(ws: str) -> dict[str, Any]:
    with _lock:
        undo, redo = _load(ws)
        at, held = _pick(ws, undo)
        return {"undo": undo[at]["label"] if at is not None else None, "redo": redo[-1]["label"] if redo else None,
                "held": held}


def _put_card(ws: str, card: dict[str, Any], prior: str | None) -> None:
    """A card back into its group (the canvas's first group when that group is gone), after the card that preceded it."""
    try:
        canvas.find(ws, card["id"])
        raise HTTPException(409, f"card {card['id']} is on the canvas already")
    except KeyError:
        pass
    with canvas._lock:
        try:
            nb = canvas.load(ws, str(card.get("notebook") or ""))
        except KeyError:
            nb = canvas.group_for(ws, None)
        card = {**copy.deepcopy(card), "notebook": nb["id"]}
        ids = [c["id"] for c in nb["cells"]]
        at = ids.index(prior) + 1 if prior in ids else (0 if prior is None else len(ids))
        nb["cells"].insert(at, card)
        canvas.save(ws, nb)
    canvas.emit(ws, card, "added")


def _drop_card(ws: str, cid: str) -> None:
    with canvas._lock:
        try:
            nb, cell = canvas.find(ws, cid)
        except KeyError:
            return  # gone already
        nb["cells"] = [c for c in nb["cells"] if c["id"] != cid]
        canvas.save(ws, nb)
    canvas.emit(ws, cell, "deleted")


def _set_card(ws: str, cid: str, fields: dict[str, Any]) -> None:
    with canvas._lock:
        try:
            nb, cell = canvas.find(ws, cid)
        except KeyError:
            raise HTTPException(409, f"card {cid} is no longer on the canvas") from None
        for k, v in fields.items():
            if v is None and k not in PLACE_FIELDS:
                cell.pop(k, None)
            else:
                cell[k] = copy.deepcopy(v)
        if isinstance(fields.get("payload"), dict) and cell.get("kind") == "note" and "text" not in fields:
            cell["text"] = fields["payload"].get("text", "")
        cell["ts"] = home.now()
        nb["cells"] = [cell if c["id"] == cid else c for c in nb["cells"]]
        canvas.save(ws, nb)
    canvas.emit(ws, cell, "edited")


def _set_report(ws: str, md: str | None) -> None:
    p = home.workspace_dir(ws) / "docs" / f"{report.DOC}.md"
    if md is None:
        try:
            p.unlink()
        except OSError:
            pass
    else:
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(md, encoding="utf-8")
    hub.publish(ws, {"type": "report", "slug": report.DOC, "status": "edited", "by": "undo"})


def _apply(ws: str, step: dict[str, Any], forward: bool) -> None:
    _applying.on = True
    try:
        if step["kind"] == "doc":
            _set_report(ws, step.get("after") if forward else step.get("before"))
            return
        op, cid = step["op"], str(step["target"])
        if op == "created":
            _put_card(ws, step["after"], step.get("prior")) if forward else _drop_card(ws, cid)
        elif op == "deleted":
            _drop_card(ws, cid) if forward else _put_card(ws, step["before"], step.get("prior"))
        else:
            _set_card(ws, cid, step["after"] if forward else step["before"])
    finally:
        _applying.on = False


def undo(ws: str) -> dict[str, Any]:
    with _lock:
        stack, redo = _load(ws)
        at, held = _pick(ws, stack)
        if held:
            raise HTTPException(409, held)
        if at is None:
            raise HTTPException(409, "nothing to undo")
        step = stack.pop(at)
        try:
            _apply(ws, step, forward=False)
        except HTTPException:
            _save(ws, stack, redo)  # a step that cannot be reverted any more is dropped
            raise
        redo.append(step)
        _save(ws, stack, redo)
        return {"applied": step["label"], **labels(ws)}


def redo(ws: str) -> dict[str, Any]:
    with _lock:
        stack, redo_ = _load(ws)
        if not redo_:
            raise HTTPException(409, "nothing to redo")
        step = redo_.pop()
        try:
            _apply(ws, step, forward=True)
        except HTTPException:
            _save(ws, stack, redo_)
            raise
        stack.append(step)
        _save(ws, stack, redo_)
        return {"applied": step["label"], **labels(ws)}


# --------------------------------------------------------------------------- routes


def register(ctx: Any) -> None:
    global _sessions
    _sessions = ctx.sessions
    canvas.on_change(_on_card)
    canvas.on_earlier(earlier_outputs)
    report.on_save(_on_report)
    app = ctx.app

    # the routes that change the canvas run on the event loop, where the stream's records are published
    @app.get("/api/ws/{c}/cells/{cid}/versions/{entry}")
    def card_version(c: str, cid: str, entry: str) -> dict[str, Any]:
        ws = ctx.ws_of(c)
        try:
            _, cell = canvas.find(ws, cid)
            got = version_of(ws, cell, entry)
        except KeyError as e:
            raise HTTPException(404, str(e).strip("'")) from None
        e, v = got["entry"], got["version"]
        payload = v.get("payload")
        text = v.get("text") if v.get("text") is not None else (payload or {}).get("text") if v.get("kind") == "note" \
            and isinstance(payload, dict) else None
        return {"card": cell["id"], "before": entry, "by": e.get("by"), "ts": e.get("ts"), "fields": e.get("fields") or [],
                "version": {**v, "id": cell["id"], "notebook": cell.get("notebook"), "title": v.get("title") or "",
                            "takeaway": v.get("takeaway") or "", "text": text}}

    @app.post("/api/ws/{c}/cells/{cid}/versions/{entry}/restore")
    async def card_restore(c: str, cid: str, entry: str) -> dict[str, Any]:
        ws = ctx.ws_of(c)
        try:
            return restore(ws, cid, entry)
        except KeyError as e:
            raise HTTPException(404, str(e).strip("'")) from None
        except ValueError as e:
            raise HTTPException(400, str(e)) from None

    @app.get("/api/ws/{c}/undo")
    def get_undo(c: str) -> dict[str, Any]:
        return labels(ctx.ws_of(c))

    @app.post("/api/ws/{c}/undo")
    async def post_undo(c: str) -> dict[str, Any]:
        return undo(ctx.ws_of(c))

    @app.post("/api/ws/{c}/redo")
    async def post_redo(c: str) -> dict[str, Any]:
        return redo(ctx.ws_of(c))
