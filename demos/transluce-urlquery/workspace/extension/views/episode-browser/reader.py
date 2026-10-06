# Episode Browser: the URLQuery report catalog read as bursts of reports, one data source at a time.
#
# The data, each a file at the corpus's top:
# all-reports.csv, the catalog: a header row, then one report per line with nine columns: report_id, report_url,
#   report_date_utc (ISO 8601 in UTC, to the second), timestamp_precision, disposition (included, review_required or
#   background), confidence (significant, suggestive, or blank off the included), broad_class (source_request,
#   indirection or custom_program), why_included (free text of stock sentences) and caveat.
# report-sources.csv, one row per included report: report_id, report_date_utc, data_source (the display bucket),
#   source_basis and matched_sources. Review-required and background reports have no row.
# selection-provenance.csv, the provenance of the supplement's additions, one row per report_id: source_batch, group,
#   source, record_kind, selection_basis and description.
# supplement-classifications.json, {original_classifier_sha256, decisions}: one decision per supplemental report_id.
# classification-overrides.json, {generated_at, base_release, scope, decisions}: the reviewed confidence changes, each
#   with previous_confidence, confidence, basis and reason.
#
# The records: a report is one row of all-reports.csv, cited <path>#row=<n> as thimble's labels key it, with its
# report-sources.csv row joined by report_id (its data_source, source_basis and matched_sources). An episode is the
# reports of one data source whose consecutive report_date_utc times are less than GAP seconds apart; a gap of GAP or
# more starts the next one. A report with no source row takes the group of its disposition ("Needs review",
# "Background control"), split into episodes the same way. An episode is a unit, cited view:episode-browser/<source
# key>/<its first report's time>, and so is a data source's every episode, view:episode-browser/<source key>.
#
# The cleaning: every file is read whole as bytes and each line parsed on its own, since no cell of the CSV files spans
# lines, so a torn line spoils only itself. A row whose cells do not parse or do not match the header, a report_id
# that is no report id, a time the reader cannot read, a report_id seen before, or a source row whose matched_sources
# names no data source of the file, is no record, and problems() lists it. The JSON files are read decision by
# decision, so a torn file keeps the decisions before the tear. A report that only report-sources.csv names is still a
# report, with the cells the catalog would give blank. A provenance row or decision whose report_id no report has is
# listed by unplaced(). A report_date_utc on which the two CSV files disagree is a problem, and the catalog's wins.
#
# The method: the index keeps each report as small integers (time, catalog row, source row, an index into each
# category's names), the byte offset of every line of the CSV files, each episode's reports in time order, and the
# few provenance rows and decisions whole. `records` answers the overview with one row per episode, its counts, peak
# minute and rate over its span taken over the reports the label filter keeps, an episode's reports in time order with
# their cells read back from their lines, and one report in full. A citation's excerpt quotes cells of the records it
# cites, one a line, as the files hold them.
#
# Labels: they apply when records are served, never in the index. A report is kept when thimble.kept_unit holds for its
# catalog row and its source row, and an episode stays while it keeps a report.
#
# Colour: the page's Colour by choice (thimble.colourBy; its colour.query() comes with each fetch as `colour`) gives
# each report one value: its confidence, broad_class, disposition, source_basis or cohort ("external cohort" when its
# why_included names the external cohort), or a label's value on its catalog row or source row (thimble.colour_value).
# A report whose value's chip is off is left out of every count but `cv`, each episode's kept reports per value, which
# the page sums for the chips and draws as the episode's mix and dot.
import csv
import json
import re
from datetime import datetime, timezone

import thimble

REPORTS, SOURCES = "all-reports.csv", "report-sources.csv"
PROVENANCE, SUPPLEMENT, OVERRIDES = "selection-provenance.csv", "supplement-classifications.json", "classification-overrides.json"
REPORT_COLUMNS = ("report_id", "report_url", "report_date_utc", "timestamp_precision", "disposition", "confidence",
                  "broad_class", "why_included", "caveat")
SOURCE_COLUMNS = ("report_id", "report_date_utc", "data_source", "source_basis", "matched_sources")
PROVENANCE_COLUMNS = ("report_id", "source_batch", "group", "source", "record_kind", "selection_basis", "description")
GAP = 7200  # seconds between two reports of a source that start a new episode
COHORT = "externally selected research-activity cohort"
CLASSES = ("source_request", "indirection", "custom_program")
GROUP_OF = {"review_required": "Needs review", "background": "Background control"}  # groups of reports with no source
NO_SOURCE = "No source row"  # an included report that report-sources.csv does not name
UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
ISO = re.compile(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ")
SHAPE = 24  # equal slices of an episode's span its rate is counted in
UNIT_REFS = 200  # refs a unit's citation carries, as many as thimble reads a unit's marks from
MONTHS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")
# why_included is a few stock sentences; the short form keeps what tells one report from another
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
    """Whole seconds since 1970 of an ISO 8601 time in UTC, or None."""
    s = (s or "").strip()
    if not ISO.fullmatch(s):
        return None
    try:
        return int(datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc).timestamp())
    except ValueError:
        return None


