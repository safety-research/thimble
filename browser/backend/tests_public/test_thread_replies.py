"""A side thread's answer as its chat keeps it: the fork's `reply_in_thread` post, or its closing `↳` note
(session._note_reply), each stored as the same reply record, so both modes check its citations as they check any
answer's."""
from __future__ import annotations

import json
from types import SimpleNamespace

import pytest

from app import agents, cite, config, events, session, threads, tools

CORPUS = "mini"
QUESTION = "Why is Agent 3 so high?"


@pytest.fixture()
def term(workspaces_tmp, mini_dir, monkeypatch):
    """A terminal-mode workspace whose main session listens: an event goes to its queue file."""
    ws = config.workspace_dir(CORPUS)
    (ws / "trusted").mkdir(exist_ok=True)
    (ws / "trusted" / "launch.json").write_text(json.dumps({"mode": "terminal"}))
    monkeypatch.setattr(events, "reachable", lambda c: True)
    agents._busy.clear()
    yield mini_dir
    agents._busy.clear()


def _thread(question: str = QUESTION) -> str:
    tid = agents.new_thread(CORPUS, "card:abc123", "Runs per agent", "runs-per-agent")["id"]
    agents.append(agents.paths(CORPUS, tid)[1], {"type": "user", "text": question})
    return tid


def _replies(chat: str) -> list[dict]:
    return [r for r in agents.read_events(agents.paths(CORPUS, chat)[1]) if r.get("type") == "text" and r.get("reply")]


async def test_the_fallback_answer_is_the_reply_record_a_reply_in_thread_post_is(term):
    """The fork's closing `↳` note kept as the thread's answer (its clause that says what it made left out) is the record
    `reply_in_thread` writes for the same words, its citations in their chat form: both modes check one as the other."""
    noted, posted = _thread(), _thread()
    sub = SimpleNamespace(thread=True, note="added a table card. it ran [[31|card:abc123#runs/agent-3]] runs.", chat=noted)
    session._note_reply(SimpleNamespace(c=CORPUS), sub, "done")
    await threads.tool_reply_in_thread(tools.Ctx(CORPUS, tools.ANALYST), {"thread": posted,
                                                                         "text": "It ran [[31|card:abc123#runs/agent-3]] runs."})
    (a,), (b,) = _replies(noted), _replies(posted)
    assert a["delta"] == b["delta"] == cite.from_links("It ran [[31|card:abc123#runs/agent-3]] runs.")
    assert "[[31|card:abc123#runs/agent-3]]" in a["delta"]
    assert {k: v for k, v in a.items() if k != "by"} == {k: v for k, v in b.items() if k != "by"}


async def test_a_run_s_answer_is_its_texts_up_to_the_done_record_that_names_its_turn(term):
    """Each run of a thread ends with a `done` record that names its turn (threads.fork_finished), and its answer, whose
    marks are checked under that turn, is the texts after the run before it, as the page shows them as that run's rows:
    an API error's line is a row of its own, which holds no marks."""
    tid = _thread()
    log_path = agents.paths(CORPUS, tid)[1]
    agents.append(log_path, {"type": "text", "delta": "It ran [31](#) runs.", "reply": True, "by": "terminal"})
    threads.fork_finished(CORPUS, tid, "done", turn="aaaa0001")
    agents.append(log_path, {"type": "user", "text": "And Agent 4?"})
    for rec in ({"delta": "Agent 4 ran [12](#)."}, {"delta": "Overloaded", "api_error": "overloaded"},
                {"delta": "It stopped at [noon](#)."}):
        agents.append(log_path, {"type": "text", **rec, "reply": True, "by": "terminal"})
    threads.fork_finished(CORPUS, tid, "done", turn="aaaa0002")
    assert [r.get("turn") for r in agents.read_events(log_path) if r["type"] == "done"] == ["aaaa0001", "aaaa0002"]
    assert threads.answer(CORPUS, tid, "aaaa0001") == ["It ran [31](#) runs."]
    assert threads.answer(CORPUS, tid, "aaaa0002") == ["Agent 4 ran [12](#).", "It stopped at [noon](#)."]
    assert threads.answer(CORPUS, tid, "aaaa0003") == []
