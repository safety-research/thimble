"""A written document exported as a file: Markdown, HTML, PDF or video, and the formats a report type's export.py adds.

Every format starts from one reading of the document (read_model): its title, lead, units (a report's sections, a
story's sections, a deck's slides, a video's lines), their figures and the citations, numbered in order of first use.
Markdown writes the citations as footnotes; HTML is one self-contained file (fonts, pictures and styles inlined) with
the citations as numbered notes linked from the text; PDF is that HTML printed by the browser; video renders the film
(film_export.py).

The browser: the one thimble's config names (userconf.browser, from 0.3.0), else the system's Chrome, Edge or Chromium,
else Playwright's own Chromium. Pictures of cards come from the card harness (render.py); without a browser a card is
its title, its table or its text, and PDF and video are offered disabled with the reason.

A report type an extension adds may ship export.py beside its type.md:

    FORMATS = [{"id": "csv", "name": "CSV", "ext": "csv"}]   # adds to the four; an id among them replaces that one
    def export(doc, fmt, ctx): ...                          # -> {"markdown"|"html"|"film"|"bytes": ..., "mime"?: ...}

The server reads FORMATS without running the file. export() runs in the workspace's `exports` kernel, under the same
wrap as cards; `ctx` has markdown(), html(), cite(ref) and figure(card). A returned html is printed when the format's
ext is pdf, and a returned film ({html, duration, lines}) is rendered when it is a video, so a hook never drives the
browser.
"""
from __future__ import annotations

import ast
import asyncio
import base64
import contextlib
import html as _html
import json
import logging
import os
import re
import secrets
import shutil
import sys
from pathlib import Path
from typing import Any, AsyncIterator

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response

from . import config, frames, investigation, refs
from .report import _collapse, plain_text

log = logging.getLogger("thimble.exports")
router = APIRouter()

BUILTIN = ("markdown", "html", "pdf", "video")
FORMAT_INFO = {
    "markdown": {"name": "Markdown", "ext": "md", "mime": "text/markdown; charset=utf-8"},
    "html": {"name": "HTML", "ext": "html", "mime": "text/html; charset=utf-8"},
    "pdf": {"name": "PDF", "ext": "pdf", "mime": "application/pdf"},
    "video": {"name": "Video", "ext": "mp4", "mime": "video/mp4"},
}
MIME_BY_EXT = {"md": "text/markdown; charset=utf-8", "html": "text/html; charset=utf-8", "pdf": "application/pdf",
               "mp4": "video/mp4", "webm": "video/webm", "csv": "text/csv; charset=utf-8", "json": "application/json",
               "txt": "text/plain; charset=utf-8"}
QUOTE_CHARS = 240  # of a cited record, in its note
TEXT_CHARS = 1200  # of a card's text when it is shown without a picture
TABLE_ROWS = 30
KERNEL = "exports"
EXPORT_PY = "export.py"
HOOK_TIMEOUT_S = 120.0
SENTINEL = "\x1ethimble-export:"
SYSTEM_BROWSERS = {
    "linux": ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge"),
    "darwin": ("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
               "/Applications/Chromium.app/Contents/MacOS/Chromium",
               "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"),
}
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
    from .report_types import UNVERIFIED_MARK, _sentence_refs  # noqa: PLC0415

    text = plain_text(str(x.get("text") or ""))
    if "unverified" in (x.get("tags") or []):
        text += f" {UNVERIFIED_MARK}"
    return {"text": text, "notes": notes.of(_sentence_refs(x)), "bullet": bool(x.get("bullet"))}


def _figure(f: Any, notes: Notes) -> dict[str, Any] | None:
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
    raw_caption = str(f.get("caption") or "")
    return {"card": cid, "caption": plain_text(raw_caption), "role": f.get("role"),
            "after": f.get("after_paragraph"), "notes": notes.of([f"card:{cid}", *refs.extract_refs(raw_caption)])}


