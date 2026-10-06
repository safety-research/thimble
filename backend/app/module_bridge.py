"""The server's side of thimble's hooks module (plugin/hooks/thimble.ts): how a click in the browser reaches Claude Code's
`$.agent.spawn`, `SendMessage` and `TaskStop` in main's session with no turn of main.

The module runs inside main's `claude` process, in thimble's launched interactive main only, and starts no process. It
says hello (POST /api/module/hello), fetches the roles it registers (GET /api/module/roles, from subagents.roles) and
what the workspace's record holds (GET /api/module/state), then holds a long poll (GET /api/module/next) that hands it
the requests made for its main session, one at a time; it answers each (POST /api/module/result), and posts the end of
each run of an agent it started (POST /api/module/ended), since its other hooks skip those agents. Every route is
hook-authenticated (hook_auth.MODULE_PREFIX): a request proves the token of server.json and the answer proves it back,
so a process that holds the port can neither hand the module requests nor read them.

A hello is accepted only from main's session: the one launch.json names, or the one `--rekey` moved it to after a
/clear or an in-session /resume (rekey), in either order, since the module sees the new id within tens of milliseconds
of the SessionStart hook (spike V2): a hello for an id that is not main yet is held up to HELLO_HOLD_S for a rekey that
names it. Main must also run inside thimble's fence (cc_plugin.main_fenced), so a THIMBLE_LAUNCHED that a child session
inherited gets no requests. The long poll hands out requests for that session only, so two mains in one folder never
take each other's clicks.

`request(c, op, **args)` is how the rest of the server asks (lane B's clicks, follow-ups and stops, lane E's jobs). It
waits up to REQUEST_TIMEOUT_S for the module's answer, after which the request expires and the answer is `no-module`:
the module never acts on an expired request, and an agent its late spawn started anyway is stopped, so a click never
starts an agent after its card said it did not. An Answer is a dict with exactly one of these keys:
    agentId     the agent started, sent to or stopped (`model` the model a spawn resolved; `text` the tool's text;
                `queued`: a message waits for a running agent's next tool round rather than resuming it)
    deny        thimble's own PreToolUse refused the call (the reason as Claude Code gives it)
    limit       Claude Code's concurrent-subagent limit (its own text, with the number)
    error       anything else (`gone`: the agent had ended already or belongs to another session)
    ok          a register or a note went through
    no-module   no module holds the long poll for main's session (the reason, why_not), or none answered in time
                (`expired`: true)
Ops and their arguments:
    register                              the module registers every role again from GET /api/module/roles
    spawn  role, prompt, description, values {model, effort}, what, request
                                          register the role with `values` if they differ, `$.agent.spawn`, then the
                                          one-line note (hint module-started-note, with `what`, a server-checked name)
    send   agent, text, role, values      register the run's values if needed, then SendMessage
    stop   agent                          TaskStop
    note   text                           `$.session.append` to main
`request` is a coroutine for the server's loop; request_blocking is the same call from a worker thread.

The workspace's subagents.json holds, under `module`, the last hello `{session, version, at}`, or the reason the
module stays idle (`idle`), what it could not register (`problem`), and the session moves rekey learned (`rekeyed`),
for `doctor`, the browser and a restarted server. It is written under an flock of subagents.json.lock beside it, with an
atomic replace, keeping every other key.
"""
from __future__ import annotations

import asyncio
import contextlib
import fcntl
import json
import logging
import os
import re
import secrets
import tempfile
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel

from . import config

log = logging.getLogger("thimble.module")
router = APIRouter()

