"""Labels: a category given to every record of a scope, kept with each record's ref.

    thimble/labels/<name>.json    one label: its definition, each record's value, the person's checks, and its runs

A label is defined once and applied to every record of the files a glob names (or a sample of them, a trial), after
`--where` and `--within` narrow them. Each record gets one of its values (positive first) by its predicate:

    regex    the record's text as the file holds it matches: the first value, else the last
    code     `label(unit)` in Python returns the value, (value, confidence) or None; a unit is the record as a dict
             (a line of text is {"text": ...}), with `_ref` and `_text` (the line as the file holds it)
    prompt   a model reads each record against the definition: the records wait in the label (`waiting`) until the
             label verb (verbs/label/) makes the calls through the session's own model and writes the answers back
    set      values Claude gives records itself, after reading them (`--set REF=VALUE`)

A value has its source (`by`: regex, code, model, claude), and a person's check stands over it: what the person said a
record's value is (`checks`), which a later count and use() read in its place. Each record keeps its ref, so a count
of a value opens its records like any citation.

The counts are a query (count_query): `label_rows(name)` gives the label's records with their value, and tally() keeps
each value's records exactly, so `[38](r12#apology=yes@n)` cites them. A later query reads the label with
use("apology"): each record's `_ref` and value (with `confidence`, `reason`, `by`, `checked`), live, so a check the
person made since is in it. The label's card (save_card) draws the counts; its examples are records of each value
chosen at random, the unchecked first, so the person checks a sample before trusting the counts.

Every change bumps `rev`. Writes take a lock (the label verb, the person's checks and Claude's commands may write at
once).
"""
from __future__ import annotations

import contextlib
import fcntl
import json
import random
import re
import time
from collections import Counter
from pathlib import Path
from typing import Any, Iterator

from . import refs as R
from . import sources as S
from .store import Store

DEFAULT_VALUES = ["yes", "no"]
BATCH_ITEMS = 50  # records per model call, at most
BATCH_CHARS = 36_000  # or fewer, when their texts add up to this many characters (about 10k tokens)
UNIT_CHARS = 4_000  # characters of one record the model reads
SAMPLES = 12  # records of each value the card shows as examples
KINDS = ("regex", "code", "prompt", "set")


class LabelError(ValueError):
    pass


def slug(name: str) -> str:
    return re.sub(r"[^A-Za-z0-9_-]+", "-", name.strip()).strip("-").lower() or "label"


def path(st: Store, name: str) -> Path:
    return st.dir / "labels" / f"{slug(name)}.json"


def load(st: Store, name: str) -> dict[str, Any] | None:
    lab = st.read_json(path(st, name))
    return lab if isinstance(lab, dict) and lab.get("name") else None


def names(st: Store) -> list[str]:
    d = st.dir / "labels"
    if not d.is_dir():
        return []
    out = []
    for p in sorted(d.glob("*.json")):
        lab = st.read_json(p)
        if isinstance(lab, dict) and lab.get("name"):
            out.append(str(lab["name"]))
    return out


@contextlib.contextmanager
def locked(st: Store, name: str) -> Iterator[None]:
    """One writer of a label at a time."""
    d = st.sub("labels")
    with open(d / f".{slug(name)}.lock", "w") as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(f, fcntl.LOCK_UN)


def write(st: Store, lab: dict[str, Any], change: bool = True) -> None:
    if change:
        lab["rev"] = int(lab.get("rev") or 0) + 1
    lab["updated"] = time.time()
    st.write_json(path(st, lab["name"]), lab)


# ------------------------------------------------------------------ values


def value_of(lab: dict[str, Any], ref: str) -> str | None:
    """The value a record has now: the person's check, else its predicate's (or Claude's)."""
    c = (lab.get("checks") or {}).get(ref)
    if c is not None:
        return c.get("v")
    u = (lab.get("units") or {}).get(ref)
    return u.get("v") if u else None


