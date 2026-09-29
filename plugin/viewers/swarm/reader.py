# Swarm: many agents acting on shared pages and channels, drawn as a swimlane chart of the records a question picks.
# A row per account, columns in event order, and as cards the records the labels that are on give a highlighted value,
# coloured by value, with the links the records themselves carry. A question typed in the page goes to the analyst's
# Claude Code session, which answers it by making labels over these records; the chart then draws them.
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
#     thimble shows above the page. A quoted CSV cell over several lines is one row, citing every line.
#   - A repeated record (the same id, or the same sequence on one place, in one file: a replayed save, a post delivered
#     twice) is left out, and a citation of it opens the first.
#   - Records are put in time order across files; a record with no time keeps its place after the line before it in its
#     file and shows as having none.
#   - A roster names an account with other capitals than its actions do: accounts are matched without case.
#   - A save that changes only spacing, or only re-encodes lines, changes nothing, and says so: saves are compared line
#     by line on each line with its mojibake repaired (runs of Latin-1 characters that read as UTF-8, such as "Ã©" for
#     "é", as a wiki that re-encodes its pages on each save grows them) and its spacing collapsed (_key).
#   - Text shown on a card or beside the chart has its mojibake repaired and control characters dropped (_clean); the
#     excerpts that cite the records stay as written.
#
# The method: the index keeps, per record, only what finding and ordering it needs (its offset, account, place, time,
# the save before it, the record it replies to), so a corpus of many thousand saves indexes in seconds; a card's text,
# what its save changed, the name it signs with and the accounts it names are read back from its line when it is shown.
#
# The chart: the cards are the records the labels that are on give a highlighted value (thimble.marked), kept by the
# label filter (thimble.kept), of the values the page's legend keeps (`only`, all when none), CARDS_MAX at a time in
# event order, each page taking the values in turn so the first shows them all. With no label on they are the actions
# that address another account (a reply to another account's record, or what it wrote naming another account that acts
# on its place) on the PLACES_SHOWN places where they are most and most of what is done (their count times their
# share). Links between cards come from the records:
#   reply       the card's record answers the other card's record (its reply field)
#   names       the card's text names the other card's account (the latest card of that account before it)
#   same place  the card before it on its place, by another account
# A pair keeps one link, the first of these that holds. A card signs as someone when a line of its text ends with
# "-- name" (or an em dash); the page can group its rows by that name instead of the account.
#
# Labels: the cards are what they mark, so a label that is on is the chart's subject and colour: each card carries the
# marks thimble.marked gives its record (the first as `m`, all of them as bits in `mb`), which the page draws. A row's
# unit is `agent/<account>` and a place's `place/<place>`, whose refs are their records.
#
# When it applies (view.json `applies`): thimble proposes this view to an orientation when applies(paths), given the
# corpus's record files, finds a swarm in them, and claims the files it names (applies).
import csv
import difflib
import io
import json
import re
from datetime import datetime, timezone
from pathlib import Path

import thimble

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
CARDS_MAX = 40
DETECT_FILES = 400  # record files applies() reads, the shallowest first
DETECT_RECORDS = 20_000  # records it reads of each
DETECT_BYTES = 64 * 1024 * 1024  # bytes it reads of each
DETECT_BYTES_ALL = 256 * 1024 * 1024  # bytes it reads of them all; the files after are left unread
SWARM_ACCOUNTS = 30  # a swarm's accounts at least
SWARM_PLACES = 3  # places that three or more of them act on, at least
SWARM_NAMING = 0.05  # the share of the actions on shared places that name another account acting there, at least
CLAIMS_LISTED = 12  # the action files of one folder claimed one by one; more are claimed by a glob
PLACES_SHOWN = 3
MARKS_MAX = 24  # label values the page tells apart, as bits of one number per card
CARD_CHARS = 110
TEXT_MAX = 60_000  # characters of a record's text the page gets
FIELD_MAX = 300
HUNK_LINES = 400
HUNK_PAIRS_MAX = 4_000_000  # line pairs a save's diff compares at most; past it the lines are compared as sets
EXCERPT_LINES = 12
LINE_MAX = 400
REFS_MAX = 200
SIGNATURE = re.compile(r"(?:—|--)\s*([A-Za-z][\w.'-]*(?: [\w.'-]+){0,3})\s*$")
WORD = re.compile(r"@?[A-Za-z][\w.-]*\w")
SENTENCE = re.compile(r"(?<=[.?!])\s+")
MOJIBAKE = re.compile(r"[\u0080-\u00ff]{2,}")
CONTROL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f-\x9f]")
MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def _first(rec, keys):
    """(the first of `keys` the record holds a value under, the value as text), or (None, "")."""
    for k in keys:
        v = rec.get(k)
        if v is not None and not isinstance(v, (dict, list)) and str(v).strip():
            return k, str(v).strip()
    return None, ""


