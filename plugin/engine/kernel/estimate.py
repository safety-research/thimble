"""The number a --prompt label prints before its model calls run: how many calls it makes, which are its real batches
("292 model calls"). Time and cost are left out: they depend on the records' length, the model's answers and the API's
load, so any figure for them is rough. Pure: no files, no model.

The browser keeps the same code in browser/server/thimble_browser/labels/estimate.py, and a test there holds the two
equal. Change both together.
"""
from __future__ import annotations


def calls_line(calls: int) -> str:
    """"292 model calls"."""
    return f"{calls:,} model {'call' if calls == 1 else 'calls'}"
