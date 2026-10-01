"""A dev or view build session's turn (dev._worker_turn) is over only once the session's own background work is too:
a turn that ends while a workflow or a background agent of the session runs goes on, the session is never stopped while
it runs, and the turn ends with the turn that its task notification starts. Claude Code's fake session here lists
whatever state the test sets and records each stop."""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from app import dev

TASK = "wpvy4g4zv"


class _Sessions:
    """dev.SESSIONS as a fake: one background session whose `claude agents` state is `now`."""

    def __init__(self, transcript: Path) -> None:
        self.path, self.now, self.stops, self.process = transcript, "working", [], True

    async def start(self, cwd, prompt, **kw):
        return {"id": "ab12cd34", "session_id": "ab12cd34-0000"}

    async def state(self, cwd, short):
        return self.now

    def has_process(self, short):
        return self.process

    def transcript(self, session_id):
        return self.path

    def stop(self, short):
        self.stops.append(short)


@pytest.fixture()
def turn(tmp_path, monkeypatch):
    """(start the turn as a view build's, the fake sessions, append records to the transcript, the thread's stage lines)."""
    tx = tmp_path / "ab12cd34-0000.jsonl"
    tx.write_text("")
    fake = _Sessions(tx)
    monkeypatch.setattr(dev, "SESSIONS", fake)
    monkeypatch.setattr(dev, "POLL_S", 0.01)
    monkeypatch.setattr(dev, "STATE_GAP_MAX_S", 0.04)
    stages: list[str] = []

    class Log(dev.Log):
        def stage(self, line: str) -> None:
            stages.append(line)

    def write(*recs: dict) -> None:
        with tx.open("a") as f:
            for r in recs:
                f.write(json.dumps(r) + "\n")

    def start():
        run = dev.Run("v1", "a view", "now")
        return asyncio.get_running_loop().create_task(
            dev._worker_turn(run, Log(None), tmp_path, "build the view", None, name="thimble:view-posts", workspace=None,
                             on_session=lambda a, b: None, answered=False))

    return start, fake, write, stages


def said(text: str) -> dict:
    return {"type": "assistant", "message": {"content": [{"type": "text", "text": text}]}}


def call(tid: str, name: str, inp: dict) -> dict:
    return {"type": "assistant", "message": {"content": [{"type": "tool_use", "id": tid, "name": name, "input": inp}]}}


def result(tid: str, text: str) -> dict:
    return {"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": tid, "content": text}]}}


def turn_end(**counts: int) -> dict:
    return {"type": "system", "subtype": "turn_duration", "durationMs": 1000, "messageCount": 9, **counts}


def notice(task: str, status: str = "completed") -> dict:
    return {"type": "user", "origin": {"kind": "task-notification"},
            "message": {"role": "user", "content": f"<task-notification>\n<task-id>{task}</task-id>\n"
                                                   f"<status>{status}</status>\n<summary>done</summary>\n</task-notification>"}}


WORKFLOW = [call("toolu_w", "Workflow", {"script": "export const meta = {name: 'read'}"}),
            result("toolu_w", f"Workflow launched in background. Task ID: {TASK}\nSummary: read the contract\n"
                              "Transcript dir: /x/ab12cd34-0000/subagents/workflows/wf_1")]


async def test_a_turn_that_ends_while_its_workflow_runs_waits_for_it_and_never_stops_the_session(turn):
    start, fake, write, stages = turn
    task = start()
    write(*WORKFLOW, said("I'll wait for the workflow."), turn_end(pendingWorkflowCount=1))
    await asyncio.sleep(0.05)
    for state in ("done", "idle", "blocked", "working", "done"):  # whatever the listing says of the task
        fake.now = state
        await asyncio.sleep(0.15)
        assert not task.done(), f"the turn ended while the workflow ran (listed {state})"
    assert fake.stops == [], "the session was stopped with its workflow running"
    assert sum(s.startswith("the session waits for its own background work (1 running)") for s in stages) == 1, stages
    # the workflow's notification starts the next turn, which ends with nothing left running
    fake.now = "working"
    write(notice(TASK), said("The view is written."), turn_end())
    await asyncio.sleep(0.05)
    fake.now = "idle"
    assert await asyncio.wait_for(task, 2) == "The view is written."
    assert fake.stops == ["ab12cd34"], "stopped once, after its last turn"


