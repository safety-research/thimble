# Relay Board: the messages AI agents left on wiki pages while they ran the same timed tasks, read as one thread
# per task, each save shown as the lines it added.
#
# The data: revisions.jsonl, one JSON object per line, one stored save of one wiki page each:
#   rev_id          the save's id, <page_key>@<seq>
#   page_id         the page, <wiki>/<name>
#   page_key        the page as <wiki>~<name>
#   wiki, name      the wiki (dse, probier, fractal, dorfwiki) and the page's name
#   seq             the save's number on its page, 1 for the page's first; a page whose first stored seq is above 1
#                   lost its earlier saves
#   body            the whole page after the save
#   body_len, lines its length in characters and lines
#   label           the username the save was made under, "" for none
#   ip16            the first two octets of the saver's address
#   time            when, ISO 8601 in UTC (write_date repeats it)
#   request_action  form_edit or null
#   change_summary  the summary the saver typed, or null
#
# events.jsonl, the wikis' logs, is read only for its delete events (page_key, time): a save that comes after a delete
# of its page is compared with an empty page, as Wiki Page History does, since the wiki starts the page again.
# The deletes themselves show in Wiki Page History, so hidden() lists events.jsonl with that why.
#
# The records: every save is one record. Its added text is the lines a line diff of its body against the body of the
# page's previous stored save finds added (the page's first stored save adds its whole body, and so does a save after a
# delete of its page: a delete at or after the previous save's time and before this save's time). A save is a message when
# those lines hold text other than blanks, the wiki's stock new-page line ("Beschreibe hier die neue Seite.") and the
# placeholder "[pre-2026 line withheld]".
#
# What the reader works out (view.json lists each):
#   added, n_added, n_removed   the line diff above: the added lines, and how many lines it added and removed
#   kind        1 Text only (the added text holds no web address), 2 With links (it holds one: http://, https:// or
#               www.), 0 no new text (not a message)
#   task        the first entry of TASKS whose pattern the page's name holds; the wikis' shared pages (SHARED) are a row
#               of their own; a page whose name holds no pattern is "No task in the name"
#   signature   the name after "-- " at the end of the last added line that ends in one, a trailing " ?" dropped
#   order       records are sorted by time, then by line
#   bad lines   a line that does not parse whole (a torn line), or has no page_id, seq, body or time the reader can read,
#               is no record; problems() lists it, and the next save of its page is compared with the one before it
#
# The method: build_index reads the file once and keeps each line's byte offset, each record as a row of small integers
# (time, line, page, user, task, signature, lines added, lines removed, kind) in time order, and the added text of
# each, which the search reads. `records` sends the rows the label filter keeps as columns, and the page counts, groups
# and filters them itself. The text of the rows it draws, a search and one record in full (its body read back from the
# file) are separate fetches.
#
# Units: a task (its key, such as OECD) and a page (its page_key, such as dse~LangR5SignalJun13).
#
# Labels: they apply when records are served, never in the index. The overview keeps only the rows thimble.kept(ref)
# holds for, and gives each row the labels that mark it as bits in `mb`, from which the page reads the value of the
# label its Colour by control colours by, for its strips, its counts and its chips, since thimble cannot see inside
# them. The other values the page colours by (a message's kind, its page's wiki, its signature) it works out from the
# columns sent.
import bisect
import difflib
import json
import os
import re
from datetime import datetime, timezone

import thimble