def counts(lab: dict[str, Any]) -> Counter:
    out: Counter = Counter()
    for ref in lab.get("units") or {}:
        v = value_of(lab, ref)
        if v is not None:
            out[v] += 1
    return out


def status(lab: dict[str, Any]) -> dict[str, Any]:
    """What the label holds now: how many records, valued, waiting for the model, without a value, checked."""
    units = lab.get("units") or {}
    waiting = [r for r, u in units.items() if u.get("wait")]
    failed = [r for r, u in units.items() if u.get("v") is None and not u.get("wait") and r not in (lab.get("checks") or {})]
    checks = lab.get("checks") or {}
    agree = sum(1 for r, c in checks.items() if c.get("was") is not None and c.get("v") == c.get("was"))
    disagree = sum(1 for r, c in checks.items() if c.get("was") is not None and c.get("v") != c.get("was"))
    cnt = counts(lab)
    return {"records": len(units), "valued": sum(cnt.values()), "waiting": len(waiting), "failed": len(failed),
            "checked": len(checks), "agree": agree, "disagree": disagree, "counts": dict(cnt),
            "run": lab.get("run") or {}}


def row_ref(ref: str) -> str:
    """The record a ref names: a block of a transcript record (`a.jsonl#L44.b1`) is its record's."""
    return re.sub(r"(#L\d+)\.b\d+$", r"\1", ref)


def frame(st: Store, name: str):
    """The label's records that have a value, as a DataFrame: `_ref`, `_file`, the value (a column named as the label),
    `confidence`, `reason`, `by` and `checked`."""
    import pandas as pd

    lab = load(st, name)
    if lab is None:
        raise KeyError(f"no label {name!r}")
    rows = []
    checks = lab.get("checks") or {}
    for ref, u in (lab.get("units") or {}).items():
        v = value_of(lab, ref)
        if v is None:
            continue
        c = checks.get(ref)
        rows.append({"_ref": ref, "_file": ref.split("#")[0], lab["name"]: v,
                     "confidence": 1.0 if c else u.get("c"), "reason": u.get("why"),
                     "by": "person" if c else u.get("by"), "checked": bool(c)})
    cols = ["_ref", "_file", lab["name"], "confidence", "reason", "by", "checked"]
    return pd.DataFrame(rows, columns=cols)


def files_of(lab: dict[str, Any]) -> Counter:
    """How many of the label's records each file holds."""
    return Counter(ref.split("#")[0] for ref in lab.get("units") or {})


# ------------------------------------------------------------------ the records a label applies to


class Rec(dict):
    def __getattr__(self, k: str) -> Any:
        return self.get(k)

    def __missing__(self, k: str) -> Any:
        return None


def records(st: Store, glob: str, where: str | None = None, within: tuple[str, str] | None = None,
            limit: int | None = None, seed: int = 0) -> tuple[list[S.Row], int, list[str]]:
    """(the records, how many matched, the files) of a glob, narrowed by --where and --within; with a limit, that many
    of them at random (a trial)."""
    files = S.expand_glob(st.root, glob)
    if not files:
        raise LabelError(f"no source file matches {glob!r} under {st.root}")
    cond = compile(where, "<where>", "eval") if where else None
    inside = None
    if within:
        other = load(st, within[0])
        if other is None:
            raise LabelError(f"--within names no label {within[0]!r}; labels: {', '.join(names(st)) or 'none'}")
        inside = {r for r in other.get("units") or {} if value_of(other, r) == within[1]}
    rng = random.Random(seed)
    kept: list[S.Row] = []
    matched = 0
    for rel in files:
        for row in S.iter_rows(st.root, rel):
            if inside is not None and row.ref not in inside:
                continue
            if cond is not None:
                r = Rec(row.value) if isinstance(row.value, dict) else row.value
                try:
                    ok = eval(cond, {"re": re, "len": len, "str": str, "int": int, "float": float, "any": any, "all": all},
                              {"r": r, "text": row.raw})
                except Exception:  # noqa: BLE001 — a row the expression cannot read does not match
                    ok = False
                if not ok:
                    continue
            matched += 1
            if not limit or len(kept) < limit:
                kept.append(row)
            else:  # reservoir sampling: a trial is a random sample of every match
                j = rng.randrange(matched)
                if j < limit:
                    kept[j] = row
    return kept, matched, files


