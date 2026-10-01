"""`thimble`, the module a card's code imports for thimble's data and for the drawings the canvas makes.

Runs inside a workspace kernel: notebook.kernel_argv hands this file's source to the kernel, which builds a module from
it with `WS` (the workspace directory) set and registers it as `thimble`.

    thimble.labels()          the labels defined in this workspace: name, id, kind, unit, values, n_labeled
    thimble.labels("<name>")  one label's matches as a DataFrame (path, line, effective, label, source, verdict,
                              confidence, ref), one row per unit whose effective label is the label's first value;
                              `effective` is the analyst's verdict when there is one, else the classifier's label
    thimble.labels("<name>", negatives=True)
                              every labeled unit, the other values included
    thimble.colours("<name>", values=None)
                              {value: colour} in the colours the label's tags show; with `values`, other values get
                              neutral inks (NEUTRAL_COLOURS)
    thimble.diagram(nodes, edges)
                              a node-link diagram the canvas lays out: nodes as names or {id, label, detail}, edges as
                              (source, target[, label]) or dicts. A node's first line is its label, the rest its
                              detail. Output is DIAGRAM_MIME with a text/plain listing the model reads and cites
    thimble.marked(ref)       in a view's reader: the marks of the labels that are on for one record, each
                              {label, value, colour}, [] outside a view's call
    thimble.kept(ref)         in a view's reader: whether the record passes the analyst's label filter (True with none)
    thimble.kept_unit(refs)   in a view's reader: whether a unit that gathers the records `refs` passes that filter,
                              judged by its records in the files the filter's label ran over (True when it has records
                              and none is in such a file, False when it has no records)
    thimble.view_labels()     in a view's reader: {labels, filter}, the labels that are on with their highlighted values,
                              and the filter {label, value, colour} or None
    thimble.progress(done=None, total=None, note=None)
                              in a view's reader: how far the call has got, which the page can show while it waits;
                              nothing outside a view's call
    thimble.timeline(events, spacing="time")
                              events on a time axis: (time, label[, lane]) or {time, label, lane, end}; TIMELINE_MIME
                              with a text/plain listing. Clock times ("HH:MM[:SS]") are read on CLOCK_DAY, rolling over
                              midnight when a time goes backwards
    thimble.card(type, labels=None, **args)
                              a card of a card type (the workspace's CARD_TYPES_FILE): the arguments checked against the
                              type's schema, the type's card.py run on its reader's index with `labels` as the labels
                              that mark the records, shown as CARD_MIME with the type's listing as text/plain

Each list may also be a DataFrame or a dict of (key, value) pairs; anything else raises a TypeError naming the forms.

Server-only helpers: `_frame()` returns a table card's final DataFrame as JSON (frames.CAPTURE); `_trial_begin/_end/
_undo/_drop` let the card check run a fix's code and put names back if it is refused; `_labels_read()` reports the
labels (with revisions) the last cell read.

Rows come from labels/<id>.sqlite when it reflects the labels file, else from labels/<id>.jsonl (last row per ref wins).
A cover over a range of records supplies their negative value. Only the standard library at import; pandas is imported
when a DataFrame is made.
"""
import io
import json
import math
import os
import numbers
import re
import sqlite3
import zlib
from pathlib import Path

WS = globals().get("WS")  # the workspace directory, set by the injector (notebook.kernel_argv)

__all__ = ["labels", "colours", "marked", "kept", "view_labels", "progress", "diagram", "timeline", "card"]

FRAME_ROWS = 500  # rows of a table card's DataFrame the card keeps and shows (frames.ROWS_MAX)

CLOCK_DAY = "2000-01-01"  # the day clock times are read on (timeline); the canvas prints them as times of day

DIAGRAM_MIME = "application/vnd.thimble.diagram+json"  # tools.DRAWING_MIMES and frontend components/Outputs.tsx
TIMELINE_MIME = "application/vnd.thimble.timeline+json"

_COLUMNS = ["path", "line", "effective", "label", "source", "verdict", "confidence", "ref"]

# A label class's colour by index (concepts.PALETTE): 0 is --label-none, the grey of a negative class; 1..12 are
# --label-1..12 (styles/tokens.css).
LABEL_COLOURS = ["#a09c93", "#0072b2", "#e69f00", "#009e73", "#cc79a7", "#d55e00", "#56b4e9", "#8a6d3b", "#6a5acd", "#aa3377", "#999933",
                 "#6a3d9a", "#d62728"]
# A value a label does not define: --viz-ink-1, -2 and -4 in turn (the third step is the label grey's near twin).
NEUTRAL_COLOURS = ["#1b1a18", "#6b675f", "#cfcbc2"]
_QUIET = frozenset({"no", "none", "other", "no match", "not", "neither", "n/a", "unknown"})  # concepts.QUIET_VALUES
_LEFTOVER = frozenset({"no", "not", "none", "neither", "nothing", "other", "unrelated", "irrelevant"})  # concepts.LEFTOVER_WORDS


