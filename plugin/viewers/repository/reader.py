# Repository: a code forge's log of several agent runs on one library, read the way its GitHub pages read.
#
# The data: one folder per run, runs/<run>/, which the scope runs/*.json, runs/*.jsonl and runs/*.csv matches. Each run
# is a team of agents working the same backlog of one library, so issue #3 of one run is issue #3 of another, and runs
# compare issue by issue. The files and their fields:
#   manifest.json        the run's setup, whose keys changed between runs: its id (`run` or `id`), its start (`started`
#                        or `started_at`), its agents (`agents` or `team`, as names or as objects with a `name` and a
#                        `session`), the approvals a merge needs (`approvals`, `required_approvals`, or the `approvals`
#                        of `policy`), its brief (`brief` or `prompt`), and `timezone`, the zone of the run's times
#                        written without an offset; `schema` and `forge` name the layout of its forge data
#   events.jsonl         the forge's events, one per line: `id`; `type`, one of issue.opened, pr.opened, push, review,
#                        comment, pr.merged, pr.closed and pr.reopened; `ts` (when); `actor` (who); `number` (the issue
#                        or pull request; they share one numbering in a run); `title`; `labels` (the first is the part
#                        of the library it is about); `fixes` (the issue a pull request fixes); `sha`, `message` and
#                        `diff` (a push's; the diff is unified, over the files it changed); `forced` and `before` (a
#                        force-push, and the head it replaced); `state` (a review's verdict: approved,
#                        changes_requested or commented); `reason` (why a close ended it without a merge); and `body`.
#                        r4's forge wrote schema 2, which renamed fields: `v` is 2, and `event`, `time` (epoch
#                        milliseconds), `user`, `area`, `closes`, `text` and `patch` stand for type, ts, actor, labels,
#                        fixes, body or message, and diff; its verdicts are in capitals
#   board.jsonl          the discussion: `id`, `thread_id`, `thread_title` (on a thread's first post), `author`,
#                        `created_at` and `body`
#   agents/<name>.jsonl  one agent's transcript: `type` (user or assistant), `session_id`, `timestamp` and `message`,
#                        whose content is text or blocks; its last assistant text is the note the agent signed off with
#   export/              r3's forge data, exported as tables in place of events.jsonl, with local times in the
#                        manifest's timezone: issues.csv (`number`, `title`, `author`, `created_at`, `state`, `labels`,
#                        `body`); pulls.csv (the same, with `merged_at`, `merged_by`, `closed_at`, `closed_by`,
#                        `state_reason` and `linked_issue`); commits.csv (`pull`, `sha`, `author`, `committed_at`,
#                        `message`, and `patch`, the diff, in a cell over several lines); comments.csv (`number`,
#                        `author`, `created_at`, `body`); and reviews.json, a JSON array with one review per line
#                        (`id`, `pull`, `user` with its login, `state`, `submitted_at`, `body`)
#
# What the reader cleans:
#   - Times are ISO 8601 with or without an offset, epoch milliseconds, or local time. A time without an offset is in
#     the run's `timezone`, else UTC, and every time is read onto one clock.
#   - The forge redelivered some events: a line whose `id` came earlier in its file repeats that event and is left out.
#   - Some events were logged late, and the export lists reviews by pull request, so records are put in time order.
#   - r4's events.jsonl ends in a line cut off when the run stopped. A line or row that does not parse, a manifest that
#     does not parse, and a timezone the machine does not know (the run's times are then read as UTC) are left out,
#     and problems() lists them for thimble to show. So does it list an event of a type it does not know, a record
#     about a number no pull request or issue of the run opens, a record with no time when no line before it has one,
#     and a time it cannot read, whose record takes the time of the line before it.
#   - A file in scope whose place in a run's folder is none of the above is left out, and hidden() says why.
#   - A cell of an export table may run over several lines inside its quotes; its row cites its first line.
#   - r4's manifest lists an agent that left no transcript: a run's agents are the manifest's and the transcripts', and
#     one without a transcript has no note.
#   - A linked issue or a number of approvals written as free text ("#14", "18 (regression from #15)") is its first
#     number.
#   - A pull request opened without an area label takes the area of the issue it fixes.
#   - A review from an account that no longer exists names no reviewer, and counts as the reviewer `unknown`.
#   - A post saved without a time takes the time of the line before it in its file.
#   - A row of pulls.csv holds a pull request's opening and its merge or close, so all of them cite that row. The row's
#     close has no words; the closer's comment of the same minute says why.
#   - A force-push is a push that says so, and a reopened pull request is open again.
#
# The method: the reader gathers each run's records into the units a forge shows, keyed as its URLs are: pull requests
# (<run>/pull/<n>), issues (<run>/issues/<n>), discussions (<run>/discussions/<n>) and agents (<run>/agents/<name>),
# and a run itself (<run>). The index keeps each unit's facts (state, who merged it, each reviewer's verdicts, flags)
# and its records' lines and times; a record's text is read back from its byte offset when a page shows it. One fetch
# answers a whole tab under the page's selection: the tab counts, one row of measures per run, the activity per time
# bin, the values of every filter with their counts, and a page of units. A filter takes one value or several, and a
# unit meets it when it has any of them. Most filters pick units by their facts; the time range, `actor` (who wrote a
# record) and `action` (what it did) pick records, and a unit stays when one of its records meets all three. Each
# filter's counts hold every other filter, and the runs' rows hold every filter but the run, so a run that is not chosen
# still shows what choosing it would give. The activity and the strips key each record by the colour field the page
# chose (its action, who wrote it, its run, its unit's author, state, area, close reason, origin or first flag, or for a
# review its reviewer and verdict), and the colour field's own counts hold every filter but its own, as a legend's do.
#
# Labels: they apply when records are served, never in the index. A unit stays when thimble.kept_unit holds for its
# records, and a record counts in the activity and on a unit's strip when thimble.kept holds for it. While a label is
# on, unless the page asks for the colour field (`labels`: false), the values of the labels that are on key the records
# in place of the colour field: each record by the first of
# them that marks it (thimble.marked), since thimble cannot see inside a chart, and the page draws them in the labels'
# colours. The page may hide the records of some of those values, or the records none marks.
import csv
import io
import json
import re
import statistics
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

