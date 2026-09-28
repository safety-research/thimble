# Swarm map: how many agents acted on a few shared places, drawn from the map the orientation wrote of them.
#
# The map (swarm.json): the chart's content, which the orientation's swarm step writes and checks against the records.
#   title     the chart's takeaway, one sentence
#   agents    [{username, goal, signs_as?, evidence: [{ref, quote}]}]: the identity the records give each agent, its
#             goal as its records show it, and the names its own text signs with
#   threads   [{tag, id, ref}]: the shared places, tagged T1, T2 and on; `id` is the name the records give the place,
#             `ref` the record that defines it
#   actions   [{id, agent, thread, time, action, ref, before?, quote}]: the significant actions, numbered in event order;
#             `time` is UTC or null, `ref` the record, `before` the save before it where a record holds a whole
#             document, and `quote` the record's text that shows the action
#   links     [{from, to, type, reason, evidence: [{ref, quote}]}]: a later action bearing on an earlier one, as a reply,
#             support, contradicts or related
# Every ref is <path>#L<n>, relative to the corpus folder. The map is found next to this file, else in the workspace's
# orient folder, else in the corpus folder.
#
# The corpus: JSON Lines files, one record per line, such as a wiki's revisions (each the whole page as it was saved,
# with the account that saved it and when) and its page index, or a board's posts. The claimed files are the ones the
# map cites.
#
# The cleaning:
#   bad lines   a line of a claimed file that is not a JSON object holds no record: the page says how many there are,
#               with the first few (`problems`)
#   the map     an action that names an agent or a thread the map does not list gets one; a link whose ends are not both
#               actions of the map, or a ref that names no line, is left out and counted among the problems
#   text        a record's text is its longest string field; an action's added text is the lines its record's text holds
#               that its `before` record's does not
#   names       a record belongs to an agent or a thread of the map when one of its fields holds the agent's username or
#               the thread's id as its whole value
#
# The method: the index keeps the byte offset of every line of the claimed files and the lines that do not parse. The
# map is read again whenever its file changes, since it is not one of the claimed files. `records` sends the whole map
# the label filter keeps, since it holds a few dozen actions; a record's fields and text are read back from its line
# when the page asks for them.
#
# Labels: they apply when the map is served. Every answer keeps only the actions thimble.kept(ref) holds for, the
# agents and threads that keep an action and the links whose two actions are kept. `marks` lists the values of the
# labels that are on, and each action carries the ones thimble.marked(ref) gives its record (the first as `m`, all of
# them as bits in `mb`), which the page draws on its card. An agent, a thread and a link are units, `agent:<username>`,
# `thread:<tag>` and `<from>-<to>`, whose refs are the records they gather.
import difflib
import json
import re
from datetime import datetime
from pathlib import Path

import thimble

MAP_NAME = "swarm.json"
TYPES = ("reply", "support", "contradicts", "related")
MARKS_MAX = 24  # label values the page tells apart, as bits of one number per action
PROBLEMS_SHOWN = 5
TEXT_MAX = 60_000  # characters of a record's text the page gets
FIELD_MAX = 300  # characters of a field's value the page gets
HUNK_LINES = 400  # added or removed lines of a save the page gets
EXCERPT_LINES = 12
LINE_MAX = 400  # characters of a line in an excerpt
MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
REF = re.compile(r"(.+?)#L(\d+)(?:-L?\d+)?")
TIME_KEYS = ("time", "timestamp", "ts", "created_at", "created", "date", "write_date")
WHO_KEYS = ("username", "user", "author", "agent", "actor", "label")


def _problem(problems, where, why):
    problems["count"] += 1
    if len(problems["examples"]) < PROBLEMS_SHOWN:
        problems["examples"].append(f"{where}: {why}")


# ---------------------------------------------------------------- the index


