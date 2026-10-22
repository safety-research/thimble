"""The kernels that answer view readers' calls (views._call), a few per workspace, so a slow call holds up only itself.

Each workspace has up to POOL_MAX kernels for readers, named `views`, `views-2`, ... (notebook's dedicated kernels).
A call goes to the kernel that last held its view's index (its index then stays in one kernel's memory) when that one
is free. When it is busy, a call whose index pickle is at most SMALL_INDEX bytes may load it on another free kernel, or
on a new one while the pool has room; a call whose index is larger, or still being built, waits for its own kernel. A
call that needs no index (a card type's applies) runs on any free kernel. A call has no time limit. Cancelling the task
that awaits it interrupts its kernel, which takes no other call until it is idle again (or, when the interrupt does not
stop it within DRAIN_S, until it has been restarted).

Memory: each kernel keeps the indexes it uses most within memory_budget() bytes (view_host, which counts an index by
what loading or building it took). After a call the resident memory of the kernel's process is read (under a sandbox
wrapper, of the Python process inside it). A kernel above rss_max() is restarted once free when it holds more than one
index or more than KEEP_FACTOR times what its indexes take, unless one of them has no pickle (a restart would build it
again). While the kernels of all workspaces together hold more than total_rss_max(), the least recently used free ones
are shut down. A kernel beyond the first unused for IDLE_S is shut down, the first too when it holds more than
KEEP_RSS, and one that holds an index of a deleted view once it is free (forget_view). The limits are shares of the
machine's memory within fixed bounds, so a large machine does not let the views' kernels take tens of gigabytes.

A call the page names (`call`) is registered with the task that runs it, so a newer request or the page's closing can
cancel it (cancel), and its progress, which view_host writes to a file under the indexes folder, can be read (progress).
A cancel that comes before its call is registered (the page dropped a fetch whose request was still on its way) is kept
for CANCELLED_S, and that call is refused when it comes (cancelled_before).
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
KERNEL_BASE = 256 * 1024 * 1024  # a reader kernel's resident size before it holds any index
KEEP_FACTOR = 1.5  # a kernel above rss_max() holding more than this times its indexes' bytes is restarted
MB = 1024 * 1024
SPARE_AFTER_S = 1.0  # a call running this long starts a spare kernel when none is free
SPARE_BACKOFF_S = 5.0  # after a spare kernel did not start, none is started for this long, doubled at each failure
SPARE_BACKOFF_MAX_S = 300.0  # in a row up to this; a start that works ends the wait
CALL_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
CANCELLED_S = 60.0  # how long a cancel that came before its call is kept
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


def _share(part: int, low: int, high: int) -> int:
    """`part`ths of the machine's memory, within [low, high] MB."""
    return min(max(physical_memory() // part, low * MB), high * MB)


def memory_budget() -> int:
    """Bytes of indexes one kernel keeps in memory: a sixteenth of the machine's memory, from 256 MB to 2 GB
    (THIMBLE_VIEW_MEMORY_MB sets it)."""
    return _env_mb("THIMBLE_VIEW_MEMORY_MB") or _share(16, 256, 2048)


def rss_max() -> int:
    """The resident size above which a kernel may be restarted (module note): an eighth of the machine's memory, from
    1 GB to 6 GB (THIMBLE_VIEW_RSS_MB sets it)."""
    return _env_mb("THIMBLE_VIEW_RSS_MB") or _share(8, 1024, 6144)


def total_rss_max() -> int:
    """The resident size of all reader kernels together above which free ones are shut down: a quarter of the
    machine's memory, from 2 GB to 12 GB (THIMBLE_VIEW_TOTAL_RSS_MB sets it)."""
    return _env_mb("THIMBLE_VIEW_TOTAL_RSS_MB") or _share(4, 2048, 12288)


@dataclass
class Worker:
    c: str
    name: str
    busy: bool = False
    used: float = field(default_factory=time.monotonic)
    holds: "OrderedDict[tuple[str, str], int]" = field(default_factory=OrderedDict)  # (slug, fp) -> bytes it takes
    rss: int = 0
    restart: bool = False  # shut down once free
    unpickled: bool = False  # holds an index with no pickle, which only a build would bring back


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
_cancelled: dict[tuple[str, str], float] = {}  # (workspace, call id) -> when a cancel came for a call not yet registered
_reaper: "tuple[asyncio.AbstractEventLoop, asyncio.TimerHandle] | None" = None


@dataclass
class Failing:
    """A workspace's spare kernels that did not start: how many in a row, until when none is started, and the last
    error."""
    n: int
    until: float
    error: str


_spare_failed: dict[str, Failing] = {}  # workspace -> its spare kernels' failures in a row (_spare)


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


_inner: dict[int, int] = {}  # the pid a kernel was started as -> the pid of its Python process


def _kernel_process(pid: int) -> int:
    """The kernel's Python process among `pid` and its descendants: the first, nearest `pid`, started as
    `python -m ipykernel_launcher` (a process it forked has the same command line, further down), else the largest
    descendant, else `pid`."""
    tree = [pid, *procs.descendants(pid)]
    for p in tree:
        a = procs.argv(p)
        if len(a) > 2 and a[1:3] == ["-m", "ipykernel_launcher"]:
            return p
    return max(tree[1:], key=procs.rss) if len(tree) > 1 else pid


def _rss(c: str, name: str) -> int:
    """The resident size in bytes of the kernel's Python process, 0 when it is not running. Under a sandbox wrapper the
    process started is the wrapper, so the Python process is found inside it (once, _kernel_process). Tests replace
    it."""
    from . import notebook  # noqa: PLC0415

    k = notebook._exec_kernels.get((c, name))
    if k is None or not k.pid:
        return 0
    inner = _inner.get(k.pid)
    if inner is None or not procs.alive(inner):
        inner = _kernel_process(k.pid)
        for p in [p for p in _inner if not procs.alive(p)]:
            del _inner[p]
        _inner[k.pid] = inner
    return procs.rss(inner) or procs.rss(k.pid)


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
        holder = next((w for w in free if key in w.holds), None)
        if holder is not None:
            return holder
        size = _index_bytes(cache)
        if cache and (size is None or size > SMALL_INDEX):
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

    ans = _answer_from(outputs, raw=True)  # the result left unread
    if ans is None and any(_error_name(b) in STUCK for b in outputs):
        w.holds.clear()  # the kernel died or did not settle, and holds nothing now
    ans = ans or {}
    held = ans.get("held")
    if isinstance(held, list):
        w.holds = OrderedDict(((str(h[0]), str(h[1])), int(h[2] or 0)) for h in held
                              if isinstance(h, list) and len(h) == 3)
        w.unpickled = bool(ans.get("unpickled"))
    with contextlib.suppress(Exception):
        w.rss = _rss(w.c, w.name)
    if w.rss > rss_max() and not w.unpickled and not w.restart and \
            (len(w.holds) > 1 or w.rss > KERNEL_BASE + KEEP_FACTOR * sum(w.holds.values())):
        w.restart = True
        log.info("%s: the reader kernel %s holds %d MB, its %d index(es) %d MB; it is restarted once free", w.c, w.name,
                 w.rss // MB, len(w.holds), sum(w.holds.values()) // MB)


def _workspace_gone(c: str) -> bool:
    """Whether the workspace's corpus is no longer registered or its folder is gone (config.corpus_dir), so no kernel of
    it can start; False while that cannot be read (a process out of file descriptors). Tests replace it."""
    from . import config  # noqa: PLC0415

    try:
        config.corpus_dir(c)
    except ValueError:
        return True
    except OSError:
        return False
    return False


def _spare(c: str) -> None:
    """Start a kernel ahead when none is free and the pool has room, so the next call need not wait for one to start.
    After a spare did not start, none is started for SPARE_BACKOFF_S, doubled at each failure in a row up to
    SPARE_BACKOFF_MAX_S, and the log says so once (_spare_failure). A workspace that is gone gets none, and its kernels
    are shut down."""
    pool = _pool(c)
    if any(not w.busy for w in pool) or len(pool) >= POOL_MAX:
        return
    failing = _spare_failed.get(c)
    if failing is not None and time.monotonic() < failing.until:
        return
    if _workspace_gone(c):
        _drop_gone(c)
        return
    w = _new_worker(c)
    w.busy = True

    async def warm() -> None:
        try:
            await _start(c, w.name)
        except Exception as e:  # noqa: BLE001
            _forget(w)
            _wake()
            _spare_failure(c, w.name, e)
            return
        if w not in _pools.get(c, []):  # the workspace's kernels were forgotten while this one started
            with contextlib.suppress(Exception):
                await _stop(c, w.name)
            return
        done = _spare_failed.pop(c, None)
        if done is not None:
            log.info("%s: the spare reader kernel %s started after %d that did not", c, w.name, done.n)
        _release(w)

    asyncio.get_running_loop().create_task(warm(), name=f"view-kernel-spare-{w.name}")


def _spare_failure(c: str, name: str, e: BaseException) -> None:
    """A spare kernel of the workspace did not start: wait longer before the next (_spare). The first failure is logged
    with its traceback, a later one only when its error differs from the one before."""
    if _workspace_gone(c):
        _drop_gone(c)
        return
    prev = _spare_failed.get(c)
    n = prev.n + 1 if prev is not None else 1
    wait = min(SPARE_BACKOFF_MAX_S, SPARE_BACKOFF_S * 2 ** (n - 1))
    error = f"{type(e).__name__}: {e}"
    _spare_failed[c] = Failing(n, time.monotonic() + wait, error)
    if prev is None or prev.error != error:
        log.warning("%s: the spare reader kernel %s did not start (%s); the next spare waits %.0f s, longer while they "
                    "keep failing", c, name, error, wait, exc_info=(type(e), e, e.__traceback__) if prev is None else None)
    else:
        log.debug("%s: the spare reader kernel %s did not start again (%d in a row); the next waits %.0f s", c, name, n,
                  wait)


def _drop_gone(c: str) -> None:
    """The workspace is gone: its kernels shut down and its pool and state forgotten (notebook.shutdown_workspace)."""
    log.info("%s: the workspace is gone, so its reader kernels are shut down and no spare is started", c)
    forget_workspace(c)

    async def stop() -> None:
        from . import notebook  # noqa: PLC0415

        try:
            await notebook.shutdown_workspace(c)
        except Exception:  # noqa: BLE001
            log.exception("%s: shutting down the kernels of a workspace that is gone failed", c)

    asyncio.get_running_loop().create_task(stop(), name=f"view-kernels-gone-{c}")


async def execute(c: str, code: str, timeout: float | None) -> tuple[list[dict], str]:
    """Run one reader call's code (views.snippet) on a kernel of the workspace's pool, for the request in REQUEST.
    `timeout` None is no limit; a call past its limit is interrupted, and its kernel takes no other call until it is
    idle again, as after a cancel. Cancelling the awaiting task interrupts the call (module note)."""
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
    if any(_error_name(b) in STUCK for b in outputs):
        loop.create_task(_drain(w), name=f"view-kernel-drain-{w.name}")  # interrupted at its limit, or gone
    else:
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
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    if _reaper is not None and _reaper[0] is loop:
        return
    _reaper = (loop, loop.call_later(IDLE_S / 4, _reap))


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


def forget_view(c: str, slug: str) -> None:
    """The view `slug` was deleted: a kernel that holds one of its indexes is shut down once free, since only a new
    process gives that memory back; the next call starts another."""
    for k in [k for k in _affinity if k[0] == c and k[1] == slug]:
        del _affinity[k]
    for w in list(_pools.get(c, [])):
        if not any(k[0] == slug for k in w.holds):
            continue
        w.restart = True
        if w.busy:
            continue  # shut down when its call ends (_release)
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            continue  # shut down after its next call
        w.busy = True
        loop.create_task(_shut(w), name=f"view-kernel-deleted-{w.name}")


def forget_workspace(c: str) -> None:
    """The workspace's kernels were shut down elsewhere (notebook.shutdown_workspace: a reset, a restore, a removal):
    forget them, and the spare kernels that did not start."""
    _pools.pop(c, None)
    _spare_failed.pop(c, None)
    for k in [k for k in _affinity if k[0] == c]:
        del _affinity[k]
    _wake()


def registered(c: str) -> None:
    """The workspace's folder was registered (again): a spare kernel that did not start is tried at the next slow call."""
    _spare_failed.pop(c, None)


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
    """Cancel the page's call `cid`; False when no such call runs, which is then refused should it come within
    CANCELLED_S."""
    call = _calls.get((c, cid))
    if call is None or call.task is None or call.task.done():
        if call is None:
            now = time.monotonic()
            for k in [k for k, at in _cancelled.items() if now - at > CANCELLED_S]:
                del _cancelled[k]
            _cancelled[(c, cid)] = now
        return False
    call.task.cancel()
    return True


def cancelled_before(c: str, cid: str | None) -> bool:
    """Whether the page cancelled its call `cid` before the call came (cancel)."""
    at = _cancelled.pop((c, cid), None) if cid else None
    return at is not None and time.monotonic() - at <= CANCELLED_S


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
