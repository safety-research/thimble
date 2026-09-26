"""The terminal's commands for what only the chat bar did: /thimble:ask sends a message to a thread as its composer
would (message_thread): a side thread's follow-up with its anchor, Ask again with no message, a follow-up for the
orientation, a change to a view for its build thread, and main's own for any other chat; /thimble:orient passes Start's
switches, the critique and the permission mode among them, to start_orientation. The skills run no shell command, since
Claude Code puts typed arguments into one unescaped."""
from __future__ import annotations

import asyncio
from pathlib import Path

import pytest
import yaml

from app import agents, channel, config, ledger, orient_session, orientation, session, threads, tools, views

CORPUS = "mini"
SKILLS = config.REPO_ROOT / "plugin" / "skills"


@pytest.fixture(autouse=True)
def _fresh(workspaces_tmp):
    channel._subs.clear()
    session._live.clear()
    agents._busy.clear()
    yield
    channel._subs.clear()


def _listen() -> asyncio.Queue:
    q: asyncio.Queue = asyncio.Queue()
    channel._subs.setdefault(CORPUS, set()).add(q)
    return q


def _thread(tid: str, name: str) -> dict:
    meta = agents._defaults({"id": tid, "kind": agents.KIND_THREAD, "role": "thread", "title": name, "created_at": "t",
                             "parent": agents.MAIN_ID, "anchor": "card:68e99674", "anchor_text": "pages per wiki"})
    agents.write_meta(CORPUS, meta)
    agents.paths(CORPUS, tid)[1].touch()
    return meta


def _log(chat: str) -> list[dict]:
    return agents.read_events(agents.paths(CORPUS, chat)[1])


def _split(path: Path) -> tuple[dict, str]:
    text = path.read_text("utf-8")
    head, _, body = text[4:].partition("\n---\n")
    return yaml.safe_load(head), body


async def test_ask_follows_up_a_side_thread_with_its_anchor_as_the_analyst_s_own_message():
    q = _listen()
    _thread("5a5a0001", "pages-per-wiki")
    res = await tools.call(CORPUS, "message_thread", {"thread": "pages-per-wiki", "message": "Why is dse so big?"})
    assert not res.is_error and tools.hint("message_thread-sent", thread="pages-per-wiki") in res.text
    note = q.get_nowait()
    assert note["meta"]["kind"] == "thread" and note["meta"]["thread"] == "5a5a0001"
    assert "question: Why is dse so big?" in note["content"] and "ref: card:68e99674" in note["content"], "the anchor rides along"
    [user] = [e for e in _log("5a5a0001") if e["type"] == "user"]
    assert (user["text"], user["by"]) == ("Why is dse so big?", agents.TERMINAL)


async def test_ask_with_no_message_asks_the_unanswered_question_again():
    q = _listen()
    _thread("5a5a0002", "edits-per-day")
    path = agents.paths(CORPUS, "5a5a0002")[1]
    agents.append(path, {"type": "user", "ts": "t", "text": "Which day peaked?", "by": agents.BROWSER})
    agents.append(path, {"type": "error", "ts": "t", "message": threads.STOP_TEXT[threads.UNANSWERED], "kind": threads.UNANSWERED})
    res = await tools.call(CORPUS, "message_thread", {"thread": "5a5a0002"})
    assert not res.is_error and tools.hint("message_thread-again", thread="edits-per-day") in res.text
    assert "question: Which day peaked?" in q.get_nowait()["content"]
    assert [e["type"] for e in _log("5a5a0002")][-1] == "again"


async def test_ask_reaches_the_orientation_a_view_s_build_and_else_main(monkeypatch):
    res = await tools.call(CORPUS, "message_thread", {"thread": "nothing-like-this", "message": "hi"})
    assert res.is_error and "no thread" in res.text
    # the orientation: its follow-up, or in terminal-first mode main's SendMessage to its subagent
    ledger.put_settings(CORPUS, {orientation.TERMINAL_FIRST_KEY: True})
    orientation.request(CORPUS, "", ["final"], route=orientation.SUBAGENT_ROUTE)
    orient = agents.new_agent(CORPUS, orientation.ROLE, orientation.TITLE, session="s1", agent_id="a9", tool_use_id="t9")
    orientation.started(CORPUS, orient["id"], agent_id="a9")
    res = await tools.call(CORPUS, "message_thread", {"thread": "orientation", "message": "Check April too."})
    assert not res.is_error and tools.hint("message_orientation-subagent", agent_id="a9") in res.text
    # a view's build thread: the message is a change to the view
    changes: list = []
    monkeypatch.setattr(views, "message", lambda c, slug, text: changes.append((slug, text)) or {})
    agents.new_agent(CORPUS, "dev", "Wiki board", view="board", announce=False)
    res = await tools.call(CORPUS, "message_thread", {"thread": "Wiki board", "message": "Show the dates."})
    assert not res.is_error and changes == [("board", "Show the dates.")]
    # a writer's chat takes no messages of its own: main does what it asks
    agents.new_agent(CORPUS, "writer", "Write report", announce=False)
    res = await tools.call(CORPUS, "message_thread", {"thread": "Write report", "message": "Shorter."})
    assert res.is_error and tools.hint("message_thread-main", thread="Write report") in res.text


async def test_orient_passes_the_critique_and_the_permission_mode_to_the_session(monkeypatch):
    seen: dict = {}

    async def fake_start(c, brief, passes, call=None, chosen=None):
        seen.update(brief=brief, passes=passes, chosen=chosen)

    monkeypatch.setattr(orient_session, "start", fake_start)
    res = await tools.call(CORPUS, "start_orientation", {"brief": "the edits", "generate_report": True, "critique": False,
                                                         "permissions": "auto"})
    assert not res.is_error
    assert seen == {"brief": "the edits", "passes": ["final", "views", "report"], "chosen": {"critique": False, "permissions": "auto"}}
    await tools.call(CORPUS, "start_orientation", {"brief": ""})
    assert seen["chosen"] == {}, "a switch the call leaves out keeps Start's or the default"


def test_the_skills_name_their_tool_and_run_no_shell_command():
    for name, tool in (("ask", "message_thread"), ("orient", "start_orientation")):
        front, body = _split(SKILLS / name / "SKILL.md")
        assert front["name"] == name and front["disable-model-invocation"] is True
        assert f"`{tool}`" in body and "$ARGUMENTS" in body
        assert not [ln for ln in body.splitlines() if ln.lstrip().startswith("!`")], "typed arguments reach no shell"
    _, body = _split(SKILLS / "orient" / "SKILL.md")
    for flag, arg in (("--no-deck", "final_notebook"), ("--no-views", "propose_views"), ("--report", "generate_report"),
                      ("--no-critique", "critique"), ("--auto", "permissions")):
        assert f"`{flag}`" in body and f"`{arg}`" in body, flag
    section = tools.tool_sections(["start_orientation"])["start_orientation"][1]
    assert section["properties"]["permissions"]["enum"] == list(orientation.PERMISSIONS)
