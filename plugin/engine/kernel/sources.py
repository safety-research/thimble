"""Sources: anything Claude can read, each kind with an adapter that gives its rows with stable ids (refs.py).

    kind        files                                 a row is                          its ref
    jsonl       .jsonl .ndjson                        one line (one record)             <path>#L<n>
    transcript  a jsonl of chat records               one line (one message or event)   <path>#L<n>
    csv         .csv .tsv                             one row after the header          <path>#row=<n>
    json        .json                                 one item of its largest list      <path>#/<key>/<i>
    sqlite      .db .sqlite .sqlite3                  one row of a table                <path>#<table>/<rowid>
    markdown    .md .markdown .rst                    one section (a heading and text)  <path>#L<a>-<b>
    diff        .diff .patch                          one hunk                          <path>#L<a>-<b>
    text        code, logs, config, .txt              one line                          <path>#L<n>

Coverage also counts the files that have no rows, each in its own unit: a PDF by its pages, and an image, a sound, a
video or any other file as one whole file (`file_kind`, `list_files`).

A ref stays the same when the analysis runs again on the same file. Each row also has a content hash (`row_hash`), so a
citation can tell when its row changed or moved. Files under the thimble/ record folder, version control and
dependency folders are never sources.
"""
from __future__ import annotations

import csv
import hashlib
import json
import os
import re
import sqlite3
import sys
import time
from collections import Counter, defaultdict
from contextlib import closing
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterator

from . import refs as R

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


def row_hash(raw: str) -> str:
    return hashlib.sha1(raw.encode("utf-8", "surrogatepass")).hexdigest()[:12]


def kind_of(path: Path) -> str | None:
    ext = path.suffix.lower()
    if ext in KIND_OF_EXT:
        return KIND_OF_EXT[ext]
    if ext in TEXT_EXT or (not ext and path.name in ("Makefile", "Dockerfile", "README", "LICENSE")):
        return "text"
    return None


def list_sources(root: Path) -> list[str]:
    """Every source file under root, relative, sorted."""
    out = []
    for d, dirs, files in os.walk(root):
        dirs[:] = sorted(x for x in dirs if x not in SKIP_DIRS and not x.startswith("."))
        for f in files:
            p = Path(d) / f
            if kind_of(p) and not p.is_symlink():
                out.append(os.path.relpath(p, root))
    return sorted(out)


def file_kind(path: Path) -> str:
    """A file's kind for coverage: its source kind, else pdf, image, audio or video by its extension, else file."""
    return kind_of(path) or MEDIA_KIND.get(path.suffix.lower(), "file")


def list_files(root: Path) -> list[str]:
    """Every file under root that coverage counts, relative, sorted: the sources, and the other files that are not
    hidden (a PDF, an image, a binary), under the same folders list_sources walks."""
    out: list[str] = []

    # by os.scandir and plain strings: a folder of 100,000 files is walked in well under a second
    def walk(d: str, rel: str) -> None:
        try:
            entries = list(os.scandir(d))
        except OSError:
            return
        dirs = []
        for e in entries:
            try:
                if e.is_symlink():
                    continue
                if e.is_dir(follow_symlinks=False):
                    dirs.append(e.name)
                elif not (e.name.startswith(".") and not kind_of(Path(e.name))):
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


def fingerprint(p: Path) -> dict[str, Any]:
    """What tells a later run that the file changed: size, mtime, and a hash of its first and last 64 KiB."""
    st = p.stat()
    h = hashlib.sha1()
    with open(p, "rb") as f:
        h.update(f.read(65536))
        if st.st_size > 65536:
            f.seek(max(65536, st.st_size - 65536))
            h.update(f.read(65536))
    return {"size": st.st_size, "mtime": st.st_mtime_ns, "head_tail": h.hexdigest()[:12]}


def same_file(p: Path, fp: dict[str, Any] | None) -> bool:
    if not fp:
        return True
    try:
        st = p.stat()
    except OSError:
        return False
    if st.st_size != fp.get("size"):
        return False
    if st.st_mtime_ns == fp.get("mtime"):
        return True
    return fingerprint(p).get("head_tail") == fp.get("head_tail")


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


def one_document(p: Path) -> bool:
    """Whether a .json file holds one JSON value (a document), not one value per line. Read from its first 64 KiB: a
    file whose first line is a whole value and goes on after it holds one value per line."""
    try:
        with open(p, "rb") as f:
            head = f.read(65536)
    except OSError:
        return False
    first, _, rest = head.lstrip().partition(b"\n")
    if not rest.strip():
        return True
    try:
        json.loads(first)
    except ValueError:
        return True
    return False


