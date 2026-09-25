"""A thread's life past its first answer (app/threads.py, app/agents.py): a session that ends under a thread says so
in the thread, and the thread's next question forks anew with what was said; a deleted thread's fork writes nothing
outside the trash; and the permission prompt of a thread's fork names its thread."""
from __future__ import annotations

import asyncio

import pytest
from fastapi.testclient import TestClient

from app import agents, channel, config, session, threads

CORPUS = "mini"


@pytest.fixture(autouse=True)
def _fresh(workspaces_tmp, tmp_path, monkeypatch):
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "claude-config"))
    channel._subs.clear()
    session._live.clear()
    session._expected.clear()
    session._event_threads.clear()
    agents._busy.clear()
    threads._awaiting.clear()
    yield
    channel._subs.clear()
    session._live.clear()
    threads._awaiting.clear()


def _listen() -> asyncio.Queue:
    q: asyncio.Queue = asyncio.Queue()
    channel._subs.setdefault(CORPUS, set()).add(q)
    return q


def _drain(q: asyncio.Queue) -> list[dict]:
    out = []
    while not q.empty():
        out.append(q.get_nowait())
    return out


def _log(chat: str) -> list[dict]:
    return agents.read_events(agents.paths(CORPUS, chat)[1])


def _attach(sid: str = "s" * 8) -> session.Live:
    lv = session.attach(CORPUS, sid, str(config.corpus_dir(CORPUS)), None)
    assert lv is not None
    return lv


def _ask(tid: str, text: str) -> dict:
    return channel.post(CORPUS, channel.THREAD, {"thread": tid, "text": text})


def test_a_thread_whose_session_ends_says_so_and_its_next_question_forks_anew_with_what_was_said():
    q = _listen()
    lv = _attach()
    t = agents.new_thread(CORPUS, "card:abc", "a card")
    _ask(t["id"], "why so high?")
    threads.fork_started(CORPUS, t["id"], agent_id="a1", tool_use_id="toolu_1", session=lv.sid)
    threads.reply(CORPUS, t["id"], "It posted the nightly report.", by="terminal")
    threads.fork_finished(CORPUS, t["id"], "done")
    _ask(t["id"], "sort the chart")  # a follow-up the fork was working on when the session ended
    _drain(q)
    session.detach(CORPUS, lv.sid, "ended")
    assert not agents.running(CORPUS, t["id"])
    assert _log(t["id"])[-1]["kind"] == threads.SESSION_ENDED
    assert agents.read_meta(CORPUS, t["id"])["fork"]["ended"]
    # the same session id attached again (claude --resume): the fork is gone with the process all the same
    _attach(lv.sid)
    _ask(t["id"], "still there?")
    [note] = _drain(q)
    assert "agent" not in note["meta"] and "ref: card:abc" in note["content"]
    assert "earlier:\nanalyst: why so high?\nreply: It posted the nightly report.\nanalyst: sort the chart" in note["content"]


def test_a_deleted_thread_s_fork_writes_nothing_outside_the_trash(workspaces_tmp):
    from app.main import app

    t = agents.new_thread(CORPUS, "card:abc", "a card")
    rec = agents.Recorder(CORPUS, t["id"])
    with TestClient(app, base_url="http://127.0.0.1") as client:
        assert client.delete(f"/api/ws/{CORPUS}/chats/{t['id']}").status_code == 200
    rec.tool_use("toolu_1", "Read", {"file_path": "x"})
    assert not agents.paths(CORPUS, t["id"])[1].exists(), "no log without its meta"
    assert (agents.chats_dir(CORPUS) / "trash" / f"{t['id']}.meta.json").is_file()


def test_a_fork_s_permission_prompt_names_its_thread():
    t = agents.new_thread(CORPUS, "card:abc", "a card")
    agents.update_agent(CORPUS, t["id"], fork={"agent_id": "a9", "session": "s"})
    channel._hold(CORPUS, "hook-1", "Bash", "ls", "{}", "a9")
    channel._hold(CORPUS, "hook-2", "Bash", "ls", "{}", None)
    held = {p["id"]: p for p in agents.read_meta(CORPUS, "main")["permissions"]}
    assert held["hook-1"]["chat"] == t["id"] and "chat" not in held["hook-2"]
