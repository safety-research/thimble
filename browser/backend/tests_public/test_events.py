"""events.py: the one event path from the browser to the analyst's Claude Code session. `main` logs the analyst's line
when it posts and queues the event for the session's watcher, and the shim's subscription waits for the workspace,
attaches the session that is main, and carries no events. The watcher's side is test_delivery.py, the shim's
test_shim.py."""
from __future__ import annotations

import asyncio
import json
import re

import pytest
from conftest import Listener
from fastapi.testclient import TestClient

from app import agents, config, events, session

CORPUS = "mini"


@pytest.fixture(autouse=True)
def _fresh(workspaces_tmp):
    events._subs.clear()
    events._pending.clear()
    session._live.clear()
    session._expected.clear()
    agents._busy.clear()
    yield
    events._subs.clear()
    events._pending.clear()
    session._live.clear()


@pytest.fixture()
def client(workspaces_tmp):
    from app.main import app

    with TestClient(app, base_url="http://127.0.0.1") as c:
        yield c


def _log(chat: str) -> list[dict]:
    _, log_path = agents.paths(CORPUS, chat)
    return agents.read_events(log_path)


# ----------------------------------------------------------------------------- posting


def test_a_browser_message_is_logged_on_main_and_queued_for_the_session(client):
    q = Listener(CORPUS)
    r = client.post(f"/api/ws/{CORPUS}/events", json={"kind": "main", "payload": {"text": "which agent stalled?"}})
    assert r.status_code == 200
    out = r.json()
    assert out["kind"] == "main" and out["delivered"] == 1
    note = q.get_nowait()
    assert (note["content"], note["meta"]) == ("which agent stalled?", {"kind": "main", "event": out["id"]})
    rec = _log(agents.MAIN_ID)[-1]
    assert rec == {**rec, "type": "user", "by": "browser", "text": "which agent stalled?", "event": out["id"]}
    assert out["id"] in session._expected and agents._running(CORPUS, agents.MAIN_ID)


def test_an_event_reaches_only_the_session_that_is_main(client):
    """Another `claude` in the folder subscribes too, and gets none of main's events; with no main, a post is refused."""
    other = events.Sub("0ther000-0000-4000-8000-000000000001")
    events._subs.setdefault(CORPUS, set()).add(other)
    r = client.post(f"/api/ws/{CORPUS}/events", json={"kind": "main", "payload": {"text": "anyone?"}})
    assert r.status_code == 409
    q = Listener(CORPUS)
    assert client.post(f"/api/ws/{CORPUS}/events", json={"kind": "main", "payload": {"text": "hi"}}).status_code == 200
    assert q.get_nowait()["content"] == "hi" and not events._pending.get((CORPUS, other.session))


def test_a_thread_named_in_any_script_asks_main_to_fork_under_a_name_claude_code_accepts(client):
    """Claude Code's Agent refuses a `name` other than ASCII letters, digits, '_' and '-', and then no fork starts."""
    q = Listener(CORPUS)
    r = client.post(f"/api/ws/{CORPUS}/chats", json={"title": "Café マージ担当", "text": "which did agent-04 merge?"})
    assert r.status_code == 201
    assert re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}", q.get_nowait()["meta"]["name"])


# ----------------------------------------------------------------------------- the subscription


def test_the_subscription_waits_for_the_workspace_then_attaches_the_session_that_is_main(client, plugin_headers):
    """404 for a folder that is no workspace yet (the shim retries); a subscription that names a session no /thimble
    named makes no session main, and one that names main's keeps it attached; each gets a `ready` event."""
    r = client.get("/api/events", params={"cwd": "/nowhere/at/all"}, headers=plugin_headers())
    assert r.status_code == 404
    cwd = str(config.corpus_dir(CORPUS))

    class Req:
        async def is_disconnected(self):
            return False

    async def go():
        stray = await events.subscribe(Req(), cwd=cwd, session="s" * 8, pid=42)
        assert events.listening(CORPUS) and session.current(CORPUS) is None, "only /thimble makes a session main"
        await stray.body_iterator.__anext__()
        await stray.body_iterator.aclose()
        session.attach(CORPUS, "m" * 8, cwd)
        resp = await events.subscribe(Req(), cwd=cwd, session="m" * 8, pid=43)
        gen = resp.body_iterator
        first = await gen.__anext__()
        assert events.reachable(CORPUS) and session.current(CORPUS).sid == "m" * 8
        await gen.aclose()
        return first

    first = asyncio.run(go())
    assert first["event"] == "ready" and json.loads(first["data"]) == {"workspace": CORPUS}
    assert not events.listening(CORPUS), "a closed subscription is no longer counted"
