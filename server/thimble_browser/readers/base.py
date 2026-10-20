"""What the readers need of the folder of files: safe paths, a file's kind, its lines read by number, and read-only
database connections. These are the parts of thimble 0.8's corpus.py that its readers used, with a simpler line index.

A file's lines are found through a sparse line index: the byte offset of every MARK_LINES-th line, built in one pass on
first use and kept per file while its size and modification time stay the same. A page of lines seeks to the mark
before its first line and reads on from there, so a page of a large file never reads the whole file.
"""
from __future__ import annotations

import itertools
import re
import sqlite3
import threading
from array import array
from bisect import bisect_right
from collections import OrderedDict
from pathlib import Path
from typing import Any
from urllib.parse import quote

from fastapi import HTTPException

from .. import corpus as folder_files
from . import refs

DB_SUFFIXES = (".db", ".sqlite", ".sqlite3")  # a file so named is a database (kind 'forge')
SIDE_SUFFIXES = ("-wal", "-shm", "-journal")  # sqlite's side files of a database opened read-write elsewhere
SKIPPED_SUFFIXES = tuple(db + side for db in DB_SUFFIXES for side in SIDE_SUFFIXES)
MARK_LINES = 1000  # lines between two marks of a line index
READ_BUF = 8 * 1024 * 1024
INDEX_FILES_MAX = 64  # line indexes kept, least recently used out first
BINARY_SNIFF = 8192  # bytes of a file's head that decide whether it is binary
BINARY_CONTROL = 0.10  # the share of control bytes past which a head with no NUL still reads as binary
_TEXT_CONTROLS = frozenset(b"\t\n\r\f\v\b\x1b")
_NEWLINE = re.compile(b"\n")


# ---- paths

def safe_path(folder: Path, rel: str) -> Path:
    """The path `rel` names in the folder; ValueError for one that leaves it (corpus.inside)."""
    try:
        return folder_files.inside(folder, rel)
    except folder_files.OutsideFolder as e:
        raise ValueError(str(e)) from None


def file_in(folder: Path, rel: str) -> Path:
    """A file of the folder for a route: 400 for a path that leaves the folder or names a folder, 404 for none."""
    try:
        p = safe_path(folder, rel)
    except ValueError as e:
        raise HTTPException(400, str(e)) from None
    if p.is_dir():
        raise HTTPException(400, f"not a file: {rel!r}")
    if not p.is_file():
        raise HTTPException(404, f"no such file: {rel!r}")
    return p


def source_kind(rel: str) -> str:
    return folder_files.kind_of(rel)


def source_title(rel: str, kind: str) -> str:
    name = rel.rsplit("/", 1)[-1]
    if kind in ("board", "events"):
        return kind
    return name[: -len(".jsonl")] if name.endswith(".jsonl") else name


def sniff_binary(path: Path) -> bool:
    """Whether the file is binary, from its first BINARY_SNIFF bytes: a NUL byte, or more than BINARY_CONTROL of control
    bytes other than whitespace and escape."""
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


def decode_line(raw: bytes) -> str:
    """A line's text: UTF-8, else Windows-1252, with the bytes 1252 leaves undefined as U+FFFD."""
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return raw.decode("cp1252", "replace")


# ---- lines

class LineIndex:
    """The marks of one file: line `mark_lines[i]` starts at byte `mark_offsets[i]`. len() is the file's line count."""

    __slots__ = ("key", "lines", "mark_lines", "mark_offsets")

    def __init__(self, key: tuple[int, int], lines: int, mark_lines: array, mark_offsets: array) -> None:
        self.key, self.lines, self.mark_lines, self.mark_offsets = key, lines, mark_lines, mark_offsets

    def __len__(self) -> int:
        return self.lines

    def mark_before(self, line: int) -> tuple[int, int]:
        i = max(0, bisect_right(self.mark_lines, line) - 1)
        return self.mark_lines[i], self.mark_offsets[i]


_INDEX: "OrderedDict[str, LineIndex]" = OrderedDict()
_index_lock = threading.Lock()


def build_index(path: Path) -> LineIndex:
    """One pass over the file: a mark at line 1 and after every MARK_LINES-th newline, and the line count (a last line
    without its newline is a line)."""
    st = path.stat()
    mark_lines, mark_offsets = array("q"), array("q")
    if st.st_size:
        mark_lines.append(1)
        mark_offsets.append(0)
    seen = 0  # newlines before the buffer
    base = 0  # the buffer's offset in the file
    last = b""
    with open(path, "rb") as f:
        for buf in iter(lambda: f.read(READ_BUF), b""):
            skip = MARK_LINES - 1 - seen % MARK_LINES  # newlines of this buffer before the next one that ends a stretch
            for i, m in enumerate(itertools.islice(_NEWLINE.finditer(buf), skip, None, MARK_LINES)):
                n = seen + skip + i * MARK_LINES + 1  # the newline's number in the file
                if base + m.end() < st.st_size:
                    mark_lines.append(n + 1)
                    mark_offsets.append(base + m.end())
            seen += buf.count(b"\n")
            base += len(buf)
            last = buf[-1:]
    lines = seen + (1 if last and last != b"\n" else 0)
    return LineIndex((st.st_size, st.st_mtime_ns), lines, mark_lines, mark_offsets)


