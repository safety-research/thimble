"""Tests of the coverage count (helper/coverage.py, helper/pyaudit): `python3 tests/test_coverage.py`."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
HELPER = os.path.join(os.path.dirname(HERE), "helper")
sys.path.insert(0, HELPER)
import coverage  # noqa: E402


def corpus(d: str) -> None:
    os.makedirs(os.path.join(d, "runs", "1"))
    os.makedirs(os.path.join(d, "runs", "2"))
    with open(os.path.join(d, "events.jsonl"), "w") as f:
        for i in range(1, 101):
            f.write(json.dumps({"event_id": f"ev-{i:04d}", "kind": "edit", "body": f"The agent number {i} rewrote the pricing page and left a note."}) + "\n")
    for r in ("1", "2"):
        with open(os.path.join(d, "runs", r, "log.txt"), "w") as f:
            f.write("".join(f"step {i} of run {r}: the agent ran the tests again\n" for i in range(1, 21)))
    with open(os.path.join(d, "notes.md"), "w") as f:
        f.write("# Notes\n\nNothing here yet.\n")


def test_read_tool_lines() -> None:
    with tempfile.TemporaryDirectory() as d:
        corpus(d)
        out = "".join(f"{n:>6}→line\n" for n in range(1, 11))
        got = coverage.reads_of(d, {"tool": "Read", "input": {"file_path": os.path.join(d, "events.jsonl")}, "output": out})
        assert got == [{"file": "events.jsonl", "how": "read", "lines": [[1, 10]]}], got


def test_bash_head_and_python_print() -> None:
    with tempfile.TemporaryDirectory() as d:
        corpus(d)
        lines = open(os.path.join(d, "events.jsonl")).read().splitlines()
        got = coverage.reads_of(d, {"tool": "Bash", "input": {"command": "head -n 3 events.jsonl"}, "output": "\n".join(lines[:3])})
        assert got == [{"file": "events.jsonl", "how": "read", "lines": [[1, 3]]}], got
        # a script that prints one field of records 50 and 51, cut short: the field's start is enough
        bodies = [json.loads(lines[i])["body"][:55] for i in (49, 50)]
        got = coverage.reads_of(d, {"tool": "Bash", "input": {"command": "python3 -c 'print(...)' events.jsonl"}, "output": "\n".join(bodies)})
        assert got == [{"file": "events.jsonl", "how": "read", "lines": [[50, 51]]}], got


def test_counting_and_globs() -> None:
    with tempfile.TemporaryDirectory() as d:
        corpus(d)
        got = coverage.reads_of(d, {"tool": "Bash", "input": {"command": "wc -l runs/*/log.txt"}, "output": "20 runs/1/log.txt\n20 runs/2/log.txt\n40 total"})
        assert got == [{"file": "runs/1/log.txt", "how": "scan"}, {"file": "runs/2/log.txt", "how": "scan"}], got
        got = coverage.reads_of(d, {"tool": "Bash", "input": {"command": "grep -rn 'step 7 ' runs | head"},
                                   "output": "runs/1/log.txt:7:step 7 of run 1: the agent ran the tests again"})
        assert {"file": "runs/1/log.txt", "how": "read", "lines": [[7, 7]]} in got, got
        assert {"file": "runs/2/log.txt", "how": "scan"} in got, got
        # ls lists without reading
        assert coverage.reads_of(d, {"tool": "Bash", "input": {"command": "ls -la runs/1"}, "output": "log.txt"}) == []
        # files named in a loop that a reader goes over
        log1 = open(os.path.join(d, "runs", "1", "log.txt")).read().splitlines()
        got = coverage.reads_of(d, {"tool": "Bash", "input": {"command": "for f in runs/1/log.txt notes.md; do echo == $f; sed -n '1,2p' $f | cut -c1-600; done"},
                                   "output": "== runs/1/log.txt\n" + "\n".join(log1[:2]) + "\n== notes.md\n# Notes\n"})
        assert {"file": "runs/1/log.txt", "how": "read", "lines": [[1, 2]]} in got and {"file": "notes.md", "how": "scan"} in got, got


def test_summary_and_line() -> None:
    with tempfile.TemporaryDirectory() as d:
        corpus(d)
        lines = open(os.path.join(d, "events.jsonl")).read().splitlines()
        coverage.record(d, [
            {"agent": "main", "tool": "Bash", "input": {"command": "head -n 10 events.jsonl"}, "output": "\n".join(lines[:10])},
            {"agent": "a1", "tool": "Bash", "input": {"command": "wc -l runs/1/log.txt"}, "output": "20 runs/1/log.txt"},
        ])
        s = coverage.summary(d)
        t = s["totals"]
        assert (t["files"], t["read"], t["scanned"], t["untouched"]) == (4, 1, 1, 2), t
        assert t["records_seen"] == 10 and t["records"] == 100 + 20 + 20 + 3, t
        assert coverage.line(s) == "read 1 of 4 files · 7.0% of records · 1 only counted by code · 2 never opened", coverage.line(s)
        mine = coverage.summary(d, ["a1"])["totals"]
        assert (mine["read"], mine["scanned"]) == (0, 1), mine
        txt = coverage.text(s)
        assert "notes.md" in txt and "never opened" in txt.splitlines()[2], txt


def test_a_prompt_label_counts_as_judged() -> None:
    with tempfile.TemporaryDirectory() as d:
        corpus(d)
        coverage.record(d, [{"agent": "label", "tool": "Label", "input": {"refs": [f"events.jsonl#L{n}" for n in range(1, 51)], "files": ["events.jsonl", "*.md"], "seen": ["events.jsonl#L7"]}, "output": ""}])
        s = coverage.summary(d)
        assert s["totals"]["records_judged"] == 50 and s["totals"]["records_seen"] == 1, s["totals"]
        assert coverage.line(s) == "read 1 of 4 files · 0.7% of records · 35% judged by a label · 1 only counted by code · 2 never opened", coverage.line(s)


def test_python_opens_are_noted() -> None:
    with tempfile.TemporaryDirectory() as d:
        corpus(d)
        env = {**os.environ, "THIMBLE_CC_MOD_ROOT": d, "PYTHONPATH": os.path.join(HELPER, "pyaudit")}
        script = "import glob\nfor p in glob.glob('runs/*/log.txt'):\n    open(p).read()\nprint('counted')\n"
        r = subprocess.run([sys.executable, "-c", script], cwd=d, env=env, capture_output=True, text=True)
        assert r.returncode == 0 and r.stdout.strip() == "counted", r
        got = coverage.reads_of(d, {"tool": "Bash", "input": {"command": "python3 count.py"}, "output": "counted"})
        assert sorted(x["file"] for x in got) == ["runs/1/log.txt", "runs/2/log.txt"] and all(x["how"] == "scan" for x in got), got
        # the offset moved on: the next call does not take them again
        assert coverage.reads_of(d, {"tool": "Bash", "input": {"command": "echo hi"}, "output": "hi"}) == []


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"ok {name}")
