# Swarm: many agents acting on shared pages and channels. The multiagent-swimlane card type (card.py) reads its records and
# links from this reader's index, and run as a script (main) it prints the records in order, as the shares the
# orientation writes for its swarm-reader agents.
#
# The records: JSON Lines or CSV files of saves and posts. The reader finds each file's fields by their names:
#   who     the first actor field with a value (ACTOR_KEYS), else the address of a save made without an account
#   where   the place field, such as a page or a channel (PLACE_KEYS), else the file's own path under the folder that
#           all such files share, as for a wiki kept as one file per page
#   when    ISO 8601 with Z, an offset or no zone (read as UTC), or epoch seconds or milliseconds (TIME_KEYS)
#   text    the text field (TEXT_KEYS); a record with an actor and a text is an action
#   save    an action with a sequence field (SEQ_KEYS) holds a whole document, so what it did is what it changed from
#           the save before it on its place; any other action is a post, and what it did is what it says
#   reply   a field naming the id of the record it answers (REPLY_KEYS)
# A record with an account and a goal field (GOAL_KEYS) but no text is a roster row: its goal heads the account's row.
# A record with a place and a title but no text names its place (a page index), as does an action's title field
# (TITLE_KEYS) for a place nothing else names. Other records are left alone.
#
# The sample: one night of a survey team's shared wiki and chat, and its roster. roster.csv (`account`, `objective`,
# `joined`); wiki/index.jsonl (`slug`, `title`, `created`, `by`); wiki/pages/<slug>.jsonl, one page's saves (`rev`,
# `user` or `ip`, `ts`, `summary`, `text`, the whole page after the save); chat/<channel>.jsonl, posts (`id`,
# `channel`, `user`, `ts`, `text`, `reply_to`) and join notices, night-ops.jsonl in a later exporter's fields (`room`,
# `author`, `sent` in epoch milliseconds, `body`, `parent`).
#
# What the reader cleans:
#   - A line that is not a JSON object, or a CSV row that does not parse, is left out and reported (problems), which
#     thimble shows above the page, as are an action with no account, one whose text is not a string or is under
#     another text field than its file's, and a claimed file with neither. A time that does not parse, a CSV row with
#     more or fewer cells than its header, a line that is not UTF-8 and a file that cannot be read are reported too. A
#     quoted CSV cell over several lines is one row, citing every line. A UTF-8 byte order mark is dropped.
#   - A repeated record (the same id, or the same sequence on one place, in one file: a replayed save, a post delivered
#     twice) is left out, and a citation of it opens the first.
#   - Records are put in time order across files; a record with no time keeps its place after the line before it in its
#     file and shows as having none.
#   - A roster names an account with other capitals than its actions do: accounts are matched without case.
#   - A save that changes only spacing, or only re-encodes lines, changes nothing, and says so: saves are compared line
#     by line on each line with its mojibake repaired (runs of Latin-1 characters that read as UTF-8, such as "Ã©" for
#     "é", as a wiki that re-encodes its pages on each save grows them) and its spacing collapsed (_key).
#   - Text shown in a listing or beside the rows has its mojibake repaired and control characters dropped (_clean);
#     the excerpts that cite the records stay as written.
#
# The method: the index keeps, per record, only what finding and ordering it needs (its offset, account, place, time,
# the save before it, the record it replies to), so a corpus of many thousand saves indexes in seconds; a record's text,
# what its save changed, the name it signs with and the accounts it names are read back from its line when it is shown.
#
# Links (_reach), for the card type, which names the links it draws and lists those the records themselves carry among
# its actions, counted from the index with no text read:
#   reply       the record answers the other record (its reply field)
#   names       the record names the other record's account (the latest record of that account before it)
#   same place  the record before it on its place, by another account
# A pair keeps one link, the first of these that holds.
#
# Which files it reads: those its card.json claims, every JSON Lines and CSV file; a file whose records have no account
# and text and name no place is left out and reported, and the script's listing gives each file the records it reads
# there, or why it reads none.
import csv
import difflib
import io
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

try:
    import thimble
except ImportError:  # run as a script (main), which asks nothing of the labels
    thimble = None

ACTOR_KEYS = ("user", "username", "author", "account", "actor", "agent", "sender", "label", "login", "by")
ANON_KEYS = ("ip", "address", "ip16")
PLACE_KEYS = ("channel", "channel_id", "room", "room_id", "page", "page_id", "thread", "thread_id", "topic", "topic_id",
              "issue", "issue_id", "conversation", "conversation_id", "slug")
