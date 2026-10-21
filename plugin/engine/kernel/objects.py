"""Objects: what Claude makes for a person (a card, a view, a map, squeezed text), saved as one file each,
thimble/objects/<nn>-<slug>.json, so it can be drawn again, diffed, versioned and shared.

An object is a program + data + lineage:

    id, version, created, updated, session, history   kept by the kernel
    program      the program's text, written against the drawing contract (plugin/draw); the kernel never runs it
    text         words for the person, in Markdown; each [label](ref) is a citation
    data         the values the program draws: a query ref (r3, r3#day=2026-06-16, r3#day=2026-06-16@n) is replaced by
                 its value, each row keeping `_rows`, its source rows; a {"ref": ..., "quote": ...} is a cited row
    source       the spec as Claude gave it, query refs unbound, so `thimble save --rerun` can bind it again
    lineage      queries (code, inputs, what they kept and used), bindings (which query fills which part of data),
                 cites (each citation, with the row's hash), rows (per file, every source row behind the values),
                 coverage (what the session had read and had not, at save), declared (anything Claude says it read
                 or did that no tool saw, in its own form), problems (a citation or binding that does not hold)

Any other field Claude gives (title, question, notes, anything) is kept as given. Nothing is required.

Earlier versions are kept in thimble/objects/.versions/<id>/v<k>.json. When the lineage's rows are long (thousands of
transcript blocks), the file keeps them packed in lineage.packed (store.pack_object); load() puts them back.
"""
from __future__ import annotations

import copy
import datetime as dt
import json
import re
import shutil
import zlib
from typing import Any

from . import query as Q
from . import refs as R
from . import sources as S
from .store import Store, pack_object, unpack_object

# the drawing contract a card is written against, by the name it has had since the first cards (saved cards carry it)
CONTRACT = "lean/draw"


def now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


