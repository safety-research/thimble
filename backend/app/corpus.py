"""Corpora, sources, jsonl/text paging, database (sqlite) browsing and the ref endpoint.

Everything reads raw corpus files lazily. Per-process caches keep a large corpus cheap: a sparse line index per opened
file (LineIndex, in an LRU), so a page seeks to the nearest mark and scans one chunk; each corpus's folder tree by name
(corpus_tree), which a walk reads again only where a folder changed; and a SOURCES_MEMO_S memo of each corpus's source
list. `GET /sources?path=&depth=1` reads only the folder asked for.

A file ending in .db, .sqlite or .sqlite3 is a database (internal kind 'forge'): the /forge/* routes open it read-only
and it is never paged as text. A binary file (sniff_binary) pages as no records. Serving a file or database page records
the analyst's view of it (viewlog.record). The Files view's name, in-file and cross-file searches run here too.

The one write: `PUT /corpora/{c}/source?path=…` replaces an existing .txt / .md / .markdown file atomically, keeping its
line ending and trailing-newline convention.
"""
from __future__ import annotations

import json
import logging
import os
import re
import shutil
import sqlite3
import tempfile
import threading
import time
from array import array
from bisect import bisect_right
from collections import OrderedDict
from contextlib import closing
from pathlib import Path
from typing import Any, Callable, Iterator
from urllib.parse import quote

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from . import config, corpus_tree, hook_auth, refs, viewlog

log = logging.getLogger("thimble.corpus")

router = APIRouter()

PAGE_DEFAULT = 100
PAGE_MAX = 500
AROUND_MAX = 250  # per side, so a page stays within PAGE_MAX-ish
CLIP_MIN = 1000  # the shortest a page's `clip` may cut a string to
ROWS_MAX = 500
QUERY_LIMIT = 1000
KIND_ORDER = {"text": 0, "board": 1, "events": 2, "forge": 3, "prompt": 4, "agent": 5}
EDITABLE_SUFFIXES = (".txt", ".md", ".markdown")  # the files PUT /source may replace; by name, any case


# --------------------------------------------------------------------------- sources


DB_SUFFIXES, SIDE_SUFFIXES, SKIPPED_SUFFIXES = corpus_tree.DB_SUFFIXES, corpus_tree.SIDE_SUFFIXES, corpus_tree.SKIPPED_SUFFIXES


def source_kind(rel: str) -> str:
    """Kind from the basename and parent directory, anywhere in the tree.

    `agents/x.jsonl` and `<run>/agents/x.jsonl` are agents; `board.jsonl` and `events.jsonl` by basename at any
    depth; any name ending in one of DB_SUFFIXES is a database (kind 'forge', forge.db included); anything under a
    `prompts/` dir is a prompt; everything else is text.
    """
    parts = rel.split("/")
    name = parts[-1]
    parent = parts[-2] if len(parts) > 1 else ""
    if parent == "agents" and name.endswith(".jsonl"):
        return "agent"
    if name == "board.jsonl":
        return "board"
    if name == "events.jsonl":
        return "events"
    if name.endswith(DB_SUFFIXES):
        return "forge"
    if parent == "prompts":
        return "prompt"
    return "text"


def source_title(rel: str, kind: str) -> str:
    name = rel.rsplit("/", 1)[-1]
    if kind in ("board", "events"):
        return kind
    if name.endswith(".jsonl"):
        return name[: -len(".jsonl")]
    return name


def run_dir(rel: str) -> str:
    """The run directory of a nested path (`run2-x/agents/a.jsonl` -> `run2-x`); '' for flat paths."""
    parts = rel.split("/")
    depth = 2 if len(parts) > 1 and parts[-2] in ("agents", "prompts") else 1
    return "/".join(parts[:-depth]) if len(parts) > depth else ""


SOURCES_MEMO_S = 30.0  # a corpus's source list is walked at most this often
_SOURCES: dict[tuple[Path, bool], "_Listing"] = {}  # (corpus dir, include_hidden) -> the memoised listing
_sources_lock = threading.Lock()
_sources_walks: dict[tuple[Path, bool], threading.Lock] = {}  # one walk at a time per key; a second caller waits for it


class _Listing:
    """One walk of a corpus: its sources as list_sources returns them, and when the walk ended."""

    __slots__ = ("ts", "sources")

    def __init__(self, ts: float, sources: list[dict[str, Any]]) -> None:
        self.ts = ts
        self.sources = sources


def _is_hidden(rel: str) -> bool:
    return rel.startswith(".") or "/." in rel


def _walk_sources(corpus: Path, include_hidden: bool) -> list[dict[str, Any]]:
    """Every file of the corpus, sorted, from its folder tree (corpus_tree: a folder is read again only when it changed)
    with each file stat'ed for its size. Symlinked files are listed, symlinked directories are not entered; dot names
    are left out unless `include_hidden`."""
    _, paths = corpus_tree.tree(corpus).walk(links=False, hidden=include_hidden, skip=SKIPPED_SUFFIXES)
    base = str(corpus)
    out: list[dict[str, Any]] = []
    for rel in paths:
        try:
            size = os.stat(f"{base}/{rel}").st_size
        except OSError:
            continue
        kind = source_kind(rel)
        rec: dict[str, Any] = {"path": rel, "kind": kind, "size_bytes": size, "title": source_title(rel, kind)}
        if include_hidden and _is_hidden(rel):
            rec["hidden"] = True
        out.append(rec)
    out.sort(key=lambda s: (KIND_ORDER[s["kind"]], s["path"]))
    return out


def _listing(corpus: Path, include_hidden: bool) -> _Listing:
    key = (corpus, include_hidden)
    now = time.monotonic()
    with _sources_lock:
        hit = _SOURCES.get(key)
        if hit is not None and now - hit.ts < SOURCES_MEMO_S:
            return hit
        walk = _sources_walks.setdefault(key, threading.Lock())
    with walk:  # the first caller walks; the others get its result
        with _sources_lock:
            hit = _SOURCES.get(key)
            if hit is not None and time.monotonic() - hit.ts < SOURCES_MEMO_S:
                return hit
        sources = _walk_sources(corpus, include_hidden)
        listing = _Listing(time.monotonic(), sources)  # timed at the walk's end, so a long walk is not stored expired
        with _sources_lock:
            _SOURCES[key] = listing
        return listing


