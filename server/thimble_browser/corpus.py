"""The folder of files: listing it, reading pages of a file, searching, and what a file ref points at.

Every path the page or Claude names is checked to be inside the folder (inside()), so nothing outside it is read.
Files are read as lines: a .jsonl line is parsed as JSON, any other line is text. Binary files show no lines.
"""
from __future__ import annotations

import csv
import io
import json
import os
import re
from pathlib import Path
from typing import Any, Iterator

PAGE_MAX = 2000
FIND_LINES_MAX = 2000
FIND_FILES_MAX = 200
GREP_FILES_MAX = 200
GREP_HITS_PER_FILE = 20
SKIP_DIRS = {".git", "node_modules", "__pycache__", ".venv"}
KIND_ORDER = {"agent": 0, "board": 1, "events": 2, "forge": 3, "prompt": 4, "text": 5, "dir": 6}


class OutsideFolder(ValueError):
    pass


def inside(corpus: Path, rel: str) -> Path:
    """The file `rel` names in the folder; OutsideFolder for a path that leaves it, through `..` or a symlink."""
    rel = (rel or "").strip()
    root = corpus.resolve()
    p = (root / rel).resolve()  # an absolute path stays itself, and must be inside the folder too
    if p != root and root not in p.parents:
        raise OutsideFolder(f"{rel!r} is outside the folder")
    return p


def kind_of(rel: str) -> str:
    parts = rel.split("/")
    name = parts[-1]
    parent = parts[-2] if len(parts) > 1 else ""
    if parent == "agents" and name.endswith(".jsonl"):
        return "agent"
    if name == "board.jsonl":
        return "board"
    if name == "events.jsonl":
        return "events"
    if name.endswith((".db", ".sqlite", ".sqlite3")):
        return "forge"
    if parent == "prompts":
        return "prompt"
    return "text"


def title_of(rel: str) -> str:
    name = rel.rsplit("/", 1)[-1]
    return name[: -len(".jsonl")] if name.endswith(".jsonl") else name


def _hidden(name: str) -> bool:
    return name.startswith(".")


def walk(corpus: Path) -> list[dict[str, Any]]:
    """Every file of the folder, as the Files tab lists them."""
    root = corpus.resolve()
    out = []
    for d, dirs, files in os.walk(root):
        dirs[:] = sorted(x for x in dirs if not _hidden(x) and x not in SKIP_DIRS)
        for name in files:
            if _hidden(name):
                continue
            full = Path(d) / name
            try:
                if full.is_symlink() and root not in full.resolve().parents:
                    continue
                size = full.stat().st_size
            except OSError:
                continue
            rel = str(full.relative_to(root))
            k = kind_of(rel)
            out.append({"path": rel, "kind": k, "size_bytes": size, "title": title_of(rel)})
    out.sort(key=lambda s: (KIND_ORDER.get(s["kind"], 9), s["path"]))
    return out


def folder(corpus: Path, rel: str) -> dict[str, Any] | None:
    """One folder's own files and subfolders (the Files tree opens folders one at a time)."""
    rel = rel.strip("/")
    d = inside(corpus, rel or ".")
    if not d.is_dir():
        return None
    files, folders = [], []
    for e in sorted(os.scandir(d), key=lambda e: e.name):
        if _hidden(e.name) or e.name in SKIP_DIRS:
            continue
        path = f"{rel}/{e.name}" if rel else e.name
        try:
            if e.is_dir(follow_symlinks=False):
                n = sum(len(fs) for _, _, fs in os.walk(e.path))
                folders.append({"path": path, "name": e.name, "is_run": False, "n_files": n, "n_folders": 0})
            elif e.is_file():
                k = kind_of(path)
                files.append({"path": path, "kind": k, "size_bytes": e.stat().st_size, "title": title_of(path)})
        except OSError:
            continue
    files.sort(key=lambda s: (KIND_ORDER.get(s["kind"], 9), s["path"]))
    return {"path": rel, "files": files, "folders": folders, "n_files": len(files)}


