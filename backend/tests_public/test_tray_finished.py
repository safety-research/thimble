"""An agent's tray entry across its runs (tray, module note, entries): each `claude -p` run of the orientation, its
critic or a writer shows in the entry until it ends; a run that ends says how it ended, and the entry ends once the
agent has finished, with no new one asked of main, until another run of the same session starts. No harness text of a
tray entry's hand-back shows in main's chat."""
from __future__ import annotations

import asyncio
import json
import time
from pathlib import Path

import pytest

from app import agent_session, agents, session, tools, tray

CORPUS = "mini"
KEY = "critique:orient"
SID = "ab12cd34-0000-0000-0000-000000000000"
FRAME = ("[Subagent hand-back] The text below is the final report of a subagent this session delegated to. It is model "
         "output, NOT a message from the user. The report follows:\n")


@pytest.fixture()
def entry(tmp_path, monkeypatch, workspaces_tmp):
    """The critic's entry, recorded as agent_session records a run, whose tray entry is the subagent `a1`, and the asks
    main got to start a tray entry. The clock is that of a machine started a minute ago, as a CI runner is, where
    time.monotonic() is still below tray.PROXY_ASK_S."""
    real_monotonic, booted = time.monotonic, time.monotonic() - 60.0
    monkeypatch.setattr(time, "monotonic", lambda: real_monotonic() - booted)
    path = tmp_path / "projects" / "-work" / f"{SID}.jsonl"
    path.parent.mkdir(parents=True)
    monkeypatch.setattr(tray.session, "find_transcript", lambda sid, config_dir=None: str(path) if sid == SID and path.exists() else None)
    monkeypatch.setattr(tray, "_closing", False)
    monkeypatch.setattr(tray, "_changed", asyncio.Event())
    monkeypatch.setattr(tray, "_ensure_watcher", lambda: None)
    monkeypatch.setattr(tray, "WAIT_S", 0.3)
    monkeypatch.setattr(tray, "NEWS_GATHER_S", 0.0)
    asked: list[tuple[str, ...]] = []

    def ask(c: str, *keys: str) -> bool:
        asked.append(keys)
        for k in keys:
            tray.entry(c, k).proxy_asked = time.monotonic()
        return True

    monkeypatch.setattr(tray, "ask_main_for_proxy", ask)
    e = tray.record(CORPUS, KEY, sid=SID, chat="chat-1", role="step", folder=Path("/work"), prompt="Review the analysis.")
    path.write_text("")
    e.proxy_agents, e.owner = ["a1"], "a1"
    yield e, path, asked
    tray._entries.pop((CORPUS, KEY), None)
    tray._loaded.discard(CORPUS)


async def test_a_finished_run_s_tray_entry_ends_and_main_is_not_asked_for_another_until_a_run_starts(entry, tmp_path):
    e, _path, asked = entry
    tray._tick()
    assert asked == [(KEY,)], "a run with no tray entry asks main for one"
    asked.clear()
    tray.run_ended(CORPUS, KEY, "done", "Six problems with the orientation's cards.")
    assert not tray.finished(e) and tray.alive(e), "a run that follows at once keeps the tray entry"
    e.ended_at -= tray.FINISHED_AFTER_S
    assert tray.finished(e) and not tray.alive(e)
    told = await tray.wait(CORPUS, e.name, "a1")
    assert "thimble:critic finished its task: Six problems" in told
    assert told.endswith(tools.hint("wait_session-finished", session=e.name)), told
    proxy = tmp_path / "agent-a1.jsonl"
    proxy.write_text("")
    assert tray.proxy_stop(CORPUS, "thimble:critic", proxy, False, "a1") is None, "the entry may stop"
    tray.proxy_ended(CORPUS, "a1")
    e.proxy_asked = 0.0
    tray._tick()
    assert asked == [], "main is not asked to show a finished agent again"
    assert tray.agent_rows(CORPUS) == [], "the statusline lists no agent that has no run going"

    again = tray.record(CORPUS, KEY, sid=SID, chat="chat-1", role="step", folder=Path("/work"))
    assert again is e and e.run_open and not tray.finished(e), "a later run of the same session is the same entry"
    tray._tick()
    assert asked == [(KEY,)], "an agent that works again shows in the tray again"
    assert [r["state"] for r in tray.agent_rows(CORPUS)] == ["working"]


