"""Coverage: what a session did with every file of the folder, from what Claude's own calls touched.

The hooks module (hooks/watch.ts) keeps each Read, Grep and Bash call of the session in store.seen, and the labels the
session made say which records a rule or a label's model went over. Coverage keeps apart what entered a model's context
and what was only computed over. A file's status is the strongest of:

    seen       some of its lines or rows entered Claude's context: Read, cat, head, tail or sed printing them
               (shellcmd.py), or a search that showed them with their line numbers (Grep)
    model      only a label's model read some of its records (`thimble label --prompt`)
    searched   a search went over it and which lines it showed is not known (grep or rg in the shell)
    computed   a rule label (regex, code) went over its records, and none of them entered a context
    named      it was only named, listed or counted (wc, ls, find, git ls-files, grep -c), or named by a program whose
               output is not known (python, jq); the text says "counted"
    not read   nothing touched it (the text says "untouched")

Only seen counts as read. What a label's model read and what a rule computed over are counted apart.
"""
from __future__ import annotations

import fnmatch
import re
from collections import defaultdict
from pathlib import Path
from typing import Any

from . import shellcmd as SH
from . import sources as S
from .store import Store

# The statuses, strongest first, and how the text says each (the module's docstring says what each means).
ORDER = ["seen", "model", "searched", "computed", "named", "not read"]
SAID = {"seen": "read", "model": "read by a label's model", "searched": "searched", "computed": "computed over",
        "named": "counted", "not read": "not touched"}
# Each file is counted in its own unit: records of a JSONL or JSON file, rows of a table, lines of text, pages of a
# PDF, and an image, a sound or any other file as one whole file (seen or not).
UNITS = ["records", "rows", "lines", "pages", "file"]
ONE = {"records": "record", "rows": "row", "lines": "line", "pages": "page", "file": "file", "sections": "section",
       "hunks": "hunk", "entries": "entry"}
# programs that only list files by name: a file they named and nothing else touched is not touched
LISTS = {"ls", "find", "tree", "du", "stat", "file", "git", "fd"}


# the line ranges and search hits kept per file
RANGES_MAX = 300
HITS_MAX = 400


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
    """A file's two measures in its own unit: the share read into Claude's context, and the share counted or computed
    over (read is part of it): a rule label or a label's model went over it, or Claude read it."""
    units = max(1, o.get("units") or 0)
    read = min(1.0, (o.get("seen_units") or 0) / units)
    if o.get("unit") == "file":
        return read, 1.0 if read or o.get("computed") or o.get("model") else 0.0
    return read, min(1.0, ((o.get("seen_units") or 0) + (o.get("model_units") or 0) + (o.get("computed_units") or 0)) / units)


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


def _add_units(into: dict[str, dict[str, int]], o: dict[str, Any]) -> None:
    """A file's units added to a group's, by unit: all, read, read by a label's model, computed over; and files."""
    u = into.setdefault(o["unit"], {"units": 0, "seen": 0, "model": 0, "computed": 0, "files": 0, "seen_files": 0})
    u["units"] += o["units"]
    u["seen"] += o["seen_units"]
    u["model"] += o["model_units"]
    u["computed"] += o["computed_units"]
    u["files"] += 1
    u["seen_files"] += int(o["seen"])


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


