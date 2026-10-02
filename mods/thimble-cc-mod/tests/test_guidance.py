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


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
