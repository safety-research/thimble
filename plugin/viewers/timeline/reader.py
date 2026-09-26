# Activity: a server's call log as a timeline. Each line of events.jsonl is one call an agent made, with its `ts`, the
# `agent`, the `action` (such as pr.claim or git.push, whose part before the dot is the call's kind) and its `params`.
#
# What the view is for: the analyst sees at a glance when the agents were busy and with what, over the whole log, and
# opens any stretch of it down to the single call. So the chart counts every call per time bin and kind, and one bin's
# calls are listed below it.
#
# How the reader works: the index keeps each call's line, epoch, bin and kind, so the chart's counts come from the
# index alone and a bin's calls are read back by seeking to their lines.
import json
import re
from datetime import datetime, timedelta, timezone

# The chart shows the whole span in at most MAX_BARS bars, so the bin comes from the data, never from a constant: a log
# of one afternoon is binned by minutes, a log of two months by days, and one of several years by weeks. A bin copied
# from another corpus gives thousands of slivers, or a handful of bars with the same tick label under each.
BINS = [60, 300, 600, 1800, 3600, 3 * 3600, 6 * 3600, 86400, 7 * 86400]  # seconds
MAX_BARS = 120
DAY = 86400
BIN_CALLS = 200  # calls one bin query returns; the page asks for the next ones when the analyst wants more
TEXT_PARAMS = ("status", "title", "reason")  # params whose text says what a call was about


def _bin_seconds(first, last):
    span = max(1, last - first)
    return next((b for b in BINS if span / b <= MAX_BARS), BINS[-1])


def _epoch(t):
    """The time as seconds since 1970 (a time with no zone taken as UTC), or None when it does not parse."""
    try:
        dt = datetime.fromisoformat(str(t).replace("Z", "+00:00"))
    except ValueError:
        return None
    return (dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)).timestamp()


def _bin_start(epoch, seconds):
    """The start of the bin holding `epoch`, in UTC: a bin of under a week starts at a multiple of its length from
    midnight, and a week on its Monday, so bins line up with the ticks a reader expects."""
    if seconds < 7 * DAY:
        return epoch - epoch % seconds
    day = datetime.fromtimestamp(epoch - epoch % DAY, timezone.utc)
    return (day - timedelta(days=day.weekday())).timestamp()


def _bin_key(start, seconds):
    """A bin's key, which is also how a citation names it: its start as YYYY-MM-DDTHH:MM for bins under a day, and as
    YYYY-MM-DD for a day or a week, since a longer bin has no time of day."""
    fmt = "%Y-%m-%dT%H:%M" if seconds < DAY else "%Y-%m-%d"
    return datetime.fromtimestamp(start, timezone.utc).strftime(fmt)


