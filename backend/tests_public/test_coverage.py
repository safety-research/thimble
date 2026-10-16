"""Coverage (app/coverage.py, `thimble state coverage`, `thimble act coverage`): what a session's tool calls read,
searched or never opened in the corpus's data files. Facts merge per file (whole, a part's line or page ranges,
searched), facts outside the corpus or on code files are dropped, a recursive search over a folder is one fact for every
data file under it, the cards' reads and the labels' runs count as searched, rows group by folder and extension, the
summary line has its four forms, and an index of 1,032,019 files answers both requests in under 1 s without walking or
counting. The index job starts once under its lock, under nice and ionice, and keys its rows by size and mtime."""
from __future__ import annotations

import fcntl
import json
import os
import sqlite3
import subprocess
import time
from pathlib import Path

import pytest

from app import config, corpus_walk, coverage, local, notebook, records

SID = "sess-1"
HERE = Path(__file__).resolve().parent
REAL_START = coverage.start_index


@pytest.fixture()
def corpus(tmp_path, monkeypatch):
    """A corpus registered as a directory corpus (DATA_DIR/<name> with a manifest), shaped like toy-incident: twelve
    agents' logs, prompts, and files at the top. The index job is not started by a request (start_index recorded)."""
    data = tmp_path / "data"
    root = data / "toy"
    (root / "agents").mkdir(parents=True)
    (root / "prompts").mkdir()
    monkeypatch.setattr(config, "DATA_DIR", data.resolve())
    (root / "manifest.json").write_text(json.dumps({"name": "toy", "description": ""}))
    for i in range(1, 13):
        (root / "agents" / f"agent-{i:02d}.jsonl").write_text("".join(json.dumps({"i": i, "n": n}) + "\n"
                                                                      for n in range(10)))
    for name in ("worker", "manager", "kickoff", "env_manual"):
        (root / "prompts" / f"{name}.md").write_text(f"# {name}\n\nline\n")
    (root / "events.jsonl").write_text("".join(json.dumps({"e": n}) + "\n" for n in range(140)))
    (root / "board.jsonl").write_text("".join(json.dumps({"b": n}) + "\n" for n in range(20)))
    (root / "pull_requests.csv").write_text("id,title\n" + "".join(f"{n},t{n}\n" for n in range(5)))
    (root / "README.md").write_text("# toy\n")
    (root / "notes.py").write_text("print(1)\n")  # a code file: never in the universe
    started: list[str] = []
    monkeypatch.setattr(coverage, "start_index", lambda c, force=False: started.append(c) or False)
    root = root.resolve()
    yield {"c": "toy", "root": root, "started": started}
    corpus_walk.forget()


def _index(c: str, root: Path) -> None:
    """The job's body in this process (no detached job)."""
    assert coverage.run_job(c, root) == 0


def _facts(c, facts, sid=SID, turn="t1"):
    return coverage.add_facts(c, sid, turn, facts)


def test_is_data_follows_the_shared_case_list():
    cases = json.loads((HERE / "fixtures" / "data_files.json").read_text())["cases"]
    wrong = [c for c in cases if coverage.is_data(c["path"], c["codeTree"]) is not c["data"]]
    assert not wrong, wrong
    assert len(cases) >= 50


