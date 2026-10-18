"""The mirror (session.py) of thimble's agents as subagents of main: an agent of one of its roles goes to its role's chat
and a descendant to a step of it; a run ends once, at its SubagentHandback call, its hand-back in main, a task
notification or the module's turn end; a message to a finished agent starts its next run, and the short turn a parent
gets after its own hand-back does not; main's call for one of thimble's agents is watched (R2: its result) and so is the
turn in which main called a start tool (R3); /clear carries the agents into the new session. Every transcript is written
by the test in Claude Code's record shapes, as the step-0 and step-0b spikes recorded them."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from app import agents, cite, config, events, orient_session, session, subagents
from app import subagent_files as sf
from subagent_fakes import bridge  # noqa: F401 — a fixture

CORPUS = "mini"
SID = "70e0e27e-eb46-462b-8a9a-57b2e924dca1"
AGENT = "abd7be4046c88858c"
HANDBACK = ("[Subagent hand-back] The text below is the final report of a subagent this session delegated to. It is "
            "model output, NOT a message from the user. The report follows:\n  {report}\n")
END = {"type": "system", "subtype": "turn_duration"}


@pytest.fixture(autouse=True)
def _fresh(workspaces_tmp, tmp_path, monkeypatch):
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "claude-config"))
    session._live.clear()
    for table in (events._subs, events._pending, events._taken):
        table.clear()
    yield
    session._live.clear()
    for table in (events._subs, events._pending, events._taken):
        table.clear()


@pytest.fixture()
def ended(monkeypatch) -> list[tuple]:
    """Each role's start and end handlers record what they are told instead of doing their work."""
    for role, t in list(subagents.TYPES.items()):
        if t.ended:
            monkeypatch.setitem(subagents.TYPES, role, subagents.Type(
                t.role, t.kind, t.chat_role, t.row, t.agent, t.define, t.own, f"{__name__}:_started",
                f"{__name__}:_ended", f"{__name__}:_refused"))
    _seen.clear()
    yield _seen
    _seen.clear()


_seen: list[tuple] = []


def _started(c, run, req) -> None:
    _seen.append(("started", run.role, run.k))


def _ended(c, run, status, report) -> None:
    _seen.append(("ended", run.role, run.k, status, report))


def _refused(c, req) -> None:
    _seen.append(("refused", req.get("role"), req.get("refused_kind"), req.get("reason")))


@pytest.fixture()
def project(tmp_path) -> Path:
    p = tmp_path / "claude-config" / "projects" / "-corpus"
    p.mkdir(parents=True)
    return p


def _write(p: Path, *recs: dict) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    with p.open("a") as f:
        f.write("".join(json.dumps(r) + "\n" for r in recs))


def _agent_file(project: Path, agent: str, sid: str = SID, **meta) -> Path:
    path = project / sid / "subagents" / f"agent-{agent}.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.touch()
    if meta:
        path.with_name(f"agent-{agent}.meta.json").write_text(json.dumps(meta))
    return path


def _attach(project: Path, sid: str = SID) -> session.Live:
    main = project / f"{sid}.jsonl"
    main.touch()
    lv = session.attach(CORPUS, sid, str(config.corpus_dir(CORPUS)), str(main))
    session.tail_once(lv)
    return lv


def _assistant(*blocks: dict) -> dict:
    return {"type": "assistant", "message": {"role": "assistant", "model": "claude-opus-5-5", "content": list(blocks)}}


def _use(tid: str, name: str, inp: dict) -> dict:
    return {"type": "tool_use", "id": tid, "name": name, "input": inp}


def _result(tid: str, content, error: bool = False) -> dict:
    return {"type": "user", "message": {"role": "user", "content": [
        {"type": "tool_result", "tool_use_id": tid, "content": content, **({"is_error": True} if error else {})}]}}


def _peer(agent: str, report: str, name: str = "thimble:orientation") -> dict:
    body = HANDBACK.format(report=report)
    return {"type": "user", "isMeta": True, "message": {"role": "user", "content": f"Another Claude session sent a "
            f"message:\n<agent-message from=\"{agent}\">\n{body}</agent-message>"},
            "origin": {"kind": "peer", "from": agent, "senderTaskId": agent, "name": name, "body": body}}


