"""When main's session ends and no session takes over, everything thimble runs for the workspace stops
(session._stop_agents, agents.stop_all), so nothing works on after the analyst quit, and the server stops itself once no
workspace has a main session."""
from __future__ import annotations

import asyncio

from app import agent_session, agents, card_check, checks, cli, concepts, dev, notebook, session


def test_stop_all_stops_the_checks_the_builds_the_label_runs_the_sessions_and_the_kernels(monkeypatch):
    called: list[str] = []
    monkeypatch.setattr(checks, "stop_workspace", lambda c: called.append("report checks") or 0)
    monkeypatch.setattr(card_check, "stop_workspace", lambda c: called.append("card checks") or 0)
    monkeypatch.setattr(dev, "stop_workspace", lambda c: called.append("builds") or 1)
    monkeypatch.setattr(concepts, "stop_workspace", lambda c: called.append("label runs") or 0)

    async def wind_down(c):
        called.append("sessions")
        return ["Orientation"]

    async def kernels(c):
        called.append("kernels")

    monkeypatch.setattr(agent_session, "wind_down", wind_down)
    monkeypatch.setattr(notebook, "shutdown_workspace", kernels)
    got = asyncio.run(agents.stop_all("w"))
    assert called == ["report checks", "card checks", "builds", "label runs", "sessions", "kernels"], "nothing starts a session after its stop"
    assert got == ["dev build", "Orientation"]


def test_a_workspace_s_label_runs_count_as_at_work_and_stop_with_it():
    """A label run (concepts.start_apply) keeps its workspace at work, and concepts.stop_workspace ends only that
    workspace's runs, their cancel flags set and their run records kept."""
    async def go() -> None:
        mine = asyncio.create_task(asyncio.sleep(60))
        theirs = asyncio.create_task(asyncio.sleep(60))
        concepts._tasks[("w", "k1")], concepts._tasks[("other", "k2")] = mine, theirs
        concepts._runs[("w", "k1")] = {"status": "running"}
        try:
            assert {"w", "other"} <= agents.at_work()
            assert concepts.stop_workspace("w") == 1
            await asyncio.sleep(0)
            assert mine.cancelled() and not theirs.done()
            assert concepts._cancel_event("w", "k1").is_set() and not concepts._cancel_event("other", "k2").is_set()
            assert "w" not in concepts.workspaces_at_work() and ("w", "k1") in concepts._runs
        finally:
            theirs.cancel()
            for key in (("w", "k1"), ("other", "k2")):
                concepts._tasks.pop(key, None)
                concepts._runs.pop(key, None)
                concepts._cancels.pop(key, None)

    asyncio.run(go())


def test_main_ending_with_no_successor_stops_the_agents(monkeypatch):
    called: list[str] = []
    monkeypatch.setattr(session, "_stop_agents", called.append)
    monkeypatch.setattr(session, "_shutting_down", lambda: False)

    class Lv:
        sid = "s1"

    session._live["w"] = Lv()
    monkeypatch.setattr(session, "detach", lambda c, sid, why: session._live.pop(c, None))
    monkeypatch.setattr(session, "_hand_back", lambda c, gone: None)
    from app import events
    monkeypatch.setattr(events, "listening", lambda c, sid: False)
    monkeypatch.setattr(session, "GRACE_S", 0)
    session.disconnected("w", "s1")
    assert called == ["w"]


def test_the_server_stops_itself_once_no_workspace_has_a_main_session(monkeypatch):
    stopped: list[str] = []

    async def stop_all(c):
        stopped.append(c)
        return []

    monkeypatch.setattr(agents, "stop_all", stop_all)
    monkeypatch.setattr(agents, "at_work", lambda: {"idle"})
    stops: list[int] = []
    monkeypatch.setattr(cli, "stop_self", lambda: stops.append(1))

    async def main_ends() -> None:
        session._stop_agents("w")
        await asyncio.sleep(0.2)

    session._live["other"] = object()
    try:
        asyncio.run(main_ends())
    finally:
        session._live.pop("other", None)
    assert stopped == ["w"] and not stops, "another workspace's main session keeps the server"
    asyncio.run(main_ends())
    assert stopped == ["w", "w", "idle"], "what another workspace still runs stops too"
    assert stops == [1]


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


def test_main_s_end_fails_the_views_the_analyst_asked_for_and_holds_a_session_s_until_a_session_is_main_again(workspaces_tmp):
    """Main's end (dev.stop_workspace) stops every view build of the workspace: a view the analyst asked for, running or
    queued, fails with Retry, while a view the orientation proposed waits, and no listing of the proposals queues it
    again until a session is main again."""
    from app import config, views

    c = "mini"
    first, second = (views.propose(c, n, "why", ["board.jsonl"], "one row per post", asked=True)["slug"]
                     for n in ("Posts", "Threads"))
    ours = views.propose(c, "Timeline", "why", ["events.jsonl"], "one row per event", orientation=True)["slug"]

    async def go() -> None:
        building = await _running_build(c, first)
        run = dev._view_runs[(c, first)]
        assert dev.stop_workspace(c) == 1
        await asyncio.sleep(0)
        assert building.cancelled() and run.status == dev.MAIN_ENDED, "its build ends failed (dev._run_view)"

    asyncio.run(go())
    assert not dev._view_queue, "no queued view starts in a stopped one's place"
    queued = views.read_proposal(c, second) or {}
    assert (queued.get("status"), queued.get("error")) == ("failed", dev.MAIN_ENDED)
    dev.recover_views(c)  # the browser lists the proposals
    assert (c, ours) not in dev._view_queue
    session.attach(c, "sid-next", str(config.corpus_dir(c)))
    try:
        assert (c, ours) in dev._view_queue
    finally:
        session._live.pop(c, None)
