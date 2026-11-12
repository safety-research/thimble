"""A written document exported: Markdown, one self-contained HTML file set as the report is on the page, PDF offered
disabled when there is no browser, and the page a Claude artifact publishes, in claude.ai's rules for one. Each holds the
report's text and figures alone, unless the Export menu asks for its citations (footnotes, numbered notes) or its
comments (each after its passage). No model call and no browser: the card harness's pictures and the PDF are faked."""
from __future__ import annotations

import base64
import re
from html.parser import HTMLParser

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import config, exports, investigation, notebook, render, report_types, tools

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


async def test_a_written_document_exports_with_its_citations_as_markdown_footnotes_and_as_one_html_file_that_loads_nothing(
        report, monkeypatch):
    await _write(report)
    monkeypatch.setattr(exports, "browser", lambda: ("off", "the browser is off in thimble's config"))
    client = TestClient(app)
    by = {f["id"]: f for f in client.get(f"{BASE}/report/exports").json()["formats"]}
    assert list(by) == ["markdown", "html", "pdf", "artifact"], "no slides"
    assert by["markdown"]["ok"] and by["html"]["ok"] and not by["pdf"]["ok"], "PDF needs the browser"
    assert by["artifact"] == {"id": "artifact", "name": "Claude artifact", "ext": "html", "note": "link", "ok": True}
    # a page, whose HTML is its own, offers no Claude artifact
    assert [f["id"] for f in exports.formats({"renderer": "custom"})] == ["markdown", "html", "pdf"]
    r = client.get(f"{BASE}/report/export/markdown?citations=true")
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/markdown")
    assert 'filename="One-account-did-it.md"' in r.headers["content-disposition"] and r.text.startswith("# One account")
    assert "account.[^1] It posted first and again later.[^2][^1]" in r.text
    assert f"[^1]: card:{report}" in r.text and "[^2]: board.jsonl#L1" in r.text
    r = client.get(f"{BASE}/report/export/html?citations=true")
    assert r.status_code == 200 and "<strong>one</strong>" in r.text
    assert r.text.count('href="#note-1"') == 2 and 'id="note-2"' in r.text
    assert "<link" not in r.text and 'src="http' not in r.text and "<script src" not in r.text


PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==")
DARK_PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==")


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
    recording the width each card's art was laid out at and the paper it was drawn on."""
    asked: list[tuple[str, int, str]] = []

    async def render_figure(c, cell, *, width, zoom=1.0, paper="neutral", timeout_s=0):
        asked.append((cell["id"], width, paper))
        return render.Rendered(png=DARK_PNG if paper == "dark" else PNG,
                               box={"x": 0, "y": 0, "width": width * zoom, "height": width * zoom / 2})

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
    assert harness == [(chart, exports.FIGURE_W, "neutral")]
    # in print a heading stays with what follows it, a figure is never split and its art is never taller than a page; a
    # numbered list keeps its numbers
    assert "h1,h2,h3,h4{break-after:avoid}" in html and "figure{margin:18px 0 22px;break-inside:avoid}" in html
    assert "figure img{max-height:230mm;width:auto}" in html
    assert "<ol><li>Why the account did it. Nobody asked.</li><li>Whether it acted alone.</li></ol>" in html


