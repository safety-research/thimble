"""Every failure of thimble's agents reaches the analyst where they are looking (notices.py): a start that did not
happen and a run that ended failed (subagents.py), a view whose build failed (dev.py), a report check that failed
(checks.py), a card check that failed by itself (card_check.py) and a label run that failed (concepts.py). Each is one
open notice under the agent's key, with its fix and, for an agent with a chat, Open on that chat; a later start or
success clears it. The module is the fake bridge (subagent_fakes)."""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from app import agents, card_check, checks, concepts, config, dev, notices, subagents, views
from app import model as model_mod
from subagent_fakes import bridge  # noqa: F401 — a fixture

CORPUS = "mini"
BLOCK = "API Error: Opus 5.5's safeguards flagged this message (https://www.anthropic.com/legal/aup)."
SAFEGUARDS = "Claude's safeguards stopped its request; rephrase or narrow the request and try again"


@pytest.fixture(autouse=True)
def _fresh(workspaces_tmp, monkeypatch):
    rows = {r: {"model": "claude-opus-5-5", "effort": "high", "fast": False}
            for r in ("orient", "subagents", "critic", "writer", "checks", "dev", "labels", "verify")}
    real = config.models_for
    monkeypatch.setattr(config, "models_for", lambda c=None: {**real(c), **{k: dict(v) for k, v in rows.items()}})
    yield


def _open(key: str, c: str = CORPUS) -> dict | None:
    return next((n for n in notices.open_notices(c) if n.get("key") == key), None)


async def _until(cond, what: str, tries: int = 300) -> None:
    for _ in range(tries):
        if cond():
            return
        await asyncio.sleep(0.01)
    raise AssertionError(what)


# --------------------------------------------------------------------------- subagents.py


async def test_a_start_that_did_not_happen_is_told_and_the_next_start_clears_it(bridge):
    bridge.answers.append({"error": "something else"})
    ans = await subagents.start_job(CORPUS, "writer", "writer:report", "w", {}, subagents.CLICK,
                                    chat={"title": "Write report", "doc": "report"})
    assert ans.refused
    n = _open("agent:writer:report")
    assert n["text"] == "The writer of report didn't start: something else." and n["agent"] == "Writer: report"
    assert n["chat"] is None and n["kind"] == "agent"
    ans = await subagents.start_job(CORPUS, "writer", "writer:report", "w", {}, subagents.CLICK,
                                    chat={"title": "Write report", "doc": "report"})
    assert ans.started and _open("agent:writer:report") is None


async def test_a_run_s_api_error_is_told_by_its_record_s_class_and_a_done_run_clears_its_helpers_notice(bridge,
                                                                                                      monkeypatch):
    """Claude Code 2.1.300's 404 line names no status; the mirror's class from the record (model_not_found) gives the
    fix, and the helpers' notice under the agent's id goes when the agent's run ends done."""
    from app import session

    ans = await subagents.start_job(CORPUS, "writer", "writer:report", "w", {}, subagents.CLICK,
                                    chat={"title": "Write report", "doc": "report"})
    line = ("There's an issue with the selected model (claude-opus-9-9). It may not exist or you may not have access to "
            "it. Run /model to pick a different model.")
    monkeypatch.setattr(subagents, "api_error", lambda c, a: line)
    monkeypatch.setattr(session, "agent_error_class", lambda c, a: "not_found")
    subagents.run_ended(CORPUS, ans.agent_id, "done", "", source="module")
    n = _open("agent:writer:report")
    assert n["text"] == ("The writer of report failed: its model isn't available to your account; pick another model "
                         "in Settings.") and n["action"] == notices.SETTINGS
    notices.post(CORPUS, kind="agent", text="A helper of the writer stopped with an error.",
                 key=session.helper_key(ans.agent_id))
    monkeypatch.setattr(subagents, "api_error", lambda c, a: None)
    subagents.run_again(CORPUS, ans.agent_id, "coordinator")
    subagents.run_ended(CORPUS, ans.agent_id, "done", "Written.", source="module")
    assert notices.open_notices(CORPUS) == []


