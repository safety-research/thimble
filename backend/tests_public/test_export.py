"""export.py: GET /ws/{c}/export, one zip with every usage record of a workspace. The zip holds every stream, lists the
corpus by path, size and hash and never copies it, drops torn lines, and copies transcripts only from Claude Code's
transcript roots. The workspace is built by hand under a temp WORKSPACES_DIR over the synthetic corpus `mini`, with
rows in every stream, and Claude Code's transcripts under a temp CLAUDE_CONFIG_DIR: main's session with two threads'
forks, and an orientation session with a workflow run and a spilled tool result, all written here."""
from __future__ import annotations

import hashlib
import io
import json
import zipfile
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import canvas_history, config, dev, export, notebook

C = "mini"
MAIN_SID = "5f5f5f5f-0000-4000-8000-000000000002"
ORIENT_SID = "11111111-2222-4333-8444-555555555555"
FORK = "a1f2e3d4c5b6a7980"  # the fork of thread ef56ab12
OTHER_FORK = "a0b1c2d3e4f5a6b7c"  # the fork of a thread whose chat is gone, named by its description alone
T = [f"2026-03-12T10:{m:02d}:00+00:00" for m in range(60)]

app = FastAPI()
app.include_router(export.router, prefix="/api")


def _jsonl(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(r) + "\n" for r in rows))


def _json(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj))


def _record(kind: str, at: str, content, **extra) -> dict:
    """One transcript record in Claude Code's shape: a user or assistant message with its session and timestamp."""
    return {"type": kind, "sessionId": MAIN_SID, "timestamp": at, "uuid": f"u-{at}",
            "message": {"role": kind, "content": content}, **extra}


def write_main_session(proj: Path) -> None:
    """Main's transcript, and two threads' forks under subagents/, each with the meta Claude Code writes beside it."""
    _jsonl(proj / f"{MAIN_SID}.jsonl", [
        _record("user", "2026-03-12T09:58:00.000Z", "/thimble"),
        _record("assistant", "2026-03-12T09:58:04.000Z", [{"type": "text", "text": "thimble: http://127.0.0.1:8300/?ws=mini"}]),
        _record("user", "2026-03-12T10:03:00.000Z", "how many posts are there?"),
        _record("assistant", "2026-03-12T10:03:09.000Z", [{"type": "text", "text": "There are 8 posts."}]),
    ])
    for agent, thread in ((FORK, "ef56ab12"), (OTHER_FORK, "e1820b23")):
        sub = proj / MAIN_SID / "subagents"
        _jsonl(sub / f"agent-{agent}.jsonl", [
            {**_record("user", "2026-03-12T10:07:00.000Z", f"thread:{thread} what is this?"), "isSidechain": True,
             "agentId": agent},
            {**_record("assistant", "2026-03-12T10:07:05.000Z", [{"type": "text", "text": "A forge event."}]),
             "isSidechain": True, "agentId": agent},
        ])
        _json(sub / f"agent-{agent}.meta.json", {"agentType": "fork", "isFork": True, "description": f"thread:{thread}",
                                                  "toolUseId": f"toolu_fork_{thread}", "spawnDepth": 1,
                                                  "requestShape": "background", "model": "inherit"})


