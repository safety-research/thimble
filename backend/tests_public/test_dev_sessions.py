"""The dev agent's sessions (dev.Sessions, dev._worker_turn): each turn of a view build, a view review's revision or a
code ticket is one `claude -p` process, the first with `--session-id`, each later one with `--resume` of the same
session, never `claude --bg`, so no folder needs Claude Code's trust. A turn copies the transcript into the chat while
the process runs and ends when it ends; Stop ends the process and whatever it started, also one a server that died left
running. A turn has no time limit: its thread says when the session shows no activity."""
from __future__ import annotations

import asyncio
import json
import subprocess
import sys
import time
import uuid
from pathlib import Path

import pytest

from app import agent_session, dev, procs, userconf

FAKE = r'''
import json, os, sys, time
argv = sys.argv[1:]
out = os.environ["FAKE_DIR"]
prompt = sys.stdin.read()
with open(os.path.join(out, "calls.jsonl"), "a") as f:
    f.write(json.dumps({"argv": argv, "stdin": prompt}) + "\n")
time.sleep(float(os.environ.get("FAKE_SLEEP") or 0))
if os.environ.get("FAKE_FAIL"):
    print(json.dumps({"type": "result", "is_error": True, "api_error_status": 529, "result": "Overloaded"}), flush=True)
    sys.exit(1)
print(json.dumps({"type": "result", "is_error": False, "result": "built: " + prompt}), flush=True)
'''


@pytest.fixture()
def cli(tmp_path, monkeypatch) -> Path:
    """The stand-in CLI as dev's `claude`; the folder it records each call into."""
    script = tmp_path / "claude"
    script.write_text(f"#!{sys.executable}\n{FAKE}")
    script.chmod(0o755)
    out = tmp_path / "calls"
    out.mkdir()
    monkeypatch.setattr(dev, "CLAUDE_BIN", str(script))
    monkeypatch.setenv("FAKE_DIR", str(out))
    monkeypatch.delenv("FAKE_SLEEP", raising=False)
    monkeypatch.delenv("FAKE_FAIL", raising=False)
    monkeypatch.setitem(userconf.DEFAULTS["sandbox"], "enforce", False)  # the stand-in has no sandbox to run in
    return out


def _calls(out: Path) -> list[dict]:
    return [json.loads(line) for line in (out / "calls.jsonl").read_text().splitlines()]


async def _settled(sessions: dev.Sessions, sid: str) -> str | None:
    for _ in range(200):
        state = await sessions.state(Path("."), sid)
        if state != "working":
            return state
        await asyncio.sleep(0.02)
    return "working"


async def test_each_turn_is_one_claude_p_process_and_a_later_turn_resumes_the_same_session(cli, tmp_path, workspaces_tmp):
    sessions = dev.Sessions()
    got = await sessions.start(tmp_path, "Build the view.", name="thimble:view-posts · mini", workspace=None)
    sid = got["session_id"]
    assert uuid.UUID(sid) and got["id"].startswith(f"{sid}/"), "each turn has an id of its own"
    assert await _settled(sessions, got["id"]) == "done" and not sessions.has_process(got["id"])
    assert sessions.result(got["id"])[0] == "built: Build the view."
    again = await sessions.resume(tmp_path, sid, "Fix what the checks found.", name="thimble:view-posts · mini",
                                  workspace=None)
    assert again["session_id"] == sid and again["id"] != got["id"]
    assert await _settled(sessions, again["id"]) == "done"
    first, second = (c["argv"] for c in _calls(cli))
    assert first[:3] == ["-p", "--session-id", sid] and "--bg" not in first and "-n" not in first
    assert second[:3] == ["-p", "--resume", sid]
    assert [c["stdin"] for c in _calls(cli)] == ["Build the view.", "Fix what the checks found."]
    settings = json.loads(first[first.index("--settings") + 1])
    assert settings["env"][agent_session.BG_WAIT_ENV] == agent_session.BG_WAIT_MS, "--print waits for its background work"
    assert await sessions.state(tmp_path, "no-such-session") is None


async def test_a_turn_that_fails_says_why(cli, tmp_path, monkeypatch):
    monkeypatch.setenv("FAKE_FAIL", "1")
    sessions = dev.Sessions()
    tid = (await sessions.start(tmp_path, "Build it.", name="x", workspace=None))["id"]
    assert await _settled(sessions, tid) == "api error"
    assert sessions.result(tid)[0] == "Overloaded"


async def test_stop_ends_the_process_and_one_a_dead_server_left_running(cli, tmp_path, monkeypatch):
    monkeypatch.setenv("FAKE_SLEEP", "60")
    sessions = dev.Sessions()
    first = await sessions.start(tmp_path, "Build it.", name="x", workspace=None)
    assert sessions.has_process(first["id"])
    pid = sessions._turns[first["id"]].proc.pid
    await asyncio.to_thread(sessions.stop, first["id"])
    assert await _settled(sessions, first["id"]) == "failed" and not procs.alive(pid)
    # a late stop of a turn that ended, as a cancelled run makes, never reaches the next turn of the same session
    second = await sessions.resume(tmp_path, first["session_id"], "Go on.", name="x", workspace=None)
    await asyncio.to_thread(sessions.stop, first["id"])
    assert sessions.has_process(second["id"])
    await asyncio.to_thread(sessions.stop, first["session_id"])  # a session's id ends each of its turns that runs
    assert await _settled(sessions, second["id"]) == "failed"

    orphan_sid = str(uuid.uuid4())  # a turn a server that died started, which this server does not know
    orphan = subprocess.Popen([dev.CLAUDE_BIN, "-p", "--session-id", orphan_sid], stdin=subprocess.PIPE,
                              start_new_session=True)
    try:
        for _ in range(50):
            if orphan_sid in procs.argv(orphan.pid):
                break
            time.sleep(0.05)
        dev.Sessions().stop(orphan_sid)
        assert orphan.wait(timeout=10) is not None
    finally:
        if orphan.poll() is None:
            orphan.kill()
