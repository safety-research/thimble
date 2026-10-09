"""Report checks as subagents of main (checks.py): a writer's end starts each shown check on its document through
thimble's module, as a follow-on start of the writer's own, at most MAX_SESSIONS at once, each with its task file in
check-work/; the analyst's own edits start nothing and mark the checks stale with the count of passages that changed;
Run is a click; main's run_check gives the exact Agent call. A run's end supersedes its check's earlier comments on the
passages it covered and records their fingerprints. The module is the fake bridge (subagent_fakes); an agent's end is
subagents.run_ended."""
from __future__ import annotations

import asyncio
import json

import pytest
from fastapi.testclient import TestClient

from app import agents, checks, config, investigation, report_types, subagents, tools
from app import subagent_files as sf
from subagent_fakes import bridge  # noqa: F401 — a fixture

CORPUS = "mini"
TEXT = ("# One account did it\n\n## One account\n\nAll the deletions came from one account. It ran at night.\n\n"
        "## Caveats\n\nThe log covers one week.\n")


@pytest.fixture()
def doc(workspaces_tmp, monkeypatch):
    """The checks `unverified` and `judgment` on, on Settings' checks row; each test writes the report (_write)."""
    rows = {"checks": {"model": "claude-opus-5-5", "effort": "high", "fast": False}}
    real = config.models_for
    monkeypatch.setattr(config, "models_for", lambda c=None: {**real(c), **{k: dict(v) for k, v in rows.items()}})
    for cid in ("unverified", "judgment"):
        checks.edit(CORPUS, cid, shown=True)
    checks.edit(CORPUS, "you-should-know", shown=False)  # the built-in thimble ships on: these two are the shown checks


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


async def test_in_plan_mode_a_writer_s_end_holds_its_checks_which_say_so_and_start_after(doc, bridge, monkeypatch):
    """Live check L21: the runs a writer's end starts wait while main is in plan mode; their rows said they waited for
    a free session. Their records say `waiting: plan` meanwhile, and they start once main leaves plan mode."""
    from app import session

    mode = {"now": "plan"}
    monkeypatch.setattr(session, "main_mode", lambda c: mode["now"])

    async def out_of_plan(c, poll_s=2.0):  # subagents.out_of_plan, polled fast, with main's session there
        while mode["now"] == "plan":
            await asyncio.sleep(0.01)

    monkeypatch.setattr(subagents, "out_of_plan", out_of_plan)
    await _write()
    _writer_done()
    await _until(lambda: _run("unverified").get("waiting") == checks.WAITING_PLAN, "the run did not say it waits")
    await asyncio.sleep(0.05)
    assert not bridge.ops("spawn"), "nothing starts in plan mode"
    mode["now"] = "auto"
    await _until(lambda: len(bridge.ops("spawn")) == 2, "the held checks never started")
    assert "waiting" not in _run("unverified") or _run("unverified")["waiting"] != checks.WAITING_PLAN


async def test_the_analyst_s_edit_starts_nothing_and_marks_the_checks_stale_with_the_count(doc, bridge):
    await _write()
    _writer_done()
    await _until(lambda: len(bridge.ops("spawn")) == 2, "the checks never started")
    for cid in ("unverified", "judgment"):
        subagents.run_ended(CORPUS, _run(cid)["agent_id"], "done", "Done.", source="handback")
    await _until(lambda: all(_run(c)["status"] == "done" for c in ("unverified", "judgment")), "the runs never ended")
    await _write(TEXT.replace("It ran at night.", "It ran in the morning."))
    assert len(bridge.ops("spawn")) == 2, "an edit starts no run"
    assert _run("unverified")["stale"] == 1 and _run("judgment")["stale"] == 1, "one paragraph changed"


async def test_run_is_a_click_that_starts_one_and_stop_goes_through_the_module(doc, bridge):
    await _write()
    act = await _started("judgment")
    assert len(bridge.ops("spawn")) == 1
    assert subagents.request(CORPUS, bridge.ops("spawn")[0]["request"])["route"] == "click"
    await checks.stop(act)
    assert bridge.ops("stop")[0]["agent"] == act.agent
    subagents.run_ended(CORPUS, act.agent, "stopped", "", source="notification")
    assert _run("judgment")["status"] == "stopped"


async def test_main_s_run_check_gives_the_exact_agent_call(doc, bridge):
    await _write()
    res = await tools.call(CORPUS, "run_check", {"name": "Judgment"}, tool_use_id="toolu_main1")
    assert not res.is_error, res.text
    inp = json.loads(res.text.split("AGENT CALL ", 1)[1].splitlines()[0])
    assert inp["subagent_type"] == "thimble:check" and not bridge.ops("spawn")
    rid = sf.REQUEST_RE.search(inp["prompt"].split("\n", 1)[0]).group(0)
    req = subagents.request(CORPUS, rid)
    assert (req["route"], req["call"]) == ("typed", "toolu_main1")
    with subagents.update(CORPUS) as state:
        assert sf.check_call(state, {"tool_name": "Agent", "tool_use_id": "toolu_x", "tool_input": inp}) is None