TIME_KEYS = ("ts", "time", "timestamp", "sent", "created_at", "created", "date")
TEXT_KEYS = ("text", "body", "content", "message")
REPLY_KEYS = ("reply_to", "parent", "in_reply_to", "parent_id")
ID_KEYS = ("id", "rev_id", "message_id")
SEQ_KEYS = ("rev", "seq", "revision")
GOAL_KEYS = ("objective", "goal", "brief", "purpose", "role")
TITLE_KEYS = ("thread_title", "title", "subject")  # an action's name for its place, when nothing else names it
MARKS_MAX = 24  # label values the overview and the card type tell apart
CARD_CHARS = 110
TEXT_MAX = 60_000  # characters of a record's text the page gets
FIELD_MAX = 300
HUNK_LINES = 400
HUNK_PAIRS_MAX = 4_000_000  # line pairs a save's diff compares at most; past it the lines are compared as sets
EXCERPT_LINES = 12
LINE_MAX = 400
PROBLEMS_KEPT = 50  # problems the index lists; all are counted
SIGNATURE = re.compile(r"(?:—|--)\s*([A-Za-z][\w.'-]*(?: [\w.'-]+){0,3})\s*$")
WORD = re.compile(r"@?[A-Za-z][\w.-]*\w")
SENTENCE = re.compile(r"(?<=[.?!])\s+")
MOJIBAKE = re.compile(r"[\u0080-\u00ff]{2,}")
CONTROL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f-\x9f]")
T_MIN = datetime(1, 1, 2, tzinfo=timezone.utc).timestamp()  # the times a datetime can show in any zone
T_MAX = datetime(9999, 12, 30, tzinfo=timezone.utc).timestamp()
MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def _first(rec, keys):
    """(the first of `keys` the record holds a value under, the value as text), or (None, "")."""
    for k in keys:
        v = rec.get(k)
        if v is not None and not isinstance(v, (dict, list)) and str(v).strip():
            return k, str(v).strip()
    return None, ""


def _time(v):
    """Epoch seconds of epoch seconds or milliseconds, or of ISO 8601 with or without a zone (UTC then), between T_MIN
    and T_MAX; None."""
    if isinstance(v, bool) or v in (None, ""):
        return None
    if isinstance(v, (int, float)):
        t = v / 1000 if v > 1e11 else float(v)
        return t if T_MIN <= t <= T_MAX else None
    s = str(v).strip()
    if re.fullmatch(r"\d{9,13}(\.\d+)?", s):
        return _time(float(s))
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None
    t = (dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)).timestamp()
    return t if T_MIN <= t <= T_MAX else None


def _iso(t):
    return datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _problem(problems, ref, why):
    problems["count"] += 1
    if len(problems["examples"]) < PROBLEMS_KEPT:
        problems["examples"].append({"ref": ref, "why": why})


# ------------------------------------------------------------------------------------------------ the index


def _rows(path, problems):
    """[(first line, last line, record dict)] of a file: the JSON objects of a JSON Lines file, a CSV's rows by its
    header. A file that cannot be read is reported and has none."""
    try:
        raw = Path(path).read_bytes()
    except OSError as e:
        _problem(problems, path, f"not read ({e.strerror or e})")
        return []
    out = []
    if path.endswith(".csv"):
        try:
            text = raw.decode("utf-8-sig")
        except UnicodeDecodeError:
            _problem(problems, path, "not UTF-8; shown with replacement characters")
            text = raw.decode("utf-8-sig", "replace")
        reader = csv.reader(io.StringIO(text), strict=True)
        header, done = None, 0
        while True:
            try:
                cells = next(reader)
            except StopIteration:
                break
            except csv.Error as e:
                _problem(problems, f"{path}#L{done + 1}", f"not a CSV row ({e})")
                done = reader.line_num
                continue
            first, last = done + 1, max(done + 1, reader.line_num)
            done = reader.line_num
            if not any(c.strip() for c in cells):
                continue
            if header is None:
                header = [c.strip().lower() for c in cells]
                continue
            if len(cells) != len(header):
                _problem(problems, f"{path}#L{first}", f"{len(cells)} cells where the header has {len(header)}")
            out.append((first, last, {k: v.strip() for k, v in zip(header, cells)}))
        return out
    for n, line in enumerate(raw.split(b"\n"), 1):
        if not line.strip():
            continue
        try:
            text, utf8 = line.decode("utf-8"), True
        except UnicodeDecodeError:
            text, utf8 = line.decode("utf-8", "replace"), False
        try:
            rec = json.loads(text.lstrip("\ufeff"))
        except ValueError:
            rec = None
        if not isinstance(rec, dict):
            _problem(problems, f"{path}#L{n}", "not a JSON object")
            continue
        if not utf8:
            _problem(problems, f"{path}#L{n}", "not UTF-8; shown with replacement characters")
        out.append((n, n, rec))
    return out


def _csv_header(path):
    """A CSV's header as _rows reads it: its first row with a cell, lower-cased; None when there is none."""
    try:
        with open(path, encoding="utf-8-sig", errors="replace", newline="") as fh:
            for cells in csv.reader(fh):
                if any(c.strip() for c in cells):
                    return [c.strip().lower() for c in cells]
    except (OSError, csv.Error):
        return None
    return None


def _offsets(path):
    offs, pos = [], 0
    try:
        with open(path, "rb") as fh:
            for raw in fh:
                offs.append(pos)
                pos += len(raw)
    except OSError:
        return []
    return offs


