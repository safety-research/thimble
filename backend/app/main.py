"""FastAPI app: the thimble server. A module in ROUTER_MODULES that has routes exposes `router`, and one that owns
subprocesses or tasks (kernels, the job queue, the shims' event streams) exposes `shutdown()`, which the lifespan calls."""
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

OPEN_FILES = 8192  # the soft limit of open files the server raises its own to, within the hard limit
ACCEPT_LOG_S = 60.0  # one line in this long says the server could not accept connections (quiet_accept_errors)
ACCEPT_ERROR = "socket.accept() out of system resource"  # asyncio's message when accept() fails for want of descriptors


def raise_open_files(want: int = OPEN_FILES) -> str:
    """Raise this process's soft limit of open files to `want`, or to the hard limit when that is lower, and say what was
    done, '' when nothing was. Each kernel's channels take about twenty descriptors here (more on macOS, whose default
    soft limit is 256), so a few views open at once would otherwise run the server out of them: then no kernel starts
    and no connection is accepted. The kernels the server starts inherit the limit."""
    try:
        import resource  # noqa: PLC0415 — Unix only

        soft, hard = resource.getrlimit(resource.RLIMIT_NOFILE)
    except (ImportError, OSError, ValueError):
        return ""
    target = want if hard == resource.RLIM_INFINITY else min(hard, want)
    if soft == resource.RLIM_INFINITY or soft >= target:
        return ""
    hard_text = "unlimited" if hard == resource.RLIM_INFINITY else str(hard)
    try:
        resource.setrlimit(resource.RLIMIT_NOFILE, (target, hard))
    except (OSError, ValueError) as e:
        return f"open files: the soft limit stays {soft} (hard {hard_text}); raising it to {target} failed: {e}"
    return f"open files: raised the soft limit from {soft} to {target} (hard {hard_text})"


def quiet_accept_errors(loop: asyncio.AbstractEventLoop, every: float = ACCEPT_LOG_S) -> None:
    """While the process is out of file descriptors, asyncio logs ACCEPT_ERROR with a traceback for every try at each
    waiting connection, thousands of lines a second: here one line in `every` seconds says it, with how many tries
    failed meanwhile. Other errors go to the handler the loop had."""
    before = loop.get_exception_handler()
    state = {"at": -every, "n": 0}

    def handler(lp: asyncio.AbstractEventLoop, context: dict) -> None:
        if context.get("message") != ACCEPT_ERROR:
            if before is not None:
                before(lp, context)
            else:
                lp.default_exception_handler(context)
            return
        state["n"] += 1
        now = time.monotonic()
        if now - state["at"] < every:
            return
        log.error("the server cannot accept connections: %s (tries that failed since the last such line: %d); restart "
                  "it with `thimble server restart`", context.get("exception"), state["n"])
        state["at"], state["n"] = now, 0

    loop.set_exception_handler(handler)


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
    "corpus", "transcripts", "source_keys", "pdfs", "ledger", "investigation", "notebook", "concepts", "views", "cardtypes",
    "extensions", "precached",
    # the agent engine (main, threads, background agents) and the tools they call
    "agents", "tools", "jobs", "verify",
    # documents, and the report checks that comment on them (their runs shut down with the server)
    "report_types", "exports", "checks", "canvas_comments",
    # the developer agent, telemetry, the workspace export, the problem report
    "dev", "telemetry", "export", "feedback_routes",
    # undo and redo over the workspace's cards and documents
    "undo",
    # browser events to the analyst's Claude Code session, and the mirror of its transcript (listed for its shutdown)
    "events", "session",
    # the plugin's hooks module in main's session, which starts, messages and stops thimble's subagents on a click
    "module_bridge",
    # thimble's agents as subagents of main (their hooks' routes, Start it), the permission requests of an extension's
    # programs and a code ticket's own questions (shut down with the server), and the orientation's calls, stored whole
    # and citable
    "subagents", "agent_session", "calls", "orient_session", "write_session",
    # the programs an extension runs a role with (an Agent SDK program or a command), and their sessions
    "harness",
    # the orientation's, its critic's and the writers' tray entries in the analyst's terminal
    "tray",
    # the card harness (a headless Chromium that draws every card offscreen) and the card check that reads it, and
    # where the check's records and fixes are kept (the Undo of a fix)
    "render", "card_check", "checkstore",
    # the review of a built view's pictures, which sends what it finds back to the view's build session
    "view_review",
    # whether the product tour was offered on this install's first launch
    "tour",
    # the workspaces the start page and the top bar's switcher list
    "start_page",
]

