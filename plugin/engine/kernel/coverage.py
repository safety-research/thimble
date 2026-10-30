"""Coverage: what a session did with every file of the folder, from what Claude's own calls touched.

The hooks module (hooks/watch.ts) keeps each Read, Grep and Bash call of the session in store.seen, and the labels the
session made say which records a rule or a label's model went over. A file's status is the strongest of:

    seen        read: some of its lines, rows or pages entered Claude's context (a Read; `cat`, `head`, `tail` or `sed`
                printing them; a search that showed them with their line numbers)
    model       a label's model read some of its records (`thimble label --prompt`); none entered Claude's context
    searched    a search (Grep, `grep`, `rg`) went over all of it and showed only the lines that matched, and which lines
                those were is not known
    computed    a program went over its content and only its results came back: Claude's code that names the file
                (in its arguments, a here-document or the script it runs), a count (`wc`, `grep -c`), a rule label, or
                a command whose output went to a file. Code is taken to go over all of a file it names
    listed      only its name came up, or the name of a folder that holds it: a listing (`ls`, `find`), a folder named
                in code, a row's ref a script printed, a program thimble does not know
    untouched   no call named it or its folder

A file is touched when it is seen, model, searched or computed; a listed file is not touched. Only seen counts as
read. Each file has two measures in its own unit: the share read, and the share gone over (read, read by a model,
searched or computed over; read is part of it). shellcmd.py says what a shell command did with each file.

What happened to each file is kept only for the files touched. A file not touched is counted by its folder and type,
and a few of each folder's are named (`untouched`): a folder of a million screenshots costs one pass over its names.
"""
from __future__ import annotations

import fnmatch
import gc
import re
from collections import defaultdict
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

from . import shellcmd as SH
from . import sources as S
from .store import Store

# The statuses, strongest first, and how the text says each (the module's docstring says what each means).
ORDER = ["seen", "model", "searched", "computed", "listed", "untouched"]
SAID = {"seen": "read", "model": "read by a label's model", "searched": "searched", "computed": "computed over",
        "listed": "only listed", "untouched": "untouched"}
# Each file is counted in its own unit: records of a JSONL or JSON file, rows of a table, lines of text, pages of a
# PDF, and an image, a sound or any other file as one whole file (seen or not).
UNITS = ["records", "rows", "lines", "pages", "file"]
ONE = {"records": "record", "rows": "row", "lines": "line", "pages": "page", "file": "file", "sections": "section",
       "hunks": "hunk", "entries": "entry"}
# the line ranges and search hits kept per file
RANGES_MAX = 300
HITS_MAX = 400
# the untouched files named of each folder, at most
UNTOUCHED_PER_FOLDER = 200


def _ranges_len(ranges: list[tuple[int, int]]) -> int:
    n, end = 0, 0
    for a, b in sorted(ranges):
        if b <= end:
            continue
        n += b - max(a, end + 1) + 1
        end = b
    return n


def _merged(ranges: list[tuple[int, int]], cap: int = RANGES_MAX) -> list[list[int]]:
    """Line ranges joined where they touch or overlap, in order, at most `cap` of them."""
    out: list[list[int]] = []
    for a, b in sorted((min(a, b), max(a, b)) for a, b in ranges):
        if out and a <= out[-1][1] + 1:
            out[-1][1] = max(out[-1][1], b)
        else:
            out.append([a, b])
    return out[:cap]


def _line_of(ref: str) -> int | None:
    m = re.search(r"(?:^|#)L(\d+)", ref)
    return int(m.group(1)) if m else None


def type_of(path: str) -> str:
    """A file's type as the coverage pane groups it: its extension (`jsonl`, `py`), else `no extension`."""
    name = path.rsplit("/", 1)[-1]
    dot = name.rfind(".")
    return name[dot + 1:].lower() if 0 < dot < len(name) - 1 else "no extension"


def folder_of(path: str) -> str:
    """A file's folder as the coverage pane groups files: `runs/r004/`, or `./` for the top folder."""
    return path.rsplit("/", 1)[0] + "/" if "/" in path else "./"


def shares(o: dict[str, Any]) -> tuple[float, float]:
    """A file's two measures in its own unit: the share read into Claude's context, and the share gone over (read, read
    by a label's model, searched or computed over; read is part of it)."""
    units = max(1, o.get("units") or 0)
    read = min(1.0, (o.get("seen_units") or 0) / units)
    over = sum(o.get(k) or 0 for k in ("seen_units", "model_units", "searched_units", "computed_units"))
    if o.get("unit") == "file":
        return read, 1.0 if over else 0.0
    return read, min(1.0, over / units)


class _Scripts(dict):
    """The scripts the session's commands wrote (shellcmd.shows keeps them), with a number that changes with each new
    text, so a command run again over the same scripts is read once."""

    version = 0

    def __setitem__(self, key: str, text: str) -> None:
        if self.get(key) != text:
            self.version += 1
        super().__setitem__(key, text)


def _program(cmd: str) -> str:
    """A command's first program past `cd`, as coverage names what touched a file."""
    for pipe in SH.pipelines(cmd):
        for stage in pipe:
            prog, _ = SH.program(stage["words"])
            if prog and prog != "cd":
                return prog
    return "Bash"


