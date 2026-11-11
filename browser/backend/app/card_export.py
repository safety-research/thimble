"""A card exported as figure files: the card's figure as an export of it alone shows it (render.render_figure, `whole`),
its question over its chart or table and its takeaway beside the ink rule, on the export's white, in thimble's faces.
Each file's name starts with a slug of the card's question (stem):

    <name>.png   the figure at two device pixels per CSS pixel
    <name>.webp  that picture as WebP
    <name>.pdf   the figure alone, printed at its own size: vector, its fonts embedded, no margin
    <name>.svg   the chart alone, as Vega or matplotlib drew it: for a card whose figure is such a chart (has_chart)

The card harness makes them from one drawing (render.FIGURE_FILES), laid out as wide as the card stands on the canvas.
Without the harness's browser each file is listed with ok false and the reason, as exports.py lists PDF.

Two ways out. The card's Export menu lists the files and saves the one picked (GET /ws/{c}/cards/{card}/figure, GET
…/figure/{id}); it writes nothing in the corpus folder, so it works with Read only on. Main's export_card writes all of
them into a folder of the corpus (tool_export_card), never through a link there (nofollow), and not while the analyst's
Settings switch Read only is on (ledger.corpus_edits).
"""
from __future__ import annotations

import asyncio
import re
import unicodedata
from typing import Any

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response

from . import cite, config, material, nofollow, render, tools

router = APIRouter()

STEM_CHARS = 60  # of a file's name before its ending
FOLDER = "figures"  # export_card's folder in the corpus when the call names none
EXPORT_TIMEOUT_S = 30.0  # a figure drawn and its files made, at most
FILES = ("png", "webp", "pdf", "svg")  # in the menu's order; the SVG only for a card with a chart (has_chart)
# each kind of file by its ending: its name in the menu, and its media type
KINDS = {"png": ("PNG", "image/png"), "webp": ("WebP", "image/webp"), "pdf": ("PDF", "application/pdf"),
         "svg": ("SVG", "image/svg+xml")}
# what a drawing that made no such file lacks, by its ending
MISSING = {"png": "a picture", "webp": "a WebP (the harness's browser cannot encode one)", "pdf": "a PDF",
           "svg": "a chart to write as an SVG"}


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


def has_chart(cell: dict[str, Any]) -> bool:
    """Whether the card's figure is a chart an SVG file can hold: the chart it draws (its first, as the figure picks it:
    material.figure_kind) is a figure drawn as SVG (a matplotlib figure) or, when no picture stands before it in its
    bundle, a Vega or Vega-Lite chart."""
    first = next((b for _, b in cite.iter_outputs(cell.get("outputs")) if material._chart_of(b) == "chart"), None)
    if first is None or any(k in material.DRAWINGS for k in first):
        return False
    if first.get("image/svg+xml"):
        return True
    return not any(str(k).startswith("image/") for k in first) and cite.chart_spec(first) is not None


def width_of(cell: dict[str, Any]) -> int:
    """The width the card's figure is laid out at, px: the card's own on the canvas, else a card's at rest."""
    w = cell.get("width")
    return int(w) if isinstance(w, (int, float)) and w > 0 else render.CARD_W


def _why_not() -> str:
    """Why no figure can be drawn here, with the command that fetches the harness's browser when it is not installed;
    '' while one can."""
    from .exports import _fetch_hint  # noqa: PLC0415 — exports imports much of the app

    if not render.down():
        return ""
    why = render.why()
    return f"Needs a browser: {why}{_fetch_hint(why)}"


def _file(cell: dict[str, Any], ext: str) -> dict[str, Any]:
    name = stem(cell.get("title"), str(cell.get("id") or "card"))
    return {"id": ext, "name": KINDS[ext][0], "ext": ext, "file": f"{name}.{ext}"}


def files(cell: dict[str, Any]) -> list[dict[str, Any]]:
    """The files of the card's figure (module note), in the menu's order, each {id, name, ext, file, ok, why?}."""
    why = _why_not()
    out = [_file(cell, ext) for ext in FILES if ext != "svg" or has_chart(cell)]
    for f in out:
        f.update(ok=not why, **({"why": why} if why else {}))
    return out


def named(cell: dict[str, Any], file_id: str) -> dict[str, Any]:
    """The file `file_id` of the card's figure, without drawing it. HTTPException 404 when the figure has no such file."""
    if file_id in FILES and (file_id != "svg" or has_chart(cell)):
        return _file(cell, file_id)
    raise HTTPException(404, f"card:{cell.get('id')} has no figure file {file_id!r}")


