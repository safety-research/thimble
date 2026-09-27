# Linked sessions: the sessions of agent teams, each run's sessions on one clock, with every subagent under the session
# that spawned it.
#
# The data (sample/): three files, one JSON record per line. A record is known by its fields, not by its file's name.
# sessions.jsonl, one line per session:
#   id         the session's id, unique across runs
#   run        the run it belongs to; a run's sessions share one clock, which starts with its first session
#   team       how the run's team was set up, the same on each of its sessions
#   agent      the agent's name, such as lead or client-port
#   parent     the session that spawned it with a Task call, or null for the run's lead
#   started    when it started, ISO 8601
#   ended      when it ended, ISO 8601
# calls.jsonl, one line per tool call:
#   session    the session that made the call
#   at         when the call started, ISO 8601
#   seconds    how long it ran; a Task call runs until its subagent returns
#   tool       the tool, such as Read, Edit, Bash, Grep, WebSearch or Task
#   input      what the call was given: a path, a command, a pattern, a query, or a Task's description
#   outcome    ok, error, or denied when the permission rules refused it
#   result     what came back, in a line
#   exit       a failed command's exit code
#   files      the paths the call read, edited or ran against
#   matches    the files a Grep matched
#   old        the text an Edit replaced
#   new        the text the Edit put in its place
#   output     a command's whole output
#   spawned    the session a Task call started
# messages.jsonl, one line per message:
#   session    the session it belongs to
#   at         when, ISO 8601
#   kind       prompt (the task the session was given), text (what the agent said between calls) or result (what it
#              handed back when it ended)
#   text       the message
#
# The method: the index keeps each session's place in its run's tree, each call's facts (its session, its time on the
# run's clock, its tool, outcome, files and the words a search looks in) and every record's byte offset; the text of a
# call or a message is read back when a transcript shows it. One fetch answers the overview under the page's selection:
# the runs and sessions with their counts, every call that passes as one mark, and the values of every field with their
# counts, each count holding every filter but its own field's. Other fetches answer a session's transcript, what the
# other sessions of its run were doing at one moment, and a comparison of sessions or runs side by side.
#
# Labels: they apply when records are served, never in the index. A call passes when thimble.kept holds for it, and a
# session stays when thimble.kept_unit holds for its records or one of its subagents stays, so the tree keeps its
# shape. Every call carries the values of the labels that are on that mark it (thimble.marked), which colour it in the
# page; the page may also hide the calls a label value marks, or the calls no label marks.
import json
import re
from datetime import datetime, timezone

import thimble

FIELDS = ("run", "agent", "tool", "outcome", "ftype", "dur")
DURATIONS = ("under 1 s", "1–10 s", "over 10 s")
NO_FILE = "no file"
TEST_PATH = re.compile(r"(^|/)tests?/|(^|/)test_[^/]*$")


def _epoch(t):
    try:
        dt = datetime.fromisoformat(str(t).replace("Z", "+00:00"))
    except ValueError:
        return None
    return (dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)).timestamp()


def _ftype(files):
    """A call's file type, from its first file: the extension, marked test for a file under tests/ or named test_*."""
    if not files:
        return NO_FILE
    f = str(files[0])
    name = f.rsplit("/", 1)[-1]
    ext = "." + name.rsplit(".", 1)[1] if "." in name else name
    return f"test {ext}" if TEST_PATH.search(f) else ext


def _dur(seconds):
    return DURATIONS[0] if seconds < 1 else DURATIONS[1] if seconds <= 10 else DURATIONS[2]


def _merge(spans):
    out = []
    for a, b in sorted(spans):
        if out and a <= out[-1][1] + 1:
            out[-1][1] = max(out[-1][1], b)
        else:
            out.append([a, b])
    return out