async def _comment_on(cid: str) -> dict:
    """The report _write_with_figure wrote, with the comments the margin shows, one of each kind, and two it does not, a
    resolved one and one of a check that is off; and the citation check's mark on a sentence nothing shows."""
    doc = report_types.read_doc(CORPUS, MAIN, "report")
    sections = doc["sections"]
    first = sections[0]["paragraphs"][0]["sentences"]
    hour = next(u for u in sections if u.get("heading") == "The deletions came within one hour")
    second = hour["paragraphs"][1]["sentences"]
    for x in first:
        x["tags"] = ["unverified"] if x is first[1] else []
    base = {"ts": "2026-03-12T10:00:00+00:00", "generation": 1, "status": "open"}
    doc["comments"] = [
        {**base, "id": "c1", "sentence_id": first[0]["id"], "author": "check", "check": "heads-up", "run": "r1",
         "text": "The 27 counts deletions of [[27|card:%s]] pages, not of files." % cid,
         "details": "The card counts each page once.\n\n- It reads the audit log\n- It skips the restores"},
        {**base, "id": "c2", "sentence_id": hour["id"], "author": "analyst", "text": "Say which hour."},
        {**base, "id": "c3", "sentence_id": second[0]["id"], "paragraph": True, "author": "claude",
         "text": "This paragraph repeats the opening."},
        {**base, "id": "c4", "sentence_id": first[0]["id"], "author": "check", "check": "judgment", "run": "r2",
         "text": "A judgment call that is off."},
        {**base, "id": "c5", "sentence_id": first[0]["id"], "author": "analyst", "status": "dismissed",
         "text": "A comment the analyst resolved."},
    ]
    report_types.write_doc(CORPUS, MAIN, "report", doc)
    return doc


@pytest.fixture()
def printed(monkeypatch) -> list[str]:
    """The HTML each PDF export prints, with the browser's print faked."""
    got: list[str] = []

    async def print_pdf(html_text: str) -> bytes:
        got.append(html_text)
        return b"%PDF-1.7 made up"

    monkeypatch.setattr(exports, "print_pdf", print_pdf)
    return got


COMMENT_WORDS = ("pages, not of files", "Say which hour", "repeats the opening", "judgment call", "resolved")


async def test_by_default_an_export_holds_the_report_s_text_and_figures_alone_in_every_format(chart, harness, printed):
    await _write_with_figure(chart)
    await _comment_on(chart)
    client = TestClient(app)
    md = client.get(f"{BASE}/report/export/markdown").text
    assert "All 27 deletions came from one account. It posted first.\n" in md
    assert "*Figure: The deletions by hour*\n" in md
    html = client.get(f"{BASE}/report/export/html").text
    assert client.get(f"{BASE}/report/export/pdf").content == b"%PDF-1.7 made up"
    page = client.get(f"{BASE}/report/export/artifact").text
    for text in (html, printed[0], page):
        assert "<p>All 27 deletions came from one account. It posted first.</p>" in text
        assert "<figcaption><span>The deletions by hour</span></figcaption>" in text and "<img " in text
        assert 'class="cite"' not in text.split("</style>")[-1] and "Sources" not in text and "note-" not in text
        assert 'class="cm' not in text.split("</style>")[-1]
    for text in (md, html, printed[0], page):
        assert "[^" not in text and "[unverified]" not in text
        assert not [w for w in COMMENT_WORDS if w in text]


async def test_asked_for_them_an_export_has_its_citations_and_each_comment_the_page_shows_after_its_passage(
        chart, harness, printed):
    await _write_with_figure(chart)
    await _comment_on(chart)
    client = TestClient(app)
    # Markdown: the footnotes, and each comment a quote under its passage, named by its check or by who left it
    md = client.get(f"{BASE}/report/export/markdown?citations=true&comments=true").text
    assert ("All 27 deletions came from one account.[^1] It posted first. [unverified][^2]\n\n"
            "> **Heads up:** The 27 counts deletions of 27 pages, not of files.\n>\n> The card counts each page once.\n>\n"
            "> - It reads the audit log\n> - It skips the restores\n\n") in md
    assert "## The deletions came within one hour\n\n> **Comment:** Say which hour.\n\n" in md
    assert "Its second sentence stays in the notes.\n\n> **Claude:** This paragraph repeats the opening.\n\n" in md
    assert f"[^1]: card:{chart}" in md and "[^2]: board.jsonl#L1" in md
    # a resolved comment and the comment of a check that is off stay out
    assert "judgment call" not in md and "resolved" not in md
    # HTML and PDF: the notes, each comment after its passage beside a rule in its check's color, and the passage tinted
    html = client.get(f"{BASE}/report/export/html?citations=true&comments=true").text
    client.get(f"{BASE}/report/export/pdf?citations=true&comments=true")
    for text in (html, printed[0]):
        orange = "#d0750a"  # Heads up's color (prompts/checks/heads-up.md), palette place 2 on white
        assert (f'<p><span class="cm-on" style="--cm:{orange}">All 27 deletions came from one account.'
                '<sup class="cite"><a href="#note-1">1</a></sup></span> It posted first.') in text
        assert (f'</p><aside class="cm" style="--cm:{orange}"><div><div class="cm-name">Heads up</div>'
                '<p>The 27 counts deletions of 27 pages, not of files.</p><p class="cm-more">The card counts each page once.</p>'
                '<ul class="cm-more"><li>It reads the audit log</li><li>It skips the restores</li></ul></div></aside>') in text
        assert ('<h2><span class="cm-on" style="--cm:#a09c93">The deletions came within one hour</span></h2>'
                '<aside class="cm" style="--cm:#a09c93"><div><div class="cm-name">Comment</div>') in text
        # a comment on a whole paragraph tints all of it, as one passage
        assert ('<p><span class="cm-on" style="--cm:#a09c93">A second paragraph opens here. Its second sentence stays in '
                'the notes.</span></p>') in text
        assert '<section class="notes"><h2>Sources</h2>' in text and ".cm{display:flex" in text
        assert "judgment call" not in text and "resolved" not in text
    # each alone: the citations with no comment, or the comments with no citation
    only = client.get(f"{BASE}/report/export/markdown?citations=true").text
    assert "[^1]" in only and "> **" not in only
    only = client.get(f"{BASE}/report/export/markdown?comments=true").text
    assert "[^" not in only and "[unverified]" not in only and "> **Heads up:**" in only


