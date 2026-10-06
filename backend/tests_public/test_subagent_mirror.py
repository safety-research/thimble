"""The mirror (session.py) of thimble's agents as subagents of main: an agent of one of its roles goes to its role's chat
and a descendant to a step of it; a run ends once, at its SubagentHandback call, its hand-back in main, a task
notification or the module's turn end; a message to a finished agent starts its next run, and the short turn a parent
gets after its own hand-back does not; main's call for one of thimble's agents is watched (R2: its result) and so is the
turn in which main called a start tool (R3); /clear carries the agents into the new session. Every transcript is written
by the test in Claude Code's record shapes, as the step-0 and step-0b spikes recorded them."""
from __future__ import annotations

import json
import time
from pathlib import Path

import pytest

from app import agents, config, events, orient_session, session, subagents
from app import subagent_files as sf
from subagent_fakes import bridge  # noqa: F401 — a fixture

CORPUS = "mini"
SID = "70e0e27e-eb46-462b-8a9a-57b2e924dca1"
NEW = "17bcfd32-0000-4000-8000-000000000002"
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


def _human(text: str) -> dict:
    return {"type": "user", "origin": {"kind": "human"}, "message": {"content": text}}


def _peer(agent: str, report: str) -> dict:
    body = HANDBACK.format(report=report)
    return {"type": "user", "isMeta": True, "message": {"role": "user", "content": f"Another Claude session sent a "
            f"message:\n<agent-message from=\"{agent}\">\n{body}</agent-message>"},
            "origin": {"kind": "peer", "from": agent, "senderTaskId": agent, "name": "thimble:orientation",
                       "body": body}}


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
    ans = await orient_session.start(CORPUS, "", ["final"], route=subagents.CLICK)
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


async def test_each_follow_up_s_message_in_the_thread_names_its_run(bridge, project, ended):
    """Main's SendMessage to the finished orientation, and a message the analyst typed to it in the agent tray, each
    show in its thread with the run they start (`run`), as the browser cuts the thread into runs by it (orientRuns)
    and takes a message it sent off its outbox once the thread holds it (live check L7)."""
    lv, chat, path = await _click_orientation(bridge, project)
    _write(path, _assistant(_use("toolu_hb", "SubagentHandback", {"message": "done"})))
    session.tail_once(lv)
    subagents.message_request(CORPUS, AGENT, "And April?", call="toolu_m1")
    _write(Path(lv.transcript_path), _human("ask it about April"),
           _assistant(_use("toolu_m1", "SendMessage", {"to": AGENT, "message": "And April?"})),
           _result("toolu_m1", json.dumps({"success": True, "message": f"Resuming agent {AGENT}"})))
    session.tail_once(lv)
    _write(path, {"type": "user", "isMeta": True, "origin": {"kind": "coordinator"},
                  "message": {"content": "The coordinator sent a message while you were working:\nAnd April?"}},
           _assistant(_use("toolu_hb2", "SubagentHandback", {"message": "April is the same."})))
    session.tail_once(lv)
    _write(path, {"type": "user", "isMeta": True, "origin": {"kind": "human"},
                  "message": {"content": "Message from the user while you were working:\nAnd May?"}})
    session.tail_once(lv)
    _, log = agents.paths(CORPUS, chat)
    users = [(e["text"], e.get("by"), e.get("run")) for e in agents.read_events(log) if e.get("type") == "user"]
    assert users == [("And April?", "main", 1), ("And May?", "terminal", 2)]