def _iso(t):
    return datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _when(t):
    d = datetime.fromtimestamp(t, timezone.utc)
    return f"{d.day} {MONTHS[d.month - 1]} {d.year} {d:%H:%M}"


def _slug(name):
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-") or "source"


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


# ---------------------------------------------------------------- reading the files


def _lines(path):
    """(the byte offset of every line, [(line number, text)]) of a file read whole."""
    with open(path, "rb") as fh:
        data = fh.read()
    offs, out, pos, n = [], [], 0, 0
    for raw in data.splitlines(keepends=True):
        n += 1
        offs.append(pos)
        pos += len(raw)
        out.append((n, raw.decode("utf-8", "replace").rstrip("\r\n")))
    return offs, out


def _cells(text):
    """The cells of one CSV line, or None when it does not parse whole."""
    try:
        rows = list(csv.reader([text], strict=True))
    except csv.Error:
        return None
    return rows[0] if len(rows) == 1 else None


def _csv(path, columns, ctx):
    """(offsets, [(line, {column: cell})]) of a CSV file whose header names `columns`; a row that does not parse, or
    whose cells do not match the header, is a problem."""
    try:
        offs, lines = _lines(path)
    except OSError as e:
        ctx["problems"].append({"ref": f"{path}#L1", "why": f"cannot be read ({type(e).__name__})"})
        return [], []
    if not lines:
        return offs, []
    header = _cells(lines[0][1])
    if header is None or [h.strip() for h in header] != list(columns):
        ctx["problems"].append({"ref": f"{path}#L1", "why": "the header does not name the columns " + ", ".join(columns)})
        return offs, []
    rows = []
    for n, text in lines[1:]:
        if not text.strip():
            continue
        cells = _cells(text)
        if cells is None:
            ctx["problems"].append({"ref": f"{path}#L{n}", "why": "not a whole CSV row (an unclosed quote: the line may be cut short)"})
        elif len(cells) != len(columns):
            ctx["problems"].append({"ref": f"{path}#L{n}", "why": f"{len(cells)} cells where the header names {len(columns)} (the line may be cut short)"})
        elif not UUID.fullmatch(cells[0].strip()):
            ctx["problems"].append({"ref": f"{path}#L{n}", "why": "report_id is no report id"})
        else:
            rows.append((n, dict(zip(columns, (c.strip() for c in cells), strict=True))))
    return offs, rows


def _decisions(path, ctx):
    """[(index, first line, last line, decision)] of a JSON file's `decisions` array, read one decision at a time, so a
    torn file keeps the decisions before the tear, which is a problem; and the document's other top-level keys."""
    try:
        with open(path, "rb") as fh:
            text = fh.read().decode("utf-8", "replace")
    except OSError as e:
        ctx["problems"].append({"ref": f"{path}#L1", "why": f"cannot be read ({type(e).__name__})"})
        return [], {}
    line_of = lambda pos: text.count("\n", 0, pos) + 1  # noqa: E731
    try:
        doc = json.loads(text)
        whole = True
    except ValueError as e:
        doc, whole = None, False
        ctx["problems"].append({"ref": f"{path}#L{line_of(getattr(e, 'pos', 0) or 0)}",
                                "why": "not valid JSON (the file may be cut short): the decisions before this line are read"})
    meta = {k: v for k, v in doc.items() if k != "decisions"} if isinstance(doc, dict) else {}
    m = re.search(r'"decisions"\s*:\s*\[', text)
    if not m:
        if whole:
            ctx["problems"].append({"ref": f"{path}#L1", "why": "no decisions array"})
        return [], meta
    dec, pos, out, gap = json.JSONDecoder(), m.end(), [], re.compile(r"[\s,]*")
    while True:
        pos = gap.match(text, pos).end()
        if pos >= len(text) or text[pos] == "]":
            break
        try:
            item, end = dec.raw_decode(text, pos)
        except ValueError:
            if whole:
                ctx["problems"].append({"ref": f"{path}#L{line_of(pos)}", "why": "a decision that does not parse"})
            break
        k = len(out)
        if not isinstance(item, dict) or not UUID.fullmatch(str(item.get("report_id", "")).strip()):
            ctx["problems"].append({"ref": f"{path}#/decisions/{k}", "why": "a decision with no report_id"})
        out.append((k, line_of(pos), line_of(end - 1), item))
        pos = end
    return out, meta


