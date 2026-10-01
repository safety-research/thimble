"""A view build or a review's revision whose turn Anthropic's API ends at capacity (app/dev.py): the session is woken
again after a wait, with a plain prompt to go on rather than a report on files it has not written yet, and the turn
counts as no attempt. Every session turn and gate is faked."""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from app import config, dev, tools, userconf, views

CORPUS = "boards"
OVERLOADED = 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'
READER = '''
def build_index(paths):
    return {}


def records(index, query):
    return []


def resolve(index, locator):
    return None
'''
VIEW = dict(name="Posts", description="The board's posts.", claims=["board.jsonl"],
            accepts=[{"form": "L<n>", "means": "one post"}], units=[], libs=[])


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
    return corpus


@pytest.fixture()
def turns(monkeypatch):
    """The session's turns, each answered by the next of `script` (a function of the prompt), the prompts it got, the
    gates run and the capacity waits taken."""
    seen: dict[str, list] = {"prompts": [], "gates": [], "waits": []}
    script: list = []

    async def turn(run, run_log, cwd, prompt, resume, **_kw):
        seen["prompts"].append(prompt)
        run.session_id = run.session_id or "sid-1"
        return script.pop(0)(prompt)

    async def gate(c, slug, locators=None):
        ok = (views.views_dir(c) / slug / views.VIEW_JSON).is_file()
        seen["gates"].append(ok)
        return {"ok": ok, "checks": [], "page": {"ok": ok}, "errors": [] if ok else ["the view's files were never written"]}

    async def wait(s):
        seen["waits"].append(s)

    monkeypatch.setattr(dev, "_worker_turn", turn)
    monkeypatch.setattr(views, "gate", gate)
    monkeypatch.setattr(views, "gate_lines", lambda rep: list(rep.get("errors") or []) or ["the checks passed"])
    monkeypatch.setattr(dev, "_capacity_sleep", wait)
    monkeypatch.setattr(dev, "view_capacity_waits", lambda: [30.0, 60.0])
    return seen, script


def _write(prompt: str) -> str:
    views.write_view(CORPUS, "posts", reader=READER, html="<!doctype html><p>posts</p>", **VIEW)
    return "the view is written"


def test_a_build_the_api_stops_before_it_writes_a_view_is_told_to_go_on_not_what_failed(board, turns):
    seen, script = turns
    slug = views.propose(CORPUS, "Posts", "to read the board", ["board.jsonl"], "one row per post", asked=True)["slug"]
    assert slug == "posts"
    script += [lambda p: OVERLOADED, _write]
    run = dev.Run(ticket_id=f"view:{slug}", title="Posts", ts_start="")
    asyncio.run(dev._run_view(CORPUS, slug, run))
    assert run.status == "built"
    assert seen["waits"] == [30.0]
    assert seen["prompts"][1] == tools.hint("session-retry"), "the session hears it was stopped and goes on"
    assert seen["gates"] == [True], "no gate runs on a folder the session has not written yet"


def test_a_build_run_again_on_its_session_before_it_wrote_a_view_is_told_to_go_on(board, turns):
    """Retry after the API stopped a build through every wait, or a server restart mid-build, runs the ticket again on
    its session: with no view written yet, the session is told to go on, not sent the gate's report on a missing file."""
    seen, script = turns
    slug = views.propose(CORPUS, "Posts", "to read the board", ["board.jsonl"], "one row per post", asked=True)["slug"]
    views.update_proposal(CORPUS, slug, session_id="sid-1")
    script += [_write]
    run = dev.Run(ticket_id=f"view:{slug}", title="Posts", ts_start="")
    asyncio.run(dev._run_view(CORPUS, slug, run))
    assert run.status == "built"
    assert seen["prompts"] == [tools.hint("session-resumed", stopped="")]
    assert seen["gates"] == [True]


