# Wiki Page History: every page of a few wikis with its saved revisions and the administrator's deletes, and one
# page's history read as the wiki showed it, each revision against the one before.
#
# The data, four JSON Lines files, one object per line:
#   revisions.jsonl  one saved revision of a page: rev_id (<page_key>@<seq>), page_id (<wiki>/<name>), page_key
#                    (<wiki>~<name>, a / in the name written ~2f), wiki, name, seq (the page's revision number, which
#                    goes on after a delete), body (the page's whole text after the save), body_len, lines, label (the
#                    username the editor gave, "" for none), ip16 (the first two parts of the editor's IP), time and
#                    write_date (the same UTC time), request_action (form_edit or null) and change_summary
#   events.jsonl     what the wiki logged: event_type save (one per revision, with revision_ref, its rev_id), delete
#                    (the administrator's: actor_label, ip16, change_summary "Seite gelöscht.", page, page_key and wiki)
#                    or request (a browse, search or preference request, with no page); time in UTC
#   pages.jsonl      one page that has stored revisions: page_key, wiki, name, n_revs, n_revs_before (its revisions
#                    from before the files begin, which they do not hold), first_write, last_write and its usernames
#   labels.jsonl     one username: label, stored_revisions, first_write, last_write, the pages it saved, its wikis, and
#                    role on the administrator's
#
# What the reader cleans and computes:
#   - times become seconds since 1970, read as UTC
#   - a delete names its page by page_key; a page no line of pages.jsonl lists (one deleted with no revision stored)
#     is a page all the same, named by the delete's wiki and page
#   - a page's records are its revisions and deletes in time order; the save events repeat the revisions and open
#     them, and a request names no page, so neither is a record of its own
#   - `before` is the text a revision changed: the revision before it, or an empty page for the first stored one and
#     for the first save after a delete, as the wiki showed a deleted page new again
#   - `after` is said of the first save after a delete: restored when its text is the one the page had before the
#     delete, else re-created
#   - a line that does not parse, or a record with no page or no time, is no record, and problems() lists it; a save
#     event whose revision no line of revisions.jsonl holds, and a request, which names no page, are listed by
#     unplaced()
#
# The method: the index keeps each record as a short row (kind, page, time, username, IP prefix, line, revision
# number, change summary, after) and the byte offset of every line; a revision's text is read back from its line when
# the page opens its history, a window of it at a time.
#
# What the page asks (records(index, query)):
#   {op: overview, color, filter}   the pages and, as columns, every record Filter by and the label filter keep, with
#                                   its Color by value, which the page counts in the time range
#   {op: page, key, color, filter}  one page's facts and its records, kept as above
#   {op: bodies, key, at}           the texts of the page's records at those places, each with the text it changed
#   {op: user, name}                one username's line of labels.jsonl
# Places: L<n> of any of the four files: a revision or a delete in its page's history, a page or a username.
# Units: <page_key>, one page's history; user/<username>, the pages one username saved.
import json
import zlib
from datetime import datetime, timezone

import thimble

SAVE, DELETE = 0, 1
KINDS = ("save", "delete")
# a record's row: kind, page, time, user, ip16, line, seq, summary, after
K, P, T, U, IP, LN, SEQ, SUM, AFT = range(9)
FILES = ("revisions.jsonl", "events.jsonl", "pages.jsonl", "labels.jsonl")
UNIT_REFS = 200
EXCERPT_MAX = 300


def _epoch(s):
    if not isinstance(s, str) or not s:
        return None
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return int(dt.timestamp())


def _iso(t):
    return datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m-%d %H:%M")


def _s(v):
    return "" if v is None else str(v)


def _lines(path, offs):
    """(line number, parsed object or None, text) of every line, recording each line's byte offset."""
    with open(path, "rb") as fh:
        pos = 0
        for n, raw in enumerate(fh, 1):
            offs.append(pos)
            pos += len(raw)
            text = raw.decode("utf-8", "replace").strip()
            if not text:
                yield n, None, ""
                continue
            try:
                obj = json.loads(text)
            except ValueError:
                obj = False
            yield n, obj, text


