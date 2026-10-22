"""Labels: a category given to every record of a scope, kept with each record's ref.

    thimble/labels/<name>.json    one label: its definition, each record's value, the person's checks, and its runs

A label is defined once and applied to every record of the files a glob names (or a sample of them, a trial), after
`--where` and `--within` narrow them. Each record gets one of its values (positive first) by its predicate:

    regex    the record's text matches: the first value, else the last. A JSON or JSONL record's text is its values,
             decoded, one per line (a newline in a value is a real newline), the text a person reads; any other
             record's text is as the file holds it (regex_text)
    code     `label(unit)` in Python returns the value, (value, confidence) or None; a unit is the record as a dict
             (a line of text is {"text": ...}), with `_ref` and `_text` (the line as the file holds it). Without
             --values its values are the ones it returns, the most common first (yes, no when it returns a bool). A
             None it returns is a record outside the label (`out`): no record, no failure, not in the counts' base
    prompt   a model reads each record against the definition: the records wait in the label (`waiting`) until the
             plugin (labels/labels.ts) makes the calls through the session's own model and writes the answers back
    set      values Claude gives records itself, after reading them (`--set REF=VALUE`)

A value has its source (`by`: regex, code, model, claude), and a person's check stands over it: what the person said a
record's value is (`checks`), which the counts read in its place. Each record keeps its ref, so the person can open
the records of a value (the plugin's labels pane, `page`: the unchecked first, so the person checks a sample before
trusting the counts). `thimble label NAME` prints the counts per value as plain numbers, with the records they are
counted over; `thimble label NAME --csv` prints each record's value for Claude's own code (`csv_rows`). A label keeps
the sessions that applied it (`sessions`), which coverage reads.

Every change bumps `rev`. Writes take a lock (the model's reads, the person's checks and Claude's commands may write
at once).
"""
from __future__ import annotations

import contextlib
import csv
import fcntl
import json
import random
import re
import time
from collections import Counter
from pathlib import Path
from typing import Any, Iterator

from . import refs as R
from . import regextext as RT
from . import sources as S
from .store import Store

DEFAULT_VALUES = ["yes", "no"]
BATCH_ITEMS = 50  # records per model call, at most
BATCH_CHARS = 36_000  # or fewer, when their texts add up to this many characters (about 10k tokens)
UNIT_CHARS = 4_000  # characters of one record the model reads
KINDS = ("regex", "code", "prompt", "set")
SESSIONS_MAX = 50  # sessions a label keeps as the ones that applied it


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


