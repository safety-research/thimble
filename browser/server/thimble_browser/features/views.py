"""Views: a page made for this folder of files that shows its records in the form they call for, such as a timeline,
a network or a forge's pull requests, in the Files tab.

A view starts as a proposal: Claude calls propose_view when the analyst asks for one, and the chat shows it as a card
with Accept and Reject. Only Accept starts the view's builder, the one agent besides the chat's, which writes the
view's three files, checks them and finishes on its own.

It owns the views' routes (views/ keeps them; media.py, view_head.py and view_builds.py serve their media, header and
build controls), the builder agent, the tools propose_view (the chat's) and write_view_file, view_check and
finish_view (the builder's), the `Views` part of the chat agent's prompt (prompts/views.md) and, on the page, the views
bar of the Files tab and the proposal card.
"""
from __future__ import annotations

import secrets
import shutil
from pathlib import Path
from typing import Any

from fastapi import Body, HTTPException, Request
from fastapi.responses import JSONResponse, Response

from .. import agent, chats, home, media, view_builds, view_head, views
from ..agent import READ, AgentDef
from ..hub import hub
from ..tools import Result
from . import Feature

BUILD_ATTEMPTS = 3


# ---- the builder

def _builder_finished(session: Any, result: str | None) -> None:
    """A view's builder ended: finish_view marked the view built, or the build failed."""
    ws = session.ws
    meta = chats.meta(ws, session.chat)
    slug = meta.get("view")
    row = next((r for r in views.proposals(ws) if r.get("slug") == slug), {})
    built = row.get("status") == "built"
    meta.update(status="done" if built else "failed", ts_end=home.now())
    chats.save_meta(ws, meta)
    if not built:
        views.set_proposal(ws, str(slug), status="failed")
    chats.append(ws, "main", {"type": "chip", "kind": "view", "text": f"{row.get('name') or slug}: "
                              + ("built" if built else "the build failed"), "ref": f"view:{slug}",
                              "view": slug, "status": "built" if built else "failed"})


agent.AGENTS["dev"] = AgentDef(lambda s: views.builder_prompt(s.folder, BUILD_ATTEMPTS),
                               READ + ("write_view_file", "view_check", "finish_view"),
                               extra_roots=(views.REPO / "docs", views.REPO / "samples" / "views"),
                               finished=_builder_finished)


async def start_build(sessions: Any, ws: str, slug: str) -> str:
    """Start the builder on the proposal `slug`, in a chat of its own; the chat's id. Only the analyst's Accept, Build
    or Retry calls it."""
    row = next((r for r in views.proposals(ws) if r.get("slug") == slug), None)
    if row is None:
        raise KeyError(slug)
    name = str(row.get("name") or slug)
    cid = "d" + secrets.token_hex(4)
    m = chats.new_meta(cid, kind="agent", title=f"View: {name}", parent="main")
    m.update(role="dev", view=slug, status="running", asked=True)
    chats.save_meta(ws, m)
    views.set_proposal(ws, slug, status="building", chat=cid, attempts=0, asked=True)
    await sessions.get(ws, cid).send(views.builder_brief(name, slug, str(row.get("description") or ""),
                                                         str(row.get("task") or ""), list(row.get("claims") or [])))
    return cid


# ---- the tools

async def propose_view(t: Any, args: dict[str, Any]) -> Result:
    name = str(args.get("name") or "View")
    slug = views.slug_for(t.ws, name)
    views.set_proposal(t.ws, slug, name=name, description=str(args.get("description") or ""),
                       task=str(args.get("task") or ""), claims=list(args.get("claims") or []), status="suggested",
                       offered={"at": home.now(), "by": t.maker()}, proposed_by="main", attempts=0)
    return Result(f"Proposed the view {name} (view:{slug}). The analyst sees it as a card with Accept, which builds it "
                  "on its own; it then appears in the Files tab.")


async def write_view_file(t: Any, args: dict[str, Any]) -> Result:
    try:
        p = views.write_file(t.ws, str(t.view), str(args.get("name") or ""), str(args.get("text") or ""))
    except (ValueError, KeyError) as e:
        return Result(str(e), True)
    return Result(f"wrote {p.name} ({p.stat().st_size} bytes)")


async def view_check(t: Any, args: dict[str, Any]) -> Result:
    got = await views.check(t.ws, str(t.view), t.folder)
    text = ("The checks pass.\n" if got["ok"] else "Fix these:\n") + "\n".join(f"- {x}" for x in got["lines"])
    shot = Path(got["shot"]) if got.get("shot") else None
    if shot is not None and shot.is_file():
        text += "\n\nThe picture below is the page as the analyst first sees it. Look at it as they would."
    return Result(text, images=[shot] if shot is not None and shot.is_file() else None)


