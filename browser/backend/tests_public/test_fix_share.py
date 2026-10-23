"""Share on a fix in the browser (app/fix_share.py): the analyst's click alone; Claude's text, then the plugin kernel's
GitHub link (`thimble file issue`, run for real on a made-up fix record); and when Claude writes no text, the link still
comes, with why. Nothing is sent. All data here is made up."""
from __future__ import annotations

import asyncio
import json
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import pytest
from fastapi import HTTPException
from starlette.requests import Request

from app import fix_share, main

REC = {"id": 2, "title": "Minimap covers cards", "words": ["the minimap hides the last lines of cards"], "rounds": 1,
       "made_in": "browser", "created": 1.0, "state": "on", "commit": "c0ffee1",
       "files": [{"path": "browser/frontend/src/canvas/Minimap.tsx", "add": 3, "del": 1}], "tests": "passed",
       "summary": "The minimap folds into a small button.", "error": None, "work": None, "base": "b0b0b0b"}
TEXT = {"title": "The minimap covers the text of cards",
        "wrong": "The zoom box sat on top of cards near the bottom right and hid their last lines.",
        "fixed": "The box folds into a small button in the corner and opens on hover."}


@pytest.fixture()
def home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    h = tmp_path / "plugin-home"
    (h / "fixes").mkdir(parents=True)
    (h / "fixes" / "fixes.jsonl").write_text(json.dumps(REC) + "\n")
    monkeypatch.setenv(fix_share.PLUGIN_HOME_ENV, str(h))
    return h


def test_share_is_a_route_of_the_server():
    assert "fix_share" in main.ROUTER_MODULES
    paths = {r.path for r in fix_share.router.routes}
    assert paths == {"/fixes/{fid}/share"}


def test_share_puts_claudes_text_through_the_scan_into_githubs_link(home, monkeypatch, analyst):
    seen: dict = {}

    async def drafted(c, rec):
        seen.update(c=c, id=rec["id"])
        return TEXT

    monkeypatch.setattr(fix_share, "drafted", drafted)
    out = asyncio.run(fix_share.share_route(2, analyst, fix_share.ShareBody(ws="w1")))
    assert seen == {"c": "w1", "id": 2}
    assert out["title"] == TEXT["title"] and out["text"] == "claude" and out["note"] == ""
    assert "page" not in out
    q = parse_qs(urlsplit(out["url"]).query)
    assert out["url"].startswith("https://github.com/safety-research/thimble/issues/new?")
    assert q["title"] == [TEXT["title"]] and q["body"][0].startswith(f"### What was wrong\n\n{TEXT['wrong']}")
    assert "· browser · fixed by <code>thimble fix</code>" in q["body"][0]
    # no local page: the analyst's tab goes to GitHub
    assert not (home / "fixes" / "share" / "2" / "index.html").exists()


def test_without_claudes_text_the_link_still_comes_and_says_why(home, monkeypatch, analyst):
    async def no_text(c, rec):
        return "Claude did not write the text (timeout)"

    monkeypatch.setattr(fix_share, "drafted", no_text)
    out = asyncio.run(fix_share.share_route(2, analyst, None))
    assert out["note"] == "Claude did not write the text (timeout)" and out["text"] == "record"
    assert out["title"] == "Minimap covers cards"
    assert parse_qs(urlsplit(out["url"]).query)["body"][0].startswith("### What was wrong\n\nthe minimap hides the last lines")


def test_share_is_the_analysts_click(home, monkeypatch):
    stranger = Request({"type": "http", "headers": [], "state": {}})
    with pytest.raises(HTTPException) as e:
        asyncio.run(fix_share.share_route(2, stranger, None))
    assert e.value.status_code == 403
