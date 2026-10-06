"""The writer's report check and the film renderer: `python3 tests/test_report.py` (rendering needs a Python with
Playwright, named by THIMBLE_CC_MOD_PYTHON, and ffmpeg; without them that test is skipped)."""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = os.path.dirname(os.path.abspath(__file__))
HELPER = os.path.join(os.path.dirname(HERE), "helper")
sys.path.insert(0, HELPER)
import film  # noqa: E402
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


def test_a_good_video_checks_ok() -> None:
    md = ("# Title\n\nOpening line.\n\n## One wiki\n\n![x](card:abc123)\n\n"
          "dse holds [[13403|card:abc123#revisions/dse]] revisions. (pause 0.5)\n\n## A page\n\nIt is [[pages.jsonl#L1]].\n")
    with tempfile.TemporaryDirectory() as root:
        problems, summary = report.check(_corpus(root, md), "video")
        assert problems == [], problems
        assert summary.startswith("2 citations resolve, 1 cards, 2 scenes, about 0:"), summary


def test_problems_name_their_line_and_what_to_do() -> None:
    md = ("Opening without a title.\n\n## One\n\n![x](card:abc123)\n![y](card:ffffff)\n\n"
          "dse holds [[999|card:abc123#revisions/dse]] revisions. Two. Three.\n\n## Two\n\n![z](card:abc123)\n")
    with tempfile.TemporaryDirectory() as root:
        problems, _ = report.check(_corpus(root, md), "video")
    text = "\n".join(problems)
    assert 'does not open with a "# " title' in text
    assert "line 8: [[999|card:abc123#revisions/dse]]" in text
    assert "card:ffffff is embedded but" in text
    assert "shows 2 cards: one card per scene" in text
    assert "a line of 3 sentences" in text
    assert 'scene 2 ("Two") has no line of narration' in text


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
    assert {t for t, _, _ in types} >= {"document", "video", "story", "slides"}, types
    for _, renderer, prompt in types:
        assert renderer in report.CONTRACTS, renderer
        assert Path(HERE, "..", "prompt", "reports", prompt).is_file(), prompt


def test_cells_and_the_concat_list() -> None:
    html = film.rows_html("\x1b[0;1;38;2;230;237;243mab\x1b[0m\n\x1b[0;38;2;47;125;225m█", 3)
    assert html.count('<div class="l">') == 3
    assert "font-weight:bold" in html and "color:#e6edf3" in html
    assert "linear-gradient(to top,#2f7de1 100.0%" in html
    assert film.concat_list([("a.png", 80), ("b.png", 1200)]) == (
        "ffconcat version 1.0\nfile 'a.png'\nduration 0.080\nfile 'b.png'\nduration 1.200\nfile 'b.png'\n")


def test_narration_mixes_each_spoken_line_in_at_its_start() -> None:
    if not shutil.which("ffmpeg"):
        print("skipped: no ffmpeg")
        return
    # a stand-in voice: a tone per line, written as the voice would write it
    def fake_speak(tool: str, text: str, out: Path) -> bool:
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.5", str(out)], check=True)
        return True

    real = film.speak
    film.speak = fake_speak
    try:
        with tempfile.TemporaryDirectory() as d:
            inputs, graph = film.narration([{"start": 0.5, "text": "one"}, {"start": 2, "text": "two"}, {"start": 3, "text": ""}], "espeak-ng", Path(d))
            assert inputs == ["-i", f"{d}/line000.wav", "-i", f"{d}/line001.wav"]
            assert graph == "[1:a]adelay=500|500,aformat=channel_layouts=mono[a1];[2:a]adelay=2000|2000,aformat=channel_layouts=mono[a2];[a1][a2]amix=inputs=2:normalize=0:dropout_transition=0[aout]"
    finally:
        film.speak = real


def test_a_film_renders_to_an_mp4() -> None:
    py = os.environ.get("THIMBLE_CC_MOD_PYTHON", "")
    if not py or not shutil.which("ffmpeg"):
        print("skipped: set THIMBLE_CC_MOD_PYTHON to a Python with Playwright")
        return
    frames = [{"ansi": f"\x1b[0;1m frame {i}\x1b[0m", "ms": 400, "caption": f"line {i}"} for i in range(3)]
    with tempfile.TemporaryDirectory() as d:
        src = Path(d) / "f.json"
        src.write_text(json.dumps({"cols": 136, "rows": 32, "frames": frames, "lines": []}))
        r = subprocess.run([py, os.path.join(HELPER, "film.py"), str(src), str(Path(d) / "out.mp4")], capture_output=True, text=True)
        assert r.returncode == 0, r.stderr
        got = json.loads(r.stdout)
        assert got["frames"] == 3 and got["seconds"] == 1.2
        probe = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=codec_name,width,height", "-of", "csv=p=0", str(Path(d) / "out.mp4")], capture_output=True, text=True)
        assert probe.stdout.strip().startswith("h264,1280,720"), probe.stdout


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"ok {name}")
