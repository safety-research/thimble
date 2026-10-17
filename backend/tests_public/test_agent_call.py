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
    assert not right.is_error and "Write only the word Done" in right.text
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
    assert "Call read_call" in more.text
    second = await _send("read_call", {}, 3)
    assert "reply number 2" in second.text
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