def _time(v):
    """Epoch seconds of epoch seconds or milliseconds, or of ISO 8601 with or without a zone (UTC then); None."""
    if isinstance(v, bool) or v in (None, ""):
        return None
    if isinstance(v, (int, float)):
        return v / 1000 if v > 1e11 else float(v)
    s = str(v).strip()
    if re.fullmatch(r"\d{9,13}(\.\d+)?", s):
        return _time(float(s))
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None
    return (dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)).timestamp()


def _iso(t):
    return datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _problem(problems, ref, why):
    problems.append({"ref": ref, "why": why})


# ------------------------------------------------------------------------------------------------ the index


def _rows(path, problems):
    """[(first line, last line, record dict)] of a file: the JSON objects of a JSON Lines file, a CSV's rows by its
    header."""
    raw = Path(path).read_bytes()
    out = []
    if path.endswith(".csv"):
        text = raw.decode("utf-8", "replace")
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
            out.append((first, last, {k: v.strip() for k, v in zip(header, cells)}))
        return out
    for n, line in enumerate(raw.split(b"\n"), 1):
        if not line.strip():
            continue
        try:
            rec = json.loads(line.decode("utf-8", "replace"))
        except ValueError:
            rec = None
        if not isinstance(rec, dict):
            _problem(problems, f"{path}#L{n}", "not a JSON object")
            continue
        out.append((n, n, rec))
    return out


def _offsets(path):
    offs, pos = [], 0
    with open(path, "rb") as fh:
        for raw in fh:
            offs.append(pos)
            pos += len(raw)
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


