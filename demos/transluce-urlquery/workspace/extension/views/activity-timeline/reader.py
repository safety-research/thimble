# Activity Timeline: every URLQuery report of the catalog on one UTC time axis, a lane per data source (or per value of
# another field or a label), and the bursts of each lane's reports, its episodes.
#
# The data:
#   all-reports.csv                 one row per report (38,160), the header first: report_id, report_url,
#                                   report_date_utc (ISO 8601 in UTC, to the second), timestamp_precision, disposition
#                                   (included, review_required or background), confidence (significant, suggestive or
#                                   blank), broad_class (source_request, indirection or custom_program), why_included
#                                   (free text of stock sentences) and caveat
#   report-sources.csv              one row per included report: report_id, report_date_utc, data_source (a display
#                                   name such as UNCTAD), source_basis and matched_sources
#   additional-cited-reports.csv    the supplemental catalog, all-reports.csv's columns: a report is supplemental when
#                                   its report_id is listed here
#   selection-provenance.csv        the provenance of the supplement's additions, one row per report_id: source_batch,
#                                   group, source, record_kind, selection_basis and description
#   supplement-classifications.json {original_classifier_sha256, decisions}: one decision per supplemental report_id
#   classification-overrides.json   {generated_at, base_release, scope, decisions}: the reviewed confidence changes, each
#                                   with previous_confidence, confidence, basis and reason
#
# The records: one report per row of all-reports.csv, cited as all-reports.csv#L<n>. The reader joins the report's
# source row on report_id (cited as report-sources.csv#L<n>) and gives each report:
#   time      report_date_utc read as seconds since 1970 in UTC
#   lane      the report's data_source, else Review required or Background control by its disposition (another
#             disposition names its own lane, and an included report with no source row is in "No source row")
#   catalog   supplemental when additional-cited-reports.csv lists its report_id, else main
# A report's provenance row, supplemental decision and confidence change are joined on report_id and shown with it.
# An episode is the reports of one lane whose consecutive times are less than GAP seconds apart; a gap of GAP or more
# starts the next one. The page groups the reports it shows into episodes the same way for whatever the lanes are
# grouped by; the reader knows the data source lanes' episodes, for their citations.
#
# The cleaning: a row whose cells do not match the header (a line cut short), a row with no report_id, a time that does
# not parse and a report_id that repeats are no record, and problems() lists them. The JSON files are read decision by
# decision, so a torn file keeps the decisions before the tear. A source row, supplemental row, provenance row or
# decision whose report_id no report has cannot be placed, and unplaced() lists it.
#
# The method: the index keeps each report as small integers in time order (its time, its lines, a code per field) with
# its report_id and the byte offset of every line, so a report's row is read back from its file when the page opens it.
# `records` sends every report the label filter keeps as columns, ROWS a fetch, and the page zooms, filters, groups and
# lays out its lanes and episodes without asking again.
#
# Units: a lane (unctad, review-required), a UTC day (2026-05-11), a window (2026-05-11T14:00..2026-05-11T15:00), a lane
# within a day or a window (unctad/2026-05-11), which the overview's bars are, and an episode, a lane and its first
# report's second (unctad/2026-05-17T00:10:01Z).
#
# Labels: a report is its two rows, so a label over either file applies to it. It stays when thimble.kept_unit holds for
# its rows, and its marks are those thimble.marked gives either row, in the order of the labels the view reads (those
# that are on, and those its controls name), each with its label's id; the page reads a report's value of a label from
# them for Color by, Filter by and Rows, since thimble cannot see inside its charts.
import bisect
import csv
import json
import re
from datetime import datetime, timezone

import thimble

