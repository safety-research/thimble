"""A model call as a subagent of main (agent_call.py): the call starts a `thimble:call` agent through thimble's module
(the fake bridge, subagent_fakes), the agent answers through send_answer, whose answer is checked against the call's
schema, and the caller gets it; a call with no Claude Code session gives `no_session` with its fix; an agent that ends
without an answer gives its part back once; a cancel stops the agent and refuses a late answer; a call of many parts
starts a fresh agent once one has read its share. The card check reads its card this way."""
from __future__ import annotations

import asyncio
import json

import pytest

from app import agent_call, card_check, ledger, module_bridge as real_bridge, subagent_files as sf, subagents, tools
from app import userconf
from app.call_result import ToolSpec
from subagent_fakes import bridge  # noqa: F401 — a fixture

CORPUS = "mini"
TOOL = ToolSpec(name="verdict", description="Say whether the reply is curt.",
                input_schema={"type": "object", "properties": {"curt": {"type": "boolean"}}, "required": ["curt"]})


async def _until(cond, what: str) -> None:
    for _ in range(500):
        if cond():
            return
        await asyncio.sleep(0.01)
    raise AssertionError(what)


def _agents() -> list[tuple[str, dict]]:
    return list(subagents.agents_of(CORPUS, role="call").items())


async def _send(name: str, args: dict, n: int = 0, agent: int = -1) -> tools.ToolResult:
    """A tool call of the call's agent (the `agent`-th started), attributed to it as the caller hook attributes it."""
    aid, a = _agents()[agent]
    tid = f"toolu_{name}_{n}_{aid[-4:]}"
    sf.add_caller(subagents.ws(CORPUS), tid, aid, "thimble:call")
    return await tools.call(CORPUS, name, args, session=str(a["key"]), tool_use_id=tid)


@pytest.fixture()
def ws(workspaces_tmp, monkeypatch):
    monkeypatch.setattr(agent_call, "POLL_S", 0.01)
    monkeypatch.setattr(agent_call, "END_GRACE_S", 0.0)
    sf.ensure(subagents.ws(CORPUS))


async def test_a_call_runs_as_main_s_subagent_and_its_answer_is_checked_against_its_schema(ws, bridge):
    call = asyncio.create_task(agent_call.structured(
        CORPUS, "The reply: Do it now.", tool=TOOL, model="claude-opus-5-5", effort="low",
        system="Judge one reply of a support agent.", what="curt check", title="thimble: curt check",
        done="thimble judged a reply"))
    await _until(lambda: bridge.ops("spawn"), "no agent started")
    [spawn] = bridge.ops("spawn")
    assert spawn["role"] == "call" and spawn["route"] == "follow-on"
    assert spawn["drop"] == "thimble judged a reply" and spawn["description"] == "thimble: curt check"
    assert spawn["values"] == {"model": "claude-opus-5-5", "effort": "low"}
    prompt = spawn["prompt"]
    assert "Judge one reply" in prompt and "The reply: Do it now." in prompt and '"curt"' in prompt
    assert "read_call" not in prompt, "a part with no pictures is in the first message itself"
    await _until(lambda: _agents(), "the agent was not registered")
    wrong = await _send("send_answer", {"answer": {"curt": "very"}})
    assert wrong.is_error and "curt" in wrong.text and "agree with the schema" in wrong.text
    right = await _send("send_answer", {"answer": {"curt": True}}, 1)
    assert not right.is_error and "only the word Done" in right.text
    res = await asyncio.wait_for(call, 5)
    assert res.status == "ok" and res.output == {"curt": True} and res.model_requested == "claude-opus-5-5"
    late = await _send("send_answer", {"answer": {"curt": False}}, 2)
    assert "stopped this task" in late.text, "a call that ended takes no more answers"


async def test_a_call_with_no_claude_code_session_says_how_to_start_one(ws, bridge):
    bridge.is_live, bridge.reason = False, real_bridge.NO_MAIN
    res = await agent_call.structured(CORPUS, "The reply: Do it now.", tool=TOOL, model="claude-opus-5-5",
                                      effort="low")
    assert res.status == "no_session" and res.detail == agent_call.NO_SESSION and not bridge.ops("spawn")
    words = card_check._read_failure(res.status, res.detail)
    assert words.startswith("the check could not start") and "type /thimble" in words