def read_model(c: str, doc: dict[str, Any], renderer: str) -> dict[str, Any]:
    """The document as every format reads it (module note)."""
    from . import report_types, video  # noqa: PLC0415

    notes = Notes(c)
    title = _collapse(doc.get("title")) or _collapse(doc.get("type")) or "Report"
    lead = [_sentence(doc["answer"], notes)] if isinstance(doc.get("answer"), dict) else []
    claims = [_sentence(x, notes) for x in doc.get("claims") or [] if isinstance(x, dict)] if doc.get("html") else []
    units: list[dict[str, Any]] = []
    lines: list[dict[str, Any]] = []
    film: dict[str, Any] = {}
    if renderer == "video":
        timing = video.timing(doc)
        film = {"film_page": video.film_document(doc), "duration": timing["duration"]}
        tm = {x["id"]: x for x in timing["lines"]}
        for u in video.lines_of(doc):
            w = tm.get(str(u.get("id") or ""), {})
            sents = [_sentence(x, notes) for x in u.get("sentences") or [] if isinstance(x, dict)]
            lines.append({"text": " ".join(s["text"] for s in sents), "notes": [n for s in sents for n in s["notes"]],
                          "spoken": video.spoken(u), "start": w.get("start", 0.0), "end": w.get("end", 0.0)})
    else:
        for u in report_types.units(doc):
            if isinstance(u.get("paragraphs"), list):
                paras = [{"id": p.get("id"), "kind": p.get("kind") or "", "speaker": _collapse(p.get("speaker")),
                          "sentences": [_sentence(x, notes) for x in p.get("sentences") or [] if isinstance(x, dict)]}
                         for p in u["paragraphs"] if isinstance(p, dict)]
            else:
                paras = [{"id": None, "kind": "", "speaker": "",
                          "sentences": [_sentence(x, notes) for x in report_types.unit_sentences(u)]}]
            figs_raw = list(u.get("figures") or []) + ([u["figure"]] if isinstance(u.get("figure"), dict) else [])
            figs = [f for f in (_figure(x, notes) for x in figs_raw) if f]
            units.append({"heading": _collapse(u.get("heading")), "level": report_types._level(u.get("level")),
                          "tldr": report_types._is_tldr(u.get("heading")), "layout": u.get("layout") or "",
                          "side": u.get("card") or "", "paragraphs": [p for p in paras if p["sentences"] or p["kind"] == "divider"],
                          "figures": figs, "speaker_notes": plain_text(u["notes"]) if isinstance(u.get("notes"), str) else ""})
        if renderer not in ("slides", "story"):
            units.sort(key=lambda u: 0 if u["tldr"] else 1)
    return {"title": title, "renderer": renderer, "lead": lead, "claims": claims, "units": units, "lines": lines,
            "notes": notes.rows, "page_html": doc.get("html") if isinstance(doc.get("html"), str) else None,
            **film}


# --------------------------------------------------------------------------- Markdown


def _md_sentence(s: dict[str, Any]) -> str:
    return s["text"] + "".join(f"[^{n}]" for n in s["notes"])


def to_markdown(m: dict[str, Any]) -> str:
    """The document as Markdown, each citation a footnote naming what it cites and quoting it."""
    out = [f"# {m['title']}", ""]
    if m["lead"]:
        out += [" ".join(_md_sentence(s) for s in m["lead"]), ""]
    for s in m["claims"]:
        out.append(f"- {_md_sentence(s)}")
    if m["claims"]:
        out.append("")
    if m["renderer"] == "video":
        for i, ln in enumerate(m["lines"], 1):
            out += [f"**{_clock(ln['start'])}–{_clock(ln['end'])}** {ln['text']}" + "".join(f"[^{n}]" for n in ln["notes"]), ""]
    for k, u in enumerate(m["units"], 1):
        if m["renderer"] == "slides":
            out += [f"## {u['heading'] or f'Slide {k}'}", ""]
        elif u["heading"]:
            out += [f"{'#' * max(2, u['level'])} {u['heading']}", ""]
        for p in u["paragraphs"]:
            if p["kind"] == "divider":
                out += ["---", ""]
                continue
            bullets = [s for s in p["sentences"] if s["bullet"]]
            if bullets and len(bullets) == len(p["sentences"]):
                out += [f"- {_md_sentence(s)}" for s in bullets] + [""]
                continue
            text = " ".join(_md_sentence(s) for s in p["sentences"])
            if p["kind"] == "quote":
                text = "> " + text + (f"\n>\n> — {p['speaker']}" if p["speaker"] else "")
            elif p["kind"] == "headline":
                text = f"**{text}**"
            elif p["kind"] == "callout":
                text = "> " + text
            out += [text, ""]
        for f in u["figures"]:
            if f["caption"]:
                out += [f"*Figure: {f['caption']}*" + "".join(f"[^{n}]" for n in f["notes"]), ""]
        if u["speaker_notes"]:
            out += [f"*Notes: {u['speaker_notes']}*", ""]
    if m["notes"]:
        out += ["---", ""]
        for r in m["notes"]:
            out.append(f"[^{r['n']}]: {_note_text(r)}")
        out.append("")
    return "\n".join(out).rstrip() + "\n"