def unit_text(row: S.Row, cut: int = UNIT_CHARS) -> str:
    """A record as the model reads it: a transcript record's blocks (its words, tool calls, results), a record's JSON,
    or a line of text; cut at `cut` characters."""
    v = row.value
    if isinstance(v, dict) and v.get("type") in ("assistant", "user") and isinstance(v.get("message"), dict):
        parts = []
        for b in S.blocks_of(v):
            t = b["text"].strip()
            if t:
                parts.append(t if b["kind"] == "text" else f"[{b['kind']}] {t}")
        text = f"({v['type']}) " + "\n".join(parts)
    elif isinstance(v, str):
        text = v
    else:
        text = row.raw
    return text if len(text) <= cut else text[:cut] + f" … (+{len(text) - cut} characters)"


def _unit_of(row: S.Row) -> dict[str, Any]:
    v = row.value
    u = dict(v) if isinstance(v, dict) else {"text": v}
    u["_ref"] = row.ref
    u["_text"] = row.raw
    return u


def _code_fn(code: str):
    ns: dict[str, Any] = {"re": re, "json": json, "__name__": "__thimble_label__"}
    exec(compile(code, "<label>", "exec"), ns)
    fn = ns.get("label")
    if not callable(fn):
        raise LabelError("the code defines no label(unit): define `def label(unit):` returning a value, (value, confidence) or None")
    return fn


def _as_value(lab: dict[str, Any], got: Any) -> tuple[str | None, float | None]:
    conf = None
    if isinstance(got, tuple) and len(got) == 2:
        got, conf = got
    if got is None:
        return None, None
    if isinstance(got, bool):
        got = lab["values"][0] if got else lab["values"][-1]
    return str(got), (float(conf) if isinstance(conf, (int, float)) else None)


# ------------------------------------------------------------------ define and apply


def _definition(kind: str, rule: str, glob: str | None, values: list[str], where: str | None,
                within: tuple[str, str] | None) -> dict[str, Any]:
    return {"kind": kind, "rule": rule, "in": glob, "values": values, "where": where,
            "within": list(within) if within else None}


