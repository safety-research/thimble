"""threads.py: a thread's anchor picture, the reply_in_thread tool, the screenshot of the element a thread was opened on,
and the end of a fork's run: a `done`, and a chip in main pointing at the anchor when the run posted no reply (an act
that needs no words shows as a chip), and the thread's canvas group, made with its first card. How the fork is found
and its rows mirrored is test_session.py's; how the thread's event is built is test_channel.py's."""
from __future__ import annotations

import base64

import pytest

from app import agents, config, threads, tools

CORPUS = "mini"
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 16


@pytest.fixture(autouse=True)
def _fresh(workspaces_tmp):
    agents._busy.clear()
    yield


def _log(chat: str) -> list[dict]:
    _, log_path = agents.paths(CORPUS, chat)
    return agents.read_events(log_path)


def _thread(**kw) -> dict:
    return agents.new_thread(CORPUS, kw.pop("anchor", "card:abc,card:def"), "the card", **kw)


def test_the_picture_is_saved_only_when_it_is_a_png():
    url = "data:image/png;base64," + base64.b64encode(PNG).decode()
    path = threads.save_image(CORPUS, "t1", url)
    assert path == str(config.workspace_dir(CORPUS) / "anchors" / "t1.png") and open(path, "rb").read() == PNG
    for bad in (None, "", "data:image/jpeg;base64,AAAA", "data:image/png;base64," + base64.b64encode(b"GIF89a").decode()):
        assert threads.save_image(CORPUS, "t2", bad) is None


def test_the_fork_description_names_the_thread():
    assert threads.thread_of("thread:3fa9c1d2") == "3fa9c1d2" and threads.thread_of(" thread:ab ") == "ab"
    assert threads.thread_of("Count the files") is None and threads.thread_of(None) is None


async def test_reply_in_thread_writes_the_reply_the_analyst_reads():
    t = _thread()
    r = await tools.call(CORPUS, "reply_in_thread", {"thread": t["id"], "text": "Two of the forty runs."}, actor="analyst")
    assert not r.is_error and r.text.endswith(f"replied in thread {t['id']}")
    rec = _log(t["id"])[-1]
    assert rec == {**rec, "type": "text", "delta": "Two of the forty runs.", "reply": True, "by": "terminal"}
    assert threads.replied_since_question(CORPUS, t["id"])
    r = await tools.call(CORPUS, "reply_in_thread", {"thread": "nope", "text": "x"}, actor="analyst")
    assert r.is_error and t["id"] in r.text
    r = await tools.call(CORPUS, "reply_in_thread", {"thread": t["id"], "text": " "}, actor="analyst")
    assert r.is_error
    r = await tools.call(CORPUS, "reply_in_thread", {"thread": f"thread:{t['id']}", "text": "ok"}, actor="analyst")
    assert not r.is_error, "the thread:<id> spelling reads as the id"


async def test_main_renames_and_deletes_a_thread_by_its_id_or_the_name_the_list_shows():
    """rename_thread and delete_thread take a thread's id or its name as the thread list shows it; a thread's rename is
    its title, another chat's its `name`; deleting a session takes its steps with it and stops a task that runs."""
    t = _thread(title="why-the-spike")
    r = await tools.call(CORPUS, "rename_thread", {"thread": "main/why-the-spike", "name": "  spike  cause "}, actor="analyst")
    assert not r.is_error and agents.read_meta(CORPUS, t["id"])["title"] == "spike cause"
    dev = agents.new_agent(CORPUS, "dev", "Ticket #2: Group the board by round")
    r = await tools.call(CORPUS, "rename_thread", {"thread": "dev/group-the-board-by", "name": "board"}, actor="analyst")
    assert not r.is_error and agents.read_meta(CORPUS, dev["id"])["name"] == "board"
    assert agents.read_meta(CORPUS, dev["id"])["title"] == "Ticket #2: Group the board by round"
    r = await tools.call(CORPUS, "rename_thread", {"thread": "nope", "name": "x"}, actor="analyst")
    assert r.is_error and t["id"] in r.text and dev["id"] in r.text, "a name that matches none lists the threads"
    r = await tools.call(CORPUS, "rename_thread", {"thread": "main", "name": "x"}, actor="analyst")
    assert r.is_error, "main is no thread of the list"
    orient = agents.new_agent(CORPUS, "orient", "Orientation")
    step = agents.new_agent(CORPUS, "step", "Read: read:run-logs", parent=orient["id"], announce=False)
    r = await tools.call(CORPUS, "delete_thread", {"thread": orient["id"]}, actor="analyst")
    assert not r.is_error and "1 steps" in r.text
    assert agents.meta_or_none(CORPUS, orient["id"]) is None and agents.meta_or_none(CORPUS, step["id"]) is None
    r = await tools.call(CORPUS, "delete_thread", {"thread": "board"}, actor="analyst")
    assert not r.is_error and agents.meta_or_none(CORPUS, dev["id"]) is None
    assert [m["id"] for m in agents.list_chats(CORPUS)] == ["main", t["id"]]
    trash = config.workspace_dir(CORPUS) / "chats" / "trash"
    assert (trash / f"{orient['id']}.meta.json").is_file(), "a deleted chat goes to the trash the export reads"