def build_index(paths):
    """{files: {path: {offsets, kind, fields, n}}, recs: {ref: action}, order: [action refs in event order], same:
    {ref of a repeat: ref of the first}, places: {place: {ref, title, refs, accounts, addressed}}, accounts: {account:
    {n, goal, goal_refs}}, problems: [{ref, why}]}. An action keeps its account, place, time, kind, the save before
    it, the record it replies to and whether it addresses another account (_addressing); texts are read back from their
    lines when shown."""
    problems = []
    files, recs, same, actions, places, roster, texts, titles = {}, {}, {}, [], {}, {}, {}, {}
    parsed = {p: _rows(p, problems) for p in sorted(paths)}
    fields = {p: _fields(rows) for p, rows in parsed.items()}
    placeless = [p for p, f in fields.items() if ("actor" in f or "anon" in f) and "text" in f and "place" not in f]
    base = _common_dir(placeless) if len(placeless) > 1 else ""
    for path, rows in parsed.items():
        f = fields[path]
        own_place = path[len(base):].rsplit(".", 1)[0] if path in placeless else None
        kind = ("actions" if ("actor" in f or "anon" in f) and "text" in f
                else "roster" if "actor" in f and "goal" in f else "other")
        files[path] = {"offsets": _offsets(path), "kind": kind, "fields": f, "n": 0}
        seen, last = {}, None
        for first, end, rec in rows:
            ref = f"{path}#L{first}"
            if kind == "roster":
                _k, who = _first(rec, (f["actor"],))
                _g, goal = _first(rec, GOAL_KEYS)
                if who:
                    roster[who.lower()] = {"goal": goal, "refs": [f"{path}#L{n}" for n in range(first, end + 1)]}
                continue
            if kind == "other":
                _p, place = _first(rec, PLACE_KEYS)
                _t, title = _first(rec, ("title",))
                if place and title:
                    places.setdefault(place, {"ref": ref, "title": title, "refs": [], "accounts": {}})
                continue
            _a, who = _first(rec, ACTOR_KEYS)
            if not who:
                _a, who = _first(rec, ANON_KEYS)
            if not who or not isinstance(rec.get(f["text"]), str):
                continue
            _p, place = _first(rec, PLACE_KEYS)
            place = place or own_place or path
            rid = _first(rec, (f["id"],))[1] if "id" in f else ""
            seq = _first(rec, (f["seq"],))[1] if "seq" in f else ""
            key = ("id", rid) if rid else ("seq", place, seq) if seq else None
            if key is not None:
                if key in seen:
                    same[ref] = seen[key]
                    continue
                seen[key] = ref
            t = _time(_first(rec, TIME_KEYS)[1])
            known = t is not None
            t = t if known else (last + 1e-3 if last is not None else 0.0)
            last = t
            r = {"ref": ref, "account": who, "place": place, "t": t, "known": known, "kind": "save" if seq else "post",
                 "id": rid, "reply": _first(rec, REPLY_KEYS)[1], "before": None, "reply_ref": None}
            recs[ref] = r
            texts[ref] = rec[f["text"]]
            titles[ref] = _first(rec, TITLE_KEYS)[1]
            actions.append(r)
            files[path]["n"] += 1
    actions.sort(key=lambda r: (r["t"], r["ref"]))
    last_save, by_id, accounts = {}, {}, {}
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
        p["refs"].append(r["ref"])
        p["accounts"][r["account"]] = p["accounts"].get(r["account"], 0) + 1
        a = accounts.setdefault(r["account"], {"n": 0})
        a["n"] += 1
    for name, a in accounts.items():
        row = roster.get(name.lower()) or {}
        a["goal"], a["goal_refs"] = row.get("goal", ""), row.get("refs", [])
    _addressing(actions, recs, places, texts)
    return {"files": files, "recs": recs, "order": [r["ref"] for r in actions], "same": same,
            "places": {k: v for k, v in places.items() if v["refs"]}, "accounts": accounts, "problems": problems}


# ------------------------------------------------------------------------------------------------ when the view applies


def _lines(fh, budget):
    """The lines of a file open in binary while `budget[0]` bytes last, which it spends."""
    while budget[0] > 0:
        line = fh.readline(budget[0])
        if not line:
            return
        budget[0] -= len(line)
        yield line


def _head(path, most, budget):
    """The first `most` records of a JSON Lines file or a CSV as {field: value} dicts, read while `budget[0]` bytes last
    and DETECT_BYTES at most, which it spends. A file that cannot be read has none."""
    own = [min(budget[0], DETECT_BYTES)]
    out = []
    try:
        with open(path, "rb") as fh:
            lines = _lines(fh, own)
            if path.endswith(".csv"):
                header = None
                for cells in csv.reader(ln.decode("utf-8", "replace").lstrip("\ufeff") for ln in lines):
                    if len(out) >= most:
                        break
                    if not any(c.strip() for c in cells):
                        continue
                    if header is None:
                        header = [c.strip().lower() for c in cells]
                    else:
                        out.append({k: v.strip() for k, v in zip(header, cells)})
            else:
                for line in lines:
                    if len(out) >= most:
                        break
                    try:
                        rec = json.loads(line.decode("utf-8", "replace").lstrip("\ufeff"))
                    except ValueError:
                        continue
                    if isinstance(rec, dict):
                        out.append(rec)
    except (OSError, csv.Error):
        pass
    budget[0] -= min(budget[0], DETECT_BYTES) - own[0]
    return out