def test_a_build_the_api_stops_twice_on_one_report_gets_the_report_once(board, turns, monkeypatch):
    """A report the session was sent and could not act on, since the API stopped its turns, is not sent again."""
    seen, script = turns
    slug = views.propose(CORPUS, "Posts", "to read the board", ["board.jsonl"], "one row per post", asked=True)["slug"]
    folder = views.views_dir(CORPUS) / slug

    def half(prompt: str) -> str:
        folder.mkdir(parents=True, exist_ok=True)
        (folder / views.VIEW_JSON).write_text("{}")
        return "written, not yet checked"

    def done(prompt: str) -> str:
        (folder / views.VIEW_JSON).unlink()
        return _write(prompt)

    async def gate(c, s, locators=None):
        ok = (folder / views.VIEW_JSON).read_text() != "{}"
        return {"ok": ok, "checks": [], "page": {"ok": ok}, "errors": [] if ok else ["reader.py is missing"]}

    monkeypatch.setattr(views, "gate", gate)
    script += [half, lambda p: OVERLOADED, lambda p: OVERLOADED, done]
    run = dev.Run(ticket_id=f"view:{slug}", title="Posts", ts_start="")
    asyncio.run(dev._run_view(CORPUS, slug, run))
    assert run.status == "built"
    report = dev.build_gates_prompt("reader.py is missing")
    assert seen["prompts"][1:] == [report, tools.hint("session-retry"), tools.hint("session-retry")]


def test_a_review_s_revision_the_api_stops_waits_and_goes_on(board, turns):
    """A 529 in the middle of a revision the view review asked for waits as a build does and wakes the same session,
    so the review's fixes are made rather than thrown away."""
    seen, script = turns
    _write("")
    slug = views.propose(CORPUS, "Posts", "to read the board", ["board.jsonl"], "one row per post", asked=True)["slug"]
    views.update_proposal(CORPUS, slug, session_id="sid-1", status="built")
    script += [lambda p: OVERLOADED, lambda p: "fixed the two problems"]
    ok, said = asyncio.run(dev.review_revision(CORPUS, slug, "fix these two problems"))
    assert (ok, said) == (True, "fixed the two problems")
    assert seen["prompts"] == ["fix these two problems", tools.hint("session-retry")]
    assert seen["waits"] == [30.0] and seen["gates"] == [True], "the turn the API cut short is not checked"


def test_a_review_s_revision_waits_for_as_long_as_the_api_stays_at_capacity(board, turns):
    """Past the build's waits a revision goes on waiting the longest of them."""
    seen, script = turns
    _write("")
    slug = views.propose(CORPUS, "Posts", "to read the board", ["board.jsonl"], "one row per post", asked=True)["slug"]
    views.update_proposal(CORPUS, slug, session_id="sid-1", status="built")
    script += [lambda p: OVERLOADED] * 4 + [lambda p: "fixed it"]
    ok, said = asyncio.run(dev.review_revision(CORPUS, slug, "fix it"))
    assert (ok, said) == (True, "fixed it")
    assert seen["waits"] == [30.0, 60.0, 60.0, 60.0] and seen["gates"] == [True]


def test_a_review_s_revision_stops_at_capacity_when_the_waits_are_turned_off(board, turns, monkeypatch):
    seen, script = turns
    monkeypatch.setattr(dev, "view_capacity_waits", lambda: [])
    _write("")
    slug = views.propose(CORPUS, "Posts", "to read the board", ["board.jsonl"], "one row per post", asked=True)["slug"]
    views.update_proposal(CORPUS, slug, session_id="sid-1", status="built")
    script += [lambda p: OVERLOADED]
    ok, why = asyncio.run(dev.review_revision(CORPUS, slug, "fix it"))
    assert not ok and why == dev.REVIEW_CAPACITY_WHY.format(why=dev.CAPACITY_WORDS["overloaded"], waited=dev._minutes(0.0))
    assert not seen["waits"] and not seen["gates"]