def held(lab: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """The label's records: its units without those its code left outside it (a None returned with no error)."""
    return {r: u for r, u in (lab.get("units") or {}).items() if not u.get("out")}


def counts(lab: dict[str, Any]) -> Counter:
    out: Counter = Counter()
    for ref in held(lab):
        v = value_of(lab, ref)
        if v is not None:
            out[v] += 1
    return out


def status(lab: dict[str, Any]) -> dict[str, Any]:
    """What the label holds now: how many records, valued, waiting for the model, without a value, checked."""
    units = held(lab)
    waiting = [r for r, u in units.items() if u.get("wait")]
    failed = [r for r, u in units.items() if u.get("v") is None and not u.get("wait") and r not in (lab.get("checks") or {})]
    checks = lab.get("checks") or {}
    agree = sum(1 for r, c in checks.items() if c.get("was") is not None and c.get("v") == c.get("was"))
    disagree = sum(1 for r, c in checks.items() if c.get("was") is not None and c.get("v") != c.get("was"))
    cnt = counts(lab)
    return {"records": len(units), "valued": sum(cnt.values()), "waiting": len(waiting), "failed": len(failed),
            "out": len(lab.get("units") or {}) - len(units),
            "checked": len(checks), "agree": agree, "disagree": disagree, "counts": dict(cnt),
            "run": lab.get("run") or {}}


ONE_UNIT = {"records": "record", "rows": "row", "lines": "line", "sections": "section", "hunks": "hunk", "files": "file",
            "pages": "page"}


def units_of(st: Store, lab: dict[str, Any]) -> list[dict[str, Any]]:
    """The label's records in each file's own unit, the largest first: [{unit, n, counts}], where `counts` holds each
    value's records of that unit. A line of code is a line, a row of a table a row, a record of a JSONL file a record. A
    Markdown file or a diff the label takes whole (one section or hunk, with no --where or --within) is a file, as is a
    JSON document read as one value. A label over code and Markdown files can so hold lines and files at once."""
    units = held(lab)
    per_file = Counter(ref.split("#")[0] for ref in units)
    narrowed = bool(lab.get("where") or lab.get("within"))
    kinds: dict[str, str | None] = {}
    by: dict[str, dict[str, Any]] = {}
    for ref in units:
        rel, _, frag = ref.partition("#")
        if rel not in kinds:
            try:
                kinds[rel] = S.kind_of_file(st.root, rel)
            except OSError:
                kinds[rel] = None
        kind = kinds[rel]
        if frag in ("", "/") or (kind in ("markdown", "diff") and per_file[rel] == 1 and not narrowed):
            unit = "files"
        elif kind is None and frag.startswith("page"):
            unit = "pages"
        else:
            unit = S.entry_word(kind) or "records"
        u = by.setdefault(unit, {"unit": unit, "n": 0, "counts": Counter()})
        u["n"] += 1
        v = value_of(lab, ref)
        if v is not None:
            u["counts"][v] += 1
    return sorted(by.values(), key=lambda u: -u["n"])


def unit_count(n: int, unit: str) -> str:
    """`465 lines`, `1 file`."""
    return f"{n:,} {ONE_UNIT.get(unit, unit) if n == 1 else unit}"


def units_said(parts: list[dict[str, Any]]) -> str:
    """The records in their units, in words: `465 lines`, or `8 files and 457 lines`."""
    said = [unit_count(u["n"], u["unit"]) for u in parts]
    return said[0] if len(said) == 1 else ", ".join(said[:-1]) + " and " + said[-1]


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
    # `x.db#prs` names one table of a database, as load() reads it
    pattern, _, table = glob.partition("#")
    files = S.expand_glob(st.root, pattern)
    if not files:
        raise LabelError(f"no source file matches {pattern!r} under {st.root}")
    if table:
        for rel in files:
            tables = S.table_names(st.root, rel)
            if table not in tables:
                raise LabelError(f"{rel} has no table {table!r}; its tables: {', '.join(tables) or 'none'}")
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
        for row in S.iter_rows(st.root, rel, table=table or None):
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


JSON_KINDS = ("jsonl", "transcript", "json")  # files whose records a regex reads decoded


def regex_text(row: S.Row, kind: str | None) -> str:
    """The text a regex label matches. A JSON or JSONL record's values, decoded and one per line, the text a person
    reads: the file holds a newline in a value as the two characters \\ and n, so `\\bhttps?://` would miss a link
    right after one. Any other record (a line of text, a CSV row, a table's row) as the file holds it."""
    if kind in JSON_KINDS and not isinstance(row.value, str):
        return RT.json_text(row.value)
    return row.raw


def _kind_of_ref(kinds: dict[str, str | None], ref: str) -> str | None:
    """The kind of the file a row's ref is in, from {file: kind}."""
    k = kinds.get(ref.rsplit("#", 1)[0], "?")
    if k != "?":
        return k
    return next((v for f, v in kinds.items() if ref.startswith(f + "#")), None)


def rows_of(st: Store, refs: list[str]) -> dict[str, S.Row]:
    """The rows `refs` name, by ref, each file read once; a record no longer in its file is left out. The lines of a
    JSONL file or a transcript are read up to the last one wanted, and only those are decoded (S.json_lines), so a page
    of a large file does not decode the whole file."""
    by_file: dict[str, set[str]] = {}
    for r in refs:
        by_file.setdefault(r.split("#")[0], set()).add(r)
    out: dict[str, S.Row] = {}
    for rel, want in by_file.items():
        nums = {int(m[1]) for r in want if (m := re.fullmatch(r".*#L(\d+)", r))}
        try:
            if len(nums) == len(want) and S.kind_of_file(st.root, rel) in ("jsonl", "transcript"):
                rows = S.json_lines(st.root, rel, nums)
            else:
                rows = S.iter_rows(st.root, rel)
            for row in rows:
                if row.ref in want:
                    out[row.ref] = row
        except OSError:
            continue
    return out


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
        # the label's first value or its last; a code label with no --values has yes and no
        vals = lab["values"] if lab.get("given", True) and len(lab["values"]) >= 2 else DEFAULT_VALUES
        got = vals[0] if got else vals[-1]
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
    it, with a value still on the list, are kept). Code with no `values` takes the values it returns, the most common
    first, and a None it returns leaves the record outside the label. Returns {label, added, applied, errors}."""
    if kind not in ("regex", "code", "prompt"):
        raise LabelError(f"a label's predicate is --regex, --code or --prompt, not {kind}")
    given = bool(values) or kind != "code"
    values = [v.strip() for v in (values or ([] if kind == "code" else DEFAULT_VALUES)) if v and v.strip()]
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
                   "sessions": list(old.get("sessions") or []) if old else []}
            if old:
                # (code with no values: the checks whose value it still returns, once it has run)
                keep = {r: c for r, c in (old.get("checks") or {}).items() if c.get("v") in values or not given}
                lab["checks_kept"] = len(keep)
                lab["checks"] = keep
        if kind == "code" and (not same or given or "given" not in lab):
            lab["given"] = given
        lab["reason"] = bool(reason) or bool(lab.get("reason"))
        lab["trial"] = bool(limit)
        lab["matched"] = matched
        lab["files"] = files
        units = lab["units"]
        kinds = {f: S.kind_of_file(st.root, f) for f in files} if kind == "regex" else {}
        added, errors = 0, []
        for row in rows:
            if row.ref in units and not units[row.ref].get("wait") and (units[row.ref].get("v") is not None
                                                                          or units[row.ref].get("out")):
                continue
            if row.ref in units and kind == "prompt":
                continue
            added += 1
            if kind == "regex":
                hit = re.search(rule, regex_text(row, _kind_of_ref(kinds, row.ref))) is not None
                units[row.ref] = {"v": values[0] if hit else values[-1], "c": 1.0, "by": "regex"}
            elif kind == "code":
                try:
                    v, c = _as_value(lab, fn(_unit_of(row)))
                    # a None the code returns on purpose: the record is outside the label, not one without a value
                    units[row.ref] = ({"v": v, "c": c if c is not None else 1.0, "by": "code"} if v is not None
                                      else {"v": None, "by": "code", "out": True})
                    if v is not None and v not in lab["values"]:
                        lab["values"].append(v)
                except Exception as e:  # noqa: BLE001 — a record the code cannot label has no value, and says why
                    units[row.ref] = {"v": None, "by": "code", "err": f"{type(e).__name__}: {e}"[:200]}
                    if len(errors) < 3:
                        errors.append(f"{row.ref}: {type(e).__name__}: {e}")
            else:
                units[row.ref] = {"v": None, "wait": True}
        if kind == "code" and not lab.get("given"):
            _values_by_count(lab)
        if kind == "prompt":
            waiting = sum(1 for u in units.values() if u.get("wait"))
            lab["run"] = {"state": "asked" if waiting else "done", "asked": time.time(), "waiting": waiting}
        # the sessions that applied it, which coverage counts as having gone over its records
        lab["sessions"] = [s for s in lab.get("sessions") or [] if s != st.session][-(SESSIONS_MAX - 1):] + [st.session]
        write(st, lab)
    return {"label": lab, "added": added, "applied": len(rows), "matched": matched, "errors": errors, "same": same}


def _values_by_count(lab: dict[str, Any]) -> None:
    """A code label's values when none were given: those its records have, the most common first; yes before no."""
    cnt = counts(lab)
    vals = sorted(cnt, key=lambda v: -cnt[v])  # (a stable sort: a tie keeps the order the code first returned them)
    if vals and set(vals) <= set(DEFAULT_VALUES):
        vals = list(DEFAULT_VALUES)
    lab["values"] = vals
    lab["checks"] = {r: c for r, c in (lab.get("checks") or {}).items() if c.get("v") in vals}
    if "checks_kept" in lab:
        lab["checks_kept"] = len(lab["checks"])


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
            if p.get("kind") in ("bad", "file", "table"):
                bad.append(ref)
                continue
            lab["units"][ref] = {"v": str(v), "c": 1.0, "by": "claude"}
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
        u = (lab.get("units") or {}).get(ref)
        if u is None:
            raise LabelError(f"{ref} is not one of {name}'s records")
        checks = lab.setdefault("checks", {})
        if value is None:
            checks.pop(ref, None)
        else:
            if value not in lab["values"]:
                raise LabelError(f"{value!r} is not a value of {name}: {', '.join(lab['values'])}")
            checks[ref] = {"v": value, "was": u.get("v"), "at": time.time()}
        write(st, lab)
    return {"label": lab, "ref": ref, "was": u.get("v"), "now": value}


