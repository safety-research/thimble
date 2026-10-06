# Wiki Page History: the edit log of public wikis that agents used as a scratchpad and message board, read one page
# at a time as a wiki shows its history, each edit as the lines it added and removed.
#
# The files:
#   pages.jsonl      one line per page: page_id (wiki/name), page_key (wiki~name), wiki, name, n_revs (stored
#                    revisions), n_revs_before (earlier revisions the corpus withholds), first_write, last_write,
#                    body_bytes, labels (the usernames that edited it), n_labels, n_ips, n_ip16
#   revisions.jsonl  one line per stored revision: rev_id, page_id, page_key, wiki, name, seq, body (the whole page
#                    again), body_len, lines, label (the username, "" when anonymous), ip16, time, write_date,
#                    request_action, change_summary
#   events.jsonl     the wikis' events in time order: save (one per revision, revision_ref its rev_id), delete (page_key,
#                    actor_label, ip16, change_summary) and request (an HTTP request to a wiki: ip16, request_action,
#                    request, label, referrer)
#   labels.jsonl     one line per username (label): stored_revisions, first_write, last_write, pages, wikis and counts
#
# What the reader makes of them:
#   history     a page's revisions by seq, its delete events and the requests that name it, merged in time order; an
#               event goes before the first revision written after it
#   diff        each revision compared line by line with the one before it, or with an empty page when it is the
#               page's first or comes after a delete (the wiki then starts the page again from its template), and
#               not at all when the corpus withholds the revisions before it; `add` and `rem` count the lines
#   admin       a revision whose username is one that deleted pages
#   save        a revision's kind as the history reads it, the base its diff is against: a new page (the page's first
#               revision), an edit (against the revision before), after a delete (against an empty page) or the first
#               stored (earlier revisions withheld); the page colours saves by it
#   placement   a request names a page by the id or keywords in its URL; a delete of a page pages.jsonl does not list,
#               a request that names no listed page and a save whose revision is missing are read but not placed, and
#               unplaced() lists them
#   missing     a page pages.jsonl does not list but revisions name is made from its revisions; a username labels.jsonl
#               does not list is made from the revisions it wrote
#   bad lines   a line that is not a JSON object, or lacks what places it (a page's page_id, a revision's page and seq,
#               an event's type and time), is no record, and problems() lists it
#
# The method: the index keeps every page's fields, every revision as small columns (page, seq, time, username, ip,
# change summary, line, diff counts) and the byte offset of every line; bodies are read back from revisions.jsonl by
# seeking to their lines, so a diff is worked out again when the page shows it. Labels apply when records are served:
# a page stays when thimble.kept_unit holds for its records (its pages.jsonl line, its deletes and its revisions), a
# revision or an event when thimble.kept holds for its line, and each carries the marks thimble.marked gives it, from
# which the page reads the value of the label its Color by control colors by.
import difflib
import json
import re
from datetime import datetime, timezone

import thimble

FILES = ("pages.jsonl", "revisions.jsonl", "events.jsonl", "labels.jsonl")
WITHHELD = "[pre-2026 line withheld]"
MARKS_MAX = 24  # label values the page tells apart, as bits of one number per record
BASES = ("new", "prev", "deleted", "withheld")  # a revision's base, sent as its index in the overview's `rk`
BLOCKS_MAX = 120  # history items one page fetch reads in full
CONTEXT = 2  # unchanged lines kept around a change
EXCERPT_LINES = 30  # lines a revision's citation quotes
PAIR_RATIO = 0.45  # how alike a removed and an added line must be for the characters that changed to be marked
SAFE_KEY = re.compile(r"[A-Za-z0-9_.~/-]+")
REQUEST_PAGE = re.compile(r"(?:[?&;]id=|[?&;]keywords=)([^&;#\s]+)")


def _epoch(v):
    if not isinstance(v, str) or not v.strip():
        return None
    try:
        dt = datetime.fromisoformat(v.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    return int((dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)).timestamp())


def _int(v, default=0):
    return v if isinstance(v, int) and not isinstance(v, bool) else default


def _str(v):
    return v if isinstance(v, str) else ("" if v is None else str(v))


def _role(path):
    base = str(path).replace("\\", "/").rsplit("/", 1)[-1]
    return base if base in FILES else None


def _read(path, offs, problems):
    """(line number, object) of every line of a JSON lines file that parses as an object, recording each line's byte
    offset in `offs`; a line that does not is a problem."""
    try:
        fh = open(path, "rb")
    except OSError:
        return
    with fh:
        pos = 0
        for n, raw in enumerate(fh, 1):
            offs.append(pos)
            pos += len(raw)
            if not raw.strip():
                continue
            try:
                obj = json.loads(raw)
            except ValueError:
                problems.append({"ref": f"{path}#L{n}", "why": "not a whole JSON object (a line cut short or broken)"})
                continue
            if not isinstance(obj, dict):
                problems.append({"ref": f"{path}#L{n}", "why": "not a JSON object"})
                continue
            yield n, obj


# ---------------------------------------------------------------- diffs


def _split(body):
    return body.split("\n") if body else []


def _counts(a, b):
    """(lines added, lines removed) from a to b."""
    add = rem = 0
    for op, i1, i2, j1, j2 in difflib.SequenceMatcher(None, a, b, autojunk=False).get_opcodes():
        if op != "equal":
            rem += i2 - i1
            add += j2 - j1
    return add, rem


