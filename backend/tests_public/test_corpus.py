"""The corpus routes over the synthetic `mini` corpus: registering a folder, refs, databases and the Host check. Corpus
access is read-only and confined to the corpus folder."""
import shutil
import sqlite3
from contextlib import closing
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)
MINI = "/api/corpora/mini"
AGENT = "agents/agent-01.jsonl"


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


def test_rejects_untrusted_host_header():
    # DNS rebinding defence: a page on evil.example resolving to 127.0.0.1 must not be same-origin with the API
    assert client.get("/api/corpora", headers={"Host": "evil.example:8000"}).status_code == 400
    assert client.get("/api/corpora", headers={"Host": "127.0.0.1:8000"}).status_code == 200
    assert client.get("/api/corpora", headers={"Host": "localhost:8000"}).status_code == 200


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


def test_open_database_is_read_only_and_checks_the_header(databases_data):
    from app import corpus

    with closing(corpus.open_database(databases_data / "dbs" / "runs" / "x" / "other.db")) as con:
        with pytest.raises(sqlite3.OperationalError, match="readonly"):
            con.execute("DELETE FROM patients")
    with pytest.raises(sqlite3.DatabaseError):
        corpus.open_database(databases_data / "dbs" / "bad.db")


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


def test_a_file_read_counts_as_the_analysts_view_only_with_the_analysts_cookie(monkeypatch):
    """The view log (viewlog), which the telemetry export merges, records the browser's reads of a file. Card code
    reads through the same routes without the analyst's cookie (hook_auth.analyst), so its reads are not recorded."""
    from conftest import UI_KEY, _record

    from app import hook_auth, viewlog

    monkeypatch.setattr(viewlog, "_recent", {})
    _record(ui_key=UI_KEY)
    c = TestClient(app)
    assert c.get("/api/corpora/mini/source", params={"path": "agents/agent-01.jsonl"}).status_code == 200
    assert viewlog.rows("mini") == []
    c.cookies.set(hook_auth.ui_cookie(), UI_KEY)
    assert c.get("/api/corpora/mini/source", params={"path": "agents/agent-01.jsonl"}).status_code == 200
    assert [(r["actor"], r["path"]) for r in viewlog.rows("mini")] == [("analyst", "agents/agent-01.jsonl")]
