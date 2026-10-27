"""thimble fix done (engine/kernel/fixes.py) at the edges of the runner that tests a fixer's change: a done that only
waits works from any session, and two checks at once start one run, the second waiting no longer than its limit. The
world is test_fixes.py's made-up thimble 0.10.2; slow tests are made with THIMBLE_FIX_TESTS. All data here is made up."""
from __future__ import annotations

import fcntl
import os
import sys
import threading
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_fixes import FX, made, world  # noqa: E402, F401  (world is the fixture)


def runner_gone(fid: int) -> None:
    """Once the runner of the fix's tests ended: the lock it holds while it lives is free."""
    fd = os.open(FX.home() / "tests" / f"{fid}.lock", os.O_RDWR)
    try:
        for _ in range(600):
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                return
            except BlockingIOError:
                time.sleep(0.05)
        raise AssertionError("the runner never ended")
    finally:
        os.close(fd)


def test_a_done_that_only_waits_for_the_tests_works_from_any_session(world, monkeypatch):
    monkeypatch.setenv("THIMBLE_FIX_TESTS", "sleep 1")
    r = FX.new("say read, not coverage", session="s-made-up-1")
    p = Path(r["work"]) / "plugin" / "bar" / "bar.tsx"
    p.write_text(p.read_text().replace("coverage", "read"))
    assert FX.done(r["id"], "Bar says read", "", session="s-made-up-1", within=0.2)["testing"]
    # /clear gave the session a new id while it waits: it waits on, and gets what came of the tests
    got = FX.done(r["id"], session="s-made-up-2", within=30)
    assert got["state"] == "ready" and got["title"] == "Bar says read"
    assert FX.done(r["id"], session="s-made-up-3", within=30)["state"] == "ready"
    # a done that would check a change is still the fixer's session's alone
    s = FX.new("a note", session="s-made-up-1")
    with pytest.raises(FX.FixError, match="another Claude Code session"):
        FX.done(s["id"], session="s-made-up-2", within=30)
    assert FX.get(s["id"])["state"] == "working"


def test_two_checks_at_once_start_one_run_and_the_second_waits_no_longer_than_its_limit(world, monkeypatch, tmp_path):
    runs = tmp_path / "runs.log"
    monkeypatch.setenv("THIMBLE_FIX_TESTS", f"echo run >> {runs}; sleep 3")
    r = made(world)
    real = FX._tests_argv
    first_in, second_in = threading.Event(), threading.Event()

    def argv(fid):
        # both checks read the fix while it was working, before either one started its tests
        if threading.current_thread().name == "first":
            first_in.set()
            second_in.wait(20)
        else:
            second_in.set()
            while not FX.get(fid).get("testing"):
                time.sleep(0.02)
        return real(fid)

    monkeypatch.setattr(FX, "_tests_argv", argv)
    got: dict = {}

    def check(within: float) -> None:
        t0 = time.monotonic()
        rec = FX.done(r["id"], "Bar says read", "", within=within)
        got[threading.current_thread().name] = (rec, time.monotonic() - t0)

    first = threading.Thread(target=check, args=(30,), name="first")
    second = threading.Thread(target=check, args=(1,), name="second")
    first.start()
    assert first_in.wait(20)
    second.start()
    second.join(30)
    first.join(30)
    rec, took = got["second"]
    assert took < 2.5 and rec["state"] == "working" and rec["testing"]
    assert got["first"][0]["state"] == "ready"
    runner_gone(r["id"])
    # the first check's runner wrote what came of the tests; nothing wrote over it or ran them again
    assert FX.get(r["id"])["state"] == "ready" and FX.get(r["id"])["tests"] == "passed"
    assert runs.read_text() == "run\n"
