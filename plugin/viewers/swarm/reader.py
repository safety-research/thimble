# Swarm: many agents acting on shared pages and channels, drawn as a swimlane map of who changed what, where, and in
# answer to whom.
#
# The data: one night of a survey team's shared wiki and chat, and its roster. The files and their fields:
#   roster.csv              the team: `account`, `objective` (the agent's brief, empty for some) and `joined` (a date)
#   wiki/index.jsonl        the wiki's pages: `slug` (the page's path), `title`, `created` and `by`
#   wiki/pages/<slug>.jsonl one page's history, a save per line: `rev`, `user` (or `ip` for a save without an account),
#                           `ts`, `summary` (the edit summary) and `text`, the whole page as that save left it. A page
#                           holds prose and `key: value` lines, such as `gain: 1.84 e-/ADU` or `22:00: Bramblewick (F3)`
#   chat/<channel>.jsonl    one channel, a line per post: `id`, `channel`, `user`, `ts`, `text` and `reply_to` (the id
#                           of the post it answers); a line with `type` join is a join notice. night-ops.jsonl was
#                           written by a later exporter (`v` 2), which renamed channel, user, ts, text and reply_to to
#                           `room`, `author`, `sent` (epoch milliseconds), `body` and `parent`
#
# What the reader cleans:
#   - Times are ISO 8601 with Z or an offset, a date and time with a space and no zone (UTC), epoch seconds or epoch
#     milliseconds, and every time is read as UTC. A post saved without a time keeps its place after the line before it
#     in its file and shows as having no time.
#   - The wiki export replayed a save (a repeated rev in a page's file) and the chat delivered a post twice (a repeated
#     id in a channel): the repeat is left out, and a citation of it opens the first.
#   - A channel's lines are not all in time order, since a post can be logged late: records are put in time order.
#   - night-ops.jsonl ends in a line cut off when the export stopped. A line or row that does not parse is left out,
#     and the page says how many there are, with the first few (`problems`).
#   - The roster names one account with other capitals (Lamplighter for lamplighter), leaves some objectives empty,
#     writes one objective over two lines inside quotes (the row cites both lines), and misses an agent who acted.
#   - The index lists a page whose history is gone and misses the sandbox, whose thread is then defined by its first
#     save.
#   - A save by an address without an account is the agent named by that address.
#   - A save that changes only whitespace changes nothing.
#
# The method: every save is compared with the save before it on its page, as `key: value` lines, so a save is what it
# changed rather than the whole page, which other agents wrote. Walking all records in time order, the reader keeps who
# set each key's current value and who last set each value, a value being the first decimal number of a key's value
# (a constant or a measurement, which is what these agents pass between them), and draws links from a record back to
# the earlier ones it bears on:
#   contradicts  the save changes, clears or restores a key whose current value another agent set
#   reply        the post answers another agent's post (`reply_to`), or the post or save summary names an agent with @,
#                which links to that agent's latest record
#   support      the record repeats a value another agent set on another key or page
#   related      the post asks a question that names a value another agent set
# A pair of records keeps one link, the first of these that holds. An action is significant when it sets, changes or
# clears a value (a placeholder such as `open` is no value), asks a question, or has a link. A thread's measure of
# interaction is the links its records draw; the threads with any, up to MAX_THREADS of them, are on the chart, tagged
# T1, T2 and on in the order of their first action. The chart holds their significant actions, numbered from 1 in time
# order, the links between them and the agents who acted. An agent's goal is its roster objective, else "Unknown
# beyond" its first action, and the names it signs with (a closing "— name") are listed as its `signs_as`. The whole
# map is built with the index, in the shape {title, agents, threads, actions, links}, and each fetch narrows it.
#
# Labels: they apply when records are served, never in the index. An action is shown when thimble.kept holds for its
# record, a link when both its actions are shown and an agent when one of its actions is; a thread's and an agent's
# lists hold only kept records. The page greys its own colours while a label is on (`labels_on`), since thimble draws
# each label's bar on the cards.
import csv
import difflib
import json
import re
from datetime import datetime, timezone

import thimble

MAX_THREADS = 5
ACTION_MAX = 60  # characters of a card's line
QUOTE_MAX = 200
PROBLEMS_SHOWN = 5
PLACEHOLDERS = {"", "open", "free", "tbd", "pending", "-", "?", "none", "n/a"}
KV = re.compile(r"^(?P<k>[^=\s][^\n]{0,39}?):\s+(?P<v>\S.*)$")  # `key: value`, the key before the first ": "
NUMBER = re.compile(r"(?<![\w.])\d+\.\d+(?!\w|\.\d)")  # a decimal, a full stop after it allowed
MENTION = re.compile(r"@([\w.-]+[\w])")
SIGNATURE = re.compile(r"(?:—|--|~~)\s*([A-Za-z][\w .'-]{0,30}?)\s*$")
SENTENCE = re.compile(r"(?<=[.?!])\s+")
GERUND = {"Set": "setting", "Changed": "changing", "Cleared": "clearing", "Reverted": "reverting", "Asked": "asking",
          "Replied": "replying", "Posted": "posting", "Saved": "saving"}
