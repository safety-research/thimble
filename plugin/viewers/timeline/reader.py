# Timeline: a ferry operator's ops export over several days, every source on one time axis.
#
# The data (sample/): what each system exported, in its own format and on its own clock. The reader turns every
# record into the same fields (below, "The records") and cleans what the sources get wrong ("The cleaning").
# alerts/*.jsonl, the monitor's alerts, one JSON object per line, a file per start of the monitor (it starts again
#   each midnight), named for the day and time it started:
#   id         the alert's id, such as alr-44
#   ts         when, in milliseconds since 1970
#   state      firing or resolved; FIRING or RESOLVED since the monitor's 4.0 upgrade
#   svc        the service, before the upgrade
#   service    the service, since the upgrade; null on some alerts
#   severity   warning or critical
#   incident   the incident, such as INC-312; absent before the upgrade and null since it outside any incident
#   msg        what the alert says, before the upgrade
#   summary    what the alert says, since the upgrade
#   resolves   on a resolved alert, the id of the alert it resolves
#   monitor    on the line a monitor writes as it starts, which is no alert: its version
#   started    on that line, when it started
#   rules      on that line, how many alert rules it loaded
# deploys.csv, the deploy tool's events, a header row and then one row per event: time (local time, with an offset
#   when deploybot wrote the row and without one when a person ran the tool), deploy (the deploy's id, the same on
#   each of its events), event (started, finished or rollback), service, version, by (a login), reason (free text,
#   naming an incident on some), result (ok or failed, sometimes with words after it) and notes, every day's rows in
#   the one file.
# chat/*.json, one file per channel, {channel, messages}: each message has ts (seconds since 1970, as a string, and
#   its id in the channel), user (an id), text, and on some thread_ts (the ts of the thread's first message), edited,
#   subtype (bot_message with a username, or channel_join) and user_profile (a guest's name). A channel named like
#   inc-312 is one incident's, and every day's messages are in the channel's one file. chat/users.json names the
#   people: id, name (their login) and display_name.
# tickets/*.txt, one support ticket per file, like an email thread: the headers Ticket, Subject and Requester, then
#   each message's From, Date (an email date, in the sender's time zone) and Status (open, pending or closed), a blank
#   line and its text, a signature after "-- " on some. tickets/index.csv lists the tickets as the helpdesk last
#   exported them: ticket, subject, priority, service and incident.
# agents.log, the automated agents' actions over every day, one line each: a UTC time, a level, the agent, and
#   key=value pairs:
#   action, incident, service, what set it off (alert, ticket, or via, the chat message that asked, as
#   <channel>/<ts>), result, and msg, what it did.
#
# The records: every source becomes records with the same fields, which the page filters and colours by.
#   time (in UTC), source (alert, deploy, chat, ticket or agent), kind (fired or resolved; started, finished or
#   rollback; message; opened, updated or closed; an agent's action), actor (the monitor, a person, a customer or an
#   agent), service, severity (an alert's severity, a ticket's priority), outcome (ok, failed or held), incident,
#   answers (the id of the record it answers), took (the seconds since that record), id and text.
#
# The cleaning:
#   times       every clock becomes seconds since 1970: epoch milliseconds, epoch seconds in a string, ISO 8601 with or
#               without an offset, and email dates; a time without an offset is local in deploys.csv and UTC in
#               agents.log
#   renames     the monitor's svc and msg are read as service and summary, its state in any case
#   missing     an alert with a null service takes the one its summary starts with ("web-2: ..." is web); a ticket the
#               index does not list, or lists with no priority, has no severity
#   duplicates  an alert delivered twice is kept once, and the later line opens the first
#   order       records are sorted by time, whatever order their file holds them in
#   bad lines   a line that does not parse whole, such as agents.log's torn last line, a JSON escape a log value gets
#               wrong, an alert line with no id or state, a chat file that is not one channel, a ticket with no message
#               or a record with no time the reader can read, is no record, and problems() lists it for thimble to show
#   the index   tickets are the files on disk: the index gives their fields, and its rows without a file are ignored
#   free text   a priority or result with words around it ("Urgent - 2nd double charge") takes the value it names;
#               a deploy's reason or a chat message that names an incident belongs to it, and a deploy's later events
#               to its incident
#   people      a login or a chat id becomes the name users.json gives, and a guest takes their profile's name
#   non-records a chat channel's join notices and the monitor's start line are skipped
#   links       an alert's resolves, a deploy's later events, a thread's replies, a ticket's later messages and what
#               set an agent off become `answers`, the record answered
#
# The method: the index keeps every record as a row of small integers (time, file, line, each field's value as an
# index into that field's names, the row it answers) in time order, with its id, the lines its record spans, and
# the byte offset of every line. A record's line is the one that holds its text, so a label, which reads a file line
# by line, marks that line. `records` sends the rows the label filter keeps as columns, OVERVIEW_ROWS rows a fetch, and
# the page asks for the next page until it has them all, so it picks days, zooms, filters and lays out lanes without
# asking again; text, search and a record's details are read back from the files by seeking to the record's lines and
# parsing them again. A record's details carry its lines as the file holds them, which the page shows beside the
# fields the reader made of them.
#
# Units: an incident (INC-312), a day (2026-05-16) and a window of time (2026-05-16T08:00..2026-05-16T09:00).
#
# Labels: they apply when records are served, never in the index. Every answer keeps only the records thimble.kept(ref)
# holds for. `marks` lists the values of the labels that are on, in thimble's order, and each row carries the ones
# thimble.marked(ref) gives it (the first as `m`, all of them as bits in `mb`), which the page draws in the labels'
# colours in its charts and lanes, since thimble cannot see inside them.
import bisect
import csv
import json
import re
from datetime import datetime, timedelta, timezone
from email.utils import parseaddr, parsedate_to_datetime
from operator import itemgetter
from pathlib import PurePosixPath

