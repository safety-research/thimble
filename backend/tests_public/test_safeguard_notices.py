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

from app import agents, config, notices, session, subagents

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
    assert [r["text"] for r in rows] == [
        'Claude\'s safeguards switched a reply of the agent "posts" from Opus 5.5 to Opus 4.8.']
    assert _notices() == [], "the agent's chat, not main's"
    assert _open(f"safeguards:{chat}")[0]["chat"] == chat, "shown in the foreground, with Open on the agent's chat"
    with path.open("a") as f:
        f.write(json.dumps(_side({**FALLBACK, "scope": "local"})) + "\n")
    for sub in lv.subs:
        session._tail_sub(lv, sub)
    assert len(_notices(chat)) == 2 and len(_open(f"safeguards:{chat}")) == 1


def _sub_project(cwd: str, tmp_path: Path) -> tuple[session.Live, Path, str]:
    project = tmp_path / "claude-config" / "projects" / "-corpus"
    project.mkdir(parents=True)
    p = project / f"{SID}.jsonl"
    p.write_text("")
    lv = session.attach(CORPUS, SID, cwd, str(p))
    session.tail_once(lv)
    path, chat = _agent(project, lv, p)
    return lv, path, chat


def _feed(lv: session.Live, path: Path, recs: list[dict]) -> None:
    with path.open("a") as f:
        f.write("".join(json.dumps(_side(r)) + "\n" for r in recs))
    session.tail_once(lv)
    for sub in lv.subs:
        session._tail_sub(lv, sub)


def _refusal() -> dict:
    rec = _assistant({"type": "thinking", "thinking": ""})
    rec["message"]["stop_reason"] = "refusal"
    return rec


# Claude Code's meta line after a reply a safety classifier stopped (2.1.295), which comes with or without a record of
# the refused reply
CLASSIFIER = {"type": "user", "isMeta": True, "turnCompanion": True, "refusedMessageId": "msg_01",
              "message": {"role": "user", "content": "Your response above was stopped by a safety classifier — this is "
                                                     "not a tool or API error. The rest of it was withheld."}}
SWITCHED = 'Claude\'s safeguards switched a reply of the agent "posts" from Opus 5.5 to Opus 4.8.'


def test_a_switch_that_comes_replies_after_the_refusal_is_told(cwd, tmp_path):
    """A refusal, then the run goes on on its own model for a reply, then answers on another one (a real transcript's
    order): the switch is told when it comes, once."""
    lv, path, chat = _sub_project(cwd, tmp_path)
    _feed(lv, path, [_assistant(_say("Counting.")), _refusal(), _assistant(_say("Going on.")),
                     _assistant(_say("Counted 8."), model="claude-opus-4-8"),
                     _assistant(_say("And 9."), model="claude-opus-4-8")])
    assert [r["text"] for r in _notices(chat)] == [SWITCHED]


def test_a_switch_with_no_refusal_record_is_told(cwd, tmp_path):
    """Only the classifier's meta line comes before the replies on another model."""
    lv, path, chat = _sub_project(cwd, tmp_path)
    _feed(lv, path, [_assistant(_say("Counting.")), CLASSIFIER, _assistant(_say("Counted 8."), model="claude-opus-4-8")])
    assert [r["text"] for r in _notices(chat)] == [SWITCHED]
    assert not [r for r in _log(chat) if r["type"] == "user" and "classifier" in str(r.get("text"))], \
        "Claude Code's meta line is no message in the chat"


def test_a_workflow_agent_s_fallback_block_is_told(cwd, tmp_path):
    lv, path, chat = _sub_project(cwd, tmp_path)
    _feed(lv, path, [_assistant(_say("Counting."), model="claude-fable-5"),
                     _assistant({"type": "fallback"}, model="claude-opus-4-8"),
                     _assistant(_say("Counted 8."), model="claude-opus-4-8")])
    assert [r["text"] for r in _notices(chat)] == [
        'Claude\'s safeguards switched a reply of the agent "posts" from Fable 5 to Opus 4.8.']