@pytest.fixture()
def ws(workspaces_tmp, tmp_path, monkeypatch):
    canvas_history.forget()
    claude = tmp_path / "claude"
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(claude))
    proj = claude / "projects" / "-tmp-mini"
    proj.mkdir(parents=True)
    write_main_session(proj)
    # the orientation's own session: a transcript still being written (its last line is torn), a workflow run, and a
    # tool result Claude Code spilled out of line
    (proj / f"{ORIENT_SID}.jsonl").write_text(
        json.dumps({"type": "user", "timestamp": T[1], "message": {"role": "user", "content": "orient"}}) + "\n"
        + json.dumps({"type": "assistant", "timestamp": T[5], "message": {"role": "assistant", "content": "done"}}) + "\n"
        + '{"type": "assistant", "timest')
    run = proj / ORIENT_SID / "subagents" / "workflows" / "wf_1"
    _jsonl(run / "journal.jsonl", [{"ts": T[2], "type": "started", "agent": "aw1"}])
    _jsonl(run / "agent-aw1.jsonl", [{"type": "user", "timestamp": T[2], "message": {"content": "read agents/"}}])
    _json(run / "agent-aw1.meta.json", {"agentType": "Explore", "description": "read the agents"})
    (proj / ORIENT_SID / "workflows" / "scripts").mkdir(parents=True)
    (proj / ORIENT_SID / "workflows" / "scripts" / "orient-wf_1.js").write_text("export default async () => {}\n")
    (proj / ORIENT_SID / "tool-results").mkdir()
    (proj / ORIENT_SID / "tool-results" / "toolu_1.txt").write_text("corpus text the model read\n")

    w = workspaces_tmp / C
    _jsonl(w / "telemetry.jsonl", [
        {"ts": T[0], "seq": 0, "boot": "b1", "actor": "analyst", "session": "p1", "kind": "page-load", "target": None},
        {"ts": T[3], "seq": 1, "boot": "b1", "actor": "analyst", "session": "p1", "kind": "ask-send", "target": "chat:main",
         "detail": {"event": "main", "chars": 12}},
    ])
    (w / "telemetry.jsonl").open("a").write('{"torn')  # a cut line is skipped
    _jsonl(w / "viewed.jsonl", [{"ts": T[4], "actor": "analyst", "by": "browser", "path": "README.md", "kind": "file"}])
    _jsonl(w / "investigations" / "main" / "events.jsonl", [
        {"ts": T[6], "seq": 0, "type": "cell", "notebook": "g1", "cell": "gone1", "kind": "deleted"},
    ])
    _json(w / "sessions.json", {MAIN_SID: {"session": MAIN_SID, "cwd": "/tmp/mini", "transcript_path": str(proj / f"{MAIN_SID}.jsonl"),
                                           "since": T[0], "ended": T[50], "reason": "other"}})
    chats = w / "chats"
    _json(chats / "main.meta.json", {"id": "main", "kind": "main", "role": "main", "title": "main", "created_at": T[0], "parent": None})
    _jsonl(chats / "main.jsonl", [{"type": "user", "ts": T[3], "text": "how many?", "by": "browser", "event": "e1"},
                                  {"type": "text", "delta": "27."}, {"type": "done", "ts": T[4]}])
    _json(chats / "ef56ab12.meta.json", {"id": "ef56ab12", "kind": "thread", "role": "thread", "title": "t", "created_at": T[7],
                                         "parent": "main", "anchor": "events.jsonl#L1", "fork": {"agent_id": FORK, "session": MAIN_SID}})
    _jsonl(chats / "ef56ab12.jsonl", [{"type": "user", "ts": T[7], "text": "what is this?", "by": "browser", "event": "e2"},
                                      {"type": "text", "delta": "A save.", "reply": True}, {"type": "done", "ts": T[8]}])
    _json(chats / "or1.meta.json", {"id": "or1", "kind": "agent", "role": "orient", "title": "Orientation", "created_at": T[1],
                                    "parent": "main", "status": "done", "session": ORIENT_SID, "ts_end": T[9]})
    # the canvas: a live group with one card and its logged history, a trashed group holding a card deleted before the log
    nb = notebook.create_notebook(config.workspace_dir(C), "Your work", role="analyst")
    card = notebook.new_cell("note", "user", "What the log covers", nb["id"], payload={"text": "One week."})
    card["edited"] = [{"by": "user", "ts": T[2]}]
    card["created_ts"] = card["ts"] = nb["ts"] = T[1]
    nb["cells"].append(card)
    notebook.write_notebook(config.workspace_dir(C), nb)
    _jsonl(w / canvas_history.LOG_NAME, [{"ts": T[10], "op": "edited", "card": card["id"], "group": nb["id"], "by": "terminal",
                                          "changed": ["takeaway"], "h": "x", "state": {"title": "What the log covers"}}])
    _json(w / "notebooks" / "trash" / "g1.json", {"id": "g1", "title": "Old", "cells": [
        {"id": "gone1", "kind": "note", "title": "A deleted card", "payload": {"text": "kept in the trash"}}]})
    # labels, views, documents, orientation
    _json(w / "concepts" / "k1.json", {"id": "k1", "name": "deletion", "unit": "record", "kind": "regex", "spec": "delete"})
    _jsonl(w / "labels" / "k1.jsonl", [{"ref": "events.jsonl#L1", "label": "yes", "confidence": 1.0, "source": "regex", "ts": T[11]}])
    (w / "labels" / "k1.sqlite").write_bytes(b"index")
    _json(w / "filters.json", {"files": {"concept": "k1", "value": "yes"}})
    _json(w / "views" / "proposals.json", [{"slug": "board", "name": "Board"}])
    _json(w / "views" / "board" / "view.json", {"slug": "board", "claims": ["board.jsonl"]})
    (w / "views" / "board" / "reader.py").write_text("def read(): pass\n")
    _json(w / "views" / "board" / "cache" / "index.json", {"rows": "from the corpus"})
    inv = w / "investigations" / "main"
    _json(inv / "report.json", {"id": "report", "generation": 2, "generated_at": T[20], "sections": [], "comments": [
        {"id": "cm1", "sentence_id": "s1", "author": "verifier", "kind": "verified", "status": "open", "generation": 2, "ts": T[20]}]})
    _json(inv / "report.frame.json", {"id": "report", "frame": True, "generation": 0})
    _json(inv / "report" / "20260312T101500.json", {"id": "report", "generation": 1, "comments": [
        {"id": "cm1", "sentence_id": "s1", "author": "verifier", "status": "open", "generation": 1, "ts": T[15]},
        {"id": "cm0", "sentence_id": "s0", "author": "analyst", "status": "dismissed", "generation": 1, "ts": T[14]}]})
    _json(inv / "versions" / "report" / "2.json", {"n": 2, "ts": T[20], "source": "button", "previous_generation": 1,
                                                   "previous": {"generation": 1, "comments": []}})
    _json(w / "orient" / "run.json", {"status": "done", "started": T[1], "ended": T[9]})
    (w / "orient" / "summary.md").write_text("The corpus is three agents.\n")
    # the checkout's dev/: this workspace's ticket, and another workspace's
    _jsonl(dev.DEV_DIR / "tickets.jsonl", [{"id": "t1", "workspace": C, "title": "zoom", "session_id": None},
                                           {"id": "t2", "workspace": "other", "title": "pan", "session_id": None}])
    return w