def _note_text(r: dict[str, Any]) -> str:
    what = r["label"] + (f" “{r['title']}”" if r["title"] else "")
    return what + (f": “{r['quote']}”" if r["quote"] else "")


def _clock(t: float) -> str:
    t = max(0.0, float(t or 0))
    s = int(t)
    return f"{s // 60}:{s % 60:02d}"


# --------------------------------------------------------------------------- HTML


def font_faces() -> str:
    """@font-face rules for Hanken Grotesk and Geist Mono as data URLs: the frontend's packages, else the built UI's
    files, else the TrueType faces the kernels use (page_fonts)."""
    rules: list[str] = []
    faces = [("Hanken Grotesk", "hanken-grotesk", w, s) for w, s in (("400", "normal"), ("500", "normal"), ("600", "normal"), ("400", "italic"))]
    faces += [("Geist Mono", "geist-mono", w, "normal") for w in ("400", "500")]
    fontsource = config.REPO_ROOT / "frontend" / "node_modules" / "@fontsource"
    assets = config.FRONTEND_DIST / "assets"
    ttf = Path(__file__).with_name("fonts")
    for family, pkg, w, style in faces:
        name = f"{pkg}-latin-{w}-{style}"
        found = fontsource / pkg / "files" / f"{name}.woff2"
        if not found.is_file():
            found = next(iter(sorted(assets.glob(f"{name}-*.woff2"))), None) if assets.is_dir() else None
        fmt, mime = "woff2", "font/woff2"
        if found is None or not found.is_file():
            stem = {"400": "Regular", "500": "Medium"}.get(w)
            found = ttf / f"{family.replace(' ', '')}-{stem}.ttf" if stem and style == "normal" else None
            fmt, mime = "truetype", "font/ttf"
        if found is None or not found.is_file():
            continue
        data = base64.b64encode(found.read_bytes()).decode("ascii")
        rules.append(f"@font-face{{font-family:'{family}';font-style:{style};font-weight:{w};font-display:block;"
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
sup.cite{font-size:.68em;line-height:0;margin-left:1px}
sup.cite a{text-decoration:none;color:var(--ink-500);font-weight:500}
sup.cite a:hover{color:var(--ink-900)}
sup.cite+sup.cite::before{content:",";color:var(--ink-500)}
.lead{font-size:18px;color:var(--ink-900)}
blockquote{margin:0 0 14px;padding:2px 0 2px 16px;border-left:2px solid var(--ink-300);color:var(--ink-700)}
blockquote .who{display:block;margin-top:4px;font-size:14px;color:var(--ink-500)}
.headline{font-size:22px;line-height:1.3;font-weight:600}
.callout{background:var(--paper-1);border-radius:10px;padding:12px 16px}
hr{border:0;border-top:1px solid rgba(var(--ink-rgb),.14);margin:24px 0}
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

STORY_CSS = """
main{max-width:1040px}
section.story{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:40px;align-items:start;margin:0 0 56px}
section.story.side-left .copy{order:2}
section.story.side-full,section.story.side-none,section.story.plain{grid-template-columns:minmax(0,1fr)}
section.story h2{margin-top:0}
section.story figure{margin-top:4px}
@media (max-width:760px){section.story{grid-template-columns:minmax(0,1fr)}}
@media print{@page{size:A4 landscape;margin:14mm}section.story{break-before:page;margin:0}section.story:first-of-type{break-before:auto}}
"""

SLIDES_CSS = """
main{max-width:1000px;padding-top:32px}
.slide{position:relative;width:100%;aspect-ratio:16/9;background:var(--white);border-radius:12px;margin:0 0 28px;
padding:44px 56px;display:flex;flex-direction:column;gap:14px;overflow:hidden;box-shadow:0 0 0 1px rgba(var(--ink-rgb),.08)}
.slide h2{font-size:30px;margin:0}
.slide.layout-title{justify-content:center}
.slide.layout-title h2{font-size:40px}
.slide .body{display:flex;gap:28px;flex:1;min-height:0}
.slide .copy{flex:1;min-width:0;font-size:19px}
.slide .figs{flex:1;min-width:0;display:grid;gap:12px;align-content:start}
.slide .figs figure{margin:0}
.slide .figs img{max-height:360px;width:auto;max-width:100%;object-fit:contain}
.slide .num{position:absolute;right:20px;bottom:14px;font-size:12px;color:var(--ink-500)}
.speaker{font-size:13px;color:var(--ink-500);margin:-16px 4px 28px}
.slide .figs{overflow:hidden}.slide .figs figcaption{font-size:12px;margin-top:4px}
.deck-title{font-size:15px;color:var(--ink-500);margin:0 0 16px}
@media print{@page{size:13.333in 7.5in;margin:0}html,body{background:var(--white)}main{max-width:none;padding:0}
.deck-title{display:none}.slide{width:13.333in;height:7.5in;aspect-ratio:auto;border-radius:0;box-shadow:none;margin:0;
break-after:page;padding:.6in .8in}.slide .figs img{max-height:4.2in}.speaker{display:none}.notes{break-before:page;padding:.6in .8in;margin:0;border:0}}
"""


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
    return "".join(f'<sup class="cite"><a href="#note-{n}" id="cite-{n}">{n}</a></sup>' for n in ns)


def _sentence_html(s: dict[str, Any]) -> str:
    return inline_html(s["text"]) + _cites_html(s["notes"])


def _para_html(p: dict[str, Any]) -> str:
    if p["kind"] == "divider":
        return "<hr>"
    bullets = [s for s in p["sentences"] if s["bullet"]]
    if bullets and len(bullets) == len(p["sentences"]):
        return "<ul>" + "".join(f"<li>{_sentence_html(s)}</li>" for s in bullets) + "</ul>"
    text = " ".join(_sentence_html(s) for s in p["sentences"])
    if p["kind"] == "quote":
        return f"<blockquote>{text}" + (f'<span class="who">— {_esc(p["speaker"])}</span>' if p["speaker"] else "") + "</blockquote>"
    if p["kind"] in ("headline", "callout"):
        return f'<p class="{p["kind"]}">{text}</p>'
    return f"<p>{text}</p>"


def _figure_html(f: dict[str, Any], pics: dict[str, dict[str, Any]]) -> str:
    pic = pics.get(f["card"]) or {}
    cap = (f'<figcaption>{inline_html(f["caption"])}{_cites_html(f["notes"])}</figcaption>' if f["caption"]
           else "")
    return f'<figure id="card-{_esc(f["card"])}">{card_html(pic)}{cap}</figure>'


def card_html(pic: dict[str, Any]) -> str:
    """A card as the export shows it: its picture, else its table, else its title and text."""
    if pic.get("png"):
        w = pic.get("width")
        size = f' width="{int(w)}"' if w else ""
        return f'<img alt="{_esc(pic.get("title"))}"{size} src="data:image/png;base64,{pic["png"]}">'
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
        items.append(f'<li id="note-{r["n"]}">{label}{quote} <a href="#cite-{r["n"]}" aria-label="Back">↩</a></li>')
    return f'<section class="notes"><h2>Sources</h2><ol>{"".join(items)}</ol></section>'


def _unit_body(u: dict[str, Any], pics: dict[str, dict[str, Any]]) -> str:
    """A section's paragraphs with each figure after the paragraph it follows, the rest at the end."""
    placed: dict[Any, list[str]] = {}
    tail: list[str] = []
    ids = {p["id"] for p in u["paragraphs"]}
    for f in u["figures"]:
        (placed.setdefault(f["after"], []) if f["after"] in ids and f["after"] is not None else tail).append(_figure_html(f, pics))
    out = []
    for p in u["paragraphs"]:
        out.append(_para_html(p))
        out += placed.get(p["id"], [])
    return "".join(out + tail)


def to_html(m: dict[str, Any], pics: dict[str, dict[str, Any]], *, faces: str | None = None) -> str:
    """The document as one self-contained HTML file."""
    faces = font_faces() if faces is None else faces
    if m["renderer"] == "video":
        from . import film_export  # noqa: PLC0415

        return film_export.player_html(m, faces)
    if m["page_html"] is not None:
        return _page_html(m, faces)
    css, parts = BASE_CSS, []
    lead = f'<p class="lead">{" ".join(_sentence_html(s) for s in m["lead"])}</p>' if m["lead"] else ""
    if m["renderer"] == "slides":
        css += SLIDES_CSS
        parts.append(f'<p class="deck-title">{_esc(m["title"])}</p>')
        for k, u in enumerate(m["units"], 1):
            layout = u["layout"] or ("title" if k == 1 and not u["figures"] else "text")
            copy = "".join(_para_html(p) for p in u["paragraphs"])
            figs = "".join(_figure_html(f, pics) for f in u["figures"])
            head = f"<h2>{inline_html(u['heading'])}</h2>" if u["heading"] else ""
            body = f'<div class="body"><div class="copy">{copy}</div>' + (f'<div class="figs">{figs}</div>' if figs else "") + "</div>"
            speaker = f'<p class="speaker">{inline_html(u["speaker_notes"])}</p>' if u["speaker_notes"] else ""
            parts.append(f'<section class="slide layout-{_esc(layout)}">{head}{body}<span class="num">{k}</span></section>{speaker}')
    elif m["renderer"] == "story":
        css += STORY_CSS
        parts.append(f"<h1>{inline_html(m['title'])}</h1>{lead}")
        for u in m["units"]:
            side = u["side"] if u["side"] in ("left", "right", "full", "none") else "right"
            main_figs = [f for f in u["figures"] if f.get("role") in ("main", None)][:1] if side != "none" else []
            rest = {**u, "figures": [f for f in u["figures"] if f not in main_figs]}
            head = f"<h2>{inline_html(u['heading'])}</h2>" if u["heading"] else ""
            aside = "".join(_figure_html(f, pics) for f in main_figs)
            cls = f"side-{side}" if aside else "plain"
            parts.append(f'<section class="story {cls}"><div class="copy">{head}{_unit_body(rest, pics)}</div>'
                         + (f"<div>{aside}</div>" if aside else "") + "</section>")
    else:
        parts.append(f"<h1>{inline_html(m['title'])}</h1>{lead}")
        if m["claims"]:
            parts.append("<ul>" + "".join(f"<li>{_sentence_html(s)}</li>" for s in m["claims"]) + "</ul>")
        for u in m["units"]:
            if u["heading"]:
                lvl = min(4, max(2, u["level"]))
                parts.append(f"<h{lvl}>{inline_html(u['heading'])}</h{lvl}>")
            parts.append(_unit_body(u, pics))
    parts.append(_notes_html(m))
    return _document(m["title"], faces, css, "<main>" + "".join(parts) + "</main>")


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
        cols, _rows, grid = frames.frame_grid(fr, list(range(min(TABLE_ROWS, len(frames.row_labels(fr))))))
        head = "".join(f"<th>{_esc(x)}</th>" for x in cols)
        body = "".join("<tr>" + "".join(f"<td>{_esc(v)}</td>" for v in row) + "</tr>" for row in grid)
        return f"<table><thead><tr>{head}</tr></thead><tbody>{body}</tbody></table>", ""
    texts = [str(b.get("text/plain") or "") for b in cell.get("outputs") or [] if isinstance(b, dict) and b.get("text/plain")]
    text = "\n".join(t for t in [str(cell.get("takeaway") or "")] + texts if t).strip()
    return "", text[:TEXT_CHARS] + ("…" if len(text) > TEXT_CHARS else "")


async def card_pictures(c: str, cards: list[str], *, draw: bool) -> tuple[dict[str, dict[str, Any]], str]:
    """Each card as the export shows it (card_html's input), and why cards are not pictures when they are not."""
    from . import notebook, render  # noqa: PLC0415

    out: dict[str, dict[str, Any]] = {}
    why = "" if draw else "the browser is off"
    for cid in dict.fromkeys(cards):
        cell = await asyncio.to_thread(notebook.get_cell, c, cid)
        if cell is None:
            out[cid] = {"title": f"card:{cid} (deleted)"}
            continue
        pic: dict[str, Any] = {"title": _collapse(cell.get("title")) or f"card:{cid}"}
        if draw and not why:
            try:
                r = await render.render_card(c, cell)
            except render.Unavailable as e:
                why = str(e)
            else:
                if r.ok and r.png:
                    pic["png"] = base64.b64encode(r.png).decode("ascii")
                    pic["width"] = r.box.get("width")
        if "png" not in pic:
            pic["table"], pic["text"] = _card_text(cell)
        out[cid] = pic
    return out, why


# --------------------------------------------------------------------------- the browser


def _bundled_installed() -> bool:
    root = Path(os.environ.get("PLAYWRIGHT_BROWSERS_PATH") or Path.home() / ".cache" / "ms-playwright")
    return any(root.glob("chromium_headless_shell-*")) or any(root.glob("chromium-*"))


def system_browser() -> str:
    plat = "linux" if sys.platform.startswith("linux") else sys.platform
    for name in SYSTEM_BROWSERS.get(plat, ()):
        if "/" in name:
            if os.access(name, os.X_OK):
                return name
        elif found := shutil.which(name):
            return found
    return ""


def browser() -> tuple[str, str]:
    """(kind, path or why): thimble's config's choice (userconf.browser) where there is one, else the system browser,
    else Playwright's own when installed; `off` with the reason when there is none."""
    try:
        from . import userconf  # noqa: PLC0415 — 0.3.0's config
    except ImportError:
        userconf = None
    if userconf is not None:
        return userconf.browser(_bundled_installed)
    found = system_browser()
    if found:
        return "system", found
    return ("bundled", "") if _bundled_installed() else ("off", "no browser is installed (Chrome, Edge or Chromium)")


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
    from . import render  # noqa: PLC0415

    pw = await async_playwright().start()
    b = None
    try:
        try:
            b = await pw.chromium.launch(headless=True, **({"executable_path": what} if kind == "system" else {}))
        except Exception as e:  # noqa: BLE001
            raise RuntimeError(render._launch_why(e)) from e
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


async def fonts_loaded(page: Any) -> bool:
    return bool(await page.evaluate(
        "async () => { await document.fonts.ready; await document.fonts.load('16px \"Hanken Grotesk\"').catch(() => []);"
        " return document.fonts.check('16px \"Hanken Grotesk\"') }"))


async def print_pdf(html_text: str, renderer: str = "document") -> bytes:
    """The HTML printed by the browser: A4 for a report, the story's landscape pages, a 16:9 page per slide."""
    async with browser_page(1280, 900) as page:
        await page.set_content(html_text, wait_until="load")
        if not await fonts_loaded(page):
            log.warning("pdf export: Hanken Grotesk did not load; the fallback face is printed")
        await page.emulate_media(media="print")
        opts: dict[str, Any] = {"print_background": True, "prefer_css_page_size": True}
        if renderer not in ("slides", "story"):
            opts.update(format="A4", margin={"top": "18mm", "bottom": "18mm", "left": "16mm", "right": "16mm"})
        return await page.pdf(**opts)


# --------------------------------------------------------------------------- formats


def _extension_types(c: str) -> list[dict[str, Any]]:
    try:
        from . import extensions  # noqa: PLC0415
    except ImportError:
        return []
    try:
        return extensions.report_types(c)
    except Exception:  # noqa: BLE001 — a broken extension leaves the built-in formats
        log.warning("exports: the extensions' report types could not be read", exc_info=True)
        return []


def hook_of(c: str, slug: str) -> Path | None:
    """The export.py of the extension report type `slug`, if it ships one."""
    for t in _extension_types(c):
        if t.get("id") == slug and t.get("export"):
            p = Path(str(t["export"]))
            return p if p.is_file() else None
    return None


def hook_formats(path: Path) -> list[dict[str, str]]:
    """FORMATS of an export.py as literal values, read without running the file; [] when it has none or it is not a
    literal list of {id, name, ext}."""
    try:
        tree = ast.parse(path.read_text("utf-8"))
    except (OSError, SyntaxError, ValueError):
        return []
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "FORMATS" for t in node.targets):
            try:
                val = ast.literal_eval(node.value)
            except ValueError:
                return []
            out = []
            for f in val if isinstance(val, list) else []:
                if isinstance(f, dict) and re.fullmatch(r"[a-z0-9][a-z0-9-]{0,30}", str(f.get("id") or "")):
                    ext = re.sub(r"[^a-z0-9]", "", str(f.get("ext") or f["id"]).lower())[:8] or "txt"
                    out.append({"id": str(f["id"]), "name": str(f.get("name") or f["id"])[:40], "ext": ext})
            return out
    return []


