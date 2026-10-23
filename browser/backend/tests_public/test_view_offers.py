"""View proposals (app/views.py, `offer` in the code): a view thimble proposes to the analyst after a turn (proposer.py)
or for a file type opened in the File browser (views.suggest), stored as a `suggested` proposal row with `offered`,
which builds only when the analyst accepts it. One waits at a time, until the analyst answers it: Accept builds it,
Reject drops it, each with its answer stamped. A file type's check that fails is a notice with a fix. Try again on
a notice checks that file type again, else asks the proposer to check now (propose-now). proposer.json keeps the
proposer's pending job. Main sees the waiting view proposal as thimble's.
"""
from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app import config, context, events, ledger, userconf, views

CORPUS = "offers"
CLICK_REFUSED = views.click_refused  # the real one, which the corpus fixture replaces
READER = '''
def build_index(paths):
    return {}


def records(index, query):
    return []


def resolve(index, locator):
    return None
'''


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


def _file_offer(name: str = "Trace Steps") -> tuple[dict | None, str]:
    return views.offer(CORPUS, name=name, description="Each step of a trace.", task="", claims=["**/*.trace"],
                       after="file", why="Traces read as steps.", proposed_by="files", arrangement="One row per step.")


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


def _build(slug: str, name: str = "Posts") -> dict:
    return views.write_view(CORPUS, slug, name=name, description="The posts.", claims=["board.jsonl"], reader=READER,
                            html="<p>posts</p>")


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


def test_a_view_proposal_is_refused_while_another_waits_or_when_its_name_files_or_build_cannot_be(corpus, monkeypatch):
    first, _ = _offer()
    assert _offer("Threads") == (None, views.OFFER_OPEN), "one view proposal waits at a time"
    views.answer_offer(CORPUS, first["slug"], "rejected")
    corpus.sent.clear()
    for name in ("posts", "POSTS"):
        row, why = _offer(name)
        assert row is None and "taken" in why, "a row's name, answered offers included"
    _build("threads", "Threads")
    assert "taken" in _offer("threads")[1], "a built view's name"
    views._keep_deleted(CORPUS, {"slug": "replies", "name": "Replies"})
    assert "taken" in _offer("Replies")[1], "a deleted proposal's name"
    row, why = _offer("Notes", claims=["notes/*.md"])
    assert row is None and "notes/*.md" in why, "a claim that matches no file"
    assert _offer("Notes", task="")[1] == "the view proposal has no task"
    assert _offer("Notes", after="somewhere")[0] is None
    assert views.offer(CORPUS, name="Trace", description="Steps.", task="", claims=["**/*.trace"], after="file",
                       why="", proposed_by="files")[1] == "the view proposal has no arrangement"
    monkeypatch.setattr(views, "build_problem", lambda: "Custom views need Node 20+, and this machine has no Node.")
    assert _offer("Notes") == (None, "Custom views need Node 20+, and this machine has no Node.")
    assert not [e for e in corpus.sent if e[1] == "suggested"] and views.open_offer(CORPUS) is None
    assert {p["name"] for p in views.list_proposals(CORPUS)} == {"Posts"}, "a refused offer writes nothing"


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


def test_an_accept_that_cannot_start_a_builder_comes_back_refused_and_the_view_proposal_still_waits(corpus,
                                                                                                    monkeypatch):
    """Accept refused at once (no hooks module, main not started by `thimble`): the card shows the reason and its fix
    under its buttons (`refused.reason`), and the view proposal waits for the analyst's next answer."""
    from app import subagents

    reason = "Claude Code's hooks modules are off in this session: turn them on, then Accept."
    monkeypatch.setattr(views, "click_refused", CLICK_REFUSED)
    monkeypatch.setattr(subagents, "refusal_before", lambda c, click=False: subagents.refusal("no-module", reason))
    row, _ = _offer()
    got = views.accept(CORPUS, row["slug"])
    assert got["status"] == "suggested" and got["refused"]["reason"] == reason and "answer" not in got
    assert corpus.queued == [] and views.open_offer(CORPUS)["slug"] == row["slug"]
    monkeypatch.setattr(subagents, "refusal_before", lambda c, click=False: None)
    got = views.accept(CORPUS, row["slug"])
    assert (got["status"], got["answer"], got.get("refused")) == ("queued", "accepted", None)


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


async def test_a_rejected_file_type_proposal_dismisses_its_file_type(corpus, analyst):
    row, why = _file_offer()
    assert why == "" and row["proposed_by"] == "files" and row["offered"]["after"] == "file"
    await views.reject_route(CORPUS, row["slug"], analyst)
    assert views.suggestions(CORPUS)[".trace"]["answer"] == "dismissed"
    assert views.suggestion_for(CORPUS, "run.trace")["eligible"] is False