def build_index(paths):
    """{"offsets": {path: [byte offset of line n at n-1]}, "runs": {run: facts}, "sessions": {id: facts}, "calls": [facts],
    "messages": [facts], "values": {field: [values in their order]}}. Times are seconds on the run's clock. A session's
    `order` is its run's sessions in tree order, each after the session that spawned it; a call's `words` is the
    lowercased text a search looks in. A line that is not JSON, that no kind of record fits, or a session without a
    start and an end, is in `offsets` only."""
    offsets, sessions, raw_calls, raw_msgs = {}, {}, [], []
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
                if not isinstance(r, dict):
                    continue
                ref = f"{path}#L{n}"
                if r.get("tool") and r.get("session"):
                    raw_calls.append((ref, r))
                elif r.get("kind") and r.get("session") and "text" in r:
                    raw_msgs.append((ref, r))
                elif r.get("id") and r.get("run") and r.get("agent"):
                    t0, t1 = _epoch(r.get("started")), _epoch(r.get("ended"))
                    if t0 is not None and t1 is not None:
                        sessions[str(r["id"])] = {"id": str(r["id"]), "ref": ref, "run": str(r["run"]), "team": str(r.get("team") or ""),
                                                  "agent": str(r["agent"]), "parent": r.get("parent"), "t0": t0, "t1": t1}

    runs = {}
    for s in sessions.values():
        run = runs.setdefault(s["run"], {"id": s["run"], "team": s["team"], "start": s["t0"], "sessions": []})
        run["start"] = min(run["start"], s["t0"])
    for s in sessions.values():
        start = runs[s["run"]]["start"]
        s["start"], s["end"] = round(s["t0"] - start, 1), round(s["t1"] - start, 1)
        s["calls"], s["msgs"], s["tasks"] = [], [], []
        if s["parent"] not in sessions:
            s["parent"] = None

    calls = []
    for ref, r in sorted(raw_calls, key=lambda x: _epoch(x[1].get("at")) or 0):
        s = sessions.get(str(r["session"]))
        t = _epoch(r.get("at"))
        if s is None or t is None:
            continue
        files = [str(f) for f in r.get("files") or []]
        d = float(r.get("seconds") or 0)
        c = {"ref": ref, "i": len(calls), "s": s["id"], "t": round(t - runs[s["run"]]["start"], 1), "d": round(d, 2), "tool": str(r["tool"]),
             "out": str(r.get("outcome") or "ok"), "files": files, "child": r.get("spawned") if r.get("spawned") in sessions else None,
             "input": str(r.get("input") or "")[:160]}
        c["ftype"], c["dur"] = _ftype(files), _dur(d)
        c["words"] = " ".join(str(r.get(k) or "") for k in ("tool", "input", "result", "old", "new", "output")).lower() + " " + " ".join(
            files + [str(m) for m in r.get("matches") or []]).lower()
        calls.append(c)
        s["calls"].append(c["i"])
        if c["child"]:
            s["tasks"].append(c["i"])
            sessions[c["child"]]["spawn"] = c["i"]

    messages = []
    for ref, r in sorted(raw_msgs, key=lambda x: _epoch(x[1].get("at")) or 0):
        s = sessions.get(str(r["session"]))
        t = _epoch(r.get("at"))
        if s is None or t is None:
            continue
        s["msgs"].append(len(messages))
        messages.append({"ref": ref, "s": s["id"], "t": round(t - runs[s["run"]]["start"], 1), "kind": str(r["kind"]),
                         "words": str(r.get("text") or "").lower()})

    for s in sessions.values():
        s["waits"] = _merge([(calls[i]["t"], calls[i]["t"] + calls[i]["d"]) for i in s["tasks"]])
        # a session's records: its own line, its prompt, then its calls and other messages in time order
        rest = sorted([(calls[i]["t"], calls[i]["ref"]) for i in s["calls"]] +
                      [(messages[i]["t"], messages[i]["ref"]) for i in s["msgs"] if messages[i]["kind"] != "prompt"])
        s["refs"] = [s["ref"]] + [messages[i]["ref"] for i in s["msgs"] if messages[i]["kind"] == "prompt"] + [r for _, r in rest]
    for run in runs.values():
        def walk(parent, depth):
            kids = sorted((x for x in sessions.values() if x["run"] == run["id"] and x["parent"] == parent), key=lambda x: x["start"])
            for x in kids:
                x["depth"] = depth
                run["sessions"].append(x["id"])
                walk(x["id"], depth + 1)
        walk(None, 0)
        run["span"] = max(sessions[i]["end"] for i in run["sessions"])
    order = sorted(runs, key=lambda k: runs[k]["start"])
    for run in runs.values():
        run["started"] = datetime.fromtimestamp(run["start"], timezone.utc).isoformat()

    def by_count(field, last=()):
        n = {}
        for c in calls:
            n[c[field]] = n.get(c[field], 0) + 1
        return sorted(n, key=lambda v: (v in last, -n[v], v))

    agents = []
    for k in order:
        for i in runs[k]["sessions"]:
            if sessions[i]["agent"] not in agents:
                agents.append(sessions[i]["agent"])
    values = {"run": order, "agent": agents, "tool": by_count("tool"), "outcome": by_count("out"),
              "ftype": by_count("ftype", (NO_FILE,)), "dur": [d for d in DURATIONS if any(c["dur"] == d for c in calls)]}
    # what every run's lead was asked, when they were all asked the same
    prompts = {str(_text_of(offsets, messages[i]["ref"])) for k in order for i in sessions[runs[k]["sessions"][0]]["msgs"]
               if messages[i]["kind"] == "prompt"}
    return {"offsets": offsets, "runs": runs, "order": order, "task": prompts.pop() if len(prompts) == 1 else None, "sessions": sessions, "calls": calls, "messages": messages, "values": values}


