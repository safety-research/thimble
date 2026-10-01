# Linked sessions: the sessions of agent teams, each run's sessions on one clock, with every subagent under the session
# that spawned it.
#
# The data (sample/): transcripts, runs/*.jsonl, and each run's index, runs/*/sessions-index.json, one folder per run as
# the harness that ran the teams wrote it.
#   runs/<run>/<session id>.jsonl                        the lead's transcript
#   runs/<run>/<session id>/subagents/agent-<id>.jsonl   a subagent's transcript, named by its agent id; the subagents a
#                                                        subagent spawned sit in the same folder
#   runs/<run>/sessions-index.json                       the run's index
# A transcript holds one JSON object per line:
#   type           user or assistant
#   uuid           the line's id
#   parentUuid     the line before it in the conversation, or null
#   timestamp      when the line was written
#   message        {role, content}: content is a string for a prompt, else a list of blocks: text {text}, tool_use
#                  {id, name, input} and tool_result {tool_use_id, content, is_error}. A Task call's input holds the
#                  subagent's description, prompt and subagent_type.
#   toolUseResult  the harness's copy of a result: {agentId} for a Task, {filenames} for a Grep, a string for an error
# sessions-index.json, one JSON document:
#   version        1 or 2
#   team           how the run's team was set up
#   sessions       version 1: [{session_id, agent, file}]
#   entries        version 2: [{sessionId, agentId, agentType, path, created, messageCount}]
#
# What the reader cleans up, since the harness changed between runs and runs end untidily:
#   - timestamps come as ISO 8601 with Z or an offset, with or without milliseconds, or as epoch milliseconds;
#   - a line written twice (the same uuid) counts once, and a session's lines are put in time order;
#   - a line that is not JSON, such as the last line of a session that was cut off, a line with no time the reader can
#     read, a tool result for no call before it and an index that is not JSON are left out, and problems() lists them
#     for thimble to show;
#   - the files on disk are the sessions: the index only names the team and the agents, and it may miss a session or
#     list one that is gone;
#   - r1's harness flags an error with isError and the later ones with is_error, and r3's calls the Task tool Agent;
#   - a subagent is named by its Task call's subagent_type, else by the index; the call that spawned it is the one
#     whose toolUseResult names its agentId, else whose result's text says "agentId: <id>", else whose prompt it got;
#   - some facts are only in a result's text: a command's exit code ("Exit code 1"), a permission denial ("Permission to
#     use Bash has been denied: ..."), a Grep's matched files one per line, and the files a command ran against.
#
# The method: the index keeps each session's place in its run's tree, each call's facts (its session, its time on the
# run's clock, its tool, outcome, files and the words a search looks in) and every line's byte offset. A call is its
# tool_use line and its tool_result line; its text, or a message's, is read back when a transcript shows it. One fetch
# answers the overview under the page's selection: the runs and sessions with their counts, every call that passes as
# one mark, and the values of every field with their counts, each count holding every filter but its own field's.
# Other fetches answer a session's transcript, what the other sessions of its run were doing at one moment, and a
# comparison of sessions or runs side by side.
#
# Labels: they apply when records are served, never in the index. A call passes when thimble.kept_unit holds for its
# two lines, and a session stays when it holds for its records or one of its subagents stays, so the tree keeps its
# shape. Every call carries the values of the labels that are on that mark either of its lines (thimble.marked), which
# colour it in the page; the page may also hide the calls a label value marks, or the calls no label marks.
import json
import os
import re
from datetime import datetime, timezone

import thimble

FIELDS = ("run", "agent", "tool", "outcome", "ftype", "dur")
DURATIONS = ("under 1 s", "1–10 s", "over 10 s")
NO_FILE = "no file"
LEAD = "lead"
TEST_PATH = re.compile(r"(^|/)tests?/|(^|/)test_[^/]*$")
TOOL_NAMES = {"Agent": "Task"}
PATH = re.compile(r"(?<![\w./:-])((?:[\w.-]+/)+[\w.-]+\.[A-Za-z]\w*)")  # a path with a folder and an extension
EXIT = re.compile(r"Exit code (\d+)")
DENIED = re.compile(r"Permission to use \S+ has been denied[.:]?\s*")
AGENT_ID = re.compile(r"agentId: (\w+)")


