"""thimble-cc-mod cards: write a card's data from Python, so every number a card shows comes from code.

    import sys; sys.path.insert(0, "<plugin>/helper"); from tcard import card

    card("bar", "Which agents made the most edits?", rows=[("Agent 3", 412), ("Agent 7", 288)], x="agent", y="edits")
    card("line", "How many edits were made each day?", series={"edits": [("2026-09-01", 41), ...]}, x="day", y="edits")
    card("timeline", "What happened to the pricing page?", events=[("2026-09-01 10:02", "Agent 3 creates it", "events.jsonl#L12")])
    card("table", "Which pages were reverted most?", columns=["page", "reverts", "editors"], rows=[["Pricing", 9, 4]])
    card("example", "How does a revert read?", examples=[{"ref": "revisions.jsonl#L88", "field": "comment", "quote": "rv"}])
    card("diagram", "Who hands work to whom?", nodes=[("a3", "Agent 3", "events.jsonl#L12"), "Agent 7"],
         edges=[("a3", "Agent 7", "assigns pages")])

    by = param("by", "wiki", ["wiki", "label"])   # a control on the card: picking a choice runs the script again

Each call writes .thimble-cc-mod/cards/<id>.json in the session's folder, wherever the script runs (THIMBLE_CC_MOD_ROOT,
which thimble-cc-mod sets for the session; else the folder holding the script's .thimble-cc-mod; else the nearest folder up
from the current one that has a .thimble-cc-mod; else the current folder), and prints the line that embeds the card in a
reply and the citation of each value. Refs (an example's, a node's) are read from that folder too. The id comes from the
question, so running the script again replaces the card.

When the analyst picks another choice of a param on the card, thimble-cc-mod runs the script again with
THIMBLE_CC_MOD_PARAMS (the values, as JSON) and THIMBLE_CC_MOD_ONLY ("<index>:<id>"): only that card is written, under its
own id, so the reply that embeds it shows the new data.
"""
from __future__ import annotations

import datetime as _dt
import hashlib
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from refs import HOME, LINES_RE, fmt, read_lines, record_text, resolve, safe_path, split_ref  # noqa: E402

KINDS = ("bar", "line", "timeline", "table", "example", "diagram")
MAX_NODES = 40
MAX_EDGES = 80
MAX_ROWS = 2000
MAX_QUOTE = 600
MAX_CHOICES = 12

_params: list[dict] = []  # the params this script declared, in order
_count = 0  # card() calls so far in this run


def _root() -> str:
    """The session's folder, where cards are written and refs are read."""
    env = os.environ.get("THIMBLE_CC_MOD_ROOT")
    if env and os.path.isdir(env):
        return os.path.abspath(env)
    main = getattr(sys.modules.get("__main__"), "__file__", None)
    if main:
        parts = os.path.abspath(main).split(os.sep)
        if HOME in parts:
            return os.sep.join(parts[: len(parts) - 1 - parts[::-1].index(HOME)]) or os.sep
    d = os.getcwd()
    while True:
        if os.path.isdir(os.path.join(d, HOME)):
            return d
        up = os.path.dirname(d)
        if up == d:
            return os.getcwd()
        d = up


_MONTHS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")
_STAMP = re.compile(r"(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?\s*(?:Z|[+-]\d{2}(?::?\d{2})?)?")


def short_times(times: list[str]) -> list[str]:
    """Timestamps as a timeline card shows and cites them, all in one form: "18 Jun 21:26", the year only when the
    events span more than one, the time only when one is not midnight, seconds only when two events share a minute.
    The clock reads as written. Times that are not all ISO dates are kept. hooks/draw.ts shortTimes has the same rule."""
    ps = [_STAMP.fullmatch(t.strip()) for t in times]
    if not ps or not all(ps):
        return list(times)
    g = [[p.group(i) or "00" if i >= 4 else p.group(i) for i in range(7)] for p in ps]
    years = {x[1] for x in g}
    clock = any(x[4] != "00" or x[5] != "00" or x[6] != "00" for x in g)
    minute = [(x[1], x[2], x[3], x[4], x[5]) for x in g]
    secs = any(minute[i] == minute[j] and g[i][6] != g[j][6] for i in range(len(g)) for j in range(len(g)))
    out = []
    for x in g:
        day = f"{int(x[3])} {_MONTHS[int(x[2]) - 1] if 1 <= int(x[2]) <= 12 else x[2]}" + (f" {x[1]}" if len(years) > 1 else "")
        out.append(day if not clock else f"{day} {x[4]}:{x[5]}" + (f":{x[6]}" if secs else ""))
    return out