import thimble

FIELDS = ("source", "kind", "actor", "service", "severity", "outcome", "incident")  # the fields the page filters by
T, F, L = 0, 1, 2  # a row's time, file and line; the fields' values follow, then RE
RE = 3 + len(FIELDS)  # the row the record answers, or -1
LOCAL = timezone(timedelta(hours=1))  # the operator's clock in May, which deploys.csv writes
OUTCOMES = ("ok", "failed", "held")
PRIORITIES = ("urgent", "high", "normal", "low")
TEXT_MAX = 400  # characters of a record's text a list row gets
UNIT_REFS = 200  # refs a unit's citation carries
EXCERPT_RECORDS = 12  # records whose text a unit's excerpt quotes
MARKS_MAX = 24  # label values the page tells apart, as bits of one number per record
OVERVIEW_ROWS = 5000  # rows one overview fetch returns
MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
LOG_LINE = re.compile(r"(\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:?\d\d)?)\s+([A-Z]+)\s+(\S+)\s+(.*)")
LOG_PAIR = re.compile(r'(\w+)=("(?:[^"\\]|\\.)*"|[^\s"]\S*)')
INCIDENT = re.compile(r"\bINC-\d+\b")


def _epoch(v, naive=timezone.utc):
    """Whole seconds since 1970, or None: a number or a string of digits is epoch seconds, or milliseconds when it is
    that large; anything else is ISO 8601 or an email date. A time without an offset is in `naive`."""
    if v is None or isinstance(v, bool):
        return None
    s = str(v).strip()
    if isinstance(v, (int, float)) or re.fullmatch(r"\d+(\.\d+)?", s):
        x = float(s)
        return int(x / 1000 if x > 1e11 else x)
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        try:
            dt = parsedate_to_datetime(s)
        except (TypeError, ValueError, IndexError):
            return None
    return int((dt if dt.tzinfo else dt.replace(tzinfo=naive)).timestamp())


def _iso(epoch):
    return datetime.fromtimestamp(epoch, timezone.utc).strftime("%Y-%m-%dT%H:%M")


def _when(epoch):
    d = datetime.fromtimestamp(epoch, timezone.utc)
    return f"{d.day} {MONTHS[d.month - 1]} {d:%H:%M}"


def _str(v):
    return "" if v is None else str(v).strip()


def _word(v, words):
    """The first of `words` that the free text `v` names, ignoring case, else ""."""
    return next((w for w in re.findall(r"[a-z]+", _str(v).lower()) if w in words), "")


def _lines(path, offs):
    """(line number, text) of every line of the file, recording each line's byte offset in `offs`."""
    with open(path, "rb") as fh:
        pos = 0
        for n, raw in enumerate(fh, 1):
            offs.append(pos)
            pos += len(raw)
            yield n, raw.decode("utf-8", "replace").rstrip("\r\n")