async def test_a_send_message_a_hook_denied_shows_no_message_from_main_in_the_thread(bridge, project, ended):
    """Live check L7: a second SendMessage with no pending request was denied by thimble's --agent-check, and the thread
    still showed it as sent from main, since the mirror showed the call as it appeared. A message main sent shows once
    its call ran: not after a hook's deny, auto mode's refusal or a `success: false` answer."""
    lv, chat, path = await _click_orientation(bridge, project)
    _write(path, _assistant(_use("toolu_hb", "SubagentHandback", {"message": "done"})))
    session.tail_once(lv)
    deny = ("PreToolUse:SendMessage hook error: thimble's agents continue only when the analyst asks. If they asked, "
            "call message_orientation and send what it gives; otherwise ask them first.")
    _write(Path(lv.transcript_path), _human("ask it again"),
           _assistant(_use("toolu_d1", "SendMessage", {"to": AGENT, "message": "And April?"})))
    session.tail_once(lv)
    _, log = agents.paths(CORPUS, chat)
    assert not [e for e in agents.read_events(log) if e.get("type") == "user" and e.get("by") == "main"], \
        "nothing shows before the call ran"
    _write(Path(lv.transcript_path), _result("toolu_d1", deny, error=True),
           _assistant(_use("toolu_d2", "SendMessage", {"to": AGENT, "message": "And May?"})),
           _result("toolu_d2", json.dumps({"success": False, "message": "could not be resumed"})),
           _assistant(_use("toolu_d3", "SendMessage", {"to": AGENT, "message": "And June?"})),
           _result("toolu_d3", json.dumps({"success": True, "message": f"Resuming agent {AGENT}"})), END)
    session.tail_once(lv)
    assert [e["text"] for e in agents.read_events(log) if e.get("type") == "user" and e.get("by") == "main"] \
        == ["And June?"]


async def test_a_run_keeps_the_effort_claude_code_writes_beside_its_message(bridge, project, ended):
    """Claude Code writes a request's effort on the transcript record, beside `message` (contract_module), so each run's
    `ran` names it and the thread's header shows the run's model and effort (live check L1)."""
    lv, chat, path = await _click_orientation(bridge, project)
    rec = _assistant(_use("toolu_hb", "SubagentHandback", {"message": "done"}))
    rec["effort"] = "medium"
    _write(path, rec)
    session.tail_once(lv)
    assert subagents.agent(CORPUS, AGENT)["ran"] == {"0": {"model": "claude-opus-5-5", "effort": "medium"}}
    assert agents.read_meta(CORPUS, chat)["ran"] == {"0": {"model": "claude-opus-5-5", "effort": "medium"}}


async def test_each_run_keeps_the_model_it_ran_on_and_a_typed_follow_up_on_another_shows_it(bridge, project, ended):
    """A typed follow-up (main's SendMessage) runs on the role's registration in force, not on the run's values; when
    its transcript names another model, main's chat says so (`follow-up-ran-on`)."""
    lv, chat, path = await _click_orientation(bridge, project)
    _write(path, _assistant(_use("toolu_hb", "SubagentHandback", {"message": "done"})))
    session.tail_once(lv)
    assert subagents.agent(CORPUS, AGENT)["ran"] == {"0": {"model": "claude-opus-5-5"}}
    assert agents.read_meta(CORPUS, chat)["ran"] == {"0": {"model": "claude-opus-5-5"}}
    with subagents.update(CORPUS) as state:
        sf.registry(state)[AGENT]["values"] = {"model": "claude-opus-5-5[1m]", "effort": "max"}
    ans = subagents.message_request(CORPUS, AGENT, "And April?", call="toolu_m1")
    with subagents.update(CORPUS) as state:
        assert sf.check_call(state, {"tool_name": "SendMessage", "tool_use_id": "toolu_m1",
                                     "tool_input": ans["input"]}) is None
    other = _assistant(_use("toolu_hb2", "SubagentHandback", {"message": "April is the same."}))
    other["message"]["model"] = "claude-sonnet-5"
    _write(path, {"type": "user", "isMeta": True, "origin": {"kind": "coordinator"},
                  "message": {"content": "The coordinator sent a message while you were working:\nAnd April?"}}, other)
    session.tail_once(lv)
    assert subagents.agent(CORPUS, AGENT)["ran"]["1"] == {"model": "claude-sonnet-5"}
    _, log = agents.paths(CORPUS, agents.MAIN_ID)
    chips = [e for e in agents.read_events(log) if e.get("type") == "chip" and e.get("kind") == "follow_up_ran_on"]
    assert [e["text"] for e in chips] == ["RAN ON claude-sonnet-5 "] and chips[0]["chat"] == chat


async def test_in_default_mode_the_module_s_turn_end_ends_the_first_run(bridge, project, ended):
    lv, chat, path = await _click_orientation(bridge, project)
    _write(path, _assistant({"type": "text", "text": "Done."}))
    session.tail_once(lv)
    assert subagents.ended(CORPUS, AGENT, "Done.")
    assert ended[-1] == ("ended", "orientation", 0, "done", "Done.")
    assert not subagents.ended(CORPUS, AGENT, "Done."), "once"