def formats(c: str, slug: str, renderer: str) -> list[dict[str, Any]]:
    """The formats the document offers, each {id, name, ext, ok, why?, hook?}: the four that fit its kind, a report
    type's own added or in place of one, the ones the browser or an encoder is missing for marked not ok."""
    from . import film_export  # noqa: PLC0415

    kind, why_off = browser()
    ids = ["markdown", "html", "pdf"] + (["video"] if renderer == "video" else [])
    out: dict[str, dict[str, Any]] = {i: {"id": i, "name": FORMAT_INFO[i]["name"], "ext": FORMAT_INFO[i]["ext"], "ok": True}
                                      for i in ids}
    if renderer == "video":
        enc = film_export.encoder()
        out["video"]["ext"] = enc[0] if enc else "mp4"
    hook = hook_of(c, slug)
    for f in hook_formats(hook) if hook else []:
        out[f["id"]] = {**f, "ok": True, "hook": True}
    for f in out.values():
        needs_browser = f["ext"] == "pdf" or f["id"] == "video" or f["ext"] in ("mp4", "webm")
        if needs_browser and kind == "off":
            f.update(ok=False, why=f"Needs a browser: {why_off}")
        elif f["id"] == "video" and not f.get("hook") and film_export.encoder() is None:
            f.update(ok=False, why="Needs ffmpeg to write the video file")
    return list(out.values())


