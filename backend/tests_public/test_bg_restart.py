"""A server restart with a background session that finished before it: Claude Code keeps the session's process, and
lists it as busy while a background shell of its own runs on. The next server does not follow it again, asks main for no
tray entry, and stops listing it every few seconds. A turn the session starts after the restart is followed, and a wake
that follows nothing leaves no run open."""
from __future__ import annotations

import asyncio
import json
import sys
import time

import pytest

import app
from app import agent_session, agents, bg_session, config

CORPUS = "mini"
KEY = "critique:orient"
SHORT = "ab12cd34"
SID = "ab12cd34-0000-4000-8000-000000000000"


def _line(rec: dict) -> str:
    return json.dumps(rec) + "\n"


@pytest.fixture()
def restarted(tmp_path, monkeypatch, workspaces_tmp):
    """The state a server finds at its start: the critic's chat ended done, the registry keeps its session as idle with
    no run open, its transcript's last turn ended, and `claude agents` lists it busy with a process. The critique's
    module is not imported yet, as in a fresh server. Yields (transcript, the listing's rows, main's asks, starts)."""
    path = tmp_path / "projects" / "-work" / f"{SID}.jsonl"
    path.parent.mkdir(parents=True)
    path.write_text(_line({"type": "user", "message": {"role": "user", "content": "Review the orientation."}})
                    + _line({"type": "assistant", "message": {"content": [{"type": "text", "text": "Six problems."}]}})
                    + _line({"type": "system", "subtype": "turn_duration", "durationMs": 1000}))
    monkeypatch.setattr(bg_session.session, "find_transcript",
                        lambda sid, config_dir=None: str(path) if sid == SID else None)
    monkeypatch.setattr(bg_session, "_closing", False)
    monkeypatch.setattr(bg_session, "_changed", asyncio.Event())
    monkeypatch.setattr(bg_session, "_entries", {})
    monkeypatch.setattr(bg_session, "_loaded", set())
    monkeypatch.setattr(bg_session, "_ensure_watcher", lambda: None)
    chat = str(agents.new_agent(CORPUS, agent_session.STEP_ROLE, "critique", session=SID, background=True, bg=SHORT,
                                pid=None)["id"])
    agents.finish_agent(CORPUS, chat, "done", "Six problems.")
    name = bg_session.name_of(CORPUS, KEY)
    (config.workspace_dir(CORPUS) / bg_session.REGISTRY_FILE).write_text(json.dumps([{
        "c": CORPUS, "key": KEY, "name": name, "short": SHORT, "sid": SID, "chat": chat, "role": "step",
        "folder": str(tmp_path / "work"), "started": time.time() - 7200, "status": "idle", "run_open": False,
        "result": "Six problems.", "ended_at": time.time() - 3600, "proxy_agents": ["a1"], "relayed": [],
        "proxy_refused": False}]))
    rows = [{"id": SHORT, "sessionId": SID, "pid": 4242, "status": "busy", "name": name, "kind": "background"}]
    monkeypatch.setattr(bg_session, "listing", lambda bin_=None, env=None: rows)
    asked: list[tuple[str, ...]] = []
    monkeypatch.setattr(bg_session, "ask_main_for_proxy", lambda c, *keys: asked.append(keys) or True)
    starts: list[dict] = []

    async def start(c, key, **kw):
        starts.append({"key": key, **kw})
        raise AssertionError("no run starts")

    monkeypatch.setattr(agent_session, "start", start)
    monkeypatch.delitem(sys.modules, "app.critique_session", raising=False)
    monkeypatch.delattr(app, "critique_session", raising=False)
    monkeypatch.delitem(agent_session._relaunchers, "critique", raising=False)
    yield path, rows, asked, starts


async def test_a_session_that_finished_before_a_restart_is_not_followed_again_while_claude_lists_it_busy(restarted):
    path, rows, asked, starts = restarted
    assert await bg_session.recover() == []
    e = bg_session.entry(CORPUS, KEY)
    assert e is not None and not e.run_open and starts == []
    for _ in range(3):
        await bg_session._tick(rows)
        await asyncio.sleep(0)
    assert not e.run_open and starts == [] and agent_session.current(CORPUS, KEY) is None
    e.proxy_asked = 0.0  # PROXY_ASK_S has passed
    await bg_session._tick(rows)
    assert asked == [], "main is asked for no tray entry"
    assert bg_session.finished(e), "a tray entry started for it ends at once"
    assert not bg_session._hot(), "it is not listed every POLL_S"


