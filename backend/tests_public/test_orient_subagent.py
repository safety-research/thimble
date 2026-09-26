"""Terminal-first mode: the orientation as a background subagent of the analyst's session. start_orientation writes its
prompt to a file and asks main to start the plugin agent; the mirror makes it the Orientation chat and runs its record;
its calls through main's shim act as the orientation's, so its cards land in the deck; a resumed run's record runs again
instead of staying failed; and a message or a Stop from the browser goes through main, which alone reaches its subagent.
The transcripts are written in Claude Code's record shapes."""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest
import yaml

from app import agents, channel, cli, config, ledger, orient_session, orientation, session, terminal_tools, tools

CORPUS = "mini"
SID = "e7b0a1f2-0000-4000-8000-00000000a0b1"
AGENT_ID = "a0b1c2d3e4f5a6b7c"
USE = "toolu_orient1"
PLUGIN_AGENT = config.REPO_ROOT / "plugin" / "agents" / "orient-subagent.md"
END = {"type": "system", "subtype": "turn_duration"}


@pytest.fixture(autouse=True)
def _fresh(workspaces_tmp, tmp_path, monkeypatch):
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "claude-config"))
    session._live.clear()
    session._expected.clear()
    channel._subs.clear()
    agents._busy.clear()
    ledger.put_settings(CORPUS, {orientation.TERMINAL_FIRST_KEY: True})
    yield
    session._live.clear()
    channel._subs.clear()


def _listen() -> asyncio.Queue:
    q: asyncio.Queue = asyncio.Queue()
    channel._subs.setdefault(CORPUS, set()).add(q)
    return q


def _log(chat: str) -> list[dict]:
    return agents.read_events(agents.paths(CORPUS, chat)[1])


def _assistant(*blocks: dict) -> dict:
    return {"type": "assistant", "message": {"role": "assistant", "content": list(blocks)}}


def _use(tool_use_id: str, name: str, tool_input: dict) -> dict:
    return {"type": "tool_use", "id": tool_use_id, "name": name, "input": tool_input}


def _result(tool_use_id: str, content) -> dict:
    return {"type": "user", "message": {"role": "user", "content": [
        {"type": "tool_result", "tool_use_id": tool_use_id, "content": content}]}}


def _note(status: str) -> dict:
    text = (f"<task-notification>\n<task-id>{AGENT_ID}</task-id>\n<tool-use-id>{USE}</tool-use-id>\n"
            f"<status>{status}</status>\n<result>Done.</result>\n</task-notification>")
    return {"type": "user", "origin": {"kind": "task-notification"}, "message": {"content": text}}


def _add(path: Path, records: list[dict]) -> None:
    with path.open("a") as f:
        f.write("".join(json.dumps({**r, "isSidechain": True}) + "\n" for r in records))


def _append(p: Path, lv: session.Live, recs: list[dict]) -> None:
    with p.open("a") as f:
        f.write("".join(json.dumps(r) + "\n" for r in recs))
    session.tail_once(lv)


async def test_start_orientation_writes_the_prompt_file_and_asks_main_to_start_the_subagent():
    res = await tools.call(CORPUS, "start_orientation", {"brief": "the edits", "generate_report": True})
    path = orientation.subagent_prompt_file(CORPUS)
    assert not res.is_error and str(path) in res.text and f"{orientation.PLUGIN}:{orientation.SUBAGENT}" in res.text
    assert "`run_in_background` true" in res.text
    text = path.read_text()
    assert text.startswith("# Orientation") and "the edits" in text and "{{" not in text
    assert text.strip() == orient_session.system_prompt(CORPUS, "the edits", ["final", "views", "report"]).strip()
    assert orient_session.LINES["critique"] not in text, "main's shim lists no `critique`, so the prompt names none"
    run = orientation.read_run(CORPUS)
    assert run["status"] == "requested" and run["route"] == orientation.SUBAGENT_ROUTE and run["query"] == "the edits"
    assert run["passes"] == ["final", "views", "report"] and run["groups"]["orientation"]
    assert not orient_session.running(CORPUS), "no session of its own is started"


