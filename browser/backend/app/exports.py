"""A written document exported as a file: Markdown, HTML or PDF.

Every format starts from one reading of the document (read_model): its title, units (a report's sections), their
figures and the citations, numbered in order of first use;
a card a sentence names as a noun is written as the card's title (report_types.card_nouns).
Markdown writes the citations as footnotes; HTML is one self-contained file (fonts, pictures and styles inlined) with
the citations as numbered notes linked from the text; PDF is that HTML printed by the browser.

HTML and PDF are drawn in a figure style (render.FIGURES), the page's (frontend lib/theme FigureStyle, report.css):
thimble's own, each figure the card as the canvas draws it; Blog (blogpost-figure's), the text in DM Sans under an
accent bar, each figure the card as a Blog figure headed by its caption, citing nothing, as a post's figures do not;
Paper (paper-figure's), the text in Source Serif 4, each figure the chart with its legend under it and the caption
`Figure N. Takeaway. Question`. Markdown is the same in every style.

The browser: the one thimble's config names (userconf.browser): the system's Chrome, Edge or Chromium, else Playwright's
own Chromium when it is installed. Pictures of cards come from the card harness (render.py); without a browser a card is
its title, its table or its text, and PDF is offered disabled with the reason.
"""
from __future__ import annotations

import asyncio
import base64
import contextlib
import html as _html
import itertools
import logging
import os
import re
from pathlib import Path
from typing import Any, AsyncIterator, Iterator

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response

from . import config, frames, headless, investigation, refs, userconf
from .report import _collapse, plain_text

log = logging.getLogger("thimble.exports")
router = APIRouter()

FORMAT_INFO = {
    "markdown": {"name": "Markdown", "ext": "md", "mime": "text/markdown; charset=utf-8"},
    "html": {"name": "HTML", "ext": "html", "mime": "text/html; charset=utf-8"},
    "pdf": {"name": "PDF", "ext": "pdf", "mime": "application/pdf"},
}
QUOTE_CHARS = 240  # of a cited record, in its note
TEXT_CHARS = 1200  # of a card's text when it is shown without a picture
TABLE_ROWS = 30
_INLINE_RE = re.compile(r"\*\*(.+?)\*\*|(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])|`([^`]+)`|\[([^\]]+)\]\((https?://[^)\s]+)\)")


# --------------------------------------------------------------------------- the document, read once


class Notes:
    """The document's citations, numbered in order of first use; each {n, ref, label, quote, card}."""

    def __init__(self, c: str):
        from .report_types import _Citations  # noqa: PLC0415 — report_types imports much of the app

        self.cites = _Citations(c)
        self.corpus = self.cites.corpus
        self.rows: list[dict[str, Any]] = []
        self._n: dict[str, int] = {}

    def note(self, ref: str) -> int | None:
        if ref in self._n:
            return self._n[ref]
        label = self.cites.cite(ref)
        if not label:
            return None
        quote = ""
        if self.corpus is not None:
            try:
                res = refs.resolve(self.corpus, ref) or {}
            except Exception:  # noqa: BLE001 — a ref that no longer resolves keeps its label
                res = {}
            quote = "" if re.fullmatch(r"card:[0-9a-f]{8}", ref) else _collapse(res.get("excerpt") or "")
            if len(quote) > QUOTE_CHARS:
                quote = quote[: QUOTE_CHARS - 1].rstrip() + "…"
        card = None
        try:
            p = refs.parse_ref(ref)
            if p.get("kind") == "cell":
                card = str(p["cell_id"])
        except ValueError:
            pass
        title = self.cites.titles.get(card, "") if card else ""
        n = len(self.rows) + 1
        self.rows.append({"n": n, "ref": ref, "label": label, "quote": quote, "card": card, "title": title})
        self._n[ref] = n
        return n

    def of(self, raw_refs: list[str]) -> list[int]:
        out: list[int] = []
        for r in raw_refs:
            n = self.note(r)
            if n is not None and n not in out:
                out.append(n)
        return out


def _sentence(x: dict[str, Any], notes: Notes) -> dict[str, Any]:
    from .report_types import UNVERIFIED_MARK, _sentence_refs, card_nouns  # noqa: PLC0415

    text = plain_text(card_nouns(str(x.get("text") or ""), notes.cites))
    if "unverified" in (x.get("tags") or []):
        text += f" {UNVERIFIED_MARK}"
    return {"text": text, "notes": notes.of(_sentence_refs(x)), "bullet": bool(x.get("bullet"))}


