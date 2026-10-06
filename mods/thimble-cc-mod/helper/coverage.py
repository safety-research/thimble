"""thimble-cc-mod coverage: which of the corpus's files and records the agents read, and which they never opened.

The mod records every tool result of main and of every subagent (hooks/coverage.ts); this file decides what each one
read and keeps it in .thimble-cc-mod/coverage/reads.jsonl, one line per file a call touched:

    {"t": 1759650000.1, "agent": "main", "tool": "Bash", "file": "events.jsonl", "how": "read", "lines": [[1, 20]]}

- read: records the model saw in the call's output. A Read call's own line numbers; for Bash and Grep, the lines of
  the files the call named (or that Python opened while it ran) whose start, or the start of one of whose long string
  fields, appears in the output (a 40-character window), or a short line the output shows whole.
- scan: the call processed the file without showing its records (a script counted over it, grep searched it, wc
  counted it). Python's opens come from helper/pyaudit/sitecustomize.py, which the mod puts on PYTHONPATH.

    python3 coverage.py record     stdin {"cwd", "events": [{"agent", "tool", "input", "output", "t"?}]}
    python3 coverage.py summary    [--cwd DIR] [--agent ID ...] [--session ID] [--json]
    python3 coverage.py            the summary, as text, of this session (THIMBLE_CC_MOD_SESSION) in its folder

Each read is kept with its session, and the summary counts one session's (the mod sets THIMBLE_CC_MOD_SESSION), since
a later session's model has not seen what an earlier one read.

A record is a line of a text file (a JSON line, a CSV row, a log line); a binary file counts by its bytes alone.
"""
from __future__ import annotations

import argparse
import fnmatch
import glob
import json
import os
import pickle
import re
import shlex
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from refs import HOME  # noqa: E402

DIR = "coverage"
SKIP_DIRS = {".git", ".thimble-cc-mod", ".claude", "node_modules", "__pycache__", ".venv", "venv", ".mypy_cache"}
MAX_FILES = 20000  # files listed at most; past this the summary says so
WINDOW = 40  # characters of a line's start (or a string field's) looked for in an output
SHORT_MIN = 12  # a line shorter than WINDOW counts when the output shows it whole, from this length
FIELD_MIN = WINDOW  # string fields of a JSON record this long are indexed by their start too
LONG = 4 * WINDOW  # characters of a line's start that tell apart lines that begin alike (a transcript's records)
INDEX_VERSION = 2
DUP_MAX = 3  # a window shared by more lines than this says nothing about which record was seen
INDEX_MAX_BYTES = 200_000_000  # a larger file is not indexed: its records count as seen only by line numbers
CANDIDATES_MAX = 60  # files one call's output is matched against
OUTPUT_MAX = 400_000  # characters of one output matched
READERS = {"cat", "head", "tail", "sed", "awk", "gawk", "grep", "egrep", "fgrep", "rg", "ag", "wc", "jq", "less", "more",
           "cut", "sort", "uniq", "nl", "tr", "strings", "xxd", "od", "hexdump", "diff", "cmp", "column", "tac", "python",
           "python3", "perl", "ruby", "node", "csvlook", "csvcut", "sqlite3", "duckdb", "zcat", "gzip", "bat", "md5sum",
           "sha1sum", "sha256sum", "split", "paste", "join", "comm", "iconv", "file"}
NOT_CONTENT = {"wc", "md5sum", "sha1sum", "sha256sum", "file", "cmp"}  # read a file but show none of its records
RECURSIVE = {"rg", "ag"}  # search folders without -r
_READ_LINE = re.compile(r"^\s*(\d+)(?:→|\t)", re.M)  # a Read result's numbered line
_GREP_N = re.compile(r"^(?:(?P<path>[^\n:]+?)[:-])?(?P<n>\d+)[:-]", re.M)  # grep -n / rg -n prefixes
_DIGITS = re.compile(r"\d+")
_HEXID = re.compile(r"(?=[0-9a-f]*\d)[0-9a-f]{8,}", re.I)


