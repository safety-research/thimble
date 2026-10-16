"""Coverage (app/coverage.py, `thimble state coverage`, `thimble act coverage`): what Claude read or searched in the
corpus in a session. Facts merge per file (whole, a part's line or page ranges, searched), facts outside the corpus or
on code files are dropped, a recursive search over a folder is one fact for every file under it, the cards' reads and
the labels' runs count as searched. Each row counts one unit: lines for line-based text, entries for a JSON document's
values and a database's rows, files for everything else (images, binaries, documents), never two units in one number.
Rows group by folder and type, siblings that share a name pattern (5 or more) by their glob, and every group is listed
(no `other`); a group drills in to its files. The totals hold the corpus's denominators per unit. An index of the
earlier form is built again, and the coverage switch off keeps no fact."""
from __future__ import annotations

import json
import os
import sqlite3
import time
from pathlib import Path

import pytest

from app import config, corpus_walk, coverage, local

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


def _lines(p: Path) -> int:
    """A file's lines, as a text editor numbers them."""
    return len(p.read_bytes().splitlines())


def test_is_data_follows_the_shared_case_list():
    cases = json.loads((HERE / "fixtures" / "data_files.json").read_text())["cases"]
    wrong = [c for c in cases if coverage.is_data(c["path"], c["codeTree"]) is not c["data"]]
    assert not wrong, wrong
    assert len(cases) >= 50


def test_the_universe_and_each_file_s_unit_follow_the_shared_case_list():
    got = json.loads((HERE / "fixtures" / "data_files.json").read_text())
    cases = got["universe"]
    wrong = [c for c in cases if coverage.in_universe(c["path"], c["codeTree"]) is not c["counts"]
             or (c["counts"] and coverage.unit_of(c["path"]) != c["unit"])]
    assert not wrong, wrong
    assert len(cases) >= 40
    # every data file of the activation rule is in the universe
    assert all(coverage.in_universe(c["path"], c["codeTree"]) for c in got["cases"] if c["data"])


@pytest.fixture()
def no_line_index(monkeypatch):
    """The corpus's line indexes as a fresh process has them: none in memory."""
    from collections import OrderedDict

    from app import corpus as corpus_mod

    monkeypatch.setattr(corpus_mod, "_INDEX", OrderedDict())
    return corpus_mod


def _universe_bytes(root: Path) -> int:
    return sum(p.stat().st_size for p in root.rglob("*") if p.is_file()
               and coverage.in_universe(p.relative_to(root).as_posix(), False))


def test_the_total_measures_the_corpus_by_size(corpus, no_line_index):
    """One total for the whole corpus, by size: read, the bytes of what Claude read; searched, the bytes of what was
    searched and not read; the corpus's bytes. A file of the files unit read in part counts whole; a file read in part
    and searched counts its rest as searched; a folder searched counts every file under it."""
    c, root = corpus["c"], corpus["root"]
    (root / "postmortem.pdf").write_bytes(b"%PDF-1.4 " + bytes(500))
    _index(c, root)
    size = {p.relative_to(root).as_posix(): p.stat().st_size for p in root.rglob("*") if p.is_file()}
    s = _facts(c, [{"path": "board.jsonl", "how": "whole", "by": "Bash"},
                   {"path": "postmortem.pdf", "how": "part", "pages": [2, 3], "total": 12, "by": "Read"},
                   {"path": "pull_requests.csv", "how": "searched", "by": "search"},
                   {"path": "agents", "how": "searched", "folder": True, "by": "search"},
                   {"path": "agents/agent-03.jsonl", "how": "part", "lines": [1, 5], "total": 10, "by": "Read"}])
    part = round(size["agents/agent-03.jsonl"] * 5 / 10)
    read = size["board.jsonl"] + size["postmortem.pdf"] + part
    agents = sum(v for k, v in size.items() if k.startswith("agents/"))
    searched = size["pull_requests.csv"] + agents - part
    total = _universe_bytes(root)
    assert total == sum(v for k, v in size.items() if k != "notes.py")  # a code file is no part of it
    assert s["size"] == {"read": read, "searched": searched, "total": total}
    assert s["line"] == f"read {coverage.percent(read, total)} · searched {coverage.percent(searched, total)} of the data"
    # the rows keep their own units
    rows = {r["name"]: r for r in coverage.rows(c, SID)}
    assert (rows["agent-*.jsonl"]["unit"], rows["agent-*.jsonl"]["records_seen"]) == ("lines", 5)
    assert (rows["postmortem.pdf"]["unit"], rows["postmortem.pdf"]["seen"]) == ("files", 1)
    # nothing searched: the line leaves searched out
    s = coverage.add_facts(c, "sess-2", "t1", [{"path": "README.md", "how": "whole", "by": "Read"}])
    assert s["size"] == {"read": size["README.md"], "searched": 0, "total": total}
    assert s["line"] == f"read {coverage.percent(size['README.md'], total)} of the data"


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
    lines = s["totals"][0]
    assert lines["unit"] == "lines" and lines["counted"] is True
    assert lines["seen"] == 70 + 20 + 3
    # the lines of the line-based files: the five .md files count as files, manifest.json its entries
    total = sum(_lines(p) for p in root.rglob("*") if p.is_file()
                and coverage.in_universe(p.relative_to(root).as_posix(), False) and coverage.unit_of(p.name) == "lines")
    assert lines["total"] == total
    # searched: all 6 lines of pull_requests.csv (its header line too), and agent-01's 7 lines not read (it was
    # searched and read in part)
    assert lines["searched"] == 6 + 7
    # `records` holds the first unit's numbers, never two units added up
    assert s["records"] == {"unit": "lines", "seen": 93, "searched": 13, "total": total, "counted": True}
    # the line: the read and searched shares of the corpus by size
    size = s["size"]
    assert size["total"] == sum(p.stat().st_size for p in root.rglob("*") if p.is_file() and p.name != "notes.py")
    assert s["line"] == \
        f"read {coverage.percent(size['read'], size['total'])} · searched {coverage.percent(size['searched'], size['total'])} of the data"
    stored = coverage.read_facts(c, SID)
    assert len(stored) == 6 and all(f["turn"] == "t1" for f in stored)
    assert stored[2]["path"] == "board.jsonl"  # stored relative to the corpus


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


