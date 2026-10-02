"""session.py: the mirror of the analyst's Claude Code session. The transcript tail translates a turn and skips every
other record, and main follows its session when Claude Code moves it into a background job. Every transcript here is
written by the test in Claude Code's record shapes."""
from __future__ import annotations

import asyncio
import json
from collections import deque
from pathlib import Path

import pytest

from app import agents, cc_channel, channel, config, session, threads

CORPUS = "mini"
SID = "e7b0a1f2-0000-4000-8000-000000000001"
ADD_CARD = "mcp__plugin_thimble_thimble__add_card"


@pytest.fixture(autouse=True)
def _fresh(workspaces_tmp, tmp_path, monkeypatch):
    # Claude Code's config dir, empty: the mirror reads a session's state file from it (session.session_state)
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "claude-config"))
    session._live.clear()
    session._expected.clear()
    session._event_threads.clear()
    session._came_back.clear()
    session._shim_pids.clear()
    session._shim_configs.clear()
    for table in (channel._subs, channel._routes, channel._pending, channel._taken):
        table.clear()
    agents._busy.clear()
    yield
    session._live.clear()
    for table in (channel._subs, channel._routes, channel._pending, channel._taken):
        table.clear()


@pytest.fixture()
def cwd() -> str:
    return str(config.corpus_dir(CORPUS))


def _log(chat: str) -> list[dict]:
    _, log_path = agents.paths(CORPUS, chat)
    return agents.read_events(log_path)


def _mirror() -> list[dict]:
    return [r for r in _log(agents.MAIN_ID) if r.get("by") in ("terminal", "browser")]


def _attach(cwd: str, transcript: Path, sid: str = SID, **kw) -> session.Live:
    lv = session.attach(CORPUS, sid, cwd, str(transcript), **kw)
    assert lv is not None
    return lv


END = {"type": "system", "subtype": "turn_duration"}


def _human(text: str) -> dict:
    return {"type": "user", "origin": {"kind": "human"}, "message": {"content": text}}


def _assistant(*blocks: dict) -> dict:
    return {"type": "assistant", "message": {"role": "assistant", "model": "claude-sonnet-5", "content": list(blocks)}}


def _say(text: str) -> dict:
    return {"type": "text", "text": text}


def _use(tool_use_id: str, name: str, tool_input: dict) -> dict:
    return {"type": "tool_use", "id": tool_use_id, "name": name, "input": tool_input}


def _result(tool_use_id: str, content) -> dict:
    return {"type": "user", "message": {"role": "user", "content": [
        {"type": "tool_result", "tool_use_id": tool_use_id, "content": content}]}}


def _append(p: Path, lv: session.Live, recs: list[dict]) -> None:
    with p.open("a") as f:
        f.write("".join(json.dumps(r) + "\n" for r in recs))
    session.tail_once(lv)


# ----------------------------------------------------------------------------- the tail


def test_the_tail_translates_a_turn_and_skips_every_other_record(cwd, tmp_path):
    """A turn of main's: the prompt is the analyst's line, then the add_card call with the card id read from its result,
    the reply, and `done` at the turn's end. The ToolSearch that loaded add_card, attachments, thinking, meta prompts and
    queue records write nothing."""
    p = tmp_path / f"{SID}.jsonl"
    p.write_text("")
    lv = _attach(cwd, p)
    session.tail_once(lv)
    _append(p, lv, [
        _human("Add a card that counts the board's posts."),
        {"type": "attachment", "attachment": {"type": "environment"}},
        {"type": "queue-operation", "operation": "enqueue"},
        _assistant({"type": "thinking", "thinking": ""}),
        _assistant(_use("toolu_ts", "ToolSearch", {"query": "select:" + ADD_CARD})),
        _result("toolu_ts", "loaded"),
        _assistant(_use("toolu_ac", ADD_CARD, {"kind": "code", "question": "How many posts?", "code": "print(8)"})),
        _result("toolu_ac", '$ add_card kind="code" question="How many posts?" code="print(8)"\ncard:cd34ef56\nL1|8'),
        {"type": "user", "isMeta": True, "message": {"content": [{"type": "text", "text": "Base directory"}]}},
        _assistant(_say("card:cd34ef56")),
        END,
    ])
    recs = _mirror()
    assert [r["type"] for r in recs] == ["user", "tool_use", "tool_result", "text", "done"], recs
    user, use, made, text, _ = recs
    assert user["text"] == "Add a card that counts the board's posts." and user["by"] == "terminal"
    assert use["name"] == ADD_CARD and made["cell_id"] == "cd34ef56" and text["delta"] == "card:cd34ef56"
    assert not lv.degraded and lv.offset == p.stat().st_size and lv.buf == b""
    n = len(_log(agents.MAIN_ID))
    session.tail_once(lv)
    assert len(_log(agents.MAIN_ID)) == n  # nothing new




