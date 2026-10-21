"""Coverage claims no more than happened: a file is seen only when some of its lines or rows entered Claude's context
(Read, cat, head, tail, sed, `thimble rows`, a search that showed them by line, a query that printed them as rows). A
query or a rule label that only went over its rows computed over it, and a label's model that read its records is said
apart; neither is seen. A file only named, listed or counted (wc, ls, find, git ls-files, grep -c) is not seen, nor is
one a shell search went over. The bar counts the files touched (total.touched_files): seen, or gone over by a query,
a rule, a search, a count or a program; a file only listed by name (ls, find) is not touched. The coverage text, the
object's snapshot and trace use the one rule. Run: python -m pytest plugin/tests"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

ENGINE = Path(__file__).resolve().parents[1] / "engine"
sys.path.insert(0, str(ENGINE))

from kernel import lineage as LIN  # noqa: E402
from kernel import sources as S  # noqa: E402
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
    # the bar's share is of files touched, each file once whatever its unit: a count over a file touches it
    assert t["touched_share"] == 1.0
    text = LIN.coverage_text(cov)
    assert "Every source file" not in text
    assert ("Touched 13 of 13 files (read, searched, counted or computed over). Read 5 of the files, at least in part: "
            "0 of 3 rows (0%) and 72 of 360 lines (20%) entered Claude's context. Not read: 8 files (3 rows and 210 lines): "
            "7 only named or counted (runs.csv, src/f.py, src/g.py, src/h.py and 3 more); 1 searched, which lines a search "
            "showed is not known (src/e.py).") in text
    assert "  src/c.py  read 5 of 30 lines (17%)\n" in text
    assert "runs.csv  only named or counted (wc); Claude read none of it" in text
    assert "src/g.py  only named or counted (find, ls, wc)" in text
    assert "src/h.py  only named or counted (cat > a file, find, ls, wc)" in text
    assert "src/e.py  searched by grep; which lines it showed is not known" in text


def test_reading_every_file_says_so_and_how_much(code: Path, tmp_path: Path) -> None:
    saw(tmp_path, code, [bash("head -3 src/*.py runs.csv", 60)])
    cov = LIN.coverage(Store(code))
    assert all(o["status"] == "seen" for o in cov["files"])
    assert LIN.coverage_sentence(cov) == ("Touched 13 of 13 files (read, searched, counted or computed over). Read all 13 "
                                          "files, at least in part: 2 of 3 rows (67%) and 36 of 360 lines (10%) entered "
                                          "Claude's context.")


def test_a_query_reads_the_rows_its_shown_table_holds_and_a_print_of_refs_reads_none(code: Path, tmp_path: Path) -> None:
    # a print of `_refs`, a script whose output named refs, and a result of refs alone name rows without their content:
    # the files are touched, none of their rows read. A result table of the rows' fields beside their refs shows its rows
    from kernel import query as Q

    (code / "people.csv").write_text("id,name,fare\n" + "".join(f"{i},Person{i} Example,{i}.25\n" for i in range(1, 101)))
    saw(tmp_path, code, [{**bash("python3 ids.py", 1), "refs": ["runs.csv#row=2"]}])
    st = Store(code)
    Q.run(st, "refs", 'df = load("people.csv")\nprint(list(df._ref[:12]))\nNone')
    Q.run(st, "refs alone", 'load("people.csv")._ref[:12]')
    by = {o["path"]: o for o in LIN.coverage(Store(code))["files"]}
    assert by["people.csv"]["status"] == "computed" and by["people.csv"]["seen_units"] == 0 and by["people.csv"]["touched"]
    assert by["runs.csv"]["status"] == "named" and by["runs.csv"]["seen_units"] == 0
    # 100 rows with their names: the result shows its first and last rows (query.display), and those are read
    q = Q.run(st, "names", 'load("people.csv")[["_ref", "name"]]')
    n = len(q["shown_rows"])
    assert 10 <= n < 100 and q["shown_rows"][0] == 0 and q["shown_rows"][-1] == 99
    by = {o["path"]: o for o in LIN.coverage(Store(code))["files"]}
    assert by["people.csv"]["status"] == "seen" and by["people.csv"]["seen_units"] == n


def test_each_file_is_counted_in_its_own_unit_and_no_rows_are_listed(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A folder that mixes kinds: records of a JSONL file, rows of a table, lines of Markdown, pages of a PDF, and an
    image as one whole file. An image viewed with Read is seen; a PDF read by pages counts those pages."""
    d = tmp_path / "mixed"
    d.mkdir()
    (d / "trials.jsonl").write_text("".join(json.dumps({"trial": i, "team": "otters"}) + "\n" for i in range(1, 201)))
    (d / "scores.csv").write_text("team,score\n" + "".join(f"t{i},{i}\n" for i in range(40)))
    (d / "notes.md").write_text("# Notes\n\nA line.\n\n## More\n\nAnother line.\n")
    (d / "chart.png").write_bytes(b"\x89PNG\r\n\x1a\n" + bytes(64))
    (d / "song.mp3").write_bytes(bytes(32))
    (d / "report.pdf").write_bytes(b"%PDF-1.4\n" + b"".join(b"%d 0 obj << /Type /Page /Parent 1 0 R >> endobj\n" % i for i in range(2, 7))
                                   + b"1 0 obj << /Type /Pages /Count 5 >> endobj\n%%EOF\n")
    monkeypatch.setenv("THIMBLE_HOME", str(tmp_path / "th"))
    monkeypatch.setenv("THIMBLE_SESSION", "s-cov")
    monkeypatch.delenv("THIMBLE_ROOT", raising=False)
    saw(tmp_path, d, [
        {"tool": "Read", "file": str(d / "chart.png"), "from": None, "to": None},
        {"tool": "Read", "file": str(d / "report.pdf"), "from": None, "to": None, "pages": "2-3"},
        {"tool": "Read", "file": str(d / "trials.jsonl"), "from": 10, "to": 12},
        bash("head -5 scores.csv", 5),
        # a search over the folder goes over the text files, not the image or the PDF
        {"tool": "Grep", "path": str(d), "mode": "files_with_matches", "files": []},
    ])
    cov = LIN.coverage(Store(d))
    by = {o["path"]: o for o in cov["files"]}
    assert set(by) == {"trials.jsonl", "scores.csv", "notes.md", "chart.png", "song.mp3", "report.pdf"}
    got = {f: (o["unit"], o["units"], o["seen_units"], o["status"]) for f, o in by.items()}
    assert got == {"trials.jsonl": ("records", 200, 3, "seen"), "scores.csv": ("rows", 40, 4, "seen"),
                   "notes.md": ("lines", 7, 0, "named"), "chart.png": ("file", 1, 1, "seen"),
                   "song.mp3": ("file", 1, 0, "not read"), "report.pdf": ("pages", 5, 2, "seen")}
    assert by["report.pdf"]["pages"] == [[2, 3]]
    said = {f: o["said"] for f, o in by.items()}
    assert said["trials.jsonl"] == "read 3 of 200 records (2%)"
    assert said["report.pdf"] == "read 2 of 5 pages (40%)"
    assert said["chart.png"] == "seen" and said["song.mp3"] == "none"
    text = LIN.coverage_text(cov)
    assert text.startswith("Coverage of this session · 6 files: 200 records, 40 rows, 7 lines, 5 pages and 2 other files\n")
    assert "  chart.png  seen\n" in text and "  song.mp3  none\n" in text
    assert ("Touched 5 of 6 files (read, searched, counted or computed over). Read 4 of the files, at least in part: "
            "3 of 200 records (2%), 4 of 40 rows (10%), 0 of 7 lines (0%), 2 of 5 pages (40%) and 1 of 2 other files "
            "entered Claude's context") in text
    assert cov["total"]["touched_share"] == pytest.approx(5 / 6)
    # never which rows: no line or row numbers in the text
    assert "10" not in text.replace("(10%)", "")


