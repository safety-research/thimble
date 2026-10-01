"""Records: the parts of a file that thimble labels, cites and marks, and the ref that names each one.

    reader   files                                   one record                                  ref
    lines    JSON Lines, text, and any other file    a line                                      <path>#L<n>
             that reads as text
    json     a .json file that holds one document    an element of an array at its top or one    <path>#/<json pointer>
                                                     level down, else an entry of its object
    csv      .csv and .tsv                           a row after the header line, whose cells    <path>#row=<n>
                                                     may hold line breaks
    sqlite   .db, .sqlite and .sqlite3               a row of a table, by its single primary     <path>#<table>/<key>
                                                     key, else its rowid
    pdf      .pdf                                    a page                                      <path>#page=<n>

`n` counts from 1 in every form, and `#p<n>` reads as `#page=<n>` (canon). A .json file whose lines each hold a value
reads as lines, as does a document larger than JSON_INDEX_MAX_BYTES. Another binary file has no records. A view's reader
may split any other file into records named `<path>#<locator>` in its own notation; labels and marks key those by their
ref as they key these.

A record is {ref, n, record, text, line, end_line}: `n` its place in the file (a line's number for a line), `record` the
value a code label gets, `text` what a model or a regex reads, and `line`..`end_line` the lines of the file it spans when
the file is text, so the File browser opens it there (None for a database row or a PDF page). The byte offsets of a JSON
document's records and of a CSV's rows, and a PDF's page texts, are kept per path while its size and mtime stay the same,
in least-recently-used caches of a bounded size.
"""
from __future__ import annotations

import csv
import json
import mmap
import re
import sqlite3
import threading
from array import array
from collections import OrderedDict
from contextlib import closing
from pathlib import Path
from typing import Any, Iterator

from . import corpus, refs

CHUNK = 500  # lines read per corpus.load_records call
JSON_SNIFF_BYTES = 64 * 1024
JSON_INDEX_MAX_BYTES = 1024 * 1024 * 1024  # a larger .json file reads as lines
POINTER_PARSE_MAX_BYTES = 64 * 1024 * 1024  # a pointer to a value no record holds is looked up in a document this size at most
CACHE_MAX_FILES = 32
CACHE_MAX_BYTES = 256 * 1024 * 1024
PDF_CACHE_MAX = 16
COUNT_BLOCK = 1 << 20

_TOKENS = re.compile(rb'"(?:[^"\\]|\\.)*"|[\[\]{},:]', re.S)
_NON_SPACE = re.compile(rb"\S")
_TABLE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_QUOTE, _COLON, _COMMA = 0x22, 0x3A, 0x2C
_OPEN_A, _CLOSE_A, _OPEN_O, _CLOSE_O = 0x5B, 0x5D, 0x7B, 0x7D


# --------------------------------------------------------------------------- refs


def is_pdf(rel: str) -> bool:
    return rel.lower().endswith(".pdf")


def is_delimited(rel: str) -> bool:
    return rel.lower().endswith((".csv", ".tsv"))


def is_json(rel: str) -> bool:
    return rel.lower().endswith(".json")


def is_database(rel: str) -> bool:
    return rel.endswith(corpus.DB_SUFFIXES)


def canon(ref: str) -> str:
    """The form a record's ref is keyed by: `<pdf>#p<n>` as `<pdf>#page=<n>`; any other ref as it is."""
    ref = str(ref).strip()
    head, sep, frag = ref.partition("#")
    if sep and is_pdf(head):
        m = re.fullmatch(r"(?:p|page=?)(\d+)", frag)
        if m:
            return f"{head}#page={int(m[1])}"
    return ref


def split(ref: str) -> tuple[str, str] | None:
    """(path, fragment) of a ref that names one record of a file: a line, a database row, a page, a JSON pointer, a CSV
    row, or a `<path>#<locator>` a view's reader names; None for a whole file, a range or part of a line, and anything
    that is not a file's."""
    try:
        p = refs.parse_ref(ref)
    except ValueError:
        return None
    if p["kind"] in refs.RECORD_KINDS or (p["kind"] == "path" and p.get("locator")):
        r = canon(refs.format_ref(p))
        return p["path"], r.partition("#")[2]
    return None


REF_MAX = 2000  # characters of a string read as a ref at most


def is_record_ref(ref: str) -> bool:
    return isinstance(ref, str) and "#" in ref and len(ref) <= REF_MAX and split(ref) is not None


