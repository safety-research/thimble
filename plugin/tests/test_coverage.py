"""Coverage claims no more than happened: a file is seen only when some of its lines or rows entered Claude's context
(Read, cat, head, tail, sed, `thimble rows`, a search that showed them by line, a query that printed them as rows). A
query or a rule label that only went over its rows computed over it, and a label's model that read its records is said
apart; neither is seen. A file only named, listed or counted (wc, ls, find, git ls-files, grep -c) is not seen, nor is
one a shell search went over. The coverage text, the bar's share (total.seen_share), the object's snapshot and trace
use the one rule. Run: python -m pytest plugin/tests"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

ENGINE = Path(__file__).resolve().parents[1] / "engine"
sys.path.insert(0, str(ENGINE))

from kernel import lineage as LIN  # noqa: E402
from kernel.store import Store  # noqa: E402

NAMES = "abcdefghijkl"


@pytest.fixture()
def code(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """A made-up project: twelve source files of 30 lines each under src/, and a table."""
    d = tmp_path / "proj"
    (d / "src").mkdir(parents=True)
    for c in NAMES:
        (d / "src" / f"{c}.py").write_text("".join(f"def f{i}(): return {i}\n" for i in range(30)))
    (d / "runs.csv").write_text("run,passed\na,1\nb,0\nc,1\n")
    monkeypatch.setenv("THIMBLE_HOME", str(tmp_path / "th"))
    monkeypatch.setenv("THIMBLE_SESSION", "s-cov")
    monkeypatch.delenv("THIMBLE_ROOT", raising=False)
    return d


def saw(tmp_path: Path, root: Path, rows: list[dict]) -> None:
    seen = tmp_path / "th" / "lean" / "seen"
    seen.mkdir(parents=True, exist_ok=True)
    (seen / "s-cov.jsonl").write_text("\n".join(json.dumps({"cwd": str(root), **r}) for r in rows) + "\n")


def bash(command: str, out_lines: int) -> dict:
    return {"tool": "Bash", "command": command, "out_lines": out_lines}


def test_counting_every_file_and_reading_a_few_says_only_the_few_were_read(code: Path, tmp_path: Path) -> None:
    # a session that line-counts the whole project, lists it, and reads five files by hand
    saw(tmp_path, code, [
        bash("git ls-files | xargs wc -l", 14),
        bash("wc -l src/*.py runs.csv", 14),
        bash("ls src/", 12),
        bash("find . -name '*.py' | head -50", 12),
        {"tool": "Read", "file": str(code / "src" / "a.py"), "from": 1, "to": 30},
        bash("cat src/b.py", 30),
        bash("head -n 5 src/c.py", 5),
        bash("sed -n '10,12p' src/d.py", 3),
        bash("grep -n 'def f1' src/e.py", 11),
        bash("grep -c def src/f.py", 1),
        bash("cat src/g.py | wc -l", 1),
        bash("cat src/h.py > /tmp/copy.py", 0),
        bash("python3 -c \"print(len(open('src/i.py').read()))\"", 1),
        bash("cat src/j.py", 4),  # a long output, cut: four lines reached Claude
    ])
    st = Store(code)
    cov = LIN.coverage(st)
    status = {o["path"]: o["status"] for o in cov["files"]}
    assert {f for f, s in status.items() if s == "seen"} == {"src/a.py", "src/b.py", "src/c.py", "src/d.py", "src/j.py"}
    assert status["src/e.py"] == "searched"
    assert {f for f, s in status.items() if s == "named"} == {"src/f.py", "src/g.py", "src/h.py", "src/i.py", "src/k.py",
                                                              "src/l.py", "runs.csv"}
    lines = {o["path"]: o["seen_lines"] for o in cov["files"] if o["seen"]}
    assert lines == {"src/a.py": 30, "src/b.py": 30, "src/c.py": 5, "src/d.py": 3, "src/j.py": 4}
    t = cov["total"]
    assert (t["seen_files"], t["not_seen_files"], t["untouched_files"], t["touched_files"]) == (5, 8, 0, 13)
    assert t["seen_share"] == pytest.approx(72 / 363) and t["read_share"] == t["seen_share"]
    text = LIN.coverage_text(cov)
    assert "Every source file" not in text and "touched." not in text
    assert ("Seen: 72 of 363 rows (20%) entered Claude's context, from 5 of 13 source files; 13 were touched in some way. "
            "Not seen: 8 files (213 rows): 7 only named, listed or counted (runs.csv, src/f.py, src/g.py, src/h.py and 3 "
            "more); 1 searched, which lines a search showed is not known (src/e.py).") in text
    assert "runs.csv  only named, listed or counted (wc); none of its lines seen" in text
    assert "src/g.py  only named, listed or counted (find, ls, wc)" in text
    assert "src/h.py  only named, listed or counted (cat > a file, find, ls, wc)" in text
    assert "src/e.py  searched: a search went over it; which lines it showed is not known (grep)" in text


def test_reading_every_file_says_so_and_how_much(code: Path, tmp_path: Path) -> None:
    saw(tmp_path, code, [bash("head -3 src/*.py runs.csv", 60)])
    cov = LIN.coverage(Store(code))
    assert all(o["status"] == "seen" for o in cov["files"])
    assert LIN.coverage_sentence(cov) == "Seen all 13 source files, at least in part: 38 of 363 rows (11%) entered Claude's context."
