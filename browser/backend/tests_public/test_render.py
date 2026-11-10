"""app.render: the theme the harness draws a card in (what the analyst's browser last reported, its figure style among
it), the request it sends the render page, and the files it makes of a figure's drawing. The browser is never launched
here: the pool is stood in for. All data is made up."""
from __future__ import annotations

import base64
import json

import pytest
from fastapi.testclient import TestClient

from app import config, main, render

CORPUS = "mini"
THEME_PATH = f"/api/ws/{CORPUS}/render/theme"


def stored() -> dict:
    return json.loads((config.workspace_dir(CORPUS) / render.THEMES_FILE).read_text())


def report(**theme) -> None:
    (config.workspace_dir(CORPUS) / render.THEMES_FILE).write_text(json.dumps(theme))


def test_the_theme_carries_the_figure_style_the_browser_reported_and_thimbles_when_it_names_none_the_harness_knows():
    assert render.theme(CORPUS) == {"paper": "warm", "accent": "iris", "figures": "thimble"}
    report(paper="dark", accent="pink", figures="blog")
    assert render.theme(CORPUS) == {"paper": "dark", "accent": "pink", "figures": "blog"}
    report(paper="neutral", accent="lime", figures="paper")
    assert render.theme(CORPUS)["figures"] == "paper"
    # a file a browser of 1.1 wrote, a style this server does not know, a value that is no name
    for theme in ({"paper": "warm", "accent": "blue"}, {"paper": "warm", "accent": "blue", "figures": "neon"},
                  {"paper": "warm", "accent": "blue", "figures": ["blog"]}):
        report(**theme)
        assert render.theme(CORPUS) == {"paper": "warm", "accent": "blue", "figures": "thimble"}
    (config.workspace_dir(CORPUS) / render.THEMES_FILE).write_text("[1, 2]")
    assert render.theme(CORPUS) == render.DEFAULT_THEME


def test_the_browser_reports_its_figure_style_and_a_style_the_server_does_not_know_is_kept_as_thimbles():
    c = TestClient(main.create_app())
    r = c.put(THEME_PATH, json={"paper": "warm", "accent": "pink", "figures": "blog"})
    assert r.status_code == 200 and r.json() == {"paper": "warm", "accent": "pink", "figures": "blog"}
    assert stored() == {"paper": "warm", "accent": "pink", "figures": "blog"}
    assert c.put(THEME_PATH, json={"paper": "warm", "accent": "pink", "figures": "neon"}).json()["figures"] == "thimble"
    # a browser that names no figure style (an older page still open)
    assert c.put(THEME_PATH, json={"paper": "dark", "accent": "iris"}).json() == {"paper": "dark", "accent": "iris",
                                                                                    "figures": "thimble"}
    assert c.put(THEME_PATH, json={"paper": "sepia", "accent": "iris", "figures": "blog"}).status_code == 400
    assert stored()["paper"] == "dark"


def test_a_cards_request_names_the_theme_with_its_figure_style():
    report(paper="neutral", accent="iris", figures="paper")
    req = render.request_for(CORPUS, {"id": "c1", "kind": "code", "title": "Runs per day?", "takeaway": ""})
    assert req["theme"] == {"paper": "neutral", "accent": "iris", "figures": "paper"}
    assert "figure" not in req


@pytest.fixture()
def drawn(monkeypatch):
    """The harness on, its pool standing in for the browser: each request it is given, and a made-up picture."""
    requests: list[dict] = []

    class FakePool:
        async def render(self, request, *, timeout_s=render.RENDER_TIMEOUT_S, still=True):
            requests.append(request)
            return render.Rendered(png=b"made-up png", box={"x": 16, "y": 16, "width": 800, "height": 520})

    monkeypatch.setattr(render, "enabled", lambda: True)
    monkeypatch.setattr(render, "pool", lambda: FakePool())
    return requests


async def test_render_card_draws_the_card_face_as_the_canvas_does(drawn):
    cell = {"id": "c1", "kind": "code", "title": "Runs per day?", "takeaway": "Most runs end on [[day 2|card:c1]]."}
    r = await render.render_card(CORPUS, cell)
    assert r.ok and r.png == b"made-up png"
    assert drawn[0]["card"]["id"] == "c1" and "figure" not in drawn[0]


async def test_render_figure_asks_the_page_for_the_card_as_a_figure_in_the_style_named_else_the_reported_one(drawn):
    cell = {"id": "c1", "kind": "plot", "title": "Runs per day?", "takeaway": "Most runs end on day 2."}
    report(paper="dark", accent="pink", figures="blog")
    r = await render.render_figure(CORPUS, cell)
    assert r.ok
    assert drawn[-1]["figure"] == {"style": "blog", "part": "figure"}
    # the card, the theme and the rest of the request are a card's, so the page reads the card as it would
    assert drawn[-1]["card"]["id"] == "c1" and drawn[-1]["theme"]["paper"] == "dark"
    await render.render_figure(CORPUS, cell, style="paper", part="legend", columns=2)
    assert drawn[-1]["figure"] == {"style": "paper", "part": "legend", "columns": 2}
    await render.render_figure(CORPUS, cell, style="paper", caption=3)
    assert drawn[-1]["figure"] == {"style": "paper", "part": "figure", "caption": 3}
    # a legend in one row: no columns named
    await render.render_figure(CORPUS, cell, style="paper", part="legend")
    assert "columns" not in drawn[-1]["figure"]