def _env_json(name: str) -> dict:
    try:
        v = json.loads(os.environ.get(name) or "{}")
        return v if isinstance(v, dict) else {}
    except json.JSONDecodeError:
        return {}


def param(name: str, default, choices):
    """A value the analyst can change on the card, from `choices` (at most 12 strings or numbers). Returns `default`,
    or the choice the analyst picked when thimble-cc-mod runs the script again."""
    choices = [_plain(c) for c in choices]
    if not choices or len(choices) > MAX_CHOICES:
        raise ValueError(f"param {name!r}: give 1 to {MAX_CHOICES} choices")
    if any(not isinstance(c, (str, int, float)) or isinstance(c, bool) for c in choices):
        raise TypeError(f"param {name!r}: choices must be strings or numbers")
    default = _plain(default)
    if default not in choices:
        raise ValueError(f"param {name!r}: the default {default!r} is not among the choices")
    if any(p["name"] == name for p in _params):
        raise ValueError(f"param {name!r} is declared twice")
    want = _env_json("THIMBLE_CC_MOD_PARAMS").get(name, default)
    value = next((c for c in choices if str(c) == str(want)), default)
    _params.append({"name": str(name), "value": value, "default": default, "choices": choices})
    return value


def _num(v: object, what: str) -> float | int:
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        try:
            import numpy as np  # noqa: PLC0415

            if isinstance(v, np.generic):
                return v.item()
        except ImportError:
            pass
        raise TypeError(f"{what} must be a number, got {v!r}")
    return v


def _plain(v: object) -> object:
    """A value JSON can hold: numpy scalars and dates as Python values, the rest as text."""
    if v is None or isinstance(v, (str, bool, int, float)):
        return v
    if hasattr(v, "item"):
        return v.item()
    if isinstance(v, (_dt.date, _dt.datetime)):
        return v.isoformat(sep=" ") if isinstance(v, _dt.datetime) else v.isoformat()
    return str(v)


def _source(root: str) -> dict:
    main = sys.modules.get("__main__")
    path = getattr(main, "__file__", None)
    if not path or not os.path.isfile(path):
        print("thimble-cc-mod: this card has no script file. Write the code to .thimble-cc-mod/scripts/<name>.py and run it, "
              "so the analyst can read how the card was made.", file=sys.stderr)
        return {}
    with open(path, "rb") as f:
        sha = hashlib.sha1(f.read()).hexdigest()[:12]
    full = os.path.abspath(path)
    rel = os.path.relpath(full, root)
    return {"script": full if rel.startswith("..") else rel, "sha1": sha}


def _example(cwd: str, ex: dict) -> dict:
    ref = str(ex["ref"])
    base, frag = split_ref(ref)
    path = safe_path(cwd, base)
    if path is None or not os.path.isfile(path):
        raise FileNotFoundError(f"example {ref}: no file {base} in this folder")
    m = LINES_RE.match(frag)
    if not m:
        raise ValueError(f"example {ref}: cite lines, as {base}#L12 or {base}#L12-L14")
    a, b = int(m.group(1)), int(m.group(2) or m.group(1))
    lines = read_lines(path, a, b)
    if lines is None:
        raise ValueError(f"example {ref}: {base} has fewer than {b} lines")
    field = ex.get("field")
    text = "\n".join(record_text(ln, field) for ln in lines)
    quote = ex.get("quote")
    if quote:
        flat = " ".join(text.split())
        if quote not in text and " ".join(str(quote).split()) not in flat:
            raise ValueError(f"example {ref}: the quote is not in the record{' field ' + field if field else ''}: {quote!r}")
    else:
        quote = text if len(text) <= MAX_QUOTE else text[:MAX_QUOTE] + "…"
    return {"ref": ref, "quote": str(quote), "note": str(ex.get("note", "")), "field": field or ""}


