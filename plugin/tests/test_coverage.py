"""Coverage claims no more than happened: a file is seen only when some of its lines or rows entered Claude's context
(Read, cat, head, tail, sed, a search that showed them by line). A search that went over it, a program or a rule label
that computed over it (code that names it, wc, grep -c), and a label's model that read its records are said apart;
none is seen. The bar counts the files touched (total.touched_files): seen, searched or computed over; a file only
listed by name (ls, find, a folder named in code) is not touched. The count reads a folder's databases without writing
beside them. Run: python3 -m pytest plugin/tests"""
from __future__ import annotations

import json
import sqlite3
import sys
from contextlib import closing
from pathlib import Path

import pytest

ENGINE = Path(__file__).resolve().parents[1] / "engine"
sys.path.insert(0, str(ENGINE))

from kernel import coverage as CV  # noqa: E402
from kernel import store as STORE  # noqa: E402
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


def test_a_full_count_with_no_line_read_touches_the_file_and_a_listing_does_not(code: Path, tmp_path: Path) -> None:
    """Coverage 0 means Claude looked at no file at all: a count over every line touches a file though none of its
    lines entered Claude's context; a file only listed by name is not touched."""
    saw(tmp_path, code, [bash("ls src/ runs.csv", 13), bash("wc -l runs.csv", 1)])
    cov = CV.coverage(Store(code))
    t = cov["total"]
    assert (t["touched_files"], t["seen_files"], t["files"]) == (1, 0, 13)
    assert t["touched_share"] == pytest.approx(1 / 13)
    assert [o["path"] for o in cov["files"]] == ["runs.csv"]
    assert (t["listed_files"], t["untouched_files"]) == (12, 0)
    assert "  src/a.py  only listed by name (ls); Claude read none of it\n" in CV.coverage_text(cov)
    assert CV.coverage_sentence(cov).startswith("Touched 1 of 13 files (read, searched or computed over). "
                                                 "Read: no part of any file entered Claude's context.")
    saw(tmp_path, code, [bash("ls src/", 12)])
    t = CV.coverage(Store(code))["total"]
    assert t["touched_files"] == 0 and t["touched_share"] == 0
    assert CV.coverage_sentence(CV.coverage(Store(code))).startswith("Touched 0 of 13 files: Claude has not looked at any of them.")


def test_each_file_and_folder_has_two_measures_read_and_counted(code: Path, tmp_path: Path) -> None:
    # 8 of 40 records read, and a code label over all of them: read 20%, counted 100% (read is part of it); a folder of
    # files of one unit says the same in that unit
    (code / "logs").mkdir()
    (code / "logs" / "events.jsonl").write_text("".join(json.dumps({"i": i}) + "\n" for i in range(40)))
    labels = STORE.kept_dir(code) / "labels"
    labels.mkdir(parents=True)
    units = {f"logs/events.jsonl#L{i}": {"v": "yes", "c": 1.0, "by": "code"} for i in range(1, 41)}
    (labels / "even.json").write_text(json.dumps({"name": "even", "kind": "code", "units": units, "sessions": ["s-cov"]}))
    saw(tmp_path, code, [{"tool": "Read", "file": str(code / "logs" / "events.jsonl"), "from": 1, "to": 8}])
    cov = CV.coverage(Store(code))
    f = next(o for o in cov["files"] if o["path"] == "logs/events.jsonl")
    assert (f["read_share"], f["counted_share"]) == (0.2, 1.0)
    g = next(g for g in cov["groups"] if g["folder"] == "logs/")
    assert (g["read_share"], g["counted_share"]) == (0.2, 1.0) and g["touched"] == 1


def test_only_a_model_labels_reads_are_said_as_a_models(code: Path, tmp_path: Path) -> None:
    """Two labels over the same table: a prompt label whose model read its rows, and a code label that only went over
    them. The model read is said with the prompt label's name alone; the code label computed over the rows."""
    st = Store(code)
    rows = ["runs.csv#row=1", "runs.csv#row=2", "runs.csv#row=3"]
    (st.dir / "labels").mkdir(parents=True, exist_ok=True)
    for name, by in (("mood", "model"), ("passed_flag", "code")):
        units = {ref: {"v": "yes", "c": 1.0, "by": by} for ref in rows}
        (st.dir / "labels" / f"{name}.json").write_text(json.dumps({"name": name, "kind": "prompt" if by == "model" else "code",
                                                                    "in": "runs.csv", "units": units, "sessions": ["s-cov"]}))
    saw(tmp_path, code, [])
    o = {f["path"]: f for f in CV.coverage(Store(code))["files"]}["runs.csv"]
    assert o["model_labels"] == ["mood"]
    # each whole, in the file's unit: the model read all 3 rows, and code went over all 3
    assert (o["unit"], o["units"], o["model_read_units"], o["computed_over_units"]) == ("rows", 3, 3, 3)
    assert "a label's model read 3 of 3 rows (mood)" in o["said"]
    assert "passed_flag" not in o["said"].split("computed over")[0]
    assert "computed over all 3 rows (passed_flag)" in o["said"]