def test_percent_forms():
    assert coverage.percent(0, 100) == "0%"
    assert coverage.percent(5, 0) == "0%"
    assert coverage.percent(1, 3_000_000) == "<0.01%"
    assert coverage.percent(4_401, 13_200_000) == "0.03%"
    assert coverage.percent(3, 1_000) == "0.3%"
    assert coverage.percent(99, 10_000) == "0.9%" and coverage.percent(99, 100_000) == "0.09%"
    assert coverage.percent(17, 100) == "17%"
    assert coverage.percent(25, 1_000) == "3%"  # half up, as coverageview.tsx rounds
    assert coverage.percent(995, 1_000) == "99%"  # rounds to 100 but not all of it
    assert coverage.percent(1_000, 1_000) == "100%"


def test_rows_keep_the_hierarchy_and_say_where_each_file_is(corpus):
    """Folder, then type or pattern, then file: agents/ is one row (its files share agent-*.jsonl), prompts/ another
    (four .md files with no shared pattern); the five files at the top are file rows whose folder is '' (the top level,
    never `.`); a level of 20 files or fewer lists its files."""
    c, root = corpus["c"], corpus["root"]
    _index(c, root)
    _facts(c, [{"path": "agents/agent-01.jsonl", "how": "whole"}, {"path": "events.jsonl", "how": "whole"}])
    rows = coverage.rows(c, SID)
    by = {r["name"]: r for r in rows}
    assert set(by) == {"agent-*.jsonl", ".md", "events.jsonl", "board.jsonl", "pull_requests.csv", "manifest.json",
                       "README.md"}
    a = by["agent-*.jsonl"]
    assert (a["folder"], a["ext"], a["path"], a["match"], a["drill"], a["unit"]) == \
        ("agents", ".jsonl", None, None, True, "lines")
    assert (a["files"], a["seen"], a["records_seen"], a["records_searched"], a["records_total"]) == (12, 1, 10, 0, 120)
    p = by[".md"]
    assert (p["folder"], p["unit"], p["files"], p["seen"], p["drill"]) == ("prompts", "files", 4, 0, True)
    e = by["events.jsonl"]
    assert (e["folder"], e["path"], e["drill"], e["records_seen"], e["records_total"]) == \
        ("", "events.jsonl", False, 140, 140)
    assert by["README.md"]["unit"] == "files" and by["README.md"]["folder"] == ""
    assert (by["manifest.json"]["unit"], by["manifest.json"]["records_total"]) == ("entries", 2)  # its two keys
    assert all(r["folder"] != "." and r["key"] != "other" for r in rows)
    # the group of the most files first, then by size
    assert [(r["files"], r["bytes"]) for r in rows] == sorted(((r["files"], r["bytes"]) for r in rows), reverse=True)
    assert [r["name"] for r in rows[:2]] == ["agent-*.jsonl", ".md"]
    # a level of 20 files or fewer lists files: seen first, then by name
    files = coverage.rows(c, SID, "agents")
    assert [r["path"] for r in files][:2] == ["agents/agent-01.jsonl", "agents/agent-02.jsonl"]
    assert files[0]["seen"] == 1 and len(files) == 12
    assert all(r["files"] == 1 and not r["drill"] and r["folder"] == "agents" and r["name"] == r["path"].split("/")[-1]
               for r in files)


