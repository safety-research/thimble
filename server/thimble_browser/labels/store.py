"""Where labels are kept, and what is read from them.

The workspace's labels folder, `<workspace>/labels/`, is also what a card's code reads as thimble's workspace
(cards/kernel_thimble.py, `thimble.labels("<name>")`), so its files have the form that module reads:

    labels/concepts/<id>.json   a label's definition, its values with their colors, its runs (new_concept has the shape)
    labels/labels/<id>.jsonl    one row per labeled unit and run: {ref, label, confidence, source, ts, rationale?,
                                spans?, line?}; the analyst's own value of a unit is a row with source "analyst".
                                The last row of a ref of each kind counts.
    filters.json                (in the workspace) the filter of each scope: {files?, canvas?, report?}

A ref names a unit: `<path>#L<n>` a line of a file, `<path>#row=<n>` a row of a CSV file (with its `line`),
`<path>#/<key>` a value of a JSON document, `<path>` a whole file or a run's folder, `card:<id>` a card and
`report:report#<id>` a sentence of the report.
"""
from __future__ import annotations

import json
import os
import re
import secrets
import threading
from pathlib import Path
from typing import Any, Iterable

from .. import canvas, home
from ..cards.kernel_thimble import LABEL_ORDER, palette_from
from ..hub import hub

KINDS = ("prompt", "regex", "code")
FILE_UNITS = ("record", "agent", "run")
UNITS = (*FILE_UNITS, "cell", "span")
SCOPES = {"files": "record", "canvas": "cell", "report": "span"}
SCOPE_OF_UNIT = {**{u: "files" for u in FILE_UNITS}, "cell": "canvas", "span": "report"}
MARKS = ("span", "record", "file")
MARKS_UNIT = {"span": "record", "record": "record", "file": "agent"}
DEFAULT_VALUES = ["yes", "no"]
PALETTE = 12  # the colors new values take, --label-1..12; 0 is the gray of a negative value
PICKS = 18  # the colors a value can hold; 13..18 only when the analyst picks one
QUIET_VALUES = frozenset({"no", "none", "other", "no match", "not", "neither", "n/a", "unknown"})
LEFTOVER_WORDS = frozenset({"no", "not", "none", "neither", "nothing", "other", "unrelated", "irrelevant"})
DEFINITION = ("description", "spec", "labels", "kind", "unit", "marks", "model")  # a change steps the version
CHANGES_KEPT = 20
APPLICATIONS_KEPT = 50
ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
LINE_REF = re.compile(r"^(.*)#L(\d+)$")
COLOR_NAMES = {"blue": 1, "orange": 2, "green": 3, "sky blue": 4, "olive": 5, "teal": 6, "brown": 7, "navy": 8,
               "grass green": 9, "cerulean": 10, "chestnut": 11, "cyan": 12, "red": 13, "dark red": 14, "purple": 15,
               "dark purple": 16, "pink": 17, "dark pink": 18}

_lock = threading.RLock()


class LabelError(ValueError):
    """A request the labels cannot do, in words the analyst or Claude reads."""


# ---- paths

def root(ws: str) -> Path:
    """The workspace's labels folder: what card code reads as thimble's workspace."""
    d = home.workspace_dir(ws) / "labels"
    (d / "concepts").mkdir(parents=True, exist_ok=True)
    (d / "labels").mkdir(parents=True, exist_ok=True)
    return d


def _concept_path(ws: str, cid: str) -> Path:
    if not ID_RE.match(cid or ""):
        raise KeyError(cid)
    return root(ws) / "concepts" / f"{cid}.json"


def rows_path(ws: str, cid: str) -> Path:
    if not ID_RE.match(cid or ""):
        raise KeyError(cid)
    return root(ws) / "labels" / f"{cid}.jsonl"


def notify(ws: str, cid: str, what: str, rows: bool = True) -> None:
    """`concepts {concept, what, rows}` on the workspace's stream; `rows` False when the rows stay as they were."""
    hub.publish(ws, {"type": "concepts", "concept": cid, "what": what, "rows": rows})


# ---- values and their colors (as thimble 0.8, and kernel_thimble's mirror of it)

def values_list(values: Any) -> list[str]:
    out: list[str] = []
    for v in values if isinstance(values, list) else []:
        s = " ".join(str(v).split())
        if s and s not in out:
            out.append(s)
    return out or list(DEFAULT_VALUES)


