"""On Claude Code sign-in, a command's request to a host the analyst's Claude Code settings do not allow asks the
analyst in the chat (host_asks.py), as Claude Code asks in the terminal in its default mode, where before the session's
`dontAsk` refused it unasked: the session runs in the default mode with a permission callback (runtime_cc.options),
Claude Code's sandbox hands the callback its ask as the tool SandboxNetworkAccess, the ask waits on the chat of the
agent that made the request while the callback waits, and the analyst's choice answers it: once, always (kept for the
workspace, so the next session allows the host in its settings and asks nothing), or deny. Every other ask is refused
at once, as don't ask mode refused it. Claude Code's ask names the host alone, under an id of its own, so the ask
carries the session's Bash call that runs, which Claude Code's hooks tell the session. The Agent SDK is not started:
the callbacks are called as Claude Code calls them. Main's prompt says so (test_prompts.py)."""
from __future__ import annotations

import asyncio
import http.server
import json
import threading
import uuid
from typing import Any

import httpx
import pytest
from claude_agent_sdk import PermissionResultAllow, PermissionResultDeny, ToolPermissionContext
from fastapi import FastAPI

from app import agents, claude_access, events, host_asks, ledger, llm, runtime, runtime_cc, runtime_tools, session
from tests_public.test_runtime import CORPUS, FakeClient, call, fake_sdk, main_turn, on, text  # noqa: F401 — fixtures

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


async def bash(opts: Any, event: str, tool_use_id: str, **tool_input: str) -> None:
    """Claude Code's hook `event` on a Bash call of the session: PreToolUse before its command runs (with its input),
    PostToolUse or PostToolUseFailure once it ended."""
    inp = {"hook_event_name": event, "tool_name": "Bash", **({"tool_input": tool_input} if tool_input else {})}
    await opts.hooks[event][0].hooks[0](inp, tool_use_id, {"signal": None})


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
    assert await asks_on(api, "main") == [], "the ask leaves the chat once answered"
    assert host_asks.kept(CORPUS) == [], "once is for this session alone"
    again = await api.post(f"/api/ws/{CORPUS}/host-asks/{ask['id']}", json={"choice": "once"})
    assert again.status_code == 404
    bad = await api.post(f"/api/ws/{CORPUS}/host-asks/{ask['id']}", json={"choice": "sometimes"})
    assert bad.status_code == 400

    # the next session asks again
    task = network_ask(options(cc.main))
    assert (await shown(api, "main"))[0]["host"] == HOST
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task


async def test_the_ask_carries_the_command_that_runs_with_claude_s_description_of_it(cc, api):
    opts = options(cc.main)
    curl, what = f"curl -sS -m 30 -o runs.json https://{HOST}/api/runs", "Fetch the runs from the lab's API"
    await bash(opts, "PreToolUse", "toolu_ls", command="ls runs", description="List the runs")
    await bash(opts, "PostToolUse", "toolu_ls")
    await bash(opts, "PreToolUse", "toolu_curl", command=curl, description=what)
    task = network_ask(opts)
    ask = (await shown(api, "main"))[0]
    assert ask["call"] == {"tool": "Bash", "input": {"command": curl, "description": what}}
    await api.post(f"/api/ws/{CORPUS}/host-asks/{ask['id']}", json={"choice": "deny"})
    assert isinstance(await task, PermissionResultDeny)
    await bash(opts, "PostToolUseFailure", "toolu_curl")  # refused, the command failed

    # a command with no description: the command alone
    await bash(opts, "PreToolUse", "toolu_bare", command=curl)
    task = network_ask(opts)
    assert (await shown(api, "main"))[0]["call"] == {"tool": "Bash", "input": {"command": curl}}
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    await bash(opts, "PostToolUse", "toolu_bare")

    # no Bash call runs (a command left running in the background asks): the host alone
    task = network_ask(opts)
    assert "call" not in (await shown(api, "main"))[0]
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task


async def test_a_denied_host_is_refused_and_nothing_is_kept(cc, api):
    task = network_ask(options(cc.main))
    ask = (await shown(api, "main"))[0]
    r = await api.post(f"/api/ws/{CORPUS}/host-asks/{ask['id']}", json={"choice": "deny"})
    assert r.status_code == 200
    got = await task
    assert isinstance(got, PermissionResultDeny) and got.message == "", "Claude Code's proxy says user denied itself"
    assert await asks_on(api, "main") == [] and host_asks.kept(CORPUS) == []
    settings = json.loads(options(cc.main).settings)
    assert host_asks.rule(HOST) not in settings["permissions"]["allow"]


async def test_always_allow_keeps_the_host_for_the_workspace_and_answers_every_ask_for_it(cc, api):
    opts = options(cc.main)
    first, second = network_ask(opts), network_ask(opts)
    asks = await shown(api, "main", 2)
    r = await api.post(f"/api/ws/{CORPUS}/host-asks/{asks[0]['id']}", json={"choice": "always"})
    assert r.status_code == 200
    assert isinstance(await first, PermissionResultAllow) and isinstance(await second, PermissionResultAllow)
    assert host_asks.kept(CORPUS) == [host_asks.rule(HOST)]

    # remembered: the next session's sandbox reaches the host unasked, and an ask for it is answered at once
    later = options(cc.main)
    assert host_asks.rule(HOST) in json.loads(later.settings)["permissions"]["allow"]
    assert isinstance(await asyncio.wait_for(network_ask(later), 2), PermissionResultAllow)
    assert await asks_on(api, "main") == []
    # another host still asks
    other = network_ask(later, "other.example-lab.test")
    assert (await shown(api, "main"))[0]["host"] == "other.example-lab.test"
    other.cancel()
    with pytest.raises(asyncio.CancelledError):
        await other


