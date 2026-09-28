"""refs.py: every ref kind parses and formats back to itself (file line, range, block and span, database row and table,
card with its output line or td span, concept, report, view, and any file with a locator of its own type);
record_blocks; and resolve over the synthetic `mini` corpus, which answers an excerpt with its context or a RefError
with a 400 or 404 status, nested runs included."""
import json
import shutil

import pytest

from app import config, refs

CASES = {
    "agents/agent-03.jsonl#L412": {"kind": "record", "path": "agents/agent-03.jsonl", "line": 412},
    "agents/agent-03.jsonl#L412-L420": {"kind": "range", "path": "agents/agent-03.jsonl", "line": 412, "end_line": 420},
    "agents/agent-03.jsonl#L412.b2": {"kind": "block", "path": "agents/agent-03.jsonl", "line": 412, "block": 2},
    "agents/agent-03.jsonl#L412.b2:c10-40": {"kind": "span", "path": "agents/agent-03.jsonl", "line": 412, "block": 2,
                                             "start": 10, "end": 40},
    "board.jsonl#L17": {"kind": "record", "path": "board.jsonl", "line": 17},
    "prompts/worker.md#L3": {"kind": "record", "path": "prompts/worker.md", "line": 3},
    "forge.db#prs/4410": {"kind": "row", "path": "forge.db", "table": "prs", "pk": "4410"},
    "forge.db#agents/agent-01": {"kind": "row", "path": "forge.db", "table": "agents", "pk": "agent-01"},
    "forge.db#prs": {"kind": "table", "path": "forge.db", "table": "prs"},
    # nested corpora: (<dir>/)?forge.db#...
    "run-b/forge.db#prs/4410": {"kind": "row", "path": "run-b/forge.db",
                                                    "table": "prs", "pk": "4410"},
    "run-b/forge.db#prs": {"kind": "table", "path": "run-b/forge.db", "table": "prs"},
    "a/b/forge.db#messages/17": {"kind": "row", "path": "a/b/forge.db", "table": "messages", "pk": "17"},
    # any sqlite file is a database: <path ending in .db|.sqlite|.sqlite3>#<table>[/<pk>]
    "runs/x/ehr.db#patients/12": {"kind": "row", "path": "runs/x/ehr.db", "table": "patients", "pk": "12"},
    "runs/x/ehr.db#patients": {"kind": "table", "path": "runs/x/ehr.db", "table": "patients"},
    "notes.sqlite#wards/icu-2": {"kind": "row", "path": "notes.sqlite", "table": "wards", "pk": "icu-2"},
    "a/b/c.sqlite3#visits": {"kind": "table", "path": "a/b/c.sqlite3", "table": "visits"},
    "run-b/agents/agent-03.jsonl#L412": {"kind": "record", "path": "run-b/agents/agent-03.jsonl",
                                                            "line": 412},
    "run-b/board.jsonl#L17.b0:c1-5": {"kind": "span", "path": "run-b/board.jsonl", "line": 17,
                                                          "block": 0, "start": 1, "end": 5},
    "card:7f3a": {"kind": "cell", "cell_id": "7f3a", "exec": None},
    "card:7f3a@3": {"kind": "cell", "cell_id": "7f3a", "exec": 3},
    # td spans (cite.py): the labels are written encoded and parse decoded
    "card:7f3a#count/alpha": {"kind": "cell", "cell_id": "7f3a", "exec": None, "col": "count", "row": "alpha"},
    "card:7f3a#mean%20score/α%2Fβ": {"kind": "cell", "cell_id": "7f3a", "exec": None, "col": "mean score", "row": "α/β"},
    "card:7f3a#p%2A/x%7Ey": {"kind": "cell", "cell_id": "7f3a", "exec": None, "col": "p*", "row": "x~y"},
    "card:7f3a#a%7Cb/%5Fid": {"kind": "cell", "cell_id": "7f3a", "exec": None, "col": "a|b", "row": "_id"},
    "card:7f3a#%23items/50%25": {"kind": "cell", "cell_id": "7f3a", "exec": None, "col": "#items", "row": "50%"},
    "card:7f3a@out0#L3": {"kind": "cell", "cell_id": "7f3a", "exec": None, "out": 0, "line": 3},
    # a line range of an output: the file range form, for cards
    "card:7f3a@out1#L3-L5": {"kind": "cell", "cell_id": "7f3a", "exec": None, "out": 1, "line": 3, "end_line": 5},
    "chat:ab12#7": {"kind": "chat", "chat_id": "ab12", "event_index": 7},
    "README.md": {"kind": "path", "path": "README.md"},
    # any other part of a file, in the notation of its own type: the file with the locator kept as text
    "budget.xlsx#Q3!B2:B40": {"kind": "path", "path": "budget.xlsx", "locator": "Q3!B2:B40"},
    "papers/a.pdf#page=4": {"kind": "path", "path": "papers/a.pdf", "locator": "page=4"},
    "poster.psd#layer=Title": {"kind": "path", "path": "poster.psd", "locator": "layer=Title"},
    "notes.txt#intro#2": {"kind": "path", "path": "notes.txt", "locator": "intro#2"},
    # a view, and a unit only that view defines: the key is the view's own text
    "view:ticket-threads": {"kind": "view", "slug": "ticket-threads", "key": None},
    "view:ticket-threads/queue~BillingEscalations2031": {"kind": "view", "slug": "ticket-threads", "key": "queue~BillingEscalations2031"},
    "view:budget/Q3/row-4": {"kind": "view", "slug": "budget", "key": "Q3/row-4"},
}


