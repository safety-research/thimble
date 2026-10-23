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


def _api_error(text: str) -> dict:
    return {"type": "assistant", "isApiErrorMessage": True, "error": "invalid_request",
            "message": {"role": "assistant", "model": "<synthetic>", "stop_reason": "refusal",
                        "content": [_say(text)]}}


BLOCK = "API Error: Opus 5.5's safeguards flagged this message (https://www.anthropic.com/legal/aup)."


def test_an_api_error_that_stops_a_side_thread_is_told_in_the_foreground_until_it_answers(cwd, tmp_path):
    lv, _ = _attach(cwd, tmp_path)
    tid = agents.new_thread(CORPUS, None, None, "Who replies most?")["id"]
    sub = session.Sub(CORPUS, tid, "toolu_fork", "a7", thread=True)
    session.translate_sub(lv, sub, json.dumps(_api_error(BLOCK)))
    (n,) = _open(f"thread:{tid}")
    assert n["text"] == ('The side thread "Who replies most?" stopped with an error: Claude\'s safeguards stopped its '
                         "request; rephrase or narrow the request and try again.")
    assert n["chat"] == tid and n["agent"] == "Side thread: Who replies most?"
    session._finish_sub(lv, sub, "completed", None)
    assert _open(f"thread:{tid}"), "a fork that ended on its error answered nothing"
    again = session.Sub(CORPUS, tid, "toolu_fork2", "a8", thread=True)
    session.translate_sub(lv, again, json.dumps(_assistant(_say("Agent B replies most."))))
    session._finish_sub(lv, again, "completed", None)
    assert _open(f"thread:{tid}") == []


# --------------------------------------------------------------------------- main's own requests

# Claude Code 2.1.300's records of a request Anthropic's API failed (isApiErrorMessage with apiErrorStatus and error;
# the API error screenshots' probes, 10-14), whose words name neither the failure nor its fix the same way twice
LOGIN = {"type": "assistant", "isApiErrorMessage": True, "error": "authentication_failed", "apiErrorStatus": 401,
         "message": {"role": "assistant", "model": "<synthetic>", "stop_reason": "stop_sequence",
                     "content": [_say("Please run /login · API Error: 401 Invalid bearer token")]}}
NO_MODEL = {"type": "assistant", "isApiErrorMessage": True, "error": "model_not_found", "apiErrorStatus": 404,
            "message": {"role": "assistant", "model": "<synthetic>", "stop_reason": "stop_sequence",
                        "content": [_say("There's an issue with the selected model (claude-opus-9-9). It may not "
                                         "exist or you may not have access to it. Run /model to pick a different "
                                         "model.")]}}
THIMBLE = {"type": "user", "origin": {"kind": "human"},
           "message": {"content": "<command-name>/thimble</command-name>\n<command-args></command-args>"}}


def test_main_s_api_error_is_its_card_with_its_class_and_a_notice_for_the_other_chats(cwd, tmp_path, monkeypatch):
    from app import proposer

    turns: list[dict] = []
    monkeypatch.setattr(proposer, "turn_ended", lambda c, **kw: turns.append(kw))
    lv, p = _attach(cwd, tmp_path)
    _append(p, lv, [_human("Who replies most?"), LOGIN, _end("c1")])
    (text,) = [r for r in _log() if r["type"] == "text"]
    assert text["api_error"] == "auth", "the class from the record's fields, for the browser's card"
    (n,) = _open(session.MAIN_API_KEY)
    assert n["text"] == ("Claude's reply in main failed: Claude Code isn't signed in. In your terminal: run /login "
                         "(or `claude auth login` in a shell).")
    assert n["chat"] == agents.MAIN_ID and n["kind"] == notices.API and n["action"] is None
    assert _notices() == [], "main's chat shows its API error card, not a notice row as well"
    assert turns[-1]["analyst"] is False, "a turn that failed answered nothing, so no view proposal is looked for"
    _append(p, lv, [_human("Again."), NO_MODEL, _end("c2")])
    (n,) = _open(session.MAIN_API_KEY)
    assert n["text"] == ("Claude's reply in main failed: its model isn't available to your account. In your terminal: "
                         "run /model to pick another model."), "main's model changes only in the terminal"
    _append(p, lv, [_human("Again."), _assistant(_say("Agent B.")), _end("c3")])
    assert _open(session.MAIN_API_KEY) == [], "a turn that answered clears it"
    assert turns[-1]["analyst"] is True


def test_a_first_turn_that_failed_shows_in_main(cwd, tmp_path):
    """/thimble's own turn is not mirrored, but its failure is: the browser would show nothing of it else."""
    lv, p = _attach(cwd, tmp_path)
    _append(p, lv, [THIMBLE, LOGIN, _end("c1")])
    (text,) = [r for r in _log() if r["type"] == "text"]
    assert text["api_error"] == "auth" and text["delta"].startswith("Please run /login")
    assert _open(session.MAIN_API_KEY), "and in the foreground"


def test_a_blocked_request_of_main_is_refused_whatever_its_words(cwd, tmp_path):
    lv, p = _attach(cwd, tmp_path)
    block = {**LOGIN, "error": "invalid_request", "apiErrorStatus": None,
             "message": {**LOGIN["message"], "stop_reason": "refusal", "content": [_say("API Error: the request was "
                                                                                       "declined.")]}}
    _append(p, lv, [_human("Look at the logs."), block, _end("c1")])
    (text,) = [r for r in _log() if r["type"] == "text"]
    assert text["api_error"] == "refused" and text["refusal"] is True
