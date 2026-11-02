"""A message the analyst sends while main works, on the server that runs main (runtime.py, B14). It reaches main at the
turn's next tool call, as Claude Code gives a message typed mid-turn to the model: on the Messages API with the call's
results (runtime_api's loop), on the Claude Code sign-in through main's session at once (runtime_cc._hand), which
Claude Code reads at its next tool call, or as its next turn when the reply ends first, and echoes once read. Until main
reads it, main's chat shows it waiting (its meta's `unread`) and logs nothing of it, so the rest of the turn does not
read as its answer; then the chat logs it there. The analyst's Stop keeps it, as main's next turn. The Messages API is
test_runtime's fake client and the Agent SDK a fake ClaudeSDKClient that takes what it is sent: no model is called and
no `claude` starts."""
from __future__ import annotations

import asyncio
import json
from typing import Any

from app import agents, claude_access, config, events, llm, runtime, session
from test_runtime import CORPUS, FakeClient, Final, Hang, api_key, call, main_records, main_turn, on, shape, text, until  # noqa: F401

FIRST = "What happened?"
SECOND = "And how many files are there?"


def transcript() -> list[dict[str, Any]]:
    return [json.loads(ln) for ln in runtime._spaces[CORPUS].main_path.read_text("utf-8").splitlines()]


async def page_unread() -> list[str]:
    """The messages main's chat shows waiting, as the page reads them (agents.main_route, meta `unread`)."""
    return [m["text"] for m in json.loads((await agents.main_route(CORPUS)).body)["meta"]["unread"]]


# --------------------------------------------------------------------------- the Messages API


async def test_a_message_sent_while_main_works_reaches_it_with_the_results_of_its_next_tool_call(on, monkeypatch):
    """The second message goes to the model with the results of the call that ran while it was sent, in the same turn,
    and main's chat logs it there, after the call; until then the chat shows it waiting and logs nothing of it."""
    meanwhile: dict[str, Any] = {}

    def ask_again_while_it_works(body: dict[str, Any]) -> list[Any]:
        events.post(CORPUS, "main", {"text": SECOND})
        meanwhile["unread"] = [m["text"] for m in runtime.unread(CORPUS)]
        meanwhile["logged"] = [r.get("text") for r in main_records() if r["type"] == "user"]
        return call("list_cards", {"group": "all"})

    client = api_key(monkeypatch, [ask_again_while_it_works, text("Nothing broke, and there are 12 files.")])
    await main_turn(FIRST)
    assert meanwhile == {"unread": [SECOND], "logged": [FIRST]}, "it waits, and is no line of the chat yet"
    assert len(client.bodies) == 2, "no turn of its own"
    last = client.bodies[1]["messages"][-1]["content"]
    assert [b["type"] for b in last] == ["tool_result", "text"]
    assert SECOND in last[1]["text"] and 'kind="main"' in last[1]["text"]
    assert shape(main_records()) == [("user", FIRST), ("tool_use", "list_cards"), ("tool_result", ""), ("user", SECOND),
                                     ("text", "Nothing broke, and there are 12 files."), ("done", "")]
    queued = [r["attachment"] for r in transcript() if r.get("type") == "attachment"]
    assert [a["type"] for a in queued] == ["queued_command"] and SECOND in queued[0]["prompt"]
    assert await page_unread() == [] and not runtime._spaces[CORPUS].main.queue


async def test_a_message_sent_as_main_ends_its_reply_is_its_next_turn(on, monkeypatch):
    """A message that comes while the turn's last reply is written has no tool call to ride on: it waits, shown so, and
    is main's next turn, whose start logs it."""
    meanwhile: dict[str, Any] = {}

    def ask_again_as_it_answers(body: dict[str, Any]) -> list[Any]:
        events.post(CORPUS, "main", {"text": SECOND})
        meanwhile["unread"] = [m["text"] for m in runtime.unread(CORPUS)]
        return text("Nothing broke.")

    client = api_key(monkeypatch, [ask_again_as_it_answers, text("There are 12 files.")])
    await main_turn(FIRST)
    await runtime._spaces[CORPUS].main.task
    assert meanwhile["unread"] == [SECOND]
    assert SECOND in json.dumps(client.bodies[1]["messages"][-1])
    assert shape(main_records()) == [("user", FIRST), ("text", "Nothing broke."), ("done", ""), ("user", SECOND),
                                     ("text", "There are 12 files."), ("done", "")]
    assert await page_unread() == []