REQUEST_TIMEOUT_S = 10.0  # a request the module has not answered by then expires (module note)
POLL_WAIT_S = 25.0  # the server holds a long poll this long
POLL_TICK_S = 1.0  # how often a held poll looks again whether its session is still main's
LIVE_GAP_S = 3.0  # a module whose last poll ended this recently still holds it: it polls again at once
HELLO_HOLD_S = 5.0  # a hello for a session that is not main yet waits this long for a rekey naming it
LOCK_WAIT_S = 2.0  # the most a write of subagents.json waits for its lock
EXPIRED_KEPT = 64  # expired requests remembered for their late answers
REKEYS_KEPT = 32
OPS = ("register", "spawn", "send", "stop", "note")
ANSWER_KEYS = ("agentId", "deny", "limit", "error", "ok")
NO_MODULE = "no-module"
REGISTRY = "subagents.json"  # lane B's record of thimble's agents, in the workspace (module note)
LAUNCH = "launch.json"  # written by `thimble launch-args` (lane A): {session, at, fenced, switches, unset}
NOTE_HINT = "module-started-note"  # prompts/tools.md: {role}, {agent}, {what}
AGENT = "{agent}"  # left in a note for the module to fill with the agent id it got
WHAT_CHARS = 120
NO_MODULE_ENV = "THIMBLE_NO_MODULE"
NOT_LOADED = "Claude Code did not load thimble's hooks module"
NOT_ANSWERING = "Your Claude Code session's thimble module did not answer"
NOT_MAIN = "this Claude Code session is not thimble's main session in this folder"
NOT_FENCED = "main does not run inside thimble's sandbox"
NO_LAUNCH = "thimble did not launch main in this folder (no launch.json names its session)"
ENDED_STATES = frozenset({"ended", "stopped", "killed", "completed", "failed", "done", "refused", "expired"})
TYPED_LIVE = frozenset({"", "pending", "claimed"})  # a typed start's request still waiting for main's Agent call
ROLE_TYPE = re.compile(r"thimble:(.+)")
SPEC_KEYS = ("name", "description", "prompt", "tools", "disallowedTools", "model", "effort", "permissionMode",
             "mcpServers", "maxTurns", "skills", "initialPrompt", "memory", "background", "omitClaudeMd")

Answer = dict  # module note: exactly one of ANSWER_KEYS or NO_MODULE, plus the extras named there


@dataclass
class _Request:
    id: str
    op: str
    args: dict[str, Any]
    session: str
    deadline: float  # monotonic; inf for one nobody waits on
    future: asyncio.Future | None = None
    taken: bool = False

    def wire(self) -> dict[str, Any]:
        left = self.deadline - time.monotonic()
        return {"id": self.id, "op": self.op, "args": self.args,
                **({"expires_in": max(0, int(left * 1000))} if left != float("inf") else {})}


@dataclass
class _Bridge:
    session: str = ""  # the main session whose hello was accepted last
    version: str = ""
    hello_at: float = 0.0
    polls: int = 0  # long polls open now
    last_poll: float = 0.0  # monotonic, when the last one ended
    queue: deque = field(default_factory=deque)
    by_id: dict[str, _Request] = field(default_factory=dict)
    expired: dict[str, str] = field(default_factory=dict)  # id -> op, for a late answer
    rekeyed: dict[str, str] = field(default_factory=dict)  # old main session -> new
    idle: str = ""  # why the last hello was refused
    problem: str = ""  # what the module reported it could not do (a role it could not register)


_bridges: dict[str, _Bridge] = {}
_waiters: dict[str, set[asyncio.Future]] = {}
_ended: list[Callable[[str, str, str, str], None]] = []
_loop: asyncio.AbstractEventLoop | None = None
_file_lock = threading.Lock()


# ---------------------------------------------------------------------------------------------------- the workspace

def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _ws(c: str) -> Path:
    return config.workspace_path(c)


def _read_json(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text("utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _launch(c: str) -> dict[str, Any]:
    """launch.json of workspace `c`, {} when there is none."""
    try:
        return _read_json(_ws(c) / LAUNCH)
    except ValueError:
        return {}


def registry(c: str) -> dict[str, Any]:
    """subagents.json of workspace `c`, {} when there is none or it cannot be read."""
    try:
        return _read_json(_ws(c) / REGISTRY)
    except ValueError:
        return {}


@contextlib.contextmanager
def _locked(path: Path):
    """An exclusive flock of `path`.lock, waiting up to LOCK_WAIT_S; past that the write goes on without it, since the
    module's record is advisory and a lock nobody releases must not stop the bridge."""
    fd = None
    try:
        fd = os.open(f"{path}.lock", os.O_RDWR | os.O_CREAT, 0o600)
        end = time.monotonic() + LOCK_WAIT_S
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except OSError:
                if time.monotonic() >= end:
                    log.warning("%s.lock is held past %.0f s; writing without it", path, LOCK_WAIT_S)
                    break
                time.sleep(0.02)
    except OSError:
        fd = None
    try:
        yield
    finally:
        if fd is not None:
            with contextlib.suppress(OSError):
                fcntl.flock(fd, fcntl.LOCK_UN)
            os.close(fd)


def _record(c: str, module: dict[str, Any]) -> None:
    """subagents.json's `module` key set to `module`, every other key kept (module note)."""
    try:
        path = config.workspace_dir(c) / REGISTRY
    except (OSError, ValueError):
        return
    with _file_lock, _locked(path):
        data = _read_json(path)
        data["module"] = module
        fd, tmp = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent))
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write(json.dumps(data, indent=1, ensure_ascii=False) + "\n")
            os.replace(tmp, path)
        except OSError:
            log.exception("writing the module's record into %s failed", path)
            with contextlib.suppress(OSError):
                os.unlink(tmp)