def _spans(a, b):
    """The character ranges of a and of b that differ, when the two lines are alike enough to pair, else None."""
    if len(a) > 4000 or len(b) > 4000:
        return None
    sm = difflib.SequenceMatcher(None, a, b, autojunk=False)
    if sm.ratio() < PAIR_RATIO:
        return None
    sa, sb = [], []
    for op, i1, i2, j1, j2 in sm.get_opcodes():
        if op != "equal":
            if i2 > i1:
                sa.append([i1, i2])
            if j2 > j1:
                sb.append([j1, j2])
    return sa, sb


def _diff(a, b):
    """The lines of a diff from a to b: [" ", text] unchanged, ["+", text, spans?] added, ["-", text, spans?] removed
    (spans: the characters that changed, when the line pairs with one on the other side), ["~", n] n unchanged lines
    left out. Unchanged lines are kept CONTEXT around each change."""
    out = []
    ops = difflib.SequenceMatcher(None, a, b, autojunk=False).get_opcodes()
    for k, (op, i1, i2, j1, j2) in enumerate(ops):
        if op == "equal":
            run = a[i1:i2]
            head = CONTEXT if k > 0 else 0
            tail = CONTEXT if k < len(ops) - 1 else 0
            if len(run) <= head + tail + 1:
                out += [[" ", s] for s in run]
            else:
                out += [[" ", s] for s in run[:head]]
                out.append(["~", len(run) - head - tail])
                out += [[" ", s] for s in run[len(run) - tail:]]
            continue
        old, new = a[i1:i2], b[j1:j2]
        pairs = {}
        if op == "replace":
            for x in range(min(len(old), len(new))):
                sp = _spans(old[x], new[x])
                if sp:
                    pairs[x] = sp
        out += [["-", s, pairs[x][0]] if x in pairs else ["-", s] for x, s in enumerate(old)]
        out += [["+", s, pairs[x][1]] if x in pairs else ["+", s] for x, s in enumerate(new)]
    return out


# ---------------------------------------------------------------- the index


