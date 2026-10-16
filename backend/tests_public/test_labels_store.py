"""Label values as thimble stores and reads them. app.labels_store keeps no index another one covers, reads a store
made before as it is, and counts each value of a file's records with the covers' records; the unsure records
(concepts.unsure, `thimble state label-unsure`) list the records no category fit, then those the classifier was unsure
of; and a code label labels every record of a corpus of many files (the kernel's wrapper gets the matched files as one
JSON string, since a one-line list of thousands of paths takes gigabytes to tokenize)."""
from __future__ import annotations

import json
import os
import sqlite3
from pathlib import Path

import pytest

from app import concepts, config, labels_store, local


def _labels(path: Path, n: int = 3000) -> Path:
    rows = [{"ref": f"turns.jsonl#L{i}", "label": "shell" if i % 3 else "gui", "source": "code", "confidence": 1.0,
             "ts": "2026-01-01T00:00:00+00:00"} for i in range(1, n + 1)]
    rows += [{"ref": "chat.jsonl#L4", "label": "gui", "source": "code"},
             {"ref": "turns.jsonl#L9", "label": "shell", "source": "analyst", "ts": "t"},
             labels_store.cover_row("other.jsonl", 1, 40, "quiet", "regex", "t")]
    path.write_text("".join(json.dumps(r) + "\n" for r in rows))
    return path


def _indexes(db: Path) -> set[str]:
    conn = sqlite3.connect(str(db))
    try:
        return {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL")}
    finally:
        conn.close()


def test_a_store_made_before_is_read_as_it_is_and_drops_the_covered_index_at_its_next_write(tmp_path):
    """A store made with the index on path alone stays fresh, so an update reads it with no rebuild, and its next write
    drops that index."""
    jsonl = _labels(tmp_path / "k.jsonl", n=50)
    st = labels_store.Store(jsonl)
    st.rebuild()
    conn = sqlite3.connect(str(st.db))
    conn.execute("CREATE INDEX current_path ON current(path)")
    conn.commit()
    conn.close()
    assert st.state()[0] == "fresh", "no rebuild"
    st.connect(write=True).close()
    assert "current_path" not in _indexes(st.db) and st.state()[0] == "fresh"


def test_a_files_records_per_bin_count_each_value_with_the_covers_records_that_have_no_row(tmp_path):
    """line_counts: per bin of the file's lines, how many records have each value (the reader's overview draws each part
    of the file in the value most of its records have); a cover's records count but those with a row of their own,
    which count for their own value; line_bins is the bins that hold a value."""
    rows = [{"ref": f"turns.jsonl#L{i}", "label": "gui" if i % 4 == 0 else "shell", "source": "code"} for i in range(1, 21)]
    rows += [labels_store.cover_row("other.jsonl", 1, 40, "quiet", "regex", "t"),
             {"ref": "other.jsonl#L7", "label": "loud", "source": "code"}]
    jsonl = tmp_path / "k.jsonl"
    jsonl.write_text("".join(json.dumps(r) + "\n" for r in rows))
    st = labels_store.Store(jsonl)
    st.rebuild()
    assert st.line_counts("turns.jsonl", 20, 2) == {"shell": {0: 8, 1: 7}, "gui": {0: 2, 1: 3}}
    assert st.line_counts("other.jsonl", 40, 4) == {"quiet": {0: 9, 1: 10, 2: 10, 3: 10}, "loud": {0: 1}}
    assert st.line_bins("other.jsonl", 40, 4) == {"quiet": [0, 1, 2, 3], "loud": [0]}


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


SPEC = "def label(unit):\n    return 'yes' if unit.get('kind') == 'result' else 'no'\n"


def _groups(n: int) -> list[dict]:
    """File groups of invented run folders, as a glob over a corpus of `n` JSON Lines files matches them."""
    paths = [f"runs/run-{i:04d}/session-data/a{i:07x}-9c1e/subagents/agent-{i:016x}.jsonl" for i in range(n)]
    return [{"ref": p, "paths": [p]} for p in paths]


def test_the_wrapper_labels_every_record_of_every_file(tmp_path):
    root = tmp_path / "corpus"
    groups = _groups(40)
    for i, g in enumerate(groups):
        f = root / g["paths"][0]
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text("".join(json.dumps({"kind": "result" if j == i % 3 else "step", "n": j}) + "\n" for j in range(3)))
    rows_file = tmp_path / "rows.tmp"
    code = concepts.build_code_wrapper({"name": "r", "unit": "record", "spec": SPEC}, groups, None, rows_file)
    cwd = os.getcwd()
    os.chdir(root)
    try:
        exec(compile(code, "wrapper", "exec"), {"__name__": "wrapper"})
    finally:
        os.chdir(cwd)
    rows, errors, message = concepts.parse_code_output([], rows_file)
    assert len(rows) == 120 and errors == 0 and message is None
    assert sum(r["label"] == "yes" for r in rows) == 40
    assert rows[4]["ref"] == f"{groups[1]['paths'][0]}#L2" and rows[4]["label"] == "yes"