def _text_of(offsets, ref):
    path, _, line = ref.rpartition("#L")
    with open(path, "rb") as f:
        f.seek(offsets[path][int(line) - 1])
        return json.loads(f.readline()).get("text") or ""


# ----------------------------------------------------------------------------------------------------- the selection


def _value(index, c, field):
    s = index["sessions"][c["s"]]
    return s["run"] if field == "run" else s["agent"] if field == "agent" else c["out"] if field == "outcome" else c[field]


def _classes():
    """The label values that are on, each {label, value, colour}, in the labels' order: what colours a call."""
    return [{"label": lab["name"], "value": v["name"], "colour": v["colour"]} for lab in thimble.view_labels()["labels"] for v in lab["values"]]


def _key(label, value):
    return f"{label}\n{value}"


class Selection:
    """The page's selection over the index: `filters` {field: [hidden values]}, `search` (words a call's or a message's
    text holds), `hide`, the label values whose calls are hidden (`label\\nvalue`, or "none" for the calls no label
    that is on marks), and `win`, the time window the counts keep to. Each call's marks and the label filter's verdict
    on it are looked up once."""

    def __init__(self, index, query):
        q = query or {}
        self.index = index
        self.hidden = {f: set(v or []) for f, v in (q.get("filters") or {}).items() if f in FIELDS and v}
        self.search = str(q.get("search") or "").strip().lower()
        self.hide = set(q.get("hide") or [])
        win = q.get("win")
        self.win = (float(win[0]), float(win[1])) if isinstance(win, list) and len(win) == 2 else None
        self.classes = _classes()
        keys = {_key(c["label"], c["value"]): i for i, c in enumerate(self.classes)}
        self.marks, self.kept = {}, {}
        for c in index["calls"]:
            if self.classes:
                self.marks[c["i"]] = sorted({keys[k] for m in thimble.marked(c["ref"]) if (k := _key(m["label"], m["value"])) in keys})
            self.kept[c["i"]] = thimble.kept(c["ref"])

    def fields(self, c, but=None):
        """Whether a call passes the field filters, all or all but the field `but`, and the search."""
        for f, hid in self.hidden.items():
            if f != but and _value(self.index, c, f) in hid:
                return False
        return not self.search or self.search in c["words"]

    def labelled(self, c):
        """Whether a call passes the label filter and the label values the page hides."""
        if not self.kept[c["i"]]:
            return False
        if self.hide and self.classes:
            got = [_key(self.classes[i]["label"], self.classes[i]["value"]) for i in self.marks.get(c["i"], [])] or ["none"]
            if all(k in self.hide for k in got):
                return False
        return True

    def passes(self, c, but=None):
        return self.fields(c, but) and self.labelled(c)

    def in_window(self, c):
        """Whether a call runs within the time window on its run's clock, which the counts keep to."""
        return not self.win or (c["t"] + c["d"] >= self.win[0] and c["t"] <= self.win[1])

    def message(self, m):
        s = self.index["sessions"][m["s"]]
        return s["run"] not in self.hidden.get("run", ()) and s["agent"] not in self.hidden.get("agent", ())

    def shown_sessions(self):
        """The sessions that stay: not hidden by run or agent, kept by the label filter, or holding one that stays."""
        ix, keep = self.index, set()
        for sid, s in ix["sessions"].items():
            if s["run"] in self.hidden.get("run", ()) or s["agent"] in self.hidden.get("agent", ()):
                continue
            if thimble.kept_unit(s["refs"]):
                while sid and sid not in keep:
                    keep.add(sid)
                    sid = ix["sessions"][sid]["parent"]
        return keep


