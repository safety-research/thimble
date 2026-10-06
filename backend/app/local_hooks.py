"""The hooks' backend calls in terminal mode, where no server runs: what the server's routes do with a hook's record in
browser mode, run in a process the hook starts and does not wait for.

    thimble-python -m app.local_hooks <kind>     the hook's input on stdin

The file-first hooks of plugin/bin/.thimble-watch write their record to the workspace's files as in browser mode
(subagent_files.py); in terminal mode, instead of a post, each starts this module detached with its input:

    started     SubagentStart of one of thimble's agents (subagents.hook_started: its chat, its role's start handler)
    stopped     SubagentStop of any subagent (subagents.hook_stopped: a turn's end; the typed starts a fork never made)
    denied      PermissionDenied of a start or a message (subagents.hook_denied: R1)
    end         SessionEnd of main (subagents.hook_end: the running agents' chats end, "Stopped when Claude Code quit.")
    rekey       SessionStart of main for clear and resume (subagents.hook_rekey: the chats and the mirror follow)
    main-stop   Stop of main's turn (only the pass below: the mirror, R3, the hand-backs, the task notifications)
    plan        an agent's tool call in plan mode (subagents.plan_check, which every pass also runs)

One process holds the workspace's MIRROR_LOCK at a time. A call that finds it held adds its kind and input to TODO and
exits, and the holder takes it. The holder runs passes until nothing is left to do: each pass applies what module.json
says (the ends of the runs the module started, module_bridge.new_ended; a late spawn's stop, module_bridge.reconcile),
runs the mirror to the end of main's and every subagent's transcript (session.catch_up: chats, thread forks,
hand-backs, task notifications, R2 and R3, so subagents.run_ended and each role's end handler run as on the server),
stops thimble's agents when main is in plan mode (subagents.plan_check), and runs each kind's body. Between passes it
waits TICK_S while work it started goes on: the tasks the end handlers started (the coverage line, at most 120 s; a
follow-on start through the module), a hand-back's wait (subagents.stopped), and the view builds and report checks it
started, whose ends its own passes must see, since their queues live in its memory (dev, checks). It exits SETTLE_S
after the last of these, or once main's `claude` process has gone, and after MAX_S at the latest. Nothing runs in
browser mode: a call for a workspace whose session is not in terminal mode exits at once.

The SubagentStart hook's process then follows the running agents (follow): while one of thimble's agents runs, it makes
a call with no kind every FOLLOW_S, so an agent's thread shows its steps while it works, as the server's resident mirror
shows them in browser mode, and not only at the next hook.
"""
from __future__ import annotations

import asyncio
import contextlib
import fcntl
import json
import logging
import os
import sys
import time
from pathlib import Path
from typing import Any

from . import subagent_files as sf

log = logging.getLogger("thimble.local_hooks")

KINDS = ("started", "stopped", "denied", "end", "rekey", "main-stop", "plan")
MIRROR_LOCK = "mirror.lock"  # in the workspace folder: held by the one process that runs passes
TODO = "mirror.todo.jsonl"  # in the workspace folder: the calls that found the lock held, for the holder
TICK_S = 1.0
SETTLE_S = 3.0
MAX_S = 3600.0
LOG_FILE = "local-hooks.log"  # in the workspace folder
FOLLOW_LOCK = "mirror.follow.lock"  # in the workspace folder: held by the one process that follows the running agents
FOLLOW_S = 1.0  # between the follower's calls (follow)


def _todo_path(ws: Path) -> Path:
    return ws / TODO


def _add_todo(ws: Path, kind: str, body: dict[str, Any]) -> None:
    from . import event_files  # noqa: PLC0415 — its lock, standard library only

    path = _todo_path(ws)
    with event_files.locked(path):
        with open(path, "a", encoding="utf-8") as f:
            f.write(json.dumps({"kind": kind, "body": body, "at": time.time()}) + "\n")