def _page_ranges(pages: Any, total: int) -> list[tuple[int, int]]:
    """The pages a Read of a PDF names (`"3"`, `"1-5"`, `"1-3, 8"`), else all of them; each within the PDF."""
    if not pages:
        return [(1, total)]
    out = []
    for part in str(pages).split(","):
        m = re.match(r"\s*(\d+)\s*(?:-\s*(\d+))?\s*$", part)
        if m:
            a = int(m.group(1))
            b = int(m.group(2) or a)
            a, b = max(1, min(a, b)), min(total, max(a, b))
            if a <= b:
                out.append((a, b))
    return out or [(1, total)]


def _unit(into: dict[str, dict[str, int]], unit: str) -> dict[str, int]:
    return into.setdefault(unit, {"units": 0, "seen": 0, "model": 0, "searched": 0, "computed": 0, "files": 0, "seen_files": 0})


def _add_units(into: dict[str, dict[str, int]], o: dict[str, Any], n: int = 1) -> None:
    """A file's units, or those of `n` files alike, added to a group's, by unit: all, read, read by a label's model,
    searched, computed over; and files."""
    u = _unit(into, o["unit"])
    u["units"] += n * o["units"]
    u["seen"] += n * o["seen_units"]
    u["model"] += n * o["model_units"]
    u["searched"] += n * o["searched_units"]
    u["computed"] += n * o["computed_units"]
    u["files"] += n
    u["seen_files"] += n * int(o["seen"])


def _units_list(by: dict[str, dict[str, int]]) -> list[dict[str, Any]]:
    return [{"unit": k, **by[k]} for k in UNITS if k in by]


def amount(unit: str, part: float, total: int, other: bool = False) -> str:
    """Part of a total in a unit, as the coverage pane says it: `3 of 14,591 records (0.02%)`; whole files have no
    share (`1 of 2 files`, or `other files` beside other units)."""
    if unit == "file":
        return f"{_n(part)} of {total:,} {'other ' if other else ''}{'file' if total == 1 else 'files'}"
    return f"{_n(part)} of {total:,} {ONE[unit] if total == 1 else unit} ({percent(part / total if total else 0)})"


def amounts(units: list[dict[str, Any]], key: str = "seen") -> str:
    """Each unit's part, joined: `7 of 42,205 records (0.01%), 2 of 12 pages (16%) and 1 of 2 other files`."""
    mixed = len(units) > 1
    bits = [amount(u["unit"], u[key], u["units"], mixed) for u in units if key == "seen" or u[key]]
    return bits[0] if len(bits) == 1 else ", ".join(bits[:-1]) + " and " + bits[-1] if bits else ""


# what a file's own calls did, for a file no call of its own touched (only a search or code over many files)
_NONE: dict[str, Any] = {"lines": (), "hits": (), "pages": (), "whole": False, "model": 0, "labels": (),
                         "model_labels": (), "computed": 0, "computed_by": ()}


def _file_record(f: str, c: dict[str, Any], unit: str, x: dict[str, Any], searched_by: list[str],
                 computed_by: list[str]) -> dict[str, Any]:
    """One touched file as coverage gives it (see `coverage`): `x` what its own calls did (the lines read, the pages,
    a label's reads, the lines code went over), `searched_by` and `computed_by` the programs that searched it or went
    over all of it."""
    rows, lines = c.get("rows", 0), c.get("lines", 0)
    seen_lines = min(_ranges_len(x["lines"]), lines or _ranges_len(x["lines"]))
    pages = _merged(x["pages"]) if unit == "pages" and not x["whole"] else ([[1, max(1, rows)]] if unit == "pages" else [])
    units = 1 if unit == "file" else lines if unit == "lines" else rows
    if unit == "pages":
        seen_units = min(rows, _ranges_len([tuple(r) for r in pages]))
    elif unit == "file":
        seen_units = int(x["whole"])
    else:
        seen_units = 0
    seen = bool(seen_lines or seen_units)
    computed = x["computed"]
    if computed_by:
        # a program went over all of it: all its rows, one at least
        computed = max(computed, c.get("rows") or 1)
    searched = bool(searched_by)
    status = ("seen" if seen else "model" if x["model"] else "searched" if searched else "computed")
    computed_rows = min(computed, rows) if rows else computed
    model = min(x["model"], rows) if rows else x["model"]
    if unit in ("pages", "file"):
        share = seen_units / max(1, units)
    else:
        share = min(1.0, seen_lines / max(1, lines or rows)) if seen and rows else 0.0
        if unit == "lines":
            seen_units = seen_lines
        elif c.get("kind") == "csv" and lines == rows + 1:
            # a table's rows are its lines after the header
            body = [(max(2, a), b) for a, b in x["lines"] if b >= 2]
            seen_units = min(rows, _ranges_len(body))
        else:
            seen_units = max(1, round(share * units)) if seen and units else 0
    seen_rows = share * rows
    # the parts of its rows, apart, as the pane draws them: seen, then read by a label's model, then searched (all
    # of it), then only computed over (each part what the ones before it leave, at most)
    model_part = max(0.0, min(rows - seen_rows, model - seen_rows)) if rows else 0.0
    searched_part = max(0.0, rows - seen_rows - model_part) if rows and searched else 0.0
    computed_part = max(0.0, min(rows - seen_rows - model_part - searched_part, computed_rows - seen_rows - model_part)) if rows else 0.0
    # the same parts in the file's unit (a Markdown file's rows are its sections, its unit its lines)
    per_unit = units / rows if rows else 0.0
    o = {"path": f, "kind": c.get("kind"), "unit": unit, "units": units, "seen_units": seen_units,
         "model_units": round(model_part * per_unit), "searched_units": round(searched_part * per_unit),
         "computed_units": round(computed_part * per_unit), "pages": pages, "rows": rows, "lines": lines,
         # what a label's model read and what code computed over, each whole (not the part the ones before it
         # leave), in the file's unit, as the coverage pane's detail says them
         "model_read_units": min(units, round(model * per_unit)) if unit != "file" else int(bool(model)),
         "computed_over_units": min(units, round(computed_rows * per_unit)) if unit != "file" else int(bool(computed_rows)),
         "status": status, "seen": seen, "read": seen, "touched": True, "share": share,
         "seen_lines": seen_lines, "read_lines": seen_lines, "seen_rows": round(seen_rows),
         "model": model, "model_rows": round(model_part), "computed": computed_rows,
         "computed_rows": round(computed_part), "labels": sorted(x["labels"]), "model_labels": sorted(x["model_labels"]),
         "searched": searched, "hits": len(x["hits"]), "searched_by": searched_by,
         "computed_by": sorted({*x["computed_by"], *computed_by}), "type": type_of(f), "folder": folder_of(f),
         # which lines entered Claude's context, and which of them a search showed
         "ranges": _merged(x["lines"]), "hit_lines": sorted({n for n in map(_line_of, x["hits"]) if n})[:HITS_MAX]}
    o["said"] = file_line(o)
    o["read_share"], o["counted_share"] = shares(o)
    return o


