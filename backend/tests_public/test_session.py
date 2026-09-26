"""session.py: the mirror of the analyst's Claude Code session. Attach and detach by the channel's subscription, which
is the session's liveness; the transcript tail, which reads only complete new lines from where it attached; a thread's
fork, whose tool calls go to its thread; a subagent, which is an agent chat ending with the report it handed back; the
end token, which no chat shows; push_event; and the startup sweep. Every transcript here is written by the test in
Claude Code's record shapes."""
from __future__ import annotations

import asyncio
import json
import signal
from pathlib import Path

import pytest

from app import agents, channel, config, session, threads

CORPUS = "mini"
SID = "e7b0a1f2-0000-4000-8000-000000000001"
ADD_CARD = "mcp__plugin_thimble_thimble__add_card"


@pytest.fixture(autouse=True)
def _fresh(workspaces_tmp, tmp_path, monkeypatch):
    # Claude Code's config dir, empty: the mirror reads a session's state file from it (session.session_state)
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "claude-config"))
    session._live.clear()
    session._expected.clear()
    session._event_threads.clear()
    session._came_back.clear()
    session._shim_pids.clear()
    channel._subs.clear()
    agents._busy.clear()
    yield
    session._live.clear()
    channel._subs.clear()


@pytest.fixture()
def cwd() -> str:
    return str(config.corpus_dir(CORPUS))


def _log(chat: str) -> list[dict]:
    _, log_path = agents.paths(CORPUS, chat)
    return agents.read_events(log_path)


def _mirror() -> list[dict]:
    return [r for r in _log(agents.MAIN_ID) if r.get("by") in ("terminal", "browser")]


def _attach(cwd: str, transcript: Path, sid: str = SID, **kw) -> session.Live:
    lv = session.attach(CORPUS, sid, cwd, str(transcript), **kw)
    assert lv is not None
    return lv


def _thread(tid: str, anchor: str = "card:68e99674") -> dict:
    """A thread chat under a fixed id, as agents.new_thread makes one."""
    meta = agents._defaults({"id": tid, "kind": agents.KIND_THREAD, "role": "thread", "title": tid, "created_at": "t",
                             "parent": agents.MAIN_ID, "anchor": anchor})
    agents.write_meta(CORPUS, meta)
    agents.paths(CORPUS, tid)[1].touch()
    return meta


END = {"type": "system", "subtype": "turn_duration"}


def _human(text: str) -> dict:
    return {"type": "user", "origin": {"kind": "human"}, "message": {"content": text}}


def _assistant(*blocks: dict) -> dict:
    return {"type": "assistant", "message": {"role": "assistant", "model": "claude-sonnet-5", "content": list(blocks)}}


def _say(text: str) -> dict:
    return {"type": "text", "text": text}


def _use(tool_use_id: str, name: str, tool_input: dict) -> dict:
    return {"type": "tool_use", "id": tool_use_id, "name": name, "input": tool_input}


def _result(tool_use_id: str, content) -> dict:
    return {"type": "user", "message": {"role": "user", "content": [
        {"type": "tool_result", "tool_use_id": tool_use_id, "content": content}]}}


def _subagent_file(tmp_path: Path, agent: str, meta: dict, records: list[dict]) -> Path:
    """A subagent's transcript where Claude Code writes it, <transcript dir>/<session id>/subagents/, with its meta."""
    path = tmp_path / SID / "subagents" / f"agent-{agent}.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.with_name(f"agent-{agent}.meta.json").write_text(json.dumps(meta))
    path.write_text("".join(json.dumps({**r, "isSidechain": True, "agentId": agent}) + "\n" for r in records))
    return path


# ----------------------------------------------------------------------------- the tail


def test_the_tail_translates_a_turn_and_skips_every_other_record(cwd, tmp_path):
    """A turn of main's: the prompt is the analyst's line, then the add_card call with the card id read from its result,
    the reply, and `done` at the turn's end. The ToolSearch that loaded add_card, attachments, thinking, meta prompts and
    queue records write nothing."""
    p = tmp_path / f"{SID}.jsonl"
    p.write_text("")
    lv = _attach(cwd, p)
    session.tail_once(lv)
    _append(p, lv, [
        _human("Add a card that counts the board's posts."),
        {"type": "attachment", "attachment": {"type": "environment"}},
        {"type": "queue-operation", "operation": "enqueue"},
        _assistant({"type": "thinking", "thinking": ""}),
        _assistant(_use("toolu_ts", "ToolSearch", {"query": "select:" + ADD_CARD})),
        _result("toolu_ts", "loaded"),
        _assistant(_use("toolu_ac", ADD_CARD, {"kind": "code", "question": "How many posts?", "code": "print(8)"})),
        _result("toolu_ac", '$ add_card kind="code" question="How many posts?" code="print(8)"\ncard:9b180761\nL1|8'),
        {"type": "user", "isMeta": True, "message": {"content": [{"type": "text", "text": "Base directory"}]}},
        _assistant(_say("card:9b180761")),
        END,
    ])
    recs = _mirror()
    assert [r["type"] for r in recs] == ["user", "tool_use", "tool_result", "text", "done"], recs
    user, use, made, text, _ = recs
    assert user["text"] == "Add a card that counts the board's posts." and user["by"] == "terminal"
    assert use["name"] == ADD_CARD and made["cell_id"] == "9b180761" and text["delta"] == "card:9b180761"
    assert not lv.degraded and lv.offset == p.stat().st_size and lv.buf == b""
    n = len(_log(agents.MAIN_ID))
    session.tail_once(lv)
    assert len(_log(agents.MAIN_ID)) == n  # nothing new


def test_the_tail_reads_only_complete_new_lines_and_starts_after_what_was_there(cwd, tmp_path):
    lines = [json.dumps(r).encode() for r in (
        _human("How many posts?"), _assistant(_use("b1", "Bash", {"command": "wc -l board.jsonl"})), _result("b1", "8 board.jsonl"),
        _assistant(_say("There are 8 posts.")), END)]
    p = tmp_path / "t.jsonl"
    p.write_bytes(b"\n".join(lines[:3]) + b"\n")
    lv = _attach(cwd, p)
    session.tail_once(lv)
    assert lv.offset == p.stat().st_size and _mirror() == []  # there before the attach: not replayed
    rest = b"\n".join(lines[3:]) + b"\n"
    cut = len(lines[3]) // 2
    with p.open("ab") as f:
        f.write(rest[:cut])
    session.tail_once(lv)
    assert lv.buf == rest[:cut], "a line cut in the middle waits for the rest of it"
    with p.open("ab") as f:
        f.write(rest[cut:])
    session.tail_once(lv)
    # the prompt was before the attach, so the turn it opened is not mirrored: the tail starts at the next turn
    assert _mirror() == [] and lv.buf == b""
    _append(p, lv, [_human("next"), _assistant(_say("ok")), END])
    assert [(r["type"], r.get("text") or r.get("delta")) for r in _mirror()] == [("user", "next"), ("text", "ok"), ("done", None)]


# ----------------------------------------------------------------------------- subagents and threads' forks


def _agent_chats() -> list[dict]:
    return [m for m in agents.list_chats(CORPUS) if m.get("kind") == "agent"]


