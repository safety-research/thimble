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
                             "parent": agents.MAIN_ID, "anchor": "card:0a1b2c3d", "anchor_text": "trees per orchard"})
    agents.write_meta(CORPUS, meta)
    agents.paths(CORPUS, tid)[1].touch()
    return meta


def _log(chat: str) -> list[dict]:
    return agents.read_events(agents.paths(CORPUS, chat)[1])


def _split(path: Path) -> tuple[dict, str]:
    text = path.read_text("utf-8")
    head, _, body = text[4:].partition("\n---\n")
    return yaml.safe_load(head), body


async def test_ask_hands_main_a_side_thread_s_event_with_its_anchor_in_the_result_and_logs_the_analyst_s_message():
    q = _listen()
    _thread("5a5a0001", "trees-per-orchard")
    res = await tools.call(CORPUS, "message_thread", {"thread": "trees-per-orchard", "message": "Why is the hill orchard so big?"})
    assert not res.is_error and "Handle the thread's event now" in res.text
    assert '<channel source="plugin:thimble:thimble" kind="thread"' in res.text and 'thread="5a5a0001"' in res.text
    assert "question: Why is the hill orchard so big?" in res.text and "ref: card:0a1b2c3d" in res.text, "the anchor rides along"
    assert q.empty(), "main answers in the same turn: no event wakes it again"
    [user] = [e for e in _log("5a5a0001") if e["type"] == "user"]
    assert (user["text"], user["by"]) == ("Why is the hill orchard so big?", agents.TERMINAL)
    assert agents.running(CORPUS, "5a5a0001")


async def test_ask_with_no_message_hands_main_the_unanswered_question_again():
    q = _listen()
    _thread("5a5a0002", "picks-per-day")
    path = agents.paths(CORPUS, "5a5a0002")[1]
    agents.append(path, {"type": "user", "ts": "t", "text": "Which day peaked?", "by": agents.BROWSER})
    agents.append(path, {"type": "error", "ts": "t", "message": threads.STOP_TEXT[threads.UNANSWERED], "kind": threads.UNANSWERED})
    res = await tools.call(CORPUS, "message_thread", {"thread": "5a5a0002"})
    assert not res.is_error and "question: Which day peaked?" in res.text and 'kind="thread"' in res.text
    assert "asks the thread picks-per-day its questions again" in res.text
    assert q.empty()
    assert [e["type"] for e in _log("5a5a0002")][-1] == "again"


async def test_a_handed_event_counts_as_the_turn_s_so_main_s_send_is_not_logged_again(tmp_path):
    _listen()
    _thread("5a5a0003", "rows-per-tree")
    p = tmp_path / "s1.jsonl"
    p.write_text("")
    lv = session.attach(CORPUS, "s1", str(config.corpus_dir(CORPUS)), str(p))
    fork = session.Sub(CORPUS, "5a5a0003", "t_fork", "a_fork", thread=True)
    lv.subs.append(fork)
    res = await tools.call(CORPUS, "message_thread", {"thread": "rows-per-tree", "message": "And per row?"})
    assert not res.is_error and "rows-per-tree" in res.text
    assert "5a5a0003" in lv.turn_threads and lv.handed == ["5a5a0003"]
    session._open_turn(lv)  # the tail reads the command's line after the call ran
    assert lv.turn_threads == ["5a5a0003"]
    session._tool_use(lv, "t_send", session.SEND_TOOL, {"to": "a_fork", "message": "And per row?"})
    assert [(e["text"], e["by"]) for e in _log("5a5a0003") if e["type"] == "user"] == [("And per row?", agents.TERMINAL)]
    session._release_threads(lv)
    assert lv.handed == [] and lv.turn_threads == []


async def test_ask_reaches_the_orientation_a_view_s_build_and_else_main(monkeypatch):
    res = await tools.call(CORPUS, "message_thread", {"thread": "nothing-like-this", "message": "hi"})
    assert res.is_error and "no thread" in res.text
    # the orientation, by the tree's name for it: in terminal-first mode main's SendMessage to its subagent, and the
    # chat shows the message as the analyst's
    ledger.put_settings(CORPUS, {orientation.TERMINAL_FIRST_KEY: True})
    orientation.request(CORPUS, "", ["final"], route=orientation.SUBAGENT_ROUTE)
    orient = agents.new_agent(CORPUS, orientation.ROLE, orientation.TITLE, session="s1", agent_id="a9", tool_use_id="t9")
    orientation.started(CORPUS, orient["id"], agent_id="a9")
    for name in ("orient", "orientation"):
        res = await tools.call(CORPUS, "message_thread", {"thread": name, "message": "Check April too."})
        assert not res.is_error and tools.hint("message_orientation-subagent", agent_id="a9") in res.text
    # a view's build threads: the view's name reaches its latest build, as a change to the view
    changes: list = []
    monkeypatch.setattr(views, "message", lambda c, slug, text: changes.append((slug, text)) or {})
    agents.new_agent(CORPUS, "dev", "view: Orchard board", view="orchard-board", announce=False)
    agents.new_agent(CORPUS, "dev", "view: Orchard board", view="orchard-board", announce=False)
    for name in ("dev/orchard-board", "dev/view-orchard-board", "orchard-board"):
        res = await tools.call(CORPUS, "message_thread", {"thread": name, "message": "Show the dates."})
        assert not res.is_error, (name, res.text)
    assert changes == [("orchard-board", "Show the dates.")] * 3
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
