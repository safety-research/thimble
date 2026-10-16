"""Coverage (app/coverage.py, `thimble state coverage`, `thimble act coverage`): what Claude read or searched in the
corpus in a session. Facts merge per file (whole, a part's line or page ranges, searched), facts outside the corpus or
on code files are dropped, a recursive search over a folder is one fact for every file under it, the cards' reads and
the labels' runs count as searched. Each row counts one unit: lines for line-based text, entries for a JSON document's
values and a database's rows, files for everything else (images, binaries, documents), never two units in one number.
Rows group by folder and type, siblings that share a name pattern (5 or more) by their glob, and every group is listed
(no `other`); a group drills in to its files. The totals hold the corpus's denominators per unit. An index of 1,032,019
files answers both requests in under 1 s without walking or counting. The index job starts once under its lock, under
nice and ionice, and keys its rows by size and mtime."""
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


def test_each_format_counts_lines_entries_or_files():
    """Lines for line-based text, entries for a JSON document's values and a database's rows, files for every other
    file of the universe: images, PDF, Markdown, HTML, binaries, and formats nothing counts (parquet)."""
    for ext in ("jsonl", "ndjson", "csv", "tsv", "log", "txt", "vtt", "srt"):
        assert coverage.unit_of(f"a.{ext}") == coverage.unit_of(ext) == "lines"
        assert coverage.unit_of(f"d/a.{ext.upper()}") == "lines"
    for ext in ("json", "db", "sqlite", "sqlite3"):
        assert coverage.unit_of(f"a.{ext}") == coverage.unit_of(f".{ext}") == "entries", ext
    for ext in ("png", "jpg", "pdf", "md", "html", "htm", "xml", "eml", "parquet", "arrow", "xlsx", "duckdb", "mp4",
                "wav", "bin", "tar.gz", "safetensors"):
        assert coverage.unit_of(f"a.{ext}") == "files", ext
    assert coverage.UNITS == ("lines", "entries", "files")
    assert "records" not in coverage.UNITS


def _count(root: Path, name: str) -> int:
    return coverage.count_file(root / name, name, coverage.unit_of(name))


def test_a_json_document_counts_its_entries_not_its_lines(tmp_path, monkeypatch):
    """A JSON document counts its values: the items of an array at its top, else the values of its object (the items
    of its arrays of objects where it has any, as records.py reads its records), whatever lines they take; a .json file
    of one value a line counts its values; a document too big for records.py's index is counted by a scan."""
    pretty = json.dumps([{"id": i, "tags": ["a", "b"], "text": "x"} for i in range(3)], indent=2)
    (tmp_path / "array.json").write_text(pretty)
    assert _lines(tmp_path / "array.json") > 20 and _count(tmp_path, "array.json") == 3
    (tmp_path / "object.json").write_text(json.dumps({"a": 1, "b": [1, 2, 3], "c": {"d": [{"e": 1}]}, "f": None},
                                                     indent=2))
    assert _count(tmp_path, "object.json") == 4
    chat = {"title": "t", "messages": [{"role": "user", "text": "hi"}, {"role": "assistant", "text": "yo"},
                                        {"role": "user", "text": "{[,"}]}
    (tmp_path / "chat.json").write_text(json.dumps(chat, indent=1))
    assert _count(tmp_path, "chat.json") == 3
    (tmp_path / "empty.json").write_text("[]\n")
    (tmp_path / "blank.json").write_text("")
    assert _count(tmp_path, "empty.json") == 0 and _count(tmp_path, "blank.json") == 0
    (tmp_path / "values.json").write_text('{"a": 1}\n{"a": 2}\n\n{"a": 3}\n')
    assert _count(tmp_path, "values.json") == 3
    (tmp_path / "escaped.json").write_text(json.dumps(["a \\\" ] }, b", "c", "d"]))
    assert _count(tmp_path, "escaped.json") == 3
    # the same count as the records a citation or a label names in the documents records.py indexes
    for name in ("array.json", "object.json", "chat.json", "escaped.json"):
        assert _count(tmp_path, name) == records.count(tmp_path / name, name), name
    # a document with more values than records.py indexes reads as lines there, and still counts its entries here
    monkeypatch.setattr(records, "JSON_RECORDS_MAX", 2)
    (tmp_path / "big.json").write_text(json.dumps([{"i": i} for i in range(5)], indent=2))
    assert records.count(tmp_path / "big.json", "big.json") == _lines(tmp_path / "big.json") > 5
    assert _count(tmp_path, "big.json") == 5


