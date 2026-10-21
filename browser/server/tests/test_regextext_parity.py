"""A regex label reads the same text in both products: the browser's regextext.py is a byte-identical copy of the
plugin's kernel regextext.py, and the browser's regex run reads a JSON lines record's decoded values."""
from __future__ import annotations

import re
from pathlib import Path

from thimble_browser.labels import regextext
from thimble_browser.labels.run import _regex_rows
from thimble_browser.labels.units import Unit

KERNEL = Path(__file__).resolve().parents[3] / "plugin" / "engine" / "kernel" / "regextext.py"


def test_the_two_copies_are_byte_identical():
    assert Path(regextext.__file__).read_bytes() == KERNEL.read_bytes()


def test_a_link_after_a_newline_in_a_json_value_matches_and_a_text_line_reads_as_before():
    concept = {"labels": ["yes", "no"]}
    rx = re.compile(r"\bhttps?://")
    line = '{"id": 1, "text": "See the source:\\nhttps://example.org/a"}'
    jsonl = Unit("edits.jsonl#L1", line, {"id": 1, "text": "See the source:\nhttps://example.org/a"}, path="edits.jsonl")
    text = Unit("notes.txt#L1", "literal \\nhttps://example.org/c", {"text": "literal \\nhttps://example.org/c"}, path="notes.txt")
    rows = _regex_rows(concept, rx, [jsonl, text])
    assert [r["label"] for r in rows] == ["yes", "no"]
    # keys and quotes are not the text
    assert _regex_rows(concept, re.compile(r'"text": "See'), [jsonl])[0]["label"] == "no"