def _take_todo(ws: Path) -> list[tuple[str, dict[str, Any]]]:
    from . import event_files  # noqa: PLC0415

    path = _todo_path(ws)
    if not path.exists():
        return []
    with event_files.locked(path):
        try:
            raw = path.read_text("utf-8")
            path.unlink()
        except OSError:
            return []
    out = []
    for line in raw.splitlines():
        with contextlib.suppress(ValueError):
            rec = json.loads(line)
            if isinstance(rec, dict) and rec.get("kind") in KINDS:
                out.append((str(rec["kind"]), rec.get("body") if isinstance(rec.get("body"), dict) else {}))
    return out


def _try_lock(ws: Path, name: str = MIRROR_LOCK) -> int | None:
    """The workspace's lock file `name` (MIRROR_LOCK), held: its file descriptor, or None when another process holds
    it."""
    try:
        fd = os.open(ws / name, os.O_RDONLY | os.O_CREAT, 0o600)
    except OSError:
        return None
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        os.close(fd)
        return None
    return fd


# the modules that hear an agent's end only once imported (agents.on_agent_finished at their import), as the server
# imports every module at its start: a writer's end starts the shown checks (checks), the orientation's report pass
# follows its writer (orient_session), and the document follows its writer (report_types)
END_LISTENERS = ("checks", "orient_session", "report_types")


def listen() -> None:
    """Import END_LISTENERS, so this process's passes run every handler of an agent's end the server would."""
    import importlib  # noqa: PLC0415

    for name in END_LISTENERS:
        importlib.import_module(f"{__package__}.{name}")


def run(c: str, kind: str, body: dict[str, Any]) -> int:
    """One call (module note): its kind and input go to the holder, which is this process when it takes MIRROR_LOCK.
    Returns the number of passes this process ran (0 when another held the lock)."""
    from . import config  # noqa: PLC0415

    ws = config.workspace_dir(c)
    if kind:
        _add_todo(ws, kind, body)
    passes = 0
    while True:
        fd = _try_lock(ws)
        if fd is None:
            return passes
        listen()
        try:
            passes += asyncio.run(_hold(c, ws))
        finally:
            os.close(fd)
        if not _todo_path(ws).exists():  # a call that came while the lock was being let go
            return passes


def _agents_run(c: str) -> bool:
    """Whether one of thimble's agents runs in workspace `c` (subagents.json)."""
    from . import subagents  # noqa: PLC0415

    return any(isinstance(a, dict) and a.get("role") in subagents.ROLES and a.get("status") in sf.RUNNING
               for a in subagents.agents_of(c).values())


def follow(c: str) -> int:
    """The SubagentStart hook's process, once its call is done: while one of thimble's agents runs and main's `claude`
    lives, a call with no kind every FOLLOW_S, so the mirror reads the agents' transcripts as they grow and their threads
    show their steps as they take them, as the server's mirror shows them in browser mode. One process follows at a
    time (FOLLOW_LOCK). Returns the number of passes it ran."""
    from . import config  # noqa: PLC0415

    ws = config.workspace_dir(c)
    start = time.monotonic()
    passes = 0

    def going() -> bool:
        return _agents_run(c) and sf.main_pid(ws) is not None and time.monotonic() - start < MAX_S

    while going():
        fd = _try_lock(ws, FOLLOW_LOCK)
        if fd is None:
            return passes
        try:
            while going():
                passes += run(c, "", {})
                time.sleep(FOLLOW_S)
        finally:
            os.close(fd)
        # an agent that started as this process let go: its own hook's process found the lock held, so look again
    return passes


async def _hold(c: str, ws: Path) -> int:
    start = time.monotonic()
    quiet = start
    passes = 0
    while time.monotonic() - start < MAX_S:
        items = _take_todo(ws)
        await _pass(c, items)
        passes += 1
        if items:
            quiet = time.monotonic()
        if sf.main_pid(ws) is None or any(k == "end" for k, _ in items):
            await _settle_tasks(SETTLE_S)  # main is gone: what its end started finishes, nothing more is waited for
            break
        if _busy(c):
            quiet = time.monotonic()
        elif time.monotonic() - quiet >= SETTLE_S and not _todo_path(ws).exists():
            break
        await asyncio.sleep(TICK_S)
    from . import subagents  # noqa: PLC0415

    for key in [k for k in subagents._waits if k[0] == c]:  # their timers end with this loop
        subagents._waits.pop(key, None)
    return passes


