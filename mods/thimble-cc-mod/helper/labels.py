"""thimble-cc-mod labels: a category applied to every record of some files, as thimble's apply_label does.

A label lives in .thimble-cc-mod/labels/<slug>/: spec.json (what the `label` tool was given), rows.json (each record's
value, by its ref), verdicts.json (values the analyst set by hand or agreed with, which win and teach a prompt label), picked.json (the
records shown as examples, kept while the analyst judges them). Every label is listed in .thimble-cc-mod/labels.json in
thimble's form ({name, kind, spec, labels, paths}, plus `rows`), which the views read (helper/viewhost.py) to mark
records. Its counts and examples become one label card, made by .thimble-cc-mod/scripts/label-<slug>.py.

    python3 labels.py run <slug> [--limit N]     a regex or code label: label the records, then finish
    python3 labels.py units <slug> [--limit N]   a prompt label's records, for the model calls the mod makes
    python3 labels.py finish <slug>              take rows.prompt.json (the model's values), write rows, cards, registry
    python3 labels.py verdict <slug> <ref> <value>   the analyst's own value for one record (its own value: agreed)
    python3 labels.py show <slug>                its spec, counts and examples, as they stand
    python3 labels.py list                       the labels of this folder

A record is a line of a text file (a JSON line is read as its object), or a row of a CSV/TSV file. A ref is
`file#L<n>` or `file#row=<n>`, as the citations write them.
"""
from __future__ import annotations

import argparse
import csv
import glob
import io
import json
import os
import re
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from refs import HOME, demojibake  # noqa: E402

TEXT_MAX = 6000  # characters of a record a model reads
EXCERPT = 240  # characters of a record an example shows
EXAMPLES_PER_VALUE = 3
PICKED_MAX = 18  # examples kept in all, for a label of many values
SKIP = {".git", HOME, ".claude", "node_modules", "__pycache__"}


def root() -> str:
    return os.path.abspath(os.environ.get("THIMBLE_CC_MOD_ROOT") or os.getcwd())


def folder(cwd: str, slug: str) -> str:
    return os.path.join(cwd, HOME, "labels", slug)


def slug_of(name: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:48]
    return s or "label"


# ------------------------------------------------------------------------------------------------ records


def files_of(cwd: str, paths: list[str]) -> list[str]:
    """The corpus files the label's globs match, relative to the folder, sorted; the mod's own files never."""
    out: set[str] = set()
    for g in paths or []:
        g = g[2:] if g.startswith("./") else g
        for p in glob.glob(os.path.join(cwd, g), recursive=True):
            if not os.path.isfile(p):
                continue
            rel = os.path.relpath(p, cwd)
            if rel.startswith("..") or any(part in SKIP or part.startswith(".") for part in rel.split(os.sep)):
                continue
            out.add(rel)
    return sorted(out)


def _field(obj: object, field: str) -> object:
    for k in field.split("."):
        if isinstance(obj, list):
            obj = obj[int(k)]
        elif isinstance(obj, dict):
            obj = obj.get(k)
        else:
            return None
    return obj


def records(cwd: str, rel: str, field: str = ""):
    """Each record of a file as (ref, unit, text): `unit` what a code label gets (a JSON line's object, a CSV row's
    dict, else {"text": line}), `text` what a regex or a model reads (the field when one is named)."""
    path = os.path.join(cwd, rel)
    if rel.lower().endswith((".csv", ".tsv")):
        with open(path, encoding="utf-8", errors="replace", newline="") as f:
            rd = csv.DictReader(f, delimiter="\t" if rel.lower().endswith(".tsv") else ",")
            for n, row in enumerate(rd, start=1):
                text = str(row.get(field, "")) if field else "\n".join(f"{k}: {v}" for k, v in row.items())
                yield f"{rel}#row={n}", dict(row), text
        return
    with open(path, encoding="utf-8", errors="replace") as f:
        for n, raw in enumerate(f, start=1):
            line = raw.rstrip("\n")
            if not line.strip():
                continue
            unit: object = {"text": line}
            if line.lstrip().startswith(("{", "[")):
                try:
                    unit = json.loads(line)
                except ValueError:
                    unit = {"text": line}
            if field:
                v = _field(unit, field) if not (isinstance(unit, dict) and set(unit) == {"text"}) else None
                text = v if isinstance(v, str) else json.dumps(v, ensure_ascii=False) if v is not None else ""
            else:
                text = line
            yield f"{rel}#L{n}", unit, text