CHAT_V2 = {"room": "channel", "author": "user", "sent": "ts", "body": "text", "parent": "reply_to"}


# ------------------------------------------------------------------------------------------------ reading the files


def _time(v):
    """Epoch seconds of epoch seconds or milliseconds, or of ISO 8601 with or without a zone (UTC then); None."""
    if isinstance(v, bool) or v in (None, ""):
        return None
    if isinstance(v, (int, float)):
        return v / 1000 if v > 1e11 else float(v)
    try:
        dt = datetime.fromisoformat(str(v).strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    return (dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)).timestamp()


def _iso(t):
    return None if t is None else datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _problem(problems, ref, why):
    problems["count"] += 1
    if len(problems["examples"]) < PROBLEMS_SHOWN:
        problems["examples"].append(f"{ref}: {why}")


def _lines(path):
    """[(byte offset, raw line)] of a file."""
    out, pos = [], 0
    with open(path, "rb") as f:
        for raw in f:
            out.append((pos, raw))
            pos += len(raw)
    return out


def _shape(path):
    if path.endswith("roster.csv"):
        return "roster"
    if path == "wiki/index.jsonl":
        return "index"
    if path.startswith("wiki/pages/") and path.endswith(".jsonl"):
        return "page"
    if path.startswith("chat/") and path.endswith(".jsonl"):
        return "chat"
    return None


def _json(raw):
    try:
        r = json.loads(raw.decode("utf-8", "replace"))
    except ValueError as e:
        raise ValueError("not a JSON object") from e
    if not isinstance(r, dict):
        raise ValueError("not a JSON object")
    return r


def _chat(r):
    """A chat line in either exporter's fields, as {id, channel, user, ts, text, reply_to, type}."""
    if r.get("v") == 2:
        r = {CHAT_V2.get(k, k): v for k, v in r.items()}
    return r


def _kv(text):
    """[(key, value, raw line)] of a page's `key: value` lines, and [raw line] of its other non-blank lines."""
    pairs, plain = [], []
    for raw in str(text or "").split("\n"):
        line = raw.strip()
        if not line:
            continue
        m = KV.match(line)
        if m and not line.startswith("="):
            pairs.append((m["k"].strip(), m["v"].strip(), raw))
        else:
            plain.append(raw)
    return pairs, plain


def _key_of(raw):
    """The key of a `key: value` line, None for another line."""
    m = KV.match(raw.strip())
    return m["k"].strip() if m and not raw.strip().startswith("=") else None


def _placeholder(v):
    return v is None or v.strip().lower() in PLACEHOLDERS


def _numbers(text):
    return NUMBER.findall(str(text or ""))


def _first_number(v):
    got = _numbers(v)
    return got[0] if got else None


def _sentences(text):
    return [s for s in SENTENCE.split(str(text or "").strip()) if s]


def _signature(text):
    m = SIGNATURE.search(str(text or ""))
    return m.group(1).strip() if m else None


def _fit(prefix, text, limit=ACTION_MAX):
    """prefix + '"text"', the text cut on a word to fit `limit` characters with an ellipsis."""
    room = limit - len(prefix) - 2
    if len(text) > room:
        cut = text[: room - 1]
        cut = cut[: cut.rfind(" ")] if " " in cut else cut
        text = cut.rstrip(" ,;:") + "…"
    return f'{prefix}"{text}"'