async def test_a_later_run_s_task_notification_ends_it_once_and_an_older_one_is_ignored(bridge, project, ended):
    lv, chat, path = await _click_orientation(bridge, project)
    _write(path, _assistant(_use("toolu_hb", "SubagentHandback", {"message": "first"})))
    session.tail_once(lv)
    subagents.run_again(CORPUS, AGENT, "coordinator")
    old = "2001-01-01T00:00:00.000Z"
    _write(Path(lv.transcript_path), _notice(AGENT, "completed", result="first", at=old), END)
    session.tail_once(lv)
    assert subagents.agent(CORPUS, AGENT)["status"] == "running", "a notification older than its latest start"
    _write(Path(lv.transcript_path), _notice(AGENT, "completed", result="the whole report"), END)
    session.tail_once(lv)
    assert ended[-1] == ("ended", "orientation", 1, "done", "the whole report")


async def test_a_killed_run_ends_stopped_and_one_cut_off_by_the_quit_says_continue_here(bridge, project, ended):
    lv, chat, path = await _click_orientation(bridge, project)
    # a TaskStop's notification, the browser's Stop or main's (Claude Code 2.1.291's words)
    _write(Path(lv.transcript_path), _notice(AGENT, "killed", summary='Agent "orientation: x" was stopped by Claude'),
           END)
    session.tail_once(lv)
    assert ended[-1][:4] == ("ended", "orientation", 0, "stopped")
    assert subagents.agent(CORPUS, AGENT)["stopped_by"] == "analyst"
    assert not subagents.cancelled(CORPUS, AGENT), "a TaskStop leaves it resumable"
    subagents.run_again(CORPUS, AGENT, "coordinator")
    _write(Path(lv.transcript_path), _notice(AGENT, "stopped", summary='Background agent "orientation" didn\'t finish '
                                             "before the previous session ended"), END)
    session.tail_once(lv)
    assert ended[-1][:4] == ("ended", "orientation", 1, "stopped")
    assert agents.read_meta(CORPUS, chat)["continue"] == "here"


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


async def test_an_api_error_the_run_went_on_from_and_a_stop_are_no_failure(bridge, project, ended):
    """Only the latest reply counts: a run that went on after an API error (Claude Code retried on a fallback model, or
    nudged it to hand back) ends as its hand-back or answer says; and a run the analyst stopped ends stopped."""
    lv, chat, path = await _click_orientation(bridge, project)
    _write(path, _api_error(), _assistant({"type": "text", "text": "Done after all."}))
    assert subagents.ended(CORPUS, AGENT, "Done after all.", "answer")
    assert ended[-1] == ("ended", "orientation", 0, "done", "Done after all.")
    subagents.run_again(CORPUS, AGENT, "coordinator")
    _write(path, {"type": "user", "message": {"role": "user", "content": "And April?"}}, _api_error())
    assert subagents.ended(CORPUS, AGENT, "", "aborted")
    assert ended[-1][:4] == ("ended", "orientation", 1, "stopped")
    subagents.run_again(CORPUS, AGENT, "coordinator")
    _write(path, {"type": "user", "message": {"role": "user", "content": "And May?"}}, _api_error(),
           _assistant(_use("toolu_hb", "SubagentHandback", {"message": "I could not read May."})))
    session.tail_once(lv)
    assert ended[-1] == ("ended", "orientation", 2, "done", "I could not read May.")


def test_a_failed_turn_end_with_no_text_says_so():
    """The module's turn end for an API error or a refusal that brought no text and no transcript line: the run's report
    says Claude Code gave none, rather than nothing."""
    assert subagents.NO_ERROR_TEXT.format(reason="error") == "Claude Code ended the run (error) and gave no error text"


async def test_a_typed_start_s_agent_call_is_no_row_and_its_agent_takes_up_the_claimed_request(bridge, project, ended):
    lv = _attach(project)
    ans = await subagents.start_job(CORPUS, "writer", "writer:report", "write it", {"model": "m", "effort": "e"},
                                    subagents.TYPED, description="writer: report", chat={"title": "Write report"})
    inp = ans["input"]
    with subagents.update(CORPUS) as state:
        assert sf.check_call(state, {"tool_name": "Agent", "tool_use_id": "toolu_w1", "tool_input": inp}) is None
    main = Path(lv.transcript_path)
    _write(main, _human("Write the report."), _assistant(_use("toolu_w1", "Agent", inp)),
           _result("toolu_w1", "Async agent launched successfully.\nagentId: a00000000000000w1"))
    session.tail_once(lv)
    assert not [r for r in agents.read_events(agents.paths(CORPUS, agents.MAIN_ID)[1])
                if r.get("type") in ("tool_use", "tool_result") and r.get("id") == "toolu_w1"], "no row in main"
    path = _agent_file(project, "a00000000000000w1", agentType="thimble:writer", toolUseId="toolu_w1")
    _write(path, _assistant({"type": "text", "text": "Writing."}))
    session.tail_once(lv)
    a = subagents.agent(CORPUS, "a00000000000000w1")
    assert a["key"] == "writer:report" and a["chat"] and a["plugin_started"] is False
    assert agents.read_meta(CORPUS, a["chat"])["started_by"] == "typed"