def define(st: Store, name: str, kind: str, rule: str, glob: str, values: list[str] | None = None,
           where: str | None = None, within: tuple[str, str] | None = None, limit: int | None = None,
           reason: bool = False, seed: int = 0) -> dict[str, Any]:
    """Define a label (or apply the same definition again) and apply it: regex and code at once, prompt as records that
    wait for the model. The same definition again keeps the values it has and applies it only to records it has not
    seen; a changed one is a new version, whose records start again (the person's checks of records that are still in
    it, with a value still on the list, are kept). Returns {label, added, applied, errors}."""
    if kind not in ("regex", "code", "prompt"):
        raise LabelError(f"a label's predicate is --regex, --code or --prompt, not {kind}")
    values = [v.strip() for v in (values or DEFAULT_VALUES) if v and v.strip()]
    if len(values) < 2 and kind != "code":
        raise LabelError("a label needs two values or more, the positive first: --values yes,no")
    if kind == "regex":
        try:
            re.compile(rule)
        except re.error as e:
            raise LabelError(f"the regex does not compile: {e}") from e
    fn = _code_fn(rule) if kind == "code" else None
    rows, matched, files = records(st, glob, where, within, limit, seed)
    with locked(st, name):
        old = load(st, name)
        d = _definition(kind, rule, glob, values, where, within)
        # code may add values it found; the same definition keeps them
        same = bool(old) and all(old.get(k) == d[k] for k in d if k != "values") \
            and list(old.get("values") or [])[:len(values)] == values
        if same:
            lab = old
        else:
            lab = {"name": name, "version": (int(old.get("version") or 1) + 1) if old else 1, **d, "units": {},
                   "checks": {}, "created": time.time(), "rev": int(old.get("rev") or 0) if old else 0,
                   **({"card": old["card"]} if old and old.get("card") else {})}
            if old:
                keep = {r: c for r, c in (old.get("checks") or {}).items() if c.get("v") in values}
                lab["checks_kept"] = len(keep)
                lab["checks"] = keep
        lab["reason"] = bool(reason) or bool(lab.get("reason"))
        lab["trial"] = bool(limit)
        lab["matched"] = matched
        lab["files"] = files
        units = lab["units"]
        added, errors = 0, []
        for row in rows:
            if row.ref in units and not units[row.ref].get("wait") and units[row.ref].get("v") is not None:
                continue
            if row.ref in units and kind == "prompt":
                continue
            added += 1
            if kind == "regex":
                hit = re.search(rule, row.raw) is not None
                units[row.ref] = {"v": values[0] if hit else values[-1], "c": 1.0, "by": "regex"}
            elif kind == "code":
                try:
                    v, c = _as_value(lab, fn(_unit_of(row)))
                    units[row.ref] = {"v": v, "c": c if c is not None else 1.0, "by": "code"}
                    if v is not None and v not in lab["values"]:
                        lab["values"].append(v)
                except Exception as e:  # noqa: BLE001 — a record the code cannot label has no value, and says why
                    units[row.ref] = {"v": None, "by": "code", "err": f"{type(e).__name__}: {e}"[:200]}
                    if len(errors) < 3:
                        errors.append(f"{row.ref}: {type(e).__name__}: {e}")
            else:
                units[row.ref] = {"v": None, "wait": True}
        if kind == "prompt":
            waiting = sum(1 for u in units.values() if u.get("wait"))
            lab["run"] = {"state": "asked" if waiting else "done", "asked": time.time(), "waiting": waiting}
        write(st, lab)
    st.log({"kind": "label", "name": name, "how": kind, "in": glob, "scanned": files, "records": len(rows)})
    return {"label": lab, "added": added, "applied": len(rows), "matched": matched, "errors": errors, "same": same}


def set_values(st: Store, name: str, given: dict[str, str], values: list[str] | None = None) -> dict[str, Any]:
    """Values Claude gives records itself, after reading them. A label that does not exist yet is made (its values are
    the ones given, or --values)."""
    with locked(st, name):
        lab = load(st, name)
        if lab is None:
            vals = [v for v in (values or []) if v] or list(dict.fromkeys(given.values()))
            lab = {"name": name, "version": 1, "kind": "set", "rule": None, "in": None, "values": vals, "where": None,
                   "within": None, "units": {}, "checks": {}, "created": time.time(), "rev": 0}
        bad = []
        for ref, v in given.items():
            try:
                p = R.parse(ref)
            except R.RefError:
                p = {"kind": "bad"}
            if p.get("kind") in ("query", "object", "bad", "file", "table"):
                bad.append(ref)
                continue
            r = row_ref(ref)
            lab["units"][r] = {"v": str(v), "c": 1.0, "by": "claude"}
            if str(v) not in lab["values"]:
                lab["values"].append(str(v))
        write(st, lab)
    return {"label": lab, "bad": bad}