# ------------------------------------------------------------------ the model's part (prompt labels)


def waiting(st: Store, name: str, cut: int = UNIT_CHARS, first: int | None = None) -> dict[str, Any]:
    """The records that wait for the model, with the text it reads, and the label's definition. With `first`, only the
    records of the first `first` batches (a wave of calls), so the answer stays small; `waiting` counts them all."""
    lab = load(st, name)
    if lab is None:
        raise LabelError(f"no label {name!r}")
    refs = [r for r, u in (lab.get("units") or {}).items() if u.get("wait")]
    rows = rows_of(st, refs)
    units = [{"ref": r, "text": unit_text(rows[r], cut)} for r in refs if r in rows]
    gone = [r for r in refs if r not in rows]
    total = len(units)
    bs = batches(units)
    if first:
        bs = bs[:first]
        keep = {r for b in bs for r in b}
        units = [u for u in units if u["ref"] in keep]
    return {"name": lab["name"], "version": lab.get("version"), "definition": lab.get("rule") or "", "values": lab["values"],
            "reason": bool(lab.get("reason")), "units": units, "waiting": total, "gone": gone, "batches": bs}


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


def head(lab: dict[str, Any]) -> dict[str, Any]:
    """What the label viewer says of a label above its records: its definition, where it applies, its counts."""
    return {"name": lab["name"], "kind": lab.get("kind"), "rule": str(lab.get("rule") or ""), "values": list(lab["values"]),
            "in": lab.get("in"), "where": lab.get("where"), "within": lab.get("within"), "trial": bool(lab.get("trial")),
            "matched": lab.get("matched"), "version": lab.get("version"), "rev": lab.get("rev"), **status(lab)}


