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
    assert len(rows) == 2 and rows[-1]["text"] == "Claude's safeguards switched this reply from Opus 5.5 to Opus 4.8."
    assert rows[0]["kind"] == "safeguards"
    (shown,) = _open("safeguards:main")
    assert shown["id"] == rows[-1]["id"] and shown["chat"] == agents.MAIN_ID, "one notice in the foreground"


def test_main_switched_for_the_session_says_so_and_how_to_go_back(cwd, tmp_path):
    """Bug hunt C20: Claude Code moved main to Opus 4.8 for the rest of the session (scope `session`), and the notice
    said "switched this reply". It says main stays on Opus 4.8 and gives the fix the terminal has, since the browser's
    model line cannot change main's model."""
    lv, p = _attach(cwd, tmp_path)
    _append(p, lv, [_human("Look at the logs."), FALLBACK, _assistant(_say("Here."), model="claude-opus-4-8"), _end("c1")])
    (shown,) = _open("safeguards:main")
    text = shown["text"]
    assert "this reply" not in text
    assert "switched main from Opus 5.5 to Opus 4.8 for the rest of this session" in text
    assert "In your terminal: run /model to pick Opus 5.5 again" in text


BLOCKED = {"type": "assistant", "isApiErrorMessage": True, "error": "invalid_request",
           "message": {"role": "assistant", "model": "<synthetic>", "stop_reason": "refusal",
                       "content": [_say("API Error: Claude can't help with this. Start a new session to continue.")]}}


def test_a_request_the_safeguards_blocked_marks_its_error_line(cwd, tmp_path):
    lv, p = _attach(cwd, tmp_path)
    _append(p, lv, [_human("Look at the logs."), BLOCKED, _end("c1")])
    (text,) = [r for r in _log() if r["type"] == "text"]
    assert text["refusal"] is True and text["delta"].startswith("API Error:")


def test_a_reply_of_main_s_the_safeguards_stopped_says_what_it_cost_with_its_fixes(cwd, tmp_path):
    """Bug hunt C23: Claude's safeguards stopped main's reply in the middle of add_card (stop_reason refusal on the
    model's own reply), Claude Code went on once, and thimble told only the chat's note: the card was lost, with no fix.
    A notice, in the browser and the terminal, says the card wasn't added and offers Make the card again and Ask again,
    which puts the analyst's last question back in the prompt."""
    from app import local

    lv, p = _attach(cwd, tmp_path)
    asked, question = "Which of these packages look risky?", "For each package, what starts its code?"
    card = {"type": "tool_use", "id": "toolu_c1", "name": "mcp__plugin_thimble_thimble__add_card",
            "input": {"question": question, "kind": "table", "code": "import json"}}
    interrupted = ("Interrupted: the response that made this tool call was stopped by a safety classifier while the call "
                   "was running; it may have partially or fully completed.")
    def stopped(block: dict) -> dict:  # a record of the reply the safeguards stopped
        rec = _assistant(block)
        return {**rec, "message": {**rec["message"], "stop_reason": "refusal"}}

    _append(p, lv, [
        _human(asked), stopped({"type": "thinking", "thinking": ""}), stopped(card),
        {"type": "user", "message": {"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": "toolu_c1", "is_error": True, "content": interrupted}]}},
        {"type": "system", "subtype": "informational", "level": "notice",
         "content": "Opus 5.5's safeguards stopped the response above · continuing once with that noted"},
        {"type": "user", "isMeta": True, "message": {"role": "user", "content": "Your response above was stopped."}},
        BLOCKED, _end("c1")])
    (shown,) = _open("stopped:main")
    assert shown["text"] == ("Claude's safeguards stopped main's reply partway, so the card it was making wasn't added: "
                             f"\"{question}\". Make the card again, or ask again in other words.")
    again, ask = shown["action"]
    assert again["label"] == "Make the card again" and again["do"] == "card-again" and question in again["text"]
    assert ask == {"label": "Ask again", "do": "ask-again", "text": asked}
    (row,) = [n for n in local._notices(CORPUS) if n["key"] == "stopped:main"]
    assert [(a["act"], a["text"]) for a in row["acts"]] == [("card-again", again["text"]), ("ask-again", asked)], (
        "the terminal shows it too, with the same fixes")


def _stopped_reply(block: dict, said: str) -> list[dict]:
    """main's reply the safeguards stop in the middle of the call `block`, Claude Code's line that it goes on once, and
    main's reply after it, `said`."""
    rec = _assistant(block)
    return [{**rec, "message": {**rec["message"], "stop_reason": "refusal"}},
            {"type": "user", "message": {"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": block["id"], "is_error": True, "content": "Interrupted: stopped."}]}},
            {"type": "system", "subtype": "informational", "level": "notice",
             "content": "Opus 5.5's safeguards stopped the response above · continuing once with that noted"},
            {"type": "user", "isMeta": True, "message": {"role": "user", "content": "Your response above was stopped."}},
            _assistant(_say(said), model="claude-opus-4-8")]


def test_a_stopped_reply_main_went_on_from_offers_no_ask_again(cwd, tmp_path):
    """Bug hunt D11: the safeguards stopped main's reply in the middle of a label call, and main went on, started the
    label over every message and answered. The stopped-reply notice stayed up with Ask again, which would send the
    request, and its label run, a second time. A turn main went on in has no Ask again, and a notice only for a card
    the stop cost."""
    lv, p = _attach(cwd, tmp_path)
    label = {"type": "tool_use", "id": "toolu_l1", "name": "mcp__plugin_thimble_thimble__apply_label",
             "input": {"name": "rival talk", "scope": "files", "paths": ["notes/*.json#/messages"]}}
    _append(p, lv, [_human("Label the rival talk in every message."), *_stopped_reply(label, "Labeling every message now.")])
    assert not _open("stopped:main"), "no notice while main goes on"
    _append(p, lv, [_end("c1")])
    assert not _open("stopped:main"), "the request ran to its end"

    question = "How many messages talk of a rival?"
    card = {"type": "tool_use", "id": "toolu_c2", "name": "mcp__plugin_thimble_thimble__add_card",
            "input": {"question": question, "kind": "table", "code": "import json"}}
    _append(p, lv, [_human("Count them."), *_stopped_reply(card, "Here is the count."), _end("c2")])
    (shown,) = _open("stopped:main")
    assert "Main went on" in shown["text"] and question in shown["text"]
    assert shown["action"]["do"] == "card-again", "Make the card again alone, no Ask again"
