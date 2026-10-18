"""Two or more of thimble's agents of one type started in one turn each take up their own start (app/subagent_files.py
register and settle). In views round 5 main started two view builders in one turn, the SubagentStart hook gave each the
other's start, and each built the other's view. Claude Code's SubagentStart input names the agent and its type, but not
the Agent call that spawned it, and Claude Code writes the agent's meta.json, which names the call, only after that hook
ends (2.1.295). It spawns the agents of one turn together, in either order, and each call's result (main's transcript,
the call's PostToolUse hook) can come before or after its agent's SubagentStart. These tests replay those orders: each
agent takes up its own start, no agent holds another's start at any point, and no claim is left behind."""
from __future__ import annotations

import itertools
import json
import time
from pathlib import Path

import pytest

from app import config, subagents, tools, view_tools, views
from app import subagent_files as sf
from subagent_fakes import bridge, hints  # noqa: F401 — fixtures

SID = "70e0e27e-eb46-462b-8a9a-57b2e924dca1"
BUILDER = "view-builder"


def _call_input(rid: str, role: str, name: str) -> dict:
    return {"subagent_type": sf.type_name(role), "description": f"{role}: {name}", "prompt": f"{rid}\nwork on {name}"}


def _claim(state: dict, i: int, role: str = BUILDER) -> tuple[str, str, str, str]:
    """The typed start `i` of `role` as main's start tool records it, claimed by main's own Agent call as the
    agent-check hook decides it: (request id, key, the call's id, the agent the call will start)."""
    rid, name = f"req_{i:010x}", f"v{i}"
    key = f"{'view' if role == BUILDER else role}:{name}"
    sf.requests(state)[rid] = {"kind": "start", "route": "typed", "role": role, "key": key,
                               "input": _call_input(rid, role, name), "values": {"model": "m", "effort": f"e{i}"},
                               "created": time.time(), "claimed_by": None, "state": "pending",
                               "chat": {"title": name}}
    call = f"toolu_0{i}main"
    assert sf.check_call(state, {"hook_event_name": "PreToolUse", "tool_name": "Agent", "tool_use_id": call,
                                 "session_id": SID, "permission_mode": "auto",
                                 "tool_input": _call_input(rid, role, name)}) is None
    return rid, key, call, f"a{i:016x}"


def _start(agent: str, role: str = BUILDER, **extra) -> dict:
    """The SubagentStart hook's input, as Claude Code gives it: the agent and its type, no Agent call."""
    return {"hook_event_name": "SubagentStart", "session_id": SID, "agent_id": agent,
            "agent_type": sf.type_name(role), **extra}


def _launched(call: str, agent: str, role: str = BUILDER, text: bool = False) -> dict:
    """The PostToolUse hook's input for main's Agent call `call` that launched `agent` in the background."""
    answer = (f"Async agent launched successfully.\nagentId: {agent} (internal ID)" if text
              else {"isAsync": True, "status": "async_launched", "agentId": agent})
    return {"hook_event_name": "PostToolUse", "tool_name": "Agent", "session_id": SID, "tool_use_id": call,
            "tool_input": {"subagent_type": sf.type_name(role)}, "tool_response": answer}


def _own_or_none(state: dict, starts: list[tuple[str, str, str, str]]) -> None:
    """No agent holds another agent's start: each registered agent has its own, and each start that has an agent has
    its own."""
    reg, reqs = sf.registry(state), sf.requests(state)
    for rid, key, _, agent in starts:
        if agent in reg:
            assert (reg[agent]["request"], reg[agent]["key"]) == (rid, key), (agent, reg[agent])
        assert reqs[rid].get("agent") in (None, agent), (rid, reqs[rid])


def _all_own(state: dict, starts: list[tuple[str, str, str, str]]) -> None:
    """Each agent took up its own start, with its own effort, and nothing waits or stays claimed."""
    _own_or_none(state, starts)
    reg = sf.registry(state)
    for rid, key, _, agent in starts:
        assert agent in reg, agent
        assert sf.requests(state)[rid]["state"] == "started"
        assert sf.efforts(state)[agent] == sf.requests(state)[rid]["values"]["effort"]
    assert not state.get(sf.UNSETTLED), state.get(sf.UNSETTLED)
    assert not [r for r in sf.requests(state).values() if r.get("state") == "claimed"], "no claim is left behind"


def _replay(state: dict, starts: list, order: list[tuple[str, int]], role: str = BUILDER) -> None:
    """Each event of `order`: ("start", i) the SubagentStart of start i's agent, ("result", i) its call's result."""
    for what, i in order:
        rid, key, call, agent = starts[i]
        if what == "start":
            sf.register(state, _start(agent, role))
        else:
            assert sf.launched_agent(_launched(call, agent, role, text=i % 2 == 1)) == agent
            sf.settle(state, agent, call)
        _own_or_none(state, starts)