def slugify(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")[:48] or "object"


def all_ids(st: Store) -> list[str]:
    d = st.dir / "objects"
    return sorted(p.stem for p in d.glob("*.json")) if d.is_dir() else []


def find_id(st: Store, name: str) -> str | None:
    """The id of an object by its id, or by its name without the number prefix, as given or as its id spells it (a name
    with an underscore or a capital is the same card again)."""
    name = name.removeprefix("obj:").removeprefix("card:")
    ids = all_ids(st)
    if name in ids:
        return name
    for want in dict.fromkeys([name, slugify(name)]):
        for i in ids:
            if re.sub(r"^\d+-", "", i) == want:
                return i
    return None


def load(st: Store, name: str) -> dict[str, Any] | None:
    """An object, its lineage's packed rows (store.pack_object) back in place."""
    i = find_id(st, name)
    return read(st, st.dir / "objects" / f"{i}.json") if i else None


def read(st: Store, p: Any) -> dict[str, Any] | None:
    try:
        return unpack_object(st.read_json(p))
    except (KeyError, IndexError, TypeError, ValueError, zlib.error) as e:
        # packed rows that do not read: the object as written, which still draws, and its parts still resolve from their
        # data's `_rows`; its problems say what is missing and how to get it back
        obj = st.read_json(p)
        lin = obj.get("lineage") if isinstance(obj, dict) else None
        if isinstance(lin, dict):
            lin.pop("packed", None)
            lin["problems"] = list(lin.get("problems") or []) + [
                f"its lineage's packed rows did not read ({type(e).__name__}): `thimble save {obj.get('id')} --rerun` binds them again"]
        return obj


def walk(data: Any, pointer: str) -> tuple[Any, Any, str]:
    """(value at a JSON pointer, the nearest dict that holds it and has `_rows` or `ref` (else its parent), that dict's
    pointer)."""
    v = data
    holder, holder_ptr = None, ""
    parts = [p.replace("~1", "/").replace("~0", "~") for p in pointer.split("/")[1:]] if pointer else []
    cur = ""
    if isinstance(v, dict) and (v.get("_rows") or "ref" in v):
        holder, holder_ptr = v, ""
    for part in parts:
        if isinstance(v, list):
            try:
                v = v[int(part)]
            except (ValueError, IndexError):
                raise R.RefError(f"the card's data has nothing at {pointer}")
        elif isinstance(v, dict):
            if part not in v:
                raise R.RefError(f"the card's data has nothing at {pointer}")
            v = v[part]
        else:
            raise R.RefError(f"the card's data has nothing at {pointer}")
        cur += "/" + part
        if isinstance(v, dict) and (v.get("_rows") or isinstance(v.get("ref"), str)):
            holder, holder_ptr = v, cur
    return v, holder, holder_ptr


def binding_for(lin: dict[str, Any], pointer: str) -> dict[str, Any] | None:
    best = None
    for b in lin.get("bindings") or []:
        at = b["at"]
        if pointer == at or pointer.startswith(at.rstrip("/") + "/") or at == "":
            if best is None or len(at) > len(best["at"]):
                best = b
    return best


# ------------------------------------------------------------------ binding data


def _bind(st: Store, ref: str, at: str, ctx: dict[str, Any]) -> Any:
    """The value a query ref names, with `_rows` on each row; records the binding and the query."""
    p = R.parse(ref)
    q = Q.get(st, p["query"])
    if not q:
        ctx["problems"].append(f"{at or '/'}: no query {p['query']}")
        return None
    if q.get("error"):
        ctx["problems"].append(f"{at or '/'}: {q['id']} failed ({q['error']})")
        return None
    ctx["queries"].add(q["id"])
    table = q.get("table") or []
    rows = q.get("rows")
    if q.get("truncated") and not ("row" in p or "keys" in p):
        # the record keeps the first TABLE_MAX rows of an output: an object bound to all of it would show a part as the whole
        ctx["problems"].append(f"{at or '/'}: {q['id']} has more rows than its record keeps ({len(table):,} kept), so this "
                               "part shows only them: bind a smaller table (one row per thread, station or group)")
    frag = {k: p[k] for k in ("row", "keys") if k in p}
    idx = Q.find_rows(q, frag) if frag else list(range(len(table)))
    if frag and not idx:
        ctx["problems"].append(f"{at or '/'}: {q['id']} has no output row {ref.partition('#')[2]}")
        return None

    # each row carries its own ref (r3#day=2026-06-18) beside its source rows, so whatever draws it can cite it and
    # open its rows with no work by the program
    own = Q.row_refs(q)

    def row(i: int) -> dict[str, Any]:
        r = dict(table[i])
        if i < len(own):
            r["_ref"] = own[i]
        if rows and i < len(rows):
            r["_rows"] = rows[i]
        return r

    b: dict[str, Any] = {"at": at, "ref": ref, "query": q["id"], "lineage": q.get("lineage")}
    col = p.get("col")
    if col is not None:
        col = Q.column(table[idx[0]], col) if idx else col
        if idx and col is None:
            ctx["problems"].append(f"{at or '/'}: {q['id']}'s output has no column {p['col']!r}; it has {', '.join(table[idx[0]])}")
            return None
        if frag and len(idx) == 1:
            if rows and idx[0] < len(rows):
                b["rows"] = Q.value_rows(q, idx[0], col)
            ctx["bindings"].append(b)
            return table[idx[0]][col]
        val = [table[i][col] for i in idx]
        ctx["bindings"].append(b)
        return val
    ctx["bindings"].append(b)
    if frag and len(idx) == 1:
        return row(idx[0])
    return [row(i) for i in idx]


def _walk_spec(st: Store, v: Any, at: str, ctx: dict[str, Any]) -> Any:
    if isinstance(v, str) and re.fullmatch(R.QUERY_ID + r"(#.*)?", v):
        try:
            return _bind(st, v, at, ctx)
        except R.RefError as e:
            ctx["problems"].append(f"{at or '/'}: {e}")
            return None
    if isinstance(v, list):
        return [_walk_spec(st, x, f"{at}/{i}", ctx) for i, x in enumerate(v)]
    if isinstance(v, dict):
        if isinstance(v.get("ref"), str):
            _cite(st, v["ref"], at, ctx, quote=v.get("quote"))
        return {k: _walk_spec(st, x, f"{at}/{k.replace('~', '~0').replace('/', '~1')}", ctx) if k != "ref" else x
                for k, x in v.items()}
    return v


def _cite(st: Store, ref: str, where: str, ctx: dict[str, Any], quote: str | None = None, label: str | None = None) -> None:
    c: dict[str, Any] = {"in": where or "/", "ref": ref}
    if label is not None:
        c["label"] = label
    try:
        p = R.parse(ref)
    except R.RefError as e:
        c["problem"] = str(e)
        ctx["problems"].append(f"{where}: {e}")
        ctx["cites"].append(c)
        return
    try:
        if p["kind"] == "query":
            q = Q.get(st, p["query"])
            if not q:
                raise R.RefError(f"no query {p['query']}")
            ctx["queries"].add(q["id"])
            if label is not None:
                # a citation of a whole query (or of a row set) whose words show one value: the row that holds it
                from . import lineage as LIN

                got = LIN.narrow(st, ref, label)
                if got:
                    c["wrote"], c["ref"], ref = ref, got[0], got[0]
                    p = R.parse(ref)
            frag = {k: p[k] for k in ("row", "keys") if k in p}
            idx = Q.find_rows(q, frag) if frag else []
            if frag and not idx:
                raise R.RefError(f"{q['id']} has no output row {ref.partition('#')[2].partition('@')[0]}")
            if "col" in p and len(idx) == 1:
                row = (q.get("table") or [])[idx[0]]
                col = Q.column(row, p["col"])
                if col is None:
                    raise R.RefError(f"{q['id']}'s output has no column {p['col']!r}")
                c["value"] = row[col]
                if label is not None and not number_matches(unkeyed(label, p), row[col]):
                    raise R.RefError(f"the citation shows {label!r} but {ref} holds {row[col]!r}")
                if q.get("rows") and idx[0] < len(q["rows"]):
                    c["rows"] = Q.value_rows(q, idx[0], col)
            elif frag and q.get("rows"):
                c["rows"] = _merge_rows([q["rows"][i] for i in idx if i < len(q["rows"])])
        elif p["kind"] == "object":
            if not find_id(st, p["object"]):
                raise R.RefError(f"no card {p['object']}")
        else:
            rel = S.locate(st.root, p.get("path", ""))
            if rel != p.get("path"):
                # a path written from a subfolder: the one file under the root whose path ends with it
                c["wrote"], c["ref"] = ref, R.format_source({**p, "path": rel})
                ref, p = c["ref"], R.parse(c["ref"])
            got = S.fetch(st.root, ref, limit=1 if p["kind"] in ("file", "table") else None)
            if p["kind"] not in ("file", "table"):
                c["rows"] = [R.format_source(p)]
                if len(got) == 1:
                    c["hash"] = S.row_hash(got[0].raw)
                q = quote or (label.strip()[1:-1] if label and len(label.strip()) > 2 and label.strip()[0] in "\"“" and label.strip()[-1] in "\"”" else None)
                if q:
                    if not any(S.find_quote(S.text_of(r), q) for r in got):
                        raise R.RefError(f"the quote {q[:60]!r} is not in {ref}")
                    c["quote"] = q
    except R.RefError as e:
        c["problem"] = str(e)
        ctx["problems"].append(f"{where or '/'}: {e}")
    ctx["cites"].append(c)


def _merge_rows(lists: list[list[str]]) -> list[str]:
    flat = [x for xs in lists for x in xs]
    try:
        return R.merge(flat)
    except R.RefError:
        return flat


# a number in words: never the digits of a name such as r5, R3 or ip16 (a letter, an underscore or a digit before them),
# nor a time's minutes (the 00 of 23:00); and the words one to ten, which state a count as digits do ("one edit at
# 23:00"), but not the "one" of "the one" or "no one", which states none
_NUM_WORDS = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10}
NUM_RE = re.compile(r"(?<![A-Za-z_\d.,:])[-−]?\d[\d,]*(?:\.\d+)?"
                    r"|(?<![A-Za-z])(?<!the )(?<!no )(?<!any )(?<!each )(?<!every )(?<!this )(?<!that )(?<!which )"
                    r"(?:" + "|".join(_NUM_WORDS) + r")(?![A-Za-z])", re.I)


