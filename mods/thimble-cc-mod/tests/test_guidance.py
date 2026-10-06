"""Tests of the prompt against the code it describes: `python3 tests/test_guidance.py` (no dependencies)."""
from __future__ import annotations

import os
import re

MOD = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def read(path: str) -> str:
    with open(os.path.join(MOD, path), encoding="utf-8") as f:
        return f.read()


def test_diagram_guidance() -> None:
    prompt = read("prompt/chat.md")
    inline = int(re.search(r"const EDGE_INLINE = (\d+)", read("hooks/draw.ts")).group(1))
    entry = prompt[prompt.index("       diagram "):prompt.index("2. The helper prints")]
    assert f"a label over {inline}\n" in entry or f"a label over {inline} " in entry, "edge-note threshold differs from draw.ts"
    assert "numbered note" in entry
    assert "6-8 edges" in entry and "two cards" in entry


def section(text: str, head: str) -> str:
    start = text.index(f"\n## {head}\n")
    end = text.find("\n## ", start + 1)
    return text[start:end if end >= 0 else len(text)]


def test_view_proposal_and_reply_guidance() -> None:
    views = section(read("prompt/chat.md"), "Views")
    assert "at the size they asked for" in views
    assert "Claim every file that holds the records" not in views and "and no other files" in views
    assert "Ask for no long text" in views
    assert "reply in one sentence that names the view, and nothing more" in views and "what a click" in views
    good = re.search(r"^ +Good +(.+)$", views, re.M).group(1)
    bad = re.search(r"^ +Bad +(.+)$", views, re.M).group(1)
    # the good reply is one sentence with no number and no layout; the bad one has both
    assert good.count(". ") == 0 and not re.search(r"\d", good), good
    assert re.search(r"\d", bad) and "time axis" in bad and "click" in bad


def test_view_size_guidance_matches_the_checks_and_the_drawing() -> None:
    import sys
    sys.path.insert(0, os.path.join(MOD, "helper"))
    import viewpipe
    mb = f"{viewpipe.ROWS_MAX / 1e6:g} MB"
    parts = f"{viewpipe.PART_BYTES / 1e6:g} MB"
    # the detail's text wraps at the measure (72 cells, or the panel's width when narrower), to its lines at most
    lines = int(re.search(r"wrap\(t, Math\.min\(72, cols - 2\), (\d+)\)", read("hooks/viewdraw.ts")).group(1))
    for path in ("prompt/view-build.md", "prompt/view-review.md", "prompt/view-revise.md", "views/SPEC.md"):
        text = " ".join(read(path).split())
        assert mb in text, f"{path} does not give the rows' limit, {mb}"
        assert f"{lines} lines" in text, f"{path} does not say the details draw {lines} lines of a text"
    assert parts in read("prompt/view-build.md")
    assert mb in " ".join(read("README.md").split())


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