ALL, SRC, SUP = "all-reports.csv", "report-sources.csv", "additional-cited-reports.csv"
PROVENANCE, SUPPLEMENT, OVERRIDES = "selection-provenance.csv", "supplement-classifications.json", "classification-overrides.json"
PROVENANCE_COLUMNS = ("report_id", "source_batch", "group", "source", "record_kind", "selection_basis", "description")
FIELDS = ("lane", "confidence", "disposition", "broad_class", "source_basis", "catalog", "why_included")  # coded per report
NON_INCLUDED = {"review_required": "Review required", "background": "Background control"}
NO_SOURCE = "No source row"
GAP = 7200  # seconds between two reports of a lane that start a new episode
ROWS = 40000  # reports one overview fetch sends
MARKS_MAX = 24  # label values the page tells apart
UNIT_REFS = 40  # refs a unit's answer cites
EXCERPT_ROWS = 3  # rows a unit's excerpt quotes
SEARCH_MAX = 40000
ID_CHARS = 8  # characters of a report_id the overview sends
CHIP_MAX = 40  # characters of a citation's chip (thimble cuts longer ones)
ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_"  # a field's codes, 6 bits a character
MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
DAY = re.compile(r"\d{4}-\d\d-\d\d")
WINDOW = re.compile(r"(\d{4}-\d\d-\d\dT\d\d:\d\d)\.\.(\d{4}-\d\d-\d\dT\d\d:\d\d)")
EPISODE = re.compile(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ")
UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
# why_included is a few stock sentences; the short form the page lists keeps what tells one report from another
SHORT = (
    (re.compile(r"^Related data source or exact task identifier: (.*?)\.?$"), r"\1"),
    (re.compile(r"^Member of the externally selected research-activity cohort(?::.*)?\.?$"), "external cohort"),
    (re.compile(r"^Imported tags are source-attributed evidence.*$"), ""),
    (re.compile(r"^Submitted content uses an intermediary or publishes task material\.$"), "intermediary or published task"),
    (re.compile(r"^Supplied task-specific code fetches data or automatically submits a POST form\.$"), "task code"),
    (re.compile(r"^Explicit reference or discovery candidate; relation to an agent-like workflow needs review\.$"),
     "candidate, needs review"),
)
SENTENCE = re.compile(r"(?<=\.)\s+(?=[A-Z])")


def _epoch(s):
    """Whole seconds since 1970 of an ISO 8601 time, UTC when it names no offset; None when it does not parse."""
    s = str(s or "").strip()
    if not s:
        return None
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None
    return int((dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)).timestamp())


def _iso_second(t):
    return datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _when(t, seconds=False):
    d = datetime.fromtimestamp(t, timezone.utc)
    return f"{MONTHS[d.month - 1]} {d.day}, {d.year} {d:%H:%M:%S}" if seconds else f"{MONTHS[d.month - 1]} {d.day}, {d.year}"


def slug(name):
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-") or "lane"


def short_why(text):
    """why_included with its stock sentences cut to a few words and its disclaimer dropped, joined by ' · '."""
    out = []
    for s in SENTENCE.split((text or "").strip()):
        for pat, rep in SHORT:
            if pat.match(s):
                s = pat.sub(rep, s)
                break
        if s and s not in out:
            out.append(s)
    return " · ".join(out)


def _rows(path, offs, problems):
    """(first line, last line, cells) of each row of a CSV file, a quoted cell over several lines included, recording
    each line's byte offset in `offs`; a row that does not parse is a problem."""
    numbers = []

    def lines():
        with open(path, "rb") as fh:
            pos = 0
            for n, raw in enumerate(fh, 1):
                offs.append(pos)
                pos += len(raw)
                numbers.append(n)
                yield raw.decode("utf-8", "replace").rstrip("\r\n") + "\n"

    reader, done = csv.reader(lines(), strict=True), 0
    while True:
        try:
            cells = next(reader)
        except StopIteration:
            return
        except csv.Error as e:
            if numbers:
                problems.append({"ref": f"{path}#L{numbers[min(done, len(numbers) - 1)]}", "why": f"not a CSV row ({e})"})
            done = reader.line_num
            continue
        if numbers:
            yield numbers[done], numbers[reader.line_num - 1], cells
        done = reader.line_num


def _table(path, offs, problems, need):
    """(header, [(line, last line, row dict)]) of a CSV file whose header names the columns `need`; a row whose cells
    are fewer or more than the header's is a problem."""
    header, out = None, []
    try:
        for a, b, cells in _rows(path, offs, problems):
            if header is None:
                header = [c.strip().lstrip("\ufeff") for c in cells]
                missing = [c for c in need if c not in header]
                if missing:
                    problems.append({"ref": f"{path}#L{a}", "why": f"the header has no column {', '.join(missing)}"})
                    return header, []
                continue
            if not any(c.strip() for c in cells):
                continue
            if len(cells) != len(header):
                problems.append({"ref": f"{path}#L{a}", "why": f"{len(cells)} cells where the header names {len(header)}"
                                 + (", a line cut short" if len(cells) < len(header) else "")})
                continue
            out.append((a, b, dict(zip(header, cells, strict=True))))
    except OSError as e:
        problems.append({"ref": f"{path}#L1", "why": f"cannot be read ({type(e).__name__})"})
    return header, out