def test_a_foreground_subagent_is_a_task_row_that_ends_with_the_report_it_handed_back(cwd, tmp_path, monkeypatch):
    """Main spawns a general-purpose subagent through the Agent tool. Its transcript, found under
    <transcript dir>/<session id>/subagents/ by the tool_use id its meta json names, gives its agent chat its rows, and
    the chat ends `done` with the message of its SubagentHandback once its file has been quiet after the Agent result."""
    monkeypatch.setattr(session, "SUB_QUIET_S", 0.0)
    use, agent = "toolu_agent1", "a03b0e13b025938eb"
    p = tmp_path / f"{SID}.jsonl"
    p.write_text("")
    lv = _attach(cwd, p)
    session.tail_once(lv)
    _subagent_file(tmp_path, agent, {"agentType": "general-purpose", "toolUseId": use, "description": "Count the files"}, [
        {"type": "user", "message": {"role": "user", "content": "Count the files under agents/."}},
        _assistant(_use("s1", "Bash", {"command": "ls agents | wc -l"})),
        _result("s1", "3"),
        _assistant(_use("s2", ADD_CARD, {"kind": "note", "question": "How many files?", "text": "3"})),
        _result("s2", "card:5a6b7c8d"),
        _assistant(_use("s3", "SubagentHandback", {"message": "3"})),
        _result("s3", "handed back"),
    ])
    _append(p, lv, [_human("How many transcripts are there?"), _assistant(_say("I will ask a subagent.")),
                    _assistant(_use(use, "Agent", {"description": "Count the files", "prompt": "Count the files under agents/.",
                                                   "subagent_type": "general-purpose"})),
                    _result(use, [{"type": "text", "text": "3"}]),
                    _assistant(_say("There are 3.")), END])
    session.tail_once(lv)
    recs = _mirror()
    kinds = [r["type"] for r in recs]
    assert kinds[:5] == ["user", "text", "tool_use", "agent", "tool_result"], kinds
    assert recs[2]["name"] == "Agent" and recs[2]["id"] == use
    assert recs[3] == {**recs[3], "role": "subagent", "title": "Count the files"}
    meta = _agent_chats()[0]
    assert meta == {**meta, "status": "done", "result": "3", "tool_use_id": use, "agent_id": agent,
                    "agent_type": "general-purpose", "session": SID}
    ev = _log(meta["id"])
    assert [e["name"] for e in ev if e["type"] == "tool_use"] == ["Bash", ADD_CARD, "SubagentHandback"]
    assert ev[0]["type"] == "user" and ev[-1]["type"] == "done" and ev[-1]["result"] == "3"
    assert all(s.done for s in lv.subs)


def test_a_fork_s_tool_calls_land_in_its_thread_and_its_agent_id_on_the_thread(cwd, tmp_path):
    """A thread's event reaches main as a channel record, and main forks with the Agent tool and the description
    `thread:<id>`, which is no row in main. The fork's transcript is matched to the thread by that description: its tool
    calls go into the thread's chat (never its text, the ToolSearch that loaded a tool or its reply_in_thread call), the
    thread's meta keeps its agent id and session, and the run ends at the fork's task notification."""
    tid, event, use, agent = "2b99eda7", "e7", "toolu_fork1", "a1f2e3d4c5b6a7980"
    reply = "mcp__plugin_thimble_thimble__reply_in_thread"
    _thread(tid)
    session.expect(CORPUS, event, thread=tid)
    agents.set_running(CORPUS, tid, True)  # as threads.event marks it
    p = tmp_path / f"{SID}.jsonl"
    p.write_text("")
    lv = _attach(cwd, p)
    session.tail_once(lv)
    _subagent_file(tmp_path, agent, {"agentType": "fork", "isFork": True, "description": f"thread:{tid}", "toolUseId": use}, [
        {"type": "user", "message": {"role": "user", "content": f"thread:{tid}"}},
        _assistant(_say("Looking at the event.")),
        _assistant(_use("k1", "ToolSearch", {"query": "select:" + reply})),
        _result("k1", "loaded"),
        _assistant(_use("k2", "mcp__plugin_thimble_thimble__read_ref", {"ref": "events.jsonl#L18"})),
        _result("k2", 'events.jsonl#L18 (pr.claim)\n{"ok": true, "pr": 7160}'),
        _assistant(_use("k3", reply, {"text": "agent-01 claimed #7160."})),
        _result("k3", "replied"),
    ])
    _append(p, lv, [_channel_event("thread", event, "question: what is this event?", thread=tid),
                    _assistant(_use(use, "Agent", {"subagent_type": "fork", "description": f"thread:{tid}", "prompt": f"thread:{tid}"})),
                    _result(use, [{"type": "text", "text": f"Async agent launched successfully.\nagentId: {agent} (internal ID)"}]),
                    _assistant(_say("(shown in the dashboard)")), END])
    assert agents._running(CORPUS, tid), "the fork runs past the turn that started it"
    threads.reply(CORPUS, tid, "agent-01 claimed #7160.", by="terminal")  # what the fork's reply_in_thread writes
    note = (f"<task-notification>\n<task-id>{agent}</task-id>\n<tool-use-id>{use}</tool-use-id>\n"
            "<status>completed</status>\n</task-notification>")
    _append(p, lv, [{"type": "user", "origin": {"kind": "task-notification"}, "message": {"content": note}},
                    _assistant(_say("(shown in the dashboard)")), END])
    assert not [r for r in _mirror() if r["type"] in ("tool_use", "agent", "text")], "the fork is no row in main"
    meta = agents.read_meta(CORPUS, tid)
    assert meta["fork"]["agent_id"] == agent and meta["fork"]["session"] == SID
    ev = _log(tid)
    assert [e["name"] for e in ev if e["type"] == "tool_use"] == ["mcp__plugin_thimble_thimble__read_ref"]
    assert [e["delta"] for e in ev if e["type"] == "text"] == ["agent-01 claimed #7160."], "the fork's own text is not the thread's"
    assert not agents._running(CORPUS, tid) and all(s.done for s in lv.subs)


def test_thimble_s_own_turn_is_not_mirrored_though_its_record_comes_after_the_attach(cwd, tmp_path):
    """/thimble's skill attaches the session before Claude Code writes the command's record, so the tail reads that
    turn. /thimble's turn opens none, whatever its action, so main's chat stays empty (the Start gate opens only while
    it is), and the next turn is mirrored as usual."""
    p = tmp_path / "t.jsonl"

    def human(content: str) -> str:
        return json.dumps({"type": "user", "origin": {"kind": "human"}, "message": {"content": content}})

    def reply(text: str) -> str:
        return json.dumps({"type": "assistant", "message": {"content": [{"type": "text", "text": text}]}})

    def command(name: str, action: str = "") -> str:
        args = f"\n<command-args>{action}</command-args>" if action else ""
        return human(f"<command-message>thimble:thimble</command-message>\n<command-name>{name}</command-name>{args}")

    end = json.dumps({"type": "system", "subtype": "turn_duration"})
    meta = json.dumps({"type": "user", "isMeta": True, "message": {"content": [{"type": "text", "text": "Base directory"}]}})
    p.write_text("\n".join([command("/thimble:thimble"), meta, reply("thimble: WARNING - the sandbox"), end]) + "\n")
    lv = _attach(cwd, p)
    session.tail_once(lv)  # the first /thimble's turn was there before the attach
    for action in ("", "fresh"):
        with p.open("a") as f:
            f.write("\n".join([command("/thimble:thimble", action), meta, reply("thimble: http://127.0.0.1:8891/"), end]) + "\n")
        session.tail_once(lv)
        assert _mirror() == [] and not lv.turn_open, action
    with p.open("a") as f:
        f.write("\n".join([human("How many runs are there?"), reply("Two."), end]) + "\n")
    session.tail_once(lv)
    rows = [("user", "How many runs are there?"), ("text", "Two."), ("done", None)]
    assert [(r["type"], r.get("text") or r.get("delta")) for r in _mirror()] == rows
    # a turn left open (its turn_duration never came) is closed by /thimble's record, with its `done`
    with p.open("a") as f:
        f.write("\n".join([human("And tasks?"), reply("Four."), command("/thimble"), reply("thimble: http://127.0.0.1:8891/"),
                           end]) + "\n")
    session.tail_once(lv)
    rows += [("user", "And tasks?"), ("text", "Four."), ("done", None)]
    assert [(r["type"], r.get("text") or r.get("delta")) for r in _mirror()] == rows
    assert not lv.turn_open and not agents._running(CORPUS, agents.MAIN_ID)


