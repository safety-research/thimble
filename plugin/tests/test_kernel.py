"""Focused tests of the kernel: stable row ids per source kind, row sets, query lineage, objects with lineage,
resolving a value to its rows, and coverage. Run: THIMBLE_PYTHON-or-any-python-with-pandas -m pytest plugin/tests"""
from __future__ import annotations

import copy
import csv
import json
import os
import re
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


def test_a_resolved_row_carries_its_words_not_a_dump_of_its_fields(root: Path) -> None:
    st = Store(root)
    r = LIN.resolve(st, "saves.jsonl#L4", n=1)
    rec = r["records"][0]
    assert rec["words"] == "save number 3" and rec["meta"].startswith("ann")
    assert "id:" not in rec["words"]
    assert rec["text"].startswith("id: 3"), "the CLI's excerpt is unchanged"
    run = LIN.resolve(st, "agent.jsonl#L2", n=1)["records"][0]
    assert run["words"] == "I will run the tests" and run["meta"] == "assistant"
    assert "words" not in LIN.resolve(st, "runs.csv#row=1", n=1)["records"][0], "a row with no words has none"


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
    assert obj["version"] == 2 and renamed == {q["id"]: f"r{int(q['id'][1:]) + 1}"}
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
            {"tool": "Grep", "path": str(root), "glob": "*.md", "mode": "content", "files": [str(root / "notes.md")],
             "lines": {str(root / "notes.md"): [4]}, "cwd": str(root)},
            {"tool": "Bash", "command": "head -2 change.diff", "out_lines": 2, "cwd": str(root)},
            {"tool": "Bash", "command": "wc -l agent.jsonl", "out_lines": 1, "cwd": str(root)}]
    (seen / "s-test.jsonl").write_text("\n".join(json.dumps(r) for r in rows) + "\n")
    cov = LIN.coverage(st)
    status = {o["path"]: o["status"] for o in cov["files"]}
    assert status == {"runs.csv": "computed", "saves.jsonl": "read", "notes.md": "searched", "change.diff": "read",
                      "agent.jsonl": "named", "forge.db": "not read", "report.json": "not read"}
    saves = next(o for o in cov["files"] if o["path"] == "saves.jsonl")
    assert saves["read_lines"] == 4
    assert next(o for o in cov["files"] if o["path"] == "change.diff")["read_lines"] == 2
    # searched and counted files are not read
    assert cov["total"]["not_read_files"] == 4 and cov["total"]["read_files"] == 3
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
    res = subprocess.run([str(lean), "resolve", "r1#passed=1@n"], text=True, capture_output=True, cwd=root, env=env, timeout=60)
    assert "2 source rows: runs.csv#row=1,3" in res.stdout


# ------------------------------------------------------------------ run, and the ids from before it was named run


def _thimble(root: Path, *args: str, stdin: str | None = None) -> subprocess.CompletedProcess:
    lean = Path(__file__).resolve().parents[1] / "bin" / "thimble"
    env = {**os.environ, "THIMBLE_PYTHON": sys.executable, "THIMBLE_ROOT": str(root)}
    return subprocess.run([str(lean), *args], input=stdin, text=True, capture_output=True, cwd=root, env=env, timeout=120)


def test_run_makes_r_ids_and_q_is_an_unlisted_alias_that_goes_on_with_them(root: Path) -> None:
    code = 'tally(load("runs.csv"), "passed")'
    first = _thimble(root, "run", "runs by result", stdin=code)
    assert first.returncode == 0, first.stderr
    assert first.stdout.startswith("r1 · runs by result") and (root / "thimble" / "queries" / "r1.json").is_file()
    for n, alias in ((2, "q"), (3, "query")):
        out = _thimble(root, alias, "runs again", stdin=code)
        assert out.returncode == 0, out.stderr
        assert out.stdout.startswith(f"r{n} · runs again") and f"[1](r{n}#passed=0@n)" in out.stdout
    again = _thimble(root, "run", "--rerun", "r1")
    assert again.stdout.startswith("r4 ran r1 again: its output is the same"), again.stdout
    # the help and the usage name run, never the aliases
    for args in ((), ("--help",), ("no-such-command",)):
        out = _thimble(root, *args)
        text = out.stdout + out.stderr
        assert "thimble run " in text or "{run," in text, text
        assert not re.search(r"thimble q |[,{'](q|query)[,}']|, (q|query),", text), text