def _node(n) -> dict:
    if isinstance(n, dict):
        nid = n.get("id", n.get("name", n.get("label")))
        if nid is None:
            raise TypeError(f"diagram node {n!r} has no id; a node is a name, (id, label, ref) or {{id, label, ref}}")
        label, ref, detail = n.get("label"), n.get("ref"), n.get("detail")
    elif isinstance(n, (tuple, list)):
        nid, label, ref = (list(n) + [None, None])[:3]
        detail = None
    else:
        nid, label, ref, detail = n, None, None, None
    out = {"id": str(_plain(nid)), "label": str(_plain(label if label not in (None, "") else nid)).strip()}
    if ref:
        out["ref"] = str(ref)
    if detail:
        out["detail"] = str(detail)
    return out


def _diagram(root: str, nodes, edges) -> tuple[list[dict], list[dict]]:
    ns: list[dict] = []
    seen: dict[str, dict] = {}

    def add(n) -> str:
        node = _node(n)
        if node["id"] not in seen:
            seen[node["id"]] = node
            ns.append(node)
        return node["id"]

    for n in nodes or []:
        add(n)
    es = []
    for e in edges or []:
        if isinstance(e, dict):
            s, t, label = e.get("source", e.get("from")), e.get("target", e.get("to")), e.get("label")
        elif isinstance(e, (tuple, list)) and len(e) >= 2:
            s, t, label = (list(e) + [None])[:3]
        else:
            raise TypeError(f"diagram edge {e!r}: give (source, target) or (source, target, label)")
        if s is None or t is None:
            raise TypeError(f"diagram edge {e!r} has no source or target")
        # an edge may name a node by its id or by its label
        by_label = {v["label"]: k for k, v in seen.items()}
        s, t = (str(_plain(v)) for v in (s, t))
        s, t = (v if v in seen else by_label.get(v) or add(v) for v in (s, t))
        edge = {"source": s, "target": t}
        if label not in (None, ""):
            edge["label"] = str(label)
        es.append(edge)
    if not ns:
        raise ValueError("a diagram card needs nodes, as names, (id, label, ref) or {id, label, ref}")
    if len(ns) > MAX_NODES or len(es) > MAX_EDGES:
        raise ValueError(f"a diagram card shows at most {MAX_NODES} nodes and {MAX_EDGES} edges")
    for n in ns:
        if n.get("ref") and resolve(root, n["ref"])["status"] == "missing":
            raise ValueError(f"node {n['label']!r}: the ref {n['ref']} does not resolve in {root}")
    return ns, es