def coverage(st: Store, session: str | None = "") -> dict[str, Any]:
    """What this session (or `session`, or all sessions for None) did with every source file, file by file, by folder
    and by file type. It keeps apart what entered Claude's context (seen), what a label's model read, and what a rule
    label only computed over; only seen counts as read. Each file also says which of its lines were seen (`ranges`) and which lines a search
    showed (`hit_lines`), for the coverage pane. A file nothing touched is only in `untouched`, as columns of its path,
    unit and size, and in the counts of its folder and type: in a folder of a million files nearly every file is one."""
    from . import labels as LB

    files = S.list_files(st.root)
    cnt = S.counts(st.root, files, st.cache / "counts.json")
    unit_of = {f: S.UNIT_OF_KIND.get(cnt.get(f, {}).get("kind") or "", "file") for f in files}
    # the files, indexed once for the commands' paths (shellcmd.Known); what happened to each file is kept only for the
    # files something touched, since in a folder of a million files nearly every file is untouched
    known = SH.Known(files)
    per: dict[str, dict[str, Any]] = {}

    def at(f: str) -> dict[str, Any]:
        x = per.get(f)
        if x is None:
            x = per[f] = {"computed": 0, "lines": [], "searched": False, "matched": 0, "named": False, "hits": set(),
                          "by": set(), "searched_by": set(), "model": 0, "labels": set(), "model_labels": set(),
                          "pages": [], "whole": False}
        return x
    # the labels this session applied (each label keeps the sessions that defined it): a model's reads of a --prompt
    # label's records, a rule's pass over the others
    want = st.session if session == "" else session
    label_names = [n for n in LB.names(st) if want is None or want in ((LB.load(st, n) or {}).get("sessions") or [])]
    for name in sorted(label_names):
        lab = LB.load(st, name)
        if not lab:
            continue
        model: dict[str, int] = defaultdict(int)
        ruled: dict[str, int] = defaultdict(int)
        for ref, u in (lab.get("units") or {}).items():
            f = ref.split("#")[0]
            if f not in known.set:
                continue
            if u.get("by") == "model":
                model[f] += 1
            elif u.get("by") in ("regex", "code"):
                ruled[f] += 1
        for f, n in model.items():
            at(f)["model"] += n
            at(f)["labels"].add(name)
            # (only a model's labels read rows: a code or regex label over the same file computed over it)
            at(f)["model_labels"].add(name)
        for f, n in ruled.items():
            at(f)["computed"] = max(at(f)["computed"], n)
            at(f)["labels"].add(name)
    root = str(st.root)
    for s in st.seen(session):
        tool = s.get("tool")
        if tool == "Read":
            f = st.rel(s.get("file") or "")
            if f in known.set and unit_of[f] == "pages":
                # the pages it read (`pages: "1-5"`), else all of them
                at(f)["pages"].extend(_page_ranges(s.get("pages"), cnt.get(f, {}).get("rows") or 1))
            elif f in known.set and unit_of[f] == "file":
                # an image (or any other file) viewed with Read is seen whole
                at(f)["whole"] = True
            elif f in known.set:
                a, b = s.get("from"), s.get("to")
                if a is None or b is None:
                    a, b = 1, max(1, cnt.get(f, {}).get("lines") or 1)
                at(f)["lines"].append((int(a), int(b)))
        elif tool == "Grep":
            scope = st.rel(s.get("path") or s.get("cwd") or root)
            if scope is None:
                continue
            glob = s.get("glob") or ""
            # a search that showed lines leaves its files searched (the lines it showed are seen); one that showed only
            # names or counts, named
            lines = s.get("mode") == "content" or (s.get("mode") is None and bool(s.get("lines")))
            for f in ([scope] if scope in known.set else known.under(scope.rstrip("/"))):
                if unit_of[f] in ("pages", "file"):
                    continue  # a search skips a binary file
                if not glob or fnmatch.fnmatch(Path(f).name, glob) or fnmatch.fnmatch(f, glob):
                    at(f)["searched" if lines else "named"] = True
                    if not lines:
                        at(f)["by"].add("Grep")
            for fp in s.get("files") or []:
                f = st.rel(fp)
                if f in known.set:
                    at(f)["matched"] += 1
            for fp, ns in (s.get("lines") or {}).items():
                f = st.rel(fp)
                if f in known.set:
                    at(f)["hits"].update(f"L{n}" for n in ns)
                    at(f)["lines"].extend((int(n), int(n)) for n in ns)
        elif tool == "Bash":
            cmd = str(s.get("command") or "")
            if re.match(r"^\s*thimble(\s|$)", cmd):
                continue
            # a ref its output named (a script that printed `_refs`) is a row's name, not its content: its file is
            # touched, none of it read
            for t in s.get("refs") or []:
                path = str(t).partition("#")[0]
                f = path if path in known.set else st.rel(str(Path(s.get("cwd") or root) / path))
                if f in known.set:
                    at(f)["named"] = True
                    at(f)["by"].add(_program(cmd))
            # what reached Claude is at most the lines the command printed (a long output is cut)
            left = s.get("out_lines")
            for f, how, span, prog in SH.shows(cmd, known, root, s.get("cwd"), lambda f: cnt.get(f, {}).get("lines") or 0):
                if f not in known.set:
                    continue
                x = at(f)
                if how == "read" and unit_of[f] in ("pages", "file"):
                    # a file with no lines printed whole (cat of an image or a PDF)
                    x["whole"] = True
                    continue
                if how == "read" and span:
                    a, b = span
                    if left is not None:
                        b = min(b, a + int(left) - 1)
                        left = max(0, int(left) - max(0, b - a + 1))
                    if a <= b:
                        x["lines"].append((a, b))
                        continue
                    how = "named"
                x["searched" if how == "searched" else "named"] = True
                x["searched_by" if how == "searched" else "by"].add(prog)
    out_files = []
    # a file nothing touched, the most of a large folder: its path, unit and size in columns, and its part of its
    # folder's and its type's sizes, added up by (folder, type, unit) as [files, units, rows]
    untouched: dict[str, list[Any]] = {"path": [], "unit": [], "units": []}
    quiet: dict[tuple[str, str, str], list[int]] = defaultdict(lambda: [0, 0, 0])
    for f in files:
        c, x = cnt.get(f, {}), per.get(f)
        rows, lines = c.get("rows", 0), c.get("lines", 0)
        if x is None or not (x["computed"] or x["lines"] or x["searched"] or x["matched"] or x["named"] or x["hits"]
                             or x["model"] or x["labels"] or x["pages"] or x["whole"]):
            unit = unit_of[f]
            units = 1 if unit == "file" else lines if unit == "lines" else rows
            untouched["path"].append(f)
            untouched["unit"].append(unit)
            untouched["units"].append(units)
            q = quiet[(folder_of(f), type_of(f), unit)]
            q[0] += 1
            q[1] += units
            q[2] += rows
            continue
        unit = unit_of[f]
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
        status = ("seen" if seen else "model" if x["model"] else "searched" if x["searched"] else
                  "computed" if x["computed"] else "named" if x["named"] else "not read")
        # touched: some of it seen, or a rule, a model, a search, a count or a program went over it; a file
        # only listed by name (ls, find) is not touched
        listed = status == "named" and bool(x["by"]) and x["by"] <= LISTS
        computed = min(x["computed"], rows) if rows else x["computed"]
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
        # the parts of its rows, apart, as the pane draws them: seen, then read by a label's model, then only computed
        # over (each part what the one before it leaves, at most)
        model_part = max(0.0, min(rows - seen_rows, model - seen_rows)) if rows else 0.0
        computed_part = max(0.0, min(rows - seen_rows - model_part, computed - seen_rows - model_part)) if rows else 0.0
        # the same parts in the file's unit (a Markdown file's rows are its sections, its unit its lines)
        per_unit = units / rows if rows else 0.0
        out_files.append({"path": f, "kind": c.get("kind"), "unit": unit, "units": units, "seen_units": seen_units,
                          "model_units": round(model_part * per_unit), "computed_units": round(computed_part * per_unit),
                          "pages": pages, "rows": rows, "lines": lines, "status": status,
                          "seen": seen, "read": seen, "touched": status != "not read" and not listed, "listed": listed, "share": share,
                          "seen_lines": seen_lines, "read_lines": seen_lines, "seen_rows": round(seen_rows),
                          "model": model, "model_rows": round(model_part), "computed": computed,
                          "computed_rows": round(computed_part), "labels": sorted(x["labels"]),
                          "model_labels": sorted(x["model_labels"]),
                          "searched": x["searched"], "matched": x["matched"],
                          "hits": len(x["hits"]), "named": x["named"], "by": sorted(x["by"]),
                          "searched_by": sorted(x["searched_by"]), "type": type_of(f), "folder": folder_of(f),
                          # which lines entered Claude's context, and which of them a search showed
                          "ranges": _merged(x["lines"]),
                          "hit_lines": sorted({n for n in map(_line_of, x["hits"]) if n})[:HITS_MAX]})
        out_files[-1]["said"] = file_line(out_files[-1])
        out_files[-1]["read_share"], out_files[-1]["counted_share"] = shares(out_files[-1])
    # the files by folder and by type, each group with the two measures: read and counted, in its files' unit (when
    # they share one), else the mean of its files' shares
    folders: dict[str, dict[str, Any]] = {}
    types: dict[str, dict[str, Any]] = {}

    def group(into: dict[str, dict[str, Any]], name: str, key: str) -> dict[str, Any]:
        G = into.get(key)
        if G is None:
            G = into[key] = {name: key, "files": 0, "rows": 0, "seen_rows": 0.0, "model_rows": 0, "computed_rows": 0,
                             "touched": 0, "seen_files": 0, "by_status": defaultdict(int), "computed": 0, "units": {},
                             "read_sum": 0.0, "counted_sum": 0.0}
        return G
    for (folder, typ, unit), (n, units, rows) in quiet.items():
        for G in (group(folders, "folder", folder), group(types, "type", typ)):
            G["files"] += n
            G["rows"] += rows
            G["by_status"]["not read"] += n
            u = G["units"].setdefault(unit, {"units": 0, "seen": 0, "model": 0, "computed": 0, "files": 0, "seen_files": 0})
            u["units"] += units
            u["files"] += n
    for e in out_files:
        for key, name, into in ((e["folder"], "folder", folders), (e["type"], "type", types)):
            G = group(into, name, key)
            G["read_sum"] += e["read_share"]
            G["counted_sum"] += e["counted_share"]
            _add_units(G["units"], e)
            G["files"] += 1
            G["rows"] += e["rows"]
            G["seen_rows"] += e["share"] * e["rows"]
            G["model_rows"] += e["model_rows"]
            G["computed_rows"] += e["computed_rows"]
            G["touched"] += int(e["touched"])
            G["seen_files"] += int(e["seen"])
            G["by_status"][e["status"]] += 1
            G["computed"] += e["computed"]
    for G in [*folders.values(), *types.values()]:
        G["units"] = _units_list(G["units"])
        if len(G["units"]) == 1 and G["units"][0]["units"]:
            u = G["units"][0]
            G["read_share"] = min(1.0, u["seen"] / u["units"])
            G["counted_share"] = min(1.0, (u["seen"] + u["model"] + u["computed"]) / u["units"])
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
    touched_files = sum(1 for o in out_files if o["touched"])
    # the bar's share is of files touched: each file counts once, whatever its unit, and a file a rule label counted over
    # counts as much as one Claude read; 0 means Claude looked at no file at all
    total = {"files": len(files), "rows": rows_all, "touched_files": touched_files,
             "touched_share": touched_files / len(files) if files else 0.0, "seen_files": seen_files,
             "seen_rows": round(seen_rows), "seen_share": seen_files / len(files) if files else 0.0,
             "model_files": sum(1 for o in out_files if o["model"]), "model_rows": model_rows,
             "model_share": model_rows / rows_all if rows_all else 0.0,
             "computed_files": sum(1 for o in out_files if o["computed_rows"]), "computed_rows": computed_rows,
             "computed_share": computed_rows / rows_all if rows_all else 0.0,
             "not_seen_files": len(not_seen) + len(untouched["path"]),
             "not_seen_rows": sum(o["rows"] for o in not_seen) + quiet_rows,
             "untouched_files": sum(1 for o in out_files if not o["touched"]) + len(untouched["path"])}
    every: dict[str, dict[str, int]] = {}
    unread: dict[str, dict[str, int]] = {}
    for o in out_files:
        _add_units(every, o)
        if not o["seen"]:
            _add_units(unread, o)
    for (_, _, unit), (n, units, _) in quiet.items():
        for into in (every, unread):
            u = into.setdefault(unit, {"units": 0, "seen": 0, "model": 0, "computed": 0, "files": 0, "seen_files": 0})
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