def test_facts_merge_whole_part_lines_pages_and_searched(corpus):
    c, root = corpus["c"], corpus["root"]
    _index(c, root)
    s = _facts(c, [
        {"path": "events.jsonl", "how": "part", "lines": [1, 50], "total": 140, "by": "Read"},
        {"path": "events.jsonl", "how": "part", "lines": [40, 70], "by": "Read"},
        {"path": str(root / "board.jsonl"), "how": "whole", "by": "Bash"},
        {"path": "pull_requests.csv", "how": "searched", "by": "search"},
        {"path": "agents/agent-01.jsonl", "how": "searched", "by": "search"},
        {"path": "agents/agent-01.jsonl", "how": "part", "lines": [1, 3], "by": "Read"},
    ])
    assert s["files"] == {"seen": 3, "searched": 1, "never": 17, "total": 21}
    # events: lines 1-70 of 140; board: all 20; agent-01: 3 of 10
    assert s["records"]["counted"] is True
    assert s["records"]["seen"] == 70 + 20 + 3
    total = sum(records.count(p, p.relative_to(root).as_posix()) for p in root.rglob("*")
                if p.is_file() and coverage.is_data(p.relative_to(root).as_posix(), False))
    assert s["records"]["total"] == total
    assert s["line"] == f"saw {round(100 * 93 / total)}% of records (3 of 21 files)"
    stored = coverage.read_facts(c, SID)
    assert len(stored) == 6 and all(f["turn"] == "t1" for f in stored)
    assert stored[2]["path"] == "board.jsonl"  # stored relative to the corpus


def test_part_with_pdf_pages_counts_the_pages(corpus, monkeypatch):
    c, root = corpus["c"], corpus["root"]
    (root / "postmortem.pdf").write_bytes(b"%PDF-1.4 not really")
    monkeypatch.setattr(records, "count", lambda path, rel, under=None: 12 if rel.endswith(".pdf") else
                        sum(1 for _ in open(path, "rb")))
    _index(c, root)
    _facts(c, [{"path": "postmortem.pdf", "how": "part", "pages": [2, 5], "total": 12, "by": "Read"},
               {"path": "postmortem.pdf", "how": "part", "pages": [4, 6], "by": "Read"}])
    row = next(r for r in coverage.rows(c, SID) if r["ext"] == ".pdf")
    assert (row["seen"], row["records_seen"], row["records_total"]) == (1, 5, 12)


def test_paths_outside_the_corpus_and_code_files_are_dropped(corpus, tmp_path):
    c, root = corpus["c"], corpus["root"]
    _index(c, root)
    outside = tmp_path / "elsewhere.jsonl"
    outside.write_text("{}\n")
    s = _facts(c, [
        {"path": str(outside), "how": "whole", "by": "Read"},
        {"path": "../elsewhere.jsonl", "how": "whole", "by": "Read"},
        {"path": "notes.py", "how": "whole", "by": "Read"},
        {"path": "node_modules/x.jsonl", "how": "whole", "by": "Read"},
        {"path": os.environ["THIMBLE_HOME"] + "/config.json", "how": "whole", "by": "Read"},
        {"path": "events.jsonl", "how": "nonsense", "by": "Read"},
    ])
    assert s["files"]["seen"] == 0 and coverage.read_facts(c, SID) == []
    rows = coverage.rows(c, SID)
    assert all(r["ext"] != ".py" for r in rows)


def test_a_code_tree_keeps_no_code_fact(corpus):
    c, root = corpus["c"], corpus["root"]
    (root / "pyproject.toml").write_text("[project]\n")
    (root / "src").mkdir()
    (root / "src" / "app.py").write_text("x = 1\n")
    (root / "src" / "big.json").write_text("{}")
    _facts(c, [{"path": "src/app.py", "how": "whole", "by": "Read"},
               {"path": "src/big.json", "how": "whole", "by": "Read"},
               {"path": "README.md", "how": "whole", "by": "Read"}])
    assert coverage.read_facts(c, SID) == []
    _facts(c, [{"path": "events.jsonl", "how": "whole", "by": "Read"}])
    assert [f["path"] for f in coverage.read_facts(c, SID)] == ["events.jsonl"]


