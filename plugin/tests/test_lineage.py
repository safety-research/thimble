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


def test_a_count_of_a_filtered_frame_opens_the_filtered_rows(root: Path) -> None:
    # made-up crew list: rows 2, 4 and 5 have no age
    (root / "crew.csv").write_text("name,age,deck\nkai,31,A\nlou,,B\nmo,22,B\nned,,C\nola,,C\npia,47,A\n")
    st = Store(root)
    # a count of missing values, never named as a frame: its rows are the three with no age, not all six
    q = Q.run(st, "no age", 'import pandas as pd\ndf = load("crew.csv")\na = pd.to_numeric(df.age, errors="coerce")\na.isna().sum()')
    r = LIN.resolve(st, f"{q['id']}#row=1@value")
    assert r["count"] == 3 and r["rows"] == ["crew.csv#row=2,4-5"] and "why" not in r
    # a count of a condition's true values
    q = Q.run(st, "deck c", 'df = load("crew.csv")\nc = df.deck == "C"\nc.sum()')
    assert LIN.resolve(st, f"{q['id']}#row=1@value")["rows"] == ["crew.csv#row=4-5"]
    # a count that two different row sets fit rests on every row read, as before
    q = Q.run(st, "two", 'df = load("crew.csv")\na = df.deck == "A"\nb = df.deck == "B"\nb.sum()')
    r = LIN.resolve(st, f"{q['id']}#row=1@value")
    assert r["count"] == 6 and "why" in r


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


def test_a_long_message_cited_by_words_that_name_a_passage_opens_on_that_passage_marked(root: Path) -> None:
    # a made-up transcript: the agent's long final summary names its result deep inside, in other words than the reply's
    filler = " ".join(f"Step {i} set up the data and checked the loader again." for i in range(1, 30))
    summary = (f"All done. Here is the whole picture. {filler} Main result: prompting gave 98% recall but **41% over-asking** on "
               f"complete items, and the short fine-tune fixed it (over-ask -> 3.6%, p=0.001). {filler}")
    with open(root / "talk.jsonl", "w") as f:
        f.write(json.dumps({"type": "user", "message": {"role": "user", "content": "go"}}) + "\n")
        f.write(json.dumps({"type": "assistant", "timestamp": "2026-03-04T10:00:00Z",
                            "message": {"role": "assistant", "content": [{"type": "text", "text": summary}]}}) + "\n")
    st = Store(root)
    hot = next(x for x in LIN.resolve(st, "talk.jsonl#L2", label="cut over-asking from 41% to 3.6%")["span"]["rows"] if x["hot"])
    # not the message's first lines: the passage that holds the cited numbers, with a line of context before it, marked
    assert not hot["text"].startswith("All done"), hot["text"][:80]
    marked = hot["text"][hot["at"][0]:hot["at"][1]]
    assert marked.startswith("41% over-asking") and marked.endswith("3.6%"), marked
    assert 40 <= hot["at"][0] <= 200 and hot["text"].startswith("…")
    # a percent the words write may stand at the low end of a range of percents in the text
    text = "prompting gave 35–45% over-asking, and after the fine-tune over-ask -> 2.8% on the same items"
    at = LIN._named(text, "from 35% to 2.8%")[1]
    assert text[at[0]:at[1]] == "35–45% over-asking, and after the fine-tune over-ask -> 2.8%"
    # words that name nothing in it leave the message's first words as they were
    other = next(x for x in LIN.resolve(st, "talk.jsonl#L2", label="trained for 12 hours")["span"]["rows"] if x["hot"])
    assert "at" not in other and other["text"].startswith("All done")


