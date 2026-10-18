"""lean: thimble's kernel as one command, which Claude runs with the Bash tool, so every call goes through the
session's permission mode and sandbox like any other command.

    lean sources [GLOB]                     the source files here: kind, rows, size
    lean rows TARGET [--where EXPR] [--search RE] [-n 5] [--first] [--fields a,b]
                                            rows with their refs: one ref, or a random sample of a file or glob
    lean q "what it answers" <<'PY' ... PY  run Python over the sources; keeps the code, inputs, output and the rows
                                            behind each output row (lean q --rerun q3 runs a query again)
    lean save [NAME] [--rerun] <<'JSON' ... JSON   (or --from FILE)
                                            save an object (program + data + lineage) or a new version of one
    lean list [NAME]                        the objects, or one object with its lineage
    lean resolve REF [-n 5] [--random]      where a value came from, down to its source rows
    lean coverage [NAME] [--all]            what was read and what was not (of this session, or of an object)
    lean trace [REF] [--text PASSAGE] [--in GLOB]
                                            where it came from and where it went: the path back to its rows, what
                                            uses it (queries, objects, answers), and in transcripts who read a
                                            passage and who wrote it after reading it

Add --json to sources, q, list, resolve, coverage or trace for the whole record.
"""
from __future__ import annotations

import argparse
import json
import random
import re
import sys
from pathlib import Path
from typing import Any

from . import lineage as LIN
from . import objects as O
from . import query as Q
from . import refs as R
from . import sources as S
from .store import Store


def stdin_text(wait: float = 1.0) -> str:
    """stdin when it holds input (a heredoc or a pipe); the Bash tool's open stdin with nothing on it reads as ''."""
    import select

    if sys.stdin is None or sys.stdin.isatty():
        return ""
    try:
        r, _, _ = select.select([sys.stdin], [], [], wait)
    except (OSError, ValueError):
        return sys.stdin.read()
    return sys.stdin.read() if r else ""


def fmt(n: Any) -> str:
    return f"{n:,}" if isinstance(n, int) else str(n)


def out_json(v: Any) -> None:
    print(json.dumps(v, indent=1, ensure_ascii=False, default=str))


# ------------------------------------------------------------------ sources and rows


def cmd_sources(a: argparse.Namespace) -> int:
    st = Store()
    files = S.expand_glob(st.root, a.glob) if a.glob else S.list_sources(st.root)
    files = [f for f in files if S.kind_of(Path(f))]
    cnt = S.counts(st.root, files, st.cache / "counts.json")
    if a.json:
        out_json([{"path": f, **{k: v for k, v in cnt.get(f, {}).items() if k != "key"}} for f in files])
        return 0
    if len(files) <= 40:
        for f in files:
            c = cnt.get(f, {})
            print(f"{f}  {c.get('kind')}  {fmt(c.get('rows', 0))} rows  {c.get('size', 0) / 1e6:.1f} MB")
    else:
        groups: dict[str, list[str]] = {}
        for f, g in S.group_of(files).items():
            groups.setdefault(g, []).append(f)
        ranked = sorted(groups.items(), key=lambda kv: -sum(cnt.get(f, {}).get("rows", 0) for f in kv[1]))
        top, rest = ranked[:12], ranked[12:]
        for g, fs in top:
            kinds = sorted({str(cnt.get(f, {}).get("kind")) for f in fs})
            rows = sum(cnt.get(f, {}).get("rows", 0) for f in fs)
            size = sum(cnt.get(f, {}).get("size", 0) for f in fs)
            print(f"{g}  {len(fs)} file{'s' if len(fs) != 1 else ''}  {'/'.join(kinds)}  {fmt(rows)} rows  {size / 1e6:.1f} MB")
        by_top: dict[str, list[str]] = {}
        for _, fs in rest:
            for f in fs:
                by_top.setdefault(f.split("/")[0] + ("/" if "/" in f else ""), []).append(f)
        for t, fs in sorted(by_top.items(), key=lambda kv: -len(kv[1])):
            kinds = sorted({str(cnt.get(f, {}).get("kind")) for f in fs})
            rows = sum(cnt.get(f, {}).get("rows", 0) for f in fs)
            print(f"{t}…  {len(fs)} more files  {'/'.join(kinds)}  {fmt(rows)} rows  (lean sources '{t}**' lists them)")
    total = sum(c.get("rows", 0) for c in cnt.values())
    print(f"\n{len(files):,} source files, {total:,} rows under {st.root}. A row's ref is its stable id: cite it as [↗](<ref>).")
    return 0


