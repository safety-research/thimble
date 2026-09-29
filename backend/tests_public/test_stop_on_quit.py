"""When main's session ends and no session takes over, every agent of the workspace stops (session._stop_agents,
agents.stop_all): nothing works on after the analyst quit."""
from __future__ import annotations

import asyncio

from app import agent_session, agents, bg_session, dev, session


def test_stop_all_stops_running_agent_chats_dev_builds_and_live_background_sessions(monkeypatch):
    chats = [{"id": "m", "kind": "main", "status": None}, {"id": "o", "kind": "agent", "status": "running", "title": "Orientation"},
             {"id": "w", "kind": "agent", "status": "done", "title": "Writer"}]
    monkeypatch.setattr(agents, "list_chats", lambda c: chats)
    asked: list[str] = []

    async def stop_chat(c, chat):
        asked.append(chat)
        return True

    monkeypatch.setattr(agent_session, "stop_chat", stop_chat)
    monkeypatch.setattr(dev, "stop_workspace", lambda c: 1)

    class E:
        def __init__(self, name, short, status):
            self.name, self.short, self.status, self.replacing = name, short, status, False

    monkeypatch.setattr(bg_session, "entries", lambda c: [E("thimble:critic · w", "abc", "idle"), E("thimble:writer · w", "def", "stopped")])
    cli: list[str] = []
    monkeypatch.setattr(bg_session, "stop_cli", cli.append)
    got = asyncio.run(agents.stop_all("w"))
    assert asked == ["o"], "only the running agent chat"
    assert cli == ["abc"], "only a background session still alive"
    assert got == ["Orientation", "dev build", "thimble:critic · w"]


def test_main_ending_with_no_successor_stops_the_agents(monkeypatch):
    called: list[str] = []
    monkeypatch.setattr(session, "_stop_agents", called.append)
    monkeypatch.setattr(session, "_shutting_down", lambda: False)

    class Lv:
        sid = "s1"

    session._live["w"] = Lv()
    monkeypatch.setattr(session, "detach", lambda c, sid, why: session._live.pop(c, None))
    monkeypatch.setattr(session, "_hand_back", lambda c, gone: None)
    from app import channel
    monkeypatch.setattr(channel, "listening", lambda c, sid: False)
    monkeypatch.setattr(session, "GRACE_S", 0)
    session.disconnected("w", "s1")
    assert called == ["w"]
