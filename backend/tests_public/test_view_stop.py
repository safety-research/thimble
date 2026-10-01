"""The Stop in a view build's thread (views.stop_build): a build has no time limit, so the analyst ends one that runs
too long there. Every session turn and gate is faked."""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest
from fastapi import HTTPException

from app import agents, config, dev, userconf, view_review, views

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
    monkeypatch.setenv("THIMBLE_SANDBOX", "0")
    monkeypatch.setitem(userconf.DEFAULTS["sandbox"], "enforce", False)
    monkeypatch.setattr(views, "build_problem", lambda: "")
    monkeypatch.setattr(dev, "_view_queue", [])
    monkeypatch.setattr(dev, "_view_runs", {})
    monkeypatch.setattr(dev, "_view_stopping", {})
    return corpus


class _Sessions:
    def __init__(self) -> None:
        self.stopped: list[str | None] = []

    def stop(self, short: str | None) -> None:
        self.stopped.append(short)


def _write(slug: str) -> None:
    views.write_view(CORPUS, slug, reader=READER, html=f"<!doctype html><p>{slug}</p>", name=slug.title(),
                     description="The board's posts.", claims=["board.jsonl"],
                     accepts=[{"form": "L<n>", "means": "one post"}], units=[], libs=[])


@pytest.fixture()
def fake(monkeypatch):
    """The sessions: a turn of a slug in `quiet` runs until it is cancelled, any other writes its view. The turns taken,
    by slug, and the sessions stopped."""
    sessions = _Sessions()
    quiet: set[str] = set()
    turns: list[str] = []

    async def turn(run, run_log, cwd, prompt, resume, **_kw):
        slug = run.ticket_id.removeprefix("view:")
        run.session, run.session_id = f"s-{slug}", f"sid-{slug}"
        turns.append(slug)
        if slug in quiet:
            await asyncio.Event().wait()
        _write(slug)
        return "the view is written"

    async def gate(c, slug, locators=None):
        ok = (views.views_dir(c) / slug / views.VIEW_JSON).is_file()
        return {"ok": ok, "checks": [], "page": {"ok": ok}, "errors": [] if ok else ["no view"]}

    monkeypatch.setattr(dev, "SESSIONS", sessions)
    monkeypatch.setattr(dev, "_worker_turn", turn)
    monkeypatch.setattr(views, "gate", gate)
    monkeypatch.setattr(views, "gate_lines", lambda rep: list(rep.get("errors") or []) or ["the checks passed"])
    monkeypatch.setattr(view_review, "after_built", lambda c, slug: None)
    return sessions, quiet, turns


async def _until(cond, what: str) -> None:
    for _ in range(500):
        if cond():
            return
        await asyncio.sleep(0.01)
    raise AssertionError(what)


def _status(slug: str) -> tuple[str | None, str | None]:
    p = views.read_proposal(CORPUS, slug) or {}
    return p.get("status"), p.get("error")


def test_the_stop_in_a_build_s_thread_fails_the_view_with_retry_and_frees_its_slot_in_the_pool(board, fake, monkeypatch):
    sessions, quiet, turns = fake
    monkeypatch.setattr(dev, "VIEW_POOL", 1)
    first, second = (views.propose(CORPUS, n, "to read the board", ["board.jsonl"], "one row per post", asked=True)["slug"]
                     for n in ("Posts", "Threads"))
    quiet.add(first)

    async def go() -> None:
        dev._start_views()
        await _until(lambda: turns == [first], "the first build's turn never started")
        await asyncio.sleep(0.05)
        assert _status(first)[0] == "building" and _status(second)[0] == "queued", "the pool holds one build"
        task = dev._view_runs[(CORPUS, first)].task
        assert views.stop_build(CORPUS, first) == {"ok": True}
        await asyncio.wait_for(asyncio.gather(task, return_exceptions=True), 5)
        assert _status(first) == ("failed", dev.VIEW_STOPPED)
        assert f"s-{first}" in sessions.stopped
        chat = (views.read_proposal(CORPUS, first) or {}).get("chat")
        assert (agents.meta_or_none(CORPUS, chat) or {}).get("status") == "stopped"
        await _until(lambda: _status(second)[0] == "built", "the queued build never got the freed slot")
        quiet.discard(first)
        views.retry(CORPUS, first)
        await _until(lambda: _status(first)[0] == "built", "Retry did not build the stopped view")

    asyncio.run(go())
    assert turns == [first, second, first]


def test_a_queued_build_stops_at_once_a_change_stopped_leaves_the_view_as_it_was_and_a_built_view_has_no_stop(
        board, fake, monkeypatch):
    sessions, quiet, turns = fake
    monkeypatch.setattr(dev, "VIEW_POOL", 1)
    slug = views.propose(CORPUS, "Posts", "to read the board", ["board.jsonl"], "one row per post", asked=True)["slug"]
    assert slug in [s for _, s in dev._view_queue]
    assert views.stop_build(CORPUS, slug) == {"ok": True}
    assert _status(slug) == ("failed", dev.VIEW_STOPPED) and not dev._view_queue, "no build ever started"
    with pytest.raises(HTTPException) as e:
        views.stop_build(CORPUS, "nothing")
    assert e.value.status_code == 404

    async def build_then_change() -> None:
        views.retry(CORPUS, slug)
        await _until(lambda: _status(slug)[0] == "built", "the view never built")
        with pytest.raises(HTTPException) as e:
            views.stop_build(CORPUS, slug)
        assert e.value.status_code == 409
        built = (views.views_dir(CORPUS) / slug / "view.html").read_text()
        quiet.add(slug)
        views.revise(CORPUS, slug, "show the threads too", asked=True)
        await _until(lambda: turns.count(slug) == 2, "the change's turn never started")
        (views.views_dir(CORPUS) / slug / "view.html").write_text("<p>half a change</p>")
        task = dev._view_runs[(CORPUS, slug)].task
        views.stop_build(CORPUS, slug)
        await asyncio.wait_for(asyncio.gather(task, return_exceptions=True), 5)
        prop = views.read_proposal(CORPUS, slug) or {}
        assert (prop.get("status"), prop.get("error"), prop.get("failed_change")) == (
            "built", dev.VIEW_STOPPED, "show the threads too")
        assert (views.views_dir(CORPUS) / slug / "view.html").read_text() == built, "the view is back as it was built"

    asyncio.run(build_then_change())