def _counts(calls, err="error", den="denied"):
    return {"n": len(calls), "err": sum(1 for c in calls if c["out"] == err), "den": sum(1 for c in calls if c["out"] == den)}


def _overview(index, query):
    sel = Selection(index, query)
    ix = index
    keep = sel.shown_sessions()
    passing = [c for c in ix["calls"] if c["s"] in keep and sel.passes(c)]
    by_s = {}
    for c in passing:
        by_s.setdefault(c["s"], []).append(c)
    sessions, runs = [], []
    for k in ix["order"]:
        run = ix["runs"][k]
        ids = [i for i in run["sessions"] if i in keep]
        if not ids:
            continue
        runs.append({"id": k, "key": k, "team": run["team"], "started": run["started"], "span": run["span"], "sessions": ids,
                     **_counts([c for i in ids for c in by_s.get(i, [])])})
        for i in ids:
            s = ix["sessions"][i]
            sessions.append({"id": i, "key": i, "ref": s["ref"], "run": k, "agent": s["agent"], "parent": s["parent"] if s["parent"] in keep else None,
                             "depth": s["depth"], "start": s["start"], "end": s["end"], "waits": s["waits"],
                             "spawn": ix["calls"][s["spawn"]]["t"] if s.get("spawn") is not None else None, **_counts(by_s.get(i, []))})
    fields = {}
    for f in FIELDS:
        n = {}
        for c in ix["calls"]:
            if c["s"] in keep and sel.in_window(c) and sel.passes(c, but=f):
                v = _value(ix, c, f)
                n[v] = n.get(v, 0) + 1
        fields[f] = [{"v": v, "n": n.get(v, 0)} for v in ix["values"][f]]
    # a legend's counts leave out the label values it hides, so a hidden value still says how many calls it marks
    classes, none = [{**cl, "n": 0} for cl in sel.classes], 0
    for c in ix["calls"]:
        if c["s"] in keep and sel.in_window(c) and sel.kept[c["i"]] and sel.fields(c):
            got = sel.marks.get(c["i"], [])
            for i in got:
                classes[i]["n"] += 1
            none += not got
    hits = [{"ref": m["ref"], "s": m["s"], "t": m["t"], "kind": m["kind"]} for m in ix["messages"]
            if sel.search and m["s"] in keep and sel.message(m) and sel.search in m["words"]]
    return {"runs": runs, "sessions": sessions, "span": max([ix["runs"][k]["span"] for k in ix["order"]] or [0]),
            "calls": [{"ref": c["ref"], "s": c["s"], "t": c["t"], "d": c["d"], "tool": c["tool"], "out": c["out"], "ftype": c["ftype"],
                       "dur": c["dur"], "files": c["files"], "child": c["child"], "input": c["input"][:80], "m": sel.marks.get(c["i"], [])}
                      for c in passing],
            "task": ix["task"], "totals": {"runs": len(ix["runs"]), "sessions": len(ix["sessions"])},
            "days": sorted({ix["runs"][k]["started"][:10] for k in ix["order"]}),
            "messages": hits, "fields": fields, "classes": classes, "none": none, "total": len(ix["calls"])}


# ------------------------------------------------------------------------------------------------ the other answers


def _read(index, ref):
    """The record a ref names, read from its byte offset."""
    path, _, line = ref.rpartition("#L")
    with open(path, "rb") as f:
        f.seek(index["offsets"][path][int(line) - 1])
        return json.loads(f.readline())