# --------------------------------------------------------------------------- the hook


async def run_hook(c: str, path: Path, doc: dict[str, Any], fmt: str, ctx: dict[str, Any]) -> dict[str, Any]:
    """export() of `path` on the workspace's exports kernel with the document, the format and the context's values;
    RuntimeError with the hook's error."""
    from . import notebook  # noqa: PLC0415

    tmp = config.workspace_dir(c) / "scratch" / "exports"
    tmp.mkdir(parents=True, exist_ok=True)
    tag = secrets.token_hex(6)
    req, res = tmp / f"{tag}.in.json", tmp / f"{tag}.out.json"
    req.write_text(json.dumps({"doc": doc, "fmt": fmt, "ctx": ctx}, ensure_ascii=False, default=str), "utf-8")
    code = HOOK_SRC.format(req=str(req), res=str(res), path=str(path), sentinel=SENTINEL)
    try:
        outputs, _n, status = await notebook.execute_on(c, KERNEL, code, timeout_s=HOOK_TIMEOUT_S)
        text = "".join(b.get("text/plain", "") for b in outputs if b.get("_stream") == "stdout")
        if status != "ok" or SENTINEL not in text:
            err = next((f"{e.get('ename', 'Error')}: {e.get('evalue', '')}" for b in outputs
                        if isinstance(e := b.get("application/vnd.thimble.error+json"), dict)), "")
            raise RuntimeError(err or "the export hook printed no result")
        return json.loads(res.read_text("utf-8"))
    finally:
        for p in (req, res):
            with contextlib.suppress(OSError):
                p.unlink()


