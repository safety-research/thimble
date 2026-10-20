"""The report exported as a file: Markdown, or one standalone HTML page with its figures, and PDF by printing that page
in the analyst's own browser (the page's Export menu does it; the server runs no browser).

Every format starts from one reading of the report (read_model): its title, its sections of paragraphs and figures, and
its citations, numbered in order of first use. A citation is a footnote: the words it was on stay in the text with the
note's number after them, and the notes at the end name what each cites in plain text (a file and its line or row, or
a card and the value) with a short quote of it. Nothing in an export links back into thimble.

A figure is its card drawn as the page draws it, when the page sends that picture (POST, `pictures`: {card id: a PNG
data URL}); else what the card's outputs give: its PNG or SVG picture, its table, the data of its chart as a table, or
its text. A card's own HTML (a custom card) is never copied into the export.

    GET  /api/ws/{c}/investigations/main/types/report/exports      {formats}
    GET  /api/ws/{c}/investigations/main/types/report/export/{fmt} the file (markdown, html)
    POST /api/ws/{c}/investigations/main/types/report/export/{fmt} the same, with the page's pictures of the figures
    GET  /api/ws/{c}/investigations/main/types/report/export       {markdown, title}
"""
from __future__ import annotations

import base64
import binascii
import html as _html
import logging
import re
from pathlib import Path
from typing import Any

from fastapi import HTTPException, Request
from fastapi.responses import Response

from . import canvas, corpus, report
from .cards import frames

log = logging.getLogger("thimble_browser.exports")

FORMATS = [
    {"id": "markdown", "name": "Markdown", "ext": "md", "ok": True},
    {"id": "html", "name": "HTML", "ext": "html", "ok": True, "pictures": True},
    {"id": "pdf", "name": "PDF", "ext": "pdf", "ok": True, "pictures": True, "print": True},
]
MIME = {"markdown": "text/markdown; charset=utf-8", "html": "text/html; charset=utf-8"}
QUOTE_CHARS = 240  # of a cited record, in its note
TEXT_CHARS = 1200  # of a card's text when it is shown without a picture
TABLE_ROWS = 30
TABLE_COLS = 8
PICTURE_MAX = 12_000_000  # characters of one picture's data URL the page may send
PICTURES_MAX = 60
PNG_URL = re.compile(r"^data:image/png;base64,([A-Za-z0-9+/=\s]+)$")
VEGA = re.compile(r"^application/vnd\.vegalite\.v\d+(\.\d+)*\+?\.?json$")
TOKEN = report.TOKEN
INLINE = re.compile(r"\*\*(.+?)\*\*|(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])|`([^`]+)`|\[([^\]]+)\]\((https?://[^)\s]+)\)")
DIST = Path(__file__).resolve().parents[2] / "frontend"


def _collapse(v: Any) -> str:
    return " ".join(str(v or "").split())


def _esc(s: Any) -> str:
    return _html.escape(str(s or ""), quote=True)


def _cut(s: str, n: int) -> str:
    s = _collapse(s)
    return s if len(s) <= n else s[: n - 1].rstrip() + "…"


# --------------------------------------------------------------------------- the report, read once