def _figure(f: Any, notes: Notes, cite: bool = True) -> dict[str, Any] | None:
    if isinstance(f, str):
        f = {"cell": f}
    if not isinstance(f, dict):
        return None
    raw = str(f.get("cell") or f.get("card") or "").strip().strip("[]")
    cid = None
    try:
        p = refs.parse_ref(raw)
        cid = str(p["cell_id"]) if p.get("kind") == "cell" else None
    except ValueError:
        cid = raw if re.fullmatch(r"[0-9a-f]{8}", raw) else None
    if not cid:
        return None
    from .report_types import card_nouns  # noqa: PLC0415

    raw_caption = str(f.get("caption") or "")
    return {"card": cid, "caption": plain_text(card_nouns(raw_caption, notes.cites)), "lead": bool(f.get("lead")),
            "after": f.get("after_paragraph"),
            "notes": notes.of([f"card:{cid}", *refs.extract_refs(raw_caption)]) if cite else []}


def read_model(c: str, doc: dict[str, Any], *, cite_figures: bool = True) -> dict[str, Any]:
    """The document as every format reads it (module note); with `cite_figures` false its figures cite nothing, as a
    Blog post's figures do not, so the notes are the text's citations alone."""
    from . import report_types  # noqa: PLC0415

    notes = Notes(c)
    title = _collapse(doc.get("title")) or _collapse(doc.get("type")) or "Report"
    claims = [_sentence(x, notes) for x in doc.get("claims") or [] if isinstance(x, dict)] if doc.get("html") else []
    units: list[dict[str, Any]] = []
    for u in report_types.units(doc):
        paras = [{"id": p.get("id"), "sentences": [_sentence(x, notes) for x in p.get("sentences") or [] if isinstance(x, dict)]}
                 for p in u.get("paragraphs") or [] if isinstance(p, dict)]
        figs = [f for f in (_figure(x, notes, cite_figures) for x in u.get("figures") or []) if f]
        units.append({"heading": _collapse(u.get("heading")), "level": report_types._level(u.get("level")),
                      "tldr": report_types._is_tldr(u.get("heading")), "paragraphs": [p for p in paras if p["sentences"]],
                      "figures": figs})
    units.sort(key=lambda u: 0 if u["tldr"] else 1)
    return {"title": title, "claims": claims, "units": units, "notes": notes.rows,
            "page_html": doc.get("html") if isinstance(doc.get("html"), str) else None}


# --------------------------------------------------------------------------- Markdown


def _md_sentence(s: dict[str, Any]) -> str:
    return s["text"] + "".join(f"[^{n}]" for n in s["notes"])


def to_markdown(m: dict[str, Any]) -> str:
    """The document as Markdown, each citation a footnote naming what it cites and quoting it."""
    out = [f"# {m['title']}", ""]
    for s in m["claims"]:
        out.append(f"- {_md_sentence(s)}")
    if m["claims"]:
        out.append("")
    for u in m["units"]:
        if u["heading"]:
            out += [f"{'#' * max(2, u['level'])} {u['heading']}", ""]
        for p in u["paragraphs"]:
            bullets = [s for s in p["sentences"] if s["bullet"]]
            if bullets and len(bullets) == len(p["sentences"]):
                out += [f"- {_md_sentence(s)}" for s in bullets] + [""]
                continue
            out += [" ".join(_md_sentence(s) for s in p["sentences"]), ""]
        for f in u["figures"]:
            if f["caption"]:
                out += [f"*Figure: {f['caption']}*" + "".join(f"[^{n}]" for n in f["notes"]), ""]
    if m["notes"]:
        out += ["---", ""]
        for r in m["notes"]:
            out.append(f"[^{r['n']}]: {_note_text(r)}")
        out.append("")
    return "\n".join(out).rstrip() + "\n"


def _note_text(r: dict[str, Any]) -> str:
    what = r["label"] + (f" “{r['title']}”" if r["title"] else "")
    return what + (f": “{r['quote']}”" if r["quote"] else "")


# --------------------------------------------------------------------------- HTML


_MONO = [("Geist Mono", "geist-mono", w, "normal") for w in ("400", "500")]
# the faces each figure style's file is set in (frontend styles/fonts.css), as (family, package, weight, style):
# thimble's Hanken Grotesk; Blog's DM Sans, with Source Serif 4 for the records its notes quote; Paper's Source Serif 4.
# Geist Mono sets code and the notes' refs in every style.
FACES = {
    "thimble": [("Hanken Grotesk", "hanken-grotesk", w, s)
                for w, s in (("400", "normal"), ("500", "normal"), ("600", "normal"), ("400", "italic"))] + _MONO,
    "blog": [("DM Sans", "dm-sans", w, "normal") for w in ("400", "500", "600", "700")]
            + [("Source Serif 4", "source-serif-4", "400", s) for s in ("normal", "italic")] + _MONO,
    "paper": [("Source Serif 4", "source-serif-4", w, s)
              for w, s in (("400", "normal"), ("600", "normal"), ("400", "italic"))] + _MONO,
}
BODY_FACE = {"thimble": "Hanken Grotesk", "blog": "DM Sans", "paper": "Source Serif 4"}  # what a style's text is set in


