"""The server's freed memory given back to the system.

glibc's malloc keeps what Python frees, for reuse: the bytes of a big file read for a page, a transcript parsed for the
Transcript mode, a label's rows. Each thread that did such work keeps an arena of its own at its high-water mark, so the
resident size of a server that opened big files climbs with each one and never comes down (bug hunt round 2: 125 MB to
787 MB in an hour on a 12 GB corpus; in a session driven the same way the objects Python held stayed under 100 MB).
Three settings keep it near what is in use:

- arenas: at the start malloc is told to make at most ARENAS arenas (mallopt M_ARENA_MAX), so the many worker threads
  of a busy server share a few heaps rather than each keeping one;
- big blocks: a block of MMAP_THRESHOLD bytes or more is mapped on its own and unmapped when freed (M_MMAP_THRESHOLD),
  where malloc would otherwise raise that threshold to the size of the last big block freed and keep such blocks;
- trim: a watch thread calls malloc_trim(0), which gives the free pages inside every arena back to the system, every
  CHECK_S while the resident size is GROWTH bytes or more above the least it came to after a trim (a trim takes about
  a millisecond, 20 ms when it gives back a few hundred MB).

With a C library that has neither call (macOS, musl) nothing is done; THIMBLE_HEAP_TRIM=0 turns all three off.
"""
from __future__ import annotations

import ctypes
import logging
import os
import threading
import time
from typing import Any

log = logging.getLogger("thimble.heap")

ARENAS = 2  # malloc arenas at most (mallopt M_ARENA_MAX)
MMAP_THRESHOLD = 1024 * 1024  # a block this large or larger is mapped on its own (mallopt M_MMAP_THRESHOLD)
CHECK_S = 30.0  # how often the watch reads the resident size
GROWTH = 32 * 1024 * 1024  # bytes above the least resident size after a trim that call for the next one
M_ARENA_MAX, M_MMAP_THRESHOLD = -8, -3  # glibc's mallopt parameters

_stop: threading.Event | None = None


def _libc() -> Any:
    """The C library with malloc_trim and mallopt (glibc), else None."""
    try:
        lib = ctypes.CDLL(None)
        lib.malloc_trim.argtypes, lib.malloc_trim.restype = [ctypes.c_size_t], ctypes.c_int
        lib.mallopt.argtypes, lib.mallopt.restype = [ctypes.c_int, ctypes.c_int], ctypes.c_int
    except (OSError, AttributeError, TypeError):
        return None
    return lib


def rss() -> int:
    """This process's resident size in bytes, 0 when /proc cannot tell."""
    try:
        with open("/proc/self/statm", "rb") as f:
            return int(f.read().split()[1]) * os.sysconf("SC_PAGE_SIZE")
    except (OSError, ValueError, IndexError):
        return 0


def trim() -> int:
    """malloc_trim(0) now: the bytes the resident size fell by (0 when there is no malloc_trim)."""
    lib = _libc()
    if lib is None:
        return 0
    before = rss()
    lib.malloc_trim(0)
    return max(0, before - rss())


def start() -> bool:
    """Set malloc's arenas and big-block threshold and start the watch thread, until stop(); False when this C library
    has no malloc_trim or THIMBLE_HEAP_TRIM is 0."""
    global _stop
    stop()
    lib = _libc()
    if lib is None or os.environ.get("THIMBLE_HEAP_TRIM", "").strip() == "0":
        return False
    lib.mallopt(M_ARENA_MAX, ARENAS)
    lib.mallopt(M_MMAP_THRESHOLD, MMAP_THRESHOLD)
    _stop = threading.Event()
    threading.Thread(target=_watch, args=(_stop,), name="thimble-heap-trim", daemon=True).start()
    return True


def stop() -> None:
    if _stop is not None:
        _stop.set()


def _watch(stopped: threading.Event) -> None:
    """Trim every CHECK_S while the resident size is GROWTH above `floor`, the least it came to after a trim (at first,
    at the start). The floor is never raised: a trim made while a request held much memory would otherwise set it high
    and leave what that request freed for good."""
    floor = rss()
    while not stopped.wait(CHECK_S):
        if rss() - floor < GROWTH:
            continue
        t0 = time.monotonic()
        try:
            freed = trim()
        except Exception:  # noqa: BLE001 — the server runs on with what malloc keeps
            log.debug("malloc_trim failed", exc_info=True)
            continue
        after = rss()
        floor = min(floor, after)
        log.debug("malloc_trim gave back %d MB in %.0f ms (resident %d MB)", freed >> 20,
                  (time.monotonic() - t0) * 1000, after >> 20)
