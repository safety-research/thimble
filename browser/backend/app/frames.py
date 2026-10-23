"""A table card's DataFrame kept as data rather than as pandas' html.

notebook._execute_cell asks the kernel for a table card's final DataFrame in the same execute request (CAPTURE, via
`user_expressions`) and stores it in place of the DataFrame's display as a FRAME_MIME bundle: typed rows (at most
ROWS_MAX), columns and types, the column that names each row in a ref (`label`), and the `view` (shown columns and
number formats). The canvas draws it (canvas/FrameTable.tsx), the model reads its text/plain and the citation check
reads frame_cells, so all three see the same values in the same format.

Row names: the index when the code set one, else the first column of distinct text, else the position. An unnamed index
keeps pandas' name (`index`, `level_0`) and has no header over it.

Types: a column whose values are all numbers is quantitative whatever its dtype (after `.T` columns are object dtype).

Number formats match d3-format in the browser (lib/dataFrame.ts): whole numbers `,d` (years `d`), others with the
decimals that give the largest absolute value three significant digits, trailing zeros dropped (`,.2~f`), with
JavaScript's rounding and d3's minus sign.

Only the standard library, since tools.py imports this module and the MCP shim imports tools.
"""
from __future__ import annotations

import html as _html
import json
import math
import re
from decimal import ROUND_HALF_UP, Decimal
from typing import Any, Iterable

FRAME_MIME = "application/vnd.thimble.frame+json"
KIND = "table"  # the one kind whose DataFrame is kept (captures)
EXPR_KEY = "thimble_frame"  # the user expression's key in the execute request (notebook._execute)
# by import, so it works whether or not the card imported thimble
CAPTURE = "__import__('thimble')._frame()"
ROWS_MAX = 500  # kernel_thimble.FRAME_ROWS: the rows a card keeps and shows
TEXT_ROWS = 60  # the rows of a frame a tool result shows the model, then pandas' own `[n rows x m columns]` line
TEXT_WIDTH = 30  # the widest a column is padded to in that text (cite.CHART_TEXT_WIDTH)
TYPES = ("quantitative", "temporal", "nominal", "ordinal")
MINUS = "−"  # d3-format's default locale writes a negative number with the minus sign; cite._norm reads both


def captures(kind: str | None) -> bool:
    """Whether a card of `kind` keeps the DataFrame its code ends in."""
    return kind == KIND


# number formats

_FMT_RE = re.compile(r"^(,)?(?:d|\.(\d)~f)$")


