"""View builds as subagents of main (dev.py, view_tools.py, views.py): a builder (`thimble:view-builder`) starts through
thimble's module for the analyst's click, checks its view with `view_check` and finishes with `finish_view`, where the
server runs the gates of record, registers the view and tells main. Checks that fail when the builder stops go back to
it once; a view that still fails says what is wrong, with Send to thimble-fix and Discard.

The module is the fake bridge (subagent_fakes); an agent's calls are made through tools.call with the caller hook's line
written first, as the PreToolUse hook writes it. The gate is faked: a view passes when its folder holds view.json and
its page says no FAIL."""
from __future__ import annotations

import asyncio
import itertools
import json
from pathlib import Path

import pytest

from app import agents, config, dev, session, subagents, tools, view_review, view_tools, views
from app import subagent_files as sf
from subagent_fakes import bridge  # noqa: F401 — a fixture

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
    sf.add_caller(config.workspace_dir(CORPUS), tid, agent, str(a.get("type") or "thimble:orient-helper"))
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


async def test_a_click_starts_a_builder_whose_finish_view_registers_the_view_and_tells_main(board, bridge, gates, heard):
    slug = _propose(asked=True)
    agent = await _started(slug, values={"model": "sonnet", "effort": "max"})
    [spawn] = bridge.ops("spawn")
    assert spawn["role"] == "view-builder" and spawn["values"] == {"model": "claude-sonnet-5-5", "effort": "max"}
    assert spawn["description"] == "view: Posts" and spawn["what"] == slug
    folder, work = views.views_dir(CORPUS) / slug, dev.view_work_dir(CORPUS, slug)
    assert str(folder) in spawn["prompt"] and str(work) in spawn["prompt"]
    prop = _prop(slug)
    assert (prop["status"], prop["agent_id"], prop["attempt"]) == ("building", agent, 0)
    meta = agents.read_meta(CORPUS, prop["chat"])
    assert meta["role"] == "dev" and meta["view"] == slug and meta["agent_id"] == agent

    key = view_tools.build_key(slug)
    _draft(slug)
    res = await _call("view_check", {"locators": ["board.jsonl#L1"]}, agent, key)
    assert not res.is_error and "The checks pass." in res.text
    res = await _call("finish_view", {}, agent, key)
    assert not res.is_error and res.text.endswith(tools.hint("finish-view-pass"))
    prop = _prop(slug)
    assert prop["status"] == "built" and prop["finish"] == {"agent": agent, "result": "pass",
                                                             "version": views.read_view(CORPUS, slug)["version"]}
    assert [k for k, _ in heard] == ["view"] and heard[0][1]["view"] == slug