# ---------------------------------------------------------------- the index


def build_index(paths):
    """{"files": {name: path}, "ids", "t", "ar" (catalog line, 0 for none), "rs" (source line, 0 for none), "disp",
    "conf", "cls", "src", "basis" (each an index into names[field]), "cohort" (0/1), "why" (an index into whys),
    "group" (an index into groups), "ep" (each report's episode): one entry per report; "episodes": [{key, g, start,
    end, rows}] with rows in time order; "groups": [name], "group_key": [key], "offsets": {file: [byte offset of line
    n at n-1]}, "provenance", "supplement", "overrides": {report_id: record and its place}, "problems", "unplaced"}."""
    files = {}
    for p in paths:
        name = p.rsplit("/", 1)[-1]
        if name in (REPORTS, SOURCES, PROVENANCE, SUPPLEMENT, OVERRIDES):
            files[name] = p
    ctx = {"problems": [], "unplaced": []}
    offsets = {}
    thimble.progress(0, 5, "Reading the catalog")
    cat_rows = []
    if REPORTS in files:
        offsets[REPORTS], cat_rows = _csv(files[REPORTS], REPORT_COLUMNS, ctx)
    thimble.progress(1, 5, "Reading the source table")
    src_rows = []
    if SOURCES in files:
        offsets[SOURCES], src_rows = _csv(files[SOURCES], SOURCE_COLUMNS, ctx)
    thimble.progress(2, 5, "Reading provenance and decisions")
    prov_rows = []
    if PROVENANCE in files:
        offsets[PROVENANCE], prov_rows = _csv(files[PROVENANCE], PROVENANCE_COLUMNS, ctx)
    supp, supp_meta = _decisions(files[SUPPLEMENT], ctx) if SUPPLEMENT in files else ([], {})
    over, over_meta = _decisions(files[OVERRIDES], ctx) if OVERRIDES in files else ([], {})

    names = {f: [""] for f in ("disp", "conf", "cls", "src", "basis")}
    at = {f: {"": 0} for f in names}

    def code(f, v):
        if v not in at[f]:
            at[f][v] = len(names[f])
            names[f].append(v)
        return at[f][v]

    for v in ("included", "review_required", "background"):
        code("disp", v)
    for v in ("significant", "suggestive"):
        code("conf", v)
    for v in CLASSES:
        code("cls", v)
    whys, why_at = [""], {"": 0}
    ids, t, ar, rs, disp, conf, cls, src, basis, cohort, why, matched = ([] for _ in range(12))
    by_id = {}
    path = files.get(REPORTS, REPORTS)
    for n, r in cat_rows:
        rid = r["report_id"]
        when = _epoch(r["report_date_utc"])
        if rid in by_id:
            ctx["problems"].append({"ref": f"{path}#L{n}", "why": f"report_id seen before, on line {ar[by_id[rid]]}"})
            continue
        if when is None:
            ctx["problems"].append({"ref": f"{path}#L{n}", "why": "no report_date_utc the reader can read"})
            continue
        if r["disposition"] not in at["disp"]:
            ctx["problems"].append({"ref": f"{path}#L{n}", "why": f"a disposition the catalog does not use: {r['disposition'][:40]}"})
        w = r["why_included"]
        if w not in why_at:
            why_at[w] = len(whys)
            whys.append(w)
        by_id[rid] = len(ids)
        ids.append(rid)
        t.append(when)
        ar.append(n)
        rs.append(0)
        disp.append(code("disp", r["disposition"]))
        conf.append(code("conf", r["confidence"]))
        cls.append(code("cls", r["broad_class"]))
        src.append(0)
        basis.append(0)
        matched.append("")
        cohort.append(1 if COHORT in w else 0)
        why.append(why_at[w])
    # the source table: a row names a data source and the sources it matched, each of which is a data source the table
    # names (a cut cell names none)
    known = {r["data_source"] for _, r in src_rows if r["data_source"]}
    path = files.get(SOURCES, SOURCES)
    for n, r in src_rows:
        rid = r["report_id"]
        parts = [x.strip() for x in r["matched_sources"].split(";") if x.strip()]
        if not r["data_source"] or any(x not in known for x in parts):
            ctx["problems"].append({"ref": f"{path}#L{n}", "why": "matched_sources names no data source of the table (the line may be cut short)"
                                    if r["data_source"] else "no data_source"})
            continue
        when = _epoch(r["report_date_utc"])
        i = by_id.get(rid)
        if i is not None and rs[i]:
            ctx["problems"].append({"ref": f"{path}#L{n}", "why": f"report_id seen before, on line {rs[i]}"})
            continue
        if i is None:
            if when is None:
                ctx["problems"].append({"ref": f"{path}#L{n}", "why": "no report_date_utc the reader can read"})
                continue
            # a report the catalog does not hold: still a report, its catalog cells blank
            by_id[rid] = i = len(ids)
            ids.append(rid)
            t.append(when)
            ar.append(0)
            rs.append(0)
            disp.append(at["disp"]["included"])
            conf.append(0)
            cls.append(0)
            src.append(0)
            basis.append(0)
            matched.append("")
            cohort.append(0)
            why.append(0)
        elif when is not None and when != t[i]:
            ctx["problems"].append({"ref": f"{path}#L{n}", "why": f"report_date_utc differs from {REPORTS} line {ar[i]}, whose time the view uses"})
        rs[i] = n
        src[i] = code("src", r["data_source"])
        basis[i] = code("basis", r["source_basis"])
        matched[i] = r["matched_sources"]
    thimble.progress(3, 5, "Finding the episodes")
    # groups: every data source, then the dispositions of reports with no source row
    groups, gat = [], {}

    def group_of(i):
        if src[i]:
            g = names["src"][src[i]]
        else:
            g = GROUP_OF.get(names["disp"][disp[i]], NO_SOURCE)
        if g not in gat:
            gat[g] = len(groups)
            groups.append(g)
        return gat[g]

    group = [group_of(i) for i in range(len(ids))]
    members = {}
    for i in sorted(range(len(ids)), key=lambda i: (t[i], ar[i] or 10 ** 9, rs[i])):
        members.setdefault(group[i], []).append(i)
    episodes, ep = [], [0] * len(ids)
    keys = {}
    used = set()
    for g in range(len(groups)):
        k = _slug(groups[g])
        while k in used:
            k += "-x"
        used.add(k)
        keys[g] = k
    for g, rows in members.items():
        cur = [rows[0]]
        for a, b in zip(rows, rows[1:], strict=False):
            if t[b] - t[a] >= GAP:
                episodes.append(cur)
                cur = [b]
            else:
                cur.append(b)
        episodes.append(cur)
    episodes.sort(key=lambda rows: (t[rows[0]], group[rows[0]]))
    eps = []
    for e, rows in enumerate(episodes):
        g = group[rows[0]]
        for i in rows:
            ep[i] = e
        eps.append({"key": f"{keys[g]}/{_iso(t[rows[0]])}", "g": g, "start": t[rows[0]], "end": t[rows[-1]], "rows": rows})
    thimble.progress(4, 5, "Joining provenance and decisions")
    provenance, supplement, overrides = {}, {}, {}
    path = files.get(PROVENANCE, PROVENANCE)
    for n, r in prov_rows:
        if r["report_id"] not in by_id:
            ctx["unplaced"].append({"ref": f"{path}#row={n - 1}", "why": "its report_id is no report of the catalog or the source table"})
            continue
        provenance[r["report_id"]] = {"line": n, "record": r}
    for store, found, name in ((supplement, supp, SUPPLEMENT), (overrides, over, OVERRIDES)):
        for k, a, b, d in found:
            rid = str(d.get("report_id", "")).strip() if isinstance(d, dict) else ""
            if not rid:
                continue
            if rid not in by_id:
                ctx["unplaced"].append({"ref": f"{name}#/decisions/{k}", "why": "its report_id is no report of the catalog or the source table"})
                continue
            store[rid] = {"k": k, "lines": [a, b], "record": d}
    thimble.progress(5, 5, "Done")
    return {"files": files, "ids": ids, "t": t, "ar": ar, "rs": rs, "disp": disp, "conf": conf, "cls": cls, "src": src,
            "basis": basis, "matched": matched, "cohort": cohort, "why": why, "whys": whys, "group": group, "ep": ep,
            "names": names, "groups": groups, "group_key": [keys[g] for g in range(len(groups))], "episodes": eps,
            "ep_at": {e["key"]: k for k, e in enumerate(eps)}, "offsets": offsets,
            "ar_at": {n: i for i, n in enumerate(ar) if n}, "rs_at": {n: i for i, n in enumerate(rs) if n},
            "prov_at": {p["line"]: by_id[rid] for rid, p in provenance.items()}, "provenance": provenance,
            "supplement": supplement, "overrides": overrides,
            "meta": {SUPPLEMENT: supp_meta, OVERRIDES: over_meta}, "problems": ctx["problems"], "unplaced": ctx["unplaced"]}