def _problem(problems, ref, why):
    """Note that the line `ref` holds no record because it does not parse."""
    problems.append({"ref": ref, "why": why})


def _epoch(t):
    """Seconds since the epoch: from epoch milliseconds, or from ISO 8601 with Z, an offset or none (read as UTC)."""
    if isinstance(t, bool) or t is None:
        return None
    if isinstance(t, (int, float)):
        return t / 1000 if t > 1e11 else float(t)
    try:
        dt = datetime.fromisoformat(str(t).strip().replace("Z", "+00:00"))
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


# ------------------------------------------------------------------------------------------------ reading the lines


def _msg_of(record):
    """A line's message; {} when it is not an object."""
    msg = record.get("message")
    return msg if isinstance(msg, dict) else {}


def _blocks(record):
    """A line's content blocks; a prompt written as a plain string is one text block."""
    content = _msg_of(record).get("content")
    if isinstance(content, str):
        return [{"type": "text", "text": content}]
    return [b for b in content if isinstance(b, dict)] if isinstance(content, list) else []


def _text(content):
    """The text of a block's content, a string or a list of text blocks."""
    if isinstance(content, list):
        return "\n".join(str(b.get("text") or "") for b in content if isinstance(b, dict) and b.get("type") == "text")
    return "" if content is None else str(content)


def _message_text(record):
    return "\n".join(str(b.get("text") or "") for b in _blocks(record) if b.get("type") == "text")


def _block(record, kind, key, value):
    return next((b for b in _blocks(record) if b.get("type") == kind and b.get(key) == value), None)


def _input(tool, inp, literal=False):
    """What a call was given, in a line: a path, a command, a Grep's pattern with its path and mode, a query, or a
    Task's description. `literal` keeps a Grep to its pattern, which the record holds word for word."""
    if tool == "Grep":
        if literal:
            return str(inp.get("pattern") or "")
        pattern = str(inp.get("pattern") or "").replace('"', '\\"')
        return " ".join(x for x in (f'"{pattern}"', str(inp.get("path") or ""),
                                    "-l" if inp.get("output_mode") == "files_with_matches" else "", "-n" if inp.get("-n") else "") if x)
    for k in ("file_path", "command", "query", "description", "url", "pattern"):
        if inp.get(k):
            return str(inp[k])
    return next((str(v) for v in inp.values() if isinstance(v, str)), "")


def _facts(tool, inp, block, tur):
    """What a call's lines say, as any version of the harness wrote them: {out, result, exit, text, output, files,
    matches, old, new}. `text` is what came back without an "Exit code" or "agentId" line, `result` its first line
    without a denial's or an error's prefix, and `output` the text when it runs to more lines."""
    lines = [ln for ln in (_text(block.get("content")) if block else "").splitlines() if ln.strip()]
    code = EXIT.fullmatch(lines[0].strip()) if lines else None
    lines = [ln for ln in lines[1 if code else 0:] if not AGENT_ID.fullmatch(ln.strip())]
    first = lines[0] if lines else ""
    denied = bool(DENIED.match(first))
    first = re.sub(r"^Error: ", "", first[DENIED.match(first).end():] if denied else first)
    flagged = bool(block and (block.get("is_error") or block.get("isError")))
    if isinstance(tur, dict) and isinstance(tur.get("filenames"), list):
        matches = [str(f) for f in tur["filenames"]]
    elif tool == "Grep":
        matches = [ln.strip() for ln in lines[1:] if PATH.fullmatch(ln.strip())]
    else:
        matches = []
    if inp.get("file_path"):
        files = [str(inp["file_path"])]
    elif tool == "Bash":
        files = list(dict.fromkeys(PATH.findall(str(inp.get("command") or "")) + PATH.findall("\n".join(lines))))
    else:
        files = []
    return {"out": "denied" if denied else "error" if flagged else "ok", "result": first, "exit": int(code[1]) if code else None,
            "text": "\n".join(lines), "output": "\n".join(lines) if len(lines) > 1 else None, "files": files, "matches": matches,
            "old": inp.get("old_string"), "new": inp.get("new_string")}