def home(cwd: str) -> str:
    return os.path.join(cwd, HOME, DIR)


# ------------------------------------------------------------------------------------------------ the corpus


def corpus_files(cwd: str) -> list[str]:
    """Every file of the corpus, relative to its folder, in sorted order: hidden folders and the mod's own left out."""
    out: list[str] = []
    for d, dirs, files in os.walk(cwd):
        dirs[:] = sorted(x for x in dirs if x not in SKIP_DIRS and not x.startswith("."))
        for f in sorted(files):
            if f.startswith("."):
                continue
            out.append(os.path.relpath(os.path.join(d, f), cwd))
            if len(out) >= MAX_FILES:
                return out
    return out


def _is_text(path: str) -> bool:
    try:
        with open(path, "rb") as f:
            head = f.read(8192)
    except OSError:
        return False
    return b"\0" not in head and not path.lower().endswith((".db", ".sqlite", ".sqlite3", ".parquet", ".gz", ".zip",
                                                             ".png", ".jpg", ".jpeg", ".pdf", ".mp4", ".pkl"))


def _count_lines(path: str) -> int:
    n, last = 0, b"\n"
    with open(path, "rb") as f:
        while chunk := f.read(1 << 20):
            n += chunk.count(b"\n")
            last = chunk[-1:]
    return n + (0 if last == b"\n" else 1)


def file_stats(cwd: str, files: list[str]) -> dict[str, dict]:
    """{file: {size, records}} with `records` None for a binary file, cached by size and mtime in files.json."""
    cache_path = os.path.join(home(cwd), "files.json")
    try:
        with open(cache_path, encoding="utf-8") as f:
            cache = json.load(f)
    except (OSError, ValueError):
        cache = {}
    out, changed = {}, False
    for rel in files:
        p = os.path.join(cwd, rel)
        try:
            st = os.stat(p)
        except OSError:
            continue
        key = f"{st.st_size}:{int(st.st_mtime)}"
        hit = cache.get(rel)
        if not hit or hit.get("key") != key:
            records = _count_lines(p) if _is_text(p) else None
            if records is not None and rel.lower().endswith((".csv", ".tsv")) and records:
                records -= 1  # the header
            hit = cache[rel] = {"key": key, "size": st.st_size, "records": records}
            changed = True
        out[rel] = {"size": hit["size"], "records": hit["records"]}
    if changed:
        os.makedirs(home(cwd), exist_ok=True)
        with open(cache_path, "w", encoding="utf-8") as f:
            json.dump(cache, f)
    return out


def kind_of(rel: str) -> str:
    """A kind of file: its path with ids and numbers masked, so runs/7/events.jsonl and runs/12/events.jsonl are one."""
    return _DIGITS.sub("#", _HEXID.sub("*", rel))


# ------------------------------------------------------------------------------------------------ what a call read


def _rel(cwd: str, path: str) -> str | None:
    """A path under the corpus, relative to it; None outside it or under a skipped folder."""
    if not path:
        return None
    p = os.path.realpath(path if os.path.isabs(path) else os.path.join(cwd, path))
    root = os.path.realpath(cwd)
    if not p.startswith(root + os.sep):
        return None
    rel = os.path.relpath(p, root)
    if any(part in SKIP_DIRS or part.startswith(".") for part in rel.split(os.sep)):
        return None
    return rel


def _expand(cwd: str, tok: str, recursive: bool) -> list[str]:
    """The corpus files a command's word names: a file, every file a glob matches, every file under a folder when the
    command searches folders."""
    if not tok or tok.startswith("-") or len(tok) > 400:
        return []
    tok = tok.strip("'\"")
    out: list[str] = []
    if any(c in tok for c in "*?["):
        pat = tok if os.path.isabs(tok) else os.path.join(cwd, tok)
        for p in sorted(glob.glob(pat, recursive=True))[:5000]:
            if os.path.isfile(p) and (r := _rel(cwd, p)):
                out.append(r)
        return out
    p = tok if os.path.isabs(tok) else os.path.join(cwd, tok)
    if os.path.isfile(p):
        r = _rel(cwd, p)
        return [r] if r else []
    if recursive and os.path.isdir(p):
        base = _rel(cwd, p) if os.path.realpath(p) != os.path.realpath(cwd) else ""
        if base is None:
            return []
        return [f for f in corpus_files(cwd) if not base or f.startswith(base + os.sep)]
    return []