def build_index(paths):
    """{files: {name: path}, offsets: {path: [byte offset of line n at n-1]}, pages: [page], page_of: {page_id: i},
    page_by_key: {page_key: i}, the revisions as columns (r_page, r_seq, r_t, r_user, r_ip, r_cs, r_line, r_len,
    r_lines, r_add, r_rem, r_base, r_pos), page_revs: [[revision] by seq per page], deletes: [[t, line, page, actor, ip]],
    page_dels: [[delete] per page], requests: [[t, line, page]], page_reqs, items: [[(kind, i)] in time order per
    page], event_at: {events line: (kind, i)}, rev_at: {revisions line: i}, page_at: {pages line: i}, users: [name],
    user_at: {name: i}, user_line: {name: labels line}, ips: [ip16], admins: [actor], problems, unplaced}."""
    files = {}
    for p in paths:
        r = _role(p)
        if r and r not in files:
            files[r] = p
    problems, unplaced, offsets = [], [], {}
    users, user_at, ips, ip_at = [], {}, [], {}

    def user(name):
        name = _str(name)
        if name not in user_at:
            user_at[name] = len(users)
            users.append(name)
        return user_at[name]

    def ip(v):
        v = _str(v)
        if v not in ip_at:
            ip_at[v] = len(ips)
            ips.append(v)
        return ip_at[v]

    # pages.jsonl
    pages, page_of, page_by_key = [], {}, {}
    path = files.get("pages.jsonl")
    if path:
        offs = offsets.setdefault(path, [])
        thimble.progress(0, 4, "reading the pages")
        for n, o in _read(path, offs, problems):
            pid = _str(o.get("page_id")).strip()
            if not pid:
                problems.append({"ref": f"{path}#L{n}", "why": "a page with no page_id"})
                continue
            if pid in page_of:
                problems.append({"ref": f"{path}#L{n}", "why": f"a second line for the page {pid}; the first is shown"})
                continue
            wiki, _, name = pid.partition("/")
            pg = {"id": pid, "key": _str(o.get("page_key")) or pid.replace("/", "~", 1),
                  "wiki": _str(o.get("wiki")) or wiki, "name": _str(o.get("name")) or name or pid, "line": n,
                  "n_revs": _int(o.get("n_revs")), "n_before": _int(o.get("n_revs_before")),
                  "first": _epoch(o.get("first_write")), "last": _epoch(o.get("last_write")),
                  "n_labels": _int(o.get("n_labels"))}
            page_of[pid] = len(pages)
            page_by_key[pg["key"]] = len(pages)
            pages.append(pg)

    # revisions.jsonl
    cols = {k: [] for k in ("r_page", "r_seq", "r_t", "r_user", "r_ip", "r_cs", "r_line", "r_len", "r_lines")}
    bodies, rev_id_at, made = [], {}, set()
    path = files.get("revisions.jsonl")
    if path:
        offs = offsets.setdefault(path, [])
        thimble.progress(1, 4, "reading the revisions")
        for n, o in _read(path, offs, problems):
            pid = _str(o.get("page_id")).strip()
            if not pid and o.get("page_key"):
                pid = _str(o.get("page_key")).replace("~", "/", 1)
            seq, t = o.get("seq"), _epoch(o.get("time")) or _epoch(o.get("write_date"))
            if not pid or not isinstance(seq, int) or isinstance(seq, bool) or t is None:
                problems.append({"ref": f"{path}#L{n}", "why": "a revision without its page, seq or a time the reader can read"})
                continue
            if pid not in page_of:
                wiki, _, name = pid.partition("/")
                page_of[pid] = len(pages)
                key = _str(o.get("page_key")) or pid.replace("/", "~", 1)
                page_by_key.setdefault(key, len(pages))
                pages.append({"id": pid, "key": key, "wiki": _str(o.get("wiki")) or wiki,
                              "name": _str(o.get("name")) or name or pid, "line": 0, "n_revs": 0, "n_before": 0,
                              "first": None, "last": None, "n_labels": 0})
                made.add(page_of[pid])
            i = len(cols["r_page"])
            for k, v in (("r_page", page_of[pid]), ("r_seq", seq), ("r_t", t), ("r_user", user(o.get("label"))),
                         ("r_ip", ip(o.get("ip16"))), ("r_cs", o.get("change_summary") if isinstance(o.get("change_summary"), str) else None),
                         ("r_line", n), ("r_len", _int(o.get("body_len"))), ("r_lines", _int(o.get("lines")))):
                cols[k].append(v)
            bodies.append(_str(o.get("body")))
            if o.get("rev_id"):
                rev_id_at.setdefault(_str(o.get("rev_id")), i)

    page_revs = [[] for _ in pages]
    for i, p in enumerate(cols["r_page"]):
        page_revs[p].append(i)
    for p, revs in enumerate(page_revs):
        revs.sort(key=lambda i: (cols["r_seq"][i], cols["r_line"][i]))
        if p in made:  # a page pages.jsonl does not list, made from its revisions
            pg = pages[p]
            pg["n_revs"] = len(revs)
            pg["n_before"] = max(0, cols["r_seq"][revs[0]] - 1) if revs else 0
            pg["first"] = cols["r_t"][revs[0]] if revs else None
            pg["last"] = cols["r_t"][revs[-1]] if revs else None
            pg["n_labels"] = len({cols["r_user"][i] for i in revs})
    for pg in pages:
        if pg["first"] is None or pg["last"] is None:
            revs = page_revs[page_of[pg["id"]]]
            ts = [cols["r_t"][i] for i in revs]
            pg["first"] = pg["first"] if pg["first"] is not None else (min(ts) if ts else None)
            pg["last"] = pg["last"] if pg["last"] is not None else (max(ts) if ts else None)

    # events.jsonl
    deletes, requests, event_at = [], [], {}
    page_dels = [[] for _ in pages]
    page_reqs = [[] for _ in pages]
    path = files.get("events.jsonl")
    if path:
        offs = offsets.setdefault(path, [])
        thimble.progress(2, 4, "reading the events")
        for n, o in _read(path, offs, problems):
            kind, t = _str(o.get("event_type")), _epoch(o.get("time"))
            if not kind or t is None:
                problems.append({"ref": f"{path}#L{n}", "why": "an event without its type or a time the reader can read"})
                continue
            ref = f"{path}#L{n}"
            if kind == "save":
                i = rev_id_at.get(_str(o.get("revision_ref")))
                if i is None:
                    unplaced.append({"ref": ref, "why": "a save whose revision revisions.jsonl does not hold"})
                else:
                    event_at[n] = ("s", i)
            elif kind == "delete":
                key = _str(o.get("page_key")) or (f"{_str(o.get('wiki'))}~{_str(o.get('page'))}" if o.get("page") else "")
                p = page_by_key.get(key, -1)
                d = len(deletes)
                wiki, _, name = key.partition("~")
                deletes.append([t, n, p, _str(o.get("actor_label")), _str(o.get("ip16")),
                                _str(o.get("wiki")) or wiki, _str(o.get("page")) or name])
                event_at[n] = ("d", d)
                if p < 0:
                    unplaced.append({"ref": ref, "why": "a delete of a page with no stored revision, which pages.jsonl does not list"})
                else:
                    page_dels[p].append(d)
            elif kind == "request":
                wiki = _str(o.get("wiki")) or (_str(o.get("event_id")).split(":") + ["", ""])[1]
                m = REQUEST_PAGE.search(_str(o.get("request")))
                p = page_by_key.get(f"{wiki}~{m.group(1)}", -1) if m else -1
                q = len(requests)
                requests.append([t, n, p])
                event_at[n] = ("q", q)
                if p < 0:
                    unplaced.append({"ref": ref, "why": "a request to the wiki that names no page with stored revisions"})
                else:
                    page_reqs[p].append(q)
            else:
                unplaced.append({"ref": ref, "why": f"an event of the type {kind!r}, which the view does not show"})
                event_at[n] = ("x", -1)
    admins = sorted({d[3] for d in deletes if d[3]})

    # the diffs' counts, against the revision before, or an empty page after a delete
    thimble.progress(3, 4, "comparing revisions")
    r_add, r_rem, r_base = [0] * len(bodies), [0] * len(bodies), [""] * len(bodies)
    items = []
    for p, revs in enumerate(page_revs):
        dels = sorted(page_dels[p], key=lambda d: deletes[d][0])
        evs = sorted([(deletes[d][0], "d", d) for d in dels] + [(requests[q][0], "q", q) for q in page_reqs[p]])
        page_items, e, prev = [], 0, None
        for i in revs:
            t = cols["r_t"][i]
            gone = False
            while e < len(evs) and evs[e][0] < t:
                gone = gone or evs[e][1] == "d"
                page_items.append((evs[e][1], evs[e][2]))
                e += 1
            page_items.append(("r", i))
            if prev is None:
                base = "deleted" if gone else "withheld" if cols["r_seq"][i] > 1 or pages[p]["n_before"] > 0 else "new"
            else:
                base = "deleted" if gone else "prev"
            r_base[i] = base
            if base != "withheld":
                r_add[i], r_rem[i] = _counts(_split(bodies[prev]) if base == "prev" else [], _split(bodies[i]))
            prev = i
        page_items += [(k, x) for _, k, x in evs[e:]]
        items.append(page_items)
    del bodies

    # labels.jsonl
    user_line = {}
    path = files.get("labels.jsonl")
    if path:
        offs = offsets.setdefault(path, [])
        for n, o in _read(path, offs, problems):
            if not isinstance(o.get("label"), str):
                problems.append({"ref": f"{path}#L{n}", "why": "a username line with no label"})
                continue
            user_line.setdefault(o["label"], n)
    thimble.progress(4, 4, "done")

    r_pos = [0] * len(cols["r_page"])
    for revs in page_revs:
        for k, i in enumerate(revs):
            r_pos[i] = k
    rev_at = {ln: i for i, ln in enumerate(cols["r_line"])}
    page_at = {pg["line"]: i for i, pg in enumerate(pages) if pg["line"]}
    all_t = [t for t in cols["r_t"]] + [d[0] for d in deletes]
    return {"files": files, "offsets": offsets, "pages": pages, "page_of": page_of, "page_by_key": page_by_key,
            **cols, "r_add": r_add, "r_rem": r_rem, "r_base": r_base, "r_pos": r_pos, "page_revs": page_revs, "deletes": deletes,
            "page_dels": page_dels, "requests": requests, "page_reqs": page_reqs, "items": items,
            "event_at": event_at, "rev_at": rev_at, "page_at": page_at, "users": users, "user_at": user_at,
            "user_line": user_line, "ips": ips, "admins": admins, "made": sorted(made),
            "t0": min(all_t) if all_t else 0, "t1": max(all_t) if all_t else 0,
            "problems": problems, "unplaced": unplaced}


