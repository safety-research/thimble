"""Rewind main to one of the analyst's messages (runtime.rewind_main) on the server that runs main, with what 0.10.8
added beside it: a message the analyst sends while main works waits for main's next tool call (B14), an ask before a
request to a host waits on the chat on Claude Code sign-in (B15), and the server opens its own files in a workspace as
nofollow opens them. Nothing the analyst typed is lost: a message that waits comes back in the composer after the
rewound message's words, and so does the event of a message the rewind hides that main never read; the rewind's line
keeps those words too, for a page that never got its reply; every other event that waits is main's next turn, as after
a Stop, also when a step after the cut fails; an ask that waits on main ends with the stopped turn, unanswered. A
message main read mid-turn is cut where main read it, and the quiet events that rode along with the rewound message
wait again. A rewind goes back only within main's current chat, and a /thimble-fix it takes back starts no fix. The
Messages API is test_runtime's fake client and the Agent SDK a fake ClaudeSDKClient: no model is called and no `claude`
starts."""
from __future__ import annotations

import asyncio
import json
import uuid
from pathlib import Path
from typing import Any

import pytest
from fastapi import HTTPException

from app import (agents, claude_access, events, fixes, host_asks, llm, marks, proposer, runtime, runtime_api,
                 runtime_cc, session)
from test_main_waits import FIRST, SECOND, CCClient, HangFirst, fake_cc, page_unread, result
from test_runtime import (CORPUS, FakeClient, Final, Hang, api_key, call, cc_record, cc_transcript,  # noqa: F401
                          claude_config, fake_sdk, main_records, main_turn, on, shape, text, until)

HOST = "data.example-lab.test"
FIX_SAID, FIX_WORDS = "/thimble-fix make the legend name the rows", "make the legend name the rows"


@pytest.fixture(autouse=True)
def _no_asks():
    host_asks._waits.clear()
    yield
    host_asks._waits.clear()


@pytest.fixture(autouse=True)
def _no_fix_words():
    """No /thimble-fix of an earlier test waits for main or is one fix_thimble may take (fixes._waiting, _asked)."""
    fixes._asked.pop(CORPUS, None)
    fixes._waiting.pop(CORPUS, None)
    yield
    fixes._asked.pop(CORPUS, None)
    fixes._waiting.pop(CORPUS, None)


def post_fix(eid: str) -> None:
    """The person's /thimble-fix, posted as fixes.ask posts it (the fixes are off in these tests, so ask refuses): the
    words wait for the turn of main's that reads them (fixes._waiting), the chat logs the line, and main gets the
    request as its event."""
    fixes._waiting.setdefault(CORPUS, {})[eid] = fixes._Asking(FIX_WORDS, "")
    agents.mirror(CORPUS, "user", by=agents.BROWSER, text=FIX_SAID, event=eid)
    events.post(CORPUS, "main", {"text": "Make the legend name the rows."}, mirror=False, line=FIX_SAID, event_id=eid)


def shown() -> list[tuple[str, str]]:
    """(words, event id) of each message of the analyst's that main's chat shows, oldest first."""
    recs = main_records()
    hidden = runtime.rewound(recs)
    return [(r["text"], r["event"]) for i, r in enumerate(recs) if i not in hidden and runtime._analyst_message(r)]


def hanging(monkeypatch, replies: list[Any]) -> Any:
    """The Messages API on an API key, whose first reply never comes, as a long turn's: main runs until it stops."""
    claude_access.save(claude_access.API_KEY, key="sk-ant-test-key")
    client = HangFirst(replies)
    monkeypatch.setattr(llm, "client", lambda: client)
    return client


async def first_turn_runs(client: Any) -> str:
    """FIRST sent, and main's turn on it running: FIRST's event id."""
    events.post(CORPUS, "main", {"text": FIRST})
    await until(lambda: client.bodies, "main's first request was not sent")
    return shown()[0][1]


# --------------------------------------------------------------------------- what waits for main


