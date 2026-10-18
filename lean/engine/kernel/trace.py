"""Trace: where a value or a passage came from and where it went.

Backward is `lineage.resolve` (a value, its query and code, its source rows). This module adds the forward direction
and the lineage of text that moves between agents:

    uses(st, ref)            what uses a row, a query's value or an object: the queries whose output rows rest on it,
                             the objects whose values or citations rest on it, and the answers (Claude's replies in the
                             sessions that worked in this folder) that cite it or a value built on it
    spread(st, text, files)  where a passage appears in transcripts, by direction: a transcript that received it (in a
                             tool result or a prompt) read it; one that produced it (in its words or a tool call) wrote
                             it. The first to write it is the origin; one that wrote it after reading it copied it
    copied_from(st, ref)     the passages a transcript's block shares with what that transcript read before it, each
                             with the block it read, longest first: where the words of a line came from
    trace(st, ref, text)     all of it for one target, as `lean trace` prints it

Nothing here judges what a passage means. It finds where the same words appear, in which direction and when, and
leaves the reading (is this a copy of the idea, a variant, a mention?) to Claude.
"""
from __future__ import annotations

import datetime as dt
import glob
import json
import os
import re
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any, Iterable

from . import lineage as LIN
from . import objects as O
from . import query as Q
from . import refs as R
from . import sources as S
from .store import Store

# ------------------------------------------------------------------ row sets as intervals

_SET = re.compile(r"^(?P<path>[^#]+)#(?P<unit>L|row=|/(?:[^/]*/)*|[A-Za-z_][A-Za-z0-9_]*/)(?P<nums>\d+(?:-L?\d+)?(?:,\d+(?:-\d+)?)*)(?:\.b\d+)?$")


def intervals(rowsets: Iterable[str]) -> dict[tuple[str, str], list[tuple[int, int]]]:
    """Row sets as sorted, merged (lo, hi) runs per (file, unit), without listing every row. A block ref counts as its
    record's line; a ref that names no numbered row (a whole file, a heading) is left out."""
    out: dict[tuple[str, str], list[tuple[int, int]]] = {}
    for s in rowsets:
        m = _SET.match(str(s))
        if not m:
            continue
        runs = out.setdefault((m["path"], m["unit"]), [])
        for part in m["nums"].split(","):
            a, _, b = part.partition("-")
            lo, hi = int(a), int(b.lstrip("L") or a)
            runs.append((min(lo, hi), max(lo, hi)))
    for k, runs in out.items():
        runs.sort()
        merged: list[tuple[int, int]] = []
        for lo, hi in runs:
            if merged and lo <= merged[-1][1] + 1:
                merged[-1] = (merged[-1][0], max(merged[-1][1], hi))
            else:
                merged.append((lo, hi))
        out[k] = merged
    return out


def overlap(a: dict[tuple[str, str], list[tuple[int, int]]], b: dict[tuple[str, str], list[tuple[int, int]]]) -> int:
    """How many rows two interval sets share."""
    n = 0
    for k, xs in a.items():
        ys = b.get(k)
        if not ys:
            continue
        i = j = 0
        while i < len(xs) and j < len(ys):
            lo, hi = max(xs[i][0], ys[j][0]), min(xs[i][1], ys[j][1])
            if lo <= hi:
                n += hi - lo + 1
            if xs[i][1] < ys[j][1]:
                i += 1
            else:
                j += 1
    return n


# ------------------------------------------------------------------ what a ref stands for


def _qvalue(st: Store, p: dict[str, Any]) -> tuple[str, set[int] | None] | None:
    """(query id, the output rows a parsed query ref names, None for all) or None when there is no such query."""
    q = Q.get(st, p["query"])
    if not q:
        return None
    frag = {k: p[k] for k in ("row", "keys") if k in p}
    return q["id"], (set(Q.find_rows(q, frag)) if frag else None)


def _same_value(a: tuple[str, set[int] | None], b: tuple[str, set[int] | None]) -> bool:
    return a[0] == b[0] and (a[1] is None or b[1] is None or bool(a[1] & b[1]))


def _target(st: Store, ref: str) -> dict[str, Any]:
    """What a ref stands for: {kind, ref, rows, values, object, pointer}. `rows` are the source rows it is (a row ref,
    or the row an object's value cites); `values` the query values it is or is bound to, as (query id, output rows)."""
    p = R.parse(ref)
    t: dict[str, Any] = {"kind": p["kind"], "ref": ref, "rows": {}, "values": [], "object": None, "pointer": ""}
    if p["kind"] == "query":
        v = _qvalue(st, p)
        if not v:
            raise R.RefError(f"no query {p['query']}")
        t["values"].append(v)
    elif p["kind"] == "object":
        obj = O.load(st, p["object"])
        if not obj:
            raise R.RefError(f"no object {p['object']}")
        t["object"], t["pointer"] = obj["id"], p.get("pointer") or ""
        lin = obj.get("lineage") or {}
        if t["pointer"]:
            b = O.binding_for(lin, t["pointer"])
            if b:
                try:
                    bp = R.parse(b["ref"])
                except R.RefError:
                    bp = {}
                if bp.get("kind") == "query":
                    v = _qvalue(st, bp)
                    if v:
                        idx = v[1]
                        # a pointer below the binding names one of its rows: data/<i>/... is output row i of a list binding
                        rest = t["pointer"][len(b["at"]):].split("/")[1:] if t["pointer"].startswith(b["at"]) else []
                        if idx is None and rest and rest[0].isdigit():
                            idx = {int(rest[0])}
                        t["values"].append((v[0], idx))
            try:
                _, holder, _ = O.walk(obj.get("data"), t["pointer"])
            except R.RefError:
                holder = None
            if isinstance(holder, dict) and isinstance(holder.get("ref"), str):
                try:
                    hp = R.parse(holder["ref"])
                    if hp["kind"] == "query":
                        v = _qvalue(st, hp)
                        if v:
                            t["values"].append(v)
                    elif hp["kind"] not in ("object", "file", "table"):
                        t["rows"] = intervals([R.format_source(hp)])
                except R.RefError:
                    pass
        else:
            for b in lin.get("bindings") or []:
                try:
                    bp = R.parse(b["ref"])
                except R.RefError:
                    continue
                if bp.get("kind") == "query" and (v := _qvalue(st, bp)):
                    t["values"].append(v)
    elif p["kind"] not in ("file", "table"):
        t["rows"] = intervals([R.format_source(p)])
        t["path"] = p.get("path")
    else:
        t["path"] = p.get("path")
    return t