async def test_the_subagent_is_the_orientation_chat_its_calls_act_as_the_orientation_and_a_resume_runs_its_record_again(
        tmp_path):
    await tools.call(CORPUS, "start_orientation", {"brief": ""})
    p = tmp_path / f"{SID}.jsonl"
    p.write_text("")
    lv = session.attach(CORPUS, SID, str(config.corpus_dir(CORPUS)), str(p))
    assert lv is not None
    session.tail_once(lv)
    prompt = str(orientation.subagent_prompt_file(CORPUS))
    sub = tmp_path / SID / "subagents" / f"agent-{AGENT_ID}.jsonl"
    sub.parent.mkdir(parents=True)
    sub.with_name(f"agent-{AGENT_ID}.meta.json").write_text(json.dumps(
        {"agentType": f"thimble:{orientation.SUBAGENT}", "description": "orientation", "toolUseId": USE}))
    _add(sub, [{"type": "user", "message": {"role": "user", "content": prompt}},
               _assistant(_use("k1", "Read", {"file_path": prompt})), _result("k1", "# Orientation …"),
               _assistant(_use("k2", terminal_tools.tool_name("add_card"), {"question": "How many pages?"}))])
    _append(p, lv, [{"type": "user", "origin": {"kind": "human"}, "message": {"content": "Orient."}},
                    _assistant(_use(USE, "Agent", {"subagent_type": f"thimble:{orientation.SUBAGENT}", "description": "orientation",
                                                   "prompt": prompt, "run_in_background": True})),
                    _result(USE, [{"type": "text", "text": f"Async agent launched successfully.\nagentId: {AGENT_ID} (internal ID)"}]),
                    END])
    run = orientation.read_run(CORPUS)
    chat = run["chats"][orientation.ROLE]
    meta = agents.read_meta(CORPUS, chat)
    assert run["status"] == "running" and run["agent_id"] == AGENT_ID and meta["role"] == orientation.ROLE
    assert meta["title"] == orientation.TITLE and orientation.running(CORPUS) and orientation.drafting(CORPUS)
    assert not [e for e in _log(chat) if e["type"] == "user"], "its first prompt only names the prompt file"
    assert [e["name"] for e in _log(chat) if e["type"] == "tool_use"][:1] == ["Read"]
    # its add_card comes through main's shim with no session: the mirror's transcript says it is the orientation's
    assert await session.call_session(CORPUS, "k2") == tools.ORIENT_SESSION
    _append(p, lv, [_assistant(_use("toolu_main_own", terminal_tools.tool_name("list_cards"), {}))])
    assert await session.call_session(CORPUS, "toolu_main_own") is None
    seen: list = []

    async def fake_call(c, name, args, **kw):
        seen.append(kw["session"])
        return tools.ok("card:1a2b3c4d")

    import app.tools as tools_mod
    orig = tools_mod.call
    tools_mod.call = fake_call
    try:
        await tools.call_route("add_card", tools.CallBody(args={"question": "q"}, workspace=CORPUS, tool_use_id="k2"), None)
    finally:
        tools_mod.call = orig
    assert seen == [tools.ORIENT_SESSION]
    assert tools.default_group(tools.Ctx(CORPUS, tools.ANALYST, session=tools.ORIENT_SESSION)) == run["groups"]["orientation"]
    # the API's capacity ends its first run
    _append(p, lv, [_note("failed"), END])
    assert orientation.read_run(CORPUS)["status"] == "failed" and agents.read_meta(CORPUS, chat)["status"] == "failed"
    # the analyst types to it in the agent view, which resumes it: the record runs again, and its next end closes it
    _add(sub, [{"type": "user", "isMeta": True, "origin": {"kind": "human"}, "message": {
        "content": "The user sent a new message while you were working:\nGo on where you stopped.\n\nThis is how Claude Code surfaces messages."}},
        _assistant({"type": "text", "text": "Going on."})])
    session.tail_once(lv)
    assert orientation.read_run(CORPUS)["status"] == "running" and agents.read_meta(CORPUS, chat)["status"] == "running"
    assert [e["text"] for e in _log(chat) if e["type"] == "user"] == ["Go on where you stopped."]
    _append(p, lv, [_note("completed"), END])
    assert orientation.read_run(CORPUS)["status"] == "done" and agents.read_meta(CORPUS, chat)["status"] == "done"
    # main resumes the finished orientation with a follow-up: run 1, whose changes land in place, so nothing is held
    _add(sub, [{"type": "user", "isMeta": True, "origin": {"kind": "coordinator"}, "message": {
        "content": "The coordinator sent a message while you were working:\nAdd a card on edits per day.\n\nAddress this before completing your current task."}},
        _assistant({"type": "text", "text": "Adding it."})])
    session.tail_once(lv)
    run = orientation.read_run(CORPUS)
    assert run["status"] == "running" and run["run"] == 1 and not orientation.drafting(CORPUS)
    assert run["followups"][-1]["messages"] == [{"text": "Add a card on edits per day.", "by": "main"}]
    _append(p, lv, [_note("completed"), END])
    run = orientation.read_run(CORPUS)
    assert run["status"] == "done" and run["followups"][-1]["status"] == "done"