def font_faces(style: str = "thimble") -> str:
    """@font-face rules for the faces of figure style `style` (FACES) as data URLs: the frontend's packages, else the
    built UI's files, else, for Hanken Grotesk and Geist Mono, the TrueType faces the kernels use (page_fonts)."""
    rules: list[str] = []
    fontsource = config.REPO_ROOT / "frontend" / "node_modules" / "@fontsource"
    assets = config.FRONTEND_DIST / "assets"
    ttf = Path(__file__).with_name("fonts")
    for family, pkg, w, slant in FACES.get(style, FACES["thimble"]):
        name = f"{pkg}-latin-{w}-{slant}"
        found = fontsource / pkg / "files" / f"{name}.woff2"
        if not found.is_file():
            found = next(iter(sorted(assets.glob(f"{name}-*.woff2"))), None) if assets.is_dir() else None
        fmt, mime = "woff2", "font/woff2"
        if found is None or not found.is_file():
            stem = {"400": "Regular", "500": "Medium"}.get(w)
            found = ttf / f"{family.replace(' ', '')}-{stem}.ttf" if stem and slant == "normal" else None
            fmt, mime = "truetype", "font/ttf"
        if found is None or not found.is_file():
            continue
        data = base64.b64encode(found.read_bytes()).decode("ascii")
        rules.append(f"@font-face{{font-family:'{family}';font-style:{slant};font-weight:{w};font-display:block;"
                     f"src:url(data:{mime};base64,{data}) format('{fmt}')}}")
    return "".join(rules)


