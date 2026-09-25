"""The job queue: one in-process `asyncio.Queue` with JOB_WORKERS consumers (THIMBLE_JOB_WORKERS, default 12) and no
persistence. Jobs are derived from state, so a restart rescans (the `on_start` functions) instead of replaying a log.

A job is `(kind, target, version)` plus a zero-argument coroutine function. `enqueue` answers False when the same key is
queued, running or terminal, so an unchanged target is never checked twice and a failed one is not retried until it
changes. A job gets ATTEMPTS tries; then it is `failed`, its owner is told through `on_failed`, and the workspace stream
gets a `job` failed event.

Jobs run on the event loop as their own tasks. `enqueue` from a worker thread hands the job to the loop; with no loop
the job is dropped and the next start's rescan derives it. Including the router starts the workers via its lifespan.
"""
from __future__ import annotations

import asyncio
import logging
import os
import re
from collections import OrderedDict
from collections.abc import Awaitable, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter

from . import capture

log = logging.getLogger("thimble.jobs")


@asynccontextmanager
async def _lifespan(app):
    """The router's lifespan, which FastAPI merges into the app's when the router is included, so the workers start at
    server start with no wiring in main.py; `shutdown()` is idempotent."""
    await start()
    try:
        yield
    finally:
        await shutdown()


router = APIRouter(lifespan=_lifespan)

DEFAULT_JOB_WORKERS = 12


def configured_workers() -> int:
    """THIMBLE_JOB_WORKERS as an integer of at least 1; anything else is the default with a log line."""
    raw = os.environ.get("THIMBLE_JOB_WORKERS", "").strip()
    if not raw:
        return DEFAULT_JOB_WORKERS
    try:
        n = int(raw)
    except ValueError:
        n = 0
    if n < 1:
        log.warning("THIMBLE_JOB_WORKERS=%r is not a positive integer; using %d", raw, DEFAULT_JOB_WORKERS)
        return DEFAULT_JOB_WORKERS
    return n


JOB_WORKERS = configured_workers()
ATTEMPTS = 2
TERMINAL_MAX = 4000  # done/failed keys remembered in this process (the dedupe of "terminal"); the oldest are forgotten

Fn = Callable[[], Awaitable[Any]]


def _class_of(e: BaseException) -> str:
    """The failure's short class token for the `job` event: the exception's `job_class` when it carries one, else its
    type name in snake case (RuntimeError → runtime_error)."""
    tok = getattr(e, "job_class", None)
    if isinstance(tok, str) and tok.strip():
        return tok.strip()
    return re.sub(r"(?<!^)(?=[A-Z])", "_", type(e).__name__).lower()


@dataclass
class Job:
    kind: str
    target: str
    version: str
    fn: Fn
    workspace: str | None = None
    on_failed: Callable[[str], Any] | None = None
    status: str = "queued"  # queued | running | done | failed | cancelled (a workspace reset)
    attempt: int = 0
    note: str = ""
    cls: str = ""  # the last failure's class token (_class_of); on the job event and in public()
    queued_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat(timespec="seconds"))
    task: asyncio.Task | None = None

    @property
    def key(self) -> tuple[str, str, str]:
        return (self.kind, self.target, self.version)

    def public(self) -> dict[str, Any]:
        return {"kind": self.kind, "target": self.target, "version": self.version, "status": self.status,
                "attempts": self.attempt, "note": self.note, "class": self.cls, "workspace": self.workspace,
                "queued_at": self.queued_at}


_queue: asyncio.Queue[Job] | None = None
_active: dict[tuple[str, str, str], Job] = {}  # queued or running
_terminal: OrderedDict[tuple[str, str, str], Job] = OrderedDict()  # done or failed, bounded
_workers: list[asyncio.Task] = []
_loop: asyncio.AbstractEventLoop | None = None
_started = False
_on_start: list[Callable[[], Any]] = []


# ----------------------------------------------------------------------------------------------------------
# the contract
# ----------------------------------------------------------------------------------------------------------