def build_index(paths):
    """{"files": [path], "offsets": {path: [byte offset of line n at n-1]}, "problems": {count, examples} of the lines
    that are not a JSON object}."""
    offsets, problems = {}, {"count": 0, "examples": []}
    for path in paths:
        offs, pos = [], 0
        with open(path, "rb") as fh:
            for n, raw in enumerate(fh, 1):
                offs.append(pos)
                pos += len(raw)
                if not raw.strip():
                    continue
                try:
                    ok = isinstance(json.loads(raw), dict)
                except ValueError:
                    ok = False
                if not ok:
                    _problem(problems, f"{path}#L{n}", "not a JSON object")
        offsets[path] = offs
    return {"files": list(paths), "offsets": offsets, "problems": problems}


_extra_offsets = {}  # (path, mtime, size) -> offsets, for a file the map cites that the view does not claim


def _line(index, path, n):
    """The text of line n of the corpus file, or None."""
    offs = index["offsets"].get(path)
    try:
        if offs is None:
            p = Path(path)
            st = p.stat()
            key = (path, st.st_mtime_ns, st.st_size)
            if key not in _extra_offsets:
                offs, pos = [], 0
                with open(p, "rb") as fh:
                    for raw in fh:
                        offs.append(pos)
                        pos += len(raw)
                _extra_offsets.clear()
                _extra_offsets[key] = offs
            offs = _extra_offsets[key]
        if not 1 <= n <= len(offs):
            return None
        with open(path, "rb") as fh:
            fh.seek(offs[n - 1])
            return fh.readline().decode("utf-8", "replace").rstrip("\r\n")
    except OSError:
        return None


def _split(ref):
    m = REF.fullmatch(str(ref or ""))
    return (m.group(1), int(m.group(2))) if m else (None, None)


def _read(index, ref):
    """(the record on the ref's line as a dict or None, the line's text or None)."""
    path, n = _split(ref)
    if path is None:
        return None, None
    raw = _line(index, path, n)
    if raw is None:
        return None, None
    try:
        rec = json.loads(raw)
    except ValueError:
        return None, raw
    return (rec if isinstance(rec, dict) else None), raw


# ---------------------------------------------------------------- the map

_map = {"sig": None, "map": None}


def _map_path():
    here = Path(__file__).with_name(MAP_NAME)
    ws = getattr(thimble, "WS", None)
    for p in (here, Path(ws) / "orient" / MAP_NAME if ws else None, Path(MAP_NAME)):
        if p is not None and p.is_file():
            return p
    return None


def _str(v):
    return "" if v is None else str(v).strip()


def _evidence(v, problems, where):
    out = []
    for e in v if isinstance(v, list) else []:
        if not isinstance(e, dict):
            continue
        if _split(e.get("ref"))[0] is None:
            _problem(problems, where, f"the ref {_str(e.get('ref'))!r} names no line")
            continue
        out.append({"ref": _str(e["ref"]), "quote": _str(e.get("quote"))})
    return out


