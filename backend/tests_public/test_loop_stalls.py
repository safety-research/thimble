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
    """The chat list is read again on every change to any chat, from the browser and from permission requests, so each
    log is read on from where the last read stopped and not parsed whole each time; a log written again, cut short or
    holding a torn last line is still counted right."""
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


def test_a_long_command_is_read_word_by_word_only_when_it_names_an_install(monkeypatch):
    """Every Bash call of every agent is checked for installs on the event loop, up to three times, and shlex takes
    about a second for a 200 KB script: a command line that names no install word is not read with it, and the answer
    is the same."""
    from app import sandbox_allow

    lexed = []
    real = sandbox_allow.shlex.shlex
    monkeypatch.setattr(sandbox_allow.shlex, "shlex", lambda *a, **k: lexed.append(1) or real(*a, **k))
    script = "python3 -c 'import json\n" + "".join(f"rows{i} = [json.loads(l) for l in open(\"f{i}.jsonl\")]\n"
                                                   for i in range(3000)) + "'"
    getattr(sandbox_allow.installs, "cache_clear", lambda: None)()
    assert not sandbox_allow.installs(script) and not lexed
    for line, want in ((script + " && pip install pandas", True), (script + " && curl$(echo -O) u", True),
                       ('cd x && "cu"rl -O u', True), ("echo pip-install is a word", False)):
        assert sandbox_allow.installs(line) is want, line[-40:]


def test_the_event_log_is_read_on_from_where_it_was_left(workspaces_tmp, monkeypatch):
    """Every record on the workspace stream read the log's tail again for another process's records, and every open
    stream parsed the whole log every 3 s for them: the log is read again only when another process wrote to it, and a
    stream reads only what was appended since its last read."""
    import asyncio
    import json

    from app import investigation

    c = "mini"
    tails = []
    real = investigation._last_stored_seq
    monkeypatch.setattr(investigation, "_last_stored_seq", lambda p: tails.append(1) or real(p))

    async def emit_some(n: int) -> None:
        for i in range(n):
            investigation.emit(c, investigation.MAIN, {"type": "chat", "chat": f"x{i}"})

    asyncio.run(emit_some(1))
    tails.clear()
    asyncio.run(emit_some(30))
    assert len(tails) == 0, "records of this process alone read no tail"
    log = investigation.inv_dir(c, investigation.MAIN) / "events.jsonl"
    pos = log.stat().st_size
    with log.open("a") as f:
        f.write(json.dumps({"type": "chat", "chat": "other", "seq": 100}) + "\n" + '{"type": "chat", "se')
    fresh, end = investigation._read_jsonl_after(log, pos)
    assert [e["seq"] for e in fresh] == [100] and end == pos + len(json.dumps({"type": "chat", "chat": "other", "seq": 100})) + 1
    asyncio.run(emit_some(1))
    assert len(tails) == 1 and json.loads(log.read_text().splitlines()[-1])["seq"] == 101, \
        "a record another process wrote is seen, and the next seq follows it"
    assert investigation._read_jsonl_after(log, log.stat().st_size + 10)[1] == log.stat().st_size, \
        "a log written again is read from its start"


def test_a_chat_read_again_is_not_parsed_again(workspaces_tmp, monkeypatch):
    """The browser reads the open chat again on each of its records: the route answers the log's records as read_events
    reads them, NaN as null, and a reload parses only the records added since the last."""
    import json

    from fastapi.testclient import TestClient

    from app import agents
    from app.main import app

    c = "mini"
    agents.ensure_main(c)
    _, log_path = agents.paths(c, agents.MAIN_ID)
    for i in range(300):
        agents.append(log_path, {"type": "text", "ts": f"t{i}", "text": f"reply {i} ü", "n": i})
    agents.append(log_path, {"type": "text", "ts": "nan", "score": float("nan")})
    with TestClient(app, base_url="http://127.0.0.1") as client:
        got = client.get(f"/api/ws/{c}/chats/{agents.MAIN_ID}").json()
        want = agents.read_events(log_path)
        want[-1]["score"] = None
        assert got["events"] == want and got["meta"]["id"] == agents.MAIN_ID
        parsed = []
        loads = json.loads
        monkeypatch.setattr(agents.json, "loads", lambda s, *a, **k: parsed.append(1) or loads(s, *a, **k))
        agents.append(log_path, {"type": "user", "ts": "last", "text": "one more"})
        got = client.get(f"/api/ws/{c}/chats/{agents.MAIN_ID}").json()
    assert got["events"][-1]["text"] == "one more" and len(got["events"]) == 302
    assert len(parsed) < 10, "the records read before are not parsed again"


def test_files_named_outright_are_found_without_walking_the_corpus(mini_dir, tmp_path, monkeypatch):
    """A label over named files walked every file of the corpus to find them, seconds of a worker thread holding the
    interpreter on a corpus of a million files: files named outright are found by name, as the walk would find them,
    and a name the walk would treat otherwise still goes through it."""
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


def test_a_labels_coverage_is_encoded_a_part_at_a_time(workspaces_tmp, monkeypatch):
    """A label's coverage lists every file of the corpus, 160 MB for a million files, which one encode held every thread
    for: it is encoded in parts off the event loop, and reads as coverage() gives it."""
    import json

    from app import concepts, config

    ws = config.workspace_dir("mini")
    concept = concepts.new_concept("covered", kind="regex", spec="x")
    concepts.write_concept(ws, concept)
    monkeypatch.setattr(concepts, "JSON_CHUNK", 2)
    got = json.loads(concepts._coverage_json(ws, concept))
    assert got == json.loads(json.dumps(concepts.coverage(ws, concept))) and len(got["files"]) > 4


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


def test_lines_read_from_a_chunk_are_the_lines_a_whole_split_gives(tmp_path):
    """Lines are found a newline at a time rather than by splitting their whole chunk (up to 8 MB, which held the
    interpreter for every record read): any range reads as the split read it, CRLF and a last line without its newline
    included."""
    import random

    from app import corpus

    def split_read(idx, path, start, end):
        start, end = max(1, start), min(end, len(idx))
        if start > end:
            return []
        first, begin, stop = idx.chunk_span(start, end)
        lines = path.read_bytes()[begin:stop].split(b"\n")
        if lines and lines[-1] == b"":
            lines.pop()
        return [ln[:-1] if ln.endswith(b"\r") else ln for ln in lines][start - first:end - first + 1]

    rnd = random.Random(7)
    for k in range(4):
        path = tmp_path / f"f{k}.jsonl"
        data = b"".join(b"x" * rnd.randint(0, 80) + rnd.choice([b"\n", b"\r\n", b"\n\n"]) for _ in range(9000))
        path.write_bytes(data.rstrip(b"\n") if k % 2 else data)
        idx = corpus.line_offsets(path)
        assert idx.n_marks > 2
        for _ in range(200):
            a = rnd.randint(-1, len(idx) + 2)
            b = a + rnd.randint(-1, 300)
            assert corpus._index_lines(idx, path, a, b) == split_read(idx, path, a, b), (k, a, b)
