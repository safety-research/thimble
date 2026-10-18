"""Lineage read back: resolve any ref (a source row, a query's value, an object's value) to the rows it came from, and
coverage, what was read and what was not.

Coverage comes from three records: the queries' inputs and the rows `lean rows` showed (thimble/ledger.jsonl), and the
Read, Grep and Bash calls the hooks module kept (store.seen). A file's coverage is the strongest of:

    computed   a query loaded its rows (how many of how many)
    read       Claude read some of its lines or rows (which)
    searched   a search ran over it (Grep, `lean rows --search`), which shows only what matched
    named      a shell command named it (cat, head, jq, python...); what the command read is not known
    not read   nothing touched it
"""
from __future__ import annotations

import fnmatch
import json
import random
import re
from collections import defaultdict
from pathlib import Path
from typing import Any

from . import objects as O
from . import query as Q
from . import refs as R
from . import sources as S
from .store import Store

# ------------------------------------------------------------------ resolve


def excerpt(row: S.Row, width: int = 240) -> str:
    v = row.value
    if isinstance(v, dict) and v.get("type") in ("assistant", "user") and isinstance(v.get("message"), dict):
        bl = S.blocks_of(v)
        parts = []
        for b in bl[:3]:
            t = " ".join(str(b["text"]).split())
            parts.append(f"[{b['kind']}] {t[:160]}")
        s = f"{v['type']}: " + " · ".join(parts)
    elif isinstance(v, dict) and "text" in v and len(v) <= 6 and isinstance(v["text"], str):
        s = " ".join(v["text"].split())
    elif isinstance(v, dict):
        def short(x: Any) -> Any:
            if isinstance(x, str):
                x = " ".join(x.split())
                return x if len(x) <= 60 else x[:59] + "…"
            if isinstance(x, (dict, list)):
                t = json.dumps(x, ensure_ascii=False, default=str)
                return t if len(t) <= 60 else t[:59] + "…"
            return x
        s = ", ".join(f"{k}: {short(x)}" for k, x in v.items() if x not in (None, "", [], {}))
    else:
        s = " ".join(str(v).split())
    return s if len(s) <= width else s[: width - 1] + "…"


# the fields that hold a record's words, best first; then the fields that say whose and where it is (the shell's detail
# view shows `words` and `meta`; `text` stays the excerpt the CLI prints)
WORD_KEYS = ("text", "quote", "summary", "title", "message", "msg", "body", "content", "comment", "description", "subject",
             "note", "change_summary", "reason", "answer", "question", "prompt")
META_KEYS = ("user", "author", "agent", "sender", "name", "label", "page", "run", "step", "epoch", "rev", "kind", "type",
             "event_type", "activity", "day", "date", "time")


def words_of(row: S.Row) -> tuple[str, str]:
    """A row as a person reads it: its meaningful words (its text, title, summary, message, body and the like; a
    transcript row's first words or tool call) and a short line of whose and where it is. ('', '') when nothing in it
    reads as words."""
    v = row.value
    one = lambda x: " ".join(str(x).split())  # noqa: E731
    if isinstance(v, str):
        return one(v)[:240], ""
    if not isinstance(v, dict):
        return "", ""
    words, key = "", None
    if v.get("type") in ("assistant", "user") and isinstance(v.get("message"), dict):
        for b in S.blocks_of(v):
            if b["kind"] in ("text", "tool_use", "tool_result") and str(b["text"]).strip():
                words = one(b["text"])
                break
    if not words:
        key = next((k for k in WORD_KEYS if isinstance(v.get(k), str) and v[k].strip()), None)
        if key:
            words = one(v[key])
    if not words:
        long = [(k, x) for k, x in v.items() if isinstance(x, str) and len(x.strip()) >= 16
                and not re.search(r"(^|_)(id|ref|hash|key|url|path)$", k, re.I)]
        if long:
            key, x = max(long, key=lambda kv: len(kv[1]))
            words = one(x)
    if not words:
        return "", ""
    meta = []
    for k in META_KEYS:
        x = v.get(k)
        if len(meta) >= 3:
            break
        if k == key or x in (None, "") or isinstance(x, (dict, list)) or len(one(x)) > 40:
            continue
        meta.append(f"{k} {x}" if isinstance(x, (int, float)) and not isinstance(x, bool) else one(x))
    return (words if len(words) <= 240 else words[:239] + "…"), " · ".join(meta)


def _record(row: S.Row) -> dict[str, Any]:
    out: dict[str, Any] = {"ref": row.ref, "hash": S.row_hash(row.raw), "text": excerpt(row)}
    words, meta = words_of(row)
    if words:
        out["words"] = words
        if meta:
            out["meta"] = meta
    return out


