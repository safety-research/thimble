"""The agents the server runs itself (runtime.py) on the way to reach Claude the person chose (claude_access.py): an API
key or WIF runs a Messages API loop here (runtime_api.py), Claude Code sign-in a headless Claude Code session through
the Agent SDK (runtime_cc.py). Both write the same records into the chats, through the mirror (session.py). The
Messages API is a fake client and the Agent SDK a fake ClaudeSDKClient: no model is called and no `claude` starts."""
from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import pytest

from app import agents, claude_access, config, events, llm, runtime, runtime_cc, session, subagents, write_session

CORPUS = "mini"


# --------------------------------------------------------------------------- fakes


class Block:
    def __init__(self, **kw: Any) -> None:
        self.__dict__.update(kw)

    def model_dump(self, **_: Any) -> dict[str, Any]:
        return dict(self.__dict__)


class Final:
    def __init__(self, content: list[Block], stop_reason: str = "end_turn") -> None:
        self.content, self.stop_reason, self.model, self.usage = content, stop_reason, "claude-opus-5-5", None


class FakeStream:
    def __init__(self, final: Final) -> None:
        self.final = final

    async def __aenter__(self) -> "FakeStream":
        return self

    async def __aexit__(self, *a: Any) -> None:
        return None

    def __aiter__(self) -> "FakeStream":
        return self

    async def __anext__(self) -> Any:
        raise StopAsyncIteration

    async def get_final_message(self) -> Final:
        return self.final


class FakeClient:
    """The Messages API: each request takes the next scripted reply (a list of blocks, or a function of the request)."""

    def __init__(self, replies: list[Any]) -> None:
        self.replies, self.bodies = list(replies), []
        self.beta = self
        self.messages = self

    def stream(self, **body: Any) -> FakeStream:
        self.bodies.append(json.loads(json.dumps(body, default=str)))
        reply = self.replies.pop(0) if self.replies else [Block(type="text", text="(no more)")]
        reply = reply(body) if callable(reply) else reply
        stop = "tool_use" if any(b.type == "tool_use" for b in reply) else "end_turn"
        return FakeStream(Final(reply, stop))


def text(t: str) -> list[Block]:
    return [Block(type="text", text=t)]


def call(name: str, args: dict[str, Any], tid: str = "toolu_1") -> list[Block]:
    return [Block(type="tool_use", id=tid, name=name, input=args)]


@pytest.fixture()
def on(monkeypatch, workspaces_tmp):
    """The runtime on, in workspace `mini`, with the checks off (Heads up and Explainers would start at main's turn end)."""
    monkeypatch.setenv("THIMBLE_RUNTIME", "on")
    monkeypatch.setenv("THIMBLE_SANDBOX", "0")
    config.workspace_dir(CORPUS).mkdir(parents=True, exist_ok=True)
    from app import checks

    for cid in ("heads-up", "explainers", "judgment"):
        checks.edit(CORPUS, cid, shown=False)
    runtime._spaces.clear()
    yield
    runtime._spaces.clear()


def api_key(monkeypatch, replies: list[Any]) -> FakeClient:
    claude_access.save(claude_access.API_KEY, key="sk-ant-test-key")
    client = FakeClient(replies)
    monkeypatch.setattr(llm, "client", lambda: client)
    return client


def main_records() -> list[dict[str, Any]]:
    return agents.read_events(agents.paths(CORPUS, agents.MAIN_ID)[1])


async def main_turn(words: str) -> None:
    events.post(CORPUS, "main", {"text": words})
    task = runtime._spaces[CORPUS].main.task
    assert task is not None
    await task


def shape(records: list[dict[str, Any]]) -> list[tuple]:
    """What the page shows of main's records: their types, texts and tool names, without times and ids."""
    out = []
    for r in records:
        if r["type"] == "text":
            out.append(("text", r.get("delta") or r.get("text")))
        elif r["type"] in ("tool_use", "tool_result"):
            out.append((r["type"], str(r.get("name") or "").rsplit("__", 1)[-1]))
        else:
            out.append((r["type"], r.get("text") or r.get("kind") or ""))
    return out


# --------------------------------------------------------------------------- main


async def test_a_message_runs_a_turn_of_main_on_the_messages_api(on, monkeypatch):
    client = api_key(monkeypatch, [text("Two incidents happened.")])
    await main_turn("What happened?")
    got = shape(main_records())
    assert got[0] == ("user", "What happened?")
    assert ("text", "Two incidents happened.") in got
    assert got[-1][0] == "done"
    body = client.bodies[0]
    assert "<thimble-event" in json.dumps(body["messages"][-1])
    assert {"Read", "Grep", "Glob"} <= {t["name"] for t in body["tools"] if "name" in t}
    assert "list_cards" in {t["name"] for t in body["tools"]}


async def test_main_calls_thimble_tools_as_0_8s_shim_did(on, monkeypatch):
    api_key(monkeypatch, [call("list_cards", {"group": "all"}), text("No cards yet.")])
    await main_turn("Which cards are there?")
    got = shape(main_records())
    assert ("tool_use", "list_cards") in got and ("tool_result", "") in got
    assert ("text", "No cards yet.") in got
    from app import subagent_files as sf

    line = sf.find_caller(config.workspace_dir(CORPUS), "toolu_1")
    assert line is not None and line["agent_id"] == ""  # main's own call