def applies(paths):
    """{claims, found} when the record files among `paths` record a swarm, else None: actions (as build_index reads
    them) by SWARM_ACCOUNTS accounts or more, SWARM_PLACES places or more that three or more of them act on, and
    SWARM_NAMING of the actions on shared places naming another account that acts there. `claims` are the files that
    hold the actions, `found` says what was found. It reads DETECT_RECORDS of each of the first DETECT_FILES record
    files, the shallowest first, while DETECT_BYTES_ALL last."""
    files = sorted((p for p in paths if p.endswith((".jsonl", ".csv"))), key=lambda p: (p.count("/"), p))[:DETECT_FILES]
    acts, budget = {}, [DETECT_BYTES_ALL]
    for path in files:
        if budget[0] <= 0:
            break
        recs = _head(path, DETECT_RECORDS, budget)
        f = _fields([(0, 0, rec) for rec in recs])
        if not (("actor" in f or "anon" in f) and "text" in f):
            continue
        got = []
        for rec in recs:
            who = _first(rec, ACTOR_KEYS)[1] or _first(rec, ANON_KEYS)[1]
            if who and isinstance(rec.get(f["text"]), str):
                got.append((who, _first(rec, PLACE_KEYS)[1], rec[f["text"]]))
        if got:
            acts[path] = got
    placeless = [p for p, got in acts.items() if not any(place for _w, place, _t in got)]
    base = _common_dir(placeless) if len(placeless) > 1 else ""
    places = {}
    for path, got in acts.items():
        for who, place, _t in got:
            places.setdefault(place or path[len(base):], set()).add(who.lower())
    on_shared = naming = 0
    for path, got in acts.items():
        for who, place, text in got:
            others = places[place or path[len(base):]] - {who.lower()}
            if others:
                on_shared += 1
                naming += bool(others & {w.lstrip("@").lower() for w in WORD.findall(text)})
    accounts = set().union(*places.values()) if places else set()
    shared = sum(len(who) >= 3 for who in places.values())
    share = naming / on_shared if on_shared else 0.0
    if len(accounts) < SWARM_ACCOUNTS or shared < SWARM_PLACES or share < SWARM_NAMING:
        return None
    return {"claims": _claims(list(acts)),
            "found": f"{len(accounts):,} accounts act on {shared:,} places that three or more of them share, and "
                     f"{share:.0%} of what they write there names another account acting on the place."}


def _claims(paths):
    """The files as claims: each one, or a folder's files by one glob when it holds more than CLAIMS_LISTED."""
    by_dir = {}
    for p in paths:
        by_dir.setdefault(p.rpartition("/")[0], []).append(p)
    out = []
    for d, ps in sorted(by_dir.items()):
        if len(ps) <= CLAIMS_LISTED:
            out += sorted(ps)
        else:
            out += sorted({f"{d + '/' if d else ''}*.{p.rsplit('.', 1)[-1]}" for p in ps})
    return out


def _addressing(actions, recs, places, texts):
    """Mark each action that addresses another account (`to`): it replies to another account's record, or what it
    wrote (a save's lines that the save before it on its place lacked) names, as the account is written, another
    account that acts on its place; count them per place (`addressed`)."""
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
        r["to"] = bool(reply and reply["account"] != r["account"]) or bool(others & {w.lstrip("@") for w in WORD.findall(said)})
        places[r["place"]]["addressed"] = places[r["place"]].get("addressed", 0) + r["to"]


# ------------------------------------------------------------------------------------------------ reading records back


def _raw(index, ref):
    path, _, n = ref.partition("#L")
    offs = index["files"].get(path, {}).get("offsets")
    if not offs or not n.isdigit() or not 1 <= int(n) <= len(offs):
        return None
    with open(path, "rb") as fh:
        fh.seek(offs[int(n) - 1])
        return fh.readline().decode("utf-8", "replace").rstrip("\r\n")


def _record(index, ref):
    """The record on the ref's line as a dict, or None."""
    path, _, n = ref.partition("#L")
    if path.endswith(".csv") and n.isdigit():
        return next((rec for a, _b, rec in _rows(path, []) if a == int(n)), None)
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
    """What the action did, as {line, said, before?, hunks?}: `line` the card's words, `said` the text it added or
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
    """A card's words for the lines a save wrote: the last that ends in a signature, where a note ends, or the line above
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


# ------------------------------------------------------------------------------------------------ the chart