BASE_CSS = """
:root{--paper-0:#fbfaf7;--paper-1:#f5f3ee;--white:#fffdf8;--ink-900:#000;--ink-700:#4a4844;--ink-500:#64625b;
--ink-300:#c6c2b9;--ink-rgb:27,26,24;--font-body:'Hanken Grotesk',system-ui,sans-serif;--font-mono:'Geist Mono',ui-monospace,monospace}
*{box-sizing:border-box}
html{background:var(--paper-0);color:var(--ink-900);font-family:var(--font-body);font-size:16px;line-height:1.6;
-webkit-font-smoothing:antialiased;-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{margin:0;background:var(--paper-0)}
main{max-width:720px;margin:0 auto;padding:56px 24px 72px}
h1{font-size:30px;line-height:1.2;font-weight:600;letter-spacing:-.01em;margin:0 0 20px}
h2{font-size:20px;line-height:1.3;font-weight:600;margin:36px 0 10px}
h3,h4{font-size:17px;font-weight:600;margin:28px 0 8px}
p{margin:0 0 14px}
ul{margin:0 0 14px;padding-left:22px}
a{color:inherit}
code{font-family:var(--font-mono);font-size:.88em;background:rgba(var(--ink-rgb),.06);padding:1px 4px;border-radius:4px}
sup.cite{font-size:.68em;line-height:0;margin-left:1px;color:var(--ink-500)}
sup.cite a{text-decoration:none;color:var(--ink-500);font-weight:500}
sup.cite a:hover{color:var(--ink-900)}
figure{margin:20px 0 24px;break-inside:avoid}
figure img{display:block;max-width:100%;height:auto;border-radius:10px}
figcaption{font-size:14px;color:var(--ink-500);margin-top:8px}
.card{background:var(--white);border-radius:10px;padding:14px 16px;box-shadow:0 0 0 1px rgba(var(--ink-rgb),.08)}
.card-title{font-weight:600;margin-bottom:6px}
.card pre{font-family:var(--font-mono);font-size:12px;white-space:pre-wrap;margin:0;color:var(--ink-700)}
.card table{border-collapse:collapse;font-size:13px;width:100%}
.card th,.card td{text-align:left;padding:3px 8px;border-bottom:1px solid rgba(var(--ink-rgb),.08)}
.card th{font-weight:500;color:var(--ink-500)}
.notes{margin-top:48px;padding-top:16px;border-top:1px solid rgba(var(--ink-rgb),.14);font-size:13px;color:var(--ink-700)}
.notes h2{font-size:14px;margin:0 0 10px;color:var(--ink-500);font-weight:500}
.notes ol{padding-left:24px;margin:0}
.notes li{margin:0 0 6px}
.notes .ref{font-family:var(--font-mono);font-size:12px;color:var(--ink-900)}
.notes q{color:var(--ink-500)}
.meta{font-size:13px;color:var(--ink-500);margin:-12px 0 28px}
@media print{html,body{background:#fff}main{padding:0 0 24px}a{text-decoration:none}}
"""
# Blog (blogpost-figure's): white, its inks, DM Sans at 17 px; the title under a 44 x 5 accent bar; links and citations
# in the accent; the quoted records in Source Serif 4. A figure is 800 px wide at most, and the text stands in from its
# edges by the share its padding takes (40 of 800 px), where the figure's own headline and chart start.
BLOG_CSS = """
:root{--paper-0:#fff;--white:#fff;--ink-900:#1f1f1e;--ink-700:#5a5a57;--ink-500:#8a8a86;--ink-rgb:31,31,30;
--accent:#b86046;--font-body:'DM Sans','Helvetica Neue',Arial,sans-serif;--font-quote:'Source Serif 4',Georgia,serif}
html{font-size:17px;line-height:1.55}
main{max-width:848px}
main>:not(figure){margin-left:5%;margin-right:5%}
h1{font-size:34px;line-height:1.15;font-weight:700;letter-spacing:-.01em}
h1::before{content:'';display:block;width:44px;height:5px;margin-bottom:18px;background:var(--accent)}
h2{font-size:24px;line-height:1.25;font-weight:600;margin-top:40px}
h3,h4{font-size:19px;line-height:1.35;font-weight:600}
strong{font-weight:600}
a,sup.cite a,sup.cite a:hover{color:var(--accent)}
figure.fig-blog img{border-radius:0}
.notes q{font-family:var(--font-quote);font-size:14px}
"""
# Paper (paper-figure's): white, Source Serif 4 at a paper's sizes, the title centered and the paragraphs justified; a
# figure centered at its own size, its legend under it and its caption under both, as wide as the text.
PAPER_CSS = """
:root{--paper-0:#fff;--white:#fff;--ink-900:#1a1a1a;--ink-700:#3d3d3d;--ink-500:#5c5c5c;--ink-rgb:26,26,26;
--font-body:'Source Serif 4','Times New Roman',Times,serif}
html{font-size:16px;line-height:1.5}
h1{font-size:26px;line-height:1.25;font-weight:600;letter-spacing:0;text-align:center;margin-bottom:28px}
h2{font-size:19px;line-height:1.3;font-weight:600;margin-top:32px}
h3,h4{font-size:16px;line-height:1.4;font-weight:600}
strong{font-weight:600}
p{text-align:justify;hyphens:auto}
figure.fig-paper{margin:24px 0 28px;text-align:center}
.fig-paper img{display:block;margin:0 auto;max-width:100%;border-radius:0}
.fig-paper img.fig-legend{margin-top:6px}
.fig-paper figcaption{margin-top:10px;text-align:left;font-size:14px;line-height:1.45;color:var(--ink-900)}
.fig-n{margin-right:.15em}
.fig-table{overflow-x:auto}
.fig-table table{margin:0 auto;border-collapse:collapse;font-size:14px;border-top:1px solid var(--ink-900);
border-bottom:1px solid var(--ink-900)}
.fig-table th,.fig-table td{padding:3px 12px;text-align:left}
.fig-table thead th{font-weight:600;border-bottom:1px solid var(--ink-900)}
.notes{font-size:14px}
"""
STYLE_CSS = {"thimble": "", "blog": BLOG_CSS, "paper": PAPER_CSS}


def _esc(s: Any) -> str:
    return _html.escape(str(s or ""), quote=True)


def inline_html(text: str) -> str:
    """A sentence's inline Markdown as HTML: bold, emphasis, code and http(s) links; everything else escaped."""
    out, pos = [], 0
    for m in _INLINE_RE.finditer(text or ""):
        out.append(_esc(text[pos:m.start()]))
        if m.group(1) is not None:
            out.append(f"<strong>{_esc(m.group(1))}</strong>")
        elif m.group(2) is not None:
            out.append(f"<em>{_esc(m.group(2))}</em>")
        elif m.group(3) is not None:
            out.append(f"<code>{_esc(m.group(3))}</code>")
        else:
            out.append(f'<a href="{_esc(m.group(5))}">{_esc(m.group(4))}</a>')
        pos = m.end()
    out.append(_esc((text or "")[pos:]))
    return "".join(out)


def _cites_html(ns: list[int]) -> str:
    if not ns:
        return ""
    return '<sup class="cite">' + ",".join(f'<a href="#note-{n}">{n}</a>' for n in ns) + "</sup>"


def _sentence_html(s: dict[str, Any]) -> str:
    return inline_html(s["text"]) + _cites_html(s["notes"])