def enqueue(kind: str, target: str, version: str, fn: Fn, *, workspace: str | None = None,
            on_failed: Callable[[str], Any] | None = None) -> bool:
    """Queue `fn` under the key (kind, target, version). False when that key is already queued, running or terminal
    (done or failed in this process), or when no event loop exists to run it. `workspace` names the workspace whose
    stream gets the job's `failed` event; `on_failed(note)` is called once when the last attempt fails."""
    key = (kind, str(target), str(version))
    if key in _active or key in _terminal:
        return False
    job = Job(kind, str(target), str(version), fn, workspace, on_failed)
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        if _loop is None or _loop.is_closed():
            log.info("job %s/%s@%s not queued: no event loop (the rescan at start derives it)", kind, target, version)
            return False
        _loop.call_soon_threadsafe(_admit, job)
        return True
    _admit(job)
    return True


def status(target: str) -> dict[str, Any]:
    """{status, attempts, note} of the newest job for `target`: a queued or running one first, else the latest
    terminal one; {status: 'none', attempts: 0, note: ''} for a target no job in this process has touched."""
    live = [j for j in _active.values() if j.target == target]
    if live:
        j = max(live, key=lambda x: x.queued_at)
        return {"status": j.status, "attempts": j.attempt, "note": j.note}
    done = [j for j in _terminal.values() if j.target == target]
    if done:
        j = done[-1]
        return {"status": j.status, "attempts": j.attempt, "note": j.note}
    return {"status": "none", "attempts": 0, "note": ""}


def on_start(fn: Callable[[], Any]) -> None:
    """Register a rescan (sync or async, no arguments) that `start()` runs once the workers are up, deriving pending
    jobs from state."""
    if fn not in _on_start:
        _on_start.append(fn)


async def start() -> None:
    """Start the workers and run every registered rescan. Idempotent; needs a running loop (the lifespan). The worker
    count is read from the environment here, so the value at server start is the one that runs."""
    global _started, JOB_WORKERS
    JOB_WORKERS = configured_workers()
    _ensure_workers()
    if _started:
        return
    _started = True
    for fn in list(_on_start):
        try:
            out = fn()
            if asyncio.iscoroutine(out):
                await out
        except Exception:  # noqa: BLE001 — a rescan that fails leaves its targets for the next enqueue
            log.exception("job rescan %s failed", getattr(fn, "__name__", fn))


async def shutdown() -> None:
    """Lifespan shutdown: cancel the running jobs and the workers; the queue is dropped (jobs come back from state)."""
    global _queue, _loop, _started
    for j in list(_active.values()):
        if j.task is not None and not j.task.done():
            j.task.cancel()
    for w in _workers:
        w.cancel()
    for w in _workers:
        try:
            await w
        except (asyncio.CancelledError, Exception):  # noqa: BLE001
            pass
    _workers.clear()
    _active.clear()
    _queue = _loop = None
    _started = False


def snapshot(workspace: str | None = None) -> dict[str, Any]:
    """The queue as the routes show it: depth (queued), running, workers, and the live jobs (a workspace narrows to its
    own jobs, those enqueued with `workspace=c` or whose target is `c`)."""
    live = [j for j in _active.values() if workspace is None or j.workspace == workspace or j.target == workspace]
    return {"depth": sum(1 for j in live if j.status == "queued"),
            "running": sum(1 for j in live if j.status == "running"),
            "workers": len(_workers),
            "jobs": [j.public() for j in live]}


def reset_for_tests() -> None:
    """Forget every job and the terminal memory (tests only; the workers are left to `shutdown`)."""
    _active.clear()
    _terminal.clear()
    _on_start.clear()


# ----------------------------------------------------------------------------------------------------------
# the machinery
# ----------------------------------------------------------------------------------------------------------


def _admit(job: Job) -> None:
    """On the loop: register, queue, make sure workers run."""
    if job.key in _active or job.key in _terminal:
        return
    _ensure_workers()
    assert _queue is not None
    _active[job.key] = job
    _queue.put_nowait(job)


def cancel_workspace(c: str) -> list[str]:
    """Drop the queued or running jobs of workspace `c` (ledger.reset_workspace), so no job writes into the directory
    the reset removes. Returns the kinds dropped."""
    out: list[str] = []
    for job in [j for j in _active.values() if j.workspace == c or j.target == c]:
        job.status = "cancelled"
        job.note = "cancelled: the workspace was reset"
        _active.pop(job.key, None)
        if job.task is not None and not job.task.done():
            job.task.cancel()
        log.info("job %s/%s@%s cancelled: workspace %s reset", job.kind, job.target, job.version, c)
        out.append(job.kind)
    return out