def _clean(raw, problems):
    """The map with every field present and of its type (the cleaning above)."""
    raw = raw if isinstance(raw, dict) else {}
    agents, threads, actions, links = {}, {}, [], []
    for a in raw.get("agents") or []:
        if isinstance(a, dict) and _str(a.get("username")) and _str(a["username"]) not in agents:
            u = _str(a["username"])
            sig = a.get("signs_as")
            agents[u] = {"username": u, "goal": _str(a.get("goal")),
                         "signs_as": [_str(s) for s in (sig if isinstance(sig, list) else [sig] if sig else []) if _str(s)],
                         "evidence": _evidence(a.get("evidence"), problems, f"agent {u}")}
    for t in raw.get("threads") or []:
        if isinstance(t, dict) and _str(t.get("tag")) and _str(t["tag"]) not in threads:
            ref = _str(t.get("ref"))
            threads[_str(t["tag"])] = {"tag": _str(t["tag"]), "id": _str(t.get("id")) or _str(t["tag"]),
                                       "ref": ref if _split(ref)[0] else None}
    seen = set()
    for a in raw.get("actions") or []:
        if not isinstance(a, dict):
            continue
        try:
            aid = int(a.get("id"))
        except (TypeError, ValueError):
            _problem(problems, "an action", f"its id {a.get('id')!r} is not a number")
            continue
        if aid in seen or _split(a.get("ref"))[0] is None:
            _problem(problems, f"action {aid}", "its id is taken" if aid in seen else "its ref names no line")
            continue
        seen.add(aid)
        u, tag = _str(a.get("agent")), _str(a.get("thread"))
        if u not in agents:
            _problem(problems, f"action {aid}", f"the map lists no agent {u!r}")
            agents[u] = {"username": u, "goal": "", "signs_as": [], "evidence": []}
        if tag not in threads:
            _problem(problems, f"action {aid}", f"the map lists no thread {tag!r}")
            threads[tag] = {"tag": tag, "id": tag, "ref": None}
        before = _str(a.get("before"))
        actions.append({"id": aid, "agent": u, "thread": tag, "time": _str(a.get("time")) or None,
                        "action": _str(a.get("action")), "ref": _str(a["ref"]),
                        "before": before if _split(before)[0] else None, "quote": _str(a.get("quote"))})
    actions.sort(key=lambda a: a["id"])
    for x in raw.get("links") or []:
        if not isinstance(x, dict):
            continue
        try:
            f, t = int(x.get("from")), int(x.get("to"))
        except (TypeError, ValueError):
            _problem(problems, "a link", f"{x.get('from')!r}→{x.get('to')!r} does not join two action ids")
            continue
        if f not in seen or t not in seen or f == t:
            _problem(problems, f"link {f}→{t}", "its ends are not two actions of the map")
            continue
        links.append({"from": f, "to": t, "key": f"{f}-{t}", "type": _str(x.get("type")).lower() or "related",
                      "reason": _str(x.get("reason")), "evidence": _evidence(x.get("evidence"), problems, f"link {f}→{t}")})
    used = {a["agent"] for a in actions}
    return {"title": _str(raw.get("title")), "agents": [a for u, a in agents.items() if u in used],
            "threads": [t for t in threads.values() if any(a["thread"] == t["tag"] for a in actions)],
            "actions": actions, "links": links}


def _load():
    """The map (_clean) with its own problems, read again when its file changed."""
    p = _map_path()
    if p is None:
        problems = {"count": 1, "examples": [f"{MAP_NAME}: not found next to the view, in the workspace or in the corpus"]}
        return {**_clean({}, problems), "problems": problems}
    st = p.stat()
    sig = (str(p.resolve()), st.st_mtime_ns, st.st_size)
    if _map["sig"] != sig:
        problems = {"count": 0, "examples": []}
        try:
            raw = json.loads(p.read_text("utf-8"))
        except (OSError, ValueError) as e:
            _problem(problems, MAP_NAME, f"cannot be read ({type(e).__name__})")
            raw = {}
        _map.update(sig=sig, map={**_clean(raw, problems), "problems": problems})
    return _map["map"]


# ---------------------------------------------------------------- records


def _both(index, m):
    """The index's problems and the map's, as one {count, examples}."""
    a, b = index["problems"], m["problems"]
    return {"count": a["count"] + b["count"], "examples": (b["examples"] + a["examples"])[:PROBLEMS_SHOWN]}


def _overview(index, keep):
    """The map as the label filter keeps it (Labels above), with `marks`, `total` (the counts before the filter),
    `hidden` (the actions the filter left out) and `problems`."""
    m = _load()
    on = thimble.view_labels()
    marks = [{"label": lab["name"], "value": v["name"], "colour": v["colour"]}
             for lab in on["labels"] for v in lab["values"]][:MARKS_MAX]
    mark_at = {(x["label"], x["value"]): i for i, x in enumerate(marks)}
    actions, hidden = [], 0
    for a in m["actions"]:
        if on["filter"] and a["ref"] not in keep and not thimble.kept(a["ref"]):
            hidden += 1
            continue
        first, bits = -1, 0
        for x in thimble.marked(a["ref"]) if marks else ():
            i = mark_at.get((x["label"], x["value"]))
            if i is not None:
                first = i if first < 0 else first
                bits |= 1 << i
        actions.append({**a, "m": first, "mb": bits})
    ids = {a["id"] for a in actions}
    agents = {a["agent"] for a in actions}
    tags = {a["thread"] for a in actions}
    return {"title": m["title"], "agents": [a for a in m["agents"] if a["username"] in agents],
            "threads": [t for t in m["threads"] if t["tag"] in tags], "actions": actions,
            "links": [x for x in m["links"] if x["from"] in ids and x["to"] in ids], "types": list(TYPES),
            "marks": marks, "hidden": hidden, "files": index["files"],
            "total": {k: len(m[k]) for k in ("agents", "threads", "actions", "links")}, "problems": _both(index, m)}


