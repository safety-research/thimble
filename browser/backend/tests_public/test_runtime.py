"""The agents the server runs itself (runtime.py) on the way to reach Claude the person chose (claude_access.py): an API
key or WIF runs a Messages API loop here (runtime_api.py), Claude Code sign-in a headless Claude Code session through
the Agent SDK (runtime_cc.py). Both write the same records into the chats, through the mirror (session.py). The
Messages API is a fake client and the Agent SDK a fake ClaudeSDKClient: no model is called and no `claude` starts."""
from __future__ import annotations

import asyncio
import contextlib
import json
from pathlib import Path
from typing import Any

import pytest

from app import (agents, claude_access, config, events, ledger, llm, report_types, runtime, runtime_cc, session,
                 subagents, write_session)

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
    """The analyst's message is main's turn: main calls a tool of thimble's, then answers, and the chat shows each step."""
    client = api_key(monkeypatch, [call("list_cards", {"group": "all"}), text("No cards yet.")])
    await main_turn("Which cards are there?")
    got = shape(main_records())
    assert got[0] == ("user", "Which cards are there?")
    assert ("tool_use", "list_cards") in got and ("tool_result", "") in got and ("text", "No cards yet.") in got
    assert got[-1][0] == "done"
    body = client.bodies[0]
    assert "<thimble-event" in json.dumps(body["messages"][-1])
    assert {"Read", "Grep", "Glob", "list_cards"} <= {t["name"] for t in body["tools"] if "name" in t}
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

        async def query(self, prompt: Any) -> None:  # the turn's prompt, one user message (runtime_cc._message)
            seen["prompt"] = prompt if isinstance(prompt, str) else "".join([m["message"]["content"] async for m in prompt])

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
    # Claude Code's default mode, whose asks go to the callback: a new host's to the analyst, the rest refused
    # (test_host_asks.py)
    assert opts.permission_mode == "default" and opts.can_use_tool is not None and "safe-mode" in opts.extra_args
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


async def test_a_session_whose_sandbox_cannot_run_has_no_bash_and_the_analyst_is_told_what_it_lacks(on, monkeypatch):
    """Where thimble's probe finds that Claude Code's Bash sandbox cannot run, main's session goes without Bash, and the
    analyst gets the sandbox notice with what the sandbox lacks, as the session starts, which the error Claude Code
    answers a call of the missing Bash with does not take away; THIMBLE_SANDBOX=0, which turns the sandbox off on purpose
    (the fixture's), tells nothing."""
    from claude_agent_sdk import (AssistantMessage, ResultMessage, SystemMessage, TextBlock, ToolResultBlock,
                                  ToolUseBlock, UserMessage)

    from app import cc_settings, notices

    seen: dict[str, Any] = {}
    fake_sdk(monkeypatch, [
        SystemMessage(subtype="init", data={"session_id": "sess-box"}),
        AssistantMessage(content=[ToolUseBlock(id="toolu_box", name="Bash", input={"command": "ls runs | wc -l"})],
                         model="claude-opus-5-5"),
        UserMessage(content=[ToolResultBlock(tool_use_id="toolu_box", is_error=True,
                                             content="<tool_use_error>Error: No such tool available: Bash</tool_use_error>")]),
        AssistantMessage(content=[TextBlock(text="I could not run the shell.")], model="claude-opus-5-5"),
        ResultMessage(subtype="success", duration_ms=1, duration_api_ms=1, is_error=False, num_turns=1,
                      session_id="sess-box"),
    ], seen)
    claude_access.save(claude_access.CLAUDE_CODE, consent=True)

    def told() -> list[str]:
        return [n["text"] for n in notices.open_notices(CORPUS) if n.get("key") == runtime_cc.SANDBOX_KEY]

    await main_turn("How many runs are there?")
    assert "Bash" not in seen["options"].tools and told() == []
    monkeypatch.delenv("THIMBLE_SANDBOX")
    monkeypatch.setattr(cc_settings, "sandbox_ok", lambda refresh=False: False)
    monkeypatch.setattr(cc_settings, "sandbox_missing", lambda: ["bwrap", "socat"])
    await main_turn("How many runs are there?")
    assert "Bash" not in seen["options"].tools
    assert told() == [runtime_cc.SANDBOX_NOTICE.format(agent="Main", why="missing bwrap, socat")]


