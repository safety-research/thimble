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


# The call's waits for what came of the tests (fixes._wait), each written as a line of waits.jsonl: `left`, the seconds
# its deadline had left when it began (null without one), and `late`, how many of its sleeps began once the deadline had
# passed. A wait that keeps to its limit begins with at most the limit left, which counts from the call's start, and
# sleeps at most once more after it: it looks at the deadline before each sleep.
WAITS = """_wait, _sleep, WAITS = fixes._wait, time.sleep, sys.argv.pop(1)
def waits(fid, deadline):
    left, late, over = (None if deadline is None else deadline - time.monotonic()), [0], [0]
    def sleep(s):
        now = time.monotonic()
        late[0] += deadline is not None and now >= deadline
        over[0] += deadline is not None and now < deadline and s > deadline - now + 0.1
        _sleep(s)
    time.sleep = sleep
    try:
        return _wait(fid, deadline)
    finally:
        time.sleep = _sleep
        with open(WAITS, "a") as f:
            f.write(json.dumps({"left": left, "late": late[0], "over": over[0]}) + "\\n")
fixes._wait = waits
"""


def call(tmp_path: Path, *args: str) -> subprocess.Popen:
    """`thimble fix ARGS` in a process of its own, as Claude Code runs it, in a process group of its own, as Claude Code
    stops it; with no sandbox around the tests, as the world fixture has in this process. Its waits for the tests go to
    tmp_path/waits.jsonl (WAITS)."""
    w = tmp_path / "thimble.py"
    w.write_text(f"import json, sys, time\nsys.path.insert(0, {str(ENGINE)!r})\nfrom kernel import cli, fixes\n"
                 f"fixes.sandbox_argv = lambda fid: ['/bin/bash', '-c']\n{WAITS}sys.exit(cli.main(sys.argv[1:]))\n")
    return subprocess.Popen([sys.executable, str(w), str(tmp_path / "waits.jsonl"), "fix", *args], stdin=subprocess.DEVNULL,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)


def waits(tmp_path: Path) -> list[dict]:
    """The waits the calls so far made for what came of the tests (WAITS), and none after."""
    p = tmp_path / "waits.jsonl"
    got = [json.loads(x) for x in p.read_text().splitlines()] if p.exists() else []
    p.unlink(missing_ok=True)
    return got


def test_done_within_gives_the_fix_still_working_while_its_tests_run_and_a_later_done_what_came_of_them(world, monkeypatch, tmp_path):
    # the tests run until the test makes the gate, which it does only once the call came back, so the call can come
    # back only at its limit, while they run (and they end with this process, should the call wait for them after all)
    gate = tmp_path / "tests-may-end"
    monkeypatch.setenv("THIMBLE_FIX_TESTS", f"while [ ! -e '{gate}' ] && kill -0 {os.getpid()}; do sleep 0.05; done")
    r = made(world)
    try:
        # the call ends at its limit while the tests run on: their runner holds none of its pipes
        out, err = call(tmp_path, "done", str(r["id"]), "--title", "Bar says read", "--within", "0.3").communicate()
        got = json.loads(out)
        # still working, as every list reads it, with the mark that its tests run
        assert got["state"] == "working" and got["testing"]["lock"] and FX.get(r["id"])["testing"] == got["testing"]
        # and back at the limit, however busy the machine: its wait for the tests began with at most 0.3 s left, and
        # came back at its first look after them
        assert [(w["left"] is not None and w["left"] <= 0.3, w["late"] <= 1, w["over"] == 0) for w in waits(tmp_path)] == [(True, True, True)], err
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