def num_text(tok: str) -> str:
    """A number NUM_RE found, as digits: `one` is 1, `−3` is -3, `8,452` is 8452."""
    w = _NUM_WORDS.get(tok.lower())
    return str(w) if w is not None else tok.replace("−", "-").replace(",", "")
# a scale written after a number: 12k, 1.17M, 2.4 billion
_SCALE_RE = re.compile(r"\s?(k|K|M|B|bn|thousand|million|billion)(?![A-Za-z])")
_SCALES = {"k": 1e3, "K": 1e3, "thousand": 1e3, "M": 1e6, "million": 1e6, "B": 1e9, "bn": 1e9, "billion": 1e9}


def _tight(label: str) -> str:
    """The words without the thin spaces some numbers hold (8 452)."""
    return label.replace(" ", "").replace(" ", "")


def unkeyed(label: str, ref: dict[str, Any] | None) -> str:
    """The words of a citation without the numbers its ref names (a parsed ref). Such a number says which row or
    column the place is, not the value it holds: in `[edits from addresses starting with 20.](r9#from_20=yes@n)` the
    20 is part of a key's name, and in `[addresses starting with 20.](r9#first=20@n)` it is a key's value. Words that
    are only a number state the value, so there only a number equal to a whole key value is dropped: in
    `[6](r9#week=2026-06-01@n)` the 6 is the count, but `[2024](r9#year=2024@n)` names the row."""
    keys = (ref or {}).get("keys") or {}
    whole: set[float] = set()
    for v in keys.values():
        try:
            whole.add(abs(float(str(v).replace(",", ""))))
        except ValueError:
            pass
    named = set(whole)
    if not _BARE_RE.fullmatch(_tight(label or "").strip()):
        for s in [*keys, *keys.values(), (ref or {}).get("col")]:
            for tok in re.findall(r"\d+(?:\.\d+)?", str(s or "").replace(",", "")):
                named.update(float(t) for t in {tok, *tok.split(".")} if t)
    if not named:
        return label

    def drop(m: re.Match) -> str:
        try:
            return " " if abs(float(num_text(m[0]))) in named else m[0]
        except ValueError:
            return m[0]

    return NUM_RE.sub(drop, _tight(label))


