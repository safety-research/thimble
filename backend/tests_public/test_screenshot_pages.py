"""The screenshot tool (app/tools.py): an http address is shot only on thimble's own port or its interface's."""
from __future__ import annotations

import base64
from pathlib import Path

import pytest

from app import dev, tools


class FakeShot:
    """Stands in for dev.run_shot: records each call with the page it loads, and writes a one-pixel png."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, str | None, dict, str]] = []

    async def __call__(self, url, out, selector=None, **kw):
        from starlette.datastructures import Headers

        from app import hook_auth

        tok = kw.get("read_token")  # whether the page's reads would pass hook_auth.LocalReadGuard while it is shot
        kw["token_live"] = bool(tok) and hook_auth.shot_proven(Headers({hook_auth.SHOT_HEADER: tok}), "GET")
        self.calls.append((url, selector, kw, Path(url.removeprefix("file://")).read_text("utf-8")
                           if url.startswith("file://") else ""))
        Path(out).write_bytes(base64.b64decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="))
        return 0


@pytest.fixture()
def shots(monkeypatch):
    fake = FakeShot()
    monkeypatch.setattr(dev, "run_shot", fake)
    return fake


async def test_a_page_screenshot_reaches_only_thimble_s_own_port_or_its_interface_s(shots, monkeypatch):
    monkeypatch.setenv("THIMBLE_PORT", "8721")
    monkeypatch.delenv("THIMBLE_DEV", raising=False)
    ok = await tools._shot_page("http://127.0.0.1:8721/?ws=mini", None)
    assert not ok.is_error and shots.calls[-1][0] == "http://127.0.0.1:8721/?ws=mini"
    for url in ("http://127.0.0.1:22/", "http://localhost/", "http://127.0.0.1:8722/", "http://evil.example:8721/",
                "http://127.0.0.1:99999/", "http://localhost.evil.example:8721/", "http://evil.example\\@127.0.0.1:8721/",
                "http://127.0.0.1:9\\@127.0.0.1:8721/", "http://x@127.0.0.1:8721/"):
        r = await tools._shot_page(url, None)
        assert r.is_error and "8721" in r.text, url
    assert len(shots.calls) == 1, "nothing else was loaded"
    monkeypatch.setenv("THIMBLE_DEV", "1")
    monkeypatch.setenv("THIMBLE_FRONTEND_URL", "http://127.0.0.1:5399")
    assert tools.shot_ports() == {8721, 5399}
    assert not (await tools._shot_page("http://localhost:5399/", ".canvas")).is_error


async def test_a_card_is_shot_once_its_page_has_drawn_it_with_no_fixed_wait_and_no_key(shots, monkeypatch):
    """The live QA of 0.7.0 (2026-10-10): each card screenshot took 4.2-4.6 s, 2.2 s of it a fixed wait for the flash of
    the card the page opened, and a key pressed to clear its selection. The page opens the card its URL names still, so
    the shot waits only until the card is drawn (scripts/ui_shot.mjs --settle, tests in browser/card-shot.test.ts)."""
    monkeypatch.setattr(tools.headless, "missing", lambda kind: "")
    shot = await tools._shot_card_in_ui("mini", "c1a2b3c4", "http://127.0.0.1:8721")
    assert shot is not None and not shot.is_error
    [(url, selector, kw, _)] = shots.calls
    assert url == "http://127.0.0.1:8721/?ws=mini&ref=card%3Ac1a2b3c4"
    assert selector == 'article.canvas-card[data-cell="c1a2b3c4"]'
    assert kw["settle"] is True and not kw.get("wait_ms") and not kw.get("press")


async def test_a_shot_of_the_page_reads_with_a_shot_token_that_ends_with_it(shots, monkeypatch):
    """The headless page holds no sign-in cookie, so a page or card shot hands its run a shot token
    (hook_auth.mint_shot), good for reads while the shot runs and dropped when it ends; a figure's own page, which
    reaches nothing, gets none."""
    from starlette.datastructures import Headers

    from app import hook_auth

    monkeypatch.setenv("THIMBLE_PORT", "8721")
    monkeypatch.delenv("THIMBLE_DEV", raising=False)
    monkeypatch.setattr(tools.headless, "missing", lambda kind: "")
    assert not (await tools._shot_page("http://127.0.0.1:8721/?ws=mini", None)).is_error
    assert await tools._shot_card_in_ui("mini", "c1a2b3c4", "http://127.0.0.1:8721") is not None
    for _, _, kw, _ in shots.calls:
        assert kw["read_token"] and kw["token_live"], kw
        assert not hook_auth.shot_proven(Headers({hook_auth.SHOT_HEADER: kw["read_token"]}), "GET"), "dropped after"
    assert shots.calls[0][2]["read_token"] != shots.calls[1][2]["read_token"], "a token for each shot"
    await tools._shot_page_file("c1", "<!doctype html><p>figure</p>")
    assert not shots.calls[-1][2].get("read_token") and shots.calls[-1][2]["offline"] is True