def pointer_escape(key: str) -> str:
    return key.replace("~", "~0").replace("/", "~1")


def pointer_parts(pointer: str) -> list[str]:
    """The keys of a JSON pointer (RFC 6901): `/a~1b/0` -> ['a/b', '0']."""
    if not pointer:
        return []
    return [p.replace("~1", "/").replace("~0", "~") for p in pointer[1:].split("/")]


# --------------------------------------------------------------------------- which reader


class _Cache:
    """A least-recently-used map of path -> ((size, mtime_ns), value, nbytes), bounded by entries and bytes."""

    def __init__(self, max_files: int, max_bytes: int) -> None:
        self.max_files, self.max_bytes = max_files, max_bytes
        self.items: "OrderedDict[str, tuple[tuple[int, int], Any, int]]" = OrderedDict()
        self.lock = threading.Lock()

    def get(self, path: Path, key: tuple[int, int]) -> Any:
        with self.lock:
            hit = self.items.get(str(path))
            if hit is None or hit[0] != key:
                return None
            self.items.move_to_end(str(path))
            return hit[1]

    def put(self, path: Path, key: tuple[int, int], value: Any, nbytes: int = 0) -> None:
        with self.lock:
            self.items[str(path)] = (key, value, nbytes)
            self.items.move_to_end(str(path))
            total = sum(x[2] for x in self.items.values())
            while len(self.items) > self.max_files or (total > self.max_bytes and len(self.items) > 1):
                _p, gone = self.items.popitem(last=False)
                total -= gone[2]


_KINDS = _Cache(4096, 1 << 62)        # path -> its reader, for a .json file whose sniff or index decided it
_JSON = _Cache(CACHE_MAX_FILES, CACHE_MAX_BYTES)
_CSV = _Cache(CACHE_MAX_FILES, CACHE_MAX_BYTES)
_PDF = _Cache(PDF_CACHE_MAX, CACHE_MAX_BYTES)
_builds: dict[str, threading.Lock] = {}
_builds_lock = threading.Lock()


def _key(path: Path) -> tuple[int, int]:
    st = path.stat()
    return (st.st_size, st.st_mtime_ns)


def _one_build(path: Path) -> threading.Lock:
    with _builds_lock:
        return _builds.setdefault(str(path), threading.Lock())


def reader_of(path: Path, rel: str) -> str | None:
    """The reader that splits the file at `path` (corpus-relative `rel`) into records, or None for a binary file no
    reader reads."""
    if is_database(rel):
        return "sqlite"
    if is_pdf(rel):
        return "pdf"
    if is_delimited(rel):
        return "csv"
    if is_json(rel) and _json_document(path):
        return "json"
    if corpus.sniff_binary(path):
        return None
    return "lines"


def _json_document(path: Path) -> bool:
    """Whether a .json file holds one document: it opens with `[` or `{`, is not past JSON_INDEX_MAX_BYTES, and its first
    line is not a whole value with more after it (JSON Lines). An index that then finds a second value reads it as lines."""
    try:
        key = _key(path)
    except OSError:
        return False
    hit = _KINDS.get(path, key)
    if hit is not None:
        return hit == "json"
    try:
        with open(path, "rb") as f:
            head = f.read(JSON_SNIFF_BYTES)
    except OSError:
        return False
    body = head.lstrip()
    out = False
    if body[:1] in (b"[", b"{") and key[0] <= JSON_INDEX_MAX_BYTES:
        first, _, rest = body.partition(b"\n")
        try:
            json.loads(first)
        except ValueError:
            out = True
        else:
            out = not rest.strip()
    _KINDS.put(path, key, "json" if out else "lines")
    return out


# --------------------------------------------------------------------------- JSON documents


class _JsonIndex:
    """A JSON document's records: each one's pointer and byte span, and the lines it spans."""

    __slots__ = ("pointers", "starts", "ends", "lines", "end_lines", "at")

    def __init__(self) -> None:
        self.pointers: list[str] = []
        self.starts, self.ends = array("q"), array("q")
        self.lines, self.end_lines = array("q"), array("q")
        self.at: dict[str, int] = {}

    @property
    def nbytes(self) -> int:
        return 40 * len(self.pointers) + sum(len(p) for p in self.pointers)