# words that are only a number: 8,452, ~20, 58%, 1.2M
_BARE_RE = re.compile(r"[~≈]?\s*[-−]?\d[\d,]*(?:\.\d+)?\s*(?:%|k|K|M|B|bn)?")


def number_matches(label: str, value: Any) -> bool:
    """Whether a number a citation shows is the cited value, as written or rounded to the digits it shows. The words
    may hold several numbers (`8,452 of the 14,591 edits`), and any one of them may be the value. A share may be shown
    as a percent, and a number may carry a scale (`1.17M` is 1,170,228 rounded). A label with no number matches."""
    s = _tight(label)
    found = list(NUM_RE.finditer(s))
    if not found or not isinstance(value, (int, float)) or isinstance(value, bool):
        return True
    for m in found:
        tok = num_text(m[0])
        try:
            shown = float(tok)
        except ValueError:
            continue
        digits = len(tok.split(".")[1]) if "." in tok else 0
        after = s[m.end():]
        pct = after.lstrip().startswith("%")
        sc = None if pct else _SCALE_RE.match(after)
        cands = [float(value) * 100] if pct else [float(value) / _SCALES[sc[1]]] if sc else []
        for v in cands + [float(value)]:
            if round(v, digits) == shown or abs(v - shown) <= 0.5 * 10 ** -digits + 1e-9:
                return True
    return False


# ------------------------------------------------------------------ saving


