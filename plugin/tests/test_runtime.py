"""The kernel's side of the card runtime: every row bound into a card carries its own ref, a group key with spaces or
brackets round-trips through a citation, a citation of a whole query opens the one row behind the value it shows,
examples are spread across a group's rows, a save is an event of the session's change feed, and every card has a
title. Run: THIMBLE_PYTHON-or-any-python-with-pandas -m pytest plugin/tests"""
from __future__ import annotations

import json
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
from kernel.store import Store  # noqa: E402

OUTCOMES = ["won (clean ep)"] * 3 + ["lost (clean ep)"] * 2 + ["failed/adversarial"] * 4 + ["contested"]


@pytest.fixture()
def root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    d = tmp_path / "data"
    d.mkdir()
    with open(d / "runs.jsonl", "w") as f:
        for i, o in enumerate(OUTCOMES):
            f.write(json.dumps({"run": f"ep{i:02d}", "outcome": o, "calls": 100 + 10 * i, "summary": f"episode {i} ended {o}"}) + "\n")
    monkeypatch.setenv("THIMBLE_HOME", str(tmp_path / "th"))
    monkeypatch.setenv("THIMBLE_SESSION", "s-run")
    monkeypatch.delenv("THIMBLE_ROOT", raising=False)
    return d


def by_outcome(st: Store) -> dict:
    return Q.run(st, "runs by outcome", 'df = load("runs.jsonl")\ntally(df, "outcome", median=("calls", "median"))')


def test_a_group_key_with_spaces_and_brackets_round_trips_through_a_citation(root: Path) -> None:
    st = Store(root)
    q = by_outcome(st)
    refs = Q.row_refs(q)
    won = next(i for i, r in enumerate(q["table"]) if r["outcome"] == "won (clean ep)")
    assert refs[won] == f"{q['id']}#outcome=won-clean-ep", "the kernel writes the key as its slug, one Markdown link"
    # the slug, the words as Claude may copy them, and the percent-encoded form all open the same three rows
    for ref in (f"{refs[won]}@n", f"{q['id']}#outcome=won (clean ep)@n", f"{q['id']}#outcome=won%20%28clean%20ep%29@n"):
        r = LIN.resolve(st, ref)
        assert r["count"] == 3 and r["rows"] == ["runs.jsonl#L1-3"], ref
        assert r["chain"][0]["value"] == 3
    # a key with a slash keeps it: it is safe in a link
    assert f"{q['id']}#outcome=failed/adversarial" in refs
    # a citation written with the words in it is still one link, and nothing of it leaks into the prose
    text = f"Clean wins took a median of [110]({q['id']}#outcome=won (clean ep)@median) calls."
    assert R.links(text) == [("110", f"{q['id']}#outcome=won (clean ep)@median")]
    # the example citation `thimble run` prints is already the safe form
    assert "(clean" not in (Q.cite_example(q) or "")


def test_rows_bound_into_a_card_carry_their_own_ref(root: Path) -> None:
    st = Store(root)
    q = by_outcome(st)
    obj = O.save(st, "outcomes", {"title": "Outcomes", "data": {"by": q["id"], "won": f"{q['id']}#outcome=won-clean-ep"}})
    rows = obj["data"]["by"]
    assert all(r["_ref"].startswith(f"{q['id']}#") and r["_rows"] for r in rows)
    assert obj["data"]["won"]["_ref"] == f"{q['id']}#outcome=won-clean-ep" and obj["data"]["won"]["n"] == 3
    # a value read through a row's own ref resolves to exactly that row's source rows
    r = LIN.resolve(st, obj["data"]["won"]["_ref"] + "@n")
    assert r["rows"] == ["runs.jsonl#L1-3"]
    # saving the object again from its file keeps the binding: `_ref` is the kernel's, like `_rows`
    again = O.save(st, "outcomes", {"title": "Outcomes", "data": json.loads(json.dumps(obj["data"]))})
    assert again["source"]["data"]["by"] == q["id"]