def _save(c: str, b: _Bridge) -> None:
    rec: dict[str, Any] = {"at": _now(), "session": b.session}
    if b.idle:
        rec["idle"] = b.idle
    else:
        rec["version"] = b.version
    if b.problem:
        rec["problem"] = b.problem
    if b.rekeyed:
        rec["rekeyed"] = dict(list(b.rekeyed.items())[-REKEYS_KEPT:])
    _record(c, rec)


def _bridge(c: str) -> _Bridge:
    b = _bridges.get(c)
    if b is None:
        b = _bridges[c] = _Bridge()
        moved = (registry(c).get("module") or {}).get("rekeyed")
        if isinstance(moved, dict):  # what a server before this one learned
            b.rekeyed.update({str(k): str(v) for k, v in moved.items() if isinstance(v, str)})
    return b


def main_session(c: str) -> str:
    """Main's session in workspace `c`: launch.json's, followed through every move rekey recorded; '' for none."""
    sid = str(_launch(c).get("session") or "")
    moved, seen = _bridge(c).rekeyed, set()
    while sid in moved and sid not in seen:
        seen.add(sid)
        sid = moved[sid]
    return sid


def _fenced(c: str) -> bool:
    from . import cc_plugin  # noqa: PLC0415

    try:
        return bool(cc_plugin.main_fenced(c))
    except Exception:  # noqa: BLE001 — main's command line could not be read
        log.debug("main_fenced(%s) failed", c, exc_info=True)
        return False


def _refusal(c: str, sid: str) -> str:
    """'' when a hello from `sid` may be accepted, else why not."""
    main = main_session(c)
    if not main:
        return NO_LAUNCH
    if sid != main:
        return NOT_MAIN
    if not _fenced(c):
        return NOT_FENCED
    return ""


def _accepted(c: str, sid: str) -> bool:
    """Whether `sid` said hello last and is main's session now."""
    b = _bridge(c)
    return bool(sid) and b.session == sid and not b.idle and main_session(c) == sid


# ---------------------------------------------------------------------------------------------------- waking

def _wake(c: str) -> None:
    for fut in list(_waiters.get(c, ())):
        if not fut.done():
            fut.set_result(None)


async def _wait(c: str, timeout: float) -> None:
    fut = asyncio.get_running_loop().create_future()
    _waiters.setdefault(c, set()).add(fut)
    try:
        await asyncio.wait_for(fut, timeout)
    except asyncio.TimeoutError:
        pass
    finally:
        _waiters.get(c, set()).discard(fut)


def _stopping() -> bool:
    from . import session  # noqa: PLC0415

    return session._shutting_down()


def _remember_loop() -> None:
    global _loop
    _loop = asyncio.get_running_loop()


# ---------------------------------------------------------------------------------------------------- the contract

def live(c: str) -> bool:
    """Whether a module holds the long poll for main's session in workspace `c` (module note)."""
    b = _bridges.get(c)
    if b is None or not _accepted(c, b.session):
        return False
    return b.polls > 0 or time.monotonic() - b.last_poll < LIVE_GAP_S