def test_a_recursive_search_over_a_folder_is_one_fact_for_every_data_file_under_it(corpus):
    c, root = corpus["c"], corpus["root"]
    _index(c, root)
    s = _facts(c, [{"path": "agents", "how": "searched", "folder": True, "by": "search"},
                   {"path": "agents/agent-03.jsonl", "how": "whole", "by": "Read"}])
    stored = coverage.read_facts(c, SID)
    assert [f["path"] for f in stored] == ["agents", "agents/agent-03.jsonl"] and stored[0]["folder"] is True
    assert s["files"]["seen"] == 1 and s["files"]["searched"] == 11
    agents = next(r for r in coverage.rows(c, SID) if r["folder"] == "agents")
    assert (agents["files"], agents["seen"], agents["searched"], agents["never"]) == (12, 1, 11, 0)
    # the whole corpus searched (grep -r with no folder): every other data file is searched
    s = _facts(c, [{"path": ".", "how": "searched", "folder": True, "by": "search"}])
    assert s["files"] == {"seen": 1, "searched": 20, "never": 0, "total": 21}
    # a folder fact over a folder that is no folder, or a never-folder, is dropped
    _facts(c, [{"path": "events.jsonl", "how": "searched", "folder": True}, {"path": "node_modules", "how": "searched",
                                                                            "folder": True}])
    assert len(coverage.read_facts(c, SID)) == 3


def test_card_reads_and_label_runs_since_activation_count_as_searched(corpus, monkeypatch):
    c, root = corpus["c"], corpus["root"]
    _index(c, root)
    home = Path(os.environ["THIMBLE_HOME"])
    (home / "up").mkdir(parents=True, exist_ok=True)
    (home / "up" / f"{SID}.active").write_text(json.dumps({"at": time.time() - 60}))
    ws = config.workspace_dir(c)
    nb = notebook.create_notebook(ws, "Your work", role="analyst")
    old = notebook.new_cell("code", "terminal", "Old", nb["id"], code="1")
    old["reads"], old["ts"] = ["board.jsonl"], "2001-01-01T00:00:00+00:00"
    new = notebook.new_cell("code", "terminal", "New", nb["id"], code="2")
    new["reads"] = ["events.jsonl", "pull_requests.csv"]
    nb["cells"] += [old, new]
    notebook.write_notebook(ws, nb)
    from app import concepts

    concept = concepts.new_concept("Cause", "why", "prompt", "x", "record", ["a", "b"], "analyst", glob="agents/**")
    concept["applications"] = [{"ts": coverage.datetime.now().astimezone().isoformat(), "paths": ["agents/**"]}]
    concepts.write_concept(ws, concept)
    s = coverage.summary(c, SID)
    assert s["files"]["searched"] == 2 + 12 and s["files"]["seen"] == 0
    rows = {r["key"]: r for r in coverage.rows(c, SID)}
    assert rows["agents|.jsonl"]["searched"] == 12
    assert rows[".|.jsonl"]["searched"] == 1  # events.jsonl; board.jsonl was read by a card made before


def test_rows_group_by_folder_and_extension_and_drill(corpus):
    c, root = corpus["c"], corpus["root"]
    _index(c, root)
    _facts(c, [{"path": "agents/agent-01.jsonl", "how": "whole"}, {"path": "events.jsonl", "how": "whole"}])
    rows = coverage.rows(c, SID)
    assert len(rows) <= coverage.ROWS_MAX
    first = rows[0]
    assert first == {"key": "agents|.jsonl", "folder": "agents", "ext": ".jsonl", "path": None, "files": 12, "seen": 1,
                     "searched": 0, "never": 11, "records_seen": 10, "records_total": 120,
                     "bytes": first["bytes"], "drill": True}
    top = next(r for r in rows if r["key"] == ".|.jsonl")
    assert (top["folder"], top["files"], top["seen"], top["records_seen"], top["drill"]) == ("", 2, 1, 140, False)
    # a level of 20 files or fewer lists files: seen first, then never, then by name
    files = coverage.rows(c, SID, "agents")
    assert [r["path"] for r in files][:2] == ["agents/agent-01.jsonl", "agents/agent-02.jsonl"]
    assert files[0]["seen"] == 1 and all(r["files"] == 1 and not r["drill"] for r in files) and len(files) == 12


