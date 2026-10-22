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


KIT_MIME = "application/vnd.thimble.kit+json"
# the ids a drawn part can hold (browser/kit/kit.js ID_RE)
PART_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}")


def part_id(anchor: str) -> str:
    """The id the drawing kit gives a part a program names `anchor` (kit.js regionId): the anchor itself when an id can
    hold it, else its slug, as kit.js slug() writes it. So `page-dse/StartSeite` is drawn as `page-dse-startseite`."""
    if PART_ID.fullmatch(anchor):
        return anchor
    t = re.sub(r"^-+|-+$", "", re.sub(r"[^a-z0-9_.:]+", "-", anchor.lower()))[:48]
    return t if re.match(r"[a-z0-9]", t) else "r"


def _drawings(outputs: Any) -> Iterator[dict]:
    for o in outputs or []:
        kit = o.get(KIT_MIME) if isinstance(o, dict) else None
        if isinstance(kit, dict) and isinstance(kit.get("drawing"), dict):
            yield kit["drawing"]


def region(outputs: Any, anchor: str) -> dict[str, Any] | None:
    """The part of a program card's drawing that a citation's anchor names, {id, meta}, or None. The anchor is read as
    written and as the kit renames it (part_id)."""
    ids = {anchor, part_id(anchor)}
    for d in _drawings(outputs):
        for r in d.get("regions") or []:
            if isinstance(r, dict) and r.get("id") in ids:
                return r
    return None


def region_words(outputs: Any, rid: str, limit: int = 4000) -> str:
    """The words a drawn part shows: its label, then the text it draws, as far as `limit`."""
    out: list[str] = []
    r = region(outputs, rid)
    meta = r.get("meta") if r and isinstance(r.get("meta"), dict) else {}
    if meta.get("label"):
        out.append(str(meta["label"]))

    def walk(n: Any, inside: bool, d: int = 0) -> None:
        if d > 40 or sum(len(x) for x in out) > limit:
            return
        if isinstance(n, dict):
            here = inside or (n.get("t") == "region" and r is not None and n.get("id") == r.get("id"))
            if here and isinstance(n.get("s"), str):
                out.append(n["s"])
            for k, v in n.items():
                if k != "meta":
                    walk(v, here, d + 1)
        elif isinstance(n, list):
            for v in n:
                walk(v, inside, d + 1)

    if r is not None:
        for dr in _drawings(outputs):
            walk(dr.get("root"), False)
    return " ".join(out)[:limit]


def series_values(outputs: Any, rid: str) -> list[float] | None:
    """The y values of the plot series a program draws as the part `rid` (kit.js plot keeps each series' points `pts`,
    [x, y] pairs, and its part id `region`), or None when that part is no plot series. A series' name says what it
    counts, so its digits (`wins vs skill 0`) are no value of it; its points are."""
    r = region(outputs, rid)
    if r is None:
        return None
    want = r.get("id")

    def walk(n: Any, d: int = 0) -> list[float] | None:
        if d > 40:
            return None
        if isinstance(n, dict):
            if n.get("t") == "plot" and isinstance(n.get("series"), list):
                for s in n["series"]:
                    if isinstance(s, dict) and s.get("region") == want:
                        return [p[1] for p in s.get("pts") or [] if isinstance(p, (list, tuple)) and len(p) > 1
                                and isinstance(p[1], (int, float)) and not isinstance(p[1], bool)]
            kids = n.values()
        elif isinstance(n, list):
            kids = n
        else:
            return None
        for v in kids:
            got = walk(v, d + 1)
            if got is not None:
                return got
        return None

    for dr in _drawings(outputs):
        got = walk(dr.get("root"))
        if got is not None:
            return got
    return None