async def test_no_choice_shows_one_card_that_opens_the_setup_step(on, monkeypatch):
    def boom() -> Any:
        raise AssertionError("no model call without a way to reach Claude")

    monkeypatch.setattr(llm, "client", boom)
    await main_turn("Hello?")
    errors = [r for r in main_records() if r["type"] == "error"]
    assert len(errors) == 1
    assert errors[0]["kind"] == runtime.ACCESS_KIND and errors[0]["action"] == "claude-access"
    assert "NoCredentials" not in json.dumps(errors[0])
    assert main_records()[-1]["type"] == "done"


async def test_a_refused_key_is_the_same_card(on, monkeypatch):
    import anthropic
    import httpx

    claude_access.save(claude_access.API_KEY, key="sk-ant-test-key")

    class Refusing(FakeClient):
        def stream(self, **body: Any) -> Any:
            req = httpx.Request("POST", "https://api.anthropic.com/v1/messages")
            raise anthropic.AuthenticationError("bad key", response=httpx.Response(401, request=req), body=None)

    monkeypatch.setattr(llm, "client", lambda: Refusing([]))
    await main_turn("Hello?")
    errors = [r for r in main_records() if r["type"] == "error"]
    assert [e["kind"] for e in errors] == [runtime.ACCESS_KIND]
    assert "401" in errors[0]["message"]


async def test_claude_code_needs_consent():
    with pytest.raises(claude_access.AccessError):
        claude_access.save(claude_access.CLAUDE_CODE)
    rec = claude_access.save(claude_access.CLAUDE_CODE, consent=True)
    assert rec["consent"]["text"] == claude_access.CONSENT


async def test_the_api_key_is_kept_private_and_never_in_status():
    claude_access.save(claude_access.API_KEY, key="sk-ant-secret-value")
    assert claude_access.key_path().stat().st_mode & 0o077 == 0
    assert "sk-ant-secret-value" not in json.dumps(claude_access.status())


# --------------------------------------------------------------------------- Claude Code sign-in


def fake_sdk(monkeypatch, script: list[Any], seen: dict[str, Any]) -> None:
    import claude_agent_sdk as sdk_mod

    class FakeSDKClient:
        def __init__(self, options: Any) -> None:
            seen["options"] = options

        async def __aenter__(self) -> "FakeSDKClient":
            return self

        async def __aexit__(self, *a: Any) -> None:
            return None

        async def query(self, prompt: str) -> None:
            seen["prompt"] = prompt

        async def receive_response(self):  # noqa: ANN202
            for m in script:
                yield m

    def capture_server(name: str, version: str = "1.0.0", tools: Any = None) -> dict[str, Any]:
        seen["server"] = (name, list(tools or []))
        return {"type": "sdk", "name": name, "instance": None}

    monkeypatch.setattr(sdk_mod, "ClaudeSDKClient", FakeSDKClient)
    monkeypatch.setattr(sdk_mod, "create_sdk_mcp_server", capture_server)
    monkeypatch.setattr(config, "CLI_PATH", "/bin/true")


async def test_claude_code_sign_in_runs_a_headless_session_with_the_same_records(on, monkeypatch):
    from claude_agent_sdk import AssistantMessage, ResultMessage, SystemMessage, TextBlock

    seen: dict[str, Any] = {}
    fake_sdk(monkeypatch, [
        SystemMessage(subtype="init", data={"session_id": "sess-1"}),
        AssistantMessage(content=[TextBlock(text="Two incidents happened.")], model="claude-opus-5-5"),
        ResultMessage(subtype="success", duration_ms=1, duration_api_ms=1, is_error=False, num_turns=1,
                      session_id="sess-1"),
    ], seen)
    claude_access.save(claude_access.CLAUDE_CODE, consent=True)
    await main_turn("What happened?")
    cc = shape(main_records())
    opts = seen["options"]
    assert opts.permission_mode == "dontAsk" and "safe-mode" in opts.extra_args
    assert "Agent" not in opts.tools and "Read" in opts.tools
    assert seen["server"][0] == runtime_cc.SERVER
    assert "mcp__plugin_thimble_thimble__list_cards" in opts.allowed_tools
    assert "<thimble-event" in seen["prompt"]
    assert json.loads(runtime._spaces[CORPUS].main.state_path("cc").read_text())["session_id"] == "sess-1"

    # the same message on the Messages API writes the same records
    agents.paths(CORPUS, agents.MAIN_ID)[1].write_text("")
    api_key(monkeypatch, [text("Two incidents happened.")])
    await main_turn("What happened?")
    assert shape(main_records()) == cc