def is_negative(value: str, index: int, n: int) -> bool:
    """A quiet word (no, none, other), the second of two, or a last value of more that starts with a leftover word."""
    v = value.strip().lower()
    return v in QUIET_VALUES or (n == 2 and index == 1) or (n > 2 and index == n - 1 and v.split(" ", 1)[0] in LEFTOVER_WORDS)


def _color(v: Any) -> int | None:
    try:
        n = int(v)
    except (TypeError, ValueError):
        return None
    return n if 0 <= n <= PICKS else None


def classes_of(values: list[str], stored: Any) -> list[dict[str, Any]]:
    """One {name, color, highlight} per value: the stored class of that name, else no color yet and highlighted unless
    it is the negative value."""
    by_name: dict[str, dict] = {}
    for c in stored if isinstance(stored, list) else []:
        if isinstance(c, dict) and str(c.get("name") or "").strip():
            by_name.setdefault(" ".join(str(c["name"]).split()), c)
    out = []
    for i, name in enumerate(values):
        c = by_name.get(name, {})
        hl = c.get("highlight")
        out.append({"name": name, "color": _color(c.get("color")),
                    "highlight": hl if isinstance(hl, bool) else not is_negative(name, i, len(values))})
    return out


def _own_color(want: int, taken: set[int]) -> int:
    if not want or want not in taken:
        return want
    return next((m for m in palette_from(want)[1:] if m not in taken), want)


def _free_color(start: int, used: set[int]) -> int | None:
    return next((m for m in palette_from(start) if m not in used), None)