def _scan_json(mm: Any) -> tuple[int | None, list, dict] | None:
    """The structure of a document: (the opening byte of its top value or None for a scalar, its children as (key,
    start, end), the elements of each child whose value is an array as {child index: [(start, end), ...]}). Spans hold
    the value and the white space around it. None when the bytes hold more than one value or end inside one."""
    stack = bytearray()
    top: int | None = None
    children: list[tuple[Any, int, int]] = []
    arrays: dict[int, list[tuple[int, int]]] = {}
    start1: int | None = None
    key: Any = None
    start2: int | None = None
    in_array: int | None = None

    def filled(a: int, b: int) -> bool:
        return _NON_SPACE.search(mm, a, b) is not None

    def close1(end: int) -> None:
        if start1 is not None and filled(start1, end):
            children.append((len(children) if top == _OPEN_A else key, start1, end))

    def close2(end: int) -> None:
        if in_array is not None and start2 is not None and filled(start2, end):
            arrays[in_array].append((start2, end))

    for m in _TOKENS.finditer(mm):
        a, b = m.span()
        c = mm[a]
        d = len(stack)
        if c == _QUOTE:
            if d == 0:
                return (None, [], {}) if top is None and not filled(b, len(mm)) else None
            if d == 1 and top == _OPEN_O and start1 is None:
                try:
                    key = json.loads(m.group())
                except ValueError:
                    return None
            continue
        if c == _COLON:
            if d == 1 and top == _OPEN_O:
                start1 = b
            continue
        if c == _COMMA:
            if d == 1:
                close1(a)
                start1 = b if top == _OPEN_A else None
            elif d == 2 and in_array is not None and stack[-1] == _OPEN_A:
                close2(a)
                start2 = b
            continue
        if c in (_OPEN_A, _OPEN_O):
            if d == 0:
                if top is not None:
                    return None
                top = c
                if c == _OPEN_A:
                    start1 = b
            elif d == 1 and top == _OPEN_O and c == _OPEN_A and start1 is not None:
                in_array = len(children)
                arrays[in_array] = []
                start2 = b
            stack.append(c)
            continue
        if not stack:
            return None
        opener = stack.pop()
        if (opener == _OPEN_A) != (c == _CLOSE_A):
            return None
        d = len(stack)
        if d == 0:
            close1(a)
            start1 = None
        elif d == 1 and in_array is not None and opener == _OPEN_A:
            close2(a)
            start2 = None
            in_array = None
    if stack:
        return None
    if top is None:
        return (None, [], {}) if not filled(0, len(mm)) or _scalar(mm) else None
    return top, children, arrays


SCALAR_MAX_BYTES = 1024 * 1024  # a document with no array, object or string is read whole to check it up to this size


def _scalar(mm: Any) -> bool:
    if len(mm) > SCALAR_MAX_BYTES:
        return False
    try:
        json.loads(bytes(mm[:]))
        return True
    except ValueError:
        return False


def _line_numbers(path: Path, offsets: list[int]) -> list[int]:
    """The 1-based line of each byte offset of the file, `offsets` sorted."""
    out: list[int] = []
    n = 1
    base = 0
    i = 0
    with open(path, "rb") as f:
        while i < len(offsets):
            buf = f.read(COUNT_BLOCK)
            if not buf:
                break
            pos = 0
            while i < len(offsets) and offsets[i] < base + len(buf):
                at = max(0, offsets[i] - base)
                n += buf.count(b"\n", pos, at)
                pos = at
                out.append(n)
                i += 1
            n += buf.count(b"\n", pos)
            base += len(buf)
    out.extend([n] * (len(offsets) - len(out)))
    return out


def _value_start(mm: Any, a: int, b: int) -> int:
    m = _NON_SPACE.search(mm, a, b)
    return m.start() if m else a


def _value_end(mm: Any, a: int, b: int) -> int:
    end = b
    while end > a and mm[end - 1] in b" \t\r\n":
        end -= 1
    return end