def _fields(rows):
    """The fields of a file's records by role, each the key most of its records use: {actor, anon, place, time, text,
    reply, id, seq, goal}."""
    out = {}
    for role, keys in (("actor", ACTOR_KEYS), ("anon", ANON_KEYS), ("place", PLACE_KEYS), ("time", TIME_KEYS),
                       ("text", TEXT_KEYS), ("reply", REPLY_KEYS), ("id", ID_KEYS), ("seq", SEQ_KEYS), ("goal", GOAL_KEYS)):
        count = {}
        for _a, _b, rec in rows:
            k = next((k for k in keys if k in rec), None)
            if k:
                count[k] = count.get(k, 0) + 1
        if count:
            out[role] = max(count, key=count.get)
    return out


def _common_dir(paths):
    parts = [p.split("/")[:-1] for p in paths]
    head = parts[0] if parts else []
    for p in parts[1:]:
        n = 0
        while n < min(len(head), len(p)) and head[n] == p[n]:
            n += 1
        head = head[:n]
    return "/".join(head) + "/" if head else ""


def _runs(paths):
    """{path: run} for files of the same name in two or more sibling folders, such as runs/<run>/board.jsonl, each
    folder a run of its own; other files are in no run."""
    folders = {}
    for p in paths:
        d, _, name = p.rpartition("/")
        if d:
            folders.setdefault((d.rpartition("/")[0], name), set()).add(d)
    return {p: p.rpartition("/")[0].rpartition("/")[2] for p in paths
            if len(folders.get((p.rpartition("/")[0].rpartition("/")[0], p.rpartition("/")[2]), ())) > 1}


def build_index(paths):
    """{files: {path: {offsets, kind, fields, n, skipped, repeats, goals, names, left?, why?, run}}, recs: {ref: action}, order: [action refs in event order], same:
    {ref of a repeat: ref of the first}, places: {place: {ref, title, refs, accounts, addressed, run}}, accounts:
    {account: {n, goal, goal_refs}}, runs: {run: n}, problems: {count, examples: [{ref, why}]}}. An action keeps its
    account, place, time, kind, run, the save before it, the record it replies to and whether it addresses another
    account (_addressing); texts are read back from their lines when shown. A place a field names is named with its run
    ("<run>/<place>") when the files are in runs (_runs), since each run numbers its threads anew."""
    problems = {"count": 0, "examples": []}
    files, recs, same, actions, places, roster, texts, titles = {}, {}, {}, [], {}, {}, {}, {}
    parsed = {p: _rows(p, problems) for p in sorted(paths)}
    fields = {p: _fields(rows) for p, rows in parsed.items()}
    placeless = [p for p, f in fields.items() if ("actor" in f or "anon" in f) and "text" in f and "place" not in f]
    base = _common_dir(placeless) if len(placeless) > 1 else ""
    run_of = _runs([p for p, f in fields.items() if ("actor" in f or "anon" in f) and "text" in f and "place" in f])
    for path, rows in parsed.items():
        f = fields[path]
        run = run_of.get(path)
        own_place = path[len(base):].rsplit(".", 1)[0] if path in placeless else None
        kind = ("actions" if ("actor" in f or "anon" in f) and "text" in f
                else "roster" if "actor" in f and "goal" in f else "other")
        files[path] = {"offsets": _offsets(path), "kind": kind, "fields": f, "n": 0, "skipped": 0, "repeats": 0,
                       "goals": 0, "names": 0, "run": run, "header": _csv_header(path) if path.endswith(".csv") else None}
        seen, last, names_places = {}, None, False
        for first, end, rec in rows:
            ref = f"{path}#L{first}"
            if kind == "roster":
                _k, who = _first(rec, (f["actor"],))
                _g, goal = _first(rec, GOAL_KEYS)
                if who:
                    roster[who.lower()] = {"goal": goal, "refs": [f"{path}#L{n}" for n in range(first, end + 1)]}
                    files[path]["goals"] += 1
                continue
            if kind == "other":
                _p, place = _first(rec, PLACE_KEYS)
                _t, title = _first(rec, ("title",))
                if place and title:
                    places.setdefault(place, {"ref": ref, "title": title, "refs": [], "accounts": {}})
                    names_places = True
                    files[path]["names"] += 1
                continue
            _a, who = _first(rec, ACTOR_KEYS)
            if not who:
                _a, who = _first(rec, ANON_KEYS)
            if not isinstance(rec.get(f["text"]), str):
                other = next((k for k in TEXT_KEYS if k in rec), None)
                if other is not None:  # a record with no text field, such as a join notice, is not an action
                    _problem(problems, ref, f"left out: its text is under `{other}`, not `{f['text']}`" if other != f["text"]
                             else f"left out: its `{other}` is not text")
                files[path]["skipped"] += 1
                continue
            if not who:
                _problem(problems, ref, "left out: no account")
                files[path]["skipped"] += 1
                continue
            _p, place = _first(rec, PLACE_KEYS)
            place = (f"{run}/{place}" if run else place) if place else own_place or path
            rid = _first(rec, (f["id"],))[1] if "id" in f else ""
            seq = _first(rec, (f["seq"],))[1] if "seq" in f else ""
            key = ("id", rid) if rid else ("seq", place, seq) if seq else None
            if key is not None:
                if key in seen:
                    same[ref] = seen[key]
                    files[path]["repeats"] += 1
                    continue
                seen[key] = ref
            _k, when = _first(rec, TIME_KEYS)
            t = _time(when)
            known = t is not None
            if when and not known:
                _problem(problems, ref, f"time {when[:40]!r} not read; shown as unknown")
            t = t if known else (last + 1e-3 if last is not None else 0.0)
            last = t
            r = {"ref": ref, "account": who, "place": place, "t": t, "known": known, "kind": "save" if seq else "post",
                 "run": run, "id": rid, "reply": _first(rec, REPLY_KEYS)[1], "before": None, "reply_ref": None}
            recs[ref] = r
            texts[ref] = rec[f["text"]]
            titles[ref] = _first(rec, TITLE_KEYS)[1]
            actions.append(r)
            files[path]["n"] += 1
        if kind == "other" and not names_places:
            files[path]["left"] = True
            files[path]["why"] = ("no records" if not rows else "no text field" if "actor" in f or "anon" in f
                                  else "no account field" if "text" in f else "no account or text field")
            if rows:
                _problem(problems, path, f"left out: no account and text fields ({', '.join(list(rows[0][2])[:6])})")
    actions.sort(key=lambda r: (r["t"], r["ref"]))
    last_save, by_id, accounts, runs = {}, {}, {}, {}
    for r in actions:
        if r["kind"] == "save":
            r["before"] = last_save.get(r["place"])
            last_save[r["place"]] = r["ref"]
        if r["reply"]:
            r["reply_ref"] = by_id.get((r["place"], r["reply"])) or by_id.get((None, r["reply"]))
        if r["id"]:
            by_id[(r["place"], r["id"])] = r["ref"]
            by_id.setdefault((None, r["id"]), r["ref"])
        del r["reply"]
        p = places.setdefault(r["place"], {"ref": r["ref"], "title": titles[r["ref"]] or r["place"], "refs": [], "accounts": {}})
        p["run"] = r["run"]
        p["refs"].append(r["ref"])
        if r["run"]:
            runs[r["run"]] = runs.get(r["run"], 0) + 1
        p["accounts"][r["account"]] = p["accounts"].get(r["account"], 0) + 1
        a = accounts.setdefault(r["account"], {"n": 0})
        a["n"] += 1
    for name, a in accounts.items():
        row = roster.get(name.lower()) or {}
        a["goal"], a["goal_refs"] = row.get("goal", ""), row.get("refs", [])
    _addressing(actions, recs, places, texts)
    return {"files": files, "recs": recs, "order": [r["ref"] for r in actions], "same": same,
            "places": {k: v for k, v in places.items() if v["refs"]}, "accounts": accounts, "runs": runs,
            "problems": problems}