def _decisions(path, problems):
    """[(index, first line, last line, decision)] of a JSON file's `decisions` array, read one decision at a time, so a
    torn file keeps the decisions before the tear, which is a problem."""
    try:
        with open(path, "rb") as fh:
            text = fh.read().decode("utf-8", "replace")
    except OSError as e:
        problems.append({"ref": f"{path}#L1", "why": f"cannot be read ({type(e).__name__})"})
        return []
    line_of = lambda pos: text.count("\n", 0, pos) + 1  # noqa: E731
    try:
        json.loads(text)
        whole = True
    except ValueError as e:
        whole = False
        problems.append({"ref": f"{path}#L{line_of(getattr(e, 'pos', 0) or 0)}",
                         "why": "not valid JSON (the file may be cut short): the decisions before this line are read"})
    m = re.search(r'"decisions"\s*:\s*\[', text)
    if not m:
        if whole:
            problems.append({"ref": f"{path}#L1", "why": "no decisions array"})
        return []
    dec, pos, out, gap = json.JSONDecoder(), m.end(), [], re.compile(r"[\s,]*")
    while True:
        pos = gap.match(text, pos).end()
        if pos >= len(text) or text[pos] == "]":
            break
        try:
            item, end = dec.raw_decode(text, pos)
        except ValueError:
            if whole:
                problems.append({"ref": f"{path}#L{line_of(pos)}", "why": "a decision that does not parse"})
            break
        k = len(out)
        if not isinstance(item, dict) or not UUID.fullmatch(str(item.get("report_id", "")).strip()):
            problems.append({"ref": f"{path}#/decisions/{k}", "why": "a decision with no report_id"})
        out.append((k, line_of(pos), line_of(end - 1), item))
        pos = end
    return out