class BackgroundCLI:
    """A headless `claude` whose first turn runs a Bash command in the background: a real process, which lives until the
    session closes, as Claude Code kills its background commands as it exits. `ends` makes the command end between the
    turns, which Claude Code answers with a turn of its own before it echoes the next prompt; `during` is awaited with
    the session once the command runs, while the first turn still runs."""

    def __init__(self, options: Any, made: list["BackgroundCLI"], ends: bool, during: Any = None) -> None:
        self.options, self.ends, self.during, self.jobs, self.closed = options, ends, during, [], False
        self.prompts: asyncio.Queue = asyncio.Queue()
        self.sent: list[Any] = []  # the prompts it read
        self.stopped: list[str] = []  # the tasks stop_task stopped
        self.stream: Any = None
        self.on_close: Any = None  # called as it starts to close, while its commands still run
        made.append(self)

    async def __aenter__(self) -> "BackgroundCLI":
        return self

    async def __aexit__(self, *a: Any) -> None:
        if self.on_close is not None:
            self.on_close()
        self.closed = True
        for p in self.jobs:
            p.kill()
            p.wait()

    async def query(self, prompt: Any) -> None:
        if isinstance(prompt, str):
            await self.prompts.put({"message": {"content": prompt}})
            return
        async for m in prompt:
            await self.prompts.put(m)

    async def stop_task(self, task_id: str) -> None:
        self.stopped.append(task_id)
        for p in self.jobs:
            p.kill()
            p.wait()

    async def play(self):  # noqa: ANN201
        import subprocess

        from claude_agent_sdk import (AssistantMessage, ResultMessage, SystemMessage, TextBlock, ToolResultBlock,
                                      ToolUseBlock, UserMessage)

        def done() -> ResultMessage:
            return ResultMessage(subtype="success", duration_ms=1, duration_api_ms=1, is_error=False, num_turns=1,
                                 session_id="sess-bg")

        self.sent.append(await self.prompts.get())
        yield SystemMessage(subtype="init", data={"session_id": "sess-bg"})
        yield AssistantMessage(content=[ToolUseBlock(id="toolu_bg", name="Bash", input={
            "command": "sleep 600", "run_in_background": True})], model="claude-opus-5-5")
        self.jobs.append(subprocess.Popen(["sleep", "600"], start_new_session=True))
        if self.during is not None:
            await self.during(self)
        yield SystemMessage(subtype="background_tasks_changed",
                            data={"tasks": [{"task_id": "b1", "task_type": "local_bash"}]})
        yield UserMessage(content=[ToolResultBlock(tool_use_id="toolu_bg", content="Command running in background")])
        yield AssistantMessage(content=[TextBlock(text="The job runs.")], model="claude-opus-5-5")
        yield done()
        while True:
            sent = await self.prompts.get()
            self.sent.append(sent)
            if self.ends:  # the command ended while no turn ran: Claude Code's own turn, before it reads the prompt
                self.jobs.pop().kill()
                yield SystemMessage(subtype="background_tasks_changed", data={"tasks": []})
                yield AssistantMessage(content=[TextBlock(text="The job ended.")], model="claude-opus-5-5")
                yield done()
                self.ends = False
            yield UserMessage(content=sent["message"]["content"], uuid=sent.get("uuid"))  # replay-user-messages
            yield AssistantMessage(content=[TextBlock(text="Still here.")], model="claude-opus-5-5")
            yield done()

    async def receive_response(self):  # noqa: ANN201
        from claude_agent_sdk import ResultMessage

        self.stream = self.stream or self.play()
        async for m in self.stream:
            yield m
            if isinstance(m, ResultMessage):
                return


def background_cli(monkeypatch, ends: bool = False, during: Any = None) -> list[BackgroundCLI]:
    import claude_agent_sdk as sdk_mod

    made: list[BackgroundCLI] = []
    fake_sdk(monkeypatch, [], {})
    monkeypatch.setattr(sdk_mod, "ClaudeSDKClient", lambda options: BackgroundCLI(options, made, ends, during))
    claude_access.save(claude_access.CLAUDE_CODE, consent=True)
    return made


async def until(cond, what: str) -> None:
    for _ in range(600):
        if cond():
            return
        await asyncio.sleep(0.05)
    raise AssertionError(what)


