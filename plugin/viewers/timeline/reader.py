# Activity by ten minutes: a server's call log as a timeline. Each line of events.jsonl is one call an agent made, with
# its `ts`, the `agent`, the `action` (such as pr.claim or git.push, whose part before the dot is the call's kind) and
# its `params`. The index keeps each call's line, window and kind, so the chart's counts come from the index and a
# window's calls are read back by line.
import json
import re
from datetime import datetime, timezone

WINDOW_MINUTES = 10  # one bar of the chart; a log that spans days reads better per hour or per day
WINDOW_CALLS = 200  # calls one window query returns
TEXT_PARAMS = ("status", "title", "reason")  # params whose text says what a call was about


def _epoch(t):
    """The time as seconds since 1970 (a time with no zone taken as UTC), or None when it does not parse."""
    try:
        dt = datetime.fromisoformat(str(t).replace("Z", "+00:00"))
    except ValueError:
        return None
    return (dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)).timestamp()


def _window(epoch):
    """The window's key: its start in UTC, written YYYY-MM-DDTHH:MM."""
    start = epoch - epoch % (WINDOW_MINUTES * 60)
    return datetime.fromtimestamp(start, timezone.utc).strftime("%Y-%m-%dT%H:%M")


def build_index(paths):
    """{"calls": [[path, line, window, kind, epoch], ...] in time order, "windows": {window: [first, last+1] into calls},
    "line": {"path#Ln": index into calls}, "offsets": {path: [byte offset of line n at n-1]}}. A line with no time that
    parses is in `offsets` but not in `calls`, so it resolves without a window."""
    calls, offsets = [], {}
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
                kind = str(r.get("action") or "other").split(".")[0]
                calls.append([path, n, _window(epoch), kind, epoch])
    calls.sort(key=lambda c: (c[4], c[0], c[1]))
    windows = {}
    for i, c in enumerate(calls):
        span = windows.setdefault(c[2], [i, i + 1])
        span[1] = i + 1
    line = {f"{c[0]}#L{c[1]}": i for i, c in enumerate(calls)}
    return {"calls": calls, "windows": windows, "line": line, "offsets": offsets}


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


def records(index, query):
    """{op: counts} gives [{window, start, kind, n}] for the chart, with start in milliseconds; {op: window, window} the
    window's calls in time order."""
    query = query or {}
    if query.get("op") == "window":
        first, end = index["windows"].get(query.get("window"), [0, 0])
        rows = index["calls"][first:end][:WINDOW_CALLS]
        by_file = {}
        for c in rows:
            by_file.setdefault(c[0], []).append(c[1])
        recs = {p: _lines(index, p, ns) for p, ns in by_file.items()}
        items = []
        for p, n, _, kind, _ in rows:
            r = recs[p].get(n, {})
            items.append({"ref": f"{p}#L{n}", "time": str(r.get("ts") or ""), "kind": kind,
                          "action": r.get("action") or "", "agent": r.get("agent") or "", "detail": _detail(r)})
        return {"window": query.get("window"), "total": end - first, "items": items}
    counts = {}
    for _, _, window, kind, _ in index["calls"]:
        counts[(window, kind)] = counts.get((window, kind), 0) + 1
    out = []
    for (window, kind), n in sorted(counts.items()):
        start = datetime.strptime(window, "%Y-%m-%dT%H:%M").replace(tzinfo=timezone.utc).timestamp()
        out.append({"window": window, "start": start * 1000, "kind": kind, "n": n})
    return out


def resolve(index, locator):
    """events.jsonl#L<n>: the call, its excerpt the action, the agent and the text params as the record holds them.
    view:<slug>/<window>: the window, its excerpt the actions called in it, citing its calls in time order."""
    if "key" in locator:
        span = index["windows"].get(locator["key"])
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
                "target": {"window": locator["key"]}}
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
        # a call with no time that parses has no window, so the page shows the chart alone
        return {"excerpt": _excerpt(r), "label": label, "refs": [ref], "key": None, "target": {}}
    c = index["calls"][index["line"][ref]]
    return {"excerpt": _excerpt(r), "label": label, "refs": [ref], "key": c[2], "target": {"window": c[2], "ref": ref}}
