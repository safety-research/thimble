"""FastAPI app: the thimble server. A module in ROUTER_MODULES that has routes exposes `router`, and one that owns
subprocesses or tasks (kernels, the job queue, the channel's streams) exposes `shutdown()`, which the lifespan calls."""
from __future__ import annotations

import asyncio
import contextlib
import importlib
import logging
import os
import shutil
import sys
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Body, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from starlette.datastructures import MutableHeaders
from starlette.exceptions import HTTPException
from starlette.middleware.trustedhost import TrustedHostMiddleware
from starlette.staticfiles import StaticFiles

from . import config
from .errors import ErrorLog
from . import hook_auth
from .hook_auth import HookAuth, LocalWriteGuard
from .http_guard import OriginCheck, SecurityHeaders, dev_origins

# every line of thimble's own loggers carries a wall-clock stamp, so the server log can be read against the other logs
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("thimble")


def stamp_uvicorn_logs() -> None:
    """Put the same wall-clock stamp in front of uvicorn's own lines (its access lines and its errors), which carry none
    by default. uvicorn configures its handlers before it imports this module, so they are there to change."""
    for name in ("uvicorn", "uvicorn.access"):
        for handler in logging.getLogger(name).handlers:
            fmt = handler.formatter
            text = getattr(fmt, "_fmt", None)
            if fmt is None or not text or "%(asctime)s" in text:
                continue
            try:
                handler.setFormatter(type(fmt)(fmt="%(asctime)s " + text, use_colors=False))
            except TypeError:  # a formatter of another shape, from a log config of the operator's
                handler.setFormatter(logging.Formatter("%(asctime)s " + text))


stamp_uvicorn_logs()


class QuietPolling(logging.Filter):
    """Drop uvicorn's access line for a successful GET or HEAD, and for a successful telemetry POST: the open tab's
    polling would otherwise fill server.log and push errors out of the problem report's tail. THIMBLE_ACCESS_LOG=all
    keeps every line."""

    def filter(self, record: logging.LogRecord) -> bool:
        args = record.args if isinstance(record.args, tuple) else ()
        if len(args) != 5:  # uvicorn's access line: client, method, path, HTTP version, status
            return True
        method, path, status = args[1], args[2], args[4]
        if not isinstance(status, int) or status >= 400:
            return True
        telemetry = method == "POST" and isinstance(path, str) and path.split("?", 1)[0].endswith("/telemetry")
        return not (method in ("GET", "HEAD") or telemetry)


if os.environ.get("THIMBLE_ACCESS_LOG", "").strip().lower() != "all":
    logging.getLogger("uvicorn.access").addFilter(QuietPolling())

ROUTER_MODULES = [
    # storage and the corpus
    "corpus", "transcripts", "pdfs", "ledger", "investigation", "notebook", "concepts", "views", "cardtypes",
    "extensions",
    # the agent engine (main, threads, background agents) and the tools they call
    "agents", "tools", "jobs", "verify",
    # documents, and the report checks that comment on them (their runs shut down with the server)
    "report_types", "exports", "checks",
    # the developer agent, telemetry, the workspace export, the problem report
    "dev", "telemetry", "export", "feedback_routes",
    # undo and redo over the workspace's cards and documents
    "undo",
    # the channel to the analyst's Claude Code session, and the mirror of its transcript (listed for its shutdown)
    "channel", "session",
    # the Claude Code sessions thimble starts beside main, the orientation's and each writer's: their permission
    # requests (shut down with the server), and the orientation's calls, stored whole and citable
    "agent_session", "calls", "orient_session",
    # the orientation's, its critic's and the writers' Claude Code background sessions, and their tray entries
    "bg_session",
    # the card harness (a headless Chromium that draws every card offscreen) and the card check that reads it, and
    # where the check's records and fixes are kept (the Undo of a fix)
    "render", "card_check", "checkstore",
    # the review of a built view's pictures, which sends what it finds back to the view's build session
    "view_review",
]

# The backend binds to 127.0.0.1, but a DNS-rebinding page can still reach it as same-origin unless the Host
# header is checked. Ports are ignored by the middleware. Env override for other bind names (comma-separated).
ALLOWED_HOSTS = [h.strip() for h in os.environ.get("THIMBLE_ALLOWED_HOSTS", "127.0.0.1,localhost").split(",") if h.strip()]

# Request timing: a request slower than this many ms is logged at WARNING, every other one at DEBUG. Every response
# carries `Server-Timing: app;dur=<ms>`, so the browser's Network panel shows the backend's own time.
SLOW_REQUEST_MS = float(os.environ.get("THIMBLE_SLOW_MS", "300"))
# the watcher's long polls (channel.py), slow by design: logged at DEBUG like a fast request
LONG_POLLS = ("/api/channel/pull", "/api/channel/permission/hook")
timing_log = logging.getLogger("thimble.timing")

