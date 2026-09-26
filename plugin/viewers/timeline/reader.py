# Deliveries: a bakery's delivery log as a timeline.
#
# The data (sample/deliveries.jsonl): one line is one delivery, the drop-off at one stop of a van's morning round.
#   at      when the van reached the stop, ISO 8601; a time with no zone is read as UTC
#   route   the van's round, one of a few names (north, river, old town): the category each bar is split by
#   stop    the customer
#   order   what was dropped off, as text
#   status  delivered, left at door, late or refused, as the driver recorded it
#   note    the driver's note, on some deliveries only
# Deliveries relate only through time and route: one van's round on one morning is that route's deliveries that day.
# The lines are in the order the vans synced, not in time order.
#
# The method: every record is counted per time bin and category, the bin chosen from the span, and one bin's records
# are listed below the chart. The index keeps each record's line, time, bin and category, so the counts come from the
# index alone and a bin's records are read back by seeking to their lines.
#
# Labels: they apply when records are served, never in the index. Every count and list keeps only the records
# thimble.kept(ref) holds for, and each bar counts the records the first label that is on marks (thimble.marked), which
# the page draws in the label's colour, since thimble cannot see inside a chart.
import json
import re
from datetime import datetime, timedelta, timezone

import thimble

TIME = "at"  # the field that places a record in time
KIND = "route"  # the field whose value splits each bar

# The chart shows the whole span in at most MAX_BARS bars, so the bin comes from the data: a morning is binned by
# minutes, a week by hours, a year by weeks.
BINS = [60, 300, 600, 1800, 3600, 3 * 3600, 6 * 3600, 86400, 7 * 86400]  # seconds
MAX_BARS = 120
DAY = 86400
BIN_ROWS = 200  # records one bin query returns; the page asks for the next ones


def _bin_seconds(first, last):
    span = max(1, last - first)
    return next((b for b in BINS if span / b <= MAX_BARS), BINS[-1])


def _epoch(t):
    """The time as seconds since 1970, or None when it does not parse."""
    try:
        dt = datetime.fromisoformat(str(t).replace("Z", "+00:00"))
    except ValueError:
        return None
    return (dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)).timestamp()


def _bin_start(epoch, seconds):
    """The start of the bin holding `epoch`: a bin under a week starts at a multiple of its length from midnight, a
    week on its Monday, so bars line up with the ticks a reader expects."""
    if seconds < 7 * DAY:
        return epoch - epoch % seconds
    day = datetime.fromtimestamp(epoch - epoch % DAY, timezone.utc)
    return (day - timedelta(days=day.weekday())).timestamp()


def _bin_key(start, seconds):
    """A bin's key, which is also how a citation names it: YYYY-MM-DDTHH:MM under a day, YYYY-MM-DD for longer bins."""
    fmt = "%Y-%m-%dT%H:%M" if seconds < DAY else "%Y-%m-%d"
    return datetime.fromtimestamp(start, timezone.utc).strftime(fmt)


def build_index(paths):
    """{"rows": [[path, line, bin key, kind, epoch], ...] in time order, "bins": {key: [first, last+1] into rows},
    "starts": {key: start epoch}, "bin": seconds, "first", "last": epochs, "line": {"path#Ln": index into rows},
    "offsets": {path: [byte offset of line n at n-1]}}. A line with no time is in `offsets` only."""
    found, offsets = [], {}
    for path in paths:
        offs = offsets.setdefault(path, [])
        with open(path, "rb") as f:
            pos = 0
            for n, raw in enumerate(f, 1):
                offs.append(pos)
                pos += len(raw)
                try:
                    r = json.loads(raw)
                except ValueError:
                    continue
                if not isinstance(r, dict) or (epoch := _epoch(r.get(TIME))) is None:
                    continue
                found.append((path, n, str(r.get(KIND) or "other"), epoch))
    found.sort(key=lambda x: (x[3], x[0], x[1]))
    first, last = (found[0][3], found[-1][3]) if found else (0.0, 0.0)
    seconds = _bin_seconds(first, last)
    rows, bins, starts = [], {}, {}
    for i, (path, n, kind, epoch) in enumerate(found):
        start = _bin_start(epoch, seconds)
        key = _bin_key(start, seconds)
        starts[key] = start
        rows.append([path, n, key, kind, epoch])
        bins.setdefault(key, [i, i + 1])[1] = i + 1
    line = {f"{r[0]}#L{r[1]}": i for i, r in enumerate(rows)}
    return {"rows": rows, "bins": bins, "starts": starts, "bin": seconds, "first": first, "last": last,
            "line": line, "offsets": offsets}


def _lines(index, path, wanted):
    """{line: record} for the wanted line numbers of one file, each read at its byte offset."""
    out = {}
    with open(path, "rb") as f:
        for n in wanted:
            f.seek(index["offsets"][path][n - 1])
            try:
                out[n] = json.loads(f.readline())
            except ValueError:
                continue
    return out