def test_a_database_counts_the_rows_of_its_tables_as_entries(tmp_path):
    for name in ("forge.db", "runs.sqlite", "app.sqlite3"):
        con = sqlite3.connect(tmp_path / name)
        con.execute("CREATE TABLE prs (id INTEGER PRIMARY KEY, title TEXT)")
        con.execute("CREATE TABLE notes (body TEXT)")
        con.executemany("INSERT INTO prs (title) VALUES (?)", [(f"t{i}",) for i in range(3)])
        con.executemany("INSERT INTO notes (body) VALUES (?)", [(f"n{i}",) for i in range(4)])
        con.commit()
        con.close()
        assert coverage.unit_of(name) == "entries" and _count(tmp_path, name) == 7, name


def test_line_based_files_count_their_lines(tmp_path):
    """Every line counts, a CSV's header line and each line of a quoted cell too, and a last line without its newline;
    a binary file with a text type counts none."""
    (tmp_path / "t.csv").write_text('id,body\n1,"two\nlines"\n2,x\n')
    (tmp_path / "t.tsv").write_text("a\tb\n1\t2")
    (tmp_path / "t.vtt").write_text("WEBVTT\n\n00:01.000 --> 00:02.000\nhello\n")
    (tmp_path / "t.log").write_bytes(b"\x00\x01\x02binary\n" * 3)
    assert [_count(tmp_path, n) for n in ("t.csv", "t.tsv", "t.vtt", "t.log")] == [4, 2, 4, 0]


def test_a_part_of_a_csv_counts_the_lines_read(corpus):
    c, root = corpus["c"], corpus["root"]
    _index(c, root)
    _facts(c, [{"path": "pull_requests.csv", "how": "part", "lines": [1, 3], "by": "Read"}])
    row = next(r for r in coverage.rows(c, SID) if r["name"] == "pull_requests.csv")
    assert (row["unit"], row["records_seen"], row["records_total"]) == ("lines", 3, 6)


def _head_bytes(p: Path, n: int) -> int:
    """The bytes of a file's first n lines, their newlines too."""
    return len(b"".join(p.read_bytes().splitlines(keepends=True)[:n]))


@pytest.fixture()
def no_line_index(monkeypatch):
    """The corpus's line indexes as a fresh process has them: none in memory."""
    from collections import OrderedDict

    from app import corpus as corpus_mod

    monkeypatch.setattr(corpus_mod, "_INDEX", OrderedDict())
    return corpus_mod


def test_a_part_of_a_line_file_counts_the_bytes_of_the_lines_read(corpus, no_line_index, monkeypatch):
    """The size a part of a line-based file counts: the bytes of the lines read where a line index of the file is at
    hand (in memory, or kept on disk for a big file), else the file's size times the share of its lines read. Ranges
    that overlap count once."""
    c, root = corpus["c"], corpus["root"]
    _index(c, root)
    ev = root / "events.jsonl"
    size = ev.stat().st_size
    s = _facts(c, [{"path": "events.jsonl", "how": "part", "lines": [1, 50], "total": 140, "by": "Read"},
                   {"path": "events.jsonl", "how": "part", "lines": [41, 70], "by": "Read"}])
    exact = _head_bytes(ev, 70)
    share = round(size * 70 / 140)
    assert exact != share  # the lines grow longer as they go: the two ways differ
    assert (s["size"]["read"], s["size"]["searched"]) == (share, 0)
    # a line index in memory: the bytes of lines 1-70 exactly, and of the lines of a middle part
    no_line_index.line_offsets(config.corpus_dir(c) / "events.jsonl")
    assert coverage.summary(c, SID)["size"]["read"] == exact
    board = root / "board.jsonl"
    s = _facts(c, [{"path": "board.jsonl", "how": "part", "lines": [5, 8], "total": 20, "by": "Read"}], sid="sess-b")
    assert s["size"]["read"] == round(board.stat().st_size * 4 / 20)
    no_line_index.line_offsets(config.corpus_dir(c) / "board.jsonl")
    assert coverage.summary(c, "sess-b")["size"]["read"] == _head_bytes(board, 8) - _head_bytes(board, 4)
    # a big file's index, which counting its lines kept on disk, serves a later process
    monkeypatch.setattr(no_line_index, "INDEX_BIG", 1)
    with open(ev, "a") as f:
        f.write('{"e": 140}\n')
    corpus_walk.forget()
    _index(c, root)
    no_line_index._INDEX.clear()
    assert coverage.summary(c, SID)["size"]["read"] == exact
    assert list((Path(os.environ["THIMBLE_HOME"]) / no_line_index.INDEX_DIR).glob("*.idx"))


