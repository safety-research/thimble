# Incident timeline: a ferry operator's ops log for one day, every source on one time axis.
#
# The data (sample/events.jsonl): one line is one record from one of five sources, which were exported one after
# another, so the file holds the alerts, then the deploys, the chat, the tickets and the agent actions, each in time
# order, and the reader sorts them together.
#   id        the record's id in its source, such as alr-44 or sup-5512
#   at        when it happened, ISO 8601; a time with no zone is read as UTC
#   source    the system it came from: alert, deploy, chat, ticket or agent (an automated agent's action)
#   kind      what happened in that source: fired or resolved, started, finished or rollback, message, opened,
#             updated or closed, and an agent's restart, scale, page, tag, pause, resume, open or close
#   actor     who acted: a person, a customer on a ticket they opened, the monitor, or an agent such as autoheal
#   service   the service it concerns (web, payments, passes, bookings-db), on most records
#   severity  an alert's warning or critical, a ticket's normal, high or urgent; absent elsewhere
#   outcome   how a deploy or an agent action ended: ok, failed or held; absent elsewhere
#   incident  the incident the record belongs to, such as INC-312; absent on records outside any incident
#   re        the id of the record it answers: an alert resolved answers its firing, a ticket update its opening, an
#             agent's restart the alert that set it off; on some records only
#   text      what the record says, as its source wrote it
# Records relate through time, through `re`, and through the fields they share: an incident is every record that
# names it, in time order.
#
# The method: the index keeps every record as a row of small integers (time, file, line, each field's value as an
# index into that field's names, the row `re` points at) in time order, and the byte offset of every line. `records`
# sends the rows the label filter keeps as columns, so the page zooms, filters, groups and compares without asking
# again; text, search and a record's details are read back from the file by seeking to its line.
#
# Labels: they apply when records are served, never in the index. Every answer keeps only the records thimble.kept(ref)
# holds for. `marks` lists the values of the labels that are on, in thimble's order, and each row carries the ones
# thimble.marked(ref) gives it (the first as `m`, all of them as bits in `mb`), which the page draws in the labels'
# colours in its charts and lanes, since thimble cannot see inside them.
import bisect
import json
import re
from datetime import datetime, timezone
from operator import itemgetter

import thimble

TIME = "at"
FIELDS = ("source", "kind", "actor", "service", "severity", "outcome", "incident")  # the fields the page filters by
T, F, L = 0, 1, 2  # a row's time, file and line; the fields' values follow, then RE
RE = 3 + len(FIELDS)  # the row the record answers, or -1
TEXT_MAX = 400  # characters of a record's text a list row gets
NEAR = 4  # records before and after the chosen one, across every source
UNIT_REFS = 200  # refs a unit's citation carries
EXCERPT_RECORDS = 12  # records whose text a unit's excerpt quotes
MARKS_MAX = 24  # label values the page tells apart, as bits of one number per record
MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def _epoch(t):
    """The time as whole seconds since 1970, or None when it does not parse."""
    try:
        dt = datetime.fromisoformat(str(t).replace("Z", "+00:00"))
    except ValueError:
        return None
    return int((dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)).timestamp())


def _iso(epoch):
    return datetime.fromtimestamp(epoch, timezone.utc).strftime("%Y-%m-%dT%H:%M")


def _when(epoch):
    d = datetime.fromtimestamp(epoch, timezone.utc)
    return f"{d.day} {MONTHS[d.month - 1]} {d:%H:%M}"


def _text(r, field):
    v = r.get(field)
    return v if isinstance(v, str) else ("" if v is None else str(v))


def build_index(paths):
    """{"rows": [[epoch, file, line, *field values, re row]] in time order, "files": [path], "names": {field: [name]}
    (index 0 is "", a record without the field), "offsets": [[byte offset of line n at n-1] per file], "row_of":
    {"file#line": row}, "answered": {row: [rows that answer it]}, "units": {incident: [first row, last row]}}. A line
    with no time is in `offsets` only."""
    files = list(paths)
    names = {f: [""] for f in FIELDS}
    at = {f: {"": 0} for f in FIELDS}
    found, offsets, ids = [], [], {}
    for fi, path in enumerate(files):
        offs = []
        offsets.append(offs)
        with open(path, "rb") as fh:
            pos = 0
            for n, raw in enumerate(fh, 1):
                offs.append(pos)
                pos += len(raw)
                try:
                    r = json.loads(raw)
                except ValueError:
                    continue
                if not isinstance(r, dict) or (t := _epoch(r.get(TIME))) is None:
                    continue
                vals = []
                for f in FIELDS:
                    v = _text(r, f).strip()
                    if v not in at[f]:
                        at[f][v] = len(names[f])
                        names[f].append(v)
                    vals.append(at[f][v])
                found.append([t, fi, n, *vals, _text(r, "re"), _text(r, "id")])
    found.sort(key=lambda x: (x[T], x[F], x[L]))
    for i, x in enumerate(found):
        if x[-1]:
            ids.setdefault((x[F], x[-1]), i)
    rows = [[*x[:RE], ids.get((x[F], x[RE]), -1) if x[RE] else -1] for x in found]
    inc = 3 + FIELDS.index("incident")
    units, answered = {}, {}
    for i, row in enumerate(rows):
        if row[inc]:
            units.setdefault(names["incident"][row[inc]], [i, i])[1] = i
        if row[RE] >= 0:
            answered.setdefault(row[RE], []).append(i)
    return {"rows": rows, "files": files, "names": names, "offsets": offsets,
            "row_of": {f"{files[row[F]]}#{row[L]}": i for i, row in enumerate(rows)}, "answered": answered,
            "units": units}