# ------------------------------------------------------------------ uses: the forward index


def _key_of(q: dict[str, Any], i: int) -> dict[str, Any]:
    table = q.get("table") or []
    if i >= len(table):
        return {}
    keys = [k for k in q.get("keys") or [] if k in table[i]]
    return {k: table[i][k] for k in keys} if keys else {"row": i + 1}


def _all_queries(st: Store) -> list[dict[str, Any]]:
    d = st.dir / "queries"
    if not d.is_dir():
        return []
    ids = sorted((p.stem for p in d.glob("q*.json") if p.stem[1:].isdigit()), key=lambda s: int(s[1:]))
    return [q for q in (Q.get(st, i) for i in ids) if q]


def _walk_rows(v: Any, ptr: str, out: list[tuple[str, list[str]]]) -> None:
    if isinstance(v, dict):
        if v.get("_rows"):
            out.append((ptr, v["_rows"]))
        for k, x in v.items():
            if k != "_rows":
                _walk_rows(x, f"{ptr}/{k}", out)
    elif isinstance(v, list):
        for i, x in enumerate(v):
            _walk_rows(x, f"{ptr}/{i}", out)


def _ptr_related(a: str, b: str) -> bool:
    a, b = (a or "").rstrip("/"), (b or "").rstrip("/")
    return a == b or a.startswith(b + "/") or b.startswith(a + "/") or not a or not b


class _Matcher:
    """Whether a ref someone wrote (a link in an answer, an object's citation) uses the target."""

    def __init__(self, st: Store, t: dict[str, Any]):
        self.st, self.t = st, t
        self.qrows: dict[str, Any] = {}
        self.objects: dict[str, list[str]] = {}  # objects found to use the target, and where

    def query_rows_overlap(self, v: tuple[str, set[int] | None]) -> bool:
        if not self.t["rows"]:
            return False
        q = self.qrows.setdefault(v[0], Q.get(self.st, v[0]) or {})
        rows = q.get("rows") or []
        idx = v[1] if v[1] is not None else set(range(len(rows)))
        return any(i < len(rows) and overlap(self.t["rows"], intervals(rows[i])) for i in idx)

    def __call__(self, ref: str) -> bool:
        t = self.t
        if ref == t["ref"]:
            return True
        try:
            p = R.parse(ref)
        except R.RefError:
            return False
        if p["kind"] == "query":
            v = _qvalue(self.st, p)
            if not v:
                return False
            return any(_same_value(v, w) for w in t["values"]) or self.query_rows_overlap(v)
        if p["kind"] == "object":
            oid = O.find_id(self.st, p["object"])
            if oid and oid == t["object"]:
                return _ptr_related(p.get("pointer") or "", t["pointer"])
            if oid in self.objects:
                return any(_ptr_related(p.get("pointer") or "", x if x != "/" else "") for x in self.objects[oid])
            return False
        if t["rows"] and p["kind"] not in ("file", "table"):
            try:
                return bool(overlap(t["rows"], intervals([R.format_source(p)])))
            except R.RefError:
                return False
        return False


