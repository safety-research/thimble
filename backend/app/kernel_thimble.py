"""`thimble`, the module a card's code imports for thimble's data and for the drawings the canvas makes.

Runs inside a workspace kernel: the kernel reads this file at its start (notebook.startup_lines), builds a module from
it with `WS` (the workspace directory) set and registers it as `thimble`.

    thimble.labels()          the labels defined in this workspace: name, id, kind, unit, values, n_labeled
    thimble.labels("<name>")  one label's matches as a DataFrame (path, line, effective, label, source, verdict,
                              confidence, ref), one row per unit whose effective label is the label's first value;
                              `effective` is the analyst's verdict when there is one, else the classifier's label
    thimble.labels("<name>", negatives=True)
                              every labeled unit, the other values included
    thimble.colors("<name>", values=None)
                              {value: color} in the colors the label's tags show; with `values`, other values get
                              neutral inks (NEUTRAL_COLOURS); thimble.colours is the same function
    thimble.diagram(nodes, edges)
                              a node-link diagram the canvas lays out: nodes as names or {id, label, detail}, edges as
                              (source, target[, label]) or dicts. A node's first line is its label, the rest its
                              detail. Output is DIAGRAM_MIME with a text/plain listing the model reads and cites
    thimble.marked(ref)       in a view's reader: the marks of the labels that are on for one record, each
                              {label, value, color, id}, [] outside a view's call
    thimble.color_value(choice, ref=None, record=None)
                              in a view's reader: the value a record takes under the page's Color by (`choice`, the
                              page's color.query()), a label's value on `ref` or a field's in `record`; None for none
    thimble.color_on(choice, value)
                              in a view's reader: whether the analyst left that value's toggle on under Filter by
                              (`choice`, the page's filter.query()); True for every value of Color by's query
    thimble.kept(ref)         in a view's reader: whether the record passes the analyst's label filter (True with none)
    thimble.kept_unit(refs)   in a view's reader: whether a unit that gathers the records `refs` passes that filter,
                              judged by its records in the files the filter's label ran over (True when it has records
                              and none is in such a file, False when it has no records)
    thimble.view_labels()     in a view's reader: {labels, filter}, the labels that are on with their highlighted values,
                              and the filter {label, value, color} or None
    thimble.progress(done=None, total=None, note=None)
                              in a view's reader: how far the call has got, which the page can show while it waits;
                              nothing outside a view's call
    thimble.timeline(events, spacing="time")
                              events on a time axis: (time, label[, lane]) or {time, label, lane, end}; TIMELINE_MIME
                              with a text/plain listing. Clock times ("HH:MM[:SS]") are read on CLOCK_DAY, rolling over
                              midnight when a time goes backwards
    thimble.chart(kind, data, **options)
                              a common chart (CHARTS) of a DataFrame whose columns come in the kind's order, such as
                              bar (category, value[, group]): VEGALITE_MIME with the rows inline and no color, font or
                              size of its own, which the card draws in thimble's theme (docs/charts.md); with show=False
                              the chart as an Altair chart, which the code can add layers of its own marks to.
                              chart_spec builds the spec without showing it, for the view kit's charts too
                              (views.chart_answer)
    thimble.theme             the theme's colors by role for those marks (accent, ink, muted, pale, series), each a CSS
                              variable the card reads, so they follow the accent and the paper
    thimble.card(type, labels=None, **args)
                              a card of a card type (the workspace's CARD_TYPES_FILE): the arguments checked against the
                              type's schema, the type's card.py run on its reader's index with `labels` as the labels
                              that mark the records, shown as CARD_MIME with the type's listing as text/plain

Each list may also be a DataFrame or a dict of (key, value) pairs; anything else raises a TypeError naming the forms.
The British spellings stay as aliases: colours, colour_value and colour_on, and a mark's or a label's "colour" beside
its "color".

Server-only helpers: `_frame()` returns a table card's final DataFrame as JSON (frames.CAPTURE); `_trial_begin/_end/
_undo/_drop` let the card check run a fix's code and put names back if it is refused; `_labels_read()` reports the
labels (with revisions) the last cell read.

Rows come from labels/<id>.sqlite when it reflects the labels file, else from labels/<id>.jsonl (last row per ref wins).
A cover over a range of records supplies their negative value. Only the standard library at import; pandas is imported
when a DataFrame is made.
"""
import contextvars
import io
import json
import math
import os
import numbers
import re
import sqlite3
import threading
import zlib
from pathlib import Path

WS = globals().get("WS")  # the workspace directory, set by the injector (notebook.startup_lines)

__all__ = ["labels", "colors", "marked", "kept", "view_labels", "color_value", "color_on", "progress", "diagram", "timeline",
           "chart", "theme", "card", "colours", "colour_value", "colour_on"]

FRAME_ROWS = 500  # rows of a table card's DataFrame the card keeps and shows (frames.ROWS_MAX)

CLOCK_DAY = "2000-01-01"  # the day clock times are read on (timeline); the canvas prints them as times of day

DIAGRAM_MIME = "application/vnd.thimble.diagram+json"  # tools.DRAWING_MIMES and frontend components/Outputs.tsx
TIMELINE_MIME = "application/vnd.thimble.timeline+json"

_COLUMNS = ["path", "line", "effective", "label", "source", "verdict", "confidence", "ref"]

# A label class's colour by index (concepts.PICKS): 0 is --label-none, the grey of a negative class; 1..18 are
# --label-1..18 (styles/tokens.css), of which new values take 1..12 (LABEL_ORDER) and the analyst alone picks 13..18,
# red, purple and pink.
LABEL_COLOURS = ["#a09c93", "#025ac3", "#d0750a", "#06572a", "#1392d4", "#7d6702", "#009c85", "#844500", "#013c77", "#2aa02b", "#025a7c",
                 "#622b01", "#0389a0", "#d0342c", "#8a1c1c", "#7b4fd6", "#4c2a91", "#d23f8b", "#8d1d5c"]
# The order new values take the palette's places (indices into LABEL_COLOURS): blue, orange, green, gold, teal, brown,
# sky, then navy, grass, cerulean, chestnut and cyan, so a label's first five values are five hues with no second blue.
# A stored place keeps its hue; only the order new values take the places in differs. The frontend and the view kit
# read the same order from label_order.json, which test_label_order holds equal to this.
LABEL_ORDER = (1, 2, 3, 5, 6, 7, 4, 8, 9, 10, 11, 12)
# A value a label does not define: --viz-ink-1, -2 and -4 in turn (the third step is the label grey's near twin).
NEUTRAL_COLOURS = ["#1b1a18", "#6b675f", "#cfcbc2"]
_QUIET = frozenset({"no", "none", "other", "no match", "not", "neither", "n/a", "unknown"})  # concepts.QUIET_VALUES
_LEFTOVER = frozenset({"no", "not", "none", "neither", "nothing", "other", "unrelated", "irrelevant"})  # concepts.LEFTOVER_WORDS


def _negative(value: str, index: int, n: int) -> bool:
    """concepts.is_negative: a quiet word, the second of two, or a last value of more that starts with a leftover word."""
    v = value.strip().lower()
    return v in _QUIET or (n == 2 and index == 1) or (n > 2 and index == n - 1 and v.split(" ", 1)[0] in _LEFTOVER)


def palette_from(start: int) -> tuple:
    """The palette's places in LABEL_ORDER from `start` on, round the order; from the first when `start` is no place."""
    i = LABEL_ORDER.index(start) if start in LABEL_ORDER else 0
    return LABEL_ORDER[i:] + LABEL_ORDER[:i]


def _ws() -> Path:
    if not WS:
        raise RuntimeError("thimble.labels: this kernel was started without a workspace; run the card from thimble")
    return Path(str(WS))


def _concepts(ws=None) -> list:
    """Every concept file of the workspace, oldest first (the fields a cell needs); of the workspace folder `ws` when
    given, else the kernel's."""
    out = []
    d = (Path(ws) if ws is not None else _ws()) / "concepts"
    for p in sorted(d.glob("*.json")) if d.is_dir() else []:
        try:
            with open(p, "r", encoding="utf-8") as f:
                k = json.load(f)
        except (OSError, ValueError):
            continue
        if not isinstance(k, dict):
            continue
        stats = k.get("label_stats") if isinstance(k.get("label_stats"), dict) else {}
        out.append({"id": str(k.get("id") or p.stem), "name": str(k.get("name") or p.stem), "kind": k.get("kind"),
                    "unit": k.get("unit"), "values": list(k.get("labels") or []), "n_labeled": int(stats.get("n_labeled") or 0),
                    "superseded_by": k.get("superseded_by"), "ts": str(k.get("ts") or ""), "rev": _rev(k.get("rev")),
                    "classes": _classes(k)})
    out.sort(key=lambda k: (k["ts"], k["id"]))
    return _fill_colours(out)


def _classes(k: dict) -> list:
    """A concept's classes as [value, colour index or None], in the order of its values (concepts.classes_of over
    concepts._labels_list): the stored colour of a class of that name, else None until _fill_colours gives it one."""
    values = []
    for v in k.get("labels") if isinstance(k.get("labels"), list) else []:
        v = str(v).strip()
        if v and v not in values:
            values.append(v)
    stored = {}
    for c in k.get("classes") if isinstance(k.get("classes"), list) else []:
        if isinstance(c, dict) and str(c.get("name") or "").strip():
            stored.setdefault(str(c["name"]).strip(), c.get("color"))
    out = []
    for v in values or ["yes", "no"]:
        try:
            n = int(stored.get(v))
        except (TypeError, ValueError):
            n = None
        out.append([v, n if n is not None and 0 <= n < len(LABEL_COLOURS) else None])
    return out


def _fill_colours(ks: list) -> list:
    """Give every class without a color the one concepts.fill_colours gives it, in place, taking the places in
    LABEL_ORDER: while a color is free, one no class of any label has, a label's first class takes the first free one;
    else the colors in turn. A further class, i places after the first, takes the first free color from the one i
    places after the first class's, else that one. A negative class takes the gray, and a label's classes do not repeat
    a color while one remains."""
    used = {c[1] for k in ks for c in k["classes"] if c[1]}
    j = 0
    for k in ks:
        cs = k["classes"]
        if not cs:
            continue
        if cs[0][1] is None:
            cs[0][1] = next((m for m in LABEL_ORDER if m not in used), None)
            if cs[0][1] is None:
                cs[0][1] = LABEL_ORDER[j % len(LABEL_ORDER)]
                j += 1
            used.add(cs[0][1])
        base = cs[0][1] or LABEL_ORDER[0]
        taken = {base} if cs[0][1] else set()
        for i, c in enumerate(cs[1:], 1):
            if c[1] is None:
                at = palette_from(base)[i % len(LABEL_ORDER)]
                busy = used | taken
                c[1] = 0 if _negative(c[0], i, len(cs)) else next((m for m in palette_from(at) if m not in busy), at)
            if c[1] and c[1] in taken:
                c[1] = next((m for m in palette_from(c[1])[1:] if m not in taken), c[1])
            if c[1]:
                taken.add(c[1])
                used.add(c[1])
    return ks


def _rev(v) -> int:
    try:
        return int(v or 0)
    except (TypeError, ValueError):
        return 0


def _find(name: str, ws=None) -> dict:
    """A label by its id or its name (the newest of that name not superseded), in the workspace folder `ws` when given,
    else the kernel's."""
    key = " ".join(str(name or "").split())
    if not key:
        raise ValueError("thimble.labels: give the label's name (thimble.labels() lists them)")
    ks = _concepts(ws)
    for k in ks:
        if k["id"] == key:
            return k
    norm = key.casefold()
    live = [k for k in ks if k["name"].casefold() == norm and not k["superseded_by"]] or [k for k in ks if k["name"].casefold() == norm]
    if live:
        return live[-1]
    names = ", ".join(repr(k["name"]) for k in ks if not k["superseded_by"]) or "none defined yet"
    raise KeyError(f"thimble.labels: no label named {name!r}; the labels are: {names}")


def _store_fresh(jsonl: Path, db: Path) -> bool:
    """Whether the store reflects the labels file (labels_store.Store.state's `fresh`). A store keying cards by `cell:`
    refs is not, so the labels file is read instead."""
    try:
        st = jsonl.stat()
    except OSError:
        return False
    if not db.exists():
        return False
    try:
        conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=5.0)
        try:
            meta = dict(conn.execute("SELECT key, value FROM meta").fetchall())
            if conn.execute("SELECT 1 FROM current WHERE ref >= 'cell:' AND ref < 'cell;' LIMIT 1").fetchone():
                return False
        finally:
            conn.close()
    except sqlite3.Error:
        return False
    try:
        return int(meta.get("size", -1)) == st.st_size and int(meta.get("mtime_ns", -1)) == st.st_mtime_ns
    except (TypeError, ValueError):
        return False


def _ref_parts(ref: str):
    head, sep, tail = str(ref).partition("#")
    if sep and tail.startswith("L"):
        n = 0
        for ch in tail[1:]:
            if not ch.isdigit():
                break
            n = n * 10 + ord(ch) - 48
        return head, (n or None)
    return (head if head and ":" not in head else None), None


def _with_covers(rows: list, covers: list, negatives: bool) -> list:
    """`rows` (path, line, label, source, verdict, confidence, ref) with a verdict's missing label read from the cover
    that holds its record and, with `negatives`, a row for each record a cover holds that has none; `covers` is
    [(path, first, last, value, source)]."""
    if not covers:
        return rows
    by_path: dict = {}
    for c in covers:
        by_path.setdefault(c[0], []).append(c)

    def held(path, line):
        return next((c for c in by_path.get(path, ()) if line and c[1] <= line <= c[2]), None)

    out = []
    have: dict = {}
    for path, line, label, source, verdict, confidence, ref in rows:
        if label is None and (c := held(path, line)) is not None:
            label = c[3]
        out.append((path, line, label, source, verdict, confidence, ref))
        if path is not None and line is not None:
            have.setdefault(path, set()).add(line)
    if negatives:
        for path, first, last, value, source in covers:
            got = have.get(path, ())
            out.extend((path, n, value, source, None, 1.0, f"{path}#L{n}") for n in range(first, last + 1) if n not in got)
    return out


def _store_parts(db: Path):
    """(rows, covers) of the store: rows (path, line, label, source, verdict, confidence, ref), covers (path, first,
    last, value, source)."""
    conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=5.0)
    try:
        rows = conn.execute("SELECT path, line, label, source, analyst, confidence, ref FROM current "
                            "WHERE label IS NOT NULL OR analyst IS NOT NULL ORDER BY rowid").fetchall()
        try:
            covers = conn.execute("SELECT path, first, last, value, source FROM covers ORDER BY rowid").fetchall()
        except sqlite3.Error:  # a store without covers
            covers = []
    finally:
        conn.close()
    return rows, covers


def _store_rows(db: Path):
    """_store_parts with the rows as an iterator over the query, so a large label is never held as a list of rows."""
    conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=5.0)
    try:
        try:
            covers = conn.execute("SELECT path, first, last, value, source FROM covers ORDER BY rowid").fetchall()
        except sqlite3.Error:  # a store without covers
            covers = []
        cur = conn.execute("SELECT path, line, label, source, analyst, confidence, ref FROM current "
                           "WHERE label IS NOT NULL OR analyst IS NOT NULL ORDER BY rowid")
    except BaseException:
        conn.close()
        raise

    def rows():
        try:
            while batch := cur.fetchmany(10_000):
                yield from batch
        finally:
            conn.close()

    return rows(), covers


def _rows_from_store(db: Path, negatives: bool = False):
    return _with_covers(*_store_parts(db), negatives)


def _trim(covers: list, path: str, a: int, b: int) -> list:
    """`covers` with records a..b of `path` taken out (labels_store.trim)."""
    out = []
    for c in covers:
        if c[0] != path or c[2] < a or c[1] > b:
            out.append(c)
            continue
        if c[1] < a:
            out.append((path, c[1], a - 1, c[3], c[4]))
        if c[2] > b:
            out.append((path, b + 1, c[2], c[3], c[4]))
    return out


def _rows_from_jsonl(jsonl: Path, negatives: bool = False):
    """The labels file read whole: the last classifier row and the last analyst row per ref, its cover and clear lines
    applied in their place (labels_store, covers)."""
    return _with_covers(*_jsonl_parts(jsonl), negatives)


def _jsonl_parts(jsonl: Path):
    """(rows, covers) of the labels file, as _store_parts gives them for the store. A clear line finds the rows on its
    lines through `at`, so a run written as many cleared blocks reads in one pass."""
    model = {}
    analyst = {}
    covers: list = []
    at: dict = {}  # path -> {line: the ref, or a list of the refs, of the classifier rows there}
    try:
        f = open(jsonl, "r", encoding="utf-8")
    except OSError:
        return [], []
    with f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                r = json.loads(line)
            except ValueError:
                continue
            if not isinstance(r, dict):
                continue
            where = r.get("cover") or r.get("clear")
            if not r.get("ref") and isinstance(where, str):
                try:
                    a, b = int(r.get("from") or 1), (2**62 if r.get("to") is None else int(r["to"]))
                except (TypeError, ValueError):
                    continue
                if r.get("clear") and (got := at.get(where)):
                    span = range(a, b + 1) if b - a < len(got) else [n for n in got if a <= n <= b]
                    for n in span:
                        slot = got.pop(n, None)
                        for ref in ([slot] if isinstance(slot, str) else slot or ()):
                            m = model.get(ref)
                            if m is not None and m[0] == where and m[1] == n:
                                del model[ref]
                covers = _trim(covers, where, a, b)
                if r.get("cover") and r.get("value") is not None:
                    covers.append((where, a, b, str(r["value"]), r.get("source")))
                continue
            if not r.get("ref"):
                continue
            ref = str(r["ref"])
            ref = "card:" + ref[len("cell:"):] if ref.startswith("cell:") else ref  # `cell:` prefix read as `card:` (labels_store.canon_ref)
            path, n = _row_line(ref, r)
            if r.get("source") == "analyst":
                analyst[ref] = (path, n, r.get("label"))
                continue
            model[ref] = (path, n, r.get("label"), r.get("source"), r.get("confidence"))
            if path is not None and n:
                got = at.setdefault(path, {})
                slot = got.get(n)
                if slot is None:
                    got[n] = ref
                elif isinstance(slot, str):
                    if slot != ref:
                        got[n] = [slot, ref]
                elif ref not in slot:
                    slot.append(ref)
    out = []
    for ref, (path, n, label, source, confidence) in model.items():
        a = analyst.get(ref)
        out.append((path, n, label, source, a[2] if a else None, confidence, ref))
    for ref, (path, n, label) in analyst.items():
        if ref not in model:
            out.append((path, n, None, None, label, None, ref))
    return out, covers