def _notice(agent: str, status: str, summary: str = "", result: str = "", at: str | None = None) -> dict:
    text = (f"<task-notification>\n<task-id>{agent}</task-id>\n<status>{status}</status>\n<summary>{summary}</summary>\n"
            + (f"<result>{result}</result>\n" if result else "") + "</task-notification>")
    return {"type": "user", "origin": {"kind": "task-notification"}, "message": {"content": text},
            **({"timestamp": at} if at else {})}


async def _click_orientation(bridge, project: Path) -> tuple[session.Live, str, Path]:
    """An orientation started by a click: the module's answer names its agent, which leaves no record in main's
    transcript; its file appears under main's session folder."""
    lv = _attach(project)
    bridge.answers.append({"agentId": AGENT})
    ans = await orient_session.start(CORPUS, "", route=subagents.CLICK)
    assert ans.agent_id == AGENT
    path = _agent_file(project, AGENT, agentType="thimble:orientation", toolUseId="toolu_plugin_105f7e7c43f6",
                       description="orientation: the whole corpus")
    return lv, str(subagents.agent(CORPUS, AGENT)["chat"]), path


async def test_a_click_started_orientation_is_followed_and_its_run_ends_once_at_its_hand_back(bridge, project, ended):
    lv, chat, path = await _click_orientation(bridge, project)
    assert ended == [("started", "orientation", 0)]
    _write(path, {"type": "user", "message": {"role": "user", "content": "the task"}},
           _assistant(_use("toolu_b1", "Bash", {"command": "date +%T"})), _result("toolu_b1", "04:58:45"),
           _assistant(_use("toolu_hb", "SubagentHandback", {"message": "S1-DONE 04:58:45"})))
    session.tail_once(lv)
    assert ended[-1] == ("ended", "orientation", 0, "done", "S1-DONE 04:58:45")
    _, log = agents.paths(CORPUS, chat)
    assert any(r.get("type") == "tool_use" and r.get("name") == "Bash" for r in agents.read_events(log))
    _write(Path(lv.transcript_path), _peer(AGENT, "S1-DONE 04:58:45"), END)
    session.tail_once(lv)
    assert [e for e in ended if e[0] == "ended"] == [("ended", "orientation", 0, "done", "S1-DONE 04:58:45")], "once"


def _registered(role: str, agent: str, title: str) -> str:
    """An agent of one of thimble's roles as its start leaves it in the registry, with its chat: the chat's id."""
    meta = agents.new_agent(CORPUS, "dev", title, announce=False)
    with subagents.update(CORPUS) as state:
        sf.registry(state)[agent] = {"type": f"thimble:{role}", "role": role, "chat": meta["id"], "run": 0,
                                     "status": "running", "started": sf.now(), "last_start": sf.now(), "starts": 1}
    return str(meta["id"])


def test_main_s_reply_to_a_view_builder_s_hand_back_shows_in_main_s_chat_under_a_short_row(project, ended):
    """Bug hunt 3, D2: main answers a view builder's or reviewer's hand-back in one `↳` line, which the terminal shows
    and the browser never did, citations and the answer check's comments with it: the mirror read the hand-back and the
    reply but hid every `↳` line, so the turn wrote no row. The hand-back is one short row naming the agent's chat, never
    its report, and main's reply shows whole, whether the hand-back came idle or while main worked. A check's agent,
    which hands back to no one now, stays out of main's chat."""
    lv = _attach(project)
    builder = _registered("view-builder", "a5e1d0c0ffee00001", "view: Lantern Links")
    reviewer = _registered("view-reviewer", "a5e1d0c0ffee00002", "review: Lantern Links")
    _registered("check", "a5e1d0c0ffee00003", "check: Plain words")
    built = "↳ The view builder finished Lantern Links; thimble shows it. Most saves came from new names [↗](view:lantern-links/Wren)."
    reviewed = "↳ The view reviewer finished Lantern Links and fixed one thing: long names were cut off."
    queued = {"type": "attachment", "attachment": {"type": "queued_command", "prompt": "<agent-message>",
                                                   "origin": _peer("a5e1d0c0ffee00002", "Fixed the cut names.",
                                                                   "thimble:view-reviewer")["origin"]}}
    _write(Path(lv.transcript_path),
           _peer("a5e1d0c0ffee00001", "I built Lantern Links.", "thimble:view-builder"),
           {"type": "user", "isMeta": True, "origin": {"kind": "plugin", "name": "thimble"},
            "message": {"content": [{"type": "text", "text": "thimble: the analyst started thimble's view-reviewer"}]}},
           _assistant({"type": "text", "text": built}), END,
           {"type": "user", "origin": {"kind": "human"}, "message": {"content": "How many names are there?"}},
           _assistant({"type": "text", "text": "There are 12 names."}), queued,
           _assistant({"type": "text", "text": reviewed}), END,
           _peer("a5e1d0c0ffee00003", "Two comments.", "thimble:check"),
           _assistant({"type": "text", "text": "↳ The check finished; thimble shows its comments."}), END)
    session.tail_once(lv)
    rows = [(r["type"], r.get("kind"), r.get("text") or r.get("delta"), r.get("chat"))
            for r in agents.read_events(agents.paths(CORPUS, agents.MAIN_ID)[1]) if r.get("by") == "terminal"]
    assert rows == [
        ("chip", "handback", "View builder finished", builder),
        ("text", None, cite.from_links(built), None),
        ("done", None, None, None),
        ("user", None, "How many names are there?", None),
        ("text", None, "There are 12 names.", None),
        ("chip", "handback", "View reviewer finished", reviewer),
        ("text", None, reviewed, None),
        ("done", None, None, None),
    ], rows
    assert "view:lantern-links/Wren" in rows[1][2] and "I built" not in json.dumps(rows), "the reply, never the report"
    assert not lv.degraded