import thimble

TABS = ("pulls", "issues", "discussions", "agents")
PAGE = 100  # units one fetch returns; the page asks for the next ones
BINS = [5, 10, 15, 20, 30, 60, 120, 240, 480, 1440]  # minutes; the activity's bin is the first giving at most MAX_BARS
MAX_BARS = 40
# what each kind of record did, as the activity and the strips name it; a review is named by its verdict
ACTION = {"pr": "opened", "issue": "opened", "commit": "pushed", "comment": "commented", "merge": "merged",
          "close": "closed", "reopen": "reopened", "post": "posted", "agent": "signed off"}
MENTION = re.compile(r"#(\d+)\b")
# the fields that can colour the records on each tab: a record's action or who wrote it, a review's reviewer and
# verdict, or its unit's run, author, state, area, close reason, origin or first flag
COLOURS = {"pulls": ("action", "actor", "author", "reviewer", "verdict", "run", "state", "area", "reason", "flag"),
           "issues": ("action", "actor", "author", "run", "state", "area", "origin", "reason"),
           "discussions": ("action", "actor", "run"), "agents": ("action", "actor", "run")}
UNIT_COLOURS = ("author", "state", "area", "reason", "origin")  # the colour fields a unit's fact gives
NO_NAME = "unknown"  # the reviewer of a review whose account is gone
# a record's kind by an event's `type` (schema 2: `event`), and a review's verdict by its `state`, in any case
KINDS = {"issue.opened": "issue", "pr.opened": "pr", "push": "commit", "review": "review", "comment": "comment",
         "pr.merged": "merge", "pr.closed": "close", "issue.closed": "close", "pr.reopened": "reopen"}
VERDICTS = {"approved": "approved", "changes_requested": "changes requested", "commented": "commented"}
# a run's files by their path in its folder; agents/<name>.jsonl are transcripts
SHAPES = {"manifest.json": "manifest", "events.jsonl": "events", "board.jsonl": "board", "export/issues.csv": "issues",
          "export/pulls.csv": "pulls", "export/commits.csv": "commits", "export/comments.csv": "comments",
          "export/reviews.json": "reviews"}
TABLES = ("issues", "pulls", "commits", "comments")


# ------------------------------------------------------------------------------------------------ reading the files


def _time(v, tz=None, bad=None):
    """Epoch seconds of epoch milliseconds or ISO 8601; a time without an offset is in the zone `tz`, else UTC. A time
    given in another form is None, and noted in the list `bad` when one is passed."""
    if isinstance(v, bool) or v in (None, ""):
        return None
    if isinstance(v, (int, float)):
        return v / 1000
    try:
        dt = datetime.fromisoformat(str(v).strip().replace("Z", "+00:00"))
    except ValueError:
        if bad is not None:
            bad.append(v)
        return None
    return (dt if dt.tzinfo else dt.replace(tzinfo=ZoneInfo(tz) if tz else timezone.utc)).timestamp()


def _problem(problems, ref, why):
    """Note that the line `ref` holds no record because it does not parse."""
    problems.append({"ref": ref, "why": why})


def _number(v):
    """The first number in `v`: an int, "#14", or free text such as "18 (regression from #15)"; None for none."""
    if isinstance(v, int) and not isinstance(v, bool):
        return v
    m = re.search(r"\d+", str(v or ""))
    return int(m.group()) if m else None


def _first(r, *keys):
    """The value of the first of `keys` that the record gives, for a field whose name changed between versions."""
    return next((r[k] for k in keys if r.get(k) not in (None, "")), None)


def _rec(kind, t, **fields):
    """One of the reader's records: its kind, its time in epoch seconds, and the fields it has."""
    return {"kind": kind, "t": t, **{k: v for k, v in fields.items() if v is not None and v is not False and v != ""}}


def _verdict(state):
    return VERDICTS.get(str(state or "commented").lower(), "commented")


def _event(r, tz, bad=None):
    """An events.jsonl line, in either schema, as records; ValueError for a type the reader does not know."""
    kind = KINDS.get(_first(r, "type", "event"))
    if kind is None:
        raise ValueError(f"an event of a type the reader does not know ({_first(r, 'type', 'event')!r})")
    labels = r.get("labels")
    return [_rec(kind, _time(_first(r, "ts", "time"), tz, bad), id=r.get("id"), author=_first(r, "actor", "user"),
                 number=_number(r.get("number")), title=r.get("title"),
                 area=labels[0] if isinstance(labels, list) and labels else r.get("area"),
                 closes=_number(_first(r, "fixes", "closes")), sha=r.get("sha"), diff=_first(r, "diff", "patch"),
                 verdict=_verdict(r.get("state")) if kind == "review" else None, reason=r.get("reason"),
                 text=_first(r, "body", "text", "message"), forced=bool(r.get("forced")), before=r.get("before"))]


def _row(shape, c, tz, bad=None):
    """A row of an export table, {column: cell}, as records: a pull request's row holds its opening and its merge or
    close."""
    def t(col):
        return _time(c.get(col), tz, bad)

    n = _number(c.get("number"))
    if shape == "issues":
        return [_rec("issue", t("created_at"), author=c.get("author"), number=n, title=c.get("title"),
                     area=c.get("labels"), text=c.get("body"))]
    if shape == "pulls":
        out = [_rec("pr", t("created_at"), author=c.get("author"), number=n, title=c.get("title"), area=c.get("labels"),
                    closes=_number(c.get("linked_issue")), text=c.get("body"))]
        if c.get("merged_at"):
            out.append(_rec("merge", t("merged_at"), author=c.get("merged_by"), number=n))
        elif c.get("closed_at"):
            out.append(_rec("close", t("closed_at"), author=c.get("closed_by"), number=n,
                            reason=c.get("state_reason") or "closed"))
        return out
    if shape == "commits":
        return [_rec("commit", t("committed_at"), author=c.get("author"), number=_number(c.get("pull")),
                     sha=c.get("sha"), text=c.get("message"), diff=c.get("patch"))]
    return [_rec("comment", t("created_at"), author=c.get("author"), number=n, text=c.get("body"))]


def _content(r):
    """A transcript line's message content; None when its message is not an object."""
    msg = r.get("message")
    return msg.get("content") if isinstance(msg, dict) else None


