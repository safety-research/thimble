# Activity Timeline: every URLQuery report of the collection on one UTC time axis, a lane per data source.
#
# The data, three CSV files with a header row and one record per line (no quoted cell spans lines):
#   all-reports.csv               one row per report, the deduplicated union of the main and the supplemental catalog:
#                                 report_id, report_url, report_date_utc (ISO 8601 in UTC, to the second),
#                                 timestamp_precision, disposition (included, review_required or background),
#                                 confidence (significant, suggestive, blank outside the included reports),
#                                 broad_class, why_included and caveat
#   additional-cited-reports.csv  the supplemental catalog, the same nine columns, its rows also in all-reports.csv
#   report-sources.csv            one row per included report: report_id, report_date_utc, data_source, source_basis
#                                 and matched_sources
#
# The records: one per report_id, gathered from every file that names it. Its ref is its line in all-reports.csv, else
# its line in additional-cited-reports.csv, else in report-sources.csv, so the view keeps working with a file missing.
# Its fields: t (seconds since 1970), source (its data_source, or Review required / Background control / No source row
# for a report the source table does not list), confidence, disposition, broad_class, source_basis, matched_sources and
# catalog (supplement when additional-cited-reports.csv lists it, else main).
#
# The method: build_index reads each file whole once, keeps each record as small integers (time, file, line, each
# field's value as an index into that field's names) in time order, and the byte offset of every line, so a record's
# lines are read back from the files when the page opens it.
#
# Places: L<n> of any of the three files, the report on that line, opened in the side panel.
# Units: a data source's name (its reports, Filter by narrowed to it), a day (YYYY-MM-DD) and a window
# (YYYY-MM-DDTHH:MM..YYYY-MM-DDTHH:MM), each framed by the viewfinder.
import bisect
import csv
import re
from datetime import datetime, timezone

import thimble

MAIN, SUPP, SOURCES = "all-reports.csv", "additional-cited-reports.csv", "report-sources.csv"
CATALOG_COLS = ["report_id", "report_url", "report_date_utc", "timestamp_precision", "disposition", "confidence",
                "broad_class", "why_included", "caveat"]