def why_not(c: str) -> str:
    """'' when the module is live, else why thimble's agents cannot start: the reason its hello was refused, what it
    reported, THIMBLE_NO_MODULE or the managed settings that turn hooks modules off, or that Claude Code did not load
    the module (or that it stopped polling)."""
    if live(c):
        return ""
    b = _bridges.get(c) or _Bridge()
    rec = registry(c).get("module") or {}
    idle = b.idle or (str(rec.get("idle") or "") if isinstance(rec, dict) else "")
    if idle:
        return idle
    if b.problem:
        return b.problem
    switches = _launch(c).get("switches")
    if isinstance(switches, (list, dict)) and NO_MODULE_ENV in switches:
        return f"{NO_MODULE_ENV} is set"
    from . import cc_plugin  # noqa: PLC0415

    tier = cc_plugin.managed() or {}
    for key in ("disableAllHooks", "allowManagedHooksOnly"):
        if tier.get(key) is True:
            return f"your organization's managed settings set {key}"
    if b.session and b.hello_at:
        return f"{NOT_ANSWERING}; it stopped polling"
    return NOT_LOADED


def on_ended(fn: Callable[[str, str, str, str], None]) -> None:
    """Call `fn(c, agent_id, answer, reason)` when the module posts the end of a run of an agent it started (its
    `turn.complete`, which reaches it although its other hooks skip that agent). Lane B's end rules register here."""
    if fn not in _ended:
        _ended.append(fn)


def rekey(c: str, old: str, new: str) -> None:
    """Main moved from session `old` to `new` (/clear or an in-session /resume; lane B's `--rekey` calls this). A hello
    from `new` waiting for it is accepted, whichever came first."""
    if not (old and new) or old == new:
        return
    b = _bridge(c)
    b.rekeyed.pop(new, None)  # a move back (/resume to the session before) ends the chain at `new`
    b.rekeyed[old] = new
    _save(c, b)
    if _loop is not None and _loop.is_running():
        _loop.call_soon_threadsafe(_wake, c)


def _note(role: str, what: str) -> str:
    """The one line the module appends to main at a start: hint module-started-note with the role and `what`, a
    server-checked name, and AGENT left for the module to fill. '' when the hint is missing."""
    from . import tools  # noqa: PLC0415

    clean = re.sub(r"[\x00-\x1f\x7f<>]+", " ", str(what or "")).strip()[:WHAT_CHARS]
    return tools.hint(NOTE_HINT, role=role, agent=AGENT, what=clean)


def _answer(op: str, raw: Any) -> Answer:
    """The module's answer as module note's Answer: one main key, and only the extras named there."""
    if not isinstance(raw, dict):
        return {"error": f"the module's answer to {op} was not an object"}
    key = next((k for k in ANSWER_KEYS if raw.get(k) not in (None, "", False)), None)
    if key is None:
        return {"error": f"the module gave no answer to {op}"}
    out: dict[str, Any] = {key: raw[key] if key != "ok" else True}
    for extra, kind in (("model", str), ("text", str), ("queued", bool), ("gone", bool)):
        if isinstance(raw.get(extra), kind):
            out[extra] = raw[extra]
    return out


def _enqueue(c: str, op: str, args: dict[str, Any], session: str, timeout: float | None) -> _Request:
    b = _bridge(c)
    loop = asyncio.get_running_loop()
    req = _Request(id=secrets.token_hex(8), op=op, args=args, session=session,
                   deadline=time.monotonic() + timeout if timeout is not None else float("inf"),
                   future=loop.create_future() if timeout is not None else None)
    b.queue.append(req)
    b.by_id[req.id] = req
    _wake(c)
    return req


def _args(op: str, args: dict[str, Any]) -> dict[str, Any]:
    """What the module gets for `op`; the note for a spawn is rendered here, from the role and `what` alone."""
    if op == "spawn":
        role = str(args.get("role") or "")
        out = {"role": role, "prompt": str(args.get("prompt") or ""), "description": str(args.get("description") or ""),
               "values": dict(args.get("values") or {}), "note": _note(role, str(args.get("what") or ""))}
        if args.get("request"):
            out["request"] = str(args["request"])
        return out
    if op == "send":
        return {"agent": str(args.get("agent") or ""), "text": str(args.get("text") or ""),
                "role": str(args.get("role") or ""), "values": dict(args.get("values") or {})}
    if op == "stop":
        return {"agent": str(args.get("agent") or "")}
    if op == "note":
        return {"text": str(args.get("text") or "")}
    return {}