def _turn(r, name, note, bad=None):
    """A transcript line as a record: the agent's sign-off when it is its last words (`note`), else a turn, which the
    agent's unit cites but the page does not show."""
    content = _content(r)
    blocks = [{"text": content}] if isinstance(content, str) else content if isinstance(content, list) else []
    words = [b.get("text") or b.get("content") or (b.get("input") or {}).get("command") for b in blocks
             if isinstance(b, dict)]
    return [_rec("agent" if note else "turn", _time(r.get("timestamp"), None, bad), author=name,
                 text="\n".join(w for w in words if isinstance(w, str) and w))]


def _parse(ctx, n, raw, bad=None):
    """The records on line `n` of a file whose context (build_index) is `ctx`, a table's row whole however many lines it
    takes; [] for a line that holds none, ValueError for one that does not parse. Times given in a form the reader does
    not read go in the list `bad`."""
    shape, tz = ctx["shape"], ctx.get("tz")
    text = raw.decode("utf-8", "replace").strip()
    if not text or shape == "manifest" or (shape == "reviews" and text in ("[", "]")):
        return []
    if shape in TABLES:
        try:
            return [] if n == 1 else _row(shape, dict(zip(ctx["header"], next(csv.reader(io.StringIO(text), strict=True)))), tz, bad)
        except csv.Error as e:
            raise ValueError(f"not a CSV row ({e})") from e
    try:
        r = json.loads(text.rstrip(","))  # reviews.json holds one object per line, each but the last with a comma
    except ValueError as e:
        raise ValueError("not a JSON object") from e
    if not isinstance(r, dict):
        raise ValueError("not a JSON object")
    if shape == "events":
        return _event(r, tz, bad)
    if shape == "board":
        return [_rec("post", _time(r.get("created_at"), tz, bad), author=r.get("author"), thread=_number(r.get("thread_id")),
                     title=r.get("thread_title"), text=r.get("body"))]
    if shape == "reviews":
        return [_rec("review", _time(r.get("submitted_at"), tz, bad), author=(r.get("user") or {}).get("login") or NO_NAME,
                     number=_number(r.get("pull")), verdict=_verdict(r.get("state")), text=r.get("body"))]
    return _turn(r, ctx["agent"], n == ctx["note"], bad)


def _manifest(path, problems):
    """A run's setup from its manifest, whichever keys it uses, with the line of its brief; a manifest that does not
    parse is a problem and gives no setup, a timezone the machine does not know is a problem and read as UTC, and a
    team or policy of another shape is a problem and left out."""
    with open(path, "rb") as f:
        text = f.read().decode("utf-8", "replace")
    line = lambda key: next((n for n, ln in enumerate(text.splitlines(), 1) if ln.strip().startswith(f'"{key}"')), None)  # noqa: E731
    try:
        m = json.loads(text)
    except ValueError:
        m = None
    if not isinstance(m, dict):
        _problem(problems, f"{path}#L1", "the manifest is not a JSON object")
        return {"agents": []}
    tz = m.get("timezone")
    try:
        ZoneInfo(tz) if tz else None
    except (ValueError, TypeError, KeyError):  # an unknown name raises ZoneInfoNotFoundError, a KeyError
        _problem(problems, f"{path}#L{line('timezone') or 1}", f"unknown timezone {tz!r}; the run's local times are read as UTC")
        tz = None
    team, policy = _first(m, "agents", "team") or [], m.get("policy") or {}
    if not isinstance(team, list) or not isinstance(policy, dict):
        _problem(problems, f"{path}#L1", "the manifest's team or policy is not of the shape the reader knows")
        team, policy = team if isinstance(team, list) else [], policy if isinstance(policy, dict) else {}
    brief = "brief" if "brief" in m else "prompt"
    bad = []
    start = _time(_first(m, "started", "started_at"), tz, bad)
    if bad:
        _problem(problems, f"{path}#L{line('started') or line('started_at') or 1}",
                 f"a start the reader cannot read ({bad[0]!r}); the run starts at its first record")
    return {"start": start, "tz": tz, "brief": m.get(brief), "line": line(brief),
            "agents": [str(a.get("name")) if isinstance(a, dict) else str(a) for a in team],
            "approvals": _number(_first(m, "approvals", "required_approvals") or policy.get("approvals"))}


def _shape(path):
    parts = path.split("/")
    if len(parts) < 3 or parts[0] != "runs":
        return None
    if len(parts) == 4 and parts[2] == "agents" and parts[3].endswith(".jsonl"):
        return "agent"
    return SHAPES.get("/".join(parts[2:]))


def _says(raw):
    """Whether a transcript line is the agent's own words: an assistant message with text."""
    try:
        r = json.loads(raw)
    except ValueError:
        return False
    if not isinstance(r, dict):
        return False
    content = _content(r)
    return r.get("type") == "assistant" and (isinstance(content, str) or isinstance(content, list) and any(
        isinstance(b, dict) and b.get("type") == "text" for b in content))


def _lines(path):
    """[(byte offset, raw line)] of a file."""
    out, pos = [], 0
    with open(path, "rb") as f:
        for raw in f:
            out.append((pos, raw))
            pos += len(raw)
    return out


def _table(path, lines, ctx, problems):
    """[(first line, raw row)] of an export table's rows after its header, a quoted cell that runs over several lines
    included: the header goes in ctx["header"], and each row of more than one line in ctx["rows"] as first: last. A row
    that does not parse is a problem."""
    rows = csv.reader((raw.decode("utf-8", "replace") for _, raw in lines), strict=True)
    ctx["header"], ctx["rows"], out, done = [], {}, [], 0
    while True:
        try:
            cells = next(rows)
        except StopIteration:
            return out
        except csv.Error as e:
            _problem(problems, f"{path}#L{done + 1}", f"not a CSV row ({e})")
        else:
            if done == 0:
                ctx["header"] = cells
            else:
                out.append((done + 1, b"".join(raw for _, raw in lines[done:rows.line_num])))
                if rows.line_num > done + 1:
                    ctx["rows"][done + 1] = rows.line_num
        done = rows.line_num