def list_sources(corpus: Path, include_hidden: bool = False) -> list[dict[str, Any]]:
    """The corpus's files as the Files tab lists them. Paths with a dot component are left out unless `include_hidden`,
    which marks them `hidden: True`. Memoised per corpus; callers must not mutate the shared list."""
    return _listing(corpus, include_hidden).sources


def forget_sources(corpus: Path | None = None) -> None:
    """Drop the source-list memo of one corpus (every corpus when None), and have the next walk of its folder tree check
    every folder: a saved file, a working-directory change."""
    with _sources_lock:
        for key in [k for k in _SOURCES if corpus is None or k[0] == corpus]:
            _SOURCES.pop(key, None)
    corpus_tree.forget(corpus)


def folder_listing(corpus: Path, rel: str, include_hidden: bool = False) -> dict[str, Any] | None:
    """`GET /sources?path=<rel>&depth=1`: the folder's own files and subfolders, read from that folder alone. A
    subfolder is a run (`is_run`) when it holds an `agents/` folder or a `manifest.json`. The counts of files at any
    depth (`n_files`, the folder's own and each subfolder's) and a subfolder's `n_folders` are given only where earlier
    walks of the corpus's folder tree know them (corpus_tree.Tree.counts). None for a folder that is not there, or one
    the listing leaves out: under a dot name without `include_hidden`, or reached through a symlinked folder."""
    rel = rel.strip("/")
    hidden_here = _is_hidden(rel) if rel else False
    if hidden_here and not include_hidden:
        return None
    d = f"{corpus}/{rel}" if rel else str(corpus)
    if rel and (os.path.normpath(rel) != rel or os.path.realpath(d) != os.path.join(os.path.realpath(corpus), rel)):
        return None
    try:
        with os.scandir(d) as it:
            entries = list(it)
    except OSError:
        return None
    files: list[dict[str, Any]] = []
    subs: list[tuple[str, str, bool, str]] = []
    for e in entries:
        name = e.name
        hidden = hidden_here or name.startswith(".")
        if hidden and not include_hidden:
            continue
        path = f"{rel}/{name}" if rel else name
        try:
            if e.is_dir(follow_symlinks=False):
                subs.append((name, path, hidden, e.path))
                continue
            if not e.is_file() or name.endswith(SKIPPED_SUFFIXES):
                continue
            size = e.stat().st_size
        except OSError:
            continue
        kind = source_kind(path)
        rec: dict[str, Any] = {"path": path, "kind": kind, "size_bytes": size, "title": source_title(path, kind)}
        if hidden:
            rec["hidden"] = True
        files.append(rec)
    files.sort(key=lambda s: (KIND_ORDER[s["kind"]], s["path"]))
    counts = corpus_tree.tree(corpus).counts(include_hidden)
    folders = []
    for name, path, hidden, full in sorted(subs):
        is_run = os.path.isfile(f"{full}/manifest.json") or os.path.isdir(f"{full}/agents") and not os.path.islink(f"{full}/agents")
        entry: dict[str, Any] = {"path": path, "name": name, "is_run": is_run}
        known = counts.get(path)
        if known is not None:
            entry["n_files"], entry["n_folders"] = known
        if hidden:
            entry["hidden"] = True
        folders.append(entry)
    out: dict[str, Any] = {"path": rel, "files": files, "folders": folders}
    known = counts.get(rel)
    if known is not None:
        out["n_files"] = known[0]
    return out


# --------------------------------------------------------------------------- line access

INDEX_MAX_FILES = 64                 # line indexes kept, least recently used out first
INDEX_MAX_BYTES = 256 * 1024 * 1024  # ... or until their marks add up to this
INDEX_BUF = 8 * 1024 * 1024          # bytes read at a time while marking
_INDEX: "OrderedDict[Path, LineIndex]" = OrderedDict()  # path -> its sparse index; test hooks read `p in _INDEX`
_COUNTS: dict[Path, tuple[tuple[int, int], int]] = {}  # path -> ((size, mtime_ns), line count): filled by line_offsets and remember_line_count
_index_lock = threading.Lock()
_index_builds: dict[Path, threading.Lock] = {}  # one build at a time per file; a second reader waits for it


class LineIndex:
    """The sparse line index of one file: `marks` are (line number, byte offset) for the first line of every chunk
    (every concept_scan.CHUNK_LINES lines or CHUNK_BYTES bytes, as concept_scan.index_file computes), kept as two int64
    arrays. `len()` is the line count; `offset(n)` scans one chunk; `chunk_span(a, b)` gives the byte range holding
    lines a..b."""

    __slots__ = ("key", "size", "lines", "mark_lines", "mark_offsets")

    def __init__(self, key: tuple[int, int], lines: int, mark_lines: array, mark_offsets: array) -> None:
        self.key = key
        self.size = key[0]
        self.lines = lines
        self.mark_lines = mark_lines
        self.mark_offsets = mark_offsets

    def __len__(self) -> int:
        return self.lines

    @property
    def n_marks(self) -> int:
        return len(self.mark_lines)

    @property
    def nbytes(self) -> int:
        return self.mark_lines.itemsize * len(self.mark_lines) + self.mark_offsets.itemsize * len(self.mark_offsets)

    def marks_list(self) -> Iterator[tuple[int, int]]:
        return zip(self.mark_lines, self.mark_offsets)

    def chunk_span(self, start: int, end: int) -> tuple[int, int, int]:
        """(first line of the chunk holding `start`, its byte offset, the byte offset after the chunk holding `end`),
        for 1-based lines start <= end within the file."""
        i = bisect_right(self.mark_lines, start) - 1
        j = bisect_right(self.mark_lines, end)
        stop = self.mark_offsets[j] if j < len(self.mark_offsets) else self.size
        return self.mark_lines[i], self.mark_offsets[i], stop

    def offset(self, path: Path, line_no: int) -> int:
        """Byte offset of line `line_no` (1-based): the chunk's mark, then a scan of the chunk's bytes."""
        if line_no < 1 or line_no > self.lines:
            raise IndexError(line_no)
        first, begin, stop = self.chunk_span(line_no, line_no)
        if line_no == first:
            return begin
        with open(path, "rb") as f:
            f.seek(begin)
            buf = f.read(stop - begin)
        pos = -1
        for _ in range(line_no - first):
            pos = buf.find(b"\n", pos + 1)
            if pos < 0:
                raise IndexError(line_no)
        return begin + pos + 1

    def __getitem__(self, i: int) -> int:
        raise TypeError("a LineIndex holds marks, not every line start: use offset(path, line_no) or read_lines")