class Notes:
    """The report's citations, numbered in order of first use; each {n, ref, label, quote}."""

    def __init__(self, ws: str, folder: Path) -> None:
        self.ws, self.folder = ws, folder
        self.rows: list[dict[str, Any]] = []
        self._n: dict[str, int] = {}

    def note(self, ref: str) -> int:
        ref = ref.strip()
        if ref not in self._n:
            label, quote = self._describe(ref)
            self.rows.append({"n": len(self.rows) + 1, "ref": ref, "label": label, "quote": quote,
                              "card": ref.startswith(("card:", "cell:"))})
            self._n[ref] = len(self.rows)
        return self._n[ref]

    def _describe(self, ref: str) -> tuple[str, str]:
        """(what the ref names in words, a short quote of it)."""
        try:
            if ref.startswith(("card:", "cell:")):
                _, cell = canvas.find(self.ws, ref)
                got = canvas.resolve_card_ref(self.ws, ref)
                label = f"card “{_cut(cell['title'], 120)}”"
                return label, (_cut(got["excerpt"], QUOTE_CHARS) if got["kind"] == "value" else "")
            got = corpus.resolve(self.folder, ref)
        except Exception:  # noqa: BLE001 — a ref that no longer opens keeps its words
            return ref, ""
        path, kind = got.get("path") or ref, got.get("kind")
        if kind == "record":
            label = f"{path}, line {got.get('line')}"
        elif kind == "range":
            label = f"{path}, lines {got.get('line')}–{(got.get('meta') or {}).get('end')}"
        elif kind == "row":
            m = re.search(r"row=(\d+)", ref)
            label = f"{path}, row {m.group(1)}" if m else f"{path}, line {got.get('line')}"
        else:
            label = path
        rec = got.get("record")
        text = rec.get("text") if isinstance(rec, dict) and isinstance(rec.get("text"), str) else got.get("excerpt")
        return label, ("" if kind in ("file", "dir") else _cut(str(text or ""), QUOTE_CHARS))


def _pieces(text: str, notes: Notes) -> list[tuple[str, int | None]]:
    """A sentence as [(words, note number or None)]: each citation's words with its note's number."""
    out: list[tuple[str, int | None]] = []
    pos = 0
    for m in TOKEN.finditer(text or ""):
        if m.start() > pos:
            out.append((text[pos:m.start()], None))
        inner = m.group(1)
        words, ref = inner.split("|", 1) if "|" in inner else ("", inner)
        out.append((words, notes.note(ref)))
        pos = m.end()
    if pos < len(text or ""):
        out.append((text[pos:], None))
    return out


def read_model(ws: str) -> dict[str, Any]:
    doc = report.writeup(ws)
    if doc is None:
        raise HTTPException(404, "the report is not written yet")
    notes = Notes(ws, corpus_of(ws))
    title = _collapse(doc.get("title")) or "Report"
    sections = []
    for sec in doc.get("sections") or []:
        paras = [{"id": p["id"], "bullet": all(s.get("bullet") for s in p["sentences"]) and bool(p["sentences"]),
                  "marker": (p["sentences"][0].get("bullet") if p["sentences"] else None),
                  "sentences": [_pieces(s.get("text") or "", notes) for s in p["sentences"]]}
                 for p in sec.get("paragraphs") or []]
        figs = []
        for f in sec.get("figures") or []:
            n = notes.note(f"card:{f['cell']}")
            figs.append({"card": f["cell"], "caption": _pieces(f.get("caption") or "", notes), "note": n,
                         "after": f.get("after_paragraph"), "lead": bool(f.get("lead"))})
        sections.append({"heading": _collapse(sec.get("heading")), "level": int(sec.get("level") or 2),
                         "paragraphs": paras, "figures": figs})
    return {"title": title, "title_pieces": _pieces(title, notes), "sections": sections, "notes": notes.rows}


def corpus_of(ws: str) -> Path:
    from . import home  # noqa: PLC0415

    return home.corpus_of(ws)


# --------------------------------------------------------------------------- the figures


def _table(cols: list[str], rows: list[list[Any]], corner: str = "") -> tuple[str, str]:
    """(an HTML table, a Markdown table) of `rows` under `cols`."""
    head = "".join(f"<th>{_esc(c)}</th>" for c in cols)
    body = "".join("<tr>" + "".join(f"<td>{_esc(v)}</td>" for v in r) + "</tr>" for r in rows)
    md_cell = lambda v: str(v if v is not None else "").replace("|", "\\|").replace("\n", " ")  # noqa: E731
    md = "\n".join(["| " + " | ".join(md_cell(c) for c in cols) + " |", "|" + "---|" * len(cols)]
                   + ["| " + " | ".join(md_cell(v) for v in r) + " |" for r in rows])
    return f"<table><thead><tr>{head}</tr></thead><tbody>{body}</tbody></table>", md


def _frame_table(frame: dict[str, Any]) -> tuple[str, str]:
    cols, names, grid = frames.frame_grid(frame, list(range(min(TABLE_ROWS, len(frame.get("rows") or [])))))
    return _table([frames.corner(frame), *cols], [[n, *row] for n, row in zip(names, grid)])


