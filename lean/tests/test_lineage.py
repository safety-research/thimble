"""Values of queries that keep no rows per output row: a summary (a number, a dict of numbers, one row of values) rests
on the rows the query read, a count that equals one frame's rows on that frame's, a merge keeps both sides' rows,
records built in code find their rows by key, and every value with no rows of its own says in one line why (`why` in
`lean resolve --json`). Old query records, which have none of the new fields, still resolve.
Run: LEAN_PYTHON-or-any-python-with-pandas -m pytest lean/tests"""
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
    monkeypatch.setenv("LEAN_SESSION", "s-lin")
    monkeypatch.delenv("LEAN_ROOT", raising=False)
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
    env = {**os.environ, "LEAN_ROOT": str(root)}
    out = subprocess.run([sys.executable, str(ENGINE / "lean.py"), "resolve", f"{q['id']}#key=share@value", "--json"],
                         capture_output=True, text=True, env=env, check=True).stdout
    r = json.loads(out)
    assert r["count"] == 12 and r["why"].startswith(f"{q['id']} computed this value over all 12 rows")
    text = subprocess.run([sys.executable, str(ENGINE / "lean.py"), "resolve", f"{q['id']}#key=share@value"],
                          capture_output=True, text=True, env=env, check=True).stdout
    assert "  why: " in text


def test_a_card_value_bound_to_a_summary_says_its_rows_are_all_the_query_read(root: Path) -> None:
    from kernel import objects as O

    st = Store(root)
    q = Q.run(st, "share", 'df = load("edits.jsonl")\n{"ana_share": round((df.user == "ana").mean(), 2)}')
    obj = O.save(st, "share", {"title": "Ana's share", "data": {"s": f"{q['id']}#key=ana_share"}})
    r = LIN.resolve(st, f"obj:{obj['id']}#/s/value")
    assert r["count"] == 12 and r["why"].startswith(f"{q['id']} computed this value over all 12 rows it read")