def document_ref(root: Path, ref: str) -> str:
    """A whole-file ref of a JSON document as its root row (`x.json` is `x.json#/`): a file that is one JSON document is
    one row. Any other ref as it is."""
    if "#" in ref or not ref.lower().endswith(".json"):
        return ref
    p = root / ref
    return f"{ref}#/" if p.is_file() and one_document(p) else ref


def _pointer_get(v: Any, pointer: str) -> Any:
    for part in pointer.split("/")[1:]:
        part = part.replace("~1", "/").replace("~0", "~")
        v = v[int(part)] if isinstance(v, list) else v[part]
    return v


def table_names(root: Path, rel: str) -> list[str]:
    """The tables of a database, by name; none for a file that is not one."""
    if kind_of_file(root, rel) != "sqlite":
        return []
    with closing(sqlite3.connect(f"file:{root / rel}?mode=ro", uri=True)) as con:
        return [t for (t,) in con.execute("select name from sqlite_master where type='table' and name not like 'sqlite_%' order by name").fetchall()]


def iter_rows(root: Path, rel: str, table: str | None = None) -> Iterator[Row]:
    """Every row of one source file, in file order."""
    p = root / rel
    kind = kind_of_file(root, rel)
    if kind in ("jsonl", "transcript"):
        with open(p, "r", errors="replace") as f:
            for i, line in enumerate(f, 1):
                line = line.rstrip("\n")
                if not line.strip():
                    continue
                try:
                    v = json.loads(line)
                except ValueError:
                    v = {"_text": line}
                yield Row(f"{rel}#L{i}", line, v)
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
        with closing(sqlite3.connect(f"file:{p}?mode=ro", uri=True)) as con:
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
    with closing(sqlite3.connect(f"file:{p}?mode=ro", uri=True)) as con:
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


def _count_one(args: tuple[str, str]) -> int:
    return count_rows(Path(args[0]), args[1])


def _count_many(root: Path, rels: list[str], sizes: dict[str, int]) -> dict[str, int]:
    """Rows of many files: in up to 8 worker processes when they are big together (Linux), else one after another."""
    if len(rels) > 1 and sum(sizes.get(r, 0) for r in rels) >= PARALLEL_MIN and sys.platform.startswith("linux"):
        n = max(1, min(8, (os.cpu_count() or 2) - 1, len(rels)))
        if n > 1:
            try:
                import multiprocessing as mp
                from concurrent.futures import ProcessPoolExecutor

                order = sorted(rels, key=lambda r: -sizes.get(r, 0))
                with ProcessPoolExecutor(max_workers=n, mp_context=mp.get_context("fork")) as ex:
                    return dict(zip(order, ex.map(_count_one, [(str(root), r) for r in order], chunksize=4)))
            except Exception:  # noqa: BLE001 — counted one after another below
                pass
    return {r: count_rows(root, r) for r in rels}


def counts(root: Path, rels: list[str], cache_file: Path | None) -> dict[str, dict[str, Any]]:
    """{path: {rows, lines, kind}} for each file, cached by size and mtime. A file that is no source has its kind
    (pdf, image, audio, video, file), its pages or 1 as rows, and no lines."""
    cache: dict[str, Any] = {}
    if cache_file:
        try:
            cache = json.loads(cache_file.read_text())
        except (OSError, ValueError):
            cache = {}
    out, changed = {}, False
    # the files not counted yet (or changed since), counted together first
    stats: dict[str, Any] = {}
    base = str(root)
    for rel in rels:
        try:
            stats[rel] = os.stat(f"{base}/{rel}")
        except OSError:
            continue
    todo = [r for r, st in stats.items() if not ((c := cache.get(r)) and c.get("key") == f"{st.st_size}:{st.st_mtime_ns}")]
    fresh = _count_many(root, todo, {r: stats[r].st_size for r in todo}) if todo else {}
    for rel in rels:
        st = stats.get(rel)
        if st is None:
            continue
        key = f"{st.st_size}:{st.st_mtime_ns}"
        c = cache.get(rel)
        if c and c.get("key") == key:
            out[rel] = c
            continue
        p = root / rel
        kind = kind_of_file(root, rel) or file_kind(p)
        rows = fresh[rel] if rel in fresh else count_rows(root, rel)
        lines = rows if kind in ("jsonl", "transcript", "text") else (count_lines(p) if kind in ("markdown", "diff", "csv", "json") and st.st_size < 256 * 1024 * 1024 else 0)
        c = {"key": key, "kind": kind, "rows": rows, "lines": lines, "size": st.st_size}
        cache[rel] = c
        out[rel] = c
        changed = True
    if changed and cache_file:
        cache_file.parent.mkdir(parents=True, exist_ok=True)
        tmp = cache_file.with_suffix(".tmp")
        tmp.write_text(json.dumps(cache))
        os.replace(tmp, cache_file)
    return out


