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

CORPUS = "mini"

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


class _Sessions:
    """dev.SESSIONS as a fake: one session whose turn's state is `now`, whose looks at it are counted."""

    def __init__(self, transcript: Path) -> None:
        self.path, self.now, self.looks, self.stops = transcript, "working", 0, []
        self.said = ("", "")

    async def start(self, cwd, prompt, **kw):
        return {"id": "ab12cd34-0000", "session_id": "ab12cd34-0000"}

    async def state(self, cwd, short):
        self.looks += 1
        return self.now

    def result(self, short):
        return self.said

    def transcript(self, session_id):
        return self.path

    def stop(self, short):
        self.stops.append(short)


def _line(path: Path, text: str) -> None:
    with path.open("a") as f:
        f.write(json.dumps({"type": "assistant", "message": {"content": [{"type": "text", "text": text}]}}) + "\n")


def _turn(run, log, cwd, **kw):
    return asyncio.get_running_loop().create_task(dev._worker_turn(run, log, cwd, "do it", None, name="thimble:dev",
                                                                   workspace=kw.pop("workspace", None),
                                                                   on_session=lambda a, b: None, **kw))


async def test_a_turn_copies_the_transcript_while_its_process_runs_and_ends_with_it(tmp_path, monkeypatch):
    tx = tmp_path / "ab12cd34-0000.jsonl"
    tx.write_text("")
    fake = _Sessions(tx)
    monkeypatch.setattr(dev, "SESSIONS", fake)
    monkeypatch.setattr(dev, "POLL_S", 0.01)
    turn = _turn(dev.Run("t1", "a ticket", "now"), dev.Log(None), tmp_path)
    for i in range(5):
        _line(tx, f"step {i}")
        await asyncio.sleep(0.03)
    assert not turn.done(), "the turn goes on while the process runs, whatever its transcript says"
    fake.now = "done"
    assert await asyncio.wait_for(turn, 2) == "step 4"
    assert fake.stops == ["ab12cd34-0000"], "whatever it started that outlived it is ended"


async def test_a_failed_turn_raises_and_a_view_build_s_api_error_returns_its_text(tmp_path, monkeypatch):
    tx = tmp_path / "ab12cd34-0000.jsonl"
    tx.write_text("")
    fake = _Sessions(tx)
    monkeypatch.setattr(dev, "SESSIONS", fake)
    monkeypatch.setattr(dev, "POLL_S", 0.01)
    fake.now, fake.said = "failed", ("", "Error: something broke")
    with pytest.raises(dev.SessionError, match="the session ended failed: Error: something broke"):
        await asyncio.wait_for(_turn(dev.Run("t1", "a ticket", "now"), dev.Log(None), tmp_path), 2)
    fake.now, fake.said = "api error", ("API Error: 529 overloaded", "")
    with pytest.raises(dev.SessionError, match="Anthropic's API ended the session's turn: API Error: 529"):
        await asyncio.wait_for(_turn(dev.Run("t1", "a ticket", "now"), dev.Log(None), tmp_path), 2)
    got = await asyncio.wait_for(_turn(dev.Run("v1", "a view", "now"), dev.Log(None), tmp_path, answered=False), 2)
    assert got == "API Error: 529 overloaded", "a view build tells a capacity error from others by its text"


async def test_a_dev_turn_has_no_time_limit_and_its_thread_says_when_the_session_shows_no_activity(tmp_path,
                                                                                                     monkeypatch):
    """A turn runs until its session ends it. A session whose transcript and subagents' transcripts stay quiet gets
    "no activity" lines in its thread, at QUIET_NOTE_S and each time that time doubles, and runs on; a transcript or a
    subagent that grows starts the quiet time again."""
    tx = tmp_path / "ab12cd34-0000.jsonl"
    tx.write_text("")
    sub = tmp_path / "ab12cd34-0000" / "subagents" / "agent-a1.jsonl"
    fake = _Sessions(tx)
    monkeypatch.setattr(dev, "SESSIONS", fake)
    monkeypatch.setattr(dev, "POLL_S", 0.01)
    monkeypatch.setattr(dev, "QUIET_NOTE_S", 0.3)
    stages: list[str] = []

    class Log(dev.Log):
        def stage(self, line: str) -> None:
            stages.append(line)

    def notes() -> list[str]:
        return [s for s in stages if s.startswith("no activity for ")]

    async def until(n: int) -> float:
        began = time.monotonic()
        while len(notes()) < n and time.monotonic() - began < 3:
            await asyncio.sleep(0.01)
        return time.monotonic() - began

    async def busy(write, seconds: float) -> None:
        began = time.monotonic()
        while time.monotonic() - began < seconds:
            write()
            await asyncio.sleep(0.03)

    def subagent() -> None:
        sub.parent.mkdir(parents=True, exist_ok=True)
        with sub.open("a") as f:
            f.write("{}\n")

    turn = _turn(dev.Run("t1", "a ticket", "now"), Log(None), tmp_path, workspace=CORPUS)
    assert await until(2) >= 0.6  # quiet: a line at 0.3 s and one at 0.6 s
    assert not turn.done(), "the turn was stopped"
    assert notes() == [dev.QUIET_LINE.format(minutes=dev._minutes(s)) for s in (0.3, 0.6)]
    await busy(lambda: _line(tx, "working"), 0.7)
    await busy(subagent, 0.7)
    assert len(notes()) == 2, "activity, the transcript's or a subagent's, counted as quiet"
    assert await until(3) >= 0.25 and notes()[2] == notes()[0], "the quiet time starts again after activity"
    _line(tx, "done")
    await asyncio.sleep(0.05)
    fake.now = "done"
    assert await asyncio.wait_for(turn, 2) == "done"


