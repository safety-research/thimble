"""Focused tests of the lean kernel: stable row ids per source kind, row sets, query lineage, objects with lineage,
resolving a value to its rows, and coverage. Run: LEAN_PYTHON-or-any-python-with-pandas -m pytest lean/tests"""
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

from kernel import lineage as LIN  # noqa: E402
from kernel import objects as O  # noqa: E402
from kernel import query as Q  # noqa: E402
from kernel import refs as R  # noqa: E402
from kernel import sources as S  # noqa: E402
from kernel.store import Store  # noqa: E402

DAYS = ["2026-06-01"] * 3 + ["2026-06-02"] * 5 + ["2026-06-03"] * 2


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
    monkeypatch.setenv("LEAN_SESSION", "s-test")
    monkeypatch.delenv("LEAN_ROOT", raising=False)
    return d


# ------------------------------------------------------------------ refs


def test_refs_round_trip_and_row_sets() -> None:
    for ref in ["a.jsonl#L3", "a.jsonl#L3-9", "x.csv#row=2", "f.db#prs/2", "f.db#prs", "r.json#/messages/1",
                "r.json#/a/b", "t.jsonl#L4.b1", "notes.md", "budget.xlsx#Q3!B2"]:
        assert R.format_source(R.parse(ref)) == ref
    assert R.parse("a.jsonl#L3-L9")["nums"] == list(range(3, 10))
    assert R.compress(["a.jsonl#L1", "a.jsonl#L2", "a.jsonl#L3", "a.jsonl#L7", "b.csv#row=4", "f.db#prs/1", "f.db#prs/2"]) == [
        "a.jsonl#L1-3,7", "b.csv#row=4", "f.db#prs/1-2"]
    assert R.expand(["a.jsonl#L1-3,7"]) == ["a.jsonl#L1", "a.jsonl#L2", "a.jsonl#L3", "a.jsonl#L7"]
    assert R.count(["a.jsonl#L1-3,7", "f.db#prs/1-2"]) == 6
    p = R.parse("q3#day=2026-06-16&wiki=dse@n")
    assert p == {"kind": "query", "query": "q3", "keys": {"day": "2026-06-16", "wiki": "dse"}, "col": "n"}
    assert R.parse("obj:03-saves#/days/4/n") == {"kind": "object", "object": "03-saves", "pointer": "/days/4/n"}
    with pytest.raises(R.RefError):
        R.parse("a.jsonl#L3-x")  # a mistyped line ref is an error, not the whole file
    assert R.parse("notes.md#Findings") == {"kind": "file", "path": "notes.md", "locator": "Findings"}


# ------------------------------------------------------------------ sources


def test_every_kind_has_rows_with_stable_ids(root: Path) -> None:
    refs = {rel: [r.ref for r in S.iter_rows(root, rel)] for rel in S.list_sources(root)}
    assert refs["saves.jsonl"][:2] == ["saves.jsonl#L1", "saves.jsonl#L2"]
    assert refs["runs.csv"] == ["runs.csv#row=1", "runs.csv#row=2", "runs.csv#row=3"]
    assert refs["report.json"] == ["report.json#/messages/0", "report.json#/messages/1"]
    assert refs["forge.db"] == ["forge.db#prs/1", "forge.db#prs/2", "forge.db#prs/3"]
    assert refs["notes.md"] == ["notes.md#L1-3", "notes.md#L4-6"]
    assert refs["change.diff"] == ["change.diff#L4-8"]
    assert S.kind_of_file(root, "agent.jsonl") == "transcript"
    again = {rel: [r.ref for r in S.iter_rows(root, rel)] for rel in S.list_sources(root)}
    assert again == refs
    # each row reads back by its ref, the same text
    for rel, rs in refs.items():
        for ref in rs:
            first = next(r for r in S.iter_rows(root, rel) if r.ref == ref)
            assert S.fetch(root, ref)[0].raw == first.raw, ref
    hunk = next(S.iter_rows(root, "change.diff")).value
    assert (hunk["file"], hunk["added"], hunk["removed"]) == ("x.py", 2, 1)
    assert S.fetch(root, "agent.jsonl#L2.b1")[0].value["kind"] == "tool_use"