def _zip() -> zipfile.ZipFile:
    r = TestClient(app).get(f"/api/ws/{C}/export")
    assert r.status_code == 200, r.text
    assert r.headers["content-type"] == "application/zip"
    assert f'filename="{C}-thimble-export-' in r.headers["content-disposition"]
    return zipfile.ZipFile(io.BytesIO(r.content))


def _rows(z: zipfile.ZipFile, name: str) -> list[dict]:
    return [json.loads(x) for x in z.read(name).decode().splitlines() if x.strip()]


def test_the_zip_holds_every_stream_and_the_manifest_names_each_file(ws):
    z = _zip()
    names = set(z.namelist())
    for need in ("manifest.json", "README.md", "telemetry/ui.jsonl", "telemetry/files-opened.jsonl", "telemetry/events.jsonl",
                 "chats/index.jsonl", "chats/main.jsonl", "chats/ef56ab12.jsonl", "sessions/index.jsonl",
                 f"sessions/{MAIN_SID}.jsonl", f"sessions/{MAIN_SID}/subagents/agent-{FORK}.jsonl",
                 f"sessions/{ORIENT_SID}.jsonl", f"sessions/{ORIENT_SID}/subagents/workflows/wf_1/journal.jsonl",
                 f"sessions/{ORIENT_SID}/workflows/scripts/orient-wf_1.js", "canvas/groups.jsonl", "canvas/cards.jsonl",
                 "canvas/history.jsonl", "labels/definitions.jsonl", "labels/results.jsonl", "labels/filters.json",
                 "views/proposals.json", "views/board/view.json", "views/board/reader.py", "documents/documents.jsonl",
                 "documents/comments.jsonl", "orientation/run.json", "orientation/summary.md", "tickets.jsonl"):
        assert need in names, need
    m = json.loads(z.read("manifest.json"))
    assert m["schema"] == export.SCHEMA and m["version"] == export.VERSION and m["workspace"]["name"] == C
    listed = {f["path"]: f for f in m["files"]}
    assert set(listed) == names - {"manifest.json"}
    for name, f in listed.items():
        data = z.read(name)
        assert f["bytes"] == len(data) and f["sha256"] == hashlib.sha256(data).hexdigest(), name
    assert listed["telemetry/ui.jsonl"]["rows"] == 2  # the torn line is left out
    # the range spans every record: main's transcript starts at 09:58, the report written at T[20] is the last
    assert m["time_range"]["first"].startswith("2026-03-12T09:58") and m["time_range"]["last"].startswith(T[20][:19])