@pytest.mark.parametrize("text,kind", [
    ("[Auto-Mode Bypass] Starting an agent to do what was refused.", "auto-mode"),
    ("Cannot launch: 20 concurrent subagents are already running (the limit is 20).", "limit"),
    ("Agent type 'thimble:writer' not found. Available agents: general-purpose", "no-module"),
    ("PreToolUse:Agent hook error: MAKE THE CALL EXACTLY", "hook"),
])
async def test_r2_main_s_agent_call_that_fails_refuses_its_request_with_the_kind_of_its_error(bridge, project, ended,
                                                                                            text, kind):
    lv = _attach(project)
    ans = await subagents.start_job(CORPUS, "writer", "writer:report", "w", {}, subagents.TYPED)
    _write(Path(lv.transcript_path), _human("write"), _assistant(_use("toolu_r2", "Agent", ans["input"])),
           _result("toolu_r2", text, error=True))
    session.tail_once(lv)
    r = subagents.request(CORPUS, ans["request"])
    assert (r["state"], r["refused_kind"], r["reason"]) == ("refused", kind, text)
    assert ended[-1] == ("refused", "writer", kind, text)


async def test_r2_a_send_message_to_an_agent_of_another_session_and_a_stop_of_an_ended_one(bridge, project, ended):
    lv, chat, path = await _click_orientation(bridge, project)
    ans = subagents.message_request(CORPUS, AGENT, "and April?")
    send = {"to": AGENT, "message": "and April?"}
    gone = json.dumps({"success": False, "message": f'Agent "{AGENT}" could not be resumed: No transcript found for '
                                                    f"agent ID: {AGENT}"})
    _write(Path(lv.transcript_path), _human("ask it"), _assistant(_use("toolu_s", "SendMessage", send)),
           _result("toolu_s", gone), _assistant(_use("toolu_t", "TaskStop", {"task_id": AGENT})),
           _result("toolu_t", f"<tool_use_error>Task {AGENT} is not running</tool_use_error>", error=True), END)
    session.tail_once(lv)
    r = subagents.request(CORPUS, ans["request"])
    assert r["state"] == "refused" and r["refused_kind"] == "earlier-session"


async def test_r3_a_turn_that_called_the_start_tool_and_ended_without_the_call_refuses_it_quoting_main(bridge, project,
                                                                                                    ended):
    lv = _attach(project)
    ans = await subagents.start_job(CORPUS, "writer", "writer:report", "w", {}, subagents.TYPED, call="toolu_tool")
    claimed = await subagents.start_job(CORPUS, "writer", "writer:story", "w2", {}, subagents.TYPED, call="toolu_tool2")
    with subagents.update(CORPUS) as state:
        sf.check_call(state, {"tool_name": "Agent", "tool_use_id": "toolu_a2", "tool_input": claimed["input"]})
    reply = "Auto mode told me not to pursue that outcome again.\nI won't start it.\nAnything else?"
    _write(Path(lv.transcript_path), _human("write"),
           _assistant(_use("toolu_tool", "mcp__plugin_thimble_thimble__start_writing", {"doc": "report"})),
           _result("toolu_tool", "AGENT CALL {...}"),
           _assistant(_use("toolu_tool2", "mcp__plugin_thimble_thimble__start_writing", {"doc": "story"})),
           _result("toolu_tool2", "AGENT CALL {...}"),
           _assistant({"type": "text", "text": reply}), END)
    session.tail_once(lv)
    r = subagents.request(CORPUS, ans["request"])
    assert (r["state"], r["refused_kind"], r["reason"]) == ("refused", "no-call", "Auto mode told me not to pursue "
                                                            "that outcome again.\nI won't start it.")
    assert subagents.request(CORPUS, claimed["request"])["state"] == "claimed", "main made that call"