async def test_an_agent_that_ends_without_its_answer_gives_the_part_back_once(ws, bridge):
    call = asyncio.create_task(agent_call.structured(CORPUS, "The reply: Fine.", tool=TOOL, model="claude-opus-5-5",
                                                     effort="low"))
    await _until(lambda: _agents(), "no agent started")
    subagents.run_ended(CORPUS, _agents()[0][0], "done", "I am not sure.")
    await _until(lambda: len(_agents()) == 2, "the part was not given to a second agent")
    assert "The reply: Fine." in bridge.ops("spawn")[1]["prompt"]
    subagents.run_ended(CORPUS, _agents()[1][0], "done", "Still not sure.")
    res = await asyncio.wait_for(call, 5)
    assert res.status == "no_tool_call" and "Still not sure." in res.detail and len(bridge.ops("spawn")) == 2


async def test_a_fork_of_main_answers_with_its_report_which_must_fit_the_schema(ws, bridge):
    call = asyncio.create_task(agent_call.structured(
        CORPUS, "Is the analyst's last reply curt?", tool=TOOL, model="", effort="", fork=True,
        title="thimble: curt check", done="thimble judged a reply"))
    await _until(lambda: bridge.ops("spawn"), "no fork started")
    [spawn] = bridge.ops("spawn")
    assert spawn["fork"] is True and spawn["role"] == "call" and spawn["drop"] == "thimble judged a reply"
    prompt = spawn["prompt"]
    assert "You are a fork of the analyst's session" in prompt and "Is the analyst's last reply curt?" in prompt
    assert '"curt"' in prompt and "read_call" not in prompt and "send_answer" not in prompt
    await _until(lambda: _agents(), "the fork was not registered")
    assert _agents()[0][1]["type"] == "fork", "its start names Claude Code's fork type"
    subagents.run_ended(CORPUS, _agents()[0][0], "done", 'Checking the reply.\n{"curt": "very"}')
    await _until(lambda: len(_agents()) == 2, "an answer that does not fit gives the part to a second fork")
    subagents.run_ended(CORPUS, _agents()[1][0], "done", 'One line first.\n```json\n{"curt": true}\n```')
    res = await asyncio.wait_for(call, 5)
    assert res.status == "ok" and res.output == {"curt": True} and len(bridge.ops("spawn")) == 2


async def test_a_fork_the_safeguards_refused_fails_at_once_and_one_with_pictures_never_starts(ws, bridge):
    refusal = {"model": "claude-opus-4-8", "effort": "high"}
    call = asyncio.create_task(agent_call.structured(CORPUS, "Judge it.", tool=TOOL, model="", effort="", fork=True,
                                                     refusal=refusal))
    await _until(lambda: _agents(), "no fork started")
    subagents.run_ended(CORPUS, _agents()[0][0], "failed", "API Error: Claude's safeguards flagged this message.")
    res = await asyncio.wait_for(call, 5)
    assert res.status == "refused" and len(bridge.ops("spawn")) == 1, "a fork cannot change its model"
    pictured = await agent_call.structured(CORPUS, "Judge it.", tool=TOOL, model="", effort="", fork=True,
                                           images=[(b"png", "image/png")])
    assert pictured.status == "error" and "no pictures" in pictured.detail and len(bridge.ops("spawn")) == 1


def test_a_fork_that_ends_before_its_start_s_answer_named_it_still_answers_its_part(ws):
    cid = "f0f0f0f0f0f0"
    with agent_call._locked(CORPUS, cid) as rec:
        rec.update(id=cid, status="running", fork=True, model="", tool={"schema": TOOL.input_schema},
                   parts={"1": {"state": "given", "agent": "", "tries": 1, "inline": True}}, agents={})
    agent_call._agent_ended(CORPUS, cid, "afast", "done", '{"curt": false}')
    part = agent_call.read(CORPUS, cid)["parts"]["1"]
    assert part["state"] == "answered" and part["agent"] == "afast"
    assert json.loads(agent_call._answer_path(CORPUS, cid, 1).read_text()) == {"curt": False}


async def test_a_cancelled_call_stops_its_agent_and_takes_no_late_answer(ws, bridge):
    call = asyncio.create_task(agent_call.structured(CORPUS, "The reply: Now.", tool=TOOL, model="claude-opus-5-5",
                                                     effort="low"))
    await _until(lambda: _agents(), "no agent started")
    aid = _agents()[0][0]
    call.cancel()
    with pytest.raises(asyncio.CancelledError):
        await call
    await _until(lambda: bridge.ops("stop"), "the agent was not stopped")
    assert bridge.ops("stop")[0]["agent"] == aid
    late = await _send("send_answer", {"answer": {"curt": True}})
    assert "stopped this task" in late.text