def _problem(ctx, fi, n, why):
    """Note that line n of file fi holds no record because it does not parse."""
    ctx["problems"].append({"ref": f"{ctx['files'][fi]}#L{n}", "why": why})


def _csv_rows(lines, fi, ctx):
    """(first line, last line, cells) of each row of a CSV file's lines, a quoted cell that runs over several lines
    included; a row that does not parse is a problem."""
    numbers = []

    def feed():
        for n, s in lines:
            numbers.append(n)
            yield s + "\n"

    rows, done = csv.reader(feed(), strict=True), 0
    while True:
        try:
            cells = next(rows)
        except StopIteration:
            return
        except csv.Error as e:
            _problem(ctx, fi, numbers[done], f"not a CSV row ({e})")
        else:
            yield numbers[done], numbers[rows.line_num - 1], cells
        done = rows.line_num


def _rec(fi, line, span, t, source, kind, actor, service, severity, outcome, incident, rid, key=None, re_key=None):
    """A record found while indexing: `key` is how other records name it, `re_key` how it names the one it answers."""
    vals = map(_str, (source, kind, actor, service, severity, outcome, incident))
    return {"t": t, "f": fi, "line": line, "span": span, "id": rid, "key": key, "re": re_key,
            "vals": dict(zip(FIELDS, vals, strict=True))}


# ---------------------------------------------------------------- the sources
# Each reads one file's (line number, text) pairs and yields its records (_rec).


def _alerts(lines, fi, ctx):
    for n, line in lines:
        try:
            r = json.loads(line)
        except ValueError:
            if line.strip():
                _problem(ctx, fi, n, "not a JSON object")
            continue
        if isinstance(r, dict) and "monitor" in r and not r.get("state"):
            continue  # the line a monitor writes as it starts
        if not isinstance(r, dict) or not r.get("id") or not r.get("state"):
            _problem(ctx, fi, n, "not an alert: " + ("not a JSON object" if not isinstance(r, dict)
                                                     else "no id" if not r.get("id") else "no state"))
            continue
        text = _str(r.get("summary", r.get("msg")))
        service = _str(r.get("service", r.get("svc")))
        if not service and (m := re.match(r"([a-z][\w-]*?)(?:-\d+)?:\s", text)):
            service = m.group(1)
        state = _str(r["state"]).lower()
        kind = "fired" if state == "firing" else state
        yield _rec(fi, n, (n, n), _epoch(r.get("ts")), "alert", kind, "monitor", service,
                   _str(r.get("severity")).lower(), "", r.get("incident"), _str(r["id"]),
                   key=("alert", _str(r["id"])) if kind == "fired" else None,
                   re_key=("alert", _str(r["resolves"])) if r.get("resolves") else None)


def _deploys(lines, fi, ctx):
    header, incidents = None, {}  # each deploy's incident, which its later events share
    for n, last, cells in _csv_rows(lines, fi, ctx):
        if header is None:
            header = ctx["headers"][fi] = [c.strip().lower() for c in cells]
            continue
        r = dict(zip(header, cells, strict=False))
        event, dep, login = _str(r.get("event")).lower(), _str(r.get("deploy")), _str(r.get("by"))
        first = event in ("started", "rollback")
        found = INCIDENT.search(_str(r.get("reason")))
        incident = found.group(0) if found else "" if first else incidents.get(dep, "")
        incidents.setdefault(dep, incident)
        actor = ctx["people"].get(login.lower(), login)
        yield _rec(fi, n, (n, last), _epoch(r.get("time"), LOCAL), "deploy", event, actor, r.get("service"), "",
                   _word(r.get("result"), OUTCOMES), incident, dep,
                   key=("deploy", dep) if first else None, re_key=None if first else ("deploy", dep))


def _json_items(text, key):
    """(item, start, end) for each item of the array under `key` in a JSON document's text, as character offsets."""
    m = re.search(r'"%s"\s*:\s*\[' % re.escape(key), text)
    if not m:
        return []
    dec, pos, out, gap = json.JSONDecoder(), m.end(), [], re.compile(r"[\s,]*")
    while True:
        pos = gap.match(text, pos).end()
        if pos >= len(text) or text[pos] == "]":
            return out
        item, end = dec.raw_decode(text, pos)
        out.append((item, pos, end))
        pos = end