def _chart_table(spec: Any) -> tuple[str, str] | None:
    """A chart's data as a table: the first of its datasets, or its inline values."""
    if not isinstance(spec, dict):
        return None
    rows = None
    if isinstance(spec.get("datasets"), dict) and spec["datasets"]:
        rows = next(iter(spec["datasets"].values()))
    elif isinstance(spec.get("data"), dict) and isinstance(spec["data"].get("values"), list):
        rows = spec["data"]["values"]
    if not isinstance(rows, list) or not rows or not isinstance(rows[0], dict):
        return None
    cols = [str(k) for k in rows[0]][:TABLE_COLS]
    return _table(cols, [[r.get(c) if isinstance(r, dict) else "" for c in cols] for r in rows[:TABLE_ROWS]])


def figure(cell: dict[str, Any] | None, picture: str | None = None) -> dict[str, str]:
    """{html, md} of a card as the export shows it (module note)."""
    if cell is None:
        return {"html": '<div class="card"><div class="card-title">A card that is no longer on the canvas</div></div>',
                "md": ""}
    title = _collapse(cell.get("title"))
    if picture:
        return {"html": f'<img alt="{_esc(title)}" src="{picture}">', "md": ""}
    outs = [o for o in cell.get("outputs") or [] if isinstance(o, dict)]
    for o in outs:
        if isinstance(o.get("image/png"), str):
            data = re.sub(r"\s+", "", o["image/png"])
            return {"html": f'<img alt="{_esc(title)}" src="data:image/png;base64,{data}">', "md": ""}
        if isinstance(o.get("image/svg+xml"), str):
            data = base64.b64encode(o["image/svg+xml"].encode("utf-8")).decode("ascii")
            return {"html": f'<img alt="{_esc(title)}" src="data:image/svg+xml;base64,{data}">', "md": ""}
    body_html, body_md = "", ""
    frame = frames.frame_in(outs)
    if frame:
        body_html, body_md = _frame_table(frame)
    else:
        for o in outs:
            key = next((k for k in o if VEGA.match(k)), None)
            got = _chart_table(o[key]) if key else None
            if got:
                body_html, body_md = got
                break
    if not body_html:
        if cell.get("kind") == "note":
            text = _cut(re.sub(r"\[\[([^|\]]*)\|[^\]]*\]\]|\[\[[^\]]*\]\]", r"\1", cell.get("text") or ""), TEXT_CHARS)
        elif cell.get("kind") == "example":
            text = "\n".join(str(r.get("ref") if isinstance(r, dict) else r) for r in (cell.get("payload") or {}).get("refs") or [])
        elif cell.get("kind") == "custom":
            text = "An interactive card: open it in thimble to see it."
        else:
            text = "\n".join(str(o.get("text/plain") or "") for o in outs if o.get("text/plain")).strip()
            text = text[:TEXT_CHARS] + ("…" if len(text) > TEXT_CHARS else "")
        if text:
            body_html, body_md = f"<pre>{_esc(text)}</pre>", "\n".join(f"    {ln}" for ln in text.splitlines())
    return {"html": f'<div class="card"><div class="card-title">{_esc(title)}</div>{body_html}</div>', "md": body_md}


def check_pictures(raw: Any) -> dict[str, str]:
    """The page's pictures that are PNG data URLs of a sane size, by card id; others left out."""
    out: dict[str, str] = {}
    if not isinstance(raw, dict):
        return out
    for cid, url in list(raw.items())[:PICTURES_MAX]:
        cid = str(cid).removeprefix("card:")
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", cid) or not isinstance(url, str) or len(url) > PICTURE_MAX:
            continue
        m = PNG_URL.match(url)
        if not m:
            continue
        try:
            head = base64.b64decode(re.sub(r"\s+", "", m.group(1))[:64])
        except (binascii.Error, ValueError):
            continue
        if head.startswith(b"\x89PNG"):
            out[cid] = "data:image/png;base64," + re.sub(r"\s+", "", m.group(1))
    return out