# ---------------------------------------------------------------- refs and labels


def _path(index, name):
    return index["files"].get(name, name)


def _ref(index, i):
    """The report's citation: its catalog row, else its source row."""
    if index["ar"][i]:
        return f"{_path(index, REPORTS)}#row={index['ar'][i] - 1}"
    return f"{_path(index, SOURCES)}#row={index['rs'][i] - 1}"


def _refs(index, i):
    out = []
    if index["ar"][i]:
        out.append(f"{_path(index, REPORTS)}#row={index['ar'][i] - 1}")
    if index["rs"][i]:
        out.append(f"{_path(index, SOURCES)}#row={index['rs'][i] - 1}")
    return out


COLOUR_FIELDS = ("confidence", "broad_class", "disposition", "source_basis", "cohort")


def _colour_record(index, i):
    """The report's values of the fields the page colours by, as colour_value reads them."""
    names = index["names"]
    return {"confidence": names["conf"][index["conf"][i]], "broad_class": names["cls"][index["cls"][i]],
            "disposition": names["disp"][index["disp"][i]], "source_basis": names["basis"][index["basis"][i]],
            "cohort": "external cohort" if index["cohort"][i] else ""}


def _colour_value(index, choice, i):
    """The report's value under the Colour by choice: a field's, or a label's on its catalog row, else its source row;
    None for none."""
    if not isinstance(choice, dict):
        return None
    rec = _colour_record(index, i)
    if choice.get("label") is None:
        return thimble.colour_value(choice, None, rec)
    for ref in _refs(index, i):
        v = thimble.colour_value(choice, ref, rec)
        if v is not None:
            return v
    return None


