"""The orientation's first run holds its view proposals (views.propose `hold`): each builds at once, but neither it nor
its build is announced or listed until the run ends, and at release_held a view built by then appears ready at once. A
held proposal proposed again unchanged keeps its build; revised (after the critique) it is built again, a built view's
folder emptied first. The view build itself is not run: a proposal's view is written into its folder and marked built
as a build that passed its gate would be. The board is invented."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from app import agents, config, critique_session, dev, investigation, orientation, session, views

CORPUS = "boards"
ARGS = {"name": "Posts", "why": "one post at a time", "claims": ["board.jsonl"], "arrangement": "one post per page"}
READER = '''
def build_index(paths):
    return {}


def records(index, query):
    return []


def resolve(index, locator):
    return None
'''


@pytest.fixture()
def board(tmp_path, monkeypatch, workspaces_tmp) -> list[dict]:
    """The corpus, with the stream's `view` events and main's channel events recorded (the list returned)."""
    d = tmp_path / "data"
    corpus = d / CORPUS
    corpus.mkdir(parents=True)
    (corpus / "manifest.json").write_text(json.dumps({"name": CORPUS, "description": "a message board"}))
    (corpus / "board.jsonl").write_text(json.dumps({"body": "first post"}) + "\n")
    monkeypatch.setattr(config, "DATA_DIR", d.resolve())
    events: list[dict] = []
    monkeypatch.setattr(views, "_thread_loop", lambda: object())  # _emit sends at once
    monkeypatch.setattr(investigation, "emit", lambda c, chat, ev: events.append(ev))
    monkeypatch.setattr(session, "push_event", lambda c, kind, text, **m: events.append({"main": kind, **m}) or True)
    return events


def _build(slug: str = "posts") -> None:
    """The view's files written and registered, as a build whose gate passed leaves them (dev.run_view)."""
    d = views.views_dir(CORPUS) / slug
    d.mkdir(parents=True, exist_ok=True)
    (d / "view.json").write_text(json.dumps({"name": "Posts", "why": ARGS["why"], "claims": ARGS["claims"],
                                             "accepts": [], "declares": []}))
    (d / "reader.py").write_text(READER)
    (d / "view.html").write_text("<!doctype html><html><body></body></html>")
    views.mark_built(CORPUS, slug)


def _listed() -> list[str]:
    return [p["slug"] for p in views.list_proposals(CORPUS) if not p.get("held")]


def test_a_held_proposal_builds_at_once_unseen_and_appears_built_at_release(board, monkeypatch):
    prop = views.propose(CORPUS, **ARGS, proposed_by="orient", hold=True)
    assert prop["held"] and prop["status"] == "queued"
    assert (CORPUS, "posts") in dev._view_queue, "its build is queued while the run goes"
    assert board == [], "nothing is announced for a held proposal"

    _build()
    assert views.read_proposal(CORPUS, "posts")["status"] == "built"
    assert board == [], "nor for its build"
    assert "posts" not in [v["slug"] for v in views.list_views(CORPUS)], "its view is not listed while held"
    assert _listed() == []

    chips: list[dict] = []
    monkeypatch.setattr(agents, "chip", lambda c, kind, text, **k: chips.append({"kind": kind, **k}))
    released = orientation.release_views(CORPUS, "orient-chat")
    assert [p["slug"] for p in released] == ["posts"]
    assert {"type": "view", "slug": "posts", "status": "built"} in board, "a built one appears ready at once"
    assert any(e.get("main") == "view" and e.get("view") == "posts" for e in board), "main hears of the view now"
    assert chips == [{"kind": "view", "ref": "view:posts", "status": "built", "chat": "orient-chat"}]
    assert "posts" in [v["slug"] for v in views.list_views(CORPUS)]
    assert _listed() == ["posts"]


def test_a_held_proposal_still_building_at_release_goes_on(board, monkeypatch):
    views.propose(CORPUS, **ARGS, proposed_by="orient", hold=True)
    views.update_proposal(CORPUS, "posts", status="building")
    monkeypatch.setattr(agents, "chip", lambda *a, **k: None)
    assert [p["status"] for p in views.release_held(CORPUS)] == ["building"]
    assert board == [{"type": "view", "slug": "posts", "status": "building"}]


def test_a_held_proposal_proposed_again_keeps_its_build_unless_revised(board, monkeypatch):
    stopped: list[str] = []
    monkeypatch.setattr(dev, "stop_view", lambda c, slug, why: stopped.append(why) or True)
    first = views.propose(CORPUS, **ARGS, proposed_by="orient", hold=True)
    _build()

    same = views.propose(CORPUS, **ARGS, proposed_by="orient", hold=True)
    assert same["ts"] == first["ts"] and same["status"] == "built" and stopped == [], "unchanged: the build stands"

    revised = views.propose(CORPUS, **{**ARGS, "arrangement": "one thread per page"}, proposed_by="orient", hold=True)
    assert stopped == ["replaced"]
    assert revised["slug"] == "posts" and revised["held"] and revised["status"] == "queued"
    assert not (views.views_dir(CORPUS) / "posts").exists(), "the view built from the old proposal is gone"
    assert views.read_proposal(CORPUS, "posts")["arrangement"] == "one thread per page"
    assert board == [], "still nothing announced"


def test_a_dropped_held_proposal_is_not_released(board, monkeypatch):
    views.propose(CORPUS, **ARGS, proposed_by="orient", hold=True)
    views.drop(CORPUS, "posts", "its checks did not pass")
    assert board == []
    monkeypatch.setattr(agents, "chip", lambda *a, **k: pytest.fail("no chip for a dropped proposal"))
    assert views.release_held(CORPUS) == []
    assert not views.read_proposal(CORPUS, "posts").get("held")


def test_the_critique_reviews_held_proposals_and_an_older_held_row_reads_as_held(board, monkeypatch):
    p = views.proposals_path(CORPUS)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps([{"slug": "posts", **ARGS, "proposed_by": "orient", "status": "held", "ts": "t"}]))
    prop = views.read_proposal(CORPUS, "posts")
    assert prop["status"] == "queued" and prop["held"]
    monkeypatch.setattr(orientation, "read_run", lambda c: {})
    assert any("Posts: one post at a time" in part for part in critique_session.drafts(CORPUS))


def test_a_proposal_not_held_is_announced_and_listed_as_before(board):
    views.propose(CORPUS, **ARGS, proposed_by="analyst")
    assert board == [{"type": "view", "slug": "posts", "status": "queued"}]
    assert _listed() == ["posts"]
    assert Path(views.proposals_path(CORPUS)).is_file()
