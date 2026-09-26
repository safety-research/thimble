"""Several permission prompts of one agent at once: a subagent that makes three calls in parallel has three prompts
relayed to the browser, which keeps all three while the agent goes on writing its calls into its transcript. Each prompt
leaves the browser when its own call has a result, which is how an answer given in the terminal shows, and the rest
stay. An agent that stops takes its prompts with it. Main's own parallel prompts leave the same way, each with its own
call's result, and a result never ends another prompt of main's."""
from __future__ import annotations

import asyncio
import json
import time
from pathlib import Path

import pytest

from app import agents, channel, config, session

CORPUS = "mini"
SID = "e7b0a1f2-0000-4000-8000-00000000be11"
AGENT, USE = "a0000000000000b11", "toolu_helper"
END = {"type": "system", "subtype": "turn_duration"}
URLS = ["https://registry.example/ip/1", "https://registry.example/ip/2", "https://registry.example/ip/3"]


@pytest.fixture(autouse=True)
def _fresh(workspaces_tmp, tmp_path, monkeypatch):
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "claude-config"))
    session._live.clear()
    channel._asks.clear()
    channel._answered.clear()
    agents._busy.clear()
    yield
    session._live.clear()
    channel._asks.clear()
    channel._answered.clear()


def _line(rec: dict) -> str:
    return json.dumps({**rec, "isSidechain": True, "timestamp": "2099-01-01T00:00:00Z"}) + "\n"


def _use(i: int) -> dict:
    return {"type": "assistant", "message": {"role": "assistant", "content": [
        {"type": "tool_use", "id": f"w{i}", "name": "WebFetch", "input": {"url": URLS[i], "prompt": "Who owns it?"}}]}}


def _result(i: int) -> dict:
    return {"type": "user", "message": {"role": "user", "content": [
        {"type": "tool_result", "tool_use_id": f"w{i}", "content": "owner: Example Net"}]}}


def _setup(tmp_path: Path) -> tuple[session.Live, Path]:
    main = tmp_path / f"{SID}.jsonl"
    main.write_text("")
    lv = session.attach(CORPUS, SID, str(config.corpus_dir(CORPUS)), str(main))
    assert lv is not None
    session.tail_once(lv)
    sub = tmp_path / SID / "subagents" / f"agent-{AGENT}.jsonl"
    sub.parent.mkdir(parents=True, exist_ok=True)
    sub.with_name(f"agent-{AGENT}.meta.json").write_text(json.dumps(
        {"agentType": "general-purpose", "description": "look up owners", "toolUseId": USE}))
    sub.write_text(_line({"type": "user", "message": {"content": "Look up the owners."}}))
    with main.open("a") as f:
        for rec in ({"type": "user", "origin": {"kind": "human"}, "message": {"content": "Find the owners."}},
                    {"type": "assistant", "message": {"role": "assistant", "content": [{"type": "tool_use", "id": USE,
                     "name": "Agent", "input": {"subagent_type": "general-purpose", "description": "look up owners",
                                                "prompt": "Look up the owners.", "run_in_background": True}}]}},
                    {"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": USE, "content": [
                        {"type": "text", "text": f"Async agent launched successfully.\nagentId: {AGENT} (internal ID)"}]}]}},
                    END):
            f.write(json.dumps(rec) + "\n")
    session.tail_once(lv)
    return lv, sub


def _ask(i: int, agent: str | None = AGENT) -> str:
    """A prompt of the helper's (or with `agent` None, main's) i-th call, relayed as main's PermissionRequest hook
    relays it."""
    loop = asyncio.get_event_loop()
    request_id = f"h{i}"
    channel._asks[request_id] = channel.Ask(CORPUS, loop, loop.create_future(), time.monotonic(), time.time(), agent,
                                            channel.call_key("WebFetch", {"url": URLS[i], "prompt": "Who owns it?"}))
    channel._hold(CORPUS, request_id, "WebFetch", "WebFetch", json.dumps({"url": URLS[i]}), agent)
    return request_id