def build_index(paths):
    files = {}
    for p in paths:
        name = str(p).replace("\\", "/").rsplit("/", 1)[-1]
        if name in FILES and name not in files:
            files[name] = str(p)
    offsets = {}
    problems, unplaced = [], []
    pages, page_at = [], {}
    users, user_at = [""], {"": 0}
    recs = []
    rev_line = {}  # rev_id -> rec
    save_lines = []  # (events line, revision_ref)
    page_meta = {}  # page_key -> (pages.jsonl line, n_revs_before)
    user_meta = {}  # username -> (labels.jsonl line, role)
    requests = {}  # events.jsonl line of each request
    hashes = []  # per rec, the body's checksum (revisions) or None

    def page(key, wiki, name):
        i = page_at.get(key)
        if i is None:
            i = page_at[key] = len(pages)
            pages.append({"key": key, "wiki": wiki or key.split("~", 1)[0], "name": name or key.split("~", 1)[-1]})
        return i

    def user(name):
        name = _s(name).strip()
        i = user_at.get(name)
        if i is None:
            i = user_at[name] = len(users)
            users.append(name)
        return i

    def bad(path, n, why):
        problems.append({"ref": f"{path}#L{n}", "why": why})

    for role in FILES:
        path = files.get(role)
        if path is None:
            continue
        offs = offsets[path] = []
        for n, r, text in _lines(path, offs):
            if r is None:
                continue
            if r is False or not isinstance(r, dict):
                bad(path, n, "not a whole JSON object")
                continue
            if role == "revisions.jsonl":
                key, t = _s(r.get("page_key")), _epoch(r.get("time") or r.get("write_date"))
                if not key or t is None:
                    bad(path, n, "a revision with no page" if not key else "a revision with no time")
                    continue
                pi = page(key, r.get("wiki"), r.get("name"))
                body = _s(r.get("body"))
                rec = [SAVE, pi, t, user(r.get("label")), _s(r.get("ip16")), n,
                       r.get("seq") if isinstance(r.get("seq"), int) else 0, _s(r.get("change_summary")), ""]
                if r.get("rev_id"):
                    rev_line[_s(r["rev_id"])] = len(recs)
                recs.append(rec)
                hashes.append(zlib.crc32(body.encode("utf-8")) ^ len(body))
            elif role == "events.jsonl":
                kind = r.get("event_type")
                if kind == "save":
                    save_lines.append((n, _s(r.get("revision_ref"))))
                elif kind == "request":
                    unplaced.append({"ref": f"{path}#L{n}", "why": "a request, which names no page"})
                    requests[str(n)] = 1
                elif kind == "delete":
                    key, t = _s(r.get("page_key")), _epoch(r.get("time"))
                    if not key or t is None:
                        bad(path, n, "a delete with no page" if not key else "a delete with no time")
                        continue
                    pi = page(key, r.get("wiki"), r.get("page"))
                    recs.append([DELETE, pi, t, user(r.get("actor_label")), _s(r.get("ip16")), n, 0,
                                 _s(r.get("change_summary")), ""])
                    hashes.append(None)
            elif role == "pages.jsonl":
                key = _s(r.get("page_key"))
                if not key:
                    bad(path, n, "a page with no page_key")
                    continue
                page(key, r.get("wiki"), r.get("name"))
                before = r.get("n_revs_before")
                page_meta[key] = (n, before if isinstance(before, int) else 0)
            elif role == "labels.jsonl":
                if "label" not in r:
                    bad(path, n, "a username's line with no label")
                    continue
                user_meta[_s(r.get("label")).strip()] = (n, _s(r.get("role")))
    thimble.progress(3, 4, "ordering each page's records")
    items = [[] for _ in pages]
    for i, rec in enumerate(recs):
        items[rec[P]].append(i)
    for lst in items:
        lst.sort(key=lambda i: (recs[i][T], recs[i][K], recs[i][SEQ]))
        last, deleted = None, False
        for i in lst:
            if recs[i][K] == DELETE:
                deleted = True
                continue
            if deleted:
                recs[i][AFT] = "restored" if hashes[i] == last else "re-created"
                deleted = False
            last = hashes[i]
    by_line = {"revisions.jsonl": {}, "events.jsonl": {}}
    for i, rec in enumerate(recs):
        by_line["revisions.jsonl" if rec[K] == SAVE else "events.jsonl"][str(rec[LN])] = i
    save_at = {}
    for n, ref in save_lines:
        i = rev_line.get(ref)
        if i is None:
            unplaced.append({"ref": f"{files['events.jsonl']}#L{n}", "why": "a save whose revision revisions.jsonl does not hold"})
        else:
            save_at[str(n)] = i
    for p in pages:
        meta = page_meta.get(p["key"])
        p["line"], p["before"] = meta if meta else (0, 0)
    uline = {}
    for name, (n, role) in user_meta.items():
        uline[name] = [n, role]
    pline = {str(p["line"]): i for i, p in enumerate(pages) if p["line"]}
    ulines = {str(n): name for name, (n, _) in user_meta.items()}
    return {"files": files, "offsets": offsets, "pages": pages, "page_at": page_at, "users": users,
            "user_at": user_at, "recs": recs, "items": items, "by_line": by_line, "save_at": save_at,
            "user_meta": uline, "requests": requests, "page_line": pline, "user_line": ulines, "problems": problems, "unplaced": unplaced}


