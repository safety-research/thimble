"""Runs thimble waits on have no time limit (agent_session.wait_done, _retry; critique_session; checks): a session runs
until it ends or the analyst stops it, its chat says when it shows no activity, and a session the API keeps stopping at
capacity is started again for as long as that lasts. Every session is faked."""
from __future__ import annotations

import asyncio
import time
from pathlib import Path

import pytest

from app import agent_session, agents, critique_session, session, tools

CORPUS = "mini"


@pytest.fixture()
def run(tmp_path, workspaces_tmp) -> agent_session.Run:
    """A followed session whose chat is a real agent chat, with its transcript at tmp_path/main.jsonl."""
    meta = agents.new_agent(CORPUS, "check", "a check", announce=False)
    r = agent_session.Run(CORPUS, "check:c1:d1", str(meta["id"]), "sid-1", tmp_path, "check", pid=4242)
    r.main = session.Sub(CORPUS, r.chat, None, None)
    r.main.path = tmp_path / "main.jsonl"
    r.main.path.write_text("")
    return r


def _quiet_lines(r: agent_session.Run) -> list[str]:
    _, log = agents.paths(CORPUS, r.chat)
    return [str(e.get("delta") or "").strip() for e in agents.read_events(log) if e.get("type") == "text"]


async def test_a_quiet_session_runs_on_and_its_chat_says_so_as_its_quiet_time_doubles(run, monkeypatch):
    monkeypatch.setattr(agent_session, "QUIET_NOTE_S", 0.2)
    done: asyncio.Future = asyncio.get_running_loop().create_future()
    waiting = asyncio.ensure_future(agent_session.wait_done(run, done, poll_s=0.02))
    await asyncio.sleep(0.7)
    assert not waiting.done(), "a quiet session is not stopped"
    assert _quiet_lines(run) == ["· no activity for 0 s", "· no activity for 0 s"], "at 0.2 s and at 0.4 s, not again by 0.7 s"
    done.set_result("done")
    await asyncio.wait_for(waiting, 1)


async def test_the_quiet_time_starts_again_when_the_transcript_grows_or_a_request_waits(run, monkeypatch):
    monkeypatch.setattr(agent_session, "QUIET_NOTE_S", 0.3)
    done: asyncio.Future = asyncio.get_running_loop().create_future()
    waiting = asyncio.ensure_future(agent_session.wait_done(run, done, poll_s=0.02))
    began = time.monotonic()
    while time.monotonic() - began < 0.6:
        await asyncio.sleep(0.1)
        with run.main.path.open("a") as f:
            f.write('{"type": "assistant"}\n')
    run.waits["r1"] = asyncio.get_running_loop().create_future()  # a permission request on the card
    await asyncio.sleep(0.5)
    run.waits.clear()
    run.pid = None  # a retry's wait for capacity
    await asyncio.sleep(0.5)
    assert _quiet_lines(run) == []
    done.set_result("done")
    await asyncio.wait_for(waiting, 1)


async def test_a_session_at_capacity_is_started_again_however_many_times_it_failed(run, monkeypatch):
    started: list[int] = []

    async def respawn(r, hint=agent_session.RETRY_PROMPT, **values):
        started.append(r.retries)

    monkeypatch.setattr(agent_session, "capacity", lambda r: "overloaded")
    monkeypatch.setattr(agent_session, "_respawn", respawn)
    monkeypatch.setattr(agent_session, "retry_wait", lambda n: 0.01)
    run.spawned = time.monotonic()
    for _ in range(60):  # far past the half hour the old schedule allowed
        assert await agent_session._retry(run)
    assert started == list(range(1, 61))


async def test_a_critique_is_waited_for_until_it_ends_and_the_analyst_s_stop_ends_it(run, monkeypatch):
    caller = agent_session.Run(CORPUS, "orient", "chat-o", "sid-o", Path("/w"), "orient", pid=1)
    monkeypatch.setattr(critique_session, "orientation_run", lambda c, key: caller)
    monkeypatch.setattr(critique_session, "_caller_ended", lambda c: asyncio.sleep(3600))
    monkeypatch.setattr(agent_session, "QUIET_POLL_S", 0.02)
    futures: list[asyncio.Future] = []

    async def start(c, caller_, context=""):
        futures.append(asyncio.get_running_loop().create_future())
        return run, futures[-1]

    monkeypatch.setattr(critique_session, "start", start)
    ctx = type("Ctx", (), {"c": CORPUS, "session": "orient"})()

    call = asyncio.ensure_future(critique_session.tool_critique(ctx, {}))
    await asyncio.sleep(0.4)
    assert not call.done(), "the critique runs as long as it takes"
    futures[0].set_result(("done", "The report."))
    assert await asyncio.wait_for(call, 1) == tools.ok("The report.")

    call = asyncio.ensure_future(critique_session.tool_critique(ctx, {}))
    await asyncio.sleep(0.1)
    futures[1].set_result(("stopped", ""))  # the analyst's Stop ends the critic's session
    assert await asyncio.wait_for(call, 1) == tools.err(tools.hint("critique-ended", status="stopped", text="nothing"))


def test_no_run_has_a_time_limit_of_its_own():
    from app import checks

    for name in ("CRITIQUE_LIMIT_S", "critique_limit"):
        assert not hasattr(critique_session, name)
    for name in ("RUN_LIMIT_S", "run_limit"):
        assert not hasattr(checks, name)
    for name in ("RETRY_BUDGET_S", "RETRY_BUDGET_ENV", "wait_active"):
        assert not hasattr(agent_session, name)
