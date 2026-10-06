"""The locks of the stores more than one process writes (ledger.locked, calls_file): two processes that add cards to one
group keep every card, and a hook and the backend number calls in one sequence."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

from app import calls, calls_file, config, ledger, notebook

BACKEND = Path(__file__).resolve().parents[1]

# a process that adds `n` note cards to one group of a workspace folder, as thimble-run and the shim each write cards
ADDER = """
import asyncio, sys
sys.path.insert(0, {backend!r})
from pathlib import Path
from app import config, notebook
ws, group, tag, n = Path(sys.argv[1]), sys.argv[2], sys.argv[3], int(sys.argv[4])
config.workspace_dir = lambda c: ws
async def main():
    for i in range(n):
        notebook.insert_cell(ws, group, notebook.new_cell("note", "test", f"{{tag}}{{i}}", group, payload={{"text": f"{{tag}}{{i}}"}}))
        await asyncio.sleep(0)
asyncio.run(main())
"""


def _group(ws: Path) -> str:
    (ws / "notebooks").mkdir(parents=True)
    (ws / "notebooks" / "g1.json").write_text(json.dumps({"id": "g1", "title": "G", "cells": []}))
    return "g1"


def test_two_processes_adding_cards_to_one_group_keep_every_card(tmp_path: Path) -> None:
    ws = tmp_path / "ws"
    group = _group(ws)
    script = tmp_path / "adder.py"
    script.write_text(ADDER.format(backend=str(BACKEND)))
    procs = [subprocess.Popen([sys.executable, str(script), str(ws), group, tag, "15"]) for tag in ("a", "b")]
    assert [p.wait(timeout=120) for p in procs] == [0, 0]
    cells = json.loads((ws / "notebooks" / "g1.json").read_text())["cells"]
    assert len(cells) == 30
    assert sorted(c["title"] for c in cells) == sorted([f"a{i}" for i in range(15)] + [f"b{i}" for i in range(15)])
    assert (ws / "notebooks" / ".lock").exists()  # the folder's lock file, inside the folder main's sandbox may write


def test_a_run_saves_into_the_group_as_another_process_left_it(workspaces_tmp: Path) -> None:
    """_merge_cell: a cell saved from a group loaded before another process added a card keeps that card."""
    ws = config.workspace_dir("mini")
    nb = notebook.create_notebook(ws, "G")
    first = notebook.insert_cell("mini", nb["id"], notebook.new_cell("code", "test", "q", nb["id"], code="1"))
    held = json.loads(json.dumps(notebook.read_notebook(ws, nb["id"])))  # what a run held across its awaits
    # another process adds a card: the file changes under the cache
    data = json.loads(notebook._nb_file(ws, nb["id"]).read_text())
    data["cells"].append(notebook.new_cell("note", "other", "other", nb["id"], payload={"text": "x"}))
    ledger.atomic_write_text(notebook._nb_file(ws, nb["id"]), json.dumps(data))
    cell = next(c for c in held["cells"] if c["id"] == first["id"])
    cell["status"] = "running"
    stored, target = notebook._merge_cell(ws, held, cell)
    titles = [c["title"] for c in json.loads(notebook._nb_file(ws, nb["id"]).read_text())["cells"]]
    assert titles == ["q", "other"] and target["status"] == "running"


def test_locked_is_reentrant_and_gives_up_after_its_wait(tmp_path: Path) -> None:
    store = tmp_path / "store.json"
    with ledger.locked(store) as held:
        assert held
        with ledger.locked(store) as again:  # the same thread takes it again at once
            assert again
    assert ledger.lock_file(store) == tmp_path / "store.json.lock"
    assert ledger.lock_file(tmp_path) == tmp_path / ".lock"
    # another process holds it: a writer waits `wait_s`, then goes on without it
    holder = subprocess.Popen([sys.executable, "-c", (
        "import fcntl, os, sys, time\n"
        f"fd = os.open({str(store) + '.lock'!r}, os.O_RDWR | os.O_CREAT)\n"
        "fcntl.flock(fd, fcntl.LOCK_EX)\n"
        "print('held', flush=True)\n"
        "time.sleep(30)\n")], stdout=subprocess.PIPE, text=True)
    try:
        assert holder.stdout.readline().strip() == "held"
        t0 = time.monotonic()
        with ledger.locked(store, wait_s=0.3) as held:
            assert held is False
        assert 0.25 <= time.monotonic() - t0 < 3
    finally:
        holder.kill()
        holder.wait()


def test_threads_of_one_process_take_turns(tmp_path: Path) -> None:
    store = tmp_path / "count.json"
    store.write_text("0")

    def bump() -> None:
        for _ in range(50):
            ledger.update_json(store, lambda n: (n or 0) + 1, 0)

    ts = [threading.Thread(target=bump) for _ in range(4)]
    for t in ts:
        t.start()
    for t in ts:
        t.join()
    assert json.loads(store.read_text()) == 200


# a hook's process numbering calls with calls_file alone (standard library), as `--agents` does in terminal mode
HOOK = """
import sys
sys.path.insert(0, {backend!r})
from pathlib import Path
from app import calls_file
ws = Path(sys.argv[1])
for i in range(int(sys.argv[2])):
    calls_file.number(ws, "orient1", f"toolu_hook_{{i}}", "Bash", {{"command": "echo"}}, "agent-x")