def build_index(paths):
    """{files: {path: {shape, offsets}}, recs: {ref: record}, order: [ref of each save and post in time order],
    same: {ref of a repeat: ref of its first line}, threads: {id: thread}, roster: {account in lower case: row},
    map: the chart, action_of: {ref: action id}, problems}. A record keeps its kind, place, agent, time and what the
    map needs (a save's changes and added lines, a post's reply and first sentences); texts are read back from their
    byte offsets when a page or a citation shows them."""
    files, recs, same, problems = {}, {}, {}, {"count": 0, "examples": []}
    roster, pages, events = {}, {}, []
    for path in sorted(paths):
        shape = _shape(path)
        if shape is None:
            continue
        lines = _lines(path)
        files[path] = {"shape": shape, "offsets": [pos for pos, _ in lines]}
        if shape == "roster":
            _read_roster(path, lines, recs, roster, problems)
            continue
        seen, last = {}, None
        slug = path[len("wiki/pages/"):-len(".jsonl")] if shape == "page" else None
        for n, (_, raw) in enumerate(lines, 1):
            ref = f"{path}#L{n}"
            if not raw.strip():
                continue
            try:
                r = _json(raw)
            except ValueError as e:
                _problem(problems, ref, str(e))
                continue
            if shape == "index":
                if r.get("slug"):
                    recs[ref] = {"kind": "page", "ref": ref, "thread": str(r["slug"]),
                                 "title": str(r.get("title") or r["slug"])}
                    pages.setdefault(str(r["slug"]), ref)
                continue
            if shape == "chat":
                r = _chat(r)
                thread = "#" + str(r.get("channel") or path.rsplit("/", 1)[1][:-len(".jsonl")]).lstrip("#")
                kind = "join" if r.get("type") == "join" else "post"
                key = r.get("id")
            else:
                thread, kind, key = slug, "save", r.get("rev")
            if key is not None:
                if key in seen:
                    same[ref] = seen[key]
                    continue
                seen[key] = ref
            t = _time(r.get("ts"))
            known = t is not None
            t = t if known else (last + 1e-3 if last is not None else 0.0)
            last = t
            agent = str(r.get("user") or r.get("ip") or "unknown")
            rec = {"kind": kind, "ref": ref, "thread": thread, "agent": agent, "t": t, "known": known}
            if kind == "save":
                rec.update(rev=r.get("rev"), summary=str(r.get("summary") or ""), text=str(r.get("text") or ""))
            elif kind == "post":
                rec.update(id=key, text=str(r.get("text") or ""), reply_id=r.get("reply_to"))
            recs[ref] = rec
            events.append(rec)
    events.sort(key=lambda r: (r["t"], r["ref"]))
    _compare_saves(events)
    links = _link(events)
    threads = _threads(events, recs, pages, links)
    graph = _map(events, links, threads, roster)
    for rec in events:  # the texts are read back when shown
        rec.pop("text", None)
    return {"files": files, "recs": recs, "order": [r["ref"] for r in events], "same": same, "threads": threads,
            "roster": roster, "map": graph, "action_of": {a["ref"]: a["id"] for a in graph["actions"]},
            "problems": problems}


def _read_roster(path, lines, recs, roster, problems):
    """The roster's rows, a quoted cell over several lines included; each row cites every line it takes."""
    rows = csv.reader((raw.decode("utf-8", "replace") for _, raw in lines), strict=True)
    header, done = None, 0
    while True:
        try:
            cells = next(rows)
        except StopIteration:
            return
        except csv.Error as e:
            _problem(problems, f"{path}#L{done + 1}", f"not a CSV row ({e})")
            done = rows.line_num
            continue
        refs = [f"{path}#L{n}" for n in range(done + 1, rows.line_num + 1)]
        done = rows.line_num
        if header is None:
            header = [c.strip().lower() for c in cells]
            recs[refs[0]] = {"kind": "header", "ref": refs[0], "refs": refs, "text": ",".join(cells)}
            continue
        row = dict(zip(header, cells))
        account = (row.get("account") or "").strip()
        if not account:
            continue
        entry = {"kind": "roster", "ref": refs[0], "refs": refs, "account": account,
                 "objective": (row.get("objective") or "").strip(), "joined": (row.get("joined") or "").strip()}
        roster[account.lower()] = entry
        for ref in refs:
            recs[ref] = entry


def _compare_saves(events):
    """Each save against the save before it on its page: its changes [[key, old, new]], the raw lines it added, the
    save it restores when it puts back an earlier text, and `before`, the previous save's ref."""
    prev, texts = {}, {}
    for rec in events:
        if rec["kind"] != "save":
            continue
        page = rec["thread"]
        pairs, plain = _kv(rec["text"])
        old = prev.get(page)
        old_kv = {k: v for k, v, _ in old["pairs"]} if old else {}
        new_kv = {k: v for k, v, _ in pairs}
        changes = [[k, old_kv.get(k), v] for k, v in new_kv.items() if old_kv.get(k) != v]
        changes += [[k, v, None] for k, v in old_kv.items() if k not in new_kv]
        old_plain = list(old["plain"]) if old else []
        added = [raw for k, v, raw in pairs if old_kv.get(k) != v]
        for raw in plain:
            if raw.strip() in [p.strip() for p in old_plain]:
                old_plain.remove(next(p for p in old_plain if p.strip() == raw.strip()))
            else:
                added.append(raw)
        norm = "\n".join(ln.strip() for ln in rec["text"].split("\n") if ln.strip())
        rec["changes"] = changes
        rec["added"] = added
        rec["before"] = old["ref"] if old else None
        rec["restores"] = next((r for r, n in reversed(texts.get(page, []))
                                if n == norm and old and r != old["ref"]), None)
        texts.setdefault(page, []).append((rec["ref"], norm))
        prev[page] = {"ref": rec["ref"], "pairs": pairs, "plain": plain}


def _asks(rec):
    return rec["kind"] == "post" and "?" in rec["text"]


def _sets(rec):
    """Whether a save sets, changes or clears a value."""
    return any(not _placeholder(new) or not _placeholder(old) for _, old, new in rec.get("changes") or [])