async def test_a_headless_session_s_bash_sandbox_gets_a_short_tmpdir_and_fails_closed(data_tmp, on, monkeypatch,
                                                                                       tmp_path):
    """Claude Code's sandbox puts its sockets in TMPDIR, and did not start with one of 76 characters or more, which the
    workspace's runtime/tmp/<conv> is with a long user or workspace name: the session gets a short private TMPDIR of
    its own, removed after the turn, its sandbox is required, a refused Bash call tells the person, and the empty
    .claude/.cc-writes/ the sandbox makes in the corpus goes when the turn ends."""
    import os
    import stat

    import claude_agent_sdk as sdk_mod
    from claude_agent_sdk import AssistantMessage, ResultMessage, TextBlock, ToolResultBlock, ToolUseBlock, UserMessage

    from app import notices

    monkeypatch.setenv("THIMBLE_SANDBOX", "1")
    monkeypatch.setattr(config, "WORKSPACES_DIR", tmp_path / "home" / ("a-rather-long-user-name-" * 2)
                        / ".thimble-browser" / "workspaces-of-a-long-workspace-name")
    config.workspace_dir(CORPUS)
    runtime._spaces.clear()

    def turn_with(result: str, is_error: bool) -> list[Any]:
        return [AssistantMessage(content=[ToolUseBlock(id="toolu_b", name="Bash", input={"command": "ls"})],
                                 model="claude-opus-5-5"),
                UserMessage(content=[ToolResultBlock(tool_use_id="toolu_b", content=result, is_error=is_error)]),
                AssistantMessage(content=[TextBlock(text="Done.")], model="claude-opus-5-5"),
                ResultMessage(subtype="success", duration_ms=1, duration_api_ms=1, is_error=False, num_turns=1,
                              session_id="sess-1")]

    seen: dict[str, Any] = {}
    during: dict[str, Any] = {}

    def fake(script: list[Any]) -> None:
        fake_sdk(monkeypatch, script, seen)
        entered = sdk_mod.ClaudeSDKClient.__aenter__

        async def aenter(self: Any) -> Any:
            tmp = seen["options"].env["TMPDIR"]
            during.update(tmp=tmp, mode=stat.S_IMODE(os.stat(tmp).st_mode))
            (Path(seen["options"].cwd) / ".claude" / ".cc-writes").mkdir(parents=True, exist_ok=True)  # as CC's does
            return await entered(self)

        monkeypatch.setattr(sdk_mod.ClaudeSDKClient, "__aenter__", aenter)

    fake(turn_with("Sandbox is required but failed to initialize: Failed to create bridge sockets after 5 attempts. "
                   "Restart to retry.", True))
    claude_access.save(claude_access.CLAUDE_CODE, consent=True)
    await main_turn("What is in the folder?")
    opts = seen["options"]
    home = runtime._spaces[CORPUS].main.spec().home
    assert len(str(home)) >= 76, "the workspace's tmp is as long as the one that broke the sandbox"
    assert len(during["tmp"]) <= runtime_cc.TMP_MAX and during["mode"] == 0o700
    assert not Path(during["tmp"]).exists(), "the TMPDIR goes when the turn ends"
    box = json.loads(opts.settings)["sandbox"]
    assert box["failIfUnavailable"] is True and box["allowUnsandboxedCommands"] is False
    assert during["tmp"] in box["filesystem"]["allowWrite"] and str(home) in box["filesystem"]["allowWrite"]
    assert not (Path(opts.cwd) / ".claude").exists(), "the sandbox's empty .claude/.cc-writes/ goes too"
    told = [n for n in notices.open_notices(CORPUS) if n["key"] == runtime_cc.SANDBOX_KEY]
    assert len(told) == 1 and "Failed to create bridge sockets" in told[0]["text"] and "Main" in told[0]["text"]

    # a later Bash call that runs takes the notice away, and a .claude/ that was there before stays
    fake(turn_with("a.txt", False))
    (Path(opts.cwd) / ".claude").mkdir()
    await main_turn("And now?")
    assert not [n for n in notices.open_notices(CORPUS) if n["key"] == runtime_cc.SANDBOX_KEY]
    assert (Path(opts.cwd) / ".claude").is_dir() and not (Path(opts.cwd) / ".claude" / ".cc-writes").exists()
    assert Path(opts.cwd).is_relative_to(data_tmp), "the test's own copy of the corpus"


def test_short_tmp_stays_short_where_the_temp_folder_is_long(monkeypatch, tmp_path):
    """macOS's temp folder is /var/folders/<..>/T, about 49 characters; short_tmp keeps to /tmp where it exists, and
    never makes a folder longer than TMP_MAX."""
    import tempfile

    long_root = tmp_path / ("x" * 60)
    long_root.mkdir()
    monkeypatch.setattr(tempfile, "gettempdir", lambda: str(long_root))
    got = runtime_cc.short_tmp()
    assert got is not None and len(str(got)) <= runtime_cc.TMP_MAX and str(got).startswith("/tmp/")
    got.rmdir()
    monkeypatch.setattr(runtime_cc, "TMP_ROOT", str(long_root))
    assert runtime_cc.short_tmp() is None, "no folder rather than one too long for the sandbox's sockets"


