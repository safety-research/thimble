"""A written document exported as a file: Markdown, HTML or PDF, or as a page to publish as a Claude artifact.

Every format starts from one reading of the document (read_model): its title, units (a report's sections) and their
figures; a card a sentence names as a noun is written as the card's title (report_types.card_nouns). An export holds
those alone, unless the Export menu asks for more: `citations`, numbered in order of first use, with the citation
check's mark on a sentence nothing shows; `comments`, the comments the report's margin shows (comments_of), each after
the passage it is on. Markdown writes the citations as footnotes and a comment as a quote under its passage; HTML is one
self-contained file (fonts, pictures and styles inlined) with the citations as numbered notes linked from the text, set
as the report is on the page, in its faces and sizes on white, each figure the card's question, its art and its
caption, each comment beside a rule in its check's color, the passage it is on tinted in that color as on the page; PDF
is that HTML printed by the browser on A4 pages, a heading kept with what follows it and a figure, a table row, a
comment or a note never split. The artifact's page (to_artifact)
is that HTML made to claude.ai's rules for an artifact: nothing loaded from elsewhere, light and dark from tokens, each
figure's art drawn on both papers, readable at a phone's width; main publishes it (artifact_export.py), and where it
cannot, the page downloads. A page document, whose HTML is its own, has no artifact export.

The browser: the one thimble's config names (userconf.browser): the system's Chrome, Edge or Chromium, else Playwright's
own Chromium when it is installed. A figure's art comes from the card harness (render.render_figure), drawn as the
report's figure draws it; without a browser a figure is its card's table or its text, and PDF is offered disabled with
the reason.
"""
from __future__ import annotations

import asyncio
import base64
import contextlib
import html as _html
import logging
import os
import re
from pathlib import Path
from typing import Any, AsyncIterator

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response

from . import config, frames, headless, investigation, refs, userconf
from .kernel_thimble import LABEL_COLOURS
from .report import _collapse, plain_text

log = logging.getLogger("thimble.exports")
router = APIRouter()

FORMAT_INFO = {
    "markdown": {"name": "Markdown", "ext": "md", "mime": "text/markdown; charset=utf-8"},
    "html": {"name": "HTML", "ext": "html", "mime": "text/html; charset=utf-8"},
    "pdf": {"name": "PDF", "ext": "pdf", "mime": "application/pdf"},
    # published as a link (artifact_export.py), which the menu notes in place of an extension
    "artifact": {"name": "Claude artifact", "ext": "html", "mime": "text/html; charset=utf-8", "note": "link"},
}
NEEDS_BROWSER = ("pdf",)  # its figures are pictures, which the card harness draws
QUOTE_CHARS = 240  # of a cited record, in its note
TEXT_CHARS = 1200  # of a card's text when it is shown without a picture
TABLE_ROWS = 30
FIGURE_W = 640  # px: the text column of the HTML and PDF, which a figure's art is laid out as wide as (render_figure)
# how many times larger than its layout a figure's art is drawn: with the harness's 2 device px per px, a picture of 3
# px per px, about 290 dpi in the PDF's column
FIGURE_ZOOM = 1.5
# the page an export is set on, Neutral's white (frontend styles/tokens.css), which its figures' art is drawn on
# (render.export_theme)
PAPER = "#ffffff"
DARK = "dark"  # the paper the art of an artifact's figures is drawn on for its dark theme (to_artifact)
# a comment's check's color on Dark, by its palette place as LABEL_COLOURS has it on the light papers (frontend
# styles/tokens.css, Dark's --label-none and --label-1..18), which the artifact's dark theme draws a comment's rule and
# tint in
LABEL_DARK = ("#a09c93", "#2275e8", "#da7306", "#17a973", "#0c9edc", "#beb222", "#5fcfca", "#9b7239", "#9ebdff", "#50c14d",
              "#0985b4", "#f6b896", "#0bb8d6", "#ef5b51", "#f7a39c", "#a585f5", "#cdb9ff", "#ec6aa8", "#f6b0d2")
# the name over a comment no check left: Claude's for a note of main's, else the analyst's own, which the page calls You
NOTE_NAMES = {"claude": "Claude"}
COMMENT_NAME = "Comment"
UNVERIFIED = "unverified"  # the check the citation check's unverified tags belong to (checks.RETIRED)
_MARK_RE = re.compile(r"\[([^\]]*)\]\(#\)")  # a citation mark in a card's text, `[words](#)`
_INLINE_RE = re.compile(r"\*\*(.+?)\*\*|(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])|`([^`]+)`|\[([^\]]+)\]\((https?://[^)\s]+)\)")


# --------------------------------------------------------------------------- the document, read once


class Notes:
    """The document's citations, numbered in order of first use; each {n, ref, label, quote, card, title}. A card's
    question (`title`) stands in the first note of the card and in a note of the whole card; a line of a JSON Lines file
    is not quoted, since its label names the file, the line and the record's id and time."""

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
        try:
            p = refs.parse_ref(ref)
        except ValueError:
            p = {}
        card = str(p["cell_id"]) if p.get("kind") == "cell" else None
        jsonl = p.get("kind") in ("record", "range", "block", "span") and str(p.get("path") or "").endswith(".jsonl")
        quote = ""
        if self.corpus is not None and not jsonl:
            try:
                res = refs.resolve(self.corpus, ref) or {}
            except Exception:  # noqa: BLE001 — a ref that no longer resolves keeps its label
                res = {}
            quote = "" if re.fullmatch(r"card:[0-9a-f]{8}", ref) else _collapse(res.get("excerpt") or "")
            if len(quote) > QUOTE_CHARS:
                quote = quote[: QUOTE_CHARS - 1].rstrip() + "…"
        first = card is not None and all(r["card"] != card for r in self.rows)
        whole = re.fullmatch(r"card:[0-9a-f]{8}", ref) is not None
        title = self.cites.titles.get(card, "") if card and (first or whole) else ""
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