@contextmanager
def _collector_waits() -> Iterator[None]:
    """Python's cycle collector goes over every object the process holds, again each time many more are made: a count
    that makes millions (a record for each of 150,000 files) spent 1.4 of its 3.5 seconds there. A count makes no
    cycles, so the collector waits until it ends."""
    was = gc.isenabled()
    gc.disable()
    try:
        yield
    finally:
        if was:
            gc.enable()


def coverage(st: Store, session: str | None = "", per_folder: int = UNTOUCHED_PER_FOLDER,
             until: float | None = None) -> dict[str, Any]:
    """What this session (or `session`, or all sessions for None) did with every file of the folder. `files` holds
    each touched file with its status, its two measures, the lines seen (`ranges`) and the lines a search showed
    (`hit_lines`); `groups` and `types` count every file by folder and by file type; `untouched` names at most
    `per_folder` of each folder's files not touched, as columns of path, unit, size and the programs that listed it.
    `until` (time.monotonic()): when to stop counting the files' rows (sources.counts), which then raises
    sources.Unfinished and keeps what it counted for the next count.

    The folder is listed once, and each call is read once, for what it did: a search of a folder or code that globs
    thousands of files adds one set of files to its program's, and a call done again adds nothing. A glob no call used
    before is tried only on the files that can match it (Known.candidates). Each file is then gone over once."""
    with _collector_waits():
        return _coverage(st, session, per_folder, until)


