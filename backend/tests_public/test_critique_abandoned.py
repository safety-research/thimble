"""A critique nobody waits for any more is stopped (critique_session.tool_critique, tools.until_dropped). The orientation
waits for the critic's report inside one tool call; when that call goes away (Claude Code aborts it and the shim drops
its request, the orientation's session is stopped, or the server stops), the coverage checks' child process and the
critic's session end with it, and the next critique is not refused as one that still runs.

The critic and the orientation are the stand-in CLI of test_agent_sessions, which sleeps; the checks' child is a
process that writes its pid and waits."""
from __future__ import annotations

import asyncio
import json
import os
import sys
import time

import pytest
from test_agent_sessions import CORPUS, fake  # noqa: F401 — the stand-in CLI fixture, used by name

from app import agent_session, agents, channel, critique_session, orient_checks, orient_session, session, tools
from app.main import create_app

CRITIC = critique_session.session_key(orient_session.KEY)


@pytest.fixture(autouse=True)
async def _fresh(workspaces_tmp):
    session._live.clear()
    session._expected.clear()
    channel._subs.clear()
    agent_session._runs.clear()
    yield
    await agent_session.shutdown()  # every process a test started goes, whatever the test left running
    channel._subs.clear()
    agent_session._runs.clear()


async def _until(pred, timeout: float = 20.0, what: str = "the condition"):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        got = pred()
        if got:
            return got
        await asyncio.sleep(0.05)
    raise AssertionError(f"{what} did not happen within {timeout:.0f} s")


def _gone(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return True
    return False


def _critic_running() -> agent_session.Run | None:
    run = agent_session.current(CORPUS, CRITIC)
    return run if run is not None and run.pid else None


async def _orientation(monkeypatch) -> agent_session.Run:
    monkeypatch.setenv("FAKE_MODE", "sleep")
    run = await orient_session.start(CORPUS, "")
    await _until(lambda: orient_session.current(CORPUS), what="the orientation's start")
    return run


def _critique_call() -> asyncio.Task:
    return asyncio.ensure_future(tools.call(CORPUS, "critique", {"context": "the runs by task"}, session=orient_session.KEY))


# --------------------------------------------------------------------------- the route


async def test_a_dropped_call_is_cancelled_and_its_cleanup_runs():
    cleaned: list[str] = []

    async def work() -> tools.ToolResult:
        try:
            await asyncio.sleep(60)
        finally:
            cleaned.append("cleanup")
        return tools.ok("never")

    async def receive() -> dict:
        await asyncio.sleep(0.1)
        return {"type": "http.disconnect"}

    t0 = time.monotonic()
    assert await tools.until_dropped(receive, work(), "critique") is None
    assert cleaned == ["cleanup"] and time.monotonic() - t0 < 5


async def test_a_call_whose_caller_waits_returns_its_result():
    async def receive() -> dict:
        await asyncio.sleep(60)
        return {"type": "http.disconnect"}

    res = await tools.until_dropped(receive, asyncio.sleep(0.05, result=tools.ok("the report")), "critique")
    assert res is not None and res.text == "the report"


async def test_the_route_cancels_a_critique_whose_shim_drops_the_request(monkeypatch):
    """Through the whole app, as the shim posts it: the request's body arrives, then the connection closes, and the
    critique's handler is cancelled rather than left to run for nobody."""
    state: dict[str, bool] = {}

    async def handler(ctx, args):
        state["started"] = True
        try:
            await asyncio.sleep(60)
        except asyncio.CancelledError:
            state["cancelled"] = True
            raise
        return tools.ok("never")

    monkeypatch.setattr(critique_session, "tool_critique", handler)
    body = json.dumps({"workspace": CORPUS, "args": {"context": "x"}, "session": orient_session.KEY}).encode()
    sent: list[dict] = []
    first = [True]

    async def receive() -> dict:
        if first[0]:
            first[0] = False
            return {"type": "http.request", "body": body, "more_body": False}
        while not state.get("started"):
            await asyncio.sleep(0.02)
        await asyncio.sleep(0.1)
        return {"type": "http.disconnect"}

    async def send(message: dict) -> None:
        sent.append(message)

    scope = {"type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": "POST", "scheme": "http",
             "path": "/api/tools/critique", "raw_path": b"/api/tools/critique", "query_string": b"", "root_path": "",
             "headers": [(b"host", b"test"), (b"content-type", b"application/json"),
                         (b"content-length", str(len(body)).encode())],
             "client": ("127.0.0.1", 5000), "server": ("127.0.0.1", 80)}
    await asyncio.wait_for(create_app()(scope, receive, send), 10)
    assert state == {"started": True, "cancelled": True}


# --------------------------------------------------------------------------- the critique


async def test_a_cancelled_critique_stops_the_critic_and_the_next_one_starts(fake, monkeypatch):  # noqa: F811
    await _orientation(monkeypatch)
    call = _critique_call()
    critic = await _until(_critic_running, what="the critic's start")
    pid, chat = critic.pid, critic.chat
    call.cancel()
    with pytest.raises(asyncio.CancelledError):
        await call
    assert agent_session.current(CORPUS, CRITIC) is None, "no critique runs any more"
    with pytest.raises(ProcessLookupError):
        os.killpg(pid, 0)  # the critic's process group is gone
    assert agents.read_meta(CORPUS, chat)["status"] == "stopped"
    again = _critique_call()
    second = await _until(_critic_running, what="the second critique's start")
    assert second.pid != pid, "the next call is not refused as a critique that still runs"
    again.cancel()
    with pytest.raises(asyncio.CancelledError):
        await again
    assert _gone(second.pid)


async def test_a_critique_cancelled_during_its_coverage_checks_kills_their_child(fake, monkeypatch, tmp_path):  # noqa: F811
    pidfile = tmp_path / "checks.pid"
    code = f"import os, pathlib, time; pathlib.Path({str(pidfile)!r}).write_text(str(os.getpid())); time.sleep(60)"
    monkeypatch.setattr(orient_checks, "child_argv", lambda c: [sys.executable, "-c", code])
    await _orientation(monkeypatch)
    call = _critique_call()
    child = int(await _until(lambda: pidfile.is_file() and pidfile.read_text().strip(), what="the checks' child"))
    assert not _gone(child)
    call.cancel()
    with pytest.raises(asyncio.CancelledError):
        await call
    assert _gone(child), "the checks' child was killed with the critique"
    assert agent_session.current(CORPUS, CRITIC) is None, "no critic session was started"


async def test_the_orientation_s_stop_stops_its_critique(fake, monkeypatch):  # noqa: F811
    await _orientation(monkeypatch)
    call = _critique_call()
    critic = await _until(_critic_running, what="the critic's start")
    assert await orient_session.stop(CORPUS)
    res = await asyncio.wait_for(call, 30)
    assert res.is_error and tools.hint("critique-ended", status="stopped", text="nothing") in res.text
    assert agent_session.current(CORPUS, CRITIC) is None
    with pytest.raises(ProcessLookupError):
        os.killpg(critic.pid, 0)
