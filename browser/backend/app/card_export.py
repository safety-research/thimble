"""A card exported as figure files: the card as a figure (render.render_figure) in a figure style, as the files a post
or a paper takes. Each file's name starts with a slug of the card's question (stem).

    thimble  the card as the canvas draws it: <name>.png, <name>.pdf, and <name>.svg for a card with a chart
    Blog     blogpost-figure's panel: <name>.png, <name>.webp, <name>.pdf, and <name>.svg for a card with a chart
    Paper    the chart alone, with no legend and no title: <name>.pdf; and when the chart has a legend of colors, the
             legend in files of its own, paper-figure's layouts (legend_columns): <name>_legend_<N>col.pdf

The card harness makes the files of one drawing together (render.FIGURE_FILES): the PNG is its picture at two device
pixels per CSS pixel, the WebP that picture encoded in its page, the PDF the figure alone printed by Chromium at its own
size (vector, its fonts embedded, no margin), the SVG the chart's own (a Vega chart's, or a matplotlib figure as drawn).
How many entries a Paper legend has, and so which of its files there are, is known once the harness drew it. Without
the harness's browser each file is listed with ok false and the reason, as exports.py lists PDF.

A Blog figure opens with a headline and a subtitle: the first sentence of the card's takeaway and its question, or what
main's export_card gives as its `title` and `subtitle` (heads_of).

Two ways out. The card's Export menu lists the files of the figure style the analyst's browser reported and saves the
one picked (GET /ws/{c}/cards/{card}/figure, GET …/figure/{id}). Main's export_card writes all of them into a folder
of the corpus (tool_export_card), never through a link there (nofollow), and not while the analyst's Settings keep the
corpus read-only (ledger.corpus_edits).
"""
from __future__ import annotations

import asyncio
import logging
import re
import unicodedata
from typing import Any

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response

from . import cite, config, nofollow, render, tools

log = logging.getLogger("thimble.card_export")
router = APIRouter()

STEM_CHARS = 60  # of a file's name before its ending
FOLDER = "figures"  # export_card's folder in the corpus when the call names none
HEADS = ("title", "subtitle")  # export_card's words for a Blog figure's headline and subtitle (render.render_figure's)
EXPORT_TIMEOUT_S = 30.0  # a figure drawn and its files made, at most
STYLE_NAMES = {"thimble": "thimble", "blog": "Blog", "paper": "Paper"}  # as the theme popover names them (theme.ts)
# what each style makes of its figure, in the menu's order; the SVG only for a card with a chart (has_chart)
STYLE_FILES = {"thimble": ("png", "pdf", "svg"), "blog": ("png", "webp", "pdf", "svg"), "paper": ("pdf",)}
# each kind of file by its ending: its name in the menu, and its media type
KINDS = {"png": ("PNG", "image/png"), "webp": ("WebP", "image/webp"), "pdf": ("PDF", "application/pdf"),
         "svg": ("SVG", "image/svg+xml")}
# what a drawing that made no such file lacks, by its ending
MISSING = {"png": "a picture", "webp": "a WebP (the harness's browser cannot encode one)", "pdf": "a PDF",
           "svg": "a chart to write as an SVG"}
_LEGEND_ID = re.compile(r"^legend_(\d+)col$")  # a Paper legend's file id, as its file's name ends


# --------------------------------------------------------------------------- the files


def stem(question: Any, card_id: str) -> str:
    """A file's name before its ending: the card's question in lowercase words joined by hyphens, as many whole words as
    fit in STEM_CHARS characters (the first word cut there when it alone is longer), with accents and apostrophes taken
    out; the card's id when the question has no such word. Pure."""
    plain = unicodedata.normalize("NFKD", str(question or "")).encode("ascii", "ignore").decode("ascii")
    words = re.findall(r"[a-z0-9]+", plain.lower().replace("'", ""))
    out = ""
    for w in words:
        if len(out) + bool(out) + len(w) > STEM_CHARS:
            break
        out = f"{out}-{w}" if out else w
    return out or (words[0][:STEM_CHARS] if words else card_id)