def test_a_citation_of_a_whole_query_opens_the_row_behind_the_value_it_shows(root: Path) -> None:
    st = Store(root)
    q = by_outcome(st)
    # Claude cited the query, not the row: the words show 4, which only failed/adversarial holds
    r = LIN.resolve(st, q["id"], label="4 runs")
    assert r["narrowed"] == f"{q['id']}#outcome=failed/adversarial@n" and r["wrote"] == q["id"]
    assert r["count"] == 4 and r["rows"] == ["runs.jsonl#L6-9"]
    assert "only row" in r["notes"][0]
    # a column cite too: [125](r1@median) is the contested row's median
    r = LIN.resolve(st, f"{q['id']}@median", label="190")
    assert r["narrowed"].endswith("#outcome=contested@median") and r["count"] == 1
    # words that two rows hold are not narrowed: the cite keeps every row it named, and says nothing it cannot know
    per_run = Q.run(st, "calls per run", 'tally(load("runs.jsonl"), "run")')
    r = LIN.resolve(st, per_run["id"], label="1 call")
    assert "narrowed" not in r and r["count"] == 10
    assert "narrowed" not in LIN.resolve(st, q["id"], label="999")
    # an object's text: the citation is kept as written and opens the narrowed row
    obj = O.save(st, None, {"title": "x", "text": f"[4 runs]({q['id']}) failed."})
    c = obj["lineage"]["cites"][0]
    assert c["wrote"] == q["id"] and c["ref"].endswith("failed/adversarial@n") and c["rows"] == ["runs.jsonl#L6-9"]
    assert not obj["lineage"]["problems"]


def test_examples_are_spread_across_a_group_not_its_first_rows(root: Path) -> None:
    st = Store(root)
    r = LIN.resolve(st, "runs.jsonl#L1-10", n=3)
    assert [x["ref"] for x in r["records"]] == ["runs.jsonl#L1", "runs.jsonl#L6", "runs.jsonl#L10"]
    assert r["records"][0]["words"] == "episode 0 ended won (clean ep)", "a record reads as its words"
    q = by_outcome(st)
    r = LIN.resolve(st, f"{q['id']}#outcome=failed-adversarial@n", n=2)
    assert [x["ref"] for x in r["records"]] == ["runs.jsonl#L6", "runs.jsonl#L9"]
    assert r["about"].startswith("runs by outcome") and "failed/adversarial" in r["about"]
    first = LIN.resolve(st, "runs.jsonl#L1-10", n=3, pick="first")
    assert [x["ref"] for x in first["records"]] == ["runs.jsonl#L1", "runs.jsonl#L2", "runs.jsonl#L3"]
    assert LIN.spread_refs(["a.jsonl#L1-2", "b.jsonl#L5,9"], 4) == ["a.jsonl#L1", "a.jsonl#L2", "b.jsonl#L5", "b.jsonl#L9"]


def test_a_save_is_an_event_of_the_sessions_change_feed(root: Path, tmp_path: Path) -> None:
    st = Store(root)
    q = by_outcome(st)
    O.save(st, "one", {"title": "One", "data": {"by": q["id"]}})
    O.save(st, "one", {"title": "One again", "data": {"by": q["id"]}})
    feed = tmp_path / "th" / "lean" / "events" / "s-run.jsonl"
    events = [json.loads(x) for x in feed.read_text().splitlines()]
    assert [(e["kind"], e["object"], e["version"]) for e in events] == [("save", "01-one", 1), ("save", "01-one", 2)]
    assert events[1]["root"] == str(root) and events[1]["title"] == "One again"


def test_the_command_writes_the_event_even_when_its_output_is_cut(root: Path, tmp_path: Path) -> None:
    st = Store(root)
    q = by_outcome(st)
    env = {"PATH": "/usr/bin:/bin", "THIMBLE_HOME": str(tmp_path / "th"), "THIMBLE_SESSION": "s-pipe", "THIMBLE_ROOT": str(root),
           "THIMBLE_PYTHON": sys.executable}
    lean = str(Path(__file__).resolve().parents[1] / "bin" / "thimble")
    spec = json.dumps({"title": "Cut", "data": {"by": q["id"]}})
    out = subprocess.run(["sh", "-c", f"{lean} save cut | tail -1"], input=spec, text=True, capture_output=True, env=env, cwd=root)
    assert "saved" not in out.stdout, "the pipe cut the line that says saved"
    feed = tmp_path / "th" / "lean" / "events" / "s-pipe.jsonl"
    assert json.loads(feed.read_text().splitlines()[-1])["object"] == "01-cut"


def test_every_card_has_a_title_even_when_claude_gave_none(root: Path) -> None:
    st = Store(root)
    assert O.save(st, "a", {"title": "  Outcomes   by run "})["title"] == "Outcomes by run"
    b = O.save(st, "b", {"question": "Which episodes ended clean?", "program": "return k.text('x')"})
    assert b["title"] == "Which episodes ended clean?" and b["title_from"] == "question"
    c = O.save(st, "c", {"text": "Three episodes ended [clean](runs.jsonl#L1). The rest did not."})
    assert c["title"] == "Three episodes ended clean." and c["title_from"] == "text"
    assert O.save(st, "runs-by-outcome", {"program": "return 1"})["title"] == "Runs by outcome"


