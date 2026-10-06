"""View builds and view reviews as subagents of main (dev.py, view_tools.py, view_review.py, views.py's digest rule):
a builder (`thimble:view-builder`) starts through thimble's module for a click or a follow-on start, or by main's exact
Agent call for main's propose_view; it checks with `view_check`, finishes with `finish_view`, where the server runs the
gates of record and counts the attempts; its end is the backstop, which gates once, repairs an orientation's proposal or
fails the view with Retry. Readers see only files a gate passed. A reviewer (`thimble:view-reviewer`) takes pictures
with `view_pictures` and ends each round with `finish_review`.

The module is the fake bridge (subagent_fakes); an agent's calls are made through tools.call with the caller hook's line
written first, as the PreToolUse hook writes it, and its end is subagents.run_ended, as the mirror or the module's
`ended` post ends a run. The gate is faked: a view passes when its folder holds view.json and its page says no FAIL."""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import agents, config, dev, session, subagents, tools, view_review, view_tools, views
from app import subagent_files as sf
from subagent_fakes import bridge, hints  # noqa: F401 — fixtures

CORPUS = "boards"
READER = '''
def build_index(paths):
    return {}


def records(index, query):
    return []


def resolve(index, locator):
    return None
'''


@pytest.fixture()
def board(tmp_path, monkeypatch, workspaces_tmp) -> Path:
    d = tmp_path / "data"
    corpus = d / CORPUS
    corpus.mkdir(parents=True)
    (corpus / "manifest.json").write_text(json.dumps({"name": CORPUS}))
    (corpus / "board.jsonl").write_text(json.dumps({"body": "first post"}) + "\n")
    monkeypatch.setattr(config, "DATA_DIR", d.resolve())
    rows = {"dev": {"model": "claude-opus-5-5", "effort": "high", "fast": False},
            "checks": {"model": "claude-opus-5-5", "effort": "high", "fast": False}}
    real = config.models_for
    monkeypatch.setattr(config, "models_for", lambda c=None: {**real(c), **{k: dict(v) for k, v in rows.items()}})
    return corpus


@pytest.fixture()
def gates(monkeypatch):
    """views.gate faked: a view passes when its folder holds view.json and its page says no FAIL. The slugs gated."""
    seen: list[str] = []

    async def gate(c, slug, locators=None, **_kw):
        d = views.views_dir(c) / slug
        html = (d / views.VIEW_HTML).read_text() if (d / views.VIEW_HTML).is_file() else ""
        ok = (d / views.VIEW_JSON).is_file() and "FAIL" not in html
        seen.append(slug)
        return {"ok": ok, "checks": [], "page": {"ok": ok}, "problems": [] if ok else ["problem: the page says FAIL"]}

    monkeypatch.setattr(views, "gate", gate)
    monkeypatch.setattr(views, "gate_lines", lambda rep: list(rep.get("problems") or []) or ["the checks passed"])
    monkeypatch.setattr(views, "build_problem", lambda: "")
    return seen


@pytest.fixture()
def heard(monkeypatch):
    """The `view` events main hears (session.push_event)."""
    got: list[tuple[str, dict]] = []
    monkeypatch.setattr(session, "push_event", lambda c, kind, text, **meta: got.append((kind, meta)) or True)
    return got


def _draft(slug: str, html: str = "<p>posts</p>") -> None:
    """A builder writes the view's three files, as a draft: view.json without thimble's `built` stamp."""
    d = views.views_dir(CORPUS) / slug
    d.mkdir(parents=True, exist_ok=True)
    (d / views.VIEW_JSON).write_text(json.dumps({"name": slug.title(), "description": "The board's posts.",
                                                  "scope": ["board.jsonl"], "accepts": [{"form": "L<n>", "means": "a post"}],
                                                  "units": [], "libs": []}))
    (d / views.READER_PY).write_text(READER)
    (d / views.VIEW_HTML).write_text(html)


def _propose(name: str = "Posts", **kw) -> str:
    return views.propose(CORPUS, name, "to read the board", ["board.jsonl"], "one row per post", **kw)["slug"]


def _prop(slug: str) -> dict:
    return views.read_proposal(CORPUS, slug) or {}