def check(st: Store, name: str, ref: str, value: str | None) -> dict[str, Any]:
    """The person's check of one record: the value they say it has (None takes the check back). Kept beside the value
    the label gave it, which stays for the record of agreement."""
    with locked(st, name):
        lab = load(st, name)
        if lab is None:
            raise LabelError(f"no label {name!r}")
        r = row_ref(ref)
        u = (lab.get("units") or {}).get(r)
        if u is None:
            raise LabelError(f"{ref} is not one of {name}'s records")
        checks = lab.setdefault("checks", {})
        if value is None:
            checks.pop(r, None)
        else:
            if value not in lab["values"]:
                raise LabelError(f"{value!r} is not a value of {name}: {', '.join(lab['values'])}")
            checks[r] = {"v": value, "was": u.get("v"), "at": time.time()}
        write(st, lab)
    return {"label": lab, "ref": r, "was": u.get("v"), "now": value}


# ------------------------------------------------------------------ the model's part (prompt labels)


def waiting(st: Store, name: str, cut: int = UNIT_CHARS) -> dict[str, Any]:
    """The records that wait for the model, with the text it reads, and the label's definition."""
    lab = load(st, name)
    if lab is None:
        raise LabelError(f"no label {name!r}")
    refs = [r for r, u in (lab.get("units") or {}).items() if u.get("wait")]
    by_file: dict[str, list[str]] = {}
    for r in refs:
        by_file.setdefault(r.split("#")[0], []).append(r)
    texts: dict[str, str] = {}
    for rel, rs in by_file.items():
        want = set(rs)
        try:
            for row in S.iter_rows(st.root, rel):
                if row.ref in want:
                    texts[row.ref] = unit_text(row, cut)
        except OSError:
            continue
    units = [{"ref": r, "text": texts[r]} for r in refs if r in texts]
    gone = [r for r in refs if r not in texts]
    return {"name": lab["name"], "version": lab.get("version"), "definition": lab.get("rule") or "", "values": lab["values"],
            "reason": bool(lab.get("reason")), "units": units, "gone": gone, "batches": batches(units)}


def batches(units: list[dict[str, Any]], items: int = BATCH_ITEMS, chars: int = BATCH_CHARS) -> list[list[str]]:
    """The records in batches of one model call each: up to `items` records, or fewer when their texts add up to
    `chars`."""
    out: list[list[str]] = []
    cur: list[str] = []
    size = 0
    for u in units:
        n = len(u["text"]) + 40
        if cur and (len(cur) >= items or size + n > chars):
            out.append(cur)
            cur, size = [], 0
        cur.append(u["ref"])
        size += n
    if cur:
        out.append(cur)
    return out


def answers(st: Store, name: str, payload: dict[str, Any]) -> dict[str, Any]:
    """The model's answers for records that waited: {"values": {ref: {value, confidence?, reason?}}, "failed": {ref:
    why}, "run": {...}}. A value off the label's list is no value (it says why). Records that no longer wait are left as
    they are. Returns how many took a value and how many failed."""
    took = failed = 0
    with locked(st, name):
        lab = load(st, name)
        if lab is None:
            raise LabelError(f"no label {name!r}")
        units = lab.get("units") or {}
        for ref, a in (payload.get("values") or {}).items():
            u = units.get(ref)
            if not u or not u.get("wait"):
                continue
            a = a if isinstance(a, dict) else {"value": a}
            v = a.get("value")
            v = None if v is None else str(v).strip()
            if v not in lab["values"]:
                # a near miss in case or quotes counts as the value it names
                near = [x for x in lab["values"] if v is not None and x.lower() == v.strip("\"'`").lower()]
                v = near[0] if near else None
            if v is None:
                units[ref] = {"v": None, "by": "model", "err": f"the model gave {a.get('value')!r}, which is not a value of the label"}
                failed += 1
                continue
            conf = a.get("confidence")
            units[ref] = {"v": v, "c": float(conf) if isinstance(conf, (int, float)) else None, "by": "model",
                          **({"why": str(a["reason"])[:300]} if a.get("reason") else {})}
            took += 1
        for ref, why in (payload.get("failed") or {}).items():
            u = units.get(ref)
            if u and u.get("wait"):
                units[ref] = {"v": None, "by": "model", "err": str(why)[:300]}
                failed += 1
        if isinstance(payload.get("run"), dict):
            lab["run"] = {**(lab.get("run") or {}), **payload["run"], "at": time.time()}
            if payload["run"].get("state") == "running" and not (took or failed):
                # picked up, nothing written yet: the label's values have not changed
                st.write_json(path(st, lab["name"]), {**lab, "updated": time.time()})
                return {"label": lab, "took": 0, "failed": 0}
        if not any(u.get("wait") for u in units.values()) and (lab.get("run") or {}).get("state") not in ("done", "failed"):
            lab["run"] = {**(lab.get("run") or {}), "state": "done", "at": time.time()}
        write(st, lab, change=bool(took or failed))
    return {"label": lab, "took": took, "failed": failed}