def records(st: Store, rowsets: list[str], n: int = 5, pick: str = "first", seed: int = 0) -> list[dict[str, Any]]:
    """Up to n rows of the row sets, each {ref, hash, text, words?, meta?}: the first ones in file order, or a random
    sample."""
    singles = R.expand(rowsets) if pick == "random" else None
    out = []
    if singles is not None:
        chosen = sorted(random.Random(seed).sample(singles, min(n, len(singles))), key=lambda r: (r.split("#")[0], _num(r)))
        for ref in chosen:
            for row in S.fetch(st.root, ref, limit=1):
                out.append(_record(row))
        return out
    for rs in rowsets:
        if len(out) >= n:
            break
        for row in S.fetch(st.root, rs, limit=n - len(out)):
            out.append(_record(row))
    return out


def _num(ref: str) -> int:
    m = re.search(r"(\d+)(?:-\d+)?$", ref)
    return int(m[1]) if m else 0


def resolve(st: Store, ref: str, n: int = 5, pick: str = "first") -> dict[str, Any]:
    """Where a ref's value came from: a chain of steps from the ref down to source rows, the rows as row sets, how many,
    and up to n of them read back."""
    p = R.parse(ref)
    chain: list[dict[str, Any]] = []
    notes: list[str] = []
    rowsets: list[str] = []
    if p["kind"] == "object":
        rowsets = _resolve_object(st, p, chain, notes)
    elif p["kind"] == "query":
        rowsets = _resolve_query(st, p, chain, notes)
    else:
        rowsets = [R.format_source(p)] if p["kind"] not in ("file", "table") else [ref]
        chain.append({"step": "source", "ref": ref, "kind": S.kind_of_file(st.root, p["path"])})
    out: dict[str, Any] = {"ref": ref, "chain": chain, "rows": rowsets, "notes": notes}
    try:
        files_only = all(R.parse(x)["kind"] in ("file", "table") for x in rowsets)
        out["count"] = None if files_only else R.count(rowsets)
        out["records"] = records(st, rowsets, n, pick) if rowsets and not files_only else []
    except R.RefError as e:
        out["error"] = str(e)
        out["records"] = []
    st.log({"kind": "resolve", "ref": ref, "shown": [r["ref"] for r in out.get("records") or []]})
    return out


def _resolve_query(st: Store, p: dict[str, Any], chain: list, notes: list) -> list[str]:
    q = Q.get(st, p["query"])
    if not q:
        raise R.RefError(f"no query {p['query']}")
    stale = Q.stale_inputs(st, q)
    step: dict[str, Any] = {"step": "query", "id": q["id"], "about": q.get("about"), "lineage": q.get("lineage"),
                            "frame": q.get("frame"), "code": q.get("code"),
                            "inputs": [{"path": x["path"], "rows_read": x.get("rows_read")} for x in q.get("inputs") or []]}
    if stale:
        step["stale"] = stale
        notes.append(f"{', '.join(stale)} changed since {q['id']} ran; `lean rerun {q['id']}` runs it again")
    if q.get("uses"):
        step["uses"] = q["uses"]
    chain.append(step)
    frag = {k: p[k] for k in ("row", "keys") if k in p}
    idx = Q.find_rows(q, frag) if frag else []
    if frag and not idx:
        raise R.RefError(f"{q['id']} has no output row {_frag_text(p)}")
    if frag:
        rows_tbl = q.get("table") or []
        step["rows"] = [{"i": i + 1, **rows_tbl[i]} for i in idx[:20]]
        if "col" in p:
            if len(idx) == 1:
                if p["col"] not in rows_tbl[idx[0]]:
                    raise R.RefError(f"{q['id']}'s output has no column {p['col']!r}; it has {', '.join(rows_tbl[idx[0]])}")
                step["value"] = rows_tbl[idx[0]][p["col"]]
    if not q.get("rows"):
        notes.append(f"{q['id']} keeps no rows per output row (lineage: query), so each of its values rests on every "
                     "row it read; tally() or a `_refs` column keeps them")
        return [x["path"] for x in Q.all_inputs(st, q)]
    pick = idx if frag else range(len(q["rows"]))
    rowsets: list[str] = []
    for i in pick:
        if i < len(q["rows"]):
            rowsets.extend(q["rows"][i])
    rowsets = _merge(rowsets)
    mode = q.get("lineage")
    n = R.count(rowsets)
    v = step.get("value")
    if mode == "superset":
        notes.append(f"these {n:,} rows share the output row's key, but a count column of {q['id']} disagrees: they hold "
                     "more rows than the value counts")
    elif mode == "key":
        notes.append(f"these {n:,} rows share the output row's key in frame `{q.get('frame')}`; no column counts rows, "
                     "so the match could not be checked")
    if isinstance(v, int) and not isinstance(v, bool) and frag and len(idx) == 1:
        step["check"] = "the value equals the number of rows" if v == n else f"the value is {v:,}, the rows are {n:,}"
    return rowsets