def build_index(path: Path) -> LineIndex:
    """One pass over the file: the marks concept_scan.index_file makes and the line count, without a Python step per
    line. Newlines are counted with bytes.count over a window sized from the average line so far; a line longer than the
    window falls to the byte rule."""
    from . import concept_scan  # lazy: concept_scan imports this module

    chunk_lines, chunk_bytes = concept_scan.CHUNK_LINES, concept_scan.CHUNK_BYTES
    st = path.stat()
    size = st.st_size
    mark_lines, mark_offsets = array("q"), array("q")
    n = 0          # lines whose start the scan has passed
    last = 0       # offset of the last mark
    head = 0       # the scan's position: a line start when `pending`
    pending = True
    with open(path, "rb") as f:
        b0 = 0
        buf = f.read(INDEX_BUF)
        while True:
            rel = head - b0
            if rel >= len(buf):
                if not buf:
                    break
                b0 += len(buf)
                buf = f.read(INDEX_BUF)
                rel = 0
                if not buf:
                    break
            if pending and head < size:
                if n == 0 or n % chunk_lines == 0 or head - last >= chunk_bytes:
                    mark_lines.append(n + 1)
                    mark_offsets.append(head)
                    last = head
                pending = False
            k = chunk_lines - n % chunk_lines  # newlines to the next line-rule mark
            target = last + chunk_bytes          # the byte-rule mark: the first line start at or past it
            r_end = max(rel, min(len(buf), target - b0))
            c = 0
            if r_end > rel:
                avg = head / n if n else 128.0
                guess = min(r_end, rel + int(k * avg * 1.05) + 256)
                c = buf.count(b"\n", rel, guess)
                if c >= k:
                    pos = guess
                    for _ in range(c - k + 1):
                        pos = buf.rfind(b"\n", rel, pos)
                    n += k
                    head = b0 + pos + 1
                    pending = True
                    continue
                i = guess
                while c < k:
                    j = buf.find(b"\n", i, r_end)
                    if j < 0:
                        break
                    i = j + 1
                    c += 1
                if c >= k:
                    n += k
                    head = b0 + i
                    pending = True
                    continue
            n += c
            if r_end < len(buf):  # the byte-rule target lies in this buffer
                if r_end > rel and buf[r_end - 1] == 10:
                    head = b0 + r_end
                    pending = True
                    continue
                j = buf.find(b"\n", r_end)
                if j >= 0:
                    n += 1
                    head = b0 + j + 1
                    pending = True
                    continue
                head = b0 + len(buf)
                pending = False
                continue
            head = b0 + len(buf)
            pending = buf.endswith(b"\n")
    if size and not pending:
        n += 1  # a last line without its newline is a line
    return LineIndex((size, st.st_mtime_ns), n, mark_lines, mark_offsets)


def _index_trim() -> None:
    """Least recently used indexes out until INDEX_MAX_FILES and INDEX_MAX_BYTES hold (under _index_lock)."""
    total = sum(idx.nbytes for idx in _INDEX.values())
    while _INDEX and (len(_INDEX) > INDEX_MAX_FILES or total > INDEX_MAX_BYTES):
        _p, gone = _INDEX.popitem(last=False)
        total -= gone.nbytes


def line_offsets(path: Path) -> LineIndex:
    """The file's sparse line index, built on first access and kept in an LRU keyed on (size, mtime_ns) so a changed
    file is indexed again."""
    st = path.stat()
    key = (st.st_size, st.st_mtime_ns)
    with _index_lock:
        hit = _INDEX.get(path)
        if hit is not None and hit.key == key:
            _INDEX.move_to_end(path)
            return hit
        build = _index_builds.setdefault(path, threading.Lock())
    with build:
        with _index_lock:
            hit = _INDEX.get(path)
            if hit is not None and hit.key == key:
                _INDEX.move_to_end(path)
                return hit
        idx = build_index(path)
        with _index_lock:
            _INDEX[path] = idx
            _INDEX.move_to_end(path)
            _COUNTS[path] = (idx.key, idx.lines)
            _index_trim()
            _index_builds.pop(path, None)
        return idx


def forget_index(path: Path) -> None:
    with _index_lock:
        _INDEX.pop(path, None)


def remember_line_count(path: Path, key: tuple[int, int], n: int) -> None:
    """Record a line count another process measured, so line_count answers without reading the file."""
    _COUNTS[path] = (key, n)


def line_count(path: Path) -> int:
    """The number of lines of a file: from the line index or a remembered count when either matches the file's (size,
    mtime), else one counting pass (cached as a count only, so counting many files leaves no index behind)."""
    st = path.stat()
    key = (st.st_size, st.st_mtime_ns)
    with _index_lock:
        hit = _INDEX.get(path)
    if hit is not None and hit.key == key:
        return hit.lines
    known = _COUNTS.get(path)
    if known is not None and known[0] == key:
        return known[1]
    n = 0
    last = b""
    with open(path, "rb") as f:
        for buf in iter(lambda: f.read(1 << 20), b""):
            n += buf.count(b"\n")
            last = buf[-1:]
    if last and last != b"\n":
        n += 1  # a last line without its newline is a line, as line_offsets counts it
    _COUNTS[path] = (key, n)
    return n


def _split_lines(buf: bytes) -> list[bytes]:
    lines = buf.split(b"\n")
    if lines and lines[-1] == b"":
        lines.pop()
    return [ln[:-1] if ln.endswith(b"\r") else ln for ln in lines]


def read_lines(path: Path, start: int, end: int) -> list[bytes]:
    """Raw lines start..end (1-based, inclusive), without terminators; bounds are clamped. Seeks to the chunk holding
    `start` and reads through the chunk holding `end`, never the whole file."""
    idx = line_offsets(path)
    n = len(idx)
    start, end = max(1, start), min(end, n)
    if start > end:
        return []
    first, begin, stop = idx.chunk_span(start, end)
    with open(path, "rb") as f:
        f.seek(begin)
        buf = f.read(stop - begin)
    lines = _split_lines(buf)
    return lines[start - first:end - first + 1]