def test_a_changed_row_is_found_again_by_its_hash(root: Path) -> None:
    row = S.fetch(root, "saves.jsonl#L4")[0]
    h = S.row_hash(row.raw)
    text = (root / "saves.jsonl").read_text()
    (root / "saves.jsonl").write_text(json.dumps({"id": -1}) + "\n" + text)
    assert S.row_hash(S.fetch(root, "saves.jsonl#L4")[0].raw) != h
    assert S.relocate(root, "saves.jsonl#L4", h) == "saves.jsonl#L5"


# ------------------------------------------------------------------ queries


def test_a_groupby_keeps_each_output_rows_source_rows(root: Path) -> None:
    st = Store(root)
    q = Q.run(st, "saves per day", 'df = load("saves.jsonl")\ndf["day"] = df.time.str[:10]\ndf.groupby("day").size().rename("n")')
    assert q["error"] is None
    assert q["lineage"] == "matched" and q["keys"] == ["day"]
    assert q["table"][1] == {"day": "2026-06-02", "n": 5}
    assert q["rows"][1] == ["saves.jsonl#L4-8"]
    assert q["inputs"][0]["path"] == "saves.jsonl" and q["inputs"][0]["rows_read"] == 10


def test_tally_is_exact_and_a_filtered_count_is_marked_superset(root: Path) -> None:
    st = Store(root)
    t = Q.run(st, "by user", 'df = load("saves.jsonl")\ntally(df, "user")')
    assert t["lineage"] == "exact"
    assert R.count(t["rows"][0]) == t["table"][0]["n"]
    s = Q.run(st, "late saves", 'df = load("saves.jsonl")\ndf[df.id > 4].groupby("user").size().rename("n")')
    assert s["lineage"] == "superset"  # the filtered frame was never named, so its rows are not the ones counted


def test_a_scalar_count_finds_its_frame_and_keep_use_record_the_version(root: Path) -> None:
    st = Store(root)
    q = Q.run(st, "merged", 'prs = load("forge.db#prs")\nmerged = prs[prs.state == "merged"]\nlen(merged)')
    assert q["table"] == [{"value": 2}] and q["lineage"] == "matched" and q["rows"] == [["forge.db#prs/1,3"]]
    k = Q.run(st, "label passed", 'runs = load("runs.csv")\nkeep("passed", dict(zip(runs._ref, runs.passed == "1")))\nlen(runs)')
    u = Q.run(st, "use it", 'p = use("passed")\nsum(p.values())')
    assert u["uses"] == [{"name": "passed", "query": k["id"]}]
    assert [x["path"] for x in Q.all_inputs(st, u)] == ["runs.csv"]


def test_a_changed_input_makes_a_query_stale(root: Path) -> None:
    st = Store(root)
    q = Q.run(st, "rows", 'len(load("runs.csv"))')
    assert Q.stale_inputs(st, q) == []
    with open(root / "runs.csv", "a") as f:
        f.write("d,1\n")
    assert Q.stale_inputs(st, q) == ["runs.csv"]


# ------------------------------------------------------------------ objects and resolve


def test_an_object_holds_its_lineage_and_a_value_resolves_to_its_rows(root: Path) -> None:
    st = Store(root)
    q = Q.run(st, "saves per day", 'df = load("saves.jsonl")\ndf["day"] = df.time.str[:10]\ndf.groupby("day").size().rename("n")')
    spec = {"title": "Saves per day", "program": "k.bars(data.days, 'day', 'n')", "mood": "any field is kept",
            "data": {"days": q["id"], "peak": f"{q['id']}#day=2026-06-02@n",
                     "example": {"ref": "report.json#/messages/1", "quote": "PRECISION ALERT"}},
            "text": f"The busiest day had [5 saves]({q['id']}#day=2026-06-02@n).",
            "declared": {"read": ["notes.md#L4-6"], "how": "read the findings by hand"}}
    obj = O.save(st, "saves-per-day", spec)
    assert obj["id"] == "01-saves-per-day" and obj["mood"] == "any field is kept"
    on_disk = json.loads((root / "thimble" / "objects" / "01-saves-per-day.json").read_text())
    lin = on_disk["lineage"]
    assert lin["queries"][q["id"]]["code"].startswith('df = load("saves.jsonl")')
    assert lin["rows"]["saves.jsonl"]["count"] == 10 and lin["problems"] == []
    assert lin["declared"]["how"] == "read the findings by hand"
    assert on_disk["data"]["days"][1]["_rows"] == ["saves.jsonl#L4-8"] and on_disk["data"]["peak"] == 5
    r = LIN.resolve(st, "obj:saves-per-day#/days/1/n")
    assert r["count"] == 5 and r["rows"] == ["saves.jsonl#L4-8"]
    assert [x["ref"] for x in r["records"]] == [f"saves.jsonl#L{i}" for i in range(4, 9)]
    assert r["chain"][-1]["check"] == "the value equals the number of rows"
    assert LIN.resolve(st, "obj:saves-per-day#/peak")["rows"] == ["saves.jsonl#L4-8"]
    assert LIN.resolve(st, "obj:saves-per-day#/example")["rows"] == ["report.json#/messages/1"]