def build(st: Store, spec: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    """(data, lineage) of a spec. A binding or citation that does not hold is kept, with its problem, in
    lineage.problems: the object is saved anyway, and Claude reads the problems in the command's output."""
    from . import lineage as LIN

    ctx: dict[str, Any] = {"problems": [], "queries": set(), "bindings": [], "cites": []}
    data = _walk_spec(st, copy.deepcopy(spec.get("data")), "", ctx)
    for label, target in R.links(spec.get("text") or ""):
        _cite(st, target, "text", ctx, label=label)
    # every query the object rests on, with the queries those build on (use())
    queries: dict[str, Any] = {}
    todo = list(ctx["queries"])
    while todo:
        qid = todo.pop()
        if qid in queries:
            continue
        q = Q.get(st, qid)
        if not q:
            continue
        queries[qid] = {"id": qid, "about": q.get("about"), "code": q.get("code"), "inputs": q.get("inputs"),
                        "uses": q.get("uses"), "labels": q.get("labels"), "kept": q.get("kept"), "lineage": q.get("lineage"),
                        "frame": q.get("frame"), "keys": q.get("keys"), "out_hash": q.get("out_hash"),
                        "t": q.get("t"), "session": q.get("session"), "rerun_of": q.get("rerun_of")}
        todo.extend(u["query"] for u in q.get("uses") or [])
    # the source rows behind every value, per file
    every: list[str] = []
    for b in ctx["bindings"]:
        if b.get("rows"):
            every.extend(b["rows"])
    _collect_rows(data, every)
    for c in ctx["cites"]:
        every.extend(c.get("rows") or [])
    # a whole JSON document is its root row, whether a record names it as the file or as `x.json#/`
    every = Q.Documents(st.root)(every)
    per_file: dict[str, list[str]] = {}
    for rs in every:
        per_file.setdefault(rs.split("#")[0], []).append(rs)
    rows = {}
    for f, rss in per_file.items():
        merged = _merge_rows([rss])
        rows[f] = {"count": R.count(merged), "rowsets": merged}
    cov = LIN.coverage(st)
    snap = {"session": st.session, "at": now(), "total": cov["total"],
            "files": {o["path"]: o["status"] for o in cov["files"] if o["status"] != "not read"},
            "not_read": [o["path"] for o in cov["files"] if not o["read"]][:500]}
    lineage = {"queries": queries, "bindings": ctx["bindings"], "cites": ctx["cites"], "rows": rows,
               "coverage": snap, "declared": spec.get("declared"), "problems": ctx["problems"]}
    return data, lineage


def _collect_rows(v: Any, out: list[str]) -> None:
    if isinstance(v, dict):
        if v.get("_rows"):
            out.extend(v["_rows"])
        for x in v.values():
            _collect_rows(x, out)
    elif isinstance(v, list):
        for x in v:
            _collect_rows(x, out)


KEPT = ("id", "version", "created", "updated", "session", "history", "data", "source", "lineage")


def _bare(v: Any) -> Any:
    """A value of data without the kernel's `_rows` and `_ref`, to compare what Claude passed back with what a query
    filled in."""
    if isinstance(v, dict):
        return {k: _bare(x) for k, x in v.items() if k not in ("_rows", "_ref")}
    if isinstance(v, list):
        return [_bare(x) for x in v]
    return v


def _rebind(spec: dict[str, Any], old: dict[str, Any]) -> dict[str, Any]:
    """A new version's spec with each part of its data that still holds what a query of the old version filled in
    given back as that query's ref, so the binding and its lineage stay. Claude often makes a new version by loading
    the saved object, changing a field and saving it whole; the data it passes back is the bound output, written out."""
    data = spec.get("data")
    if not isinstance(data, (dict, list)):
        return spec
    out = copy.deepcopy(spec)
    for b in sorted((old.get("lineage") or {}).get("bindings") or [], key=lambda b: len(b.get("at") or "")):
        at, ref = b.get("at") or "", b.get("ref")
        if not isinstance(ref, str):
            continue
        try:
            new_v, _, _ = walk(out["data"], at)
            old_v, _, _ = walk(old.get("data"), at)
        except R.RefError:
            continue
        if isinstance(new_v, str) and new_v == ref:
            continue
        if _bare(new_v) != _bare(old_v):
            continue
        if not at:
            out["data"] = ref
            break
        parts = [x.replace("~1", "/").replace("~0", "~") for x in at.split("/")[1:]]
        holder = out["data"]
        for part in parts[:-1]:
            holder = holder[int(part)] if isinstance(holder, list) else holder[part]
        key = int(parts[-1]) if isinstance(holder, list) else parts[-1]
        holder[key] = ref
    return out


def save(st: Store, name: str | None, spec: dict[str, Any], change: str | None = None) -> dict[str, Any]:
    """Make an object, or a new version of the one with this name."""
    oid = find_id(st, name) if name else None
    d = st.sub("objects")
    old = read(st, d / f"{oid}.json") if oid else None
    if old:
        spec = _rebind(spec, old)
    data, lineage = build(st, spec)
    if not oid:
        nums = [int(m[1]) for i in all_ids(st) if (m := re.match(r"^(\d+)-", i))]
        oid = f"{max(nums, default=0) + 1:02d}-{slugify(name or str(spec.get('title') or 'object'))}"
    version = (old.get("version") or 1) + 1 if old else 1
    obj: dict[str, Any] = {"id": oid, "version": version, "created": old.get("created") if old else now(),
                           "updated": now(), "session": st.session}
    for k, v in spec.items():  # every field Claude gave, as given (program, text, title, anything else)
        if k not in KEPT and k != "declared":
            obj[k] = v
    obj.setdefault("contract", CONTRACT)
    # every card has a title the renderers can draw, even when the program draws none: Claude's, else one made from
    # its question, its first words or its name, marked as made
    title, made = title_of(spec, name or oid)
    obj["title"] = title
    if made:
        obj["title_from"] = made
    else:
        obj.pop("title_from", None)
    obj["data"] = data
    obj["source"] = spec
    obj["lineage"] = lineage
    obj["history"] = (old.get("history") if old else []) + [{"v": version, "at": now(), "change": change or ("made" if not old else "changed")}]
    if old:
        vd = d / ".versions" / oid
        vd.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(d / f"{oid}.json", vd / f"v{old.get('version') or 1}.json")
    # long lineage rows are written packed; the object in hand, which the command prints from, stays whole
    st.write_json(d / f"{oid}.json", pack_object(obj))
    st.log({"kind": "save", "object": oid, "version": version, "queries": sorted(lineage["queries"]),
            "problems": len(lineage["problems"])})
    # the session's change feed: a surface (the terminal under a reply, the browser) learns of the save from here,
    # never from what the command printed, which a pipe may cut
    st.emit({"kind": "save", "object": oid, "version": version, "title": title, "problems": len(lineage["problems"])})
    return obj


def title_of(spec: dict[str, Any], name: str | None) -> tuple[str, str | None]:
    """(the card's title, where it came from when Claude gave none: "question", "text" or "name")."""
    t = spec.get("title")
    if isinstance(t, str) and t.strip():
        return " ".join(t.split()), None

    def short(s: str) -> str:
        s = " ".join(R.LINK_RE.sub(lambda m: m[1], s).replace("**", "").split())
        return s if len(s) <= 80 else s[:79].rsplit(" ", 1)[0] + "…"

    q = spec.get("question")
    if isinstance(q, str) and q.strip():
        return short(q), "question"
    text = spec.get("text")
    if isinstance(text, str) and text.strip():
        first = re.split(r"(?<=[.!?])\s", text.strip(), maxsplit=1)[0]
        return short(first), "text"
    words = re.sub(r"^\d+-", "", str(name or "card")).replace("-", " ").replace("_", " ").strip() or "card"
    return words[:1].upper() + words[1:], "name"


def update(st: Store, name: str, changes: dict[str, Any], rerun: bool = False, change: str | None = None) -> tuple[dict[str, Any], dict[str, str]]:
    """A new version of an object: its spec with `changes` applied; with rerun, each query it rests on runs again (as a
    new query) and the object binds the new results. Returns the object and {old query: new query}."""
    obj = load(st, name)
    if not obj:
        raise KeyError(f"no card {name}")
    spec = copy.deepcopy(obj.get("source") or {})
    for k, v in changes.items():
        if k == "data" and isinstance(v, dict) and isinstance(spec.get("data"), dict):
            spec["data"].update(v)
        elif v is not None:
            spec[k] = v
    renamed: dict[str, str] = {}
    if rerun:
        for qid, q in sorted((obj.get("lineage") or {}).get("queries", {}).items(), key=lambda kv: int(kv[0][1:])):
            if not q.get("code"):
                continue
            new = Q.run(st, q.get("about") or "", q["code"], rerun_of=qid)
            renamed[qid] = new["id"]
        if renamed:
            spec = json.loads(_rename_queries(json.dumps(spec, ensure_ascii=False), renamed))
    saved = save(st, obj["id"], spec, change or ("ran its queries again: " + ", ".join(f"{a}→{b}" for a, b in renamed.items()) if renamed else "changed"))
    return saved, renamed


def _rename_queries(text: str, renamed: dict[str, str]) -> str:
    return re.sub(r"(?<![\w])(" + R.QUERY_ID + r")(?=[#@\"\)\]]|$)", lambda m: renamed.get(m[1], m[1]), text)


def summary_line(obj: dict[str, Any]) -> str:
    lin = obj.get("lineage") or {}
    rows = sum(x.get("count", 0) for x in (lin.get("rows") or {}).values())
    files = len(lin.get("rows") or {})
    qs = ", ".join(sorted(lin.get("queries") or {}, key=lambda q: int(q[1:]))) or "no query"
    probs = len(lin.get("problems") or [])
    return (f"{obj['id']}  v{obj.get('version')}  {obj.get('title') or ''}  · {qs} · {rows:,} source rows in {files} "
            f"file{'s' if files != 1 else ''} · {len(lin.get('cites') or [])} citations"
            + (f" · {probs} problem{'s' if probs != 1 else ''}" if probs else ""))
