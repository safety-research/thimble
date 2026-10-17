"""The Stop in a view build's thread (views.stop_build): a build has no time limit, so the analyst ends one that runs
too long there. The builder is a subagent of main, stopped through thimble's module (the fake bridge); its end, as
the killed notification brings it, is subagents.run_ended. The gate is faked."""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from app import agents, config, dev, subagents, views
from subagent_fakes import bridge  # noqa: F401 — a fixture
from target_blocks import target_blocks  # noqa: F401 — the core lane's target flags, where prompts.py lacks them

CORPUS = "boards"


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