def test_a_local_command_in_the_terminal_opens_no_turn_and_is_no_row(cwd, tmp_path):
    """/effort typed in the terminal (Claude Code runs it there and the model never sees it) is written as a meta
    caveat, the command line and its output, all under one promptId, and no reply or turn_duration follows. It opens no
    turn, so main does not show as running (which would hide the Start gate for good), and its line is no row; the
    analyst's next line is mirrored as usual, one without a promptId too. As Claude Code 2.1.282 writes it."""
    lv = session.Live(CORPUS, "e" * 8, cwd, None, None)
    pid = "507dd4af-3e84-45fe-bfd7-86a79d24b39d"
    for rec in ({"type": "user", "isMeta": True, "promptId": pid, "message": {"content": "<local-command-caveat>Caveat: The messages below were generated by the user while running local commands. DO NOT respond to these messages or otherwise consider them in your response unless the user explicitly asks you to.</local-command-caveat>"}},
                {"type": "user", "promptId": pid, "message": {"content": "<command-name>/effort</command-name>\n            <command-message>effort</command-message>\n            <command-args></command-args>"}},
                {"type": "user", "promptId": pid, "message": {"content": "<local-command-stdout>Cancelled</local-command-stdout>"}}):
        session.translate(lv, json.dumps(rec))
    assert _mirror() == [] and not lv.turn_open and not agents._running(CORPUS, agents.MAIN_ID)
    # a caveat without a promptId (an older Claude Code) covers only the command's own records
    for rec in ({"type": "user", "isMeta": True, "message": {"content": "<local-command-caveat>Caveat</local-command-caveat>"}},
                {"type": "user", "message": {"content": "<command-name>/model</command-name>\n<command-args>opus</command-args>"}},
                {"type": "user", "message": {"content": "<local-command-stdout>Set model to Opus</local-command-stdout>"}}):
        session.translate(lv, json.dumps(rec))
    assert _mirror() == [] and not lv.turn_open
    session.translate(lv, json.dumps({"type": "user", "message": {"content": "How many runs are there?"}}))
    assert [(r["type"], r.get("text")) for r in _mirror()] == [("user", "How many runs are there?")] and lv.turn_open
    # a prompt command (a skill) has no caveat and is the analyst's line
    session.translate(lv, json.dumps({"type": "system", "subtype": "turn_duration"}))
    session.translate(lv, json.dumps({"type": "user", "origin": {"kind": "human"}, "promptId": "p2", "message": {
        "content": "<command-message>review</command-message>\n<command-name>/review</command-name>"}}))
    assert _mirror()[-1]["text"] == "/review" and lv.turn_open


def test_the_first_unreadable_record_disables_the_tail_with_one_error(cwd, tmp_path):
    p = tmp_path / "t.jsonl"
    p.write_text("")
    lv = _attach(cwd, p)
    session.tail_once(lv)
    lv.turn_open = True
    good = json.dumps({"type": "assistant", "isSidechain": False, "message": {"content": [{"type": "text", "text": "one"}]}})
    p.write_text(good + "\n" + '{"type": "assistant", "message": {"content": [{"no": "type"}]}}\n' + good.replace("one", "two") + "\n")
    session.tail_once(lv)
    recs = _mirror()
    assert [r["type"] for r in recs] == ["text", "error"] and recs[1]["message"] == "intermediate text unavailable"
    assert lv.degraded
    for bad in (b"not json", b"[1]", b'{"type": "assistant", "message": {"content": 3}}',
                b'{"type": "assistant", "message": {"content": [{"type": "text"}]}}',
                b'{"type": "assistant", "message": {"content": [{"type": "tool_use", "id": 1}]}}'):
        other = session.Live(CORPUS, "c" * 8, cwd, None, None)
        other.turn_open = True
        with pytest.raises(session.Unreadable):
            session.translate(other, bad)


def test_translate_skips_thinking_sidechains_meta_prompts_and_every_other_record(cwd):
    lv = session.Live(CORPUS, "d" * 8, cwd, None, None)
    for rec in ({"type": "attachment", "attachment": {"type": "environment"}}, {"type": "queue-operation"},
                {"type": "user", "isMeta": True, "message": {"content": "[Your previous response had no visible output.]"}},
                {"type": "user", "origin": {"kind": "human"}, "message": {"content": "<local-command-stderr>x</local-command-stderr>"}},
                {"type": "assistant", "isSidechain": True, "message": {"content": [{"type": "text", "text": "sub"}]}}):
        session.translate(lv, json.dumps(rec))
    assert _mirror() == []
    session.translate(lv, json.dumps({"type": "user", "origin": {"kind": "human"}, "message": {
        "content": "<command-message>thimble:orient</command-message>\n<command-name>/thimble:orient</command-name>\n<command-args>the renames</command-args>"}}))
    for rec in ({"type": "assistant", "message": {"content": [{"type": "thinking", "thinking": "hm"}]}},
                {"type": "assistant", "message": {"content": [{"type": "text", "text": "   "}]}},
                {"type": "assistant", "message": {"content": "a string reply"}}):
        session.translate(lv, json.dumps(rec))
    assert [(r["type"], r.get("text") or r.get("delta")) for r in _mirror()] == [("user", "/thimble:orient the renames"), ("text", "a string reply")]


def test_detach_stops_a_subagent_that_never_ended(cwd, tmp_path):
    lv = _attach(cwd, tmp_path / "t.jsonl")
    session.translate(lv, json.dumps({"type": "user", "origin": {"kind": "human"}, "message": {"content": "look around"}}))
    session.translate(lv, json.dumps({"type": "assistant", "message": {"content": [
        {"type": "tool_use", "id": "toolu_A", "name": "Agent", "input": {"description": "Look around", "prompt": "look", "subagent_type": "Explore"}}]}}))
    session.translate(lv, json.dumps({"type": "user", "message": {"content": [
        {"type": "tool_result", "tool_use_id": "toolu_A", "content": [{"type": "text", "text": "Async agent launched successfully.\nagentId: a77 (internal ID)"}]}]}}))
    meta = _agent_chats()[0]
    assert meta["status"] == "running" and meta["agent_id"] == "a77" and lv.busy, "a background agent runs past its launch"
    session.detach(CORPUS, SID)
    meta = agents.read_meta(CORPUS, meta["id"])
    assert meta["status"] == "stopped" and _log(meta["id"])[-1]["kind"] == "stopped"


def test_a_fork_described_by_its_event_id_still_finds_its_thread(cwd, tmp_path):
    """Main may describe a fork by the event's id instead of the thread's: the event's id is
    remembered with its thread when the channel posts it, so the fork still joins the thread."""
    _thread("t1")
    session.expect(CORPUS, "e1", thread="t1")
    assert session.thread_for(CORPUS, "thread:e1") == "t1" and session.thread_for(CORPUS, "thread:t1") == "t1"
    assert session.thread_for(CORPUS, "thread:nope") is None and session.thread_for(CORPUS, "Count the files") is None


def test_a_channel_record_the_channel_did_not_log_is_the_browser_s_line(cwd, tmp_path):
    """An event posted before this server started (so not in `expected`) is still the analyst's line."""
    p = tmp_path / "t.jsonl"
    p.write_text("")
    lv = _attach(cwd, p)
    session.tail_once(lv)
    rec = {"type": "user", "isMeta": True, "origin": {"kind": "channel", "server": "plugin:thimble:thimble"},
           "message": {"content": '<channel source="plugin:thimble:thimble" kind="main" event="e9">\nhow many?\n</channel>'}}
    p.write_text(json.dumps(rec) + "\n")
    session.tail_once(lv)
    assert [(r["type"], r["by"], r["text"], r["event"]) for r in _mirror()] == [("user", "browser", "how many?", "e9")]


