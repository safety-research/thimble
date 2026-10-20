"""The server: the page's files and the API it reads, on 127.0.0.1 only.

The routes are the ones thimble 0.8's page calls, so its components work unchanged (frontend/). A feature of 0.8 that
thimble browser does not have yet answers with an empty list, which the page shows as nothing to show.
"""
from __future__ import annotations

import asyncio
import json
import secrets
from pathlib import Path
from typing import Any

from fastapi import Body, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse

from . import canvas, chats, corpus, home
from .agent import Sessions
from .auth import Auth, Guard
from .hub import hub

DIST = Path(__file__).resolve().parents[2] / "frontend" / "dist"
SECURITY_HEADERS = {"x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
                    "content-security-policy": "frame-ancestors 'self'"}


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
    def resolve_ref(c: str, ref: str) -> dict[str, Any]:
        f = folder_of(c)
        try:
            if ref.startswith(("card:", "cell:")):
                got = canvas.resolve_card_ref(c, ref)
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
        return {"session": "thimble-browser", "cwd": str(folder_of(c)), "since": started}

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
        m["fork_of"] = chats.meta(c, "main").get("session_id")
        chats.save_meta(c, m)
        hub.publish(c, {"type": "chat", "chat": cid})
        text = str(body.get("text") or "").strip()
        if text:
            await sessions.get(c, cid).send(text)
        return with_state(c, m)

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
        try:
            await sessions.get(c, chat).send(text)
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

    # ---- what thimble browser does not have yet: empty answers the page shows as nothing

    empty_list = ["views", "views/proposals", "notices", "concepts", "labels/presence", "checks", "card-checks",
                  "card-libs"]
    for route in empty_list:
        app.add_api_route(f"/api/ws/{{c}}/{route}", lambda c: [], methods=["GET"])
    for route, value in {"orientation": {}, "undo": {"undo": None, "redo": None}, "filters": {},
                         "canvas/comments": {"comments": []}, "investigations/main/types": {},
                         "settings": {"models": {}}}.items():
        app.add_api_route(f"/api/ws/{{c}}/{route}", (lambda v: (lambda c: v))(value), methods=["GET"])

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
