"""The writer's report check: `python3 tests/test_report.py`."""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = os.path.dirname(os.path.abspath(__file__))
HELPER = os.path.join(os.path.dirname(HERE), "helper")
sys.path.insert(0, HELPER)
import report  # noqa: E402

CARD = {"id": "abc123", "kind": "bar", "question": "Which wikis?", "x": "wiki", "y": "revisions", "note": "",
        "source": {"script": "s.py"}, "rows": [{"label": "dse", "value": 13403, "group": ""}], "total": 13403}


def _corpus(root: str, md: str) -> str:
    os.makedirs(os.path.join(root, ".thimble-cc-mod", "cards"))
    os.makedirs(os.path.join(root, ".thimble-cc-mod", "reports"))
    with open(os.path.join(root, ".thimble-cc-mod", "cards", "abc123.json"), "w") as f:
        json.dump(CARD, f)
    with open(os.path.join(root, "pages.jsonl"), "w") as f:
        f.write('{"name": "Main"}\n')
    path = os.path.join(root, ".thimble-cc-mod", "reports", "r.md")
    with open(path, "w") as f:
        f.write(md)
    return path


def test_a_good_document_checks_ok() -> None:
    md = ("# Title\n\nOpening line.\n\n## One wiki\n\n![x](card:abc123)\n\n"
          "dse holds [[13403|card:abc123#revisions/dse]] revisions.\n\n## A page\n\nIt is [[pages.jsonl#L1]].\n")
    with tempfile.TemporaryDirectory() as root:
        problems, summary = report.check(_corpus(root, md), "document")
        assert problems == [], problems
        assert summary.startswith("2 citations resolve, 1 cards"), summary


def test_problems_name_their_line_and_what_to_do() -> None:
    md = ("Opening without a title.\n\n## One\n\n![x](card:abc123)\n![y](card:ffffff)\n\n"
          "dse holds [[999|card:abc123#revisions/dse]] revisions.\n")
    with tempfile.TemporaryDirectory() as root:
        problems, _ = report.check(_corpus(root, md), "document")
    text = "\n".join(problems)
    assert 'does not open with a "# " title' in text
    assert "line 8: [[999|card:abc123#revisions/dse]]" in text
    assert "card:ffffff is embedded but" in text


def test_there_is_no_video() -> None:
    # the video type is gone: its contract is refused, and no type of the registry names it
    assert "video" not in report.CONTRACTS
    with tempfile.TemporaryDirectory() as root:
        path = _corpus(root, "# T\n\n## A\n\nIt is [[pages.jsonl#L1]].\n")
        r = subprocess.run([sys.executable, os.path.join(HELPER, "report.py"), "check", path, "--contract", "video"], capture_output=True, text=True)
        assert r.returncode == 2, r.stdout + r.stderr


def test_the_command_line() -> None:
    with tempfile.TemporaryDirectory() as root:
        path = _corpus(root, "# T\n\n## A\n\n- one [[pages.jsonl#L1]]\n")
        r = subprocess.run([sys.executable, os.path.join(HELPER, "report.py"), "check", path, "--form", "slides"], capture_output=True, text=True)
        assert r.returncode == 0 and r.stdout.startswith("ok: 1 citations resolve, 0 cards, 1 slides"), r.stdout + r.stderr
        r = subprocess.run([sys.executable, os.path.join(HELPER, "report.py"), "check", path, "--form", "poster"], capture_output=True, text=True)
        assert r.returncode == 2


def test_a_slide_figure_taller_than_a_narrow_panel_is_a_problem() -> None:
    md = "# T\n\n## Pairs\n\n![x](card:tb0015)\n\n- one [[pages.jsonl#L1]]\n\n## Wikis\n\n![y](card:abc123)\n"
    table = {"id": "tb0015", "kind": "table", "question": "Which pairs?", "x": "", "y": "", "note": "", "source": {"script": "s.py"},
             "columns": ["pair", "pages"], "rows": [[f"a{i} + b{i}", 9] for i in range(15)]}
    with tempfile.TemporaryDirectory() as root:
        path = _corpus(root, md)
        with open(os.path.join(root, ".thimble-cc-mod", "cards", "tb0015.json"), "w") as f:
            json.dump(table, f)
        problems, _ = report.check(path, "slides")
        assert problems == ['slide 1 ("Pairs"): card:tb0015 shows 15 rows, more than fit a narrow panel; show at most 8 on a slide: split them over two slides, or make a card of the top 8'], problems
        # the same card in a document is no problem, and eight rows fit a slide
        assert report.check(path, "document")[0] == []
        table["rows"] = table["rows"][:8]
        with open(os.path.join(root, ".thimble-cc-mod", "cards", "tb0015.json"), "w") as f:
            json.dump(table, f)
        assert report.check(path, "slides")[0] == []


def test_the_contract_is_the_renderer_and_each_type_has_its_guidance() -> None:
    md = "# T\n\n## One wiki\n\nIt is [[pages.jsonl#L1]].\n"
    with tempfile.TemporaryDirectory() as root:
        path = _corpus(root, md)
        run = lambda *a: subprocess.run([sys.executable, os.path.join(HELPER, "report.py"), "check", path, *a], capture_output=True, text=True)
        assert run("--contract", "document").stdout.startswith("ok:")
        # a type drawn as a document is checked as one; an unknown contract is refused
        assert run("--form", "casefile").stdout.startswith("ok:")
        assert run("--contract", "story").returncode == 1
        assert run("--contract", "poster").returncode == 2
    # every type of the registry (hooks/report.ts TYPES) names guidance that exists and a renderer report.py checks
    ts = Path(HERE, "..", "hooks", "report.ts").read_text()
    registry = ts[ts.index("export const TYPES"):ts.index("const BY_ID")]
    types = re.findall(r"\{ id: '(\w+)'.*?renderer: '(\w+)', prompt: '([\w.-]+)'", registry)
    assert {t for t, _, _ in types} >= {"document", "story", "slides"} and "video" not in {t for t, _, _ in types}, types
    for _, renderer, prompt in types:
        assert renderer in report.CONTRACTS, renderer
        assert Path(HERE, "..", "prompt", "reports", prompt).is_file(), prompt


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"ok {name}")
