"""The canvas as the analyst arranges it (feature module): its groups (the frames), where cards and frames sit, and the
cards the analyst adds. The routes are thimble 0.8's (frontend canvas/Canvas.tsx and lib/api.ts canvasApi).

- GET /api/ws/{c}/notebooks: the groups, without their cards.
- POST /api/ws/{c}/notebooks: a new group, at the root or under `parent`, placed by `pos` or `order`.
- PUT /api/ws/{c}/notebooks/{nb}: a group renamed, moved under another (`parent`, null for the root) or placed.
- DELETE /api/ws/{c}/notebooks/{nb}: the group with the groups under it and all their cards, moved to the
  workspace's trash folder.
- POST /api/ws/{c}/cells/move: cards in order into a group's flow (`after` a card of it, null first, left out last),
  or one card free at `pos`.
- POST /api/ws/{c}/notebooks/{nb}/cells: a card the analyst adds (an empty code card is allowed), after `after`.
- POST /api/ws/{c}/notebooks/{nb}/run: a code card made and run in one call.

Everything here changes the workspace's own store, never the folder of files.
"""
from __future__ import annotations

import secrets
from typing import Any

from fastapi import Body, HTTPException

from . import canvas, home
from .hub import hub

KINDS = ("sequence", "split")
_LAST = object()


def _pos(v: Any) -> dict[str, float] | None:
    """{x, y} numbers, or None; ValueError for anything else."""
    if v is None:
        return None
    if isinstance(v, dict) and all(isinstance(v.get(k), (int, float)) and not isinstance(v.get(k), bool)
                                   for k in ("x", "y")):
        return {"x": v["x"], "y": v["y"]}
    raise ValueError("pos must be {x, y} numbers or null")


def _order(v: Any) -> int | None:
    if v is None:
        return None
    if isinstance(v, int) and not isinstance(v, bool) and v >= 0:
        return v
    raise ValueError("order must be a whole number from 0, or null")


def summary(nb: dict[str, Any]) -> dict[str, Any]:
    return {**{k: v for k, v in nb.items() if k != "cells"}, "n_cells": len(nb.get("cells") or [])}


def _group(ws: str, nb: str) -> dict[str, Any]:
    try:
        return canvas.load(ws, nb)
    except KeyError:
        raise HTTPException(404, f"no such group: {nb}") from None


def subtree(ws: str, nb: str) -> list[str]:
    """The group and every group under it, parents first."""
    kids: dict[str, list[str]] = {}
    for g in canvas.notebooks(ws):
        if g.get("parent"):
            kids.setdefault(str(g["parent"]), []).append(g["id"])
    out: list[str] = []
    todo = [nb]
    while todo:
        gid = todo.pop(0)
        if gid not in out:
            out.append(gid)
            todo.extend(kids.get(gid, []))
    return out


def create_group(ws: str, body: dict[str, Any]) -> dict[str, Any]:
    parent = body.get("parent")
    if parent is not None:
        _group(ws, str(parent))
    try:
        pos, order = _pos(body.get("pos")), _order(body.get("order"))
    except ValueError as e:
        raise HTTPException(400, str(e)) from None
    kind = body.get("kind") if body.get("kind") in KINDS else "sequence"
    nb = {"id": secrets.token_hex(4), "title": str(body.get("title") or "").strip() or "New frame", "parent": parent,
          "kind": kind, "anchor": None, "chat": None, "role": str(body.get("role") or "analyst"), "ts": home.now(),
          "pos": pos, "order": order, "cells": []}
    with canvas._lock:
        canvas.save(ws, nb)
    hub.publish(ws, {"type": "group", "notebook": nb["id"], "kind": "added"})
    return summary(nb)


def update_group(ws: str, nb_id: str, body: dict[str, Any]) -> dict[str, Any]:
    with canvas._lock:
        nb = _group(ws, nb_id)
        try:
            if "pos" in body:
                nb["pos"] = _pos(body["pos"])
            if "order" in body:
                nb["order"] = _order(body["order"])
        except ValueError as e:
            raise HTTPException(400, str(e)) from None
        if "parent" in body:
            parent = body["parent"]
            if parent is not None:
                _group(ws, str(parent))
                if str(parent) in subtree(ws, nb_id):
                    raise HTTPException(400, "a group cannot go inside itself or a group under it")
            nb["parent"] = parent
        if isinstance(body.get("title"), str) and body["title"].strip():
            nb["title"] = body["title"].strip()
        if body.get("kind") in KINDS:
            nb["kind"] = body["kind"]
        canvas.save(ws, nb)
    hub.publish(ws, {"type": "group", "notebook": nb_id, "kind": "edited"})
    return summary(nb)


def delete_group(ws: str, nb_id: str) -> None:
    trash = home.workspace_dir(ws) / "trash" / "notebooks"
    gone: list[dict[str, Any]] = []
    with canvas._lock:
        _group(ws, nb_id)
        for gid in subtree(ws, nb_id):
            p = canvas._path(ws, gid)
            if not p.is_file():
                continue
            g = canvas.load(ws, gid)
            gone.extend({**c, "notebook": gid} for c in g.get("cells") or [])
            trash.mkdir(parents=True, exist_ok=True)
            p.replace(trash / f"{gid}-{secrets.token_hex(3)}.json")
    for cell in gone:
        canvas.emit(ws, cell, "deleted")
    hub.publish(ws, {"type": "group", "notebook": nb_id, "kind": "deleted"})