async def test_render_figure_refuses_a_style_or_part_it_does_not_know_and_says_when_the_harness_is_off(drawn, monkeypatch):
    cell = {"id": "c1", "kind": "plot", "title": "Runs per day?"}
    with pytest.raises(ValueError, match="style"):
        await render.render_figure(CORPUS, cell, style="neon")
    with pytest.raises(ValueError, match="part"):
        await render.render_figure(CORPUS, cell, part="caption")
    assert not drawn
    monkeypatch.setattr(render, "enabled", lambda: False)
    with pytest.raises(render.Unavailable):
        await render.render_figure(CORPUS, cell, style="blog")


def test_a_figure_request_carries_the_figure_beside_what_a_card_request_carries():
    cell = {"id": "c1", "kind": "plot", "title": "Runs per day?", "takeaway": ""}
    plain = render.request_for(CORPUS, cell)
    asked = render.request_for(CORPUS, cell, figure={"style": "paper", "part": "legend"})
    assert asked.pop("figure") == {"style": "paper", "part": "legend"}
    assert asked == plain


async def test_the_page_says_when_a_figure_draws_nothing_and_the_picture_is_still_its_box():
    """A Paper legend of a chart with no legend of colors (a matplotlib figure) comes back `empty`, so an export leaves
    its legend files out; a card or a figure that drew comes back as it did. The page is stood in for."""

    class FakePage:
        def __init__(self, out):
            self.out, self.shots = out, []

        async def evaluate(self, script, *args):
            return self.out if args else False

        async def screenshot(self, **kw):
            self.shots.append(kw["clip"])
            return b"made-up png"

    pool = render.Pool(pages=1)
    for out, empty in (({"box": {"x": 16, "y": 16, "width": 4, "height": 4}, "fonts": True, "empty": True}, True),
                       ({"box": {"x": 16, "y": 16, "width": 240, "height": 240}, "fonts": True}, False)):
        page = FakePage(out)
        res = render.Rendered()
        await pool._render_on(page, {"figure": {"style": "paper", "part": "legend"}}, res)
        assert res.empty is empty and res.png == b"made-up png"
        assert page.shots == [{"x": 16, "y": 16, "width": out["box"]["width"], "height": out["box"]["height"]}]


async def test_render_figure_names_the_files_to_make_of_the_drawing_and_refuses_one_it_does_not_know(drawn):
    cell = {"id": "c1", "kind": "plot", "title": "Runs per day?"}
    await render.render_figure(CORPUS, cell, style="blog", files=("webp", "pdf", "webp"))
    assert drawn[-1]["figure"] == {"style": "blog", "part": "figure", "files": ["webp", "pdf"]}
    with pytest.raises(ValueError, match="files"):
        await render.render_figure(CORPUS, cell, style="blog", files=("gif",))


async def test_a_figures_files_come_from_the_drawing_its_picture_shows():
    """The page puts the chart's SVG and a legend's entries in its result; the harness encodes the picture as WebP in the
    page, and prints the figure alone on one page of the picture's size, edge to edge, in the page's screen styles,
    setting the page back after. A request that names no files makes none. The page is stood in for."""

    class FakePage:
        def __init__(self):
            self.calls = []

        async def evaluate(self, script, *args):
            self.calls.append((script, args))
            if "render(" in script:
                return {"box": {"x": 16, "y": 16, "width": 800, "height": 519.5}, "fonts": True, "entries": 3,
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
    await render.Pool(pages=1)._render_on(page, {"figure": {"style": "blog", "part": "figure",
                                                            "files": ["webp", "pdf", "svg"]}}, res)
    assert (res.png, res.webp, res.pdf, res.svg, res.entries) == (b"made-up png", b"made-up webp", b"%PDF made-up",
                                                                  "<svg>the chart</svg>", 3)
    clip = {"x": 16, "y": 16, "width": 800, "height": 520}
    printing = [c for c in page.calls if c[0] in ("media", "pdf") or "print(" in c[0]]
    assert printing == [("(box) => window.__thimbleRender.print(box)", (clip,)), ("media", "screen"),
                        ("pdf", {"width": "800px", "height": "520px", "print_background": True,
                                 "margin": render.NO_MARGIN, "page_ranges": "1"}),
                        ("media", "null"), ("() => window.__thimbleRender.print(null)", ())]
    page, res = FakePage(), render.Rendered()
    await render.Pool(pages=1)._render_on(page, {"figure": {"style": "blog", "part": "figure"}}, res)
    assert res.png == b"made-up png" and (res.webp, res.pdf) == (None, None)
    assert not [c for c in page.calls if c[0] in ("media", "pdf") or "webp(" in c[0]]
