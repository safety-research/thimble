"""Coverage: what Claude read or searched in the corpus in this session, by its tool calls.

The terminal UI's tracker (plugin/hooks/term/tracker.ts) notes a fact for each file a tool call of main or of its
subagents touched, and at the end of each turn that has facts it runs `thimble act coverage --stdin` once with them as
JSON on standard input (add_facts). A fact is {path, how, lines?, pages?, total?, folder?, by, at}: `how` is `whole`
(the call showed the whole file), `part` (some of it: `lines` [a, b] of a line-based file, `pages` [a, b] of a PDF) or
`searched` (a search, a count or a script touched its contents without showing them). A `folder` fact (a recursive
`grep -r` or `rg` over a folder) is kept as one fact and stands for every file under the folder. Facts whose path is
outside the corpus, or that is not in the universe (in_universe), are dropped, and the store holds paths only, never a
command's text. Per session the facts are appended to `<ws>/coverage/<sid>.jsonl`.

The universe. is_data is the data-file rule of the activation trigger (plugin/hooks/term/activate.ts `isDataFile` is
its twin, and both tests read one case list, tests_public/fixtures/data_files.json): never under a tool or build folder,
never a package or lock file, never a code or config file; outside a code tree any data or document type; inside a code
tree (the corpus root holds a project file) only data types, and document types under a data folder. in_universe holds
those and, beside them, the corpus's other non-code files (images, audio, video, binaries, documents): never code or
config, never a hidden file, a database's side file or a file without an extension, and inside a code tree only under a
data folder.

Units. unit_of decides what a file counts, by its type: `lines` for line-based text (LINE_EXTS: JSON Lines, CSV, TSV,
logs, text, subtitles), every line of the file as an editor numbers them; `entries` for a JSON document's values and a
database's rows (ENTRY_EXTS): the items of an array at a document's top, else the values of its object (the items of its
arrays of objects where it has any, as records.py splits a document into records), and the rows of every table a
database holds; `files` for every other file of the universe (images, video, binaries, PDF, Markdown, HTML, and formats
nothing counts, such as parquet). A row of the Coverage view holds files of one type, so it counts in one unit, and no
number adds two units. count_file counts a file in its unit.

The index. A detached job (`python -m app.coverage index --cwd <corpus>`, under `flock <ws>/coverage/index.lock`, as
`nice -n 19 ionice -c3` where those exist) walks the corpus (corpus_walk.walk), keeps one row per file of the universe
in `<ws>/coverage/index.sqlite` keyed by (path, size, mtime) with its name pattern (name_pattern), and a totals table
per (folder prefix at each depth, extension) with its files, bytes, count (`records`: lines or entries) and the one name
pattern its files share. A file that counts files gets 0 at once; the job then counts the lines or entries of the others
(count_file), one (folder, extension) group at a time, adding each group's count to the totals as it finishes and
touching `<ws>/coverage/` so the terminal UI reads the summary again. A refresh stats again only the files of a folder
whose listing changed, and in the other folders only the files of lines or entries (lines are added to them in place);
it counts only the files whose size or mtime changed. A file that cannot be counted counts 0, and the job posts the
`coverage:count` notice. An index of an earlier form (SCHEMA) is built again.

Requests never walk or count: summary and level read the index alone, and start the job (once, under its lock) when the
index is missing or was walked more than STALE_S ago. With no index yet the summary counts files from the facts only and
says `counting`.

Per file: read (`seen` in the rows and totals) when a `whole` or `part` fact names it: it was pulled into Claude's
context; else `searched` when a `searched` fact names it or a folder fact is above it: grep, a script or a label went
over it and only a narrow result came back; else neither. Lines or entries read: all of a `whole` file's, the union of a
`part` file's line ranges within its lines (a line-based file), else none. Searched: all of a searched file's, and those
of a file read in part that a search also touched, less those read. The reads of cards made since the session was turned
on (`cell.reads`, the notebook's audit) and the files of labels run since then count as searched. The rows' and totals'
`records_*` fields and the index's `records` column hold a count in the row's unit, lines or entries.

The size (summary `size`): one total for the whole corpus in bytes, whatever the units of its rows. Read: a `whole`
file's size, and a file of the `files` unit read in part counts whole too; a `part` file of lines or entries counts the
bytes of its line ranges where a line index of the file is at hand (read_bytes: corpus.known_index, in memory or kept on
disk, never built here), else its size times the share of its lines read (of the index's lines for a line-based file,
else of the line total the read reported); a part without a line range counts none. Searched: a searched file's size,
and the rest of a file read in part that a search also touched. The summary line says the read and searched shares of
it: `read 2% · searched 41% of the data`, searched only when not 0; with no index yet, the files the facts name. The
orientation's coverage line is this line for its own calls: summary_of takes the facts call_facts.py gives of its
stored calls, and what its cards and labels searched, in place of a session's.

Rows (level): at a level with FILE_ROWS files or fewer, one row per file (seen, then searched, then the others, by
name). Otherwise one row per (folder right under the level, extension), which drills into that folder (a folder that
holds only one folder and no file names the deeper folder); and the files right in the level: siblings that share a
name pattern (PATTERN_MIN or more) are one row by their glob (`agent-*.jsonl`), the rest one row each when FILE_ROWS or
fewer, else one row per type (a type of one file is its file's row). A pattern's or a type's row drills into its files.
Every group is listed, the one of the most files first (then by size); a list of more than LIST_MAX rows says how many
it leaves out (`more`). The totals (summary `totals`) hold the corpus's denominators, one entry per unit it has: lines,
entries, files; the size (summary `size`) is the whole corpus's at every level.
"""
from __future__ import annotations

import contextlib
import fcntl
import fnmatch
import json
import logging
import math
import os
import re
import shutil
import sqlite3
import stat as stat_mod
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
SCHEMA = "4"  # the index's form: files with their name pattern and count (lines or entries), totals, folders' mtimes
STALE_S = 60.0  # a request starts the job when the index was walked longer ago than this
START_DEBOUNCE_S = 5.0  # a process starts the job at most once in this long
WALK_POLL_S = 0.2  # how often wait_walked looks whether the job's walk is in the index
FILE_ROWS = 20  # at a level with this many files or fewer, the rows are files
PATTERN_MIN = 5  # siblings that share a name pattern, this many or more, are one row by their glob
LIST_MAX = 500  # rows one level lists at most; `more` says how many it leaves out
NO_EXT = "(none)"
SID_RE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
HOWS = ("whole", "part", "searched")
BYS = ("Read", "Bash", "search", "agent")
UNITS = ("lines", "entries", "files")  # in the totals' order
COUNTED = ("lines", "entries")  # the units the job counts; a file of the others counts itself
COUNT_NOTICE = "coverage:count"  # the notice of files the job could not count (module note)
COUNT_TEXT = "thimble could not count the lines or entries of {n}: {reason}"
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
# The universe beyond the data rule (module note): never these types, which are code, notebooks or build leftovers.
NOT_CORPUS_EXTS = CODE_EXTS | frozenset("ipynb pyc pyo class o swp".split())
DB_SIDE = re.compile(r"\.(db|sqlite|sqlite3)-(wal|shm|journal)$", re.I)
# The units' types (module note): line-based text counts lines; a JSON document and a database count entries.
LINE_EXTS = frozenset("jsonl ndjson csv tsv log txt vtt srt".split())
ENTRY_EXTS = frozenset("json db sqlite sqlite3".split())
DB_EXTS = frozenset("db sqlite sqlite3".split())

_SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, folder TEXT NOT NULL, ext TEXT NOT NULL,
    size INTEGER NOT NULL, mtime INTEGER NOT NULL, records INTEGER, reader TEXT, error TEXT, pattern TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS files_group ON files(folder, ext);
CREATE INDEX IF NOT EXISTS files_pattern ON files(folder, pattern, ext);
CREATE TABLE IF NOT EXISTS totals (prefix TEXT NOT NULL, ext TEXT NOT NULL, parent TEXT, files INTEGER NOT NULL,
    bytes INTEGER NOT NULL, records INTEGER NOT NULL, counted INTEGER NOT NULL, pattern TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (prefix, ext));
CREATE INDEX IF NOT EXISTS totals_parent ON totals(parent);
CREATE TABLE IF NOT EXISTS folders (path TEXT PRIMARY KEY, mtime INTEGER);
"""

_started: dict[str, float] = {}  # workspace -> when this process last started the job
_stat = os.stat  # the job's one stat per file (a test counts them)


# --------------------------------------------------------------------------- the data rule and the universe


def ext_of(name: str) -> str:
    """The file name's extension, lowercased, without its dot; '' for none (a dot name like `.env` has none)."""
    base = name.rsplit("/", 1)[-1]
    stem, dot, ext = base.rpartition(".")
    return ext.lower() if dot and stem else ""


def is_data(rel: str, code_tree: bool) -> bool:
    """Whether the corpus-relative path `rel` is a data file by the activation rule (module note)."""
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


def in_universe(rel: str, code_tree: bool) -> bool:
    """Whether the corpus-relative path `rel` counts in coverage: a data file (is_data), or another non-code file of
    the corpus (module note)."""
    if is_data(rel, code_tree):
        return True
    parts = PurePosixPath(str(rel or "")).parts
    if not parts or parts[0] in ("/", "..") or ".." in parts:
        return False
    name = parts[-1]
    if name.startswith(".") or any(p in NEVER_SEGMENTS or p.startswith(".") for p in parts[:-1]):
        return False
    if any(fnmatch.fnmatchcase(name, pat) for pat in NEVER_NAMES) or DB_SIDE.search(name):
        return False
    ext = ext_of(name)
    if not ext or ext in NOT_CORPUS_EXTS:
        return False
    return not code_tree or any(p in DATA_SEGMENTS for p in parts[:-1])


def unit_of(rel_or_ext: str) -> str:
    """What a file counts, by its type (module note): `lines`, `entries` or `files`. Takes a path, a name or an
    extension."""
    s = str(rel_or_ext or "")
    ext = ext_of(s) if ("." in s.rsplit("/", 1)[-1].lstrip(".") or "/" in s) else s.lower().lstrip(".")
    return "lines" if ext in LINE_EXTS else "entries" if ext in ENTRY_EXTS else "files"


# a JSON document's parts: a string (its escapes kept inside), one of the six marks, or a run of another value's bytes
_JSON_PARTS = re.compile(rb'"[^"\\]*(?:\\.[^"\\]*)*"|[\[\]{},:]|[^\s\[\]{},:"]+', re.S)
_OPEN_A, _CLOSE_A, _OPEN_O, _CLOSE_O, _COLON = 0x5B, 0x5D, 0x7B, 0x7D, 0x3A


def json_entries(buf: Any) -> int | None:
    """The entries of one JSON document in `buf` (bytes or an mmap), in one scan whatever its size: the items of an
    array at its top; else the values of its object, or, where any of its values is an array whose first item is an
    object or an array, the items of those arrays (records.py `_build_json` splits a document so); 1 for a scalar. None
    when `buf` holds no value or more than one, or ends inside one."""
    depth = 0
    top: int | None = None  # the opening byte of the top value, or 0 for a scalar
    done = False
    children = 0
    items = 0  # the items of the top object's arrays of objects or arrays
    nested = False
    in_array = False  # inside an array that is a value of the top object
    count = 0
    first: bool | None = None  # whether that array's first item is an object or an array
    for m in _JSON_PARTS.finditer(buf):
        b = buf[m.start()]
        if isinstance(b, (bytes, bytearray)):
            b = b[0]
        if done:
            return None
        if depth == 0:
            if b in (_OPEN_A, _OPEN_O):
                top, depth = b, 1
            elif b in (_CLOSE_A, _CLOSE_O, 0x2C, _COLON):
                return None
            else:
                top, done = 0, True
            continue
        if b in (_OPEN_A, _OPEN_O):
            if depth == 1:
                if top == _OPEN_A:
                    children += 1
                elif b == _OPEN_A:
                    in_array, count, first = True, 0, None
            elif depth == 2 and in_array:
                count += 1
                if first is None:
                    first = True
            depth += 1
        elif b in (_CLOSE_A, _CLOSE_O):
            depth -= 1
            if depth == 1 and in_array:
                if first:
                    nested, items = True, items + count
                in_array = False
            elif depth == 0:
                done = True
        elif b == _COLON:
            if depth == 1 and top == _OPEN_O:
                children += 1
        elif b != 0x2C:  # a string, a number, true, false or null
            if depth == 1 and top == _OPEN_A:
                children += 1
            elif depth == 2 and in_array:
                count += 1
                if first is None:
                    first = False
    if not done:
        return None
    if top == 0:
        return 1
    return items if top == _OPEN_O and nested else children


def _value_lines(path: Path) -> int:
    """The lines of a file that hold anything but white space: the values of a .json file of one value a line."""
    n = 0
    with open(path, "rb") as f:
        for line in f:
            if line.strip():
                n += 1
    return n


def count_file(full: Path, rel: str, unit: str) -> int:
    """A file's count in its unit (module note): its lines, or its entries (a JSON document's values, a database's
    rows); 0 for a file of the `files` unit and for a binary file of a text type."""
    from . import corpus, records  # noqa: PLC0415

    if unit == "lines":
        return 0 if corpus.sniff_binary(full) else corpus.line_count(full)
    if unit != "entries":
        return 0
    if ext_of(rel) in DB_EXTS:
        return int(records.count(full, rel))
    if full.stat().st_size == 0 or corpus.sniff_binary(full):
        return 0
    import mmap  # noqa: PLC0415

    with open(full, "rb") as f, mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ) as mm:
        n = json_entries(mm)
    return _value_lines(full) if n is None else n


_NAME_PART = re.compile(r"([^A-Za-z0-9]+)")
_UUID = re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")
_HEXISH = re.compile(r"[0-9a-fA-F]+")
_STARS = re.compile(r"\*(?:[^A-Za-z0-9*]+\*)+")