def build_index(paths):
    """{"files": {path: context}, "offsets": {path: [byte offset of line n at n-1]}, "runs": {run: setup}, "units":
    {key: unit}, "line": {ref: key of its unit}, "same": {ref of a redelivered event: ref of its first line},
    "problems": [{ref, why}] of the lines that do not parse}. A unit
    holds its tab, run, facts, `refs` (the lines it gathers) and `events` ([ref, hours since its run started, action,
    author, the record's place among its line's records, epoch seconds] in time order, its strip and its part of the
    activity). An agent's refs start with its note, then every record it wrote, and its transcript's other lines are
    its `more`; an issue's events include the merge that fixed it."""
    files, offsets, runs, recs, same, by_run = {}, {}, {}, [], {}, {}
    problems, unknown = [], []
    for path in sorted(paths):
        if shape := _shape(path):
            by_run.setdefault(path.split("/")[1], []).append((path, shape))
        else:
            unknown.append(path)
    for run, found in by_run.items():
        man = next((p for p, s in found if s == "manifest"), None)
        setup = _manifest(man, problems) if man else {"agents": []}
        runs[run] = {"start": setup.get("start"), "end": None, "approvals": setup.get("approvals"),
                     "ref": f"{man}#L{setup['line']}" if man and setup.get("line") else None,
                     "brief": setup.get("brief"), "agents": list(setup["agents"])}
        for path, shape in found:
            lines = _lines(path)
            offsets[path] = [pos for pos, _ in lines]
            ctx = files[path] = {"run": run, "shape": shape, "tz": setup.get("tz")}
            items = _table(path, lines, ctx, problems) if shape in TABLES else [(n, raw) for n, (_, raw) in enumerate(lines, 1)]
            if shape == "agent":
                ctx["agent"] = path.rsplit("/", 1)[1][:-len(".jsonl")]
                ctx["note"] = max((n for n, (_, raw) in enumerate(lines, 1) if _says(raw)), default=None)
                if ctx["agent"] not in runs[run]["agents"]:
                    runs[run]["agents"].append(ctx["agent"])
            seen, last = {}, None
            for n, raw in items:
                ref, bad = f"{path}#L{n}", []
                try:
                    found = _parse(ctx, n, raw, bad)
                except Exception as e:  # noqa: BLE001 — any line the reader cannot read is a problem, never the index's end
                    _problem(problems, ref, str(e) if isinstance(e, ValueError) else "a record of a shape the reader does not know")
                    continue
                said, told = f"a time the reader cannot read ({bad[0]!r})" if bad else "no time", False
                for i, r in enumerate(found):
                    if r.get("id") is not None:
                        if r["id"] in seen:
                            same[ref] = seen[r["id"]]
                            break
                        seen[r["id"]] = ref
                    if r["t"] is None and (bad or last is None) and not told:
                        _problem(problems, ref, f"{said}, and no line before it has one, so it is left out" if last is None
                                 else f"{said}; the record takes the time of the line before it")
                        told = True
                    last = r["t"] if r["t"] is not None else last
                    if last is not None:
                        recs.append((last, ref, i, run, r))
    recs.sort(key=lambda x: x[0])
    for run, info in runs.items():
        times = [x[0] for x in recs if x[3] == run]
        info["start"] = info["start"] if info["start"] is not None else min(times, default=0)
        info["end"] = max([info["start"], *times])
        info["team"] = len(info["agents"]) or None

    agents = {(run, a) for run, info in runs.items() for a in info["agents"]}
    numbered = {(run, r["number"]): f"{run}/{'pull' if r['kind'] == 'pr' else 'issues'}/{r['number']}"
                for _, _, _, run, r in recs if r["kind"] in ("pr", "issue") and r.get("number") is not None}
    units, more, line = {}, {}, {info["ref"]: run for run, info in runs.items() if info["ref"]}
    for t, ref, i, run, r in recs:
        kind, who = r["kind"], str(r.get("author") or "")
        h, act = round((t - runs[run]["start"]) / 3600, 3), _action(r)
        if kind in ("agent", "turn"):
            key = f"{run}/agents/{who}"
        elif kind == "post" and r.get("thread") is not None:
            key = f"{run}/discussions/{r['thread']}"
        elif (run, r.get("number")) in numbered:
            key = numbered[(run, r["number"])]
        else:
            _problem(problems, ref, "a post with no thread" if kind == "post" else
                     f"a {kind} with no pull request or issue number" if r.get("number") is None else
                     f"a {kind} about #{r['number']}, which no pull request or issue of the run opens")
            continue
        line[ref] = key
        if kind == "turn":
            more.setdefault(key, []).append(ref)
            continue
        u = units.get(key) or units.setdefault(key, _unit(key, run, r, h))
        _add(u, kind, r, who, h, act, [ref, i])
        if ref not in u["refs"]:
            u["refs"].insert(0, ref) if kind == "agent" else u["refs"].append(ref)
        event = [ref, h, act, who, i, t, kind]
        u["events"].append(event)
        u["words"].append(" ".join(str(r.get(f) or "") for f in ("title", "text", "reason", "sha")))
        if (run, who) in agents and kind != "agent":
            a = units.get(f"{run}/agents/{who}") or units.setdefault(f"{run}/agents/{who}",
                                                                     _unit(f"{run}/agents/{who}", run, r, h))
            if ref not in a["refs"]:
                a["refs"].append(ref)
            a["events"].append(event)

    for key, refs in more.items():
        units.setdefault(key, _unit(key, key.split("/")[0], {"author": key.rsplit("/", 1)[1]}, 0))["more"] = refs
    for u in units.values():
        numbers = [f"#{n}" for n in (u.get("number"), u.get("closes")) if n is not None and u["tab"] != "discussions"]
        u["search"] = " ".join([u.get("title") or "", u.get("author") or "", *numbers, *u.pop("words")]).lower()
        if u.get("state") == "closed" and u["why"] is None:
            u["why"] = next(([e[0], e[4]] for e in u["events"] if e[2] == "commented" and e[3] == u["closed_by"]
                             and abs(e[1] - u["ended"]) < 1 / 60), None)
        if u["tab"] == "pulls":
            _pull_facts(u, runs[u["run"]])
    for u in [u for u in units.values() if u["tab"] == "pulls" and u.get("closes") is not None]:
        issue = units.get(f"{u['run']}/issues/{u['closes']}")
        if issue is None:
            continue
        u["area"] = u["area"] or issue["area"]
        issue["prs"].append(u["number"])
        if u["state"] == "merged" and issue["state"] == "open":
            issue.update(state="fixed", fixed_by=u["number"], ended=u["ended"])
            merge = next(e for e in u["events"] if e[2] == "merged")
            issue["events"].append([merge[0], u["ended"], "fixed", merge[3], merge[4], merge[5], "merge"])
    _agent_facts(units)
    problems.sort(key=lambda p: (p["ref"].rpartition("#L")[0], int(p["ref"].rpartition("#L")[2] or 0)))
    return {"files": files, "offsets": offsets, "runs": runs, "units": units, "line": line, "same": same,
            "problems": problems, "unknown": unknown}