def _row_line(ref: str, row: dict):
    """_ref_parts, with the line a row names (`line`) for a record whose ref carries none, such as a CSV row
    (labels_store.row_line)."""
    path, line = _ref_parts(ref)
    given = row.get("line")
    if line is None and path is not None and isinstance(given, int) and not isinstance(given, bool) and given >= 1:
        line = given
    return path, line


_LIST_COLUMNS = ["name", "id", "kind", "unit", "values", "n_labeled", "set_by_analyst"]


def labels(name=None, negatives=False):
    """thimble.labels() lists the labels, each with how many of its units the analyst set to another value
    (`set_by_analyst`); thimble.labels("<name>") returns one label's matches (every labeled unit with negatives=True).

    The analyst's verdicts override the label: a unit's `effective` value is the analyst's `verdict` where they set one,
    else the label's own (`label`), and the matches are the units whose effective value is the label's first value. So a
    value's rows here can differ from the count the label itself gave by the units the analyst set to another value; that
    is the analyst's review, not a fault (the result's `attrs["set_by_analyst"]` counts them)."""
    import pandas as pd

    if (_view_ctx or {}).get("probe") and (name is None or name == PROBE_NAME):
        return _probe_labels(pd, name, negatives)
    if name is None:
        ks = [k for k in _concepts() if not k["superseded_by"]]
        return pd.DataFrame([{"name": k["name"], "id": k["id"], "kind": k["kind"], "unit": k["unit"], "values": k["values"],
                              "n_labeled": k["n_labeled"], "set_by_analyst": _set_by_analyst(k["id"])} for k in ks],
                            columns=_LIST_COLUMNS)
    k = _find(name)
    if all(x["id"] != k["id"] for x in _LABELS_READ):
        _LABELS_READ.append({"id": k["id"], "rev": k["rev"]})
    jsonl = _ws() / "labels" / f"{k['id']}.jsonl"
    db = jsonl.with_suffix(".sqlite")
    rows = _rows_from_store(db, negatives) if _store_fresh(jsonl, db) else _rows_from_jsonl(jsonl, negatives)
    positive = k["values"][0] if k["values"] else None
    out = []
    for path, line, label, source, verdict, confidence, ref in rows:
        effective = verdict if verdict is not None else label
        if not negatives and positive is not None and effective != positive:
            continue
        out.append((path, line, effective, label, source, verdict, confidence, ref))
    df = pd.DataFrame(out, columns=_COLUMNS, dtype=object)  # object: a missing label or verdict stays None, not NaN
    df["line"] = pd.array(df["line"].tolist(), dtype="Int64")
    df["confidence"] = pd.to_numeric(df["confidence"], errors="coerce")
    df.attrs["set_by_analyst"] = sum(1 for _p, _l, label, _s, verdict, _c, _r in rows
                                     if verdict is not None and label is not None and str(verdict) != str(label))
    return df


def _set_by_analyst(concept_id: str) -> int:
    """How many units of a label the analyst set to another value than the label gave (concepts.verdicts_applied's
    count): from the store when it reflects the labels file, else from the file."""
    jsonl = _ws() / "labels" / f"{concept_id}.jsonl"
    db = jsonl.with_suffix(".sqlite")
    try:
        if _store_fresh(jsonl, db):
            # the analyst's rows alone, each with the value the label gave it: its own, or its cover's (a range of
            # records the label gave one value)
            conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=5.0)
            try:
                rows = conn.execute("SELECT path, line, label, source, analyst, confidence, ref FROM current "
                                    "WHERE analyst IS NOT NULL").fetchall()
                try:
                    covers = conn.execute("SELECT path, first, last, value, source FROM covers ORDER BY rowid").fetchall()
                except sqlite3.Error:  # a store without covers
                    covers = []
            finally:
                conn.close()
            rows = _with_covers(rows, covers, False)
        else:
            rows = _rows_from_jsonl(jsonl)
        return sum(1 for _p, _l, label, _s, verdict, _c, _r in rows
                   if verdict is not None and label is not None and str(verdict) != str(label))
    except (OSError, sqlite3.Error):
        return 0


def colors(name, values=None):
    """thimble.colors("<name>") maps each of the label's values to its color, in the label's order; with `values`,
    other values follow sorted, in the neutral inks. thimble.colours is the same function."""
    k = _find(name)
    if all(x["id"] != k["id"] for x in _LABELS_READ):
        _LABELS_READ.append({"id": k["id"], "rev": k["rev"]})
    own = {v: LABEL_COLOURS[n or 0] for v, n in k["classes"]}
    if values is None:
        return own
    if isinstance(values, (str, bytes)) or not hasattr(values, "__iter__"):
        raise TypeError("thimble.colors takes the values as a list or a column, not a single value")
    given = {v for v in values if not _missing(v)}
    others = sorted((v for v in given if not (isinstance(v, str) and v in own)), key=str)
    out = {v: c for v, c in own.items() if v in given}
    out.update({v: NEUTRAL_COLOURS[i % len(NEUTRAL_COLOURS)] for i, v in enumerate(others)})
    return out


colours = colors  # the British spelling, kept so that a card written with it still runs


# A view's reader call sets _view_ctx (view_host) to the labels context views.labels_context builds: {"labels": [{id,
# name, colour, values: [{name, colour, highlight}], jsonl}], "filter": {id, label, value, colour} | None}, or to the
# probe {"probe": n, "filter": bool}, a test label that marks every record whose line is a multiple of n. Outside a
# view's call it is None, and marked() and kept() answer as if no label were on.
_view_ctx = None
_view_paths: list = []  # the claimed files of the view whose reader call is running, but those it shows whole
# During a view's records call (view_host) a set of the refs kept() and kept_unit() refused, which thimble counts above
# the view as hidden by the filter; None outside one.
_left_out = None
PROBE_NAME = "test label"
PROBE_ID = "test-label"
# the colour the analyst's first label takes (--label-1, the first of LABEL_ORDER), so the pictures show a view's own
# colour that clashes with a label where the analyst would see it
PROBE_COLOUR = LABEL_COLOURS[LABEL_ORDER[0]]
# labels file -> (the files' signature, (_Values, {path: [(first, last, value)]}, {path})), the most recently used last
_MEMBERS: dict = {}
# above the labels any context holds: labels that do not all fit here are read again on every call
MEMBERS_KEPT = 64
_MEMBERS_LOCK = threading.Lock()  # guards _MEMBERS and _READING
_READING: dict = {}  # labels file -> the lock held while one thread reads its members, which the others wait for
DENSE_MIN = 1 / 16  # a file's line refs fill at least this share of its lines up to the last: one code per line


class _Values:
    """{ref: value} of one label, kept small: the values of `<path>#L<n>` refs as one code per line of each file (bytes
    indexed by line where they are dense, else sorted line numbers beside their codes), every other ref in a dict. Reads
    as a read-only mapping of the refs to their values."""

    def __init__(self) -> None:
        self._names: list = [None]  # code -> value; code 0 is none
        self._codes: dict = {}
        self._pending: dict = {}  # path -> (lines, codes, whether a line that has a code keeps it), in the order added
        self._lines: dict = {}  # path -> codes indexed by line, or (lines ascending, their codes)
        self._other: dict = {}
        self._n = 0

    def _code(self, value) -> int:
        c = self._codes.get(value)
        if c is None:
            c = self._codes[value] = len(self._names)
            self._names.append(value)
        return c

    def add(self, ref: str, value, keep: bool = False) -> None:
        """Give the ref its value, a later call winning, or with `keep` only when it has none yet; seal() packs them."""
        path, line = _ref_parts(ref)
        if line is None or path is None or ref != f"{path}#L{line}":
            if not keep or ref not in self._other:
                self._other[ref] = value
            return
        self.add_line(path, line, value, keep)

    def add_line(self, path: str, line: int, value, keep: bool = False) -> None:
        """add() for the ref `<path>#L<line>`."""
        got = self._pending.get(path)
        if got is None:
            from array import array

            got = self._pending[path] = (array("Q"), array("I"), bytearray())
        got[0].append(line)
        got[1].append(self._code(value))
        got[2].append(1 if keep else 0)

    def seal(self) -> "_Values":
        from array import array

        wide = len(self._names) > 256
        for path, (lines, codes, keeps) in self._pending.items():
            top = max(lines)
            if len(lines) >= top * DENSE_MIN:
                out = array("I", bytes(4 * (top + 1))) if wide else bytearray(top + 1)
                for n, c, k in zip(lines, codes, keeps):
                    if not k or not out[n]:
                        out[n] = c
                self._lines[path] = out if wide else bytes(out)
                self._n += (top + 1) - out.count(0)
            else:
                last: dict = {}
                for n, c, k in zip(lines, codes, keeps):
                    if not k or n not in last:
                        last[n] = c
                order = sorted(last)
                self._lines[path] = (array("Q", order), array("I", (last[n] for n in order)))
                self._n += len(order)
        self._pending = {}
        self._n += len(self._other)
        return self

    def _line_code(self, path: str, line: int) -> int:
        got = self._lines.get(path)
        if got is None:
            return 0
        if isinstance(got, tuple):
            from bisect import bisect_left

            order, codes = got
            i = bisect_left(order, line)
            return codes[i] if i < len(order) and order[i] == line else 0
        return got[line] if 0 < line < len(got) else 0

    def get(self, ref, default=None):
        ref = str(ref)
        path, sep, tail = ref.rpartition("#L")
        if sep and tail.isascii() and tail.isdigit() and tail[0] != "0":
            c = self._line_code(path, int(tail))
            if c:
                return self._names[c]
        return self._other.get(ref, default)

    def __getitem__(self, ref):
        v = self.get(ref, _ABSENT)
        if v is _ABSENT:
            raise KeyError(ref)
        return v

    def __contains__(self, ref) -> bool:
        return self.get(ref, _ABSENT) is not _ABSENT

    def __len__(self) -> int:
        return self._n

    def items(self):
        for path, got in self._lines.items():
            if isinstance(got, tuple):
                for n, c in zip(*got):
                    yield f"{path}#L{n}", self._names[c]
            else:
                for n, c in enumerate(got):
                    if c:
                        yield f"{path}#L{n}", self._names[c]
        yield from self._other.items()

    def __iter__(self):
        return (ref for ref, _ in self.items())

    def keys(self):
        return iter(self)

    def values(self):
        return (v for _, v in self.items())


_ABSENT = object()


def _signature(*paths: Path) -> tuple:
    out = []
    for p in paths:
        try:
            st = p.stat()
            out.append((st.st_mtime_ns, st.st_size))
        except OSError:
            out.append(None)
    return tuple(out)


def _members(jsonl) -> tuple:
    """({ref: effective value}, {path: [(first, last, value)]}, {path}) of one label: its rows' values, its covers, and
    the files it left a value on. Read from its store when that is fresh, else its labels file, and kept until either
    file changes (at most MEMBERS_KEPT labels), so a reader's lookups cost a lookup each. Threads that ask for the same
    label at once wait for the first one's read."""
    jsonl = Path(jsonl)
    key = str(jsonl)
    with _MEMBERS_LOCK:
        reading = _READING.setdefault(key, threading.Lock())
    with reading:
        db = jsonl.with_suffix(".sqlite")
        sig = _signature(jsonl, db)
        with _MEMBERS_LOCK:
            hit = _MEMBERS.pop(key, None)
            if hit is not None and hit[0] == sig:
                _MEMBERS[key] = hit
                return hit[1]
        members = _read_members(jsonl, db)
        with _MEMBERS_LOCK:
            _MEMBERS[key] = (sig, members)
            while len(_MEMBERS) > MEMBERS_KEPT:
                _READING.pop(gone := next(iter(_MEMBERS)), None)
                del _MEMBERS[gone]
        return members


def _read_members(jsonl: Path, db: Path) -> tuple:
    rows, covers = _store_rows(db) if _store_fresh(jsonl, db) else _jsonl_parts(jsonl)
    values = _Values()
    paths = set()
    starts = []  # a record of a CSV or a JSON document by the line it starts on, as a view that reads its lines names it
    for path, line, label, _source, verdict, _confidence, ref in rows:
        v = verdict if verdict is not None else label
        if v is not None:
            ref = str(ref)
            if path is not None and line is not None and ref == f"{path}#L{line}":
                values.add_line(path, line, str(v))
            else:
                values.add(ref, str(v))
            if path is not None:
                paths.add(str(path))
                if line is not None and _ref_parts(str(ref))[1] is None:
                    starts.append((f"{path}#L{int(line)}", str(v)))
    rows = None
    for ref, v in starts:
        values.add(ref, v, keep=True)
    values.seal()
    spans: dict = {}
    for c in covers:
        if c[3] is not None:
            spans.setdefault(c[0], []).append((int(c[1]), int(c[2]), str(c[3])))
            paths.add(str(c[0]))
    return values, spans, paths


def _label_members(label: dict) -> tuple:
    """The label's members (_members), looked up once per labels context: each reader call gets a fresh context, so a
    reader that asks about every record reads no file state per record."""
    members = label.get("_members")
    if members is None:
        members = label["_members"] = _members(label["jsonl"]) if label.get("jsonl") else ({}, {}, set())
    return members


def _value_of(label: dict, ref: str):
    """The label's effective value on the record `ref`: its row's, else the value of the cover that holds its line."""
    values, spans, _paths = _label_members(label)
    v = values.get(ref)
    if v is None:
        c = _canon(ref)
        if c != ref:
            v = values.get(c)
    if v is not None or not spans:
        return v
    path, line = _ref_parts(ref)
    if path is None or line is None:
        return None
    return next((value for a, b, value in spans.get(path, ()) if a <= line <= b), None)


_PDF_PAGE = re.compile(r"^(.+\.[Pp][Dd][Ff])#(?:p|page=?)(\d+)$")


def _canon(ref: str) -> str:
    """A record's ref as label rows key it (records.canon): a PDF's `#page=<n>` as `#p<n>`."""
    if "#p" not in ref:  # names no PDF page: skip the regex, which a view's reader runs on each record it marks
        return ref
    m = _PDF_PAGE.match(ref)
    return f"{m[1]}#p{int(m[2])}" if m else ref


_LINES: dict = {}  # path -> ((mtime_ns, size), line count)


def _line_count(path: str) -> int:
    try:
        st = os.stat(path)
    except OSError:
        return 0
    sig = (st.st_mtime_ns, st.st_size)
    hit = _LINES.get(path)
    if hit is not None and hit[0] == sig:
        return hit[1]
    n = 0
    with io.open(path, "rb") as f:
        head = f.read(4096)
        if b"\0" in head:
            n = 0
        else:
            f.seek(0)
            last = b""
            for block in iter(lambda: f.read(1 << 20), b""):
                n += block.count(b"\n")
                last = block
            if last and not last.endswith(b"\n"):
                n += 1
    _LINES[path] = (sig, n)
    return n


def _probe_labels(pd, name, negatives):
    """thimble.labels() under the test label: the list holds it alone, and its matches are the lines of the view's
    claimed files whose number is a multiple of the probe's, with every other line under negatives=True."""
    every = int(_view_ctx["probe"])
    if name is None:
        return pd.DataFrame([{"name": PROBE_NAME, "id": PROBE_ID, "kind": "regex", "unit": "line", "values": [PROBE_NAME],
                              "n_labeled": None, "set_by_analyst": 0}], columns=_LIST_COLUMNS)
    out = []
    for path in _view_paths:
        for line in range(1, _line_count(path) + 1):
            hit = line % every == 0
            if hit or negatives:
                value = PROBE_NAME if hit else None
                out.append((path, line, value, value, "probe", None, None, f"{path}#L{line}"))
    df = pd.DataFrame(out, columns=_COLUMNS, dtype=object)
    df["line"] = pd.array(df["line"].tolist(), dtype="Int64")
    df["confidence"] = pd.to_numeric(df["confidence"], errors="coerce")
    return df


def _probed(ref: str, every) -> bool:
    """Whether the test label marks the record: a line whose number is a multiple of `every`, or a record of another
    reader (a database row, a page, a JSON value, a CSV row) whose ref's checksum is."""
    _path, line = _ref_parts(ref)
    if line:
        return line % int(every) == 0
    if "#" not in ref or ref.startswith(("view:", "card:", "cell:")):
        return False
    return zlib.crc32(_canon(ref).encode("utf-8")) % int(every) == 0


def marked(ref):
    """The marks of the labels that are on for the record `ref` (`<path>#L<n>`, or the ref of a record of another reader
    such as `<db>#<table>/<key>` or `<pdf>#p<n>`): each {label, value, color, id} (with "colour" the same) whose value
    the record takes and the analyst highlights, in the labels' order. [] outside a view's reader call."""
    return [_both(m) for m in _marked(_view_ctx, ref)]


def color_value(choice, ref=None, record=None):
    """The value a record takes under the view's Color by, `choice` being what the page's color.query() sent with its
    fetch (viewer_colour.js): for a label, {label: id, name}, the label's highlighted value on the record `ref`, else
    None; for a field of the view, {field}, record[field] (record a dict), else None. None for no choice."""
    if not isinstance(choice, dict):
        return None
    if choice.get("label") is not None:
        if ref is None:
            return None
        want = str(choice.get("label"))
        hit = next((m for m in _marked(_view_ctx, ref) if m.get("id") == want), None)
        return None if hit is None else hit.get("value")
    field = choice.get("field")
    if field is None or not isinstance(record, dict):
        return None
    v = record.get(field)
    return None if _missing(v) or v == "" else str(v)


