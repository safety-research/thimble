"""View proposals (app/views.py, `offer` in the code): a view thimble proposes to the analyst after a turn (proposer.py)
is stored as a `suggested` proposal row with `offered`, which builds only when the analyst accepts it: Accept queues
its build as one the analyst asked for.
"""
from __future__ import annotations

import json
from types import SimpleNamespace

import pytest

from app import config, views

CORPUS = "offers"


@pytest.fixture()
def corpus(tmp_path, monkeypatch, workspaces_tmp) -> SimpleNamespace:
    """A corpus of a board and a trace file, where views can be built (build_problem) and no build starts anything
    (_queue). The `view` events go to the list the fixture returns, as (slug, status, extra)."""
    d = tmp_path / "data" / CORPUS
    d.mkdir(parents=True)
    (d / "manifest.json").write_text(json.dumps({"name": CORPUS}))
    (d / "board.jsonl").write_text(json.dumps({"body": "first post"}) + "\n")
    (d / "run.trace").write_text("t=0 start\nt=1 step\n")
    monkeypatch.setattr(config, "DATA_DIR", d.parent.resolve())
    monkeypatch.setattr(views, "build_problem", lambda: "")
    monkeypatch.setattr(views, "_queue", lambda c, slug: queued.append(slug))
    monkeypatch.delenv(views.PROPOSE_ENV, raising=False)
    queued: list[str] = []
    sent: list[tuple[str, str, dict]] = []
    monkeypatch.setattr(views, "_emit", lambda c, slug, status, **extra: sent.append((slug, status, extra)))
    return SimpleNamespace(dir=d, sent=sent, queued=queued)


def _offer(name: str = "Posts", **kw) -> tuple[dict | None, str]:
    args = {"name": name, "description": "Each post of the board.", "task": "Compare who posts what.",
            "claims": ["board.jsonl"], "after": "main", "why": "The analyst compares the agents.", **kw}
    return views.offer(CORPUS, **args)


def _row(slug: str) -> dict:
    return views.read_proposal(CORPUS, slug) or {}


def test_a_view_proposal_waits_for_the_analyst_and_accept_queues_its_build(corpus):
    row, why = _offer()
    assert why == "" and row is not None
    stored = _row(row["slug"])
    assert stored["status"] == "suggested" and stored["proposed_by"] == "proposer" and stored["route"] == views.CLICK
    assert (stored["name"], stored["task"], stored["claims"]) == ("Posts", "Compare who posts what.", ["board.jsonl"])
    assert corpus.sent == [(row["slug"], "suggested", {})] and corpus.queued == [], "it builds only once accepted"
    assert views.open_offer(CORPUS)["slug"] == row["slug"]
    got = views.accept(CORPUS, row["slug"])
    assert (got["status"], got["asked"], got["accepted"], got["answer"]) == ("queued", True, True, "accepted")
    assert corpus.sent[-1] == (row["slug"], "queued", {"asked": True}) and corpus.queued == [row["slug"]]
    assert views.open_offer(CORPUS) is None