# ------------------------------------------------------------------------------------------------ reading back


def _ref(index, i):
    rec = index["recs"][i]
    return f"{index['files']['revisions.jsonl' if rec[K] == SAVE else 'events.jsonl']}#L{rec[LN]}"


def _fields(index, i):
    """The record's fields as Color by and Filter by read them."""
    rec = index["recs"][i]
    return {"kind": KINDS[rec[K]], "wiki": index["pages"][rec[P]]["wiki"], "user": index["users"][rec[U]],
            "after": rec[AFT]}


def _read(index, role, n):
    path = index["files"].get(role)
    offs = index["offsets"].get(path) if path else None
    if not offs or not 0 < n <= len(offs):
        return None
    with open(path, "rb") as fh:
        fh.seek(offs[n - 1])
        raw = fh.readline()
    try:
        r = json.loads(raw.decode("utf-8", "replace"))
    except ValueError:
        return None
    return r if isinstance(r, dict) else None


def _body(index, i):
    rec = index["recs"][i]
    if rec[K] != SAVE:
        return None
    r = _read(index, "revisions.jsonl", rec[LN])
    return _s(r.get("body")) if r else ""


def _before(index, pi, pos):
    """The text the record at `pos` of the page changed: the revision before it, '' after a delete or at the start."""
    lst = index["items"][pi]
    if pos <= 0 or index["recs"][lst[pos - 1]][K] == DELETE:
        return ""
    return _body(index, lst[pos - 1])


def _keeps(index, i, filt):
    ref = _ref(index, i)
    if not thimble.kept(ref):
        return False
    return thimble.color_on(filt, thimble.color_value(filt, ref, _fields(index, i)))


# ------------------------------------------------------------------------------------------------ the answers