def test_a_full_count_with_no_line_read_touches_the_file_and_a_listing_does_not(code: Path, tmp_path: Path) -> None:
    """Coverage 0 means Claude looked at no file at all: a count over every line touches a file though none of its
    lines entered Claude's context; a file only listed by name is not touched."""
    saw(tmp_path, code, [bash("ls src/ runs.csv", 13), bash("wc -l runs.csv", 1)])
    cov = LIN.coverage(Store(code))
    t = cov["total"]
    assert (t["touched_files"], t["seen_files"], t["files"]) == (1, 0, 13)
    assert t["touched_share"] == pytest.approx(1 / 13)
    by = {o["path"]: o for o in cov["files"]}
    assert by["runs.csv"]["touched"] and not by["src/a.py"]["touched"]
    assert by["src/a.py"]["said"] == "only listed by name (ls); Claude read none of it"
    assert LIN.coverage_sentence(cov).startswith("Touched 1 of 13 files (read, searched, counted or computed over). "
                                                 "Read: no part of any file entered Claude's context.")
    saw(tmp_path, code, [bash("ls src/", 12)])
    t = LIN.coverage(Store(code))["total"]
    assert t["touched_files"] == 0 and t["touched_share"] == 0
    assert LIN.coverage_sentence(LIN.coverage(Store(code))).startswith("Touched 0 of 13 files: Claude has not looked at any of them.")


