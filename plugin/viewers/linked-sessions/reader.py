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
# The method: the index keeps each session's place in its run's tree, the facts of each call and message (its session,
# its time in UTC, its tool, outcome and files, a message's first line, and the words a search looks in) and every
# line's byte offset. A call is its tool_use line and its tool_result line; its whole input and output, and a message's
# whole text, are read back from those offsets when the page opens its row.
#
# What the page asks (records(index, query)):
#   {"op": "overview", "colour": <the page's colour.query()>, "scope": "" | "r:<run>" | "s:<session>", "search": <words>}
#       every run and session the label filter keeps, for the page's menu; the sessions in scope, every one, a run's or
#       a session with the subagents under it; and their calls and messages that hold the words, each with its speaker,
#       those of a value turned off under the Color by choice left out, with the counts of every value for the chips.
#   {"op": "record", "ref": <a call's or a message's ref>}
#       the call's whole input, what came back and the session it spawned, or the message's whole text.
#
# Labels: they apply when records are served, never in the index. A call passes when thimble.kept_unit holds for its
# two lines, a message when thimble.kept holds for its line, and a session stays when it holds for its records or one of
# its subagents stays, so the tree keeps its shape. A label colors a call by its value on the call's tool_use line, the
# line its row in the page is anchored by.
import json
import os
import re
from collections import Counter
from datetime import datetime, timezone