async def _pass(c: str, items: list[tuple[str, dict[str, Any]]]) -> None:
    """One pass (module note)."""
    from . import module_bridge, session, subagents  # noqa: PLC0415

    for e in _step("module.json's ends", module_bridge.new_ended, c) or []:
        _step("a run's end from the module", subagents.ended, c, e["agentId"], e["answer"], e["reason"])
    _step("a late spawn's stop", module_bridge.reconcile, c)
    _step("the mirror", session.catch_up, c)
    for kind, body in items:
        hook = body.get("hook") if isinstance(body.get("hook"), dict) else body
        if kind == "started":
            _step(kind, subagents.hook_started, c, hook)
        elif kind == "stopped":
            _step(kind, subagents.hook_stopped, c, hook)
        elif kind == "denied":
            _step(kind, subagents.hook_denied, c, hook)
        elif kind == "end":
            _step(kind, subagents.hook_end, c, hook)
        elif kind == "rekey":
            _step(kind, subagents.hook_rekey, c, hook)
            _step("the mirror", session.catch_up, c)
    if not any(k == "end" for k, _ in items):
        try:
            await subagents.plan_check(c)
        except Exception:  # noqa: BLE001 — the pass goes on
            log.exception("%s: the agents were not stopped for plan mode", c)


def _step(what: str, fn: Any, *args: Any) -> Any:
    try:
        return fn(*args)
    except Exception:  # noqa: BLE001 — one step that fails leaves the others to run
        log.exception("%s failed", what)
        return None


def _busy(c: str) -> bool:
    """Whether work this process started goes on (module note): a task of its loop, a hand-back's wait, or a view
    build or report check of this workspace whose end its passes must see."""
    from . import checks, dev, subagents  # noqa: PLC0415

    me = asyncio.current_task()
    if any(t is not me and not t.done() for t in asyncio.all_tasks()):
        return True
    if any(k[0] == c for k in subagents._waits):
        return True
    if any(k[0] == c for k in dev._view_runs) or any(k[0] == c for k in dev._view_queue):
        return True
    return any(k[0] == c for k in checks._active) or any(a.c == c for a in checks._queue if hasattr(a, "c"))


async def _settle_tasks(wait_s: float) -> None:
    me = asyncio.current_task()
    tasks = [t for t in asyncio.all_tasks() if t is not me and not t.done()]
    if tasks:
        await asyncio.wait(tasks, timeout=wait_s)


def _workspace(body: dict[str, Any]) -> str | None:
    """The workspace of the hook's folder, as the hooks find it (subagent_files.use_env, then config)."""
    from . import config  # noqa: PLC0415

    cwd = str(body.get("cwd") or os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd())
    return config.workspace_for_cwd(cwd)


LOG_BYTES = 1_000_000  # local-hooks.log is rotated past this, keeping one before it


def _logging(ws: Path) -> None:
    from logging.handlers import RotatingFileHandler  # noqa: PLC0415

    handler = RotatingFileHandler(ws / LOG_FILE, maxBytes=LOG_BYTES, backupCount=1, encoding="utf-8")
    handler.setFormatter(logging.Formatter("%(asctime)s %(process)d %(name)s %(levelname)s %(message)s"))
    root = logging.getLogger()
    root.addHandler(handler)
    root.setLevel(logging.INFO)


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    kind = args[0] if args else ""
    if kind not in KINDS:
        print(f"usage: python -m app.local_hooks {{{'|'.join(KINDS)}}} < hook input", file=sys.stderr)
        return 2
    try:
        body = json.loads(sys.stdin.read() or "{}")
    except ValueError:
        body = {}
    body = body if isinstance(body, dict) else {}
    sf.use_env()
    c = _workspace(body.get("hook") if isinstance(body.get("hook"), dict) else body)
    if not c:
        return 0
    from . import config  # noqa: PLC0415

    ws = config.workspace_path(c)
    if not sf.terminal(ws):
        return 0
    _logging(ws)
    try:
        run(c, kind, body)
        if kind == "started":
            follow(c)
    except Exception:  # noqa: BLE001
        log.exception("%s: the %s call failed", c, kind)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