def _sentence(x: dict[str, Any], notes: Notes, cite: bool) -> dict[str, Any]:
    """A sentence as an export writes it: its words, and with `cite` its citations' numbers and the citation check's
    mark when nothing shows it."""
    from .report_types import UNVERIFIED_MARK, _sentence_refs, card_nouns  # noqa: PLC0415

    text = plain_text(card_nouns(str(x.get("text") or ""), notes.cites))
    if cite and "unverified" in (x.get("tags") or []):
        text += f" {UNVERIFIED_MARK}"
    # a list item's marker, "1." for a numbered list, else "-"; None for a sentence of prose
    bullet = ("1." if x.get("bullet") == "1." else "-") if x.get("bullet") else None
    return {"id": str(x.get("id") or ""), "text": text, "notes": notes.of(_sentence_refs(x)) if cite else [],
            "bullet": bullet}


def _figure(f: Any, notes: Notes, cite: bool) -> dict[str, Any] | None:
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


def comments_of(c: str, doc: dict[str, Any]) -> dict[str, list[dict[str, Any]]]:
    """The comments the report's margin shows (frontend report/checkComments openComments and shownComments), by the id
    of the passage each is on (a sentence, the first sentence of a paragraph for one on the whole paragraph, a section's
    heading, the title): the open ones, the analyst's and Claude's always and a check's while that check is on, then the
    citation check's unverified tags where its check is on and left none. Each {name, colour, text, details, whole}:
    the check's name and its palette place, else NOTE_NAMES or COMMENT_NAME and the place of no match (0); its
    statement and its details, their citations flattened to their values; whether it is on its whole paragraph."""
    from . import checks, report_types  # noqa: PLC0415

    on = {str(x["id"]): x for x in checks.list_checks(c) if x.get("shown")}
    place = lambda check: int(check.get("colour")) if check.get("colour") in range(len(LABEL_COLOURS)) else 0  # noqa: E731
    out: dict[str, list[dict[str, Any]]] = {}
    marked: set[str] = set()
    for cm in doc.get("comments") or []:
        if not isinstance(cm, dict) or (cm.get("status") or "open") != "open":
            continue
        sid, text = str(cm.get("sentence_id") or ""), plain_text(str(cm.get("text") or ""))
        check = str(cm["check"]) if cm.get("check") else None
        if not sid or not text:
            continue
        if check == UNVERIFIED:
            marked.add(sid)
        if check is not None and check not in on:
            continue
        name = (on[check].get("name") or check) if check else NOTE_NAMES.get(str(cm.get("author")), COMMENT_NAME)
        out.setdefault(sid, []).append({"name": str(name), "colour": place(on[check]) if check else 0, "text": text,
                                        "details": str(cm.get("details") or "").strip(), "whole": cm.get("paragraph") is True})
    if UNVERIFIED in on:
        for x in report_types.all_sentences(doc):
            sid = str(x.get("id") or "")
            if sid and sid not in marked and "unverified" in (x.get("tags") or []):
                note = str(((x.get("tag_notes") or {}) if isinstance(x.get("tag_notes"), dict) else {}).get("unverified") or "")
                out.setdefault(sid, []).append({"name": str(on[UNVERIFIED].get("name") or UNVERIFIED),
                                                "colour": place(on[UNVERIFIED]), "text": plain_text(note) or "Not checked",
                                                "details": "", "whole": False})
    return out


def _placed(sentences: list[dict[str, Any]], by: dict[str, list[dict[str, Any]]]) -> list[dict[str, Any]]:
    """The comments on `sentences` (a paragraph, a list, a page's claims) in their order, which an export sets after
    them. A sentence a comment is on takes the colour of its first as its tint (`tint`), and each sentence of a paragraph
    a comment on the whole paragraph is on, as the page tints them."""
    out = [cm for x in sentences for cm in by.get(x["id"], [])]
    for x in sentences:
        if by.get(x["id"]):
            x["tint"] = by[x["id"]][0]["colour"]
    for cm in out:
        for x in sentences if cm["whole"] else []:
            x.setdefault("tint", cm["colour"])
    return out