def _build_json(path: Path) -> _JsonIndex | None:
    """The index of a document's records (module note), or None for a file that is not one JSON document."""
    idx = _JsonIndex()
    size = path.stat().st_size
    if size == 0:
        return None
    with open(path, "rb") as f, mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ) as mm:
        found = _scan_json(mm)
        if found is None:
            return None
        top, children, arrays = found
        spans: list[tuple[str, int, int]] = []
        if top == _OPEN_A:
            spans = [(f"/{k}", s, e) for k, s, e in children]
        elif top == _OPEN_O:
            filled = [i for i in range(len(children)) if arrays.get(i)]
            # the arrays of objects when there are any, else every array: a list of tags beside them is no record
            of_objects = [i for i in filled if mm[_value_start(mm, *arrays[i][0])] == _OPEN_O]
            if filled:
                for i in of_objects or filled:
                    k = children[i][0]
                    for j, (s, e) in enumerate(arrays[i]):
                        spans.append((f"/{pointer_escape(str(k))}/{j}", s, e))
            else:
                spans = [(f"/{pointer_escape(str(k))}", s, e) for k, s, e in children]
        bounds = [(p, _value_start(mm, s, e), _value_end(mm, s, e)) for p, s, e in spans]
    marks = sorted({x for _p, s, e in bounds for x in (s, max(s, e - 1))})
    line_at = dict(zip(marks, _line_numbers(path, marks)))
    for i, (p, s, e) in enumerate(bounds):
        idx.pointers.append(p)
        idx.at[p] = i
        idx.starts.append(s)
        idx.ends.append(e)
        idx.lines.append(line_at[s])
        idx.end_lines.append(line_at[max(s, e - 1)])
    return idx


def json_index(path: Path) -> _JsonIndex | None:
    """The file's record index, built once per (size, mtime_ns); None when it is not one document, which then reads as
    lines."""
    key = _key(path)
    hit = _JSON.get(path, key)
    if hit is not None:
        return hit
    with _one_build(path):
        hit = _JSON.get(path, key)
        if hit is not None:
            return hit
        idx = _build_json(path)
        if idx is None:
            _KINDS.put(path, key, "lines")
            return None
        _JSON.put(path, key, idx, idx.nbytes)
        return idx


def _json_value(path: Path, idx: _JsonIndex, i: int) -> Any:
    with open(path, "rb") as f:
        f.seek(idx.starts[i])
        raw = f.read(idx.ends[i] - idx.starts[i])
    try:
        return json.loads(raw.decode("utf-8", "replace"))
    except ValueError:
        return {"_raw": raw.decode("utf-8", "replace")}


def _json_record(path: Path, rel: str, idx: _JsonIndex, i: int) -> dict[str, Any]:
    value = _json_value(path, idx, i)
    return {"ref": f"{rel}#{idx.pointers[i]}", "n": i + 1, "record": value, "text": _blocks_text(value),
            "line": idx.lines[i], "end_line": idx.end_lines[i]}


def _pointer_lookup(path: Path, rel: str, pointer: str, idx: _JsonIndex) -> dict[str, Any] | None:
    """A value the pointer names that is no record of the index: the document read whole (up to POINTER_PARSE_MAX_BYTES),
    with the lines of the record that holds it."""
    if path.stat().st_size > POINTER_PARSE_MAX_BYTES:
        return None
    try:
        value: Any = json.loads(path.read_bytes().decode("utf-8", "replace"))
    except ValueError:
        return None
    for part in pointer_parts(pointer):
        if isinstance(value, dict) and part in value:
            value = value[part]
        elif isinstance(value, list) and part.isdigit() and int(part) < len(value):
            value = value[int(part)]
        else:
            return None
    holder = next((i for i, p in enumerate(idx.pointers) if pointer.startswith(p + "/")), None)
    return {"ref": f"{rel}#{pointer}", "n": None if holder is None else holder + 1, "record": value, "text": _blocks_text(value),
            "line": None if holder is None else idx.lines[holder], "end_line": None if holder is None else idx.end_lines[holder]}


def _blocks_text(value: Any) -> str:
    return "\n\n".join(b["text"] for b in refs.record_blocks(value))


# --------------------------------------------------------------------------- CSV and TSV


class _CsvIndex:
    """A delimited file's header and each row's byte offset and lines."""

    __slots__ = ("header", "offsets", "lines", "end_lines")

    def __init__(self, header: list[str]) -> None:
        self.header = header
        self.offsets, self.lines, self.end_lines = array("q"), array("q"), array("q")

    @property
    def nbytes(self) -> int:
        return 24 * len(self.offsets)


def _dialect(rel: str) -> dict[str, Any]:
    if rel.lower().endswith(".tsv"):
        return {"delimiter": "\t", "quoting": csv.QUOTE_NONE}
    return {"delimiter": ","}


