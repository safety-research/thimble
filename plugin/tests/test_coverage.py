"""Coverage claims no more than happened: a file is seen only when some of its lines or rows entered Claude's context
(Read, cat, head, tail, sed, a search that showed them by line). A search that went over it, a program or a rule label
that computed over it (code that names it, wc, grep -c), and a label's model that read its records are said apart;
none is seen. The bar counts the files touched (total.touched_files): seen, searched or computed over; a file only
listed by name (ls, find, a folder named in code) is not touched. The count reads a folder's databases without writing
beside them. Run: python3 -m pytest plugin/tests"""
from __future__ import annotations

import json
import os
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


def test_a_video_or_a_pdf_a_decoder_went_over_is_computed_not_only_listed() -> None:
    from kernel import shellcmd as SH

    files = ["P3/recording.mp4", "P3/transcript.md", "papers/a.pdf"]
    # frames taken from the video for Claude to look at: the video was gone over, its frames went to the temp folder
    got = SH.shows("for t in 19:30 20:00; do ffmpeg -v error -y -ss 00:$t -i P3/recording.mp4 -frames:v 1 $TMPDIR/f_$t.png; done",
                   files, "/data", "/data", lambda f: 10)
    assert ("P3/recording.mp4", "computed", None, "ffmpeg") in got
    got = SH.shows("ffprobe -v error -show_entries format=duration P3/recording.mp4; pdftotext papers/a.pdf - | head -40", files, "/data", "/data", lambda f: 10)
    assert [(f, how) for f, how, _, _ in got] == [("P3/recording.mp4", "computed"), ("papers/a.pdf", "computed")]
    # a listing still only names it
    assert [how for _, how, _, _ in SH.shows("ls -la P3/recording.mp4", files, "/data", "/data", lambda f: 10)] == ["listed"]


def test_a_database_code_opens_by_a_path_it_fills_in_or_a_query_inside_quotes_is_computed() -> None:
    from kernel import shellcmd as SH

    files = ["runs/a/forge.db", "runs/b/forge.db", "runs/a/manifest.json", "notes.md"]
    # code that fills in the start of a path (an f-string, a template): every file the rest of the path can name
    got = SH.shows("cd runs; python3 -I - <<'PY'\nimport glob, sqlite3\nfor d in glob.glob('*'):\n    sqlite3.connect(f'{d}/forge.db')\nPY",
                   files, "/data", "/data", lambda f: 10)
    assert sorted((f, how) for f, how, _, _ in got) == [("runs/a/forge.db", "computed"), ("runs/b/forge.db", "computed")]
    # a query in a command substitution inside quotes is a command of its own, and goes over the database
    got = SH.shows('cd runs; for d in */; do echo "$d | $(sqlite3 $d/forge.db "select count(*) from prs" | tr \'\\n\' \' \')"; done',
                   files, "/data", "/data", lambda f: 10)
    assert sorted((f, how, by) for f, how, _, by in got) == [("runs/a/forge.db", "computed", "sqlite3"), ("runs/b/forge.db", "computed", "sqlite3")]


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


def test_a_corpus_of_thousands_of_folders_keeps_its_record_under_claude_codes_output_limit() -> None:
    """Claude Code reads the first 4 MiB of a command's output: a trace corpus of thousands of small folders gave a
    --json record past it, cut short, which the bar could not read. The folders keep what the pane reads, and the
    deepest untouched ones fold into their parent folder until they fit, every file still counted."""
    from kernel import cli as CLI

    groups = [{"folder": "notes/", "files": 3, "touched": 2, "seen_files": 1, "rows": 9, "by_status": {"seen": 1}}]
    for run in range(4):
        for task in range(300):
            for ep in range(3):
                hit = (run, task, ep) == (0, 7, 0)
                groups.append({"folder": f"runs/run-{run}/task-{task}/trial-1/episode-{ep}/", "files": 2,
                               "touched": int(hit), "seen_files": int(hit), "rows": 40, "by_status": {"untouched": 2}})
    room = 64_000
    out = CLI.cover_groups(groups, room)
    assert len(json.dumps(out, separators=(",", ":")).encode()) <= room
    assert set(out[0]) == set(CLI.COVER_GROUP_KEYS)
    # every file still counted, and the touched folder kept whole
    assert sum(g["files"] for g in out) == sum(g["files"] for g in groups)
    touched = {g["folder"]: g for g in out if g["touched"]}
    assert set(touched) == {"notes/", "runs/run-0/task-7/trial-1/episode-0/"}
    assert len(out) < len(groups) and all(g["folder"].count("/") < 5 for g in out if not g["touched"])