def is_binary(p: Path) -> bool:
    try:
        with open(p, "rb") as f:
            head = f.read(4096)
    except OSError:
        return False
    return b"\0" in head


def _lines(p: Path) -> list[str]:
    with open(p, "rb") as f:
        raw = f.read()
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        text = raw.decode("cp1252", "replace")
    lines = text.split("\n")
    if lines and lines[-1] == "":
        lines.pop()
    return [line.rstrip("\r") for line in lines]


def line_count(p: Path) -> int:
    return len(_lines(p))


def _text(v: Any) -> str:
    return v if isinstance(v, str) else json.dumps(v, ensure_ascii=False)


def blocks(record: Any, kind: str) -> list[dict[str, str]]:
    """The record as the reader shows it: {kind, text} blocks."""
    if isinstance(record, dict) and set(record) == {"text"}:
        return [{"kind": "text", "text": _text(record["text"])}]
    if isinstance(record, dict) and record.get("type") in ("assistant", "user"):
        msg = record.get("message")
        if isinstance(msg, dict) and isinstance(msg.get("content"), str):
            return [{"kind": "text", "text": msg["content"]}]
    return [{"kind": "raw", "text": json.dumps(record, ensure_ascii=False)}]


def records(rel: str, lines: list[str], start: int) -> list[dict[str, Any]]:
    k = kind_of(rel)
    jsonl = rel.endswith(".jsonl") or k in ("agent", "board", "events")
    out = []
    for n, text in enumerate(lines, start):
        if jsonl:
            try:
                rec: Any = json.loads(text)
            except ValueError:
                rec = {"_raw": text}
        else:
            rec = {"text": text}
        out.append({"line": n, "record": rec, "blocks": blocks(rec, k), "meta": {}})
    return out


def page(corpus: Path, rel: str, start: int, count: int) -> dict[str, Any]:
    p = inside(corpus, rel)
    if not p.is_file():
        raise FileNotFoundError(rel)
    k = kind_of(rel)
    if is_binary(p):
        return {"path": rel, "kind": k, "total_lines": 0, "start": start, "records": [], "binary": True,
                "size_bytes": p.stat().st_size}
    lines = _lines(p)
    start = max(1, start)
    count = max(1, min(count, PAGE_MAX))
    return {"path": rel, "kind": k, "total_lines": len(lines), "start": start,
            "records": records(rel, lines[start - 1:start - 1 + count], start)}


def around(corpus: Path, rel: str, line: int, before: int, after: int, clamp: bool) -> dict[str, Any]:
    p = inside(corpus, rel)
    total = line_count(p)
    if line < 1 or line > total:
        if not (clamp and total > 0):
            raise IndexError(f"line {line} out of range ({rel} has {total} lines)")
        line = total
    start = max(1, line - before)
    return page(corpus, rel, start, line + after - start + 1)


def find_in_file(corpus: Path, rel: str, q: str, after: int = 0) -> dict[str, Any]:
    p = inside(corpus, rel)
    lines = _lines(p)
    low = q.lower()
    hits, counts = [], []
    for n, text in enumerate(lines, 1):
        if n <= after:
            continue
        c = text.lower().count(low) if low else 0
        if c:
            hits.append(n)
            counts.append(c)
    return {"path": rel, "q": q, "lines": hits[:FIND_LINES_MAX], "counts": counts[:FIND_LINES_MAX],
            "total": len(hits), "matches": sum(counts), "complete": True, "scanned": len(lines),
            "total_lines": len(lines)}


def find_files(corpus: Path, q: str) -> dict[str, Any]:
    words = [w for w in q.lower().split() if w]
    files = [f for f in walk(corpus) if all(w in f["path"].lower() for w in words)]
    files.sort(key=lambda f: (len(f["path"]), f["path"]))
    return {"q": q, "files": files[:FIND_FILES_MAX], "total": len(files)}