def _waiting() -> list[str]:
    return [p["id"] for p in agents.read_meta(CORPUS, agents.MAIN_ID).get("permissions") or []]


async def test_each_prompt_leaves_with_its_own_call_s_result(tmp_path):
    lv, sub = _setup(tmp_path)
    with sub.open("a") as f:
        f.write(_line(_use(0)))
    session.tail_once(lv)
    _ask(0)
    with sub.open("a") as f:  # the agent writes its next parallel calls while the first prompt waits
        f.write(_line(_use(1)) + _line(_use(2)))
    session.tail_once(lv)
    _ask(1)
    _ask(2)
    session.tail_once(lv)
    assert _waiting() == ["h0", "h1", "h2"], "the agent's later calls end no prompt"
    with sub.open("a") as f:  # the second is answered in the terminal: its call runs and has a result
        f.write(_line(_result(1)))
    session.tail_once(lv)
    assert _waiting() == ["h0", "h2"]
    assert channel._asks["h0"].fut.done() is False and "h1" not in channel._asks
    with sub.open("a") as f:
        f.write(_line(_result(0)) + _line(_result(2)))
    session.tail_once(lv)
    assert _waiting() == [] and not channel._asks


async def test_a_prompt_answered_in_the_browser_ends_no_other_prompt_with_its_result(tmp_path):
    lv, sub = _setup(tmp_path)
    with sub.open("a") as f:
        f.write(_line(_use(0)) + _line(_use(1)))
    session.tail_once(lv)
    _ask(0)
    _ask(1)
    assert channel._answer_ask("h0", "allow")
    channel._drop(CORPUS, {"h0"}, answer="allow")
    with sub.open("a") as f:
        f.write(_line(_result(0)))
    session.tail_once(lv)
    assert _waiting() == ["h1"], "the answered call's result is not the other prompt's"


async def test_a_stopped_agent_takes_its_prompts_with_it(tmp_path):
    lv, sub = _setup(tmp_path)
    with sub.open("a") as f:
        f.write(_line(_use(0)) + _line(_use(1)))
    session.tail_once(lv)
    _ask(0)
    _ask(1)
    channel.agent_moved(CORPUS, AGENT, float("inf"))
    assert _waiting() == []


def test_a_call_key_names_the_call_by_its_field():
    assert channel.call_key("Bash", {"command": "wc  -l\n a.txt", "description": "count"}) == ("Bash", "wc -l a.txt")
    assert channel.call_key("Skill", {"skill": "x"}) == ("Skill", '{"skill": "x"}')


async def test_main_s_own_parallel_prompts_leave_each_with_its_own_call_s_result(tmp_path):
    lv, _sub = _setup(tmp_path)
    main = Path(lv.transcript_path)
    with main.open("a") as f:
        f.write(_line({"type": "user", "origin": {"kind": "human"}, "message": {"content": "Fetch all three."}}))
        f.write(_line(_use(0)) + _line(_use(1)) + _line(_use(2)))
    session.tail_once(lv)
    for i in range(3):
        _ask(i, None)
    assert _waiting() == ["h0", "h1", "h2"]
    with main.open("a") as f:  # the second is answered in the terminal and runs
        f.write(_line(_result(1)))
    session.tail_once(lv)
    assert _waiting() == ["h0", "h2"]
    assert channel._answer_ask("h0", "allow")  # the first is answered in the browser
    channel._drop(CORPUS, {"h0"}, answer="allow")
    with main.open("a") as f:
        f.write(_line(_result(0)))
    session.tail_once(lv)
    assert _waiting() == ["h2"], "the browser's answer's result ends no other prompt"
    with main.open("a") as f:
        f.write(_line(_result(2)))
    session.tail_once(lv)
    assert _waiting() == [] and not channel._asks