def card(kind: str, question: str, *, rows=None, columns=None, series=None, points=None, events=None, examples=None,
         nodes=None, edges=None, x: str = "", y: str = "", total: bool | float | int = False, note: str = "",
         id: str | None = None) -> str:
    """Write a card and print how to embed and cite it. Returns the card's id."""
    global _count
    if kind not in KINDS:
        raise ValueError(f"kind must be one of {', '.join(KINDS)}")
    if not question or not str(question).strip():
        raise ValueError("a card needs its question")
    root = _root()
    index = _count
    _count += 1
    cid = id or hashlib.sha1(f"{kind}:{question}".encode()).hexdigest()[:6]
    only = os.environ.get("THIMBLE_CC_MOD_ONLY", "")
    if only:
        # a run by thimble-cc-mod for one card: the others of this script are left as they are
        at, _, keep = only.partition(":")
        if str(index) != at:
            return cid
        cid = keep or cid
    data: dict = {"id": cid, "kind": kind, "question": str(question).strip(), "x": x, "y": y, "note": note,
                  "created": _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds"),
                  "source": {**_source(root), "index": index}}
    if _params:
        data["params"] = [dict(p) for p in _params]
    cites: list[str] = []
    if kind == "bar":
        out = []
        for r in rows or []:
            label, value, group = (r["label"], r["value"], r.get("group", "")) if isinstance(r, dict) else (list(r) + [""])[:3]
            out.append({"label": str(_plain(label)), "value": _num(_plain(value), f"the value of {label!r}"), "group": str(group or "")})
        if not out:
            raise ValueError("a bar card needs rows, as [(label, value), ...]")
        data["rows"] = out[:MAX_ROWS]
        col = y or "value"
        data["y"] = col
        if total is True:
            data["total"] = sum(r["value"] for r in out)
        elif total is not False:
            data["total"] = _num(total, "total")
        cites = [f"[[{fmt(r['value'])}|card:{cid}#{col}/{r['label']}]]" for r in out]
        if "total" in data:
            cites.append(f"[[{fmt(data['total'])}|card:{cid}#{col}/all]]")
    elif kind == "line":
        if points is not None:
            series = {y or "value": points}
        if not series:
            raise ValueError("a line card needs series={name: [(x, y), ...]} or points=[(x, y), ...]")
        data["series"] = [{"name": str(name), "points": [[_plain(px), _num(_plain(py), f"{name} at {px}")] for px, py in pts][:MAX_ROWS]}
                          for name, pts in series.items()]
        for s in data["series"]:
            pts = s["points"]
            pick = pts if len(pts) <= 6 else [pts[0], max(pts, key=lambda p: p[1]), min(pts, key=lambda p: p[1]), pts[-1]]
            cites += [f"[[{fmt(py)}|card:{cid}#{s['name']}/{px}]]" for px, py in pick]
    elif kind == "timeline":
        evs = []
        for e in events or []:
            t, label, ref = (e["time"], e["label"], e.get("ref", "")) if isinstance(e, dict) else (list(e) + [""])[:3]
            evs.append({"time": str(_plain(t)), "label": str(label), "ref": str(ref or "")})
        if not evs:
            raise ValueError("a timeline card needs events, as [(time, label, ref), ...]")
        evs = evs[:200]
        for e, shown in zip(evs, short_times([e["time"] for e in evs])):
            if shown != e["time"]:
                e["shown"] = shown
        data["events"] = evs
        cites = [f"[[{e['ref']}]]" if e["ref"] else f"[[{e.get('shown', e['time'])}|card:{cid}#time/{i + 1}]]" for i, e in enumerate(evs)]
    elif kind == "table":
        if not columns or rows is None:
            raise ValueError("a table card needs columns=[...] and rows=[[...], ...]; the first column names each row")
        data["columns"] = [str(c) for c in columns]
        data["rows"] = [[_plain(v) for v in r] for r in rows][:MAX_ROWS]
        for r in data["rows"][:8]:
            cites += [f"[[{fmt(v)}|card:{cid}#{c}/{r[0]}]]" for c, v in zip(data["columns"][1:], r[1:]) if isinstance(v, (int, float))]
    elif kind == "example":
        data["examples"] = [_example(root, ex) for ex in examples or []]
        if not data["examples"]:
            raise ValueError("an example card needs examples, as [{'ref': 'file.jsonl#L12', 'quote': '...'}]")
        cites = [f"[[{ex['ref']}]]" for ex in data["examples"]]
    elif kind == "diagram":
        data["nodes"], data["edges"] = _diagram(root, nodes, edges)
        cites = [f"[[{n['ref']}]]" for n in data["nodes"] if n.get("ref")]
    folder = os.path.join(root, HOME, "cards")
    os.makedirs(folder, exist_ok=True)
    with open(os.path.join(folder, f"{cid}.json"), "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    n = len(data.get("rows") or data.get("series") or data.get("events") or data.get("examples") or data.get("nodes") or [])
    unit = {"line": "series", "diagram": "nodes"}.get(kind, "rows")
    where = os.path.join(HOME, "cards", f"{cid}.json") if os.path.samefile(root, os.getcwd()) else os.path.join(root, HOME, "cards", f"{cid}.json")
    print(f"thimble-cc-mod card {cid} ({kind}, {n} {unit}) -> {where}")
    if _params:
        print("controls on the card: " + "; ".join(f"{p['name']} = {p['value']} of {', '.join(map(str, p['choices']))}" for p in _params))
    print(f"embed it on a line of its own: [[card:{cid}]]")
    if cites:
        print("cite its records as:" if kind in ("example", "diagram") else "cite its values as:")
        for c in cites[:24]:
            print(f"  {c}")
        if len(cites) > 24:
            print(f"  ... {len(cites) - 24} more, in the same form")
    return cid


if __name__ == "__main__":
    if len(sys.argv) >= 2 and sys.argv[1] == "list":
        folder = os.path.join(_root(), HOME, "cards")
        for name in sorted(os.listdir(folder)) if os.path.isdir(folder) else []:
            with open(os.path.join(folder, name), encoding="utf-8") as f:
                c = json.load(f)
            print(f"{c['id']}  {c['kind']:<8}  {c['question']}")
    else:
        print(__doc__)