def _where(path):
    """(run, session id, the lead's session id or None) of a transcript, from where it sits."""
    parts = path.replace(os.sep, "/").split("/")
    name = parts[-1][: -len(".jsonl")]
    if len(parts) >= 4 and parts[-2] == "subagents":
        return parts[-4], name[len("agent-"):] if name.startswith("agent-") else name, parts[-3]
    return (parts[-2] if len(parts) >= 2 else "."), name, None


def _run_index(path, offs, problems):
    """{team, team_line, names: {session or agent id: agent name}} from a run's index, in either version; {} for an index
    that does not parse, which is a problem."""
    with open(path, "rb") as f:
        raw = f.read()
    pos = 0
    for line in raw.splitlines(keepends=True):
        offs.append(pos)
        pos += len(line)
    try:
        doc = json.loads(raw)
    except ValueError:
        doc = None
    if not isinstance(doc, dict):
        _problem(problems, f"{path}#L1", "the index is not a JSON object")
        return {}
    names = {}
    entries = doc.get("entries") or doc.get("sessions")
    for e in entries if isinstance(entries, list) else []:
        if isinstance(e, dict):
            key, name = e.get("agentId") or e.get("session_id") or e.get("sessionId"), e.get("agentType") or e.get("agent")
            if key and name:
                names[str(key)] = str(name)
    team_line = next((n for n, line in enumerate(raw.splitlines(), 1) if b'"team"' in line), None)
    return {"team": str(doc.get("team") or ""), "team_line": team_line, "names": names}


def _transcript(path, offs, dups, problems):
    """A session's lines in time order, each (time, line number, ref, record). A line that is not JSON, has no time or
    has a uuid of another shape is a problem, and a line whose uuid came before is noted in `dups` as the ref it
    repeats."""
    lines, seen = [], {}
    with open(path, "rb") as f:
        pos = 0
        for n, raw in enumerate(f, 1):
            offs.append(pos)
            pos += len(raw)
            ref = f"{path}#L{n}"
            try:
                r = json.loads(raw)
            except ValueError:
                r = None
            if not isinstance(r, dict):
                if raw.strip():
                    _problem(problems, ref, "not a JSON object")
                continue
            u = r.get("uuid")
            if u is not None and not isinstance(u, str):
                _problem(problems, ref, "a uuid that is not a string")
                continue
            if u and u in seen:
                dups[ref] = seen[u]
                continue
            t = _epoch(r.get("timestamp"))
            if t is None:
                _problem(problems, ref, "no timestamp the reader can read")
                continue
            if u:
                seen[u] = ref
            lines.append((t, n, ref, r))
    return sorted(lines, key=lambda x: (x[0], x[1]))