# --------------------------------------------------------------------------- Markdown


def _md_pieces(pieces: list[tuple[str, int | None]]) -> str:
    out = ""
    for words, n in pieces:
        # a citation with no words of its own stands against the word before it
        out = (out.rstrip() if not words and n else out) + words + (f"[^{n}]" if n else "")
    return out.strip()


def to_markdown(m: dict[str, Any], figs: dict[str, dict[str, str]]) -> str:
    out = [f"# {_md_pieces(m['title_pieces'])}", ""]
    for sec in m["sections"]:
        if sec["heading"]:
            out += [f"{'#' * max(2, sec['level'])} {sec['heading']}", ""]
        for block in _order(sec):
            if block[0] == "p":
                p = block[1]
                if p["bullet"]:
                    out += [f"{'1.' if p['marker'] == '1.' else '-'} {_md_pieces(s)}" for s in p["sentences"]] + [""]
                else:
                    out += [" ".join(_md_pieces(s) for s in p["sentences"]), ""]
            else:
                f = block[1]
                cap = _md_pieces(f["caption"]) or "Figure"
                out += [f"*Figure: {cap}*[^{f['note']}]", ""]
                if figs.get(f["card"], {}).get("md"):
                    out += [figs[f["card"]]["md"], ""]
    if m["notes"]:
        out += ["---", ""]
        out += [f"[^{r['n']}]: {_note_words(r)}" for r in m["notes"]]
        out.append("")
    return "\n".join(out).rstrip() + "\n"


def _note_words(r: dict[str, Any]) -> str:
    return r["label"] + (f": “{r['quote']}”" if r["quote"] else "") + (f" ({r['ref']})" if r["label"] != r["ref"] else "")


def _order(sec: dict[str, Any]) -> list[tuple[str, dict[str, Any]]]:
    """A section's paragraphs with each figure after the paragraph it follows (a lead figure first)."""
    after: dict[Any, list[dict[str, Any]]] = {}
    lead, tail = [], []
    ids = {p["id"] for p in sec["paragraphs"]}
    for f in sec["figures"]:
        if f["lead"]:
            lead.append(f)
        elif f["after"] in ids:
            after.setdefault(f["after"], []).append(f)
        else:
            tail.append(f)
    out: list[tuple[str, dict[str, Any]]] = [("f", f) for f in lead]
    for p in sec["paragraphs"]:
        out.append(("p", p))
        out += [("f", f) for f in after.get(p["id"], [])]
    return out + [("f", f) for f in tail]


# --------------------------------------------------------------------------- HTML


def inline_html(text: str) -> str:
    """Inline Markdown as HTML: bold, emphasis, code and http(s) links; everything else escaped."""
    out, pos = [], 0
    for m in INLINE.finditer(text or ""):
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


def _html_pieces(pieces: list[tuple[str, int | None]]) -> str:
    out = ""
    for words, n in pieces:
        out = (out.rstrip() if not words and n else out) + inline_html(words) \
            + (f'<sup class="cite"><a href="#note-{n}">{n}</a></sup>' if n else "")
    return out.strip()


def _font_faces() -> str:
    """@font-face rules for Hanken Grotesk and Geist Mono as data URLs, from the page's packages or its built files;
    '' when neither is here (the page then uses the system's faces)."""
    rules = []
    faces = [("Hanken Grotesk", "hanken-grotesk", w, s) for w, s in (("400", "normal"), ("600", "normal"), ("400", "italic"))]
    faces += [("Geist Mono", "geist-mono", "400", "normal")]
    for family, pkg, w, style in faces:
        name = f"{pkg}-latin-{w}-{style}"
        found = DIST / "node_modules" / "@fontsource" / pkg / "files" / f"{name}.woff2"
        if not found.is_file():
            assets = DIST / "dist" / "assets"
            found = next(iter(sorted(assets.glob(f"{name}-*.woff2"))), None) if assets.is_dir() else None
        if found is None or not found.is_file():
            continue
        data = base64.b64encode(found.read_bytes()).decode("ascii")
        rules.append(f"@font-face{{font-family:'{family}';font-style:{style};font-weight:{w};font-display:block;"
                     f"src:url(data:font/woff2;base64,{data}) format('woff2')}}")
    return "".join(rules)