# The backend binds to 127.0.0.1, but a DNS-rebinding page can still reach it as same-origin unless the Host
# header is checked. Ports are ignored by the middleware. Env override for other bind names (comma-separated).
ALLOWED_HOSTS = [h.strip() for h in os.environ.get("THIMBLE_ALLOWED_HOSTS", "127.0.0.1,localhost").split(",") if h.strip()]

# Request timing: a request slower than this many ms is logged at WARNING, every other one at DEBUG. Every response
# carries `Server-Timing: app;dur=<ms>`, so the browser's Network panel shows the backend's own time.
SLOW_REQUEST_MS = float(os.environ.get("THIMBLE_SLOW_MS", "300"))
# the watcher's long polls (events.py) and the hooks module's (module_bridge.py, whose hello may wait for a rekey),
# slow by design: logged at DEBUG like a fast request
LONG_POLLS = ("/api/events/pull", "/api/events/permission", "/api/module/next", "/api/module/hello")
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


class OldEventRoutes:
    """Pure ASGI middleware, outermost: a request on a route thimble 0.5.0 named for Claude Code channels, which a
    session started before the update still calls, goes on as its new route (events.OLD_PATHS), so every check and the
    router see the new path. Each such route is logged once."""

    def __init__(self, app) -> None:
        self.app = app
        self.seen: set[str] = set()

    async def __call__(self, scope, receive, send) -> None:
        from . import events  # noqa: PLC0415

        new = events.OLD_PATHS.get(scope.get("path", "")) if scope["type"] == "http" else None
        if new is not None:
            if scope["path"] not in self.seen:
                self.seen.add(scope["path"])
                log.info("%s answers as %s: a Claude Code session started before the update to thimble 0.6.0 calls "
                         "it; restarting that session loads the new plugin", scope["path"], new)
            scope = {**scope, "path": new, "raw_path": new.encode("latin-1")}
        await self.app(scope, receive, send)


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
    if raised := raise_open_files():
        log.info("%s", raised)
    quiet_accept_errors(asyncio.get_running_loop())
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
        hook_auth.ensure_session_key()
        config.private_dir(config.WORKSPACES_DIR)
    except Exception:
        log.exception("making thimble's home and workspaces private failed")
    # the extensions thimble ships added: those it ships on, on its first run (extensions.ship)
    try:
        from . import extensions

        for name in extensions.ship():
            log.info("extension %s added, renamed or updated from thimble's own", name)
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
    from . import loop_watch

    loop_watch.start(asyncio.get_running_loop())
    yield
    loop_watch.stop()
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
    app.add_middleware(CompleteStreams)  # sees every response's last message
    app.add_middleware(OldEventRoutes)  # added last = outermost: the checks see the new path

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

    from . import cli  # noqa: PLC0415 — imports config, procs and cc_plugin only

    install = {"home": str(cli.home().expanduser().resolve()), "app": str(Path(config.REPO_ROOT).resolve())}

    @app.get("/api/health")
    async def health() -> dict:
        # `leader` lets `server up`/`stop` find a server whose record was lost, `ui` lets an open tab tell it is stale,
        # and `home`/`app` let another install's `server up` on the same port refuse it. Answered on the event loop, not
        # in a worker thread, which can wait behind threads that compute: the supervisor and the plugin give a health
        # call 1 to 2 s (cli.HEALTH_TIMEOUT_S) before they take the server for one that is starting or gone.
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