# ----------------------------------------------------------------------------- a session that continues in a job

JOB = "e7b0a1f2-0000-4000-8000-000000000002"  # the background job's session
NEXT = "e7b0a1f2-0000-4000-8000-000000000003"
MOVED_AT = "2026-10-01T21:17:45.528Z"


def _subscribe(sid: str, delivery: str) -> asyncio.Queue:
    q: asyncio.Queue = asyncio.Queue()
    channel._subs.setdefault(CORPUS, set()).add(q)
    channel._routes[q] = (sid, delivery)
    return q


def _stamped(sid: str, n: int, at: str, *recs: dict) -> list[dict]:
    """Records as Claude Code writes them in session `sid`: each with its uuid and its time."""
    return [{**r, "uuid": f"{n}-{i}", "timestamp": at, "sessionId": sid} for i, r in enumerate(recs)]


def _turn(sid: str, n: int, at: str, ask: str) -> list[dict]:
    return _stamped(sid, n, at, _human(ask), _assistant(_say(f"About {ask}")), END)


def _moved(sid: str, to: str, at: str = MOVED_AT) -> list[dict]:
    """The continued-in record, then an event queued for the parked session, which never reads it."""
    return [{"type": "continued-in", "timestamp": at, "sessionId": sid, "continuedInSessionId": to},
            {"type": "queue-operation", "operation": "enqueue", "timestamp": "2026-10-01T22:41:21.160Z",
             "sessionId": sid, "content": "<channel kind=\"main\">hello</channel>"}]


def _copy(recs: list[dict], sid: str) -> list[dict]:
    """What the job's transcript opens with: a title and its queue, then the conversation, each record with its uuid and
    time."""
    return [{"type": "custom-title", "customTitle": "thimble:main", "sessionId": sid},
            {"type": "queue-operation", "operation": "dequeue", "timestamp": "2026-10-01T21:17:46.000Z",
             "sessionId": sid},
            *({**r, "sessionId": sid} for r in recs if r.get("uuid"))]


def _write(p: Path, recs: list[dict]) -> None:
    with p.open("a") as f:
        f.write("".join(json.dumps(r) + "\n" for r in recs))


def _shown(kind: str) -> list[str]:
    return [r.get("text") or r.get("delta") or "" for r in _mirror() if r["type"] == kind]


def _restart() -> None:
    """The server stops and starts again: what it held in memory is gone, and every shim subscribes anew."""
    session._live.clear()
    session._shim_pids.clear()
    for table in (channel._subs, channel._routes):
        table.clear()


@pytest.fixture()
def project(tmp_path) -> Path:
    """The project folder of Claude Code's config dir, where find_transcript finds the job's transcript."""
    d = tmp_path / "claude-config" / "projects" / "-corpus"
    d.mkdir(parents=True)
    return d


@pytest.fixture()
def quits(monkeypatch) -> list[str]:
    """The workspaces whose agents stopped because main's session ended (session._stop_agents)."""
    stopped: list[str] = []
    monkeypatch.setattr(session, "_stop_agents", stopped.append)
    monkeypatch.setattr(session, "_shutting_down", lambda: False)
    monkeypatch.setattr(session, "GRACE_S", 0)
    return stopped