def _link(events):
    """Every link between records, walking them in time order: {(from ref, to ref): {type, reason, quote}}, each pair
    with the first type that holds of contradicts, reply, support and related."""
    rank = {"contradicts": 0, "reply": 1, "support": 2, "related": 3}
    links, current, setters, latest, posts = {}, {}, {}, {}, {}

    def add(a, b, kind, reason, quote):
        if b is None or b["agent"] == a["agent"]:
            return
        k = (a["ref"], b["ref"])
        if k not in links or rank[kind] < rank[links[k]["type"]]:
            links[k] = {"type": kind, "reason": reason, "quote": quote[:QUOTE_MAX]}

    for a in events:
        if a["kind"] == "join":
            continue
        if a["kind"] == "save":
            lines = {_key_of(raw): raw for raw in a["added"]}
            own = {(a["thread"], k) for k, _, _ in a["changes"]}
            for k, old, new in a["changes"]:
                was = current.get((a["thread"], k))
                if was and was["by"] is not None and not (_placeholder(old) and _placeholder(new)):
                    b = was["by"]
                    replaced = next((o for kk, o, _ in b["changes"] if kk == k), None)
                    quote = lines.get(k, "").strip() or a["summary"] or a["agent"]
                    if new is not None and new == replaced and not _placeholder(new):
                        add(a, b, "contradicts", f"Restores {new}, which {b['agent']} replaced", quote)
                    elif _placeholder(new):
                        add(a, b, "contradicts", f"Clears {k}, which {b['agent']} set to {old}", quote)
                    else:
                        add(a, b, "contradicts", f"Changes {k} from {old}, which {b['agent']} set", quote)
                current[(a["thread"], k)] = {"value": new, "by": None if _placeholder(new) else a}
            words, question = "\n".join(a["added"]), False
            said = a["summary"]
        else:
            own, words, question, said = set(), a["text"], _asks(a), a["text"]
            b = posts.get((a["thread"], a["reply_id"])) if a.get("reply_id") is not None else None
            if b is not None:
                add(a, b, "reply", f"Answers {b['agent']}'s question" if _asks(b) else f"Replies to {b['agent']}",
                    _sentences(a["text"])[0] if _sentences(a["text"]) else a["text"])
        for name in MENTION.findall(said):
            b = latest.get(name.lower())
            quote = next((s for s in _sentences(said) if "@" + name in s), said)
            add(a, b, "reply", f"Addresses @{name}", quote)
        for n in dict.fromkeys(_numbers(words)):
            b = setters.get(n)
            if b is None or (b["thread"], b["key"]) in own:
                continue
            parts = a["added"] if a["kind"] == "save" else _sentences(a["text"])
            quote = next((s for s in parts if n in s), n).strip()
            if question:
                add(a, b["by"], "related", f"Asks about {n}, which {b['by']['agent']} set", quote)
            else:
                add(a, b["by"], "support", f"Repeats {n}, which {b['by']['agent']} set", quote)
        if a["kind"] == "save":
            for k, _, new in a["changes"]:
                if not _placeholder(new) and (n := _first_number(new)):
                    setters[n] = {"by": a, "thread": a["thread"], "key": k}
        else:
            posts[(a["thread"], a["id"])] = a
        latest[a["agent"].lower()] = a
    return links


def _threads(events, recs, pages, links):
    """{id: {id, kind, ref, title, refs, agents, links, sources, listed}} of every page and channel: its records, its
    agents and the links its records draw (`sources`, a link's record each), the measure the chart picks threads by."""
    threads = {}
    for slug, ref in pages.items():
        threads[slug] = {"id": slug, "kind": "page", "ref": ref, "title": recs[ref]["title"], "refs": [], "agents": [],
                         "links": 0, "sources": [], "listed": True, "tag": None}
    for rec in events:
        th = threads.get(rec["thread"])
        if th is None:
            th = threads[rec["thread"]] = {"id": rec["thread"], "kind": "channel" if rec["kind"] != "save" else "page",
                                           "ref": rec["ref"], "title": rec["thread"], "refs": [], "agents": [],
                                           "links": 0, "sources": [], "listed": rec["kind"] != "save", "tag": None}
        th["refs"].append(rec["ref"])
        if rec["kind"] != "join" and rec["agent"] not in th["agents"]:
            th["agents"].append(rec["agent"])
    for src, _ in links:
        threads[recs[src]["thread"]]["links"] += 1
        threads[recs[src]["thread"]]["sources"].append(src)
    return threads


