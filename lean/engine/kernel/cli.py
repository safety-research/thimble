"""thimble: thimble's kernel as one command, which Claude runs with the Bash tool, so every call goes through the
session's permission mode and sandbox like any other command.

    thimble sources [GLOB]                     the source files here: kind, rows, size
    thimble rows TARGET [--where EXPR] [--search RE] [--label NAME=VALUE] [-n 5] [--first] [--fields a,b]
                                               rows with their refs: one ref, or a random sample of a file or glob
    thimble run "what it answers" <<'PY' ... PY
                                               run Python over the sources; keeps the code, inputs, output and the rows
                                               behind each output row, as r1, r2, ... (--rerun r3 runs r3 again)
    thimble save [NAME] [--rerun] <<'JSON' ... JSON   (or --from FILE)
                                               save a card (its program, data and lineage) or a new version of one
    thimble list [NAME]                        the cards, or one card with its lineage
    thimble resolve REF [-n 5] [--label WORDS] where a value came from, down to its source rows (a few of them, spread
                                               across the rows)
    thimble coverage [NAME] [--all]            what was read and what was not (of this session, or of a card)
    thimble trace [REF] [--text PASSAGE] [--in GLOB]
                                               where it came from and where it went: the path back to its rows, what
                                               uses it (runs, cards, answers), and in transcripts who read a
                                               passage and who wrote it after reading it
    thimble label [NAME]                       the labels, or one label's counts per value (each a citation)
    thimble label NAME --in GLOB (--regex RE | --code [FILE] | --prompt "DEFINITION") [--values yes,no]
                  [--where EXPR] [--within LABEL=VALUE] [--limit N] [--reason]
                                               give each record of GLOB one of the values, and draw the counts for the
                                               person as a card where they check records; a --prompt label's records
                                               wait for the model, which reads each one beside the session
                                               (--wait waits for it; thimble label --help says more)

In a run: load(glob, fields=[...]) gives a DataFrame with each row's `_ref`; tally(df, by) counts and keeps each
group's rows; use("r3") is an earlier run's output; keep(name, x) and use(name) pass a named result or a label on
(use of a `thimble label` gives each record's `_ref` and value); rows(glob), sample(df, n), pd, np, re, json. The
last expression is the output. `thimble run --help` says more.

Add --json to sources, run, list, resolve, coverage or trace for the whole record.
"""
from __future__ import annotations

import argparse
import json
import random
import re
import sys
import time
from pathlib import Path
from typing import Any

from . import labels as LB
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
            print(f"{t}…  {len(fs)} more files  {'/'.join(kinds)}  {fmt(rows)} rows  (thimble sources '{t}**' lists them)")
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
                print(f"{a.target} is a value, not a source row: `thimble resolve {a.target}` shows its rows")
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
    lab, lab_value, with_value = None, None, None
    if a.label:
        lname, _, lab_value = a.label.partition("=")
        lab = LB.load(st, lname.strip())
        if lab is None:
            print(f"--label names no label {lname.strip()!r}; labels: {', '.join(LB.names(st)) or 'none'}")
            return 1
        lab_value = lab_value.strip() or None
        with_value = {r for r in lab.get("units") or {} if (LB.value_of(lab, r) == lab_value if lab_value else True)}
    rng = random.Random(a.seed)
    kept: list[S.Row] = []
    matched = total = 0
    for rel in files:
        for row in S.iter_rows(st.root, rel):
            total += 1
            if with_value is not None and row.ref not in with_value:
                continue
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
            elif not (rx or where or with_value is not None):
                break
    if not a.first:
        kept.sort(key=lambda r: (r.ref.split("#")[0], LIN._num(r.ref)))
    for row in kept:
        tag = ""
        if lab is not None:
            u = (lab.get("units") or {}).get(row.ref) or {}
            c = (lab.get("checks") or {}).get(row.ref)
            how = "the person" if c else (u.get("by") or "")
            if not c and u.get("c") is not None and u.get("by") == "model":
                how += f" {u['c']:.2f}"
            tag = f"  [{lab['name']}: {LB.value_of(lab, row.ref)} · {how}" + (f": {u['why']}" if u.get("why") and not c else "") + "]"
        print(f"{row.ref}{tag}  {shorten(row.value, width, fields)}")
    how = "the first in file order" if a.first else f"chosen at random (seed {a.seed})"
    cond = " matching" if (rx or where or with_value is not None) else ""
    if a.first and not (rx or where or with_value is not None):
        cnt = S.counts(st.root, files, st.cache / "counts.json")
        all_rows = sum(c.get("rows", 0) for c in cnt.values())
        where_ = files[0] if len(files) == 1 else f"{len(files)} files"
        print(f"\nthe first {len(kept)} of {fmt(all_rows)} rows in {where_}. Cite one as [↗](<ref>).")
    else:
        scope = f"{fmt(total)} in {files[0]}" if len(files) == 1 else f"{fmt(total)} in {len(files)} files"
        print(f"\n{len(kept)} of {fmt(matched)}{cond} rows (of {scope}), {how}. Cite one as [↗](<ref>).")
    scanned = files if (rx or where or with_value is not None) else []
    st.log({"kind": "rows", "how": "first" if a.first else "random", "target": a.target, "search": a.search,
            "where": a.where, "matched": matched, "total": total, "scanned": scanned, "shown": [k.ref for k in kept]})
    return 0