async def _call(tool: str, args: dict, agent: str, key: str, n: list[int] = [0]) -> tools.ToolResult:  # noqa: B006
    """A call of `tool` by the agent `agent`, whose calls run as `key`, the caller hook's line written first."""
    n[0] += 1
    tid = f"toolu_t{n[0]:06d}"
    a = subagents.agent(CORPUS, agent) or {}
    sf.add_caller(config.workspace_dir(CORPUS), tid, agent, str(a.get("type") or "thimble:helper"))
    return await tools.call(CORPUS, tool, args, session=key, tool_use_id=tid)


async def _until(cond, what: str, tries: int = 300) -> None:
    for _ in range(tries):
        if cond():
            return
        await asyncio.sleep(0.01)
    raise AssertionError(what)


async def _started(slug: str, route: str = subagents.CLICK, values: dict | None = None) -> str:
    """A builder of `slug` started through the module: its agent id."""
    ans = await dev.start_build(CORPUS, slug, route, values)
    assert ans.started, dict(ans)
    return str(ans.agent_id)


# --------------------------------------------------------------------------- starts and values


async def test_a_click_starts_a_builder_through_the_module_on_the_values_it_names(board, bridge, gates):
    slug = _propose(asked=True)
    agent = await _started(slug, values={"model": "sonnet", "effort": "max"})
    [spawn] = bridge.ops("spawn")
    assert spawn["role"] == "view-builder" and spawn["values"] == {"model": "claude-sonnet-5", "effort": "max"}
    assert spawn["description"] == "view: Posts" and spawn["what"] == slug
    folder, work = views.views_dir(CORPUS) / slug, dev.view_work_dir(CORPUS, slug)
    assert str(folder) in spawn["prompt"] and str(work) in spawn["prompt"]
    assert "<<<the proposal" in spawn["prompt"] or "the proposal" in spawn["prompt"], "the proposal is fenced as data"
    prop = _prop(slug)
    assert (prop["status"], prop["agent_id"], prop["attempt"]) == ("building", agent, 0)
    meta = agents.read_meta(CORPUS, prop["chat"])
    assert meta["role"] == "dev" and meta["view"] == slug and meta["agent_id"] == agent
    again = await _started(_propose("Threads", asked=True))
    assert bridge.ops("spawn")[-1]["values"] == {"model": "claude-opus-5-5", "effort": "high"}, "the dev row by default"
    assert again != agent


async def test_main_s_propose_view_gives_the_exact_agent_call_its_hook_lets_through(board, bridge, gates, hints):
    res = await tools.call(CORPUS, "propose_view", {"name": "Posts", "why": "to read the board",
                                                    "claims": ["board.jsonl"], "unit": "a post", "overview": "a list",
                                                    "zoom": "a post", "filter": "labels", "details": "the body",
                                                    "effort": "low"}, tool_use_id="toolu_main1")
    assert not res.is_error, res.text
    inp = json.loads(res.text.split("AGENT CALL ", 1)[1].splitlines()[0])
    assert inp["subagent_type"] == "thimble:view-builder" and "run_in_background" not in inp and "model" not in inp
    assert not bridge.ops("spawn"), "main makes the call, not the module"
    rid = sf.REQUEST_RE.search(inp["prompt"].split("\n", 1)[0]).group(0)
    req = subagents.request(CORPUS, rid)
    assert (req["route"], req["values"]) == ("typed", {"model": "claude-opus-5-5", "effort": "low"})
    with subagents.update(CORPUS) as state:
        assert sf.check_call(state, {"tool_name": "Agent", "tool_use_id": "toolu_x", "tool_input": inp}) is None
    slug = views.built_slug(CORPUS, "Posts") or next(p["slug"] for p in views.list_proposals(CORPUS))
    assert _prop(slug)["status"] == "building" and (CORPUS, slug) in dev._view_runs


async def test_an_orientation_s_proposal_builds_as_a_follow_on_start_when_the_pool_has_room(board, bridge, gates,
                                                                                             monkeypatch):
    monkeypatch.setattr(dev, "VIEW_POOL", 1)
    first, second = _propose("Posts", orientation=True), _propose("Threads", orientation=True)
    await _until(lambda: len(bridge.ops("spawn")) == 1, "the first build never started")
    await asyncio.sleep(0.05)
    assert len(bridge.ops("spawn")) == 1 and (CORPUS, second) in dev._view_queue, "at most VIEW_POOL builds start"
    req = subagents.request(CORPUS, bridge.ops("spawn")[0]["request"])
    assert req["route"] == "follow-on" and _prop(first)["held"]