async def test_a_call_of_many_parts_takes_them_one_at_a_time_and_a_fresh_agent_takes_the_rest(ws, bridge):
    heard: list[int] = []
    spec = agent_call.Spec(what="labels", instructions="Judge each reply.", tool=TOOL, model="claude-opus-5-5",
                           effort="low", budget_chars=20)
    parts = [agent_call.Part(f"reply number {i}") for i in (1, 2, 3)]  # 14 characters each
    call = asyncio.create_task(agent_call.run(CORPUS, spec, parts, on_answer=lambda o: heard.append(o.part)))
    await _until(lambda: _agents(), "no agent started")
    assert "Call read_call to get the first part" in bridge.ops("spawn")[0]["prompt"]
    first = await _send("read_call", {})
    assert "# Part 1" in first.text and "reply number 1" in first.text
    again = await _send("read_call", {}, 1)
    assert "# Part 1" in again.text, "an agent holds one part until it answers it"
    more = await _send("send_answer", {"answer": {"curt": False}}, 2)
    assert "Your next part follows" in more.text and "# Part 2" in more.text and "reply number 2" in more.text, \
        "the next part comes with the answer's result"
    second = await _send("read_call", {}, 3)
    assert "reply number 2" in second.text, "the part it holds, again"
    last = await _send("send_answer", {"part": 2, "answer": {"curt": True}}, 4)
    assert "That was your last part" in last.text, "its share is read"
    share = await _send("read_call", {}, 5)
    assert "Another agent gets the parts" in share.text
    subagents.run_ended(CORPUS, _agents()[0][0], "done", "Done")
    await _until(lambda: len(_agents()) == 2, "no fresh agent took the rest")
    third = await _send("read_call", {}, 6)
    assert "reply number 3" in third.text
    await _send("send_answer", {"answer": {"curt": True}}, 7)
    outs = await asyncio.wait_for(call, 5)
    assert [(o.part, o.status, o.output) for o in outs] == [(1, "ok", {"curt": False}), (2, "ok", {"curt": True}),
                                                           (3, "ok", {"curt": True})]
    assert heard == [1, 2, 3]


async def test_a_lazy_source_that_waits_adds_parts_as_it_goes_and_starts_an_agent_only_for_a_part_none_waits_for(
        ws, bridge):
    """A source that yields WAIT keeps the call open until it ends; with room for four agents, one part starts one
    agent, and a part added while that agent holds one starts a second."""
    queue: list[str] = ["reply one"]
    closed = False

    async def source():
        while True:
            if queue:
                yield agent_call.Part(queue.pop(0))
            elif closed:
                return
            else:
                yield agent_call.WAIT

    spec = agent_call.Spec(what="labels", instructions="Judge each reply.", tool=TOOL, model="claude-opus-5-5",
                           effort="low", agents=4)
    call = asyncio.create_task(agent_call.run(CORPUS, spec, source()))
    await _until(lambda: _agents(), "no agent started")
    await asyncio.sleep(0.1)
    assert len(bridge.ops("spawn")) == 1, "one part waits, so one agent starts"
    first = await _send("read_call", {})
    assert "reply one" in first.text
    queue.append("reply two")
    await _until(lambda: len(_agents()) == 2, "a part no agent waits for starts a second agent")
    second = await _send("read_call", {}, 1, agent=1)
    assert "reply two" in second.text
    await _send("send_answer", {"answer": {"curt": True}}, 2, agent=0)
    await _send("send_answer", {"answer": {"curt": False}}, 3, agent=1)
    await asyncio.sleep(0.1)
    assert not call.done(), "a source that waits keeps the call open"
    closed = True
    outs = await asyncio.wait_for(call, 5)
    assert [(o.part, o.output) for o in outs] == [(1, {"curt": True}), (2, {"curt": False})]


