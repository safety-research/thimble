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


# ----------------------------------------------------------------------------- a picture in a terminal ask

# a PNG of one pixel
PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="


async def test_i5_a_picture_pasted_into_a_terminal_ask_is_kept_shown_in_its_thread_and_passed_to_the_fork(client, tmp_path):
    """Bug hunt I5: `/thimble:ask <thread> [Image #1] …` reached the thread as the text alone, so the thread showed a
    dead placeholder and the fork saw the picture only when main thought to name its path. message_thread takes the
    pictures' paths, keeps a copy in the workspace, names it on the thread's record and gives its ref to the fork as a
    `picture` line, which `screenshot` shows; a message that names a picture without them is refused with the hint
    that asks for them, and a file that is no picture is refused."""
    import base64

    from app import threads, tools

    Listener(CORPUS)
    tid = agents.new_thread(CORPUS, None, "why does ep09 have so many dots")["id"]
    ctx = tools.Ctx(CORPUS, tools.ANALYST)
    shot = tmp_path / "view-ep09.png"
    shot.write_bytes(base64.b64decode(PNG))
    message = "[Image #1] What do the red X marks mean?"
    said = lambda res: res.content[0]["text"]  # noqa: E731

    asked = await threads.tool_message_thread(ctx, {"thread": tid, "message": message})
    assert asked.is_error and "names [Image #1], but no picture came with it" in said(asked)
    notes = tmp_path / "notes.txt"
    notes.write_text("not a picture")
    refused = await threads.tool_message_thread(ctx, {"thread": tid, "message": message, "pictures": [str(notes)]})
    assert refused.is_error and f"{notes} is not a picture that thimble can keep" in said(refused)
    assert not [r for r in _log(tid) if r.get("type") == "user"]

    sent = await threads.tool_message_thread(ctx, {"thread": tid, "message": message, "pictures": [str(shot)]})
    assert not sent.is_error, said(sent)
    rec = [r for r in _log(tid) if r.get("type") == "user"][-1]
    assert rec["text"] == message and len(rec["images"]) == 1
    kept = threads.picture_path(CORPUS, rec["images"][0])
    assert kept is not None and kept.read_bytes() == shot.read_bytes()
    assert str(kept).startswith(str(agents._ws(CORPUS)))
    assert f"picture: picture:{rec['images'][0]}" in said(sent)
    # the fork looks at it with thimble's own screenshot tool, which asks for no permission to read a file
    shown = await tools.call(CORPUS, "screenshot", {"ref": f"picture:{rec['images'][0]}"})
    assert not shown.is_error and shown.content[1] == {"type": "image", "data": PNG, "mimeType": "image/png"}
    # the browser reads it from the workspace
    got = client.get(f"/api/ws/{CORPUS}/pictures/{rec['images'][0]}")
    assert got.status_code == 200 and got.headers["content-type"] == "image/png" and got.content == shot.read_bytes()
    assert client.get(f"/api/ws/{CORPUS}/pictures/..%2Fconfig.json").status_code == 404


async def test_main_s_terminal_prints_the_analyst_s_words_from_the_browser_and_no_line_of_thimble_s_own_events(client):
    """Bug hunt 9, friction 5: after a press (the server's transport) the held hook printed `› new thread: …`, `The
    orientation has finished: 3 labels, 8 cards.` and a coverage line no one asked for, which main's reply and the
    chat's rows say. It prints the analyst's own words alone."""
    q = Listener(CORPUS)
    events.post(CORPUS, "orient", {"text": "The orientation has finished: 3 labels, 8 cards.\nCoverage: read 0.1%"},
                check_kind=False)
    out = client.post(f"/api/ws/{CORPUS}/events", json={"kind": "main", "payload": {"text": "which pages were deleted?"}}).json()
    note = q.get_nowait()
    assert "The orientation has finished" in note["content"], "main still reads the orientation's end"
    assert note["said"] == "› which pages were deleted?"
    # the watcher took it and wrote it out: the held hook prints that line alone
    events._taken[out["id"]] = (CORPUS, q.sid, note, 0.0)
    await events.ack_route(events.AckBody(cwd="", session=q.sid, id=out["id"], terminal=True))
    assert events._lines.pop((CORPUS, q.sid)) == [(out["id"], "› which pages were deleted?")]
    q.close()