@pytest.mark.real_write_guard
def test_the_reject_route_refuses_the_server_s_token_without_the_analyst_s_cookie(corpus, plugin_headers):
    from app import main

    row, _ = _offer()
    client = TestClient(main.create_app())
    r = client.post(f"/api/ws/{CORPUS}/views/proposals/{row['slug']}/reject", headers=plugin_headers())
    assert r.status_code == 403, r.text
    assert _row(row["slug"])["status"] == "suggested"


def test_the_first_build_of_an_accepted_view_proposal_says_accepted_and_no_later_one_does(corpus):
    row, _ = _offer()
    views.accept(CORPUS, row["slug"])
    corpus.sent.clear()
    _build(row["slug"])
    assert corpus.sent[-1][:2] == (row["slug"], "built")
    assert corpus.sent[-1][2].get("accepted") is True and "asked" not in corpus.sent[-1][2], "marked new, not opened"
    _build(row["slug"])
    assert "accepted" not in corpus.sent[-1][2], "a build after the first"
    views.revise(CORPUS, row["slug"], "a legend", route=views.TYPED)
    _build(row["slug"])
    assert "accepted" not in corpus.sent[-1][2], "a change to the view"
    asked = views.propose(CORPUS, "Threads", "The threads.", ["board.jsonl"], asked=True)
    _build(asked["slug"], "Threads")
    assert corpus.sent[-1][2] == {"asked": True, "version": corpus.sent[-1][2]["version"]}, "a view main proposed"


def test_proposer_json_keeps_the_proposer_s_pending_job(corpus):
    assert views.proposer_state(CORPUS) == {"job": None}
    job = {"after": ["main"], "sid": "s1", "cut": "u1"}
    path = views.state_dir(CORPUS) / views.PROPOSER_FILE
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"job": job}))
    assert views.proposer_state(CORPUS) == {"job": job}, "a job one process wrote (proposer.py) is the next one's"
    path.write_text(json.dumps({"job": None}))
    assert views.proposer_state(CORPUS) == {"job": None}
    path.write_text("{broken")
    assert views.proposer_state(CORPUS) == {"job": None}
    path.write_text(json.dumps({"job": "x"}))
    assert views.proposer_state(CORPUS) == {"job": None}


def test_main_s_proposal_under_a_waiting_view_proposal_s_name_replaces_it_and_builds(corpus):
    row, _ = _offer()
    got = views.propose(CORPUS, "posts", "The board's posts by agent.", ["board.jsonl"], task="Compare the agents.",
                        asked=True, route=views.TYPED)
    assert got["slug"] == row["slug"] and got["status"] == "queued" and got["asked"] is True
    assert "offered" not in got and views.open_offer(CORPUS) is None
    assert [p["slug"] for p in views.list_proposals(CORPUS)] == [row["slug"]]
    row2, _ = _offer("Threads")
    views.propose(CORPUS, "Threads", "The threads.", ["board.jsonl"])
    assert corpus.queued == [row2["slug"]], "a click's proposal queues its build at once"


def _viewer_call(answer: dict, calls: list):
    async def call(c, task, inp, schema=None):
        calls.append(inp["suffix"])
        return SimpleNamespace(status="ok", output=answer)

    return call


async def test_the_file_type_proposal_makes_no_call_while_view_proposals_are_off_or_one_waits(corpus, monkeypatch):
    from app import tasks

    calls: list[str] = []
    answer = {"help": True, "name": "trace steps", "why": "Traces read as steps.", "arrangement": "One row per step."}
    monkeypatch.setattr(tasks, "call", _viewer_call(answer, calls))
    monkeypatch.setenv(views.PROPOSE_ENV, "off")
    assert await views.suggest(CORPUS, "run.trace") is None and calls == []
    monkeypatch.delenv(views.PROPOSE_ENV)
    userconf.save(None, {"views": {"propose": False}})
    assert not views.propose_enabled(CORPUS)
    assert await views.suggest(CORPUS, "run.trace") is None and calls == []
    userconf.save(None, {"views": {"propose": None}})
    row, _ = _offer()
    assert await views.suggest(CORPUS, "run.trace") is None and calls == []
    assert views.suggestions(CORPUS) == {}, "no answer is kept for the file type, so it is asked again"
    views.answer_offer(CORPUS, row["slug"], "rejected")
    slug = await views.suggest(CORPUS, "run.trace")
    assert calls == [".trace"] and slug is not None
    got = _row(slug)
    assert (got["name"], got["status"], got["proposed_by"], got["claims"]) == ("Trace Steps", "suggested", "files",
                                                                              ["**/*.trace"])
    assert got["offered"]["after"] == "file" and got["arrangement"] == "One row per step." and got["task"] == ""
    assert views.suggestions(CORPUS)[".trace"] == {"answer": "suggested", "slug": slug,
                                                   "ts": views.suggestions(CORPUS)[".trace"]["ts"]}
    assert views.open_offer(CORPUS)["slug"] == slug and corpus.queued == []


