"""The per-file work of a label apply, run in the scan pool concepts.py owns.

A Python loop over gigabytes of records holds the GIL, so the passes that read the corpus run in spawned worker
processes and the server receives only counts and finished JSONL bytes:

- `index_file(path)` counts a file's lines and marks a chunk every CHUNK_LINES lines or CHUNK_BYTES bytes.
- `scan_records(...)` (one chunk of one file) and `scan_group(...)` (every record of an agent or run unit until the
  first match) run the regex over each record's block text and return rows as encoded JSONL plus the same rows as
  dicts. A record's row carries `spans`, the distinct texts matched. With `cover`, a chunk writes rows only for matches,
  after a clear line and a cover line that stand for the negative value.

Nothing here imports concepts, so a worker boots with corpus, refs, config and labels_store alone.
"""
from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

from . import corpus, labels_store

CHUNK_LINES = 4_000            # a scan task covers at most this many records ...
CHUNK_BYTES = 8 * 1024 * 1024  # ... or this many bytes of them, whichever comes first
RATIONALE_MAX = 200            # chars of the first matched text kept as a row's rationale
SPANS_MAX = 16                 # distinct matched texts kept on a record's row


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def row(ref: str, label: str, confidence: float, source: str, rationale: str | None = None, spans: list[str] | None = None) -> dict:
    """One label row: {ref, label, confidence, source, ts, rationale?, spans?}."""
    r: dict[str, Any] = {"ref": ref, "label": label, "confidence": round(float(confidence), 4), "source": source, "ts": now()}
    if rationale:
        r["rationale"] = rationale
    if spans:
        r["spans"] = spans
    return r


def matched_texts(rx: re.Pattern, text: str, cap: int = SPANS_MAX) -> list[str]:
    """The distinct non-empty texts `rx` matches in `text`, in order, at most `cap`. Each is the whole match: the reader
    highlights a span by finding its text in the record, so a cut text would mark only its first part."""
    out: list[str] = []
    for m in rx.finditer(text):
        t = m.group(0)
        if t.strip() and t not in out:
            out.append(t)
            if len(out) >= cap:
                break
    return out


def jsonl_bytes(rows: list[dict]) -> bytes:
    """Rows as the labels file's lines (what the parent appends; the store takes the dicts)."""
    return "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows).encode("utf-8")


_jsonl = jsonl_bytes


def _split_lines(buf: bytes) -> list[bytes]:
    lines = buf.split(b"\n")
    if lines and lines[-1] == b"":
        lines.pop()
    return [ln[:-1] if ln.endswith(b"\r") else ln for ln in lines]


def _text_of(rec: dict) -> str:
    return "\n\n".join(b["text"] for b in rec["blocks"])


# --------------------------------------------------------------------------- tasks


def index_file(path: str) -> dict:
    """One pass over the file (blocking; a worker): {size, mtime_ns, lines, marks, end}. `marks` is [(line_no, byte
    offset)] for the first line of every chunk (line 1 at 0, then every CHUNK_LINES lines or CHUNK_BYTES bytes); `end`
    is the offset after the last line."""
    p = Path(path)
    st = p.stat()
    marks: list[tuple[int, int]] = []
    n = pos = last = 0
    with open(p, "rb") as f:
        for line in f:
            if n == 0 or n % CHUNK_LINES == 0 or pos - last >= CHUNK_BYTES:
                marks.append((n + 1, pos))
                last = pos
            n += 1
            pos += len(line)
    return {"size": st.st_size, "mtime_ns": st.st_mtime_ns, "lines": n, "marks": marks, "end": pos}


def chunks_of(index: dict) -> list[tuple[int, int, int, int]]:
    """The scan tasks an index_file result cuts a file into: [(start_line, n_lines, byte_start, byte_end)]."""
    marks = index["marks"]
    out = []
    for i, (line_no, offset) in enumerate(marks):
        nxt_line, nxt_off = marks[i + 1] if i + 1 < len(marks) else (index["lines"] + 1, index["end"])
        out.append((line_no, nxt_line - line_no, offset, nxt_off))
    return out


