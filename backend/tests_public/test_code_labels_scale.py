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


def test_the_file_list_is_one_token_of_the_wrapper_code():
    concept = {"name": "result record", "unit": "record", "spec": SPEC}
    code = concepts.build_code_wrapper(concept, _groups(3000), None, "/tmp/rows.tmp")
    per_line: dict[int, int] = {}
    for tok in tokenize.generate_tokens(io.StringIO(code).readline):
        per_line[tok.start[0]] = per_line.get(tok.start[0], 0) + 1
    assert max(per_line.values()) < 100, "no line of the code holds the 3,000 files as tokens of their own"


def test_ipython_reads_the_wrapper_of_a_label_over_many_files_in_little_memory():
    InteractiveShell = pytest.importorskip("IPython.core.interactiveshell").InteractiveShell
    concept = {"name": "result record", "unit": "record", "spec": SPEC}
    code = concepts.build_code_wrapper(concept, _groups(400), None, "/tmp/rows.tmp")
    shell = InteractiveShell.instance()
    tracemalloc.start()
    try:
        shell.transform_cell(code)
        peak = tracemalloc.get_traced_memory()[1]
    finally:
        tracemalloc.stop()
    assert peak < 16 * 2**20, f"transforming the cell took {peak / 2**20:.0f} MB"


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


def test_the_server_reads_the_wrapper_s_rows_a_batch_at_a_time(tmp_path, monkeypatch):
    rows_file = tmp_path / "rows.tmp"
    lines = [json.dumps({"ref": f"runs/log.jsonl#L{i + 1}", "label": "yes" if i % 10 == 0 else "no"}) for i in range(12_000)]
    lines[5] = json.dumps({"ref": "runs/log.jsonl#L6", "error": "KeyError: 'kind'"})
    rows_file.write_text("\n".join(lines) + "\n")
    out = tmp_path / "labels" / "k1.jsonl"
    out.parent.mkdir()
    monkeypatch.setattr(labels_store, "BATCH", 1000)
    seen: list[int] = []
    parse = concepts._parse_code_rows

    def counted(batch: list[str]):
        seen.append(len(batch))
        return parse(batch)

    monkeypatch.setattr(concepts, "_parse_code_rows", counted)
    labeled, errors, message, matches = concepts._collect_code_rows([], rows_file, out, "yes")
    assert (labeled, errors, message, matches) == (11_999, 1, "KeyError: 'kind'", 1200)
    assert max(seen) == 1000 and sum(seen) == 12_000
    assert sum(1 for _ in out.open()) == 11_999
    store = labels_store.Store(out)
    assert store.fresh() and len(store.refs()) == 11_999


def test_a_kernel_error_is_the_run_s_message(tmp_path):
    out = tmp_path / "labels" / "k1.jsonl"
    out.parent.mkdir()
    bundle = {"application/vnd.thimble.error+json": {"ename": "SyntaxError", "evalue": "invalid syntax"}}
    assert concepts._collect_code_rows([bundle], None, out) == (0, 0, "SyntaxError: invalid syntax", 0)
    assert not out.exists()
