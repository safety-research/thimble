"""File refs, as thimble 0.8 wrote and read them (backend/app/refs.py, its file forms):

    <path>                      a whole file          <path>#L<n>               a line (a record)
    <path>#L<n>-L<m>            a range of lines      <path>#L<n>.b<k>          block k of line n
    <path>#L<n>.b<k>:c<a>-<b>   a span of a block (UTF-16 offsets, as a browser's selection gives them)
    <db>#<table>[/<key>]        a database's table or one of its rows (by its single primary key, else its rowid)
    <pdf>#p<n>                  a PDF's page          <json>#/<pointer>         a JSON document's value
    <csv>#row=<n>               a CSV row             <media>#t=<a>[,<b>]       a moment of a recording

record_blocks() splits a record into the blocks the reader shows: a Claude Code transcript's text, tool_use,
tool_result and thinking blocks, a board's post, an event's parameters, and the raw JSON of any other record. A span's
offsets count in these blocks, so they are the same everywhere.
"""
from __future__ import annotations

import json
import re
import sqlite3
from contextlib import closing
from pathlib import Path
from typing import Any

EXCERPT_MAX = 2000
CONTEXT_RECORDS = 3
RANGE_MAX_RECORDS = 100
PATH_EXCERPT_LINES = 8
QUOTE_LOOSE_MAX_BYTES = 4 * 1024 * 1024  # of text searched with the loose match too, which reads every character

# The files the media routes serve, by suffix: images, audio and video, which an element shows without the page reading
# their bytes. No SVG (its scripts would run if it were opened on its own) and no other type.
MEDIA_TYPES = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
    ".avif": "image/avif", ".bmp": "image/bmp",
    ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4", ".aac": "audio/aac", ".oga": "audio/ogg",
    ".ogg": "audio/ogg", ".opus": "audio/ogg", ".flac": "audio/flac", ".weba": "audio/webm",
    ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm", ".ogv": "video/ogg",
}

# A file's path may hold spaces, never at its ends and never a newline or `#`.
_FP = r"[^#\s](?:[^#\n]*[^#\s])?"
_FP_NO_COLON = r"[^#\s:](?:[^#\n:]*[^#\s:])?"
_FILE_LIKE = re.compile(r"/|\.[A-Za-z0-9]{1,8}$")
_DATABASE = re.compile(r"^(" + _FP + r"\.(?:db|sqlite|sqlite3))#([A-Za-z_][A-Za-z0-9_]*)(?:/(.+))?$")
_PAGE = re.compile(r"^(" + _FP + r"\.[Pp][Dd][Ff])#(?:page=|p)(\d+)$")
_POINTER = re.compile(r"^(" + _FP + r"\.[Jj][Ss][Oo][Nn])#(/[^\n]*)$")
_CSV_ROW = re.compile(r"^(" + _FP + r"\.(?:[Cc][Ss][Vv]|[Tt][Ss][Vv]))#row=(\d+)$")
_SPAN = re.compile(r"^(" + _FP + r")#L(\d+)\.b(\d+):c(\d+)-(\d+)$")
_BLOCK = re.compile(r"^(" + _FP + r")#L(\d+)\.b(\d+)$")
_RANGE = re.compile(r"^(" + _FP + r")#L(\d+)-L(\d+)$")
_RECORD = re.compile(r"^(" + _FP + r")#L(\d+)$")
_PATH = re.compile(r"^(" + _FP_NO_COLON + r")$")
_LOCATOR = re.compile(r"^(" + _FP_NO_COLON + r")#(\S+)$")
_LINE_SHAPED = re.compile(r"^L(?:\d|$)")
_MOMENT = re.compile(r"^t=([0-9:.]+)(?:,([0-9:.]+))?$")

FILE_KINDS = ("record", "range", "block", "span", "path", "table", "row", "page", "pointer", "csvrow")
RECORD_KINDS = ("record", "row", "page", "pointer", "csvrow")  # the kinds that name one record of a file (records.py)


