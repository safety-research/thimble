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
import os
import subprocess
import time
from pathlib import Path

import pytest

from app import agents, config, session, subagents, tools, view_tools, views
from app import subagent_files as sf
from subagent_fakes import bridge, hints  # noqa: F401 — fixtures

CORPUS = "mini"
SID = "70e0e27e-eb46-462b-8a9a-57b2e924dca1"
WATCHER = Path(__file__).resolve().parents[2] / "plugin" / "bin" / ".thimble-watch"
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


@pytest.mark.parametrize("order", list(itertools.permutations(
    [("start", 0), ("start", 1), ("result", 0), ("result", 1)])))
def test_two_agents_of_one_type_started_in_one_turn_each_take_their_own_start_in_every_order(order):
    state: dict = {}
    starts = [_claim(state, 0), _claim(state, 1)]
    _replay(state, starts, list(order))
    _all_own(state, starts)


def test_three_agents_of_one_type_each_take_their_own_start_in_every_order():
    events = [(w, i) for i in range(3) for w in ("start", "result")]
    for order in itertools.permutations(events):
        state: dict = {}
        starts = [_claim(state, i) for i in range(3)]
        _replay(state, starts, list(order))
        _all_own(state, starts)


@pytest.mark.parametrize("first", ["view-builder", "view-reviewer"])
def test_a_builder_and_a_reviewer_started_together_each_take_their_own_start_at_once(first):
    """Agents of different types never share a start: each takes its own at its SubagentStart, with no result."""
    state: dict = {}
    starts = {"view-builder": _claim(state, 0, "view-builder"), "view-reviewer": _claim(state, 1, "view-reviewer")}
    for role in (first, *(r for r in starts if r != first)):
        rid, key, _, agent = starts[role]
        entry = sf.register(state, _start(agent, role))
        assert entry is not None and (entry["request"], entry["key"]) == (rid, key)
    _all_own(state, list(starts.values()))


def test_a_single_agent_takes_its_start_at_once():
    state: dict = {}
    rid, key, _, agent = _claim(state, 0)
    entry = sf.register(state, _start(agent))
    assert entry is not None and (entry["request"], entry["key"]) == (rid, key)
    assert not state.get(sf.UNSETTLED)


def test_a_single_agent_never_takes_a_claim_whose_agent_never_came():
    """A start main's call claimed whose agent never started (the call failed after its claim, or the analyst said no
    to it) is not the next agent's: the next agent of its type waits until its own call names it, and the claim that
    never came is refused as its call's result says, and changes nothing."""
    state: dict = {}
    stale = _claim(state, 0)
    sf.requests(state)[stale[0]]["claimed_at"] -= 120
    rid, key, call, agent = _claim(state, 1)
    assert sf.register(state, _start(agent)) is None, "two claims wait: the agent waits"
    assert agent not in sf.registry(state)
    assert sf.settle(state, agent, call) == [agent]
    assert (sf.registry(state)[agent]["request"], sf.registry(state)[agent]["key"]) == (rid, key)
    sf.requests(state)[stale[0]].update(state="refused", refused_kind="limit")
    assert sf.eliminate(state) == []
    assert sf.requests(state)[stale[0]].get("agent") is None and sf.requests(state)[rid]["agent"] == agent


def test_an_agent_whose_call_never_reports_takes_its_start_once_every_other_one_is_taken_or_refused():
    """A claim whose result never comes: the other agent's result names it, and the agent left takes the start left;
    so does an agent whose only other claim is refused."""
    state: dict = {}
    starts = [_claim(state, 0), _claim(state, 1)]
    for _, _, _, agent in starts:
        sf.register(state, _start(agent))
    assert sorted(state[sf.UNSETTLED]) == sorted(a for *_, a in starts)
    assert sf.settle(state, starts[1][3], starts[1][2]) == [starts[1][3], starts[0][3]]
    _all_own(state, starts)

    state = {}
    stale, mine = _claim(state, 0), _claim(state, 1)
    sf.register(state, _start(mine[3]))
    sf.requests(state)[stale[0]].update(state="refused", refused_kind="auto-mode")
    assert sf.eliminate(state) == [mine[3]]
    assert sf.registry(state)[mine[3]]["key"] == mine[1]


