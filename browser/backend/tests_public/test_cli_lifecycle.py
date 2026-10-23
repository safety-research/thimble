"""What `stop` ends under the supervisor (app.cli): the workspaces' kernels by their records, and never a recorded pid
whose command line is no kernel; the server first, with time to stop its own agents; and the server stops when the
terminal that holds thimble-browser closes. The stand-in kernels and servers are Python processes that sleep."""
from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

import pytest

from app import cli
from test_cli import _free_port, _started

pytestmark = pytest.mark.usefixtures("named_sessions")


def _stop_all(*ps: subprocess.Popen) -> None:
    for p in ps:
        if p.poll() is None:
            p.kill()
            p.wait(5)


# ----------------------------------------------------------------------------- stop


def test_stop_ends_the_workspaces_kernels_by_their_records_and_restart_keeps_them(home, tmp_path, monkeypatch):
    ws_dir = tmp_path / "ws"
    monkeypatch.setenv("THIMBLE_WORKSPACES_DIR", str(ws_dir))
    kd = ws_dir / "mini" / cli.KERNELS_DIR
    kd.mkdir(parents=True)
    conn_a, conn_b, conn_c = kd / "shared.conn.json", kd / "k-nb1.conn.json", kd / "k-nb2.conn.json"
    for f in (conn_a, conn_b, conn_c):
        f.write_text("{}")
    sleeper = "import time; time.sleep(60)"
    recorded = _started(subprocess.Popen([sys.executable, "-c", sleeper, "ipykernel_launcher", "-f", str(conn_a)],
                                         start_new_session=True), "ipykernel_launcher")
    other = _started(subprocess.Popen([sys.executable, "-c", sleeper], start_new_session=True), sleeper)
    orphan = _started(subprocess.Popen([sys.executable, "-c", sleeper, "ipykernel_launcher", "-f", str(conn_c)],
                                       start_new_session=True), "ipykernel_launcher")
    try:
        (kd / "shared.json").write_text(json.dumps({"name": None, "pid": recorded.pid, "pgid": recorded.pid,
                                                    "connection_file": str(conn_a)}))
        (kd / "k-nb1.json").write_text(json.dumps({"name": "nb1", "pid": other.pid, "pgid": other.pid,
                                                   "connection_file": str(conn_b)}))
        found = {conn: pid for pid, _pgid, conn, _rec in cli.kernel_processes(ws_dir)}
        assert found == {str(conn_a): recorded.pid, str(conn_b): 0, str(conn_c): orphan.pid}
        cli.write_state({"port": _free_port(), "pid": None, "vite_pid": None})
        monkeypatch.setattr(cli, "_kill", lambda pid, must, label, *_: f"{label}: not running")
        assert cli.stop(kernels=False) == ["server: not running"]
        assert recorded.poll() is None and orphan.poll() is None
        lines = cli.stop()
        assert lines[0].startswith("kernels: 2 stopped") and lines[1:] == ["server: not running"]
        recorded.wait(5)
        orphan.wait(5)
        assert other.poll() is None, "a recorded pid whose command line is no kernel is never signalled"
        assert not (kd / "shared.json").exists() and not conn_a.exists()
        assert not (kd / "k-nb1.json").exists() and not conn_b.exists()
        assert cli.stop()[0] == "kernels: none running"
    finally:
        _stop_all(recorded, other, orphan)


# ----------------------------------------------------------------------------- the server's stop

# a stand-in server: a session leader whose SIGTERM stops its agent (its child) itself, as runtime.stop_all does
LEADER = """
import signal, subprocess, sys, time
child = subprocess.Popen([sys.executable, sys.argv[1], sys.argv[2]])
def stop(*_):
    if sys.argv[3] == "stops-its-agents":
        child.send_signal(signal.SIGUSR1)
        child.wait(5)
    sys.exit(0)
signal.signal(signal.SIGTERM, stop)
open(sys.argv[2] + ".leader", "w").close()
time.sleep(60)
"""
# its agent, which says how it ended: stopped by the server, or terminated from outside
AGENT = """
import signal, sys, time
def ended(how):
    def handler(*_):
        open(sys.argv[1], "w").write(how)
        sys.exit(0)
    return handler
signal.signal(signal.SIGUSR1, ended("stopped by the server"))
signal.signal(signal.SIGTERM, ended("terminated"))
open(sys.argv[1] + ".agent", "w").close()
time.sleep(60)
"""


def _server_with_an_agent(tmp_path, how: str) -> tuple[subprocess.Popen, Path]:
    d = tmp_path / how
    d.mkdir()
    (d / "leader.py").write_text(LEADER)
    (d / "agent.py").write_text(AGENT)
    out = d / "ended"
    p = subprocess.Popen([sys.executable, str(d / "leader.py"), str(d / "agent.py"), str(out), how],
                         start_new_session=True)
    deadline = time.monotonic() + 10
    while not (Path(f"{out}.leader").exists() and Path(f"{out}.agent").exists()) and time.monotonic() < deadline:
        time.sleep(0.05)
    return p, out


def test_the_server_stops_its_own_agents_before_the_rest_of_its_session_is_signalled(tmp_path):
    """Ctrl-C (stop): the server alone has its SIGTERM first and time to stop its agents, so each ends `stopped` rather
    than dying under it; what it leaves of its session is ended after."""
    p, out = _server_with_an_agent(tmp_path, "stops-its-agents")
    try:
        line = cli._kill(p.pid, lambda pid: None, "server", 5.0)
        assert line == f"server: pid {p.pid} stopped (2 processes)"
        assert out.read_text() == "stopped by the server"
    finally:
        _stop_all(p)
    p, out = _server_with_an_agent(tmp_path, "leaves-them")
    try:
        assert cli._kill(p.pid, lambda pid: None, "server", 5.0).startswith(f"server: pid {p.pid} ")
        assert out.read_text() == "terminated", "what the server left running is ended after it"
    finally:
        _stop_all(p)


@pytest.mark.parametrize("sig", [signal.SIGHUP, signal.SIGTERM])
def test_closing_the_terminal_stops_the_server_as_ctrl_c_does(monkeypatch, capsys, sig):
    """The terminal that holds thimble-browser closes (SIGHUP), or the launcher is killed (SIGTERM): the server stops,
    with every agent it runs, as on Ctrl-C, and a second signal during that stop does not cut it short."""
    stops: list[int] = []

    def stop() -> list[str]:
        os.kill(os.getpid(), sig)  # a second signal while the server stops
        stops.append(1)
        return ["server: pid 1 stopped"]

    def sleep(_s: float) -> None:
        os.kill(os.getpid(), sig)
        time.sleep(5)  # the signal's handler raises out of this

    monkeypatch.setattr(cli, "stop", stop)
    before = signal.getsignal(sig)
    cli.hold_until_quit(sleep)
    assert stops == [1] and "server: pid 1 stopped" in capsys.readouterr().out
    assert signal.getsignal(sig) is before
