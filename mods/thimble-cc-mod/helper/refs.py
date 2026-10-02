"""Shared by tcard.py and resolve.py: where thimble-cc-mod keeps its files, how a ref is read, and how a shown number is
compared with the value at a ref (a port of thimble's backend/app/cite.py shown_matches and value_in).

Refs read here:
    card:<id>                       a card
    card:<id>#<column>/<row>        a value of a card (bar: the y title and the label; table: a column and the first
                                    column's value; line: the series and the x value; timeline: event and its number;
                                    diagram: node and its id, edge and its number)
    call:<id>#L<n>[-L<m>]           lines of a Bash call's output, as thimble-cc-mod saved it (.thimble-cc-mod/calls)
    <path>#L<n>[-L<m>]              lines of a text file, counted from 1
    <path>#row=<n>                  a row of a CSV or TSV file, counted from the row after the header
    <path>#/<json pointer>          a value of a JSON document
    <path>#<table>/<key>            a row of a SQLite database, by its primary key
    <path>                          a file
"""
from __future__ import annotations

import csv
import io
import json
import os
import re
import sqlite3
from decimal import ROUND_HALF_EVEN, ROUND_HALF_UP, Decimal, InvalidOperation
from itertools import islice

HOME = ".thimble-cc-mod"
LINE_CAP = 4000  # characters of one line kept for display; the match is found on the whole line first

NUM_RE = re.compile(r"(?<![\w:./#\-−])[-−]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?%?(?![\w%:])")
PLAIN_NUM_RE = re.compile(r"[-−]?(?:(?:0|[1-9][0-9]*)(?:\.[0-9]*)?|\.[0-9]+)")
QUOTE_MARKS = "\"'“”‘’"
LINES_RE = re.compile(r"^L(\d+)(?:-L?(\d+))?$")


def home(cwd: str) -> str:
    return os.path.join(cwd, HOME)


# ------------------------------------------------------------------------------------------------ numbers


def norm(tok: str) -> str:
    s = tok.replace(",", "").replace("−", "-").rstrip("%").strip()
    if not PLAIN_NUM_RE.fullmatch(s):
        return s
    try:
        d = Decimal(s)
    except (InvalidOperation, ValueError):
        return s
    return format(d.normalize() if d != 0 else Decimal(0), "f")


def _parts(s: str) -> tuple[Decimal, int] | None:
    t = s.strip().replace(",", "").replace("−", "-").rstrip("%").strip()
    if not PLAIN_NUM_RE.fullmatch(t):
        return None
    try:
        return Decimal(t), (len(t.split(".", 1)[1]) if "." in t else 0)
    except (InvalidOperation, ValueError):
        return None


def shown_matches(token: str, shown: str) -> bool:
    """The same value, or `shown` with only decimals dropped by rounding: "91%" cites 91.2, "6,500" does not cite 6,543."""
    a, b = _parts(token), _parts(shown)
    if a is None or b is None:
        return bool(norm(token)) and norm(token) == norm(shown)
    (va, da), (vb, db) = a, b
    if va == vb:
        return True
    if da < db:
        q = Decimal(1).scaleb(-da)
        return va in (vb.quantize(q, rounding=ROUND_HALF_UP), vb.quantize(q, rounding=ROUND_HALF_EVEN))
    return False


def value_in(display: str, text: str) -> bool:
    """Whether a citation's shown value is at the place it cites: a number must match a whole number of the text;
    anything else is a comma-insensitive substring (quotes around a quoted phrase left out)."""
    if any(shown_matches(display, t) for t in NUM_RE.findall(text)):
        return True
    if NUM_RE.fullmatch(display.strip()):
        return False
    words = display.strip()
    if len(words) > 2 and words[0] in QUOTE_MARKS and words[-1] in QUOTE_MARKS:
        words = words[1:-1]
    return norm(words) in text.replace(",", "")


def number_spans(display: str, text: str) -> list[list[int]]:
    """Where the shown value stands in `text`, as [start, end] pairs, so a viewer can mark it."""
    out = [[m.start(), m.end()] for m in NUM_RE.finditer(text) if shown_matches(display, m.group(0))]
    if out or NUM_RE.fullmatch(display.strip()):
        return out
    words = display.strip().strip(QUOTE_MARKS)
    i = text.find(words) if words else -1
    return [[i, i + len(words)]] if i >= 0 else []


