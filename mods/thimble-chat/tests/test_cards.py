"""The card helper writes to the session's folder and draws diagrams: `python3 tests/test_cards.py` (no dependencies)."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
HELPER = os.path.join(os.path.dirname(HERE), "helper")
sys.path.insert(0, HELPER)
from refs import resolve  # noqa: E402


def _script(root: str, body: str) -> str:
    os.makedirs(os.path.join(root, ".thimble-chat", "scripts"), exist_ok=True)
    path = os.path.join(root, ".thimble-chat", "scripts", "c.py")
    with open(path, "w") as f:
        f.write(f"import sys; sys.path.insert(0, {HELPER!r}); from tcard import card\n{body}\n")
    return path


def _run(path: str, cwd: str, env: dict | None = None) -> str:
    clean = {k: v for k, v in os.environ.items() if k != "THIMBLE_CHAT_ROOT"}
    return subprocess.run([sys.executable, path], cwd=cwd, env={**clean, **(env or {})}, capture_output=True, text=True,
                          check=True).stdout


def _cards(root: str) -> list[str]:
    folder = os.path.join(root, ".thimble-chat", "cards")
    return sorted(os.listdir(folder)) if os.path.isdir(folder) else []


def test_cards_go_to_the_session_folder_wherever_the_script_runs() -> None:
    with tempfile.TemporaryDirectory() as root, tempfile.TemporaryDirectory() as elsewhere:
        path = _script(root, "card('bar', 'How many?', rows=[('a', 1)])")
        # run from another folder: the script's own .thimble-chat names the session folder
        _run(path, elsewhere)
        assert len(_cards(root)) == 1 and not _cards(elsewhere)
        with open(os.path.join(root, ".thimble-chat", "cards", _cards(root)[0])) as f:
            assert json.load(f)["source"]["script"] == os.path.join(".thimble-chat", "scripts", "c.py")
        # THIMBLE_CHAT_ROOT, which the mod sets for the session, wins
        with tempfile.TemporaryDirectory() as session:
            out = _run(path, elsewhere, {"THIMBLE_CHAT_ROOT": session})
            assert len(_cards(session)) == 1 and session in out


def test_a_script_outside_the_folder_finds_the_nearest_thimble_chat_up() -> None:
    with tempfile.TemporaryDirectory() as root, tempfile.TemporaryDirectory() as scripts:
        os.makedirs(os.path.join(root, ".thimble-chat"))
        os.makedirs(os.path.join(root, "data", "sub"))
        path = os.path.join(scripts, "x.py")
        with open(path, "w") as f:
            f.write(f"import sys; sys.path.insert(0, {HELPER!r}); from tcard import card\ncard('bar', 'Q', rows=[('a', 1)])\n")
        _run(path, os.path.join(root, "data", "sub"))
        assert len(_cards(root)) == 1
        with open(os.path.join(root, ".thimble-chat", "cards", _cards(root)[0])) as f:
            assert json.load(f)["source"]["script"] == path  # outside the folder: kept whole


def test_diagram_nodes_edges_refs_and_values() -> None:
    with tempfile.TemporaryDirectory() as root:
        with open(os.path.join(root, "events.jsonl"), "w") as f:
            f.write('{"who": "planner"}\n')
        path = _script(root, (
            "card('diagram', 'Who hands work to whom?', nodes=[('p', 'Planner', 'events.jsonl#L1'), 'Coder'],\n"
            "     edges=[('p', 'Coder', 'assigns'), ('Coder', 'Reviewer')])"))
        out = _run(path, root)
        assert "(diagram, 3 nodes)" in out and "[[events.jsonl#L1]]" in out
        name = _cards(root)[0]
        with open(os.path.join(root, ".thimble-chat", "cards", name)) as f:
            c = json.load(f)
        assert [n["id"] for n in c["nodes"]] == ["p", "Coder", "Reviewer"]
        assert c["nodes"][0] == {"id": "p", "label": "Planner", "ref": "events.jsonl#L1"}
        assert c["edges"] == [{"source": "p", "target": "Coder", "label": "assigns"}, {"source": "Coder", "target": "Reviewer"}]
        cid = name[:-5]
        assert resolve(root, f"card:{cid}#node/p", "Planner")["status"] == "ok"
        assert resolve(root, f"card:{cid}#edge/1")["status"] == "ok"
        # a node's ref must resolve
        bad = _script(root, "card('diagram', 'Bad', nodes=[('p', 'P', 'events.jsonl#L9')])")
        r = subprocess.run([sys.executable, bad], cwd=root, capture_output=True, text=True)
        assert r.returncode != 0 and "does not resolve" in r.stderr


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"ok {name}")
