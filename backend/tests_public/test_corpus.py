"""The corpus routes over the synthetic `mini` corpus: listing, paging, the line index, databases through /forge/*, and
refs. Corpus access is read-only and confined to the corpus folder."""
import shutil
import sqlite3
import time
from contextlib import closing
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)
MINI = "/api/corpora/mini"
AGENT = "agents/agent-01.jsonl"
ALL_TABLES = {"agents", "assignments", "comments", "events", "issue_comments", "issues", "messages", "pr_closes",
              "prs", "reports", "reviews", "threads"}


def lines(page):
    return [r["line"] for r in page["records"]]


# --------------------------------------------------------------------------- corpora, sources


def test_list_corpora():
    r = client.get("/api/corpora")
    assert r.status_code == 200
    (mini,) = [c for c in r.json() if c["name"] == "mini"]
    assert mini["manifest"]["name"] == "mini" and mini["manifest"]["n_agents"] == 3


def test_unknown_or_bad_corpus_is_404():
    assert client.get("/api/corpora/nope/sources").status_code == 404
    assert client.get("/api/corpora/%2e%2e/sources").status_code == 404
    assert client.get("/api/corpora/a%2Fb/sources").status_code == 404


def test_sources_kinds_titles_and_no_line_counts():
    r = client.get(f"{MINI}/sources")
    assert r.status_code == 200
    by_path = {s["path"]: s for s in r.json()}
    assert by_path[AGENT] == {"path": AGENT, "kind": "agent", "size_bytes": by_path[AGENT]["size_bytes"], "title": "agent-01"}
    assert (by_path["board.jsonl"]["kind"], by_path["board.jsonl"]["title"]) == ("board", "board")
    assert (by_path["events.jsonl"]["kind"], by_path["events.jsonl"]["title"]) == ("events", "events")
    assert (by_path["forge.db"]["kind"], by_path["forge.db"]["title"]) == ("forge", "forge.db")
    assert (by_path["prompts/worker.md"]["kind"], by_path["prompts/worker.md"]["title"]) == ("prompt", "worker.md")
    assert (by_path["README.md"]["kind"], by_path["README.md"]["title"]) == ("text", "README.md")
    assert by_path["manifest.json"]["kind"] == "text"
    assert {"agents/agent-01.jsonl", "agents/agent-02.jsonl", "agents/agent-03.jsonl"} <= set(by_path)
    assert all(s["size_bytes"] > 0 and "total_lines" not in s for s in by_path.values())


# --------------------------------------------------------------------------- paging


def test_source_default_page():
    r = client.get(f"{MINI}/source", params={"path": AGENT})
    assert r.status_code == 200
    page = r.json()
    assert (page["path"], page["kind"], page["total_lines"], page["start"]) == (AGENT, "agent", 20, 1)
    assert lines(page) == list(range(1, 21))
    rec = page["records"][9]
    assert set(rec) == {"line", "record", "blocks", "meta"}
    assert rec["record"]["type"] == "assistant" and rec["blocks"][0]["kind"] == "text"
    assert rec["meta"]["agent"] == "agent-01" and rec["meta"]["session_id"]
    assert page["records"][0]["record"]["type"] == "tool_progress" and page["records"][0]["blocks"][0]["kind"] == "raw"


def test_source_paging_windows_and_clamps():
    page = client.get(f"{MINI}/source", params={"path": AGENT, "start": 10, "count": 3}).json()
    assert page["start"] == 10 and lines(page) == [10, 11, 12]
    page = client.get(f"{MINI}/source", params={"path": AGENT, "start": 18, "count": 5}).json()
    assert lines(page) == [18, 19, 20]
    assert client.get(f"{MINI}/source", params={"path": AGENT, "start": 25}).json()["records"] == []
    assert client.get(f"{MINI}/source", params={"path": AGENT, "count": 1000}).status_code == 200
    page = client.get(f"{MINI}/source", params={"path": AGENT, "start": -5, "count": 2}).json()
    assert page["start"] == 1 and lines(page) == [1, 2]


def test_source_text_board_events():
    page = client.get(f"{MINI}/source", params={"path": "prompts/worker.md"}).json()
    assert page["kind"] == "prompt" and page["total_lines"] == 3
    assert page["records"][0] == {"line": 1, "record": {"text": "# Your role"}, "blocks": [{"kind": "text", "text": "# Your role"}], "meta": {}}
    assert client.get(f"{MINI}/source", params={"path": "README.md"}).json()["kind"] == "text"
    page = client.get(f"{MINI}/source", params={"path": "board.jsonl", "count": 2}).json()
    assert page["kind"] == "board" and page["total_lines"] == 8
    assert page["records"][0]["blocks"] == [{"kind": "text", "text": page["records"][0]["record"]["body"]}]
    assert page["records"][0]["meta"]["author"] == "agent-01"
    page = client.get(f"{MINI}/source", params={"path": "events.jsonl", "start": 18, "count": 1}).json()
    assert page["kind"] == "events" and page["total_lines"] == 20
    assert page["records"][0]["blocks"][0] == {"kind": "event", "text": '{"ok": true, "pr": 7160}'}
    assert page["records"][0]["meta"]["action"] == "pr.claim"


@pytest.mark.parametrize("path,status", [
    ("../../../etc/passwd", 400),
    ("/etc/passwd", 400),
    ("agents/../../mini/../../etc/hostname", 400),
    ("agents", 400),
    ("", 400),
    ("forge.db", 400),
    ("nope.jsonl", 404),
    ("agents/agent-99.jsonl", 404),
])
def test_source_path_errors(path, status):
    r = client.get(f"{MINI}/source", params={"path": path})
    assert r.status_code == status and r.json()["detail"]
    r = client.get(f"{MINI}/source/around", params={"path": path, "line": 1})
    assert r.status_code == status


def test_around():
    page = client.get(f"{MINI}/source/around", params={"path": AGENT, "line": 10, "before": 2, "after": 3}).json()
    assert page["start"] == 8 and lines(page) == [8, 9, 10, 11, 12, 13] and page["total_lines"] == 20
    page = client.get(f"{MINI}/source/around", params={"path": AGENT, "line": 1, "before": 5, "after": 1}).json()
    assert lines(page) == [1, 2]
    page = client.get(f"{MINI}/source/around", params={"path": AGENT, "line": 20, "before": 1, "after": 5}).json()
    assert lines(page) == [19, 20]
    page = client.get(f"{MINI}/source/around", params={"path": AGENT, "line": 10}).json()  # defaults 50/50
    assert lines(page) == list(range(1, 21))
    assert client.get(f"{MINI}/source/around", params={"path": AGENT, "line": 21}).status_code == 404
    assert client.get(f"{MINI}/source/around", params={"path": AGENT, "line": 0}).status_code == 404