def fmt(v: object) -> str:
    """A value as a citation shows it: an integer whole, a float to at most 3 decimals (trailing zeros dropped)."""
    if isinstance(v, bool):
        return str(v).lower()
    if isinstance(v, int):
        return str(v)
    if isinstance(v, float):
        if v != v:
            return "NaN"
        if v.is_integer() and abs(v) < 1e15:
            return str(int(v))
        s = f"{v:.3f}".rstrip("0").rstrip(".")
        return s if s not in ("-0", "") else "0"
    return str(v)


# ------------------------------------------------------------------------------------------------ files


def safe_path(cwd: str, rel: str) -> str | None:
    """The file a ref names, under the session's folder; None for a path outside it."""
    p = os.path.realpath(os.path.join(cwd, rel))
    root = os.path.realpath(cwd)
    return p if p == root or p.startswith(root + os.sep) else None


def read_lines(path: str, start: int, end: int) -> list[str] | None:
    """Lines start..end (from 1) of a text file, streamed so a large file is not read whole; None past its end."""
    with open(path, encoding="utf-8", errors="replace") as f:
        got = [ln.rstrip("\n") for ln in islice(f, start - 1, end)]
    return got if len(got) == end - start + 1 else None


def window(path: str, start: int, end: int, around: int) -> list[dict]:
    lo = max(1, start - around)
    out = []
    with open(path, encoding="utf-8", errors="replace") as f:
        for n, ln in enumerate(islice(f, lo - 1, end + around), start=lo):
            out.append({"n": n, "text": ln.rstrip("\n"), "hit": start <= n <= end})
    return out


def json_pointer(doc: object, pointer: str) -> object:
    cur = doc
    for raw in pointer.split("/")[1:]:
        key = raw.replace("~1", "/").replace("~0", "~")
        if isinstance(cur, list):
            cur = cur[int(key)]
        elif isinstance(cur, dict):
            cur = cur[key]
        else:
            raise KeyError(key)
    return cur


def record_text(line: str, field: str | None = None) -> str:
    """A JSONL record's text: the named field (dotted path) when given, else the line as it is."""
    if not field:
        return line
    obj = json.loads(line)
    for k in field.split("."):
        obj = obj[int(k)] if isinstance(obj, list) else obj[k]
    return obj if isinstance(obj, str) else json.dumps(obj, ensure_ascii=False)


# ------------------------------------------------------------------------------------------------ cards


def load_card(cwd: str, cid: str) -> dict | None:
    p = os.path.join(home(cwd), "cards", f"{cid}.json")
    if not re.fullmatch(r"[A-Za-z0-9_-]+", cid) or not os.path.exists(p):
        return None
    with open(p, encoding="utf-8") as f:
        return json.load(f)


def card_values(card: dict) -> dict[str, dict[str, object]]:
    """Every value a card shows, by column then row key, as `card:<id>#<column>/<row>` cites it."""
    kind = card.get("kind")
    out: dict[str, dict[str, object]] = {}
    if kind == "bar":
        col = card.get("y") or "value"
        out[col] = {str(r["label"]): r["value"] for r in card.get("rows", [])}
        if card.get("total") is not None:
            out[col]["all"] = card["total"]
    elif kind == "line":
        for s in card.get("series", []):
            out[str(s["name"])] = {str(x): y for x, y in s.get("points", [])}
    elif kind == "table":
        cols = card.get("columns", [])
        for r in card.get("rows", []):
            key = str(r[0])
            for c, v in zip(cols, r):
                out.setdefault(str(c), {})[key] = v
    elif kind == "timeline":
        out["event"] = {str(i + 1): f"{e['time']} {e['label']}" for i, e in enumerate(card.get("events", []))}
        out["time"] = {str(i + 1): e.get("shown") or e["time"] for i, e in enumerate(card.get("events", []))}
    elif kind == "diagram":
        out["node"] = {str(n["id"]): n["label"] for n in card.get("nodes", [])}
        label = {str(n["id"]): n["label"] for n in card.get("nodes", [])}
        out["edge"] = {str(i + 1): f"{label.get(e['source'], e['source'])} → {label.get(e['target'], e['target'])}"
                       + (f": {e['label']}" if e.get("label") else "") for i, e in enumerate(card.get("edges", []))}
    return out


