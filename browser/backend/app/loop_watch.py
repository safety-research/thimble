"""A watch on the server's event loop. When the loop goes STALL_S without a turn, server.log gets one line saying how
long it was held and where the loop's thread was meanwhile, so the log of a slow server names what held it."""
from __future__ import annotations

import asyncio
import collections
import logging
import os
import sys
import threading
import time
import traceback

log = logging.getLogger("thimble.loop")

STALL_S = 1.0  # a loop held this long gets its line
CHECK_S = 0.25  # how often the loop is asked for a turn
SAMPLE_S = 0.1  # how often the loop thread's place is taken while the loop is held
FRAMES = 4  # frames of thimble's own code a line names, besides the innermost frame
APP_DIR = os.path.dirname(os.path.abspath(__file__)) + os.sep

_stop: threading.Event | None = None


def start(loop: asyncio.AbstractEventLoop) -> None:
    """Watch `loop`, which runs on the calling thread, until stop()."""
    global _stop
    stop()
    _stop = threading.Event()
    threading.Thread(target=_watch, args=(loop, threading.get_ident(), _stop), name="thimble-loop-watch",
                     daemon=True).start()


def stop() -> None:
    if _stop is not None:
        _stop.set()


def where(frame: object) -> str:
    """A stack's innermost frame and its innermost FRAMES frames in thimble's own code, as `file:line function`,
    innermost first."""
    out: list[str] = []
    own = 0
    for f, lineno in traceback.walk_stack(frame):  # type: ignore[arg-type]
        mine = f.f_code.co_filename.startswith(APP_DIR)
        if out and not mine:
            continue
        out.append(f"{os.path.basename(f.f_code.co_filename)}:{lineno} {f.f_code.co_name}")
        own += mine
        if own >= FRAMES:
            break
    return " < ".join(out)


def _watch(loop: asyncio.AbstractEventLoop, owner: int, stopped: threading.Event) -> None:
    while not stopped.wait(CHECK_S):
        turned = threading.Event()
        t0 = time.monotonic()
        try:
            loop.call_soon_threadsafe(turned.set)
        except RuntimeError:  # the loop is closed
            return
        if turned.wait(STALL_S):
            continue
        seen: collections.Counter[str] = collections.Counter()
        while not turned.wait(SAMPLE_S) and not stopped.is_set():
            frame = sys._current_frames().get(owner)
            if frame is not None:
                seen[where(frame)] += 1
        held = time.monotonic() - t0
        top = seen.most_common(1)[0][0] if seen else "a place not sampled"
        log.warning("the event loop went %.1f s without a turn; its thread was mostly at %s", held, top)
