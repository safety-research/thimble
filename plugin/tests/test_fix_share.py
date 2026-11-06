"""thimble file issue (engine/kernel/share.py): the share draft goes through the privacy scan, which says what it took
out. Nothing is sent: the command that would open the link is a fake. The world is test_fixes.py's made-up thimble
0.10.2. All data here is made up."""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_fixes import FX, made, press, world  # noqa: E402, F401  (world is the fixture)

from kernel import share as SH  # noqa: E402

DRAFT = {"title": "Bar says read for coverage",
         "wrong": "After Claude read board-7.jsonl, the bar's item still said coverage.",
         "fixed": "The bar's coverage item now says read, as in r read 14% (3/21 files)."}


def fix_on(w) -> dict:
    r = made(w)
    FX.done(r["id"], "Bar says read", "The bar's coverage item says read.")
    FX.apply(r["id"], press(r["id"]))
    return FX.get(r["id"])


@pytest.fixture
def opened(world, monkeypatch, tmp_path):
    """The command that opens the link: a fake that logs what it was given."""
    log = tmp_path / "opened.log"
    fake = tmp_path / "open-fake"
    fake.write_text(f"#!/bin/sh\necho \"$1\" >> '{log}'\n")
    fake.chmod(0o755)
    monkeypatch.setenv("THIMBLE_OPEN", str(fake))
    return log


def test_the_draft_goes_through_the_scan_and_says_what_it_took_out(world, monkeypatch, opened):
    rec = fix_on(world)
    monkeypatch.setattr(FX, "session_terms", lambda st: {"file": ["board-7.jsonl"], "name": ["dana"]})
    r = SH.share(rec["id"], DRAFT)
    assert r["took"] == "took 1 file name out of the text"
    assert "board-7.jsonl" not in r["title"] + r["body"] + r["url"]
    assert "After Claude read ‹data file›, the bar's item still said coverage." in r["body"]
    # GitHub Markdown: a heading for each part, the version line small at the end
    assert r["body"].startswith("### What was wrong\n\nAfter Claude read")
    assert "\n\n### How it was fixed\n\nThe bar's coverage item now says read" in r["body"]
    assert r["body"].rstrip().endswith("thimble 0.10.2 · terminal · fixed by `thimble fix`")
    assert r["marks"] == ["‹data file›"]
    # Claude's draft is kept for the next share of the same fix (the shell has no model call), before the scan
    assert json.loads((SH.share_dir(rec["id"]) / "given.json").read_text())["wrong"] == DRAFT["wrong"]
    again = SH.share(rec["id"])
    assert again["text"] == "earlier" and again["body"] == r["body"]