# ---------------------------------------------------------------- reading back


def _lines_of(index, name, numbers):
    """{line number: object} of the wanted lines of one of the files, read back by seeking to them."""
    path = index["files"].get(name)
    out = {}
    if not path:
        return out
    offs = index["offsets"].get(path) or []
    with open(path, "rb") as fh:
        for n in sorted(set(numbers)):
            if not 1 <= n <= len(offs):
                continue
            fh.seek(offs[n - 1])
            try:
                o = json.loads(fh.readline())
            except ValueError:
                continue
            if isinstance(o, dict):
                out[n] = o
    return out


def _ref(index, name, n):
    return f"{index['files'].get(name, name)}#L{n}"


def _rev_ref(index, i):
    return _ref(index, "revisions.jsonl", index["r_line"][i])


def _event_ref(index, n):
    return _ref(index, "events.jsonl", n)


def _page_ref(index, p):
    line = index["pages"][p]["line"]
    return _ref(index, "pages.jsonl", line) if line else None


def _page_refs(index, p):
    """The records a page gathers: its pages.jsonl line, its deletes and its revisions by seq."""
    out = [r] if (r := _page_ref(index, p)) else []
    out += [_event_ref(index, index["deletes"][d][1]) for d in index["page_dels"][p]]
    out += [_rev_ref(index, i) for i in index["page_revs"][p]]
    return out


def _page_named(index, key):
    """The page a key names: its page_id (dse/Name), its page_key (dse~Name), or its name alone, the page with the most
    revisions when several wikis have one, each ignoring case when nothing matches exactly; None for none."""
    key = key.strip()
    p = index["page_of"].get(key, index["page_by_key"].get(key))
    if p is not None:
        return p
    low = key.lower()
    hits = [i for i, pg in enumerate(index["pages"]) if low in (pg["id"].lower(), pg["key"].lower(), pg["name"].lower())]
    return max(hits, key=lambda i: index["pages"][i]["n_revs"]) if hits else None


def _unit_key(index, p):
    pid = index["pages"][p]["id"]
    return pid if SAFE_KEY.fullmatch(pid) else None


def _labels_on():
    on = thimble.view_labels() or {}
    marks = [{"label": lab.get("name"), "value": v.get("name"), "colour": v.get("colour")}
             for lab in on.get("labels") or [] for v in lab.get("values") or []][:MARKS_MAX]
    return marks, {(m["label"], m["value"]): k for k, m in enumerate(marks)}, bool(on.get("filter"))


def _bits(ref, mark_at):
    """(the index of the first of the marks the record takes, all of them as bits), (-1, 0) for none."""
    first, bits = -1, 0
    if ref and mark_at:
        for x in thimble.marked(ref):
            m = mark_at.get((x.get("label"), x.get("value")))
            if m is not None:
                first = m if first < 0 else first
                bits |= 1 << m
    return first, bits


# ---------------------------------------------------------------- answers