async def test_state_and_act_surfaces(corpus):
    c, root = corpus["c"], corpus["root"]
    _index(c, root)
    got = await local.act(c, "coverage", {"session": SID, "turn": "u1", "facts": [
        {"path": "agents/agent-02.jsonl", "how": "whole", "by": "Read", "at": 1.0}]})
    assert got["ok"] is True and got["summary"]["files"]["seen"] == 1 and "line" in got["summary"]
    state = await local.state(c, "coverage", ["--session", SID])
    assert set(state) == {"summary", "folder", "match", "rows", "more", "counting"} and state["folder"] == ""
    assert set(state["summary"]) == {"files", "records", "totals", "size", "line"}
    assert set(state["summary"]["size"]) == {"read", "searched", "total"}
    assert set(state["rows"][0]) == {"key", "folder", "ext", "path", "files", "seen", "searched", "never",
                                     "records_seen", "records_searched", "records_total", "bytes", "drill", "unit",
                                     "name", "match"}
    only = await local.state(c, "coverage", ["--session", SID, "--summary"])
    assert "rows" not in only
    down = await local.state(c, "coverage", ["--session", SID, "--folder", "agents"])
    assert down["folder"] == "agents" and len(down["rows"]) == 12
    group = await local.state(c, "coverage", ["--session", SID, "--folder", "prompts", "--match", ".md"])
    assert group["match"] == ".md" and len(group["rows"]) == 4
    with pytest.raises(local.StateError):
        await local.state(c, "coverage", ["--session", "../x"])
    with pytest.raises(local.StateError):
        await local.act(c, "coverage", {"session": SID, "facts": "no"})
    assert "coverage" in local.STATE_USAGE and "coverage" in local.ACT_USAGE


def test_an_index_of_the_earlier_form_is_built_again(corpus):
    """An index written before rows had units and patterns (no `pattern` column) counts as missing: a request starts
    the job, and the job builds it again."""
    c, root = corpus["c"], corpus["root"]
    p = coverage.index_path(c)
    conn = sqlite3.connect(p)
    conn.executescript("""
        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
        CREATE TABLE files (path TEXT PRIMARY KEY, folder TEXT NOT NULL, ext TEXT NOT NULL, size INTEGER NOT NULL,
            mtime INTEGER NOT NULL, records INTEGER, reader TEXT, error TEXT);
        CREATE TABLE totals (prefix TEXT NOT NULL, ext TEXT NOT NULL, parent TEXT, files INTEGER NOT NULL,
            bytes INTEGER NOT NULL, records INTEGER NOT NULL, counted INTEGER NOT NULL, PRIMARY KEY (prefix, ext));
    """)
    conn.execute("INSERT INTO meta VALUES ('walked_at', ?)", (str(time.time()),))
    conn.commit()
    conn.close()
    s = coverage.summary(c, SID)
    assert s["counting"] is True and corpus["started"] == [c]
    _index(c, root)
    s = coverage.summary(c, SID)
    assert s["files"]["total"] == 21 and s["records"]["counted"] is True
    assert {r["name"] for r in coverage.rows(c, SID)} >= {"agent-*.jsonl", ".md"}
    # an index of form 3 (CSV rows and a JSON document's lines counted as records) is built again too
    conn = sqlite3.connect(p)
    with conn:
        conn.execute("UPDATE meta SET value = '3' WHERE key = 'schema'")
        conn.execute("UPDATE files SET records = 5 WHERE path = 'pull_requests.csv'")
    conn.close()
    corpus["started"].clear()
    assert coverage.summary(c, SID)["counting"] is True and corpus["started"] == [c]
    _index(c, root)
    csv = next(r for r in coverage.rows(c, SID) if r["name"] == "pull_requests.csv")
    assert (csv["unit"], csv["records_total"]) == ("lines", 6)


def test_the_coverage_switch_off_keeps_no_fact_and_starts_no_job(corpus, monkeypatch):
    import sys
    import types

    c, root = corpus["c"], corpus["root"]
    try:
        from app import features as mod
    except ImportError:  # the core lane's features.py, or a stand-in where it is not there
        mod = types.ModuleType("app.features")
        monkeypatch.setitem(sys.modules, "app.features", mod)
        import app

        monkeypatch.setattr(app, "features", mod, raising=False)
    monkeypatch.setattr(mod, "auto", lambda c, kind: kind != "coverage", raising=False)
    monkeypatch.setattr(coverage, "start_index", REAL_START)
    runs: list = []
    monkeypatch.setattr(coverage.subprocess, "Popen", lambda argv, **kw: runs.append(argv))
    coverage._started.clear()
    _facts(c, [{"path": "events.jsonl", "how": "whole"}])
    assert coverage.read_facts(c, SID) == [] and runs == []
    assert coverage.start_index(c, force=True) is False and runs == []