# (key, name shown, pattern): a page takes the first task whose pattern its name holds. Sector 61-62 comes after the
# tasks whose pages also say "StateSequence" (Clothing, Language, Poverty).
TASKS = [
    ("Grocery", "Grocery", r"grocery"),
    ("Clothing", "Clothing", r"clothing"),
    ("Construction", "Construction", r"construction"),
    ("Language", "Language", r"language|lang|french"),
    ("FuelPoverty", "Fuel poverty", r"fuelpoverty"),
    ("Poverty", "Poverty", r"poverty"),
    ("Cashier", "Cashier", r"cashier"),
    ("Maids", "Maids", r"maids"),
    ("Police", "Police", r"police"),
    ("Veterans", "Veterans", r"veteran"),
    ("Ivy", "Ivy tuition", r"ivy|tuition"),
    ("Transport", "Transport", r"transport"),
    ("CVD", "Cardiovascular", r"cvd|cardio|healthdata|mcv"),
    ("OECD", "OECD equity", r"oecd|equity"),
    ("FamilyPlanning", "Family planning", r"familyplanning|fpscout|ihme"),
    ("RRP", "RRP Poland", r"rrp|poland"),
    ("UEFA", "UEFA", r"uefa"),
    ("Finance", "Finance", r"finance"),
    ("Asian", "Asian enrollment", r"asian|enrollment"),
    ("SchoolPsych", "School psych", r"schoolpsych|slp"),
    ("Production", "Production", r"(?-i:Prod(?:uction)?(?![a-z]))"),
    ("Sector61", "Sector 61–62", r"sector|statesequence|state5|6162"),
    ("Shared", "Shared pages", None),
    ("Other", "No task in the name", None),
]
TASK_RE = [(i, re.compile(p, re.I)) for i, (_, _, p) in enumerate(TASKS) if p]
SHARED_I = len(TASKS) - 2
OTHER_I = len(TASKS) - 1
SHARED = {"WillkommenImWiki", "StartSeite", "TestSeite", "RecentChanges", "SandBox"}  # the last part of the name
STOCK = {"Beschreibe hier die neue Seite.", "Describe the new page here."}
WITHHELD = "[pre-2026 line withheld]"
URL = re.compile(r"https?://|\bwww\.", re.I)
SIGNATURE = re.compile(r"(?:^|\s)--\s+([^\s-][^\n]{0,59}?)(?:\s+\?)?\s*$")
KINDS = ["No new text", "Text only", "With links"]
T, L, PG, U, TK, SG, NA, NR, K = range(9)  # a row
OVERVIEW_ROWS = 200_000  # rows one overview fetch returns: every row of this file at once
TEXT_MAX = 2400  # characters of a message's added text a thread row gets
TEXTS_MAX = 1000  # rows one texts fetch answers
MARKS_MAX = 24
UNIT_REFS = 200
EXCERPT_ROWS = 8
MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def _task(name):
    if name.rsplit("/", 1)[-1] in SHARED:
        return SHARED_I
    for i, rx in TASK_RE:
        if rx.search(name):
            return i
    return OTHER_I


def _epoch(v):
    if not isinstance(v, str) or not v.strip():
        return None
    try:
        dt = datetime.fromisoformat(v.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    return int((dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)).timestamp())


def _when(t):
    d = datetime.fromtimestamp(t, timezone.utc)
    return f"{d.day} {MONTHS[d.month - 1]} {d:%H:%M}"


def _diff(old, new):
    """(numbers from 0 of the lines of `new` a line diff against `old` finds added, the removed lines of `old`)."""
    a, b = old.splitlines(), new.splitlines()
    added, removed = [], []
    for op, i1, i2, j1, j2 in difflib.SequenceMatcher(None, a, b, autojunk=False).get_opcodes():
        if op in ("insert", "replace"):
            added.extend(range(j1, j2))
        if op in ("delete", "replace"):
            removed.extend(a[i1:i2])
    return added, removed


def _clean(lines):
    """The added lines that count toward a message: not blank, not the stock line, not the withheld placeholder."""
    return [s for s in lines if s.strip() and s.strip() not in STOCK and s.strip() != WITHHELD]


def _signature(lines):
    for s in reversed(lines):
        m = SIGNATURE.search(s.rstrip())
        if m:
            return m.group(1).strip()
    return ""


def _intern(table, at, v):
    if v not in at:
        at[v] = len(table)
        table.append(v)
    return at[v]


