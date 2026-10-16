"""Coverage: what this session's tool calls read, searched or never opened in the corpus's data files.

The terminal UI's tracker (plugin/hooks/term/tracker.ts) notes a fact for each data file a tool call of main or of
its subagents touched, and at the end of each turn that has facts it runs `thimble act coverage --stdin` once with them
as JSON on standard input (add_facts). A fact is {path, how, lines?, pages?, total?, folder?, by, at}: `how` is `whole`
(the call showed the whole file), `part` (some of it: `lines` [a, b] of a line-based file, `pages` [a, b] of a PDF) or
`searched` (a search, a count or a script touched its contents without showing them). A `folder` fact (a recursive
`grep -r` or `rg` over a folder) is kept as one fact and stands for every data file under the folder. Facts whose path
is outside the corpus, or that is no data file (is_data), are dropped, and the store holds paths only, never a
command's text. Per session the facts are appended to `<ws>/coverage/<sid>.jsonl`.

Data files only. is_data decides with the rules of the activation trigger (plugin/hooks/term/activate.ts `isDataFile`
is its twin, and both tests read one case list, tests_public/fixtures/data_files.json): never under a tool or build
folder, never a package or lock file, never a code or config file; outside a code tree any data or document type;
inside a code tree (the corpus root holds a project file) only data types, and document types under a data folder.

The universe. A detached job (`python -m app.coverage index --cwd <corpus>`, under `flock <ws>/coverage/index.lock`,
as `nice -n 19 ionice -c3` where those exist) walks the corpus (corpus_walk.walk), keeps one row per data file in
`<ws>/coverage/index.sqlite` keyed by (path, size, mtime), and a totals table per (folder prefix at each depth,
extension) with its files, bytes and records. It then counts the records of the files not yet counted
(records.count), one (folder, extension) group at a time, adding each group's records to the totals as it finishes and
touching `<ws>/coverage/` so the terminal UI reads the summary again. A refresh counts only the files whose size or
mtime changed. A file that cannot be counted counts 0 records, and the job posts the `coverage:count` notice.

Requests never walk or count: summary and rows read the index alone, and start the job (once, under its lock) when the
index is missing or was walked more than STALE_S ago. With no index yet the summary counts files from the facts only
and says `counting`.

Per file: `seen` when a `whole` or `part` fact names it; else `searched` when a `searched` fact names it or a folder
fact is above it; else `never`. Records seen: all of a `whole` file's, the union of a `part` file's line ranges (a
line-based file) or page ranges (a PDF) within its records, else none. The reads of cards made since the session was
turned on (`cell.reads`, the notebook's audit) and the files of labels run since then count as searched.

Rows (rows): at a level with FILE_ROWS data files or fewer, one row per file (seen, then searched, then never, then by
name); otherwise one row per (first path segment under the folder, or `.` for the files directly in it; extension),
largest first, at most ROWS_MAX rows, the rest merged into `other`. A row whose segment is a folder drills in.
"""
from __future__ import annotations

import contextlib
import fcntl
import fnmatch
import json
import logging
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path, PurePosixPath
from typing import Any, Iterable

from . import config
from .ledger import append_jsonl_many

log = logging.getLogger("thimble.coverage")

DIR = "coverage"  # under the workspace
INDEX = "index.sqlite"
LOCK = "index.lock"
STALE_S = 60.0  # a request starts the job when the index was walked longer ago than this
START_DEBOUNCE_S = 5.0  # a process starts the job at most once in this long
FILE_ROWS = 20  # at a level with this many data files or fewer, the rows are files
ROWS_MAX = 10  # rows at most at a level of groups: the largest GROUPS_SHOWN and `other`
GROUPS_SHOWN = 9
OTHER = "other"
NO_EXT = "(none)"
SID_RE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
HOWS = ("whole", "part", "searched")
BYS = ("Read", "Bash", "search", "agent")
COUNT_NOTICE = "coverage:count"  # the notice of files the job could not count (module note)
COUNT_TEXT = "thimble could not count the records of {n} files: {reason}"
RETRY_ACT = "coverage-retry"  # the notice's act that starts the job again

# The data rule (module note). The trigger's lists (plugin/hooks/term/activate.ts) and these are one rule.
DATA_EXTS = frozenset("csv tsv jsonl ndjson parquet arrow feather xlsx sqlite db duckdb json log".split())
DOC_EXTS = frozenset("pdf txt md html htm xml vtt srt eml".split())
ANY_SIZE_EXTS = frozenset("csv tsv jsonl ndjson parquet arrow feather xlsx log".split())  # data in a code tree too
CODE_EXTS = frozenset(("py ts tsx js jsx mjs cjs go rs java c h cpp rb php sh swift kt scala css scss toml ini cfg "
                       "lock yaml yml").split())
NEVER_SEGMENTS = frozenset(("node_modules .git .venv venv dist build .claude tests test fixtures testdata "
                            "__snapshots__ sample samples examples").split())
NEVER_NAMES = ("package*.json", "tsconfig*.json", "*.lock", "composer.json", ".eslintrc*")
DATA_SEGMENTS = frozenset("data datasets runs transcripts traces corpus corpora".split())
CODE_TREE_MARKS = (".git", "package.json", "pyproject.toml", "setup.py", "Cargo.toml", "go.mod", "pom.xml",
                   "build.gradle", "Gemfile", "composer.json")
LINE_READERS = ("lines", "csv")  # the readers whose records are lines, so a `part` fact's line range counts records

_SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, folder TEXT NOT NULL, ext TEXT NOT NULL,
    size INTEGER NOT NULL, mtime INTEGER NOT NULL, records INTEGER, reader TEXT, error TEXT);
CREATE INDEX IF NOT EXISTS files_group ON files(folder, ext);
CREATE TABLE IF NOT EXISTS totals (prefix TEXT NOT NULL, ext TEXT NOT NULL, parent TEXT, files INTEGER NOT NULL,
    bytes INTEGER NOT NULL, records INTEGER NOT NULL, counted INTEGER NOT NULL, PRIMARY KEY (prefix, ext));
CREATE INDEX IF NOT EXISTS totals_parent ON totals(parent);
"""

_started: dict[str, float] = {}  # workspace -> when this process last started the job


# --------------------------------------------------------------------------- the data rule


def ext_of(name: str) -> str:
    """The file name's extension, lowercased, without its dot; '' for none (a dot name like `.env` has none)."""
    base = name.rsplit("/", 1)[-1]
    stem, dot, ext = base.rpartition(".")
    return ext.lower() if dot and stem else ""


def is_data(rel: str, code_tree: bool) -> bool:
    """Whether the corpus-relative path `rel` is a data file whose coverage counts (module note)."""
    parts = PurePosixPath(str(rel or "")).parts
    if not parts or parts[0] in ("/", "..") or ".." in parts:
        return False
    name = parts[-1]
    if any(p in NEVER_SEGMENTS for p in parts[:-1]) or any(fnmatch.fnmatchcase(name, pat) for pat in NEVER_NAMES):
        return False
    ext = ext_of(name)
    if not ext or ext in CODE_EXTS:
        return False
    if not code_tree:
        return ext in DATA_EXTS or ext in DOC_EXTS
    if any(p in DATA_SEGMENTS for p in parts[:-1]) and (ext in DATA_EXTS or ext in DOC_EXTS):
        return True
    return ext in ANY_SIZE_EXTS


def code_tree(root: Path) -> bool:
    """Whether the corpus root holds a project file, so it is a code tree (module note)."""
    return any((root / m).exists() for m in CODE_TREE_MARKS)


def _never_folder(rel: str) -> bool:
    return any(p in NEVER_SEGMENTS for p in PurePosixPath(rel).parts)


# --------------------------------------------------------------------------- places


def coverage_dir(c: str) -> Path:
    d = config.workspace_dir(c) / DIR
    d.mkdir(mode=0o700, exist_ok=True)
    return d


def _facts_file(c: str, sid: str) -> Path:
    if not SID_RE.match(str(sid or "")):
        raise ValueError(f"not a session id: {sid!r}")
    return coverage_dir(c) / f"{sid}.jsonl"


def _homes() -> list[str]:
    """THIMBLE_HOME and CLAUDE_CONFIG_DIR as real paths: no fact under either counts."""
    out = []
    for v in (os.environ.get("THIMBLE_HOME") or "~/.thimble", os.environ.get("CLAUDE_CONFIG_DIR") or ""):
        if v:
            with contextlib.suppress(OSError):
                out.append(os.path.realpath(os.path.expanduser(v)))
    return out


def _inside(path: str, base: str) -> bool:
    return path == base or path.startswith(base.rstrip("/") + "/")


def _corpus_rel(root: str, roots: tuple[str, ...], base: str, path: Any, homes: list[str] | None = None) -> str | None:
    """The path a fact names, relative to the corpus root ('' for the root itself), or None when it is outside the
    corpus or under thimble's home or Claude Code's config (`homes`, _homes). Lexical: a fact names what a call read by
    its path."""
    p = str(path or "").strip()
    if not p or "\0" in p:
        return None
    full = os.path.normpath(p if os.path.isabs(p) else os.path.join(base, p))
    for r in roots:
        if _inside(full, r):
            rel = "" if full == r else full[len(r.rstrip("/")) + 1:]
            break
    else:
        return None
    if any(_inside(full, h) for h in (_homes() if homes is None else homes) if h not in roots):
        return None
    return rel


# --------------------------------------------------------------------------- facts


def _range(v: Any) -> list[int] | None:
    if not isinstance(v, (list, tuple)) or len(v) != 2:
        return None
    try:
        a, b = int(v[0]), int(v[1])
    except (TypeError, ValueError):
        return None
    if a < 1 or b < a:
        return None
    return [a, b]


def clean_facts(c: str, facts: Iterable[Any], cwd: str | None = None) -> list[dict[str, Any]]:
    """The facts as stored: paths relative to the corpus root, each a data file inside the corpus (a folder fact a
    folder inside it), with only the fields of the fact form (module note). Others are dropped."""
    root = config.corpus_dir(c)
    roots = tuple(dict.fromkeys((os.path.normpath(str(root)), os.path.realpath(root))))
    base = os.path.normpath(cwd) if cwd and os.path.isabs(cwd) else str(root)
    tree = code_tree(root)
    homes = _homes()
    out: list[dict[str, Any]] = []
    now = time.time()
    for f in facts if isinstance(facts, (list, tuple)) else ():
        if not isinstance(f, dict):
            continue
        how = str(f.get("how") or "")
        rel = _corpus_rel(roots[0], roots, base, f.get("path"), homes)
        if rel is None or how not in HOWS:
            continue
        by = str(f.get("by") or "")
        try:
            at = float(f.get("at") or now)
        except (TypeError, ValueError):
            at = now
        fact: dict[str, Any] = {"path": rel, "how": how, "by": by if by in BYS else "Read", "at": at}
        if f.get("folder") is True:
            if how != "searched" or (rel and _never_folder(rel)) or not (root / rel).is_dir():
                continue
            fact["folder"] = True
        elif not rel or not is_data(rel, tree):
            continue
        elif how == "part":
            if (lines := _range(f.get("lines"))) is not None:
                fact["lines"] = lines
            elif (pages := _range(f.get("pages"))) is not None:
                fact["pages"] = pages
        if how == "part" and isinstance(f.get("total"), int) and not isinstance(f.get("total"), bool) and f["total"] >= 0:
            fact["total"] = int(f["total"])
        out.append(fact)
    return out