async def test_the_api_key_s_bash_runs_in_its_sandbox_with_long_folder_names(tmp_path):
    """The API key's Bash (runtime_tools._bash) runs under the sandbox runtime with no network rule, so srt starts no
    proxy and makes no socket: a TMPDIR of any length (here over 200 characters, from a long user and workspace name)
    starts it. The command writes its TMPDIR and the workspace, and its write to the data folder is refused."""
    from app import runtime_tools

    if why := runtime_tools.sandbox_reason():
        pytest.skip(why)
    long = tmp_path / "home" / ("a-rather-long-user-name-" * 3)
    ws = long / ".thimble-browser" / "workspaces" / ("a-long-workspace-name-" * 3)
    corpus = tmp_path / "data" / ("a-long-data-folder-name-" * 3)
    home = ws / "runtime" / "home" / ("conv-" + "x" * 30)
    for p in (ws, corpus, home):
        p.mkdir(parents=True)
    (corpus / "rows.txt").write_text("ada 3\n")
    assert len(str(home / "tmp")) > 200
    box = runtime_tools.Box(cwd=corpus, workspace=ws, read_roots=[corpus], write_roots=[ws], home=home)
    out = await runtime_tools._bash(box, {"command": (
        f"cat rows.txt; mktemp >/dev/null && echo tmp-ok; echo x > {ws}/w && echo ws-ok; "
        "(echo x > new.txt) 2>/dev/null && echo DATA-WRITTEN || echo data-refused")})
    assert not out.is_error and out.text.split() == ["ada", "3", "tmp-ok", "ws-ok", "data-refused"], out.text
    assert not (corpus / "new.txt").exists() and (ws / "w").is_file()


async def test_a_thimble_call_in_a_headless_session_runs_as_its_caller(on, monkeypatch):
    seen: dict[str, Any] = {}
    fake_sdk(monkeypatch, [], seen)
    claude_access.save(claude_access.CLAUDE_CODE, consent=True)
    sp = runtime.ensure(CORPUS)
    pending: dict[str, list[str]] = {}
    opts = runtime_cc.options(sp.main, sp.main.spec(), pending)
    pre = opts.hooks["PreToolUse"][0].hooks[0]
    await pre({"tool_name": "mcp__plugin_thimble_thimble__list_cards", "tool_input": {"group": "all"}}, "toolu_cc", None)
    tool = next(t for t in seen["server"][1] if t.name == "list_cards")
    res = await tool.handler({"group": "all"})
    assert not res["is_error"]
    from app import subagent_files as sf

    assert sf.find_caller(config.workspace_dir(CORPUS), "toolu_cc") is not None


# --------------------------------------------------------------------------- threads and thimble's agents


async def test_a_thread_is_answered_by_a_fork_of_main(on, monkeypatch):
    client = api_key(monkeypatch, [text("Main answered."), text("Because of the deploy.")])
    await main_turn("What happened?")
    meta = agents.new_thread(CORPUS, None, None, "why")
    tid = str(meta["id"])
    events.post(CORPUS, "thread", {"thread": tid, "text": "Why did it fail?"})
    sp = runtime._spaces[CORPUS]
    fork = next(c for c in sp.convs.values() if c.kind == "fork")
    await fork.task
    recs = agents.read_events(agents.paths(CORPUS, tid)[1])
    assert any(r["type"] == "text" and "Because of the deploy." in (r.get("delta") or "") for r in recs)
    assert recs[-1]["type"] == "done"
    # the fork's conversation starts from main's
    assert "Main answered." in json.dumps(client.bodies[1]["messages"])


async def test_write_starts_the_writer_in_the_server(on, monkeypatch):
    api_key(monkeypatch, [text("The report is written.")])
    runtime.ensure(CORPUS)
    ans = await write_session.start(CORPUS, "report", "Write it up.")
    assert ans.started, ans
    sp = runtime._spaces[CORPUS]
    conv = sp.convs[str(ans.agent_id)]
    await conv.task
    a = subagents.agent(CORPUS, str(ans.agent_id)) or {}
    assert a.get("status") == "done"
    recs = agents.read_events(agents.paths(CORPUS, str(a["chat"]))[1])
    assert any(r["type"] == "text" and "The report is written." in (r.get("delta") or "") for r in recs)
    assert conv.transcript is not None and conv.transcript.path.with_name(
        conv.transcript.path.name.replace(".jsonl", ".meta.json")).is_file()


async def test_typed_start_tools_start_at_once(on, monkeypatch):
    api_key(monkeypatch, [call("start_writing", {"doc": "report", "request": "Write it up."}), text("ok"),
                          text("The report is written.")])
    await main_turn("Write the report.")
    results = [r for r in main_records() if r["type"] == "tool_result"]
    assert results and "Agent call" not in json.dumps(results)
    assert any(c.kind == "agent" for c in runtime._spaces[CORPUS].convs.values())
    for c in list(runtime._spaces[CORPUS].convs.values()):
        if c.task is not None:
            await c.task


class Hang(FakeStream):
    """A reply that never comes, as a long turn's: the turn waits on it until it is stopped."""

    async def __anext__(self) -> Any:
        await asyncio.Event().wait()
        raise StopAsyncIteration