def color_on(choice, value):
    """Whether the analyst left a value's toggle on under the view's Filter by (`choice`, the page's filter.query()),
    None standing for the records that take no value: True for every value with no choice, and for every value of Color
    by's color.query(), which names no value turned off since Color by hides no record."""
    if not isinstance(choice, dict):
        return True
    off = choice.get("off") or []
    return (None if value is None or value == "" else str(value)) not in off


# the British spellings, kept so that a reader written with them still runs
colour_value = color_value
colour_on = color_on


def kept(ref):
    """Whether the record `ref` passes the analyst's label filter: True with no filter or when the filter's label left
    no value in the record's file, else whether the label takes the filter's value on it."""
    out = _kept(_view_ctx, ref)
    if not out and _left_out is not None:
        _left_out.add(str(ref))
    return out


def kept_unit(refs):
    """Whether a unit that gathers the records `refs` passes the analyst's label filter: True with no filter; with one,
    False for a unit with no records, True when the filter's label left no value in any of their files, else whether
    the label takes the filter's value on one of its records in a file it ran over. Records of other files never keep a
    unit, since kept holds for all of them."""
    refs = [str(r) for r in refs]
    out = _kept_unit(_view_ctx, refs)
    if not out and _left_out is not None:
        _left_out.update(refs)
    return out


# A view's reader call sets _progress (view_host) to the function that records its progress.
_progress = None


def progress(done=None, total=None, note=None):
    """Report how far a view's reader call has got: `done` of `total` steps, and a few words of what it does."""
    fn = _progress
    if fn is None:
        return
    fields = {}
    for k, v in (("done", done), ("total", total)):
        if isinstance(v, numbers.Real) and not isinstance(v, bool) and math.isfinite(v):
            fields[k] = v
    if note is not None:
        fields["note"] = " ".join(str(note).split())[:120]
    fn(**fields)


def view_labels():
    """{labels, filter}: the labels that are on, each {id, name, color, values: [{name, color}]} with its highlighted
    values, and the filter {label, value, color}, or None; each "colour" beside "color" is the same."""
    return _view_labels(_view_ctx)


def _marked(ctx, ref) -> list:
    if not ctx:
        return []
    ref = str(ref)
    if ctx.get("probe"):
        return [{"label": PROBE_NAME, "value": PROBE_NAME, "colour": PROBE_COLOUR, "id": PROBE_ID}] if _probed(ref, ctx["probe"]) else []
    out = []
    for k in ctx.get("labels") or []:
        lit = _label_lit(k)
        if not lit:
            continue
        v = _value_of(k, ref)
        if v in lit:
            out.append({"label": k.get("name"), "value": v, "colour": lit[v], "id": k.get("id")})
    return out


def _both(d: dict) -> dict:
    """A mark or a label as a reader gets it, its "colour" given again as "color" (the documented name), in place."""
    d["color"] = d.get("colour")
    return d


def _label_lit(label: dict) -> dict:
    """{value: colour} of the label's highlighted values, the first of a name winning, looked up once per labels context
    as _label_members is: _marked runs on every record a view's reader marks."""
    lit = label.get("_lit")
    if lit is None:
        lit = {}
        for x in label.get("values") or []:
            if x.get("highlight"):
                try:
                    lit.setdefault(x.get("name"), x.get("colour") or label.get("colour"))
                except TypeError:  # an unhashable name equals no value
                    pass
        label["_lit"] = lit
    return lit


def _kept(ctx, ref) -> bool:
    f = ctx.get("filter") if ctx else None
    if not f:
        return True
    ref = str(ref)
    if ctx.get("probe"):
        return _probed(ref, ctx["probe"])
    k = next((x for x in ctx.get("labels") or [] if x.get("id") == f.get("id")), None)
    if k is None:
        return False
    path, _line = _ref_parts(ref)
    # a file the label never ran over is outside the filter, so a view of other files keeps its records
    if path is not None and path not in _label_members(k)[2]:
        return True
    return _value_of(k, ref) == f.get("value")


def _kept_unit(ctx, refs) -> bool:
    f = ctx.get("filter") if ctx else None
    if not f:
        return True
    refs = [str(r) for r in refs]
    if not refs:
        return False
    if ctx.get("probe"):
        return any(_probed(r, ctx["probe"]) for r in refs)
    k = next((x for x in ctx.get("labels") or [] if x.get("id") == f.get("id")), None)
    if k is None:
        return False
    paths = _label_members(k)[2]
    ran = [r for r in refs if _ref_parts(r)[0] in paths]
    return not ran or any(_value_of(k, r) == f.get("value") for r in ran)


def _view_labels(ctx) -> dict:
    ctx = ctx or {}
    if ctx.get("probe"):
        probe = _both({"id": PROBE_ID, "name": PROBE_NAME, "colour": PROBE_COLOUR, "values": [_both({"name": PROBE_NAME, "colour": PROBE_COLOUR})]})
        f = _both({"label": PROBE_NAME, "value": PROBE_NAME, "colour": PROBE_COLOUR}) if ctx.get("filter") else None
        return {"labels": [probe], "filter": f}
    labels = [_both({"id": k.get("id"), "name": k.get("name"), "colour": k.get("colour"),
                     "values": [_both({"name": v.get("name"), "colour": v.get("colour")}) for v in k.get("values") or [] if v.get("highlight")]})
              for k in ctx.get("labels") or []]
    f = ctx.get("filter")
    return {"labels": labels, "filter": _both({"label": f.get("label"), "value": f.get("value"), "colour": f.get("colour")}) if f else None}


def _missing(v) -> bool:
    """Whether a value is None or a missing number (NaN, pandas' NA), which no chart colors."""
    try:
        return v is None or bool(v != v)
    except (TypeError, ValueError):
        return True


def _text(v) -> str:
    """A value as a drawing's label or time: a date or a timestamp in ISO form, anything else as str."""
    iso = getattr(v, "isoformat", None)
    return str(iso()) if callable(iso) else str(v)


def _time(v):
    """A time as the canvas sorts it: a number stays a number (a step, a second), a numpy one included, since the canvas
    reads a time given as text as a date; anything else is text (_text)."""
    if isinstance(v, numbers.Real) and not isinstance(v, bool):
        item = getattr(v, "item", None)
        return item() if callable(item) else v
    return _text(v)


_CLOCK = re.compile(r"^(\d{1,3}):([0-5]\d)(?::([0-5]\d))?$")


def _clock_times(times: list) -> list | None:
    """Clock times ("01:03", "13:45:10") as ISO times on CLOCK_DAY, or None when any time is not one. A time earlier
    than the one before starts the next day; with an hour past 23 hours count from the start of CLOCK_DAY. The canvas
    reads a text time as a date, so without this it would space such events evenly."""
    parsed = []
    for t in times:
        m = _CLOCK.match(t) if isinstance(t, str) else None
        if m is None:
            return None
        parsed.append(int(m.group(1)) * 3600 + int(m.group(2)) * 60 + int(m.group(3) or 0))
    if not parsed:
        return None
    from datetime import datetime, timedelta

    base = datetime.fromisoformat(CLOCK_DAY)
    elapsed = any(sec >= 86400 for sec in parsed)  # an hour past 23: hours counted from the start, not times of day
    out, day, prev = [], 0, None
    for sec in parsed:
        if not elapsed and prev is not None and sec + day * 86400 < prev:
            day += 1
        at = sec + day * 86400
        prev = at
        out.append((base + timedelta(seconds=at)).isoformat())
    return out


def _rows(items, columns: tuple, what: str) -> list:
    """The items a drawing is given, as a list: a DataFrame's rows as dicts when it has the named `columns`, else as
    tuples in column order (so its first column is the time, or the source); a mapping's items as (key, value) pairs;
    None as no items. A string is refused, since iterating one gives its characters."""
    if items is None:
        return []
    if hasattr(items, "to_dict") and hasattr(items, "columns"):
        if all(c in items.columns for c in columns):
            return items.to_dict("records")
        return [tuple(r) for r in items.itertuples(index=False)]
    if isinstance(items, dict):
        return list(items.items())
    if isinstance(items, (str, bytes)):
        raise TypeError(f"thimble.{what} takes a list or a DataFrame, not a string")
    return list(items)


def _parts(item, n: int, what: str) -> list:
    """One item given as a tuple or a list, padded with None to `n` values; TypeError naming the forms for anything else."""
    if isinstance(item, (str, bytes)) or not hasattr(item, "__iter__"):
        raise TypeError(f"thimble.{what}: {item!r} is not one of the forms, {FORMS[what]}")
    parts = list(item)
    if len(parts) < 2:
        raise TypeError(f"thimble.{what}: {item!r} has fewer than two values; the forms are {FORMS[what]}")
    return (parts + [None] * n)[:n]


def _show(bundle: dict) -> None:
    from IPython.display import display

    display(bundle, raw=True)


# the forms each drawing takes, for the error a model reads when it gives another
FORMS = {"diagram": "an edge as (source, target), (source, target, label) or {source, target, label}",
         "timeline": "an event as (time, label), (time, label, lane) or {time, label, lane, end}"}


def _node(key: str, text: str, detail=None) -> dict:
    """A diagram's node: its label is the first line of `text`, the lines after it (or `detail`) its detail; blank lines
    and indents are dropped."""
    name, _, rest = text.strip().partition("\n")
    more = [ln.strip() for ln in (_text(detail) if detail is not None else rest).splitlines() if ln.strip()]
    node = {"id": key, "label": name.strip() or key}
    if more:
        node["detail"] = "\n".join(more)
    return node


def diagram(nodes=(), edges=()):
    """Show a node-link diagram. Returns nothing, so the card shows the drawing once."""
    ns, seen = [], set()

    def add(node_id, label=None, detail=None):
        key = _text(node_id)
        if key not in seen:
            seen.add(key)
            ns.append(_node(key, _text(label) if label is not None else key, detail))

    for n in _rows(nodes, ("id",), "diagram"):
        if isinstance(n, dict):
            node_id = next((n[k] for k in ("id", "name", "label") if n.get(k) is not None), None)
            if node_id is None:
                raise TypeError(f"thimble.diagram: the node {n!r} has no `id`; a node is a name or {{id, label}}")
            add(node_id, n.get("label"), n.get("detail", n.get("description")))
        elif isinstance(n, tuple):
            add(n[0], n[1] if len(n) > 1 else None)
        else:
            add(n)
    es = []
    for e in _rows(edges, ("source", "target"), "diagram"):
        if isinstance(e, dict):
            s, d, lab = e.get("source", e.get("from")), e.get("target", e.get("to")), e.get("label")
            if s is None or d is None:
                raise TypeError(f"thimble.diagram: the edge {e!r} has no `source` or `target`; the forms are {FORMS['diagram']}")
        else:
            s, d, lab = _parts(e, 3, "diagram")
        add(s)
        add(d)
        edge = {"source": _text(s), "target": _text(d)}
        if lab is not None and _text(lab) != "":
            edge["label"] = _text(lab)
        es.append(edge)
    linked = {x for e in es for x in (e["source"], e["target"])}
    lines = [f"diagram: {len(ns)} nodes, {len(es)} edges"]
    lines += [f"{e['source']} -> {e['target']}" + (f" ({e['label']})" if e.get("label") else "") for e in es]
    lines += [f"node {n['id']}" + (f" ({n['label']})" if n["label"] != n["id"] else "")
              + (f": {'; '.join(n['detail'].splitlines())}" if n.get("detail") else "")
              for n in ns if n["id"] not in linked or n.get("detail")]
    _show({DIAGRAM_MIME: {"nodes": ns, "edges": es}, "text/plain": "\n".join(lines)})


TIMELINE_SPACINGS = ("time", "even")  # how far apart the canvas draws the events: by the time between them, or evenly


def timeline(events=(), spacing="time"):
    """Show events on a time axis. Returns nothing, so the card shows the drawing once. `spacing` "even" draws one event
    per row at equal distance; "time", the default, spaces them by time."""
    if spacing not in TIMELINE_SPACINGS:
        raise ValueError(f"thimble.timeline: `spacing` is one of {', '.join(map(repr, TIMELINE_SPACINGS))}, not {spacing!r}")
    evs = []
    for e in _rows(events, ("time", "label"), "timeline"):
        if isinstance(e, dict):
            if e.get("time") is None:
                raise TypeError(f"thimble.timeline: the event {e!r} has no `time`; the forms are {FORMS['timeline']}")
            ev = {"time": _time(e["time"]), "label": _text(e.get("label", ""))}
            if e.get("lane") is not None:
                ev["lane"] = _text(e["lane"])
            if e.get("end") is not None:
                ev["end"] = _time(e["end"])
        else:
            t, label, lane = _parts(e, 3, "timeline")
            ev = {"time": _time(t), "label": _text(label) if label is not None else ""}
            if lane is not None:
                ev["lane"] = _text(lane)
        evs.append(ev)
    given = [ev["time"] for ev in evs]  # the listing keeps the times as the code gave them
    clock = _clock_times(given)
    if clock is not None:
        for ev, t in zip(evs, clock):
            ev["time"] = t
        ends = _clock_times([ev["end"] for ev in evs if "end" in ev])
        for ev, t in zip([ev for ev in evs if "end" in ev], ends or []):
            ev["end"] = t
    lines = [f"timeline: {len(evs)} events" + (", evenly spaced" if spacing == "even" else "")]
    lines += [f"{t}  {ev['label']}" + (f" [{ev['lane']}]" if ev.get("lane") else "") for t, ev in zip(given, evs)]
    _show({TIMELINE_MIME: {"events": evs, **({"spacing": "even"} if spacing == "even" else {})},
           "text/plain": "\n".join(lines)})


# Charts (docs/charts.md): thimble.chart(kind, data, **options) draws a common chart from a DataFrame whose columns come
# in the kind's order, as plain Vega-Lite with its rows inline and no color, font or size of its own. The card draws it
# as it draws any chart, in thimble's theme (frontend lib/vizTheme, lib/chartDefaults, which also gives a label's values
# the label's colors when the card read the label), and its rows are the table a takeaway cites (cite.chart_table).
VEGALITE_MIME = "application/vnd.vegalite.v6.json"  # the mime Altair's mimetype renderer (notebook.SHELL_LINES) shows
VEGALITE_SCHEMA = "https://vega.github.io/schema/vega-lite/v6.json"
CHART_ROWS_MAX = 5000  # the rows a chart draws at most; a histogram, a density and an ecdf take any number of values
BINS = 20  # the most bins a histogram makes when it picks its own step
BINS_MAX = 200  # the most bins a histogram's given step may make
LINE_DOTS_MAX = 30  # a line marks each value with a dot while its longest series has at most this many
STACK_FIELD = "__thimble_stack"  # a row's group's place, which a bar's segments or an area's series are stacked in
BOX_MIN = 5  # a box plot draws a box for a group of at least this many values, and a group of fewer as a strip of them
BOX_REACH = 1.5  # a box's whiskers reach the farthest values within this many box widths of it (Tukey's)
BOX_PAD = 0.45  # the share of a box plot's row left between its boxes, so a box is about half as thick as its row
DENSITY_POINTS = 100  # the points a density curve is drawn through at least, and at most DENSITY_POINTS_MAX, enough
DENSITY_POINTS_MAX = 400  # that the narrowest curve has a point every half of its smoothing width
DENSITY_ROWS = CHART_ROWS_MAX  # a density chart's rows at most while each curve can keep DENSITY_POINTS
DENSITY_BINS = 2048  # the values of a group of more than DENSITY_EXACT are counted in this many bins before smoothing
DENSITY_EXACT = 20000
RIDGE_FROM = 5  # a density chart of this many groups draws them one over another, each on its own baseline
RIDGE_RISE = 1.5  # how many baselines the highest ridge rises
RIDGE_BASE, RIDGE_TOP = "__thimble_base", "__thimble_top"  # a ridge's baseline and its curve, in baselines from the bottom
VIOLIN_LOW = "__thimble_low"  # a violin's lower edge, as RIDGE_TOP is its upper edge and RIDGE_BASE its line
VIOLIN_MOST = "__thimble_most"  # the largest density of a violin's curve, which its widest point is scaled to
ECDF_STEPS_MAX = 500  # a group's cumulative share is kept at this many of its values at most, evenly spread
RANGE_PAD = 8  # px a range's axis reaches past its outermost ends, so their marks clear the axis line
RANGE_END = "__thimble_end"  # a range's end, as its before or after column's name
RANGE_GAP = 4  # px the line between a range's ends stops short of each, about the radius of an end's dot (the theme's
# thimble-end), so a lighter end shows no line through it
VIOLIN_HALF = 0.45  # a violin's widest point reaches this far either side of its line, in lines, so neighbors never touch
TIME_TICKS_MAX = 40  # times more than a day apart (weeks, months) of a bar, line or area get a tick each up to this many
FITS = ("linear", "smooth")  # the trend lines a scatter fits: least squares, or a local regression (LOESS)
SMOOTH_SPAN = 0.75  # the share of the points each point of a smooth fit is fitted to (R's loess and ggplot's default)
SMOOTH_AT = 200  # a smooth fit is computed at this many x values at most and read between them
# dots on one line that would overlap move across it, each only as far as it needs (a dots chart's, a box plot's): two
# dots overlap when their x lie closer than DODGE_GAP of the x axis's span (a dot's width on a card's plot); a dot that
# overlaps one already placed moves DODGE_PX up, else down, then twice that, up to DODGE_MAX steps either way; its x
# stays where it is
DODGE_GAP = 0.0125
DODGE_PX = 3.5
DODGE_MAX = 2
DODGE_ROW, DODGE_FIELD = "__thimble_row", "__thimble_dodge"  # a row's number, and its dot's steps across its line
# the marks a chart names by their job, which the theme draws (frontend lib/vizTheme vegaConfig's `style`): a band
# faint behind its line (a line's interval); a box plot's boxes and a violin's body lighter than their color, their
# medians in ink; areas overlapping lightly; a scatter's fitted line in ink; the line between a range's two ends muted,
# and the ends larger than a dot; an area's points unseen, wider than a dot so a hover finds them
FAINT_STYLE, BOX_STYLE, MEDIAN_STYLE, OVERLAP_STYLE = "thimble-faint", "thimble-box", "thimble-median", "thimble-overlap"
FIT_STYLE, SPAN_STYLE, END_STYLE, HOVER_STYLE = "thimble-fit", "thimble-span", "thimble-end", "thimble-hover"
# each kind's columns in order, how many of them it needs, and its options
CHARTS = {
    "bar": (("category", "value", "group"), 2, ("sort", "stack", "label", "marks", "interval", "panels")),
    "line": (("x", "y", "series"), 2, ("label", "marks", "interval", "panels")),
    "area": (("x", "y", "series"), 2, ("stack", "label", "marks", "panels")),
    "scatter": (("x", "y", "group"), 2, ("label", "marks", "fit", "panels")),
    "dots": (("x", "row", "group"), 2, ("sort", "label", "marks", "interval", "panels")),
    "box": (("value", "group"), 2, ("sort", "label")),
    "histogram": (("value", "group"), 1, ("step", "label", "marks", "panels")),
    "density": (("value", "group"), 1, ("bandwidth", "sort", "label", "marks", "panels")),
    "violin": (("value", "group"), 2, ("bandwidth", "sort", "label")),
    "ecdf": (("value", "group"), 1, ("label", "marks")),
    "range": (("item", "before", "after", "group"), 3, ("sort", "label", "marks")),
    "heatmap": (("x", "y", "value"), 3, ("log",)),
}
_VALUES = ("histogram", "density", "ecdf")  # the kinds that take any number of values, and a Series as its values alone
_GROUPED = ("box", "violin")  # the kinds that take a Series as its values grouped by its index, when that is named
_DEFAULT = object()  # an option left out
# the workspace folder whose labels a chart's `label` names, while chart_spec draws for a caller other than a card
# (views.chart_answer); None in a kernel, which reads its own workspace's and notes the label as read
_CHART_WS: contextvars.ContextVar = contextvars.ContextVar("thimble_chart_ws", default=None)
# text a chart reads as times: an ISO date, a month ("2025-04") or a date and time, with or without its zone
_ISO_TIME = re.compile(r"^\d{4}-\d{2}(-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?)?$")