def _coverage(st: Store, session: str | None, per_folder: int, until: float | None) -> dict[str, Any]:
    from . import labels as LB

    files = S.list_files(st.root)
    known = SH.Known(files)
    # rows are counted only for the sources and PDFs: one test per extension, and a name with none tested alone
    cnt = S.counts(st.root, [f for ext, fs in known.by_ext.items() if not ext or S.counted("x" + ext) for f in fs],
                   st.cache / "counts.json", until)

    def count(f: str) -> dict[str, Any]:
        return cnt.get(f) or S.whole_file(f)

    def unit_of(f: str) -> str:
        c = cnt.get(f)
        return S.UNIT_OF_KIND.get(c["kind"] or "", "file") if c else "file"

    text_files: set[str] | None = None

    def texts() -> set[str]:
        """The files a search goes over: the text files, since a search skips a binary file, an image or a PDF."""
        nonlocal text_files
        if text_files is None:
            text_files = {f for f, c in cnt.items() if S.UNIT_OF_KIND.get(c["kind"] or "", "file") not in ("pages", "file")}
        return text_files

    searchable_in: dict[str, set[str]] = {}

    def searchable(folder: str) -> set[str]:
        """The files a search into a folder (`runs/`, `./`) goes over: its text files. The folder's files are one range
        of the sorted names (Known.under), found once."""
        fs = searchable_in.get(folder)
        if fs is None:
            under = known.under("." if folder == "./" else folder.rstrip("/"))
            fs = searchable_in[folder] = texts() if len(under) == len(files) else texts().intersection(under)
        return fs

    def grepped(scope: str, glob: str) -> set[str]:
        """The files a Grep of `scope` (a file or a folder) with `glob` goes over. The glob matches a file's name or its
        path (fnmatch), and it is tried only on the files that can match it (Known.candidates): a glob no call used
        before costs a test of the files that hold its rarest literal part, or of the folder's own files when they are
        fewer. A name or a path the glob matches ends as the glob ends (`*.json`: `.json`), so only those are tried."""
        if not glob:
            if scope in known.set:
                return {scope} if unit_of(scope) not in ("pages", "file") else set()
            return searchable("./" if scope == "." else scope.rstrip("/") + "/")
        match, end = re.compile(fnmatch.translate(glob)).match, re.split(r"[*?\]]", glob)[-1]
        fs = [scope] if scope in known.set else known.candidates(glob, scope.rstrip("/"))
        text = texts()
        return {f for f in fs if f.endswith(end) and f in text and (match(f[f.rfind("/") + 1:]) or match(f))}

    per: dict[str, dict[str, Any]] = {}  # what each file's own calls did

    def at(f: str) -> dict[str, Any]:
        x = per.get(f)
        if x is None:
            x = per[f] = {"lines": [], "hits": set(), "pages": [], "whole": False, "model": 0, "labels": set(),
                          "model_labels": set(), "computed": 0, "computed_by": set(), "named": set()}
        return x

    def computed(f: str, span: tuple[int, int] | None, by: str) -> None:
        """A program went over the file: its lines `span`, else all of it."""
        c = count(f)
        rows, lines = c.get("rows") or 1, c.get("lines") or 0
        part = rows
        if span and lines:
            # at least one row: the program went over some of its lines
            part = max(1, round(rows * max(0, min(span[1], lines) - span[0] + 1) / lines))
        x = at(f)
        x["computed"] = max(x["computed"], part)
        x["computed_by"].add(by)

    # the files each program searched, went over whole, or only listed by name: sets that grow by unions, so a search
    # of a folder of 150,000 files costs one union, and the same search again costs nothing
    searched_by: dict[str, set[str]] = {}
    computed_by: dict[str, set[str]] = {}
    listed_by: dict[str, set[str]] = {}
    # what was only named: a file, or a folder (`runs/`, `./`) for all its files, and the programs that named it
    listed: dict[str, set[str]] = defaultdict(set)
    # the labels this session applied (each label keeps the sessions that defined it): a model's reads of a --prompt
    # label's records, a rule's pass over the others (labels.summaries: per file, never the label's records); for every
    # session, the labels of every conversation in the folder
    want = st.session if session == "" else session
    for lab in LB.summaries(st, every=want is None):
        if want is not None and want not in lab["sessions"]:
            continue
        for f, (model, ruled) in lab["files"].items():
            if f not in known.set or not (model or ruled):
                continue
            x = at(f)
            x["labels"].add(lab["name"])
            if model:
                x["model"] += model
                # (only a model's labels read rows: a code or regex label over the same file computed over it)
                x["model_labels"].add(lab["name"])
            if ruled:
                x["computed"] = max(x["computed"], ruled)
    root = str(st.root)
    scripts = _Scripts()  # the scripts the session's commands wrote, for the commands after them (shellcmd)
    # what a search or a command did to a file or a folder, once: done again, it changes nothing
    done: set[tuple[Any, ...]] = set()
    # each command as shellcmd read it, by its words, its folder and the scripts written before it: run again, only
    # the lines it printed count again (what reached Claude is cut to each run's own output)
    printed: dict[tuple[str, str | None, int], list[tuple[Any, str, tuple[int, int] | None, str]]] = {}
    for s in st.seen(session):
        tool = s.get("tool")
        if tool == "Read":
            f = st.rel(s.get("file") or "")
            if f in known.set and unit_of(f) == "pages":
                # the pages it read (`pages: "1-5"`), else all of them
                at(f)["pages"].extend(_page_ranges(s.get("pages"), count(f).get("rows") or 1))
            elif f in known.set and unit_of(f) == "file":
                # an image (or any other file) viewed with Read is seen whole
                at(f)["whole"] = True
            elif f in known.set:
                a, b = s.get("from"), s.get("to")
                # a Read that showed no numbered line (an offset past the end, an empty file) showed nothing of it
                if a is not None and b is not None:
                    at(f)["lines"].append((int(a), int(b)))
                at(f)["named"].add("Read")
        elif tool == "Grep":
            scope = st.rel(s.get("path") or s.get("cwd") or root)
            if scope is None:
                continue
            glob = s.get("glob") or ""
            # a search that showed lines leaves its files searched (the lines it showed are seen); one that showed only
            # names or counts computed over them
            lines = s.get("mode") == "content" or (s.get("mode") is None and bool(s.get("lines")))
            if ("Grep", scope, glob, lines) not in done:
                done.add(("Grep", scope, glob, lines))
                fs = grepped(scope, glob)
                if fs:
                    (searched_by if lines else computed_by).setdefault("Grep", set()).update(fs)
            for fp, ns in (s.get("lines") or {}).items():
                f = st.rel(fp)
                if f in known.set:
                    at(f)["hits"].update(f"L{n}" for n in ns)
                    at(f)["lines"].extend((int(n), int(n)) for n in ns)
                    at(f)["named"].add("Grep")
        elif tool == "Bash":
            cmd = str(s.get("command") or "")
            if re.match(r"^\s*thimble(\s|$)", cmd):
                continue
            # a ref its output named (a script that printed `_refs`) is a row's name, not its content
            for t in s.get("refs") or []:
                path = str(t).partition("#")[0]
                f = path if path in known.set else st.rel(str(Path(s.get("cwd") or root) / path))
                if f in known.set:
                    listed[f].add(_program(cmd))
            # what reached Claude is at most the lines the command printed (a long output is cut)
            left = s.get("out_lines")
            key = (cmd, s.get("cwd"), scripts.version)
            if (key, left) in done:
                continue  # the same command again, with as long an output: it showed nothing new
            done.add((key, left))
            shown = printed.get(key)
            if shown is None:
                shown = SH.shows_sets(cmd, known, root, s.get("cwd"), lambda f: count(f).get("lines") or 0, scripts)
                printed[key] = [x for x in shown if x[1] == "read"]
            for f, how, span, prog in shown:
                if not isinstance(f, str):
                    # the files one program searched, went over whole or only listed: those named one by one, and the
                    # set of each glob once (a glob's set is the one Known.glob keeps, so the key holds no copy of it)
                    into = (searched_by if how == "searched" else computed_by if how == "computed" else listed_by
                            ).setdefault(prog, set())
                    into.update(f.files)
                    for fs in f.globs:
                        if (fs, how, prog) not in done:
                            done.add((fs, how, prog))
                            into.update(fs)
                    continue
                if how != "read":
                    if (f, how, span, prog) in done:
                        continue
                    done.add((f, how, span, prog))
                if f.endswith("/"):  # a folder, for its files
                    if how == "searched":
                        searched_by.setdefault(prog, set()).update(searchable(f))
                    else:
                        listed[f].add(prog)
                    continue
                if f not in known.set:
                    continue
                if how == "computed":
                    computed(f, span, prog)
                elif how == "searched":
                    searched_by.setdefault(prog, set()).add(f)
                elif how == "read" and unit_of(f) in ("pages", "file"):
                    at(f)["whole"] = True  # a file with no lines printed whole (cat of an image or a PDF)
                elif how == "read" and span:
                    a, b = span
                    if left is not None:
                        b = min(b, a + int(left) - 1)
                        left = max(0, int(left) - max(0, b - a + 1))
                    if a <= b:
                        at(f)["lines"].append((a, b))
                    else:
                        listed[f].add(prog)  # the output was cut before its lines
                else:
                    listed[f].add(prog)

    # the files touched: those searched or gone over whole, and those whose own calls showed some of them; a file a call
    # named but showed nothing of (a Read past its end, a search that showed none of its lines) is only named
    touched: set[str] = set()
    for fs in (*searched_by.values(), *computed_by.values()):
        touched |= fs
    for f, x in per.items():
        if _ranges_len(x["lines"]) or x["pages"] or x["whole"] or x["model"] or x["computed"]:
            touched.add(f)
        elif f not in touched:
            listed[f] |= x["named"]

    # the files not touched, the most of a large folder: one pass over their names, by extension, counted by (folder,
    # type, unit) as [files, units, rows, listed], and the first few of each folder named
    folder_listed: dict[str, list[str]] = {}  # the programs that listed each folder, itself or a folder above it
    listed_progs = sorted(listed_by)

    def listed_folder(folder: str) -> list[str]:
        """The programs that listed `folder` or a folder above it, each folder looked up once (`./` holds all)."""
        by = folder_listed.get(folder)
        if by is None:
            got = set(listed.get("./", ()))
            at_ = folder.find("/")
            while at_ >= 0 and folder != "./":
                got |= listed.get(folder[:at_ + 1], set())
                at_ = folder.find("/", at_ + 1)
            by = folder_listed[folder] = sorted(got)
        return by

    quiet: dict[tuple[str, str, str], list[int]] = defaultdict(lambda: [0, 0, 0, 0])
    sample: dict[str, list[tuple[str, str, int, str]]] = defaultdict(list)
    for ext, fs in known.by_ext.items():
        typ = ext[1:] or "no extension"
        for f in fs:
            if f in touched:
                continue
            slash = f.rfind("/")
            folder = f[:slash + 1] or "./"
            c = cnt.get(f)
            unit = S.UNIT_OF_KIND.get(c["kind"] or "", "file") if c else "file"
            rows = c["rows"] if c else 1
            units = 1 if unit == "file" else c["lines"] if unit == "lines" else rows
            by = listed_folder(folder)
            own = listed.get(f)
            for p in listed_progs:
                if f in listed_by[p]:
                    own = {p} | own if own else {p}
            if own:
                by = sorted(own | set(by))
            q = quiet[(folder, typ, unit)]
            q[0] += 1
            q[1] += units
            q[2] += rows
            q[3] += bool(by)
            if len(sample[folder]) < per_folder:
                sample[folder].append((f, unit, units, ", ".join(by[:4])))
    named_files = sorted(x for xs in sample.values() for x in xs)
    untouched = {"path": [x[0] for x in named_files], "unit": [x[1] for x in named_files],
                 "units": [x[2] for x in named_files], "by": [x[3] for x in named_files]}

    # the files by folder and by type, each group with the two measures: read and gone over, in its files' unit (when
    # they share one), else the mean of its files' shares; the files not touched first, by their counts
    folders: dict[str, dict[str, Any]] = {}
    types: dict[str, dict[str, Any]] = {}

    def group(into: dict[str, dict[str, Any]], name: str, key: str) -> dict[str, Any]:
        G = into.get(key)
        if G is None:
            G = into[key] = {name: key, "files": 0, "rows": 0, "seen_rows": 0.0, "model_rows": 0, "computed_rows": 0,
                             "touched": 0, "seen_files": 0, "by_status": defaultdict(int), "computed": 0, "units": {},
                             "read_sum": 0.0, "counted_sum": 0.0}
        return G
    for (folder, typ, unit), (n, units, rows, n_listed) in quiet.items():
        for G in (group(folders, "folder", folder), group(types, "type", typ)):
            G["files"] += n
            G["rows"] += rows
            if n_listed:
                G["by_status"]["listed"] += n_listed
            if n > n_listed:
                G["by_status"]["untouched"] += n - n_listed
            u = _unit(G["units"], unit)
            u["units"] += units
            u["files"] += n
    # then each touched file, in the order of their paths. A file that only a search or code over many files touched
    # has one of a few shapes (its kind, its size and the programs): its record is worked out once and copied, and its
    # counts are added to its folder and its type once per shape, after (each share and float sum still in the order
    # of the paths, so every sum is as one file after another gives it)
    out_files: list[dict[str, Any]] = []
    every: dict[str, dict[str, int]] = {}
    unread: dict[str, dict[str, int]] = {}

    def add(G: dict[str, Any], e: dict[str, Any], n: int = 1) -> None:
        """A file's counts (`n` files of one shape) added to its folder's or its type's."""
        _add_units(G["units"], e, n)
        G["files"] += n
        G["rows"] += n * e["rows"]
        G["model_rows"] += n * e["model_rows"]
        G["computed_rows"] += n * e["computed_rows"]
        G["touched"] += n
        G["seen_files"] += n * int(e["seen"])
        G["by_status"][e["status"]] += n
        G["computed"] += n * e["computed"]

    s_progs = [(p, searched_by[p]) for p in sorted(searched_by)]
    c_progs = [(p, computed_by[p]) for p in sorted(computed_by)]
    shapes: dict[tuple[Any, ...], dict[str, Any]] = {}
    shaped: dict[tuple[str, str, tuple[Any, ...]], int] = defaultdict(int)  # (folder, type, shape): files
    for f in sorted(touched):
        c = cnt.get(f)
        if c is None:
            c, unit = S.whole_file(f), "file"
        else:
            unit = S.UNIT_OF_KIND.get(c["kind"] or "", "file")
        sb = [p for p, fs in s_progs if f in fs]
        cb = [p for p, fs in c_progs if f in fs]
        x = per.get(f)
        if x is not None:
            e = _file_record(f, c, unit, x, sb, cb)
            out_files.append(e)
            for G in (group(folders, "folder", e["folder"]), group(types, "type", e["type"])):
                G["read_sum"] += e["read_share"]
                G["counted_sum"] += e["counted_share"]
                G["seen_rows"] += e["share"] * e["rows"]
                add(G, e)
            _add_units(every, e)
            if not e["seen"]:
                _add_units(unread, e)
            continue
        shape = (c.get("kind"), c.get("rows", 0), c.get("lines", 0), unit, tuple(sb), tuple(cb))
        t = shapes.get(shape)
        if t is None:
            t = shapes[shape] = _file_record(f, c, unit, _NONE, sb, cb)
        e = t.copy()
        slash = f.rfind("/")  # (type_of and folder_of, written out: they run for each of 150,000 files)
        name = f[slash + 1:]
        dot = name.rfind(".")
        e["path"] = f
        e["pages"], e["labels"], e["model_labels"], e["searched_by"], e["computed_by"] = [], [], [], sb, cb
        e["type"] = typ = name[dot + 1:].lower() if 0 < dot < len(name) - 1 else "no extension"
        e["folder"] = folder = f[:slash + 1] if slash >= 0 else "./"
        e["ranges"], e["hit_lines"] = [], []
        out_files.append(e)
        for G in (group(folders, "folder", folder), group(types, "type", typ)):
            G["read_sum"] += t["read_share"]
            G["counted_sum"] += t["counted_share"]
            G["seen_rows"] += t["share"] * t["rows"]
            G["by_status"].setdefault(t["status"], 0)  # (each status in the order the files first give it)
        shaped[(folder, typ, shape)] += 1
    for (folder, typ, shape), n in shaped.items():
        t = shapes[shape]
        add(folders[folder], t, n)
        add(types[typ], t, n)
        _add_units(every, t, n)
        if not t["seen"]:
            _add_units(unread, t, n)
    for G in [*folders.values(), *types.values()]:
        G["units"] = _units_list(G["units"])
        if len(G["units"]) == 1 and G["units"][0]["units"]:
            u = G["units"][0]
            G["read_share"] = min(1.0, u["seen"] / u["units"])
            G["counted_share"] = min(1.0, (u["seen"] + u["model"] + u["searched"] + u["computed"]) / u["units"])
        else:
            G["read_share"], G["counted_share"] = G["read_sum"] / G["files"], G["counted_sum"] / G["files"]
        del G["read_sum"], G["counted_sum"]
        G["group"] = G.get("folder", G.get("type"))
        G["by_status"] = dict(G["by_status"])
        G["seen_rows"] = round(G["seen_rows"])
        G["read_rows"] = G["seen_rows"]
    quiet_rows = sum(q[2] for q in quiet.values())
    rows_all = sum(o["rows"] for o in out_files) + quiet_rows
    seen_rows = sum(o["share"] * o["rows"] for o in out_files)
    model_rows = sum(o["model_rows"] for o in out_files)
    computed_rows = sum(o["computed_rows"] for o in out_files)
    not_seen = [o for o in out_files if not o["seen"]]
    seen_files = len(out_files) - len(not_seen)
    touched_files = len(out_files)
    listed_files = sum(q[3] for q in quiet.values())
    # the bar's share is of files touched: each file counts once, whatever its unit, and a file a rule label computed
    # over counts as much as one Claude read; 0 means Claude looked at no file at all
    total = {"files": len(files), "rows": rows_all, "touched_files": touched_files,
             "touched_share": touched_files / len(files) if files else 0.0, "seen_files": seen_files,
             "seen_rows": round(seen_rows), "seen_share": seen_files / len(files) if files else 0.0,
             "model_files": sum(1 for o in out_files if o["model"]), "model_rows": model_rows,
             "model_share": model_rows / rows_all if rows_all else 0.0,
             "computed_files": sum(1 for o in out_files if o["computed_rows"]), "computed_rows": computed_rows,
             "computed_share": computed_rows / rows_all if rows_all else 0.0,
             "not_seen_files": len(files) - seen_files,
             "not_seen_rows": sum(o["rows"] for o in not_seen) + quiet_rows,
             "listed_files": listed_files,
             "untouched_files": len(files) - touched_files - listed_files}
    for (_, _, unit), (n, units, _, _) in quiet.items():
        for into in (every, unread):
            u = _unit(into, unit)
            u["units"] += units
            u["files"] += n
    total["units"] = _units_list(every)
    total["not_seen_units"] = _units_list(unread)
    # the names earlier readers know: read is seen
    total.update(read_files=total["seen_files"], read_rows=total["seen_rows"], read_share=total["seen_share"],
                 not_read_files=total["not_seen_files"], not_read_rows=total["not_seen_rows"])
    return {"root": str(st.root), "session": st.session if session == "" else session, "files": out_files,
            "untouched": untouched,
            "groups": sorted(folders.values(), key=lambda g: (-g["touched"], -g["files"], g["folder"])),
            "types": sorted(types.values(), key=lambda g: (-g["rows"], g["type"])),
            "total": total}