@pytest.mark.parametrize("shape", ["every folder touched", "every folder at the top"])
def test_a_folder_of_70000_folders_gives_a_record_claude_code_reads_whole(tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
                                                                          capsys: pytest.CaptureFixture[str], shape: str) -> None:
    """A trace corpus of 210,000 files in 70,000 small folders gave a --json record of 5.7 MB, past the 4 MiB Claude
    Code reads, so the bar's count failed: the folders Claude touched never folded, nor did the folders at the top. The
    record keeps the folders the pane needs most, each counting every file in it, and names the files of those it keeps.
    (The folder is made up, one file in each of its 70,000 folders, listed and counted in memory.)"""
    from kernel import cli as CLI
    from kernel import sources as S

    if shape == "every folder touched":
        folders = [f"runs/run-{r:02d}/task-{t:04d}/trial-{k}/" for r in range(1, 11) for t in range(1, 3501) for k in (1, 2)]
    else:
        folders = [f"trial-{i:06d}/" for i in range(1, 70001)]
    files = sorted([f + "stdout.log" for f in folders] + ["README.md"])
    monkeypatch.setattr(S, "list_files", lambda root: files)
    monkeypatch.setattr(S, "counts", lambda root, rels, cache, until=None: {f: {"kind": "jsonl", "rows": 3, "lines": 3} for f in rels})
    d = tmp_path / "evals"
    d.mkdir()
    for k, v in {"THIMBLE_HOME": str(tmp_path / "th"), "THIMBLE_ROOT": str(d), "THIMBLE_SESSION": "s-wide"}.items():
        monkeypatch.setenv(k, v)
    read = folders[4321] + "stdout.log"
    calls = [{"tool": "Read", "file": str(d / read), "from": 1, "to": 3}, {"tool": "Read", "file": str(d / "README.md"), "from": 1, "to": 3}]
    if shape == "every folder touched":
        calls.append({"tool": "Grep", "path": None, "glob": None, "mode": "files_with_matches"})
    seen = tmp_path / "th" / "seen"
    seen.mkdir(parents=True)
    (seen / "s-wide.jsonl").write_text("".join(json.dumps({"cwd": str(d), **c}) + "\n" for c in calls))
    assert CLI.main(["coverage", "--json"]) == 0
    out = capsys.readouterr().out
    assert len(out.encode()) <= 4 * 1024 * 1024
    cov = json.loads(out)
    t = cov["total"]
    assert (t["files"], t["touched_files"]) == (len(files), len(files) if shape == "every folder touched" else 2)
    # every file is counted in one folder, and each file named is in a folder the record keeps: the pane's tree adds up
    assert sum(g["files"] for g in cov["groups"]) == len(files)
    assert sum(g["touched"] for g in cov["groups"]) == t["touched_files"]
    kept = {g["folder"] for g in cov["groups"]}
    assert all(o["folder"] in kept for o in cov["files"])
    assert all(CV.folder_of(p) in kept for p in cov["untouched"]["path"])
    # the files Claude read are named, with the folders they are in
    assert {"README.md", read} <= {o["path"] for o in cov["files"] if o["seen"]}


def _folder(tmp_path: Path, n: int) -> tuple[Path, list[str]]:
    """A made-up folder of n small record files of different sizes."""
    d = tmp_path / "many"
    d.mkdir()
    for i in range(n):
        (d / f"r{i:03d}.jsonl").write_text('{"step": 1}\n' * (i + 1))
    return d, sorted(p.name for p in d.iterdir())