def test_the_corpus_is_listed_by_path_size_and_hash_never_copied(ws):
    z = _zip()
    m = json.loads(z.read("manifest.json"))
    corpus = config.corpus_dir(C)
    files = {f["path"]: f for f in m["corpus"]["files"]}
    assert "README.md" in files and "board.jsonl" in files
    assert files["board.jsonl"]["sha256"] == hashlib.sha256((corpus / "board.jsonl").read_bytes()).hexdigest()
    assert files["board.jsonl"]["bytes"] == (corpus / "board.jsonl").stat().st_size
    ours = {"README.md", "manifest.json"}  # the zip's own, which share their names with two corpus files
    assert not [n for n in z.namelist() if (n in files and n not in ours) or n.endswith(("board.jsonl", "forge.db"))]
    assert z.read("README.md") != (corpus / "README.md").read_bytes()
    # what was left out is named, with its size and hash
    omitted = {o["path"]: o for o in m["omitted"]}
    spill = f"sessions/{ORIENT_SID}/tool-results/toolu_1.txt"
    assert spill in omitted and spill not in z.namelist() and omitted[spill]["bytes"] == len("corpus text the model read\n")
    assert not [n for n in z.namelist() if "cache" in n or n.endswith(".sqlite")]


def test_sessions_index_joins_each_transcript_to_its_chat(ws):
    z = _zip()
    idx = _rows(z, "sessions/index.jsonl")
    main = next(r for r in idx if r["session"] == MAIN_SID and r["file"] == "session")
    assert main["role"] == "main" and main["chat"] == "main" and main["ended"] == T[50] and main["rows"] > 0
    fork = next(r for r in idx if r.get("agent_id") == FORK)
    assert fork["file"] == "subagent" and fork["chat"] == "ef56ab12" and fork["meta"]["description"] == "thread:ef56ab12"
    # a fork that no thread's meta names still names its thread through its description
    other = next(r for r in idx if r.get("agent_id") == OTHER_FORK)
    assert other["chat"] == "e1820b23"
    orient = next(r for r in idx if r["session"] == ORIENT_SID and r["file"] == "session")
    assert orient["role"] == "orient" and orient["chat"] == "or1" and orient["rows"] == 2  # the torn last line is not copied
    assert z.read(f"sessions/{ORIENT_SID}.jsonl").decode().endswith("}\n")
    wf = next(r for r in idx if r.get("agent_id") == "aw1")
    assert wf["file"] == "workflow-agent" and wf["workflow_run"] == "wf_1" and wf["meta"]["agentType"] == "Explore"
    assert next(r for r in idx if r["path"].endswith("journal.jsonl"))["file"] == "journal"


def test_a_session_started_as_a_step_is_a_session_and_a_subagent_step_is_not(tmp_path):
    own, sub = "4d1c2a0e-0000-4000-8000-000000000001", "4d1c2a0e-0000-4000-8000-000000000002"
    chats = [{"id": "st1", "kind": "agent", "role": "step", "title": "critique", "session": own},
             {"id": "st2", "kind": "agent", "role": "step", "title": "reader", "session": sub, "agent_id": "a1b2c3"}]
    recs = export.session_records(tmp_path, chats)
    assert recs[own]["role"] == "step" and recs[own]["chat"] == "st1" and sub not in recs