def _deletes(path, problems):
    """{page_key: sorted delete times} from the delete events of events.jsonl; {} without the file."""
    out = {}
    if not path:
        return out
    try:
        with open(path, "rb") as fh:
            for n, raw in enumerate(fh, 1):
                if b'"delete"' not in raw:
                    continue
                try:
                    r = json.loads(raw)
                except ValueError:
                    problems.append({"ref": f"{path}#L{n}", "why": "not a whole JSON object (the line is cut short)"})
                    continue
                if not isinstance(r, dict) or r.get("event_type") != "delete":
                    continue
                t, key = _epoch(r.get("time")), r.get("page_key")
                if t is None or not isinstance(key, str) or not key:
                    continue
                out.setdefault(key, []).append(t)
    except OSError as e:
        problems.append({"ref": f"{path}#L1", "why": f"cannot be read ({type(e).__name__})"})
    for v in out.values():
        v.sort()
    return out


def _deleted_between(times, a, b):
    """Whether a delete lies after the save at time a and before the save at time b, as Wiki Page History orders
    them: a delete at the same second as a save comes after it."""
    if not times:
        return False
    k = bisect.bisect_left(times, a)
    return k < len(times) and times[k] < b


# ---------------------------------------------------------------- the index


def build_index(paths):
    """{"path", "offsets": [byte offset of line n at n-1], "rows": [[t, line, page, user, task, signature, n_added,
    n_removed, kind]] in time order, "added": [text per row], "pages": [{id, key, name, wiki, task, first}], "users",
    "sigs", "row_at": {line: row}, "page_rows": [[rows in seq order] per page], "problems": [{ref, why}]}."""
    paths = list(paths or [])
    path = next((p for p in paths if os.path.basename(p) == "revisions.jsonl"), None)
    events = next((p for p in paths if os.path.basename(p) == "events.jsonl"), None)
    idx = {"path": path, "events": events, "offsets": [], "rows": [], "added": [], "pages": [], "users": [""],
           "sigs": [""], "row_at": {}, "page_rows": [], "problems": [], "after_delete": set()}
    if path is None:
        return idx
    deletes = _deletes(events, idx["problems"])
    found = []  # (page_id, seq, line, t, record)
    try:
        total = os.path.getsize(path)
        with open(path, "rb") as fh:
            pos = 0
            for n, raw in enumerate(fh, 1):
                idx["offsets"].append(pos)
                pos += len(raw)
                if n % 2000 == 0:
                    thimble.progress(pos, total, "reading the saves")
                if not raw.strip():
                    continue
                try:
                    r = json.loads(raw)
                except ValueError:
                    idx["problems"].append({"ref": f"{path}#L{n}", "why": "not a whole JSON object (the line is cut short)"})
                    continue
                if not isinstance(r, dict):
                    idx["problems"].append({"ref": f"{path}#L{n}", "why": "not a JSON object"})
                    continue
                why = ("no page_id" if not isinstance(r.get("page_id"), str) or not r["page_id"]
                       else "no seq" if not isinstance(r.get("seq"), int) or isinstance(r.get("seq"), bool)
                       else "no body" if not isinstance(r.get("body"), str)
                       else "no time the reader can read" if _epoch(r.get("time")) is None else "")
                if why:
                    idx["problems"].append({"ref": f"{path}#L{n}", "why": f"not a save: {why}"})
                    continue
                found.append((r["page_id"], r["seq"], n, _epoch(r["time"]), r))
    except OSError as e:
        idx["problems"].append({"ref": f"{path}#L1", "why": f"cannot be read ({type(e).__name__})"})
        return idx
    found.sort(key=lambda x: (x[0], x[1], x[2]))
    page_at, user_at, sig_at = {}, {"": 0}, {"": 0}
    rows, added = [], []
    prev_page, prev_body, prev_t = None, "", None
    for k, (pid, seq, n, t, r) in enumerate(found):
        if k % 2000 == 0:
            thimble.progress(k, len(found), "comparing each save with the one before")
        if pid != prev_page:
            prev_page, prev_body, prev_t = pid, "", None
            page_at[pid] = len(idx["pages"])
            name = str(r.get("name") or pid.split("/", 1)[-1])
            idx["pages"].append({"id": pid, "key": str(r.get("page_key") or pid.replace("/", "~", 1)), "name": name,
                                 "wiki": str(r.get("wiki") or pid.split("/", 1)[0]), "task": _task(name), "first": seq})
        body = r["body"]
        new_lines = body.splitlines()
        key = str(r.get("page_key") or pid.replace("/", "~", 1))
        if prev_t is not None and _deleted_between(deletes.get(key), prev_t, t):
            prev_body = ""
            idx["after_delete"].add(n)
        add_at, removed = _diff(prev_body, body)
        prev_body, prev_t = body, t
        lines = [new_lines[j] for j in add_at]
        clean = _clean(lines)
        kind = 0 if not clean else 2 if URL.search("\n".join(clean)) else 1
        text = "\n".join(lines).strip("\n") if kind else ""
        user = r.get("label") if isinstance(r.get("label"), str) else ""
        rows.append([t, n, page_at[pid], _intern(idx["users"], user_at, user), idx["pages"][page_at[pid]]["task"],
                     _intern(idx["sigs"], sig_at, _signature(lines) if kind else ""), len(add_at), len(removed), kind])
        added.append(text)
    order = sorted(range(len(rows)), key=lambda i: (rows[i][T], rows[i][L]))
    idx["rows"] = [rows[i] for i in order]
    idx["added"] = [added[i] for i in order]
    idx["page_rows"] = [[] for _ in idx["pages"]]
    for i, row in enumerate(idx["rows"]):
        idx["row_at"][row[L]] = i
    at = [0] * len(rows)
    for i, j in enumerate(order):
        at[j] = i
    for j, row in enumerate(rows):  # rows before sorting are in page and seq order
        idx["page_rows"][row[PG]].append(at[j])
    return idx