def uses(st: Store, ref: str, answers: bool = True, limit: int = 20) -> dict[str, Any]:
    """What uses `ref`: queries, objects and answers, each with where and how much. See the module note."""
    t = _target(st, ref)
    rows = t["rows"]
    match = _Matcher(st, t)
    qids = {v[0] for v in t["values"]}
    out: dict[str, Any] = {"ref": ref, "kind": t["kind"], "queries": [], "objects": [], "answers": []}

    for q in _all_queries(st):
        entry: dict[str, Any] | None = None
        if rows and q["id"] not in qids:
            qrows = q.get("rows") or []
            hit = []
            for i, rs in enumerate(qrows):
                n = overlap(rows, intervals(rs))
                if n:
                    hit.append({"i": i + 1, "key": _key_of(q, i), "n": n})
            if hit:
                entry = {"id": q["id"], "about": q.get("about"), "how": "its output rows rest on it",
                         "output_rows": len(hit), "of": len(q.get("table") or []), "rows": hit[:limit]}
            elif not qrows and (t.get("path") in {x["path"] for x in q.get("inputs") or []}):
                entry = {"id": q["id"], "about": q.get("about"), "how": "read its file; keeps no rows per output row"}
        used = [u for u in q.get("uses") or [] if u.get("query") in qids]
        if used:
            entry = {"id": q["id"], "about": q.get("about"), "how": "uses " + ", ".join(repr(u["name"]) for u in used)
                     + " kept by " + ", ".join(sorted({u["query"] for u in used}))}
        elif q.get("rerun_of") in qids:
            entry = {"id": q["id"], "about": q.get("about"), "how": f"ran {q['rerun_of']} again"}
        if entry:
            entry["t"] = q.get("t")
            out["queries"].append(entry)

    for oid in O.all_ids(st):
        obj = O.load(st, oid)
        if not obj:
            continue
        lin = obj.get("lineage") or {}
        at: list[dict[str, Any]] = []
        if rows:
            found: list[tuple[str, list[str]]] = []
            _walk_rows(obj.get("data"), "", found)
            for ptr, rs in found:
                n = overlap(rows, intervals(rs))
                if n:
                    at.append({"at": ptr or "/", "rows": n})
        for b in lin.get("bindings") or []:
            if oid == t["object"] and _ptr_related(b.get("at") or "", t["pointer"]):
                continue
            try:
                bp = R.parse(b["ref"])
            except R.RefError:
                continue
            if bp.get("kind") == "query" and (v := _qvalue(st, bp)) and any(_same_value(v, w) for w in t["values"]):
                at.append({"at": b["at"] or "/", "binds": b["ref"]})
        for c in lin.get("cites") or []:
            cref = c.get("ref") or ""
            if c.get("in") == "text" or not (oid == t["object"] and _ptr_related(c.get("in") or "", t["pointer"])):
                if match(cref):
                    at.append({"at": c.get("in") or "/", "cites": cref, **({"label": c["label"]} if c.get("label") else {})})
        if oid == t["object"]:
            at = [a for a in at if "cites" in a or "binds" in a]
        if at:
            seen: set[str] = set()
            uniq = []
            for a in at:
                k = json.dumps(a, sort_keys=True)
                if k not in seen:
                    seen.add(k)
                    uniq.append(a)
            out["objects"].append({"id": oid, "title": obj.get("title"), "version": obj.get("version"), "at": uniq[:limit],
                                   "values": len(uniq), "updated": obj.get("updated")})
            match.objects[oid] = [a["at"] for a in uniq if a["at"] != "text"]

    if answers:
        out["answers"] = _answers(st, match, limit)
    return out


# ------------------------------------------------------------------ answers: Claude's replies that cite it


def session_transcripts(st: Store) -> list[tuple[str, Path]]:
    """(session id, transcript file) of every Claude Code session that worked in this folder (the ledger names them)
    and of this one, where the transcript can be found under CLAUDE_CONFIG_DIR (else ~/.claude)."""
    ids: list[str] = []
    for r in st.ledger(None):
        s = r.get("session")
        if s and s not in ids:
            ids.append(s)
    if st.session not in ids:
        ids.append(st.session)
    bases = [os.environ.get("CLAUDE_CONFIG_DIR") or "", os.path.expanduser("~/.claude")]
    out = []
    for sid in ids:
        if not re.fullmatch(r"[A-Za-z0-9_-]{6,80}", sid):
            continue
        for b in bases:
            if not b:
                continue
            hits = glob.glob(os.path.join(glob.escape(b), "projects", "*", f"{sid}.jsonl"))
            if hits:
                out.append((sid, Path(hits[0])))
                break
    return out


# lenient on purpose: an answer may write a key with a space, `q2#purpose=adds links@n`, which Markdown would not link
_LINKS = re.compile(r"\[([^\]\n]*)\]\(([^)\n]+)\)")


def _sentence(text: str, start: int, end: int, width: int = 220) -> str:
    a = max(text.rfind(". ", 0, start), text.rfind("\n", 0, start))
    b_candidates = [x for x in (text.find(". ", end), text.find("\n", end)) if x >= 0]
    b = min(b_candidates) if b_candidates else len(text)
    s = text[a + 1 if a >= 0 else 0:b + 1].strip()
    s = _LINKS.sub(lambda m: m[1], s)
    if s.startswith("|"):  # a row of a Markdown table: its cells, without the pipes
        s = " · ".join(c.strip() for c in s.strip("|").split("|") if c.strip() and not set(c.strip()) <= set("-: "))
    s = " ".join(s.split())
    return s if len(s) <= width else s[: width - 1] + "…"


def _is_prompt(line: str) -> bool:
    """Whether a transcript line is a prompt the person typed: not a tool result, a skill's text, a hook's context or
    a command's echo."""
    try:
        v = json.loads(line)
    except ValueError:
        return False
    if v.get("type") != "user" or v.get("isMeta") or v.get("isSidechain"):
        return False
    c = (v.get("message") or {}).get("content")
    text = c if isinstance(c, str) else " ".join(str(b.get("text") or "") for b in c or [] if isinstance(b, dict) and b.get("type") == "text")
    return bool(text.strip()) and not text.lstrip().startswith(("<command-", "<local-command", "<bash-", "<system-reminder"))


def _answers(st: Store, match: _Matcher, limit: int) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for sid, path in session_transcripts(st):
        turn = 0
        try:
            f = open(path, errors="replace")
        except OSError:
            continue
        with f:
            for n, line in enumerate(f, 1):
                if '"user"' in line and '"tool_result"' not in line and _is_prompt(line):
                    turn += 1
                if '"assistant"' not in line or "](" not in line:
                    continue
                try:
                    v = json.loads(line)
                except ValueError:
                    continue
                if v.get("type") != "assistant" or v.get("isSidechain"):
                    continue
                content = (v.get("message") or {}).get("content")
                if not isinstance(content, list):
                    continue
                for bi, b in enumerate(content):
                    if not isinstance(b, dict) or b.get("type") != "text":
                        continue
                    text = str(b.get("text") or "")
                    hits = [m for m in _LINKS.finditer(text)
                            if not m[2].startswith(("http://", "https://", "mailto:")) and match(m[2].strip())]
                    if not hits:
                        continue
                    out.append({"session": sid, "turn": turn, "t": v.get("timestamp"), "ref": f"{path}#L{n}.b{bi}",
                                "cites": [{"label": m[1], "ref": m[2]} for m in hits][:6],
                                "text": _sentence(text, hits[0].start(), hits[0].end())})
                    if len(out) >= limit:
                        return out
    return out


