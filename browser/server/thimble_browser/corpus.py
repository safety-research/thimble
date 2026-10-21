"""The folder of files: listing it, reading pages of a file, searching, and what a file ref points at.

Every path the page or Claude names is checked to be inside the folder (inside()), so nothing outside it is read.
Files are read as lines: a .jsonl line is parsed as JSON, any other line is text. Binary files show no lines. A page of
lines is read through a line index (readers/base.py), and carries what the readers (readers/) find in the file: whether
it reads as a transcript, the key of its records' time, and each record's blocks.
"""
from __future__ import annotations

import os
import time
from pathlib import Path
from typing import Any, Callable, Iterable, Iterator

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


def _count(top: str) -> int:
    """The files under a folder at any depth that walk() lists: hidden files and skipped folders do not count."""
    n = 0
    for _, dirs, files in os.walk(top):
        dirs[:] = [x for x in dirs if not _hidden(x) and x not in SKIP_DIRS]
        n += sum(1 for name in files if not _hidden(name))
    return n


def stamp(corpus: Path, rel: str) -> str | None:
    """A folder's modification time, which a file added, removed or renamed in it changes; None for no folder. The
    Files tree lists a folder again when its stamp changes."""
    try:
        d = inside(corpus, rel.strip("/") or ".")
        return str(d.stat().st_mtime_ns) if d.is_dir() else None
    except (OSError, OutsideFolder):
        return None


def folder(corpus: Path, rel: str) -> dict[str, Any] | None:
    """One folder's own files and subfolders (the Files tree opens folders one at a time), with its stamp."""
    rel = rel.strip("/")
    d = inside(corpus, rel or ".")
    if not d.is_dir():
        return None
    mark = stamp(corpus, rel)
    files, folders = [], []
    for e in sorted(os.scandir(d), key=lambda e: e.name):
        if _hidden(e.name) or e.name in SKIP_DIRS:
            continue
        path = f"{rel}/{e.name}" if rel else e.name
        try:
            if e.is_dir(follow_symlinks=False):
                n = _count(e.path)
                folders.append({"path": path, "name": e.name, "is_run": False, "n_files": n, "n_folders": 0})
            elif e.is_file():
                k = kind_of(path)
                files.append({"path": path, "kind": k, "size_bytes": e.stat().st_size, "title": title_of(path)})
        except OSError:
            continue
    files.sort(key=lambda s: (KIND_ORDER.get(s["kind"], 9), s["path"]))
    # n_files is every file under the folder, as the Files tree counts it: a folder that holds only folders is not empty
    n_all = len(files) + sum(f["n_files"] for f in folders)
    return {"path": rel, "files": files, "folders": folders, "n_files": n_all, "stamp": mark}


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
    from .readers import base  # noqa: PLC0415 — the readers import this module

    return base.line_count(p)


def blocks(record: Any, kind: str) -> list[dict[str, str]]:
    """The record as the reader shows it: {kind, text} blocks (a Claude Code transcript's text, tool_use, tool_result
    and thinking blocks; a post; an event's parameters; else the record's JSON)."""
    from .readers import refs  # noqa: PLC0415

    return refs.record_blocks(record, kind)


def records(rel: str, lines: list[str], start: int) -> list[dict[str, Any]]:
    from .readers import base  # noqa: PLC0415

    return base.records_from_lines(lines, rel, kind_of(rel), start)


def page(corpus: Path, rel: str, start: int, count: int) -> dict[str, Any]:
    """Lines start.. of a file as records, with what the readers find in it: `transcript` when it reads as one (and its
    records' turns and fields), and on the first page `time`, the key of its records' time."""
    from .readers import base, source_events, transcripts  # noqa: PLC0415

    p = inside(corpus, rel)
    if not p.is_file():
        raise FileNotFoundError(rel)
    k = kind_of(rel)
    if is_binary(p):
        return {"path": rel, "kind": k, "total_lines": 0, "start": start, "records": [], "binary": True,
                "size_bytes": p.stat().st_size}
    start = max(1, start)
    count = max(1, min(count, PAGE_MAX))
    got = {"path": rel, "kind": k, "total_lines": base.line_count(p), "start": start,
           "records": base.load_records(p, rel, k, start, start + count - 1)}
    return source_events.dress(transcripts.dress(got, p, rel), p, rel)


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


def split_ref(ref: str) -> tuple[str, str]:
    path, _, loc = ref.partition("#")
    return path.replace("%20", " "), loc


_LISTED: dict[str, tuple[float, list[str]]] = {}  # folder -> (when it was listed, its files), for a few seconds
LISTED_S = 5.0


def _files(corpus: Path) -> list[str]:
    key = str(corpus.resolve())
    when, files = _LISTED.get(key, (0.0, []))
    if time.monotonic() - when > LISTED_S:
        files = [f["path"] for f in walk(corpus)]
        _LISTED[key] = (time.monotonic(), files)
    return files


def locate(corpus: Path, rel: str, read: Callable[[], Iterable[str]] | None = None) -> str:
    """The path in the folder of the file a ref names. A path may be written from a subfolder: Claude read
    toy/board.jsonl and cited board.jsonl. When the folder holds nothing at `rel`, the one file whose path ends with
    /<rel> is meant; among several, the one the session read (`read` lists the paths it read). `rel` itself when no file
    ends so, which then fails as a missing file. ValueError when several files end so and the reads do not choose."""
    rel = rel.strip()
    if not rel or inside(corpus, rel).exists():
        return rel
    tail = "/" + rel.removeprefix("./")
    hits = [f for f in _files(corpus) if f.endswith(tail)]
    if len(hits) > 1 and read is not None:
        seen = {r.removeprefix("./") for r in read()}
        hits = [h for h in hits if h in seen] or hits
    if len(hits) > 1:
        more = f", and {len(hits) - 3} more" if len(hits) > 3 else ""
        raise ValueError(f"no file {rel} in the folder, and {len(hits)} files end with {tail}: "
                         f"{', '.join(hits[:3])}{more}")
    return hits[0] if hits else rel


def resolve(corpus: Path, ref: str, read: Callable[[], Iterable[str]] | None = None) -> dict[str, Any]:
    """What a file ref points at, as GET /ref answers (readers/refs.py): {ref, kind, path, line, record, blocks,
    excerpt, meta}. A path written from a subfolder is read at the file it means (locate): then `ref` is the ref with
    that path, and `moved_from` the ref as written. FileNotFoundError for a place that is not there, ValueError
    (OutsideFolder for a path that leaves the folder) for a ref that is malformed."""
    from .readers import refs  # noqa: PLC0415

    path, loc = split_ref(ref.strip())
    inside(corpus, path)  # OutsideFolder before anything is read
    where = locate(corpus, path, read)
    try:
        got = refs.resolve(corpus, f"{where}#{loc}" if loc else where)
    except refs.RefError as e:
        if e.status == 404:
            raise FileNotFoundError(e.detail) from None
        raise ValueError(e.detail) from None
    if where != path:
        got["moved_from"] = ref.strip()
    return got


def csv_rows(corpus: Path, rel: str, a: int, b: int) -> list[list[int]]:
    """[line, n] for each CSV row that starts on lines a..b: n is the row's number in a `#row=<n>` ref."""
    p = inside(corpus, rel)
    out = []
    for n, line in enumerate(_lines(p)[1:], 2):
        if a <= n <= b:
            out.append([n, n - 1])
    return out
