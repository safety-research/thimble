"""Several permission requests on the card at once (agent_session, permissions): requests from different agents and from
one agent at the same moment each get the answer given to them; no request waits for good; and a request nothing waits
on any more leaves the card, whether its hook went away, a previous server left it, or its wait ended before the answer.
The sessions are hosted ones (agent_session.host), as the dev agent's are, so no process runs."""
from __future__ import annotations

import asyncio
import json

import pytest
from fastapi import HTTPException

from app import agent_session, agents, config

CORPUS = "mini"


@pytest.fixture(autouse=True)
def _fresh(workspaces_tmp):
    agent_session._runs.clear()
    agent_session._hosted.clear()
    yield
    for key in [k for (c, k) in list(agent_session._hosted)]:
        agent_session.unhost(CORPUS, key)
    agent_session._runs.clear()


def _agent(key: str, role: str = "dev", title: str = "view: Posts", wait_s: float = 600.0, patient: bool = False) -> str:
    chat = str(agents.new_agent(CORPUS, role, title)["id"])
    run = agent_session.host(CORPUS, key, chat, agent="dev", wait_s=wait_s)
    run.patient = patient
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


class Hook:
    """The request of a permission hook as the route takes it, which goes away when `gone` is set."""

    def __init__(self) -> None:
        self.gone = False

    async def is_disconnected(self) -> bool:
        return self.gone


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


async def test_requests_from_one_agent_at_once_are_all_on_its_card_and_each_answer_reaches_its_own():
    chat = _agent("view:a")
    tags = ["one", "two", "three", "four"]
    calls = {t: asyncio.ensure_future(agent_session.hook_request(CORPUS, _body("view:a", t))) for t in tags}
    ps = await _pending(chat, 4)
    by_tag = {json.loads(p["input"])["command"].split()[-1]: p["id"] for p in ps}
    assert sorted(by_tag) == sorted(tags), "none dropped"
    for t, allow in [("three", True), ("one", False), ("four", False), ("two", True)]:
        agent_session.answer(CORPUS, chat, by_tag[t], allow)
        assert (await asyncio.wait_for(calls[t], 5))["behavior"] == ("allow" if allow else "deny"), t
        assert by_tag[t] not in {p["id"] for p in agents.read_meta(CORPUS, chat)["permissions"]}
    assert agents.read_meta(CORPUS, chat)["permissions"] == []


async def test_a_patient_session_s_request_is_declined_unanswered_after_a_while_rather_than_waiting_for_good(monkeypatch):
    monkeypatch.setattr(agent_session, "PATIENT_WAIT_S", 0.2)
    chat = _agent("orient", role="orient", title="Orientation", wait_s=0.05, patient=True)
    call = asyncio.ensure_future(agent_session.hook_request(CORPUS, _body("orient", "venv")))
    [p] = await _pending(chat, 1)
    assert p["wait_s"] == 0.2
    await asyncio.sleep(0.1)
    assert not call.done(), "longer than the minute other sessions get"
    got = await asyncio.wait_for(call, 5)
    assert got == {"behavior": "deny", "message": agent_session.timed_out_line(0.2)}
    [p] = agents.read_meta(CORPUS, chat)["permissions"]
    assert p["expired"], "it stays on the card, declined, until dismissed"
    assert agent_session.answer(CORPUS, chat, p["id"], False)
    assert agents.read_meta(CORPUS, chat)["permissions"] == []


async def test_a_request_whose_hook_went_away_leaves_the_card(monkeypatch):
    monkeypatch.setattr(agent_session, "HOOK_POLL_S", 0.02)
    chat = _agent("view:a")
    hook = Hook()
    call = asyncio.ensure_future(agent_session.permission_request_route(CORPUS, _body("view:a", "gone"), hook))
    other = asyncio.ensure_future(agent_session.permission_request_route(CORPUS, _body("view:a", "stays"), Hook()))
    await _pending(chat, 2)
    hook.gone = True
    assert await asyncio.wait_for(call, 5) == {"behavior": "deny", "message": agent_session.GONE_LINE}
    [left] = agents.read_meta(CORPUS, chat)["permissions"]
    assert "stays" in left["input"], "only the request whose hook went away left"
    assert agent_session.answer(CORPUS, chat, left["id"], True)
    assert (await asyncio.wait_for(other, 5))["behavior"] == "allow"


async def test_a_request_a_previous_server_left_waiting_is_taken_off_at_start_and_by_an_answer(analyst):
    chat = str(agents.new_agent(CORPUS, "dev", "view: Posts")["id"])
    stale = [{"id": f"r{i}", "tool": "Bash", "what": f"echo {i}", "since": "2026-10-01T00:17:11+00:00"} for i in range(3)]
    declined = {"id": "x1", "tool": "Bash", "what": "echo x", "since": "2026-10-01T00:10:00+00:00",
                "expired": "2026-10-01T00:20:00+00:00"}
    agents.update_agent(CORPUS, chat, permissions=[*stale, declined])
    other = str(agents.new_agent(CORPUS, "dev", "view: Board")["id"])
    agents.update_agent(CORPUS, other, permissions=[{"id": "o1", "tool": "Bash", "what": "echo o"}])
    # what a server that restarted under them finds: no session waits on any of them
    with pytest.raises(HTTPException) as e:
        await agent_session.permission_route(CORPUS, other, agent_session.PermissionAnswer(id="o1", allow=True), analyst)
    assert e.value.status_code == 404, "no session hears this answer"
    assert agents.read_meta(CORPUS, other)["permissions"] == [], "yet the request leaves the card"
    await agent_session.recover()
    assert agents.read_meta(CORPUS, chat)["permissions"] == [declined], "a declined one stays until dismissed"
    log = [json.loads(ln) for ln in (config.workspace_dir(CORPUS) / agents.PERMISSIONS_LOG).read_text().splitlines()]
    assert {r["id"] for r in log if r.get("answer") == agent_session.NOBODY_WAITS} == {"o1", "r0", "r1", "r2"}


async def test_a_request_asked_while_the_server_starts_stays_on_the_card():
    chat = _agent("view:a")
    call = asyncio.ensure_future(agent_session.hook_request(CORPUS, _body("view:a", "early")))
    [p] = await _pending(chat, 1)
    await agent_session.recover()
    assert [q["id"] for q in agents.read_meta(CORPUS, chat)["permissions"]] == [p["id"]]
    agent_session.answer(CORPUS, chat, p["id"], True)
    assert (await asyncio.wait_for(call, 5))["behavior"] == "allow"


async def test_main_s_relayed_request_asked_after_a_session_s_is_stamped_after_it():
    from datetime import datetime

    from app import channel

    chat = _agent("view:a")
    call = asyncio.ensure_future(agent_session.hook_request(CORPUS, _body("view:a", "first")))
    [first] = await _pending(chat, 1)
    channel._hold(CORPUS, "main-1", "Bash", "ls", "{}")
    [later] = agents.read_meta(CORPUS, agents.MAIN_ID)["permissions"]
    assert datetime.fromisoformat(later["since"]) >= datetime.fromisoformat(first["since"]), "the card lists it second"
    agent_session.answer(CORPUS, chat, first["id"], True)
    await asyncio.wait_for(call, 5)