class RequestTiming:
    """Pure ASGI middleware (BaseHTTPMiddleware would wrap the body, and SSE routes stay open for minutes). The clock
    stops at `http.response.start`, so a stream is measured by its time to first byte; the body passes through
    untouched."""

    def __init__(self, app, slow_ms: float | None = None) -> None:
        self.app = app
        self.slow_ms = SLOW_REQUEST_MS if slow_ms is None else slow_ms

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        start = time.perf_counter()

        async def send_timed(message) -> None:
            if message["type"] == "http.response.start":
                ms = (time.perf_counter() - start) * 1000
                MutableHeaders(scope=message).append("Server-Timing", f"app;dur={ms:.1f}")
                qs = (scope.get("query_string") or b"").decode("latin-1")
                path = scope["path"] + (f"?{qs}" if qs else "")
                slow = ms >= self.slow_ms and scope["path"] not in LONG_POLLS
                timing_log.log(logging.WARNING if slow else logging.DEBUG,
                               "%s %s -> %s in %.0f ms", scope.get("method", "?"), path, message["status"], ms)
            await send(message)

        await self.app(scope, receive, send_timed)


class CompleteStreams:
    """Pure ASGI middleware. When the server stops, sse_starlette cancels each event stream without the response's last
    message, which uvicorn reports as an error; such a response gets its last, empty message here. An unfinished
    response at any other time is left for uvicorn to report."""

    def __init__(self, app) -> None:
        self.app = app

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        state = {"started": False, "done": False}

        async def track(message) -> None:
            if message["type"] == "http.response.start":
                state["started"] = True
            elif message["type"] == "http.response.body" and not message.get("more_body", False):
                state["done"] = True
            await send(message)

        await self.app(scope, receive, track)
        session = sys.modules.get("app.session")
        if state["started"] and not state["done"] and session is not None and session._shutting_down():
            with contextlib.suppress(Exception):  # the client may be gone already
                await send({"type": "http.response.body", "body": b"", "more_body": False})


def dev_mode() -> bool:
    """cli.resolve_env's rule, as cli._server_environ passes it to this process: THIMBLE_DEV on means Vite serves the
    source on the UI port with HMR and nothing is mounted at / here."""
    return os.environ.get("THIMBLE_DEV", "").strip().lower() in ("1", "true", "yes", "on")


def frontend_dist() -> Path | None:
    """The built UI to serve at /: config.FRONTEND_DIST when it holds an index.html and the server is not in dev mode,
    else None (a release install without a build, or a dev stack)."""
    if dev_mode():
        return None
    d = Path(config.FRONTEND_DIST)
    return d if (d / "index.html").is_file() else None


def ui_build() -> str | None:
    """The built UI's identity: its index.html's modification time, which a build changes (scripts/rebuild_ui.sh swaps
    index.html last). None in dev mode, where Vite reloads the page itself, and without a build."""
    dist = frontend_dist()
    if dist is None:
        return None
    try:
        return str((dist / "index.html").stat().st_mtime_ns)
    except OSError:
        return None


class BuiltUI(StaticFiles):
    """frontend/dist at / (StaticFiles, html=True serves / as index.html). Mounted after every /api route, so those
    always win. An unknown extension-less path is a client-side route and gets index.html; an unknown asset stays a 404.
    An unknown /api path is a 404 whatever the method (StaticFiles would answer 405 to a DELETE or POST)."""

    async def get_response(self, path: str, scope) -> object:
        if path == "api" or path.startswith("api/"):
            raise HTTPException(status_code=404)
        try:
            return await super().get_response(path, scope)
        except HTTPException as e:
            if e.status_code == 404 and "." not in path.rsplit("/", 1)[-1]:
                return await super().get_response("index.html", scope)
            raise


@asynccontextmanager
async def _lifespan(app: FastAPI):
    log.info("data dir %s, workspaces dir %s", config.DATA_DIR, config.WORKSPACES_DIR)
    # the versions in play, so a log sent with a problem report says what ran
    try:
        from . import cli

        log.info("pid %s, port %s, home %s; %s; Claude Code %s", os.getpid(), os.environ.get("THIMBLE_PORT", "?"),
                 cli.home(), cli.versions_line(), cli.claude_code_version() or "not found on PATH")
    except Exception:
        log.exception("reading the versions for the log failed")
    # thimble's state is its owner's alone: <home> and the workspaces are private folders (config.private_dir)
    try:
        from . import cli

        cli.ensure_home()
        st = cli.read_state()
        if st and not st.get("token"):  # a record an older supervisor wrote: the hooks' token (hook_auth.py)
            cli.write_state(st)
        config.private_dir(config.WORKSPACES_DIR)
    except Exception:
        log.exception("making thimble's home and workspaces private failed")
    # the extensions thimble ships added: those it ships on, on its first run (extensions.ship)
    try:
        from . import extensions

        for name in extensions.ship():
            log.info("extension %s added from thimble's own", name)
    except Exception:
        log.exception("adding the extensions thimble ships failed")
    # the records an install tree's data/ holds are brought into the registry once (config.migrate_registry)
    try:
        config.migrate_registry()
    except Exception:
        log.exception("bringing the install tree's registry records into %s failed", config.DATA_DIR)
    from . import userconf

    if why := userconf.problem():
        log.warning("%s; no agent starts until it is fixed", why)
    # what older versions left in Claude Code's files and in the workspaces, taken out once: the keys they wrote into
    # folders' settings.local.json (claude_changes.cleanup) and each workspace's own Claude Code config dir
    try:
        from . import claude_changes

        for line in claude_changes.cleanup():
            log.info("%s", line)
        for old in config.WORKSPACES_DIR.glob("*/.claude-config"):
            shutil.rmtree(old, ignore_errors=True)
    except Exception:
        log.exception("removing what an older thimble left failed")
    # the views an older thimble kept in a workspace's views/ moved into its local extension, once
    try:
        from . import views

        views.migrate_workspaces()
    except Exception:
        log.exception("moving the workspaces' views into their local extensions failed")
    await _startup()
    yield
    # shutdown: modules that own subprocesses expose `shutdown()`, so a restart never leaves an orphan running
    for name in ROUTER_MODULES:
        fn = getattr(sys.modules.get(f"app.{name}"), "shutdown", None)
        if fn is None:
            continue
        try:
            await fn()
        except Exception:
            log.exception("shutdown of app.%s failed", name)


