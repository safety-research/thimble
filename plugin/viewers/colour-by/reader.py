# Message board: a team's messages, to show the view kit's Color by (thimble.colorBy) and time range selector
# (thimble.timeRange), and little else.
#
# The data (sample/messages.jsonl): one message per line, {ts, author, channel, text}. ts is ISO 8601 in UTC, or on a few
# lines an older export's "DD/MM/YYYY HH:MM", read as UTC. A line that does not parse whole, such as a message cut
# short, is no record, and problems() lists it.
#
# The records: every message with its line, its time in UTC, its author, channel and text, and its kind, "With links"
# when the text holds a web address and "Text only" when it does not, which the reader works out.
#
# What the page asks (records(index, query)):
#   {"op": "board", "colour": <the page's colour.query()>}
#       the messages the label filter keeps (thimble.kept) in time order, each with its value under the Color by choice (thimble.colour_value), those of a value turned off left out (thimble.colour_on); and
#       the counts of every value for the chips. The page's time range selector draws the messages over time itself.
import json
import re
from collections import Counter
from datetime import datetime, timezone

import thimble

LINK = re.compile(r"https?://\S+")
FIELDS = ("author", "channel", "kind")


def _time(v):
    """seconds since 1970 for an ISO 8601 time or a day-first DD/MM/YYYY HH:MM, both UTC; None for anything else"""
    if not isinstance(v, str):
        return None
    for fmt in ("%Y-%m-%dT%H:%M:%SZ", "%d/%m/%Y %H:%M"):
        try:
            return datetime.strptime(v, fmt).replace(tzinfo=timezone.utc).timestamp()
        except ValueError:
            continue
    return None


def _iso(t):
    return datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def build_index(paths):
    """{rows: [{line, t, author, channel, text, kind}], path, bad: [[line, why]]}, the rows in time order"""
    rows, bad, path = [], [], None
    for p in sorted(paths):
        path = p
        with open(p, encoding="utf-8", errors="replace") as f:
            for n, line in enumerate(f, 1):
                if not line.strip():
                    continue
                try:
                    r = json.loads(line)
                except ValueError:
                    bad.append([n, "the line does not parse as JSON, as when it was cut short"])
                    continue
                t = _time(r.get("ts")) if isinstance(r, dict) else None
                if t is None or not isinstance(r.get("text"), str):
                    bad.append([n, "the message has no time or no text the reader can read"])
                    continue
                rows.append({"line": n, "t": t, "author": str(r.get("author") or ""), "channel": str(r.get("channel") or ""),
                             "text": r["text"], "kind": "With links" if LINK.search(r["text"]) else "Text only"})
    rows.sort(key=lambda r: (r["t"], r["line"]))
    return {"rows": rows, "path": path, "bad": bad}


def _ref(index, r):
    return f"{index['path']}#L{r['line']}"


def _board(index, choice):
    out, counts = [], Counter()
    for r in index["rows"]:
        ref = _ref(index, r)
        if not thimble.kept(ref):
            continue
        value = thimble.colour_value(choice, ref, r)
        counts["" if value is None else value] += 1
        # a value whose chip the analyst turned off leaves the list and the overview, and stays in the chips' counts
        if not thimble.colour_on(choice, value):
            continue
        out.append({"ref": ref, "ts": _iso(r["t"]), "author": r["author"], "channel": r["channel"], "text": r["text"],
                    "kind": r["kind"], "value": value})
    return {"messages": out, "counts": dict(counts)}


def records(index, query):
    query = query or {}
    if query.get("op") == "board":
        return _board(index, query.get("colour"))
    return {"error": f"no such op {query.get('op')!r}"}


def resolve(index, locator):
    """<file>#L<n>: the message on that line, picked in the list"""
    if "key" in locator:
        return None
    m = re.fullmatch(r"L(\d+)", str(locator.get("fragment") or ""))
    if not m or locator.get("path") != index["path"]:
        return None
    n = int(m.group(1))
    r = next((x for x in index["rows"] if x["line"] == n), None)
    if r is None:
        return None
    ref = _ref(index, r)
    return {"excerpt": r["text"], "label": f"{r['author']} · {_iso(r['t'])[:16].replace('T', ' ')}", "refs": [ref],
            "key": None, "target": {"ref": ref}}


def problems(index):
    return [{"ref": f"{index['path']}#L{n}", "why": why} for n, why in index["bad"]]