# ---------------------------------------------------------------- reading back


def _ref(index, i):
    return f"{index['path']}#L{index['rows'][i][L]}"


def _line(index, n):
    """The save on line n as the file holds it, parsed, or None."""
    try:
        with open(index["path"], "rb") as fh:
            fh.seek(index["offsets"][n - 1])
            return json.loads(fh.readline())
    except (OSError, ValueError, IndexError):
        return None


def _overview(index, keep, start):
    """The rows the filter keeps (and the rows in `keep`), from row `start` on, at most OVERVIEW_ROWS, as columns kept
    small: `dr` the row and `dt` its time in seconds, each as the step from the row before (the first from row -1 and
    `t0`), `ln` the line, `pg`, `u`, `tk`, `sg` indices into the names, `na` and `nr` the lines added and removed, `k`
    the kind, and `mb` the row's marks as bits of indices into `marks`; `next` the row the next page starts at, None
    after the last. The first page also holds `t0`, `path`, `pages` [[name, task, first seq, wiki index, page_id]],
    `wikis`, `users`, `sigs`, `tasks` [[key, name]], `kinds`, `marks` (every value of the labels that are on,
    {label, value, colour}), `on` and `filter` (the labels on and the filter it answered for), and `ad`, the rows of the
    saves that come after a delete of their page."""
    on = thimble.view_labels()
    rows = index["rows"]
    t0 = rows[0][T] if rows else 0
    cols = {k: [] for k in ("dr", "dt", "ln", "pg", "u", "tk", "sg", "na", "nr", "k", "mb")}
    marks = [{"label": lab["name"], "value": v["name"], "colour": v["colour"]}
             for lab in on["labels"] for v in lab["values"]][:MARKS_MAX]
    mark_at = {(x["label"], x["value"]): m for m, x in enumerate(marks)}
    i = max(0, start)
    last_r, last_t = i - 1, rows[i - 1][T] if 0 < i <= len(rows) else t0
    n_sent = 0
    while i < len(rows) and n_sent < OVERVIEW_ROWS:
        row, ref = rows[i], _ref(index, i)
        i += 1
        if on["filter"] and (i - 1) not in keep and not thimble.kept(ref):
            continue
        bits = 0
        for x in thimble.marked(ref) if marks else ():
            m = mark_at.get((x["label"], x["value"]))
            if m is not None:
                bits |= 1 << m
        for k, v in zip(cols, (i - 1 - last_r, row[T] - last_t, row[L], row[PG], row[U], row[TK], row[SG], row[NA],
                               row[NR], row[K], bits), strict=True):
            cols[k].append(v)
        last_r, last_t = i - 1, row[T]
        n_sent += 1
    page = {"cols": cols, "next": i if i < len(rows) else None}
    if start <= 0:
        pages, wikis = [], []
        for p in index["pages"]:
            if p["wiki"] not in wikis:
                wikis.append(p["wiki"])
            pages.append([p["name"], p["task"], p["first"], wikis.index(p["wiki"]), p["id"], p["key"]])
        page.update(ad=sorted(index["row_at"][n] for n in index["after_delete"] if n in index["row_at"]))
        page.update(t0=t0, path=index["path"], users=index["users"], sigs=index["sigs"],
                    tasks=[[k, name] for k, name, _ in TASKS], kinds=KINDS, pages=pages, wikis=wikis,
                    marks=marks, on=[lab["name"] for lab in on["labels"]], filter=on["filter"])
    return page