def test_a_part_of_a_json_document_counts_the_bytes_of_the_lines_read(corpus, no_line_index):
    """A JSON document read in part counts the bytes of its lines read with a line index at hand, else its size times
    the share of its lines read (the read's own line total); its entries read stay as they were."""
    c, root = corpus["c"], corpus["root"]
    doc = root / "runs.json"
    doc.write_text(json.dumps([{"id": i, "title": "t" * i} for i in range(30)], indent=2))
    n = _lines(doc)
    _index(c, root)
    size = doc.stat().st_size
    s = _facts(c, [{"path": "runs.json", "how": "part", "lines": [1, 40], "total": n, "by": "Read"}])
    assert s["size"]["read"] == round(size * 40 / n)
    no_line_index.line_offsets(config.corpus_dir(c) / "runs.json")
    assert coverage.summary(c, SID)["size"]["read"] == _head_bytes(doc, 40) != round(size * 40 / n)
    row = next(r for r in coverage.rows(c, SID) if r["name"] == "runs.json")
    assert (row["unit"], row["records_total"], row["seen"]) == ("entries", 30, 1)


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


def test_the_total_is_the_whole_corpus_s_in_a_folder_and_a_group(corpus):
    c, root = corpus["c"], corpus["root"]
    _index(c, root)
    _facts(c, [{"path": "agents/agent-01.jsonl", "how": "whole"}, {"path": "events.jsonl", "how": "whole"}])
    top = coverage.state(c, SID)["summary"]
    assert top["size"]["total"] == _universe_bytes(root) and top["size"]["read"] > 0
    assert coverage.state(c, SID, "agents")["summary"]["size"] == top["size"]
    assert coverage.state(c, SID, "prompts", match=".md")["summary"]["size"] == top["size"]


def test_the_totals_hold_one_entry_per_unit_the_corpus_has(corpus):
    """A corpus of lines and entries only has no files line; the units come lines, entries, files."""
    c, root = corpus["c"], corpus["root"]
    for p in [root / "README.md", *(root / "prompts").iterdir()]:
        p.unlink()
    _index(c, root)
    assert [t["unit"] for t in coverage.summary(c, SID)["totals"]] == ["lines", "entries"]
    (root / "shot.png").write_bytes(b"\x89PNG")
    corpus_walk.forget()
    _index(c, root)
    assert [t["unit"] for t in coverage.summary(c, SID)["totals"]] == ["lines", "entries", "files"]


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


def test_a_document_read_in_part_counts_as_one_file_seen(corpus, monkeypatch):
    """Documents count files, not pages: a PDF read in part is one file seen, and the job counts no records of it."""
    c, root = corpus["c"], corpus["root"]
    (root / "postmortem.pdf").write_bytes(b"%PDF-1.4 not really")
    counted: list[str] = []
    real = coverage.count_file
    monkeypatch.setattr(coverage, "count_file", lambda full, rel, unit: counted.append(rel) or real(full, rel, unit))
    _index(c, root)
    assert "postmortem.pdf" not in counted and not any(r.endswith(".md") for r in counted)
    _facts(c, [{"path": "postmortem.pdf", "how": "part", "pages": [2, 5], "total": 12, "by": "Read"},
               {"path": "postmortem.pdf", "how": "part", "pages": [4, 6], "by": "Read"}])
    row = next(r for r in coverage.rows(c, SID) if r["ext"] == ".pdf")
    assert (row["unit"], row["name"], row["files"], row["seen"], row["searched"]) == ("files", "postmortem.pdf", 1, 1, 0)


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
    # in lines: agent-03's 10 lines read, the other 11 files' 110 lines searched
    assert (agents["unit"], agents["records_seen"], agents["records_searched"], agents["records_total"]) == \
        ("lines", 10, 110, 120)
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
    rows = {r["name"]: r for r in coverage.rows(c, SID)}
    assert rows["agent-*.jsonl"]["searched"] == 12
    assert rows["events.jsonl"]["searched"] == 1
    assert rows["board.jsonl"]["searched"] == 0  # read by a card made before the session was turned on


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