def _session_lines(sid, lines, problems):
    """A session's messages, each {ref, s, at, kind, words, text}, and its calls, each {ref, s, at, id, tool, inp} with
    {res, end, block, tur} once its result came. A user's text is a prompt; the last thing the agent said, when no
    call follows it, is its result. A line whose blocks are of another shape, or a tool result for no call before it,
    is a problem."""
    msgs, calls, pending = [], [], {}
    for t, _n, ref, r in lines:
        user = (r.get("type") or _msg_of(r).get("role")) == "user"
        blocks = _blocks(r)
        if any(not isinstance(b.get(k), (str, type(None))) for b in blocks for k in ("id", "tool_use_id")):
            _problem(problems, ref, "a content block whose id is not a string")
            continue
        for b in blocks:
            kind = b.get("type")
            if kind == "text" and str(b.get("text") or "").strip():
                msgs.append({"ref": ref, "s": sid, "at": t, "kind": "prompt" if user else "text", "text": str(b["text"])})
            elif kind == "tool_use" and b.get("id"):
                name = str(b.get("name") or "")
                pending[b["id"]] = {"ref": ref, "s": sid, "at": t, "id": b["id"], "tool": TOOL_NAMES.get(name, name),
                                    "inp": b.get("input") if isinstance(b.get("input"), dict) else {}}
                calls.append(pending[b["id"]])
            elif kind == "tool_result" and b.get("tool_use_id") in pending:
                pending.pop(b["tool_use_id"]).update(res=ref, end=t, block=b, tur=r.get("toolUseResult"))
            elif kind == "tool_result":
                _problem(problems, ref, "a tool result for no call before it in the session")
    said = [m for m in msgs if m["kind"] == "text"]
    if said and not any(c["at"] > said[-1]["at"] for c in calls):
        said[-1]["kind"] = "result"
    return msgs, calls