def test_main_answering_a_thread_itself_is_a_line_in_main_and_the_thread_stops_running(cwd, tmp_path):
    """Main should fork, and when it answers a thread's event itself its words are main's text like any other (nothing
    guesses that they belong in the thread). The event marked the thread running (threads.event), and with no fork to
    stop it the turn's end does."""
    _thread("t2")
    session.expect(CORPUS, "e2", thread="t2")
    agents.set_running(CORPUS, "t2", True)
    p = tmp_path / "t.jsonl"
    p.write_text("")
    lv = _attach(cwd, p)
    session.tail_once(lv)
    recs = [{"type": "user", "isMeta": True, "origin": {"kind": "channel"},
             "message": {"content": '<channel source="plugin:thimble:thimble" kind="thread" event="e2" thread="t2">\nquestion: why?\n</channel>'}},
            {"type": "assistant", "message": {"content": [{"type": "text", "text": "Because of the renames."}]}},
            {"type": "system", "subtype": "turn_duration"}]
    p.write_text("".join(json.dumps(r) + "\n" for r in recs))
    session.tail_once(lv)
    assert [(r["type"], r.get("delta")) for r in _mirror()] == [("text", "Because of the renames."), ("done", None)]
    assert not [e for e in _log("t2") if e["type"] == "text"] and not agents._running(CORPUS, "t2")
    assert not lv.turn_threads and not lv.forked


def _channel_event(kind: str, event: str, body: str = "", **attrs: str) -> dict:
    extra = "".join(f' {k}="{v}"' for k, v in attrs.items())
    return {"type": "user", "isMeta": True, "origin": {"kind": "channel", "server": "plugin:thimble:thimble"},
            "message": {"content": f'<channel source="plugin:thimble:thimble" kind="{kind}" event="{event}"{extra}>\n{body}\n</channel>'}}


def _append(p: Path, lv: session.Live, recs: list[dict]) -> None:
    with p.open("a") as f:
        f.write("".join(json.dumps(r) + "\n" for r in recs))
    session.tail_once(lv)


def test_the_end_token_is_the_only_text_the_mirror_leaves_out(cwd, tmp_path):
    """Claude Code asks for a visible reply when a turn ends without text, and main.md asks main to end a turn that has
    nothing for the analyst with `(shown in the dashboard)`, rather than the mirror guessing which short lines to hide. A text
    that is only the token is not written, one that ends with it is written without it, and every other text is written
    as it is, a one-word line after the start and written events included."""
    p = tmp_path / "t.jsonl"
    p.write_text("")
    lv = _attach(cwd, p)
    session.tail_once(lv)
    _append(p, lv, [_channel_event("start", "s1", final_notebook="true"),
                  {"type": "assistant", "message": {"content": [{"type": "tool_use", "id": "o1", "name": "mcp__plugin_thimble_thimble__start_orientation",
                                                                 "input": {"brief": ""}}]}},
                  {"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "o1", "content": "The orientation has started."}]}},
                  {"type": "user", "isMeta": True, "message": {"content": "[Your previous response had no visible output. Please continue and produce a user-visible response.]"}},
                  {"type": "assistant", "message": {"content": [{"type": "text", "text": "(shown in the dashboard)"}]}},
                  {"type": "system", "subtype": "turn_duration"}])
    assert [(r["type"], r.get("name")) for r in _mirror()] == [
        ("tool_use", "mcp__plugin_thimble_thimble__start_orientation"), ("tool_result", None), ("done", None)]
    replies = [(_channel_event("written", "w1", "Wrote report:report.", doc="report"), " (shown in the dashboard)\n", None),
               (_channel_event("orient", "o2", "The orientation has finished: 8 cards.", status="done"),
                "It found two runs that never finished.\n\n(shown in the dashboard)", "It found two runs that never finished."),
               (_channel_event("written", "w2", "Wrote report:story.", doc="story"), "Done.", "Done."),
               (_channel_event("main", "m1", "how do I stop a turn?"), "Write (shown in the dashboard) on a line of its own.", "Write (shown in the dashboard) on a line of its own.")]
    for event, reply, shown in replies:
        _append(p, lv, [event, {"type": "assistant", "message": {"content": [{"type": "text", "text": reply}]}},
                        {"type": "system", "subtype": "turn_duration"}])
    assert [r["delta"] for r in _mirror() if r["type"] == "text"] == [s for _, _, s in replies if s is not None]


def test_visible_hides_the_whole_token_and_strips_it_from_the_end_only():
    assert session.END_TOKEN == "(shown in the dashboard)"
    for text in ("(shown in the dashboard)", "  (shown in the dashboard)\n", "\n\n(shown in the dashboard)\n\n", "(Shown in the dashboard)", "(shown in the dashboard).",
                 "*(shown in the dashboard)*", "_(shown in the dashboard)_", "(SHOWN IN THE DASHBOARD)"):
        assert session.visible(text) == "", text
    assert session.visible("Started the writer. (shown in the dashboard)") == "Started the writer."
    assert session.visible("The report is written.\n\n(shown in the dashboard)\n") == "The report is written."
    assert session.visible("Forked the thread. _(shown in the dashboard)_.") == "Forked the thread."
    for text in ("Started.", "Done.\nSee the card.", "(shown in the dashboard) is the token.", "Write (shown in the dashboard) on its own line.",
                 "I cannot open files in the browser.", "The chart is shown in the browser", "in the browser",
                 "The chart is shown in the dashboard.", "shown in the dashboard", ""):
        assert session.visible(text) == text, text


def test_a_subagent_s_return_and_a_workflow_s_are_written_unless_main_ends_with_the_token(cwd, tmp_path):
    """A subagent's return needs no words from main (main.md), which then ends the turn with the token and nothing is
    written; a short line main writes there instead reaches the chat, as does a workflow's answer."""
    p = tmp_path / "t.jsonl"
    p.write_text("")
    lv = _attach(cwd, p)
    session.tail_once(lv)
    _append(p, lv, [{"type": "user", "origin": {"kind": "human"}, "message": {"content": "check the report"}},
                    {"type": "assistant", "message": {"content": [
                        {"type": "tool_use", "id": "a1", "name": "Agent", "input": {"description": "verify", "subagent_type": "thimble:verify", "prompt": "check"}},
                        {"type": "tool_use", "id": "a2", "name": "Agent", "input": {"description": "count", "subagent_type": "general-purpose", "prompt": "count"}},
                        {"type": "tool_use", "id": "w1", "name": "Workflow", "input": {"script": "export const meta = {name: 'count'}"}}]}},
                    {"type": "user", "message": {"content": [
                        {"type": "tool_result", "tool_use_id": "a1", "content": [{"type": "text", "text": "Async agent launched successfully.\nagentId: ag1 (internal ID)"}]},
                        {"type": "tool_result", "tool_use_id": "a2", "content": [{"type": "text", "text": "Async agent launched successfully.\nagentId: ag2 (internal ID)"}]},
                        {"type": "tool_result", "tool_use_id": "w1", "content": "Workflow launched in background. Task ID: wt1"}]}},
                    {"type": "assistant", "message": {"content": [{"type": "text", "text": "(shown in the dashboard)"}]}},
                    {"type": "system", "subtype": "turn_duration"}])
    note = "<task-notification>\n<task-id>{t}</task-id>\n<tool-use-id>{u}</tool-use-id>\n<status>completed</status>\n<result>{r}</result>\n</task-notification>"
    for task, use, result, reply in (("ag1", "a1", "all sentences hold", "(shown in the dashboard)"), ("ag2", "a2", "9 files", "Done."),
                                     ("wt1", "w1", "yes, 12 runs", "Yes, 12 runs.")):
        _append(p, lv, [{"type": "user", "origin": {"kind": "task-notification"}, "message": {"content": note.format(t=task, u=use, r=result)}},
                        {"type": "assistant", "message": {"content": [{"type": "text", "text": reply}]}},
                        {"type": "system", "subtype": "turn_duration"}])
    assert [r.get("delta") for r in _mirror() if r["type"] == "text"] == ["Done.", "Yes, 12 runs."]


def test_a_thread_s_turn_is_written_like_any_other(cwd, tmp_path):
    """No hidden rule decides what main's forced reply is. main.md asks main to end a turn that forked a thread with
    `(shown in the dashboard)`, since the fork answers in the thread, and a fork's return needs no words either: such turns
    write nothing in main and end without a `done`. A line main writes there instead is main's text, as in any other
    turn, and never the thread's reply. A forked thread runs until its fork's task notification."""
    p = tmp_path / "t.jsonl"
    p.write_text("")
    lv = _attach(cwd, p)
    session.tail_once(lv)
    note = "<task-notification>\n<task-id>{a}</task-id>\n<tool-use-id>{u}</tool-use-id>\n<status>completed</status>\n</task-notification>"
    for tid, event, use, agent, forked, returned in (("t3", "e3", "f3", "af3", "(shown in the dashboard)", "(shown in the dashboard)"),
                                                     ("t4", "e4", "f4", "af4", "Forked.", "Answered in the thread. (shown in the dashboard)")):
        _thread(tid)
        session.expect(CORPUS, event, thread=tid)
        agents.set_running(CORPUS, tid, True)  # as threads.event marks it
        _append(p, lv, [_channel_event("thread", event, "question: why?", thread=tid),
                        {"type": "assistant", "message": {"content": [{"type": "tool_use", "id": use, "name": "Agent", "input": {
                            "subagent_type": "fork", "description": f"thread:{tid}", "prompt": f"thread:{tid}"}}]}},
                        {"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": use, "content": [
                            {"type": "text", "text": f"Async agent launched successfully.\nagentId: {agent} (internal ID)"}]}]}},
                        {"type": "assistant", "message": {"content": [{"type": "text", "text": forked}]}},
                        {"type": "system", "subtype": "turn_duration"}])
        assert agents._running(CORPUS, tid), f"{tid}'s fork runs past the turn that started it"
        threads.reply(CORPUS, tid, f"the answer in {tid}", by="terminal")  # the fork's reply_in_thread
        _append(p, lv, [{"type": "user", "origin": {"kind": "task-notification"}, "message": {"content": note.format(a=agent, u=use)}},
                        {"type": "assistant", "message": {"content": [{"type": "text", "text": returned}]}},
                        {"type": "system", "subtype": "turn_duration"}])
        assert not agents._running(CORPUS, tid), f"{tid}'s fork stopped"
        assert [e["delta"] for e in _log(tid) if e["type"] == "text"] == [f"the answer in {tid}"]
    assert [(r["type"], r.get("delta")) for r in _mirror()] == [
        ("text", "Forked."), ("done", None), ("text", "Answered in the thread."), ("done", None)]