def build_index(paths):
    """{"n", "t": [epoch] in time order, "line": [all-reports.csv line], "sline": [report-sources.csv line or 0],
    "codes": {field: [code]}, "names": {field: [value]}, "short": [why_included's short form, by its code], "ids":
    [report_id], "lanes": [lane codes, largest first, the non-included last], "lane_keys": {key: code}, "files": {name:
    path}, "offsets": {path: [byte offset of line n at n-1]}, "lane_count": [reports per lane], "by_lane": {lane:
    [rows]}, "episodes": [{lane, start, end, rows}], "ep_at": {unit key: episode}, "at": {path: {line: row}},
    "provenance", "supplement", "overrides": {row: record and its place}, "problems", "unplaced"}."""
    files = {}
    for p in paths:
        name = p.rsplit("/", 1)[-1]
        if name in (ALL, SRC, SUP, PROVENANCE, SUPPLEMENT, OVERRIDES):
            files[name] = p
    problems, unplaced, offsets = [], [], {}

    sources, sup = {}, {}
    thimble.progress(0, 5, "Reading the source table")
    if SRC in files:
        p = files[SRC]
        offsets[p] = []
        _, rows = _table(p, offsets[p], problems, ("report_id", "data_source"))
        for a, _b, r in rows:
            rid = r["report_id"].strip()
            if not rid:
                problems.append({"ref": f"{p}#L{a}", "why": "no report_id"})
            elif rid in sources:
                problems.append({"ref": f"{p}#L{a}", "why": f"a second source row for the report on line {sources[rid][0]}"})
            else:
                sources[rid] = (a, r.get("data_source", "").strip(), r.get("source_basis", "").strip())
    if SUP in files:
        p = files[SUP]
        offsets[p] = []
        _, rows = _table(p, offsets[p], problems, ("report_id",))
        for a, _b, r in rows:
            rid = r["report_id"].strip()
            if rid:
                sup.setdefault(rid, a)

    thimble.progress(1, 5, "Reading the catalog")
    found, seen = [], {}
    if ALL in files:
        p = files[ALL]
        offsets[p] = []
        _, rows = _table(p, offsets[p], problems, ("report_id", "report_date_utc", "disposition"))
        for a, b, r in rows:
            rid = r["report_id"].strip()
            if not rid:
                problems.append({"ref": f"{p}#L{a}", "why": "no report_id"})
                continue
            if rid in seen:
                problems.append({"ref": f"{p}#L{a}", "why": f"repeats the report on line {seen[rid]}"})
                continue
            t = _epoch(r.get("report_date_utc"))
            if t is None:
                problems.append({"ref": f"{p}#L{a}", "why": f"a report_date_utc that is no time: {r.get('report_date_utc', '')[:40]!r}"})
                continue
            seen[rid] = a
            disp = r.get("disposition", "").strip()
            src = sources.get(rid)
            if disp == "included":
                lane = src[1] or NO_SOURCE if src else NO_SOURCE
            else:
                lane = NON_INCLUDED.get(disp, disp or "No disposition")
            found.append((t, a, src[0] if src else 0, rid, {
                "lane": lane, "confidence": r.get("confidence", "").strip(), "disposition": disp,
                "broad_class": r.get("broad_class", "").strip(), "source_basis": src[2] if src else "",
                "catalog": "supplemental" if rid in sup else "main", "why_included": r.get("why_included", "").strip()}))

    for rid, (a, _name, _basis) in sources.items():
        if rid not in seen:
            unplaced.append({"ref": f"{files[SRC]}#L{a}", "why": f"no report in {ALL} has the report_id {rid}"})
    for rid, a in sup.items():
        if rid not in seen and ALL in files:
            unplaced.append({"ref": f"{files[SUP]}#L{a}", "why": f"no report in {ALL} has the report_id {rid}"})

    found.sort(key=lambda x: (x[0], x[1]))
    names = {f: [] for f in FIELDS}
    at_name = {f: {} for f in FIELDS}
    codes = {f: [] for f in FIELDS}
    for x in found:
        for f in FIELDS:
            v = x[4][f]
            if v not in at_name[f]:
                at_name[f][v] = len(names[f])
                names[f].append(v)
            codes[f].append(at_name[f][v])
    n = len(found)
    count = [0] * len(names["lane"])
    for c in codes["lane"]:
        count[c] += 1
    last = set(NON_INCLUDED.values())
    lanes = sorted(range(len(names["lane"])), key=lambda c: (names["lane"][c] in last, names["lane"][c] == NO_SOURCE,
                                                             -count[c], names["lane"][c]))
    lane_keys, taken = {}, set()
    for c in lanes:
        k, i = slug(names["lane"][c]), 2
        while k in taken or DAY.fullmatch(k):
            k, i = f"{slug(names['lane'][c])}-{i}", i + 1
        taken.add(k)
        lane_keys[k] = c
    key_of = {c: k for k, c in lane_keys.items()}
    at = {p: {} for p in offsets}
    for i, x in enumerate(found):
        at[files[ALL]][x[1]] = i
        if x[2]:
            at[files[SRC]][x[2]] = i
    by_id = {x[3]: i for i, x in enumerate(found)}
    if SUP in files:
        for rid, a in sup.items():
            if rid in by_id:
                at[files[SUP]][a] = by_id[rid]
    by_lane = {}
    for i, c in enumerate(codes["lane"]):
        by_lane.setdefault(c, []).append(i)

    # the episodes of each data source lane: its reports in time order, split where two lie GAP or more apart
    thimble.progress(2, 5, "Finding the episodes")
    t_of = [x[0] for x in found]
    episodes, ep_at = [], {}
    for c in lanes:
        cur = []
        for i in by_lane.get(c, []):
            if cur and t_of[i] - t_of[cur[-1]] >= GAP:
                episodes.append({"lane": c, "start": t_of[cur[0]], "end": t_of[cur[-1]], "rows": cur})
                cur = []
            cur.append(i)
        if cur:
            episodes.append({"lane": c, "start": t_of[cur[0]], "end": t_of[cur[-1]], "rows": cur})
    for e, ep in enumerate(episodes):
        ep_at.setdefault(f"{key_of[ep['lane']]}/{_iso_second(ep['start'])}", e)

    # provenance rows and decisions, each joined to its report by report_id
    thimble.progress(3, 5, "Reading provenance and decisions")
    provenance, supplement, overrides = {}, {}, {}
    if PROVENANCE in files:
        p = files[PROVENANCE]
        offsets[p] = []
        _, rows = _table(p, offsets[p], problems, PROVENANCE_COLUMNS)
        at[p] = {}
        for a, _b, r in rows:
            rid = r["report_id"].strip()
            if rid not in by_id:
                unplaced.append({"ref": f"{p}#L{a}", "why": f"no report in {ALL} has the report_id {rid}"})
                continue
            provenance[by_id[rid]] = {"line": a, "record": {k: r.get(k, "").strip() for k in PROVENANCE_COLUMNS}}
            at[p][a] = by_id[rid]
    for name, store in ((SUPPLEMENT, supplement), (OVERRIDES, overrides)):
        if name not in files:
            continue
        p = files[name]
        for k, a, b, d in _decisions(p, problems):
            rid = str(d.get("report_id", "")).strip() if isinstance(d, dict) else ""
            if not rid:
                continue
            if rid not in by_id:
                unplaced.append({"ref": f"{p}#/decisions/{k}", "why": f"no report in {ALL} has the report_id {rid}"})
                continue
            store[by_id[rid]] = {"k": k, "lines": [a, b], "record": d}
    thimble.progress(5, 5, "Done")
    return {"n": n, "t": t_of, "line": [x[1] for x in found], "sline": [x[2] for x in found],
            "ids": [x[3] for x in found], "codes": codes, "names": names,
            "short": [short_why(w) for w in names["why_included"]], "lanes": lanes, "lane_keys": lane_keys,
            "lane_count": count, "by_lane": by_lane, "episodes": episodes, "ep_at": ep_at, "files": files,
            "offsets": offsets, "at": at, "provenance": provenance, "supplement": supplement, "overrides": overrides,
            "problems": problems, "unplaced": unplaced}