class RefError(Exception):
    """A ref that does not resolve. `status` is the route's answer: 400 malformed, 404 missing."""

    def __init__(self, detail: str, status: int = 404):
        super().__init__(detail)
        self.detail = detail
        self.status = status


# ---- grammar

def parse_ref(ref: str) -> dict[str, Any]:
    """A file ref as a dict with its `kind`. ValueError for anything else."""
    ref = ref.strip()
    if m := _DATABASE.match(ref):
        if m[3]:
            return {"kind": "row", "path": m[1], "table": m[2], "pk": m[3]}
        return {"kind": "table", "path": m[1], "table": m[2]}
    if (m := _PAGE.match(ref)) and int(m[2]) >= 1:
        return {"kind": "page", "path": m[1], "page": int(m[2])}
    if m := _POINTER.match(ref):
        return {"kind": "pointer", "path": m[1], "pointer": m[2]}
    if (m := _CSV_ROW.match(ref)) and int(m[2]) >= 1:
        return {"kind": "csvrow", "path": m[1], "row": int(m[2])}
    if line := _file_line(ref):
        return line
    if (m := _PATH.match(ref)) and (" " not in m[1] or _FILE_LIKE.search(m[1])):
        return {"kind": "path", "path": m[1]}
    if (m := _LOCATOR.match(ref)) and (" " not in m[1] or _FILE_LIKE.search(m[1])):
        if _LINE_SHAPED.match(m[2]):
            raise ValueError(f"not a ref: {ref!r} (a line is <path>#L<n> and a range <path>#L<n>-L<m>)")
        return {"kind": "path", "path": m[1], "locator": m[2]}
    raise ValueError(f"not a ref: {ref!r}")


def _file_line(ref: str) -> dict[str, Any] | None:
    if m := _SPAN.match(ref):
        return {"kind": "span", "path": m[1], "line": int(m[2]), "block": int(m[3]), "start": int(m[4]), "end": int(m[5])}
    if m := _BLOCK.match(ref):
        return {"kind": "block", "path": m[1], "line": int(m[2]), "block": int(m[3])}
    if m := _RANGE.match(ref):
        return {"kind": "range", "path": m[1], "line": int(m[2]), "end_line": int(m[3])}
    if m := _RECORD.match(ref):
        return {"kind": "record", "path": m[1], "line": int(m[2])}
    return None


def format_ref(p: dict[str, Any]) -> str:
    """parse_ref's inverse."""
    k = p["kind"]
    if k == "table":
        return f"{p['path']}#{p['table']}"
    if k == "row":
        return f"{p['path']}#{p['table']}/{p['pk']}"
    if k == "page":
        return f"{p['path']}#p{p['page']}"
    if k == "pointer":
        return f"{p['path']}#{p['pointer']}"
    if k == "csvrow":
        return f"{p['path']}#row={p['row']}"
    if k == "record":
        return f"{p['path']}#L{p['line']}"
    if k == "range":
        return f"{p['path']}#L{p['line']}-L{p['end_line']}"
    if k == "block":
        return f"{p['path']}#L{p['line']}.b{p['block']}"
    if k == "span":
        return f"{p['path']}#L{p['line']}.b{p['block']}:c{p['start']}-{p['end']}"
    if k == "path":
        return p["path"] + (f"#{p['locator']}" if p.get("locator") else "")
    raise ValueError(f"unknown ref kind: {k!r}")


# ---- blocks

def _dumps(obj: Any, indent: int | None = None) -> str:
    return json.dumps(obj, indent=indent, ensure_ascii=False)


def _text(x: Any) -> str:
    if x is None:
        return ""
    return x if isinstance(x, str) else _dumps(x)


def _raw(record: Any) -> dict[str, str]:
    return {"kind": "raw", "text": _dumps(record, indent=2)}


