"""session.py and failures the analyst should see wherever they look: a reply Claude Code switched to another model
after the requested one refused leaves a notice (shown in the foreground, a row in its chat, main's or an agent's), a
request the safeguards blocked marks its error line, which the chat shows as its API error card, and an API error that
stops a side thread's fork or a helper of the orientation leaves a notice with its fix. Transcripts are written in the
record shapes of Claude Code 2.1.295-2.1.300 (the view builder experiment's runs: main's model_refusal_fallback
record, a workflow agent's refusal and replies on Opus 4.8)."""
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
    """The notice rows of a chat (its history)."""
    return [r for r in _log(chat) if r["type"] == notices.TYPE]


def _open(key: str) -> list[dict]:
    """The open notices under `key`, as the foreground shows them."""
    return [n for n in notices.open_notices(CORPUS) if n.get("key") == key]


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
    rows = _notices()
    assert [r["text"] for r in rows] == ["Claude's safeguards switched this reply from Opus 5.5 to Opus 4.8."] * 2
    assert rows[0]["kind"] == "safeguards"
    (shown,) = _open("safeguards:main")
    assert shown["id"] == rows[-1]["id"] and shown["chat"] == agents.MAIN_ID, "one notice in the foreground"


def test_a_request_the_safeguards_blocked_marks_its_error_line(cwd, tmp_path):
    lv, p = _attach(cwd, tmp_path)
    block = {"type": "assistant", "isApiErrorMessage": True, "error": "invalid_request",
             "message": {"role": "assistant", "model": "<synthetic>", "stop_reason": "refusal",
                         "content": [_say("API Error: Claude can't help with this. Start a new session to continue.")]}}
    _append(p, lv, [_human("Look at the logs."), block, _end("c1")])
    (text,) = [r for r in _log() if r["type"] == "text"]
    assert text["refusal"] is True and text["delta"].startswith("API Error:")