class Rec(dict):
    """A row for --where: r.x or r['x'] reads a field, a missing one reads None."""

    def __getattr__(self, k: str) -> Any:
        return self.get(k)

    def __missing__(self, k: str) -> Any:
        return None


def shorten(v: Any, width: int, fields: list[str] | None) -> str:
    if isinstance(v, dict):
        if fields:
            v = {k: v.get(k) for k in fields}

        def cut(x: Any) -> Any:
            if isinstance(x, str) and len(x) > width:
                return x[:width] + f"… (+{len(x) - width} chars)"
            if isinstance(x, list):
                return [cut(y) for y in x[:8]] + ([f"… (+{len(x) - 8} items)"] if len(x) > 8 else [])
            if isinstance(x, dict):
                return {k: cut(y) for k, y in x.items()}
            return x

        return json.dumps(cut(v), ensure_ascii=False, default=str)
    s = str(v)
    return s if len(s) <= width * 2 else s[: width * 2] + f"… (+{len(s) - width * 2} chars)"


def cmd_rows(a: argparse.Namespace) -> int:
    st = Store()
    width, fields = a.width, [f for f in (a.fields or "").split(",") if f] or None
    if "#" in a.target:
        try:
            p = R.parse(a.target)
            if p["kind"] in ("query", "object"):
                print(f"{a.target} is a value, not a source row: `lean resolve {a.target}` shows its rows")
                return 1
            if p["kind"] != "file" or not p.get("locator"):
                rows = S.fetch(st.root, a.target, limit=a.n if p["kind"] not in ("block",) else None)
                for row in rows:
                    print(f"{row.ref}  {shorten(row.value, max(width, 4000), fields)}")
                total = R.count([a.target]) if p["kind"] not in ("file", "table") else len(rows)
                if total > len(rows):
                    print(f"\n{len(rows)} of {total:,} rows in {a.target}, the first in file order.")
                st.log({"kind": "rows", "how": "ref", "target": a.target, "shown": [r.ref for r in rows]})
                return 0
        except R.RefError as e:
            print(f"{a.target}: {e}")
            return 1
    files = S.expand_glob(st.root, a.target)
    if not files:
        print(f"no source file matches {a.target!r} under {st.root}")
        return 1
    rx = re.compile(a.search, re.I) if a.search else None
    where = compile(a.where, "<where>", "eval") if a.where else None
    rng = random.Random(a.seed)
    kept: list[S.Row] = []
    matched = total = 0
    for rel in files:
        for row in S.iter_rows(st.root, rel):
            total += 1
            if rx and not rx.search(row.raw):
                continue
            if where is not None:
                r = Rec(row.value) if isinstance(row.value, dict) else row.value
                try:
                    ok = eval(where, {"re": re, "len": len, "str": str, "int": int, "float": float, "any": any, "all": all},
                              {"r": r, "text": row.raw})
                except Exception:  # noqa: BLE001 — a row the expression cannot read does not match
                    ok = False
                if not ok:
                    continue
            matched += 1
            if len(kept) < a.n:
                kept.append(row)
            elif not a.first:  # reservoir sampling: the n shown are a random sample of every match
                j = rng.randrange(matched)
                if j < a.n:
                    kept[j] = row
            elif not (rx or where):
                break
    if not a.first:
        kept.sort(key=lambda r: (r.ref.split("#")[0], LIN._num(r.ref)))
    for row in kept:
        print(f"{row.ref}  {shorten(row.value, width, fields)}")
    how = "the first in file order" if a.first else f"chosen at random (seed {a.seed})"
    cond = " matching" if (rx or where) else ""
    if a.first and not (rx or where):
        cnt = S.counts(st.root, files, st.cache / "counts.json")
        all_rows = sum(c.get("rows", 0) for c in cnt.values())
        where_ = files[0] if len(files) == 1 else f"{len(files)} files"
        print(f"\nthe first {len(kept)} of {fmt(all_rows)} rows in {where_}. Cite one as [↗](<ref>).")
    else:
        scope = f"{fmt(total)} in {files[0]}" if len(files) == 1 else f"{fmt(total)} in {len(files)} files"
        print(f"\n{len(kept)} of {fmt(matched)}{cond} rows (of {scope}), {how}. Cite one as [↗](<ref>).")
    scanned = files if (rx or where) else []
    st.log({"kind": "rows", "how": "first" if a.first else "random", "target": a.target, "search": a.search,
            "where": a.where, "matched": matched, "total": total, "scanned": scanned, "shown": [k.ref for k in kept]})
    return 0