# ------------------------------------------------------------------ text in transcripts


def _strings(v: Any) -> list[str]:
    out: list[str] = []
    if isinstance(v, str):
        out.append(v)
    elif isinstance(v, dict):
        for x in v.values():
            out.extend(_strings(x))
    elif isinstance(v, list):
        for x in v:
            out.extend(_strings(x))
    return out


def blocks(record: Any) -> list[tuple[int, str, str, str]]:
    """(index, direction, kind, text) of each content block of a transcript record. A user record's blocks (prompts,
    tool results) were received; an assistant record's words and tool calls were produced; its reasoning is 'thought'.
    A tool call's text is the strings of its input, so a command or a file it wrote reads as written."""
    if not isinstance(record, dict) or record.get("type") not in ("user", "assistant"):
        return []
    msg = record.get("message")
    if not isinstance(msg, dict):
        return []
    c = msg.get("content")
    way = "received" if record["type"] == "user" else "produced"
    if isinstance(c, str):
        return [(0, way, "text", c)]
    out = []
    for i, b in enumerate(c if isinstance(c, list) else []):
        if not isinstance(b, dict):
            continue
        k = b.get("type")
        if k == "text":
            out.append((i, way, "text", str(b.get("text") or "")))
        elif k == "tool_use":
            out.append((i, "produced", "tool_use", f"{b.get('name')}: " + "\n".join(_strings(b.get("input")))))
        elif k == "tool_result":
            cc = b.get("content")
            out.append((i, "received", "tool_result", "\n".join(_strings(cc)) if not isinstance(cc, str) else cc))
        elif k == "thinking" and b.get("thinking"):
            out.append((i, "thought", "thinking", str(b.get("thinking"))))
    return out


def fold(s: str) -> str:
    tr = str.maketrans({"“": '"', "”": '"', "‘": "'", "’": "'", "—": "-", "–": "-"})
    return " ".join(s.translate(tr).split()).lower()


def _when(v: Any) -> str | None:
    if isinstance(v, dict):
        for k in ("timestamp", "time", "ts", "created_at"):
            if isinstance(v.get(k), str):
                return v[k]
    return None


def _ts(s: str | None) -> float | None:
    if not s:
        return None
    try:
        return dt.datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def _line_with(text: str, needle: str, width: int = 140) -> str:
    """The line of `text` that holds the passage, cut around it."""
    low = text.lower()
    i = low.find(needle.lower())
    if i < 0:
        f = fold(text)
        j = f.find(fold(needle))
        s = f[max(0, j - 50): j + width - 50] if j >= 0 else f[:width]
        return s
    a = text.rfind("\n", 0, i) + 1
    b = text.find("\n", i)
    line = text[a: b if b >= 0 else len(text)].strip()
    if len(line) > width:
        k = i - a
        lo = max(0, min(k - 30, len(line) - width))
        line = ("…" if lo else "") + line[lo: lo + width - 1] + ("…" if lo + width - 1 < len(line) else "")
    return " ".join(line.split())


def _agent(rel: str) -> str:
    return Path(rel).stem


def spread(st: Store, text: str, files: list[str], limit_lines: int = 3) -> dict[str, Any]:
    """Where a passage appears in transcripts, by direction (module note). Matching folds whitespace and case."""
    return spread_many(st, [text], files, limit_lines)[0]


def spread_many(st: Store, texts: list[str], files: list[str], limit_lines: int = 3) -> list[dict[str, Any]]:
    """spread() of several passages in one pass over the files."""
    needles = [fold(t) for t in texts]
    if any(len(x) < 4 for x in needles):
        raise ValueError("a passage of at least 4 characters is needed")
    probes = []
    for x in needles:
        runs = re.findall(r"[a-z0-9_]{3,}", x)
        probes.append(max(runs, key=len) if runs else None)  # a run of ASCII letters reads the same in a raw JSON line
    pers: list[list[dict[str, Any]]] = [[] for _ in texts]
    for rel in files:
        if S.kind_of_file(st.root, rel) not in ("transcript", "jsonl"):
            continue
        es = [{"file": rel, "agent": _agent(rel), "read": 0, "wrote": 0, "first_read": None, "first_wrote": None,
               "lines": []} for _ in texts]
        try:
            fh = open(st.root / rel, errors="replace")
        except OSError:
            continue
        with fh:
            for n, raw in enumerate(fh, 1):
                low = raw.lower()
                which = [i for i, pr in enumerate(probes) if not pr or pr in low]
                if not which:
                    continue
                try:
                    v = json.loads(raw)
                except ValueError:
                    continue
                for bi, way, kind, btext in blocks(v):
                    fb = fold(btext)
                    for i in which:
                        if needles[i] not in fb:
                            continue
                        e = es[i]
                        at = {"ref": f"{rel}#L{n}.b{bi}", "t": _when(v), "kind": kind}
                        if way == "received":
                            e["read"] += 1
                            if not e["first_read"]:
                                e["first_read"] = at
                        elif way == "produced":
                            e["wrote"] += 1
                            if not e["first_wrote"]:
                                e["first_wrote"] = at
                            ln = _line_with(btext, texts[i])
                            if ln not in e["lines"] and len(e["lines"]) < limit_lines:
                                e["lines"].append(ln)
        for i, e in enumerate(es):
            pers[i].append(e)
    return [_roles(t, per) for t, per in zip(texts, pers)]