def _content_block(b: Any) -> dict[str, str] | None:
    if not isinstance(b, dict):
        return _raw(b)
    t = b.get("type")
    if t == "text":
        return {"kind": "text", "text": _text(b.get("text"))}
    if t == "tool_use":
        return {"kind": "tool_use", "text": _text(b.get("name")) + "\n" + _dumps(b.get("input"), indent=2)}
    if t == "tool_result":
        c = b.get("content")
        if isinstance(c, list):
            text = "\n".join(_text(x.get("text")) for x in c if isinstance(x, dict) and x.get("type") == "text")
        else:
            text = _text(c)
        return {"kind": "tool_result", "text": text}
    if t == "thinking":
        th = b.get("thinking")
        return {"kind": "thinking", "text": _text(th)} if th else None  # a redacted or empty thinking block: none
    return _raw(b)


_TEXT_KEYS = ("text", "content", "body", "message", "output", "stdout", "result")


def _shape_text(record: dict) -> str:
    """The longest string under a text-like key at the top level or one object down."""
    best = ""
    for k, v in record.items():
        if k in _TEXT_KEYS and isinstance(v, str) and len(v) > len(best):
            best = v
        if isinstance(v, dict):
            for k2, v2 in v.items():
                if k2 in _TEXT_KEYS and isinstance(v2, str) and len(v2) > len(best):
                    best = v2
    return best


def record_blocks(record: Any, kind: str | None = None) -> list[dict[str, str]]:
    """A record as the {kind, text} blocks the reader shows, in order. `kind` is the file's kind (agent, board, events,
    prompt, text) when known, else it is read from the record's shape."""
    if not isinstance(record, dict):
        return [_raw(record)]
    if kind in ("text", "prompt") or (kind is None and set(record) == {"text"}):
        if "text" in record or kind is None:
            return [{"kind": "text", "text": _text(record.get("text"))}]
        if (stream := _stream_blocks(record)) is not None:  # a Claude Code transcript outside an agents/ folder
            return stream
        found = _shape_text(record)  # a .jsonl of plain-text kind whose records are objects: never an empty block
        return [{"kind": "text", "text": found}] if found else [_raw(record)]
    if kind == "board" or (kind is None and "body" in record and "thread_id" in record):
        return [{"kind": "text", "text": _text(record.get("body"))}]
    if kind == "events" or (kind is None and "action" in record and "params" in record):
        if "params" in record:
            return [{"kind": "event", "text": _dumps(record.get("params"))}]
        found = _shape_text(record)
        return [{"kind": "event", "text": found}] if found else [_raw(record)]
    if (stream := _stream_blocks(record)) is not None:
        return stream
    return [_raw(record)]


def _stream_blocks(record: dict) -> list[dict[str, str]] | None:
    """A Claude Code transcript's user or assistant record as its message's blocks; None for any other record."""
    if record.get("type") in ("assistant", "user"):
        msg = record.get("message")
        if isinstance(msg, dict) and "content" in msg:
            content = msg["content"]
            if isinstance(content, str):
                return [{"kind": "text", "text": content}]
            if isinstance(content, list):
                return [blk for blk in map(_content_block, content) if blk is not None]
    return None


def utf16_slice(text: str, start: int, end: int) -> str:
    """`text` cut by UTF-16 code units, the offsets a browser's selection gives; the bounds are clamped."""
    b = text.encode("utf-16-le", "surrogatepass")
    n = len(b) // 2
    start = max(0, min(start, n))
    end = max(start, min(end, n))
    return b[2 * start: 2 * end].decode("utf-16-le", "replace")


def _find_quote(text: str, quote: str) -> tuple[int, int] | None:
    """Where `quote` is in `text`, as [a, b): as written; else as JSON writes it; else with each run of whitespace read
    as one space and case ignored. None when it is not there."""
    q = quote.strip()
    if not q:
        return None
    at = text.find(q)
    if at >= 0:
        return at, at + len(q)
    escaped = json.dumps(q, ensure_ascii=False)[1:-1]
    at = text.find(escaped)
    if at >= 0:
        return at, at + len(escaped)
    kept: list[int] = []
    folded: list[str] = []
    for i, ch in enumerate(text):
        if ch.isspace():
            if folded and folded[-1] != " ":
                folded.append(" ")
                kept.append(i)
            continue
        folded.append(ch.lower()[:1] or ch)
        kept.append(i)
    needle = " ".join(q.split()).lower()
    at = "".join(folded).find(needle)
    if at < 0:
        return None
    return kept[at], kept[at + len(needle) - 1] + 1