# --------------------------------------------------------------------------- record_blocks


# --------------------------------------------------------------------------- resolve


@pytest.fixture()
def mini():
    return config.corpus_dir("mini")


def lines(records):
    return [r["line"] for r in records]


def test_resolve_record(mini):
    out = refs.resolve(mini, "agents/agent-01.jsonl#L10")
    assert out["kind"] == "record" and out["path"] == "agents/agent-01.jsonl" and out["line"] == 10
    assert out["record"]["type"] == "assistant"
    assert out["blocks"][0]["kind"] == "text"
    assert out["excerpt"].startswith("The build compiles now")
    assert lines(out["context"]["before"]) == [7, 8, 9]
    assert lines(out["context"]["after"]) == [11, 12, 13]
    assert set(out["context"]["before"][0]) == {"line", "record", "blocks", "meta"}
    meta = out["meta"]
    assert meta["agent"] == "agent-01" and meta["type"] == "assistant"
    assert meta["timestamp"].startswith("2026-03-12T") and meta["session_id"]


def test_resolve_cell(mini, workspaces_tmp):
    with pytest.raises(refs.RefError):
        refs.resolve(mini, "card:7f3a")
    ws = workspaces_tmp / "mini"
    ws.mkdir()
    cells = [
        {"id": "7f3a", "code": "print(1+1)", "exec_count": 2, "status": "ok", "created_by": "user", "ts": "t",
         "outputs": [{"text/plain": "2\n", "_stream": "stdout"}]},
        {"id": "img1", "code": "plt.plot()", "exec_count": 1, "status": "ok", "created_by": "chat:ab", "ts": "t",
         "outputs": [{"image/png": "iVBORw0KGgo="}]},
        {"id": "err1", "code": "1/0", "exec_count": 3, "status": "error", "created_by": "user", "ts": "t",
         "outputs": [{"application/vnd.thimble.error+json": {"ename": "ZeroDivisionError", "evalue": "division by zero",
                                                             "traceback": []}}]},
        {"id": "new1", "code": "x = 1", "exec_count": None, "status": "idle", "created_by": "user", "ts": "t", "outputs": []},
    ]
    (ws / "notebooks").mkdir()
    (ws / "notebooks" / "main.json").write_text(json.dumps({"id": "main", "title": "Notebook", "ts": "t",
                                                            "cells": [{**c, "notebook": "main"} for c in cells]}))
    out = refs.resolve(mini, "card:7f3a")
    assert out["kind"] == "cell" and out["cell_id"] == "7f3a" and out["excerpt"] == "2\n"
    assert out["record"]["code"] == "print(1+1)" and out["meta"]["exec_count"] == 2
    assert out["notebook"] == "main" and out["meta"]["notebook"] == "main" and out["record"]["notebook"] == "main"
    # cards are searched across every group of the workspace
    (ws / "notebooks" / "nb2.json").write_text(json.dumps({"id": "nb2", "title": "Notebook 2", "ts": "t", "cells": [
        {"id": "beef", "notebook": "nb2", "code": "print('two')", "exec_count": 1, "status": "ok", "created_by": "user",
         "ts": "t", "outputs": [{"text/plain": "two\n", "_stream": "stdout"}]}]}))
    out = refs.resolve(mini, "card:beef")
    assert out["notebook"] == "nb2" and out["excerpt"] == "two\n" and out["record"]["notebook"] == "nb2"
    assert refs.resolve(mini, "card:7f3a")["notebook"] == "main"
    assert "requested_exec" not in refs.resolve(mini, "card:7f3a@2")["meta"]
    assert refs.resolve(mini, "card:7f3a@1")["meta"]["requested_exec"] == 1
    assert refs.resolve(mini, "card:img1")["excerpt"] == "[image]"
    assert refs.resolve(mini, "card:err1")["excerpt"] == "ZeroDivisionError: division by zero"
    assert refs.resolve(mini, "card:new1")["excerpt"] == "x = 1"
    with pytest.raises(refs.RefError) as e:
        refs.resolve(mini, "card:nope")
    assert e.value.status == 404


# --------------------------------------------------------------------------- nested corpora


@pytest.fixture()
def databases(tmp_path, monkeypatch, mini_dir):
    """Corpus `dbs`: a copy of mini (so it has the root forge.db) plus `runs/x/other.db` (a real database) and
    `bad.db` (garbage bytes). Returns the corpus dir."""
    import sqlite3
    from contextlib import closing

    data = tmp_path / "data"
    shutil.copytree(mini_dir, data / "dbs")
    other = data / "dbs" / "runs" / "x" / "other.db"
    other.parent.mkdir(parents=True)
    with closing(sqlite3.connect(other)) as con:
        con.executescript("CREATE TABLE patients (id INTEGER PRIMARY KEY, name TEXT);"
                          "INSERT INTO patients VALUES (12, 'Ada'), (13, 'Grace');"
                          "CREATE TABLE visits (patient INTEGER, day TEXT); INSERT INTO visits VALUES (12, '2026-01-01');")
    (data / "dbs" / "bad.db").write_bytes(b"not a database\n" * 8)
    monkeypatch.setattr(config, "DATA_DIR", data.resolve())
    return config.corpus_dir("dbs")