def test_forge_tables():
    r = client.get(f"{MINI}/forge/tables")
    assert r.status_code == 200
    counts = {t["name"]: t["row_count"] for t in r.json()}
    assert set(counts) == ALL_TABLES  # sqlite_sequence is hidden
    assert counts["prs"] == 5 and counts["reviews"] == 5 and counts["assignments"] == 0


def test_forge_rows_basic_order_where_paging():
    r = client.get(f"{MINI}/forge/rows", params={"table": "prs"})
    assert r.status_code == 200
    body = r.json()
    assert body["table"] == "prs" and body["pk"] == "number" and body["columns"][0] == "number"
    assert body["total"] == 5 and len(body["rows"]) == 5 and len(body["rows"][0]) == len(body["columns"])
    body = client.get(f"{MINI}/forge/rows", params={"table": "prs", "limit": 2, "offset": 2}).json()
    assert len(body["rows"]) == 2 and body["total"] == 5
    body = client.get(f"{MINI}/forge/rows", params={"table": "prs", "order": "number desc"}).json()
    assert [row[0] for row in body["rows"]] == [7152, 7138, 7123, 7114, 7101]
    body = client.get(f"{MINI}/forge/rows", params={"table": "prs", "where": "state = 'merged'", "order": "number"}).json()
    assert body["total"] == 3 and [row[0] for row in body["rows"]] == [7114, 7123, 7152]
    body = client.get(f"{MINI}/forge/rows", params={"table": "reviews", "where": "pr IN (SELECT number FROM prs WHERE state='merged')"}).json()
    assert body["total"] == 5
    assert client.get(f"{MINI}/forge/rows", params={"table": "prs", "limit": 5000}).status_code == 200


def test_forge_rows_composite_pk_uses_rowid():
    body = client.get(f"{MINI}/forge/rows", params={"table": "pr_closes", "order": "rowid"}).json()
    assert body["pk"] == "rowid" and body["columns"] == ["rowid", "pr", "issue"]
    assert body["rows"] == [[1, 7101, 212], [2, 7114, 230]]
    assert client.get(f"{MINI}/ref", params={"ref": "forge.db#pr_closes/2"}).json()["record"]["issue"] == 230


@pytest.mark.parametrize("params,status", [
    ({"table": "prs", "where": "1=1; DROP TABLE prs"}, 400),
    ({"table": "prs", "order": "number; --"}, 400),
    ({"table": "prs", "order": "nosuchcol"}, 400),
    ({"table": "prs", "where": "nosuchcol = 1"}, 400),
    ({"table": "nope"}, 404),
    ({"table": "sqlite_master"}, 404),
])
def test_forge_rows_rejects(params, status):
    r = client.get(f"{MINI}/forge/rows", params=params)
    assert r.status_code == status and r.json()["detail"]


def test_forge_query():
    r = client.post(f"{MINI}/forge/query", json={"sql": "SELECT number, state FROM prs ORDER BY number;"})
    assert r.status_code == 200
    body = r.json()
    assert body["columns"] == ["number", "state"] and body["rows"][0] == [7101, "open"] and body["truncated"] is False
    r = client.post(f"{MINI}/forge/query", json={"sql": "WITH m AS (SELECT * FROM prs WHERE state='merged') SELECT count(*) FROM m"})
    assert r.json()["rows"] == [[3]]
    r = client.post(f"{MINI}/forge/query", json={"sql": "SELECT a.number FROM prs a, prs b, comments, events, messages, reviews"})
    assert r.json()["truncated"] is True and len(r.json()["rows"]) == 1000


@pytest.mark.parametrize("sql", [
    "SELECT 1; SELECT 2",
    "PRAGMA table_info(prs)",
    "select * from prs; pragma journal_mode",
    "ATTACH DATABASE '/tmp/x.db' AS x",
    "DELETE FROM prs",
    "UPDATE prs SET state='open'",
    "SELECT * FROM nope",
    "",
    "   ;  ",
])
def test_forge_query_rejects(sql):
    r = client.post(f"{MINI}/forge/query", json={"sql": sql})
    assert r.status_code == 400 and r.json()["detail"]


def test_forge_is_read_only():
    client.post(f"{MINI}/forge/query", json={"sql": "SELECT * FROM prs"})
    assert client.get(f"{MINI}/forge/rows", params={"table": "prs"}).json()["total"] == 5


# --------------------------------------------------------------------------- ref endpoint


def test_ref_endpoint():
    r = client.get(f"{MINI}/ref", params={"ref": f"{AGENT}#L10.b0:c0-9"})
    assert r.status_code == 200
    body = r.json()
    assert body["kind"] == "span" and body["excerpt"] == "The build" and body["ref"] == f"{AGENT}#L10.b0:c0-9"
    assert len(body["context"]["before"]) == 3
    r = client.get(f"{MINI}/ref", params={"ref": "forge.db#reviews/21"})
    assert r.status_code == 200 and r.json()["record"]["pr"] == 7114
    assert client.get(f"{MINI}/ref", params={"ref": f"{AGENT}#L99"}).status_code == 404
    assert client.get(f"{MINI}/ref", params={"ref": "card:zzzz"}).status_code == 404
    assert client.get(f"{MINI}/ref", params={"ref": "garbage ref"}).status_code == 400
    assert client.get(f"{MINI}/ref", params={"ref": "../../etc/passwd#L1"}).status_code == 400
    assert client.get("/api/corpora/nope/ref", params={"ref": f"{AGENT}#L1"}).status_code == 404


def test_forge_query_trailing_comment_and_keyword_in_literal():
    # a trailing -- comment must not swallow the LIMIT wrapper's closing paren
    r = client.post(f"{MINI}/forge/query", json={"sql": "SELECT number FROM prs -- top rows"})
    assert r.status_code == 200 and len(r.json()["rows"]) == 5
    # 'attach' / 'pragma' inside a string literal is an ordinary analyst query (only the leading keyword is refused)
    r = client.post(f"{MINI}/forge/query", json={"sql": "SELECT number FROM prs WHERE state LIKE '%attach%' OR state LIKE '%pragma%'"})
    assert r.status_code == 200 and r.json()["rows"] == []


