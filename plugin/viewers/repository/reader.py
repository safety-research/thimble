# Repository: a code forge's log of several agent runs on one library, read the way its GitHub pages read.
#
# The data (sample/repo.jsonl): one line is one record of one run, in the order the forge wrote them.
#   kind       what the record is: run, agent, issue, pr, commit, review, comment, merge, close or post
#   run        the run it belongs to, such as r1; numbers, threads and agents are read within their run
#   at         when, ISO 8601
#   author     who wrote it: an agent of the run, or for a backlog issue the person who reported it
#   number     the issue or pull request it belongs to; issues and pull requests share one numbering in a run
#   title      an issue's or pull request's title, and a discussion's on its first post
#   area       the part of the library an issue or pull request is about
#   closes     on a pull request, the number of the issue it fixes when it merges
#   sha        a commit's id
#   verdict    a review's verdict: approved, changes requested or commented
#   reason     why a close ended its pull request or issue without a merge, such as duplicate or abandoned
#   thread     a post's discussion, numbered within its run
#   team       on a run, how many agents it had
#   approvals  on a run, how many approvals a pull request needed to merge
#   text       the body: a description, a commit message, a review, a comment, a post, a run's brief, or the note an
#              agent left when it signed off
# Every run works the same backlog, so issue #3 of one run is issue #3 of another, and runs compare issue by issue.
#
# The method: the reader gathers each run's records into the units a forge shows, keyed as its URLs are: pull requests
# (<run>/pull/<n>), issues (<run>/issues/<n>), discussions (<run>/discussions/<n>) and agents (<run>/agents/<name>),
# and a run itself (<run>). The index keeps each unit's facts (state, who merged it, each reviewer's verdicts, flags)
# and its records' lines and times; a record's text is read back from its byte offset when a page shows it. One fetch
# answers a whole tab under the page's selection: the tab counts, one row of measures per run, the activity per time
# bin, the values of every filter with their counts, and a page of units. Each filter's counts hold every other
# filter, and the runs' rows hold every filter but the run, so a run that is not chosen still shows what choosing it
# would give.
#
# Labels: they apply when records are served, never in the index. A unit stays when thimble.kept_unit holds for its
# records, and a record counts in the activity and on a unit's strip when thimble.kept holds for it. The records the
# first label that is on marks (thimble.marked) are counted apart in the activity and in each run's row, since thimble
# cannot see inside a chart; the page draws them in the label's colour.
import json
import re
import statistics
from datetime import datetime, timezone

import thimble

TABS = ("pulls", "issues", "discussions", "agents")
PAGE = 100  # units one fetch returns; the page asks for the next ones
BINS = [5, 10, 15, 20, 30, 60, 120, 240, 480, 1440]  # minutes; the activity's bin is the first giving at most MAX_BARS
MAX_BARS = 40
# what each kind of record did, as the activity and the strips name it; a review is named by its verdict
ACTION = {"pr": "opened", "issue": "opened", "commit": "pushed", "comment": "commented", "merge": "merged",
          "close": "closed", "post": "posted", "agent": "signed off"}
MENTION = re.compile(r"#(\d+)\b")


def _epoch(t):
    try:
        dt = datetime.fromisoformat(str(t).replace("Z", "+00:00"))
    except ValueError:
        return None
    return (dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)).timestamp()


def _action(r):
    return (r.get("verdict") or "commented") if r.get("kind") == "review" else ACTION.get(r.get("kind"), "other")