CSS = """
:root{--paper:#fbfaf7;--card:#fffdf8;--ink:#1b1a18;--ink-2:#4a4844;--ink-3:#64625b;--ink-rgb:27,26,24;
--body:'Hanken Grotesk',system-ui,sans-serif;--mono:'Geist Mono',ui-monospace,monospace}
*{box-sizing:border-box}
html{background:var(--paper);color:var(--ink);font-family:var(--body);font-size:16px;line-height:1.6;
-webkit-font-smoothing:antialiased;-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{margin:0;background:var(--paper)}
main{max-width:720px;margin:0 auto;padding:56px 24px 72px}
h1{font-size:30px;line-height:1.2;font-weight:600;letter-spacing:-.01em;margin:0 0 20px}
h2{font-size:20px;line-height:1.3;font-weight:600;margin:36px 0 10px}
h3,h4,h5,h6{font-size:17px;font-weight:600;margin:28px 0 8px}
p{margin:0 0 14px}
ul,ol{margin:0 0 14px;padding-left:22px}
a{color:inherit}
code{font-family:var(--mono);font-size:.88em;background:rgba(var(--ink-rgb),.06);padding:1px 4px;border-radius:4px}
sup.cite{font-size:.68em;line-height:0;margin-left:1px;color:var(--ink-3)}
sup.cite a{text-decoration:none;color:var(--ink-3);font-weight:500}
figure{margin:20px 0 24px;break-inside:avoid}
figure img{display:block;max-width:100%;height:auto;border-radius:10px}
figcaption{font-size:14px;color:var(--ink-3);margin-top:8px}
.card{background:var(--card);border-radius:10px;padding:14px 16px;box-shadow:0 0 0 1px rgba(var(--ink-rgb),.08);overflow-x:auto}
.card-title{font-weight:600;margin-bottom:6px}
.card pre{font-family:var(--mono);font-size:12px;white-space:pre-wrap;margin:0;color:var(--ink-2)}
.card table{border-collapse:collapse;font-size:13px;width:100%}
.card th,.card td{text-align:left;padding:3px 8px;border-bottom:1px solid rgba(var(--ink-rgb),.08)}
.card th{font-weight:500;color:var(--ink-3)}
.notes{margin-top:48px;padding-top:16px;border-top:1px solid rgba(var(--ink-rgb),.14);font-size:13px;color:var(--ink-2)}
.notes h2{font-size:14px;margin:0 0 10px;color:var(--ink-3);font-weight:500}
.notes ol{padding-left:24px;margin:0}
.notes li{margin:0 0 6px}
.notes .ref{font-family:var(--mono);font-size:12px;color:var(--ink)}
.notes .card-ref{color:var(--ink)}
.notes q{color:var(--ink-3)}
@media print{html,body{background:#fff}main{padding:0 0 24px}a{text-decoration:none}}
"""