def _n(x: float) -> str:
    return format(int(round(x)), ",")


def file_line(o: dict[str, Any]) -> str:
    """What happened to one touched file, in its own unit, as the coverage pane says it: how much of it Claude read (an
    image or another whole file: seen), what a label's model read, what a search or a program went over, and that
    Claude read none of it when so. It never lists which rows were read."""
    s = o["status"]
    rows, unit = o["rows"], o.get("unit") or "lines"
    rw = S.ROW_WORD.get(o.get("kind") or "", unit)
    bits = []
    if s == "seen":
        bits.append("seen" if unit == "file" else "read " + amount(unit, o.get("seen_units", 0), o.get("units", 0)))
    if o.get("model"):
        by_model = o.get("model_labels") or []
        bits.append(f"a label's model read {o['model']:,} of {rows:,} {rw}" + (f" ({', '.join(by_model[:3])})" if by_model else ""))
    if o.get("searched"):
        by = o.get("searched_by") or []
        bits.append("searched" + (f" by {', '.join(by[:4])}" if by else "") + "; which lines it showed is not known")
    if o["computed"]:
        whole = o["computed"] >= rows > 0
        what = ([lb for lb in o.get("labels") or [] if lb not in (o.get("model_labels") or [])] + list(o.get("computed_by") or []))[:4]
        part = "all of it" if whole and rows == 1 else f"all {rows:,} {rw}" if whole else f"{o['computed']:,} of {rows:,} {rw}"
        bits.append(f"computed over {part}" + (f" ({', '.join(what)})" if what else ""))
    if s != "seen" and bits:
        bits[-1] += "; Claude read none of it"
    return "; ".join(bits)