def _negative(value: str, index: int, n: int) -> bool:
    """concepts.is_negative: a quiet word, the second of two, or a last value of more that starts with a leftover word."""
    v = value.strip().lower()
    return v in _QUIET or (n == 2 and index == 1) or (n > 2 and index == n - 1 and v.split(" ", 1)[0] in _LEFTOVER)


def _oklab(hex_colour: str) -> tuple:
    """A colour's place in OKLab, where distance is how different two colours look."""
    def lin(x: int) -> float:
        c = x / 255
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4

    r, g, b = (lin(int(hex_colour[i:i + 2], 16)) for i in (1, 3, 5))
    lms = [(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b) ** (1 / 3),
           (0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b) ** (1 / 3),
           (0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b) ** (1 / 3)]
    return tuple(sum(w * x for w, x in zip(row, lms)) for row in ((0.2104542553, 0.7936177850, -0.0040720468),
                                                                  (1.9779984951, -2.4285922050, 0.4505937099),
                                                                  (0.0259040371, 0.7827717662, -0.8086757660)))


_LAB = [_oklab(h) for h in LABEL_COLOURS]


def most_distinct(taken, candidates) -> int:
    """The candidate colour index that looks most unlike the nearest of `taken`; the lowest index on a tie."""
    return max(candidates, key=lambda m: (min((math.dist(_LAB[m], _LAB[t]) for t in taken), default=0.0), -m))


def _ws() -> Path:
    if not WS:
        raise RuntimeError("thimble.labels: this kernel was started without a workspace; run the card from thimble")
    return Path(str(WS))


def _concepts() -> list:
    """Every concept file of the workspace, oldest first (the fields a cell needs)."""
    out = []
    d = _ws() / "concepts"
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
    """Give every class without a colour the one concepts.fill_colours gives it, in place: while a colour is free, one no
    class of any label has, a label's first class takes the first free one; else the colours in turn. A further class
    takes the free colour, else any, that looks most unlike its label's colours (most_distinct). A negative class takes
    the grey, and a label's classes do not repeat a colour while one remains."""
    n_colours = len(LABEL_COLOURS) - 1
    used = {c[1] for k in ks for c in k["classes"] if c[1]}

    def free(start: int):
        return next((m for m in ((start - 1 + i) % n_colours + 1 for i in range(n_colours)) if m not in used), None)

    j = 0
    for k in ks:
        cs = k["classes"]
        if not cs:
            continue
        if cs[0][1] is None:
            cs[0][1] = free(1)
            if cs[0][1] is None:
                cs[0][1] = j % n_colours + 1
                j += 1
            used.add(cs[0][1])
        base = cs[0][1] or 1
        taken = {base} if cs[0][1] else set()
        for i, c in enumerate(cs[1:], 1):
            if c[1] is None:
                mine = [m for m in range(1, n_colours + 1) if m not in taken]
                c[1] = 0 if _negative(c[0], i, len(cs)) else most_distinct(taken, [m for m in mine if m not in used] or mine or [base])
            if c[1] and c[1] in taken:
                c[1] = next((m for m in ((c[1] - 1 + j) % n_colours + 1 for j in range(1, n_colours)) if m not in taken), c[1])
            if c[1]:
                taken.add(c[1])
                used.add(c[1])
    return ks


def _rev(v) -> int:
    try:
        return int(v or 0)
    except (TypeError, ValueError):
        return 0


def _find(name: str) -> dict:
    key = " ".join(str(name or "").split())
    if not key:
        raise ValueError("thimble.labels: give the label's name (thimble.labels() lists them)")
    ks = _concepts()
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
    """(rows, covers) of the labels file, as _store_parts gives them for the store."""
    model = {}
    analyst = {}
    covers: list = []
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
                if r.get("clear"):
                    for ref in [ref for ref, m in model.items() if m[0] == where and a <= (m[1] or 0) <= b]:
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
            else:
                model[ref] = (path, n, r.get("label"), r.get("source"), r.get("confidence"))
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


def labels(name=None, negatives=False):
    """thimble.labels() lists the labels; thimble.labels("<name>") returns one label's matches (every labeled unit with
    negatives=True)."""
    import pandas as pd

    if (_view_ctx or {}).get("probe") and (name is None or name == PROBE_NAME):
        return _probe_labels(pd, name, negatives)
    if name is None:
        ks = [k for k in _concepts() if not k["superseded_by"]]
        return pd.DataFrame([{"name": k["name"], "id": k["id"], "kind": k["kind"], "unit": k["unit"], "values": k["values"],
                              "n_labeled": k["n_labeled"]} for k in ks],
                            columns=["name", "id", "kind", "unit", "values", "n_labeled"])
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
    return df


def colours(name, values=None):
    """thimble.colours("<name>") maps each of the label's values to its colour, in the label's order; with `values`,
    other values follow sorted, in the neutral inks."""
    k = _find(name)
    if all(x["id"] != k["id"] for x in _LABELS_READ):
        _LABELS_READ.append({"id": k["id"], "rev": k["rev"]})
    own = {v: LABEL_COLOURS[n or 0] for v, n in k["classes"]}
    if values is None:
        return own
    if isinstance(values, (str, bytes)) or not hasattr(values, "__iter__"):
        raise TypeError("thimble.colours takes the values as a list or a column, not a single value")
    given = {v for v in values if not _missing(v)}
    others = sorted((v for v in given if not (isinstance(v, str) and v in own)), key=str)
    out = {v: c for v, c in own.items() if v in given}
    out.update({v: NEUTRAL_COLOURS[i % len(NEUTRAL_COLOURS)] for i, v in enumerate(others)})
    return out