def _overview(index, keep):
    """Every page the label filter keeps, as columns: `p` its index, `ln` its pages.jsonl line, `w` its wiki (an index
    into `wikis`), `name`, `n` n_revs, `f` and `l` its first and last write in seconds since `t0`, `u` n_labels, `d` its
    deletes, `pm` the marks of its records as bits; its kept revisions as columns `rp` (page), `rt` (seconds since
    `t0`), `ru` (an index into `users`), `ra` and `rr` (lines added and removed), `rm` (first mark, -1 for none); and its
    deletes as `dp`, `dt`, `dm`; `rk` each revision's base (an index into BASES) and `rb` its marks as bits; and the
    deletes of pages with no stored revision, which pages.jsonl does not list, as `ot` (seconds since `t0`), `ow`
    (wiki, an index into `wikis`) and `on` (page name). `marks` lists the values of the labels that are on, `admins`
    the usernames that deleted pages."""
    marks, mark_at, filtering = _labels_on()
    t0 = index["t0"]
    wikis, wiki_at = [], {}
    P = {k: [] for k in ("p", "ln", "w", "name", "n", "f", "l", "u", "d", "pm")}
    R = {k: [] for k in ("rp", "rt", "ru", "ra", "rr", "rm", "rk", "rb")}
    D = {k: [] for k in ("dp", "dt", "dm")}
    for p, pg in enumerate(index["pages"]):
        if filtering and p not in keep and not thimble.kept_unit(_page_refs(index, p)):
            continue
        _, pm = _bits(_page_ref(index, p), mark_at)
        for i in index["page_revs"][p]:
            ref = _rev_ref(index, i)
            if filtering and p not in keep and not thimble.kept(ref):
                continue
            m, b = _bits(ref, mark_at)
            pm |= b
            for k, v in (("rp", p), ("rt", index["r_t"][i] - t0), ("ru", index["r_user"][i]), ("ra", index["r_add"][i]),
                         ("rr", index["r_rem"][i]), ("rm", m), ("rk", BASES.index(index["r_base"][i])), ("rb", b)):
                R[k].append(v)
        nd = 0
        for d in index["page_dels"][p]:
            t, line = index["deletes"][d][:2]
            ref = _event_ref(index, line)
            if filtering and p not in keep and not thimble.kept(ref):
                continue
            m, b = _bits(ref, mark_at)
            pm |= b
            nd += 1
            for k, v in (("dp", p), ("dt", t - t0), ("dm", m)):
                D[k].append(v)
        if pg["wiki"] not in wiki_at:
            wiki_at[pg["wiki"]] = len(wikis)
            wikis.append(pg["wiki"])
        for k, v in (("p", p), ("ln", pg["line"]), ("w", wiki_at[pg["wiki"]]), ("name", pg["name"]), ("n", pg["n_revs"]),
                     ("f", (pg["first"] or t0) - t0), ("l", (pg["last"] or t0) - t0), ("u", pg["n_labels"]), ("d", nd),
                     ("pm", pm)):
            P[k].append(v)
    G = {k: [] for k in ("ot", "ow", "on")}
    for d in index["deletes"]:
        if d[2] >= 0 or (filtering and not thimble.kept(_event_ref(index, d[1]))):
            continue
        if d[5] not in wiki_at:
            wiki_at[d[5]] = len(wikis)
            wikis.append(d[5])
        for k, v in (("ot", d[0] - t0), ("ow", wiki_at[d[5]]), ("on", d[6])):
            G[k].append(v)
    return {"t0": t0, "span": [0, index["t1"] - t0], "wikis": wikis, "users": index["users"], "pages": P, "revs": R,
            "dels": D, "gone": G, "marks": marks, "admins": index["admins"], "total": len(index["pages"]),
            "keys": [_unit_key(index, p) for p in P["p"]]}


def _history(index, p, user, keep, filtering):
    """The page's history items the filters keep, in order: (kind, i) with kind r, d or q."""
    out = []
    for kind, i in index["items"][p]:
        if kind == "r":
            if user is not None and index["users"][index["r_user"][i]] != user:
                continue
            ref = _rev_ref(index, i)
        else:
            ref = _event_ref(index, (index["deletes"] if kind == "d" else index["requests"])[i][1])
        if filtering and ref not in keep and not thimble.kept(ref):
            continue
        out.append((kind, i))
    return out


def _block_rev(index, i, row, bodies, mark_at):
    base = index["r_base"][i]
    body = _str(row.get("body"))
    if base == "withheld":
        diff = [[" ", s] for s in _split(body)]
    else:
        before = []
        if base == "prev":
            revs = index["page_revs"][index["r_page"][i]]
            before = _split(bodies.get(revs[index["r_pos"][i] - 1], ""))
        diff = _diff(before, _split(body))
    ref = _rev_ref(index, i)
    return {"ref": ref, "i": i, "rev_id": row.get("rev_id"), "seq": row.get("seq"), "time": row.get("time"),
            "label": row.get("label"), "ip16": row.get("ip16"), "change_summary": row.get("change_summary"),
            "body_len": row.get("body_len"), "lines": row.get("lines"), "write_date": row.get("write_date"),
            "request_action": row.get("request_action"), "base": base, "add": index["r_add"][i],
            "rem": index["r_rem"][i], "diff": diff, "admin": _str(row.get("label")) in index["admins"],
            "marks": [x for x in thimble.marked(ref)] if mark_at else []}