def build_index(paths):
    """{"calls": [[path, line, bin key, kind, epoch], ...] in time order, "bins": {key: [first, last+1] into calls},
    "starts": {key: start epoch}, "bin": seconds, "first", "last": epochs, "line": {"path#Ln": index into calls},
    "offsets": {path: [byte offset of line n at n-1]}}. A line with no time that parses is in `offsets` but not in
    `calls`, so it resolves without a bin."""
    rows, offsets = [], {}
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
                if not isinstance(r, dict) or (epoch := _epoch(r.get("ts"))) is None:
                    continue
                rows.append((path, n, str(r.get("action") or "other").split(".")[0], epoch))
    rows.sort(key=lambda c: (c[3], c[0], c[1]))
    first, last = (rows[0][3], rows[-1][3]) if rows else (0.0, 0.0)
    seconds = _bin_seconds(first, last)
    calls, bins, starts = [], {}, {}
    for i, (path, n, kind, epoch) in enumerate(rows):
        start = _bin_start(epoch, seconds)
        key = _bin_key(start, seconds)
        starts[key] = start
        calls.append([path, n, key, kind, epoch])
        bins.setdefault(key, [i, i + 1])[1] = i + 1
    line = {f"{c[0]}#L{c[1]}": i for i, c in enumerate(calls)}
    return {"calls": calls, "bins": bins, "starts": starts, "bin": seconds, "first": first, "last": last,
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


def _params(r):
    return r.get("params") if isinstance(r.get("params"), dict) else {}


def _detail(r):
    """What the call was about, for its row: the pull request or thread it names, else the first text param."""
    p = _params(r)
    if p.get("pr") is not None:
        return f"#{p['pr']}"
    if p.get("thread") is not None:
        return f"thread {p['thread']}"
    return next((str(p[k]) for k in TEXT_PARAMS if isinstance(p.get(k), str) and p[k]), "")


def _excerpt(r):
    """The call's text as the record holds it: the action, the agent and the text params, one per line."""
    p = _params(r)
    return "\n".join([x for x in (r.get("action"), r.get("agent")) if isinstance(x, str) and x]
                     + [p[k] for k in TEXT_PARAMS if isinstance(p.get(k), str) and p[k]])


def _counts(index):
    """The chart's rows, one per bin and kind: {start (ms), key, kind, n}."""
    counts = {}
    for _, _, key, kind, _ in index["calls"]:
        counts[(key, kind)] = counts.get((key, kind), 0) + 1
    return [{"start": index["starts"][key] * 1000, "key": key, "kind": kind, "n": n}
            for (key, kind), n in sorted(counts.items())]


def _busiest(index):
    """The bin with the most calls, which the page lists below the chart when it opens."""
    return max(index["bins"], key=lambda k: index["bins"][k][1] - index["bins"][k][0], default=None)


def records(index, query):
    """{op: counts} gives the chart: {bin: {seconds, first, last}, busiest, rows: [{start, key, kind, n}]}, times in
    milliseconds. {op: bin, key, offset?} gives one bin's calls in time order, BIN_CALLS from `offset`."""
    query = query or {}
    if query.get("op") == "bin":
        first, end = index["bins"].get(query.get("key"), [0, 0])
        offset = max(0, int(query.get("offset") or 0))
        rows = index["calls"][first + offset:end][:BIN_CALLS]
        by_file = {}
        for c in rows:
            by_file.setdefault(c[0], []).append(c[1])
        recs = {p: _lines(index, p, ns) for p, ns in by_file.items()}
        items = []
        for p, n, _, kind, _ in rows:
            r = recs[p].get(n, {})
            items.append({"ref": f"{p}#L{n}", "time": str(r.get("ts") or ""), "kind": kind,
                          "action": r.get("action") or "", "agent": r.get("agent") or "", "detail": _detail(r)})
        return {"key": query.get("key"), "total": end - first, "offset": offset, "items": items}
    return {"bin": {"seconds": index["bin"], "first": index["first"] * 1000, "last": index["last"] * 1000},
            "busiest": _busiest(index), "rows": _counts(index)}


def resolve(index, locator):
    """events.jsonl#L<n>: the call, its excerpt the action, the agent and the text params as the record holds them.
    view:<slug>/<bin>: the bin, its excerpt the actions called in it, citing its calls in time order."""
    if "key" in locator:
        span = index["bins"].get(locator["key"])
        if not span:
            return None
        rows = index["calls"][span[0]:span[1]]
        recs = {}
        for c in rows[:20]:
            recs.setdefault(c[0], []).append(c[1])
        read = {(p, n): r for p, ns in recs.items() for n, r in _lines(index, p, ns).items()}
        actions = [read[(c[0], c[1])].get("action") for c in rows[:20] if (c[0], c[1]) in read]
        excerpt = "\n".join(dict.fromkeys(a for a in actions if isinstance(a, str) and a))
        return {"excerpt": excerpt, "label": f"{locator['key'].replace('T', ' ')} · {len(rows)} calls",
                "refs": [f"{c[0]}#L{c[1]}" for c in rows][:200], "key": locator["key"],
                "target": {"bin": locator["key"]}}
    path, fragment = locator.get("path"), str(locator.get("fragment") or "")
    m = re.fullmatch(r"L(\d+)", fragment)
    if not m or path not in index["offsets"] or not 1 <= int(m.group(1)) <= len(index["offsets"][path]):
        return None
    n, ref = int(m.group(1)), f"{path}#{fragment}"
    r = _lines(index, path, [n]).get(n)
    if not isinstance(r, dict) or not _excerpt(r):
        return None
    label = f"{r.get('action') or 'call'} · {str(r.get('ts') or '').replace('T', ' ')[:16]}".strip(" ·")
    if ref not in index["line"]:
        # a call with no time that parses has no bin, so the page shows the chart alone
        return {"excerpt": _excerpt(r), "label": label, "refs": [ref], "key": None, "target": {}}
    i = index["line"][ref]
    c = index["calls"][i]
    # the page of the bin's calls that holds this one, so a cited call is listed even in a bin of thousands
    at = i - index["bins"][c[2]][0]
    return {"excerpt": _excerpt(r), "label": label, "refs": [ref], "key": c[2],
            "target": {"bin": c[2], "ref": ref, "offset": at - at % BIN_CALLS}}
