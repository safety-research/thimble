"""Prompts of thimble's agents in Claude Code's Manual mode (events.py, session.py): Claude Code asks them in the terminal
alone, so main's meta holds each as a `terminal` entry naming the agent's chat, which the browser shows as that agent
waiting for the analyst's answer there. The entry goes once the analyst has answered: when Claude Code's record of main's
session says no dialog is open after it was seen open (though an allowed call may run long before its result), when its
call's result comes, or when the agent's run ends. A descendant that no chat names yet is shown on its nearest
ancestor's chat. Claude Code's session record is written by the test."""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from app import agents, config, events, subagents, write_session
from app import subagent_files as sf
from subagent_fakes import bridge  # noqa: F401 — a fixture

CORPUS = "mini"
SID = "7e3a1100-0000-4000-8000-0000000000aa"
PID = 5151


@pytest.fixture()
def live(workspaces_tmp, tmp_path, monkeypatch):
    """Main's session attached, with Claude Code's record of it in the test's config dir."""
    from app import session

    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "claude-config"))
    monkeypatch.setattr(session, "_ensure_tail", lambda lv: None)
    for table in (events._asks, events._terminal, events._seen_open, events._closed_since):
        table.clear()
    lv = session.Live(CORPUS, SID, str(config.corpus_dir(CORPUS)), None, None)
    lv.pid = PID
    session._live[CORPUS] = lv
    yield lv
    session._live.pop(CORPUS, None)
    for table in (events._asks, events._terminal, events._seen_open, events._closed_since):
        table.clear()


class Hook:
    async def is_disconnected(self) -> bool:
        return False


def _record(status: str, waiting_for: str | None = None) -> None:
    """Claude Code's own record of main's session, as session.session_state reads it."""
    d = Path(str(config.claude_config_dir())) / "sessions"
    d.mkdir(parents=True, exist_ok=True)
    (d / f"{PID}.json").write_text(json.dumps({"pid": PID, "sessionId": SID, "status": status,
                                               **({"waitingFor": waiting_for} if waiting_for else {})}))


def _cards() -> list[dict]:
    return agents.read_meta(CORPUS, agents.MAIN_ID).get("permissions") or []


async def _ask(agent_id: str, command: str) -> dict:
    """The PermissionRequest hook relays a Bash prompt of `agent_id`; returns its card entry."""
    before = {p["id"] for p in _cards()}
    got = await asyncio.wait_for(events.hook_permission_route(Hook(), events.HookPermission(
        cwd=str(config.corpus_dir(CORPUS)), session=SID, tool_name="Bash", tool_input={"command": command},
        agent_id=agent_id)), 2)
    assert got["behavior"] is None, "the terminal asks at once"
    [card] = [p for p in _cards() if p["id"] not in before]
    return card


def _busy(lv) -> None:
    """A turn of main's is open, so the mirror reads Claude Code's record (session._watch_wait)."""
    lv.turn_open = True


async def test_a_prompt_seen_open_ends_once_claude_code_says_no_dialog_is_open(bridge, live, monkeypatch):
    from app import session

    _busy(live)
    ans = await write_session.start(CORPUS, "report", route=subagents.CLICK)
    chat = subagents.agent(CORPUS, ans.agent_id)["chat"]
    card = await _ask(ans.agent_id, "python3 long_survey.py")
    assert card["terminal"] is True and card["chat"] == chat, "the browser shows the writer as waiting"

    _record("busy")  # read before the dialog shows: a prompt never seen open stays
    monkeypatch.setattr(events, "TERMINAL_CLOSED_S", 0.0)
    session._watch_wait(live)
    assert [p["id"] for p in _cards()] == [card["id"]]

    monkeypatch.setattr(events, "TERMINAL_CLOSED_S", 1.0)
    _record("waiting", session.PERMISSION_WAIT)  # the dialog is open in the terminal
    session._watch_wait(live)
    assert [p["id"] for p in _cards()] == [card["id"]]
    _record("busy")  # answered: the call runs, and its result is far off
    session._watch_wait(live)
    assert [p["id"] for p in _cards()] == [card["id"]], "no dialog for less than TERMINAL_CLOSED_S: kept"
    _record("waiting", session.PERMISSION_WAIT)  # the next prompt of a queue took its place at once
    session._watch_wait(live)
    _record("busy")
    session._watch_wait(live)
    events._closed_since[CORPUS] -= 1.5
    session._watch_wait(live)
    assert _cards() == [], "no dialog for TERMINAL_CLOSED_S: the analyst answered it"
    assert events._terminal == {} and events._seen_open == set()


async def test_another_dialog_keeps_the_prompt_and_its_result_ends_it(bridge, live):
    from app import session

    _busy(live)
    ans = await write_session.start(CORPUS, "report", route=subagents.CLICK)
    card = await _ask(ans.agent_id, "wc -l agents.jsonl")
    for waiting in (session.PERMISSION_WAIT, session.DIALOG_WAIT, session.PERMISSION_WAIT):
        _record("waiting", waiting)
        session._watch_wait(live)
        assert [p["id"] for p in _cards()] == [card["id"]], f"a dialog is open ({waiting})"
    events.calls_done(CORPUS, ans.agent_id, [(events.call_key("Bash", {"command": "wc -l agents.jsonl"}), 0.0)])
    assert _cards() == [] and events._seen_open == set()


async def test_a_stopped_run_takes_its_open_prompt_away(bridge, live):
    ans = await write_session.start(CORPUS, "report", route=subagents.CLICK)
    await _ask(ans.agent_id, "wc -l agents.jsonl")
    subagents.run_ended(CORPUS, ans.agent_id, "stopped", None, source="module")
    assert _cards() == [] and events._terminal == {}


async def test_a_descendant_with_no_chat_yet_waits_on_its_ancestor_s_chat(bridge, live):
    ans = await write_session.start(CORPUS, "report", route=subagents.CLICK)
    chat = subagents.agent(CORPUS, ans.agent_id)["chat"]
    with subagents.update(CORPUS) as state:
        sf.registry(state)["h-1"] = {"parent": ans.agent_id, "status": "running"}
    card = await _ask("h-1", "ls")
    assert card["terminal"] is True and card["chat"] == chat
