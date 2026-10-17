"""app.heap: the server's freed memory goes back to the system (malloc_trim), and nothing is done without glibc."""
from __future__ import annotations

import sys
import threading
import time

import pytest

from app import heap

glibc = pytest.mark.skipif(heap._libc() is None, reason="this C library has no malloc_trim (glibc only)")


@glibc
def test_a_trim_gives_back_what_python_freed_inside_the_heap():
    """Buffers freed between ones still held leave free pages inside the heap, which malloc keeps until a trim."""
    chunks = [bytearray(64 * 1024) for _ in range(2048)]  # 128 MB in chunks under the mmap threshold, in the heap
    for b in chunks:
        b[0] = 1
    held = chunks[::32]  # one chunk in 32 still held, so the heap cannot shrink from its top
    del chunks, b
    before = heap.rss()
    freed = heap.trim()
    after = heap.rss()
    assert before - after >= 64 * 1024 * 1024, f"the trim gave back {(before - after) >> 20} MB of ~124 MB freed"
    assert freed > 0 and len(held) == 64


def test_the_watch_trims_while_the_resident_size_is_growth_above_its_floor(monkeypatch):
    """A trim made while a request held memory leaves the resident size high; the floor stays where it was, so the next
    check trims again once that memory is free, rather than taking the high mark as the new floor."""
    g = heap.GROWTH
    # the start, check 1, after trim 1 (a request still holds its memory), check 2, after trim 2, check 3
    sizes = iter([100, 100 + g, 100 + g + 5, 100 + g + 5, 110, 110])
    trims: list[int] = []
    done = threading.Event()

    def rss() -> int:
        try:
            return next(sizes)
        except StopIteration:
            done.set()
            return 110

    monkeypatch.setattr(heap, "rss", rss)
    monkeypatch.setattr(heap, "trim", lambda: trims.append(1) or 0)
    monkeypatch.setattr(heap, "CHECK_S", 0.01)
    stop = threading.Event()
    t = threading.Thread(target=heap._watch, args=(stop,), daemon=True)
    t.start()
    assert done.wait(5)
    stop.set()
    t.join(5)
    assert len(trims) == 2, "checks 1 and 2 trim (GROWTH above the floor of 100); check 3, at 110, does not"


def test_nothing_is_done_without_malloc_trim_or_when_turned_off(monkeypatch):
    monkeypatch.setattr(heap, "_libc", lambda: None)
    assert heap.start() is False
    assert heap.trim() == 0
    monkeypatch.undo()
    monkeypatch.setenv("THIMBLE_HEAP_TRIM", "0")
    started = threading.active_count()
    assert heap.start() is False
    time.sleep(0.05)
    assert threading.active_count() == started


@pytest.mark.skipif(not sys.platform.startswith("linux"), reason="/proc/self/statm")
def test_rss_reads_this_process():
    assert heap.rss() > 1024 * 1024