def _is_number(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and not (isinstance(v, float) and not math.isfinite(v))


def _group(digits: str) -> str:
    """The integer digits with thousands joined by commas (d3-format's en-US grouping)."""
    head = len(digits) % 3 or 3
    return ",".join([digits[:head], *(digits[i:i + 3] for i in range(head, len(digits), 3))])


def default_format(values: Iterable[Any]) -> str:
    """The format of a number column: whole numbers ',d' (a column of years 'd'), others the decimals that give the
    largest absolute value three significant digits."""
    nums = [float(v) for v in values if _is_number(v)]
    if not nums or all(n.is_integer() for n in nums):
        if nums and all(1000 <= n <= 2100 for n in nums):
            return "d"
        return ",d"
    m = max(abs(n) for n in nums)
    if m == 0:
        return ",d"
    decimals = max(0, min(6, 2 - math.floor(math.log10(m))))
    return f",.{decimals}~f"


def _number(value: float, fmt: str) -> str | None:
    """A number as d3-format(fmt) writes it, for the formats default_format gives; None for any other format."""
    m = _FMT_RE.match(fmt)
    if not m:
        return None
    comma, decimals = m.group(1), m.group(2)
    neg = value < 0 or (value == 0 and math.copysign(1, value) < 0)
    # JS's toFixed and Math.round read the float's exact binary value and round a tie away from zero
    exact = Decimal(abs(value)) if isinstance(value, float) else Decimal(abs(int(value)))
    places = int(decimals) if decimals is not None else 0
    text = f"{exact.quantize(Decimal(1).scaleb(-places), rounding=ROUND_HALF_UP):.{places}f}"
    whole, _, frac = text.partition(".")
    frac = frac.rstrip("0") if decimals is not None else ""  # `~` drops the trailing zeros
    if neg and float(text) == 0:
        neg = False  # d3 writes no sign on a value that rounds to zero
    return (MINUS if neg else "") + (_group(whole) if comma else whole) + (f".{frac}" if frac else "")


def show(value: Any, fmt: str | None = None) -> str:
    """One value as the card shows it: a number in its column's format, text as it is, a boolean as JSON writes it, a
    missing value as nothing, anything nested as compact JSON."""
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if _is_number(value) and fmt:
        text = _number(value, fmt)
        if text is not None:
            return text
    if isinstance(value, float):
        if not math.isfinite(value):
            return ""
        return str(int(value)) if value.is_integer() else repr(value)
    if isinstance(value, (int, str)):
        return str(value)
    try:
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"), default=str)
    except (TypeError, ValueError):
        return str(value)


# ----------------------------------------------------------------------------------------------------------
# the frame
# ----------------------------------------------------------------------------------------------------------

_MIDNIGHT_RE = re.compile(r"^(\d{4}-\d{2}-\d{2})T00:00:00(?:\.0+)?(?:Z|[+-]00:?00)?$")
_ISO_RE = re.compile(r"^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$")


def read_reply(reply: Any) -> tuple[dict | None, str | None]:
    """(the frame, why there is none when the kernel said why) from the execute reply's user expression
    (kernel_thimble._frame). A code that ends in something other than a DataFrame gives (None, None)."""
    if not isinstance(reply, dict):
        return None, "the kernel sent no frame"
    if reply.get("status") != "ok":
        return None, f"{reply.get('ename') or 'Error'}: {reply.get('evalue') or ''}".strip()
    data = reply.get("data") if isinstance(reply.get("data"), dict) else {}
    try:
        got = json.loads(data.get("text/plain")) if isinstance(data.get("text/plain"), str) else None
    except ValueError:
        got = None
    if not isinstance(got, dict):
        return None, "the kernel's frame could not be read"
    raw = got.get("frame")
    if not isinstance(raw, dict):
        return None, str(got["problem"]) if got.get("problem") else None
    return normalize(raw), None


def _guess_type(values: list) -> str:
    vals = [v for v in values if v is not None]
    if vals and all(_is_number(v) for v in vals):
        return "quantitative"
    if vals and all(isinstance(v, str) and _ISO_RE.match(v) for v in vals):
        return "temporal"
    return "nominal"


def normalize(raw: dict) -> dict:
    """A frame as the kernel sent it, in the stored form: column names as text, rows aligned with them, a temporal
    column whose every time is midnight written as dates, the types filled in, the row names and the view set."""
    columns = [str(c) for c in raw.get("columns") or []]
    rows = [list(r) + [None] * (len(columns) - len(r)) if isinstance(r, list) else [None] * len(columns)
            for r in raw.get("rows") or []]
    rows = [r[: len(columns)] for r in rows]
    types = raw.get("types") if isinstance(raw.get("types"), dict) else {}
    types = {c: (types.get(c) if types.get(c) in TYPES else _guess_type([r[j] for r in rows]))
             for j, c in enumerate(columns)}
    for j, c in enumerate(columns):
        if types[c] == "nominal" and _guess_type([r[j] for r in rows]) == "quantitative":
            types[c] = "quantitative"  # numbers of object dtype
    for j, c in enumerate(columns):
        vals = [r[j] for r in rows if r[j] is not None]
        if types[c] == "temporal" and vals and all(isinstance(v, str) and _MIDNIGHT_RE.match(v) for v in vals):
            for r in rows:
                if isinstance(r[j], str):
                    r[j] = _MIDNIGHT_RE.match(r[j]).group(1)  # type: ignore[union-attr]
    index = raw.get("index")
    if isinstance(index, list):
        index = str(index[0]) if len(index) == 1 else None
    index = str(index) if isinstance(index, str) and str(index) in columns else None
    total = raw.get("total")
    total = total if isinstance(total, int) and total >= len(rows) else len(rows)
    f = {"columns": columns, "types": types, "index": index, "rows": rows, "total": total}
    f["label"] = label_column(f)
    f["view"] = view_of(f)
    return f


_UNNAMED_INDEX = re.compile(r"^(?:index|level_\d+)$")


def corner(frame: dict) -> str:
    """The header over a frame's row names: the label column's name, or '' for an unnamed index."""
    lab = str(frame.get("label") or "")
    return "" if lab and lab == frame.get("index") and _UNNAMED_INDEX.match(lab) else lab


def _numbers_as_text(frame: dict) -> bool:
    """Whether a stored frame types a column of numbers as text."""
    types = frame.get("types") or {}
    return any(types.get(c) == "nominal" and _guess_type([r[j] if j < len(r) else None for r in frame["rows"] if isinstance(r, list)])
               == "quantitative" for j, c in enumerate(frame["columns"]))


def column(frame: dict, name: str) -> list:
    j = frame["columns"].index(name)
    return [r[j] for r in frame["rows"]]


def label_column(frame: dict) -> str | None:
    """The column whose values name the frame's rows in a ref."""
    if frame.get("index") in frame["columns"]:
        return frame["index"]
    for c in frame["columns"]:
        vals = column(frame, c)
        if vals and all(isinstance(v, str) and v.strip() for v in vals) and len(set(vals)) == len(vals):
            return c
    return None


def view_of(frame: dict) -> dict:
    """What the card shows of a frame: every column but the row names, each number column's format (the row names'
    too when they are numbers), and how many rows of the DataFrame the card does not keep."""
    lab = frame.get("label")
    shown = [c for c in frame["columns"] if c != lab]
    formats = {c: default_format(column(frame, c)) for c in [*([lab] if lab else []), *shown]
               if frame["types"].get(c) == "quantitative"}
    return {"columns": shown, "formats": formats, "more": max(0, frame["total"] - len(frame["rows"]))}


def row_labels(frame: dict) -> list[str]:
    """Each row's name in a ref: its label column's value as text (a whole float without `.0`), else its position from
    0. A name stays unformatted (step 5500, not 5,500), since that is how the model cites the row."""
    lab = frame.get("label")
    if lab in frame["columns"]:
        return [str(int(v)) if isinstance(v, float) and v.is_integer() else show(v) for v in column(frame, lab)]
    return [str(i) for i in range(len(frame["rows"]))]


def frame_grid(frame: dict, rows: list[int] | None = None) -> tuple[list[str], list[str], list[list[str]]]:
    """(the shown columns, each row's name as a ref writes it, each row's values as the card shows them)."""
    view = frame.get("view") or view_of(frame)
    fmts = view.get("formats") or {}
    cols = [c for c in view.get("columns") or [] if c in frame["columns"]]
    idx = [frame["columns"].index(c) for c in cols]
    labels = row_labels(frame)
    rows = list(range(len(frame["rows"]))) if rows is None else rows
    cells = [[show(frame["rows"][i][j], fmts.get(c)) for j, c in zip(idx, cols)] for i in rows]
    return cols, [labels[i] for i in rows], cells


def frame_text(frame: dict, limit: int = TEXT_ROWS) -> str:
    """The rows as the model reads them, aligned like a printed DataFrame (at most `limit` rows, then pandas' own
    `[n rows x m columns]` line)."""
    n = len(frame["rows"])
    cols, names, cells = frame_grid(frame, list(range(min(n, limit))))
    lab = frame.get("label") or ""
    grid = [[corner(frame), *cols], *([name, *r] for name, r in zip(names, cells))]
    width = [min(TEXT_WIDTH, max(len(r[j]) for r in grid)) for j in range(len(grid[0]))]
    lines = ["  ".join(v.ljust(w) for v, w in zip(r, width)).rstrip() for r in grid]
    if n > limit or frame["total"] > n:
        lines.append(f"[{frame['total']} rows x {len(cols) + (1 if lab else 0)} columns]")
    return "\n".join(lines)


def bundle(frame: dict) -> dict:
    """The output bundle a frame is stored as: the frame, and its text for the model."""
    return {FRAME_MIME: frame, "text/plain": frame_text(frame)}


def frame_of(b: Any) -> dict | None:
    """The frame a bundle holds, with its row names and view (worked out for a bundle stored without them); None for
    any other bundle."""
    if not isinstance(b, dict):
        return None
    f = b.get(FRAME_MIME)
    if isinstance(f, str):
        try:
            f = json.loads(f)
        except ValueError:
            return None
    if not isinstance(f, dict) or not isinstance(f.get("columns"), list) or not isinstance(f.get("rows"), list):
        return None
    if "view" not in f or "label" not in f or "types" not in f or _numbers_as_text(f):
        f = normalize(f)
    return f


def frame_in(outputs: Any) -> dict | None:
    """The frame among a card's outputs, or None."""
    for b in outputs or []:
        f = frame_of(b)
        if f is not None:
            return f
    return None


def apply_run(outputs: list[dict], status: str, reply: Any, result_index: int | None) -> list[dict]:
    """A table card's outputs after a run, with its DataFrame kept (notebook._execute_cell): the frame's bundle in place
    of the DataFrame's own display, the execute_result at `result_index`. A run that errored, and one whose code ends
    in no DataFrame, keep their outputs as they are, so the kind check says what the card shows instead."""
    if status != "ok" or result_index is None or not 0 <= result_index < len(outputs):
        return outputs
    frame, _ = read_reply(reply)
    if frame is None:
        return outputs
    out = list(outputs)
    out[result_index] = bundle(frame)
    return out


# ----------------------------------------------------------------------------------------------------------
# the frame as a table of citable values (cite.table_html, cite.find_td and cite._output_sources read these)
# ----------------------------------------------------------------------------------------------------------


def frame_cells(b: Any) -> list[tuple[str, str, str]] | None:
    """(column, row name, value as shown) for every value the card shows of a frame bundle; None for any other bundle."""
    f = frame_of(b)
    if f is None:
        return None
    cols, names, cells = frame_grid(f)
    return [(c, n, v) for n, r in zip(names, cells) for c, v in zip(cols, r)]


def frame_html(b: Any, around: str | None = None, window: int = 8) -> str:
    """The shown values of a frame bundle as the pandas-shaped html table cite.table_cells reads (a header row, then
    each row's name in a th before its values); with `around`, a row's name, only the `window` rows either side of it,
    for a citation's preview."""
    f = frame_of(b)
    if f is None:
        return ""
    rows = list(range(len(f["rows"])))
    names = row_labels(f)
    if around is not None and around in names:
        k = names.index(around)
        rows = rows[max(0, k - window):k + window + 1]
    cols, names, cells = frame_grid(f, rows)
    esc = _html.escape
    head = f"<tr><th>{esc(corner(f))}</th>" + "".join(f"<th>{esc(c)}</th>" for c in cols) + "</tr>"
    body = "".join(f"<tr><th>{esc(n)}</th>" + "".join(f"<td>{esc(v)}</td>" for v in r) + "</tr>"
                   for n, r in zip(names, cells))
    return f"<table><thead>{head}</thead><tbody>{body}</tbody></table>"


def locate(b: Any, col: str, row: str) -> str | None:
    """The value a ref's column and row name in a frame bundle, as the card shows it; None when the frame has no such
    column or row, or the bundle holds no frame."""
    f = frame_of(b)
    if f is None:
        return None
    labels = row_labels(f)
    lab = f.get("label")
    if row not in labels or (col not in (f.get("view") or {}).get("columns", []) and col != lab):
        return None
    i = labels.index(row)
    return show(f["rows"][i][f["columns"].index(col)], ((f.get("view") or {}).get("formats") or {}).get(col))