def line_offsets(path: Path) -> LineIndex:
    """The file's line index, built on first use and kept while its size and modification time stay the same."""
    st = path.stat()
    key, k = (st.st_size, st.st_mtime_ns), str(path)
    with _index_lock:
        hit = _INDEX.get(k)
        if hit is not None and hit.key == key:
            _INDEX.move_to_end(k)
            return hit
    idx = build_index(path)
    with _index_lock:
        _INDEX[k] = idx
        while len(_INDEX) > INDEX_FILES_MAX:
            _INDEX.popitem(last=False)
    return idx


def line_count(path: Path) -> int:
    return len(line_offsets(path))


def read_lines(path: Path, start: int, end: int) -> list[bytes]:
    """Raw lines start..end (from 1, both included, clamped to the file), without their line ends."""
    idx = line_offsets(path)
    start, end = max(1, start), min(end, len(idx))
    if start > end:
        return []
    mark_line, offset = idx.mark_before(start)
    out: list[bytes] = []
    with open(path, "rb") as f:
        f.seek(offset)
        for _ in range(start - mark_line):
            f.readline()
        for _ in range(end - start + 1):
            raw = f.readline()
            if not raw:
                break
            raw = raw[:-1] if raw.endswith(b"\n") else raw
            out.append(raw[:-1] if raw.endswith(b"\r") else raw)
    return out


def record_meta(record: Any, rel: str, kind: str) -> dict[str, Any]:
    if not isinstance(record, dict):
        return {}
    if kind == "agent":
        meta: dict[str, Any] = {"agent": source_title(rel, kind)}
        keys: tuple[str, ...] = ("timestamp", "session_id", "type", "subtype")
    elif kind == "board":
        meta, keys = {}, ("author", "created_at", "thread_id", "thread_title")
    elif kind == "events":
        meta, keys = {}, ("ts", "agent", "action")
    else:
        return {}
    meta.update({k: record[k] for k in keys if k in record})
    return meta


def is_jsonl(rel: str, kind: str) -> bool:
    return kind in ("agent", "board", "events") or rel.endswith(".jsonl")


def records_from_lines(lines: list[bytes] | list[str], rel: str, kind: str, start: int) -> list[dict[str, Any]]:
    """Lines as the reader's records, the first being line `start`: {line, record, blocks, meta}. A line of JSON lines
    is parsed (`{"_raw": text}` when it is not JSON), any other line is {"text": line}."""
    import json  # noqa: PLC0415

    jsonl = is_jsonl(rel, kind)
    out = []
    for n, raw in enumerate(lines, start):
        text = decode_line(raw) if isinstance(raw, bytes) else raw
        if jsonl:
            try:
                record: Any = json.loads(text)
            except ValueError:
                record = {"_raw": text}
        else:
            record = {"text": text}
        out.append({"line": n, "record": record, "blocks": refs.record_blocks(record, kind),
                    "meta": record_meta(record, rel, kind)})
    return out


def load_records(path: Path, rel: str, kind: str, start: int, end: int) -> list[dict[str, Any]]:
    return records_from_lines(read_lines(path, start, end), rel, kind, start)


# ---- databases, read-only

def connect_ro(db: Path, any_thread: bool = False) -> sqlite3.Connection:
    """A read-only connection: SQLite opens the file with mode=ro, so no statement can change it."""
    return sqlite3.connect(f"file:{quote(str(db), safe='/')}?mode=ro", uri=True, check_same_thread=not any_thread)


def open_database(db: Path, any_thread: bool = False) -> sqlite3.Connection:
    """A read-only connection, checked against the file up front (SQLite opens lazily). sqlite3.Error for a file that
    is no database."""
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
    """(its columns, its one primary key column, None when it has none or several)."""
    info = con.execute(f'PRAGMA table_info("{table}")').fetchall()
    pks = [r[1] for r in info if r[5]]
    return [r[1] for r in info], (pks[0] if len(pks) == 1 else None)


def jsonable(v: Any) -> Any:
    return f"<blob {len(v)} bytes>" if isinstance(v, (bytes, bytearray, memoryview)) else v
