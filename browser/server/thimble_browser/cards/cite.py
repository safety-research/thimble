"""The values a card citation can point at: `card:<id>#<column>/<row>` names one value of a card's table or chart.

A table card keeps its DataFrame as a frame (frames.py). A chart keeps its rows inline in its Vega-Lite spec, and this
module reads them as a frame too, with the same row names and number formats, so a chart's values are cited, shown
and found the same way as a table's. The model reads both as text (canvas.outputs_text), and the page shows a cited
value in its table (`table_html`, the rows around it with the value marked).

Only the standard library.
"""
from __future__ import annotations

import re
from typing import Any, Iterator

from . import frames

VEGALITE_PREFIX = "application/vnd.vegalite"
CHART_ROWS_MAX = frames.ROWS_MAX


def chart_spec(b: Any) -> dict | None:
    """The Vega-Lite spec a chart bundle holds, or None for any other bundle."""
    if not isinstance(b, dict):
        return None
    for k, v in b.items():
        if isinstance(k, str) and k.startswith(VEGALITE_PREFIX) and isinstance(v, dict):
            return v
    return None


def _subparts(spec: dict) -> list[dict]:
    parts = [p for key in ("layer", "hconcat", "vconcat", "concat")
             for p in (spec.get(key) if isinstance(spec.get(key), list) else [])]
    return [p for p in [*parts, spec.get("spec")] if isinstance(p, dict)]


def _rows(spec: dict, datasets: dict) -> list | None:
    """The inline rows of a part of a chart: its own data's values or the dataset it names, else those of its part with
    the most rows (the marks a chart's code layers on, such as a rule, take a row or a few)."""
    datasets = {**datasets, **(spec.get("datasets") if isinstance(spec.get("datasets"), dict) else {})}
    data = spec.get("data")
    if isinstance(data, dict):
        if isinstance(data.get("values"), list):
            return data["values"]
        got = datasets.get(data.get("name")) if isinstance(data.get("name"), str) else None
        if isinstance(got, list):
            return got
    found = [r for p in _subparts(spec) if (r := _rows(p, datasets)) is not None]
    if found:
        return max(found, key=len)
    if len(datasets) == 1 and isinstance(only := next(iter(datasets.values())), list):
        return only
    return None


def _x_field(spec: dict) -> str | None:
    enc = spec.get("encoding")
    if isinstance(enc, dict) and isinstance(enc.get("x"), dict) and isinstance(enc["x"].get("field"), str):
        return enc["x"]["field"]
    return next((f for p in _subparts(spec) if (f := _x_field(p))), None)


def chart_frame(b: Any) -> dict | None:
    """A chart bundle's inline rows as a frame: the row names are the first column of distinct text, else the x axis
    field when its values are distinct, else each row's position. None when the bundle is no chart or has no rows."""
    spec = chart_spec(b)
    raw = _rows(spec, {}) if spec is not None else None
    rows = [r for r in (raw or [])[:CHART_ROWS_MAX] if isinstance(r, dict)]
    if not rows:
        return None
    cols: list[str] = []
    for r in rows:
        cols.extend(str(k) for k in r if str(k) not in cols)
    frame = frames.normalize({"columns": cols, "rows": [[r.get(c) for c in cols] for r in rows], "total": len(raw or [])})
    if frame.get("label") is None and (x := _x_field(spec)) in cols:
        vals = frames.column(frame, x)
        if all(v is not None and str(v).strip() for v in vals) and len({str(v) for v in vals}) == len(vals):
            frame = frames.normalize({**frame, "index": x})
    return frame


def frames_of(outputs: Any) -> Iterator[dict]:
    """Every frame a card's outputs hold: a table's, then each chart's rows."""
    for b in outputs or []:
        f = frames.frame_of(b)
        if f is None:
            f = chart_frame(b)
        if f is not None:
            yield f


def find(outputs: Any, col: str, row: str) -> tuple[str, str] | None:
    """(the value a citation's column and row name, as the card shows it; the rows around it as an html table) in the
    first frame of `outputs` that has them, or None."""
    for f in frames_of(outputs):
        b = {frames.FRAME_MIME: f}
        got = frames.locate(b, col, row)
        if got is not None:
            return got, frames.frame_html(b, around=row)
    return None


_SPACE = re.compile(r"[\s,   ]")


def same_value(shown: str, label: str) -> bool:
    """Whether a citation's words (`label`) state the value the card shows: the value as a whole number or word in
    them, commas, spaces and the minus sign aside."""
    a = _SPACE.sub("", shown).replace(frames.MINUS, "-")
    b = _SPACE.sub("", label).replace(frames.MINUS, "-")
    if not a or not b:
        return False
    return re.search(rf"(?<![\w.]){re.escape(a)}(?![\w]|\.\d)", b) is not None


def chart_text(b: Any, card: str) -> str | None:
    """What the model reads of a chart: its rows, as a table's are read, and how to cite them; None for no rows."""
    f = chart_frame(b)
    if f is None:
        return None
    return f"(cite a value as card:{card}#<column>/<row>):\n{frames.frame_text(f)}"
