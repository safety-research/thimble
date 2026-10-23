"""The agents the server runs itself (runtime.py) on the way to reach Claude the person chose (claude_access.py): an API
key or WIF runs a Messages API loop here (runtime_api.py), Claude Code sign-in a headless Claude Code session through
the Agent SDK (runtime_cc.py). Both write the same records into the chats, through the mirror (session.py). The
Messages API is a fake client and the Agent SDK a fake ClaudeSDKClient: no model is called and no `claude` starts."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from app import agents, claude_access, config, events, llm, runtime, runtime_cc, subagents, write_session

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
    """The runtime on, in workspace `mini`, with the Important details check off (it would start at main's turn end)."""
    monkeypatch.setenv("THIMBLE_RUNTIME", "on")
    monkeypatch.setenv("THIMBLE_SANDBOX", "0")
    config.workspace_dir(CORPUS).mkdir(parents=True, exist_ok=True)
    from app import checks

    for cid in ("important-details", "judgment", "unverified"):
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


# --------------------------------------------------------------------------- one-shot calls


async def test_structured_calls_go_to_the_messages_api(on, monkeypatch):
    from app import model

    claude_access.save(claude_access.API_KEY, key="sk-ant-test-key")

    class Out:
        def __init__(self) -> None:
            self.calls: list[dict[str, Any]] = []
            self.beta = self
            self.messages = self

        async def create(self, **body: Any) -> Any:
            self.calls.append(body)
            return Final([Block(type="tool_use", id="t", name="answer", input={"value": "yes"})], "tool_use")

    out = Out()
    monkeypatch.setattr(llm, "client", lambda: out)
    spec = model.ToolSpec("answer", "the answer", {"type": "object", "properties": {"value": {"type": "string"}},
                                                   "required": ["value"]})
    res = await model.structured("Is it?", tool=spec, model="claude-opus-5-5", effort="low", speed="standard",
                                 refusal=None, cwd=".")
    assert res.status == "ok" and res.output == {"value": "yes"}
    assert out.calls[0]["tool_choice"] == {"type": "tool", "name": "answer"}


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
