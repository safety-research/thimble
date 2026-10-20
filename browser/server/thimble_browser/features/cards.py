"""Cards: what Claude draws to show the evidence of an answer, a table, a chart, a diagram, a timeline, records or a
note, each with its question and its takeaway. The chat shows the cards of a turn under its answer, and the Canvas tab
lays them all out in groups.

It owns the canvas's routes (canvas.py keeps the cards, canvas_layout.py their groups and places, history.py their
versions and Undo), the card tools, the `Cards` part of the chat agent's prompt (prompts/cards.md) and, on the page,
the Canvas tab and the cards under an answer.
"""
from __future__ import annotations

import json
from typing import Any

from fastapi import Body, HTTPException
from fastapi.responses import Response

from .. import canvas, canvas_layout, history
from ..tools import Result
from . import Feature


def describe(cell: dict[str, Any]) -> str:
    """A card as Claude reads it: its ref, kind, question, takeaway, and what it shows."""
    head = f"card:{cell['id']} ({cell['kind']}) {cell['title']}"
    if cell.get("takeaway"):
        head += f"\ntakeaway: {cell['takeaway']}"
    if cell["kind"] in canvas.CODE_KINDS:
        head += f"\nstatus: {cell.get('status')}\n\n{canvas.outputs_text(cell)}"
    elif cell["kind"] == "note":
        head += f"\n{cell.get('text', '')}"
    elif cell["kind"] == "example":
        head += "\nrefs: " + json.dumps(cell.get("payload", {}).get("refs", []), ensure_ascii=False)
    return head


# ---- the tools

async def _run_and_describe(t: Any, cell: dict[str, Any]) -> Result:
    if cell["kind"] in canvas.CODE_KINDS:
        cell = await canvas.run_card(t.ws, cell["id"], t.folder, unsandboxed=t.unsandboxed)
    t.on_card(cell["id"])
    text = describe(cell)
    if cell.get("status") == "error":
        text += "\n\nThe code failed. Fix it with edit_card on this card rather than adding a new one."
    elif not cell.get("takeaway"):
        text += "\n\nRead the output, then give the card its takeaway with edit_card."
    return Result(text, cell_id=cell["id"])


async def list_cards(t: Any, args: dict[str, Any]) -> Result:
    group = str(args.get("group") or "all")
    lines = []
    for nb in canvas.notebooks(t.ws):
        if group not in ("all", nb["id"], nb.get("title")):
            continue
        lines.append(f"## {nb.get('title')} ({nb['id']})")
        for c in nb["cells"]:
            lines.append(f"card:{c['id']}  {c['kind']}  {c['title']}  |  {(c.get('takeaway') or '')[:120]}")
    return Result("\n".join(lines) or "no cards yet")


async def add_card(t: Any, args: dict[str, Any]) -> Result:
    try:
        cell = canvas.new_card(t.ws, args, by=t.maker(), chat=t.chat)
    except ValueError as e:
        return Result(str(e), True)
    return await _run_and_describe(t, cell)


async def edit_card(t: Any, args: dict[str, Any]) -> Result:
    try:
        before = canvas.find(t.ws, str(args.get("card") or ""))[1]
        cell = canvas.update_card(t.ws, str(args["card"]), args, by=t.maker())
    except KeyError:
        return Result(f"no card {args.get('card')}: list_cards names them", True)
    except ValueError as e:
        return Result(str(e), True)
    changed = (args.get("code") is not None and args["code"] != before.get("code")) or \
        (args.get("program") is not None and args["program"] != before.get("program"))
    if cell["kind"] in canvas.CODE_KINDS and changed:
        return await _run_and_describe(t, cell)
    t.on_card(cell["id"])
    return Result(describe(cell), cell_id=cell["id"])


async def delete_card(t: Any, args: dict[str, Any]) -> Result:
    try:
        canvas.delete_card(t.ws, str(args.get("card") or ""))
    except KeyError:
        return Result(f"no card {args.get('card')}", True)
    return Result(f"deleted {args.get('card')}")


# ---- the routes

def register(ctx: Any) -> None:
    app = ctx.app
    canvas_layout.register(ctx)
    history.register(ctx)

    @app.get("/api/ws/{c}/canvas")
    def get_canvas(c: str) -> dict[str, Any]:
        return canvas.canvas(ctx.ws_of(c))

    @app.get("/api/ws/{c}/cells/names")
    def cell_names(c: str) -> list[dict[str, Any]]:
        return [{"id": x["id"], "notebook": x["notebook"], "title": x["title"], "slug": x.get("slug"),
                 "exec_count": x.get("exec_count"), "ts": x.get("ts"), "status": x.get("status")}
                for x in canvas.canvas(ctx.ws_of(c))["cells"]]

    @app.get("/api/ws/{c}/cells/{cid}")
    def cell_get(c: str, cid: str) -> dict[str, Any]:
        try:
            return canvas.find(ctx.ws_of(c), cid)[1]
        except KeyError:
            raise HTTPException(404, cid) from None

    @app.put("/api/ws/{c}/cells/{cid}")
    def cell_put(c: str, cid: str, body: dict = Body(...)) -> dict[str, Any]:
        args = dict(body)
        if "title" in args:
            args["question"] = args.pop("title")
        if isinstance(args.get("payload"), dict):
            args.update(args.pop("payload"))
        try:
            return canvas.update_card(ctx.ws_of(c), cid, args, by="analyst")
        except Exception as e:  # noqa: BLE001
            raise ctx.bad(e) from None

    @app.delete("/api/ws/{c}/cells/{cid}")
    def cell_delete(c: str, cid: str) -> dict[str, bool]:
        try:
            canvas.delete_card(ctx.ws_of(c), cid, by="analyst")
        except Exception as e:  # noqa: BLE001
            raise ctx.bad(e) from None
        return {"ok": True}

    @app.post("/api/ws/{c}/cells/{cid}/run")
    async def cell_run(c: str, cid: str) -> dict[str, Any]:
        try:
            return await canvas.run_card(ctx.ws_of(c), cid, ctx.folder_of(c), unsandboxed=ctx.sessions.unsandboxed)
        except KeyError:
            raise HTTPException(404, cid) from None

    @app.get("/api/ws/{c}/notebooks/{nb}/cells/{cid}/outputs/{i}/full")
    def output_full(c: str, nb: str, cid: str, i: int) -> Response:
        _, cell = canvas.find(ctx.ws_of(c), cid)
        outs = cell.get("outputs") or []
        if not 0 <= i < len(outs):
            raise HTTPException(404, "no such output")
        return Response(str(outs[i].get("text/plain", "")), media_type="text/plain")

    @app.put("/api/ws/{c}/canvas/active-group")
    def active_group(c: str) -> Response:
        return Response(status_code=204)


FEATURE = Feature(
    name="cards",
    title="Cards",
    does="Claude draws a card under its answer when a picture shows the evidence better than words. The Canvas tab "
         "holds them all.",
    register=register,
    tools={"list_cards": list_cards, "add_card": add_card, "edit_card": edit_card, "delete_card": delete_card},
    main_tools=("list_cards", "add_card", "edit_card", "delete_card"),
    prompt="cards.md",
    page=("canvas", "answer-cards"),
)