def build_index(paths):
    """{"offsets": {path: [byte offset of line n at n-1]}, "runs": {run: facts}, "units": {key: unit}, "line": {ref:
    key of its unit}}. A unit holds its tab, run, facts, `refs` (the records it gathers) and `events` ([ref, hours since
    its run started, action] in time order, its strip and its part of the activity). An agent's refs start with its
    own record, then every record it wrote; an issue's events include the merge that fixed it. The agents of a run are
    the authors of its `agent` records. A line that is not JSON, or has no run or no time, is in `offsets` only."""
    offsets, recs = {}, []
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
                if isinstance(r, dict) and r.get("run") and (t := _epoch(r.get("at"))) is not None:
                    recs.append((t, f"{path}#L{n}", str(r["run"]), r))
    recs.sort(key=lambda x: x[0])

    runs, agents, numbered = {}, set(), {}
    for t, ref, run, r in recs:
        info = runs.setdefault(run, {"start": t, "end": t, "team": None, "approvals": None, "ref": None})
        info["end"] = max(info["end"], t)
        if r.get("kind") == "run":
            info.update(start=t, team=r.get("team"), approvals=r.get("approvals"), ref=ref)
        elif r.get("kind") == "agent":
            agents.add((run, str(r.get("author"))))
        elif r.get("kind") in ("pr", "issue") and r.get("number") is not None:
            numbered[(run, int(r["number"]))] = f"{run}/{'pull' if r['kind'] == 'pr' else 'issues'}/{r['number']}"

    units, line = {}, {}
    for t, ref, run, r in recs:
        kind, who = r.get("kind"), str(r.get("author") or "")
        h, act = round((t - runs[run]["start"]) / 3600, 3), _action(r)
        if kind == "run":
            line[ref] = run
            continue
        if kind == "agent":
            key = f"{run}/agents/{who}"
        elif kind == "post" and r.get("thread") is not None:
            key = f"{run}/discussions/{r['thread']}"
        elif r.get("number") is not None and (run, int(r["number"])) in numbered:
            key = numbered[(run, int(r["number"]))]
        else:
            continue
        line[ref] = key
        u = units.get(key) or units.setdefault(key, _unit(key, run, r, h))
        _add(u, kind, r, who, h, act)
        u["refs"].insert(0, ref) if kind == "agent" else u["refs"].append(ref)
        u["events"].append([ref, h, act])
        u["words"].append(" ".join(str(r.get(f) or "") for f in ("title", "text", "reason", "sha")))
        if (run, who) in agents and kind != "agent":
            a = units.setdefault(f"{run}/agents/{who}", _unit(f"{run}/agents/{who}", run, {"author": who}, h))
            a["refs"].append(ref)
            a["events"].append([ref, h, act])

    for u in units.values():
        numbers = [f"#{n}" for n in (u.get("number"), u.get("closes")) if n is not None and u["tab"] != "discussions"]
        u["search"] = " ".join([u.get("title") or "", u.get("author") or "", *numbers, *u.pop("words")]).lower()
        if u["tab"] == "pulls":
            _pull_facts(u, runs[u["run"]])
    for u in [u for u in units.values() if u["tab"] == "pulls" and u.get("closes") is not None]:
        issue = units.get(f"{u['run']}/issues/{u['closes']}")
        if issue is None:
            continue
        issue["prs"].append(u["number"])
        if u["state"] == "merged" and issue["state"] == "open":
            issue.update(state="fixed", fixed_by=u["number"], ended=u["ended"])
            issue["events"].append([next(e[0] for e in u["events"] if e[2] == "merged"), u["ended"], "fixed"])
    _agent_facts(units)
    return {"offsets": offsets, "runs": runs, "units": units, "line": line}


def _unit(key, run, r, h):
    """A new unit for the record `r`, the first of it, at `h` hours."""
    tab = {"pull": "pulls", "issues": "issues", "discussions": "discussions", "agents": "agents"}[key.split("/")[1]]
    u = {"key": key, "tab": tab, "run": run, "at": h, "author": str(r.get("author") or ""), "refs": [], "events": [],
         "words": []}
    if tab in ("pulls", "issues"):
        u.update(number=int(key.rsplit("/", 1)[1]), title="", area="", state="open", closed_by=None, reason=None,
                 ended=None, comments=0)
    if tab == "pulls":
        u.update(closes=None, merged_by=None, reviews=[], commits=[])
    elif tab == "issues":
        u.update(origin="backlog", prs=[], fixed_by=None)
    elif tab == "discussions":
        u.update(number=int(key.rsplit("/", 1)[1]), title="", posts=0, posters=[], mentions=[])
    else:
        u.update(name=key.rsplit("/", 1)[1])
    return u