async def test_a_message_that_waits_for_main_comes_back_in_the_composer_with_the_rewound_one(on, monkeypatch):
    """The analyst sends a second message while main's turn on the first runs: it waits (unread). A rewind to the first
    stops the turn and takes both back: their words come back for the composer, the first's then the second's, the chat
    shows the second waiting no more and logs no line of it, and Claude never gets it."""
    client = hanging(monkeypatch, [text("Two incidents.")])
    first = await first_turn_runs(client)
    events.post(CORPUS, "main", {"text": SECOND})
    assert await page_unread() == [SECOND]
    got = await runtime.rewind_main(CORPUS, first)
    assert got == {"text": f"{FIRST}\n\n{SECOND}", "event": first}
    sp = runtime._spaces[CORPUS]
    assert await page_unread() == [] and not sp.main.queue and not sp.said and not sp.main.running
    assert ("user", SECOND) not in shape(main_records()) and shown() == []
    await main_turn("What happened, in one line?")
    sent = json.dumps(client.bodies[-1]["messages"])
    assert "in one line" in sent and FIRST not in sent and SECOND not in sent


async def test_the_event_of_a_message_the_rewind_hides_that_main_never_read_leaves_main_s_queue_too(on, monkeypatch):
    """A message the chat logs as it is posted, such as a /thimble-fix (fixes.py logs its line, then posts its event),
    waits for the end of main's running turn, unread. A rewind to the message of that turn hides it, and its event
    leaves main's queue with its words, which come back after the rewound message's."""
    client = hanging(monkeypatch, [])
    first = await first_turn_runs(client)
    said, eid = "/thimble-fix make the legend name the rows", "f1c5e0a7"
    agents.mirror(CORPUS, "user", by=agents.BROWSER, text=said, event=eid)
    events.post(CORPUS, "main", {"text": "Make the legend name the rows."}, mirror=False, line=said, event_id=eid)
    sp = runtime._spaces[CORPUS]
    assert len(sp.main.queue) == 1 and [w for w, _ in shown()] == [FIRST, said]
    got = await runtime.rewind_main(CORPUS, first)
    assert got["text"] == f"{FIRST}\n\n{said}"
    assert not sp.main.queue and not sp.main.running and shown() == []
    assert len(client.bodies) == 1, "Claude never got it"


async def test_an_event_that_is_no_message_of_the_analyst_s_stays_and_is_main_s_next_turn(on, monkeypatch):
    """A notice that waits for main's turn to end, such as a check's end, is nothing the analyst typed: the rewind
    leaves it waiting, and it is main's next turn, as after a Stop, on the conversation the rewind cut."""
    client = hanging(monkeypatch, [text("The check left two comments.")])
    first = await first_turn_runs(client)
    events.post(CORPUS, "checked", {"text": "The check of the report ended: 2 comments.", "check": "unverified"})
    assert len(runtime._spaces[CORPUS].main.queue) == 1
    got = await runtime.rewind_main(CORPUS, first)
    assert got["text"] == FIRST
    sp = runtime._spaces[CORPUS]
    assert sp.main.running, "the notice is main's next turn"
    await sp.main.task
    sent = json.dumps(client.bodies[-1]["messages"])
    assert "2 comments" in sent and FIRST not in sent
    rows = shape(main_records())
    assert rows.index(("chip", runtime.REWOUND)) < rows.index(("text", "The check left two comments."))


async def test_the_quiet_events_a_message_carried_wait_again_for_main_s_next_event(on, monkeypatch):
    """A quiet event (events.QUIET_KINDS) rides along with main's next event, here a message the analyst sends while
    main works. A rewind takes that message back unread, and the quiet event waits again, so main reads it with the
    analyst's next message."""
    client = hanging(monkeypatch, [text("Noted.")])
    first = await first_turn_runs(client)
    events.post(CORPUS, "citations", {"text": '"302 of 439" is corrected to "319 of 460"'})
    events.post(CORPUS, "main", {"text": SECOND})
    assert events.held(CORPUS) == [], "it rides along with the message"
    await runtime.rewind_main(CORPUS, first)
    assert [n["meta"]["kind"] for n in events.held(CORPUS)] == ["citations"]
    await main_turn("And now?")
    last = json.dumps(client.bodies[-1]["messages"][-1])
    assert "319 of 460" in last and events.MEANWHILE in last and SECOND not in last


async def test_the_quiet_events_that_rode_along_with_the_rewound_message_wait_again_for_main_s_next_event(
        on, monkeypatch):
    """A quiet event that comes while main is idle rides along with the analyst's next message, whose turn reads it. A
    rewind to that message cuts the prompt that carried it, and the quiet event, which came before the message, waits
    again, so main reads it with the analyst's next message."""
    client = api_key(monkeypatch, [text("Two incidents."), text("Noted.")])
    events.post(CORPUS, "citations", {"text": '"302 of 439" is corrected to "319 of 460"'})
    await main_turn(FIRST)
    assert "319 of 460" in json.dumps(client.bodies[0]["messages"]) and events.held(CORPUS) == []
    await runtime.rewind_main(CORPUS, shown()[0][1])
    assert [n["meta"]["kind"] for n in events.held(CORPUS)] == ["citations"]
    await main_turn("And now?")
    sent = json.dumps(client.bodies[-1]["messages"])
    assert "319 of 460" in sent and events.MEANWHILE in sent and FIRST not in sent