async def finish_view(t: Any, args: dict[str, Any]) -> Result:
    row = next((r for r in views.proposals(t.ws) if r.get("slug") == t.view), {})
    attempts = int(row.get("attempts") or 0) + 1
    got = await views.check(t.ws, str(t.view), t.folder)
    if got["ok"]:
        views.mark_built(t.ws, str(t.view))
        return Result("The view passed its checks and is in the analyst's Files tab. End with your one-line message.")
    views.set_proposal(t.ws, str(t.view), attempts=attempts,
                       status="failed" if attempts >= BUILD_ATTEMPTS else "building")
    left = BUILD_ATTEMPTS - attempts
    lines = "\n".join(f"- {x}" for x in got["lines"])
    if left <= 0:
        return Result(f"The checks failed on the last attempt, so the build has failed:\n{lines}\nEnd with one line "
                      "saying what failed.", True)
    return Result(f"The checks failed ({left} attempts left). Fix these, then call finish_view again:\n{lines}", True)


# ---- the routes

def register(ctx: Any) -> None:
    app = ctx.app
    media.register(ctx)
    view_head.register(ctx)
    view_builds.register(ctx)

    def view_of(c: str, slug: str) -> Path:
        try:
            d = views.view_dir(ctx.ws_of(c), slug)
        except KeyError:
            raise HTTPException(404, f"no such view: {slug}") from None
        if not (d / "view.html").is_file():
            raise HTTPException(404, f"no such view: {slug}")
        return d

    def proposal(ws: str, slug: str) -> dict[str, Any]:
        row = next((r for r in views.proposals(ws) if r.get("slug") == slug), None)
        if row is None:
            raise HTTPException(404, f"no view proposal {slug!r}")
        return row

    @app.get("/api/ws/{c}/views")
    def views_list(c: str, path: str | None = None) -> list[dict[str, Any]]:
        return views.list_views(ctx.ws_of(c), ctx.folder_of(c), path)

    @app.get("/api/ws/{c}/views/proposals")
    def views_proposals(c: str) -> list[dict[str, Any]]:
        return [p for p in views.proposals(ctx.ws_of(c)) if p.get("status") != "built"]

    @app.post("/api/ws/{c}/views/proposals/{slug}/accept")
    async def accept(c: str, slug: str) -> dict[str, Any]:
        ws = ctx.ws_of(c)
        if proposal(ws, slug).get("status") != "suggested":
            raise HTTPException(409, "this proposal was answered already")
        cid = await start_build(ctx.sessions, ws, slug)
        return {**proposal(ws, slug), "agentId": cid}

    @app.post("/api/ws/{c}/views/proposals/{slug}/reject")
    def reject(c: str, slug: str) -> dict[str, Any]:
        ws = ctx.ws_of(c)
        proposal(ws, slug)
        return views.set_proposal(ws, slug, status="rejected")

    @app.get("/api/ws/{c}/views/{slug}/frame")
    def view_frame(c: str, slug: str, request: Request) -> Response:
        view_of(c, slug)
        # the Host header is one of `hosts` (Guard), so the frame's media URLs name this server as the browser reaches it
        doc = views.frame(c, slug, origin=f"http://{request.headers.get('host', '')}",
                          browser=request.scope.get("browser") or "")
        return Response(doc, media_type="text/html", headers={"cache-control": "no-cache"})

    @app.post("/api/ws/{c}/views/{slug}/records")
    async def view_records(c: str, slug: str, body: dict = Body(...)) -> Any:
        view_of(c, slug)
        got = await views.run_reader(c, slug, ctx.folder_of(c), "records", body.get("query"))
        if not got.get("ok"):
            return JSONResponse({"detail": {"message": got.get("error"), "traceback": got.get("traceback", "")}},
                                status_code=502)
        return {"data": got["result"]}

    @app.get("/api/ws/{c}/views/{slug}/resolve")
    async def view_resolve(c: str, slug: str, ref: str) -> Any:
        view_of(c, slug)
        path, _, frag = ref.partition("#")
        loc = {"key": ref.split("/", 1)[1]} if ref.startswith("view:") else {"path": path, "fragment": frag}
        got = await views.run_reader(c, slug, ctx.folder_of(c), "resolve", loc)
        if not got.get("ok") or not got.get("result"):
            raise HTTPException(404, f"the view does not know {ref}")
        return {"ref": ref, **got["result"]}

    @app.get("/api/ws/{c}/views/{slug}/calls/{call}")
    def view_call(c: str, slug: str, call: str) -> dict[str, bool]:
        return {"running": False}

    @app.post("/api/ws/{c}/views/{slug}/calls/{call}/cancel")
    def view_cancel(c: str, slug: str, call: str) -> dict[str, bool]:
        return {"cancelled": False}

    @app.delete("/api/ws/{c}/views/{slug}")
    def view_delete(c: str, slug: str) -> dict[str, Any]:
        d = view_of(c, slug)
        shutil.rmtree(d)
        hub.publish(c, {"type": "view", "slug": slug, "status": "deleted"})
        return {"deleted": slug}


FEATURE = Feature(
    name="views",
    title="Views",
    does="A page built for this folder, such as a timeline of each run, when you ask for one. Claude proposes it, "
         "and a builder makes it after you accept.",
    register=register,
    tools={"propose_view": propose_view, "write_view_file": write_view_file, "view_check": view_check,
           "finish_view": finish_view},
    main_tools=("propose_view",),
    prompt="views.md",
    page=("views",),
)
