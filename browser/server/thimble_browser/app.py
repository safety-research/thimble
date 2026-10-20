"""The server: the page's files and the API it reads, on 127.0.0.1 only.

The routes are the ones thimble 0.8's page calls, so its components work unchanged (frontend/). A feature of 0.8 that
thimble browser does not have yet answers with an empty list, which the page shows as nothing to show.
"""
from __future__ import annotations

import asyncio
import json
import secrets
from pathlib import Path
from dataclasses import dataclass
from typing import Any, Callable

from fastapi import Body, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse

from . import canvas, chats, corpus, features, home, report, settings, tools, views
from .agent import Sessions
from .auth import Auth, Guard
from .hub import hub

DIST = Path(__file__).resolve().parents[2] / "frontend" / "dist"
SECURITY_HEADERS = {"x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
                    "content-security-policy": "frame-ancestors 'self'"}


@dataclass
class Ctx:
    """What a feature module's register() gets: the app to add routes to, the agents, and the helpers every route
    uses (folder_of: the folder of a workspace, 404 for none; ws_of: the workspace's name, checked; bad: an error as
    the HTTP answer it should be)."""
    app: Any
    auth: Auth
    sessions: Sessions
    folder_of: Callable[[str], Path]
    ws_of: Callable[[str], str]
    bad: Callable[[Exception], HTTPException]