def _action(r):
    return (r.get("verdict") or "commented") if r["kind"] == "review" else ACTION.get(r["kind"], "other")


def _unit(key, run, r, h):
    """A new unit for the record `r`, the first of it, at `h` hours."""
    tab = {"pull": "pulls", "issues": "issues", "discussions": "discussions", "agents": "agents"}[key.split("/")[1]]
    u = {"key": key, "tab": tab, "run": run, "at": h, "author": str(r.get("author") or ""), "refs": [], "events": [],
         "words": []}
    if tab in ("pulls", "issues"):
        u.update(number=int(key.rsplit("/", 1)[1]), title="", area="", state="open", closed_by=None, reason=None,
                 ended=None, comments=0, why=None)
    if tab == "pulls":
        u.update(closes=None, merged_by=None, reviews=[], commits=[], plus=0, minus=0, paths=[])
    elif tab == "issues":
        u.update(origin="backlog", prs=[], fixed_by=None)
    elif tab == "discussions":
        u.update(number=int(key.rsplit("/", 1)[1]), title="", posts=0, posters=[], mentions=[])
    else:
        u.update(name=key.rsplit("/", 1)[1], more=[])
    return u


def _add(u, kind, r, who, h, act, at):
    """What one record adds to its unit's facts; `at` is [its ref, its place among its line's records]. A pull
    request's commits add their diff's lines and files."""
    if kind in ("pr", "issue"):
        u.update(title=str(r.get("title") or ""), area=str(r.get("area") or ""), author=who, at=h)
        if kind == "pr":
            u["closes"] = r.get("closes")
        else:
            u["origin"] = "backlog" if h <= 0 else "found during the run"
    elif kind == "commit":
        u["commits"].append(h)
        lines = str(r.get("diff") or "").splitlines()
        u["plus"] += sum(ln.startswith("+") and not ln.startswith("+++") for ln in lines)
        u["minus"] += sum(ln.startswith("-") and not ln.startswith("---") for ln in lines)
        u["paths"] += [ln[6:] for ln in lines if ln.startswith("+++ b/") and ln[6:] not in u["paths"]]
    elif kind == "review":
        u["reviews"].append([who, act, h])
    elif kind == "comment":
        u["comments"] += 1
    elif kind == "merge":
        u.update(state="merged", merged_by=who, ended=h)
    elif kind == "close":
        u.update(state="closed", closed_by=who, reason=str(r.get("reason") or "closed"), ended=h,
                 why=at if r.get("text") else None)
    elif kind == "reopen":
        u.update(state="open", closed_by=None, reason=None, ended=None, why=None)
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
    """{ref: [its line's records]} for the refs, each line (a table's row, all its lines) read at its byte offset."""
    out, by_path = {}, {}
    for ref in refs:
        path, _, n = ref.rpartition("#L")
        by_path.setdefault(path, set()).add(int(n))
    for path, ns in by_path.items():
        ctx = index["files"][path]
        with open(path, "rb") as f:
            for n in ns:
                f.seek(index["offsets"][path][n - 1])
                raw = b"".join(f.readline() for _ in range(ctx.get("rows", {}).get(n, n) - n + 1))
                try:
                    out[f"{path}#L{n}"] = _parse(ctx, n, raw)
                except ValueError:
                    out[f"{path}#L{n}"] = []
    return out


def _record(index, at):
    """The record at [ref, place among its line's records], or {}."""
    got = _read(index, [at[0]]).get(at[0]) or []
    return got[at[1]] if at[1] < len(got) else {}


def _key(label, value):
    return f"{label}\n{value}"


class _Labels:
    """The label calls of one fetch, each ref asked once. `classes` are the values of the labels that are on, each
    {label, value, colour}, in thimble's order, `colours` whether they key the records, and `hide` those whose records
    the page hides (`label\\nvalue`, or "none" for the records none marks). `keep(ref)`, `marks(ref)` (the classes that
    mark it), `first(ref)` (the first of them the page does not hide, or -1), `hidden(ref)` and `unit(u)` (whether the
    filter keeps the unit)."""

    def __init__(self, hide=(), colours=True):
        self.classes = [{"label": lab["name"], "value": v["name"], "colour": v["colour"]}
                        for lab in thimble.view_labels()["labels"] for v in lab["values"]]
        self.colours = colours and bool(self.classes)
        at = {_key(c["label"], c["value"]): i for i, c in enumerate(self.classes)}
        self._at = at
        self.hide = {h for h in hide or () if h == "none" or h in at} if self.colours else set()
        self._off = {at[h] for h in self.hide if h != "none"}
        self._keep, self._marks, self._unit = {}, {}, {}

    def keep(self, ref):
        if ref not in self._keep:
            self._keep[ref] = thimble.kept(ref)
        return self._keep[ref]

    def marks(self, ref):
        if not self.classes:
            return []
        if ref not in self._marks:
            self._marks[ref] = sorted({i for m in thimble.marked(ref)
                                       if (i := self._at.get(_key(m["label"], m["value"]))) is not None})
        return self._marks[ref]

    def first(self, ref):
        return next((i for i in self.marks(ref) if i not in self._off), -1)

    def of_unit(self, u):
        """The classes that mark any record the unit gathers and are not hidden, in thimble's order."""
        return sorted({i for ref in u["refs"] + u.get("more", []) for i in self.marks(ref) if i not in self._off})

    def hidden(self, ref):
        if not self.hide:
            return False
        got = self.marks(ref)
        return all(i in self._off for i in got) if got else "none" in self.hide

    def unit(self, u):
        if u["key"] not in self._unit:
            self._unit[u["key"]] = thimble.kept_unit(u["refs"] + u.get("more", []))
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
        return {}
    return {"agent": [u["name"]], "reviewed": sorted(u["partners"])}


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