def read_model(c: str, doc: dict[str, Any], *, citations: bool = False, comments: bool = False) -> dict[str, Any]:
    """The document as every format reads it (module note): with `citations` its citations, with `comments` the comments
    the page shows, each list of them after the passage they are on (`comments` of the title, a claims list, a heading,
    a paragraph)."""
    from . import report_types  # noqa: PLC0415

    notes = Notes(c)
    by = comments_of(c, doc) if comments else {}
    title = _collapse(doc.get("title")) or _collapse(doc.get("type")) or "Report"
    claims = [_sentence(x, notes, citations) for x in doc.get("claims") or [] if isinstance(x, dict)] if doc.get("html") else []
    units: list[dict[str, Any]] = []
    for u in report_types.units(doc):
        paras = [{"id": p.get("id"), "sentences": [_sentence(x, notes, citations) for x in p.get("sentences") or [] if isinstance(x, dict)]}
                 for p in u.get("paragraphs") or [] if isinstance(p, dict)]
        paras = [{**p, "comments": _placed(p["sentences"], by)} for p in paras if p["sentences"]]
        figs = [f for f in (_figure(x, notes, citations) for x in u.get("figures") or []) if f]
        heading = _collapse(u.get("heading"))
        units.append({"heading": heading, "level": report_types._level(u.get("level")),
                      "tldr": report_types._is_tldr(u.get("heading")), "paragraphs": paras, "figures": figs,
                      "comments": by.get(str(u.get("id")), []) if heading else []})
    units.sort(key=lambda u: 0 if u["tldr"] else 1)
    return {"title": title, "comments": by.get(report_types.TITLE_BLOCK, []), "claims": claims,
            "claims_comments": _placed(claims, by), "units": units, "notes": notes.rows,
            "page_html": doc.get("html") if isinstance(doc.get("html"), str) else None}


# --------------------------------------------------------------------------- Markdown


def _md_sentence(s: dict[str, Any]) -> str:
    return s["text"] + "".join(f"[^{n}]" for n in s["notes"])


_ITEM_RE = re.compile(r"^(?:[-*]|\d+[.)])\s+")  # a list item's marker at the start of a line of a comment's details


def detail_blocks(details: str) -> list[list[str]]:
    """A comment's details as its blocks (paragraphs, lists), each its lines, their citations flattened to their values
    as the comment's statement is (report.plain_text)."""
    blocks = [[plain_text(line) for line in b.splitlines() if line.strip()] for b in re.split(r"\n\s*\n", details or "")]
    return [b for b in blocks if any(b)]


def _md_comments(cms: list[dict[str, Any]]) -> list[str]:
    """Comments as Markdown, each a quote under its passage: the name of its check (or who left it) bold, its statement,
    then its details."""
    out: list[str] = []
    for cm in cms:
        out.append(f"> **{cm['name']}:** {cm['text']}")
        for block in detail_blocks(cm["details"]):
            out += [">", *(f"> {line}" for line in block)]
        out.append("")
    return out


def to_markdown(m: dict[str, Any]) -> str:
    """The document as Markdown, each citation a footnote naming what it cites and quoting it, each comment a quote under
    its passage."""
    out = [f"# {m['title']}", ""] + _md_comments(m["comments"])
    for s in m["claims"]:
        out.append(f"- {_md_sentence(s)}")
    if m["claims"]:
        out += [""] + _md_comments(m["claims_comments"])
    for u in m["units"]:
        if u["heading"]:
            out += [f"{'#' * max(2, u['level'])} {u['heading']}", ""] + _md_comments(u["comments"])
        for p in u["paragraphs"]:
            bullets = [s for s in p["sentences"] if s["bullet"]]
            if bullets and len(bullets) == len(p["sentences"]):
                out += [f"{s['bullet']} {_md_sentence(s)}" for s in bullets] + [""] + _md_comments(p["comments"])
                continue
            out += [" ".join(_md_sentence(s) for s in p["sentences"]), ""] + _md_comments(p["comments"])
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