SOURCE_COLS = ["report_id", "report_date_utc", "data_source", "source_basis", "matched_sources"]
FIELDS = ("source", "confidence", "disposition", "broad_class", "source_basis", "matched_sources", "catalog", "why")
NO_ROW = {"review_required": "Review required", "background": "Background control"}
UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
PAGE = 20000
UNIT_REFS = 200
MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def _epoch(s):
    try:
        dt = datetime.fromisoformat(str(s).strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return int(dt.timestamp())


def _iso(t):
    return datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _when(t):
    d = datetime.fromtimestamp(t, timezone.utc)
    return f"{MONTHS[d.month - 1]} {d.day} {d.year} {d:%H:%M:%S}"


def _read_csv(path, want, problems):
    """(line, {col: value}) of each row of a CSV file, and the byte offset of every line. A line that does not parse
    into the header's columns, or holds no report id or no readable time, is a problem."""
    offsets, rows = [], []
    with open(path, "rb") as fh:
        data = fh.read()
    pos, header = 0, None
    parts = data.split(b"\n")
    if parts and parts[-1] == b"":
        parts.pop()
    for n, raw in enumerate(parts, 1):
        offsets.append(pos)
        pos += len(raw) + 1
        line = raw.decode("utf-8", "replace").rstrip("\r\n")
        if not line.strip():
            continue
        try:
            cells = next(csv.reader([line], strict=True))
        except (csv.Error, StopIteration) as e:
            problems.append({"ref": f"{path}#L{n}", "why": f"not a CSV row ({e})"})
            continue
        if header is None:
            header = [c.strip() for c in cells]
            missing = [c for c in ("report_id", "report_date_utc") if c not in header]
            if missing:
                problems.append({"ref": f"{path}#L{n}", "why": "the header has no " + " or ".join(missing)})
                return offsets, []
            continue
        if len(cells) != len(header):
            problems.append({"ref": f"{path}#L{n}", "why": f"{len(cells)} cells where the header has {len(header)}"})
            continue
        r = dict(zip(header, cells, strict=True))
        if not UUID.fullmatch(r["report_id"].strip()):
            problems.append({"ref": f"{path}#L{n}", "why": "no report id"})
            continue
        if _epoch(r["report_date_utc"]) is None:
            problems.append({"ref": f"{path}#L{n}", "why": "no time the reader can read"})
            continue
        rows.append((n, {k: r.get(k, "").strip() for k in want}))
    return offsets, rows


def build_index(paths):
    paths = list(paths)
    byname = {p.rsplit("/", 1)[-1]: p for p in paths}
    files = [byname.get(MAIN), byname.get(SUPP), byname.get(SOURCES)]
    problems, offsets, found = [], [[], [], []], [[], [], []]
    for fi, path in enumerate(files):
        if path is None:
            continue
        try:
            offsets[fi], found[fi] = _read_csv(path, SOURCE_COLS if fi == 2 else CATALOG_COLS, problems)
        except OSError as e:
            problems.append({"ref": f"{path}#L1", "why": f"cannot be read ({type(e).__name__})"})
    reps = {}  # report_id: {lines: [main, supp, sources], vals}
    for fi in range(3):
        for n, r in found[fi]:
            rid = r["report_id"]
            rec = reps.setdefault(rid, {"lines": [0, 0, 0], "cat": None, "src": None})
            if rec["lines"][fi]:
                continue  # a report listed twice in one file: the first line holds it
            rec["lines"][fi] = n
            if fi < 2:
                rec["cat"] = rec["cat"] or r
            else:
                rec["src"] = r
    names = {f: [""] for f in FIELDS}
    at = {f: {"": 0} for f in FIELDS}

    def code(f, v):
        if v not in at[f]:
            at[f][v] = len(names[f])
            names[f].append(v)
        return at[f][v]

    out = []
    for rid, rec in reps.items():
        cat, src = rec["cat"] or {}, rec["src"] or {}
        t = _epoch(cat.get("report_date_utc") or src.get("report_date_utc"))
        disp = cat.get("disposition", "included" if src else "")
        source = src.get("data_source") or NO_ROW.get(disp, "No source row")
        fi = 0 if rec["lines"][0] else 1 if rec["lines"][1] else 2
        vals = {"source": source, "confidence": cat.get("confidence", ""), "disposition": disp,
                "broad_class": cat.get("broad_class", ""), "source_basis": src.get("source_basis", ""),
                "matched_sources": src.get("matched_sources", ""),
                "catalog": ("supplement" if rec["lines"][1] else "main") if files[1] else "",
                "why": cat.get("why_included", "")}
        out.append([t, fi, rec["lines"][fi], *(code(f, vals[f]) for f in FIELDS), *rec["lines"], rid])
    out.sort(key=lambda r: (r[0], r[-1]))
    # where each file's lines are: {file: {line: row}}
    at_line = [{}, {}, {}]
    for i, r in enumerate(out):
        for fi in range(3):
            n = r[3 + len(FIELDS) + fi]
            if n:
                at_line[fi][n] = i
    counts = {}
    for r in out:
        counts[r[3]] = counts.get(r[3], 0) + 1
    return {"rows": [r[:-1] for r in out], "ids": [r[-1] for r in out], "files": files, "names": names,
            "offsets": offsets, "at_line": [{str(k): v for k, v in m.items()} for m in at_line],
            "source_counts": {names["source"][k]: n for k, n in counts.items()}, "problems": problems}


# ---------------------------------------------------------------- a record's fields

LINES = 3 + len(FIELDS)  # the row's line in each of the three files, 0 for none


def _vals(index, i):
    row = index["rows"][i]
    return {f: index["names"][f][row[3 + k]] for k, f in enumerate(FIELDS)}


def _refs(index, i):
    """The record's refs, its own first, then its lines in the other files."""
    row, files = index["rows"][i], index["files"]
    own = f"{files[row[1]]}#L{row[2]}"
    return [own] + [f"{files[fi]}#L{n}" for fi, n in enumerate(row[LINES:LINES + 3]) if n and fi != row[1]]


def _filtering():
    try:
        return bool((thimble.view_labels() or {}).get("filter"))
    except Exception:  # noqa: BLE001 - outside a view call there is no filter
        return True


def _kept(index, i, keep, filtering=True):
    return i in keep or not filtering or all(thimble.kept(ref) for ref in _refs(index, i))


def _value(choice, index, i, rec):
    """A record's value under a choice: a field's, or a label's on any of its lines, its own first."""
    if isinstance(choice, dict) and choice.get("label") is not None:
        for ref in _refs(index, i):
            v = thimble.color_value(choice, ref, rec)
            if v is not None:
                return v
        return None
    return thimble.color_value(choice, None, rec)


def _line(index, fi, n):
    path = index["files"][fi]
    offs = index["offsets"][fi]
    if not path or not 0 < n <= len(offs):
        return ""
    with open(path, "rb") as fh:
        fh.seek(offs[n - 1])
        return fh.readline().decode("utf-8", "replace").rstrip("\r\n")


def _overview(index, query, keep):
    rows, names = index["rows"], index["names"]
    choice, only, group_by = query.get("color"), query.get("filter"), query.get("rows")
    q = str(query.get("q") or "").strip().lower()
    start = query.get("from")
    i = start if isinstance(start, int) and not isinstance(start, bool) and start > 0 else 0
    cols = {k: [] for k in ("r", "t", "f", "n", "id", *FIELDS, "value", "group")}
    counts, fcounts = {}, {}
    hit_why = {k for k, w in enumerate(names["why"]) if q and q in w.lower()}
    end = min(len(rows), i + PAGE)
    filtering = _filtering()
    for j in range(i, end):
        row = rows[j]
        asked = j in keep
        if q and not asked:
            words = (index["ids"][j], names["source"][row[3]], names["matched_sources"][row[3 + FIELDS.index("matched_sources")]])
            if row[3 + FIELDS.index("why")] not in hit_why and not any(q in w.lower() for w in words):
                continue
        if not _kept(index, j, keep, filtering):
            continue
        rec = _vals(index, j)
        value, shown = _value(choice, index, j, rec), _value(only, index, j, rec)
        shows = thimble.color_on(only, shown)
        fcounts[shown or ""] = fcounts.get(shown or "", 0) + 1
        if shows:
            counts[value or ""] = counts.get(value or "", 0) + 1
        if not shows and not asked:
            continue
        cols["r"].append(j)
        cols["t"].append(row[0])
        cols["f"].append(row[1])
        cols["n"].append(row[2])
        cols["id"].append(index["ids"][j])
        for k, f in enumerate(FIELDS):
            cols[f].append(row[3 + k])
        cols["value"].append(value)
        cols["group"].append(_value(group_by, index, j, rec))
    thimble.progress(end, len(rows), "reports")
    page = {"cols": cols, "counts": counts, "fcounts": fcounts, "next": end if end < len(rows) else None}
    if not start:
        page["span"] = [rows[0][0], rows[-1][0]] if rows else [0, 0]
    return page


def _order(index):
    """The data sources, the largest first, then the lanes of the reports with no source row."""
    c = index["source_counts"]
    return sorted(c, key=lambda s: (s in NO_ROW.values() or s == "No source row", -c[s], s))


def _record(index, i):
    rows = index["rows"]
    if not isinstance(i, int) or isinstance(i, bool) or not 0 <= i < len(rows):
        return None
    row = rows[i]
    lines = []
    for fi, n in enumerate(row[LINES:LINES + 3]):
        if n:
            lines.append({"ref": f"{index['files'][fi]}#L{n}", "file": index["files"][fi], "line": n,
                          "text": _line(index, fi, n)})
    rec = {}
    for ln in lines:
        cols = SOURCE_COLS if ln["file"] == index["files"][2] else CATALOG_COLS
        try:
            cells = next(csv.reader([ln["text"]]))
        except (csv.Error, StopIteration):
            continue
        for k, v in zip(cols, cells, strict=False):
            rec.setdefault(k, v)
    return {"r": i, "ref": _refs(index, i)[0], "t": row[0], "fields": rec, "vals": _vals(index, i), "lines": lines}


def records(index, query):
    query = query or {}
    keep = {x for x in query.get("keep") or () if isinstance(x, int) and not isinstance(x, bool)}
    if query.get("op") == "record":
        return _record(index, query.get("r"))
    if query.get("op") == "meta":
        return {"order": _order(index), "names": index["names"], "files": index["files"]}
    return _overview(index, query, keep)


# ---------------------------------------------------------------- citations


def _unit(index, found, label, key, target):
    found = [i for i in found if _kept(index, i, ())] or found
    rows = index["rows"]
    lines = [_line(index, rows[i][1], rows[i][2]) for i in found[:8]]
    return {"excerpt": "\n".join(lines), "label": label, "refs": [_refs(index, i)[0] for i in found[:UNIT_REFS]],
            "key": key, "target": target}


def resolve(index, locator):
    rows = index["rows"]
    times = [r[0] for r in rows]
    if "key" in locator:
        key = str(locator["key"])
        if key in index["source_counts"]:
            code = index["names"]["source"].index(key)
            found = [i for i, r in enumerate(rows) if r[3] == code]
            return _unit(index, found, f"{key} · {len(found)} reports", key, {"source": key})
        if re.fullmatch(r"\d{4}-\d\d-\d\d", key):
            a = _epoch(key + "T00:00:00Z")
            if a is None:
                return None
            found = list(range(bisect.bisect_left(times, a), bisect.bisect_left(times, a + 86400)))
            if not found:
                return None
            return _unit(index, found, f"{_when(a)[:-9]} · {len(found)} reports", key, {"from": a, "to": a + 86400})
        m = re.fullmatch(r"(\d{4}-\d\d-\d\dT\d\d:\d\d)\.\.(\d{4}-\d\d-\d\dT\d\d:\d\d)", key)
        if not m or (a := _epoch(m.group(1))) is None or (b := _epoch(m.group(2))) is None or b <= a:
            return None
        found = list(range(bisect.bisect_left(times, a), bisect.bisect_left(times, b)))
        if not found:
            return None
        return _unit(index, found, f"{_when(a)[:-3]} to {_when(b)[:-3]} · {len(found)} reports", key,
                     {"from": a, "to": b})
    path, fragment = locator.get("path"), str(locator.get("fragment") or "")
    if path not in index["files"]:
        return None
    m = re.fullmatch(r"L(\d+)(?:-L?\d+)?", fragment)
    if not m:
        return None
    fi = index["files"].index(path)
    n = int(m.group(1))
    lines = index["at_line"][fi]
    i = lines.get(str(n))
    if i is None:  # the header or a line that holds no report: the nearest report after it, else before it
        if not lines:
            return None
        known = sorted(int(k) for k in lines)
        k = bisect.bisect_left(known, n)
        i = lines[str(known[min(k, len(known) - 1)])]
    row = rows[i]
    own = row[LINES + fi]
    text = _line(index, fi, own)
    if not text:
        return None
    asked = f"{path}#L{n}"
    refs = [asked] + [r for r in _refs(index, i) if r != asked]
    v = _vals(index, i)
    return {"excerpt": text, "label": f"{v['source']} · {_when(rows[i][0])}", "refs": refs, "key": None,
            "target": {"r": i}}


def problems(index):
    return index["problems"]

