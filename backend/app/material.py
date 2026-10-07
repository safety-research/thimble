"""Reading the canvas as text, for the modules that compare or cite it: a card's kind, question, takeaway, outputs as
text and marks (notebook_cells, which revise_diff fingerprints), and figure_kind, the one test of a card that draws a
figure, which every form of document uses."""
from __future__ import annotations

import json
import logging
from typing import Any

from . import cite, config, frames, notebook, refs
from .kernel_thimble import CARD_MIME, DIAGRAM_MIME, TIMELINE_MIME

log = logging.getLogger("thimble.material")


def collapse(v: Any) -> str:
    return " ".join(str(v or "").split())


def cut(s: Any, n: int) -> str:
    t = collapse(s)
    return t if len(t) <= n else t[:n] + " …"


# the drawings a card's code makes with thimble.diagram and thimble.timeline, which the canvas lays out (tools.DRAWING_MIMES)
DRAWINGS = {DIAGRAM_MIME: "diagram", TIMELINE_MIME: "timeline"}
# what figure_kind answers, in words, for the messages that say which cards a document can show
FIGURE_WORDS = "a chart, a table, a timeline, a diagram or a custom card's page"


def _chart_of(b: Any) -> str | None:
    """What one output bundle draws as a chart (frontend components/Outputs isChart): `timeline` or `diagram` for a
    drawing, `chart` for an image, a vega spec or a card type's graphic; None for another bundle."""
    if not isinstance(b, dict):
        return None
    drawn = next((DRAWINGS[k] for k in b if k in DRAWINGS), None)
    if drawn:
        return drawn
    return "chart" if CARD_MIME in b or any(str(k).startswith("image/") or "vega" in str(k) for k in b) else None


def has_table(outputs: Any) -> bool:
    """An output bearing a table whose cells can be cited: an html table, or a table card's frame (frames.py)."""
    if frames.frame_in(outputs if isinstance(outputs, list) else []) is not None:
        return True
    for b in outputs if isinstance(outputs, list) else []:
        if isinstance(b, dict) and "text/html" in b and cite.table_cells(cite._bundle_html(b)):
            return True
    return False


def figure_kind(cell: Any) -> str | None:
    """What a card draws that a document can show as a figure (frontend components/Outputs figureKind): `timeline` or
    `diagram` for a drawing, from its code's thimble.timeline or thimble.diagram or from its dataset; `chart` for an
    image, a vega spec or a card type's graphic; `table` for an html table or a table card's frame; `custom` for a custom
    card's page. None for a card that draws none: a note, an example, a label, or code that only printed. The first
    output that draws a chart decides, as the card shows it."""
    if not isinstance(cell, dict):
        return None
    kind = str(cell.get("kind") or notebook.DEFAULT_KIND)
    payload = cell.get("payload")
    if isinstance(payload, dict):
        if kind in ("timeline", "diagram") and payload.get("dataset") is not None:
            return kind
        if kind == "custom" and str(payload.get("html") or "").strip():
            return "custom"
        return None
    outputs = cell.get("outputs") if isinstance(cell.get("outputs"), list) else []
    drawn = next((k for k in map(_chart_of, outputs) if k), None)
    if drawn:
        return drawn
    return "table" if has_table(outputs) else None


def notebook_cells(c: str, roles: tuple[str, ...], *, raw: bool = False) -> list[dict[str, Any]]:
    """Every cell of every notebook whose role is in `roles`, in notebook order, as dicts; `raw` adds the code, the
    outputs as text, the exec count, the takeaway's link check and the timestamps."""
    ws = config.workspace_dir(c)
    out: list[dict[str, Any]] = []
    for info in notebook.list_notebooks(ws):
        role = info.get("role") or notebook.DEFAULT_ROLE
        if role not in roles:
            continue
        nb = notebook.read_notebook(ws, info["id"])
        if not nb:
            continue
        for cell in nb.get("cells") or []:
            cid = str(cell.get("id") or "")
            if not cid:
                continue
            kind = "code" if notebook.runnable(cell) else "md"  # the writer's two shapes: a card with outputs, or one read as text
            takeaway = str(cell.get("takeaway") or "").strip()
            text = _payload_text(cell) if kind == "md" else ""
            row: dict[str, Any] = {
                "id": cid, "notebook": info["id"], "notebook_title": str(nb.get("title") or info["id"]), "notebook_role": role,
                "kind": kind, "title": collapse(cell.get("title")), "text": text, "takeaway": takeaway,
                "status": str(cell.get("status") or "idle"),
                "figure": figure_kind(cell),
                "refs": refs.extract_refs(takeaway or text),
                "created_by": str(cell.get("created_by") or ""),
            }
            if raw:
                v = cell.get("verification") if isinstance(cell.get("verification"), dict) else {}
                links = v.get("links") if isinstance(v.get("links"), dict) else {}
                row.update({
                    "code": str(cell.get("code") or "") if kind == "code" else "",
                    "outputs_text": outputs_as_text(notebook.hydrate_outputs(ws, cell.get("outputs"))) if kind == "code" else "",
                    "exec_count": cell.get("exec_count"),
                    "verification": str(links.get("status") or "") if links else "",
                    "created_ts": str(cell.get("created_ts") or ""), "ts": str(cell.get("ts") or ""),
                    "edited": [e for e in (cell.get("edited") or []) if isinstance(e, dict)],
                    "takeaway_author": str(cell.get("takeaway_author") or ""),
                })
            out.append(row)
    return out


def outputs_as_text(outputs: Any) -> str:
    """A cell's outputs as text, uncapped: streams and text results as they are, an error as one line, an html table
    as its rows, a chart as its mime in brackets."""
    parts: list[str] = []
    for b in outputs if isinstance(outputs, list) else []:
        if not isinstance(b, dict):
            continue
        err = next((v for k, v in b.items() if str(k).startswith("application/vnd.thimble.error")), None)
        if isinstance(err, dict):
            parts.append(f"ERROR {err.get('ename', '')}: {err.get('evalue', '')}".rstrip(": "))
            continue
        for k in b:
            if str(k).startswith("image/"):
                parts.append(f"[chart: {k}]")
            elif "vega" in str(k):
                parts.append("[chart: vega-lite]")
        tp = b.get("text/plain")
        if isinstance(tp, list):
            tp = "".join(map(str, tp))
        html = cite.table_html(b)  # a table, or the inline rows a chart draws
        if html:
            rows: dict[str, list[str]] = {}
            for col, row, value in cite.table_cells(html):
                rows.setdefault(row, []).append(f"{col}={value}" if col else value)
            if rows:
                parts.append("\n".join(f"{row}: {'; '.join(vals)}" for row, vals in rows.items()))
                continue
        if isinstance(tp, str) and tp.strip() and not tp.strip().startswith("<Figure"):
            parts.append(tp.rstrip())
    return "\n".join(parts)


def _payload_text(cell: dict[str, Any]) -> str:
    """A data card as the writer reads it: a note's text, an example's refs, a label's concept, a dataset as JSON."""
    payload = cell.get("payload") if isinstance(cell.get("payload"), dict) else {}
    kind = cell.get("kind")
    if kind in ("note", "md"):
        return str(payload.get("text") or cell.get("text") or "").strip()
    if kind == "example":
        return "\n".join(f"[[{r}]]" for r in payload.get("refs") or [])
    if kind == "label":
        return f"label [[concept:{payload.get('concept')}]]" if payload.get("concept") else ""
    if kind == "custom":
        return str(payload.get("html") or "").strip()
    return json.dumps(payload.get("dataset"), ensure_ascii=False) if payload.get("dataset") is not None else ""