def _add(u, kind, r, who, h, act):
    """What one record adds to its unit's facts."""
    if kind in ("pr", "issue"):
        u.update(title=str(r.get("title") or ""), area=str(r.get("area") or ""), author=who, at=h)
        if kind == "pr":
            u["closes"] = r.get("closes")
        else:
            u["origin"] = "backlog" if h <= 0 else "found during the run"
    elif kind == "commit":
        u["commits"].append(h)
    elif kind == "review":
        u["reviews"].append([who, act, h])
    elif kind == "comment":
        u["comments"] += 1
    elif kind == "merge":
        u.update(state="merged", merged_by=who, ended=h)
    elif kind == "close":
        u.update(state="closed", closed_by=who, reason=str(r.get("reason") or "closed"), ended=h)
    elif kind == "post":
        u["title"] = u["title"] or str(r.get("title") or "")
        u["posts"] += 1
        u["posters"] += [who] if who not in u["posters"] else []
        u["mentions"] += [m for m in map(int, MENTION.findall(str(r.get("text") or ""))) if m not in u["mentions"]]


def _pull_facts(u, run):
    """A pull request's derived facts: each reviewer's latest verdict, how long to its first review and to its merge,
    and its flags."""
    latest = {}
    for who, verdict, h in u["reviews"]:
        if verdict != "commented" or who not in latest:
            latest[who] = verdict
    u["latest"] = latest
    u["approvals"] = sum(1 for v in latest.values() if v == "approved")
    u["changes"] = sum(1 for v in latest.values() if v == "changes requested")
    u["first_review"] = round(u["reviews"][0][2] - u["at"], 3) if u["reviews"] else None
    u["to_merge"] = round(u["ended"] - u["at"], 3) if u["state"] == "merged" else None
    approved = [h for _, v, h in u["reviews"] if v == "approved"]
    flags = []
    if u["state"] == "merged" and u["merged_by"] == u["author"]:
        flags.append("merged by its author")
    if u["state"] == "merged" and u["changes"]:
        flags.append("merged over a change request")
    if approved and any(c > max(approved) for c in u["commits"]):
        flags.append("pushed after its last approval")
    if u["state"] == "open" and u["approvals"] < (run["approvals"] or 1):
        flags.append("waiting for approvals")
    u["flags"] = flags


def _agent_facts(units):
    """Each agent's counts, and its review partners: {author: [approvals, change requests]} of the pull requests it
    reviewed."""
    agents = {k: u for k, u in units.items() if u["tab"] == "agents"}
    for a in agents.values():
        acts = [e[2] for e in a["events"]]
        a.update(opened=0, merged=0, merges=0, approved=acts.count("approved"), changes=acts.count("changes requested"),
                 comments=acts.count("commented"), posts=acts.count("posted"), issues=0, partners={})
    def of(u, name):
        return agents.get(f"{u['run']}/agents/{name}")

    for u in units.values():
        if u["tab"] == "pulls":
            if a := of(u, u["author"]):
                a["opened"] += 1
                a["merged"] += u["state"] == "merged"
            if u["merged_by"] and (m := of(u, u["merged_by"])):
                m["merges"] += 1
            for who, verdict, _ in u["reviews"]:
                if verdict != "commented" and (r := of(u, who)):
                    r["partners"].setdefault(u["author"], [0, 0])[0 if verdict == "approved" else 1] += 1
        elif u["tab"] == "issues" and (a := of(u, u["author"])):
            a["issues"] += 1


# ------------------------------------------------------------------------------------------------ serving


def _read(index, refs):
    """{ref: record} for the refs, each line read at its byte offset."""
    out, by_path = {}, {}
    for ref in refs:
        path, _, n = ref.rpartition("#L")
        by_path.setdefault(path, []).append(int(n))
    for path, ns in by_path.items():
        with open(path, "rb") as f:
            for n in ns:
                f.seek(index["offsets"][path][n - 1])
                try:
                    out[f"{path}#L{n}"] = json.loads(f.readline())
                except ValueError:
                    continue
    return out


class _Labels:
    """The label calls of one fetch, each ref asked once: `keep(ref)`, `mark(ref)` (whether the first label that is on
    marks it) and `unit(u)` (whether the filter keeps the unit)."""

    def __init__(self):
        on = thimble.view_labels()["labels"]
        self.first = on[0]["name"] if on else None
        self._keep, self._mark, self._unit = {}, {}, {}

    def keep(self, ref):
        if ref not in self._keep:
            self._keep[ref] = thimble.kept(ref)
        return self._keep[ref]

    def mark(self, ref):
        if self.first is None:
            return False
        if ref not in self._mark:
            self._mark[ref] = any(m["label"] == self.first for m in thimble.marked(ref))
        return self._mark[ref]

    def unit(self, u):
        if u["key"] not in self._unit:
            self._unit[u["key"]] = thimble.kept_unit(u["refs"])
        return self._unit[u["key"]]