def _chart(index, query):
    on = thimble.view_labels()
    marks = [{"label": lab["name"], "value": v["name"], "colour": v["colour"]}
             for lab in on["labels"] for v in lab["values"]][:MARKS_MAX]
    mark_at = {(x["label"], x["value"]): i for i, x in enumerate(marks)}
    keep = {str(r) for r in query.get("keep") or ()}

    def kept(ref):
        return ref in keep or thimble.kept(ref)

    per_mark = [0] * len(marks)
    if marks:
        source = "labels"
        picked = [(ref, got) for ref in index["order"] if ((got := thimble.marked(ref)) or ref in keep) and kept(ref)]
        for _ref, got in picked:
            for i in {mark_at[k] for x in got if (k := (x["label"], x["value"])) in mark_at}:
                per_mark[i] += 1
        only = {(x.get("label"), x.get("value")) for x in query.get("only") or () if isinstance(x, dict)}
        if only:
            picked = [(ref, got) for ref, got in picked if ref in keep or any((x["label"], x["value"]) in only for x in got)]
        picked = _by_turns(picked, mark_at)
    else:
        ranked = sorted(index["places"], key=lambda p: (-(v := index["places"][p])["addressed"] ** 2 / len(v["refs"]),
                                                        -len(v["accounts"]), p))
        source, wanted = "addressed", set(ranked[:PLACES_SHOWN])
        picked = [(ref, []) for ref in index["order"]
                  if (r := index["recs"][ref])["place"] in wanted and (r["to"] or ref in keep) and kept(ref)]
    offset = max(0, min(int(query.get("offset") or 0), max(0, len(picked) - 1)))
    cards, by_ref, said = [], {}, {}
    for n, (ref, got) in enumerate(picked[offset: offset + CARDS_MAX], offset + 1):
        r = index["recs"][ref]
        did = _did(index, r)
        first, bits = -1, 0
        for x in got:
            i = mark_at.get((x["label"], x["value"]))
            if i is not None:
                first = i if first < 0 else first
                bits |= 1 << i
        c = {"id": n, "ref": ref, "account": r["account"], "sig": _signature(did["said"]), "place": r["place"],
             "time": _iso(r["t"]) if r["known"] else None, "kind": r["kind"], "line": did["line"], "m": first, "mb": bits}
        said[n] = did["said"]
        cards.append(c)
        by_ref[ref] = c
    links = _links(index, cards, by_ref, said)
    tags = {}
    for c in cards:
        c["tag"] = tags.setdefault(c["place"], f"T{len(tags) + 1}")
    rows = [{"account": a, "goal": index["accounts"][a]["goal"], "n": index["accounts"][a]["n"]}
            for a in dict.fromkeys(c["account"] for c in cards)]
    places = [{"tag": t, "name": p, "title": index["places"][p]["title"], "ref": index["places"][p]["ref"],
               "n": len(index["places"][p]["refs"]), "accounts": len(index["places"][p]["accounts"])}
              for p, t in tags.items()]
    title = ("; ".join(lab["name"] for lab in on["labels"]) if source == "labels"
             else "Where accounts most answer or name each other")
    return {"title": title, "source": source, "cards": cards, "rows": rows, "places": places, "links": links,
            "marks": marks, "mark_counts": per_mark, "offset": offset, "total": len(picked), "page": CARDS_MAX,
            "counts": {"records": len(index["order"]), "accounts": len(index["accounts"]), "places": len(index["places"])}}


def _by_turns(picked, mark_at):
    """The cards in pages of CARDS_MAX that take the values in turn, so the first page shows each value; a page keeps event
    order."""
    if len(picked) <= CARDS_MAX:
        return picked
    seen, turn = {}, []
    for ref, got in picked:
        v = min((mark_at[k] for x in got if (k := (x["label"], x["value"])) in mark_at), default=-1)
        seen[v] = seen.get(v, -1) + 1
        turn.append(seen[v])
    order = sorted(range(len(picked)), key=lambda i: (turn[i], i))
    return [picked[i] for p in range(0, len(order), CARDS_MAX) for i in sorted(order[p: p + CARDS_MAX])]