def test_a_count_stopped_part_way_keeps_what_it_counted_and_the_next_goes_on_from_there(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """The first count of a big folder on a slow disk outlasted the time Claude Code gives a command, or the next
    reload of the plugin, which killed it. It kept nothing, so every count began again at the first file and none
    ended. Each file is now kept as it is counted, so the count after a kill counts only the files left."""
    import signal
    import subprocess
    import textwrap
    import time

    from kernel import sources as S

    d, files = _folder(tmp_path, 30)
    cache = tmp_path / "cache" / "counts.json"
    eleventh = tmp_path / "eleventh"
    child = textwrap.dedent(f"""
        import sys, time
        from pathlib import Path
        sys.path.insert(0, {str(ENGINE)!r})
        from kernel import sources as S
        real, n = S.count_rows, [0]
        def slow(root, rel):
            n[0] += 1
            if n[0] == 11:  # ten files counted: the count is killed while it counts the eleventh
                Path({str(eleventh)!r}).write_text("")
                time.sleep(120)
            return real(root, rel)
        S.count_rows = slow
        S.counts(Path({str(d)!r}), {files!r}, Path({str(cache)!r}))
    """)
    p = subprocess.Popen([sys.executable, "-c", child])
    try:
        until = time.time() + 60
        while not eleventh.exists():
            assert p.poll() is None and time.time() < until, "the count ended before it was killed"
            time.sleep(0.05)
    finally:
        p.send_signal(signal.SIGKILL)  # as Claude Code stops it: no cleanup runs
        p.wait()
    real = S.count_rows
    counted: list[str] = []
    monkeypatch.setattr(S, "count_rows", lambda root, rel: (counted.append(rel), real(root, rel))[1])
    got = S.counts(d, files, cache)
    assert len(counted) == 20
    assert got == S.counts(d, files, None)
    # and a count after a whole one counts nothing again
    counted.clear()
    assert S.counts(d, files, cache) == got and counted == []


def test_a_count_given_a_time_stops_counting_then_says_how_far_it_got_and_the_next_run_ends(tmp_path: Path) -> None:
    """The plugin's count runs within Claude Code's time limit: past the time it is given, the command stops counting the
    folder's files, keeps what it counted and says how far it got, and the next run goes on and gives the record."""
    import subprocess

    d, files = _folder(tmp_path, 12)
    env = {**os.environ, "THIMBLE_PYTHON": sys.executable, "THIMBLE_ROOT": str(d), "THIMBLE_HOME": str(tmp_path / "th"),
           "THIMBLE_SESSION": "s-cov"}
    run = lambda *a: subprocess.run([str(ENGINE.parent / "bin" / "thimble"), "coverage", "--json", *a], text=True,  # noqa: E731
                                    capture_output=True, cwd=d, env=env, timeout=120)
    first = run("--within", "0")
    assert first.returncode == 0, first.stderr
    assert json.loads(first.stdout) == {"counting": {"counted": 0, "files": 12}}
    second = run("--within", "60")
    assert second.returncode == 0, second.stderr
    assert json.loads(second.stdout)["total"]["files"] == 12


def test_a_search_the_session_repeats_goes_over_its_folder_once(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A long session (a resumed one, compacted more than once) searches the same folders again and again, and each
    search of a folder went over each of its files: a count of a folder of 150,000 files took minutes per thousand calls,
    so the bar's count of such a session never ended. A search or a command done again changes nothing: the folder is
    gone over once, and the coverage is the same as of each call once."""
    from kernel import shellcmd as SH

    d, files = _folder(tmp_path, 50)
    monkeypatch.setenv("THIMBLE_HOME", str(tmp_path / "th"))
    monkeypatch.delenv("THIMBLE_ROOT", raising=False)
    calls = [{"tool": "Grep", "path": str(d), "glob": "*.jsonl", "mode": "content", "lines": {str(d / "r001.jsonl"): [1]}},
             {"tool": "Grep", "path": str(d), "glob": None, "mode": "files_with_matches"},
             bash("grep -rn step . | head -5", 5),
             bash("python3 - <<'PY'\nimport glob\nfor p in glob.glob('r00*.jsonl'):\n    open(p).read()\nPY", 1),
             {"tool": "Read", "file": str(d / "r002.jsonl"), "from": 1, "to": 2}]
    seen = tmp_path / "th" / "seen"
    seen.mkdir(parents=True)
    for name, rows in (("s-once", calls), ("s-long", calls * 200)):
        (seen / f"{name}.jsonl").write_text("".join(json.dumps({"cwd": str(d), **r}) + "\n" for r in rows))
    once = CV.coverage(Store(d, session="s-once"))
    gone = [0]
    under = SH.Known.under
    monkeypatch.setattr(SH.Known, "under", lambda self, folder: (fs := under(self, folder), gone.__setitem__(0, gone[0] + len(fs)))[0])
    long = CV.coverage(Store(d, session="s-long"))
    assert gone[0] <= len(files)
    assert long["total"] == once["total"]
    assert [(o["path"], o["status"], o["said"]) for o in long["files"]] == [(o["path"], o["status"], o["said"]) for o in once["files"]]


def test_a_long_sessions_record_in_parts_counts_the_calls_of_every_part(tmp_path: Path,
                                                                         monkeypatch: pytest.MonkeyPatch) -> None:
    """The hooks module keeps a long session's calls in parts of 3.5M characters (`<session>.jsonl`, then
    `<session>.2.jsonl` and on). Coverage read the first part alone, so what a resumed session read after it never
    counted."""
    d, _ = _folder(tmp_path, 4)
    monkeypatch.setenv("THIMBLE_HOME", str(tmp_path / "th"))
    monkeypatch.delenv("THIMBLE_ROOT", raising=False)
    seen = tmp_path / "th" / "seen"
    seen.mkdir(parents=True)
    for part, name in (("", "r000.jsonl"), (".2", "r001.jsonl"), (".3", "r002.jsonl")):
        row = {"cwd": str(d), "tool": "Read", "file": str(d / name), "from": 1, "to": 1}
        (seen / f"s-parts{part}.jsonl").write_text(json.dumps(row) + "\n")
    cov = CV.coverage(Store(d, session="s-parts"))
    assert [o["path"] for o in cov["files"] if o["seen"]] == ["r000.jsonl", "r001.jsonl", "r002.jsonl"]


def test_a_long_session_whose_calls_each_go_over_every_file_counts_in_about_the_time_of_a_short_one(
        tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A long session (a resumed one, compacted more than once) runs code that globs every file and opens one more,
    searches the whole folder, Greps with a glob no call used before, and names folders outside the folder (`$OUT/x/`
    can be any folder), each time in other words. Each such call went over each file or folder it could name: the count
    of a few thousand calls over 150,000 files took minutes. A glob's files are one set, added once, and a glob is
    tried only on what can match it, so 2,500 such calls over 20,000 files in 2,000 folders count in about the time of
    five. (The folder is made up, listed and counted in memory: the time measured is the session's pass.)"""
    import time

    from kernel import sources as S

    files = sorted(f"r{i:04d}/{n}" for i in range(2000) for n in [f"e{j}.jsonl" for j in range(9)] + ["meta.json"])
    monkeypatch.setattr(S, "list_files", lambda root: files)
    monkeypatch.setattr(S, "counts", lambda root, rels, cache, until=None: {f: {"kind": "jsonl", "rows": 3, "lines": 3} for f in rels})
    d = tmp_path / "runs"
    d.mkdir()
    monkeypatch.setenv("THIMBLE_HOME", str(tmp_path / "th"))
    monkeypatch.delenv("THIMBLE_ROOT", raising=False)

    def calls(n: int) -> list[str]:
        out = []
        for i in range(n):
            r = f"r{i % 2000:04d}"
            for c in (bash(f"python3 - <<'PY'\nimport glob, json\nm = json.load(open('{r}/meta.json'))\n"
                           f"n = sum(1 for p in glob.glob('*/e*.jsonl'))\nprint(m, n, {i})\nPY", 1),
                      {"tool": "Grep", "path": str(d), "glob": f"*{r}*e{i // 2000 % 9}*", "mode": "content", "lines": {}},
                      bash(f"grep -rn 'step {i}' . | head -3", 3),
                      bash(f"ls $OUT/made{i}/ /tmp/made/x{i}/ | head", 2),
                      {"tool": "Read", "file": str(d / "r0001" / "e1.jsonl"), "from": 1, "to": 2}):
                out.append(json.dumps({"cwd": str(d), **c}) + "\n")
        return out

    seen = tmp_path / "th" / "seen"
    seen.mkdir(parents=True)
    (seen / "s-short.jsonl").write_text("".join(calls(1)))
    long = calls(500)
    (seen / "s-long.jsonl").write_text("".join(long[:1250]))
    (seen / "s-long.2.jsonl").write_text("".join(long[1250:]))

    def timed(session: str) -> tuple[dict, float]:
        took = []
        for _ in range(2):
            t = time.monotonic()
            cov = CV.coverage(Store(d, session=session))
            took.append(time.monotonic() - t)
        return cov, min(took)

    short, short_s = timed("s-short")
    many, many_s = timed("s-long")
    assert short["total"]["touched_files"] == many["total"]["touched_files"] == 20000
    assert short["total"]["seen_files"] == many["total"]["seen_files"] == 1
    last = next(o for o in many["files"] if o["path"] == "r0499/meta.json")
    assert "python3" in last["computed_by"]
    # each call over every file again: the first version took 10 s more, and 600 MB; r106-int 26 s more; now 0.2 s more
    assert many_s - short_s < 1.0, (short_s, many_s)


def test_a_glob_is_tried_only_on_the_files_that_can_match_it_and_names_what_a_test_of_every_file_does() -> None:
    """A glob not seen before went over every file: each new Grep glob, `find -name` pattern or word that can name any
    folder (`$OUT/x/` is `*/x`) cost a pass over 150,000 files. A glob's literal parts lie in folder names or in the
    file's name, so only the files under folders, or with names, that hold them are tried; a part that names any
    folder (`*`, `**`) is looked up from the first part after it that names something. Code that globs many files and
    opens one more keeps the glob's own set, so a long session holds no copy of it per call."""
    import fnmatch
    import re

    from kernel import shellcmd as SH

    files = sorted([f"r{i:04d}/{n}" for i in range(300) for n in [f"e{j}.jsonl" for j in range(5)] + ["meta.json"]]
                   + [f"r{i:04d}/steps/s{j}.json" for i in range(0, 300, 7) for j in range(3)]
                   + ["made/x", "a/made/x", "a/b/made/x", "a/b/c/made/y", "top.json"])
    K = SH.Known(files)
    # a Grep's glob (fnmatch, by name or by path): tried on few files, matching what a test of every file matches
    assert sorted(K.candidates("*r0123*")) == [f"r0123/{n}" for n in ["e0.jsonl", "e1.jsonl", "e2.jsonl", "e3.jsonl", "e4.jsonl", "meta.json"]]
    for g in ["**/r0126/**/*.json", "*r0123*", "r0123/*.json", "*.jsonl", "*meta*", "[!r]*", "*/steps/*", "?0*", "*", "a/*"]:
        m = re.compile(fnmatch.translate(g)).match
        assert ({f for f in K.candidates(g) if m(f[f.rfind("/") + 1:]) or m(f)}
                == {f for f in files if m(f[f.rfind("/") + 1:]) or m(f)}), g
    # a shell glob: looked up by name or walked down, the files a test of every file finds
    for p in ["**/*/made/x", "*/made/x", "**/made/*", "*/*/made/x", "**/*/*/y", "*/e1.jsonl", "r01*/meta.json",
              "**/steps/*.json", "**/r0007/**", "r00[0-4]*/steps/s1.json", "*/*/s2.json", "**/*.json", "*", "**",
              "**/*/steps/s0.json", "a/**/*/x"]:
        assert K.glob(p) == {f for f in files if SH._glob_rx(p).match(f)}, p
    # code that globs files and opens one more: the glob's set is the one Known.glob keeps, in every command
    one, _ = SH.named("import glob, json\njson.load(open('r0001/meta.json'))\nglob.glob('*/e*.jsonl')", K, "/data")
    two, _ = SH.named("import glob, json\njson.load(open('r0002/meta.json'))\nglob.glob('*/e*.jsonl')", K, "/data")
    assert one.globs == two.globs and one.globs[0] is two.globs[0] is K.glob("*/e*.jsonl") and len(one.globs[0]) == 1500
    assert one.files == {"r0001/meta.json"} and two.files == {"r0002/meta.json"}


def test_greps_into_many_folders_and_a_glob_through_every_folder_count_in_about_the_time_of_one_grep(
        tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A Grep into one run's folder with a glob (`*.json`) looked for the glob's files among every name in the root
    that holds `.json`, and a glob whose parts name any folder (`runs/*/*/*.json`) looked its last part up once for
    each folder above it: 1,000 such Greps over 150,000 files took two minutes, and the glob over 140,000 files half a
    minute, where r106-int took seconds. A lookup by name now stops once it costs more than the folder's own files, and
    a glob looks a name up once, so 1,000 Greps, one into each of 1,000 folders that hold 6,000 files, and the glob
    over those files each count in about the time of one Grep. (The folder is made up, listed and counted in memory:
    the time measured is the session's pass.)"""
    import time

    from kernel import sources as S

    files = sorted([f"runs/r{i:04d}/steps/{i:04d}-{j}.json" for i in range(1000) for j in range(5)]
                   + [f"runs/r{i:04d}/meta.json" for i in range(1000)])
    monkeypatch.setattr(S, "list_files", lambda root: files)
    monkeypatch.setattr(S, "counts", lambda root, rels, cache, until=None: {f: {"kind": "json", "rows": 1, "lines": 1} for f in rels})
    d = tmp_path / "data"
    d.mkdir()
    monkeypatch.setenv("THIMBLE_HOME", str(tmp_path / "th"))
    monkeypatch.delenv("THIMBLE_ROOT", raising=False)

    def grep(i: int) -> str:
        return json.dumps({"cwd": str(d), "tool": "Grep", "path": str(d / "runs" / f"r{i:04d}"), "glob": "*.json",
                           "mode": "content", "lines": {}}) + "\n"

    seen = tmp_path / "th" / "seen"
    seen.mkdir(parents=True)
    (seen / "s-one.jsonl").write_text(grep(0))
    (seen / "s-greps.jsonl").write_text("".join(grep(i) for i in range(1000)))
    (seen / "s-glob.jsonl").write_text(grep(0) + json.dumps({"cwd": str(d), **bash("wc -l runs/*/*/*.json | tail -1", 1)}) + "\n")

    def timed(session: str) -> tuple[dict, float]:
        took = []
        for _ in range(2):
            t = time.monotonic()
            cov = CV.coverage(Store(d, session=session))
            took.append(time.monotonic() - t)
        return cov, min(took)

    one, one_s = timed("s-one")
    greps, greps_s = timed("s-greps")
    glob, glob_s = timed("s-glob")
    assert (one["total"]["touched_files"], greps["total"]["touched_files"], glob["total"]["touched_files"]) == (6, 6000, 5001)
    step = next(o for o in glob["files"] if o["path"] == "runs/r0999/steps/0999-4.json")
    assert step["computed_by"] == ["wc"]
    # each Grep went over every name that holds `.json`, and the glob over them again for each run's folder:
    # 219567533 took 2 to 4 s more for each; r106-int 0.1 s more; now 0.03 s more
    assert greps_s - one_s < 0.5, (one_s, greps_s)
    assert glob_s - one_s < 0.5, (one_s, glob_s)