async def test_a_long_part_reaches_its_agent_in_pages(ws, bridge, monkeypatch):
    monkeypatch.setattr(agent_call, "PAGE_CHARS", 30)
    monkeypatch.setattr(agent_call, "PAGE_SEEK", 10)
    text = "\n".join(f"line {i:02d} of the reply" for i in range(4))  # 4 lines of 20 characters
    assert agent_call.pages(text) == [(0, 21), (21, 42), (42, 63), (63, 83)], "each page ends at a line break"
    spec = agent_call.Spec(what="labels", instructions="Judge each reply.", tool=TOOL, model="claude-opus-5-5",
                           effort="low")
    call = asyncio.create_task(agent_call.run(CORPUS, spec, [agent_call.Part(text), agent_call.Part("short")]))
    await _until(lambda: _agents(), "no agent started")
    got = [(await _send("read_call", {}, n)).text for n in range(5)]
    assert "page 1 of 4" in got[0] and "line 00" in got[0] and "line 01" not in got[0]
    assert "Call read_call to get page 2" in got[0] and "line 03" in got[3] and "last page of part 1" in got[3]
    assert "page 1 of 4" in got[4], "after its last page, its first again"
    nxt = await _send("send_answer", {"answer": {"curt": True}}, 5)
    assert "short" in nxt.text and "page" not in nxt.text
    await _send("send_answer", {"answer": {"curt": False}}, 6)
    outs = await asyncio.wait_for(call, 5)
    assert [o.status for o in outs] == ["ok", "ok"]


async def test_the_card_check_s_reading_gets_its_picture_from_read_call(ws, bridge, tmp_path, monkeypatch):
    monkeypatch.setattr(card_check, "fit_image", lambda b: b)
    picture = tmp_path / "shot.png"
    picture.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\0" * 32)
    card = {"card": {"id": "c1", "kind": "code", "question": "How many curt replies?", "takeaway": "Two.",
                     "citations": "", "code": "print(2)", "context": "", "typed": "", "kept": ""},
            "picture": str(picture)}
    read = asyncio.create_task(card_check.check_task(CORPUS, card))
    await _until(lambda: _agents(), "no agent started")
    [spawn] = bridge.ops("spawn")
    assert spawn["drop"] == 'thimble checked the card "How many curt replies?"'
    assert spawn["description"] == "thimble card check: How many curt replies?"
    assert "card:c1" in spawn["prompt"] and "Call read_call to see them" in spawn["prompt"]
    got = await _send("read_call", {})
    images = [b for b in got.content if b.get("type") == "image"]
    assert len(images) == 1 and images[0]["mimeType"] == "image/png"
    assert "Its text is in your first message" in got.text and "How many curt replies?" not in got.text
    answer = {"assessment": [{"problem": ""}] * 5, "question": "How many curt replies?", "code": "print(2)",
              "takeaway": "Two."}
    ok = await _send("send_answer", {"answer": answer}, 1)
    assert not ok.is_error, ok.text
    res = await asyncio.wait_for(read, 5)
    assert res.status == "ok" and res.output == answer


async def test_the_card_check_s_agent_runs_at_the_model_and_effort_settings_shows_for_its_role(ws, bridge, tmp_path):
    path = userconf.global_file()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"agents": {"cardCheck": {"model": "claude-sonnet-5", "effort": "low"}}}))
    card = {"card": {"id": "c1", "kind": "note", "question": "Q?", "takeaway": "T."}, "picture": None}
    read = asyncio.create_task(card_check.check_task(CORPUS, card))
    await _until(lambda: bridge.ops("spawn"), "no agent started")
    shown = ledger.get_settings(CORPUS)["models"]["verify"]
    assert bridge.ops("spawn")[0]["values"] == {"model": shown["model"], "effort": shown["effort"]}
    assert shown["model"] == "claude-sonnet-5" and shown["effort"] == "low"
    read.cancel()
    with pytest.raises(asyncio.CancelledError):
        await read


def test_the_call_role_has_only_its_own_tools_from_its_own_shim_and_tells_main_nothing(ws):
    role = subagents.roles(CORPUS)["call"]
    assert role["tools"] == ["mcp__thimble-call__read_call", "mcp__thimble-call__send_answer"]
    assert role["omitClaudeMd"] is True and role["background"] is True and role["type"] == "thimble:call"
    [server] = role["mcpServers"]
    assert server["thimble-call"]["args"] == ["--private", "call"]
    assert [t["name"] for t in tools.private_list("call")] == ["read_call", "send_answer"]
    assert not {"read_call", "send_answer"} & {t["name"] for t in tools.list()}, "main's shim lists neither"
    assert real_bridge._note("call", "abc", "follow-on") == ""
    wire = real_bridge._args("spawn", {"role": "call", "prompt": "p", "description": "d", "drop": "thimble did it"})
    assert wire["drop"] == "thimble did it" and wire["note"] == ""