def add_facts(c: str, sid: str, turn: str, facts: Any, cwd: str | None = None) -> dict[str, Any]:
    """Append the turn's facts to the session's store (clean_facts drops the ones that do not count), then the
    session's summary (summary). With the Coverage switch off nothing is kept."""
    path = _facts_file(c, sid)
    kept = clean_facts(c, facts, cwd) if feature_on(c) else []
    t = str(turn or "")[:128]
    if kept:
        append_jsonl_many(path, ({**f, **({"turn": t} if t else {})} for f in kept))
    return summary(c, sid)


def read_facts(c: str, sid: str) -> list[dict[str, Any]]:
    """The session's facts as stored, oldest first; a torn or foreign line is skipped."""
    try:
        text = _facts_file(c, sid).read_text("utf-8")
    except (OSError, ValueError):
        return []
    out = []
    for line in text.splitlines():
        try:
            f = json.loads(line)
        except ValueError:
            continue
        if isinstance(f, dict) and isinstance(f.get("path"), str) and f.get("how") in HOWS:
            out.append(f)
    return out


def _since(sid: str, facts: list[dict[str, Any]]) -> float | None:
    """When thimble was turned on in the session: its session marker's `at` (<home>/up/<sid>.active), else the time of
    its first fact."""
    home = Path(os.environ.get("THIMBLE_HOME") or "~/.thimble").expanduser()
    with contextlib.suppress(OSError, ValueError, TypeError):
        at = json.loads((home / "up" / f"{sid}.active").read_text("utf-8")).get("at")
        if isinstance(at, (int, float)):
            return float(at)
    times = [float(f["at"]) for f in facts if isinstance(f.get("at"), (int, float))]
    return min(times) if times else None


def _epoch(ts: Any) -> float | None:
    if isinstance(ts, (int, float)):
        return float(ts)
    with contextlib.suppress(TypeError, ValueError):
        return datetime.fromisoformat(str(ts).replace("Z", "+00:00")).timestamp()
    return None


def _glob_area(pattern: str) -> tuple[str, str | None] | None:
    """A label's file pattern (fnmatch, `*` spans `/`, as concepts.match_paths reads it) as a searched area: (folder,
    extension or None) for `agents/*`, `agents/**/*`, `agents/*.jsonl`, `**/*.jsonl` and the like; None for a pattern
    of another form, such as a wildcard inside a name (`agents/agent-*.jsonl`)."""
    p = pattern.strip().strip("/")
    at = [i for i in (p.find(ch) for ch in "*?[") if i >= 0]
    if not at:
        return None
    head, rest = p[:min(at)], p[min(at):]
    if head and not head.endswith("/"):
        return None
    folder = head.rstrip("/")
    if rest in ("*", "**", "**/*"):
        return folder, None
    m = re.fullmatch(r"(?:\*\*/)?\*\.([A-Za-z0-9]+)", rest)
    return (folder, m.group(1).lower()) if m else None


def _derived(c: str, since: float | None) -> tuple[set[str], list[tuple[str, str | None]], list[str]]:
    """(files, areas, patterns) searched by the cards made and the labels run since `since`: the cards' recorded reads
    (a card whose reads were capped searched the folders they fall in), the labels' file patterns (a plain path is a
    file, `<folder>/**` or `<folder>/**/*.ext` an area, anything else a pattern matched over the index)."""
    files: set[str] = set()
    areas: list[tuple[str, str | None]] = []
    patterns: list[str] = []
    if since is None:
        return files, areas, patterns
    ws = config.workspace_dir(c)
    root = config.corpus_dir(c)
    try:
        from . import notebook  # noqa: PLC0415 — notebook imports the kernel machinery

        for _, nb in notebook._stored(ws):
            for cell in nb.get("cells") or []:
                if not isinstance(cell, dict) or (_epoch(cell.get("ts")) or 0) < since:
                    continue
                reads = [str(r).removeprefix("./") for r in cell.get("reads") or [] if isinstance(r, str)]
                files.update(reads)
                if cell.get("reads_more"):  # its reads were capped: the folders they fall in, but never the whole corpus
                    areas.extend((d, None) for d in {os.path.dirname(r) for r in reads} if d)
    except Exception:  # noqa: BLE001 — coverage without the cards' reads still answers
        log.debug("%s: the cards' reads were not read for coverage", c, exc_info=True)
    try:
        from . import concepts  # noqa: PLC0415

        for concept in concepts.list_concepts(ws):
            for app in concept.get("applications") or []:
                if not isinstance(app, dict) or (_epoch(app.get("ts")) or 0) < since:
                    continue
                pats = app.get("paths") or concept.get("glob") or []
                for pat in [pats] if isinstance(pats, str) else pats:
                    pat = str(pat or "").partition("#")[0].strip().removeprefix("./").strip("/")
                    if not pat:
                        continue
                    if not any(ch in pat for ch in "*?["):
                        if (root / pat).is_dir():
                            areas.append((pat, None))
                        else:
                            files.add(pat)
                    elif (area := _glob_area(pat)) is not None:
                        areas.append(area)
                    else:
                        patterns.append(pat)
    except Exception:  # noqa: BLE001
        log.debug("%s: the labels' runs were not read for coverage", c, exc_info=True)
    return files, areas, patterns