def _columns(cells: list[str]) -> list[str]:
    """Column names from a header line: blank ones as `column <i>`, a repeated one with its number after it, and a byte
    order mark left off."""
    out: list[str] = []
    for i, c in enumerate(cells, 1):
        name = c.replace("\ufeff", "").strip() or f"column {i}"
        base, k = name, 2
        while name in out:
            name, k = f"{base} {k}", k + 1
        out.append(name)
    return out


def _csv_rows(f: Any, rel: str, start: int = 0) -> Iterator[tuple[int, int, int, list[str]]]:
    """(byte offset, first line, last line, cells) of every row from byte `start`, the line numbers counted from that
    point as 1; blank lines are no rows."""
    pos = [start]
    consumed = [0]

    def lines() -> Iterator[str]:
        for raw in f:
            pos[0] += len(raw)
            consumed[0] += 1
            yield corpus.decode_line(raw[:-2] if raw.endswith(b"\r\n") else raw[:-1] if raw.endswith(b"\n") else raw) + "\n"

    f.seek(start)
    reader = csv.reader(lines(), **_dialect(rel))
    while True:
        at, first = pos[0], consumed[0] + 1
        try:
            cells = next(reader)
        except StopIteration:
            return
        except csv.Error:
            cells = []
        if cells:
            yield at, first, consumed[0], cells


def _build_csv(path: Path, rel: str) -> _CsvIndex:
    csv.field_size_limit(1 << 30)
    with open(path, "rb") as f:
        rows = _csv_rows(f, rel)
        head = next(rows, None)
        idx = _CsvIndex(_columns(head[3]) if head else [])
        for at, first, last, _cells in rows:
            idx.offsets.append(at)
            idx.lines.append(first)
            idx.end_lines.append(last)
    return idx


def csv_index(path: Path, rel: str) -> _CsvIndex:
    key = _key(path)
    hit = _CSV.get(path, key)
    if hit is not None:
        return hit
    with _one_build(path):
        hit = _CSV.get(path, key)
        if hit is not None:
            return hit
        idx = _build_csv(path, rel)
        _CSV.put(path, key, idx, idx.nbytes)
        return idx


def _row_record(header: list[str], cells: list[str]) -> dict[str, str]:
    out = {}
    for i, v in enumerate(cells):
        out[header[i] if i < len(header) else f"column {i + 1}"] = v
    return out


def _fields_text(record: dict[str, Any]) -> str:
    return "\n".join(f"{k}: {v if isinstance(v, str) else json.dumps(v, ensure_ascii=False)}" for k, v in record.items())


def _csv_record(path: Path, rel: str, idx: _CsvIndex, i: int) -> dict[str, Any]:
    csv.field_size_limit(1 << 30)
    with open(path, "rb") as f:
        hit = next(_csv_rows(f, rel, idx.offsets[i]), None)
    cells = hit[3] if hit else []
    record = _row_record(idx.header, cells)
    return {"ref": f"{rel}#row={i + 1}", "n": i + 1, "record": record, "text": _fields_text(record),
            "line": idx.lines[i], "end_line": idx.end_lines[i]}


# --------------------------------------------------------------------------- SQLite


def _tables(con: sqlite3.Connection, under: str | None) -> Iterator[tuple[str, str, list[str]]]:
    """(table, the column that keys its rows, its columns) of each table a ref can name: by its single primary key,
    else its rowid; a table with neither is skipped."""
    for t in corpus.table_names(con):
        if not _TABLE.match(t) or (under and t != under):
            continue
        columns, pk = corpus.table_info(con, t)
        if pk is None:
            try:
                con.execute(f'SELECT rowid FROM "{t}" LIMIT 0')
            except sqlite3.Error:
                continue
        yield t, pk or "rowid", columns


def _db_rows(con: sqlite3.Connection, table: str, key: str, columns: list[str], offset: int = 0,
             limit: int = -1) -> Iterator[tuple[Any, dict[str, Any]]]:
    if key == "rowid":
        sql, names = f'SELECT rowid, * FROM "{table}" ORDER BY rowid LIMIT ? OFFSET ?', ["rowid", *columns]
    else:
        sql, names = f'SELECT * FROM "{table}" ORDER BY "{key}" LIMIT ? OFFSET ?', columns
    for row in con.execute(sql, (limit, offset)):
        record = dict(zip(names, (corpus.jsonable(v) for v in row)))
        yield record[key], record