def bash_files(cwd: str, command: str) -> tuple[list[str], bool]:
    """The corpus files a Bash command reads, and whether every command of it that reads only counts (wc) rather than
    showing records. When any command of its pipelines reads files (cat, sed, grep, python, ...), each word anywhere
    in it that names a corpus file or a glob of them counts, so `for f in a.jsonl b.jsonl; do head $f; done` reads
    both; a folder counts, every file under it, when a searching command recurses (grep -r, rg)."""
    try:
        lex = shlex.shlex(command, posix=True, punctuation_chars=";&|()<>")
        lex.whitespace_split = True
        words = list(lex)
    except ValueError:
        words = command.split()
    readers: list[str] = []
    recursive = False
    seg: list[str] = []

    def flush() -> None:
        nonlocal recursive
        i = 0
        while i < len(seg) and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*=.*", seg[i]):
            i += 1  # VAR=value before the command
        while i < len(seg) and seg[i] in ("sudo", "env", "time", "nice", "xargs", "uv", "run", "exec", "command", "do", "then", "else"):
            i += 1
        if i >= len(seg):
            return
        cmd = os.path.basename(seg[i])
        cmd = "python" if cmd.startswith("python") else cmd
        if cmd in READERS:
            readers.append(cmd)
            if cmd in RECURSIVE or any(w in ("-r", "-R", "--recursive") or re.fullmatch(r"-[a-zA-Z]*[rR][a-zA-Z]*", w) for w in seg[i + 1:]):
                recursive = True

    for w in words:
        if w in (";", "&&", "||", "|", "&", "(", ")", "|&") or w in ("do", "then"):
            flush()
            seg = [] if w not in ("do", "then") else []
        else:
            seg.append(w)
    flush()
    if not readers:
        return [], False
    files: dict[str, None] = {}
    for w in words:
        for f in _expand(cwd, w, recursive):
            files.setdefault(f, None)
    return list(files), all(r in NOT_CONTENT for r in readers)


def _index_path(cwd: str, rel: str) -> str:
    return os.path.join(home(cwd), "index", re.sub(r"[^A-Za-z0-9._-]", "_", rel) + ".pkl")


def line_index(cwd: str, rel: str) -> dict | None:
    """What an output is matched against, for one text file, each table {key: [line, ...]}: `start`, each line's first
    WINDOW characters; `long`, its first LONG; `short`, a line shorter than WINDOW whole; `field`, the first WINDOW
    characters of each long string field of a JSON line, as a script prints it and as the raw line holds it. Cached
    by size and mtime under coverage/index/."""
    p = os.path.join(cwd, rel)
    try:
        st = os.stat(p)
    except OSError:
        return None
    if st.st_size > INDEX_MAX_BYTES or not _is_text(p):
        return None
    key = f"{st.st_size}:{int(st.st_mtime)}:{INDEX_VERSION}"
    ip = _index_path(cwd, rel)
    try:
        with open(ip, "rb") as f:
            got = pickle.load(f)
        if got.get("key") == key:
            return got
    except (OSError, pickle.PickleError, EOFError, AttributeError, ValueError):
        pass
    tables: dict[str, dict[str, list[int]]] = {"start": {}, "long": {}, "short": {}, "field": {}}

    def add(table: str, k: str, n: int) -> None:
        got = tables[table].setdefault(k, [])
        if len(got) <= DUP_MAX and (not got or got[-1] != n):
            got.append(n)

    with open(p, encoding="utf-8", errors="replace") as f:
        for n, raw in enumerate(f, start=1):
            line = raw.rstrip("\n").strip()
            if len(line) >= WINDOW:
                add("start", line[:WINDOW], n)
                if len(line) >= LONG:
                    add("long", line[:LONG], n)
            elif len(line) >= SHORT_MIN:
                add("short", line, n)
            if line.startswith("{") and len(line) > FIELD_MIN:
                try:
                    obj = json.loads(line)
                except ValueError:
                    continue
                for v in _strings(obj):
                    v = v.strip()
                    if len(v) >= FIELD_MIN:
                        add("field", v[:WINDOW], n)
                        add("field", json.dumps(v, ensure_ascii=False)[1:WINDOW + 1], n)
    got = {"key": key, **tables}
    os.makedirs(os.path.dirname(ip), exist_ok=True)
    try:
        with open(ip, "wb") as f:
            pickle.dump(got, f, protocol=pickle.HIGHEST_PROTOCOL)
    except OSError:
        pass
    return got


