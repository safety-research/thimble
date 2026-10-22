"""Focused tests of the kernel: stable row ids per source kind, row sets, coverage from what the hooks saw, and the
command, which needs only Python's standard library. Run: python3 -m pytest plugin/tests"""
from __future__ import annotations

import csv
import json
import os
import sqlite3
import subprocess
import sys
from pathlib import Path

import pytest

ENGINE = Path(__file__).resolve().parents[1] / "engine"
sys.path.insert(0, str(ENGINE))

from kernel import coverage as CV  # noqa: E402
from kernel import refs as R  # noqa: E402
from kernel import sources as S  # noqa: E402
from kernel.store import Store  # noqa: E402

DAYS = ["2026-06-01"] * 3 + ["2026-06-02"] * 5 + ["2026-06-03"] * 2
THIMBLE = Path(__file__).resolve().parents[1] / "bin" / "thimble"


@pytest.fixture()
def root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    d = tmp_path / "data"
    d.mkdir()
    with open(d / "saves.jsonl", "w") as f:
        for i, day in enumerate(DAYS):
            f.write(json.dumps({"id": i, "time": f"{day}T10:00:00Z", "user": "ann" if i % 2 else "bo", "body": f"save number {i}"}) + "\n")
    with open(d / "runs.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["run", "passed"])
        w.writerows([["a", "1"], ["b", "0"], ["c", "1"]])
    (d / "report.json").write_text(json.dumps({"name": "r", "messages": [{"role": "user", "text": "hi"}, {"role": "assistant", "text": "PRECISION ALERT"}]}))
    con = sqlite3.connect(d / "forge.db")
    con.execute("create table prs (title text, state text)")
    con.executemany("insert into prs values (?, ?)", [("fix", "merged"), ("docs", "closed"), ("perf", "merged")])
    con.commit()
    con.close()
    (d / "notes.md").write_text("# Notes\nintro line\n\n## Findings\nthe swarm stalled\non day two\n")
    (d / "change.diff").write_text("diff --git a/x.py b/x.py\n--- a/x.py\n+++ b/x.py\n@@ -1,2 +1,3 @@\n a\n-b\n+c\n+d\n")
    with open(d / "agent.jsonl", "w") as f:
        f.write(json.dumps({"type": "system", "subtype": "init", "session_id": "s"}) + "\n")
        f.write(json.dumps({"type": "assistant", "message": {"content": [{"type": "text", "text": "I will run the tests"},
                                                                         {"type": "tool_use", "name": "Bash", "input": {"command": "pytest"}}]}}) + "\n")
    monkeypatch.setenv("THIMBLE_HOME", str(tmp_path / "th"))
    monkeypatch.setenv("THIMBLE_SESSION", "s-test")
    monkeypatch.delenv("THIMBLE_ROOT", raising=False)
    return d


# ------------------------------------------------------------------ refs


def test_refs_parse_rows_and_row_sets() -> None:
    kinds = {"a.jsonl#L3": "lines", "a.jsonl#L1-3,7": "lines", "x.csv#row=2": "csvrows", "f.db#prs/2": "dbrows",
             "f.db#prs": "table", "r.json#/messages/1": "pointer", "notes.md": "file", "budget.xlsx#Q3!B2": "file"}
    assert {ref: R.parse(ref)["kind"] for ref in kinds} == kinds
    assert R.parse("a.jsonl#L1-3,7")["nums"] == [1, 2, 3, 7]
    assert R.parse("a.jsonl#L3-L9")["nums"] == list(range(3, 10))
    with pytest.raises(R.RefError):
        R.parse("a.jsonl#L3-x")  # a mistyped line ref is an error, not the whole file
    assert R.parse("notes.md#Findings") == {"kind": "file", "path": "notes.md", "locator": "Findings"}


# ------------------------------------------------------------------ sources


def test_every_kind_has_rows_with_stable_ids(root: Path) -> None:
    sources = [f for f in S.list_files(root) if S.kind_of(root / f)]
    refs = {rel: [r.ref for r in S.iter_rows(root, rel)] for rel in sources}
    assert refs["saves.jsonl"][:2] == ["saves.jsonl#L1", "saves.jsonl#L2"]
    assert refs["runs.csv"] == ["runs.csv#row=1", "runs.csv#row=2", "runs.csv#row=3"]
    assert refs["report.json"] == ["report.json#/messages/0", "report.json#/messages/1"]
    assert refs["forge.db"] == ["forge.db#prs/1", "forge.db#prs/2", "forge.db#prs/3"]
    assert refs["notes.md"] == ["notes.md#L1-3", "notes.md#L4-6"]
    assert refs["change.diff"] == ["change.diff#L4-8"]
    assert S.kind_of_file(root, "agent.jsonl") == "transcript"
    again = {rel: [r.ref for r in S.iter_rows(root, rel)] for rel in sources}
    assert again == refs
    # a JSONL file's records read back by their lines, the same text
    assert [r.raw for r in S.json_lines(root, "saves.jsonl", {2, 9})] == [r.raw for r in S.iter_rows(root, "saves.jsonl")][1:9:7]
    hunk = next(S.iter_rows(root, "change.diff")).value
    assert (hunk["file"], hunk["added"], hunk["removed"]) == ("x.py", 2, 1)


# ------------------------------------------------------------------ coverage


def test_coverage_merges_what_the_hook_saw(root: Path, tmp_path: Path) -> None:
    st = Store(root)
    seen = tmp_path / "th" / "seen"
    seen.mkdir(parents=True)
    rows = [{"tool": "Read", "file": str(root / "saves.jsonl"), "from": 1, "to": 4, "cwd": str(root)},
            {"tool": "Grep", "path": str(root), "glob": "*.md", "mode": "content", "files": [str(root / "notes.md")],
             "lines": {str(root / "notes.md"): [4]}, "cwd": str(root)},
            {"tool": "Bash", "command": "head -2 change.diff", "out_lines": 2, "cwd": str(root)},
            {"tool": "Bash", "command": "wc -l agent.jsonl", "out_lines": 1, "cwd": str(root)}]
    (seen / "s-test.jsonl").write_text("\n".join(json.dumps(r) for r in rows) + "\n")
    cov = CV.coverage(st)
    status = {o["path"]: o["status"] for o in cov["files"]}
    assert status == {"saves.jsonl": "seen", "notes.md": "seen", "change.diff": "seen", "agent.jsonl": "computed"}
    assert sorted(cov["untouched"]["path"]) == ["forge.db", "report.json", "runs.csv"]
    saves = next(o for o in cov["files"] if o["path"] == "saves.jsonl")
    assert saves["seen_lines"] == 4
    assert next(o for o in cov["files"] if o["path"] == "change.diff")["seen_lines"] == 2
    assert next(o for o in cov["files"] if o["path"] == "notes.md")["hit_lines"] == [4]
    # a counted file is not seen
    assert cov["total"]["not_seen_files"] == 4 and cov["total"]["seen_files"] == 3 and cov["total"]["touched_files"] == 4
    assert "Not read: 4 files" in CV.coverage_text(cov)


# ------------------------------------------------------------------ the command


def run(root: Path, *args: str) -> subprocess.CompletedProcess:
    # the root is pinned: a thimble/ store in a folder above the test's (as /tmp can hold) must not take it
    env = {**os.environ, "THIMBLE_PYTHON": sys.executable, "THIMBLE_ROOT": str(root)}
    return subprocess.run([str(THIMBLE), *args], text=True, capture_output=True, cwd=root, env=env, timeout=120)


def test_the_command_labels_and_counts_coverage(root: Path) -> None:
    out = run(root, "label", "busy", "--in", "saves.jsonl", "--regex", "number [0-4]$")
    assert out.returncode == 0, out.stderr
    assert "busy: yes 5 · no 5 of 10 records" in out.stdout
    assert "busy: yes 5 · no 5 of 10 records" in run(root, "label", "busy").stdout
    cov = run(root, "coverage")
    assert cov.returncode == 0, cov.stderr
    # the rule label went over every record of saves.jsonl, and none of it entered Claude's context
    assert "saves.jsonl  computed over all 10 records (busy); Claude read none of it" in cov.stdout


def test_the_command_lists_only_what_stays(root: Path) -> None:
    out = run(root, "--help")
    assert out.returncode == 0
    assert "thimble label" in out.stdout and "thimble coverage" in out.stdout and "thimble fix" in out.stdout
    for gone in ("thimble run", "thimble rows", "thimble save"):
        assert gone not in out.stdout
    bad = run(root, "rows")
    assert bad.returncode == 2 and "the commands are label, coverage, claims and fix" in bad.stderr