def _overview(index, query):
    choice, filt = query.get("color"), query.get("filter")
    recs, pages = index["recs"], index["pages"]
    values, vat = [], {}
    ev = {"t": [], "p": [], "k": [], "u": [], "v": []}
    counts, fcounts = {}, {}
    shown = set()
    for i, rec in enumerate(recs):
        ref = _ref(index, i)
        if not thimble.kept(ref):
            continue
        f = _fields(index, i)
        fv = thimble.color_value(filt, ref, f)
        fcounts[fv or ""] = fcounts.get(fv or "", 0) + 1
        if not thimble.color_on(filt, fv):
            continue
        v = thimble.color_value(choice, ref, f)
        counts[v or ""] = counts.get(v or "", 0) + 1
        if v is None:
            vi = -1
        else:
            vi = vat.get(v)
            if vi is None:
                vi = vat[v] = len(values)
                values.append(v)
        ev["t"].append(rec[T])
        ev["p"].append(rec[P])
        ev["k"].append(rec[K])
        ev["u"].append(rec[U])
        ev["v"].append(vi)
        shown.add(rec[P])
    out = [{"p": pi, "key": pages[pi]["key"], "wiki": pages[pi]["wiki"], "name": pages[pi]["name"],
            "before": pages[pi]["before"]} for pi in sorted(shown)]
    times = [rec[T] for rec in recs]
    return {"pages": out, "users": index["users"], "values": values, "ev": ev, "counts": counts, "fcounts": fcounts,
            "span": [min(times), max(times)] if times else [0, 1]}


def _page(index, query):
    pi = index["page_at"].get(_s(query.get("key")))
    if pi is None:
        return None
    choice, filt = query.get("color"), query.get("filter")
    p = index["pages"][pi]
    out = []
    for pos, i in enumerate(index["items"][pi]):
        if not _keeps(index, i, filt):
            continue
        rec, ref = index["recs"][i], _ref(index, i)
        f = _fields(index, i)
        out.append({"pos": pos, "ref": ref, "t": rec[T], "kind": f["kind"], "wiki": f["wiki"], "user": f["user"],
                    "ip": rec[IP], "seq": rec[SEQ], "summary": rec[SUM], "after": rec[AFT],
                    "value": thimble.color_value(choice, ref, f)})
    pref = f"{index['files']['pages.jsonl']}#L{p['line']}" if (p["line"] and "pages.jsonl" in index["files"]) else None
    return {"key": p["key"], "wiki": p["wiki"], "name": p["name"], "before": p["before"], "ref": pref,
            "total": len(index["items"][pi]), "items": out}


def _bodies(index, query):
    pi = index["page_at"].get(_s(query.get("key")))
    if pi is None:
        return None
    lst = index["items"][pi]
    out = {}
    for pos in query.get("at") or []:
        if not isinstance(pos, int) or isinstance(pos, bool) or not 0 <= pos < len(lst):
            continue
        i = lst[pos]
        if index["recs"][i][K] == SAVE:
            out[str(pos)] = {"body": _body(index, i), "before": _before(index, pi, pos)}
    return {"key": index["pages"][pi]["key"], "bodies": out}


def _user(index, query):
    name = _s(query.get("name")).strip()
    meta = index["user_meta"].get(name)
    if meta is None or "labels.jsonl" not in index["files"]:
        return {"name": name, "ref": None, "role": ""}
    return {"name": name, "ref": f"{index['files']['labels.jsonl']}#L{meta[0]}", "role": meta[1]}


def records(index, query):
    query = query or {}
    op = query.get("op")
    if op == "page":
        return _page(index, query)
    if op == "bodies":
        return _bodies(index, query)
    if op == "user":
        return _user(index, query)
    return _overview(index, query)


# ------------------------------------------------------------------------------------------------ citations


def _first_change(before, body):
    """A line of the body the revision added, word for word, else its first line with words."""
    old = set(before.split("\n"))
    lines = [s for s in body.split("\n") if s.strip()]
    pick = next((s for s in lines if s not in old), lines[0] if lines else "")
    return pick.strip()[:EXCERPT_MAX]