PAGE = 20  # records of one page of the label viewer
NO_VALUE = "-"  # the viewer's filter for records with no value yet (waiting for the model, or failed)


def page(st: Store, name: str, value: str | None = None, at: int = 0, n: int = PAGE) -> dict[str, Any]:
    """One page of a label's records for the labels pane: all of them, those of one value, or those with none
    (NO_VALUE); the records the analyst has not checked first, each part in the order they were labeled. Each record has
    its value, where the value came from (regex, code, model, claude, or the analyst's check), the model's confidence
    and reason, and its words. Reading them is the person's, never counted as what Claude read."""
    lab = load(st, name)
    if lab is None:
        raise LabelError(f"no label {name!r}; labels: {', '.join(names(st)) or 'none'}")
    units = held(lab)
    checks = lab.get("checks") or {}
    refs = [r for r in units if value is None or (value_of(lab, r) or NO_VALUE) == value]
    refs = [r for r in refs if r not in checks] + [r for r in refs if r in checks]
    total = len(refs)
    n = max(1, min(int(n), 200))
    at = max(0, min(int(at), max(0, total - 1)))
    want = refs[at:at + n]
    rows = rows_of(st, want)
    # the rows of a file named by one field, as the rows beside them
    said = S.words_by_file(list(rows.values()))
    kinds = {f: S.kind_of_file(st.root, f) for f in dict.fromkeys(r.split("#")[0] for r in rows)} \
        if lab.get("kind") == "regex" else {}
    out = []
    for i, r in enumerate(want):
        u, c = units.get(r) or {}, checks.get(r)
        e: dict[str, Any] = {"ref": r, "i": at + i, "value": value_of(lab, r), "by": "analyst" if c else u.get("by")}
        if u.get("c") is not None and not c and u.get("by") == "model":
            e["confidence"] = u["c"]
        if u.get("why"):
            e["reason"] = str(u["why"])[:300]
        if u.get("wait"):
            e["waiting"] = True
        if u.get("err") and e["value"] is None:
            e["error"] = str(u["err"])[:200]
        if c:
            e["checked"] = True
            e["was"] = c.get("was")
        row = rows.get(r)
        if row is not None:
            words, meta = said[r]
            e.update(words=words or unit_text(row, 240), meta=meta, text=unit_text(row, 1200))
            e.update(matched_part(lab, row, kinds))
        else:
            e["missing"] = "the record is no longer in its file"
        out.append(e)
    return {"label": head(lab), "value": value, "at": at, "total": total, "records": out}