def _frag_text(p: dict[str, Any]) -> str:
    if "row" in p:
        return f"row={p['row']}"
    return "&".join(f"{k}={v}" for k, v in (p.get("keys") or {}).items())


def _merge(rowsets: list[str]) -> list[str]:
    try:
        return R.compress(R.expand(rowsets)) if len(rowsets) > 1 else rowsets
    except R.RefError:
        return rowsets


def _resolve_object(st: Store, p: dict[str, Any], chain: list, notes: list) -> list[str]:
    obj = O.load(st, p["object"])
    if not obj:
        raise R.RefError(f"no object {p['object']}")
    ptr = p.get("pointer") or ""
    step: dict[str, Any] = {"step": "object", "id": obj["id"], "version": obj.get("version"), "title": obj.get("title")}
    chain.append(step)
    lin = obj.get("lineage") or {}
    if not ptr:
        step["values"] = len(lin.get("bindings") or [])
        rs = []
        for f, x in (lin.get("rows") or {}).items():
            rs.extend(x.get("rowsets") or [])
        return rs
    value, holder, holder_ptr = O.walk(obj.get("data"), ptr)
    step["at"] = ptr
    step["value"] = value
    b = O.binding_for(lin, ptr)
    if b:
        chain.append({"step": "binding", "at": b["at"], "from": b["ref"]})
    if isinstance(holder, dict) and holder.get("_rows"):
        rowsets = list(holder["_rows"])
        if b and R.parse(b["ref"])["kind"] == "query":
            q = Q.get(st, R.parse(b["ref"])["query"]) or (lin.get("queries") or {}).get(R.parse(b["ref"])["query"])
            if q:
                chain.append({"step": "query", "id": q["id"], "about": q.get("about"), "lineage": q.get("lineage"),
                              "code": q.get("code")})
                stale = Q.stale_inputs(st, q)
                if stale:
                    notes.append(f"{', '.join(stale)} changed since {q['id']} ran")
                if q.get("lineage") in ("superset", "key"):
                    notes.append(f"{q['id']}'s rows were found by key ({q['lineage']}), not kept exactly")
        n = R.count(rowsets)
        if isinstance(value, int) and not isinstance(value, bool):
            chain[-1]["check"] = "the value equals the number of rows" if value == n else f"the value is {value:,}, the rows are {n:,}"
        return rowsets
    if isinstance(holder, dict) and isinstance(holder.get("ref"), str):
        cp = R.parse(holder["ref"])
        if cp["kind"] in ("query", "object"):
            return _resolve_query(st, cp, chain, notes) if cp["kind"] == "query" else _resolve_object(st, cp, chain, notes)
        cite = next((c for c in lin.get("cites") or [] if c.get("ref") == holder["ref"]), None)
        if cite and cite.get("hash"):
            try:
                now = S.fetch(st.root, holder["ref"], limit=1)
                if now and S.row_hash(now[0].raw) != cite["hash"]:
                    moved = S.relocate(st.root, holder["ref"], cite["hash"])
                    notes.append(f"{holder['ref']} changed since the object was saved" + (f"; its row is now at {moved}" if moved else ""))
                    if moved:
                        return [moved]
            except R.RefError as e:
                notes.append(str(e))
        return [holder["ref"]]
    if b and R.parse(b["ref"])["kind"] == "query":
        return _resolve_query(st, R.parse(b["ref"]), chain, notes)
    notes.append("Claude wrote this value into the object; no query or row stands behind it")
    return []


# ------------------------------------------------------------------ coverage


_FILE_TOKEN = re.compile(r"[\w./*?\[\]{}~+-]+")


def files_named_in(text: str, known: list[str], root: str) -> set[str]:
    """Source files a shell command names, by path or by a glob over them (from thimble-lite)."""
    hit: set[str] = set()
    text = text.replace(root.rstrip("/") + "/", "")
    for t in set(_FILE_TOKEN.findall(text)):
        t = t.strip("'\"")
        if len(t) < 3:
            continue
        if "*" in t or "?" in t:
            for f in known:
                if fnmatch.fnmatch(f, t) or fnmatch.fnmatch(f, "*/" + t.lstrip("/")):
                    hit.add(f)
        elif "." in t or "/" in t:
            for f in known:
                if f == t or f.endswith("/" + t) or (t.endswith("/" + f)):
                    hit.add(f)
                elif t.endswith("/") or ("." not in Path(t).name and f.startswith(t.rstrip("/") + "/")):
                    hit.add(f)
    return hit