def _para_html(p: dict[str, Any]) -> str:
    bullets = [s for s in p["sentences"] if s["bullet"]]
    if bullets and len(bullets) == len(p["sentences"]):
        return "<ul>" + "".join(f"<li>{_sentence_html(s)}</li>" for s in bullets) + "</ul>"
    return f"<p>{' '.join(_sentence_html(s) for s in p['sentences'])}</p>"


def _pic_key(f: dict[str, Any], style: str) -> str:
    """The picture a figure shows, by its card; by its caption too in Blog, whose headline the caption is."""
    return f"{f['card']}\n{f['caption']}" if style == "blog" else f["card"]


def _own(f: dict[str, Any], pic: dict[str, Any]) -> str:
    """A figure's caption when it says something of its own: not one that only repeats the card's question, which a
    figure written without one keeps, nor the card's takeaway word for word; else ''."""
    said = _collapse(f["caption"])
    return f["caption"] if said and said not in (_collapse(pic.get("question")), _collapse(pic.get("takeaway"))) else ""


def _said(f: dict[str, Any], pic: dict[str, Any]) -> str:
    """What a figure says in Blog and Paper: its own caption (_own), else its card's takeaway."""
    return _own(f, pic) or pic.get("takeaway") or ""


def paper_caption(n: int, takeaway: str, question: str) -> str:
    """A Paper figure's caption as HTML, `Figure N. Takeaway. Question` (frontend figures/figure captionParts): the
    takeaway in bold, ending in one period or in its own question or exclamation mark."""
    said = re.sub(r"[.\s]+$", "", takeaway or "")
    if said and not re.search(r"[?!…]$", said):
        said += "."
    parts = [f'<span class="fig-n">Figure {n}.</span>']
    if said:
        parts.append(f"<strong>{inline_html(said)}</strong>")
    if question:
        parts.append(inline_html(question))
    return " ".join(parts)


def _figure_html(f: dict[str, Any], pics: dict[str, dict[str, Any]], style: str = "thimble",
                 n: int | None = None) -> str:
    """A figure in its style: thimble's the card's picture with the caption under it; Blog's the figure's picture,
    headed as card_pictures drew it; Paper's, numbered `n`, the chart's picture with its legend's under it, or a
    table card's table as text, and the caption (paper_caption). A figure without a picture is its card's table or
    text, with its caption."""
    pic = pics.get(_pic_key(f, style)) or {}
    cites = _cites_html(f["notes"])
    fid = _esc(f["card"])
    if style == "blog" and pic.get("png"):
        return f'<figure id="card-{fid}" class="fig-blog">{card_html(pic)}</figure>'
    if style == "paper" and n is not None:
        art = card_html(pic) if pic.get("png") or not pic.get("table") else f'<div class="fig-table">{pic["table"]}</div>'
        legend = card_html(pic["legend"], cls="fig-legend") if pic.get("legend") else ""
        cap = paper_caption(n, _said(f, pic), pic.get("question") or "")
        return f'<figure id="card-{fid}" class="fig-paper">{art}{legend}<figcaption>{cap}{cites}</figcaption></figure>'
    cap = (f'<figcaption>{inline_html(f["caption"])}{cites}</figcaption>' if f["caption"]
           else "")
    return f'<figure id="card-{fid}">{card_html(pic)}{cap}</figure>'


def card_html(pic: dict[str, Any], *, cls: str = "") -> str:
    """A card as the export shows it: its picture, else its table, else its title and text."""
    if pic.get("png"):
        w = pic.get("width")
        size = f' width="{int(w)}"' if w else ""
        klass = f' class="{cls}"' if cls else ""
        return f'<img{klass} alt="{_esc(pic.get("title"))}"{size} src="data:image/png;base64,{pic["png"]}">'
    body = pic.get("table") or (f"<pre>{_esc(pic['text'])}</pre>" if pic.get("text") else "")
    return f'<div class="card"><div class="card-title">{_esc(pic.get("title") or "Card")}</div>{body}</div>'


def _notes_html(m: dict[str, Any]) -> str:
    if not m["notes"]:
        return ""
    items = []
    for r in m["notes"]:
        label = f'<span class="ref">{_esc(r["label"])}</span>'
        if r["title"]:
            label += f" “{_esc(r['title'])}”"
        quote = f" <q>{_esc(r['quote'])}</q>" if r["quote"] else ""
        items.append(f'<li id="note-{r["n"]}">{label}{quote}</li>')
    return f'<section class="notes"><h2>Sources</h2><ol>{"".join(items)}</ol></section>'