def build_index(paths):
    """{"offsets": {path: [byte offset of line n at n-1]}, "runs": {run: facts}, "sessions": {id: facts}, "calls": [facts],
    "messages": [facts], "lines": {ref: (what it holds, its key)}, "values": {field: [values in their order]},
    "problems": [{ref, why}] of the lines that do not parse}. Times
    are seconds on the run's clock. A run's `sessions` are in tree order, each after the session that spawned it; a
    call's `words` is the lowercased text a search looks in."""
    offsets, dups, indexes, sessions, raw_calls, raw_msgs = {}, {}, {}, {}, [], []
    problems = []
    for path in sorted(paths):
        offs = offsets.setdefault(path, [])
        if not path.endswith(".jsonl"):
            parts = path.replace(os.sep, "/").split("/")
            indexes[parts[-2] if len(parts) > 1 else "."] = dict(_run_index(path, offs, problems), path=path)
            continue
        run, sid, lead = _where(path)
        lines = _transcript(path, offs, dups, problems)
        if not lines:
            continue
        msgs, calls = _session_lines(sid, lines, problems)
        prompt = next((m for m in msgs if m["kind"] == "prompt"), None)
        sessions[sid] = {"id": sid, "ref": lines[0][2], "run": run, "lead": lead, "t0": lines[0][0], "t1": lines[-1][0], "agent": None,
                         "parent": None, "prompt": prompt["ref"] if prompt else None, "asked": prompt["text"] if prompt else ""}
        raw_msgs += msgs
        raw_calls += calls

    # each subagent under the session whose Task call spawned it
    for c in raw_calls:
        c.update(_facts(c["tool"], c["inp"], c.get("block"), c.get("tur")))
        c["child"] = None
        if c["tool"] != "Task" or "block" not in c:
            continue
        tur = c["tur"] if isinstance(c.get("tur"), dict) else {}
        said = AGENT_ID.search(_text(c["block"].get("content")))
        kid = str(tur.get("agentId") or (said[1] if said else ""))
        if kid not in sessions:
            prompt = str(c["inp"].get("prompt") or "")
            kid = next((x["id"] for x in sessions.values() if x["lead"] and x["parent"] is None and x["run"] == sessions[c["s"]]["run"]
                        and prompt and x["asked"] == prompt), None)
        if kid in sessions and kid != c["s"] and sessions[kid]["lead"] and sessions[kid]["parent"] is None:
            c["child"] = kid
            sessions[kid]["parent"] = c["s"]
            sessions[kid]["agent"] = c["inp"].get("subagent_type")
    for s in sessions.values():
        ix = indexes.get(s["run"]) or {}
        s["agent"] = str(s["agent"] or (ix.get("names") or {}).get(s["id"]) or (LEAD if s["lead"] is None else f"agent-{s['id']}"))
        s["team"] = ix.get("team") or ""
        if s["parent"] is None and s["lead"] in sessions:
            s["parent"] = s["lead"]
        del s["asked"]

    runs = {}
    for s in sessions.values():
        run = runs.setdefault(s["run"], {"id": s["run"], "team": s["team"], "start": s["t0"], "sessions": []})
        run["start"] = min(run["start"], s["t0"])
    for run in runs.values():
        ix = indexes.get(run["id"]) or {}
        run["team_ref"] = f"{ix['path']}#L{ix['team_line']}" if ix.get("team_line") else None
    for s in sessions.values():
        start = runs[s["run"]]["start"]
        s["start"], s["end"] = round(s["t0"] - start, 1), round(s["t1"] - start, 1)
        s["calls"], s["msgs"], s["tasks"] = [], [], []

    calls, held = [], {}
    for r in sorted(raw_calls, key=lambda x: x["at"]):
        s = sessions[r["s"]]
        d = max(0.0, r["end"] - r["at"]) if "end" in r else 0.0
        c = {"ref": r["ref"], "refs": [r["ref"]] + ([r["res"]] if r.get("res") else []), "id": r["id"], "i": len(calls), "s": s["id"],
             "t": round(r["at"] - runs[s["run"]]["start"], 1), "d": round(d, 2), "tool": r["tool"], "out": r["out"], "files": r["files"],
             "child": r["child"], "input": _input(r["tool"], r["inp"])[:160]}
        c["ftype"], c["dur"] = _ftype(c["files"]), _dur(d)
        c["words"] = " ".join(str(x or "") for x in (c["tool"], c["input"], r["text"], r["old"], r["new"])).lower() + " " + " ".join(
            c["files"] + r["matches"]).lower()
        calls.append(c)
        s["calls"].append(c["i"])
        for ref in c["refs"]:
            held[ref] = ("call", c["i"])
        if c["child"]:
            s["tasks"].append(c["i"])
            sessions[c["child"]]["spawn"] = c["i"]

    messages = []
    for r in sorted(raw_msgs, key=lambda x: x["at"]):
        s = sessions[r["s"]]
        held[r["ref"]] = ("message", len(messages))
        s["msgs"].append(len(messages))
        messages.append({"ref": r["ref"], "s": s["id"], "t": round(r["at"] - runs[s["run"]]["start"], 1), "kind": r["kind"],
                         "words": r["text"].lower()})
    for dup, first in dups.items():
        if first in held:
            held[dup] = held[first]
    for run, ix in indexes.items():
        if run in runs:
            for n in range(1, len(offsets[ix["path"]]) + 1):
                held[f"{ix['path']}#L{n}"] = ("run", run)

    for s in sessions.values():
        s["waits"] = _merge([(calls[i]["t"], calls[i]["t"] + calls[i]["d"]) for i in s["tasks"]])
        # a session's records: its prompt, then its calls' lines and its other messages in time order
        rest = sorted([(calls[i]["t"], r) for i in s["calls"] for r in calls[i]["refs"]] +
                      [(messages[i]["t"], messages[i]["ref"]) for i in s["msgs"] if messages[i]["kind"] != "prompt"])
        s["refs"] = [messages[i]["ref"] for i in s["msgs"] if messages[i]["kind"] == "prompt"] + [r for _, r in rest] or [s["ref"]]
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
    prompts = {_prompt_text(offsets, sessions[runs[k]["sessions"][0]]["prompt"]) for k in order}
    return {"offsets": offsets, "runs": runs, "order": order, "task": prompts.pop() if len(prompts) == 1 else None, "sessions": sessions,
            "calls": calls, "messages": messages, "lines": held, "values": values, "problems": problems}


def _record(offsets, ref):
    """The record a ref names, read from its byte offset."""
    path, _, line = ref.rpartition("#L")
    with open(path, "rb") as f:
        f.seek(offsets[path][int(line) - 1])
        return json.loads(f.readline())


