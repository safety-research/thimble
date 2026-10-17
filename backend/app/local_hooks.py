"""The hooks' backend calls on local transport, where no server runs for the session: what the server's routes do with
a hook's record, run in a process the hook starts and does not wait for.

    thimble-python -m app.local_hooks <kind>     the hook's input on stdin

The file-first hooks of plugin/bin/.thimble-watch write their record to the workspace's files whatever the transport
(subagent_files.py); on local transport (subagent_files.transport), instead of a post, each starts this module detached
with its input:

    started     SubagentStart of one of thimble's agents (subagents.hook_started: its chat, its role's start handler)
    stopped     SubagentStop of any subagent (subagents.hook_stopped: a turn's end; the typed starts a fork never made)
    handback    PreToolUse of a hand-back the hook took from a check's or the card check's agent (subagents.hook_handback:
                the run's end with its report)
    denied      PermissionDenied of a start or a message (subagents.hook_denied: R1)
    end         SessionEnd of main (subagents.hook_end: the running agents' chats end, "Stopped when Claude Code quit.")
    rekey       SessionStart of main for clear and resume (subagents.hook_rekey: the chats and the mirror follow)
    main-stop   Stop of main's turn (only the pass below: the mirror, R3, the hand-backs, the task notifications)
    mode-notice main's permission mode turned into or out of Manual mode (the mode hook): the `manual-mode` notice
                shown with modes.manual_notice's words, or cleared (notices.py), as session.note_mode does on the
                server

and `thimble act` (local.py) starts it with the analyst's answer to a view proposal or to a notice, since only this
process writes proposals.json and the chats' logs, and follows to its end a build it queues (dev's queue lives in its
memory):

    view-accept       the view proposal accepted (views.accept: its build queued as one the analyst asked for)
    view-reject       the view proposal rejected (views.answer_offer)
    view-retry        a failed build of a view run again, a notice's Retry (views.retry)
    view-propose-now  a check for a view proposal now, a notice's Try again (proposer.run_now)
    view-term-page    the terminal page of a view built for the browser, built on its first open in the terminal
                      (views.ensure_page)
    notice-dismiss    a notice dismissed, its × (notices.dismiss)

One process holds the workspace's MIRROR_LOCK at a time. A call that finds it held adds its kind and input to TODO and
exits, and the holder takes it. The holder runs passes until nothing is left to do: each pass applies what module.json
says (the ends of the runs the module started, module_bridge.new_ended; a late spawn's stop, module_bridge.reconcile),
runs the mirror to the end of main's and every subagent's transcript (session.catch_up: chats, thread forks, hand-backs,
task notifications, R2 and R3, so subagents.run_ended and each role's end handler run as on the server), and runs each
kind's body. Plan mode stops no running agent. Between passes it waits TICK_S while work it started goes on: the tasks
the end handlers started (the coverage line, at most 120 s; a follow-on start through the module), a hand-back's wait
(subagents.stopped), and the view builds and report checks it started, whose ends its own passes must see, since their
queues live in its memory (dev, checks). It exits SETTLE_S after the last of these, or once main's `claude` process has
gone, and after MAX_S at the latest. A call for a workspace whose main runs on the server exits at once.

The press hands the session over to thimble's server: the work this process started (a view build it queued, a check
it runs) finishes here (H6), while its passes stop reading main's transcript (session.catch_up reads nothing once main's
transport is the server), and it starts no new pass for a call (TODO) and exits once that work is done; the server's
mirror reads on from the cursor the last pass saved (session.attach waits for a pass under way, H4).

The SubagentStart hook's process then follows the running agents (follow): while one of thimble's agents runs and
main's transport is local, it makes a call with no kind every FOLLOW_S, so an agent's thread shows its steps while it
works, as the server's resident mirror shows them, and not only at the next hook.
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

KINDS = ("started", "stopped", "handback", "denied", "end", "rekey", "main-stop", "mode-notice", "view-accept",
         "view-reject", "view-retry", "view-propose-now", "view-term-page", "notice-dismiss")
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
# imports every module at its start: a writer's end starts the shown checks (checks), and the document follows its
# writer (report_types)
END_LISTENERS = ("checks", "report_types")


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
        if not _todo_path(ws).exists() or _served(ws):  # a call that came while the lock was being let go
            return passes


def _served(ws: Path) -> bool:
    """Whether a press handed main over to thimble's server (subagent_files.transport)."""
    return sf.transport(ws) == sf.SERVER


def _agents_run(c: str) -> bool:
    """Whether one of thimble's agents runs in workspace `c` (subagents.json)."""
    from . import subagents  # noqa: PLC0415

    return any(isinstance(a, dict) and a.get("role") in subagents.ROLES and a.get("status") in sf.RUNNING
               for a in subagents.agents_of(c).values())