def _order(at: dict[str, Any] | None) -> tuple[float, int]:
    if not at:
        return (float("inf"), 0)
    n = int(re.search(r"#L(\d+)", at["ref"])[1])
    return (_ts(at.get("t")) or float("inf"), n)


def _roles(text: str, per: list[dict[str, Any]]) -> dict[str, Any]:
    for e in per:
        r, w = e["first_read"], e["first_wrote"]
        if w and (not r or _order(w) < _order(r)):
            e["role"] = "wrote it before reading it"
        elif w:
            e["role"] = "copied"
        elif r:
            e["role"] = "read, never wrote"
        else:
            e["role"] = "never read"
    own = sorted([e for e in per if e["role"] == "wrote it before reading it"], key=lambda e: _order(e["first_wrote"]))
    origin = own[0] if own else None
    reads = sorted([e for e in per if e["first_read"]], key=lambda e: _order(e["first_read"]))
    outside = None
    if reads and (not origin or _order(reads[0]["first_read"]) < _order(origin["first_wrote"])):
        # someone read it before anyone here wrote it: it came from outside these transcripts
        outside = {"agent": reads[0]["agent"], "first_read": reads[0]["first_read"]}
    first_writer = origin
    if origin and not outside:
        origin["role"] = "origin"
    else:
        origin = None
    copied = sorted([e for e in per if e["role"] == "copied"], key=lambda e: _order(e["first_wrote"]))
    held = sorted([e for e in per if e["role"] == "read, never wrote"], key=lambda e: _order(e["first_read"]))
    never = [e for e in per if e["role"] == "never read"]
    readers = [e for e in per if e["read"] and e is not origin]
    return {"text": text, "files": len(per), "origin": origin, "outside": outside, "first_writer": first_writer,
            "own": own[1:] if origin else own, "read": len(readers),
            "copied": copied, "held_out": held, "never": [e["agent"] for e in never],
            "per_file": per}


def siblings(st: Store, rel: str) -> list[str]:
    """The transcripts that sit beside one: the same folder's files of the same kind (a swarm's agents, a sweep's runs)."""
    folder = str(Path(rel).parent)
    pat = (folder + "/" if folder != "." else "") + "*" + Path(rel).suffix
    return [f for f in S.expand_glob(st.root, pat) if S.kind_of_file(st.root, f) == "transcript"]


_WORD = re.compile(r"\S+")


def _shingles(text: str, k: int = 2) -> set[tuple[str, ...]]:
    """Runs of k words (letters and digits only), so punctuation around a word does not hide a shared passage."""
    words = re.findall(r"\w+", text)
    return {tuple(words[i:i + k]) for i in range(max(0, len(words) - k + 1))}


def copied_from(st: Store, ref: str, min_chars: int = 12, top: int = 8) -> dict[str, Any]:
    """The passages a transcript block shares with what its transcript received before it (module note)."""
    p = R.parse(ref)
    if p["kind"] not in ("block", "lines"):
        raise R.RefError(f"{ref} is not a record or block of a transcript")
    rel = p["path"]
    line = p["line"] if p["kind"] == "block" else p["nums"][0]
    target_rows = S.fetch(st.root, f"{rel}#L{line}", limit=1)
    rec = target_rows[0].value if target_rows else None
    bl = blocks(rec)
    if p["kind"] == "block":
        bl = [b for b in bl if b[0] == p["block"]]
    mine = [b for b in bl if b[1] == "produced"] or bl
    if not mine:
        return {"ref": ref, "text": "", "sources": [], "note": "the record has no words or tool calls"}
    text = "\n".join(b[3] for b in mine)
    ftext = fold(text)
    words = ftext.split()
    sh = _shingles(ftext)
    cands: list[tuple[int, int, int, str, str, str | None]] = []  # (shared shingles, line, block, text, kind, t)
    calls: dict[str, str] = {}  # tool call id -> the call, so a result can say what it answers
    answers: dict[tuple[int, int], str] = {}  # (line, block) of a tool result -> its call's id
    with open(st.root / rel, errors="replace") as fh:
        for n, raw in enumerate(fh, 1):
            if n >= line:
                break
            if '"tool_use"' in raw and '"assistant"' in raw:
                try:
                    for b in (json.loads(raw).get("message") or {}).get("content") or []:
                        if isinstance(b, dict) and b.get("type") == "tool_use" and b.get("id"):
                            first = next(iter(_strings(b.get("input"))), "")  # a command, a path, a pattern
                            calls[b["id"]] = " ".join(f"{b.get('name')}: {first}".split())[:120]
                except (ValueError, AttributeError):
                    pass
                continue
            if '"user"' not in raw:
                continue
            try:
                v = json.loads(raw)
            except ValueError:
                continue
            c = (v.get("message") or {}).get("content") if isinstance(v, dict) else None
            for bi, b in enumerate(c if isinstance(c, list) else []):
                if isinstance(b, dict) and b.get("type") == "tool_result" and b.get("tool_use_id"):
                    answers[(n, bi)] = b["tool_use_id"]
            for bi, way, kind, btext in blocks(v):
                if way != "received" or not btext:
                    continue
                fb = fold(btext)
                common = len(sh & _shingles(fb)) if sh else int(ftext in fb)
                if common:
                    cands.append((common, n, bi, fb, kind, _when(v)))
    cands.sort(key=lambda c: (-c[0], -c[1]))
    found: list[dict[str, Any]] = []
    covered: list[tuple[int, int]] = []
    for common, n, bi, fb, kind, when in cands[:16]:
        sm = SequenceMatcher(None, ftext, fb[:60000], autojunk=False)
        for blk in sm.get_matching_blocks():
            if blk.size < min_chars:
                continue
            a, b = _whole_words(ftext, blk.a, blk.a + blk.size)
            if b - a < min_chars or any(not (b <= x or a >= y) for x, y in covered):
                continue
            passage = ftext[a:b].strip(" ,;:.\"'")
            if len(passage) < min_chars or len(passage.split()) < 2:
                continue
            found.append({"passage": passage, "chars": len(passage)})
            covered.append((a, b))
    found.sort(key=lambda x: (-x["chars"]))
    found = found[:top]
    # where this transcript first received each passage: the moment it could have learned it
    for f, sp in zip(found, spread_many(st, [f["passage"] for f in found], [rel]) if found else []):
        at = sp["per_file"][0]["first_read"] if sp["per_file"] else None
        if at and int(re.search(r"#L(\d+)", at["ref"])[1]) < line:
            f.update({"from": at["ref"], "t": at.get("t"), "kind": at.get("kind")})
            m = re.search(r"#L(\d+)\.b(\d+)$", at["ref"])
            via = calls.get(answers.get((int(m[1]), int(m[2])), "")) if m else None
            if via:
                f["via"] = via
    found = [f for f in found if f.get("from")]
    return {"ref": ref, "agent": _agent(rel), "t": _when(rec), "text": _line_with(text, words[0] if words else ""),
            "block": text[:4000], "sources": found}