class HangFirst(FakeClient):
    """The first reply never comes, as a long turn's; the later ones are the scripted replies."""

    def stream(self, **body: Any) -> Any:
        if not self.bodies:
            self.bodies.append(json.loads(json.dumps(body, default=str)))
            return Hang(Final([], "end_turn"))
        return super().stream(**body)


async def test_stop_keeps_a_message_that_waited_and_main_answers_it_next(on, monkeypatch, analyst):
    """Stop no longer drops what waited for the stopped turn: once the turn has ended in main's chat with its note, the
    message the analyst sent while it ran is main's next turn, which hears that the turn before was stopped."""
    claude_access.save(claude_access.API_KEY, key="sk-ant-test-key")
    client = HangFirst([text("There are 12 files.")])
    monkeypatch.setattr(llm, "client", lambda: client)
    events.post(CORPUS, "main", {"text": FIRST})
    await until(lambda: client.bodies, "main's first request was not sent")
    events.post(CORPUS, "main", {"text": SECOND})
    assert await page_unread() == [SECOND]
    assert await agents.interrupt_route(CORPUS, agents.MAIN_ID, analyst) == {"stopped": True}
    await runtime._spaces[CORPUS].main.task
    assert len(client.bodies) == 2
    asked = json.dumps(client.bodies[1]["messages"][-1])
    assert SECOND in asked and runtime.NOTES_HEAD in asked, "the turn hears of the Stop"
    got = shape(main_records())
    assert got[0] == ("user", FIRST)
    assert got.index(("chip", session.STOPPED_TEXT)) < got.index(("user", SECOND)) < got.index(("text", "There are 12 files."))
    assert got[-1] == ("done", "") and await page_unread() == []


# --------------------------------------------------------------------------- the Claude Code sign-in


def fake_cc(monkeypatch, play: Any) -> list["CCClient"]:
    """The Agent SDK as CCClient playing `play(client)`, the session's messages; the clients made, in order. A second
    session fails at once, so a message that waits for a turn of its own ends the test quickly."""
    import claude_agent_sdk as sdk_mod

    made: list[CCClient] = []

    class Client(CCClient):
        def __init__(self, options: Any) -> None:
            super().__init__(options, play if not made else no_second_session)
            made.append(self)

    monkeypatch.setattr(sdk_mod, "ClaudeSDKClient", Client)
    monkeypatch.setattr(sdk_mod, "create_sdk_mcp_server", lambda name, version="1.0.0", tools=None: {
        "type": "sdk", "name": name, "instance": None})
    monkeypatch.setattr(config, "CLI_PATH", "/bin/true")
    claude_access.save(claude_access.CLAUDE_CODE, consent=True)
    return made


class CCClient:
    """A headless Claude Code session through the Agent SDK: what it is sent waits in `sent` (the turn's prompt, then each
    message handed to it, with its uuid), and `play(client)` gives the session's messages, which receive_response yields
    up to each ResultMessage."""

    def __init__(self, options: Any, play: Any) -> None:
        self.options, self.play, self.stream = options, play, None
        self.sent: asyncio.Queue = asyncio.Queue()

    async def __aenter__(self) -> "CCClient":
        return self

    async def __aexit__(self, *a: Any) -> None:
        return None

    async def query(self, prompt: Any) -> None:
        if isinstance(prompt, str):
            await self.sent.put({"message": {"content": prompt}})
            return
        async for m in prompt:
            await self.sent.put(m)

    async def receive_response(self):  # noqa: ANN201
        from claude_agent_sdk import ResultMessage

        if self.stream is None:
            self.stream = self.play(self)
        while True:
            try:
                m = await self.stream.__anext__()
            except StopAsyncIteration:
                return
            yield m
            if isinstance(m, ResultMessage):
                return