def test_a_search_names_the_files_it_searches_not_its_pattern() -> None:
    from kernel import shellcmd as SH

    files = ["claude.jsonl", "images/1a.png", "images/9b.png", "src/a.py"]
    got = SH.shows("grep -o '\"cost\":[0-9.]*' claude.jsonl", files, "/data", "/data", lambda f: 10)
    assert [(f, how) for f, how, _, _ in got] == [("claude.jsonl", "searched")]
    got = SH.shows("grep -rn -e '[0-9]*.png' -A 2 src/a.py", files, "/data", "/data", lambda f: 10)
    assert [f for f, *_ in got] == ["src/a.py"]


def made_up_village(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """A made-up export: an event log, a table of agents, notes, and three days of screenshots."""
    d = tmp_path / "village"
    for day in ("d1", "d2", "d3"):
        (d / "shots" / day).mkdir(parents=True)
        for i in range(50):
            (d / "shots" / day / f"{i}.png").write_bytes(b"")
    (d / "events.jsonl").write_text("".join(json.dumps({"i": i, "kind": "MOVE" if i % 4 else "REST"}) + "\n" for i in range(40)))
    (d / "agents.jsonl").write_text('{"name":"Ada"}\n{"name":"Bo"}\n{"name":"Cy"}\n')
    (d / "notes.md").write_text("# Notes\n\nA line.\n")
    (d / "spare.jsonl").write_text('{"x":1}\n')
    monkeypatch.setenv("THIMBLE_HOME", str(tmp_path / "th"))
    monkeypatch.setenv("THIMBLE_SESSION", "s-cov")
    monkeypatch.delenv("THIMBLE_ROOT", raising=False)
    return d


def test_code_goes_over_the_files_it_names_also_in_a_script_it_wrote(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    # a script written with a here-document and run in the same command or a later one, and a script on disk (as
    # Claude's Write tool leaves it), go over the files their code names; a script never run goes over nothing
    d = made_up_village(tmp_path, monkeypatch)
    wrote = tmp_path / "wrote.py"
    wrote.write_text("print(open('notes.md').read().count('line'))\n")
    saw(tmp_path, d, [
        bash("cat > $TMPDIR/rest.py <<'PY'\nimport json\nfor l in open('events.jsonl'): pass\nPY\npython3 -I $TMPDIR/rest.py", 1),
        bash("cat > /made/up/count.py <<'PY'\nprint(sum(1 for _ in open('agents.jsonl')))\nPY", 0),
        bash("cat > /made/up/never.py <<'PY'\nprint(open('spare.jsonl').read())\nPY", 0),
        bash("python3 /made/up/count.py", 1),
        bash(f"python3 {wrote}", 1),
        bash("grep -m2 REST events.jsonl | cut -c1-200", 2),
    ])
    cov = CV.coverage(Store(d))
    by = {o["path"]: o for o in cov["files"]}
    assert set(by) == {"events.jsonl", "agents.jsonl", "notes.md"}
    ev = by["events.jsonl"]
    assert (ev["status"], ev["computed"], ev["computed_by"], ev["counted_share"]) == ("searched", 40, ["python3"], 1.0)
    assert ev["said"] == ("searched by grep; which lines it showed is not known; computed over all 40 records (python3); "
                          "Claude read none of it")
    assert by["agents.jsonl"]["status"] == by["notes.md"]["status"] == "computed"


def test_a_read_that_showed_no_line_only_names_the_file_and_a_part_of_a_file_counts_a_row(code: Path, tmp_path: Path) -> None:
    # a Read past the file's end shows no numbered line: the file is named, not read; a program that went over a few
    # lines of a file of one long record went over that record
    saw(tmp_path, code, [{"tool": "Read", "file": str(code / "src" / "a.py"), "from": None, "to": None},
                         bash("head -1 runs.csv | python3 -c 'import sys; print(len(sys.stdin.read()))'", 1)])
    cov = CV.coverage(Store(code))
    by = {o["path"]: o for o in cov["files"]}
    assert "src/a.py" not in by and "src/a.py" in (cov.get("untouched") or {}).get("path", [])
    assert by["runs.csv"]["said"] != ""


# the bar's count reads a WAL database as its writer left it: no -wal or -shm file appears beside it
def test_counting_a_wal_database_writes_nothing_beside_it(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("THIMBLE_HOME", str(tmp_path / "home"))
    d = tmp_path / "data"
    d.mkdir()
    with closing(sqlite3.connect(d / "runs.db")) as con:
        con.execute("pragma journal_mode=wal")
        con.execute("create table runs (name text)")
        con.executemany("insert into runs values (?)", [("made-up-a",), ("made-up-b",)])
        con.commit()
    before = sorted(p.name for p in d.iterdir())
    assert before == ["runs.db"]
    cov = CV.coverage(Store(d, session="s1"))
    assert cov["total"]["files"] == 1
    assert sorted(p.name for p in d.iterdir()) == before
