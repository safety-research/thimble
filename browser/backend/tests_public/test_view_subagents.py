"""View builds as subagents of main (dev.py, view_tools.py, views.py): a builder (`thimble:view-builder`) starts through
thimble's module for the analyst's click, checks its view with `view_check` and finishes with `finish_view`, where the
server runs the gates of record, registers the view and tells main. Checks that fail when the builder stops go back to
it once; a view that still fails says what is wrong, with Send to thimble-fix and Discard.

The module is the fake bridge (subagent_fakes); an agent's calls are made through tools.call with the caller hook's line
written first, as the PreToolUse hook writes it. The gate is faked: a view passes when its folder holds view.json and
its page says no FAIL."""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from app import agents, config, dev, session, subagents, tools, view_tools, views
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