def _links(index, cards, by_ref, said):
    """The links between the cards (the chart note above): [{from, to, key, type, reason}], the later card first."""
    out, seen, last_on, last_by = [], set(), {}, {}
    names = {c["account"].lower(): c["account"] for c in cards if not re.fullmatch(r"[\d.:]+", c["account"])}

    def add(a, b, kind, reason):
        if b is None or b["account"] == a["account"] or (a["id"], b["id"]) in seen:
            return
        seen.add((a["id"], b["id"]))
        out.append({"from": a["id"], "to": b["id"], "key": f"{a['id']}-{b['id']}", "type": kind, "reason": reason})

    for c in cards:
        reply = index["recs"][c["ref"]]["reply_ref"]
        if reply in by_ref:
            add(c, by_ref[reply], "reply", f"Replies to {by_ref[reply]['account']}")
        for w in dict.fromkeys(WORD.findall(said[c["id"]])):
            who = names.get(w.lstrip("@").lower())
            if who in last_by:
                add(c, last_by[who], "names", f"Names {who}")
        b = last_on.get(c["place"])
        if b is not None:
            add(c, b, "same place", f"{'Edits' if c['kind'] == 'save' else 'Posts in'} {c['place']} after {b['account']}")
        last_on[c["place"]] = c
        last_by[c["account"]] = c
    return out


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


def problems(index):
    """The lines that do not parse, each {ref, why}, which thimble shows above the page."""
    return index["problems"]


def records(index, query):
    """{op: chart, offset?, keep?, only?}: the chart (_chart), the records whose refs are in `keep` shown whatever the
    labels and the filter keep, and only the records of the label values in `only` [{label, value}] when it is given.
    {op: record, ref}: one record in full (_detail)."""
    query = query if isinstance(query, dict) else {}
    if query.get("op") == "record":
        return _detail(index, str(query.get("ref") or ""))
    return _chart(index, query)


# ------------------------------------------------------------------------------------------------ citations


def _excerpt(lines):
    return "\n".join([s.strip()[:LINE_MAX] for s in lines if s.strip()][:EXCERPT_LINES])


def _first_lines(index, refs, per=2):
    return [s for ref in refs[:6] for s in [x for x in _text(index, ref).splitlines() if x.strip()][:per]]


def resolve(index, locator):
    """<file>#L<n>: the record on that line, on its card when the chart shows it, else beside the chart; a roster row
    opens its account. view:<slug>/agent/<account> or place/<place>: that account's or that place's records."""
    if "key" in locator:
        kind, _, name = str(locator["key"]).partition("/")
        name = name.replace("%20", " ")
        if kind == "agent":
            hit = next((a for a in index["accounts"] if a.lower() == name.lower()), None)
            if hit is None:
                return None
            a = index["accounts"][hit]
            refs = [r for r in index["order"] if index["recs"][r]["account"] == hit][:REFS_MAX]
            return {"excerpt": _excerpt(([a["goal"]] if a["goal"] else []) + _first_lines(index, refs)),
                    "label": f"{hit} · {a['n']} record{'s' * (a['n'] != 1)}"[:40], "refs": (a["goal_refs"] + refs)[:REFS_MAX],
                    "key": f"agent/{hit}", "target": {"account": hit}}
        p = index["places"].get(name) if kind == "place" else None
        if p is None:
            return None
        return {"excerpt": _excerpt(_first_lines(index, p["refs"])), "label": f"{name} · {len(p['refs'])} records"[:40],
                "refs": p["refs"][:REFS_MAX], "key": f"place/{name.replace(' ', '%20')}", "target": {"place": name}}
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
                    "key": f"agent/{who}", "target": {"account": who, "ref": ref}}
        rec = _record(index, ref)
        if rec is None:
            return None
        words = next((v for v in sorted((v for v in rec.values() if isinstance(v, str)), key=len, reverse=True)), "")
        return {"excerpt": words[:LINE_MAX], "label": ref[-40:], "refs": [ref], "key": None, "target": {"ref": ref}}
    did = _did(index, r)
    lines = did["said"].splitlines() if did["said"].strip() else _text(index, ref).splitlines()
    when = datetime.fromtimestamp(r["t"], timezone.utc)
    label = f"{r['account']} · {when.day} {MONTHS[when.month - 1]} {when:%H:%M}" if r["known"] else r["account"]
    return {"excerpt": _excerpt(lines) or r["account"], "label": label[:40], "refs": cited,
            "key": f"place/{r['place'].replace(' ', '%20')}", "target": {"ref": ref, "account": r["account"], "place": r["place"]}}