"""


def test_a_hook_and_the_backend_number_calls_in_one_sequence(workspaces_tmp: Path, tmp_path: Path) -> None:
    ws = config.workspace_dir("mini")
    script = tmp_path / "hook.py"
    script.write_text(HOOK.format(backend=str(BACKEND)))
    calls.forget()
    hook = subprocess.Popen([sys.executable, str(script), str(ws), "40"])
    mine = [calls.number("mini", "orient1", f"toolu_main_{i}", "Read", {"file_path": "x"}) for i in range(40)]
    assert hook.wait(timeout=60) == 0
    assert len(set(mine)) == 40
    by_id, top = calls_file.scan(calls_file.path(ws, "orient1"))
    assert top == 80 and sorted(by_id.values()) == list(range(1, 81))
    # the backend sees the hook's numbers too, and a call the hook numbered keeps its number
    assert calls.number("mini", "orient1", "toolu_hook_7", "Bash") == by_id["toolu_hook_7"]
    assert calls.get("mini", "orient1", by_id["toolu_hook_7"])["agent"] == "agent-x"
    calls.result("mini", "orient1", "toolu_hook_7", "out\n")
    assert calls.get("mini", "orient1", by_id["toolu_hook_7"])["result"] == "out\n"
    assert calls_file.number(ws, "orient1", "toolu_main_3", "Read") == mine[3]


def test_chat_meta_changes_from_two_processes_both_land(workspaces_tmp: Path, tmp_path: Path) -> None:
    from app import agents

    meta = agents.new_thread("mini", "card:abc", "x")
    script = tmp_path / "meta.py"
    script.write_text(
        "import sys\n"
        f"sys.path.insert(0, {str(BACKEND)!r})\n"
        "from pathlib import Path\n"
        "from app import agents, config\n"
        f"config.WORKSPACES_DIR = Path({str(config.WORKSPACES_DIR)!r})\n"
        "for i in range(30):\n"
        f"    agents.change_meta('mini', {meta['id']!r}, lambda m, i=i: m.setdefault('a', []).append(i))\n")
    env = {**os.environ, "THIMBLE_WORKSPACES_DIR": str(config.WORKSPACES_DIR)}
    other = subprocess.Popen([sys.executable, str(script)], env=env)
    for i in range(30):
        agents.change_meta("mini", meta["id"], lambda m, i=i: m.setdefault("b", []).append(i))
    assert other.wait(timeout=60) == 0
    got = agents.read_meta("mini", meta["id"])
    assert got["a"] == list(range(30)) and got["b"] == list(range(30))