def _chat(lines, fi, ctx):
    lines = list(lines)
    text = "\n".join(s for _, s in lines)
    try:
        doc = json.loads(text)
    except ValueError as e:
        _problem(ctx, fi, text.count("\n", 0, e.pos) + 1 if isinstance(e, json.JSONDecodeError) else 1, "not valid JSON")
        return
    if not isinstance(doc, dict) or not isinstance(doc.get("messages"), list):
        _problem(ctx, fi, 1, "not a chat channel: no object with a list of messages")
        return
    starts = [0]
    for _, s in lines:
        starts.append(starts[-1] + len(s) + 1)
    line_of = lambda pos: bisect.bisect_right(starts, pos)  # noqa: E731
    channel = _str(doc.get("channel")) or PurePosixPath(ctx["files"][fi]).stem
    own = channel.upper() if re.fullmatch(r"inc-\d+", channel, re.I) else ""
    for m, a, b in _json_items(text, "messages"):
        if not isinstance(m, dict):
            _problem(ctx, fi, line_of(a), "not a chat message: not a JSON object")
            continue
        if m.get("subtype") not in (None, "bot_message"):
            continue
        at = text.find('"text"', a, b)
        body, ts, thread = _str(m.get("text")), _str(m.get("ts")), _str(m.get("thread_ts"))
        if m.get("subtype") == "bot_message":
            actor = _str(m.get("username"))
        else:
            profile = m.get("user_profile") if isinstance(m.get("user_profile"), dict) else {}
            actor = ctx["people"].get(_str(m.get("user"))) or _str(profile.get("display_name")) or _str(m.get("user"))
        found = INCIDENT.search(body)
        line = line_of(at if at >= 0 else a)
        yield _rec(fi, line, (line_of(a), line_of(b - 1)), _epoch(ts), "chat", "message", actor, "", "", "",
                   own or (found.group(0) if found else ""), f"{channel}/{ts}", key=("chat", channel, ts),
                   re_key=("chat", channel, thread) if thread and thread != ts else None)


def _message(lines):
    """One ticket message's headers and the lines of its text, without a signature."""
    head, body, i = {}, [], 0
    while i < len(lines) and lines[i][1].strip():
        k, _, v = lines[i][1].partition(":")
        head[k.strip().lower()] = v.strip()
        i += 1
    for n, s in lines[i:]:
        if s.rstrip() == "--":
            break
        body.append((n, s))
    while body and not body[0][1].strip():
        body.pop(0)
    while body and not body[-1][1].strip():
        body.pop()
    return head, body


def _ticket(lines, fi, ctx):
    lines = list(lines)
    top, _ = _message(lines)
    num = top.get("ticket") or PurePosixPath(ctx["files"][fi]).stem
    fields = ctx["tickets"].get(num, {})
    starts = [k for k, (_, s) in enumerate(lines) if s.startswith("From:") and k and not lines[k - 1][1].strip()]
    if not starts and lines:
        _problem(ctx, fi, 1, "not a ticket: no message, a From: line after a blank line")
    for j, k in enumerate(starts):
        part = lines[k:starts[j + 1] if j + 1 < len(starts) else len(lines)]
        head, body = _message(part)
        name, addr = parseaddr(head.get("from", ""))
        kind = "opened" if j == 0 else "closed" if head.get("status", "").lower() == "closed" else "updated"
        first, last = part[0][0], max(n for n, s in part if s.strip())
        yield _rec(fi, body[0][0] if body else first, (first, last), _epoch(head.get("date")), "ticket", kind,
                   name or addr, fields.get("service"), fields.get("priority"), "", fields.get("incident"),
                   f"{num}.{j + 1}", key=None if j else ("ticket", num), re_key=("ticket", num) if j else None)


def _log_line(s):
    """A log line's time, level and agent with its key=value pairs, or None when it does not parse whole."""
    m = LOG_LINE.fullmatch(s.strip())
    if not m or LOG_PAIR.sub("", m.group(4)).strip():
        return None
    try:
        out = {k: json.loads(v) if v.startswith('"') else v for k, v in LOG_PAIR.findall(m.group(4))}
    except ValueError:  # a quoted value with an escape JSON does not have, such as \d
        return None
    return {**out, "time": m.group(1), "level": m.group(2), "agent": m.group(3)}


