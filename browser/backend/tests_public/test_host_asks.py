"""On Claude Code sign-in, a command's request to a host the analyst's Claude Code settings do not allow asks the
analyst in the chat (host_asks.py), as Claude Code asks in the terminal in its default mode, where before the session's
`dontAsk` refused it unasked: the session runs in the default mode with a permission callback (runtime_cc.options),
Claude Code's sandbox hands the callback its ask as the tool SandboxNetworkAccess, the ask waits on the chat of the
agent that made the request while the callback waits, and the analyst's choice answers it: once, always (kept for the
workspace, so the next session allows the host in its settings and asks nothing), or deny. The Agent SDK is not
started: the callbacks are called as Claude Code calls them."""
from __future__ import annotations

import asyncio
import uuid
from typing import Any

import httpx
import pytest
from claude_agent_sdk import PermissionResultAllow, PermissionResultDeny, ToolPermissionContext
from fastapi import FastAPI

from app import agents, claude_access, host_asks, runtime, runtime_cc
from test_runtime import CORPUS, fake_sdk, on  # noqa: F401 — `on` is a fixture

HOST = "data.example-lab.test"


@pytest.fixture()
async def cc(on, monkeypatch):  # noqa: F811 — the fixture imported above
    """Claude Code sign-in, with its Bash sandbox, in workspace `mini`; main's options as a turn builds them."""
    monkeypatch.setenv("THIMBLE_SANDBOX", "1")
    fake_sdk(monkeypatch, [], {})
    claude_access.save(claude_access.CLAUDE_CODE, consent=True)
    sp = runtime.ensure(CORPUS)
    agents.ensure_main(CORPUS)
    host_asks._waits.clear()
    yield sp
    host_asks._waits.clear()


@pytest.fixture()
async def api():
    """The routes the page reads the chats from and answers an ask with."""
    app = FastAPI()
    app.include_router(agents.router, prefix="/api")
    app.include_router(host_asks.router, prefix="/api")
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
        yield c


def options(conv: runtime.Conv) -> Any:
    return runtime_cc.options(conv, conv.spec(), {})


def network_ask(opts: Any, host: str = HOST) -> asyncio.Task:
    """Claude Code's sandbox asking the session's callback about `host`, as it does over can_use_tool: the host alone,
    under a new id that is no tool call's."""
    ctx = ToolPermissionContext(tool_use_id=str(uuid.uuid4()))
    return asyncio.ensure_future(opts.can_use_tool(host_asks.TOOL, {"host": host}, ctx))


async def asks_on(api: httpx.AsyncClient, chat: str) -> list[dict[str, Any]]:
    """The asks the page reads on `chat`: its meta from the chat's route, as the chat list has it too."""
    r = await api.get(f"/api/ws/{CORPUS}/chats/{chat}")
    assert r.status_code == 200, r.text
    listed = next(m for m in (await api.get(f"/api/ws/{CORPUS}/chats")).json() if m["id"] == chat)
    got = r.json()["meta"].get(host_asks.KEY) or []
    assert (listed.get(host_asks.KEY) or []) == got
    return got


async def shown(api: httpx.AsyncClient, chat: str, n: int = 1) -> list[dict[str, Any]]:
    """The asks the page reads on `chat` once `n` show; none is written into the chat's meta file, so none outlives
    this process."""
    for _ in range(200):
        got = await asks_on(api, chat)
        if len(got) >= n:
            assert host_asks.KEY not in agents.read_meta(CORPUS, chat)
            return got
        await asyncio.sleep(0.01)
    raise AssertionError(f"no ask showed on {chat}")


async def test_a_new_host_asks_in_main_s_chat_and_the_command_waits_for_the_answer(cc, api):
    """A command's request to a new host asks the analyst in main's chat and waits for the answer: Allow once lets it
    through, Deny refuses it, and neither keeps the host for the workspace."""
    opts = options(cc.main)
    assert opts.permission_mode == "default" and opts.can_use_tool is not None
    task = network_ask(opts)
    ask = (await shown(api, "main"))[0]
    assert ask["host"] == HOST and ask["id"]
    await asyncio.sleep(0.05)
    assert not task.done(), "the command waits while the analyst has not answered"
    r = await api.post(f"/api/ws/{CORPUS}/host-asks/{ask['id']}", json={"choice": "once"})
    assert r.status_code == 200, r.text
    assert isinstance(await task, PermissionResultAllow)
    assert await asks_on(api, "main") == [] and host_asks.kept(CORPUS) == []

    # the next request asks again, and Deny refuses it
    task = network_ask(options(cc.main))
    ask = (await shown(api, "main"))[0]
    assert (await api.post(f"/api/ws/{CORPUS}/host-asks/{ask['id']}", json={"choice": "deny"})).status_code == 200
    assert isinstance(await task, PermissionResultDeny)
    assert await asks_on(api, "main") == [] and host_asks.kept(CORPUS) == []