async def test_a_run_s_end_supersedes_its_covered_comments_and_records_what_it_saw(doc, bridge):
    await _write()
    first = await _started("judgment")
    key = checks.session_key("judgment", "report")
    d = report_types.read_doc(CORPUS, investigation.MAIN, "report")
    sid = report_types.all_sentences(d)[0]["id"]
    tid = "toolu_c1"
    sf.add_caller(config.workspace_dir(CORPUS), tid, first.agent, "thimble:check")
    res = await tools.call(CORPUS, "add_comment", {"ref": f"report:report#{sid}", "text": "No card shows this."},
                           session=key, tool_use_id=tid)
    assert not res.is_error, res.text
    subagents.run_ended(CORPUS, first.agent, "done", "Commented on 1 passage.", source="handback")
    assert _run("judgment")["comments"] == 1 and len(_run("judgment")["seen"]) == len(first.fps)
    second = await _started("judgment")
    subagents.run_ended(CORPUS, second.agent, "done", "Commented on 0 passages.", source="handback")
    d = report_types.read_doc(CORPUS, investigation.MAIN, "report")
    [cm] = [c for c in d.get("comments") or [] if c.get("check") == "judgment"]
    assert cm["status"] != "open" and cm["superseded_by"] == second.run


async def test_a_run_main_s_plan_mode_held_at_its_end_fails_saying_why_and_supersedes_nothing(doc, bridge):
    """Main went into plan mode while a check ran, and thimble stopped nothing, as Claude Code stops no subagent then:
    the check's agent followed main and could only read and plan, so it may not have commented where it would have.
    Its run ends failed with the line that says why and to choose Re-run, not done, and the check's earlier comments
    on the passages it covered stay open."""
    await _write()
    first = await _started("judgment")
    key = checks.session_key("judgment", "report")
    d = report_types.read_doc(CORPUS, investigation.MAIN, "report")
    sid = report_types.all_sentences(d)[0]["id"]
    sf.add_caller(config.workspace_dir(CORPUS), "toolu_p1", first.agent, "thimble:check")
    res = await tools.call(CORPUS, "add_comment", {"ref": f"report:report#{sid}", "text": "No card shows this."},
                           session=key, tool_use_id="toolu_p1")
    assert not res.is_error, res.text
    subagents.run_ended(CORPUS, first.agent, "done", "Commented on 1 passage.", source="handback")
    second = await _started("judgment")
    subagents.saw_plan_mode(CORPUS, second.agent)
    subagents.run_ended(CORPUS, second.agent, "done", "My plan is in the plan file.", source="handback")
    line = subagents.plan_failed_line("check")
    assert (_run("judgment")["status"], _run("judgment")["summary"]) == ("failed", line)
    assert line.endswith(", then choose Re-run on the check.")
    d = report_types.read_doc(CORPUS, investigation.MAIN, "report")
    [cm] = [c for c in d.get("comments") or [] if c.get("check") == "judgment"]
    assert (cm.get("status") or "open") == "open" and not cm.get("superseded_by")


async def test_a_start_at_the_subagent_limit_waits_and_a_refused_one_fails_with_its_refusal(doc, bridge, monkeypatch):
    monkeypatch.setattr(checks, "LIMIT_RETRY_S", 0.05)
    await _write()
    bridge.answers.append({"limit": "Claude Code runs at most 20 concurrent subagents"})
    await checks.start_run(CORPUS, "judgment", "report", force=True, route="click")
    await _until(lambda: len(bridge.ops("spawn")) == 2, "the start was never tried again")
    assert _run("judgment")["status"] == "running" and _run("judgment")["agent_id"]
    bridge.answers.append({"deny": "PreToolUse:Agent hook error: PLAN MODE"})
    await _started("unverified")
    assert _run("unverified")["status"] == "failed" and _run("unverified")["refused"]["kind"] == "hook"


async def test_a_run_whose_agent_runs_on_across_a_server_restart_takes_its_place_again(doc, bridge, monkeypatch):
    await _write()
    agent = (await _started("judgment")).agent
    monkeypatch.setattr(checks, "_active", {})
    assert checks.recover() == []
    assert checks._active[(CORPUS, "judgment", "report")].agent == agent
    with subagents.update(CORPUS) as state:
        sf.registry(state)[agent]["status"] = "done"
    monkeypatch.setattr(checks, "_active", {})
    assert checks.recover() == [f"{CORPUS}/judgment/report"]
    assert _run("judgment")["status"] == "stopped"


