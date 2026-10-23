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