def fill_colors(concepts: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Give every class without a color one, in place (thimble 0.8's fill_colours): a label's first value takes the
    first color no label has, a further value the colors after it, a negative value the gray."""
    used = {c["color"] for x in concepts for c in x.get("classes") or [] if c["color"]}
    k = 0
    for concept in concepts:
        classes = concept.get("classes") or []
        if not classes:
            continue
        n = len(classes)
        if classes[0]["color"] is None:
            classes[0]["color"] = _free_color(LABEL_ORDER[0], used)
            if classes[0]["color"] is None:
                classes[0]["color"] = LABEL_ORDER[k % PALETTE]
                k += 1
            used.add(classes[0]["color"])
        base = classes[0]["color"] or LABEL_ORDER[0]
        taken = {base} if classes[0]["color"] else set()
        for i, c in enumerate(classes[1:], 1):
            if c["color"] is None:
                at = palette_from(base)[i % PALETTE]
                c["color"] = 0 if is_negative(c["name"], i, n) else (_free_color(at, used | taken) or at)
            c["color"] = _own_color(c["color"], taken)
            if c["color"]:
                taken.add(c["color"])
                used.add(c["color"])
    return concepts


def marks_of(unit: str, marks: Any = None) -> str | None:
    if unit not in FILE_UNITS:
        return None
    if unit == "record":
        return marks if marks in ("span", "record") else "record"
    return "file"


def globs(glob: Any) -> list[str]:
    """The patterns of a comma-separated glob."""
    if isinstance(glob, list):
        return [str(p).strip() for p in glob if str(p).strip()]
    return [p.strip() for p in str(glob or "").split(",") if p.strip()]


# ---- definitions

def normalize(cid: str, data: Any) -> dict[str, Any]:
    data = data if isinstance(data, dict) else {}
    unit = data.get("unit") if data.get("unit") in UNITS else "record"
    values = values_list(data.get("labels"))
    within = data.get("within") if isinstance(data.get("within"), dict) and unit == "record" else None
    return {
        "id": cid,
        "name": " ".join(str(data.get("name") or cid).split()),
        "description": str(data.get("description") or ""),
        "unit": unit,
        "kind": data.get("kind") if data.get("kind") in KINDS else "prompt",
        "spec": str(data.get("spec") or ""),
        "labels": values,
        "marks": marks_of(unit, data.get("marks")),
        "glob": ", ".join(globs(data.get("glob"))) if unit in FILE_UNITS else "",
        "model": str(data.get("model") or "").strip(),
        "classes": classes_of(values, data.get("classes")),
        "shown": bool(data.get("shown")),
        "trial": bool(data.get("trial")),
        "comment": bool(data.get("comment")),
        "within": {"label": str(within.get("label")), "value": str(within.get("value"))} if within else None,
        "created_by": str(data.get("created_by") or "user"),
        "ts": str(data.get("ts") or home.now()),
        "version": int(data.get("version") or 1),
        "rev": int(data.get("rev") or 0),
        "changes": [e for e in data.get("changes") or [] if isinstance(e, dict)][-CHANGES_KEPT:],
        "applications": [a for a in data.get("applications") or [] if isinstance(a, dict)][-APPLICATIONS_KEPT:],
        "label_stats": data.get("label_stats") if isinstance(data.get("label_stats"), dict) else None,
        "calibration": data.get("calibration") if isinstance(data.get("calibration"), dict) else
        {"n": 0, "agreed": 0, "disagreed": 0, "est_precision": {}, "taught": 0},
    }


def new_concept(name: str, *, description: str = "", kind: str = "prompt", spec: str = "", unit: str = "record",
                labels: list[str] | None = None, created_by: str = "user", marks: str | None = None, glob: Any = "",
                model: str = "", classes: list[dict] | None = None, shown: bool = False) -> dict[str, Any]:
    """A new label's definition, not yet written. `marks` file makes a label over records one over whole files."""
    if kind not in KINDS:
        raise LabelError(f"kind must be one of {', '.join(KINDS)}")
    if marks is not None and marks not in MARKS:
        raise LabelError(f"marks must be one of {', '.join(MARKS)}")
    if marks is not None and unit in FILE_UNITS and (unit == "record" or marks != "file"):
        unit = MARKS_UNIT[marks]
    if unit not in UNITS:
        raise LabelError(f"unit must be one of {', '.join(UNITS)}")
    name = " ".join(str(name or "").split())
    if not name:
        raise LabelError("a label needs a name")
    if classes and not labels:
        labels = [str(c.get("name") or "") for c in classes if isinstance(c, dict)]
    return normalize(secrets.token_hex(4), {
        "name": name, "description": description, "kind": kind, "spec": spec, "unit": unit, "labels": labels,
        "created_by": created_by, "ts": home.now(), "version": 1, "marks": marks, "glob": glob, "model": model,
        "classes": classes, "shown": shown})


def read(ws: str, cid: str) -> dict[str, Any] | None:
    try:
        p = _concept_path(ws, cid)
    except KeyError:
        return None
    data = home.read_json(p)
    return normalize(cid, data) if isinstance(data, dict) else None


def write(ws: str, concept: dict[str, Any]) -> None:
    with _lock:
        home.write_json(_concept_path(ws, concept["id"]), concept)


def listing(ws: str) -> list[dict[str, Any]]:
    """Every label, oldest first, each value with its color."""
    out = []
    for p in sorted((root(ws) / "concepts").glob("*.json")):
        if ID_RE.match(p.stem) and (k := read(ws, p.stem)) is not None:
            out.append(k)
    out.sort(key=lambda k: (k["ts"], k["id"]))
    return fill_colors(out)


def colored(ws: str, concept: dict[str, Any]) -> dict[str, Any]:
    """The label with its values given the colors listing() gives them, so they are written with it."""
    others = [k for k in listing(ws) if k["id"] != concept["id"]]
    fill_colors(sorted([*others, concept], key=lambda k: (k["ts"], k["id"])))
    return concept


def find(ws: str, id_or_name: str) -> dict[str, Any] | None:
    """A label by its id (or `concept:<id>`), else by its name, case and spaces aside."""
    key = str(id_or_name or "").strip().removeprefix("concept:")
    if not key:
        return None
    if ID_RE.match(key) and (k := read(ws, key)) is not None:
        return k
    norm = " ".join(key.split()).casefold()
    return next((k for k in listing(ws) if k["name"].casefold() == norm), None)


def note_change(concept: dict[str, Any], what: str, text: str = "") -> dict[str, Any]:
    """Step the label's revision (what a card counting by it read) and keep what changed."""
    concept["rev"] = int(concept.get("rev") or 0) + 1
    concept["changes"] = [*concept.get("changes", []), {"what": what, "first": concept["rev"], "rev": concept["rev"],
                                                        "text": text, "ts": home.now()}][-CHANGES_KEPT:]
    return concept


def remove(ws: str, cid: str) -> None:
    for p in (_concept_path(ws, cid), rows_path(ws, cid)):
        try:
            p.unlink()
        except OSError:
            pass
    _cache.pop(str(rows_path(ws, cid)), None)


# ---- rows

def ref_place(ref: str, row: dict[str, Any] | None = None) -> tuple[str | None, int | None]:
    """(the file, the line) a ref stands on: `<path>#L<n>` its line; another ref into a file its `line` when the row
    has one; a card or a sentence (None, None)."""
    if ref.startswith(("card:", "cell:", "report:")):
        return None, None
    m = LINE_REF.match(ref)
    if m:
        return m.group(1), int(m.group(2))
    path = ref.split("#", 1)[0]
    line = (row or {}).get("line")
    return path, line if isinstance(line, int) and not isinstance(line, bool) and line >= 1 else None


def append_rows(ws: str, cid: str, rows: Iterable[dict[str, Any]]) -> int:
    lines = [json.dumps(r, ensure_ascii=False) for r in rows]
    if not lines:
        return 0
    with _lock:
        with open(rows_path(ws, cid), "a", encoding="utf-8") as f:
            f.write("\n".join(lines) + "\n")
    return len(lines)


def clear_model_rows(ws: str, cid: str, refs: set[str] | None = None) -> None:
    """Drop the rows the label's classifier gave (those of `refs` alone, when given); the analyst's rows stay."""
    p = rows_path(ws, cid)
    with _lock:
        kept = []
        for r in _read_rows(p):
            if r.get("source") == "analyst" or (refs is not None and str(r.get("ref")) not in refs):
                kept.append(json.dumps(r, ensure_ascii=False))
        tmp = p.with_suffix(".tmp")
        tmp.write_text("".join(x + "\n" for x in kept), encoding="utf-8")
        os.replace(tmp, p)


def _read_rows(p: Path) -> list[dict[str, Any]]:
    out = []
    try:
        with open(p, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    r = json.loads(line)
                except ValueError:
                    continue
                if isinstance(r, dict) and r.get("ref"):
                    out.append(r)
    except OSError:
        pass
    return out


_cache: dict[str, tuple[tuple[int, int], dict[str, dict[str, Any]]]] = {}


def merged(ws: str, cid: str) -> dict[str, dict[str, Any]]:
    """{ref: row}: the last classifier row of each ref with the analyst's value as `analyst`, in the order the refs
    were first labeled; read again only when the rows file changed."""
    p = rows_path(ws, cid)
    try:
        st = p.stat()
        key = (st.st_size, st.st_mtime_ns)
    except OSError:
        return {}
    hit = _cache.get(str(p))
    if hit is not None and hit[0] == key:
        return hit[1]
    model: dict[str, dict[str, Any]] = {}
    analyst: dict[str, dict[str, Any]] = {}
    for r in _read_rows(p):
        ref = str(r["ref"])
        if ref.startswith("cell:"):
            ref = "card:" + ref[5:]
        (analyst if r.get("source") == "analyst" else model)[ref] = r
    out: dict[str, dict[str, Any]] = {}
    for ref, r in model.items():
        a = analyst.get(ref)
        row = {"ref": ref, "label": r.get("label"), "confidence": r.get("confidence"), "rationale": r.get("rationale"),
               "source": r.get("source"), "ts": r.get("ts"), "analyst": a.get("label") if a else None}
        if r.get("spans"):
            row["spans"] = r["spans"]
        if isinstance(r.get("line"), int):
            row["line"] = r["line"]
        out[ref] = row
    for ref, a in analyst.items():
        if ref not in out:
            row = {"ref": ref, "label": None, "confidence": None, "rationale": None, "source": None, "ts": a.get("ts"),
                   "analyst": a.get("label")}
            if isinstance(a.get("line"), int):
                row["line"] = a["line"]
            out[ref] = row
    _cache[str(p)] = (key, out)
    return out


def effective(row: dict[str, Any]) -> str | None:
    return row.get("analyst") if row.get("analyst") is not None else row.get("label")


def stats(ws: str, cid: str) -> dict[str, Any]:
    """{n_labeled, n_reviewed, n_marked, counts}: the units the label gave a value, of them those the analyst gave one
    too, every unit the analyst gave one, and the count of each value the label gave."""
    rows = merged(ws, cid)
    counts: dict[str, int] = {}
    n_labeled = n_reviewed = n_marked = 0
    for r in rows.values():
        if r["label"] is not None:
            n_labeled += 1
            counts[str(r["label"])] = counts.get(str(r["label"]), 0) + 1
            n_reviewed += r["analyst"] is not None
        n_marked += r["analyst"] is not None
    return {"n_labeled": n_labeled, "n_reviewed": n_reviewed, "n_marked": n_marked, "counts": counts}


def effective_counts(ws: str, cid: str) -> tuple[dict[str, int], int]:
    """The counts with the analyst's values in place of the label's (as thimble.labels() counts), and how many units
    the analyst moved to another value."""
    counts: dict[str, int] = {}
    moved = 0
    for r in merged(ws, cid).values():
        if r["label"] is None:
            continue
        v = str(effective(r))
        counts[v] = counts.get(v, 0) + 1
        moved += r["analyst"] is not None and str(r["analyst"]) != str(r["label"])
    return counts, moved


def rows_on(ws: str, cid: str, path: str, spans: list[tuple[int, int]] | None = None) -> list[dict[str, Any]]:
    """The rows on one file: every one, or those on the lines `spans` cover and the file's whole-file rows."""
    out = []
    for ref, r in merged(ws, cid).items():
        p, line = ref_place(ref, r)
        if p != path:
            continue
        if spans is None or line is None or any(a <= line <= b for a, b in spans):
            out.append(r)
    return out


def rows_for_refs(ws: str, cid: str, refs: list[str]) -> list[dict[str, Any]]:
    rows = merged(ws, cid)
    return [rows[r] for r in refs if r in rows]


def presence(ws: str, cid: str) -> dict[str, dict[str, int]]:
    """{path: {value: n}}: the values the label left on each file."""
    out: dict[str, dict[str, int]] = {}
    for ref, r in merged(ws, cid).items():
        path, _ = ref_place(ref, r)
        v = effective(r)
        if path is None or v is None:
            continue
        per = out.setdefault(path, {})
        per[str(v)] = per.get(str(v), 0) + 1
    return out


def ruler(ws: str, cid: str, path: str, total: int, bins: int) -> dict[str, dict[int, int]]:
    """{value: {bin: n}}: where on a file of `total` lines the label's values fall, the lines cut into `bins`."""
    out: dict[str, dict[int, int]] = {}
    if total <= 0:
        return out
    for ref, r in merged(ws, cid).items():
        p, line = ref_place(ref, r)
        v = effective(r)
        if p != path or line is None or v is None:
            continue
        b = min(bins - 1, (line - 1) * bins // total)
        per = out.setdefault(str(v), {})
        per[b] = per.get(b, 0) + 1
    return out


def record_verdict(ws: str, concept: dict[str, Any], ref: str, value: str, note: str | None = None) -> dict[str, Any]:
    """The analyst's value of one unit; an empty value takes theirs back."""
    value = " ".join(str(value or "").split())
    if value and value not in concept["labels"]:
        raise LabelError(f"{concept['name']} has no value {value!r}; its values are {', '.join(concept['labels'])}")
    row: dict[str, Any] = {"ref": ref, "label": value or None, "source": "analyst", "ts": home.now()}
    if note:
        row["note"] = str(note)[:500]
    have = merged(ws, concept["id"]).get(ref)
    if have and isinstance(have.get("line"), int):
        row["line"] = have["line"]
    append_rows(ws, concept["id"], [row])
    rows = merged(ws, concept["id"])
    pairs = [(r["label"], r["analyst"]) for r in rows.values() if r["label"] is not None and r["analyst"] is not None]
    agreed = sum(1 for a, b in pairs if a == b)
    per: dict[str, list[int]] = {}
    for a, b in pairs:
        per.setdefault(str(a), []).append(int(a == b))
    concept["calibration"] = {"n": len(pairs), "agreed": agreed, "disagreed": len(pairs) - agreed,
                              "est_precision": {v: (sum(x) / len(x) if x else None) for v, x in per.items()}, "taught": 0}
    note_change(concept, "corrected")
    write(ws, concept)
    return rows.get(ref, row)


# ---- the label's card on the canvas

def label_cards(ws: str, cid: str) -> list[tuple[dict[str, Any], dict[str, Any]]]:
    out = []
    for nb in canvas.notebooks(ws):
        for cell in nb["cells"]:
            payload = cell.get("payload") if isinstance(cell.get("payload"), dict) else {}
            if cell.get("kind") == "label" and payload.get("concept") == cid:
                out.append((nb, cell))
    return out


def label_card(ws: str, concept: dict[str, Any], *, group: str | None, by: str, chat: str | None = None,
               question: str | None = None) -> dict[str, Any]:
    """The label's card, kind `label` with payload {concept}: the one it has (with a new question when one is given and
    the analyst has not locked it), else a new one in `group`, or in a group named after the label."""
    title = " ".join(str(question or "").split())
    with canvas._lock:
        for nb, cell in label_cards(ws, concept["id"]):
            if title and cell.get("title") != title and not cell.get("locked"):
                cell["title"] = title
                cell["ts"] = home.now()
                canvas.save(ws, nb)
                canvas.emit(ws, cell, "edited")
            return cell
        now = home.now()
        nb = canvas.group_for(ws, group or concept["name"], chat)
        taken = {c.get("slug") for g in canvas.notebooks(ws) for c in g["cells"]}
        cell = {"id": secrets.token_hex(4), "kind": "label", "title": title or concept["name"],
                "slug": canvas._slug(title or concept["name"], taken), "takeaway": "", "takeaway_author": None,
                "labels": [], "locked": False, "created_by": by, "created_at_event": None, "edited": [],
                "created_ts": now, "ts": now, "width": None, "height": None, "pos": None, "starred": False,
                "payload": {"concept": concept["id"]}, "notebook": nb["id"]}
        nb = canvas.load(ws, nb["id"])
        nb["cells"].append(cell)
        canvas.save(ws, nb)
    canvas.emit(ws, cell, "added")
    return cell


def drop_label_cards(ws: str, cid: str) -> None:
    with canvas._lock:
        for nb, cell in label_cards(ws, cid):
            nb = canvas.load(ws, nb["id"])
            nb["cells"] = [c for c in nb["cells"] if c["id"] != cell["id"]]
            canvas.save(ws, nb)
            canvas.emit(ws, cell, "deleted")


# ---- filters

CARD_LISTS = ("kinds", "groups", "makers", "checks")
CARD_FLAGS = ("starred", "locked")


def card_parts(raw: Any) -> dict[str, Any]:
    o = raw if isinstance(raw, dict) else {}
    out: dict[str, Any] = {}
    for part in CARD_LISTS:
        v = o.get(part)
        vals: list[str] = []
        for x in [v] if isinstance(v, str) else v if isinstance(v, list) else []:
            s = " ".join(x.split()) if isinstance(x, str) else ""
            if s and s not in vals:
                vals.append(s)
        if vals:
            out[part] = vals
    for part in CARD_FLAGS:
        if o.get(part) is True:
            out[part] = True
    text = " ".join(o["text"].split())[:200] if isinstance(o.get("text"), str) else ""
    if text:
        out["text"] = text
    return out


def _filters_path(ws: str) -> Path:
    return home.workspace_dir(ws) / "filters.json"


def read_filters(ws: str) -> dict[str, Any]:
    data = home.read_json(_filters_path(ws), {}) or {}
    out: dict[str, Any] = {}
    for scope in SCOPES:
        f = data.get(scope) if isinstance(data, dict) else None
        if not isinstance(f, dict):
            continue
        entry: dict[str, Any] = {}
        if f.get("concept") and f.get("value") is not None:
            entry = {"concept": str(f["concept"]), "value": str(f["value"])}
        if scope == "canvas":
            entry.update(card_parts(f))
        if entry:
            out[scope] = entry
    return out


def _filter_event(ws: str, scope: str, entry: dict[str, Any] | None) -> None:
    hub.publish(ws, {"type": "filter", "scope": scope, **{k: entry[k] for k in ("concept", "value") if entry and k in entry}})


def _files_label_off(ws: str, cid: str) -> None:
    k = read(ws, cid)
    if k is not None and k["shown"]:
        k["shown"] = False
        write(ws, colored(ws, k))
        notify(ws, cid, "changed", rows=False)


def set_filter(ws: str, scope: str, cid: str, value: str) -> dict[str, Any]:
    """The scope's label filter (a canvas filter keeps its card parts). In Files it is the label turned on with that
    value alone highlighted, and the label the filter named before turns off."""
    if scope not in SCOPES:
        raise LabelError(f"scope must be one of {', '.join(SCOPES)}")
    concept = find(ws, cid)
    if concept is None:
        raise KeyError(cid)
    value = " ".join(str(value or "").split())
    if not value:
        raise LabelError("a filter needs a value")
    with _lock:
        filters = read_filters(ws)
        before = filters.get(scope) or {}
        filters[scope] = {"concept": concept["id"], "value": value, **(card_parts(before) if scope == "canvas" else {})}
        home.write_json(_filters_path(ws), filters)
    if scope == "files":
        if before.get("concept") and before["concept"] != concept["id"]:
            _files_label_off(ws, before["concept"])
        if concept["unit"] in FILE_UNITS:
            concept["shown"] = True
            if any(c["name"] == value for c in concept["classes"]):
                for c in concept["classes"]:
                    c["highlight"] = c["name"] == value
            write(ws, colored(ws, concept))
            notify(ws, concept["id"], "changed", rows=False)
    _filter_event(ws, scope, filters[scope])
    return filters


def set_card_filter(ws: str, parts: dict[str, Any]) -> dict[str, Any]:
    with _lock:
        filters = read_filters(ws)
        entry = {k: v for k, v in (filters.get("canvas") or {}).items() if k in ("concept", "value")}
        entry.update(card_parts(parts))
        if entry:
            filters["canvas"] = entry
        else:
            filters.pop("canvas", None)
        home.write_json(_filters_path(ws), filters)
    _filter_event(ws, "canvas", entry)
    return filters


def clear_filter(ws: str, scope: str, *, whole: bool = False) -> dict[str, Any]:
    """Drop the scope's label filter (with `whole`, the canvas's card parts too). In Files the label turns off."""
    if scope not in SCOPES:
        raise LabelError(f"scope must be one of {', '.join(SCOPES)}")
    with _lock:
        filters = read_filters(ws)
        entry = filters.get(scope)
        left = {} if entry is None or whole or scope != "canvas" else card_parts(entry)
        if entry is None or left == entry:
            return filters
        if left:
            filters[scope] = left
        else:
            filters.pop(scope)
        home.write_json(_filters_path(ws), filters)
    if scope == "files" and entry.get("concept"):
        _files_label_off(ws, entry["concept"])
    _filter_event(ws, scope, left)
    return filters


def clear_filters_of(ws: str, cid: str) -> None:
    for scope, f in list(read_filters(ws).items()):
        if f.get("concept") == cid:
            clear_filter(ws, scope)


def show(ws: str, id_or_name: str, on: bool | None, values: list[str] | None = None,
         colors: dict[str, str] | None = None) -> dict[str, Any]:
    """Turn a label over files on or off in Files (it runs nothing); with `values`, on highlights those alone;
    `colors` gives values colors by name, a value that had the color taking the one it leaves."""
    concept = find(ws, id_or_name)
    if concept is None:
        names = ", ".join(repr(k["name"]) for k in listing(ws)) or "none yet"
        raise KeyError(f"no label {id_or_name!r}; the labels are {names}")
    if concept["unit"] not in FILE_UNITS:
        raise LabelError(f"the label {concept['name']!r} is over {SCOPE_OF_UNIT[concept['unit']]}, not files")
    wanted = [" ".join(str(v).split()) for v in values or [] if str(v).strip()]
    painted = {" ".join(str(v).split()): " ".join(str(n).split()).lower() for v, n in (colors or {}).items()}
    unknown = [v for v in [*wanted, *painted] if v not in concept["labels"]]
    if unknown:
        raise LabelError(f"the label {concept['name']!r} has no value {', '.join(map(repr, unknown))}; its values are "
                         f"{', '.join(concept['labels'])}")
    nameless = [n for n in painted.values() if n not in COLOR_NAMES]
    if nameless:
        raise LabelError(f"no label color is named {', '.join(map(repr, nameless))}; the colors are {', '.join(COLOR_NAMES)}")
    if on is not None:
        concept["shown"] = bool(on)
    if on and wanted:
        for c in concept["classes"]:
            c["highlight"] = c["name"] in wanted
    concept = colored(ws, concept)
    for value, name in painted.items():
        at = next(c for c in concept["classes"] if c["name"] == value)
        new, old = COLOR_NAMES[name], at["color"]
        for c in concept["classes"]:
            if c is not at and c["color"] == new:
                c["color"] = old
        at["color"] = new
    write(ws, concept)
    if on is False:
        f = read_filters(ws).get("files")
        if f and f.get("concept") == concept["id"]:
            clear_filter(ws, "files")
    notify(ws, concept["id"], "changed", rows=False)
    return concept