def record_meta(record: Any, rel: str, kind: str) -> dict[str, Any]:
    if not isinstance(record, dict):
        return {}
    if kind == "agent":
        meta: dict[str, Any] = {"agent": source_title(rel, kind)}
        keys = ("timestamp", "session_id", "type", "subtype")
    elif kind == "board":
        meta, keys = {}, ("author", "created_at", "thread_id", "thread_title")
    elif kind == "events":
        meta, keys = {}, ("ts", "agent", "action")
    else:
        return {}
    meta.update({k: record[k] for k in keys if k in record})
    return meta


def load_records(path: Path, rel: str, kind: str, start: int, end: int) -> list[dict[str, Any]]:
    """Records start..end as {line, record, blocks, meta}. jsonl lines are parsed; text lines become {"text": line}."""
    return records_from_lines(read_lines(path, start, end), rel, kind, start)


def decode_line(raw: bytes) -> str:
    """A line's text: UTF-8, else Windows-1252; the five bytes 1252 leaves undefined become U+FFFD."""
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return raw.decode("cp1252", "replace")


def records_from_lines(lines: list[bytes], rel: str, kind: str, start: int) -> list[dict[str, Any]]:
    """load_records over raw lines already read (the first is line `start`), so scan workers' rows match the Reader's
    records."""
    is_jsonl = kind in ("agent", "board", "events") or rel.endswith(".jsonl")
    out = []
    for line_no, raw in enumerate(lines, start):
        text = decode_line(raw)
        if is_jsonl:
            try:
                record: Any = json.loads(text)
            except ValueError:
                record = {"_raw": text}
        else:
            record = {"text": text}
        out.append({"line": line_no, "record": record, "blocks": refs.record_blocks(record, kind),
                    "meta": record_meta(record, rel, kind)})
    return out


# --------------------------------------------------------------------------- databases (sqlite, read-only)


def connect_ro(db: Path) -> sqlite3.Connection:
    return sqlite3.connect(f"file:{quote(str(db), safe='/')}?mode=ro", uri=True)


def open_database(db: Path) -> sqlite3.Connection:
    """Read-only connection to a sqlite file, checked against the file header up front (sqlite opens lazily, so a
    garbage file would otherwise fail on the first query). Raises sqlite3.Error; an empty file is an empty database."""
    con = connect_ro(db)
    try:
        con.execute("SELECT 1 FROM sqlite_master LIMIT 1").fetchall()
    except sqlite3.Error:
        con.close()
        raise
    return con


def table_names(con: sqlite3.Connection) -> list[str]:
    rows = con.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    return [r[0] for r in rows]


def table_info(con: sqlite3.Connection, table: str) -> tuple[list[str], str | None]:
    """(column names, single primary-key column or None when the table has none / a composite one)."""
    info = con.execute(f'PRAGMA table_info("{table}")').fetchall()
    columns = [r[1] for r in info]
    pks = [r[1] for r in info if r[5]]
    return columns, (pks[0] if len(pks) == 1 else None)


def jsonable(v: Any) -> Any:
    return f"<blob {len(v)} bytes>" if isinstance(v, (bytes, bytearray, memoryview)) else v


def _database(corpus: Path, rel: str = "forge.db") -> sqlite3.Connection:
    """Read-only connection to the database at corpus-relative `rel`. 400 when the path escapes the corpus, is not a
    database by name, or sqlite cannot read it; 404 when missing."""
    try:
        db = config.safe_corpus_path(corpus, rel)
    except ValueError as e:
        raise HTTPException(400, str(e))
    if source_kind(rel) != "forge":
        raise HTTPException(400, f"not a database file (*.db, *.sqlite, *.sqlite3): {rel!r}")
    if not db.is_file():
        raise HTTPException(404, f"corpus has no {rel}")
    try:
        return open_database(db)
    except sqlite3.Error as e:
        raise HTTPException(400, f"{rel!r} is not a readable SQLite database: {e}")


# --------------------------------------------------------------------------- route helpers


PEEK_HEADER = "x-thimble-peek"
_OFF = frozenset({"", "0", "false", "no", "off"})


def _peeking(request: Request | None) -> bool:
    """A read that is not the analyst's view (a screenshot tour, a hover preview): `?peek=1` or an `X-Thimble-Peek: 1`
    header. Without it a source GET counts as the analyst opening the file."""
    if request is None:
        return False
    q = request.query_params.get("peek")
    h = request.headers.get(PEEK_HEADER)
    return (q is not None and q.strip().lower() not in _OFF) or (h is not None and h.strip().lower() not in _OFF)


def _viewed(c: str, rel: str, request: Request | None = None) -> None:
    """Record the analyst's read of `rel` in the view log; never fails the request. Skipped when peeking, and for a
    request without the analyst's cookie (hook_auth.analyst): card code reads through these routes too, and its reads
    are not the analyst's."""
    if _peeking(request) or (request is not None and not hook_auth.analyst(request)):
        return
    try:
        viewlog.record(c, rel, "analyst", viewlog.BROWSER, kind="file")
    except Exception:  # noqa: BLE001 — bookkeeping
        log.exception("view log: could not record %s/%s", c, rel)


def _corpus(name: str) -> Path:
    try:
        return config.corpus_dir(name)
    except ValueError as e:
        raise HTTPException(404, str(e))


def _file(corpus: Path, rel: str) -> Path:
    try:
        p = config.safe_corpus_path(corpus, rel)
    except ValueError as e:
        raise HTTPException(400, str(e))
    if p.is_dir():
        raise HTTPException(400, f"not a file: {rel!r}")
    if not p.is_file():
        raise HTTPException(404, f"no such file: {rel!r}")
    return p


def _clip_value(v: Any, clip: int) -> tuple[Any, int]:
    """(v with every string longer than `clip` characters cut to `clip`, the longest string it cut, 0 when none)."""
    if isinstance(v, str):
        return (v[:clip], len(v)) if len(v) > clip else (v, 0)
    if isinstance(v, dict):
        out, most = {}, 0
        for k, x in v.items():
            out[k], n = _clip_value(x, clip)
            most = max(most, n)
        return out, most
    if isinstance(v, list):
        items = [_clip_value(x, clip) for x in v]
        return [x for x, _ in items], max((n for _, n in items), default=0)
    return v, 0