def _action_line(rec):
    """A card's line, at most ACTION_MAX characters: what a save changed, or what a post asked, answered or said."""
    if rec["kind"] == "post":
        sentences = _sentences(rec["text"]) or [rec["text"]]
        if "?" in rec["text"]:
            said = next(s for s in sentences if "?" in s)
            return _fit("Asked ", said), said
        verb = "Replied " if rec.get("reply_id") is not None or MENTION.search(rec["text"]) else "Posted "
        return _fit(verb, sentences[0]), sentences[0]
    changes = [c for c in rec["changes"] if not (_placeholder(c[1]) and _placeholder(c[2]))]
    quote = next((raw.strip() for raw in rec["added"] if _key_of(raw) == changes[0][0]),
                 rec["summary"] or rec["agent"]) if changes else rec["summary"] or rec["agent"]
    if not changes:
        return _fit("Saved ", rec["summary"]) if rec["summary"] else f"Saved {rec['thread']}", quote
    if len(changes) == 1:
        k, old, new = changes[0]
        if _placeholder(new):
            line = f"Cleared {k} ({old})" if len(f"Cleared {k} ({old})") <= ACTION_MAX else f"Cleared {k}"
        elif rec["restores"]:
            line = f"Reverted {k} to {new}"
        elif _placeholder(old):
            line = f"Set {k} to {new}"
        else:
            line = f"Changed {k} from {old} to {new}"
            if len(line) > ACTION_MAX:
                line = f"Changed {k} to {new}"
    else:
        parts = [f"{k} to {new}" if not _placeholder(new) else f"{k} cleared" for k, _, new in changes]
        line = "Set " + " and ".join(parts) if len(parts) == 2 else "Set " + ", ".join(parts)
        if len(line) > ACTION_MAX:
            line = f"Set {parts[0]} and {len(parts) - 1} more"
    return (line if len(line) <= ACTION_MAX else line[: ACTION_MAX - 1] + "…"), quote


def _map(events, links, threads, roster):
    """The chart: {title, agents, threads, actions, links} in the shape the swarm map takes."""
    linked = {r for pair in links for r in pair}
    significant = [r for r in events if r["kind"] != "join"
                   and (r["ref"] in linked or _asks(r) or (r["kind"] == "save" and _sets(r)))]
    first = {}
    for r in significant:
        first.setdefault(r["thread"], r["t"])
    chosen = sorted((t for t in threads.values() if t["links"] > 0 and t["id"] in first),
                    key=lambda t: (-t["links"], first[t["id"]]))[:MAX_THREADS]
    chosen.sort(key=lambda t: first[t["id"]])
    for i, th in enumerate(chosen, 1):
        th["tag"] = f"T{i}"
    tags = {th["id"]: th["tag"] for th in chosen}
    actions, ids = [], {}
    for r in significant:
        if r["thread"] not in tags:
            continue
        line, quote = _action_line(r)
        ids[r["ref"]] = len(actions) + 1
        a = {"id": len(actions) + 1, "agent": r["agent"], "thread": tags[r["thread"]],
             "time": _iso(r["t"]) if r["known"] else None,
             "action": line, "ref": r["ref"], "quote": quote[:QUOTE_MAX], "kind": r["kind"]}
        if r.get("before"):
            a["before"] = r["before"]
        actions.append(a)
    out_links = [{"from": ids[src], "to": ids[dst], "type": v["type"], "reason": v["reason"],
                  "evidence": [{"ref": src, "quote": v["quote"]}]}
                 for (src, dst), v in links.items() if src in ids and dst in ids]
    out_links.sort(key=lambda x: (x["from"], x["to"]))
    agents = []
    for name in dict.fromkeys(a["agent"] for a in actions):
        mine = [a for a in actions if a["agent"] == name]
        row = roster.get(name.lower())
        own = [r for r in events if r["agent"] == name]
        signs = list(dict.fromkeys(s for r in own if (s := _signature(r.get("summary") if r["kind"] == "save"
                                                                      else r.get("text")))
                                   and s.lower() != name.lower()))
        if row and row["objective"]:
            goal = " ".join(row["objective"].split())
            evidence = [{"ref": row["ref"], "quote": row["objective"].split("\n")[0][:QUOTE_MAX]}]
        else:
            verb, _, rest = mine[0]["action"].partition(" ")
            goal = f"Unknown beyond {GERUND.get(verb, verb.lower())} {rest}"
            if len(mine) > 1:
                goal += f" and {len(mine) - 1} more"
            evidence = [{"ref": a["ref"], "quote": a["quote"]} for a in mine[:3]]
        agent = {"username": name, "goal": goal, "evidence": evidence}
        if signs:
            agent["signs_as"] = signs
        agents.append(agent)
    return {"title": _title(actions, out_links, events), "agents": agents,
            "threads": [{"tag": th["tag"], "id": th["id"], "ref": th["ref"]} for th in chosen],
            "actions": actions, "links": out_links}


def _title(actions, links, events):
    """The chart's takeaway: the key set most often and by whom, and how many links contradict."""
    by_ref = {r["ref"]: r for r in events}
    counts = {}
    for a in actions:
        r = by_ref[a["ref"]]
        for k, old, new in r.get("changes") or []:
            if not (_placeholder(old) and _placeholder(new)):
                counts.setdefault((r["thread"], k), []).append(a["agent"])
    against = sum(x["type"] == "contradicts" for x in links)
    tail = f"{against} of {len(links)} links contradict an earlier action" if links else "no links"
    if counts:
        (page, key), who = max(counts.items(), key=lambda kv: len(kv[1]))
        if len(who) > 1:
            return f"{key} on {page} was set {len(who)} times by {len(set(who))} agents, and {tail}"
    agents, threads = len({a["agent"] for a in actions}), len({a["thread"] for a in actions})
    return f"{agents} agents acted on {threads} threads, and {tail}"