@pytest.fixture()
def mixed(corpus):
    """The toy corpus plus files that count as files: 30 screenshots in images/day-1/, a PDF, a video; and a database
    of 7 rows."""
    root = corpus["root"]
    (root / "images" / "day-1").mkdir(parents=True)
    for i in range(30):
        (root / "images" / "day-1" / f"{i:08x}-9529-43fe-be10-934bab47bc4f.png").write_bytes(b"\x89PNG\r\n\x1a\n" + bytes(40))
    (root / "docs").mkdir()
    (root / "docs" / "report.pdf").write_bytes(b"%PDF-1.4 not really")
    (root / "video.mp4").write_bytes(bytes(100))
    con = sqlite3.connect(root / "forge.db")
    con.execute("CREATE TABLE prs (id INTEGER PRIMARY KEY, title TEXT)")
    con.executemany("INSERT INTO prs (title) VALUES (?)", [(f"t{i}",) for i in range(7)])
    con.commit()
    con.close()
    return corpus


def test_each_row_counts_one_unit_and_the_totals_hold_each_unit(mixed):
    """Line-based files count lines, a JSON document and a database count entries, images, video and documents count
    files; one number never mixes two units. The totals hold the corpus's denominators, one entry per unit, lines then
    entries then files."""
    c, root = mixed["c"], mixed["root"]
    _index(c, root)
    png = sorted(p.name for p in (root / "images" / "day-1").iterdir())[0]
    s = _facts(c, [{"path": f"images/day-1/{png}", "how": "whole", "by": "Read"},
                   {"path": "events.jsonl", "how": "part", "lines": [1, 40], "by": "Read"},
                   {"path": "README.md", "how": "searched", "by": "search"},
                   {"path": "forge.db", "how": "searched", "by": "Bash"}])
    rows = {r["name"]: r for r in coverage.rows(c, SID)}
    img = rows[".png"]
    assert (img["folder"], img["unit"], img["files"], img["seen"], img["searched"], img["drill"]) == \
        ("images/day-1", "files", 30, 1, 0, True)
    db = rows["forge.db"]
    assert (db["unit"], db["records_total"], db["records_seen"], db["records_searched"]) == ("entries", 7, 0, 7)
    assert rows["video.mp4"]["unit"] == "files" and rows["report.pdf"]["unit"] == "files"
    assert rows["report.pdf"]["folder"] == "docs"
    assert [t["unit"] for t in s["totals"]] == ["lines", "entries", "files"]
    lines, entries, files = s["totals"]
    line_files = 12 + 3  # agents, events, board, pull_requests.csv
    rels = [p.relative_to(root).as_posix() for p in root.rglob("*") if p.is_file()]
    total = sum(_lines(root / r) for r in rels if coverage.in_universe(r, False) and coverage.unit_of(r) == "lines")
    assert total == 120 + 140 + 20 + 6
    assert lines == {"unit": "lines", "seen": 40, "searched": 0, "total": total, "counted": True,
                     "files": line_files, "files_seen": 1, "files_searched": 0}
    # forge.db's 7 rows and manifest.json's 2 values
    assert entries == {"unit": "entries", "seen": 0, "searched": 7, "total": 7 + 2, "counted": True, "files": 2,
                       "files_seen": 0, "files_searched": 1}
    assert files == {"unit": "files", "seen": 1, "searched": 1, "total": 30 + 1 + 1 + 5}
    n = line_files + 2 + 37
    assert s["files"] == {"seen": 2, "searched": 2, "never": n - 4, "total": n}
    # the line by size: the screenshot and 40 of events.jsonl's 140 lines read; README.md and forge.db searched
    ev = (root / "events.jsonl").stat().st_size
    read = (root / "images" / "day-1" / png).stat().st_size + round(ev * 40 / 140)
    searched = (root / "README.md").stat().st_size + (root / "forge.db").stat().st_size
    assert (s["size"]["read"], s["size"]["searched"]) == (read, searched)
    assert s["line"] == f"read {coverage.percent(read, s['size']['total'])} · searched " \
        f"{coverage.percent(searched, s['size']['total'])} of the data"
    # a file row of a file the index does not hold yet keeps its unit
    (root / "late.png").write_bytes(b"\x89PNG")
    _facts(c, [{"path": "late.png", "how": "whole", "by": "Read"}])
    late = next(r for r in coverage.rows(c, SID) if r["name"] == "late.png")
    assert (late["unit"], late["files"], late["seen"]) == ("files", 1, 1)