def _strings(obj: object, depth: int = 0):
    if depth > 4:
        return
    if isinstance(obj, str):
        yield obj
    elif isinstance(obj, dict):
        for v in obj.values():
            yield from _strings(v, depth + 1)
    elif isinstance(obj, list):
        for v in obj[:50]:
            yield from _strings(v, depth + 1)


_LEAD = re.compile(r"^\s*(?:(?:[^\s:]+?:)?\d+[:\-\t→]\s?|\d+\t)?")  # grep -n, rg -n, cat -n prefixes
_BOUNDARY = re.compile(r'(?:"|\t|: |= |\| |, )')  # where a field's value can begin within a line


def seen_lines(cwd: str, rel: str, output: str) -> set[int]:
    """The lines of `rel` an output shows: an output line that begins as one of its lines does (or is a short one
    whole), or a long string field of one of its records beginning at the start of an output line or after a quote,
    a tab or a separator."""
    idx = line_index(cwd, rel)
    if not idx or not output:
        return set()
    hits: list[list[int]] = []

    def take(table: str, k: str) -> bool:
        hit = idx[table].get(k)
        if hit and len(hit) <= DUP_MAX:
            hits.append(hit)
            return True
        return False

    for ln in output[:OUTPUT_MAX].splitlines():
        body = ln[_LEAD.match(ln).end():].strip()
        if len(body) < SHORT_MIN:
            continue
        if len(body) < WINDOW:
            take("short", body) or take("short", ln.strip())
        elif not take("long", body[:LONG]) and not take("start", body[:WINDOW]):
            take("field", body[:WINDOW])
        for m in _BOUNDARY.finditer(body):
            at = m.end()
            if len(body) - at >= WINDOW:
                take("field", body[at:at + WINDOW])
    # A key one line holds names that line. One a few lines share (revisions of a page that begin alike) names one of
    # them, unless a line it names is already counted: the count of records seen stays right, if not which ones.
    out: set[int] = {h[0] for h in hits if len(h) == 1}
    for h in hits:
        if len(h) > 1 and not out.intersection(h):
            out.add(h[0])
    return out


def ranges(lines: set[int] | list[int]) -> list[list[int]]:
    """Line numbers as [first, last] runs."""
    out: list[list[int]] = []
    for n in sorted(set(lines)):
        if out and n == out[-1][1] + 1:
            out[-1][1] = n
        else:
            out.append([n, n])
    return out


def _opens_since(cwd: str) -> list[str]:
    """The corpus files Python opened since the last call recorded (pyaudit's opens.jsonl past the kept offset)."""
    path = os.path.join(home(cwd), "opens.jsonl")
    off_path = os.path.join(home(cwd), "opens.offset")
    try:
        off = int(open(off_path).read().strip() or 0)
    except (OSError, ValueError):
        off = 0
    out: list[str] = []
    try:
        with open(path, "rb") as f:
            f.seek(off)
            data = f.read()
            end = f.tell()
    except OSError:
        return out
    for raw in data.decode("utf-8", "replace").splitlines():
        try:
            r = _rel(cwd, json.loads(raw).get("file", ""))
        except ValueError:
            continue
        if r and r not in out:
            out.append(r)
    with open(off_path, "w") as f:
        f.write(str(end))
    return out


