"""A written document exported: Markdown with footnotes, one self-contained HTML file set as the report is on the page,
PDF and slides offered disabled when there is no browser, and slides as a .pptx of one slide per section. No model call
and no browser: the card harness's pictures are faked."""
from __future__ import annotations

import base64
import io
import re
import zipfile
import xml.etree.ElementTree as ET

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import config, exports, investigation, notebook, render, tools

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


async def test_a_written_document_exports_as_markdown_with_footnotes_and_as_one_html_file_that_loads_nothing(
        report, monkeypatch):
    await _write(report)
    monkeypatch.setattr(exports, "browser", lambda: ("off", "the browser is off in thimble's config"))
    client = TestClient(app)
    by = {f["id"]: f for f in client.get(f"{BASE}/report/exports").json()["formats"]}
    assert by["markdown"]["ok"] and by["html"]["ok"] and not by["pdf"]["ok"], "PDF needs the browser"
    r = client.get(f"{BASE}/report/export/markdown")
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/markdown")
    assert 'filename="One-account-did-it.md"' in r.headers["content-disposition"] and r.text.startswith("# One account")
    assert "account.[^1] It posted first and again later.[^2][^1]" in r.text
    assert f"[^1]: card:{report}" in r.text and "[^2]: board.jsonl#L1" in r.text
    r = client.get(f"{BASE}/report/export/html")
    assert r.status_code == 200 and "<strong>one</strong>" in r.text
    assert r.text.count('href="#note-1"') == 2 and 'id="note-2"' in r.text
    assert "<link" not in r.text and 'src="http' not in r.text and "<script src" not in r.text


PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==")
NS = {"a": "http://schemas.openxmlformats.org/drawingml/2006/main",
      "p": "http://schemas.openxmlformats.org/presentationml/2006/main"}


@pytest.fixture()
def chart(workspaces_tmp):
    """A card that draws a chart, as a figure needs."""
    ws = config.workspace_dir(CORPUS)
    nb = notebook.create_notebook(ws, "Your work", role="analyst")
    cell = notebook.new_cell("code", "terminal", "When were the pages deleted?", nb["id"], code="chart()")
    cell["status"], cell["outputs"] = "ok", [{"image/png": base64.b64encode(PNG).decode("ascii")}]
    cell["takeaway"] = "All [27](#) deletions came within one hour."
    nb["cells"].append(cell)
    notebook.write_notebook(ws, nb)
    return cell["id"]


@pytest.fixture()
def harness(monkeypatch):
    """A browser to export with, and a card harness that draws each figure's art as a picture twice as wide as tall,
    recording the width each card's art was laid out at."""
    asked: list[tuple[str, int]] = []

    async def render_figure(c, cell, *, width, zoom=1.0, timeout_s=0):
        asked.append((cell["id"], width))
        return render.Rendered(png=PNG, box={"x": 0, "y": 0, "width": width * zoom, "height": width * zoom / 2})

    monkeypatch.setattr(exports, "browser", lambda: ("bundled", ""))
    monkeypatch.setattr(render, "render_figure", render_figure)
    return asked


async def _write_with_figure(cid: str) -> None:
    text = (f"# One account deleted the audit pages\n\n"
            f"All [[27|card:{cid}]] deletions came from one account. It posted first [[board.jsonl#L1]].\n\n"
            f"## The deletions came within one hour\n\n"
            f"The account deleted every page within an hour [[card:{cid}]]. Nobody restored them.\n\n"
            f"A second paragraph opens here. Its second sentence stays in the notes.\n\n"
            f"![The deletions by hour](card:{cid})\n\n"
            f"## What is left open\n\n"
            f"1. Why the account did it. Nobody asked.\n2. Whether it acted alone.\n")
    r = await tools.call(CORPUS, "write_document", {"doc": "report", "text": text}, actor="analyst")
    assert not r.is_error, r.text


async def test_the_html_and_pdf_set_each_figure_as_the_page_shows_it_and_keep_a_heading_with_what_follows(chart, harness):
    await _write_with_figure(chart)
    client = TestClient(app)
    r = client.get(f"{BASE}/report/export/html")
    assert r.status_code == 200
    html = r.text
    # the figure is its card's question, its art drawn as the report's figure draws it, and its caption once
    fig = re.search(r'<figure id="card-[0-9a-f]{8}">(.*?)</figure>', html, re.S).group(1)
    assert '<div class="fig-q">When were the pages deleted?</div>' in fig
    assert re.search(rf'<img alt="When were the pages deleted\?" width="{exports.FIGURE_W}" height="\d+" src="data:image/png', fig)
    assert fig.count("The deletions by hour") == 1 and "within one hour" not in fig, "the takeaway is not drawn twice"
    assert harness == [(chart, exports.FIGURE_W)]
    # in print a heading stays with what follows it, a figure is never split and its art is never taller than a page; a
    # numbered list keeps its numbers
    assert "h1,h2,h3,h4{break-after:avoid}" in html and "figure{margin:18px 0 22px;break-inside:avoid}" in html
    assert "figure img{max-height:230mm;width:auto}" in html
    assert "<ol><li>Why the account did it. Nobody asked.</li><li>Whether it acted alone.</li></ol>" in html