def _db_record(rel: str, table: str, k: Any, record: dict[str, Any], n: int) -> dict[str, Any]:
    return {"ref": f"{rel}#{table}/{k}", "n": n, "record": record, "text": _fields_text(record), "line": None, "end_line": None}


def _db_count(con: sqlite3.Connection, under: str | None) -> int:
    return sum(int(con.execute(f'SELECT COUNT(*) FROM "{t}"').fetchone()[0]) for t, _k, _c in _tables(con, under))


# --------------------------------------------------------------------------- PDF


def pdf_pages(path: Path) -> list[str]:
    """The text of each page of a PDF, empty for a page with no text layer; [] for a PDF that does not open."""
    key = _key(path)
    hit = _PDF.get(path, key)
    if hit is not None:
        return hit
    try:
        from pypdf import PdfReader  # noqa: PLC0415

        pages = [(p.extract_text() or "").strip() for p in PdfReader(str(path)).pages]
    except Exception:  # noqa: BLE001 — a PDF that does not open has no pages
        pages = []
    _PDF.put(path, key, pages, sum(len(p) for p in pages))
    return pages


def _pdf_record(rel: str, pages: list[str], n: int) -> dict[str, Any]:
    return {"ref": f"{rel}#page={n}", "n": n, "record": {"page": n, "text": pages[n - 1]}, "text": pages[n - 1],
            "line": None, "end_line": None}


# --------------------------------------------------------------------------- reading


def _lines(path: Path, rel: str, kind: str, start: int, end: int) -> Iterator[dict[str, Any]]:
    for r in corpus.load_records(path, rel, kind, start, end):
        yield {"ref": f"{rel}#L{r['line']}", "n": r["line"], "record": r["record"],
               "text": "\n\n".join(b["text"] for b in r["blocks"]), "line": r["line"], "end_line": r["line"],
               "blocks": r["blocks"], "meta": r["meta"]}


def iter_records(path: Path, rel: str, kind: str | None = None, under: str | None = None) -> Iterator[dict[str, Any]]:
    """Every record of the file in order (module note). `kind` is the source kind (corpus.source_kind) a line's blocks
    are read by; `under` keeps the records whose fragment is it or lies below it (`prs` keeps the rows of a
    database's table prs, `/messages` the elements of a document's messages)."""
    kind = kind or corpus.source_kind(rel)
    reader = reader_of(path, rel)
    if reader == "json" and json_index(path) is None:
        reader = "lines"
    if reader == "lines":
        total = len(corpus.line_offsets(path))
        for start in range(1, total + 1, CHUNK):
            yield from _lines(path, rel, kind, start, min(total, start + CHUNK - 1))
    elif reader == "json":
        idx = json_index(path)
        for i, p in enumerate(idx.pointers):
            if _under(p, under):
                yield _json_record(path, rel, idx, i)
    elif reader == "csv":
        csv.field_size_limit(1 << 30)
        idx = csv_index(path, rel)
        with open(path, "rb") as f:
            rows = _csv_rows(f, rel)
            next(rows, None)
            for i, (_at, _first, _last, cells) in enumerate(rows):
                if i >= len(idx.offsets):
                    break
                record = _row_record(idx.header, cells)
                yield {"ref": f"{rel}#row={i + 1}", "n": i + 1, "record": record, "text": _fields_text(record),
                       "line": idx.lines[i], "end_line": idx.end_lines[i]}
    elif reader == "sqlite":
        try:
            con = corpus.open_database(path)
        except sqlite3.Error:
            return
        with closing(con):
            n = 0
            for table, key, columns in _tables(con, _table_of(under)):
                for k, record in _db_rows(con, table, key, columns):
                    n += 1
                    yield _db_record(rel, table, k, record, n)
    elif reader == "pdf":
        pages = pdf_pages(path)
        for n in range(1, len(pages) + 1):
            yield _pdf_record(rel, pages, n)


def _under(fragment: str, under: str | None) -> bool:
    if not under:
        return True
    w = under.rstrip("/") or "/"
    return fragment == w or fragment.startswith(w if w.endswith("/") else w + "/")


def _table_of(under: str | None) -> str | None:
    return under.split("/", 1)[0] if under else None


