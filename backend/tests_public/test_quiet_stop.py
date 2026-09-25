"""A server that begins to stop ends its open requests itself, so a stop or restart logs no error. The watcher's long
poll answers 204 at once and the permission hook's request lets Claude Code's own prompt decide, rather than holding
the stop until uvicorn cancels them with a traceback; an event stream sse_starlette cancels gets its last message
(main.CompleteStreams), so uvicorn does not log it as an incomplete response."""
from __future__ import annotations

import asyncio
import time

import pytest
from sse_starlette.sse import AppStatus
from test_delivery import CORPUS, SID, Req, _cwd, _fresh, _subscribe  # noqa: F401 — the fixture, used by name

from app import cc_channel, channel, main, session


@pytest.fixture()
def stopping():
    """The flag sse_starlette sets when uvicorn begins to stop, which session._shutting_down reads."""
    AppStatus.should_exit = True
    try:
        yield
    finally:
        AppStatus.should_exit = False


def test_a_long_poll_answers_at_once_when_the_server_stops(stopping):
    _subscribe(SID, cc_channel.HOOK)
    session.attach(CORPUS, SID, _cwd(), None)
    t0 = time.monotonic()
    got = asyncio.run(channel.pull_route(Req(), cwd=_cwd(), session=SID, wait=20))
    assert got.status_code == 204 and time.monotonic() - t0 < 1.0


def test_a_relayed_permission_prompt_goes_back_to_claude_code_when_the_server_stops():
    _subscribe(SID, cc_channel.HOOK)
    session.attach(CORPUS, SID, _cwd(), None)
    body = channel.HookPermission(cwd=_cwd(), session=SID, tool_name="Bash", tool_input={"command": "ls"})

    async def go():
        task = asyncio.create_task(channel.hook_permission_route(Req(), body))
        await asyncio.sleep(0.2)
        AppStatus.should_exit = True
        try:
            return await asyncio.wait_for(task, 5)
        finally:
            AppStatus.should_exit = False

    got = asyncio.run(go())
    assert got["behavior"] is None


def _run(app, stop: bool) -> list[dict]:
    sent: list[dict] = []

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message):
        sent.append(message)

    AppStatus.should_exit = stop
    try:
        asyncio.run(main.CompleteStreams(app)({"type": "http", "path": "/api/ws/x/events"}, receive, send))
    finally:
        AppStatus.should_exit = False
    return sent


async def _cut_stream(scope, receive, send):
    """A stream that ends without its last message, as a cancelled event stream does."""
    await send({"type": "http.response.start", "status": 200, "headers": []})
    await send({"type": "http.response.body", "body": b"data: {}\n\n", "more_body": True})


def test_a_stream_cut_off_by_the_stop_is_completed_and_one_cut_off_otherwise_is_not():
    closed = _run(_cut_stream, stop=True)
    assert closed[-1] == {"type": "http.response.body", "body": b"", "more_body": False}
    assert _run(_cut_stream, stop=False)[-1]["more_body"] is True, "outside a stop uvicorn still reports it"
