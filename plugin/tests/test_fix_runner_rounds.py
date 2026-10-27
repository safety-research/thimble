"""thimble fix done (engine/kernel/fixes.py) when a new round, or another check, meets the check of the round before:
the check that waits returns as soon as the record no longer waits for its tests; each run of the tests has a lock of its
own, so a new round's tests start while the runner before still runs; two checks at once commit in the copy one at a
time. The world is test_fixes.py's made-up thimble 0.10.2; slow tests are made with THIMBLE_FIX_TESTS. All data here is
made up."""
from __future__ import annotations

import fcntl
import io
import json
import os
import sys
import threading
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_fix_runner_edges import runner_gone  # noqa: E402
from test_fixes import FX, made, on_fix, sh, world  # noqa: E402, F401  (world is the fixture)


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
    assert got["state"] == "working" and (got.get("testing") or {}).get("lock") not in (None, first["lock"])
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


def held_mark(monkeypatch, tmp_path: Path) -> list[int]:
    """_start_tests made to write the mark of a run whose lock this test holds, as a runner would, and to start no
    runner: the test runs the runner itself (run_here). The descriptors that hold the locks, to close at the end."""
    fds: list[int] = []

    def start(rec, named, argv, *rest):
        lock = tmp_path / f"made-up-run-{rec['id']}.lock"
        fd = os.open(lock, os.O_RDWR | os.O_CREAT, 0o600)
        fcntl.flock(fd, fcntl.LOCK_EX)
        fds.append(fd)
        return FX.put({**rec, "testing": {"since": time.time(), "lock": str(lock)}})

    monkeypatch.setattr(FX, "_start_tests", start)
    return fds


def run_here(monkeypatch, fid: int, title: str | None) -> None:
    """The runner of the fix's tests, in this process, with its job on stdin as _start_tests gives it."""
    job = {"id": fid, "argv": ["/bin/bash", "-c", "true"], "title": title, "testing": FX.get(fid)["testing"]}
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps(job)))
    FX.tests_runner()


def step_in(monkeypatch, where: str, act) -> list[threading.Thread]:
    """`act`, in a thread of its own, while the runner is between its look at the record and its write ("look": as it
    makes what came of the tests) or at its write ("write"), waited for at most 2 s: a step that waits for the fixes'
    lock goes on after the write."""
    threads: list[threading.Thread] = []

    def fire() -> None:
        th = threading.Thread(target=act)
        threads.append(th)
        th.start()
        th.join(2)

    if where == "look":
        tested = FX._tested

        def hooked(*a, **k):
            if not threads:
                fire()
            return tested(*a, **k)

        monkeypatch.setattr(FX, "_tested", hooked)
    else:
        put = FX.put

        def hooked(rec):
            if rec.get("unshown") and not threads:
                fire()
            return put(rec)

        monkeypatch.setattr(FX, "put", hooked)
    return threads


@pytest.mark.parametrize("where", ["look", "write"])
def test_a_new_round_that_comes_while_the_runner_writes_what_came_of_the_tests_stays_as_it_is(world, monkeypatch, tmp_path, where):
    fds = held_mark(monkeypatch, tmp_path)
    r = made(world)
    assert FX.done(r["id"], "Bar says read", "", within=0)["testing"]
    threads = step_in(monkeypatch, where, lambda: FX.round_(r["id"], "and keep the percent"))
    run_here(monkeypatch, r["id"], "Bar says read")
    for th in threads:
        th.join(30)
    got = FX.get(r["id"])
    assert threads and got["state"] == "working" and got["rounds"] == 2 and got["words"][-1] == "and keep the percent"
    for fd in fds:
        os.close(fd)


@pytest.mark.parametrize("where", ["look", "write"])
def test_a_fix_removed_while_the_runner_writes_what_came_of_the_tests_stays_removed(world, monkeypatch, tmp_path, where):
    fds = held_mark(monkeypatch, tmp_path)
    r = made(world)
    assert FX.done(r["id"], "Bar says read", "", within=0)["testing"]
    threads = step_in(monkeypatch, where, lambda: FX.remove(r["id"]))
    run_here(monkeypatch, r["id"], "Bar says read")
    for th in threads:
        th.join(30)
    assert threads and FX.get(r["id"])["state"] == "removed"
    for fd in fds:
        os.close(fd)


@pytest.mark.parametrize("where", ["look", "write"])
def test_a_new_round_while_the_runner_settles_a_fix_changed_in_place_stays_as_it_is(world, monkeypatch, tmp_path, where):
    a = on_fix(world)
    r = FX.round_(a["id"], "it breaks when I click")
    p = Path(r["work"]) / "plugin" / "bar" / "bar.tsx"
    p.write_text(p.read_text().replace("${n}", "${n ?? 0}"))
    fds = held_mark(monkeypatch, tmp_path)
    assert FX.done(r["id"], None, "The read item works when clicked.", within=0)["testing"]
    threads = step_in(monkeypatch, where, lambda: FX.round_(r["id"], "and when I press it twice"))
    run_here(monkeypatch, r["id"], None)
    for th in threads:
        th.join(30)
    got = FX.get(r["id"])
    assert threads and got["state"] == "working" and got["rounds"] == r["rounds"] + 1 and got["prev"]["state"] == "on"
    assert got["words"][-1] == "and when I press it twice"
    for fd in fds:
        os.close(fd)


def test_another_round_a_new_round_and_r_drop_the_mark_of_an_outcome_not_shown(world, monkeypatch):
    # tests that fail: the runner writes what came of them, not shown yet
    monkeypatch.setenv("THIMBLE_FIX_TESTS", "false")
    r = made(world)
    assert FX.done(r["id"], "Bar says read", "", within=30)["unshown"] is True
    # another round in the same copy, for the refusal
    assert "unshown" not in FX.again(r["id"]) and "unshown" not in FX.get(r["id"])
    assert FX.done(r["id"], "Bar says read", "", within=30)["unshown"] is True
    # r, in a new copy
    assert "unshown" not in FX.redo(r["id"]) and "unshown" not in FX.get(r["id"])
    monkeypatch.setenv("THIMBLE_FIX_TESTS", "true")
    p = Path(FX.get(r["id"])["work"]) / "plugin" / "bar" / "bar.tsx"
    p.write_text(p.read_text().replace("coverage", "read"))
    assert FX.done(r["id"], "Bar says read", "", within=30)["unshown"] is True
    # more words, in the copy
    assert "unshown" not in FX.round_(r["id"], "and keep the percent") and "unshown" not in FX.get(r["id"])
    assert FX.done(r["id"], "Bar says read", "", within=30)["unshown"] is True
    # more words for a fix with no copy (n kept it, off): a round in place
    FX.not_now(r["id"])
    assert FX.get(r["id"])["unshown"] is True
    assert "unshown" not in FX.round_(r["id"], "and say it in the pane too") and "unshown" not in FX.get(r["id"])