import thimble

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
    """A call's file type, from its first file: the extension, marked test for a file under tests/ or named test_*;
    None for a call with no file, which Color by counts with the records that have no value."""
    if not files:
        return None
    f = str(files[0])
    name = f.rsplit("/", 1)[-1]
    ext = "." + name.rsplit(".", 1)[1] if "." in name else name
    return f"test {ext}" if TEST_PATH.search(f) else ext


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
    return {"outcome": "denied" if denied else "error" if flagged else "ok", "result": first, "exit": int(code[1]) if code else None,
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
                msgs.append({"ref": ref, "session": sid, "at": t, "kind": "prompt" if user else "text", "text": str(b["text"])})
            elif kind == "tool_use" and b.get("id"):
                name = str(b.get("name") or "")
                pending[b["id"]] = {"ref": ref, "session": sid, "at": t, "id": b["id"], "tool": TOOL_NAMES.get(name, name),
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
    """{"offsets": {path: [byte offset of line n at n-1]}, "runs": {run: facts}, "order": [run ids by start], "sessions":
    {id: facts}, "calls": [facts], "messages": [facts], "lines": {ref: (what it holds, its key)}, "problems": [{ref, why}]
    of the lines that do not parse}. Times are seconds since 1970 in UTC. A run's `sessions` are in tree order, each after
    the session that spawned it; a call's or a message's `words` is the lowercased text a search looks in."""
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
                         "parent": None, "prompt": prompt["ref"] if prompt else None, "asked": prompt["text"] if prompt else "",
                         "calls": [], "msgs": []}
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
            kid = next((x["id"] for x in sessions.values() if x["lead"] and x["parent"] is None and x["run"] == sessions[c["session"]]["run"]
                        and prompt and x["asked"] == prompt), None)
        if kid in sessions and kid != c["session"] and sessions[kid]["lead"] and sessions[kid]["parent"] is None:
            c["child"] = kid
            sessions[kid]["parent"] = c["session"]
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

    calls, held = [], {}
    for r in sorted(raw_calls, key=lambda x: x["at"]):
        s = sessions[r["session"]]
        c = {"ref": r["ref"], "refs": [r["ref"]] + ([r["res"]] if r.get("res") else []), "id": r["id"], "i": len(calls), "session": s["id"],
             "time": round(r["at"], 1), "duration": round(max(0.0, r["end"] - r["at"]) if "end" in r else 0.0, 2), "tool": r["tool"],
             "outcome": r["outcome"], "files": r["files"], "child": r["child"], "input": _input(r["tool"], r["inp"])[:160]}
        c["file type"] = _ftype(c["files"])
        c["words"] = " ".join(str(x or "") for x in (c["tool"], c["input"], r["text"], r["old"], r["new"])).lower() + " " + " ".join(
            c["files"] + r["matches"]).lower()
        calls.append(c)
        s["calls"].append(c["i"])
        for ref in c["refs"]:
            held[ref] = ("call", c["i"])

    messages = []
    for r in sorted(raw_msgs, key=lambda x: x["at"]):
        s = sessions[r["session"]]
        held[r["ref"]] = ("message", len(messages))
        s["msgs"].append(len(messages))
        first = next((ln.strip() for ln in r["text"].splitlines() if ln.strip()), "")
        messages.append({"ref": r["ref"], "session": s["id"], "time": round(r["at"], 1), "kind": r["kind"], "text": first[:200],
                         "words": r["text"].lower()})
    for dup, first in dups.items():
        if first in held:
            held[dup] = held[first]
    for run, ix in indexes.items():
        if run in runs:
            for n in range(1, len(offsets[ix["path"]]) + 1):
                held[f"{ix['path']}#L{n}"] = ("run", run)

    for s in sessions.values():
        # a session's records: its prompt, then its calls' lines and its other messages in time order
        rest = sorted([(calls[i]["time"], r) for i in s["calls"] for r in calls[i]["refs"]] +
                      [(messages[i]["time"], messages[i]["ref"]) for i in s["msgs"] if messages[i]["kind"] != "prompt"])
        s["refs"] = [messages[i]["ref"] for i in s["msgs"] if messages[i]["kind"] == "prompt"] + [r for _, r in rest] or [s["ref"]]
    for run in runs.values():
        def walk(parent, depth):
            kids = sorted((x for x in sessions.values() if x["run"] == run["id"] and x["parent"] == parent), key=lambda x: x["t0"])
            for x in kids:
                x["depth"] = depth
                run["sessions"].append(x["id"])
                walk(x["id"], depth + 1)
        walk(None, 0)
    order = sorted(runs, key=lambda k: runs[k]["start"])
    return {"offsets": offsets, "runs": runs, "order": order, "sessions": sessions, "calls": calls, "messages": messages,
            "lines": held, "problems": problems}


def _record(offsets, ref):
    """The record a ref names, read from its byte offset."""
    path, _, line = ref.rpartition("#L")
    with open(path, "rb") as f:
        f.seek(offsets[path][int(line) - 1])
        return json.loads(f.readline())


def _prompt_text(offsets, ref):
    return _message_text(_record(offsets, ref)) if ref else ""


def _call(index, c):
    """A call as its two lines hold it: its input as a line and as the record holds it word for word (`literal`), and
    its facts (_facts)."""
    use = _block(_record(index["offsets"], c["refs"][0]), "tool_use", "id", c["id"]) or {}
    inp = use.get("input") if isinstance(use.get("input"), dict) else {}
    block, tur = None, None
    if len(c["refs"]) > 1:
        r = _record(index["offsets"], c["refs"][1])
        block, tur = _block(r, "tool_result", "tool_use_id", c["id"]), r.get("toolUseResult")
    return {"input": _input(c["tool"], inp), "literal": _input(c["tool"], inp, literal=True), **_facts(c["tool"], inp, block, tur)}


def _message(index, m):
    return _message_text(_record(index["offsets"], m["ref"]))


# ------------------------------------------------------------------------------------------------------- the answers


def _kept(index):
    """The sessions the label filter keeps, in tree order: those it keeps a record of, and every session above one."""
    ss, keep = index["sessions"], set()
    for sid, s in ss.items():
        if thimble.kept_unit(s["refs"]):
            while sid and sid not in keep:
                keep.add(sid)
                sid = ss[sid]["parent"]
    return [i for k in index["order"] for i in index["runs"][k]["sessions"] if i in keep]


def _in_scope(index, ids, scope):
    """Of the sessions `ids`, in tree order, those the page's menu picks: every one, a run's ("r:<run>"), or a session
    with the subagents under it ("s:<session>")."""
    kind, _, key = str(scope or "").partition(":")
    if kind == "r":
        return [i for i in ids if index["sessions"][i]["run"] == key]
    if kind == "s":
        under = {key}
        for i in ids:
            if index["sessions"][i]["parent"] in under:
                under.add(i)
        return [i for i in ids if i in under]
    return ids


def _speaker(index, s, kind):
    """Who wrote a line of the session `s`: its prompt the session that spawned it, or the user for a lead; the rest its
    agent."""
    if kind != "prompt":
        return s["agent"]
    parent = index["sessions"].get(s["parent"])
    return parent["agent"] if parent else "user"


def _overview(index, query):
    ix, choice = index, query.get("colour")
    words = str(query.get("search") or "").strip().lower()
    keep = _kept(ix)
    scope = _in_scope(ix, keep, query.get("scope"))
    calls, messages, counts = [], [], Counter()

    def add(out, item):
        value = thimble.colour_value(choice, item["ref"], item)
        counts["" if value is None else value] += 1
        # a value whose chip the analyst turned off leaves the list, the lanes and the overview, and stays in the counts
        if thimble.colour_on(choice, value):
            out.append(item)

    for sid in scope:
        s = ix["sessions"][sid]
        for c in (ix["calls"][i] for i in s["calls"]):
            if words in c["words"] and thimble.kept_unit(c["refs"]):
                add(calls, {"ref": c["ref"], "session": sid, "time": c["time"], "duration": c["duration"], "tool": c["tool"],
                            "file type": c["file type"], "outcome": c["outcome"], "speaker": s["agent"], "input": c["input"]})
        for m in (ix["messages"][i] for i in s["msgs"]):
            if words in m["words"] and thimble.kept(m["ref"]):
                add(messages, {"ref": m["ref"], "session": sid, "time": m["time"], "kind": m["kind"],
                               "speaker": _speaker(ix, s, m["kind"]), "text": m["text"]})
    ss = ix["sessions"]
    return {"runs": [{"id": k, "team": ix["runs"][k]["team"]} for k in ix["order"] if any(ss[i]["run"] == k for i in keep)],
            "sessions": [{"id": i, "path": ss[i]["ref"].rpartition("#")[0], "run": ss[i]["run"], "agent": ss[i]["agent"],
                          "parent": ss[i]["parent"], "depth": ss[i]["depth"], "start": ss[i]["t0"], "end": ss[i]["t1"]} for i in keep],
            "scope": scope, "calls": calls, "messages": messages, "counts": dict(counts)}


def _one(index, query):
    """A call or a message in full, for its row's details: the call's whole input, what came back and the session it
    spawned, or the message's whole text."""
    kind, i = index["lines"].get(str(query.get("ref")), (None, None))
    if kind == "call":
        c = index["calls"][i]
        r = _call(index, c)
        return {"ref": c["ref"], "input": r["input"], "result": r["result"], "exit": r["exit"], "output": r["output"],
                "old": r["old"], "new": r["new"], "child": c["child"]}
    if kind == "message":
        m = index["messages"][i]
        return {"ref": m["ref"], "text": _message(index, m)}
    return None


def records(index, query):
    q = query or {}
    return _one(index, q) if q.get("op") == "record" else _overview(index, q)


# ---------------------------------------------------------------------------------------------------------- places


def _clock(t):
    return datetime.fromtimestamp(t, timezone.utc).strftime("%H:%M:%S")


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
        r, s = _call(ix, c), ix["sessions"][c["session"]]
        return {"excerpt": "\n".join(x for x in (r["literal"], r["result"]) if x) or c["tool"], "label": f"{s['agent']} · {c['tool']} {_clock(c['time'])}",
                "refs": list(dict.fromkeys(c["refs"] + [ref])), "key": s["id"], "target": {"session": s["id"], "call": c["ref"]}}
    if kind == "message":
        mm = ix["messages"][i]
        s = ix["sessions"][mm["session"]]
        return {"excerpt": _message(ix, mm), "label": f"{s['agent']} · {mm['kind']} {_clock(mm['time'])}", "refs": list(dict.fromkeys([mm["ref"], ref])),
                "key": s["id"], "target": {"session": s["id"], "message": mm["ref"]}}
    return None


def problems(index):
    """The lines that do not parse, each {ref, why}, which thimble shows beside the page."""
    return index["problems"]
