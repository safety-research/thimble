"""A written document exported: Markdown with footnotes, one self-contained HTML file, and PDF offered disabled when
there is no browser. No model call and no browser."""
from __future__ import annotations

import json
import re

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import config, exports, frames, investigation, notebook, tools

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


# --------------------------------------------------------------------------- the figure styles

CHART = {"application/vnd.vegalite.v5+json": {"mark": "bar", "data": {"values": [{"day": "Mon", "runs": 3}]},
                                               "encoding": {"x": {"field": "day"}, "y": {"field": "runs"}}}}


@pytest.fixture()
def figures(workspaces_tmp):
    """Two cards that draw a chart, made up: a report's figures."""
    ws = config.workspace_dir(CORPUS)
    nb = notebook.create_notebook(ws, "Your work", role="analyst")
    ids = []
    for question, takeaway in (("Which day has the most runs?", "Monday has the most runs."),
                               ("How long is a run?", "A run takes four minutes?")):
        cell = notebook.new_cell("code", "terminal", question, nb["id"], code="chart()")
        cell["status"], cell["outputs"], cell["takeaway"] = "ok", [CHART], takeaway
        nb["cells"].append(cell)
        ids.append(cell["id"])
    notebook.write_notebook(ws, nb)
    return ids


@pytest.fixture()
def harness(monkeypatch):
    """The card harness stood in for: each picture asked of it as (call, card id, takeaway, style, part, columns), a
    made-up picture back, and a legend that draws nothing for a card whose question names no groups."""
    from app import render

    calls: list[tuple] = []

    async def render_card(c, cell, **kw):
        calls.append(("card", cell["id"], cell.get("takeaway"), None, None, None))
        return render.Rendered(png=b"card", box={"width": 720, "height": 400})

    async def render_figure(c, cell, *, style=None, part="figure", columns=None, **kw):
        calls.append(("figure", cell["id"], cell.get("takeaway"), style, part, columns))
        empty = part == "legend" and "day" not in str(cell.get("title"))
        width = {"blog": 800, "paper": 240}[style] if part == "figure" else 120
        return render.Rendered(png=b"figure", box={"width": width, "height": 200}, empty=empty)

    monkeypatch.setattr(render, "render_card", render_card)
    monkeypatch.setattr(render, "render_figure", render_figure)
    monkeypatch.setattr(exports, "browser", lambda: ("system", "/usr/bin/made-up-chromium"))
    return calls


async def _write_figures(a: str, b: str) -> None:
    """A report with a figure of card `a` after its first paragraph, captioned, and one of card `b` after its second,
    written without a caption. Its text cites card `b`."""
    text = (f"# Runs over the week\n\n## When runs happen\n\nRuns peak early in the week [[card:{b}]].\n\n"
            f"![Most runs come on [[Monday|card:{a}]].](card:{a})\n\nThey are short.\n\n![](card:{b})\n")
    r = await tools.call(CORPUS, "write_document", {"doc": "report", "text": text}, actor="analyst")
    assert not r.is_error, r.text


async def test_a_blog_export_draws_each_figure_as_a_blog_figure_whose_headline_is_its_caption(figures, harness):
    a, b = figures
    await _write_figures(a, b)
    r = TestClient(app).get(f"{BASE}/report/export/html?figures=blog")
    assert r.status_code == 200
    html = r.text
    assert "--font-body:'DM Sans'" in html and "h1::before" in html and "'Hanken Grotesk',system-ui" in html
    assert html.count('class="fig-blog"') == 2 and 'width="800"' in html
    # the caption is the headline, in plain words; a figure written without one, whose caption is its card's question,
    # is headed by its card's takeaway
    assert ("figure", a, "Most runs come on Monday.", "blog", "figure", None) in harness
    assert ("figure", b, "A run takes four minutes?", "blog", "figure", None) in harness
    assert not [c for c in harness if c[0] == "card"]
    assert 'alt="Most runs come on Monday."' in html and "Figure 1." not in html
    # a Blog figure cites nothing, as a post's figures do not: the notes are the text's citations alone
    assert "<figcaption>" not in html and html.count('<li id="note-') == 1 and f"card:{b}</span>" in html


async def test_a_paper_export_numbers_each_figure_and_puts_its_legend_and_caption_under_the_chart(figures, harness):
    a, b = figures
    await _write_figures(a, b)
    html = TestClient(app).get(f"{BASE}/report/export/html?figures=paper").text
    assert "--font-body:'Source Serif 4'" in html and "text-align:justify" in html
    assert ("figure", a, "Monday has the most runs.", "paper", "figure", None) in harness
    assert ("figure", a, "Monday has the most runs.", "paper", "legend", 2) in harness
    # a chart with no legend of colors gets no legend under it
    assert html.count('class="fig-legend"') == 1
    first = html.index('<span class="fig-n">Figure 1.</span> <strong>Most runs come on Monday.</strong> Which day has')
    second = html.index('<span class="fig-n">Figure 2.</span> <strong>A run takes four minutes?</strong> How long is')
    assert html.index("Runs peak early") < first < html.index("They are short") < second
    assert html.count('class="fig-paper"') == 2