def _shape(kind: str) -> str:
    """A kind's columns as its errors name them: "(x, y) or (x, y, series)"."""
    cols, need, _opts = CHARTS[kind]
    return " or ".join("(" + ", ".join(cols[:n]) + ")" for n in range(need, len(cols) + 1))


def chart(kind, data, *, show=True, **options):
    """Show a common chart of `data`, a DataFrame whose columns come in the kind's order and are named as the axes and
    the legend read; a Series is its index, then its values (a histogram's, a density's and an ecdf's, its values; a box
    plot's and a violin's, its values, then its index when that is named). Returns nothing, so the card shows the chart
    once; with show=False it shows nothing and returns the chart as an Altair chart, for the card's code to add layers
    of its own marks to (`theme` names the theme's colors for them).

        bar        (category, value[, group])        sort, stack, label, marks, interval, panels
        line       (x, y[, series])                  label, marks, interval, panels
        area       (x, y[, series])                  stack, label, marks, panels
        scatter    (x, y[, group])                   label, marks, fit, panels
        dots       (x, row[, group])                 sort, label, marks, interval, panels
        box        (value, group)                    sort, label
        histogram  (value[, group])                  step, label, marks, panels
        density    (value[, group])                  bandwidth, sort, label, marks, panels
        violin     (value, group)                    bandwidth, sort, label
        ecdf       (value[, group])                  label, marks
        range      (item, before, after[, group])    sort, label, marks
        heatmap    (x, y, value)                     log

    A value or y is a number; a line's, an area's, a scatter's and a dots chart's x is numbers or times, as are a range's
    before and after.
    sort      a list of the categories (bar), rows (dots), groups (box, density, violin) or items (range) in order, or
              None for the frame's order; by default the largest first (bar), the earliest first (dots), the largest
              median first (box, density, violin), the largest after first, or with times the earliest before (range),
              a label's values in the label's order (bar, dots, range)
    stack     with a group or series: True stacks them (the default), False sets bars side by side and overlaps areas
              lightly, "share" stacks each category or x to 100%
    label     a label's name: the group or series column, else the category, row or item column, holds its values,
              drawn in its colors and, but in a box plot, a density and a violin, its order
    marks     {text: x}: a line across the chart at each x, with its text
    interval  (lo, hi): the names of two more columns of the frame, the low and high ends of an interval around each
              value or x, such as a Wilson interval's, drawn as a line in ink; a bar chart's groups go side by side; a
              line's are error bars under its dots in its series' colors, or a faint band along a line too long for dots
    panels    True draws each group or series in a panel of its own, one under another, the panels sharing their scales
              but a line chart's, whose panels each have their own y scale
    fit       "linear" or "smooth": a scatter's trend line for each group, fitted by least squares or by a local
              regression (LOESS), its fitted values a column of the chart's rows
    step      the width of a histogram's bins; by default a round width that makes at most 20
    bandwidth the width of a density's or a violin's smoothing, in the value's units; by default each group's own
              (Silverman's rule)
    log       True colors a heatmap's values on a log scale"""
    if show is not True and show is not False:
        raise ValueError(f"thimble.chart({kind!r}): `show` is True, which shows the chart, or False, which returns it as "
                         f"an Altair chart; not {show!r}")
    spec, n = chart_spec(kind, data, options)
    if not show:
        return _altair({k: v for k, v in spec.items() if k != "$schema"})
    _show({VEGALITE_MIME: spec, "text/plain": f"thimble.chart({kind!r}): {n:,} rows"})


def chart_spec(kind, data, options: dict, ws=None) -> tuple:
    """thimble.chart's spec without showing it: (the Vega-Lite spec, the rows the chart draws), `data` and `options`
    checked as chart() checks them, with the same errors. A card's chart shows the spec; the view kit's thimble.chart
    (viewer_chart.js) asks thimble for the same spec (views.chart_answer), so a view's chart and a card's take the same
    kinds, data and options from this one code. `ws` is the workspace folder whose labels `label` names, for a chart
    drawn outside a kernel, which notes no label as read; the kernel's own by default."""
    if not isinstance(kind, str) or kind not in CHARTS:
        raise ValueError(f"thimble.chart: no chart kind {kind!r}; the kinds are "
                         + "; ".join(f"{k} {_shape(k)}" for k in CHARTS))
    allowed = CHARTS[kind][2]
    for name in options:
        if name not in allowed:
            raise TypeError(f"thimble.chart({kind!r}) takes the options {', '.join(allowed)}, not {name!r}")
    iv = options.get("interval")
    if iv is not None:
        if isinstance(iv, (str, bytes, dict)) or not hasattr(iv, "__iter__") or len(iv := tuple(iv)) != 2 \
                or not all(isinstance(c, str) for c in iv) or iv[0] == iv[1]:
            raise ValueError(f"thimble.chart({kind!r}): `interval` is the names of the two columns that hold each value's "
                             f"low and high ends, such as (\"lo\", \"hi\"), not {options['interval']!r}")
        options = {**options, "interval": iv}
    df = _chart_frame(kind, data, iv or ())
    at = _CHART_WS.set(None if ws is None else str(ws))
    try:
        spec = _CHART_SPECS[kind](df, options)
    finally:
        _CHART_WS.reset(at)
    return {"$schema": VEGALITE_SCHEMA, **spec}, len(df)


def _altair(spec: dict):
    """The chart as an Altair chart (a Chart, a LayerChart or a FacetChart) that draws as the spec does. Its rows go round
    Altair's from_dict, which would make an object of every row (seconds for a few thousand): each inline `values` is
    held out under a name while the rest is read, then put back. No $schema, which Altair writes when it shows the chart
    and refuses in a layer. The chart's own rows keep a name of CHART_ROWS_NAME's (Altair leaves named rows inline), by
    which they stay the table a takeaway cites wherever the chart stands among the code's layers (cite._main_part)."""
    import altair as alt

    own = spec["data"]["values"]
    named = f"{CHART_ROWS_NAME}{zlib.crc32(json.dumps(own).encode()):08x}"
    held: list = []

    def out(node):
        if isinstance(node, dict):
            if set(node) == {"values"} and isinstance(node["values"], list):
                held.append(node["values"])
                return {"name": f"{_HELD}{len(held) - 1}"}
            return {k: out(v) for k, v in node.items()}
        return [out(v) for v in node] if isinstance(node, list) else node

    def back(obj):
        if isinstance(obj, list):
            for v in obj:
                back(v)
        elif isinstance(obj, alt.SchemaBase):
            for k, v in list(obj._kwds.items()):
                name = v.name if isinstance(v, alt.NamedData) else None
                if isinstance(name, str) and name.startswith(_HELD):
                    rows = held[int(name[len(_HELD):])]
                    setattr(obj, k, alt.InlineData(values=rows, name=named) if rows is own else alt.InlineData(values=rows))
                else:
                    back(v)

    chart = alt.Chart.from_dict(out(spec))
    back(chart)
    return chart


_HELD = "__thimble_rows_"  # the name a chart's rows go by while Altair reads the rest of it (_altair)
CHART_ROWS_NAME = "thimble-chart-"  # the start of the name of a returned chart's own rows, then a checksum of them


def _chart_frame(kind: str, data, extra=()):
    """`data` as a DataFrame of named columns: a Series as its index and its values (a histogram's, a density's and an
    ecdf's as its values, a box plot's and a violin's as its values and then its index when that is named), a named
    index as the first columns; the columns that `extra` names (an interval's) after the kind's own. ValueError naming
    the kind's columns when their number is wrong."""
    import pandas as pd

    if isinstance(data, pd.Series):
        data = data.to_frame(name="value" if data.name is None else data.name)
        if kind in _GROUPED:  # its values, then its index as the groups when it is named
            named = any(n is not None for n in data.index.names)
            data = data.reset_index() if named else data.reset_index(drop=True)
            data = data[[data.columns[-1], *data.columns[:-1]]]
        else:
            data = data.reset_index(drop=True) if kind in _VALUES else data.reset_index()
    elif isinstance(data, pd.DataFrame):
        if any(n is not None for n in data.index.names):
            data = data.reset_index()
    else:
        raise TypeError(f"thimble.chart({kind!r}) takes a DataFrame of {_shape(kind)} columns, not {type(data).__name__}")
    names = [" / ".join(str(p) for p in c if str(p)) if isinstance(c, tuple) else str(c) for c in data.columns]
    got = ", ".join(names) or "none"
    cols, need, _opts = CHARTS[kind]
    for name in extra:
        if name not in names:
            raise ValueError(f"thimble.chart({kind!r}): `interval` names `{name}`, which the frame lacks; its columns are {got}")
    own = [n for n in names if n not in extra]
    if not need <= len(own) <= len(cols):
        besides = f", beside the interval's {' and '.join(extra)}" if extra else ""
        raise ValueError(f"thimble.chart({kind!r}) takes {_shape(kind)} columns, in that order{besides}; got {len(own)}: "
                         + (", ".join(own) or "none"))
    if len(set(names)) < len(names):
        raise ValueError(f"thimble.chart({kind!r}): each column needs a name of its own; got {got}")
    if len(data) > CHART_ROWS_MAX and kind not in _VALUES and kind != "violin":
        raise ValueError(f"thimble.chart({kind!r}): {len(data):,} rows, and a chart draws {CHART_ROWS_MAX:,} at most; count "
                         "or bin them first")
    data = data.copy()
    data.columns = names
    return data[own + list(extra)] if extra else data


def _col_kind(s) -> str:
    """A column as a chart reads it: "number", "time" (times, dates, or text that is all ISO dates), "duration" or
    "text"."""
    from pandas.api import types as pt

    if pt.is_timedelta64_dtype(s.dtype):
        return "duration"
    t = _type_of(s)
    if t == "quantitative":
        return "number"
    if t == "temporal":
        return "time"
    vals = s.dropna()
    return "time" if len(vals) and all(isinstance(v, str) and _ISO_TIME.match(v) for v in vals) else "text"


def _chart_kinds(kind: str, df, number=(), axis=()) -> dict:
    """{column: its kind (_col_kind)}; ValueError naming the kind's columns when a column that must hold numbers (the
    places in `number`), or numbers or times (the places in `axis`), holds something else."""
    cols = list(df.columns)
    kinds = {c: _col_kind(df[c]) for c in cols}
    names = CHARTS[kind][0]
    for i in [*number, *axis]:
        if i < len(cols) and kinds[cols[i]] not in (("number",) if i in number else ("number", "time")):
            want = "numbers" if i in number else "numbers or times"
            got = {"time": "times", "duration": "durations"}.get(kinds[cols[i]], kinds[cols[i]])
            hint = (", which .dt.total_seconds() gives as numbers" if got == "durations"
                    else '; draw categories with "bar"' if i in axis and kind != "bar" else "")
            raise ValueError(f"thimble.chart({kind!r}) takes {_shape(kind)} columns, the {names[i]} {want}; `{cols[i]}` "
                             f"holds {got}{hint}")
    return kinds


def _times(s):
    """A column of times as timestamps without a zone, each at its own zone's clock time (a column of mixed zones at
    UTC's): Vega-Lite reads a time without a zone as the clock shows it, and one with a zone in the reader's zone."""
    import pandas as pd

    if not pd.api.types.is_datetime64_any_dtype(s.dtype):
        fmt = {"format": "ISO8601"} if all(isinstance(v, str) for v in s.dropna()) else {}
        try:
            s = pd.to_datetime(s, **fmt)
        except (ValueError, TypeError):
            s = pd.to_datetime(s, utc=True, **fmt)
    if getattr(s.dt, "tz", None) is not None:
        s = s.dt.tz_localize(None)
    return s


def _time_format(ts) -> str:
    """The d3 format that shows a column of times whole: the date, with the minute or the second when any has one."""
    vals = ts.dropna()
    if ((vals.dt.second != 0) | (vals.dt.microsecond != 0)).any():
        return "%Y-%m-%d %H:%M:%S"
    return "%Y-%m-%d %H:%M" if ((vals.dt.hour != 0) | (vals.dt.minute != 0)).any() else "%Y-%m-%d"


def _time_label_format(ts) -> str:
    """The d3 format an axis names a column of times in, as a date axis's labels read (frontend chartDefaults
    timeFormat): the month and day, the year too when the times span more than one, and the clock when _time_format
    shows one."""
    day = "%b %-d" if ts.dropna().dt.year.nunique() <= 1 else "%b %-d, %Y"
    return day + _time_format(ts)[len("%Y-%m-%d"):]


def _datetime(t) -> dict:
    """A time as a Vega-Lite DateTime, which Vega-Lite reads at the reader's clock, as it reads a row's time without a
    zone."""
    d = {"year": t.year, "month": t.month, "date": t.day}
    d.update({k: v for k, v in (("hours", t.hour), ("minutes", t.minute), ("seconds", t.second)) if v})
    return d


def _step_ticks(ts) -> dict:
    """The axis options of a bar's, a line's or an area's times when they lie more than a day apart, such as weeks or
    months: a tick at each, which the axis names, up to TIME_TICKS_MAX of them, in place of the ticks Vega spaces by
    their count, which name days between the times ({} otherwise)."""
    import pandas as pd

    times = ts.dropna().drop_duplicates().sort_values()
    steps = times.diff().dropna()
    if not len(steps) or steps.min() <= pd.Timedelta(days=1) or len(times) > TIME_TICKS_MAX:
        return {}
    return {"axis": {"values": [_datetime(t) for t in times]}}


def _json_value(v):
    """A value as a chart's row holds it: a number, a bool, text, a time in ISO form, None for a missing one."""
    if _missing(v):
        return None
    if isinstance(v, bool) or type(v).__name__ == "bool_":
        return bool(v)
    if isinstance(v, numbers.Integral):
        return int(v)
    if isinstance(v, numbers.Real):
        f = float(v)
        return f if math.isfinite(f) else None
    return _text(v)


def _chart_rows(df, kinds: dict) -> list:
    """The frame's rows as a chart's inline data, its time columns as times (_times)."""
    cols = {c: (_times(df[c]) if kinds[c] == "time" else df[c]).tolist() for c in df.columns}
    return [dict(zip(cols, vals)) for vals in zip(*[[_json_value(v) for v in vs] for vs in cols.values()])]


def _distinct(values) -> list:
    """The values as a chart's rows hold them, each once, in their first order, none missing."""
    out, seen = [], set()
    for v in values:
        j = _json_value(v)
        key = json.dumps(j)
        if j is not None and key not in seen:
            seen.add(key)
            out.append(j)
    return out


def _ranked(s, by, earliest=False) -> list:
    """The values of `s` by the rows' `by`: the largest absolute sum first, or with `earliest` the least first; ties,
    and values with no `by`, in the frame's order."""
    key: dict = {}
    for v, w in zip(s.tolist(), by.tolist()):
        j, w = _json_value(v), None if _missing(w) else w
        if j is not None and w is not None:
            k = json.dumps(j)
            key[k] = (min(key[k], w) if k in key else w) if earliest else key.get(k, 0) - abs(float(w))
    vals = _distinct(s.tolist())
    return sorted([v for v in vals if json.dumps(v) in key], key=lambda v: key[json.dumps(v)]) \
        + [v for v in vals if json.dumps(v) not in key]