async def test_the_server_s_stop_ends_its_agents_stopped_and_the_next_start_runs_none(on, monkeypatch):
    """Ctrl-C in thimble-browser stops the server, which stops every agent it runs first (runtime.stop_all): a writer's
    run ends `stopped`, a thread's fork ends, main's turn ends with a line that says why, and the mirror keeps them
    ended, so the next start under the same chat (thimble-browser --continue) shows nothing running."""
    client = api_key(monkeypatch, [])
    client.stream = lambda **body: Hang(Final([], "end_turn"))
    runtime.ensure(CORPUS)
    ans = await write_session.start(CORPUS, "report", "Write it up.")
    tid = str(agents.new_thread(CORPUS, None, None, "why")["id"])
    events.post(CORPUS, "thread", {"thread": tid, "text": "Why did it fail?"})
    events.post(CORPUS, "main", {"text": "What happened?"})
    await asyncio.sleep(0.3)
    sp = runtime._spaces[CORPUS]
    writer = sp.convs[str(ans.agent_id)]
    assert sp.main.running and writer.running and agents.running(CORPUS, tid)
    assert len(await runtime.stop_all(wait_s=5)) == 3
    assert not any(c.running for c in [sp.main, *sp.convs.values()])
    assert (subagents.agent(CORPUS, str(ans.agent_id)) or {}).get("status") == "stopped"
    assert not agents.running(CORPUS, tid)
    assert ("chip", session.QUIT_TEXT) in shape(main_records())
    # the next start: a new server attaches main's same chat, with none of this one's state in memory
    runtime._spaces.clear()
    session._live.pop(CORPUS, None)
    agents._busy.clear()
    runtime.ensure(CORPUS)
    try:
        assert not agents.running(CORPUS, tid), "the thread's fork is not taken up again"
        assert not agents.running(CORPUS, agents.MAIN_ID) and not session._live[CORPUS].turn_open
    finally:
        await session.shutdown()


# --------------------------------------------------------------------------- one-shot calls


async def test_structured_calls_go_to_the_messages_api(on, monkeypatch):
    from app import model

    claude_access.save(claude_access.API_KEY, key="sk-ant-test-key")

    class Out:
        def __init__(self) -> None:
            self.calls: list[dict[str, Any]] = []
            self.beta = self
            self.messages = self

        def stream(self, **body: Any) -> FakeStream:
            self.calls.append(body)
            return FakeStream(Final([Block(type="tool_use", id="t", name="answer", input={"value": "yes"})], "tool_use"))

    out = Out()
    monkeypatch.setattr(llm, "client", lambda: out)
    spec = model.ToolSpec("answer", "the answer", {"type": "object", "properties": {"value": {"type": "string"}},
                                                   "required": ["value"]})
    res = await model.structured("Is it?", tool=spec, model="claude-opus-5-5", effort="low", speed="standard",
                                 refusal=None, cwd=".")
    assert res.status == "ok" and res.output == {"value": "yes"}
    # the current models refuse a forced tool_choice ("tool" or "any"): the system prompt names the tool
    assert out.calls[0]["tool_choice"] == {"type": "auto"} and "`answer` tool" in out.calls[0]["system"]


async def test_a_structured_reply_without_its_tool_call_is_asked_for_it_once_more(on, monkeypatch):
    from app import model

    claude_access.save(claude_access.API_KEY, key="sk-ant-test-key")
    replies = [Final([Block(type="thinking", thinking="", signature="s"), Block(type="text", text="Yes.")], "end_turn"),
               Final([Block(type="tool_use", id="t", name="answer", input={"value": "yes"})], "tool_use")]

    class Out:
        def __init__(self) -> None:
            self.calls: list[dict[str, Any]] = []
            self.beta = self
            self.messages = self

        def stream(self, **body: Any) -> FakeStream:
            self.calls.append(json.loads(json.dumps(body)))
            return FakeStream(replies.pop(0))

    out = Out()
    monkeypatch.setattr(llm, "client", lambda: out)
    spec = model.ToolSpec("answer", "the answer", {"type": "object", "properties": {"value": {"type": "string"}},
                                                   "required": ["value"]})
    res = await model.structured("Is it?", tool=spec, model="claude-opus-5-5", effort="low", speed="standard",
                                 refusal=None, cwd=".")
    assert res.status == "ok" and res.output == {"value": "yes"} and res.attempts == 2
    again = out.calls[1]["messages"]
    # the reply goes back as it came, its thinking included, then the ask for the tool
    assert [b["type"] for b in again[1]["content"]] == ["thinking", "text"] and "`answer` tool" in again[2]["content"]