def _join_blocks(blocks: list[dict[str, str]]) -> str:
    return "\n\n".join(b["text"] for b in blocks)


# ---- resolve: a file ref as what it points at

def resolve(folder: Path, ref: str) -> dict[str, Any]:
    """{ref, kind, path, line?, record, blocks?, excerpt, meta} of a file ref. RefError: 400 malformed or outside the
    folder, 404 missing."""
    try:
        p = parse_ref(ref)
    except ValueError as e:
        raise RefError(str(e), 400) from None
    kind = p["kind"]
    if kind in ("table", "row"):
        return _resolve_database(folder, p, ref)
    if kind == "page":
        return _resolve_page(folder, p, ref)
    if kind in ("pointer", "csvrow"):
        return _resolve_record(folder, p, ref)
    if kind in ("record", "range", "block", "span"):
        return _resolve_lines(folder, p, ref)
    return _resolve_path(folder, p, ref)


def _locate(folder: Path, rel: str) -> Path:
    from . import base  # noqa: PLC0415 — base imports this module

    try:
        return base.safe_path(folder, rel)
    except ValueError as e:
        raise RefError(str(e), 400) from None


def _seconds(text: str) -> float | None:
    parts = text.split(":")
    if not 1 <= len(parts) <= 3:
        return None
    try:
        nums = [float(x) for x in parts]
    except ValueError:
        return None
    total = 0.0
    for n in nums:
        total = total * 60 + n
    return total


def media_of(rel: str, locator: str | None) -> dict[str, Any] | None:
    """{kind: image, audio or video, type}, with the moment `#t=<a>[,<b>]` names in seconds for a recording; None for a
    file of another type."""
    media_type = MEDIA_TYPES.get(Path(rel).suffix.lower())
    if media_type is None:
        return None
    out: dict[str, Any] = {"kind": media_type.split("/")[0], "type": media_type}
    m = _MOMENT.match(locator or "")
    if m and out["kind"] in ("video", "audio"):
        start = _seconds(m[1])
        end = _seconds(m[2]) if m[2] else None
        if start is not None:
            out["start"] = start
        if end is not None and start is not None and end > start:
            out["end"] = end
    return out


def _clock(sec: float) -> str:
    s = int(sec)
    return f"{s // 3600}:{s % 3600 // 60:02d}:{s % 60:02d}" if s >= 3600 else f"{s // 60}:{s % 60:02d}"


def _media_excerpt(media: dict[str, Any]) -> str:
    if media["kind"] == "image":
        return "(an image)"
    what = "a video" if media["kind"] == "video" else "a recording"
    if "start" in media:
        return f"({what} from {_clock(media['start'])}" + (f" to {_clock(media['end'])})" if "end" in media else ")")
    return f"({what})"


def _resolve_path(folder: Path, p: dict[str, Any], ref: str) -> dict[str, Any]:
    """A whole file: its first lines as the excerpt; a database's tables; a media file's kind and moment; a PDF's page
    text when the locator names a page."""
    from . import base, pdfs  # noqa: PLC0415

    rel = p["path"]
    path = _locate(folder, rel)
    if path.is_dir():
        return {"ref": ref, "kind": "dir", "path": rel, "excerpt": f"folder {rel}", "meta": {}}
    if not path.is_file():
        raise RefError(f"no such file: {rel!r}", 404)
    src_kind = base.source_kind(rel)
    meta: dict[str, Any] = {"kind": src_kind, "size_bytes": path.stat().st_size}
    if src_kind == "forge":
        try:
            with closing(base.connect_ro(path)) as con:
                tables = base.table_names(con)
        except sqlite3.Error:
            tables = []
        meta["tables"] = tables
        excerpt = "database: " + (", ".join(tables) if tables else "(no tables read)")
    elif media := media_of(rel, p.get("locator")):
        meta["media"] = media
        excerpt = _media_excerpt(media)
    elif rel.lower().endswith(".pdf"):
        excerpt, more = pdfs.excerpt(path, p.get("locator"))
        if more.get("missing"):
            raise RefError(f"{p.get('locator')} is past the last page ({rel} has {more['pages']} pages)", 404)
        meta.update(more)
    elif base.sniff_binary(path):
        meta["binary"] = True
        excerpt = "(a binary file, open it in Files)"
    else:
        meta["lines"] = base.line_count(path)
        recs = base.load_records(path, rel, src_kind, 1, PATH_EXCERPT_LINES)
        excerpt = "\n".join(_join_blocks(r["blocks"]) for r in recs)
    out = {"ref": ref, "kind": "path", "path": rel, "line": 1, "record": None, "excerpt": excerpt[:EXCERPT_MAX],
           "meta": meta}
    if p.get("locator"):
        out["locator"] = meta["locator"] = p["locator"]
    return out