def _ensure_workers() -> None:
    global _queue, _loop
    loop = asyncio.get_running_loop()
    if _loop is not None and _loop is not loop:  # a new loop (tests): the old workers died with their loop
        _workers.clear()
        _queue = None
    _loop = loop
    if _queue is None:
        _queue = asyncio.Queue()
    alive = [w for w in _workers if not w.done()]
    while len(alive) < JOB_WORKERS:
        alive.append(loop.create_task(_worker(len(alive)), name=f"thimble-job-worker-{len(alive)}"))
    _workers[:] = alive


async def _worker(n: int) -> None:
    assert _queue is not None
    while True:
        job = await _queue.get()
        try:
            if job.status != "queued":  # cancelled while waiting
                continue
            job.task = asyncio.get_running_loop().create_task(_run(job), name=f"thimble-job-{job.kind}")
            try:
                await job.task
            except asyncio.CancelledError:
                me = asyncio.current_task()
                if me is not None and me.cancelling():
                    raise  # the worker itself was cancelled (shutdown)
                # else: the job's own task was cancelled (a workspace reset); this worker goes on
            except Exception:  # noqa: BLE001 — _run reports; a worker never dies of a job
                log.exception("job worker %d: unexpected error", n)
        finally:
            _queue.task_done()


async def _run(job: Job) -> None:
    job.status = "running"
    job.attempt += 1
    capture.reset()  # a job names its own calls (capture.scope); the enqueuing code's scope must not carry over
    try:
        await job.fn()
    except asyncio.CancelledError:
        if job.status == "cancelled":  # its workspace was reset
            return
        raise
    except Exception as e:  # noqa: BLE001
        note = f"{type(e).__name__}: {e}".strip(": ")
        job.cls = _class_of(e)
        if job.attempt < ATTEMPTS:
            log.info("job %s/%s@%s attempt %d failed: %s; retrying", job.kind, job.target, job.version, job.attempt, note)
            job.status = "queued"
            if _queue is not None:
                _queue.put_nowait(job)
            return
        log.warning("job %s/%s@%s failed after %d attempts: %s", job.kind, job.target, job.version, job.attempt, note)
        await _fail(job, note)
    else:
        job.status = "done"
        job.cls = ""
        _retire(job)


async def _fail(job: Job, note: str) -> None:
    """The job is `failed` with the note: retired, its owner told through `on_failed`, and the `failed` event emitted
    with the attempt and class."""
    job.status = "failed"
    job.note = note
    _retire(job)
    if job.on_failed is not None:
        try:
            out = job.on_failed(note)
            if asyncio.iscoroutine(out):
                await out
        except Exception:  # noqa: BLE001
            log.exception("job %s/%s: on_failed raised", job.kind, job.target)
    _emit(job, {"type": "job", "status": "failed", "key": list(job.key), "note": note})


def _retire(job: Job) -> None:
    _active.pop(job.key, None)
    _terminal[job.key] = job
    while len(_terminal) > TERMINAL_MAX:
        _terminal.popitem(last=False)


def _emit(job: Job, event: dict[str, Any]) -> None:
    """A `job` event onto the workspace stream of the job's workspace (its target, for a job keyed by workspace), with
    the attempts spent and `class`, the cause's short token (_class_of)."""
    c = job.workspace or job.target
    event = {**event, "attempt": job.attempt, "class": event.get("class") or job.cls or None}
    try:
        from . import config, investigation
        config.corpus_dir(c)  # a target that is not a workspace name: nothing to emit onto
        investigation.emit(c, "main", event)
    except Exception:  # noqa: BLE001 — the stream is a convenience; the job's state is on its target
        log.debug("job event for %s not emitted", c, exc_info=True)


# ----------------------------------------------------------------------------------------------------------
# routes
# ----------------------------------------------------------------------------------------------------------


@router.get("/jobs")
async def jobs_route() -> dict[str, Any]:
    return snapshot()


@router.get("/ws/{c}/jobs")
async def workspace_jobs_route(c: str) -> dict[str, Any]:
    return snapshot(c)