async def test_a_run_that_failed_is_told_with_open_on_its_chat_and_a_new_run_clears_it(bridge):
    ans = await subagents.start_job(CORPUS, "writer", "writer:report", "w", {}, subagents.CLICK,
                                    chat={"title": "Write report", "doc": "report"})
    chat = subagents.agent(CORPUS, ans.agent_id)["chat"]
    subagents.run_ended(CORPUS, ans.agent_id, "failed", BLOCK, source="module")
    n = _open("agent:writer:report")
    assert n["text"] == f"The writer of report failed: {SAFEGUARDS}." and n["chat"] == chat
    rows = [r for r in agents.read_events(agents.paths(CORPUS, chat)[1]) if r["type"] == notices.TYPE]
    assert [r["id"] for r in rows] == [n["id"]], "a row in the writer's own chat"
    subagents.run_again(CORPUS, ans.agent_id, "coordinator")
    assert _open("agent:writer:report") is None
    subagents.run_ended(CORPUS, ans.agent_id, "stopped", "", source="module")
    assert notices.open_notices(CORPUS) == [], "a stop is no failure"


async def test_a_role_that_tells_its_own_failures_is_left_to_it(bridge, monkeypatch):
    """A view's build: its run's status is not its outcome (dev.py tells it), so subagents.py tells nothing."""
    monkeypatch.setattr(dev, "build_refused", lambda c, req: None)
    bridge.answers.append({"error": "something else"})
    await subagents.start_job(CORPUS, "view-builder", "view:board", "b", {}, subagents.CLICK)
    assert notices.open_notices(CORPUS) == []
    assert subagents.TYPES["check"].own_notices and subagents.TYPES["dev-ticket"].own_notices


# --------------------------------------------------------------------------- dev.py: a view's build


@pytest.fixture()
def board(tmp_path, monkeypatch) -> str:
    d = tmp_path / "data"
    corpus = d / "boards"
    corpus.mkdir(parents=True)
    (corpus / "manifest.json").write_text(json.dumps({"name": "boards"}))
    (corpus / "board.jsonl").write_text(json.dumps({"body": "first post"}) + "\n")
    monkeypatch.setattr(config, "DATA_DIR", d.resolve())

    async def gate(c, slug, locators=None, **_kw):
        return {"ok": False, "checks": [], "page": {"ok": False}, "problems": ["problem: the page threw"]}

    monkeypatch.setattr(views, "gate", gate)
    monkeypatch.setattr(views, "gate_lines", lambda rep: list(rep.get("problems") or []))
    monkeypatch.setattr(views, "build_problem", lambda: "")
    return "boards"


async def test_a_view_that_failed_to_build_is_told_with_retry_and_its_next_build_clears_it(board, bridge):
    c = board
    slug = views.propose(c, "Posts", "to read the board", ["board.jsonl"], "one row per post", asked=True)["slug"]
    assert (await dev.start_build(c, slug, subagents.CLICK)).started
    prop = views.read_proposal(c, slug)
    d = views.views_dir(c) / slug
    d.mkdir(parents=True, exist_ok=True)
    (d / views.VIEW_JSON).write_text("{}")
    subagents.run_ended(c, prop["agent_id"], "done", "I could not make it pass.", source="handback")
    await _until(lambda: (views.read_proposal(c, slug) or {}).get("status") == "failed", "it never failed")
    n = _open(f"agent:view:{slug}", c)
    assert n["text"] == "The view Posts failed to build: problem: the page threw."
    assert n["action"] == {"label": "Retry", "do": "view-retry", "slug": slug}
    assert n["agent"] == "View build: Posts" and n["chat"] == prop["chat"]
    await dev.start_build(c, slug, subagents.CLICK)
    await _until(lambda: _open(f"agent:view:{slug}", c) is None, "its next build left the notice")


# --------------------------------------------------------------------------- checks.py