def _unit_body(u: dict[str, Any], pics: dict[str, dict[str, Any]], style: str = "thimble",
               count: Iterator[int] | None = None) -> str:
    """A section's figures that lead it, then its paragraphs with each figure after the paragraph it follows, the rest
    at the end, as the page places them (frontend report/model blocksFromDoc). A Paper figure takes the next number of
    `count` in that order, unless its card is gone."""
    lead: list[dict[str, Any]] = []
    placed: dict[Any, list[dict[str, Any]]] = {}
    tail: list[dict[str, Any]] = []
    ids = {p["id"] for p in u["paragraphs"]}
    for f in u["figures"]:
        if f.get("lead"):
            lead.append(f)
        else:
            (placed.setdefault(f["after"], []) if f["after"] in ids and f["after"] is not None else tail).append(f)

    def figure(f: dict[str, Any]) -> str:
        numbered = style == "paper" and count is not None and not (pics.get(_pic_key(f, style)) or {}).get("gone")
        return _figure_html(f, pics, style, next(count) if numbered else None)

    out = [figure(f) for f in lead]
    for p in u["paragraphs"]:
        out.append(_para_html(p))
        out += [figure(f) for f in placed.get(p["id"], [])]
    return "".join(out + [figure(f) for f in tail])


def to_html(m: dict[str, Any], pics: dict[str, dict[str, Any]], *, faces: str | None = None,
            style: str = "thimble") -> str:
    """The document as one self-contained HTML file, in figure style `style` (module note); a page in thimble's."""
    if m["page_html"] is not None:
        return _page_html(m, font_faces() if faces is None else faces)
    faces = font_faces(style) if faces is None else faces
    count = itertools.count(1)
    parts = [f"<h1>{inline_html(m['title'])}</h1>"]
    if m["claims"]:
        parts.append("<ul>" + "".join(f"<li>{_sentence_html(s)}</li>" for s in m["claims"]) + "</ul>")
    for u in m["units"]:
        if u["heading"]:
            lvl = min(4, max(2, u["level"]))
            parts.append(f"<h{lvl}>{inline_html(u['heading'])}</h{lvl}>")
        parts.append(_unit_body(u, pics, style, count))
    parts.append(_notes_html(m))
    return _document(m["title"], faces, BASE_CSS + STYLE_CSS.get(style, ""), "<main>" + "".join(parts) + "</main>")


def _document(title: str, faces: str, css: str, body: str) -> str:
    return (f'<!doctype html><html lang="en"><head><meta charset="utf-8">'
            f'<meta name="viewport" content="width=device-width,initial-scale=1"><title>{_esc(title)}</title>'
            f"<style>{faces}{css}</style></head><body>{body}</body></html>")


def _page_html(m: dict[str, Any], faces: str) -> str:
    """A page (a custom type written as HTML) as its own file, with thimble's faces and tokens added."""
    page = m["page_html"] or ""
    head = f"<style>{faces}{BASE_CSS.split('*{')[0]}</style>"
    if re.search(r"<head[^>]*>", page, re.I):
        return re.sub(r"(<head[^>]*>)", lambda mm: mm.group(1) + '<meta charset="utf-8">' + head, page, count=1, flags=re.I)
    return _document(m["title"], faces, BASE_CSS.split("*{")[0], page)


# --------------------------------------------------------------------------- pictures of the cards


def _card_text(cell: dict[str, Any]) -> tuple[str, str]:
    """(table html, text) of a card shown without a picture."""
    fr = frames.frame_in(cell.get("outputs") or [])
    if fr:
        cols, names, grid = frames.frame_grid(fr, list(range(min(TABLE_ROWS, len(fr["rows"])))))
        head = f"<th>{_esc(frames.corner(fr))}</th>" + "".join(f"<th>{_esc(x)}</th>" for x in cols)
        body = "".join(f"<tr><td>{_esc(n)}</td>" + "".join(f"<td>{_esc(v)}</td>" for v in row) + "</tr>"
                       for n, row in zip(names, grid))
        return f"<table><thead><tr>{head}</tr></thead><tbody>{body}</tbody></table>", ""
    texts = [str(b.get("text/plain") or "") for b in cell.get("outputs") or [] if isinstance(b, dict) and b.get("text/plain")]
    text = "\n".join(t for t in [plain_text(str(cell.get("takeaway") or ""))] + texts if t).strip()
    return "", text[:TEXT_CHARS] + ("…" if len(text) > TEXT_CHARS else "")


def _picture(r: Any, title: str) -> dict[str, Any] | None:
    """A drawn card or figure as card_html shows it; None when it drew nothing."""
    if not (r.ok and r.png) or r.empty:
        return None
    return {"title": title, "png": base64.b64encode(r.png).decode("ascii"), "width": r.box.get("width")}


