"""thimble fix done (engine/kernel/fixes.py): the quick tests run in a process of their own, so that a check may take
longer than a call. done --within gives the fix still working while its tests run, and a later done what came of them;
a done while they run starts no second run; a runner that ended before it wrote what came of them leaves the fix
failed, with no new round; the shell's done waits for them. The world is test_fixes.py's made-up thimble 0.10.2; slow
tests are made with THIMBLE_FIX_TESTS. All data here is made up."""
from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_fixes import FX, made, world  # noqa: E402, F401  (world is the fixture)

ENGINE = Path(__file__).resolve().parents[1] / "engine"


def appeared(p: Path) -> str:
    """The text of a file the tests write, once it has some."""
    end = time.monotonic() + 60  # a busy machine starts the runner late, never not at all
    while time.monotonic() < end:
        if p.exists() and p.read_text().strip():
            return p.read_text().strip()
        time.sleep(0.05)
    raise AssertionError(f"{p.name} never appeared")


def call(tmp_path: Path, *args: str) -> subprocess.Popen:
    """`thimble fix ARGS` in a process of its own, as Claude Code runs it, in a process group of its own, as Claude Code
    stops it; with no sandbox around the tests, as the world fixture has in this process."""
    w = tmp_path / "thimble.py"
    w.write_text(f"import sys\nsys.path.insert(0, {str(ENGINE)!r})\nfrom kernel import cli, fixes\n"
                 "fixes.sandbox_argv = lambda fid: ['/bin/bash', '-c']\nsys.exit(cli.main(sys.argv[1:]))\n")
    return subprocess.Popen([sys.executable, str(w), "fix", *args], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, text=True, start_new_session=True)


def test_done_within_gives_the_fix_still_working_while_its_tests_run_and_a_later_done_what_came_of_them(world, monkeypatch, tmp_path):
    gate = tmp_path / "tests-may-end"  # the tests run until the test makes it, so they outlast the first call however slow
    monkeypatch.setenv("THIMBLE_FIX_TESTS", f"while [ ! -e '{gate}' ]; do sleep 0.05; done")
    r = made(world)
    try:
        # the call ends at its limit while the tests run on: their runner holds none of its pipes, so a call that waited
        # for them would never end
        try:
            out, err = call(tmp_path, "done", str(r["id"]), "--title", "Bar says read", "--within", "0.3").communicate(timeout=90)
        except subprocess.TimeoutExpired:
            pytest.fail("the call waited for the tests")
        got = json.loads(out)
        # still working, as every list reads it, with the mark that its tests run
        assert got["state"] == "working" and got["testing"]["lock"] and FX.get(r["id"])["testing"] == got["testing"]
    finally:
        gate.touch()
    out, err = call(tmp_path, "done", str(r["id"]), "--within", "60").communicate(timeout=90)
    got = json.loads(out)
    assert got["state"] == "ready" and got["tests"] == "passed" and got["title"] == "Bar says read"
    assert "testing" not in got and FX.get(r["id"])["state"] == "ready"
    # the runner said nothing of its own
    assert (FX.tmp_dir(r["id"]) / "runner.log").read_text() == ""


def test_a_check_whose_call_is_stopped_while_its_tests_run_still_gets_what_came_of_them(world, monkeypatch, tmp_path):
    started = tmp_path / "started"
    monkeypatch.setenv("THIMBLE_FIX_TESTS", f"echo yes > {started}; sleep 2")
    r = made(world)
    p = call(tmp_path, "done", str(r["id"]), "--title", "Bar says read")
    appeared(started)
    # Claude Code stops the call, and all of its process group, as it does at the call's 10 minutes
    os.killpg(p.pid, signal.SIGKILL)
    p.communicate(timeout=10)
    end = time.monotonic() + 60  # until the runner wrote what came of the tests
    while FX.get(r["id"])["state"] == "working" and time.monotonic() < end:
        time.sleep(0.05)
    got = FX.get(r["id"])
    assert got["state"] == "ready" and got["tests"] == "passed" and got["title"] == "Bar says read"


def test_a_done_while_the_same_fixs_tests_run_waits_for_them_and_starts_no_second_run(world, monkeypatch, tmp_path):
    runs = tmp_path / "runs.log"
    monkeypatch.setenv("THIMBLE_FIX_TESTS", f"echo run >> {runs}; sleep 2")
    r = made(world)
    first: list = []
    th = threading.Thread(target=lambda: first.append(FX.done(r["id"], "Bar says read", "")))
    th.start()
    appeared(runs)
    # the second done comes while the first one's tests run
    second = FX.done(r["id"])
    th.join(60)
    assert runs.read_text() == "run\n"
    assert first and first[0]["state"] == "ready" and second["state"] == "ready" and second["title"] == "Bar says read"


def test_a_runner_stopped_before_it_wrote_what_came_of_the_tests_leaves_the_fix_failed_with_no_new_round(world, monkeypatch, tmp_path):
    pid = tmp_path / "runner.pid"
    # the tests' shell names its parent: the runner
    monkeypatch.setenv("THIMBLE_FIX_TESTS", f"echo $PPID > {pid}; sleep 60")
    r = made(world)
    assert FX.done(r["id"], "Bar says read", "", within=0.3)["testing"]
    # the runner, its tests' shell and their sleep, all in the runner's session
    os.killpg(int(appeared(pid)), signal.SIGKILL)
    got = FX.done(r["id"], within=30)
    assert got["state"] == "failed" and got["error"] == "its tests failed in the sandbox"
    assert got["tests_tail"] == "the tests stopped before they finished"
    assert "refused" not in got and "testing" not in got and FX.get(r["id"])["state"] == "failed"


def test_the_shells_done_waits_for_what_came_of_the_tests_which_run_apart_from_it(world, monkeypatch, tmp_path, capsys):
    from kernel import cli  # noqa: PLC0415

    parent = tmp_path / "parent.pid"
    monkeypatch.setenv("THIMBLE_FIX_TESTS", f"echo $PPID > {parent}; sleep 1")
    r = made(world)
    t0 = time.monotonic()
    assert cli.main(["fix", "done", str(r["id"]), "--title", "Bar says read"]) == 0
    got = json.loads(capsys.readouterr().out)
    assert time.monotonic() - t0 >= 1
    assert got["state"] == "ready" and got["tests"] == "passed" and got["title"] == "Bar says read" and "testing" not in got
    # the tests ran in a process of their own, not in the call's
    assert int(parent.read_text()) != os.getpid()