async def test_a_task_launched_this_turn_holds_the_turn_until_its_notification_even_without_a_count(turn):
    """A workflow that finished as the turn ended is not in turn_duration's count, but its notification, queued, is
    still to start a turn: the launch the transcript shows holds the turn until a notification names the task."""
    start, fake, write, _ = turn
    task = start()
    write(*WORKFLOW, said("Waiting."), turn_end())
    fake.now = "idle"
    await asyncio.sleep(0.3)
    assert not task.done() and fake.stops == []
    # the notification arrives during a turn as a queued command
    write({"type": "attachment", "attachment": {"type": "queued_command", "commandMode": "task-notification",
                                                 "prompt": f"<task-notification>\n<task-id>{TASK}</task-id>\n"
                                                           "<status>completed</status>\n</task-notification>"}})
    assert await asyncio.wait_for(task, 2) == "Waiting."


async def test_a_background_agent_and_a_stopped_workflow(turn):
    """A background Agent counts as background work until its notification; a workflow TaskStop ended does not."""
    start, fake, write, _ = turn
    task = start()
    write(*WORKFLOW, call("toolu_s", "TaskStop", {"task_id": TASK}),
          result("toolu_s", json.dumps({"message": "Successfully stopped task", "task_id": TASK})),
          call("toolu_a", "Agent", {"description": "check", "prompt": "check it", "run_in_background": True}),
          result("toolu_a", "Async agent launched successfully.\nagentId: a1b2c3 (internal)"),
          said("The agent checks."), turn_end(pendingBackgroundAgentCount=1))
    fake.now = "done"
    await asyncio.sleep(0.3)
    assert not task.done() and fake.stops == []
    write(notice("a1b2c3"), said("Checked."), turn_end())
    assert await asyncio.wait_for(task, 2) == "Checked."


async def test_a_session_that_ends_while_its_workflow_runs_fails_the_turn(turn):
    start, fake, write, _ = turn
    task = start()
    write(*WORKFLOW, said("Waiting."), turn_end(pendingWorkflowCount=1))
    await asyncio.sleep(0.1)
    fake.now = "stopped"
    with pytest.raises(dev.SessionError, match="ended stopped"):
        await asyncio.wait_for(task, 2)


async def test_a_session_whose_process_ends_while_its_workflow_runs_fails_the_turn(turn):
    """`claude stop` from elsewhere, or a crash, leaves the session listed as done with no process: its workflow ended
    with it, so the turn fails instead of waiting for a notification that never comes."""
    start, fake, write, _ = turn
    task = start()
    write(*WORKFLOW, said("Waiting."), turn_end(pendingWorkflowCount=1))
    fake.now = "done"
    await asyncio.sleep(0.15)
    assert not task.done()
    fake.process = False
    with pytest.raises(dev.SessionError, match="before its background work finished"):
        await asyncio.wait_for(task, 2)


async def test_a_result_that_only_quotes_a_moved_call_is_no_background_work(turn):
    """Only Claude Code's own word that it moved a call to the background starts a task, not a log or a transcript
    that a Read, Grep or Bash result quotes."""
    from app import agent_session

    start, fake, write, _ = turn
    task = start()
    quoted = ('19:14:28 RESULT MCP tool "plugin:x:x/critique" is still running after 120s. It was moved to the '
              "background as task kpmn7kn7f and keeps running")
    write(call("toolu_g", "Bash", {"command": "grep RESULT run.log"}), result("toolu_g", quoted),
          call("toolu_r", "Read", {"file_path": "/x/t.jsonl"}), result("toolu_r", "  12\t" + quoted[16:]),
          said("Read the log."), turn_end())
    fake.now = "idle"
    assert await asyncio.wait_for(task, 2) == "Read the log."
    own = ('MCP tool "plugin:x:x/critique" is still running after 120s. It was moved to the background as task '
           "kpmn7kn7f and keeps running; you'll receive a notification with the result when it completes.")
    assert agent_session.MOVED_TASK_RE.search(own).group(1) == "kpmn7kn7f"
    assert not agent_session.MOVED_TASK_RE.search(quoted)


async def test_a_listed_session_has_a_process_only_with_a_pid_or_status(monkeypatch, tmp_path):
    """`claude agents` keeps a stopped session listed with its last state, and only a running one has a pid and status."""
    sessions = dev.Sessions()
    listing = [{"id": "ab12cd34", "state": "done", "status": "idle", "pid": 4242}, {"id": "ef56ab78", "state": "done"}]

    async def fake_listing(cwd):
        return listing

    monkeypatch.setattr(sessions, "_listing", fake_listing)
    assert await sessions.state(tmp_path, "ab12cd34") == "done" and sessions.has_process("ab12cd34")
    assert await sessions.state(tmp_path, "ef56ab78") == "done" and not sessions.has_process("ef56ab78")
