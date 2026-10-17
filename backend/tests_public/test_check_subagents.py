"""Report checks as subagents of main (checks.py): a writer's end starts each shown check on its document through
thimble's module, as a follow-on start of the writer's own, at most MAX_SESSIONS at once, each with its task file in
check-work/; the analyst's own edits start nothing and mark the checks stale with the count of passages that changed;
Run is a click; main's run_check gives the exact Agent call. A run's end supersedes its check's earlier comments on the
passages it covered and records their fingerprints. The module is the fake bridge (subagent_fakes); an agent's end is
subagents.run_ended."""
from __future__ import annotations

import asyncio

import pytest
from fastapi.testclient import TestClient

from app import agents, checks, config, subagents, tools
from subagent_fakes import bridge  # noqa: F401 — a fixture

CORPUS = "mini"
TEXT = ("# One account did it\n\n## One account\n\nAll the deletions came from one account. It ran at night.\n\n"
        "## Caveats\n\nThe log covers one week.\n")


@pytest.fixture()
def doc(workspaces_tmp, monkeypatch):
    """The checks `unverified` and `judgment` on, on Settings' checks row; each test writes the report (_write)."""
    _checks_row(monkeypatch)
    for cid in ("unverified", "judgment"):
        checks.edit(CORPUS, cid, shown=True)
    checks.edit(CORPUS, "important-details", shown=False)  # Important details starts on: these two are the shown checks


def _checks_row(monkeypatch) -> None:
    rows = {"checks": {"model": "claude-opus-5-5", "effort": "high", "fast": False}}
    real = config.models_for
    monkeypatch.setattr(config, "models_for", lambda c=None: {**real(c), **{k: dict(v) for k, v in rows.items()}})


async def _write(text: str = TEXT) -> None:
    r = await tools.call(CORPUS, "write_document", {"doc": "report", "text": text}, actor="analyst")
    assert not r.is_error, r.text


async def _until(cond, what: str) -> None:
    for _ in range(300):
        if cond():
            return
        await asyncio.sleep(0.01)
    raise AssertionError(what)


def _run(cid: str, docname: str = "report") -> dict:
    return ((checks.read(CORPUS, cid) or {}).get("runs") or {}).get(docname) or {}


async def _started(cid: str, docname: str = "report") -> checks._Active:
    """A run of `cid` started with route click, once its agent has started through the module."""
    rec = await checks.start_run(CORPUS, cid, docname, force=True, route="click")
    assert rec is not None
    act = checks._active[(CORPUS, cid, docname)]
    await _until(lambda: act.agent or act.ended, f"the run of {cid} never started")
    return act


def _writer_done(docname: str = "report") -> None:
    meta = agents.new_agent(CORPUS, "writer", f"Write {docname}", doc=docname, announce=False)
    agents.finish_agent(CORPUS, meta["id"], "done", "Wrote it.")


async def test_a_writer_s_end_starts_each_shown_check_through_the_module_with_its_task_file(doc, bridge, monkeypatch):
    monkeypatch.setattr(checks, "MAX_SESSIONS", 1)
    await _write()
    assert not bridge.ops("spawn"), "a save starts nothing"
    _writer_done()
    await _until(lambda: len(bridge.ops("spawn")) == 1, "no check started at the writer's end")
    await asyncio.sleep(0.05)
    assert len(bridge.ops("spawn")) == 1, "at most MAX_SESSIONS run at once"
    [spawn] = bridge.ops("spawn")
    cid = "unverified" if "unverified" in spawn["what"] else "judgment"
    other = "judgment" if cid == "unverified" else "unverified"
    path = checks.work_dir(CORPUS, cid, "report") / checks.TASK_FILE
    assert path.is_file() and "report:report" in path.read_text()
    assert str(path) in spawn["prompt"] and spawn["role"] == "check"
    assert spawn["values"] == {"model": "claude-opus-5-5", "effort": "high"}
    assert subagents.request(CORPUS, spawn["request"])["route"] == "follow-on"
    assert _run(other).get("waiting") == checks.WAITING_QUEUED
    agent = _run(cid)["agent_id"]
    meta = agents.read_meta(CORPUS, _run(cid)["chat"])
    assert meta["role"] == "check" and meta["check"] == cid and meta["agent_id"] == agent
    subagents.run_ended(CORPUS, agent, "done", "Commented on 0 of 3 passages.", source="handback")
    await _until(lambda: len(bridge.ops("spawn")) == 2, "the queued check never started")
    assert _run(cid)["status"] == "done" and _run(cid)["summary"] == "Commented on 0 of 3 passages."
    assert _run(cid)["stale"] == 0