def _session(index, query):
    """One session's transcript: its messages and the calls that pass the selection, in time order, each call with its
    whole record, its place among the session's calls and the time its command ran next; and the subagents' returns."""
    ix, sel = index, Selection(index, query)
    s = ix["sessions"].get(str(query.get("id")))
    if s is None:
        return None
    items = []
    for i in s["msgs"]:
        m = ix["messages"][i]
        items.append({"kind": m["kind"], "ref": m["ref"], "t": m["t"], "text": str(_read(ix, m["ref"]).get("text") or "")})
    for k, i in enumerate(s["calls"]):
        c = ix["calls"][i]
        if not sel.passes(c):
            continue
        r = _read(ix, c["ref"])
        again = next((ix["calls"][j] for j in s["calls"][k + 1:] if ix["calls"][j]["tool"] == c["tool"] == "Bash" and ix["calls"][j]["input"] == c["input"]), None)
        items.append({"kind": "call", "ref": c["ref"], "t": c["t"], "d": c["d"], "tool": c["tool"], "out": c["out"], "k": k + 1,
                      "input": str(r.get("input") or ""), "result": str(r.get("result") or ""), "exit": r.get("exit"),
                      "files": c["files"], "matches": [str(m) for m in r.get("matches") or []], "old": r.get("old"), "new": r.get("new"),
                      "output": r.get("output"), "child": c["child"], "m": sel.marks.get(c["i"], []),
                      "again": {"t": again["t"], "out": again["out"]} if again else None})
    for i in s["tasks"]:
        c = ix["calls"][i]
        kid = ix["sessions"][c["child"]]
        result = next((ix["messages"][j] for j in kid["msgs"] if ix["messages"][j]["kind"] == "result"), None)
        items.append({"kind": "return", "t": kid["end"], "child": kid["id"], "ran": round(kid["end"] - kid["start"], 1),
                      "ref": result["ref"] if result else None,
                      "text": str(_read(ix, result["ref"]).get("text") or "") if result else ""})
    for a, b in s["waits"]:
        kids = [ix["sessions"][ix["calls"][i]["child"]]["id"] for i in s["tasks"] if ix["calls"][i]["t"] < b and ix["calls"][i]["t"] + ix["calls"][i]["d"] > a]
        items.append({"kind": "wait", "t": a + 1.5, "a": a, "b": b, "on": kids})
    order = {"prompt": 0, "call": 1, "text": 1, "wait": 2, "return": 2, "result": 3}
    items.sort(key=lambda x: (x["t"], order.get(x["kind"], 1)))
    return {"id": s["id"], "n": len(s["calls"]), "items": items, "classes": sel.classes}


def _moment(index, query):
    """What every other session of a run was doing at `t` on its clock: not started yet, returned, waiting on its
    subagents, or its last call before `t`."""
    ix = index
    run = ix["runs"].get(str(query.get("run")))
    if run is None:
        return []
    t, out = float(query.get("t") or 0), []
    for sid in run["sessions"]:
        if sid == query.get("session"):
            continue
        s = ix["sessions"][sid]
        row = {"id": sid, "agent": s["agent"]}
        if t < s["start"]:
            row.update(state="starts", at=s["start"])
        elif t > s["end"]:
            row.update(state="returned", at=s["end"])
        elif any(a <= t <= b for a, b in s["waits"]):
            kids = [ix["calls"][i]["child"] for i in s["tasks"] if ix["calls"][i]["t"] <= t <= ix["calls"][i]["t"] + ix["calls"][i]["d"]]
            row.update(state="waiting", on=[ix["sessions"][k]["agent"] for k in kids])
        else:
            last = next((ix["calls"][i] for i in reversed(s["calls"]) if ix["calls"][i]["t"] <= t), None)
            row.update(state="call", at=last["t"], tool=last["tool"], input=last["input"], ref=last["ref"]) if last else row.update(state="starting")
        out.append(row)
    return out


def _compare(index, query):
    """Sessions or runs side by side, each a group: a run with every session in it, a session with its subagents when
    `subs` holds. Each group's calls that pass the selection, counted by tool, outcome and label value; its times; the
    files it read and edited; and its errors and denials, timed from the group's first session."""
    ix, sel = index, Selection(index, query)
    groups = []
    for gid in query.get("ids") or []:
        if gid in ix["runs"]:
            run = ix["runs"][gid]
            root, members = ix["sessions"][run["sessions"][0]], list(run["sessions"])
        elif gid in ix["sessions"]:
            root = ix["sessions"][gid]
            members = [root["id"]]
            if query.get("subs", True):
                todo = [root["id"]]
                while todo:
                    parent = todo.pop(0)
                    kids = [x["id"] for x in ix["sessions"].values() if x["parent"] == parent]
                    members += kids
                    todo += kids
                members = [i for i in ix["runs"][root["run"]]["sessions"] if i in members]
        else:
            continue
        calls = [ix["calls"][i] for sid in members for i in ix["sessions"][sid]["calls"]]
        calls = sorted((c for c in calls if sel.passes(c)), key=lambda c: c["t"])
        tools, classes, files = {}, [0] * len(sel.classes), {}
        for c in calls:
            tools[c["tool"]] = tools.get(c["tool"], 0) + 1
            for i in sel.marks.get(c["i"], []):
                classes[i] += 1
            for f in c["files"]:
                use = files.setdefault(f, [0, 0])
                if c["tool"] == "Edit":
                    use[0] += 1
                elif c["tool"] == "Read":
                    use[1] += 1
        errors = [{"ref": c["ref"], "t": round(c["t"] - root["start"], 1), "out": c["out"], "agent": ix["sessions"][c["s"]]["agent"],
                   "tool": c["tool"], "input": c["input"], "result": str(_read(ix, c["ref"]).get("result") or c["out"])}
                  for c in calls if c["out"] != "ok"]
        groups.append({"id": gid, "run": root["run"], "team": ix["runs"][root["run"]]["team"], "root": root["id"], "sessions": members,
                       "agents": [ix["sessions"][i]["agent"] for i in members], "start": root["start"], "end": root["end"],
                       **_counts(calls), "tools": tools, "classes": classes,
                       "wall": round(root["end"] - root["start"], 1),
                       "summed": round(sum(ix["sessions"][i]["end"] - ix["sessions"][i]["start"] for i in members), 1),
                       "in_tools": round(sum(c["d"] for c in calls if not c["child"]), 1),
                       "waiting": round(sum(b - a for a, b in root["waits"]), 1) if len(members) > 1 else 0,
                       "files": files, "errors": errors})
    return {"groups": groups, "classes": sel.classes, "tools": ix["values"]["tool"]}