# ---------------------------------------------------------------- reading rows back


def _lines(index, path, ns):
    """{n: line n of a claimed file as it holds it} for the wanted line numbers it has."""
    offs = index["offsets"].get(path) or []
    out = {}
    try:
        with open(path, "rb") as fh:
            for n in ns:
                if 1 <= n <= len(offs):
                    fh.seek(offs[n - 1])
                    out[n] = fh.readline().decode("utf-8", "replace").rstrip("\r\n")
    except OSError:
        pass
    return out


def _line(index, path, n):
    """Line n of a claimed file as it holds it, or None."""
    return _lines(index, path, [n]).get(n)


def _header(index, path):
    line = _line(index, path, 1)
    if line is None:
        return []
    try:
        return [c.strip().lstrip("\ufeff") for c in next(csv.reader([line]))]
    except (csv.Error, StopIteration):
        return []


def _parse(index, path, n):
    """The row on line n of a CSV file as {column: value}, or {}."""
    line = _line(index, path, n)
    if line is None:
        return {}
    try:
        cells = next(csv.reader([line]))
    except (csv.Error, StopIteration):
        return {}
    return dict(zip(_header(index, path), cells, strict=False))


def _refs(index, i):
    """The refs of report i's rows: its all-reports.csv line, then its report-sources.csv line when it has one."""
    out = [f"{index['files'][ALL]}#L{index['line'][i]}"]
    if index["sline"][i]:
        out.append(f"{index['files'][SRC]}#L{index['sline'][i]}")
    return out


def _name(index, f, i):
    return index["names"][f][index["codes"][f][i]]


class _Labels:
    """The label calls of one fetch: `marks` the values of the labels the view reads, each {label, id, value, colour},
    in thimble's order; `bits(i)` those that mark report i, as bits; `kept(i)` whether the label filter keeps it."""

    def __init__(self, index):
        self.index = index
        on = thimble.view_labels()
        self.marks = [{"label": lab["name"], "id": lab.get("id"), "value": v["name"], "colour": v["colour"]}
                      for lab in on.get("labels") or [] for v in lab.get("values") or []][:MARKS_MAX]
        self.filter = on.get("filter")
        self._at = {(m["label"], m["value"]): k for k, m in enumerate(self.marks)}

    def kept(self, i):
        return not self.filter or thimble.kept_unit(_refs(self.index, i))

    def bits(self, i):
        if not self.marks:
            return 0
        b = 0
        for ref in _refs(self.index, i):
            for m in thimble.marked(ref):
                k = self._at.get((m["label"], m["value"]))
                if k is not None:
                    b |= 1 << k
        return b

    def of(self, i):
        b = self.bits(i)
        return [m for k, m in enumerate(self.marks) if b >> k & 1]


# ---------------------------------------------------------------- the page's queries


def _pack(codes, width):
    """Codes as a string of `width` characters of ALPHABET each, the most significant first."""
    out = []
    for c in codes:
        out.append("".join(ALPHABET[(c >> (6 * (width - 1 - k))) & 63] for k in range(width)))
    return "".join(out)