def _read(index, rows):
    """{row: record} for the wanted rows, each line read at its byte offset."""
    out, by_file = {}, {}
    for i in rows:
        by_file.setdefault(index["rows"][i][F], []).append(i)
    for fi, wanted in by_file.items():
        with open(index["files"][fi], "rb") as fh:
            for i in wanted:
                fh.seek(index["offsets"][fi][index["rows"][i][L] - 1])
                try:
                    r = json.loads(fh.readline())
                except ValueError:
                    continue
                if isinstance(r, dict):
                    out[i] = r
    return out


def _ref(index, i):
    row = index["rows"][i]
    return f"{index['files'][row[F]]}#L{row[L]}"


def _kept(index, i, keep=()):
    return i in keep or thimble.kept(_ref(index, i))


def _overview(index, keep):
    """Every row the filter keeps, and the rows in `keep` (a citation asked for them), as columns: `r` the row, `t`
    seconds since `t0`, `f` and `ln` its file and line, a column per field, `re` the row it answers and `tk` the seconds
    since that row (-1 for none), `m` the index in `marks` of its first mark (-1 for none) and `mb` all its marks as
    bits. `marks` holds every value of the labels that are on, each {label, value, colour}, marking records or not."""
    on = thimble.view_labels()
    rows = index["rows"]
    t0 = rows[0][T] if rows else 0
    cols = {k: [] for k in ("r", "t", "f", "ln", *FIELDS, "re", "tk", "m", "mb")}
    marks = [{"label": lab["name"], "value": v["name"], "colour": v["colour"]}
             for lab in on["labels"] for v in lab["values"]][:MARKS_MAX]
    mark_at = {(x["label"], x["value"]): m for m, x in enumerate(marks)}
    for i, row in enumerate(rows):
        ref = _ref(index, i)
        if on["filter"] and i not in keep and not thimble.kept(ref):
            continue
        first, bits = -1, 0
        for x in thimble.marked(ref) if marks else ():
            m = mark_at.get((x["label"], x["value"]))
            if m is not None:
                first = m if first < 0 else first
                bits |= 1 << m
        took = row[T] - rows[row[RE]][T] if row[RE] >= 0 else -1
        for k, v in zip(cols, (i, row[T] - t0, row[F], row[L], *row[3:RE], row[RE], took, first, bits), strict=True):
            cols[k].append(v)
    return {"t0": t0, "span": [0, rows[-1][T] - t0 if rows else 0], "files": index["files"], "names": index["names"],
            "cols": cols, "marks": marks, "starts": {k: rows[a][T] - t0 for k, (a, _) in index["units"].items()}}


def _strings(r):
    return " ".join(_text(r, k) for k in r if isinstance(r.get(k), (str, int, float))).lower()


def _search(index, q):
    """The kept rows any of whose values holds `q`, ignoring case."""
    q = str(q or "").strip().lower()
    if not q:
        return {"q": q, "rows": []}
    needles = {json.dumps(q)[1:-1], json.dumps(q, ensure_ascii=False)[1:-1]}  # as a line holds it, escaped or not
    hits = []
    for path in index["files"]:
        with open(path, "rb") as fh:
            for n, raw in enumerate(fh, 1):
                line = raw.decode("utf-8", "replace").lower()
                if any(x in line for x in needles) and (i := index["row_of"].get(f"{path}#{n}")) is not None:
                    hits.append(i)
    got = _read(index, hits)
    return {"q": q, "rows": sorted(i for i in hits if i in got and q in _strings(got[i]) and _kept(index, i))}


def _texts(index, rows):
    """[[row, text]] for the wanted rows, each text cut to TEXT_MAX characters."""
    wanted = [i for i in rows if isinstance(i, int) and 0 <= i < len(index["rows"])][:1000]
    got = _read(index, wanted)
    return [[i, _text(got.get(i, {}), "text")[:TEXT_MAX]] for i in wanted]