def test_a_result_that_only_quotes_a_moved_call_is_no_background_work():
    """Only Claude Code's own word that it moved a call to the background starts a task, not a log or a transcript
    that a Read, Grep or Bash result quotes."""
    quoted = ('19:14:28 RESULT MCP tool "plugin:x:x/critique" is still running after 120s. It was moved to the '
              "background as task kpmn7kn7f and keeps running")
    own = ('MCP tool "plugin:x:x/critique" is still running after 120s. It was moved to the background as task '
           "kpmn7kn7f and keeps running; you'll receive a notification with the result when it completes.")
    assert agent_session.MOVED_TASK_RE.search(own).group(1) == "kpmn7kn7f"
    assert not agent_session.MOVED_TASK_RE.search(quoted)


TASK = "wpvy4g4zv"
WORKFLOW = [
    {"type": "assistant", "message": {"content": [{"type": "tool_use", "id": "toolu_w", "name": "Workflow",
                                                   "input": {"script": "export const meta = {name: 'read'}"}}]}},
    {"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "toolu_w",
                                              "content": f"Workflow launched in background. Task ID: {TASK}\n"
                                                         "Summary: read the contract"}]}},
]


def _records(path: Path, *recs: dict) -> None:
    with path.open("a") as f:
        for r in recs:
            f.write(json.dumps(r) + "\n")


async def test_a_turn_whose_process_ends_while_its_workflow_runs_fails(tmp_path, monkeypatch):
    """--print waits for the session's background work (agent_session.BG_WAIT_ENV); a process that still exits while a
    workflow it launched runs ended that workflow with it, so the turn fails rather than letting the gates run on
    half-finished work."""
    tx = tmp_path / "ab12cd34-0000.jsonl"
    tx.write_text("")
    fake = _Sessions(tx)
    monkeypatch.setattr(dev, "SESSIONS", fake)
    monkeypatch.setattr(dev, "POLL_S", 0.01)
    _records(tx, *WORKFLOW)
    _line(tx, "Waiting for the workflow.")
    _records(tx, {"type": "system", "subtype": "turn_duration", "durationMs": 1000, "pendingWorkflowCount": 1})
    fake.now = "done"
    with pytest.raises(dev.SessionError, match="before its background work finished: Waiting for the workflow."):
        await asyncio.wait_for(_turn(dev.Run("t1", "a ticket", "now"), dev.Log(None), tmp_path), 2)


async def test_a_turn_whose_workflow_finished_before_its_process_ended_is_done(tmp_path, monkeypatch):
    tx = tmp_path / "ab12cd34-0000.jsonl"
    tx.write_text("")
    fake = _Sessions(tx)
    monkeypatch.setattr(dev, "SESSIONS", fake)
    monkeypatch.setattr(dev, "POLL_S", 0.01)
    _records(tx, *WORKFLOW, {"type": "system", "subtype": "turn_duration", "durationMs": 1000, "pendingWorkflowCount": 1},
             {"type": "user", "origin": {"kind": "task-notification"},
              "message": {"role": "user", "content": f"<task-notification>\n<task-id>{TASK}</task-id>\n"
                                                     "<status>completed</status>\n</task-notification>"}})
    _line(tx, "The view is written.")
    _records(tx, {"type": "system", "subtype": "turn_duration", "durationMs": 1000})
    fake.now = "done"
    assert await asyncio.wait_for(_turn(dev.Run("t1", "a ticket", "now"), dev.Log(None), tmp_path), 2) == \
        "The view is written."