# ------------------------------------------------------------------------------------------------ serving


def _raw(index, ref):
    """The JSON object on a line, read at its byte offset; {} for none."""
    path, _, n = ref.rpartition("#L")
    with open(path, "rb") as f:
        f.seek(index["files"][path]["offsets"][int(n) - 1])
        raw = f.readline()
    try:
        r = _json(raw)
    except ValueError:
        return {}
    return _chat(r) if index["files"][path]["shape"] == "chat" else r


def _text(index, ref):
    return str(_raw(index, ref).get("text") or "")


def _diff(index, rec):
    """A save's lines against the save before it: [[op, line]], op '+' added, '-' removed, ' ' kept, blank lines out."""
    new = [ln for ln in _text(index, rec["ref"]).split("\n") if ln.strip()]
    old = [ln for ln in _text(index, rec["before"]).split("\n") if ln.strip()] if rec.get("before") else []
    out = []
    ops = difflib.SequenceMatcher(a=[ln.strip() for ln in old], b=[ln.strip() for ln in new], autojunk=False)
    for tag, i1, i2, j1, j2 in ops.get_opcodes():
        if tag == "equal":
            out += [[" ", ln] for ln in new[j1:j2]]
        else:
            out += [["-", ln] for ln in old[i1:i2]] + [["+", ln] for ln in new[j1:j2]]
    return out


def _what(index, rec):
    """A record's line in a list: its card's line when it is on the chart, else what it changed or said."""
    aid = index["action_of"].get(rec["ref"])
    if aid:
        return index["map"]["actions"][aid - 1]["action"]
    if rec["kind"] == "join":
        return f"{rec['agent']} joined"
    if rec["kind"] == "post":
        return _text(index, rec["ref"])
    changes = rec.get("changes") or []
    if not changes:
        if not rec.get("before"):
            return "Created the page"
        return "Edited the text" if rec.get("added") else "Changed only whitespace"
    k, old, new = changes[0]
    more = f" and {len(changes) - 1} more" if len(changes) > 1 else ""
    return (f"Added {k}: {new}" if old is None else f"Removed {k}" if new is None else f"Changed {k} to {new}") + more


def _row(index, ref):
    rec = index["recs"][ref]
    th = index["threads"].get(rec["thread"], {})
    return {"ref": ref, "kind": rec["kind"], "agent": rec["agent"], "thread": rec["thread"], "tag": th.get("tag"),
            "time": _iso(rec["t"]) if rec.get("known") else None, "rev": rec.get("rev"),
            "id": index["action_of"].get(ref), "what": _what(index, rec)}


def _view(index, query):
    g = index["map"]
    labels_on = bool((thimble.view_labels() or {}).get("labels"))
    hide_threads = set(query.get("hide_threads") or [])
    hide_types = set(query.get("hide_types") or [])
    kinds = set(query.get("kinds") or []) or {"save", "post"}
    focus = set(query.get("agents") or [])
    q = str(query.get("q") or "").strip().lower()
    kept = {a["id"] for a in g["actions"] if thimble.kept(a["ref"])}
    by_id = {a["id"]: a for a in g["actions"]}
    near = {}
    for x in g["links"]:
        if x["type"] not in hide_types:
            near.setdefault(x["from"], set()).add(x["to"])
            near.setdefault(x["to"], set()).add(x["from"])

    def ok(a, skip=None):
        if a["id"] not in kept:
            return False
        if skip != "thread" and a["thread"] in hide_threads:
            return False
        if skip != "kind" and a["kind"] not in kinds:
            return False
        if q and q not in f"{a['action']}\n{a['quote']}\n{a['agent']}\n{a['thread']}".lower():
            return False
        if skip != "agent" and focus and a["agent"] not in focus \
                and not any(by_id[o]["agent"] in focus for o in near.get(a["id"], ())):
            return False
        return True

    shown = [a for a in g["actions"] if ok(a)]
    ids = {a["id"] for a in shown}
    facets = {"thread": {}, "agent": {}, "kind": {}, "type": {}}
    for a in g["actions"]:
        for f, key in (("thread", a["thread"]), ("agent", a["agent"]), ("kind", a["kind"])):
            if ok(a, skip=f):
                facets[f][key] = facets[f].get(key, 0) + 1
    for x in g["links"]:
        if x["from"] in ids and x["to"] in ids:
            facets["type"][x["type"]] = facets["type"].get(x["type"], 0) + 1
    links = [x for x in g["links"] if x["from"] in ids and x["to"] in ids and x["type"] not in hide_types]
    agents = [dict(ag, n=n, focus=ag["username"] in focus) for ag in g["agents"]
              if (n := sum(a["agent"] == ag["username"] for a in shown))]
    threads = [dict(th, n=facets["thread"].get(th["tag"], 0), hidden=th["tag"] in hide_threads) for th in g["threads"]]
    filtered = bool((thimble.view_labels() or {}).get("filter"))
    listed = []
    for th in index["threads"].values():
        refs = [r for r in th["refs"] if thimble.kept(r)] if filtered else th["refs"]
        who = {index["recs"][r]["agent"] for r in refs if index["recs"][r]["kind"] != "join"}
        drawn = [r for r in th["sources"] if thimble.kept(r)] if filtered else th["sources"]
        listed.append({"id": th["id"], "tag": th["tag"], "kind": th["kind"], "ref": th["ref"], "title": th["title"],
                       "records": len(refs), "agents": len(who), "links": len(drawn), "listed": th["listed"]})
    listed.sort(key=lambda t: (t["tag"] is None, t["tag"] or "", -t["links"], -t["records"], t["id"]))
    return {"title": g["title"], "agents": agents, "threads": threads,
            "actions": [dict(a, context=bool(focus) and a["agent"] not in focus) for a in shown], "links": links,
            "counts": {"agents": len(agents), "threads": len({a["thread"] for a in shown}), "actions": len(shown),
                       "links": len(links)},
            "total": {"agents": len(g["agents"]), "threads": len(g["threads"]), "actions": len(g["actions"]),
                      "links": len(g["links"])},
            "facets": facets, "all_threads": listed, "labels_on": labels_on, "problems": index["problems"]}