def _page_unit(index, pi, extra=()):
    p = index["pages"][pi]
    lst = index["items"][pi]
    saves = sum(1 for i in lst if index["recs"][i][K] == SAVE)
    dels = len(lst) - saves
    words = f"{saves} revision{'s' if saves != 1 else ''}" + (f", {dels} delete{'s' if dels != 1 else ''}" if dels else "")
    return {"excerpt": p["name"], "label": f"{p['wiki']}/{p['name']} · {words}",
            "refs": [*extra, *(_ref(index, i) for i in lst[:UNIT_REFS])], "key": p["key"], "target": {"page": p["key"]}}


def _user_unit(index, name, extra=()):
    u = index["user_at"].get(name)
    if u is None or not name:
        return None
    mine = [i for i, rec in enumerate(index["recs"]) if rec[U] == u]
    if not mine and not extra:
        return None
    pages = len({index["recs"][i][P] for i in mine})
    return {"excerpt": name, "label": f"{name} · {len(mine)} records on {pages} page{'s' if pages != 1 else ''}",
            "refs": [*extra, *(_ref(index, i) for i in mine[:UNIT_REFS])], "key": "user/" + name,
            "target": {"user": name}}


def _record_place(index, i, asked):
    rec = index["recs"][i]
    p = index["pages"][rec[P]]
    who = index["users"][rec[U]] or "no username"
    if rec[K] == DELETE:
        excerpt = rec[SUM] or "deleted"
        label = f"{p['name']} deleted by {who} · {_iso(rec[T])}"
    else:
        pos = index["items"][rec[P]].index(i)
        body = _body(index, i) or ""
        excerpt = _first_change(_before(index, rec[P], pos), body) or who
        label = f"{p['name']} rev {rec[SEQ]} · {who} · {_iso(rec[T])}"
    ref = _ref(index, i)
    refs = [ref] if asked == ref else [asked, ref]
    return {"excerpt": excerpt, "label": label, "refs": refs, "key": p["key"], "target": {"page": p["key"], "ref": ref}}


def resolve(index, locator):
    if "key" in locator:
        key = _s(locator.get("key"))
        if key.startswith("user/"):
            return _user_unit(index, key[5:])
        pi = index["page_at"].get(key)
        return None if pi is None else _page_unit(index, pi)
    path, frag = _s(locator.get("path")), _s(locator.get("fragment"))
    role = next((r for r, p in index["files"].items() if p == path), None)
    if role is None or not frag.startswith("L") or not frag[1:].isdigit():
        return None
    n = frag[1:]
    asked = f"{path}#L{n}"
    if role in ("revisions.jsonl", "events.jsonl"):
        i = index["by_line"][role].get(n)
        if i is None and role == "events.jsonl":
            i = index["save_at"].get(n)
        if i is None and role == "events.jsonl" and n in index.get("requests", {}):
            r = _read(index, role, int(n))
            if not r:
                return None
            t = _epoch(r.get("time"))
            what = _s(r.get("request") or r.get("request_action")) or "request"
            return {"excerpt": what, "label": f"request · {_s(r.get('ip16'))} · {_iso(t) if t else ''}".strip(" ·"),
                    "refs": [asked], "key": None, "target": {"request": r, "ref": asked}}
        return None if i is None else _record_place(index, i, asked)
    if role == "pages.jsonl":
        pi = index["page_line"].get(n)
        return None if pi is None else _page_unit(index, pi, [asked])
    name = index["user_line"].get(n)
    return None if name is None else _user_unit(index, name, [asked])


def problems(index):
    return index["problems"]


def unplaced(index):
    return index["unplaced"]


def derived(index):
    return [
        {"record": "revision", "field": "before", "kind": "computed", "from": "the page's revisions and deletes in time order",
         "how": "the text of the revision before, empty for the first stored one and after a delete"},
        {"record": "revision", "field": "after", "kind": "computed", "from": "the page's revisions and deletes in time order",
         "how": "restored when the first save after a delete has the text from before it, else re-created"},
    ]
