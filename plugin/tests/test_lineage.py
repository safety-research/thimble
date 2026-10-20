"""Values of queries that keep no rows per output row: a summary (a number, a dict of numbers, one row of values) rests
on the rows the query read, a count that equals one frame's rows on that frame's, a merge keeps both sides' rows,
records built in code find their rows by key, and every value with no rows of its own says in one line why (`why` in
`thimble resolve --json`). Old query records, which have none of the new fields, still resolve.
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


# ------------------------------------------------------------------ records built in a loop

# made-up runs: two folders, each with its tickets (some closed) and a log of steps
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