def link_spans(text: str) -> list[tuple[str, str, int, int]]:
    """(words, target, start, end) of each Markdown link `[words](target)` of a text, not an image's. A target may hold
    spaces and balanced brackets, so a ref to a row named "(no name)", `[899](card:<id>#edits/(no name))`, is one link
    (the page's linkSpans, the kernel's refs.link_spans and the terminal's linkSpans read it the same). Words hold no
    bracket and no line break."""
    s = text or ""
    out: list[tuple[str, str, int, int]] = []
    i = 0
    while True:
        a = s.find("[", i)
        if a < 0:
            break
        b = s.find("]", a + 1)
        if b < 0:
            break
        words = s[a + 1:b]
        if (a > 0 and s[a - 1] == "!") or "[" in words or "\n" in words or s[b + 1:b + 2] != "(":
            i = a + 1
            continue
        depth, j = 0, b + 2
        while j < len(s) and s[j] != "\n":
            if s[j] == "(":
                depth += 1
            elif s[j] == ")":
                if depth == 0:
                    break
                depth -= 1
            j += 1
        target = s[b + 2:j]
        if s[j:j + 1] != ")" or not target.strip():
            i = a + 1
            continue
        out.append((words, target, a, j + 1))
        i = j + 1
    return out


def map_links(text: str, fn) -> str:
    """`text` with each link (link_spans) replaced by `fn(words, target, whole)`."""
    s = text or ""
    out: list[str] = []
    at = 0
    for words, target, a, b in link_spans(s):
        out.append(s[at:a])
        out.append(fn(words, target, s[a:b]))
        at = b
    out.append(s[at:])
    return "".join(out)


# a mark that only groups a number's digits (8,452, or 8 452 with a thin or no-break space), and a space before a
# percent (24.2 %): the check drops both, as the terminal's kernel/objects.py reads a number
_GROUP = re.compile("(?<=\\d)[,\u00a0\u2009\u202f](?=\\d)|(?<=\\d)\\s+(?=%)")


def _words(s: str) -> str:
    """Words, or a value as a card shows it, as the check compares them: digits ungrouped, the minus sign as "-", and
    each run of spaces one space, so `31 merged` still holds 31 as a whole number."""
    return " ".join(_GROUP.sub("", s.replace(frames.MINUS, "-")).split())


def sign_at(text: str, at: int) -> str:
    """The sign the words write for the number whose digits start at `at`: "-" (or "−"), "+", or "" for none. A sign
    stands right before the digits and not after a letter, digit or point, as the terminal's kernel/objects.py reads
    one: the hyphen of COVID-19, 10-14 or 2026-06-01 is no sign."""
    if at < 1 or text[at - 1] not in "-−+" or (at >= 2 and re.match(r"[A-Za-z_\d.,:]", text[at - 2])):
        return ""
    return "+" if text[at - 1] == "+" else "-"


def same_value(shown: str, label: str) -> bool:
    """Whether a citation's words (`label`) state the value the card shows: the value as a whole number or word
    anywhere in them (`31 merged`, `8,452 of the 14,591 edits`), digit grouping aside. A number the words write with no
    sign of its own states the value's size, either sign (`14.2 points below` states −14.2); one written with a sign
    (`-14.2`, `+14.2`) states the sign too."""
    a, b = _words(shown), _words(label)
    neg = a[:1] == "-" and a[1:2].isdigit()
    if a[:1] in ("-", "+") and a[1:2].isdigit():
        a = a[1:]
    if not a or not b:
        return False
    for m in re.finditer(rf"(?<![\w.]){re.escape(a)}(?![\w]|\.\d)", b):
        sign = sign_at(b, m.start()) if a[0].isdigit() else ""
        if not sign or (sign == "-") == neg:
            return True
    return False


def chart_text(b: Any, card: str) -> str | None:
    """What the model reads of a chart: its rows, as a table's are read, and how to cite them; None for no rows."""
    f = chart_frame(b)
    if f is None:
        return None
    return f"(cite a value as card:{card}#<column>/<row>):\n{frames.frame_text(f)}"