def _whole_words(s: str, a: int, b: int) -> tuple[int, int]:
    """A span cut to whole words: a partial word at either end is dropped."""
    if a > 0 and s[a - 1].isalnum() and a < b and s[a].isalnum():
        while a < b and not s[a].isspace():
            a += 1
    if b < len(s) and s[b].isalnum() and b > a and s[b - 1].isalnum():
        while b > a and not s[b - 1].isspace():
            b -= 1
    while a < b and s[a].isspace():
        a += 1
    while b > a and s[b - 1].isspace():
        b -= 1
    return a, b


# ------------------------------------------------------------------ one target, both directions


def _label(st: Store, p: dict[str, Any]) -> str | None:
    """What a value is, in the words its row holds: the key columns of a query's output row (purpose: message to
    agents), or the words beside it in an object's data."""
    row: Any = None
    if p["kind"] == "query":
        q = Q.get(st, p["query"])
        frag = {k: p[k] for k in ("row", "keys") if k in p}
        idx = Q.find_rows(q, frag) if q and frag else []
        if len(idx) == 1:
            row = {k: v for k, v in (q.get("table") or [])[idx[0]].items() if k in (q.get("keys") or [])}
    elif p["kind"] == "object" and p.get("pointer"):
        obj = O.load(st, p["object"])
        parent = p["pointer"].rsplit("/", 1)[0]
        try:
            row, _, _ = O.walk((obj or {}).get("data"), parent) if parent else ((obj or {}).get("data"), None, None)
        except R.RefError:
            row = None
    if not isinstance(row, dict):
        return None
    words = [str(v) for k, v in row.items() if not k.startswith("_") and isinstance(v, str) and v.strip()]
    return ", ".join(words)[:80] or None


def _upstream(st: Store, q: dict[str, Any], seen: set[str] | None = None) -> list[dict[str, Any]]:
    """The queries a query builds on through use() (a label is one), each with its own, nearest first."""
    seen = seen if seen is not None else {q["id"]}
    out = []
    for u in q.get("uses") or []:
        pq = Q.get(st, u["query"])
        if not pq or pq["id"] in seen:
            continue
        seen.add(pq["id"])
        out.append({"name": u["name"], "query": pq["id"], "about": pq.get("about"), "code": pq.get("code"),
                     "lineage": pq.get("lineage"), "inputs": [{"path": x["path"], "rows_read": x.get("rows_read")} for x in pq.get("inputs") or []],
                     "upstream": _upstream(st, pq, seen)})
    return out


