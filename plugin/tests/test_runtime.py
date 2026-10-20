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