def test_name_patterns():
    assert coverage.name_pattern("agent-07.jsonl") == "agent-*.jsonl"
    assert coverage.name_pattern("run_2024_01_03.log") == "run_*.log"
    assert coverage.name_pattern("00096407-9529-43fe-be10-934bab47bc4f.png") == "*.png"
    # a uuid whose groups are letters only is still one varying part
    assert coverage.name_pattern("97420d9e-c7bb-459d-abfb-52fc95230abb.png") == "*.png"
    assert coverage.name_pattern("trace-0000000a-1a2b-4c3d-8e9f-00000000000a.json") == "trace-*.json"
    assert coverage.name_pattern("2025-04-02") == "*"
    assert coverage.name_pattern("events.jsonl") == "events.jsonl"
    assert coverage.name_pattern("notes-bad.md") == "notes-bad.md"


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


def test_the_summary_line_is_the_read_and_searched_shares_of_the_data():
    """The line under answers and in home: the read and searched shares of the corpus by size, searched only when not
    zero, a decimal under 1%; the files the facts name while there is no index."""
    size = {"read": 2_000, "searched": 0, "total": 100_000}
    assert coverage.line_of(size) == "read 2% of the data"
    assert coverage.line_of({**size, "searched": 41_000}) == "read 2% · searched 41% of the data"
    assert coverage.line_of({**size, "read": 0}) == "read 0% of the data"
    assert coverage.line_of({**size, "read": 300}) == "read 0.3% of the data"
    assert coverage.line_of({**size, "read": 30, "searched": 1}) == "read 0.03% · searched <0.01% of the data"
    assert coverage.line_of({**size, "read": 100_000}) == "read 100% of the data"
    assert coverage.line_of(None, indexed=False, seen=3) == "read 3 files"
    assert coverage.line_of(None, indexed=False, seen=1) == "read 1 file"
    assert coverage.line_of(None, indexed=False, seen=0, searched=2) == "read 0 · searched 2 files"
    # an empty corpus has no share
    assert coverage.line_of({"read": 0, "searched": 0, "total": 0}, seen=0) == "read 0 files"
    every = [coverage.line_of(size), coverage.line_of(None, indexed=False, seen=1)]
    assert not any("seen" in w or "record" in w or "lines" in w for w in every)


def _letters(n: int) -> str:
    """A name without digits for the number n (aa, ab, ...), so no two share a name pattern."""
    out = ""
    for _ in range(3):
        n, r = divmod(n, 26)
        out = "abcdefghijklmnopqrstuvwxyz"[r] + out
    return out