def test_more_than_ten_groups_keep_nine_and_other(corpus):
    c, root = corpus["c"], corpus["root"]
    for i in range(12):
        d = root / f"g{i:02d}"
        d.mkdir()
        for k in range(i + 1):
            (d / f"f{k}.jsonl").write_text("{}\n")
    _index(c, root)
    rows = coverage.rows(c, SID)
    assert len(rows) == 10 and rows[-1]["key"] == coverage.OTHER and not rows[-1]["drill"]
    assert sum(r["files"] for r in rows) == coverage.summary(c, SID)["files"]["total"]
    assert [r["files"] for r in rows[:9]] == sorted((r["files"] for r in rows[:9]), reverse=True)
    # drill into one folder of more than 20 files groups again, one level down
    for k in range(25):
        (root / "agents" / "more").mkdir(exist_ok=True)
        (root / "agents" / "more" / f"m{k}.log").write_text("x\n")
    corpus_walk.forget()
    _index(c, root)
    down = coverage.rows(c, SID, "agents")
    assert {r["key"] for r in down} == {"more|.log", ".|.jsonl"}
    assert next(r for r in down if r["key"] == "more|.log")["folder"] == "agents/more"


def test_summary_line_forms():
    assert coverage.line_of(0, 13, 0, 48_000, True) == "saw 0% of records (0 of 13 files)"
    assert coverage.line_of(1, 13, 3, 48_000, True) == "saw <1% of records (1 of 13 files)"
    assert coverage.line_of(3, 13, 1_204, 48_310, True) == "saw 2% of records (3 of 13 files)"
    assert coverage.line_of(13, 13, 48_309, 48_310, True) == "saw 99% of records (13 of 13 files)"
    assert coverage.line_of(3, 1_032_019, 0, 0, False) == "saw 3 of 1,032,019 files"
    assert coverage.line_of(3, 13, 9, 9, False) == "saw 3 of 13 files"
    assert coverage.line_of(3, 3, 0, 0, False, indexed=False) == "saw 3 files"


def test_files_only_while_counting_and_without_an_index(corpus):
    c, root = corpus["c"], corpus["root"]
    s = _facts(c, [{"path": "events.jsonl", "how": "whole"}])
    assert s["line"] == "saw 1 files" and s["counting"] is True and corpus["started"] == [c]
    # walked but not counted: files only
    conn = coverage._connect_rw(coverage.index_path(c))
    coverage.refresh(c, root, conn)
    conn.close()
    s = coverage.summary(c, SID)
    assert s["line"] == "saw 1 of 21 files" and s["counting"] is True and s["records"]["counted"] is False
    _index(c, root)
    assert coverage.summary(c, SID)["line"].startswith("saw ") and "% of records (1 of 21 files)" in \
        coverage.summary(c, SID)["line"]


async def test_state_and_act_surfaces(corpus):
    c, root = corpus["c"], corpus["root"]
    _index(c, root)
    got = await local.act(c, "coverage", {"session": SID, "turn": "u1", "facts": [
        {"path": "agents/agent-02.jsonl", "how": "whole", "by": "Read", "at": 1.0}]})
    assert got["ok"] is True and got["summary"]["files"]["seen"] == 1 and "line" in got["summary"]
    state = await local.state(c, "coverage", ["--session", SID])
    assert set(state) == {"summary", "folder", "rows", "counting"} and state["folder"] == ""
    assert set(state["summary"]) == {"files", "records", "line"}
    assert set(state["rows"][0]) == {"key", "folder", "ext", "path", "files", "seen", "searched", "never",
                                     "records_seen", "records_total", "bytes", "drill"}
    only = await local.state(c, "coverage", ["--session", SID, "--summary"])
    assert "rows" not in only
    down = await local.state(c, "coverage", ["--session", SID, "--folder", "agents"])
    assert down["folder"] == "agents" and len(down["rows"]) == 12
    with pytest.raises(local.StateError):
        await local.state(c, "coverage", ["--session", "../x"])
    with pytest.raises(local.StateError):
        await local.act(c, "coverage", {"session": SID, "facts": "no"})
    assert "coverage" in local.STATE_USAGE and "coverage" in local.ACT_USAGE


