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


async def _running_build(c: str, slug: str) -> "asyncio.Task":
    """The view ticket `slug` as a build that runs, taken off the queue and leaving the pool as dev's own do."""
    run = dev.Run(ticket_id=f"view:{slug}", title=slug, ts_start="")

    async def build() -> None:
        try:
            await asyncio.sleep(3600)
        finally:
            dev._view_runs.pop((c, slug), None)
            dev._view_stopping.pop((c, slug), None)

    run.task = asyncio.get_running_loop().create_task(build())
    dev._view_queue.remove((c, slug))
    dev._view_runs[(c, slug)] = run
    await asyncio.sleep(0)
    return run.task


def test_stopping_the_orientation_stops_the_builds_of_its_views_and_no_other(workspaces_tmp):
    """The analyst's Stop ends the orientation's run stopped: the views it proposed stop building, running or queued,
    and no listing of the proposals queues them again, while a view the analyst asked for builds on. The server's own
    stop, which the next server resumes, stops none."""
    from app import config, orient_session, orientation, views

    c = "mini"
    ours = [views.propose(c, n, "why", ["board.jsonl"], "one row per post", orientation=True)["slug"]
            for n in ("Posts", "Threads")]
    asked = views.propose(c, "Timeline", "why", ["events.jsonl"], "one row per event", asked=True)["slug"]

    def run(**kw):
        return agent_session.Run(c, orient_session.KEY, "chat-o", "sid-o", config.corpus_dir(c), orientation.ROLE, **kw)

    async def go() -> None:
        building = await _running_build(c, ours[0])
        orient_session._ended(run(interrupted="the server stopped"), "failed", "")
        await asyncio.sleep(0)
        assert not building.done() and (c, ours[1]) in dev._view_queue, "the server's stop leaves them to resume"
        orient_session._ended(run(), "stopped", "")
        await asyncio.sleep(0)
        assert building.cancelled()

    asyncio.run(go())
    assert dev._view_queue == [(c, asked)] and not dev._view_runs
    assert {s: (views.read_proposal(c, s) or {}).get("status") for s in ours} == dict.fromkeys(ours, "dropped")
    dev.recover_views(c)  # the browser lists the proposals
    assert dev._view_queue == [(c, asked)]
