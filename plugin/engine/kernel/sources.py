"""Sources: anything Claude can read, each kind with an adapter that gives its rows with stable ids (refs.py).

    kind        files                                 a row is                          its ref
    jsonl       .jsonl .ndjson                        one line (one record)             <path>#L<n>
    transcript  a jsonl of chat records               one line (one message or event)   <path>#L<n>
    csv         .csv .tsv                             one row after the header          <path>#row=<n>
    json        .json                                 one item of its largest list      <path>#/<key>/<i>
                                                      (or of the list at a JSON pointer:
                                                      iter_rows' `at`, `*` every item)
    sqlite      .db .sqlite .sqlite3                  one row of a table                <path>#<table>/<rowid>
    markdown    .md .markdown .rst                    one section (a heading and text)  <path>#L<a>-<b>
    diff        .diff .patch                          one hunk                          <path>#L<a>-<b>
    text        code, logs, config, .txt              one line                          <path>#L<n>

Coverage also counts the files that have no rows, each in its own unit: a PDF by its pages, and an image, a sound, a
video or any other file as one whole file (`file_kind`, `list_files`).

A ref stays the same when the analysis runs again on the same file. Files under the thimble/ record folder, version
control and dependency folders are never sources.
"""
from __future__ import annotations

import csv
import json
import os
import re
import shutil
import sqlite3
import sys
import tempfile
import time
from collections import defaultdict
from contextlib import closing, contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterator
from urllib.parse import quote

SKIP_DIRS = {".git", ".hg", ".svn", "node_modules", "__pycache__", ".venv", "venv", ".mypy_cache", ".pytest_cache",
             ".thimble", "thimble", ".lite"}
KIND_OF_EXT = {
    ".jsonl": "jsonl", ".ndjson": "jsonl", ".csv": "csv", ".tsv": "csv", ".json": "json",
    ".db": "sqlite", ".sqlite": "sqlite", ".sqlite3": "sqlite",
    ".md": "markdown", ".markdown": "markdown", ".rst": "markdown",
    ".diff": "diff", ".patch": "diff",
}
TEXT_EXT = {".txt", ".log", ".py", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".sh", ".bash", ".zsh", ".yaml",
            ".yml", ".toml", ".ini", ".cfg", ".conf", ".html", ".css", ".sql", ".rb", ".go", ".rs", ".java", ".c",
            ".h", ".cpp", ".hpp", ".r", ".jl", ".lua", ".pl", ".php", ".swift", ".kt", ".scala", ".xml", ".srt",
            ".vtt", ".tex", ".bib", ".ipynb", ".env.example"}
TEXT_MAX_BYTES = 64 * 1024 * 1024
# the files that are no source, as coverage names them: a PDF is counted by its pages, the others as whole files
MEDIA_KIND = {".pdf": "pdf",
              **{e: "image" for e in (".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tif", ".tiff", ".svg", ".ico", ".heic")},
              **{e: "audio" for e in (".mp3", ".wav", ".m4a", ".flac", ".ogg", ".aac", ".opus")},
              **{e: "video" for e in (".mp4", ".mov", ".webm", ".mkv", ".avi", ".m4v")}}
PDF_MAX_BYTES = 256 * 1024 * 1024


@dataclass
class Row:
    ref: str
    raw: str  # the row's text as the file holds it (a JSON value as JSON)
    value: Any  # the row as a dict (records), or its text (lines, sections, hunks)


def kind_of(path: Path) -> str | None:
    return kind_of_name(path.name)


def ext_of(name: str) -> str:
    """A file name's extension, lower case, as Path.suffix gives it: `.gz` of `a.tar.gz`, none of `.bashrc`."""
    dot = name.rfind(".")
    return name[dot:].lower() if 0 < dot < len(name) - 1 else ""


def kind_of_name(name: str) -> str | None:
    """A source file's kind by its name (the last part of its path), or None for a file that is no source."""
    name = name.rsplit("/", 1)[-1]
    ext = ext_of(name)
    if ext in KIND_OF_EXT:
        return KIND_OF_EXT[ext]
    if ext in TEXT_EXT or (not ext and name in ("Makefile", "Dockerfile", "README", "LICENSE")):
        return "text"
    return None


def file_kind(path: Path) -> str:
    """A file's kind for coverage: its source kind, else pdf, image, audio or video by its extension, else file."""
    return kind_of(path) or MEDIA_KIND.get(path.suffix.lower(), "file")