def _block_event(index, kind, i, row, mark_at):
    line = (index["deletes"] if kind == "d" else index["requests"])[i][1]
    ref = _event_ref(index, line)
    out = {"ref": ref, "event_id": row.get("event_id"), "kind": row.get("event_type"), "time": row.get("time"),
           "ip16": row.get("ip16"), "request_action": row.get("request_action"),
           "marks": [x for x in thimble.marked(ref)] if mark_at else []}
    if kind == "d":
        out.update(actor_label=row.get("actor_label"), change_summary=row.get("change_summary"))
    else:
        out.update(request=row.get("request"), label=row.get("label"), referrer=row.get("referrer"))
    return out


def _page(index, q):
    """One page: `page` its pages.jsonl fields with its ref and its delete count; `strip` every history item the label
    filter keeps, as columns `k` (r, d or q), `x` (the revision's or event's index), `t` (seconds since t0), `u`
    (username), `a` and `r` (lines added and removed), `m` (first mark), `s` (seq), `b` (marks as bits) and `kb` (a
    revision's base, an index into BASES, -1 for an event); `users` [[username index,
    revisions]] of the page; `total` the items the username filter `user` and the time range [`since`, `until`) (seconds
    since 1970, either left out for no bound) also keep; and `blocks`, those items from `from` (or from just before
    `focus`, a cited record kept whatever the label filter says) read in full."""
    p = q.get("p")
    if not isinstance(p, int) or not 0 <= p < len(index["pages"]):
        return None
    marks, mark_at, filtering = _labels_on()
    keep = {str(x) for x in q.get("keep") or []}
    user = q.get("user") if isinstance(q.get("user"), str) else None
    focus = q.get("focus") if isinstance(q.get("focus"), dict) else {}
    want = ("r", focus["rev"]) if isinstance(focus.get("rev"), int) else ("d", focus["del"]) if isinstance(focus.get("del"), int) \
        else ("q", focus["req"]) if isinstance(focus.get("req"), int) else None
    if want and want in index["items"][p]:  # a cited record shows whatever the label filter keeps
        keep.add(_rev_ref(index, want[1]) if want[0] == "r" else
                 _event_ref(index, (index["deletes"] if want[0] == "d" else index["requests"])[want[1]][1]))
    every = _history(index, p, None, keep, filtering)
    hist = every if user is None else _history(index, p, user, keep, filtering)
    since = q.get("since") if isinstance(q.get("since"), (int, float)) else None
    until = q.get("until") if isinstance(q.get("until"), (int, float)) else None
    if since is not None or until is not None:
        def _t(item):
            kind, i = item
            return index["r_t"][i] if kind == "r" else (index["deletes"] if kind == "d" else index["requests"])[i][0]
        hist = [x for x in hist if x == want or ((since is None or _t(x) >= since) and (until is None or _t(x) < until))]
    t0 = index["t0"]
    S = {k: [] for k in ("k", "x", "t", "u", "a", "r", "m", "s", "b", "kb")}
    for kind, i in every:
        if kind == "r":
            m, b = _bits(_rev_ref(index, i), mark_at)
            vals = ("r", i, index["r_t"][i] - t0, index["r_user"][i], index["r_add"][i], index["r_rem"][i],
                    m, index["r_seq"][i], b, BASES.index(index["r_base"][i]))
        else:
            e = (index["deletes"] if kind == "d" else index["requests"])[i]
            m, b = _bits(_event_ref(index, e[1]), mark_at)
            vals = (kind, i, e[0] - t0, index["user_at"].get(e[3], -1) if kind == "d" else -1, 0, 0, m, 0, b, -1)
        for k, v in zip(S, vals):
            S[k].append(v)
    start = q.get("from") if isinstance(q.get("from"), int) else 0
    if want in hist:
        start = max(0, hist.index(want) - 1)
    n = q.get("n") if isinstance(q.get("n"), int) else 40
    start = max(0, min(start, max(0, len(hist) - 1)))
    window = hist[start:start + max(1, min(n, BLOCKS_MAX))]
    revs = index["page_revs"][p]
    want_revs = set()
    for kind, i in window:
        if kind == "r":
            want_revs.add(i)
            if index["r_base"][i] == "prev":
                want_revs.add(revs[index["r_pos"][i] - 1])
    rows = _lines_of(index, "revisions.jsonl", [index["r_line"][i] for i in want_revs])
    bodies = {i: _str(rows.get(index["r_line"][i], {}).get("body")) for i in want_revs}
    erows = _lines_of(index, "events.jsonl", [(index["deletes"] if k == "d" else index["requests"])[i][1]
                                              for k, i in window if k != "r"])
    blocks = []
    for kind, i in window:
        if kind == "r":
            row = rows.get(index["r_line"][i])
            if row is not None:
                blocks.append(_block_rev(index, i, row, bodies, mark_at))
        else:
            line = (index["deletes"] if kind == "d" else index["requests"])[i][1]
            row = erows.get(line)
            if row is not None:
                blocks.append(_block_event(index, kind, i, row, mark_at))
    pg = index["pages"][p]
    head = {"p": p, "page_id": pg["id"], "wiki": pg["wiki"], "name": pg["name"], "n_revs": pg["n_revs"],
            "n_revs_before": pg["n_before"], "first_write": None, "last_write": None, "n_labels": pg["n_labels"],
            "deletes": len(index["page_dels"][p]), "listed": bool(pg["line"]), "key": _unit_key(index, p)}
    if pg["line"]:
        row = _lines_of(index, "pages.jsonl", [pg["line"]]).get(pg["line"]) or {}
        head.update({k: row.get(k) for k in ("page_key", "first_write", "last_write", "body_bytes", "labels",
                                              "n_ips", "n_ip16") if k in row})
        head["ref"] = _page_ref(index, p)
    per_user = {}
    for i in revs:
        per_user[index["r_user"][i]] = per_user.get(index["r_user"][i], 0) + 1
    return {"page": head, "strip": S, "from": start, "total": len(hist), "blocks": blocks, "marks": marks,
            "users": sorted(per_user.items(), key=lambda x: -x[1]), "t0": t0}


