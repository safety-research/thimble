"""The kernels that answer view readers' calls (views._call), a few per workspace, so a slow call holds up only itself.

Each workspace has up to POOL_MAX kernels for readers, named `views`, `views-2`, ... (notebook's dedicated kernels).
A call goes to the kernel that last held its view's index (its index then stays in one kernel's memory) when that one is
free. When it is busy, a call whose index pickle is at most SMALL_INDEX bytes may load it on another free kernel, or on a
new one while the pool has room; a call whose index is larger, or still being built, waits for its own kernel. A call
has no time limit. Cancelling the task that awaits it interrupts its kernel, which takes no other call until it is idle
again (or, when the interrupt does not stop it within DRAIN_S, until it has been restarted).

Memory: each kernel keeps the indexes it uses most within memory_budget() bytes of pickles (view_host). After a call
the kernel's resident memory is read; a kernel above rss_max() that holds more than one index is restarted once free,
and while the kernels of all workspaces together hold more than total_rss_max(), the least recently used free ones are
shut down. A kernel beyond the first unused for IDLE_S is shut down, the first too when it holds more than KEEP_RSS.

A call the page names (`call`) is registered with the task that runs it, so a newer request or the page's closing can
cancel it (cancel), and its progress, which view_host writes to a file under the indexes folder, can be read (progress).
"""
from __future__ import annotations

import asyncio
import contextlib
import contextvars
import json
import logging
import os
import re
import time
from collections import OrderedDict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import procs

log = logging.getLogger("thimble.view_calls")

KERNEL = "views"  # the first kernel's name; the others are views-2, views-3, ...
POOL_MAX = 3
SMALL_INDEX = 256 * 1024 * 1024  # bytes of an index's pickle that a second kernel may load while the first is busy
NO_LIMIT_S = 1e9  # notebook._execute's limit for a call with none
DRAIN_S = 10.0  # how long an interrupted call has to stop before its kernel is restarted
IDLE_S = 600.0  # unused this long, a kernel beyond the first is shut down
KEEP_RSS = 512 * 1024 * 1024  # the first kernel is shut down when idle only above this resident size
SPARE_AFTER_S = 1.0  # a call running this long starts a spare kernel when none is free
CALL_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
PROGRESS_SUBDIR = ".calls"  # under the workspace's indexes folder: one progress file per running call


def physical_memory() -> int:
    """The machine's memory in bytes (0 when it cannot be read)."""
    try:
        return int(os.sysconf("SC_PAGE_SIZE")) * int(os.sysconf("SC_PHYS_PAGES"))
    except (AttributeError, OSError, ValueError):
        return 0


def _env_mb(name: str) -> int | None:
    try:
        v = int(os.environ.get(name, ""))
    except ValueError:
        return None
    return v * 1024 * 1024 if v > 0 else None


