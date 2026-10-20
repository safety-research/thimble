"""What a label labels: the units of its scope, each with its ref, its text (what a model or a regex reads) and its
value (what a code label's `label(unit)` gets).

Units over files (globs over the folder, comma-separated):
- record: a line of a text file (`<path>#L<n>`; a JSON lines record is its dict, any other line {"text": line}), a row
  of a CSV file (`<path>#row=<n>`, a dict of its columns, read as one `column: value` line per column), a value of a
  JSON document whose top is a list or a mapping (`<path>#/<key>`);
- agent: a whole file (`<path>`): {path, data, records}, data the parsed JSON document, the JSON lines' records, the
  CSV file's rows or the text;
- run: a folder of files (`<folder>`): {path, paths, records, files}, each file whole by its path.
Units over the canvas: each card but label cards (`card:<id>`). Units over the report: each sentence
(`report:report#<id>`).
"""
from __future__ import annotations

import csv
import fnmatch
import io
import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterator

from .. import canvas, corpus, report

WHOLE_CHARS = 300_000  # characters of a whole file or folder a model reads, and of a unit a regex reads
WHOLE_BYTES = 50_000_000  # a file past this is not read whole
WHOLE_CORPUS = frozenset({"", ".", "*", "**", "**/*", "./*"})


@dataclass
class Unit:
    ref: str
    text: str
    value: Any = None
    line: int | None = None  # the line a unit whose ref names none starts on (a CSV row)
    path: str | None = None
    extra: dict[str, Any] = field(default_factory=dict)


def _files(folder: Path) -> list[str]:
    return [f["path"] for f in corpus.walk(folder)]


def match_paths(folder: Path, patterns: list[str]) -> list[str]:
    """The folder's files the patterns name: a glob (`runs/*.jsonl`, `**/*.csv`), a folder (every file under it) or a
    file. A pattern's place after `#` is left aside."""
    files = _files(folder)
    out: list[str] = []
    for raw in patterns:
        pat = raw.split("#", 1)[0].strip().strip("/")
        if pat.startswith("./"):
            pat = pat[2:]
        if pat in WHOLE_CORPUS:
            hits = files
        else:
            hits = [f for f in files if f == pat or f.startswith(pat + "/") or fnmatch.fnmatchcase(f, pat)
                    or (pat.startswith("**/") and fnmatch.fnmatchcase(f, pat[3:]))]
        out.extend(h for h in hits if h not in out)
    return out


def _decode(raw: bytes) -> str:
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return raw.decode("cp1252", "replace")


def kind_of(rel: str) -> str:
    low = rel.lower()
    if low.endswith(".jsonl") or corpus.kind_of(rel) in ("agent", "board", "events"):
        return "jsonl"
    if low.endswith(".csv"):
        return "csv"
    if low.endswith(".json"):
        return "json"
    return "text"


def _csv_rows(text: str) -> tuple[list[str], list[tuple[int, dict[str, str]]]]:
    """(the header, [(the line a row starts on, its columns)])."""
    reader = csv.reader(io.StringIO(text))
    try:
        header = next(reader)
    except StopIteration:
        return [], []
    rows = []
    start = reader.line_num + 1
    for cells in reader:
        rows.append((start, dict(zip(header, cells))))
        start = reader.line_num + 1
    return header, rows


def record_units(folder: Path, rel: str) -> Iterator[Unit]:
    """The records of one file."""
    p = corpus.inside(folder, rel)
    if not p.is_file() or corpus.is_binary(p):
        return
    kind = kind_of(rel)
    if kind == "csv":
        _, rows = _csv_rows(_decode(p.read_bytes()))
        for n, (line, row) in enumerate(rows, 1):
            if not any(v.strip() for v in row.values()):
                continue
            text = "\n".join(f"{k}: {v}" for k, v in row.items())
            yield Unit(f"{rel}#row={n}", text, row, line=line, path=rel)
        return
    if kind == "json":
        try:
            data = json.loads(_decode(p.read_bytes()))
        except ValueError:
            data = None
        items = list(enumerate(data)) if isinstance(data, list) else list(data.items()) if isinstance(data, dict) else []
        if items:
            for k, v in items:
                key = str(k).replace("~", "~0").replace("/", "~1")
                yield Unit(f"{rel}#/{key}", json.dumps(v, ensure_ascii=False), v, path=rel)
            return
    for n, line in enumerate(corpus._lines(p), 1):
        if not line.strip():
            continue
        value: Any
        if kind == "jsonl":
            try:
                value = json.loads(line)
            except ValueError:
                value = {"_raw": line}
        else:
            value = {"text": line}
        yield Unit(f"{rel}#L{n}", line, value, path=rel)