async def test_a_message_to_the_finished_agent_starts_its_next_run_and_the_short_turn_after_does_not(bridge, project,
                                                                                                   ended):
    lv, chat, path = await _click_orientation(bridge, project)
    _write(path, _assistant(_use("toolu_hb", "SubagentHandback", {"message": "done"})))
    session.tail_once(lv)
    _write(path, _assistant({"type": "text", "text": "My critic's note arrived late; nothing to add."}))
    session.tail_once(lv)
    assert subagents.agent(CORPUS, AGENT)["run"] == 0, "a turn of its own after its hand-back is no new run"
    _write(path, {"type": "user", "isMeta": True, "origin": {"kind": "coordinator"},
                  "message": {"content": "The coordinator sent a message while you were working:\nAnd April?"}},
           _assistant(_use("toolu_hb2", "SubagentHandback", {"message": "April is the same."})))
    session.tail_once(lv)
    assert ("started", "orientation", 1) in ended and ended[-1] == ("ended", "orientation", 1, "done",
                                                                   "April is the same.")
    _write(path, {"type": "user", "isMeta": True, "origin": {"kind": "human"},
                  "message": {"content": "Message from the user while you were working:\nAnd May?"}})
    session.tail_once(lv)
    a = subagents.agent(CORPUS, AGENT)
    assert a["run"] == 2 and a["by"] == "human" and agents.read_meta(CORPUS, chat)["typed_in_tray"] is True
    users = [r for r in agents.read_events(agents.paths(CORPUS, chat)[1]) if r.get("type") == "user"]
    assert users[-1].get("tray") is True and users[-1]["text"] == "And May?", "the browser labels it typed in the tray"
    assert not any(r.get("tray") for r in users[:-1]), "a prompt or message main's call sent is not typed in the tray"