def _log(lines, fi, ctx):
    for n, s in lines:
        r = _log_line(s)
        if r is None:
            if s.strip():
                _problem(ctx, fi, n, "not a log line of time, level, agent and key=value pairs")
            continue
        via = r.get("via", "").split("/", 1)
        cause = (("alert", r["alert"]) if r.get("alert") else ("ticket", r["ticket"]) if r.get("ticket")
                 else ("chat", *via) if len(via) == 2 else None)
        yield _rec(fi, n, (n, n), _epoch(r["time"]), "agent", r.get("action"), r["agent"], r.get("service"), "",
                   _word(r.get("result"), OUTCOMES), r.get("incident"), "", re_key=cause)


SOURCES = {".jsonl": _alerts, ".csv": _deploys, ".json": _chat, ".txt": _ticket, ".log": _log}
LOOKUPS = ("users.json", "index.csv")  # files that describe other files' records and hold none


def _lookups(files, ctx):
    """{people: {chat id or login: name}, tickets: {ticket: {priority, service, incident}}} from users.json and the
    ticket index; a lookup that does not parse is a problem."""
    people, tickets = {}, {}
    for fi, path in enumerate(files):
        name = PurePosixPath(path).name
        try:
            if name == "users.json":
                with open(path, encoding="utf-8") as fh:
                    for u in json.load(fh):
                        shown = _str(u.get("display_name")) or _str(u.get("name"))
                        people[_str(u.get("id"))] = people[_str(u.get("name")).lower()] = shown
            elif name == "index.csv":
                with open(path, encoding="utf-8", newline="") as fh:
                    for r in csv.DictReader(fh, strict=True):
                        tickets[_str(r.get("ticket"))] = {"priority": _word(r.get("priority"), PRIORITIES),
                                                          "service": _str(r.get("service")),
                                                          "incident": _str(r.get("incident"))}
        except (OSError, ValueError, AttributeError, csv.Error) as e:
            _problem(ctx, fi, 1, f"cannot be read ({type(e).__name__})")
    return {"people": people, "tickets": tickets}


# ---------------------------------------------------------------- the index


def build_index(paths):
    """{"rows": [[epoch, file, line, *field values, re row]] in time order, "ids": [id per row], "spans": [[first line,
    last line] per row], "files": [path], "kinds": [each file's suffix, "" for a lookup], "headers": {file: csv
    header}, "names": {field: [name]} (index 0 is "", a record without the field), "offsets": [[byte offset of line n at
    n-1] per file], "at_line": [[firsts, lasts, rows] per file, the lines each row's record spans], "answered": {row:
    [rows that answer it]}, "units": {incident: [first row, last row]}, "problems": [{ref, why}] of the lines that do
    not parse}."""
    files = list(paths)
    ctx = {"files": files, "headers": {}, "problems": []}
    ctx.update(_lookups(files, ctx))
    offsets, kinds, found = [], [], []
    for fi, path in enumerate(files):
        offs = []
        offsets.append(offs)
        suffix = PurePosixPath(path).suffix.lower()
        kinds.append("" if PurePosixPath(path).name in LOOKUPS else suffix)
        parse = SOURCES.get(kinds[-1])
        if parse is None:
            for _ in _lines(path, offs):
                pass
            continue
        for r in parse(_lines(path, offs), fi, ctx):
            if r["t"] is None:
                _problem(ctx, fi, r["line"], "no time the reader can read")
            else:
                found.append(r)
    kept, seen, alias = [], {}, []
    for r in found:
        dup = (r["vals"]["source"], r["id"], r["vals"]["kind"], r["t"]) if r["id"] else None
        if dup in seen:
            alias.append((r, seen[dup]))
            continue
        if dup:
            seen[dup] = r
        kept.append(r)
    kept.sort(key=lambda r: (r["t"], r["f"], r["line"]))
    names = {f: [""] for f in FIELDS}
    at = {f: {"": 0} for f in FIELDS}
    rows, keys = [], {}
    for i, r in enumerate(kept):
        r["row"] = i
        if r["key"]:
            keys.setdefault(r["key"], i)
        vals = []
        for f in FIELDS:
            v = r["vals"][f]
            if v not in at[f]:
                at[f][v] = len(names[f])
                names[f].append(v)
            vals.append(at[f][v])
        rows.append([r["t"], r["f"], r["line"], *vals, -1])
    for r in kept:
        if r["re"]:
            rows[r["row"]][RE] = keys.get(r["re"], -1)
    spans = [[] for _ in files]
    for r, row in [(r, r["row"]) for r in kept] + [(dup, first["row"]) for dup, first in alias]:
        spans[r["f"]].append((*r["span"], row))
    at_line = []
    for s in spans:
        s.sort()
        at_line.append([[x[0] for x in s], [x[1] for x in s], [x[2] for x in s]])
    inc = 3 + FIELDS.index("incident")
    units, answered = {}, {}
    for i, row in enumerate(rows):
        if row[inc]:
            units.setdefault(names["incident"][row[inc]], [i, i])[1] = i
        if row[RE] >= 0:
            answered.setdefault(row[RE], []).append(i)
    return {"rows": rows, "ids": [r["id"] for r in kept], "spans": [list(r["span"]) for r in kept], "files": files,
            "kinds": kinds, "headers": ctx["headers"], "names": names, "offsets": offsets, "at_line": at_line,
            "answered": answered, "units": units, "problems": ctx["problems"]}


