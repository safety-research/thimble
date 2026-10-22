"""The server: the page's files and the API it reads, on 127.0.0.1 only.

The core is here: the sign-in, the workspaces and the folder of files, the chats and their agents, the event stream and
the page, the Canvas tab's routes (canvas.py) and what a ref names (GET /api/corpora/{c}/ref, for the page's links
to cards, labels and records). Each feature (features/: marks, cards, labels, report, views) adds its own routes, tools
and prompt part in one place, features.register_all. The routes are the ones thimble 0.8's page calls, so its components
work unchanged (frontend/). A route the page calls that no part answers yet answers with an empty list, which the page
shows as nothing to show.
"""
from __future__ import annotations

import asyncio
import json
from contextlib import asynccontextmanager
import os
import secrets
from pathlib import Path
from dataclasses import dataclass
from typing import Any, Callable

from fastapi import Body, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse

from . import canvas, cardrunner, chats, corpus, features, files, fixcopy, home, issues, settings, settings_api, tools
from .agent import Sessions
from .cards import sandbox
from .auth import Auth, Guard
from .hub import hub

# the built page; a server that runs from a fix's copy serves the one restart.py names
DIST = Path(os.environ.get("THIMBLE_BROWSER_DIST") or Path(__file__).resolve().parents[2] / "frontend" / "dist")
# a new one each start, so the page knows when a restart (restart.py) is done
BOOT = secrets.token_hex(8)
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


def resolve(ws: str, folder: Path, ref: str, value: str | None = None) -> dict[str, Any]:
    """What `ref` points at, as the page opens it: {ref, kind, excerpt, ...}; KeyError, FileNotFoundError or
    corpus.OutsideFolder for a ref that names nothing. `value` is the link's own words, which a value of a card is read
    against (canvas.resolve_card_ref)."""
    if (fn := tools.resolver(ref)) is not None:
        return fn(ws, ref)
    if ref.startswith(("card:", "cell:")):
        got = canvas.resolve_card_ref(ws, ref, value)
        got["record"] = canvas.find(ws, ref)[1]
        return got
    got = corpus.resolve(folder, ref, read=lambda: chats.read_paths(ws, folder))
    if got["kind"] in ("record", "range"):
        end = got.get("meta", {}).get("end", got["line"])
        page = corpus.page(folder, got["path"], got["line"], end - got["line"] + 1)
        got.update(end_line=end, records=page["records"])
    return got


def build(port: int, *, unsandboxed: bool = False) -> tuple[Any, Auth, Sessions]:
    @asynccontextmanager
    async def lifespan(_app: Any) -> Any:
        asyncio.get_running_loop().run_in_executor(None, sandbox.write_bytecode)
        yield
        await cardrunner.close_all()  # the card runners stop with the server

    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)
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
        if isinstance(e, FileNotFoundError) and e.filename:
            # the system's error names the file by its path on this disk, which the page never shows
            return HTTPException(404, f"no such file: {os.path.basename(str(e.filename))}")
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
        return {"ok": True, "product": "thimble-browser", "boot": BOOT}

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
                **({"effort_choice": choice["effort"]} if choice.get("effort") else {}),
                "fast_choice": choice.get("fast") is True}

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
    def session_fast(c: str, body: dict = Body(...)) -> dict[str, Any]:
        """The composer's bolt: fast mode for main and its threads, from their next request (agent.Session.fast)."""
        fast = body.get("fast")
        if not isinstance(fast, bool):
            raise HTTPException(400, "fast: true or false")
        p = home.workspace_dir(ws_of(c)) / "session.json"
        home.write_json(p, {**(home.read_json(p, {}) or {}), "fast": fast})
        hub.publish(c, {"type": "chat", "chat": "main"})
        return {"fast": fast, "choice": fast}

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
            # `/fix …` (typed, or the top bar's Fix…): the chat shows what was typed, Claude reads the request
            said = fixcopy.expand(text) or text
            await sessions.get(c, chat).send(thread_opening(meta, said) if first else said, shown=text)
        except RuntimeError as e:
            raise HTTPException(409, str(e)) from None
        return {"id": secrets.token_hex(4), "kind": kind, "delivered": 1, "thread": chat}

    # ---- the core's own modules, then the features (features/): each adds its own routes, tools and agents

    @app.get("/api/corpora/{c}/ref")
    def resolve_ref(c: str, ref: str, value: str | None = None) -> dict[str, Any]:
        """What `ref` names, as the page opens it: a card of the canvas, a label's value or a record of a file."""
        try:
            return resolve(c, folder_of(c), ref, value)
        except Exception as e:  # noqa: BLE001
            raise bad(e) from None

    ctx = Ctx(app=app, auth=auth, sessions=sessions, folder_of=folder_of, ws_of=ws_of, bad=bad)
    settings_api.register(ctx)
    files.register(ctx)
    issues.register(ctx)
    canvas.register(ctx)
    features.register_all(ctx)

    @app.get("/api/ws/{c}/features")
    def feature_list(c: str) -> list[dict[str, Any]]:
        ws_of(c)
        return features.listing()

    # ---- what thimble browser does not have yet: empty answers the page shows as nothing. A stub never shadows a
    # route a feature registered (FastAPI takes the first route that matches, so stubs go last and skip taken paths).

    taken = {(r.path, m) for r in app.routes for m in getattr(r, "methods", None) or ()}

    def stub(route: str, value: Any) -> None:
        path = f"/api/ws/{{c}}/{route}"
        if (path, "GET") not in taken:
            app.add_api_route(path, (lambda v: (lambda c: v))(value), methods=["GET"])

    for route in ("notices", "concepts", "labels/presence"):
        stub(route, [])
    for route, value in {"undo": {"undo": None, "redo": None}, "filters": {}}.items():
        stub(route, value)

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