def test_rejects_untrusted_host_header():
    # DNS rebinding defence: a page on evil.example resolving to 127.0.0.1 must not be same-origin with the API
    assert client.get("/api/corpora", headers={"Host": "evil.example:8000"}).status_code == 400
    assert client.get("/api/corpora", headers={"Host": "127.0.0.1:8000"}).status_code == 200
    assert client.get("/api/corpora", headers={"Host": "localhost:8000"}).status_code == 200


# --------------------------------------------------------------------------- nested corpora

NESTED = "/api/corpora/nested"


def test_source_kind_is_derived_from_basename_and_parent():
    from app.corpus import run_dir, source_kind, source_title

    assert source_kind("agents/agent-01.jsonl") == source_kind("run1/agents/agent-01.jsonl") == "agent"
    assert source_kind("board.jsonl") == source_kind("run1/board.jsonl") == "board"
    assert source_kind("events.jsonl") == source_kind("a/b/events.jsonl") == "events"
    assert source_kind("forge.db") == source_kind("run1/forge.db") == "forge"
    # every sqlite file is a database: the suffix decides, at any depth, whatever the basename
    for rel in ("other.db", "runs/x/ehr.db", "notes.sqlite", "a/b/c.sqlite3", "prompts/cache.db"):
        assert source_kind(rel) == "forge", rel
    for rel in ("other.db-wal", "x.dbx", "db", "forge.db.bak", "notes.sqlite.txt"):
        assert source_kind(rel) == "text", rel
    assert source_title("runs/x/ehr.db", "forge") == "ehr.db"  # the title is the file name; the kind label is "Database"
    assert source_kind("prompts/worker.md") == source_kind("run1/prompts/manager.md") == "prompt"
    for rel in ("README.md", "manifest.json", "run1/README.md", "run1/manifest.json", "agents/notes.md"):
        assert source_kind(rel) == "text", rel
    assert source_title("run1/agents/agent-01.jsonl", "agent") == "agent-01"
    assert source_title("run1/board.jsonl", "board") == "board"
    assert source_title("run1/prompts/manager.md", "prompt") == "manager.md"
    assert run_dir("run1/agents/a.jsonl") == run_dir("run1/board.jsonl") == run_dir("run1/prompts/x.md") == "run1"
    assert run_dir("agents/a.jsonl") == run_dir("board.jsonl") == run_dir("README.md") == ""


def test_dot_files_are_hidden_by_default_and_listed_on_request(nested_data):
    """The default listing leaves dot entries (such as Claude Code's own `.claude/`) out; `?include_hidden=1` lists them
    marked `hidden`, so the Files tab can count them."""
    root = nested_data / "nested"
    (root / ".claude").mkdir()
    (root / ".claude" / "t.jsonl").write_text('{"a": 1}\n')
    (root / ".env.md").write_text("dot\n")
    plain = client.get(f"{NESTED}/sources").json()
    paths = {s["path"] for s in plain}
    assert ".claude/t.jsonl" not in paths and ".env.md" not in paths and not any("hidden" in s for s in plain)
    r = client.get(f"{NESTED}/sources", params={"include_hidden": 1})
    assert r.status_code == 200
    by = {s["path"]: s for s in r.json()}
    assert by[".claude/t.jsonl"]["hidden"] is True and by[".claude/t.jsonl"]["kind"]  # a kind like any listed file's
    assert by[".env.md"]["hidden"] is True and "hidden" not in by["README.md"]
    assert len(by) == len(paths) + 2


def test_nested_sources(nested_data):
    r = client.get(f"{NESTED}/sources")
    assert r.status_code == 200
    by_path = {s["path"]: s for s in r.json()}
    assert by_path["run-a/agents/agent-01.jsonl"]["kind"] == "agent" and by_path["run-a/agents/agent-01.jsonl"]["title"] == "agent-01"
    assert by_path["run-b/board.jsonl"]["kind"] == "board" and by_path["run-b/events.jsonl"]["kind"] == "events"
    assert by_path["run-a/forge.db"]["kind"] == "forge" and by_path["run-b/prompts/worker.md"]["kind"] == "prompt"
    assert by_path["README.md"]["kind"] == by_path["manifest.json"]["kind"] == by_path["run-a/README.md"]["kind"] == "text"
    assert "run-a/forge.db-wal" not in by_path  # sqlite side files are skipped
    assert sum(1 for s in by_path.values() if s["kind"] == "agent") == 6
    # the flat corpus in the same DATA_DIR is unchanged
    assert {s["kind"] for s in client.get(f"{MINI}/sources").json()} == {"agent", "board", "events", "forge", "prompt", "text"}


def test_nested_paging_renders_by_kind(nested_data):
    page = client.get(f"{NESTED}/source", params={"path": "run-a/agents/agent-01.jsonl", "count": 10}).json()
    assert page["kind"] == "agent" and page["total_lines"] == 20
    rec = page["records"][9]
    assert rec["record"]["type"] == "assistant" and rec["blocks"][0]["kind"] == "text" and rec["blocks"][0]["text"]
    assert rec["meta"]["agent"] == "agent-01" and rec["meta"]["session_id"]
    page = client.get(f"{NESTED}/source", params={"path": "run-b/board.jsonl", "count": 1}).json()
    assert page["kind"] == "board" and page["records"][0]["blocks"] == [{"kind": "text", "text": page["records"][0]["record"]["body"]}]
    assert page["records"][0]["meta"]["author"] == "agent-01"
    page = client.get(f"{NESTED}/source", params={"path": "run-b/events.jsonl", "start": 18, "count": 1}).json()
    assert page["kind"] == "events" and page["records"][0]["blocks"][0]["kind"] == "event" and page["records"][0]["meta"]["action"] == "pr.claim"
    page = client.get(f"{NESTED}/source", params={"path": "run-a/prompts/worker.md"}).json()
    assert page["kind"] == "prompt" and page["records"][0]["record"] == {"text": "# Your role"}
    assert client.get(f"{NESTED}/source", params={"path": "run-a/README.md"}).json()["kind"] == "text"
    assert client.get(f"{NESTED}/source/around", params={"path": "run-a/agents/agent-01.jsonl", "line": 10, "before": 1, "after": 1}).json()["kind"] == "agent"
    # databases and their sqlite side files are never paged as text
    r = client.get(f"{NESTED}/source", params={"path": "run-a/forge.db"})
    assert r.status_code == 400 and "database" in r.json()["detail"] and "/forge/" in r.json()["detail"]
    r = client.get(f"{NESTED}/source", params={"path": "run-a/forge.db-wal"})
    assert r.status_code == 400 and "side file" in r.json()["detail"]