def clip_records(records: list[dict[str, Any]], clip: int) -> list[dict[str, Any]]:
    """A page's records with every string cut to `clip` characters, since one large record can make a short page
    megabytes. A clipped record carries `clipped` (its longest string's length); `GET /source?start=<line>&count=1`
    reads it whole."""
    out: list[dict[str, Any]] = []
    for rec in records:
        record, a = _clip_value(rec.get("record"), clip)
        blocks, b = _clip_value(rec.get("blocks"), clip)
        most = max(a, b)
        out.append({**rec, "record": record, "blocks": blocks, "clipped": most} if most else rec)
    return out


BINARY_SNIFF = 8192     # bytes of a file's head that decide whether it is binary
BINARY_CONTROL = 0.10   # the share of control bytes past which a head with no NUL still reads as binary
_TEXT_CONTROLS = frozenset(b"\t\n\r\f\v\b\x1b")  # control bytes text holds: whitespace, backspace, a terminal's escape


def sniff_binary(path: Path) -> bool:
    """Whether the file is binary, judged from its first BINARY_SNIFF bytes: a NUL byte, or more than BINARY_CONTROL of
    control bytes other than whitespace and escape."""
    try:
        with open(path, "rb") as f:
            head = f.read(BINARY_SNIFF)
    except OSError:
        return False
    if not head:
        return False
    if b"\0" in head:
        return True
    control = sum(1 for b in head if b < 32 and b not in _TEXT_CONTROLS)
    return control / len(head) > BINARY_CONTROL


def binary_page(p: Path, rel: str, kind: str, start: int) -> dict[str, Any]:
    """The page a binary file answers in place of its bytes: no records, `binary` and the file's size."""
    return {"path": rel, "kind": kind, "total_lines": 0, "start": start, "records": [], "binary": True,
            "size_bytes": p.stat().st_size}


def _page(corpus: Path, rel: str, start: int, end: int, clip: int = 0) -> dict[str, Any]:
    p = _file(corpus, rel)
    kind = source_kind(rel)
    if kind == "forge":  # never page sqlite bytes as text
        raise HTTPException(400, f"{rel!r} is a database file: browse it via the /forge/* routes (path={rel})")
    if rel.endswith(SKIPPED_SUFFIXES):
        raise HTTPException(400, f"{rel!r} is a sqlite side file ({'/'.join(SIDE_SUFFIXES)}) of a database, not text")
    if sniff_binary(p):
        return binary_page(p, rel, kind, start)
    total = len(line_offsets(p))
    records = load_records(p, rel, kind, start, end)
    if clip > 0:
        records = clip_records(records, max(CLIP_MIN, clip))
    return {"path": rel, "kind": kind, "total_lines": total, "start": start, "records": records}


# --------------------------------------------------------------------------- routes


def manifest(c: str) -> dict[str, Any]:
    """The corpus's manifest: a registered corpus's sidecar first, else its manifest.json."""
    return config.corpus_manifest(c)


@router.get("/corpora")
def list_corpora() -> list[dict[str, Any]]:
    """Every corpus: the DATA_DIR directories with a manifest.json, then the registered ones, each as {name, manifest}.
    """
    out = []
    seen: set[str] = set()
    if config.DATA_DIR.is_dir():
        for d in sorted(config.DATA_DIR.iterdir()):
            mf = d / "manifest.json"
            if not d.is_dir() or not mf.is_file() or not re.fullmatch(r"[A-Za-z0-9._-]+", d.name):
                continue
            try:
                manifest_ = json.loads(mf.read_text("utf-8"))
            except ValueError as e:
                manifest_ = {"name": d.name, "error": f"manifest.json unreadable: {e}"}
            out.append({"name": d.name, "manifest": manifest_})
            seen.add(d.name)
    for rec in config.registered_corpora():
        if rec["name"] in seen:
            continue
        out.append({"name": rec["name"], "manifest": rec["manifest"], "path": rec["path"], "registered": True})
    return out


class RegisterBody(BaseModel):
    path: str
    exact: bool = False  # register this folder even inside a registered one


@router.post("/corpora/register", status_code=201)
def register_corpus(body: RegisterBody) -> dict[str, Any]:
    """Register a directory as a corpus: writes the sidecar DATA_DIR/<name>.corpus.json, never into the directory. 400
    for a non-directory. A taken basename gets the next free name (`logs-2`); a path inside a corpus returns that corpus
    unless `exact`."""
    try:
        return config.register_corpus(body.path, exact=body.exact)
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.get("/corpora/{c}/sources")
def get_sources(c: str, include_hidden: int = 0, path: str | None = None, depth: int | None = None) -> Any:
    """The bare route lists every source (`?include_hidden=1` adds dot entries). `?path=<folder>&depth=1` answers that
    folder's entries only, so the Files tree fetches children on expand. 404 for an empty folder; 400 for another depth
    or a path outside the corpus."""
    corpus = _corpus(c)
    if path is None and depth is None:
        return list_sources(corpus, bool(include_hidden))
    if depth is not None and depth != 1:
        raise HTTPException(400, "depth must be 1: the route lists one folder's own entries")
    rel = (path or "").strip().strip("/")
    if rel == ".":
        rel = ""
    try:
        p = config.safe_corpus_path(corpus, rel or ".")
    except ValueError as e:
        raise HTTPException(400, str(e))
    listing = folder_listing(corpus, rel, bool(include_hidden))
    if listing is None:
        if rel and not p.is_dir():
            raise HTTPException(404, f"no such folder: {rel!r}")
        listing = {"path": rel, "files": [], "folders": [], "n_files": 0}
    return listing


@router.get("/corpora/{c}/source")
def get_source(c: str, path: str, request: Request, start: int = 1, count: int = PAGE_DEFAULT, clip: int = 0) -> dict[str, Any]:
    """A page of a file's records; `clip` > 0 cuts every string longer than that many characters (clip_records)."""
    start = max(1, start)
    count = max(0, min(count, PAGE_MAX))
    page = _page(_corpus(c), path, start, start + count - 1, clip)
    _viewed(c, path, request)
    return page