HOOK_SRC = """
import base64 as _b64, json as _json, runpy as _runpy
def _thimble_export():
    req = _json.load(open({req!r}, encoding='utf-8'))
    ctx = req['ctx']
    class Ctx:
        def markdown(self): return ctx['markdown']
        def html(self): return ctx['html']
        def cite(self, ref): return ctx['cites'].get(ref) or {{'label': ref, 'quote': ''}}
        def figure(self, card): return ctx['figures'].get(str(card).removeprefix('card:'), '')
    mod = _runpy.run_path({path!r}, run_name='thimble_export')
    got = mod['export'](req['doc'], req['fmt'], Ctx())
    if not isinstance(got, dict):
        raise TypeError('export() must return a dict')
    if isinstance(got.get('bytes'), (bytes, bytearray)):
        got = dict(got, bytes=_b64.b64encode(got['bytes']).decode('ascii'), b64=True)
    with open({res!r}, 'w', encoding='utf-8') as f:
        _json.dump(got, f)
    print({sentinel!r} + 'ok')
_thimble_export()
del _thimble_export
"""


# --------------------------------------------------------------------------- export


def _filename(title: str, slug: str, ext: str) -> str:
    base = re.sub(r"[^A-Za-z0-9]+", "-", title).strip("-")[:60] or slug
    return f"{base}.{ext}"