# thimble's tokens, which a page (a custom type written as HTML) may name in its own styles (_page_html)
TOKENS_CSS = """:root{--paper-0:#fbfaf7;--paper-1:#f5f3ee;--white:#fffdf8;--ink-900:#000;--ink-700:#4a4844;--ink-500:#64625b;
--ink-300:#c6c2b9;--ink-rgb:27,26,24;--font-body:'Hanken Grotesk',system-ui,sans-serif;--font-mono:'Geist Mono',ui-monospace,monospace}"""
# A comment under its passage (_comments_html): its check's name over its statement and its details, beside a 2 px
# rule in its check's color (--cm), which tints its passage at 16% (_tinted), as the page tints one (styles/report.css
# .wu-flag).
COMMENT_CSS = """.cm{display:flex;gap:10px;margin:0 0 12px;font-size:13px;line-height:1.55;color:var(--ink-700);break-inside:avoid}
.cm::before{content:'';flex:none;width:2px;background:var(--cm)}
.cm>div{min-width:0}
.cm-name{font-size:12px;font-weight:500;color:var(--ink-900)}
.cm p,.cm ul,.cm ol{margin:2px 0 0}
.cm ul,.cm ol{padding-left:18px}
.cm-more{color:var(--ink-500)}
.cm-on{background:color-mix(in oklab,var(--cm) 16%,transparent);border-radius:2px;-webkit-box-decoration-break:clone;
box-decoration-break:clone}"""
# The report as the page sets it (frontend styles/report.css): Hanken Grotesk at 15/1.7 on white (PAPER) in Neutral's
# inks, the title at 28/600 and a section at 18/600, a column as wide as a figure's art (FIGURE_W); a figure is its card's
# question, its art and its caption beside the 2 px ink rule; a comment as COMMENT_CSS sets it. In print a heading stays
# with what follows it, a figure, a list item, a table row, a comment and a note are never split, and a figure's art
# taller than a page is drawn smaller, whole.
BASE_CSS = f"""
:root{{--ink-700:#47474c;--ink-500:#636368;--ink-rgb:24,24,27}}
*{{box-sizing:border-box}}
html{{background:{PAPER};color:var(--ink-900);font-family:var(--font-body);font-size:15px;line-height:1.7;
-webkit-font-smoothing:antialiased;-webkit-print-color-adjust:exact;print-color-adjust:exact}}
body{{margin:0;background:{PAPER}}}
main{{max-width:{FIGURE_W + 48}px;margin:0 auto;padding:56px 24px 72px}}
h1{{font-size:28px;line-height:1.2;font-weight:600;letter-spacing:-.02em;margin:0 0 18px}}
h2{{font-size:18px;line-height:1.3;font-weight:600;letter-spacing:-.01em;margin:30px 0 8px}}
h3,h4{{font-size:14px;line-height:1.4;font-weight:500;margin:20px 0 6px}}
h1,h2,h3,h4{{break-after:avoid}}
p{{margin:0 0 10px;orphans:3;widows:3}}
ul,ol{{margin:0 0 10px;padding-left:22px}}
li{{margin:0 0 2px;break-inside:avoid}}
strong{{font-weight:500}}
a{{color:inherit}}
code{{font-family:var(--font-mono);font-size:.86em;background:rgba(var(--ink-rgb),.06);padding:1px 4px;border-radius:2px}}
sup.cite{{font-size:.68em;line-height:0;margin-left:1px;color:var(--ink-500)}}
sup.cite a{{text-decoration:none;color:var(--ink-500);font-weight:500}}
sup.cite a:hover{{color:var(--ink-900)}}
figure{{margin:18px 0 22px;break-inside:avoid}}
.fig-q{{font-size:14px;line-height:1.35;font-weight:500;margin:0 0 10px}}
figure img{{display:block;max-width:100%;height:auto}}
figcaption{{display:flex;gap:10px;margin-top:10px;font-size:13px;line-height:1.55;color:var(--ink-700)}}
figcaption::before{{content:'';flex:none;width:2px;background:var(--ink-900)}}
.fig-text pre{{font-family:var(--font-mono);font-size:12px;white-space:pre-wrap;margin:0;color:var(--ink-700)}}
.fig-text table{{border-collapse:collapse;font-size:13px;width:100%}}
.fig-text th,.fig-text td{{text-align:left;padding:3px 8px;border-bottom:1px solid rgba(var(--ink-rgb),.1)}}
.fig-text th{{font-weight:500;color:var(--ink-500)}}
tr{{break-inside:avoid}}
{COMMENT_CSS}
.notes{{margin-top:44px;padding-top:14px;border-top:1px solid rgba(var(--ink-rgb),.14);font-size:12px;line-height:1.5;
color:var(--ink-700)}}
.notes h2{{font-size:13px;margin:0 0 8px;color:var(--ink-500);font-weight:500;letter-spacing:0}}
.notes ol{{padding-left:24px;margin:0}}
.notes .ref{{font-family:var(--font-mono);font-size:11px;color:var(--ink-900)}}
.notes q{{color:var(--ink-500)}}
@media print{{main{{max-width:none;padding:0}}a{{text-decoration:none}}figure img{{max-height:230mm;width:auto}}}}
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
    if not ns:
        return ""
    return '<sup class="cite">' + ",".join(f'<a href="#note-{n}">{n}</a>' for n in ns) + "</sup>"


def _cm_style(colour: int, themed: bool = False) -> str:
    """The style attribute that gives an element a comment's check's color: on white (`--cm`), or on the artifact's page
    (`themed`) its color on both papers, of which its theme takes one (ARTIFACT_CSS)."""
    at = colour if 0 <= colour < len(LABEL_COLOURS) else 0
    return (f' style="--cm-light:{LABEL_COLOURS[at]};--cm-dark:{LABEL_DARK[at]}"' if themed
            else f' style="--cm:{LABEL_COLOURS[at]}"')


def _tinted(words: str, colour: int | None, themed: bool = False) -> str:
    """A passage's words, tinted in the color of the first comment on it (`colour`, None for none), as the page tints a
    commented passage."""
    return words if colour is None else f'<span class="cm-on"{_cm_style(colour, themed)}>{words}</span>'


def _sentence_html(s: dict[str, Any], themed: bool = False) -> str:
    return _tinted(inline_html(s["text"]) + _cites_html(s["notes"]), s.get("tint"), themed)


def _para_html(p: dict[str, Any], themed: bool = False) -> str:
    bullets = [s for s in p["sentences"] if s["bullet"]]
    if bullets and len(bullets) == len(p["sentences"]):
        tag = "ol" if all(s["bullet"] == "1." for s in bullets) else "ul"
        return f"<{tag}>" + "".join(f"<li>{_sentence_html(s, themed)}</li>" for s in bullets) + f"</{tag}>"
    # sentences side by side in one tint read as one passage, the space between them tinted too, as on the page
    runs: list[tuple[int | None, list[str]]] = []
    for s in p["sentences"]:
        words = inline_html(s["text"]) + _cites_html(s["notes"])
        if runs and s.get("tint") is not None and runs[-1][0] == s.get("tint"):
            runs[-1][1].append(words)
        else:
            runs.append((s.get("tint"), [words]))
    return f"<p>{' '.join(_tinted(' '.join(words), tint, themed) for tint, words in runs)}</p>"


def _comments_html(cms: list[dict[str, Any]], themed: bool = False) -> str:
    """Comments as an export sets them after their passage: each beside a rule in its check's color, the name of its
    check (or who left it) over its statement, then its details in the quieter ink."""
    out = []
    for cm in cms:
        more = "".join(_detail_html(b) for b in detail_blocks(cm["details"]))
        out.append(f'<aside class="cm"{_cm_style(cm["colour"], themed)}><div><div class="cm-name">{_esc(cm["name"])}</div>'
                   f'<p>{inline_html(cm["text"])}</p>{more}</div></aside>')
    return "".join(out)


def _detail_html(lines: list[str]) -> str:
    """A block of a comment's details: a list when each of its lines is a list item, else a paragraph."""
    if all(_ITEM_RE.match(x) for x in lines):
        tag = "ol" if all(x[0].isdigit() for x in lines) else "ul"
        return f'<{tag} class="cm-more">' + "".join(f"<li>{inline_html(_ITEM_RE.sub('', x))}</li>" for x in lines) + f"</{tag}>"
    return f'<p class="cm-more">{inline_html(" ".join(lines))}</p>'