def trace(st: Store, ref: str | None = None, text: str | None = None, within: str | None = None,
          answers: bool = True, n: int = 3) -> dict[str, Any]:
    """Backward and forward for a ref, a passage, or both (`lean trace`)."""
    out: dict[str, Any] = {"ref": ref, "text": text}
    kind = None
    if ref:
        p = R.parse(ref)
        kind = p["kind"]
        is_transcript = kind in ("block", "lines") and S.kind_of_file(st.root, p["path"]) == "transcript"
        out["back"] = LIN.resolve(st, ref, n=n) if not is_transcript else None
        out["label"] = _label(st, p) if kind in ("query", "object") else None
        for step in (out["back"] or {}).get("chain") or []:
            if step.get("step") == "query":
                q = Q.get(st, step["id"])
                step["upstream"] = _upstream(st, q) if q else []
                if q and not step.get("inputs"):
                    step["inputs"] = [{"path": x["path"], "rows_read": x.get("rows_read")} for x in q.get("inputs") or []]
        if is_transcript:
            cf = copied_from(st, ref)
            out["copied_from"] = cf
            sib = S.expand_glob(st.root, within) if within else siblings(st, p["path"])
            sps = spread_many(st, [x["passage"] for x in cf["sources"]], sib) if cf["sources"] else []
            for src, sp in zip(cf["sources"], sps):
                o = sp["origin"]
                src["origin"] = {"agent": o["agent"], "ref": o["first_wrote"]["ref"], "t": o["first_wrote"].get("t"),
                                 "line": (o["lines"] or [""])[0]} if o else None
                src["read_by"], src["copied_by"] = sp["read"], len(sp["copied"])
                src["_spread"] = sp
            # another agent's words first (behavior that moved between agents), then the longest
            cf["sources"].sort(key=lambda x: (not (x["origin"] and x["origin"]["agent"] != cf["agent"]), -x["chars"]))
            for src in cf["sources"][4:]:
                src.pop("_spread", None)
            cf["sources"] = cf["sources"][:4]
            if not text and cf["sources"]:
                pick = next((x for x in cf["sources"] if x["origin"] and x["origin"]["agent"] != cf["agent"]), cf["sources"][0])
                text = pick["passage"]
                out["text"] = text
                out["text_from"] = ("the passage it shares with what another agent wrote before" if pick["origin"]
                                    else "the longest passage it shares with what it read before")
                out["spread"] = pick["_spread"]
                out["spread"]["within"] = within or (str(Path(p["path"]).parent) + "/")
            for src in cf["sources"]:
                src.pop("_spread", None)
        cov = LIN.coverage(st)
        used = set()
        for step in (out.get("back") or {}).get("chain") or []:
            q = Q.get(st, step["id"]) if step.get("step") == "query" else None
            for x in (Q.all_inputs(st, q) if q else step.get("inputs") or []):
                used.add(x["path"])
        if kind not in ("query", "object"):
            used.add(p.get("path"))
        if kind in ("query", "object"):
            out["files"] = {"used": sorted(f for f in used if f),
                            "not_used": [o["path"] for o in cov["files"] if o["path"] not in used][:40],
                            "not_read_this_session": [o["path"] for o in cov["files"] if o["status"] == "not read"][:40]}
        out["forward"] = uses(st, ref, answers=answers)
    if text and "spread" not in out:
        files = S.expand_glob(st.root, within) if within else (siblings(st, R.parse(ref)["path"]) if ref and kind in ("block", "lines") else [])
        if not files and ref and R.parse(ref).get("path"):
            # a row of another kind (a board post, a log line): the transcripts in its own folder and below it
            folder = str(Path(R.parse(ref)["path"]).parent)
            files = [f for f in S.expand_glob(st.root, (folder + "/" if folder != "." else "") + "**/*.jsonl")
                     if S.kind_of_file(st.root, f) == "transcript"]
        if not files:
            files = [f for f in S.list_sources(st.root) if S.kind_of_file(st.root, f) == "transcript"]
        out["spread"] = spread(st, text, files)
        out["spread"]["within"] = within or (os.path.commonpath(files) + "/" if len(files) > 1 else files[0] if files else "")
    st.log({"kind": "trace", "ref": ref, "text": text, "within": within})
    return out


# ------------------------------------------------------------------ as text, for Claude


def _hhmm(t: str | None) -> str:
    if not t:
        return ""
    m = re.search(r"T(\d\d:\d\d:\d\d)", t)
    return m[1] if m else t