async def test_the_rewind_s_line_keeps_the_words_it_gives_back(on, monkeypatch):
    """The words a rewind gives back for the composer are in its reply and on its line in main's chat, so a page that
    never got the reply (closed or reloaded while main's turn stopped) puts them back from the line."""
    client = hanging(monkeypatch, [])
    first = await first_turn_runs(client)
    events.post(CORPUS, "main", {"text": SECOND})
    got = await runtime.rewind_main(CORPUS, first)
    lines = [r for r in main_records() if r.get("kind") == runtime.REWIND_CHIP]
    assert [(r["event"], r["words"]) for r in lines] == [(first, got["text"])]
    assert got["text"] == f"{FIRST}\n\n{SECOND}"


# --------------------------------------------------------------------------- a request cancelled, a step that fails


async def test_a_rewind_whose_request_is_cancelled_while_main_s_turn_stops_cuts_and_takes_back_nothing(on, monkeypatch):
    """The rewind waits for main's running turn to stop. When the request itself is cancelled meanwhile (the server
    stops, the page's connection goes), the rewind goes no further: nothing is cut or taken back and no line is
    written. Main's turn ends stopped, as after a Stop, and the message that waited for it is main's next turn."""
    stopping = asyncio.Event()

    class StopsSlowly(Hang):
        async def __anext__(self) -> Any:
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                stopping.set()
                await asyncio.Event().wait()  # until a second cancel: the turn takes its time to stop
            raise StopAsyncIteration

    class Client(FakeClient):
        def stream(self, **body: Any) -> Any:
            if not self.bodies:
                self.bodies.append(json.loads(json.dumps(body, default=str)))
                return StopsSlowly(Final([], "end_turn"))
            return super().stream(**body)

    claude_access.save(claude_access.API_KEY, key="sk-ant-test-key")
    client = Client([text("There are 12 files.")])
    monkeypatch.setattr(llm, "client", lambda: client)
    first = await first_turn_runs(client)
    events.post(CORPUS, "main", {"text": SECOND})
    rewind = asyncio.ensure_future(runtime.rewind_main(CORPUS, first))
    await asyncio.wait_for(stopping.wait(), 5)
    rewind.cancel()
    with pytest.raises(asyncio.CancelledError):
        await rewind
    await until(lambda: len(client.bodies) == 2, "the message that waited was not main's next turn")
    await runtime._spaces[CORPUS].main.task
    sent = json.dumps(client.bodies[1]["messages"])
    assert FIRST in sent and SECOND in sent, "nothing was cut or taken back"
    rows = shape(main_records())
    assert not [r for r in main_records() if r.get("kind") == runtime.REWIND_CHIP]
    assert [w for w, _ in shown()] == [FIRST, SECOND]
    assert rows.index(("chip", session.STOPPED_TEXT)) < rows.index(("user", SECOND))


async def test_a_rewind_whose_line_cannot_be_written_still_gives_the_words_back_and_main_goes_on(on, monkeypatch,
                                                                                                 caplog):
    """Once main's conversation is cut, a step after it that fails, such as writing the rewind's line on a full disk,
    loses nothing: the words come back for the composer all the same, the failure is logged, and what else waited for
    main is its next turn, as after a Stop."""
    client = hanging(monkeypatch, [text("The check left two comments.")])
    first = await first_turn_runs(client)
    events.post(CORPUS, "main", {"text": SECOND})
    events.post(CORPUS, "checked", {"text": "The check of the report ended: 2 comments.", "check": "unverified"})
    real = agents.chip

    def full(c: str, kind: str, text: str, **fields: Any) -> Any:
        if kind == runtime.REWIND_CHIP:
            raise OSError(28, "No space left on device")
        return real(c, kind, text, **fields)

    monkeypatch.setattr(agents, "chip", full)
    got = await runtime.rewind_main(CORPUS, first)
    assert got == {"text": f"{FIRST}\n\n{SECOND}", "event": first}
    assert any(r.name == "thimble.runtime" and r.exc_info for r in caplog.records), "the failure is logged"
    sp = runtime._spaces[CORPUS]
    assert sp.main.running, "the notice is main's next turn"
    await sp.main.task
    sent = json.dumps(client.bodies[-1]["messages"])
    assert "2 comments" in sent and FIRST not in sent and SECOND not in sent


