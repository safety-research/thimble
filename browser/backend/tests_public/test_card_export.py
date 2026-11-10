"""A card exported as figure files (app/card_export.py): the files each figure style makes, named after the card's
question, as the card's Export menu lists and saves them and as main's export_card writes them into the corpus. The card
harness is stood in for, as test_render.py stands in for it: no browser is launched. All data is made up."""
from __future__ import annotations

import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import card_export, config, ledger, notebook, render, tools

CORPUS = "mini"
app = FastAPI()
app.include_router(card_export.router, prefix="/api")
QUESTION = "Which model scores best on each task?"
STEM = "which-model-scores-best-on-each-task"
CHART = {"application/vnd.vegalite.v5+json": {
    "data": {"values": [{"model": "alpha", "task": "parse", "score": 0.6}, {"model": "beta", "task": "parse", "score": 0.5}]},
    "mark": "bar", "encoding": {"x": {"field": "task", "type": "nominal"}, "y": {"field": "score", "type": "quantitative"},
                                "color": {"field": "model", "type": "nominal"}}}}


@pytest.fixture()
def cards():
    """A chart card and a table card in workspace mini: their ids."""
    ws = config.workspace_dir(CORPUS)
    nb = notebook.create_notebook(ws, "Your work", role="analyst")
    chart = notebook.new_cell("plot", "terminal", QUESTION, nb["id"], code="chart()")
    chart["status"], chart["outputs"], chart["takeaway"] = "ok", [CHART], "alpha leads on parse."
    table = notebook.new_cell("table", "terminal", "", nb["id"], code="runs")
    table["status"], table["outputs"] = "ok", [{"text/plain": "run  status\nr1   ok"}]
    nb["cells"] += [chart, table]
    notebook.write_notebook(ws, nb)
    return {"chart": chart["id"], "table": table["id"]}


def report(figures: str) -> None:
    """The figure style the analyst's browser reported."""
    (config.workspace_dir(CORPUS) / render.THEMES_FILE).write_text(json.dumps({"paper": "warm", "accent": "iris",
                                                                               "figures": figures}))


@pytest.fixture()
def harness(monkeypatch):
    """The harness on, its pool standing in for the browser: each request it is given, and made-up files; a Paper
    legend of `legend` entries (None: the chart has no legend of colors)."""

    class FakePool:
        requests: list[dict] = []
        legend: int | None = 4

        async def render(self, request, *, timeout_s=render.RENDER_TIMEOUT_S, still=True):
            self.requests.append(request)
            figure = request["figure"]
            asked = figure.get("files") or []
            if figure["part"] == "legend":
                return render.Rendered(png=b"legend png", box={"x": 16, "y": 16, "width": 120, "height": 30},
                                       empty=self.legend is None, entries=self.legend or 0,
                                       pdf=f"legend pdf {figure.get('columns')}".encode() if "pdf" in asked else None)
            return render.Rendered(png=b"made-up png", box={"x": 16, "y": 16, "width": 800, "height": 520},
                                   webp=b"made-up webp" if "webp" in asked else None,
                                   pdf=b"made-up pdf" if "pdf" in asked else None,
                                   svg="<svg>made-up</svg>" if "svg" in asked else None)

    pool = FakePool()
    FakePool.requests = []
    monkeypatch.setattr(render, "enabled", lambda: True)
    monkeypatch.setattr(render, "pool", lambda: pool)
    return pool


def cell(cid: str) -> dict:
    return notebook.get_cell(CORPUS, cid)


def test_a_figures_files_take_their_name_from_the_cards_question():
    assert card_export.stem(QUESTION, "a1b2c3d4") == STEM
    assert card_export.stem("What's the café's rate, per run?", "a1b2c3d4") == "whats-the-cafes-rate-per-run"
    long = card_export.stem("How many runs failed on each of the twelve nightly builds between March and April?", "x")
    assert long == "how-many-runs-failed-on-each-of-the-twelve-nightly-builds" and len(long) <= card_export.STEM_CHARS
    assert card_export.stem("x" * 80, "a1b2c3d4") == "x" * card_export.STEM_CHARS
    # a question with no word in it: the card's id
    assert card_export.stem("", "a1b2c3d4") == card_export.stem("? !", "a1b2c3d4") == "a1b2c3d4"