def count(path: Path, rel: str, under: str | None = None) -> int:
    """How many records iter_records gives."""
    reader = reader_of(path, rel)
    if reader == "json" and json_index(path) is None:
        reader = "lines"
    if reader == "lines":
        return corpus.line_count(path)
    if reader == "json":
        idx = json_index(path)
        return len(idx.pointers) if not under else sum(1 for p in idx.pointers if _under(p, under))
    if reader == "csv":
        return len(csv_index(path, rel).offsets)
    if reader == "sqlite":
        try:
            con = corpus.open_database(path)
        except sqlite3.Error:
            return 0
        with closing(con):
            return _db_count(con, _table_of(under))
    if reader == "pdf":
        return len(pdf_pages(path))
    return 0


def records_at(path: Path, rel: str, places: list[int], kind: str | None = None, under: str | None = None) -> list[dict[str, Any]]:
    """The records at these places (1-based, as `n` counts them) in place order; places past the end are left out."""
    want = sorted({int(n) for n in places if int(n) >= 1})
    if not want:
        return []
    kind = kind or corpus.source_kind(rel)
    reader = reader_of(path, rel)
    if reader == "json" and json_index(path) is None:
        reader = "lines"
    if reader == "lines":
        total = len(corpus.line_offsets(path))
        return [r for n in want if n <= total for r in _lines(path, rel, kind, n, n)]
    if reader == "json":
        idx = json_index(path)
        kept = [i for i, p in enumerate(idx.pointers) if _under(p, under)]
        return [_json_record(path, rel, idx, kept[n - 1]) for n in want if n <= len(kept)]
    if reader == "csv":
        idx = csv_index(path, rel)
        return [_csv_record(path, rel, idx, n - 1) for n in want if n <= len(idx.offsets)]
    if reader == "pdf":
        pages = pdf_pages(path)
        return [_pdf_record(rel, pages, n) for n in want if n <= len(pages)]
    if reader == "sqlite":
        out: list[dict[str, Any]] = []
        try:
            con = corpus.open_database(path)
        except sqlite3.Error:
            return out
        with closing(con):
            base = 0
            for table, key, columns in _tables(con, _table_of(under)):
                size = int(con.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0])
                for n in want:
                    if base < n <= base + size:
                        for k, record in _db_rows(con, table, key, columns, n - base - 1, 1):
                            out.append(_db_record(rel, table, k, record, n))
                base += size
        return out
    return []


def read(path: Path, rel: str, fragment: str, kind: str | None = None) -> dict[str, Any] | None:
    """The record `<rel>#<fragment>` names, or None when the file holds no such record. A JSON pointer may name a value
    inside a record too."""
    fragment = canon(f"{rel}#{fragment}").partition("#")[2]
    reader = reader_of(path, rel)
    if reader == "json" and json_index(path) is None:
        reader = "lines"
    if reader == "lines":
        m = re.fullmatch(r"L(\d+)", fragment)
        n = int(m[1]) if m else 0
        if not 1 <= n <= len(corpus.line_offsets(path)):
            return None
        return next(_lines(path, rel, kind or corpus.source_kind(rel), n, n), None)
    if reader == "json":
        if not fragment.startswith("/"):
            return None
        idx = json_index(path)
        i = idx.at.get(fragment)
        return _json_record(path, rel, idx, i) if i is not None else _pointer_lookup(path, rel, fragment, idx)
    if reader == "csv":
        m = re.fullmatch(r"row=(\d+)", fragment)
        idx = csv_index(path, rel)
        n = int(m[1]) if m else 0
        return _csv_record(path, rel, idx, n - 1) if 1 <= n <= len(idx.offsets) else None
    if reader == "pdf":
        m = re.fullmatch(r"page=(\d+)", fragment)
        pages = pdf_pages(path)
        n = int(m[1]) if m else 0
        return _pdf_record(rel, pages, n) if 1 <= n <= len(pages) else None
    if reader == "sqlite":
        table, _, k = fragment.partition("/")
        if not k:
            return None
        try:
            con = corpus.open_database(path)
        except sqlite3.Error:
            return None
        with closing(con):
            for t, key, columns in _tables(con, table):
                names = ["rowid", *columns] if key == "rowid" else columns
                select = "rowid, *" if key == "rowid" else "*"
                try:
                    row = con.execute(f'SELECT {select} FROM "{t}" WHERE "{key}" = ?', (int(k) if k.isdigit() else k,)).fetchone()
                except sqlite3.Error:
                    return None
                if row is not None:
                    return _db_record(rel, t, k, dict(zip(names, (corpus.jsonable(v) for v in row))), None)
        return None
    return None