def again(st: Store, name: str) -> dict[str, Any]:
    """The records with no value (a call failed, an answer off the list) wait for the model again, and the calls are
    asked for again (for those, and for records that still wait from a session that ended)."""
    with locked(st, name):
        lab = load(st, name)
        if lab is None:
            raise LabelError(f"no label {name!r}")
        if lab.get("kind") != "prompt":
            raise LabelError(f"{name} is a {lab.get('kind')} label: define it again to apply it again")
        n = still = 0
        checks = lab.get("checks") or {}
        for ref, u in (lab.get("units") or {}).items():
            if u.get("wait"):
                still += 1
            elif u.get("v") is None and ref not in checks:
                lab["units"][ref] = {"v": None, "wait": True}
                n += 1
        if n or still:
            lab["run"] = {"state": "asked", "asked": time.time(), "waiting": n + still}
            write(st, lab)
    return {"label": lab, "again": n, "waiting": n + still}


# ------------------------------------------------------------------ what a record's labels say


def of_refs(st: Store, refs: list[str]) -> dict[str, dict[str, Any]]:
    """Each ref's labels: {ref: {label: {value, by, confidence, reason, checked, was}}}, for the refs some label holds."""
    labs = [load(st, n) for n in names(st)]
    out: dict[str, dict[str, Any]] = {}
    for ref in refs:
        r = row_ref(ref)
        for lab in labs:
            if not lab:
                continue
            u = (lab.get("units") or {}).get(r)
            if u is None:
                continue
            c = (lab.get("checks") or {}).get(r)
            v = value_of(lab, r)
            e: dict[str, Any] = {"value": v, "by": "person" if c else u.get("by"), "values": lab["values"]}
            if u.get("c") is not None and not c:
                e["confidence"] = u["c"]
            if u.get("why"):
                e["reason"] = u["why"]
            if u.get("wait"):
                e["waiting"] = True
            if u.get("err") and v is None:
                e["error"] = u["err"]
            if c:
                e["checked"] = True
                e["was"] = c.get("was")
            out.setdefault(ref, {})[lab["name"]] = e
    return out


def breakdown(st: Store, rowsets: list[str], cap: int = 500_000) -> dict[str, Any]:
    """How the rows of a set split by each label that holds some of them: {label: {values: {value: n}, of: rows it
    holds, rows: rows in the set}}."""
    labs = [x for x in (load(st, n) for n in names(st)) if x]
    if not labs or not rowsets:
        return {}
    try:
        if R.count(rowsets) > cap:
            return {}
        refs = R.expand(rowsets)
    except R.RefError:
        return {}
    out: dict[str, Any] = {}
    rows = {row_ref(r) for r in refs}
    for lab in labs:
        units = lab.get("units") or {}
        held = [r for r in rows if r in units]
        if not held:
            continue
        c: Counter = Counter()
        for r in held:
            v = value_of(lab, r)
            c[v if v is not None else ""] += 1
        vals = {v: c[v] for v in lab["values"] if c.get(v)}
        vals.update({v: n for v, n in c.items() if v and v not in vals})
        out[lab["name"]] = {"values": vals, "of": len(held), "rows": len(rows), "none": c.get("", 0)}
    return out