def test_an_agent_takes_its_start_from_its_meta_json_at_a_later_start(tmp_path):
    """Claude Code writes the agent's meta.json after its SubagentStart hooks end; once it is there, a later
    SubagentStart of the same agent (spawn_call) names its call."""
    state: dict = {}
    starts = [_claim(state, 0), _claim(state, 1)]
    main = tmp_path / f"{SID}.jsonl"
    rid, key, call, agent = starts[1]
    assert sf.register(state, _start(agent, transcript_path=str(main))) is None
    meta = tmp_path / SID / "subagents" / f"agent-{agent}.meta.json"
    meta.parent.mkdir(parents=True)
    meta.write_text(json.dumps({"agentType": sf.type_name(BUILDER), "toolUseId": call}))
    entry = sf.register(state, _start(agent, transcript_path=str(main)))
    assert entry is not None and entry["key"] == key


# --------------------------------------------------------------------------- the hooks themselves


def _hook(tmp_path: Path, flag: str, stdin: dict) -> subprocess.CompletedProcess:
    """The watcher run with `flag` on `stdin`, as main's hooks run it, in the corpus folder with no server."""
    env = {k: v for k, v in os.environ.items() if not k.startswith(("CLAUDE", "THIMBLE_SESSION"))}
    env.update(THIMBLE_HOME=str(tmp_path / "hook-home"), THIMBLE_WORKSPACES_DIR=str(config.WORKSPACES_DIR),
               THIMBLE_DATA_DIR=str(config.DATA_DIR), CLAUDE_PROJECT_DIR=str(config.corpus_dir(CORPUS)))
    out = subprocess.run([str(WATCHER), flag], input=json.dumps({"cwd": str(config.corpus_dir(CORPUS)), **stdin}),
                         capture_output=True, text=True, env=env, timeout=30, cwd=str(config.corpus_dir(CORPUS)))
    assert out.returncode == 0, out.stderr
    return out


def test_the_hooks_give_four_builders_of_one_turn_their_own_starts_whichever_comes_first(tmp_path):
    """The hooks themselves, on four builds of one turn: main's PostToolUse naming an agent after its SubagentStart
    (1, 2) and before it (3), and one call whose result never comes (0), whose agent takes the start left."""
    ws = config.workspace_dir(CORPUS)
    sf.ensure(ws)
    with sf.update(ws) as state:
        starts = [_claim(state, i) for i in range(4)]
    for i in (1, 0):
        _hook(tmp_path, "--subagent-start", _start(starts[i][3]))
    assert sorted(sf.read(ws)[sf.UNSETTLED]) == sorted([starts[0][3], starts[1][3]])
    assert not sf.registry(sf.read(ws)), "neither start is known yet"
    _hook(tmp_path, "--agents", _launched(starts[1][2], starts[1][3]))
    _hook(tmp_path, "--agents", _launched(starts[3][2], starts[3][3], text=True))
    _hook(tmp_path, "--subagent-start", _start(starts[3][3]))
    _hook(tmp_path, "--subagent-start", _start(starts[2][3]))
    _own_or_none(sf.read(ws), starts)
    _hook(tmp_path, "--agents", _launched(starts[2][2], starts[2][3]))
    _all_own(sf.read(ws), starts)


# --------------------------------------------------------------------------- the server and the mirror


@pytest.fixture()
def handlers(monkeypatch) -> list[tuple]:
    """Each role's start handler records (agent, key) instead of doing its work."""
    for role, t in list(subagents.TYPES.items()):
        if t.started:
            monkeypatch.setitem(subagents.TYPES, role, subagents.Type(
                t.role, t.kind, t.chat_role, t.row, t.agent, t.define, t.own,
                f"{__name__}:_record_start", "", "", t.when, t.keeps_chat, t.left_work, t.gated))
    _starts.clear()
    yield _starts
    _starts.clear()


_starts: list[tuple] = []


def _record_start(c, run, req) -> None:
    _starts.append((run.agent_id, run.key))


@pytest.fixture()
def project(tmp_path, monkeypatch) -> Path:
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "claude-config"))
    session._live.clear()
    p = tmp_path / "claude-config" / "projects" / "-corpus"
    p.mkdir(parents=True)
    yield p
    session._live.clear()


def _hook_start(agent: str, role: str, main: Path) -> None:
    """What the SubagentStart hook does in browser mode: its record, then the server's started route for the agent and
    for each agent its start left one start (app/subagent_files.py register)."""
    settled: list[str] = []
    with subagents.update(CORPUS) as state:
        entry = sf.register(state, _start(agent, role, transcript_path=str(main)), settled)
    for who in ([agent] if entry is not None else []) + settled:
        subagents.hook_started(CORPUS, {"agent_id": who})