@router.get("/corpora/{c}/source/around")
def get_source_around(c: str, path: str, line: int, request: Request, before: int = 50, after: int = 50,
                      clip: int = 0) -> dict[str, Any]:
    corpus = _corpus(c)
    p = _file(corpus, path)
    if source_kind(path) != "forge" and not path.endswith(SKIPPED_SUFFIXES) and sniff_binary(p):
        _viewed(c, path, request)
        return binary_page(p, path, source_kind(path), 1)
    total = len(line_offsets(p))
    if line < 1 or line > total:
        raise HTTPException(404, f"line {line} out of range ({path} has {total} lines)")
    before = max(0, min(before, AROUND_MAX))
    after = max(0, min(after, AROUND_MAX))
    page = _page(corpus, path, max(1, line - before), line + after, clip)
    _viewed(c, path, request)
    return page


# --------------------------------------------------------------------------- find: files by name, text in a file

FIND_FILES_MAX = 200         # files one name search lists
FIND_LINES_MAX = 5000        # matching lines one search in a file lists; the count goes on past them
FIND_SCAN_S = 20.0           # a search in a file stops after this long and says how far it read
FIND_BUF = 8 * 1024 * 1024   # bytes read at a time while searching
FIND_LONG_LINE = 8 * FIND_BUF  # a line longer than this is searched in pieces (find_lines)
SNIP_BEFORE = 48             # bytes of a matching line a snippet keeps before the match
SNIP_AFTER = 120             # and after it
GREP_FILES_MAX = 100         # files with a match one content search lists; it stops there
GREP_SHOWN = 5               # matching lines listed per file (its count goes on past them)
GREP_SCAN_S = 15.0           # a content search stops after this long and says how far it read
GREP_SKIP = (".pdf", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".tif", ".tiff", ".mp4", ".mov", ".webm",
             ".mkv", ".avi", ".mp3", ".wav", ".m4a", ".ogg", ".flac", ".zip", ".gz", ".tgz", ".tar", ".bz2", ".xz", ".7z",
             ".zst", ".whl", ".parquet", ".feather", ".arrow", ".xlsx", ".xls", ".docx")  # media and packed files: no text lines


def find_files(sources: list[dict[str, Any]], query: str, limit: int = FIND_FILES_MAX) -> tuple[list[dict[str, Any]], int]:
    """The files whose path holds every word of `query` (case-insensitive), best match first, falling back to fuzzy
    in-order letter matches. Returns the first `limit` and how many matched."""
    q = query.strip().lower()
    if not q:
        return [], 0
    words = q.split()
    ranked: list[tuple[int, int, str, dict[str, Any]]] = []
    for s in sources:
        low = s["path"].lower()
        if not all(w in low for w in words):
            continue
        name = low.rsplit("/", 1)[-1]
        rank = 0 if name == q else 1 if name.startswith(q) else 2 if q in name else 3 if all(w in name for w in words) else 4
        ranked.append((rank, len(low), low, s))
    if not ranked:
        letters = re.compile(".*?".join(re.escape(ch) for ch in q.replace(" ", "")))
        for s in sources:
            low = s["path"].lower()
            name = low.rsplit("/", 1)[-1]
            if letters.search(name):
                ranked.append((5, len(low), low, s))
            elif letters.search(low):
                ranked.append((6, len(low), low, s))
    ranked.sort(key=lambda r: r[:3])
    return [r[3] for r in ranked[:limit]], len(ranked)


def find_needles(query: str, jsonl: bool) -> list[bytes]:
    """The byte strings a line holding `query` contains, lowercased: the text in UTF-8 and in Windows-1252 (the two
    encodings decode_line reads), and in a JSON lines file also as JSON writes it inside a string, with its quotes,
    backslashes and control characters escaped and its non-ASCII characters either as written or as \\u escapes."""
    forms = {query}
    if jsonl:
        forms.add(json.dumps(query, ensure_ascii=False)[1:-1])
        forms.add(json.dumps(query)[1:-1])
    out: set[bytes] = set()
    for f in forms:
        if not f:
            continue
        out.add(f.encode("utf-8").lower())
        try:
            out.add(f.encode("cp1252").lower())
        except UnicodeEncodeError:
            pass
    return sorted(out)


def _snippet(piece: bytes, low: bytes, start: int, needles: list[bytes]) -> dict[str, Any]:
    """The part of the line that starts at `start` in `piece` around its first match: {text, hit: [from, to]}, with at
    most SNIP_BEFORE bytes before and SNIP_AFTER after, and an ellipsis where the line goes on."""
    end = low.find(b"\n", start)
    end = len(low) if end < 0 else end
    at, size = end, 0
    for needle in needles:
        pos = low.find(needle, start, end)
        if 0 <= pos < at:
            at, size = pos, len(needle)
    if size == 0:
        at = start
    a, b = max(start, at - SNIP_BEFORE), min(end, at + size + SNIP_AFTER)
    part = lambda raw: raw.decode("utf-8", "ignore").replace("\r", "").replace("\t", " ")  # noqa: E731
    head = ("…" if a > start else "") + part(piece[a:at]).lstrip()
    hit = part(piece[at:at + size])
    tail = part(piece[at + size:b]).rstrip() + ("…" if b < end else "")
    return {"text": head + hit + tail, "hit": [len(head), len(head) + len(hit)]}


