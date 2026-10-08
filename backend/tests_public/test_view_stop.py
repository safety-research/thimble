"""The Stop in a view build's thread (views.stop_build): a build has no time limit, so the analyst ends one that runs
too long there. The builder is a subagent of main, stopped through thimble's module (the fake bridge); its end, as
the killed notification brings it, is subagents.run_ended. The gate is faked."""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest
from fastapi import HTTPException

from app import agents, config, dev, subagents, views
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
    monkeypatch.setattr(views, "build_problem", lambda: "")

    async def gate(c, slug, locators=None, **_kw):
        ok = (views.views_dir(c) / slug / views.VIEW_JSON).is_file()
        return {"ok": ok, "checks": [], "page": {"ok": ok}, "problems": [] if ok else ["problem: no view"]}

    monkeypatch.setattr(views, "gate", gate)
    monkeypatch.setattr(views, "gate_lines", lambda rep: list(rep.get("problems") or []) or ["the checks passed"])
    return corpus


def _write(slug: str) -> None:
    views.write_view(CORPUS, slug, reader=READER, html=f"<!doctype html><p>{slug}</p>", name=slug.title(),
                     description="The board's posts.", claims=["board.jsonl"],
                     accepts=[{"form": "L<n>", "means": "one post"}], units=[], libs=[])


async def _until(cond, what: str) -> None:
    for _ in range(300):
        if cond():
            return
        await asyncio.sleep(0.01)
    raise AssertionError(what)


def _status(slug: str) -> tuple[str | None, str | None]:
    p = views.read_proposal(CORPUS, slug) or {}
    return p.get("status"), p.get("error")


async def test_the_stop_in_a_build_s_thread_fails_the_view_with_retry_and_frees_its_place_in_the_pool(board, bridge,
                                                                                                    monkeypatch):
    first, second = (views.propose(CORPUS, n, "to read the board", ["board.jsonl"], "one row per post", asked=True)["slug"]
                     for n in ("Posts", "Threads"))
    monkeypatch.setattr(dev, "VIEW_POOL", 1)
    dev._start_views()
    await _until(lambda: (views.read_proposal(CORPUS, first) or {}).get("agent_id"), "the first build never started")
    assert _status(second)[0] == "queued", "the pool holds one build"
    agent = views.read_proposal(CORPUS, first)["agent_id"]
    assert views.stop_build(CORPUS, first) == {"ok": True}
    await _until(lambda: bridge.ops("stop"), "no TaskStop through the module")
    assert bridge.ops("stop")[0]["agent"] == agent
    await _until(lambda: (views.read_proposal(CORPUS, second) or {}).get("agent_id"),
                 "the queued build never got the freed place")
    subagents.run_ended(CORPUS, agent, "stopped", "", source="notification")
    await _until(lambda: _status(first) == ("failed", dev.VIEW_STOPPED), "the stopped build never failed")
    chat = (views.read_proposal(CORPUS, first) or {}).get("chat")
    assert (agents.meta_or_none(CORPUS, chat) or {}).get("status") == "stopped"


async def test_a_queued_build_stops_at_once_a_change_stopped_leaves_the_view_as_it_was_and_a_built_view_has_no_stop(
        board, bridge, monkeypatch):
    slug = views.propose(CORPUS, "Posts", "to read the board", ["board.jsonl"], "one row per post", asked=True)["slug"]
    assert slug in [s for _, s in dev._view_queue]
    assert views.stop_build(CORPUS, slug) == {"ok": True}
    assert _status(slug) == ("failed", dev.VIEW_STOPPED) and not dev._view_queue, "no build ever started"
    assert not bridge.ops("spawn")
    with pytest.raises(HTTPException) as e:
        views.stop_build(CORPUS, "nothing")
    assert e.value.status_code == 404

    _write(slug)
    assert _status(slug)[0] == "built"
    with pytest.raises(HTTPException) as e:
        views.stop_build(CORPUS, slug)
    assert e.value.status_code == 409
    built = (views.views_dir(CORPUS) / slug / "view.html").read_text()
    monkeypatch.setattr(dev, "VIEW_POOL", 1)
    views.revise(CORPUS, slug, "show the threads too", asked=True)
    await _until(lambda: bridge.ops("spawn"), "the change's builder never started")
    await _until(lambda: (views.read_proposal(CORPUS, slug) or {}).get("agent_id"), "the builder took no place")
    agent = views.read_proposal(CORPUS, slug)["agent_id"]
    (views.views_dir(CORPUS) / slug / "view.html").write_text("<p>half a change</p>")
    views.stop_build(CORPUS, slug)
    subagents.run_ended(CORPUS, agent, "stopped", "", source="notification")
    await _until(lambda: _status(slug) == ("built", dev.VIEW_STOPPED), "the stopped change did not end")
    assert (views.read_proposal(CORPUS, slug) or {}).get("failed_change") == "show the threads too"
    assert (views.views_dir(CORPUS) / slug / "view.html").read_text() == built, "the view is back as it was built"