async def test_when_the_quiet_events_cannot_wait_again_the_message_that_carries_them_stays_for_main(on, monkeypatch):
    """A message the rewind takes back leaves main's queue only once the quiet events it carries wait again
    (events.hold_again). When they cannot, it stays, with its line and the quiet events in it, and is main's next turn:
    nothing is lost, and the rewound message's words alone come back."""
    client = hanging(monkeypatch, [text("Noted.")])
    first = await first_turn_runs(client)
    events.post(CORPUS, "citations", {"text": '"302 of 439" is corrected to "319 of 460"'})
    events.post(CORPUS, "main", {"text": SECOND})

    def cannot(c: str, notes: list[dict[str, Any]]) -> None:
        raise OSError(28, "No space left on device")

    monkeypatch.setattr(events, "hold_again", cannot)
    got = await runtime.rewind_main(CORPUS, first)
    assert got["text"] == FIRST
    await runtime._spaces[CORPUS].main.task
    sent = json.dumps(client.bodies[-1]["messages"])
    assert SECOND in sent and "319 of 460" in sent and FIRST not in sent
    assert [w for w, _ in shown()] == [SECOND]


# --------------------------------------------------------------------------- main's chats and the /thimble-fix


async def test_a_message_of_an_earlier_chat_of_main_is_no_place_to_rewind_to(on, monkeypatch, analyst):
    """Main's log holds its chats one after another, each from the line where it starts or comes back (Space.switch),
    and main's conversation is the latest one's. A rewind goes back only within it: a message of an earlier chat is
    refused with one line that says so (409), and nothing changes; one after the latest chat line rewinds."""
    api_key(monkeypatch, [text("Two incidents."), text("The second."), text("Three runs failed.")])
    for words in (FIRST, "Which was worse?"):
        await main_turn(words)
    sp = runtime._spaces[CORPUS]
    assert await sp.switch(None)
    await main_turn("How many runs failed?")
    state = sp.main.state_path("api").read_text()
    before = main_records()
    with pytest.raises(HTTPException) as e:
        await agents.rewind_route(CORPUS, agents.RewindBody(event=shown()[1][1]), analyst)
    assert e.value.status_code == 409 and e.value.detail == runtime.EARLIER_CHAT
    assert main_records() == before and sp.main.state_path("api").read_text() == state
    got = await runtime.rewind_main(CORPUS, shown()[2][1])
    assert got["text"] == "How many runs failed?"
    assert [w for w, _ in shown()] == [FIRST, "Which was worse?"]


async def test_a_thimble_fix_the_rewind_takes_back_is_one_no_fix_starts_from(on, monkeypatch):
    """Main's turn reads the person's /thimble-fix, so fix_thimble may take its words in that turn and the next one
    (fixes.words_read). A rewind to that message takes the words back: fix_thimble then answers as when no /thimble-fix
    was asked. So does a /thimble-fix that waited for main's turn when a rewind took it back."""
    client = api_key(monkeypatch, [text("Is this about one of your fixes, or a new fix?")])
    post_fix("f1c5e0a7")
    sp = runtime._spaces[CORPUS]
    await sp.main.task
    sp.read()
    assert fixes._asked[CORPUS].words == FIX_WORDS
    await runtime.rewind_main(CORPUS, "f1c5e0a7")
    with pytest.raises(HTTPException) as e:
        await fixes.from_tool(CORPUS, "new")
    assert e.value.status_code == 409 and e.value.detail == fixes.NOT_ASKED
    # one that waits for main's running turn
    client = hanging(monkeypatch, [])
    first = await first_turn_runs(client)
    post_fix("f2d6e1b8")
    assert list(fixes._waiting[CORPUS]) == ["f2d6e1b8"]
    assert (await runtime.rewind_main(CORPUS, first))["text"] == f"{FIRST}\n\n{FIX_SAID}"
    assert not fixes._waiting.get(CORPUS) and CORPUS not in fixes._asked


# --------------------------------------------------------------------------- a message main read mid-turn