def _body(index, i):
    if not isinstance(i, int) or not 0 <= i < len(index["r_line"]):
        return None
    row = _lines_of(index, "revisions.jsonl", [index["r_line"][i]]).get(index["r_line"][i])
    if row is None:
        return None
    return {"ref": _rev_ref(index, i), "i": i, "body": _str(row.get("body"))}


def _user(index, name):
    """One username: its labels.jsonl line's fields with its ref, `deletes` the pages it deleted, and `pages`, each of
    its pages with its fields and `edits`, the revisions the username wrote there."""
    if not isinstance(name, str):
        return None
    u = index["user_at"].get(name)
    line = index["user_line"].get(name)
    row = _lines_of(index, "labels.jsonl", [line]).get(line) if line else None
    out = {"label": name, "listed": row is not None, "deletes": sum(1 for d in index["deletes"] if d[3] == name)}
    if row is not None:
        out.update({k: v for k, v in row.items() if k != "pages"})
        out["ref"] = _ref(index, "labels.jsonl", line)
        names = [x for x in row.get("pages") or [] if isinstance(x, str)]
    else:
        names = sorted({index["pages"][index["r_page"][i]]["id"] for i in range(len(index["r_user"])) if index["r_user"][i] == u})
    pages = []
    for pid in names:
        p = index["page_of"].get(pid)
        if p is None:
            pages.append({"page_id": pid})
            continue
        pg = index["pages"][p]
        edits = sum(1 for i in index["page_revs"][p] if index["r_user"][i] == u)
        pages.append({"p": p, "page_id": pid, "wiki": pg["wiki"], "name": pg["name"], "n_revs": pg["n_revs"],
                      "edits": edits, "deletes": len(index["page_dels"][p]),
                      "first": (pg["first"] or 0) - index["t0"], "last": (pg["last"] or 0) - index["t0"],
                      "key": _unit_key(index, p)})
    out["pages"] = pages
    return out


def _event(index, n):
    """An event that no page holds, read in full: an unplaced delete or request."""
    if not isinstance(n, int):
        return None
    row = _lines_of(index, "events.jsonl", [n]).get(n)
    if row is None:
        return None
    return {"ref": _event_ref(index, n), **row}


def records(index, query):
    """{op: overview, keep?}: every page the label filter keeps (_overview), `keep` page indices kept whatever it says.
    {op: page, p, from?, n?, user?, focus?, keep?}: one page's history (_page). {op: body, i}: a revision's whole body.
    {op: user, name}: one username and its pages (_user). {op: event, line}: an event no page holds."""
    query = query or {}
    op = query.get("op")
    if op == "page":
        return _page(index, query)
    if op == "body":
        return _body(index, query.get("i"))
    if op == "user":
        return _user(index, query.get("name"))
    if op == "event":
        return _event(index, query.get("line"))
    keep = {x for x in query.get("keep") or [] if isinstance(x, int)}
    return _overview(index, keep)


# ---------------------------------------------------------------- citations


def _when(t):
    d = datetime.fromtimestamp(t, timezone.utc)
    return f"{d.day} {d:%b %H:%M}"


def _excerpt_body(body, limit=EXCERPT_LINES):
    lines = [s for s in _split(body) if s.strip()]
    return "\n".join(lines[:limit])


def _resolve_rev(index, i, extra_refs=()):
    p = index["r_page"][i]
    line = index["r_line"][i]
    row = _lines_of(index, "revisions.jsonl", [line]).get(line)
    if row is None:
        return None
    body = _str(row.get("body"))
    excerpt = ""
    base = index["r_base"][i]
    if base != "withheld":
        before = []
        if base == "prev":
            revs = index["page_revs"][p]
            prev_line = index["r_line"][revs[index["r_pos"][i] - 1]]
            before = _split(_str((_lines_of(index, "revisions.jsonl", [prev_line]).get(prev_line) or {}).get("body")))
        after = _split(body)
        sm = difflib.SequenceMatcher(None, before, after, autojunk=False)
        added = [s for op, _, _, j1, j2 in sm.get_opcodes() if op in ("replace", "insert") for s in after[j1:j2] if s.strip()]
        excerpt = "\n".join(added[:EXCERPT_LINES])
    excerpt = excerpt or _excerpt_body(body) or _str(row.get("change_summary")) or _str(row.get("rev_id"))
    who = _str(row.get("label")) or "anonymous"
    pg = index["pages"][p]
    return {"excerpt": excerpt, "label": f"{pg['name']} r{row.get('seq')} · {who}",
            "refs": [*extra_refs, _rev_ref(index, i)], "key": _unit_key(index, p), "target": {"p": p, "rev": i}}