def records(index, query):
    q = query or {}
    op = q.get("op", "overview")
    if op == "session":
        return _session(index, q)
    if op == "moment":
        return _moment(index, q)
    if op == "compare":
        return _compare(index, q)
    return _overview(index, q)


# ---------------------------------------------------------------------------------------------------------- places


def _clock(t):
    return f"{int(t // 60):02d}:{int(t % 60):02d}"


def resolve(index, locator):
    ix = index
    if "key" in locator:
        key = str(locator["key"])
        if key in ix["runs"]:
            run = ix["runs"][key]
            lead = ix["sessions"][run["sessions"][0]]
            prompt = next((ix["messages"][i] for i in lead["msgs"] if ix["messages"][i]["kind"] == "prompt"), None)
            refs = [ix["sessions"][i]["ref"] for i in run["sessions"]] + [r for i in run["sessions"] for r in ix["sessions"][i]["refs"][1:]]
            text = str(_read(ix, prompt["ref"]).get("text") or "") if prompt else ""
            return {"excerpt": "\n".join(x for x in (run["team"], text) if x) or lead["agent"], "label": f"{key} · {run['team']}".strip(" ·"),
                    "refs": refs, "key": key, "target": {"run": key}}
        s = ix["sessions"].get(key)
        if s is None:
            return None
        prompt = next((ix["messages"][i] for i in s["msgs"] if ix["messages"][i]["kind"] == "prompt"), None)
        text = str(_read(ix, prompt["ref"]).get("text") or "") if prompt else ""
        return {"excerpt": "\n".join(x for x in (s["agent"], text) if x), "label": f"{s['agent']} · {s['run']}", "refs": s["refs"],
                "key": key, "target": {"session": key}}
    path, frag = str(locator.get("path") or ""), str(locator.get("fragment") or "")
    m = re.fullmatch(r"L(\d+)", frag)
    if not m or path not in ix["offsets"]:
        return None
    ref = f"{path}#L{m[1]}"
    for c in ix["calls"]:
        if c["ref"] == ref:
            r = _read(ix, ref)
            s = ix["sessions"][c["s"]]
            text = "\n".join(str(r.get(k)) for k in ("input", "result") if r.get(k))
            return {"excerpt": text or c["tool"], "label": f"{s['agent']} · {c['tool']} {_clock(c['t'])}", "refs": [ref], "key": s["id"],
                    "target": {"session": s["id"], "call": ref}}
    for mm in ix["messages"]:
        if mm["ref"] == ref:
            s = ix["sessions"][mm["s"]]
            return {"excerpt": str(_read(ix, ref).get("text") or ""), "label": f"{s['agent']} · {mm['kind']} {_clock(mm['t'])}", "refs": [ref],
                    "key": s["id"], "target": {"session": s["id"], "message": ref}}
    for s in ix["sessions"].values():
        if s["ref"] == ref:
            return {"excerpt": f"{s['agent']}\n{s['id']}", "label": f"{s['agent']} · {s['run']}", "refs": [ref], "key": s["id"],
                    "target": {"session": s["id"]}}
    return None