def test_an_agent_chat_leaves_the_token_out_too(cwd, tmp_path):
    """The mirror writes a subagent's text, and the orientation's, a writer's and a critique's (agent_session.py),
    through translate_sub, which leaves the token out the same way."""
    lv = _attach(cwd, tmp_path / "t.jsonl")
    meta = agents.new_agent(CORPUS, "subagent", "verify", by="terminal")
    sub = session.Sub(CORPUS, str(meta["id"]), None, "ag9")
    for text in ("(shown in the dashboard)", "Checked six sentences. (shown in the dashboard)", "Checked."):
        session.translate_sub(lv, sub, json.dumps({"type": "assistant", "message": {"content": [{"type": "text", "text": text}]}}))
    assert [e["delta"] for e in _log(str(meta["id"])) if e["type"] == "text"] == ["Checked six sentences.", "Checked."]


def test_attach_is_main_s_state_not_a_line_in_its_chat_and_is_restored_after_a_restart(cwd, tmp_path):
    """The session's state is main's `attached`, which the composer reads, and nothing is written in the chat, so a
    launch or a restart adds no lines."""
    lv = _attach(cwd, tmp_path / "t.jsonl")
    assert agents.ensure_main(CORPUS)["attached"]["session"] == SID and _log(agents.MAIN_ID) == []
    assert session.attach(CORPUS, SID, cwd) is lv
    session._live.clear()  # the server restarted: main's meta and sessions.json still say attached
    again = session.attach(CORPUS, SID, cwd)
    assert again is not None and again is not lv and again.since == lv.since and again.transcript_path == lv.transcript_path
    assert _log(agents.MAIN_ID) == []


def test_a_restart_mid_turn_reads_on_from_where_the_tail_stood(cwd, tmp_path):
    """The server restarts just after main's add_card call answered, before the tail read the result. Meanwhile the
    session writes the result and its answer, and ends the turn. The restarted server attaches the session again and
    reads on from the cursor sessions.json kept, with the turn still open, so the result (its card read from it, which
    needs the call's name from before the restart), the answer and `done` reach main's chat, and nothing written
    before the restart is written twice."""
    p = tmp_path / f"{SID}.jsonl"
    p.write_text("")
    lv = _attach(cwd, p)
    session.tail_once(lv)
    _append(p, lv, [_human("Add a card that counts the posts."),
                    _assistant(_say("Counting."), _use("toolu_ac", ADD_CARD, {"kind": "code", "code": "print(8)"}))])
    before = _mirror()
    assert [r["type"] for r in before] == ["user", "text", "tool_use"]
    session._live.clear()  # the server stopped
    with p.open("a") as f:  # what the session wrote while no server read it
        f.write(json.dumps(_result("toolu_ac", '$ add_card kind="code"\ncard:9b180761\nL1|8')) + "\n")
        f.write(json.dumps(_assistant(_say("There are 8 posts."))) + "\n")
        f.write(json.dumps(END) + "\n")
    again = session.attach(CORPUS, SID, cwd)
    assert again is not None and again is not lv and again.turn_open
    session.tail_once(again)
    after = _mirror()
    assert after[:len(before)] == before
    added = after[len(before):]
    assert [r["type"] for r in added] == ["tool_result", "text", "done"]
    assert added[0]["id"] == "toolu_ac" and added[0]["cell_id"] == "9b180761"
    assert added[1]["delta"] == "There are 8 posts."
    assert not again.turn_open


def _note(agent: str, use: str) -> dict:
    """The task notification Claude Code writes in main when a background agent stops."""
    return {"type": "user", "origin": {"kind": "task-notification"}, "message": {"content": (
        f"<task-notification>\n<task-id>{agent}</task-id>\n<tool-use-id>{use}</tool-use-id>\n<status>completed</status>\n"
        "</task-notification>")}}


def _launched(agent: str) -> str:
    return f"Async agent launched successfully.\nagentId: {agent} (internal ID)"