async def test_checks_that_fail_when_the_builder_stops_go_back_to_it_and_then_say_what_is_wrong_with_its_fixes(
        board, bridge, gates, monkeypatch):
    """The builder stops with checks that fail: what they found goes back into its session, which goes on with it while
    the view builds. Stopped again without passing, the view fails, and its notice says it failed after retry and what
    is wrong with it in the analyst's words, with no Retry, which would build the same files again: Send puts what
    failed after /thimble-fix in main's composer, and Discard the view. A reply in its thread goes on with the same
    builder, whose start clears the notice."""
    from app import notices

    slug = _propose(asked=True)
    agent = await _started(slug)
    monkeypatch.setattr(dev, "_reachable", lambda c, a: a == agent)
    monkeypatch.setattr(dev, "VIEW_POOL", 2)
    _draft(slug, "<p>FAIL</p>")
    subagents.run_ended(CORPUS, agent, "done", "Built.", source="handback")
    await _until(lambda: bridge.ops("send"), "what the checks found never went back to the builder")
    [back] = bridge.ops("send")
    assert back["agent"] == agent and "problem: the page says FAIL" in back["text"] and "attempt 1 of" in back["text"]
    assert _prop(slug)["status"] == "building" and not notices.open_notices(CORPUS), "no notice while it goes on"
    subagents.run_again(CORPUS, agent, "coordinator")
    assert _prop(slug)["attempt"] == 1, "its attempts go on"
    subagents.run_ended(CORPUS, agent, "done", "I could not make the page pass.", source="handback")
    await _until(lambda: _prop(slug).get("status") == "failed", "the view never failed")
    p = _prop(slug)
    assert p["error"] == "problem: the page says FAIL" and p.get("checks_failed")
    [n] = [n for n in notices.open_notices(CORPUS) if n.get("kind") == "view"]
    said = views.plain_failure("problem: the page says FAIL")
    assert n["text"] == f"Posts failed after retry: {said}. Send to thimble-fix?" and n["chat"] == p["chat"]
    send, discard = n["action"]
    words = f"The view Posts failed after retry: {said} (“problem: the page says FAIL”). Make it build."
    assert send == {"label": "Send", "do": "thimble-fix", "text": words}, "Send's words say what failed"
    assert discard == {"label": dev.DISCARD_VIEW, "do": "view-discard", "slug": slug}
    views.message(CORPUS, slug, "Please fix the page.")
    await _until(lambda: len(bridge.ops("send")) == 2, "the reply never reached the builder")
    assert bridge.ops("send")[-1]["agent"] == agent and "Please fix the page." in bridge.ops("send")[-1]["text"]
    assert len(bridge.ops("spawn")) == 1, "the same builder goes on, no new build"
    assert _prop(slug)["status"] == "building" and not _prop(slug).get("checks_failed")
    subagents.run_again(CORPUS, agent, "coordinator")
    assert not [n for n in notices.open_notices(CORPUS) if n.get("kind") == "view"], "the builder took it up"


async def test_discard_on_a_view_whose_build_failed_drops_the_view_and_its_proposal(board, bridge, gates):
    from fastapi import HTTPException

    slug = _propose(asked=True)
    await _started(slug)
    _draft(slug, "<p>FAIL</p>")
    views.update_proposal(CORPUS, slug, status="failed", error="problem: the page says FAIL", checks_failed=True)
    assert views.discard(CORPUS, slug)["deleted"]
    assert views.read_proposal(CORPUS, slug) is None and not (views.views_dir(CORPUS) / slug).exists()
    with pytest.raises(HTTPException) as e:
        views.discard(CORPUS, slug)
    assert e.value.status_code == 404


async def test_a_view_s_review_runs_at_medium_effort_on_a_dev_row_at_medium_or_above(board, bridge, monkeypatch):
    """The reviewer takes the dev row's effort up to medium: medium on a row at medium, high, xhigh or max, and the
    row's own on a row at low. Its definition and its start carry that effort. The builder and a code ticket's agent
    keep the row's effort, and an effort a run's arguments name stands."""
    real = config.models_for
    runs_at = {"low": "low", "medium": "medium", "high": "medium", "xhigh": "medium", "max": "medium"}
    assert tuple(runs_at) == config.ROLE_EFFORTS
    for row, review in runs_at.items():
        dev_row = {"model": "claude-opus-5-5", "effort": row, "fast": False}
        monkeypatch.setattr(config, "models_for", lambda c=None, dev_row=dev_row: {**real(c), "dev": dict(dev_row)})
        assert subagents.values_for(CORPUS, "view-reviewer") == {"model": "claude-opus-5-5", "effort": review}, row
        assert subagents.roles(CORPUS)["view-reviewer"]["effort"] == review, row
        assert subagents.values_for(CORPUS, "view-builder")["effort"] == row
        assert subagents.values_for(CORPUS, "dev-ticket")["effort"] == row
    assert subagents.values_for(CORPUS, "view-reviewer", {"effort": "high"})["effort"] == "high"
    slug = _propose(asked=True)
    _draft(slug)
    assert (await view_review.begin(CORPUS, slug, route=subagents.CLICK)).started
    [spawn] = bridge.ops("spawn")
    assert spawn["role"] == "view-reviewer" and spawn["values"] == {"model": "claude-opus-5-5", "effort": "medium"}