async def test_a_file_type_proposal_that_cannot_be_written_keeps_no_answer(corpus, monkeypatch):
    from app import tasks

    calls: list[str] = []
    answer = {"help": True, "name": "Posts", "why": "Traces read as steps.", "arrangement": "One row per step."}
    monkeypatch.setattr(tasks, "call", _viewer_call(answer, calls))
    views.answer_offer(CORPUS, _offer()[0]["slug"], "rejected")
    assert await views.suggest(CORPUS, "run.trace") is None and calls == [".trace"]
    assert views.suggestions(CORPUS) == {} and views.open_offer(CORPUS) is None, "the name was taken"


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


def test_view_proposals_are_on_unless_the_environment_or_the_config_turns_them_off(corpus, monkeypatch):
    assert views.propose_enabled(CORPUS) and userconf.propose_views(CORPUS)
    for off in ("off", "OFF", "0", "false"):
        monkeypatch.setenv(views.PROPOSE_ENV, off)
        assert not views.propose_enabled(CORPUS), off
    monkeypatch.setenv(views.PROPOSE_ENV, "on")
    assert views.propose_enabled(CORPUS)
    path = userconf.workspace_file(CORPUS)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"views": {"propose": False}}))
    assert not views.propose_enabled(CORPUS) and not ledger.get_settings(CORPUS)["propose_views"]


def _fake_proposer(monkeypatch, run_now):
    """proposer.run_now, which the propose-now route calls, replaced by `run_now`."""
    from app import proposer

    monkeypatch.setattr(proposer, "run_now", run_now)


async def test_try_again_asks_the_proposer_to_check_now_and_only_the_analyst_s_click_does(corpus, analyst, monkeypatch):
    from starlette.requests import Request

    asked: list[str] = []
    _fake_proposer(monkeypatch, lambda c: asked.append(c) or {"started": True})
    with pytest.raises(HTTPException) as e:
        await views.propose_now_route(CORPUS, Request({"type": "http", "headers": []}))
    assert e.value.status_code == 403 and asked == []
    assert await views.propose_now_route(CORPUS, analyst) == {"started": True} and asked == [CORPUS]
    _fake_proposer(monkeypatch, lambda c: asked.append(c) or {"queued": True})
    assert await views.propose_now_route(CORPUS, analyst) == {"queued": True} and asked == [CORPUS, CORPUS]
    assert "propose-now" in views.RESERVED_SLUGS, "no view takes the route's name"


@pytest.mark.real_write_guard
def test_the_propose_now_route_refuses_the_server_s_token_without_the_analyst_s_cookie(corpus, plugin_headers,
                                                                                         monkeypatch):
    from app import main

    asked: list[str] = []
    _fake_proposer(monkeypatch, lambda c: asked.append(c) or {"started": True})
    client = TestClient(main.create_app())
    r = client.post(f"/api/ws/{CORPUS}/views/propose-now", headers=plugin_headers())
    assert r.status_code == 403, r.text
    assert asked == []


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


async def test_a_file_type_check_that_fails_is_a_notice_and_try_again_checks_that_type_again(corpus, analyst,
                                                                                              monkeypatch):
    from app import model

    told = _fake_notices(monkeypatch)
    monkeypatch.setattr(views, "_suggest_failed", {})
    asked: list[str] = []
    _fake_proposer(monkeypatch, lambda c: asked.append(c) or {"started": True})
    answer = {"help": True, "name": "trace steps", "why": "Traces read as steps.", "arrangement": "One row per step."}
    calls = _calls_answering(monkeypatch, [
        model.CallResult(status="error", detail="the session reported an error (HTTP 529): Overloaded."),
        model.CallResult(status="ok", output=answer)])
    assert await views.suggest(CORPUS, "run.trace") is None and calls == [".trace"]
    assert told == [("post", CORPUS, {"kind": "proposals", "key": views.SUGGEST_NOTICE_KEY, "agent": "View proposals",
                                      "action": {"label": "Try again", "do": "proposals-retry"},
                                      "text": "Couldn't check for a view proposal for .trace files: the session "
                                              "reported an error (HTTP 529): Overloaded."})]
    assert views.suggestions(CORPUS) == {} and views.open_offer(CORPUS) is None, "nothing cached: it asks again"
    told.clear()
    assert await views.propose_now_route(CORPUS, analyst) == {"started": True}
    await asyncio.gather(*views._suggest_tasks)
    assert asked == [], "Try again checked the file type, not main's turn"
    assert calls == [".trace", ".trace"] and views.open_offer(CORPUS)["name"] == "Trace Steps"
    assert ("clear", CORPUS, views.SUGGEST_NOTICE_KEY) in told and not [t for t in told if t[0] == "post"]
    assert await views.propose_now_route(CORPUS, analyst) == {"started": True} and asked == [CORPUS], \
        "with no file type's check failed, Try again is the proposer's"


