"""app.procs: process facts from /proc on Linux and from ps / lsof where there is none (macOS). Both paths run
here — the fallback by setting HAVE_PROC False, so a regression in the ps parsing shows up on Linux too."""
from __future__ import annotations

import contextlib
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

import pytest

from app import procs


@pytest.fixture(params=[True, False], ids=["proc", "ps"])
def via(request, monkeypatch):
    monkeypatch.setattr(procs, "HAVE_PROC", request.param)
    return request.param


def test_this_process_is_seen_the_same_way_on_both_paths(via):
    me = os.getpid()
    assert procs.alive(me)
    argv = procs.argv(me)
    assert argv and any("python" in a or "pytest" in a for a in argv), argv
    assert procs.cmdline(me) == " ".join(argv)
    assert procs.pgid(me) == os.getpgid(0)
    # the ps path reads the working directory with lsof, which a minimal Linux image may lack; without it cwd is unknown
    assert procs.cwd(me) == (Path.cwd().resolve() if via or shutil.which("lsof") else None)
    assert me in procs.pids()
    assert procs.commands()[me] == argv


def test_a_dead_process_and_a_zombie_are_not_alive_and_have_no_facts(via):
    dead = subprocess.Popen(["true"])
    dead.wait()
    assert not procs.alive(dead.pid) and procs.argv(dead.pid) == [] and procs.pgid(dead.pid) is None and procs.cwd(dead.pid) is None
    zombie = subprocess.Popen(["true"])
    os.waitid(os.P_PID, zombie.pid, os.WEXITED | os.WNOWAIT)  # exited, not reaped: kill(pid, 0) still answers
    try:
        assert not procs.alive(zombie.pid)
    finally:
        zombie.wait()


def test_the_command_line_carries_the_arguments_a_caller_looks_for(via):
    p = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)", "-m", "uvicorn", "app.main:app", "--port", "8398"])
    try:
        # Popen returns once the child is forked, and until it has exec'd its command line can read empty, so wait for
        # the exec rather than read it once
        deadline = time.monotonic() + 5
        argv = procs.argv(p.pid)
        while "8398" not in argv and time.monotonic() < deadline:
            time.sleep(0.02)
            argv = procs.argv(p.pid)
        assert argv[-5:] == ["-m", "uvicorn", "app.main:app", "--port", "8398"], argv
    finally:
        p.kill()
        p.wait()


def test_junk_pids_are_nothing():
    for junk in (None, 0, -1, True, "12"):
        assert not procs.alive(junk) and procs.argv(junk) == [] and procs.pgid(junk) is None and procs.cwd(junk) is None


def test_under_compares_resolved_paths(tmp_path):
    (tmp_path / "a" / "b").mkdir(parents=True)
    link = tmp_path / "link"
    link.symlink_to(tmp_path / "a")
    assert procs.under(tmp_path / "a" / "b", tmp_path) and procs.under(tmp_path / "a", tmp_path / "a")
    assert procs.under(link / "b", tmp_path / "a")
    assert not procs.under(tmp_path, tmp_path / "a") and not procs.under(None, tmp_path) and not procs.under(tmp_path, None)


@pytest.mark.skipif(not procs.HAVE_PROC, reason="the environment of another process is read from /proc")
def test_environ_is_the_environment_the_process_started_with():
    """session.attach reads the CLAUDE_CONFIG_DIR of the session's `claude` process from it (config.process_claude_config)."""
    # Popen returns while the child is still inside exec: the kernel has given it its new memory but not yet written
    # the environment into it, and /proc/<pid>/environ reads empty in that window. The child says it is up once its own code runs, which is after
    # exec has finished, so the read below always sees the environment it started with.
    p = subprocess.Popen([sys.executable, "-c", "import sys, time; print('up', flush=True); time.sleep(30)"],
                         env={"PATH": os.environ.get("PATH", ""), "CLAUDE_CONFIG_DIR": "/tmp/a b/cc", "EMPTY": ""},
                         stdout=subprocess.PIPE, text=True)
    try:
        assert p.stdout is not None and p.stdout.readline() == "up\n"
        env = procs.environ(p.pid)
        assert env is not None and env["CLAUDE_CONFIG_DIR"] == "/tmp/a b/cc" and env["EMPTY"] == ""
    finally:
        p.kill()
        p.wait()
        if p.stdout is not None:
            p.stdout.close()
    assert procs.environ(p.pid) is None, "gone"
    assert procs.environ(None) is None and procs.environ(0) is None


def test_descendants_finds_a_grandchild_in_a_session_of_its_own_with_one_read_of_the_parents(via, monkeypatch, tmp_path):
    """Stop (agent_session.stop_run) reads what a session started before its first signal, including the commands Claude
    Code runs as leaders of sessions of their own. On a Mac that read is one `ps` for all processes, never one per
    process, which would hold Stop for seconds."""
    marker = tmp_path / "grandchild.pid"
    child = subprocess.Popen([sys.executable, "-c",
                              "import subprocess, sys, time\n"
                              "g = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'], start_new_session=True)\n"
                              f"open({str(marker)!r}, 'w').write(str(g.pid))\n"
                              "time.sleep(30)"])
    try:
        deadline = time.monotonic() + 5
        while not marker.is_file() or not marker.read_text():
            assert time.monotonic() < deadline, "the grandchild never started"
            time.sleep(0.02)
        grandchild = int(marker.read_text())
        assert procs.pgid(grandchild) != procs.pgid(child.pid)
        runs: list[list[str]] = []
        real = procs._run
        monkeypatch.setattr(procs, "_run", lambda cmd: (runs.append(cmd), real(cmd))[1])
        below = procs.descendants(os.getpid())
        assert child.pid in below and grandchild in below and os.getpid() not in below
        assert procs.descendants(child.pid) == [grandchild]
        if not via:
            assert len(runs) == 2, f"one ps per call of descendants, not one per process: {runs}"
    finally:
        with contextlib.suppress(Exception):
            os.kill(int(marker.read_text()), 9)
        child.kill()
        child.wait()
