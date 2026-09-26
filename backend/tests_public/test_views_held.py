"""An orientation's view proposal (views.propose `orientation`) is held until its view passes its checks: it builds at
once, and the analyst hears of it, in the views bar and in main, as soon as it is built, while the orientation still
runs. A held proposal proposed again unchanged keeps its build; changed it is revised in place, so its build goes on
from its draft or its built view. The view build itself is not run: a proposal's view is written into its folder and
marked built as a build that passed its gate would be. The board is invented."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from app import config, critique_session, dev, investigation, orientation, session, views

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


def _in_bar() -> list[str]:
    return [p["slug"] for p in views.list_proposals(CORPUS) if not p.get("held")]


def test_an_orientation_s_view_builds_unseen_and_appears_as_soon_as_it_is_built(board, monkeypatch):
    monkeypatch.setattr(orientation, "drafting", lambda c: True)
    prop = views.propose(CORPUS, **ARGS, proposed_by="orient", orientation=True)
    assert prop["held"] and prop["orientation"] and prop["status"] == "queued"
    assert (CORPUS, "posts") in dev._view_queue, "its build is queued at once"
    assert board == [], "nothing is announced while it builds"
    assert _in_bar() == []

    _build()
    prop = views.read_proposal(CORPUS, "posts")
    assert prop["status"] == "built" and not prop.get("held"), "built, it is held no longer"
    assert {"type": "view", "slug": "posts", "status": "built"} in board, "it appears while the orientation runs"
    assert "posts" in [v["slug"] for v in views.list_views(CORPUS)]
    assert _in_bar() == ["posts"]


def test_the_proposals_route_lists_a_held_proposal_marked_held(board):
    views.propose(CORPUS, **ARGS, proposed_by="orient", orientation=True)
    from fastapi.testclient import TestClient

    from app.main import app

    with TestClient(app) as client:
        rows = client.get(f"/api/ws/{CORPUS}/views/proposals").json()
    assert [(r["slug"], r.get("held")) for r in rows] == [("posts", True)]


def test_a_held_proposal_proposed_again_keeps_its_build_and_changed_goes_on_from_its_draft(board, monkeypatch):
    stopped: list[str] = []
    monkeypatch.setattr(dev, "stop_view", lambda c, slug, why: stopped.append(why) or True)
    views.propose(CORPUS, **ARGS, proposed_by="orient", orientation=True)
    views.update_proposal(CORPUS, "posts", status="building", session_id="s1")

    same = views.propose(CORPUS, **ARGS, proposed_by="orient", orientation=True)
    assert same["status"] == "building" and stopped == [], "unchanged: the build goes on"

    draft = views.views_dir(CORPUS) / "posts"
    draft.mkdir(parents=True, exist_ok=True)
    (draft / "view.html").write_text("<!doctype html>")
    views.propose(CORPUS, **{**ARGS, "why": "whole threads"}, proposed_by="orient", orientation=True)
    prop = views.read_proposal(CORPUS, "posts")
    assert stopped == ["revised"] and (draft / "view.html").is_file(), "the build stops with its draft kept"
    assert prop["status"] == "queued" and prop["changed"] and prop["held"] and prop["session_id"] == "s1"
    assert prop["why"] == "whole threads" and not prop.get("revision")
    assert board == []


def test_a_built_orientation_view_proposed_again_changed_is_changed_in_place(board, monkeypatch):
    monkeypatch.setattr(dev, "stop_view", lambda c, slug, why: True)
    views.propose(CORPUS, **ARGS, proposed_by="orient", orientation=True)
    _build()
    board.clear()

    changed = views.propose(CORPUS, **{**ARGS, "arrangement": "one thread per page"}, proposed_by="orient",
                            orientation=True)
    assert changed["slug"] == "posts" and changed["revised"] and changed["revision"] and not changed.get("held")
    assert (views.views_dir(CORPUS) / "posts" / "reader.py").is_file(), "the view the analyst sees stays"
    assert views._revision_dir(CORPUS, "posts").is_dir(), "with a copy to go back to"
    assert "posts" in [v["slug"] for v in views.list_views(CORPUS)]
    assert [(e["slug"], e["status"]) for e in board] == [("posts", "queued")]


def test_a_dropped_held_proposal_never_appears(board):
    views.propose(CORPUS, **ARGS, proposed_by="orient", orientation=True)
    views.drop(CORPUS, "posts", "its checks did not pass")
    assert board == [] and _in_bar() == []


def test_the_critique_reviews_every_view_the_orientation_proposed_and_an_older_held_row_reads_as_held(board,
                                                                                                    monkeypatch):
    p = views.proposals_path(CORPUS)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps([{"slug": "posts", **ARGS, "proposed_by": "orient", "status": "held", "ts": "t"},
                             {"slug": "later", **ARGS, "name": "Later", "proposed_by": "orient", "orientation": True,
                              "status": "built", "ts": "t"},
                             {"slug": "asked", **ARGS, "name": "Asked", "proposed_by": "terminal", "asked": True,
                              "status": "built", "ts": "t"}]))
    prop = views.read_proposal(CORPUS, "posts")
    assert prop["status"] == "queued" and prop["held"]
    monkeypatch.setattr(orientation, "read_run", lambda c: {})
    text = "\n".join(critique_session.drafts(CORPUS))
    assert "Posts: one post at a time" in text and "Later: one post at a time" in text and "Asked:" not in text


def test_a_file_type_viewer_the_orientation_suggests_is_offered_at_once(board):
    prop = views.propose(CORPUS, "Captions", "a call's captions", ["board.jsonl"], "one cue a row",
                         proposed_by="orient", orientation=True, suggested=True)
    assert prop["status"] == "suggested" and not prop.get("held")
    assert board == [{"type": "view", "slug": "captions", "status": "suggested"}]


def test_a_proposal_the_analyst_asked_for_is_announced_and_listed_at_once(board):
    views.propose(CORPUS, **ARGS, proposed_by="analyst", asked=True)
    assert board == [{"type": "view", "slug": "posts", "status": "queued"}]
    assert _in_bar() == ["posts"]
    assert Path(views.proposals_path(CORPUS)).is_file()


def test_an_orientation_proposes_at_most_three_views_and_improves_one_under_its_name(board, monkeypatch):
    from fastapi import HTTPException

    monkeypatch.setattr(dev, "stop_view", lambda c, slug, why: True)
    for name in ("Posts", "Threads", "Replies"):
        views.propose(CORPUS, **{**ARGS, "name": name}, proposed_by="orient", orientation=True)
    with pytest.raises(HTTPException) as e:
        views.propose(CORPUS, **{**ARGS, "name": "Codebook"}, proposed_by="orient", orientation=True)
    assert e.value.status_code == 409
    assert e.value.detail == ("Codebook was not proposed: an orientation proposes at most 3 views, and yours are Posts, "
                              "Threads, Replies. To improve one, propose it again under its name.")
    assert [p["slug"] for p in views.list_proposals(CORPUS)] == ["posts", "threads", "replies"]

    better = views.propose(CORPUS, **{**ARGS, "name": "threads", "why": "each thread whole"}, proposed_by="orient",
                           orientation=True)
    assert better["slug"] == "threads" and views.read_proposal(CORPUS, "threads")["why"] == "each thread whole"

    views.propose(CORPUS, "Captions", "a call's captions", ["board.jsonl"], "one cue a row", proposed_by="orient",
                  orientation=True, suggested=True)
    views.propose(CORPUS, **{**ARGS, "name": "Asked"}, proposed_by="analyst", asked=True)
    views.drop(CORPUS, "replies", "its checks did not pass")
    views.propose(CORPUS, **{**ARGS, "name": "Codebook"}, proposed_by="orient", orientation=True)
    assert [p["name"] for p in views.orientation_views(CORPUS)] == ["Posts", "Threads", "Codebook"]


async def test_the_tool_tells_the_orientation_it_has_proposed_three_views(board, monkeypatch):
    from app import tools

    monkeypatch.setattr(views, "_queue", lambda c, slug: None)
    fields = {"unit": "one post", "overview": "every post", "zoom": "a thread", "filter": "labels", "details": "a post"}
    for name in ("Posts", "Threads", "Replies"):
        res = await tools.call(CORPUS, "propose_view", {**ARGS, **fields, "name": name}, session=tools.ORIENT_SESSION)
        assert not res.is_error
    res = await tools.call(CORPUS, "propose_view", {**ARGS, **fields, "name": "Codebook"}, session=tools.ORIENT_SESSION)
    assert res.is_error and "at most 3 views" in res.text and "propose it again under its name" in res.text