def _tool_text(output: object) -> str:
    if isinstance(output, str):
        return output
    if isinstance(output, list):
        return "\n".join(str(b.get("text", "")) for b in output if isinstance(b, dict) and b.get("type") == "text")
    return ""


def reads_of(cwd: str, ev: dict) -> list[dict]:
    """What one tool call read, as reads.jsonl lines (without its time and agent)."""
    tool = str(ev.get("tool") or "")
    inp = ev.get("input") if isinstance(ev.get("input"), dict) else {}
    output = _tool_text(ev.get("output"))
    out: list[dict] = []
    if tool == "Read":
        rel = _rel(cwd, str(inp.get("file_path") or ""))
        if not rel:
            return out
        nums = [int(m.group(1)) for m in _READ_LINE.finditer(output)]
        if nums:
            return [{"file": rel, "how": "read", "lines": ranges(nums)}]
        if output.strip() and not output.lstrip().startswith(("<tool_use_error>", "File does not exist", "Error")):
            # an image, a PDF or a notebook: read whole
            return [{"file": rel, "how": "read", "lines": None}]
        return out
    if tool == "Bash":
        command = str(inp.get("command") or "")
        named, counting = bash_files(cwd, command)
        opened = _opens_since(cwd)
        files = list(dict.fromkeys(named + opened))[:CANDIDATES_MAX]
        for rel in files:
            seen = set() if counting else seen_lines(cwd, rel, output)
            out.append({"file": rel, "how": "read", "lines": ranges(seen)} if seen else {"file": rel, "how": "scan"})
        return out
    if tool == "Label":
        # the mod's label tool: a prompt label's model read each record it judged; a rule went over its files
        by: dict[str, list[int]] = {}
        for ref in inp.get("refs") or []:
            path, _, frag = str(ref).partition("#")
            m = re.match(r"(?:L|row=)(\d+)", frag)
            rel = _rel(cwd, path)
            if rel and m:
                by.setdefault(rel, []).append(int(m.group(1)) + (1 if frag.startswith("row=") else 0))
        out = [{"file": f, "how": "label", "lines": ranges(ns)} for f, ns in by.items()]
        # the examples the tool's answer showed the model are records it read
        shown: dict[str, list[int]] = {}
        for ref in inp.get("seen") or []:
            path, _, frag = str(ref).partition("#")
            m = re.match(r"L(\d+)", frag)
            rel = _rel(cwd, path)
            if rel and m:
                shown.setdefault(rel, []).append(int(m.group(1)))
        out += [{"file": f, "how": "read", "lines": ranges(ns)} for f, ns in shown.items()]
        for rel in dict.fromkeys(f for g in inp.get("files") or [] for f in _expand(cwd, str(g), False)):
            if rel not in by:
                out.append({"file": rel, "how": "scan"})
        return out
    if tool == "Grep":
        mode = str(inp.get("output_mode") or "files_with_matches")
        base = str(inp.get("path") or cwd)
        files: list[str] = []
        for ln in output.splitlines():
            head = ln.split(":", 1)[0].strip()
            r = _rel(cwd, head) if head else None
            if r and r not in files:
                files.append(r)
        if not files:
            pat = str(inp.get("glob") or "")
            for f in _expand(cwd, base, True):
                if not pat or fnmatch.fnmatch(os.path.basename(f), pat) or fnmatch.fnmatch(f, pat):
                    files.append(f)
        for rel in files[:CANDIDATES_MAX]:
            seen = seen_lines(cwd, rel, output) if mode == "content" else set()
            out.append({"file": rel, "how": "read", "lines": ranges(seen)} if seen else {"file": rel, "how": "scan"})
        return out
    return out


