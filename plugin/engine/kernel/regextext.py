"""The text a regex label matches in a JSON or JSONL record: its values, decoded, one per line. Pure: no files.

The browser keeps the same file in browser/server/thimble_browser/labels/regextext.py, and a test there holds the two
byte-identical. Change both together.

A file holds a newline inside a JSON value as the two characters backslash and n, and a quote as backslash and quote.
A regex over that raw line misses what a person reads: `\\bhttps?://` finds no word boundary after `\\n`, since n is a
word character. So a regex reads the record's values, as a person reads them: each string as it is (real newlines),
each number or true/false as its text, in the record's order, one value per line. Keys and JSON's quotes are not in it.
"""
from __future__ import annotations

from typing import Any


def json_text(v: Any) -> str:
    """A JSON value's values, decoded, one per line: {"a": "x\\ny", "n": 2} -> "x\\ny\\n2"."""
    out: list[str] = []

    def walk(x: Any) -> None:
        if isinstance(x, str):
            out.append(x)
        elif isinstance(x, dict):
            for y in x.values():
                walk(y)
        elif isinstance(x, list):
            for y in x:
                walk(y)
        elif x is not None:
            out.append(str(x))

    walk(v)
    return "\n".join(out)