@pytest.mark.parametrize("first", ["watcher", "shim"])
def test_main_follows_its_session_into_a_background_job_and_the_parked_session_never_takes_main_back(
        cwd, project, tmp_path, quits, first):
    """Claude Code moves main's session into a background job, and before the tail reads the continued-in record the
    job's watcher asks for events, or its shim subscribes on the hook route: main follows at once, with the pid the shim
    reported. The job's transcript shows from its first record of its own, so the copied turn is not shown again. The
    events queued for the old session move to the job, and Claude Code's state file is read by the job's pid. The
    parked session stays subscribed: subscribing again does not make it main, its quitting stops nothing, and when the
    job ends main does not fall back to it."""
    p = project / f"{SID}.jsonl"
    p.write_text("")
    old_sub = _subscribe(SID, cc_channel.CHANNEL)
    lv = _attach(cwd, p, pid=100)
    session.tail_once(lv)
    asked = _turn(SID, 1, "2026-10-01T20:26:31.492Z", "the board's posts")
    _append(p, lv, asked)
    channel._pending[(CORPUS, SID)] = deque([{"content": "x", "meta": {"event": "e1"}}])

    _write(project / f"{JOB}.jsonl", [*_copy(asked, JOB), *_turn(JOB, 2, "2026-10-01T23:30:03.924Z", "the threads")])
    _write(p, _moved(SID, JOB))
    if first == "watcher":
        assert channel._pull_state(CORPUS, JOB, 200) is None, "the job's watcher waits for events"
        assert session.current(CORPUS).sid == JOB
    _subscribe(JOB, cc_channel.HOOK)
    session.connected(CORPUS, JOB, cwd, 200, claim=False)
    job = session.current(CORPUS)
    assert job is not None and job.sid == JOB and job.pid == 200 and session.main_pid(CORPUS) == 200
    session.tail_once(job)
    assert _shown("user") == ["the board's posts", "the threads"]
    assert _shown("text") == ["About the board's posts", "About the threads"]
    assert [n["meta"]["event"] for n in channel._pending[(CORPUS, JOB)]] == ["e1"]
    assert not channel._pending.get((CORPUS, SID))
    states = tmp_path / "claude-config" / "sessions"
    states.mkdir(parents=True)
    (states / "100.json").write_text(json.dumps({"sessionId": SID, "status": "idle", "parkedJobId": JOB[:8]}))
    (states / "200.json").write_text(json.dumps({"sessionId": JOB, "status": "waiting", "kind": "bg"}))
    assert session.session_state(job)["status"] == "waiting"

    assert session.sessions(CORPUS)[SID]["reason"] == session.CONTINUED and not session.may_return(CORPUS, SID)
    session.connected(CORPUS, SID, cwd, 100)
    assert session.current(CORPUS) is job, "the parked session's shim subscribing again on the channel"
    channel._subs[CORPUS].discard(old_sub)
    session.disconnected(CORPUS, SID)
    assert session.current(CORPUS) is job and quits == []
    channel._subs[CORPUS].add(old_sub)
    for q in [q for q in channel._subs[CORPUS] if channel._routes[q][0] == JOB]:
        channel._subs[CORPUS].discard(q)
    session.disconnected(CORPUS, JOB)
    assert session.current(CORPUS) is None and quits == [CORPUS], "the job ended; the parked session is not main again"


def test_a_job_written_and_subscribed_after_main_followed_takes_the_open_turn_on_across_a_restart(cwd, project, quits):
    """Main follows before the job's transcript exists and before its shim subscribes, and the server restarts at once:
    the restarted server makes the job main when its shim subscribes (sessions.json), not the parked session, whose
    shim subscribes first, and the turn the old session left open goes on from the job's first record of its own."""
    p = project / f"{SID}.jsonl"
    p.write_text("")
    _subscribe(SID, cc_channel.CHANNEL)
    lv = _attach(cwd, p, pid=100)
    session.tail_once(lv)
    asked = _stamped(SID, 1, "2026-10-01T20:26:31.492Z", _human("Add a card"),
                     _assistant(_use("toolu_ac", ADD_CARD, {"kind": "code", "question": "How many posts?"})))
    _append(p, lv, [*asked, *_moved(SID, JOB)])
    t = project / f"{JOB}.jsonl"
    job = session.current(CORPUS)
    assert job is not None and job.sid == JOB and job.pid is None and job.turn_open and job.transcript_path == str(t)
    assert _shown("user") == ["Add a card"]

    _restart()
    _write(t, [*_copy(asked, JOB), *_stamped(JOB, 2, "2026-10-01T21:18:00.000Z", _result("toolu_ac", "card:cd34ef56"),
                                              _assistant(_say("card:cd34ef56")), END)])
    _subscribe(SID, cc_channel.CHANNEL)
    session.connected(CORPUS, SID, cwd, 100)
    assert session.current(CORPUS) is None, "the parked session subscribing first is not main"
    _subscribe(JOB, cc_channel.HOOK)
    session.connected(CORPUS, JOB, cwd, 200, claim=False)
    job = session.current(CORPUS)
    assert job is not None and job.sid == JOB and job.pid == 200
    session.tail_once(job)
    assert [r["type"] for r in _mirror()] == ["user", "tool_use", "tool_result", "text", "done"]