# --------------------------------------------------------------------------- the index


def index_path(c: str) -> Path:
    return coverage_dir(c) / INDEX


def _connect_ro(p: Path) -> sqlite3.Connection | None:
    if not p.is_file():
        return None
    try:
        conn = sqlite3.connect(f"file:{p}?mode=ro", uri=True, timeout=5.0)
        conn.execute("SELECT 1 FROM meta LIMIT 1")
        return conn
    except sqlite3.Error:
        return None


def _connect_rw(p: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(str(p), timeout=30.0)
    # a journal kept in place (not deleted after each commit) leaves the folder's mtime alone, which the terminal UI
    # watches; the job touches the folder itself when a count finishes
    conn.execute("PRAGMA journal_mode=PERSIST")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.executescript(_SCHEMA)
    return conn


def _meta(conn: sqlite3.Connection, key: str) -> str | None:
    row = conn.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
    return None if row is None else str(row[0])


def _set_meta(conn: sqlite3.Connection, key: str, value: Any) -> None:
    conn.execute("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", (key, str(value)))


def _parent(prefix: str) -> str | None:
    return None if prefix == "" else (prefix.rsplit("/", 1)[0] if "/" in prefix else "")


def _prefixes(folder: str) -> list[str]:
    """'' and every prefix of `folder` at each depth: 'a/b' -> ['', 'a', 'a/b']."""
    out = [""]
    if folder:
        parts = folder.split("/")
        out.extend("/".join(parts[:i]) for i in range(1, len(parts) + 1))
    return out


def _lock_free(lock: Path) -> bool:
    """Whether no job holds the index's lock now."""
    try:
        fd = os.open(lock, os.O_RDWR | os.O_CREAT, 0o600)
    except OSError:
        return False
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        return False
    else:
        fcntl.flock(fd, fcntl.LOCK_UN)
        return True
    finally:
        os.close(fd)


def job_argv(root: Path) -> list[str]:
    """The job's command line: `python -m app.coverage index --cwd <root>`, under `nice -n 19` and `ionice -c3` where
    they exist."""
    cmd = [sys.executable, "-m", "app.coverage", "index", "--cwd", str(root)]
    if shutil.which("ionice"):
        cmd = ["ionice", "-c3", *cmd]
    if shutil.which("nice"):
        cmd = ["nice", "-n", "19", *cmd]
    return cmd


def feature_on(c: str) -> bool:
    """Whether the Coverage feature switch is on in workspace `c` (features.auto `coverage`): off, no fact is kept and
    no index job counts records."""
    from . import features  # noqa: PLC0415

    try:
        return bool(features.auto(c, "coverage"))
    except Exception:  # noqa: BLE001 — a config that cannot be read leaves coverage on, as a fresh install has it
        return True


def start_index(c: str, *, force: bool = False) -> bool:
    """Start the index job for workspace `c`, detached, unless the Coverage switch is off, one holds its lock or this
    process started one in the last START_DEBOUNCE_S. Whether it started one. Never raises."""
    now = time.monotonic()
    if not force and now - _started.get(c, -1e9) < START_DEBOUNCE_S:
        return False
    if not feature_on(c):
        return False
    try:
        d = coverage_dir(c)
        root = config.corpus_dir(c)
        if not _lock_free(d / LOCK):
            return False
        env = {**os.environ, "THIMBLE_WORKSPACES_DIR": str(config.WORKSPACES_DIR),
               "THIMBLE_DATA_DIR": str(config.DATA_DIR)}
        subprocess.Popen(job_argv(root), cwd=str(config.REPO_ROOT / "backend"), env=env, stdin=subprocess.DEVNULL,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True, close_fds=True)
    except (OSError, ValueError):
        log.warning("%s: the coverage index job did not start", c, exc_info=True)
        return False
    _started[c] = now
    return True


def _fresh_or_start(c: str, conn: sqlite3.Connection | None) -> bool:
    """Whether the index is there; starts the job when it is missing or was walked more than STALE_S ago."""
    walked = None
    if conn is not None:
        with contextlib.suppress(sqlite3.Error, TypeError, ValueError):
            walked = float(_meta(conn, "walked_at") or "")
    if walked is None or time.time() - walked > STALE_S:
        start_index(c)
    return conn is not None and walked is not None


def _walk(root: Path, tree: bool) -> dict[str, tuple[str, str, int, int]]:
    """{path: (folder, ext, size, mtime_ns)} of every data file under `root`, thimble's home and Claude Code's config
    left out."""
    from . import corpus_walk  # noqa: PLC0415

    homes = [h for h in _homes() if _inside(h, os.path.realpath(root)) and h != os.path.realpath(root)]
    skip = {os.path.relpath(h, os.path.realpath(root)) for h in homes}
    out: dict[str, tuple[str, str, int, int]] = {}
    for rel, folder in corpus_walk.walk(root, NEVER_SEGMENTS).items():
        if rel and any(_inside(rel, s) for s in skip):
            continue
        for name in folder.file_names():
            path = f"{rel}/{name}" if rel else name
            if not is_data(path, tree):
                continue
            try:
                st = os.stat(root / path)
            except OSError:
                continue
            if not os.path.isfile(root / path):
                continue
            out[path] = (rel, ext_of(name), int(st.st_size), int(st.st_mtime_ns))
    return out


def _rebuild_totals(conn: sqlite3.Connection) -> None:
    """The totals table from the files table: per (folder prefix at each depth, extension) its files, bytes, records
    and files counted."""
    acc: dict[tuple[str, str], list[int]] = {}
    for folder, ext, size, records in conn.execute("SELECT folder, ext, size, records FROM files"):
        for p in _prefixes(folder):
            t = acc.setdefault((p, ext), [0, 0, 0, 0])
            t[0] += 1
            t[1] += int(size)
            if records is not None:
                t[2] += int(records)
                t[3] += 1
    conn.execute("DELETE FROM totals")
    conn.executemany("INSERT INTO totals (prefix, ext, parent, files, bytes, records, counted) VALUES (?, ?, ?, ?, ?, ?, ?)",
                     ((p, e, _parent(p), *v) for (p, e), v in acc.items()))


def _touch(d: Path) -> None:
    with contextlib.suppress(OSError):
        os.utime(d)


def refresh(c: str, root: Path, conn: sqlite3.Connection) -> int:
    """One walk into the index: new and changed files (by size and mtime) in, uncounted, and gone files out; the totals
    made again. How many rows changed."""
    found = _walk(root, code_tree(root))
    have = {p: (s, m) for p, s, m in conn.execute("SELECT path, size, mtime FROM files")}
    gone = [p for p in have if p not in found]
    changed = [(p, *v) for p, v in found.items() if have.get(p) != (v[2], v[3])]
    with conn:
        conn.executemany("DELETE FROM files WHERE path = ?", ((p,) for p in gone))
        conn.executemany("INSERT OR REPLACE INTO files (path, folder, ext, size, mtime, records, reader, error) "
                         "VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL)", changed)
        _rebuild_totals(conn)
        _set_meta(conn, "root", str(root))
        _set_meta(conn, "walked_at", time.time())
    return len(gone) + len(changed)


def count_groups(c: str, root: Path, conn: sqlite3.Connection, d: Path | None = None) -> list[tuple[str, str]]:
    """Count the records of every file not yet counted, one (folder, extension) group at a time: each group's rows and
    its totals written in one transaction, then the coverage folder touched. [(path, why)] of the files that could not
    be counted (counted as 0 records)."""
    from . import records  # noqa: PLC0415

    failed: list[tuple[str, str]] = []
    groups = conn.execute("SELECT DISTINCT folder, ext FROM files WHERE records IS NULL ORDER BY folder, ext").fetchall()
    for folder, ext in groups:
        rows = conn.execute("SELECT path FROM files WHERE folder = ? AND ext = ? AND records IS NULL", (folder, ext)).fetchall()
        done: list[tuple[int, str | None, str | None, str]] = []
        for (path,) in rows:
            full = root / path
            try:
                reader = records.reader_of(full, path)
                n = int(records.count(full, path)) if reader is not None else 0
                done.append((n, reader, None, path))
            except Exception as e:  # noqa: BLE001 — a file that cannot be counted counts 0 records
                why = f"{type(e).__name__}: {e}"[:200]
                done.append((0, None, why, path))
                failed.append((path, why))
        if not done:
            continue
        added = sum(n for n, _, _, _ in done)
        with conn:
            conn.executemany("UPDATE files SET records = ?, reader = ?, error = ? WHERE path = ?", done)
            for p in _prefixes(folder):
                conn.execute("UPDATE totals SET records = records + ?, counted = counted + ? WHERE prefix = ? AND ext = ?",
                             (added, len(done), p, ext))
        if d is not None:
            _touch(d)
    return failed


def _count_notice(c: str, failed: list[tuple[str, str]]) -> None:
    from . import notices  # noqa: PLC0415

    try:
        if failed:
            # the act needs notices.ACTIONS and local.NOTICE_ACTS to know it (runtime lane); until then only dismiss
            act = [{"label": "Try again", "do": RETRY_ACT}] if RETRY_ACT in notices.ACTIONS else None
            notices.post(c, kind="coverage", text=COUNT_TEXT.format(n=f"{len(failed):,}", reason=failed[0][1]),
                         action=act, key=COUNT_NOTICE)
        else:
            notices.clear(c, COUNT_NOTICE)
    except Exception:  # noqa: BLE001 — the counts are written either way
        log.debug("%s: the coverage count notice was not posted", c, exc_info=True)


def run_job(c: str, root: Path) -> int:
    """The job's body under its lock: refresh, then count group by group. 0, or 1 when another job holds the lock."""
    d = coverage_dir(c)
    fd = os.open(d / LOCK, os.O_RDWR | os.O_CREAT, 0o600)
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            return 1
        conn = _connect_rw(d / INDEX)
        try:
            refresh(c, root, conn)
            _touch(d)
            failed = count_groups(c, root, conn, d)
            with conn:
                _set_meta(conn, "counted_at", time.time())
        finally:
            conn.close()
        _touch(d)
        _count_notice(c, failed)
        return 0
    finally:
        os.close(fd)


def index_main(argv: list[str]) -> int:
    """`python -m app.coverage index --cwd <dir>`: the job for the corpus `dir` is in (module note)."""
    cwd = None
    if "--cwd" in argv:
        i = argv.index("--cwd")
        cwd = argv[i + 1] if i + 1 < len(argv) else None
    cwd = cwd or os.getcwd()
    c = config.workspace_for_cwd(cwd)
    if not c:
        sys.stderr.write(f"thimble coverage: {cwd} is not inside a corpus thimble knows\n")
        return 2
    return run_job(c, config.corpus_dir(c))


# --------------------------------------------------------------------------- merging


class _Facts:
    """A session's facts merged: per file its state, and the searched areas."""

    def __init__(self, facts: list[dict[str, Any]], derived: tuple[set[str], list[tuple[str, str | None]], list[str]]):
        self.whole: set[str] = set()
        self.lines: dict[str, list[tuple[int, int]]] = {}
        self.pages: dict[str, list[tuple[int, int]]] = {}
        self.part: set[str] = set()
        self.searched: set[str] = set()
        self.areas: list[tuple[str, str | None]] = []
        for f in facts:
            path, how = str(f["path"]), f["how"]
            if f.get("folder"):
                self.areas.append((path, None))
            elif how == "whole":
                self.whole.add(path)
            elif how == "part":
                self.part.add(path)
                if (r := _range(f.get("lines"))) is not None:
                    self.lines.setdefault(path, []).append((r[0], r[1]))
                elif (r := _range(f.get("pages"))) is not None:
                    self.pages.setdefault(path, []).append((r[0], r[1]))
            else:
                self.searched.add(path)
        files, areas, self.patterns = derived
        self.searched.update(files)
        self.areas.extend(areas)
        self.seen = self.whole | self.part
        self.searched -= self.seen

    def covers(self, path: str, folder: str, ext: str) -> bool:
        """Whether a searched area holds the file."""
        return any((x is None or x == ext) and (a == "" or _inside(folder, a)) for a, x in self.areas)


def _union(ranges: list[tuple[int, int]], hi: int) -> int:
    total, end = 0, 0
    for a, b in sorted(ranges):
        a, b = max(a, end + 1, 1), min(b, hi)
        if b >= a:
            total += b - a + 1
            end = b
    return total


def _records_seen(m: _Facts, path: str, reader: str | None, records: int | None) -> int:
    if records is None or path not in m.seen:
        return 0
    if path in m.whole:
        return records
    if reader in LINE_READERS and path in m.lines:
        return _union(m.lines[path], records)
    if reader == "pdf" and path in m.pages:
        return _union(m.pages[path], records)
    return 0


class _Index:
    """What the requests read from the index: the totals by (prefix, ext) and the rows of named files."""

    def __init__(self, conn: sqlite3.Connection | None):
        self.conn = conn
        self._totals: dict[tuple[str, str], tuple[int, int, int, int]] = {}

    def totals(self, prefix: str, ext: str | None = None) -> tuple[int, int, int, int]:
        """(files, bytes, records, counted) under `prefix`, of one extension or all."""
        if self.conn is None:
            return (0, 0, 0, 0)
        if ext is not None:
            key = (prefix, ext)
            if key not in self._totals:
                row = self.conn.execute("SELECT files, bytes, records, counted FROM totals WHERE prefix = ? AND ext = ?",
                                        key).fetchone()
                self._totals[key] = tuple(int(x) for x in row) if row else (0, 0, 0, 0)  # type: ignore[assignment]
            return self._totals[key]
        out = [0, 0, 0, 0]
        for row in self.conn.execute("SELECT files, bytes, records, counted FROM totals WHERE prefix = ?", (prefix,)):
            for i in range(4):
                out[i] += int(row[i])
        return tuple(out)  # type: ignore[return-value]

    def exts(self, prefix: str) -> dict[str, tuple[int, int, int, int]]:
        if self.conn is None:
            return {}
        return {str(e): (int(f), int(b), int(r), int(k)) for e, f, b, r, k in self.conn.execute(
            "SELECT ext, files, bytes, records, counted FROM totals WHERE prefix = ?", (prefix,))}

    def children(self, prefix: str) -> list[tuple[str, str, tuple[int, int, int, int]]]:
        """(child folder prefix, ext, totals) of the folders right under `prefix`."""
        if self.conn is None:
            return []
        return [(str(p), str(e), (int(f), int(b), int(r), int(k))) for p, e, f, b, r, k in self.conn.execute(
            "SELECT prefix, ext, files, bytes, records, counted FROM totals WHERE parent = ?", (prefix,))]

    def rows_of(self, paths: Iterable[str]) -> dict[str, tuple[str, str, int, int | None, str | None]]:
        """{path: (folder, ext, size, records, reader)} of the named paths the index holds."""
        out: dict[str, tuple[str, str, int, int | None, str | None]] = {}
        if self.conn is None:
            return out
        wanted = list(dict.fromkeys(paths))
        for i in range(0, len(wanted), 500):
            part = wanted[i:i + 500]
            for p, folder, ext, size, records, reader in self.conn.execute(
                    f"SELECT path, folder, ext, size, records, reader FROM files WHERE path IN ({','.join('?' * len(part))})",
                    part):
                out[str(p)] = (str(folder), str(ext), int(size), None if records is None else int(records), reader)
        return out

    def files_under(self, prefix: str) -> list[tuple[str, str, str, int, int | None, str | None]]:
        if self.conn is None:
            return []
        if prefix == "":
            q, args = "SELECT path, folder, ext, size, records, reader FROM files", ()
        else:
            q, args = ("SELECT path, folder, ext, size, records, reader FROM files WHERE path >= ? AND path < ?",
                       (prefix + "/", prefix + "0"))
        return [(str(p), str(f), str(e), int(s), None if r is None else int(r), rd) for p, f, e, s, r, rd in
                self.conn.execute(q, args)]

    def glob(self, pattern: str) -> list[str]:
        if self.conn is None:
            return []
        return [str(p) for (p,) in self.conn.execute("SELECT path FROM files WHERE path GLOB ?", (pattern,))]


def _merge(c: str, sid: str, conn: sqlite3.Connection | None) -> tuple[_Facts, _Index, dict[str, tuple]]:
    """The merged facts, the index, and the files the facts name: {path: (folder, ext, size, records, reader)} for
    every one that exists, from the index or, for one the index does not hold yet, from the disk (records unknown)."""
    facts = read_facts(c, sid)
    derived = _derived(c, _since(sid, facts))
    idx = _Index(conn)
    if derived[2] and conn is not None:
        found = set()
        for pat in derived[2][:20]:
            found.update(idx.glob(pat))
        derived[0].update(found)
    m = _Facts(facts, derived)
    named = m.seen | m.searched
    known = idx.rows_of(named)
    root = config.corpus_dir(c)
    tree = code_tree(root)
    for p in named - set(known):
        if is_data(p, tree):
            with contextlib.suppress(OSError):
                st = os.stat(root / p)
                if os.path.isfile(root / p):
                    folder = p.rsplit("/", 1)[0] if "/" in p else ""
                    known[p] = (folder, ext_of(p), int(st.st_size), None, None, True)  # type: ignore[assignment]
    m.seen &= set(known)
    m.searched &= set(known)
    return m, idx, known


def _status(m: _Facts, path: str, folder: str, ext: str) -> str:
    if path in m.seen:
        return "seen"
    if path in m.searched or m.covers(path, folder, ext):
        return "searched"
    return "never"


def _covered(m: _Facts, idx: _Index, prefix: str, ext: str) -> int:
    """How many indexed files of `ext` under `prefix` the searched areas hold."""
    rel = [a for a, x in m.areas if x is None or x == ext]
    if any(a == "" or _inside(prefix, a) for a in rel):
        return idx.totals(prefix, ext)[0]
    inner = sorted({a for a in rel if prefix == "" or a.startswith(prefix + "/")})
    top = [a for a in inner if not any(b != a and _inside(a, b) for b in inner)]
    return sum(idx.totals(a, ext)[0] for a in top)


class _Tally:
    """One row's counts as they add up."""

    def __init__(self) -> None:
        self.files = self.seen = self.searched = self.records_seen = self.records = self.counted = self.bytes = 0

    def add_totals(self, t: tuple[int, int, int, int]) -> None:
        self.files += t[0]
        self.bytes += t[1]
        self.records += t[2]
        self.counted += t[3]


def _group_of(path: str, folder: str, prefix: str, ext: str) -> tuple[str, str]:
    """(segment, ext) of the group a file falls in at the level of `prefix`: its first segment under `prefix`, or `.`."""
    rest = folder[len(prefix) + 1:] if prefix else folder
    if folder == prefix or not rest:
        return ".", ext
    return rest.split("/", 1)[0], ext


def _tally(m: _Facts, idx: _Index, known: dict[str, tuple], prefix: str) -> dict[tuple[str, str], _Tally]:
    """The counts of each group at the level of `prefix` (module note), extension groups keyed without the dot."""
    out: dict[tuple[str, str], _Tally] = {}
    child_sums: dict[str, list[int]] = {}
    for child, ext, t in idx.children(prefix):
        seg = child.rsplit("/", 1)[-1]
        g = out.setdefault((seg, ext), _Tally())
        g.add_totals(t)
        g.searched += _covered(m, idx, child, ext)
        s = child_sums.setdefault(ext, [0, 0, 0, 0])
        for i in range(4):
            s[i] += t[i]
    for ext, t in idx.exts(prefix).items():
        direct = tuple(t[i] - child_sums.get(ext, [0, 0, 0, 0])[i] for i in range(4))
        if direct[0] > 0:
            g = out.setdefault((".", ext), _Tally())
            g.add_totals(direct)  # type: ignore[arg-type]
            rel = [a for a, x in m.areas if x is None or x == ext]
            if any(a == "" or _inside(prefix, a) for a in rel):
                g.searched += direct[0]
    for path, row in known.items():
        folder, ext = row[0], row[1]
        if prefix and not _inside(folder, prefix):
            continue
        g = out.setdefault(_group_of(path, folder, prefix, ext), _Tally())
        extra = len(row) > 5
        if extra:  # a file the index does not hold yet
            g.files += 1
            g.bytes += int(row[2])
        state = _status(m, path, folder, ext)
        area = m.covers(path, folder, ext)
        if state == "seen":
            g.seen += 1
            g.records_seen += _records_seen(m, path, row[4], row[3])
            if area and not extra:
                g.searched -= 1  # the area's count holds it, but seen wins
        elif state == "searched" and (extra or not area):
            g.searched += 1
    return out


def _row(key: str, folder: str, ext: str, path: str | None, g: _Tally, drill: bool) -> dict[str, Any]:
    counted = g.files > 0 and g.counted >= g.files
    return {"key": key, "folder": folder, "ext": ext, "path": path, "files": g.files, "seen": g.seen,
            "searched": g.searched, "never": max(0, g.files - g.seen - g.searched), "records_seen": g.records_seen,
            "records_total": g.records if counted else None, "bytes": g.bytes, "drill": drill}


def _dot(ext: str) -> str:
    return f".{ext}" if ext else NO_EXT


def _percent(seen: int, total: int) -> str:
    if seen <= 0:
        return "0%"
    p = round(100 * seen / total)
    if p < 1:
        return "<1%"
    if p >= 100 and seen < total:
        return "99%"
    return f"{min(p, 100)}%"


def line_of(files_seen: int, files_total: int, records_seen: int, records_total: int, counted: bool,
            indexed: bool = True) -> str:
    """The summary line (module note): records first when every file is counted, files otherwise."""
    if not indexed:
        return f"saw {files_seen:,} {_files(files_seen)}"
    if counted and records_total > 0:
        return (f"saw {_percent(records_seen, records_total)} of records ({files_seen:,} of {files_total:,} "
                f"{_files(files_total)})")
    return f"saw {files_seen:,} of {files_total:,} {_files(files_total)}"


def _files(n: int) -> str:
    return "file" if n == 1 else "files"


def _open(c: str) -> tuple[sqlite3.Connection | None, bool]:
    conn = _connect_ro(index_path(c))
    return conn, _fresh_or_start(c, conn)


def summary(c: str, sid: str) -> dict[str, Any]:
    """The session's coverage over the corpus: {files: {seen, searched, never, total}, records: {seen, total, counted},
    line, counting}. Reads the index only."""
    conn, indexed = _open(c)
    try:
        m, idx, known = _merge(c, sid, conn)
        groups = _tally(m, idx, known, "") if indexed else {}
        if indexed:
            g = _Tally()
            for t in groups.values():
                for k in ("files", "seen", "searched", "records_seen", "records", "counted", "bytes"):
                    setattr(g, k, getattr(g, k) + getattr(t, k))
        else:  # no index yet: the files the facts name
            g = _Tally()
            g.files = len(known)
            g.seen = len(m.seen)
            g.searched = len(m.searched)
        counted = indexed and g.files > 0 and g.counted >= g.files
        line = line_of(g.seen, g.files, g.records_seen, g.records, counted, indexed)
        return {"files": {"seen": g.seen, "searched": g.searched, "never": max(0, g.files - g.seen - g.searched),
                          "total": g.files},
                "records": {"seen": g.records_seen if counted else 0, "total": g.records if counted else 0,
                            "counted": counted},
                "line": line, "counting": not counted}
    finally:
        if conn is not None:
            conn.close()


def _sorted_files(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    order = {"seen": 0, "searched": 1, "never": 2}
    return sorted(rows, key=lambda r: (order[("seen" if r["seen"] else "searched" if r["searched"] else "never")],
                                       r["path"]))


def rows(c: str, sid: str, folder: str = "") -> list[dict[str, Any]]:
    """The rows of one level of the corpus's data files (module note), each {key, folder, ext, path, files, seen,
    searched, never, records_seen, records_total, bytes, drill}; `ext` with its dot, or `(none)`."""
    folder = str(folder or "").strip().strip("/")
    if folder in (".",):
        folder = ""
    conn, indexed = _open(c)
    try:
        m, idx, known = _merge(c, sid, conn)
        level = idx.totals(folder)[0] + sum(1 for r in known.values() if len(r) > 5 and (not folder or _inside(r[0], folder)))
        if level <= FILE_ROWS:
            files = {p: (f, e, s, r, rd) for p, f, e, s, r, rd in idx.files_under(folder)}
            for p, row in known.items():
                if len(row) > 5 and (not folder or _inside(row[0], folder)):
                    files.setdefault(p, row[:5])
            out = []
            for p, (f, e, s, r, rd) in files.items():
                g = _Tally()
                g.files, g.bytes = 1, s
                if r is not None:
                    g.records, g.counted = r, 1
                state = _status(m, p, f, e)
                g.seen, g.searched = int(state == "seen"), int(state == "searched")
                g.records_seen = _records_seen(m, p, rd, r)
                out.append(_row(p, f, _dot(e), p, g, False))
            return _sorted_files(out)
        groups = _tally(m, idx, known, folder)
        ranked = sorted(groups.items(), key=lambda kv: (-kv[1].files, kv[0][0] == ".", kv[0]))
        out = [_row(f"{seg}|{_dot(ext)}", folder if seg == "." else (f"{folder}/{seg}" if folder else seg), _dot(ext),
                    None, g, seg != ".") for (seg, ext), g in ranked]
        if len(out) > ROWS_MAX:
            rest = _Tally()
            for _, g in ranked[GROUPS_SHOWN:]:
                for k in ("files", "seen", "searched", "records_seen", "records", "counted", "bytes"):
                    setattr(rest, k, getattr(rest, k) + getattr(g, k))
            out = [*out[:GROUPS_SHOWN], _row(OTHER, folder, "", None, rest, False)]
        return out
    finally:
        if conn is not None:
            conn.close()


def state(c: str, sid: str, folder: str = "", *, summary_only: bool = False) -> dict[str, Any]:
    """`thimble state coverage`: {summary, folder, rows?, counting}."""
    s = summary(c, sid)
    out: dict[str, Any] = {"summary": {k: s[k] for k in ("files", "records", "line")}, "folder": folder,
                           "counting": s["counting"]}
    if not summary_only:
        out["rows"] = rows(c, sid, folder)
    return out


def main(argv: list[str]) -> int:
    logging.basicConfig(level=logging.WARNING, stream=sys.stderr, format="thimble %(levelname)s: %(message)s")
    if argv[:1] == ["index"]:
        return index_main(argv[1:])
    sys.stderr.write("usage: python -m app.coverage index --cwd <dir>\n")
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