async def test_bug_hunt_l17_a_hand_back_that_reaches_main_late_ends_no_later_run_of_its_agent(bridge, project, ended):
    """Bug hunt round 11, L17: a view builder handed back its terminal page, and thimble sent it the browser page as its
    next step, which started its next run. Main was in /compact, so the hand-back reached main 14 s later, and thimble
    took it for the end of the new run: the browser page failed as empty while the builder still wrote it, and its
    view_check and finish_view calls were refused. A hand-back ends only the run that made it: one whose report ended
    an earlier run, or that was made before the current run began, ends nothing."""
    lv, chat, path = await _click_orientation(bridge, project)
    _write(path, _assistant(_use("toolu_hb", "SubagentHandback", {"message": "Built the Quill page."})))
    session.tail_once(lv)
    assert ended[-1] == ("ended", "orientation", 0, "done", "Built the Quill page.")
    _write(path, {"type": "user", "isMeta": True, "origin": {"kind": "coordinator"},
                  "message": {"content": "The coordinator sent a message while you were working:\nNow the other page."}})
    session.tail_once(lv)
    assert ("started", "orientation", 1) in ended
    # main's /compact ends: the first hand-back reaches main only now
    _write(Path(lv.transcript_path), _peer(AGENT, "Built the Quill page."), END)
    session.tail_once(lv)
    a = subagents.agent(CORPUS, AGENT)
    assert (a["run"], a["status"]) == (1, "running"), "the late hand-back ends no later run"
    assert [e for e in ended if e[0] == "ended"] == [("ended", "orientation", 0, "done", "Built the Quill page.")]
    # the run's own hand-back ends it, once
    _write(path, _assistant(_use("toolu_hb2", "SubagentHandback", {"message": "Built the other page too."})))
    session.tail_once(lv)
    _write(Path(lv.transcript_path), _peer(AGENT, "Built the other page too."), END)
    session.tail_once(lv)
    assert [e for e in ended if e[0] == "ended"][1:] == [("ended", "orientation", 1, "done", "Built the other page too.")]
    # a hand-back the tail reads after the next run began, made before it began, is the earlier run's
    subagents.run_again(CORPUS, AGENT, by="coordinator")
    began = float(subagents.agent(CORPUS, AGENT)["last_start"])
    with subagents.update(CORPUS) as state:
        sf.registry(state)[AGENT]["last_start"] = began = max(began, 1000.0)
    assert subagents.run_ended(CORPUS, AGENT, "done", "Late words.", source="handback", made_at=began - 5) is False
    assert subagents.agent(CORPUS, AGENT)["status"] == "running"
    assert subagents.run_ended(CORPUS, AGENT, "done", "New words.", source="handback", made_at=began + 5) is True
    assert ended[-1] == ("ended", "orientation", 2, "done", "New words.")


SAFEGUARD = ("API Error: Opus 4.8's safeguards flagged this message. Our intentionally broad safeguards allow us to "
             "deliver more capabilities faster, but can sometimes flag legitimate cybersecurity work.\n\nDetails: "
             "`[cyber]`\n\nRequest ID: req_011CfjqEMn9QjcrgsnMLfo4s")


def _api_error(text: str = SAFEGUARD) -> dict:
    """The record Claude Code writes when an API error ends a turn: a synthetic assistant reply, as a refusal by the
    model's safeguards left it in an orientation's transcript (Claude Code 2.1.289)."""
    return {"type": "assistant", "isApiErrorMessage": True, "error": "invalid_request",
            "message": {"role": "assistant", "model": "<synthetic>", "stop_reason": "refusal",
                        "content": [{"type": "text", "text": text}]}}


async def test_a_run_an_api_error_ended_fails_with_claude_code_s_error_line_whichever_signal_ends_it(
        bridge, project, ended, monkeypatch):
    """An API error (a refusal by the model's safeguards, retries run out) ends a run with no hand-back. Its end comes as
    the module's turn end (reason refusal or error), a SubagentStop, or for a typed start a task notification that may
    say completed; each ends the run failed, with the error line of the agent's transcript as its report."""
    lv, chat, path = await _click_orientation(bridge, project)
    _write(path, {"type": "user", "message": {"role": "user", "content": "the task"}},
           _assistant(_use("toolu_b1", "Bash", {"command": "ls"})), _result("toolu_b1", "a b"), _api_error())
    assert subagents.ended(CORPUS, AGENT, "", "refusal")
    assert ended[-1] == ("ended", "orientation", 0, "failed", SAFEGUARD)
    assert subagents.agent(CORPUS, AGENT)["status"] == "failed"
    meta = agents.read_meta(CORPUS, chat)
    assert meta["status"] == "failed" and meta["result"] == SAFEGUARD[:400]

    # a follow-up's SubagentStop: the run ends with that turn's answer, which here is the API's error
    subagents.run_again(CORPUS, AGENT, "coordinator")
    _write(path, {"type": "user", "message": {"role": "user", "content": "And April?"}},
           _api_error("API Error: Repeated 529 Overloaded errors"))
    monkeypatch.setattr(subagents, "HANDBACK_WAIT_S", 0.01)
    monkeypatch.setattr(subagents, "AUTO_HANDBACK_WAIT_S", 0.01)
    subagents.stopped(CORPUS, AGENT)
    import asyncio

    for _ in range(100):
        if ended[-1][:3] == ("ended", "orientation", 1):
            break
        await asyncio.sleep(0.01)
    assert ended[-1] == ("ended", "orientation", 1, "failed", "API Error: Repeated 529 Overloaded errors")

    # a task notification that says completed: failed all the same
    subagents.run_again(CORPUS, AGENT, "coordinator")
    _write(path, {"type": "user", "message": {"role": "user", "content": "And May?"}},
           _api_error("API Error: 400 prompt is too long"))
    _write(Path(lv.transcript_path), _notice(AGENT, "completed", summary="Agent finished",
                                             result="API Error: 400 prompt is too long"), END)
    session.tail_once(lv)
    assert ended[-1] == ("ended", "orientation", 2, "failed", "API Error: 400 prompt is too long")