def build(port: int, *, unsandboxed: bool = False) -> tuple[Any, Auth, Sessions]:
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    auth = Auth(port)
    sessions = Sessions(unsandboxed=unsandboxed)
    started = home.now()

    def folder_of(c: str) -> Path:
        try:
            return home.corpus_of(c)
        except KeyError:
            raise HTTPException(404, f"no workspace {c!r}") from None

    def ws_of(c: str) -> str:
        folder_of(c)
        return c

    def bad(e: Exception) -> HTTPException:
        if isinstance(e, corpus.OutsideFolder):
            return HTTPException(400, str(e))
        if isinstance(e, (FileNotFoundError, KeyError, IndexError)):
            return HTTPException(404, str(e))
        return HTTPException(400, str(e))

    @app.middleware("http")
    async def headers(request: Request, call_next: Any) -> Response:
        res = await call_next(request)
        for k, v in SECURITY_HEADERS.items():
            res.headers.setdefault(k, v)
        if request.url.path.startswith("/api"):
            res.headers.setdefault("cache-control", "no-store")
        return res

    # ---- sign-in (auth.py)

    @app.get("/api/health")
    def health() -> dict[str, Any]:
        return {"ok": True, "product": "thimble-browser"}

    @app.post("/api/ui/key")
    def ui_key(request: Request, body: dict = Body(...)) -> Response:
        if request.scope.get("browser"):
            return Response(status_code=204)
        got = auth.claim(str(body.get("code") or ""))
        if not got:
            return JSONResponse({"detail": "this link was used already, or is too old: open the newest link "
                                           "thimble browser printed"}, status_code=410)
        cookie, key = got
        res = JSONResponse({"key": key})
        res.headers["set-cookie"] = auth.set_cookie_header(cookie, key)
        return res

    @app.get("/api/ui/paired")
    def ui_paired(request: Request) -> dict[str, Any]:
        b = request.scope.get("browser") or ""
        return {"paired": bool(b), "id": b}

    @app.post("/api/ui/signout")
    def ui_signout(request: Request) -> dict[str, bool]:
        auth.sign_out(request.cookies.get(auth.cookie_name))
        return {"ok": True}

    @app.get("/api/tour")
    def tour() -> dict[str, bool]:
        return {"seen": True}

    # ---- workspaces and files (corpus.py)

    @app.get("/api/workspaces")
    def workspaces() -> list[dict[str, Any]]:
        return [{"name": w["name"], "kind": "folder", "label": Path(w["corpus"]).name, "folder": Path(w["corpus"]).name,
                 "path": w["corpus"], "view": None} for w in home.list_workspaces()]

    @app.get("/api/corpora")
    def corpora() -> list[dict[str, Any]]:
        return [{"name": w["name"], "manifest": {"name": w["name"]}, "path": w["corpus"]} for w in home.list_workspaces()]

    @app.get("/api/corpora/{c}/sources")
    def sources(c: str, path: str | None = None, depth: int | None = None) -> Any:
        f = folder_of(c)
        if path is None and depth is None:
            return corpus.walk(f)
        try:
            got = corpus.folder(f, "" if path in (None, ".") else path)
        except Exception as e:  # noqa: BLE001
            raise bad(e) from None
        if got is None:
            raise HTTPException(404, f"no such folder: {path!r}")
        return got

    @app.get("/api/corpora/{c}/source")
    def source(c: str, path: str, start: int = 1, count: int = 100) -> dict[str, Any]:
        try:
            return corpus.page(folder_of(c), path, start, count)
        except Exception as e:  # noqa: BLE001
            raise bad(e) from None

    @app.get("/api/corpora/{c}/source/around")
    def source_around(c: str, path: str, line: int, before: int = 50, after: int = 50, clamp: int = 0) -> dict:
        try:
            return corpus.around(folder_of(c), path, line, before, after, bool(clamp))
        except Exception as e:  # noqa: BLE001
            raise bad(e) from None

    @app.get("/api/corpora/{c}/source/lines")
    def source_lines(c: str, path: str) -> dict[str, Any]:
        try:
            n = corpus.line_count(corpus.inside(folder_of(c), path))
        except Exception as e:  # noqa: BLE001
            raise bad(e) from None
        return {"path": path, "total_lines": n, "estimated": False, "indexed": n}

    @app.get("/api/corpora/{c}/source/find")
    def source_find(c: str, path: str, q: str, after: int = 0) -> dict[str, Any]:
        try:
            return corpus.find_in_file(folder_of(c), path, q, after)
        except Exception as e:  # noqa: BLE001
            raise bad(e) from None

    @app.get("/api/corpora/{c}/sources/find")
    def sources_find(c: str, q: str = "") -> dict[str, Any]:
        return corpus.find_files(folder_of(c), q)

    @app.get("/api/corpora/{c}/sources/grep")
    def sources_grep(c: str, q: str = "") -> StreamingResponse:
        f = folder_of(c)

        def lines() -> Any:
            for rec in corpus.grep(f, q):
                yield json.dumps(rec) + "\n"

        return StreamingResponse(lines(), media_type="application/x-ndjson",
                                 headers={"x-search": str(secrets.randbelow(10**6) + 1)})

    @app.post("/api/corpora/{c}/sources/grep/stop")
    def grep_stop(c: str) -> dict[str, bool]:
        return {"stopped": True}

    @app.get("/api/corpora/{c}/download/{path:path}")
    def download(c: str, path: str) -> FileResponse:
        try:
            p = corpus.inside(folder_of(c), path)
        except Exception as e:  # noqa: BLE001
            raise bad(e) from None
        if not p.is_file():
            raise HTTPException(404, path)
        return FileResponse(p, filename=p.name, headers={"cache-control": "no-cache"})

    @app.get("/api/corpora/{c}/csv-rows")
    def csv_rows(c: str, path: str, lines: str) -> dict[str, Any]:
        a, _, b = lines.partition("-")
        try:
            return {"rows": corpus.csv_rows(folder_of(c), path, int(a), int(b or a))}
        except Exception as e:  # noqa: BLE001
            raise bad(e) from None

    @app.get("/api/corpora/{c}/ref")
    def resolve_ref(c: str, ref: str, value: str | None = None) -> dict[str, Any]:
        f = folder_of(c)
        try:
            if (fn := tools.resolver(ref)) is not None:
                return fn(c, ref)
            if ref.startswith(("card:", "cell:")):
                got = canvas.resolve_card_ref(c, ref, value)
                _, cell = canvas.find(c, ref)
                got["record"] = cell
                return got
            got = corpus.resolve(f, ref)
            if got["kind"] in ("record", "range"):
                end = got.get("meta", {}).get("end", got["line"])
                page = corpus.page(f, got["path"], got["line"], end - got["line"] + 1)
                got.update(end_line=end, records=page["records"])
            return got
        except Exception as e:  # noqa: BLE001
            raise bad(e) from None

    # ---- the event stream (hub.py)

    @app.get("/api/ws/{c}/events")
    async def events(c: str, request: Request) -> StreamingResponse:
        ws_of(c)

        async def gen() -> Any:
            async for chunk in hub.stream(c):
                if await request.is_disconnected():
                    break
                yield chunk

        return StreamingResponse(gen(), media_type="text/event-stream",
                                 headers={"cache-control": "no-store", "x-accel-buffering": "no"})

    @app.get("/api/ws/{c}/instance")
    def instance(c: str) -> dict[str, Any]:
        meta = home.read_json(home.workspace_dir(ws_of(c)) / "workspace.json", {})
        return {"stamp": meta.get("created")}

    @app.put("/api/ws/{c}/render/theme")
    def theme(c: str) -> Response:
        return Response(status_code=204)

    # ---- chats (chats.py, agent.py)

    def attached(c: str) -> dict[str, Any]:
        choice = home.read_json(home.workspace_dir(c) / "session.json", {}) or {}
        return {"session": "thimble-browser", "cwd": str(folder_of(c)), "since": started,
                "model": settings.read()["model"], "settings_effort": settings.read()["effort"],
                **({"effort_choice": choice["effort"]} if choice.get("effort") else {})}

    @app.put("/api/ws/{c}/session/effort")
    async def session_effort(c: str, body: dict = Body(...)) -> dict[str, Any]:
        effort = str(body.get("effort") or "")
        if effort not in ("low", "medium", "high", "xhigh", "max", "ultracode"):
            raise HTTPException(400, f"no effort {effort!r}")
        p = home.workspace_dir(ws_of(c)) / "session.json"
        home.write_json(p, {**(home.read_json(p, {}) or {}), "effort": effort})
        await sessions.restart_idle(c)
        hub.publish(c, {"type": "chat", "chat": "main"})
        return {"effort": effort, "choice": effort}

    @app.put("/api/ws/{c}/session/fast")
    def session_fast(c: str) -> dict[str, Any]:
        raise HTTPException(409, "thimble browser has no fast mode yet")

    def with_state(c: str, m: dict[str, Any]) -> dict[str, Any]:
        m = {**m, "running": m["id"] in sessions.running(c)}
        if m["kind"] == "main":
            m["attached"] = attached(c)
        else:
            m["fork"] = {"agent_id": m["id"], "ended": None}
        return m

    @app.get("/api/ws/{c}/chats")
    def chat_list(c: str) -> list[dict[str, Any]]:
        ws_of(c)
        return [with_state(c, m) for m in chats.listing(c, sessions.running(c))]

    @app.get("/api/ws/{c}/chats/{chat}")
    def chat_detail(c: str, chat: str) -> dict[str, Any]:
        ws_of(c)
        try:
            m = chats.meta(c, chat)
        except KeyError:
            raise HTTPException(404, f"no chat {chat!r}") from None
        return {"meta": with_state(c, m), "events": chats.records(c, chat)}

    @app.post("/api/ws/{c}/chats", status_code=201)
    async def chat_new(c: str, body: dict = Body(...)) -> dict[str, Any]:
        ws_of(c)
        cid = "t" + secrets.token_hex(4)
        anchor = body.get("anchor")
        title = body.get("title") or (str(body.get("anchor_text") or anchor or "Thread")[:60])
        m = chats.new_meta(cid, kind="thread", title=title, parent=body.get("parent") or "main", anchor=anchor,
                           anchor_text=body.get("anchor_text"))
        chats.save_meta(c, m)
        sessions.fork(c, cid)
        hub.publish(c, {"type": "chat", "chat": cid})
        text = str(body.get("text") or "").strip()
        if text:
            await sessions.get(c, cid).send(thread_opening(m, text), shown=text)
        return with_state(c, m)

    def thread_opening(m: dict[str, Any], text: str) -> str:
        """A thread's first message, as Claude reads it: what the analyst pointed at, then their question."""
        what = str(m.get("anchor") or "")
        words = " ".join(str(m.get("anchor_text") or "").split())[:600]
        about = f"{what}, which reads: {words}" if words else what
        return f"(The analyst opened this thread about {about}.)\n\n{text}" if about else text

    @app.put("/api/ws/{c}/chats/{chat}")
    def chat_rename(c: str, chat: str, body: dict = Body(...)) -> dict[str, Any]:
        m = chats.meta(c, chat)
        if "name" in body:
            m["name"] = body["name"] or None
        chats.save_meta(c, m)
        hub.publish(c, {"type": "chat", "chat": chat})
        return with_state(c, m)

    @app.delete("/api/ws/{c}/chats/{chat}")
    async def chat_delete(c: str, chat: str) -> dict[str, str]:
        if chat == "main":
            raise HTTPException(400, "main cannot be deleted")
        await sessions.get(c, chat).close()
        chats.delete(c, chat)
        return {"deleted": chat}

    @app.post("/api/ws/{c}/chats/{chat}/interrupt")
    async def chat_interrupt(c: str, chat: str) -> dict[str, Any]:
        stopped = await sessions.get(c, chat).interrupt()
        return {"stopped": stopped, **({} if stopped else {"done": True})}

    @app.post("/api/ws/{c}/events")
    async def post_event(c: str, body: dict = Body(...)) -> dict[str, Any]:
        ws_of(c)
        kind, payload = body.get("kind"), body.get("payload") or {}
        text = str(payload.get("text") or "").strip()
        if kind == "main":
            chat = "main"
        elif kind == "thread":
            chat = str(payload.get("thread") or "")
            try:
                chats.meta(c, chat)
            except KeyError:
                raise HTTPException(404, f"no thread {chat!r}") from None
        else:
            raise HTTPException(409, f"thimble browser does not take {kind!r} requests yet")
        if not text:
            raise HTTPException(400, "an empty message")
        meta = chats.meta(c, chat)
        first = chat != "main" and not any(r.get("type") == "user" for r in chats.records(c, chat))
        try:
            await sessions.get(c, chat).send(thread_opening(meta, text) if first else text, shown=text)
        except RuntimeError as e:
            raise HTTPException(409, str(e)) from None
        return {"id": secrets.token_hex(4), "kind": kind, "delivered": 1, "thread": chat}

    # ---- the canvas (canvas.py)

    @app.get("/api/ws/{c}/canvas")
    def get_canvas(c: str) -> dict[str, Any]:
        return canvas.canvas(ws_of(c))

    @app.get("/api/ws/{c}/cells/names")
    def cell_names(c: str) -> list[dict[str, Any]]:
        return [{"id": x["id"], "notebook": x["notebook"], "title": x["title"], "slug": x.get("slug"),
                 "exec_count": x.get("exec_count"), "ts": x.get("ts"), "status": x.get("status")}
                for x in canvas.canvas(ws_of(c))["cells"]]

    @app.get("/api/ws/{c}/cells/{cid}")
    def cell_get(c: str, cid: str) -> dict[str, Any]:
        try:
            return canvas.find(ws_of(c), cid)[1]
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
            return canvas.update_card(ws_of(c), cid, args, by="analyst")
        except Exception as e:  # noqa: BLE001
            raise bad(e) from None

    @app.delete("/api/ws/{c}/cells/{cid}")
    def cell_delete(c: str, cid: str) -> dict[str, bool]:
        try:
            canvas.delete_card(ws_of(c), cid, by="analyst")
        except Exception as e:  # noqa: BLE001
            raise bad(e) from None
        return {"ok": True}

    @app.post("/api/ws/{c}/cells/{cid}/run")
    async def cell_run(c: str, cid: str) -> dict[str, Any]:
        try:
            return await canvas.run_card(ws_of(c), cid, folder_of(c), unsandboxed=sessions.unsandboxed)
        except KeyError:
            raise HTTPException(404, cid) from None

    @app.get("/api/ws/{c}/notebooks/{nb}/cells/{cid}/outputs/{i}/full")
    def output_full(c: str, nb: str, cid: str, i: int) -> Response:
        _, cell = canvas.find(ws_of(c), cid)
        outs = cell.get("outputs") or []
        if not 0 <= i < len(outs):
            raise HTTPException(404, "no such output")
        return Response(str(outs[i].get("text/plain", "")), media_type="text/plain")

    # ---- the report (report.py) and its writer (agent.Writer)

    def doc_slug(slug: str) -> str:
        if slug != report.DOC:
            raise HTTPException(404, f"thimble browser has one document, the report, not {slug!r}")
        return slug

    @app.get("/api/ws/{c}/investigations/main/types")
    def doc_types(c: str) -> dict[str, Any]:
        return report.types(ws_of(c))

    @app.get("/api/ws/{c}/investigations/main/types/{slug}")
    def doc_get(c: str, slug: str) -> dict[str, Any]:
        doc_slug(slug)
        got = report.writeup(ws_of(c))
        if got is None:
            raise HTTPException(404, "the report is not written yet")
        return got

    @app.get("/api/ws/{c}/investigations/main/types/{slug}/frame")
    def doc_frame(c: str, slug: str) -> dict[str, Any]:
        raise HTTPException(404, "thimble browser has no frames yet")

    @app.put("/api/ws/{c}/investigations/main/types/{slug}/blocks")
    def doc_blocks(c: str, slug: str, body: dict = Body(...)) -> dict[str, Any]:
        doc_slug(slug)
        return report.from_blocks(ws_of(c), str(body.get("title") or ""), list(body.get("blocks") or []))

    @app.post("/api/ws/{c}/write")
    async def write(c: str, body: dict = Body(...)) -> dict[str, Any]:
        ws_of(c)
        doc_slug(str(body.get("doc") or report.DOC))
        running = [m for m in chats.listing(c, sessions.running(c)) if m.get("role") == "writer" and m["running"]]
        if running:
            return {"chat": running[0]["id"], "kind": "busy", "reason": "the writer is writing the report already"}
        from .agent import writer_brief  # noqa: PLC0415

        cid = "w" + secrets.token_hex(4)
        m = chats.new_meta(cid, kind="agent", title="Report writer", parent="main")
        m.update(role="writer", doc=report.DOC, status="running", brief=str(body.get("text") or "") or None)
        chats.save_meta(c, m)
        report.set_status(c, "generating")
        await sessions.get(c, cid).send(writer_brief(c, str(body.get("text") or "")))
        return {"agentId": cid, "chat": cid}

    # ---- generative views (views/)

    def view_of(c: str, slug: str) -> Path:
        try:
            d = views.view_dir(ws_of(c), slug)
        except KeyError:
            raise HTTPException(404, f"no such view: {slug}") from None
        if not (d / "view.html").is_file():
            raise HTTPException(404, f"no such view: {slug}")
        return d

    @app.get("/api/ws/{c}/views")
    def views_list(c: str, path: str | None = None) -> list[dict[str, Any]]:
        return views.list_views(ws_of(c), folder_of(c), path)

    @app.get("/api/ws/{c}/views/proposals")
    def views_proposals(c: str) -> list[dict[str, Any]]:
        return [p for p in views.proposals(ws_of(c)) if p.get("status") != "built"]

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
        got = await views.run_reader(c, slug, folder_of(c), "records", body.get("query"))
        if not got.get("ok"):
            return JSONResponse({"detail": {"message": got.get("error"), "traceback": got.get("traceback", "")}},
                                status_code=502)
        return {"data": got["result"]}

    @app.get("/api/ws/{c}/views/{slug}/resolve")
    async def view_resolve(c: str, slug: str, ref: str) -> Any:
        view_of(c, slug)
        path, _, frag = ref.partition("#")
        loc = {"key": ref.split("/", 1)[1]} if ref.startswith("view:") else {"path": path, "fragment": frag}
        got = await views.run_reader(c, slug, folder_of(c), "resolve", loc)
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
        import shutil  # noqa: PLC0415

        d = view_of(c, slug)
        shutil.rmtree(d)
        hub.publish(c, {"type": "view", "slug": slug, "status": "deleted"})
        return {"deleted": slug}

    # ---- the features (features.py): each module adds its own routes, tools and agents

    ctx = Ctx(app=app, auth=auth, sessions=sessions, folder_of=folder_of, ws_of=ws_of, bad=bad)
    for mod in features.load():
        mod.register(ctx)

    # ---- what thimble browser does not have yet: empty answers the page shows as nothing. A stub never shadows a
    # route a feature registered (FastAPI takes the first route that matches, so stubs go last and skip taken paths).

    taken = {(r.path, m) for r in app.routes for m in getattr(r, "methods", None) or ()}

    def stub(route: str, value: Any) -> None:
        path = f"/api/ws/{{c}}/{route}"
        if (path, "GET") not in taken:
            app.add_api_route(path, (lambda v: (lambda c: v))(value), methods=["GET"])

    for route in ("notices", "concepts", "labels/presence", "checks", "card-checks", "card-libs"):
        stub(route, [])
    for route, value in {"orientation": {}, "undo": {"undo": None, "redo": None}, "filters": {},
                         "report-types/presets": [], "canvas/comments": {"comments": []},
                         "settings": {"models": {}}}.items():
        stub(route, value)

    @app.put("/api/ws/{c}/canvas/active-group")
    def active_group(c: str) -> Response:
        return Response(status_code=204)

    @app.post("/api/ws/{c}/telemetry")
    def telemetry(c: str) -> Response:
        return Response(status_code=204)

    # ---- the page

    @app.get("/{rest:path}")
    def page(rest: str) -> Response:
        if rest.startswith("api/") or rest == "api":
            raise HTTPException(404, "no such route")
        p = (DIST / rest).resolve()
        if rest and DIST.resolve() in p.parents and p.is_file():
            return FileResponse(p)
        index = DIST / "index.html"
        if not index.is_file():
            return Response("thimble browser's page is not built: run `npm run build` in frontend/", status_code=500,
                            media_type="text/plain")
        return FileResponse(index, headers={"cache-control": "no-cache"})

    hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}
    return Guard(app, auth, hosts), auth, sessions
