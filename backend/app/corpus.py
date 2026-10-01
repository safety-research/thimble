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

A big file's line index (INDEX_BIG and up) is built in a background thread and kept on disk in thimble's home, keyed by
path, size and mtime, so a restarted server reads it back. Until it is ready a page is read on from the nearest mark the
build has made (the file's start at once), with the line count estimated (`total_estimated`); `GET /source/lines` says
when it is exact.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import re
import shutil
import sqlite3
import sys
import tempfile
import threading
import time
from array import array
from bisect import bisect_right
from collections import OrderedDict
from contextlib import closing
from pathlib import Path
from typing import Any, AsyncIterator, Callable, Iterator
from urllib.parse import quote

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from . import config, corpus_tree, hook_auth, refs, transcripts, viewlog

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
INDEX_BIG = 32 * 1024 * 1024         # a file this large is indexed in the background, and its index is kept on disk
INDEX_BUILDS = 2                     # background index builds at a time
INDEX_DISK_MAX = 256                 # indexes kept on disk, least recently used out first
INDEX_DIR = "line-index"             # in thimble's home
INDEX_MAGIC = b"thimble line index 1\n"
FORWARD_BUF = 1024 * 1024            # bytes read at a time by a page read before its file's index is ready
FORWARD_SKIP = 16 * 1024 * 1024      # ... and the most it reads past the nearest mark before its first line
_INDEX: "OrderedDict[Path, LineIndex]" = OrderedDict()  # path -> its sparse index; test hooks read `p in _INDEX`
_COUNTS: dict[Path, tuple[tuple[int, int], int]] = {}  # path -> ((size, mtime_ns), line count): filled by line_offsets and remember_line_count
_index_lock = threading.Lock()
_index_builds: dict[Path, threading.Lock] = {}  # one build at a time per file; a second reader waits for it
_builds: dict[Path, "_Build"] = {}  # a big file's index being built in the background
_build_slots = threading.BoundedSemaphore(INDEX_BUILDS)


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


Progress = Callable[[array, array, int, int], None]


def build_index(path: Path, progress: Progress | None = None) -> LineIndex:
    """One pass over the file: the marks concept_scan.index_file makes and the line count, without a Python step per
    line. Newlines are counted with bytes.count over a window sized from the average line so far; a line longer than the
    window falls to the byte rule. `progress(mark_lines, mark_offsets, lines, bytes)` is called after each buffer with
    the marks so far and the lines and bytes the scan has passed."""
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
                if progress is not None:
                    progress(mark_lines, mark_offsets, n, b0)
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


class _Build:
    """A big file's line index being built in a background thread. Until it is done, the marks the scan has made so far
    (`n_marks` of them) and the lines and bytes it has passed are published as it goes, so a page can be read from the
    nearest mark before its first line."""

    __slots__ = ("key", "cond", "mark_lines", "mark_offsets", "n_marks", "lines", "passed", "index", "error")

    def __init__(self, key: tuple[int, int]) -> None:
        self.key = key
        self.cond = threading.Condition()
        self.mark_lines: array = array("q")
        self.mark_offsets: array = array("q")
        self.n_marks = 0
        self.lines = 0
        self.passed = 0
        self.index: LineIndex | None = None
        self.error: BaseException | None = None

    def progress(self, mark_lines: array, mark_offsets: array, lines: int, passed: int) -> None:
        with self.cond:
            self.mark_lines, self.mark_offsets = mark_lines, mark_offsets
            self.n_marks = len(mark_lines)
            self.lines, self.passed = lines, passed
            self.cond.notify_all()

    def finish(self, index: LineIndex | None, error: BaseException | None = None) -> None:
        with self.cond:
            self.index, self.error = index, error
            self.cond.notify_all()

    def done(self) -> bool:
        return self.index is not None or self.error is not None

    def mark_before(self, line: int) -> tuple[int, int]:
        """(line, byte offset) of the last published mark at or before `line`; line 1 at byte 0 before the first. Under
        `cond`."""
        i = bisect_right(self.mark_lines, line, 0, self.n_marks) - 1
        return (self.mark_lines[i], self.mark_offsets[i]) if i >= 0 else (1, 0)

    def wait(self) -> LineIndex:
        with self.cond:
            self.cond.wait_for(self.done)
        if self.error is not None:
            raise self.error
        assert self.index is not None
        return self.index


def _index_trim() -> None:
    """Least recently used indexes out until INDEX_MAX_FILES and INDEX_MAX_BYTES hold (under _index_lock)."""
    total = sum(idx.nbytes for idx in _INDEX.values())
    while _INDEX and (len(_INDEX) > INDEX_MAX_FILES or total > INDEX_MAX_BYTES):
        _p, gone = _INDEX.popitem(last=False)
        total -= gone.nbytes


def _keep(path: Path, idx: LineIndex) -> None:
    """The index into the LRU and its count into _COUNTS (under _index_lock)."""
    _INDEX[path] = idx
    _INDEX.move_to_end(path)
    _COUNTS[path] = (idx.key, idx.lines)
    _index_trim()


def _index_home() -> Path:
    return Path(os.environ.get("THIMBLE_HOME") or "~/.thimble").expanduser() / INDEX_DIR


def _index_file(path: Path) -> Path:
    return _index_home() / (hashlib.sha256(os.fsencode(path)).hexdigest()[:32] + ".idx")


def _index_header(path: Path, idx: LineIndex) -> dict[str, Any]:
    from . import concept_scan  # lazy: concept_scan imports this module

    return {"path": str(path), "size": idx.key[0], "mtime_ns": idx.key[1], "lines": idx.lines, "marks": idx.n_marks,
            "chunk": [concept_scan.CHUNK_LINES, concept_scan.CHUNK_BYTES], "order": sys.byteorder}


def save_index(path: Path, idx: LineIndex) -> None:
    """Keep a big file's index on disk in thimble's home, so a restarted server reads it in place of a pass over the
    file; the least recently used past INDEX_DISK_MAX go. Never fails."""
    folder = _index_home()
    tmp = None
    try:
        config.private_dir(folder.parent)
        config.private_dir(folder)
        fd, tmp = tempfile.mkstemp(dir=folder, suffix=".tmp")
        with os.fdopen(fd, "wb") as f:
            f.write(INDEX_MAGIC + json.dumps(_index_header(path, idx)).encode() + b"\n")
            f.write(idx.mark_lines.tobytes())
            f.write(idx.mark_offsets.tobytes())
        os.replace(tmp, _index_file(path))
        tmp = None
        kept = sorted(folder.glob("*.idx"), key=lambda p: p.stat().st_mtime)
        for old in kept[:max(0, len(kept) - INDEX_DISK_MAX)]:
            old.unlink(missing_ok=True)
    except OSError as e:
        log.warning("line index: could not keep the index of %s: %s", path, e)
    finally:
        if tmp is not None:
            Path(tmp).unlink(missing_ok=True)


def load_index(path: Path, key: tuple[int, int]) -> LineIndex | None:
    """The index save_index kept for this file at this (size, mtime_ns), else None."""
    f = _index_file(path)
    try:
        data = f.read_bytes()
    except OSError:
        return None
    try:
        if not data.startswith(INDEX_MAGIC):
            return None
        nl = data.index(b"\n", len(INDEX_MAGIC))
        head = json.loads(data[len(INDEX_MAGIC):nl])
        n = head["marks"]
        body = data[nl + 1:]
        mark_lines, mark_offsets = array("q"), array("q")
        mark_lines.frombytes(body[:8 * n])
        mark_offsets.frombytes(body[8 * n:])
        idx = LineIndex(key, head["lines"], mark_lines, mark_offsets)
        if head != _index_header(path, idx) or len(mark_offsets) != n:
            return None
    except (ValueError, KeyError, TypeError):
        return None
    try:
        os.utime(f)  # recently used
    except OSError:
        pass
    return idx


def _run_build(path: Path, b: _Build) -> None:
    with _build_slots:
        try:
            idx = build_index(path, b.progress)
        except Exception as e:  # noqa: BLE001 — handed to every reader waiting on the build
            with _index_lock:
                if _builds.get(path) is b:
                    del _builds[path]
            b.finish(None, e)
            return
    with _index_lock:
        if _builds.get(path) in (b, None):
            _keep(path, idx)
        if _builds.get(path) is b:
            del _builds[path]
    save_index(path, idx)
    b.finish(idx)


def _big_index(path: Path, key: tuple[int, int]) -> "LineIndex | _Build":
    """A big file's index from memory or disk, else its background build (started now when none runs)."""
    with _index_lock:
        hit = _INDEX.get(path)
        if hit is not None and hit.key == key:
            _INDEX.move_to_end(path)
            return hit
        b = _builds.get(path)
        if b is not None and b.key == key:
            return b
    idx = load_index(path, key)
    with _index_lock:
        if idx is not None:
            _keep(path, idx)
            return idx
        b = _builds.get(path)
        if b is not None and b.key == key:
            return b
        b = _builds[path] = _Build(key)
    threading.Thread(target=_run_build, args=(path, b), name="line-index", daemon=True).start()
    return b


def line_offsets(path: Path) -> LineIndex:
    """The file's sparse line index, built on first access and kept in an LRU keyed on (size, mtime_ns) so a changed
    file is indexed again. A big file's (INDEX_BIG) is built in the background and kept on disk; this waits for it."""
    st = path.stat()
    key = (st.st_size, st.st_mtime_ns)
    if st.st_size >= INDEX_BIG:
        got = _big_index(path, key)
        return got if isinstance(got, LineIndex) else got.wait()
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
            _keep(path, idx)
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
    mtime); a big file's from its line index (built once, in the background, and shared with the pages read meanwhile);
    else one counting pass (cached as a count only, so counting many files leaves no index behind)."""
    st = path.stat()
    key = (st.st_size, st.st_mtime_ns)
    with _index_lock:
        hit = _INDEX.get(path)
    if hit is not None and hit.key == key:
        return hit.lines
    known = _COUNTS.get(path)
    if known is not None and known[0] == key:
        return known[1]
    if st.st_size >= INDEX_BIG:
        return len(line_offsets(path))
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


def _index_lines(idx: LineIndex, path: Path, start: int, end: int) -> list[bytes]:
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


def read_lines(path: Path, start: int, end: int) -> list[bytes]:
    """Raw lines start..end (1-based, inclusive), without terminators; bounds are clamped. Seeks to the chunk holding
    `start` and reads through the chunk holding `end`, never the whole file."""
    return _index_lines(line_offsets(path), path, start, end)


def _read_on(path: Path, size: int, mark: tuple[int, int], start: int, end: int,
             skip_max: int | None) -> tuple[list[bytes], int, int, int | None] | None:
    """Lines start..end read on from a line start (`mark`: line, byte offset; its line <= start). Returns (those lines,
    the bytes and the whole lines read from the mark, the file's line count when the read reached its end, else None);
    None when more than `skip_max` bytes lie between the mark and line `start`."""
    mark_line, mark_off = mark
    want = end - mark_line + 1  # lines through line `end`
    skip = start - mark_line    # of them, the lines before `start`
    data = bytearray()
    found = 0
    with open(path, "rb") as f:
        f.seek(mark_off)
        while found < want:
            buf = f.read(FORWARD_BUF)
            if not buf:
                break
            data += buf
            found += buf.count(b"\n")
            if skip_max is not None and found < skip and len(data) > skip_max:
                return None
    parts = bytes(data).split(b"\n", want)
    if len(parts) > want or (parts and parts[-1] == b""):  # the bytes after line `end`, or after the last newline
        parts.pop()
    total = None
    if mark_off + len(data) >= size:  # the read reached the file's end
        total = mark_line - 1 + found + (bool(data) and not data.endswith(b"\n"))
    lines = [ln[:-1] if ln.endswith(b"\r") else ln for ln in parts[skip:]]
    return lines, data.rfind(b"\n") + 1, found, total


def _estimate(size: int, rates: list[tuple[int, int]], at_least: int) -> int:
    """The line count of a file of `size` bytes from the largest (bytes, lines) sample, never under `at_least`."""
    used, lines = max(rates)
    return max(at_least, round(size * lines / used)) if used and lines else at_least


def page_lines(path: Path, start: int, end: int) -> tuple[list[bytes], int, bool]:
    """read_lines for a page, with the file's line count and whether that count is an estimate. A big file whose index
    is not ready is read on from the nearest mark its background build has published (line 1 before the first), so a
    page near its start, or anywhere the build has passed, needs no wait; its count is then estimated from the bytes per
    line read so far."""
    start = max(1, start)
    st = path.stat()
    key = (st.st_size, st.st_mtime_ns)
    got: LineIndex | _Build = line_offsets(path) if st.st_size < INDEX_BIG else _big_index(path, key)
    while isinstance(got, _Build):
        b = got
        with b.cond:
            if b.index is not None:
                got = b.index
                break
            if b.error is not None:
                raise b.error
            mark = b.mark_before(start)
            passed = b.lines >= start
            scan = (b.passed, b.lines)
        read = _read_on(path, st.st_size, mark, start, max(start, end), None if passed else FORWARD_SKIP)
        if read is None:  # the line lies past what the build has passed: wait until it gets there
            with b.cond:
                b.cond.wait_for(lambda: b.done() or b.lines >= start, timeout=1.0)
            continue
        lines, used, n_read, total = read
        lines = lines[:max(0, end - start + 1)]
        if total is not None:
            return lines, total, False
        at_least = max(max(start, end) + 1, mark[0] - 1 + n_read, scan[1] + (scan[0] < st.st_size))
        return lines, _estimate(st.st_size, [scan, (used, n_read)], at_least), True
    return _index_lines(got, path, start, end), len(got), False


def line_total(path: Path) -> tuple[int, bool, float]:
    """(the file's line count, whether it is an estimate, the share of the file indexed so far). A big file whose index
    is not ready gets its count estimated as page_lines does, without waiting."""
    st = path.stat()
    if st.st_size < INDEX_BIG:
        return len(line_offsets(path)), False, 1.0
    got = _big_index(path, (st.st_size, st.st_mtime_ns))
    if isinstance(got, _Build):
        with got.cond:
            idx, error, scan = got.index, got.error, (got.passed, got.lines)
        if error is not None:
            raise error
        if idx is None:
            if not scan[1]:  # the scan has not reported yet: the bytes per line of the file's start
                with open(path, "rb") as f:
                    head = f.read(FORWARD_BUF)
                scan = (head.rfind(b"\n") + 1, head.count(b"\n"))
            return _estimate(st.st_size, [scan], scan[1] + 1), True, round(got.passed / st.st_size, 3)
        got = idx
    return len(got), False, 1.0


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


def connect_ro(db: Path, any_thread: bool = False) -> sqlite3.Connection:
    """A read-only connection; with `any_thread`, one a generator may go on using from another thread, one at a time."""
    return sqlite3.connect(f"file:{quote(str(db), safe='/')}?mode=ro", uri=True, check_same_thread=not any_thread)


def open_database(db: Path, any_thread: bool = False) -> sqlite3.Connection:
    """Read-only connection to a sqlite file, checked against the file header up front (sqlite opens lazily, so a
    garbage file would otherwise fail on the first query). Raises sqlite3.Error; an empty file is an empty database.
    `any_thread` as connect_ro."""
    con = connect_ro(db, any_thread)
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


def _page(corpus: Path, rel: str, start: int, end: int, clip: int = 0,
          around: tuple[int, bool] | None = None) -> dict[str, Any]:
    """A page of lines start..end; `total_estimated` when page_lines estimated the count (a big file whose line index is
    being built). With `around` (line, clamp), the page /source/around answers: 404 when the file has no such line,
    unless `clamp` moves a line past the end to the file's last lines."""
    p = _file(corpus, rel)
    kind = source_kind(rel)
    if kind == "forge":  # never page sqlite bytes as text
        raise HTTPException(400, f"{rel!r} is a database file: browse it via the /forge/* routes (path={rel})")
    if rel.endswith(SKIPPED_SUFFIXES):
        raise HTTPException(400, f"{rel!r} is a sqlite side file ({'/'.join(SIDE_SUFFIXES)}) of a database, not text")
    if sniff_binary(p):
        return binary_page(p, rel, kind, start)
    lines, total, estimated = page_lines(p, start, end)
    if around is not None:
        line, clamp = around
        if line < 1 or (not estimated and line > total):
            if not (clamp and line > total > 0):
                raise HTTPException(404, f"line {line} out of range ({rel} has {total} lines)")
            start, end = max(1, total - (line - start)), total
            lines, total, estimated = page_lines(p, start, end)
    records = records_from_lines(lines, rel, kind, start)
    if clip > 0:
        records = clip_records(records, max(CLIP_MIN, clip))
    page = {"path": rel, "kind": kind, "total_lines": total, "start": start, "records": records}
    if estimated:
        page["total_estimated"] = True
    return transcripts.dress(page, p, rel)


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
        row = {"name": rec["name"], "manifest": rec["manifest"], "path": rec["path"], "registered": True}
        if rec.get("shown"):
            row["shown"] = rec["shown"]
        out.append(row)
    return out


class RegisterBody(BaseModel):
    path: str
    exact: bool = False  # register this folder even inside a registered one
    shown: str | None = None  # the folder as the analyst named it, through a symlink; null clears it, absent keeps it


@router.post("/corpora/register", status_code=201)
def register_corpus(body: RegisterBody) -> dict[str, Any]:
    """Register a directory as a corpus: writes the sidecar DATA_DIR/<name>.corpus.json, never into the directory. 400
    for a non-directory. A taken basename gets the next free name (`logs-2`); a path inside a corpus returns that corpus
    unless `exact`."""
    shown = body.shown if "shown" in body.model_fields_set else config.KEEP_SHOWN
    try:
        return config.register_corpus(body.path, exact=body.exact, shown=shown)
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
                      clip: int = 0, clamp: int = 0) -> dict[str, Any]:
    """The page around one line: 404 for a line the file does not have, unless `clamp`, which answers a line past the
    end with the file's last lines (the reader's own moves, made while its line count is an estimate)."""
    corpus = _corpus(c)
    p = _file(corpus, path)
    if source_kind(path) != "forge" and not path.endswith(SKIPPED_SUFFIXES) and sniff_binary(p):
        _viewed(c, path, request)
        return binary_page(p, path, source_kind(path), 1)
    before = max(0, min(before, AROUND_MAX))
    after = max(0, min(after, AROUND_MAX))
    page = _page(corpus, path, max(1, line - before), line + after, clip, around=(line, bool(clamp)))
    _viewed(c, path, request)
    return page


@router.get("/corpora/{c}/source/lines")
def get_source_lines(c: str, path: str) -> dict[str, Any]:
    """{path, total_lines, estimated, indexed}: a file's line count. While a big file's line index is built in the
    background the count is an estimate and `indexed` the share of the file the build has passed; the reader asks again
    until it is exact."""
    p = _file(_corpus(c), path)
    if source_kind(path) == "forge" or path.endswith(SKIPPED_SUFFIXES) or sniff_binary(p):
        return {"path": path, "total_lines": 0, "estimated": False, "indexed": 1.0}
    total, estimated, indexed = line_total(p)
    return {"path": path, "total_lines": total, "estimated": estimated, "indexed": indexed}


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
GREP_PROGRESS_S = 0.5        # how often a content search says how many files it has read
GREP_SKIP = (".pdf", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".tif", ".tiff", ".mp4", ".mov", ".webm",
             ".mkv", ".avi", ".mp3", ".wav", ".m4a", ".ogg", ".flac", ".zip", ".gz", ".tgz", ".tar", ".bz2", ".xz", ".7z",
             ".zst", ".whl", ".parquet", ".feather", ".arrow", ".xlsx", ".xls", ".docx")  # media and packed files: no text lines


class _SearchPaths:
    """The corpus's files as the Files search reads them, for one version of its folder tree: their corpus-relative
    paths sorted and (made when first asked for) the same in the listing's order, kind first."""

    __slots__ = ("version", "paths", "_ordered")

    def __init__(self, version: int, paths: list[str]) -> None:
        self.version = version
        self.paths = paths
        self._ordered: list[str] | None = None

    @property
    def ordered(self) -> list[str]:
        if self._ordered is None:
            self._ordered = sorted(self.paths, key=lambda rel: (KIND_ORDER[source_kind(rel)], rel))
        return self._ordered


_search_memo: dict[Path, _SearchPaths] = {}


def search_paths(corpus: Path) -> _SearchPaths:
    """The files the Files tree lists, from the corpus's folder tree (corpus_tree) with no file stat'ed, so a search
    over a large corpus costs one pass over its paths; folders read less than SOURCES_MEMO_S ago are taken as read."""
    version, paths = corpus_tree.tree(corpus).walk(links=False, hidden=False, skip=SKIPPED_SUFFIXES, max_age=SOURCES_MEMO_S)
    with _sources_lock:
        hit = _search_memo.get(corpus)
    if hit is not None and hit.version == version and hit.paths is paths:
        return hit
    made = _SearchPaths(version, paths)
    with _sources_lock:
        _search_memo[corpus] = made
    return made


def source_record(corpus: Path, rel: str) -> dict[str, Any] | None:
    """One file as the Files tab lists it ({path, kind, size_bytes, title}), None when it is gone."""
    try:
        size = os.stat(f"{corpus}/{rel}").st_size
    except OSError:
        return None
    kind = source_kind(rel)
    return {"path": rel, "kind": kind, "size_bytes": size, "title": source_title(rel, kind)}


def find_paths(paths: list[str], query: str, limit: int = FIND_FILES_MAX) -> tuple[list[str], int]:
    """The paths that hold every word of `query` (case-insensitive), best match first, falling back to fuzzy in-order
    letter matches. Returns the first `limit` and how many matched."""
    q = query.strip().lower()
    if not q:
        return [], 0
    words = q.split()
    ranked: list[tuple[int, int, str, str]] = []
    for path in paths:
        low = path.lower()
        if not all(w in low for w in words):
            continue
        name = low.rsplit("/", 1)[-1]
        rank = 0 if name == q else 1 if name.startswith(q) else 2 if q in name else 3 if all(w in name for w in words) else 4
        ranked.append((rank, len(low), low, path))
    if not ranked:
        letters = q.replace(" ", "")
        fuzzy = re.compile(".*?".join(re.escape(ch) for ch in letters))
        need = set(letters)
        for path in paths:
            low = path.lower()
            if not need.issubset(low):
                continue
            name = low.rsplit("/", 1)[-1]
            if fuzzy.search(name):
                ranked.append((5, len(low), low, path))
            elif fuzzy.search(low):
                ranked.append((6, len(low), low, path))
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
    """The Files tree's name search: {q, files, total}, over the paths of the corpus's folder tree without dot entries
    (search_paths); only the files it lists are stat'ed."""
    corpus = _corpus(c)
    found, total = find_paths(search_paths(corpus).paths, q, max(1, min(limit, FIND_FILES_MAX)))
    files = [r for r in (source_record(corpus, rel) for rel in found) if r is not None]
    return {"q": q, "files": files, "total": total}


# the newest content search per corpus: a search typed further stops the one before it between two pieces of a file
_grep_gen: dict[str, int] = {}
_grep_lock = threading.Lock()


def grep_files(corpus: Path, paths: list[str], q: str, *, files_max: int = GREP_FILES_MAX,
               shown: int = GREP_SHOWN, stop: Callable[[], bool] | None = None,
               progress_s: float = GREP_PROGRESS_S) -> Iterator[dict[str, Any]]:
    """The Files search's content half: each file of `paths` whose bytes hold `q` as {path, total, complete, matches},
    a {progress: true, scanned, of} line at most every `progress_s` seconds while it reads, then one closing
    {done: true, ...}. Databases, media, packed and binary files are skipped. It has no time limit: it stops after
    `files_max` files or once `stop()` is true, with `complete` false and `scanned` the files it read whole."""
    files = hits = scanned = 0
    complete = True
    told = time.monotonic()
    yield {"progress": True, "scanned": 0, "of": len(paths)}
    for path in paths:
        if files >= files_max or (stop is not None and stop()):
            complete = False
            break
        if time.monotonic() - told >= progress_s:
            told = time.monotonic()
            yield {"progress": True, "scanned": scanned, "of": len(paths)}
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
        found = find_lines(p, find_needles(q, jsonl), 0, shown, float("inf"), snippets=True, stop=stop)
        if found["total"]:
            files += 1
            hits += found["matches"]
            yield {"path": path, "total": found["matches"], "complete": found["complete"],
                   "matches": [{"line": n, **snip} for n, snip in zip(found["lines"], found["snippets"])]}
        if not found["complete"]:
            scanned -= 1  # stopped inside this file: it was not read whole
            complete = False
            break
    yield {"done": True, "files": files, "hits": hits, "scanned": scanned, "of": len(paths), "complete": complete}


@router.get("/corpora/{c}/sources/grep")
async def grep_sources(c: str, q: str = "") -> StreamingResponse:
    """Content search over the files the tree lists, streamed as JSON lines: one per matching file, progress lines,
    and a closing `done` line. The search's id is the X-Search header, which POST /sources/grep/stop takes. It runs in
    a thread of its own and stops when it is asked to, when the browser drops the stream, or when a newer search of the
    same corpus starts. An empty or multi-line query is 400."""
    corpus = _corpus(c)
    if not q.strip() or "\n" in q:
        raise HTTPException(400, "q must be text on one line")
    with _grep_lock:
        gen = _grep_gen[c] = _grep_gen.get(c, 0) + 1
    dropped = threading.Event()
    loop = asyncio.get_running_loop()
    items: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue()

    def run() -> None:
        try:
            paths = search_paths(corpus).ordered
            for item in grep_files(corpus, paths, q, stop=lambda: dropped.is_set() or _grep_gen.get(c) != gen):
                loop.call_soon_threadsafe(items.put_nowait, item)
        except Exception:  # noqa: BLE001
            log.exception("content search of %s failed", c)
        finally:
            loop.call_soon_threadsafe(items.put_nowait, None)

    async def lines() -> AsyncIterator[str]:
        threading.Thread(target=run, name=f"grep:{c}", daemon=True).start()
        try:
            while (item := await items.get()) is not None:
                yield json.dumps(item, ensure_ascii=False) + "\n"
        finally:
            dropped.set()

    return StreamingResponse(lines(), media_type="application/x-ndjson", headers={"X-Search": str(gen)})


class GrepStopBody(BaseModel):
    search: int  # the X-Search header of the search's stream


@router.post("/corpora/{c}/sources/grep/stop")
def stop_grep(c: str, body: GrepStopBody) -> dict[str, bool]:
    """Stop the content search `search` of corpus c if it still runs: its stream ends with its `done` line, which says
    how many files it read. {stopped: false} when that search has ended or a newer one took its place."""
    _corpus(c)
    with _grep_lock:
        stopped = _grep_gen.get(c) == body.search
        if stopped:
            _grep_gen[c] = body.search + 1
    return {"stopped": stopped}


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


CSV_ROWS_SPAN = 5000  # lines one csv-rows request covers at most


@router.get("/corpora/{c}/csv-rows")
def get_csv_rows(c: str, path: str, lines: str) -> dict[str, Any]:
    """`?path=&lines=a-b`: {rows: [[line, n], ...]}, the rows of a CSV or TSV file that start on lines a..b with the
    number each is cited by (`<path>#row=<n>`), so the Table view cites a row whole. 400 for another file."""
    from . import records  # noqa: PLC0415 — records imports this module

    if not records.is_delimited(path):
        raise HTTPException(400, f"not a CSV or TSV file: {path!r}")
    m = re.fullmatch(r"(\d+)-(\d+)", lines.strip())
    if not m or int(m[1]) < 1 or int(m[2]) < int(m[1]):
        raise HTTPException(400, "lines must be a-b, from 1")
    a = int(m[1])
    b = min(int(m[2]), a + CSV_ROWS_SPAN - 1)
    return {"rows": records.row_starts(_file(_corpus(c), path), path, a, b)}


@router.get("/corpora/{c}/ref")
def get_ref(c: str, ref: str) -> dict[str, Any]:
    try:
        return refs.resolve(_corpus(c), ref)
    except refs.RefError as e:
        raise HTTPException(e.status, e.detail)
