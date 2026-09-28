"""A code label over a whole corpus of many files. The labels kernel runs the code kind's wrapper as an IPython cell,
which IPython tokenizes first; the matched files go in as one JSON string, not a list literal, since Python 3.12's
tokenizer keeps a copy of the line for each token and a one-line list of thousands of paths takes gigabytes. The server
reads the rows the wrapper wrote a batch at a time."""
from __future__ import annotations

import io
import json
import os
import tokenize
import tracemalloc

import pytest

from app import concepts, labels_store

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