async def test_main_s_empty_bash_true_after_a_start_is_no_row(bridge, project):
    lv = _attach(project)
    _write(Path(lv.transcript_path), _human("orient"),
           _assistant(_use("toolu_so", "mcp__plugin_thimble_thimble__start_orientation", {})),
           _result("toolu_so", "AGENT CALL"), _assistant(_use("toolu_true", "Bash", {"command": "true"})),
           _result("toolu_true", ""), _assistant(_use("toolu_ls", "Bash", {"command": "true"})),
           _result("toolu_ls", ""), END)
    session.tail_once(lv)
    ids = [r.get("id") for r in agents.read_events(agents.paths(CORPUS, agents.MAIN_ID)[1]) if r.get("type") == "tool_use"]
    assert "toolu_true" not in ids and "toolu_ls" in ids, "only the one right after the start"


async def test_a_descendant_of_the_orientation_is_a_step_of_its_chat_with_numbered_calls(bridge, project, ended):
    lv, chat, path = await _click_orientation(bridge, project)
    with subagents.update(CORPUS) as state:
        sf.registry(state)["h1"] = {"type": "thimble:helper", "role": "helper", "parent": AGENT, "root": AGENT,
                                    "status": "running", "descendant": True}
    child = _agent_file(project, "h1", agentType="thimble:helper", description="survey the files",
                        parentAgentId=AGENT, toolUseId="toolu_h")
    _write(child, _assistant(_use("toolu_hr", "Read", {"file_path": "/c/board.jsonl"})), _result("toolu_hr", "1\tx"))
    session.tail_once(lv)
    steps = [m for m in agents.list_chats(CORPUS) if m.get("role") == agents.STEP_ROLE and m.get("agent_id") == "h1"]
    assert len(steps) == 1 and steps[0]["parent"] == chat and steps[0]["route"] == "subagent"
    from app import calls

    assert [c.get("agent") for c in calls.listing(CORPUS, chat)] == ["h1"], "numbered in the orientation's sequence"


async def test_clear_carries_thimble_s_agents_into_the_new_session_read_from_the_start_of_its_file(bridge, project,
                                                                                                ended):
    lv, chat, path = await _click_orientation(bridge, project)
    _write(path, _assistant({"type": "text", "text": "Working in the old session."}))
    session.tail_once(lv)
    session._follow(CORPUS, SID, NEW, lv.cwd, None)
    nv = session.current(CORPUS)
    assert nv.sid == NEW and [s.agent_id for s in nv.subs if s.thimble] == [AGENT]
    assert subagents.agent(CORPUS, AGENT)["status"] == "running", "nothing closed on /clear"
    with subagents.update(CORPUS) as state:
        sf.rekey(state, SID, NEW)
    subagents.rekey(CORPUS, SID, NEW)
    cont = _agent_file(project, AGENT, sid=NEW)
    (project / f"{NEW}.jsonl").touch()
    _write(cont, _assistant({"type": "text", "text": "Going on in the new session."}),
           _assistant(_use("toolu_hb", "SubagentHandback", {"message": "done after the clear"})))
    session.tail_once(nv)
    texts = [r.get("delta") for r in agents.read_events(agents.paths(CORPUS, chat)[1]) if r.get("type") == "text"]
    assert texts[-1] == "Going on in the new session." and "Working in the old session." in texts
    assert ended[-1] == ("ended", "orientation", 0, "done", "done after the clear")
    assert agents.read_meta(CORPUS, chat)["session"] == NEW