async def request(c: str, op: str, **args: Any) -> Answer:
    """Ask the module of main's session in workspace `c` to do `op` (module note) and wait up to REQUEST_TIMEOUT_S for
    its answer. Never raises for the module's sake: no module, a refusal and a timeout are answers."""
    if op not in OPS:
        raise ValueError(f"unknown module op {op!r}")
    _remember_loop()
    if not live(c):
        return {NO_MODULE: why_not(c) or NOT_LOADED}
    b = _bridge(c)
    req = _enqueue(c, op, _args(op, args), b.session, REQUEST_TIMEOUT_S)
    try:
        # shielded: a timeout here expires the request (and answers its future) rather than cancelling it
        return await asyncio.wait_for(asyncio.shield(req.future), REQUEST_TIMEOUT_S)
    except asyncio.TimeoutError:
        _expire(c, req)
        return {NO_MODULE: NOT_ANSWERING, "expired": True}


def request_blocking(c: str, op: str, **args: Any) -> Answer:
    """`request` from a worker thread, on the server's loop. Called on the loop itself it would block the very loop the
    answer needs, so it raises there."""
    loop = _loop
    try:
        running = asyncio.get_running_loop()
    except RuntimeError:
        running = None
    if running is not None:
        raise RuntimeError("module_bridge.request_blocking was called on the event loop; await request() there")
    if loop is None or not loop.is_running():
        return {NO_MODULE: why_not(c) or NOT_LOADED}
    return asyncio.run_coroutine_threadsafe(request(c, op, **args), loop).result(REQUEST_TIMEOUT_S + 5)


def _expire(c: str, req: _Request) -> None:
    b = _bridge(c)
    with contextlib.suppress(ValueError):
        b.queue.remove(req)
    b.by_id.pop(req.id, None)
    b.expired[req.id] = req.op
    while len(b.expired) > EXPIRED_KEPT:
        b.expired.pop(next(iter(b.expired)))
    if req.future is not None and not req.future.done():
        req.future.set_result({NO_MODULE: NOT_ANSWERING, "expired": True})


def push_roles(c: str) -> None:
    """Have the module register every role again (Settings, the orientation instructions or the active extensions
    changed). Returns at once, from any thread; nothing when no module is live or one such request already waits."""

    def push() -> None:
        if not live(c):
            return
        b = _bridge(c)
        if any(r.op == "register" and not r.taken for r in b.queue):
            return
        _enqueue(c, "register", {}, b.session, None)

    try:
        asyncio.get_running_loop()
        push()
    except RuntimeError:
        if _loop is not None and _loop.is_running():
            _loop.call_soon_threadsafe(push)


def _take(c: str, session: str) -> _Request | None:
    b = _bridge(c)
    now = time.monotonic()
    for req in list(b.queue):
        if req.session != session:
            continue
        b.queue.remove(req)
        if req.deadline <= now:  # past its time: request() answers no-module for it, and the module never sees it
            _expire(c, req)
            continue
        req.taken = True
        if req.future is None:
            b.by_id.pop(req.id, None)
        return req
    return None


def _drop_session(c: str, session: str) -> None:
    """Requests made for a session that is no longer main's go nowhere: their callers get no-module now."""
    b = _bridge(c)
    for req in [r for r in b.queue if r.session != session]:
        b.queue.remove(req)
        b.by_id.pop(req.id, None)
        if req.future is not None and not req.future.done():
            req.future.set_result({NO_MODULE: NOT_ANSWERING})


# ---------------------------------------------------------------------------------------------------- routes

def _workspace(cwd: str) -> str:
    c = config.workspace_for_cwd(cwd) if cwd else None
    if not c:
        raise HTTPException(404, f"{cwd} is not a thimble workspace")
    return c


def _require(c: str, session: str) -> _Bridge:
    if not _accepted(c, session):
        raise HTTPException(409, "say hello first: this session's hello is not the accepted one")
    return _bridge(c)


class HelloBody(BaseModel):
    cwd: str
    session: str
    version: str = ""
    problem: str = ""  # what the module could not do, such as a role Claude Code refused to register