# ------------------------------------------------------------------ queries


def cmd_q(a: argparse.Namespace) -> int:
    st = Store()
    try:
        import pandas  # noqa: F401
    except ImportError:
        print("thimble run needs pandas: set THIMBLE_PYTHON to a Python that has it, or install it (pip install pandas)")
        return 2
    if a.rerun:
        old = Q.get(st, a.rerun)
        if not old:
            print(f"no run {a.rerun}")
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
        print("no code: pass it on stdin, as in thimble run \"what it answers\" <<'PY' ... PY")
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
        "loop": f"Each output row keeps the rows its loop iteration held when it appended the record to `{q.get('frame')}` (what it loaded and filtered); a count that equals one of those frames opens that frame's rows.",
        "summary": "A summary of the rows it read: each value rests on all of them, except a count that equals one frame's rows (tally() keeps the rows per value).",
        "query": "No rows per output row: each value rests on all the rows read (tally() keeps them per row).",
    }.get(mode or "query", "")
    if q.get("lineage_error"):
        say = (f"No rows per output row: thimble could not find them ({q['lineage_error']}), so each value rests on all the "
               "rows read (tally() keeps them per row).")
    how = Q.loop_source(q) if mode == "loop" else None
    if how == "opened":
        # the records rest on the files each pass opened, not on frames it loaded
        say = (f"Each output row keeps the rows of the files its loop opened for its records in `{q.get('frame')}` (a JSON "
               "document is one row); a `_ref` column keeps finer rows.")
    elif how == "kept":
        # rows of a table an earlier query kept, grouped: each rests on what that query found for it
        by = next((u.get("query") for u in q.get("uses") or [] if u.get("name") == q.get("frame")), None)
        say = (f"Each output row keeps the rows behind the rows of `{q.get('frame')}` it groups (found by "
               f"{', '.join(q.get('keys') or [])}" + (f", as {by} kept them" if by else "") + ").")
    if q.get("cells") and mode != "loop" and q.get("loop"):
        say += f" A count its loop kept rows for (in `{q.get('loop')}`) opens those rows."
    elif q.get("cells") and q.get("cells_by"):
        say += f" A count named by a value of `{q['cells_by']}` opens the rows of its group that hold that value."
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
            print(f"thimble save reads one JSON object on stdin: {e}")
            return 2
        if not isinstance(spec, dict):
            print("thimble save reads one JSON object on stdin")
            return 2
    if a.program:
        spec["program"] = Path(a.program).read_text()
    existing = O.find_id(st, a.name) if a.name else None
    if existing and (a.rerun or not raw.strip() or a.merge):
        obj, renamed = O.update(st, existing, spec, rerun=a.rerun, change=a.change)
        if renamed:
            print("ran again: " + ", ".join(f"{k} → {v}" for k, v in renamed.items()))
    elif a.rerun:
        print(f"no card {a.name} to run again")
        return 1
    elif not spec:
        print("nothing to save: pass the card as JSON on stdin")
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
    narrowed = [c for c in cites if c.get("wrote")]
    if narrowed:
        print(f"  {len(narrowed)} citation{'s' if len(narrowed) != 1 else ''} named more than one value; each opens the "
              f"row that holds the value its words show, as {narrowed[0]['wrote']} → {narrowed[0]['ref']}")
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
            print("no cards yet: thimble save makes one")
        for o in objs:
            if o:
                print(O.summary_line(o))
        return 0
    obj = O.load(st, a.name)
    if not obj:
        print(f"no card {a.name}; cards: {', '.join(O.all_ids(st)) or 'none'}")
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
        pick = "random" if a.random else "first" if a.first else "spread"
        if len(a.ref) > 1:
            r = LIN.resolve_many(st, a.ref, n=a.n, pick=pick)
        else:
            r = LIN.resolve(st, a.ref[0], n=a.n, pick=pick, label=a.label)
    except R.RefError as e:
        print(f"{' '.join(a.ref)}: {e}")
        return 1
    _label_rows_of(st, r)
    if a.json:
        out_json(r)
        return 0
    for step in r["chain"]:
        k = step["step"]
        if k == "object":
            print(f"card {step['id']} v{step.get('version')}" + (f" · {step.get('title')}" if step.get("title") else "")
                  + (f" · at {step['at']} = {json.dumps(step.get('value'), ensure_ascii=False, default=str)[:200]}" if "at" in step else ""))
        elif k == "binding":
            print(f"  ← bound from {step['from']} (data{step['at'] or '/'})")
        elif k == "query":
            print(f"  ← run {step['id']} · {step.get('about')} · rows: {step.get('lineage')}"
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
        elif k == "selection":
            print(f"{step['refs']} refs" + (f" of {', '.join(step['queries'])}" if step.get("queries") else ""))
        if step.get("check"):
            print(f"    check: {step['check']}")
    if r.get("rows"):
        cut = lambda x: x if len(x) <= 160 else x[:157] + "…"  # noqa: E731
        shown = ", ".join(cut(x) for x in r["rows"][:4]) + (f" and {len(r['rows']) - 4} more row sets" if len(r["rows"]) > 4 else "")
        cnt = r.get("count")
        print(f"  ← {fmt(cnt) + ' source rows' if cnt is not None else 'whole files'}: {shown}")
    for note in r.get("notes") or []:
        print(f"  note: {note}")
    if r.get("why"):
        print(f"  why: {r['why']}")
    if r.get("error"):
        print(f"  problem: {r['error']}")
    for lname, b in (r.get("labels") or {}).items():
        split = " · ".join(f"{n:,} {v}" for v, n in b["values"].items())
        print(f"  label {lname}: {split}" + (f" (it holds {b['of']:,} of these {b['rows']:,} rows)" if b["of"] != b["rows"] else ""))
    recs = r.get("records") or []
    if recs:
        how = "at random" if a.random else "the first in file order" if a.first else "spread across them"
        print(f"\n{len(recs)} of them, {how}:")
        for x in recs:
            tag = "".join(f"  [{k}: {v}]" for k, v in (x.get("labels") or {}).items())
            print(f"  {x['ref']}{tag}  {x['text']}")
    return 0


def _label_rows_of(st: Store, r: dict[str, Any]) -> None:
    """The labels of what a resolve found: how its rows split by each label that holds some of them, and each record's
    values. Nothing when the folder has no labels."""
    if not LB.names(st):
        return
    try:
        b = LB.breakdown(st, r.get("rows") or [])
        if b:
            r["labels"] = b
        recs = r.get("records") or []
        got = LB.of_refs(st, [x["ref"] for x in recs])
        for x in recs:
            if got.get(x["ref"]):
                x["labels"] = {k: v.get("value") for k, v in got[x["ref"]].items()}
                x["label_detail"] = got[x["ref"]]
    except Exception:  # noqa: BLE001 — a label that does not read leaves the resolve as it was
        pass


def cmd_coverage(a: argparse.Namespace) -> int:
    st = Store()
    if a.name:
        obj = O.load(st, a.name)
        if not obj:
            print(f"no card {a.name}")
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
        print("thimble trace needs a ref (a value, a row, a transcript block) or --text with the words to follow")
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


# ------------------------------------------------------------------ labels

LABEL_HELP = """A label gives every record of a scope one of a few values, and keeps each record's ref.

    thimble label                              the labels here, with their counts
    thimble label NAME                         its counts per value, each a citation; what waits; what the person checked
    thimble label NAME --in GLOB --regex RE    the first value where the record's text (as the file holds it) matches
    thimble label NAME --in GLOB --code FILE   label(unit) in Python returns a value, (value, confidence) or None; a
                                               unit is the record as a dict, with `_ref` and `_text` (or the code on
                                               stdin)
    thimble label NAME --in GLOB --prompt "DEFINITION"
                                               the model reads each record against the definition, in calls of up to
                                               50 records that run beside the session, through its own model
    thimble label NAME --set REF=VALUE ...     values you give records yourself, after reading them
    thimble label NAME --wait [SECONDS]        wait for the model's calls (default 600 s), then the counts
    thimble label NAME --again                 ask the model again for the records that got no value

    --values a,b,c      the values, the positive first (default yes,no)
    --where EXPR        only records for which this Python expression is true (r is the record, text its raw text)
    --within L=V        only records the label L gave the value V
    --limit N           a trial: N records at random; the same label without --limit then labels the rest
    --reason            the model also gives a one-line reason per record

The same definition again keeps the values it has and labels only records it has not seen. The counts are a run, so
`[38](r12#apology=yes@n)` cites the 38 records. In a run, use("apology") gives each record's `_ref` and value (a
column named as the label), and `thimble rows GLOB --label apology=yes` reads records with a value. The person sees the
label as a card under your reply, opens a value's records, and checks a sample of them: what they say a record is
counts in place of the label's value."""


def _parse_within(s: str | None) -> tuple[str, str] | None:
    if not s:
        return None
    if "=" not in s:
        raise LB.LabelError("--within takes LABEL=VALUE, such as --within apology=yes")
    k, v = s.split("=", 1)
    return k.strip(), v.strip()


def _label_lines(st: Store, lab: dict[str, Any]) -> list[str]:
    s = LB.status(lab)
    rule = str(lab.get("rule") or "")
    rule = rule if len(rule) <= 90 else rule[:89] + "…"
    head = f"label {lab['name']} v{lab.get('version')} · {lab.get('kind')}" + (f" {rule!r}" if rule and lab.get("kind") != "code" else "")
    head += f" · values {', '.join(lab['values'])}"
    scope = lab.get("in") or "records you named"
    if lab.get("where"):
        scope += f" where {lab['where']}"
    if lab.get("within"):
        scope += f" within {lab['within'][0]}={lab['within'][1]}"
    out = [head, f"  {s['records']:,} records of {scope}" + (f" (a trial: {s['records']:,} of {lab.get('matched', 0):,} at random)" if lab.get("trial") else "")]
    qid = lab.get("query")
    vals = lab["values"] + [v for v in s["counts"] if v not in lab["values"]]
    w = max(len(v) for v in vals) if vals else 4
    for v in (vals if s["valued"] or not s["waiting"] else []):
        n = s["counts"].get(v, 0)
        cite = f"  {LB._cite_value(qid, lab['name'], v)}" if qid and n else ""
        out.append(f"  {v:<{w}}  {n:>7,}{cite}")
    if s["waiting"]:
        out.append(f"  {s['waiting']:,} records wait for the model")
    if s["failed"]:
        why = next((u.get("err") for u in (lab.get("units") or {}).values() if u.get("v") is None and u.get("err")), "")
        out.append(f"  {s['failed']:,} records have no value" + (f" ({why})" if why else "")
                   + (f": `thimble label {lab['name']} --again` asks the model again" if lab.get("kind") == "prompt" else ""))
    if s["checked"]:
        out.append(f"  the person checked {s['checked']:,}: {s['agree']:,} agree, {s['disagree']:,} disagree")
    return out


def _recount(st: Store, name: str, card: bool = True) -> tuple[dict[str, Any], dict[str, Any] | None, dict[str, Any] | None]:
    """The label with its counts as of now: a new count query when it changed since the last, and a new version of its
    card when that is older than the label."""
    lab = LB.load(st, name)
    if lab is None:
        raise LB.LabelError(f"no label {name!r}; labels: {', '.join(LB.names(st)) or 'none'}")
    q = None
    if lab.get("counted_rev") != lab.get("rev") or not lab.get("query"):
        q = LB.count_query(st, name)
        lab = LB.load(st, name) or lab
    obj = None
    if card and (lab.get("card_rev") != lab.get("rev") or not lab.get("card") or q is not None):
        obj = LB.save_card(st, name, q)
        lab = LB.load(st, name) or lab
    return lab, q, obj


def _cite_hint(lab: dict[str, Any]) -> str:
    s = LB.status(lab)
    top = next((v for v in lab["values"] if s["counts"].get(v)), None)
    if not lab.get("query") or not top:
        return ""
    return (f"Cite a count as [{s['counts'][top]:,}]({LB._cite_value(lab['query'], lab['name'], top)}). In a run, "
            f"use({json.dumps(lab['name'])}) gives each record's `_ref` and value: merge it on `_ref`.")


def cmd_label(a: argparse.Namespace) -> int:
    st = Store()
    try:
        return _label(st, a)
    except LB.LabelError as e:
        print(f"thimble label: {e}")
        return 1


def _label(st: Store, a: argparse.Namespace) -> int:
    if a.of:
        out_json(LB.of_refs(st, a.of))
        return 0
    if not a.name:
        labs = [LB.load(st, n) for n in LB.names(st)]
        if a.json:
            out_json([{"name": x["name"], **LB.status(x), "query": x.get("query"), "card": x.get("card")} for x in labs if x])
            return 0
        if not labs:
            print("no labels yet: thimble label NAME --in GLOB --regex RE | --code FILE | --prompt \"DEFINITION\" makes one")
        for x in labs:
            if x:
                s = LB.status(x)
                print(f"{x['name']}  {x.get('kind')}  {s['records']:,} records: " + ", ".join(f"{v} {s['counts'].get(v, 0):,}" for v in x["values"])
                      + (f" · {s['waiting']:,} waiting" if s["waiting"] else "") + (f" · {s['checked']:,} checked" if s["checked"] else ""))
        return 0
    name = a.name
    if a.delete:
        p = LB.path(st, name)
        if not p.exists():
            print(f"no label {name}")
            return 1
        p.unlink()
        print(f"deleted the label {name} (its card and queries stay)")
        return 0
    if a.check:
        ref, value = a.check
        r = LB.check(st, name, ref, None if value in ("-", "none") else value)
        if a.json:
            out_json({"ref": r["ref"], "was": r["was"], "now": r["now"], **LB.status(r["label"])})
            return 0
        print(f"{r['ref']}: the person says {r['now']}" + (f" (the label gave {r['was']})" if r["was"] is not None else ""))
        return 0
    if a.waiting:
        out_json(LB.waiting(st, name))
        return 0
    if a.answers:
        raw = Path(a.answers).read_text() if a.answers != "-" else stdin_text(5.0)
        try:
            payload = json.loads(raw or "{}")
        except ValueError as e:
            print(f"thimble label --answers reads one JSON object: {e}")
            return 2
        r = LB.answers(st, name, payload)
        lab = r["label"]
        s = LB.status(lab)
        done = not s["waiting"]
        obj = None
        if done or payload.get("count"):
            lab, _, obj = _recount(st, name)
        res = {"took": r["took"], "failed": r["failed"], **LB.status(lab), "query": lab.get("query"),
               "card": {"id": obj["id"], "version": obj["version"]} if obj else None}
        if a.json:
            out_json(res)
        else:
            print(f"{name}: {r['took']:,} records took a value, {r['failed']:,} got none; {s['waiting']:,} still wait"
                  + (f" · saved {obj['id']} v{obj['version']}" if obj else ""))
        return 0
    if a.again:
        r = LB.again(st, name)
        if not r["waiting"]:
            print(f"{name}: every record has a value")
            return 0
        lab, _, obj = _recount(st, name)
        card = obj or ({"id": lab["card"], "version": None} if lab.get("card") else None)
        if card:
            st.emit({"kind": "verb", "verb": "label", "object": card["id"], "version": card["version"], "args": name})
        calls = len(LB.batches(LB.waiting(st, name)["units"]))
        print(f"{name}: {r['waiting']:,} records wait for the model ({calls} call{'s' if calls != 1 else ''}), which run "
              f"beside the session. `thimble label {name} --wait` waits for them.")
        return 0
    if a.set_values is not None:
        given: dict[str, str] = {}
        pairs = list(a.set_values)
        if not pairs:
            raw = stdin_text()
            try:
                got = json.loads(raw) if raw.strip() else {}
            except ValueError as e:
                print(f"thimble label --set reads REF=VALUE pairs, or one JSON object {{ref: value}} on stdin: {e}")
                return 2
            given = {str(k): str(v) for k, v in (got.items() if isinstance(got, dict) else [])}
        for x in pairs:
            if "=" not in x:
                print(f"--set takes REF=VALUE, not {x!r}")
                return 2
            k, v = x.rsplit("=", 1)
            given[k] = v
        if not given:
            print("nothing to set: give REF=VALUE pairs")
            return 2
        r = LB.set_values(st, name, given, a.values.split(",") if a.values else None)
        for b in r["bad"][:3]:
            print(f"  {b} names no record of a source file, so it got no value")
        lab, _, _ = _recount(st, name)
        for line in _label_lines(st, lab):
            print(line)
        hint = _cite_hint(lab)
        if hint:
            print(hint)
        return 0
    kinds = [k for k, v in (("regex", a.regex), ("code", a.code), ("prompt", a.prompt)) if v is not None]
    if len(kinds) > 1:
        print("give one predicate: --regex, --code or --prompt")
        return 2
    if kinds:
        kind = kinds[0]
        if not a.glob:
            print("--in GLOB names the records to label, such as --in 'agents/*.jsonl'")
            return 2
        rule = a.regex if kind == "regex" else a.prompt if kind == "prompt" else None
        if kind == "code":
            rule = Path(a.code).read_text() if a.code not in ("-", "") else stdin_text(5.0)
            if not rule.strip():
                print("no code: pass a file with --code FILE, or the code on stdin, defining label(unit)")
                return 2
        r = LB.define(st, name, kind, rule, a.glob, a.values.split(",") if a.values else None, a.where,
                      _parse_within(a.within), a.limit, a.reason, a.seed)
        lab, q, obj = _recount(st, name)
        s = LB.status(lab)
        if kind == "prompt" and s["waiting"] and obj:
            st.emit({"kind": "verb", "verb": "label", "object": obj["id"], "version": obj["version"], "args": name})
        if a.json:
            out_json({"name": name, **s, "query": lab.get("query"), "card": lab.get("card"), "added": r["added"], "errors": r["errors"]})
            return 0
        if r["same"] and not r["added"]:
            print(f"{name}: the same definition again, and every record has been seen; its values stand")
        for line in _label_lines(st, lab):
            print(line)
        for e in r["errors"]:
            print(f"  error: {e}")
        if s["waiting"]:
            calls = len(LB.batches(LB.waiting(st, name)["units"]))
            print(f"  The model reads them in {calls} call{'s' if calls != 1 else ''} of up to {LB.BATCH_ITEMS} records, "
                  f"which run beside the session through its own model; the person sees the card fill in. "
                  f"`thimble label {name} --wait` waits for them, then prints the counts.")
        if lab.get("card"):
            print(f"  card: {lab['card']}, drawn for the person under your reply, where they open each value's records and check them")
        hint = _cite_hint(lab)
        if hint and not s["waiting"]:
            print(hint)
        return 0
    if a.wait is not None:
        t0 = time.time()
        while True:
            lab = LB.load(st, name)
            if lab is None:
                print(f"no label {name}")
                return 1
            s = LB.status(lab)
            run = lab.get("run") or {}
            if not s["waiting"]:
                break
            if time.time() - t0 > a.wait:
                print(f"{name}: still {s['waiting']:,} records waiting after {a.wait:.0f}s; the calls go on beside the session")
                break
            if run.get("state") == "asked" and time.time() - float(run.get("asked") or t0) > 45:
                print(f"{name}: no session has started the model's calls. They run in a Claude Code session with the "
                      "thimble plugin; outside one, label with --regex or --code, or give values with --set.")
                return 1
            if run.get("state") == "running" and time.time() - float(run.get("at") or run.get("started") or t0) > 900:
                print(f"{name}: the model's calls stopped 15 minutes ago with {s['waiting']:,} records still waiting (the "
                      f"session that made them may have ended). `thimble label {name} --again` asks for them again.")
                return 1
            time.sleep(1.0)
    lab, _, _ = _recount(st, name)
    if a.json:
        card = O.load(st, lab["card"]) if lab.get("card") else None
        out_json({"name": name, **LB.status(lab), "query": lab.get("query"), "card": lab.get("card"),
                  "card_version": card.get("version") if card else None,
                  "definition": lab.get("rule"), "kind": lab.get("kind"), "values": lab["values"]})
        return 0
    for line in _label_lines(st, lab):
        print(line)
    hint = _cite_hint(lab)
    if hint:
        print(hint)
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="thimble", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
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
    p.add_argument("--label", metavar="NAME=VALUE", help="keep rows the label gave this value (NAME alone: every row it holds), each shown with its value")
    p.set_defaults(fn=cmd_rows)
    p = sub.add_parser("run", help="run Python over the sources and keep its lineage",
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
    p.add_argument("ref", nargs="+", help="a ref, or several: the rows behind all of them, as one set")
    p.add_argument("-n", type=int, default=5)
    p.add_argument("--random", action="store_true")
    p.add_argument("--first", action="store_true", help="the first rows in file order, not rows spread across them")
    p.add_argument("--label", help="the words the citation shows: a citation of a whole query opens the row that holds them")
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
    p = sub.add_parser("label", help="give each record of a scope one of a few values", description=LABEL_HELP,
                       formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("name", nargs="?")
    p.add_argument("--in", dest="glob", metavar="GLOB")
    p.add_argument("--regex")
    p.add_argument("--code", nargs="?", const="-", metavar="FILE")
    p.add_argument("--prompt", metavar="DEFINITION")
    p.add_argument("--values")
    p.add_argument("--where")
    p.add_argument("--within", metavar="LABEL=VALUE")
    p.add_argument("--limit", type=int)
    p.add_argument("--seed", type=int, default=0)
    p.add_argument("--reason", action="store_true")
    p.add_argument("--set", dest="set_values", nargs="*", metavar="REF=VALUE")
    p.add_argument("--wait", nargs="?", type=float, const=600.0, metavar="SECONDS")
    p.add_argument("--again", action="store_true")
    p.add_argument("--check", nargs=2, metavar=("REF", "VALUE"), help="the person's check of one record (- takes it back)")
    p.add_argument("--answers", metavar="FILE", help="the model's answers for waiting records (the label verb writes them)")
    p.add_argument("--waiting", action="store_true", help="the records that wait for the model, with their text, as JSON")
    p.add_argument("--of", nargs="+", metavar="REF", help="the labels of these records, as JSON")
    p.add_argument("--delete", action="store_true")
    p.add_argument("--json", action="store_true")
    p.set_defaults(fn=cmd_label)
    args = list(sys.argv[1:] if argv is None else argv)
    if args and args[0] in ("q", "query"):
        # the names `run` had before the rename: they still work, and neither help nor usage lists them
        args[0] = "run"
    if not args or args[0] in ("-h", "--help", "help"):
        # the commands in one screen: argparse's usage lines would only repeat them
        print(__doc__.strip())
        return 0
    a = ap.parse_args(args)
    if not getattr(a, "fn", None):
        print(__doc__.strip())
        return 0
    return a.fn(a)