def test_an_event_row_reads_as_what_happened_not_its_ids(root: Path) -> None:
    with open(root / "events.jsonl", "w") as f:
        f.write(json.dumps({"event_id": "request:w:0", "event_type": "request", "time": "2026-05-17T05:46:45Z",
                            "ip16": "10.1", "request_action": "browse-bare"}) + "\n")
    rec = LIN.resolve(Store(root), "events.jsonl#L1", n=1)["records"][0]
    assert rec["words"] == "request · browse-bare · ip16 10.1" and "event_id" not in rec["words"]
    assert rec["meta"] == "2026-05-17T05:46:45Z"


def test_a_per_group_table_with_a_computed_word_column_still_keeps_its_rows(root: Path) -> None:
    st = Store(root)
    q = Q.run(st, "per outcome", 'df = load("runs.jsonl")\ng = df.groupby("outcome")\n'
                                 'pd.DataFrame({"n": g.size(), "first_run": g.run.min()}).reset_index()')
    assert q["lineage"] == "matched" and q["keys"] == ["outcome"]
    won = next(i for i, r in enumerate(q["table"]) if r["outcome"] == "won (clean ep)")
    assert q["rows"][won] == ["runs.jsonl#L1-3"]
    # a citation that names both word columns still finds its row
    assert LIN.resolve(st, f"{q['id']}#outcome=won-clean-ep&first_run=ep00@n")["count"] == 3


def test_a_sorted_wide_table_keeps_its_rows_by_its_words_not_its_old_positions(root: Path) -> None:
    st = Store(root)
    q = Q.run(st, "wide", 'df = load("runs.jsonl")\np = df.pivot_table(index="outcome", values="calls", aggfunc="count").reset_index()\n'
                         'p.rename(columns={"calls": "n"}).sort_values("n", ascending=False)')
    assert q["keys"] == ["outcome"] and q["rows"] is not None, (q["keys"], q["lineage"])
    top = q["table"][0]
    assert top["outcome"] == "failed/adversarial" and "index" in top, "the old position stays a column"
    assert LIN.resolve(st, f"{q['id']}#outcome=failed-adversarial@n")["count"] == 4


def test_rows_picked_from_a_frame_keep_their_lineage_by_row(root: Path) -> None:
    st = Store(root)
    # a tally merged with more columns, then sorted and cut to a few columns: each output row is a row of `per`
    q = Q.run(st, "top outcomes", 'df = load("runs.jsonl")\nper = tally(df, "outcome", calls=("calls", "sum"))\n'
                                 'per["share"] = per.n / per.n.sum()\nper.sort_values("n", ascending=False)[["outcome", "n", "share"]].head(2)')
    assert q["lineage"] == "exact", q["lineage"]
    assert [R.count(x) for x in q["rows"]] == [4, 3]
    # source rows picked by a filter and a column choice are their own rows
    f = Q.run(st, "slow runs", 'df = load("runs.jsonl")\ndf[df.calls > 170][["run", "calls"]]')
    assert f["lineage"] == "exact" and f["rows"][0] == ["runs.jsonl#L9"]


def test_a_table_built_from_a_used_query_finds_its_rows_through_that_querys_groups(root: Path) -> None:
    st = Store(root)
    t = Q.run(st, "per run", 'tally(load("runs.jsonl"), ["outcome", "run"])')
    q = Q.run(st, "per outcome", f'per = use("{t["id"]}")\n'
                                 'g = pd.DataFrame({"outcome": sorted(per.outcome.unique())})\n'
                                 'g["runs"] = g.outcome.map(per.groupby("outcome").size())\ng')
    assert q["lineage"] == "matched", q["lineage"]
    won = next(i for i, r in enumerate(q["table"]) if r["outcome"] == "won (clean ep)")
    assert q["rows"][won] == ["runs.jsonl#L1-3"]


def test_a_selection_of_several_rows_opens_as_one_set(root: Path) -> None:
    st = Store(root)
    q = by_outcome(st)
    refs = [f"{q['id']}#outcome=won-clean-ep", f"{q['id']}#outcome=contested"]
    r = LIN.resolve_many(st, refs, n=3)
    assert r["count"] == 4 and r["rows"] == ["runs.jsonl#L1-3,10"]
    assert [x["ref"] for x in r["records"]] == ["runs.jsonl#L1", "runs.jsonl#L3", "runs.jsonl#L10"]
    assert r["about"] == f"2 rows of {q['id']}"
    env = {"PATH": "/usr/bin:/bin", "THIMBLE_HOME": str(root.parent / "th"), "THIMBLE_SESSION": "s-cli", "THIMBLE_ROOT": str(root),
           "THIMBLE_PYTHON": sys.executable}
    lean = str(Path(__file__).resolve().parents[1] / "bin" / "thimble")
    out = subprocess.run([lean, "resolve", *refs, "--json"], capture_output=True, text=True, env=env, cwd=root)
    assert json.loads(out.stdout)["count"] == 4