def _overview(index, start, keep):
    """The reports the filter keeps, and those in `keep` whatever it keeps, from row `start` on, at most ROWS of them,
    in time order, as columns small enough for one answer: `ids` the first ID_CHARS characters of each report_id, one after
    another; `r` the reader's row, `t` the seconds since `t0` and `ln` the
    line in all-reports.csv, each as the difference from the report before (`r` is None when the rows run on without a
    gap); `sl` the line in report-sources.csv as the difference from the last report that has one, 0 for none; `codes`
    each field's index into `names` packed as `w` characters of ALPHABET per report; and `mb` [report, bits] for each
    report a label marks, its marks as bits. `next` is the row the next page starts at, None after the last. The first
    page also holds `t0`, `names`, `short` (why_included's short forms), `lanes` (the lanes' codes in order), `keys`
    (each lane's unit key), `counts` (every lane's reports, unfiltered), `files`, `marks`, `alphabet` and `total`."""
    labels = _Labels(index)
    n = index["n"]
    t0 = index["t"][0] if n else 0
    rows, mb = [], []
    i = max(0, start)
    while i < n and len(rows) < ROWS:
        if i in keep or labels.kept(i):
            b = labels.bits(i)
            if b:
                mb.append([len(rows), b])
            rows.append(i)
        i += 1
        if i % 5000 == 0:
            thimble.progress(i, n, "Reading the reports")
    r, t, ln, sl = [], [], [], []
    pr, pt, pl, ps = start - 1, 0, 0, 0
    for j in rows:
        tt, ll, ss = index["t"][j] - t0, index["line"][j], index["sline"][j]
        r.append(j - pr)
        t.append(tt - pt)
        ln.append(ll - pl)
        sl.append(ss - ps if ss else 0)
        pr, pt, pl = j, tt, ll
        if ss:
            ps = ss
    codes = {}
    for f in FIELDS:
        width = 1 if len(index["names"][f]) <= 64 else 2 if len(index["names"][f]) <= 4096 else 3
        codes[f] = {"w": width, "s": _pack((index["codes"][f][j] for j in rows), width)}
    # the start of each report_id, ID_CHARS characters, which tells apart reports of the same lane and second
    ids = "".join((index["ids"][j][:ID_CHARS].encode("ascii", "replace").decode("ascii")).ljust(ID_CHARS) for j in rows)
    page = {"n": len(rows), "r": None if all(x == 1 for x in r) else r, "t": t, "ln": ln, "sl": sl, "codes": codes,
            "ids": ids, "mb": mb, "next": i if i < n else None, "start": start}
    if start <= 0:
        page.update(t0=t0, t1=index["t"][-1] if n else 0, names=index["names"], short=index["short"],
                    lanes=index["lanes"], keys={str(c): k for k, c in index["lane_keys"].items()},
                    counts=index["lane_count"], files={"all": index["files"].get(ALL), "src": index["files"].get(SRC)},
                    marks=labels.marks, alphabet=ALPHABET, id_chars=ID_CHARS, total=n, gap=GAP,
                    filtered=bool(labels.filter))
    return page


def _report(index, i):
    """Report i in full: the cells of its all-reports.csv row under their column names, its source row (`source`, with
    its ref) when it has one, its provenance row, supplemental decision and confidence change when its report_id has
    them (each {ref, record}), its lane and catalog, and the marks of the labels the view reads."""
    if not isinstance(i, int) or isinstance(i, bool) or not 0 <= i < index["n"]:
        return None
    path = index["files"][ALL]
    row = _parse(index, path, index["line"][i])
    out = {"row": i, "ref": f"{path}#L{index['line'][i]}", **{k: v for k, v in row.items()}}
    if index["sline"][i]:
        sp = index["files"][SRC]
        src = _parse(index, sp, index["sline"][i])
        out["source"] = {"ref": f"{sp}#L{index['sline'][i]}", **{k: src.get(k, "") for k in
                                                                  ("data_source", "source_basis", "matched_sources")}}
    p = index["provenance"].get(i)
    if p:
        out["provenance"] = {"ref": f"{index['files'][PROVENANCE]}#L{p['line']}", "record": p["record"]}
    for name, key, store in ((SUPPLEMENT, "supplement", "supplement"), (OVERRIDES, "override", "overrides")):
        d = index[store].get(i)
        if d:
            out[key] = {"ref": f"{index['files'][name]}#/decisions/{d['k']}",
                        "record": {k: v for k, v in d["record"].items() if isinstance(v, (str, int, float)) or
                                   (isinstance(v, list) and all(isinstance(x, str) for x in v))}}
    out["lane"] = _name(index, "lane", i)
    out["catalog"] = _name(index, "catalog", i)
    out["marks"] = _Labels(index).of(i)
    return out