# ------------------------------------------------------------------ queries


def cmd_q(a: argparse.Namespace) -> int:
    st = Store()
    try:
        import pandas  # noqa: F401
    except ImportError:
        print("lean q needs pandas: set LEAN_PYTHON to a Python that has it, or install it (pip install pandas)")
        return 2
    if a.rerun:
        old = Q.get(st, a.rerun)
        if not old:
            print(f"no query {a.rerun}")
            return 1
        q = Q.run(st, old.get("about") or "", old["code"], rerun_of=old["id"])
        if a.json:
            out_json(q)
            return 1 if q["error"] else 0
        same = q["out_hash"] == old.get("out_hash")
        changed = Q.stale_inputs(st, old)
        print(f"{q['id']} ran {old['id']} again: its output is {'the same' if same else 'different'}"
              + (f"; changed inputs: {', '.join(changed)}" if changed else ""))
        if not same:
            print(_cut(q["stdout"]))
        return 1 if q["error"] else 0
    code = a.code if a.code else stdin_text()
    if not code.strip():
        print("no code: pass it on stdin, as in lean q \"what it answers\" <<'PY' ... PY")
        return 2
    q = Q.run(st, a.about, code)
    if a.json:
        out_json(q)
        return 1 if q["error"] else 0
    print(f"{q['id']} · {a.about}")
    print(_cut(q["stdout"], q["id"]).rstrip())
    cnt = S.counts(st.root, [x["path"] for x in q["inputs"]], st.cache / "counts.json")
    read = []
    for x in q["inputs"]:
        tot = cnt.get(x["path"], {}).get("rows")
        got = x.get("rows_read")
        read.append(f"{x['path']} ({fmt(got)} of {fmt(tot)} rows)" if got and tot else f"{x['path']} (opened)")
    tail = [f"\n{q['id']} {'FAILED: ' + q['error'] if q['error'] else 'done'} in {q['seconds']}s"]
    if read:
        tail.append("read " + ", ".join(read[:6]) + (f" and {len(read) - 6} more files" if len(read) > 6 else ""))
    if q.get("uses"):
        tail.append("uses " + ", ".join(u["name"] if u["name"] == u["query"] else f"{u['name']} (kept by {u['query']})" for u in q["uses"]))
    if q.get("kept"):
        tail.append("kept " + ", ".join(q["kept"]))
    if q["external"]:
        tail.append(f"read {len(q['external'])} file(s) outside the folder ({', '.join(q['external'][:2])}), which no lineage traces")
    print(" · ".join(tail))
    if not q["error"] and q.get("table") is not None:
        # a query that only printed has no output rows to keep: nothing to say about them
        print(_lineage_line(q))
    return 1 if q["error"] else 0


def _cut(s: str, qid: str | None = None) -> str:
    if len(s) <= Q.CUT:
        return s
    return s[: Q.CUT] + f"\n… ({len(s) - Q.CUT:,} more characters" + (f", kept in {qid})" if qid else ")")


def _lineage_line(q: dict[str, Any]) -> str:
    mode = q.get("lineage")
    ex = Q.cite_example(q)
    say = {
        "exact": "Each output row keeps its source rows.",
        "matched": f"Each output row keeps its source rows (found by {', '.join(q.get('keys') or [])} in `{q.get('frame')}`; the counts agree).",
        "key": f"Each output row keeps the rows that share its {', '.join(q.get('keys') or [])} in `{q.get('frame')}` (no count to check them by).",
        "superset": f"The rows found by {', '.join(q.get('keys') or [])} in `{q.get('frame')}` hold more than the counts: tally() keeps them exactly.",
        "query": "No rows per output row: each value rests on all the rows read (tally() keeps them per row).",
    }.get(mode or "query", "")
    return say + (f" Cite a value as {ex}." if ex else "")