async def test_a_figure_that_leads_its_section_comes_first_and_takes_the_first_number_as_on_the_page(
        figures, harness, monkeypatch):
    from app import report_types

    a, b = figures
    await _write_figures(a, b)
    read = report_types.read_doc

    def led(*args):
        doc = read(*args)
        for f in doc["sections"][0]["figures"]:
            if f["cell"] == f"card:{b}":
                f["lead"], f["after_paragraph"] = True, None
        return doc

    monkeypatch.setattr(report_types, "read_doc", led)
    html = TestClient(app).get(f"{BASE}/report/export/html?figures=paper").text
    assert html.index("Figure 1.</span> <strong>A run takes") < html.index("Runs peak early") < html.index("Figure 2.")


async def test_the_export_takes_the_reported_figure_style_when_it_names_none_and_markdown_is_the_same_in_every_style(
        figures, harness):
    from app import render

    a, b = figures
    await _write_figures(a, b)
    client = TestClient(app)
    thimble = client.get(f"{BASE}/report/export/html").text
    assert [c[0] for c in harness] == ["card", "card"] and 'class="fig-' not in thimble
    theme = {"paper": "warm", "accent": "iris", "figures": "paper"}
    (config.workspace_dir(CORPUS) / render.THEMES_FILE).write_text(json.dumps(theme))
    assert "Figure 2." in client.get(f"{BASE}/report/export/html").text
    assert 'class="fig-' not in client.get(f"{BASE}/report/export/html?figures=thimble").text
    # a style the server does not know is thimble's
    assert 'class="fig-' not in client.get(f"{BASE}/report/export/html?figures=neon").text
    md = {s: client.get(f"{BASE}/report/export/markdown?figures={s}").text for s in ("thimble", "blog", "paper")}
    assert md["blog"] == md["thimble"] == md["paper"] and "Figure 1." not in md["blog"]


async def test_a_table_cards_paper_figure_is_its_table_set_as_text_over_its_caption(workspaces_tmp, harness):
    ws = config.workspace_dir(CORPUS)
    nb = notebook.create_notebook(ws, "Your work", role="analyst")
    cell = notebook.new_cell("code", "terminal", "What does a gift box add?", nb["id"], code="table()")
    cell["status"], cell["takeaway"] = "ok", "A gift box adds 6.00."
    cell["outputs"] = [{frames.FRAME_MIME: {"columns": ["item", "price"], "rows": [["Tin", 48], ["Tin in a box", 54]]}}]
    nb["cells"].append(cell)
    notebook.write_notebook(ws, nb)
    text = f"# Prices\n\n## Boxes\n\nA box costs more.\n\n![](card:{cell['id']})\n"
    r = await tools.call(CORPUS, "write_document", {"doc": "report", "text": text}, actor="analyst")
    assert not r.is_error, r.text
    html = TestClient(app).get(f"{BASE}/report/export/html?figures=paper").text
    assert not harness, "a table is no picture in Paper"
    assert '<div class="fig-table"><table>' in html and "<td>Tin in a box</td>" in html
    assert '<span class="fig-n">Figure 1.</span> <strong>A gift box adds 6.00.</strong> What does a gift box add?' in html


def test_a_paper_caption_says_the_number_the_takeaway_in_bold_with_one_stop_and_the_question():
    assert exports.paper_caption(2, "Most runs end early.", "When do runs end?") == (
        '<span class="fig-n">Figure 2.</span> <strong>Most runs end early.</strong> When do runs end?')
    assert "<strong>Do runs end early?</strong>" in exports.paper_caption(1, "Do runs end early?", "")
    assert "<strong>Most end <code>early</code>.</strong>" in exports.paper_caption(1, "Most end `early`", "")
    assert exports.paper_caption(3, "", "When do runs end?") == '<span class="fig-n">Figure 3.</span> When do runs end?'


def test_each_style_inlines_its_own_faces(tmp_path, monkeypatch):
    font = tmp_path / "frontend" / "node_modules" / "@fontsource"
    for pkg, name in (("hanken-grotesk", "hanken-grotesk-latin-400-normal"), ("dm-sans", "dm-sans-latin-700-normal"),
                      ("source-serif-4", "source-serif-4-latin-400-normal"), ("geist-mono", "geist-mono-latin-400-normal")):
        (font / pkg / "files").mkdir(parents=True, exist_ok=True)
        (font / pkg / "files" / f"{name}.woff2").write_bytes(b"made-up face")
    monkeypatch.setattr(config, "REPO_ROOT", tmp_path)
    monkeypatch.setattr(config, "FRONTEND_DIST", tmp_path / "dist")
    monkeypatch.setattr(exports, "Path", lambda *a: tmp_path / "no-fonts" / "x.py")
    family = lambda style: set(re.findall(r"font-family:'([^']+)'", exports.font_faces(style)))  # noqa: E731
    assert family("thimble") == {"Hanken Grotesk", "Geist Mono"}
    assert family("blog") == {"DM Sans", "Source Serif 4", "Geist Mono"}
    assert family("paper") == {"Source Serif 4", "Geist Mono"}
