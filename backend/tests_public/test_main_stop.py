"""Stop for main and its side threads in the browser (agents.interrupt_route). Main's Stop ends main's running turn
through thimble's hooks module (subagents.stop_main, the module's `abort`: `$.turn.abort`), as Esc ends it in the
terminal, and the mirror ends the turn with its note (session.turn_stopped), since the abort leaves no record in the
transcript; without the module the browser says to press Esc. A side thread's Stop stops the fork that answers it, as
an agent's Stop does. Both are clicks, which take the analyst's cookie. Every transcript here is written by the test in
Claude Code's record shapes."""
from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi import HTTPException

from app import agents, config, events, session, subagents
from subagent_fakes import bridge  # noqa: F401 — fixture

CORPUS = "mini"
SID = "e7b0a1f2-0000-4000-8000-000000000042"


@pytest.fixture(autouse=True)
def _fresh(workspaces_tmp, tmp_path, monkeypatch):
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "claude-config"))
    session._live.clear()
    for table in (events._subs, events._pending, events._taken):
        table.clear()
    agents._busy.clear()
    yield
    session._live.clear()
    agents._busy.clear()


def _human(text: str) -> dict:
    return {"type": "user", "origin": {"kind": "human"}, "message": {"content": text}}


def _say(text: str) -> dict:
    return {"type": "assistant", "message": {"role": "assistant", "model": "claude-sonnet-5", "content": [{"type": "text", "text": text}]}}


def _write(p: Path, recs: list[dict]) -> None:
    with p.open("a") as f:
        f.write("".join(json.dumps(r) + "\n" for r in recs))


def _main_log() -> list[dict]:
    return agents.read_events(agents.paths(CORPUS, agents.MAIN_ID)[1])


def _notes() -> list[str]:
    return [str(r.get("text") or "") for r in _main_log() if r.get("type") == "chip"]


@pytest.fixture()
def turn(tmp_path) -> tuple[Path, session.Live]:
    """Main attached, in a turn the analyst asked for that has written one line so far."""
    p = tmp_path / f"{SID}.jsonl"
    p.write_text("")
    lv = session.attach(CORPUS, SID, str(config.corpus_dir(CORPUS)), str(p))
    assert lv is not None
    session.tail_once(lv)
    _write(p, [_human("Count the runs per agent."), _say("Counting the runs.")])
    session.tail_once(lv)
    assert lv.turn_open and agents.running(CORPUS, agents.MAIN_ID)
    return p, lv


async def test_main_s_stop_aborts_its_turn_through_the_module_and_the_mirror_ends_the_turn_with_its_note(bridge, turn, analyst):
    p, lv = turn
    # a line of the turn the tail has not read yet, then Stop
    _write(p, [_say("Agent 3 ran most of them.")])
    bridge.answers = [{"ok": True}]
    assert await agents.interrupt_route(CORPUS, agents.MAIN_ID, analyst) == {"stopped": True}
    assert [op for op, _ in bridge.calls] == ["abort"]
    assert not lv.turn_open and not agents.running(CORPUS, agents.MAIN_ID)
    said = [r.get("delta") for r in _main_log() if r.get("type") == "text"]
    assert said == ["Counting the runs.", "Agent 3 ran most of them."], "what the transcript held is read before the end"
    assert _notes() == [session.STOPPED_TEXT]
    assert session.STOPPED_TEXT == "The turn was stopped in the browser"
    assert _main_log()[-1]["type"] == "done"
    # the cursor keeps the turn ended, so a restart does not open it again
    cursor = session.sessions(CORPUS)[SID]["cursor"]
    assert cursor["turn_open"] is False and cursor["offset"] == p.stat().st_size
    # a record of the aborted turn written after the stop is not shown, and the next prompt opens a new turn
    _write(p, [_say("late words of the stopped turn")])
    session.tail_once(lv)
    assert "late words of the stopped turn" not in [r.get("delta") for r in _main_log()]
    _write(p, [_human("Now per day.")])
    session.tail_once(lv)
    assert lv.turn_open and agents.running(CORPUS, agents.MAIN_ID)