def test_rows_does_what_sources_list_and_resolve_did_and_they_are_unlisted_aliases(root: Path) -> None:
    assert _thimble(root, "run", "runs by result", stdin='tally(load("runs.csv"), "passed")').returncode == 0
    alone = _thimble(root, "rows")
    assert "runs.csv" in alone.stdout and "no cards yet" in alone.stdout, alone.stdout + alone.stderr
    for cmd in ("rows", "resolve", "from"):
        out = _thimble(root, cmd, "r1#passed=1@n")
        assert "2 source rows: runs.csv#row=1,3" in out.stdout, (cmd, out.stdout + out.stderr)
    assert "runs.csv" in _thimble(root, "sources").stdout
    for args in ((), ("--help",), ("no-such-command",)):
        out = _thimble(root, *args)
        text = out.stdout + out.stderr
        assert "thimble rows" in text or "rows," in text, text
        assert not re.search(r"thimble (sources|list|resolve|from)\b|'(sources|list|resolve|from)'|,(sources|list|resolve|from)[,}]", text), text


def test_new_ids_go_on_from_the_highest_id_old_or_new(root: Path) -> None:
    st = Store(root)
    d = st.sub("queries")
    for n in range(1, 6):
        (d / f"q{n}.json").write_text("{}")
    qid, path = Q.next_id(st)
    assert (qid, path.name) == ("r6", "r6.json")
    (d / "q8.json").write_text("{}")
    assert Q.next_id(st)[0] == "r9"


def test_both_id_forms_read_as_query_refs() -> None:
    for qid in ("r3", "q3"):
        assert R.parse(f"{qid}#day=2026-06-16@n") == {"kind": "query", "query": qid, "keys": {"day": "2026-06-16"}, "col": "n"}
        assert R.links(f"[202]({qid}#outcome=won (clean ep)@median)") == [("202", f"{qid}#outcome=won (clean ep)@median")]
    assert R.parse("r1/runs.jsonl#L3")["kind"] != "query"  # a folder named like an id is still a path