def _text_of(kind, lines, header):
    """The text of the record on these lines, parsed as its source writes it."""
    try:
        if kind == ".jsonl":
            r = json.loads(lines[0][1])
            return _str(r.get("summary", r.get("msg")))
        if kind == ".csv":
            return _str(dict(zip(header or [], next(csv.reader(s + "\n" for _, s in lines)), strict=False)).get("notes"))
        if kind == ".json":
            return _str(json.loads("\n".join(s for _, s in lines).rstrip().rstrip(",")).get("text"))
        if kind == ".txt":
            return "\n".join(s for _, s in _message(lines)[1])
        if kind == ".log":
            return _str((_log_line(lines[0][1]) or {}).get("msg"))
    except (ValueError, AttributeError, StopIteration, csv.Error):
        pass
    return ""


def _read(index, rows):
    """{row: record} for the wanted rows: the row's fields, and its text read back from the lines it spans."""
    out, by_file = {}, {}
    for i in rows:
        by_file.setdefault(index["rows"][i][F], []).append(i)
    for fi, wanted in by_file.items():
        with open(index["files"][fi], "rb") as fh:
            for i in wanted:
                a, b = index["spans"][i]
                fh.seek(index["offsets"][fi][a - 1])
                lines = [(n, fh.readline().decode("utf-8", "replace").rstrip("\r\n")) for n in range(a, b + 1)]
                out[i] = _record_of(index, i, _text_of(index["kinds"][fi], lines, index["headers"].get(fi)))
    return out