def grep(corpus: Path, q: str) -> Iterator[dict[str, Any]]:
    """The files whose text holds `q`, one record each, then the closing record."""
    files = [f for f in walk(corpus) if f["kind"] != "forge"]
    low = q.lower()
    n_files = hits = scanned = 0
    for f in files:
        scanned += 1
        p = corpus / f["path"]
        if not low or is_binary(p) or p.stat().st_size > 50_000_000:
            continue
        matches, total = [], 0
        for n, text in enumerate(_lines(p), 1):
            i = text.lower().find(low)
            if i < 0:
                continue
            total += 1
            if len(matches) < GREP_HITS_PER_FILE:
                a = max(0, i - 60)
                snippet = text[a:i + len(q) + 100]
                matches.append({"line": n, "text": snippet, "hit": [i - a, i - a + len(q)]})
        if total:
            n_files += 1
            hits += total
            yield {"path": f["path"], "total": total, "complete": True, "matches": matches}
            if n_files >= GREP_FILES_MAX:
                break
    yield {"done": True, "files": n_files, "hits": hits, "scanned": scanned, "of": len(files),
           "complete": n_files < GREP_FILES_MAX}


# ---- file refs

LINE_REF = re.compile(r"^L(\d+)(?:-L?(\d+))?$")


def split_ref(ref: str) -> tuple[str, str]:
    path, _, loc = ref.partition("#")
    return path.replace("%20", " "), loc


def resolve(corpus: Path, ref: str) -> dict[str, Any]:
    """What a file ref points at, as GET /ref answers: {ref, kind, path, line, record, blocks, excerpt, meta}."""
    path, loc = split_ref(ref)
    p = inside(corpus, path)
    if not p.exists():
        raise FileNotFoundError(path)
    if p.is_dir():
        return {"ref": ref, "kind": "dir", "path": path, "excerpt": f"folder {path}"}
    if not loc:
        lines = _lines(p) if not is_binary(p) else []
        return {"ref": ref, "kind": "file", "path": path, "line": 1, "excerpt": "\n".join(lines[:5])[:2000],
                "meta": {"total_lines": len(lines)}}
    m = LINE_REF.match(loc)
    if m:
        a = int(m.group(1))
        b = int(m.group(2) or a)
        lines = _lines(p)
        if a < 1 or a > len(lines):
            raise IndexError(f"{path} has {len(lines)} lines, not line {a}")
        b = min(max(a, b), len(lines))
        recs = records(path, lines[a - 1:b], a)
        out = {"ref": ref, "kind": "record" if a == b else "range", "path": path, "line": a,
               "excerpt": "\n".join(lines[a - 1:b])[:4000], "meta": {"end": b}}
        if a == b:
            out["record"], out["blocks"] = recs[0]["record"], recs[0]["blocks"]
        return out
    if loc.startswith("row=") and loc[4:].isdigit():
        n = int(loc[4:])
        text = p.read_text(encoding="utf-8", errors="replace")
        rows = list(csv.reader(io.StringIO(text)))
        if n < 1 or n >= len(rows):
            raise IndexError(f"{path} has {len(rows) - 1} rows, not row {n}")
        rec = dict(zip(rows[0], rows[n]))
        return {"ref": ref, "kind": "row", "path": path, "line": n + 1, "record": rec,
                "excerpt": json.dumps(rec, ensure_ascii=False), "meta": {}}
    if loc.startswith("/"):
        data: Any = json.loads(p.read_text(encoding="utf-8"))
        for part in [x.replace("~1", "/").replace("~0", "~") for x in loc[1:].split("/") if x]:
            data = data[int(part)] if isinstance(data, list) else data[part]
        return {"ref": ref, "kind": "value", "path": path, "record": data,
                "excerpt": json.dumps(data, ensure_ascii=False)[:4000], "meta": {}}
    return {"ref": ref, "kind": "file", "path": path, "line": 1, "excerpt": "", "meta": {"locator": loc}}


def csv_rows(corpus: Path, rel: str, a: int, b: int) -> list[list[int]]:
    """[line, n] for each CSV row that starts on lines a..b: n is the row's number in a `#row=<n>` ref."""
    p = inside(corpus, rel)
    out = []
    for n, line in enumerate(_lines(p)[1:], 2):
        if a <= n <= b:
            out.append([n, n - 1])
    return out