async def test_a_message_main_read_mid_turn_is_cut_where_main_read_it_and_the_call_before_it_keeps_its_result(
        on, monkeypatch):
    """On the Messages API main reads a message sent while its tool call ran with the call's result, in one user message
    (Conv.take_waiting). A rewind to it cuts that user message after the result, which stays, since the call ran: the
    next turn sends the call with its own result, and neither the message nor the reply that read it."""
    def ask_again_while_it_works(body: dict[str, Any]) -> list[Any]:
        events.post(CORPUS, "main", {"text": SECOND})
        return call("list_cards", {"group": "all"})

    client = api_key(monkeypatch, [ask_again_while_it_works, text("Nothing broke, and there are 12 files."),
                                   text("Two groups.")])
    await main_turn(FIRST)
    second = shown()[1][1]
    assert (await runtime.rewind_main(CORPUS, second))["text"] == SECOND
    assert [w for w, _ in shown()] == [FIRST]
    await main_turn("Which groups are there?")
    sent = client.bodies[-1]["messages"]
    assert [m["role"] for m in sent] == ["user", "assistant", "user", "user"]
    assert [b["type"] for b in sent[1]["content"]] == ["tool_use"]
    assert [b["type"] for b in sent[2]["content"]] == ["tool_result"]
    assert runtime_api.STOPPED not in json.dumps(sent), "the call ran: its own result stays"
    assert SECOND not in json.dumps(sent) and "12 files" not in json.dumps(sent)


async def test_on_claude_code_sign_in_a_message_read_mid_turn_is_cut_before_the_entry_claude_code_keeps_it_as(
        on, monkeypatch, claude_config):
    """Claude Code keeps a message its session read mid-turn as a queued_command attachment, after the result of the
    call it rode on, not as a prompt of its own. A rewind to it resumes the session up to that result, as a fork."""
    from claude_agent_sdk import AssistantMessage, SystemMessage, TextBlock, ToolResultBlock, ToolUseBlock, UserMessage

    sent: list[dict[str, Any]] = []

    async def play(client: CCClient):  # noqa: ANN202
        sent.append(await client.sent.get())
        yield SystemMessage(subtype="init", data={"session_id": "sess-1"})
        yield AssistantMessage(content=[ToolUseBlock(id="toolu_r", name="Read", input={"file_path": "notes.txt"})],
                               model="claude-opus-5-5")
        events.post(CORPUS, "main", {"text": SECOND})  # the analyst writes while the call runs
        sent.append(await asyncio.wait_for(client.sent.get(), 5))
        yield UserMessage(content=[ToolResultBlock(tool_use_id="toolu_r", content="12 files")])
        yield UserMessage(content=sent[1]["message"]["content"], uuid=sent[1]["uuid"])
        yield AssistantMessage(content=[TextBlock(text="Nothing broke, and there are 12 files.")],
                               model="claude-opus-5-5")
        yield result(2)

    fake_cc(monkeypatch, play)
    await main_turn(FIRST)
    cc_transcript("sess-1", [
        cc_record("user", "u0", sent[0]["message"]["content"]),
        cc_record("assistant", "a0", [{"type": "tool_use", "id": "toolu_r", "name": "Read", "input": {}}]),
        cc_record("user", "r0", [{"type": "tool_result", "tool_use_id": "toolu_r", "content": "12 files"}]),
        cc_record("attachment", "q0", sent[1]["message"]["content"]),
        cc_record("assistant", "a1", [{"type": "text", "text": "Nothing broke, and there are 12 files."}])])
    sp = runtime._spaces[CORPUS]
    assert (await runtime.rewind_main(CORPUS, shown()[1][1]))["text"] == SECOND
    assert json.loads(sp.main.state_path("cc").read_text()) == {"session_id": "sess-1", "resume_at": "r0"}
    opts = runtime_cc.options(sp.main, sp.main.spec(), {})
    assert (opts.resume, opts.resume_session_at, opts.fork_session) == ("sess-1", "r0", True)


# --------------------------------------------------------------------------- an ask that waits