# ------------------------------------------------------------------ objects


def cmd_save(a: argparse.Namespace) -> int:
    st = Store()
    raw = Path(a.spec_file).read_text() if a.spec_file else stdin_text()
    spec: dict[str, Any] = {}
    if raw.strip():
        try:
            spec = json.loads(raw)
        except ValueError as e:
            print(f"lean save reads one JSON object on stdin: {e}")
            return 2
        if not isinstance(spec, dict):
            print("lean save reads one JSON object on stdin")
            return 2
    if a.program:
        spec["program"] = Path(a.program).read_text()
    existing = O.find_id(st, a.name) if a.name else None
    if existing and (a.rerun or not raw.strip() or a.merge):
        obj, renamed = O.update(st, existing, spec, rerun=a.rerun, change=a.change)
        if renamed:
            print("ran again: " + ", ".join(f"{k} → {v}" for k, v in renamed.items()))
    elif a.rerun:
        print(f"no object {a.name} to run again")
        return 1
    elif not spec:
        print("nothing to save: pass the object as JSON on stdin")
        return 2
    else:
        obj = O.save(st, a.name, spec, a.change)
    lin = obj["lineage"]
    print(f"saved {obj['id']} v{obj['version']}: thimble/objects/{obj['id']}.json")
    for b in lin["bindings"]:
        print(f"  {b['at'] or '/'} ← {b['ref']} ({b.get('lineage')})")
    cites = lin["cites"]
    ok = [c for c in cites if not c.get("problem")]
    if cites:
        print(f"  {len(ok)} of {len(cites)} citations hold")
    for p in lin["problems"]:
        print(f"  problem: {p}")
    rows = lin["rows"]
    if rows:
        print("  source rows behind its values: " + ", ".join(f"{f} ({x['count']:,})" for f, x in list(rows.items())[:6]))
    t = lin["coverage"]["total"]
    if t["not_read_files"]:
        print(f"  this session has not read {t['not_read_files']:,} of {t['files']:,} source files ({t['not_read_rows']:,} rows)")
    ex = _value_example(obj)
    if ex:
        print(f"Cite or resolve one of its values as {ex}.")
    return 0


def _value_example(obj: dict[str, Any]) -> str | None:
    def find(v: Any, ptr: str) -> str | None:
        if isinstance(v, dict):
            if v.get("_rows"):
                for k, x in v.items():
                    if not k.startswith("_") and isinstance(x, (int, float)) and not isinstance(x, bool):
                        return f"{ptr}/{k}"
                return ptr
            for k, x in v.items():
                got = find(x, f"{ptr}/{k}")
                if got:
                    return got
        elif isinstance(v, list):
            for i, x in enumerate(v[:50]):
                got = find(x, f"{ptr}/{i}")
                if got:
                    return got
        return None

    p = find(obj.get("data"), "")
    return f"obj:{obj['id']}#{p}" if p else None


def cmd_list(a: argparse.Namespace) -> int:
    st = Store()
    if not a.name:
        objs = [O.load(st, i) for i in O.all_ids(st)]
        if a.json:
            out_json([{k: o.get(k) for k in ("id", "version", "title", "updated")} for o in objs if o])
            return 0
        if not objs:
            print("no objects yet: lean save makes one")
        for o in objs:
            if o:
                print(O.summary_line(o))
        return 0
    obj = O.load(st, a.name)
    if not obj:
        print(f"no object {a.name}; objects: {', '.join(O.all_ids(st)) or 'none'}")
        return 1
    if a.json:
        out_json(obj)
        return 0
    lin = obj.get("lineage") or {}
    print(O.summary_line(obj))
    for h in obj.get("history") or []:
        print(f"  v{h['v']} {h['at']} {h.get('change') or ''}")
    for qid, q in sorted((lin.get("queries") or {}).items(), key=lambda kv: int(kv[0][1:])):
        stale = Q.stale_inputs(st, q)
        inputs = q.get("inputs") or []
        ins = ", ".join(f"{x['path']} ({fmt(x.get('rows_read'))} rows)" for x in inputs[:3])
        if len(inputs) > 3:
            ins += f" and {len(inputs) - 3} more files ({fmt(sum(x.get('rows_read') or 0 for x in inputs[3:]))} rows)"
        print(f"  {qid} · {q.get('about')} · reads {ins or 'nothing'} · rows: {q.get('lineage')}" + (f" · CHANGED: {', '.join(stale)}" if stale else ""))
    for b in lin.get("bindings") or []:
        print(f"  data{b['at'] or '/'} ← {b['ref']}")
    for c in lin.get("cites") or []:
        print(f"  cite in {c['in']}: {c['ref']}" + (f" (problem: {c['problem']})" if c.get("problem") else ""))
    if lin.get("declared"):
        print(f"  declared: {json.dumps(lin['declared'], ensure_ascii=False)[:400]}")
    return 0


