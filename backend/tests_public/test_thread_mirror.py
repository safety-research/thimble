"""The thread mirror: the browser's thread holds the same conversation as the terminal's agent view. A fork's own text is
its reply there, without the line to main that only the terminal shows; a message the analyst typed to a running fork
or subagent in the agent view shows as theirs, once, in either of the shapes Claude Code writes it; and a message main
sends a fork for a question typed in the terminal, or sends a subagent, shows as from main, while main's relay of a
question the browser already logged adds nothing. The transcripts are written in Claude Code's record shapes."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from app import agents, channel, config, session, threads

CORPUS = "mini"
SID = "e7b0a1f2-0000-4000-8000-0000000071ed"
REPLY = "mcp__plugin_thimble_thimble__reply_in_thread"
END = {"type": "system", "subtype": "turn_duration"}


@pytest.fixture(autouse=True)
def _fresh(workspaces_tmp, tmp_path, monkeypatch):
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "claude-config"))
    session._live.clear()
    session._expected.clear()
    session._event_threads.clear()
    channel._subs.clear()
    agents._busy.clear()
    yield
    session._live.clear()
    channel._subs.clear()


def _thread(tid: str) -> None:
    meta = agents._defaults({"id": tid, "kind": agents.KIND_THREAD, "role": "thread", "title": tid, "created_at": "t",
                             "parent": agents.MAIN_ID, "anchor": "card:0a1b2c3d"})
    agents.write_meta(CORPUS, meta)
    agents.paths(CORPUS, tid)[1].touch()


def _log(chat: str) -> list[dict]:
    return agents.read_events(agents.paths(CORPUS, chat)[1])


def _assistant(*blocks: dict) -> dict:
    return {"type": "assistant", "message": {"role": "assistant", "content": list(blocks)}}


def _say(text: str) -> dict:
    return {"type": "text", "text": text}


def _use(tool_use_id: str, name: str, tool_input: dict) -> dict:
    return {"type": "tool_use", "id": tool_use_id, "name": name, "input": tool_input}


def _result(tool_use_id: str, content) -> dict:
    return {"type": "user", "message": {"role": "user", "content": [
        {"type": "tool_result", "tool_use_id": tool_use_id, "content": content}]}}


def _typed_queued(text: str) -> dict:
    """A message typed to a working subagent in the agent view, as the queued command Claude Code 2.1.283 writes."""
    return {"type": "attachment", "attachment": {"type": "queued_command", "prompt": text, "source_uuid": "u1",
                                                  "origin": {"kind": "human"}, "isMeta": True}}


def _typed_meta(text: str) -> dict:
    """The same kind of message as the meta prompt Claude Code writes when it reaches the subagent between turns."""
    wrapped = (f"The user sent a new message while you were working:\n{text}\n\nThis is how Claude Code surfaces messages "
               "the user sends mid-turn — within the running turn. Address the message above as you continue this turn.")
    return {"type": "user", "isMeta": True, "origin": {"kind": "human"}, "message": {"content": wrapped}}


def _coordinator(text: str) -> dict:
    return {"type": "user", "isMeta": True, "origin": {"kind": "coordinator"}, "message": {
        "content": f"The coordinator sent a message while you were working:\n{text}\n\nAddress this before completing your current task."}}


def _agent_file(tmp_path: Path, agent: str, meta: dict, records: list[dict]) -> Path:
    path = tmp_path / SID / "subagents" / f"agent-{agent}.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.with_name(f"agent-{agent}.meta.json").write_text(json.dumps(meta))
    _add(path, records)
    return path


def _add(path: Path, records: list[dict]) -> None:
    with path.open("a") as f:
        f.write("".join(json.dumps({**r, "isSidechain": True}) + "\n" for r in records))


def _main(tmp_path: Path) -> tuple[Path, session.Live]:
    p = tmp_path / f"{SID}.jsonl"
    p.write_text("")
    lv = session.attach(CORPUS, SID, str(config.corpus_dir(CORPUS)), str(p))
    assert lv is not None
    session.tail_once(lv)
    return p, lv


def _append(p: Path, lv: session.Live, recs: list[dict]) -> None:
    with p.open("a") as f:
        f.write("".join(json.dumps(r) + "\n" for r in recs))
    session.tail_once(lv)


def _fork(p: Path, lv: session.Live, tmp_path: Path, tid: str, agent: str, records: list[dict]) -> Path:
    """Main forks for the thread from a terminal turn; the fork's transcript holds `records` after its prompt."""
    use = f"toolu_{agent}"
    path = _agent_file(tmp_path, agent, {"agentType": "fork", "isFork": True, "description": f"thread:{tid}", "toolUseId": use},
                       [{"type": "user", "message": {"role": "user", "content": f"<fork-boilerplate>…</fork-boilerplate>\n\nthread:{tid}"}},
                        *records])
    _append(p, lv, [{"type": "user", "origin": {"kind": "human"}, "message": {"content": "Look into the card."}},
                    _assistant(_use(use, "Agent", {"subagent_type": "fork", "description": f"thread:{tid}", "prompt": f"thread:{tid}"})),
                    _result(use, [{"type": "text", "text": f"Async agent launched successfully.\nagentId: {agent} (internal ID)"}]),
                    END])
    return path


