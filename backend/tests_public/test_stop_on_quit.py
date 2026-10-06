"""When main's session ends and no session takes over, everything thimble runs for the workspace stops
(session._stop_agents, agents.stop_all), so nothing works on after the analyst quit, and the server stops itself once no
workspace has a main session."""
from __future__ import annotations

import asyncio

from app import agents, card_check, checks, cli, concepts, dev, notebook, session


def test_stop_all_stops_the_checks_the_builds_the_label_runs_the_sessions_and_the_kernels(monkeypatch):
    called: list[str] = []
    monkeypatch.setattr(checks, "stop_workspace", lambda c: called.append("report checks") or 0)
    monkeypatch.setattr(card_check, "stop_workspace", lambda c: called.append("card checks") or 0)
    monkeypatch.setattr(dev, "stop_workspace", lambda c: called.append("builds") or 1)
    monkeypatch.setattr(concepts, "stop_workspace", lambda c: called.append("label runs") or 0)

    def close_running(c, why):
        called.append("subagents")
        return ["a1"]

    async def kernels(c):
        called.append("kernels")

    from app import subagents

    monkeypatch.setattr(subagents, "close_running", close_running)
    monkeypatch.setattr(notebook, "shutdown_workspace", kernels)
    got = asyncio.run(agents.stop_all("w"))
    assert called == ["report checks", "card checks", "builds", "label runs", "subagents", "kernels"], \
        "nothing starts after its stop"
    assert got == ["dev build", "agent a1"], "the chats of thimble's agents, which died with main, are closed"


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
    and no listing of the proposals queues them again, while a view the analyst asked for builds on. A run main's quit
    cut off stops none here (main's end stops the builds, dev.stop_workspace)."""
    from app import orient_session, views

    c = "mini"
    ours = [views.propose(c, n, "why", ["board.jsonl"], "one row per post", orientation=True)["slug"]
            for n in ("Posts", "Threads")]
    asked = views.propose(c, "Timeline", "why", ["events.jsonl"], "one row per event", asked=True)["slug"]

    from app import subagents

    def run(**kw):
        return subagents.Run(c, orient_session.KEY, "orientation", "chat-o", "a1", **kw)

    async def go() -> None:
        building = await _running_build(c, ours[0])
        orient_session.subagent_ended(c, run(interrupted=True), "stopped", "")
        await asyncio.sleep(0)
        assert not building.done() and (c, ours[1]) in dev._view_queue, "main's quit stops nothing more here"
        orient_session.subagent_ended(c, run(), "stopped", "")
        await asyncio.sleep(0)
        assert building.cancelled()

    asyncio.run(go())
    assert dev._view_queue == [(c, asked)] and not dev._view_runs
    assert {s: (views.read_proposal(c, s) or {}).get("status") for s in ours} == dict.fromkeys(ours, "dropped")
    dev.recover_views(c)  # the browser lists the proposals
    assert dev._view_queue == [(c, asked)]


def test_main_s_end_fails_every_queued_build_with_retry_and_none_starts_again(workspaces_tmp):
    """Main's end (dev.stop_workspace) fails every queued view build of the workspace with MAIN_ENDED and Retry, the
    analyst's and the orientation's alike, and nothing starts it again by itself: not a listing of the proposals, not a
    new main. A builder that ran ended with main (test_view_subagents.py)."""
    from app import config, views

    c = "mini"
    slugs = [views.propose(c, n, "why", ["board.jsonl"], "one row per post", asked=True)["slug"]
             for n in ("Posts", "Threads")]
    slugs.append(views.propose(c, "Timeline", "why", ["events.jsonl"], "one row per event", orientation=True)["slug"])
    assert dev.stop_workspace(c) == 3
    assert not dev._view_queue
    assert {s: ((views.read_proposal(c, s) or {}).get("status"), (views.read_proposal(c, s) or {}).get("error"))
            for s in slugs} == dict.fromkeys(slugs, ("failed", dev.MAIN_ENDED))
    dev.recover_views(c)  # the browser lists the proposals
    session.attach(c, "sid-next", str(config.corpus_dir(c)))
    try:
        assert not dev._view_queue and not dev._view_runs
    finally:
        session._live.pop(c, None)
