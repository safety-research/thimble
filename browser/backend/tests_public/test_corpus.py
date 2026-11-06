"""The corpus routes over the synthetic `mini` corpus: opening a folder, a citation's ref, Download and the content
search. Corpus access is read-only and confined to the corpus folder: a path or a link that leads out of it is
refused."""
import json

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)
MINI = "/api/corpora/mini"
AGENT = "agents/agent-01.jsonl"


# --------------------------------------------------------------------------- ref endpoint


def test_a_ref_opens_its_place_and_a_ref_out_of_the_corpus_is_refused():
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


# --------------------------------------------------------------------------- registration


def test_opening_a_folder_registers_it_lists_its_files_and_serves_them(data_tmp, tmp_path, plugin_headers):
    from app import config, corpus

    run = tmp_path / "incident-run"
    (run / "agents").mkdir(parents=True)
    (run / "agents" / "agent-01.jsonl").write_text('{"type": "user", "text": "hi"}\n')
    (run / "notes.md").write_text("# notes\n")
    r = client.post("/api/corpora/register", json={"path": str(run)}, headers=plugin_headers())
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
    assert client.post("/api/corpora/register", json={"path": str(run / "agents")}, headers=plugin_headers()).json()["name"] == "incident-run"
    assert client.post("/api/corpora/register", json={"path": str(data_tmp / "mini" / "agents")}, headers=plugin_headers()).json()["name"] == "mini"
    assert sorted(p.name for p in data_tmp.glob("*.corpus.json")) == ["incident-run.corpus.json"]


# --------------------------------------------------------------------------- Download


def test_download_sends_a_file_as_it_is_on_disk_and_refuses_a_path_or_a_link_out_of_the_corpus(data_tmp, tmp_path):
    """The File browser's Download (corpus.download_source): a file's bytes unchanged, larger than one chunk of the
    stream, as an attachment named as Files lists the file (a link inside the corpus by its own name). It refuses what
    the reader refuses: a folder, a path or a link that leads out of the corpus, a file that is not there."""
    mini = data_tmp / "mini"
    blob = bytes(range(256)) * 1024  # 256 KiB, four chunks of FileResponse's stream
    (mini / "data.bin").write_bytes(blob)
    (mini / "latest.jsonl").symlink_to(mini / AGENT)
    outside = tmp_path / "secret.txt"
    outside.write_text("not the corpus's\n")
    (mini / "escape.txt").symlink_to(outside)

    def get(path, **kw):
        return client.get(f"{MINI}/download/{path}", **kw)

    r = get("data.bin")
    assert r.status_code == 200 and r.content == blob
    assert r.headers["content-disposition"] == 'attachment; filename="data.bin"'
    assert r.headers["content-type"] == "application/octet-stream" and r.headers["x-content-type-options"] == "nosniff"
    r = get("latest.jsonl")
    assert r.content == (mini / AGENT).read_bytes() and r.headers["content-disposition"] == 'attachment; filename="latest.jsonl"'
    assert get("agents").status_code == 400
    assert get("..%2F..%2Fsecret.txt").status_code == 400
    assert get("escape.txt").status_code == 400
    assert get("agents/agent-99.jsonl").status_code == 404


# --------------------------------------------------------------------------- the Files search


def test_the_content_search_route_streams_its_lines_and_a_closing_line():
    r = client.get(f"{MINI}/sources/grep", params={"q": "the build"})
    lines = [json.loads(x) for x in r.text.splitlines() if x]
    assert lines[-1]["done"] is True and lines[-1]["complete"] is True
    assert any(x.get("path") == AGENT for x in lines)
    assert r.headers["x-search"].isdigit()
    assert client.get(f"{MINI}/sources/grep", params={"q": " "}).status_code == 400