def _ordered(kind: str, s, default: list, sort=_DEFAULT, label=None, what="categories") -> list:
    """The values of `s` in the order the chart shows them: the frame's with `sort` None; else `default`, after a
    label's values in the label's order or a categorical column's categories, with `sort`'s list first."""
    vals = _distinct(s.tolist())
    if sort is None:
        return vals
    base = list(default)
    head = [v for v in label if v in vals] if label is not None else \
        [v for v in _distinct(s.cat.categories) if v in vals] if hasattr(s, "cat") else []
    if sort is not _DEFAULT:
        if isinstance(sort, (str, bytes, dict)) or not hasattr(sort, "__iter__"):
            raise ValueError(f"thimble.chart({kind!r}): `sort` is a list of the {what} in order, or None for the "
                             f"frame's order, not {sort!r}")
        head = [v for v in _distinct(sort) if v in vals]
    return head + [v for v in base if v not in head]


def _label_values(kind: str, name, s, col: str) -> list:
    """The values of the label `name` in its order, once column `col` is seen to hold some of them; in a kernel the card
    notes the label as read, which draws those values in the label's colors (outside one, chart_spec's `ws` names the
    workspace, and the caller colors them)."""
    if not isinstance(name, str):
        raise TypeError(f"thimble.chart({kind!r}): `label` is a label's name, not {name!r}")
    ws = _CHART_WS.get()
    k = _find(name, ws)
    values = [v for v, _c in k["classes"]]
    if not {str(v) for v in s.dropna().tolist()} & set(values):
        raise ValueError(f"thimble.chart({kind!r}): the column `{col}` holds none of the label {k['name']!r}'s values, "
                         + ", ".join(map(repr, values)))
    if ws is None and all(x["id"] != k["id"] for x in _LABELS_READ):
        _LABELS_READ.append({"id": k["id"], "rev": k["rev"]})
    return values


def _field(name: str) -> str:
    """A column's name as a Vega-Lite field, whose dots and brackets would otherwise read as a path into the row."""
    return re.sub(r"([\\.\[\]])", r"\\\1", name)


def _enc(name: str, type_: str, **more) -> dict:
    return {"field": _field(name), "type": type_, "title": name, **more}


def _free(name: str, taken) -> str:
    """`name`, or `name (2)` and on, whichever no column of `taken` has."""
    n, out = 1, name
    while out in taken:
        n += 1
        out = f"{name} ({n})"
    return out


def _tooltip(df, kinds: dict) -> list:
    """Every column of the chart's rows, in the hover tip: times whole (_time_format)."""
    out = []
    for c in df.columns:
        t = {"number": "quantitative", "time": "temporal"}.get(kinds[c], "nominal")
        tip = {"field": _field(c), "type": t, "title": c}
        if t == "temporal":
            tip["format"] = _time_format(_times(df[c]))
        out.append(tip)
    return out


def _unit(rows: list, mark, enc: dict, **more) -> dict:
    return {"data": {"values": rows}, "mark": mark, "encoding": enc, **more}


def _with_marks(kind: str, spec: dict, marks, x: str, xkind: str) -> dict:
    """The chart as a layer under a rule across it at each of `marks`' x values ({text: x}), the text at the rule's top."""
    import pandas as pd

    if not isinstance(marks, dict) or not marks:
        raise ValueError(f"thimble.chart({kind!r}): `marks` is a dict of {{text: x}}, not {marks!r}")
    if xkind not in ("time", "number"):
        raise ValueError(f"thimble.chart({kind!r}): `marks` need an x axis of times or numbers; `{x}` holds text")
    at = pd.Series(list(marks.values()), dtype=object)
    if xkind == "time":
        try:
            at = _times(at)
        except (ValueError, TypeError):
            raise ValueError(f"thimble.chart({kind!r}): `marks` are at times, as `{x}` holds; got "
                             f"{list(marks.values())!r}") from None
    elif not all(isinstance(v, numbers.Real) and not isinstance(v, bool) for v in at):
        raise ValueError(f"thimble.chart({kind!r}): `marks` are at numbers, as `{x}` holds; got {list(marks.values())!r}")
    text = _free("mark", [x])
    rows = [{x: _json_value(v), text: str(t)} for t, v in zip(marks, at.tolist())]
    xenc = _enc(x, "temporal" if xkind == "time" else "quantitative")
    data = spec.pop("data")
    return {"data": data, "layer": [
        spec,
        {"data": {"values": rows}, "mark": "rule", "encoding": {"x": xenc}},
        {"data": {"values": rows}, "mark": {"type": "text", "align": "left", "baseline": "top", "dx": 4, "dy": 4},
         "encoding": {"x": xenc, "y": {"value": 0}, "text": {"field": _field(text), "type": "nominal"}}},
    ]}


def _check_interval(kind: str, df, interval: tuple, val: str, at: str) -> None:
    """ValueError when the interval's columns do not hold each value's low and high ends: numbers, the low at most the
    high, and not every value outside them (they would be widths, not ends)."""
    lo, hi = interval
    for c in interval:
        k = _col_kind(df[c])
        if k != "number":
            got = {"time": "times", "duration": "durations"}.get(k, k)
            raise ValueError(f"thimble.chart({kind!r}): `interval` names the columns of each value's low and high ends, "
                             f"numbers; `{c}` holds {got}")
    inside = outside = 0
    for a, v, low, high in zip(df[at].tolist(), df[val].tolist(), df[lo].tolist(), df[hi].tolist()):
        if _missing(low) or _missing(high):
            continue
        if low > high:
            raise ValueError(f"thimble.chart({kind!r}): `interval` is (low, high), and `{lo}` is above `{hi}` where "
                             f"`{at}` is {_json_value(a)!r}")
        if not _missing(v):
            inside, outside = (inside + 1, outside) if low <= v <= high else (inside, outside + 1)
    if outside and not inside:
        raise ValueError(f"thimble.chart({kind!r}): every `{val}` lies outside its interval; `{lo}` and `{hi}` are the "
                         "interval's low and high ends, such as a Wilson interval's, not its widths")


def _with_interval(spec: dict, interval: tuple, title: str, ch: str, enc: dict, offset=None, mark="rule",
                   colored=False, under=False) -> dict:
    """The chart as a layer with a mark from each row's low end to its high end along channel `ch`, at its place on the
    other channel (and `offset`'s), over the chart or `under` it: a rule, which the theme draws in ink, or another mark
    (a line's band); in the chart's color when `colored` and the chart has one."""
    lo, hi = interval
    other = "y" if ch == "x" else "x"
    rule = {ch: _enc(lo, "quantitative", title=title), f"{ch}2": {"field": _field(hi)}, other: enc[other]}
    if offset:
        rule[offset] = enc[offset]
    if colored and "color" in enc:
        rule["color"] = enc["color"]
    rule["tooltip"] = enc["tooltip"]
    data = spec.pop("data")
    ends = {"mark": mark, "encoding": rule}
    return {"data": data, "layer": [ends, spec] if under else [spec, ends]}


def _dodge(xs: list, lines: list, span=None) -> list:
    """Each dot's steps across its line (DODGE_PX each, 0 on it), so the dots of a line (`lines`, a key per dot) that
    would overlap stand apart and the rest stay on it: earliest first, a dot takes the first of 0, -1, 1, -2, 2 ... up
    to DODGE_MAX whose last dot lies more than DODGE_GAP of the axis's span (`span`, else that of `xs`) behind it, else
    the one whose last dot lies farthest behind. `xs` are numbers, None for a dot that is not drawn."""
    known = [x for x in xs if x is not None]
    out = [0] * len(xs)
    if not known:
        return out
    gap = DODGE_GAP * (max(known) - min(known) if span is None else span)
    steps = [0, *[s for k in range(1, DODGE_MAX + 1) for s in (-k, k)]]
    last: dict = {}
    for i in sorted((i for i, x in enumerate(xs) if x is not None), key=lambda i: xs[i]):
        x, line = xs[i], lines[i]
        free = [s for s in steps if (line, s) not in last or x - last[(line, s)] > gap]
        step = free[0] if free else min(steps, key=lambda s: last[(line, s)])
        last[(line, step)] = x
        out[i] = step
    return out


def _dodge_x(s, kind: str) -> list:
    """A column's values (`kind` "time" or "number") as _dodge places them: numbers, or times as seconds; None for a
    missing one."""
    at = _times(s) if kind == "time" else s
    return [None if _missing(v) else (v.value / 1e9 if kind == "time" else float(v)) for v in at.tolist()]


def _dodged(levels: list) -> list:
    """The transforms that give each of a layer's rows its dot's steps across its line (`levels`, by row; _dodge) as
    DODGE_FIELD, which DODGE_OFFSET reads: the rows numbered, and the steps of the moved ones looked up by number, 0 for
    the rest; [] when no dot moves. The steps are the chart's layout, not its rows'."""
    moved = [{"r": i + 1, "d": s} for i, s in enumerate(levels) if s]
    if not moved:
        return []
    return [{"window": [{"op": "row_number", "as": DODGE_ROW}]},
            {"lookup": DODGE_ROW, "from": {"data": {"values": moved}, "key": "r", "fields": ["d"]}, "as": [DODGE_FIELD],
             "default": 0}]


# a dot's place across its line, DODGE_PX a step (a mark's yOffset, read per row; _dodged)
DODGE_OFFSET = {"expr": f"datum[{json.dumps(DODGE_FIELD)}] * {DODGE_PX}"}


def _panels_on(kind: str, opts: dict, grp) -> bool:
    """Whether the chart draws its groups in panels (`panels` True), which needs the kind's group or series column."""
    panels = opts.get("panels", False)
    if (panels is not True and panels is not False) or (panels and grp is None):
        raise ValueError(f"thimble.chart({kind!r}): `panels` is True or False and needs a {CHARTS[kind][0][-1]} column")
    if panels and "stack" in opts:
        raise ValueError(f"thimble.chart({kind!r}): `panels` put each {CHARTS[kind][0][-1]} in a panel of its own; leave "
                         "out `stack`")
    return panels


def _with_panels(spec: dict, grp: str, groups: list, own_y: bool = False) -> dict:
    """The chart with each group in a panel of its own, one under another: a single mark's own row channel, else the
    layers inside a facet by rows, where a layer of rows of its own (a mark across the chart) repeats in every panel. The
    panels share their scales, or with `own_y` each has its own y scale."""
    row = {"field": _field(grp), "type": "nominal", "sort": groups, "title": None}
    resolve = {"resolve": {"scale": {"y": "independent"}}} if own_y else {}
    if "layer" not in spec:
        spec["encoding"]["row"] = row
        return {**spec, **resolve}
    data = spec.pop("data")
    return {"data": data, "facet": {"row": row}, "spec": spec, **resolve}


def _bar_spec(df, opts: dict) -> dict:
    kind = "bar"
    iv = opts.get("interval")
    cols = [c for c in df.columns if c not in (iv or ())]
    cat, val, grp = cols[0], cols[1], cols[2] if len(cols) > 2 else None
    kinds = _chart_kinds(kind, df, number=(1,))
    panels = _panels_on(kind, opts, grp)
    stack = opts.get("stack", not iv and not panels)
    if not (stack is True or stack is False or stack == "share"):
        raise ValueError(f"thimble.chart({kind!r}): `stack` is True, False or \"share\", not {stack!r}")
    if "stack" in opts and grp is None:
        raise ValueError(f"thimble.chart({kind!r}): `stack` stacks the groups of a third column, which this frame lacks")
    label = _label_values(kind, opts["label"], df[grp or cat], grp or cat) if opts.get("label") is not None else None
    ck = kinds[cat]
    if iv:
        if ck == "time":
            raise ValueError(f"thimble.chart({kind!r}): `interval` draws around bars of text or number categories; "
                             f"`{cat}` holds times")
        if grp and stack is not False:
            raise ValueError(f"thimble.chart({kind!r}): `interval` sets the groups side by side; leave out `stack`")
        _check_interval(kind, df, iv, val, cat)
    if ck == "time" and "sort" in opts:
        raise ValueError(f"thimble.chart({kind!r}): `sort` orders text or number categories; times keep their order")
    if ck == "time" and stack is False and not panels:
        raise ValueError(f"thimble.chart({kind!r}): stack=False sets groups side by side over text or number "
                         "categories; draw groups over time with \"line\"")
    if opts.get("marks") is not None and ck != "time":
        raise ValueError(f"thimble.chart({kind!r}): `marks` need categories that are times; `{cat}` holds {ck}")
    rows = _chart_rows(df, kinds)
    sort = opts.get("sort", _DEFAULT)
    enc: dict = {}
    order = None
    if ck == "text":
        order = _ordered(kind, df[cat], _ranked(df[cat], df[val]), sort, None if grp else label)
        enc["y"] = _enc(cat, "nominal", sort=order)
        enc["x"] = _enc(val, "quantitative")
        value, offset = "x", "yOffset"
    elif ck == "number":
        order = _ordered(kind, df[cat], sorted(_distinct(df[cat].tolist())), sort, None if grp else label)
        enc["x"] = _enc(cat, "ordinal", sort=order)
        enc["y"] = _enc(val, "quantitative")
        value, offset = "y", "xOffset"
    else:  # times: each bar spans its time to the next, the least step between two of them, else a day
        import pandas as pd

        ts = _times(df[cat])
        steps = ts.dropna().drop_duplicates().sort_values().diff().dropna()
        step = steps.min() if len(steps) else pd.Timedelta(days=1)
        end = _free(f"{cat} end", cols)
        for r, t in zip(rows, ts.tolist()):
            r[end] = None if _missing(t) else _json_value(t + step)
        enc["x"] = _enc(cat, "temporal", **_step_ticks(ts))  # bars of a week each named by the day it starts
        enc["x2"] = {"field": _field(end)}
        enc["y"] = _enc(val, "quantitative")
        value, offset = "y", None
    # a bar over times is told it stands upright, since Vega-Lite takes a bar from x to x2 for one lying down
    mark = {"type": "bar", "orient": "vertical"} if ck == "time" else "bar"
    more: dict = {}
    if grp:
        if stack == "share":
            enc[value] = {**enc[value], "stack": "normalize", "axis": {"format": "%"}}
        groups = _ordered(kind, df[grp], _ranked(df[grp], df[val]), label=label)
        enc["color"] = _enc(grp, "nominal", sort=groups)
        if panels:
            pass
        elif stack is False:
            enc[offset] = {"field": _field(grp), "type": "nominal", "sort": groups}
        else:
            # Vega-Lite stacks a bar's segments by the group's name; this stacks them in the legend's order
            more["transform"] = [{"calculate": f"indexof({json.dumps(groups)}, datum[{json.dumps(grp)}])", "as": STACK_FIELD}]
            enc["order"] = {"field": STACK_FIELD, "type": "quantitative"}
    elif label is not None:
        enc["color"] = _enc(cat, "nominal", sort=order, legend=None)
    enc["tooltip"] = _tooltip(df, kinds)
    spec = _unit(rows, mark, enc, **more)
    if iv:
        spec = _with_interval(spec, iv, val, value, enc, offset if grp and not panels else None)
    if opts.get("marks") is not None:
        spec = _with_marks(kind, spec, opts["marks"], cat, ck)
    return _with_panels(spec, grp, groups) if panels else spec


def _xy_spec(kind: str, df, opts: dict) -> dict:
    """A line, a scatter or a dots chart: x numbers or times; y numbers, or a dots chart's rows; a third column's groups
    in color. A line's interval is an error bar at each of its dots, or a faint band along a line too long for dots; a
    dots chart's, a rule through each dot. A dots chart's dots that would overlap on their row's line move across it
    (_dodge), unless its groups stand side by side on the line."""
    iv = opts.get("interval")
    cols = [c for c in df.columns if c not in (iv or ())]
    x, y, grp = cols[0], cols[1], cols[2] if len(cols) > 2 else None
    kinds = _chart_kinds(kind, df, number=() if kind == "dots" else (1,), axis=(0,))
    if iv and kind == "line":
        _check_interval(kind, df, iv, y, x)
    elif iv:
        if kinds[x] != "number":
            raise ValueError(f"thimble.chart({kind!r}): `interval` draws around an x of numbers; `{x}` holds times")
        _check_interval(kind, df, iv, x, y)
    on = grp or (y if kind == "dots" else None)  # the column a label colors
    if opts.get("label") is not None and on is None:
        raise ValueError(f"thimble.chart({kind!r}): `label` colors the {CHARTS[kind][0][2]} column, which this frame lacks")
    label = _label_values(kind, opts["label"], df[on], on) if opts.get("label") is not None else None
    panels = _panels_on(kind, opts, grp)
    fit = opts.get("fit")
    if fit is not None and fit not in FITS:
        raise ValueError(f"thimble.chart({kind!r}): `fit` is \"linear\" or \"smooth\", not {fit!r}")
    rows = _chart_rows(df, kinds)
    at = _times(df[x]) if kinds[x] == "time" else df[x]
    ticks = _step_ticks(at) if kind == "line" and kinds[x] == "time" else {}
    enc: dict = {"x": _enc(x, "temporal" if kinds[x] == "time" else "quantitative", **ticks)}
    if kind == "dots":
        order = _ordered(kind, df[y], _ranked(df[y], at, earliest=True), opts.get("sort", _DEFAULT), None if grp else label, "rows")
        enc["y"] = _enc(y, "nominal", sort=order)
    else:
        enc["y"] = _enc(y, "quantitative")
    more: dict = {}
    if grp:
        weights = df[y] if kind == "line" else df[grp].map(lambda _v: 1)
        groups = _ordered(kind, df[grp], _ranked(df[grp], weights), label=label)
        enc["color"] = _enc(grp, "nominal", sort=groups)
        if kind == "dots" and not panels:  # each row's groups side by side on its line, so no dot covers another's
            enc["yOffset"] = {"field": _field(grp), "type": "nominal", "sort": groups}
    elif label is not None:
        enc["color"] = _enc(y, "nominal", sort=enc["y"]["sort"], legend=None)
    enc["tooltip"] = _tooltip(df, kinds)
    dodge: list = []
    if kind == "line":
        longest = int(df.groupby(grp, sort=False).size().max()) if grp and len(df) else len(df)
        mark = {"type": "line", "point": True} if longest <= LINE_DOTS_MAX else "line"
    else:
        mark = "point"
        if kind == "dots" and "yOffset" not in enc:  # each row's line, or in panels each group's on it
            lines = [json.dumps([_json_value(a), _json_value(b)]) for a, b in
                     zip(df[y].tolist(), df[grp].tolist() if grp else [None] * len(df))]
            dodge = _dodged(_dodge(_dodge_x(df[x], kinds[x]), lines))
            if dodge:
                mark = {"type": "point", "yOffset": DODGE_OFFSET}
    if fit:
        line = _fit_column(kind, fit, df, x, y, grp, kinds[x], rows)
        enc["tooltip"] = [*enc["tooltip"], {"field": _field(line), "type": "quantitative", "title": line}]
        fitted = {"x": enc["x"], "y": _enc(line, "quantitative", title=y), **({"color": enc["color"]} if "color" in enc else {}),
                  "tooltip": enc["tooltip"]}
        spec = {"data": {"values": rows}, "layer": [{"mark": mark, "encoding": enc},
                                                    {"mark": {"type": "line", "style": FIT_STYLE}, "encoding": fitted}]}
    else:
        spec = _unit(rows, mark, enc, **more)
    if iv and kind == "line":
        # under the line: an error bar at each dot, or a band along a line too long for dots; a series' in its color
        ends = "rule" if mark != "line" else {"type": "area", "style": FAINT_STYLE}
        spec = _with_interval(spec, iv, y, "y", enc, mark=ends, colored=True, under=True)
    elif iv:
        spec = _with_interval(spec, iv, x, "x", enc, "yOffset" if grp and not panels else None,
                              mark={"type": "rule", "yOffset": DODGE_OFFSET} if dodge else "rule")
    if opts.get("marks") is not None:
        spec = _with_marks(kind, spec, opts["marks"], x, kinds[x])
    spec = _with_panels(spec, grp, groups, own_y=kind == "line") if panels else spec
    if dodge:  # where the rows are, before any panel takes its share of them
        spec["transform"] = [*dodge, *spec.get("transform", [])]
    return spec