def memory_budget() -> int:
    """Bytes of index pickles one kernel keeps in memory: a sixteenth of the machine's memory, at least 256 MB
    (THIMBLE_VIEW_MEMORY_MB sets it)."""
    return _env_mb("THIMBLE_VIEW_MEMORY_MB") or max(256 * 1024 * 1024, physical_memory() // 16)


def rss_max() -> int:
    """The resident size above which a kernel holding several indexes is restarted: a quarter of the machine's memory
    (THIMBLE_VIEW_RSS_MB sets it)."""
    return _env_mb("THIMBLE_VIEW_RSS_MB") or max(1024 * 1024 * 1024, physical_memory() // 4)


def total_rss_max() -> int:
    """The resident size of all reader kernels together above which free ones are shut down: 40% of the machine's
    memory (THIMBLE_VIEW_TOTAL_RSS_MB sets it)."""
    return _env_mb("THIMBLE_VIEW_TOTAL_RSS_MB") or max(2 * 1024 * 1024 * 1024, physical_memory() * 2 // 5)


@dataclass
class Worker:
    c: str
    name: str
    busy: bool = False
    used: float = field(default_factory=time.monotonic)
    holds: "OrderedDict[tuple[str, str], int]" = field(default_factory=OrderedDict)  # (slug, fp) -> pickle bytes
    rss: int = 0
    restart: bool = False  # shut down once free


@dataclass
class Call:
    id: str
    c: str
    slug: str
    started: float
    progress: Path | None = None
    task: asyncio.Task | None = None
    worker: str | None = None


# the request views._call is running in this task: {slug, fp, cache, progress?}
REQUEST: contextvars.ContextVar[dict[str, Any] | None] = contextvars.ContextVar("view_request", default=None)

_pools: dict[str, list[Worker]] = {}
_affinity: dict[tuple[str, str, str], str] = {}  # (workspace, slug, fp) -> the kernel that holds or builds its index
_waiters: list[asyncio.Future] = []
_calls: dict[tuple[str, str], Call] = {}  # (workspace, call id) -> the call
_reaper: asyncio.TimerHandle | None = None


# ------------------------------------------------------------------------------------------------- the kernels' work

async def _start(c: str, name: str) -> None:
    """Start the kernel `name` of the workspace if it is not running. Tests replace it."""
    from . import notebook  # noqa: PLC0415 — the kernel machinery loads lazily

    k = notebook._kernel(c, name)
    async with k.lock:
        await notebook._ensure_started(k, c, name)


async def _exec(c: str, name: str, code: str, timeout: float) -> tuple[list[dict], str]:
    """(outputs, status) of `code` on the kernel `name`, started if need be. Tests replace it."""
    from . import notebook  # noqa: PLC0415

    k = notebook._kernel(c, name)
    async with k.lock:
        await notebook._ensure_started(k, c, name)
        outputs, _, status = await notebook._execute(k, code, timeout)
    return outputs, status


def _interrupt(c: str, name: str) -> None:
    """SIGINT to the kernel's running code. Tests replace it."""
    from . import notebook  # noqa: PLC0415

    k = notebook._kernel(c, name)
    if k.pid:
        k.interrupt()


async def _stop(c: str, name: str) -> None:
    """Shut the kernel down. Tests replace it."""
    from . import notebook  # noqa: PLC0415

    await notebook.shutdown_kernel(c, name)


def _rss(c: str, name: str) -> int:
    """The kernel's resident size in bytes, 0 when it is not running. Tests replace it."""
    from . import notebook  # noqa: PLC0415

    k = notebook._exec_kernels.get((c, name))
    return procs.rss(k.pid) if k is not None and k.pid else 0


# ----------------------------------------------------------------------------------------------------------- the pool

def _pool(c: str) -> list[Worker]:
    pool = _pools.get(c)
    if pool is None:
        pool = _pools[c] = []
    return pool


def _new_worker(c: str) -> Worker:
    pool = _pool(c)
    taken = {w.name for w in pool}
    name = next(n for n in (KERNEL, *(f"{KERNEL}-{i}" for i in range(2, POOL_MAX + 2))) if n not in taken)
    w = Worker(c, name)
    pool.append(w)
    return w


def _index_bytes(cache: str | None) -> int | None:
    """The size of the index's pickle, None when there is none yet."""
    try:
        return os.path.getsize(cache) if cache else None
    except OSError:
        return None


def _choose(c: str, slug: str, fp: str, cache: str | None) -> Worker | None:
    """The kernel this call should run on now, None to wait (module note)."""
    pool = _pool(c)
    free = [w for w in pool if not w.busy]
    key = (slug, fp)
    own = _affinity.get((c, slug, fp))
    mine = next((w for w in pool if w.name == own), None)
    if mine is not None and not mine.busy:
        return mine
    if mine is not None:
        size = _index_bytes(cache)
        holder = next((w for w in free if key in w.holds), None)
        if holder is not None:
            return holder
        if size is None or size > SMALL_INDEX:
            return None
    if free:
        return min(free, key=lambda w: (key not in w.holds, sum(w.holds.values()), -w.used))
    if len(pool) < POOL_MAX:
        return _new_worker(c)
    return None


def _wake() -> None:
    for f in _waiters:
        if not f.done():
            f.set_result(None)
    _waiters.clear()


async def _acquire(c: str, slug: str, fp: str, cache: str | None) -> Worker:
    while True:
        w = _choose(c, slug, fp, cache)
        if w is not None:
            w.busy = True
            _affinity.setdefault((c, slug, fp), w.name)
            return w
        fut = asyncio.get_running_loop().create_future()
        _waiters.append(fut)
        try:
            await fut
        finally:
            with contextlib.suppress(ValueError):
                _waiters.remove(fut)


def _release(w: Worker) -> None:
    w.busy = False
    w.used = time.monotonic()
    if w.restart:
        w.busy = True
        asyncio.get_running_loop().create_task(_shut(w), name=f"view-kernel-stop-{w.name}")
    _wake()
    _schedule_reaper()


def _forget(w: Worker) -> None:
    pool = _pools.get(w.c, [])
    if w in pool:
        pool.remove(w)
    for k in [k for k, n in _affinity.items() if k[0] == w.c and n == w.name]:
        del _affinity[k]


async def _shut(w: Worker) -> None:
    """Shut a worker's kernel down and forget it; the next call that needs a kernel starts one."""
    try:
        await _stop(w.c, w.name)
    except Exception:  # noqa: BLE001
        log.exception("%s: stopping the reader kernel %s failed", w.c, w.name)
    finally:
        _forget(w)
        _wake()


async def _drain(w: Worker) -> None:
    """After an interrupt: wait until the kernel takes a new request, restarting it when it does not within DRAIN_S."""
    try:
        outputs, _ = await _exec(w.c, w.name, "pass", DRAIN_S)
        if any(_error_name(b) in STUCK for b in outputs):
            await _stop(w.c, w.name)
            w.holds.clear()
            for k in [k for k, n in _affinity.items() if k[0] == w.c and n == w.name]:
                del _affinity[k]
    except Exception:  # noqa: BLE001
        log.exception("%s: the reader kernel %s did not settle after an interrupt", w.c, w.name)
        with contextlib.suppress(Exception):
            await _stop(w.c, w.name)
        _forget(w)
        _wake()
        return
    _release(w)


ERROR_MIME = "application/vnd.thimble.error+json"  # notebook.ERROR_MIME
STUCK = ("TimeoutError", "KernelDied", "Disconnected")  # what notebook._execute says of a kernel that did not settle


def _error_name(bundle: dict) -> str:
    err = bundle.get(ERROR_MIME)
    return str(err.get("ename") or "") if isinstance(err, dict) else ""


def _note_answer(w: Worker, outputs: list[dict]) -> None:
    """Keep what the kernel said it holds (view_host's `held`) and read its resident size."""
    from .views import _answer_from  # noqa: PLC0415 — views imports this module

    ans = _answer_from(outputs) or {}
    held = ans.get("held")
    if isinstance(held, list):
        w.holds = OrderedDict(((str(h[0]), str(h[1])), int(h[2] or 0)) for h in held
                              if isinstance(h, list) and len(h) == 3)
    with contextlib.suppress(Exception):
        w.rss = _rss(w.c, w.name)
    if w.rss > rss_max() and len(w.holds) > 1:
        w.restart = True


def _spare(c: str) -> None:
    """Start a kernel ahead when none is free and the pool has room, so the next call need not wait for one to start."""
    pool = _pool(c)
    if any(not w.busy for w in pool) or len(pool) >= POOL_MAX:
        return
    w = _new_worker(c)
    w.busy = True

    async def warm() -> None:
        try:
            await _start(c, w.name)
        except Exception:  # noqa: BLE001
            log.exception("%s: the spare reader kernel %s did not start", c, w.name)
            _forget(w)
            _wake()
            return
        _release(w)

    asyncio.get_running_loop().create_task(warm(), name=f"view-kernel-spare-{w.name}")


async def execute(c: str, code: str, timeout: float | None) -> tuple[list[dict], str]:
    """Run one reader call's code (views.snippet) on a kernel of the workspace's pool, for the request in REQUEST.
    `timeout` None is no limit. Cancelling the awaiting task interrupts the call (module note)."""
    req = REQUEST.get() or {}
    slug, fp = str(req.get("slug") or ""), str(req.get("fp") or "")
    w = await _acquire(c, slug, fp, req.get("cache"))
    call = _calls.get((c, str(req.get("call") or "")))
    if call is not None:
        call.worker = w.name
    loop = asyncio.get_running_loop()
    spare = loop.call_later(SPARE_AFTER_S, _spare, c)
    try:
        outputs, status = await _exec(c, w.name, code, NO_LIMIT_S if timeout is None else timeout)
    except asyncio.CancelledError:
        spare.cancel()
        with contextlib.suppress(Exception):
            _interrupt(c, w.name)
        loop.create_task(_drain(w), name=f"view-kernel-drain-{w.name}")
        raise
    except BaseException:
        spare.cancel()
        _release(w)
        raise
    spare.cancel()
    _note_answer(w, outputs)
    _release(w)
    _trim_total(w)
    return outputs, status


def _trim_total(current: Worker) -> None:
    """Shut down the least recently used free kernels while all of them together hold more than total_rss_max()."""
    workers = [w for pool in _pools.values() for w in pool]
    total = sum(w.rss for w in workers)
    for w in sorted((w for w in workers if not w.busy and w is not current), key=lambda w: w.used):
        if total <= total_rss_max():
            break
        total -= w.rss
        w.busy = True
        asyncio.get_running_loop().create_task(_shut(w), name=f"view-kernel-trim-{w.name}")


def _schedule_reaper() -> None:
    global _reaper
    if _reaper is not None:
        return
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    _reaper = loop.call_later(IDLE_S / 4, _reap)


def _reap() -> None:
    """Shut down kernels unused for IDLE_S (module note); runs again while any kernel is left."""
    global _reaper
    _reaper = None
    now = time.monotonic()
    for pool in list(_pools.values()):
        for w in list(pool):
            if w.busy or now - w.used < IDLE_S:
                continue
            if w.name == KERNEL and w.rss <= KEEP_RSS:
                continue
            w.busy = True
            asyncio.get_running_loop().create_task(_shut(w), name=f"view-kernel-idle-{w.name}")
    if any(pool for pool in _pools.values()):
        _schedule_reaper()


def forget_workspace(c: str) -> None:
    """The workspace's kernels were shut down elsewhere (a reset, a restore): forget them."""
    _pools.pop(c, None)
    for k in [k for k in _affinity if k[0] == c]:
        del _affinity[k]
    _wake()


def kernels(c: str) -> list[dict[str, Any]]:
    """The workspace's reader kernels: {name, busy, rss, holds: [slug/fp]}."""
    return [{"name": w.name, "busy": w.busy, "rss": w.rss, "holds": [f"{s}/{f}" for s, f in w.holds]}
            for w in _pools.get(c, [])]


# ---------------------------------------------------------------------------------------------- calls a page can name

def call_id(v: Any) -> str | None:
    """A page's call id, or None for one that is not a short word."""
    return v if isinstance(v, str) and CALL_ID_RE.match(v) else None


def progress_path(indexes: Path, cid: str) -> Path:
    return indexes / PROGRESS_SUBDIR / f"{cid}.json"


def begin(c: str, slug: str, cid: str | None, indexes: Path) -> Call | None:
    """Register the page's call `cid` (None for a call it did not name), with the file its progress goes to."""
    if not cid:
        return None
    path = progress_path(indexes, cid)
    with contextlib.suppress(OSError):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.unlink(missing_ok=True)
    call = Call(cid, c, slug, time.monotonic(), path, asyncio.current_task())
    _calls[(c, cid)] = call
    return call


def end(call: Call | None) -> None:
    if call is None:
        return
    if _calls.get((call.c, call.id)) is call:
        del _calls[(call.c, call.id)]
    if call.progress is not None:
        with contextlib.suppress(OSError):
            call.progress.unlink(missing_ok=True)


def cancel(c: str, cid: str) -> bool:
    """Cancel the page's call `cid`; False when no such call runs."""
    call = _calls.get((c, cid))
    if call is None or call.task is None or call.task.done():
        return False
    call.task.cancel()
    return True


def progress(c: str, cid: str) -> dict[str, Any] | None:
    """{running: true, seconds, phase, done?, total?, note?} of the page's call `cid`, None when no such call runs. The
    seconds are those since it started; the rest is what its kernel wrote (view_host)."""
    call = _calls.get((c, cid))
    if call is None:
        return None
    out: dict[str, Any] = {"running": True, "seconds": round(time.monotonic() - call.started, 1), "phase": "wait"}
    if call.worker is not None:
        out["phase"] = "call"
    if call.progress is not None:
        with contextlib.suppress(OSError, ValueError):
            raw = json.loads(call.progress.read_text("utf-8"))
            if isinstance(raw, dict):
                for k in ("phase", "note"):
                    if isinstance(raw.get(k), str):
                        out[k] = raw[k][:120]
                for k in ("done", "total"):
                    if isinstance(raw.get(k), (int, float)) and not isinstance(raw.get(k), bool):
                        out[k] = raw[k]
    return out