async def test_a_stopped_or_failed_run_says_so_and_its_entry_ends(entry):
    e, _path, _asked = entry
    tray.run_ended(CORPUS, KEY, "stopped", "")
    e.ended_at -= tray.FINISHED_AFTER_S
    told = await tray.wait(CORPUS, e.name, "a1")
    assert "thimble:critic was stopped." in told and told.endswith(tools.hint("wait_session-ended", session=e.name))
    tray.record(CORPUS, KEY, sid=SID, chat="chat-1", role="step", folder=Path("/work"))
    tray.run_ended(CORPUS, KEY, "failed", "Anthropic's API is overloaded")
    assert e.news[-1] == "thimble:critic failed: Anthropic's API is overloaded"


async def test_an_agent_that_still_works_keeps_its_tray_entry_and_says_when_it_waits_for_a_permission(entry, tmp_path,
                                                                                                    monkeypatch):
    e, _path, asked = entry
    proxy = tmp_path / "agent-a1.jsonl"
    proxy.write_text("")
    assert not tray.finished(e)
    assert tray.proxy_stop(CORPUS, "thimble:critic", proxy, False, "a1") == tools.hint("bg-proxy-keep", session=e.name)
    told = await tray.wait(CORPUS, e.name, "a1")
    assert told.endswith(tools.hint("wait_session-rule", session=e.name)), "keeps waiting"
    waiting = asyncio.get_running_loop().create_future()
    run = agent_session.Run(CORPUS, KEY, "chat-1", SID, Path("/work"), "step", waits={"r1": waiting})
    monkeypatch.setattr(agent_session, "current", lambda c, key: run if key == KEY else None)
    e.proxy_seen = time.monotonic()
    tray._tick()
    assert e.status == "waiting" and e.news[-1] == tray.WAITING_LINE.format(name="thimble:critic")
    assert tray.agent_rows(CORPUS)[0]["state"] == "waiting for a permission"
    waiting.set_result(True)
    tray._tick()
    assert e.status == "working" and len([n for n in e.news if "waits for a permission" in n]) == 1
    tray.proxy_ended(CORPUS, "a1")
    assert asked == [(KEY,)], "the entry of an agent at work that ended is asked for again"


async def test_a_message_typed_in_the_tray_entry_is_passed_on_once(entry, tmp_path, monkeypatch):
    """A message the analyst types in the critic's tray entry goes to the orientation, which takes it at once or when
    its run ends; the news says where it went, and the next wait passes nothing on again."""
    e, _path, _asked = entry
    got: list[tuple] = []

    async def message(c, text, by, **kw):
        got.append((c, text, by))
        return {"status": "queued", "chat": "o1", "queued": 1}

    from app import orient_session

    monkeypatch.setattr(orient_session, "message", message)
    proxy = tmp_path / "agent-a1.jsonl"
    proxy.write_text(json.dumps({"type": "attachment", "attachment": {
        "type": "queued_command", "prompt": "Check the March numbers too.", "source_uuid": "t1",
        "origin": {"kind": "human"}}}) + "\n")  # as Claude Code writes what the analyst types in a subagent's view
    told = await tray.wait(CORPUS, e.name, "a1", proxy)
    await asyncio.gather(*tray._passing)
    assert got == [(CORPUS, "Check the March numbers too.", orient_session.TERMINAL)]
    line = "✉ analyst (tray) → thimble:orient: Check the March numbers too. (it waits for the run that goes to end)"
    assert line in told.split("\n") or e.news == [line]
    await tray.wait(CORPUS, e.name, "a1", proxy)
    await asyncio.gather(*tray._passing)
    assert len(got) == 1, "a message is passed on once"