async def export(c: str, inv_id: str, slug: str, fmt: str) -> tuple[bytes, str, str]:
    """(content, file name, mime) of the document in format `fmt`. HTTPException 404 for no document or no such format,
    409 for a format that cannot run here, with the reason."""
    from . import film_export, report_types  # noqa: PLC0415

    doc = await asyncio.to_thread(report_types.read_doc, c, inv_id, slug)
    if doc is None:
        raise HTTPException(404, f"no {slug} yet")
    t = report_types.read_type(c, slug) or {}
    renderer = str(doc.get("renderer") or t.get("renderer") or "document")
    offered = {f["id"]: f for f in await asyncio.to_thread(formats, c, slug, renderer)}
    f = offered.get(fmt)
    if f is None:
        raise HTTPException(404, f"{slug} has no export format {fmt!r}")
    if not f["ok"]:
        raise HTTPException(409, f["why"])
    m = await asyncio.to_thread(read_model, c, doc, renderer)
    name = lambda ext: _filename(m["title"], slug, ext)  # noqa: E731
    if fmt == "markdown" and not f.get("hook"):
        return to_markdown(m).encode("utf-8"), name("md"), FORMAT_INFO["markdown"]["mime"]
    if fmt == "video" and not f.get("hook"):
        data, ext = await film_export.render_video(m, voice=True)
        return data, name(ext), MIME_BY_EXT[ext]
    kind, _why = browser()
    cards = [x["card"] for u in m["units"] for x in u["figures"]]
    pics, _ = await card_pictures(c, cards, draw=kind != "off")
    if f.get("hook"):
        return await _hooked(c, slug, doc, f, m, pics)
    html_text = await asyncio.to_thread(to_html, m, pics)
    if fmt == "html":
        return html_text.encode("utf-8"), name("html"), FORMAT_INFO["html"]["mime"]
    if renderer == "video":
        return await film_export.frames_pdf(m), name("pdf"), FORMAT_INFO["pdf"]["mime"]
    try:
        return await print_pdf(html_text, renderer), name("pdf"), FORMAT_INFO["pdf"]["mime"]
    except RuntimeError as e:
        raise HTTPException(409, f"PDF needs a browser: {e}") from e


