"""A report check's run across a stop (app/checks.py): the pane's Stop ends a run, a save made while it ran asks for
no rerun after the analyst's Stop, and a run a stopped server left `running` can be stopped from the pane and ends
`failed` with why at the next server's start. A run's session is agent_session.start, replaced here by a stand-in
that records what it was started with and ends when stopped; the report and its card are invented."""
from __future__ import annotations

import asyncio
from types import SimpleNamespace

import httpx
import pytest

from app import agent_session, agents, channel, checks, config, notebook, report_types, tools

CORPUS = "mini"
TEXT = "# Deletions\n\n## Who\n\nAlice deleted 27 pages [[27|card:{cid}]].\n\nBob deleted none.\n"


@pytest.fixture()
def card(workspaces_tmp) -> str:
    """A printed count (27) in the analyst's group; its id."""
    channel._subs.clear()
    report_types._writes.clear()
    ws = config.workspace_dir(CORPUS)
    nb = notebook.create_notebook(ws, "Your work", role="analyst")
    count = notebook.new_cell("code", "terminal", "How many deletions?", nb["id"], code="print(27)")
    count["status"], count["outputs"] = "ok", [{"text/plain": "27", "_stream": True}]
    nb["cells"].append(count)
    notebook.write_notebook(ws, nb)
    yield count["id"]
    channel._subs.clear()
    report_types._writes.clear()


@pytest.fixture()
def sessions(monkeypatch):
    """agent_session.start and stop_run replaced: a run gets an agent chat and a record of what it was started with;
    stop_run ends it as stopped."""
    started: list[SimpleNamespace] = []

    async def start(c, key, **kw):
        meta = agents.new_agent(c, kw["role"], kw["title"], announce=kw.get("announce", True))
        run = SimpleNamespace(c=c, key=key, chat=meta["id"], kw=kw, pid=None, waits={}, sid="s1")
        started.append(run)
        return run

    async def stop_run(run):
        run.kw["on_end"](run, "stopped", "")
        return True

    monkeypatch.setattr(agent_session, "start", start)
    monkeypatch.setattr(agent_session, "stop_run", stop_run)
    checks._active.clear()
    checks._dirty.clear()
    yield started
    for act in list(checks._active.values()):
        if act.task is not None:
            act.task.cancel()
    checks._active.clear()
    for h in checks._timers.values():
        h.cancel()
    checks._timers.clear()


async def _started(sessions: list, n: int) -> SimpleNamespace:
    for _ in range(200):
        if len(sessions) >= n:
            return sessions[n - 1]
        await asyncio.sleep(0.01)
    raise AssertionError(f"{n} runs did not start ({len(sessions)} did)")


async def test_the_pane_stops_one_run_and_a_run_left_by_a_stopped_server_ends(card, sessions):
    from app.main import app

    wrote = await tools.call(CORPUS, "write_document", {"doc": "report", "text": TEXT.format(cid=card)}, actor="analyst")
    assert not wrote.is_error, wrote.text
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as client:
        checks.edit(CORPUS, "verified", shown=True)
        await checks.start_run(CORPUS, "verified", "report", force=True)
        await _started(sessions, 1)
        checks._dirty.add((CORPUS, "verified", "report"))  # a save while it ran asked for a rerun
        r = await client.post(f"/api/ws/{CORPUS}/checks/verified/runs/report/stop")
        assert r.status_code == 200 and r.json()["runs"]["report"]["status"] == "stopped"
        assert not checks._active and not checks._timers, "no rerun follows the analyst's Stop"
        assert (await client.post(f"/api/ws/{CORPUS}/checks/nope/runs/report/stop")).status_code == 404
        check = checks.read(CORPUS, "verified")
        check["runs"]["report"]["status"] = "running"  # as a server that stopped mid-run leaves it
        checks.save(CORPUS, check)
        r = await client.post(f"/api/ws/{CORPUS}/checks/verified/runs/report/stop")
        assert r.json()["runs"]["report"]["status"] == "stopped"
    check = checks.read(CORPUS, "verified")
    check["runs"]["report"].update(status="running", waiting="writer")
    checks.save(CORPUS, check)
    assert checks.mark_interrupted(config.WORKSPACES_DIR) == [f"{CORPUS}/verified/report"]
    rec = checks.read(CORPUS, "verified")["runs"]["report"]
    assert rec["status"] == "failed" and rec["summary"] == checks.INTERRUPTED and "waiting" not in rec
    assert checks.mark_interrupted(config.WORKSPACES_DIR) == []