async def test_a_descendant_of_the_orientation_is_a_step_of_its_chat_with_numbered_calls(bridge, project, ended):
    lv, chat, path = await _click_orientation(bridge, project)
    with subagents.update(CORPUS) as state:
        sf.registry(state)["h1"] = {"type": "thimble:orient-helper", "role": "orient-helper", "parent": AGENT, "root": AGENT,
                                    "status": "running", "descendant": True}
    child = _agent_file(project, "h1", agentType="thimble:orient-helper", description="survey the files",
                        parentAgentId=AGENT, toolUseId="toolu_h")
    _write(child, _assistant(_use("toolu_hr", "Read", {"file_path": "/c/board.jsonl"})), _result("toolu_hr", "1\tx"))
    session.tail_once(lv)
    steps = [m for m in agents.list_chats(CORPUS) if m.get("role") == agents.STEP_ROLE and m.get("agent_id") == "h1"]
    assert len(steps) == 1 and steps[0]["parent"] == chat and steps[0]["route"] == "subagent"
    from app import calls

    assert [c.get("agent") for c in calls.listing(CORPUS, chat)] == ["h1"], "numbered in the orientation's sequence"


async def test_the_card_check_s_agent_gets_no_chat_of_its_own(bridge, project, monkeypatch):
    """The card check's agent (agent_call.py) has no chat: the mirror leaves its transcript alone, while its start waits
    for the module's answer too, and any other agent of main's still gets its chat."""
    from app import agent_call

    lv = _attach(project)
    before = {m["id"] for m in agents.list_chats(CORPUS)}
    spawned = {"agentId": "acall000000000001"}
    bridge.answers.append(spawned)
    ans = await subagents.start_job(CORPUS, agent_call.ROLE, "call:abc123", "Judge it.", {}, subagents.FOLLOW_ON,
                                    description="thimble card check: Q?", fields={"drop": "done"})
    assert ans.agent_id == "acall000000000001" and subagents.agent(CORPUS, ans.agent_id)["type"] == "thimble:call"
    _agent_file(project, "acall000000000001", agentType="thimble:call", description="thimble card check: Q?",
                toolUseId=sf.PLUGIN_CALL + "1")
    # an agent whose start still waits for the module's answer: not adopted while it waits
    with sf.update(config.workspace_dir(CORPUS)) as state:
        sf.requests(state)["req_wait000001"] = {"kind": "start", "route": "follow-on", "role": "call",
                                                "key": "call:def456", "state": "pending", "input": {}}
    _agent_file(project, "acall000000000002", agentType="thimble:call", description="thimble card check: R?",
                toolUseId=sf.PLUGIN_CALL + "2")
    _agent_file(project, "aplain00000000003", agentType="general-purpose", description="Look around",
                toolUseId="toolu_01main")
    session._scan_subs(lv)  # as the mirror's pass does once main's turn ended
    made = [m for m in agents.list_chats(CORPUS) if m["id"] not in before]
    assert [m.get("title") for m in made] == ["Look around"], made
    assert str(project / SID / "subagents" / "agent-acall000000000002.jsonl") not in lv.sub_paths, "it waits"


@pytest.mark.parametrize("first", ["notification", "module"])
async def test_a_failure_main_read_in_claude_code_s_own_line_waits_for_no_prompt(bridge, project, first):
    """Bug hunt C22: the orientation failed while main was busy, main read Claude Code's own line of it (a task
    notification in main's transcript) and told the analyst, and thimble's `orient` event of the same failure was held
    and came with the analyst's next question, minutes later, as old news. Whichever signal ends the run first, no event
    of that failure waits for main's next prompt."""
    lv, _chat, _path = await _click_orientation(bridge, project)
    events._subs.setdefault(CORPUS, set()).add(events.Sub(SID))
    main = project / f"{SID}.jsonl"
    _write(main, {"type": "user", "origin": {"kind": "human"}, "message": {"content": "What stands out?"}})
    session.tail_once(lv)
    error = "API Error: Opus 5.5's safeguards flagged this message."
    if first == "module":  # the module's turn end comes first: the event is held, as before
        subagents.run_ended(CORPUS, AGENT, "failed", error, source="module")
        assert [n["meta"]["status"] for n in events.held(CORPUS)] == ["failed"]
    _write(main, _notice(AGENT, "failed", f'Agent "orientation: the whole corpus" failed: {error}'))
    session.tail_once(lv)
    assert subagents.agent(CORPUS, AGENT)["status"] == "failed"
    assert events.held(CORPUS) == [], "no old news for the analyst's next question"


