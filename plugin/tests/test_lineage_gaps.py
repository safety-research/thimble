"""Lineage gaps closed: outputs whose index the kernel could not read back (a described frame turned on its side),
whole JSON documents and the files a loop opened, groupbys on a number column, and row sets of transcript blocks.
Run: THIMBLE_PYTHON-or-any-python-with-pandas -m pytest plugin/tests"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

ENGINE = Path(__file__).resolve().parents[1] / "engine"
sys.path.insert(0, str(ENGINE))

from kernel import lineage as LIN  # noqa: E402
from kernel import query as Q  # noqa: E402
from kernel.store import Store  # noqa: E402

# made-up events: 40 actions by four agents, the first of them a lead
EVENTS = [{"agent": f"a{i % 4}", "step": i, "hours": i * 0.5, "act": ["read", "edit", "test"][i % 3]} for i in range(40)]


@pytest.fixture()
def root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    d = tmp_path / "data"
    d.mkdir()
    with open(d / "events.jsonl", "w") as f:
        for e in EVENTS:
            f.write(json.dumps(e) + "\n")
    monkeypatch.setenv("THIMBLE_HOME", str(tmp_path / "th"))
    monkeypatch.setenv("THIMBLE_SESSION", "s-gaps")
    monkeypatch.delenv("THIMBLE_ROOT", raising=False)
    return d


# ------------------------------------------------------------------ an index the kernel reads back


def test_a_described_frame_turned_on_its_side_keeps_its_output(root: Path) -> None:
    st = Store(root)
    # describe().T has an index of two unnamed levels: reset, they are level_0 and level_1, never `index`
    q = Q.run(st, "profile", 'df = load("events.jsonl")\ndf["role"] = np.where(df.agent == "a0", "lead", "worker")\n'
              'df.groupby("role")[["step", "hours"]].describe(percentiles=[.5]).T')
    assert q["error"] is None and q["keys"] == ["level_0", "level_1"]
    assert q["table"][0] == {"level_0": "step", "level_1": "count", "lead": 10.0, "worker": 30.0}
    r = LIN.resolve(st, f"{q['id']}#level_0=step&level_1=count@lead")
    assert r["chain"][0]["value"] == 10.0


def test_an_unnamed_index_beside_a_column_named_index_keeps_its_output(root: Path) -> None:
    st = Store(root)
    q = Q.run(st, "per agent", 'df = load("events.jsonl")\nt = df.groupby("agent").size().rename("index").to_frame()\n'
              't.index = ["x" + a for a in t.index]\nt')
    assert q["error"] is None and q["keys"] == ["level_0"]
    assert q["table"][0] == {"level_0": "xa0", "index": 10}


def test_columns_of_two_levels_beside_a_named_index_keep_their_output(root: Path) -> None:
    st = Store(root)
    # agg(["mean", "max"]) gives columns of two levels: the index levels come back as (name, ""), named by their name
    q = Q.run(st, "per agent", 'df = load("events.jsonl")\ndf["role"] = np.where(df.agent == "a0", "lead", "worker")\n'
              'df.groupby(["role", "agent"])[["step", "hours"]].agg(["mean", "max"])')
    assert q["error"] is None and q["keys"] == ["role", "agent"]
    assert list(q["table"][0]) == ["role", "agent", "step_mean", "step_max", "hours_mean", "hours_max"]
    assert LIN.resolve(st, f"{q['id']}#role=worker&agent=a2@step_max")["rows"] == ["events.jsonl#L3,7,11,15,19,23,27,31,35,39"]


def test_a_lineage_that_fails_keeps_the_output_and_says_why(root: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    st = Store(root)

    def broken(*a, **k):
        raise KeyError("index")

    monkeypatch.setattr(Q, "output_lineage", broken)
    q = Q.run(st, "per agent", 'df = load("events.jsonl")\ndf.groupby("agent").size()')
    assert q["error"] is None and q["rows"] is None and q["lineage_error"] == "KeyError: 'index'"
    assert q["table"][0] == {"agent": "a0", "value": 10}
    assert q["read"] == ["events.jsonl#L1-40"]
    r = LIN.resolve(st, f"{q['id']}#agent=a1@value")
    assert r["why"] == (f"thimble could not find the rows behind {q['id']}'s output (KeyError: 'index'), so its values keep "
                        "no rows: tally() in the query keeps them per row")
    # the query as a whole still opens every row it read
    assert LIN.resolve(st, q["id"])["count"] == 40


# ------------------------------------------------------------------ whole JSON documents

# made-up chat logs, one JSON document per agent: messages keyed by id, as some exports write them
CHATS = {"ep1/u1.json": ("u1", ["ls", "make", "make test"]), "ep1/u2.json": ("u2", ["cat notes"]),
         "ep2/u1.json": ("u1", ["ls", "ls -la"])}


@pytest.fixture()
def docs_root(root: Path) -> Path:
    for rel, (agent, cmds) in CHATS.items():
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        msgs = {f"m{i}": {"role": "assistant", "content": [{"type": "tool_use", "name": "Bash", "input": {"command": c}}]}
                for i, c in enumerate(cmds)}
        p.write_text(json.dumps({"agent": agent, "system": [{"text": "a made-up prompt"}], "messages": msgs}))
    # a .json file with one record per line is no document: its rows stay lines
    (root / "ep1" / "lines.json").write_text('{"a": 1}\n{"a": 2}\n')
    return root


def test_a_whole_json_document_opens_its_root_row(docs_root: Path) -> None:
    st = Store(docs_root)
    whole = LIN.resolve(st, "ep1/u1.json")
    assert whole["rows"] == ["ep1/u1.json#/"] and whole["count"] == 1 and "why" not in whole
    assert whole["records"][0]["ref"] == "ep1/u1.json#/"
    # the same as the document's root pointer, which opened it before
    assert LIN.resolve(st, "ep1/u1.json#/")["records"] == whole["records"]
    # a document on one line: its line 1 is the document
    one = LIN.resolve(st, "ep1/u2.json#L1")
    assert one["count"] == 1 and one["records"][0]["text"].startswith("agent: u2")
    # a file of one record per line stays a whole file, and its lines open as records
    assert LIN.resolve(st, "ep1/lines.json")["rows"] == ["ep1/lines.json"]
    assert LIN.resolve(st, "ep1/lines.json#L2")["records"][0]["text"] == "a: 2"


def test_a_query_whose_rows_are_whole_documents_opens_them(docs_root: Path) -> None:
    st = Store(docs_root)
    q = Q.run(st, "calls per run", 'import glob\nout = []\nfor f in sorted(glob.glob("ep*/u*.json")):\n'
              '    d = json.load(open(f))\n    out.append(dict(_ref=f, run=f.split("/")[0], agent=d["agent"], calls=len(d["messages"])))\n'
              'pd.DataFrame(out)')
    # a whole JSON document is kept as its root row
    assert q["lineage"] == "exact" and q["rows"][0] == ["ep1/u1.json#/"]
    r = LIN.resolve(st, f"{q['id']}#run=ep1&agent=u2@calls")
    assert r["rows"] == ["ep1/u2.json#/"] and r["count"] == 1 and r["records"][0]["ref"] == "ep1/u2.json#/"
    assert LIN.resolve(st, q["id"])["count"] == 3
    # a record an earlier kernel wrote names the whole files: they open the same
    f = docs_root / "thimble" / "queries" / f"{q['id']}.json"
    old = json.loads(f.read_text())
    old["rows"] = [[x[0].removesuffix("#/")] for x in old["rows"]]
    f.write_text(json.dumps(old))
    assert LIN.resolve(st, f"{q['id']}#run=ep1&agent=u2@calls")["rows"] == ["ep1/u2.json#/"]


def test_records_built_from_documents_opened_in_a_loop_rest_on_them(docs_root: Path) -> None:
    st = Store(docs_root)
    code = ('import glob\nout = []\nfor f in sorted(glob.glob("ep*/u*.json")):\n    d = json.load(open(f))\n'
            '    out.append(dict(run=f.split("/")[0], agent=d["agent"], calls=len(d["messages"])))\npd.DataFrame(out)')
    q = Q.run(st, "calls per run", code)
    assert q["lineage"] == "loop" and q["rows"] == [["ep1/u1.json#/"], ["ep1/u2.json#/"], ["ep2/u1.json#/"]]
    r = LIN.resolve(st, f"{q['id']}#run=ep2&agent=u1@calls")
    assert r["rows"] == ["ep2/u1.json#/"] and r["records"]
    assert r["why"] == (f"{q['id']} built this output row in a loop over the files it opened (ep2/u1.json), and it "
                        "does not keep which part of them the value used")
    # records of an inner loop rest on the document the outer loop opened
    inner = ('import glob\nout = []\nfor f in sorted(glob.glob("ep*/u*.json")):\n    d = json.load(open(f))\n'
             '    for mid, m in d["messages"].items():\n        out.append(dict(file=f, mid=mid, cmd=m["content"][0]["input"]["command"]))\n'
             'pd.DataFrame(out)')
    i = Q.run(st, "every call", inner)
    assert i["lineage"] == "loop" and i["rows"][3] == ["ep1/u2.json#/"] and i["rows"][5] == ["ep2/u1.json#/"]
    # one document opened before the loop: every record rests on it alike, so nothing per row is known, and each row
    # opens the document the query read
    one = Q.run(st, "calls of one run", 'd = json.load(open("ep1/u1.json"))\nout = []\nfor mid, m in d["messages"].items():\n'
                '    out.append(dict(mid=mid, cmd=m["content"][0]["input"]["command"]))\npd.DataFrame(out)')
    assert one["rows"] is None
    r = LIN.resolve(st, f"{one['id']}#mid=m1@cmd")
    assert r["rows"] == ["ep1/u1.json#/"] and r["count"] == 1
    assert r["why"] == (f"{one['id']} built its output in code from JSON documents it opened (ep1/u1.json), so a value "
                        "opens the whole document: a `_ref` column of JSON pointers (ep1/u1.json#/<key>/<n>) keeps each "
                        "row's own part")


def test_records_built_from_line_files_opened_in_a_loop_rest_on_their_lines(root: Path) -> None:
    st = Store(root)
    (root / "logs").mkdir()
    (root / "logs" / "a.jsonl").write_text('{"x": 1}\n{"x": 2}\n')
    (root / "logs" / "b.jsonl").write_text('{"x": 3}\n')
    code = ('import glob\nout = []\nfor f in sorted(glob.glob("logs/*.jsonl")):\n'
            '    xs = [json.loads(l)["x"] for l in open(f)]\n    out.append({"file": f, "total": sum(xs)})\npd.DataFrame(out)')
    q = Q.run(st, "totals", code)
    assert q["lineage"] == "loop" and q["rows"] == [["logs/a.jsonl#L1-2"], ["logs/b.jsonl#L1"]]
    assert LIN.resolve(st, f"{q['id']}#file=logs/a.jsonl@total")["count"] == 2
    # files read with rows() or load() are not files the code opened: their records keep what the loop held
    r = Q.run(st, "by rows", 'out = []\nfor ref, row in rows("logs/*.jsonl"):\n    out.append({"x": row["x"]})\npd.DataFrame(out)')
    assert r["rows"] is None


# ------------------------------------------------------------------ outputs whose key is a number, or a table of records


def test_a_groupby_on_a_number_column_finds_its_rows_by_that_column(root: Path) -> None:
    st = Store(root)
    # a bin the query made, grouped, then reset: the output's only key is a number
    q = Q.run(st, "per tenth", 'df = load("events.jsonl")\ndf["tenth"] = df.step * 10 // len(df)\n'
              't = df[df.act != "test"].copy()\ndef mk(g):\n    return pd.Series({"n": len(g), "reads": int((g.act == "read").sum())})\n'
              't.groupby("tenth").apply(mk).reset_index()')
    assert q["lineage"] == "matched" and q["keys"] == ["tenth"] and q["frame"] == "t"
    r = LIN.resolve(st, f"{q['id']}#tenth=0@n")
    assert r["rows"] == ["events.jsonl#L1-2,4"] and r["count"] == 3 and "why" not in r
    # sums per slice: found by the slice, the sums are no counts of rows
    s = Q.run(st, "hours per slice", 'df = load("events.jsonl")\ndf["slice"] = df.step // 10\n'
              'df.groupby("slice")[["hours"]].sum().reset_index()')
    assert s["keys"] == ["slice"] and s["rows"][3] == ["events.jsonl#L31-40"]
    # a count per slice and agent: the agent alone does not tell the rows apart, the slice beside it does
    a = Q.run(st, "per agent and slice", 'df = load("events.jsonl")\ndf["slice"] = df.step // 10\n'
              'df.groupby(["agent", "slice"]).size().reset_index(name="n")')
    assert a["lineage"] == "matched" and a["keys"] == ["agent", "slice"]
    assert LIN.resolve(st, f"{a['id']}#agent=a1&slice=2@n")["rows"] == ["events.jsonl#L22,26,30"]
    # a pivot of kinds per slice: each row opens its slice
    p = Q.run(st, "kinds per slice", 'df = load("events.jsonl")\ndf["slice"] = df.step // 10\n'
              'df.pivot_table(index="slice", columns="act", aggfunc="size", fill_value=0).reset_index()')
    assert p["keys"] == ["slice"] and LIN.resolve(st, f"{p['id']}#slice=1")["count"] == 10


def test_a_word_the_query_computed_per_group_does_not_hide_the_groupby_keys(root: Path) -> None:
    st = Store(root)
    # the last role per act and agent is a word column, but no key: the first two columns tell the rows apart
    q = Q.run(st, "last role", 'df = load("events.jsonl")\ndf["role"] = np.where(df.step < 20, "early", "late")\n'
              'df.groupby(["act", "agent"]).agg(n=("step", "size"), last_role=("role", "last")).reset_index()')
    assert q["lineage"] == "matched" and q["keys"] == ["act", "agent"]
    assert LIN.resolve(st, f"{q['id']}#act=test&agent=a1@n")["rows"] == ["events.jsonl#L6,18,30"]


def test_documents_beside_other_whole_files_stay_whole_files(docs_root: Path) -> None:
    st = Store(docs_root)
    (docs_root / "steps.jsonl").write_text('{"x": 1}\n{"x": 2}\n')
    # rows loaded from a jsonl file and a JSON document opened beside it, and no rows per output row: a row of the
    # output opens the files it read as before, never a whole file counted as one row
    q = Q.run(st, "steps", 'm = json.load(open("ep1/u1.json"))\ns = load("steps.jsonl")\n'
              'pd.DataFrame({"who": [m["agent"], "other"], "n": [len(s), 0]})')
    assert q["rows"] is None
    r = LIN.resolve(st, f"{q['id']}#who=u1@n")
    assert set(r["rows"]) == {"ep1/u1.json", "steps.jsonl"} and r["count"] is None and not r["records"]


def test_a_table_built_from_records_finds_its_rows_through_them(docs_root: Path) -> None:
    st = Store(docs_root)
    # one record per call, each resting on the document its pass opened; the output groups the table of them
    code = ('import glob\nrows = []\nfor f in sorted(glob.glob("ep*/u*.json")):\n    d = json.load(open(f))\n'
            '    for m in d["messages"].values():\n        rows.append(dict(run=f.split("/")[0], agent=d["agent"], cmd=m["content"][0]["input"]["command"]))\n'
            'o = pd.DataFrame(rows).sort_values("cmd")\nkeep("calls", o)\no.groupby(["run", "agent"]).size()')
    q = Q.run(st, "calls per run", code)
    assert q["lineage"] == "loop" and q["frame"] == "rows" and q["keys"] == ["run", "agent"]
    r = LIN.resolve(st, f"{q['id']}#run=ep1&agent=u1@value")
    assert r["rows"] == ["ep1/u1.json#/"] and r["chain"][0]["check"] == "the value is 3, the rows are 1"
    assert r["why"].startswith(f"{q['id']} built this output row in a loop over the files it opened (ep1/u1.json)")
    # a later query that groups the kept table finds the same rows, by its index
    u = Q.run(st, "on it", 'o = use("calls").copy()\no["long"] = o.cmd.str.len() > 4\no.groupby(["agent", "long"]).size().reset_index(name="n")')
    assert u["lineage"] == "loop" and u["frame"] == "calls"
    assert LIN.resolve(st, f"{u['id']}#agent=u2&long=true@n")["rows"] == ["ep1/u2.json#/"]
    w = LIN.resolve(st, f"{u['id']}#agent=u1&long=false@n")
    assert set(w["rows"]) == {"ep1/u1.json#/", "ep2/u1.json#/"}
    assert w["why"] == (f"{u['id']} grouped rows of `calls` (kept by {q['id']}), which rest on these 2 rows (ep1/u1.json, "
                        "ep2/u1.json), and it does not keep which of them the value used")
    # what use() gives the later query is the table as kept, with no column of lean's
    v = Q.run(st, "columns", '",".join(use("calls").columns)')
    assert v["stdout"].strip() == "'run,agent,cmd'"


def test_a_table_of_more_records_than_an_output_table_keeps_finds_its_rows_through_them(root: Path) -> None:
    # made-up chat logs long enough that the loop appends more records than an output table keeps (TABLE_MAX)
    per = Q.TABLE_MAX // 2 + 1
    for rel, agent in (("ep1/u1.json", "u1"), ("ep1/u2.json", "u2"), ("ep2/u1.json", "u1")):
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        msgs = {f"m{i}": {"role": "assistant", "content": [{"type": "tool_use", "input": {"command": f"c{i % 7}"}}]} for i in range(per)}
        p.write_text(json.dumps({"agent": agent, "messages": msgs}))
    st = Store(root)
    code = ('import glob\nrows = []\nfor f in sorted(glob.glob("ep*/u*.json")):\n    d = json.load(open(f))\n'
            '    for m in d["messages"].values():\n        rows.append(dict(run=f.split("/")[0], agent=d["agent"], cmd=m["content"][0]["input"]["command"]))\n'
            'o = pd.DataFrame(rows).sort_values("cmd")\nkeep("calls", o)\no.groupby(["run", "agent"]).size()')
    q = Q.run(st, "calls per run", code)
    assert len(q["rows"]) == 3 and 3 * per > Q.TABLE_MAX
    assert q["lineage"] == "loop" and q["rows"] == [["ep1/u1.json#/"], ["ep1/u2.json#/"], ["ep2/u1.json#/"]]
    # the kept table keeps them too: a later query that groups it finds the same rows
    u = Q.run(st, "on it", 'use("calls").groupby("agent").size().reset_index(name="n")')
    assert u["lineage"] == "loop" and u["frame"] == "calls"
    assert set(LIN.resolve(st, f"{u['id']}#agent=u1@n")["rows"]) == {"ep1/u1.json#/", "ep2/u1.json#/"}


def test_a_table_cut_from_a_loaded_frame_keeps_its_rows_for_a_later_query(root: Path) -> None:
    st = Store(root)
    k = Q.run(st, "cut", 'df = load("events.jsonl")\nt = df[df.act == "edit"][["agent", "act"]]\nkeep("edits", t)\nlen(t)')
    assert k["error"] is None
    u = Q.run(st, "per agent", 'use("edits").groupby("agent").size().reset_index(name="n")')
    assert u["lineage"] == "loop" and u["frame"] == "edits"
    r = LIN.resolve(st, f"{u['id']}#agent=a1@n")
    assert r["rows"] == ["events.jsonl#L2,14,26,38"] and r["count"] == 4


def test_a_count_named_by_a_value_opens_the_rows_that_hold_it(root: Path) -> None:
    st = Store(root)
    # a pivot of kinds per slice: the slice's rows behind the row, each kind's count behind its own cell
    p = Q.run(st, "kinds per slice", 'df = load("events.jsonl")\ndf["slice"] = df.step // 10\n'
              'df.pivot_table(index="slice", columns="act", aggfunc="size", fill_value=0).reset_index()')
    assert p["lineage"] == "superset" and p["cells_by"] == "act"
    r = LIN.resolve(st, f"{p['id']}#slice=1@edit")
    assert r["rows"] == ["events.jsonl#L11,14,17,20"] and r["count"] == 4 and not r["notes"] and "why" not in r
    # the row as a whole still opens its slice, and says what was found
    w = LIN.resolve(st, f"{p['id']}#slice=1")
    assert w["count"] == 10 and w["notes"][0].startswith("these 10 rows share the output row's key")
    # an unstack of counts per agent names its columns the same way
    u = Q.run(st, "kinds per agent", 'df = load("events.jsonl")\ndf.groupby(["agent", "act"]).size().unstack(fill_value=0)')
    assert u["cells_by"] == "act" and LIN.resolve(st, f"{u['id']}#agent=a2@test")["rows"] == ["events.jsonl#L3,15,27,39"]
    # a crosstab beside a smaller frame that has the key too: its rows are found in the frame the counts were counted
    # in, whose groups hold them, not in the smaller one
    x = Q.run(st, "agents per kind", 'df = load("events.jsonl")\nfirst = df[df.step < 3]\n'
              'pd.crosstab(df.act, df.agent).reset_index()')
    assert x["frame"] == "df" and x["cells_by"] == "agent"
    assert LIN.resolve(st, f"{x['id']}#act=edit@a1")["rows"] == ["events.jsonl#L2,14,26,38"]
    # the same over a table an earlier query showed (its rows as `_refs`), binned by a number
    t = Q.run(st, "events", 'load("events.jsonl")[["step", "act", "_ref"]]')
    b = Q.run(st, "kinds per bin", f'a = use("{t["id"]}")\na["bin"] = a.step // 20 * 0.5\n'
              'a.groupby(["bin", "act"]).size().unstack(fill_value=0).reset_index()')
    assert b["keys"] == ["bin"] and b["cells_by"] == "act"
    assert LIN.resolve(st, f"{b['id']}#bin=0.5@read")["rows"] == ["events.jsonl#L22,25,28,31,34,37,40"]


# ------------------------------------------------------------------ row sets of transcript blocks

from kernel import refs as R  # noqa: E402
from kernel import sources as S  # noqa: E402


def test_a_block_set_parses_counts_formats_and_expands_like_a_line_set() -> None:
    p = R.parse("a.jsonl#L44.b0-2,45-47.b0")
    assert p["kind"] == "blocks" and p["n"] == 6 and R.count(["a.jsonl#L44.b0-2,45-47.b0"]) == 6
    assert R.single_refs(p) == ["a.jsonl#L44.b0", "a.jsonl#L44.b1", "a.jsonl#L44.b2", "a.jsonl#L45.b0", "a.jsonl#L46.b0",
                                "a.jsonl#L47.b0"]
    assert R.format_source(p) == "a.jsonl#L44.b0-2,45-47.b0"
    # lines that hold the same blocks join; blocks with a gap are two parts
    assert R.format_blocks([(5, 0), (5, 2), (6, 0), (6, 2), (9, 1)]) == "5-6.b0,5-6.b2,9.b1"
    assert R.compress(["a.jsonl#L5.b2", "a.jsonl#L5.b0", "b.jsonl#L1.b0", "a.jsonl#L6.b0", "a.jsonl#L6.b2", "a.jsonl#L2"]) == [
        "a.jsonl#L2", "a.jsonl#L5-6.b0,5-6.b2", "b.jsonl#L1.b0"]
    # one block stays the ref it was
    assert R.parse("a.jsonl#L44.b0")["kind"] == "block" and R.compress(["a.jsonl#L44.b0"]) == ["a.jsonl#L44.b0"]


def _transcript(root: Path, lines: int) -> None:
    with open(root / "t.jsonl", "w") as f:
        for i in range(lines):
            content = [{"type": "text", "text": f"step {i}"}] + [
                {"type": "tool_use", "name": ["Bash", "Read"][(i + j) % 2], "input": {"command": f"ls {i}-{j}"}} for j in range(i % 3 + 1)]
            f.write(json.dumps({"type": "assistant", "message": {"role": "assistant", "content": content}}) + "\n")


CALLS = ('df = load("t.jsonl")\nout = []\nfor ref, msg in zip(df._ref, df.message):\n'
         '    for j, b in enumerate(msg["content"]):\n        if b["type"] == "tool_use":\n'
         '            out.append({"_ref": f"{ref}.b{j}", "name": b["name"]})\ncalls = pd.DataFrame(out)\n')


def test_a_query_resting_on_many_blocks_keeps_block_sets_and_resolves_fast(root: Path) -> None:
    import time

    _transcript(root, 3000)
    st = Store(root)
    q = Q.run(st, "calls by tool", CALLS + 'tally(calls, "name")')
    assert q["lineage"] == "exact" and all(len(r) == 1 for r in q["rows"])
    assert q["rows"][0][0].startswith("t.jsonl#L1.b1,2.b2,3.b1,3.b3,")
    t0 = time.time()
    r = LIN.resolve(st, q["id"])
    assert time.time() - t0 < 5
    # one row set for the file, not 6,000 refs, and a spread of five of its blocks
    assert r["count"] == 6000 and len(r["rows"]) == 1 and R.parse(r["rows"][0])["kind"] == "blocks"
    assert len(r["records"]) == 5 and all(R.parse(x["ref"])["kind"] == "block" for x in r["records"])
    assert all(x["text"].startswith(("Bash", "Read")) for x in r["records"])
    # one tool's row, a block of it, and the rows of the whole query as one summary the model reads
    bash = LIN.resolve(st, f"{q['id']}#name=Bash@n")
    assert bash["count"] == 3000 and bash["chain"][0]["check"] == "the value equals the number of rows"
    one = R.expand(bash["rows"])[7]
    assert LIN.resolve(st, one)["records"][0]["ref"] == one
    # a frame of blocks used by a later query: its rows read as one block set
    u = Q.run(st, "calls again", CALLS + 'keep("calls", calls)\nlen(calls)')
    v = Q.run(st, "share of Bash", 'c = use("calls")\nround((c.name == "Bash").mean(), 2)')
    assert u["error"] is None and v["lineage"] == "summary" and len(v["rows"][0]) == 1 and R.count(v["rows"][0]) == 6000


def test_a_block_set_reads_its_blocks_and_counts_like_the_observer(root: Path) -> None:
    _transcript(root, 5)
    rows = S.fetch(root, "t.jsonl#L2-3.b1,3.b3", limit=None)
    assert [r.ref for r in rows] == ["t.jsonl#L2.b1", "t.jsonl#L3.b1", "t.jsonl#L3.b3"]
    assert rows[2].value["kind"] == "tool_use" and "ls 2-2" in rows[2].value["text"]
    with pytest.raises(R.RefError):
        S.fetch(root, "t.jsonl#L1.b0-3")
    from kernel.store import _rows_in

    assert _rows_in("t.jsonl#L2-3.b1,3.b3") == 3 and _rows_in("t.jsonl#L4.b0") == 1