class _Labels:
    """The label filter, read once per answer: which reports it keeps."""

    def __init__(self, index):
        on = thimble.view_labels()
        self.index = index
        self.filter = on.get("filter")
        self._kept = {}

    def kept(self, i):
        if not self.filter:
            return True
        if i not in self._kept:
            self._kept[i] = thimble.kept_unit(_refs(self.index, i))
        return self._kept[i]


# ---------------------------------------------------------------- answers


def _overview(index, choice=None, lead=None):
    """One row per episode that keeps a report, as columns: `key`, `g` (an index into `groups`), `start` and `end`
    (seconds since 1970 of its first and last report), `kn` (the reports the label filter keeps), `cv` (those reports
    per value of the Colour by choice, '' for none), and over the kept reports whose value is on: `n` (how many), `all`
    (every report), `sr`, `ind`, `cp` (per broad_class), `sig` (significant), `coh` (of the external cohort), `pm` (the
    most in one clock minute), `rate` (in each of SHAPE equal slices of its span) and `rl` (those whose value is `lead`,
    the value the page draws over the rate, or None). Also `groups` with their unit `keys` and `disp`."""
    lab = _Labels(index)
    cls, conf, cohort = index["cls"], index["conf"], index["cohort"]
    names = index["names"]
    c_sr, c_in, c_cp = (names["cls"].index(c) for c in CLASSES)
    sig = names["conf"].index("significant")
    cols = {k: [] for k in ("key", "g", "start", "end", "kn", "cv", "n", "all", "sr", "ind", "cp", "sig", "coh", "pm",
                            "rate", "rl")}
    t = index["t"]
    lead = None if lead in (None, "") else str(lead)
    total = len(index["episodes"])
    for e, ep in enumerate(index["episodes"]):
        if e % 100 == 0:
            thimble.progress(e, total, "Counting the episodes")
        kn = n = sr = ind = cp = s = coh = 0
        cv = {}
        times, led = [], []
        for i in ep["rows"]:
            if not lab.kept(i):
                continue
            kn += 1
            v = _colour_value(index, choice, i)
            key = "" if v is None else v
            cv[key] = cv.get(key, 0) + 1
            if not thimble.colour_on(choice, v):
                continue
            n += 1
            times.append(t[i])
            if lead is not None and v == lead:
                led.append(t[i])
            c = cls[i]
            sr += c == c_sr
            ind += c == c_in
            cp += c == c_cp
            s += conf[i] == sig
            coh += cohort[i]
        if not kn:
            continue
        for k, v in zip(cols, (ep["key"], ep["g"], ep["start"], ep["end"], kn, cv, n, len(ep["rows"]), sr, ind, cp, s,
                               coh, _peak(times, 60), _slices(times, ep), _slices(led, ep) if led else None),
                        strict=True):
            cols[k].append(v)
    disp = []
    for g in range(len(index["groups"])):
        name = index["groups"][g]
        disp.append("review_required" if name == GROUP_OF["review_required"] else
                    "background" if name == GROUP_OF["background"] else "included")
    return {"episodes": cols, "groups": index["groups"], "keys": index["group_key"], "disp": disp,
            "filtered": bool(lab.filter), "reports": len(index["ids"])}