def _reviews(bridge) -> list[dict]:
    """The starts of a view's reviewer asked of the module."""
    return [s for s in bridge.ops("spawn") if s["role"] == "view-reviewer"]


async def _passes(slug: str, agent: str, html: str, finishes: bool = True) -> None:
    """The builder `agent` writes the view `slug` so that it passes, and its run ends: finish_view registers the pass
    when it `finishes`, else the gate at its end does. Its end is settled, and a review it started has asked for its
    reviewer."""
    _draft(slug, html)
    if finishes:
        assert not (await _call("finish_view", {}, agent, view_tools.build_key(slug))).is_error
    subagents.run_ended(CORPUS, agent, "done", "Done.", source="handback")
    await _until(lambda: (CORPUS, slug) not in dev._settling, "the builder's end was never settled")
    for t in [t for t in asyncio.all_tasks() if t.get_name() == f"view-review:{CORPUS}:{slug}"]:
        await t


async def _changes(slug: str, agent: str, bridge, words: str) -> None:
    """The analyst's message about the built view `slug` reaches its finished builder `agent`, whose next run begins: a
    change to the view."""
    sent = len(bridge.ops("send"))
    views.message(CORPUS, slug, words)
    await _until(lambda: len(bridge.ops("send")) > sent, "the message never reached the builder")
    subagents.run_again(CORPUS, agent, "coordinator")
    assert _prop(slug)["revision"] and _prop(slug)["status"] == "building"


@pytest.mark.parametrize("finishes", [True, False])
async def test_a_view_s_first_build_starts_its_review_and_a_change_to_it_starts_none_while_review_again_starts_one(
        board, bridge, gates, heard, monkeypatch, analyst, finishes):
    """A view's first build that passes starts its review, a follow-on of the start that asked for the build. A change
    to the built view that passes starts none once a review of the view has ended: that review keeps its state and its
    time, without what it revised and without its copy of the view for Undo, since the changed view is the new version.
    Review again, the analyst's click, starts a review after the build and after the change. The same for a pass that
    finish_view registers (`finishes`) and for one that the gate at the builder's end registers."""
    from app import headless

    monkeypatch.setenv("THIMBLE_VIEW_REVIEW", "on")
    monkeypatch.setattr(headless, "missing", lambda *a, **k: [])
    clock = itertools.count()
    monkeypatch.setattr(view_review, "_now", lambda: f"t{next(clock)}")
    slug = _propose(asked=True)
    agent = await _started(slug)
    monkeypatch.setattr(dev, "_reachable", lambda c, a: a == agent)
    copies = views.state_dir(CORPUS) / view_review.REVIEWED_SUBDIR / slug

    async def reviewed(revised: list[str]) -> dict:
        """The reviewer that runs finishes its review, with a revision when it names what it `revised`, and ends."""
        reviewer = subagents.current(CORPUS, view_review.key(slug)).agent_id
        if revised:
            _draft(slug, "<p>posts, with room</p>")
        res = await _call("finish_review", {"revised": revised}, reviewer, view_review.key(slug))
        assert not res.is_error, res.text
        subagents.run_ended(CORPUS, reviewer, "done", "Reviewed.", source="handback")
        await _until(lambda: not [t for t in asyncio.all_tasks() if t.get_name().startswith("view-review-end:")],
                     "the reviewer's end was never settled")
        return _prop(slug)["review"]

    await _passes(slug, agent, "<p>posts</p>", finishes)
    [first] = _reviews(bridge)
    assert first["route"] == subagents.FOLLOW_ON and first["what"] == slug, "a first build starts the review"
    review = await reviewed(["the rows overlapped"])
    assert (review["state"], review["revised"]) == ("done", ["the rows overlapped"]) and copies.is_dir()

    assert (await view_review.again_route(CORPUS, slug, analyst))["ok"], "Review again after a build"
    assert [s["route"] for s in _reviews(bridge)] == [subagents.FOLLOW_ON, subagents.CLICK]
    before = await reviewed([])
    assert (before["state"], before["revised"]) == ("done", ["the rows overlapped"])

    await _changes(slug, agent, bridge, "Make the posts bold.")
    await _passes(slug, agent, "<p><b>posts</b></p>", finishes)
    assert _prop(slug)["status"] == "built" and not _prop(slug).get("revision")
    assert len(_reviews(bridge)) == 2 and not view_review.running(CORPUS, slug), "a change starts no review"
    assert _prop(slug)["review"] == {**before, "revised": []}, "the review before it stands, with nothing to undo"
    assert not copies.exists()

    assert (await view_review.again_route(CORPUS, slug, analyst))["ok"], "Review again after a change"
    assert [s["route"] for s in _reviews(bridge)][2:] == [subagents.CLICK]
    assert _prop(slug)["review"]["state"] == "running" and copies.is_dir()