def _texts(index, rows):
    """[[row, added text, whether it was cut]] of the wanted rows, each cut to TEXT_MAX characters."""
    out = []
    for i in rows[:TEXTS_MAX]:
        if isinstance(i, int) and not isinstance(i, bool) and 0 <= i < len(index["rows"]):
            s = index["added"][i]
            out.append([i, s[:TEXT_MAX], len(s) > TEXT_MAX])
    return out


_LOWER = {"id": None, "texts": None}


def _search(index, q):
    """The rows whose added text holds `q`, ignoring case."""
    q = str(q or "").strip().lower()
    if not q:
        return {"q": q, "rows": []}
    if _LOWER["id"] != id(index):
        _LOWER.update(id=id(index), texts=[s.lower() for s in index["added"]])
    return {"q": q, "rows": [i for i, s in enumerate(_LOWER["texts"]) if q in s]}


def _record(index, i):
    """One save in full: the fields its line holds, its body, the lines it added (`added_lines`, their numbers in the
    body from 0), the lines it removed, what the reader made of it and the row of the save before it on its page."""
    rows = index["rows"]
    if not isinstance(i, int) or isinstance(i, bool) or not 0 <= i < len(rows):
        return None
    row = rows[i]
    r = _line(index, row[L]) or {}
    body = r.get("body") if isinstance(r.get("body"), str) else ""
    page_rows = index["page_rows"][row[PG]]
    at = page_rows.index(i) if i in page_rows else -1
    before = page_rows[at - 1] if at > 0 else None
    prev_body = ""
    after_delete = row[L] in index["after_delete"]
    if before is not None and not after_delete:
        b = _line(index, rows[before][L]) or {}
        prev_body = b.get("body") if isinstance(b.get("body"), str) else ""
    added_at, removed = _diff(prev_body, body)
    page = index["pages"][row[PG]]
    return {"row": i, "ref": _ref(index, i), "rev_id": r.get("rev_id"), "page_id": r.get("page_id"),
            "name": r.get("name"), "seq": r.get("seq"), "time": r.get("time"), "label": r.get("label"),
            "ip16": r.get("ip16"), "change_summary": r.get("change_summary"), "body_len": r.get("body_len"),
            "request_action": r.get("request_action"), "body": body, "added_lines": added_at,
            "removed_lines": removed[:400], "removed_more": max(0, len(removed) - 400),
            "task": TASKS[row[TK]][1], "kind": KINDS[row[K]], "signature": index["sigs"][row[SG]],
            "n_added": row[NA], "n_removed": row[NR], "earlier_lost": at == 0 and page["first"] > 1,
            "after_delete": after_delete, "before_row": before}