def _addressing(actions, recs, places, texts):
    """Mark each action that addresses another account (`to`): it replies to another account's record, or what it
    wrote (a save's lines that the save before it on its place lacked) names, as the account is written, another
    account that acts on its place (`named`, those accounts); count them per place (`addressed`)."""
    who = {p: set(v["accounts"]) for p, v in places.items()}
    last = {}
    for r in actions:
        text = texts[r["ref"]]
        said = text
        if r["kind"] == "save":
            before = {_key(s) for s in last.get(r["place"], "").splitlines()}
            said = "\n".join(s for s in text.splitlines() if _key(s) not in before)
            last[r["place"]] = text
        others = who[r["place"]] - {r["account"]}
        reply = recs.get(r["reply_ref"]) if r["reply_ref"] else None
        r["named"] = sorted(others & {w.lstrip("@") for w in WORD.findall(said)})
        r["to"] = bool(reply and reply["account"] != r["account"]) or bool(r["named"])
        places[r["place"]]["addressed"] = places[r["place"]].get("addressed", 0) + r["to"]


# ------------------------------------------------------------------------------------------------ reading records back


def _raw(index, ref):
    path, _, n = ref.partition("#L")
    offs = index["files"].get(path, {}).get("offsets")
    if not offs or not n.isdigit() or not 1 <= int(n) <= len(offs):
        return None
    try:
        with open(path, "rb") as fh:
            fh.seek(offs[int(n) - 1])
            return fh.readline().decode("utf-8", "replace").rstrip("\r\n").lstrip("\ufeff")
    except OSError:
        return None


def _record(index, ref):
    """The record on the ref's line as a dict, or None; a CSV row read from its line's offset by the file's header."""
    path, _, n = ref.partition("#L")
    if path.endswith(".csv"):
        f = index["files"].get(path, {})
        header, offs = f.get("header"), f.get("offsets")
        if not header or not offs or not n.isdigit() or not 1 <= int(n) <= len(offs):
            return None
        try:
            with open(path, "rb") as fh:
                fh.seek(offs[int(n) - 1])
                cells = next(csv.reader(io.TextIOWrapper(fh, "utf-8", "replace", newline=""), strict=True))
        except (OSError, StopIteration, csv.Error):
            return None
        return {k: v.strip() for k, v in zip(header, cells)}
    raw = _raw(index, ref)
    try:
        rec = json.loads(raw) if raw is not None else None
    except ValueError:
        return None
    return rec if isinstance(rec, dict) else None


