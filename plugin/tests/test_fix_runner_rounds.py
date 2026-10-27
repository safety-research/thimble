"""thimble fix done (engine/kernel/fixes.py) when a new round, or another check, meets the check of the round before:
the check that waits returns as soon as the record no longer waits for its tests; each run of the tests has a lock of its
own, so a new round's tests start while the runner before still runs; two checks at once commit in the copy one at a
time. The world is test_fixes.py's made-up thimble 0.10.2; slow tests are made with THIMBLE_FIX_TESTS. All data here is
made up."""
from __future__ import annotations

import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_fix_runner_edges import runner_gone  # noqa: E402
from test_fixes import FX, made, sh, world  # noqa: E402, F401  (world is the fixture)


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


def test_the_tests_of_a_new_round_start_while_the_runner_of_the_round_before_still_runs(world, monkeypatch, tmp_path):
    runs = tmp_path / "runs.log"
    # the first run is slow, the next one quick
    monkeypatch.setenv("THIMBLE_FIX_TESTS", f"echo run >> {runs}; [ $(wc -l < {runs}) -gt 1 ] || sleep 4")
    r = made(world)
    first = FX.done(r["id"], "Bar says read", "", within=0.2)["testing"]
    FX.round_(r["id"], "and keep the percent")
    p = Path(r["work"]) / "plugin" / "bar" / "bar.tsx"
    p.write_text(p.read_text().replace("${n}", "${n}%"))
    # the round's check starts its own run at once, with a lock of its own, while the runner before still runs
    got = FX.done(r["id"], "Bar says read percent", "", within=1)
    assert got["state"] == "working" and got["testing"] and got["testing"]["lock"] != first["lock"]
    got = FX.done(r["id"], within=30)
    assert got["state"] == "ready" and got["tests"] == "passed" and got["title"] == "Bar says read percent"
    runner_gone(r["id"])
    assert FX.get(r["id"])["state"] == "ready" and runs.read_text() == "run\nrun\n"


def test_two_checks_at_once_commit_in_the_copy_one_at_a_time_and_the_second_commits_nothing(world, monkeypatch, tmp_path):
    runs = tmp_path / "runs.log"
    monkeypatch.setenv("THIMBLE_FIX_TESTS", f"echo run >> {runs}; sleep 1")
    r = made(world)
    real = FX.git
    adds: list[str] = []
    both = threading.Event()

    def git(*args, **kw):
        if args[:2] == ("add", "-A"):
            adds.append(threading.current_thread().name)
            if len(adds) > 1:
                both.set()
            # the first check stays in its commit until the second comes to the same step, or a while
            both.wait(2)
        return real(*args, **kw)

    monkeypatch.setattr(FX, "git", git)
    got: dict = {}

    def check() -> None:
        got[threading.current_thread().name] = FX.done(r["id"], "Bar says read", "", within=30)

    a = threading.Thread(target=check, name="a")
    b = threading.Thread(target=check, name="b")
    a.start()
    for _ in range(400):
        if adds:
            break
        time.sleep(0.01)
    # both checks read the fix while it was working, before either started its tests
    b.start()
    a.join(60)
    b.join(60)
    assert adds == ["a"]
    assert got["a"]["state"] == "ready" and got["b"]["state"] == "ready" and runs.read_text() == "run\n"
    assert sh("git", "rev-parse", f"refs/thimble/fixes/{r['id']}", cwd=FX.live_dir()) == FX.get(r["id"])["commit"]