async def test_a_prompt_that_waited_and_started_the_next_turn_before_the_stop_was_read_goes_on(bridge, turn, analyst):
    """After the abort, Claude Code takes up a prompt that waited at once: the read finds the next turn open, which the
    Stop leaves alone, so its answer shows."""
    p, lv = turn
    _write(p, [_say("Agent 3 ran most of them."), _human("Now per day."), _say("Per day, the runs peak on Monday.")])
    bridge.answers = [{"ok": True}]
    assert await agents.interrupt_route(CORPUS, agents.MAIN_ID, analyst) == {"stopped": True}
    assert lv.turn_open and agents.running(CORPUS, agents.MAIN_ID)
    assert [r.get("delta") for r in _main_log() if r.get("type") == "text"][-1] == "Per day, the runs peak on Monday."
    assert not _notes()


async def test_a_stop_when_main_ran_no_turn_is_done_and_ends_a_turn_an_interrupt_left_open_with_no_note_of_its_own(
        bridge, turn, analyst):
    p, lv = turn
    # a turn the mirror holds open whose end it has yet to read: the done Stop leaves it to the mirror
    bridge.answers = [{"error": "main is not running a turn", "gone": True}]
    assert await agents.interrupt_route(CORPUS, agents.MAIN_ID, analyst) == {"stopped": True, "done": True}
    assert lv.turn_open and agents.running(CORPUS, agents.MAIN_ID) and not _notes()
    # Esc in the terminal: Claude Code writes its interrupt line and no turn_duration
    _write(p, [_human("[Request interrupted by user]")])
    session.tail_once(lv)
    assert _notes() == [session.INTERRUPTED_TEXT] and agents.running(CORPUS, agents.MAIN_ID)
    bridge.answers = [{"error": "main is not running a turn", "gone": True}]
    assert await agents.interrupt_route(CORPUS, agents.MAIN_ID, analyst) == {"stopped": True, "done": True}
    assert not agents.running(CORPUS, agents.MAIN_ID)
    assert _notes() == [session.INTERRUPTED_TEXT]


async def test_without_the_module_main_s_stop_is_refused_and_the_turn_goes_on(bridge, turn, analyst):
    bridge.is_live, bridge.reason = False, "Claude Code did not load thimble's hooks module"
    got = await agents.interrupt_route(CORPUS, agents.MAIN_ID, analyst)
    assert got == {"stopped": False, "kind": subagents.NO_MODULE, "reason": "Claude Code did not load thimble's hooks module"}
    assert bridge.calls == []
    assert agents.running(CORPUS, agents.MAIN_ID) and not _notes()


async def test_a_side_thread_s_stop_stops_its_fork_through_the_module_and_one_with_no_fork_says_so(bridge, analyst):
    tid = agents.new_thread(CORPUS, "card:abc123", "Runs per agent", "runs-per-agent")["id"]
    got = await agents.interrupt_route(CORPUS, tid, analyst)
    assert got["stopped"] is False and got["kind"] == agents.NO_FORK
    agents.update_agent(CORPUS, tid, fork={"agent_id": "afork1", "ended": "2026-10-15T10:00:00+00:00"})
    assert (await agents.interrupt_route(CORPUS, tid, analyst))["kind"] == agents.NO_FORK, "a fork that ended is none"
    assert bridge.calls == []
    agents.update_agent(CORPUS, tid, fork={"agent_id": "afork1"})
    assert await agents.interrupt_route(CORPUS, tid, analyst) == {"stopped": True}
    assert [(op, args["agent"]) for op, args in bridge.calls] == [("stop", "afork1")]
    # a fork that had ended already counts as stopped
    bridge.answers = [{"error": "Task afork1 is not running", "gone": True}]
    assert await agents.interrupt_route(CORPUS, tid, analyst) == {"stopped": True, "done": True}


async def test_main_s_stop_and_a_thread_s_take_the_analyst_s_cookie(bridge, plugin_headers):
    from starlette.requests import Request

    tid = agents.new_thread(CORPUS, "card:abc123", "Runs per agent", "runs-per-agent")["id"]
    agents.update_agent(CORPUS, tid, fork={"agent_id": "afork1"})
    bare = Request({"type": "http", "headers": []})
    for chat in (agents.MAIN_ID, tid):
        with pytest.raises(HTTPException) as no:
            await agents.interrupt_route(CORPUS, chat, bare)
        assert no.value.status_code == 403 and "start, message or stop thimble's agents" in no.value.detail
    assert bridge.calls == [], "the module is never asked"