# ------------------------------------------------------------------ lineage


def cmd_resolve(a: argparse.Namespace) -> int:
    st = Store()
    try:
        r = LIN.resolve(st, a.ref, n=a.n, pick="random" if a.random else "first")
    except R.RefError as e:
        print(f"{a.ref}: {e}")
        return 1
    if a.json:
        out_json(r)
        return 0
    for step in r["chain"]:
        k = step["step"]
        if k == "object":
            print(f"object {step['id']} v{step.get('version')}" + (f" · {step.get('title')}" if step.get("title") else "")
                  + (f" · at {step['at']} = {json.dumps(step.get('value'), ensure_ascii=False, default=str)[:200]}" if "at" in step else ""))
        elif k == "binding":
            print(f"  ← bound from {step['from']} (data{step['at'] or '/'})")
        elif k == "query":
            print(f"  ← query {step['id']} · {step.get('about')} · rows: {step.get('lineage')}"
                  + (f" in `{step['frame']}`" if step.get("frame") else ""))
            code = (step.get("code") or "").strip().splitlines()
            for line in code[:12]:
                print(f"      {line}")
            if len(code) > 12:
                print(f"      … ({len(code) - 12} more lines)")
            for row in step.get("rows") or []:
                print(f"    output row {row['i']}: {json.dumps({k: v for k, v in row.items() if k != 'i'}, ensure_ascii=False, default=str)[:300]}")
            if "value" in step:
                print(f"    value: {step['value']}")
        elif k == "source":
            print(f"source {step['ref']} ({step.get('kind')})")
        if step.get("check"):
            print(f"    check: {step['check']}")
    if r.get("rows"):
        cut = lambda x: x if len(x) <= 160 else x[:157] + "…"  # noqa: E731
        shown = ", ".join(cut(x) for x in r["rows"][:4]) + (f" and {len(r['rows']) - 4} more row sets" if len(r["rows"]) > 4 else "")
        cnt = r.get("count")
        print(f"  ← {fmt(cnt) + ' source rows' if cnt is not None else 'whole files'}: {shown}")
    for note in r.get("notes") or []:
        print(f"  note: {note}")
    if r.get("error"):
        print(f"  problem: {r['error']}")
    recs = r.get("records") or []
    if recs:
        how = "at random" if a.random else "the first in file order"
        print(f"\n{len(recs)} of them, {how}:")
        for x in recs:
            print(f"  {x['ref']}  {x['text']}")
    return 0


def cmd_coverage(a: argparse.Namespace) -> int:
    st = Store()
    if a.name:
        obj = O.load(st, a.name)
        if not obj:
            print(f"no object {a.name}")
            return 1
        c = LIN.object_coverage(st, obj)
        if a.json:
            out_json(c)
            return 0
        print(f"{obj['id']}: its values come from {len(c['feeding'])} of {len(c['feeding']) + len(c['not_feeding'])} source files")
        for x in c["feeding"]:
            print(f"  {x['path']}  " + (f"{x['rows']:,} of {x['of']:,} rows" if x.get("rows") is not None else x.get("how", "")))
        if c["not_feeding"]:
            nf = c["not_feeding"]
            print(f"  not used: {len(nf)} files: {', '.join(nf[:8])}" + (f" and {len(nf) - 8} more" if len(nf) > 8 else ""))
        s = c.get("session")
        if s:
            t = s["total"]
            print(f"When it was saved, the session had not read {t['not_read_files']:,} of {t['files']:,} source files ({t['not_read_rows']:,} rows).")
        return 0
    cov = LIN.coverage(st, None if a.all else "")
    if a.json:
        out_json(cov)
        return 0
    print(LIN.coverage_text(cov))
    return 0