def test_chats_come_as_the_browser_showed_them_with_an_index(ws):
    z = _zip()
    assert z.read("chats/main.jsonl") == (ws / "chats" / "main.jsonl").read_bytes()
    idx = {r["id"]: r for r in _rows(z, "chats/index.jsonl")}
    assert idx["ef56ab12"]["fork"]["agent_id"] == FORK and idx["ef56ab12"]["records"] == 3
    assert idx["or1"]["log"] is None and idx["or1"]["session"] == ORIENT_SID


def test_canvas_history_adds_what_the_older_records_still_hold(ws):
    z = _zip()
    hist = _rows(z, "canvas/history.jsonl")
    ops = [(r["op"], r["source"]) for r in hist]
    # created (reconstructed from created_ts) and the edit in `edited` precede the log; the deletion comes from the event
    # stream with the card's content from the trash; the log's own line keeps its place in time
    assert ops == [("created", "reconstructed"), ("edited", "reconstructed"), ("deleted", "reconstructed"), ("edited", "log")]
    created = hist[0]
    assert created["state"]["title"] == "What the log covers" and created["by"] == "user" and created["state_as_of"] == "export"
    assert hist[2]["state"]["title"] == "A deleted card"
    cards = _rows(z, "canvas/cards.jsonl")
    assert {c["card"]: c["trashed"] for c in cards}["gone1"] is True
    groups = {g["id"]: g for g in _rows(z, "canvas/groups.jsonl")}
    assert groups["g1"]["trashed"] is True and "cells" not in groups["g1"]


def test_labels_documents_and_the_dev_rows(ws):
    z = _zip()
    assert _rows(z, "labels/results.jsonl") == [{"label": "k1", "ref": "events.jsonl#L1", "value": "yes", "confidence": 1.0,
                                                  "source": "regex", "ts": T[11]}]
    docs = _rows(z, "documents/documents.jsonl")
    assert sorted((d["doc"], d["state"]) for d in docs) == [("report", "archive"), ("report", "current"), ("report", "frame"),
                                                             ("report", "version")]
    assert next(d for d in docs if d["state"] == "version")["document"]["previous_generation"] == 1
    comments = {c["id"]: c for c in _rows(z, "documents/comments.jsonl")}
    assert comments["cm1"]["generation"] == 2 and comments["cm0"]["status"] == "dismissed" and comments["cm0"]["doc"] == "report"
    assert [r["id"] for r in _rows(z, "tickets.jsonl")] == ["t1"]


def test_the_readme_says_how_the_files_join_and_counts_this_export(ws):
    z = _zip()
    readme = z.read("README.md").decode()
    assert "## How the files join" in readme and "## This export" in readme
    assert "`telemetry/ui.jsonl` | 2 |" in readme
    assert readme.startswith(export.README_SOURCE.read_text("utf-8").split("\n", 1)[0])


def test_an_unknown_workspace_is_a_404_and_the_cli_writes_the_same_zip(ws, tmp_path, capsys):
    assert TestClient(app).get("/api/ws/nope/export").status_code == 404
    out = tmp_path / "x.zip"
    assert export.main([C, str(out)]) == 0
    assert "manifest.json" in zipfile.ZipFile(out).namelist()
    assert str(out) in capsys.readouterr().out


def test_a_deleted_thread_moves_to_the_trash_and_stays_in_the_export(ws):
    from app import agents

    api = FastAPI()
    api.include_router(agents.router, prefix="/api")
    assert TestClient(api).delete(f"/api/ws/{C}/chats/ef56ab12").status_code == 200
    assert not (ws / "chats" / "ef56ab12.jsonl").exists() and (ws / "chats" / "trash" / "ef56ab12.jsonl").is_file()
    assert "ef56ab12" not in [m["id"] for m in agents.list_chats(C)]
    z = _zip()
    row = next(r for r in _rows(z, "chats/index.jsonl") if r["id"] == "ef56ab12")
    assert row["trashed"] is True and row["log"] == "chats/trash/ef56ab12.jsonl" and row["records"] == 3