def _text(index, ref):
    rec = _record(index, ref) or {}
    v = rec.get(index["files"].get(ref.partition("#L")[0], {}).get("fields", {}).get("text", "text"))
    return v if isinstance(v, str) else ""


def _unmangle(m):
    """A run of Latin-1 characters read back as UTF-8 while it decodes; each pass shortens it, so the loop ends."""
    s = m.group(0)
    while True:
        try:
            t = s.encode("latin-1").decode("utf-8")
        except UnicodeError:
            return s
        if len(t) >= len(s):
            return s
        s = t


def _key(line):
    """A line as saves are compared by: its mojibake repaired and its spacing collapsed."""
    return " ".join(MOJIBAKE.sub(_unmangle, line).split())


def _clean(text):
    """Text to show: its mojibake repaired and control characters other than tab and newline dropped."""
    return CONTROL.sub("", MOJIBAKE.sub(_unmangle, text))


def _hunks(old, new):
    """[{at, add, del}]: where the new text differs from the old, line by line on each line's _key, `at` the first added
    line's number. The lines both texts start and end with are equal; when what lies between them is too large to diff
    (HUNK_PAIRS_MAX), it is one hunk of the lines each side has that the other lacks."""
    a, b = old.splitlines(), new.splitlines()
    ka, kb = [_key(x) for x in a], [_key(x) for x in b]
    lo = 0
    while lo < min(len(ka), len(kb)) and ka[lo] == kb[lo]:
        lo += 1
    hi = 0
    while hi < min(len(ka), len(kb)) - lo and ka[-1 - hi] == kb[-1 - hi]:
        hi += 1
    ia, ib = len(a) - hi, len(b) - hi
    if (ia - lo) * (ib - lo) > HUNK_PAIRS_MAX:
        old_keys, new_keys = set(ka[lo:ia]), set(kb[lo:ib])
        ops = [("replace", lo, ia, lo, ib)]

        def pick(i1, i2, j1, j2):
            return [b[j] for j in range(j1, j2) if kb[j] not in old_keys], [a[i] for i in range(i1, i2) if ka[i] not in new_keys]
    else:
        ops = [(op, i1 + lo, i2 + lo, j1 + lo, j2 + lo)
               for op, i1, i2, j1, j2 in difflib.SequenceMatcher(None, ka[lo:ia], kb[lo:ib], autojunk=False).get_opcodes()]

        def pick(i1, i2, j1, j2):
            return b[j1:j2], a[i1:i2]
    out, budget = [], HUNK_LINES
    for op, i1, i2, j1, j2 in ops:
        if op == "equal" or budget <= 0:
            continue
        add, rem = pick(i1, i2, j1, j2)
        add, rem = add[:budget], rem[:budget]
        budget -= len(add) + len(rem)
        if add or rem:
            out.append({"at": j1 + 1, "add": add, "del": rem})
    return out


def _cut(s, n=CARD_CHARS):
    s = " ".join(_clean(s).split())
    return s if len(s) <= n else s[: n - 1].rstrip(" ,;:") + "…"


def _swap(old, new):
    """'old words → new words' for one line changed into another, the words they share left out."""
    a, b = old.split(), new.split()
    ops = difflib.SequenceMatcher(None, a, b, autojunk=False).get_opcodes()
    gone = " ".join(w for op, i1, i2, _j1, _j2 in ops if op in ("replace", "delete") for w in a[i1:i2])
    came = " ".join(w for op, _i1, _i2, j1, j2 in ops if op in ("replace", "insert") for w in b[j1:j2])
    return f"{_cut(gone, 40)} → {_cut(came, 60)}" if gone and came else _cut(came or new)


def _did(index, r):
    """What the action did, as {line, said, before?, hunks?}: `line` its words in a listing, `said` the text it added or
    posted, whose last "-- name" is its signature and whose words name other accounts."""
    text = _text(index, r["ref"])
    if r["kind"] == "post":
        parts = SENTENCE.split(text.strip())
        head = parts[0] if len(parts[0]) > 12 or len(parts) == 1 else " ".join(parts[:2])
        return {"line": _cut(head), "said": text}
    if not r["before"]:
        return {"line": _gist([s for s in text.splitlines() if s.strip()]) or "Created the page", "said": text}
    hunks = _hunks(_text(index, r["before"]), text)
    added = [s for h in hunks for s in h["add"] if s.strip()]
    removed = [s for h in hunks for s in h["del"] if s.strip()]
    if [s.split() for s in added] == [s.split() for s in removed]:
        line = "Changed only spacing or encoding"
    elif len(added) == 1 and len(removed) == 1:
        line = _swap(removed[0], added[0])
    elif added:
        line = _gist(added)
    else:
        line = "Removed " + _cut(removed[0], CARD_CHARS - 8)
    return {"line": line, "said": "\n".join(added), "before": r["before"], "hunks": hunks}