def _fit_column(kind: str, fit: str, df, x: str, y: str, grp, xkind: str, rows: list) -> str:
    """Each row's fitted y, the trend of its group (`fit`, FITS), added to `rows` as a column of its own whose name is
    returned: None where the row has no x, or its group too few distinct x values for the fit (2 for a line, 3 for a
    smooth one). ValueError when no group has enough."""
    import numpy as np

    xs = _times(df[x]) if xkind == "time" else df[x]
    xv = np.array([np.nan if _missing(v) else (v.value / 1e9 if xkind == "time" else float(v)) for v in xs.tolist()])
    yv = np.array([np.nan if _missing(v) else float(v) for v in df[y].tolist()])
    keys = [json.dumps(_json_value(g)) for g in df[grp].tolist()] if grp else ["" for _ in range(len(df))]
    need = 2 if fit == "linear" else 3
    out = np.full(len(df), np.nan)
    for key in set(keys):
        at = np.array([k == key for k in keys]) & np.isfinite(xv)
        both = at & np.isfinite(yv)
        if len(np.unique(xv[both])) < need:
            continue
        gx, gy = xv[both], yv[both]
        if fit == "linear":
            mx, my = gx.mean(), gy.mean()
            slope = ((gx - mx) * (gy - my)).sum() / ((gx - mx) ** 2).sum()
            out[at] = my + slope * (xv[at] - mx)
        else:
            grid = np.unique(gx)
            if len(grid) > SMOOTH_AT:
                grid = np.linspace(grid[0], grid[-1], SMOOTH_AT)
            out[at] = np.interp(xv[at], grid, _loess(gx, gy, grid))
    if not np.isfinite(out).any():
        raise ValueError(f"thimble.chart({kind!r}): a {fit} fit needs {need} or more points with distinct x values in a "
                         + ("group" if grp else "chart"))
    name = _free(f"{y} fit", list(df.columns))
    for r, v in zip(rows, out.tolist()):
        r[name] = _num(float(f"{v:.6g}")) if math.isfinite(v) else None
    return name


def _loess(x, y, at):
    """A local regression (LOESS, as R's loess and ggplot's smooth draw it) of y on x read at each of `at`: a quadratic
    fitted to the SMOOTH_SPAN of the points nearest it, weighted by their distance (tricube), after two rounds that weigh
    down the points far from the curve (bisquare), so an outlier barely moves it."""
    import numpy as np

    k = min(len(x), max(3, math.ceil(SMOOTH_SPAN * len(x))))

    def fitted(points, robust):
        out = np.empty(len(points))
        for i, p in enumerate(points):
            d = x - p
            h = np.partition(np.abs(d), k - 1)[k - 1] or np.abs(d).max() or 1.0  # the nearest share's farthest point
            w = np.clip(1 - np.abs(d / h) ** 3, 0, 1) ** 3 * robust
            root = np.sqrt(w)
            u = d / h
            coef = np.linalg.lstsq(np.stack([root, root * u, root * u * u], axis=1), root * y, rcond=None)[0]
            out[i] = coef[0] if w.sum() > 0 else np.nan
        return out

    robust = np.ones(len(x))
    for _ in range(2):
        resid = y - np.interp(x, at, fitted(at, robust))
        s = np.median(np.abs(resid))
        if not s > 0:
            break
        robust = np.clip(1 - (resid / (6 * s)) ** 2, 0, 1) ** 2
    return fitted(at, robust)


def _area_spec(df, opts: dict) -> dict:
    """Areas over numbers or times, a third column's series stacked in the legend's order, side by side overlapping
    lightly, or stacked to 100% of each x."""
    kind = "area"
    cols = list(df.columns)
    x, y, ser = cols[0], cols[1], cols[2] if len(cols) > 2 else None
    kinds = _chart_kinds(kind, df, number=(1,), axis=(0,))
    stack = opts.get("stack", True)
    if not (stack is True or stack is False or stack == "share"):
        raise ValueError(f"thimble.chart({kind!r}): `stack` is True, False or \"share\", not {stack!r}")
    panels = _panels_on(kind, opts, ser)
    if ser is None and ("stack" in opts or opts.get("label") is not None):
        raise ValueError(f"thimble.chart({kind!r}): `{'stack' if 'stack' in opts else 'label'}` takes the series of a "
                         "third column, which this frame lacks")
    label = _label_values(kind, opts["label"], df[ser], ser) if opts.get("label") is not None else None
    rows = _chart_rows(df, kinds)
    ticks = _step_ticks(_times(df[x])) if kinds[x] == "time" else {}
    enc: dict = {"x": _enc(x, "temporal" if kinds[x] == "time" else "quantitative", **ticks),
                 "y": _enc(y, "quantitative")}
    mark: dict = {"type": "area"}
    more: dict = {}
    if ser:
        series = _ordered(kind, df[ser], _ranked(df[ser], df[y]), label=label)
        enc["color"] = _enc(ser, "nominal", sort=series)
        if panels:
            pass
        elif stack is False:
            enc["y"]["stack"] = None
            mark["style"] = OVERLAP_STYLE
        else:
            if stack == "share":
                enc["y"] = {**enc["y"], "stack": "normalize", "axis": {"format": "%"}}
            # Vega-Lite stacks the areas by the series' names; this stacks them in the legend's order, the first lowest
            more["transform"] = [{"calculate": f"indexof({json.dumps(series)}, datum[{json.dumps(ser)}])", "as": STACK_FIELD}]
            enc["order"] = {"field": STACK_FIELD, "type": "quantitative"}
    enc["tooltip"] = _tooltip(df, kinds)
    # a hover tip at each value while the series are short, at a point the theme draws wider than a dot, unseen by its
    # own fillOpacity: Vega-Lite gives a style's fillOpacity to the legend's swatches too, which overlapping areas show
    longest = int(df.groupby(ser, sort=False).size().max()) if ser and len(df) else len(df)
    if longest <= LINE_DOTS_MAX:
        mark["point"] = {"style": HOVER_STYLE, "fillOpacity": 0}
    spec = _unit(rows, mark if len(mark) > 1 else "area", enc, **more)
    if opts.get("marks") is not None:
        spec = _with_marks(kind, spec, opts["marks"], x, kinds[x])
    return _with_panels(spec, ser, series) if panels else spec


def _num(v: float):
    """A computed number as a chart's row holds it: whole numbers as ints, the rest without float noise."""
    v = round(float(v), 10)
    return int(v) if v.is_integer() else v


def _box_spec(df, opts: dict) -> dict:
    """A box per group lying down, as Tukey drew it: the box from its first quartile to its third, its median a line in
    ink across it, whiskers to the farthest values within BOX_REACH box widths of it, and a dot for each value past
    them; a group of fewer than BOX_MIN values a strip of its dots alone. Dots that would overlap move across their line
    (_dodge). The chart's rows are each group's summary, which a takeaway cites; the dots' rows are their layer's
    own."""
    import pandas as pd

    kind = "box"
    val, grp = list(df.columns)
    kinds = _chart_kinds(kind, df, number=(0,))
    label = _label_values(kind, opts["label"], df[grp], grp) if opts.get("label") is not None else None
    # the groups as text, as the sort and the label read them
    values = [r for r in _chart_rows(df, {**kinds, grp: "text"}) if r[val] is not None and r[grp] is not None]
    by: dict = {}
    for r in values:
        by.setdefault(json.dumps(r[grp]), (r[grp], []))[1].append(r[val])
    names: list = []
    for c in ("n", "low", "q1", "median", "q3", "high"):
        names.append(_free(c, [val, grp, *names]))
    n, low, q1, median, q3, high = names
    stats: dict = {}
    for key, (g, vs) in by.items():
        a, m, b = pd.Series(vs, dtype=float).quantile([0.25, 0.5, 0.75]).tolist()
        reach = BOX_REACH * (b - a)
        stats[key] = {grp: g, n: len(vs), low: _num(min(v for v in vs if v >= a - reach)), q1: _num(a), median: _num(m),
                      q3: _num(b), high: _num(max(v for v in vs if v <= b + reach))}
    ranked = [stats[k][grp] for k in sorted(stats, key=lambda k: -stats[k][median])]
    order = _ordered(kind, df[grp], ranked, opts.get("sort", _DEFAULT), what="groups")
    rows = sorted(stats.values(), key=lambda r: order.index(r[grp]) if r[grp] in order else len(order))
    boxed = {k for k, r in stats.items() if r[n] >= BOX_MIN}
    y = _enc(grp, "nominal", sort=order, scale={"paddingInner": BOX_PAD})
    color = {"color": _enc(grp, "nominal", sort=order, legend=None)} if label is not None else {}
    dot_tip = _tooltip(df, {**kinds, grp: "text"})
    tip = [{"field": _field(c), "type": "nominal" if c == grp else "quantitative", "title": c} for c in (grp, *names)]

    def along(field: str) -> dict:
        return _enc(field, "quantitative", title=val)

    def past(r) -> bool:  # a dot of its own: a value past its box's whiskers, or one of a group too small for a box
        key = json.dumps(r[grp])
        return key not in boxed or not stats[key][low] <= r[val] <= stats[key][high]

    layer: list = []
    if boxed:
        only = [{"filter": f"datum[{json.dumps(n)}] >= {BOX_MIN}"}]
        layer += [
            {"transform": only, "mark": "rule", "encoding": {"x": along(low), "x2": {"field": _field(q1)}, "y": y, "tooltip": tip}},
            {"transform": only, "mark": "rule", "encoding": {"x": along(q3), "x2": {"field": _field(high)}, "y": y, "tooltip": tip}},
            {"transform": only, "mark": {"type": "bar", "style": BOX_STYLE},
             "encoding": {"x": along(q1), "x2": {"field": _field(q3)}, "y": y, **color, "tooltip": tip}},
            {"transform": only, "mark": {"type": "tick", "style": MEDIAN_STYLE},
             "encoding": {"x": along(median), "y": y, "tooltip": tip}},
        ]
    dots = [r for r in values if past(r)]
    if dots:
        every = [r[val] for r in values]
        dodge = _dodged(_dodge([float(r[val]) for r in dots], [json.dumps(r[grp]) for r in dots], max(every) - min(every)))
        layer.append({"data": {"values": dots}, **({"transform": dodge} if dodge else {}),
                      "mark": {"type": "point", "yOffset": DODGE_OFFSET} if dodge else "point",
                      "encoding": {"x": along(val), "y": y, **color, "tooltip": dot_tip}})
    if not layer:
        raise ValueError(f"thimble.chart({kind!r}): `{val}` holds no numbers with a group to draw")
    return {"data": {"values": rows}, "layer": layer}


def _value_groups(kind: str, df, opts: dict) -> tuple:
    """A histogram's, a density's or an ecdf's values by group: (the value column, the group column or None, a label's
    values or None, {key: (the group as the chart's rows hold it, its values as floats)}, the groups once each as a
    column of the frame's, for _ordered), groups in the frame's order; a value with no group, none of its own or an
    infinite one is left out, and so is a group left with none. Any number of values, so pandas groups them."""
    import numpy as np

    cols = list(df.columns)
    val, grp = cols[0], cols[1] if len(cols) > 1 else None
    _chart_kinds(kind, df, number=(0,))
    if opts.get("label") is not None and grp is None:
        raise ValueError(f"thimble.chart({kind!r}): `label` colors the group column, which this frame lacks")
    label = _label_values(kind, opts["label"], df[grp], grp) if opts.get("label") is not None else None
    vals = df[val].astype(float)
    kept = np.isfinite(vals) & (df[grp].notna() if grp else True)
    by: dict = {}
    for g, part in (vals[kept].groupby(df[grp][kept], sort=False) if grp else [(None, vals[kept])]):
        if not len(part):
            continue
        j = _json_value(g)
        by.setdefault(json.dumps(j), (j, []))[1].extend(part.tolist())
    if not by:
        raise ValueError(f"thimble.chart({kind!r}): `{val}` holds no numbers to draw")
    return val, grp, label, by, df[grp][kept].drop_duplicates() if grp else None


def _by_median(by: dict, largest: bool = True) -> list:
    """The groups of `by` (_value_groups) by their median, the largest first, or the least."""
    import numpy as np

    meds = {k: float(np.median(vs)) for k, (_g, vs) in by.items()}
    return [by[k][0] for k in sorted(meds, key=lambda k: -meds[k] if largest else meds[k])]


def _histogram_spec(df, opts: dict) -> dict:
    """The values counted in bins of a round width; a group column's groups stacked in each bin in the legend's order, or
    each in a panel of its own, all in the same bins."""
    import numpy as np

    kind = "histogram"
    col, grp, label, by, firsts = _value_groups(kind, df, opts)
    panels = _panels_on(kind, opts, grp)
    vals = np.concatenate([np.asarray(vs) for _g, vs in by.values()])
    lo, hi = float(vals.min()), float(vals.max())
    whole = bool((vals == np.floor(vals)).all())
    step = opts.get("step")
    if step is None:
        raw = (hi - lo) / BINS or (abs(lo) / BINS if lo else 1.0)
        e = 10 ** math.floor(math.log10(raw))
        step = next(m * e for m in (1, 2, 5, 10) if m * e >= raw * (1 - 1e-9))
        step = max(step, 1.0) if whole else step
    elif isinstance(step, bool) or not isinstance(step, numbers.Real) or not step > 0:
        raise ValueError(f"thimble.chart({kind!r}): `step` is a bin's width, a number above 0, not {step!r}")
    step = float(step)
    start = math.floor(lo / step + 1e-9) * step
    n = int(math.floor((hi - start) / step + 1e-9)) + 1
    if n > BINS_MAX:
        raise ValueError(f"thimble.chart({kind!r}): a step of {step:g} makes {n:,} bins, and a histogram takes {BINS_MAX} "
                         "at most")

    def counted(vs) -> list:
        at = np.minimum(n - 1, np.floor((np.asarray(vs) - start) / step + 1e-9).astype(int))
        return np.bincount(at, minlength=n).tolist()

    def edge(i):
        v = round(start + i * step, 10)
        return int(v) if v.is_integer() else v

    taken = [col, grp] if grp else [col]
    end = _free(f"{col} end", taken)
    count = _free("count", [*taken, end])
    # plain numbers on the axis (Vega-Lite labels bins of a round step as 1.2e+2 otherwise)
    enc = {"x": _enc(col, "quantitative", bin={"binned": True, "step": step}, axis={"format": ",~r"}),
           "x2": {"field": _field(end)},
           "y": _enc(count, "quantitative"),
           "tooltip": [{"field": _field(c), "type": "quantitative", "title": c} for c in (col, end, count)]}
    more: dict = {}
    if grp is None:
        rows = [{col: edge(i), end: edge(i + 1), count: c} for i, c in enumerate(counted(vals))]
    else:
        most = [by[k][0] for k in sorted(by, key=lambda k: -len(by[k][1]))]  # the most values first
        groups = _ordered(kind, firsts, most, label=label)
        rows = [{col: edge(i), end: edge(i + 1), count: c, grp: g}
                for g in groups for i, c in enumerate(counted(by[json.dumps(g)][1]))]
        enc["color"] = _enc(grp, "nominal", sort=groups)
        enc["tooltip"].append({"field": _field(grp), "type": "nominal", "title": grp})
        if not panels:  # stacked in the legend's order, as a bar chart's groups are
            more["transform"] = [{"calculate": f"indexof({json.dumps(groups)}, datum[{json.dumps(grp)}])", "as": STACK_FIELD}]
            enc["order"] = {"field": STACK_FIELD, "type": "quantitative"}
    spec = _unit(rows, "bar", enc, **more)
    if opts.get("marks") is not None:
        spec = _with_marks(kind, spec, opts["marks"], col, "number")
    return _with_panels(spec, grp, groups) if panels else spec


def _bandwidth(vs: list) -> float:
    """A density's smoothing width for the values `vs` by Silverman's rule: 0.9 times the lesser of their standard
    deviation and their interquartile range over 1.34, times their count to the -1/5; for values that do not spread, a
    tenth of their size, else 1."""
    import numpy as np

    a = np.asarray(vs, dtype=float)
    sd = float(a.std(ddof=1)) if len(a) > 1 else 0.0
    q1, q3 = np.percentile(a, [25, 75])
    iqr = float(q3 - q1) / 1.34
    spread = min(sd, iqr) if sd > 0 and iqr > 0 else sd or iqr or abs(float(a.mean())) / 10 or 1.0
    return 0.9 * spread * len(a) ** -0.2