def scan_records(path: str, rel: str, kind: str, start_line: int, byte_start: int, byte_end: int, max_units: int | None,
                 pattern: str, pos_label: str, neg_label: str, cover: bool = False) -> dict:
    """Regex over the records of one byte range of a file (blocking; a worker): a row per record, `pos_label` with matched
    texts as rationale and `spans`, else `neg_label`; with `cover`, rows for matches alone after a clear and cover line.
    `max_units` cuts the range short. Returns {units, hits, rows: JSONL bytes, records: the rows as dicts}."""
    rx = re.compile(pattern)
    with open(path, "rb") as f:
        f.seek(byte_start)
        buf = f.read(max(0, byte_end - byte_start))
    lines = _split_lines(buf)
    if max_units is not None:
        lines = lines[:max(0, max_units)]
    rows: list[dict] = []
    hits = units = 0
    last = start_line - 1
    for rec in corpus.records_from_lines(lines, rel, kind, start_line):
        units += 1
        last = rec["line"]
        text = _text_of(rec)
        m = rx.search(text)
        ref = f"{rel}#L{rec['line']}"
        if m:
            hits += 1
            rows.append(row(ref, pos_label, 1.0, "regex", m.group(0)[:RATIONALE_MAX], matched_texts(rx, text)))
        elif not cover:
            rows.append(row(ref, neg_label, 1.0, "regex"))
    if cover and units:
        rows = [labels_store.clear_row(rel, start_line, last),
                labels_store.cover_row(rel, start_line, last, neg_label, "regex", now()), *rows]
    return {"units": units, "hits": hits, "rows": _jsonl(rows), "records": rows}


def _file_records(path: Path, rel: str, kind: str) -> Iterator[dict]:
    """Every record of a file, parsed CHUNK_LINES lines at a time."""
    batch: list[bytes] = []
    start = 1
    with open(path, "rb") as f:
        for raw in f:
            batch.append(raw[:-1] if raw.endswith(b"\n") else raw)
            if len(batch) >= CHUNK_LINES:
                yield from corpus.records_from_lines([ln[:-1] if ln.endswith(b"\r") else ln for ln in batch], rel, kind, start)
                start += len(batch)
                batch = []
    if batch:
        yield from corpus.records_from_lines([ln[:-1] if ln.endswith(b"\r") else ln for ln in batch], rel, kind, start)


def group_texts(path: Path, rel: str, kind: str) -> Iterator[tuple[str, str]]:
    """(ref, text) of each part of a file as an agent or run unit reads it: its lines, a database's rows or a PDF's pages
    (records.py); nothing of another binary file."""
    from . import records  # noqa: PLC0415 — records imports corpus, as this module does

    reader = records.reader_of(path, rel)
    if reader in ("sqlite", "pdf"):
        for r in records.iter_records(path, rel, kind):
            yield r["ref"], r["text"]
    elif reader is not None:
        for rec in _file_records(path, rel, kind):
            yield f"{rel}#L{rec['line']}", _text_of(rec)


def scan_group(corpus_root: str, ref: str, files: list[tuple[str, str]], pattern: str, pos_label: str, neg_label: str) -> dict:
    """An agent or run unit (blocking; a worker): the unit's files' records in order until the first match (group_texts);
    one row for the unit, its rationale `<record ref>: <matched text>`. Returns {units: 1, hits, rows: JSONL bytes,
    records: [the row]}."""
    rx = re.compile(pattern)
    hit: str | None = None
    for rel, kind in files:
        for at, text in group_texts(Path(corpus_root) / rel, rel, kind):
            m = rx.search(text)
            if m:
                hit = f"{at}: {m.group(0)[:RATIONALE_MAX]}"
                break
        if hit is not None:
            break
    r = row(ref, pos_label if hit is not None else neg_label, 1.0, "regex", hit)
    return {"units": 1, "hits": int(hit is not None), "rows": _jsonl([r]), "records": [r]}