async def _hooked(c: str, slug: str, doc: dict[str, Any], f: dict[str, Any], m: dict[str, Any],
                  pics: dict[str, dict[str, Any]]) -> tuple[bytes, str, str]:
    from . import film_export  # noqa: PLC0415

    hook = hook_of(c, slug)
    if hook is None:
        raise HTTPException(404, f"{slug}'s export.py is gone")
    faces = font_faces()
    ctx = {"markdown": to_markdown(m), "html": to_html(m, pics, faces=faces),
           "cites": {r["ref"]: {"label": r["label"], "quote": r["quote"], "n": r["n"]} for r in m["notes"]},
           "figures": {cid: card_html(p) for cid, p in pics.items()}}
    try:
        got = await run_hook(c, hook, doc, f["id"], ctx)
    except RuntimeError as e:
        raise HTTPException(500, f"{slug}'s export.py failed: {e}") from e
    ext = f["ext"]
    name = _filename(m["title"], slug, ext)
    mime = str(got.get("mime") or MIME_BY_EXT.get(ext, "application/octet-stream"))
    if isinstance(got.get("film"), dict):
        data, vext = await film_export.render_film(got["film"], faces=faces)
        return data, _filename(m["title"], slug, vext), MIME_BY_EXT[vext]
    if isinstance(got.get("html"), str):
        if ext == "pdf":
            try:
                return await print_pdf(got["html"]), name, MIME_BY_EXT["pdf"]
            except RuntimeError as e:
                raise HTTPException(409, f"PDF needs a browser: {e}") from e
        return got["html"].encode("utf-8"), name, mime if got.get("mime") else MIME_BY_EXT["html"]
    if isinstance(got.get("markdown"), str):
        return got["markdown"].encode("utf-8"), name, mime if got.get("mime") else MIME_BY_EXT["md"]
    if isinstance(got.get("bytes"), str):
        data = base64.b64decode(got["bytes"]) if got.get("b64") else got["bytes"].encode("utf-8")
        return data, name, mime
    raise HTTPException(500, f"{slug}'s export.py returned none of markdown, html, film or bytes")


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
    t = report_types.read_type(c, slug) or {}
    renderer = str((doc or {}).get("renderer") or t.get("renderer") or "document")
    return {"formats": await asyncio.to_thread(formats, c, slug, renderer) if doc else []}


@router.get("/ws/{c}/investigations/{inv_id}/types/{slug}/export/{fmt}")
async def export_route(c: str, inv_id: str, slug: str, fmt: str) -> Response:
    slug = _slug(c, inv_id, slug)
    data, name, mime = await export(c, inv_id, slug, fmt)
    return Response(content=data, media_type=mime,
                    headers={"Content-Disposition": f'attachment; filename="{name}"', "X-Export-Name": name})