def test_a_shell_variable_in_a_path_names_only_the_files_it_can_stand_for(code: Path, tmp_path: Path) -> None:
    """`src/$n.py` in a loop over a and b names those two files, not every file under src/; a variable the command did
    not set stands for one name (`src/$1.py` is `src/*.py`), and a word that is only such a variable names nothing."""
    saw(tmp_path, code, [bash("for n in a b; do wc -l src/$n.py; done", 2), bash("head -3 $f", 3),
                         bash("D=src; wc -l $D/c.py", 1)])
    cov = LIN.coverage(Store(code))
    touched = sorted(o["path"] for o in cov["files"] if o["touched"])
    assert touched == ["src/a.py", "src/b.py", "src/c.py"] and cov["total"]["touched_files"] == 3
    saw(tmp_path, code, [bash("sqlite3 src/$1/forge.db 'select 1'", 1)])
    assert LIN.coverage(Store(code))["total"]["touched_files"] == 0
    saw(tmp_path, code, [bash("set -- $spec; wc -l src/$1.py", 12)])
    assert LIN.coverage(Store(code))["total"]["touched_files"] == 12


def test_the_entries_behind_a_value_take_their_files_word(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Records of a JSONL file, rows of a table, lines of text; the word of the kind most of them come from, `entries`
    when no kind holds most, and none for whole files with no entries."""
    d = tmp_path / "words"
    d.mkdir()
    (d / "trials.jsonl").write_text("".join(json.dumps({"trial": i}) + "\n" for i in range(1, 11)))
    (d / "scores.csv").write_text("team,score\n" + "".join(f"t{i},{i}\n" for i in range(10)))
    (d / "notes.txt").write_text("".join(f"line {i}\n" for i in range(10)))
    (d / "chart.png").write_bytes(b"\x89PNG\r\n\x1a\n" + bytes(64))
    monkeypatch.setenv("THIMBLE_HOME", str(tmp_path / "th"))
    monkeypatch.delenv("THIMBLE_ROOT", raising=False)
    st = Store(d)
    assert LIN.entries_of(st, ["trials.jsonl#L1-3"]) == {"unit": "records", "unit_one": "record"}
    assert LIN.entries_of(st, ["scores.csv#L2-3"])["unit"] == "rows"
    assert LIN.entries_of(st, ["notes.txt#L4"])["unit"] == "lines"
    # most from the JSONL file: its word; an even split: entries
    assert LIN.entries_of(st, ["trials.jsonl#L1-3", "scores.csv#L2"])["unit"] == "records"
    assert LIN.entries_of(st, ["trials.jsonl#L1", "scores.csv#L2"]) == {"unit": "entries", "unit_one": "entry"}
    assert LIN.entries_of(st, ["chart.png"]) == {"unit": None, "unit_one": None}


def test_each_file_and_folder_has_two_measures_read_and_counted(code: Path, tmp_path: Path) -> None:
    # 8 of 40 records read, and a query over all of them: read 20%, counted 100% (read is part of it); a folder of
    # files of one unit says the same in that unit
    (code / "logs").mkdir()
    (code / "logs" / "events.jsonl").write_text("".join(json.dumps({"i": i}) + "\n" for i in range(40)))
    th = code / "thimble"
    th.mkdir()
    (th / "ledger.jsonl").write_text(json.dumps({"session": "s-cov", "kind": "query", "id": "q1", "loaded": {"logs/events.jsonl": 40}}) + "\n")
    saw(tmp_path, code, [{"tool": "Read", "file": str(code / "logs" / "events.jsonl"), "from": 1, "to": 8}])
    cov = LIN.coverage(Store(code))
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
        (st.dir / "labels" / f"{name}.json").write_text(json.dumps({"name": name, "kind": "prompt" if by == "model" else "code", "in": "runs.csv", "units": units}))
        st.log({"kind": "label", "name": name})
    saw(tmp_path, code, [])
    o = {f["path"]: f for f in LIN.coverage(Store(code))["files"]}["runs.csv"]
    assert o["model_labels"] == ["mood"]
    assert "a label's model read 3 of 3 rows (mood)" in o["said"]
    assert "passed_flag" not in o["said"].split("computed over")[0]
    assert "computed over all 3 rows (passed_flag)" in o["said"]


def test_a_working_folder_of_links_counts_the_files_they_point_to(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    # a made-up dataset, and a working folder of links to each of its top-level files and folders (one link of a
    # folder holds many images), with a link back up and a broken link that must not count or loop
    data = tmp_path / "harbor"
    (data / "shots" / "day1").mkdir(parents=True)
    (data / "shots" / "day2").mkdir(parents=True)
    for d in ("day1", "day2"):
        for i in range(300):
            (data / "shots" / d / f"{i}.png").write_bytes(b"")
    (data / "boats.jsonl").write_text('{"boat":"Ada"}\n{"boat":"Bo"}\n{"boat":"Cy"}\n')
    (data / "README.md").write_text("# Harbor\n\nboats and shots\n")
    (data / "shots" / "day1" / "up").symlink_to(data / "shots")
    work = tmp_path / "work"
    work.mkdir()
    for x in data.iterdir():
        (work / x.name).symlink_to(x)
    (work / "gone.jsonl").symlink_to(tmp_path / "nowhere.jsonl")
    monkeypatch.setenv("THIMBLE_HOME", str(tmp_path / "th"))
    monkeypatch.setenv("THIMBLE_SESSION", "s-cov")
    monkeypatch.delenv("THIMBLE_ROOT", raising=False)
    before = sorted(p.name for p in work.iterdir())
    saw(tmp_path, work, [{"tool": "Read", "file": str(work / "boats.jsonl"), "from": 1, "to": 2}])

    cov = LIN.coverage(Store(work))
    by = {o["path"]: o for o in cov["files"]}
    assert cov["total"]["files"] == 602
    assert "shots/day2/299.png" in by and "gone.jsonl" not in by
    assert not any(p.startswith("shots/day1/up/") for p in by)
    assert by["boats.jsonl"]["touched"] and cov["total"]["touched_files"] == 1
    # the sources are the linked tables too, and nothing was written into the folder or the dataset
    assert S.list_sources(work) == ["README.md", "boats.jsonl"]
    assert sorted(p.name for p in work.iterdir()) == before
    assert sorted(p.name for p in data.iterdir()) == ["README.md", "boats.jsonl", "shots"]


def test_the_json_of_a_folder_of_many_files_stays_small(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    # the shell reads the first 4 MB of a command's output: a folder of many files lists a few of each folder, and
    # says how many more there are, while the totals count them all
    from kernel import cli as CLI

    d = tmp_path / "shots"
    for day in ("d1", "d2", "d3"):
        (d / day).mkdir(parents=True)
        for i in range(40):
            (d / day / f"{i}.png").write_bytes(b"")
    monkeypatch.setenv("THIMBLE_HOME", str(tmp_path / "th"))
    monkeypatch.setenv("THIMBLE_SESSION", "s-cov")
    monkeypatch.delenv("THIMBLE_ROOT", raising=False)
    monkeypatch.chdir(d)
    monkeypatch.setattr(CLI, "COVER_UNTOUCHED_MAX", 50)
    monkeypatch.setattr(CLI, "COVER_PER_FOLDER", 10)
    import contextlib
    import io

    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        assert CLI.main(["coverage", "--json"]) == 0
    got = json.loads(out.getvalue())
    assert got["total"]["files"] == 120
    assert len(got["untouched"]["path"]) == 30 and got["cut"] == {"files": 0, "untouched": 90}
    assert {p.split("/")[0] for p in got["untouched"]["path"]} == {"d1", "d2", "d3"}
