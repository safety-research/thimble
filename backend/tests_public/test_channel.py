"""channel.py: the one event path from the browser to the analyst's Claude Code session. `main` logs the analyst's line
when it posts, and the shim's subscription waits for the workspace, attaches and delivers each event as {content, meta}.
The shim's side is test_shim_channel.py."""
from __future__ import annotations

import asyncio
import json

import pytest
from fastapi.testclient import TestClient

from app import agents, channel, config, session

CORPUS = "mini"


@pytest.fixture(autouse=True)
def _fresh(workspaces_tmp):
    channel._subs.clear()
    session._live.clear()
    session._expected.clear()
    agents._busy.clear()
    yield
    channel._subs.clear()
    session._live.clear()


@pytest.fixture()
def client(workspaces_tmp):
    from app.main import app

    with TestClient(app, base_url="http://127.0.0.1") as c:
        yield c


def _listen() -> asyncio.Queue:
    q: asyncio.Queue = asyncio.Queue()
    channel._subs.setdefault(CORPUS, set()).add(q)
    return q


def _log(chat: str) -> list[dict]:
    _, log_path = agents.paths(CORPUS, chat)
    return agents.read_events(log_path)


# ----------------------------------------------------------------------------- posting


def test_a_browser_message_is_logged_on_main_and_published_to_the_session(client):
    q = _listen()
    r = client.post(f"/api/ws/{CORPUS}/events", json={"kind": "main", "payload": {"text": "which agent stalled?"}})
    assert r.status_code == 200
    out = r.json()
    assert out["kind"] == "main" and out["delivered"] == 1
    note = q.get_nowait()
    assert note == {"content": "which agent stalled?", "meta": {"kind": "main", "event": out["id"]}}
    rec = _log(agents.MAIN_ID)[-1]
    assert rec == {**rec, "type": "user", "by": "browser", "text": "which agent stalled?", "event": out["id"]}
    assert out["id"] in session._expected and agents._running(CORPUS, agents.MAIN_ID)


# ----------------------------------------------------------------------------- the subscription


def test_the_subscription_waits_for_the_workspace_then_attaches_and_streams_events(client, plugin_headers):
    """404 for a folder that is no workspace yet (the shim retries); a subscription names the session, which is then
    main, and gets a `ready` event and then each event as {content, meta}."""
    r = client.get("/api/channel", params={"cwd": "/nowhere/at/all"}, headers=plugin_headers())
    assert r.status_code == 404
    cwd = str(config.corpus_dir(CORPUS))

    async def go():
        from app import channel as ch

        class Req:
            async def is_disconnected(self):
                return False

        resp = await ch.subscribe(Req(), cwd=cwd, session="s" * 8, pid=42)
        assert ch.listening(CORPUS) and session.current(CORPUS).sid == "s" * 8
        gen = resp.body_iterator
        first = await gen.__anext__()
        ch.post(CORPUS, "main", {"text": "hello"})
        second = await gen.__anext__()
        await gen.aclose()
        return first, second

    first, second = asyncio.run(go())
    assert first["event"] == "ready" and json.loads(first["data"]) == {"workspace": CORPUS}
    assert second["event"] == "channel" and json.loads(second["data"])["content"] == "hello"
    assert not channel.listening(CORPUS), "a closed subscription is no longer counted"