def list_files(root: Path) -> list[str]:
    """Every file under root that coverage counts, relative, sorted: the sources, and the other files that are not
    hidden (a PDF, an image, a binary). A link counts as what it points to, so a working folder of links to a
    dataset's files and folders is the dataset; each folder is walked once (a link back up is not followed again),
    and a broken link is no file. Nothing is written anywhere."""
    out: list[str] = []
    walked: set[tuple[int, int]] = set()

    # by os.scandir and plain strings: a folder of 100,000 files is walked in well under a second
    def walk(d: str, rel: str) -> None:
        try:
            s = os.stat(d)
            if (s.st_dev, s.st_ino) in walked:
                return
            walked.add((s.st_dev, s.st_ino))
            entries = list(os.scandir(d))
        except OSError:
            return
        dirs = []
        for e in entries:
            try:
                if e.is_dir():
                    dirs.append(e.name)
                elif not (e.name.startswith(".") and not kind_of(Path(e.name))) and (not e.is_symlink() or e.is_file()):
                    out.append(rel + e.name)
            except OSError:
                continue
        for x in sorted(dirs):
            if x not in SKIP_DIRS and not x.startswith("."):
                walk(os.path.join(d, x), f"{rel}{x}/")

    walk(str(root), "")
    return sorted(out)


_PDF_PAGE = re.compile(rb"/Type\s*/Page(?![a-zA-Z])")


def count_pages(p: Path) -> int:
    """A PDF's pages: its page objects, also those packed in compressed object streams. At least 1."""
    import zlib

    try:
        if p.stat().st_size > PDF_MAX_BYTES:
            return 1
        data = p.read_bytes()
    except OSError:
        return 1
    n = len(_PDF_PAGE.findall(data))
    at = data.find(b"/ObjStm")
    while at >= 0:
        a = data.find(b"stream", at)
        b = data.find(b"endstream", a + 6) if a >= 0 else -1
        if b < 0:
            break
        try:
            n += len(_PDF_PAGE.findall(zlib.decompressobj().decompress(data[a + 6:b].lstrip(b"\r\n"))))
        except zlib.error:
            pass
        at = data.find(b"/ObjStm", b)
    return max(1, n)


# ------------------------------------------------------------------ adapters


TRANSCRIPT_TYPES = {"user", "assistant", "system", "result", "summary"}


def looks_like_transcript(p: Path) -> bool:
    """A jsonl file whose first records are chat records (Claude Code's transcripts and stream-json logs)."""
    try:
        with open(p, "r", errors="replace") as f:
            for _, line in zip(range(5), f):
                try:
                    v = json.loads(line)
                except ValueError:
                    return False
                if isinstance(v, dict) and v.get("type") in TRANSCRIPT_TYPES and ("message" in v or "subtype" in v or "session_id" in v or "sessionId" in v):
                    return True
    except OSError:
        return False
    return False


def kind_of_file(root: Path, rel: str) -> str | None:
    p = root / rel
    k = kind_of(p)
    if k == "jsonl" and looks_like_transcript(p):
        return "transcript"
    return k


def json_rows_key(v: Any) -> str | None:
    """The key of a JSON document's rows: '' for a top-level list, else its longest top-level list (one level down,
    `/a/b`, when the top holds none)."""
    if isinstance(v, list):
        return ""
    if not isinstance(v, dict):
        return None
    best, n = None, 0
    for k, x in v.items():
        if isinstance(x, list) and len(x) > n:
            best, n = "/" + k.replace("~", "~0").replace("/", "~1"), len(x)
    if best is None:
        for k, x in v.items():
            if isinstance(x, dict):
                for k2, y in x.items():
                    if isinstance(y, list) and len(y) > n:
                        best, n = f"/{k}/{k2}", len(y)
    return best


def _pointer_get(v: Any, pointer: str) -> Any:
    for part in pointer.split("/")[1:]:
        part = part.replace("~1", "/").replace("~0", "~")
        v = v[int(part)] if isinstance(v, list) else v[part]
    return v


def _esc(key: Any) -> str:
    return str(key).replace("~", "~0").replace("/", "~1")


def pointer_values(v: Any, at: str) -> Iterator[tuple[str, Any]]:
    """(pointer, value) of each value a JSON pointer names in a document: `at` is a JSON pointer (RFC 6901) whose `*`
    parts stand for every item of a list or every key of an object at that level, so `/*/messages` names the
    `messages` of each top item. A part that names nothing in a value skips that value."""
    # `#/` is the whole document, as iter_rows names one read as one value
    parts = [p.replace("~1", "/").replace("~0", "~") for p in at.split("/")[1:]] if at.startswith("/") and at != "/" else []

    def walk(x: Any, i: int, here: str) -> Iterator[tuple[str, Any]]:
        if i == len(parts):
            yield here, x
            return
        part = parts[i]
        if part == "*":
            kids = enumerate(x) if isinstance(x, list) else x.items() if isinstance(x, dict) else ()
            for k, y in kids:
                yield from walk(y, i + 1, f"{here}/{_esc(k)}")
        elif isinstance(x, list) and part.isdigit() and int(part) < len(x):
            yield from walk(x[int(part)], i + 1, f"{here}/{part}")
        elif isinstance(x, dict) and part in x:
            yield from walk(x[part], i + 1, f"{here}/{_esc(part)}")

    yield from walk(v, 0, "")