@pytest.mark.parametrize("how", ["a new session", "a new chat", "an API key", "the server's stop"])
async def test_a_command_main_s_bash_runs_in_the_background_outlives_the_turn_until_main_s_session_ends(on, monkeypatch,
                                                                                                       analyst, how):
    """Claude Code kills the commands Bash ran in the background (`run_in_background`) as it exits, so main's session
    stays open past the turn while one runs, and main's next turn goes on in it; once main's session truly ends (the
    workspace moved aside for a new session, a new chat, an API key chosen in Settings, the server's stop) it closes,
    and the command ends with it."""
    made = background_cli(monkeypatch)
    await main_turn("Start the long job.")
    job = made[0].jobs[0]
    assert job.poll() is None and not made[0].closed, "the background command outlives main's turn"
    await main_turn("Is it still running?")
    assert len(made) == 1 and job.poll() is None, "main's next turn goes on in the same session"
    assert [t for k, t in shape(main_records()) if k == "text"][-1] == "Still here."
    if how == "a new session":
        await runtime.forget(CORPUS)
    elif how == "a new chat":
        await runtime._spaces[CORPUS].switch(None)
    elif how == "an API key":
        api_key(monkeypatch, [])
        await claude_access.put_route(claude_access.AccessBody(how=claude_access.API_KEY, key="sk-ant-test-key"),
                                      analyst)
    else:
        await runtime.stop_all()
    assert made[0].closed and job.poll() is not None, f"{how} ends main's session and its background command"
    assert made[0].stopped == ["b1"], "the session stops the command first: claude would wait for it as it exits"


@pytest.mark.parametrize("change", ["edits off", "labels off", "edits back on"])
async def test_a_settings_change_that_lets_main_do_less_closes_its_kept_session_at_once(on, monkeypatch, analyst,
                                                                                       change):
    """Taking a permission back leaves no command running with it: a Settings change that lets main do less ("Claude can
    edit files in this folder" or labels off) closes main's session kept open for a background command at once, not at
    main's next turn, and the command with it. A change that only widens leaves the command running."""
    made = background_cli(monkeypatch)
    if change == "edits back on":
        ledger.put_settings_route(CORPUS, analyst, {"corpus_edits": False})
    await main_turn("Start the long job.")
    job = made[0].jobs[0]
    ledger.put_settings_route(CORPUS, analyst, {"edits off": {"corpus_edits": False}, "labels off": {"labels": False},
                                                "edits back on": {"corpus_edits": None}}[change])
    if change == "edits back on":
        await asyncio.sleep(0.2)
        assert not made[0].closed and job.poll() is None, "a change that only widens leaves the command running"
        await runtime_cc.close(runtime._spaces[CORPUS].main)
        return
    await until(lambda: made[0].closed, f"{change} closes main's kept session")
    assert job.poll() is not None and made[0].stopped == ["b1"] and runtime._spaces[CORPUS].main.cc is None


# --------------------------------------------------------------------------- threads and thimble's agents


async def test_a_thread_is_answered_by_a_fork_of_main(on, monkeypatch):
    """A side thread's question goes to a fork of main, which starts from main's conversation; main stays idle."""
    client = api_key(monkeypatch, [text("Main answered."), text("Because of the deploy.")])
    await main_turn("What happened?")
    tid = str(agents.new_thread(CORPUS, None, None, "why")["id"])
    events.post(CORPUS, "thread", {"thread": tid, "text": "Why did it fail?"})
    assert not agents.running(CORPUS, agents.MAIN_ID)
    await fork_of_thread().task
    recs = agents.read_events(agents.paths(CORPUS, tid)[1])
    assert any(r["type"] == "text" and "Because of the deploy." in (r.get("delta") or "") for r in recs)
    assert recs[-1]["type"] == "done"
    assert "Main answered." in json.dumps(client.bodies[1]["messages"])
    runtime._spaces[CORPUS].read()
    assert not agents.running(CORPUS, agents.MAIN_ID) and not agents.running(CORPUS, tid)


def fork_of_thread() -> runtime.Conv:
    return next(c for c in runtime._spaces[CORPUS].convs.values() if c.kind == "fork")


async def test_a_message_sent_to_an_agent_while_it_works_is_read_at_its_running_turn_s_next_step(on, monkeypatch):
    """A follow-up sent to one of thimble's agents while its turn runs (module_op send), such as the analyst's message in
    a view build's thread, is read at the turn's next tool call, after the call's results, as main reads a message typed
    in its chat (Conv.take_waiting): part of the run that goes on, not a run of its own after it."""
    seen: dict[str, Any] = {}

    def agent() -> Any:
        return next(c for c in runtime._spaces[CORPUS].convs.values() if c.kind == "agent")

    def look_then_hear(body: dict[str, Any]) -> list[Block]:
        seen["send"] = asyncio.get_running_loop().create_task(
            runtime.module_op(CORPUS, "send", {"agent": agent().id, "text": "Also give each section a date."}))
        return call("Glob", {"pattern": "*"})

    def answer(body: dict[str, Any]) -> list[Block]:
        seen["next"] = json.dumps(body["messages"][-1])
        return text("Written, each section dated.")

    client = api_key(monkeypatch, [look_then_hear, answer])
    runtime.ensure(CORPUS)
    ans = await write_session.start(CORPUS, "report", "Write it up.")
    conv = runtime._spaces[CORPUS].convs[str(ans.agent_id)]
    await conv.task
    assert (await seen["send"]).get("queued"), "it came while the turn ran"
    assert "Also give each section a date." in seen["next"] and "tool_result" in seen["next"], seen["next"]
    assert len(client.bodies) == 2 and not conv.queue and not conv.sent
    assert (subagents.agent(CORPUS, str(ans.agent_id)) or {}).get("run", 0) == 0, "no run of its own after the turn"
    said = [json.loads(ln) for ln in conv.transcript.path.read_text().splitlines()]
    assert any(r.get("type") == "user" and r.get("message", {}).get("content") == "Also give each section a date."
               and (r.get("origin") or {}).get("kind") == "coordinator" for r in said), "its transcript records it"