def test_a_top_folder_of_1000_files_of_many_kinds_lists_every_group_by_pattern_or_type(corpus, monkeypatch):
    """1,000 files of many kinds at the top: siblings that share a name pattern (5 or more) are one glob row, the rest
    one row per type (a type of one file is its file's row); no `other`; every file is in exactly one row; a group
    drills in to its files, seen ones first, and a long list says how many it leaves out."""
    c, root = corpus["c"], corpus["root"]
    made = 0

    def put(name: str, data: bytes = b"x\n") -> None:
        nonlocal made
        (root / name).write_bytes(data)
        made += 1

    for i in range(300):
        put(f"run_{i:04d}.jsonl", b'{"a": 1}\n{"a": 2}\n')
    for i in range(200):
        put(f"img_{i:04d}.png", b"\x89PNG\r\n\x1a\n" + bytes(8))
    for i in range(150):
        put(f"trace-{i:08x}-1a2b-4c3d-8e9f-{i:012x}.json", b'[{"t": 1}]')
    for i in range(100):
        put(f"notes-{_letters(i)}.md")
    for i in range(50):
        put(f"table-{_letters(i)}.csv", b"a,b\n1,2\n")
    kinds = {"txt": 60, "pdf": 40, "xml": 30, "html": 30, "wav": 20, "parquet": 18}
    for ext, n in kinds.items():
        for i in range(n):
            put(f"{ext}-{_letters(i)}.{ext}")
    put("solo.tsv", b"a\tb\n1\t2\n")
    put("lonely.mp4", bytes(10))
    assert made == 1000
    _index(c, root)
    run = "run_0250.jsonl"
    _facts(c, [{"path": run, "how": "whole", "by": "Read"}, {"path": "img_0003.png", "how": "whole", "by": "Read"}])
    t0 = time.monotonic()
    got = coverage.level(c, SID, "")
    assert time.monotonic() - t0 < 1.0
    rows = got["rows"]
    by = {r["name"]: r for r in rows if r["folder"] == ""}  # the rows of the files at the top
    assert {(r["folder"], r["name"]) for r in rows if r["folder"]} == {("agents", "agent-*.jsonl"), ("prompts", ".md")}
    assert got["more"] == 0 and all(r["key"] != "other" and "other" not in r["name"] for r in rows)
    assert sum(r["files"] for r in rows) == coverage.summary(c, SID)["files"]["total"] == 1000 + 21
    runs = by["run_*.jsonl"]
    assert (runs["unit"], runs["files"], runs["records_total"], runs["records_seen"], runs["match"], runs["drill"]) == \
        ("lines", 300, 600, 2, "run_*.jsonl", True)
    assert (by["img_*.png"]["unit"], by["img_*.png"]["files"], by["img_*.png"]["seen"]) == ("files", 200, 1)
    trace = by["trace-*.json"]
    assert (trace["files"], trace["unit"], trace["records_total"]) == (150, "entries", 150)
    # the rest by type: the toy corpus's README.md and pull_requests.csv join their type's row
    assert (by[".md"]["files"], by[".md"]["unit"], by[".md"]["match"]) == (101, "files", ".md")
    assert (by[".csv"]["files"], by[".csv"]["unit"], by[".csv"]["records_total"]) == (51, "lines", 50 * 2 + 6)
    assert {by[f".{ext}"]["unit"] for ext in ("pdf", "xml", "html", "wav", "parquet")} == {"files"}
    assert by[".txt"]["unit"] == "lines"
    assert by[".jsonl"]["files"] == 2  # events.jsonl and board.jsonl, which share no pattern with run_*.jsonl
    for ext, n in kinds.items():
        assert by[f".{ext}"]["files"] == n
    for name in ("solo.tsv", "lonely.mp4", "manifest.json"):
        assert by[name]["path"] == name and by[name]["files"] == 1 and not by[name]["drill"]
    # drill in: a type's files, then a pattern's, seen first; a list longer than LIST_MAX says how many are left out
    md = coverage.level(c, SID, "", ".md")
    assert len(md["rows"]) == 101 and md["more"] == 0 and md["match"] == ".md"
    assert all(r["path"] and r["folder"] == "" and r["unit"] == "files" for r in md["rows"])
    monkeypatch.setattr(coverage, "LIST_MAX", 100)
    down = coverage.level(c, SID, "", "run_*.jsonl")
    assert len(down["rows"]) == 100 and down["more"] == 200
    assert down["rows"][0]["path"] == run and down["rows"][0]["records_seen"] == 2
    assert [r["path"] for r in down["rows"][1:3]] == ["run_0000.jsonl", "run_0001.jsonl"]