def _slices(times, ep):
    """How many of these times fall in each of SHAPE equal slices of the episode's span."""
    out, span = [0] * SHAPE, ep["end"] - ep["start"]
    for x in times:
        out[min(SHAPE - 1, (x - ep["start"]) * SHAPE // span) if span else 0] += 1
    return out


def _read_lines(index, name, lines):
    """{line: text} of the wanted lines of one CSV file, read back from their byte offsets."""
    out, offs = {}, index["offsets"].get(name)
    if not offs or name not in index["files"]:
        return out
    with open(index["files"][name], "rb") as fh:
        for n in sorted(set(lines)):
            if 1 <= n <= len(offs):
                fh.seek(offs[n - 1])
                out[n] = fh.readline().decode("utf-8", "replace").rstrip("\r\n")
    return out


def _row_cells(index, name, columns, text):
    cells = _cells(text) if text is not None else None
    return dict(zip(columns, cells, strict=True)) if cells and len(cells) == len(columns) else {}


def _report_row(index, i, cells, prev_t, value):
    """One report of an episode's list: the catalog cells it shows as the file holds them, and what the reader made,
    with its value under the Colour by choice."""
    r = {"i": i, "ref": _ref(index, i), "report_id": index["ids"][i], "t": index["t"][i],
         "gap": None if prev_t is None else index["t"][i] - prev_t}
    if cells:
        r.update(report_date_utc=cells["report_date_utc"], broad_class=cells["broad_class"],
                 confidence=cells["confidence"], disposition=cells["disposition"], report_url=cells["report_url"],
                 why_short=short_why(cells["why_included"]))
    if index["cohort"][i]:
        r["cohort"] = True
    if value is not None:
        r["value"] = value
    return r


def _episode(index, key, keep=None, choice=None):
    """An episode's kept reports whose value under the Colour by choice is on, in time order (each _report_row, the
    report `keep` kept whatever the filters), its group and span."""
    e = index["ep_at"].get(str(key or ""))
    if e is None:
        return None
    ep = index["episodes"][e]
    lab = _Labels(index)
    rows, values = [], {}
    for i in ep["rows"]:
        if i != keep and not lab.kept(i):
            continue
        v = _colour_value(index, choice, i)
        if i != keep and not thimble.colour_on(choice, v):
            continue
        rows.append(i)
        values[i] = v
    texts = _read_lines(index, REPORTS, [index["ar"][i] for i in rows if index["ar"][i]])
    out, prev = [], None
    for i in rows:
        cells = _row_cells(index, REPORTS, REPORT_COLUMNS, texts.get(index["ar"][i]))
        out.append(_report_row(index, i, cells, prev, values[i]))
        prev = index["t"][i]
    times = [index["t"][i] for i in rows]
    return {"key": ep["key"], "group": index["groups"][ep["g"]], "start": ep["start"], "end": ep["end"],
            "all": len(ep["rows"]), "peak_minute": _peak(times, 60), "peak_hour": _peak(times, 3600), "rows": out}


def _peak(times, width):
    """The most of these times that fall in one clock interval of `width` seconds in UTC, as the page's rate chart bins
    them: a clock minute for 60, a clock hour for 3600."""
    per = {}
    for t in times:
        per[t // width] = per.get(t // width, 0) + 1
    return max(per.values(), default=0)


def _report(index, i):
    """One report in full: every cell of its catalog row and of its source row as the files hold them, and its
    provenance row, supplemental decision and confidence override when its report_id has them, each with its ref."""
    if not isinstance(i, int) or isinstance(i, bool) or not 0 <= i < len(index["ids"]):
        return None
    rid = index["ids"][i]
    out = {"i": i, "ref": _ref(index, i), "report_id": rid, "t": index["t"][i],
           "episode_key": index["episodes"][index["ep"][i]]["key"], "group": index["groups"][index["group"][i]]}
    if index["ar"][i]:
        text = _read_lines(index, REPORTS, [index["ar"][i]]).get(index["ar"][i])
        out["catalog"] = {"ref": f"{_path(index, REPORTS)}#row={index['ar'][i] - 1}",
                          "record": _row_cells(index, REPORTS, REPORT_COLUMNS, text)}
    if index["rs"][i]:
        text = _read_lines(index, SOURCES, [index["rs"][i]]).get(index["rs"][i])
        out["source"] = {"ref": f"{_path(index, SOURCES)}#row={index['rs'][i] - 1}",
                         "record": _row_cells(index, SOURCES, SOURCE_COLUMNS, text)}
    p = index["provenance"].get(rid)
    if p:
        out["provenance"] = {"ref": f"{_path(index, PROVENANCE)}#row={p['line'] - 1}", "record": p["record"]}
    for name, key in ((SUPPLEMENT, "supplement"), (OVERRIDES, "override")):
        d = index["supplement" if key == "supplement" else "overrides"].get(rid)
        if d:
            out[key] = {"ref": f"{_path(index, name)}#/decisions/{d['k']}", "record": d["record"]}
    return out


def records(index, query):
    """{op: overview, colour?, lead?}: one row per episode (_overview). {op: episode, key, keep?, colour?}: an episode's
    reports in time order, the report `keep` kept whatever the filters. {op: report, i}: one report in full. `colour` is
    the page's Colour by choice (colour.query())."""
    query = query or {}
    op = query.get("op")
    choice = query.get("colour") if isinstance(query.get("colour"), dict) else None
    if op == "episode":
        keep = query.get("keep")
        return _episode(index, query.get("key"), keep if isinstance(keep, int) and not isinstance(keep, bool) else None,
                        choice)
    if op == "report":
        return _report(index, query.get("i"))
    return _overview(index, choice, query.get("lead"))


# ---------------------------------------------------------------- citations
# An excerpt quotes cells of the records it cites, one cell a line, as the files hold them.

EXCERPT_CELLS = {
    REPORTS: ("report_date_utc", "broad_class", "confidence", "why_included"),
    SOURCES: ("data_source", "source_basis", "matched_sources", "report_date_utc"),
    PROVENANCE: ("description", "group", "record_kind", "selection_basis"),
    SUPPLEMENT: ("reason", "basis", "confidence", "broad_class"),
    OVERRIDES: ("reason", "previous_confidence", "confidence", "basis"),
}
COLUMNS_OF = {REPORTS: REPORT_COLUMNS, SOURCES: SOURCE_COLUMNS, PROVENANCE: PROVENANCE_COLUMNS}
EXCERPT_REFS = 30  # the cited reports whose cells a unit's excerpt may quote


def _quote(record, name):
    """The cells of a record an excerpt quotes, one a line, each once."""
    out = []
    for k in EXCERPT_CELLS[name]:
        v = record.get(k) if isinstance(record, dict) else None
        v = v.strip() if isinstance(v, str) else ""
        if v and v not in out:
            out.append(v)
    return out


def _catalog_cells(index, rows):
    """{report: its catalog row's cells} of the reports that have a catalog row."""
    texts = _read_lines(index, REPORTS, [index["ar"][i] for i in rows if index["ar"][i]])
    return {i: _row_cells(index, REPORTS, REPORT_COLUMNS, texts.get(index["ar"][i])) for i in rows if index["ar"][i]}


def _unit_excerpt(index, rows, lead=()):
    """The first report's time and the classes and why_included texts of the first cited reports."""
    got = _catalog_cells(index, rows[:EXCERPT_REFS])
    lines = list(lead)
    first = got.get(rows[0]) if rows else None
    if first and first.get("report_date_utc"):
        lines.append(first["report_date_utc"])
    for field, most in (("broad_class", 3), ("why_included", 3)):
        seen = []
        for i in rows[:EXCERPT_REFS]:
            v = (got.get(i) or {}).get(field, "").strip()
            if v and v not in seen and len(seen) < most:
                seen.append(v)
        lines += seen
    return "\n".join(dict.fromkeys(lines))


def _episode_label(index, ep):
    n = len(ep["rows"])
    return f"{index['groups'][ep['g']]} · {_when(ep['start'])} · {n:,} report{'s' if n != 1 else ''}"


def _unit(index, ep):
    rows = ep["rows"]
    return {"excerpt": _unit_excerpt(index, rows), "label": _episode_label(index, ep),
            "refs": [_ref(index, i) for i in rows[:UNIT_REFS]], "key": ep["key"], "target": {"episode": ep["key"]}}


def _group(index, g, key):
    eps = [ep for ep in index["episodes"] if ep["g"] == g]
    rows = []
    for ep in eps:
        rows.extend(ep["rows"][:UNIT_REFS - len(rows)])
        if len(rows) >= UNIT_REFS:
            break
    if not rows:
        return None
    n = sum(len(ep["rows"]) for ep in eps)
    first = rows[0]
    refs, lead = [], []
    if index["rs"][first]:
        # the source row names the data source, which the excerpt quotes
        refs.append(f"{_path(index, SOURCES)}#row={index['rs'][first] - 1}")
        text = _read_lines(index, SOURCES, [index["rs"][first]]).get(index["rs"][first])
        cell = _row_cells(index, SOURCES, SOURCE_COLUMNS, text).get("data_source")
        if cell:
            lead.append(cell)
    elif index["disp"][first]:
        lead.append(index["names"]["disp"][index["disp"][first]])
    refs += [_ref(index, i) for i in rows[:UNIT_REFS - len(refs)]]
    return {"excerpt": _unit_excerpt(index, rows[:EXCERPT_REFS - len(lead)], lead),
            "label": f"{index['groups'][g]} · {len(eps)} episode{'s' if len(eps) != 1 else ''} · {n:,} reports",
            "refs": refs, "key": key, "target": {"group": index["groups"][g]}}


def _when_short(t):
    d = datetime.fromtimestamp(t, timezone.utc)
    return f"{d.day} {MONTHS[d.month - 1]} {d.year} {d:%H:%M:%S}"


def _place(index, i, ref, excerpt, what=""):
    ep = index["episodes"][index["ep"][i]]
    if not excerpt:
        return None
    return {"excerpt": excerpt, "label": f"{index['groups'][ep['g']]} report{what} · {_when_short(index['t'][i])}",
            "refs": [ref], "key": ep["key"], "target": {"episode": ep["key"], "report": i}}


def resolve(index, locator):
    """view:episode-browser/<source key>/<YYYY-MM-DDTHH:MM:SSZ>: one episode, opened with its reports.
    view:episode-browser/<source key>: every episode of a data source, narrowed to it.
    <all-reports.csv or report-sources.csv>#row=<n> or #L<n>: that report, opened in its episode; selection-provenance.csv
    the same for the report it is about; line 1, the header, opens the whole catalog.
    <decisions file>.json#/decisions/<k> or #L<n>: the report the decision is about, from the decision on that line or the
    nearest one."""
    if "key" in locator:
        key = str(locator["key"])
        e = index["ep_at"].get(key)
        if e is not None:
            return _unit(index, index["episodes"][e])
        if key in index["group_key"]:
            return _group(index, index["group_key"].index(key), key)
        return None
    path, fragment = str(locator.get("path") or ""), str(locator.get("fragment") or "")
    name = path.rsplit("/", 1)[-1]
    if name in COLUMNS_OF:
        m = re.fullmatch(r"L(\d+)|row=(\d+)", fragment)
        if not m:
            return None
        n = int(m.group(1)) if m.group(1) else int(m.group(2)) + 1
        ref = f"{path}#L{n}" if m.group(1) else f"{path}#row={n - 1}"
        text = _read_lines(index, name, [n]).get(n)
        if n == 1:
            if not m.group(1) or not text:
                return None
            return {"excerpt": text, "label": f"the columns of {name}", "refs": [ref], "key": None, "target": {}}
        i = index["prov_at" if name == PROVENANCE else "ar_at" if name == REPORTS else "rs_at"].get(n)
        if i is None or not text:
            return None
        what = "" if name == REPORTS else "'s source row" if name == SOURCES else "'s provenance"
        return _place(index, i, ref, "\n".join(_quote(_row_cells(index, name, COLUMNS_OF[name], text), name)), what)
    if name in (SUPPLEMENT, OVERRIDES):
        store = index["supplement" if name == SUPPLEMENT else "overrides"]
        found = sorted(store.items(), key=lambda kv: kv[1]["k"])
        if not found:
            return None
        m = re.fullmatch(r"/decisions/(\d+)(?:/.*)?", fragment)
        line = re.fullmatch(r"L(\d+)", fragment)
        if m:
            hit = next((kv for kv in found if kv[1]["k"] == int(m.group(1))), None)
            refs = [f"{path}#/decisions/{m.group(1)}"] if hit else []
        elif line:
            n = int(line.group(1))
            hit = next((kv for kv in found if kv[1]["lines"][0] <= n <= kv[1]["lines"][1]), None)
            hit = hit or next((kv for kv in found if kv[1]["lines"][0] > n), found[-1])
            refs = [f"{path}#L{n}", f"{path}#/decisions/{hit[1]['k']}"]
        else:
            return None
        if not hit:
            return None
        rid, d = hit
        out = _place(index, index["ids"].index(rid), refs[0], "\n".join(_quote(d["record"], name)),
                     "'s decision" if name == SUPPLEMENT else "'s confidence change")
        if out:
            out["refs"] = refs
        return out
    return None


def problems(index):
    """The lines that do not parse, each {ref, why}, which thimble shows beside the page."""
    return index["problems"]


def unplaced(index):
    """The provenance rows and decisions whose report_id no report has, each {ref, why}."""
    return index["unplaced"]