def test_a_cited_event_row_shows_the_time_hashes_and_flag_its_words_name(root: Path) -> None:
    # made-up audit log: a push, then a forced branch move; an event row has no sentence, only an action and fields
    rows = [{"id": 1, "ts": "2026-05-04T09:10:02.100+00:00", "agent": "otter-3", "action": "repo.push", "params": {"branch": "fix/9", "commits": 2}},
            {"id": 2, "ts": "2026-05-04T09:21:47.800+00:00", "agent": "otter-3", "action": "repo.ref",
             "params": {"ref": "refs/heads/fix/9", "old": "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678", "new": "0f1e2d3c4b5a69788796a5b4c3d2e1f001234567", "forced": True, "created": False}},
            {"id": 3, "ts": "2026-05-04T09:30:00.000+00:00", "agent": "heron-1", "action": "repo.push", "params": {"branch": "fix/9", "commits": 1}}]
    with open(root / "audit.jsonl", "w") as f:
        f.write("".join(json.dumps(r) + "\n" for r in rows))
    st = Store(root)
    hot = next(r for r in LIN.span(st, "audit.jsonl#L2", label="09:21")["rows"] if r["hot"])
    assert hot["text"] == "repo.ref · agent otter-3"
    assert hot["meta"].startswith("2026-05-04 09:21:47")
    assert "old a1b2c3d" in hot["meta"] and "new 0f1e2d3" in hot["meta"] and "forced" in hot["meta"]
    assert "created" not in hot["meta"] and "id 2" not in hot["meta"]
    # words that write a hash longer than 7 characters name it, and it is shown as long as they write it
    hot = next(r for r in LIN.span(st, "audit.jsonl#L2", label="from a1b2c3d4 to 0f1e2d3c")["rows"] if r["hot"])
    assert hot["meta"].startswith("old a1b2c3d4 · new 0f1e2d3c")
    # words that name the flag put it first
    hot = next(r for r in LIN.span(st, "audit.jsonl#L2", label="the branch moved, marked forced")["rows"] if r["hot"])
    assert hot["meta"].startswith("forced · 2026-05-04 09:21:47")
    # the rows around it stay one line each
    assert all("meta" not in r for r in LIN.span(st, "audit.jsonl#L2", label="09:21")["rows"] if not r["hot"])
    # a row with a sentence keeps its words; only a field the citation names is added
    with open(root / "say.jsonl", "w") as f:
        f.write(json.dumps({"user": "ana", "text": "moved the map to the parks page", "bytes": 4120, "day": "2026-03-04"}) + "\n")
    hot = LIN.span(st, "say.jsonl#L1", label="4120 bytes")["rows"][0]
    assert hot["text"] == "moved the map to the parks page" and hot["meta"].startswith("bytes 4120")
    assert "bytes" not in LIN.span(st, "say.jsonl#L1", label="moved the map")["rows"][0].get("meta", "")


def test_rows_of_a_file_are_named_by_one_field_not_by_whichever_is_longest(root: Path) -> None:
    # made-up passengers: row 3's name is short and its ticket long, so row by row its ticket would name it
    rows = [("Lindqvist, Mr. Osmo Rainer", "A 1234"), ("Varga, Mrs. Ilona Petra", "B 22"),
            ("Aho, Mr. Tuomo", "QX/R.S. 7700123"), ("Brandt, Miss. Edda Marie", "C 3"), ("Okafor, Mr. Chidi Nnamdi", "D 41")]
    with open(root / "voyagers.csv", "w") as f:
        f.write("Id,Name,Ticket\n" + "".join(f'{i},"{n}",{t}\n' for i, (n, t) in enumerate(rows, 1)))
    st = Store(root)
    sp = LIN.span(st, "voyagers.csv#row=3")
    assert sp is not None
    words = {r["n"]: r["text"] for r in sp["rows"]}
    assert words[3] == "Aho, Mr. Tuomo" and words[2] == "Varga, Mrs. Ilona Petra"
    recs = LIN.records(st, ["voyagers.csv#row=1-5"], n=5, pick="first")
    assert [r["words"] for r in recs][2] == "Aho, Mr. Tuomo"


def test_a_count_named_like_a_0_1_column_opens_the_rows_of_its_group_where_that_column_is_1(tmp_path: Path) -> None:
    d = tmp_path / "data"
    d.mkdir()
    (d / "crew.csv").write_text("name,band,Rescued\nkai,hi,1\nlou,hi,1\nmo,hi,0\nned,lo,0\nola,lo,1\n")
    st = Store(d)

    def opens(q: dict, col: str) -> tuple[int, list[str]]:
        r = LIN.resolve(st, f"{q['id']}#band=hi@{col}", n=10)
        checks = [c["check"] for c in r["chain"] if c.get("check")]
        assert checks == ["the value equals the number of rows"], checks
        return r["count"], [x["ref"] for x in r["records"]]

    hi = (2, ["crew.csv#row=1", "crew.csv#row=2"])
    # a count added beside a tally's groups, named differently from the 0/1 column (`rescued`, `Rescued`)
    q = Q.run(st, "rescued per band", "df = load('crew.csv')\ndf['Rescued'] = df.Rescued.astype(int)\n"
              "t = tally(df, 'band')\nt['rescued'] = df.groupby('band').Rescued.sum().reindex(t.band).values\nt")
    assert opens(q, "rescued") == hi
    # ... and named the same as a 0/1 column the query made
    q = Q.run(st, "rescued per band", "df = load('crew.csv')\ndf['rescued'] = df.Rescued.astype(int)\n"
              "t = tally(df, 'band')\nt['rescued'] = df.groupby('band').rescued.sum().reindex(t.band).values\nt")
    assert opens(q, "rescued") == hi
    # a group found by key: the same
    q = Q.run(st, "rescued per band", "df = load('crew.csv')\ndf['Rescued'] = df.Rescued.astype(int)\n"
              "df.groupby('band').agg(n=('name', 'size'), Rescued=('Rescued', 'sum')).reset_index()")
    assert opens(q, "Rescued") == hi
    # a count that is not the number of its group's rows marked 1 keeps none of its own
    q = Q.run(st, "rescued per band", "df = load('crew.csv')\ndf['Rescued'] = df.Rescued.astype(int)\n"
              "t = tally(df, 'band')\nt['rescued'] = [3, 2]\nt")
    assert not q.get("cells")