# what a claude.ai artifact may load (the Artifact tool's page contract): stylesheets from Google Fonts with the font
# files they pull, and scripts from these hosts; everything else is inline
STYLE_HOSTS = ("https://fonts.googleapis.com/",)
SCRIPT_HOSTS = ("https://cdnjs.cloudflare.com/", "https://cdn.jsdelivr.net/npm/", "https://unpkg.com/",
                "https://cdn.tailwindcss.com/", "https://code.jquery.com/")
CSS_URL_RE = re.compile(r"url\(\s*['\"]?([^'\")]*)|@import\s+['\"]([^'\"]+)")


class Loads(HTMLParser):
    """What a page loads: (what, address) of each script, stylesheet, picture, frame and media it names, and of each
    url() and @import of its styles; and the skeleton tags it has of its own."""

    def __init__(self) -> None:
        super().__init__()
        self.loads: list[tuple[str, str]] = []
        self.skeleton: list[str] = []
        self._style = False

    def handle_decl(self, decl: str) -> None:
        self.skeleton.append(f"<!{decl}>")

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        a = {k: v or "" for k, v in attrs}
        if tag in ("html", "head", "body"):
            self.skeleton.append(f"<{tag}>")
        self._style = tag == "style"
        for key in ("src", "href", "data", "poster", "srcset"):
            if a.get(key) and not (tag == "a" and key == "href"):  # a link the reader follows loads nothing
                self.loads.append((tag, a[key].split()[0]))
        self.loads += [("style", u) for m in CSS_URL_RE.finditer(a.get("style", "")) for u in m.groups() if u]

    def handle_endtag(self, tag: str) -> None:
        self._style = False if tag == "style" else self._style

    def handle_data(self, data: str) -> None:
        if self._style:
            self.loads += [("css", u) for m in CSS_URL_RE.finditer(data) for u in m.groups() if u]


