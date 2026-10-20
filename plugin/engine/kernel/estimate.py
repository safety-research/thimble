"""The ask before a big prompt label's run: when it asks, and the one number it shows. Pure: no files, no model.

The browser keeps the same code in browser/server/thimble_browser/labels/estimate.py, and a test there holds the two
equal. Change both together.

A prompt label over more than SAMPLE records asks the person first: Run all, Run on a sample of SAMPLE, or Cancel.
The ask's sentence says only what is certain, the records and the files ("Read 14,591 records of revisions.jsonl with
Claude"), and the line under its choices gives the one exact number, the model calls the run makes, which are its real
batches ("292 model calls"). Time and cost are left out: they depend on the records' length, the model's answers and
the API's load, so any figure for them is rough.
"""
from __future__ import annotations

SAMPLE = 300  # the records "Run on a sample" reads, chosen at random


def needs_asking(units: int) -> bool:
    """Whether a prompt label's run asks the person first: it reads more records than a sample."""
    return units > SAMPLE


def calls_line(calls: int) -> str:
    """The line under the ask's choices: "292 model calls"."""
    return f"{calls:,} model {'call' if calls == 1 else 'calls'}"