def test_a_reply_back_on_the_run_s_model_ends_the_switch_and_a_new_switch_updates_the_notice(cwd, tmp_path):
    lv, path, chat = _sub_project(cwd, tmp_path)
    _feed(lv, path, [_assistant(_say("Counting.")), _assistant(_say("a"), model="claude-opus-4-8"),
                     _assistant(_say("b")), _assistant(_say("c"), model="claude-opus-4-8[1m]")])
    assert [r["text"] for r in _notices(chat)] == [SWITCHED, SWITCHED], "a model's [1m] tag is the same model"
    assert len(_open(f"safeguards:{chat}")) == 1, "one notice in the foreground"


def test_a_new_run_on_another_model_is_no_switch(cwd, tmp_path):
    lv, path, chat = _sub_project(cwd, tmp_path)
    follow_up = {"type": "user", "message": {"role": "user", "content": "Now count the replies."}}
    _feed(lv, path, [_assistant(_say("Counted 8.")), follow_up,
                     _assistant(_say("Counted 3."), model="claude-sonnet-5-5")])
    assert _notices(chat) == []


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


def test_an_api_error_of_the_orientation_s_helper_is_told_and_one_of_main_s_own_subagent_is_not(cwd, tmp_path,
                                                                                               monkeypatch):
    lv, _ = _attach(cwd, tmp_path)
    orient = agents.new_agent(CORPUS, "orient", "Orientation")["id"]
    step = agents.new_agent(CORPUS, agents.STEP_ROLE, "count posts", parent=orient)["id"]
    monkeypatch.setattr(subagents, "agent", lambda c, a: {"role": "orientation", "chat": orient} if a == "o1" else None)
    helper = session.Sub(CORPUS, step, "toolu_h", "h1", role=agents.STEP_ROLE)
    helper.root = "o1"
    overloaded = _api_error("API Error: Repeated 529 Overloaded errors")  # Claude Code 2.1.300's record of a 529
    overloaded.update(error="server_error", apiErrorStatus=529)
    overloaded["message"]["stop_reason"] = "stop_sequence"
    session.translate_sub(lv, helper, json.dumps(overloaded))
    (n,) = _open("helper:o1")
    assert n["text"] == ("A helper of the orientation stopped with an error: Anthropic's API is overloaded; try again "
                         "in a few minutes.") and n["chat"] == step
    own = session.Sub(CORPUS, step, "toolu_m", "m1")
    session.translate_sub(lv, own, json.dumps(_api_error(BLOCK)))
    assert [n["key"] for n in notices.open_notices(CORPUS)] == ["helper:o1"], "main hears its own subagent's error"


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


def test_main_s_request_that_reached_no_api_says_the_connection_failed(cwd, tmp_path):
    """Claude Code 2.1.300 records a refused connection (a proxy or firewall) with `error` server_error and no
    apiErrorStatus, as live check 11's transcript has it; the card and the notice say the connection failed, not that
    the API had a server error, and a turn that answers clears the notice."""
    refused = {"type": "assistant", "isApiErrorMessage": True, "error": "server_error",
               "message": {"role": "assistant", "model": "<synthetic>", "stop_reason": "stop_sequence",
                           "content": [_say("API Error: Connection refused — a firewall or proxy may be blocking "
                                            "it (ECONNREFUSED)")]}}
    lv, p = _attach(cwd, tmp_path)
    _append(p, lv, [_human("Who replies most?"), refused, _end("c1")])
    (text,) = [r for r in _log() if r["type"] == "text"]
    assert text["api_error"] == "connection"
    (n,) = _open(session.MAIN_API_KEY)
    assert n["text"] == ("Claude's reply in main failed: the connection to Anthropic's API failed; check the network "
                         "and try again.")
    _append(p, lv, [_human("Again."), _assistant(_say("Agent B.")), _end("c2")])
    assert _open(session.MAIN_API_KEY) == []


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
