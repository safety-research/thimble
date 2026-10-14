"""notices.py: a failure of one of thimble's agents told in the foreground with its fix. An open notice is one per key,
kept in the workspace's notices file (GET /notices) and written as a row in its agent's chat; clear (a later success)
and dismiss (the analyst's x) take it away, each with its `notice` event."""
from __future__ import annotations

import asyncio

import pytest
from fastapi.testclient import TestClient

from app import agents, main, notices

CORPUS = "mini"


@pytest.fixture(autouse=True)
def _fresh(workspaces_tmp):
    yield


@pytest.fixture()
def sent(monkeypatch) -> list[dict]:
    """The `notice` events, as the workspace stream would get them."""
    got: list[dict] = []
    monkeypatch.setattr(notices.investigation, "emit", lambda c, inv, ev: got.append(ev))
    return got


def _rows(chat: str) -> list[dict]:
    return [r for r in agents.read_events(agents.paths(CORPUS, chat)[1]) if r["type"] == notices.TYPE]


async def test_a_notice_with_a_key_is_one_open_notice_that_clear_takes_away(sent):
    retry = {"label": "Try again", "do": "proposals-retry"}
    a = notices.post(CORPUS, kind="proposals", text="First  try.", agent="View proposals", key="k", action=retry)
    b = notices.post(CORPUS, kind="proposals", text="Second try.", agent="View proposals", key="k")
    assert a["text"] == "First try." and a["action"] == retry and a["chat"] is None
    assert sent[0] == {"type": "notice", "id": a["id"], "key": "k", "kind": "proposals", "text": "First try.",
                       "agent": "View proposals", "chat": None, "action": retry, "foreground": True}
    assert [n["id"] for n in notices.open_notices(CORPUS)] == [b["id"]], "the later one replaced it in place"
    assert notices.clear(CORPUS, "k") and notices.open_notices(CORPUS) == []
    assert sent[-1] == {"type": "notice", "id": b["id"], "key": "k", "cleared": True}
    assert not notices.clear(CORPUS, "k")


async def test_an_agent_s_notice_is_also_a_row_in_its_chat_and_dismiss_leaves_the_row(sent):
    chat = agents.new_agent(CORPUS, "dev", "view: Board")["id"]
    n = notices.post(CORPUS, kind="view", text="The view Board failed to build: no reader.", agent="View build: Board",
                     chat=chat, action={"label": "Retry", "do": "view-retry", "slug": "board"}, key="agent:view:board")
    (row,) = _rows(chat)
    assert row["id"] == n["id"] and row["text"] == n["text"] and row["action"]["slug"] == "board"
    assert row["agent"] == "View build: Board" and _rows(agents.MAIN_ID) == []
    assert notices.dismiss(CORPUS, n["id"]) and not notices.dismiss(CORPUS, n["id"])
    assert notices.open_notices(CORPUS) == [] and len(_rows(chat)) == 1, "the row is the thread's history"
    assert sent[-1] == {"type": "notice", "id": n["id"], "key": "agent:view:board", "cleared": True}


def test_a_notice_for_a_chat_that_is_gone_is_still_open():
    n = notices.post(CORPUS, chat="nochat", kind="safeguards", text="Gone.")
    assert n is not None and [x["id"] for x in notices.open_notices(CORPUS)] == [n["id"]]


def test_a_bad_action_is_refused_and_old_notices_go_first(monkeypatch):
    with pytest.raises(ValueError):
        notices.post(CORPUS, kind="x", text="y", action={"label": "Go", "do": "rm -rf"})
    monkeypatch.setattr(notices, "OPEN_MAX", 3)
    ids = [notices.post(CORPUS, kind="agent", text=f"Failure {i}.", key=f"k{i}")["id"] for i in range(5)]
    assert [n["id"] for n in notices.open_notices(CORPUS)] == ids[2:]


def test_get_notices_gives_the_open_ones_and_the_x_dismisses():
    client = TestClient(main.create_app())
    assert client.get(f"/api/ws/{CORPUS}/notices").json() == []
    n = notices.post(CORPUS, kind="agent", text="The orientation failed: it broke.", agent="Orientation",
                     key="agent:orientation")
    got = client.get(f"/api/ws/{CORPUS}/notices").json()
    assert [(x["id"], x["text"], x["agent"]) for x in got] == [(n["id"], n["text"], "Orientation")]
    assert client.post(f"/api/ws/{CORPUS}/notices/{n['id']}/dismiss").json() == {"dismissed": True}
    assert client.get(f"/api/ws/{CORPUS}/notices").json() == []


async def test_a_notice_from_a_worker_thread_reaches_the_stream_on_the_loop(monkeypatch):
    got: list[dict] = []
    monkeypatch.setattr(notices.investigation, "emit", lambda c, inv, ev: got.append(ev))
    monkeypatch.setattr(notices, "_loop", asyncio.get_running_loop())
    await asyncio.to_thread(notices.post, CORPUS, kind="card-check", text="The card check failed.", key="card-check")
    await asyncio.sleep(0)
    assert [e["text"] for e in got] == ["The card check failed."]


@pytest.mark.parametrize("line,words,fix", [
    ("API Error: Opus 5.5's safeguards flagged this message (https://www.anthropic.com/legal/aup).",
     "Claude's safeguards stopped its request; rephrase or narrow the request and try again", None),
    ("API Error: Claude can't help with this. Start a new session to continue.",
     "Claude's safeguards stopped its request; rephrase or narrow the request and try again", None),
    ("Not logged in · Please run /login", "Claude Code isn't signed in; run /login", None),
    ("API Error: 403 {\"type\":\"error\",\"error\":{\"type\":\"permission_error\"}}",
     "your account may not make this request (403); check your sign-in and your organization's settings, or pick "
     "another model in Settings", notices.SETTINGS),
    ("API Error: 404 model: claude-x not found", "its model isn't available to your account; pick another model in "
     "Settings", notices.SETTINGS),
    ("API Error: Repeated 529 Overloaded errors", "Anthropic's API is overloaded; try again in a few minutes", None),
    ("API Error: Connection error.", "the connection to Anthropic's API failed; check the network and try again", None),
    ("Problem: the page threw.", "Problem: the page threw", None),
])
def test_a_failure_s_words_name_the_fix(line, words, fix):
    assert notices.reason(line) == (words, fix)


def test_a_long_reason_keeps_its_first_sentence_and_its_fix():
    plan = ("Your Claude Code session is in plan mode, where thimble's agents would have to ask you before every card "
            "and every edit, so none of them starts or takes a message there. They wait. Nothing else happens there "
            "while it lasts, and that is how it is meant to be. Switch out of plan mode first (shift+tab in your "
            "terminal).")
    words, _ = notices.reason(plan)
    assert words.startswith("Your Claude Code session is in plan mode") and " … " in words
    assert words.endswith("Switch out of plan mode first (shift+tab in your terminal)")
    assert notices.reason("Not logged in", server=True)[0].endswith("run `thimble server restart`")


def test_an_agent_is_named_by_its_role_and_its_run_s_title():
    assert notices.who("orientation", "Orientation") == ("Orientation", "The orientation")
    assert notices.who("view-builder", "view: Agent Network") == ("View build: Agent Network",
                                                                  "The build of the view Agent Network")
    assert notices.who("writer", "Write report") == ("Writer: report", "The writer of report")
    assert notices.who("thread", "Who replies?") == ("Side thread: Who replies?", 'The side thread "Who replies?"')
    assert notices.who("", "") == ("Agent", "The agent")