def quiet_line(by: str) -> str:
    """What happened to a file not touched: listed by the programs `by`, or nothing."""
    return f"only listed by name ({by}); Claude read none of it" if by else "untouched"


def _few(paths: list[str], n: int = 4, total: int | None = None) -> str:
    """At most n of the paths, and how many more of `total` there are; "" when no path is known to name."""
    total = len(paths) if total is None else total
    if not paths:
        return ""
    return ", ".join(paths[:n]) + (f" and {total - min(n, len(paths)):,} more" if total > min(n, len(paths)) else "")


def coverage_text(cov: dict[str, Any], max_lines: int = 40) -> str:
    t = cov["total"]
    head = f"Coverage of {'every session' if cov['session'] is None else 'this session'} · {t['files']:,} file{'s' if t['files'] != 1 else ''}"
    sizes = _sizes(t.get("units") or [])
    lines = [head + (f": {sizes}" if sizes else "")]
    ranked = sorted(cov["files"], key=lambda o: (ORDER.index(o["status"]), o["path"]))
    q = cov.get("untouched") or {}
    quiet = [{"path": p, "status": "listed" if by else "untouched", "said": quiet_line(by)}
             for p, by in zip(q.get("path") or [], q.get("by") or [])]
    if t["files"] <= max_lines:
        for o in sorted(ranked + quiet, key=lambda o: (ORDER.index(o["status"]), o["path"])):
            lines.append(f"  {o['path']}  {o['said']}")
    else:
        shown = [g for g in cov["groups"] if g["files"] > 1 or set(g["by_status"]) != {"untouched"}][:12]
        for g in shown:
            parts = [f"{n:,} {SAID[k]}" for k, n in sorted(g["by_status"].items(), key=lambda kv: ORDER.index(kv[0]))]
            units = g.get("units") or []
            sizes = "" if [u["unit"] for u in units] == ["file"] else f", {_sizes(units)}"  # whole files: no size but their number
            lines.append(f"  {g['group']}  {g['files']:,} file{'s' if g['files'] != 1 else ''}{sizes}: {', '.join(parts)}")
        others = [g for g in cov["groups"] if g not in shown]
        if others:
            lines.append(f"  {sum(g['files'] for g in others):,} other files: "
                         + ", ".join(f"{sum(g['by_status'].get(k, 0) for g in others):,} {SAID[k]}" for k in ORDER if any(g['by_status'].get(k) for g in others)))
        if ranked:
            lines.append("  read, read by a label's model, searched or computed over:")
            for o in ranked[:15]:
                lines.append(f"    {o['path']}  {o['said']}")
            if len(ranked) > 15:
                lines.append(f"    … and {len(ranked) - 15} more")
    lines.append(coverage_sentence(cov))
    return "\n".join(lines)


