"""The dev agent's permission requests (agent_session, dev.py, permissions): a dev session's request shows on the card
and is denied after dev.PERMISSION_WAIT_S unanswered."""
from __future__ import annotations

import asyncio
import json

import pytest

from app import agent_session, agents, config

CORPUS = "mini"
KEY = "view:posts"
PAGE = {"url": "https://vega.github.io/vega-lite/docs/bar.html", "prompt": "What does a bar mark take?"}
OTHER_PAGE = {"url": "https://vega.github.io/vega-lite/docs/line.html", "prompt": "And a line mark?"}


@pytest.fixture(autouse=True)
def _fresh(workspaces_tmp):
    agent_session._runs.clear()
    agent_session._hosted.clear()
    yield
    agent_session._runs.clear()
    agent_session._hosted.clear()


def _chat(title: str = "view: Posts") -> str:
    return str(agents.new_agent(CORPUS, "dev", title, view="posts")["id"])


def _card(chat: str) -> list[dict]:
    return agents.read_meta(CORPUS, chat).get("permissions") or []


async def _waiting(chat: str, n: int = 1) -> list[dict]:
    for _ in range(200):
        live = [p for p in _card(chat) if not p.get("expired")]
        if len(live) >= n:
            return live
        await asyncio.sleep(0.01)
    raise AssertionError(f"no {n} request(s) on the card: {_card(chat)}")


def _request(tool: str, inp: dict, key: str = KEY, **extra) -> "asyncio.Future":
    body = agent_session.PermissionRequestBody(session=key, tool_name=tool, tool_input=inp, **extra)
    return asyncio.ensure_future(agent_session.permission_request_route(CORPUS, body))


async def test_an_unanswered_request_is_denied_after_the_wait_and_its_card_says_so_until_dismissed():
    """A hosted session's request nobody answers is denied after its wait, so the build goes on; the model is told to
    carry on without it, the thread hears of it, and the card keeps it marked denied unanswered until Dismiss or the
    run's end. Requests that joined it are denied with it."""
    chat = _chat()
    heard: list[dict] = []
    agent_session.host(CORPUS, KEY, chat, mode="manual", wait_s=0.1, on_expired=lambda run, entry: heard.append(entry))
    one = _request("WebFetch", PAGE)
    await _waiting(chat)
    two = _request("WebFetch", OTHER_PAGE)
    denied = {"behavior": "deny", "message": agent_session.timed_out_line(0.1)}
    assert await one == denied and await two == denied
    assert "Carry on without it" in denied["message"]
    [p] = _card(chat)
    assert p["expired"] and p["what"] == PAGE["url"] and [e["what"] for e in heard] == [PAGE["url"]]
    assert not agent_session.asking(CORPUS, KEY)
    assert agent_session.answer(CORPUS, chat, p["id"], False) and _card(chat) == []
    assert not agent_session.answer(CORPUS, chat, p["id"], False)
    log = [json.loads(ln) for ln in (config.workspace_dir(CORPUS) / agents.PERMISSIONS_LOG).read_text().splitlines()]
    assert log[-1]["answer"] == "deny: nobody answered in time"
    waiting = _request("Bash", {"command": "curl example.org"})
    await _waiting(chat)
    assert agent_session.asking(CORPUS, KEY)
    agent_session.unhost(CORPUS, KEY)
    assert await waiting == {"behavior": "deny", "message": agent_session.GONE_LINE}
    assert _card(chat) == [] and await _request("Bash", {"command": "ls"}) == {"behavior": "deny", "message": agent_session.GONE_LINE}
