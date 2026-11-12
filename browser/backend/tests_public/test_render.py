"""app.render: a card's figure as an export draws it (render_figure), whole as an export of the card alone shows it, the
files the harness makes of one drawing besides its picture (FIGURE_FILES), and the theme a card is drawn in (put_theme).
The browser is never launched here: the pool and the page are stood in for. All data is made up."""
from __future__ import annotations

import base64

import pytest
from fastapi import HTTPException

from app import render

CORPUS = "mini"
CELL = {"id": "c1", "kind": "plot", "title": "Runs per day?", "takeaway": "Most runs end on [[day 2|card:c1]].",
        "outputs": []}


@pytest.fixture()
def drawn(monkeypatch):
    """The harness on, its pool standing in for the browser: each request it is given, and a made-up picture."""
    requests: list[dict] = []

    class FakePool:
        async def render(self, request, *, timeout_s=render.RENDER_TIMEOUT_S, still=True):
            requests.append(request)
            return render.Rendered(png=b"made-up png", box={"x": 16, "y": 16, "width": 480, "height": 520})

    monkeypatch.setattr(render, "enabled", lambda: True)
    monkeypatch.setattr(render, "pool", lambda: FakePool())
    return requests


async def test_render_figure_names_the_files_to_make_of_the_drawing_and_refuses_one_it_does_not_know(drawn):
    await render.render_figure(CORPUS, CELL, width=480, whole=True, files=("webp", "pdf", "webp"))
    req = drawn[-1]
    assert (req["figure"], req["whole"], req["files"], req["width"]) == (True, True, ["webp", "pdf"], 480)
    assert req["card"]["takeaway"] == CELL["takeaway"], "the takeaway is the page's to set as a caption"
    # a report's figure: the art alone, and no files
    await render.render_figure(CORPUS, CELL, width=640, zoom=1.5)
    assert "whole" not in drawn[-1] and "files" not in drawn[-1] and drawn[-1]["zoom"] == 1.5
    with pytest.raises(ValueError, match="files"):
        await render.render_figure(CORPUS, CELL, width=480, files=("gif",))
    assert len(drawn) == 2


async def test_the_theme_takes_an_accent_the_page_added_and_the_cards_drawn_here_are_drawn_in_it(drawn):
    """The page's list is the one list of accents (frontend lib/theme.ts ACCENTS): an accent added there, which the
    server never named, is taken and kept, and the cards drawn after it, an export's figure too, are drawn in it. A name
    of another form is refused and changes nothing."""
    teal = {"paper": "warm", "accent": "teal"}
    assert await render.put_theme(CORPUS, render.ThemeBody(**teal)) == teal
    await render.render_card(CORPUS, CELL)
    await render.render_figure(CORPUS, CELL, width=480)
    assert [r["theme"] for r in drawn] == [teal, {"paper": "neutral", "accent": "teal"}]
    for name in ("Teal", "teal'] body {", ""):
        with pytest.raises(HTTPException) as e:
            await render.put_theme(CORPUS, render.ThemeBody(paper="warm", accent=name))
        assert e.value.status_code == 400, name
    assert render.theme(CORPUS) == teal


async def test_a_figures_files_come_from_the_drawing_its_picture_shows():
    """The page puts the chart's SVG in its result; the harness encodes the picture as WebP in the page, and prints the
    figure alone on one page of the picture's size, edge to edge, in the page's screen styles, setting the page back
    after. A request that names no files makes none. The page is stood in for."""

    class FakePage:
        def __init__(self):
            self.calls = []

        async def evaluate(self, script, *args):
            self.calls.append((script, args))
            if "render(" in script:
                return {"box": {"x": 16, "y": 16, "width": 480, "height": 519.5}, "fonts": True,
                        "svg": "<svg>the chart</svg>"}
            if "webp(" in script:
                assert base64.b64decode(args[0]) == b"made-up png"
                return base64.b64encode(b"made-up webp").decode("ascii")
            return None if "print(" in script else False

        async def screenshot(self, **kw):
            return b"made-up png"

        async def emulate_media(self, *, media):
            self.calls.append(("media", media))

        async def pdf(self, **kw):
            self.calls.append(("pdf", kw))
            return b"%PDF made-up"

    page, res = FakePage(), render.Rendered()
    await render.Pool(pages=1)._render_on(page, {"figure": True, "whole": True, "files": ["webp", "pdf", "svg"]}, res)
    assert (res.png, res.webp, res.pdf, res.svg) == (b"made-up png", b"made-up webp", b"%PDF made-up",
                                                     "<svg>the chart</svg>")
    clip = {"x": 16, "y": 16, "width": 480, "height": 520}
    printing = [c for c in page.calls if c[0] in ("media", "pdf") or "print(" in c[0]]
    assert printing == [("(box) => window.__thimbleRender.print(box)", (clip,)), ("media", "screen"),
                        ("pdf", {"width": "480px", "height": "520px", "print_background": True,
                                 "margin": render.NO_MARGIN, "page_ranges": "1"}),
                        ("media", "null"), ("() => window.__thimbleRender.print(null)", ())]
    page, res = FakePage(), render.Rendered()
    await render.Pool(pages=1)._render_on(page, {"figure": True}, res)
    assert res.png == b"made-up png" and (res.webp, res.pdf) == (None, None)
    assert not [c for c in page.calls if c[0] in ("media", "pdf") or "webp(" in c[0]]
