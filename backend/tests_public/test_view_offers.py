"""View proposals (app/views.py, `offer` in the code): a view thimble proposes to the analyst after a turn (proposer.py)
or for a file type opened in the File browser (views.suggest), stored as a `suggested` proposal row with `offered`,
which builds only when the analyst accepts it. One waits at a time, until the analyst answers it: Accept builds it,
Reject drops it, each with its answer stamped. A file type's check that fails is a notice with a fix. Try again on
a notice checks that file type again, else asks the proposer to check now (propose-now). proposer.json keeps the
proposer's pending job. Main sees the waiting view proposal as thimble's.
"""
from __future__ import annotations

import json
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app import config, context, events, ledger, views

CORPUS = "offers"


@pytest.fixture()
def corpus(tmp_path, monkeypatch, workspaces_tmp) -> SimpleNamespace:
    """A corpus of a board and a trace file, where views can be built (build_problem), a session listens (reachable)
    and no build or click starts anything (_queue, click_refused). The `view` events go to the list the fixture returns,
    as (slug, status, extra)."""
    d = tmp_path / "data" / CORPUS
    d.mkdir(parents=True)
    (d / "manifest.json").write_text(json.dumps({"name": CORPUS}))
    (d / "board.jsonl").write_text(json.dumps({"body": "first post"}) + "\n")
    (d / "run.trace").write_text("t=0 start\nt=1 step\n")
    monkeypatch.setattr(config, "DATA_DIR", d.parent.resolve())
    monkeypatch.setattr(views, "build_problem", lambda: "")
    monkeypatch.setattr(views, "_queue", lambda c, slug: queued.append(slug))
    monkeypatch.setattr(views, "click_refused", lambda c, slug: None)
    monkeypatch.setattr(events, "reachable", lambda c: True)
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


def _legacy_trace() -> dict:
    """A 0.7.x orientation's viewer for a file type as it stored it: a `suggested` row without `offered`, never queued."""
    with views._proposals_lock:
        row = {"slug": views._unique_slug(CORPUS, "Old Trace"), "name": "Old Trace", "description": "A trace viewer.",
               "task": "", "claims": ["**/*.trace"], "arrangement": "One row per step.", "proposed_by": "files",
               "status": "suggested", "ts": views._now(), "route": views.CLICK}
        views._save_proposals(CORPUS, [*views.list_proposals(CORPUS), row])
    return row


def test_a_view_proposal_is_stored_announced_and_never_queued(corpus):
    row, why = _offer()
    assert why == "" and row is not None
    stored = _row(row["slug"])
    assert stored["status"] == "suggested" and stored["proposed_by"] == "proposer" and stored["route"] == views.CLICK
    assert stored["offered"] == {"at": stored["ts"], "after": "main", "why": "The analyst compares the agents."}
    assert (stored["name"], stored["task"], stored["claims"]) == ("Posts", "Compare who posts what.", ["board.jsonl"])
    assert corpus.sent == [(row["slug"], "suggested", {})] and corpus.queued == []
    assert views.open_offer(CORPUS)["slug"] == row["slug"]
    assert [p["slug"] for p in views.offers(CORPUS)] == [row["slug"]]


def test_accept_stamps_the_answer_and_queues_the_build_as_one_the_analyst_asked_for(corpus):
    row, _ = _offer()
    got = views.accept(CORPUS, row["slug"])
    assert (got["status"], got["asked"], got["accepted"], got["answer"]) == ("queued", True, True, "accepted")
    assert got["answered_at"] and got["offered"] == row["offered"]
    assert corpus.sent[-1] == (row["slug"], "queued", {"asked": True}) and corpus.queued == [row["slug"]]
    assert views.open_offer(CORPUS) is None
    with pytest.raises(HTTPException) as e:
        views.accept(CORPUS, row["slug"])
    assert e.value.status_code == 409
    assert e.value.detail == "the view proposal 'Posts' is no longer waiting for an answer", "the card's toast"