# ------------------------------------------------------------------ the counts as a query, and the card


def count_query(st: Store, name: str) -> dict[str, Any] | None:
    """The label's counts per value, as a query whose output rows keep their records (tally), so each count is a
    citation. None without pandas."""
    from . import query as Q

    try:
        import pandas  # noqa: F401
    except ImportError:
        return None
    lab = load(st, name)
    if lab is None:
        return None
    col = json.dumps(lab["name"], ensure_ascii=False)
    about = f"label {lab['name']}: records per value"
    code = (f"# the label {col} ({lab.get('kind')}, v{lab.get('version')}): each record's value\n"
            f"lab = label_rows({col})\n"
            f"tally(lab, {col})\n")
    q = Q.run(st, about, code)
    with locked(st, name):
        cur = load(st, name)
        if cur is not None:
            cur["query"] = q["id"]
            cur["counted_rev"] = cur.get("rev")
            write(st, cur, change=False)
    return q


def _cite_value(qid: str, col: str, v: str) -> str:
    """The ref of one value's count in the count query's output."""
    key = R.value_slug(v) if re.search(r"[\s\[\]()#@&=]", v) else v
    return f"{qid}#{R.value_slug(col) if re.search(r'[^A-Za-z0-9_-]', col) else col}={key}@n"


def samples(st: Store, lab: dict[str, Any], n: int = SAMPLES, seed: int = 0) -> dict[str, list[dict[str, Any]]]:
    """Up to n records of each value, chosen at random, the unchecked first, each {ref, words, meta, text}: what the
    person checks."""
    from .lineage import words_of

    checks = lab.get("checks") or {}
    by: dict[str, list[str]] = {}
    for ref in lab.get("units") or {}:
        v = value_of(lab, ref)
        if v is not None:
            by.setdefault(v, []).append(ref)
    rng = random.Random(seed)
    picked: dict[str, list[str]] = {}
    for v, refs in by.items():
        fresh = [r for r in refs if r not in checks]
        done = [r for r in refs if r in checks]
        rng.shuffle(fresh)
        picked[v] = (fresh + done)[:n]
    want = {r for rs in picked.values() for r in rs}
    rows: dict[str, S.Row] = {}
    for rel in sorted({r.split("#")[0] for r in want}):
        try:
            for row in S.iter_rows(st.root, rel):
                if row.ref in want:
                    rows[row.ref] = row
        except OSError:
            continue
    out: dict[str, list[dict[str, Any]]] = {}
    for v, refs in picked.items():
        recs = []
        for r in refs:
            row = rows.get(r)
            if row is None:
                continue
            words, meta = words_of(row)
            # the label's value, its source and reason are the detail's to show, from the label as it is now
            recs.append({"ref": r, "words": words or unit_text(row, 240), "meta": meta, "text": unit_text(row, 600)})
        out[v] = recs
    return out