async def test_an_ask_about_a_host_that_waits_on_main_s_chat_ends_unanswered_with_the_rewound_turn(
        on, monkeypatch, claude_config):
    """On Claude Code sign-in main's command waits on an ask about a host when the analyst rewinds to the message whose
    turn runs it: the rewind stops the turn, and the ask leaves main's chat with the session, unanswered, as a Stop
    ends it, so no host is allowed or kept. The analyst typed nothing there."""
    from claude_agent_sdk import AssistantMessage, SystemMessage, ToolPermissionContext, ToolUseBlock

    prompts: list[str] = []
    asking: list[asyncio.Future] = []
    command = {"command": f"curl -s https://{HOST}/runs.csv", "description": "Fetch the runs table"}

    async def play(client: CCClient):  # noqa: ANN202
        prompts.append((await client.sent.get())["message"]["content"])
        yield SystemMessage(subtype="init", data={"session_id": "sess-1"})
        yield AssistantMessage(content=[ToolUseBlock(id="toolu_b", name="Bash", input=command)],
                               model="claude-opus-5-5")
        pre = client.options.hooks["PreToolUse"][0].hooks[0]
        await pre({"hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": command}, "toolu_b",
                  {"signal": None})
        # Claude Code's sandbox asks the session's callback about the host, in a task of the Agent SDK's own
        ctx = ToolPermissionContext(tool_use_id=str(uuid.uuid4()))
        client.spawned = [asyncio.ensure_future(client.options.can_use_tool(host_asks.TOOL, {"host": HOST}, ctx))]
        asking.extend(client.spawned)
        await asyncio.Event().wait()  # the command waits for the answer, and the turn with it

    async def close(self: CCClient, *_a: Any) -> None:  # the Agent SDK cancels the session's callbacks as it closes
        for task in getattr(self, "spawned", []):
            task.cancel()

    monkeypatch.setattr(CCClient, "__aexit__", close)
    fake_cc(monkeypatch, play)
    events.post(CORPUS, "main", {"text": FIRST})
    await until(lambda: host_asks.waiting(CORPUS, agents.MAIN_ID), "no ask showed on main's chat")
    assert host_asks.waiting(CORPUS, agents.MAIN_ID)[0]["call"]["input"] == command
    cc_transcript("sess-1", [cc_record("user", "u0", prompts[0])])
    assert (await runtime.rewind_main(CORPUS, shown()[0][1]))["text"] == FIRST
    await until(lambda: asking[0].done(), "the ask's callback went on after its session")
    assert asking[0].cancelled() and host_asks.waiting(CORPUS, agents.MAIN_ID) == []
    assert host_asks.kept(CORPUS) == []
    sp = runtime._spaces[CORPUS]
    assert not sp.main.running and not sp.main.state_path("cc").exists(), "the first message: no session is left"


# --------------------------------------------------------------------------- refusals and untrusted files


async def test_a_session_thimble_cannot_read_refuses_the_rewind_before_main_s_turn_stops(on, monkeypatch,
                                                                                         claude_config):
    """On Claude Code sign-in the rewind reads the session's transcript first: when there is none to read, it refuses,
    and nothing changes, main's running turn and the message that waits for it included."""
    from claude_agent_sdk import SystemMessage

    async def play(client: CCClient):  # noqa: ANN202
        await client.sent.get()
        yield SystemMessage(subtype="init", data={"session_id": "sess-gone"})
        await asyncio.Event().wait()

    fake_cc(monkeypatch, play)
    events.post(CORPUS, "main", {"text": FIRST})
    sp = runtime._spaces[CORPUS]
    await until(lambda: sp.main.state_path("cc").exists(), "the session did not start")
    events.post(CORPUS, "main", {"text": SECOND})
    before = main_records()
    with pytest.raises(runtime.RewindRefused):
        await runtime.rewind_main(CORPUS, shown()[0][1])
    assert sp.main.running and await page_unread() == [SECOND] and main_records() == before
    assert json.loads(sp.main.state_path("cc").read_text()) == {"session_id": "sess-gone"}
    await runtime.abort_main(CORPUS)


def _outside(tmp_path_factory) -> Path:
    """A folder outside the workspace that holds a made-up file of the person's."""
    d = tmp_path_factory.mktemp("outside-the-workspace").resolve()
    (d / "made-up-dotfile").write_text("# the person's own\n")
    return d