def _kde(vs: list, h: float, xs):
    """The density of the values `vs` at each of `xs`, smoothed by a Gaussian of width `h`, the curve's area 1. A group of
    more than DENSITY_EXACT values is counted in DENSITY_BINS bins first, each bin's middle weighted by its count."""
    import numpy as np

    a = np.asarray(vs, dtype=float)
    w = np.ones(len(a))
    if len(a) > DENSITY_EXACT:
        counts, edges = np.histogram(a, bins=DENSITY_BINS)
        keep = counts > 0
        a, w = ((edges[:-1] + edges[1:]) / 2)[keep], counts[keep].astype(float)
    z = (xs[:, None] - a[None, :]) / h
    return (np.exp(-0.5 * z * z) * w).sum(axis=1) / (w.sum() * h * math.sqrt(2 * math.pi))


def _curve_rows(kind: str, val: str, grp, by: dict, order: list, opts: dict) -> tuple:
    """The groups of `by` (_value_groups), in `order`, each as a smooth density curve (a Gaussian kernel's), its area 1,
    over a range the curves share that stops at 0 when no value passes it (the smoothing past 0 folded back inside),
    through enough points to show the narrowest curve's bumps: (the rows, each a value, its density and the group, the
    density column's name). `bandwidth` in `opts` sets the smoothing's width."""
    import numpy as np

    bw = opts.get("bandwidth")
    if bw is not None and (isinstance(bw, bool) or not isinstance(bw, numbers.Real) or not bw > 0):
        raise ValueError(f"thimble.chart({kind!r}): `bandwidth` is the width of the smoothing in `{val}`'s units, a number "
                         f"above 0, not {bw!r}")
    widths = {k: float(bw) if bw is not None else _bandwidth(vs) for k, (_g, vs) in by.items()}
    least = min(min(vs) for _g, vs in by.values())
    most = max(max(vs) for _g, vs in by.values())
    lo = min(min(vs) - 3 * widths[k] for k, (_g, vs) in by.items())
    hi = max(max(vs) + 3 * widths[k] for k, (_g, vs) in by.items())
    # a range that would pass 0 where no value does stops there, and the smoothing that would spill past 0 is folded
    # back (each value counts again as its mirror image across 0), so the curve keeps its area and does not sink toward
    # 0 where the values crowd it
    fold = (least >= 0 > lo) or (most <= 0 < hi)
    if least >= 0:
        lo = max(lo, 0.0)
    elif most <= 0:
        hi = min(hi, 0.0)
    # enough points that the narrowest curve's bumps are drawn, DENSITY_POINTS at least, and DENSITY_ROWS rows at most
    points = min(DENSITY_POINTS_MAX, max(DENSITY_POINTS, math.ceil(2 * (hi - lo) / min(widths.values()))))
    points = min(points, max(DENSITY_POINTS, DENSITY_ROWS // len(by)))
    xs = np.linspace(lo, hi, points)
    digits = max(0, 2 - math.floor(math.log10((hi - lo) / (points - 1))))
    density = _free("density", [val, grp] if grp else [val])
    rows = []
    for g in order:
        key = json.dumps(g)
        curve = _kde(by[key][1], widths[key], xs)
        if fold:
            curve = curve + _kde(by[key][1], widths[key], -xs)
        for x, d in zip(xs.tolist(), curve.tolist()):
            rows.append({val: _num(round(x, digits)), density: _num(float(f"{d:.4g}")), **({grp: g} if grp else {})})
    return rows, density


def _density_spec(df, opts: dict) -> dict:
    """Each group's values as a smooth density curve (a Gaussian kernel's), its area 1, over a range the curves share
    that stops at 0 when no value passes it (the smoothing past 0 folded back inside), drawn through enough points to
    show the narrowest curve's bumps: a few groups overlapping lightly, RIDGE_FROM or more each on a baseline of
    its own one over another (a ridgeline, named on the y axis), or each in a panel of its own. The rows are the curves'
    points; the ridges' places are laid out by the chart, not held in its rows."""
    kind = "density"
    val, grp, label, by, firsts = _value_groups(kind, df, opts)
    panels = _panels_on(kind, opts, grp)
    order = [None]
    if grp:
        order = _ordered(kind, firsts, _by_median(by), opts.get("sort", _DEFAULT), what="groups")
    elif "sort" in opts:
        raise ValueError(f"thimble.chart({kind!r}): `sort` orders the groups of a second column, which this frame lacks")
    rows, density = _curve_rows(kind, val, grp, by, order, opts)
    enc: dict = {"x": _enc(val, "quantitative"), "y": _enc(density, "quantitative")}
    tip = [{"field": _field(c), "type": "quantitative", "title": c} for c in (val, density)]
    if grp:
        tip.append({"field": _field(grp), "type": "nominal", "title": grp})
    more: dict = {}
    if grp and len(order) >= RIDGE_FROM and not panels:
        # each ridge on its own baseline, the lowest group's at 0, the curves scaled alike so the highest rises RIDGE_RISE
        # baselines; the axis names each baseline by its group
        n, top = len(order), max(r[density] for r in rows) or 1
        more["transform"] = [
            {"calculate": f"{n - 1} - indexof({json.dumps(order)}, datum[{json.dumps(grp)}])", "as": RIDGE_BASE},
            {"calculate": f"datum[{json.dumps(RIDGE_BASE)}] + datum[{json.dumps(density)}] / {top} * {RIDGE_RISE}",
             "as": RIDGE_TOP}]
        names = [_text(g) for g in reversed(order)]
        enc["y"] = {"field": RIDGE_TOP, "type": "quantitative", "title": grp,
                    "axis": {"values": list(range(n)), "labelExpr": f"{json.dumps(names)}[datum.value]"}}
        enc["y2"] = {"field": RIDGE_BASE}
        enc["detail"] = {"field": _field(grp), "type": "nominal"}
        if label is not None:
            enc["color"] = _enc(grp, "nominal", sort=order, legend=None)
    elif grp:
        enc["color"] = _enc(grp, "nominal", sort=order)
        enc["y"]["stack"] = None  # the curves overlap; Vega-Lite would stack them
    enc["tooltip"] = tip
    # a smooth line through the points, which never overshoots them
    spec = _unit(rows, {"type": "area", "line": True, "interpolate": "monotone", "style": OVERLAP_STYLE}, enc, **more)
    if opts.get("marks") is not None:
        spec = _with_marks(kind, spec, opts["marks"], val, "number")
    return _with_panels(spec, grp, order) if panels else spec


def _violin_spec(df, opts: dict) -> dict:
    """Each group's values as a violin lying down: its density curve (_curve_rows, as a density chart's) mirrored either
    side of the group's line, each curve scaled so its widest point reaches VIOLIN_HALF of the way to the next line, its
    first to third quartile a line in ink along it and its median a mark in ink across it; a group of fewer than BOX_MIN
    values a strip of its dots alone, as a box plot's, those that would overlap moved across the line (_dodge). The
    groups one under another, the largest median first, named on the y axis. The rows are the curves' points; the
    violins' places and widths are laid out by the chart, and the quartiles and the dots are their layers' own rows."""
    import numpy as np

    kind = "violin"
    val, grp, label, by, firsts = _value_groups(kind, df, opts)
    order = _ordered(kind, firsts, _by_median(by), opts.get("sort", _DEFAULT), what="groups")
    curved = [g for g in order if len(by[json.dumps(g)][1]) >= BOX_MIN]
    rows, density = _curve_rows(kind, val, grp, {json.dumps(g): by[json.dumps(g)] for g in curved}, curved, opts) \
        if curved else ([], _free("density", [val, grp]))
    n = len(order)
    line = [{"calculate": f"{n - 1} - indexof({json.dumps(order)}, datum[{json.dumps(grp)}])", "as": RIDGE_BASE}]
    reach = f"datum[{json.dumps(density)}] / max(datum[{json.dumps(VIOLIN_MOST)}], 1e-300) * {VIOLIN_HALF}"
    body = [*line, {"joinaggregate": [{"op": "max", "field": _field(density), "as": VIOLIN_MOST}], "groupby": [_field(grp)]},
            {"calculate": f"datum[{json.dumps(RIDGE_BASE)}] + {reach}", "as": RIDGE_TOP},
            {"calculate": f"datum[{json.dumps(RIDGE_BASE)}] - {reach}", "as": VIOLIN_LOW}]
    names = [_text(g) for g in reversed(order)]
    # each group's line at a whole number, the top group's highest; the axis names the lines and draws no grid
    y = {"type": "quantitative", "title": grp, "scale": {"domain": [-0.5, n - 0.5], "nice": False, "zero": False},
         "axis": {"values": list(range(n)), "labelExpr": f"{json.dumps(names)}[datum.value]", "grid": False}}
    color = {"color": _enc(grp, "nominal", sort=order, legend=None)} if label is not None else {}
    tip = [{"field": _field(val), "type": "quantitative", "title": val},
           {"field": _field(density), "type": "quantitative", "title": density},
           {"field": _field(grp), "type": "nominal", "title": grp}]
    names_q: list = []
    for c in ("q1", "median", "q3"):
        names_q.append(_free(c, [val, grp, *names_q]))
    q1, median, q3 = names_q
    quartiles = []
    for g in curved:
        a, m, b = np.percentile(np.asarray(by[json.dumps(g)][1], dtype=float), [25, 50, 75]).tolist()
        quartiles.append({grp: g, q1: _num(a), median: _num(m), q3: _num(b)})
    qtip = [{"field": _field(c), "type": "nominal" if c == grp else "quantitative", "title": c}
            for c in (grp, q1, median, q3)]
    at = {**y, "field": RIDGE_BASE}
    layer: list = []
    if curved:
        layer += [
            {"transform": body, "mark": {"type": "area", "interpolate": "monotone", "style": BOX_STYLE},
             "encoding": {"x": _enc(val, "quantitative"), "y": {**y, "field": RIDGE_TOP}, "y2": {"field": VIOLIN_LOW},
                          "detail": {"field": _field(grp), "type": "nominal"}, **color, "tooltip": tip}},
            {"data": {"values": quartiles}, "transform": line, "mark": "rule",
             "encoding": {"x": _enc(q1, "quantitative", title=val), "x2": {"field": _field(q3)}, "y": at, "tooltip": qtip}},
            {"data": {"values": quartiles}, "transform": line,
             "mark": {"type": "tick", "orient": "vertical", "style": MEDIAN_STYLE},
             "encoding": {"x": _enc(median, "quantitative", title=val), "y": at, "tooltip": qtip}},
        ]
    dots = [{val: _num(v), grp: g} for g in order if g not in curved for v in by[json.dumps(g)][1]]
    if dots:
        every = [v for _g, vs in by.values() for v in vs]
        dodge = _dodged(_dodge([r[val] for r in dots], [json.dumps(r[grp]) for r in dots], max(every) - min(every)))
        layer.append({"data": {"values": dots}, "transform": [*line, *dodge],
                      "mark": {"type": "point", "yOffset": DODGE_OFFSET} if dodge else "point",
                      "encoding": {"x": _enc(val, "quantitative"), "y": at, **color,
                                   "tooltip": [{"field": _field(c), "type": "nominal" if c == grp else "quantitative",
                                                "title": c} for c in (val, grp)]}})
    return {"data": {"values": rows or dots}, "layer": layer}


def _ecdf_spec(df, opts: dict) -> dict:
    """Each group's cumulative share: at each of its values, the share of its values at or below it, drawn as steps. The
    rows are those shares, at ECDF_STEPS_MAX of a group's values at most; the legend lists the groups by their median,
    the least first, as their curves stand from the top."""
    import numpy as np

    kind = "ecdf"
    val, grp, label, by, firsts = _value_groups(kind, df, opts)
    share = _free("share", [val, grp] if grp else [val])
    order = [None]
    if grp:
        order = _ordered(kind, firsts, _by_median(by, largest=False), label=label)
    rows, longest = [], 0
    for g in order:
        u, c = np.unique(np.asarray(by[json.dumps(g)][1]), return_counts=True)
        p = np.cumsum(c) / c.sum()
        if len(u) > ECDF_STEPS_MAX:
            keep = np.unique(np.linspace(0, len(u) - 1, ECDF_STEPS_MAX).round().astype(int))
            u, p = u[keep], p[keep]
        longest = max(longest, len(u))
        rows += [{val: _num(x), share: _num(round(s, 6)), **({grp: g} if grp else {})} for x, s in zip(u.tolist(), p.tolist())]
    enc: dict = {"x": _enc(val, "quantitative"), "y": _enc(share, "quantitative", axis={"format": "%"})}
    tip = [{"field": _field(val), "type": "quantitative", "title": val},
           {"field": _field(share), "type": "quantitative", "title": share, "format": ".1%"}]
    if grp:
        enc["color"] = _enc(grp, "nominal", sort=order)
        tip.append({"field": _field(grp), "type": "nominal", "title": grp})
    enc["tooltip"] = tip
    mark: dict = {"type": "line", "interpolate": "step-after"}
    if longest <= LINE_DOTS_MAX:
        mark["point"] = True
    spec = _unit(rows, mark, enc)
    return _with_marks(kind, spec, opts["marks"], val, "number") if opts.get("marks") is not None else spec


def _range_spec(df, opts: dict) -> dict:
    """A dumbbell per item lying down: a muted line from its before to its after, both numbers or both times, and a
    solid dot at each end, the line stopping at the dots' edges; the x axis titled "before → after" by the columns'
    names. The two ends take two series colors, named in the legend by their columns; when a group column, or a label
    on the items, colors the dumbbells, the ends are told apart by how strongly they show, the before end the lighter,
    in a legend of their own titled "end". Items by
    their after, the largest first, or with times by their before, the earliest first; a group column's groups side by
    side on the line of an item that is in several."""
    kind = "range"
    cols = list(df.columns)
    item, before, after = cols[:3]
    grp = cols[3] if len(cols) > 3 else None
    kinds = _chart_kinds(kind, df, axis=(1, 2))
    if kinds[before] != kinds[after]:
        word = {"time": "times", "number": "numbers"}
        raise ValueError(f"thimble.chart({kind!r}) takes {_shape(kind)} columns, the before and after both numbers or both "
                         f"times; `{before}` holds {word[kinds[before]]} and `{after}` {word[kinds[after]]}")
    xk = kinds[before]
    on = grp or item  # the column a label colors
    label = _label_values(kind, opts["label"], df[on], on) if opts.get("label") is not None else None
    ranked = _ranked(df[item], _times(df[before]), earliest=True) if xk == "time" else \
        _ranked(df[item], -df[after].astype(float), earliest=True)
    order = _ordered(kind, df[item], ranked, opts.get("sort", _DEFAULT), None if grp else label, "items")
    rows = _chart_rows(df, kinds)
    xt, title = ("temporal" if xk == "time" else "quantitative"), f"{before} \u2192 {after}"
    # the ends are places, not lengths from 0: the axis spans them, with room for the marks at its ends
    scale = {"scale": {"zero": False, "padding": RANGE_PAD} if xk == "number" else {"padding": RANGE_PAD}}
    y = {"y": _enc(item, "nominal", sort=order)}
    color: dict = {}
    if grp:
        groups = _ordered(kind, df[grp], _ranked(df[grp], df[grp].map(lambda _v: 1)), label=label)
        color["color"] = _enc(grp, "nominal", sort=groups)
        if df[item].duplicated().any():  # an item in several groups: their dumbbells side by side on its line
            y["yOffset"] = {"field": _field(grp), "type": "nominal", "sort": groups}
    elif label is not None:
        color["color"] = _enc(item, "nominal", sort=order, legend=None)
    # each end named by its column: in the series colors, or, when the dumbbells have colors of their own, by strength;
    # the ends in order by the scale's domain, which a view's Color by leaves as it is (viewer_chart.js colors a field
    # that its rows hold, or that a `sort` lists)
    end = {"field": RANGE_END, "type": "ordinal" if color else "nominal", "scale": {"domain": [before, after]},
           "title": "end" if color else None}
    ends = {**color, ("opacity" if color else "color"): end}
    tip = _tooltip(df, kinds)
    # the line runs from one end's edge to the other's: 1 when the after lies past the before, -1 before it, 0 at it
    b, a = f"datum[{json.dumps(before)}]", f"datum[{json.dumps(after)}]"
    way = f"({a} > {b} ? 1 : {a} < {b} ? -1 : 0)"

    def dot(c: str) -> dict:
        return {"transform": [{"calculate": json.dumps(c), "as": RANGE_END}], "mark": {"type": "point", "style": END_STYLE},
                "encoding": {"x": _enc(c, xt, title=title, **scale), **y, **ends, "tooltip": tip}}

    spec = {"data": {"values": rows}, "layer": [
        {"mark": {"type": "rule", "style": SPAN_STYLE, "xOffset": {"expr": f"{way} * {RANGE_GAP}"},
                  "x2Offset": {"expr": f"{way} * {-RANGE_GAP}"}},
         "encoding": {"x": _enc(before, xt, title=title, **scale), "x2": {"field": _field(after)}, **y, "tooltip": tip}},
        dot(before),
        dot(after),
    ]}
    return _with_marks(kind, spec, opts["marks"], before, xk) if opts.get("marks") is not None else spec


def _heatmap_spec(df, opts: dict) -> dict:
    kind = "heatmap"
    x, y, val = list(df.columns)
    kinds = _chart_kinds(kind, df, number=(2,))
    log = opts.get("log", False)
    if log not in (True, False):
        raise ValueError(f"thimble.chart({kind!r}): `log` is True or False, not {log!r}")
    rows = _chart_rows(df, {c: "number" if kinds[c] == "number" else "text" for c in df.columns})
    enc: dict = {}
    for ch, c in (("x", x), ("y", y)):
        # the x ticks stand between the columns, so names that read across close together (`Jun 17 Jun 18`) each
        # stand between two ticks rather than over one at the space inside them
        axis: dict = {"tickBand": "extent"} if ch == "x" else {}
        if kinds[c] == "time":  # times as the text of their cells' places, in time order
            ts = _times(df[c])
            fmt = _time_format(ts)
            labels = [None if _missing(t) else t.strftime(fmt) for t in ts.tolist()]
            for r, t in zip(rows, labels):
                r[c] = t
            order = sorted(set(t for t in labels if t is not None))
            # the axis names them as a date axis does ("Jun 18"), short enough that a few weeks of days read across;
            # the one tick more that ticks between columns take has no value, and so no name
            axis["labelExpr"] = (f"datum.value == null ? '' : utcFormat(utcParse(datum.value, '{fmt}'), "
                                 f"'{_time_label_format(ts)}')")
        elif kinds[c] == "number":
            order = sorted(_distinct(df[c].tolist()))
        else:
            order = _ordered(kind, df[c], _ranked(df[c], df[val]))
        enc[ch] = _enc(c, "nominal" if kinds[c] == "text" else "ordinal", sort=order, **({"axis": axis} if axis else {}))
    enc["color"] = _enc(val, "quantitative", **({"scale": {"type": "symlog"}} if log else {}))
    enc["tooltip"] = [{"field": _field(c), "type": "quantitative" if c == val else "nominal", "title": c} for c in (x, y, val)]
    return _unit(rows, "rect", enc)


_CHART_SPECS = {"bar": _bar_spec, "line": lambda df, o: _xy_spec("line", df, o), "area": _area_spec,
                "scatter": lambda df, o: _xy_spec("scatter", df, o), "dots": lambda df, o: _xy_spec("dots", df, o),
                "box": _box_spec, "histogram": _histogram_spec, "density": _density_spec, "violin": _violin_spec,
                "ecdf": _ecdf_spec, "range": _range_spec, "heatmap": _heatmap_spec}


class _Theme:
    """thimble.theme: the theme's colors by their role, for the marks a card's code adds to a chart (an Altair layer
    over thimble.chart(..., show=False)), as in mark_text(color=thimble.theme.accent). Each is a CSS variable of the
    theme's (frontend styles/tokens.css) that the card reads when it draws the chart (lib/vizTheme withTokens), so the
    marks follow the accent and the paper, dark included. A mark given no color takes the theme's own: the first series
    color, and for text and rules the annotation ink; every text mark takes the theme's face and size."""

    __slots__ = ()
    accent = "var(--viz-highlight)"  # one thing set against the rest; the first series color's family
    ink = "var(--viz-ink-1)"  # the darkest ink, for text that leads
    muted = "var(--viz-other)"  # the rest, set against the accent
    pale = "var(--viz-ink-4)"  # quiet lines and shaded spans: a leader line, a span behind the marks
    series = tuple(f"var(--viz-{i})" for i in range(1, 8))  # the series colors in order, as a chart's groups take them

    def __repr__(self) -> str:
        return "thimble.theme: " + ", ".join(f"{k} {getattr(self, k)!r}" for k in ("accent", "ink", "muted", "pale")) \
            + f", series[0..6] {self.series[0]!r} to {self.series[-1]!r}"


theme = _Theme()


# Card types (backend cardtypes.py): a viewer folder whose view.json has a `card` block. The server writes the types a
# workspace has to CARD_TYPES_FILE, each with its argument schema, its files and its reader's index as the views kernel
# keys and caches it, and card() runs the type's card.py on that index in the card's own kernel.
CARD_MIME = "application/vnd.thimble.card+json"
CARD_TYPES_FILE = "card_types.json"
REGISTRY_DIR = "registry"  # kernel_wrap.REGISTRY_DIR: the workspace's folder that holds CARD_TYPES_FILE, read-only in a wrapped kernel
CARD_DATA_MAX = 256 * 1024  # bytes of JSON a card's data may take
_CARD_MODULES: dict = {}  # card.py's path -> ((mtime_ns, size), module)
_JSON_TYPES = {"string": str, "integer": numbers.Integral, "number": numbers.Real, "boolean": bool, "array": list,
               "object": dict}
_TYPE_WORDS = {"string": "a string", "integer": "a whole number", "number": "a number", "boolean": "True or False",
               "array": "a list", "object": "a dict"}


def _card_types() -> dict:
    """{name: type} as the server last wrote them for this workspace; {} before it did."""
    try:
        with open(_ws() / REGISTRY_DIR / CARD_TYPES_FILE, encoding="utf-8") as f:
            got = json.load(f)
    except (OSError, ValueError):
        return {}
    types = got.get("types") if isinstance(got, dict) else None
    return types if isinstance(types, dict) else {}


def _allowed(schema: dict) -> str:
    """What a schema allows, in words, for an error."""
    if "enum" in schema:
        return "one of " + ", ".join(repr(v) for v in schema["enum"])
    t = schema.get("type")
    if t == "array" and isinstance(schema.get("items"), dict):
        return f"a list, each {_allowed(schema['items'])}"
    if t == "object" and schema.get("properties"):
        need = set(schema.get("required") or [])
        return "a dict of " + ", ".join(k if k in need else f"{k} (optional)" for k in schema["properties"])
    return _TYPE_WORDS.get(t, "any value")


def _checked(schema: dict, value, where: str):
    """`value` checked against a JSON Schema subset (type, enum, items, properties, required, additionalProperties,
    default), each object's missing properties that have a default filled in; ValueError saying at `where` what is
    allowed. A tuple, a set or anything with tolist() (a pandas Series) is read as a list."""
    t = schema.get("type")
    if t == "array" and not isinstance(value, (str, bytes, dict)):
        if isinstance(value, (tuple, set, frozenset)):
            value = list(value)
        elif callable(getattr(value, "tolist", None)):
            value = value.tolist()
    if t in _JSON_TYPES and (not isinstance(value, _JSON_TYPES[t]) or (t in ("integer", "number") and isinstance(value, bool))):
        raise ValueError(f"{where} is {_allowed(schema)}, not {value!r}")
    if "enum" in schema and value not in schema["enum"]:
        raise ValueError(f"{where} is {_allowed(schema)}, not {value!r}")
    if t == "array":
        return [_checked(schema.get("items") or {}, v, f"{where}[{i}]") for i, v in enumerate(value)]
    if t == "object":
        props = schema.get("properties") or {}
        out = {}
        for k, v in value.items():
            if k not in props and schema.get("additionalProperties") is False:
                raise ValueError(f"{where} has no `{k}`; the keys are {', '.join(props) or 'none'}")
            out[k] = _checked(props.get(k) or {}, v, f"`{k}`" if where == "the arguments" else f"{where}.{k}")
        for k in schema.get("required") or []:
            if k not in out:
                raise ValueError(f"{where} needs `{k}`")
        for k, p in props.items():
            if k not in out and isinstance(p, dict) and "default" in p:
                out[k] = p["default"]
        return out
    return value


def _views_host(path: str):
    """view_host.py (the reader contract's loader and index cache) as the module `_thimble_views`, loaded again when
    its source changed, versioned as views.snippet versions it."""
    import hashlib
    import sys
    import types

    src = Path(path).read_text("utf-8")
    version = hashlib.sha1(src.encode("utf-8")).hexdigest()[:12]
    mod = sys.modules.get("_thimble_views")
    if getattr(mod, "VERSION", None) != version:
        mod = types.ModuleType("_thimble_views")
        exec(src, mod.__dict__)  # noqa: S102 — thimble's own module source
        mod.VERSION = version
        sys.modules["_thimble_views"] = mod
    return mod


def _card_module(slug: str, path: str):
    """A type's card.py as a module, loaded again when the file's mtime or size changed."""
    import importlib.util
    import os

    st = os.stat(path)
    sig = (st.st_mtime_ns, st.st_size)
    hit = _CARD_MODULES.get(path)
    if hit is not None and hit[0] == sig:
        return hit[1]
    spec = importlib.util.spec_from_file_location("thimble_card_" + slug.replace("-", "_"), path)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load {path}")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    for fn in ("card", "listing"):
        if not callable(getattr(mod, fn, None)):
            raise AttributeError(f"{path} defines no function {fn}()")
    _CARD_MODULES[path] = (sig, mod)
    return mod


def _card_label(k: dict) -> dict:
    """A label as a view's labels context holds it (views.labels_context), read from the workspace, with every value but
    the negative one marking its records, whatever the analyst highlights in Files: a card's records follow its code."""
    n = len(k["classes"])
    lit = {v: not _negative(v, i, n) for i, (v, _c) in enumerate(k["classes"])}
    first = next((c for v, c in k["classes"] if lit[v]), None)
    return {"id": k["id"], "name": k["name"], "colour": LABEL_COLOURS[first if first is not None else 1],
            "values": [{"name": v, "colour": LABEL_COLOURS[c or 0], "highlight": lit[v]} for v, c in k["classes"]],
            "jsonl": str(_ws() / "labels" / f"{k['id']}.jsonl")}


def card(type, labels=None, **args):
    """Show a card of the card type `type`, whose records `labels` (label names) mark and color, with the type's own
    keyword arguments. Returns nothing, so the card shows the graphic once. The labels context holds the named labels
    alone: labels turned on later and the Files filter mark and dim what the card drew, they choose nothing."""
    global _view_ctx
    types = _card_types()
    t = (types.get(type) or next((x for x in types.values() if type in (x.get("aliases") or [])), None)
         if isinstance(type, str) else None)
    if t is None:
        raise ValueError(f"thimble.card: no card type {type!r}; the types here are {', '.join(map(repr, types)) or 'none yet'}")
    if isinstance(labels, str):
        labels = [labels]
    ks = [_find(n) for n in (labels or [])]
    try:
        args = _checked(t.get("args") or {"type": "object"}, args, "the arguments")
    except ValueError as e:
        raise ValueError(f"thimble.card({type!r}): {e}") from None
    for k in ks:
        if all(x["id"] != k["id"] for x in _LABELS_READ):
            _LABELS_READ.append({"id": k["id"], "rev": k["rev"]})
    host = _views_host(t["host"])
    reader = host._reader(t["slug"], t["reader"])
    index, _built = host._index(t["slug"], reader, t["fp"], t["paths"], t["cache"])
    mod = _card_module(t["slug"], t["card"])
    mod.reader = reader
    before = _view_ctx
    _view_ctx = {"labels": [_card_label(k) for k in ks], "filter": None}
    try:
        data = json.loads(json.dumps(mod.card(index, **args), ensure_ascii=False, default=str))
        lines = [" ".join(str(x).split()) for x in mod.listing(data)]
    finally:
        _view_ctx = before
    size = len(json.dumps(data, ensure_ascii=False).encode("utf-8"))
    if size > CARD_DATA_MAX:
        raise ValueError(f"thimble.card({type!r}): the card's data is {size:,} bytes, and a card holds {CARD_DATA_MAX:,} "
                         f"at most; narrow its records")
    _show({CARD_MIME: {"type": t["slug"], "view": t.get("view", t["slug"]), "version": str(t.get("version") or ""),
                       "args": args, "size": t.get("size"),
                       "labels": [{"id": k["id"], "name": k["name"]} for k in ks], "data": data},
           "text/plain": "\n".join(lines)})


class _Json:
    """A user expression's value whose text/plain is the JSON it carries (_frame), since IPython formats a user
    expression's value by its repr."""

    def __init__(self, text: str) -> None:
        self.text = text

    def __repr__(self) -> str:
        return self.text


def _as_frame(value):
    """The value as a DataFrame when it is tabular (a DataFrame, a Series, a Styler's data), else None."""
    import sys

    pd = sys.modules.get("pandas")
    if pd is None:
        return None
    styler = getattr(getattr(pd, "io", None), "formats", None)
    styler = getattr(getattr(styler, "style", None), "Styler", None)
    if styler is not None and isinstance(value, styler):
        value = value.data
    if isinstance(value, pd.Series):
        return value.to_frame(name=value.name if value.name is not None else "value")
    return value if isinstance(value, pd.DataFrame) else None


def _type_of(series) -> str:
    """A column's type: numbers quantitative, times temporal, an ordered category ordinal, the rest nominal (a column of
    Python dates or datetimes is temporal too). The table aligns numbers by it and formats them."""
    import datetime as _dt

    from pandas.api import types as t

    if t.is_bool_dtype(series.dtype):
        return "nominal"
    if t.is_datetime64_any_dtype(series.dtype):
        return "temporal"
    if isinstance(series.dtype, __import__("pandas").CategoricalDtype):
        return "ordinal" if series.dtype.ordered else "nominal"
    if t.is_numeric_dtype(series.dtype):
        return "quantitative"
    vals = series.dropna()
    if len(vals) and all(isinstance(v, (_dt.date, _dt.datetime)) for v in vals.head(200)):
        return "temporal"
    return "nominal"


def _frame_json(df) -> dict:
    """The frame as the server stores it: a named index (or an unnamed one that is not a plain range) as the first
    columns, column names as text, timedeltas as seconds, at most FRAME_ROWS rows as JSON values with times in ISO
    form."""
    import json as _json

    import pandas as pd

    total = int(len(df))
    df = df.head(FRAME_ROWS)
    index = None
    if not (isinstance(df.index, pd.RangeIndex) and all(n is None for n in df.index.names)):
        n = df.index.nlevels
        df = df.reset_index()
        index = [str(c) for c in df.columns[:n]]
    if isinstance(df.columns, pd.MultiIndex):
        df.columns = [" / ".join(str(p) for p in c if str(p)) for c in df.columns]
    names, seen = [], {}
    for c in df.columns:
        name = str(c)
        if name in seen:
            seen[name] += 1
            name = f"{name} ({seen[name]})"
        else:
            seen[name] = 1
        names.append(name)
    df = df.copy()
    df.columns = names
    if index is not None:
        index = names[: len(index)]
    types = {}
    for c in names:
        col = df[c]
        if pd.api.types.is_timedelta64_dtype(col.dtype):
            df[c] = col.dt.total_seconds()
            types[c] = "quantitative"
        else:
            types[c] = _type_of(col)
        if types[c] == "temporal" and not pd.api.types.is_datetime64_any_dtype(df[c].dtype):
            df[c] = df[c].map(lambda v: v.isoformat() if hasattr(v, "isoformat") else v)
    rows = _json.loads(df.to_json(orient="values", date_format="iso", date_unit="s", default_handler=str))
    return {"columns": names, "types": types, "index": index, "rows": rows, "total": total}


def _frame():
    """The DataFrame the card that just ran ends in."""
    import json as _json

    frame, problem, last = None, None, None
    try:
        # imported, not the builtin: IPython puts get_ipython in builtins only while a cell runs, and a user expression
        # is evaluated after the cell
        from IPython import get_ipython

        ip = get_ipython()
        value = getattr(getattr(ip, "last_execution_result", None), "result", None)
    except ImportError:
        value = None
    df = _as_frame(value)
    if df is not None:
        try:
            frame = _frame_json(df)
        except Exception as e:  # noqa: BLE001 — reported to the server rather than raised into the reply
            problem = f"the DataFrame could not be read: {type(e).__name__}: {e}"
    elif value is not None:
        last = type(value).__name__
    return _Json(_json.dumps({"frame": frame, "problem": problem, "last": last}, default=str))


# The card check's trials (notebook.trial_run). A fix's code runs on the card's kernel before the check keeps it, so a
# refused fix would leave its variables behind. _trial_begin notes the namespace's bindings, _trial_end records the
# names the trial bound or rebound, and _trial_undo puts back each that still holds the trial's value. Values are not
# copied. _trial_drop forgets a kept fix's trial. At most _TRIALS_KEPT trials are held, since a cancelled check never
# settles.
_TRIALS = {}
_TRIALS_KEPT = 8
_UNSET = object()


def _user_ns():
    from IPython import get_ipython

    return get_ipython().user_ns


def _trial_begin(tid):
    _TRIALS[tid] = {"before": dict(_user_ns())}
    while len(_TRIALS) > _TRIALS_KEPT:
        _TRIALS.pop(next(iter(_TRIALS)))


def _trial_end(tid):
    t = _TRIALS.get(tid)
    if t is None:
        return
    before, ns = t.pop("before", {}), _user_ns()
    t["changed"] = {k: (before.get(k, _UNSET), ns.get(k, _UNSET)) for k in set(before) | set(ns)
                    if not k.startswith("_") and before.get(k, _UNSET) is not ns.get(k, _UNSET)}


def _trial_undo(tid):
    t = _TRIALS.get(tid)
    if t is not None and "changed" not in t:  # a trial whose code raised ends here, since its user expression never ran
        _trial_end(tid)
    ns = _user_ns()
    for k, (old, new) in (_TRIALS.pop(tid, None) or {}).get("changed", {}).items():
        if ns.get(k, _UNSET) is not new:
            continue
        if old is _UNSET:
            ns.pop(k, None)
        else:
            ns[k] = old


def _trial_drop(tid):
    _TRIALS.pop(tid, None)


# The labels a cell uses. thimble.labels("<name>") and thimble.colours("<name>") note the label id and revision they
# read; _labels_read hands them to the server after the cell (notebook.LABELS_EXPR), and IPython's pre_run_cell event
# empties the list before each cell. The call is the signal, since a regex over the code would miss a label named
# through a variable. The event handler reads the list by global name, so a re-run of this source
# (notebook._refresh_thimble) keeps it working.
_LABELS_READ = []


def _labels_read():
    return _Json(json.dumps(list(_LABELS_READ)))


def _new_cell(*_args, **_kwargs):
    del _LABELS_READ[:]


def _watch_cells():
    try:
        from IPython import get_ipython
    except ImportError:
        return
    ip = get_ipython()
    if ip is None or globals().get("_CELLS_WATCHED"):
        return
    ip.events.register("pre_run_cell", _new_cell)
    globals()["_CELLS_WATCHED"] = True


_watch_cells()