@router.post("/module/hello")
async def hello_route(body: HelloBody) -> dict[str, Any]:
    """The module's hello: accepted (200) from main's fenced session, held up to HELLO_HOLD_S for a rekey that names a
    new main, else refused (403, with the reason recorded for why_not). 404 for a folder that is no workspace yet: the
    module says hello again later."""
    _remember_loop()
    c = _workspace(body.cwd)
    b = _bridge(c)
    end = time.monotonic() + HELLO_HOLD_S
    while True:
        why = _refusal(c, body.session)
        if not why:
            break
        if why != NOT_MAIN or time.monotonic() >= end:
            if not _accepted(c, b.session):  # a refused stray never unseats the main session's module
                b.idle = why
                _save(c, b)
            log.info("module hello from %s refused in %s: %s", body.session, c, why)
            raise HTTPException(403, why)
        await _wait(c, max(0.0, min(0.25, end - time.monotonic())))
    moved = b.session != body.session
    b.session, b.version, b.hello_at, b.idle = body.session, body.version, time.time(), ""
    b.problem = body.problem.strip()[:500]
    _save(c, b)
    if moved:
        _drop_session(c, body.session)
    _wake(c)
    log.info("module %s said hello for %s in %s", body.version or "?", body.session, c)
    return {"ok": True}


@router.get("/module/next")
async def next_route(request: Request, cwd: str, session: str, wait: float = POLL_WAIT_S) -> Any:
    """The module's long poll: `{request}` for the next request made for this session, 204 when none came within
    `wait` seconds, 409 when the session's hello is not the accepted one (the module says hello again)."""
    _remember_loop()
    c = _workspace(cwd)
    b = _require(c, session)
    b.polls += 1
    try:
        deadline = time.monotonic() + min(max(wait, 0.0), POLL_WAIT_S)
        while True:
            if not _accepted(c, session):
                raise HTTPException(409, "this session is not main's any more: say hello again")
            if await request.is_disconnected() or _stopping():
                return Response(status_code=204)
            req = _take(c, session)
            if req is not None:
                return {"request": req.wire()}
            left = deadline - time.monotonic()
            if left <= 0:
                return Response(status_code=204)
            await _wait(c, min(left, POLL_TICK_S))
    finally:
        b.polls -= 1
        b.last_poll = time.monotonic()


class ResultBody(BaseModel):
    cwd: str
    session: str = ""
    id: str
    answer: dict[str, Any] = {}


@router.post("/module/result")
async def result_route(body: ResultBody) -> dict[str, Any]:
    """The module's answer to a request. A late answer to an expired spawn that started an agent anyway gets that agent
    stopped, since its caller was told it did not start."""
    _remember_loop()
    c = _workspace(body.cwd)
    b = _bridge(c)
    req = b.by_id.pop(body.id, None)
    if req is None:
        if b.expired.get(body.id) == "spawn" and isinstance(agent := body.answer.get("agentId"), str) and agent:
            log.warning("the module started %s for an expired request %s; stopping it", agent, body.id)
            if live(c):
                _enqueue(c, "stop", {"agent": agent}, b.session, None)
        return {"ok": False, "expired": body.id in b.expired}
    if req.future is not None and not req.future.done():
        req.future.set_result(_answer(req.op, body.answer))
    return {"ok": True}


class EndedBody(BaseModel):
    cwd: str
    session: str = ""
    agentId: str
    answer: str = ""
    reason: str = ""


@router.post("/module/ended")
async def ended_route(body: EndedBody) -> dict[str, Any]:
    """The end of a run of an agent the module started (its turn.complete), for lane B's end rules (on_ended)."""
    c = _workspace(body.cwd)
    for fn in list(_ended):
        try:
            fn(c, body.agentId, body.answer, body.reason)
        except Exception:  # noqa: BLE001 — one observer's failure is logged, never the module's
            log.exception("an observer of the module's ended post failed")
    return {"ok": True}


def _spec(name: str, role: Any) -> dict[str, Any] | None:
    """One role of subagents.roles as `$.agent.register` takes it: SPEC_KEYS only, `name` the role's own."""
    if hasattr(role, "spec") and callable(role.spec):
        role = role.spec()
    elif hasattr(role, "__dataclass_fields__"):
        import dataclasses  # noqa: PLC0415

        role = dataclasses.asdict(role)
    if not isinstance(role, dict):
        return None
    out = {k: role[k] for k in SPEC_KEYS if role.get(k) not in (None, "", [], {})}
    out["name"] = ROLE_TYPE.sub(r"\1", name)
    return out