def test_nested_forge_routes_take_a_path(nested_data):
    assert client.get(f"{NESTED}/forge/tables").status_code == 404  # no root forge.db in a nested corpus
    r = client.get(f"{NESTED}/forge/tables", params={"path": "run-a/forge.db"})
    assert r.status_code == 200 and {t["name"] for t in r.json()} == ALL_TABLES
    body = client.get(f"{NESTED}/forge/rows", params={"path": "run-b/forge.db", "table": "prs", "order": "number"}).json()
    assert body["total"] == 5 and body["rows"][0][0] == 7101
    r = client.post(f"{NESTED}/forge/query", params={"path": "run-b/forge.db"}, json={"sql": "SELECT count(*) FROM prs"})
    assert r.status_code == 200 and r.json()["rows"] == [[5]]
    # path validation: escapes, non-forge files, missing runs
    assert client.get(f"{NESTED}/forge/tables", params={"path": "../mini/forge.db"}).status_code == 400
    r = client.get(f"{NESTED}/forge/tables", params={"path": "run-a/board.jsonl"})
    assert r.status_code == 400 and "database file" in r.json()["detail"]
    assert client.get(f"{NESTED}/forge/tables", params={"path": "run-z/forge.db"}).status_code == 404
    # the flat corpus keeps the default
    assert client.get(f"{MINI}/forge/tables").status_code == 200
    assert client.get(f"{MINI}/forge/rows", params={"table": "prs", "path": "forge.db"}).json()["total"] == 5


def test_nested_ref_endpoint(nested_data):
    r = client.get(f"{NESTED}/ref", params={"ref": "run-a/agents/agent-01.jsonl#L10"})
    assert r.status_code == 200 and r.json()["excerpt"].startswith("The build compiles now") and r.json()["meta"]["agent"] == "agent-01"
    r = client.get(f"{NESTED}/ref", params={"ref": "run-b/forge.db#prs/7101"})
    assert r.status_code == 200 and r.json()["path"] == "run-b/forge.db" and r.json()["record"]["number"] == 7101
    r = client.get(f"{NESTED}/ref", params={"ref": "run-b/forge.db#prs"})
    assert r.status_code == 200 and r.json()["kind"] == "table"
    r = client.get(f"{NESTED}/ref", params={"ref": "run-b/board.jsonl#L1"})
    assert r.status_code == 200 and r.json()["excerpt"] and r.json()["meta"]["author"]
    assert client.get(f"{NESTED}/ref", params={"ref": "forge.db#prs/1"}).status_code == 404
    assert client.get(f"{NESTED}/ref", params={"ref": "../mini/forge.db#prs/7101"}).status_code == 400


# --------------------------------------------------------------------------- unknown extensions / non-text bytes


@pytest.fixture()
def odd_files_data(tmp_path, monkeypatch, mini_dir):
    """A DATA_DIR whose corpus `odd` (a copy of mini) also holds files of no known kind: `notes.dat` with Latin-1 and
    control bytes, a `.csv`, and `other.db`, a database by name whose bytes (a truncated header) sqlite cannot read.
    Returns the data dir."""
    from app import config

    data = tmp_path / "data"
    shutil.copytree(mini_dir, data / "odd")
    (data / "odd" / "notes.dat").write_bytes(b"caf\xe9 au lait\n\xff\xfe\x01 bytes\r\n\x89PNG\n")
    (data / "odd" / "rows.csv").write_text("a,b\n1,2\n", encoding="utf-8")
    (data / "odd" / "other.db").write_bytes(b"SQLite format 3\x00" + b"\x00" * 16)
    monkeypatch.setattr(config, "DATA_DIR", data.resolve())
    return data


def test_unknown_extension_pages_as_text_with_replacement(odd_files_data):
    """A file of unknown extension is kind `text` and pages line by line; a line that is not UTF-8 decodes as
    Windows-1252 rather than failing, so Latin-1 text reads as written (the Reader's Raw view, the default for such
    files, shows these lines verbatim)."""
    by_path = {s["path"]: s for s in client.get("/api/corpora/odd/sources").json()}
    assert by_path["notes.dat"]["kind"] == "text" and by_path["rows.csv"]["kind"] == "text"
    r = client.get("/api/corpora/odd/source", params={"path": "notes.dat"})
    assert r.status_code == 200
    page = r.json()
    assert page["kind"] == "text" and page["total_lines"] == 3
    texts = [rec["record"]["text"] for rec in page["records"]]
    assert texts[0] == "caf\u00e9 au lait"
    assert texts[1] == "\u00ff\u00fe\x01 bytes"  # \r stripped; each byte read as Windows-1252
    assert texts[2] == "\u2030PNG"
    assert client.get("/api/corpora/odd/source/around", params={"path": "notes.dat", "line": 2}).status_code == 200
    csv = client.get("/api/corpora/odd/source", params={"path": "rows.csv"}).json()
    assert [rec["record"] for rec in csv["records"]] == [{"text": "a,b"}, {"text": "1,2"}]


def test_a_file_is_listed_whatever_its_name(odd_files_data):
    """No file name is left out of the listing; only a database's sqlite side files are."""
    (odd_files_data / "odd" / "GROUND_TRUTH.md").write_text("# notes\n")
    (odd_files_data / "odd" / "other.db-wal").write_bytes(b"")
    paths = {s["path"] for s in client.get("/api/corpora/odd/sources").json()}
    assert "GROUND_TRUTH.md" in paths and "other.db-wal" not in paths