async def card_pictures(c: str, figures: list[dict[str, Any]], *, draw: bool,
                        style: str = "thimble") -> tuple[dict[str, dict[str, Any]], str]:
    """Each figure as the export shows it in figure style `style` (card_html's input), by _pic_key, and why figures are
    not pictures when they are not. thimble's picture is the card as the canvas draws it (render_card); Blog's is the
    card as a Blog figure headed by the figure's own caption (_own), else by the first sentence of the card's takeaway,
    as on the page (frontend report/FigureBlock FigureInStyle), and Paper's the chart alone with its legend as a picture
    of its own (`legend`, none for a chart with none), both drawn by render_figure; a table card's Paper figure is its
    table, set as text. A card with no picture is its table or its text; each keeps its question and takeaway for a
    Paper caption."""
    from . import material, notebook, render  # noqa: PLC0415

    out: dict[str, dict[str, Any]] = {}
    why = "" if draw else "the browser is off"
    cells: dict[str, dict[str, Any] | None] = {}
    for f in figures:
        key, cid = _pic_key(f, style), f["card"]
        if key in out:
            continue
        if cid not in cells:
            cells[cid] = await asyncio.to_thread(notebook.get_cell, c, cid)
        cell = cells[cid]
        if cell is None:
            out[key] = {"title": f"card:{cid} (deleted)", "gone": True}
            continue
        title = _collapse(cell.get("title")) or f"card:{cid}"
        pic: dict[str, Any] = {"title": title, "question": plain_text(str(cell.get("title") or "")),
                               "takeaway": plain_text(str(cell.get("takeaway") or ""))}
        if draw and not why and not (style == "paper" and material.figure_kind(cell) == "table"):
            try:
                if style == "blog":
                    drawn = await render.render_figure(c, cell, style="blog", title=_own(f, pic) or None)
                    got = _picture(drawn, _said(f, pic) or title)
                elif style == "paper":
                    got = _picture(await render.render_figure(c, cell, style="paper"), title)
                    if got:
                        legend = await render.render_figure(c, cell, style="paper", part="legend", columns=2)
                        got["legend"] = _picture(legend, "Legend")
                else:
                    got = _picture(await render.render_card(c, cell), title)
            except render.Unavailable as e:
                why = str(e)
            else:
                pic.update(got or {})
        if "png" not in pic:
            pic["table"], pic["text"] = _card_text(cell)
        out[key] = pic
    return out, why


# --------------------------------------------------------------------------- the browser


def _bundled_installed() -> bool:
    root = headless.browsers_dir()
    return any(root.glob("chromium_headless_shell-*")) or any(root.glob("chromium-*"))


def browser() -> tuple[str, str]:
    """(kind, path or why) of the browser thimble's config names (userconf.browser); `off` with the reason when there is
    none."""
    return userconf.browser(_bundled_installed)


@contextlib.asynccontextmanager
async def browser_page(width: int, height: int, *, scale: float = 1) -> AsyncIterator[Any]:
    """A page of a fresh headless browser that reaches nothing off this machine. RuntimeError with the reason when no
    browser can start."""
    kind, what = browser()
    if kind == "off":
        raise RuntimeError(what)
    try:
        from playwright.async_api import async_playwright  # noqa: PLC0415
    except ImportError as e:
        raise RuntimeError("Playwright is not installed in backend/.venv") from e
    pw = await async_playwright().start()
    b = None
    try:
        try:
            b = await pw.chromium.launch(headless=True, **({"executable_path": what} if kind == "system" else {}))
        except Exception as e:  # noqa: BLE001
            first = str(e).splitlines()[0][:300] if str(e) else ""
            raise RuntimeError(headless.why_missing(str(e)) or f"{type(e).__name__}: {first}") from e
        ctx = await b.new_context(viewport={"width": width, "height": height}, device_scale_factor=scale)
        await ctx.route("**/*", _offline)
        page = await ctx.new_page()
        yield page
    finally:
        if b is not None:
            with contextlib.suppress(Exception):
                await b.close()
        with contextlib.suppress(Exception):
            await pw.stop()


async def _offline(route: Any) -> None:
    if route.request.url.startswith(("http:", "https:", "ws:", "wss:")):
        await route.abort()
    else:
        await route.fallback()


async def fonts_loaded(page: Any, face: str = "Hanken Grotesk") -> bool:
    return bool(await page.evaluate(
        "async (face) => { const f = `16px \"${face}\"`; await document.fonts.ready;"
        " await document.fonts.load(f).catch(() => []); return document.fonts.check(f) }", face))