def _sizes(units: list[dict[str, Any]]) -> str:
    """A set of files' sizes, each in its unit: `42,205 records, 12 pages and 2 other files`."""
    mixed = len(units) > 1
    bits = [f"{u['units']:,} {'other ' if mixed else ''}{'file' if u['units'] == 1 else 'files'}" if u["unit"] == "file"
            else f"{u['units']:,} {ONE[u['unit']] if u['units'] == 1 else u['unit']}" for u in units]
    return bits[0] if len(bits) == 1 else ", ".join(bits[:-1]) + " and " + bits[-1] if bits else ""


def percent(part: float) -> str:
    """A share as the thimble line says it (shell.tsx percent): 34%, a decimal under 1%, and 100% only when all."""
    if not part > 0:
        return "0%"
    if part >= 1:
        return "100%"
    p = 100 * part
    if p < 0.01:
        return "<0.01%"
    if p < 1:
        d = 2 if p < 0.1 else 1
        return f"{int(p * 10 ** d) / 10 ** d:.{d}f}%"
    return f"{min(99, int(p + 0.5))}%"


def coverage_sentence(cov: dict[str, Any]) -> str:
    """What the session did, in words that claim no more than happened: first the files touched (the bar's number:
    read, searched or computed over), then what was read, each unit apart; what a label's model read and what a rule
    label or Claude's code computed over are said apart; then the files not read, by what happened to them."""
    t = cov["total"]
    if not t["files"]:
        return "There are no files."
    units = t.get("units") or []
    share = amounts(units)
    touched, files = t.get("touched_files", 0), t["files"]
    if not touched:
        out = [f"Touched 0 of {files:,} files: Claude has not looked at any of them."]
    else:
        out = [f"Touched {touched:,} of {files:,} files (read, searched or computed over)."]
    if not t["not_seen_files"]:
        out.append(f"Read all {files:,} files, at least in part: {share} entered Claude's context.")
    elif t["seen_files"]:
        out.append(f"Read {t['seen_files']:,} of the files, at least in part: {share} entered Claude's context.")
    elif touched:
        out.append("Read: no part of any file entered Claude's context.")
    model, computed = amounts(units, "model"), amounts(units, "computed")
    if model:
        out.append(f"Read by a label's model: {model}.")
    if computed:
        out.append(f"Computed over by a program or a rule label, none of it read: {computed}.")
    if t["not_seen_files"]:
        by = {k: [o["path"] for o in cov["files"] if o["status"] == k] for k in ("model", "searched", "computed")}
        q = cov.get("untouched") or {}
        by["listed"] = [p for p, b in zip(q.get("path") or [], q.get("by") or []) if b]
        by["untouched"] = [p for p, b in zip(q.get("path") or [], q.get("by") or []) if not b]
        n_of = {"listed": t["listed_files"], "untouched": t["untouched_files"]}
        words = {"model": "read only by a label's model", "searched": "searched, which lines a search showed is not known",
                 "computed": "only computed over", "listed": "only listed by name", "untouched": "untouched"}
        parts = [f"{n_of.get(k, len(by[k])):,} {words[k]}" + (f" ({_few(by[k], total=n_of.get(k))})" if by[k] else "")
                 for k in ("untouched", "listed", "computed", "model", "searched") if n_of.get(k, len(by[k]))]
        n = t["not_seen_files"]
        sizes = _sizes(t.get("not_seen_units") or [])
        out.append(f"Not read: {n:,} file{'s' if n != 1 else ''}{f' ({sizes})' if sizes else ''}: " + "; ".join(parts) + ".")
    return " ".join(out)