def _meta(project: Path, agent: str, role: str, call: str) -> Path:
    """The agent's transcript and the meta.json Claude Code writes beside it after its SubagentStart."""
    path = project / SID / "subagents" / f"agent-{agent}.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"type": "assistant", "message": {"role": "assistant", "content": [
        {"type": "text", "text": "Working."}]}}) + "\n")
    path.with_name(f"agent-{agent}.meta.json").write_text(json.dumps({"agentType": sf.type_name(role),
                                                                      "toolUseId": call}))
    return path


def _main_turn(main: Path, calls: list[tuple[str, dict, str]], uses: bool = True, results: bool = True) -> None:
    """Main's turn: one message with every Agent call (`uses`), then each call's result naming its agent
    (`results`)."""
    recs = [{"type": "user", "origin": {"kind": "human"}, "message": {"content": "Build both views."}},
            {"type": "assistant", "message": {"role": "assistant", "model": "claude-opus-5-5", "content": [
                {"type": "tool_use", "id": call, "name": "Agent", "input": inp} for call, inp, _ in calls]}}] \
        if uses else []
    recs += [{"type": "user", "message": {"role": "user", "content": [
        {"type": "tool_result", "tool_use_id": call,
         "content": f"Async agent launched successfully.\nagentId: {agent} (internal ID)"}]}}
        for call, _, agent in calls] if results else []
    with main.open("a") as f:
        f.write("".join(json.dumps(r) + "\n" for r in recs))


@pytest.mark.parametrize("first", [0, 1])
@pytest.mark.parametrize("order", ["starts-first", "results-first", "interleaved"])
async def test_the_mirror_gives_each_of_two_builders_its_own_chat_and_start_handler(bridge, project, handlers, order,
                                                                                   first):
    """Main's two view builds of one turn: whichever of the SubagentStart hooks and main's results comes first, and
    whichever builder starts first, each builder's chat names it and its own view's key, and its role's start handler
    runs once, with its own key, never with the other's."""
    main = project / f"{SID}.jsonl"
    main.touch()
    lv = session.attach(CORPUS, SID, str(config.corpus_dir(CORPUS)), str(main))
    session.tail_once(lv)
    calls = []
    for i, name in enumerate(("alpha", "beta")):
        ans = await subagents.start_job(CORPUS, BUILDER, f"view:{name}", f"build {name}", {"model": "m", "effort": "e"},
                                        subagents.TYPED, description=f"view: {name}", chat={"title": name.title()})
        call = f"toolu_0{i}build"
        assert subagents.claim(CORPUS, call, ans["input"]) is None
        calls.append((call, ans["input"], f"a{i:016x}"))
    agents_ = [a for _, _, a in calls]
    right = {(agents_[0], "view:alpha"), (agents_[1], "view:beta")}
    one, two = agents_[first], agents_[1 - first]
    if order == "starts-first":
        _hook_start(one, BUILDER, main)
        _hook_start(two, BUILDER, main)
        assert set(handlers) <= right, handlers
        _main_turn(main, calls)
        session.tail_once(lv)
    elif order == "results-first":
        _main_turn(main, calls)
        session.tail_once(lv)
        _hook_start(one, BUILDER, main)
        assert set(handlers) <= right, handlers
        _hook_start(two, BUILDER, main)
    else:
        _hook_start(one, BUILDER, main)
        assert set(handlers) <= right, handlers
        _main_turn(main, calls)
        session.tail_once(lv)
        _hook_start(two, BUILDER, main)
    for call, _, agent in calls:
        _meta(project, agent, BUILDER, call)
    session.tail_once(lv)
    session.tail_once(lv)
    assert sorted(handlers) == sorted(right), "each start handler ran once, with its own key"
    for (call, _, agent), (name, key) in zip(calls, (("Alpha", "view:alpha"), ("Beta", "view:beta"))):
        a = subagents.agent(CORPUS, agent)
        meta = agents.read_meta(CORPUS, a["chat"])
        assert (a["key"], meta["key"], meta["agent_id"], meta["title"]) == (key, key, agent, name)
        assert meta["tool_use_id"] == call
    builds = [m for m in agents.list_chats(CORPUS) if m.get("agent_type") == sf.type_name(BUILDER)]
    assert len(builds) == 2, builds
    state = subagents.read(CORPUS)
    assert not state.get(sf.UNSETTLED) and not [r for r in sf.requests(state).values() if r.get("state") == "claimed"]