def _record(index, ref):
    ref = index["same"].get(ref, ref)
    rec = index["recs"].get(ref)
    if rec is None or rec["kind"] not in ("save", "post", "join"):
        return None
    out = _row(index, ref)
    raw = _raw(index, ref)
    if rec["kind"] == "save":
        out.update(summary=rec.get("summary") or "", before=rec.get("before"), diff=_diff(index, rec),
                   restores=rec.get("restores"))
    elif rec["kind"] == "post":
        out["text"] = str(raw.get("text") or "")
        if rec.get("reply_id") is not None:
            to = next((r for r in index["threads"][rec["thread"]]["refs"]
                       if index["recs"][r].get("id") == rec["reply_id"]), None)
            if to:
                out["reply_to"] = {"ref": to, "agent": index["recs"][to]["agent"], "id": index["action_of"].get(to)}
    aid = index["action_of"].get(ref)
    if aid:
        a = index["map"]["actions"][aid - 1]
        out["action"] = a
        out["links"] = [dict(x, dir="out", other=x["to"]) for x in index["map"]["links"] if x["from"] == aid] + \
                       [dict(x, dir="in", other=x["from"]) for x in index["map"]["links"] if x["to"] == aid]
        for x in out["links"]:
            o = index["map"]["actions"][x["other"] - 1]
            x["agent"], x["action"] = o["agent"], o["action"]
    return out


def _thread(index, tid):
    th = index["threads"].get(tid)
    if th is None:
        return None
    rows = []
    for ref in th["refs"]:
        if not thimble.kept(ref):
            continue
        row = _row(index, ref)
        rec = index["recs"][ref]
        if rec["kind"] == "save":
            row["summary"] = rec.get("summary") or ""
            row["diff"] = [d for d in _diff(index, rec) if d[0] != " "]
        elif rec["kind"] == "post":
            row["text"] = _text(index, ref)
        rows.append(row)
    return {k: th[k] for k in ("id", "tag", "kind", "ref", "title", "listed", "links")} | {"records": rows}


def _agent(index, name):
    g = index["map"]
    ag = next((a for a in g["agents"] if a["username"] == name), None)
    row = index["roster"].get(name.lower())
    refs = [r for r in index["order"] if index["recs"][r]["agent"] == name]
    if ag is None and row is None and not refs:
        return None
    out = {"username": name, "goal": ag["goal"] if ag else None, "signs_as": (ag or {}).get("signs_as", []),
           "evidence": (ag or {}).get("evidence", []),
           "records": [_row(index, r) for r in refs if thimble.kept(r) and index["recs"][r]["kind"] != "join"]}
    if row:
        out["roster"] = {k: row[k] for k in ("ref", "account", "objective", "joined")}
    return out


def records(index, query):
    """{op: map, hide_threads?: [tag], agents?: [username], kinds?: [save|post], hide_types?: [type], q?}: the chart
    narrowed by those (an agent brings the actions linked to its own), with its counts, the facets' counts (each
    leaving out its own filter), every thread with its measures and `labels_on`. {op: record, ref}: one save or post
    with its diff or text, its reply and its card's links. {op: thread, id}: a thread's records in time order.
    {op: agent, username}: an agent's roster row, goal, names it signs with and records."""
    query = query or {}
    op = query.get("op") or "map"
    if op == "record":
        return _record(index, str(query.get("ref") or ""))
    if op == "thread":
        return _thread(index, str(query.get("id") or ""))
    if op == "agent":
        return _agent(index, str(query.get("username") or ""))
    return _view(index, query)