def group_of(files: list[str]) -> dict[str, str]:
    """A pattern per file (from thimble-lite): a folder level with 4 or more sibling folders reads `*`, and 6 or more
    files of one extension in one folder read `*.ext`, so runs/a/agents/x.jsonl reads runs/*/agents/*.jsonl."""
    kids: dict[str, set[str]] = defaultdict(set)
    files_in: dict[tuple[str, str], int] = defaultdict(int)
    for f in files:
        parts = f.split("/")
        for i in range(len(parts) - 1):
            kids["/".join(parts[:i])].add(parts[i])
        files_in[("/".join(parts[:-1]), Path(f).suffix)] += 1
    out = {}
    for f in files:
        parts = f.split("/")
        pat = []
        for i in range(len(parts) - 1):
            pat.append("*" if len(kids["/".join(parts[:i])]) >= 4 else parts[i])
        ext = Path(f).suffix
        pat.append(f"*{ext}" if files_in[("/".join(parts[:-1]), ext)] >= 6 else parts[-1])
        out[f] = "/".join(pat)
    return out


def _shape(name: str) -> str:
    """A folder's name with its numbers and ids read as `#`: run-003 and run-017 have one shape."""
    return re.sub(r"[0-9a-f]{6,}|\d+", "#", name.lower())


def pattern_of(files: list[str], alike: float = 0.6, many: int = 4) -> dict[str, str]:
    """A wildcard pattern per file, for the coverage pane: a folder level reads `*` where it has `many` or more sibling
    folders and most of them look alike (`alike` of them share a name shape, run-001 and run-002, or hold the same
    names and file types), so runs/r1/agents/a.jsonl reads runs/*/agents/*.jsonl while backend/ and frontend/ keep
    their names; three or more files of one type in one (pattern) folder read `*.ext`."""
    kids: dict[str, set[str]] = defaultdict(set)
    sig: dict[str, set[str]] = defaultdict(set)
    for f in files:
        parts = f.split("/")
        for i in range(len(parts) - 1):
            parent = "/".join(parts[:i])
            kids[parent].add(parts[i])
            if i:
                sig["/".join(parts[:i])].add(parts[i] + "/")
        sig["/".join(parts[:-1])].add(Path(f).suffix or parts[-1])
    star: dict[str, bool] = {}
    for parent, names in kids.items():
        if len(names) < many:
            star[parent] = False
            continue
        join = (lambda n: f"{parent}/{n}" if parent else n)
        shapes = Counter(_shape(n) for n in names)
        sigs = Counter(frozenset(sig[join(n)]) for n in names)
        star[parent] = max(shapes.values()) >= alike * len(names) or max(sigs.values()) >= alike * len(names)
    folder: dict[str, str] = {}
    for f in files:
        parts = f.split("/")
        pat = [("*" if star.get("/".join(parts[:i])) else parts[i]) for i in range(len(parts) - 1)]
        folder[f] = "/".join(pat)
    names_in: dict[tuple[str, str], set[str]] = defaultdict(set)
    for f in files:
        names_in[(folder[f], Path(f).suffix)].add(f.split("/")[-1])
    out = {}
    for f in files:
        ext, name = Path(f).suffix, f.split("/")[-1]
        leaf = f"*{ext}" if ext and len(names_in[(folder[f], ext)]) >= 3 else name
        out[f] = f"{folder[f]}/{leaf}" if folder[f] else leaf
    return out


def expand_glob(root: Path, pattern: str) -> list[str]:
    """Source files under root that a path or glob names, relative, sorted."""
    import glob

    pattern = pattern.strip()
    if pattern.startswith("./"):
        pattern = pattern[2:]
    hits = sorted(glob.glob(str(root / pattern), recursive=True))
    out = []
    for h in hits:
        if os.path.isfile(h):
            rel = os.path.relpath(h, root)
            if not any(part in SKIP_DIRS for part in Path(rel).parts[:-1]):
                out.append(rel)
    return out


# ------------------------------------------------------------------ fetching rows by ref