def _gist(lines):
    """The words for the lines a save wrote: the last that ends in a signature, where a note ends, or the line above
    a signature on a line of its own; else the last."""
    if not lines:
        return ""
    i = next((i for i in range(len(lines) - 1, -1, -1) if SIGNATURE.search(lines[i].strip())), len(lines) - 1)
    if i > 0 and len(SIGNATURE.sub("", lines[i].strip())) < 12:
        i -= 1
    return _cut(lines[i]) + (f" (+{len(lines) - 1} lines)" if len(lines) > 1 else "")


def _signature(said):
    sig = None
    for s in said.splitlines():
        m = SIGNATURE.search(s.strip())
        if m:
            sig = m.group(1).strip()
    return sig


# ------------------------------------------------------------------------------------------------ links


def _reach(index, picked):
    """The links among the records `picked` (in event order), read from the index: replies, the accounts a record names
    (the latest record of that account before it) and the record before it on its place, as [(later ref, earlier ref,
    type)]."""
    recs = index["recs"]
    order = {ref: i for i, ref in enumerate(picked)}
    links, seen, last_by, last_on = [], set(), {}, {}

    def add(a, b, kind):
        if b is None or a == b or recs[a]["account"] == recs[b]["account"] or (a, b) in seen or (b, a) in seen:
            return
        later, earlier = (a, b) if order[a] > order[b] else (b, a)
        seen.add((later, earlier))
        links.append((later, earlier, kind))

    for ref in picked:
        r = recs[ref]
        if r["reply_ref"] in order:
            add(ref, r["reply_ref"], "reply")
        for who in r.get("named") or ():
            add(ref, last_by.get(who), "names")
        add(ref, last_on.get(r["place"]), "same place")
        last_by[r["account"]] = ref
        last_on[r["place"]] = ref
    return links


def _short(v):
    return json.dumps(v, ensure_ascii=False)[:FIELD_MAX] if isinstance(v, (dict, list)) else ("" if v is None else str(v))[:FIELD_MAX]


def _detail(index, ref):
    """One record in full: its fields, its text, what its save changed, and its account, place and signature."""
    ref = index["same"].get(ref, ref)
    rec = _record(index, ref)
    if rec is None:
        return {"ref": ref, "missing": True, "raw": (_raw(index, ref) or "")[:FIELD_MAX]}
    key = index["files"].get(ref.partition("#L")[0], {}).get("fields", {}).get("text")
    text = rec.get(key) if isinstance(rec.get(key), str) else ""
    out = {"ref": ref, "fields": [[k, _clean(_short(v))] for k, v in rec.items() if k != key], "text_key": key,
           "text": _clean(text[:TEXT_MAX]), "cut": len(text) > TEXT_MAX}
    r = index["recs"].get(ref)
    if r is not None:
        did = _did(index, r)
        out.update(account=r["account"], place=r["place"], sig=_signature(did["said"]))
        if did.get("before"):
            out.update(before=did["before"], hunks=[{**h, "add": [_clean(x) for x in h["add"]],
                                                     "del": [_clean(x) for x in h["del"]]} for h in did["hunks"]])
    return out


# ------------------------------------------------------------------------------------------------ records


def problems(index):
    """What the reader could not read or left out, as {count, examples: [{ref, why}]}, which thimble shows above the
    page."""
    return index["problems"]


def records(index, query):
    """{op: record, ref}: one record in full (_detail), which the card shows beside the chart; None for any other query."""
    query = query if isinstance(query, dict) else {}
    if query.get("op") == "record":
        return _detail(index, str(query.get("ref") or ""))
    return None


# ------------------------------------------------------------------------------------------------ citations


def _excerpt(lines):
    return "\n".join([s.strip()[:LINE_MAX] for s in lines if s.strip()][:EXCERPT_LINES])


def resolve(index, locator):
    """<file>#L<n>: the record on that line; a roster row names its account."""
    path, fragment = locator.get("path"), str(locator.get("fragment") or "")
    hit = re.fullmatch(r"L(\d+)", fragment)
    if not path or not hit or path not in index["files"]:
        return None
    asked = f"{path}#L{int(hit.group(1))}"
    ref = index["same"].get(asked, asked)
    cited = list(dict.fromkeys([ref, asked]))
    r = index["recs"].get(ref)
    if r is None:
        who = next((a for a, v in index["accounts"].items() if ref in v["goal_refs"]), None)
        if who:
            return {"excerpt": index["accounts"][who]["goal"] or who, "label": f"{who} · roster"[:40], "refs": [ref],
                    "key": None, "target": {"account": who, "ref": ref}}
        rec = _record(index, ref)
        if rec is None:
            return None
        words = next((v for v in sorted((v for v in rec.values() if isinstance(v, str)), key=len, reverse=True)), "")
        return {"excerpt": words[:LINE_MAX], "label": ref[-40:], "refs": [ref], "key": None, "target": {"ref": ref}}
    did = _did(index, r)
    lines = did["said"].splitlines() if did["said"].strip() else _text(index, ref).splitlines()
    when = datetime.fromtimestamp(r["t"], timezone.utc)
    label = f"{r['account']} · {MONTHS[when.month - 1]} {when.day} {when:%H:%M}" if r["known"] else r["account"]
    return {"excerpt": _excerpt(lines) or r["account"], "label": label[:40], "refs": cited, "key": None,
            "target": {"ref": ref, "account": r["account"], "place": r["place"]}}