def json_records_at(rel: str, v: Any, at: str) -> Iterator[Row]:
    """The records of a JSON document at a pointer (pointer_values): each item of each list it names, else the value it
    names, each with its own pointer as its ref (`run.json#/0/messages/3`), so a record keeps its place in the file."""
    for here, x in pointer_values(v, at):
        if isinstance(x, list):
            for i, y in enumerate(x):
                yield Row(f"{rel}#{here}/{i}", json.dumps(y, ensure_ascii=False), y)
        else:
            yield Row(f"{rel}#{here or '/'}", json.dumps(x, ensure_ascii=False), x)


@contextmanager
def open_db(p: Path) -> Iterator[sqlite3.Connection]:
    """A database opened to read only, so that nothing beside it is made or changed. SQLite reads a database in WAL mode
    with its -wal and -shm files, and makes or rewrites them even with `mode=ro`; `immutable=1` reads the database file
    alone and touches none. A -wal file that holds rows not yet in the database is read from a copy: the database and
    its -wal file copied to a temporary folder, which SQLite may write in, and which is deleted after."""
    wal = Path(f"{p}-wal")
    if wal.is_file() and wal.stat().st_size > 0:
        with tempfile.TemporaryDirectory(prefix="thimble-db-") as d:
            copy = Path(d) / "db"
            shutil.copyfile(p, copy)
            shutil.copyfile(wal, f"{copy}-wal")
            with closing(sqlite3.connect(f"file:{quote(str(copy))}?mode=ro", uri=True)) as con:
                yield con
        return
    with closing(sqlite3.connect(f"file:{quote(str(p))}?immutable=1", uri=True)) as con:
        yield con


def table_names(root: Path, rel: str) -> list[str]:
    """The tables of a database, by name; none for a file that is not one."""
    if kind_of_file(root, rel) != "sqlite":
        return []
    with open_db(root / rel) as con:
        return [t for (t,) in con.execute("select name from sqlite_master where type='table' and name not like 'sqlite_%' order by name").fetchall()]


def _record(rel: str, i: int, line: str) -> Row:
    """Line i of a JSONL file as a row: its record, or its text when it is no JSON."""
    line = line.rstrip("\n")
    try:
        v = json.loads(line)
    except ValueError:
        v = {"_text": line}
    return Row(f"{rel}#L{i}", line, v)


def json_lines(root: Path, rel: str, nums: set[int]) -> Iterator[Row]:
    """The records on the lines `nums` of a JSONL file (or a transcript): the file is read up to the last of them, and
    only those lines are decoded."""
    top = max(nums, default=0)
    with open(root / rel, "r", errors="replace") as f:
        for i, line in enumerate(f, 1):
            if i > top:
                break
            if i in nums and line.strip():
                yield _record(rel, i, line)


def iter_rows(root: Path, rel: str, table: str | None = None, at: str | None = None) -> Iterator[Row]:
    """Every row of one source file, in file order. `at`, a JSON pointer (pointer_values): the records of a JSON
    document there in place of its largest list, so the messages nested in each conversation of a transcript file are
    records of their own."""
    p = root / rel
    kind = kind_of_file(root, rel)
    if at and kind == "json":
        yield from json_records_at(rel, json.loads(p.read_text(errors="replace")), at)
        return
    if kind in ("jsonl", "transcript"):
        with open(p, "r", errors="replace") as f:
            for i, line in enumerate(f, 1):
                if line.strip():
                    yield _record(rel, i, line)
    elif kind == "csv":
        with open(p, newline="", errors="replace") as f:
            for i, row in enumerate(csv.DictReader(f, delimiter="\t" if p.suffix.lower() == ".tsv" else ","), 1):
                yield Row(f"{rel}#row={i}", json.dumps(row, ensure_ascii=False), row)
    elif kind == "json":
        v = json.loads(p.read_text(errors="replace"))
        key = json_rows_key(v)
        if key is None:
            yield Row(f"{rel}#/", json.dumps(v, ensure_ascii=False), v)
            return
        items = _pointer_get(v, key) if key else v
        for i, x in enumerate(items):
            yield Row(f"{rel}#{key}/{i}", json.dumps(x, ensure_ascii=False), x)
    elif kind == "sqlite":
        with open_db(p) as con:
            con.row_factory = sqlite3.Row
            tables = [t for (t,) in con.execute("select name from sqlite_master where type='table' and name not like 'sqlite_%' order by name").fetchall()]
            for t in tables:
                if table and t != table:
                    continue
                try:
                    cur = con.execute(f'select rowid as "_rowid_", * from "{t}"')
                except sqlite3.Error:
                    continue
                for row in cur:
                    d = dict(row)
                    rid = d.pop("_rowid_")
                    yield Row(f"{rel}#{t}/{rid}", json.dumps(d, ensure_ascii=False, default=str), d)
    elif kind == "markdown":
        yield from _sections(p, rel)
    elif kind == "diff":
        yield from _hunks(p, rel)
    elif kind == "text":
        if p.stat().st_size > TEXT_MAX_BYTES:
            return
        with open(p, "r", errors="replace") as f:
            for i, line in enumerate(f, 1):
                line = line.rstrip("\n")
                yield Row(f"{rel}#L{i}", line, line)