def _median(xs):
    xs = [x for x in xs if x is not None]
    return round(statistics.median(xs), 3) if xs else None


def _facets(tab, u):
    """{filter: [values]} of one unit, the values it is found under in each of the tab's filters."""
    if tab == "pulls":
        verdicts = sorted(set(u["latest"].values())) or ["no review"]
        return {"state": [u["state"]], "author": [u["author"]], "reviewer": sorted(u["latest"]), "verdict": verdicts,
                "area": [u["area"]], "reason": [u["reason"]] if u["reason"] else [], "flag": u["flags"]}
    if tab == "issues":
        return {"state": [u["state"]], "author": [u["author"]], "area": [u["area"]], "origin": [u["origin"]],
                "reason": [u["reason"]] if u["reason"] else []}
    if tab == "discussions":
        return {"author": list(u["posters"])}
    return {}


def _measures(tab, us, index, run):
    """One run's row: its measures over the units `us`."""
    if tab == "pulls":
        return {"n": len(us), "merged": sum(u["state"] == "merged" for u in us),
                "closed": sum(u["state"] == "closed" for u in us), "open": sum(u["state"] == "open" for u in us),
                "to_merge": _median(u["to_merge"] for u in us), "first_review": _median(u["first_review"] for u in us),
                "reviews": round(sum(len(u["reviews"]) for u in us) / len(us), 2) if us else None,
                **{f: sum(f in u["flags"] for u in us) for f in ("merged by its author", "merged over a change request",
                                                                 "pushed after its last approval")}}
    if tab == "issues":
        return {"n": len(us), "fixed": sum(u["state"] == "fixed" for u in us),
                "closed": sum(u["state"] == "closed" for u in us), "open": sum(u["state"] == "open" for u in us),
                "to_fix": _median(u["ended"] - u["at"] if u["state"] == "fixed" else None for u in us),
                "found": sum(u["origin"] != "backlog" for u in us), "several": sum(len(u["prs"]) > 1 for u in us)}
    if tab == "discussions":
        posters = {p for u in us for p in u["posters"]}
        return {"n": len(us), "posts": sum(u["posts"] for u in us), "posters": len(posters)}
    reviews = sorted((u["approved"] + u["changes"] for u in us), reverse=True)
    # pairs of agents who each approved a pull request of the other
    mutual = {tuple(sorted((u["name"], b))) for u in us for b, (ok, _) in u["partners"].items()
              if ok and index["units"].get(f"{run}/agents/{b}", {}).get("partners", {}).get(u["name"], [0])[0]}
    return {"n": len(us), "spread": reviews, "top": round(reviews[0] / sum(reviews), 3) if sum(reviews) else None,
            "mutual": len(mutual), "merges": sum(u["merges"] for u in us)}


def _item(tab, u, index, labels):
    """A unit as a row of the list, with its kept records as strip ticks: [ref, hours, action, marked], and for a
    closed one the closer's words (`why`, read from its close record)."""
    ticks = [[ref, h, act, labels.mark(ref)] for ref, h, act in u["events"] if labels.keep(ref)]
    base = {"key": u["key"], "run": u["run"], "at": u["at"], "ticks": ticks}
    if u.get("state") == "closed":
        ref = next(e[0] for e in reversed(u["events"]) if e[2] == "closed")
        base["why"] = {"ref": ref, "text": str(_read(index, [ref])[ref].get("text") or "")}
    if tab == "pulls":
        return {**base, **{k: u[k] for k in ("number", "title", "author", "state", "area", "closes", "merged_by",
                                             "closed_by", "reason", "ended", "to_merge", "first_review", "approvals",
                                             "changes", "comments", "flags", "latest")}, "commits": len(u["commits"]),
                "reviews": len(u["reviews"])}
    if tab == "issues":
        return {**base, **{k: u[k] for k in ("number", "title", "author", "state", "area", "origin", "prs",
                                             "fixed_by", "closed_by", "reason", "ended", "comments")}}
    if tab == "discussions":
        return {**base, **{k: u[k] for k in ("number", "title", "author", "posts", "posters", "mentions")}}
    return {**base, **{k: u[k] for k in ("name", "opened", "merged", "merges", "approved", "changes", "comments",
                                         "posts", "issues", "partners")}, "reviews": u["approved"] + u["changes"]}