def test_a_folder_that_holds_only_one_folder_shows_the_deeper_folder(corpus):
    """images/ holds only computer-use-turns/, which holds the days: the top row names images/computer-use-turns
    and drills in there, where each day is a row."""
    c, root = corpus["c"], corpus["root"]
    days = root / "images" / "computer-use-turns"
    for d in range(6):
        day = days / f"2025-04-0{d + 1}"
        day.mkdir(parents=True)
        for i in range(4):
            (day / f"{d:02d}{i:06x}-9529-43fe-be10-934bab47bc4f.png").write_bytes(b"\x89PNG")
    # a day of 30 screenshots right in it: one row of their type, even where a uuid's groups hold no digit
    for i in range(29):
        (days / "2025-04-01" / f"{i:08x}-1111-43fe-be10-934bab47bc4f.png").write_bytes(b"\x89PNG")
    (days / "2025-04-01" / "97420d9e-c7bb-459d-abfb-52fc95230abb.png").write_bytes(b"\x89PNG")
    (days / "2025-04-01" / "turns.json").write_text('[{"a": 1}]')
    _index(c, root)
    top = next(r for r in coverage.rows(c, SID) if r["ext"] == ".png")
    assert (top["folder"], top["name"], top["unit"], top["files"], top["drill"]) == \
        ("images/computer-use-turns", ".png", "files", 54, True)
    turns = next(r for r in coverage.rows(c, SID) if r["ext"] == ".json" and r["folder"].startswith("images"))
    assert (turns["path"], turns["name"], turns["folder"]) == \
        ("images/computer-use-turns/2025-04-01/turns.json", "turns.json", "images/computer-use-turns/2025-04-01")
    down = coverage.rows(c, SID, "images/computer-use-turns")
    assert sorted(r["folder"] for r in down if r["ext"] == ".png") == [f"images/computer-use-turns/2025-04-0{d + 1}"
                                                                       for d in range(6)]
    assert sorted(r["files"] for r in down if r["ext"] == ".png") == [4, 4, 4, 4, 4, 34]
    assert all(r["drill"] for r in down if r["ext"] == ".png")
    day = [r for r in coverage.rows(c, SID, "images/computer-use-turns/2025-04-01") if r["ext"] == ".png"]
    assert [(r["name"], r["files"], r["match"]) for r in day] == [(".png", 34, "*.png")]


