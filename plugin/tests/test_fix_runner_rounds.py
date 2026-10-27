"""thimble fix done (engine/kernel/fixes.py) when a new round, or a fix removed, meets the check of the round before: the
check that waits returns as soon as the record no longer waits for its tests. The world is test_fixes.py's made-up
thimble 0.10.2; slow tests are made with THIMBLE_FIX_TESTS. All data here is made up."""
from __future__ import annotations

import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_fix_runner_edges import runner_gone  # noqa: E402
from test_fixes import FX, made, world  # noqa: E402, F401  (world is the fixture)


def mark_of(fid: int) -> dict:
    """The fix's `testing` mark, once its check started the tests."""
    for _ in range(400):
        mark = FX.get(fid).get("testing")
        if mark:
            return mark
        time.sleep(0.05)
    raise AssertionError("the tests never started")


def test_a_check_that_waits_for_the_tests_returns_as_soon_as_a_new_round_takes_the_copy(world, monkeypatch):
    monkeypatch.setenv("THIMBLE_FIX_TESTS", "sleep 4")
    r = made(world)
    got: list = []
    th = threading.Thread(target=lambda: got.append((FX.done(r["id"], "Bar says read", "", within=30), time.monotonic())))
    th.start()
    mark_of(r["id"])
    t0 = time.monotonic()
    # more words for the fix while the check waits for its tests: a new round in the same copy
    FX.round_(r["id"], "and keep the percent")
    th.join(30)
    rec, at = got[0]
    # the check gives the fix as the round left it, at once, not once the tests of the round before end
    assert at - t0 < 2
    assert rec["state"] == "working" and "testing" not in rec and rec["rounds"] == 2
    runner_gone(r["id"])
    assert FX.get(r["id"])["state"] == "working"