def test_a_restart_reads_on_each_subagent_and_fork_from_where_it_stood(cwd, tmp_path):
    """The server stops while a background subagent and a thread's fork run. Meanwhile both go on writing, a second
    subagent starts and finishes, and main hears that all three stopped. The restarted server reads each subagent's
    and the fork's transcript on from the place sessions.json kept, and the new subagent's from its start: every line
    written while no server ran reaches its chat, none is written twice, a card's result is read with the call's name
    from before the restart, and each run ends after its last line."""
    tid, fork, fuse = "5c0de0aa", "af0f0f0f0f0f0f0f0", "toolu_fork"
    sub, suse, late, luse = "a1a1a1a1a1a1a1a1a", "toolu_sub", "a2a2a2a2a2a2a2a2a", "toolu_late"
    _thread(tid)
    agents.set_running(CORPUS, tid, True)
    p = tmp_path / f"{SID}.jsonl"
    p.write_text("")
    lv = _attach(cwd, p)
    session.tail_once(lv)
    sub_file = _subagent_file(tmp_path, sub, {"agentType": "general-purpose", "toolUseId": suse, "description": "Count posts"}, [
        {"type": "user", "message": {"role": "user", "content": "Count the posts."}},
        _assistant(_use("s1", ADD_CARD, {"kind": "code", "question": "How many posts?", "code": "print(8)"})),
    ])
    fork_file = _subagent_file(tmp_path, fork, {"agentType": "fork", "description": f"thread:{tid}", "toolUseId": fuse}, [
        {"type": "user", "message": {"role": "user", "content": f"thread:{tid}"}},
        _assistant(_use("k1", "mcp__plugin_thimble_thimble__read_ref", {"ref": "events.jsonl#L1"})),
    ])
    _append(p, lv, [_human("Count the posts, and answer the thread."),
                    _assistant(_use(suse, "Agent", {"description": "Count posts", "prompt": "Count the posts.", "run_in_background": True})),
                    _result(suse, [{"type": "text", "text": _launched(sub)}]),
                    _assistant(_use(fuse, "Agent", {"subagent_type": "fork", "description": f"thread:{tid}", "prompt": f"thread:{tid}"})),
                    _result(fuse, [{"type": "text", "text": _launched(fork)}]),
                    _assistant(_say("(shown in the dashboard)")), END])
    session.tail_once(lv)
    chat = next(m["id"] for m in _agent_chats() if m.get("agent_id") == sub)
    assert [e["type"] for e in _log(chat)] == ["user", "tool_use"]
    assert [e["type"] for e in _log(tid)] == ["tool_use"]
    session._live.clear()  # the server stopped
    agents._busy.clear()

    def put(path: Path, agent: str, recs: list[dict]) -> None:
        with path.open("a") as f:
            f.write("".join(json.dumps({**r, "isSidechain": True, "agentId": agent}) + "\n" for r in recs))

    # what the subagents, the fork and main wrote while no server read them
    put(sub_file, sub, [_result("s1", '$ add_card kind="code"\ncard:6d7e8f90\nL1|8'), _assistant(_say("There are 8 posts."))])
    put(fork_file, fork, [_result("k1", "events.jsonl#L1 (pr.claim)"), _assistant(_use("k2", "Bash", {"command": "wc -l events.jsonl"})),
                          _result("k2", "3 events.jsonl")])
    _subagent_file(tmp_path, late, {"agentType": "general-purpose", "toolUseId": luse, "description": "List agents"}, [
        {"type": "user", "message": {"role": "user", "content": "List the agents."}},
        _assistant(_use("l1", "Bash", {"command": "ls agents"})), _result("l1", "agent-01.jsonl")])
    with p.open("a") as f:
        f.write("".join(json.dumps(r) + "\n" for r in (
            _note(sub, suse), _human("And list the agents."),
            _assistant(_use(luse, "Agent", {"description": "List agents", "prompt": "List the agents.", "run_in_background": True})),
            _result(luse, [{"type": "text", "text": _launched(late)}]), _assistant(_say("(shown in the dashboard)")), END,
            _note(late, luse), _note(fork, fuse), _assistant(_say("(shown in the dashboard)")), END)))
    again = session.attach(CORPUS, SID, cwd)
    assert again is not None and again is not lv
    session.tail_once(again)
    ev = _log(chat)
    assert [e["type"] for e in ev] == ["user", "tool_use", "tool_result", "text", "done"], ev
    assert ev[2]["cell_id"] == "6d7e8f90", "the result is read with the add_card name kept from before the restart"
    assert ev[3]["delta"] == "There are 8 posts."
    ev = _log(tid)
    assert [e["type"] for e in ev] == ["tool_use", "tool_result", "tool_use", "tool_result", "done"], ev
    assert not agents._running(CORPUS, tid)
    new = next(m for m in _agent_chats() if m.get("agent_id") == late)
    assert [e["type"] for e in _log(new["id"])] == ["user", "tool_use", "tool_result", "done"]
    assert len(_agent_chats()) == 2
    # a second restart reads nothing twice
    n = {c: len(_log(c)) for c in (chat, tid, new["id"])}
    session._live.clear()
    session.tail_once(session.attach(CORPUS, SID, cwd))
    assert {c: len(_log(c)) for c in n} == n


def test_a_restart_after_a_session_attached_anew_does_not_replay_a_subagent_the_earlier_attach_read(cwd, tmp_path,
                                                                                                    monkeypatch):
    """A subagent an earlier attach of the session followed to its end keeps its chat as it is when the session attaches
    anew (a /resume brings it back) and the server then restarts: the new attach kept no place for its file, and its
    chat has lines, so the file is not read again."""
    monkeypatch.setattr(session, "SUB_QUIET_S", 0.0)
    use, agent = "toolu_old", "a0b0c0d0e0f0a0b0c"
    p = tmp_path / f"{SID}.jsonl"
    p.write_text("")
    lv = _attach(cwd, p)
    session.tail_once(lv)
    _subagent_file(tmp_path, agent, {"agentType": "general-purpose", "toolUseId": use, "description": "List agents"}, [
        {"type": "user", "message": {"role": "user", "content": "List the agents."}},
        _assistant(_use("o1", "Bash", {"command": "ls agents"})), _result("o1", "agent-01.jsonl"), _assistant(_say("One agent."))])
    _append(p, lv, [_human("List the agents."), _assistant(_use(use, "Agent", {"description": "List agents", "prompt": "List the agents."})),
                    _result(use, [{"type": "text", "text": "One agent."}]), _assistant(_say("One agent.")), END])
    session.tail_once(lv)
    chat = _agent_chats()[0]["id"]
    n = len(_log(chat))
    assert n >= 4 and _log(chat)[-1]["type"] == "done"
    session.detach(CORPUS, SID, "ended")
    session.tail_once(_attach(cwd, p))  # attached anew
    session._live.clear()  # the server restarted
    session.tail_once(session.attach(CORPUS, SID, cwd))
    assert len(_log(chat)) == n and len(_agent_chats()) == 1


def test_a_session_attached_anew_does_not_replay_an_old_cursor_after_a_restart(cwd, tmp_path):
    """A cursor from an earlier attach of the same session is replaced when the session attaches anew (a /resume brings
    it back), so a restart afterwards reads on from the new attach, not from the old place."""
    p = tmp_path / f"{SID}.jsonl"
    p.write_text("")
    lv = _attach(cwd, p)
    session.tail_once(lv)
    _append(p, lv, [_human("First."), _assistant(_say("One.")), END])
    session.detach(CORPUS, SID, "ended")
    with p.open("a") as f:  # written while it was not main
        f.write("".join(json.dumps(r) + "\n" for r in (_human("Second."), _assistant(_say("Two.")), END)))
    n = len(_mirror())
    lv = _attach(cwd, p)
    session.tail_once(lv)
    session._live.clear()
    again = session.attach(CORPUS, SID, cwd)
    session.tail_once(again)
    assert len(_mirror()) == n, "the lines written while the session was not main are not replayed"