SORTS = {
    "newest": (lambda u: -u["at"]), "oldest": (lambda u: u["at"]),
    "longest to merge": (lambda u: -(u.get("to_merge") if u.get("to_merge") is not None else -1)),
    "quickest first review": (lambda u: u["first_review"] if u.get("first_review") is not None else 1e9),
    "most reviews": (lambda u: -len(u.get("reviews") or [])),
    "most commits": (lambda u: -len(u.get("commits") or [])),
    "longest to fix": (lambda u: -((u["ended"] - u["at"]) if u.get("state") == "fixed" else -1)),
    "most comments": (lambda u: -(u.get("comments") or 0)),
    "most posts": (lambda u: -(u.get("posts") or 0)),
    "latest": (lambda u: -u["events"][-1][1] if u["events"] else 0),
}
AGENT_SORTS = ("merges", "opened", "merged", "reviews", "approved", "changes", "comments", "posts")


def _order(tab, units, sort):
    if tab == "agents":
        col = sort if sort in AGENT_SORTS else "merges"
        count = (lambda u: u["approved"] + u["changes"]) if col == "reviews" else (lambda u: u[col])
        return sorted(units, key=lambda u: (-count(u), u["run"], u["name"]))
    key = SORTS.get(sort) or (SORTS["most posts"] if tab == "discussions" else SORTS["newest"])
    return sorted(units, key=lambda u: (key(u), u["run"], u.get("number") or 0))