async def test_the_rewind_reads_and_removes_main_s_files_through_no_link_a_card_left(on, monkeypatch, claude_config,
                                                                                    tmp_path_factory):
    """A card's code writes the workspace, main's runtime folder and its chats among it. A link it leaves in place of
    main's chat leads the rewind to no message there, and one it leaves in place of the folder of main's
    conversations, between the rewind's read of main's state and its change, leads the removal nowhere: the rewind is
    refused, and the file of that name where the link leads stays."""
    from claude_agent_sdk import AssistantMessage, ResultMessage, SystemMessage, TextBlock

    outside = _outside(tmp_path_factory)
    seen: dict[str, Any] = {}
    fake_sdk(monkeypatch, [SystemMessage(subtype="init", data={"session_id": "sess-1"}),
                           AssistantMessage(content=[TextBlock(text="ok")], model="claude-opus-5-5"),
                           ResultMessage(subtype="success", duration_ms=1, duration_api_ms=1, is_error=False,
                                         num_turns=1, session_id="sess-1")], seen)
    claude_access.save(claude_access.CLAUDE_CODE, consent=True)
    await main_turn(FIRST)
    cc_transcript("sess-1", [cc_record("user", "u0", seen["prompt"]), cc_record("assistant", "a0", "ok")])
    first = shown()[0][1]

    # main's chat swapped for a link to a log outside that holds a made-up message
    _, log = agents.paths(CORPUS, agents.MAIN_ID)
    (outside / "made-up.jsonl").write_text(json.dumps({"type": "user", "by": "browser", "text": "made up",
                                                       "event": "0utside1"}) + "\n")
    log.rename(log.with_name("main.moved"))
    log.symlink_to(outside / "made-up.jsonl")
    with pytest.raises(runtime.RewindRefused):
        await runtime.rewind_main(CORPUS, "0utside1")
    assert (outside / "made-up.jsonl").read_text().count("\n") == 1, "no rewind line went into the file outside"
    log.unlink()
    log.with_name("main.moved").rename(log)

    # the folder of main's conversations swapped for a link once the rewind has read main's state (one read: main idles)
    sp = runtime._spaces[CORPUS]
    convs = sp.main.state_path("cc").parent
    (outside / sp.main.state_path("cc").name).write_text('{"the person\'s": "own"}\n')
    plan, reads = runtime._rewind_plan, []

    def swapped_after_the_read(conv: Any, ids: set[str]) -> Any:
        got = plan(conv, ids)
        reads.append(got)
        if len(reads) == 1:
            convs.rename(convs.with_name("convs.moved"))
            convs.symlink_to(outside, target_is_directory=True)
        return got

    monkeypatch.setattr(runtime, "_rewind_plan", swapped_after_the_read)
    with pytest.raises(runtime.RewindRefused):
        await runtime.rewind_main(CORPUS, first)
    assert [held for _, held, _ in reads[0]] == [None], "the rewind was to remove main's state"
    assert (outside / sp.main.state_path("cc").name).read_text() == '{"the person\'s": "own"}\n'
    assert not any(r.get("kind") == runtime.REWIND_CHIP for r in main_records())


async def test_a_session_or_an_entry_a_card_wrote_in_main_s_state_names_no_transcript_and_reaches_no_command(
        on, monkeypatch, claude_config):
    """Main's Claude Code state lies in the workspace, which a card's code writes. A session id there that Claude Code
    never makes names no transcript the rewind reads, and an entry there that is no record's id, such as one that would
    read as an option, goes to no --resume-session-at: not to main's next turn, nor to the checker's fork."""
    api_key(monkeypatch, [text("Two incidents.")])
    await main_turn(FIRST)
    claude_access.save(claude_access.CLAUDE_CODE, consent=True)
    sp = runtime._spaces[CORPUS]
    state = sp.main.state_path("cc")
    read: list[str] = []
    real = runtime_cc.session_entries
    monkeypatch.setattr(runtime_cc, "session_entries", lambda sid: read.append(sid) or real(sid))
    state.write_text(json.dumps({"session_id": "../../made-up", "resume_at": "u0"}))
    await runtime.rewind_main(CORPUS, shown()[0][1])
    assert read == [], "no transcript is read by that name"
    state.write_text(json.dumps({"session_id": "sess-1", "resume_at": "--dangerously-skip-permissions"}))
    assert runtime_api.cc_main_cut(CORPUS) is None
    opts = runtime_cc.options(sp.main, sp.main.spec(), {})
    assert (opts.resume, opts.resume_session_at, opts.fork_session) == ("sess-1", None, False)
    state.write_text(json.dumps({"session_id": "--help", "resume_at": "u0"}))
    opts = runtime_cc.options(sp.main, sp.main.spec(), {})
    assert (opts.resume, opts.resume_session_at) == (None, None), "never an entry without a session to resume"


# --------------------------------------------------------------------------- where the forks of main resume


class Fork:
    """A `claude` process of a fork that answers at once."""

    returncode = 0
    pid = 0

    async def communicate(self, _input: bytes) -> tuple[bytes, bytes]:
        return json.dumps({"type": "result", "subtype": "success", "result": "ok"}).encode() + b"\n", b""