def card_lookup(card: dict, frag: str) -> tuple[str, str, object] | None:
    """(column, row, value) for the `<column>/<row>` of a card ref; column names may hold a slash, so each known column
    is tried as a prefix, longest first."""
    vals = card_values(card)
    for col in sorted(vals, key=len, reverse=True):
        if frag.startswith(col + "/"):
            row = frag[len(col) + 1:]
            if row in vals[col]:
                return col, row, vals[col][row]
            # a row key written as a number the card holds as text, or the other way round
            for k, v in vals[col].items():
                if norm(k) == norm(row):
                    return col, k, v
            return None
    return None


# ------------------------------------------------------------------------------------------------ resolving


def split_ref(ref: str) -> tuple[str, str]:
    base, _, frag = ref.partition("#")
    return base.strip(), frag.strip()


def resolve(cwd: str, ref: str, display: str | None = None, around: int = 6) -> dict:
    """Read the place a ref names. status: ok (resolves and the shown value is there, or there is none to check),
    differs (resolves, the shown value is not there), missing (does not resolve). window: lines to show, `hit` on the
    cited ones; spans: where the shown value stands in each hit line."""
    base, frag = split_ref(ref)
    out: dict = {"ref": ref, "status": "missing", "why": "", "kind": "file", "window": [], "text": ""}
    try:
        if base.startswith("card:"):
            return _resolve_card(cwd, base[5:], frag, display, out)
        if base.startswith("call:"):
            return _resolve_call(cwd, base[5:], frag, display, out, around)
        path = safe_path(cwd, base)
        if path is None or not os.path.isfile(path):
            out["why"] = f"no file {base} in this folder"
            return out
        out["file"] = base
        if not frag:
            if display is None:
                out.update(status="ok", why="the file exists")
            else:
                out.update(status="unchecked", why="a whole file: cite a line to check the value")
            return out
        m = LINES_RE.match(frag)
        if m:
            a = int(m.group(1))
            b = int(m.group(2) or a)
            if b < a or b - a > 400:
                out["why"] = f"bad line range {frag}"
                return out
            lines = read_lines(path, a, b)
            if lines is None:
                out["why"] = f"{base} has fewer than {b} lines"
                return out
            out.update(kind="lines", start=a, end=b, window=window(path, a, b, around), text="\n".join(lines))
            return _check(out, display, out["text"])
        if frag.startswith("row="):
            n = int(frag[4:])
            with open(path, encoding="utf-8", errors="replace", newline="") as f:
                dialect = csv.excel_tab if path.endswith((".tsv", ".tab")) else csv.excel
                rows = list(islice(csv.reader(f, dialect), 0, n + 1))
            if n < 1 or len(rows) <= n:
                out["why"] = f"{base} has fewer than {n} rows"
                return out
            text = ", ".join(f"{h}: {v}" for h, v in zip(rows[0], rows[n]))
            out.update(kind="row", text=text, window=[{"n": n, "text": text, "hit": True}])
            return _check(out, display, text)
        if frag.startswith("/"):
            with open(path, encoding="utf-8") as f:
                val = json_pointer(json.load(f), frag)
            text = val if isinstance(val, str) else json.dumps(val, ensure_ascii=False, indent=1)
            out.update(kind="json", text=text, window=[{"n": i + 1, "text": t, "hit": True} for i, t in enumerate(text.splitlines()[:60])])
            return _check(out, display, text)
        if "/" in frag and path.endswith((".db", ".sqlite", ".sqlite3")):
            table, key = frag.split("/", 1)
            con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
            cols = [r[1] for r in con.execute(f'PRAGMA table_info("{table}")')]
            pk = next((r[1] for r in con.execute(f'PRAGMA table_info("{table}")') if r[5]), "rowid")
            row = con.execute(f'SELECT * FROM "{table}" WHERE "{pk}" = ?', (key,)).fetchone()
            if row is None:
                out["why"] = f"no row {key} in {table}"
                return out
            text = ", ".join(f"{c}: {v}" for c, v in zip(cols, row))
            out.update(kind="row", text=text, window=[{"n": 1, "text": text, "hit": True}])
            return _check(out, display, text)
        out["why"] = f"cannot read the place #{frag}"
        return out
    except (OSError, ValueError, KeyError, IndexError, TypeError, sqlite3.Error, json.JSONDecodeError) as err:
        out["why"] = f"{type(err).__name__}: {str(err)[:120]}"
        return out


def is_quote(display: str) -> bool:
    d = display.strip()
    return len(d) > 2 and d[0] in QUOTE_MARKS and d[-1] in QUOTE_MARKS