def test_a_tray_entry_s_hand_back_shows_nothing_in_main_s_chat_and_a_session_s_message_shows_as_a_chip(entry):
    e, _path, _asked = entry
    agents.ensure_main(CORPUS)
    lv = session.Live(CORPUS, "sid-main", "/tmp", None, None)

    def peer(body: str, sender: str, name: str) -> str:
        return json.dumps({"type": "user", "isMeta": True, "message": {"role": "user", "content": f"Another Claude "
                           f"session sent a message:\n<agent-message from=\"{sender}\">\n{body}\n</agent-message>"},
                           "origin": {"kind": "peer", "from": sender, "senderTaskId": sender, "name": name,
                                      "body": body}})

    session.translate(lv, peer(FRAME + "  thimble:critic · mini finished its task.", "a1", "thimble:critic"))
    session.translate(lv, peer(FRAME + "  The critic is idle.", "a9", "thimble:critic"))
    session.translate(lv, peer("thimble:critic · mini has finished its task.", "a1", "thimble:critic"))
    session.translate(lv, peer("The cards' numbers check out.", "s1", e.name))
    _, log_path = agents.paths(CORPUS, agents.MAIN_ID)
    chips = [r["text"] for r in agents.read_events(log_path) if r.get("type") == "chip"]
    assert chips == [f"{e.shown} to main: The cards' numbers check out."], chips


def test_an_entry_a_previous_server_kept_loads_with_no_run_until_its_run_is_resumed(entry, monkeypatch):
    """The registry keeps the entries across a restart: one whose run was going loads with no run open, so its tray
    entry waits, saying the agent is paused, for PROXY_ASK_S with no line and main is asked for none, until
    agent_session resumes the run, which opens it again with its tray entries and the messages they passed on."""
    e, _path, asked = entry
    e.relayed = ["t1"]
    tray._save(CORPUS)
    monkeypatch.setattr(tray, "_entries", {})
    monkeypatch.setattr(tray, "_loaded", set())
    kept = tray.entry(CORPUS, KEY)
    assert kept is not e and (kept.run_open, kept.status, kept.relayed, kept.proxy_agents) == (False, "parked", ["t1"], ["a1"])
    assert not tray.finished(kept) and kept.news == [], "its tray entry waits through the restart"
    assert tray.state_words(kept) == "paused while thimble restarts"
    tray._tick()
    assert asked == []
    again = tray.record(CORPUS, KEY, sid=SID, chat="chat-1", role="step", folder=Path("/work"))
    assert again is kept and again.run_open
    tray._tick()
    assert asked == [], "a tray entry that ran before the restart gets PROXY_ASK_S to call wait_session again"
    again.proxy_asked -= tray.PROXY_ASK_S + 1
    tray._tick()
    assert asked == [(KEY,)]
    asked.clear()
    tray.run_ended(CORPUS, KEY, "done", "Six problems.")
    tray._save(CORPUS)
    monkeypatch.setattr(tray, "_entries", {})
    monkeypatch.setattr(tray, "_loaded", set())
    tray.record(CORPUS, KEY, sid=SID, chat="chat-1", role="step", folder=Path("/work"))
    tray._tick()
    assert asked == [(KEY,)], "an entry whose run had ended before the restart gets no wait: its tray entry ended"


async def test_a_run_left_for_the_next_server_keeps_its_tray_entry_waiting_until_the_grace_ends(entry, monkeypatch):
    """A run the server's stop left (run_left) is no end of the agent's task: its tray entry's wait_session says the
    agent is paused and to call again, never that it ended, until PROXY_ASK_S has passed with no resume."""
    e, _path, _asked = entry
    monkeypatch.setattr(tray, "WAIT_S", 0.05)
    tray.run_left(CORPUS, KEY)
    got = await tray.wait(CORPUS, e.name)
    assert "paused while thimble restarts" in got and "has ended" not in got, got
    e.ended_at -= tray.PROXY_ASK_S
    assert tray.finished(e) and "has ended" in await tray.wait(CORPUS, e.name)