async def _draw(c: str, cell: dict[str, Any], made: tuple[str, ...]) -> render.Rendered:
    """The figure drawn with the files `made` besides its PNG. HTTPException 409 with the reason when the harness cannot
    draw here or the card did not draw."""
    from .exports import _fetch_hint  # noqa: PLC0415

    try:
        r = await render.render_figure(c, cell, width=width_of(cell), whole=True, files=made,
                                       timeout_s=EXPORT_TIMEOUT_S)
    except render.Unavailable as e:
        raise HTTPException(409, f"Needs a browser: {e}{_fetch_hint(str(e))}") from e
    if not r.ok:
        raise HTTPException(409, f"card:{cell.get('id')} did not draw as a figure: {r.error or 'it drew nothing'}")
    return r


def _content(r: render.Rendered, ext: str) -> bytes | None:
    return {"png": r.png, "webp": r.webp, "pdf": r.pdf, "svg": r.svg.encode("utf-8") if r.svg else None}[ext]


async def make(c: str, cell: dict[str, Any], f: dict[str, Any]) -> bytes:
    """One file of the card's figure (files, named), drawn now. HTTPException 409 with the reason when it cannot be made
    here."""
    r = await _draw(c, cell, () if f["ext"] == "png" else (f["ext"],))
    data = _content(r, f["ext"])
    if not data:
        raise HTTPException(409, f"card:{cell.get('id')} made no {MISSING[f['ext']]}")
    return data


async def make_all(c: str, cell: dict[str, Any], listed: list[dict[str, Any]]) -> list[tuple[dict[str, Any], bytes | None]]:
    """Every listed file (files) from one drawing: (file, its content, None when the drawing made none)."""
    r = await _draw(c, cell, tuple(f["ext"] for f in listed if f["ext"] != "png"))
    return [(f, _content(r, f["ext"])) for f in listed]


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


async def tool_export_card(ctx: Any, args: dict[str, Any]) -> Any:
    """The `export_card` tool: every file of the card's figure, written into `folder` of the corpus (made when missing),
    each through no link there; the result names each path written, relative to the corpus folder. While Read only is
    on it writes nothing and says how to turn it off, as the refusal of a write in the corpus does (runtime_tools)."""
    from . import ledger, notebook, runtime_tools  # noqa: PLC0415 — notebook imports the kernel machinery

    cid = tools._cell_id_of(args.get("card"))
    if not cid:
        return tools.err("export_card: `card` names the card, as card:<id>")
    if not ledger.corpus_edits(ctx.c):
        return tools.err(f"export_card writes into the corpus folder, which is read-only while the analyst's Settings "
                         f"switch \"{runtime_tools.READ_ONLY_SWITCH}\" is on; they can turn it off there")
    try:
        rel = folder_of(args.get("folder"))
    except ValueError as e:
        return tools.err(f"export_card: {e}")
    cell = await asyncio.to_thread(notebook.get_cell, ctx.c, cid)
    if cell is None:
        return tools.err(f"export_card: there is no card {cid}")
    listed = files(cell)
    if not listed[0]["ok"]:
        return tools.err(f"export_card: the card's figure is drawn by the card harness. {listed[0]['why']}")
    try:
        made = await make_all(ctx.c, cell, listed)
    except HTTPException as e:
        return tools.err(f"export_card: {e.detail}")
    corpus = config.corpus_dir(ctx.c)
    written: list[str] = []
    missing: dict[str, list[str]] = {}  # the paths not written, by why
    for f, data in made:
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
    text = tools.hint("export_card-written", card=f"card:{cid}", paths=", ".join(written))
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
    """The files of the card's figure: {files: [{id, name, ext, ok, why?}]}."""
    cell = await _card(c, card)
    return {"files": [{k: f[k] for k in ("id", "name", "ext", "ok", "why") if k in f} for f in files(cell)]}


@router.get("/ws/{c}/cards/{card}/figure/{file_id}")
async def file_route(c: str, card: str, file_id: str) -> Response:
    """One file of the card's figure, named by its file name in X-Export-Name."""
    cell = await _card(c, card)
    f = named(cell, file_id)
    data = await make(c, cell, f)
    return Response(content=data, media_type=KINDS[f["ext"]][1],
                    headers={"Content-Disposition": f'attachment; filename="{f["file"]}"', "X-Export-Name": f["file"]})
