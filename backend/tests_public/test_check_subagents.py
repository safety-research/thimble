"""Report checks as subagents of main (checks.py): a writer's end starts each shown check on its document through
thimble's module, as a follow-on start of the writer's own, at most MAX_SESSIONS at once, each with its task file in
check-work/; the analyst's own edits start nothing and mark the checks stale with the count of passages that changed;
Run is a click; main's run_check gives the exact Agent call. A run's end supersedes its check's earlier comments on the
passages it covered and records their fingerprints. The module is the fake bridge (subagent_fakes); an agent's end is
subagents.run_ended."""
from __future__ import annotations

import asyncio
import sys

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
    assert path.read_text().strip() in spawn["prompt"] and spawn["role"] == "check"
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


async def test_a_module_start_gives_the_check_its_whole_task_and_a_typed_start_names_its_files(doc, bridge, monkeypatch):
    """Bug hunt F2: in Manual mode each Read of a file outside the analyst's folder is a permission ask, and checks
    reading their task files made 42 of one session's 87 asks. A run the module starts gets its whole task in its
    prompt, with its work folder, so it reads no file for it: 0 Read calls, where it made one per part (six in that
    session's workspace). Its chat keeps only the prompt's lead, and its request in subagents.json the start of it once
    its agent started. A typed start (main's run_check), whose Agent call main types out, still names its files."""
    from app import read_parts

    monkeypatch.setattr(read_parts, "READ_UNITS", 300)  # a large workspace: the task in several parts
    await _write()
    await _started("unverified")
    [spawn] = bridge.ops("spawn")
    work = checks.work_dir(CORPUS, "unverified", "report")
    files = read_parts.paths(work / checks.TASK_FILE, len(list(work.glob("task*.md"))))
    assert len(files) > 1 and all(p.is_file() for p in files)
    task = "".join(p.read_text() for p in files).strip()
    prompt = spawn["prompt"]
    assert task in prompt and str(work) in prompt
    assert not any(str(p) in prompt for p in files), "no task file to read: before, one Read per part"
    row = checks.prompt_row(prompt)
    assert str(work) in row and "report:report" not in row and len(row) < 1_000
    req = subagents.request(CORPUS, spawn["request"])
    assert req["input"]["prompt"] == prompt[:subagents.STARTED_PROMPT_CHARS]
    assert req["input"]["prompt_chars"] == len(prompt)

    rec = await checks.start_run(CORPUS, "judgment", "report", force=True, route=checks.TYPED, call="toolu_main1")
    typed = rec["_answer"]["input"]["prompt"]
    jwork = checks.work_dir(CORPUS, "judgment", "report")
    jfiles = read_parts.paths(jwork / checks.TASK_FILE, len(list(jwork.glob("task*.md"))))
    assert len(jfiles) > 1 and typed.index(str(jfiles[0])) < typed.index(str(jfiles[-1]))
    assert len(typed) < 2_000 and len(bridge.ops("spawn")) == 1, "main makes the typed Agent call"


async def test_bug_hunt_i12_a_typed_start_keeps_the_check_s_whole_task_for_the_module_to_give_its_agent(
        doc, bridge, monkeypatch):
    """Bug hunt I12: a check main started with run_check still read task.md and task-2.md before its first command, a
    permission ask each in Manual mode. Main's Agent call stays short and names the files, and the request keeps the
    whole task, as a module start's prompt gives it, in the trusted folder, which the module's spawn hook gives the
    agent in its place; the module's view of the request says so, and the file goes once the agent started."""
    from app import read_parts
    from app import subagent_files as sf
    from subagent_fakes import real_bridge

    monkeypatch.setattr(read_parts, "READ_UNITS", 300)  # the task in several parts
    await _write()
    rec = await checks.start_run(CORPUS, "judgment", "report", force=True, route=checks.TYPED, call="toolu_main1")
    rid = rec["_answer"]["request"]
    typed = rec["_answer"]["input"]["prompt"]
    work = checks.work_dir(CORPUS, "judgment", "report")
    files = read_parts.paths(work / checks.TASK_FILE, len(list(work.glob("task*.md"))))
    assert str(files[0]) in typed and len(typed) < 2_000, "main types the short prompt"
    whole = sf.inline_path(config.workspace_dir(CORPUS), rid)
    text = whole.read_text()
    task = "".join(p.read_text() for p in files).strip()
    assert text.split("\n", 1)[0] == typed.split("\n", 1)[0] and rid in text.split("\n", 1)[0], "the same request line"
    assert task in text and not any(str(p) in text for p in files), "the whole task, no file to read"
    assert (whole.stat().st_mode & 0o777) == 0o600
    assert subagents.request(CORPUS, rid)["inline"] is True
    assert real_bridge._typed(subagents.read(CORPUS))[rid]["inline"] is True
    with subagents.update(CORPUS) as state:  # the SubagentStart hook took up the start
        sf._take(state, "aCheck1", rid, sf.requests(state)[rid], "")
    subagents.hook_started(CORPUS, {"agent_id": "aCheck1"})
    assert not whole.exists(), "the whole prompt goes once the agent started"


