"""Several permission requests on the card at once (agent_session, permissions): requests from different agents and from
one agent at the same moment each get the answer given to them; no request waits for good; and a request nothing waits
on any more leaves the card, whether its hook went away, a previous server left it, or its wait ended before the answer.
The sessions are hosted ones (agent_session.host), as the dev agent's are, so no process runs."""
from __future__ import annotations

import asyncio

import pytest

from app import agent_session, agents

CORPUS = "mini"


@pytest.fixture(autouse=True)
def _fresh(workspaces_tmp):
    agent_session._hosted.clear()
    yield
    for key in [k for (c, k) in list(agent_session._hosted)]:
        agent_session.unhost(CORPUS, key)


def _agent(key: str, role: str = "dev", title: str = "view: Posts") -> str:
    chat = str(agents.new_agent(CORPUS, role, title)["id"])
    agent_session.host(CORPUS, key, chat, agent="dev")
    return chat


def _body(key: str, tag: str, tool: str = "Bash") -> agent_session.PermissionRequestBody:
    inp = {"command": f"echo {tag}", "description": f"Say {tag}"} if tool == "Bash" else {"file_path": f"/tmp/{tag}"}
    sugg = [{"type": "addRules", "rules": [{"toolName": "Bash", "ruleContent": f"echo {tag}:*"}], "behavior": "allow",
             "destination": "session"}]
    return agent_session.PermissionRequestBody(session=key, tool_name=tool, tool_input=inp, suggestions=sugg)


async def _pending(chat: str, n: int) -> list[dict]:
    for _ in range(250):
        ps = agents.read_meta(CORPUS, chat).get("permissions") or []
        if len(ps) >= n:
            return ps
        await asyncio.sleep(0.02)
    raise AssertionError(f"fewer than {n} requests on chat {chat}")


async def test_requests_from_different_agents_at_once_each_get_the_answer_given_to_them():
    keys = ["view:a", "view:b", "view:c", "orient", "critique:orient"]
    chats = {k: _agent(k, title=f"view: {k}") for k in keys}
    calls = {k: asyncio.ensure_future(agent_session.hook_request(CORPUS, _body(k, k))) for k in keys}
    entries = {k: (await _pending(chats[k], 1))[0] for k in keys}
    assert all(not c.done() for c in calls.values()), "every one waits for the analyst"
    plan = {"orient": (True, False), "view:a": (False, False), "critique:orient": (True, True), "view:c": (True, False),
            "view:b": (False, False)}
    for k, (allow, always) in plan.items():
        assert agent_session.answer(CORPUS, chats[k], entries[k]["id"], allow, always)
        got = await asyncio.wait_for(calls[k], 5)
        assert got["behavior"] == ("allow" if allow else "deny"), k
        assert ("updatedPermissions" in got) == always, k
        assert agents.read_meta(CORPUS, chats[k])["permissions"] == [], "the answered request leaves its card"
    assert [p for k in keys for p in agents.read_meta(CORPUS, chats[k])["permissions"]] == []