async def test_reject_is_the_analyst_s_click_and_drops_the_view_proposal_with_its_answer(corpus, analyst):
    from starlette.requests import Request

    row, _ = _offer()
    with pytest.raises(HTTPException) as e:
        await views.reject_route(CORPUS, row["slug"], Request({"type": "http", "headers": []}))
    assert e.value.status_code == 403 and _row(row["slug"])["status"] == "suggested"
    with pytest.raises(ValueError):
        views.answer_offer(CORPUS, row["slug"], "ignored")
    assert _row(row["slug"])["status"] == "suggested", "it waits until the analyst answers it"
    got = await views.reject_route(CORPUS, row["slug"], analyst)
    assert (got["status"], got["answer"]) == ("dropped", "rejected") and got["answered_at"]
    assert corpus.sent[-1] == (row["slug"], "dropped", {})
    assert views.suggestions(CORPUS) == {}, "a rejected proposer offer leaves the file types alone"
    with pytest.raises(HTTPException) as e:
        await views.reject_route(CORPUS, row["slug"], analyst)
    assert e.value.status_code == 409, "no longer waiting for an answer"
    assert "view proposal" in e.value.detail and "offer" not in e.value.detail.replace("view proposal", "")
    with pytest.raises(HTTPException) as e:
        await views.reject_route(CORPUS, "nothing", analyst)
    assert e.value.status_code == 404
    built = views.propose(CORPUS, "Threads", "The threads.", ["board.jsonl"])
    with pytest.raises(HTTPException) as e:
        await views.reject_route(CORPUS, built["slug"], analyst)
    assert e.value.status_code == 409, "main's proposal, which no card shows"
    legacy = _legacy_trace()
    with pytest.raises(HTTPException) as e:
        await views.reject_route(CORPUS, legacy["slug"], analyst)
    assert e.value.status_code == 409, "a 0.7.x suggested row without `offered`"


def test_a_0_7_suggested_row_is_never_the_waiting_view_proposal_and_blocks_none(corpus):
    legacy = _legacy_trace()
    assert legacy["status"] == "suggested" and "offered" not in legacy
    assert views.open_offer(CORPUS) is None and views.offers(CORPUS) == []
    row, why = _offer()
    assert why == "" and views.open_offer(CORPUS)["slug"] == row["slug"]
    views.answer_offer(CORPUS, row["slug"])
    assert _row(legacy["slug"])["status"] == "suggested" and "answer" not in _row(legacy["slug"])
    assert [(p["slug"], p["answer"]) for p in views.offers(CORPUS)] == [(row["slug"], "rejected")], \
        "answered view proposals stay listed, so the proposer sees the rejected ones"


def test_don_t_ask_again_turns_view_proposals_off_through_the_settings_put_and_settings_back_on(corpus, analyst):
    """The card's Don't ask again is the settings PUT of `propose_views: false`; Settings' switch turns them back on.
    The waiting view proposal only hides meanwhile."""
    row, _ = _offer()
    assert ledger.put_settings_route(CORPUS, analyst, {"propose_views": False})["propose_views"] is False
    assert not views.propose_enabled(CORPUS) and "Posts" not in context.views(CORPUS)
    assert _row(row["slug"])["status"] == "suggested"
    assert ledger.put_settings_route(CORPUS, analyst, {"propose_views": True})["propose_views"] is True
    assert views.propose_enabled(CORPUS) and views.open_offer(CORPUS)["slug"] == row["slug"]
    assert "thimble's view proposal" in context.views(CORPUS)


def _fake_notices(monkeypatch) -> list[tuple]:
    """notices.post and notices.clear recorded: each post as ("post", c, its keywords), each clear as ("clear", c,
    key)."""
    from app import notices

    told: list[tuple] = []
    monkeypatch.setattr(notices, "post", lambda c, **kw: told.append(("post", c, kw)))
    monkeypatch.setattr(notices, "clear", lambda c, key, **kw: told.append(("clear", c, key)))
    return told


def _calls_answering(monkeypatch, results: list) -> list[str]:
    """tasks.call answering the file-viewer call with each of `results` in turn: a CallResult, or an exception raised."""
    from app import tasks

    calls: list[str] = []

    async def call(c, task, inp, schema=None):
        calls.append(inp["suffix"])
        got = results.pop(0)
        if isinstance(got, BaseException):
            raise got
        return got

    monkeypatch.setattr(tasks, "call", call)
    return calls


@pytest.mark.parametrize(("result", "reason", "turn_off"), [
    ({"status": "refused", "detail": "the model refused the request (stop_reason refusal)"},
     "Claude's safeguards blocked the request.", True),
    ({"status": "error", "detail": "the model call failed (authentication_failed)"},
     "Claude Code isn't signed in. In your terminal: run /login (or `claude auth login` in a shell).", False),
])
async def test_a_file_type_check_s_notice_says_why_it_failed_and_how_to_fix_it(corpus, monkeypatch, result, reason,
                                                                               turn_off):
    from app import model

    told = _fake_notices(monkeypatch)
    monkeypatch.setattr(views, "_suggest_failed", {})
    _calls_answering(monkeypatch, [model.CallResult(**result)])
    assert await views.suggest(CORPUS, "run.trace") is None
    [(_, _, kw)] = told
    assert kw["text"] == f"Couldn't check for a view proposal for .trace files: {reason}"
    buttons = kw["action"] if isinstance(kw["action"], list) else [kw["action"]]
    assert [b["do"] for b in buttons] == ["proposals-retry", *(["proposals-off"] if turn_off else [])]
    assert views._suggest_failed == {CORPUS: "run.trace"}