def _by(o: dict[str, Any]) -> str:
    by = o.get("by") or []
    return f" ({', '.join(by[:4])})" if by else ""


def _n(x: float) -> str:
    return format(int(round(x)), ",")


def file_line(o: dict[str, Any]) -> str:
    """What happened to one file, in its own unit, as the coverage pane says it: how much of it Claude read (an image
    or another whole file: seen), what a label's model read, what a rule label computed over, or why none of it
    entered a context; `none` when nothing touched it. It never lists which rows were read."""
    s = o["status"]
    rows, unit = o["rows"], o.get("unit") or "lines"
    rw = S.ROW_WORD.get(o.get("kind") or "", unit)
    bits = []
    if s == "seen":
        bits.append("seen" if unit == "file" else "read " + amount(unit, o.get("seen_units", 0), o.get("units", 0)))
    if o.get("model"):
        by_model = o.get("model_labels") or []
        bits.append(f"a label's model read {o['model']:,} of {rows:,} {rw}" + (f" ({', '.join(by_model[:3])})" if by_model else ""))
    if o["computed"]:
        whole = o["computed"] >= rows > 0
        what = [lb for lb in o.get("labels") or [] if lb not in (o.get("model_labels") or [])][:4]
        bits.append(f"computed over {'all ' + format(rows, ',') if whole else format(o['computed'], ',') + ' of ' + format(rows, ',')} {rw}"
                    + (f" ({', '.join(what)})" if what else ""))
    if s == "searched":
        by = o.get("searched_by") or []
        bits.append("searched" + (f" by {', '.join(by[:4])}" if by else "") + "; which lines it showed is not known")
    if s == "named":
        bits.append(f"only listed by name{_by(o)}" if o.get("listed") else f"only named or counted{_by(o)}")
    if s in ("model", "computed", "named"):
        bits[-1] += "; Claude read none of it"
    if not bits:
        bits.append("none")
    return "; ".join(bits)