HIT_ROOM = 320  # characters of a record the label viewer shows around the part its label matched
CODE_READS = re.compile(r"""\bunit\s*(?:\[\s*['"]([^'"\]]+)['"]\s*\]|\.get\(\s*['"]([^'"]+)['"])""")


def matched_part(lab: dict[str, Any], row: S.Row, kinds: dict[str, str | None]) -> dict[str, Any]:
    """The part of a record its label matched, for the viewer's example: a regex's match with its line and a line of
    context on each side, up to HIT_ROOM characters, cut with … ({hit: {before, match, after}}); or the fields the code
    read, each value cut ({fields: [[name, value]]}). Empty for a model's label, or a regex that does not match."""
    rule = str(lab.get("rule") or "")
    if lab.get("kind") == "regex" and rule:
        text = regex_text(row, _kind_of_ref(kinds, row.ref))
        try:
            m = re.search(rule, text)
        except re.error:
            return {}
        if not m:
            return {}
        a, b = m.span()
        # the match's line and a line of context on each side (a JSON record's values are one a line)
        start = text.rfind("\n", 0, a)
        start = 0 if start <= 0 else text.rfind("\n", 0, start) + 1
        end = text.find("\n", b)
        if end >= 0:
            end = text.find("\n", end + 1)
        if end < 0:
            end = len(text)
        before, match, after = text[start:a], text[a:b], text[b:end]
        if len(match) > HIT_ROOM:
            match, after = match[:HIT_ROOM - 1] + "…", ""
        side = max(12, (HIT_ROOM - len(match)) // 2)
        if len(before) > side:
            before, start = before[-side:], 1
        if len(after) > side:
            after, end = after[:side], -1
        return {"hit": {"before": ("…" if start > 0 else "") + before, "match": match,
                        "after": after + ("…" if end < 0 or end < len(text) else "")}}
    if lab.get("kind") == "code" and rule:
        unit = _unit_of(row)
        names = list(dict.fromkeys(a or b for a, b in CODE_READS.findall(rule)))
        fields = []
        for name in names[:6]:
            if name in unit:
                v = unit[name]
                said = v if isinstance(v, str) else json.dumps(v, ensure_ascii=False, default=str)
                said = " ".join(said.split())
                fields.append([name, said if len(said) <= HIT_ROOM else said[:HIT_ROOM - 1] + "…"])
        return {"fields": fields} if fields else {}
    return {}


CSV_FIELDS = ("ref", "value", "confidence", "by", "checked")


def csv_rows(lab: dict[str, Any]) -> Iterator[list[Any]]:
    """Every record of the label as a row for `--csv`: its ref, its value now (the analyst's check wins; empty while it
    waits for the model or has none), the confidence the value came with, who gave it (regex, code, model, claude, or
    analyst) and whether the analyst checked it."""
    checks = lab.get("checks") or {}
    for ref, u in held(lab).items():
        c = checks.get(ref)
        v = value_of(lab, ref)
        conf = None if c or v is None else u.get("c")
        yield [ref, "" if v is None else v, "" if conf is None else conf, "analyst" if c else u.get("by") or "",
               "true" if c else "false"]


def write_csv(lab: dict[str, Any], out: Any) -> None:
    w = csv.writer(out, lineterminator="\n")
    w.writerow(CSV_FIELDS)
    w.writerows(csv_rows(lab))