def _flat_text(v: Any) -> str:
    out: list[str] = []

    def walk(x: Any) -> None:
        if isinstance(x, str):
            out.append(x)
        elif isinstance(x, dict):
            for y in x.values():
                walk(y)
        elif isinstance(x, list):
            for y in x:
                walk(y)
        elif x is not None:
            out.append(str(x))

    walk(v)
    return "\n".join(out)


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


_FILES: dict[str, tuple[float, list[str]]] = {}  # root -> (when it was listed, its files), for a few seconds


def locate(root: Path, rel: str) -> str:
    """The path under root of the file a ref names. A path may start in a subfolder, where a session ran `cd`: when
    root/rel is no file, the one file under root whose path ends with /rel is the one meant. Raises RefError when no
    file ends so, or several do."""
    if (root / rel).is_file():
        return rel
    tail = "/" + rel.removeprefix("./")
    when, files = _FILES.get(str(root), (0.0, []))
    if time.monotonic() - when > 5:
        files = list_files(root)
        _FILES[str(root)] = (time.monotonic(), files)
    hits = [f for f in files if f.endswith(tail)]
    if len(hits) == 1 and (root / hits[0]).is_file():
        return hits[0]
    if len(hits) > 1:
        more = f", and {len(hits) - 3} more" if len(hits) > 3 else ""
        raise R.RefError(f"no file {rel} under {root}, and {len(hits)} files end with {tail}: {', '.join(hits[:3])}{more}")
    raise R.RefError(f"no file {rel} under {root}")


def fetch(root: Path, rowset: str, limit: int | None = None) -> list[Row]:
    """The rows one source ref or row set names, in file order (at most `limit`). The rows name the file by its path
    under root (`locate`). Raises RefError when the file is missing or a row is not there."""
    p = R.parse(rowset)
    k = p["kind"]
    if k in ("query", "object"):
        raise R.RefError(f"{rowset} is not a source ref")
    rel = locate(root, p.get("path", ""))
    path = root / rel
    if k == "file":
        return [Row(rel, "", {"path": rel})]
    if k == "block":
        rows = fetch(root, f"{rel}#L{p['line']}")
        bl = blocks_of(rows[0].value)
        if p["block"] >= len(bl):
            raise R.RefError(f"{rel}#L{p['line']} has {len(bl)} blocks, no block {p['block']}")
        b = bl[p["block"]]
        return [Row(rowset, b["text"], b)]
    if k == "blocks":
        # each record read once, for as many of its blocks as the set names (up to `limit` blocks in all)
        want: list[tuple[int, int]] = []
        for pair in R.block_pairs(p):
            want.append(pair)
            if limit and len(want) >= limit:
                break
        recs = {r.ref: r for r in fetch(root, f"{rel}#L{R.format_nums([x for x, _ in want])}")}
        got = []
        for line, block in want:
            bl = blocks_of(recs[f"{rel}#L{line}"].value)
            if block >= len(bl):
                raise R.RefError(f"{rel}#L{line} has {len(bl)} blocks, no block {block}")
            got.append(Row(f"{rel}#L{line}.b{block}", bl[block]["text"], bl[block]))
        return got
    kind = kind_of_file(root, rel)
    if k == "lines":
        want = set(p["nums"])
        if kind in ("markdown", "diff", "text") or kind is None:
            # a section, a hunk or a run of lines reads as one row: each run of consecutive lines is one
            lines: dict[int, str] = {}
            top = max(want)
            with open(path, "r", errors="replace") as f:
                for i, line in enumerate(f, 1):
                    if i in want:
                        lines[i] = line.rstrip("\n")
                    if i >= top:
                        break
            if len(lines) < len(want):
                raise R.RefError(f"{rel} has no line {min(want - set(lines))}")
            got = []
            for run in R.format_nums(sorted(want)).split(","):
                a, _, b = run.partition("-")
                lo, hi = int(a), int(b or a)
                body = "\n".join(lines[i] for i in range(lo, hi + 1))
                got.append(Row(f"{rel}#L{lo}" + (f"-{hi}" if hi > lo else ""), body, body))
                if limit and len(got) >= limit:
                    break
            return got
        if kind in ("jsonl", "transcript", "json"):
            # a line of a JSON document is a line of its text: one that holds a whole value (a document on one line,
            # a .json file of one record per line) reads as that value
            got = []
            top = max(want)
            with open(path, "r", errors="replace") as f:
                for i, line in enumerate(f, 1):
                    if i in want:
                        line = line.rstrip("\n")
                        try:
                            v: Any = json.loads(line)
                        except ValueError:
                            v = {"_text": line}
                        got.append(Row(f"{rel}#L{i}", line, v))
                        if limit and len(got) >= limit:
                            break
                    if i >= top:
                        break
            if len(got) < len(want) and not (limit and len(got) >= limit):
                missing = sorted(want - {int(r.ref.rsplit("#L", 1)[1]) for r in got})
                raise R.RefError(f"{rel} has no line {missing[0]}")
            return got
    if k == "csvrows":
        want = set(p["nums"])
        got = []
        with open(path, newline="", errors="replace") as f:
            for i, row in enumerate(csv.DictReader(f, delimiter="\t" if path.suffix.lower() == ".tsv" else ","), 1):
                if i in want:
                    got.append(Row(f"{rel}#row={i}", json.dumps(row, ensure_ascii=False), row))
                    if limit and len(got) >= limit:
                        break
        if len(got) < len(want) and not (limit and len(got) >= limit):
            raise R.RefError(f"{rel} has fewer rows than {max(want)}")
        return got
    if k == "pointer":
        try:
            doc = json.loads(path.read_text(errors="replace"))
        except ValueError as e:
            raise R.RefError(f"{rel} is not one JSON document ({e}): its rows are lines, as {rel}#L1") from e
        ptrs = [f"{p['prefix']}{n}" for n in p["nums"]] if "nums" in p else [p["pointer"]]
        got = []
        for ptr in ptrs:
            try:
                v = _pointer_get(doc, ptr) if ptr != "/" else doc
            except (KeyError, IndexError, ValueError, TypeError):
                raise R.RefError(f"{rel} has no value at {ptr}")
            got.append(Row(f"{rel}#{ptr}", json.dumps(v, ensure_ascii=False), v))
            if limit and len(got) >= limit:
                break
        return got
    if k in ("dbrows", "table"):
        with closing(sqlite3.connect(f"file:{path}?mode=ro", uri=True)) as con:
            con.row_factory = sqlite3.Row
            t = p["table"]
            if not con.execute("select 1 from sqlite_master where type='table' and name=?", (t,)).fetchone():
                raise R.RefError(f"{rel} has no table {t}")
            if k == "table":
                n = con.execute(f'select count(*) from "{t}"').fetchone()[0]
                return [Row(rowset, "", {"table": t, "rows": n})]
            keys = p.get("nums") or p.get("keys") or []
            got = []
            for key in keys:
                r = con.execute(f'select * from "{t}" where rowid = ?', (key,)).fetchone()
                if r is None:
                    raise R.RefError(f"{rel} has no row {key} in {t}")
                d = dict(r)
                got.append(Row(f"{rel}#{t}/{key}", json.dumps(d, ensure_ascii=False, default=str), d))
                if limit and len(got) >= limit:
                    break
            return got
    raise R.RefError(f"cannot read {rowset}")