CARD_PROGRAM = r"""
const L = data.label
const rows = data.counts || []
const col = L.name
const by = {}
for (const r of rows) by[String(r[col])] = r
const values = L.values.concat(Object.keys(by).filter(v => !L.values.includes(v)))
const total = L.records
const max = Math.max(1, ...values.map(v => (by[v] ? by[v].n : 0)), L.waiting || 0)
const items = values.map((v, i) => {
  const r = by[v]
  const n = r ? r.n : 0
  const ex = 'ex-' + i
  if ((data.samples || {})[v] && data.samples[v].length) k.examples(ex, { label: `${col} = ${v}`, records: data.samples[v], total: n })
  return { ...(r || {}), id: 'value-' + i, label: v, value: n, max, tone: i === 0 ? 'accent' : 'c' + ((i % 5) + 2), examples: (data.samples || {})[v] ? ex : undefined, note: total ? k.fmt(n / total, { pct: true, dp: 0 }) : '' }
})
const parts = [k.bars(items, { max })]
if (L.waiting) parts.push(k.beside(k.text('{dim:waiting}', { w: 10 }), k.unseen({ label: `${k.fmt(L.waiting)} records wait for the model`, w: Math.max(12, Math.min(48, k.w - 16)) })))
if (L.failed) parts.push(k.text(`{warn:${k.fmt(L.failed)} records have no value}{dim: · ${k.escape(L.failed_why || 'thimble label ' + col + ' --again asks again')}}`))
const how = L.kind === 'prompt' ? 'the model read each record' : L.kind === 'regex' ? 'a regex' : L.kind === 'code' ? 'code' : 'Claude, after reading'
const checked = L.checked ? ` · checked ${k.fmt(L.checked)}: ${k.fmt(L.agree)} agree, ${k.fmt(L.disagree)} disagree` : ' · none checked yet'
parts.push(k.text(`{dim:${k.escape(how)} · ${k.fmt(total)} records${L.trial ? ' (a trial sample)' : ''}${checked}}`))
return k.frame(k.stack(...parts), { title: k.title })
"""


def card_spec(st: Store, lab: dict[str, Any], q: dict[str, Any] | None) -> dict[str, Any]:
    s = status(lab)
    qid = q["id"] if q else None
    top = lab["values"][0]
    n = s["counts"].get(top, 0)
    scope = lab.get("in") or "the records Claude named"
    if lab.get("where"):
        scope += f" where {lab['where']}"
    if lab.get("within"):
        scope += f" within {lab['within'][0]} = {lab['within'][1]}"
    definition = str(lab.get("rule") or "")
    failed_why = next((u.get("err") for u in (lab.get("units") or {}).values() if u.get("v") is None and u.get("err")), None)
    info = {"name": lab["name"], "kind": lab.get("kind"), "values": lab["values"], "records": s["records"],
            "waiting": s["waiting"], "failed": s["failed"], "failed_why": (failed_why or "")[:120], "checked": s["checked"],
            "agree": s["agree"], "disagree": s["disagree"], "trial": bool(lab.get("trial")), "scope": scope,
            "definition": definition[:400], "version": lab.get("version"), "rev": lab.get("rev")}
    cite = f"[{n:,}]({_cite_value(qid, lab['name'], top)})" if qid and n else f"{n:,}"
    text = f"{cite} of {s['records']:,} records are {top}."
    if s["waiting"]:
        text += f" {s['waiting']:,} still wait for the model."
    if s["failed"]:
        text += f" {s['failed']:,} have no value."
    title = (f"{lab['name']}: {s['records']:,} records wait for the model" if s["waiting"] and not s["valued"]
             else f"{lab['name']}: {n:,} of {s['records']:,} records are {top}")
    spec: dict[str, Any] = {
        "title": title,
        "question": definition if lab.get("kind") == "prompt" else f"{lab.get('kind')}: {definition}"[:400],
        "label": lab["name"],
        "text": text,
        "data": {"label": info, "samples": samples(st, lab), **({"counts": qid} if qid else {"counts": []})},
        "program": CARD_PROGRAM.strip(),
        "hints": [],
        "declared": {"label": f"{lab['name']} v{lab.get('version')} rev {lab.get('rev')}: {lab.get('kind')} over {scope}"},
    }
    return spec


def save_card(st: Store, name: str, q: dict[str, Any] | None = None) -> dict[str, Any] | None:
    from . import objects as O

    lab = load(st, name)
    if lab is None:
        return None
    if q is None and lab.get("query"):
        from . import query as Q
        q = Q.get(st, lab["query"])
    obj = O.save(st, f"label-{slug(lab['name'])}", card_spec(st, lab, q), change=f"label rev {lab.get('rev')}")
    with locked(st, name):
        cur = load(st, name)
        if cur is not None:
            cur["card"] = obj["id"]
            cur["card_rev"] = cur.get("rev")
            write(st, cur, change=False)
    return obj