def follow(c: str) -> int:
    """The SubagentStart hook's process, once its call is done: while one of thimble's agents runs and main's `claude`
    lives, a call with no kind every FOLLOW_S, so the mirror reads the agents' transcripts as they grow and their threads
    show their steps as they take them, as the server's mirror shows them. One process follows at a
    time (FOLLOW_LOCK). Returns the number of passes it ran."""
    from . import config  # noqa: PLC0415

    ws = config.workspace_dir(c)
    start = time.monotonic()
    passes = 0

    def going() -> bool:
        return (_agents_run(c) and sf.main_pid(ws) is not None and not _served(ws)
                and time.monotonic() - start < MAX_S)

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
        elif _served(ws) or (time.monotonic() - quiet >= SETTLE_S and not _todo_path(ws).exists()):
            break  # after the press only the work it started kept it here (H6)
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
        elif kind == "handback":
            _step(kind, subagents.hook_handback, c, hook)
        elif kind == "denied":
            _step(kind, subagents.hook_denied, c, hook)
        elif kind == "end":
            _step(kind, subagents.hook_end, c, hook)
        elif kind == "rekey":
            _step(kind, subagents.hook_rekey, c, hook)
            _step("the mirror", session.catch_up, c)
        elif kind == "mode-notice":
            _step(kind, _mode_notice, c, hook)
        elif kind in ANSWERS:
            _step(kind, ANSWERS[kind], c, hook)


def _mode_notice(c: str, hook: dict[str, Any]) -> None:
    """The `manual-mode` notice for the permission mode the mode hook reported: shown while it is Manual mode
    (modes.manual_hint), in the words of modes.manual_notice, and cleared otherwise. A dismissal holds for the workspace
    (notices.dismiss)."""
    from . import modes, notices  # noqa: PLC0415

    mode = str(hook.get("permission_mode") or "")
    if modes.manual_hint(mode):
        notices.post(c, kind="manual-mode", key="manual-mode", text=modes.manual_notice(mode))
    else:
        notices.clear(c, "manual-mode")


def _answered(what: str, c: str, slug: str, fn: Any, *args: Any) -> None:
    """A view's call (views.accept, answer_offer, retry) for the analyst's press; a press the view no longer takes (a
    second press, an answer written meanwhile: 404 or 409) is one line in the log."""
    from fastapi import HTTPException  # noqa: PLC0415

    try:
        fn(c, slug, *args)
    except HTTPException as e:
        log.warning("%s: the view %s was not %s: %s", c, slug, what, e.detail)


def _accept(c: str, body: dict[str, Any]) -> None:
    """The view proposal accepted: its build queued (views.accept), which this process follows (_busy); a refusal
    (no session, no hooks module) is written on the proposal, which the row above the prompt shows."""
    from . import views  # noqa: PLC0415

    _answered("accepted", c, str(body.get("slug") or ""), views.accept)


def _reject(c: str, body: dict[str, Any]) -> None:
    from . import views  # noqa: PLC0415

    _answered("rejected", c, str(body.get("slug") or ""), views.answer_offer, "rejected")


def _retry(c: str, body: dict[str, Any]) -> None:
    """A notice's Retry: the notice dismissed first, then the view built again (views.retry)."""
    from . import views  # noqa: PLC0415

    _fixing(c, body)
    _answered("built again", c, str(body.get("slug") or ""), views.retry)


def _propose_now(c: str, body: dict[str, Any]) -> None:
    """A notice's Try again: the notice dismissed first, then a check for a view proposal now (proposer.run_now), which
    starts its run as a task of this loop that keeps the holder busy (_busy) until it ends; a check it refuses is one
    line in the log."""
    from . import proposer  # noqa: PLC0415

    _fixing(c, body)
    got = proposer.run_now(c)
    if got.get("started") is False:
        log.warning("%s: no check for a view proposal: %s", c, got.get("reason"))


def _dismiss(c: str, body: dict[str, Any]) -> None:
    """A notice dismissed (notices.dismiss)."""
    from . import notices  # noqa: PLC0415

    notice_id = str(body.get("id") or "")
    if notice_id and not notices.dismiss(c, notice_id):
        log.warning("%s: the notice %s was not dismissed: it is gone", c, notice_id)


def _fixing(c: str, body: dict[str, Any]) -> None:
    """The notice a press of its act named (`notice`, its id) dismissed before the act runs: a failure the act meets
    again is a new notice, which this does not hide."""
    if body.get("notice"):
        _step("the notice's dismissal", _dismiss, c, {"id": body["notice"]})


def _term_page(c: str, body: dict[str, Any]) -> None:
    """A view built for the browser opened in the terminal: its terminal page's build queued (views.ensure_page), which
    this process follows (_busy)."""
    from . import views  # noqa: PLC0415

    slug = str(body.get("slug") or "")
    if slug and not views.ensure_page(c, slug, views.TERM_PAGE):
        log.warning("%s: no build of the terminal page of %s was queued: %s", c, slug,
                    views.page_ask(c, slug, views.TERM_PAGE))


# the analyst's answers that `thimble act` hands to the holder (module note), each called with the act's body
ANSWERS = {"view-accept": _accept, "view-reject": _reject, "view-retry": _retry, "view-propose-now": _propose_now,
           "view-term-page": _term_page, "notice-dismiss": _dismiss}


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
    if _served(ws):
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