def _seed(c: str, root: Path, n_top=30, n_sub=40, per=860, extra=19) -> int:
    """An index of n_top * n_sub * per + extra files, counted, written straight into the tables."""
    for i in range(n_top):
        (root / f"f{i:02d}").mkdir(exist_ok=True)
    conn = coverage._connect_rw(coverage.index_path(c))

    def files():
        for i in range(n_top):
            for j in range(n_sub):
                folder = f"f{i:02d}/d{j:02d}"
                for k in range(per):
                    yield (f"{folder}/x{k:04d}.jsonl", folder, "jsonl", 100, 1, 10, "lines")
        for k in range(extra):
            yield (f"top{k:02d}.jsonl", "", "jsonl", 100, 1, 10, "lines")

    with conn:
        conn.executemany("INSERT INTO files (path, folder, ext, size, mtime, records, reader) VALUES (?, ?, ?, ?, ?, ?, ?)",
                         files())
        rows = []
        for i in range(n_top):
            top = f"f{i:02d}"
            rows.append((top, "jsonl", "", n_sub * per, n_sub * per * 100, n_sub * per * 10, n_sub * per))
            for j in range(n_sub):
                rows.append((f"{top}/d{j:02d}", "jsonl", top, per, per * 100, per * 10, per))
        total = n_top * n_sub * per + extra
        rows.append(("", "jsonl", None, total, total * 100, total * 10, total))
        conn.executemany("INSERT INTO totals (prefix, ext, parent, files, bytes, records, counted) VALUES (?, ?, ?, ?, ?, ?, ?)",
                         rows)
        coverage._set_meta(conn, "walked_at", time.time())
    conn.close()
    return total


async def test_a_seeded_index_of_a_million_files_answers_in_under_a_second(corpus, monkeypatch):
    c, root = corpus["c"], corpus["root"]
    total = _seed(c, root)
    assert total == 1_032_019

    def no(*a, **k):
        raise AssertionError("a request walked or counted")

    monkeypatch.setattr(corpus_walk, "walk", no)
    monkeypatch.setattr(records, "count", no)
    t0 = time.monotonic()
    got = await local.state(c, "coverage", ["--session", SID, "--summary"])
    took = time.monotonic() - t0
    assert got["summary"]["files"]["total"] == total and took < 1.0, took
    t0 = time.monotonic()
    got = await local.act(c, "coverage", {"session": SID, "turn": "u", "facts": [
        {"path": "f03", "how": "searched", "folder": True, "by": "search"},
        {"path": "f00/d00/x0001.jsonl", "how": "whole", "by": "Read"},
        {"path": "f00/d01/x0002.jsonl", "how": "part", "lines": [1, 4], "by": "Read"}]})
    took = time.monotonic() - t0
    assert took < 1.0, took
    s = got["summary"]
    assert s["files"] == {"seen": 2, "searched": 34_400, "never": total - 2 - 34_400, "total": total}
    assert s["records"] == {"seen": 14, "total": total * 10, "counted": True}
    assert s["line"] == "saw <1% of records (2 of 1,032,019 files)"
    t0 = time.monotonic()
    rows = coverage.rows(c, SID)
    assert time.monotonic() - t0 < 1.0
    assert len(rows) == 10 and rows[-1]["key"] == "other" and corpus["started"] == []