def _colour(field, u, e):
    """What an event of the unit `u` is under the colour field: a review's reviewer and verdict, the first of its
    unit's flags, and "" for none."""
    if field == "actor":
        return e[3]
    if field == "run":
        return u["run"]
    if field in UNIT_COLOURS:
        return str(u.get(field) or "")
    if field in ("reviewer", "verdict"):
        return (e[3] if field == "reviewer" else e[2]) if e[6] == "review" else ""
    if field == "flag":
        return (u.get("flags") or [""])[0]
    return e[2]


def _part(field, u, e, labels):
    """An event's part of the activity and colour on a strip: the first class that marks it while a label is on
    (-1 for none), else its value under the colour field."""
    return labels.first(e[0]) if labels.colours else _colour(field, u, e)


def _item(tab, u, index, labels, field, on):
    """A unit as a row of the list, with its kept records as strip ticks: [ref, hours, action, part (_part), 1 when
    `on(event)` holds, the time range and the record filters picking it, else 0], `marks` (the classes that mark any of
    its records), and for a closed one the closer's words (`why`, read from its close record or from the closer's
    comment beside it)."""
    ticks = [[e[0], e[1], e[2], _part(field, u, e, labels), int(on(e))] for e in u["events"] if labels.keep(e[0])]
    base = {"key": u["key"], "run": u["run"], "at": u["at"], "ticks": ticks, "marks": labels.of_unit(u)}
    if u.get("state") == "closed" and u["why"]:
        base["why"] = {"ref": u["why"][0], "text": str(_record(index, u["why"]).get("text") or "")}
    if tab == "pulls":
        return {**base, **{k: u[k] for k in ("number", "title", "author", "state", "area", "closes", "merged_by",
                                             "closed_by", "reason", "ended", "to_merge", "first_review", "approvals",
                                             "changes", "comments", "flags", "latest", "plus", "minus")},
                "commits": len(u["commits"]), "reviews": len(u["reviews"]), "files": len(u["paths"])}
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
# the filters that pick records rather than units, and each one's place in an event, and the tabs that offer each
PICKS = {"actor": 3, "action": 2}
TAB_PICKS = {"pulls": ("actor", "action"), "issues": ("actor", "action"), "discussions": ("actor",),
             "agents": ("action",)}
AGENT_SORTS = ("merges", "opened", "merged", "reviews", "approved", "changes", "comments", "posts")


def _order(tab, units, sort):
    if tab == "agents":
        col = sort if sort in AGENT_SORTS else "merges"
        count = (lambda u: u["approved"] + u["changes"]) if col == "reviews" else (lambda u: u[col])
        return sorted(units, key=lambda u: (-count(u), u["run"], u["name"]))
    key = SORTS.get(sort) or (SORTS["most posts"] if tab == "discussions" else SORTS["newest"])
    return sorted(units, key=lambda u: (key(u), u["run"], u.get("number") or 0))


def _active(e):
    """Whether an event is activity of its run: a backlog issue was imported as its run began, which is not."""
    return not (e[1] < 0 or (e[1] == 0 and e[2] == "opened"))