def artifact_rules(page: str) -> list[str]:
    """The rules of a claude.ai artifact's page the page breaks: it loads only what the hosts above serve and data URLs,
    has no skeleton of its own, names itself in its first 8 KB, defines its colors as light tokens that both dark blocks
    redefine, sets the body's background from a token, keeps the side gutter it promises, and stays under 16 MB."""
    seen = Loads()
    seen.feed(page)
    broken = [f"loads {what} {url}" for what, url in seen.loads
              if not url.startswith(("data:", "#"))
              and not (what == "link" and url.startswith(STYLE_HOSTS))
              and not (what == "script" and url.startswith(SCRIPT_HOSTS))]
    broken += [f"has its own {tag}" for tag in seen.skeleton]
    if not re.search(r"<title>[^<]+</title>", page[:8192]):
        broken.append("no title in its first 8 KB")
    css = "".join(re.findall(r"<style>(.*?)</style>", page, re.S))
    if not re.search(r":root\{[^}]*--paper:", css):
        broken.append("no light tokens on :root")
    if '@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){' not in css or ':root[data-theme="dark"]{' not in css:
        broken.append("no dark tokens for the system's dark scheme and for a dark choice")
    if css.count("color-scheme:dark") < 2:
        broken.append("the dark blocks leave color-scheme light")
    if not re.search(r"body\{[^}]*background:var\(--", css):
        broken.append("the body's background is no token")
    gutter = ("padding-left:max(16px,env(safe-area-inset-left,0px))" in css
              and "padding-right:max(16px,env(safe-area-inset-right,0px))" in css)
    if gutter != ('<meta name="claude:viewport-fit-sides" content="cover">' in page):
        broken.append("the side gutter and its promise do not go together")
    if len(page.encode()) > 16 * 1024 * 1024:
        broken.append("over 16 MB")
    return broken


def test_the_rules_find_what_an_artifact_may_not_load():
    """The check above finds a page's loads from elsewhere and its own skeleton, so a page that passes it loads none."""
    bad = ('<!doctype html><html><head><link rel="stylesheet" href="https://example.test/a.css"></head><body>'
           '<img src="https://example.test/a.png"><script src="https://example.test/a.js"></script>'
           '<style>p{background:url(https://example.test/b.png)}@import "https://example.test/c.css";</style>'
           '<a href="https://example.test/">a link</a></body></html>')
    got = artifact_rules(bad)
    assert {"loads link https://example.test/a.css", "loads img https://example.test/a.png",
            "loads script https://example.test/a.js", "loads css https://example.test/b.png",
            "loads css https://example.test/c.css", "has its own <!doctype html>", "has its own <html>",
            "has its own <head>", "has its own <body>"} <= set(got)
    assert not any("example.test/\"" in g or g.endswith("example.test/") for g in got), "a link loads nothing"


async def test_a_claude_artifact_s_page_keeps_claude_ai_s_rules_and_draws_each_figure_in_both_themes(chart, harness):
    await _write_with_figure(chart)
    await _comment_on(chart)
    client = TestClient(app)
    r = client.get(f"{BASE}/report/export/artifact?citations=true&comments=true")
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/html")
    assert 'filename="One-account-deleted-the-audit-pages.artifact.html"' in r.headers["content-disposition"]
    page = r.text
    assert artifact_rules(page) == []
    assert page.startswith('<meta charset="utf-8">')
    assert "<title>One account deleted the audit pages</title>" in page[:8192]
    # the report as the HTML sets it: its sections, its notes, its comments and its figure, the art drawn on each paper
    # and shown in its theme, and each comment's color on each paper
    assert ">The deletions came within one hour</span></h2>" in page and 'id="note-2"' in page
    assert '<aside class="cm" style="--cm-light:#d0750a;--cm-dark:#da7306">' in page
    assert ':root[data-theme="dark"] :is(.cm,.cm-on){--cm:var(--cm-dark)}' in page
    assert sorted(harness) == [(chart, exports.FIGURE_W, "dark"), (chart, exports.FIGURE_W, "neutral")]
    fig = re.search(r'<figure id="card-[0-9a-f]{8}">(.*?)</figure>', page, re.S).group(1)
    light = re.search(r'<img class="art-light" [^>]*src="data:image/png;base64,([^"]+)"', fig).group(1)
    dark = re.search(r'<img class="art-dark" [^>]*src="data:image/png;base64,([^"]+)"', fig).group(1)
    assert base64.b64decode(light) == PNG and base64.b64decode(dark) == DARK_PNG
    assert ".art-light{display:var(--art-light)}" in page and ".art-dark{display:var(--art-dark)}" in page
    # its faces inlined, as the HTML's are
    assert "@font-face{font-family:'Hanken Grotesk'" in page and "src:url(data:font/" in page