def test_a_wrong_citation_is_kept_as_a_problem_not_refused(root: Path) -> None:
    st = Store(root)
    q = Q.run(st, "n", 'df = load("saves.jsonl")\ndf["day"] = df.time.str[:10]\ntally(df, "day")')
    obj = O.save(st, None, {"title": "x", "text": f"[7 saves]({q['id']}#day=2026-06-02@n) and [\"not there\"](saves.jsonl#L1)"})
    probs = obj["lineage"]["problems"]
    assert len(probs) == 2 and "holds 5" in probs[0] and "not in" in probs[1]


def test_a_new_version_keeps_the_old_and_rerun_binds_new_results(root: Path) -> None:
    st = Store(root)
    q = Q.run(st, "runs", 'tally(load("runs.csv"), "passed")')
    O.save(st, "runs", {"title": "Runs", "data": {"by": q["id"]}, "text": f"[2]({q['id']}#passed=1@n) passed"})
    with open(root / "runs.csv", "a") as f:
        f.write("d,1\n")
    obj, renamed = O.update(st, "runs", {}, rerun=True)
    assert obj["version"] == 2 and renamed == {q["id"]: f"q{int(q['id'][1:]) + 1}"}
    assert (root / "thimble" / "objects" / ".versions" / "01-runs" / "v1.json").is_file()
    assert obj["data"]["by"][1]["n"] == 3
    assert obj["lineage"]["problems"] and "holds 3" in obj["lineage"]["problems"][0]  # the text still says 2


# ------------------------------------------------------------------ coverage


def test_coverage_merges_queries_rows_and_what_the_hook_saw(root: Path, tmp_path: Path) -> None:
    st = Store(root)
    Q.run(st, "runs", 'len(load("runs.csv"))')
    seen = tmp_path / "th" / "lean" / "seen"
    seen.mkdir(parents=True)
    rows = [{"tool": "Read", "file": str(root / "saves.jsonl"), "from": 1, "to": 4, "cwd": str(root)},
            {"tool": "Grep", "path": str(root), "glob": "*.md", "files": [str(root / "notes.md")], "lines": {}, "cwd": str(root)},
            {"tool": "Bash", "command": "head -2 change.diff", "cwd": str(root)}]
    (seen / "s-test.jsonl").write_text("\n".join(json.dumps(r) for r in rows) + "\n")
    cov = LIN.coverage(st)
    status = {o["path"]: o["status"] for o in cov["files"]}
    assert status == {"runs.csv": "computed", "saves.jsonl": "read", "notes.md": "searched", "change.diff": "named",
                      "agent.jsonl": "not read", "forge.db": "not read", "report.json": "not read"}
    saves = next(o for o in cov["files"] if o["path"] == "saves.jsonl")
    assert saves["read_lines"] == 4
    assert cov["total"]["not_read_files"] == 3
    assert "Not read: 3 files" in LIN.coverage_text(cov)


# ------------------------------------------------------------------ the command


def test_the_command_runs_a_query_from_a_heredoc(root: Path) -> None:
    lean = Path(__file__).resolve().parents[1] / "bin" / "lean"
    env = {**os.environ, "LEAN_PYTHON": sys.executable}
    out = subprocess.run([str(lean), "q", "runs by result"], input='tally(load("runs.csv"), "passed")', text=True,
                         capture_output=True, cwd=root, env=env, timeout=120)
    assert out.returncode == 0, out.stderr
    assert "q1 · runs by result" in out.stdout and "Each output row keeps its source rows." in out.stdout
    assert "[1](q1#passed=0@n)" in out.stdout
    res = subprocess.run([str(lean), "resolve", "q1#passed=1@n"], text=True, capture_output=True, cwd=root, env=env, timeout=60)
    assert "2 source rows: runs.csv#row=1,3" in res.stdout