def _record_of(index, i, text):
    row = index["rows"][i]
    r = {"id": index["ids"][i], "time": datetime.fromtimestamp(row[T], timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}
    r.update((f, index["names"][f][v]) for f, v in zip(FIELDS, row[3:RE], strict=True))
    if row[RE] >= 0:
        r["answers"] = index["ids"][row[RE]]
        r["took"] = row[T] - index["rows"][row[RE]][T]
    r["text"] = text
    return {k: v for k, v in r.items() if v != ""}


def _text(r, field):
    v = r.get(field)
    return v if isinstance(v, str) else ("" if v is None else str(v))


def _ref(index, i):
    row = index["rows"][i]
    return f"{index['files'][row[F]]}#L{row[L]}"


def _kept(index, i, keep=()):
    return i in keep or thimble.kept(_ref(index, i))


def _overview(index, keep, start=0):
    """The rows the filter keeps, and the rows in `keep` (a citation asked for them), from row `start` on and at most
    OVERVIEW_ROWS of them, as columns: `r` the row, `t` seconds since `t0`, `f` and `ln` its file and line, a column per
    field, `re` the row it answers and `tk` the seconds since that row (-1 for none), `m` the index in `marks` of its
    first mark (-1 for none) and `mb` all its marks as bits; `next` the row the next page starts at, None after the last.
    The first page also holds `marks`, every value of the labels that are on, each {label, value, colour}, marking
    records or not, and what the page needs to draw them: `t0`, `span`, `files`, `names` and each incident's start."""
    on = thimble.view_labels()
    rows = index["rows"]
    t0 = rows[0][T] if rows else 0
    cols = {k: [] for k in ("r", "t", "f", "ln", *FIELDS, "re", "tk", "m", "mb")}
    marks = [{"label": lab["name"], "value": v["name"], "colour": v["colour"]}
             for lab in on["labels"] for v in lab["values"]][:MARKS_MAX]
    mark_at = {(x["label"], x["value"]): m for m, x in enumerate(marks)}
    i = max(0, start)
    while i < len(rows) and len(cols["r"]) < OVERVIEW_ROWS:
        row, ref = rows[i], _ref(index, i)
        i += 1
        if on["filter"] and i - 1 not in keep and not thimble.kept(ref):
            continue
        first, bits = -1, 0
        for x in thimble.marked(ref) if marks else ():
            m = mark_at.get((x["label"], x["value"]))
            if m is not None:
                first = m if first < 0 else first
                bits |= 1 << m
        took = row[T] - rows[row[RE]][T] if row[RE] >= 0 else -1
        for k, v in zip(cols, (i - 1, row[T] - t0, row[F], row[L], *row[3:RE], row[RE], took, first, bits), strict=True):
            cols[k].append(v)
    page = {"cols": cols, "next": i if i < len(rows) else None}
    if start <= 0:
        page.update(t0=t0, span=[0, rows[-1][T] - t0 if rows else 0], files=index["files"], names=index["names"],
                    marks=marks, starts={k: rows[a][T] - t0 for k, (a, _) in index["units"].items()})
    return page


def _strings(r):
    return " ".join(r[k] for k in r if isinstance(r[k], str)).lower()


def _search(index, q):
    """The kept rows any of whose values holds `q`, ignoring case."""
    q = str(q or "").strip().lower()
    if not q:
        return {"q": q, "rows": []}
    got = _read(index, range(len(index["rows"])))
    return {"q": q, "rows": [i for i in sorted(got) if q in _strings(got[i]) and _kept(index, i)]}


def _texts(index, rows):
    """[[row, text]] for the wanted rows, each text cut to TEXT_MAX characters."""
    wanted = [i for i in rows if isinstance(i, int) and 0 <= i < len(index["rows"])][:1000]
    got = _read(index, wanted)
    return [[i, _text(got.get(i, {}), "text")[:TEXT_MAX]] for i in wanted]


def _brief(index, i, r):
    row = index["rows"][i]
    return {"r": i, "ref": _ref(index, i), "t": row[T], "source": _text(r, "source"), "kind": _text(r, "kind"),
            "actor": _text(r, "actor"), "text": _text(r, "text")[:TEXT_MAX]}


def _record(index, i, keep):
    """One record in full: its fields, its lines as the file holds them (`raw`, [[line, text]]), the record it answers
    and the kept records that answer it."""
    rows = index["rows"]
    if not isinstance(i, int) or not 0 <= i < len(rows):
        return None
    answers = [j for j in index["answered"].get(i, []) if _kept(index, j, keep)]
    parent = rows[i][RE]
    got = _read(index, [i, *answers, *([parent] if parent >= 0 else [])])
    a, b = index["spans"][i]
    fi = rows[i][F]
    with open(index["files"][fi], "rb") as fh:
        fh.seek(index["offsets"][fi][a - 1])
        raw = [[n, fh.readline().decode("utf-8", "replace").rstrip("\r\n")] for n in range(a, b + 1)]
    return {"r": i, "ref": _ref(index, i), "t": rows[i][T], "record": got.get(i, {}), "raw": raw,
            "answers": _brief(index, parent, got.get(parent, {})) if parent >= 0 else None,
            "answered": [_brief(index, j, got.get(j, {})) for j in answers]}


def records(index, query):
    """{op: overview, from?, keep?}: a page of the kept rows as columns (_overview), from row `from` on, `keep` rows
    kept whatever the filter.
    {op: texts, rows}: the rows' texts. {op: search, q}: the kept rows holding q. {op: record, r, keep?}: one row in
    full (_record)."""
    query = query or {}
    keep = {int(x) for x in query.get("keep") or () if isinstance(x, int)}
    op = query.get("op")
    if op == "texts":
        return {"texts": _texts(index, query.get("rows") or [])}
    if op == "search":
        return _search(index, query.get("q"))
    if op == "record":
        return _record(index, query.get("r"), keep | {query.get("r")})
    start = query.get("from")
    return _overview(index, keep, start if isinstance(start, int) and not isinstance(start, bool) else 0)


def _unit(index, found, label, key, target):
    """A unit's answer: the excerpt quotes the first records' texts, and the refs cite every record in time order."""
    got = _read(index, found[:EXCERPT_RECORDS])
    lines = [_text(got[i], "text") for i in found[:EXCERPT_RECORDS] if i in got and _text(got[i], "text")]
    return {"excerpt": "\n".join(lines), "label": label, "refs": [_ref(index, i) for i in found[:UNIT_REFS]],
            "key": key, "target": target}


def _at_line(index, fi, n):
    """(row, first line, last line) of the record whose lines hold line n of the file, else of the nearest record in
    the file (the next one, or the last before it) with its lines stretched to n; None in a file with no records."""
    firsts, lasts, rows = index["at_line"][fi]
    if not rows:
        return None
    k = bisect.bisect_right(firsts, n) - 1
    if k >= 0 and lasts[k] >= n:
        return rows[k], firsts[k], lasts[k]
    k = min(k + 1, len(rows) - 1)
    return rows[k], min(n, firsts[k]), max(n, lasts[k])


def resolve(index, locator):
    """<file>#L<n>: the record on that line, or the nearest one, chosen in the time around it.
    view:<slug>/<incident>: every record of the incident, filtered to it. view:<slug>/<YYYY-MM-DD>: the records of one
    day in UTC, that day picked. view:<slug>/<from>..<to>: the records between two UTC times, zoomed to them."""
    rows = index["rows"]
    if "key" in locator:
        key = str(locator["key"])
        if key in index["units"]:
            inc = index["names"]["incident"].index(key)
            col = 3 + FIELDS.index("incident")
            a, b = index["units"][key]
            found = [i for i in range(a, b + 1) if rows[i][col] == inc]
            return _unit(index, found, f"{key} · {len(found)} records", key, {"incident": key})
        if re.fullmatch(r"\d{4}-\d\d-\d\d", key):
            a = _epoch(key + "T00:00:00Z")
            found = [] if a is None else list(range(bisect.bisect_left(rows, a, key=itemgetter(T)),
                                                    bisect.bisect_left(rows, a + 86400, key=itemgetter(T))))
            if not found:
                return None
            return _unit(index, found, f"{_when(a)[:-6]} · {len(found)} records", key, {"day": key})
        m = re.fullmatch(r"(\d{4}-\d\d-\d\dT\d\d:\d\d)\.\.(\d{4}-\d\d-\d\dT\d\d:\d\d)", key)
        if not m or (a := _epoch(m.group(1))) is None or (b := _epoch(m.group(2))) is None or b <= a:
            return None
        found = list(range(bisect.bisect_left(rows, a, key=itemgetter(T)),
                           bisect.bisect_left(rows, b, key=itemgetter(T))))
        if not found:
            return None
        span = f"{_when(a)} to {_when(b)[-5:]}" if _when(a)[:-5] == _when(b)[:-5] else f"{_when(a)} to {_when(b)}"
        return _unit(index, found, f"{span} · {len(found)} records", key, {"from": _iso(a), "to": _iso(b)})
    path, fragment = locator.get("path"), str(locator.get("fragment") or "")
    m = re.fullmatch(r"L(\d+)", fragment)
    if not m or path not in index["files"]:
        return None
    hit = _at_line(index, index["files"].index(path), int(m.group(1)))
    if hit is None:
        return None
    i, a, b = hit
    r = _read(index, [i]).get(i, {})
    text = _text(r, "text") or _text(r, "kind")
    if not text:
        return None
    inc = _text(r, "incident") or None
    return {"excerpt": text, "label": f"{_text(r, 'actor') or _text(r, 'source')} · {_when(rows[i][T])}",
            "refs": [f"{path}#L{a}" if a == b else f"{path}#L{a}-L{b}"],
            "key": inc if inc in index["units"] else None, "target": {"r": i}}


def problems(index):
    """The lines that do not parse, each {ref, why}, which thimble shows beside the page."""
    return index["problems"]
