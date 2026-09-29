# Agent flow: one account's records as steps in time order, with the links between its records and other accounts'.
# `reader` is the Swarm view's reader.py; the links are read from its index over every record (reader._reach), so a
# step counts every other account it followed and that followed it, not only those among the steps shown.
import thimble

reader = None

STEPS_MAX = 40
CHIPS_MAX = 6  # chips a side of a step; the rest are counted
STEP_GAP = 15 * 60  # seconds between two records on one place past which they are two steps


def _account(index, account):
    want = str(account or "").strip().lstrip("@").lower()
    hit = next((a for a in index["accounts"] if a.lower() == want), None)
    if hit is None:
        top = sorted(index["accounts"], key=lambda a: (-index["accounts"][a]["n"], a))[:5]
        raise ValueError(f"no account {account!r}; the busiest are " + ", ".join(repr(a) for a in top))
    return hit


def _chips(links):
    """[{account, kind, ref, n}] of a side's links [(account, kind, ref)], one per account and kind, the most first."""
    by = {}
    for who, kind, ref in links:
        c = by.setdefault((who, kind), {"account": who, "kind": kind, "ref": ref, "n": 0})
        c["n"] += 1
    return sorted(by.values(), key=lambda c: (-c["n"], c["account"].lower(), c["kind"]))


def card(index, account, within=None, places=None, links=None, edges=None):
    recs = index["recs"]
    who = _account(index, account)
    on = thimble.view_labels()
    marks = [{"label": lab["name"], "value": v["name"], "colour": v["colour"]}
             for lab in on["labels"] for v in lab["values"]][:reader.MARKS_MAX]
    mark_at = {(x["label"], x["value"]): i for i, x in enumerate(marks)}
    chosen = reader._within(within)
    wanted = {str(p) for p in places or ()}
    mine = [ref for ref in index["order"] if recs[ref]["account"] == who and (chosen is None or ref in chosen)
            and (not wanted or recs[ref]["place"] in wanted)]
    reach = reader._reach(index, [(ref, ()) for ref in index["order"]], links, edges)
    mine_set = set(mine)
    left, right = {}, {}  # my ref -> [(account, kind, their ref)]
    for later, earlier, kind in reach["links"]:
        if later in mine_set and recs[earlier]["account"] != who:
            left.setdefault(later, []).append((recs[earlier]["account"], kind, earlier))
        elif earlier in mine_set and recs[later]["account"] != who:
            right.setdefault(earlier, []).append((recs[later]["account"], kind, later))

    steps = []
    for ref in mine:
        r = recs[ref]
        prev = recs[steps[-1]["refs"][-1]] if steps else None
        if prev and prev["place"] == r["place"] and (not (r["known"] and prev["known"]) or r["t"] - prev["t"] <= STEP_GAP):
            steps[-1]["refs"].append(ref)
        else:
            steps.append({"place": r["place"], "refs": [ref]})
    by_account = {}
    for s in steps:
        s_left = [x for ref in s["refs"] for x in left.get(ref, ())]
        s_right = [x for ref in s["refs"] for x in right.get(ref, ())]
        for acc, _k, _r in s_left:
            by_account.setdefault(acc, [0, 0])[0] += 1
        for acc, _k, _r in s_right:
            by_account.setdefault(acc, [0, 0])[1] += 1
        first, last = recs[s["refs"][0]], recs[s["refs"][-1]]
        got = {}
        for ref in s["refs"]:
            for i in {mark_at[k] for x in (thimble.marked(ref) if marks else ()) if (k := (x["label"], x["value"])) in mark_at}:
                got[i] = got.get(i, 0) + 1
        lc, rc = _chips(s_left), _chips(s_right)
        s.update({"ref": s["refs"][0], "last": s["refs"][-1], "n": len(s["refs"]),
                  "time": reader._iso(first["t"]) if first["known"] else None,
                  "end": reader._iso(last["t"]) if last["known"] and len(s["refs"]) > 1 else None,
                  "kind": first["kind"], "line": reader._did(index, first)["line"],
                  "title": index["places"][s["place"]]["title"], "m": sorted(got.items(), key=lambda kv: -kv[1]),
                  "links": len(s_left) + len(s_right), "left": lc[:CHIPS_MAX], "right": rc[:CHIPS_MAX],
                  "left_more": sum(c["n"] for c in lc[CHIPS_MAX:]), "right_more": sum(c["n"] for c in rc[CHIPS_MAX:])})
        del s["refs"]
    kept = range(len(steps))
    if len(steps) > STEPS_MAX:
        kept = sorted(sorted(kept, key=lambda i: (-steps[i]["links"], i))[:STEPS_MAX])
    shown, prev = [], -1
    for n, i in enumerate(kept, 1):
        shown.append({**steps[i], "id": n, "step": i + 1, "gap": i - prev - 1})
        prev = i
    kinds = {}
    for acc_links in (left, right):
        for xs in acc_links.values():
            for _a, k, _r in xs:
                kinds[k] = kinds.get(k, 0) + 1
    return {"account": who, "goal": index["accounts"][who].get("goal", ""), "records": len(mine),
            "records_all": index["accounts"][who]["n"], "steps_total": len(steps), "gap_after": len(steps) - 1 - prev,
            "places": len({recs[ref]["place"] for ref in mine}), "steps": shown, "marks": marks,
            "counts": kinds, "by_account": sorted(([a, i, o] for a, (i, o) in by_account.items()),
                                                  key=lambda x: (-(x[1] + x[2]), x[0].lower()))}


def _n(n, one, many=None):
    return f"{n:,} {one if n == 1 else many or one + 's'}"


def listing(data):
    """The account's totals, the accounts it is linked with, then a line per step shown, each ending in its first
    record's ref."""
    shown, total = len(data["steps"]), data["steps_total"]
    out = [f"agent-flow: {data['account']}, {_n(data['records'], 'record')} on {_n(data['places'], 'place')} in "
           f"{_n(total, 'step')}" + (f"; the {shown} most linked shown" if shown < total else "")]
    if data["records"] != data["records_all"]:
        out[0] += f" (of its {data['records_all']:,} records)"
    if data["goal"]:
        out.append(f"goal: {data['goal']}")
    if data["counts"]:
        out.append("links with other accounts: " + ", ".join(f"{k} {n:,}" for k, n in data["counts"].items()))
    if data["by_account"]:
        out.append("linked accounts (it answered / answered it): "
                   + ", ".join(f"{a} {i}/{o}" for a, i, o in data["by_account"][:12]))
    for s in data["steps"]:
        if s["gap"]:
            out.append(f"... {_n(s['gap'], 'step')} not shown")
        when = s["time"].replace("T", " ")[:16] if s["time"] else "time unknown"
        many = f" ({s['n']} records)" if s["n"] > 1 else ""
        value = f" [{data['marks'][s['m'][0][0]]['value']}]" if s["m"] else ""
        sides = []
        if s["left"]:
            sides.append("after " + ", ".join(f"{c['account']} ({c['kind']})" for c in s["left"][:3]))
        if s["right"]:
            sides.append("then " + ", ".join(f"{c['account']} ({c['kind']})" for c in s["right"][:3]))
        tail = f"; {'; '.join(sides)}" if sides else ""
        out.append(f"{s['step']}. {when} {s['place']}{many}{value}: {s['line']}{tail} {s['ref']}")
    if data["gap_after"]:
        out.append(f"... {_n(data['gap_after'], 'step')} not shown")
    return out