async def test_a_start_refused_at_the_subagent_limit_goes_back_to_the_queue_with_no_failure(board, bridge, gates,
                                                                                           monkeypatch):
    monkeypatch.setattr(dev, "VIEW_POOL", 1)
    monkeypatch.setattr(dev, "LIMIT_RETRY_S", 0.05)
    bridge.answers.append({"limit": "Claude Code runs at most 20 concurrent subagents"})
    slug = _propose(asked=True)
    await _until(lambda: len(bridge.ops("spawn")) == 2, "the refused start was never tried again")
    await _until(lambda: _prop(slug).get("status") == "building", "it never started")
    assert not _prop(slug).get("refused") and not _prop(slug).get("error")


async def test_a_start_refused_otherwise_fails_the_view_with_its_refusal_and_start_it(board, bridge, gates):
    bridge.answers.append({"deny": "PreToolUse:Agent hook error: PLAN MODE"})
    slug = _propose(asked=True)
    ans = await dev.start_build(CORPUS, slug, subagents.CLICK)
    assert ans.kind == "hook"
    prop = _prop(slug)
    assert prop["status"] == "failed" and prop["refused"]["kind"] == "hook" and prop["refused"]["request"]
    bridge.is_live, bridge.reason = False, "THIMBLE_NO_MODULE is set"
    slug2 = _propose("Threads", asked=True)
    ans = await dev.start_build(CORPUS, slug2, subagents.CLICK)
    assert ans.kind == "no-module" and _prop(slug2)["refused"]["kind"] == "no-module"


# --------------------------------------------------------------------------- the gate tools


async def test_finish_view_registers_a_passing_view_once_and_tells_main(board, bridge, gates, heard, hints):
    slug = _propose(asked=True)
    agent = await _started(slug)
    key = view_tools.build_key(slug)
    _draft(slug)
    res = await _call("view_check", {"locators": ["board.jsonl#L1"]}, agent, key)
    assert not res.is_error and "The checks pass." in res.text and _prop(slug)["locators"] == ["board.jsonl#L1"]
    res = await _call("finish_view", {}, agent, key)
    assert not res.is_error and res.text.endswith(tools.hint("finish-view-pass"))
    prop = _prop(slug)
    assert prop["status"] == "built" and prop["finish"] == {"agent": agent, "result": "pass",
                                                             "version": views.read_view(CORPUS, slug)["version"]}
    assert [k for k, _ in heard] == ["view"] and heard[0][1]["view"] == slug
    again = await _call("finish_view", {}, agent, key)
    assert again.text.endswith(tools.hint("finish-view-pass")) and len(heard) == 1 and gates.count(slug) == 2, \
        "a second finish runs no gate and tells main nothing more"


async def test_finish_view_counts_the_attempts_and_a_call_after_the_last_runs_nothing(board, bridge, gates, hints):
    slug = _propose(asked=True)
    agent = await _started(slug)
    key = view_tools.build_key(slug)
    _draft(slug, "<p>FAIL</p>")
    for n in range(1, dev.MAX_ATTEMPTS):
        res = await _call("finish_view", {}, agent, key)
        assert f"attempt {n} of {dev.MAX_ATTEMPTS}" in res.text and "problem: the page says FAIL" in res.text
    res = await _call("finish_view", {}, agent, key)
    assert res.text.endswith(tools.hint("finish-view-stop"))
    gated = len(gates)
    _draft(slug)
    res = await _call("finish_view", {}, agent, key)
    assert res.text.endswith(tools.hint("finish-view-stop")) and len(gates) == gated, "no gate after the last attempt"
    assert _prop(slug)["status"] == "building" and views.read_built(CORPUS, slug) is None