def scope(cwd: str, spec: dict) -> list[tuple[str, object, str]]:
    """Every record the label covers: its files' records, those another label gave a value when `within` names one."""
    keep = None
    w = spec.get("within") or None
    if w and w.get("label"):
        other = load_rows(cwd, slug_of(str(w["label"])))
        want = str(w.get("value") or "")
        if not want:
            vals = (load_spec(cwd, slug_of(str(w["label"]))) or {}).get("values") or []
            want = vals[0] if vals else ""
        keep = {ref for ref, r in other.items() if r.get("value") == want}
    out = []
    for rel in files_of(cwd, spec.get("paths") or []):
        for ref, unit, text in records(cwd, rel, str(spec.get("field") or "")):
            if keep is None or ref in keep:
                out.append((ref, unit, text))
    return out


def sample(items: list, limit: int | None) -> list:
    """`limit` items spread evenly over the whole list (its start, middle and end), or all of them."""
    if not limit or limit >= len(items):
        return items
    if limit == 1:
        return [items[len(items) // 2]]
    step = (len(items) - 1) / (limit - 1)
    return [items[round(k * step)] for k in range(limit)]


# ------------------------------------------------------------------------------------------------ storage


def load_spec(cwd: str, slug: str) -> dict | None:
    try:
        with open(os.path.join(folder(cwd, slug), "spec.json"), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def load_rows(cwd: str, slug: str) -> dict[str, dict]:
    try:
        with open(os.path.join(folder(cwd, slug), "rows.json"), encoding="utf-8") as f:
            return json.load(f).get("rows") or {}
    except (OSError, ValueError):
        return {}


def load_verdicts(cwd: str, slug: str) -> dict[str, dict]:
    try:
        with open(os.path.join(folder(cwd, slug), "verdicts.json"), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def _write_json(path: str, obj: object) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False)
    os.replace(tmp, path)


# ------------------------------------------------------------------------------------------------ rules


def apply_rule(spec: dict, items: list[tuple[str, object, str]]) -> tuple[dict[str, dict], list[str]]:
    """A regex or code label's value on each record: {ref: {value, confidence}}, and the errors (at most 5 kept)."""
    values = list(spec.get("values") or ["yes", "no"])
    kind = spec.get("kind")
    rows: dict[str, dict] = {}
    errors: list[str] = []
    if kind == "regex":
        rx = re.compile(str(spec.get("definition") or ""))
        for ref, _, text in items:
            rows[ref] = {"value": values[0] if rx.search(text) else values[-1], "confidence": 1.0}
        return rows, errors
    ns: dict = {"re": re, "json": json}
    exec(compile(str(spec.get("definition") or ""), "<label>", "exec"), ns)  # noqa: S102 — the agent's own label code
    fn = ns.get("label")
    if not callable(fn):
        raise ValueError("a code label defines label(unit) returning (value, confidence)")
    n_err = 0
    for ref, unit, _ in items:
        try:
            got = fn(unit)
            value, conf = (got if isinstance(got, (tuple, list)) else (got, 1.0))[:2]
            value = str(value)
            if value not in values:
                raise ValueError(f"returned {value!r}, not one of {values}")
            rows[ref] = {"value": value, "confidence": float(conf)}
        except Exception as err:  # noqa: BLE001
            n_err += 1
            if len(errors) < 5:
                errors.append(f"{ref}: {type(err).__name__}: {err}")
    if n_err > len(errors):
        errors.append(f"… {n_err} records failed in all")
    return rows, errors


# ------------------------------------------------------------------------------------------------ finishing


def _excerpt(text: str, unit: object = None, field: str = "") -> str:
    """A record's words as an example shows them: the field the label reads, else a JSON record's longest text field
    after its name, else the line."""
    if not field and isinstance(unit, dict) and set(unit) != {"text"}:
        strs = [(k, v) for k, v in unit.items() if isinstance(v, str)]
        if strs:
            k, v = max(strs, key=lambda kv: len(kv[1]))
            text = f"{k}: {v}"
    t = " ".join(demojibake(str(text)).split())
    return t if len(t) <= EXCERPT else t[:EXCERPT - 1] + "…"


def finish(cwd: str, slug: str, new_rows: dict[str, dict], total: int, trial: bool, errors: list[str], status: str = "",
           repick: bool = True) -> dict:
    """Keep the rows (the analyst's verdicts win), list the label, write and run its card script, and say what it
    found: counts per value, examples of each, the card. `repick`: a new run picks new examples; a verdict keeps the
    ones the analyst is judging."""
    spec = load_spec(cwd, slug) or {}
    verdicts = load_verdicts(cwd, slug)
    rows = dict(new_rows)
    for ref, v in verdicts.items():
        if ref in rows or not trial:
            rows[ref] = {**rows.get(ref, {}), "value": v["value"], "confidence": 1.0, "analyst": True, "was": str(v.get("was") or "")}
    # the run's problems and status are kept with its rows, for the panel of a later session
    _write_json(os.path.join(folder(cwd, slug), "rows.json"), {"rows": rows, "total": total, "trial": trial, "updated": time.time(),
                                                               "errors": errors, "status": status})
    out = summarize(cwd, slug, spec, rows, total, trial, repick=repick, save=True)
    register(cwd, slug, spec, trial, out["counts"], _signature(rows))
    cards = write_cards(cwd, slug, spec, trial, len(rows), total)
    return {**out, "errors": errors, "status": status, **cards}


def load_picked(cwd: str, slug: str) -> list[dict]:
    try:
        with open(os.path.join(folder(cwd, slug), "picked.json"), encoding="utf-8") as f:
            got = json.load(f)
        return [x for x in got if isinstance(x, dict) and isinstance(x.get("ref"), str)] if isinstance(got, list) else []
    except (OSError, ValueError):
        return []


def pick(cwd: str, spec: dict, rows: dict[str, dict]) -> list[dict]:
    """Records to show as examples, with their words: up to EXAMPLES_PER_VALUE of each value, spread over its records,
    those the analyst has not judged first; ordered first of each value, then second of each, so the label card's first
    few hold every value."""
    values = list(spec.get("values") or ["yes", "no"])
    per = []
    for v in values:
        refs = [ref for ref, r in rows.items() if r.get("value") == v]
        fresh = [ref for ref in refs if not rows[ref].get("analyst")]
        chosen = sample(fresh, EXAMPLES_PER_VALUE)
        if len(chosen) < EXAMPLES_PER_VALUE:
            chosen += sample([ref for ref in refs if rows[ref].get("analyst")], EXAMPLES_PER_VALUE - len(chosen))
        per.append(chosen)
    order = [lst[k] for k in range(EXAMPLES_PER_VALUE) for lst in per if k < len(lst)][:PICKED_MAX]
    want = set(order)
    texts = {}
    for ref, unit, text in scope(cwd, spec):
        if ref in want:
            texts[ref] = _excerpt(text, unit, str(spec.get("field") or ""))
    return [{"ref": ref, "text": texts.get(ref, "")} for ref in order]


def summarize(cwd: str, slug: str, spec: dict, rows: dict[str, dict], total: int, trial: bool, repick: bool = True,
              save: bool = False) -> dict:
    """Counts per value and the examples, each with its words, its value now, why, and whether the analyst judged it
    (`analyst`, with the value the label gave before in `was`)."""
    values = list(spec.get("values") or ["yes", "no"])
    counts = {v: 0 for v in values}
    for r in rows.values():
        counts[r["value"]] = counts.get(r["value"], 0) + 1
    picked = [] if repick else [x for x in load_picked(cwd, slug) if x["ref"] in rows]
    if not picked:
        picked = pick(cwd, spec, rows)
        if save:
            _write_json(os.path.join(folder(cwd, slug), "picked.json"), picked)
    examples = []
    for x in picked:
        r = rows[x["ref"]]
        examples.append({"value": r["value"], "ref": x["ref"], "text": str(x.get("text") or ""), "rationale": str(r.get("rationale") or ""),
                         "confidence": r.get("confidence", 1.0), "analyst": bool(r.get("analyst")), "was": str(r.get("was") or "")})
    return {"slug": slug, "name": spec.get("name"), "kind": spec.get("kind"), "values": values, "counts": counts,
            "labeled": len(rows), "total": total, "trial": trial, "examples": examples}


def cmd_show(cwd: str, slug: str) -> dict:
    """A label as it stands: its spec, counts and examples, nothing run or written."""
    spec = load_spec(cwd, slug)
    if not spec:
        raise ValueError(f"no label {slug}")
    try:
        with open(os.path.join(folder(cwd, slug), "rows.json"), encoding="utf-8") as f:
            kept = json.load(f)
    except (OSError, ValueError):
        kept = {"rows": {}, "total": 0, "trial": True}
    return {**summarize(cwd, slug, spec, kept.get("rows") or {}, int(kept.get("total") or 0), bool(kept.get("trial")), repick=False),
            "spec": spec, "errors": list(kept.get("errors") or []), "status": str(kept.get("status") or "")}


def _signature(rows: dict[str, dict]) -> str:
    """What a card that read the label depends on: every record's value."""
    import hashlib  # noqa: PLC0415
    return hashlib.sha1(json.dumps(sorted((ref, r.get("value")) for ref, r in rows.items())).encode()).hexdigest()[:16]


def register(cwd: str, slug: str, spec: dict, trial: bool, counts: dict, sig: str = "") -> None:
    """The label in .thimble-cc-mod/labels.json, in thimble's form, where the views find it. `updated` changes only
    when a record's value or the definition did, so an analyst's agreement leaves the cards that read it current."""
    path = os.path.join(cwd, HOME, "labels.json")
    try:
        with open(path, encoding="utf-8") as f:
            reg = json.load(f)
        if not isinstance(reg, list):
            reg = []
    except (OSError, ValueError):
        reg = []
    entry = {"name": spec.get("name"), "slug": slug, "kind": spec.get("kind"), "spec": spec.get("definition"),
             "labels": spec.get("values") or ["yes", "no"], "paths": spec.get("paths") or [], "field": spec.get("field") or "",
             **({"within": spec["within"]} if spec.get("within") else {}),
             "rows": f"{HOME}/labels/{slug}/rows.json", "scope": "trial" if trial else "all", "counts": counts,
             "sig": sig, "updated": time.time()}
    before = next((e for e in reg if e.get("slug") == slug), None)
    if before and sig and before.get("sig") == sig and before.get("spec") == entry["spec"] and before.get("updated"):
        entry["updated"] = before["updated"]
    reg = [e for e in reg if e.get("slug") != slug and e.get("name") != spec.get("name")] + [entry]
    _write_json(path, reg)


CARD_SCRIPT = '''# The label "{name}" ({kind}): how many records of {where} it gives each value, and the first records it picked to show,
# from what thimble-cc-mod's label tool keeps in .thimble-cc-mod/labels/{slug}/ (written by helper/labels.py: rows.json,
# each record's value, those the analyst set or agreed with marked; picked.json, the records shown, with their words).
import json, os, sys
sys.path.insert(0, {helper!r})
from tcard import card

FOLDER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "labels", {slug!r})


def kept(name, default):
    try:
        with open(os.path.join(FOLDER, name), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


got = kept("rows.json", {{"rows": {{}}}})
rows = got["rows"]
values = {values!r}
counts = {{v: 0 for v in values}}
for r in rows.values():
    counts[r["value"]] = counts.get(r["value"], 0) + 1

# the records to agree or disagree with: the first {shown} the label tool picked, each with its value now and why
examples = []
for x in kept("picked.json", [])[:{shown}]:
    r = rows.get(x["ref"])
    if r:
        examples.append({{"ref": x["ref"], "quote": x.get("text", ""), "value": r["value"], "why": r.get("rationale", ""),
                         "set": bool(r.get("analyst")), "was": r.get("was", "")}})

card("label", {question!r}, rows=[(v, counts[v]) for v in values], x="value", y="records", total=True, note={note!r},
     label={{"slug": {slug!r}, "name": {name!r}, "kind": {kind!r}, "values": values, "labeled": len(rows),
            "total": got.get("total", len(rows)), "trial": bool(got.get("trial")), "paths": {paths!r}}},
     examples=examples)
'''


def write_cards(cwd: str, slug: str, spec: dict, trial: bool, labeled: int, total: int) -> dict:
    """Write the label's card script and run it: one label card, the count of each value and records to judge."""
    name = str(spec.get("name") or slug)
    paths = spec.get("paths") or []
    values = list(spec.get("values") or ["yes", "no"])
    where = ", ".join(paths) if len(paths) <= 3 else f"{', '.join(paths[:3])} and {len(paths) - 3} more"
    how = {"prompt": "a model read each record", "regex": "a regex matched each record", "code": "code decided each record"}.get(spec.get("kind"), "")
    within = spec.get("within") or {}
    among = f', among the records the label "{within.get("label")}" gave {within.get("value") or "its first value"}' if within.get("label") else ""
    if trial:
        question = f'How many of {labeled} sampled records get each value of "{name}"?'
        note = f"A trial on {labeled} of {total} records of {where}{among}, spread over the files; {how}."
    else:
        question = f'How many records get each value of "{name}"?'
        note = f"All {labeled} records of {where}{among}; {how}."
    helper = os.path.dirname(os.path.abspath(__file__))
    shown = 4 if len(values) <= 4 else min(len(values), 6)
    script = CARD_SCRIPT.format(name=name, kind=spec.get("kind"), where=where, slug=slug, helper=helper, values=values,
                                question=question, note=note, shown=shown, paths=list(paths))
    sdir = os.path.join(cwd, HOME, "scripts")
    os.makedirs(sdir, exist_ok=True)
    spath = os.path.join(sdir, f"label-{slug}.py")
    with open(spath, "w", encoding="utf-8") as f:
        f.write(script)
    env = {**os.environ, "THIMBLE_CC_MOD_ROOT": cwd}
    env.pop("THIMBLE_CC_MOD_PARAMS", None)
    env.pop("THIMBLE_CC_MOD_ONLY", None)
    r = subprocess.run([sys.executable, spath], cwd=cwd, env=env, capture_output=True, text=True, timeout=120)
    ids = re.findall(r"^thimble-cc-mod card (\w+)", r.stdout, re.M)
    return {"script": os.path.relpath(spath, cwd), "cards": ids, "card_output": r.stdout[-4000:], "card_error": r.stderr[-2000:] if r.returncode else ""}


# ------------------------------------------------------------------------------------------------ commands


def cmd_run(cwd: str, slug: str, limit: int | None) -> dict:
    spec = load_spec(cwd, slug)
    if not spec:
        raise SystemExit(f"no label {slug}")
    items = scope(cwd, spec)
    picked = sample(items, limit)
    rows, errors = apply_rule(spec, picked)
    return finish(cwd, slug, rows, len(items), bool(limit) and limit < len(items), errors)


def cmd_units(cwd: str, slug: str, limit: int | None, page: int = 0, per: int = 0) -> dict:
    """A prompt label's records for the model, a page at a time (`per` records from page `page`; all when 0), since a
    process's output the mod reads is capped: the total, whether it is a trial, the pages, the analyst's examples."""
    spec = load_spec(cwd, slug)
    if not spec:
        raise SystemExit(f"no label {slug}")
    items = scope(cwd, spec)
    picked = sample(items, limit)
    verdicts = load_verdicts(cwd, slug)
    texts = {ref: text for ref, _, text in items if ref in verdicts}
    examples = [{"ref": ref, "text": texts.get(ref, "")[:600], "value": v["value"], "note": v.get("note", "")} for ref, v in verdicts.items() if ref in texts][:8]
    pages = max(1, -(-len(picked) // per)) if per else 1
    window = picked[page * per:(page + 1) * per] if per else picked
    return {"total": len(items), "picked": len(picked), "trial": bool(limit) and limit < len(items), "examples": examples if page == 0 else [],
            "pages": pages, "units": [{"ref": ref, "text": text[:TEXT_MAX], **({"set": verdicts[ref]["value"]} if ref in verdicts else {})} for ref, _, text in window]}


def cmd_finish(cwd: str, slug: str) -> dict:
    with open(os.path.join(folder(cwd, slug), "rows.prompt.json"), encoding="utf-8") as f:
        got = json.load(f)
    return finish(cwd, slug, got.get("rows") or {}, int(got.get("total") or 0), bool(got.get("trial")), list(got.get("errors") or []),
                  str(got.get("status") or ""))


def cmd_verdict(cwd: str, slug: str, ref: str, value: str) -> dict:
    """The analyst set a record's value by hand, or agreed with the one it has (`value` its own): kept in verdicts.json
    (it wins over every later run and shows a prompt label the standard), put in the rows, and the counts, the registry
    and the card made again, with the same examples."""
    spec = load_spec(cwd, slug)
    if not spec:
        raise ValueError(f"no label {slug}")
    if value not in (spec.get("values") or []):
        raise ValueError(f"{value!r} is not one of the label's values")
    try:
        with open(os.path.join(folder(cwd, slug), "rows.json"), encoding="utf-8") as f:
            kept = json.load(f)
    except (OSError, ValueError):
        kept = {"rows": {}, "total": 0, "trial": True}
    rows = kept.get("rows") or {}
    prior = rows.get(ref, {})
    # the value the label gave, kept through later changes of mind, so "you agreed" and "was …" read right
    was = str(prior.get("was") or "") if prior.get("analyst") else str(prior.get("value") or "")
    verdicts = load_verdicts(cwd, slug)
    verdicts[ref] = {"value": value, "at": time.time(), "was": was}
    _write_json(os.path.join(folder(cwd, slug), "verdicts.json"), verdicts)
    rows[ref] = {**prior, "value": value}
    return finish(cwd, slug, rows, int(kept.get("total") or 0), bool(kept.get("trial")), list(kept.get("errors") or []),
                  str(kept.get("status") or ""), repick=False)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("op", choices=["run", "units", "finish", "list", "verdict", "show"])
    ap.add_argument("slug", nargs="?", default="")
    ap.add_argument("ref", nargs="?", default="")
    ap.add_argument("value", nargs="?", default="")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--page", type=int, default=0)
    ap.add_argument("--per", type=int, default=0)
    ap.add_argument("--cwd", default=root())
    a = ap.parse_args()
    cwd = os.path.abspath(a.cwd)
    if a.op == "list":
        try:
            with open(os.path.join(cwd, HOME, "labels.json"), encoding="utf-8") as f:
                reg = json.load(f)
        except (OSError, ValueError):
            reg = []
        for e in reg:
            print(f"{e.get('slug')}  {e.get('kind'):<6}  {e.get('scope'):<5}  {e.get('name')}  {json.dumps(e.get('counts'))}")
        return
    try:
        if a.op == "verdict":
            out = cmd_verdict(cwd, a.slug, a.ref, a.value)
        elif a.op == "show":
            out = cmd_show(cwd, a.slug)
        else:
            out = {"run": cmd_run, "units": lambda c, s, lim: cmd_units(c, s, lim, a.page, a.per)}.get(a.op, lambda c, s, _l: cmd_finish(c, s))(cwd, a.slug, a.limit or None)
    except re.error as err:
        out = {"error": f"the regex does not compile: {err}"}
    except SyntaxError as err:
        out = {"error": f"the code does not compile: {err}"}
    except (ValueError, OSError) as err:
        out = {"error": str(err)}
    print(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()
