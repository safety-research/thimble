"""The server's lifecycle under the supervisor (app.cli): which recorded process is trusted as the server, what `stop`
ends (the server answering on the port when the record is stale, the workspaces' kernels by their records, never
another program), a restart that hands the kernels over and announces itself, the restart after a source change that
waits until the server is idle, and `/thimble restore` with the archives it lists and restores. The stand-in
processes run `sleep` under a server's command line on port 8398, where nothing listens."""
from __future__ import annotations

import json
import subprocess
import sys
import time
from pathlib import Path

import pytest

from app import cli, config, procs
from test_cli import (SERVER_LIKE, _free_port, _healthy_no_process, _healthy_with_state, _restart_seam,  # noqa: F401
                      _started, fake)

pytestmark = pytest.mark.usefixtures("named_sessions")


def _stop_all(*ps: subprocess.Popen) -> None:
    for p in ps:
        if p.poll() is None:
            p.kill()
            p.wait(5)


# ----------------------------------------------------------------------------- which process is the server


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
        monkeypatch.setattr(cli, "_kill", lambda pid, must, label: f"{label}: not running")
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


# ----------------------------------------------------------------------------- restart


# ----------------------------------------------------------------------------- resuming a run