def records(index, query):
    """{op: overview, from?, keep?}: a page of the kept rows as columns (_overview). {op: texts, rows}: their added text.
    {op: search, q}: the rows whose added text holds q. {op: record, r}: one save in full (_record)."""
    query = query or {}
    op = query.get("op")
    keep = {x for x in query.get("keep") or () if isinstance(x, int) and not isinstance(x, bool)}
    if op == "texts":
        return {"texts": _texts(index, list(query.get("rows") or []))}
    if op == "search":
        return _search(index, query.get("q"))
    if op == "record":
        return _record(index, query.get("r"))
    start = query.get("from")
    return _overview(index, keep, start if isinstance(start, int) and not isinstance(start, bool) else 0)


# ---------------------------------------------------------------- places


def _unit(index, found, label, key, target):
    lines = [index["added"][i].split("\n", 1)[0] for i in found if index["added"][i]][:EXCERPT_ROWS]
    return {"excerpt": "\n".join(lines), "label": label, "refs": [_ref(index, i) for i in found[:UNIT_REFS]],
            "key": key, "target": target}


def resolve(index, locator):
    """<file>#L<n>: the save on that line (or the nearest line with one), opened in its task's thread with its page
    beside it. view:<slug>/<task key>: that task's thread. view:<slug>/<page_key or page_id>: one page's messages."""
    rows = index["rows"]
    if "key" in locator:
        key = str(locator["key"])
        for f, (k, name, _) in enumerate(TASKS):
            if k.lower() == key.lower():
                found = [i for i, row in enumerate(rows) if row[TK] == f and row[K]]
                if not found:
                    return None
                return _unit(index, found, f"{name} · {len(found):,} messages", k, {"task": k})
        for p, page in enumerate(index["pages"]):
            if key in (page["key"], page["id"]):
                found = [i for i in index["page_rows"][p] if rows[i][K]]
                if found:
                    return _unit(index, found, f"{page['name']} · {len(found):,} messages", page["key"],
                                 {"page": page["key"]})
                # a page whose saves add no new text: its saves, the first line of the first one's body as excerpt
                saves = index["page_rows"][p]
                if not saves:
                    return None
                r = _line(index, rows[saves[0]][L]) or {}
                first = next((s for s in str(r.get("body") or "").splitlines() if s.strip()), "") or str(r.get("rev_id") or "")
                if not first:
                    return None
                return {"excerpt": first, "label": f"{page['name']} · {len(saves):,} {'save' if len(saves) == 1 else 'saves'}, no new text",
                        "refs": [_ref(index, i) for i in saves[:UNIT_REFS]], "key": page["key"], "target": {"page": page["key"]}}
        return None
    m = re.fullmatch(r"L(\d+)", str(locator.get("fragment") or ""))
    if not m or not index["path"] or os.path.normpath(str(locator.get("path") or "")) != os.path.normpath(index["path"]):
        return None
    n = int(m.group(1))
    i = index["row_at"].get(n)
    if i is None:
        lines = sorted(index["row_at"])
        if not lines:
            return None
        k = bisect.bisect_left(lines, n)
        n = lines[min(k, len(lines) - 1)]
        i = index["row_at"][n]
    row = rows[i]
    page = index["pages"][row[PG]]
    user = index["users"][row[U]]
    text = index["added"][i]
    if not text:  # a save that adds no new text: its page, else what its line says of it
        r = _line(index, row[L]) or {}
        text = next((str(r[k]) for k in ("body", "change_summary", "rev_id") if r.get(k)), "")
    if not text:
        return None
    return {"excerpt": text, "label": f"{page['name']} · {user or 'no username'} · {_when(row[T])}",
            "refs": [f"{index['path']}#L{row[L]}"], "key": TASKS[row[TK]][0], "target": {"r": i}}


def problems(index):
    return index["problems"]


def unplaced(index):
    return []


def hidden(index):
    if not index.get("events"):
        return []
    return [{"path": index["events"], "why": "Read only for the delete times, so that a save after a delete of its page "
             "is compared with an empty page. The deletes and the logged requests show in Wiki Page History."}]
