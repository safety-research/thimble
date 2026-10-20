"""Coverage claims no more than happened: a file is read only when its lines or rows were in front of Claude (Read,
cat, head, tail, sed, `thimble rows`, a query that loaded it). A file only named, listed or counted (wc, ls, find,
git ls-files, grep -c) is not read, nor is one a search showed only its matching lines of. The coverage text, the bar's
share (total.read_share), the object's snapshot and trace use the one rule. Run: python -m pytest lean/tests"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

ENGINE = Path(__file__).resolve().parents[1] / "engine"
sys.path.insert(0, str(ENGINE))

from kernel import lineage as LIN  # noqa: E402
from kernel import objects as O  # noqa: E402
from kernel import query as Q  # noqa: E402
from kernel import shellcmd as SH  # noqa: E402
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
    assert {f for f, s in status.items() if s == "read"} == {"src/a.py", "src/b.py", "src/c.py", "src/d.py", "src/j.py"}
    assert status["src/e.py"] == "searched"
    assert {f for f, s in status.items() if s == "named"} == {"src/f.py", "src/g.py", "src/h.py", "src/i.py", "src/k.py",
                                                              "src/l.py", "runs.csv"}
    lines = {o["path"]: o["read_lines"] for o in cov["files"] if o["read"]}
    assert lines == {"src/a.py": 30, "src/b.py": 30, "src/c.py": 5, "src/d.py": 3, "src/j.py": 4}
    t = cov["total"]
    assert (t["read_files"], t["not_read_files"], t["untouched_files"]) == (5, 8, 0)
    assert t["read_share"] == pytest.approx(72 / 363)
    text = LIN.coverage_text(cov)
    assert "Every source file" not in text and "touched." not in text
    assert ("Read 5 of 13 source files, 72 of 363 rows (20%). Not read: 8 files (213 rows): 7 only named, listed or "
            "counted (runs.csv, src/f.py, src/g.py, src/h.py and 3 more); 1 searched, only matching lines shown (src/e.py).") in text
    assert "runs.csv  only named, listed or counted (wc); none of its lines shown" in text
    assert "src/g.py  only named, listed or counted (find, ls, wc)" in text
    assert "src/h.py  only named, listed or counted (cat > a file, find, ls, wc)" in text
    assert "src/e.py  searched: only matching lines shown (grep)" in text


def test_reading_every_file_says_so_and_how_much(code: Path, tmp_path: Path) -> None:
    saw(tmp_path, code, [bash("head -3 src/*.py runs.csv", 60)])
    cov = LIN.coverage(Store(code))
    assert all(o["status"] == "read" for o in cov["files"])
    assert LIN.coverage_sentence(cov) == "Read all 13 source files, at least in part: 38 of 363 rows (11%)."


def test_the_object_snapshot_and_trace_follow_the_same_rule(code: Path, tmp_path: Path) -> None:
    saw(tmp_path, code, [bash("wc -l src/*.py", 13), bash("cat src/a.py", 30)])
    st = Store(code)
    Q.run(st, "runs", 'len(load("runs.csv"))')
    cov = LIN.coverage(st)
    assert {o["path"] for o in cov["files"] if o["read"]} == {"src/a.py", "runs.csv"}
    obj = O.save(st, "runs", {"title": "Runs", "program": "return k.text('3 runs')", "data": {}})
    snap = obj["lineage"]["coverage"]
    assert set(snap["not_read"]) == {f"src/{c}.py" for c in NAMES[1:]}
    assert snap["files"]["src/b.py"] == "named" and snap["total"]["not_read_files"] == 11


@pytest.mark.parametrize("cmd, want", [
    ("cat runs.csv | head -2", [("runs.csv", "read", (1, 2))]),
    ("head -3 runs.csv | tail -1", [("runs.csv", "read", (3, 3))]),
    ("tail -n +2 runs.csv", [("runs.csv", "read", (2, 4))]),
    ("tail -2 runs.csv", [("runs.csv", "read", (3, 4))]),
    ("sed -n '2,$p' runs.csv", [("runs.csv", "read", (2, 4))]),
    ("sed -n '/a/p' runs.csv", [("runs.csv", "searched", None)]),
    ("sed -i 's/a/b/' runs.csv", [("runs.csv", "named", None)]),
    ("cat runs.csv 2>/dev/null", [("runs.csv", "read", (1, 4))]),
    ("cat runs.csv > out.csv", [("runs.csv", "named", None)]),
    ("cat runs.csv | grep -c a", [("runs.csv", "named", None)]),
    ("cat runs.csv | grep a | head -1", [("runs.csv", "searched", None)]),
    ("grep -n 'a|b' runs.csv", [("runs.csv", "searched", None)]),
    ("rg -l def src/", [(f"src/{c}.py", "named", None) for c in NAMES]),
    ("cd src && cat a.py", [("src/a.py", "read", (1, 30))]),
    ("for f in runs.csv; do head -2 $f; done", [("runs.csv", "named", None)]),
    ("python3 - <<'EOF'\nprint(open('runs.csv').read())\nEOF", [("runs.csv", "named", None)]),
    ("thimble rows runs.csv", []),
])
def test_what_one_command_shows(code: Path, cmd: str, want: list) -> None:
    files = ["runs.csv"] + [f"src/{c}.py" for c in NAMES]
    lines = {"runs.csv": 4, **{f"src/{c}.py": 30 for c in NAMES}}
    got = [(f, how, span) for f, how, span, _ in SH.shows(cmd, files, str(code), str(code), lambda f: lines[f])]
    assert got == want
