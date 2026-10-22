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

from app import agents, config, events, session, subagents
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
    ans = await orient_session.start(CORPUS, "", route=subagents.CLICK)
    assert ans.agent_id == AGENT
    path = _agent_file(project, AGENT, agentType="thimble:orientation", toolUseId="toolu_plugin_105f7e7c43f6",
                       description="orientation: the whole corpus")
    return lv, str(subagents.agent(CORPUS, AGENT)["chat"]), path


SAFEGUARD = ("API Error: Opus 4.8's safeguards flagged this message. Our intentionally broad safeguards allow us to "
             "deliver more capabilities faster, but can sometimes flag legitimate cybersecurity work.\n\nDetails: "
             "`[cyber]`\n\nRequest ID: req_011CfjqEMn9QjcrgsnMLfo4s")


def _api_error(text: str = SAFEGUARD) -> dict:
    """The record Claude Code writes when an API error ends a turn: a synthetic assistant reply, as a refusal by the
    model's safeguards left it in an orientation's transcript (Claude Code 2.1.289)."""
    return {"type": "assistant", "isApiErrorMessage": True, "error": "invalid_request",
            "message": {"role": "assistant", "model": "<synthetic>", "stop_reason": "refusal",
                        "content": [{"type": "text", "text": text}]}}


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


async def test_r2_a_subagent_s_agent_call_for_a_typed_start_that_fails_refuses_its_request(bridge, project, ended):
    """U5: a subagent of main's that is no agent of thimble's (a thread's fork; here main's own general-purpose
    subagent) called start_writing and made the Agent call itself; Claude Code's error for it refuses the request with
    the kind of its error, as for main's call, so the browser never waits on Starting…"""
    lv = _attach(project)
    gp = "a0000000000000gp1"
    sf.add_caller(config.workspace_dir(CORPUS), "toolu_gp_tool", gp, "general-purpose")
    ans = await subagents.start_job(CORPUS, "writer", "writer:report", "w", {}, subagents.TYPED, call="toolu_gp_tool")
    assert subagents.request(CORPUS, ans["request"])["caller_agent"] == gp
    _write(Path(lv.transcript_path), _human("have a helper start the writer"),
           _assistant(_use("toolu_gp", "Agent", {"subagent_type": "general-purpose", "description": "helper",
                                                 "prompt": "start the writer"})),
           _result("toolu_gp", f"Async agent launched successfully.\nagentId: {gp}"))
    session.tail_once(lv)
    path = _agent_file(project, gp, agentType="general-purpose", toolUseId="toolu_gp")
    text = "Cannot launch: 20 concurrent subagents are already running (the limit is 20)."
    _write(path, _assistant(_use("toolu_gp_tool", "mcp__plugin_thimble_thimble__start_writing", {"doc": "report"})),
           _result("toolu_gp_tool", "AGENT CALL"), _assistant(_use("toolu_gp_agent", "Agent", ans["input"])),
           _result("toolu_gp_agent", text, error=True))
    session.tail_once(lv)
    session.tail_once(lv)
    r = subagents.request(CORPUS, ans["request"])
    assert (r["state"], r["refused_kind"], r["reason"]) == ("refused", "limit", text)
    assert ended[-1] == ("refused", "writer", "limit", text)


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


def test_task_notices_reads_each_block_and_a_bare_notification_as_one():
    two = "pre <task-notification><task-id>a</task-id><status>completed</status></task-notification>\n" \
          "<task-notification><task-id>b</task-id><status>killed</status></task-notification>"
    assert session.task_notices(two) == [{"task-id": "a", "status": "completed"}, {"task-id": "b", "status": "killed"}]
    assert session.task_notices("<task-id>c</task-id>") == [{"task-id": "c"}]


def _at(t: float) -> str:
    from datetime import datetime, timezone

    return datetime.fromtimestamp(t, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _left(old: str, reason: str, at: float) -> None:
    """main's SessionEnd hook recorded that main left session `old` (/clear, /resume), as --end writes it."""
    with subagents.update(CORPUS) as state:
        state["main_end"] = {"session": old, "reason": reason, "at": at}


def test_a_handback_s_report_is_what_follows_its_frame_dedented():
    body = HANDBACK.format(report="Line one.\n  Line two.")
    assert session.handback_report(body) == "Line one.\nLine two."
    assert session.handback_report(body + "</agent-message>") == "Line one.\nLine two."


async def _no_line() -> str:
    return ""


CLASSIFIER = ("Permission for this action was denied by the Claude Code auto mode classifier. Reason: [Credential "
              "Exploration]. If you have other tasks that don't depend on this action, continue working on those. "
              "IMPORTANT: You *may* attempt to accomplish this action using other tools.")