async def test_a_thread_s_ask_waits_on_its_thread_and_one_with_no_chat_is_refused(cc, api, monkeypatch):
    thread = agents.new_thread(CORPUS, None, None, "why")["id"]
    fork = runtime.Conv(cc, "f1", "fork", agent_id="f1", base=runtime.MAIN)
    monkeypatch.setattr(session, "chat_of_agent", lambda c, agent_id: thread if agent_id == "f1" else None)
    task = network_ask(options(fork))
    ask = (await shown(api, thread))[0]
    assert await asks_on(api, "main") == []
    await api.post(f"/api/ws/{CORPUS}/host-asks/{ask['id']}", json={"choice": "once"})
    assert isinstance(await task, PermissionResultAllow)

    lost = runtime.Conv(cc, "a9", "agent", agent_id="a9", role="writer")
    assert isinstance(await asyncio.wait_for(network_ask(options(lost)), 2), PermissionResultDeny)
    assert isinstance(await asyncio.wait_for(network_ask(options(cc.main), "bad host!"), 2), PermissionResultDeny)


async def test_an_ask_whose_session_ends_leaves_its_chat(cc, api):
    task = network_ask(options(cc.main))
    ask = (await shown(api, "main"))[0]
    task.cancel()  # the turn ended or stopped, and the Agent SDK cancels the callback with the session
    with pytest.raises(asyncio.CancelledError):
        await task
    assert await asks_on(api, "main") == []
    r = await api.post(f"/api/ws/{CORPUS}/host-asks/{ask['id']}", json={"choice": "once"})
    assert r.status_code == 404


async def test_every_other_ask_is_refused_at_once_as_don_t_ask_mode_refused_it(cc, api):
    opts = options(cc.main)
    got = await asyncio.wait_for(opts.can_use_tool("Write", {"file_path": "/elsewhere/x", "content": "x"},
                                                   ToolPermissionContext()), 2)
    assert isinstance(got, PermissionResultDeny)
    assert got.message == runtime_cc.REFUSED.format(tool="Write")
    assert got.message.startswith("Permission to use Write has been denied because Claude Code is running in don't ask")
    assert await asks_on(api, "main") == [], "nothing else asks the analyst"


async def test_settings_say_where_main_s_network_reaches(cc):
    assert ledger.agent_rows(CORPUS)["main"]["network"] == "ask"
    claude_access.save(claude_access.API_KEY, key="sk-ant-test-key")
    assert ledger.agent_rows(CORPUS)["main"]["network"] == "on"


def _asked(monkeypatch) -> list[str]:
    """The hosts host_asks asks the analyst about, each refused at once."""
    seen: list[str] = []

    async def ask(c: str, chat: Any, host: str, running: Any = None) -> bool:
        seen.append(host)
        return False

    monkeypatch.setattr(host_asks, "ask", ask)
    return seen


def _permissions(prompt: str) -> str:
    return prompt.split("## Permission requests", 1)[1].split("\n## ", 1)[0]


async def test_main_s_prompt_on_claude_code_sign_in_says_a_bash_command_s_new_host_asks_and_nothing_else_does(
        cc, monkeypatch):
    """On Claude Code sign-in a Bash command's request to a new host asks the analyst (host_asks), while web fetches and
    searches are allowed tools, which never reach the callback that asks; main's prompt says so, as Settings' row for
    main does."""
    asked = _asked(monkeypatch)
    opts = options(cc.main)
    said = _permissions(opts.system_prompt)
    assert events.NETWORK["ask"] in said and ledger.agent_rows(CORPUS)["main"]["network"] == "ask"
    assert isinstance(await asyncio.wait_for(network_ask(opts), 2), PermissionResultDeny) and asked == [HOST]
    assert {"WebFetch", "WebSearch"} <= set(opts.allowed_tools)


async def test_main_s_prompt_with_an_api_key_says_no_request_to_a_host_asks_as_its_bash_reaches_one_unasked(
        on, monkeypatch):
    """With an API key or WIF main's Bash runs in the sandbox runtime with the host's network, and nothing asks the
    analyst before a request reaches a host: main's prompt said a request to a host the analyst had not allowed asks
    them first, and in the same turn a command reached such a host unasked. It says now that nothing asks, as Settings'
    row for main does."""
    if why := runtime_tools.sandbox_reason():
        pytest.skip(why)
    hits: list[str] = []

    class Recorder(http.server.BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802 — the handler's name
            hits.append(self.path)
            self.send_response(200)
            self.send_header("Content-Length", "2")
            self.end_headers()
            self.wfile.write(b"ok")

        def log_message(self, *a: Any) -> None:
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Recorder)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    asked = _asked(monkeypatch)
    claude_access.save(claude_access.API_KEY, key="sk-ant-test-key")
    client = FakeClient([call("Bash", {"command": f"curl -sS -m 20 http://127.0.0.1:{server.server_address[1]}/rows"}),
                         text("Done.")])
    monkeypatch.setattr(llm, "client", lambda: client)
    try:
        await main_turn("Fetch the rows from my server.")
    finally:
        server.shutdown()
        server.server_close()
    said = _permissions(client.bodies[0]["system"][0]["text"])
    assert events.NETWORK["on"] in said and "asks them first" not in said
    assert ledger.agent_rows(CORPUS)["main"]["network"] == "on"
    assert hits == ["/rows"] and asked == []