# --------------------------------------------------------------------------- the hooks' records, every order


def test_three_agents_of_one_type_each_take_their_own_start_in_every_order():
    events = [(w, i) for i in range(3) for w in ("start", "result")]
    for order in itertools.permutations(events):
        state: dict = {}
        starts = [_claim(state, i) for i in range(3)]
        _replay(state, starts, list(order))
        _all_own(state, starts)


# --------------------------------------------------------------------------- the server and the mirror


@pytest.fixture()
def board(tmp_path, monkeypatch, workspaces_tmp) -> Path:
    d = tmp_path / "data"
    corpus = d / "boards"
    corpus.mkdir(parents=True)
    (corpus / "manifest.json").write_text(json.dumps({"name": "boards"}))
    (corpus / "board.jsonl").write_text(json.dumps({"body": "first post"}) + "\n")
    monkeypatch.setattr(config, "DATA_DIR", d.resolve())
    real = config.models_for
    row = {"model": "claude-opus-5-5", "effort": "high", "fast": False}
    monkeypatch.setattr(config, "models_for", lambda c=None: {**real(c), "dev": dict(row), "checks": dict(row)})
    gated: list[str] = []

    async def gate(c, slug, locators=None, **_kw):
        gated.append(slug)
        ok = (views.views_dir(c) / slug / views.VIEW_JSON).is_file()
        return {"ok": ok, "checks": [], "page": {"ok": ok}, "problems": [] if ok else ["problem: no view.json"]}

    monkeypatch.setattr(views, "gate", gate)
    monkeypatch.setattr(views, "gate_lines", lambda rep: list(rep.get("problems") or []) or ["the checks passed"])
    monkeypatch.setattr(views, "build_problem", lambda: "")
    return corpus


def _draft(slug: str) -> None:
    d = views.views_dir("boards") / slug
    d.mkdir(parents=True, exist_ok=True)
    (d / views.VIEW_JSON).write_text(json.dumps({"name": slug.title(), "description": "The board's posts.",
                                                 "scope": ["board.jsonl"], "accepts": [], "units": [], "libs": []}))
    (d / views.READER_PY).write_text("def build_index(paths):\n    return {}\n\n\ndef records(index, query):\n"
                                     "    return []\n\n\ndef resolve(index, locator):\n    return None\n")
    (d / views.VIEW_HTML).write_text("<p>posts</p>")


@pytest.mark.parametrize("first", [0, 1])
async def test_two_view_builds_of_one_turn_each_build_their_own_view(board, bridge, hints, tmp_path, first):
    """Views round 5: main's two propose_view calls of one turn, both Agent calls claimed, the builders' SubagentStart
    hooks in either order and main's results not read yet. Each builder's first call runs as its own view's build (its
    meta.json names its call, tools._as_caller), and finish_view registers the view it built."""
    c = "boards"
    main = tmp_path / "proj" / f"{SID}.jsonl"
    builds = []
    for i, name in enumerate(("Posts", "Authors")):
        res = await tools.call(c, "propose_view", {"name": name, "description": "The board's posts as a list.",
                                                   "task": "Read the board.", "claims": ["board.jsonl"]},
                               tool_use_id=f"toolu_main{i}")
        assert not res.is_error, res.text
        inp = json.loads(res.text.split("AGENT CALL ", 1)[1].splitlines()[0])
        slug = next(p["slug"] for p in views.list_proposals(c) if p.get("name") == name)
        call = f"toolu_0{i}agent"
        with subagents.update(c) as state:
            assert sf.check_call(state, {"tool_name": "Agent", "tool_use_id": call, "tool_input": inp}) is None
        builds.append((slug, call, f"b{i:016x}"))
    for slug, call, agent in (builds[first], builds[1 - first]):
        with subagents.update(c) as state:
            sf.register(state, _start(agent, transcript_path=str(main)))
        subagents.hook_started(c, {"agent_id": agent})
        meta = main.with_suffix("") / "subagents" / f"agent-{agent}.meta.json"
        meta.parent.mkdir(parents=True, exist_ok=True)
        meta.write_text(json.dumps({"agentType": sf.type_name(BUILDER), "toolUseId": call}))
    for n, (slug, call, agent) in enumerate(builds):
        _draft(slug)
        tid = f"toolu_b{n}finish"
        sf.add_caller(config.workspace_dir(c), tid, agent, sf.type_name(BUILDER))
        refused, key = await tools._as_caller(c, "finish_view", tid)
        assert (refused, key) == ("", view_tools.build_key(slug)), "the builder's call runs as its own view's build"
        res = await tools.call(c, "finish_view", {}, session=key, tool_use_id=tid)
        assert not res.is_error, res.text
        prop = views.read_proposal(c, slug) or {}
        assert prop.get("agent_id") == agent, prop
    for slug, _, agent in builds:
        assert subagents.agent(c, agent)["key"] == view_tools.build_key(slug)