# ------------------------------------------------------------------------------------------------ run as a script

SHARE_BYTES = 200_000  # about the output one share holds, which one agent reads whole

USAGE = f"""python reader.py [--in DIR] [--shares OUT | --share K/N | --place NAME ... [--from I] [--count M]]
                 [--files GLOB ...]

Reads the corpus folder DIR (by default the working folder). With no other option, the places the records are on,
busiest first, one line each: its rank, records, accounts and name; then how many shares of about {SHARE_BYTES // 1000} KB
the records make. --shares OUT also writes those N shares to the folder OUT, as share-1.txt to share-N.txt. --share K/N
prints the Kth of N shares: every record, busiest place first and each place in time order, cut at records into N
parts of about the same size, so a busy place runs over several shares. --place NAME prints that place's records (give
it again for more); --from I and --count M print records I to I+M-1 of each. A record is headed by its ref, time,
account and kind, then a post's text or the lines a save changed from the save before it, each whole: a line longer
than {LINE_MAX} characters goes on over the lines after it, indented deeper. A place's heading says which of its records
follow, and the last line how many records were printed. --files GLOB reads those files, a GLOB with no / in any
folder; by default every JSON Lines and CSV file under DIR. The listing with no option begins with each file and the
records it reads there, or why it reads none."""


def _script_files(globs):
    """The files `globs` name, a glob with no slash matching names in any folder as thimble's claims do, or every record
    file of the working folder."""
    import glob

    if not globs:
        found = []
        for root, dirs, names in os.walk("."):
            dirs[:] = sorted(d for d in dirs if not d.startswith("."))
            found += [os.path.relpath(os.path.join(root, n)) for n in names if n.endswith((".jsonl", ".csv"))]
        return sorted(found)
    return sorted({p for g in globs for p in glob.glob(g if "/" in g else f"**/{g}", recursive=True) if Path(p).is_file()})