def test_a_record_the_job_writes_in_the_millisecond_of_the_move_is_shown(cwd, project, quits):
    """The job's first turn of its own is stamped in the same millisecond as the continued-in record: its records have
    new uuids, so they are shown, and only the turn the job copied is skipped."""
    p = project / f"{SID}.jsonl"
    p.write_text("")
    _subscribe(SID, cc_channel.CHANNEL)
    lv = _attach(cwd, p, pid=100)
    session.tail_once(lv)
    asked = _turn(SID, 1, "2026-10-01T20:26:31.492Z", "the board's posts")
    _append(p, lv, [*asked, *_moved(SID, JOB)])
    _write(project / f"{JOB}.jsonl", [*_copy(asked, JOB), *_turn(JOB, 2, MOVED_AT, "the threads")])
    job = session.current(CORPUS)
    assert job is not None and job.sid == JOB
    session.tail_once(job)
    assert _shown("user") == ["the board's posts", "the threads"]
    assert _shown("text") == ["About the board's posts", "About the threads"]


@pytest.mark.parametrize("back_first", ["parked", "job"])
def test_main_follows_after_a_restart_past_the_move_and_again_when_the_job_comes_back_or_moves_on(
        cwd, project, quits, back_first):
    """A server restarted under a session whose transcript the last server read past its continued-in record follows it
    when the parked session's shim subscribes, or the job's alone. The job brought back into an interactive process is
    main there (its pid) and outlives the background process's shim; a job that continues in yet another session is
    followed again."""
    p = project / f"{SID}.jsonl"
    asked = _turn(SID, 1, "2026-10-01T20:26:31.492Z", "the board's posts")
    _write(p, asked)
    lv = _attach(cwd, p, pid=100)
    lv.offset = 0
    session.tail_once(lv)
    _write(p, _moved(SID, JOB))
    lv.offset = p.stat().st_size  # a server that did not follow it read past the move
    session._save_cursor(lv)

    _restart()
    t = project / f"{JOB}.jsonl"
    threads = _turn(JOB, 2, "2026-10-01T23:30:03.924Z", "the threads")
    _write(t, [*_copy(asked, JOB), *threads])
    if back_first == "parked":
        _subscribe(SID, cc_channel.CHANNEL)
        session.connected(CORPUS, SID, cwd, 100)
    bg = _subscribe(JOB, cc_channel.HOOK)
    session.connected(CORPUS, JOB, cwd, 200, claim=False)
    job = session.current(CORPUS)
    assert job is not None and job.sid == JOB and job.pid == 200
    session.tail_once(job)
    assert _shown("text") == ["About the board's posts", "About the threads"]

    _subscribe(JOB, cc_channel.CHANNEL)
    session.connected(CORPUS, JOB, cwd, 300)
    assert session.current(CORPUS) is job and job.pid == 300 and session.main_pid(CORPUS) == 300
    channel._subs[CORPUS].discard(bg)
    session.disconnected(CORPUS, JOB)
    assert session.current(CORPUS) is job and quits == [], "the background process's shim leaving ends nothing"

    later = _turn(JOB, 3, "2026-10-02T00:08:35.620Z", "the timeline")
    _write(t, [*later, *_moved(JOB, NEXT, "2026-10-02T00:20:00.000Z")])
    _write(project / f"{NEXT}.jsonl",
           [*_copy([*asked, *threads, *later], NEXT), *_turn(NEXT, 4, "2026-10-02T00:21:00.000Z", "a card")])
    session.tail_once(job)
    nxt = session.current(CORPUS)
    assert nxt is not None and nxt.sid == NEXT
    session.tail_once(nxt)
    assert _shown("text") == ["About the board's posts", "About the threads", "About the timeline", "About a card"]


