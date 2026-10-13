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
# and a run itself (<run>). The index keeps each unit's facts (state, area, flags, a thread's first words, an agent's
# sign-off) and its records' lines and times; a record's text is read back from its byte offset when the page opens the
# unit. The page draws the units the way a code forge and a message board draw them: lists with states and counts, a
# pull request's conversation, commits and changed files, an issue's timeline, a thread's posts and an agent's profile.
#
# What the page asks (records(index, query)):
#   {"op": "view", "run": <a run>, "tab": "pulls" | "issues" | "discussions" | "agents", "color": <color.query()>,
#    "filter": <filter.query()>}
#       one run's repository, as a forge shows one repository at a time: the run's units of the tab that the label
#       filter keeps (thimble.kept_unit) and Filter by keeps (thimble.color_on), each with the facts its
#       list row shows, its value under the Color by choice (thimble.color_value) and, under a label, how many of its
#       records take each value; the counts of every value for Filter by's and Color by's chips; how many units each
#       tab of the run holds under the same filters; and each run's facts with its tabs' counts, which the run switcher
#       lists. The run is the first when `run` names none
#   {"op": "unit", "key": <a unit's key>}
#       the unit's facts and its records the label filter keeps, with their text, in time order; for a pull request
#       the issue it fixes, for an issue the pull requests that fix it, each opening in its timeline; for both the same
#       issue in every run; and every #<n> its records mention, so the page links them
# Under a label, a unit stands for its records: its value is the label's value most of its marked records take, as
# thimble marks a unit, and `mix` counts its records by their own values, which the page draws as the unit's mix. An
# agent's row carries its author, itself, so Color by author colors it as it colors the other rows; under a field it
# does not carry, its records' state or area, it stands for its records in the same way, each record taking the value
# of the pull request, issue or thread it is about.
import csv
import io
import json
import re
from collections import Counter
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

import thimble

TABS = ("pulls", "issues", "discussions", "agents")
# what each kind of record did, as the page names it; a review is named by its verdict
ACTION = {"pr": "opened", "issue": "opened", "commit": "pushed", "comment": "commented", "merge": "merged",
          "close": "closed", "reopen": "reopened", "post": "posted", "agent": "signed off"}
MENTION = re.compile(r"#(\d+)\b")
NO_NAME = "unknown"  # the reviewer of a review whose account is gone
LEAD = 400  # characters the index keeps of a thread's first post and of an agent's sign-off, which their list rows show
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
        u.update(number=int(key.rsplit("/", 1)[1]), title="", posts=0, posters=[], mentions=[], lead="")
    else:
        u.update(name=key.rsplit("/", 1)[1], more=[], note="")
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
        u["lead"] = u["lead"] or str(r.get("text") or "")[:LEAD]
        u["posts"] += 1
        u["posters"] += [who] if who not in u["posters"] else []
        u["mentions"] = list(dict.fromkeys([*u["mentions"], *map(int, MENTION.findall(str(r.get("text") or "")))]))
    elif kind == "agent":
        u["note"] = str(r.get("text") or "")[:LEAD]


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
    u["need"] = run["approvals"] or 1
    # the review decision a forge writes on the pull request's row
    u["review"] = ("changes requested" if u["changes"] else "approved" if u["approvals"] >= u["need"]
                   else "review required")
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



def _value(choice, u, ref=None):
    """A unit's value under the page's Color by or Filter by: its state, area or author, or for a label the label's
    value on the record `ref`, else the value most of the unit's marked records take (the first of them on a tie), as
    thimble marks the unit; None for none."""
    if isinstance(choice, dict) and choice.get("label") is not None:
        if ref:
            return thimble.color_value(choice, ref)
        seen = Counter(v for r in (u["refs"] + u.get("more", []))[:200] if (v := thimble.color_value(choice, r)) is not None)
        return max(seen, key=seen.get) if seen else None
    return thimble.color_value(choice, None, u)


def _by_records(index, choice, u):
    """The values an agent's records take under a field its row does not carry: each record's is that of the pull
    request, issue or thread it is about (a review takes its pull request's state), None where that has none; the
    records its row counts (its sign-off left out) that the label filter keeps, in time order. None for any other unit,
    for a label, and for a field the agent carries: its author, itself."""
    if u["tab"] != "agents" or not isinstance(choice, dict) or choice.get("label") is not None or not choice.get("field"):
        return None
    if thimble.color_value(choice, None, u) is not None:
        return None
    return [thimble.color_value(choice, None, index["units"].get(index["line"].get(e[0])))
            for e in u["events"] if e[6] != "agent" and thimble.kept(e[0])]


