"""The kernels across a server's restart (app/notebook.py): each kernel is recorded under workspaces/<c>/kernels/ and
runs detached; a restart hands the kernels over and the next server takes them back with their variables; the kernels
of a server that ended without handing them over are stopped at the next start; a record whose pid is dead or now
another program's is dropped and that program never signalled; and a kernel of another home, or of a server that still
runs, is left alone. Kernels start for real on the synthetic corpus `mini`, and the teardown stops every one a test
left, attached or recorded."""
from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from app import notebook, procs

CORPUS = "mini"


@pytest.fixture(autouse=True)
async def _kernels_down(workspaces_tmp, tmp_path, monkeypatch):
    monkeypatch.setenv("THIMBLE_HOME", str(tmp_path / "home"))  # where the hand-off (cli.hand_over_kernels) lives
    yield
    await notebook.shutdown_all()
    for c in [p.name for p in workspaces_tmp.iterdir() if p.is_dir()]:
        for name in notebook.recorded_kernels(c):
            await notebook.shutdown_kernel(c, kernel=name)


def _text(cell: dict) -> str:
    return "".join(b.get("text/plain", "") for b in cell["outputs"] if "_stream" in b)


def _alive(pid: int) -> bool:
    return notebook._pid_alive(pid)


async def _gone(pid: int, timeout: float = 10.0) -> bool:
    for _ in range(int(timeout / 0.1)):
        if not _alive(pid):
            return True
        await asyncio.sleep(0.1)
    return not _alive(pid)


def _record(ws: Path, key: str) -> dict:
    return json.loads((ws / "kernels" / f"{key}.json").read_text())


def _finished_pid() -> int:
    p = subprocess.Popen(["true"])
    p.wait()
    return p.pid


async def test_a_restart_hands_the_kernels_over_and_the_next_server_takes_them_back(workspaces_tmp):
    """A restart leaves the hand-off naming the server before it stops it (cli.hand_over_kernels): shutdown() then
    detaches, the next server's reconnect_all takes back the kernels the hand-off names, with their variables, and
    consumes it."""
    from app import cli

    await notebook.run_code(CORPUS, "x = 41", "user")
    pid = _record(workspaces_tmp / CORPUS, "k-main")["pid"]
    assert cli.hand_over_kernels(os.getpid()) and cli.kernel_handoff() == os.getpid()
    await notebook.shutdown()
    assert notebook._kernels == {} and notebook._exec_kernels == {}
    assert _alive(pid) and (workspaces_tmp / CORPUS / "kernels" / "k-main.json").is_file()
    res = await notebook.reconnect_all()
    assert res == {"reconnected": [f"{CORPUS}/k-main"], "reaped": []}
    assert cli.kernel_handoff() is None, "consumed"
    cell = await notebook.run_code(CORPUS, "print(x + 1)", "user")
    assert _text(cell) == "42\n" and notebook._exec_kernels[(CORPUS, "main")].pid == pid


async def test_a_kernel_whose_server_ended_without_handing_it_over_is_stopped_at_start(workspaces_tmp):
    """A server that crashed, or was killed before its shutdown ran, left its kernels recorded with its pid: the next
    server of the same THIMBLE_HOME stops them at start instead of taking them back."""
    await notebook.run_code(CORPUS, "1", "user")
    ws = workspaces_tmp / CORPUS
    rec = _record(ws, "k-main")
    await notebook.detach_all()
    (ws / "kernels" / "k-main.json").write_text(json.dumps({**rec, "server_pid": _finished_pid()}))
    res = await notebook.reconnect_all()
    assert res == {"reconnected": [], "reaped": [f"{CORPUS}/k-main"]}
    assert await _gone(rec["pid"]) and notebook.recorded_kernels(CORPUS) == []


async def test_reconnect_all_leaves_another_home_s_kernel_and_a_running_server_s_alone(workspaces_tmp, tmp_path):
    """Only its own kernels: one recorded by a server of another THIMBLE_HOME, and one whose server still runs (a
    uvicorn process), are neither taken back nor stopped."""
    await notebook.run_code(CORPUS, "1", "user")
    ws = workspaces_tmp / CORPUS
    rec = _record(ws, "k-main")
    assert rec["home"] == str(tmp_path / "home")
    await notebook.detach_all()
    record = ws / "kernels" / "k-main.json"
    record.write_text(json.dumps({**rec, "home": str(tmp_path / "another-home")}))
    assert await notebook.reconnect_all() == {"reconnected": [], "reaped": []}
    server = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)", "-m", "uvicorn", "app.main:app"])
    # Popen returns once the child is forked, and until its exec its command line reads as this process's
    for _ in range(500):
        if "app.main:app" in " ".join(procs.argv(server.pid)):
            break
        await asyncio.sleep(0.01)
    try:
        record.write_text(json.dumps({**rec, "server_pid": server.pid}))
        assert await notebook.reconnect_all() == {"reconnected": [], "reaped": []}
        assert _alive(rec["pid"]) and record.is_file()
    finally:
        server.kill()
        server.wait()


async def test_stale_record_is_dropped_without_a_signal_and_a_foreign_pid_is_never_touched(workspaces_tmp):
    """A record whose pid is dead: dropped. A record whose pid now belongs to another program (a reused pid): dropped,
    the program untouched. Neither is reconnected."""
    kdir = workspaces_tmp / CORPUS / "kernels"
    kdir.mkdir(parents=True)
    other = subprocess.Popen(["sleep", "30"])
    try:
        for key, pid in (("k-dead", _finished_pid()), ("k-other", other.pid)):
            (kdir / f"{key}.json").write_text(json.dumps({"name": key[2:], "pid": pid, "pgid": pid,
                                                          "connection_file": str(kdir / f"{key}.conn.json")}))
            (kdir / f"{key}.conn.json").write_text("{}")
        res = await notebook.reconnect_all()
        assert res["reconnected"] == [] and sorted(res["reaped"]) == [f"{CORPUS}/k-dead", f"{CORPUS}/k-other"]
        assert sorted(p.name for p in kdir.iterdir()) == []
        assert other.poll() is None, "still running: never signalled"
    finally:
        other.kill()
        other.wait()