def _line(prefix, text):
    """A line of a record as the script prints it, whole: after `prefix`, and past LINE_MAX characters on over the lines
    after it, indented two deeper, each broken at a space where one falls in its second half."""
    s, out = _clean(text), []
    while len(s) > LINE_MAX:
        cut = s.rfind(" ", LINE_MAX // 2, LINE_MAX)
        cut = cut if cut > 0 else LINE_MAX
        out.append(s[:cut])
        s = s[cut + 1 if s[cut] == " " else cut:]
    out.append(s)
    more = " " * (len(prefix) + 2)
    return "".join(f"{prefix if i == 0 else more}{x}\n" for i, x in enumerate(out))


def _block(index, ref):
    """One record as the script prints it: its head line, then a post's text or the lines its save changed."""
    r = index["recs"][ref]
    did = _did(index, r)
    head = f"{ref} {_iso(r['t']) if r['known'] else 'time unknown'} {r['account']} {r['kind']}"
    if r["reply_ref"]:
        head += f", reply to {r['reply_ref']}"
    out = [head + "\n"]
    if did.get("hunks") is not None:
        for h in did["hunks"]:
            out += [_line("  - ", x) for x in h["del"] if x.strip()]
            out += [_line("  + ", x) for x in h["add"] if x.strip()]
        if not did["hunks"]:
            out.append("  (no change)\n")
    else:
        out += [_line("  ", x) for x in did["said"].splitlines() if x.strip()]
    return "".join(out)


def _n(n, one, many=None):
    return f"{n:,} {one if n == 1 else many or one + 's'}"


def _file_line(f):
    """What the listing says of one file: the records it reads there, and those it leaves out, or why it reads none."""
    if f["kind"] == "actions":
        extra = [x for x in (f["skipped"] and f"{f['skipped']:,} left out", f["repeats"] and f"{f['repeats']:,} repeated") if x]
        return _n(f["n"], "record") + (f" ({', '.join(extra)})" if extra else "")
    if f["kind"] == "roster":
        return f"0 records (a roster, the goals of {_n(f['goals'], 'account')})"
    if not f.get("left"):
        return f"0 records (it names {_n(f['names'], 'place')})"
    return f"0 records ({f.get('why') or 'no account or text field'})"


def _heading(index, name, a, b):
    p = index["places"][name]
    n = len(p["refs"])
    title = f" · {_cut(p['title'], 80)}" if p["title"] != name else ""
    which = (_n(n, "record") if a == 1 and b == n else f"record {a:,} of {n:,}" if a == b
             else f"records {a:,}–{b:,} of {n:,}")
    return f"## {name}{title}: {which} by {_n(len(p['accounts']), 'account')}\n"


def _blocks(index, places):
    """Every record of `places` in their order as (place, its record's number on the place, block, bytes it prints), a
    place's heading counted with its first record."""
    out = []
    for p in places:
        refs = index["places"][p]["refs"]
        for i, ref in enumerate(refs, 1):
            text = _block(index, ref)
            size = len(text.encode()) + (len(_heading(index, p, 1, len(refs)).encode()) + 1 if i == 1 else 0)
            out.append((p, i, text, size))
    return out


def _print(index, picked, out):
    """The records `picked` (_blocks), a heading before each run of one place's records."""
    runs = []
    for name, i, text, _size in picked:
        if runs and runs[-1][0] == name and runs[-1][2] == i - 1:
            runs[-1][2] = i
            runs[-1][3].append(text)
        else:
            runs.append([name, i, i, [text]])
    for name, a, b, texts in runs:
        out.write(_heading(index, name, a, b))
        out.writelines(texts)
        out.write("\n")
    out.write(f"-- {_n(len(picked), 'record')} printed\n")


def _shares(blocks):
    """How many shares of about SHARE_BYTES the blocks make, with room for the headings of places cut between two."""
    return max(1, -(-sum(b[3] for b in blocks) * 20 // (SHARE_BYTES * 19)))


def _share(blocks, k, n):
    """The Kth of N shares of `blocks`: cut at records into N parts of about the same size, a record going to the part
    its first byte falls in."""
    total = sum(b[3] for b in blocks) or 1
    at, picked = 0, []
    for b in blocks:
        if (k - 1) * total <= at * n < k * total:
            picked.append(b)
        at += b[3]
    return picked


def _write_shares(index, blocks, n, into):
    """The N shares of `blocks` written to the folder `into` as share-1.txt to share-N.txt, in place of any it held."""
    os.makedirs(into, exist_ok=True)
    for old in Path(into).glob("share-*.txt"):
        old.unlink()
    for k in range(1, n + 1):
        with open(os.path.join(into, f"share-{k}.txt"), "w", encoding="utf-8") as f:
            _print(index, _share(blocks, k, n), f)


def main(argv):
    share, into, names, globs, first, count, i = None, None, [], [], 1, None, 0
    start = os.getcwd()
    while i < len(argv):
        arg = argv[i]
        if arg in ("-h", "--help"):
            print(USAGE)
            return 0
        if arg in ("--in", "--shares", "--share", "--place", "--files", "--from", "--count") and i + 1 < len(argv):
            v = argv[i + 1]
            if arg == "--in":
                os.chdir(v)
            elif arg == "--shares":
                into = os.path.join(start, v)
            elif arg == "--share":
                share = v
            elif arg == "--place":
                names.append(v)
            elif arg == "--files":
                globs.append(v)
            elif not v.isdigit() or int(v) < 1:
                sys.exit(f"reader.py: {arg} takes a whole number from 1, not {v!r}")
            elif arg == "--from":
                first = int(v)
            else:
                count = int(v)
            i += 2
            continue
        sys.exit(f"reader.py: {arg!r} is no option\n\n{USAGE}")
    if sum(map(bool, (into, share, names))) > 1:
        sys.exit("reader.py: give one of --shares, --share and --place")
    if (first != 1 or count is not None) and not names:
        sys.exit("reader.py: --from and --count go with --place")
    index = build_index(_script_files(globs))
    ranked = sorted(index["places"], key=lambda p: (-len(index["places"][p]["refs"]), p))
    out = sys.stdout
    if share:
        k, _, n = share.partition("/")
        if not (k.isdigit() and n.isdigit() and 1 <= int(k) <= int(n)):
            sys.exit(f"reader.py: --share takes K/N with 1 <= K <= N, not {share!r}")
        _print(index, _share(_blocks(index, ranked), int(k), int(n)), out)
        return 0
    if not names:
        out.write("files:\n" + "".join(f"  {p}: {_file_line(f)}\n" for p, f in sorted(index["files"].items())))
        for rank, p in enumerate(ranked, 1):
            v = index["places"][p]
            out.write(f"{rank}\t{len(v['refs'])}\t{len(v['accounts'])}\t{p}\n")
        blocks = _blocks(index, ranked)
        n = _shares(blocks)
        if into:
            _write_shares(index, blocks, n, into)
        where = f"written to {into} as share-1.txt to share-{n}.txt" if into else f"--share 1/{n} to --share {n}/{n}"
        read = [p for p, f in index["files"].items() if f["n"]]
        out.write(f"{_n(len(index['order']), 'record')} from {read[0] if len(read) == 1 else _n(len(read), 'file')}, "
                  f"{sum(b[3] for b in blocks) // 1000:,} KB printed: {_n(n, 'share')} of about {SHARE_BYTES // 1000} KB, "
                  f"{where}\n")
        return 0
    missing = [p for p in names if p not in index["places"]]
    if missing:
        sys.exit(f"reader.py: no place {missing[0]!r}; run it with no option for the places")
    picked = []
    for p in names:
        refs = index["places"][p]["refs"]
        last = len(refs) if count is None else min(len(refs), first + count - 1)
        picked += [(p, j, _block(index, refs[j - 1]), 0) for j in range(first, last + 1)]
    _print(index, picked, out)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