def _text(r, field):
    v = r.get(field)
    return v if isinstance(v, str) else ""


def _excerpt(r):
    """The delivery's text as the record holds it, one field per line."""
    return "\n".join(x for x in (_text(r, f) for f in ("stop", "order", "status", "note")) if x)


def _counts(index):
    """The chart's rows, one per bin and kind, of the records the filter keeps: {start (ms), key, kind, n, marked},
    `marked` those the first label that is on marks."""
    on = thimble.view_labels()["labels"]
    first = on[0]["name"] if on else None
    counts = {}
    for path, n, key, kind, _ in index["rows"]:
        ref = f"{path}#L{n}"
        if not thimble.kept(ref):
            continue
        c = counts.setdefault((key, kind), [0, 0])
        c[0] += 1
        if first is not None and any(m["label"] == first for m in thimble.marked(ref)):
            c[1] += 1
    return [{"start": index["starts"][key] * 1000, "key": key, "kind": kind, "n": n, "marked": m}
            for (key, kind), (n, m) in sorted(counts.items())]


def _busiest(rows):
    per = {}
    for r in rows:
        per[r["key"]] = per.get(r["key"], 0) + r["n"]
    return max(per, key=lambda k: per[k], default=None)


def records(index, query):
    """{op: counts}: the chart, {bin: {seconds, first, last}, busiest, rows: [{start, key, kind, n, marked}]}, times in
    ms. {op: bin, key, offset?, ref?}: one bin's kept records in time order, BIN_ROWS from `offset`; the record `ref`
    names is listed even when the filter drops it, since a citation asked for it."""
    query = query or {}
    if query.get("op") == "bin":
        first, end = index["bins"].get(query.get("key"), [0, 0])
        cited = query.get("ref")
        kept = [r for r in index["rows"][first:end] if f"{r[0]}#L{r[1]}" == cited or thimble.kept(f"{r[0]}#L{r[1]}")]
        if query.get("offset") is None and cited:
            at = next((i for i, r in enumerate(kept) if f"{r[0]}#L{r[1]}" == cited), 0)
            offset = at - at % BIN_ROWS
        else:
            offset = max(0, int(query.get("offset") or 0))
        page = kept[offset:offset + BIN_ROWS]
        by_file = {}
        for r in page:
            by_file.setdefault(r[0], []).append(r[1])
        read = {p: _lines(index, p, ns) for p, ns in by_file.items()}
        items = []
        for p, n, _, kind, _ in page:
            r = read[p].get(n, {})
            items.append({"ref": f"{p}#L{n}", "time": _text(r, TIME), "kind": kind, "stop": _text(r, "stop"),
                          "order": _text(r, "order"), "status": _text(r, "status"), "note": _text(r, "note")})
        return {"key": query.get("key"), "total": len(kept), "offset": offset, "items": items}
    rows = _counts(index)
    return {"bin": {"seconds": index["bin"], "first": index["first"] * 1000, "last": index["last"] * 1000},
            "busiest": _busiest(rows), "rows": rows}


def resolve(index, locator):
    """deliveries.jsonl#L<n>: the delivery. view:<slug>/<bin>: the bin, its excerpt the stops in it."""
    if "key" in locator:
        span = index["bins"].get(locator["key"])
        if not span:
            return None
        rows = index["rows"][span[0]:span[1]]
        wanted = {}
        for r in rows[:20]:
            wanted.setdefault(r[0], []).append(r[1])
        read = {(p, n): rec for p, ns in wanted.items() for n, rec in _lines(index, p, ns).items()}
        stops = [_text(read[(r[0], r[1])], "stop") for r in rows[:20] if (r[0], r[1]) in read]
        n = len(rows)
        return {"excerpt": "\n".join(dict.fromkeys(s for s in stops if s)),
                "label": f"{locator['key'].replace('T', ' ')} · {n} {'delivery' if n == 1 else 'deliveries'}",
                "refs": [f"{r[0]}#L{r[1]}" for r in rows][:200], "key": locator["key"],
                "target": {"bin": locator["key"]}}
    path, fragment = locator.get("path"), str(locator.get("fragment") or "")
    m = re.fullmatch(r"L(\d+)", fragment)
    if not m or path not in index["offsets"] or not 1 <= int(m.group(1)) <= len(index["offsets"][path]):
        return None
    n, ref = int(m.group(1)), f"{path}#{fragment}"
    r = _lines(index, path, [n]).get(n)
    if not isinstance(r, dict) or not _excerpt(r):
        return None
    label = f"{_text(r, 'stop') or 'delivery'} · {_text(r, TIME).replace('T', ' ')[:16]}".strip(" ·")
    if ref not in index["line"]:
        return {"excerpt": _excerpt(r), "label": label, "refs": [ref], "key": None, "target": {}}
    row = index["rows"][index["line"][ref]]
    return {"excerpt": _excerpt(r), "label": label, "refs": [ref], "key": row[2], "target": {"bin": row[2], "ref": ref}}