def _vega(cell: dict[str, Any]) -> bool:
    """Whether the card shows a Vega or Vega-Lite chart."""
    return any(cite.chart_spec(b) is not None for _, b in cite.iter_outputs(cell.get("outputs")))


def has_chart(cell: dict[str, Any]) -> bool:
    """Whether the card shows a chart an SVG file can hold: a Vega or Vega-Lite chart, or a figure drawn as SVG (a
    matplotlib figure)."""
    return _vega(cell) or any(b.get("image/svg+xml") for _, b in cite.iter_outputs(cell.get("outputs")))


def legend_columns(entries: int) -> list[int]:
    """The columns of each of a Paper legend's files, paper-figure's layouts for a legend of `entries`: one, two, three
    when it has three or more, and all in one row; one alone for a legend of amounts (0 entries), which has no columns.
    Pure."""
    return [1] if entries < 1 else sorted({1, 2, min(3, entries), entries})


def legend_name(columns: int, entries: int) -> str:
    """A legend file's name in the menu: `Legend, one row` for its entries all in one row (three or more), else its
    columns. Pure."""
    if columns == entries and entries > 2:
        return "Legend, one row"
    return "Legend, 1 column" if columns == 1 else f"Legend, {columns} columns"


def _file(name: str, ext: str) -> dict[str, Any]:
    return {"id": ext, "name": KINDS[ext][0], "ext": ext, "file": f"{name}.{ext}", "part": "figure", "columns": None}


def _legend(name: str, columns: int, entries: int) -> dict[str, Any]:
    return {"id": f"legend_{columns}col", "name": legend_name(columns, entries), "ext": "pdf",
            "file": f"{name}_legend_{columns}col.pdf", "part": "legend", "columns": columns}


async def files(c: str, cell: dict[str, Any], style: str) -> list[dict[str, Any]]:
    """The files of the card's figure in `style` (module note), in the menu's order, each {id, name, ext, file, ok,
    why?} with how the harness draws it (`part`, `columns`). A Paper figure's legend is drawn here once, all in one row,
    to count its entries."""
    name = stem(cell.get("title"), str(cell.get("id") or "card"))
    why = f"Needs a browser: {render.why()}" if render.down() else ""
    out = [_file(name, ext) for ext in STYLE_FILES[style] if ext != "svg" or has_chart(cell)]
    if style == "paper" and not why and _vega(cell):
        try:
            drawn = await render.render_figure(c, cell, style=style, part="legend", timeout_s=EXPORT_TIMEOUT_S)
        except render.Unavailable as e:
            why = f"Needs a browser: {e}"
        else:
            if not drawn.ok:
                log.warning("card export: card:%s's legend did not draw: %s", cell.get("id"), drawn.error)
            elif not drawn.empty:
                out += [_legend(name, k, drawn.entries) for k in legend_columns(drawn.entries)]
    for f in out:
        f.update(ok=not why, **({"why": why} if why else {}))
    return out


def named(cell: dict[str, Any], style: str, file_id: str) -> dict[str, Any]:
    """The file `file_id` of the card's figure in `style`, without drawing it; a legend's columns are checked against
    its entries once it is drawn (make). HTTPException 404 when the figure has no such file."""
    name = stem(cell.get("title"), str(cell.get("id") or "card"))
    m = _LEGEND_ID.match(file_id)
    if style == "paper" and m and int(m.group(1)) > 0:
        return _legend(name, int(m.group(1)), int(m.group(1)))
    if file_id in STYLE_FILES[style] and (file_id != "svg" or has_chart(cell)):
        return _file(name, file_id)
    raise _no_file(cell, style, file_id)


def _no_file(cell: dict[str, Any], style: str, file_id: str) -> HTTPException:
    return HTTPException(404, f"card:{cell.get('id')} has no figure file {file_id!r} in the {STYLE_NAMES[style]} style")


