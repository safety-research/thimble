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


async def _until(ok) -> None:
    for _ in range(300):
        if ok():
            return
        await asyncio.sleep(0.01)
    raise AssertionError("the card never got there")


def _request(tool: str, inp: dict, key: str = KEY, **extra) -> "asyncio.Future":
    body = agent_session.PermissionRequestBody(session=key, tool_name=tool, tool_input=inp, **extra)
    return asyncio.ensure_future(agent_session.permission_request_route(CORPUS, body))


async def test_an_unanswered_request_is_denied_after_the_wait_and_its_card_says_so_until_dismissed():
    """A hosted session's request nobody answers is denied after its wait, so the build goes on; the model is told to
    carry on without it, the thread hears of it, and the card keeps it marked denied unanswered until Dismiss or the
    run's end. Requests that joined it are denied with it. An Allow covers the requests that joined the card before it
    was clicked, as many as the card says it listed; a later one is asked on its own."""
    chat = _chat()
    heard: list[dict] = []
    run = agent_session.host(CORPUS, KEY, chat, agent="views", wait_s=0.1, on_expired=lambda run, entry: heard.append(entry))
    one = _request("WebFetch", PAGE)
    await _waiting(chat)
    two = _request("WebFetch", OTHER_PAGE)
    long = _request("WebFetch", {"url": f"{PAGE['url']}?q={'x' * agent_session.ALSO_CHARS}"})
    [first, own] = await _waiting(chat, 2)
    assert first["also"] == [OTHER_PAGE["url"]] and "also" not in own, "a call the card cannot list whole asks on its own"
    denied = {"behavior": "deny", "message": agent_session.timed_out_line(0.1)}
    assert await one == denied and await two == denied and await long == denied
    assert agent_session.answer(CORPUS, chat, own["id"], False)
    [p] = _card(chat)
    assert p["expired"] and p["what"] == PAGE["url"] and [e["what"] for e in heard][0] == PAGE["url"]
    assert not agent_session.asking(CORPUS, KEY)
    assert agent_session.answer(CORPUS, chat, p["id"], False) and _card(chat) == []
    assert not agent_session.answer(CORPUS, chat, p["id"], False)
    log = [json.loads(ln) for ln in (config.workspace_dir(CORPUS) / agents.PERMISSIONS_LOG).read_text().splitlines()]
    assert log[-1]["answer"] == "deny: nobody answered in time"
    run.wait_s = 10  # a request still waiting when its session ends, however slowly the test runs
    waiting = _request("Bash", {"command": "curl example.org"})
    await _waiting(chat)
    assert agent_session.asking(CORPUS, KEY)
    agent_session.unhost(CORPUS, KEY)

    chat, key, late = _chat("view: Other"), "view:other", {"url": f"{PAGE['url']}?late"}
    agent_session.host(CORPUS, key, chat, agent="views", wait_s=10)
    one = _request("WebFetch", PAGE, key=key)
    [first] = await _waiting(chat)
    two = _request("WebFetch", OTHER_PAGE, key=key)
    three = _request("WebFetch", late, key=key)
    await _until(lambda: len(_card(chat)[0].get("also") or []) == 2)
    assert agent_session.answer(CORPUS, chat, first["id"], True, shown=1)
    assert (await one)["behavior"] == (await two)["behavior"] == "allow"
    await _until(lambda: [p for p in _card(chat) if p["id"] != first["id"]])
    [own] = _card(chat)
    assert own["what"] == late["url"] and not three.done(), "the call the card had not listed asks on its own"
    assert agent_session.answer(CORPUS, chat, own["id"], False)
    assert (await three)["behavior"] == "deny"
    agent_session.unhost(CORPUS, key)
    assert await waiting == {"behavior": "deny", "message": agent_session.GONE_LINE}
    assert _card(chat) == [] and await _request("Bash", {"command": "ls"}) == {"behavior": "deny", "message": agent_session.GONE_LINE}
    assert agent_session.web_rule("WebFetch", {"url": "https://evil.example\\@docs.python.org/"}) is None, \
        "Claude Code would fetch evil.example"


def test_a_kept_web_rule_lives_where_a_kernel_cannot_write_it():
    """The analyst's "don't ask again" for a site is kept in the workspace's registry folder, which a kernel's cells
    may only read, and a web_rules.json a cell writes beside it is not read."""
    from app import kernel_wrap

    agent_session.keep_web_rule(CORPUS, "WebFetch(domain:vega.github.io)")
    kept = config.registry_dir(CORPUS) / agent_session.WEB_RULES_FILE
    assert json.loads(kept.read_text())["allow"] == ["WebFetch(domain:vega.github.io)"]
    assert kernel_wrap.REGISTRY_DIR in kernel_wrap.READ_ONLY_DIRS and kept.parent.name == kernel_wrap.REGISTRY_DIR
    (config.workspace_dir(CORPUS) / agent_session.WEB_RULES_FILE).write_text(json.dumps({"allow": ["WebSearch"]}))
    assert agent_session.web_rules(CORPUS) == ["WebFetch(domain:vega.github.io)"]
