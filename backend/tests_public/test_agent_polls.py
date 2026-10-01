"""How often thimble asks `claude agents` about its background sessions, each ask a `claude` process: the watcher
(bg_session) lists every POLL_S only while a session needs following and backs off while every session is idle, and
lists soon after an idle session's transcript grows; a dev ticket's turn (dev._worker_turn) asks for its session's state
only while the transcript is quiet, at gaps that double while the state stays the same."""
from __future__ import annotations

import asyncio
import json
import time
from pathlib import Path

import pytest

from app import bg_session, dev

CORPUS = "mini"
KEY = "writer:report"


@pytest.fixture()
def idle_session(tmp_path, monkeypatch):
    """A session thimble followed earlier, idle now, its transcript a file the test appends to, and `claude agents`
    a fake that records each listing."""
    path = tmp_path / "projects" / "-work" / "ab12cd34-0000.jsonl"
    path.parent.mkdir(parents=True)
    path.write_text("")
    monkeypatch.setattr(bg_session.session, "find_transcript", lambda sid, config_dir=None: str(path))
    monkeypatch.setattr(bg_session, "_closing", False)
    monkeypatch.setattr(bg_session, "_changed", asyncio.Event())
    monkeypatch.setattr(bg_session, "_save", lambda c: None)
    monkeypatch.setattr(bg_session, "POLL_S", 0.05)
    monkeypatch.setattr(bg_session, "IDLE_POLL_S", 0.4)
    e = bg_session.Entry(CORPUS, KEY, bg_session.name_of(CORPUS, KEY), "ab12cd34", "ab12cd34-0000", "chat-1",
                         "writer", "/work/report", started=time.time() - 600, status="idle", run_open=False,
                         proxy_refused=True)
    e.tx_path, e.tx_sid = str(path), e.sid
    monkeypatch.setattr(bg_session, "_loaded", {CORPUS})  # the sessions of other tests are not this one's watcher's
    monkeypatch.setattr(bg_session, "_entries", {(CORPUS, KEY): e})
    listed: list[float] = []
    state = {"status": "idle"}

    def listing(*a):
        listed.append(time.monotonic())
        return [{"id": "ab12cd34", "sessionId": "ab12cd34-0000", "pid": 1, "status": state["status"]}]

    monkeypatch.setattr(bg_session, "listing", listing)
    return e, path, listed, state


async def test_the_watcher_backs_off_while_every_session_is_idle_and_lists_soon_after_a_turn_begins(idle_session):
    e, path, listed, state = idle_session
    task = asyncio.get_running_loop().create_task(bg_session._watch())
    try:
        await asyncio.sleep(1.2)
        idle = len(listed)
        assert 2 <= idle <= 7, f"{idle} listings in 1.2 s with every session idle (24 at a fixed POLL_S)"
        state["status"] = "busy"  # the analyst typed in `claude attach`: the turn's first line is written
        with path.open("a") as f:
            f.write(json.dumps({"type": "user", "message": {"role": "user", "content": "go on"}}) + "\n")
        began = time.monotonic()
        while len(listed) == idle and time.monotonic() - began < 2:
            await asyncio.sleep(0.01)
        assert listed[idle] - began < 0.3
        await asyncio.sleep(0.5)
        assert e.status == "working" and len(listed) - idle >= 6, "a working session is listed every POLL_S"
    finally:
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task


async def test_a_turn_that_begins_while_the_watcher_lists_is_not_missed(idle_session, monkeypatch):
    e, path, listed, state = idle_session
    monkeypatch.setattr(bg_session, "IDLE_POLL_S", 5.0)
    real = bg_session.listing

    def listing(*a):
        rows = real(*a)
        if len(listed) == 5:  # the analyst typed while `claude agents` ran, which still showed the session idle
            with path.open("a") as f:
                f.write(json.dumps({"type": "user", "message": {"role": "user", "content": "go on"}}) + "\n")
        return rows

    monkeypatch.setattr(bg_session, "listing", listing)
    task = asyncio.get_running_loop().create_task(bg_session._watch())
    try:
        began = time.monotonic()
        while len(listed) < 5 and time.monotonic() - began < 5:
            await asyncio.sleep(0.01)
        fifth = listed[4]
        while len(listed) < 6 and time.monotonic() - fifth < 3:
            await asyncio.sleep(0.01)
        assert len(listed) == 6 and listed[5] - fifth < 0.4, "the line written during the listing went unseen"
    finally:
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task


class _Sessions:
    """dev.SESSIONS as a fake: one session, whose state is `state` and whose looks at it are counted."""

    def __init__(self, transcript: Path) -> None:
        self.path, self.now, self.looks = transcript, "working", 0

    async def start(self, cwd, prompt, **kw):
        return {"id": "ab12cd34", "session_id": "ab12cd34-0000"}

    async def state(self, cwd, short):
        self.looks += 1
        return self.now

    def transcript(self, session_id):
        return self.path

    def stop(self, short):
        return None


async def test_a_dev_turn_asks_for_its_session_s_state_only_while_the_transcript_is_quiet(tmp_path, monkeypatch):
    tx = tmp_path / "ab12cd34-0000.jsonl"
    tx.write_text("")
    fake = _Sessions(tx)
    monkeypatch.setattr(dev, "SESSIONS", fake)
    monkeypatch.setattr(dev, "POLL_S", 0.01)
    monkeypatch.setattr(dev, "STATE_GAP_MAX_S", 0.16)
    run = dev.Run("t1", "a ticket", "now")
    turn = asyncio.get_running_loop().create_task(dev._worker_turn(run, dev.Log(None), tmp_path, "do it", None,
                                                                    name="thimble:dev", workspace=None,
                                                                    on_session=lambda a, b: None))
    with tx.open("a") as f:
        for i in range(30):  # the session works: its transcript grows every poll
            f.write(json.dumps({"type": "assistant", "message": {"content": [{"type": "text", "text": f"step {i}"}]}}) + "\n")
            f.flush()
            await asyncio.sleep(0.01)
    assert fake.looks <= 2, "a growing transcript needs no look at `claude agents`"
    before = fake.looks
    await asyncio.sleep(1.0)  # quiet, listed working: the gaps double up to STATE_GAP_MAX_S
    quiet = fake.looks - before
    assert 3 <= quiet <= 12, f"{quiet} looks in 1 s of a quiet transcript (100 at one a poll)"
    fake.now = "idle"
    with tx.open("a") as f:
        f.write(json.dumps({"type": "system", "subtype": "turn_duration"}) + "\n")
    assert await asyncio.wait_for(turn, 2) == "step 29"
