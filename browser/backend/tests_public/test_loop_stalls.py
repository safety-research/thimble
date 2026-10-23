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


def test_the_chat_list_reads_each_log_on_from_where_it_stopped(workspaces_tmp, monkeypatch):
    """The chat list is read again on every change to any chat, from the browser and from permission requests: each log
    is read on from where the last read stopped, and a log written again, cut short or holding a torn last line is still
    counted right."""
    import json

    from app import agents

    c = "mini"
    agents.ensure_main(c)
    _, log_path = agents.paths(c, agents.MAIN_ID)
    for i in range(500):
        agents.append(log_path, {"type": "user" if i % 2 else "text", "ts": f"t{i}", "text": "x" * 200})
    parsed = []
    loads = json.loads
    monkeypatch.setattr(agents.json, "loads", lambda s, *a, **k: parsed.append(1) or loads(s, *a, **k))

    def main_row() -> dict:
        return next(m for m in agents.list_chats(c) if m["id"] == agents.MAIN_ID)

    row = main_row()
    assert (row["n_messages"], row["last_ts"]) == (250, "t499")
    before = len(parsed)
    for _ in range(5):
        main_row()
    assert len(parsed) - before < 20, "a log that did not change is not parsed again"
    agents.append(log_path, {"type": "done", "ts": "t500"})
    with log_path.open("a") as f:
        f.write('{"type": "user", "ts": "t5')
    assert (main_row()["n_messages"], main_row()["last_ts"]) == (251, "t500"), "a torn last line waits for its end"
    with log_path.open("a") as f:
        f.write('01"}\n')
    assert (main_row()["n_messages"], main_row()["last_ts"]) == (252, "t501")
    rewritten = log_path.with_name("rewritten.tmp")
    rewritten.write_text("".join(json.dumps({"type": "user", "ts": f"r{i}"}) + "\n" for i in range(3)))
    rewritten.replace(log_path)
    assert (main_row()["n_messages"], main_row()["last_ts"]) == (3, "r2"), "a log written again is read again"
    log_path.write_text(json.dumps({"type": "chip", "ts": "s0"}) + "\n" + json.dumps({"type": "user", "ts": "s1"}) + "\n")
    assert (main_row()["n_messages"], main_row()["last_ts"]) == (2, "s1"), "a log cut short is read again"


def test_files_named_outright_are_found_without_walking_the_corpus(mini_dir, tmp_path, monkeypatch):
    """A walk of a corpus of a million files keeps a worker thread on the interpreter for seconds: files a label names
    outright are found by name, as the walk would find them, and a name the walk would treat otherwise still goes
    through it."""
    import shutil

    from app import concepts, corpus

    root = tmp_path / "c"
    shutil.copytree(mini_dir, root)
    (root / ".hidden").mkdir()
    (root / ".hidden" / "x.jsonl").write_text("{}\n")
    (root / "linked").symlink_to(root / "agents")
    corpus.forget_sources(root)
    named = [["board.jsonl"], ["agents/agent-01.jsonl", "board.jsonl#x", "board.jsonl"], ["forge.db#prs"],
             ["agents/agent-02.jsonl#a", "agents/agent-02.jsonl#b"]]
    by_name = getattr(corpus, "source_of", None)
    monkeypatch.setattr(corpus, "source_of", lambda *a: None, raising=False)
    want = [concepts.match_paths(root, p) for p in named]
    monkeypatch.setattr(corpus, "source_of", by_name, raising=False)
    walks = []
    real = corpus.list_sources
    monkeypatch.setattr(corpus, "list_sources", lambda *a, **k: walks.append(a) or real(*a, **k))
    assert [concepts.match_paths(root, p) for p in named] == want and not walks
    assert want[3][0]["under"] == ["a", "b"] and "under" not in want[1][1]
    for odd in (["agents"], [".hidden/x.jsonl"], ["linked/agent-01.jsonl"], ["agents/*.jsonl"], ["nothing.jsonl"]):
        walks.clear()
        assert concepts.match_paths(root, odd) == [s for s in real(root) if s["path"] == odd[0] or
                                                  s["path"].startswith(odd[0] + "/") or
                                                  (odd[0] == "agents/*.jsonl" and s["path"].startswith("agents/"))]
        assert walks, odd


async def test_health_answers_while_every_worker_thread_is_taken():
    """`server up` and the plugin give a health call 1 to 2 s: it is answered on the event loop, not after a worker
    thread frees up behind the requests that compute."""
    import asyncio
    import time

    import anyio
    import httpx

    from app.main import app

    limiter = anyio.to_thread.current_default_thread_limiter()
    tokens = limiter.total_tokens
    limiter.total_tokens = 1
    try:
        hold = asyncio.ensure_future(anyio.to_thread.run_sync(time.sleep, 3))
        await asyncio.sleep(0.2)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://127.0.0.1") as client:
            t0 = time.monotonic()
            r = await client.get("/api/health")
            took = time.monotonic() - t0
        await hold
    finally:
        limiter.total_tokens = tokens
    assert r.status_code == 200 and r.json()["ok"] and took < 1.0, f"health took {took:.1f} s"