def test_the_job_starts_once_under_its_lock_with_nice_and_ionice(corpus, monkeypatch):
    c, root = corpus["c"], corpus["root"]
    monkeypatch.setattr(coverage, "start_index", REAL_START)  # the real start, but no real process
    runs: list[list[str]] = []

    class Popen:
        def __init__(self, argv, **kw):
            runs.append(argv)
            assert kw["start_new_session"] and kw["stdin"] == subprocess.DEVNULL

    monkeypatch.setattr(coverage.subprocess, "Popen", Popen)
    monkeypatch.setattr(coverage.shutil, "which", lambda name: f"/usr/bin/{name}")
    coverage._started.clear()
    assert coverage.start_index(c) is True
    assert coverage.start_index(c) is False  # once
    assert runs[0][:5] == ["nice", "-n", "19", "ionice", "-c3"]
    assert runs[0][5:] == [coverage.sys.executable, "-m", "app.coverage", "index", "--cwd", str(root)]
    monkeypatch.setattr(coverage.shutil, "which", lambda name: None)
    assert coverage.job_argv(root)[0] == coverage.sys.executable
    # a job that holds the lock: no second one starts, and a second job's body exits at once
    lock = coverage.coverage_dir(c) / coverage.LOCK
    fd = os.open(lock, os.O_RDWR | os.O_CREAT, 0o600)
    fcntl.flock(fd, fcntl.LOCK_EX)
    try:
        assert coverage.start_index(c, force=True) is False and len(runs) == 1
        assert coverage.run_job(c, root) == 1
        assert not coverage.index_path(c).exists()
    finally:
        os.close(fd)
    assert coverage.start_index(c, force=True) is True and len(runs) == 2


def test_the_job_keys_rows_by_size_and_mtime(corpus, monkeypatch):
    c, root = corpus["c"], corpus["root"]
    counted: list[str] = []
    real = records.count
    monkeypatch.setattr(records, "count", lambda path, rel, under=None: counted.append(rel) or real(path, rel, under))
    _index(c, root)
    assert len(counted) == 21
    counted.clear()
    _index(c, root)
    assert counted == []
    with open(root / "events.jsonl", "a") as f:
        f.write('{"e": 140}\n')
    corpus_walk.forget()
    _index(c, root)
    assert counted == ["events.jsonl"]
    conn = sqlite3.connect(coverage.index_path(c))
    assert conn.execute("SELECT records FROM files WHERE path = 'events.jsonl'").fetchone()[0] == 141
    assert conn.execute("SELECT records FROM totals WHERE prefix = '' AND ext = 'jsonl'").fetchone()[0] == 141 + 20 + 120
    conn.close()


def test_a_file_that_cannot_be_counted_posts_the_count_notice(corpus, monkeypatch):
    c, root = corpus["c"], corpus["root"]
    from app import notices

    def count(path, rel, under=None):
        if rel == "board.jsonl":
            raise OSError("unreadable")
        return 1

    monkeypatch.setattr(records, "count", count)
    _index(c, root)
    open_ = [n for n in notices.open_notices(c) if n.get("key") == coverage.COUNT_NOTICE]
    assert len(open_) == 1 and open_[0]["text"].startswith("thimble could not count the records of 1 files: OSError")
    assert coverage.summary(c, SID)["records"]["counted"] is True  # counted as 0, so the line has its percent


def test_the_detached_job_indexes_the_corpus(corpus, monkeypatch):
    """A real start: the detached job walks and counts, and requests read what it wrote."""
    c, root = corpus["c"], corpus["root"]
    monkeypatch.setattr(coverage, "start_index", REAL_START)
    coverage._started.clear()
    assert coverage.start_index(c) is True
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        conn = coverage._connect_ro(coverage.index_path(c))
        done = conn is not None and coverage._meta(conn, "counted_at") is not None
        if conn is not None:
            conn.close()
        if done:
            break
        time.sleep(0.2)
    else:
        pytest.fail("the job did not finish")
    lock = coverage.coverage_dir(c) / coverage.LOCK
    deadline = time.monotonic() + 10
    while not coverage._lock_free(lock) and time.monotonic() < deadline:
        time.sleep(0.1)
    s = coverage.summary(c, SID)
    assert s["files"]["total"] == 21 and s["records"]["counted"] is True