def test_a_relaunch_that_resumes_the_session_does_not_replay_its_finished_forks_and_subagents(cwd, tmp_path, monkeypatch):
    """The analyst quits Claude Code and runs `thimble` again, which resumes the same session id in a new `claude`
    process. A thread's fork and a subagent of that session had finished, and their transcripts are still in the
    session's folder. The next turn of the resumed main neither writes their calls into their chats a second time, nor
    opens a second agent chat for the subagent, nor sets the thread running again."""
    monkeypatch.setattr(session, "SUB_QUIET_S", 0.0)
    tid, fork, fuse = "7e1a0c3b", "a7a7a7a7a7a7a7a7a", "toolu_fork7"
    sub, suse = "a8a8a8a8a8a8a8a8a", "toolu_sub8"
    _thread(tid)
    agents.set_running(CORPUS, tid, True)
    p = tmp_path / f"{SID}.jsonl"
    p.write_text("")
    lv = _attach(cwd, p)
    session.tail_once(lv)
    _subagent_file(tmp_path, fork, {"agentType": "fork", "description": f"thread:{tid}", "toolUseId": fuse}, [
        {"type": "user", "message": {"role": "user", "content": f"thread:{tid}"}},
        _assistant(_use("k1", ADD_CARD, {"kind": "code", "question": "How many posts?", "code": "print(8)"})),
        _result("k1", '$ add_card kind="code"\ncard:6d7e8f91\nL1|8')])
    _subagent_file(tmp_path, sub, {"agentType": "general-purpose", "toolUseId": suse, "description": "List agents"}, [
        {"type": "user", "message": {"role": "user", "content": "List the agents."}},
        _assistant(_use("s1", "Bash", {"command": "ls agents"})), _result("s1", "agent-01.jsonl")])
    _append(p, lv, [_human("Count the posts in the thread, and list the agents."),
                    _assistant(_use(fuse, "Agent", {"subagent_type": "fork", "description": f"thread:{tid}", "prompt": f"thread:{tid}"})),
                    _result(fuse, [{"type": "text", "text": _launched(fork)}]),
                    _assistant(_use(suse, "Agent", {"description": "List agents", "prompt": "List the agents.", "run_in_background": True})),
                    _result(suse, [{"type": "text", "text": _launched(sub)}]),
                    _assistant(_say("(shown in the dashboard)")), END,
                    _note(fork, fuse), _note(sub, suse), _assistant(_say("(shown in the dashboard)")), END])
    chat = next(m["id"] for m in _agent_chats() if m.get("agent_id") == sub)
    before = {c: _log(c) for c in (tid, chat)}
    assert [e["type"] for e in before[tid]] == ["tool_use", "tool_result", "done"], before[tid]
    session.detach(CORPUS, SID, "ended")  # /exit in the terminal
    lv = _attach(cwd, p)  # `thimble` again: the same session id, resumed in a new process
    session.tail_once(lv)
    _append(p, lv, [_human("Do you remember the thread?")])  # the tail reads while the turn is open
    _append(p, lv, [_assistant(_say("Yes.")), END])
    assert {c: _log(c) for c in (tid, chat)} == before, "no call of a finished fork or subagent is written twice"
    assert len(_agent_chats()) == 1
    assert not agents._running(CORPUS, tid) and not agents._running(CORPUS, chat)


def test_loading_a_deferred_tool_is_no_row_in_main_or_a_subagent_s_chat(cwd, tmp_path):
    """ToolSearch loads a tool's schema before its first call (a fork loads reply_in_thread, main loads SendMessage for
    a follow-up); it did nothing the analyst reads, so neither the call nor its result is a row."""
    transcript = tmp_path / f"{SID}.jsonl"
    transcript.write_text("")
    lv = _attach(cwd, transcript)
    session._open_turn(lv)
    use = {"type": "assistant", "message": {"role": "assistant", "content": [
        {"type": "tool_use", "id": "toolu_ts", "name": "ToolSearch", "input": {"query": "select:SendMessage"}}]}}
    res = {"type": "user", "message": {"role": "user", "content": [
        {"type": "tool_result", "tool_use_id": "toolu_ts", "content": "loaded"}]}}
    session.translate(lv, json.dumps(use))
    session.translate(lv, json.dumps(res))
    assert not [r for r in _log(agents.MAIN_ID) if r.get("id") == "toolu_ts"]
    writer = session._spawn(lv, "toolu_w", "aw1", "write report", "thimble:writer")
    assert session.translate_sub(lv, writer, json.dumps(use)) == 0
    assert session.translate_sub(lv, writer, json.dumps(res)) == 0
    assert not [r for r in _log(writer.chat) if r.get("id") == "toolu_ts"]


def test_a_new_session_replaces_the_one_before(cwd, tmp_path):
    _attach(cwd, tmp_path / "t.jsonl")
    new = session.attach(CORPUS, "a" * 8, cwd, str(tmp_path / "u.jsonl"))
    assert new is not None and agents.ensure_main(CORPUS)["attached"]["session"] == "a" * 8
    assert session.sessions(CORPUS)[SID]["reason"] == "replaced"
    assert _log(agents.MAIN_ID) == [], "a relaunch writes nothing in main's chat"
    assert session.attach(CORPUS, "bad id!", cwd) is None


def test_the_transcript_is_found_by_the_session_id(cwd, tmp_path, monkeypatch):
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "cc"))
    p = tmp_path / "cc" / "projects" / "-some-corpus" / f"{SID}.jsonl"
    p.parent.mkdir(parents=True)
    p.write_text("")
    assert session.find_transcript(SID) == str(p) and session.find_transcript("f" * 8) is None
    lv = session.attach(CORPUS, SID, cwd)
    assert lv is not None and lv.transcript_path == str(p)


def test_the_subscription_is_the_session_s_liveness(cwd, tmp_path, monkeypatch):
    """connected attaches the session the shim names; when the last subscriber leaves, the session is detached after
    GRACE_S unless a subscriber comes back first."""
    monkeypatch.setattr(session, "GRACE_S", 0.05)

    async def go():
        q: asyncio.Queue = asyncio.Queue()
        channel._subs.setdefault(CORPUS, set()).add(q)
        session.connected(CORPUS, SID, cwd, 123)
        assert session.current(CORPUS).sid == SID and session.current(CORPUS).pid == 123
        channel._subs[CORPUS].discard(q)
        session.disconnected(CORPUS, SID)
        channel._subs[CORPUS].add(q)  # the shim came back within the grace (a server restart, a reconnect)
        session.connected(CORPUS, SID, cwd, 123)
        await asyncio.sleep(0.1)
        assert session.current(CORPUS) is not None
        channel._subs[CORPUS].discard(q)
        session.disconnected(CORPUS, SID)
        await asyncio.sleep(0.1)
        assert session.current(CORPUS) is None and agents.ensure_main(CORPUS)["attached"] is None

    asyncio.run(go())
    assert _log(agents.MAIN_ID) == [], "the session's end is main's `attached` gone, not a line in its chat"


def test_the_sweep_detaches_a_session_whose_shim_never_came_back(cwd, tmp_path):
    _attach(cwd, tmp_path / "t.jsonl")
    channel._subs[CORPUS] = {asyncio.Queue()}
    assert session.sweep() == []  # a shim is subscribed
    channel._subs.clear()
    session._live.clear()  # a restarted server, and nobody subscribed since
    assert session.sweep() == [SID] and agents.ensure_main(CORPUS)["attached"] is None
    assert session.sweep() == []


def test_the_sweep_leaves_a_session_whose_shim_came_back_since_the_server_started(cwd, tmp_path):
    """On the hook route the server restarted, main's own shim subscribed again and attached the session, and then its
    stream ended: the sweep must not clear main's meta, since on this route the shim attaches only the session main's
    meta names."""
    _attach(cwd, tmp_path / "t.jsonl")
    session._live.clear()  # a restarted server
    session.connected(CORPUS, SID, cwd, 123, claim=False)
    assert session.current(CORPUS).sid == SID
    assert session.sweep() == [] and agents.ensure_main(CORPUS)["attached"]["session"] == SID