def _activity(units, index, labels, runs, picked, field):
    """The kept records of the units that `picked(event)` holds for, per run, time bin and part (_part): {bin: minutes,
    hours: the longest run, rows: [run, bin, part, n]}."""
    span = max((index["runs"][r]["end"] - index["runs"][r]["start"]) / 3600 for r in runs) if runs else 1
    minutes = next((b for b in BINS if span * 60 / b <= MAX_BARS), BINS[-1])
    counts = {}
    for u in units:
        for e in u["events"]:
            if not _active(e) or not picked(e) or not labels.keep(e[0]):
                continue
            key = (u["run"], int(e[1] * 60 // minutes), _part(field, u, e, labels))
            counts[key] = counts.get(key, 0) + 1
    return {"bin": minutes, "hours": round(span, 3),
            "rows": [[*k, n] for k, n in sorted(counts.items(), key=lambda kv: (kv[0][0], kv[0][1], str(kv[0][2])))]}


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


def _values(v):
    """A filter's chosen values: a list of them, or one alone."""
    return [str(x) for x in (v if isinstance(v, list) else [v]) if x not in (None, "")]


def _colour_filter(tab, field):
    """The filter that narrows the tab by the colour field's values, whose own choice the field's counts leave out."""
    if field == "actor":
        return "agent" if tab == "agents" else "actor"
    if field == "action":
        return "action" if "action" in TAB_PICKS.get(tab, ()) else None
    return field if field in (*UNIT_COLOURS, "reviewer", "verdict", "flag") else None


def _view(index, query):
    tab = query.get("tab") if query.get("tab") in TABS else "pulls"
    field = query.get("colour") if query.get("colour") in COLOURS[tab] else "action"
    labels = _Labels(query.get("hide") or (), query.get("labels") is not False)
    all_runs = sorted(index["runs"])
    chosen = [r for r in (query.get("runs") or []) if r in index["runs"]] or all_runs
    q = str(query.get("q") or "").strip().lower()
    rng = query.get("range") if isinstance(query.get("range"), list) and len(query["range"]) == 2 else None
    wanted = {k: vs for k, v in (query.get("filters") or {}).items() if (vs := _values(v))}
    picks = {f: wanted.pop(f) for f in list(wanted) if f in PICKS}

    kept = [u for u in index["units"].values() if labels.unit(u)]
    tabs = {t: sum(u["tab"] == t and u["run"] in chosen for u in kept) for t in TABS}
    found = [u for u in kept if u["tab"] == tab and (not q or q in u["search"])]
    facts = {u["key"]: _facets(tab, u) for u in found}

    def ok(u, skip=None):
        return all(any(v in facts[u["key"]].get(f, []) for v in vs) for f, vs in wanted.items() if f != skip)

    def picked(e, skip=None, hiding=True):
        return all(e[PICKS[f]] in vs for f, vs in picks.items() if f != skip) and not (hiding and labels.hidden(e[0]))

    def on(e, skip=None):
        """Whether the time range and every record filter but `skip` pick the event."""
        return (not rng or rng[0] <= e[1] < rng[1]) and picked(e, skip)

    def hits(u, skip=None):
        return [e for e in u["events"] if on(e, skip)]

    live = [u for u in found if not (rng or picks or labels.hide) or hits(u)]
    facets = {}
    for f in {f for u in live for f in facts[u["key"]]}:
        counts = {}
        for u in live:
            if u["run"] in chosen and ok(u, f):
                for v in facts[u["key"]].get(f, []):
                    counts[v] = counts.get(v, 0) + 1
        for v in wanted.get(f, ()):
            counts.setdefault(v, 0)
        facets[f] = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
    for f in TAB_PICKS.get(tab, ()):
        counts = {}
        for u in found:
            if u["run"] in chosen and ok(u):
                for v in {e[PICKS[f]] for e in hits(u, f)}:
                    counts[v] = counts.get(v, 0) + 1
        for v in picks.get(f, ()):
            counts.setdefault(v, 0)
        facets[f] = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))

    def unit_class(u):
        """The first class that marks a record of the unit and is not hidden, or -1."""
        got = [i for ref in u["refs"] if (i := labels.first(ref)) >= 0]
        return min(got) if got else -1

    runs = []
    for r in all_runs:
        us = [u for u in live if u["run"] == r and ok(u)]
        info = index["runs"][r]
        cls = [unit_class(u) for u in us] if labels.colours else []
        own = [path for path in index["offsets"] if path.split("/")[1:2] == [r]]
        runs.append({"run": r, "team": info["team"], "approvals": info["approvals"],
                     "started": _iso(info["start"]) if info["start"] is not None else None, "files": len(own),
                     "source": "an export" if any(path.startswith(f"runs/{r}/export/") for path in own) else "events.jsonl",
                     "hours": round((info["end"] - info["start"]) / 3600, 3), "chosen": r in chosen,
                     "marked": sum(c >= 0 for c in cls), "classes": [cls.count(i) for i in range(len(labels.classes))],
                     **_measures(tab, us, index, r)})

    shown = _order(tab, [u for u in live if u["run"] in chosen and ok(u)], query.get("sort"))
    offset = max(0, int(query.get("offset") or 0))
    active = [u for u in found if u["run"] in chosen and ok(u)]
    out = {"tab": tab, "tabs": tabs, "runs": runs, "chosen": chosen, "facets": facets, "total": len(shown),
           "offset": offset, "items": [_item(tab, u, index, labels, field, on) for u in shown[offset:offset + PAGE]],
           # the activity leaves out the time range, so the chart shows the range among the rest
           "activity": _activity(active, index, labels, chosen, picked, field),
           "colour": _colours(tab, field, index, found, chosen, all_runs, ok, picked, labels),
           **_classes(active, labels, picked), "hide": sorted(labels.hide)}
    if query.get("compare") and tab in ("pulls", "issues"):
        out["grid"] = _grid(tab, shown, index)
    if tab == "agents":
        out["pairs"] = {r: {u["name"]: u["partners"] for u in shown if u["run"] == r} for r in chosen}
    return out


def _colours(tab, field, index, found, chosen, all_runs, ok, picked, labels):
    """The colour field's values: `order`, the order they take their colours in, by records of the chosen runs on the
    tab whatever else is chosen, so a value keeps its colour while the filters change, and "" (no value) last; `values`,
    [value, records] of the activity with every filter but the field's own, the run's too for the run."""
    tally = {}
    for u in index["units"].values():
        if u["tab"] == tab and u["run"] in chosen:
            for e in u["events"]:
                if _active(e):
                    v = _colour(field, u, e)
                    tally[v] = tally.get(v, 0) + 1
    order = all_runs if field == "run" else sorted(tally, key=lambda v: (v == "", -tally[v], v))
    own = _colour_filter(tab, field)
    counts = {}
    for u in found:
        if (field != "run" and u["run"] not in chosen) or not ok(u, None if own in PICKS else own):
            continue
        for e in u["events"]:
            if _active(e) and picked(e, own if own in PICKS else None) and labels.keep(e[0]):
                v = _colour(field, u, e)
                counts[v] = counts.get(v, 0) + 1
    rest = sorted(v for v in counts if v not in order)
    return {"field": field, "filter": own, "order": order,
            "values": [[v, counts[v]] for v in [*order, *rest] if counts.get(v)]}


def _classes(units, labels, picked):
    """The classes with the activity's records each marks, the page's hiding aside, and `none`, those none marks."""
    n, none = [0] * len(labels.classes), 0
    if labels.classes:
        for u in units:
            for e in u["events"]:
                if _active(e) and picked(e, hiding=False) and labels.keep(e[0]):
                    got = labels.marks(e[0])
                    for i in got:
                        n[i] += 1
                    none += not got
    return {"classes": [{**c, "n": n[i]} for i, c in enumerate(labels.classes)], "none": none}


def _iso(t):
    return datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _texts(index, events, part=None):
    """The records of the events as a page shows them: [{ref, kind, action, author, at, hours, text, ..., colour_key}],
    `at` in UTC, `colour_key` the event's under the callable `part` when given."""
    read = _read(index, [e[0] for e in events])
    out = []
    for e in events:
        got = read.get(e[0]) or []
        if e[4] >= len(got):
            continue
        r = got[e[4]]
        x = {"ref": e[0], "kind": r["kind"], "action": _action(r), "author": r.get("author") or "", "at": _iso(e[5]),
             "hours": e[1], **{f: r[f] for f in ("number", "title", "text", "sha", "diff", "verdict", "reason",
                                                 "closes", "thread", "forced", "before") if r.get(f) is not None}}
        if part:
            x["colour_key"] = part(e)
        out.append(x)
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