async def test_a_report_exports_as_slides_one_per_section_with_its_figure_and_its_text_in_the_notes(chart, harness):
    await _write_with_figure(chart)
    client = TestClient(app)
    by = {f["id"]: f for f in client.get(f"{BASE}/report/exports").json()["formats"]}
    assert by["pptx"] == {"id": "pptx", "name": "Slides", "ext": "pptx", "ok": True}
    r = client.get(f"{BASE}/report/export/pptx")
    assert r.status_code == 200 and r.headers["content-type"].startswith("application/vnd.openxmlformats-officedocument.presentationml")
    assert 'filename="One-account-deleted-the-audit-pages.pptx"' in r.headers["content-disposition"]
    z = zipfile.ZipFile(io.BytesIO(r.content))
    for name in z.namelist():  # every part a viewer reads is well-formed
        if name.endswith((".xml", ".rels")):
            ET.fromstring(z.read(name))
    types = z.read("[Content_Types].xml").decode()
    slides = [n for n in z.namelist() if re.fullmatch(r"ppt/slides/slide\d+\.xml", n)]
    assert len(slides) == 3 and all(f'PartName="/{n}"' in types for n in slides), "the title, then one per section"

    def texts(name: str) -> list[str]:
        """Each paragraph's words, without the mark of a sentence no check verified (no checker runs here)."""
        root = ET.fromstring(z.read(name))
        return ["".join(t.text or "" for t in p.iter(f"{{{NS['a']}}}t")).replace(" [unverified]", "")
                for p in root.iter(f"{{{NS['a']}}}p")]

    # the title slide holds the title and the opening section's lead
    assert texts("ppt/slides/slide1.xml")[:2] == ["One account deleted the audit pages",
                                                   "All 27 deletions came from one account."]
    # a section's slide: its heading, the first sentence of each paragraph, its figure's question, picture and caption
    two = texts("ppt/slides/slide2.xml")
    assert two[:3] == ["The deletions came within one hour", "The account deleted every page within an hour.",
                       "A second paragraph opens here."]
    assert "When were the pages deleted?" in two and "The deletions by hour" in two
    assert b"<p:pic>" in z.read("ppt/slides/slide2.xml") and z.read("ppt/media/image1.png") == PNG
    assert "../media/image1.png" in z.read("ppt/slides/_rels/slide2.xml.rels").decode()
    # its notes hold the section's whole text; a list's items keep their numbers on the slide
    assert "Its second sentence stays in the notes." in " ".join(texts("ppt/notesSlides/notesSlide2.xml"))
    assert texts("ppt/slides/slide3.xml")[1:] == ["Why the account did it.", "Whether it acted alone."]
    assert b'<a:buAutoNum type="arabicPeriod"/>' in z.read("ppt/slides/slide3.xml")
    # a chart is laid out narrower for a slide, so its labels read larger there
    assert harness == [(chart, 480)]


async def test_slides_need_the_browser_and_say_what_stops_the_pictures(chart, monkeypatch):
    await _write_with_figure(chart)
    client = TestClient(app)
    monkeypatch.setattr(exports, "browser", lambda: ("off", "no browser is installed"))
    by = {f["id"]: f for f in client.get(f"{BASE}/report/exports").json()["formats"]}
    assert not by["pptx"]["ok"] and by["pptx"]["why"] == "Needs a browser: no browser is installed"
    # a browser, but a card harness whose Chromium is missing: the slides are refused with the command that fetches it
    monkeypatch.setattr(exports, "browser", lambda: ("bundled", ""))

    async def missing(*a, **k):
        raise render.Unavailable(exports.headless.NOT_INSTALLED)

    monkeypatch.setattr(render, "render_figure", missing)
    r = client.get(f"{BASE}/report/export/pptx")
    assert r.status_code == 409
    assert "the headless Chromium is not installed. Fetch it: " in r.json()["detail"]