async def test_the_gate_tools_refuse_main_another_view_s_builder_and_a_builder_s_own_subagent(board, bridge, gates):
    slug, other = _propose(asked=True), _propose("Threads", asked=True)
    agent = await _started(slug)
    theirs = await _started(other)
    _draft(slug)
    res = await _call("finish_view", {}, theirs, view_tools.build_key(slug))
    assert res.is_error and "not that agent's" in res.text, "another view's builder"
    with subagents.update(CORPUS) as state:
        sf.registry(state)["child1"] = {"type": "general-purpose", "parent": agent, "root": agent, "status": "running"}
    res = await _call("finish_view", {}, "child1", view_tools.build_key(slug))
    assert res.is_error, "the builder's own subagent"
    res = await tools.call(CORPUS, "finish_view", {}, session=None, tool_use_id="toolu_main")
    assert res.is_error
    assert _prop(slug)["status"] == "building" and not gates


async def test_a_gate_whose_builder_was_stopped_meanwhile_registers_nothing(board, bridge, gates, heard, monkeypatch):
    slug = _propose(asked=True)
    agent = await _started(slug)
    _draft(slug)
    real = views.gate

    async def slow(c, s, locators=None, **kw):
        subagents.run_ended(CORPUS, agent, "stopped", "", source="notification")  # TaskStop while the gate runs
        return await real(c, s, locators, **kw)

    monkeypatch.setattr(views, "gate", slow)
    res = await _call("finish_view", {}, agent, view_tools.build_key(slug))
    assert res.is_error and not heard and _prop(slug).get("finish") is None


async def test_a_builder_still_running_after_its_pass_is_stopped_after_the_grace(board, bridge, gates, monkeypatch):
    monkeypatch.setattr(view_tools, "FINISH_GRACE_S", 0.05)
    slug = _propose(asked=True)
    agent = await _started(slug)
    _draft(slug)
    await _call("finish_view", {}, agent, view_tools.build_key(slug))
    await _until(lambda: bridge.ops("stop"), "the builder was never stopped")
    assert bridge.ops("stop")[0]["agent"] == agent
    subagents.run_ended(CORPUS, agent, "stopped", "", source="notification")
    await asyncio.sleep(0.05)
    assert _prop(slug)["status"] == "built", "its run ends as the finish tool said"


# --------------------------------------------------------------------------- the digest rule


async def test_readers_see_only_what_a_gate_passed(board, bridge, gates):
    slug = _propose(asked=True)
    agent = await _started(slug)
    _draft(slug, "<p>v1</p>")
    await _call("finish_view", {}, agent, view_tools.build_key(slug))
    v1 = views.read_built(CORPUS, slug)
    assert v1 is not None and v1["dir"] == str(views.views_dir(CORPUS) / slug)
    (views.views_dir(CORPUS) / slug / views.VIEW_HTML).write_text("<p>an edit after the pass</p>")
    kept = views.read_built(CORPUS, slug)
    assert kept["version"] == v1["version"] and kept["dir"] != v1["dir"], "the copy kept at the pass"
    assert (Path(kept["dir"]) / views.VIEW_HTML).read_text() == "<p>v1</p>"
    assert [v["dir"] for v in views.list_views(CORPUS) if v["slug"] == slug] == [kept["dir"]]
    raw = json.loads((views.views_dir(CORPUS) / slug / views.VIEW_JSON).read_text())
    forged = {**raw, "built": "2026-10-06T00:00:00+00:00", "version": "0123456789ab"}
    (views.views_dir(CORPUS) / slug / views.VIEW_JSON).write_text(json.dumps(forged))
    assert views.read_built(CORPUS, slug)["version"] == v1["version"], "a stamp with no kept copy is ignored"
    fresh = _propose("Threads", asked=True)
    _draft(fresh)
    d = views.views_dir(CORPUS) / fresh
    (d / views.VIEW_JSON).write_text(json.dumps({**json.loads((d / views.VIEW_JSON).read_text()),
                                                  "built": "x", "version": "abcdefabcdef"}))
    assert views.read_built(CORPUS, fresh) is None, "a view no gate passed reaches no reader"