def test_db_file_sqlite_cannot_read_is_a_clear_400(odd_files_data):
    """`other.db` is a database by name (kind 'forge') but its bytes are not a database sqlite can open: every route
    that would open it answers 400 with a message naming the file, never a traceback (a 500)."""
    lenient = TestClient(app, raise_server_exceptions=False)  # a server exception would surface here as a 500
    by_path = {s["path"]: s for s in lenient.get("/api/corpora/odd/sources").json()}
    assert by_path["other.db"]["kind"] == "forge" and by_path["other.db"]["title"] == "other.db"
    r = lenient.get("/api/corpora/odd/source", params={"path": "other.db"})
    assert r.status_code == 400 and "other.db" in r.json()["detail"] and "/forge/" in r.json()["detail"]
    for r in (lenient.get("/api/corpora/odd/forge/tables", params={"path": "other.db"}),
              lenient.get("/api/corpora/odd/forge/rows", params={"path": "other.db", "table": "t"}),
              lenient.post("/api/corpora/odd/forge/query", params={"path": "other.db"}, json={"sql": "SELECT 1"}),
              lenient.get("/api/corpora/odd/ref", params={"ref": "other.db#t/1"})):
        assert r.status_code == 400, r.text
        assert "other.db" in r.json()["detail"] and "SQLite" in r.json()["detail"]
    # the paging refusal speaks of a database file and points at the /forge/* routes, for forge.db too
    r = lenient.get("/api/corpora/odd/source", params={"path": "forge.db"})
    assert r.status_code == 400 and "/forge/" in r.json()["detail"] and "database" in r.json()["detail"]


# --------------------------------------------------------------------------- any sqlite file is a database