def _ranges_len(ranges: list[tuple[int, int]]) -> int:
    n, end = 0, 0
    for a, b in sorted(ranges):
        if b <= end:
            continue
        n += b - max(a, end + 1) + 1
        end = b
    return n


def coverage(st: Store, session: str | None = "") -> dict[str, Any]:
    """What this session (or `session`, or all sessions for None) read of every source file, file by file and by
    group of like files."""
    files = S.list_sources(st.root)
    cnt = S.counts(st.root, files, st.cache / "counts.json")
    known = set(files)
    per: dict[str, dict[str, Any]] = {f: {"computed": 0, "queries": [], "shown": set(), "lines": [], "searched": False,
                                          "matched": 0, "named": False} for f in files}
    for r in st.ledger(session):
        k = r.get("kind")
        if k == "query" and not r.get("error"):
            for f, n in (r.get("loaded") or {}).items():
                if f in per:
                    per[f]["computed"] = max(per[f]["computed"], int(n or 0)) or per[f]["computed"]
                    per[f]["queries"].append(r.get("id"))
                    if not n:
                        per[f]["named"] = True
        elif k in ("rows", "resolve"):
            for ref in r.get("shown") or []:
                f = ref.split("#")[0]
                if f in per:
                    per[f]["shown"].add(ref)
            for f in r.get("scanned") or []:
                if f in per:
                    per[f]["searched"] = True
    root = str(st.root)
    for s in st.seen(session):
        tool = s.get("tool")
        if tool == "Read":
            f = st.rel(s.get("file") or "")
            if f in per:
                a, b = s.get("from"), s.get("to")
                if a is None or b is None:
                    a, b = 1, max(1, cnt.get(f, {}).get("lines") or 1)
                per[f]["lines"].append((int(a), int(b)))
        elif tool == "Grep":
            scope = st.rel(s.get("path") or s.get("cwd") or root)
            if scope is None:
                continue
            glob = s.get("glob") or ""
            for f in files:
                inside = scope in (".", "") or f == scope or f.startswith(scope.rstrip("/") + "/")
                if inside and (not glob or fnmatch.fnmatch(Path(f).name, glob) or fnmatch.fnmatch(f, glob)):
                    per[f]["searched"] = True
            for fp in s.get("files") or []:
                f = st.rel(fp)
                if f in per:
                    per[f]["matched"] += 1
            for fp, lines in (s.get("lines") or {}).items():
                f = st.rel(fp)
                if f in per:
                    for n in lines:
                        per[f]["lines"].append((int(n), int(n)))
        elif tool == "Bash":
            cmd = str(s.get("command") or "")
            if re.match(r"^\s*lean(\s|$)", cmd):
                continue
            for f in files_named_in(cmd, list(known), root):
                per[f]["named"] = True
    out_files = []
    for f in files:
        c, x = cnt.get(f, {}), per[f]
        rows, lines = c.get("rows", 0), c.get("lines", 0)
        read_lines = _ranges_len(x["lines"])
        status = ("computed" if x["computed"] else "read" if (read_lines or x["shown"]) else
                  "searched" if x["searched"] else "named" if x["named"] else "not read")
        out_files.append({"path": f, "kind": c.get("kind"), "rows": rows, "lines": lines, "status": status,
                          "computed": min(x["computed"], rows) if rows else x["computed"],
                          "queries": sorted(set(q for q in x["queries"] if q)), "read_lines": min(read_lines, lines or read_lines),
                          "shown": len(x["shown"]), "searched": x["searched"], "matched": x["matched"], "named": x["named"]})
    groups: dict[str, dict[str, Any]] = {}
    for f, g in S.group_of(files).items():
        e = next(o for o in out_files if o["path"] == f)
        G = groups.setdefault(g, {"group": g, "files": 0, "rows": 0, "by_status": defaultdict(int), "computed": 0})
        G["files"] += 1
        G["rows"] += e["rows"]
        G["by_status"][e["status"]] += 1
        G["computed"] += e["computed"]
    for G in groups.values():
        G["by_status"] = dict(G["by_status"])
    not_read = [o for o in out_files if o["status"] == "not read"]
    return {"root": str(st.root), "session": st.session if session == "" else session, "files": out_files,
            "groups": sorted(groups.values(), key=lambda g: -g["rows"]),
            "total": {"files": len(files), "rows": sum(o["rows"] for o in out_files),
                      "not_read_files": len(not_read), "not_read_rows": sum(o["rows"] for o in not_read)}}