async def test_the_builder_s_end_gates_a_folder_that_changed_after_its_pass(board, bridge, gates):
    slug = _propose(asked=True)
    agent = await _started(slug)
    _draft(slug, "<p>v1</p>")
    await _call("finish_view", {}, agent, view_tools.build_key(slug))
    v1 = views.read_view(CORPUS, slug)["version"]
    (views.views_dir(CORPUS) / slug / views.VIEW_HTML).write_text("<p>FAIL</p>")
    subagents.run_ended(CORPUS, agent, "done", "Built.", source="handback")
    await _until(lambda: (views.views_dir(CORPUS) / slug / views.VIEW_HTML).read_text() == "<p>v1</p>",
                 "a failing change after the pass was not put back")
    assert views.read_view(CORPUS, slug)["version"] == v1 and views.passed_as_is(CORPUS, slug)

    other = _propose("Threads", asked=True)
    theirs = await _started(other)
    _draft(other, "<p>v1</p>")
    await _call("finish_view", {}, theirs, view_tools.build_key(other))
    first = views.read_view(CORPUS, other)["version"]
    (views.views_dir(CORPUS) / other / views.VIEW_HTML).write_text("<p>v2</p>")
    subagents.run_ended(CORPUS, theirs, "done", "Built.", source="handback")
    await _until(lambda: views.read_view(CORPUS, other)["version"] != first, "a passing change was not stamped")
    assert views.passed_as_is(CORPUS, other)


async def test_a_change_found_with_no_agent_of_the_view_running_is_gated_once(board, bridge, gates, monkeypatch):
    monkeypatch.setattr(views, "FOUND_GATE_S", 0.01)
    views._bind_loop()
    slug = _propose(asked=True)
    agent = await _started(slug)
    _draft(slug, "<p>v1</p>")
    await _call("finish_view", {}, agent, view_tools.build_key(slug))
    subagents.run_ended(CORPUS, agent, "done", "Built.", source="handback")
    await asyncio.sleep(0.05)
    gated = len(gates)
    (views.views_dir(CORPUS) / slug / views.VIEW_HTML).write_text("<p>the analyst's edit</p>")
    views.read_built(CORPUS, slug)
    views.read_built(CORPUS, slug)
    await _until(lambda: views.passed_as_is(CORPUS, slug), "the change found was never gated")
    assert len(gates) == gated + 1 and (views.views_dir(CORPUS) / slug / views.VIEW_HTML).read_text() == \
        "<p>the analyst's edit</p>"


# --------------------------------------------------------------------------- build ends


async def test_a_builder_that_ends_without_finish_view_gets_the_gate_once(board, bridge, gates, heard):
    slug = _propose(asked=True)
    agent = await _started(slug)
    _draft(slug)
    subagents.run_ended(CORPUS, agent, "done", "Done.", source="handback")
    await _until(lambda: _prop(slug).get("status") == "built", "the backstop gate never registered the view")
    assert gates == [slug] and [k for k, _ in heard] == ["view"]


async def test_an_orientation_s_failing_proposal_is_repaired_then_dropped_and_an_asked_one_fails_with_retry(
        board, bridge, gates, monkeypatch):
    slug = _propose(orientation=True)
    agent = await _started(slug, route=subagents.FOLLOW_ON)
    _draft(slug, "<p>FAIL</p>")
    for n in range(1, dev.VIEW_REPAIRS + 1):
        subagents.run_ended(CORPUS, agent, "done", "It still fails.", source="handback")
        await _until(lambda: len(bridge.ops("spawn")) == n + 1, f"repair {n} never started")
        spawn = bridge.ops("spawn")[-1]
        assert f"repair {n} of {dev.VIEW_REPAIRS}" in spawn["prompt"] and "problem: the page says FAIL" in spawn["prompt"]
        assert subagents.request(CORPUS, spawn["request"])["route"] == "follow-on"
        agent = _prop(slug)["agent_id"]
    subagents.run_ended(CORPUS, agent, "done", "It still fails.", source="handback")
    await _until(lambda: _prop(slug).get("status") == "dropped", "the proposal was never dropped")
    assert len(bridge.ops("spawn")) == dev.VIEW_REPAIRS + 1

    asked = _propose("Threads", asked=True)
    theirs = await _started(asked)
    _draft(asked, "<p>FAIL</p>")
    subagents.run_ended(CORPUS, theirs, "done", "It fails.", source="handback")
    await _until(lambda: _prop(asked).get("status") == "failed", "the asked view never failed")
    assert "FAIL" in _prop(asked)["error"] and len(bridge.ops("spawn")) == dev.VIEW_REPAIRS + 2, "no repair"
    views.retry(CORPUS, asked, {"effort": "low"})
    assert _prop(asked)["status"] == "queued" and _prop(asked)["values"] == {"effort": "low"}