def _detail(index, key, field="action", hide=(), colours=True):
    """One unit's page: its facts and its records with their text, in time order, each with its colour_key (_part)
    under the colour field `field`, or the labels while one is on and `colours` holds."""
    u = index["units"].get(key)
    if u is None:
        return None
    labels = _Labels(hide, colours)
    run = index["runs"][u["run"]]
    out = {k: v for k, v in u.items() if k not in ("refs", "events", "search", "more", "why")}
    out["marks"] = labels.of_unit(u)
    out["setup"] = {"team": run["team"], "approvals": run["approvals"],
                    "hours": round((run["end"] - run["start"]) / 3600, 3)}
    first = u["refs"][0] if u["refs"] else None
    out["records"] = [x for x in _texts(index, u["events"], lambda e: _part(field, u, e, labels))
                      if labels.keep(x["ref"]) or x["ref"] == first]
    if u["tab"] in ("pulls", "issues"):
        out["elsewhere"] = _elsewhere(index, u)
    if u["tab"] == "pulls" and (issue := index["units"].get(f"{u['run']}/issues/{u.get('closes')}")):
        out["issue"] = {k: issue[k] for k in ("key", "number", "title", "state")}
    if u["tab"] == "issues":
        out["pulls"] = [{k: index["units"][f"{u['run']}/pull/{n}"][k]
                         for k in ("key", "number", "title", "state", "author")} for n in u["prs"]]
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


RAW_LINES, RAW_CHARS = 300, 4000


def _raw(index, key):
    """[{ref, text}] of the lines a unit's records come from, in its records' order, as their files hold them."""
    u = index["units"].get(key)
    out = []
    for ref in (u["refs"] if u else [])[:RAW_LINES]:
        path, _, n = ref.rpartition("#L")
        with open(path, "rb") as f:
            f.seek(index["offsets"][path][int(n) - 1])
            rows = index["files"][path].get("rows", {})
            text = b"".join(f.readline() for _ in range(rows.get(int(n), int(n)) - int(n) + 1)).decode("utf-8", "replace").rstrip("\r\n")
        out.append({"ref": ref, "text": text if len(text) <= RAW_CHARS else text[:RAW_CHARS] + "…"})
    return out


def records(index, query):
    """{op: view, tab, runs?, compare?, q?, range?: [h0, h1], filters?: {filter: value or [values]}, colour?, labels?,
    hide?, sort?, offset?}: one tab under that selection, as _view describes. {op: unit, key, colour?, labels?, hide?}:
    one unit's page (_detail). {op: raw, key}: the lines its records come from as their files hold them (_raw). Times
    are hours since the run's start."""
    query = query or {}
    if query.get("op") == "raw":
        return _raw(index, str(query.get("key") or ""))
    if query.get("op") == "unit":
        u = index["units"].get(str(query.get("key") or ""))
        field = query.get("colour") if u and query.get("colour") in COLOURS[u["tab"]] else "action"
        return _detail(index, str(query.get("key") or ""), field, query.get("hide") or (),
                       query.get("labels") is not False)
    return _view(index, query)


def _excerpt(r):
    """A record's own words, one field per line, as its line writes them; a record with none (a merge) gives its
    author."""
    lines = [str(r[f]) for f in ("title", "text", "reason", "sha") if r.get(f)]
    return "\n".join(lines) or str(r.get("author") or r.get("kind") or "")


def resolve(index, locator):
    """<file>#L<n>: the record, opened in its unit; a manifest's line opens its run, a transcript's line its agent,
    and a redelivered event the event it repeats. view:<slug>/<run>: the run, its excerpt the brief.
    view:<slug>/<run>/pull/<n>, issues/<n>, discussions/<n> or agents/<name>: the unit, its excerpt the first record's
    text, citing every line it gathers."""
    if "key" in locator:
        key = str(locator["key"])
        if key in index["runs"]:
            run = index["runs"][key]
            if not run["ref"]:
                return None
            refs = [run["ref"]] + [ref for ref, k in index["line"].items() if k.startswith(key + "/")]
            return {"excerpt": str(run["brief"] or key), "label": f"{key} · {run['team']} agents",
                    "refs": refs[:200], "key": key, "target": {"run": key}}
        u = index["units"].get(key)
        if u is None or not u["refs"]:
            return None
        name = u.get("title") or u.get("name") or key
        label = f"{u['run']} #{u['number']} {name}" if u.get("number") is not None and u["tab"] != "discussions" \
            else f"{u['run']} {name}"
        return {"excerpt": _excerpt(_record(index, [u["refs"][0], 0])), "label": label[:40],
                "refs": (u["refs"] + u.get("more", []))[:200], "key": key, "target": {"key": key}}
    path, fragment = locator.get("path"), str(locator.get("fragment") or "")
    m = re.fullmatch(r"L(\d+)", fragment)
    if not m or path not in index["offsets"] or not 1 <= int(m.group(1)) <= len(index["offsets"][path]):
        return None
    ref, ctx = f"{path}#{fragment}", index["files"][path]
    run = ctx["run"]
    if ctx["shape"] == "manifest":
        info = index["runs"][run]
        return {"excerpt": str(info["brief"] or run), "label": f"{run} manifest", "refs": [ref], "key": run,
                "target": {"run": run}}
    shown = index["same"].get(ref, ref)
    key = index["line"].get(shown)
    got = _read(index, [ref]).get(ref) or []
    if not got or key is None:
        return None
    r, who = got[0], str(got[0].get("author") or "")
    if r["kind"] in ("agent", "turn"):
        label = f"{run} {who}'s {'sign-off' if r['kind'] == 'agent' else 'transcript'}"
    elif r.get("number") is not None:
        label = f"{run} #{r['number']} {_action(r)} by {who}"
    else:
        label = f"{run} {_action(r)} by {who}"
    return {"excerpt": _excerpt(r), "label": label[:40], "refs": [ref], "key": key,
            "target": {"key": key} if r["kind"] == "turn" else {"key": key, "ref": shown}}


def problems(index):
    """The lines that do not parse, each {ref, why}, which thimble shows beside the page."""
    return index["problems"]


def hidden(index):
    """The files in scope the reader leaves out, each {path, why}: a file whose place in a run's folder it does not know."""
    return [{"path": p, "why": "not a file of a run's folder that the reader knows: manifest.json, events.jsonl, "
                               "board.jsonl, agents/<name>.jsonl or an export/ table"} for p in index.get("unknown", [])]