def find_lines(path: Path, needles: list[bytes], after: int = 0, limit: int = FIND_LINES_MAX,
               budget_s: float = FIND_SCAN_S, *, snippets: bool = False,
               stop: Callable[[], bool] | None = None) -> dict[str, Any]:
    """The lines past line `after` that hold any of `needles` (compared lowercased): {lines, counts, total, matches,
    complete, scanned} and optionally `snippets`. The file is read in FIND_BUF pieces cut at line ends, each lowercased
    once and searched with bytes.find. A line longer than FIND_LONG_LINE is searched in overlapping pieces, so a file
    with no line ends is never held whole and a match across a cut is found once."""
    start_line = after + 1
    begin = 0
    if after > 0:
        idx = line_offsets(path)
        if after >= len(idx):
            return {"lines": [], "counts": [], "total": 0, "matches": 0, "complete": True, "scanned": len(idx)}
        begin = idx.offset(path, start_line)
    lines: list[int] = []
    counts: list[int] = []
    snips: list[dict[str, Any]] = []
    total = matches = 0
    last_hit = 0          # the last line counted, so a long line split over two pieces counts once
    line_no = start_line  # the line the next piece starts in
    open_line = False     # the last piece read ended inside a line
    complete = True
    deadline = time.monotonic() + budget_s
    carry = b""
    tail = b""            # the end of the last piece, lowercased, while it ended inside a line
    reach = max((len(n) for n in needles), default=1) - 1
    with open(path, "rb") as f:
        f.seek(begin)
        while True:
            buf = f.read(FIND_BUF)
            data = carry + buf
            if buf:
                cut = data.rfind(b"\n")
                if cut < 0 and len(data) < FIND_LONG_LINE:
                    carry = data
                    continue
                cut = len(data) - 1 if cut < 0 else cut
                piece, carry = data[:cut + 1], data[cut + 1:]
            else:
                piece, carry = data, b""
            if piece:
                low = piece.lower()
                starts: dict[int, set[int]] = {}  # the offset in the piece of each line that matches: its matches
                for needle in needles:
                    pos = low.find(needle)
                    while pos >= 0:
                        s = low.rfind(b"\n", 0, pos) + 1
                        end = low.find(b"\n", pos)
                        end = len(low) if end < 0 else end
                        found = starts.setdefault(s, set())
                        while pos >= 0:
                            found.add(pos)
                            pos = low.find(needle, pos + len(needle), end)
                        pos = low.find(needle, end + 1)
                    if tail:
                        # a match across the cut from the last piece: it starts in the tail and ends in this piece
                        joint = tail + low[:reach]
                        pos = joint.find(needle, max(0, len(tail) - len(needle) + 1))
                        while 0 <= pos < len(tail):
                            starts.setdefault(0, set()).add(pos - len(tail))
                            pos = joint.find(needle, pos + len(needle))
                at, n = 0, line_no
                for s in sorted(starts):
                    n += low.count(b"\n", at, s)
                    at = s
                    k = len(starts[s])
                    matches += k
                    if n == last_hit:
                        if lines and lines[-1] == n:
                            counts[-1] += k
                        continue
                    last_hit = n
                    total += 1
                    if len(lines) < limit:
                        lines.append(n)
                        counts.append(k)
                        if snippets:
                            snips.append(_snippet(piece, low, s, needles))
                line_no += low.count(b"\n")
                open_line = not piece.endswith(b"\n")
                tail = low[-reach:] if open_line and reach else b""
            if not buf:
                break
            if time.monotonic() > deadline or (stop is not None and stop()):
                complete = False
                break
    out = {"lines": lines, "counts": counts, "total": total, "matches": matches, "complete": complete,
           "scanned": line_no - (0 if open_line else 1)}
    if snippets:
        out["snippets"] = snips
    return out


@router.get("/corpora/{c}/sources/find")
def find_sources(c: str, q: str = "", limit: int = FIND_FILES_MAX) -> dict[str, Any]:
    """The Files tree's name search: {q, files, total}, over the memoised listing without dot entries."""
    corpus = _corpus(c)
    files, total = find_files(list_sources(corpus), q, max(1, min(limit, FIND_FILES_MAX)))
    return {"q": q, "files": files, "total": total}


# the newest content search per corpus: a search typed further stops the one before it between two pieces of a file
_grep_gen: dict[str, int] = {}
_grep_lock = threading.Lock()


def grep_files(corpus: Path, sources: list[dict[str, Any]], q: str, *, files_max: int = GREP_FILES_MAX,
               shown: int = GREP_SHOWN, budget_s: float = GREP_SCAN_S,
               stop: Callable[[], bool] | None = None) -> Iterator[dict[str, Any]]:
    """The Files search's content half: each file of `sources` whose bytes hold `q` as {path, total, complete, matches},
    then one closing {done: true, ...}. Databases, media, packed and binary files are skipped. Stops after `files_max`
    files, `budget_s` seconds or `stop()`, with `complete` false."""
    deadline = time.monotonic() + budget_s
    files = hits = scanned = 0
    complete = True
    for src in sources:
        if files >= files_max or time.monotonic() > deadline or (stop is not None and stop()):
            complete = False
            break
        path = src["path"]
        scanned += 1
        kind = source_kind(path)
        if kind == "forge" or path.lower().endswith(GREP_SKIP):
            continue
        try:
            p = config.safe_corpus_path(corpus, path)
        except ValueError:
            continue
        if not p.is_file() or sniff_binary(p):
            continue
        jsonl = kind in ("agent", "board", "events") or path.endswith(".jsonl")
        found = find_lines(p, find_needles(q, jsonl), 0, shown, max(0.0, deadline - time.monotonic()), snippets=True, stop=stop)
        if found["total"]:
            files += 1
            hits += found["matches"]
            yield {"path": path, "total": found["matches"], "complete": found["complete"],
                   "matches": [{"line": n, **snip} for n, snip in zip(found["lines"], found["snippets"])]}
        if not found["complete"]:
            complete = False
            break
    yield {"done": True, "files": files, "hits": hits, "scanned": scanned, "of": len(sources), "complete": complete}


@router.get("/corpora/{c}/sources/grep")
def grep_sources(c: str, q: str = "") -> StreamingResponse:
    """Content search over the files the tree lists, streamed as JSON lines, one per matching file and a closing `done`
    line. A newer search of the same corpus stops this one. An empty or multi-line query is 400."""
    corpus = _corpus(c)
    if not q.strip() or "\n" in q:
        raise HTTPException(400, "q must be text on one line")
    with _grep_lock:
        gen = _grep_gen[c] = _grep_gen.get(c, 0) + 1
    sources = list_sources(corpus)

    def lines() -> Iterator[str]:
        for item in grep_files(corpus, sources, q, stop=lambda: _grep_gen.get(c) != gen):
            yield json.dumps(item, ensure_ascii=False) + "\n"

    return StreamingResponse(lines(), media_type="application/x-ndjson")


@router.get("/corpora/{c}/source/find")
def find_in_source(c: str, path: str, q: str, after: int = 0, limit: int = FIND_LINES_MAX) -> dict[str, Any]:
    """The reader's find: the lines of one file past `after` that hold `q`, case-insensitive, searched on the server so
    matches beyond what the reader loaded are found. Binary files answer `binary: true`; a database or empty query is
    400."""
    corpus = _corpus(c)
    p = _file(corpus, path)
    kind = source_kind(path)
    if kind == "forge":
        raise HTTPException(400, f"{path!r} is a database file: query it via the /forge/* routes (path={path})")
    if not q.strip() or "\n" in q:
        raise HTTPException(400, "q must be text on one line")
    if sniff_binary(p):
        return {"path": path, "q": q, "lines": [], "total": 0, "complete": True, "scanned": 0, "total_lines": 0, "binary": True}
    jsonl = kind in ("agent", "board", "events") or path.endswith(".jsonl")
    found = find_lines(p, find_needles(q, jsonl), max(0, after), max(1, min(limit, FIND_LINES_MAX)))
    return {"path": path, "q": q, **found, "total_lines": len(line_offsets(p))}