async def test_each_figure_style_lists_its_files(cards, harness):
    chart, table = cell(cards["chart"]), cell(cards["table"])
    ids = lambda listed: [f["id"] for f in listed]  # noqa: E731
    assert ids(await card_export.files(CORPUS, chart, "thimble")) == ["png", "pdf", "svg"]
    blog = await card_export.files(CORPUS, chart, "blog")
    assert ids(blog) == ["png", "webp", "pdf", "svg"] and all(f["ok"] for f in blog)
    assert [f["file"] for f in blog] == [f"{STEM}.png", f"{STEM}.webp", f"{STEM}.pdf", f"{STEM}.svg"]
    assert not harness.requests, "thimble's and Blog's files are listed without drawing"
    # Paper: the chart alone, and its legend in paper-figure's layouts for its 4 entries
    paper = await card_export.files(CORPUS, chart, "paper")
    assert [(f["id"], f["name"], f["file"]) for f in paper] == [
        ("pdf", "PDF", f"{STEM}.pdf"),
        ("legend_1col", "Legend, 1 column", f"{STEM}_legend_1col.pdf"),
        ("legend_2col", "Legend, 2 columns", f"{STEM}_legend_2col.pdf"),
        ("legend_3col", "Legend, 3 columns", f"{STEM}_legend_3col.pdf"),
        ("legend_4col", "Legend, one row", f"{STEM}_legend_4col.pdf")]
    assert harness.requests[-1]["figure"] == {"style": "paper", "part": "legend"}
    harness.legend = 2
    assert ids(await card_export.files(CORPUS, chart, "paper")) == ["pdf", "legend_1col", "legend_2col"]
    harness.legend = 0  # a legend of amounts (a heatmap's), which has no columns
    assert ids(await card_export.files(CORPUS, chart, "paper")) == ["pdf", "legend_1col"]
    harness.legend = None
    assert ids(await card_export.files(CORPUS, chart, "paper")) == ["pdf"]
    # a card with no chart: no SVG, and no legend to draw
    drawn = len(harness.requests)
    assert ids(await card_export.files(CORPUS, table, "thimble")) == ["png", "pdf"]
    assert ids(await card_export.files(CORPUS, table, "paper")) == ["pdf"] and len(harness.requests) == drawn
    assert (await card_export.files(CORPUS, table, "blog"))[0]["file"] == f"{cards['table']}.png"


async def test_without_the_harness_every_file_is_listed_not_ok_with_the_reason(cards):
    listed = await card_export.files(CORPUS, cell(cards["chart"]), "blog")
    assert [f["id"] for f in listed] == ["png", "webp", "pdf", "svg"]
    assert all(not f["ok"] and f["why"] == "Needs a browser: THIMBLE_RENDER is off" for f in listed)
    report("blog")
    r = TestClient(app).get(f"/api/ws/{CORPUS}/cards/{cards['chart']}/figure/png")
    assert r.status_code == 409 and "Needs a browser" in r.json()["detail"]


