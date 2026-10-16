"""The labels' unsure records (concepts.unsure, `thimble state label-unsure`): under each label the records no category
fit (no value, a value off its list, a quiet value), then those its classifier was unsure of (confidence under 0.6),
least sure first, paged; a record the analyst judged is in neither. A yes/no label's quiet value is an answer."""
from __future__ import annotations

import json

import pytest

from app import concepts, config, labels_store, local

CORPUS = "mini"
TS = "2026-01-01T00:00:00+00:00"


def _row(line: int, label, confidence: float, source: str = "model") -> dict:
    return {"ref": f"board.jsonl#L{line}", "label": label, "confidence": confidence, "source": source, "ts": TS}


@pytest.fixture()
def labels(workspaces_tmp, mini_dir):
    """A label over the board's posts with three values, one of them quiet, and a yes/no label."""
    ws = config.workspace_dir(CORPUS)
    kinds = concepts.new_concept("Post kind", "kind", "prompt", "x", "record",
                                 ["coordination", "status report", "other"], "analyst")
    concepts.write_concept(ws, kinds)
    rows = [_row(1, "coordination", 0.95), _row(2, "status report", 0.55), _row(3, "other", 0.9),
            _row(4, "coordination", 0.3), _row(5, "spam", 0.8), _row(6, "status report", 0.59),
            _row(7, "coordination", 0.6), _row(8, "coordination", 0.1),
            {"ref": "board.jsonl#L8", "label": "status report", "source": "analyst", "ts": TS},  # the analyst decided
            _row(9, "Other", 0.99)]
    concepts.labels_file(ws, kinds["id"]).parent.mkdir(parents=True, exist_ok=True)
    concepts.labels_file(ws, kinds["id"]).write_text("".join(json.dumps(r) + "\n" for r in rows))
    yes = concepts.new_concept("Asks", "asks", "prompt", "x", "record", ["yes", "no"], "analyst")
    yes["ts"] = "2999-01-01T00:00:00+00:00"  # listed after the first
    concepts.write_concept(ws, yes)
    concepts.labels_file(ws, yes["id"]).write_text("".join(json.dumps(r) + "\n" for r in [
        _row(1, "no", 0.9), _row(2, "yes", 0.4), labels_store.cover_row("events.jsonl", 1, 5, "no", "model", TS)]))
    return {"kinds": kinds, "yes": yes}


async def test_no_fit_first_then_unsure_by_confidence(labels):
    got = await local.state(CORPUS, "label-unsure", ["--label", labels["kinds"]["id"], "--n", "20"])
    (one,) = got["labels"]
    assert (one["name"], one["noFit"], one["unsure"], one["total"]) == ("Post kind", 3, 3, 6)
    assert [(r["ref"], r["kind"]) for r in one["rows"]] == [
        ("board.jsonl#L3", "no-fit"), ("board.jsonl#L5", "no-fit"), ("board.jsonl#L9", "no-fit"),
        ("board.jsonl#L4", "unsure"), ("board.jsonl#L2", "unsure"), ("board.jsonl#L6", "unsure")]
    first = one["rows"][0]
    assert set(first) == {"ref", "value", "confidence", "kind", "text"}
    assert first["value"] == "other" and first["confidence"] == 0.9
    assert first["text"] and len(first["text"]) <= concepts.UNSURE_TEXT + 1


async def test_threshold_is_0_6(labels):
    rows = concepts.unsure(CORPUS, labels["kinds"]["id"])["rows"]
    conf = {r["ref"]: r["confidence"] for r in rows if r["kind"] == "unsure"}
    assert "board.jsonl#L7" not in conf and conf["board.jsonl#L6"] == 0.59
    assert concepts.UNSURE_BELOW == 0.6


async def test_paging_by_offset(labels):
    cid = labels["kinds"]["id"]
    page1 = concepts.unsure(CORPUS, cid, n=2, offset=0)
    page2 = concepts.unsure(CORPUS, cid, n=2, offset=2)
    page3 = concepts.unsure(CORPUS, cid, n=2, offset=4)
    assert page1["total"] == page2["total"] == 6
    refs = [r["ref"] for p in (page1, page2, page3) for r in p["rows"]]
    assert refs == ["board.jsonl#L3", "board.jsonl#L5", "board.jsonl#L9", "board.jsonl#L4", "board.jsonl#L2",
                    "board.jsonl#L6"]
    assert concepts.unsure(CORPUS, cid, n=2, offset=6)["rows"] == []


async def test_counts_for_every_label_and_the_yes_no_label(labels):
    got = await local.state(CORPUS, "label-unsure", ["--counts"])
    assert [(x["name"], x["noFit"], x["unsure"]) for x in got["labels"]] == [("Post kind", 3, 3), ("Asks", 0, 1)]
    assert all("rows" not in x for x in got["labels"])
    assert concepts.unsure_counts(CORPUS, labels["yes"]["id"]) == {"noFit": 0, "unsure": 1, "total": 1}


def test_covers_of_a_no_fit_value_count_and_list_after_the_rows(labels):
    ws = config.workspace_dir(CORPUS)
    kinds = labels["kinds"]
    with concepts.labels_file(ws, kinds["id"]).open("a") as f:
        f.write(json.dumps(labels_store.cover_row("events.jsonl", 1, 4, "other", "model", TS)) + "\n")
    got = concepts.unsure(CORPUS, kinds["id"], n=10)
    assert got["total"] == 3 + 4 + 3
    assert [r["ref"] for r in got["rows"]][3:7] == [f"events.jsonl#L{i}" for i in range(1, 5)]
    assert got["rows"][7]["kind"] == "unsure"
    assert concepts.unsure(CORPUS, kinds["id"], n=2, offset=4)["rows"][0]["ref"] == "events.jsonl#L2"


async def test_a_label_without_rows_and_an_unknown_label(labels):
    ws = config.workspace_dir(CORPUS)
    empty = concepts.new_concept("Empty", "e", "prompt", "x", "record", ["a", "b"], "analyst")
    concepts.write_concept(ws, empty)
    assert concepts.unsure(CORPUS, empty["id"]) == {"total": 0, "rows": []}
    with pytest.raises(local.StateError):
        await local.state(CORPUS, "label-unsure", ["--label", "nope"])
    with pytest.raises(local.StateError):
        await local.state(CORPUS, "label-unsure", ["--n", "x"])