def text_of(row: Row) -> str:
    """Every string of a row, joined: what a quote is looked for in."""
    if isinstance(row.value, str):
        return row.value
    return _flat_text(row.value) + "\n" + row.raw


def find_quote(text: str, quote: str) -> bool:
    """Whether a quote is in a text: as written, as JSON escapes it, or with whitespace folded and case ignored; an
    ellipsis splits it into parts that must all be there, in order (from 0.9.0's refs._find_quote)."""
    q = quote.strip().strip('"').strip()
    if not q:
        return False
    tr = str.maketrans({"“": '"', "”": '"', "‘": "'", "’": "'", "—": "-", "–": "-"})
    fold = lambda s: " ".join(s.translate(tr).split()).lower()  # noqa: E731
    parts = [x.strip(" ,;:") for x in re.split(r"\s*(?:\.\.\.|…|\[\.\.\.\]|\[…\])\s*", q) if x.strip(" ,;:")]
    hay = fold(text)
    at = 0
    for part in parts:
        if part in text or json.dumps(part, ensure_ascii=False)[1:-1] in text:
            continue
        i = hay.find(fold(part), at)
        if i < 0:
            return False
        at = i
    return True


def relocate(root: Path, ref: str, h: str, window: int = 100000) -> str | None:
    """Where a one-row ref's row went when its hash no longer matches: the ref of the row in the same file whose
    content hash is `h`, or None."""
    p = R.parse(ref)
    rel = p.get("path", "")
    if not (root / rel).is_file():
        return None
    for n, row in enumerate(iter_rows(root, rel)):
        if n > window:
            break
        if row_hash(row.raw) == h:
            return row.ref
    return None