def test_a_transcript_path_outside_claude_code_s_transcript_roots_is_never_copied(ws, tmp_path):
    """sessions.json is a file of the workspace, which a cell can write, and the zip is meant to be shared. A
    transcript_path outside Claude Code's transcript roots, or one naming another session's file, is ignored: the
    session's transcript is looked up under the roots by its id, and a session found nowhere there is listed as not
    found."""
    private = tmp_path / "elsewhere" / "notes.jsonl"
    _jsonl(private, [{"type": "user", "message": {"content": "a file outside the transcripts"}}])
    stored = json.loads((ws / "sessions.json").read_text())
    stored[MAIN_SID]["transcript_path"] = str(private)
    stray = "22222222-3333-4444-8555-666666666666"
    stored[stray] = {"session": stray, "cwd": "/tmp/mini", "transcript_path": str(private), "since": T[1]}
    borrowed = "33333333-4444-4555-8666-777777777777"
    other = next((tmp_path / "claude" / "projects").glob(f"*/{ORIENT_SID}.jsonl"))
    stored[borrowed] = {"session": borrowed, "cwd": "/tmp/mini", "transcript_path": str(other), "since": T[2]}
    (ws / "sessions.json").write_text(json.dumps(stored))
    z = _zip()
    assert not [n for n in z.namelist() if b"a file outside the transcripts" in z.read(n)]
    idx = _rows(z, "sessions/index.jsonl")
    main = next(r for r in idx if r["session"] == MAIN_SID and r["file"] == "session")
    assert main["found"] is True and main["rows"] == 4, "found under the roots by its id"
    assert next(r for r in idx if r["session"] == stray)["found"] is False
    assert next(r for r in idx if r["session"] == borrowed)["found"] is False, "another session's transcript is not its own"


def test_a_symlink_among_the_transcripts_is_never_followed(ws, tmp_path):
    """A cell can write the workspace's own transcript root (.claude-config/projects) and plant a symlink there: neither
    the lookup by id nor a session's side folder follows one, so a file outside the transcripts never reaches the zip."""
    secret = tmp_path / "private" / "secret.jsonl"
    _jsonl(secret, [{"type": "user", "message": {"content": "a private file"}}])
    (tmp_path / "private" / "agent-a1.meta.json").write_text(json.dumps({"description": "a private meta"}))
    planted = "44444444-5555-4666-8777-888888888888"
    own = ws / ".claude-config" / "projects" / "-x"
    own.mkdir(parents=True)
    (own / f"{planted}.jsonl").symlink_to(secret)
    _json(ws / "sessions.json", {**json.loads((ws / "sessions.json").read_text()),
                                 planted: {"session": planted, "transcript_path": str(own / f"{planted}.jsonl")}})
    linked = "55555555-6666-4777-8888-999999999999"
    _jsonl(own / f"{linked}.jsonl", [{"type": "user", "message": {"content": "its own transcript"}}])
    (own / linked).symlink_to(secret.parent)  # the side folder itself
    main_side = next((tmp_path / "claude" / "projects").glob(f"*/{MAIN_SID}"))
    (main_side / "subagents" / "agent-a2.jsonl").symlink_to(secret)
    (main_side / "subagents" / f"agent-{FORK}.meta.json").unlink()
    (main_side / "subagents" / f"agent-{FORK}.meta.json").symlink_to(tmp_path / "private" / "agent-a1.meta.json")
    z = _zip()
    assert not [n for n in z.namelist() if b"a private" in z.read(n)]
    idx = _rows(z, "sessions/index.jsonl")
    assert next(r for r in idx if r["session"] == planted)["found"] is False
    assert next(r for r in idx if r["session"] == linked and r["file"] == "session")["found"] is True
    assert not [r for r in idx if r["session"] == linked and r["file"] != "session"]