def record(cwd: str, events: list[dict]) -> int:
    """Append what each event read to reads.jsonl; returns the lines written."""
    rows = []
    for ev in events:
        t = float(ev.get("t") or time.time())
        agent = str(ev.get("agent") or "main")
        try:
            got = reads_of(cwd, ev)
        except Exception as err:  # noqa: BLE001 — one odd call must not lose the rest
            print(f"coverage: {ev.get('tool')}: {err}", file=sys.stderr)
            continue
        for r in got:
            rows.append({"t": round(t, 3), "session": str(ev.get("session") or ""), "agent": agent, "tool": ev.get("tool"), **r})
    if rows:
        os.makedirs(home(cwd), exist_ok=True)
        with open(os.path.join(home(cwd), "reads.jsonl"), "a", encoding="utf-8") as f:
            for r in rows:
                f.write(json.dumps(r, ensure_ascii=False) + "\n")
    return len(rows)


# ------------------------------------------------------------------------------------------------ the summary


def load_reads(cwd: str, agents: list[str] | None = None, since: float = 0.0, session: str = "") -> list[dict]:
    out = []
    try:
        with open(os.path.join(home(cwd), "reads.jsonl"), encoding="utf-8") as f:
            for raw in f:
                try:
                    r = json.loads(raw)
                except ValueError:
                    continue
                if agents and r.get("agent") not in agents:
                    continue
                if since and float(r.get("t") or 0) < since:
                    continue
                if session and r.get("session") != session:
                    continue
                out.append(r)
    except OSError:
        pass
    return out


def summary(cwd: str, agents: list[str] | None = None, since: float = 0.0, session: str = "") -> dict:
    """What the reads cover: per file its records, the lines seen and whether a call scanned it, and the totals."""
    files = corpus_files(cwd)
    stats = file_stats(cwd, files)
    seen: dict[str, set[int]] = {}
    judged: dict[str, set[int]] = {}
    whole: set[str] = set()
    scanned: set[str] = set()
    who: dict[str, set[str]] = {}
    for r in load_reads(cwd, agents, since, session):
        f = r.get("file")
        if f not in stats:
            continue
        who.setdefault(f, set()).add(str(r.get("agent") or "main"))
        if r.get("how") == "label":
            j = judged.setdefault(f, set())
            for a, b in r.get("lines") or []:
                j.update(range(int(a), int(b) + 1))
            scanned.add(f)
        elif r.get("how") == "read":
            if r.get("lines") is None:
                whole.add(f)
            else:
                s = seen.setdefault(f, set())
                for a, b in r["lines"]:
                    s.update(range(int(a), int(b) + 1))
        else:
            scanned.add(f)
    rows = []
    tot = {"files": 0, "read": 0, "scanned": 0, "untouched": 0, "records": 0, "records_seen": 0, "records_judged": 0, "bytes": 0, "bytes_seen": 0.0}
    kinds: dict[str, dict] = {}
    for f in files:
        st = stats.get(f)
        if not st:
            continue
        recs = st["records"]
        if f in whole:
            n_seen = recs if recs is not None else 0
            frac = 1.0
        else:
            n_seen = len({n for n in seen.get(f, set()) if recs is None or n <= recs})
            frac = (n_seen / recs) if recs else (1.0 if n_seen else 0.0)
        state = "read" if (n_seen or f in whole) else "scanned" if f in scanned else "untouched"
        tot["files"] += 1
        tot[state] += 1
        tot["bytes"] += st["size"]
        tot["bytes_seen"] += st["size"] * min(1.0, frac)
        n_judged = len({n for n in judged.get(f, set()) if recs is None or n <= recs})
        if recs is not None:
            tot["records"] += recs
            tot["records_seen"] += min(n_seen, recs)
            tot["records_judged"] += min(n_judged, recs)
        k = kinds.setdefault(kind_of(f), {"kind": kind_of(f), "files": 0, "read": 0, "scanned": 0, "untouched": 0, "records": 0, "records_seen": 0})
        k["files"] += 1
        k[state] += 1
        k["records"] += recs or 0
        k["records_seen"] += min(n_seen, recs or n_seen)
        rows.append({"file": f, "size": st["size"], "records": recs, "seen": n_seen, "judged": n_judged, "state": state,
                     "ranges": [[1, recs]] if f in whole and recs else ranges(seen.get(f, set()))[:40],
                     "agents": sorted(who.get(f, set()))})
    tot["bytes_seen"] = int(tot["bytes_seen"])
    return {"cwd": cwd, "agents": agents or [], "totals": tot, "kinds": sorted(kinds.values(), key=lambda k: k["kind"]),
            "files": rows, "capped": len(files) >= MAX_FILES}