async def test_main_s_quit_stops_a_queued_run_and_its_agent_s_end_stops_a_running_one(doc, bridge, monkeypatch):
    monkeypatch.setattr(checks, "MAX_SESSIONS", 1)
    await _write()
    await _started("judgment")
    await checks.start_run(CORPUS, "unverified", "report", force=True, route="click")
    assert _run("unverified").get("waiting") == checks.WAITING_QUEUED
    assert checks.stop_workspace(CORPUS) == 1
    subagents.close_running(CORPUS)
    assert _run("judgment")["status"] == "stopped" and _run("unverified")["status"] == "stopped"
    await asyncio.sleep(0.05)
    assert len(bridge.ops("spawn")) == 1, "nothing starts in a stopped run's place"


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


async def test_in_terminal_mode_each_process_takes_up_a_run_from_the_check_s_file(doc, bridge, monkeypatch):
    """Terminal mode has no server to hold a run: main's run_check starts it in the shim, a hook's process hears its
    agent start and end, and the shim takes its comments. Each process takes the run up from the check's file, so its
    comments land and its end is recorded, and a process that held it lets it go once another ended it (live check
    T6: a typed check stayed `running` for good, and the next writer's end started no check)."""
    from terminal_fakes import write_launch

    write_launch(config.workspace_dir(CORPUS))
    await _write()
    res = await tools.call(CORPUS, "run_check", {"name": "Judgment"}, tool_use_id="toolu_main1")
    assert not res.is_error, res.text
    shim = dict(checks._active)  # the shim's process: it started the run
    key = checks.session_key("judgment", "report")
    monkeypatch.setattr(checks, "_active", {})  # a hook's process: the agent starts
    checks.subagent_started(CORPUS, subagents.Run(CORPUS, key, "check", "c0ffee00", "agentcheck1"), {})
    assert _run("judgment")["agent_id"] == "agentcheck1"
    monkeypatch.setattr(checks, "_active", dict(shim))  # the shim again: the agent comments
    d = report_types.read_doc(CORPUS, investigation.MAIN, "report")
    sid = report_types.all_sentences(d)[0]["id"]
    sf.add_caller(config.workspace_dir(CORPUS), "toolu_c1", "agentcheck1", "thimble:check")
    res = await tools.call(CORPUS, "add_comment", {"ref": f"report:report#{sid}", "text": "No card shows this."},
                           session=key, tool_use_id="toolu_c1")
    assert not res.is_error, res.text
    monkeypatch.setattr(checks, "_active", {})  # another hook's process: the agent ends
    checks.subagent_ended(CORPUS, subagents.Run(CORPUS, key, "check", "c0ffee00", "agentcheck1"), "done", "One comment.")
    assert (_run("judgment")["status"], _run("judgment")["comments"]) == ("done", 1)
    monkeypatch.setattr(checks, "_active", dict(shim))  # the shim lets go of the run that ended elsewhere
    assert not checks.running(CORPUS, "judgment", "report") and checks._active == {}
    await _write(TEXT + "\n## Later\n\nA second account joined in the second week.\n")
    _writer_done()  # a writer's end starts the shown checks on what they have not seen, this one among them
    await _until(lambda: _run("judgment")["status"] == "running" and _run("judgment")["run"] != shim[
        (CORPUS, "judgment", "report")].run, "the writer's end started no run of judgment")


async def test_in_terminal_mode_a_run_counts_the_comments_the_shim_took(doc, bridge, monkeypatch):
    """A writer's end starts a check in a hook's process, which holds the run until its agent ends; the agent's comments
    go through the shim, another process. The run's end counts the comments its document holds (live check T6: a
    check that left a comment recorded none)."""
    from terminal_fakes import write_launch

    write_launch(config.workspace_dir(CORPUS))
    await _write()
    hook = await _started("judgment")  # the hook's process holds it
    held = dict(checks._active)
    key = checks.session_key("judgment", "report")
    monkeypatch.setattr(checks, "_active", {})  # the shim takes the agent's comment
    d = report_types.read_doc(CORPUS, investigation.MAIN, "report")
    sid = report_types.all_sentences(d)[0]["id"]
    sf.add_caller(config.workspace_dir(CORPUS), "toolu_c1", hook.agent, "thimble:check")
    res = await tools.call(CORPUS, "add_comment", {"ref": f"report:report#{sid}", "text": "No card shows this."},
                           session=key, tool_use_id="toolu_c1")
    assert not res.is_error, res.text
    monkeypatch.setattr(checks, "_active", held)  # back in the hook's process: the agent ends
    subagents.run_ended(CORPUS, hook.agent, "done", "Commented on 1 passage.", source="handback")
    assert (_run("judgment")["status"], _run("judgment")["comments"]) == ("done", 1)
