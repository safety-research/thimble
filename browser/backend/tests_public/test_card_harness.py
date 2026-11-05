"""The card harness (app/render.py) on a machine without its headless Chromium: it says so plainly, warns once and does
not try again, and no card check begins, or stays on a card when it began before the harness knew. With a browser (a
fake one here), the browser closes once no card was drawn for a while and is launched again by the next card."""
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


class _FakePage:
    def __init__(self, delay: float = 0) -> None:
        self.delay = delay

    async def goto(self, url, **kw):
        return None

    async def wait_for_function(self, js, **kw):
        return None

    async def evaluate(self, js, req=None):
        import asyncio  # noqa: PLC0415

        await asyncio.sleep(self.delay)
        return {"box": {"x": 0, "y": 0, "width": 10, "height": 10}, "frames": [], "fonts": True}

    async def screenshot(self, **kw):
        return b"png"

    async def close(self):
        return None


class _FakeBrowser:
    """A headless Chromium as the pool drives it, which records its launches and closes."""

    def __init__(self, log: list[str], delay: float) -> None:
        self.log, self.delay, self.up = log, delay, True

    def is_connected(self) -> bool:
        return self.up

    async def new_context(self, **kw):
        browser = self

        class Context:
            async def route(self, *a, **kw):
                return None

            async def new_page(self):
                return _FakePage(browser.delay)

            async def close(self):
                return None

        return Context()

    async def close(self):
        self.up = False
        self.log.append("close")


def _fake_playwright(log: list[str], delay: float = 0):
    class Chromium:
        async def launch(self, **kw):
            log.append("launch")
            return _FakeBrowser(log, delay)

    class Playwright:
        chromium = Chromium()

        async def stop(self):
            log.append("stop")

    class Starter:
        async def start(self):
            return Playwright()

    return lambda: Starter()


async def test_the_browser_closes_when_no_card_was_drawn_for_a_while_and_comes_back_for_the_next(no_browser, monkeypatch):
    import asyncio  # noqa: PLC0415

    log: list[str] = []
    delay = {"s": 0.0}
    monkeypatch.setattr(playwright.async_api, "async_playwright", lambda: _fake_playwright(log, delay["s"])())
    monkeypatch.setattr(headless, "launch", lambda kind: "")
    monkeypatch.setattr(render, "IDLE_S", 0.3)
    monkeypatch.setattr(render, "enabled", lambda: True)
    pool = render.Pool(pages=1)
    monkeypatch.setattr(render, "_pool", pool)
    try:
        assert (await pool.render({})).ok and log == ["launch"]
        await asyncio.sleep(0.6)
        assert log == ["launch", "close", "stop"] and not pool.ready
        assert render.available() and (await render.status())["ready"], "a browser closed for idleness still draws cards"
        delay["s"] = 0.6  # a render that runs past IDLE_S keeps the browser up
        assert (await pool.render({})).ok and log[3:] == ["launch"]
        await asyncio.sleep(0.15)
        assert pool.ready and log[4:] == []
        await asyncio.sleep(0.5)
        assert log[4:] == ["close", "stop"]
    finally:
        await pool.stop()


class _AnimatedPage(_FakePage):
    """A card with a frame that draws itself (render.SELF_DRAWN), whose picture changes with each shot until its
    `frames`-th, as an animation that draws a day at a time does, and stays the same after."""

    def __init__(self, frames: int) -> None:
        super().__init__()
        self.frames, self.shots, self.animations = frames, 0, []

    async def evaluate(self, js, req=None):
        return True if js == render.SELF_DRAWN else await super().evaluate(js, req)

    async def screenshot(self, **kw):
        self.shots += 1
        self.animations.append(kw.get("animations"))
        return f"frame {min(self.shots, self.frames)}".encode()


async def test_a_card_whose_frame_animates_is_shot_once_its_picture_stays_the_same(monkeypatch):
    """A custom card's page draws inside its own frame, which the render page cannot watch: the card is shot again until
    its picture stays the same, with the frame's animations playing, so the check reads what the animation drew rather
    than its first frame. One that never stops is shot as it stands at STILL_MAX_S, and card_fit, which needs the size
    alone, takes the first picture."""
    monkeypatch.setattr(render, "STILL_POLL_S", 0.01)
    monkeypatch.setattr(render, "STILL_QUIET_S", 0.08)
    monkeypatch.setattr(render, "STILL_MAX_S", 1.0)
    page, res = _AnimatedPage(frames=6), render.Rendered()
    await render.Pool(pages=1)._render_on(page, {}, res)
    assert res.png == b"frame 6" and res.ok and set(page.animations) == {"allow"}
    first = render.Rendered()
    await render.Pool(pages=1)._render_on(_AnimatedPage(frames=6), {}, first, still=False)
    assert first.png == b"frame 1"
    monkeypatch.setattr(render, "STILL_MAX_S", 0.2)
    endless, res = _AnimatedPage(frames=10**9), render.Rendered()
    await render.Pool(pages=1)._render_on(endless, {}, res)
    assert res.ok and 5 < endless.shots < 40, endless.shots