async def test_screenshot_of_a_thread_returns_the_picture_taken_at_the_click():
    t = _thread(image="data:image/png;base64," + base64.b64encode(PNG).decode())
    r = await tools.call(CORPUS, "screenshot", {"ref": f"thread:{t['id']}"}, actor="analyst")
    assert not r.is_error and r.content[-1] == {"type": "image", "data": base64.b64encode(PNG).decode(), "mimeType": "image/png"}
    r = await tools.call(CORPUS, "screenshot", {"ref": "card:abc,card:def"}, actor="analyst")
    assert r.is_error, "a card is shot by the card module, not from a thread's picture"
    r = await tools.call(CORPUS, "screenshot", {"ref": "ui:composer"}, actor="analyst")
    assert r.is_error and "thread:<id>" in r.text


def test_a_run_with_no_reply_leaves_a_chip_in_main_and_one_with_a_reply_does_not():
    t = _thread()
    agents.set_running(CORPUS, t["id"], True)
    agents.append(agents.paths(CORPUS, t["id"])[1], {"type": "user", "ts": "t", "text": "Sort it from most to least", "by": "browser"})
    threads.fork_finished(CORPUS, t["id"], "done")
    chips = [r for r in _log(agents.MAIN_ID) if r["type"] == "chip"]
    assert [(c["kind"], c["text"], c["ref"], c["chat"]) for c in chips] == [("thread", "Sort it from most to least", "card:abc", t["id"])]
    assert _log(t["id"])[-1]["type"] == "done" and not agents._running(CORPUS, t["id"])
    # the next question, answered: no chip
    agents.append(agents.paths(CORPUS, t["id"])[1], {"type": "user", "ts": "t", "text": "Why is agent-3 high?", "by": "browser"})
    threads.reply(CORPUS, t["id"], "It posted the nightly report.", by="terminal")
    threads.fork_finished(CORPUS, t["id"], "done")
    assert len([r for r in _log(agents.MAIN_ID) if r["type"] == "chip"]) == 1
    # a failed run says so in the thread, and no chip
    threads.fork_finished(CORPUS, t["id"], "failed")
    assert _log(t["id"])[-1] == {**_log(t["id"])[-1], "type": "error", "message": "failed"}
    assert len([r for r in _log(agents.MAIN_ID) if r["type"] == "chip"]) == 1


def test_fork_started_keeps_the_agent_id_and_forgets_a_fork_of_another_session():
    t = _thread()
    threads.fork_started(CORPUS, t["id"], tool_use_id="toolu_1", session="s1")
    threads.fork_started(CORPUS, t["id"], agent_id="a1", session="s1")
    assert agents.read_meta(CORPUS, t["id"])["fork"] == {"tool_use_id": "toolu_1", "agent_id": "a1", "session": "s1"}
    threads.fork_started(CORPUS, t["id"], agent_id="a2", tool_use_id="toolu_2", session="s2")
    assert agents.read_meta(CORPUS, t["id"])["fork"] == {"agent_id": "a2", "tool_use_id": "toolu_2", "session": "s2"}


async def test_a_thread_s_group_is_made_with_its_first_card_so_a_thread_with_none_leaves_no_group():
    """A thread's event names the thread as its cards' group, `thread:<id>`. Asking builds no group; the first card the
    fork adds there makes it (titled after the thread, beside the anchor's card, credited to the thread's chat), the next
    card lands in the same group, and list_cards reads the thread's group by the same name."""
    from app import notebook

    ws = config.workspace_dir(CORPUS)
    groups = lambda: [g["id"] for g in notebook.list_notebooks(ws)]  # noqa: E731
    deck = tools.group_path(ws, "Orientation")
    card = notebook.insert_cell(CORPUS, deck, notebook.new_cell("note", "terminal", "Reviews per agent", deck, payload={"text": "t"}))
    t = agents.new_thread(CORPUS, f"card:{card['id']}", "Reviews per agent")
    before = groups()
    try:
        _, fields, _ = threads.build(CORPUS, t["id"], ["Why is agent-3 high?"])
        assert fields["group"] == f"thread:{t['id']}"
        assert groups() == before and agents.read_meta(CORPUS, t["id"])["group"] is None
        r = await tools.call(CORPUS, "list_cards", {"group": fields["group"]}, actor="analyst")
        assert not r.is_error and "no cards yet" in r.text and groups() == before
        add = {"kind": "note", "question": "Agent-3's posts", "text": "t", "group": fields["group"]}
        r = await tools.call(CORPUS, "add_card", add, actor="analyst")
        assert not r.is_error, r.text
        made = [g for g in notebook.list_notebooks(ws) if g["id"] not in before]
        assert len(made) == 1
        group = notebook.read_notebook(ws, made[0]["id"])
        assert group["title"] == f"main/{t['title']}" and group["parent"] == deck and group["chat"] == t["id"]
        assert agents.read_meta(CORPUS, t["id"])["group"] == group["id"]
        r = await tools.call(CORPUS, "add_card", {**add, "question": "Agent-3's replies"}, actor="analyst")
        assert not r.is_error and len(notebook.read_notebook(ws, group["id"])["cells"]) == 2
        assert len(groups()) == len(before) + 1
        r = await tools.call(CORPUS, "list_cards", {"group": fields["group"]}, actor="analyst")
        assert "Agent-3's posts" in r.text and "Agent-3's replies" in r.text
    finally:
        await notebook.shutdown_all()