def file_line(o: dict[str, Any]) -> str:
    s = o["status"]
    rows = o["rows"]
    bits = []
    if o["computed"]:
        whole = o["computed"] >= rows > 0
        bits.append(f"computed over {'all ' + format(rows, ',') if whole else format(o['computed'], ',') + ' of ' + format(rows, ',')} rows"
                    + (f" ({', '.join(o['queries'][:4])})" if o["queries"] else ""))
    if o["read_lines"]:
        unit = "lines" if o["kind"] not in ("jsonl", "transcript") else "rows"
        bits.append(f"read {o['read_lines']:,} of {o['lines']:,} {unit}")
    if o["shown"]:
        bits.append(f"{o['shown']:,} row{'s' if o['shown'] != 1 else ''} shown")
    if o["searched"] and s != "computed":
        bits.append("searched" + (f" ({o['matched']} hits)" if o["matched"] else ""))
    if o["named"] and not bits:
        bits.append("named in a shell command (what it read is not known)")
    if not bits:
        bits.append(f"not read ({rows:,} rows)")
    return "; ".join(bits)


def coverage_text(cov: dict[str, Any], max_lines: int = 40) -> str:
    t = cov["total"]
    head = f"Coverage of {'every session' if cov['session'] is None else 'this session'} · {t['files']:,} source files, {t['rows']:,} rows"
    lines = [head]
    many = len(cov["files"]) > max_lines
    if not many:
        for o in sorted(cov["files"], key=lambda o: (["computed", "read", "searched", "named", "not read"].index(o["status"]), o["path"])):
            lines.append(f"  {o['status']:<9} {o['path']}  {file_line(o)}")
    else:
        order = ["computed", "read", "searched", "named", "not read"]
        shown = [g for g in cov["groups"] if g["files"] > 1 or set(g["by_status"]) != {"not read"}][:12]
        for g in shown:
            st = g["by_status"]
            parts = [f"{n} {k}" for k, n in sorted(st.items(), key=lambda kv: order.index(kv[0]))]
            lines.append(f"  {g['group']}  {g['files']:,} file{'s' if g['files'] != 1 else ''}, {g['rows']:,} rows: {', '.join(parts)}")
        others = [g for g in cov["groups"] if g not in shown]
        if others:
            lines.append(f"  {sum(g['files'] for g in others):,} other files ({sum(g['rows'] for g in others):,} rows): "
                         + ", ".join(f"{sum(g['by_status'].get(k, 0) for g in others)} {k}" for k in order if any(g['by_status'].get(k) for g in others)))
        touched = [o for o in cov["files"] if o["status"] != "not read"]
        if touched:
            lines.append("  touched:")
            for o in touched[:15]:
                lines.append(f"    {o['status']:<9} {o['path']}  {file_line(o)}")
            if len(touched) > 15:
                lines.append(f"    … and {len(touched) - 15} more")
    nr = [o for o in cov["files"] if o["status"] == "not read"]
    if nr:
        names = ", ".join(o["path"] for o in nr[:6]) + (f" and {len(nr) - 6} more" if len(nr) > 6 else "")
        lines.append(f"Not read: {len(nr):,} file{'s' if len(nr) != 1 else ''} ({t['not_read_rows']:,} rows): {names}")
    else:
        lines.append("Every source file was touched.")
    return "\n".join(lines)


def object_coverage(st: Store, obj: dict[str, Any]) -> dict[str, Any]:
    """Which source files feed an object's values, and which do not."""
    files = S.list_sources(st.root)
    cnt = S.counts(st.root, files, st.cache / "counts.json")
    rows = (obj.get("lineage") or {}).get("rows") or {}
    feeding = []
    for f in files:
        if f in rows:
            feeding.append({"path": f, "rows": rows[f]["count"], "of": cnt.get(f, {}).get("rows", 0)})
    used = {x["path"] for x in feeding}
    for q in ((obj.get("lineage") or {}).get("queries") or {}).values():
        for x in q.get("inputs") or []:
            if x["path"] not in used and x["path"] in cnt:
                feeding.append({"path": x["path"], "rows": None, "of": cnt[x["path"]].get("rows", 0), "how": "read by a query; no rows per value"})
                used.add(x["path"])
    others = [f for f in files if f not in used]
    return {"object": obj["id"], "feeding": feeding, "not_feeding": others,
            "session": (obj.get("lineage") or {}).get("coverage")}
