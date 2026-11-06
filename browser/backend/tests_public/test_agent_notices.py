"""A failure of thimble's agents reaches the analyst where they are looking (notices.py): a view whose builder stopped
without passing its checks (dev.py) is one open notice under the agent's key, with its fixes, Send to thimble-fix and
Discard, and Open on its chat; its next build clears it. The module is the fake bridge (subagent_fakes)."""
from __future__ import annotations

import asyncio
import json

import pytest

from app import config, dev, notices, subagents, views
from subagent_fakes import bridge  # noqa: F401 — a fixture

# model calls go through Claude Code, which the tests fake (conftest claude_code_sign_in)
pytestmark = pytest.mark.usefixtures("claude_code_sign_in")

CORPUS = "mini"


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


async def test_a_view_that_failed_its_checks_is_told_with_its_fixes_and_no_retry_and_its_next_build_clears_it(
        board, bridge):
    """A builder that stopped without passing the view's checks: the notice says what is wrong with the view in the
    analyst's words, not the checks' own, and offers no Retry, which would build the same files again, but asks to send
    it to thimble-fix, with what failed, or Discard the view; Open goes to the build's thread."""
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
    assert n["text"] == f"Posts failed: {views.plain_failure('problem: the page threw')}. Send to thimble-fix?"
    send, discard = n["action"]
    assert send["do"] == "thimble-fix" and "problem: the page threw" in send["text"]
    assert discard == {"label": dev.DISCARD_VIEW, "do": "view-discard", "slug": slug}
    assert n["agent"] == "View build: Posts" and n["chat"] == prop["chat"]
    await dev.start_build(c, slug, subagents.CLICK)
    await _until(lambda: _open(f"agent:view:{slug}", c) is None, "its next build left the notice")