async def _draw(c: str, cell: dict[str, Any], style: str, part: str, columns: int | None,
                made: tuple[str, ...], heads: dict[str, str] | None = None) -> render.Rendered:
    """The figure (or its legend) drawn with the files `made` besides its PNG, a Blog figure under `heads` (heads_of).
    HTTPException 409 with the reason when the harness cannot draw here or the card did not draw."""
    try:
        r = await render.render_figure(c, cell, style=style, part=part, columns=columns, files=made,
                                       timeout_s=EXPORT_TIMEOUT_S, **(heads or {}))
    except render.Unavailable as e:
        raise HTTPException(409, f"Needs a browser: {e}") from e
    if not r.ok:
        raise HTTPException(409, f"card:{cell.get('id')} did not draw as a figure: {r.error or 'it drew nothing'}")
    return r


def _content(r: render.Rendered, ext: str) -> bytes | None:
    return {"png": r.png, "webp": r.webp, "pdf": r.pdf, "svg": r.svg.encode("utf-8") if r.svg else None}[ext]


async def make(c: str, cell: dict[str, Any], style: str, f: dict[str, Any]) -> bytes:
    """One file of the card's figure (files, named), drawn now. HTTPException 404 for a legend layout its entries do not
    have, 409 with the reason when it cannot be made here."""
    r = await _draw(c, cell, style, f["part"], f["columns"], () if f["ext"] == "png" else (f["ext"],))
    if f["part"] == "legend" and (r.empty or f["columns"] not in legend_columns(r.entries)):
        raise _no_file(cell, style, f["id"])
    data = _content(r, f["ext"])
    if not data:
        raise HTTPException(409, f"card:{cell.get('id')} made no {MISSING[f['ext']]}")
    return data


async def make_all(c: str, cell: dict[str, Any], style: str, listed: list[dict[str, Any]],
                   heads: dict[str, str] | None = None) -> list[tuple[dict[str, Any], bytes | None]]:
    """Every listed file (files), the figure's from one drawing, a Blog figure under `heads` (heads_of), and each legend
    layout from its own: (file, its content, None when the drawing made none)."""
    figure = [f for f in listed if f["part"] == "figure"]
    out: list[tuple[dict[str, Any], bytes | None]] = []
    if figure:
        r = await _draw(c, cell, style, "figure", None, tuple(f["ext"] for f in figure if f["ext"] != "png"), heads)
        out += [(f, _content(r, f["ext"])) for f in figure]
    for f in listed:
        if f["part"] == "legend":
            out.append((f, _content(await _draw(c, cell, style, "legend", f["columns"], ("pdf",)), "pdf")))
    return out


# --------------------------------------------------------------------------- main's tool


def folder_of(raw: Any) -> str:
    """export_card's folder as a path relative to the corpus folder, "." for the folder itself: FOLDER when not given.
    ValueError for an absolute path (or one from the home folder) and for one with a `..` part. Pure."""
    text = str(raw if raw is not None else "").strip() or FOLDER
    if text.startswith(("/", "\\", "~")) or re.match(r"^[A-Za-z]:", text):
        raise ValueError(f"`folder` is a folder inside the corpus folder, given relative to it, not {text!r}")
    parts = [p for p in re.split(r"[\\/]+", text) if p not in ("", ".")]
    if ".." in parts:
        raise ValueError(f"`folder` is a folder inside the corpus folder, so it has no `..`: {text!r}")
    return "/".join(parts) or "."


def heads_of(args: dict[str, Any]) -> dict[str, str]:
    """export_card's headline and subtitle for a Blog figure (HEADS) as render_figure takes them: each one given as
    text, without the spaces around it; one not given is left out, so the figure takes the first sentence of the card's
    takeaway and its question. Pure."""
    return {k: args[k].strip() for k in HEADS if isinstance(args.get(k), str) and args[k].strip()}


