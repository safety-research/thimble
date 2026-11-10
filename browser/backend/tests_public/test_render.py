"""app.render: the theme the harness draws a card in (what the analyst's browser last reported, its figure style among
it), and the request it sends the render page. The browser is never launched here: the pool is stood in for. All data
is made up."""
from __future__ import annotations

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