async def test_an_unsettled_agent_s_file_without_its_meta_json_goes_to_no_chat_until_its_start_is_known(
        bridge, project, handlers):
    """The mirror finds an agent's transcript before its start is known, with no meta.json: it waits for the start, past
    the scans it waits for any file's meta.json, and makes no chat in main for the agent."""
    main = project / f"{SID}.jsonl"
    main.touch()
    lv = session.attach(CORPUS, SID, str(config.corpus_dir(CORPUS)), str(main))
    session.tail_once(lv)
    calls = []
    for i, name in enumerate(("alpha", "beta")):
        ans = await subagents.start_job(CORPUS, BUILDER, f"view:{name}", f"build {name}", {}, subagents.TYPED,
                                        description=f"view: {name}", chat={"title": name.title()})
        assert subagents.claim(CORPUS, f"toolu_0{i}build", ans["input"]) is None
        calls.append((f"toolu_0{i}build", ans["input"], f"a{i:016x}"))
    _main_turn(main, calls, results=False)
    session.tail_once(lv)
    assert lv.busy, "main's turn runs, so the mirror scans for its subagents' files"
    for call, _, agent in calls:
        _hook_start(agent, BUILDER, main)
        _meta(project, agent, BUILDER, call).with_name(f"agent-{agent}.meta.json").unlink()
    for _ in range(session.META_WAIT_SCANS + 2):
        session.tail_once(lv)
    assert not [m for m in agents.list_chats(CORPUS) if m.get("agent_id") in {a for *_, a in calls}]
    _main_turn(main, calls, uses=False)
    session.tail_once(lv)
    session.tail_once(lv)
    for (_, _, agent), key in zip(calls, ("view:alpha", "view:beta")):
        chat = subagents.agent(CORPUS, agent)["chat"]
        assert agents.read_meta(CORPUS, chat)["key"] == key
    assert len([m for m in agents.list_chats(CORPUS) if m.get("agent_id") in {a for *_, a in calls}]) == 2


async def test_a_click_s_builder_and_main_s_typed_builder_of_one_turn_each_take_their_own_start(bridge, project,
                                                                                                handlers, monkeypatch):
    """A click's build through the module while main's typed build of the same type waits for its agent: both agents
    start before either start is known. The module's answer names the click's agent (bind), and main's agent takes the
    start left."""
    import app

    main = project / f"{SID}.jsonl"
    typed = await subagents.start_job(CORPUS, BUILDER, "view:typed", "build typed", {}, subagents.TYPED,
                                      description="view: typed", chat={"title": "Typed"})
    assert subagents.claim(CORPUS, "toolu_01typed", typed["input"]) is None
    clicked, mains = "a00000000000click", "a0000000000typed"

    async def spawn(c, op, **args):
        # the module's Agent call: its PreToolUse claim, then both agents' SubagentStart hooks, then its answer
        inp = subagents.call_input(BUILDER, args["prompt"], args["description"])
        assert subagents.claim(c, "toolu_plugin_0click", inp) is None
        _hook_start(clicked, BUILDER, main)
        _hook_start(mains, BUILDER, main)
        assert not subagents.agent(c, clicked) and not subagents.agent(c, mains), "neither start is known yet"
        return {"agentId": clicked}

    monkeypatch.setattr(app.module_bridge, "request", spawn)
    ans = await subagents.start_job(CORPUS, BUILDER, "view:clicked", "build clicked", {}, subagents.CLICK,
                                    description="view: clicked", chat={"title": "Clicked"})
    assert ans.agent_id == clicked
    assert subagents.agent(CORPUS, clicked)["key"] == "view:clicked"
    assert subagents.agent(CORPUS, mains)["key"] == "view:typed"
    assert sorted(handlers) == sorted([(clicked, "view:clicked"), (mains, "view:typed")])
    state = subagents.read(CORPUS)
    assert not state.get(sf.UNSETTLED) and not [r for r in sf.requests(state).values() if r.get("state") == "claimed"]


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
        res = await tools.call(c, "propose_view", {"name": name, "why": "to read the board", "claims": ["board.jsonl"],
                                                   "unit": "a post", "overview": "a list", "zoom": "a post",
                                                   "filter": "labels", "details": "the body"},
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