def _few(paths: list[str], n: int = 4) -> str:
    return ", ".join(paths[:n]) + (f" and {len(paths) - n:,} more" if len(paths) > n else "")


def coverage_text(cov: dict[str, Any], max_lines: int = 40) -> str:
    t = cov["total"]
    head = f"Coverage of {'every session' if cov['session'] is None else 'this session'} · {t['files']:,} file{'s' if t['files'] != 1 else ''}"
    sizes = _sizes(t.get("units") or [])
    lines = [head + (f": {sizes}" if sizes else "")]
    ranked = sorted(cov["files"], key=lambda o: (ORDER.index(o["status"]), o["path"]))
    quiet = cov.get("untouched", {}).get("path") or []
    if len(cov["files"]) + len(quiet) <= max_lines:
        listed = ranked + [{"path": p, "status": "not read", "said": "none"} for p in quiet]
        for o in sorted(listed, key=lambda o: (ORDER.index(o["status"]), o["path"])):
            lines.append(f"  {o['path']}  {o.get('said') or file_line(o)}")
    else:
        shown = [g for g in cov["groups"] if g["files"] > 1 or set(g["by_status"]) != {"not read"}][:12]
        for g in shown:
            parts = [f"{n} {SAID[k]}" for k, n in sorted(g["by_status"].items(), key=lambda kv: ORDER.index(kv[0]))]
            lines.append(f"  {g['group']}  {g['files']:,} file{'s' if g['files'] != 1 else ''}, {_sizes(g.get('units') or [])}: {', '.join(parts)}")
        others = [g for g in cov["groups"] if g not in shown]
        if others:
            lines.append(f"  {sum(g['files'] for g in others):,} other files: "
                         + ", ".join(f"{sum(g['by_status'].get(k, 0) for g in others)} {SAID[k]}" for k in ORDER if any(g['by_status'].get(k) for g in others)))
        some = [o for o in ranked if o["status"] in ("seen", "model", "searched", "computed")]
        if some:
            lines.append("  read, read by a label's model, searched or computed over:")
            for o in some[:15]:
                lines.append(f"    {o['path']}  {o.get('said') or file_line(o)}")
            if len(some) > 15:
                lines.append(f"    … and {len(some) - 15} more")
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
    """What the session did, in words that claim no more than happened: first the files touched (the bar's number: a
    file is touched when some of it entered Claude's context, or a rule label, a search, a count or a program went
    over it), then what was read, each unit apart; what a label's model read and what a rule label computed over
    are said apart. A file only listed by name is not touched."""
    t = cov["total"]
    if not t["files"]:
        return "There are no files."
    units = t.get("units") or []
    share = amounts(units)
    touched, files = t.get("touched_files", 0), t["files"]
    if not touched:
        out = [f"Touched 0 of {files:,} files: Claude has not looked at any of them."]
    else:
        out = [f"Touched {touched:,} of {files:,} files (read, searched, counted or computed over)."]
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
        out.append(f"Computed over by a rule label, none of it read: {computed}.")
    if t["not_seen_files"]:
        by = {k: [o["path"] for o in cov["files"] if (o["status"] == k and o["touched"]) or (k == "not read" and not o["touched"])]
              for k in ("model", "searched", "computed", "named", "not read")}
        by["not read"] = sorted(by["not read"] + list(cov.get("untouched", {}).get("path") or []))
        words = {"model": "read only by a label's model", "searched": "searched, which lines a search showed is not known",
                 "computed": "only computed over", "named": "only named or counted", "not read": "not touched"}
        parts = [f"{len(by[k]):,} {words[k]} ({_few(by[k])})" for k in ("not read", "computed", "model", "named", "searched") if by[k]]
        n = t["not_seen_files"]
        sizes = _sizes(t.get("not_seen_units") or [])
        out.append(f"Not read: {n:,} file{'s' if n != 1 else ''}{f' ({sizes})' if sizes else ''}: " + "; ".join(parts) + ".")
    return " ".join(out)
