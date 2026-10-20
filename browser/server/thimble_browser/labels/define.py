"""Defining a label from a chat's call, and what a `concept:` ref names."""
from __future__ import annotations

from typing import Any

from .. import home
from . import run, store

PREDICATE = ("kind", "unit", "description", "spec", "labels")  # what a chat's definition of a label sets


def same_definition(prior: dict[str, Any], concept: dict[str, Any]) -> bool:
    def norm(k: dict[str, Any], key: str) -> Any:
        v = k.get(key)
        return v.strip() if isinstance(v, str) else v

    return all(norm(prior, key) == norm(concept, key) for key in PREDICATE)


async def define(ws: str, name: str, *, kind: str, text: str, unit: str, values: list[str] | None, by: str,
                 glob: list[str], trial: bool, comment: bool, within: dict[str, str] | None) -> tuple[dict[str, Any], str]:
    """Create a label, or redefine the one of that name: (the label as stored, what happened: defined, redefined or
    same). A redefinition keeps the label's id, colors and switch, steps its version, stops a run of it and drops its
    rows, since their values meant something else."""
    concept = store.new_concept(name, description=text if kind == "prompt" else "", kind=kind,
                                spec="" if kind == "prompt" else text, unit=unit, labels=values, created_by=by,
                                glob=glob)
    concept.update(trial=trial, comment=comment, within=within if unit == "record" else None)
    prior = store.find(ws, name)
    if prior is not None and same_definition(prior, concept):
        kept = {**prior, "glob": ", ".join(dict.fromkeys([*store.globs(prior["glob"]), *glob])) if glob else prior["glob"],
                "comment": comment, "within": concept["within"], "trial": trial and prior["trial"]}
        store.write(ws, kept)
        return kept, "same"
    if prior is not None:
        await run.cancel(ws, prior["id"])
        concept.update(id=prior["id"], name=prior["name"] if prior["id"] == name else concept["name"], ts=prior["ts"],
                       version=prior["version"] + 1, marks=store.marks_of(concept["unit"], prior.get("marks")),
                       classes=store.classes_of(concept["labels"], prior["classes"]), shown=prior["shown"],
                       model=prior.get("model") or "", rev=prior["rev"], changes=prior["changes"],
                       applications=prior["applications"], trial=trial and prior["trial"])
        store.note_change(concept, "redefined", "redefined")
        try:
            store.rows_path(ws, prior["id"]).unlink()
        except OSError:
            pass
        store.write(ws, store.colored(ws, concept))
        store.notify(ws, concept["id"], "redefined")
        return concept, "redefined"
    store.write(ws, store.colored(ws, concept))
    store.notify(ws, concept["id"], "defined")
    return concept, "defined"


def covered(concept: dict[str, Any], paths: list[str], limit: int | None) -> bool:
    """Whether the label's last run already answers a run of its definition over `paths`: it ran this version, ended
    without a stop, over the same files and limit."""
    last = concept["applications"][-1] if concept["applications"] else None
    if not last or last.get("status") != "done" or last.get("stopped") or last.get("version") != concept["version"]:
        return False
    if concept["unit"] in store.FILE_UNITS and sorted(last.get("paths") or []) != sorted(paths):
        return False
    return last.get("limit") == limit and not last.get("failed")


def share(count: int, total: int) -> str:
    if total <= 0:
        return ""
    p = count / total * 100
    s = f"{p:.1f}" if 0 < p < 10 or 90 < p < 100 else str(round(p))
    return f"{s[:-2] if s.endswith('.0') else s}%"


def resolve_ref(ws: str, ref: str) -> dict[str, Any]:
    """`concept:<id>` the label with its counts; `concept:<id>/<value>` one value's count, as the label's card shows it.
    KeyError for no such label or value."""
    body = ref.removeprefix("concept:")
    cid, _, value = body.partition("/")
    concept = store.find(ws, cid)
    if concept is None:
        raise KeyError(f"no label {cid!r}")
    counts, moved = store.effective_counts(ws, concept["id"])
    total = sum(counts.values())
    unit = concept["unit"]
    live = run.record(ws, concept["id"])
    running = bool(live and live.get("status") == "running")
    meta = {"name": concept["name"], "kind": concept["kind"], "unit": unit, "n_labeled": total}
    if value:
        value = value.replace("%20", " ")
        if value not in concept["labels"] and value not in counts:
            raise KeyError(f"the label {concept['name']!r} has no value {value!r}; its values are "
                           f"{', '.join(concept['labels'])}")
        n = counts.get(value, 0)
        excerpt = f"{value}: {n:,} {unit}{'' if n == 1 else 's'}"
        if total:
            excerpt += f" ({share(n, total)}) of the {total:,} labeled"
        excerpt += f" by the label {concept['name']}"
        if moved:
            excerpt += ", with the analyst's values"
        if running:
            excerpt += "; a run of it goes on, so the count can still change"
        return {"ref": ref, "kind": "concept", "concept_id": concept["id"], "excerpt": excerpt,
                "meta": {**meta, "label_value": value, "count": n, "shown": f"{n:,}"}}
    shown = ", ".join(f"{v}: {counts.get(v, 0):,}" for v in concept["labels"])
    what = concept["description"] or concept["spec"]
    excerpt = f"{concept['name']} ({concept['kind']} label, per {unit}): {what}\n{total:,} labeled ({shown})"
    if moved:
        excerpt += f"; {moved} of them the analyst set to another value, counted under that value"
    if running:
        excerpt += f"\na run of it goes on ({live.get('done', 0):,} of {live.get('total') or 0:,} so far)"
    return {"ref": ref, "kind": "concept", "concept_id": concept["id"], "excerpt": excerpt[:4000], "meta": meta,
            "ts": home.now()}