def _text_key(rec):
    """The record's longest string field, its text."""
    best, size = None, -1
    for k, v in rec.items():
        if isinstance(v, str) and len(v) > size:
            best, size = k, len(v)
    return best


def _short(v):
    if isinstance(v, list):
        head = ", ".join(_str(x) if not isinstance(x, (dict, list)) else json.dumps(x, ensure_ascii=False) for x in v[:12])
        return head + (f" (+{len(v) - 12})" if len(v) > 12 else "")
    if isinstance(v, dict):
        return json.dumps(v, ensure_ascii=False)[:FIELD_MAX]
    return _str(v)[:FIELD_MAX]


def _values(rec):
    """Every string a field of the record holds as its whole value, a list's items included."""
    out = set()
    for v in rec.values():
        for x in v if isinstance(v, list) else [v]:
            if isinstance(x, str) and x.strip():
                out.add(x.strip())
    return out


def _names(m, rec):
    """(the usernames, the thread tags) of the map that the record holds as a field's whole value."""
    vals = _values(rec)
    return [a["username"] for a in m["agents"] if a["username"] in vals], [t["tag"] for t in m["threads"] if t["id"] in vals]


def _hunks(old, new):
    """[{at, add, del}]: where the new text differs from the old, line by line, `at` the first added line's number."""
    a, b = old.splitlines(), new.splitlines()
    out, budget = [], HUNK_LINES
    for op, i1, i2, j1, j2 in difflib.SequenceMatcher(None, a, b, autojunk=False).get_opcodes():
        if op == "equal" or budget <= 0:
            continue
        add, rem = b[j1:j2][:budget], a[i1:i2][:budget]
        budget -= len(add) + len(rem)
        out.append({"at": j1 + 1, "add": add, "del": rem})
    return out


def _record(index, ref):
    """One record in full: its fields, its text, what its save added when it is an action with a save before it, and
    the map's agents and threads it names."""
    m = _load()
    rec, raw = _read(index, ref)
    if rec is None:
        return {"ref": ref, "missing": True, "raw": (raw or "")[:FIELD_MAX]}
    key = _text_key(rec)
    text = rec.get(key) if key else ""
    out = {"ref": ref, "fields": [[k, _short(v)] for k, v in rec.items() if k != key], "text_key": key,
           "text": text[:TEXT_MAX], "cut": len(text) > TEXT_MAX}
    act = next((a for a in m["actions"] if a["ref"] == ref), None)
    if act and act["before"]:
        prev, _ = _read(index, act["before"])
        if prev is not None and isinstance(prev.get(key), str):
            out.update(before=act["before"], hunks=_hunks(prev[key], text))
    out["agents"], out["threads"] = _names(m, rec)
    return out


def records(index, query):
    """{op: map, keep?}: the map as the label filter keeps it (_overview), the actions whose refs are in `keep` kept
    whatever the filter. {op: record, ref}: one record in full (_record)."""
    query = query or {}
    if query.get("op") == "record":
        return _record(index, _str(query.get("ref")))
    return _overview(index, {_str(r) for r in query.get("keep") or ()})


# ---------------------------------------------------------------- citations


def _when(v):
    try:
        d = datetime.fromisoformat(_str(v).replace("Z", "+00:00"))
    except ValueError:
        return ""
    return f"{d.day} {MONTHS[d.month - 1]} {d:%H:%M}"


def _excerpt_lines(lines):
    out = []
    for s in lines:
        if s.strip():
            out.append(s.strip()[:LINE_MAX])
        if len(out) >= EXCERPT_LINES:
            break
    return "\n".join(out)


