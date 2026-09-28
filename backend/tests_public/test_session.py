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


def _thread(tid: str, anchor: str = "card:ab12cd34") -> dict:
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
        _result("toolu_ac", '$ add_card kind="code" question="How many posts?" code="print(8)"\ncard:cd34ef56\nL1|8'),
        {"type": "user", "isMeta": True, "message": {"content": [{"type": "text", "text": "Base directory"}]}},
        _assistant(_say("card:cd34ef56")),
        END,
    ])
    recs = _mirror()
    assert [r["type"] for r in recs] == ["user", "tool_use", "tool_result", "text", "done"], recs
    user, use, made, text, _ = recs
    assert user["text"] == "Add a card that counts the board's posts." and user["by"] == "terminal"
    assert use["name"] == ADD_CARD and made["cell_id"] == "cd34ef56" and text["delta"] == "card:cd34ef56"
    assert not lv.degraded and lv.offset == p.stat().st_size and lv.buf == b""
    n = len(_log(agents.MAIN_ID))
    session.tail_once(lv)
    assert len(_log(agents.MAIN_ID)) == n  # nothing new


# ----------------------------------------------------------------------------- subagents and threads' forks


def _agent_chats() -> list[dict]:
    return [m for m in agents.list_chats(CORPUS) if m.get("kind") == "agent"]


def _channel_event(kind: str, event: str, body: str = "", **attrs: str) -> dict:
    extra = "".join(f' {k}="{v}"' for k, v in attrs.items())
    return {"type": "user", "isMeta": True, "origin": {"kind": "channel", "server": "plugin:thimble:thimble"},
            "message": {"content": f'<channel source="plugin:thimble:thimble" kind="{kind}" event="{event}"{extra}>\n{body}\n</channel>'}}


def _append(p: Path, lv: session.Live, recs: list[dict]) -> None:
    with p.open("a") as f:
        f.write("".join(json.dumps(r) + "\n" for r in recs))
    session.tail_once(lv)


def _note(agent: str, use: str) -> dict:
    """The task notification Claude Code writes in main when a background agent stops."""
    return {"type": "user", "origin": {"kind": "task-notification"}, "message": {"content": (
        f"<task-notification>\n<task-id>{agent}</task-id>\n<tool-use-id>{use}</tool-use-id>\n<status>completed</status>\n"
        "</task-notification>")}}


def _launched(agent: str) -> str:
    return f"Async agent launched successfully.\nagentId: {agent} (internal ID)"
