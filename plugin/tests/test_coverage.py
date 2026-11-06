"""Coverage claims no more than happened: a file is seen only when some of its lines or rows entered Claude's context
(Read, cat, head, tail, sed, a search that showed them by line). A search that went over it, and a program that
computed over it (code that names it, wc, grep -c), are said apart; none is seen. The bar counts the files touched
(total.touched_files): seen, searched or computed over; a file only listed by name (ls, find) is not touched. Run:
python3 -m pytest plugin/tests"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

ENGINE = Path(__file__).resolve().parents[1] / "engine"
sys.path.insert(0, str(ENGINE))

from kernel import coverage as CV  # noqa: E402
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
    seen = tmp_path / "th" / "seen"
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
    cov = CV.coverage(st)
    status = {o["path"]: o["status"] for o in cov["files"]}
    assert {f for f, s in status.items() if s == "seen"} == {"src/a.py", "src/b.py", "src/c.py", "src/d.py", "src/j.py"}
    assert status["src/e.py"] == "searched"
    # a count, a pipe into a count, an output into a file and code that opens a file each went over all of it
    assert {f for f, s in status.items() if s == "computed"} == {"src/f.py", "src/g.py", "src/h.py", "src/i.py",
                                                                 "src/k.py", "src/l.py", "runs.csv"}
    i = next(o for o in cov["files"] if o["path"] == "src/i.py")
    assert (i["computed"], i["computed_by"], i["counted_share"]) == (i["rows"], ["python3", "wc"], 1.0)
    lines = {o["path"]: o["seen_lines"] for o in cov["files"] if o["seen"]}
    assert lines == {"src/a.py": 30, "src/b.py": 30, "src/c.py": 5, "src/d.py": 3, "src/j.py": 4}
    t = cov["total"]
    assert (t["seen_files"], t["not_seen_files"], t["untouched_files"], t["touched_files"]) == (5, 8, 0, 13)
    # a searched file was gone over whole, though which of its lines Claude saw is not known
    e = next(o for o in cov["files"] if o["path"] == "src/e.py")
    assert (e["read_share"], e["counted_share"]) == (0.0, 1.0)
    # the bar's share is of files touched, each file once whatever its unit: a count over a file touches it
    assert t["touched_share"] == 1.0
    text = CV.coverage_text(cov)
    assert "Every source file" not in text
    assert ("Touched 13 of 13 files (read, searched or computed over). Read 5 of the files, at least in part: "
            "0 of 3 rows (0%) and 72 of 360 lines (20%) entered Claude's context. Computed over by a program or a rule "
            "label, none of it read: 3 of 3 rows (100%) and 258 of 360 lines (72%). Not read: 8 files (3 rows and 210 "
            "lines): 7 only computed over (runs.csv, src/f.py, src/g.py, src/h.py and 3 more); 1 searched, which lines a "
            "search showed is not known (src/e.py).") in text
    assert "  src/c.py  read 5 of 30 lines (17%); computed over all 30 lines (wc)\n" in text
    assert "runs.csv  computed over all 3 rows (wc); Claude read none of it" in text
    assert "src/g.py  computed over all 30 lines (wc)" in text
    assert "src/h.py  computed over all 30 lines (cat > a file, wc)" in text
    assert "src/e.py  searched by grep; which lines it showed is not known" in text