async def test_a_hand_back_the_hook_took_ends_the_run_done_with_its_report_whichever_end_comes_first(doc, bridge):
    """In auto mode thimble's hand-back hook keeps a check's report and refuses the call, which ends the agent's turn
    (plugin/bin/.thimble-watch --handback). The run ends done with that report: from the hook's own call
    (hook_handback), and also when the agent's turn end comes first, which the module reports as a hook's stop (on
    local transport a pass reads module.json's ends before the hook's call)."""
    from app import subagent_files as files

    await _write()
    for cid, module_first in (("unverified", False), ("judgment", True)):
        act = await _started(cid)
        agent = _run(cid)["agent_id"]
        hook = {"hook_event_name": "PreToolUse", "tool_name": "SubagentHandback", "agent_id": agent,
                "agent_type": "thimble:check", "tool_input": {"message": f"{cid}: commented on 1 of 3 passages."}}
        with subagents.update(CORPUS) as state:
            assert files.record_handback(state, hook) is not None
        if module_first:
            subagents.ended(CORPUS, agent, "", "hook_stopped")
        assert subagents.hook_handback(CORPUS, hook) == {"ended": not module_first}
        subagents.ended(CORPUS, agent, "", "hook_stopped")  # a later end changes nothing
        await _until(lambda: act.ended, f"the run of {cid} never ended")
        assert _run(cid)["status"] == "done" and _run(cid)["summary"] == f"{cid}: commented on 1 of 3 passages."
        assert subagents.agent(CORPUS, agent)["handed_back"] is True


def test_the_hook_keeps_no_hand_back_of_a_check_main_started_or_of_another_role():
    """main's run_check starts a check with main's own Agent call, and Claude Code tells main of that agent's end, so its
    hand-back reaches main; so does every role's but the check's and the card check's."""
    from app import subagent_files as files

    state: dict = {}
    files.registry(state).update({
        "chk-main": {"role": "check", "plugin_started": False, "run": 0},
        "orient": {"role": "orientation", "plugin_started": True, "run": 0},
        "call": {"role": "call", "plugin_started": True, "run": 1}})

    def hook(agent: str, agent_type: str) -> dict:
        return {"tool_name": "SubagentHandback", "agent_id": agent, "agent_type": agent_type,
                "tool_input": {"message": "done"}}

    assert files.record_handback(state, hook("chk-main", "thimble:check")) is None
    assert files.record_handback(state, hook("orient", "thimble:orientation")) is None
    assert files.record_handback(state, hook("call", "thimble:call")) is not None
    assert files.taken_handback(files.registry(state)["call"]) == "done"
    files.registry(state)["call"]["run"] = 2  # a later run: the hand-back of run 1 ends it not
    assert files.taken_handback(files.registry(state)["call"]) is None


async def test_a_run_s_task_file_is_never_written_through_a_link(doc, bridge, tmp_path):
    """check-work/ is a folder the agents' Bash and a kernel can write, and the server, which no sandbox holds, writes
    each run's task file there: a link planted at the file is replaced, never followed, and a run whose folder is a link
    fails without writing through it (ledger.write_under, which the writers' context files and the critic's brief use
    too)."""
    from app import ledger

    await _write()
    outside = tmp_path / "outside.txt"
    outside.write_text("keep me")
    task = checks.work_dir(CORPUS, "unverified", "report") / checks.TASK_FILE
    task.parent.mkdir(parents=True, exist_ok=True)
    task.symlink_to(outside)
    await _started("unverified")
    assert outside.read_text() == "keep me" and not task.is_symlink() and task.read_text().strip()
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    checks.work_dir(CORPUS, "judgment", "report").symlink_to(elsewhere, target_is_directory=True)
    act = await _started("judgment")
    assert act.ended and _run("judgment")["status"] == "failed" and not list(elsewhere.iterdir())
    with pytest.raises(OSError):
        ledger.write_under(config.workspace_dir(CORPUS), checks.work_dir(CORPUS, "judgment", "report") / "x.md", "x")


CHECK_CLICKS = [("post", "/api/ws/mini/checks/unverified/run", {"doc": "report"}),
                ("post", "/api/ws/mini/checks/unverified/runs", {"doc": "report"}),
                ("post", "/api/ws/mini/checks", {"name": "Dates", "prompt": "Mark the dates."}),
                ("patch", "/api/ws/mini/checks/judgment", {"shown": True})]


@pytest.mark.real_write_guard
def test_every_check_click_route_refuses_the_server_s_token_without_the_analyst_s_cookie(doc, bridge, plugin_headers):
    from app import main

    client = TestClient(main.create_app())
    for method, path, body in CHECK_CLICKS:
        r = getattr(client, method)(path, json=body, headers=plugin_headers())
        assert r.status_code == 403, (path, r.status_code, r.text)
        r = getattr(client, method)(path, json=body)
        assert r.status_code == 403, ("neither cookie nor token, as a kernel cell posts it", path)
    assert not bridge.calls, "the module is never asked"