async def test_a_structured_call_streams_so_the_sdk_takes_its_long_reply(on, monkeypatch):
    """The SDK refuses a call that is not streamed when its max_tokens could take longer than 10 minutes ("Streaming is
    required ..."), as a card check's reply can: structured() streams it. The real SDK client over a fake transport (httpx2, the SDK's own HTTP package)."""
    import anthropic
    import httpx2 as httpx

    from app import model

    def sse(*events: dict[str, Any]) -> bytes:
        return "".join(f"event: {e['type']}\ndata: {json.dumps(e)}\n\n" for e in events).encode()

    sent: list[dict[str, Any]] = []

    def reply(request: httpx.Request) -> httpx.Response:
        sent.append(json.loads(request.content))
        usage = {"input_tokens": 5, "output_tokens": 3}
        body = sse(
            {"type": "message_start", "message": {"id": "msg_1", "type": "message", "role": "assistant", "content": [],
                                                  "model": "claude-opus-5-5", "stop_reason": None, "usage": usage}},
            {"type": "content_block_start", "index": 0,
             "content_block": {"type": "tool_use", "id": "toolu_1", "name": "answer", "input": {}}},
            {"type": "content_block_delta", "index": 0,
             "delta": {"type": "input_json_delta", "partial_json": json.dumps({"value": "yes"})}},
            {"type": "content_block_stop", "index": 0},
            {"type": "message_delta", "delta": {"stop_reason": "tool_use"}, "usage": {"output_tokens": 3}},
            {"type": "message_stop"})
        return httpx.Response(200, content=body, headers={"content-type": "text/event-stream"})

    real = anthropic.AsyncAnthropic(api_key="sk-ant-test-key", base_url="http://api.test",
                                    http_client=httpx.AsyncClient(transport=httpx.MockTransport(reply)))
    # the same call not streamed is what the SDK refuses
    with pytest.raises(ValueError, match="Streaming is required"):
        await real.beta.messages.create(model="claude-opus-5-5", max_tokens=model.API_MAX_TOKENS,
                                        messages=[{"role": "user", "content": "Is it?"}])
    claude_access.save(claude_access.API_KEY, key="sk-ant-test-key")
    monkeypatch.setattr(llm, "client", lambda: real)
    spec = model.ToolSpec("answer", "the answer", {"type": "object", "properties": {"value": {"type": "string"}},
                                                   "required": ["value"]})
    res = await model.structured("Is it?", tool=spec, model="claude-opus-5-5", effort="low", speed="standard",
                                 refusal=None, cwd=".")
    assert res.status == "ok" and res.output == {"value": "yes"}, res.detail
    assert sent[0]["stream"] is True and sent[0]["max_tokens"] == model.API_MAX_TOKENS


async def test_extension_programs_start_no_claude_code_with_an_api_key(on):
    claude_access.save(claude_access.API_KEY, key="sk-ant-test-key")
    assert runtime.uses_api()
    claude_access.save(claude_access.CLAUDE_CODE, consent=True)
    assert not runtime.uses_api()


def test_the_runtime_is_off_for_0_8s_own_tests():
    assert not runtime.enabled()


async def test_the_checker_and_proposer_forks_run_on_the_messages_api_without_claude(on, monkeypatch):
    """With an API key the citation checker's and the view proposer's forks copy main's conversation and run here: no
    `claude` starts, and the checker runs only Read, Grep, Glob and python."""
    import asyncio
    from types import SimpleNamespace

    from app import marks, proposer

    real = asyncio.create_subprocess_exec

    async def no_claude(*a: Any, **k: Any) -> Any:
        assert not str(a[0]).rsplit("/", 1)[-1].startswith("claude"), "a claude process started"
        return await real(*a, **k)

    monkeypatch.setattr(asyncio, "create_subprocess_exec", no_claude)
    client = api_key(monkeypatch, [text("Two incidents happened."),
                                   call("Bash", {"command": "rm -rf ."}, "toolu_x") + call("Bash", {"command": "python3 -c 'print(2)'"}, "toolu_y"),
                                   text('{"n": 1, "output": "2"}'),
                                   text('{"show": false, "why": "nothing to show"}')])
    await main_turn("What happened?")
    got = await marks.run_fork(CORPUS, {"model": "claude-opus-5-5", "effort": "low"}, "cut", "Check [2](#).")
    assert "Check [2](#)." in json.dumps(client.bodies[1]["messages"][-1])
    assert any("Two incidents happened." in json.dumps(m) for m in client.bodies[1]["messages"])
    results = client.bodies[2]["messages"][-1]["content"]
    assert results[0]["is_error"] and results[0]["content"] == "This check may not use that tool."
    assert [c["command"] for c in got["calls"]] == ["rm -rf .", "python3 -c 'print(2)'"]
    assert got["answer"] == '{"n": 1, "output": "2"}' and not got["error"]
    res = await proposer._fork(SimpleNamespace(c=CORPUS, sid="s", cwd="."), "cut", "Propose.", "claude-opus-5-5", "low", "")
    assert proposer.answer_text(proposer.read_stream(res["stdout"])) == '{"show": false, "why": "nothing to show"}'


# --------------------------------------------------------------------------- main's chats (thimble-browser -c / -r)


def asked(client: FakeClient, i: int) -> str:
    """The text of request `i`'s messages, to see which chat's turns it carried."""
    return json.dumps(client.bodies[i]["messages"])


async def test_a_new_chat_starts_main_anew_and_resume_brings_the_earlier_one_back(on, monkeypatch):
    client = api_key(monkeypatch, [text("Two incidents happened."), text("Hello again."), text("Still two.")])
    await main_turn("What happened?")
    sp = runtime._spaces[CORPUS]
    first = sp.sid
    assert await sp.switch(None)
    assert sp.sid != first and json.loads((sp.dir / "main.json").read_text())["session"] == sp.sid
    await main_turn("Hi")
    assert "What happened?" not in asked(client, 1)  # the new chat holds none of the first one's turns
    got = shape(main_records())
    assert ("chip", "New chat") in got and ("user", "What happened?") in got  # the earlier chat stays in the page
    rows = runtime.main_chats(CORPUS)
    assert [(r["first"], r["turns"], r["current"]) for r in rows] == [("Hi", 1, True), ("What happened?", 1, False)]
    assert await sp.switch(first)
    await main_turn("And now?")
    assert "What happened?" in asked(client, 2) and "Hi" not in asked(client, 2)
    assert ("chip", "Resumed the chat that began with: What happened?") in shape(main_records())
    assert shape(main_records())[-1][0] == "done"