def _figure_html(f: dict[str, Any], pics: dict[str, dict[str, Any]], dark: dict[str, dict[str, Any]] | None = None) -> str:
    """A figure as the report's page shows it: its card's question, its art and its caption."""
    pic = pics.get(f["card"]) or {}
    q = f'<div class="fig-q">{_esc(pic["question"])}</div>' if pic.get("question") else ""
    cap = (f'<figcaption><span>{inline_html(f["caption"])}{_cites_html(f["notes"])}</span></figcaption>' if f["caption"]
           else "")
    art = card_html(pic, (dark or {}).get(f["card"]))
    return f'<figure id="card-{_esc(f["card"])}">{q}{art}{cap}</figure>'


def card_html(pic: dict[str, Any], dark: dict[str, Any] | None = None) -> str:
    """A figure's art as the export shows it: its picture, else its card's table, else its card's text. With `dark`, the
    same art drawn on Dark (to_artifact), both pictures, each shown in its theme (ARTIFACT_CSS)."""
    if pic.get("png"):
        if dark and dark.get("png"):
            return _img(pic, pic, "art-light") + _img(pic, dark, "art-dark")
        return _img(pic, pic)
    body = pic.get("table") or (f"<pre>{_esc(pic['text'])}</pre>" if pic.get("text") else "")
    return f'<div class="fig-text">{body}</div>' if body else ""


def _img(pic: dict[str, Any], drawn: dict[str, Any], cls: str = "") -> str:
    """The picture of `drawn` (a figure_pictures entry) at the px it stands in, its alt text the question of `pic`."""
    size = "".join(f' {k}="{int(drawn[k])}"' for k in ("width", "height") if drawn.get(k))
    named = f' class="{cls}"' if cls else ""
    return f'<img{named} alt="{_esc(pic.get("question"))}"{size} src="data:image/png;base64,{drawn["png"]}">'


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


def unit_blocks(u: dict[str, Any]) -> list[tuple[str, dict[str, Any]]]:
    """A section's paragraphs and figures in the order the page shows them (frontend report/model blocksFromDoc): the
    figures that lead it, then each paragraph with the figures that follow it, then the figures placed after no
    paragraph it has; each ("paragraph" or "figure", the item)."""
    ids = {p["id"] for p in u["paragraphs"]}
    rest = [f for f in u["figures"] if not f.get("lead")]
    out: list[tuple[str, dict[str, Any]]] = [("figure", f) for f in u["figures"] if f.get("lead")]
    for p in u["paragraphs"]:
        out += [("paragraph", p)] + [("figure", f) for f in rest if f["after"] is not None and f["after"] == p["id"]]
    return out + [("figure", f) for f in rest if f["after"] is None or f["after"] not in ids]


def _unit_body(u: dict[str, Any], pics: dict[str, dict[str, Any]], dark: dict[str, dict[str, Any]] | None = None) -> str:
    themed = dark is not None
    return "".join(_para_html(x, themed) + _comments_html(x["comments"], themed) if kind == "paragraph"
                   else _figure_html(x, pics, dark) for kind, x in unit_blocks(u))


def to_html(m: dict[str, Any], pics: dict[str, dict[str, Any]], *, faces: str | None = None) -> str:
    """The document as one self-contained HTML file."""
    faces = font_faces() if faces is None else faces
    if m["page_html"] is not None:
        return _page_html(m, faces)
    return _document(m["title"], faces, TOKENS_CSS + BASE_CSS, _main_html(m, pics))


def _main_html(m: dict[str, Any], pics: dict[str, dict[str, Any]], dark: dict[str, dict[str, Any]] | None = None) -> str:
    """The document's title, sections, figures, comments and notes, as `<main>`; with `dark` (the artifact's page), each
    figure's art and each comment's color on Dark too."""
    themed = dark is not None
    first = lambda cms: cms[0]["colour"] if cms else None  # noqa: E731 — the tint of a passage with comments
    parts = [f"<h1>{_tinted(inline_html(m['title']), first(m['comments']), themed)}</h1>", _comments_html(m["comments"], themed)]
    if m["claims"]:
        parts.append("<ul>" + "".join(f"<li>{_sentence_html(s, themed)}</li>" for s in m["claims"]) + "</ul>")
        parts.append(_comments_html(m["claims_comments"], themed))
    for u in m["units"]:
        if u["heading"]:
            lvl = min(4, max(2, u["level"]))
            parts.append(f"<h{lvl}>{_tinted(inline_html(u['heading']), first(u['comments']), themed)}</h{lvl}>")
            parts.append(_comments_html(u["comments"], themed))
        parts.append(_unit_body(u, pics, dark))
    parts.append(_notes_html(m))
    return "<main>" + "".join(parts) + "</main>"