def name_pattern(name: str) -> str:
    """A file name's pattern: its uuids, digit runs and hex ids made `*` (`agent-07.jsonl` -> `agent-*.jsonl`, a uuid
    name -> `*.png`, `2025-04-02` -> `*`); siblings with one pattern group by it."""
    base = name.rsplit("/", 1)[-1]
    stem, dot, ext = base.rpartition(".")
    if not dot or not stem:
        stem, ext = base, ""
    stem = _UUID.sub("0", stem)  # a uuid is one varying part, whether or not its groups hold digits
    out = []
    for part in _NAME_PART.split(stem):
        if not part or not part[0].isalnum():
            out.append(part)
        elif _HEXISH.fullmatch(part) and ((any(ch.isdigit() for ch in part) and (len(part) >= 4 or part.isdigit()))
                                          or len(part) >= 12):
            out.append("*")
        else:
            out.append(re.sub(r"\d+", "*", part))
    pat = re.sub(r"\*+", "*", _STARS.sub("*", "".join(out)))
    return f"{pat}.{ext}" if ext else pat


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
    """The facts as stored: paths relative to the corpus root, each a file of the universe inside the corpus (a folder
    fact a folder inside it), with only the fields of the fact form (module note). Others are dropped."""
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
        elif not rel or not in_universe(rel, tree):
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
    """A label's file pattern (fnmatch, `*` spans `/`, a `**/` may stand for no folder: corpus_tree.glob_match, as
    concepts.match_paths reads it) as a searched area: (folder, extension or None) for `agents/*`, `agents/**/*`,
    `agents/*.jsonl`, `**/*.jsonl` and the like; None for a pattern of another form, such as a wildcard inside a name
    (`agents/agent-*.jsonl`)."""
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


Derived = tuple[set[str], list[tuple[str, str | None]], list[str]]  # (files, areas, patterns) searched (_derived)


def card_searches(cells: Iterable[dict[str, Any]]) -> tuple[set[str], list[tuple[str, str | None]]]:
    """(files, areas) the cards' code searched: their recorded reads, and for a card whose reads were capped the
    folders they fall in, but never the whole corpus."""
    files: set[str] = set()
    areas: list[tuple[str, str | None]] = []
    for cell in cells:
        reads = [str(r).removeprefix("./") for r in cell.get("reads") or [] if isinstance(r, str)]
        files.update(reads)
        if cell.get("reads_more"):
            areas.extend((d, None) for d in {os.path.dirname(r) for r in reads} if d)
    return files, areas


def label_searches(root: Path, pats: Any, into: Derived) -> None:
    """Add to `into` what a label's run over the file patterns `pats` searched: a plain path is a file (a folder an
    area), `<folder>/**` or `<folder>/**/*.ext` an area, anything else a pattern matched over the index."""
    files, areas, patterns = into
    for pat in [pats] if isinstance(pats, str) else pats or []:
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


def _derived(c: str, since: float | None) -> Derived:
    """(files, areas, patterns) searched by the cards made and the labels run since `since` (card_searches,
    label_searches)."""
    out: Derived = (set(), [], [])
    if since is None:
        return out
    ws = config.workspace_dir(c)
    root = config.corpus_dir(c)
    try:
        from . import notebook  # noqa: PLC0415 — notebook imports the kernel machinery

        files, areas = card_searches(cell for _, nb in notebook._stored(ws) for cell in nb.get("cells") or []
                                     if isinstance(cell, dict) and (_epoch(cell.get("ts")) or 0) >= since)
        out[0].update(files)
        out[1].extend(areas)
    except Exception:  # noqa: BLE001 — coverage without the cards' reads still answers
        log.debug("%s: the cards' reads were not read for coverage", c, exc_info=True)
    try:
        from . import concepts  # noqa: PLC0415

        for concept in concepts.list_concepts(ws):
            for app in concept.get("applications") or []:
                if isinstance(app, dict) and (_epoch(app.get("ts")) or 0) >= since:
                    label_searches(root, app.get("paths") or concept.get("glob") or [], out)
    except Exception:  # noqa: BLE001
        log.debug("%s: the labels' runs were not read for coverage", c, exc_info=True)
    return out


# --------------------------------------------------------------------------- the index


def index_path(c: str) -> Path:
    return coverage_dir(c) / INDEX


def _connect_ro(p: Path) -> sqlite3.Connection | None:
    """The index, read only; None when it is missing or of an earlier form (SCHEMA), which the job builds again."""
    if not p.is_file():
        return None
    try:
        conn = sqlite3.connect(f"file:{p}?mode=ro", uri=True, timeout=5.0)
        if _meta(conn, "schema") != SCHEMA:
            conn.close()
            return None
        return conn
    except sqlite3.Error:
        return None


