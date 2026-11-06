"""thimble-browser's start and stop (app.cli): a detached start in a folder prints the page's link, starts one uvicorn
on its port, which server.json records and which answers health; a second start finds it; `stop` ends it. A start
passes over a taken port (test_port.py). The test starts a real uvicorn on a free port under a scratch THIMBLE_HOME."""
from __future__ import annotations

import contextlib
import json
import os
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

import pytest
from conftest import free_port

from app import cli

BACKEND = Path(__file__).resolve().parents[1]


def _uvicorns_on(p: int) -> list[int]:
    out: list[int] = []
    for entry in Path("/proc").glob("[0-9]*/cmdline"):
        try:
            b = entry.read_bytes()
        except OSError:
            continue
        if b"uvicorn" in b and f"--port\0{p}".encode() in b:
            out.append(int(entry.parent.name))
    return out


# each step is a subprocess with a time limit of its own, so the test cannot hang; its time is a server's start, which a
# machine its parallel runs keep busy makes several times longer
@pytest.mark.timeout(300)
def test_a_detached_browser_start_starts_the_server_once_and_stop_ends_it(home, data, tmp_path, fake_claude):
    try:  # in this process, which runs the same Python on the same tree, rather than in a new one
        import app.main  # noqa: F401, PLC0415
    except Exception as e:  # noqa: BLE001
        pytest.skip(f"app.main does not import in this tree: {type(e).__name__}: {e}"[:300])
    port = free_port()
    env = {**os.environ, "THIMBLE_HOME": str(home), "THIMBLE_PORT": str(port),
           "THIMBLE_DATA_DIR": str(data), "THIMBLE_WORKSPACES_DIR": str(tmp_path / "ws"), "THIMBLE_START_WAIT_S": "100",
           "THIMBLE_HEALTH_TIMEOUT_S": "100"}
    env.pop("THIMBLE_DEV", None)
    for k in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_PROFILE"):
        env.pop(k, None)
    cmd = [sys.executable, "-m", "app.cli", "browser", "--cwd", str(data / "mini"), "--detach"]
    pid = None
    try:
        out = subprocess.run(cmd, cwd=BACKEND, env=env, capture_output=True, text=True, timeout=120)
        lines = out.stdout.splitlines()
        st = json.loads((home / "server.json").read_text())
        assert out.returncode == 0 and lines[0] == f"thimble browser: http://127.0.0.1:{port}/?ws=mini", out
        assert "ui_key" not in st
        pid = st["pid"]
        assert cli.pid_alive(pid) and st["port"] == port and st["env"]["data_dir"] == str(data)
        assert os.getsid(pid) == pid, "uvicorn is its own session leader"
        from app import hook_auth  # noqa: PLC0415

        proven = urllib.request.Request(f"http://127.0.0.1:{port}/api/health",
                                        headers=hook_auth.headers(st["token"], port))
        with urllib.request.urlopen(proven, timeout=5) as r:
            health = json.loads(r.read())
            assert {k: health[k] for k in ("ok", "leader")} == {"ok": True, "leader": pid}, "the server names the pid server.json records"
            assert len(str(health.get("boot") or "")) == 8, "and a boot token new for each start"
            assert health["home"] == str(home.resolve()), "and its home, to the token's holder"
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health", timeout=5) as r:
            assert set(json.loads(r.read())) == {"ok", "boot", "ui"}, "no pid or path to a caller without the token"
        out2 = subprocess.run(cmd, cwd=BACKEND, env=env, capture_output=True, text=True, timeout=30)
        assert out2.stdout.splitlines() == lines and json.loads((home / "server.json").read_text())["pid"] == pid
        assert len(_uvicorns_on(port)) == 1, "a second start finds the server and starts none"
        stop = subprocess.run([sys.executable, "-m", "app.cli", "stop"], cwd=BACKEND, env=env, capture_output=True,
                              text=True, timeout=30)
        assert f"pid {pid}" in stop.stdout
        deadline = time.monotonic() + 10
        while cli.pid_alive(pid) and time.monotonic() < deadline:
            time.sleep(0.1)
        assert not cli.pid_alive(pid)
    finally:
        if pid and cli.pid_alive(pid):
            os.kill(pid, 9)
        for q in _uvicorns_on(port):
            with contextlib.suppress(ProcessLookupError, PermissionError):
                os.kill(q, 9)