def _document(title: str, faces: str, css: str, body: str) -> str:
    return (f'<!doctype html><html lang="en"><head><meta charset="utf-8">'
            f'<meta name="viewport" content="width=device-width,initial-scale=1"><title>{_esc(title)}</title>'
            f"<style>{faces}{css}</style></head><body>{body}</body></html>")


def _page_html(m: dict[str, Any], faces: str) -> str:
    """A page (a custom type written as HTML) as its own file, with thimble's faces and tokens added."""
    page = m["page_html"] or ""
    head = f"<style>{faces}{TOKENS_CSS}</style>"
    if re.search(r"<head[^>]*>", page, re.I):
        return re.sub(r"(<head[^>]*>)", lambda mm: mm.group(1) + '<meta charset="utf-8">' + head, page, count=1, flags=re.I)
    return _document(m["title"], faces, TOKENS_CSS, page)


# --------------------------------------------------------------------------- a Claude artifact's page

# The report as the page sets it (BASE_CSS) in the two themes an artifact shows: Neutral's white and inks, and Dark's
# card and inks (frontend styles/tokens.css), as tokens that the viewer's theme picks (its data-theme, else the system's
# scheme). Each figure's art is drawn on both papers and the theme shows one (--art-light, --art-dark), and a comment's
# rule and tint take its check's color on the paper shown (--cm-light, --cm-dark, _cm_style). The column is as
# wide as a figure's art, with the side gutter claude.ai asks for at a phone's width; a picture, a table or a long name
# never widens the page.
ARTIFACT_DARK = ("--paper:#25252a;--ink-900:#fdfcfa;--ink-700:#e2dfd8;--ink-500:#b8b5ad;--ink-rgb:248,246,242;"
                 "--art-light:none;--art-dark:block;color-scheme:dark")
ARTIFACT_CSS = f"""
:root{{--paper:{PAPER};--ink-900:#000000;--ink-700:#47474c;--ink-500:#636368;--ink-rgb:24,24,27;--art-light:block;
--art-dark:none;--font-body:'Hanken Grotesk',system-ui,-apple-system,'Segoe UI',sans-serif;
--font-mono:'Geist Mono',ui-monospace,SFMono-Regular,Menlo,monospace}}
@media (prefers-color-scheme:dark){{:root:not([data-theme="light"]){{{ARTIFACT_DARK}}}}}
:root[data-theme="dark"]{{{ARTIFACT_DARK}}}
*{{box-sizing:border-box}}
body{{margin:0;background:var(--paper);color:var(--ink-900);font-family:var(--font-body);font-size:15px;line-height:1.7;
-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%;padding-left:max(16px,env(safe-area-inset-left,0px));
padding-right:max(16px,env(safe-area-inset-right,0px))}}
main{{max-width:{FIGURE_W}px;margin:0 auto;padding-block:48px 72px}}
h1{{font-size:28px;line-height:1.2;font-weight:600;letter-spacing:-.02em;margin:0 0 18px;text-wrap:balance}}
h2{{font-size:18px;line-height:1.3;font-weight:600;letter-spacing:-.01em;margin:30px 0 8px;text-wrap:balance}}
h3,h4{{font-size:14px;line-height:1.4;font-weight:500;margin:20px 0 6px}}
p{{margin:0 0 10px}}
ul,ol{{margin:0 0 10px;padding-left:22px}}
li{{margin:0 0 2px}}
strong{{font-weight:500}}
a{{color:inherit}}
code{{font-family:var(--font-mono);font-size:.86em;background:rgba(var(--ink-rgb),.06);padding:1px 4px;border-radius:2px;
overflow-wrap:anywhere}}
sup.cite{{font-size:.68em;line-height:0;margin-left:1px;color:var(--ink-500)}}
sup.cite a{{text-decoration:none;color:var(--ink-500);font-weight:500}}
sup.cite a:hover,sup.cite a:focus-visible{{color:var(--ink-900)}}
figure{{margin:18px 0 22px}}
.fig-q{{font-size:14px;line-height:1.35;font-weight:500;margin:0 0 10px}}
figure img{{display:block;max-width:100%;height:auto}}
.art-light{{display:var(--art-light)}}
.art-dark{{display:var(--art-dark)}}
figcaption{{display:flex;gap:10px;margin-top:10px;font-size:13px;line-height:1.55;color:var(--ink-700)}}
figcaption::before{{content:'';flex:none;width:2px;background:var(--ink-900)}}
figcaption span{{min-width:0}}
.fig-text{{overflow-x:auto}}
.fig-text pre{{font-family:var(--font-mono);font-size:12px;white-space:pre-wrap;overflow-wrap:anywhere;margin:0;
color:var(--ink-700)}}
.fig-text table{{border-collapse:collapse;font-size:13px;line-height:1.5}}
.fig-text th,.fig-text td{{text-align:left;padding:3px 8px;border-bottom:1px solid rgba(var(--ink-rgb),.1);
font-variant-numeric:tabular-nums}}
.fig-text th{{font-weight:500;color:var(--ink-500)}}
{COMMENT_CSS}
.cm,.cm-on{{--cm:var(--cm-light)}}
@media (prefers-color-scheme:dark){{:root:not([data-theme="light"]) :is(.cm,.cm-on){{--cm:var(--cm-dark)}}}}
:root[data-theme="dark"] :is(.cm,.cm-on){{--cm:var(--cm-dark)}}
.notes{{margin-top:44px;padding-top:14px;border-top:1px solid rgba(var(--ink-rgb),.14);font-size:12px;line-height:1.5;
color:var(--ink-700)}}
.notes h2{{font-size:13px;margin:0 0 8px;color:var(--ink-500);font-weight:500;letter-spacing:0}}
.notes ol{{padding-left:24px;margin:0}}
.notes .ref{{font-family:var(--font-mono);font-size:11px;color:var(--ink-900);overflow-wrap:anywhere}}
.notes q{{color:var(--ink-500)}}
"""