def text_of(r: dict[str, Any], width: int = 150) -> str:
    """`lean trace` as Claude reads it: the path back, then what uses it, then the spread."""
    cut = lambda s, w=width: s if len(s) <= w else s[: w - 1] + "…"  # noqa: E731
    L: list[str] = []
    back = r.get("back")
    if back:
        L.append("back")
        for step in back.get("chain") or []:
            k = step["step"]
            if k == "object":
                val = json.dumps(step.get("value"), ensure_ascii=False, default=str) if "at" in step else ""
                L.append(cut(f"  {'= ' + val[:40] + ' ' if val else ''}object {step['id']} v{step.get('version')}" + (f" at {step['at']}" if 'at' in step else "")))
            elif k == "binding":
                L.append(f"  ← bound from {step['from']}")
            elif k == "query":
                L.append(cut(f"  ← {step['id']} · {step.get('about') or ''} · rows: {step.get('lineage')}"))
                code = [x for x in (step.get("code") or "").strip().splitlines() if x.strip()]
                for c in code[:4]:
                    L.append(cut(f"      {c}"))
                if len(code) > 4:
                    L.append(f"      … {len(code) - 4} more lines")

                def up(us: list[dict[str, Any]], depth: int) -> None:
                    for u in us:
                        ins = ", ".join(f"{x['path']} ({format(x['rows_read'], ',') if x.get('rows_read') else '?'} rows)" for x in u.get("inputs") or [])
                        L.append(cut(f"  {'  ' * depth}← uses {u['name']!r}, kept by {u['query']} · {u.get('about') or ''}" + (f" · reads {ins}" if ins else "")))
                        code_ = [x for x in (u.get("code") or "").strip().splitlines() if x.strip()]
                        for c in code_[:3]:
                            L.append(cut(f"      {'  ' * depth}{c}"))
                        if len(code_) > 3:
                            L.append(f"      {'  ' * depth}… {len(code_) - 3} more lines")
                        up(u.get("upstream") or [], depth + 1)
                if step.get("check"):
                    L.append(f"      check: {step['check']}")
                up(step.get("upstream") or [], 0)
                continue
            elif k == "source":
                L.append(f"  {step['ref']} is a source row ({step.get('kind')}): it comes from its file, nothing before it")
            if step.get("check"):
                L.append(f"      check: {step['check']}")
        source_only = all(st_["step"] == "source" for st_ in back.get("chain") or [])
        if back.get("rows") and not source_only:
            cnt = back.get("count")
            L.append(cut(f"  ← {format(cnt, ',') + ' source row' + ('s' if cnt != 1 else '') if cnt is not None else 'whole files'}: " + ", ".join(back["rows"][:3])
                         + (f" and {len(back['rows']) - 3} more row sets" if len(back["rows"]) > 3 else "")))
        for rec in (back.get("records") or [])[:2]:
            L.append(cut(f"      {rec['ref']}  {rec['text']}"))
        for note in back.get("notes") or []:
            L.append(cut(f"  note: {note}"))
    cf = r.get("copied_from")
    if cf:
        L.append("back")
        L.append(cut(f"  {cf.get('agent')} wrote it{' at ' + _hhmm(cf.get('t')) if cf.get('t') else ''}: {cf.get('text')}"))
        for s in cf["sources"]:
            o = s.get("origin")
            L.append(cut(f"  ← \"{s['passage']}\": it first read these words at {s['from'].split('#')[1]}{' (' + _hhmm(s.get('t')) + ')' if s.get('t') else ''}, a {s['kind']}"))
            if o and o["agent"] != cf.get("agent"):
                L.append(cut(f"      ← {o['agent']} wrote them first, {_hhmm(o.get('t'))} {o['ref']}: {o['line']}"))
            elif o:
                L.append(cut(f"      ← this agent wrote them first, {_hhmm(o.get('t'))} {o['ref'].split('#')[1]}"))
            elif "read_by" in s:
                L.append("      ← they came from outside these transcripts (no agent here wrote them before one read them)")
        if not cf["sources"]:
            L.append("  ← it shares no passage with anything it read before: its own words")
    files = r.get("files")
    if files and files.get("not_used"):
        nu = files["not_used"]
        L.append(cut(f"  not behind it: {len(nu)} other file{'s' if len(nu) != 1 else ''} here: {', '.join(nu[:5])}" + (" …" if len(nu) > 5 else "")))
    sp = r.get("spread")
    if sp:
        L.append(cut(f"spread of \"{sp['text']}\" across {sp['files']} transcripts in {sp.get('within') or 'this folder'}"
                     + (f" (the passage: {r['text_from']})" if r.get("text_from") else "")))
        o = sp.get("origin")
        if o:
            L.append(cut(f"  ★ {o['agent']} wrote it first, {_hhmm(o['first_wrote'].get('t'))} {o['first_wrote']['ref']}: {o['lines'][0] if o['lines'] else ''}"))
        else:
            ou = sp.get("outside") or {}
            L.append(cut("  it came from outside these transcripts" + (f": {ou['agent']} read it first, {_hhmm(ou['first_read'].get('t'))} {ou['first_read']['ref']}" if ou else "")))
        L.append(f"  {sp['read']} {'others ' if o else ''}read it · {len(sp['copied'])} wrote it after reading it · {len(sp['held_out'])} read it and never wrote it"
                 f" · {len(sp['own'])} other{'s' if len(sp['own']) != 1 else ''} wrote it before reading it · {len(sp['never'])} never read it")
        for e in sp["copied"][:12]:
            L.append(cut(f"    copied  {e['agent']}  read {_hhmm((e['first_read'] or {}).get('t'))}, wrote {_hhmm(e['first_wrote'].get('t'))} {e['first_wrote']['ref'].split('#')[1]}: {e['lines'][0] if e['lines'] else ''}"))
        if len(sp["copied"]) > 12:
            L.append(f"    … {len(sp['copied']) - 12} more copied (--json lists every one, with up to 3 lines each)")
        for e in sp["own"][:5]:
            L.append(cut(f"    own     {e['agent']}  wrote {_hhmm(e['first_wrote'].get('t'))} before reading it: {e['lines'][0] if e['lines'] else ''}"))
        if sp["held_out"]:
            L.append(cut("    read, never wrote: " + " ".join(e["agent"] for e in sp["held_out"])))
        if sp["never"]:
            L.append(cut("    never read: " + " ".join(sp["never"])))
    fw = r.get("forward")
    if fw:
        L.append("forward")
        for q in fw["queries"]:
            how = q.get("how")
            if q.get("rows"):
                keys = ", ".join(json.dumps(h["key"], ensure_ascii=False) for h in q["rows"][:3])
                L.append(cut(f"  {q['id']} · {q.get('about') or ''} · {q['output_rows']} of {q['of']} output rows rest on it: {keys}"))
            else:
                L.append(cut(f"  {q['id']} · {q.get('about') or ''} · {how}"))
        for o in fw["objects"]:
            ats = ", ".join(a["at"] for a in o["at"][:4])
            L.append(cut(f"  object {o['id']} v{o.get('version')} · {o.get('title') or ''} · {o['values']} place{'s' if o['values'] != 1 else ''}: {ats}"))
        for a in fw["answers"]:
            L.append(cut(f"  answer, turn {a['turn']}{' at ' + _hhmm(a.get('t')) if a.get('t') else ''}: \"{a['text']}\""))
        if not (fw["queries"] or fw["objects"] or fw["answers"]):
            L.append("  nothing kept here uses it yet (no query, object or cited answer)")
    return "\n".join(L)
