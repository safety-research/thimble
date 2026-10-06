"""Tests of helper/files.py, the file browser's views: `python3 tests/test_files.py` (Node 22.18 or newer for the render
check). A small folder of each kind: its tree (folders, kinds, records, the mod's own folder left out) and each file's
tabs in the order its kind asks, every view drawn within the panel by tools/render_view.mjs."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
MOD = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(MOD, "helper"))
import files  # noqa: E402


def corpus(d: str) -> None:
    os.makedirs(os.path.join(d, "runs", "r1"))
    os.makedirs(os.path.join(d, ".thimble-cc-mod", "cards"))
    with open(os.path.join(d, ".thimble-cc-mod", "cards", "x.json"), "w") as f:
        f.write("{}")
    with open(os.path.join(d, "chat.jsonl"), "w") as f:
        for i, (role, content) in enumerate([("user", "How many pages are there?"),
                                             ("assistant", [{"type": "text", "text": "Let me count."},
                                                            {"type": "tool_use", "name": "Bash", "input": {"command": "wc -l pages.jsonl"}}]),
                                             ("user", [{"type": "tool_result", "content": "4579 pages.jsonl\n"}]),
                                             ("assistant", "There are 4,579 pages.")]):
            f.write(json.dumps({"role": role, "content": content, "timestamp": f"2026-06-0{i + 1}T10:00:00Z"}) + "\n")
    with open(os.path.join(d, "pages.jsonl"), "w") as f:
        for i in range(30):
            f.write(json.dumps({"page_id": f"dse/P{i}", "wiki": ["dse", "probier"][i % 2], "n_revs": i, "first": "2026-06-01T00:00:00Z"}) + "\n")
        f.write("not json\n")
    with open(os.path.join(d, "runs", "r1", "votes.csv"), "w") as f:
        f.write("voter,choice,weight\n" + "".join(f"v{i},{'ab'[i % 2]},{i}\n" for i in range(12)))
    with open(os.path.join(d, "runs", "r1", "notes.md"), "w") as f:
        f.write("# Plan\n\nFirst line.\n\n## Risks\n\nA risk.\nAnother.\n")
    with open(os.path.join(d, "log.txt"), "w") as f:
        f.write("User: hello there\nAssistant: hi, how can I help\nUser: count the pages\nAssistant: 4,579\n")
    with open(os.path.join(d, "blob.bin"), "wb") as f:
        f.write(b"\x00\x01\x02" * 100)


def run(root: str, *args: str) -> dict:
    out = subprocess.run([sys.executable, os.path.join(MOD, "helper", "files.py"), *args, "--root", root],
                         capture_output=True, text=True, check=False)
    return json.loads(out.stdout.strip().splitlines()[-1])


def view(root: str, slug: str) -> tuple[dict, dict]:
    d = os.path.join(root, ".thimble-cc-mod", "files", slug)
    with open(os.path.join(d, "view.json")) as f:
        spec = json.load(f)
    with open(os.path.join(d, "rows.json")) as f:
        rows = json.load(f)
    return spec, rows


def drawn(root: str, slug: str) -> dict:
    d = os.path.join(root, ".thimble-cc-mod", "files", slug)
    out = subprocess.run(["node", os.path.join(MOD, "tools", "render_view.mjs"), "--spec", os.path.join(d, "view.json"),
                          "--rows", os.path.join(d, "rows.json"), "--check", "--builtin", "--width", "94", "--height", "40"],
                         capture_output=True, text=True, check=False)
    return json.loads(out.stdout)


def test_tree() -> None:
    with tempfile.TemporaryDirectory() as root:
        corpus(root)
        got = run(root, "tree")
        assert got["ok"] and got["slug"] == "files", got
        spec, rows = view(root, "files")
        by = {r["path"]: r for r in rows["collections"]["files"]}
        # the mod's own folder is left out
        assert sorted(by) == ["blob.bin", "chat.jsonl", "log.txt", "pages.jsonl", "runs/r1/notes.md", "runs/r1/votes.csv"]
        assert {p: r["kind"] for p, r in by.items()} == {"blob.bin": "binary", "chat.jsonl": "transcript", "log.txt": "transcript",
                                                          "pages.jsonl": "records", "runs/r1/notes.md": "markdown",
                                                          "runs/r1/votes.csv": "table"}
        assert by["pages.jsonl"]["records"] == 31 and by["runs/r1/votes.csv"]["records"] == 12 and by["blob.bin"]["records"] is None
        assert by["runs/r1/votes.csv"]["folder"].endswith("/runs/r1/") and spec["collections"][0]["opens"] == "path"
        assert drawn(root, "files")["ok"]


def test_transcript_first_with_tool_calls_folded() -> None:
    with tempfile.TemporaryDirectory() as root:
        corpus(root)
        got = run(root, "open", "chat.jsonl")
        assert got["ok"] and got["tabs"] == ["Transcript", "Table", "Raw"], got
        spec, rows = view(root, got["slug"])
        recs = rows["collections"]["records"]
        # a tool's result keeps the role the file gives it (the user's, in Claude's API); its kind tells it apart
        assert [r["speaker"] for r in recs] == ["user", "assistant", "user", "assistant"]
        assert [r["kind"] for r in recs] == ["message", "message", "tool result", "message"]
        assert recs[1]["said"] == "Let me count.\nBash wc -l pages.jsonl" and recs[1]["kind"] == "message"
        assert recs[2]["said"] == "◂ 4579 pages.jsonl" and recs[2]["ref"] == "chat.jsonl#L3"
        assert spec["up"] == "files" and spec["source"] == "chat.jsonl"
        assert drawn(root, got["slug"])["ok"]


def test_records_table_first_csv_markdown_and_chat_log() -> None:
    with tempfile.TemporaryDirectory() as root:
        corpus(root)
        got = run(root, "open", "pages.jsonl")
        assert got["tabs"] == ["Table", "Raw"], got
        spec, rows = view(root, got["slug"])
        table = spec["tabs"][0]
        assert table["overview"] == {"kind": "bars", "field": next(f["name"] for f in spec["collections"][0]["fields"] if f.get("label") == "wiki")}
        assert len(rows["collections"]["records"]) == 30 and len(rows["collections"]["lines"]) == 31
        assert "overview" not in spec["tabs"][1]
        csv_ = run(root, "open", "runs/r1/votes.csv")
        spec, rows = view(root, csv_["slug"])
        assert csv_["tabs"] == ["Table", "Raw"] and rows["collections"]["records"][0]["ref"] == "runs/r1/votes.csv#L2"
        md = run(root, "open", "runs/r1/notes.md")
        spec, rows = view(root, md["slug"])
        assert md["tabs"] == ["Raw"] and [r["section"] for r in rows["collections"]["lines"]] == ["Plan", "Plan", "Risks", "Risks", "Risks"]
        log = run(root, "open", "log.txt")
        spec, rows = view(root, log["slug"])
        assert log["tabs"] == ["Transcript", "Raw"] and [t["speaker"] for t in rows["collections"]["turns"]] == ["User", "Assistant", "User", "Assistant"]
        for g in (got, csv_, md, log):
            assert drawn(root, g["slug"])["ok"], g
        assert not run(root, "open", "blob.bin")["ok"] and not run(root, "open", "../etc/passwd")["ok"]


def test_written_again_only_when_the_file_changes() -> None:
    with tempfile.TemporaryDirectory() as root:
        corpus(root)
        assert not run(root, "open", "pages.jsonl").get("cached")
        assert run(root, "open", "pages.jsonl").get("cached")
        with open(os.path.join(root, "pages.jsonl"), "a") as f:
            f.write(json.dumps({"page_id": "dse/new", "wiki": "dse", "n_revs": 1, "first": "2026-06-02T00:00:00Z"}) + "\n")
        assert not run(root, "open", "pages.jsonl").get("cached")


def test_label_marks_on_records() -> None:
    with tempfile.TemporaryDirectory() as root:
        corpus(root)
        with open(os.path.join(root, ".thimble-cc-mod", "labels.json"), "w") as f:
            json.dump([{"name": "probier", "kind": "regex", "spec": "probier", "labels": ["yes", "no"], "paths": ["*.jsonl"]}], f)
        got = run(root, "open", "pages.jsonl")
        _, rows = view(root, got["slug"])
        marks = rows["labels"][0]["marks"]
        assert marks["pages.jsonl#L2"] == "yes" and marks["pages.jsonl#L1"] == "no"


def test_a_long_file_in_windows() -> None:
    with tempfile.TemporaryDirectory() as root:
        with open(os.path.join(root, "big.jsonl"), "w") as f:
            for i in range(250):
                f.write(json.dumps({"id": f"r{i}", "kind": ["a", "b"][i % 2]}) + "\n")
        old, files.WINDOW = files.WINDOW, 100
        try:
            out = os.path.join(root, ".thimble-cc-mod", "files", files.slug_of("big.jsonl"))
            assert files.open_file(root, "big.jsonl", out, files.window_start(1))["ok"]
            spec, rows = view(root, files.slug_of("big.jsonl"))
            assert spec["window"] == {"from": 1, "to": 100, "total": 250, "unit": "lines"}
            assert [r["n"] for r in rows["collections"]["records"]][::99] == [1, 100]
            # the window that holds line 230
            assert files.window_start(230) == 201
            files.open_file(root, "big.jsonl", out, files.window_start(230))
            spec, rows = view(root, files.slug_of("big.jsonl"))
            assert spec["window"] == {"from": 201, "to": 250, "total": 250, "unit": "lines"}
            assert rows["collections"]["lines"][0]["n"] == 201 and len(rows["collections"]["records"]) == 50
        finally:
            files.WINDOW = old


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print("ok", name)