def _search(index, q):
    """The rows whose report_id, why_included, data_source or matched_sources holds `q`, ignoring case; the texts are
    read from the files once and kept beside the index."""
    q = str(q or "").strip().lower()
    if not q:
        return {"q": q, "rows": []}
    texts = index.get("_texts")
    if texts is None:
        texts = {}
        for name in (ALL, SRC):
            p = index["files"].get(name)
            if not p:
                continue
            col = "line" if name == ALL else "sline"
            want = {n: i for i, n in enumerate(index[col]) if n}
            head, rows = _table(p, [], [], ())
            for a, _b, r in rows:
                if a in want:
                    keep = ("report_id", "why_included") if name == ALL else ("data_source", "matched_sources")
                    texts[want[a]] = texts.get(want[a], "") + " " + " ".join(r.get(k, "") for k in keep).lower()
        index["_texts"] = texts
    rows = [i for i in range(index["n"]) if q in texts.get(i, "")]
    return {"q": q, "rows": rows[:SEARCH_MAX]}


def records(index, query):
    """{op: overview, from?, keep?}: a page of the reports the label filter keeps, as columns (_overview).
    {op: report, r}: one report in full (_report). {op: search, q}: the rows that hold q (_search)."""
    query = query or {}
    op = query.get("op")
    if op == "report":
        return _report(index, query.get("r"))
    if op == "search":
        return _search(index, query.get("q"))
    keep = {x for x in query.get("keep") or () if isinstance(x, int) and not isinstance(x, bool)}
    start = query.get("from")
    return _overview(index, start if isinstance(start, int) and not isinstance(start, bool) else 0, keep)


# ---------------------------------------------------------------- citations


def _span(index, a, b):
    """The rows from time a up to time b, as a range."""
    return range(bisect.bisect_left(index["t"], a), bisect.bisect_left(index["t"], b))


def _unit(index, rows, label, key, target):
    rows = list(rows)
    if not rows:
        return None
    path = index["files"][ALL]
    got = _lines(index, path, [index["line"][i] for i in rows[:EXCERPT_ROWS]])
    return {"excerpt": "\n".join(got[n] for n in sorted(got) if got[n]), "label": label,
            "refs": [f"{path}#L{index['line'][i]}" for i in rows[:UNIT_REFS]], "key": key, "target": target}


def _window(key):
    """(start, end, words) of a day or a window key, or None."""
    if DAY.fullmatch(key):
        a = _epoch(key + "T00:00:00Z")
        return None if a is None else (a, a + 86400, _when(a))
    m = WINDOW.fullmatch(key)
    if not m:
        return None
    a, b = _epoch(m.group(1)), _epoch(m.group(2))
    if a is None or b is None or b <= a:
        return None
    da, db = _when(a, True), _when(b, True)
    words = f"{da[:-3]}–{db[-8:-3]}" if da[:-9] == db[:-9] else f"{da[:-15]} {da[-8:-3]}–{db[:-15]} {db[-8:-3]}"
    return a, b, words


def _plural(n, word):
    return f"{n:,} {word}" + ("" if n == 1 else "s")


def _chip(*parts):
    """The parts joined for a citation's chip, a count at the end left off when it is longer than CHIP_MAX (thimble
    cuts what is still too long)."""
    parts = [p for p in parts if p]
    while len(parts) > 2 and len(" · ".join(parts)) > CHIP_MAX:
        parts.pop()
    return " · ".join(parts)


EXCERPT_CELLS = {
    SUPPLEMENT: ("reason", "basis", "confidence", "broad_class"),
    OVERRIDES: ("reason", "previous_confidence", "confidence", "basis"),
}


def _quote(record, name):
    """The cells of a decision an excerpt quotes, one a line, each once."""
    out = []
    for k in EXCERPT_CELLS[name]:
        v = record.get(k) if isinstance(record, dict) else None
        v = v.strip() if isinstance(v, str) else ""
        if v and v not in out:
            out.append(v)
    return out


def _report_place(index, i, refs, excerpt, what=""):
    """A citation of report i: its lane, its time and what of it is cited, opened in its lane."""
    if not excerpt:
        return None
    lane = _name(index, "lane", i)
    key = next((k for k, c in index["lane_keys"].items() if c == index["codes"]["lane"][i]), None)
    return {"excerpt": excerpt, "label": _chip(lane + what, _when(index["t"][i], True)[:-3]), "refs": refs, "key": key,
            "target": {"r": i}}