def _brief(index, i, r):
    row = index["rows"][i]
    return {"r": i, "ref": _ref(index, i), "t": row[T], "source": _text(r, "source"), "kind": _text(r, "kind"),
            "actor": _text(r, "actor"), "text": _text(r, "text")[:TEXT_MAX]}


def _record(index, i, keep):
    """One record in full: its fields, the record it answers, the kept records that answer it, and the NEAR kept
    records before and after it in time across every source."""
    rows = index["rows"]
    if not isinstance(i, int) or not 0 <= i < len(rows):
        return None
    answers = [j for j in index["answered"].get(i, []) if _kept(index, j, keep)]
    before, after = [], []
    j = i - 1
    while j >= 0 and len(before) < NEAR:
        if _kept(index, j, keep):
            before.append(j)
        j -= 1
    j = i + 1
    while j < len(rows) and len(after) < NEAR:
        if _kept(index, j, keep):
            after.append(j)
        j += 1
    near = [*sorted(before), i, *after]
    parent = rows[i][RE]
    got = _read(index, [i, *answers, *near, *([parent] if parent >= 0 else [])])
    rec = got.get(i, {})
    return {"r": i, "ref": _ref(index, i), "t": rows[i][T], "record": rec,
            "answers": _brief(index, parent, got.get(parent, {})) if parent >= 0 else None,
            "answered": [_brief(index, j, got.get(j, {})) for j in answers],
            "near": [_brief(index, j, got.get(j, {})) for j in near]}


def records(index, query):
    """{op: overview, keep?}: every kept row as columns (_overview), `keep` rows kept whatever the filter.
    {op: texts, rows}: the rows' texts. {op: search, q}: the kept rows holding q. {op: record, r, keep?}: one row in
    full with its neighbours (_record)."""
    query = query or {}
    keep = {int(x) for x in query.get("keep") or () if isinstance(x, int)}
    op = query.get("op")
    if op == "texts":
        return {"texts": _texts(index, query.get("rows") or [])}
    if op == "search":
        return _search(index, query.get("q"))
    if op == "record":
        return _record(index, query.get("r"), keep | {query.get("r")})
    return _overview(index, keep)


def _unit(index, found, label, key, target):
    """A unit's answer: the excerpt quotes the first records' texts, and the refs cite every record in time order."""
    got = _read(index, found[:EXCERPT_RECORDS])
    lines = [_text(got[i], "text") for i in found[:EXCERPT_RECORDS] if i in got and _text(got[i], "text")]
    return {"excerpt": "\n".join(lines), "label": label, "refs": [_ref(index, i) for i in found[:UNIT_REFS]],
            "key": key, "target": target}


def resolve(index, locator):
    """events.jsonl#L<n>: the record, chosen in the time around it. view:<slug>/<incident>: every record of the
    incident, filtered to it. view:<slug>/<from>..<to>: the records between two UTC times, zoomed to them."""
    rows = index["rows"]
    if "key" in locator:
        key = str(locator["key"])
        if key in index["units"]:
            inc = index["names"]["incident"].index(key)
            col = 3 + FIELDS.index("incident")
            a, b = index["units"][key]
            found = [i for i in range(a, b + 1) if rows[i][col] == inc]
            return _unit(index, found, f"{key} · {len(found)} records", key, {"incident": key})
        m = re.fullmatch(r"(\d{4}-\d\d-\d\dT\d\d:\d\d)\.\.(\d{4}-\d\d-\d\dT\d\d:\d\d)", key)
        if not m or (a := _epoch(m.group(1))) is None or (b := _epoch(m.group(2))) is None or b <= a:
            return None
        found = list(range(bisect.bisect_left(rows, a, key=itemgetter(T)),
                           bisect.bisect_left(rows, b, key=itemgetter(T))))
        if not found:
            return None
        span = f"{_when(a)} to {_when(b)[-5:]}" if _when(a)[:-5] == _when(b)[:-5] else f"{_when(a)} to {_when(b)}"
        return _unit(index, found, f"{span} · {len(found)} records", key, {"from": _iso(a), "to": _iso(b)})
    path, fragment = locator.get("path"), str(locator.get("fragment") or "")
    m = re.fullmatch(r"L(\d+)", fragment)
    i = index["row_of"].get(f"{path}#{m.group(1)}") if m else None
    if i is None:
        return None
    r = _read(index, [i]).get(i, {})
    text = _text(r, "text") or _text(r, "kind")
    if not text:
        return None
    inc = _text(r, "incident") or None
    return {"excerpt": text, "label": f"{_text(r, 'actor') or _text(r, 'source')} · {_when(rows[i][T])}",
            "refs": [_ref(index, i)], "key": inc if inc in index["units"] else None, "target": {"r": i}}