def _connect_rw(p: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(str(p), timeout=30.0)
    # a journal kept in place (not deleted after each commit) leaves the folder's mtime alone, which the terminal UI
    # watches; the job touches the folder itself when a count finishes
    conn.execute("PRAGMA journal_mode=PERSIST")
    conn.execute("PRAGMA synchronous=NORMAL")
    have = None
    with contextlib.suppress(sqlite3.Error):
        have = _meta(conn, "schema")
    if have != SCHEMA:  # an index of an earlier form: built again from the walk
        with conn:
            conn.executescript("DROP TABLE IF EXISTS files; DROP TABLE IF EXISTS totals; DROP TABLE IF EXISTS folders;")
    conn.executescript(_SCHEMA)
    if have != SCHEMA:
        with conn:
            _set_meta(conn, "schema", SCHEMA)
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
    no index job counts lines or entries."""
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


def _walked(c: str) -> bool:
    """Whether the index holds a walk: every file of the universe with its size."""
    conn = _connect_ro(index_path(c))
    if conn is None:
        return False
    try:
        return bool(_meta(conn, "walked_at"))
    except sqlite3.Error:
        return False
    finally:
        conn.close()


def wait_walked(c: str, wait_s: float) -> bool:
    """Whether the index holds a walk, once this returns: with none yet, start the job and wait up to `wait_s` for its
    walk, so a summary made next has the corpus's size (orient_checks.coverage). It waits only while a job runs. False
    with the Coverage switch off."""
    if not feature_on(c):
        return False
    if _walked(c):
        return True
    started = start_index(c, force=True)
    deadline = time.monotonic() + wait_s
    while time.monotonic() < deadline:
        if _walked(c):
            return True
        if not started and _lock_free(coverage_dir(c) / LOCK):  # no job runs, and none was started
            break
        time.sleep(WALK_POLL_S)
    return _walked(c)


def _file_row(root: Path, path: str, folder: str, name: str) -> tuple | None:
    """The index row of one file from a stat: (path, folder, ext, size, mtime_ns, records, pattern), records 0 for a
    file that counts files and None (to count) for one that counts lines or entries; None when it is no regular file."""
    try:
        st = _stat(root / path)
    except OSError:
        return None
    if not stat_mod.S_ISREG(st.st_mode):
        return None
    ext = ext_of(name)
    return (path, folder, ext, int(st.st_size), int(st.st_mtime_ns), None if unit_of(ext) in COUNTED else 0,
            name_pattern(name))


def refresh(c: str, root: Path, conn: sqlite3.Connection) -> int:
    """One walk into the index (module note): new and changed files in (those that count lines or entries uncounted),
    gone files and folders out, a folder whose listing did not change stat'ed only for its files of lines or entries;
    the totals made again when anything changed. How many rows changed."""
    from . import corpus_walk  # noqa: PLC0415

    tree = code_tree(root)
    real = os.path.realpath(root)
    skip = {os.path.relpath(h, real) for h in _homes() if _inside(h, real) and h != real}
    folders = {str(p): m for p, m in conn.execute("SELECT path, mtime FROM folders")}
    changed = 0
    with conn:
        for rel, folder in corpus_walk.walk(root, NEVER_SEGMENTS).items():
            if rel and any(_inside(rel, s) for s in skip):
                continue
            same = folders.pop(rel, None) == folder.mtime_ns and not folder.racy
            have = {str(p): (int(s), int(m)) for p, s, m in
                    conn.execute("SELECT path, size, mtime FROM files WHERE folder = ?", (rel,))}
            found: set[str] = set()
            put = []
            for name in folder.file_names():
                path = f"{rel}/{name}" if rel else name
                if not in_universe(path, tree):
                    continue
                if same and path in have and unit_of(name) == "files":
                    found.add(path)  # the listing did not change: an image, a video or a document is as it was
                    continue
                row = _file_row(root, path, rel, name)
                if row is None:
                    continue
                found.add(path)
                if have.get(path) != (row[3], row[4]):
                    put.append(row)
            gone = [p for p in have if p not in found]
            if gone:
                conn.executemany("DELETE FROM files WHERE path = ?", ((p,) for p in gone))
            if put:
                conn.executemany("INSERT OR REPLACE INTO files (path, folder, ext, size, mtime, records, reader, error, "
                                 "pattern) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?)", put)
            changed += len(gone) + len(put)
            conn.execute("INSERT OR REPLACE INTO folders (path, mtime) VALUES (?, ?)",
                         (rel, None if folder.racy else folder.mtime_ns))
        for rel in folders:  # folders no walk found any more
            n = conn.execute("DELETE FROM files WHERE folder = ?", (rel,)).rowcount
            conn.execute("DELETE FROM folders WHERE path = ?", (rel,))
            changed += max(0, n)
        if changed or conn.execute("SELECT 1 FROM totals LIMIT 1").fetchone() is None:
            _rebuild_totals(conn)
        _set_meta(conn, "root", str(root))
        _set_meta(conn, "walked_at", time.time())
    return changed


def _rebuild_totals(conn: sqlite3.Connection) -> None:
    """The totals table from the files table: per (folder prefix at each depth, extension) its files, bytes, records,
    files counted, and the name pattern all its files share ('' when they do not)."""
    acc: dict[tuple[str, str], list[Any]] = {}
    for folder, ext, n, size, records, counted, lo, hi in conn.execute(
            "SELECT folder, ext, COUNT(*), SUM(size), SUM(COALESCE(records, 0)), SUM(records IS NOT NULL), "
            "MIN(pattern), MAX(pattern) FROM files GROUP BY folder, ext"):
        pat = str(lo) if lo == hi else ""
        for p in _prefixes(str(folder)):
            t = acc.get((p, str(ext)))
            if t is None:
                acc[(p, str(ext))] = [int(n), int(size), int(records), int(counted), pat]
            else:
                t[0] += int(n)
                t[1] += int(size)
                t[2] += int(records)
                t[3] += int(counted)
                if t[4] != pat:
                    t[4] = ""
    conn.execute("DELETE FROM totals")
    conn.executemany("INSERT INTO totals (prefix, ext, parent, files, bytes, records, counted, pattern) "
                     "VALUES (?, ?, ?, ?, ?, ?, ?, ?)", ((p, e, _parent(p), *v) for (p, e), v in acc.items()))


def _touch(d: Path) -> None:
    with contextlib.suppress(OSError):
        os.utime(d)


def count_groups(c: str, root: Path, conn: sqlite3.Connection, d: Path | None = None) -> list[tuple[str, str]]:
    """Count the lines or entries of every file not yet counted (count_file), one (folder, extension) group at a time:
    each group's rows and its totals written in one transaction, then the coverage folder touched. [(path, why)] of the
    files that could not be counted (counted as 0)."""
    failed: list[tuple[str, str]] = []
    groups = conn.execute("SELECT DISTINCT folder, ext FROM files WHERE records IS NULL ORDER BY folder, ext").fetchall()
    for folder, ext in groups:
        rows = conn.execute("SELECT path FROM files WHERE folder = ? AND ext = ? AND records IS NULL", (folder, ext)).fetchall()
        unit = unit_of(str(ext))
        done: list[tuple[int, str | None, str | None, str]] = []
        for (path,) in rows:
            full = root / path
            try:
                done.append((int(count_file(full, path, unit)), unit, None, path))
            except Exception as e:  # noqa: BLE001 — a file that cannot be counted counts 0
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
            n = f"{len(failed):,} {'file' if len(failed) == 1 else 'files'}"
            notices.post(c, kind="coverage", text=COUNT_TEXT.format(n=n, reason=failed[0][1]), action=act,
                         key=COUNT_NOTICE)
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
        self.line_totals: dict[str, int] = {}  # a part file's lines, as its reads reported them
        self.read_bytes: dict[str, int] = {}  # the bytes read of each file read (_merge, read_bytes)
        for f in facts:
            path, how = str(f["path"]), f["how"]
            if f.get("folder"):
                self.areas.append((path, None))
            elif how == "whole":
                self.whole.add(path)
            elif how == "part":
                self.part.add(path)
                if isinstance(f.get("total"), int) and f["total"] > 0 and not f.get("pages"):
                    self.line_totals[path] = max(self.line_totals.get(path, 0), int(f["total"]))
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
        self.hit = set(self.searched)  # every file a search named, seen ones too
        self.searched -= self.seen

    def covers(self, path: str, folder: str, ext: str) -> bool:
        """Whether a searched area holds the file."""
        return any((x is None or x == ext) and (a == "" or _inside(folder, a)) for a, x in self.areas)

    def covers_level(self, level: str, ext: str) -> bool:
        """Whether a searched area holds every file right in the folder `level` of type `ext`."""
        return any((x is None or x == ext) and (a == "" or _inside(level, a)) for a, x in self.areas)


def _union(ranges: list[tuple[int, int]], hi: int) -> int:
    total, end = 0, 0
    for a, b in sorted(ranges):
        a, b = max(a, end + 1, 1), min(b, hi)
        if b >= a:
            total += b - a + 1
            end = b
    return total


def _records_seen(m: _Facts, path: str, ext: str, records: int | None) -> int:
    """The lines or entries of a file that were read: all of a whole file's, the lines of a line-based file's parts."""
    if records is None or path not in m.seen:
        return 0
    if path in m.whole:
        return records
    if unit_of(ext) == "lines" and path in m.lines:
        return _union(m.lines[path], records)
    return 0


def _span_bytes(idx: Any, full: Path, ranges: list[tuple[int, int]]) -> int | None:
    """The bytes of a file's line ranges, once each, by its line index; None when the index does not fit the file."""
    n, out, end = len(idx), 0, 0
    try:
        for a, b in sorted(ranges):
            a, b = max(a, end + 1, 1), min(b, n)
            if b < a:
                continue
            out += (idx.offset(full, b + 1) if b < n else idx.size) - idx.offset(full, a)
            end = b
    except (OSError, IndexError):
        return None
    return out


def read_bytes(m: _Facts, root: Path, path: str, ext: str, size: int, records: int | None) -> int:
    """The bytes read of a file read (module note, the size): all of a whole file's or of a file of the files unit; the
    bytes of a part's line ranges by the file's line index where one is at hand, else its size times the share of its
    lines read; none for a part without a line range."""
    if path not in m.seen:
        return 0
    unit = unit_of(ext)
    if path in m.whole or unit == "files":
        return size
    ranges = m.lines.get(path)
    if not ranges:
        return 0
    from . import corpus  # noqa: PLC0415

    idx = corpus.known_index(root / path)
    if idx is not None and (got := _span_bytes(idx, root / path, ranges)) is not None:
        return max(0, min(size, got))
    total = records if unit == "lines" and records else m.line_totals.get(path)
    if not total:
        return 0
    return min(size, round(size * _union(ranges, total) / total))


Totals = tuple[int, int, int, int]  # (files, bytes, records, files counted)
ZERO: Totals = (0, 0, 0, 0)


class _Index:
    """What the requests read from the index: the totals by (prefix, ext) and the rows of named files."""

    def __init__(self, conn: sqlite3.Connection | None):
        self.conn = conn
        self._totals: dict[tuple[str, str], Totals] = {}

    def _q(self, sql: str, args: tuple = ()) -> list[tuple]:
        return [] if self.conn is None else self.conn.execute(sql, args).fetchall()

    def totals(self, prefix: str, ext: str | None = None) -> Totals:
        """(files, bytes, records, counted) under `prefix`, of one extension or all."""
        if ext is not None:
            key = (prefix, ext)
            if key not in self._totals:
                row = self._q("SELECT files, bytes, records, counted FROM totals WHERE prefix = ? AND ext = ?", key)
                self._totals[key] = tuple(int(x) for x in row[0]) if row else ZERO  # type: ignore[assignment]
            return self._totals[key]
        out = [0, 0, 0, 0]
        for row in self._q("SELECT files, bytes, records, counted FROM totals WHERE prefix = ?", (prefix,)):
            for i in range(4):
                out[i] += int(row[i])
        return tuple(out)  # type: ignore[return-value]

    def exts(self, prefix: str) -> dict[str, Totals]:
        return {str(e): (int(f), int(b), int(r), int(k)) for e, f, b, r, k in self._q(
            "SELECT ext, files, bytes, records, counted FROM totals WHERE prefix = ?", (prefix,))}

    def children(self, prefix: str) -> list[tuple[str, str, Totals, str]]:
        """(child folder prefix, ext, totals, shared pattern) of the folders right under `prefix`."""
        return [(str(p), str(e), (int(f), int(b), int(r), int(k)), str(pat or "")) for p, e, f, b, r, k, pat in self._q(
            "SELECT prefix, ext, files, bytes, records, counted, pattern FROM totals WHERE parent = ?", (prefix,))]

    def child_folders(self, prefix: str) -> list[str]:
        return [str(p) for (p,) in self._q("SELECT DISTINCT prefix FROM totals WHERE parent = ?", (prefix,))]

    def direct_count(self, folder: str) -> int:
        row = self._q("SELECT COUNT(*) FROM files WHERE folder = ?", (folder,))
        return int(row[0][0]) if row else 0

    def direct_groups(self, folder: str) -> list[tuple[str, str, Totals]]:
        """(pattern, ext, totals) of the files right in `folder`, by name pattern and extension."""
        return [(str(p), str(e), (int(n), int(b or 0), int(r or 0), int(k or 0))) for p, e, n, b, r, k in self._q(
            "SELECT pattern, ext, COUNT(*), SUM(size), SUM(COALESCE(records, 0)), SUM(records IS NOT NULL) "
            "FROM files WHERE folder = ? GROUP BY pattern, ext", (folder,))]

    def direct_files(self, folder: str, where: str = "", args: tuple = (), limit: int | None = None) -> list[tuple]:
        """(path, folder, ext, size, records, reader) of the files right in `folder` (and `where`), by path."""
        sql = f"SELECT path, folder, ext, size, records, reader FROM files WHERE folder = ? {where} ORDER BY path"
        if limit is not None:
            sql += f" LIMIT {int(limit)}"
        return [(str(p), str(f), str(e), int(s), None if r is None else int(r), rd) for p, f, e, s, r, rd in
                self._q(sql, (folder, *args))]

    def one_file(self, prefix: str, ext: str) -> str | None:
        """The path of a file of `ext` under `prefix` (for a group of one)."""
        row = self._q("SELECT path FROM files WHERE path >= ? AND path < ? AND ext = ? LIMIT 1",
                      (prefix + "/", prefix + "0", ext))
        return str(row[0][0]) if row else None

    def rows_of(self, paths: Iterable[str]) -> dict[str, tuple[str, str, int, int | None, str | None]]:
        """{path: (folder, ext, size, records, reader)} of the named paths the index holds."""
        out: dict[str, tuple[str, str, int, int | None, str | None]] = {}
        wanted = list(dict.fromkeys(paths))
        for i in range(0, len(wanted), 500):
            part = wanted[i:i + 500]
            for p, folder, ext, size, records, reader in self._q(
                    f"SELECT path, folder, ext, size, records, reader FROM files WHERE path IN ({','.join('?' * len(part))})",
                    tuple(part)):
                out[str(p)] = (str(folder), str(ext), int(size), None if records is None else int(records), reader)
        return out

    def files_under(self, prefix: str) -> list[tuple[str, str, str, int, int | None, str | None]]:
        if prefix == "":
            rows = self._q("SELECT path, folder, ext, size, records, reader FROM files")
        else:
            rows = self._q("SELECT path, folder, ext, size, records, reader FROM files WHERE path >= ? AND path < ?",
                           (prefix + "/", prefix + "0"))
        return [(str(p), str(f), str(e), int(s), None if r is None else int(r), rd) for p, f, e, s, r, rd in rows]

    def glob(self, pattern: str) -> list[str]:
        return [str(p) for (p,) in self._q("SELECT path FROM files WHERE path GLOB ?", (pattern,))]


def _merge(c: str, sid: str, conn: sqlite3.Connection | None,
           given: tuple[list[dict[str, Any]], Derived] | None = None) -> tuple[_Facts, _Index, dict[str, tuple]]:
    """The merged facts, the index, and the files the facts name: {path: (folder, ext, size, records, reader)} for
    every one that exists, from the index or, for one the index does not hold yet, from the disk (records unknown, a
    sixth field True). `given` (facts as stored, derived searches) stands in for the session's own (summary_of)."""
    if given is None:
        facts = read_facts(c, sid)
        derived = _derived(c, _since(sid, facts))
    else:
        facts, derived = given
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
        if in_universe(p, tree):
            with contextlib.suppress(OSError):
                st = os.stat(root / p)
                if os.path.isfile(root / p):
                    folder = p.rsplit("/", 1)[0] if "/" in p else ""
                    ext = ext_of(p)
                    known[p] = (folder, ext, int(st.st_size), None if unit_of(ext) in COUNTED else 0, None,  # type: ignore[assignment]
                                True)
    m.seen &= set(known)
    m.searched &= set(known)
    m.hit &= set(known)
    for p in m.seen:
        row = known[p]
        m.read_bytes[p] = read_bytes(m, root, p, row[1], int(row[2]), row[3])
    return m, idx, known


def _status(m: _Facts, path: str, folder: str, ext: str) -> str:
    if path in m.seen:
        return "seen"
    if path in m.searched or m.covers(path, folder, ext):
        return "searched"
    return "never"


Covered = tuple[int, int, int]  # what searched areas hold of a row: (files, lines or entries, bytes)


def _covered(m: _Facts, idx: _Index, prefix: str, ext: str) -> Covered:
    """How many indexed files of `ext` under `prefix` the searched areas hold, their lines or entries, their bytes."""
    rel = [a for a, x in m.areas if x is None or x == ext]
    if any(a == "" or _inside(prefix, a) for a in rel):
        t = idx.totals(prefix, ext)
        return t[0], t[2], t[1]
    inner = sorted({a for a in rel if prefix == "" or a.startswith(prefix + "/")})
    top = [a for a in inner if not any(b != a and _inside(a, b) for b in inner)]
    files = records = size = 0
    for a in top:
        t = idx.totals(a, ext)
        files += t[0]
        records += t[2]
        size += t[1]
    return files, records, size


class _Tally:
    """One row's counts as they add up: files, files read (`seen`) and searched; its count in its unit (lines or
    entries: `records`), read and searched; its bytes, read and searched."""

    KEYS = ("files", "seen", "searched", "records_seen", "records_searched", "records", "counted", "bytes",
            "bytes_seen", "bytes_searched")

    def __init__(self) -> None:
        self.files = self.seen = self.searched = 0
        self.records_seen = self.records_searched = self.records = self.counted = self.bytes = 0
        self.bytes_seen = self.bytes_searched = 0

    def add_totals(self, t: Totals) -> None:
        self.files += t[0]
        self.bytes += t[1]
        self.records += t[2]
        self.counted += t[3]

    def add(self, o: "_Tally") -> None:
        for k in self.KEYS:
            setattr(self, k, getattr(self, k) + getattr(o, k))


def _count(m: _Facts, base: Totals, covered: Covered, members: Iterable[tuple[str, tuple]]) -> _Tally:
    """A row's counts: its index totals (`base`), what searched areas hold of it (`covered`: files, records, bytes), and
    the files the facts name that fall in it (`members`: (path, index row), a sixth field True for a file the index does
    not hold yet). A file seen wins over a search; the records and bytes of a file seen in part that a search touched
    too, less those seen, count as searched."""
    g = _Tally()
    g.add_totals(base)
    cov_files, cov_records, cov_bytes = covered
    for path, row in members:
        folder, ext, size, records = row[:4]
        size = int(size)
        extra = len(row) > 5
        if extra:
            g.files += 1
            g.bytes += size
        rec = int(records or 0)
        area = m.covers(path, folder, ext)
        if path in m.seen:
            g.seen += 1
            rs = _records_seen(m, path, ext, records)
            rb = m.read_bytes.get(path, 0)
            g.records_seen += rs
            g.bytes_seen += rb
            if area and not extra:
                cov_files -= 1
                cov_records -= rec
                cov_bytes -= size
            if area or path in m.hit:
                g.records_searched += max(0, rec - rs)
                g.bytes_searched += max(0, size - rb)
        elif area:
            if extra:
                g.searched += 1
                g.bytes_searched += size
        elif path in m.searched:
            g.searched += 1
            g.records_searched += rec
            g.bytes_searched += size
    g.searched += max(0, cov_files)
    g.records_searched += max(0, cov_records)
    g.bytes_searched += max(0, cov_bytes)
    return g


def _group_of(folder: str, prefix: str) -> str:
    """The segment of the group a file falls in at the level of `prefix`: its first folder under `prefix`, or `.`."""
    rest = folder[len(prefix) + 1:] if prefix else folder
    if folder == prefix or not rest:
        return "."
    return rest.split("/", 1)[0]


def _coarse(m: _Facts, idx: _Index, known: dict[str, tuple], prefix: str) -> dict[tuple[str, str], _Tally]:
    """The counts of each (segment, ext) at the level of `prefix`: each folder right under it, and `.` for the files
    right in it."""
    base: dict[tuple[str, str], Totals] = {}
    cov: dict[tuple[str, str], Covered] = {}
    child_sums: dict[str, list[int]] = {}
    for child, ext, t, _ in idx.children(prefix):
        key = (child.rsplit("/", 1)[-1], ext)
        base[key] = t
        cov[key] = _covered(m, idx, child, ext)
        s = child_sums.setdefault(ext, [0, 0, 0, 0])
        for i in range(4):
            s[i] += t[i]
    for ext, t in idx.exts(prefix).items():
        direct = tuple(t[i] - child_sums.get(ext, [0, 0, 0, 0])[i] for i in range(4))
        if direct[0] > 0:
            base[(".", ext)] = direct  # type: ignore[assignment]
            cov[(".", ext)] = (direct[0], direct[2], direct[1]) if m.covers_level(prefix, ext) else (0, 0, 0)
    members: dict[tuple[str, str], list[tuple[str, tuple]]] = {}
    for path, row in known.items():
        if prefix and not _inside(row[0], prefix):
            continue
        members.setdefault((_group_of(row[0], prefix), row[1]), []).append((path, row))
    return {k: _count(m, base.get(k, ZERO), cov.get(k, (0, 0, 0)), members.get(k, [])) for k in {*base, *members}}


def _dot(ext: str) -> str:
    return f".{ext}" if ext else NO_EXT


def _row(key: str, folder: str, ext: str, path: str | None, name: str, g: _Tally, *, drill: bool = False,
         match: str | None = None) -> dict[str, Any]:
    counted = g.files > 0 and g.counted >= g.files
    return {"key": key, "folder": folder, "ext": _dot(ext), "path": path, "name": name, "unit": unit_of(ext),
            "files": g.files, "seen": g.seen, "searched": g.searched, "never": max(0, g.files - g.seen - g.searched),
            "records_seen": g.records_seen, "records_searched": g.records_searched,
            "records_total": g.records if counted else None, "bytes": g.bytes, "drill": drill, "match": match}


def percent(part: int, total: int) -> str:
    """A share in words: `0%`, `<0.01%`, two decimals below 0.1% and one below 1% (cut, so 0.99% reads `0.9%`), else a
    whole percent (`99%` for nearly all, `100%` only for all)."""
    if total <= 0 or part <= 0:
        return "0%"
    p = 100 * part / total
    if part >= total:
        return "100%"
    if p < 0.01:
        return "<0.01%"
    if p < 0.1:  # cut, not rounded, below 1%: a share never reads as the next step up
        return f"{math.floor(p * 100) / 100:.2f}%"
    if p < 1:
        return f"{math.floor(p * 10) / 10:.1f}%"
    return f"{min(99, math.floor(p + 0.5))}%"  # half up, as the terminal UI's percent rounds


def line_of(size: dict[str, int] | None, indexed: bool = True, seen: int = 0, searched: int = 0) -> str:
    """The summary line (module note, the size): the read and searched shares of the corpus by size, the searched share
    only when not 0; with no index yet (or an empty corpus), the files the facts name."""
    def files(n: int) -> str:
        return "file" if n == 1 else "files"

    if not indexed or not size or size.get("total", 0) <= 0:
        return f"read {seen:,} · searched {searched:,} {files(seen + searched)}" if searched else \
            f"read {seen:,} {files(seen)}"
    words = f"read {percent(size['read'], size['total'])}"
    if size["searched"]:
        words += f" · searched {percent(size['searched'], size['total'])}"
    return f"{words} of the data"


def _open(c: str) -> tuple[sqlite3.Connection | None, bool]:
    conn = _connect_ro(index_path(c))
    return conn, _fresh_or_start(c, conn)


def summary(c: str, sid: str) -> dict[str, Any]:
    """The session's coverage over the corpus: {files: {seen, searched, never, total} over every file, totals: one entry
    per unit the corpus has, in UNITS' order (lines and entries: {unit, seen, searched, total, counted, files,
    files_seen, files_searched}; files: {unit, seen, searched, total}), records: the first entry of lines or entries as
    {unit, seen, searched, total, counted} (the earlier form's field; never two units added up), size: the whole
    corpus's {read, searched, total} in bytes (None with no index yet), line, counting}. `seen` is read. Reads the index
    only."""
    return _summary(c, sid)


def summary_of(c: str, facts: list[dict[str, Any]], derived: Derived, *, never: bool = False) -> dict[str, Any]:
    """summary for the facts and derived searches given in place of a session's (the orientation's coverage line,
    orient_checks.coverage): the facts in add_facts's form (clean_facts keeps those that count). With `never`, also
    `never`: the indexed files neither read nor searched, by path."""
    return _summary(c, "", (clean_facts(c, facts), derived), never=never)


def _summary(c: str, sid: str, given: tuple[list[dict[str, Any]], Derived] | None = None, *,
             never: bool = False) -> dict[str, Any]:
    conn, indexed = _open(c)
    try:
        m, idx, known = _merge(c, sid, conn, given)
        by_unit = {u: _Tally() for u in UNITS}
        if indexed:
            for (_, ext), t in _coarse(m, idx, known, "").items():
                by_unit[unit_of(ext)].add(t)
        g = _Tally()
        for t in by_unit.values():
            g.add(t)
        if not indexed:  # no index yet: the files the facts name
            g.files, g.seen, g.searched = len(known), len(m.seen), len(m.searched)
        totals: list[dict[str, Any]] = []
        for unit in UNITS if indexed else ():
            u = by_unit[unit]
            if not u.files:
                continue
            if unit == "files":
                totals.append({"unit": unit, "seen": u.seen, "searched": u.searched, "total": u.files})
                continue
            counted = u.counted >= u.files
            totals.append({"unit": unit, "seen": u.records_seen if counted else 0,
                           "searched": u.records_searched if counted else 0, "total": u.records if counted else 0,
                           "counted": counted, "files": u.files, "files_seen": u.seen, "files_searched": u.searched})
        first = next((t for t in totals if t["unit"] in COUNTED), None)
        records = {k: first[k] for k in ("unit", "seen", "searched", "total", "counted")} if first else \
            {"unit": "lines", "seen": 0, "searched": 0, "total": 0, "counted": False}
        size = {"read": g.bytes_seen, "searched": g.bytes_searched, "total": g.bytes} if indexed else None
        out = {"files": {"seen": g.seen, "searched": g.searched, "never": max(0, g.files - g.seen - g.searched),
                         "total": g.files},
               "records": records, "totals": totals, "size": size, "line": line_of(size, indexed, g.seen, g.searched),
               "counting": not indexed or any(not t["counted"] for t in totals if t["unit"] in COUNTED)}
        if never:
            out["never"] = sorted(p for p, folder, ext, *_ in idx.files_under("")
                                  if _status(m, p, folder, ext) == "never") if indexed else []
        return out
    finally:
        if conn is not None:
            conn.close()


def _file_rows(m: _Facts, files: dict[str, tuple], known: dict[str, tuple]) -> list[dict[str, Any]]:
    """One row per file: {path: (folder, ext, size, records, reader[, extra])}, seen first, then searched, then the
    others, each by path."""
    out = []
    for p, row in files.items():
        folder, ext, size, records = row[0], row[1], row[2], row[3]
        extra = len(row) > 5
        base = ZERO if extra else (1, int(size), int(records or 0), int(records is not None))
        cov = (1, int(records or 0), int(size)) if m.covers(p, folder, ext) and not extra else (0, 0, 0)
        g = _count(m, base, cov, [(p, known.get(p, row))] if p in known else [])
        out.append(_row(p, folder, ext, p, p.rsplit("/", 1)[-1], g))
    order = {"seen": 0, "searched": 1, "never": 2}
    return sorted(out, key=lambda r: (order["seen" if r["seen"] else "searched" if r["searched"] else "never"],
                                      r["path"]))


def _deep(idx: _Index, prefix: str) -> str:
    """The folder a row of `prefix` names: `prefix`, or while a folder holds no file and only one folder, that one."""
    seen_depth = 0
    while seen_depth < 64:
        kids = idx.child_folders(prefix)
        if len(kids) != 1 or idx.direct_count(prefix):
            return prefix
        prefix = kids[0]
        seen_depth += 1
    return prefix


def _big_patterns(groups: list[tuple[str, str, Totals]]) -> set[tuple[str, str]]:
    """The (pattern, ext) of the direct groups that share a name pattern among PATTERN_MIN files or more."""
    return {(p, e) for p, e, t in groups if t[0] >= PATTERN_MIN and "*" in p}


def _group_label(pattern: str, ext: str) -> str:
    """A pattern's name in the rows: the glob, or the type when the pattern is any name of that type (`*.png`)."""
    return _dot(ext) if pattern in ("*", f"*.{ext}") else pattern


def level(c: str, sid: str, folder: str = "", match: str | None = None) -> dict[str, Any]:
    """One level of the corpus (module note): {folder, match, rows, more}. `match` lists the files of one group right
    in `folder`: a name pattern (`agent-*.jsonl`) or a type (`.md`, the files of that type no pattern row holds)."""
    folder = str(folder or "").strip().strip("/")
    if folder == ".":
        folder = ""
    match = str(match).strip() if match else None
    conn, _ = _open(c)
    try:
        m, idx, known = _merge(c, sid, conn)
        if match:
            rows, more = _group_files(m, idx, known, folder, match)
        else:
            rows, more = _level_rows(m, idx, known, folder)
        return {"folder": folder, "match": match, "rows": rows, "more": more}
    finally:
        if conn is not None:
            conn.close()


def _cap(rows: list[dict[str, Any]], n_more: int = 0) -> tuple[list[dict[str, Any]], int]:
    if len(rows) > LIST_MAX:
        return rows[:LIST_MAX], len(rows) - LIST_MAX + n_more
    return rows, n_more


def _level_rows(m: _Facts, idx: _Index, known: dict[str, tuple], folder: str) -> tuple[list[dict[str, Any]], int]:
    extras = {p: r for p, r in known.items() if len(r) > 5 and (not folder or _inside(r[0], folder))}
    if idx.totals(folder)[0] + len(extras) <= FILE_ROWS:
        files: dict[str, tuple] = {p: (f, e, s, r, rd) for p, f, e, s, r, rd in idx.files_under(folder)}
        for p, row in extras.items():
            files.setdefault(p, row)
        return _cap(_file_rows(m, files, known))
    out: list[dict[str, Any]] = []
    # the folders right under the level, one row per type
    coarse = _coarse(m, idx, known, folder)
    pats = {(child.rsplit("/", 1)[-1], ext): pat for child, ext, _, pat in idx.children(folder)}
    for (seg, ext), g in coarse.items():
        if seg == ".":
            continue
        prefix = f"{folder}/{seg}" if folder else seg
        if g.files == 1:  # a type of one file under this folder: that file's row
            one = next((p for p, r in known.items() if r[1] == ext and _inside(r[0], prefix)), None) or \
                idx.one_file(prefix, ext)
            if one:
                row = known.get(one) or idx.rows_of([one]).get(one)
                if row:
                    out.extend(_file_rows(m, {one: row}, known))
                    continue
        deep = _deep(idx, prefix)
        pat = pats.get((seg, ext), "")
        name = _group_label(pat, ext) if pat and g.files >= 2 else _dot(ext)
        out.append(_row(f"dir:{deep}|{_dot(ext)}", deep, ext, None, name, g, drill=True))
    # the files right in the level
    direct_known = {p: r for p, r in known.items() if r[0] == folder}
    groups = idx.direct_groups(folder)
    have = {(p, e) for p, e, _ in groups}
    for p, r in direct_known.items():  # files the index does not hold yet
        key = (name_pattern(p.rsplit("/", 1)[-1]), r[1])
        if len(r) > 5 and key not in have:
            groups.append((*key, ZERO))
            have.add(key)
    n_direct = sum(t[0] for _, _, t in groups) + sum(1 for r in direct_known.values() if len(r) > 5)
    if n_direct:
        big = _big_patterns(groups)
        member: dict[tuple[str, str], list[tuple[str, tuple]]] = {}
        for p, r in direct_known.items():
            member.setdefault((name_pattern(p.rsplit("/", 1)[-1]), r[1]), []).append((p, r))
        rest = [(p, e, t) for p, e, t in groups if (p, e) not in big]
        rest_exts = {e for _, e, _ in rest}
        for pat, ext in sorted(big):
            t = next(t for p, e, t in groups if (p, e) == (pat, ext))
            cov = (t[0], t[2], t[1]) if m.covers_level(folder, ext) else (0, 0, 0)
            g = _count(m, t, cov, member.get((pat, ext), []))
            # a pattern of any name of its type reads as the type, unless a row of that type's other files stands by it
            label = pat if ext in rest_exts else _group_label(pat, ext)
            out.append(_row(f"grp:{folder}|{pat}", folder, ext, None, label, g, drill=True, match=pat))
        n_rest = sum(t[0] for _, _, t in rest) + sum(1 for (p, e), ms in member.items() if (p, e) not in big
                                                      for _, r in ms if len(r) > 5)
        if n_rest <= FILE_ROWS:
            where, args = _not_big(big)
            files = {p: (f, e, s, r, rd) for p, f, e, s, r, rd in idx.direct_files(folder, where, args)}
            for p, r in direct_known.items():
                if len(r) > 5 and (name_pattern(p.rsplit("/", 1)[-1]), r[1]) not in big:
                    files.setdefault(p, r)
            out.extend(_file_rows(m, files, known))
        else:
            by_ext: dict[str, list[int]] = {}
            for _, e, t in rest:
                s = by_ext.setdefault(e, [0, 0, 0, 0])
                for i in range(4):
                    s[i] += t[i]
            for ext, t in by_ext.items():
                ms = [x for (p, e), xs in member.items() if e == ext and (p, e) not in big for x in xs]
                if t[0] + sum(1 for _, r in ms if len(r) > 5) == 1:
                    where, args = _not_big(big)
                    files = {p: (f, e, s, r, rd) for p, f, e, s, r, rd in
                             idx.direct_files(folder, where + " AND ext = ?", (*args, ext))}
                    for p, r in ms:
                        files.setdefault(p, r)
                    out.extend(_file_rows(m, files, known))
                    continue
                cov = (t[0], t[2], t[1]) if m.covers_level(folder, ext) else (0, 0, 0)
                g = _count(m, tuple(t), cov, ms)  # type: ignore[arg-type]
                out.append(_row(f"grp:{folder}|.{ext}", folder, ext, None, _dot(ext), g, drill=True, match=_dot(ext)))
    out.sort(key=lambda r: (-r["files"], -r["bytes"], r["key"]))  # the largest group first, then the largest file
    return _cap(out)


def _not_big(big: set[tuple[str, str]]) -> tuple[str, tuple]:
    """A WHERE part that leaves out the files of the pattern rows `big`."""
    if not big:
        return "", ()
    return " AND NOT (" + " OR ".join("(pattern = ? AND ext = ?)" for _ in big) + ")", tuple(x for pe in sorted(big)
                                                                                           for x in pe)


def _group_files(m: _Facts, idx: _Index, known: dict[str, tuple], folder: str,
                 match: str) -> tuple[list[dict[str, Any]], int]:
    """The files of one group right in `folder` (level, `match`), the ones the facts name first, at most LIST_MAX."""
    groups = idx.direct_groups(folder)
    big = _big_patterns(groups)
    if match.startswith(".") and "*" not in match:  # a type: its files no pattern row holds
        ext = match[1:].lower() if match != NO_EXT else ""
        where, args = _not_big(big)
        where, args = where + " AND ext = ?", (*args, ext)
        n = sum(t[0] for p, e, t in groups if e == ext and (p, e) not in big)

        def mine(p: str, r: tuple) -> bool:
            return r[1] == ext and (name_pattern(p.rsplit("/", 1)[-1]), ext) not in big
    else:
        where, args = " AND pattern = ?", (match,)
        n = sum(t[0] for p, _, t in groups if p == match)

        def mine(p: str, r: tuple) -> bool:
            return name_pattern(p.rsplit("/", 1)[-1]) == match
    named = {p: r for p, r in known.items() if r[0] == folder and mine(p, r)}
    first = _file_rows(m, named, known)
    rest = idx.direct_files(folder, where, args, limit=LIST_MAX + len(named))
    files = {p: (f, e, s, r, rd) for p, f, e, s, r, rd in rest if p not in named}
    out = first + sorted(_file_rows(m, files, known), key=lambda r: r["path"])
    listed = out[:LIST_MAX]
    extra = sum(1 for r in named.values() if len(r) > 5)
    return listed, max(0, n + extra - len(listed))


def rows(c: str, sid: str, folder: str = "", match: str | None = None) -> list[dict[str, Any]]:
    """The rows of one level of the corpus (level), each {key, folder, ext, path, name, unit, files, seen, searched,
    never, records_seen, records_searched, records_total, bytes, drill, match}; `ext` with its dot, or `(none)`."""
    return level(c, sid, folder, match)["rows"]


def state(c: str, sid: str, folder: str = "", *, summary_only: bool = False, match: str | None = None) -> dict[str, Any]:
    """`thimble state coverage`: {summary, folder, match, rows?, more?, counting}; the summary is the whole corpus's at
    every level."""
    s = summary(c, sid)
    out: dict[str, Any] = {"summary": {k: s[k] for k in ("files", "records", "totals", "size", "line")}, "folder": folder,
                           "match": match or None, "counting": s["counting"]}
    if not summary_only:
        got = level(c, sid, folder, match)
        out["rows"], out["more"] = got["rows"], got["more"]
    return out


def main(argv: list[str]) -> int:
    logging.basicConfig(level=logging.WARNING, stream=sys.stderr, format="thimble %(levelname)s: %(message)s")
    if argv[:1] == ["index"]:
        return index_main(argv[1:])
    sys.stderr.write("usage: python -m app.coverage index --cwd <dir>\n")
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