def pct(a: float, b: float) -> str:
    """A share as the line shows it: one decimal under 10%, whole percents above, "<0.1%" for a sliver."""
    if not b:
        return "0%"
    p = 100.0 * a / b
    if p == 0:
        return "0%"
    if p < 0.1:
        return "<0.1%"
    if p < 10:
        return f"{p:.1f}%"
    return f"{p:.0f}%"


def line(s: dict) -> str:
    """The compact line: files read, the share of records seen, and what scripts only counted or nothing opened."""
    t = s["totals"]
    parts = [f"read {t['read']} of {t['files']} file{'s' if t['files'] != 1 else ''}"]
    if t["records"]:
        parts.append(f"{pct(t['records_seen'], t['records'])} of records")
    if t.get("records_judged"):
        parts.append(f"{pct(t['records_judged'], t['records'])} judged by a label")
    if t["scanned"]:
        parts.append(f"{t['scanned']} only counted by code")
    if t["untouched"]:
        parts.append(f"{t['untouched']} never opened")
    return " · ".join(parts)


def text(s: dict, limit: int = 30) -> str:
    """The summary as main reads it: the line, then each file with what was read of it, unopened files first."""
    t = s["totals"]
    out = [f"coverage of {s['cwd']}: {line(s)}",
           f"records seen: {t['records_seen']:,} of {t['records']:,}; bytes seen: about {pct(t['bytes_seen'], t['bytes'])}"]
    order = {"untouched": 0, "scanned": 1, "read": 2}
    rows = sorted(s["files"], key=lambda r: (order[r["state"]], -r["size"]))
    for r in rows[:limit]:
        recs = f"{r['records']:,} records" if r["records"] is not None else f"{r['size']:,} bytes"
        if r["state"] == "untouched":
            what = "never opened"
        elif r["state"] == "scanned":
            what = "counted by code, no record read"
        else:
            rs = ", ".join(f"{a}" if a == b else f"{a}-{b}" for a, b in r["ranges"][:8])
            what = f"read {r['seen']:,} ({pct(r['seen'], r['records'] or 0)}): lines {rs}{' …' if len(r['ranges']) > 8 else ''}"
        out.append(f"  {r['file']}  ({recs})  {what}")
    if len(rows) > limit:
        out.append(f"  … {len(rows) - limit} more files")
    if s.get("capped"):
        out.append(f"  (only the first {MAX_FILES:,} files are counted)")
    return "\n".join(out)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("op", nargs="?", default="text", choices=["record", "summary", "text"])
    ap.add_argument("--cwd", default=os.environ.get("THIMBLE_CC_MOD_ROOT") or os.getcwd())
    ap.add_argument("--agent", action="append", default=None)
    ap.add_argument("--since", type=float, default=0.0)
    ap.add_argument("--session", default=os.environ.get("THIMBLE_CC_MOD_SESSION", ""))
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()
    if a.op == "record":
        req = json.loads(sys.stdin.read() or "{}")
        n = record(str(req.get("cwd") or a.cwd), list(req.get("events") or []))
        s = summary(str(req.get("cwd") or a.cwd), session=str(req.get("session") or ""))
        unopened = [r["file"] for r in sorted(s["files"], key=lambda r: -r["size"]) if r["state"] == "untouched"][:8]
        print(json.dumps({"written": n, "line": line(s), "totals": s["totals"], "unopened": unopened}))
        return
    s = summary(a.cwd, a.agent, a.since, a.session)
    if a.op == "summary" or a.json:
        print(json.dumps({**s, "line": line(s)}, ensure_ascii=False))
    else:
        print(text(s))


if __name__ == "__main__":
    main()