async def kill_server(monkeypatch) -> None:
    """The server is killed, so its stop (stop_all) never runs: its agents' turns end with no end recorded, and what it
    kept in memory goes (its runtimes, the mirror's sessions, the writes it was asked for). Its files stay."""
    real = runtime._ended
    monkeypatch.setattr(runtime, "_ended", lambda *a, **k: None)
    for sp in list(runtime._spaces.values()):
        for conv in (sp.main, *sp.convs.values()):
            if conv.running:
                conv.task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await conv.task
    monkeypatch.setattr(runtime, "_ended", real)
    for lv in session._live.values():
        if lv.task is not None:
            lv.task.cancel()
    session._live.clear()
    runtime._spaces.clear()
    report_types.cancel_workspace(CORPUS)


async def test_a_writer_a_killed_server_left_running_ends_stopped_when_the_session_comes_back(on, monkeypatch):
    """A server killed under a writer never ends the writer's run: the registry and its chat still say it runs, so the
    Report showed it writing for good, and no writer of the document could start. The next server's runtime of the
    workspace (runtime.ensure, as thimble-browser --continue makes it) ends that run stopped, so the document can be
    written again."""
    api_key(monkeypatch, [text("Wrote it more plainly.")])
    runtime.ensure(CORPUS)
    ans = await write_session.start(CORPUS, "report", "Say this more plainly.")
    chat = str((subagents.agent(CORPUS, str(ans.agent_id)) or {}).get("chat"))
    await kill_server(monkeypatch)
    assert write_session.running(CORPUS, "report") and agents.read_meta(CORPUS, chat)["status"] == "running"
    runtime.ensure(CORPUS)
    assert not write_session.running(CORPUS, "report"), "no process runs it"
    assert agents.read_meta(CORPUS, chat)["status"] == "stopped"
    again = await write_session.start(CORPUS, "report", "Say this more plainly.")
    assert again.started, again.reason
    await runtime._spaces[CORPUS].convs[str(again.agent_id)].task


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


# --------------------------------------------------------------------------- rewind


def analyst_messages() -> list[tuple[int, str, str]]:
    """(place, words, event id) of each message the analyst sent main from the page that the chat still shows."""
    recs = main_records()
    hidden = runtime.rewound(recs)
    return [(i, r["text"], r["event"]) for i, r in enumerate(recs)
            if i not in hidden and r["type"] == "user" and r.get("by") == agents.BROWSER]


async def test_a_rewind_cuts_main_s_conversation_before_the_message_and_hides_it_and_what_came_after(on, monkeypatch):
    client = api_key(monkeypatch, [text("Two incidents."), text("The second was worse."), text("Yes."),
                                   text("Three incidents, counting the outage.")])
    for words in ("What happened?", "Which was worse?", "Sure?"):
        await main_turn(words)
    second = analyst_messages()[1]
    got = await runtime.rewind_main(CORPUS, second[2])
    assert got == {"text": "Which was worse?", "event": second[2]}  # the words go back in the composer
    recs = main_records()
    assert recs[-1]["type"] == "chip" and recs[-1]["kind"] == runtime.REWIND_CHIP and recs[-1]["event"] == second[2]
    # the page shows the first turn alone, then the rewind's line
    assert runtime.rewound(recs) == set(range(second[0], len(recs) - 1))
    assert [w for _, w, _ in analyst_messages()] == ["What happened?"]
    await main_turn("Count the outage too?")
    sent = asked(client, 3)
    assert "What happened?" in sent and "Two incidents." in sent
    assert "Which was worse?" not in sent and "Sure?" not in sent and "worse." not in sent
    assert [w for _, w, _ in analyst_messages()] == ["What happened?", "Count the outage too?"]
    # a message a rewind hid is no place to rewind to
    with pytest.raises(runtime.RewindRefused):
        await runtime.rewind_main(CORPUS, second[2])