def test_the_menu_lists_the_reported_styles_files_and_saves_each_by_its_name(cards, harness):
    client = TestClient(app)
    report("blog")
    base = f"/api/ws/{CORPUS}/cards/{cards['chart']}/figure"
    listed = client.get(base).json()
    assert listed["style"] == "blog"
    assert listed["files"][1] == {"id": "webp", "name": "WebP", "ext": "webp", "ok": True}
    r = client.get(f"{base}/webp")
    assert r.status_code == 200 and r.content == b"made-up webp" and r.headers["content-type"] == "image/webp"
    assert r.headers["x-export-name"] == f"{STEM}.webp" and f'filename="{STEM}.webp"' in r.headers["content-disposition"]
    assert harness.requests[-1]["figure"] == {"style": "blog", "part": "figure", "files": ["webp"]}
    assert client.get(f"{base}/png").content == b"made-up png"
    assert client.get(f"{base}/svg").headers["content-type"].startswith("image/svg+xml")
    # what the style or the card has not
    assert client.get(f"{base}/legend_2col").status_code == 404
    assert client.get(f"/api/ws/{CORPUS}/cards/{cards['table']}/figure/svg").status_code == 404
    assert client.get(f"/api/ws/{CORPUS}/cards/nosuchid/figure").status_code == 404
    report("paper")
    assert [f["id"] for f in client.get(base).json()["files"]] == ["pdf", "legend_1col", "legend_2col", "legend_3col",
                                                                   "legend_4col"]
    r = client.get(f"{base}/legend_3col")
    assert r.content == b"legend pdf 3" and r.headers["x-export-name"] == f"{STEM}_legend_3col.pdf"
    assert harness.requests[-1]["figure"] == {"style": "paper", "part": "legend", "columns": 3, "files": ["pdf"]}
    assert client.get(f"{base}/legend_5col").status_code == 404, "a layout its 4 entries do not have"
    assert client.get(f"{base}/png").status_code == 404, "Paper's figure is a PDF"


async def test_export_card_writes_every_file_of_the_reported_style_into_a_folder_of_the_corpus(cards, harness, data_tmp):
    report("blog")
    r = await tools.call(CORPUS, "export_card", {"card": f"card:{cards['chart']}"}, actor="analyst")
    assert not r.is_error, r.text
    written = [f"figures/{STEM}.{ext}" for ext in ("png", "webp", "pdf", "svg")]
    assert f"in the Blog figure style: {', '.join(written)}." in r.text
    assert (data_tmp / CORPUS / "figures" / f"{STEM}.webp").read_bytes() == b"made-up webp"
    assert sorted(p.name for p in (data_tmp / CORPUS / "figures").iterdir()) == sorted(w.split("/")[1] for w in written)
    # the figure's files come from one drawing
    assert [q["figure"].get("files") for q in harness.requests] == [["webp", "pdf", "svg"]]
    report("paper")
    r = await tools.call(CORPUS, "export_card", {"card": f"card:{cards['chart']}", "folder": "paper/fig"},
                         actor="analyst")
    assert not r.is_error, r.text
    assert "in the Paper figure style: paper/fig/" in r.text
    assert sorted(p.name for p in (data_tmp / CORPUS / "paper" / "fig").iterdir()) == [
        f"{STEM}.pdf", *(f"{STEM}_legend_{k}col.pdf" for k in (1, 2, 3, 4))]
    assert (data_tmp / CORPUS / "paper" / "fig" / f"{STEM}_legend_2col.pdf").read_bytes() == b"legend pdf 2"


async def test_export_card_writes_only_inside_the_corpus_and_only_while_the_analyst_lets_claude_edit_it(
        cards, harness, data_tmp, tmp_path):
    report("blog")
    corpus = data_tmp / CORPUS
    before = sorted(p.relative_to(corpus) for p in corpus.rglob("*"))
    card = f"card:{cards['chart']}"
    for folder in ("/tmp/figures", "~/figures", "../figures", "figures/../../out"):
        r = await tools.call(CORPUS, "export_card", {"card": card, "folder": folder}, actor="analyst")
        assert r.is_error and "inside the corpus folder" in r.text, (folder, r.text)
    ledger.put_settings(CORPUS, {"corpus_edits": False})
    r = await tools.call(CORPUS, "export_card", {"card": card}, actor="analyst")
    assert r.is_error and "Claude can edit files in this folder" in r.text
    assert not harness.requests, "nothing is drawn for a call that cannot write"
    ledger.put_settings(CORPUS, {"corpus_edits": None})
    # a link in the folder's place is not followed out of the corpus
    outside = tmp_path / "outside"
    outside.mkdir()
    (corpus / "linked").symlink_to(outside, target_is_directory=True)
    r = await tools.call(CORPUS, "export_card", {"card": card, "folder": "linked"}, actor="analyst")
    assert r.is_error and "wrote nothing" in r.text and not any(outside.iterdir())
    (corpus / "linked").unlink()
    assert sorted(p.relative_to(corpus) for p in corpus.rglob("*")) == before
