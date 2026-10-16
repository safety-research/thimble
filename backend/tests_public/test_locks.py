"""The locks of the stores more than one process writes (ledger.locked, calls_file): two processes that add cards to one
group keep every card, and a hook and the backend number calls in one sequence."""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

from app import calls, calls_file, config

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