def to_artifact(m: dict[str, Any], pics: dict[str, dict[str, Any]], dark: dict[str, dict[str, Any]], *,
                faces: str | None = None) -> str:
    """The document as a page to publish as a claude.ai artifact (module note): no doctype, html, head or body tag,
    since the artifact wraps the page in its own; the page's title first, where claude.ai reads it; then its styles
    (ARTIFACT_CSS) with its faces inlined, and the report as to_html sets it, each figure's art drawn on Neutral (`pics`)
    and on Dark (`dark`) as data URLs, so it loads nothing."""
    faces = font_faces() if faces is None else faces
    return ('<meta charset="utf-8">\n<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n'
            f'<meta name="claude:viewport-fit-sides" content="cover">\n<title>{_esc(m["title"])}</title>\n'
            f'<style>{ARTIFACT_CSS}{faces}</style>\n{_main_html(m, pics, dark)}\n')


# --------------------------------------------------------------------------- pictures of the cards


def _card_text(cell: dict[str, Any]) -> tuple[str, str]:
    """(table html, text) of a card's art shown without a picture: its table, else what its run printed or the text of
    its body; the figure's caption says its takeaway."""
    fr = frames.frame_in(cell.get("outputs") or [])
    if fr:
        cols, names, grid = frames.frame_grid(fr, list(range(min(TABLE_ROWS, len(fr["rows"])))))
        head = f"<th>{_esc(frames.corner(fr))}</th>" + "".join(f"<th>{_esc(x)}</th>" for x in cols)
        body = "".join(f"<tr><td>{_esc(n)}</td>" + "".join(f"<td>{_esc(v)}</td>" for v in row) + "</tr>"
                       for n, row in zip(names, grid))
        return f"<table><thead><tr>{head}</tr></thead><tbody>{body}</tbody></table>", ""
    texts = [str(b.get("text/plain") or "") for b in cell.get("outputs") or [] if isinstance(b, dict) and b.get("text/plain")]
    payload = cell.get("payload") if isinstance(cell.get("payload"), dict) else {}
    texts += [str(payload["text"])] if isinstance(payload.get("text"), str) and not texts else []
    text = _MARK_RE.sub(r"\1", "\n".join(t for t in texts if t)).strip()
    return "", text[:TEXT_CHARS] + ("…" if len(text) > TEXT_CHARS else "")


async def figure_pictures(c: str, cards: list[str], *, draw: bool,
                          paper: str = "neutral") -> tuple[dict[str, dict[str, Any]], str]:
    """Each figure's card as the export shows it (card_html's input): its question, and its art as the report's figure
    draws it (render.render_figure, FIGURE_ZOOM times as large, on `paper`), laid out FIGURE_W px wide, as `png` with the
    px it stands in (`width`, `height`), else its table or its text; and why the art is not a picture when it is not. A
    card that is gone says so, as on the page."""
    from . import notebook, render  # noqa: PLC0415

    out: dict[str, dict[str, Any]] = {}
    why = "" if draw else "the browser is off"
    for cid in dict.fromkeys(cards):
        cell = await asyncio.to_thread(notebook.get_cell, c, cid)
        if cell is None:
            out[cid] = {"question": "The card is gone", "gone": True}
            continue
        pic: dict[str, Any] = {"question": _collapse(cell.get("title")) or f"card:{cid}"}
        if draw and not why:
            try:
                r = await render.render_figure(c, cell, width=FIGURE_W, zoom=FIGURE_ZOOM, paper=paper)
            except render.Unavailable as e:
                why = str(e)
            else:
                if r.ok and r.png:
                    pic.update(png=base64.b64encode(r.png).decode("ascii"), width=round(r.box.get("width", 0) / FIGURE_ZOOM),
                               height=round(r.box.get("height", 0) / FIGURE_ZOOM))
        if "png" not in pic:
            pic["table"], pic["text"] = _card_text(cell)
        out[cid] = pic
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


async def fonts_loaded(page: Any) -> bool:
    return bool(await page.evaluate(
        "async () => { await document.fonts.ready; await document.fonts.load('16px \"Hanken Grotesk\"').catch(() => []);"
        " return document.fonts.check('16px \"Hanken Grotesk\"') }"))