async def tool_export_card(ctx: Any, args: dict[str, Any]) -> Any:
    """The `export_card` tool: every file of the card's figure in the figure style the analyst's browser reported, a
    Blog figure headed by the call's `title` and `subtitle` (heads_of), written into `folder` of the corpus (made when
    missing), each through no link there; the result names the style and each path written, relative to the corpus
    folder."""
    from . import ledger, notebook, runtime_tools  # noqa: PLC0415 — notebook imports the kernel machinery

    cid = tools._cell_id_of(args.get("card"))
    if not cid:
        return tools.err("export_card: `card` names the card, as card:<id>")
    try:
        rel = folder_of(args.get("folder"))
    except ValueError as e:
        return tools.err(f"export_card: {e}")
    if not ledger.corpus_edits(ctx.c):
        return tools.err(f"export_card writes into the corpus folder, which is read-only while the analyst's Settings "
                         f"switch \"{runtime_tools.EDITS_SWITCH}\" is off; they can turn it on there")
    cell = await asyncio.to_thread(notebook.get_cell, ctx.c, cid)
    if cell is None:
        return tools.err(f"export_card: there is no card {cid}")
    corpus = config.corpus_dir(ctx.c)
    style = (await asyncio.to_thread(render.theme, ctx.c))["figures"]
    listed = await files(ctx.c, cell, style)
    if listed and not listed[0]["ok"]:
        return tools.err(f"export_card: the card's figure is drawn by the card harness. {listed[0]['why']}")
    written: list[str] = []
    missing: dict[str, list[str]] = {}  # the paths not written, by why
    for f, data in await make_all(ctx.c, cell, style, listed, heads_of(args)):
        path = f["file"] if rel == "." else f"{rel}/{f['file']}"
        if not data:
            missing.setdefault(f"card:{cid} made no {MISSING[f['ext']]}", []).append(path)
            continue
        try:
            await asyncio.to_thread(nofollow.write_bytes, corpus / path, data, root=corpus, make=True)
        except OSError as e:
            missing.setdefault(str(e.strerror or e), []).append(path)
            continue
        written.append(path)
    unwritten = "; ".join(f"{', '.join(paths)} ({why})" for why, paths in missing.items())
    if not written:
        return tools.err(f"export_card wrote nothing: {unwritten}")
    text = tools.hint("export_card-written", card=f"card:{cid}", style=STYLE_NAMES[style], paths=", ".join(written))
    return tools.ok(text + (f"\nNot written: {unwritten}" if missing else ""))


# --------------------------------------------------------------------------- routes


async def _card(c: str, card: str) -> dict[str, Any]:
    from . import notebook  # noqa: PLC0415

    cid = tools._cell_id_of(card)
    cell = await asyncio.to_thread(notebook.get_cell, c, cid) if cid else None
    if cell is None:
        raise HTTPException(404, f"no card {cid or card}")
    return cell


@router.get("/ws/{c}/cards/{card}/figure")
async def files_route(c: str, card: str) -> dict[str, Any]:
    """The files of the card's figure in the figure style the analyst's browser reported: {style, files: [{id, name,
    ext, ok, why?}]}."""
    cell = await _card(c, card)
    style = (await asyncio.to_thread(render.theme, c))["figures"]
    listed = await files(c, cell, style)
    return {"style": style, "files": [{k: f[k] for k in ("id", "name", "ext", "ok", "why") if k in f} for f in listed]}


@router.get("/ws/{c}/cards/{card}/figure/{file_id}")
async def file_route(c: str, card: str, file_id: str) -> Response:
    """One file of the card's figure in that style, named by its file name in X-Export-Name."""
    cell = await _card(c, card)
    style = (await asyncio.to_thread(render.theme, c))["figures"]
    f = named(cell, style, file_id)
    data = await make(c, cell, style, f)
    return Response(content=data, media_type=KINDS[f["ext"]][1],
                    headers={"Content-Disposition": f'attachment; filename="{f["file"]}"', "X-Export-Name": f["file"]})