async def test_the_analyst_s_stop_and_main_s_quit_end_a_build_failed_with_retry(board, bridge, gates):
    slug = _propose(asked=True)
    agent = await _started(slug)
    assert views.stop_build(CORPUS, slug) == {"ok": True}
    await _until(lambda: bridge.ops("stop"), "no TaskStop through the module")
    assert (CORPUS, slug) not in dev._view_runs, "its place in the pool frees at once"
    subagents.run_ended(CORPUS, agent, "stopped", "", source="notification")
    await _until(lambda: _prop(slug).get("status") == "failed", "the stopped build never failed")
    assert _prop(slug)["error"] == dev.VIEW_STOPPED

    other = _propose("Threads", asked=True)
    await _started(other)
    subagents.close_running(CORPUS)
    await _until(lambda: _prop(other).get("status") == "failed", "main's quit left the build running")
    assert _prop(other)["error"] == dev.MAIN_ENDED


# --------------------------------------------------------------------------- changes


async def test_a_change_goes_to_the_last_builder_when_it_can_be_reached_else_to_a_new_one(board, bridge, gates,
                                                                                          monkeypatch):
    slug = _propose(asked=True)
    agent = await _started(slug)
    monkeypatch.setattr(dev, "VIEW_POOL", 2)
    _draft(slug, "<p>v1</p>")
    await _call("finish_view", {}, agent, view_tools.build_key(slug))
    subagents.run_ended(CORPUS, agent, "done", "Built.", source="handback")
    await asyncio.sleep(0.05)
    monkeypatch.setattr(dev, "_reachable", lambda c, a: a == agent)
    views.revise(CORPUS, slug, "show the threads too", asked=True)
    await _until(lambda: bridge.ops("send"), "the change never reached the last builder")
    send = bridge.ops("send")[0]
    assert send["agent"] == agent and "show the threads too" in send["text"] and len(bridge.ops("spawn")) == 1
    subagents.run_again(CORPUS, agent, "coordinator")
    assert _prop(slug)["status"] == "building" and _prop(slug)["attempt"] == 0
    (views.views_dir(CORPUS) / slug / views.VIEW_HTML).write_text("<p>FAIL</p>")
    subagents.run_ended(CORPUS, agent, "done", "It fails.", source="handback")
    await _until(lambda: _prop(slug).get("status") == "built" and _prop(slug).get("failed_change"),
                 "a failed change did not leave the view as it was")
    assert (views.views_dir(CORPUS) / slug / views.VIEW_HTML).read_text() == "<p>v1</p>"

    monkeypatch.setattr(dev, "_reachable", lambda c, a: False)
    views.revise(CORPUS, slug, "a legend", asked=True)
    await _until(lambda: len(bridge.ops("spawn")) == 2, "an unreachable builder's change got no new builder")
    assert "a legend" in bridge.ops("spawn")[-1]["prompt"] and len(bridge.ops("send")) == 1


# --------------------------------------------------------------------------- the review


@pytest.fixture()
def pictures(monkeypatch):
    """views.shoot_states faked: each state a picture file written where the review asks, with a fitting page."""
    asked: list[list[dict]] = []

    async def shoot_states(c, slug, states, *, answers=0, **_kw):
        asked.append(states)
        out = []
        for st in states:
            Path(st["out"]).parent.mkdir(parents=True, exist_ok=True)
            Path(st["out"]).write_bytes(b"\x89PNG\r\n\x1a\n")
            out.append({"ok": True, "fonts": True, "png": str(st["out"]), "layout": {}, "answers": [{"n": 1}],
                        "controls": ["Day"]})
        return out

    monkeypatch.setattr(views, "shoot_states", shoot_states)
    monkeypatch.setattr(view_review.headless, "missing", lambda what: False)
    return asked


