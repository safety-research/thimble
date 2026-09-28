"""export.py: GET /ws/{c}/export copies transcripts only from Claude Code's transcript roots, and never through a
symlink planted among them. The workspace is built by hand under a temp WORKSPACES_DIR over the synthetic corpus `mini`,
and Claude Code's transcripts under a temp CLAUDE_CONFIG_DIR."""
from __future__ import annotations

import io
import json
import zipfile
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import export

C = "mini"
MAIN_SID = "5f5f5f5f-0000-4000-8000-000000000002"
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
    claude = tmp_path / "claude"
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(claude))
    proj = claude / "projects" / "-tmp-mini"
    proj.mkdir(parents=True)
    write_main_session(proj)
    w = workspaces_tmp / C
    _json(w / "sessions.json", {MAIN_SID: {"session": MAIN_SID, "cwd": "/tmp/mini", "transcript_path": str(proj / f"{MAIN_SID}.jsonl"),
                                           "since": T[0], "ended": T[50], "reason": "other"}})
    return w


def _zip() -> zipfile.ZipFile:
    r = TestClient(app).get(f"/api/ws/{C}/export")
    assert r.status_code == 200, r.text
    assert r.headers["content-type"] == "application/zip"
    assert f'filename="{C}-thimble-export-' in r.headers["content-disposition"]
    return zipfile.ZipFile(io.BytesIO(r.content))


def _rows(z: zipfile.ZipFile, name: str) -> list[dict]:
    return [json.loads(x) for x in z.read(name).decode().splitlines() if x.strip()]


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