def is_editable(rel: str) -> bool:
    """Whether PUT /source may replace the file at `rel`: its name ends in one of EDITABLE_SUFFIXES (any case)."""
    return rel.lower().endswith(EDITABLE_SUFFIXES)


def fit_text(text: str, original: bytes) -> bytes:
    """`text` as the bytes to store in place of `original`, keeping its line ending (CRLF when it used any) and its
    trailing-newline convention. An empty original has no convention."""
    text = text.replace("\r\n", "\n")
    nl = "\r\n" if b"\r\n" in original else "\n"
    if original:
        if original.endswith(b"\n"):
            if not text.endswith("\n"):
                text += "\n"
        elif text.endswith("\n"):
            text = text[:-1]
    if nl != "\n":
        text = text.replace("\n", nl)
    return text.encode("utf-8")


def write_text(path: Path, data: bytes) -> None:
    """Replace `path`'s contents atomically: a temp file in the same directory, fsynced, given the original's mode, then
    os.replace. A failure leaves the original as it was and no temp file behind."""
    fd, tmp = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        shutil.copymode(path, tmp)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


class SourceTextBody(BaseModel):
    text: str


@router.put("/corpora/{c}/source")
def put_source(c: str, path: str, body: SourceTextBody) -> dict[str, Any]:
    """Replace a .txt / .md / .markdown file's text. The path goes through config.safe_corpus_path; any other suffix is
    400. Returns the new line count."""
    corpus = _corpus(c)
    if not is_editable(path):
        raise HTTPException(400, f"only {', '.join(EDITABLE_SUFFIXES)} files can be edited: {path!r}")
    p = _file(corpus, path)
    try:
        original = p.read_bytes()
        data = fit_text(body.text, original)
        write_text(p, data)
    except OSError as e:
        raise HTTPException(500, f"could not write {path!r}: {e}")
    forget_index(p)  # the line index is keyed on size+mtime and would refresh itself; dropping it saves the stat
    _COUNTS.pop(p, None)
    forget_sources(corpus)  # the listing carries the file's size
    return {"path": path, "kind": source_kind(path), "total_lines": len(line_offsets(p)), "size_bytes": len(data)}


# /forge/* routes: `path` names any database file under the corpus (default forge.db); the connection is read-only.
@router.get("/corpora/{c}/forge/tables")
def forge_tables(c: str, request: Request, path: str = "forge.db") -> list[dict[str, Any]]:
    with closing(_database(_corpus(c), path)) as con:
        tables = [{"name": t, "row_count": con.execute(f'SELECT COUNT(*) FROM "{t}"').fetchone()[0]}
                  for t in table_names(con)]
    _viewed(c, path, request)
    return tables


@router.get("/corpora/{c}/forge/rows")
def forge_rows(c: str, table: str, request: Request, offset: int = 0, limit: int = 100,
               order: str | None = None, where: str | None = None, path: str = "forge.db") -> dict[str, Any]:
    with closing(_database(_corpus(c), path)) as con:
        if table not in table_names(con):
            raise HTTPException(404, f"no such table: {table!r}")
        columns, pk = table_info(con, table)
        if pk is None:
            pk, select, columns = "rowid", "rowid, *", ["rowid", *columns]
        else:
            select = "*"
        sql = f'SELECT {select} FROM "{table}"'
        count_sql = f'SELECT COUNT(*) FROM "{table}"'
        if where and where.strip():
            if ";" in where:
                raise HTTPException(400, "where must not contain ';'")
            sql += f" WHERE ({where})"
            count_sql += f" WHERE ({where})"
        if order and order.strip():
            m = re.fullmatch(r'\s*"?([A-Za-z_][A-Za-z0-9_]*)"?(?:\s+(asc|desc))?\s*', order, re.I)
            if not m or m[1] not in columns:
                raise HTTPException(400, "order must be a column name, optionally followed by asc|desc")
            sql += f' ORDER BY "{m[1]}" {(m[2] or "").upper()}'
        limit = max(1, min(limit, ROWS_MAX))
        offset = max(0, offset)
        sql += f" LIMIT {limit} OFFSET {offset}"
        try:
            total = con.execute(count_sql).fetchone()[0]
            rows = [[jsonable(v) for v in r] for r in con.execute(sql)]
        except sqlite3.Error as e:
            raise HTTPException(400, f"sqlite: {e}")
    _viewed(c, path, request)
    return {"table": table, "columns": columns, "rows": rows, "pk": pk, "total": total}


class QueryBody(BaseModel):
    sql: str


@router.post("/corpora/{c}/forge/query")
def forge_query(c: str, body: QueryBody, request: Request, path: str = "forge.db") -> dict[str, Any]:
    sql = body.sql.strip().rstrip(";").strip()
    if not sql:
        raise HTTPException(400, "empty sql")
    if ";" in sql:
        raise HTTPException(400, "one statement only: sql must not contain ';'")
    if re.match(r"(pragma|attach)\b", sql, re.I):  # leading keyword only: 'attach' inside a string literal is fine
        raise HTTPException(400, "PRAGMA and ATTACH are not allowed")
    with closing(_database(_corpus(c), path)) as con:
        try:
            cur = con.execute(f"SELECT * FROM ({sql}\n) LIMIT {QUERY_LIMIT + 1}")  # newline: a trailing -- comment must not eat the paren
            rows = cur.fetchall()
            columns = [d[0] for d in cur.description or []]
        except sqlite3.Error as e:
            raise HTTPException(400, f"sqlite: {e}")
    truncated = len(rows) > QUERY_LIMIT
    _viewed(c, path, request)
    return {"columns": columns, "rows": [[jsonable(v) for v in r] for r in rows[:QUERY_LIMIT]], "truncated": truncated}


@router.get("/corpora/{c}/ref")
def get_ref(c: str, ref: str) -> dict[str, Any]:
    try:
        return refs.resolve(_corpus(c), ref)
    except refs.RefError as e:
        raise HTTPException(e.status, e.detail)
