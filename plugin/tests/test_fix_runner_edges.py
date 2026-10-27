"""thimble fix done (engine/kernel/fixes.py) at the edges of the runner that tests a fixer's change: a done that only
waits works from any session; two checks at once start one run, and the second waits no longer than its limit; a new
round takes the copy from the tests of the round before; a fix removed while its tests run keeps no mark of them; what
came of the tests stays marked as not shown until the plugin says it showed it; a round of a fix changed in place that
git stops fails with git's words. The world is test_fixes.py's made-up thimble 0.10.2; slow tests are made with
THIMBLE_FIX_TESTS. All data here is made up."""
from __future__ import annotations

import fcntl
import os
import sys
import threading
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_fixes import FX, made, on_fix, sh, world  # noqa: E402, F401  (world is the fixture)


def runner_gone(fid: int) -> None:
    """Once every runner of the fix's tests ended: the lock file each run has (tests/<id>.<run>.lock), which its runner
    holds while it lives, is free, or gone."""
    for p in (FX.home() / "tests").glob(f"{fid}.*.lock"):
        try:
            fd = os.open(p, os.O_RDWR)
        except FileNotFoundError:
            continue
        try:
            for _ in range(600):
                try:
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    time.sleep(0.05)
            else:
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


def test_a_new_round_while_the_tests_run_takes_the_copy_and_its_own_done_checks_the_new_change(world, monkeypatch, tmp_path):
    runs = tmp_path / "runs.log"
    monkeypatch.setenv("THIMBLE_FIX_TESTS", f"echo run >> {runs}; sleep 1")
    r = made(world)
    assert FX.done(r["id"], "Bar says read", "", within=0.2)["testing"]
    # more words for the fix while its tests run: a new round in the same copy, which no longer waits for them
    again = FX.round_(r["id"], "and keep the percent")
    assert again["state"] == "working" and "testing" not in again and "testing" not in FX.get(r["id"])
    runner_gone(r["id"])
    # the runner of the round before wrote nothing
    assert FX.get(r["id"])["state"] == "working" and FX.get(r["id"])["rounds"] == 2
    p = Path(r["work"]) / "plugin" / "bar" / "bar.tsx"
    p.write_text(p.read_text().replace("${n}", "${n}%"))
    got = FX.done(r["id"], "Bar says read percent", "", within=30)
    assert got["state"] == "ready" and runs.read_text() == "run\nrun\n"
    assert "read ${n}%" in sh("git", "show", f"{got['commit']}:plugin/bar/bar.tsx", cwd=FX.live_dir())


def test_a_fix_removed_while_its_tests_run_keeps_no_mark_of_them(world, monkeypatch):
    monkeypatch.setenv("THIMBLE_FIX_TESTS", "sleep 1")
    r = made(world)
    assert FX.done(r["id"], "Bar says read", "", within=0.2)["testing"]
    FX.remove(r["id"])
    assert "testing" not in FX.get(r["id"])
    t0 = time.monotonic()
    got = FX.done(r["id"], within=30)
    assert got["state"] == "removed" and "testing" not in got and time.monotonic() - t0 < 1
    runner_gone(r["id"])
    assert FX.get(r["id"])["state"] == "removed"
    # only a working record carries the mark
    assert "testing" not in FX.put({**got, "state": "failed", "testing": {"since": 1.0, "lock": "made-up.lock"}})


def test_what_came_of_the_tests_stays_marked_as_not_shown_until_the_plugin_says_it_showed_it(world, monkeypatch, capsys):
    from kernel import cli  # noqa: PLC0415

    monkeypatch.setenv("THIMBLE_FIX_TESTS", "sleep 0.5")
    r = made(world)
    assert FX.done(r["id"], "Bar says read", "", within=0)["testing"]
    # the session that waited is gone; the runner writes what came of the tests all the same
    runner_gone(r["id"])
    got = FX.get(r["id"])
    assert got["state"] == "ready" and got["unshown"] is True
    capsys.readouterr()
    assert cli.main(["fix", "shown", str(r["id"])]) == 0
    assert "unshown" not in FX.get(r["id"]) and FX.get(r["id"])["state"] == "ready"


def test_a_round_of_a_fix_changed_in_place_that_git_stops_fails_with_gits_words(world, monkeypatch):
    a = on_fix(world)
    r = FX.round_(a["id"], "it breaks when I click")
    p = Path(r["work"]) / "plugin" / "bar" / "bar.tsx"
    p.write_text(p.read_text().replace("${n}", "${n ?? 0}"))
    # the tests pass, and leave the copy's git busy, so that git cannot make the fix's new version
    monkeypatch.setenv("THIMBLE_FIX_TESTS", 'touch "$(git rev-parse --git-dir)/index.lock"')
    got = FX.done(r["id"], None, "The read item works when clicked.", within=30)
    assert got["state"] == "failed" and got["error"].startswith("git checkout") and got["tests"] == "passed"
    assert "refused" not in got