# A view's reader call sets _view_ctx (view_host) to the labels context views.labels_context builds: {"labels": [{id,
# name, colour, values: [{name, colour, highlight}], jsonl}], "filter": {id, label, value, colour} | None}, or to the
# probe {"probe": n, "filter": bool}, a test label that marks every record whose line is a multiple of n. Outside a
# view's call it is None, and marked() and kept() answer as if no label were on.
_view_ctx = None
_view_paths: list = []  # the claimed files of the view whose reader call is running
# During a view's records call (view_host) a set of the refs kept() and kept_unit() refused, which thimble counts above
# the view as hidden by the filter; None outside one.
_left_out = None
PROBE_NAME = "test label"
PROBE_ID = "test-label"
# the colour the analyst's first label takes (--label-1), so the pictures show a view's own colour that clashes with a
# label where the analyst would see it
PROBE_COLOUR = LABEL_COLOURS[1]
# labels file -> (the files' signature, (_Values, {path: [(first, last, value)]}, {path})), the most recently used last
_MEMBERS: dict = {}
MEMBERS_KEPT = 8
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
        path, line = _ref_parts(ref)
        if line is not None and path is not None and ref == f"{path}#L{line}":
            c = self._line_code(path, line)
            return self._names[c] if c else default
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
    file changes (at most MEMBERS_KEPT labels), so a reader's lookups cost a lookup each."""
    jsonl = Path(jsonl)
    db = jsonl.with_suffix(".sqlite")
    sig = _signature(jsonl, db)
    hit = _MEMBERS.pop(str(jsonl), None)
    if hit is not None and hit[0] == sig:
        _MEMBERS[str(jsonl)] = hit
        return hit[1]
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
    _MEMBERS[str(jsonl)] = (sig, (values, spans, paths))
    while len(_MEMBERS) > MEMBERS_KEPT:
        _MEMBERS.pop(next(iter(_MEMBERS)))
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
        v = values.get(_canon(ref))
    if v is not None:
        return v
    path, line = _ref_parts(ref)
    if path is None or line is None:
        return None
    return next((value for a, b, value in spans.get(path, ()) if a <= line <= b), None)


_PDF_PAGE = re.compile(r"^(.+\.[Pp][Dd][Ff])#(?:p|page=?)(\d+)$")


def _canon(ref: str) -> str:
    """A record's ref as label rows key it (records.canon): a PDF's `#page=<n>` as `#p<n>`."""
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
                              "n_labeled": None}], columns=["name", "id", "kind", "unit", "values", "n_labeled"])
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
    such as `<db>#<table>/<key>` or `<pdf>#p<n>`): each {label, value, colour} whose value
    the record takes and the analyst highlights, in the labels' order. [] outside a view's reader call."""
    return _marked(_view_ctx, ref)


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
    """{labels, filter}: the labels that are on, each {id, name, colour, values: [{name, colour}]} with its highlighted
    values, and the filter {label, value, colour}, or None."""
    return _view_labels(_view_ctx)


def _marked(ctx, ref) -> list:
    if not ctx:
        return []
    ref = str(ref)
    if ctx.get("probe"):
        return [{"label": PROBE_NAME, "value": PROBE_NAME, "colour": PROBE_COLOUR}] if _probed(ref, ctx["probe"]) else []
    out = []
    for k in ctx.get("labels") or []:
        v = _value_of(k, ref)
        hit = next((x for x in k.get("values") or [] if x.get("highlight") and x.get("name") == v), None)
        if hit is not None:
            out.append({"label": k.get("name"), "value": v, "colour": hit.get("colour") or k.get("colour")})
    return out


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
        probe = {"id": PROBE_ID, "name": PROBE_NAME, "colour": PROBE_COLOUR, "values": [{"name": PROBE_NAME, "colour": PROBE_COLOUR}]}
        f = {"label": PROBE_NAME, "value": PROBE_NAME, "colour": PROBE_COLOUR} if ctx.get("filter") else None
        return {"labels": [probe], "filter": f}
    labels = [{"id": k.get("id"), "name": k.get("name"), "colour": k.get("colour"),
               "values": [{"name": v.get("name"), "colour": v.get("colour")} for v in k.get("values") or [] if v.get("highlight")]}
              for k in ctx.get("labels") or []]
    f = ctx.get("filter")
    return {"labels": labels, "filter": {"label": f.get("label"), "value": f.get("value"), "colour": f.get("colour")} if f else None}


def _missing(v) -> bool:
    """Whether a value is None or a missing number (NaN, pandas' NA), which no chart colours."""
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
    """Show a card of the card type `type`, whose records `labels` (label names) mark and colour, with the type's own
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