def move_cells(ws: str, ids: list[str], group: str | None, after: Any = _LAST, pos: Any = None) -> list[dict]:
    """Cards into `group` (None for the canvas's main group) in the order given, after the card `after` names (None
    first, by default last), or one card free at `pos`. Nothing changes on an error."""
    if not ids:
        raise HTTPException(400, "no cards to move")
    if len(set(ids)) != len(ids):
        raise HTTPException(400, "a card is named twice")
    try:
        place = _pos(pos)
    except ValueError as e:
        raise HTTPException(400, str(e)) from None
    if place is not None and len(ids) > 1:
        raise HTTPException(400, "pos places one card; several cards go into the flow")
    with canvas._lock:
        target = canvas.group_for(ws, None) if group is None else _group(ws, group)
        books: dict[str, dict[str, Any]] = {target["id"]: target}
        found: list[tuple[str, dict[str, Any]]] = []
        for cid in ids:
            try:
                nb, _ = canvas.find(ws, cid)
            except KeyError:
                raise HTTPException(404, f"no such card: {cid}") from None
            src = books.setdefault(nb["id"], nb)
            found.append((src["id"], next(c for c in src["cells"] if c["id"] == cid)))
        if after is not _LAST and after is not None:
            if after in ids:
                raise HTTPException(400, "a card cannot follow itself")
            if not any(c["id"] == after for c in target["cells"]):
                raise HTTPException(400, f"no card {after} in group {target['id']}")
        moved = []
        for src_id, cell in found:
            src = books[src_id]
            src["cells"] = [c for c in src["cells"] if c["id"] != cell["id"]]
            cell["notebook"] = target["id"]
            cell["pos"] = place
            moved.append(cell)
        at = len(target["cells"]) if after is _LAST else 0
        if after is not _LAST and after is not None:
            at = next(i for i, c in enumerate(target["cells"]) if c["id"] == after) + 1
        target["cells"][at:at] = moved
        for nb in books.values():
            canvas.save(ws, nb)
    for cell in moved:
        canvas.emit(ws, cell, "moved")
    return moved


def register(ctx: Any) -> None:
    app, ws_of = ctx.app, ctx.ws_of

    @app.get("/api/ws/{c}/notebooks")
    def groups(c: str) -> list[dict[str, Any]]:
        return [summary(nb) for nb in canvas.notebooks(ws_of(c))]

    @app.post("/api/ws/{c}/notebooks")
    def new_group(c: str, body: dict = Body(default={})) -> dict[str, Any]:
        return create_group(ws_of(c), body or {})

    @app.put("/api/ws/{c}/notebooks/{nb}")
    def edit_group(c: str, nb: str, body: dict = Body(...)) -> dict[str, Any]:
        return update_group(ws_of(c), nb, body)

    @app.delete("/api/ws/{c}/notebooks/{nb}")
    def drop_group(c: str, nb: str) -> dict[str, bool]:
        delete_group(ws_of(c), nb)
        return {"ok": True}

    @app.post("/api/ws/{c}/cells/move")
    def move(c: str, body: dict = Body(...)) -> list[dict[str, Any]]:
        ids = [str(x) for x in body.get("cells") or []]
        return move_cells(ws_of(c), ids, body.get("group"), body["after"] if "after" in body else _LAST, body.get("pos"))

    @app.post("/api/ws/{c}/notebooks/{nb}/cells")
    def new_cell(c: str, nb: str, body: dict = Body(...)) -> dict[str, Any]:
        ws = ws_of(c)
        group = _group(ws, nb)
        payload = body.get("payload") if isinstance(body.get("payload"), dict) else {}
        args = {**payload, "kind": body.get("kind") or "code", "question": body.get("title") or "New card",
                "code": body.get("code") or "", "group": group["id"]}
        try:
            cell = canvas.new_card(ws, args, by="user")
        except ValueError as e:
            raise HTTPException(400, str(e)) from None
        if body.get("after"):
            try:
                move_cells(ws, [cell["id"]], group["id"], str(body["after"]))
            except HTTPException:
                pass  # an `after` that is not in the group: the card stays last
            cell = canvas.find(ws, cell["id"])[1]
        return cell

    @app.post("/api/ws/{c}/notebooks/{nb}/run")
    async def run_new(c: str, nb: str, body: dict = Body(...)) -> dict[str, Any]:
        ws = ws_of(c)
        group = _group(ws, nb)
        kind = body.get("kind") if body.get("kind") in ("code", "plot", "table") else "code"
        try:
            cell = canvas.new_card(ws, {"kind": kind, "question": body.get("title") or "Code",
                                        "code": str(body.get("code") or ""), "group": group["id"]},
                                   by=str(body.get("created_by") or "user"))
        except ValueError as e:
            raise HTTPException(400, str(e)) from None
        return await canvas.run_card(ws, cell["id"], ctx.folder_of(c), unsandboxed=ctx.sessions.unsandboxed)