def _resolve_lines(folder: Path, p: dict[str, Any], ref: str) -> dict[str, Any]:
    from . import base  # noqa: PLC0415

    rel = p["path"]
    path = _locate(folder, rel)
    if not path.is_file():
        raise RefError(f"no such file: {rel!r}", 404)
    src_kind = base.source_kind(rel)
    if src_kind == "forge":
        raise RefError(f"{rel!r} is a database file: its rows are <path>#<table>/<key>, not lines", 400)
    total = base.line_count(path)
    line = p["line"]
    end_line = p.get("end_line", line)
    if line < 1 or line > total:
        raise RefError(f"line {line} out of range ({rel} has {total} lines)", 404)
    if end_line < line:
        raise RefError(f"range end L{end_line} is before start L{line}", 400)
    end_line = min(end_line, total)
    recs = base.load_records(path, rel, src_kind, line, min(end_line, line + RANGE_MAX_RECORDS - 1))
    first = recs[0]
    out: dict[str, Any] = {"ref": ref, "kind": p["kind"], "path": rel, "line": line, "record": first["record"],
                           "blocks": first["blocks"], "meta": dict(first["meta"])}
    if p["kind"] == "record":
        excerpt = _join_blocks(first["blocks"])
    elif p["kind"] == "range":
        out["end_line"] = end_line
        out["meta"]["end"] = end_line
        out["records"] = recs
        excerpt = "\n\n".join(_join_blocks(r["blocks"]) for r in recs)
    else:
        k = p["block"]
        blocks = first["blocks"]
        if k >= len(blocks):
            raise RefError(f"{rel}#L{line} has {len(blocks)} block(s); b{k} does not exist", 404)
        out["block"] = k
        excerpt = blocks[k]["text"]
        if p["kind"] == "span":
            out["start"], out["end"] = p["start"], p["end"]
            excerpt = utf16_slice(excerpt, p["start"], p["end"])
    out["excerpt"] = excerpt[:EXCERPT_MAX]
    return out


def _resolve_page(folder: Path, p: dict[str, Any], ref: str) -> dict[str, Any]:
    from . import pdfs  # noqa: PLC0415

    rel = p["path"]
    path = _locate(folder, rel)
    if not path.is_file():
        raise RefError(f"no such file: {rel!r}", 404)
    n = int(p["page"])
    excerpt, meta = pdfs.excerpt(path, f"p{n}")
    if meta.get("missing"):
        raise RefError(f"p{n} is past the last page ({rel} has {meta['pages']} pages)", 404)
    got = [] if meta.get("error") else pdfs.page_texts(path, n, n)["pages"]
    text = got[0] if got else ""
    meta["n"] = n
    return {"ref": ref, "kind": "page", "path": rel, "record": {"page": n, "text": text},
            "blocks": [{"kind": "text", "text": text or excerpt}], "excerpt": excerpt[:EXCERPT_MAX], "meta": meta}