def _check(out: dict, display: str | None, text: str) -> dict:
    """A shown number or quoted phrase must be at the place; other words are the link's words ([[this one|ref]]),
    checked when found there and otherwise left unchecked rather than failed."""
    if display is None:
        out.update(status="ok", why="resolves")
        return out
    if value_in(display, text):
        out.update(status="ok", why=f"{display} is there")
        for w in out["window"]:
            if w.get("hit"):
                w["spans"] = number_spans(display, w["text"])
        return out
    if NUM_RE.fullmatch(display.strip()) or is_quote(display):
        out.update(status="differs", why=f"{display} is not there")
    else:
        out.update(status="unchecked", why="resolves; the link's words are not a number or a quote, so not checked")
    return out


def _resolve_card(cwd: str, cid: str, frag: str, display: str | None, out: dict) -> dict:
    card = load_card(cwd, cid)
    out["kind"] = "card"
    out["card"] = cid
    if card is None:
        out["why"] = "no such card"
        return out
    out["question"] = card.get("question", "")
    if not frag:
        out.update(status="ok", why="the card exists")
        return out
    hit = card_lookup(card, frag)
    if hit is None:
        out["why"] = f"card {cid} has no value {frag}"
        return out
    col, row, val = hit
    out.update(kind="value", column=col, row=row, value=fmt(val), text=fmt(val))
    # a timeline's time is cited as the card shows it, or as the script wrote it
    raw = card["events"][int(row) - 1]["time"] if card.get("kind") == "timeline" and col == "time" else None
    if display is None:
        out.update(status="ok", why="resolves")
    elif (shown_matches(display, fmt(val)) or (not _parts(display) and value_in(display, fmt(val)))
          or (raw is not None and display.strip() == str(raw).strip())):
        out.update(status="ok", why=f"the card shows {fmt(val)}")
    else:
        out.update(status="differs", why=f"the card shows {fmt(val)}, not {display}")
    return out


def _resolve_call(cwd: str, cid: str, frag: str, display: str | None, out: dict, around: int) -> dict:
    p = os.path.join(home(cwd), "calls", f"{cid}.json")
    out["kind"] = "call"
    out["call"] = cid
    if not re.fullmatch(r"[A-Za-z0-9_-]+", cid) or not os.path.exists(p):
        out["why"] = f"no saved output for call {cid}"
        return out
    with open(p, encoding="utf-8") as f:
        call = json.load(f)
    lines = str(call.get("output", "")).split("\n")
    out["command"] = str(call.get("command", ""))[:2000]
    if not frag:
        out.update(status="ok", why="the call's output", window=[{"n": i + 1, "text": t[:LINE_CAP], "hit": False} for i, t in enumerate(lines[:80])])
        return out
    m = LINES_RE.match(frag)
    if not m:
        out["why"] = f"cannot read the place #{frag}"
        return out
    a = int(m.group(1))
    b = int(m.group(2) or a)
    if a < 1 or b > len(lines) or b < a:
        out["why"] = f"the output of call {cid} has {len(lines)} lines"
        return out
    lo = max(1, a - around)
    hi = min(len(lines), b + around)
    out.update(kind="call", start=a, end=b, text="\n".join(lines[a - 1:b]),
               window=[{"n": n, "text": lines[n - 1][:LINE_CAP], "hit": a <= n <= b} for n in range(lo, hi + 1)])
    return _check(out, display, out["text"])


def cap_window(res: dict, cap: int = LINE_CAP) -> dict:
    """Long lines (a JSONL record can be 100 KB) cut for display, around the first span of the shown value."""
    for w in res.get("window", []):
        t = w["text"]
        if len(t) <= cap:
            continue
        spans = w.get("spans") or []
        lo = max(0, spans[0][0] - cap // 3) if spans else 0
        w["text"] = ("…" if lo else "") + t[lo:lo + cap] + "…"
        if spans:
            shift = lo - (1 if lo else 0)
            w["spans"] = [[s - shift, e - shift] for s, e in spans if s - shift >= 0 and e - shift <= len(w["text"])]
    return res


def resolve_many(cwd: str, items: list[dict], around: int = 6) -> list[dict]:
    out = []
    for it in items:
        r = cap_window(resolve(cwd, str(it.get("ref", "")), it.get("display"), around))
        r["id"] = it.get("id")
        out.append(r)
    return out


def dumps(obj: object) -> str:
    return json.dumps(obj, ensure_ascii=False)


def read_stdin_json(stream: io.TextIOBase) -> dict:
    return json.loads(stream.read() or "{}")