def test_a_fork_s_text_is_its_reply_in_the_thread_without_the_line_to_main(tmp_path):
    tid, agent = "5c0de001", "a0000000000000001"
    _thread(tid)
    p, lv = _main(tmp_path)
    _fork(p, lv, tmp_path, tid, agent, [
        _assistant(_use("k1", REPLY, {"thread": tid, "text": "Each record is one tree."})),
        _result("k1", "replied"),
        _assistant(_say("The hill orchard has the most trees.\n↳ thread 5c0de001: said what a record is")),
        _assistant(_say("↳ thread 5c0de001: answered")),
    ])
    session.tail_once(lv)
    texts = [(e["delta"], e.get("reply")) for e in _log(tid) if e["type"] == "text"]
    assert texts == [("The hill orchard has the most trees.", True)], "reply_in_thread writes its own text; the ↳ lines stay in the terminal"
    assert threads.replied_since_question(CORPUS, tid), "the fork's text counts as the thread's reply"


def test_a_message_typed_to_a_running_fork_in_the_agent_view_shows_in_its_thread_once(tmp_path):
    tid, agent = "5c0de002", "a0000000000000002"
    _thread(tid)
    p, lv = _main(tmp_path)
    path = _fork(p, lv, tmp_path, tid, agent, [_assistant(_use("k1", "Bash", {"command": "wc -l trees.jsonl"}))])
    session.tail_once(lv)
    _add(path, [_typed_queued("Which orchard has the highest median?"),
                _typed_meta("Which orchard has the highest median?"),
                _result("k1", "812 trees.jsonl"),
                _assistant(_say("The river orchard, with 3 picks per tree."))])
    session.tail_once(lv)
    rows = [(e["type"], e.get("text") or e.get("delta"), e.get("by")) for e in _log(tid) if e["type"] in ("user", "text")]
    assert rows == [("user", "Which orchard has the highest median?", "terminal"),
                    ("text", "The river orchard, with 3 picks per tree.", "terminal")]
    _add(path, [_typed_meta("And the lowest?")])
    session.tail_once(lv)
    assert [e["text"] for e in _log(tid) if e["type"] == "user"][-1] == "And the lowest?", "the wrapper is taken off"


def test_main_s_message_to_a_fork_shows_in_the_thread_unless_it_relays_the_browser_s_question(tmp_path):
    tid, agent = "5c0de003", "a0000000000000003"
    _thread(tid)
    p, lv = _main(tmp_path)
    path = _fork(p, lv, tmp_path, tid, agent, [_assistant(_say("Done."))])
    session.tail_once(lv)
    # the analyst asks in the terminal, and main sends the fork the question
    _append(p, lv, [{"type": "user", "origin": {"kind": "human"}, "message": {"content": "Ask that thread which day peaked."}},
                    _assistant(_use("s1", "SendMessage", {"to": agent, "summary": "peak day", "message": "Which single day peaked?"})),
                    _result("s1", "sent"), END])
    _add(path, [_coordinator("Which single day peaked?"), _assistant(_say("June 23."))])
    session.tail_once(lv)
    users = [(e["text"], e["by"]) for e in _log(tid) if e["type"] == "user"]
    assert users == [("Which single day peaked?", "main")], "shown once, from main, and the fork's copy adds nothing"
    # a question typed in the browser's thread is logged there by the channel, so main's relay of it adds nothing
    session.expect(CORPUS, "e9", thread=tid)
    threads_log = agents.paths(CORPUS, tid)[1]
    agents.append(threads_log, {"type": "user", "text": "And the second?", "by": "browser", "event": "e9"})
    body = f'<channel source="plugin:thimble:thimble" kind="thread" event="e9" thread="{tid}" agent="{agent}">\nquestion: And the second?\n</channel>'
    _append(p, lv, [{"type": "user", "isMeta": True, "origin": {"kind": "channel"}, "message": {"content": body}},
                    _assistant(_use("s2", "SendMessage", {"to": agent, "message": "Follow-up from the analyst: And the second?"})),
                    _result("s2", "sent"), END])
    assert [e["by"] for e in _log(tid) if e["type"] == "user"] == ["main", "browser"]


def test_main_s_message_and_a_typed_one_reach_a_subagent_s_chat(tmp_path):
    agent, use = "a0000000000000004", "toolu_sub4"
    p, lv = _main(tmp_path)
    path = _agent_file(tmp_path, agent, {"agentType": "general-purpose", "description": "count trees", "toolUseId": use},
                       [{"type": "user", "message": {"role": "user", "content": "Count the trees."}}])
    _append(p, lv, [{"type": "user", "origin": {"kind": "human"}, "message": {"content": "Count the trees in the background."}},
                    _assistant(_use(use, "Agent", {"subagent_type": "general-purpose", "description": "count trees", "prompt": "Count the trees.", "run_in_background": True})),
                    _result(use, [{"type": "text", "text": f"Async agent launched successfully.\nagentId: {agent} (internal ID)"}]),
                    END])
    _append(p, lv, [{"type": "user", "origin": {"kind": "human"}, "message": {"content": "Tell it the hill orchard only."}},
                    _assistant(_use("s1", "SendMessage", {"to": agent, "message": "Count only the hill orchard's."})),
                    _result("s1", "sent"), END])
    _add(path, [_typed_queued("Also say how many are empty.")])
    session.tail_once(lv)
    [chat] = [m["id"] for m in agents.list_chats(CORPUS) if m.get("agent_id") == agent]
    users = [(e["text"], e["by"]) for e in _log(chat) if e["type"] == "user"]
    assert users == [("Count the trees.", "terminal"), ("Count only the hill orchard's.", "main"), ("Also say how many are empty.", "terminal")]