async def test_a_new_chat_while_main_has_no_turn_is_that_chat_and_an_unknown_id_is_refused(on, monkeypatch):
    api_key(monkeypatch, [])
    sp = runtime.ensure(CORPUS)
    sid = sp.sid
    assert not await sp.switch(None) and sp.sid == sid
    with pytest.raises(ValueError):
        await sp.switch("no-such-chat")


def test_main_s_state_from_before_chats_were_kept_apart_is_its_chat_s(on):
    d = config.workspace_dir(CORPUS) / runtime.DIR
    (d / "convs").mkdir(parents=True, exist_ok=True)
    (d / "main.json").write_text(json.dumps({"session": "s1"}))
    (d / "convs" / "main.api.json").write_text("[]")
    sp = runtime.ensure(CORPUS)
    assert sp.main.state_path("api") == d / "convs" / "main-s1.api.json" and sp.main.state_path("api").is_file()


def test_the_launcher_picks_the_latest_session_one_by_chat_id_or_one_by_number(on, monkeypatch, capsys):
    from app import cli, folder_sessions

    rows = [{"archive": None, "at": 200.0, "turns": 3, "cards": 2, "first": "Second question", "chat": "bbb222",
             "chats": ["bbb222"]},
            {"archive": "mini-2026-10-23-090000", "at": 100.0, "turns": 1, "cards": 1, "first": "First question",
             "chat": "aaa111", "chats": ["aaa111", "aab000"]}]
    monkeypatch.setattr(folder_sessions, "listing", lambda c: rows)
    folder = config.corpus_dir(CORPUS)
    monkeypatch.setattr(cli, "known_corpus", lambda cwd, data: (CORPUS, folder))
    data = folder.parent
    assert cli.pick_session(folder, data, "new") == {"archive": None, "chat": "new"}
    assert cli.pick_session(folder, data, "continue") == {"archive": None, "chat": "bbb222"}
    assert cli.pick_session(folder, data, "aab") == {"archive": "mini-2026-10-23-090000", "chat": "aab000"}
    assert cli.pick_session(folder, data, "aa") is None and cli.pick_session(folder, data, "zzz") is None
    answers = iter(["9", "2"])
    monkeypatch.setattr("builtins.input", lambda _: next(answers))
    assert cli.pick_session(folder, data, "pick") == {"archive": "mini-2026-10-23-090000", "chat": "aaa111"}
    out = capsys.readouterr().out
    assert "1. " in out and "3 turns    2 cards  Second question" in out and "1 turn     1 card  First question" in out
    monkeypatch.setattr(folder_sessions, "listing", lambda c: [])
    assert cli.pick_session(folder, data, "continue") is None
    assert "no earlier session" in capsys.readouterr().out


async def test_a_new_session_is_empty_and_the_last_comes_back_whole(on, monkeypatch):
    """thimble-browser's new session (folder_sessions.py): the open workspace moves aside whole (ledger.archive_workspace),
    main's runtime goes with it (runtime.forget), and the next start of main is a chat of its own in an empty workspace;
    bringing the session back (ledger.restore_workspace) brings its chat, its conversation and its card."""
    from app import folder_sessions, ledger, notebook

    client = api_key(monkeypatch, [text("Two incidents happened."), text("Hello."), text("Still two.")])
    await main_turn("What happened?")
    ws = config.workspace_dir(CORPUS)
    nb = notebook.create_notebook(ws, "G")
    notebook.insert_cell(CORPUS, nb["id"], notebook.new_cell("note", "test", "Two incidents", nb["id"],
                                                             payload={"text": "two"}))
    first = runtime._spaces[CORPUS].sid
    [row] = folder_sessions.listing(CORPUS)
    assert (row["archive"], row["first"], row["turns"], row["cards"], row["chat"]) == (None, "What happened?", 1, 1, first)
    moved = (await ledger.archive_workspace(CORPUS))["archived"]
    assert CORPUS not in runtime._spaces, "the runtime of the folder that went is dropped"
    await main_turn("Hi")
    assert runtime._spaces[CORPUS].sid != first and "What happened?" not in asked(client, 1)
    assert ("user", "What happened?") not in shape(main_records()), "the new session's chat holds none of the last one's"
    assert not notebook.list_notebooks(config.workspace_dir(CORPUS), figures=False)
    rows = folder_sessions.listing(CORPUS)
    assert [(r["archive"], r["first"]) for r in rows] == [(None, "Hi"), (Path(moved).name, "What happened?")]
    await ledger.restore_workspace(CORPUS, {"archive": Path(moved).name})
    assert CORPUS not in runtime._spaces
    await main_turn("And now?")
    assert runtime._spaces[CORPUS].sid == first
    assert "What happened?" in asked(client, 2) and "Hi" not in asked(client, 2)
    got = shape(main_records())
    assert ("user", "What happened?") in got and ("user", "And now?") in got and ("user", "Hi") not in got
    assert sum(r["n_cells"] for r in notebook.list_notebooks(config.workspace_dir(CORPUS), figures=False)) == 1
    assert [r["first"] for r in folder_sessions.listing(CORPUS)] == ["What happened?", "Hi"]


