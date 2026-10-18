"""A written document exported: Markdown with footnotes, one self-contained HTML file, the formats a report type's
export.py declares, such as the video extension's video file, and PDF and video offered disabled when there is no
browser. No model call and no browser."""
from __future__ import annotations


import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


from app import config, exports, investigation, notebook, report_types, tools

CORPUS = "mini"
MAIN = investigation.MAIN
app = FastAPI()
app.include_router(exports.router, prefix="/api")
BASE = f"/api/ws/{CORPUS}/investigations/{MAIN}/types"


@pytest.fixture()
def report(workspaces_tmp):
    """A report whose two sentences cite a card and a board post, the card cited twice."""
    ws = config.workspace_dir(CORPUS)
    nb = notebook.create_notebook(ws, "Your work", role="analyst")
    cell = notebook.new_cell("code", "terminal", "How many deletions?", nb["id"], code="print(27)")
    cell["status"], cell["outputs"] = "ok", [{"text/plain": "27", "_stream": True}]
    nb["cells"].append(cell)
    notebook.write_notebook(ws, nb)
    return cell["id"]


async def _write(cid: str) -> None:
    text = (f"# One account did it\n\n## What happened\n\nAll [[27|card:{cid}]] deletions came from **one** account. "
            f"It posted first [[board.jsonl#L1]] and again later [[card:{cid}]].\n")
    r = await tools.call(CORPUS, "write_document", {"doc": "report", "text": text}, actor="analyst")
    assert not r.is_error, r.text


def _model() -> dict:
    return exports.read_model(CORPUS, report_types.read_doc(CORPUS, MAIN, "report"), "document")


async def test_markdown_numbers_each_citation_once_as_a_footnote_cards_cite_none(report):
    """The references are true references alone: the corpus's records keep their footnotes; a canvas card, which the
    export's reader cannot reach, adds none."""
    await _write(report)
    md = exports.to_markdown(_model())
    assert "## What happened" in md
    assert "account. It posted first and again later.[^1]" in md
    assert "[^1]: board.jsonl#L1" in md and "forge pr claim" in md.split("[^1]:")[1]
    assert "card:" not in md and "[^2]" not in md


async def test_a_card_a_sentence_reads_as_a_noun_is_exported_as_its_title(report):
    """...a whole card right after a word such as "in"; card refs, a line of one included, add no footnote."""
    text = (f"# Deletions\n\n## Where\n\nThe count is laid out in [[card:{report}]]. "
            f"Every deletion came from one account [[card:{report}]]. "
            f"The first came on May 24, 2026 [[card:{report}@out0#L1]] and the rest by June.\n")
    r = await tools.call(CORPUS, "write_document", {"doc": "report", "text": text}, actor="analyst")
    assert not r.is_error, r.text
    md = exports.to_markdown(_model())
    assert "The count is laid out in “How many deletions?”. Every deletion came from one account." in md
    assert "The first came on May 24, 2026 and the rest by June." in md
    assert "[^" not in md


async def test_html_is_one_file_that_loads_nothing_and_links_each_citation(report):
    await _write(report)
    page = exports.to_html(_model(), {report: {"title": "How many deletions?", "text": "27"}}, faces="")
    assert "<strong>one</strong>" in page
    assert page.count('href="#note-1"') == 1 and 'id="note-1"' in page and 'id="note-2"' not in page
    assert "<link" not in page and 'src="http' not in page and "<script src" not in page


async def test_a_figures_card_is_a_picture_not_a_reference(report):
    """A figure cites its caption's records; the card it shows adds no entry to the references."""
    doc = {"title": "R", "sections": [{"id": "0000a001", "heading": "Where",
           "sentences": [{"id": "0000s001", "text": "See the count. [[board.jsonl#L1]]"}],
           "figures": [{"cell": f"card:{report}", "caption": "The count [[board.jsonl#L1]]"}]}]}
    m = exports.read_model(CORPUS, doc, "document")
    assert m["units"][0]["figures"][0]["notes"] == [1]
    assert [r["label"].split(" (")[0] for r in m["notes"]] == ["board.jsonl#L1"]


async def test_slides_export_lays_each_slide_out_as_the_editor_shows_it(report):
    """The deck's HTML (which the PDF prints) keeps each slide's layout as the editor draws it: the figure's side and
    width, the grid, the quote with its speaker, and only the cards the slide's slots show."""
    doc = {"title": "Deck", "slides": [
        {"id": "a1b2c3d4", "heading": "Side", "layout": "figure", "format": {"side": "left", "width": 30},
         "sentences": [{"id": "0000s001", "text": "One line."}],
         "figures": [{"id": "0000f001", "cell": f"card:{report}", "caption": ""},
                     {"id": "0000f002", "cell": f"card:{report}", "caption": "unseen"}]},
        {"id": "b2c3d4e5", "heading": "Grid", "layout": "figures", "format": {"slots": 4, "grid": True},
         "sentences": [], "figures": [{"id": "0000f003", "cell": f"card:{report}", "caption": ""}]},
        {"id": "c3d4e5f6", "heading": "Said", "layout": "quote", "figures": [],
         "sentences": [{"id": "0000q001", "text": "We saw it happen.", "quote": True, "speaker": "ana"}]},
    ]}
    m = exports.read_model(CORPUS, doc, "slides")
    page = exports.to_html(m, {report: {"title": "How many deletions?", "text": "27"}}, faces="")
    side = page.split('class="slide layout-figure"')[1].split("</section>")[0]
    assert "grid-template-columns:30fr 70fr" in side and side.index('class="slot"') < side.index('class="lines"')
    assert "unseen" not in page  # the slide's one slot shows one card; the rest stay unseen, as on screen
    grid = page.split('class="slide layout-figures"')[1].split("</section>")[0]
    assert "repeat(2,minmax(0,1fr))" in grid and grid.count('class="slot"') == 4
    quote = page.split('class="slide layout-quote"')[1].split("</section>")[0]
    assert "We saw it happen." in quote.split("<blockquote")[1] and "— ana" in quote
    assert page.count("We saw it happen.") == 1  # the quote stands in the quote cell, not among the lines
    md = exports.to_markdown(m)
    assert "> We saw it happen." in md and "> — ana" in md


async def test_routes_offer_the_formats_and_save_markdown_as_a_file(report, monkeypatch):
    await _write(report)
    monkeypatch.setattr(exports, "browser", lambda: ("off", "the browser is off in thimble's config"))
    got = TestClient(app).get(f"{BASE}/report/exports").json()["formats"]
    by = {f["id"]: f for f in got}
    assert [f["id"] for f in got] == ["markdown", "html", "pdf"]
    assert by["html"]["ok"] and not by["pdf"]["ok"] and "browser is off" in by["pdf"]["why"]
    r = TestClient(app).get(f"{BASE}/report/export/markdown")
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/markdown")
    assert 'filename="One-account-did-it.md"' in r.headers["content-disposition"] and r.text.startswith("# One account")
    assert TestClient(app).get(f"{BASE}/report/export/pdf").status_code == 409
    assert TestClient(app).get(f"{BASE}/report/export/video").status_code == 404
