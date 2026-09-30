"""The card harness (app/render.py) on a machine without its headless Chromium: it says so plainly, warns once and does
not try again, and no card check begins, or stays on a card when it began before the harness knew."""
from __future__ import annotations

import logging

import playwright.async_api
import pytest

from app import card_check, config, headless, notebook, render, userconf

CORPUS = "mini"


@pytest.fixture()
def no_browser(tmp_path, monkeypatch, workspaces_tmp):
    """Playwright's browsers folder empty, no system browser, the harness and the card check on, and nothing known yet
    of the browser."""
    empty = tmp_path / "browsers"
    empty.mkdir()
    page = tmp_path / "dist"
    page.mkdir()
    (page / render.RENDER_PAGE).write_text("<!doctype html>")
    monkeypatch.setenv("PLAYWRIGHT_BROWSERS_PATH", str(empty))
    monkeypatch.setattr(userconf, "system_browser", lambda: "")
    monkeypatch.setenv("THIMBLE_RENDER_DIR", str(page))
    monkeypatch.setenv("THIMBLE_RENDER", "on")
    monkeypatch.setenv("THIMBLE_CARD_CHECK", "on")
    monkeypatch.setattr(headless, "_missing", {})
    monkeypatch.setattr(render, "_pool", None)


def _card() -> str:
    """A note card a model made, with its takeaway, which the check would read."""
    nb = notebook.create_notebook(config.workspace_dir(CORPUS), "Work")["id"]
    cell = notebook.new_cell("note", "model", payload={"text": "A note."})
    cell.update(takeaway="What the note shows.", takeaway_author="model")
    return notebook.insert_cell(CORPUS, nb, cell)["id"]


async def test_without_its_browser_the_harness_warns_once_and_no_card_check_is_left(no_browser, monkeypatch, caplog):
    launches = []
    real = playwright.async_api.async_playwright
    monkeypatch.setattr(playwright.async_api, "async_playwright", lambda: launches.append(1) or real())
    caplog.set_level(logging.WARNING)
    cid = _card()

    async def undrawable(c, cell, **kw):  # the harness as it answers before its first launch has failed
        raise render.Unavailable(headless.NOT_INSTALLED)

    monkeypatch.setattr(render, "render_card", undrawable)
    run = card_check.start(CORPUS, cid, card_check.MAIN)
    assert run is not None and run.task is not None
    await run.task
    assert "check" not in notebook.get_cell(CORPUS, cid)

    assert not await render.start() and not await render.start()
    assert len(launches) == 1 and render.down() and render.why() == headless.NOT_INSTALLED
    assert [r.name for r in caplog.records] == ["thimble.headless"], [r.getMessage() for r in caplog.records]
    assert card_check.start(CORPUS, cid, card_check.MAIN) is None
    assert "check" not in notebook.get_cell(CORPUS, cid)