def test_a_workspace_that_holds_nothing_is_no_session_to_list(on):
    from app import folder_sessions

    runtime.ensure(CORPUS)
    assert folder_sessions.listing(CORPUS) == []
    assert not folder_sessions.holds(folder_sessions.summary(config.workspace_dir(CORPUS)))


def test_the_launcher_moves_a_session_that_holds_anything_aside_and_brings_one_back(on, monkeypatch, capsys):
    """open_session: a new session archives the open one only when it holds anything; an earlier one is restored; each
    then opens its chat of main through the register route; a failure says so in one line."""
    from app import cli, folder_sessions

    calls: list[tuple] = []
    monkeypatch.setattr(cli, "resolve_env", lambda: {"workspaces_dir": str(config.WORKSPACES_DIR)})
    monkeypatch.setattr(cli, "archive_workspace", lambda url, name: calls.append(("archive", name)) or (True, "/x"))
    monkeypatch.setattr(cli, "restore_workspace", lambda url, name, a: calls.append(("restore", a)) or (200, {}))
    monkeypatch.setattr(cli, "_request", lambda m, url, body=None, **k: calls.append(("register", body["chat"])) or (201, {}))
    folder = config.corpus_dir(CORPUS)
    held = {"turns": 0, "cards": 0, "labels": 0, "documents": [], "threads": 0}
    monkeypatch.setattr(folder_sessions, "summary", lambda ws: held)
    assert cli.open_session("u", CORPUS, folder, {"archive": None, "chat": "new"})
    assert calls == [("register", "new")], "a workspace that holds nothing is the new session"
    calls.clear()
    held["cards"] = 1
    assert cli.open_session("u", CORPUS, folder, {"archive": None, "chat": "new"})
    assert calls == [("archive", CORPUS), ("register", "new")]
    calls.clear()
    assert cli.open_session("u", CORPUS, folder, {"archive": None, "chat": "bbb"})
    assert calls == [("register", "bbb")], "the session open now is continued as it is"
    calls.clear()
    assert cli.open_session("u", CORPUS, folder, {"archive": "mini-1", "chat": "aaa"})
    assert calls == [("restore", "mini-1"), ("register", "aaa")]
    monkeypatch.setattr(cli, "restore_workspace", lambda url, name, a: (404, {"detail": "no archive"}))
    assert not cli.open_session("u", CORPUS, folder, {"archive": "mini-1", "chat": "aaa"})
    assert "the session was not brought back (no archive)" in capsys.readouterr().out
    monkeypatch.setattr(cli, "archive_workspace", lambda url, name: (False, None))
    assert cli.open_session("u", CORPUS, folder, {"archive": None, "chat": "new"})
    assert "the last session was not moved aside" in capsys.readouterr().out


async def test_on_claude_code_sign_in_a_new_chat_is_a_new_session_and_resume_resumes_its_own(on, monkeypatch):
    from claude_agent_sdk import AssistantMessage, ResultMessage, SystemMessage, TextBlock

    def script(sid: str) -> list[Any]:
        return [SystemMessage(subtype="init", data={"session_id": sid}),
                AssistantMessage(content=[TextBlock(text="ok")], model="claude-opus-5-5"),
                ResultMessage(subtype="success", duration_ms=1, duration_api_ms=1, is_error=False, num_turns=1,
                              session_id=sid)]

    seen: dict[str, Any] = {}
    claude_access.save(claude_access.CLAUDE_CODE, consent=True)
    fake_sdk(monkeypatch, script("sess-1"), seen)
    await main_turn("What happened?")
    sp = runtime._spaces[CORPUS]
    first = sp.sid
    await sp.switch(None)
    fake_sdk(monkeypatch, script("sess-2"), seen)
    await main_turn("Hi")
    assert seen["options"].resume is None
    await sp.switch(first)
    await main_turn("And now?")
    assert seen["options"].resume == "sess-1"


def test_an_api_error_reads_as_the_api_s_message_in_a_sentence_not_its_raw_answer():
    import anthropic
    import httpx

    body = {"type": "error", "request_id": "req_made_up",
            "error": {"type": "invalid_request_error", "message": "messages.3.content.1.fallback.from: Field required"}}
    e = anthropic.BadRequestError(f"Error code: 400 - {body}", body=body,
                                  response=httpx.Response(400, request=httpx.Request("POST", "https://api.example.test")))
    assert llm.failure(e) == "Claude's API answered 400 (invalid request): messages.3.content.1.fallback.from: Field required."
    assert "{" not in llm.failure(e)
    # an answer whose body holds no message keeps its own text
    bare = anthropic.InternalServerError("Error code: 500 - upstream reset", body=None,
                                         response=httpx.Response(500, request=httpx.Request("POST", "https://api.example.test")))
    assert llm.failure(bare) == "Claude's API answered 500: Error code: 500 - upstream reset"