def test_a_module_request_s_prompt_goes_once_the_request_ended():
    """On local transport a spawn's arguments wait in subagents.json, which every hook reads: once the module answered
    or the request expired, its prompt (a check's whole task) goes, and its other arguments stay."""
    from app import subagent_files as files

    state: dict = {}
    rid = files.add_module_request(state, "spawn", {"role": "check", "prompt": "x" * 50_000, "description": "d"}, "s", 5.0)
    files.end_module_request(state, rid, "answered")
    r = files.requests(state)[rid]
    assert r["args"] == {"role": "check", "description": "d"} and r["state"] == "done"


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


async def test_k8_a_check_due_while_thimble_is_off_waits_and_starts_once_it_is_on(doc, bridge, monkeypatch):
    """Bug hunt round 10, K8: /plugin off while an answer's checks were due failed each with a notice "… failed:
    thimble's agents can't start in this session: … it stopped polling. Main, its threads, cards and labels still work.
    Try again in a few seconds", shown beside the page's line that thimble is off, and nothing ran the check once thimble
    was on again. /plugin off is no end of the session (H19): a follow-on run waits while main's module does not answer
    in a session that runs, its record `waiting` off, tells no failure, and starts once thimble is on again."""
    from app import module_bridge as real_bridge
    from app import notices

    monkeypatch.setattr(subagents, "MODULE_BACK_POLL_S", 0.01)
    await _write()
    bridge.is_live, bridge.runs = False, True
    bridge.reason = f"{real_bridge.NOT_ANSWERING}; it stopped polling"
    await checks.start_run(CORPUS, "unverified", "report", force=True, route=subagents.FOLLOW_ON)
    await _until(lambda: _run("unverified").get("waiting") == checks.WAITING_OFF, "the run does not wait for thimble")
    await asyncio.sleep(0.1)
    assert not bridge.ops("spawn") and _run("unverified")["status"] == "running"
    key = notices.agent_key(checks.session_key("unverified", "report"))
    assert not [n for n in notices.open_notices(CORPUS) if n.get("key") == key], "no failure while thimble is off"
    bridge.is_live, bridge.reason = True, ""  # /plugin on again
    await _until(lambda: len(bridge.ops("spawn")) == 1, "the check never started once thimble was on")
    assert _run("unverified")["status"] == "running" and "waiting" not in _run("unverified")
    assert not [n for n in notices.open_notices(CORPUS) if n.get("key") == key]

    # a start the module did not answer as thimble went off (its request expired) waits too, with no failure either
    key = notices.agent_key(checks.session_key("judgment", "report"))
    real_request = bridge.request

    async def gone(c, op, **args):
        if op != "spawn":
            return await real_request(c, op, **args)
        bridge.calls.append((op, args))
        bridge.is_live, bridge.reason = False, f"{real_bridge.NOT_ANSWERING}; it stopped polling"
        return {"no-module": bridge.reason}

    fake = sys.modules["app.module_bridge"]
    monkeypatch.setattr(fake, "request", gone)
    await checks.start_run(CORPUS, "judgment", "report", force=True, route=subagents.FOLLOW_ON)
    await _until(lambda: _run("judgment").get("waiting") == checks.WAITING_OFF, "the expired start does not wait")
    assert not [n for n in notices.open_notices(CORPUS) if n.get("key") == key] and _run("judgment")["status"] == "running"
    monkeypatch.setattr(fake, "request", real_request)
    bridge.is_live, bridge.reason = True, ""
    await _until(lambda: len(bridge.ops("spawn")) == 3, "the expired check never started again")
    assert _run("judgment")["agent_id"] and not [n for n in notices.open_notices(CORPUS) if n.get("key") == key]