def _whole(folder: Path, rel: str) -> tuple[Any, list[Any], str]:
    """(the file whole as code reads it, its records, its text as a model reads it)."""
    p = corpus.inside(folder, rel)
    if not p.is_file() or corpus.is_binary(p) or p.stat().st_size > WHOLE_BYTES:
        return None, [], ""
    text = _decode(p.read_bytes())
    records = [u.value for u in record_units(folder, rel)]
    kind = kind_of(rel)
    if kind == "json":
        try:
            data: Any = json.loads(text)
        except ValueError:
            data = text
    elif kind in ("jsonl", "csv"):
        data = records
    else:
        data = text
    return data, records, text


def file_units(folder: Path, files: list[str]) -> Iterator[Unit]:
    for rel in files:
        data, records, text = _whole(folder, rel)
        yield Unit(rel, text[:WHOLE_CHARS], {"path": rel, "data": data, "records": records}, path=rel,
                   extra={"cut": len(text) > WHOLE_CHARS})


def run_units(folder: Path, files: list[str]) -> Iterator[Unit]:
    groups: dict[str, list[str]] = {}
    for rel in files:
        groups.setdefault(os.path.dirname(rel) or ".", []).append(rel)
    for d, paths in groups.items():
        recs: list[Any] = []
        whole: dict[str, Any] = {}
        parts: list[str] = []
        for rel in paths:
            data, records, text = _whole(folder, rel)
            recs.extend(records)
            whole[rel] = data
            parts.append(f"## {rel}\n{text}")
        text = "\n\n".join(parts)
        yield Unit(d, text[:WHOLE_CHARS], {"path": d, "paths": paths, "records": recs, "files": whole}, path=d,
                   extra={"cut": len(text) > WHOLE_CHARS})


def cell_text(cell: dict[str, Any]) -> str:
    payload = cell.get("payload") if isinstance(cell.get("payload"), dict) else {}
    parts = [str(cell.get("title") or ""), str(cell.get("code") or ""), str(cell.get("takeaway") or ""),
             str(payload.get("text") or cell.get("text") or ""),
             canvas.outputs_text(cell) if cell.get("outputs") else ""]
    return "\n\n".join(p for p in parts if p.strip())


def cell_units(ws: str) -> list[Unit]:
    out = []
    for nb in canvas.notebooks(ws):
        for cell in nb["cells"]:
            if cell.get("kind") == "label":
                continue
            text = cell_text(cell)
            value = {"id": cell["id"], "kind": cell.get("kind"), "question": cell.get("title"), "title": cell.get("title"),
                     "takeaway": cell.get("takeaway"), "code": cell.get("code"), "payload": cell.get("payload"),
                     "group": nb.get("title"), "groups": [nb.get("title")], "text": text}
            out.append(Unit(f"card:{cell['id']}", text, value))
    return out


def span_units(ws: str) -> list[Unit]:
    doc = report.writeup(ws)
    out = []
    for sec in (doc or {}).get("sections") or []:
        for para in sec.get("paragraphs") or []:
            for s in para.get("sentences") or []:
                out.append(Unit(f"report:{report.DOC}#{s['id']}", str(s.get("text") or ""),
                                {"id": s["id"], "text": s.get("text"), "refs": s.get("refs") or []}))
    return out


def units_of(ws: str, folder: Path, unit: str, patterns: list[str]) -> list[Unit]:
    """Every unit of a label's scope."""
    if unit == "cell":
        return cell_units(ws)
    if unit == "span":
        return span_units(ws)
    files = match_paths(folder, patterns)
    if unit == "agent":
        return list(file_units(folder, files))
    if unit == "run":
        return list(run_units(folder, files))
    return [u for rel in files for u in record_units(folder, rel)]


def sample(units: list[Unit], limit: int) -> list[Unit]:
    """`limit` units spread over the files they come from, in turn, so a trial sees each file."""
    by_file: dict[str | None, list[Unit]] = {}
    for u in units:
        by_file.setdefault(u.path, []).append(u)
    queues = list(by_file.values())
    out: list[Unit] = []
    i = 0
    while len(out) < limit and any(queues):
        q = queues[i % len(queues)]
        if q:
            out.append(q.pop(0))
        i += 1
    return out
