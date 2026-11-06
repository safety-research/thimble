"""The kernel's command, which needs only Python's standard library: it labels and counts coverage. Run: python3 -m
pytest plugin/tests"""
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


# ------------------------------------------------------------------ sources


# ------------------------------------------------------------------ coverage


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
