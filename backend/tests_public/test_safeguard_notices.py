"""session.py and Claude's safeguards: a reply Claude Code switched to another model after the requested one refused
leaves a notice in its chat (main's, or an agent's), and a request the safeguards blocked marks its error line, which
the chat shows as its API error card. Transcripts are written in the record shapes of Claude Code 2.1.295-2.1.300 (the
view builder experiment's runs: main's model_refusal_fallback record, a workflow agent's refusal and replies on Opus
4.8)."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from app import agents, config, notices, session

CORPUS = "mini"
SID = "a0b0c0d0-0000-4000-8000-0000000000b2"
END = {"type": "system", "subtype": "turn_duration"}


@pytest.fixture(autouse=True)
def _fresh(workspaces_tmp, tmp_path, monkeypatch):
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "claude-config"))
    session._live.clear()
    yield
    session._live.clear()


@pytest.fixture()
def cwd() -> str:
    return str(config.corpus_dir(CORPUS))


def _log(chat: str = agents.MAIN_ID) -> list[dict]:
    return agents.read_events(agents.paths(CORPUS, chat)[1])


def _notices(chat: str = agents.MAIN_ID) -> list[dict]:
    return [r for r in _log(chat) if r["type"] == notices.TYPE]


def _human(text: str) -> dict:
    return {"type": "user", "origin": {"kind": "human"}, "message": {"content": text}}


def _assistant(*blocks: dict, model: str = "claude-opus-5-5", **extra: Any) -> dict:
    return {"type": "assistant", "message": {"role": "assistant", "model": model, "content": list(blocks)}, **extra}


def _say(text: str) -> dict:
    return {"type": "text", "text": text}


def _end(uuid: str) -> dict:
    return {**END, "uuid": uuid}


def _attach(cwd: str, tmp_path: Path) -> tuple[session.Live, Path]:
    p = tmp_path / f"{SID}.jsonl"
    p.write_text("")
    lv = session.attach(CORPUS, SID, cwd, str(p))
    assert lv is not None
    session.tail_once(lv)
    return lv, p


def _append(p: Path, lv: session.Live, recs: list[dict]) -> None:
    with p.open("a") as f:
        f.write("".join(json.dumps(r) + "\n" for r in recs))
    session.tail_once(lv)


FALLBACK = {"type": "system", "subtype": "model_refusal_fallback", "level": "warning", "trigger": "refusal",
            "direction": "retry", "scope": "session", "originalModel": "claude-opus-5-5",
            "fallbackModel": "claude-opus-4-8", "content": "Opus 5.5's safeguards flagged this session."}


def test_a_reply_main_s_safeguards_switched_leaves_one_notice_row(cwd, tmp_path):
    lv, p = _attach(cwd, tmp_path)
    _append(p, lv, [_human("Look at the logs."), FALLBACK, _assistant(_say("Here."), model="claude-opus-4-8"),
                    _end("c1"), _human("Again."), {**FALLBACK, "scope": "local"},
                    _assistant(_say("Here."), model="claude-opus-4-8"), _end("c2")])
    rows = [r for r in _notices() if r.get("key") == session.FALLBACK_KEY]
    assert [r["text"] for r in rows] == ["Claude's safeguards switched this reply from Opus 5.5 to Opus 4.8."] * 2
    assert rows[0]["kind"] == "safeguards"


def test_a_request_the_safeguards_blocked_marks_its_error_line(cwd, tmp_path):
    lv, p = _attach(cwd, tmp_path)
    block = {"type": "assistant", "isApiErrorMessage": True, "error": "invalid_request",
             "message": {"role": "assistant", "model": "<synthetic>", "stop_reason": "refusal",
                         "content": [_say("API Error: Claude can't help with this. Start a new session to continue.")]}}
    _append(p, lv, [_human("Look at the logs."), block, _end("c1")])
    (text,) = [r for r in _log() if r["type"] == "text"]
    assert text["refusal"] is True and text["delta"].startswith("API Error:")


def _agent(project: Path, lv: session.Live, p: Path, agent: str = "a1b2c3d4") -> tuple[Path, str]:
    """A background subagent of main's, its transcript file and its chat."""
    d = project / SID / "subagents"
    d.mkdir(parents=True, exist_ok=True)
    path = d / f"agent-{agent}.jsonl"
    path.with_name(f"agent-{agent}.meta.json").write_text(json.dumps(
        {"agentType": "general-purpose", "description": "posts", "toolUseId": "toolu_ag"}))
    path.write_text("")
    _append(p, lv, [_human("Count the posts in the background"),
                    _assistant({"type": "tool_use", "id": "toolu_ag", "name": "Agent",
                                "input": {"description": "posts", "prompt": "Count.", "run_in_background": True}}),
                    {"type": "user", "message": {"role": "user", "content": [
                        {"type": "tool_result", "tool_use_id": "toolu_ag",
                         "content": f"Async agent launched successfully.\nagentId: {agent}"}]}}, _end("c0")])
    session._scan_subs(lv)
    chat = next(m["id"] for m in agents.list_chats(CORPUS) if m.get("role") == session.SUBAGENT_ROLE)
    return path, chat


def _side(rec: dict, agent: str = "a1b2c3d4") -> dict:
    return {**rec, "isSidechain": True, "agentId": agent}


def test_an_agent_s_reply_on_another_model_after_a_refusal_leaves_a_notice_in_its_chat(cwd, tmp_path):
    project = tmp_path / "claude-config" / "projects" / "-corpus"
    project.mkdir(parents=True)
    p = project / f"{SID}.jsonl"
    p.write_text("")
    lv = session.attach(CORPUS, SID, cwd, str(p))
    session.tail_once(lv)
    path, chat = _agent(project, lv, p)
    refused = _side(_assistant({"type": "thinking", "thinking": ""}, stop_reason=None))
    refused["message"]["stop_reason"] = "refusal"
    went_on = _side(_assistant(_say("I stop here."), model="claude-opus-5-5"))
    with path.open("a") as f:
        for r in (refused, went_on, refused, _side(_assistant(_say("Counted 8."), model="claude-opus-4-8"))):
            f.write(json.dumps(r) + "\n")
    session.tail_once(lv)
    for sub in lv.subs:
        session._tail_sub(lv, sub)
    rows = _notices(chat)
    assert [r["text"] for r in rows] == ["Claude's safeguards switched this reply from Opus 5.5 to Opus 4.8."]
    assert _notices() == [], "the agent's chat, not main's"
    with path.open("a") as f:
        f.write(json.dumps(_side({**FALLBACK, "scope": "local"})) + "\n")
    for sub in lv.subs:
        session._tail_sub(lv, sub)
    assert len(_notices(chat)) == 2 and _notices(chat)[-1]["key"] == session.FALLBACK_KEY