async def test_with_the_review_turned_off_no_pass_starts_one_and_each_pass_leaves_none_on_the_proposal(
        board, bridge, gates, heard, monkeypatch):
    """THIMBLE_VIEW_REVIEW=off: neither a first build nor a change to the built view starts a review, and a review
    left on the proposal from before goes at either pass."""
    from app import headless

    monkeypatch.setenv("THIMBLE_VIEW_REVIEW", "off")
    monkeypatch.setattr(headless, "missing", lambda *a, **k: [])
    slug = _propose(asked=True)
    agent = await _started(slug)
    monkeypatch.setattr(dev, "_reachable", lambda c, a: a == agent)
    left = {"state": "done", "revised": ["the rows overlapped"], "ts": "2026-01-01T00:00:00+00:00"}
    views.update_proposal(CORPUS, slug, review=left)
    await _passes(slug, agent, "<p>posts</p>")
    assert not _reviews(bridge) and not _prop(slug).get("review")
    views.update_proposal(CORPUS, slug, review=left)
    await _changes(slug, agent, bridge, "Make the posts bold.")
    await _passes(slug, agent, "<p><b>posts</b></p>")
    assert _prop(slug)["status"] == "built" and not _reviews(bridge) and not _prop(slug).get("review")


@pytest.mark.parametrize("waits", [False, True])
async def test_a_change_starts_the_review_of_a_view_whose_review_has_not_ended(
        board, bridge, gates, heard, monkeypatch, waits):
    """A message about a view that reaches its builder after the first build passed, before that run ended, makes the
    run a change, so the first build's end starts no review. The change that passes starts it, since no review of the
    view has ended and its mark offers no Review again: with no review on the proposal, and with one that still
    `waits` for a free subagent."""
    from app import headless

    monkeypatch.setenv("THIMBLE_VIEW_REVIEW", "on")
    monkeypatch.setattr(headless, "missing", lambda *a, **k: [])
    slug = _propose(asked=True)
    agent = await _started(slug)
    _draft(slug, "<p>posts</p>")
    assert not (await _call("finish_view", {}, agent, view_tools.build_key(slug))).is_error
    assert _prop(slug)["status"] == "built" and not _reviews(bridge)
    if waits:
        views.update_proposal(CORPUS, slug, review={"state": "queued", "note": view_review.QUEUED_NOTE})
    views.message(CORPUS, slug, "Make the posts bold.")
    await _until(lambda: _prop(slug).get("revision"), "the message never joined the builder's run")
    assert [s["agent"] for s in bridge.ops("send")] == [agent] and len(bridge.ops("spawn")) == 1
    await _passes(slug, agent, "<p><b>posts</b></p>")
    [only] = _reviews(bridge)
    assert only["route"] == subagents.FOLLOW_ON and _prop(slug)["review"]["state"] == "running"