@router.get("/module/roles")
async def roles_route(cwd: str, session: str) -> dict[str, Any]:
    """The roles the module registers, from subagents.roles: `{roles: {name: spec}}`."""
    c = _workspace(cwd)
    _require(c, session)
    from . import subagents  # noqa: PLC0415

    roles = await asyncio.to_thread(subagents.roles, c)
    out: dict[str, dict[str, Any]] = {}
    for name, role in (roles or {}).items():
        spec = _spec(str(name), role)
        if spec is not None:
            out[spec["name"]] = spec
    return {"roles": out}


def _role_of(kind: Any) -> str:
    m = ROLE_TYPE.fullmatch(str(kind or ""))
    return m.group(1) if m else ""


def _running(entry: dict[str, Any]) -> bool:
    state = str(entry.get("status") or entry.get("state") or "")
    return state not in ENDED_STATES and not entry.get("ended")


def _what(entry: dict[str, Any]) -> str:
    """The server-checked name an agent's note gives: the part of its key after the role (a document, a view's slug,
    a check and its document)."""
    key = str(entry.get("key") or "")
    return key.split(":", 1)[1] if ":" in key else ""


def _efforts(reg: dict[str, Any], agents: dict[str, dict[str, Any]]) -> dict[str, Any]:
    """The per-run efforts the module's step hook applies, by agent id: subagents.json's own record (`efforts`), and for
    an agent main started for a typed request the run's effort, given down to its descendants whose type is not one of
    thimble's (V7d)."""
    out: dict[str, Any] = {}
    for aid, e in agents.items():
        effort = (e.get("values") or {}).get("effort") if isinstance(e.get("values"), dict) else None
        if _role_of(e.get("type")) and not e.get("plugin_started") and effort not in (None, ""):
            out[aid] = effort
    changed = True
    while changed:  # parents before children, however the registry orders them
        changed = False
        for aid, e in agents.items():
            parent = str(e.get("parent") or "")
            if aid not in out and parent in out and not str(e.get("type") or "").startswith("thimble:"):
                out[aid] = out[parent]
                changed = True
    own = reg.get("efforts")
    if isinstance(own, dict):
        out.update({str(k): v for k, v in own.items() if v not in (None, "")})
    return out


def _typed(reg: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """The typed starts still waiting for main's Agent call, by request id: {role, values, key}."""
    out: dict[str, dict[str, Any]] = {}
    for table in ("pending", "requests"):
        rows = reg.get(table)
        if not isinstance(rows, dict):
            continue
        for rid, r in rows.items():
            if not isinstance(r, dict) or r.get("route") != "typed" or (r.get("kind") or "start") != "start":
                continue
            if str(r.get("state") or "") not in TYPED_LIVE:
                continue
            out[str(r.get("id") or rid)] = {"role": _role_of(r.get("role")) or str(r.get("role") or ""),
                                            "values": dict(r.get("values") or {}), "key": str(r.get("key") or "")}
    return out


@router.get("/module/state")
async def state_route(cwd: str, session: str) -> dict[str, Any]:
    """What the module keeps in memory, from subagents.json: the running thimble agents, the per-run efforts, the typed
    starts waiting for main's Agent call, and the note to append to a new main for each running agent (after /clear or
    /resume the new main has no record of them)."""
    c = _workspace(cwd)
    _require(c, session)
    reg = registry(c)
    table = reg.get("agents")
    agents = {str(k): v for k, v in table.items() if isinstance(v, dict)} if isinstance(table, dict) else {}
    running = {aid: e for aid, e in agents.items() if _running(e)}
    notes = []
    for aid, e in running.items():
        role = _role_of(e.get("type"))
        if role and role != "helper" and not e.get("parent"):
            line = _note(role, _what(e)).replace(AGENT, aid)
            if line:
                notes.append(line)
    return {
        "agents": {aid: {"type": str(e.get("type") or ""), "role": _role_of(e.get("type")),
                         "plugin_started": bool(e.get("plugin_started"))} for aid, e in running.items()},
        "efforts": _efforts(reg, agents),
        "requests": _typed(reg),
        "notes": notes,
    }


async def shutdown() -> None:
    """Every waiting caller gets no-module, and every held poll returns."""
    for c, b in _bridges.items():
        for req in list(b.by_id.values()):
            if req.future is not None and not req.future.done():
                req.future.set_result({NO_MODULE: NOT_ANSWERING})
        b.queue.clear()
        b.by_id.clear()
        _wake(c)
