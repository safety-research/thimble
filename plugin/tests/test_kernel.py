"""Focused tests of the kernel: stable row ids per source kind, row sets, query lineage, objects with lineage,
resolving a value to its rows, and coverage. Run: THIMBLE_PYTHON-or-any-python-with-pandas -m pytest plugin/tests"""
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
    monkeypatch.setenv("THIMBLE_SESSION", "s-test")
    monkeypatch.delenv("THIMBLE_ROOT", raising=False)
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


def test_load_gives_a_csvs_numbers_as_numbers_and_keeps_its_row_refs(root: Path) -> None:
    with open(root / "orders.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["shop", "zip", "items", "price"])
        w.writerows([["north", "02139", "9", "2.50"], ["south", "10001", "10", ""], ["north", "02139", "2", "1.25"]])
    st = Store(root)
    q = Q.run(st, "order sums", 'd = load("orders.csv")\n'
                                'print(d["items"].sum(), d.price.sum(), list(d.sort_values("items")["items"]), list(d.zip))\n'
                                'print(list(d._ref))')
    assert q["error"] is None, q["error"]
    # 9 + 10 + 2 adds, a sort orders 10 after 9, a blank price is left out, and a code that starts with 0 stays text
    assert "21 3.75 [2, 9, 10] ['02139', '10001', '02139']" in q["stdout"]
    # each row's citation is as before, and it opens the row as the file holds it
    assert "['orders.csv#row=1', 'orders.csv#row=2', 'orders.csv#row=3']" in q["stdout"]
    assert S.fetch(root, "orders.csv#row=2")[0].value == {"shop": "south", "zip": "10001", "items": "10", "price": ""}
    # a group of a number column is cited by its value, and the citation opens the rows of that group
    t = Q.run(st, "by items", 'tally(load("runs.csv"), "passed")')
    assert t["keys"] == ["passed"] and t["rows"][1] == ["runs.csv#row=1,3"]


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


# ------------------------------------------------------------------ coverage


def test_coverage_merges_queries_rows_and_what_the_hook_saw(root: Path, tmp_path: Path) -> None:
    st = Store(root)
    Q.run(st, "runs", 'len(load("runs.csv"))')
    seen = tmp_path / "th" / "lean" / "seen"
    seen.mkdir(parents=True)
    rows = [{"tool": "Read", "file": str(root / "saves.jsonl"), "from": 1, "to": 4, "cwd": str(root)},
            {"tool": "Grep", "path": str(root), "glob": "*.md", "mode": "content", "files": [str(root / "notes.md")],
             "lines": {str(root / "notes.md"): [4]}, "cwd": str(root)},
            {"tool": "Bash", "command": "head -2 change.diff", "out_lines": 2, "cwd": str(root)},
            {"tool": "Bash", "command": "wc -l agent.jsonl", "out_lines": 1, "cwd": str(root)}]
    (seen / "s-test.jsonl").write_text("\n".join(json.dumps(r) for r in rows) + "\n")
    cov = LIN.coverage(st)
    status = {o["path"]: o["status"] for o in cov["files"]}
    # the query computed over runs.csv (it printed a count, no row of it); the line a search showed is seen
    assert status == {"runs.csv": "computed", "saves.jsonl": "seen", "notes.md": "seen", "change.diff": "seen",
                      "agent.jsonl": "named", "forge.db": "not read", "report.json": "not read"}
    saves = next(o for o in cov["files"] if o["path"] == "saves.jsonl")
    assert saves["seen_lines"] == 4
    assert next(o for o in cov["files"] if o["path"] == "change.diff")["seen_lines"] == 2
    assert next(o for o in cov["files"] if o["path"] == "notes.md")["hit_lines"] == [4]
    # computed over and counted files are not seen
    assert cov["total"]["not_seen_files"] == 4 and cov["total"]["seen_files"] == 3 and cov["total"]["touched_files"] == 5
    assert cov["total"]["computed_rows"] == 3
    assert "Not read: 4 files" in LIN.coverage_text(cov)


# ------------------------------------------------------------------ the command


def test_the_command_runs_a_query_from_a_heredoc(root: Path) -> None:
    lean = Path(__file__).resolve().parents[1] / "bin" / "thimble"
    # the root is pinned: a thimble/ store in a folder above the test's (as /tmp can hold) must not take it
    env = {**os.environ, "THIMBLE_PYTHON": sys.executable, "THIMBLE_ROOT": str(root)}
    out = subprocess.run([str(lean), "run", "runs by result"], input='tally(load("runs.csv"), "passed")', text=True,
                         capture_output=True, cwd=root, env=env, timeout=120)
    assert out.returncode == 0, out.stderr
    assert "r1 · runs by result" in out.stdout and "Each output row keeps its source rows." in out.stdout
    assert "[1](r1#passed=0@n)" in out.stdout
    res = subprocess.run([str(lean), "rows", "r1#passed=1@n"], text=True, capture_output=True, cwd=root, env=env, timeout=60)
    assert "2 source rows: runs.csv#row=1,3" in res.stdout


def test_the_lineage_line_says_no_rows_stand_behind_values_when_none_were_read(root: Path) -> None:
    from kernel import cli as CLI

    st = Store(root)
    # a database read in code: the query read no rows with load(), so nothing stands behind its values
    q = Q.run(st, "prs by state", 'import sqlite3\nc = sqlite3.connect("forge.db")\n'
              'pd.DataFrame(c.execute("select state, count(*) n from prs group by state").fetchall(), columns=["state", "n"])')
    assert q["error"] is None and not q.get("read")
    line = CLI._lineage_line(q)
    assert line.startswith("No rows stand behind these values") and "rests on all the rows read" not in line
    # the same values read with load(): each rests on the rows read, as before
    q2 = Q.run(st, "prs", 'df = load("forge.db#prs")\npd.DataFrame([{"merged": int((df.state == "merged").sum()), "all": len(df)}]).T')
    assert q2.get("rows") is not None or q2.get("read")
    assert "No rows stand behind" not in CLI._lineage_line(q2)


def test_the_lineage_line_of_a_count_with_no_key(root: Path) -> None:
    from kernel import cli as CLI

    st = Store(root)
    # a query that prints and ends with len(d): no key column found its rows, the count rests on the rows of d
    q = Q.run(st, "print runs", 'd = load("runs.csv")\nfor _, r in d.iterrows():\n    print(r.run)\nlen(d)')
    assert q["error"] is None and not q.get("keys")
    line = CLI._lineage_line(q)
    assert "found by" not in line and "Each value counts the rows of `d`" in line
    # with no rows behind it, the line says so plainly and suggests no citation
    line = CLI._lineage_line({**q, "rows": None, "lineage": "matched"})
    assert line.startswith("No key and no rows stand behind these values") and "Cite" not in line


# ------------------------------------------------------------------ run, and the ids from before it was named run


def test_a_result_table_numbers_its_rows_from_1_as_a_citation_counts_them() -> None:
    import pandas as pd

    df = pd.DataFrame({"group": ["a", "b", "c"], "n": [5, 7, 9]})
    # a plain table: the first row shows as 1, the row `r2#row=1` names
    assert Q.show(df).splitlines()[1].split()[:3] == ["1", "a", "5"]
    assert Q.show(df["n"]).splitlines()[0].split() == ["1", "5"]
    # rows kept from a sort: numbered from 1, where they sat before kept as the column `index`
    lines = Q.show(df.sort_values("n", ascending=False)).splitlines()
    assert lines[0].split() == ["index", "group", "n"] and lines[1].split() == ["1", "2", "c", "9"]
    # rows named by their keys stay named
    assert Q.show(df.set_index("group")).splitlines()[2].split() == ["a", "5"]
    # a long table keeps its count line and numbers its last row as its count
    long = Q.show(pd.DataFrame({"v": range(100)}), "r9").splitlines()
    assert long[-2].split() == ["100", "99"] and long[-1].startswith("(100 rows")