def test_nothing_is_detached_while_the_server_is_stopping(cwd, tmp_path):
    """uvicorn ends the channel's streams as soon as SIGTERM comes (sse_starlette watches its flag), then waits for the
    connections to close before the lifespan's shutdown cancels the sweep and the grace timers. A sweep or a grace that
    fires in between finds no subscriber anywhere, so neither detaches while the server is stopping."""

    class Server:  # uvicorn.Server, as its bound handle_exit shows it to signal.getsignal
        should_exit = False

        def handle_exit(self, sig, frame) -> None:
            self.should_exit = True

    server = Server()
    before = signal.signal(signal.SIGTERM, server.handle_exit)
    try:
        _attach(cwd, tmp_path / "t.jsonl")
        server.should_exit = True
        assert session.sweep() == []
        session.disconnected(CORPUS, SID)  # no running loop here, so the grace's check runs at once
        assert session.current(CORPUS) is not None and agents.ensure_main(CORPUS)["attached"]["session"] == SID
        server.should_exit = False
        from sse_starlette.sse import AppStatus  # noqa: PLC0415

        AppStatus.should_exit = True  # the flag as sse_starlette mirrors it for the streams
        try:
            assert session.sweep() == []
        finally:
            AppStatus.should_exit = False
    finally:
        signal.signal(signal.SIGTERM, before)
    assert session.sweep() == [SID], "a server that runs sweeps a record whose shim never came back"


def test_push_event_sends_when_a_session_listens_and_says_so_when_none_does(cwd):
    assert session.push_event(CORPUS, "checked", "Unverified: 2 comments.", check="unverified") is False
    q: asyncio.Queue = asyncio.Queue()
    channel._subs[CORPUS] = {q}
    assert session.push_event(CORPUS, "checked", "Unverified: 2 comments.", check="unverified") is True
    note = q.get_nowait()
    assert note["content"] == "Unverified: 2 comments." and note["meta"]["kind"] == "checked" and note["meta"]["check"] == "unverified"
    assert agents._running(CORPUS, agents.MAIN_ID), "main runs until the turn the event opens ends"
    assert session.push_event(CORPUS, "view", "Build the Page boards view.", view="page-boards") is True
    assert q.empty(), "a built view waits for the next event (test_terminal_tools.py)"


def test_an_event_that_reaches_a_busy_turn_between_tool_calls_is_handled_in_that_turn(cwd, tmp_path):
    """Claude Code attaches an event that arrives during a tool call to that call's result (a `queued_command`
    attachment, origin channel). The turn stays the analyst's own: main's text is mirrored, while its fork for the thread
    is no row in main and joins the thread."""
    _thread("t3")
    session.expect(CORPUS, "e3", thread="t3")
    p = tmp_path / "t.jsonl"
    p.write_text("")
    lv = _attach(cwd, p)
    session.tail_once(lv)
    event = '<channel source="plugin:thimble:thimble" kind="thread" event="e3" thread="t3">\nquestion: why?\n</channel>'
    recs = [{"type": "user", "origin": {"kind": "human"}, "message": {"content": "count the runs"}},
            {"type": "assistant", "message": {"content": [{"type": "tool_use", "id": "b1", "name": "Bash", "input": {"command": "ls"}}]}},
            {"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "b1", "content": "a\nb"}]}},
            {"type": "attachment", "attachment": {"type": "queued_command", "prompt": event, "origin": {"kind": "channel"}}},
            {"type": "assistant", "message": {"content": [{"type": "text", "text": "There are 2 runs."},
                                                          {"type": "tool_use", "id": "f1", "name": "Agent",
                                                           "input": {"subagent_type": "fork", "description": "thread:t3", "prompt": "thread:t3"}}]}},
            {"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "f1", "content": [
                {"type": "text", "text": "Async agent launched successfully.\nagentId: a9 (internal ID)"}]}]}},
            {"type": "system", "subtype": "turn_duration"}]
    p.write_text("".join(json.dumps(r) + "\n" for r in recs))
    session.tail_once(lv)
    assert [(r["type"], r.get("text") or r.get("delta") or r.get("name")) for r in _mirror()] == [
        ("user", "count the runs"), ("tool_use", "Bash"), ("tool_result", None), ("text", "There are 2 runs."), ("done", None)]
    assert agents.read_meta(CORPUS, "t3")["fork"] == {"tool_use_id": "f1", "session": SID, "agent_id": "a9"}
    assert agents._running(CORPUS, "t3") and not agents._running(CORPUS, agents.MAIN_ID)


def test_a_subagent_started_by_a_subagent_ends_when_its_parent_hears_it_stopped(cwd, tmp_path):
    """The writer starts the verifier (a nested Agent call runs in the background). Its task
    notification reaches the writer, never main, as a queued_command attachment in the writer's own transcript, with the
    verifier's hand-back before it as a peer message; the mirror finishes the verifier's chat from there, and neither
    record becomes a line of the writer's chat."""
    transcript = tmp_path / f"{SID}.jsonl"
    transcript.write_text("")
    lv = _attach(cwd, transcript)
    writer = session._spawn(lv, "toolu_w", "aw1", "write report", "thimble:writer")
    verify = session._spawn(lv, "toolu_v", "av1", "Verify report:report", "thimble:verify")
    handback = {"type": "user", "isSidechain": True, "origin": {"kind": "peer", "from": "av1", "senderTaskId": "av1", "handback": True},
                "message": {"role": "user", "content": "Another Claude session sent a message while you were working:\n<agent-message from=\"av1\">done</agent-message>"}}
    note = {"type": "attachment", "isSidechain": True, "attachment": {"type": "queued_command", "prompt":
            "<task-notification>\n<task-id>av1</task-id>\n<tool-use-id>toolu_v</tool-use-id>\n<status>completed</status>\n"
            "<summary>Agent \"Verify report:report\" finished</summary>\n</task-notification>"}}
    assert session.translate_sub(lv, writer, json.dumps(handback)) == 0 and not verify.done
    assert session.translate_sub(lv, writer, json.dumps(note)) == 0
    assert verify.done and not writer.done
    metas = {m["id"]: m for m in _agent_chats()}
    assert metas[verify.chat]["status"] == "done" and metas[writer.chat]["status"] == "running"
    assert not [e for e in _log(writer.chat) if e["type"] == "user"]


def test_a_subagent_s_card_is_credited_to_its_chat_and_main_s_stays_main_s(cwd, tmp_path):
    """The shim stamps every card of the session `terminal`; the mirror, reading the orientation's transcript, credits
    the card its add_card made to the orientation's chat, so the card's foot names orient. Main's own card stays."""
    from app import notebook, tools

    transcript = tmp_path / f"{SID}.jsonl"
    transcript.write_text("")
    lv = _attach(cwd, transcript)
    ws = config.workspace_dir(CORPUS)
    final = tools.group_path(ws, "Orientation / Scratch")
    theirs = notebook.new_cell("note", "terminal", "q", final, payload={"text": "t"})
    ours = notebook.new_cell("note", "terminal", "q2", final, payload={"text": "t"})
    notebook.insert_cell(CORPUS, final, theirs)
    notebook.insert_cell(CORPUS, final, ours)
    orient = session._spawn(lv, "toolu_o", "ao1", "Orient in the corpus", "thimble:thimble-orient")
    use = {"type": "assistant", "message": {"role": "assistant", "content": [
        {"type": "tool_use", "id": "toolu_a", "name": "mcp__plugin_thimble_thimble__add_card", "input": {"kind": "note"}}]}}
    res = {"type": "user", "message": {"role": "user", "content": [
        {"type": "tool_result", "tool_use_id": "toolu_a", "content": f"$ add_card kind=\"note\"\ncard:{theirs['id']}"}]}}
    session.translate_sub(lv, orient, json.dumps(use))
    session.translate_sub(lv, orient, json.dumps(res))
    assert notebook.get_cell(CORPUS, theirs["id"])["created_by"] == f"chat:{orient.chat}"
    assert agents.read_meta(CORPUS, orient.chat)["role"] == "orient"
    session._open_turn(lv)
    session.translate(lv, json.dumps({**use, "message": {**use["message"], "content": [{**use["message"]["content"][0], "id": "toolu_m"}]}}))
    session.translate(lv, json.dumps({"type": "user", "message": {"role": "user", "content": [
        {"type": "tool_result", "tool_use_id": "toolu_m", "content": f"card:{ours['id']}"}]}}))
    assert notebook.get_cell(CORPUS, ours["id"])["created_by"] == "terminal"