def test_a_session_replaced_before_its_move_was_read_is_parked_all_the_same(cwd, project, quits):
    """/thimble in the job makes it main before the tail read the old session's continued-in record: the old session,
    replaced, is parked all the same, since its transcript ends with the move. Its shim's subscription does not make it
    main, nor does the job's end."""
    p = project / f"{SID}.jsonl"
    _write(p, [*_turn(SID, 1, "2026-10-01T20:26:31.492Z", "the board's posts"), *_moved(SID, JOB)])
    _subscribe(SID, cc_channel.CHANNEL)
    _attach(cwd, p, pid=100)
    job_sub = _subscribe(JOB, cc_channel.HOOK)
    assert session.attach(CORPUS, JOB, cwd, None, 200) is not None
    assert session.sessions(CORPUS)[SID]["reason"] == "replaced" and not session.may_return(CORPUS, SID)
    session.connected(CORPUS, SID, cwd, 100)
    assert session.current(CORPUS).sid == JOB
    channel._subs[CORPUS].discard(job_sub)
    session.disconnected(CORPUS, JOB)
    assert session.current(CORPUS) is None and quits == [CORPUS]


@pytest.mark.parametrize("restart", [False, True])
def test_a_subagent_at_work_when_the_session_moves_goes_on_in_the_job(cwd, project, quits, restart):
    """Main's background subagent still works when Claude Code moves the session into a job: its chat runs on, and the
    job's task notification ends it with its result, after a server restart too."""
    p = project / f"{SID}.jsonl"
    p.write_text("")
    _subscribe(SID, cc_channel.CHANNEL)
    lv = _attach(cwd, p, pid=100)
    session.tail_once(lv)
    started = _stamped(SID, 1, "2026-10-01T20:27:52.417Z", _human("Count the posts in the background"),
                       _assistant(_use("toolu_ag", "Agent", {"description": "posts", "prompt": "Count the posts.",
                                                             "run_in_background": True})),
                       _result("toolu_ag", "Async agent launched successfully.\nagentId: a1b2c3d4"), END)
    _append(p, lv, [*started, *_moved(SID, JOB)])
    assert session.current(CORPUS).sid == JOB
    chat = next(m for m in agents.list_chats(CORPUS) if m.get("role") == session.SUBAGENT_ROLE)
    assert chat["status"] == "running" and chat["session"] == JOB
    if restart:
        _restart()
        _subscribe(JOB, cc_channel.HOOK)
        session.connected(CORPUS, JOB, cwd, 200, claim=False)
    note = ("<task-notification>\n<task-id>a1b2c3d4</task-id>\n<status>completed</status>\n<result>8 posts</result>\n"
            "</task-notification>")
    _write(project / f"{JOB}.jsonl", [*_copy(started, JOB), *_stamped(
        JOB, 2, "2026-10-01T23:30:03.924Z", {"type": "user", "origin": {"kind": "task-notification"},
                                             "message": {"content": note}}, _assistant(_say("8 posts.")), END)])
    session.tail_once(session.current(CORPUS))
    chat = agents.read_meta(CORPUS, chat["id"])
    assert chat["status"] == "done" and chat["result"] == "8 posts"
    assert _shown("text") == ["8 posts."]


class _Req:
    """A request whose client stays connected, for calling a route function directly."""

    async def is_disconnected(self) -> bool:
        return False


async def _job_subscribes_on_the_channel(cwd: str) -> dict:
    """The job's shim subscribes on the channel route: the first event its stream carries after `ready`."""
    resp = await channel.subscribe(_Req(), cwd=cwd, session=JOB, pid=200)
    gen = resp.body_iterator
    try:
        assert (await gen.__anext__())["event"] == "ready"
        return json.loads((await gen.__anext__())["data"])
    finally:
        await gen.aclose()


