"""The orientation, its critic and the writers run as `claude -p` sessions (agent_session.py), never as Claude Code
background sessions, so no folder needs Claude Code's trust: a run is one process, a follow-up continues the same
session with `--resume` in the same chat, Stop ends the process, and each run shows in its tray entry (tray.py) from
the session's transcript. Nothing writes Claude Code's global config.

The stand-in CLI is test_agent_sessions.FAKE, run as agent_session.CLAUDE_BIN."""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest
from test_agent_sessions import FAKE

from app import agent_session, agents, events, orient_session, orientation, session, tools, tray, userconf, write_session

CORPUS = "mini"
KEY = orient_session.KEY


@pytest.fixture()
def fake(tmp_path, monkeypatch, workspaces_tmp) -> Path:
    """The stand-in CLI, the config dir it writes into, and the folder it records into; the tray's watcher off, so a
    test reads the news itself."""
    script = tmp_path / "claude"
    script.write_text(f"#!{__import__('sys').executable}\n{FAKE}")
    script.chmod(0o755)
    out = tmp_path / "fake"
    out.mkdir()
    monkeypatch.setattr(agent_session, "CLAUDE_BIN", str(script))
    monkeypatch.setattr(agent_session, "POLL_S", 0.05)
    monkeypatch.setattr(agent_session, "STOP_WAIT_S", 1.0)
    monkeypatch.setenv("FAKE_DIR", str(out))
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "claude-config"))
    monkeypatch.delenv("FAKE_MODE", raising=False)
    monkeypatch.delenv("FAKE_SLEEP", raising=False)
    monkeypatch.setenv("THIMBLE_SANDBOX", "0")
    monkeypatch.setitem(userconf.DEFAULTS["sandbox"], "enforce", False)
    monkeypatch.setattr(tray, "_ensure_watcher", lambda: None)
    monkeypatch.setattr(tray, "_entries", {})
    monkeypatch.setattr(tray, "_loaded", set())
    session._live.clear()
    events._subs.clear()
    agent_session._runs.clear()
    yield out
    agent_session._runs.clear()
    events._subs.clear()


async def _done(key: str = KEY) -> None:
    run = agent_session._runs.get((CORPUS, key))
    if run is not None and run.task is not None:
        await asyncio.wait_for(run.task, 10)


def _argvs(fake: Path) -> list[list[str]]:
    return [json.loads(line) for line in (fake / "argvs.jsonl").read_text().splitlines()]


def _news(key: str = KEY) -> list[str]:
    e = tray.entry(CORPUS, key)
    assert e is not None
    tray._read_news(e)
    out, e.news = list(e.news), []
    return out


async def _transcript(sid: str) -> None:
    for _ in range(100):
        if session.find_transcript(sid):
            return
        await asyncio.sleep(0.05)


async def test_the_orientation_is_one_claude_p_process_per_run_and_a_follow_up_resumes_its_session(fake,
                                                                                                claude_global_config):
    """The first run is `claude -p --session-id`, a follow-up after it ended is `claude -p --resume` of the same session
    in the same chat, with the message on stdin and its whole context kept. The tray entry follows both runs from the
    one transcript and ends each with the run's end. Claude Code's global config is left as it was."""
    before = claude_global_config.read_text()
    run = await orient_session.start(CORPUS, "")
    await _done()
    first = _argvs(fake)[0]
    assert first[0] == "-p" and "--bg" not in first and first[first.index("--session-id") + 1] == run.sid
    e = tray.entry(CORPUS, KEY)
    assert (e.sid, e.chat, e.run_open, e.status) == (run.sid, run.chat, False, "done")
    news = _news()
    assert news[0] == f"✉ thimble → thimble:orient: {tools.hint('orient-start')}"[:len(news[0])]
    assert "● Agent: general-purpose · Read runs.jsonl" in news
    assert news[-1].startswith("thimble:orient finished its task")

    got = await orient_session.message(CORPUS, "And April?", orient_session.BROWSER)
    assert got["status"] == "resumed" and got["chat"] == run.chat
    assert tray.entry(CORPUS, KEY) is e and e.run_open, "the follow-up is a run of the same entry"
    await _done()
    second = _argvs(fake)[1]
    assert second[0] == "-p" and second[second.index("--resume") + 1] == run.sid and "--session-id" not in second
    assert "And April?" in (fake / "stdin.txt").read_text()
    news = _news()
    assert any(line.startswith("✉ thimble → thimble:orient: ") and "And April?" in line for line in news), news
    assert "● Bash: grep -c run2 runs.jsonl" in news
    assert news[-2:] == ["thimble:orient: done 2", "thimble:orient finished its task."], "the end repeats no reply"
    meta = agents.read_meta(CORPUS, run.chat)
    assert (meta["status"], meta["run"], meta["session"]) == ("done", 1, run.sid)
    assert not meta.get("background") and not meta.get("bg")
    assert claude_global_config.read_text() == before, "nothing thimble starts writes Claude Code's trust"