def _resolve_record(folder: Path, p: dict[str, Any], ref: str) -> dict[str, Any]:
    """A JSON document's value or a CSV's row (records.read), with its place `n` and the lines it spans in meta."""
    from . import records  # noqa: PLC0415

    rel = p["path"]
    path = _locate(folder, rel)
    if not path.is_file():
        raise RefError(f"no such file: {rel!r}", 404)
    if p["kind"] == "pointer" and (records.reader_of(path, rel) != "json" or records.json_index(path) is None):
        raise RefError(f"{rel!r} does not hold one JSON document, so its records are its lines: <path>#L<n>", 400)
    fragment = format_ref(p).partition("#")[2]
    try:
        rec = records.read(path, rel, fragment)
    except (OSError, ValueError, sqlite3.Error) as e:
        raise RefError(f"{rel!r} could not be read: {e}", 400) from None
    if rec is None:
        raise RefError(f"{rel} has no record #{fragment}", 404)
    kind = p["kind"]
    blocks: list[dict[str, str]] = [] if kind == "csvrow" else record_blocks(rec["record"])
    meta: dict[str, Any] = {k: rec[k] for k in ("n", "line", "end_line") if rec.get(k) is not None}
    excerpt = rec["text"] or _dumps(rec["record"])
    out = {"ref": ref, "kind": kind, "path": rel, "record": rec["record"],
           "blocks": blocks, "excerpt": excerpt[:EXCERPT_MAX], "meta": meta}
    if rec.get("line") is not None:
        out["line"] = rec["line"]
    return out


def _resolve_database(folder: Path, p: dict[str, Any], ref: str) -> dict[str, Any]:
    """`<db>#<table>` or `<db>#<table>/<key>`, read through a read-only connection."""
    from . import base, records  # noqa: PLC0415

    rel = p["path"]
    db = _locate(folder, rel)
    if not db.is_file():
        raise RefError(f"no such file: {rel!r}", 404)
    try:
        con = base.open_database(db)
    except sqlite3.Error as e:
        raise RefError(f"{rel!r} is not a readable SQLite database: {e}", 400) from None
    table = p["table"]
    with closing(con):
        if table not in base.table_names(con):
            raise RefError(f"no such table: {table!r}", 404)
        columns, pk = base.table_info(con, table)
        if p["kind"] == "table":
            n = con.execute(f"SELECT COUNT(*) FROM {records.quote_id(table)}").fetchone()[0]
            record = {"name": table, "row_count": n, "columns": columns, "pk": pk or "rowid"}
            return {"ref": ref, "kind": "table", "path": rel, "table": table, "record": record,
                    "excerpt": f"{table}: {n} rows", "meta": {"table": table}}
        if pk is None:
            select, columns = "rowid, *", ["rowid", *columns]
        else:
            select = "*"
        try:
            row = records.row_by_key(con, table, pk or "rowid", p["pk"], select)
            key = row[columns.index(pk or "rowid")] if row is not None else None
            n = _row_place(con, table, pk, key) if row is not None else None
        except sqlite3.Error as e:
            raise RefError(f"sqlite: {e}", 400) from None
    if row is None:
        raise RefError(f"no row {table}/{p['pk']}", 404)
    record = dict(zip(columns, (base.jsonable(v) for v in row)))
    meta: dict[str, Any] = {"table": table, "pk_column": pk or "rowid"}
    if n is not None:
        meta["n"] = n
    return {"ref": ref, "kind": "row", "path": rel, "table": table, "pk": p["pk"], "record": record,
            "excerpt": json.dumps(record, ensure_ascii=False, separators=(",", ":"))[:EXCERPT_MAX], "meta": meta}


def _row_place(con: sqlite3.Connection, table: str, pk: str | None, key: Any) -> int | None:
    """Where a row stands (from 1) in its table read in storage order, as the Database view pages it."""
    from .records import quote_id  # noqa: PLC0415

    t, col = quote_id(table), "rowid" if pk is None else quote_id(pk)
    try:
        got = con.execute(f"SELECT COUNT(*) FROM {t} WHERE rowid < (SELECT rowid FROM {t} WHERE {col} = ?)",
                          (key,)).fetchone()
    except sqlite3.Error:
        if pk is None:
            return None
        got = con.execute(f"SELECT COUNT(*) FROM {t} WHERE {col} < ?", (key,)).fetchone()
    return int(got[0]) + 1 if got else None