def make_sqlite(path: Path) -> None:
    """A small database: a table with an INTEGER pk, one with a TEXT pk and one with no pk (rows addressed by rowid)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with closing(sqlite3.connect(path)) as con:
        con.executescript(
            "CREATE TABLE patients (id INTEGER PRIMARY KEY, name TEXT, age INTEGER);"
            "INSERT INTO patients VALUES (12, 'Ada', 36), (13, 'Grace', 45), (14, 'Linus', 29);"
            "CREATE TABLE wards (code TEXT PRIMARY KEY, floor INTEGER);"
            "INSERT INTO wards VALUES ('icu-2', 2), ('ped-1', 1);"
            "CREATE TABLE visits (patient INTEGER, day TEXT);"
            "INSERT INTO visits VALUES (12, '2026-01-01'), (13, '2026-01-02');"
        )


@pytest.fixture()
def databases_data(tmp_path, monkeypatch, mini_dir):
    """A DATA_DIR whose corpus `dbs` (a copy of mini, so it has the root forge.db) also holds `runs/x/other.db` and
    `notes.sqlite3` (real databases), `runs/x/other.db-wal` (a sqlite side file) and `bad.db` (garbage bytes)."""
    from app import config

    data = tmp_path / "data"
    shutil.copytree(mini_dir, data / "dbs")
    make_sqlite(data / "dbs" / "runs" / "x" / "other.db")
    make_sqlite(data / "dbs" / "notes.sqlite3")
    (data / "dbs" / "runs" / "x" / "other.db-wal").write_bytes(b"")
    (data / "dbs" / "bad.db").write_bytes(b"not a database\n" * 8)
    monkeypatch.setattr(config, "DATA_DIR", data.resolve())
    return data


DBS = "/api/corpora/dbs"


def test_every_sqlite_file_is_a_database_source(databases_data):
    by_path = {s["path"]: s for s in client.get(f"{DBS}/sources").json()}
    for path in ("forge.db", "runs/x/other.db", "notes.sqlite3", "bad.db"):
        assert by_path[path]["kind"] == "forge" and by_path[path]["title"] == path.rsplit("/", 1)[-1], path
    assert "runs/x/other.db-wal" not in by_path
    # never paged as text; the refusal points at the /forge/* routes with the file's own path
    for path in ("forge.db", "runs/x/other.db", "notes.sqlite3"):
        r = client.get(f"{DBS}/source", params={"path": path})
        assert r.status_code == 400 and "database" in r.json()["detail"] and f"path={path}" in r.json()["detail"], path
        assert client.get(f"{DBS}/source/around", params={"path": path, "line": 1}).status_code == 400


def test_database_routes_accept_any_sqlite_path(databases_data):
    tables = {t["name"]: t["row_count"] for t in client.get(f"{DBS}/forge/tables", params={"path": "runs/x/other.db"}).json()}
    assert tables == {"patients": 3, "wards": 2, "visits": 2}
    assert {t["name"] for t in client.get(f"{DBS}/forge/tables").json()} == ALL_TABLES  # the default is still forge.db
    assert {t["name"] for t in client.get(f"{DBS}/forge/tables", params={"path": "notes.sqlite3"}).json()} == set(tables)
    body = client.get(f"{DBS}/forge/rows", params={"path": "runs/x/other.db", "table": "patients", "order": "age desc"}).json()
    assert body["pk"] == "id" and body["columns"] == ["id", "name", "age"] and [r[0] for r in body["rows"]] == [13, 12, 14]
    body = client.get(f"{DBS}/forge/rows", params={"path": "runs/x/other.db", "table": "visits"}).json()
    assert body["pk"] == "rowid" and body["rows"][0] == [1, 12, "2026-01-01"]
    assert client.get(f"{DBS}/forge/rows", params={"path": "runs/x/other.db", "table": "prs"}).status_code == 404
    r = client.post(f"{DBS}/forge/query", params={"path": "runs/x/other.db"}, json={"sql": "SELECT count(*) FROM patients"})
    assert r.status_code == 200 and r.json()["rows"] == [[3]]


def test_open_database_is_read_only_and_checks_the_header(databases_data):
    from app import corpus

    with closing(corpus.open_database(databases_data / "dbs" / "runs" / "x" / "other.db")) as con:
        with pytest.raises(sqlite3.OperationalError, match="readonly"):
            con.execute("DELETE FROM patients")
    with pytest.raises(sqlite3.DatabaseError):
        corpus.open_database(databases_data / "dbs" / "bad.db")


@pytest.mark.parametrize("path,status,needle", [
    ("../mini/forge.db", 400, "escapes"),
    ("/etc/passwd", 400, "escapes"),
    ("runs/x/../../../../etc/passwd.db", 400, "escapes"),
    ("board.jsonl", 400, "database file"),
    ("runs/x/other.db-wal", 400, "database file"),
    ("runs/y/missing.db", 404, "corpus has no"),
    ("bad.db", 400, "SQLite"),
])
def test_database_routes_path_errors(databases_data, path, status, needle):
    lenient = TestClient(app, raise_server_exceptions=False)
    for r in (lenient.get(f"{DBS}/forge/tables", params={"path": path}),
              lenient.get(f"{DBS}/forge/rows", params={"path": path, "table": "patients"}),
              lenient.post(f"{DBS}/forge/query", params={"path": path}, json={"sql": "SELECT 1"})):
        assert r.status_code == status, (path, r.text)
        assert needle in r.json()["detail"], (path, r.text)


def test_row_refs_resolve_for_every_database(databases_data):
    r = client.get(f"{DBS}/ref", params={"ref": "runs/x/other.db#patients/12"})
    assert r.status_code == 200
    body = r.json()
    assert body["kind"] == "row" and body["path"] == "runs/x/other.db" and body["record"] == {"id": 12, "name": "Ada", "age": 36}
    assert client.get(f"{DBS}/ref", params={"ref": "runs/x/other.db#wards/icu-2"}).json()["record"]["floor"] == 2
    assert client.get(f"{DBS}/ref", params={"ref": "notes.sqlite3#visits/2"}).json()["record"] == {"rowid": 2, "patient": 13, "day": "2026-01-02"}
    assert client.get(f"{DBS}/ref", params={"ref": "forge.db#prs/7101"}).json()["record"]["number"] == 7101
    assert client.get(f"{DBS}/ref", params={"ref": "runs/x/other.db#patients"}).json()["excerpt"] == "patients: 3 rows"
    assert client.get(f"{DBS}/ref", params={"ref": "runs/x/other.db#patients/99"}).status_code == 404
    assert client.get(f"{DBS}/ref", params={"ref": "runs/y/none.db#patients/1"}).status_code == 404
    lenient = TestClient(app, raise_server_exceptions=False)
    r = lenient.get(f"{DBS}/ref", params={"ref": "bad.db#t/1"})
    assert r.status_code == 400 and "SQLite" in r.json()["detail"]
    r = client.get(f"{DBS}/ref", params={"ref": "runs/x/other.db#L1.b0"})
    assert r.status_code == 400 and "database file" in r.json()["detail"] and "forge.db" not in r.json()["detail"]


# --------------------------------------------------------------------------- registration


def test_register_route_lists_and_serves_a_directory_without_a_manifest(data_tmp, tmp_path):
    import json

    from app import config, corpus

    run = tmp_path / "incident-run"
    (run / "agents").mkdir(parents=True)
    (run / "agents" / "agent-01.jsonl").write_text('{"type": "user", "text": "hi"}\n')
    (run / "notes.md").write_text("# notes\n")
    r = client.post("/api/corpora/register", json={"path": str(run)})
    assert r.status_code == 201, r.text
    rec = r.json()
    assert rec["name"] == "incident-run" and rec["manifest"] == {"name": "incident-run", "description": ""}
    assert json.loads((data_tmp / "incident-run.corpus.json").read_text()) == rec
    assert not (run / "manifest.json").exists()  # nothing written into the directory
    rows = client.get("/api/corpora").json()
    by_name = {row["name"]: row for row in rows}
    assert by_name["mini"]["manifest"]["n_agents"] == 3
    assert by_name["incident-run"]["manifest"] == rec["manifest"] and by_name["incident-run"]["registered"] is True
    assert corpus.manifest("incident-run") == rec["manifest"] and corpus.manifest("mini")["n_agents"] == 3
    assert config.corpus_dir("incident-run") == run.resolve()
    paths = {s["path"] for s in client.get("/api/corpora/incident-run/sources").json()}
    assert paths == {"agents/agent-01.jsonl", "notes.md"}
    page = client.get("/api/corpora/incident-run/source", params={"path": "agents/agent-01.jsonl"}).json()
    assert page["kind"] == "agent" and page["records"][0]["record"]["text"] == "hi"
    # idempotent, and a path inside an existing corpus is that corpus (nothing written)
    assert client.post("/api/corpora/register", json={"path": str(run / "agents")}).json()["name"] == "incident-run"
    assert client.post("/api/corpora/register", json={"path": str(data_tmp / "mini" / "agents")}).json()["name"] == "mini"
    assert sorted(p.name for p in data_tmp.glob("*.corpus.json")) == ["incident-run.corpus.json"]


def test_register_route_errors_and_free_names(data_tmp, tmp_path):
    assert client.post("/api/corpora/register", json={"path": str(tmp_path / "nope")}).status_code == 400
    # a basename a DATA_DIR corpus holds: the next free name, never a 409 and never mini's workspace
    (tmp_path / "mini").mkdir()
    r = client.post("/api/corpora/register", json={"path": str(tmp_path / "mini")})
    assert r.status_code == 201 and r.json()["name"] == "mini-2" and r.json()["path"] == str((tmp_path / "mini").resolve())
    assert client.get("/api/corpora/mini-2/sources").json() == []
    # `exact`: a folder under a registered one gets its own sidecar; without it the registered ancestor answers
    (tmp_path / "mini" / "sub").mkdir()
    assert client.post("/api/corpora/register", json={"path": str(tmp_path / "mini" / "sub")}).json()["name"] == "mini-2"
    assert client.post("/api/corpora/register", json={"path": str(tmp_path / "mini" / "sub"), "exact": True}).json()["name"] == "sub"
    assert (data_tmp / "sub.corpus.json").is_file()


def test_register_route_takes_any_folder_a_session_is_started_in(data_tmp, tmp_path, workspaces_tmp):
    """thimble never refuses a folder. The route reads nothing of it but a manifest.json (the sidecar's manifest is
    synthesized otherwise), the sources scan lists every regular file whatever its suffix at any depth and skips what it
    cannot read, and the workspace routes the UI opens answer. A folder of .json / .md / .txt / .html files, one whose
    .jsonl is three levels down, and an empty one."""
    import json
    import os

    # a folder of transcripts none of DATA_GLOBS names, with a subdirectory that cannot be read
    notes = tmp_path / "calls"
    (notes / "locked").mkdir(parents=True)
    (notes / "call-01.json").write_text(json.dumps({"turns": [{"role": "user", "text": "hi there"}]}) + "\n")
    (notes / "summary.md").write_text("# summary\n\none line\n")
    (notes / "raw.txt").write_text("plain\n")
    (notes / "export.html").write_text("<p>hi there</p>\n")
    (notes / "locked" / "hidden.txt").write_text("x\n")
    os.chmod(notes / "locked", 0)
    try:
        r = client.post("/api/corpora/register", json={"path": str(notes)})
        assert r.status_code == 201, r.text
        assert r.json()["name"] == "calls" and r.json()["manifest"] == {"name": "calls", "description": ""}
        assert (data_tmp / "calls.corpus.json").is_file()
        rows = {row["name"]: row for row in client.get("/api/corpora").json()}
        assert rows["calls"]["registered"] is True and rows["calls"]["path"] == str(notes.resolve())
        srcs = {s["path"]: s for s in client.get("/api/corpora/calls/sources").json()}
        listed = set(srcs) if os.geteuid() != 0 else set(srcs) - {"locked/hidden.txt"}  # root reads a mode-0 directory
        assert listed == {"call-01.json", "summary.md", "raw.txt", "export.html"}
        assert all(s["kind"] == "text" and s["size_bytes"] > 0 for s in srcs.values())
        for rel in ("call-01.json", "summary.md", "raw.txt", "export.html"):
            page = client.get("/api/corpora/calls/source", params={"path": rel})
            assert page.status_code == 200 and page.json()["total_lines"] >= 1 and page.json()["records"], rel
        assert client.get("/api/corpora/calls/source", params={"path": "call-01.json"}).json()["records"][0]["record"] == {
            "text": json.dumps({"turns": [{"role": "user", "text": "hi there"}]})}
        assert client.get("/api/ws/calls/settings").status_code == 200
    finally:
        os.chmod(notes / "locked", 0o755)

    # .jsonl three levels down (a sweep of runs): listed with its kind, paged as jsonl
    deep = tmp_path / "sweep"
    (deep / "batch-1" / "run-a" / "agents").mkdir(parents=True)
    (deep / "batch-1" / "run-a" / "agents" / "agent-01.jsonl").write_text('{"type": "user", "text": "deep"}\n')
    assert client.post("/api/corpora/register", json={"path": str(deep)}).status_code == 201
    assert [(s["path"], s["kind"]) for s in client.get("/api/corpora/sweep/sources").json()] == [
        ("batch-1/run-a/agents/agent-01.jsonl", "agent")]
    page = client.get("/api/corpora/sweep/source", params={"path": "batch-1/run-a/agents/agent-01.jsonl"}).json()
    assert page["kind"] == "agent" and page["records"][0]["record"]["text"] == "deep"
    assert client.get("/api/ws/sweep/settings").status_code == 200

    # an empty folder: registered and open, nothing to list
    empty = tmp_path / "nothing-yet"
    empty.mkdir()
    r = client.post("/api/corpora/register", json={"path": str(empty)})
    assert r.status_code == 201 and r.json()["manifest"] == {"name": "nothing-yet", "description": ""}
    assert client.get("/api/corpora/nothing-yet/sources").json() == []
    assert client.get("/api/ws/nothing-yet/settings").status_code == 200
    assert sorted(p.name for p in data_tmp.glob("*.corpus.json")) == ["calls.corpus.json", "nothing-yet.corpus.json", "sweep.corpus.json"]


# --------------------------------------------------------------------------- the sparse line index and the source memo


def _every_line_start(p: Path) -> list[int]:
    offsets, pos = [], 0
    with open(p, "rb") as f:
        for line in f:
            offsets.append(pos)
            pos += len(line)
    return offsets


def test_line_index_marks_equal_index_file_and_read_lines_equal_the_file(tmp_path, monkeypatch, mini_dir):
    from app import concept_scan, corpus

    monkeypatch.setattr(concept_scan, "CHUNK_LINES", 7)   # small chunks so a fixture-sized file has many
    monkeypatch.setattr(concept_scan, "CHUNK_BYTES", 900)
    corpus._INDEX.clear()
    files = [mini_dir / "board.jsonl", mini_dir / "events.jsonl", mini_dir / "README.md", mini_dir / "agents" / "agent-01.jsonl"]
    (tmp_path / "nonl.txt").write_bytes(b"one\ntwo\nthree")            # no final newline
    (tmp_path / "blank.txt").write_bytes(b"\n\n\n\n\n\n\n\n\n")           # empty lines
    (tmp_path / "long.txt").write_bytes(b"x" * 2000 + b"\nshort\r\n" + b"y" * 5000 + b"\n")  # a line past CHUNK_BYTES, a CRLF
    (tmp_path / "empty.txt").write_bytes(b"")
    files += [tmp_path / "nonl.txt", tmp_path / "blank.txt", tmp_path / "long.txt", tmp_path / "empty.txt"]
    for p in files:
        ref = concept_scan.index_file(str(p))
        idx = corpus.line_offsets(p)
        assert len(idx) == ref["lines"] == len(_every_line_start(p)), p.name
        assert list(idx.marks_list()) == [tuple(m) for m in ref["marks"]], p.name
        raw = p.read_bytes().split(b"\n")
        if raw and raw[-1] == b"":
            raw.pop()
        want = [ln[:-1] if ln.endswith(b"\r") else ln for ln in raw]
        n = len(want)
        assert corpus.read_lines(p, 1, n) == want, p.name
        for start in range(1, n + 1, 3):
            assert corpus.read_lines(p, start, start + 9) == want[start - 1:start + 9], (p.name, start)
        assert corpus.read_lines(p, 0, 2) == want[:2] and corpus.read_lines(p, n + 1, n + 5) == []
        for line_no in (1, n // 2 + 1, n):
            if n:
                assert idx.offset(p, line_no) == _every_line_start(p)[line_no - 1], (p.name, line_no)
        assert corpus.line_count(p) == n
    with pytest.raises(TypeError):
        corpus.line_offsets(files[0])[0]


def test_line_index_is_an_lru_of_files_and_bytes(tmp_path, monkeypatch):
    from app import corpus

    corpus._INDEX.clear()
    paths = []
    for i in range(6):
        p = tmp_path / f"f{i}.txt"
        p.write_text("".join(f"line {j}\n" for j in range(5)))
        paths.append(p)
    monkeypatch.setattr(corpus, "INDEX_MAX_FILES", 4)
    for p in paths:
        corpus.line_offsets(p)
    assert [q.name for q in corpus._INDEX] == ["f2.txt", "f3.txt", "f4.txt", "f5.txt"], "the two least recently used are out"
    corpus.line_offsets(paths[2])  # a hit moves to the end
    corpus.line_offsets(paths[0])  # a rebuild evicts the oldest, f3
    assert [q.name for q in corpus._INDEX] == ["f4.txt", "f5.txt", "f2.txt", "f0.txt"]
    monkeypatch.setattr(corpus, "INDEX_MAX_BYTES", corpus._INDEX[paths[0]].nbytes * 2)
    corpus.line_offsets(paths[1])
    assert len(corpus._INDEX) == 2 and paths[1] in corpus._INDEX, "the byte bound holds too"
    # a changed file is indexed again; put_source drops the index and the source memo
    paths[1].write_text("a\nb\n")
    assert len(corpus.line_offsets(paths[1])) == 2


def test_put_source_refreshes_the_index_and_the_source_list(data_tmp):
    from app import corpus

    corpus._INDEX.clear()
    corpus.forget_sources()
    before = client.get(f"{MINI}/sources").json()
    again = client.get(f"{MINI}/sources").json()
    assert again == before
    assert corpus._listing(data_tmp / "mini", False).sources is corpus._listing(data_tmp / "mini", False).sources, "one walk serves both"
    readme = data_tmp / "mini" / "README.md"
    n0 = len(corpus.line_offsets(readme))
    r = client.put(f"{MINI}/source", params={"path": "README.md"}, json={"text": "# new\n\nshorter\n"})
    assert r.status_code == 200 and r.json()["total_lines"] == 3 and n0 != 3
    assert len(corpus.line_offsets(readme)) == 3
    sizes = {s["path"]: s["size_bytes"] for s in client.get(f"{MINI}/sources").json()}
    assert sizes["README.md"] == len("# new\n\nshorter\n"), "the memo was dropped with the write"


def test_source_clip_cuts_long_strings_and_says_so(data_tmp):
    """`clip` cuts every string of a page's records and blocks past that many characters and marks the record, so a
    reader that shows long text collapsed does not fetch a very large record whole for every page; the same line
    without `clip` reads whole."""
    import json as _json

    long = "x" * 5000
    (data_tmp / "mini" / "big.jsonl").write_text(_json.dumps({"type": "user", "text": "short"}) + "\n"
                                                  + _json.dumps({"type": "assistant", "input": {"new_string": long}}) + "\n")
    page = client.get(f"{MINI}/source", params={"path": "big.jsonl", "clip": 1200}).json()
    short, big = page["records"]
    assert "clipped" not in short and short["record"]["text"] == "short"
    assert big["clipped"] >= 5000 and big["record"]["input"]["new_string"] == "x" * 1200
    assert all(len(b.get("text") or "") <= 1200 for b in big["blocks"])
    assert client.get(f"{MINI}/source", params={"path": "big.jsonl", "clip": 10}).json()["records"][1]["clipped"] >= 5000
    assert len(client.get(f"{MINI}/source", params={"path": "big.jsonl", "clip": 10}).json()["records"][1]["record"]["input"]["new_string"]) == 1000
    whole = client.get(f"{MINI}/source", params={"path": "big.jsonl", "start": 2, "count": 1}).json()["records"][0]
    assert "clipped" not in whole and whole["record"]["input"]["new_string"] == long
    around = client.get(f"{MINI}/source/around", params={"path": "big.jsonl", "line": 2, "clip": 1000}).json()
    assert around["records"][1]["clipped"] >= 5000


def test_source_memo_expires(data_tmp, monkeypatch):
    from app import corpus

    corpus.forget_sources()
    mini = data_tmp / "mini"
    first = corpus.list_sources(mini)
    assert corpus.list_sources(mini) is first
    (mini / "late.txt").write_text("late\n")
    assert corpus.list_sources(mini) is first, "inside the memo window the new file is not seen yet"
    later = time.monotonic() + corpus.SOURCES_MEMO_S + 1
    monkeypatch.setattr(corpus.time, "monotonic", lambda: later)
    assert "late.txt" in {s["path"] for s in corpus.list_sources(mini)}


def test_sources_by_folder(nested_data):
    from app import corpus

    corpus.forget_sources()
    root = client.get("/api/corpora/nested/sources", params={"path": "", "depth": 1}).json()
    assert root["path"] == "" and [f["path"] for f in root["files"]] == ["README.md", "manifest.json"]
    assert [(f["name"], f["n_files"], f["n_folders"], f["is_run"]) for f in root["folders"]] == [("run-a", 9, 2, True), ("run-b", 9, 2, True)]
    assert root["n_files"] == 20
    run = client.get("/api/corpora/nested/sources", params={"path": "run-a", "depth": 1}).json()
    assert {f["path"] for f in run["files"]} == {"run-a/README.md", "run-a/board.jsonl", "run-a/events.jsonl", "run-a/forge.db", "run-a/manifest.json"}
    assert run["files"][0]["kind"] == "text" and [f["name"] for f in run["folders"]] == ["agents", "prompts"]
    assert run["folders"][0] == {"path": "run-a/agents", "name": "agents", "n_files": 3, "n_folders": 0, "is_run": False}
    assert client.get("/api/corpora/nested/sources", params={"path": "run-a/agents/", "depth": 1}).json()["files"][0]["kind"] == "agent"
    assert client.get("/api/corpora/nested/sources", params={"path": ".", "depth": 1}).json() == root
    assert client.get("/api/corpora/nested/sources", params={"path": "nope", "depth": 1}).status_code == 404
    assert client.get("/api/corpora/nested/sources", params={"path": "run-a", "depth": 2}).status_code == 400
    assert client.get("/api/corpora/nested/sources", params={"path": "../x", "depth": 1}).status_code == 400
    # the bare route is unchanged, and hidden entries appear on request only
    (nested_data / "nested" / ".claude").mkdir()
    (nested_data / "nested" / ".claude" / "t.jsonl").write_text("{}\n")
    corpus.forget_sources()
    assert isinstance(client.get("/api/corpora/nested/sources").json(), list)
    assert not any(f["name"] == ".claude" for f in client.get("/api/corpora/nested/sources", params={"path": "", "depth": 1}).json()["folders"])
    hidden = client.get("/api/corpora/nested/sources", params={"path": "", "depth": 1, "include_hidden": 1}).json()
    assert {"path": ".claude", "name": ".claude", "n_files": 1, "n_folders": 0, "is_run": False, "hidden": True} in hidden["folders"]


def test_a_line_that_is_not_utf8_reads_as_windows_1252():
    from app import corpus

    assert corpus.decode_line("naïve ✓".encode()) == "naïve ✓"
    assert corpus.decode_line("résumé".encode("latin-1")) == "résumé"
    assert corpus.decode_line(b"\x93quoted\x94") == "“quoted”"
    assert corpus.decode_line(b"undefined \x81 byte") == "undefined \ufffd byte"