async def test_stop_ends_the_process_and_a_message_continues_the_stopped_orientation(fake, monkeypatch):
    """Stop ends the run's process, the run ends stopped and its tray entry says so; a message afterwards continues the
    same session with `--resume`."""
    from app import procs

    monkeypatch.setenv("FAKE_MODE", "sleep")
    run = await orient_session.start(CORPUS, "")
    await _transcript(run.sid)
    assert await orient_session.stop(CORPUS)
    assert not procs.alive(run.pid) and agent_session.current(CORPUS, KEY) is None
    assert agents.read_meta(CORPUS, run.chat)["status"] == "stopped"
    assert orientation.read_run(CORPUS)["status"] == "stopped"
    assert tray.entry(CORPUS, KEY).status == "stopped" and _news()[-1] == "thimble:orient was stopped."

    monkeypatch.delenv("FAKE_MODE")
    got = await orient_session.message(CORPUS, "Go on with the March runs.", orient_session.MAIN)
    assert got["status"] == "resumed"
    await _done()
    last = _argvs(fake)[-1]
    assert last[last.index("--resume") + 1] == run.sid
    assert agents.read_meta(CORPUS, run.chat)["status"] == "done"


async def test_a_message_while_the_orientation_runs_waits_for_its_run_to_end(fake, monkeypatch):
    monkeypatch.setenv("FAKE_SLEEP", "1")
    await orient_session.start(CORPUS, "")
    await _done()
    monkeypatch.setenv("FAKE_SLEEP", "1.5")
    await orient_session.message(CORPUS, "First.", orient_session.BROWSER)
    queued = await orient_session.message(CORPUS, "Second.", orient_session.BROWSER)
    assert queued["status"] == "queued"
    await _done()
    for _ in range(100):  # the waiting message's run starts once the run ends
        if len(_argvs(fake)) == 3:
            break
        await asyncio.sleep(0.05)
    await asyncio.sleep(0.1)
    await _done()
    assert len(_argvs(fake)) == 3 and "Second." in (fake / "stdin.txt").read_text()


async def test_a_writer_s_tray_message_continues_its_session_at_once_or_when_its_run_ends(fake, monkeypatch):
    """A message for a writer (write_session.message, as a tray entry passes it on) continues its session with
    `--resume` as the chat's next run; while a run goes it waits for that run's end."""
    from app import report_types

    monkeypatch.setattr(report_types, "begin_write", lambda *a, **k: None)
    key = write_session.session_key("report")
    run = await write_session.start(CORPUS, "report")
    await _done(key)
    got = await write_session.message(CORPUS, "report", "Shorter, please.", agents.TERMINAL, chat=run.chat, sid=run.sid)
    assert got["status"] == "resumed"
    await _done(key)
    stdin = (fake / "stdin.txt").read_text()
    assert stdin == tools.hint("bg-from-terminal", text="Shorter, please.")
    monkeypatch.setenv("FAKE_SLEEP", "1")
    again = await write_session.message(CORPUS, "report", "And a title.", agents.MAIN_ID, chat=run.chat, sid=run.sid)
    queued = await write_session.message(CORPUS, "report", "One more.", agents.TERMINAL, chat=run.chat, sid=run.sid)
    assert (again["status"], queued["status"]) == ("resumed", "queued")
    await _done(key)
    for _ in range(100):  # the waiting message's run starts once the run ends
        if len(_argvs(fake)) == 4:
            break
        await asyncio.sleep(0.05)
    await asyncio.sleep(0.1)
    await _done(key)
    argvs = _argvs(fake)
    assert len(argvs) == 4 and all(a[a.index("--resume") + 1] == run.sid for a in argvs[1:])
    assert (fake / "stdin.txt").read_text() == tools.hint("bg-from-terminal", text="One more.")
    assert agents.read_meta(CORPUS, run.chat)["run"] == 3
    _, log_path = agents.paths(CORPUS, run.chat)
    typed = [r["text"] for r in agents.read_events(log_path) if r.get("type") == "user"]
    assert typed[-3:] == ["Shorter, please.", "And a title.", "One more."], "each message shows in the writer's thread"


