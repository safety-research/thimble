"""A card exported as figure files (app/card_export.py): its figure as PNG, WebP, PDF and, for a chart, SVG, named after
the card's question, as the card's Export menu lists and saves them and as main's export_card writes them into the
corpus, made by the card harness from one drawing (render.render_figure, `whole`). The harness is stood in for: no
browser is launched. All data is made up."""
from __future__ import annotations

import base64

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import card_export, config, ledger, notebook, render, runtime_tools, tools

CORPUS = "mini"
app = FastAPI()
app.include_router(card_export.router, prefix="/api")
QUESTION = "Which model scores best on each task?"
STEM = "which-model-scores-best-on-each-task"
CHART = {"application/vnd.vegalite.v5+json": {
    "data": {"values": [{"model": "alpha", "task": "parse", "score": 0.6}, {"model": "beta", "task": "parse", "score": 0.5}]},
    "mark": "bar", "encoding": {"x": {"field": "task", "type": "nominal"}, "y": {"field": "score", "type": "quantitative"},
                                "color": {"field": "model", "type": "nominal"}}}}
SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><g id="figure_1"/></svg>'
PNG = base64.b64encode(b"made-up png").decode("ascii")


@pytest.fixture()
def cards():
    """A chart card 480 px wide, a table card, a matplotlib figure drawn as SVG and one drawn as a picture, in workspace
    mini: their ids."""
    ws = config.workspace_dir(CORPUS)
    nb = notebook.create_notebook(ws, "Your work", role="analyst")
    chart = notebook.new_cell("plot", "terminal", QUESTION, nb["id"], code="chart()")
    chart["status"], chart["outputs"], chart["width"] = "ok", [CHART], 480
    chart["takeaway"] = "[alpha](#) leads on parse."
    table = notebook.new_cell("table", "terminal", "", nb["id"], code="runs")
    table["status"], table["outputs"] = "ok", [{"text/plain": "run  status\nr1   ok"}]
    drawn = notebook.new_cell("plot", "terminal", "Scores as drawn?", nb["id"], code="plt.plot()")
    drawn["status"], drawn["outputs"] = "ok", [{"text/plain": "<Figure>", "image/svg+xml": SVG}]
    raster = notebook.new_cell("plot", "terminal", "Scores as a picture?", nb["id"], code="plt.plot()")
    raster["status"], raster["outputs"] = "ok", [{"image/png": PNG, "application/vnd.vegalite.v5+json": CHART[
        "application/vnd.vegalite.v5+json"]}]
    nb["cells"] += [chart, table, drawn, raster]
    notebook.write_notebook(ws, nb)
    return {"chart": chart["id"], "table": table["id"], "drawn": drawn["id"], "raster": raster["id"]}


@pytest.fixture()
def harness(monkeypatch):
    """The harness on, its pool standing in for the browser: each request it is given, and made-up files."""

    class FakePool:
        requests: list[dict] = []

        async def render(self, request, *, timeout_s=render.RENDER_TIMEOUT_S, still=True):
            self.requests.append(request)
            asked = request.get("files") or []
            return render.Rendered(png=b"made-up png", box={"x": 16, "y": 16, "width": 480, "height": 520},
                                   webp=b"made-up webp" if "webp" in asked else None,
                                   pdf=b"%PDF made-up" if "pdf" in asked else None,
                                   svg="<svg>made-up</svg>" if "svg" in asked else None)

    pool = FakePool()
    FakePool.requests = []
    monkeypatch.setattr(render, "enabled", lambda: True)
    monkeypatch.setattr(render, "down", lambda: False)
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


def test_a_figure_is_a_png_a_webp_and_a_pdf_and_an_svg_only_of_a_chart_drawn_as_vectors(cards, harness):
    ids = lambda cid: [f["id"] for f in card_export.files(cell(cid))]  # noqa: E731
    listed = card_export.files(cell(cards["chart"]))
    assert [f["id"] for f in listed] == ["png", "webp", "pdf", "svg"] and all(f["ok"] for f in listed)
    assert [f["file"] for f in listed] == [f"{STEM}.png", f"{STEM}.webp", f"{STEM}.pdf", f"{STEM}.svg"]
    assert [f["name"] for f in listed] == ["PNG", "WebP", "PDF", "SVG"]
    assert ids(cards["drawn"]) == ["png", "webp", "pdf", "svg"], "a matplotlib figure drawn as SVG"
    # a table has no chart, and a picture the page draws before a chart in its bundle is no SVG
    assert ids(cards["table"]) == ids(cards["raster"]) == ["png", "webp", "pdf"]
    assert card_export.files(cell(cards["table"]))[0]["file"] == f"{cards['table']}.png"
    assert not harness.requests, "the files are listed without drawing"


async def test_without_the_harness_every_file_is_listed_not_ok_with_the_reason(cards):
    listed = card_export.files(cell(cards["chart"]))
    assert [f["id"] for f in listed] == ["png", "webp", "pdf", "svg"]
    assert all(not f["ok"] and f["why"] == "Needs a browser: THIMBLE_RENDER is off" for f in listed)
    r = TestClient(app).get(f"/api/ws/{CORPUS}/cards/{cards['chart']}/figure/png")
    assert r.status_code == 409 and "Needs a browser" in r.json()["detail"]