async def test_a_report_check_that_failed_is_told_and_a_run_that_ends_done_clears_it(bridge):
    checks.edit(CORPUS, "judgment", shown=True)
    from app import tools

    r = await tools.call(CORPUS, "write_document", {"doc": "report", "text": "# A\n\nOne account did it.\n"},
                         actor="analyst")
    assert not r.is_error, r.text
    await checks.start_run(CORPUS, "judgment", "report", force=True, route="click")
    act = checks._active[(CORPUS, "judgment", "report")]
    await _until(lambda: act.agent, "the run never started")
    subagents.run_ended(CORPUS, act.agent, "failed", "API Error: Repeated 529 Overloaded errors", source="module")
    key = f"agent:{checks.session_key('judgment', 'report')}"
    n = _open(key)
    assert n["text"] == ("The report check Judgment calls on the document report failed: Anthropic's API is "
                         "overloaded; try again in a few minutes.")
    assert n["agent"] == "Report check: Judgment calls" and n["chat"]
    await checks.start_run(CORPUS, "judgment", "report", force=True, route="click")
    act = checks._active[(CORPUS, "judgment", "report")]
    await _until(lambda: act.agent, "the run never started")
    assert _open(key) is None, "a run that started clears it"


# --------------------------------------------------------------------------- card_check.py


def test_a_card_check_that_failed_by_itself_is_told_and_a_card_s_own_outcome_is_not(monkeypatch):
    from app import checkstore

    monkeypatch.setattr(checkstore, "finish", lambda *a, **kw: True)
    monkeypatch.setattr(card_check, "notebook_cell", lambda c, cid: {"question": "Who replies most?"})
    run = card_check._Run(CORPUS, "c1", "main", "k1")
    card_check._end(run, "error", "the card did not draw: SyntaxError")
    assert notices.open_notices(CORPUS) == []
    card_check._end(run, "error", "the model's reading failed (Not logged in · Please run /login)", tell=True)
    n = _open(card_check.NOTICE_KEY)
    assert n["text"].startswith('The card check of the card "Who replies most?" failed: Claude Code isn\'t signed in '
                                "for thimble's server. In your terminal: run /login")
    assert n["text"].endswith("run `thimble server restart`.") and n["action"] is None
    assert n["agent"] == "Card check" and n["chat"] is None
    card_check._end(run, "ok")
    assert _open(card_check.NOTICE_KEY) is None


# --------------------------------------------------------------------------- concepts.py: a label's run


async def test_a_label_run_that_left_units_unlabeled_is_told_and_one_that_did_not_clears_it(monkeypatch):
    monkeypatch.setattr(concepts, "BATCH_ITEMS", 1)
    monkeypatch.setattr(concepts, "RETRY_DELAYS", ())
    fail = {"on": True}

    async def call(c, concept, items, comment=True, on_retry=None):
        if fail["on"]:
            return model_mod.CallResult(status="error", detail="API Error: Repeated 529 Overloaded errors")
        return model_mod.CallResult(status="ok", output={"labels": [
            {"i": n, "label": "no", "confidence": 0.7, "rationale": "r"} for n in range(1, len(items) + 1)]},
            refused_by="claude-opus-5-5", model_requested="claude-opus-4-8")

    monkeypatch.setattr(concepts, "classify_structured", call)
    k = concepts.define_concept(CORPUS, "claims a PR", "a board post that claims a PR", "prompt")
    await concepts.run_apply(CORPUS, k["id"], ["board.jsonl"])
    n = _open(f"label:{k['id']}")
    assert n["text"] == ("The label claims a PR couldn't label 8 of 8 records: Anthropic's API is overloaded; try again "
                         "in a few minutes.")
    assert n["agent"] == "Label: claims a PR" and n["kind"] == "label"
    fail["on"] = False
    await concepts.run_apply(CORPUS, k["id"], ["board.jsonl"])
    assert _open(f"label:{k['id']}") is None
    s = _open(f"safeguards:label:{k['id']}")
    assert s["text"] == "Claude's safeguards switched 8 of the label claims a PR's calls from Opus 5.5 to Opus 4.8."


def test_units_with_no_text_are_counted_in_the_count_s_own_form():
    assert concepts.blank_text_cause(1, "record", "runs/a/board.jsonl#L3") == (
        "1 record has no readable text (e.g. runs/a/board.jsonl#L3), so it was not labeled")
    assert concepts.blank_text_cause(1200, "agent", "runs/a/agent-01.jsonl") == (
        "1,200 files have no readable text (e.g. runs/a/agent-01.jsonl), so they were not labeled")