def resolve(index, locator):
    """<file>#L<n>: the report on that line of all-reports.csv, report-sources.csv, additional-cited-reports.csv or
    selection-provenance.csv, opened in its lane; a header line is the file's columns. <decisions file>#/decisions/<k>
    or #L<n>: the report the decision is about, from the decision on that line or the nearest one after it.
    view:<slug>/<lane>: one lane's reports. view:<slug>/<YYYY-MM-DD> or <from>..<to>: the reports of a UTC day or window.
    view:<slug>/<lane>/<day or window>: one lane's reports in it. view:<slug>/<lane>/<YYYY-MM-DDTHH:MM:SSZ>: the
    episode of that lane whose first report is at that second."""
    if "key" in locator:
        key = str(locator["key"]).strip()
        lane_key, _, when = key.partition("/")
        if lane_key in index["lane_keys"]:
            c = index["lane_keys"][lane_key]
            rows = index["by_lane"].get(c, [])
            name = index["names"]["lane"][c]
            if not when:
                return _unit(index, rows, _chip(name, _plural(len(rows), "report")), key, {"lane": c})
            if EPISODE.fullmatch(when):
                e = index["ep_at"].get(key)
                if e is None:
                    return None
                ep = index["episodes"][e]
                d = datetime.fromtimestamp(ep["start"], timezone.utc)
                return _unit(index, ep["rows"], _chip(name, f"episode {MONTHS[d.month - 1]} {d.day} {d:%H:%M}",
                                                      _plural(len(ep["rows"]), "report")), key,
                             {"lane": c, "episode": ep["start"], "from": ep["start"], "to": ep["end"] + 1})
            w = _window(when)
            if w is None:
                return None
            got = [i for i in rows if w[0] <= index["t"][i] < w[1]]
            return _unit(index, got, _chip(name, w[2], _plural(len(got), "report")), key,
                         {"lane": c, "from": w[0], "to": w[1]})
        w = _window(key)
        if w is None:
            return None
        got = _span(index, w[0], w[1])
        return _unit(index, got, _chip(w[2], _plural(len(got), "report")), key, {"from": w[0], "to": w[1]})
    path, fragment = locator.get("path"), str(locator.get("fragment") or "")
    name = str(path or "").rsplit("/", 1)[-1]
    if name in (SUPPLEMENT, OVERRIDES) and index["files"].get(name) == path:
        store = index["supplement" if name == SUPPLEMENT else "overrides"]
        found = sorted(store.items(), key=lambda kv: kv[1]["k"])
        if not found:
            return None
        m = re.fullmatch(r"/decisions/(\d+)(?:/.*)?", fragment)
        line = re.fullmatch(r"L(\d+)", fragment)
        if m:
            hit = next((kv for kv in found if kv[1]["k"] == int(m.group(1))), None)
            refs = [f"{path}#/decisions/{m.group(1)}"]
        elif line:
            n = int(line.group(1))
            hit = next((kv for kv in found if kv[1]["lines"][0] <= n <= kv[1]["lines"][1]), None)
            hit = hit or next((kv for kv in found if kv[1]["lines"][0] > n), found[-1])
            refs = [f"{path}#L{n}", f"{path}#/decisions/{hit[1]['k']}"]
        else:
            return None
        if not hit:
            return None
        i, d = hit
        return _report_place(index, i, refs, "\n".join(_quote(d["record"], name)),
                             "'s decision" if name == SUPPLEMENT else "'s confidence change")
    m = re.fullmatch(r"L(\d+)", fragment)
    if not m or path not in index["at"]:
        return None
    n = int(m.group(1))
    text = _line(index, path, n)
    if text is None or not text.strip():
        return None
    if n == 1:
        return {"excerpt": text, "label": f"{name} columns", "refs": [f"{path}#L1"], "key": None, "target": {}}
    i = index["at"][path].get(n)
    if i is None:
        return None
    if name == PROVENANCE:
        return _report_place(index, i, [f"{path}#L{n}"], text, "'s provenance")
    refs = [f"{path}#L{n}"] + [r for r in _refs(index, i) if r != f"{path}#L{n}"]
    return _report_place(index, i, refs, text)


def problems(index):
    """The lines that do not parse, each {ref, why}."""
    return index["problems"]


def unplaced(index):
    """The source, supplemental and provenance rows and the decisions whose report_id no report has, each {ref, why}."""
    return index["unplaced"]


def hidden(index):
    return []