async def print_pdf(html_text: str) -> bytes:
    """The HTML printed by the browser, on A4 pages whose side margins leave the column FIGURE_W wide."""
    async with browser_page(1280, 900) as page:
        await page.set_content(html_text, wait_until="load")
        if not await fonts_loaded(page):
            log.warning("pdf export: Hanken Grotesk did not load; the fallback face is printed")
        await page.emulate_media(media="print")
        return await page.pdf(print_background=True, prefer_css_page_size=True, format="A4",
                              margin={"top": "18mm", "bottom": "20mm", "left": "20mm", "right": "20mm"})


# --------------------------------------------------------------------------- formats


def formats(doc: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    """The formats a document offers, each {id, name, ext, note?, ok, why?}: Markdown, HTML, PDF and, but for a page,
    whose HTML is its own, a Claude artifact; the ones that need the browser (NEEDS_BROWSER) marked not ok when there is
    none."""
    from .report_types import is_custom  # noqa: PLC0415

    kind, why_off = browser()
    ids = [i for i in FORMAT_INFO if i != "artifact" or doc is None or not is_custom(doc)]
    out = [{"id": i, "name": FORMAT_INFO[i]["name"], "ext": FORMAT_INFO[i]["ext"],
            **({"note": FORMAT_INFO[i]["note"]} if FORMAT_INFO[i].get("note") else {}), "ok": True} for i in ids]
    for f in out:
        if f["id"] in NEEDS_BROWSER and kind == "off":
            f.update(ok=False, why=f"Needs a browser: {why_off}")
    return out


# --------------------------------------------------------------------------- export


def _fetch_hint(why: str) -> str:
    """The command that fetches the card harness's browser when `why` says it is not installed, else ''."""
    return f". Fetch it: {headless.fetch_command(headless.HARNESS)}" if why == headless.NOT_INSTALLED else ""


def _filename(title: str, slug: str, ext: str) -> str:
    base = re.sub(r"[^A-Za-z0-9]+", "-", title).strip("-")[:60] or slug
    return f"{base}.{ext}"


async def read_for(c: str, inv_id: str, slug: str, fmt: str, *, citations: bool = False,
                   comments: bool = False) -> dict[str, Any]:
    """The document read for format `fmt` (read_model), with its citations and its comments when asked. HTTPException
    404 for no document or no such format, 409 for a format that cannot run here, with the reason."""
    from . import report_types  # noqa: PLC0415

    doc = await asyncio.to_thread(report_types.read_doc, c, inv_id, slug)
    if doc is None:
        raise HTTPException(404, f"no {slug} yet")
    offered = {f["id"]: f for f in await asyncio.to_thread(formats, doc)}
    f = offered.get(fmt)
    if f is None:
        raise HTTPException(404, f"{slug} has no export format {fmt!r}")
    if not f["ok"]:
        raise HTTPException(409, f["why"])
    return await asyncio.to_thread(lambda: read_model(c, doc, citations=citations, comments=comments))


async def artifact_page(c: str, m: dict[str, Any]) -> str:
    """The artifact page of the document read as `m` (to_artifact), each figure's art drawn on Neutral and on Dark."""
    kind, _why = browser()
    cards = [x["card"] for u in m["units"] for x in u["figures"]]
    (pics, _), (dark, _) = await asyncio.gather(figure_pictures(c, cards, draw=kind != "off"),
                                                figure_pictures(c, cards, draw=kind != "off", paper=DARK))
    return await asyncio.to_thread(to_artifact, m, pics, dark)


def artifact_name(m: dict[str, Any], slug: str) -> str:
    """The file name of the artifact page of the document read as `m`, which a download saves it as."""
    return _filename(m["title"], slug, "artifact.html")


async def export(c: str, inv_id: str, slug: str, fmt: str, *, citations: bool = False,
                 comments: bool = False) -> tuple[bytes, str, str]:
    """(content, file name, mime) of the document in format `fmt`, with its citations and its comments when asked: for
    a Claude artifact, the page main publishes. The HTTPExceptions of read_for."""
    m = await read_for(c, inv_id, slug, fmt, citations=citations, comments=comments)
    name = lambda ext: _filename(m["title"], slug, ext)  # noqa: E731
    if fmt == "markdown":
        return to_markdown(m).encode("utf-8"), name("md"), FORMAT_INFO["markdown"]["mime"]
    if fmt == "artifact":
        return (await artifact_page(c, m)).encode("utf-8"), artifact_name(m, slug), FORMAT_INFO["artifact"]["mime"]
    kind, _why = browser()
    cards = [x["card"] for u in m["units"] for x in u["figures"]]
    pics, _ = await figure_pictures(c, cards, draw=kind != "off")
    html_text = await asyncio.to_thread(to_html, m, pics)
    if fmt == "html":
        return html_text.encode("utf-8"), name("html"), FORMAT_INFO["html"]["mime"]
    try:
        return await print_pdf(html_text), name("pdf"), FORMAT_INFO["pdf"]["mime"]
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
    return {"formats": await asyncio.to_thread(formats, doc) if doc else []}


@router.get("/ws/{c}/investigations/{inv_id}/types/{slug}/export/{fmt}")
async def export_route(c: str, inv_id: str, slug: str, fmt: str, citations: bool = False,
                       comments: bool = False) -> Response:
    slug = _slug(c, inv_id, slug)
    data, name, mime = await export(c, inv_id, slug, fmt, citations=citations, comments=comments)
    return Response(content=data, media_type=mime,
                    headers={"Content-Disposition": f'attachment; filename="{name}"', "X-Export-Name": name})