async def test_a_compaction_s_summary_is_no_message_in_the_thread_or_in_main(bridge, project, ended):
    """Claude Code writes a compaction's summary as a user record (isCompactSummary), the orientation's own automatic
    one and main's /compact alike: neither chat shows it as a message (live check L18, group c)."""
    lv, chat, path = await _click_orientation(bridge, project)
    summary = ("This session is being continued from a previous conversation that ran out of context. The summary "
               "below covers the earlier portion of the conversation.")
    _write(path, {"type": "user", "message": {"role": "user", "content": "the task"}},
           {"type": "system", "subtype": "compact_boundary", "content": "Conversation compacted",
            "compactMetadata": {"trigger": "auto"}},
           {"type": "user", "isCompactSummary": True, "isVisibleInTranscriptOnly": True,
            "message": {"role": "user", "content": summary}},
           _assistant({"type": "text", "text": "Reading on after the compaction."}))
    _write(Path(lv.transcript_path), {"type": "system", "subtype": "compact_boundary", "content": "Conversation compacted"},
           {"type": "user", "isCompactSummary": True, "isVisibleInTranscriptOnly": True,
            "message": {"role": "user", "content": summary}})
    session.tail_once(lv)
    thread = agents.read_events(agents.paths(CORPUS, chat)[1])
    assert [r.get("text") for r in thread if r.get("type") == "user"] == ["the task"]
    assert any(r.get("delta") == "Reading on after the compaction." for r in thread), "the thread keeps following"
    main_log = agents.read_events(agents.paths(CORPUS, "main")[1])
    assert not any(summary in str(r.get("text") or "") for r in main_log)