async def _reviewed(slug: str) -> tuple[str, str]:
    """A view built and its reviewer started: (the reviewer's agent id, its key)."""
    agent = await _started(slug)
    _draft(slug, "<p>v1</p>")
    await _call("finish_view", {}, agent, view_tools.build_key(slug))
    ans = await view_review.begin(CORPUS, slug, route=subagents.FOLLOW_ON)
    assert ans.started, dict(ans)
    return str(ans.agent_id), view_tools.review_key(slug)


async def test_view_pictures_writes_the_overview_and_the_states_asked_for_into_the_round_s_folder(
        board, bridge, gates, pictures, hints):
    slug = _propose(asked=True)
    reviewer, key = await _reviewed(slug)
    res = await _call("view_pictures", {"states": [{"state": "wide", "why": "the layout"}]}, reviewer, key)
    assert not res.is_error, res.text
    [states] = pictures
    assert [Path(s["out"]).parent for s in states] == [dev.view_work_dir(CORPUS, slug) / "review" / "1"] * 2
    assert all(str(s["out"]) in res.text for s in states) and "1528" in res.text
    more = [{"state": "narrow", "why": "x"}, {"state": "labels", "why": "y"}, {"state": "filtered", "why": "z"}]
    res = await _call("view_pictures", {"states": more}, reviewer, key)
    assert len(pictures[-1]) == 2, "the round's overview is taken, and two more states are left"
    res = await _call("view_pictures", {"states": more}, reviewer, key)
    assert res.is_error and "No picture is left" in res.text


async def test_finish_review_keeps_a_passing_revision_counts_the_round_and_restores_a_failing_one(
        board, bridge, gates, pictures, hints):
    slug = _propose(asked=True)
    reviewer, key = await _reviewed(slug)
    folder = views.views_dir(CORPUS) / slug
    (folder / views.VIEW_HTML).write_text("<p>v2</p>")
    res = await _call("finish_review", {"revised": ["the axis names days"]}, reviewer, key)
    assert res.text.endswith(tools.hint("finish-review-again"))
    review = _prop(slug)["review"]
    assert (review["round"], review["revised"], review["state"]) == (1, ["the axis names days"], "running")
    assert views.passed_as_is(CORPUS, slug) and (folder / views.VIEW_HTML).read_text() == "<p>v2</p>"
    (folder / views.VIEW_HTML).write_text("<p>FAIL</p>")
    res = await _call("finish_review", {"revised": ["a legend"]}, reviewer, key)
    assert res.text.endswith(tools.hint("finish-review-restored"))
    assert (folder / views.VIEW_HTML).read_text() == "<p>v2</p>" and views.passed_as_is(CORPUS, slug)
    review = _prop(slug)["review"]
    assert review["note"] == view_review.REVISION_FAILED_NOTE and review["finished"]
    res = await _call("finish_review", {}, reviewer, key)
    assert res.text.endswith(tools.hint("finish-review-done")), "a call after the review ended runs nothing"
    subagents.run_ended(CORPUS, reviewer, "done", "Revised the axis.", source="handback")
    await _until(lambda: not view_review.running(CORPUS, slug), "the reviewer never ended")
    assert view_review.undo(CORPUS, slug)["undo"] and (folder / views.VIEW_HTML).read_text() == "<p>v1</p>"


async def test_a_review_with_no_problems_is_done_after_its_second_round_at_the_latest(board, bridge, gates, pictures,
                                                                                    hints):
    slug = _propose(asked=True)
    reviewer, key = await _reviewed(slug)
    res = await _call("finish_review", {"left": ["a taste in colours"]}, reviewer, key)
    assert res.text.endswith(tools.hint("finish-review-done")) and _prop(slug)["review"]["left"] == ["a taste in colours"]
    other = _propose("Threads", asked=True)
    second, key2 = await _reviewed(other)
    folder = views.views_dir(CORPUS) / other
    for n, html in enumerate(("<p>v2</p>", "<p>v3</p>"), 1):
        (folder / views.VIEW_HTML).write_text(html)
        res = await _call("finish_review", {"revised": [f"fix {n}"]}, second, key2)
    assert res.text.endswith(tools.hint("finish-review-done")) and _prop(other)["review"]["round"] == view_review.ROUNDS