def to_html(m: dict[str, Any], figs: dict[str, dict[str, str]], *, faces: str | None = None) -> str:
    parts = [f"<h1>{_html_pieces(m['title_pieces'])}</h1>"]
    for sec in m["sections"]:
        if sec["heading"]:
            lvl = min(4, max(2, sec["level"]))
            parts.append(f"<h{lvl}>{inline_html(sec['heading'])}</h{lvl}>")
        for kind, block in _order(sec):
            if kind == "p":
                if block["bullet"]:
                    tag = "ol" if block["marker"] == "1." else "ul"
                    parts.append(f"<{tag}>" + "".join(f"<li>{_html_pieces(s)}</li>" for s in block["sentences"]) + f"</{tag}>")
                else:
                    parts.append("<p>" + " ".join(_html_pieces(s) for s in block["sentences"]) + "</p>")
            else:
                cap = _html_pieces(block["caption"])
                note = f'<sup class="cite"><a href="#note-{block["note"]}">{block["note"]}</a></sup>'
                parts.append(f'<figure id="card-{_esc(block["card"])}">{figs.get(block["card"], {}).get("html", "")}'
                             + (f"<figcaption>{cap}{note}</figcaption>" if cap else f"<figcaption>{note}</figcaption>")
                             + "</figure>")
    if m["notes"]:
        items = []
        for r in m["notes"]:
            label = f'<span class="{"card-ref" if r.get("card") else "ref"}">{_esc(r["label"])}</span>'
            quote = f" <q>{_esc(r['quote'])}</q>" if r["quote"] else ""
            items.append(f'<li id="note-{r["n"]}">{label}{quote}</li>')
        parts.append(f'<section class="notes"><h2>Sources</h2><ol>{"".join(items)}</ol></section>')
    faces = _font_faces() if faces is None else faces
    return ('<!doctype html><html lang="en"><head><meta charset="utf-8">'
            '<meta name="viewport" content="width=device-width,initial-scale=1">'
            f"<title>{_esc(m['title'])}</title><style>{faces}{CSS}</style></head>"
            f"<body><main>{''.join(parts)}</main></body></html>")


# --------------------------------------------------------------------------- export


def _filename(title: str, ext: str) -> str:
    base = re.sub(r"[^A-Za-z0-9]+", "-", title).strip("-")[:60] or "report"
    return f"{base}.{ext}"


def export(ws: str, fmt: str, pictures: dict[str, str] | None = None) -> tuple[bytes, str, str]:
    """(content, file name, mime) of the report in `fmt` (markdown or html; pdf is html the page prints)."""
    if fmt not in ("markdown", "html", "pdf"):
        raise HTTPException(404, f"the report has no export format {fmt!r}")
    m = read_model(ws)
    pictures = pictures or {}
    figs: dict[str, dict[str, str]] = {}
    for sec in m["sections"]:
        for f in sec["figures"]:
            try:
                cell = canvas.find(ws, f["card"])[1]
            except KeyError:
                cell = None
            figs[f["card"]] = figure(cell, pictures.get(f["card"]) if fmt != "markdown" else None)
    if fmt == "markdown":
        return to_markdown(m, figs).encode("utf-8"), _filename(m["title"], "md"), MIME["markdown"]
    return to_html(m, figs).encode("utf-8"), _filename(m["title"], "html"), MIME["html"]


def register(ctx: Any) -> None:
    app = ctx.app

    def doc_of(c: str, slug: str) -> str:
        ws = ctx.ws_of(c)
        if slug != report.DOC:
            raise HTTPException(404, f"no document {slug!r}")
        return ws

    def answer(data: bytes, name: str, mime: str) -> Response:
        return Response(content=data, media_type=mime,
                        headers={"content-disposition": f'attachment; filename="{name}"', "x-export-name": name})

    @app.get("/api/ws/{c}/investigations/main/types/{slug}/exports")
    def formats(c: str, slug: str) -> dict[str, Any]:
        ws = doc_of(c, slug)
        return {"formats": [dict(f) for f in FORMATS] if report.markdown(ws) is not None else []}

    @app.get("/api/ws/{c}/investigations/main/types/{slug}/export/{fmt}")
    def export_get(c: str, slug: str, fmt: str) -> Response:
        return answer(*export(doc_of(c, slug), fmt))

    @app.post("/api/ws/{c}/investigations/main/types/{slug}/export/{fmt}")
    async def export_post(c: str, slug: str, fmt: str, request: Request) -> Response:
        ws = doc_of(c, slug)
        try:
            body = await request.json()
        except ValueError:
            raise HTTPException(400, "the body is not JSON") from None
        pictures = check_pictures(body.get("pictures") if isinstance(body, dict) else None)
        return answer(*export(ws, fmt, pictures))

    @app.get("/api/ws/{c}/investigations/main/types/{slug}/export")
    def export_text(c: str, slug: str) -> dict[str, Any]:
        ws = doc_of(c, slug)
        data, _, _ = export(ws, "markdown")
        return {"markdown": data.decode("utf-8"), "title": read_model(ws)["title"]}