async def print_pdf(html_text: str, face: str = "Hanken Grotesk") -> bytes:
    """The HTML printed by the browser, on A4 pages, once its text's face (`face`) loaded."""
    async with browser_page(1280, 900) as page:
        await page.set_content(html_text, wait_until="load")
        if not await fonts_loaded(page, face):
            log.warning("pdf export: %s did not load; the fallback face is printed", face)
        await page.emulate_media(media="print")
        return await page.pdf(print_background=True, prefer_css_page_size=True, format="A4",
                              margin={"top": "18mm", "bottom": "18mm", "left": "16mm", "right": "16mm"})


# --------------------------------------------------------------------------- formats


def formats() -> list[dict[str, Any]]:
    """The formats a document offers, each {id, name, ext, ok, why?}: Markdown, HTML and PDF, the ones the browser is
    missing for marked not ok."""
    kind, why_off = browser()
    out: dict[str, dict[str, Any]] = {i: {"id": i, "name": FORMAT_INFO[i]["name"], "ext": FORMAT_INFO[i]["ext"], "ok": True}
                                      for i in ("markdown", "html", "pdf")}
    for f in out.values():
        if f["ext"] == "pdf" and kind == "off":
            f.update(ok=False, why=f"Needs a browser: {why_off}")
    return list(out.values())


# --------------------------------------------------------------------------- export


def _filename(title: str, slug: str, ext: str) -> str:
    base = re.sub(r"[^A-Za-z0-9]+", "-", title).strip("-")[:60] or slug
    return f"{base}.{ext}"


def figure_style(c: str, asked: str | None = None) -> str:
    """The figure style an export is drawn in: the one asked for (the page's, report/ExportMenu.tsx), else the one the
    analyst's browser last reported (render.theme); one the harness does not know reads as thimble's."""
    from . import render  # noqa: PLC0415

    return render.figures_of(asked) if asked else render.theme(c)["figures"]


async def export(c: str, inv_id: str, slug: str, fmt: str, figures: str | None = None) -> tuple[bytes, str, str]:
    """(content, file name, mime) of the document in format `fmt`, HTML and PDF in figure style `figures`
    (figure_style). HTTPException 404 for no document or no such format, 409 for a format that cannot run here, with
    the reason."""
    from . import report_types  # noqa: PLC0415

    doc = await asyncio.to_thread(report_types.read_doc, c, inv_id, slug)
    if doc is None:
        raise HTTPException(404, f"no {slug} yet")
    offered = {f["id"]: f for f in await asyncio.to_thread(formats)}
    f = offered.get(fmt)
    if f is None:
        raise HTTPException(404, f"{slug} has no export format {fmt!r}")
    if not f["ok"]:
        raise HTTPException(409, f["why"])
    style = "thimble" if fmt == "markdown" else await asyncio.to_thread(figure_style, c, figures)
    m = await asyncio.to_thread(read_model, c, doc, cite_figures=style != "blog")
    name = lambda ext: _filename(m["title"], slug, ext)  # noqa: E731
    if fmt == "markdown":
        return to_markdown(m).encode("utf-8"), name("md"), FORMAT_INFO["markdown"]["mime"]
    kind, _why = browser()
    figs = [x for u in m["units"] for x in u["figures"]]
    pics, _ = await card_pictures(c, figs, draw=kind != "off", style=style)
    html_text = await asyncio.to_thread(to_html, m, pics, style=style)
    if fmt == "html":
        return html_text.encode("utf-8"), name("html"), FORMAT_INFO["html"]["mime"]
    try:
        return await print_pdf(html_text, BODY_FACE[style]), name("pdf"), FORMAT_INFO["pdf"]["mime"]
    except RuntimeError as e:
        raise HTTPException(409, f"PDF needs a browser: {e}") from e


# --------------------------------------------------------------------------- routes


def _slug(c: str, inv_id: str, slug: str) -> str:
    from . import report_types  # noqa: PLC0415

    investigation.inv_dir(c, inv_id)
    slug = report_types._check_slug(slug, custom=False)
    report_types._require_type(c, slug)
    return slug


@router.get("/ws/{c}/investigations/{inv_id}/types/{slug}/exports")
async def formats_route(c: str, inv_id: str, slug: str) -> dict[str, Any]:
    from . import report_types  # noqa: PLC0415

    slug = _slug(c, inv_id, slug)
    doc = await asyncio.to_thread(report_types.read_doc, c, inv_id, slug)
    return {"formats": await asyncio.to_thread(formats) if doc else []}


@router.get("/ws/{c}/investigations/{inv_id}/types/{slug}/export/{fmt}")
async def export_route(c: str, inv_id: str, slug: str, fmt: str, figures: str | None = None) -> Response:
    slug = _slug(c, inv_id, slug)
    data, name, mime = await export(c, inv_id, slug, fmt, figures)
    return Response(content=data, media_type=mime,
                    headers={"Content-Disposition": f'attachment; filename="{name}"', "X-Export-Name": name})