def test_the_menu_lists_the_files_and_saves_each_by_its_name_from_the_figure_drawn_whole(cards, harness):
    client = TestClient(app)
    base = f"/api/ws/{CORPUS}/cards/{cards['chart']}/figure"
    assert client.get(base).json()["files"][1] == {"id": "webp", "name": "WebP", "ext": "webp", "ok": True}
    r = client.get(f"{base}/webp")
    assert r.status_code == 200 and r.content == b"made-up webp" and r.headers["content-type"] == "image/webp"
    assert r.headers["x-export-name"] == f"{STEM}.webp" and f'filename="{STEM}.webp"' in r.headers["content-disposition"]
    # the card's figure whole (its question, its chart and its takeaway), as wide as the card stands on the canvas, on
    # the export's paper, at two device px per px
    req = harness.requests[-1]
    assert (req["figure"], req["whole"], req["files"], req["width"], req["zoom"]) == (True, True, ["webp"], 480, 1.0)
    assert req["theme"]["paper"] == "neutral"
    assert client.get(f"{base}/png").content == b"made-up png" and "files" not in harness.requests[-1]
    assert client.get(f"{base}/pdf").headers["content-type"] == "application/pdf"
    assert client.get(f"{base}/svg").headers["content-type"].startswith("image/svg+xml")
    # a card at the canvas's own width
    client.get(f"/api/ws/{CORPUS}/cards/{cards['table']}/figure/png")
    assert harness.requests[-1]["width"] == render.CARD_W
    # what the card has not
    assert client.get(f"/api/ws/{CORPUS}/cards/{cards['table']}/figure/svg").status_code == 404
    assert client.get(f"{base}/gif").status_code == 404
    assert client.get(f"/api/ws/{CORPUS}/cards/nosuchid/figure").status_code == 404


async def test_export_card_writes_every_file_into_a_folder_of_the_corpus_from_one_drawing(cards, harness, data_tmp):
    r = await tools.call(CORPUS, "export_card", {"card": f"card:{cards['chart']}"}, actor="analyst")
    assert not r.is_error, r.text
    written = [f"figures/{STEM}.{ext}" for ext in ("png", "webp", "pdf", "svg")]
    assert f"Wrote the figure of card:{cards['chart']}: {', '.join(written)}." in r.text
    assert (data_tmp / CORPUS / "figures" / f"{STEM}.webp").read_bytes() == b"made-up webp"
    assert sorted(p.name for p in (data_tmp / CORPUS / "figures").iterdir()) == sorted(w.split("/")[1] for w in written)
    assert [(q["whole"], q.get("files")) for q in harness.requests] == [(True, ["webp", "pdf", "svg"])]
    r = await tools.call(CORPUS, "export_card", {"card": f"card:{cards['table']}", "folder": "paper/fig"},
                         actor="analyst")
    assert not r.is_error, r.text
    tid = cards["table"]
    assert sorted(p.name for p in (data_tmp / CORPUS / "paper" / "fig").iterdir()) == [f"{tid}.pdf", f"{tid}.png",
                                                                                      f"{tid}.webp"]


async def test_export_card_writes_only_inside_the_corpus_and_never_through_a_link(cards, harness, data_tmp, tmp_path):
    corpus = data_tmp / CORPUS
    before = sorted(p.relative_to(corpus) for p in corpus.rglob("*"))
    card = f"card:{cards['chart']}"
    for folder in ("/tmp/figures", "~/figures", "../figures", "figures/../../out"):
        r = await tools.call(CORPUS, "export_card", {"card": card, "folder": folder}, actor="analyst")
        assert r.is_error and "inside the corpus folder" in r.text, (folder, r.text)
    assert not harness.requests, "nothing is drawn for a call that cannot write"
    outside = tmp_path / "outside"
    outside.mkdir()
    (corpus / "linked").symlink_to(outside, target_is_directory=True)
    r = await tools.call(CORPUS, "export_card", {"card": card, "folder": "linked"}, actor="analyst")
    assert r.is_error and "wrote nothing" in r.text and not any(outside.iterdir())
    (corpus / "linked").unlink()
    r = await tools.call(CORPUS, "export_card", {"card": "card:nosuchid"}, actor="analyst")
    assert r.is_error and "there is no card nosuchid" in r.text
    assert sorted(p.relative_to(corpus) for p in corpus.rglob("*")) == before


async def test_while_read_only_is_on_export_card_writes_nothing_and_says_how_to_turn_it_off_and_the_menu_still_saves(
        cards, harness, data_tmp):
    corpus = data_tmp / CORPUS
    before = sorted(p.relative_to(corpus) for p in corpus.rglob("*"))
    ledger.put_settings(CORPUS, {"corpus_edits": False})
    r = await tools.call(CORPUS, "export_card", {"card": f"card:{cards['chart']}"}, actor="analyst")
    assert r.is_error and f'Settings switch "{runtime_tools.READ_ONLY_SWITCH}" is on' in r.text
    assert "they can turn it off there" in r.text
    assert not harness.requests and sorted(p.relative_to(corpus) for p in corpus.rglob("*")) == before
    # a download writes nothing in the corpus folder, so the card's Export menu still saves the file
    got = TestClient(app).get(f"/api/ws/{CORPUS}/cards/{cards['chart']}/figure/pdf")
    assert got.status_code == 200 and got.content == b"%PDF made-up"
    assert sorted(p.relative_to(corpus) for p in corpus.rglob("*")) == before
    ledger.put_settings(CORPUS, {"corpus_edits": None})
    r = await tools.call(CORPUS, "export_card", {"card": f"card:{cards['chart']}"}, actor="analyst")
    assert not r.is_error and (corpus / "figures" / f"{STEM}.pdf").read_bytes() == b"%PDF made-up"