@pytest.mark.parametrize("job_route", [cc_channel.HOOK, cc_channel.CHANNEL])
@pytest.mark.parametrize("old_route", [cc_channel.CHANNEL, cc_channel.HOOK])
def test_an_event_posted_after_the_move_and_before_the_job_s_shim_subscribes_waits_for_the_job(
        cwd, project, old_route, job_route):
    """The browser posts an event after Claude Code wrote the move, before the tail read it and before the job's shim
    subscribed: main follows first, and the event waits in the job's queue, never the parked session's, until the
    job's watcher takes it or its channel subscribes."""
    p = project / f"{SID}.jsonl"
    p.write_text("")
    old_sub = _subscribe(SID, old_route)
    lv = _attach(cwd, p, pid=100)
    session.tail_once(lv)
    asked = _turn(SID, 1, "2026-10-01T20:26:31.492Z", "the board's posts")
    _append(p, lv, asked)
    _write(project / f"{JOB}.jsonl", _copy(asked, JOB))
    _write(p, _moved(SID, JOB))

    posted = channel.post(CORPUS, "main", {"text": "Which posts are new?"})
    assert session.current(CORPUS).sid == JOB and posted["delivered"] == 1
    assert old_sub.empty() and not channel._pending.get((CORPUS, SID))
    assert [n["meta"]["event"] for n in channel._pending[(CORPUS, JOB)]] == [posted["id"]]
    if job_route == cc_channel.HOOK:
        _subscribe(JOB, cc_channel.HOOK)
        session.connected(CORPUS, JOB, cwd, 200, claim=False)
        got = asyncio.run(channel.pull_route(_Req(), cwd=cwd, session=JOB, wait=1, pid=200))
        assert got["id"] == posted["id"]
    else:
        got = asyncio.run(_job_subscribes_on_the_channel(cwd))
        assert got["meta"]["event"] == posted["id"] and not channel._pending.get((CORPUS, JOB))


def test_naming_the_job_after_an_unread_move_takes_over_from_no_session(cwd, project):
    """/thimble in the job before the tail read the move: the parked session is never main again, so /thimble says
    nothing of taking over from it."""
    p = project / f"{SID}.jsonl"
    p.write_text("")
    _subscribe(SID, cc_channel.CHANNEL)
    lv = _attach(cwd, p, pid=100)
    session.tail_once(lv)
    _write(p, [*_turn(SID, 1, "2026-10-01T20:26:31.492Z", "the board's posts"), *_moved(SID, JOB)])
    out = asyncio.run(channel.session_route(CORPUS, channel.SessionBody(session=JOB, cwd=cwd)))
    assert out["attached"] and out["replaced"] is None and session.current(CORPUS).sid == JOB


def test_a_thread_s_fork_at_work_when_the_session_moves_goes_on_in_the_job(cwd, project, quits):
    """A thread's fork still works when Claude Code moves the session into a job: the fork is the job's, the thread
    keeps running, and the job's task notification finishes it."""
    p = project / f"{SID}.jsonl"
    p.write_text("")
    _subscribe(SID, cc_channel.CHANNEL)
    lv = _attach(cwd, p, pid=100)
    session.tail_once(lv)
    thread = agents.new_thread(CORPUS, None, None, "Days the page changed")
    channel.post(CORPUS, "thread", {"thread": thread["id"], "text": "On which days did it change?"})
    name = agents.read_meta(CORPUS, thread["id"])[threads.FORK_NAME_KEY]
    forked = _stamped(SID, 1, "2026-10-01T20:27:52.417Z", _human("Look into the thread"),
                      _assistant(_use("toolu_fk", "Agent", {"description": f"thread:{name}", "prompt": "Answer it.",
                                                            "run_in_background": True})),
                      _result("toolu_fk", "Async agent launched successfully.\nagentId: f0e1d2c3"), END)
    _append(p, lv, [*forked, *_moved(SID, JOB)])
    assert session.current(CORPUS).sid == JOB
    fork = agents.read_meta(CORPUS, thread["id"])["fork"]
    assert fork["session"] == JOB and fork["agent_id"] == "f0e1d2c3" and not fork.get("ended")
    assert agents.running(CORPUS, thread["id"])

    note = ("<task-notification>\n<task-id>f0e1d2c3</task-id>\n<status>completed</status>\n<result>Mondays</result>\n"
            "</task-notification>")
    _write(project / f"{JOB}.jsonl", [*_copy(forked, JOB), *_stamped(
        JOB, 2, "2026-10-01T23:30:03.924Z", {"type": "user", "origin": {"kind": "task-notification"},
                                             "message": {"content": note}}, _assistant(_say("It answered.")), END)])
    session.tail_once(session.current(CORPUS))
    assert not agents.running(CORPUS, thread["id"])
    assert [r["type"] for r in _log(thread["id"]) if r["type"] in ("done", "error")] == ["done"]