async def test_try_again_on_the_proposer_s_notice_runs_the_proposer_while_a_file_type_s_failure_is_kept(corpus,
                                                                                                     analyst,
                                                                                                     monkeypatch):
    """Both notices offer Try again: each runs the check whose notice it is, by the notice's key."""
    _fake_notices(monkeypatch)
    monkeypatch.setattr(views, "_suggest_failed", {CORPUS: "run.trace"})
    asked: list[str] = []
    _fake_proposer(monkeypatch, lambda c: asked.append(c) or {"started": True})
    again: list[str] = []

    async def suggest_again(c: str, rel: str) -> None:
        again.append(rel)

    monkeypatch.setattr(views, "_suggest_again", suggest_again)
    proposer_notice = views.ProposeNowBody(key="proposals")
    assert await views.propose_now_route(CORPUS, analyst, proposer_notice) == {"started": True}
    assert asked == [CORPUS] and views._suggest_failed == {CORPUS: "run.trace"}, "the file type's failure is kept"
    file_notice = views.ProposeNowBody(key=views.SUGGEST_NOTICE_KEY)
    assert await views.propose_now_route(CORPUS, analyst, file_notice) == {"started": True}
    await asyncio.gather(*views._suggest_tasks)
    assert again == ["run.trace"] and asked == [CORPUS]


@pytest.mark.parametrize(("result", "reason", "turn_off"), [
    ({"status": "refused", "detail": "the model refused the request (stop_reason refusal)"},
     "Claude's safeguards blocked the request.", True),
    ({"status": "error", "detail": "the session reported an error: API Error: Claude's safeguards flagged this message"},
     "Claude's safeguards blocked the request.", True),
    ({"status": "error", "detail": "the model call failed (authentication_failed)"},
     "Claude Code isn't signed in. In your terminal: run /login (or `claude auth login` in a shell).", False),
    ({"status": "error", "detail": "the model call failed: API Error: 403 permission_error"},
     "access was refused for this account or organization (403). In your terminal: run /login to check the account, "
     "or check your organization's settings.", False),
    ({"status": "no_tool_call", "detail": "the file_viewer tool was never called"},
     "Claude's answer couldn't be read.", False),
    ({"status": "rate_limited", "detail": "the subscription's rate limit is exhausted"},
     "the subscription's rate limit is exhausted.", False),
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


async def test_a_file_type_check_that_times_out_or_raises_is_told_too(corpus, monkeypatch):
    told = _fake_notices(monkeypatch)
    monkeypatch.setattr(views, "_suggest_failed", {})
    monkeypatch.setattr(views, "SUGGEST_TIMEOUT_S", 0.05)
    from app import tasks

    async def slow(c, task, inp, schema=None):
        await asyncio.sleep(5)

    monkeypatch.setattr(tasks, "call", slow)
    assert await views.suggest(CORPUS, "run.trace") is None
    assert told[-1][2]["text"].startswith("Couldn't check for a view proposal for .trace files: Claude didn't answer")
    _calls_answering(monkeypatch, [RuntimeError("the claude CLI was not found " + "x" * 300)])
    assert await views.suggest(CORPUS, "run.trace") is None
    text = told[-1][2]["text"]
    assert "the claude CLI was not found" in text and text.endswith("….") and len(text) < 240, "a long reason is cut"


async def test_a_view_proposal_from_the_refusal_row_s_model_says_so(corpus, monkeypatch):
    from app import model

    told = _fake_notices(monkeypatch)
    answer = {"help": True, "name": "trace steps", "why": "Traces read as steps.", "arrangement": "One row per step."}
    _calls_answering(monkeypatch, [model.CallResult(status="ok", output=answer, refused_by="claude-opus-5-5",
                                                    model_used="claude-opus-4-8", model_requested="claude-opus-4-8")])
    slug = await views.suggest(CORPUS, "run.trace")
    assert slug is not None and views.open_offer(CORPUS)["slug"] == slug, "the card shows"
    assert told == [("post", CORPUS, {"kind": "proposals", "key": views.SUGGEST_NOTICE_KEY, "action": None,
                                      "agent": "View proposals",
                                      "text": "This view proposal came from Opus 4.8: Claude's safeguards switched "
                                              "models."})]
