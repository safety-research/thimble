"""Handing a side thread's answer back to main (threads.hand_back): an action the analyst takes, never a default. Once the
thread's run ended with an answer, `Hand back to main` (the browser's route, terminal mode's `thimble act hand-back`)
sends main the answer as the analyst's message, `From thread "<question>": <answer>`, which main's chat shows; the
answer then reads `handed` and is not offered again, while a later question's answer is. The answer is the fork's
`reply_in_thread` post, else its last text or its closing `↳` note (session._note_reply), which is stored as the same
reply record as a post, so both modes check its citations as they check any answer's."""
from __future__ import annotations

import json
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app import agents, cite, config, events, local, session, threads, tools

CORPUS = "mini"
QUESTION = "Why is Agent 3 so high?"
POST = "Agent 3 ran [[31|card:abc123#runs/agent-3]] of the [[40|card:abc123#runs/all]] runs."


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


def _log(chat: str) -> list[dict]:
    return agents.read_events(agents.paths(CORPUS, chat)[1])


def _replies(chat: str) -> list[dict]:
    return [r for r in _log(chat) if r.get("type") == "text" and r.get("reply")]


def _ended(chat: str) -> None:
    agents.append(agents.paths(CORPUS, chat)[1], {"type": "done", "result": None})


def _state(chat: str) -> str:
    return threads.hand_back_state(CORPUS, agents.read_meta(CORPUS, chat))


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
    assert {k: v for k, v in a.items() if k not in ("by", "posted")} == {k: v for k, v in b.items() if k not in ("by", "posted")}
    assert b.get("posted") is True and "posted" not in a


async def test_a_finished_answer_is_handed_back_to_main_once_as_the_analyst_s_message(term):
    tid = _thread()
    # the fork's working words, then its post: the post is the answer
    threads.reply(CORPUS, tid, "Let me look at the runs.", by="terminal")
    threads.reply(CORPUS, tid, POST, by="terminal", posted=True)
    assert _state(tid) == "", "no offer before its run ends"
    with pytest.raises(HTTPException) as no:
        threads.hand_back(CORPUS, tid)
    assert no.value.status_code == 400
    _ended(tid)
    assert _state(tid) == threads.OFFER
    # while its fork runs (a question asked again, say), nothing is offered and nothing is sent
    agents.set_running(CORPUS, tid, True)
    assert _state(tid) == ""
    with pytest.raises(HTTPException) as busy:
        threads.hand_back(CORPUS, tid)
    assert busy.value.status_code == 409
    agents.set_running(CORPUS, tid, False)

    got = await local.act(CORPUS, "hand-back", {"thread": f"thread:{tid}"})
    text = f'From thread "{QUESTION}": {cite.from_links(POST)}'
    assert got["ok"] and got["text"] == text and got["hand_back"] == threads.HANDED
    # main's chat shows it as the analyst's message, and main's watcher gets it as a `main` event
    said = [r for r in _log(agents.MAIN_ID) if r.get("type") == "user"]
    assert said[-1]["text"] == text and said[-1]["by"] == agents.BROWSER and said[-1]["event"] == got["event"]
    queue = (config.workspace_dir(CORPUS) / "events" / "queue.jsonl").read_text("utf-8")
    # main reads the citations in the form it writes them
    assert got["event"] in queue and "Agent 3 ran [[31|card:abc123#runs/agent-3]]" in queue
    # handed back: shown so in both modes' reads, and not offered again
    assert _state(tid) == threads.HANDED
    shown = await local.state(CORPUS, "thread", [tid])
    assert shown["meta"]["hand_back"] == threads.HANDED
    rows = await local.state(CORPUS, "threads")
    assert next(m for m in rows if m["id"] == tid)["hand_back"] == threads.HANDED
    with pytest.raises(local.StateError, match="already"):
        await local.act(CORPUS, "hand-back", {"thread": tid})

    # a follow-up's answer, the fork's closing note (no post), is offered again once its run ends
    log_path = agents.paths(CORPUS, tid)[1]
    agents.append(log_path, {"type": "user", "text": "And   Agent 4?"})
    assert _state(tid) == ""
    threads.reply(CORPUS, tid, "Agent 4 ran 9 of them.", by="terminal")
    _ended(tid)
    assert _state(tid) == threads.OFFER
    again = threads.hand_back(CORPUS, tid)
    assert again["text"] == 'From thread "And Agent 4?": Agent 4 ran 9 of them.'
    assert _state(tid) == threads.HANDED


async def test_the_browser_s_route_hands_back_and_the_chat_route_says_so(term):
    tid = _thread()
    threads.reply(CORPUS, tid, POST, by="terminal", posted=True)
    _ended(tid)
    meta = json.loads((await agents.get_route(CORPUS, tid)).body)["meta"]
    assert meta["hand_back"] == threads.OFFER
    got = await agents.hand_back_route(CORPUS, tid)
    assert got["text"].startswith(f'From thread "{QUESTION}": Agent 3 ran')
    assert json.loads((await agents.get_route(CORPUS, tid)).body)["meta"]["hand_back"] == threads.HANDED
    # a run that ended without a reply has nothing to hand back
    bare = _thread("Which wiki?")
    _ended(bare)
    assert json.loads((await agents.get_route(CORPUS, bare)).body)["meta"]["hand_back"] == ""
    with pytest.raises(HTTPException) as none:
        await agents.hand_back_route(CORPUS, bare)
    assert none.value.status_code == 400
    with pytest.raises(HTTPException) as main:
        threads.hand_back(CORPUS, agents.MAIN_ID)
    assert main.value.status_code == 400