def _values(choice, u, got):
    """The values a unit's row stands for under Color by or Filter by: its own (_value), or for an agent under a field
    it does not carry each value its records `got` take (_by_records), in the order they come; [None] for a row with
    none."""
    return [_value(choice, u)] if got is None else list(dict.fromkeys(got)) or [None]


# what an agent did, counted by the kind of record, in the order its profile lists them
DID = (("pr", "pull requests"), ("issue", "issues"), ("commit", "commits"), ("review", "reviews"), ("merge", "merges"),
       ("close", "closes"), ("comment", "comments"), ("post", "posts"))


def _facts(index, u):
    """What a unit's list row and the head of its page show: its key, run, title and when it opened, and its tab's
    facts. A pull request: its state, area, the issue it closes, the review decision, the approvals it has and needs,
    each reviewer's latest verdict, its comments, commits, lines added and removed, files and flags. An issue: its
    state, area, origin, the pull requests that fix it and its comments. A thread: its first post's author and words,
    its posts, posters and the last post. An agent: its sign-off note and what it did."""
    events = sorted(u["events"], key=lambda e: e[5])
    out = {"key": u["key"], "run": u["run"], "title": u.get("title") or u.get("name") or "",
           "opened": events[0][5] if events else index["runs"][u["run"]]["start"]}
    tab = u["tab"]
    if tab in ("pulls", "issues"):
        end = next((e[5] for e in reversed(events) if e[2] in ("merged", "closed", "fixed")), None)
        out.update(number=u["number"], author=u["author"], state=u["state"], area=u["area"] or None,
                   comments=u["comments"], ended=end if u["state"] != "open" else None)
    if tab == "pulls":
        out.update(closes=u["closes"], flags=u["flags"], review=u["review"], approvals=u["approvals"], need=u["need"],
                   reviewers=[[who, v] for who, v in u["latest"].items()], commits=len(u["commits"]), plus=u["plus"],
                   minus=u["minus"], files=len(u["paths"]), merged_by=u["merged_by"], closed_by=u["closed_by"],
                   reason=u["reason"])
    elif tab == "issues":
        out.update(origin=u["origin"], prs=u["prs"], fixed_by=u["fixed_by"])
    elif tab == "discussions":
        last = events[-1] if events else None
        out.update(number=u["number"], author=u["author"], lead=u["lead"], posts=u["posts"], posters=u["posters"],
                   mentions=u["mentions"], last=last[5] if last else None, last_by=last[3] if last else None)
    elif tab == "agents":
        kinds = Counter(e[6] for e in events if e[6] != "agent")
        out.update(author=u["author"], note=u["note"], did={name: kinds[k] for k, name in DID if kinds[k]})
    return out


def _view(index, query):
    """One run's tab as rows: {tab, run, items: [{<_facts>, value, search, mix?}], counts: {value: units} (Color by's),
    filtered: {value: units} (Filter by's), tabs: {tab: units}, runs: [{run, start, end, team, approvals, agents,
    tabs}]}. A unit shows when the label filter keeps one of its records and its values under Filter by are on: Color by
    only colors, so a value turned off there keeps its units. Each tab's count is of the units that show, in each run
    for the run switcher. Under a label, `mix` is [[value, records]] of the unit's records the label filter keeps. An
    agent under a field it does not carry stands for its records too: it counts under each value they take, shows while
    any of those is on under Filter by, and its `mix` and `value` are its records' (_by_records)."""
    tab = query.get("tab") if query.get("tab") in TABS else "pulls"
    names = sorted(index["runs"])
    run = query.get("run") if query.get("run") in index["runs"] else (names[0] if names else None)
    color, filt = query.get("color"), query.get("filter")
    by_label = isinstance(color, dict) and color.get("label") is not None
    items, counts, filtered = [], Counter(), Counter()
    tabs = {r: Counter() for r in names}
    units = sorted(index["units"].values(), key=lambda u: (u["run"], u.get("number") or 0, u.get("name") or ""))
    for u in units:
        if not thimble.kept_unit(u["refs"] + u.get("more", [])):
            continue
        here = u["run"] == run and u["tab"] == tab
        fvs = _values(filt, u, _by_records(index, filt, u))
        if here:
            filtered.update("" if v is None else v for v in fvs)
        if not any(thimble.color_on(filt, v) for v in fvs):
            continue
        got = _by_records(index, color, u)
        values = _values(color, u, got)
        if here:
            counts.update("" if v is None else v for v in values)
        tabs[u["run"]][u["tab"]] += 1
        if not here:
            continue
        # an agent standing for its records takes the value most of them take, as a unit under a label does
        seen = Counter(v for v in got or [] if v is not None)
        value = _value(color, u) if got is None else seen.most_common(1)[0][0] if seen else None
        item = {**_facts(index, u), "value": value, "search": u["search"]}
        mix = None
        if by_label:
            # the unit's records as thimble marks it (resolve's refs): how many take each value, in the order they come
            mix = Counter(_value(color, u, r) for r in (u["refs"] + u.get("more", []))[:200] if thimble.kept(r))
        elif got is not None:
            mix = Counter(got)
        if mix is not None:
            item["mix"] = [[v, n] for v, n in mix.items()]
        items.append(item)
    runs = [{"run": r, "start": info["start"], "end": info["end"], "team": info["team"], "approvals": info["approvals"],
             "agents": info["agents"], "tabs": {t: tabs[r][t] for t in TABS}} for r, info in sorted(index["runs"].items())]
    return {"tab": tab, "run": run, "items": items, "counts": dict(counts), "filtered": dict(filtered),
            "tabs": {t: tabs[run][t] for t in TABS} if run else {t: 0 for t in TABS}, "runs": runs}