def _excerpt(index, rec):
    """A record's own words as its line writes them: the lines a save added (else its summary or its author), a post's
    text, a joiner's name, a page's title or a roster row's objective (else its account)."""
    kind = rec["kind"]
    if kind == "save":
        return "\n".join(ln.strip() for ln in rec.get("added") or []) or rec.get("summary") or rec["agent"]
    if kind == "post":
        return _text(index, rec["ref"]) or rec["agent"]
    if kind == "join":
        return rec["agent"]
    if kind == "page":
        return rec["title"]
    if kind == "roster":
        return rec["objective"] or rec["account"]
    return rec.get("text") or ""


def _label(text):
    return text if len(text) <= 40 else text[:39] + "…"


def resolve(index, locator):
    """view:<slug>/T<n>: a thread on the chart, its excerpt the record that defines it. view:<slug>/agent/<name>: an
    agent's row, its excerpt its objective or first action. view:<slug>/<from>-<to>: a link, its excerpt the words of
    the later action that make it. <file>#L<n>: the record, as its card when it is on the chart, else in its thread; a
    roster row opens its agent, a repeated line the first, and the roster's header the roster."""
    g = index["map"]
    if "key" in locator:
        key = str(locator["key"])
        th = next((t for t in g["threads"] if t["tag"] == key), None)
        if th is not None:
            full = index["threads"][th["id"]]
            refs = [th["ref"]] + [r for r in full["refs"] if r != th["ref"]]
            return {"excerpt": _excerpt(index, index["recs"][th["ref"]]), "label": _label(f"{key} {th['id']}"),
                    "refs": refs[:200], "key": key, "target": {"thread": key}}
        if key.startswith("agent/"):
            name = key[len("agent/"):]
            ag = next((a for a in g["agents"] if a["username"] == name), None)
            if ag is None:
                return None
            row = index["roster"].get(name.lower())
            mine = [a["ref"] for a in g["actions"] if a["agent"] == name]
            lead = row["refs"] if row and row["objective"] else [mine[0]]
            excerpt = row["objective"] if row and row["objective"] else _excerpt(index, index["recs"][mine[0]])
            rest = [r for r in index["order"] if index["recs"][r]["agent"] == name and r not in lead]
            return {"excerpt": excerpt, "label": _label(f"{name} · {len(mine)} actions"), "refs": (lead + rest)[:200],
                    "key": key, "target": {"agent": name}}
        m = re.fullmatch(r"(\d+)-(\d+)", key)
        if m:
            x = next((x for x in g["links"] if x["from"] == int(m[1]) and x["to"] == int(m[2])), None)
            if x is None:
                return None
            src, dst = g["actions"][x["from"] - 1], g["actions"][x["to"] - 1]
            return {"excerpt": x["evidence"][0]["quote"], "label": _label(f"#{x['from']} → #{x['to']} {x['type']}"),
                    "refs": [src["ref"], dst["ref"]], "key": key, "target": {"link": [x["from"], x["to"]]}}
        return None
    path, fragment = locator.get("path"), str(locator.get("fragment") or "")
    m = re.fullmatch(r"L(\d+)", fragment)
    if not m or path not in index["files"] or not 1 <= int(m.group(1)) <= len(index["files"][path]["offsets"]):
        return None
    ref = f"{path}#{fragment}"
    first = index["same"].get(ref, ref)
    rec = index["recs"].get(first)
    if rec is None:
        return None
    cited = list(dict.fromkeys([ref, first]))
    kind = rec["kind"]
    if kind == "header":
        return {"excerpt": rec["text"], "label": "roster", "refs": rec["refs"], "key": None, "target": {}}
    if kind == "roster":
        on = any(a["username"].lower() == rec["account"].lower() for a in g["agents"])
        name = next((a["username"] for a in g["agents"] if a["username"].lower() == rec["account"].lower()),
                    rec["account"])
        return {"excerpt": _excerpt(index, rec), "label": _label(f"{name} in the roster"), "refs": rec["refs"],
                "key": f"agent/{name}" if on else None, "target": {"agent": name}}
    th = index["threads"].get(rec["thread"], {})
    if kind == "page":
        return {"excerpt": rec["title"], "label": _label(f"{th.get('tag') or 'page'} {rec['thread']}"), "refs": cited,
                "key": th.get("tag"), "target": {"thread": th.get("tag") or rec["thread"]}}
    aid = index["action_of"].get(first)
    where = f"{rec['thread']} rev {rec['rev']}" if kind == "save" else rec["thread"]
    label = f"#{aid} {rec['agent']} · {where}" if aid else f"{where} · {rec['agent']}"
    target = {"ref": first, "action": aid} if aid else {"ref": first, "thread": rec["thread"]}
    return {"excerpt": _excerpt(index, rec), "label": _label(label), "refs": cited, "key": th.get("tag"),
            "target": target}