async def test_a_call_that_arrives_before_its_line_waits_for_the_transcript_that_holds_it(tmp_path, monkeypatch):
    p = tmp_path / f"{SID}.jsonl"
    p.write_text("")
    lv = session.attach(CORPUS, SID, str(config.corpus_dir(CORPUS)), str(p))
    sub_path = tmp_path / SID / "subagents" / f"agent-{AGENT_ID}.jsonl"
    sub_path.parent.mkdir(parents=True)
    sub_path.write_text("")
    orient = session.Sub(CORPUS, "c0ffee01", USE, AGENT_ID, role=orientation.ROLE)
    orient.path = sub_path
    lv.subs.append(orient)
    helper = session.Sub(CORPUS, "c0ffee02", "k_agent", "a_helper")  # a subagent the orientation started
    helper.path = sub_path.with_name("agent-a_helper.jsonl")
    helper.path.write_text("")
    lv.subs.append(helper)

    async def later(path: Path, tool_use_id: str) -> None:
        await asyncio.sleep(0.15)  # Claude Code writes the line on a timer, after the call reached the server
        _add(path, [_assistant(_use(tool_use_id, terminal_tools.tool_name("add_card"), {}))])

    for path, tool_use_id, want in ((sub_path, "k_late", tools.ORIENT_SESSION), (p, "m_late", None)):
        task = asyncio.ensure_future(later(path, tool_use_id))
        assert await session.call_session(CORPUS, tool_use_id) == want, tool_use_id
        await task
    _add(sub_path, [_assistant(_use("k_agent", "Agent", {"description": "count", "prompt": "Count."}))])
    session.tail_once(lv)
    task = asyncio.ensure_future(later(helper.path, "h_late"))
    assert await session.call_session(CORPUS, "h_late") == tools.ORIENT_SESSION, "its own subagent works for it too"
    await task
    monkeypatch.setattr(session, "CALL_WAIT_S", 0.1)
    assert await session.call_session(CORPUS, "nowhere") is None, "a call in no transcript is main's once the wait ends"
    orient.done = True
    assert await session.call_session(CORPUS, "k_late") is None, "no wait while no orientation works"


async def test_a_follow_up_of_the_subagent_is_one_undo_batch():
    orientation.request(CORPUS, "", ["final"], route=orientation.SUBAGENT_ROUTE)
    chat = agents.new_agent(CORPUS, orientation.ROLE, orientation.TITLE, session=SID, agent_id=AGENT_ID)["id"]
    orientation.started(CORPUS, chat, agent_id=AGENT_ID)
    assert orient_session.undo_batch(CORPUS) is None, "the first run's cards are each a step"
    orientation.record(CORPUS, run=2, status="running")
    assert orient_session.undo_batch(CORPUS) == (f"{chat}/2", orientation.FOLLOWUP_LABEL)
    orientation.record(CORPUS, status="done")
    assert orient_session.undo_batch(CORPUS) is None


async def test_a_message_or_a_stop_from_the_browser_goes_through_main(tmp_path):
    q = _listen()
    orientation.request(CORPUS, "", ["final"], route=orientation.SUBAGENT_ROUTE)
    meta = agents.new_agent(CORPUS, orientation.ROLE, orientation.TITLE, by=agents.TERMINAL, session=SID, agent_id=AGENT_ID,
                            tool_use_id=USE)
    orientation.started(CORPUS, meta["id"], agent_id=AGENT_ID)
    res = await tools.call(CORPUS, "message_orientation", {"message": "Check April too."})
    assert not res.is_error and AGENT_ID in res.text and "SendMessage" in res.text
    out = await orient_session.message_route(CORPUS, orient_session.MessageBody(text="Check April too."))
    assert out["status"] == "relayed"
    note = q.get_nowait()
    assert note["meta"]["kind"] == "main" and note["content"] == tools.hint("orient-relay", text="Check April too.")
    stopped = await agents.interrupt_route(CORPUS, meta["id"])
    assert stopped == {"stopped": False, "asked": "main"}
    note = q.get_nowait()
    assert note["content"] == tools.hint("stop-subagent", title=orientation.TITLE, agent_id=AGENT_ID) and "TaskStop" in note["content"]


def test_the_plugin_agent_denies_the_tools_that_are_not_the_orientation_s_and_the_launcher_allows_its_prompt(home, data,
                                                                                                            monkeypatch, tmp_path):
    head = PLUGIN_AGENT.read_text().split("\n---\n", 1)[0].removeprefix("---\n")
    front = yaml.safe_load(head)
    assert front["name"] == orientation.SUBAGENT and front["background"] is True and "tools" not in front
    denied = {t.strip() for t in front["disallowedTools"].split(",")}
    assert denied == {terminal_tools.tool_name(n) for n in tools.REGISTRY if n not in orient_session.ORIENT_TOOLS}
    assert orientation.is_orient(f"thimble:{orientation.SUBAGENT}") and orientation.is_orient(orientation.AGENT)
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "claude"))
    ws = tmp_path / "ws"
    monkeypatch.setenv("THIMBLE_WORKSPACES_DIR", str(ws))
    tools_line = cli.launch_args(data / "mini").split("\n", 2)[1]
    rule = f"Read(/{ws.resolve()}/*/orient/{orientation.SUBAGENT_PROMPT})"
    assert rule in tools_line.split(",")


def test_the_mode_is_a_workspace_setting_off_by_default(workspaces_tmp):
    ledger.put_settings(CORPUS, {orientation.TERMINAL_FIRST_KEY: False})
    assert ledger.get_settings(CORPUS)[orientation.TERMINAL_FIRST_KEY] is False and not orientation.terminal_first(CORPUS)
    ledger.put_settings(CORPUS, {orientation.TERMINAL_FIRST_KEY: True})
    assert orientation.terminal_first(CORPUS)
    assert ledger.SETTINGS_DEFAULTS[orientation.TERMINAL_FIRST_KEY] is False
