"""Heavy work must not hold the server's event loop: other requests are answered while agents, model calls and label
runs go on. Each test measures how long the loop goes without a turn while the work runs."""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

from app import cli

BACKEND = Path(__file__).resolve().parents[1]

# A uvicorn server on the loop the server's command names: its startup grows the process to BALLAST_MB, starts SPAWNS
# children at once as model calls and kernels do, and prints the longest gap between two turns of the loop meanwhile.
LOOP_CHILD = r"""
import asyncio, os, sys, time, uvicorn
loop_kind, mb, n = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])

async def app(scope, receive, send):
    if scope["type"] != "lifespan":
        return
    await receive()
    ballast = bytearray(mb * 2**20)
    for i in range(0, len(ballast), 4096):
        ballast[i] = 1
    gap, running = [0.0], [True]

    async def turns():
        while running[0]:
            t = time.perf_counter()
            await asyncio.sleep(0.005)
            gap[0] = max(gap[0], time.perf_counter() - t - 0.005)

    sampler = asyncio.ensure_future(turns())
    await asyncio.sleep(0.05)
    procs = await asyncio.gather(*[asyncio.create_subprocess_exec("true") for _ in range(n)])
    await asyncio.gather(*[p.wait() for p in procs])
    running[0] = False
    await sampler
    print(f"{gap[0]:.4f}", flush=True)
    os._exit(0)

uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=0, loop=loop_kind, lifespan="on", log_level="warning")).run()
"""


def _server_loop() -> str:
    cmd = cli.backend_cmd(8300)
    return cmd[cmd.index("--loop") + 1] if "--loop" in cmd else "auto"


def test_starting_children_does_not_hold_the_servers_loop():
    """A server grown large (as on a big corpus) starting 24 children at once keeps its loop turning: uvloop forks the
    whole process for each child, about 0.5 s of held loop here and seconds at the 3 GB a long run reaches."""
    r = subprocess.run([sys.executable, "-c", LOOP_CHILD, _server_loop(), "384", "24"], cwd=str(BACKEND),
                       capture_output=True, text=True, timeout=120)
    assert r.returncode == 0, r.stderr[-2000:]
    gap = float(r.stdout.strip().splitlines()[-1])
    assert gap < 0.15, f"the loop went {gap:.2f} s without a turn while 24 children started"
