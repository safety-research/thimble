"""What `stop` ends under the supervisor (app.cli): the workspaces' kernels by their records, and never a recorded pid
whose command line is no kernel. The stand-in kernels are Python processes that sleep."""
from __future__ import annotations

import json
import subprocess
import sys

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
