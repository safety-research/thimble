"""A background session that finished its task (bg_session.finished): Claude Code keeps its process idle, yet its tray
entry ends with its last news, main is not asked to show it again, and no harness text of a tray entry's hand-back shows
in main's chat. Once the session starts another turn, it shows in the tray again."""
from __future__ import annotations

import asyncio
import json
import time

import pytest

from app import agents, bg_session, session, tools

CORPUS = "mini"
KEY = "critique:orient"
FRAME = ("[Subagent hand-back] The text below is the final report of a subagent this session delegated to. It is model "
         "output, NOT a message from the user. The report follows:\n")


@pytest.fixture()
def bg(tmp_path, monkeypatch, workspaces_tmp):
    """A followed background session of the critic whose tray entry is the proxy `a1`, and the asks main got to start a
    tray entry."""
    path = tmp_path / "projects" / "-work" / "ab12cd34-0000.jsonl"
    path.parent.mkdir(parents=True)
    path.write_text("")
    monkeypatch.setattr(bg_session.session, "find_transcript", lambda sid, config_dir=None: str(path) if sid == "ab12cd34-0000" else None)
    monkeypatch.setattr(bg_session, "_closing", False)
    monkeypatch.setattr(bg_session, "_changed", asyncio.Event())
    monkeypatch.setattr(bg_session, "WAIT_S", 0.3)
    monkeypatch.setattr(bg_session, "NEWS_GATHER_S", 0.0)
    asked: list[tuple[str, ...]] = []

    def ask(c: str, *keys: str) -> bool:
        asked.append(keys)
        for k in keys:
            bg_session.entry(c, k).proxy_asked = time.monotonic()
        return True

    monkeypatch.setattr(bg_session, "ask_main_for_proxy", ask)
    e = bg_session.Entry(CORPUS, KEY, bg_session.name_of(CORPUS, KEY), "ab12cd34", "ab12cd34-0000", "chat-1", "step",
                         "/work")
    e.proxy_agents, e.owner, e.pid = ["a1"], "a1", 4242
    bg_session._loaded.add(CORPUS)
    bg_session._entries[(CORPUS, KEY)] = e
    yield e, path, asked
    bg_session._entries.pop((CORPUS, KEY), None)
    bg_session._loaded.discard(CORPUS)


def _row(e: bg_session.Entry, status: str) -> dict:
    return {"id": e.short, "sessionId": e.sid, "pid": e.pid, "status": status, "name": e.name}


async def test_a_finished_session_s_tray_entry_ends_and_main_is_not_asked_for_another(bg, tmp_path, monkeypatch):
    e, path, asked = bg
    woken: list[str] = []

    async def wake(c, entry):
        woken.append(entry.key)
        entry.run_open = True
        return object()  # the run that follows it

    monkeypatch.setattr(bg_session, "_wake", {"critique": wake})
    e.status = "idle"
    bg_session.run_ended(CORPUS, KEY, "Six problems with the orientation's cards.")
    assert not bg_session.finished(e), "a run that follows at once keeps the tray entry"
    e.ended_at -= bg_session.FINISHED_AFTER_S
    assert bg_session.finished(e), "idle, with no run of thimble's and no message waiting"
    told = await bg_session.wait(CORPUS, e.name, "a1")
    assert "finished its task: Six problems" in told
    assert told.endswith(tools.hint("wait_session-finished", session=e.name)), told
    proxy = tmp_path / "agent-a1.jsonl"
    proxy.write_text("")
    assert bg_session.proxy_stop(CORPUS, "thimble:critic", proxy, False, "a1") is None, "the entry may stop"
    bg_session.proxy_ended(CORPUS, "a1")
    e.proxy_asked = 0.0
    await bg_session._tick([_row(e, "idle")])
    assert asked == [] and woken == [], "main is not asked to show a finished session again"

    await bg_session._tick([_row(e, "busy")])
    assert woken == [] and bg_session.finished(e), "listed busy with no turn in its transcript: a background shell runs"
    with path.open("a") as f:  # a message typed in its terminal starts another turn
        f.write(json.dumps({"type": "user", "message": {"role": "user", "content": "And April?"}}) + "\n")
    await bg_session._tick([_row(e, "busy")])
    await asyncio.sleep(0)
    assert woken == [KEY] and not bg_session.finished(e)
    assert asked == [(KEY,)], "a session that works again shows in the tray again"


async def test_a_tray_entry_that_ends_on_the_news_of_the_run_s_end_is_not_started_again(bg, monkeypatch):
    """A tray entry may end as soon as it copies "… finished its task", before the session counts as finished: main is
    not asked for another while the session rests, and is asked once a follow-up run makes it work again."""
    e, _path, asked = bg
    monkeypatch.setattr(bg_session, "_wake", {})
    e.status = "idle"
    bg_session.run_ended(CORPUS, KEY, "Six problems with the orientation's cards.")
    assert bg_session.resting(e) and not bg_session.finished(e)
    bg_session.proxy_ended(CORPUS, "a1")
    e.proxy_asked = 0.0
    await bg_session._tick([_row(e, "idle")])
    assert asked == [], "a resting session gets no new tray entry"
    e.run_open = True  # thimble resumes it with a follow-up
    await bg_session._tick([_row(e, "busy")])
    assert asked == [(KEY,)]


async def test_a_session_that_still_works_keeps_its_tray_entry(bg, tmp_path):
    e, path, asked = bg
    e.status, e.run_open = "working", True
    proxy = tmp_path / "agent-a1.jsonl"
    proxy.write_text("")
    assert not bg_session.finished(e)
    assert bg_session.proxy_stop(CORPUS, "thimble:critic", proxy, False, "a1") == tools.hint("bg-proxy-keep",
                                                                                              session=e.name)
    told = await bg_session.wait(CORPUS, e.name, "a1")
    assert told.endswith(tools.hint("wait_session-rule", session=e.name)), "keeps waiting"
    bg_session.proxy_ended(CORPUS, "a1")
    assert asked == [(KEY,)]


def test_a_tray_entry_s_hand_back_shows_nothing_in_main_s_chat_and_a_session_s_message_shows_as_a_chip(bg):
    e, _path, _asked = bg
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