async def _startup() -> None:
    """Cross-module wiring that needs every router imported. Never fails the start: a module that is absent or raises is
    logged and skipped.

    dev's restart bookkeeping runs now: a ticket left `running` by a restart is marked failed and a pending restart.json
    is announced. The announcement runs as a task, since it waits for the kernel reconnect in the routers' lifespans,
    which start after this returns.
    """
    dev = sys.modules.get("app.dev")
    if dev is not None:
        try:
            recover = getattr(dev, "_recover", None)
            if recover is not None:
                recover()
            announce = getattr(dev, "announce_restart", None)
            if announce is not None:

                async def announce_after_start() -> None:
                    try:
                        await announce()
                    except Exception:
                        log.exception("restart announcement failed")

                asyncio.get_running_loop().create_task(announce_after_start(), name="dev-announce-restart")
        except Exception:
            log.exception("dev startup wiring failed")
    # a server that re-exec'd itself after a dev apply keeps its pid but runs the applied tree; server.json's
    # `source_fingerprint` must describe that tree, or the next `ensure` restarts it again for the same change
    try:
        from . import cli

        if cli.record_source_fingerprint():
            log.info("source fingerprint refreshed in %s", cli.server_json())
    except Exception:
        log.exception("recording the source fingerprint failed")


def create_app() -> FastAPI:
    app = FastAPI(title="thimble", version="0.0.1", lifespan=_lifespan)
    # Every page reaches /api same-origin, from the built UI or through Vite's proxy; only a dev stack trusts the Vite
    # origin, since any project's dev server can sit on a loopback port (http_guard). ErrorLog is innermost, so an
    # error's answer passes through the checks' headers and the timing.
    app.add_middleware(ErrorLog)
    vite = dev_origins(dev_mode())
    if vite:
        app.add_middleware(CORSMiddleware, allow_origins=vite, allow_methods=["*"], allow_headers=["*"])
    app.add_middleware(HookAuth)  # inside the write guard: a hook proves the token here too
    app.add_middleware(LocalWriteGuard)  # inside OriginCheck, outside HookAuth: a forged-Origin write still needs the cookie or the token
    app.add_middleware(OriginCheck, extra_origins=vite)  # after TrustedHost: the Host it compares with is an allowed one
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=ALLOWED_HOSTS)
    app.add_middleware(SecurityHeaders)  # outside the two checks, so their refusals carry the headers too
    app.add_middleware(RequestTiming)  # times the whole stack
    app.add_middleware(CompleteStreams)  # added last = outermost: sees every response's last message

    for name in ROUTER_MODULES:
        try:
            mod = importlib.import_module(f"app.{name}")
        except ModuleNotFoundError as e:
            if e.name == f"app.{name}":
                log.warning("router module app.%s not present", name)
                continue
            raise
        router = getattr(mod, "router", None)
        if router is None:
            log.debug("app.%s has no `router` (listed for its shutdown hook)", name)
            continue
        app.include_router(router, prefix="/api")

    from . import cli  # noqa: PLC0415 — imports config, procs and cc_channel only

    install = {"home": str(cli.home().expanduser().resolve()), "app": str(Path(config.REPO_ROOT).resolve())}

    @app.get("/api/health")
    def health() -> dict:
        # `leader` lets `server up`/`stop` find a server whose record was lost, `ui` lets an open tab tell it is stale,
        # and `home`/`app` let another install's `server up` on the same port refuse it
        return {"ok": True, "leader": os.getsid(0), "boot": config.BOOT_ID, "ui": ui_build(), **install}

    @app.post("/api/ui/key")
    def ui_key(body: dict = Body(...)):
        # the key of the page's link, traded for the cookie a change of permission modes needs (hook_auth.claim)
        return hook_auth.claim(body.get("key"))

    # the built UI, last: a mount at / matches everything the routes above did not
    dist = frontend_dist()
    if dist is not None:
        app.mount("/", BuiltUI(directory=str(dist), html=True), name="ui")
        log.info("serving the built UI from %s at /", dist)
    elif not dev_mode():
        log.warning(config.NO_UI_BUILD_HINT)

    return app


app = create_app()
