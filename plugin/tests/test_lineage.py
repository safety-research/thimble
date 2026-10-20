"""Values of queries that keep no rows per output row: a summary (a number, a dict of numbers, one row of values) rests
on the rows the query read, a count that equals one frame's rows on that frame's, a merge keeps both sides' rows,
records built in code find their rows by key, and every value with no rows of its own says in one line why (`why` in
`thimble resolve --json`). Old query records, which have none of the new fields, still resolve.
Run: THIMBLE_PYTHON-or-any-python-with-pandas -m pytest plugin/tests"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

ENGINE = Path(__file__).resolve().parents[1] / "engine"
sys.path.insert(0, str(ENGINE))

from kernel import lineage as LIN  # noqa: E402
from kernel import query as Q  # noqa: E402
from kernel.store import Store  # noqa: E402

# made-up edits: 12 saves by four editors over three days, and the pages they touched
EDITS = [("ana", "p1", "2026-03-01"), ("ana", "p2", "2026-03-01"), ("bo", "p1", "2026-03-01"), ("ana", "p3", "2026-03-02"),
         ("cy", "p2", "2026-03-02"), ("bo", "p3", "2026-03-02"), ("ana", "p1", "2026-03-02"), ("dee", "p4", "2026-03-03"),
         ("bo", "p2", "2026-03-03"), ("ana", "p4", "2026-03-03"), ("cy", "p1", "2026-03-03"), ("ana", "p2", "2026-03-03")]


@pytest.fixture()
def root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    d = tmp_path / "data"
    d.mkdir()
    with open(d / "edits.jsonl", "w") as f:
        for i, (who, page, day) in enumerate(EDITS):
            f.write(json.dumps({"user": who, "page": page, "day": day, "bytes": 100 + 7 * i}) + "\n")
    with open(d / "pages.jsonl", "w") as f:
        for p, topic in [("p1", "tax"), ("p2", "tax"), ("p3", "parks"), ("p4", "roads")]:
            f.write(json.dumps({"page": p, "topic": topic}) + "\n")
    (d / "notes.md").write_text("# notes\nfirst\nsecond\n")
    monkeypatch.setenv("THIMBLE_HOME", str(tmp_path / "th"))
    monkeypatch.setenv("THIMBLE_SESSION", "s-lin")
    monkeypatch.delenv("THIMBLE_ROOT", raising=False)
    return d


def test_a_dict_of_numbers_opens_rows_a_count_its_frames_and_a_share_all_rows_read(root: Path) -> None:
    st = Store(root)
    q = Q.run(st, "june summary", 'df = load("edits.jsonl")\nj = df[df.user == "ana"]\n'
              '{"ana_edits": len(j), "all": len(df), "ana_share": round(len(j) / len(df), 2)}')
    assert q["lineage"] == "summary"
    by = {r["key"]: i for i, r in enumerate(q["table"])}
    # a count that equals one frame's rows rests on that frame's rows, and says nothing more
    r = LIN.resolve(st, f"{q['id']}#key=ana_edits@value")
    assert r["count"] == 6 and r["rows"] == ["edits.jsonl#L1-2,4,7,10,12"] and "why" not in r
    assert LIN.resolve(st, f"{q['id']}#key=all@value")["count"] == 12
    # a share rests on every row the query read, and says so in one line
    r = LIN.resolve(st, f"{q['id']}#row={by['ana_share'] + 1}@value")
    assert r["count"] == 12 and r["records"]
    assert r["why"] == f"{q['id']} computed this value over all 12 rows it read (edits.jsonl), and it does not keep which of them the value used"


def test_one_row_of_values_and_a_single_number_rest_on_the_rows_read(root: Path) -> None:
    st = Store(root)
    q = Q.run(st, "totals", 'df = load("edits.jsonl")\npd.DataFrame([{"editors": df.user.nunique(), "mean_bytes": df.bytes.mean()}])')
    assert q["lineage"] == "summary" and q["rows"] == [["edits.jsonl#L1-12"]]
    r = LIN.resolve(st, f"{q['id']}@mean_bytes")
    assert r["count"] == 12 and "computed this value over all 12 rows" in r["why"]
    s = Q.run(st, "mean", 'df = load("edits.jsonl")\ndf.bytes.mean()')
    assert s["lineage"] == "summary" and LIN.resolve(st, s["id"])["count"] == 12


def test_a_merge_keeps_both_sides_rows(root: Path) -> None:
    st = Store(root)
    q = Q.run(st, "edits per topic", 'e = load("edits.jsonl")\np = load("pages.jsonl")\nm = e.merge(p, on="page")\n'
              'm.groupby("topic").size().rename("n").reset_index()')
    assert q["lineage"] == "matched", "the merged frame's `_ref_x` and `_ref_y` hold its rows"
    r = LIN.resolve(st, f"{q['id']}#topic=parks@n")
    assert set(r["rows"]) == {"edits.jsonl#L4,6", "pages.jsonl#L3"} and "why" not in r
    # tally() over a merged frame keeps both sides' rows too
    t = Q.run(st, "tally merged", 'e = load("edits.jsonl")\np = load("pages.jsonl")\ntally(e.merge(p, on="page"), "topic")')
    assert t["lineage"] == "exact"
    assert set(LIN.resolve(st, f"{t['id']}#topic=roads@n")["rows"]) == {"edits.jsonl#L8,10", "pages.jsonl#L4"}


def test_records_built_in_code_find_their_rows_by_key(root: Path) -> None:
    st = Store(root)
    code = ('df = load("edits.jsonl")\nout = []\nfor u, g in df.groupby("user"):\n'
            '    out.append({"user": u, "edits": len(g), "pages": g.page.nunique()})\nout')
    q = Q.run(st, "per editor", code)
    assert q["table"] and q["rows"] is not None and q["lineage"] == "matched"
    assert LIN.resolve(st, f"{q['id']}#user=cy@edits")["rows"] == ["edits.jsonl#L5,11"]


def test_a_printed_query_opens_every_row_it_read_and_says_why(root: Path) -> None:
    st = Store(root)
    q = Q.run(st, "look", 'df = load("edits.jsonl")\nprint(df.user.value_counts())')
    assert q["table"] is None and q["read"] == ["edits.jsonl#L1-12"]
    r = LIN.resolve(st, q["id"])
    assert r["count"] == 12
    assert r["why"] == f"{q['id']} only printed its output, so a number in it has no rows of its own; these are all 12 rows it read (edits.jsonl)"


def test_values_with_no_rows_say_why_in_one_line(root: Path) -> None:
    st = Store(root)
    # computed from no source rows
    c = Q.run(st, "a constant", 'pd.DataFrame([{"k": "a", "v": 1}, {"k": "b", "v": 2}])')
    r = LIN.resolve(st, f"{c['id']}#k=a@v")
    assert not r["count"] and r["why"] == f"{c['id']} computed its output in code from no source rows"
    # a loop over rows()
    lp = Q.run(st, "loop", 'n = Counter()\nfor ref, row in rows("edits.jsonl"):\n    n[row["day"]] += 1\n'
               'pd.DataFrame([{"day": d, "n": k} for d, k in sorted(n.items())])')
    r = LIN.resolve(st, f"{lp['id']}#day=2026-03-01@n")
    assert not r["count"] and "in a loop over rows() of edits.jsonl" in r["why"]
    # files opened in code
    op = Q.run(st, "opened", 'lines = open("notes.md").read().splitlines()\npd.DataFrame([{"line": x, "len": len(x)} for x in lines])')
    assert "from files it opened (notes.md), not with load()" in LIN.resolve(st, f"{op['id']}#row=1@len")["why"]
    # a query that builds on one that keeps no rows
    up = Q.run(st, "on the loop", f'use("{lp["id"]}").sort_values("n").head(2)')
    assert LIN.resolve(st, f"{up['id']}#row=1@n")["why"] == f"{up['id']} builds on {lp['id']}, which keeps no rows"
    # keys that match no frame: the row says why, the query as a whole opens every row it read
    k = Q.run(st, "renamed keys", 'df = load("edits.jsonl")\ng = df.groupby("user").size()\n'
              'pd.DataFrame({"who": [u.upper() for u in g.index], "n": g.values})')
    r = LIN.resolve(st, f"{k['id']}#who=ANA@n")
    assert not r["count"] and r["why"] == f"{k['id']} does not keep the rows behind each output row: its key (who) matches no rows of a frame it read"
    whole = LIN.resolve(st, k["id"])
    assert whole["count"] == 12 and whole["why"].endswith("; these are all 12 rows it read (edits.jsonl)")


def test_an_old_query_record_without_the_new_fields_still_resolves_and_says_why(root: Path) -> None:
    st = Store(root)
    q = Q.run(st, "look", 'df = load("edits.jsonl")\nprint(len(df))')
    f = root / "thimble" / "queries" / f"{q['id']}.json"
    old = json.loads(f.read_text())
    for k in ("read", "why_rows", "via"):
        old.pop(k, None)
    f.write_text(json.dumps(old))
    r = LIN.resolve(st, q["id"])
    assert r["count"] is None and r["rows"] == ["edits.jsonl"]
    assert r["why"] == f"{q['id']} only printed its output, so a number in it has no rows of its own"


def test_resolve_json_carries_why(root: Path) -> None:
    st = Store(root)
    q = Q.run(st, "share", 'df = load("edits.jsonl")\n{"share": 0.5}')
    env = {**os.environ, "THIMBLE_ROOT": str(root)}
    out = subprocess.run([sys.executable, str(ENGINE / "thimble.py"), "resolve", f"{q['id']}#key=share@value", "--json"],
                         capture_output=True, text=True, env=env, check=True).stdout
    r = json.loads(out)
    assert r["count"] == 12 and r["why"].startswith(f"{q['id']} computed this value over all 12 rows")
    text = subprocess.run([sys.executable, str(ENGINE / "thimble.py"), "resolve", f"{q['id']}#key=share@value"],
                          capture_output=True, text=True, env=env, check=True).stdout
    assert "  why: " in text


def test_a_card_value_bound_to_a_summary_says_its_rows_are_all_the_query_read(root: Path) -> None:
    from kernel import objects as O

    st = Store(root)
    q = Q.run(st, "share", 'df = load("edits.jsonl")\n{"ana_share": round((df.user == "ana").mean(), 2)}')
    obj = O.save(st, "share", {"title": "Ana's share", "data": {"s": f"{q['id']}#key=ana_share"}})
    r = LIN.resolve(st, f"obj:{obj['id']}#/s/value")
    assert r["count"] == 12 and r["why"].startswith(f"{q['id']} computed this value over all 12 rows it read")


def test_a_dict_built_from_a_column_and_a_renamed_key_find_their_rows_by_value(root: Path) -> None:
    st = Store(root)
    q = Q.run(st, "edits per editor", 'df = load("edits.jsonl")\ndict(Counter(df.user))')
    assert q["lineage"] == "matched" and len(q["table"]) == 4
    assert LIN.resolve(st, f"{q['id']}#key=bo@value")["rows"] == ["edits.jsonl#L3,6,9"]
    r = Q.run(st, "renamed", 'df = load("edits.jsonl")\ng = df.groupby("page").size()\n'
              'pd.DataFrame({"which_page": g.index, "saves": g.values})')
    assert r["lineage"] == "matched" and r["keys"] == ["which_page"]
    assert LIN.resolve(st, f"{r['id']}#which_page=p4@saves")["rows"] == ["edits.jsonl#L8,10"]


def test_a_later_query_on_a_summary_copies_no_rows_into_it(root: Path) -> None:
    st = Store(root)
    s = Q.run(st, "totals", 'df = load("edits.jsonl")\npd.DataFrame([{"mean_bytes": df.bytes.mean()}])')
    t = Q.run(st, "on it", f'use("{s["id"]}")')
    assert t["lineage"] == "exact" and t["rows"] == [[]]
    assert LIN.resolve(st, f"{t['id']}#row=1@mean_bytes")["why"] == f"{t['id']} builds on {s['id']}, a summary whose values keep no rows of their own"
    # the summary itself still opens every row it read
    assert LIN.resolve(st, f"{s['id']}@mean_bytes")["count"] == 12


# ------------------------------------------------------------------ records built in a loop

# made-up runs: two folders, each with its tickets (some closed) and a log of steps
RUNS = {
    "alpha": {"tickets": [("t1", "closed", "kim"), ("t2", "open", "lee"), ("t3", "closed", "lee"), ("t4", "closed", "kim")],
              "steps": ["2026-05-01T10:00:00", "2026-05-01T10:40:00", "2026-05-01T11:00:00", "2026-05-01T11:30:00",
                        "2026-05-01T12:00:00"]},
    "beta": {"tickets": [("t5", "open", "max"), ("t6", "closed", "max")],
             "steps": ["2026-05-02T09:00:00", "2026-05-02T09:20:00", "2026-05-02T09:45:00"]},
}


@pytest.fixture()
def runs_root(root: Path) -> Path:
    for run, d in RUNS.items():
        f = root / "runs" / run
        f.mkdir(parents=True)
        with open(f / "tickets.jsonl", "w") as h:
            for tid, state, who in d["tickets"]:
                h.write(json.dumps({"id": tid, "state": state, "closer": who}) + "\n")
        with open(f / "steps.jsonl", "w") as h:
            for ts in d["steps"]:
                h.write(json.dumps({"ts": ts}) + "\n")
    return root


LOOP = '''import glob
out = []
for f in sorted(glob.glob("runs/*/tickets.jsonl")):
    run = f.split("/")[1]
    t = load(f)
    done = t[t.state == "closed"]
    by_kim = done.closer == "kim"
    st = load(f"runs/{run}/steps.jsonl")
    out.append(dict(run=run, closed=len(done), not_kim=int((~by_kim).sum()),
                    hours=round((pd.to_datetime(st.ts.max()) - pd.to_datetime(st.ts.min())).total_seconds() / 3600, 1)))
'''


def test_records_appended_in_a_loop_keep_each_iterations_rows(runs_root: Path) -> None:
    st = Store(runs_root)
    q = Q.run(st, "per run", LOOP + "pd.DataFrame(out)")
    assert q["lineage"] == "loop" and q["frame"] == "out" and q["keys"] == ["run"]
    # a count that equals a frame the iteration made opens that frame's rows, exactly
    r = LIN.resolve(st, f"{q['id']}#run=alpha@closed")
    assert r["rows"] == ["runs/alpha/tickets.jsonl#L1,3-4"] and r["count"] == 3 and "why" not in r
    assert r["chain"][-1]["check"] == "the value equals the number of rows"
    # a count of the rows a yes/no column marks (or leaves) opens those rows
    assert LIN.resolve(st, f"{q['id']}#run=alpha@not_kim")["rows"] == ["runs/alpha/tickets.jsonl#L3"]
    # any other value opens what its own iteration loaded and filtered, and says so; never another run's rows
    h = LIN.resolve(st, f"{q['id']}#run=beta@hours")
    assert set(h["rows"]) == {"runs/beta/tickets.jsonl#L2", "runs/beta/steps.jsonl#L1-3"}
    assert h["why"] == (f"{q['id']} made this output row in a loop from these 4 rows (runs/beta/steps.jsonl, "
                        "runs/beta/tickets.jsonl), the frames it loaded and filtered for it, and it does not keep which of them the value used")
    # a card bound to the table: its values open the same rows
    from kernel import objects as O

    obj = O.save(st, "runs", {"title": "Closed per run", "data": {"runs": q["id"]}})
    c = LIN.resolve(st, f"obj:{obj['id']}#/runs/0/closed")
    assert c["rows"] == ["runs/alpha/tickets.jsonl#L1,3-4"] and "why" not in c
    assert LIN.resolve(st, f"obj:{obj['id']}#/runs/1/hours")["why"].startswith(f"{q['id']} made this output row in a loop")
    # a later query that uses the table keeps each row's rows
    u = Q.run(st, "on it", f'use("{q["id"]}").sort_values("hours")')
    assert u["lineage"] == "exact" and LIN.resolve(st, f"{u['id']}#run=beta@hours")["count"] == 4


def test_a_sorted_or_filtered_table_of_records_finds_each_records_rows(runs_root: Path) -> None:
    st = Store(runs_root)
    q = Q.run(st, "sorted", LOOP + 'pd.DataFrame(out).sort_values("closed")')
    assert q["lineage"] == "loop" and [r["run"] for r in q["table"]] == ["beta", "alpha"]
    assert LIN.resolve(st, f"{q['id']}#run=beta@closed")["rows"] == ["runs/beta/tickets.jsonl#L2"]
    f = Q.run(st, "renamed", LOOP + 'pd.DataFrame(out).reset_index(drop=True).rename(columns={"closed": "n_closed"})')
    assert f["lineage"] == "loop" and LIN.resolve(st, f"{f['id']}#run=alpha@n_closed")["count"] == 3
    # tuples with named columns, and the list itself as the output
    t = Q.run(st, "tuples", LOOP.replace("out.append(dict(run=run, closed=len(done), not_kim=int((~by_kim).sum()),",
                                         "out.append((run, len(done), int((~by_kim).sum()),").replace("hours=round(", "round(")
              + 'pd.DataFrame(out, columns=["run", "closed", "not_kim", "hours"])')
    assert t["lineage"] == "loop" and LIN.resolve(st, f"{t['id']}#run=beta@closed")["rows"] == ["runs/beta/tickets.jsonl#L2"]
    w = Q.run(st, "the list", LOOP + "out")
    assert w["lineage"] == "loop" and LIN.resolve(st, f"{w['id']}#run=alpha@closed")["count"] == 3
    # a record made by a function: what the function loaded for it stands behind it (its filtered frames are gone)
    fn = Q.run(st, "by a function", 'def per(run):\n    t = load(f"runs/{run}/tickets.jsonl")\n'
               '    return {"run": run, "closed": int((t.state == "closed").sum())}\nout = []\n'
               'for run in ["alpha", "beta"]:\n    out.append(per(run))\npd.DataFrame(out)')
    assert fn["lineage"] == "loop" and fn["rows"][1] == ["runs/beta/tickets.jsonl#L1-2"]
    # its count named by a value (state "closed") still opens the rows that hold it
    assert LIN.resolve(st, f"{fn['id']}#run=beta@closed")["rows"] == ["runs/beta/tickets.jsonl#L2"]


def test_a_loop_whose_records_hold_the_same_rows_keeps_none_per_row(root: Path) -> None:
    st = Store(root)
    # one frame held across the loop, no frame made per record: nothing is known per row, and the old reason stands
    q = Q.run(st, "row by row", 'df = load("edits.jsonl")\nout = []\nfor i, r in df.head(3).iterrows():\n'
              '    out.append({"who": r.user.upper(), "big": r.bytes > 110})\npd.DataFrame(out)')
    assert q["lineage"] != "loop" and not q.get("cells")
    # an append that fails reports the query's own line, as before
    e = Q.run(st, "bad", 'df = load("edits.jsonl")\nx = 1\ndf.append({"a": 1})')
    assert e["error"] and "line 3" in e["stdout"] and "__lean_append__" not in e["stdout"]
    # appends that are not records (names, frames) are only appends
    n = Q.run(st, "names", 'names = []\nfor u in ["a", "b"]:\n    names.append(u)\nlen(names)')
    assert n["table"] == [{"value": 2}]


def test_counts_of_a_groupby_loop_keep_their_own_rows_beside_the_rows_found_by_key(runs_root: Path) -> None:
    st = Store(runs_root)
    s = Q.run(st, "steps per run", 's = load("runs/*/steps.jsonl")\ns["run"] = s._file.str.extract(r"runs/([^/]+)/", expand=False)\n'
              'tally(s, "run")')
    code = ('t = load("runs/*/tickets.jsonl")\nt["run"] = t._file.str.extract(r"runs/([^/]+)/", expand=False)\n'
            f'steps = use("{s["id"]}").set_index("run")["n"]\nout = []\n'
            'for run, g in t.groupby("run"):\n'
            '    out.append({"run": run, "steps": int(steps[run]), "tickets": len(g), "closed": int((g.state == "closed").sum()),\n'
            '                "open": int((g.state == "open").sum()), "kim": int((g.closer == "kim").sum()),\n'
            '                "share": round(float((g.state == "closed").mean()), 2)})\npd.DataFrame(out)')
    q = Q.run(st, "per run", code)
    # the rows of each output row were found another way (here the used table's, by place); the counts still keep
    # their own rows from the pass that made the row: a frame of that many rows, or the rows holding a value they name
    assert q["lineage"] != "loop" and q.get("cells") and q.get("loop") == "out"
    assert LIN.resolve(st, f"{q['id']}#run=alpha@closed")["rows"] == ["runs/alpha/tickets.jsonl#L1,3-4"]
    assert LIN.resolve(st, f"{q['id']}#run=alpha@open")["rows"] == ["runs/alpha/tickets.jsonl#L2"]
    assert LIN.resolve(st, f"{q['id']}#run=alpha@kim")["rows"] == ["runs/alpha/tickets.jsonl#L1,4"]
    assert LIN.resolve(st, f"{q['id']}#run=beta@tickets")["rows"] == ["runs/beta/tickets.jsonl#L1-2"]
    # a value that keeps no rows of its own opens its row's and says so in one line; a count of the row's rows does not
    sh = LIN.resolve(st, f"{q['id']}#run=alpha@share")
    assert sh["why"].startswith(f"{q['id']} does not keep which rows this value used: these are the")
    st_ = LIN.resolve(st, f"{q['id']}#run=alpha@steps")
    assert st_["count"] == 5 and "why" not in st_


# ------------------------------------------------------------------ the span a citation of a file opens


def test_a_quote_resolves_to_its_span_the_rows_around_it_and_the_quoted_words_in_the_field_that_holds_them(root: Path) -> None:
    with open(root / "say.jsonl", "w") as f:
        for i in range(1, 7):
            f.write(json.dumps({"user": f"u{i}", "body": f"page body {i}", "change_summary": f"summary {i}"}) + "\n")
        f.write(json.dumps({"user": "kim", "body": "a long page body", "change_summary": "add SEC county map sources"}) + "\n")
        f.write(json.dumps({"user": "lee", "body": "the next body", "change_summary": "tidy"}) + "\n")
    st = Store(root)
    r = LIN.resolve(st, "say.jsonl#L7", label='"add SEC county map"')
    sp = r["span"]
    assert sp["path"] == "say.jsonl" and sp["file"] == str((root / "say.jsonl").resolve()) and sp["unit"] == "line"
    # two rows before it, the one after it (the file ends there), each as its words
    assert [(x["n"], x["hot"]) for x in sp["rows"]] == [(5, False), (6, False), (7, True), (8, False)]
    assert sp["rows"][0]["text"] == "page body 5"
    hot = sp["rows"][2]
    # the quote is not in the row's words (its body): the row reads as the field that holds it, the quote placed
    assert hot["field"] == "change_summary" and hot["text"] == "add SEC county map sources"
    assert hot["text"][hot["at"][0]:hot["at"][1]] == "add SEC county map"
    assert '"change_summary": "add SEC county map sources"' in sp["raw"]
    # a quote in the row's words is marked there, with no field named
    hot = LIN.resolve(st, "say.jsonl#L7", label='"a long page"')["span"]["rows"][2]
    assert hot["text"] == "a long page body" and hot["at"] == [0, 11] and "field" not in hot
    # words that quote nothing (a number) mark nothing
    assert "at" not in LIN.resolve(st, "say.jsonl#L7", label="7 saves")["span"]["rows"][2]
    # an ellipsis splits a quote: from its first part to the end of its last
    hot = LIN.resolve(st, "say.jsonl#L7", label="“add SEC … map”")["span"]["rows"][2]
    assert hot["text"][hot["at"][0]:hot["at"][1]] == "add SEC county map"


def test_lines_of_a_text_file_resolve_to_their_span_and_a_query_or_a_whole_file_to_none(root: Path) -> None:
    (root / "notes.md").write_text("# notes\nfirst\nsecond line here\nthird\nfourth\nfifth\n")
    st = Store(root)
    sp = LIN.resolve(st, "notes.md#L3", label='"second line"')["span"]
    assert [(x["n"], x["hot"], x["text"]) for x in sp["rows"]] == [(1, False, "# notes"), (2, False, "first"), (3, True, "second line here"), (4, False, "third"), (5, False, "fourth")]
    assert sp["rows"][2]["at"] == [0, 11] and "raw" not in sp
    assert [x["n"] for x in LIN.resolve(st, "notes.md#L2-3")["span"]["rows"]] == [1, 2, 3, 4, 5]
    q = Q.run(st, "per user", 'df = load("edits.jsonl")\ntally(df, "user")')
    assert "span" not in LIN.resolve(st, f"{q['id']}#user=ana@n")
    assert "span" not in LIN.resolve(st, "edits.jsonl")
    assert LIN.span(st, "edits.jsonl#L99") is None


def test_a_value_of_a_card_names_the_refs_its_part_carries(root: Path) -> None:
    from kernel import objects as O

    st = Store(root)
    q = Q.run(st, "edits per day", 'df = load("edits.jsonl")\ntally(df, "day")')
    O.save(st, "per-day", {"title": "Edits per day", "data": {"days": q["id"]}})
    r = LIN.resolve(st, "obj:per-day#/days/1/n")
    step = r["chain"][0]
    assert step["step"] == "object" and step["id"] == "01-per-day"
    assert step["marks"] == ["obj:01-per-day#/days/1/n", "obj:01-per-day#/days/1", f"{q['id']}#day=2026-03-02"]