async def test_a_turn_it_starts_after_the_restart_is_followed_and_a_wake_that_follows_nothing_leaves_no_run_open(
        restarted, monkeypatch):
    path, rows, asked, starts = restarted
    woken: list[str] = []

    async def wake(c, entry):
        woken.append(entry.key)
        return None  # its chat is gone, say

    await bg_session.recover()
    monkeypatch.setitem(bg_session._wake, "critique", wake)
    e = bg_session.entry(CORPUS, KEY)
    await bg_session._tick(rows)
    assert woken == []
    with path.open("a") as f:
        f.write(_line({"type": "user", "message": {"role": "user", "content": "One more question."}}))
    await bg_session._tick(rows)
    await asyncio.sleep(0)
    await asyncio.sleep(0)
    assert woken == [KEY], "a new turn is followed"
    assert not e.run_open, "a wake that started no run leaves none open"
    e.proxy_asked = 0.0
    rows[0]["status"] = "idle"
    await bg_session._tick(rows)
    assert asked == [] and not bg_session._hot()


async def test_a_run_a_restart_cut_off_is_followed_again(restarted, monkeypatch):
    """A chat whose run was still open when the server stopped is followed again at once, whatever the listing says."""
    path, rows, asked, starts = restarted
    woken: list[str] = []

    async def wake(c, entry):
        woken.append(entry.key)
        return object()

    monkeypatch.setitem(bg_session._wake, "critique", wake)
    bg_session._load(CORPUS)
    e = bg_session.entry(CORPUS, KEY)
    agents.update_agent(CORPUS, e.chat, status="running")
    rows[0]["status"] = "idle"
    assert await bg_session.recover() == [f"{CORPUS}/{e.name}"]
    assert woken == [KEY] and e.run_open


async def test_a_turn_that_began_while_the_server_was_down_is_followed_at_the_start(restarted, monkeypatch):
    path, rows, asked, starts = restarted
    woken: list[str] = []

    async def wake(c, entry):
        woken.append(entry.key)
        return object()

    monkeypatch.setitem(bg_session._wake, "critique", wake)
    with path.open("a") as f:
        f.write(_line({"type": "user", "message": {"role": "user", "content": "One more question."}}))
    assert await bg_session.recover() == [f"{CORPUS}/{bg_session.name_of(CORPUS, KEY)}"]
    assert woken == [KEY]


def test_the_critic_s_start_arguments_are_known_before_any_critique_runs_in_this_server(restarted):
    """A critic's later turn and its Resume need its start arguments, which the critique's module registers when it is
    imported; a fresh server has imported it for no critique yet."""
    e = bg_session.entry(CORPUS, KEY)
    meta = agents.meta_or_none(CORPUS, e.chat)
    kw = agent_session._launch_kw(CORPUS, KEY, meta)
    assert kw is not None and kw["background"] is True


async def test_a_finished_session_whose_process_goes_away_stays_done_with_no_stopped_notice(restarted):
    """Claude Code's background service stops (a reboot): a session that had finished its task shows as done, with no
    notice that it stopped and no Resume."""
    path, rows, asked, starts = restarted
    bg_session._load(CORPUS)
    e = bg_session.entry(CORPUS, KEY)
    for _ in range(bg_session.GONE_AFTER):
        await bg_session._tick([])
    meta = agents.meta_or_none(CORPUS, e.chat)
    assert e.status == "stopped" and meta["status"] == "done" and not meta.get("alert")


async def test_an_unfinished_session_whose_process_goes_away_says_it_stopped(restarted):
    path, rows, asked, starts = restarted
    bg_session._load(CORPUS)
    e = bg_session.entry(CORPUS, KEY)
    agents.update_agent(CORPUS, e.chat, status="running")
    for _ in range(bg_session.GONE_AFTER):
        await bg_session._tick([])
    meta = agents.meta_or_none(CORPUS, e.chat)
    assert meta["status"] == "stopped" and meta["alert"]["kind"] == "stopped"