def test_files_without_an_index_and_the_size_while_counting(corpus):
    c, root = corpus["c"], corpus["root"]
    s = _facts(c, [{"path": "events.jsonl", "how": "whole"}])
    assert s["line"] == "read 1 file" and s["counting"] is True and corpus["started"] == [c] and s["size"] is None
    # walked but not counted: the sizes are known, so the line has its share of the data
    conn = coverage._connect_rw(coverage.index_path(c))
    coverage.refresh(c, root, conn)
    conn.close()
    s = coverage.summary(c, SID)
    ev = (root / "events.jsonl").stat().st_size
    assert s["size"] == {"read": ev, "searched": 0, "total": _universe_bytes(root)}
    assert s["line"] == f"read {coverage.percent(ev, s['size']['total'])} of the data"
    assert s["counting"] is True and s["records"]["counted"] is False
    assert [(t["unit"], t.get("counted")) for t in s["totals"]] == \
        [("lines", False), ("entries", False), ("files", None)]
    assert s["totals"][2] == {"unit": "files", "seen": 0, "searched": 0, "total": 5}  # the .md files need no count
    _index(c, root)
    line = coverage.summary(c, SID)["line"]
    assert line.startswith("read ") and line.endswith(" of the data")


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
                    yield (f"{folder}/x{k:04d}.jsonl", folder, "jsonl", 100, 1, 10, "lines", "x*.jsonl")
        for k in range(extra):
            yield (f"top{k:02d}.jsonl", "", "jsonl", 100, 1, 10, "lines", "top*.jsonl")

    with conn:
        conn.executemany("INSERT INTO files (path, folder, ext, size, mtime, records, reader, pattern) "
                         "VALUES (?, ?, ?, ?, ?, ?, ?, ?)", files())
        rows = []
        for i in range(n_top):
            top = f"f{i:02d}"
            rows.append((top, "jsonl", "", n_sub * per, n_sub * per * 100, n_sub * per * 10, n_sub * per, "x*.jsonl"))
            for j in range(n_sub):
                rows.append((f"{top}/d{j:02d}", "jsonl", top, per, per * 100, per * 10, per, "x*.jsonl"))
        total = n_top * n_sub * per + extra
        rows.append(("", "jsonl", None, total, total * 100, total * 10, total, ""))
        conn.executemany("INSERT INTO totals (prefix, ext, parent, files, bytes, records, counted, pattern) "
                         "VALUES (?, ?, ?, ?, ?, ?, ?, ?)", rows)
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
    monkeypatch.setattr(coverage, "count_file", no)
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
    assert s["records"] == {"unit": "lines", "seen": 14, "searched": 344_000, "total": total * 10, "counted": True}
    assert s["totals"] == [{"unit": "lines", "seen": 14, "searched": 344_000, "total": total * 10, "counted": True,
                            "files": total, "files_seen": 2, "files_searched": 34_400}]
    # by size: x0001's 100 bytes and 4 of x0002's 10 lines (40 bytes) read; f03's 34,400 files of 100 bytes searched
    assert s["size"] == {"read": 140, "searched": 3_440_000, "total": total * 100}
    assert s["line"] == f"read <0.01% · searched {coverage.percent(3_440_000, total * 100)} of the data"
    t0 = time.monotonic()
    got = coverage.level(c, SID)
    assert time.monotonic() - t0 < 1.0
    rows = got["rows"]
    # 30 folders and the 19 files at the top, which share top*.jsonl: every group listed, no `other`
    assert len(rows) == 31 and all(r["key"] != "other" for r in rows) and got["more"] == 0
    assert next(r for r in rows if r["name"] == "top*.jsonl")["files"] == 19
    assert sum(r["files"] for r in rows) == total and corpus["started"] == []
    t0 = time.monotonic()
    down = coverage.level(c, SID, "f00")
    assert time.monotonic() - t0 < 1.0 and len(down["rows"]) == 40


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
    real = coverage.count_file
    monkeypatch.setattr(coverage, "count_file", lambda full, rel, unit: counted.append(rel) or real(full, rel, unit))
    _index(c, root)
    assert len(counted) == 16  # the files of lines and entries; the five .md files count as files and need no count
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


def test_a_folder_whose_listing_did_not_change_stats_only_the_files_that_hold_records(corpus, monkeypatch):
    """A refresh stats a file that counts files (an image) only when its folder's listing changed; a file that holds
    records is stat'ed every time, since lines are added to it in place."""
    c, root = corpus["c"], corpus["root"]
    (root / "images").mkdir()
    for i in range(6):
        (root / "images" / f"shot-{i}.png").write_bytes(b"\x89PNG")
    (root / "images" / "turns.jsonl").write_text('{"a": 1}\n')
    past = time.time() - 3600
    for d in [root, *[p for p in root.rglob("*") if p.is_dir()]]:
        os.utime(d, (past, past))
    _index(c, root)
    statted: list[str] = []
    real = coverage._stat
    monkeypatch.setattr(coverage, "_stat", lambda p: statted.append(os.path.relpath(p, root)) or real(p))
    corpus_walk.forget()
    _index(c, root)
    assert not any(p.endswith(".png") for p in statted) and "images/turns.jsonl" in statted
    (root / "images" / "shot-new.png").write_bytes(b"\x89PNG")
    statted.clear()
    corpus_walk.forget()
    _index(c, root)
    assert "images/shot-new.png" in statted
    assert next(r for r in coverage.rows(c, SID) if r["folder"] == "images" and r["ext"] == ".png")["files"] == 7


def test_a_file_that_cannot_be_counted_posts_the_count_notice(corpus, monkeypatch):
    c, root = corpus["c"], corpus["root"]
    from app import notices

    def count(full, rel, unit):
        if rel == "board.jsonl":
            raise OSError("unreadable")
        return 1

    monkeypatch.setattr(coverage, "count_file", count)
    _index(c, root)
    open_ = [n for n in notices.open_notices(c) if n.get("key") == coverage.COUNT_NOTICE]
    assert len(open_) == 1 and open_[0]["text"].startswith("thimble could not count the lines or entries of 1 file: "
                                                           "OSError")
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