def _iso(t):
    return datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _texts(index, events):
    """The records of the events as the page shows them: [{ref, kind, action, author, at, hours, text, ...}], `at` in
    UTC."""
    read = _read(index, [e[0] for e in events])
    out = []
    for e in events:
        got = read.get(e[0]) or []
        if e[4] >= len(got):
            continue
        r = got[e[4]]
        out.append({"ref": e[0], "kind": r["kind"], "action": _action(r), "author": r.get("author") or "",
                    "at": _iso(e[5]), "hours": e[1],
                    **{f: r[f] for f in ("number", "title", "text", "sha", "diff", "verdict", "reason", "closes",
                                         "thread", "forced", "before") if r.get(f) is not None}})
    return out


def _brief(u):
    """A pull request or an issue as a link to it: {key, number, title, state, author}."""
    return {"key": u["key"], "number": u["number"], "title": u["title"], "state": u["state"], "author": u["author"]}


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


def _mentions(index, run, texts):
    """Every #<n> the texts mention that names a pull request or an issue of the run, the records' own numbers among
    them: {n: {key, number, title, state, author}}."""
    out = {}
    for text in texts:
        for n in MENTION.findall(str(text or "")):
            u = index["units"].get(f"{run}/pull/{n}") or index["units"].get(f"{run}/issues/{n}")
            if u is not None:
                out[n] = _brief(u)
    return out


def _detail(index, key):
    """One unit opened: {key, facts, records, ...}. Its records the label filter keeps, the first always, in time order;
    an issue's timeline holds the openings of the pull requests that fix it too. A pull request names the issue it
    fixes (`fixes`) and an issue the pull requests that fix it (`prs`), and both the same issue in every run
    (`elsewhere`); `mentions` are the pull requests and issues its records name by #<n>."""
    u = index["units"].get(key)
    if u is None:
        return None
    first = u["refs"][0] if u["refs"] else None
    events = list(u["events"])
    out = {"key": key, "facts": _facts(index, u)}
    if u["tab"] == "pulls":
        issue = index["units"].get(f"{u['run']}/issues/{u['closes']}")
        out["fixes"] = _brief(issue) if issue else None
    elif u["tab"] == "issues":
        prs = [p for n in u["prs"] if (p := index["units"].get(f"{u['run']}/pull/{n}"))]
        out["prs"] = [_brief(p) for p in prs]
        events += [e for p in prs for e in p["events"] if e[6] == "pr"]
    if u["tab"] in ("pulls", "issues"):
        out["elsewhere"] = _elsewhere(index, u)
    recs = [x for x in _texts(index, sorted(events, key=lambda e: e[5])) if x["ref"] == first or thimble.kept(x["ref"])]
    out["records"] = recs
    texts = [u.get("title"), u.get("lead"), u.get("note"), *(x.get(f) for x in recs for f in ("title", "text", "reason")),
             *(f"#{x[f]}" for x in recs for f in ("number", "closes") if x.get(f) is not None)]
    out["mentions"] = _mentions(index, u["run"], texts)
    return out


def records(index, query):
    """{op: view, run?, tab, color?, filter?}: one run's tab of units (_view). {op: unit, key}: one unit opened
    (_detail)."""
    query = query or {}
    if query.get("op") == "unit":
        return _detail(index, str(query.get("key") or ""))
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