_HEADING = re.compile(r"^(#{1,6})\s+(.*)$")


def _sections(p: Path, rel: str) -> Iterator[Row]:
    """A Markdown file's sections: each heading with the text under it, up to the next heading (a preamble first)."""
    lines = p.read_text(errors="replace").split("\n")
    if lines and lines[-1] == "":
        lines.pop()
    starts = [i for i, line in enumerate(lines) if _HEADING.match(line)]
    if not starts or starts[0] != 0:
        starts = [0] + starts
    for j, a in enumerate(starts):
        b = (starts[j + 1] if j + 1 < len(starts) else len(lines)) - 1
        if b < a:
            continue
        body = "\n".join(lines[a:b + 1])
        if not body.strip():
            continue
        m = _HEADING.match(lines[a])
        value = {"heading": m[2].strip() if m else "", "level": len(m[1]) if m else 0, "text": body}
        yield Row(f"{rel}#L{a + 1}-{b + 1}" if b > a else f"{rel}#L{a + 1}", body, value)


_HUNK = re.compile(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$")


def _hunks(p: Path, rel: str) -> Iterator[Row]:
    """A unified diff's hunks, each with the file it changes and its added and removed lines."""
    lines = p.read_text(errors="replace").split("\n")
    file = ""
    i = 0
    while i < len(lines):
        line = lines[i]
        if line.startswith("+++ "):
            file = re.sub(r"^b/", "", line[4:].strip().split("\t")[0])
        m = _HUNK.match(line)
        if m:
            a = i
            i += 1
            while i < len(lines) and not _HUNK.match(lines[i]) and not lines[i].startswith(("diff ", "--- ", "+++ ")):
                i += 1
            body = lines[a:i]
            while body and body[-1] == "":
                body.pop()
            b = a + len(body) - 1
            value = {"file": file, "header": line, "old_start": int(m[1]), "new_start": int(m[3]),
                     "added": sum(1 for x in body[1:] if x.startswith("+")),
                     "removed": sum(1 for x in body[1:] if x.startswith("-")), "text": "\n".join(body)}
            yield Row(f"{rel}#L{a + 1}-{b + 1}", "\n".join(body), value)
            continue
        i += 1


# ------------------------------------------------------------------ counts


def count_lines(p: Path) -> int:
    n, last = 0, b"\n"
    with open(p, "rb") as f:
        while True:
            b = f.read(1 << 22)
            if not b:
                break
            n += b.count(b"\n")
            last = b[-1:]
    return n + (0 if last == b"\n" else 1)


def _count_sqlite(p: Path) -> int:
    """The rows iter_rows gives of a database, counted by the database: each table's rows, for the tables whose rows
    can be selected by rowid (iter_rows skips the others)."""
    n = 0
    with open_db(p) as con:
        tables = [t for (t,) in con.execute("select name from sqlite_master where type='table' and name not like 'sqlite_%' order by name").fetchall()]
        for t in tables:
            try:
                con.execute(f'select rowid as "_rowid_", * from "{t}" limit 0')
            except sqlite3.Error:
                continue
            n += con.execute(f'select count(*) from "{t}"').fetchone()[0]
    return n


def count_rows(root: Path, rel: str) -> int:
    """A file's rows; for a file that is no source, its units as coverage counts them: a PDF's pages, else 1."""
    p = root / rel
    kind = kind_of(p)
    if kind is None:
        return count_pages(p) if file_kind(p) == "pdf" else 1
    try:
        if kind in ("jsonl", "text"):
            return count_lines(p)
        if kind == "csv":
            return max(0, count_lines(p) - 1)
        if kind == "json" and p.stat().st_size > 256 * 1024 * 1024:
            return 1
        if kind == "sqlite":
            return _count_sqlite(p)
        return sum(1 for _ in iter_rows(root, rel))
    except Exception:  # noqa: BLE001 — a file that cannot be read has no rows
        return 0


PARALLEL_MIN = 64_000_000  # bytes of files not yet counted: counted in worker processes above this
PARALLEL_FILES = 1_000  # or this many files: each costs an open and a read, which a slow disk makes long


class Unfinished(Exception):
    """A count that stopped at its time limit (`counts`' `until`) before it counted every file. What it counted is kept
    for the next count, which goes on from there."""

    def __init__(self, done: int, total: int):
        super().__init__(f"counted {done:,} of {total:,} files")
        self.done, self.total = done, total


def _entry(root: Path, rel: str, size: int, mtime_ns: int) -> dict[str, Any]:
    """One file's counts as the cache keeps them, by the size and the time of change it had when it was looked at. A
    file that cannot be read has no rows and no lines."""
    p = root / rel
    kind = kind_of_file(root, rel) or file_kind(p)
    rows = count_rows(root, rel)
    lines = 0
    if kind in ("jsonl", "transcript", "text"):
        lines = rows
    elif kind in ("markdown", "diff", "csv", "json") and size < 256 * 1024 * 1024:
        try:
            lines = count_lines(p)
        except OSError:
            lines = 0
    return {"key": f"{size}:{mtime_ns}", "kind": kind, "rows": rows, "lines": lines, "size": size}


def _entries(args: tuple[str, list[tuple[str, int, int]]]) -> list[tuple[str, dict[str, Any]]]:
    root = Path(args[0])
    return [(rel, _entry(root, rel, size, mtime_ns)) for rel, size, mtime_ns in args[1]]


def _die_with_parent() -> None:
    """A worker of the count ends when the count's process ends, killed or not (Linux's parent-death signal), so a
    count that Claude Code stops leaves no worker behind."""
    try:
        import ctypes
        import signal

        ctypes.CDLL(None, use_errno=True).prctl(1, signal.SIGKILL)  # PR_SET_PDEATHSIG
    except Exception:  # noqa: BLE001 — the worker then ends when its work ends
        pass


def _past(until: float | None) -> bool:
    return until is not None and time.monotonic() >= until


def _count_many(root: Path, todo: list[tuple[str, int, int]], until: float | None) -> Iterator[tuple[str, dict[str, Any]]]:
    """Each file's counts, as each is counted, the biggest files first: in up to 8 worker processes when there are many
    of them or they are big together (Linux), else one after another. No file is begun past `until`."""
    todo = sorted(todo, key=lambda t: -t[1])
    left = todo
    if len(todo) > 1 and (len(todo) >= PARALLEL_FILES or sum(t[1] for t in todo) >= PARALLEL_MIN) and sys.platform.startswith("linux"):
        n = max(1, min(8, (os.cpu_count() or 2) - 1, len(todo)))
        if n > 1:
            done: set[str] = set()
            try:
                import multiprocessing as mp
                from concurrent.futures import ProcessPoolExecutor

                # a few files per task: the big files alone, many small files together
                size = max(1, min(32, len(todo) // (n * 16)))
                tasks = [(str(root), todo[i:i + size]) for i in range(0, len(todo), size)]
                ex = ProcessPoolExecutor(max_workers=n, mp_context=mp.get_context("fork"), initializer=_die_with_parent)
                try:
                    for got in ex.map(_entries, tasks):
                        for rel, c in got:
                            done.add(rel)
                            yield rel, c
                        if _past(until):
                            return
                    return
                finally:
                    # the tasks not begun are dropped; the ones that run end with their files
                    ex.shutdown(wait=True, cancel_futures=True)
            except Exception:  # noqa: BLE001 — the files left are counted one after another below
                left = [t for t in todo if t[0] not in done]
    for rel, size, mtime_ns in left:
        if _past(until):
            return
        yield rel, _entry(root, rel, size, mtime_ns)


def counted(name: str) -> bool:
    """Whether a file is counted by its rows (a source) or its pages (a PDF), by its name alone. Any other file (an
    image, a sound, a binary) is one whole file (`whole_file`)."""
    return kind_of_name(name) is not None or MEDIA_KIND.get(ext_of(name.rsplit("/", 1)[-1])) == "pdf"


def whole_file(rel: str) -> dict[str, Any]:
    """A file that is neither a source nor a PDF, as `counts` would give it: its kind by its extension (image, audio,
    video, file), one row and no lines."""
    return {"kind": MEDIA_KIND.get(ext_of(rel.rsplit("/", 1)[-1]), "file"), "rows": 1, "lines": 0}


def _read_counts(cache_file: Path) -> tuple[dict[str, Any], bool]:
    """The counts a folder's cache keeps: its last whole count (counts.json), then each file counted since, one line
    each (counts.jsonl, the journal of a count that has not ended); and whether the journal held any."""
    cache: dict[str, Any] = {}
    try:
        v = json.loads(cache_file.read_text())
        cache = v if isinstance(v, dict) else {}
    except (OSError, ValueError):
        pass
    added = False
    try:
        with open(cache_file.with_suffix(".jsonl"), "rb") as f:
            for line in f:
                try:
                    rel, c = json.loads(line)
                except ValueError:
                    continue  # a line cut short where a count was stopped
                cache[rel] = c
                added = True
    except OSError:
        pass
    return cache, added


@contextmanager
def _counting(cache_file: Path, until: float | None, wait: bool = True) -> Iterator[bool]:
    """The folder's count, one at a time (a lock beside its cache, which ends with the process that holds it): whether
    this count holds it. A count that waits for another, while `until` allows, then reads what that one counted."""
    try:
        import fcntl
    except ImportError:  # no locks here: each count counts on its own
        yield True
        return
    cache_file.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(cache_file.with_suffix(".lock"), os.O_RDWR | os.O_CREAT, 0o644)
    held = False
    try:
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                held = True
                break
            except BlockingIOError:
                if not wait or _past(until):
                    break
                time.sleep(0.2)
            except OSError:  # a disk that keeps no locks: each count counts on its own
                held = True
                break
        yield held
    finally:
        os.close(fd)


def counts(root: Path, rels: list[str], cache_file: Path | None, until: float | None = None) -> dict[str, dict[str, Any]]:
    """{path: {rows, lines, kind}} for each file of `rels` that is `counted`, cached by size and mtime. A PDF has its
    pages as rows and no lines. A file that is not `counted` is left out: it is one whole file by its name alone
    (`whole_file`), never opened or kept in the cache, so a folder of a million screenshots costs nothing here.

    The first count of a big folder reads every file, which takes minutes on a slow disk. Each file is kept as it is
    counted (the journal, `_read_counts`), so a count stopped before its end (Claude Code's time limit, a reload of the
    plugin) keeps what it counted, and the next one goes on from there. One count at a time counts a folder's files
    (`_counting`). `until` (time.monotonic()): the time by which a count stops counting; with files left then, it raises
    Unfinished."""
    rels = [rel for rel in rels if counted(rel)]
    stats: dict[str, tuple[int, int]] = {}
    base = str(root)
    for rel in rels:
        try:
            s = os.stat(f"{base}/{rel}")
        except OSError:
            continue
        stats[rel] = (s.st_size, s.st_mtime_ns)

    def stale(cache: dict[str, Any]) -> list[tuple[str, int, int]]:
        """The files not counted yet, or changed since."""
        return [(r, size, ns) for r, (size, ns) in stats.items() if not ((c := cache.get(r)) and c.get("key") == f"{size}:{ns}")]

    cache, journaled = _read_counts(cache_file) if cache_file else ({}, False)
    todo = stale(cache)
    # a cache that holds files no longer counted (gone, or whole files) is written again without them
    if cache_file and (todo or journaled or cache.keys() - stats.keys()):
        with _counting(cache_file, until, wait=bool(todo)) as held:
            if held and todo:
                # what another count counted while this one waited
                cache, _ = _read_counts(cache_file)
                todo = stale(cache)
                fd = os.open(cache_file.with_suffix(".jsonl"), os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o644)
                try:
                    for rel, c in _count_many(root, todo, until):
                        cache[rel] = c
                        os.write(fd, (json.dumps([rel, c]) + "\n").encode())
                finally:
                    os.close(fd)
                todo = stale(cache)
            if held and not todo:
                # every file counted: one whole count, the journal folded into it
                tmp = cache_file.with_name(f"{cache_file.name}.{os.getpid()}.tmp")
                tmp.write_text(json.dumps({r: cache[r] for r in stats if r in cache}))
                os.replace(tmp, cache_file)
                cache_file.with_suffix(".jsonl").unlink(missing_ok=True)
    elif todo:
        cache.update((rel, c) for rel, c in _count_many(root, todo, until))
        todo = stale(cache)
    if todo:
        raise Unfinished(len(stats) - len(todo), len(stats))
    return {r: cache[r] for r in rels if r in stats}


def expand_glob(root: Path, pattern: str) -> list[str]:
    """Source files under root that a path or glob names, relative, sorted. A file in thimble's temp folder (a file
    Claude derived for the session, store.in_temp) is named by its absolute real path: it belongs to the root's labels
    though it lies outside the root. A relative pattern that names nothing under the root is read from the working
    folder when that is a temp folder (`cd $TMPDIR && thimble label … --in rows.jsonl`)."""
    import glob

    from .store import in_temp

    pattern = pattern.strip()
    if pattern.startswith("./"):
        pattern = pattern[2:]
    hits = sorted(glob.glob(str(root / pattern), recursive=True))
    if not hits and not os.path.isabs(pattern) and in_temp(os.getcwd()):
        hits = sorted(glob.glob(os.path.join(os.getcwd(), pattern), recursive=True))
    out = []
    for h in hits:
        if os.path.isfile(h):
            rel = os.path.relpath(h, root)
            if (rel == ".." or rel.startswith("../")) and in_temp(h):
                out.append(os.path.realpath(h))
            elif not any(part in SKIP_DIRS for part in Path(rel).parts[:-1]):
                out.append(rel)
    return out


# ------------------------------------------------------------------ fetching rows by ref


def _content_block(b: Any) -> dict[str, str] | None:
    """One content block of a chat message as {kind, text} (from 0.9.0's refs._content_block)."""
    if not isinstance(b, dict):
        return {"kind": "raw", "text": json.dumps(b, ensure_ascii=False)}
    t = b.get("type")
    if t == "text":
        return {"kind": "text", "text": str(b.get("text") or "")}
    if t == "tool_use":
        return {"kind": "tool_use", "text": f"{b.get('name')}\n{json.dumps(b.get('input'), indent=2, ensure_ascii=False)}"}
    if t == "tool_result":
        c = b.get("content")
        if isinstance(c, list):
            text = "\n".join(str(x.get("text") or "") for x in c if isinstance(x, dict) and x.get("type") == "text")
        else:
            text = str(c or "")
        return {"kind": "tool_result", "text": text}
    if t == "thinking":
        return {"kind": "thinking", "text": str(b.get("thinking"))} if b.get("thinking") else None
    return {"kind": "raw", "text": json.dumps(b, ensure_ascii=False)}


def blocks_of(record: Any) -> list[dict[str, str]]:
    """A transcript record's content blocks, in order: its words, tool calls, tool results and reasoning."""
    if isinstance(record, dict) and record.get("type") in ("assistant", "user"):
        msg = record.get("message")
        if isinstance(msg, dict):
            c = msg.get("content")
            if isinstance(c, str):
                return [{"kind": "text", "text": c}]
            if isinstance(c, list):
                return [b for b in map(_content_block, c) if b is not None]
    return [{"kind": "raw", "text": json.dumps(record, ensure_ascii=False) if not isinstance(record, str) else record}]


# ------------------------------------------------------------------ what a row says, in words

# what a file kind's rows are called: records of JSON and JSONL, rows of a table, lines of text; a Markdown file's
# sections and a diff's hunks are what a label or a count goes over, though coverage counts both in lines
UNIT_OF_KIND = {"jsonl": "records", "transcript": "records", "json": "records", "csv": "rows", "sqlite": "rows",
                "markdown": "lines", "diff": "lines", "text": "lines", "pdf": "pages"}
ROW_WORD = {"markdown": "sections", "diff": "hunks"}


def entry_word(kind: str | None) -> str | None:
    """What one file kind's entries are called: records of JSON and JSONL, rows of a table, lines of text (a Markdown
    file's sections, a diff's hunks); None for a file with no entries (an image, a PDF)."""
    unit = ROW_WORD.get(kind or "") or UNIT_OF_KIND.get(kind or "")
    return unit if unit in ("records", "rows", "lines", "sections", "hunks") else None


# the fields that hold a record's words, best first; then the fields that say whose and where it is (the shell's detail
# view shows `words` and `meta`; `text` stays the excerpt the CLI prints)
WORD_KEYS = ("text", "quote", "summary", "title", "message", "msg", "body", "content", "comment", "description", "subject",
             "note", "change_summary", "reason", "answer", "question", "prompt")
META_KEYS = ("user", "author", "agent", "sender", "name", "label", "page", "run", "step", "epoch", "rev", "kind", "type",
             "event_type", "activity", "day", "date", "time")


def _long_words(v: dict[str, Any]) -> list[tuple[str, str]]:
    """A record's fields whose values read as words: strings of several words, in a field that is no id or path. A
    time stamp (`2026-06-01 15:19:25.769`) has a space but no words: the rows are never named by it."""
    return [(k, x) for k, x in v.items() if isinstance(x, str) and len(x.strip()) >= 16 and " " in x.strip()
            and len(re.findall(r"[^\W\d_]{2,}", x)) >= 2 and not re.search(r"(id|uuid|ref|hash|key|url|path)$", k, re.I)]


def word_key(rows: list[Row]) -> str | None:
    """The field rows of one file read as words when no field by a known name holds them: the one their longest words
    are in most often. A row is then named by that field like the rows beside it, never by another field that happens
    to be longer in it (a passenger by a ticket number such as "SOTON/O.Q. 3101312")."""
    count: dict[str, int] = defaultdict(int)
    for row in rows:
        v = row.value
        if not isinstance(v, dict) or any(isinstance(v.get(k), str) and v[k].strip() for k in WORD_KEYS):
            continue
        long = _long_words(v)
        if long:
            count[max(long, key=lambda kv: len(kv[1]))[0]] += 1
    return max(count, key=lambda k: count[k]) if count else None


def words_by_file(rows: list[Row]) -> dict[str, tuple[str, str]]:
    """words_of for each of several rows, by ref: the rows of each file named by one field (word_key)."""
    by: dict[str, list[Row]] = defaultdict(list)
    for row in rows:
        by[row.ref.split("#")[0]].append(row)
    out: dict[str, tuple[str, str]] = {}
    for group in by.values():
        prefer = word_key(group)
        for row in group:
            out[row.ref] = words_of(row, prefer)
    return out


def words_of(row: Row, prefer: str | None = None) -> tuple[str, str]:
    """A row as a person reads it: its meaningful words (its text, title, summary, message, body and the like; a
    transcript row's first words or tool call) and a short line of whose and where it is. ('', '') when nothing in it
    reads as words. `prefer`: the field the rows of its file read as words (word_key), taken before the row's own
    longest words."""
    v = row.value
    one = lambda x: " ".join(str(x).split())  # noqa: E731
    if isinstance(v, str):
        return one(v)[:240], ""
    if not isinstance(v, dict):
        return "", ""
    words, key = "", None
    if v.get("type") in ("assistant", "user") and isinstance(v.get("message"), dict):
        content = v["message"].get("content")
        for b in (content if isinstance(content, list) else [{"type": "text", "text": content}]):
            if not isinstance(b, dict):
                continue
            if b.get("type") == "text" and str(b.get("text") or "").strip():
                words = one(b["text"])
            elif b.get("type") == "tool_use":
                i = b.get("input") if isinstance(b.get("input"), dict) else {}
                arg = next((i[k] for k in ("command", "file_path", "pattern", "path", "description", "query") if i.get(k)), "")
                words = one(f"{b.get('name')}: {arg}" if arg else f"{b.get('name')}: {json.dumps(i, ensure_ascii=False)}")
            elif b.get("type") == "tool_result":
                c = b.get("content")
                words = one(c if isinstance(c, str) else " ".join(str(x.get("text") or "") for x in c or [] if isinstance(x, dict)))
            if words:
                break
        if words:
            t = str(v.get("timestamp") or "")
            return (words if len(words) <= 240 else words[:239] + "…"), " · ".join(x for x in (v["type"], t[11:16]) if x)
        return "", ""
    if not words:
        key = next((k for k in WORD_KEYS if isinstance(v.get(k), str) and v[k].strip()), None)
        if key:
            words = one(v[key])
    if not words and prefer and isinstance(v.get(prefer), str) and v[prefer].strip():
        key = prefer
        words = one(v[prefer])
    if not words:
        long = _long_words(v)
        if long:
            key, x = max(long, key=lambda kv: len(kv[1]))
            words = one(x)
    used: set[str] = {key} if key else set()
    if not words:
        # an event row with no sentence in it (a request, a state change): what happened, from its short words, as
        # "request · browse-bare · wiki dse", never its ids or its time
        kinds, rest = [], []
        for k, x in v.items():
            if not isinstance(x, str) or not x.strip() or len(x) > 60 or re.search(r"(^|_)(id|uuid|ref|hash|key|url|path|sha)$", k, re.I):
                continue
            if re.match(r"^\d{4}-\d\d-\d\d([T ]\d\d:\d\d)?", x) or k in ("time", "date", "timestamp", "ts"):
                continue
            (kinds if re.search(r"(^|_)(type|kind|action|activity|status|outcome|result|event)$", k, re.I) else rest).append((k, x))
        # only a row that says what kind of thing happened reads as words; a row of plain values reads as a table
        if kinds:
            picked = (kinds + rest)[:4]
            used.update(k for k, _ in picked)
            words = " · ".join(one(x) if (k, x) in kinds else f"{k} {one(x)}" for k, x in picked)
    if not words:
        return "", ""
    meta = []
    for k in META_KEYS:
        x = v.get(k)
        if len(meta) >= 3:
            break
        if k in used or x in (None, "") or isinstance(x, (dict, list)) or len(one(x)) > 40:
            continue
        meta.append(f"{k} {x}" if isinstance(x, (int, float)) and not isinstance(x, bool) else one(x))
    return (words if len(words) <= 240 else words[:239] + "…"), " · ".join(meta)