def cmd_trace(a: argparse.Namespace) -> int:
    from . import trace as T

    st = Store()
    if not a.ref and not a.text:
        print("lean trace needs a ref (a value, a row, a transcript block) or --text with the words to follow")
        return 2
    try:
        r = T.trace(st, a.ref, a.text, a.within, answers=not a.no_answers, n=a.n)
    except (R.RefError, ValueError) as e:
        print(f"{a.ref or a.text}: {e}")
        return 1
    if a.json:
        out_json(r)
        return 0
    print(T.text_of(r))
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="lean", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd")
    p = sub.add_parser("sources", help="the source files here")
    p.add_argument("glob", nargs="?")
    p.add_argument("--json", action="store_true")
    p.set_defaults(fn=cmd_sources)
    p = sub.add_parser("rows", help="rows with their refs")
    p.add_argument("target")
    p.add_argument("--where", help="keep rows for which this Python expression is true (r is the row, text its raw text)")
    p.add_argument("--search", help="keep rows whose raw text matches this regex")
    p.add_argument("-n", type=int, default=5)
    p.add_argument("--seed", type=int, default=0)
    p.add_argument("--first", action="store_true", help="the first rows in file order, not a random sample")
    p.add_argument("--fields")
    p.add_argument("--width", type=int, default=300)
    p.set_defaults(fn=cmd_rows)
    p = sub.add_parser("q", aliases=["query"], help="run Python over the sources and keep its lineage",
                       description=Q.__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("about", nargs="?", default="", help="what the query answers, in a few words")
    p.add_argument("--code")
    p.add_argument("--rerun", metavar="QID")
    p.add_argument("--json", action="store_true")
    p.set_defaults(fn=cmd_q)
    p = sub.add_parser("save", help="save an object, or a new version of one")
    p.add_argument("name", nargs="?")
    p.add_argument("--from", dest="spec_file", metavar="FILE", help="read the object's JSON from this file, not stdin")
    p.add_argument("--program", help="read the program from this file")
    p.add_argument("--rerun", action="store_true", help="run its queries again and bind the new results")
    p.add_argument("--merge", action="store_true", help="merge the JSON into the object's spec, not replace it")
    p.add_argument("--change", help="what this version changes, in a few words")
    p.set_defaults(fn=cmd_save)
    p = sub.add_parser("list", help="the objects, or one object with its lineage")
    p.add_argument("name", nargs="?")
    p.add_argument("--json", action="store_true")
    p.set_defaults(fn=cmd_list)
    p = sub.add_parser("resolve", aliases=["from"], help="where a value came from, down to its source rows")
    p.add_argument("ref")
    p.add_argument("-n", type=int, default=5)
    p.add_argument("--random", action="store_true")
    p.add_argument("--json", action="store_true")
    p.set_defaults(fn=cmd_resolve)
    p = sub.add_parser("coverage", help="what was read and what was not")
    p.add_argument("name", nargs="?")
    p.add_argument("--all", action="store_true", help="every session, not only this one")
    p.add_argument("--json", action="store_true")
    p.set_defaults(fn=cmd_coverage)
    p = sub.add_parser("trace", help="where it came from and where it went")
    p.add_argument("ref", nargs="?")
    p.add_argument("--text", help="the words to follow through transcripts: who read them, who wrote them")
    p.add_argument("--in", dest="within", metavar="GLOB", help="the transcripts to look in (default: the ref's own folder)")
    p.add_argument("-n", type=int, default=3, help="source rows read back")
    p.add_argument("--no-answers", action="store_true", help="skip the session transcripts (Claude's cited answers)")
    p.add_argument("--json", action="store_true")
    p.set_defaults(fn=cmd_trace)
    a = ap.parse_args(argv)
    if not getattr(a, "fn", None):
        print(__doc__.strip())
        return 0
    return a.fn(a)