async def test_a_writer_whose_turn_ends_while_its_background_tasks_run_is_still_writing(bridge, project, monkeypatch):
    """Bug hunt G9: a writer started a background command and a Monitor that waited for the orientation, then ended
    its turn. thimble took that turn's end for the run's end and showed the document as not written, with Retry, though
    Claude Code woke the writer when its tasks ended and it wrote the document. While a background task of its own runs,
    a turn's end leaves the run waiting: the write stays pending, Write is refused, and its saves name its chat. The
    task notifications wake it, and its hand-back ends the run."""
    from types import SimpleNamespace

    from app import report_types, write_session

    writer = "a0c1d2e3f4a5b6c7d"
    emitted: list[dict] = []
    real_emit = report_types._emit
    monkeypatch.setattr(report_types, "_emit", lambda c, e: (emitted.append(e), real_emit(c, e)))
    monkeypatch.setattr(subagents, "HANDBACK_WAIT_S", 0.01)
    monkeypatch.setattr(subagents, "AUTO_HANDBACK_WAIT_S", 0.01)
    lv = _attach(project)
    bridge.answers.append({"agentId": writer})
    assert (await write_session.start(CORPUS, "report", route=subagents.CLICK)).agent_id == writer
    chat = str(subagents.agent(CORPUS, writer)["chat"])
    path = _agent_file(project, writer, agentType="thimble:writer", toolUseId="toolu_plugin_5e1f0a",
                       description="writer: report")
    waiting = "The orientation is still running. I'll write the report when it finishes."
    _write(path, {"type": "user", "message": {"role": "user", "content": "the task"}},
           _assistant(_use("toolu_w1", "Bash", {"command": "until test -f done; do sleep 15; done",
                                                "run_in_background": True})),
           _result("toolu_w1", "Command running in background with ID: bq7h2k9. Output is being written to: /t/bq7h2k9"),
           _assistant(_use("toolu_w2", "Monitor", {"command": "tail -f run.json", "description": "orientation ends"})),
           _result("toolu_w2", "Monitor started (task bm4x8r1, expires in 20m unless the source ends first)."),
           _assistant({"type": "text", "text": waiting}))

    assert subagents.ended(CORPUS, writer, waiting, "answer") is False, "the module's turn end is no end of the run"
    subagents.stopped(CORPUS, writer)  # the SubagentStop of the same turn
    import asyncio

    await asyncio.sleep(0.05)
    assert subagents.agent(CORPUS, writer)["status"] == "waiting"
    assert agents.read_meta(CORPUS, chat)["status"] == "running"
    assert not [e for e in emitted if e.get("status") in ("failed", "generated", "stopped")], emitted
    assert report_types.write_pending(CORPUS, "report") is not None and write_session.running(CORPUS, "report")
    ctx = SimpleNamespace(c=CORPUS, session=write_session.session_key("report"))
    assert report_types._writer_chat(ctx) == chat, "its saves' chips name its chat, so the chat shows one row"

    # the notifications wake it, it saves the document and hands back
    _write(path, _notice("bq7h2k9", "completed", 'Background command "wait" completed (exit code 0)') | {"isMeta": True},
           {"type": "attachment", "attachment": {"type": "queued_command", "prompt": (
               "<task-notification>\n<task-id>bm4x8r1</task-id>\n<status>completed</status>\n"
               "<summary>Monitor \"orientation ends\" stream ended</summary>\n</task-notification>")}})
    session.tail_once(lv)
    assert subagents.agent(CORPUS, writer)["status"] == "running" and session.agent_tasks(CORPUS, writer) == []
    report_types._write_saved(CORPUS, "report", whole=False)
    _write(path, _assistant(_use("toolu_hb", "SubagentHandback", {"message": "Wrote report:report."})))
    session.tail_once(lv)
    assert subagents.agent(CORPUS, writer)["status"] == "done"
    assert [e["status"] for e in emitted if e.get("status") in ("failed", "generated")] == ["generated"]
