"""events.py: the one event path from the browser to the analyst's Claude Code session. `main` logs the analyst's line
when it posts and queues the event for the session's watcher, and the shim's subscription waits for the workspace,
attaches the session that is main, and carries no events. The watcher's side is test_delivery.py, the shim's
test_shim.py."""
from __future__ import annotations

import re

import pytest
from conftest import Listener
from fastapi.testclient import TestClient

from app import agents, events, session

CORPUS = "mini"


@pytest.fixture(autouse=True)
def _fresh(workspaces_tmp):
    events._subs.clear()
    events._pending.clear()
    session._live.clear()
    session._expected.clear()
    agents._busy.clear()
    yield
    events._subs.clear()
    events._pending.clear()
    session._live.clear()


@pytest.fixture()
def client(workspaces_tmp):
    from app.main import app

    with TestClient(app, base_url="http://127.0.0.1") as c:
        yield c


def _log(chat: str) -> list[dict]:
    _, log_path = agents.paths(CORPUS, chat)
    return agents.read_events(log_path)


# ----------------------------------------------------------------------------- posting


def test_a_browser_message_is_logged_on_main_and_queued_for_the_session(client):
    q = Listener(CORPUS)
    r = client.post(f"/api/ws/{CORPUS}/events", json={"kind": "main", "payload": {"text": "which agent stalled?"}})
    assert r.status_code == 200
    out = r.json()
    assert out["kind"] == "main" and out["delivered"] == 1
    note = q.get_nowait()
    assert (note["content"], note["meta"]) == ("which agent stalled?", {"kind": "main", "event": out["id"]})
    rec = _log(agents.MAIN_ID)[-1]
    assert rec == {**rec, "type": "user", "by": "browser", "text": "which agent stalled?", "event": out["id"]}
    assert out["id"] in session._expected and agents._running(CORPUS, agents.MAIN_ID)


def test_an_event_reaches_only_the_session_that_is_main(client):
    """Another `claude` in the folder subscribes too, and gets none of main's events; with no main, a post is refused."""
    other = events.Sub("0ther000-0000-4000-8000-000000000001")
    events._subs.setdefault(CORPUS, set()).add(other)
    r = client.post(f"/api/ws/{CORPUS}/events", json={"kind": "main", "payload": {"text": "anyone?"}})
    assert r.status_code == 409
    q = Listener(CORPUS)
    assert client.post(f"/api/ws/{CORPUS}/events", json={"kind": "main", "payload": {"text": "hi"}}).status_code == 200
    assert q.get_nowait()["content"] == "hi" and not events._pending.get((CORPUS, other.session))


def test_a_thread_named_in_any_script_asks_main_to_fork_under_a_name_claude_code_accepts(client):
    """Claude Code's Agent refuses a `name` other than ASCII letters, digits, '_' and '-', and then no fork starts."""
    q = Listener(CORPUS)
    r = client.post(f"/api/ws/{CORPUS}/chats", json={"title": "Café マージ担当", "text": "which did agent-04 merge?"})
    assert r.status_code == 201
    assert re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}", q.get_nowait()["meta"]["name"])


def test_a_side_thread_is_named_by_its_question_and_one_named_by_its_answer_s_first_words_takes_its_question(client):
    """Bug hunt D7: a thread asked about an answer was named by the answer's first words (`the-chart-is-on`) in the
    thread list, its chip and its canvas group. It is named by its question, cut at a word; an older thread takes its
    question when the chats are read, its group follows, and its old name still finds it."""
    from app import notebook, threads

    Listener(CORPUS)
    answer = "The chart is on the card. It covers only the merge requests the bots opened during a sweep."
    question = "did any reviewer bot approve a merge request sooner than its test suite could finish running?"
    r = client.post(f"/api/ws/{CORPUS}/chats", json={"anchor_text": answer, "surface": "terminal", "element": "answer",
                                                     "text": question})
    assert r.status_code == 201
    title = r.json()["title"]
    assert title == "did any reviewer bot approve a merge request sooner than…"
    assert len(title) <= agents.QUESTION_TITLE_CHARS
    group = agents.group_for(CORPUS, agents.read_meta(CORPUS, r.json()["id"]))
    assert notebook.read_notebook(agents._ws(CORPUS), group)["title"] == f"main/{title}"
    # a thread named by the first words of its answer before, with its cards' group
    old = agents.new_thread(CORPUS, None, "I ran the sweep check over every page.")
    assert old["title"] == "i-ran-the-sweep"
    asked = "what did bot-07 write on the [[welcome page|pages.jsonl#L3]]?"
    agents.append(agents.paths(CORPUS, old["id"])[1], {"type": "user", "text": asked})
    old_group = agents.group_for(CORPUS, agents.read_meta(CORPUS, old["id"]))
    agents._retitled.clear()
    listed = {m["id"]: m for m in client.get(f"/api/ws/{CORPUS}/chats").json()}
    assert listed[old["id"]]["title"] == "what did bot-07 write on the welcome page?"
    assert listed[r.json()["id"]]["title"] == title
    renamed = "main/what did bot-07 write on the welcome page?"
    assert notebook.read_notebook(agents._ws(CORPUS), old_group)["title"] == renamed
    assert [m["id"] for m in threads.find_threads(CORPUS, "main/i-ran-the-sweep")] == [old["id"]]


def test_an_agent_s_thread_is_found_by_the_name_the_browser_gives_it_and_by_its_old_slug(client):
    """Bug hunt G11: the browser's thread tree names a view build by the view's name and a writer by its document's
    name, so /thimble:ask takes those names, as it still takes the slugs the tree gave before."""
    from app import threads

    build = agents.new_agent(CORPUS, "dev", "view: Tea Board", view="tea-board", announce=False)
    review = agents.new_agent(CORPUS, "dev", "review: Tea Board", view="tea-board", review=True, announce=False)
    writer = agents.new_agent(CORPUS, "writer", "Write report", doc="report", announce=False)
    found = lambda name: [m["id"] for m in threads.find_threads(CORPUS, name)]  # noqa: E731
    assert found("dev/Tea Board") == found("dev/tea-board") == [build["id"]]
    assert found("dev/Tea Board review") == found("dev/tea-board-review") == [review["id"]]
    assert found("Report") == [writer["id"]]
