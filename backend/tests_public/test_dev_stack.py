"""scripts/dev/dev_stack.sh stop, on a stand-in stack: it stops the leader it recorded and every process of the leader's
session, reading processes with ps, so it works on macOS, which has no /proc; where ps has no session column it goes by
the leader's process group."""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
import time
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "dev" / "dev_stack.sh"

pytestmark = pytest.mark.skipif(not all(shutil.which(t) for t in ("bash", "ps", "python3")),
                                reason="needs bash, ps and python3")


def gone(pid: int) -> bool:
    st = subprocess.run(["ps", "-o", "stat=", "-p", str(pid)], capture_output=True, text=True).stdout.strip()
    return not st or st.startswith("Z")


def stand_in_stack(tmp_path: Path) -> tuple[subprocess.Popen, int]:
    """A session leader whose command line reads as uvicorn, with a child in its session: the pids stack.json records."""
    child_file = tmp_path / "child.pid"
    code = ("import subprocess, sys, time; c = subprocess.Popen(['sleep', '60']); "
            f"open({str(child_file)!r}, 'w').write(str(c.pid)); time.sleep(60)")
    leader = subprocess.Popen([sys.executable, "-c", code, "uvicorn", "app.main:app"], start_new_session=True)
    for _ in range(100):
        if child_file.exists() and child_file.read_text():
            break
        time.sleep(0.05)
    (tmp_path / "home" / "dev").mkdir(parents=True)
    (tmp_path / "home" / "dev" / "stack.json").write_text(json.dumps({"backend_pid": leader.pid, "vite_pid": None}))
    return leader, int(child_file.read_text())


def stop(tmp_path: Path, path: str) -> subprocess.CompletedProcess:
    env = {"PATH": path, "HOME": str(tmp_path), "THIMBLE_HOME": str(tmp_path / "home")}
    return subprocess.run(["bash", str(SCRIPT), "stop"], capture_output=True, text=True, env=env, timeout=30)


@pytest.mark.parametrize("ps_kind", ["procps", "bsd"])
def test_stop_ends_the_leader_and_its_session_through_ps(tmp_path, ps_kind):
    path = "/usr/bin:/bin"
    if ps_kind == "bsd":  # a ps that, like macOS's, has no `sid` column
        bin_ = tmp_path / "bin"
        bin_.mkdir()
        (bin_ / "ps").write_text(f'#!/bin/sh\ncase " $* " in *" sid="*) echo "ps: sid: keyword not found" >&2; exit 1;; esac\n'
                                 f'exec {shutil.which("ps")} "$@"\n')
        (bin_ / "ps").chmod(0o755)
        path = f"{bin_}:{path}"
    leader, child = stand_in_stack(tmp_path)
    try:
        r = stop(tmp_path, path)
        assert r.returncode == 0 and f"stack backend: pid {leader.pid} stopped" in r.stdout, r.stdout + r.stderr
        leader.wait(5)
        for _ in range(50):
            if gone(child):
                break
            time.sleep(0.1)
        assert gone(child), "the leader's child in its session"
        assert not (tmp_path / "home" / "dev" / "stack.json").exists()
    finally:
        if leader.poll() is None:
            leader.kill()
            leader.wait(5)
        args = subprocess.run(["ps", "-o", "args=", "-p", str(child)], capture_output=True, text=True).stdout.strip()
        if args == "sleep 60":
            subprocess.run(["kill", "-KILL", str(child)], capture_output=True)


def test_the_script_reads_no_proc():
    assert "/proc" not in SCRIPT.read_text()