def _quotes(items):
    return [q for x in items for q in x["quote"].splitlines() if q.strip()]


def _unit(label, key, target, refs, quotes):
    return {"excerpt": _excerpt_lines(quotes), "label": label, "refs": list(dict.fromkeys(refs)), "key": key,
            "target": target}


def _resolve_key(m, key):
    by_id = {a["id"]: a for a in m["actions"]}
    if key.startswith("agent:"):
        ag = next((a for a in m["agents"] if a["username"] == key[6:]), None)
        if ag is None:
            return None
        acts = [a for a in m["actions"] if a["agent"] == ag["username"]]
        return _unit(f"{ag['username']} · {len(acts)} action{'s' * (len(acts) != 1)}", key, {"agent": ag["username"]},
                     [a["ref"] for a in acts] + [e["ref"] for e in ag["evidence"]], _quotes(acts + ag["evidence"]))
    if key.startswith("thread:"):
        t = next((t for t in m["threads"] if t["tag"] == key[7:]), None)
        if t is None:
            return None
        acts = [a for a in m["actions"] if a["thread"] == t["tag"]]
        return _unit(f"{t['tag']} {t['id']} · {len(acts)} action{'s' * (len(acts) != 1)}", key, {"thread": t["tag"]},
                     [a["ref"] for a in acts], _quotes(acts))
    x = next((x for x in m["links"] if x["key"] == key), None)
    if x is None:
        return None
    ends = [by_id[x["from"]], by_id[x["to"]]]
    return _unit(f"{x['from']}→{x['to']} · {x['type']}", key, {"link": key},
                 [e["ref"] for e in ends] + [e["ref"] for e in x["evidence"]], _quotes(x["evidence"] + ends))


def resolve(index, locator):
    """<file>#L<n>: the record on that line; its card when it is an action of the map, else the record beside the map
    with the agent and thread it names. view:<slug>/agent:<username>, thread:<tag> or <from>-<to>: that agent's row, that
    thread's actions or that link, with the records they gather."""
    m = _load()
    if "key" in locator:
        return _resolve_key(m, _str(locator["key"]))
    path, fragment = locator.get("path"), _str(locator.get("fragment"))
    hit = re.fullmatch(r"L(\d+)", fragment)
    if not hit or not path:
        return None
    ref = f"{path}#L{int(hit.group(1))}"
    rec, raw = _read(index, ref)
    if rec is None:
        return None
    agents, tags = _names(m, rec)
    act = next((a for a in m["actions"] if a["ref"] == ref), None)
    thread = next((t for t in m["threads"] if t["ref"] == ref), None)
    key = _text_key(rec)
    text = rec.get(key) or "" if key else ""
    excerpt = ""
    if act:
        tags = [act["thread"]]
        prev = _read(index, act["before"])[0] if act["before"] else None
        if prev is not None and isinstance(prev.get(key), str):
            excerpt = _excerpt_lines([s for h in _hunks(prev[key], text) for s in h["add"]])
        excerpt = excerpt or _excerpt_lines(act["quote"].splitlines())
        label = f"#{act['id']} · {act['agent']} · {act['thread']}"
    elif thread:
        tags = [thread["tag"]]
        excerpt = thread["id"] if thread["id"] in _values(rec) else ""
        label = f"{thread['tag']} {thread['id']}"
    else:
        who = agents[0] if agents else next((_str(rec[k]) for k in WHO_KEYS if isinstance(rec.get(k), str) and rec[k].strip()), "")
        when = next((_when(rec[k]) for k in TIME_KEYS if rec.get(k) and _when(rec[k])), "")
        label = " · ".join(x for x in (who, when) if x) or ref
    excerpt = excerpt or _excerpt_lines(text.splitlines()) or _excerpt_lines(sorted(_values(rec), key=len, reverse=True))
    return {"excerpt": excerpt, "label": label, "refs": [ref], "key": f"thread:{tags[0]}" if tags else None,
            "target": {"ref": ref, "action": act["id"] if act else None, "thread": tags[0] if tags else None,
                       "agent": act["agent"] if act else None if thread else (agents[0] if agents else None)}}