def _prompt_text(offsets, ref):
    return _message_text(_record(offsets, ref)) if ref else ""


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
    text holds), `range` [from, to], the seconds a call took, `files`, words a path the call touched holds, `hide`, the
    label values whose calls are hidden (`label\\nvalue`, or "none" for the calls no label that is on marks), and
    `win`, the time window the counts keep to. Each call's marks and the label filter's verdict on it are looked up
    once."""

    def __init__(self, index, query):
        q = query or {}
        self.index = index
        self.hidden = {f: set(v or []) for f, v in (q.get("filters") or {}).items() if f in FIELDS and v}
        self.search = str(q.get("search") or "").strip().lower()
        rng = q.get("range")
        self.range = (float(rng[0]), float(rng[1])) if isinstance(rng, list) and len(rng) == 2 else None
        self.files = str(q.get("files") or "").strip().lower()
        self.hide = set(q.get("hide") or [])
        win = q.get("win")
        self.win = (float(win[0]), float(win[1])) if isinstance(win, list) and len(win) == 2 else None
        self.classes = _classes()
        keys = {_key(c["label"], c["value"]): i for i, c in enumerate(self.classes)}
        self.marks, self.kept = {}, {}
        for c in index["calls"]:
            if self.classes:
                self.marks[c["i"]] = sorted({keys[k] for r in c["refs"] for m in thimble.marked(r) if (k := _key(m["label"], m["value"])) in keys})
            self.kept[c["i"]] = thimble.kept_unit(c["refs"])

    def fields(self, c, but=None):
        """Whether a call passes the field filters, all or all but the field `but`, the search, the range of seconds and
        the paths."""
        for f, hid in self.hidden.items():
            if f != but and _value(self.index, c, f) in hid:
                return False
        if self.range and not self.range[0] <= c["d"] <= self.range[1]:
            return False
        if self.files and not any(self.files in p.lower() for p in c["files"]):
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
    return _record(index["offsets"], ref)


def _call(index, c):
    """A call as its two lines hold it: its input as a line and as the record holds it word for word (`literal`), and
    its facts (_facts)."""
    use = _block(_read(index, c["refs"][0]), "tool_use", "id", c["id"]) or {}
    inp = use.get("input") if isinstance(use.get("input"), dict) else {}
    block, tur = None, None
    if len(c["refs"]) > 1:
        r = _read(index, c["refs"][1])
        block, tur = _block(r, "tool_result", "tool_use_id", c["id"]), r.get("toolUseResult")
    return {"input": _input(c["tool"], inp), "literal": _input(c["tool"], inp, literal=True), **_facts(c["tool"], inp, block, tur)}


def _message(index, m):
    return _message_text(_read(index, m["ref"]))


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
        items.append({"kind": m["kind"], "ref": m["ref"], "t": m["t"], "text": _message(ix, m)})
    for k, i in enumerate(s["calls"]):
        c = ix["calls"][i]
        if not sel.passes(c):
            continue
        r = _call(ix, c)
        again = next((ix["calls"][j] for j in s["calls"][k + 1:] if ix["calls"][j]["tool"] == c["tool"] == "Bash" and ix["calls"][j]["input"] == c["input"]), None)
        items.append({"kind": "call", "ref": c["ref"], "refs": c["refs"], "t": c["t"], "d": c["d"], "tool": c["tool"], "out": c["out"], "k": k + 1,
                      "input": r["input"], "result": r["result"], "exit": r["exit"],
                      "files": c["files"], "matches": r["matches"], "old": r["old"], "new": r["new"],
                      "output": r["output"], "child": c["child"], "m": sel.marks.get(c["i"], []),
                      "again": {"t": again["t"], "out": again["out"]} if again else None})
    for i in s["tasks"]:
        c = ix["calls"][i]
        kid = ix["sessions"][c["child"]]
        result = next((ix["messages"][j] for j in kid["msgs"] if ix["messages"][j]["kind"] == "result"), None)
        # a subagent without a last message of its own still returned what its Task call's result holds
        if result:
            text, ref = _message(ix, result), result["ref"]
        else:
            text, ref = _call(ix, c)["text"], c["refs"][-1] if len(c["refs"]) > 1 else None
        items.append({"kind": "return", "t": kid["end"], "child": kid["id"], "ran": round(kid["end"] - kid["start"], 1), "ref": ref, "text": text})
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
                   "tool": c["tool"], "input": c["input"], "result": _call(ix, c)["result"] or c["out"]}
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


RAW_LINES, RAW_CHARS = 4, 6000


def _raw(index, query):
    """The lines a call or a message stands for, as the transcript holds them: [{ref, text}] for the refs asked."""
    out = []
    for ref in [r for r in query.get("refs") or [] if isinstance(r, str)][:RAW_LINES]:
        path, _, frag = ref.partition("#L")
        offs = index["offsets"].get(path)
        if not offs or not frag.isdigit() or not 0 < int(frag) <= len(offs):
            continue
        with open(path, "rb") as fh:
            fh.seek(offs[int(frag) - 1])
            text = fh.readline().decode("utf-8", "replace").rstrip("\r\n")
        out.append({"ref": ref, "text": text if len(text) <= RAW_CHARS else text[:RAW_CHARS] + "…"})
    return out


def records(index, query):
    q = query or {}
    op = q.get("op", "overview")
    if op == "raw":
        return _raw(index, q)
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
            # the team is cited from the run's index, the task from the lead's prompt
            refs = ([run["team_ref"]] if run["team_ref"] else []) + [r for i in run["sessions"] for r in ix["sessions"][i]["refs"]]
            text = "\n".join(x for x in (run["team"] if run["team_ref"] else "", _prompt_text(ix["offsets"], lead["prompt"])) if x)
            return {"excerpt": text or lead["agent"], "label": f"{key} · {run['team']}".strip(" ·"), "refs": refs, "key": key, "target": {"run": key}}
        s = ix["sessions"].get(key)
        if s is None:
            return None
        return {"excerpt": _prompt_text(ix["offsets"], s["prompt"]) or s["agent"], "label": f"{s['agent']} · {s['run']}", "refs": s["refs"],
                "key": key, "target": {"session": key}}
    path, frag = str(locator.get("path") or ""), str(locator.get("fragment") or "")
    m = re.fullmatch(r"L(\d+)", frag)
    if not m or path not in ix["offsets"]:
        return None
    ref = f"{path}#L{m[1]}"
    kind, i = ix["lines"].get(ref, (None, None))
    if kind == "run":
        run = ix["runs"][i]
        return {"excerpt": run["team"] or i, "label": f"{i} · {run['team']}".strip(" ·"), "refs": [ref], "key": i, "target": {"run": i}}
    if kind == "call":
        c = ix["calls"][i]
        r, s = _call(ix, c), ix["sessions"][c["s"]]
        return {"excerpt": "\n".join(x for x in (r["literal"], r["result"]) if x) or c["tool"], "label": f"{s['agent']} · {c['tool']} {_clock(c['t'])}",
                "refs": list(dict.fromkeys(c["refs"] + [ref])), "key": s["id"], "target": {"session": s["id"], "call": c["ref"]}}
    if kind == "message":
        mm = ix["messages"][i]
        s = ix["sessions"][mm["s"]]
        return {"excerpt": _message(ix, mm), "label": f"{s['agent']} · {mm['kind']} {_clock(mm['t'])}", "refs": list(dict.fromkeys([mm["ref"], ref])),
                "key": s["id"], "target": {"session": s["id"], "message": mm["ref"]}}
    return None


def problems(index):
    """The lines that do not parse, each {ref, why}, which thimble shows beside the page."""
    return index["problems"]