async def test_an_earlier_version_s_background_chat_left_running_is_stopped_and_resumed_as_claude_p(fake, monkeypatch):
    """A chat 0.5.0 ran as a Claude Code background session, left running across the update: the server's recovery
    stops that background session with `claude stop` and continues its session with `claude -p --resume`, and the chat
    no longer names a background session."""
    stopped: list[str] = []
    monkeypatch.setattr(agent_session, "_stop_background", stopped.append)
    run = await orient_session.start(CORPUS, "")
    await _done()
    agents.update_agent(CORPUS, run.chat, status="running", pid=None, background=True, bg="ab12cd34")
    orientation.record(CORPUS, status="running")
    closed, resumed = await agent_session.recover()
    assert stopped == ["ab12cd34"] and resumed == [f"{CORPUS}/{run.chat}"] and not closed
    await _done()
    last = _argvs(fake)[-1]
    assert last[0] == "-p" and last[last.index("--resume") + 1] == run.sid
    meta = agents.read_meta(CORPUS, run.chat)
    assert meta["status"] == "done" and meta.get("background") is None and meta.get("bg") is None


async def test_an_earlier_version_s_idle_background_sessions_are_stopped_at_start_and_before_a_follow_up(fake,
                                                                                                       monkeypatch):
    """An orientation 0.5.0 left idle in Claude Code's background service across the update still lists in `claude
    agents`: the server's start stops each background session that version's registry or a chat names, once, and a
    follow-up of a chat that still names one stops it before `claude -p --resume` runs."""
    from app import config

    stopped: list[str] = []
    monkeypatch.setattr(agent_session, "_stop_background", stopped.append)
    run = await orient_session.start(CORPUS, "")
    await _done()
    agents.update_agent(CORPUS, run.chat, background=True, bg="ab12cd34")
    old = config.workspace_dir(CORPUS) / agent_session.OLD_BG_FILE
    old.write_text(json.dumps([{"key": KEY, "short": "ab12cd34"}, {"key": "writer:report", "short": "ef56ab78"}]))
    closed, resumed = await agent_session.recover()
    assert (closed, resumed) == ([], []) and stopped == ["ab12cd34", "ef56ab78"]
    assert not old.exists() and agents.read_meta(CORPUS, run.chat).get("bg") is None
    await agent_session.recover()
    assert stopped == ["ab12cd34", "ef56ab78"], "it runs once"

    agents.update_agent(CORPUS, run.chat, bg="0a0b0c0d")
    await orient_session.message(CORPUS, "And April?", orient_session.BROWSER)
    await _done()
    assert stopped[-1] == "0a0b0c0d" and agents.read_meta(CORPUS, run.chat).get("bg") is None


async def test_a_writer_s_waiting_messages_are_kept_on_its_chat_and_a_stop_drops_them_saying_so(fake, monkeypatch):
    """Messages that wait for a writer's run are kept on its chat's meta (`queued`), which a server restart keeps and its
    thread shows; when the analyst stops the run, they are dropped and its tray entry says so."""
    from app import report_types

    monkeypatch.setattr(report_types, "begin_write", lambda *a, **k: None)
    key = write_session.session_key("report")
    monkeypatch.setenv("FAKE_MODE", "sleep")
    run = await write_session.start(CORPUS, "report")
    await _transcript(run.sid)
    got = await write_session.message(CORPUS, "report", "Shorter, please.", agents.TERMINAL, chat=run.chat, sid=run.sid)
    assert got["status"] == "queued"
    assert agents.read_meta(CORPUS, run.chat)["queued"] == [{"text": "Shorter, please.", "by": agents.TERMINAL}]
    _news(key)
    assert await agent_session.stop(CORPUS, key)
    assert agents.read_meta(CORPUS, run.chat)["queued"] == []
    news = _news(key)
    assert "thimble:writer: the message that waited for it was not passed on, since it was stopped." in news, news
    assert len(_argvs(fake)) == 1, "the stopped writer was not continued"


async def test_a_dev_restart_waits_for_a_running_writer_or_critique_as_for_an_orientation(fake, monkeypatch):
    from app import dev, report_types

    monkeypatch.setattr(report_types, "begin_write", lambda *a, **k: None)
    monkeypatch.setenv("FAKE_MODE", "sleep")
    assert CORPUS not in dev.agents_running()
    await write_session.start(CORPUS, "report")
    assert CORPUS in dev.agents_running()
    await agent_session.stop(CORPUS, write_session.session_key("report"))
    assert CORPUS not in dev.agents_running()


def test_a_message_typed_in_a_tray_entry_reaches_the_orientation_as_the_analyst_s_from_the_tray():
    lead = orient_session._lead([{"text": "And April?", "by": orient_session.TERMINAL}])
    assert tools.hint("orient-from-terminal") in lead and tools.hint("orient-from-analyst") not in lead