def _at(t: float) -> str:
    from datetime import datetime, timezone

    return datetime.fromtimestamp(t, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _left(old: str, reason: str, at: float) -> None:
    """main's SessionEnd hook recorded that main left session `old` (/clear, /resume), as --end writes it."""
    with subagents.update(CORPUS) as state:
        state["main_end"] = {"session": old, "reason": reason, "at": at}


async def test_resume_back_to_the_first_session_reads_on_without_its_earlier_records(bridge, project, ended):
    """/clear, then /resume back to the session before it, while the orientation runs: Claude Code appends the agent's
    records to its file in that session's folder again, which holds what the mirror read there before /clear. Those
    records are not read again: no second copy of the task, which the chat would show as typed in the agent tray (live
    check L17, group c)."""
    t0 = time.time() - 600
    lv, chat, path = await _click_orientation(bridge, project)
    _write(path, {"type": "user", "timestamp": _at(t0), "message": {"role": "user", "content": "the task"}},
           {**_assistant({"type": "text", "text": "Working in the first session."}), "timestamp": _at(t0 + 1)},
           {**_assistant(_use("toolu_s1", "Bash", {"command": "sleep-ish 120"})), "timestamp": _at(t0 + 2)})
    session.tail_once(lv)
    _left(SID, "clear", t0 + 10)
    session._follow(CORPUS, SID, NEW, lv.cwd, None)
    with subagents.update(CORPUS) as state:
        sf.rekey(state, SID, NEW)
    subagents.rekey(CORPUS, SID, NEW)
    nv = session.current(CORPUS)
    cont = _agent_file(project, AGENT, sid=NEW)
    (project / f"{NEW}.jsonl").touch()
    _write(cont, {**_result("toolu_s1", "Exit code 137", error=True), "timestamp": _at(t0 + 11)},
           {**_assistant(_use("toolu_s2", "Bash", {"command": "sleep-ish 120"})), "timestamp": _at(t0 + 12)})
    session.tail_once(nv)
    _left(NEW, "resume", t0 + 20)
    session._follow(CORPUS, NEW, SID, lv.cwd, None)
    with subagents.update(CORPUS) as state:
        sf.rekey(state, NEW, SID)
    subagents.rekey(CORPUS, NEW, SID)
    back = session.current(CORPUS)
    _write(path, {**_result("toolu_s2", "(Bash completed with no output)"), "timestamp": _at(t0 + 140)},
           {**_assistant({"type": "text", "text": "Back in the first session."}), "timestamp": _at(t0 + 141)},
           {**_assistant(_use("toolu_hb", "SubagentHandback", {"message": "done after the resume"})),
            "timestamp": _at(t0 + 142)})
    session.tail_once(back)
    log = agents.read_events(agents.paths(CORPUS, chat)[1])
    texts = [r.get("delta") for r in log if r.get("type") == "text"]
    assert texts.count("Working in the first session.") == 1 and texts[-1] == "Back in the first session."
    assert [r.get("text") for r in log if r.get("type") == "user"].count("the task") <= 1, "the task is not read again"
    assert ended[-1] == ("ended", "orientation", 0, "done", "done after the resume")


async def test_main_s_quit_closes_the_chats_and_stops_the_jobs_at_once(bridge, project, ended, monkeypatch):
    stopped: list[str] = []
    monkeypatch.setattr(session, "_stop_agents", lambda c: stopped.append(c))
    lv, chat, path = await _click_orientation(bridge, project)
    out = await subagents.end_route(subagents.HookBody(cwd=str(config.corpus_dir(CORPUS)),
                                                       hook={"session_id": SID, "reason": "prompt_input_exit"}))
    assert out["closed"] == [AGENT] and stopped == [CORPUS] and session.current(CORPUS) is None
    assert agents.read_meta(CORPUS, chat)["stopped_by"] == "quit"


async def test_clear_and_resume_close_nothing(bridge, project, ended):
    lv, chat, path = await _click_orientation(bridge, project)
    for reason in ("clear", "resume"):
        out = await subagents.end_route(subagents.HookBody(cwd=str(config.corpus_dir(CORPUS)),
                                                           hook={"session_id": SID, "reason": reason}))
        assert out["closed"] == [] and subagents.agent(CORPUS, AGENT)["status"] == "running"


def test_a_handback_s_report_is_what_follows_its_frame_dedented():
    body = HANDBACK.format(report="Line one.\n  Line two.")
    assert session.handback_report(body) == "Line one.\nLine two."
    assert session.handback_report(body + "</agent-message>") == "Line one.\nLine two."


async def test_the_server_restarted_under_main_follows_the_running_agents_again(bridge, project, ended):
    lv, chat, path = await _click_orientation(bridge, project)
    _write(path, _assistant({"type": "text", "text": "before the restart"}))
    session.tail_once(lv)
    session._save_cursor(lv)
    session._live.clear()
    lv2 = session.attach(CORPUS, SID, str(config.corpus_dir(CORPUS)), lv.transcript_path)
    assert [s.agent_id for s in lv2.subs if s.thimble] == [AGENT]
    _write(path, _assistant(_use("toolu_hb", "SubagentHandback", {"message": "after the restart"})))
    time.sleep(0.01)
    session.tail_once(lv2)
    assert ended[-1] == ("ended", "orientation", 0, "done", "after the restart")


async def test_an_orientation_stopped_with_esc_is_recorded_as_one_claude_code_resumes_no_more(bridge, project, ended):
    """Live check L9: Esc in the agent view makes Claude Code mark the agent stopped by the user ("was stopped by user"
    in its notification), and every later SendMessage fails with "was stopped by the user and won't be resumed". The
    mirror records that stop as final (stopped_by user, the chat's `continue: stopped-by-user`), from the notification
    or from the error main's own SendMessage got, so the browser offers a new orientation instead of a follow-up."""
    lv, chat, path = await _click_orientation(bridge, project)
    _write(Path(lv.transcript_path), _notice(AGENT, "killed", summary='Agent "orientation: x" was stopped by user'), END)
    session.tail_once(lv)
    assert ended[-1][:4] == ("ended", "orientation", 0, "stopped")
    assert subagents.agent(CORPUS, AGENT)["stopped_by"] == subagents.STOPPED_USER
    assert subagents.cancelled(CORPUS, AGENT)
    meta = agents.read_meta(CORPUS, chat)
    assert (meta["continue"], meta["stopped_by"]) == (subagents.CANCELLED, "user")

    with subagents.update(CORPUS) as state:  # as if no notification had said so
        sf.registry(state)[AGENT]["cancelled"] = None
    _write(Path(lv.transcript_path), _human("ask it"),
           _assistant(_use("toolu_s1", "SendMessage", {"to": AGENT, "message": "and April?"})),
           _result("toolu_s1", f"Agent {AGENT} was stopped by the user and won't be resumed. Treat its work as "
                               "cancelled; only launch a new agent if the user explicitly asks.", error=True), END)
    session.tail_once(lv)
    assert subagents.cancelled(CORPUS, AGENT), "main's SendMessage got Claude Code's text"


async def test_main_s_plan_mode_reaching_a_running_agent_marks_its_run(bridge, project, ended):
    """Live check L21: Claude Code adds a plan_mode attachment to a running subagent's transcript when main goes into
    plan mode, and the agent follows it; the mirror marks its run and chat so (subagents.saw_plan_mode)."""
    lv, chat, path = await _click_orientation(bridge, project)
    _write(path, {"type": "user", "message": {"role": "user", "content": "the task"}},
           {"type": "attachment", "attachment": {"type": "plan_mode", "reminderType": "full"}})
    session.tail_once(lv)
    assert subagents.agent(CORPUS, AGENT)["plan_run"] == 0
    assert agents.read_meta(CORPUS, chat)["plan_mode"] is True