def _activity(units, index, labels, runs):
    """The kept records of the units per run, time bin and action: {bin: minutes, hours: the longest run, rows: [run,
    bin, action, n, marked]}."""
    span = max((index["runs"][r]["end"] - index["runs"][r]["start"]) / 3600 for r in runs) if runs else 1
    minutes = next((b for b in BINS if span * 60 / b <= MAX_BARS), BINS[-1])
    counts = {}
    for u in units:
        for ref, h, act in u["events"]:
            # a backlog issue was imported as its run began, which is no activity of the run
            if h < 0 or (h == 0 and act == "opened") or not labels.keep(ref):
                continue
            c = counts.setdefault((u["run"], int(h * 60 // minutes), act), [0, 0])
            c[0] += 1
            c[1] += labels.mark(ref)
    return {"bin": minutes, "hours": round(span, 3),
            "rows": [[r, b, a, n, m] for (r, b, a), (n, m) in sorted(counts.items())]}


def _grid(tab, units, index):
    """The compare grid of pull requests or issues: one row per issue, known by its number and title, which every run
    that shares the backlog has, with each run's pull requests for it or its state there. Pull requests that close no
    issue share a last row."""
    rows = {}
    for u in units:
        if tab == "pulls":
            issue = index["units"].get(f"{u['run']}/issues/{u.get('closes')}")
            row = (issue["number"], issue["title"]) if issue else (None, "")
            cell = {k: u[k] for k in ("key", "number", "state", "to_merge", "flags", "author")}
        else:
            row = (u["number"], u["title"])
            cell = {**{k: u[k] for k in ("key", "number", "state", "fixed_by", "prs")},
                    "to_fix": round(u["ended"] - u["at"], 3) if u["state"] == "fixed" else None}
        rows.setdefault(row, {}).setdefault(u["run"], []).append(cell)
    order = sorted(rows, key=lambda k: (k[0] is None, k[0] or 0, k[1]))
    return [{"number": k[0], "title": k[1],
             "cells": {r: sorted(cs, key=lambda c: c["number"]) for r, cs in rows[k].items()}} for k in order]


def _view(index, query):
    tab = query.get("tab") if query.get("tab") in TABS else "pulls"
    labels = _Labels()
    all_runs = sorted(index["runs"])
    chosen = [r for r in (query.get("runs") or []) if r in index["runs"]] or all_runs
    q = str(query.get("q") or "").strip().lower()
    rng = query.get("range") if isinstance(query.get("range"), list) and len(query["range"]) == 2 else None
    wanted = {k: v for k, v in (query.get("filters") or {}).items() if v not in (None, "")}

    kept = [u for u in index["units"].values() if labels.unit(u)]
    tabs = {t: sum(u["tab"] == t and u["run"] in chosen for u in kept) for t in TABS}
    found = [u for u in kept if u["tab"] == tab and (not q or q in u["search"])]
    facts = {u["key"]: _facets(tab, u) for u in found}

    def ok(u, skip=None):
        return all(v in facts[u["key"]].get(f, []) for f, v in wanted.items() if f != skip)

    def in_range(u):
        return not rng or any(rng[0] <= h < rng[1] for _, h, _ in u["events"])

    live = [u for u in found if in_range(u)]
    facets = {}
    for f in {f for u in live for f in facts[u["key"]]}:
        counts = {}
        for u in live:
            if u["run"] in chosen and ok(u, f):
                for v in facts[u["key"]].get(f, []):
                    counts[v] = counts.get(v, 0) + 1
        if f in wanted:
            counts.setdefault(wanted[f], 0)
        facets[f] = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))

    runs = []
    for r in all_runs:
        us = [u for u in live if u["run"] == r and ok(u)]
        info = index["runs"][r]
        runs.append({"run": r, "team": info["team"], "approvals": info["approvals"],
                     "hours": round((info["end"] - info["start"]) / 3600, 3), "chosen": r in chosen,
                     "marked": sum(any(labels.mark(ref) for ref in u["refs"]) for u in us),
                     **_measures(tab, us, index, r)})

    shown = _order(tab, [u for u in live if u["run"] in chosen and ok(u)], query.get("sort"))
    offset = max(0, int(query.get("offset") or 0))
    out = {"tab": tab, "tabs": tabs, "runs": runs, "chosen": chosen, "facets": facets, "total": len(shown),
           "offset": offset, "items": [_item(tab, u, index, labels) for u in shown[offset:offset + PAGE]],
           # the activity leaves out the time range, so the chart shows the range among the rest
           "activity": _activity([u for u in found if u["run"] in chosen and ok(u)], index, labels, chosen)}
    if query.get("compare") and tab in ("pulls", "issues"):
        out["grid"] = _grid(tab, shown, index)
    if tab == "agents":
        out["pairs"] = {r: {u["name"]: u["partners"] for u in shown if u["run"] == r} for r in chosen}
    return out


def _texts(index, refs):
    """The records of the refs as a page shows them: [{ref, kind, action, author, at, hours, text, ...}]."""
    read = _read(index, refs)
    out = []
    for ref in refs:
        r = read.get(ref)
        if not r:
            continue
        run = index["runs"][str(r["run"])]
        t = _epoch(r.get("at")) or run["start"]
        out.append({"ref": ref, "kind": r.get("kind"), "action": _action(r), "author": r.get("author") or "",
                    "at": r.get("at"), "hours": round((t - run["start"]) / 3600, 3),
                    **{f: r[f] for f in ("number", "title", "text", "sha", "verdict", "reason", "closes", "thread")
                       if r.get(f) is not None}})
    return out


def _elsewhere(index, u):
    """The same backlog issue in every run: [{run, key, state, prs: [{key, number, state}]}], for an issue or a pull
    request that closes one."""
    if u["tab"] == "pulls":
        issue = index["units"].get(f"{u['run']}/issues/{u.get('closes')}")
    else:
        issue = u
    if not issue:
        return []
    out = []
    for run in sorted(index["runs"]):
        twin = index["units"].get(f"{run}/issues/{issue['number']}")
        if not twin or twin["title"] != issue["title"]:
            continue
        prs = [index["units"][f"{run}/pull/{n}"] for n in twin["prs"]]
        out.append({"run": run, "key": twin["key"], "state": twin["state"],
                    "prs": [{"key": p["key"], "number": p["number"], "state": p["state"]} for p in prs]})
    return out


def _detail(index, key):
    """One unit's page: its facts and its records with their text, in time order."""
    u = index["units"].get(key)
    if u is None:
        return None
    labels = _Labels()
    run = index["runs"][u["run"]]
    out = {k: v for k, v in u.items() if k not in ("refs", "events", "search")}
    out["setup"] = {"team": run["team"], "approvals": run["approvals"], "hours": round((run["end"] - run["start"]) / 3600, 3)}
    refs = [e[0] for e in u["events"]] if u["tab"] != "agents" else u["refs"]
    out["records"] = [dict(x, marked=labels.mark(x["ref"])) for x in _texts(index, refs)
                      if labels.keep(x["ref"]) or x["ref"] == refs[0]]
    if u["tab"] in ("pulls", "issues"):
        out["elsewhere"] = _elsewhere(index, u)
    if u["tab"] == "pulls" and (issue := index["units"].get(f"{u['run']}/issues/{u.get('closes')}")):
        out["issue"] = {"key": issue["key"], "number": issue["number"], "title": issue["title"], "state": issue["state"]}
    if u["tab"] == "issues":
        out["pulls"] = [{k: index["units"][f"{u['run']}/pull/{n}"][k] for k in ("key", "number", "title", "state", "author")}
                        for n in u["prs"]]
    # the #n a text mentions or a record is on, as the pull request or issue of the run it names
    mentioned = {m for x in out["records"] for m in MENTION.findall(str(x.get("text") or ""))}
    mentioned |= {str(x["number"]) for x in out["records"] if x.get("number") is not None}
    out["links"] = {m: k for m in mentioned for k in (f"{u['run']}/pull/{m}", f"{u['run']}/issues/{m}")
                    if k in index["units"]}
    if u["tab"] == "agents":
        out["pulls"] = [{k: p[k] for k in ("key", "number", "title", "state")}
                        for p in index["units"].values() if p["tab"] == "pulls" and p["run"] == u["run"]
                        and p["author"] == u["name"]]
        out["reviewed_by"] = {p["name"]: p["partners"][u["name"]] for p in index["units"].values()
                              if p["tab"] == "agents" and p["run"] == u["run"] and u["name"] in p["partners"]}
    return out


def records(index, query):
    """{op: view, tab, runs?, compare?, q?, range?: [h0, h1], filters?: {filter: value}, sort?, offset?}: one tab under
    that selection, as _view describes. {op: unit, key}: one unit's page (_detail). Times are hours since the run's
    start."""
    query = query or {}
    if query.get("op") == "unit":
        return _detail(index, str(query.get("key") or ""))
    return _view(index, query)


def _excerpt(r):
    """A record's own text, one field per line; a record with none (a merge) gives its author."""
    lines = [str(r[f]) for f in ("title", "text", "verdict", "reason", "sha") if r.get(f)]
    return "\n".join(lines) or str(r.get("author") or r.get("kind") or "")


def resolve(index, locator):
    """repo.jsonl#L<n>: the record, opened in its unit. view:<slug>/<run>: the run, its excerpt the brief.
    view:<slug>/<run>/pull/<n>, issues/<n>, discussions/<n> or agents/<name>: the unit, its excerpt the first record's
    text, citing every record it gathers in time order."""
    if "key" in locator:
        key = str(locator["key"])
        if key in index["runs"]:
            run = index["runs"][key]
            if not run["ref"]:
                return None
            refs = [run["ref"]] + [ref for ref, k in index["line"].items() if k.startswith(key + "/")]
            brief = _read(index, [run["ref"]])[run["ref"]]
            return {"excerpt": str(brief.get("text") or key), "label": f"{key} · {run['team']} agents",
                    "refs": refs[:200], "key": key, "target": {"run": key}}
        u = index["units"].get(key)
        if u is None or not u["refs"]:
            return None
        first = _read(index, u["refs"][:1])[u["refs"][0]]
        name = u.get("title") or u.get("name") or key
        label = f"{u['run']} #{u['number']} {name}" if u.get("number") is not None and u["tab"] != "discussions" \
            else f"{u['run']} {name}"
        return {"excerpt": _excerpt(first), "label": label[:40], "refs": u["refs"][:200], "key": key,
                "target": {"key": key}}
    path, fragment = locator.get("path"), str(locator.get("fragment") or "")
    m = re.fullmatch(r"L(\d+)", fragment)
    if not m or path not in index["offsets"] or not 1 <= int(m.group(1)) <= len(index["offsets"][path]):
        return None
    ref = f"{path}#{fragment}"
    r = _read(index, [ref]).get(ref)
    key = index["line"].get(ref)
    if not isinstance(r, dict) or key is None:
        return None
    run, who = str(r["run"]), str(r.get("author") or "")
    if r.get("kind") == "run":
        label = f"{run} brief"
    elif r.get("number") is not None:
        label = f"{run} #{r['number']} {_action(r)} by {who}"
    else:
        label = f"{run} {_action(r)} by {who}"
    return {"excerpt": _excerpt(r), "label": label[:40], "refs": [ref], "key": key,
            "target": {"run": key} if key == run else {"key": key, "ref": ref}}
