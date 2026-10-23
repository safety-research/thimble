"""The locks of the stores more than one process writes (ledger.locked, calls_file): two processes that add cards to one
group keep every card, and a hook and the backend number calls in one sequence."""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

from app import config, ledger, notebook

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


def test_a_run_keeps_the_chat_another_process_credited_its_card_to(workspaces_tmp: Path) -> None:
    """_merge_cell: while a subagent's card runs (thimble-run), the mirror's process credits the card to the subagent's
    chat (agents.claim_cell); the run's save keeps that credit and its edits' authors, and writes its own state (live
    check T13: an orientation's cards were left credited to main's `terminal`)."""
    ws = config.workspace_dir("mini")
    nb = notebook.create_notebook(ws, "Orientation")
    first = notebook.insert_cell("mini", nb["id"], notebook.new_cell("code", notebook.TERMINAL_CREATOR, "q", nb["id"],
                                                                     code="1"))
    held = json.loads(json.dumps(notebook.read_notebook(ws, nb["id"])))  # what thimble-run held while the code ran
    data = json.loads(notebook._nb_file(ws, nb["id"]).read_text())
    data["cells"][0]["created_by"] = "chat:abc12345"  # the mirror's claim, from another process
    data["cells"][0]["edited"] = [{"by": "chat:abc12345", "ts": "2026-10-06T21:17:00+00:00"}]
    ledger.atomic_write_text(notebook._nb_file(ws, nb["id"]), json.dumps(data))
    cell = next(c for c in held["cells"] if c["id"] == first["id"])
    assert cell["created_by"] == notebook.TERMINAL_CREATOR
    cell.update(status="ok", outputs=[{"output_type": "stream", "name": "stdout", "text": "1\n"}])
    notebook._merge_cell(ws, held, cell)
    stored = json.loads(notebook._nb_file(ws, nb["id"]).read_text())["cells"][0]
    assert stored["created_by"] == "chat:abc12345" and stored["edited"][0]["by"] == "chat:abc12345"
    assert stored["status"] == "ok" and stored["outputs"][0]["text"] == "1\n"


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