async def test_the_checker_s_and_the_proposer_s_forks_resume_main_where_a_rewind_left_it(on, monkeypatch, tmp_path):
    """On Claude Code sign-in the checker's fork (marks.run_fork, in 0.10.8's sandboxed fork) and the proposer's
    (proposer._fork) resume main's session up to the entry a rewind left it at, until main's next turn, and its whole
    conversation when no rewind left one."""
    claude_access.save(claude_access.CLAUDE_CODE, consent=True)
    sp = runtime.ensure(CORPUS)
    sp.main.state_path("cc").parent.mkdir(parents=True, exist_ok=True)
    argvs: list[list[str]] = []

    async def fake_exec(*argv: str, **_kw: Any) -> Fork:
        argvs.append(list(argv))
        return Fork()

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)
    monkeypatch.setattr(marks, "_model", lambda c, main, prompt: ("claude-opus-5-5", "low"))
    lv = type("Live", (), {"sid": "terminal-sid", "cwd": str(tmp_path), "config": None, "config_known": False,
                           "c": CORPUS, "context_tokens": 0})()
    for state, cut in (({"session_id": "sess-1", "resume_at": "a0"}, "a0"), ({"session_id": "sess-2"}, None)):
        sp.main.state_path("cc").write_text(json.dumps(state))
        argvs.clear()
        assert (await marks.run_fork(CORPUS, {"cwd": str(tmp_path)}, "turn-cut", "Check [2](#)."))["error"] is None
        await proposer._fork(lv, "turn-cut", "Propose views.", "claude-opus-5-5", "low", "standard")
        assert len(argvs) == 2
        for argv in argvs:
            assert argv[argv.index("--resume") + 1] == state["session_id"]
            at = argv[argv.index("--resume-session-at") + 1] if "--resume-session-at" in argv else None
            assert at == cut


async def test_a_second_rewind_before_main_s_next_turn_cuts_the_session_no_later_than_the_first(on, monkeypatch,
                                                                                               claude_config):
    """A rewind left main's Claude Code session at an entry that main's next turn has not taken up yet. A second rewind
    reads the session only up to that entry: a message whose prompt the session holds only after it, such as a
    /thimble-fix logged before the first rewind's message and run after its turn, gives no later entry, so the first
    rewind's cut holds."""
    agents.ensure_main(CORPUS)
    sp = runtime.ensure(CORPUS)
    for words, eid in ((FIRST, "e0000001"), ("/thimble-fix make the legend name the rows", "e0000003"),
                       (SECOND, "e0000002")):
        agents.mirror(CORPUS, "user", by=agents.BROWSER, text=words, event=eid)
    agents.chip(CORPUS, runtime.REWIND_CHIP, runtime.REWOUND, event="e0000002")  # the first rewind, to SECOND

    def prompt(eid: str, words: str) -> str:
        return f'<thimble-event kind="main" event="{eid}">\n{words}\n</thimble-event>'

    cc_transcript("sess-1", [cc_record("user", "u0", prompt("e0000001", FIRST)), cc_record("assistant", "a0", "ok"),
                             cc_record("user", "u1", prompt("e0000002", SECOND)), cc_record("assistant", "a1", "ok"),
                             cc_record("user", "u2", prompt("e0000003", "Make the legend name the rows."))])
    claude_access.save(claude_access.CLAUDE_CODE, consent=True)
    state = sp.main.state_path("cc")
    state.parent.mkdir(parents=True, exist_ok=True)
    state.write_text(json.dumps({"session_id": "sess-1", "resume_at": "a0"}))
    assert [w for w, _ in shown()] == [FIRST, "/thimble-fix make the legend name the rows"]
    await runtime.rewind_main(CORPUS, "e0000003")
    assert json.loads(state.read_text()) == {"session_id": "sess-1", "resume_at": "a0"}
    await runtime.rewind_main(CORPUS, "e0000001")
    assert not state.exists(), "back to the first message: nothing is left to resume"
    state.write_text(json.dumps({"session_id": "sess-1", "resume_at": "gone"}))
    agents.mirror(CORPUS, "user", by=agents.BROWSER, text=SECOND, event="e0000004")
    with pytest.raises(runtime.RewindRefused):  # an entry the transcript does not hold: no rewind blind
        await runtime.rewind_main(CORPUS, "e0000004")