def test_a_folder_with_queries_from_before_the_rename_still_reads_them(root: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    st = Store(root)
    new_id = Q.next_id

    def old_id(s: Store) -> tuple[str, Path]:  # the id the kernel gave a query before it was named run
        p = s.sub("queries") / "q1.json"
        p.write_text('{"running": true}\n')
        return "q1", p

    monkeypatch.setattr(Q, "next_id", old_id)
    old = Q.run(st, "runs by result", 'tally(load("runs.csv"), "passed")')
    monkeypatch.setattr(Q, "next_id", new_id)
    assert old["id"] == "q1" and not old["error"]
    # its refs resolve, use() reads it, and a new query goes on from its number
    r = LIN.resolve(st, "q1#passed=1@n")
    assert r["count"] == 2 and r["rows"] == ["runs.csv#row=1,3"]
    used = Q.run(st, "the old one, used", 'use("q1")')
    assert used["id"] == "r2" and not used["error"] and used["uses"] == [{"name": "q1", "query": "q1"}]
    # an object that binds it still saves, and its citation holds
    obj = O.save(st, "old", {"title": "Old", "data": {"by": "q1"}, "text": "[2](q1#passed=1@n) passed"})
    assert all(x["_ref"].startswith("q1#") and x["_rows"] for x in obj["data"]["by"])
    assert not obj["lineage"]["problems"] and all(not c.get("problem") for c in obj["lineage"]["cites"])
    # --rerun runs it again under a new id
    out = _thimble(root, "run", "--rerun", "q1")
    assert out.returncode == 0 and out.stdout.startswith("r3 ran q1 again: its output is the same"), out.stdout
    # an object saved again with its queries run again binds the new id, in its data and its text
    again, renamed = O.update(st, "old", {}, rerun=True)
    assert renamed == {"q1": "r4"} and again["source"]["data"]["by"] == "r4" and "(r4#passed=1@n)" in again["text"]


def test_a_changed_input_says_how_to_run_the_query_again(root: Path) -> None:
    st = Store(root)
    q = Q.run(st, "runs by result", 'tally(load("runs.csv"), "passed")')
    with open(root / "runs.csv", "a") as f:
        f.write("d,1\n")
    r = LIN.resolve(st, f"{q['id']}#passed=1@n")
    assert f"runs.csv changed since {q['id']} ran; `thimble run --rerun {q['id']}` runs it again" in r["notes"]


def test_a_query_prints_little_beyond_what_claude_asked_for(root: Path) -> None:
    st = Store(root)
    # a long result shows its first and last rows, as many as fit, and keeps them all
    long = Q.run(st, "many rows", 'import pandas as pd\npd.DataFrame({"i": range(500), "text": ["x" * 120] * 500})')
    assert len(long["stdout"]) < Q.SHOW + 400 and "(500 rows, the first and last" in long["stdout"]
    assert len(long["table"]) == 500
    # a short table shows whole
    short = Q.run(st, "few rows", 'df = load("saves.jsonl")\ntally(df, "user")')
    assert "rows, the first" not in short["stdout"] and "ann" in short["stdout"]
    # a query that ends by keeping a result prints nothing more
    kept = Q.run(st, "keep", 'df = load("saves.jsonl")\nkeep("users", df.user)')
    assert kept["stdout"].strip() == "" and kept["kept"] == ["users"]
    # an error shows the query's own lines, not the kernel's frames
    bad = Q.run(st, "bad", 'df = load("saves.jsonl")\ndef f(x):\n    return x.nope\ndf.id.map(f)')
    assert "line 3, in f: return x.nope" in bad["stdout"] and "AttributeError" in bad["stdout"]
    assert "query.py" not in bad["stdout"]


def test_a_later_query_uses_an_earlier_querys_output_without_running_it_again(root: Path) -> None:
    st = Store(root)
    by_day = Q.run(st, "saves per day", 'df = load("saves.jsonl")\ndf["day"] = df.time.str[:10]\ntally(df, "day")')
    busy = Q.run(st, "busy days", 'd = use("%s")\nd[d.n >= 3]' % by_day["id"])
    assert busy["error"] is None and busy["lineage"] == "exact"
    assert [r["day"] for r in busy["table"]] == ["2026-06-01", "2026-06-02"]
    assert busy["rows"][1] == ["saves.jsonl#L4-8"]
    assert busy["uses"] == [{"name": by_day["id"], "query": by_day["id"]}]
    assert [x["path"] for x in Q.all_inputs(st, busy)] == ["saves.jsonl"]
    # a grouped count (no _refs of its own) is used with the rows its lineage found, and tally() builds on them
    users = Q.run(st, "per user", 'df = load("saves.jsonl")\ndf.groupby("user").size().rename("n")')
    both = Q.run(st, "all users", 'tally(use("%s"))' % users["id"])
    assert both["table"][0]["n"] == 2 and R.count(both["rows"][0]) == 10
    printed = Q.run(st, "printed", 'print(1)')
    bad = Q.run(st, "use it", 'use("%s")' % printed["id"])
    assert bad["error"] and "only printed" in bad["error"]


def test_a_new_version_saved_from_the_object_file_keeps_its_bindings(root: Path) -> None:
    st = Store(root)
    q = Q.run(st, "saves per day", 'df = load("saves.jsonl")\ndf["day"] = df.time.str[:10]\ntally(df, "day")')
    first = O.save(st, "per-day", {"title": "Saves", "data": {"days": q["id"], "peak": f"{q['id']}#day=2026-06-02@n"}})
    # Claude loads the saved object, changes the title, and saves the data it read back, written out
    again = {"title": "Saves per day", "data": copy.deepcopy(first["data"])}
    second = O.save(st, "per-day", again)
    assert second["source"]["data"] == {"days": q["id"], "peak": f"{q['id']}#day=2026-06-02@n"}
    assert sorted(b["at"] for b in second["lineage"]["bindings"]) == ["/days", "/peak"]
    assert second["data"] == first["data"]
    # a part Claude changed stays as Claude wrote it
    changed = copy.deepcopy(first["data"])
    changed["days"][0]["n"] = 99
    third = O.save(st, "per-day", {"title": "Saves", "data": changed})
    assert third["source"]["data"]["days"][0]["n"] == 99 and third["source"]["data"]["peak"] == f"{q['id']}#day=2026-06-02@n"


def test_an_object_bound_to_a_cut_table_says_so(root: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(Q, "TABLE_MAX", 4)
    st = Store(root)
    q = Q.run(st, "every save", 'load("saves.jsonl")[["_ref", "user"]]')
    assert q["truncated"] and len(q["table"]) == 4
    obj = O.save(st, "saves", {"title": "Saves", "data": {"rows": q["id"], "first": f"{q['id']}#row=1@user"}})
    assert len(obj["lineage"]["problems"]) == 1 and "more rows than its record keeps" in obj["lineage"]["problems"][0]


def test_row_sets_of_many_block_refs_compress_and_expand_fast_and_the_same(root: Path) -> None:
    """An output row may rest on a hundred thousand block refs (each tool call of a swarm): compress keeps them as one
    block set per file (`f#L12.b0-1,14-15.b0`), in first-seen order of the files, without a quadratic scan, and expand
    gives back what parse() reads, every ref once, in a few seconds at most."""
    import random
    import time

    rnd = random.Random(7)
    files = [f"runs/r{i}/agents/agent-{j:02d}.jsonl" for i in range(3) for j in range(4)]
    blocks = [f"{rnd.choice(files)}#L{rnd.randint(1, 4000)}.b{rnd.randint(0, 3)}" for _ in range(120_000)]
    mixed = blocks + ["a.jsonl#L3", "a.jsonl#L4", "a.jsonl#L9", "t.csv#row=2", "d.db#t/5", "f.json#/x/3", blocks[0]]
    t0 = time.time()
    sets = R.compress(mixed)
    back = R.expand(sets)
    assert time.time() - t0 < 10
    # every ref once: the numbered rows as row sets first, then a block set per file, in first-seen order of the files
    assert sets[:4] == ["a.jsonl#L3-4,9", "t.csv#row=2", "d.db#t/5", "f.json#/x/3"]
    assert [x.split("#")[0] for x in sets[4:]] == list(dict.fromkeys(b.split("#")[0] for b in blocks))
    assert sorted(back) == sorted(set(mixed)) and R.count(sets) == len(set(mixed))
    # expand reads each row set as parse() does, the block refs included (a leading zero is read as a number)
    slow = [x for s in sets for x in R.single_refs(R.parse(s))]
    assert back == slow
    assert R.expand(["a b/c.jsonl#L007.b02 "]) == ["a b/c.jsonl#L7.b2"]
    with pytest.raises(R.RefError):
        R.expand(["q12#L3.b1"])


def test_big_files_are_parsed_once_in_workers_and_a_load_with_fields_reads_only_those_columns(root: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A load over many big files not yet in the cache parses them in worker processes and keeps each frame by columns;
    a later load reads them from the cache, only the columns it names, and gives the same frame as a parse would."""
    for k in range(4):
        with open(root / f"run{k}.jsonl", "w") as f:
            for i in range(300):
                f.write(json.dumps({"type": "assistant" if i % 2 else "user", "n": i, "run": k, "message": {"content": "x" * 50}}) + "\n")
    monkeypatch.setattr(Q, "CACHE_MIN", 1_000)
    monkeypatch.setattr(Q, "PARALLEL_MIN", 10_000)
    st = Store(root)
    files = [f"run{k}.jsonl" for k in range(4)]
    Q._warm_cache(st, files)
    for rel in files:
        cp = Q._frame_cache(st, rel)
        assert cp.exists() and cp.with_suffix(".json").exists()
        whole = Q._parse_frame(st.root, rel, None)
        assert Q._load_frame(cp, None).equals(whole)
        part = Q._load_frame(cp, ["n", "nothing"])
        assert list(part.columns) == ["_ref", "_file", "n"] and part.equals(whole[["_ref", "_file", "n"]])
    out = Q.run(st, "assistant rows per run", 'df = load("run*.jsonl", fields=["type", "run"])\ntally(df[df.type == "assistant"], "run")')
    assert out.get("error") is None
    assert [r["n"] for r in out["table"]] == [150, 150, 150, 150]


def test_rows_are_counted_as_iter_rows_gives_them_in_workers_and_by_the_database(root: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """`thimble sources` counts each file's rows: a database's by its own count (a table its rows cannot be read from by
    rowid gives none, as iter_rows gives none), and many big files in worker processes, with the same counts."""
    con = sqlite3.connect(root / "two.db")
    con.execute("create table a (x text)")
    con.executemany("insert into a values (?)", [("p",), ("q",)])
    con.execute("create table w (k text primary key, v text) without rowid")
    con.execute("insert into w values ('k1', 'v1')")
    con.commit()
    con.close()
    assert S.count_rows(root, "two.db") == sum(1 for _ in S.iter_rows(root, "two.db")) == 2
    assert S.count_rows(root, "forge.db") == 3
    for k in range(3):
        with open(root / f"many{k}.jsonl", "w") as f:
            f.write("".join(json.dumps({"i": i}) + "\n" for i in range(50 + k)))
    rels = ["many0.jsonl", "many1.jsonl", "many2.jsonl", "two.db", "runs.csv"]
    monkeypatch.setattr(S, "PARALLEL_MIN", 1)
    sizes = {r: (root / r).stat().st_size for r in rels}
    assert S._count_many(root, rels, sizes) == {r: S.count_rows(root, r) for r in rels} == {"many0.jsonl": 50, "many1.jsonl": 51, "many2.jsonl": 52, "two.db": 2, "runs.csv": 3}