def result(turns: int = 1) -> Any:
    from claude_agent_sdk import ResultMessage

    return ResultMessage(subtype="success", duration_ms=1, duration_api_ms=1, is_error=False, num_turns=turns,
                         session_id="sess-1")


async def no_second_session(client: CCClient):  # noqa: ANN201
    from claude_agent_sdk import ResultMessage

    await client.sent.get()
    yield ResultMessage(subtype="error_during_execution", duration_ms=1, duration_api_ms=1, is_error=True, num_turns=0,
                        session_id="sess-2", result="a second session")


async def test_on_claude_code_sign_in_a_message_sent_while_main_works_goes_to_its_session_at_once(on, monkeypatch):
    """Main's session gets the message as it comes, while a call runs; Claude Code reads it with the call's result and
    echoes it (`replay-user-messages`), which is where main's chat logs it, in the same turn."""
    from claude_agent_sdk import AssistantMessage, SystemMessage, TextBlock, ToolResultBlock, ToolUseBlock, UserMessage

    meanwhile: dict[str, Any] = {}

    async def play(client: CCClient):  # noqa: ANN202
        await client.sent.get()
        yield SystemMessage(subtype="init", data={"session_id": "sess-1"})
        yield AssistantMessage(content=[ToolUseBlock(id="toolu_r", name="Read", input={"file_path": "notes.txt"})],
                               model="claude-opus-5-5")
        events.post(CORPUS, "main", {"text": SECOND})  # the analyst writes while the call runs
        meanwhile["unread"] = [m["text"] for m in runtime.unread(CORPUS)]
        handed = await asyncio.wait_for(client.sent.get(), 5)
        meanwhile["handed"] = handed
        yield UserMessage(content=[ToolResultBlock(tool_use_id="toolu_r", content="12 files")])
        yield UserMessage(content=handed["message"]["content"], uuid=handed["uuid"])
        yield AssistantMessage(content=[TextBlock(text="Nothing broke, and there are 12 files.")], model="claude-opus-5-5")
        yield result(2)

    made = fake_cc(monkeypatch, play)
    await main_turn(FIRST)
    assert "replay-user-messages" in made[0].options.extra_args
    assert meanwhile["unread"] == [SECOND]
    assert SECOND in meanwhile["handed"]["message"]["content"] and meanwhile["handed"]["uuid"]
    assert len(made) == 1
    assert shape(main_records()) == [("user", FIRST), ("tool_use", "Read"), ("tool_result", ""), ("user", SECOND),
                                     ("text", "Nothing broke, and there are 12 files."), ("done", "")]
    assert await page_unread() == [] and not runtime._spaces[CORPUS].main.queue


async def test_on_claude_code_sign_in_a_message_its_session_got_as_the_reply_ended_is_read_as_its_next_turn(
        on, monkeypatch):
    """Claude Code runs a message it got as the turn's reply ended as the session's next turn: main's turn goes on into
    it, and the chat logs the message where the session echoes it."""
    from claude_agent_sdk import AssistantMessage, SystemMessage, TextBlock, UserMessage

    async def play(client: CCClient):  # noqa: ANN202
        await client.sent.get()
        yield SystemMessage(subtype="init", data={"session_id": "sess-1"})
        yield AssistantMessage(content=[TextBlock(text="Nothing broke.")], model="claude-opus-5-5")
        events.post(CORPUS, "main", {"text": SECOND})  # the analyst writes as main ends its reply
        handed = await asyncio.wait_for(client.sent.get(), 5)
        yield result()
        yield SystemMessage(subtype="init", data={"session_id": "sess-1"})
        yield UserMessage(content=handed["message"]["content"], uuid=handed["uuid"])
        yield AssistantMessage(content=[TextBlock(text="There are 12 files.")], model="claude-opus-5-5")
        yield result()

    made = fake_cc(monkeypatch, play)
    await main_turn(FIRST)
    assert len(made) == 1
    assert shape(main_records()) == [("user", FIRST), ("text", "Nothing broke."), ("user", SECOND),
                                     ("text", "There are 12 files."), ("done", "")]
    assert await page_unread() == [] and not runtime._spaces[CORPUS].main.queue