async def test_a_reviewer_that_ends_without_finish_review_has_its_edit_gated_once(board, bridge, gates, pictures):
    slug = _propose(asked=True)
    reviewer, _ = await _reviewed(slug)
    folder = views.views_dir(CORPUS) / slug
    (folder / views.VIEW_HTML).write_text("<p>FAIL</p>")
    subagents.run_ended(CORPUS, reviewer, "done", "I fixed it.", source="handback")
    await _until(lambda: (_prop(slug).get("review") or {}).get("state") == "done", "the review never ended")
    assert (folder / views.VIEW_HTML).read_text() == "<p>v1</p>"
    assert _prop(slug)["review"]["note"] == view_review.REVISION_FAILED_NOTE


async def test_a_build_s_pass_starts_its_review_as_a_follow_on_start(board, bridge, gates, pictures, monkeypatch):
    monkeypatch.setenv("THIMBLE_VIEW_REVIEW", "on")
    slug = _propose(asked=True)
    agent = await _started(slug)
    _draft(slug)
    await _call("finish_view", {}, agent, view_tools.build_key(slug))
    subagents.run_ended(CORPUS, agent, "done", "Built.", source="handback")
    await _until(lambda: any(s["role"] == "view-reviewer" for s in bridge.ops("spawn")), "no review started")
    spawn = next(s for s in bridge.ops("spawn") if s["role"] == "view-reviewer")
    assert subagents.request(CORPUS, spawn["request"])["route"] == "follow-on"
    assert str(views.views_dir(CORPUS) / slug) in spawn["prompt"] and spawn["description"] == "review: Posts"


# --------------------------------------------------------------------------- the clicks are the analyst's


VIEW_CLICKS = [("post", "/api/ws/boards/views/posts/build", {"effort": "low"}),
               ("post", "/api/ws/boards/views/proposals/posts/retry", None),
               ("post", "/api/ws/boards/views/proposals/posts/stop", None),
               ("post", "/api/ws/boards/views/proposals/posts/accept", None),
               ("post", "/api/ws/boards/views/proposals/posts/message", {"text": "a legend"}),
               ("post", "/api/ws/boards/views/posts/review", None),
               ("delete", "/api/ws/boards/views/posts/review", None)]


@pytest.mark.real_write_guard
def test_every_job_click_route_refuses_the_server_s_token_without_the_analyst_s_cookie(board, bridge, plugin_headers):
    from app import main

    _propose(asked=True)
    client = TestClient(main.create_app())
    for method, path, body in VIEW_CLICKS:
        kw = {"json": body} if body is not None else {}
        r = getattr(client, method)(path, headers=plugin_headers(), **kw)
        assert r.status_code == 403, (path, r.status_code, r.text)
        r = getattr(client, method)(path, **kw)
        assert r.status_code == 403, ("neither cookie nor token, as a kernel cell posts it", path)
    assert not bridge.calls, "the module is never asked"


def test_the_module_registers_the_view_roles_on_their_settings_row(board):
    """subagents.roles holds `thimble:view-builder` and `thimble:view-reviewer` on Settings' dev row, each with an
    explicit effort, a fixed description, and the thimble tools that are not its own taken away."""
    roles = subagents.roles(CORPUS)
    assert {"orientation", "critic", "writer", "view-builder", "view-reviewer", "helper"} <= set(roles)
    own = {"view-builder": view_tools.BUILDER_TOOLS, "view-reviewer": view_tools.REVIEWER_TOOLS}
    for role, mine in own.items():
        r = roles[role]
        assert r["type"] == f"thimble:{role}" and r["background"] and r["description"].strip()
        assert (r["model"], r["effort"]) == ("claude-opus-5-5", "high")
        assert not [n for n in mine if tools.thimble_tool(n) in r["disallowedTools"]]
        assert tools.thimble_tool("add_card") in r["disallowedTools"]
        assert "{{" not in r["prompt"] and len(r["prompt"]) > 500
    assert str(views.EXAMPLES_DIR) in roles["view-builder"]["prompt"] and "finish_view" in roles["view-builder"]["prompt"]
    assert "view_pictures" in roles["view-reviewer"]["prompt"] and "finish_review" in roles["view-reviewer"]["prompt"]
    assert "WebFetch" in roles["view-builder"]["disallowedTools"], "the dev agent's web is off by default"