def test_a_moved_job_s_subagent_transcript_links_to_the_old_one_and_each_line_shows_once(cwd, project, quits):
    """Claude Code links the job's subagent transcript to the old session's file, which it keeps appending to: the job
    adopts the link as the subagent it carried, so there is no second chat and a line written after the move shows
    once."""
    p = project / f"{SID}.jsonl"
    p.write_text("")
    _subscribe(SID, cc_channel.CHANNEL)
    lv = _attach(cwd, p, pid=100)
    session.tail_once(lv)
    old = project / SID / "subagents" / "agent-a1b2c3d4.jsonl"
    old.parent.mkdir(parents=True)
    old.with_name("agent-a1b2c3d4.meta.json").write_text(json.dumps({"toolUseId": "toolu_ag", "description": "posts"}))
    _write(old, [_assistant(_say("Counting the posts"))])
    started = _stamped(SID, 1, "2026-10-01T20:27:52.417Z", _human("Count the posts in the background"),
                       _assistant(_use("toolu_ag", "Agent", {"description": "posts", "prompt": "Count the posts.",
                                                             "run_in_background": True})),
                       _result("toolu_ag", "Async agent launched successfully.\nagentId: a1b2c3d4"), END)
    _append(p, lv, started)
    _append(p, lv, _moved(SID, JOB))
    link = project / JOB / "subagents" / "agent-a1b2c3d4.jsonl"
    link.parent.mkdir(parents=True)
    link.symlink_to(old)
    _write(old, [_assistant(_say("8 posts so far"))])
    _write(project / f"{JOB}.jsonl", _copy(started, JOB))
    job = session.current(CORPUS)
    assert job is not None and job.sid == JOB
    session.tail_once(job)
    session.tail_once(job)
    chats = [m for m in agents.list_chats(CORPUS) if m.get("role") == session.SUBAGENT_ROLE]
    assert len(chats) == 1 and [(s.agent_id, s.path) for s in job.subs] == [("a1b2c3d4", link)]
    assert [r["delta"] for r in _log(chats[0]["id"]) if r["type"] == "text"] == ["Counting the posts", "8 posts so far"]


def test_a_copied_record_is_known_by_its_uuid_or_its_time_and_a_session_that_goes_on_is_not_parked(tmp_path):
    """A record of the job's transcript is a copy when the old transcript has its uuid, even stamped later; only a
    record with no uuid is a copy by being stamped no later than the move. A record of the job's own, with a new uuid,
    is not a copy even when stamped in the millisecond of the move. A transcript that ends with the move, queued events
    after it, names the job; once the session writes on after it, it names none."""
    old = tmp_path / f"{SID}.jsonl"
    _write(old, [*_stamped(SID, 1, "2026-10-01T20:26:31.492Z", _human("the board's posts")), *_moved(SID, JOB)])
    assert session._continued_in(str(old)) == (JOB, MOVED_AT)
    lv = session.Live(CORPUS, JOB, "", None, None)
    lv.came_from = {"session": SID, "transcript": str(old), "at": MOVED_AT}
    session._take_copied(lv)
    assert lv.copied is not None
    assert session._copied(lv.copied, {"uuid": "1-0", "timestamp": "2026-10-02T00:00:00.000Z"})
    assert session._copied(lv.copied, {"type": "attachment", "timestamp": "2026-10-01T20:26:31.492Z"})
    assert not session._copied(lv.copied, {"type": "attachment", "timestamp": "2026-10-01T21:17:45.529Z"})
    assert not session._copied(lv.copied, {"uuid": "2-0", "timestamp": "2026-10-01T23:30:03.924Z"})
    assert not session._copied(lv.copied, {"uuid": "2-1", "timestamp": MOVED_AT})
    _write(old, _stamped(SID, 9, "2026-10-02T01:00:00.000Z", _human("back again")))
    assert session._continued_in(str(old)) is None
