# Agent swimlane: the significant actions of a swarm, a row per agent. The call names the actions (a record's ref, a
# one-line summary, optionally its thread), the accounts' goals and the typed links between actions; this code finds each
# action's record in the Swarm reader's index (account, time, place) and returns what card.html draws: a row per
# account in order of its first action, the actions numbered in event order, threads tagged T1… in order of first use.
import re

import thimble

reader = None

ACTIONS_MAX = 24


def _files(index):
    return [p for p, f in index["files"].items() if f["kind"] == "actions"]


def _ref(index, given):
    """The index's ref of the record `given` names: its ref as the reader writes it, the same with a shorter or longer
    path, or L<n> when the corpus has one file of records; None."""
    s = str(given).strip().strip("[]")
    s = s.split("|")[-1]
    recs, same = index["recs"], index["same"]
    if s in recs or s in same:
        return same.get(s, s)
    path, sep, line = s.partition("#")
    if not sep:
        path, line = "", s
    if not re.fullmatch(r"L\d+", line):
        return None
    files = _files(index)
    hits = [p for p in files if not path or p == path or p.endswith("/" + path) or path.endswith("/" + p)]
    if len(hits) != 1:
        return None
    ref = f"{hits[0]}#{line}"
    return same.get(ref, ref) if ref in recs or ref in same else None


def _goal_of(goals, account):
    want = account.lower()
    return next((str(v).strip() for k, v in (goals or {}).items() if str(k).strip().lstrip("@").lower() == want), None)


def card(index, actions, goals=None, links=None):
    recs = index["recs"]
    if not actions:
        raise ValueError("`actions` is empty; give the significant actions, each {ref, summary}")
    if len(actions) > ACTIONS_MAX:
        raise ValueError(f"`actions` has {len(actions)} actions, and a card shows {ACTIONS_MAX} at most; keep the "
                         "significant ones")
    order = {ref: i for i, ref in enumerate(index["order"])}
    found, missing, seen = [], [], set()
    for a in actions:
        ref = _ref(index, a["ref"])
        if ref is None or ref not in order:
            missing.append(repr(a["ref"]))
        elif ref in seen:
            raise ValueError(f"`actions` names the record {a['ref']!r} twice")
        else:
            seen.add(ref)
            found.append((ref, a))
    if missing:
        example = index["order"][0] if index["order"] else "file.jsonl#L1"
        raise ValueError(f"no action on {', '.join(missing[:3])}{' and others' if len(missing) > 3 else ''}; a ref is "
                         f"a record's file and line as the listings give it, such as {example!r}")
    found.sort(key=lambda x: order[x[0]])

    on = thimble.view_labels()
    marks = [{"label": lab["name"], "value": v["name"], "colour": v["colour"]}
             for lab in on["labels"] for v in lab["values"]][:reader.MARKS_MAX]
    mark_at = {(x["label"], x["value"]): i for i, x in enumerate(marks)}
    tags, shown, by_ref = {}, [], {}
    for n, (ref, a) in enumerate(found, 1):
        r = recs[ref]
        thread = " ".join(str(a.get("thread") or "").split()) or r["place"]
        tag = tags.setdefault(thread, f"T{len(tags) + 1}")
        m = next((mark_at[k] for x in (thimble.marked(ref) if marks else ()) if (k := (x["label"], x["value"])) in mark_at), -1)
        c = {"id": n, "ref": ref, "account": r["account"], "time": reader._iso(r["t"]) if r["known"] else None,
             "place": r["place"], "thread": thread, "tag": tag, "summary": " ".join(str(a["summary"]).split()),
             "kind": r["kind"], "m": m}
        shown.append(c)
        by_ref[ref] = c

    def end(v, where):
        if isinstance(v, int) and not isinstance(v, bool) and 1 <= v <= len(shown):
            return shown[v - 1]
        ref = _ref(index, v) if isinstance(v, str) else None
        if ref in by_ref:
            return by_ref[ref]
        raise ValueError(f"{where} {v!r} is none of the actions; give an action's ref, or its number on the card")

    drawn, pairs = [], set()
    for i, x in enumerate(links or ()):
        a, b = end(x["from"], f"links[{i}].from"), end(x["to"], f"links[{i}].to")
        kind = " ".join(str(x["type"]).split())
        if a is b:
            raise ValueError(f"links[{i}] runs from action #{a['id']} to itself")
        if (a["id"], b["id"]) not in pairs:
            pairs.add((a["id"], b["id"]))
            drawn.append({"from": a["id"], "to": b["id"], "type": kind})
    kinds = list(dict.fromkeys(x["type"] for x in drawn))

    own = reader._reach(index, [c["ref"] for c in shown])
    carried = []
    for later, earlier, kind in own:
        a, b = by_ref[later]["id"], by_ref[earlier]["id"]
        if (a, b) not in pairs and (b, a) not in pairs:
            carried.append({"from": a, "to": b, "type": kind})

    rows = []
    for account in dict.fromkeys(c["account"] for c in shown):
        given = _goal_of(goals, account)
        rows.append({"account": account, "goal": given if given is not None else index["accounts"][account].get("goal", ""),
                     "inferred": given is not None, "n": index["accounts"][account]["n"]})
    threads = [{"tag": t, "name": name, "place": name in index["places"],
                "ref": next(c["ref"] for c in shown if c["thread"] == name),
                "n": sum(1 for c in shown if c["thread"] == name)} for name, t in tags.items()]
    return {"actions": shown, "rows": rows, "threads": threads, "links": drawn, "types": kinds, "carried": carried,
            "marks": marks, "counts": {"records": len(index["order"]), "accounts": len(index["accounts"]),
                                       "places": len(index["places"])}}


def _n(n, one, many=None):
    return f"{n:,} {one if n == 1 else many or one + 's'}"


def listing(data):
    """The card's numbers, a line per action ending in its record's ref, the links drawn, and the links the records
    themselves carry between the actions that the call does not draw."""
    acts, links = data["actions"], data["links"]
    by_type = {}
    for x in links:
        by_type[x["type"]] = by_type.get(x["type"], 0) + 1
    out = [f"agent-swimlane: {_n(len(acts), 'action')} by {_n(len(data['rows']), 'account')} on {_n(len(data['threads']), 'thread')}; "
           + (f"{_n(len(links), 'link')} ({', '.join(f'{k} {n}' for k, n in by_type.items())})" if links else "no link")]
    out.append("threads: " + ", ".join(f"{t['tag']} {t['name']}" for t in data["threads"]))
    for c in acts:
        when = c["time"].replace("T", " ")[:16] if c["time"] else "time unknown"
        value = f" [{data['marks'][c['m']]['value']}]" if c["m"] >= 0 else ""
        out.append(f"#{c['id']} {when} {c['account']} {c['tag']}{value}: {c['summary']} {c['ref']}")
    if links:
        out.append("links: " + ", ".join(f"{x['from']}→{x['to']} {x['type']}" for x in links))
    if data["carried"]:
        out.append("links the records carry that the card does not draw: "
                   + ", ".join(f"{x['from']}→{x['to']} {x['type']}" for x in data["carried"]))
    none = [r["account"] for r in data["rows"] if not r["goal"]]
    if none:
        out.append("accounts with no goal: " + ", ".join(none))
    return out