def resolve(index, locator):
    """<page_id> (or its page_key, or its name alone): one page's whole history; <page_id>@<seq>: that revision in it. pages.jsonl#L<n>: that page. revisions.jsonl#L<n>: that revision in its
    page's history. events.jsonl#L<n>: a save opens its revision, a delete its place in the page's history, a request
    the page it names, and an event no page holds opens by itself. labels.jsonl#L<n>: the username's pages."""
    if "key" in locator:
        key = str(locator["key"])
        at = re.fullmatch(r"(.+)@(\d+)", key.strip())  # <page_id>@<seq>: that revision in its page's history
        if at and (p := _page_named(index, at.group(1))) is not None:
            i = next((i for i in index["page_revs"][p] if index["r_seq"][i] == int(at.group(2))), None)
            if i is not None:
                return _resolve_rev(index, i)
        p = _page_named(index, key)
        if p is None:
            return None
        pg = index["pages"][p]
        refs = _page_refs(index, p)
        revs = index["page_revs"][p]
        excerpt = ""
        early = _lines_of(index, "revisions.jsonl", [index["r_line"][i] for i in revs[:20]])
        for i in revs[:20]:  # the first stored revision with text, which the first refs cite
            excerpt = _excerpt_body(_str((early.get(index["r_line"][i]) or {}).get("body")), 12)
            if excerpt:
                break
        excerpt = excerpt or pg["id"]
        n = len(revs)
        return {"excerpt": excerpt, "label": f"{pg['name']} · {n} revision{'s' if n != 1 else ''}", "refs": refs,
                "key": _unit_key(index, p), "target": {"p": p}}
    path, frag = locator.get("path"), str(locator.get("fragment") or "")
    m = re.fullmatch(r"L(\d+)", frag)
    if not m:
        return None
    n = int(m.group(1))
    role = next((r for r, f in index["files"].items() if f == path), None)
    if role == "pages.jsonl":
        p = index["page_at"].get(n)
        if p is None:
            return None
        pg = index["pages"][p]
        return {"excerpt": pg["id"], "label": f"{pg['name']} · {pg['n_revs']} revisions",
                "refs": [_page_ref(index, p)], "key": _unit_key(index, p), "target": {"p": p}}
    if role == "revisions.jsonl":
        i = index["rev_at"].get(n)
        return None if i is None else _resolve_rev(index, i)
    if role == "events.jsonl":
        kind, i = index["event_at"].get(n, (None, -1))
        if kind == "s":
            return _resolve_rev(index, i, [_event_ref(index, n)])
        row = _lines_of(index, "events.jsonl", [n]).get(n)
        if row is None:
            return None
        if kind == "d":
            t, _, p, actor = index["deletes"][i][:4]
            pg = index["pages"][p] if p >= 0 else None
            what = pg["name"] if pg else _str(row.get("page")) or _str(row.get("page_key"))
            excerpt = "\n".join(x for x in (_str(row.get("change_summary")), actor, _str(row.get("page"))) if x)
            return {"excerpt": excerpt or _str(row.get("event_id")), "label": f"{what} deleted · {_when(t)}",
                    "refs": [_event_ref(index, n)], "key": _unit_key(index, p) if p >= 0 else None,
                    "target": {"p": p, "del": i} if p >= 0 else {"event": n}}
        if kind == "q":
            t, _, p = index["requests"][i]
            excerpt = _str(row.get("request")) or _str(row.get("request_action")) or _str(row.get("event_id"))
            return {"excerpt": excerpt, "label": f"request · {_when(t)}", "refs": [_event_ref(index, n)],
                    "key": _unit_key(index, p) if p >= 0 else None,
                    "target": {"p": p, "req": i} if p >= 0 else {"event": n}}
        excerpt = _str(row.get("event_id")) or _str(row.get("event_type"))
        return {"excerpt": excerpt, "label": f"{_str(row.get('event_type')) or 'event'} · line {n}",
                "refs": [_event_ref(index, n)], "key": None, "target": {"event": n}} if excerpt else None
    if role == "labels.jsonl":
        name = next((k for k, v in index["user_line"].items() if v == n), None)
        if name is None:
            return None
        row = _lines_of(index, "labels.jsonl", [n]).get(n) or {}
        pages = [x for x in row.get("pages") or [] if isinstance(x, str)]
        excerpt = name or "\n".join(pages[:12])
        if not excerpt:
            return None
        return {"excerpt": excerpt, "label": f"{name or 'anonymous'} · {_int(row.get('stored_revisions'))} revisions",
                "refs": [_ref(index, "labels.jsonl", n)], "key": None, "target": {"user": name}}
    return None


def problems(index):
    """The lines that do not parse or lack what places them, each {ref, why}."""
    return index["problems"]


def unplaced(index):
    """The records read but not placed on a page: deletes of pages with no stored revision, requests that name no
    page, saves whose revision is missing."""
    return index["unplaced"]


def hidden(index):
    return []


def derived(index):
    """A page made from its revisions, when pages.jsonl does not list it."""
    if not index.get("made"):
        return []
    return [{"record": "page", "field": "n_revs", "kind": "computed", "from": "revisions.jsonl",
             "how": f"counted from the revisions of {len(index['made'])} pages pages.jsonl does not list"}]
