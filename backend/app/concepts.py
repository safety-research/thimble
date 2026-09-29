"""Labels: predicates the analyst or a chat defines and applies in parallel over the units of one scope.

    workspaces/<c>/concepts/<id>.json   the label's definition (new_concept has the shape)
    workspaces/<c>/labels/<id>.jsonl    one row per application: {ref, label, confidence, rationale?, source, ts},
                                        plus cover and clear lines for runs over whole files (labels_store, covers)
    workspaces/<c>/labels/<id>.sqlite   the store (labels_store.py), derived from the jsonl and rebuilt from it
    workspaces/<c>/filters.json         the filter per scope: {files?, canvas?, report?}

Kinds: `prompt` sends units to the labels role's model in batches through the claude CLI (model.structured, `labels`
tool); `regex` matches a pattern, in the scan pool (concept_scan.py) for file units; `code` runs a Python `label(unit)`
in a dedicated kernel. Units: `record` (a line, `<path>#L<n>`), `agent` (a file), `run` (a run directory), `cell` (a
card, `card:<id>`, `cell:<id>` read as the same unit) and `span` (a report sentence). An apply runs as a background task
whose run record streams on GET .../events.

Trials: apply_label with a `limit` defines a trial (`trial: true`), left out of the Labels list and label counts until
a run without a limit makes it a label; a limited run over files samples its units across files (trial_sample).
The same predicate again: re-applying a label with the same definition (same_definition) keeps its version and rows,
and runs only over what its rows do not cover (covered).
Within: a label over records may run only over the records another label gave one value (`within {label, value}`, kept
on the concept), such as a prompt label over the few records a regex or code label kept in a large corpus.
The analyst's labels: a label run from the browser gets a card and main hears of it (`labeled`, tell_main) once per
version. A label that ran before without a card (such as the orientation's) keeps having none.
Revisions: `rev` counts changes to a label's rows (redefinition, correction, a finished run; note_change). A card that
read an older revision than the label's is stale (stale_in) and offers Regenerate Card; bring_current reruns labels
whose rows were made under another definition before such a card runs.
"""
from __future__ import annotations

import asyncio
import fnmatch
import itertools
import json
import logging
import multiprocessing
import os
import queue
import random
import re
import secrets
import sqlite3
import sys
import threading
import time
from collections import deque
from concurrent.futures import ProcessPoolExecutor
from concurrent.futures.process import BrokenProcessPool
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from decimal import ROUND_HALF_UP, Decimal
from functools import partial
from pathlib import Path
from typing import Any, Callable, Iterable, Iterator, NamedTuple

from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel, Field
from sse_starlette import EventSourceResponse, ServerSentEvent

from . import capture, cite, concept_scan, config, corpus, labels_store, refs
from .ledger import append_jsonl, append_jsonl_many, atomic_write_text, read_json

log = logging.getLogger("thimble.concepts")
_loop: asyncio.AbstractEventLoop | None = None  # the server's loop, so a sync route's worker thread can reach the stream


@asynccontextmanager
async def _lifespan(app: Any):
    """Remembers the event loop for the sync routes and shuts the scan pool down at the end."""
    global _loop
    _loop = asyncio.get_running_loop()
    try:
        yield
    finally:
        _pool_shutdown()


router = APIRouter(lifespan=_lifespan)


def _emit(c: str, event: dict) -> None:
    """One record on the workspace stream, from the loop or scheduled onto it from a worker thread. Never raises."""

    def _do() -> None:
        try:
            from . import investigation

            (config.WORKSPACES_DIR / c / "investigations" / "main").mkdir(parents=True, exist_ok=True)
            investigation.emit(c, "main", event)
        except Exception:  # noqa: BLE001
            log.debug("could not emit %s for %s", event.get("type"), c, exc_info=True)

    try:
        asyncio.get_running_loop()
    except RuntimeError:
        loop = _loop
        if loop is not None and loop.is_running() and not loop.is_closed():
            loop.call_soon_threadsafe(_do)
        return
    _do()


def _notify(c: str, concept_id: str, what: str) -> None:
    """`concepts {concept, what}` on the workspace stream after a label is defined, changed, applied or deleted."""
    _emit(c, {"type": "concepts", "concept": concept_id, "what": what})


KINDS = ("prompt", "regex", "code")
FILE_UNITS = ("record", "agent", "run")
MARKS = ("span", "record", "file")  # what a label over files marks in the reader
MARKS_UNIT = {"span": "record", "record": "record", "file": "agent"}
PALETTE = 12              # label colours --label-1..12; 0 is --label-none, the grey of "no match"
QUIET_VALUES = frozenset({"no", "none", "other", "no match", "not", "neither", "n/a", "unknown"})  # values that say nothing
LEFTOVER_WORDS = frozenset({"no", "not", "none", "neither", "nothing", "other", "unrelated", "irrelevant"})  # a leftover's first
UNITS = (*FILE_UNITS, "cell", "span")
SCOPES = {"files": "record", "canvas": "cell", "report": "span"}
DEFAULT_LABELS = ["yes", "no"]
REPORT_SLUG = "report"
CODE_KERNEL = "labels"  # the dedicated kernel the code kind runs in

BATCH_ITEMS = 10          # items per classifier call through the claude CLI (prompt kind)
BATCH_CHARS = 40_000      # or fewer items when their texts add up to this many chars
CONCURRENCY = 24          # classifier calls in flight through the CLI, a process each, at most (halved on a 429 or 529)
RETRY_DELAYS = (1.0, 2.0, 4.0, 8.0)  # seconds before each retry of a rate-limited batch
RETRY_JITTER = 0.25
BACKOFF_POLL = 0.2        # seconds between cancel checks while a retry waits
QUOTE_MAX = 4_000         # chars of a classifier's quote kept on a row
WINDOW_TEXT_MAX = 30_000  # chars of a record's or a sentence's text in one classifier item; a longer one is read in windows
WINDOW_OVERLAP = 400      # chars each window repeats of the one before it
UNIT_TEXT_MAX = 30_000    # chars for an agent, run or cell unit, which are read no further
CHUNK = 500               # records read per corpus.load_records call
RATIONALE_MAX = 500       # chars of a classifier's rationale kept on a row
APPLICATIONS_KEPT = 50    # run summaries kept on the concept
APPLY_WAIT_S = 60.0       # apply_scoped and `wait: true` wait this long for the summary, then answer with the run so far
PROGRESS_EVERY_S = 0.25   # a run's progress record is streamed at most this often
SCAN_INFLIGHT_PER_WORKER = 2
SCAN_STOPPED = "a scan worker stopped; the rows so far are kept, apply again to finish"
ROWS_LIMIT = 200          # rows the rows route answers by default
ROWS_MAX = 2_000
EXAMPLES_MAX = 8          # analyst verdicts a prompt apply carries as few-shot examples
EXAMPLE_TEXT_MAX = 600    # chars of an example's text shown to the model
MATCH_TEXT_MAX = 2000     # chars of a unit's text searched for the words that earned its value (refs.EXCERPT_MAX)
MATCH_WINDOW = 240        # chars of a unit's text shown around those words (canvas/bodies.tsx LABEL_EXAMPLE_MAX)
MATCH_BEFORE = 60         # of them, at most, before the words
CHANGE_KINDS = ("redefined", "corrected", "ran")  # what a change to a label's rows is (note_change)
CHANGES_KEPT = 20         # changes kept on a label, which a stale card's tag reads what changed from
ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_CONCEPT_REF = re.compile(r"^concept:([A-Za-z0-9_-]+)(?:/(.+))?$")


def apply_workers() -> int:
    """THIMBLE_APPLY_WORKERS as a positive integer, else min(CPU − 1, 8) and at least 1: the scan pool's size."""
    raw = os.environ.get("THIMBLE_APPLY_WORKERS", "").strip()
    if raw:
        try:
            n = int(raw)
        except ValueError:
            n = 0
        if n >= 1:
            return n
        log.warning("THIMBLE_APPLY_WORKERS=%r is not a positive integer; using the default", raw)
    return max(1, min((os.cpu_count() or 2) - 1, 8))


def labels_model(c: str) -> tuple[str, str | None]:
    """(model, effort) of the labels role for a workspace (config.models_for)."""
    conf = config.models_for(c)["labels"]
    return str(conf["model"]), conf.get("effort")


# --------------------------------------------------------------------------- storage


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _new_id() -> str:
    return secrets.token_hex(4)


def _ws(c: str) -> Path:
    try:
        return config.workspace_dir(c)
    except ValueError as e:
        raise HTTPException(404, str(e)) from e


def concepts_dir(ws: Path) -> Path:
    return ws / "concepts"


def labels_file(ws: Path, concept_id: str) -> Path:
    return ws / "labels" / f"{concept_id}.jsonl"


def filters_file(ws: Path) -> Path:
    return ws / "filters.json"


def _concept_file(ws: Path, concept_id: str) -> Path:
    if not ID_RE.match(concept_id or ""):
        raise HTTPException(404, f"invalid concept id: {concept_id!r}")
    return concepts_dir(ws) / f"{concept_id}.json"


def _labels_list(labels: Any) -> list[str]:
    out: list[str] = []
    for l in labels if isinstance(labels, list) else []:
        s = str(l).strip()
        if s and s not in out:
            out.append(s)
    return out or list(DEFAULT_LABELS)


def is_negative(value: str, index: int, n: int) -> bool:
    """Whether a value is a label's negative: a quiet word (no, none, other, no match), the second of two, or the last of
    more when it starts with a word such as not, no or other ("not about it"), the value left for what fits no other."""
    v = value.strip().lower()
    return v in QUIET_VALUES or (n == 2 and index == 1) or (n > 2 and index == n - 1 and v.split(" ", 1)[0] in LEFTOVER_WORDS)


def marks_of(unit: str, marks: Any = None) -> str | None:
    """What a label over files marks: `marks` when it fits the unit (span or record for records, file for files and
    runs), else what the unit implies; None for a label of cards or report sentences."""
    if unit not in FILE_UNITS:
        return None
    if unit == "record":
        return marks if marks in ("span", "record") else "record"
    return "file"


def _colour(v: Any) -> int | None:
    try:
        n = int(v)
    except (TypeError, ValueError):
        return None
    return n if 0 <= n <= PALETTE else None


def classes_of(labels: list[str], stored: Any) -> list[dict]:
    """One {name, color, highlight} per value, in the values' order: the stored class of that name when there is one,
    else no colour yet (fill_colours gives it one) and highlighted unless it is the negative."""
    by_name: dict[str, dict] = {}
    for c in stored if isinstance(stored, list) else []:
        if isinstance(c, dict) and str(c.get("name") or "").strip():
            by_name.setdefault(str(c["name"]).strip(), c)
    out = []
    for i, name in enumerate(labels):
        c = by_name.get(name, {})
        hl = c.get("highlight")
        out.append({"name": name, "color": _colour(c.get("color")),
                    "highlight": bool(hl) if isinstance(hl, bool) else not is_negative(name, i, len(labels))})
    return out


def own_colour(want: int, taken: set[int]) -> int:
    """`want`, or the first palette colour after it that no other class of the label has (`taken`); `want` itself when
    every colour is taken or it is the grey."""
    if not want or want not in taken:
        return want
    return next((m for m in ((want - 1 + j) % PALETTE + 1 for j in range(1, PALETTE)) if m not in taken), want)


def free_colour(start: int, used: set[int]) -> int | None:
    """The first palette colour from `start` on, round the palette, that `used` does not hold; None when it holds every
    one."""
    return next((m for m in ((start - 1 + j) % PALETTE + 1 for j in range(PALETTE)) if m not in used), None)


def fill_colours(concepts: list[dict]) -> list[dict]:
    """Give every class without a colour one, in place, and return the list. While a palette colour is free, one no class
    of any label has, a label's first class takes the first free one; when none is free, the colours in turn. A further
    class takes the free colour, else any, that looks most unlike its label's colours (kernel_thimble.most_distinct). A
    negative class takes the grey, and a label's classes do not repeat a colour while one is free (own_colour)."""
    from .kernel_thimble import most_distinct  # noqa: PLC0415
    used = {c["color"] for x in concepts for c in x.get("classes") or [] if c["color"]}
    k = 0
    for concept in concepts:
        classes = concept.get("classes") or []
        if not classes:
            continue
        n = len(classes)
        if classes[0]["color"] is None:
            classes[0]["color"] = free_colour(1, used)
            if classes[0]["color"] is None:
                classes[0]["color"] = k % PALETTE + 1
                k += 1
            used.add(classes[0]["color"])
        base = classes[0]["color"] or 1
        taken = {base} if classes[0]["color"] else set()
        for i, c in enumerate(classes[1:], 1):
            if c["color"] is None:
                mine = [m for m in range(1, PALETTE + 1) if m not in taken]
                c["color"] = 0 if is_negative(c["name"], i, n) else most_distinct(taken, [m for m in mine if m not in used] or mine or [base])
            c["color"] = own_colour(c["color"], taken)
            if c["color"]:
                taken.add(c["color"])
                used.add(c["color"])
    return concepts


def glob_patterns(glob: Any) -> list[str]:
    """The patterns of a label's `glob` (comma-separated)."""
    return [p.strip() for p in str(glob or "").split(",") if p.strip()]


def _normalize(concept_id: str, data: Any) -> dict:
    data = data if isinstance(data, dict) else {}
    kind = data.get("kind") if data.get("kind") in KINDS else "prompt"
    unit = data.get("unit") if data.get("unit") in UNITS else "record"
    cal = data.get("calibration") if isinstance(data.get("calibration"), dict) else {}
    labels = _labels_list(data.get("labels"))
    applications = [a for a in (data.get("applications") or []) if isinstance(a, dict)]
    glob = str(data.get("glob") or "").strip()
    if not glob and unit in FILE_UNITS:
        last = next((a for a in reversed(applications) if a.get("paths")), None)
        glob = ", ".join(_patterns(last["paths"])) if last else ""
    return {
        "id": concept_id,
        "name": str(data.get("name") or concept_id),
        "description": str(data.get("description") or ""),
        "unit": unit,
        "kind": kind,
        "spec": str(data.get("spec") or ""),
        "labels": labels,
        "marks": marks_of(unit, data.get("marks")),
        "glob": glob if unit in FILE_UNITS else "",
        "model": str(data.get("model") or "").strip(),
        "classes": classes_of(labels, data.get("classes")),
        "shown": bool(data.get("shown")),
        "trial": bool(data.get("trial")),
        "calibration": {
            "n": int(cal.get("n") or 0),
            "agreed": int(cal.get("agreed") or 0),
            "disagreed": int(cal.get("disagreed") or 0),
            "est_precision": cal.get("est_precision") if isinstance(cal.get("est_precision"), dict) else {},
        },
        "created_by": str(data.get("created_by") or "user"),
        "ts": str(data.get("ts") or _now()),
        "version": int(data.get("version") or 1),
        "told": int(data.get("told") or 0),
        "rev": int(data.get("rev") or 0),
        "changes": _changes_field(data.get("changes")),
        "applications": applications,
        "label_stats": _label_stats_field(data.get("label_stats")),
        "within": _within_field(data.get("within")) if unit == "record" else None,
    }


def _within_field(v: Any) -> dict | None:
    """`within` as stored: {label: an id, value}, else None."""
    if not isinstance(v, dict) or not ID_RE.match(str(v.get("label") or "")) or not str(v.get("value") or ""):
        return None
    return {"label": str(v["label"]), "value": str(v["value"])}


def _changes_field(v: Any) -> list[dict]:
    """`changes` as stored (note_change): the entries that are dicts with a `what` and whole revisions."""
    out = []
    for e in v if isinstance(v, list) else []:
        try:
            if isinstance(e, dict) and e.get("what") in CHANGE_KINDS:
                out.append({"what": e["what"], "first": int(e.get("first") or e.get("rev") or 0), "rev": int(e.get("rev") or 0),
                            "text": str(e.get("text") or ""), "ts": str(e.get("ts") or "")})
        except (TypeError, ValueError):
            continue
    return out


def _label_stats_field(v: Any) -> dict | None:
    """`label_stats` as stored: {key: [size, mtime_ns], n_labeled, n_reviewed, counts}; None when absent or malformed."""
    if not isinstance(v, dict) or not isinstance(v.get("key"), (list, tuple)) or len(v["key"]) != 2:
        return None
    try:
        key = [int(v["key"][0]), int(v["key"][1])]
        counts = {str(k): int(n) for k, n in (v.get("counts") or {}).items()} if isinstance(v.get("counts"), dict) else {}
        return {"key": key, "n_labeled": int(v.get("n_labeled") or 0), "n_reviewed": int(v.get("n_reviewed") or 0), "counts": counts}
    except (TypeError, ValueError):
        return None


def new_concept(name: str, description: str = "", kind: str = "prompt", spec: str | None = None, unit: str = "record",
                labels: list[str] | None = None, created_by: str = "user", *, marks: str | None = None, glob: str = "",
                model: str = "", classes: list[dict] | None = None, shown: bool = False) -> dict:
    """A fresh concept dict (not written). For the prompt kind an empty spec means the description is the spec. `marks`
    file makes a record-unit label a file-unit one (MARKS_UNIT)."""
    if kind not in KINDS:
        raise HTTPException(400, f"kind must be one of {', '.join(KINDS)}")
    if marks is not None and marks not in MARKS:
        raise HTTPException(400, f"marks must be one of {', '.join(MARKS)}")
    if marks is not None and unit in FILE_UNITS:
        unit = MARKS_UNIT[marks] if unit == "record" or marks != "file" else unit
    if unit not in UNITS:
        raise HTTPException(400, f"unit must be one of {', '.join(UNITS)}")
    name = " ".join(str(name or "").split())
    if not name:
        raise HTTPException(400, "name is required")
    if classes and not labels:
        labels = [str(c.get("name") or "") for c in classes if isinstance(c, dict)]
    return _normalize(_new_id(), {"name": name, "description": description or "", "kind": kind, "unit": unit, "spec": spec or "",
                                  "labels": labels, "created_by": created_by, "ts": _now(), "version": 1, "marks": marks,
                                  "glob": glob, "model": model, "classes": classes, "shown": shown})


def read_concept(ws: Path, concept_id: str) -> dict | None:
    p = _concept_file(ws, concept_id)
    if not p.is_file():
        return None
    try:
        return _normalize(concept_id, json.loads(p.read_text("utf-8")))
    except ValueError:
        log.warning("unreadable concept %s", p)
        return None


def write_concept(ws: Path, concept: dict) -> None:
    p = _concept_file(ws, concept["id"])
    p.parent.mkdir(parents=True, exist_ok=True)
    atomic_write_text(p, json.dumps(concept, indent=1, ensure_ascii=False))


def list_concepts(ws: Path, *, trials: bool = True) -> list[dict]:
    """Every concept, oldest first, each class with a colour (fill_colours). `trials` False leaves out the trials, for a count
    of the workspace's labels."""
    d = concepts_dir(ws)
    out = []
    for p in d.glob("*.json") if d.is_dir() else ():
        if ID_RE.match(p.stem) and (c := read_concept(ws, p.stem)) is not None and (trials or not c["trial"]):
            out.append(c)
    out.sort(key=lambda c: (c["ts"], c["id"]))
    return fill_colours(out)


def coloured(ws: Path, concept: dict) -> dict:
    """The concept, its classes given the colours list_concepts gives them (a concept not yet written takes the next
    free ones), so the colours are written with it."""
    others = [c for c in list_concepts(ws) if c["id"] != concept["id"]]
    fill_colours(sorted([*others, concept], key=lambda c: (c["ts"], c["id"])))
    return concept


def find_concept(ws: Path, id_or_name: str) -> dict | None:
    """By id first, then by name (case- and whitespace-insensitive)."""
    key = str(id_or_name or "").strip()
    if not key:
        return None
    if ID_RE.match(key) and (c := read_concept(ws, key)) is not None:
        return c
    norm = " ".join(key.split()).casefold()
    for c in list_concepts(ws):
        if " ".join(c["name"].split()).casefold() == norm:
            return c
    return None


def load_concept(c: str, concept_id: str) -> tuple[Path, dict]:
    ws = _ws(c)
    concept = read_concept(ws, concept_id)
    if concept is None:
        raise HTTPException(404, f"no such concept: {concept_id}")
    return ws, concept


# --------------------------------------------------------------------------- label rows: the store
#
# The jsonl is the record; the store answers every read. A store that is missing, behind or stale is brought up to
# date by the reader that finds it: inline when the work is at most labels_store.SYNC_INLINE_BYTES, else rebuilt in
# the background while the reads answer from the jsonl flagged `building`. A store that is behind while its run
# appends is read as it stands (the run's writer commits every chunk).

INDEX_BUILDING = "the label index is being built; the counts appear when it is done"
BUILD_WAIT_S = 600.0  # a writer waits this long for a rebuild in progress before it goes on without it

_store_locks: dict[Path, threading.RLock] = {}
_store_locks_guard = threading.Lock()
_building: dict[Path, threading.Thread] = {}  # rebuilds in progress, by labels file
_building_answers: dict[Path, dict] = {}  # {path: rows} the jsonl answered while its store is built


def _store_lock(p: Path) -> threading.RLock:
    with _store_locks_guard:
        return _store_locks.setdefault(p, threading.RLock())


def _store_building(p: Path) -> bool:
    t = _building.get(p)
    if t is None:
        return False
    if t.is_alive():
        return True
    _building.pop(p, None)
    _building_answers.pop(p, None)
    return False


def _store(ws: Path, concept_id: str) -> tuple[labels_store.Store | None, bool]:
    """(the store to read, or None; whether a rebuild is in progress). Blocking when the store needs a small sync.
    None with `building` False means no labels at all."""
    if not ID_RE.match(concept_id or ""):
        return None, False
    p = labels_file(ws, concept_id)
    _off_loop(p)
    st = labels_store.Store(p)
    state, m = st.state()
    if state == "none":
        return None, False
    if state == "fresh":
        return st, False
    if _store_building(p):
        return (st if state == "behind" else None), True
    if state == "behind" and _applying(ws.name, concept_id):
        return st, False
    with _store_lock(p):
        state, m = st.state()
        if state == "fresh":
            return st, False
        if state == "none":
            return None, False
        if _store_building(p):
            return (st if state == "behind" else None), True
        if _sync_tail(p, state, m) <= labels_store.SYNC_INLINE_BYTES:
            _sync_inline(p, st, state, m)
            return st, False
        _building[p] = _rebuild_in_background(st)
        return (st if state == "behind" else None), True


def _sync_tail(p: Path, state: str, m: dict) -> int:
    """The bytes a sync must read: the unread tail when the store is behind, the whole file otherwise."""
    size = (labels_store.file_key(p) or (0, 0))[0]
    return size - int(m.get("parsed") or 0) if state == "behind" else size


def _sync_inline(p: Path, st: labels_store.Store, state: str, m: dict) -> None:
    t0 = time.monotonic()
    n = st.ingest(int(m["parsed"])) if state == "behind" else st.rebuild()
    log.info("labels store %s: %s (%d rows) in %.0f ms", p.name, "caught up" if state == "behind" else "built", n,
             (time.monotonic() - t0) * 1000)


_off_loop_seen: set[tuple[str, int]] = set()


def _off_loop(p: Path) -> None:
    """Logs once per call site when a label read runs on the event loop's thread, where it would stall every request."""
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return
    frame = sys._getframe(2)
    site = (frame.f_code.co_filename, frame.f_lineno)
    if site in _off_loop_seen:
        return
    _off_loop_seen.add(site)
    log.warning("labels store %s: a label read on the event loop thread (%s:%d); call it in a worker thread", p.name, site[0], site[1])


def _rebuild_in_background(st: labels_store.Store) -> threading.Thread:
    """A rebuild of `st` from its jsonl started in a thread: in a scan-pool process when the pool is there."""
    def run() -> None:
        t0 = time.monotonic()
        try:
            n = _rebuild_store(st)
            log.info("labels store %s: rebuilt (%d rows) in %.1f s", st.db.name, n, time.monotonic() - t0)
        except Exception:  # noqa: BLE001
            log.exception("labels store %s: the rebuild failed; the reads answer from the labels file", st.db.name)

    t = threading.Thread(target=run, name=f"labels-store-{st.db.stem}", daemon=True)
    t.start()
    return t


def _rebuild_store(st: labels_store.Store) -> int:
    try:
        with _pool_lock:
            pool = _pool_get()
        return pool.submit(labels_store.rebuild_file, str(st.jsonl)).result()
    except Exception:  # noqa: BLE001
        log.info("labels store %s: rebuilding in-process (the scan pool did not take it)", st.db.name, exc_info=True)
        return st.rebuild()


_pool_lock = threading.Lock()


def _store_ready(ws: Path, concept_id: str, *, wait: bool = True) -> labels_store.Store | None:
    """Blocking (worker thread): the store a writer may add to, made fresh here when it is not. With `wait` a rebuild
    in progress is waited for; without it None comes back while a build runs and the caller appends to the jsonl alone."""
    p = labels_file(ws, concept_id)
    st = labels_store.Store(p)
    lock = _store_lock(p)
    _off_loop(p)
    started = 0
    while True:
        with lock:
            if not _store_building(p):
                state, m = st.state()
                if state == "fresh":
                    return st
                if state == "none":
                    p.parent.mkdir(parents=True, exist_ok=True)
                    st.connect(write=True).close()
                    return st
                if _sync_tail(p, state, m) <= labels_store.SYNC_INLINE_BYTES or started >= 2:
                    _sync_inline(p, st, state, m)
                    return st
                _building[p] = _rebuild_in_background(st)
                started += 1
            t = _building[p]
        if not wait:
            return None
        t.join(BUILD_WAIT_S)
        if t.is_alive():
            log.warning("labels store %s: still being rebuilt after %.0f s; the writer keeps waiting", p.name, BUILD_WAIT_S)


def _jsonl_answer(p: Path, path: str | None, lines: tuple[int, int] | None = None) -> list[dict]:
    """While a store is rebuilt: the rows on `path` (on `lines` of it) from one pass over the jsonl, memoised for the build."""
    memo = _building_answers.setdefault(p, {})
    key = (path, lines)
    if key not in memo:
        memo[key] = labels_store.scan_jsonl(p, path, lines)
    return memo[key]


def index_building(ws: Path, concept_id: str) -> bool:
    return ID_RE.match(concept_id or "") is not None and _store_building(labels_file(ws, concept_id))


def _parse_labels(p: Path) -> list[dict]:
    return list(labels_store._read_rows(p, 0, (labels_store.file_key(p) or (0, 0))[0]))


YIELD_EVERY = 200  # rows walked between two yields of the interpreter


def _applying(c: str, concept_id: str) -> bool:
    state = _runs.get((c, concept_id))
    return bool(state and state.get("status") == "running")


def read_labels(ws: Path, concept_id: str) -> list[dict]:
    """Every row of labels/<id>.jsonl, in file order (tests and one-off counts; the routes read the store)."""
    if not ID_RE.match(concept_id or ""):
        return []
    return _parse_labels(labels_file(ws, concept_id))


def _stats(ws: Path, concept_id: str) -> dict:
    st, _building_now = _store(ws, concept_id)
    return st.stats() if st is not None else label_stats([])


def rows_for_path(ws: Path, concept_id: str, path: str | None, lines: tuple[int, int] | None = None) -> list[dict]:
    """The merged rows (latest classifier row per ref with the analyst's verdict) on one corpus path; every row when
    `path` is None; with `lines` (a, b) those on lines a..b of the path and its whole-file rows, so the reader asks for
    its page and never for every row of a large labelled file."""
    st, building = _store(ws, concept_id)
    if st is not None:
        return st.rows_for_path(path, lines)
    if building:
        return _jsonl_answer(labels_file(ws, concept_id), path, lines)
    return []


def concept_rows(ws: Path, concept_id: str, value: str | None, limit: int, offset: int,
                 texts: Callable[[list[str]], dict[str, str]] | None = None, after: int | None = None) -> dict:
    """{rows: [{ref, label, confidence, rationale, analyst, spans?}], total, next} for the rows route; empty and flagged
    `building` while the store is rebuilt. `texts` (unit_texts) adds each row's `text`, or for a row with `spans` the words
    around the first as `text` and it as `match` (match_window). Pages by rowid key-set: `next` is passed back as `after`;
    `offset` is honoured when no cursor is given."""
    st, building = _store(ws, concept_id)
    if st is None:
        out: dict[str, Any] = {"rows": [], "total": 0, "next": None}
        if building:
            out.update(building=True, note=INDEX_BUILDING)
        return out
    rows, total, cursor = st.rows(value, limit, offset, after)
    page = [{k: r.get(k) for k in ("ref", "label", "confidence", "rationale", "analyst", *(("spans",) if r.get("spans") else ()))}
            for r in rows]
    if texts is not None and page:
        found = texts([str(r["ref"]) for r in page])
        marked = [str(r["ref"]) for r in page if r.get("spans")]
        whole = texts(marked, cap=MATCH_TEXT_MAX) if marked else {}
        for r in page:
            r["text"] = found.get(str(r["ref"]), "")
            # the example shows at most MATCH_WINDOW characters, so a longer span is found and marked by its start
            span = r["spans"][0][:MATCH_WINDOW] if r.get("spans") else ""
            window = match_window(whole.get(str(r["ref"]), ""), span) if span else None
            if window:
                r["text"], r["match"] = window, span
    return {"rows": page, "total": total, "next": cursor}


def match_window(text: str, span: str) -> str | None:
    """The part of a unit's text around `span`, the words that earned the unit its value, so a label card's example shows why
    the unit got it: up to MATCH_BEFORE characters before it, from a word's start, then up to MATCH_WINDOW in all, with an
    ellipsis where the text goes on. None when the text does not hold `span`."""
    i = text.find(span) if span else -1
    if i < 0:
        return None
    start = max(0, i - MATCH_BEFORE)
    if start > 0:
        gap = text.find(" ", start, i)
        start = gap + 1 if gap >= 0 else start
    end = min(len(text), max(i + len(span), start + MATCH_WINDOW))
    return ("…" if start > 0 else "") + text[start:end].strip() + ("…" if end < len(text) else "")


def unit_texts(c: str, concept: dict, refs_wanted: list[str], cap: int = EXAMPLE_TEXT_MAX) -> dict[str, str]:
    """{ref: text} for the units the refs name, at most `cap` chars each: a cell or span from the scope's units (the
    ref route does not resolve them), a file unit through refs.resolve. A ref that resolves to nothing is left out.
    Blocking (worker thread)."""
    wanted = [str(r) for r in refs_wanted if str(r)]
    if not wanted:
        return {}
    out: dict[str, str] = {}
    if concept["unit"] in ("cell", "span"):
        want = set(wanted)
        try:
            for u in scope_units(c, concept["unit"]):
                if u.ref in want:
                    t = u.text(cap)
                    if t.strip():
                        out[u.ref] = t
        except Exception:  # noqa: BLE001
            log.debug("unit texts: the %s units could not be read", concept["unit"], exc_info=True)
        return out
    try:
        corpus_dir = config.corpus_dir(c)
    except ValueError:
        return out
    for ref in wanted:
        try:
            t = str(refs.resolve(corpus_dir, ref).get("excerpt") or "")
        except Exception:  # noqa: BLE001
            continue
        if t.strip():
            out[ref] = t[:cap] + ("…" if len(t) > cap else "")
    return out


class _LabelsWriter:
    """A run's one writer of its labels: a thread that appends each chunk's JSONL bytes to the file, then upserts the
    chunk's rows into the store with the file's new key. A failure of the store is logged once and the file goes on;
    a failure of the file ends the run."""

    def __init__(self, out: Path) -> None:
        self.out = out
        self.q: queue.Queue = queue.Queue(maxsize=WRITER_QUEUE)
        self.error: BaseException | None = None
        self.store_failed = False
        self.written = 0
        self._thread = threading.Thread(target=self._run, name=f"labels-writer-{out.stem}", daemon=True)

    def start(self) -> "_LabelsWriter":
        self._thread.start()
        return self

    def put(self, data: bytes, rows: list[dict]) -> None:
        """Queue one chunk (blocking while the queue is full: call it in a worker thread)."""
        if self.error is not None:
            raise self.error
        if data or rows:
            self.q.put((data, rows))

    def close(self) -> None:
        self.q.put(None)
        self._thread.join()
        if self.error is not None:
            raise self.error

    def _run(self) -> None:
        f = None
        conn = None
        store = labels_store.Store(self.out)
        lock = _store_lock(self.out)
        try:
            while True:
                item = self.q.get()
                if item is None:
                    break
                data, rows = item
                if self.error is not None:
                    continue
                try:
                    with lock:
                        if f is None:
                            labels_store.mend_tail(self.out)
                            f = self.out.open("ab")
                        f.write(data)
                        f.flush()
                        st = os.fstat(f.fileno())
                        key = (st.st_size, st.st_mtime_ns)
                        self.written += len(rows)
                        if not self.store_failed:
                            try:
                                if conn is None:
                                    conn = store.connect(write=True)
                                store.add(rows, key, conn)
                            except sqlite3.Error:
                                self.store_failed = True
                                log.exception("labels store %s: a write failed; the rows are in the labels file and the "
                                              "store is rebuilt from it on the next read", self.out.name)
                except OSError as e:
                    self.error = e
        finally:
            if conn is not None:
                conn.close()
            if f is not None:
                f.close()


WRITER_QUEUE = 16  # chunks a run's writer holds before the scan waits for it


def latest_rows(rows: list[dict]) -> tuple[dict[str, dict], dict[str, dict]]:
    """(latest classifier row per ref, latest analyst row per ref); file order is time order."""
    model: dict[str, dict] = {}
    analyst: dict[str, dict] = {}
    for i, r in enumerate(rows):
        (analyst if r.get("source") == "analyst" else model)[labels_store.canon_ref(r["ref"])] = r
        if i % YIELD_EVERY == YIELD_EVERY - 1:
            time.sleep(0)
    return model, analyst


def calibration_stats(rows: list[dict], labels: list[str]) -> dict:
    model, analyst = latest_rows(rows)
    pairs = [(str(m.get("label")), str(a.get("label"))) for ref, a in analyst.items() if (m := model.get(ref)) is not None]
    return _calibration_from_pairs(pairs, labels)


def _calibration_from_pairs(pairs: list[tuple[str, str]], labels: list[str]) -> dict:
    """The agreement between the classifier and the analyst over (classifier label, analyst label) pairs."""
    per: dict[str, list[int]] = {l: [] for l in labels}
    agreed = 0
    n = 0
    for m_label, a_label in pairs:
        n += 1
        ok = int(m_label == a_label)
        agreed += ok
        per.setdefault(m_label, []).append(ok)
    return {"n": n, "agreed": agreed, "disagreed": n - agreed,
            "est_precision": {l: (sum(v) / len(v) if v else None) for l, v in per.items()}}


def label_stats(rows: list[dict]) -> dict:
    model, analyst = latest_rows(rows)
    counts: dict[str, int] = {}
    for r in model.values():
        counts[str(r.get("label"))] = counts.get(str(r.get("label")), 0) + 1
    return {"n_labeled": len(model), "n_reviewed": sum(1 for ref in analyst if ref in model), "counts": counts}


def _merged_rows(rows: list[dict], path: str | None = None) -> list[dict]:
    """Latest classifier row per ref with the analyst's verdict attached (and the texts it marks), optionally only for
    refs on `path`."""
    model, analyst = latest_rows(rows)
    out = []
    for ref, r in model.items():
        if path is not None and _ref_path(ref) != path:
            continue
        a = analyst.get(ref)
        row = {"ref": ref, "label": r.get("label"), "confidence": r.get("confidence"), "rationale": r.get("rationale"),
               "source": r.get("source"), "ts": r.get("ts"), "analyst": a.get("label") if a else None}
        marked = labels_store.spans_field(r.get("spans"))
        if marked:
            row["spans"] = marked
        out.append(row)
    for ref, a in analyst.items():
        if ref not in model and (path is None or _ref_path(ref) == path):
            out.append({"ref": ref, "label": None, "confidence": None, "rationale": None, "source": None, "ts": a.get("ts"),
                        "analyst": a.get("label")})
    return out


def _ref_path(ref: str) -> str | None:
    return labels_store.ref_parts(ref)[0]


def concept_stats(ws: Path, concept: dict) -> dict:
    """{n_labeled, n_reviewed, counts} from the stats stored on the concept while their key matches the labels file,
    else from the store. While a run appends, the stored (pre-run) stats stand."""
    stored = concept.get("label_stats")
    key = _file_key(labels_file(ws, concept["id"]))
    if key is None:
        return label_stats([])
    if _applying(ws.name, concept["id"]) or (stored is not None and tuple(stored["key"]) == key):
        if stored is None:
            return label_stats([])
        return {"n_labeled": stored["n_labeled"], "n_reviewed": stored["n_reviewed"], "counts": dict(stored["counts"])}
    return _stats(ws, concept["id"])


def coverage(ws: Path, concept: dict) -> dict:
    """{unit, files: [{path, covered, rows}], not_covered: [path, ...]}: every non-forge file of the corpus with the
    rows the label has on it, and the paths with none. A cell or span unit has no files. Blocking (worker thread)."""
    out: dict[str, Any] = {"unit": concept["unit"], "files": [], "not_covered": []}
    if concept["unit"] not in FILE_UNITS:
        return out
    try:
        corpus_dir = config.corpus_dir(ws.name)
    except ValueError:
        return out
    st, _building_now = _store(ws, concept["id"])
    rows = st.paths() if st is not None else {}
    for src in corpus.list_sources(corpus_dir):
        if src["kind"] == "forge":
            continue
        n = int(rows.get(src["path"], 0))
        out["files"].append({"path": src["path"], "covered": n > 0, "rows": n})
        if n == 0:
            out["not_covered"].append(src["path"])
    out["files"].sort(key=lambda f: f["path"])
    out["not_covered"].sort()
    return out


def with_stats(ws: Path, concept: dict) -> dict:
    """The concept card: the concept plus n_labeled, n_reviewed, counts, est_precision and the live run record."""
    cal = concept["calibration"]
    est = cal["agreed"] / cal["n"] if cal.get("n") else None
    return {**{k: v for k, v in concept.items() if k != "label_stats"}, **concept_stats(ws, concept), "est_precision": est,
            "run": _runs.get((ws.name, concept["id"]))}


# --------------------------------------------------------------------------- units (what gets labelled)


def match_paths(corpus_dir: Path, patterns: list[str]) -> list[dict]:
    """Non-forge sources whose corpus-relative path matches any pattern (fnmatch, `*` may span `/`), equals it, or
    lies under it when the pattern names a directory. Sorted by path."""
    pats = [str(p).strip().strip("/") for p in patterns if str(p).strip()]
    if not pats:
        return []
    out = []
    for src in corpus.list_sources(corpus_dir):
        if src["kind"] == "forge":
            continue
        rel = src["path"]
        if any(rel == p or fnmatch.fnmatchcase(rel, p) or rel.startswith(p + "/") for p in pats):
            out.append(src)
    out.sort(key=lambda s: s["path"])
    return out


PROMPT_APPLY_MAX = 50_000  # units a prompt apply over the whole corpus may cover without a limit
WHOLE_CORPUS = frozenset({"", ".", "*", "**", "**/*", "./*"})  # path patterns that narrow nothing


def narrowing(patterns: list[str]) -> bool:
    """Whether the apply's `paths` name some files rather than the whole corpus."""
    return any(str(p).strip().strip("/") not in WHOLE_CORPUS for p in patterns)


def units_at_least(corpus_dir: Path, sources: list[dict], unit: str, cap: int) -> tuple[int, int]:
    """(units counted, files read) over the matched sources, stopping once the count passes `cap`: records are lines
    (corpus.line_count, memoised per file), agents and runs are groups. Blocking (a thread)."""
    if unit != "record":
        return len(groups_for(sources, unit)), len(sources)
    n = 0
    for i, src in enumerate(sources, 1):
        try:
            n += corpus.line_count(config.safe_corpus_path(corpus_dir, src["path"]))
        except (OSError, ValueError):
            continue
        if n > cap:
            return n, i
    return n, len(sources)


def prompt_apply_too_wide(count: int, files_read: int, n_files: int, unit: str) -> str:
    """The one sentence a too-wide prompt apply answers with: the count and the two knobs."""
    what = {"record": "records", "agent": "files", "run": "runs"}.get(unit, unit + "s")
    seen = f"{count:,} in the first {files_read} of {n_files} files alone" if files_read < n_files else f"{count:,} in {n_files} files"
    return (f"This prompt label would run over more than {PROMPT_APPLY_MAX:,} {what} ({seen}); "
            f"pass limit to cap the run or paths to narrow it to some files.")


def _iter_records(corpus_dir: Path, src: dict) -> Iterator[tuple[int, Any, str]]:
    """(line, record, block text) for every record of a source, read in chunks."""
    rel, kind = src["path"], src["kind"]
    path = config.safe_corpus_path(corpus_dir, rel)
    total = len(corpus.line_offsets(path))
    for start in range(1, total + 1, CHUNK):
        for r in corpus.load_records(path, rel, kind, start, min(total, start + CHUNK - 1)):
            yield r["line"], r["record"], "\n\n".join(b["text"] for b in r["blocks"])


class Unit:
    """One thing to label. `texts()` yields (ref, text) parts lazily; `record` is what the code kind's label() gets."""

    __slots__ = ("ref", "paths", "record", "_texts")

    def __init__(self, ref: str, paths: list[str], texts: Callable[[], Iterator[tuple[str, str]]], record: Any = None):
        self.ref, self.paths, self.record, self._texts = ref, paths, record, texts

    def texts(self) -> Iterator[tuple[str, str]]:
        return self._texts()

    def text(self, cap: int) -> str:
        return self.text_cut(cap)[0]

    def text_cut(self, cap: int) -> tuple[str, bool]:
        """The unit's text up to `cap` characters, and whether it went on past them."""
        parts: list[str] = []
        n = 0
        for _ref, t in self.texts():
            if n + len(t) > cap:
                parts.append(t[: max(0, cap - n)] + "\n…[truncated]")
                return "\n\n".join(parts), True
            parts.append(t)
            n += len(t) + 2
        return "\n\n".join(parts), False

    def windows(self, size: int, overlap: int = WINDOW_OVERLAP) -> list[str]:
        """The unit's whole text in windows of at most `size` characters, each after the first starting `overlap`
        characters before the one before it ended, so words cut at a window's edge are read whole in the next. A cut
        falls after the last whitespace in a window's second half when it has one. One window when the text fits."""
        text = "\n\n".join(t for _ref, t in self.texts())
        if len(text) <= size:
            return [text]
        out: list[str] = []
        start = 0
        while True:
            end = start + size
            if end >= len(text):
                out.append(text[start:])
                return out
            gap = max(text.rfind(" ", start + size // 2, end), text.rfind("\n", start + size // 2, end))
            if gap > start:
                end = gap + 1
            out.append(text[start:end])
            start = max(start + 1, end - overlap)


def _one(ref: str, text: str, record: Any) -> Unit:
    return Unit(ref, [], lambda: iter([(ref, text)]), record)


def groups_for(sources: list[dict], unit: str) -> list[dict]:
    """[{ref, paths}] per file unit: one group per file for records and agents, one per run directory for runs."""
    if unit in ("record", "agent"):
        return [{"ref": s["path"], "paths": [s["path"]]} for s in sources]
    runs: dict[str, list[str]] = {}
    for s in sources:
        runs.setdefault(corpus.run_dir(s["path"]) or ".", []).append(s["path"])
    return [{"ref": run, "paths": paths} for run, paths in runs.items()]



def iter_units(corpus_dir: Path, sources: list[dict], unit: str) -> Iterator[Unit]:
    """The file units of the matched sources, in corpus order."""
    if unit == "record":
        for src in sources:
            for line, record, text in _iter_records(corpus_dir, src):
                ref = f"{src['path']}#L{line}"
                yield Unit(ref, [src["path"]], lambda ref=ref, text=text: iter([(ref, text)]), record)
        return
    by_path = {s["path"]: s for s in sources}
    for g in groups_for(sources, unit):
        srcs = [by_path[p] for p in g["paths"]]

        def texts(srcs=srcs) -> Iterator[tuple[str, str]]:
            for s in srcs:
                for line, _rec, text in _iter_records(corpus_dir, s):
                    yield f"{s['path']}#L{line}", text

        yield Unit(g["ref"], g["paths"], texts)


def resolve_within(ws: Path, within: Any) -> dict | None:
    """An apply's `within` {label: a name or id, value?} as stored ({label: its id, value}), the value its first when
    none is given; None for none. 400 for a label that is not over records or a value it does not have."""
    if not within:
        return None
    if not isinstance(within, dict) or not str(within.get("label") or "").strip():
        raise HTTPException(400, "within names a label over records: {label, value}")
    k = find_concept(ws, str(within["label"]).strip())
    if k is None:
        raise HTTPException(400, f"within: no label {within['label']!r}")
    if k["unit"] != "record":
        raise HTTPException(400, f"within: the label {k['name']!r} is not over records")
    value = str(within.get("value") or "").strip() or (k["labels"][0] if k["labels"] else "")
    if value not in k["labels"]:
        raise HTTPException(400, f"within: the label {k['name']!r} has no value {value!r}; its values are {', '.join(k['labels'])}")
    return {"label": k["id"], "value": value}


def _rev_of(ws: Path, concept_id: str) -> int | None:
    """The label's revision (note_change), which steps whenever its rows change; None when it is gone."""
    k = read_concept(ws, concept_id)
    return int(k.get("rev") or 0) if k else None


def within_lines(ws: Path, sources: list[dict], within: dict, most: int | None = None) -> dict[str, set[int]]:
    """{path: lines} of the records of the sources that the label `within` names gave its value, from `most` of its rows
    at most (all when None). Blocking (a thread)."""
    st = _store_ready(ws, within["label"])
    if st is None:
        return {}
    if most is None:
        most = st.rows(within["value"], 1)[1]
    rows, _total, _next = st.rows(within["value"], most)
    wanted = {src["path"] for src in sources}
    lines: dict[str, set[int]] = {}
    for r in rows:
        path, line = labels_store.ref_parts(str(r.get("ref") or ""))
        if path in wanted and line:
            lines.setdefault(path, set()).add(int(line))
    return lines


def within_too_wide(ws: Path, within: dict, count: int) -> str:
    """The sentence a prompt label within a narrowing too wide to read answers with."""
    parent = read_concept(ws, within["label"]) or {"name": within["label"]}
    return (f"The label {parent['name']!r} gave {within['value']!r} to {count:,} records of these files, more than a prompt "
            f"label reads ({PROMPT_APPLY_MAX:,}); narrow that label further, or pass limit to label a sample of them.")


def within_units(ws: Path, corpus_dir: Path, sources: list[dict], within: dict, most: int | None = None) -> list[Unit]:
    """The records of the sources that the label `within` names gave its value (within_lines), in corpus order.
    Blocking (a thread)."""
    lines = within_lines(ws, sources, within, most)
    out: list[Unit] = []
    for src in sources:
        out += line_units(corpus_dir, src["path"], src["kind"], lines.get(src["path"], ()))
    return out


def line_units(corpus_dir: Path, rel: str, kind: str, lines: Any) -> list[Unit]:
    """The record units on these lines of one file, in line order, read CHUNK lines at a time. Blocking."""
    want = sorted(set(lines))
    path = config.safe_corpus_path(corpus_dir, rel)
    out: list[Unit] = []
    i = 0
    while i < len(want):
        j = i
        while j + 1 < len(want) and want[j + 1] < want[i] + CHUNK:
            j += 1
        keep = set(want[i:j + 1])
        for r in corpus.load_records(path, rel, kind, want[i], want[j]):
            if r["line"] in keep:
                ref, text = f"{rel}#L{r['line']}", "\n\n".join(b["text"] for b in r["blocks"])
                out.append(Unit(ref, [rel], lambda ref=ref, text=text: iter([(ref, text)]), r["record"]))
        i = j + 1
    return out


SAVE_PLACE_KEYS = ("page_id", "page", "document", "doc_id", "slug")  # the document a record saves, else its file
SAVE_SEQ_KEYS = ("seq", "rev", "revision", "version")  # the field that numbers its saves
SAVE_REV_KEYS = ("rev", "revision")  # a sequence field that marks a save even with no document field
SAVE_TEXT_KEYS = ("text", "body", "content")  # the field that holds the document


def _save_key(record: Any) -> tuple[str, str] | None:
    """(the document, "" for the record's file, and the field that holds it) of a record that may save a whole document,
    one with a text field and either a document and a sequence field or a revision field; else None. A sequence
    alone, such as an event log's `seq` or a transcript's `version`, does not make a record a save."""
    if not isinstance(record, dict) or not any(k in record for k in SAVE_SEQ_KEYS):
        return None
    place = next((str(record[k]) for k in SAVE_PLACE_KEYS if isinstance(record.get(k), (str, int)) and str(record[k])), "")
    if not place and not any(k in record for k in SAVE_REV_KEYS):
        return None
    field = next((k for k in SAVE_TEXT_KEYS if isinstance(record.get(k), str)), None)
    return (place, field) if field else None


def _befores(path: Path, wanted: set[int]) -> dict[int, str]:
    """{line: the document the save before it held} for the saves of a JSON Lines file on the `wanted` lines. Blocking."""
    last: dict[str, Any] = {}
    out: dict[int, str] = {}
    total = len(corpus.line_offsets(path))
    for start in range(1, min(total, max(wanted, default=0)) + 1, CHUNK):
        for n, raw in enumerate(corpus.read_lines(path, start, min(total, start + CHUNK - 1)), start):
            try:
                rec = json.loads(corpus.decode_line(raw))
            except ValueError:
                continue
            key = _save_key(rec)
            if key:
                if n in wanted and isinstance(last.get(key[0]), str):
                    out[n] = last[key[0]]
                last[key[0]] = rec[key[1]]
    return out


def change_lines(old: Any, new: str) -> list[str] | None:
    """The lines `new` added (`+ line`) and removed (`- line`) from `old`, the document the save before it held; None when
    there is none before it or it keeps under half of the lines before, so the save is read whole."""
    if not isinstance(old, str):
        return None
    a, b = [s for s in old.splitlines() if s.strip()], [s for s in new.splitlines() if s.strip()]
    was, now = set(a), set(b)
    if 2 * sum(s in now for s in a) < len(a):
        return None
    return [f"+ {s}" for s in b if s not in was] + [f"- {s}" for s in a if s not in now]


def _changed(u: Unit, key: tuple[str, str], old: Any, header: bool = True) -> Unit:
    """The unit of a save as the lines it changed from `old` (change_lines), under a line naming the document when
    `header`; the unit itself when the save reads whole."""
    diff = change_lines(old, u.record[key[1]])
    if diff is None:
        return u
    text = ("\n".join(diff) if not header
            else f"What this save changed on {key[0] or labels_store.ref_parts(u.ref)[0]}:\n" + ("\n".join(diff) or "nothing"))
    return Unit(u.ref, u.paths, lambda ref=u.ref, text=text: iter([(ref, text)]), u.record)


def as_changes(units: Iterator[Unit], header: bool = True) -> Iterator[Unit]:
    """Every record of some files in order (iter_units), a record that saves a document again (_save_key) reading as what
    it changed from the save before it, so a model or a regex judges what the save did rather than the whole document."""
    last: dict[tuple[str, str], Any] = {}
    for u in units:
        key = _save_key(u.record)
        if key is None:
            yield u
            continue
        doc = (labels_store.ref_parts(u.ref)[0] or "", key[0])
        old, last[doc] = last.get(doc), u.record[key[1]]
        yield _changed(u, key, old, header)


def picked_as_changes(corpus_dir: Path, units: list[Unit], header: bool = True) -> list[Unit]:
    """as_changes over the records a trial or `within` picked, each file that holds a save among them read once for the
    saves before them. Blocking."""
    wanted: dict[str, set[int]] = {}
    for u in units:
        rel, line = labels_store.ref_parts(u.ref)
        if rel and line and rel.endswith(".jsonl") and _save_key(u.record):
            wanted.setdefault(rel, set()).add(line)
    befores = {rel: _befores(config.safe_corpus_path(corpus_dir, rel), lines) for rel, lines in wanted.items()}
    out = []
    for u in units:
        rel, line = labels_store.ref_parts(u.ref)
        key = _save_key(u.record)
        out.append(_changed(u, key, befores.get(rel or "", {}).get(line or 0), header) if key else u)
    return out


EXAMPLES_SHOWN = 20  # records an apply's result quotes of the value it asks about (examples)
EXAMPLES_READ = 200  # records read to choose them from
EXAMPLE_CHARS = 200


def examples(c: str, concept_id: str, value: str, n: int = EXAMPLES_SHOWN) -> list[tuple[str, str]]:
    """Up to `n` records of a label over records that took `value`: those that matched the most different texts of a
    regex first, else spread over them, and one per document a save holds. Each is quoted by the line of what the label
    read (a save as what it changed) that holds the most of its matches, else by its first line. Blocking."""
    ws, corpus_dir = _ws(c), config.corpus_dir(c)
    st = _store_ready(ws, concept_id)
    rows, _total, _next = st.rows(value, PROMPT_APPLY_MAX) if st is not None else ([], 0, None)
    matched = {str(r.get("ref") or ""): {x.casefold() for x in r.get("spans") or [] if x} for r in rows}
    order = [rows[i] for i in spread(len(rows), len(rows))]
    order.sort(key=lambda r: -len(matched[str(r.get("ref") or "")]))
    lines: dict[str, list[int]] = {}
    for r in order[:EXAMPLES_READ]:
        rel, line = labels_store.ref_parts(str(r.get("ref") or ""))
        if rel and line:
            lines.setdefault(rel, []).append(line)
    rank = {str(r.get("ref") or ""): i for i, r in enumerate(order[:EXAMPLES_READ])}
    units = sorted((u for rel, ns in lines.items() for u in line_units(corpus_dir, rel, corpus.source_kind(rel), ns)),
                   key=lambda u: rank[u.ref])
    out: list[tuple[str, str]] = []
    docs: set = set()
    for u in picked_as_changes(corpus_dir, units, header=False):
        key = _save_key(u.record)
        doc = (labels_store.ref_parts(u.ref)[0], key[0]) if key else u.ref
        if doc in docs:
            continue
        docs.add(doc)
        hits = matched.get(u.ref) or set()
        lines = [x.strip() for x in u.text(UNIT_TEXT_MAX).splitlines() if x.strip()] or [""]
        at = max(lines, key=lambda x: sum(h in x.casefold() for h in hits))
        first = min((i for h in hits if (i := at.casefold().find(h)) >= 0), default=0)
        start = max(0, first - EXAMPLE_CHARS // 3)
        out.append((u.ref, ("…" if start else "") + at[start: start + EXAMPLE_CHARS] + ("…" if start + EXAMPLE_CHARS < len(at) else "")))
        if len(out) >= n:
            break
    return out


REASONS_SHOWN = 3  # reasons an apply's result quotes of each value (reasons)
REASONS_READ = 400  # rows of a value read to choose them from
_REASON_WORD = re.compile(r"[a-z]{3,}")


def reasons(c: str, concept_id: str, values: list[str], n: int = REASONS_SHOWN) -> dict[str, list[tuple[str, str]]]:
    """Per value, up to `n` of the records that took it so far with the reason the model gave, each chosen as the one
    whose words differ most from those chosen before (the longest first). Blocking."""
    st = _store_ready(_ws(c), concept_id)
    out: dict[str, list[tuple[str, str]]] = {}
    for v in values:
        rows, _total, _next = st.rows(v, REASONS_READ) if st is not None else ([], 0, None)
        cand = {str(r["ref"]): str(r.get("rationale") or "").strip() for r in rows if str(r.get("rationale") or "").strip()}
        words = {ref: set(_REASON_WORD.findall(why.lower())) for ref, why in cand.items()}

        def unlike(ref: str, chosen: list[str]) -> float:
            if not chosen:
                return float(len(words[ref]))
            return min(1 - len(words[ref] & words[x]) / max(1, len(words[ref] | words[x])) for x in chosen)

        chosen: list[str] = []
        while len(chosen) < min(n, len(cand)):
            chosen.append(max((r for r in cand if r not in chosen), key=lambda r: unlike(r, chosen)))
        if chosen:
            out[v] = [(r, cand[r]) for r in chosen]
    return out


SAVES_SNIFF = 20  # records read from the head of a JSON Lines file to tell whether it holds saves


def holds_saves(corpus_dir: Path, sources: list[dict]) -> bool:
    """Whether a JSON Lines file among the sources opens with a record that saves a document (_save_key). Blocking."""
    for src in sources:
        if not src["path"].endswith(".jsonl"):
            continue
        for raw in corpus.read_lines(config.safe_corpus_path(corpus_dir, src["path"]), 1, SAVES_SNIFF):
            try:
                if _save_key(json.loads(corpus.decode_line(raw))):
                    return True
            except ValueError:
                continue
    return False


TRIAL_SKIP_LINES = 8  # a trial's pick that lands on a blank line takes the next record with words within this many lines


INTERLEAVE_FIRST = 200  # units a pass of interleaved takes, spread over them all


def interleaved(n: int) -> list[int]:
    """range(n) in passes of about INTERLEAVE_FIRST indices each, every pass spread over the whole range."""
    stride = max(1, n // INTERLEAVE_FIRST)
    return sorted(range(n), key=lambda i: (i % stride, i))


def spread(n: int, k: int) -> list[int]:
    """`k` indices out of range(n), evenly spaced from the start to the end (each at the middle of its share); every
    index when k >= n."""
    if k >= n:
        return list(range(n))
    return [int((i + 0.5) * n / k) for i in range(k)]


def trial_quotas(sizes: list[int], limit: int) -> list[int]:
    """How many units of a trial of `limit` each file gives, for files of `sizes` units: one each from files spread over
    the list when the limit is below the number of files, else one from every file and the rest by each file's share
    of the units (largest remainder), never more than a file has."""
    n = len(sizes)
    quotas = [0] * n
    live = [i for i, s in enumerate(sizes) if s > 0]
    if not live or limit <= 0:
        return quotas
    limit = min(limit, sum(sizes[i] for i in live))
    if limit < len(live):
        for j in spread(len(live), limit):
            quotas[live[j]] = 1
        return quotas
    for i in live:
        quotas[i] = 1
    left = limit - len(live)
    while left > 0:
        room = [i for i in live if quotas[i] < sizes[i]]
        total = sum(sizes[i] - quotas[i] for i in room)
        shares = {i: left * (sizes[i] - quotas[i]) / total for i in room}
        given = 0
        for i in room:
            add = min(int(shares[i]), sizes[i] - quotas[i])
            quotas[i] += add
            given += add
        rest = left - given
        for i in sorted(room, key=lambda i: shares[i] - int(shares[i]), reverse=True):
            if rest <= 0:
                break
            if quotas[i] < sizes[i]:
                quotas[i] += 1
                rest -= 1
        left = limit - sum(quotas)
    return quotas


def trial_sample(corpus_dir: Path, sources: list[dict], limit: int, lines: dict[str, int]) -> list[Unit]:
    """A trial's records over the matched files: the limit spread over the files (trial_quotas, by line count) and each file's
    share spread over its lines. A pick on a line without words takes the next record with words within TRIAL_SKIP_LINES.
    Blocking (a thread)."""
    quotas = trial_quotas([int(lines.get(s["path"]) or 0) for s in sources], limit)
    out: list[Unit] = []
    for src, k in zip(sources, quotas):
        if k <= 0:
            continue
        n = int(lines.get(src["path"]) or 0)
        path = config.safe_corpus_path(corpus_dir, src["path"])
        taken: set[int] = set()
        for i in spread(n, k):
            line = i + 1
            for r in corpus.load_records(path, src["path"], src["kind"], line, min(n, line + TRIAL_SKIP_LINES)):
                text = "\n\n".join(b["text"] for b in r["blocks"])
                if r["line"] in taken or not text.strip():
                    continue
                taken.add(r["line"])
                ref = f"{src['path']}#L{r['line']}"
                out.append(Unit(ref, [src["path"]], lambda ref=ref, text=text: iter([(ref, text)]), r["record"]))
                break
    return out


def trial_groups(sources: list[dict], unit: str, limit: int) -> tuple[list[dict], int]:
    """(the sources of a trial's files or runs, the number of files or runs in scope): `limit` of them spread over the
    matched ones in corpus order, so a trial of an agent or run label runs as a full run does, over fewer of them."""
    groups = groups_for(sources, unit)
    by_path = {s["path"]: s for s in sources}
    picked = [groups[i] for i in spread(len(groups), limit)]
    return [by_path[p] for g in picked for p in g["paths"]], len(groups)


def cell_text(cell: dict) -> str:
    """What a card says, as text: its question, code, takeaway, note text and output text."""
    from . import notebook

    payload = cell.get("payload") if isinstance(cell.get("payload"), dict) else {}
    parts = [str(cell.get("title") or ""), str(cell.get("code") or ""), str(cell.get("takeaway") or ""),
             str(payload.get("text") or cell.get("text") or ""), notebook.outputs_text(cell.get("outputs") or [])]
    return "\n\n".join(p for p in parts if p.strip())


def cell_units(ws: Path) -> list[Unit]:
    """One unit per card on the canvas (notebook.canvas; label cards aside), ref `card:<id>`, in group then card order. The
    code kind's label(unit) gets the card's fields: `kind`, `question` (also `title`), `takeaway`, `code`, `payload`,
    `group`, `groups` (every enclosing frame's title, outermost first) and its words as `text`."""
    from . import notebook

    board = notebook.canvas(ws)
    rows = {g["id"]: g for g in board["groups"]}

    def frames(gid: str | None) -> list[str]:
        titles: list[str] = []
        seen: set[str] = set()
        while gid and gid in rows and gid not in seen:
            seen.add(gid)
            titles.append(str(rows[gid].get("title") or ""))
            gid = rows[gid].get("parent")
        return titles[::-1]

    out: list[Unit] = []
    for cell in board["cells"]:
        if not isinstance(cell, dict) or not cell.get("id") or cell.get("kind") == "label":
            continue
        record = {k: cell.get(k) for k in ("id", "notebook", "title", "code", "takeaway", "payload")}
        # a markdown card (kind `md`) shows as a note (frontend canvas/layout.kindOf)
        record["kind"] = "note" if cell.get("kind") == "md" else cell.get("kind") or "code"
        record["question"] = record["title"]
        record["groups"] = frames(cell.get("notebook"))
        record["group"] = record["groups"][-1] if record["groups"] else ""
        record["text"] = cell_text(cell)
        out.append(_one(f"card:{cell['id']}", record["text"], record))
    return out


def span_units(c: str, slug: str = REPORT_SLUG) -> list[Unit]:
    """One unit per sentence of the document `slug`, ref `report:<slug>#<sid>`, in document order; none without a document."""
    from . import investigation, report_types

    doc = report_types.read_doc(c, investigation.MAIN, slug)
    if not isinstance(doc, dict):
        return []
    out: list[Unit] = []
    for x in report_types.all_sentences(doc):
        sid = str(x.get("id") or "")
        text = str(x.get("text") or "")
        if sid:
            out.append(_one(f"report:{slug}#{sid}", text, {"id": sid, "text": text, "refs": list(x.get("refs") or [])}))
    return out


def scope_units(c: str, unit: str) -> list[Unit]:
    """The cell or span units of a workspace (the file units come from iter_units)."""
    if unit == "cell":
        return cell_units(_ws(c))
    if unit == "span":
        return span_units(c)
    raise ValueError(f"not a scope unit: {unit}")


# --------------------------------------------------------------------------- progress (SSE)

_runs: dict[tuple[str, str], dict] = {}  # (workspace, concept id) -> the run record
_subs: dict[tuple[str, str], set[asyncio.Queue]] = {}
_locks: dict[tuple[str, str], asyncio.Lock] = {}
_cancels: dict[tuple[str, str], threading.Event] = {}
_tasks: dict[tuple[str, str], asyncio.Task] = {}
_pool: ProcessPoolExecutor | None = None
_pool_workers = 1

RUN_FIELDS: dict[str, Any] = {
    "run_id": None, "status": "running", "started": None, "created_by": None, "paths": None,
    "total": None, "matched_total": None, "done": 0, "labeled": 0, "failed": 0, "matches": 0,
    "files_total": None, "files_done": 0, "files_indexed": 0, "file": None, "bytes_total": None, "bytes_done": 0,
    "eta_s": None, "message": None, "phase": None, "examples": 0,
}


def _cancel_event(c: str, concept_id: str) -> threading.Event:
    return _cancels.setdefault((c, concept_id), threading.Event())


def _pool_get() -> ProcessPoolExecutor:
    """The scan pool: spawned interpreters, apply_workers() of them, kept for the process's life."""
    global _pool, _pool_workers
    if _pool is None:
        _pool_workers = apply_workers()
        _pool = ProcessPoolExecutor(max_workers=_pool_workers, mp_context=multiprocessing.get_context("spawn"))
    return _pool


def _pool_shutdown() -> None:
    global _pool
    pool, _pool = _pool, None
    if pool is not None:
        pool.shutdown(wait=False, cancel_futures=True)


def _pool_reset(broken: ProcessPoolExecutor) -> ProcessPoolExecutor:
    """A fresh pool after `broken` raised BrokenProcessPool; a second run finding the fresh one keeps it."""
    if _pool is broken:
        log.warning("scan pool: a worker stopped; the pool is rebuilt and the chunks in flight re-submitted")
        _pool_shutdown()
    return _pool_get()


def _subscribe(c: str, concept_id: str) -> asyncio.Queue:
    q: asyncio.Queue = asyncio.Queue()
    _subs.setdefault((c, concept_id), set()).add(q)
    return q


def _unsubscribe(c: str, concept_id: str, q: asyncio.Queue) -> None:
    _subs.get((c, concept_id), set()).discard(q)


def _progress(c: str, concept_id: str, **fields: Any) -> dict:
    """Update the concept's run record and stream it (`done` once the status is done or error, `progress` before)."""
    key = (c, concept_id)
    state = {**_runs.get(key, {"concept": concept_id, **RUN_FIELDS}), **fields, "ts": _now()}
    _runs[key] = state
    event = "done" if state["status"] in ("done", "error") else "progress"
    for q in _subs.get(key, ()):
        q.put_nowait((event, json.dumps(state)))
    return state


# --------------------------------------------------------------------------- classifiers


def _require_model_access() -> None:
    """502 up front when a prompt apply could reach no model: no `claude`, or it is not logged in (config.auth_problem)."""
    problem = config.auth_problem()
    if problem:
        raise HTTPException(502, f"prompt labels cannot run: {problem}")



def _coerce_label(value: Any, labels: list[str]) -> str:
    s = " ".join(str(value if value is not None else "").split())
    for l in labels:
        if l.casefold() == s.casefold():
            return l
    return s[:40]


def _coerce_confidence(value: Any) -> float:
    try:
        f = float(value)
    except (TypeError, ValueError):
        return 0.5
    if f > 1.0 and f <= 100.0:
        f /= 100.0
    return max(0.0, min(1.0, f))


def definition_text(concept: dict) -> str:
    return concept["spec"].strip() if concept["kind"] == "prompt" and concept["spec"].strip() else concept["description"].strip()


UNIT_WORDS = {"record": "record from a file", "agent": "whole file", "run": "whole run directory",
              "cell": "card from the canvas", "span": "sentence from the report"}
def labels_part(heading: str, **values: str) -> str:
    """A `## ` section of prompts/labels.md, which fills one of the file's own slots (the rationale asked for, the
    examples and their lead line), so every sentence the classifier reads is in that one file."""
    from . import prompts  # noqa: PLC0415

    return prompts.render_section("labels", heading, values).strip()


def render_examples(examples: list[dict]) -> str:
    """The `{{examples}}` slot: '' without examples, else a lead line and one block per example (ref, text, the
    analyst's value and their note when they left one), each from labels.md's sections."""
    if not examples:
        return ""
    blocks = [labels_part("examples")]
    for n, ex in enumerate(examples, 1):
        text = str(ex.get("text") or "").strip()
        if len(text) > EXAMPLE_TEXT_MAX:
            text = text[:EXAMPLE_TEXT_MAX] + "…"
        block = labels_part("example", n=str(n), ref=str(ex.get("ref", "")), text=text, value=str(ex.get("value", "")))
        if str(ex.get("note") or "").strip():
            block += "\n" + labels_part("example-note", note=str(ex["note"]).strip())
        blocks.append(block)
    return "\n\n".join(blocks)


def few_shot_examples(ws: Path, concept: dict, corpus_dir: Path | None = None, limit: int = EXAMPLES_MAX) -> list[dict]:
    """The analyst's latest verdicts on the concept as few-shot examples: [{ref, text, value, note}], at most `limit`,
    each unit's text from unit_texts (a verdict whose ref no longer resolves is left out). Blocking (worker thread)."""
    st = _store_ready(ws, concept["id"], wait=False)
    if st is None:
        return []
    verdicts = st.verdicts(limit * 2)
    texts = unit_texts(ws.name, concept, [str(v["ref"]) for v in verdicts])
    out: list[dict] = []
    for v in verdicts:
        text = texts.get(str(v["ref"]), "")
        if not text.strip():
            continue
        out.append({"ref": str(v["ref"]), "text": text, "value": str(v["analyst"]), "note": v.get("analyst_note") or ""})
        if len(out) >= limit:
            break
    return out


def build_classify_prompt(concept: dict, items: list[tuple[str, str]], comment: bool = True) -> tuple[str, str]:
    """(system, user) for one batch of (ref, text) items; `comment` asks for the one-line rationale; the concept's
    `examples` (few_shot_examples, attached by run_apply for the run) fill the prompt's examples slot."""
    from . import prompts

    system = prompts.render_head("labels", {
        "name": str(concept["name"]), "unit": UNIT_WORDS.get(concept["unit"], concept["unit"]),
        "definition": definition_text(concept) or labels_part("no-definition"),
        "labels": ", ".join(concept["labels"]), "comment": labels_part("comment") if comment else "",
        "examples": render_examples(concept.get("examples") or [])})
    user = [f"### item {n} [{ref}]\n{text}" for n, (ref, text) in enumerate(items, 1)]
    return system.strip(), "\n\n".join(user)


def labels_tool(concept: dict, comment: bool = True) -> Any:
    """The classifier's output schema as a model.ToolSpec: one {i, label, confidence, rationale?, quote?} entry per
    item. `label` is a free string (an off-list value is kept as data) and `confidence` also accepts a string; `quote`
    is asked for when the label marks spans."""
    from . import model

    props: dict[str, Any] = {
        "i": {"type": "integer", "description": "The item number, exactly as given."},
        "label": {"type": "string", "description": f"One of the allowed values: {', '.join(concept['labels'])}."},
        "confidence": {"type": ["number", "string"], "description": "0..1: how sure you are the value is right."},
    }
    if comment:
        props["rationale"] = {"type": "string", "description": "One short sentence: why this value."}
    if concept.get("marks") == "span":
        props["quote"] = {"type": "string", "description": "The words of the item that carry the value, copied exactly; empty when no words do."}
    return model.ToolSpec(
        name="labels",
        description="Return one entry per numbered item: its value against the category's definition.",
        input_schema={
            "type": "object",
            "properties": {"labels": {"type": "array", "items": {"type": "object", "properties": props, "required": ["i", "label"],
                                                                  "additionalProperties": False}}},
            "required": ["labels"],
            "additionalProperties": False,
        },
    )


async def classify_structured(c: str, concept: dict, items: list[tuple[str, str]], comment: bool = True,
                              on_retry: Callable[[int, float, str, BaseException | None], Any] | None = None) -> Any:
    """One classifier batch through model.structured (never raises; read the CallResult's status), on the concept's
    `model` when it names one, else the labels role's. `on_retry` hears each retry model.structured waits for."""
    from . import model

    system, user = build_classify_prompt(concept, items, comment)
    model_name, effort = labels_model(c)
    if concept.get("model"):
        model_name = concept["model"]
    with capture.scope("concepts labels", keep=True):
        return await model.structured(
            user,
            tool=labels_tool(concept, comment),
            model=model_name,
            effort=effort,
            system_append=system,
            cwd=config.corpus_dir(c),
            on_retry=on_retry,
        )


def parse_labels(output: dict | None, concept: dict, n_items: int, comment: bool = True) -> dict[int, dict]:
    """{item index -> {label, confidence, rationale, quote?}} from a CallResult.output of the `labels` tool (`quote`
    when the label marks spans); entries with a bad or repeated index are dropped, a missing index takes the items in
    order."""
    out: dict[int, dict] = {}
    objs = (output or {}).get("labels")
    for obj in objs if isinstance(objs, list) else []:
        if not isinstance(obj, dict):
            continue
        try:
            i = int(obj.get("i"))
        except (TypeError, ValueError):
            i = len(out) + 1
        if not 1 <= i <= n_items or i in out:
            continue
        out[i] = {"label": _coerce_label(obj.get("label"), concept["labels"]), "confidence": _coerce_confidence(obj.get("confidence")),
                  "rationale": str(obj.get("rationale") or "")[:RATIONALE_MAX] if comment else ""}
        if concept.get("marks") == "span":
            out[i]["quote"] = str(obj.get("quote") or "")[:QUOTE_MAX]
    return out


def quoted_span(text: str, quote: str) -> list[str] | None:
    """The quote as the text spells it, as a row's `spans`: found as given, else ignoring case, else ignoring runs of
    whitespace; None when the text does not hold it (a paraphrase marks nothing)."""
    q = (quote or "").strip()
    if not q or not text:
        return None
    if q in text:
        return [q]
    i = text.lower().find(q.lower())
    if i >= 0:
        return [text[i:i + len(q)]]
    words = q.split()
    if len(words) > 1:
        m = re.search(r"\s+".join(re.escape(w) for w in words), text, re.IGNORECASE)
        if m:
            return [m.group(0)]
    return None


class _Item(NamedTuple):
    """One text a classifier call carries: a unit's whole text, or window `part` of the `parts` it is read in; `cut`
    when the unit's text went on past what was read."""
    unit: Unit
    text: str
    part: int = 0
    parts: int = 1
    cut: bool = False


def _items(u: Unit, unit: str) -> list[_Item]:
    """A unit's classifier items: a record or a sentence whole, in windows of WINDOW_TEXT_MAX when it is longer; any
    other unit its first UNIT_TEXT_MAX characters."""
    if unit in ("record", "span"):
        parts = u.windows(WINDOW_TEXT_MAX)
        return [_Item(u, t, i, len(parts)) for i, t in enumerate(parts)]
    t, cut = u.text_cut(UNIT_TEXT_MAX)
    return [_Item(u, t, cut=cut)]


def _batches(units: Iterator[Unit], unit: str, per_call: int) -> Iterator[list[_Item]]:
    """The units' items (_items) in the batches the classifier calls carry: `per_call` items at most, fewer when their
    texts add up to more than BATCH_CHARS. A unit's windows follow one another."""
    batch: list[_Item] = []
    chars = 0
    for u in units:
        for it in _items(u, unit):
            if batch and (len(batch) >= per_call or chars + len(it.text) > BATCH_CHARS):
                yield batch
                batch, chars = [], 0
            batch.append(it)
            chars += len(it.text)
    if batch:
        yield batch


def _answer_rank(labels: list[str], answer: dict) -> tuple[bool, int, float]:
    """How much an answer says, lowest first: a value that is not quiet before a quiet one, then the label's own order
    of its values (an off-list value after them), then the higher confidence."""
    value = answer["label"]
    return (value.casefold() in QUIET_VALUES, labels.index(value) if value in labels else len(labels), -answer["confidence"])


def merge_windows(labels: list[str], answers: list[dict | None]) -> dict | None:
    """The answer for a unit read in windows, from each window's answer (None for a window with none): the window whose value
    says the most (_answer_rank), so a unit matches when any window does. None when a missing answer could have outranked
    the others'."""
    got = [a for a in answers if a is not None]
    if not got:
        return None
    best = min(got, key=lambda a: _answer_rank(labels, a))
    top = min((_answer_rank(labels, {"label": v, "confidence": 1.0})[:2] for v in labels), default=(False, 0))
    if len(got) < len(answers) and _answer_rank(labels, best)[:2] > top:
        return None
    if best["label"].casefold() in QUIET_VALUES:
        return {**best, "confidence": min(a["confidence"] for a in got if a["label"] == best["label"])}
    return best


def _row(ref: str, label: str, confidence: float, source: str, rationale: str | None = None, spans: list[str] | None = None) -> dict:
    return concept_scan.row(ref, label, confidence, source, rationale, spans)



async def _backoff(delay: float, cancel: threading.Event) -> None:
    """Wait `delay` seconds before a retry, returning early once the analyst cancels."""
    loop = asyncio.get_running_loop()
    end = loop.time() + delay
    while not cancel.is_set():
        left = end - loop.time()
        if left <= 0:
            return
        await asyncio.sleep(min(left, BACKOFF_POLL))


MESSAGES_KEPT = 3  # distinct problem messages carried on a run's summary
FALLBACK_MESSAGE = "Downgrading {model} to {fallback}"


def _fallback_message(n: int, refused: str, fallback: str) -> str:
    """The run's line for `n` classifier calls that ran again on the fallback model after `refused` refused them
    (model.CallResult.refused_by)."""
    from .session import model_label  # noqa: PLC0415

    return FALLBACK_MESSAGE.format(model=model_label(refused), n=f"{n:,}", s="" if n == 1 else "s",
                                   fallback=model_label(fallback), them="it" if n == 1 else "them")


def _cancelled_message(n: int, unit: str) -> str:
    return f"cancelled by the analyst after {n:,} {unit}{'' if n == 1 else 's'}; the rows written so far are kept"


async def _apply_prompt(c: str, concept: dict, units: Iterator[Unit], out: Path, cancel: threading.Event,
                        files: list[str] | None = None, comment: bool = True) -> tuple[int, int, str | None]:
    """The classifier calls of a prompt label, BATCH_ITEMS units per call and up to CONCURRENCY calls running: a 429 or
    529 halves the calls let run, and each round of answered calls lets one more run again. Rows are committed in the
    units' order. `cancel` stops new calls; a rate-limited call is retried with backoff; calls that ran on the fallback
    model are counted in the run's message."""
    await asyncio.to_thread(_require_model_access)
    unit = concept["unit"]
    per_call, in_flight = BATCH_ITEMS, CONCURRENCY
    allowed = float(in_flight)  # the calls let run now
    slowdowns = 0  # a call started before the last slowdown does not slow the run again
    labeled = failed = matches = cut = 0
    labels = concept["labels"]
    pos_label = labels[0]
    spans = concept.get("marks") == "span"
    order = {p: i for i, p in enumerate(files or [])}
    key = (c, concept["id"])
    done = int(_runs[key].get("done") or 0)
    t0 = time.monotonic()
    last_emit = 0.0
    messages: list[str] = []
    fell_back: dict[tuple[str, str], int] = {}  # (refused model, fallback model) -> calls

    def note(msg: str | None) -> None:
        if msg and msg not in messages and len(messages) < MESSAGES_KEPT:
            messages.append(msg)

    def message() -> str | None:
        lines = [_fallback_message(n, *pair) for pair, n in fell_back.items()] + messages
        return "; ".join(lines) or None

    def slow(since: int) -> None:
        nonlocal allowed, slowdowns
        if since == slowdowns:
            allowed, slowdowns = max(1.0, allowed / 2), slowdowns + 1
            log.info("classifier calls: the API pushed back; %d in flight at most for now", int(allowed))

    def grow() -> None:
        nonlocal allowed
        allowed = min(float(in_flight), allowed + 1 / allowed)

    async def ask(items: list[tuple[str, str]]) -> tuple[dict[int, dict], str | None]:
        """The classifier's answers by item number (parse_labels) and, when the call failed, why."""
        for attempt in range(len(RETRY_DELAYS) + 1):
            since = slowdowns
            call = await classify_structured(
                c, concept, items, comment,
                on_retry=lambda _n, _wait, cls, _e, since=since: slow(since) if cls in ("rate_limited", "overloaded") else None)
            if call.refused_by:
                pair = (call.refused_by, call.model_requested)
                fell_back[pair] = fell_back.get(pair, 0) + 1
            if call.status == "ok":
                grow()
                break
            if call.status == "rate_limited":
                slow(since)
            failure = f"{call.status}: {call.detail}" if call.detail else call.status
            if attempt >= len(RETRY_DELAYS) or call.status != "rate_limited" or cancel.is_set():
                return {}, failure
            delay = RETRY_DELAYS[attempt] * (1 + random.random() * RETRY_JITTER)
            log.warning("classifier call: %s; retry %d/%d in %.1f s", call.status, attempt + 1, len(RETRY_DELAYS), delay)
            await _backoff(delay, cancel)
            if cancel.is_set():
                return {}, failure
        return parse_labels(call.output, concept, len(items), comment), None

    async def one(batch: list[_Item]) -> tuple[list[dict | None], str | None]:
        """Each item's answer ({label, confidence, rationale, spans}; None where it got none) and the problem, if any. The
        items a call failed or left out are asked once more."""
        answers: list[dict | None] = [None] * len(batch)
        live = [n for n, it in enumerate(batch) if (it.text or "").strip()]
        cause = None
        if len(live) < len(batch):
            blank = next(it.unit.ref for it in batch if not (it.text or "").strip())
            cause = f"{len(batch) - len(live)} unit(s) have no readable text (e.g. {blank}), so they were not labeled"
            if not live:
                return answers, cause
        items = [(batch[n].unit.ref, batch[n].text) for n in live]
        res, failure = await ask(items)
        missing = [i for i in range(1, len(items) + 1) if i not in res]
        if missing and not cancel.is_set():
            again, failure = await ask([items[i - 1] for i in missing])
            res.update({missing[j - 1]: r for j, r in again.items()})
        for i, n in enumerate(live, 1):
            if (r := res.get(i)) is not None:
                answers[n] = {**r, "spans": quoted_span(batch[n].text, r.get("quote", "")) if spans else None}
        msg = failure or (None if res else "classifier returned no usable labels")
        if cause:
            msg = cause if msg is None else f"{cause}; {msg}"
        return answers, msg

    batches = _batches(units, unit, per_call)
    windows: list[dict | None] = []  # the answers so far of the unit whose windows are being read

    def settle(b: list[_Item], answers: list[dict | None]) -> tuple[list[dict], int]:
        """The rows of the units whose last item is in `b`, and how many of those units failed."""
        nonlocal cut
        rows: list[dict] = []
        n_failed = 0
        for it, a in zip(b, answers):
            if it.part == 0:
                windows.clear()
            windows.append(a)
            if it.part < it.parts - 1:
                continue
            r = merge_windows(labels, windows) if it.parts > 1 else a
            cut += it.cut
            if r is None:
                n_failed += 1
            else:
                rows.append(_row(it.unit.ref, r["label"], r["confidence"], "model", r["rationale"] or None, r.get("spans")))
        return rows, n_failed

    def take(n: int) -> list[list[_Item]]:
        got: list[list[_Item]] = []
        for b in batches:
            got.append(b)
            if len(got) >= n:
                break
        return got

    def emit(b: list[_Item], force: bool = False) -> None:
        nonlocal last_emit
        if not (force or time.monotonic() - last_emit >= PROGRESS_EVERY_S):
            return
        last_emit = time.monotonic()
        current = b[-1].unit.paths[0] if b and b[-1].unit.paths else None
        _progress(c, concept["id"], done=done, labeled=labeled, failed=failed, matches=matches, file=current,
                  files_done=order.get(current, 0), eta_s=_eta(t0, done, _runs[key].get("total")),
                  message=message())

    writer = _LabelsWriter(out).start()
    pending: deque[tuple[asyncio.Task, list[_Item]]] = deque()  # started calls, in the units' order
    ready: deque[list[_Item]] = deque()  # batches read and not started
    exhausted = False
    try:
        while True:
            running = sum(1 for task, _b in pending if not task.done())
            while not cancel.is_set() and running < int(allowed) and len(pending) < 4 * in_flight:
                if not ready and not exhausted:
                    got = await asyncio.to_thread(take, in_flight)
                    exhausted = not got
                    ready.extend(got)
                if not ready:
                    break
                b = ready.popleft()
                pending.append((asyncio.create_task(one(b)), b))
                running += 1
            if not pending:
                break
            head, b = pending[0]
            if not head.done():
                await asyncio.wait([task for task, _b in pending if not task.done()], return_when=asyncio.FIRST_COMPLETED)
                continue
            pending.popleft()
            answers, msg = head.result()
            rows, n_failed = settle(b, answers)
            if rows:
                await asyncio.to_thread(writer.put, concept_scan.jsonl_bytes(rows), rows)
            labeled += len(rows)
            failed += n_failed
            matches += sum(1 for r in rows if r["label"] == pos_label)
            done += len(rows) + n_failed
            note(msg)
            emit(b, force=not pending)
        if cut:
            noun = {"agent": "file", "run": "run", "cell": "card"}.get(unit, unit)
            note(f"{cut:,} {noun}{'' if cut == 1 else 's'} ran past {UNIT_TEXT_MAX:,} characters; the classifier read that much of each")
        if cancel.is_set() and (ready or not exhausted):
            note(_cancelled_message(labeled + failed, unit))
        if cut or cancel.is_set():
            _progress(c, concept["id"], message=message())
    finally:
        for task, _b in pending:
            task.cancel()
        await asyncio.to_thread(writer.close)
    return labeled, failed, message()


def _eta(t0: float, done: int, total: int | None) -> float | None:
    if not total or done <= 0:
        return None
    return round(max(0.0, (time.monotonic() - t0) * (total - done) / done), 1)


async def _index_sources(c: str, concept_id: str, corpus_dir: Path, sources: list[dict], unit: str,
                         cancel: threading.Event) -> dict:
    """The run's unit count and, for record units, every file's chunk index from the scan pool. Returns
    {total, files: {path: index}}."""
    if unit != "record":
        return {"total": len(groups_for(sources, unit)), "files": {}}
    loop = asyncio.get_running_loop()
    pool = _pool_get()
    sem = asyncio.Semaphore(SCAN_INFLIGHT_PER_WORKER * _pool_workers)
    files: dict[str, dict] = {}
    broken: list[dict] = []
    last = 0.0

    async def one(s: dict) -> None:
        nonlocal last
        async with sem:
            if cancel.is_set():
                return
            p = config.safe_corpus_path(corpus_dir, s["path"])
            try:
                idx = await loop.run_in_executor(pool, concept_scan.index_file, str(p))
            except BrokenProcessPool:
                broken.append(s)
                return
        files[s["path"]] = idx
        corpus.remember_line_count(p, (idx["size"], idx["mtime_ns"]), idx["lines"])
        if time.monotonic() - last >= PROGRESS_EVERY_S:
            last = time.monotonic()
            _progress(c, concept_id, files_indexed=len(files), file=s["path"])

    await asyncio.gather(*(one(s) for s in sources))
    if broken and not cancel.is_set():
        pool = _pool_reset(pool)
        again, broken = broken, []
        await asyncio.gather(*(one(s) for s in again))
        if broken:
            raise HTTPException(502, SCAN_STOPPED)
    _progress(c, concept_id, files_indexed=len(files), file=None)
    return {"total": sum(i["lines"] for i in files.values()), "files": files}


def _compiled(concept: dict) -> re.Pattern:
    try:
        return re.compile(concept["spec"])
    except re.error as e:
        raise HTTPException(400, f"invalid regex: {e}") from e


async def _apply_regex(c: str, concept: dict, corpus_dir: Path, sources: list[dict], index: dict, limit: int | None,
                       out: Path, cancel: threading.Event) -> tuple[int, int, str | None]:
    """The regex kind over file units in the scan pool: one task per chunk of a file for records, one per unit for
    agents and runs, at most SCAN_INFLIGHT_PER_WORKER × workers in flight. A chunk whose worker raises fails its units;
    a worker that dies breaks the pool, and the chunks in flight are re-submitted once to a fresh one."""
    _compiled(concept)
    labels = concept["labels"]
    pos, neg = labels[0], (labels[1] if len(labels) > 1 else "no")
    spec, unit = concept["spec"], concept["unit"]
    kinds = {s["path"]: s["kind"] for s in sources}
    tasks: list[tuple[str, int, int, Callable[[], dict]]] = []
    if unit == "record":
        planned = 0
        for s in sources:
            idx = index["files"].get(s["path"])
            if idx is None:
                continue
            p = str(config.safe_corpus_path(corpus_dir, s["path"]))
            for start_line, n, b0, b1 in concept_scan.chunks_of(idx):
                if limit is not None and planned >= limit:
                    break
                cap = None if limit is None else min(n, limit - planned)
                units_here = n if cap is None else cap
                planned += units_here
                # a run over whole files: rows for the matches, a cover for the rest (labels_store, covers)
                tasks.append((s["path"], b1 - b0, units_here,
                              partial(concept_scan.scan_records, p, s["path"], s["kind"], start_line, b0, b1, cap, spec, pos, neg,
                                      cap is None)))
    else:
        sizes = {s["path"]: int(s.get("size_bytes") or 0) for s in sources}
        groups = groups_for(sources, unit)
        for g in (groups[:limit] if limit else groups):
            tasks.append((g["ref"], sum(sizes.get(p, 0) for p in g["paths"]), 1,
                          partial(concept_scan.scan_group, str(corpus_dir), g["ref"], [(p, kinds[p]) for p in g["paths"]], spec, pos, neg)))
    left: dict[str, int] = {}
    for name, _b, _n, _fn in tasks:
        left[name] = left.get(name, 0) + 1
    loop = asyncio.get_running_loop()
    pool = _pool_get()
    window = SCAN_INFLIGHT_PER_WORKER * _pool_workers
    key = (c, concept["id"])
    labeled = failed = matches = files_done = bytes_done = 0
    current: str | None = None
    problems: list[str] = []
    t0 = time.monotonic()
    last_emit = 0.0

    def emit(force: bool = False) -> None:
        nonlocal last_emit
        if force or time.monotonic() - last_emit >= PROGRESS_EVERY_S:
            last_emit = time.monotonic()
            _progress(c, concept["id"], done=labeled + failed, labeled=labeled, failed=failed, matches=matches, files_done=files_done,
                      file=current, bytes_done=bytes_done, eta_s=_eta(t0, labeled + failed, _runs[key].get("total")))

    Task = tuple[str, int, int, Callable[[], dict]]
    inflight: dict[asyncio.Future, Task] = {}
    todo: Iterator[Task] = iter(tasks)
    more = True
    requeue: list[Task] = []
    pool_broken = False
    retried = False

    def finish_unit(name: str, nbytes: int) -> None:
        nonlocal bytes_done, current, files_done
        bytes_done += nbytes
        current = name
        left[name] -= 1
        if left[name] == 0:
            files_done += 1

    def problem(msg: str) -> None:
        if msg not in problems and len(problems) < MESSAGES_KEPT:
            problems.append(msg)

    writer = _LabelsWriter(out).start()
    try:
        while more or inflight or requeue:
            if requeue and not inflight:
                if cancel.is_set():
                    requeue = []
                    break
                if retried:
                    for name, nbytes, n, _fn in [*requeue, *todo]:
                        failed += n
                        finish_unit(name, nbytes)
                    requeue = []
                    problem(SCAN_STOPPED)
                    more = False
                    break
                retried = True
                pool = _pool_reset(pool)
                todo = iter([*requeue, *todo])
                requeue = []
                more = True
                pool_broken = False
            while more and len(inflight) < window and not cancel.is_set() and not pool_broken:
                try:
                    task = next(todo)
                except StopIteration:
                    more = False
                    break
                try:
                    inflight[loop.run_in_executor(pool, task[3])] = task
                except BrokenProcessPool:
                    requeue.append(task)
                    pool_broken = True
            if cancel.is_set():
                more = False
            if not inflight:
                if requeue:
                    continue
                break
            finished, _ = await asyncio.wait(list(inflight), return_when=asyncio.FIRST_COMPLETED)
            for fut in finished:
                task = inflight.pop(fut)
                name, nbytes, n, _fn = task
                try:
                    res = fut.result()
                except BrokenProcessPool:
                    requeue.append(task)
                    pool_broken = True
                    continue
                except Exception as e:  # noqa: BLE001
                    failed += n
                    problem(f"{name}: {type(e).__name__}: {e}"[:300])
                else:
                    await asyncio.to_thread(writer.put, res["rows"], res["records"])
                    labeled += res["units"]
                    matches += res["hits"]
                finish_unit(name, nbytes)
            emit()
    finally:
        await asyncio.to_thread(writer.close)
    message: str | None = _cancelled_message(labeled, unit) if cancel.is_set() else None
    if problems:
        message = "; ".join(([message] if message else []) + problems)
    emit(force=True)
    return labeled, failed, message


REGEX_BATCH = 2_000  # units a regex over streamed units labels between writes


async def _apply_regex_units(c: str, concept: dict, units: Iterable[Unit], out: Path, cancel: threading.Event) -> tuple[int, int, str | None]:
    """The regex kind over units in hand or streamed (cards, sentences, the records a trial or `within` picked, the records
    of files that hold saves), REGEX_BATCH at a time in a worker thread: one row per unit, the matched text as the
    rationale and every matched text as `spans`, as the scan pool writes a record's. A regex reads as much of a unit as
    the scan pool does, not the classifier's share of it."""
    rx = _compiled(concept)
    labels = concept["labels"]
    pos, neg = labels[0], (labels[1] if len(labels) > 1 else "no")
    todo = iter(units)

    def scan() -> tuple[list[dict], int]:
        rows: list[dict] = []
        hits = 0
        for u in itertools.islice(todo, REGEX_BATCH):
            text = u.text(UNIT_TEXT_MAX)
            m = rx.search(text)
            if m:
                hits += 1
                rows.append(_row(u.ref, pos, 1.0, "regex", m.group(0)[:concept_scan.RATIONALE_MAX], concept_scan.matched_texts(rx, text)))
            else:
                rows.append(_row(u.ref, neg, 1.0, "regex"))
        return rows, hits

    done = hits = 0
    writer = _LabelsWriter(out).start()
    try:
        while not cancel.is_set():
            rows, h = await asyncio.to_thread(scan)
            if not rows:
                break
            await asyncio.to_thread(writer.put, concept_scan.jsonl_bytes(rows), rows)
            done, hits = done + len(rows), hits + h
            _progress(c, concept["id"], done=done, labeled=done, failed=0, matches=hits)
    finally:
        await asyncio.to_thread(writer.close)
    message = _cancelled_message(done, concept["unit"]) if cancel.is_set() else None
    _progress(c, concept["id"], done=done, labeled=done, failed=0, matches=hits, eta_s=None)
    return done, 0, message


def implicit_value(labels: list[str]) -> str | None:
    """The value a code label's records over whole files take without a row of their own (labels_store, covers): the
    first of its values after the first that is_negative names (`no match`, the second of two); None when it has none,
    and every record then has its row."""
    return next((v for i, v in enumerate(labels) if i > 0 and is_negative(v, i, len(labels))), None)


def build_code_wrapper(concept: dict, groups: list[dict], limit: int | None, rows_file: Path | str,
                       units_file: Path | str | None = None, quiet: str | None = None, ts: str = "") -> str:
    """The code the code kind runs in the labels kernel: the analyst's spec (defining `label(unit)`) plus a loop over the units
    that writes one JSON line per unit ({ref, label, confidence, spans?}, or {ref, error}) to `rows_file`. File units are
    read from `groups` (relative to the kernel's cwd); cell and span units come from `units_file`. Both paths must be
    absolute. With `quiet` (implicit_value), records of whole files that take that value get cover lines instead of rows.

    The file list goes into the code as one JSON string rather than a list literal: a long list literal makes one huge line,
    and Python 3.12's tokenizer keeps a copy of the line per token, which can exhaust the kernel's memory."""
    return (
        f"# thimble: apply label {concept['name']!r} (code kind, unit={concept['unit']})\n"
        "import json as _json\n\n"
        f"{concept['spec'].rstrip()}\n\n"
        f"_groups = _json.loads({json.dumps(groups)!r})\n"
        f"_unit = {concept['unit']!r}\n"
        f"_limit = {int(limit or 0)}\n"
        f"_rows_file = {str(rows_file)!r}\n"
        f"_units_file = {(str(units_file) if units_file is not None else None)!r}\n"
        f"_quiet = {quiet!r}\n"
        f"_chunk = {CODE_COVER_LINES}\n"
        f"_ts = {ts!r}\n"
        "_n = 0\n"
        "_stats = {'errors': 0, 'first_error': None}\n\n"
        "def _read(_p):\n"
        "    with open(_p, encoding='utf-8', errors='replace') as _f:\n"
        "        for _i, _line in enumerate(_f, 1):\n"
        "            _line = _line.rstrip('\\n')\n"
        "            if _p.endswith('.jsonl'):\n"
        "                try:\n"
        "                    yield _i, _json.loads(_line)\n"
        "                except ValueError:\n"
        "                    yield _i, {'_raw': _line}\n"
        "            else:\n"
        "                yield _i, {'text': _line}\n\n"
        "def _read_units(_p):\n"
        "    with open(_p, encoding='utf-8') as _f:\n"
        "        for _line in _f:\n"
        "            if _line.strip():\n"
        "                yield _json.loads(_line)\n\n"
        "def _emit(_ref, _rec, _implicit=False):\n"
        "    try:\n"
        "        _out = label(_rec)\n"
        "        _spans = None\n"
        "        if isinstance(_out, dict):\n"
        "            _lab, _conf, _spans = _out.get('label'), _out.get('confidence', 1.0), _out.get('spans')\n"
        "        elif isinstance(_out, (tuple, list)):\n"
        "            _lab, _conf = _out[0], (_out[1] if len(_out) > 1 else 1.0)\n"
        "            _spans = _out[2] if len(_out) > 2 else None\n"
        "        else:\n"
        "            _lab, _conf = _out, 1.0\n"
        "        _row = {'ref': _ref, 'label': str(_lab), 'confidence': float(_conf)}\n"
        "        if isinstance(_spans, (list, tuple)):\n"
        "            _row['spans'] = [str(_x) for _x in _spans if isinstance(_x, str)][:16]\n"
        "    except Exception as _e:\n"
        "        _row = {'ref': _ref, 'error': f'{type(_e).__name__}: {_e}'}\n"
        "        _stats['errors'] += 1\n"
        "        if _stats['first_error'] is None:\n"
        "            _stats['first_error'] = _row['error']\n"
        "    if _implicit and 'error' not in _row and _row['label'] == _quiet and not _row.get('spans'):\n"
        "        return True\n"
        "    _out_f.write(_json.dumps(_row) + '\\n')\n"
        "    return 'error' not in _row\n\n"
        "def _mark(_p, _a, _b, _cover):\n"
        "    if _cover and _b >= _a:\n"
        "        _out_f.write(_json.dumps({'cover': _p, 'from': _a, 'to': _b, 'value': _quiet, 'source': 'code', 'ts': _ts}) + '\\n')\n"
        "    elif not _cover:\n"
        "        _out_f.write(_json.dumps({'clear': _p, 'from': _a, 'to': _b}) + '\\n')\n\n"
        "with open(_rows_file, 'w', encoding='utf-8') as _out_f:\n"
        "    if _units_file is not None:\n"
        "        for _u in _read_units(_units_file):\n"
        "            if _limit and _n >= _limit:\n"
        "                break\n"
        "            _emit(_u['ref'], _u['unit'])\n"
        "            _n += 1\n"
        "    for _g in _groups:\n"
        "        if _limit and _n >= _limit:\n"
        "            break\n"
        "        if _unit == 'record' and _quiet is not None and not _limit:\n"
        "            _p, _start, _from, _i = _g['paths'][0], 1, 1, 0\n"
        "            _mark(_p, 1, _chunk, False)\n"
        "            for _i, _rec in _read(_p):\n"
        "                if _i >= _start + _chunk:\n"
        "                    _mark(_p, _from, _i - 1, True)\n"
        "                    _start = _from = _i\n"
        "                    _mark(_p, _i, _i + _chunk - 1, False)\n"
        "                if not _emit(f\"{_p}#L{_i}\", _rec, True):\n"
        "                    _mark(_p, _from, _i - 1, True)\n"
        "                    _from = _i + 1\n"
        "                _n += 1\n"
        "            _mark(_p, _from, _i, True)\n"
        "        elif _unit == 'record':\n"
        "            for _i, _rec in _read(_g['paths'][0]):\n"
        "                if _limit and _n >= _limit:\n"
        "                    break\n"
        "                _emit(f\"{_g['paths'][0]}#L{_i}\", _rec)\n"
        "                _n += 1\n"
        "        else:\n"
        "            _recs = [_rec for _p in _g['paths'] for _i, _rec in _read(_p)]\n"
        "            _emit(_g['ref'], {'ref': _g['ref'], 'paths': _g['paths'], 'records': _recs})\n"
        "            _n += 1\n"
        "print(_json.dumps({'_done': _n, 'errors': _stats['errors'], 'first_error': _stats['first_error']}))\n"
    )


CODE_COVER_LINES = 4_000  # records of a file one cover of a code label spans at most (build_code_wrapper)


def _parse_code_rows(lines: Iterator[str] | list[str]) -> tuple[list[dict], int, str | None]:
    """(rows, and the cover and clear lines among them in their order, n_errors, first error message) from the
    wrapper's JSON lines."""
    rows: list[dict] = []
    errors = 0
    message = None
    for line in lines:
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            obj = json.loads(line)
        except ValueError:
            continue
        if labels_store.is_marker(obj):
            rows.append(obj)
            continue
        if "_done" in obj or not obj.get("ref"):
            continue
        if "error" in obj:
            errors += 1
            message = message or str(obj["error"])[:300]
            continue
        rows.append(_row(str(obj["ref"]), str(obj.get("label")), _coerce_confidence(obj.get("confidence")), "code", None,
                         labels_store.spans_field(obj.get("spans"))))
    return rows, errors, message


def parse_code_output(outputs: list[dict], rows_file: Path | None) -> tuple[list[dict], int, str | None]:
    """(rows with the cover and clear lines among them, n_errors, message) for a code-kind run: the rows from
    `rows_file` (none when the code never wrote it), the first error the kernel reported as the message."""
    if rows_file is not None and rows_file.is_file():
        with open(rows_file, "r", encoding="utf-8") as f:
            rows, errors, message = _parse_code_rows(f)
    else:
        rows, errors, message = [], 0, None
    return rows, errors, _kernel_error(outputs) or message


def _kernel_error(outputs: list[dict]) -> str | None:
    """The first error the kernel reported for a code-kind run, as `<name>: <value>`."""
    for b in outputs or []:
        err = b.get("application/vnd.thimble.error+json") if isinstance(b, dict) else None
        if isinstance(err, dict):
            return f"{err.get('ename', 'Error')}: {err.get('evalue', '')}"[:300]
    return None


def _code_row_batches(rows_file: Path | None, size: int) -> Iterator[tuple[list[dict], int, str | None]]:
    """_parse_code_rows over each `size` lines of the wrapper's rows file in turn; nothing when the code never wrote
    it."""
    if rows_file is None or not rows_file.is_file():
        return
    with open(rows_file, "r", encoding="utf-8") as f:
        while lines := list(itertools.islice(f, size)):
            yield _parse_code_rows(lines)


def _collect_code_rows(outputs: list[dict], rows_file: Path | None, out: Path, pos_label: str | None = None) -> tuple[int, int, str | None, int]:
    """Blocking (worker thread): validate the wrapper's rows and append them to the labels file and the store,
    labels_store.BATCH at a time. Returns (labeled units including records the covers hold, errors, message, rows carrying
    `pos_label`)."""
    labeled = errors = matches = 0
    cleared: set[str] = set()  # files whose records the covers count
    message: str | None = None
    written = 0  # lines appended to the labels file
    with _store_lock(out):
        st: labels_store.Store | None = None
        conn: sqlite3.Connection | None = None
        broken = False
        try:
            for rows, n_errors, first in _code_row_batches(rows_file, labels_store.BATCH):
                errors += n_errors
                message = message or first
                if not rows:
                    continue
                if not written:
                    labels_store.mend_tail(out)
                append_jsonl_many(out, rows)
                written += len(rows)
                for r in rows:
                    if labels_store.is_marker(r):
                        if r.get(labels_store.CLEAR):
                            cleared.add(str(r[labels_store.CLEAR]))
                        elif r.get("to") is not None:
                            labeled += max(0, int(r["to"]) - int(r.get("from") or 1) + 1)
                        continue
                    matches += int(r.get("label") == pos_label)
                    labeled += int(labels_store.ref_parts(r["ref"])[0] not in cleared)
                if broken:
                    continue
                try:
                    if conn is None:
                        st = labels_store.Store(out)
                        conn = st.connect(write=True)
                    st.add(rows, None, conn)
                except sqlite3.Error:
                    broken = True
                    log.exception("labels store %s: a write failed; the store is rebuilt from the labels file on the next read", out.name)
            if written and not broken and st is not None and conn is not None:
                try:
                    st.add([], _file_key(out), conn)
                except sqlite3.Error:
                    log.exception("labels store %s: a write failed; the store is rebuilt from the labels file on the next read", out.name)
        finally:
            if conn is not None:
                conn.close()
    return labeled, errors, _kernel_error(outputs) or message, matches


async def _apply_code(c: str, concept: dict, sources: list[dict], units: list[Unit] | None, limit: int | None, out: Path) -> tuple[int, int, str | None]:
    """The code kind in the labels kernel (notebook.execute_on, no cell stored): the wrapper writes its rows to a temp
    file under labels/, read and removed here. With `units` None the wrapper reads the file units from the matched
    files; given units (cards, sentences, or a trial's sampled records) go to it in a file of their own."""
    from . import notebook

    stamp = secrets.token_hex(4)
    rows_file = out.with_name(f".{concept['id']}.{stamp}.rows.tmp")
    units_file: Path | None = None
    groups: list[dict] = []
    if units is None:
        groups = groups_for(sources, concept["unit"])
    else:
        units_file = out.with_name(f".{concept['id']}.{stamp}.units.tmp")
        units_file.write_text("".join(json.dumps({"ref": u.ref, "unit": u.record}, ensure_ascii=False, default=str) + "\n"
                                      for u in units), "utf-8")
    # a run over the records of whole files writes no row for a record that takes the negative (labels_store, covers)
    quiet = implicit_value(concept["labels"]) if units is None and concept["unit"] == "record" and not limit else None
    code = build_code_wrapper(concept, groups, limit, rows_file, units_file, quiet=quiet, ts=_now())
    try:
        outputs, _n, _status = await notebook.execute_on(c, CODE_KERNEL, code)
        labeled, errors, message, matches = await asyncio.to_thread(_collect_code_rows, outputs, rows_file, out, concept["labels"][0])
    finally:
        rows_file.unlink(missing_ok=True)
        if units_file is not None:
            units_file.unlink(missing_ok=True)
    _progress(c, concept["id"], matches=matches)
    return labeled, errors, message


# --------------------------------------------------------------------------- apply


def _record_application(ws: Path, concept_id: str, app: dict, calibration: dict | None = None,
                        label_stats: dict | None = None) -> dict | None:
    """Append a run summary to the stored concept (re-read: it may have changed meanwhile) and, after a completed
    run, store the recomputed calibration and the labels file's stats with its key and step its revision, since the
    run changed its rows (note_change)."""
    concept = read_concept(ws, concept_id)
    if concept is None:
        return None
    if app.get("status") == "done":
        note_change(concept, "ran", ran_text(concept["unit"], app.get("total")))
    concept["applications"] = (concept["applications"] + [app])[-APPLICATIONS_KEPT:]
    if calibration is not None:
        concept["calibration"] = calibration
    if label_stats is not None:
        concept["label_stats"] = label_stats
    write_concept(ws, concept)
    return concept


def _stored_stats(key: tuple[int, int] | None, stats: dict) -> dict | None:
    if key is None:
        return None
    return {"key": [int(key[0]), int(key[1])], "n_labeled": int(stats.get("n_labeled") or 0),
            "n_reviewed": int(stats.get("n_reviewed") or 0), "counts": {str(k): int(v) for k, v in (stats.get("counts") or {}).items()}}


def _run_record(c: str, concept_id: str, run_id: str, started: str, created_by: str, patterns: list[str], sources: list[dict]) -> dict:
    """The run record as a run begins: stored and streamed."""
    _runs.pop((c, concept_id), None)
    return _progress(c, concept_id, run_id=run_id, started=started, created_by=created_by, status="running", paths=patterns,
                     files_total=len(sources) if sources else None,
                     bytes_total=sum(int(s.get("size_bytes") or 0) for s in sources) if sources else None)


def _patterns(paths: Any) -> list[str]:
    return [str(p) for p in (paths if isinstance(paths, list) else [paths] if paths else []) if str(p).strip()]


async def run_apply(c: str, concept_id: str, paths: list[str] | None = None, limit: int | None = None, created_by: str = "user",
                    *, comment: bool = True, examples: bool = False, run_id: str | None = None, started: str | None = None,
                    sources: list[dict] | None = None) -> dict:
    """Apply a concept over its unit's scope, write the label rows and return the run summary. start_apply runs this as a
    task. One run at a time per concept. With `examples`, a prompt kind carries the analyst's verdicts as few-shot examples.
    Raises HTTPException for a missing concept, a bad regex, no matching files or a fatal error."""
    ws, concept = load_concept(c, concept_id)
    if concept["trial"] and not limit:
        # a trial becomes a label once it runs on everything
        concept["trial"] = False
        write_concept(ws, concept)
        _notify(c, concept_id, "defined")
    version = concept["version"]
    unit = concept["unit"]
    within = concept.get("within") if unit == "record" else None
    within_rev = _rev_of(ws, within["label"]) if within else None
    patterns = _patterns(paths) if unit in FILE_UNITS else []
    corpus_dir = config.corpus_dir(c)
    if unit in FILE_UNITS:
        if sources is None:
            sources = await asyncio.to_thread(match_paths, corpus_dir, patterns)
        if not sources:
            raise HTTPException(400, f"no files match {patterns}")
    else:
        sources = []
    limit = int(limit) if limit else None
    # a trial over files or runs runs as a full run over the files or runs it samples (trial_groups); a trial over
    # records picks its records once the files are indexed (trial_sample)
    scope_groups: int | None = None
    if limit and unit in ("agent", "run"):
        sources, scope_groups = await asyncio.to_thread(trial_groups, sources, unit, limit)
    key = (c, concept_id)
    lock = _locks.setdefault(key, asyncio.Lock())
    async with lock:
        cancel = _cancel_event(c, concept_id)
        cancel.clear()
        out = labels_file(ws, concept_id)
        out.parent.mkdir(parents=True, exist_ok=True)
        run_id = run_id or _new_id()
        started = started or _now()
        _run_record(c, concept_id, run_id, started, created_by, patterns, sources)
        total: int | None = None
        matched: int | None = None
        units: list[Unit] = []
        try:
            _progress(c, concept_id, phase="index")
            await asyncio.to_thread(_store_ready, ws, concept_id)
            _progress(c, concept_id, phase=None)
            if unit in FILE_UNITS:
                index = await _index_sources(c, concept_id, corpus_dir, sources, unit, cancel)
                matched = index["total"]
                if within:
                    parent = read_concept(ws, within["label"])
                    if parent is None:
                        raise HTTPException(400, "within: the label this one runs within is gone; apply it again with "
                                                 "another label's value as `within`, or without it")
                    if within["value"] not in parent["labels"]:
                        raise HTTPException(400, f"within: the label {parent['name']!r} no longer has the value "
                                                 f"{within['value']!r}; its values are {', '.join(parent['labels'])}")
                    # a prompt label reads PROMPT_APPLY_MAX records at most, so one more tells it the narrowing is wider
                    most = PROMPT_APPLY_MAX + 1 if concept["kind"] == "prompt" else None
                    units = await asyncio.to_thread(within_units, ws, corpus_dir, sources, within, most)
                    if concept["kind"] == "prompt" and not limit and len(units) > PROMPT_APPLY_MAX:
                        raise HTTPException(400, within_too_wide(ws, within, len(units)))
                    matched = len(units)
                    if limit and len(units) > limit:
                        units = [units[i] for i in spread(len(units), limit)]
                    # read spread over the narrowing first, so the first rows and reasons stand for all of it
                    units = [units[i] for i in interleaved(len(units))]
                    total = len(units)
                elif scope_groups is not None:
                    total, matched = matched, scope_groups
                elif limit:
                    lines = {p: int(i.get("lines") or 0) for p, i in index["files"].items()}
                    units = await asyncio.to_thread(trial_sample, corpus_dir, sources, limit, lines)
                    total = len(units)
                else:
                    total = matched
            else:
                units = await asyncio.to_thread(scope_units, c, unit)
                matched = len(units)
                if limit:  # a trial over cards or sentences, spread over the canvas or the document as one over files is
                    units = [units[i] for i in spread(len(units), limit)]
                total = len(units)
            _progress(c, concept_id, total=total, matched_total=matched)
            # what the kinds below run over: the sampled records of a trial or the records `within` names, else the
            # whole scope
            sampled = unit == "record" and (bool(limit) or bool(within))
            if examples and concept["kind"] == "prompt":
                few = await asyncio.to_thread(few_shot_examples, ws, concept, corpus_dir)
                concept = {**concept, "examples": few}
                _progress(c, concept_id, examples=len(few))
            if concept["kind"] == "regex":
                # a regex reads a save as what it changed, as a model does, so files that hold saves go record by record
                saves = unit == "record" and await asyncio.to_thread(holds_saves, corpus_dir, sources)
                if unit in FILE_UNITS and not sampled and not saves:
                    labeled, failed, message = await _apply_regex(c, concept, corpus_dir, sources, index, None, out, cancel)
                else:
                    if saves:
                        units = (await asyncio.to_thread(picked_as_changes, corpus_dir, units, False) if sampled
                                 else as_changes(iter_units(corpus_dir, sources, unit), False))
                    labeled, failed, message = await _apply_regex_units(c, concept, units, out, cancel)
            elif concept["kind"] == "prompt":
                stream: Iterator[Unit] = iter_units(corpus_dir, sources, unit) if unit in FILE_UNITS and not sampled else iter(units)
                if unit == "record":
                    stream = iter(await asyncio.to_thread(picked_as_changes, corpus_dir, units)) if sampled else as_changes(stream)
                labeled, failed, message = await _apply_prompt(c, concept, stream, out, cancel, files=[s["path"] for s in sources],
                                                               comment=comment)
            else:
                labeled, failed, message = await _apply_code(c, concept, sources, None if unit in FILE_UNITS and not sampled else units,
                                                             None, out)
        except HTTPException as e:
            _progress(c, concept_id, status="error", message=str(e.detail), eta_s=None, phase=None)
            _record_application(ws, concept_id, {"ts": started, "paths": patterns, "total": total, "matched_total": matched,
                                                 "labeled": 0, "failed": total or 0, "status": "error", "message": str(e.detail),
                                                 "created_by": created_by, "version": version})
            raise
        except asyncio.CancelledError:
            _progress(c, concept_id, status="error", message="cancelled", eta_s=None, phase=None)
            raise
        except Exception as e:  # noqa: BLE001
            log.exception("apply failed")
            msg = f"{type(e).__name__}: {e}"[:500]
            if isinstance(e, BrokenProcessPool):
                _pool_shutdown()
                msg = SCAN_STOPPED
            _progress(c, concept_id, status="error", message=msg, eta_s=None, phase=None)
            _record_application(ws, concept_id, {"ts": started, "paths": patterns, "total": total, "matched_total": matched,
                                                 "labeled": 0, "failed": total or 0, "status": "error", "message": msg,
                                                 "created_by": created_by, "version": version})
            raise HTTPException(502, f"apply failed: {msg}") from e
        try:
            _progress(c, concept_id, phase="summary", eta_s=None)
            calibration, stats, file_key = await asyncio.to_thread(_labels_summary, ws, concept_id, concept["labels"])
            state = _runs.get(key) or {}
            # `matches` (the units this run gave the first value) is kept on the application, so the Files pane's
            # label row can say "468 of 2,392,002 records" after a restart, when the run record is gone.
            # `limit` and `stopped` say what the run covered, which an apply of the same predicate reads (covered)
            app = {"ts": started, "paths": patterns, "total": total, "matched_total": matched, "labeled": labeled, "failed": failed,
                   "matches": int(state.get("matches") or 0), "status": "done", "message": message, "created_by": created_by,
                   "version": version, "examples": len(concept.get("examples") or []), "limit": limit, "stopped": cancel.is_set(),
                   "within": within, "within_rev": within_rev}
            concept = (_record_application(ws, concept_id, app, calibration, _stored_stats(file_key, stats))
                       or {**concept, "calibration": calibration})
            summary = {**app, "run_id": run_id, "concept": concept_id, "name": concept["name"], "unit": concept["unit"],
                       "kind": concept["kind"], "labels_path": str(out),
                       **stats, "est_precision": concept["calibration"]["est_precision"], "calibration": concept["calibration"]}
            if not out.exists():
                labels_store.remove(out)
            whole = not cancel.is_set() and not limit and not failed and state.get("files_total") is not None
            _progress(c, concept_id, status="done", done=labeled + failed, labeled=labeled, failed=failed, message=message,
                      eta_s=None, phase=None, files_done=state["files_total"] if whole else state.get("files_done", 0), summary=summary)
        except asyncio.CancelledError:
            _progress(c, concept_id, status="error", message="cancelled", eta_s=None, phase=None)
            raise
        except Exception as e:  # noqa: BLE001
            log.exception("apply: the end-of-run summary failed")
            msg = f"the labels were written but the run's summary failed: {type(e).__name__}: {e}"[:500]
            _progress(c, concept_id, status="error", message=msg, eta_s=None, phase=None)
            raise HTTPException(502, f"apply failed: {msg}") from e
    _notify(c, concept_id, "applied")
    return summary


# --------------------------------------------------------------------------- the run as a task


def _apply_finished(key: tuple[str, str], task: asyncio.Task) -> None:
    if _tasks.get(key) is task:
        _tasks.pop(key, None)
    if not task.cancelled():
        exc = task.exception()
        if exc is not None and not isinstance(exc, HTTPException):
            log.debug("apply task %s/%s ended with %r", key[0], key[1], exc)


def running_apply(c: str, concept_id: str) -> dict | None:
    """The run record of the apply running for this concept, or None."""
    task = _tasks.get((c, concept_id))
    if task is None or task.done():
        return None
    return _runs.get((c, concept_id))


def _stop_apply(key: tuple[str, str]) -> asyncio.Task | None:
    """End the apply running for `key` from any thread: the cancel flag set, the task forgotten and cancelled on its
    own loop. Returns the task for a caller on the loop to await, None when nothing ran."""
    task = _tasks.pop(key, None)
    _cancel_event(*key).set()
    if task is None or task.done():
        return None
    try:
        here = asyncio.get_running_loop()
    except RuntimeError:
        here = None
    if here is task.get_loop():
        task.cancel()
    else:
        task.get_loop().call_soon_threadsafe(task.cancel)
    return task


def _partial_record(c: str, concept_id: str) -> dict:
    """The run record so far plus `partial: true`, the concept's name, unit and kind and the labels path."""
    ws, concept = load_concept(c, concept_id)
    state = dict(_runs.get((c, concept_id)) or {})
    return {**state, "partial": True, "concept": concept_id, "name": concept["name"], "unit": concept["unit"],
            "kind": concept["kind"], "labels_path": str(labels_file(ws, concept_id))}


def _already_running(live: dict) -> HTTPException:
    return HTTPException(409, {"message": f"this label is already being applied (run {live.get('run_id')}); wait for it or cancel it first",
                               "run_id": live.get("run_id")})


def no_files_match(corpus_dir: Path, patterns: list[str]) -> str:
    """The refusal of an apply whose paths match no file a label reads, naming the databases they matched, since a
    label reads text records and a database is queried in a card."""
    pats = [str(p).strip().strip("/") for p in patterns if str(p).strip()]
    dbs = [src["path"] for src in corpus.list_sources(corpus_dir) if src["kind"] == "forge"
           and any(src["path"] == p or fnmatch.fnmatchcase(src["path"], p) or src["path"].startswith(p + "/") for p in pats)]
    if dbs:
        return (f"no files match {patterns} but the database {', '.join(dbs[:3])}; a label reads text records, so query "
                "a database in a card")
    return f"no files match {patterns}"


def scope_sources(c: str, unit: str, kind: str, patterns: list[str], limit: int | None, within: bool = False) -> list[dict]:
    """The sources an apply of a file unit runs over, or HTTPException(400) when it cannot run: no file matches, or a
    prompt label would run over the whole of a big corpus with neither a limit nor `within`. Blocking (a thread)."""
    corpus_dir = config.corpus_dir(c)
    sources = match_paths(corpus_dir, patterns)
    if not sources:
        raise HTTPException(400, no_files_match(corpus_dir, patterns))
    if kind == "prompt" and not limit and not within and not narrowing(patterns):
        # a prompt label needs a model call per BATCH_ITEMS units; over a whole big corpus that is unbounded, so past
        # PROMPT_APPLY_MAX units the analyst must cap it or name the files
        n, read = units_at_least(corpus_dir, sources, unit, PROMPT_APPLY_MAX)
        if n > PROMPT_APPLY_MAX:
            raise HTTPException(400, prompt_apply_too_wide(n, read, len(sources), unit))
    return sources


async def start_apply(c: str, concept_id: str, paths: list[str] | None = None, limit: int | None = None, created_by: str = "user",
                      *, comment: bool = True, examples: bool = False, sources: list[dict] | None = None) -> dict:
    """Begin an apply in the background and return its run record at once: 404 no such concept, 400 no matching files, 409 an
    apply of this concept is already running (`detail.run_id` names it). `sources` are the files scope_sources already found."""
    ws, concept = load_concept(c, concept_id)
    key = (c, concept_id)
    live = running_apply(c, concept_id)
    if live is not None:
        raise _already_running(live)
    patterns = _patterns(paths)
    limit = int(limit) if limit else None
    if concept["unit"] in FILE_UNITS:
        if sources is None:
            sources = await asyncio.to_thread(scope_sources, c, concept["unit"], concept["kind"], patterns, limit,
                                              bool(concept.get("within")))
    else:
        patterns, sources = [], []
    if running_apply(c, concept_id) is not None:
        raise _already_running(_runs.get(key) or {})
    run_id, started = _new_id(), _now()
    _cancel_event(c, concept_id).clear()
    record = _run_record(c, concept_id, run_id, started, created_by, patterns, sources)
    task = asyncio.get_running_loop().create_task(
        run_apply(c, concept_id, patterns, limit, created_by, comment=comment, examples=examples, run_id=run_id, started=started,
                  sources=sources),
        name=f"thimble-apply-{concept_id}")
    _tasks[key] = task
    task.add_done_callback(partial(_apply_finished, key))
    return record


async def wait_apply(c: str, concept_id: str, timeout: float | None = None) -> dict:
    """Wait for the concept's running apply: its summary when it ends within `timeout` seconds (APPLY_WAIT_S when
    None; its HTTPException when it fails), else the run record so far with `partial: true`. 404 when nothing runs
    and no summary is on record."""
    if timeout is None:
        timeout = APPLY_WAIT_S
    key = (c, concept_id)
    task = _tasks.get(key)
    if task is None:
        state = _runs.get(key)
        if state and state.get("summary"):
            return state["summary"]
        raise HTTPException(404, "no apply is running for this concept")
    done, _pending = await asyncio.wait({task}, timeout=None if timeout == float("inf") else timeout)
    if task in done:
        return task.result()
    return _partial_record(c, concept_id)


async def cancel_workspace(c: str) -> list[str]:
    """End every apply running for workspace `c` before its directory goes (ledger.reset_workspace) and forget its
    run tables. Returns the concept ids whose runs were stopped."""
    out: list[str] = []
    for key in [k for k in list(_tasks) if k[0] == c]:
        task = _tasks.pop(key)
        _cancel_event(*key).set()
        if not task.done():
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
        out.append(key[1])
    for table in (_runs, _cancels, _locks):
        for key in [k for k in list(table) if k[0] == c]:
            table.pop(key, None)
    return out


def _labels_summary(ws: Path, concept_id: str, labels: list[str]) -> tuple[dict, dict, tuple[int, int] | None]:
    """Blocking (worker thread): (calibration, label_stats, the labels file's key) from the store at a run's end."""
    p = labels_file(ws, concept_id)
    if _file_key(p) is None:
        return calibration_stats([], labels), label_stats([]), None
    st = _store_ready(ws, concept_id)
    return _calibration_from_pairs(st.calibration_pairs(), labels), st.stats(), _file_key(p)


# --------------------------------------------------------------------------- verdicts


def record_verdict(ws: Path, concept: dict, ref: str, label: str, note: str | None = None) -> tuple[dict, dict]:
    """Append the analyst's row to the file and the store, recompute the concept's calibration and step its revision
    (a corrected value, note_change). Returns (row, updated concept). While the store is being rebuilt the row goes to
    the file alone and the stats stand."""
    ref = str(ref or "").strip()
    label = " ".join(str(label or "").split())
    if not ref or not label:
        raise HTTPException(400, "ref and label are required")
    row = _row(ref, label, 1.0, "analyst", (note or "").strip() or None)
    out = labels_file(ws, concept["id"])
    out.parent.mkdir(parents=True, exist_ok=True)
    stored = concept.get("label_stats")
    with _store_lock(out):
        st = _store_ready(ws, concept["id"], wait=False)
        before = _file_key(out)
        labels_store.mend_tail(out)
        append_jsonl(out, row)
        if st is not None:
            st.add([row], _file_key(out))
    note_change(concept, "corrected")
    if st is None:
        write_concept(ws, concept)
        return row, concept
    concept["calibration"] = _calibration_from_pairs(st.calibration_pairs(), concept["labels"])
    if stored is not None and before is not None and tuple(stored["key"]) == before:
        stats = {"n_labeled": stored["n_labeled"], "n_reviewed": st.n_reviewed(), "counts": dict(stored["counts"])}
    else:
        stats = st.stats()
    concept["label_stats"] = _stored_stats(_file_key(out), stats)
    write_concept(ws, concept)
    return row, concept


def _file_key(p: Path) -> tuple[int, int] | None:
    return labels_store.file_key(p)


# --------------------------------------------------------------------------- filters
#
# One filter per scope, which the browser and a chat set alike, kept here so every tab shows the same one. In Files and
# the report a filter is a label's value, {concept, value}. The canvas's filter can also hold the card parts its Filter
# menu sets (CARD_PARTS); a card must pass every part that is set. filters.py reads the card parts on the server the way
# the browser's cardFilter.ts reads them.

CARD_PARTS = ("kinds", "groups", "makers", "checks", "starred", "locked", "text")
_CARD_LISTS = ("kinds", "groups", "makers", "checks")
_CARD_FLAGS = ("starred", "locked")
FILTER_TEXT_MAX = 200  # characters of a text filter kept
_filters_lock = threading.Lock()  # one change of filters.json at a time, since a sync route runs in a worker thread


def card_parts(raw: Any) -> dict:
    """The card parts of a canvas filter that are set, cleaned: distinct non-empty strings for kinds, groups, makers and
    checks, True for starred and locked, the text with its whitespace collapsed. What does not fit is left out."""
    o = raw if isinstance(raw, dict) else {}
    out: dict[str, Any] = {}
    for part in _CARD_LISTS:
        v = o.get(part)
        values: list[str] = []
        for x in [v] if isinstance(v, str) else v if isinstance(v, list) else []:
            s = " ".join(x.split()) if isinstance(x, str) else ""
            if s and s not in values:
                values.append(s)
        if values:
            out[part] = values
    for part in _CARD_FLAGS:
        if o.get(part) is True:
            out[part] = True
    text = " ".join(o["text"].split())[:FILTER_TEXT_MAX] if isinstance(o.get("text"), str) else ""
    if text:
        out["text"] = text
    return out


def read_filters(ws: Path) -> dict:
    """{scope: filter} for the scopes with a filter: {concept, value} in Files and the report; in the canvas the label
    part when it is set and each card part that is set (card_parts)."""
    data = read_json(filters_file(ws), {})
    out: dict[str, dict] = {}
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


def _write_filters(ws: Path, filters: dict) -> None:
    atomic_write_text(filters_file(ws), json.dumps(filters, indent=1, ensure_ascii=False))


def _filter_event(scope: str, entry: dict | None) -> dict:
    """`filter {scope, concept?, value?}`, with the label part the scope's filter holds after a change, if any."""
    return {"type": "filter", "scope": scope, **{k: entry[k] for k in ("concept", "value") if entry and k in entry}}


def _files_label_off(c: str, ws: Path, concept_id: str) -> None:
    """Turn a label off in Files when the filter that turned it on goes."""
    concept = read_concept(ws, concept_id)
    if concept is not None and concept["shown"]:
        concept["shown"] = False
        write_concept(ws, coloured(ws, concept))
        _notify(c, concept["id"], "changed")


def set_filter(c: str, scope: str, concept_id: str, value: str) -> dict:
    """Choose `value` of the concept as the scope's filter (a canvas filter keeps its card parts); emits `filter {scope,
    concept, value}`. In Files a filter is the label turned on with that value alone highlighted (`shown`, the classes'
    `highlight`), and a filter on another label turns off the label the filter named before, so only the new one shows."""
    if scope not in SCOPES:
        raise HTTPException(400, f"scope must be one of {', '.join(SCOPES)}")
    ws, concept = load_concept(c, concept_id)
    value = " ".join(str(value or "").split())
    if not value:
        raise HTTPException(400, "value is required")
    with _filters_lock:
        filters = read_filters(ws)
        before = filters.get(scope) or {}
        filters[scope] = {"concept": concept["id"], "value": value, **(card_parts(before) if scope == "canvas" else {})}
        _write_filters(ws, filters)
    if scope == "files":
        if before.get("concept") and before["concept"] != concept["id"]:
            _files_label_off(c, ws, before["concept"])
        if concept["unit"] in FILE_UNITS:
            concept["shown"] = True
            if any(cl["name"] == value for cl in concept["classes"]):
                for cl in concept["classes"]:
                    cl["highlight"] = cl["name"] == value
            write_concept(ws, coloured(ws, concept))
            _notify(c, concept["id"], "changed")
    _emit(c, _filter_event(scope, filters[scope]))
    return filters


def set_card_filter(c: str, parts: dict) -> dict:
    """Set the card parts of the canvas's filter, all of them at once (a part `parts` leaves out is unset); its label
    part stays. Emits `filter {scope: canvas, concept?, value?}`."""
    ws = _ws(c)
    with _filters_lock:
        filters = read_filters(ws)
        entry = {k: v for k, v in (filters.get("canvas") or {}).items() if k in ("concept", "value")}
        entry.update(card_parts(parts))
        if entry:
            filters["canvas"] = entry
        else:
            filters.pop("canvas", None)
        _write_filters(ws, filters)
    _emit(c, _filter_event("canvas", entry))
    return filters


def clear_filter(c: str, scope: str, *, whole: bool = False) -> dict:
    """Drop the scope's label filter, and with `whole` the canvas's card parts too, which a canvas filter keeps
    otherwise; emits `filter {scope, concept?, value?}` with what is left. In Files the label turns off."""
    if scope not in SCOPES:
        raise HTTPException(400, f"scope must be one of {', '.join(SCOPES)}")
    ws = _ws(c)
    with _filters_lock:
        filters = read_filters(ws)
        entry = filters.get(scope)
        left = {} if entry is None or whole or scope != "canvas" else card_parts(entry)
        if entry is None or left == entry:
            return filters
        if left:
            filters[scope] = left
        else:
            filters.pop(scope)
        _write_filters(ws, filters)
    if scope == "files" and entry.get("concept"):
        _files_label_off(c, ws, entry["concept"])
    _emit(c, _filter_event(scope, left))
    return filters


def _clear_filters_of(c: str, concept_id: str) -> None:
    ws = _ws(c)
    for scope, f in list(read_filters(ws).items()):
        if f.get("concept") == concept_id:
            clear_filter(c, scope)


# --------------------------------------------------------------------------- revisions: the cards a change leaves stale

UNIT_NAMES = {"record": ("record", "records"), "agent": ("file", "files"), "run": ("run", "runs"), "cell": ("card", "cards"),
              "span": ("sentence", "sentences")}


def note_change(concept: dict, what: str, text: str = "") -> dict:
    """Step the label's revision for a change of kind `what` (CHANGE_KINDS) and keep the change in words. Consecutive
    corrections are one entry spanning revisions `first` to `rev`. Mutates and returns `concept`; the caller writes it."""
    rev = int(concept.get("rev") or 0) + 1
    changes = list(concept.get("changes") or [])
    last = changes[-1] if changes else None
    if what == "corrected" and last and last["what"] == "corrected" and last["rev"] == rev - 1:
        changes[-1] = {**last, "rev": rev, "ts": _now()}
    else:
        changes.append({"what": what, "first": rev, "rev": rev, "text": text, "ts": _now()})
    concept["rev"] = rev
    concept["changes"] = changes[-CHANGES_KEPT:]
    return concept


def redefined_text(before: list[str], values: list[str]) -> str:
    return f"redefined, its values now {', '.join(values)}" if list(before) != list(values) else "redefined"


def ran_text(unit: str, total: Any) -> str:
    one, many = UNIT_NAMES.get(unit, ("unit", "units"))
    n = int(total or 0)
    return f"run over {n:,} {one if n == 1 else many}"


def changed_since(concept: dict, rev: int) -> str:
    """What changed in the label after revision `rev`, in the words a stale card's tag uses (frontend canvas/concepts
    changedSince says the same); '' when nothing did."""
    if int(concept.get("rev") or 0) <= rev:
        return ""
    entries = [e for e in concept.get("changes") or [] if e["rev"] > rev]
    parts = [] if entries and entries[0]["first"] <= rev + 1 else ["earlier changes"]
    for e in entries:
        if e["what"] == "corrected":
            n = e["rev"] - max(e["first"], rev + 1) + 1
            parts.append(f"{n} value{'' if n == 1 else 's'} corrected")
        else:
            parts.append(e["text"] or e["what"])
    return "; ".join(parts)


def stale_in(cell: dict, concepts_by_id: dict[str, dict]) -> dict[str, str]:
    """The labels `cell` read at an older revision than theirs, by id, each with what changed since. Only a card whose run
    noted the revisions it read (`label_revs`) can be stale."""
    revs = cell.get("label_revs") if isinstance(cell.get("label_revs"), dict) else {}
    out = {}
    for cid, rev in revs.items():
        k = concepts_by_id.get(cid)
        if k is None or not isinstance(rev, int):
            continue
        if text := changed_since(k, rev):
            out[cid] = text
    return out


async def bring_current(c: str, concept_ids: list[str], created_by: str = "user") -> list[str]:
    """Start a run of each label in `concept_ids` whose rows do not answer its definition as it stands (covered), so a card
    run after them counts by each label as now defined (notebook.regenerate_cell). A running label is waited for; one that
    is gone is left out. Returns the ids of the labels whose runs to wait for (wait_apply)."""
    ws = _ws(c)
    out: list[str] = []
    for cid in dict.fromkeys(str(x) for x in concept_ids if x):
        concept = read_concept(ws, cid)
        if concept is None:
            continue
        if running_apply(c, cid) is not None:
            out.append(cid)
            continue
        last = concept["applications"][-1] if concept["applications"] else {}
        paths = (glob_patterns(concept["glob"]) or _patterns(last.get("paths"))) if concept["unit"] in FILE_UNITS else []
        limit = last.get("limit") if concept["trial"] else None
        if concept["unit"] in FILE_UNITS and not paths:
            continue
        if await asyncio.to_thread(covered, c, concept, paths, limit):
            continue
        await start_apply(c, cid, paths, limit, created_by)
        cards = await asyncio.to_thread(_label_cards, ws, cid)
        tell_main(c, concept, dict(cards[0][1]) if cards else None)
        _notify(c, cid, "applying")  # the canvas reads the run record, so the card's Regenerate Card turns meanwhile
        out.append(cid)
    return out


def stale_cards(ws: Path, concept: dict) -> list[dict]:
    """Every card that read `concept` at an older revision than its own (stale_in), in the order of the groups."""
    from . import notebook

    out = []
    for info in notebook.list_notebooks(ws):
        nb = notebook.read_notebook(ws, info["id"])
        out.extend(cell for cell in (nb or {}).get("cells") or [] if stale_in(cell, {concept["id"]: concept}))
    return out


# --------------------------------------------------------------------------- the label card


def _label_cards(ws: Path, concept_id: str) -> list[tuple[dict, dict]]:
    """(notebook, cell) for every label card of the concept."""
    from . import notebook

    out = []
    for info in notebook.list_notebooks(ws):
        nb = notebook.read_notebook(ws, info["id"])
        for cell in (nb or {}).get("cells") or []:
            payload = cell.get("payload") if isinstance(cell.get("payload"), dict) else {}
            if cell.get("kind") == "label" and payload.get("concept") == concept_id:
                out.append((nb, cell))
    return out


def label_card(c: str, concept: dict, group: str | None, created_by: str, question: str | None = None) -> dict:
    """The concept's card on the canvas: a cell of kind `label` with payload {concept}, in `group` (the analyst's own group
    by default), titled with `question`, else the label's name. An existing card is kept and takes a new question when one
    is given, unless the analyst locked it."""
    from . import notebook

    ws = _ws(c)
    title = " ".join(str(question or "").split())
    for nb, cell in _label_cards(ws, concept["id"]):
        if title and cell.get("title") != title and cell.get("locked") is not True:
            cell["title"] = title
            cell["ts"] = _now()
            notebook.write_notebook(ws, nb)
        return dict(cell)
    nb = notebook.read_notebook(ws, group) if group and ID_RE.match(group) else None
    if nb is None:
        from . import tools

        nb = notebook.read_notebook(ws, tools.analyst_notebook(c))
    cell = notebook.new_cell("label", created_by, title or concept["name"], nb["id"], payload={"concept": concept["id"]})
    notebook.insert_cell(c, nb["id"], cell)
    _emit(c, {"type": "cell", "notebook": nb["id"], "cell": cell["id"], "kind": "note"})
    return dict(cell)


def _drop_label_cards(c: str, concept_id: str) -> None:
    from . import notebook

    ws = _ws(c)
    for nb, cell in _label_cards(ws, concept_id):
        nb["cells"] = [x for x in nb["cells"] if x.get("id") != cell["id"]]
        notebook.write_notebook(ws, nb)
        _emit(c, {"type": "cell", "notebook": nb["id"], "cell": cell["id"], "kind": "note", "op": "deleted"})


# --------------------------------------------------------------------------- refs hook


def resolve_concept_ref(corpus: Path | str, ref: str) -> dict:
    """Resolve `concept:<id>` to the concept card, and `concept:<id>/<value>` to one value's count as the label's card
    shows it (refs.resolve delegates here). `corpus` is the corpus dir or the workspace name. Raises refs.RefError (400
    malformed, 404 unknown)."""
    m = _CONCEPT_REF.match(str(ref or "").strip())
    if not m:
        raise refs.RefError(f"not a concept ref: {ref!r}", 400)
    name = config.workspace_for_corpus_dir(corpus) if isinstance(corpus, Path) else str(corpus)
    ws = config.WORKSPACES_DIR / name
    concept = read_concept(ws, m[1]) if ws.is_dir() else None
    if concept is None:
        raise refs.RefError(f"no concept {m[1]!r}", 404)
    card = with_stats(ws, concept)
    if m[2] and m[2].strip():
        return _resolve_value(name, card, cite.decode_label(m[2].strip()), ref)
    cal = card["calibration"]
    est = f"est. precision {card['est_precision']:.0%} on {cal['n']} reviewed" if card["est_precision"] is not None else "uncalibrated"
    counts = ", ".join(f"{k}: {v}" for k, v in sorted(card["counts"].items()))
    excerpt = f"{card['name']} ({card['kind']}, per {card['unit']}): {card['description']}".strip()
    excerpt += f"\n{card['n_labeled']} labeled" + (f" ({counts})" if counts else "") + f"; {est}"
    if _applying(name, card["id"]):
        run = _runs.get((name, card["id"])) or {}
        total = run.get("total")
        so_far = f"{run.get('done', 0):,} of {total:,}" if isinstance(total, int) else f"{run.get('done', 0):,}"
        excerpt += (f"\nan apply is running ({so_far} {card['unit']}s so far; these counts are from before it — read this "
                    f"ref again once it ends)")
    return {"ref": ref, "kind": "concept", "concept_id": card["id"], "record": card, "excerpt": excerpt[:refs.EXCERPT_MAX],
            "meta": {"name": card["name"], "kind": card["kind"], "unit": card["unit"], "n_labeled": card["n_labeled"],
                     "est_precision": card["est_precision"]}}


def label_share(count: int, total: int) -> str:
    """A value's share of the labeled units as the label card's table writes it (frontend canvas/details.labelShare):
    whole percents, one decimal at the ends (0.3%, 99.7%); '' with no total."""
    if total <= 0 or count < 0:
        return ""
    p = count / total * 100
    s = f"{p:.1f}" if 0 < p < 10 or 90 < p < 100 else str(int(Decimal(p).quantize(Decimal(1), rounding=ROUND_HALF_UP)))
    return f"{s[:-2] if s.endswith('.0') else s}%"


def _resolve_value(name: str, card: dict, value: str, ref: str) -> dict:
    """`concept:<id>/<value>`: the value's count and share among the labeled units, the numbers the label's card shows
    beside it, so a takeaway's `[[19|concept:<id>/refund request]]` is checked against the card rather than refused as
    malformed."""
    counts = card.get("counts") or {}
    values = list(dict.fromkeys([*(str(v) for v in card.get("labels") or []), *(str(v) for v in counts)]))
    if value not in values:
        raise refs.RefError(f"the label {card['name']!r} has no value {value!r}; its values are {', '.join(values) or 'none yet'}", 404)
    n = int(counts.get(value) or 0)
    total = int(card.get("n_labeled") or 0)
    unit = card["unit"]
    share = label_share(n, total)
    excerpt = f"{value}: {n:,} {unit}{'' if n == 1 else 's'}" + (f" ({share}) of the {total:,} labeled" if share else "")
    excerpt += f" by the label {card['name']}"
    if _applying(name, card["id"]):
        excerpt += "; an apply is running, so this count is from before it"
    return {"ref": ref, "kind": "concept", "concept_id": card["id"], "excerpt": excerpt[:refs.EXCERPT_MAX],
            "meta": {"name": card["name"], "kind": card["kind"], "unit": unit, "label_value": value, "count": n,
                     "shown": f"{n:,}", "n_labeled": total}}


# --------------------------------------------------------------------------- defining and applying from a tool


PREDICATE = ("kind", "unit", "description", "spec", "labels")  # what a tool's definition of a label sets


def same_definition(prior: dict, concept: dict) -> bool:
    """Whether `concept` defines what `prior` already does: the same kind, unit, predicate text and values, the texts compared
    without their surrounding whitespace."""

    def norm(k: dict, key: str) -> Any:
        v = k.get(key)
        return v.strip() if isinstance(v, str) else v

    return all(norm(prior, key) == norm(concept, key) for key in PREDICATE)


def define_concept(c: str, name: str, description: str = "", kind: str = "prompt", spec: str | None = None,
                   unit: str | None = None, labels: list[str] | None = None, created_by: str = "user", glob: str = "",
                   trial: bool = False) -> dict:
    """Create a concept. A definition under an existing name (or id) redefines it: the id stays, the version steps, the old
    labels are cleared and a running apply is stopped; how it shows in Files carries over where it fits. The same definition
    again changes nothing but the glob. `trial` makes it a trial when it is new or was one. Returns the stored concept."""
    ws = _ws(c)
    concept = new_concept(name, description, kind or "prompt", spec, unit or "record", labels, created_by, glob=glob)
    concept["trial"] = trial
    prior = find_concept(ws, concept["name"])
    if prior is not None and same_definition(prior, concept):
        # its rows cover the files it ran over before and the ones it runs over now, and so does what it applies to
        glob = ", ".join(dict.fromkeys([*glob_patterns(prior["glob"]), *glob_patterns(concept["glob"])]))
        kept = {**prior, "trial": trial and prior["trial"], "glob": glob}
        if kept != prior:
            write_concept(ws, kept)
            _notify(c, kept["id"], "changed")
        return kept
    if prior is not None:
        if prior["id"] == concept["name"]:  # named by its id, which find_concept reads first: the label keeps its name
            concept["name"] = prior["name"]
        concept["trial"] = trial and prior["trial"]
        concept["told"] = prior["told"]
        concept["id"] = prior["id"]
        concept["ts"] = prior["ts"]
        concept["version"] = int(prior.get("version") or 1) + 1
        concept["marks"] = marks_of(concept["unit"], prior.get("marks"))
        concept["classes"] = classes_of(concept["labels"], prior.get("classes"))
        concept["shown"] = bool(prior.get("shown"))
        concept["model"] = prior.get("model") or ""
        concept["glob"] = concept["glob"] or (prior.get("glob") or "")
        concept["rev"], concept["changes"] = prior["rev"], prior["changes"]
        note_change(concept, "redefined", redefined_text(prior["labels"], concept["labels"]))
        _stop_apply((c, prior["id"]))
        lf = labels_file(ws, prior["id"])
        if lf.exists():
            lf.unlink()
        labels_store.remove(lf)
        write_concept(ws, coloured(ws, concept))
        _notify(c, concept["id"], "redefined")
        return concept
    write_concept(ws, coloured(ws, concept))
    _notify(c, concept["id"], "defined")
    return concept


def covered(c: str, concept: dict, patterns: list[str], limit: int | None) -> bool:
    """Whether the label's rows already answer an apply of its definition: its last run was of this version, ended cleanly,
    and covered the same files and limit (or, for cards and sentences, every unit the scope has now). Blocking (a thread)."""
    last = concept["applications"][-1] if concept["applications"] else None
    if not last or last.get("status") != "done" or last.get("version") != concept["version"] or last.get("stopped"):
        return False
    within = concept.get("within") or None
    if (last.get("within") or None) != within or (within and last.get("within_rev") != _rev_of(_ws(c), within["label"])):
        return False
    whole = last.get("limit") is None and last.get("total") == last.get("matched_total")
    if concept["unit"] in FILE_UNITS:
        if sorted(_patterns(last.get("paths"))) != sorted(_patterns(patterns)):
            return False
        return whole or (limit is not None and last.get("limit") == limit)
    if not whole or limit is not None:
        return False
    have = {str(r.get("ref") or "").replace("cell:", "card:", 1) for r in read_labels(_ws(c), concept["id"])}
    return all(u.ref in have for u in scope_units(c, concept["unit"]))


def _live_counts(ws: Path, concept_id: str) -> dict:
    """The counts per label as the store stands (a run in progress included)."""
    try:
        st, _building_now = _store(ws, concept_id)
        return st.stats()["counts"] if st is not None else {}
    except Exception:  # noqa: BLE001
        return {}


def _follow(c: str, concept: dict) -> Callable[[Any], Any]:
    """The body of the agent chat that follows an apply: waits for the summary and reports it; stopping the agent
    cancels that apply, never a later run of the label that took its place."""
    key = (c, concept["id"])
    task = _tasks.get(key)

    async def run(rec: Any) -> str:
        try:
            s = await wait_apply(c, concept["id"], float("inf"))
        except asyncio.CancelledError:
            # also raised when the run itself was stopped, as a redefinition stops it before it starts the next run,
            # whose cancel flag this is too
            if task is not None and not task.done() and _tasks.get(key) is task:
                _cancel_event(*key).set()
            raise
        counts = ", ".join(f"{k} {v}" for k, v in sorted((s.get("counts") or {}).items()))
        line = f"labeled {s.get('labeled', 0)} of {s.get('total', 0)} {concept['unit']}(s): {counts or 'no values'}"
        if s.get("message"):
            line += f" ({s['message']})"
        rec.text(line)
        return line

    return run


async def apply_scoped(c: str, *, scope: str, name: str, kind: str, text: str, values: list[str] | None, paths: list[str] | None,
                       limit: int | None, comment: bool, filter: bool, created_by: str, chat: str | None, group: str | None,
                       question: str | None = None, card: bool = True, within: Any = None, show: bool = False) -> dict:
    """Define a label from a predicate and apply it over one scope: the concept, its card in `group` asking `question` unless
    `card` is False or the label ran before without one, the run in the background followed by an agent chat of role
    `labels`, and with `filter` the scope's filter set to the positive value. `within` {label, value?} runs a label over
    records only over the records that label gave that value (its first by default), and `show` turns a label over files on in
    Files and the views before it runs, so they draw it as it runs. A `limit` makes a new label a trial. The same
    predicate under the same name starts no run when its rows already cover the call (`unchanged: true`). Returns after
    APPLY_WAIT_S at the latest, with `stale`, the ids of cards that read the label at an older revision."""
    if scope not in SCOPES:
        raise HTTPException(400, f"scope must be one of {', '.join(SCOPES)}")
    if kind not in KINDS:
        raise HTTPException(400, f"kind must be one of {', '.join(KINDS)}")
    text = str(text or "").strip()
    if not text:
        raise HTTPException(400, "the predicate's text is required")
    unit = SCOPES[scope]
    author = f"chat:{chat}" if chat else created_by
    # what the run would refuse is refused before the label is defined, so a failed apply leaves no empty label behind
    if kind == "regex":
        _compiled({"spec": text})
    ws = _ws(c)
    if within and unit != "record":
        raise HTTPException(400, "within narrows a label over records of files")
    narrowed = resolve_within(ws, within)
    prior = find_concept(ws, name)
    if narrowed and prior is not None and prior["id"] == narrowed["label"]:
        raise HTTPException(400, f"within names the label {prior['name']!r} itself; narrow it by another label")
    sources = (await asyncio.to_thread(scope_sources, c, unit, kind, _patterns(paths), limit, bool(narrowed))
               if unit in FILE_UNITS else None)
    if narrowed and kind == "prompt" and not limit:
        lines = await asyncio.to_thread(within_lines, ws, sources or [], narrowed, PROMPT_APPLY_MAX + 1)
        if (n := sum(len(v) for v in lines.values())) > PROMPT_APPLY_MAX:
            raise HTTPException(400, within_too_wide(ws, narrowed, n))
    concept = define_concept(c, name, text if kind == "prompt" else "", kind, "" if kind == "prompt" else text, unit, values, author,
                             glob=", ".join(_patterns(paths)) if unit in FILE_UNITS else "", trial=limit is not None)
    if unit == "record" and concept.get("within") != narrowed:
        concept["within"] = narrowed
        write_concept(ws, concept)
    same = prior is not None and prior["id"] == concept["id"] and prior["version"] == concept["version"]
    if concept["told"] != concept["version"]:  # a chat defined it, so main need not hear of it (tell_main)
        concept["told"] = concept["version"]
        write_concept(ws, concept)
    # a label that ran before without a card (the orientation's) keeps having none
    cardless = (prior is not None and prior["id"] == concept["id"] and bool(prior["applications"])
                and not await asyncio.to_thread(_label_cards, ws, concept["id"]))
    made = await asyncio.to_thread(label_card, c, concept, group, author, question) if card and not cardless else None
    joined = same and running_apply(c, concept["id"]) is not None
    unchanged = same and not joined and await asyncio.to_thread(covered, c, concept, paths or [], limit)
    if show and unit in FILE_UNITS:
        show_concept(c, concept["id"], True)
    if not joined and not unchanged:
        await start_apply(c, concept["id"], paths or [], limit, author, comment=comment, sources=sources)
        try:
            from . import agents

            agents.start_agent(c, "labels", f"label {concept['name']}", _follow(c, concept))
        except Exception:  # noqa: BLE001
            log.debug("the labels agent chat was not started", exc_info=True)
    chosen = None
    if filter:
        chosen = set_filter(c, scope, concept["id"], concept["labels"][0])[scope]
        try:
            from . import agents

            agents.chip(c, "filter", f"filter {scope}: {concept['name']} = {concept['labels'][0]}", ref=f"concept:{concept['id']}",
                        scope=scope, concept=concept["id"], value=concept["labels"][0])
        except Exception:  # noqa: BLE001
            log.debug("the filter chip was not written", exc_info=True)
    if unchanged:
        result = {"total": concept["applications"][-1].get("total"), "counts": await asyncio.to_thread(_live_counts, ws, concept["id"])}
    else:
        result = await wait_apply(c, concept["id"], APPLY_WAIT_S)
    partial = bool(result.get("partial"))
    counts = result.get("counts") if not partial else await asyncio.to_thread(_live_counts, ws, concept["id"])
    stale = await asyncio.to_thread(stale_cards, ws, read_concept(ws, concept["id"]) or concept)
    return {"concept": concept["id"], "name": concept["name"], "unit": unit, "total": result.get("total"), "counts": counts or {},
            "failed": result.get("failed") or 0, "message": result.get("message"), "partial": partial,
            "cell": made["id"] if made else None, "filter": chosen, "labels_path": str(labels_file(ws, concept["id"])),
            "unchanged": unchanged, "stale": [x["id"] for x in stale]}


# the label colours by the names show_label takes (--label-1..12)
COLOUR_NAMES = {"blue": 1, "orange": 2, "green": 3, "pink": 4, "vermilion": 5, "sky blue": 6, "brown": 7, "slate blue": 8,
                "wine": 9, "olive": 10, "purple": 11, "red": 12}


def show_concept(c: str, id_or_name: str, on: bool | None, values: list[str] | None = None,
                 colours: dict[str, str] | None = None) -> dict:
    """Turn a label over files on or off in Files and the views (`shown`), which never runs it, or leave it as it is when
    `on` is None; with `values`, on highlights those values alone. `colours` gives values colours by name (COLOUR_NAMES),
    a value that had the colour taking the one it leaves, as the Labels pane's palette does. Turning it off drops a Files
    filter that names it. 404 for no such label, 400 for a label of cards or report sentences, a value it does not have
    or a colour with no name here."""
    ws = _ws(c)
    concept = find_concept(ws, id_or_name)
    if concept is None:
        names = ", ".join(repr(k["name"]) for k in list_concepts(ws)) or "none yet"
        raise HTTPException(404, f"no label {id_or_name!r}; the labels are {names}")
    if concept["unit"] not in FILE_UNITS:
        raise HTTPException(400, f"the label {concept['name']!r} is over {SCOPE_OF_UNIT[concept['unit']]} units, not files")
    wanted = [" ".join(str(v).split()) for v in (values or []) if str(v).strip()]
    painted = {" ".join(str(v).split()): " ".join(str(n).split()).lower() for v, n in (colours or {}).items()}
    unknown = [v for v in [*wanted, *painted] if v not in concept["labels"]]
    if unknown:
        raise HTTPException(400, f"the label {concept['name']!r} has no value {', '.join(map(repr, unknown))}; its values are "
                                 f"{', '.join(concept['labels'])}")
    nameless = [n for n in painted.values() if n not in COLOUR_NAMES]
    if nameless:
        raise HTTPException(400, f"no label colour is named {', '.join(map(repr, nameless))}; the colours are {', '.join(COLOUR_NAMES)}")
    if on is not None:
        concept["shown"] = bool(on)
    if on and wanted:
        for cl in concept["classes"]:
            cl["highlight"] = cl["name"] in wanted
    concept = coloured(ws, concept)
    for value, name in painted.items():
        at = next(cl for cl in concept["classes"] if cl["name"] == value)
        new, old = COLOUR_NAMES[name], at["color"]
        for cl in concept["classes"]:
            if cl is not at and cl["color"] == new:
                cl["color"] = old
        at["color"] = new
    write_concept(ws, concept)
    if on is False:
        f = read_filters(ws).get("files")
        if f and f["concept"] == concept["id"]:
            clear_filter(c, "files")
    _notify(c, concept["id"], "changed")
    return concept


LABELED_KIND = "labeled"  # the channel event that tells main of a label the analyst ran from the browser (prompts/main.md)
LABEL_DONE_KIND = "label_done"  # the channel event that tells main a label it ran finished after its call returned
_watching: set[asyncio.Task] = set()  # the tasks of tell_when_done, held until they end
SCOPE_OF_UNIT = {**{u: "files" for u in FILE_UNITS}, "cell": "canvas", "span": "report"}


def tell_when_done(c: str, concept_id: str) -> None:
    """Post `label_done` to main once the label's running apply ends: its counts, its card and the cards that read it
    while it ran (stale_cards), which main runs again. A run that fails or is stopped posts nothing."""
    from . import channel

    async def watch() -> None:
        try:
            summary = await wait_apply(c, concept_id, float("inf"))
        except HTTPException:
            return
        if summary.get("stopped"):
            return
        ws = _ws(c)
        concept = read_concept(ws, concept_id)
        if concept is None:
            return
        stale = await asyncio.to_thread(stale_cards, ws, concept)
        counts = await asyncio.to_thread(_live_counts, ws, concept_id)
        cards = await asyncio.to_thread(_label_cards, ws, concept_id)
        told = ", ".join(f"{v} {n:,}" for v, n in counts.items()) or "no values"
        text = (f"label {concept['name']} [[concept:{concept_id}]] finished: {told}. "
                + (f"Its card is [[card:{cards[0][1]['id']}]]. " if cards else "")
                + ("Cards that read it while it ran: " + ", ".join(f"[[card:{x['id']}]]" for x in stale) + "." if stale
                   else "No card read it while it ran."))
        payload = {"text": text, "name": concept["name"], "ref": f"concept:{concept_id}",
                   "card": f"card:{cards[0][1]['id']}" if cards else None,
                   "stale": ", ".join(f"card:{x['id']}" for x in stale) or None}
        try:
            channel.post(c, LABEL_DONE_KIND, payload)
        except HTTPException as e:
            log.info("%s: the %s event for concept:%s was not posted: %s", c, LABEL_DONE_KIND, concept_id, e.detail)

    task = asyncio.get_running_loop().create_task(watch(), name=f"thimble-label-done-{concept_id}")
    _watching.add(task)
    task.add_done_callback(_watching.discard)


def tell_main(c: str, concept: dict, card: dict | None) -> bool:
    """Post `labeled` to main for a label the analyst ran from the browser at a version main has not heard of (`told`), with
    its definition as the text and its name, ref, scope, classifier, values, files, card and stale cards as attributes. The
    version is marked told only once an event went out. Never raises."""
    if concept.get("told") == concept["version"]:
        return False
    from . import channel

    scope = SCOPE_OF_UNIT.get(concept["unit"], "files")
    payload = {"text": (concept["description"] if concept["kind"] == "prompt" else concept["spec"]).strip(),
               "name": concept["name"], "ref": f"concept:{concept['id']}", "scope": scope, "classifier": concept["kind"],
               "values": ", ".join(concept["labels"]), "paths": concept["glob"] if scope == "files" else None,
               "card": f"card:{card['id']}" if card else None,
               "what": "changed" if concept["told"] > 0 or concept["version"] > 1 else "defined",
               "stale": ", ".join(f"card:{x['id']}" for x in stale_cards(_ws(c), concept)) or None}
    try:
        channel.post(c, LABELED_KIND, payload)
    except HTTPException as e:
        log.debug("%s: the %s event for concept:%s was not posted: %s", c, LABELED_KIND, concept["id"], e.detail)
        return False
    except Exception:  # noqa: BLE001 — the label runs either way
        log.exception("%s: the %s event for concept:%s failed", c, LABELED_KIND, concept["id"])
        return False
    ws = _ws(c)
    stored = read_concept(ws, concept["id"])
    if stored is not None and stored["version"] == concept["version"]:
        stored["told"] = concept["version"]
        write_concept(ws, stored)
    return True



# --------------------------------------------------------------------------- routes


class ClassBody(BaseModel):
    name: str
    color: int | None = None  # 1..12 a label colour, 0 the grey of "no match"
    highlight: bool | None = None


class NewConcept(BaseModel):
    name: str
    description: str = ""
    kind: str = "prompt"
    spec: str | None = None
    unit: str = "record"
    labels: list[str] | None = None
    created_by: str = "user"
    marks: str | None = None
    glob: str = ""
    model: str = ""
    classes: list[ClassBody] | None = None
    shown: bool = False


class ConceptPatch(BaseModel):
    name: str | None = None
    description: str | None = None
    kind: str | None = None
    spec: str | None = None
    unit: str | None = None
    labels: list[str] | None = None
    marks: str | None = None     # span | record | file: a file label is of unit agent, a span or record label of unit record
    glob: str | None = None      # what it applies to, comma-separated patterns
    model: str | None = None     # the prompt kind's classifier model; '' for the labels role's
    classes: list[ClassBody] | None = None  # the values in order with their colour and highlight; the names become `labels`
    shown: bool | None = None    # on in Files


class ApplyBody(BaseModel):
    paths: list[str] = Field(default_factory=list)  # corpus-relative globs or directories (file units)
    limit: int | None = None
    comment: bool = True
    examples: bool = False  # prompt kind: carry the analyst's verdicts as few-shot examples
    created_by: str = "user"
    wait: bool = False  # true: answer with the summary once the run ends, or the run so far past APPLY_WAIT_S


class VerdictBody(BaseModel):
    ref: str
    label: str
    note: str | None = None


class FilterBody(BaseModel):
    scope: str
    concept: str
    value: str


class CardFilterBody(BaseModel):
    """The card parts of the canvas's filter (CARD_PARTS), all of them: one left out is unset."""

    kinds: list[str] = Field(default_factory=list)
    groups: list[str] = Field(default_factory=list)
    makers: list[str] = Field(default_factory=list)
    checks: list[str] = Field(default_factory=list)
    starred: bool = False
    locked: bool = False
    text: str = ""


def _summary(ws: Path, concept: dict) -> dict:
    card = with_stats(ws, concept)
    card.pop("applications", None)
    card["last_run"] = concept["applications"][-1] if concept["applications"] else None
    return card


@router.get("/ws/{c}/concepts")
def list_concepts_route(c: str) -> list[dict]:
    ws = _ws(c)
    return [_summary(ws, k) for k in list_concepts(ws)]


def _classes_in(body: list[ClassBody] | None) -> list[dict] | None:
    if body is None:
        return None
    return [{"name": " ".join(cl.name.split()), "color": cl.color, "highlight": cl.highlight} for cl in body if cl.name.strip()]


@router.post("/ws/{c}/concepts")
def create_concept_route(c: str, body: NewConcept) -> dict:
    ws = _ws(c)
    concept = new_concept(body.name, body.description, body.kind, body.spec, body.unit, body.labels, body.created_by,
                          marks=body.marks, glob=body.glob, model=body.model, classes=_classes_in(body.classes), shown=body.shown)
    write_concept(ws, coloured(ws, concept))
    _notify(c, concept["id"], "defined")
    return with_stats(ws, concept)


@router.get("/ws/{c}/concepts/{concept_id}")
async def get_concept_route(c: str, concept_id: str) -> dict:
    """The concept card with its kept run summaries."""
    ws, concept = load_concept(c, concept_id)
    return await asyncio.to_thread(with_stats, ws, coloured(ws, concept))


DEFINITION = ("description", "spec", "labels", "kind", "unit", "marks", "model")  # a change to one of these steps the version


@router.put("/ws/{c}/concepts/{concept_id}")
def update_concept_route(c: str, concept_id: str, body: ConceptPatch) -> dict:
    """Partial update; `version` steps when the definition (DEFINITION) changes, not for the name, the glob, the colours,
    the highlights or `shown`. `marks` sets the unit (MARKS_UNIT); `classes` sets the values (their names) with their
    colour and highlight. Turning a label off in Files drops a Files filter that names it."""
    ws, concept = load_concept(c, concept_id)
    before = {k: concept[k] for k in DEFINITION}
    if body.name is not None and body.name.strip():
        concept["name"] = " ".join(body.name.split())
    if body.description is not None:
        concept["description"] = body.description
    if body.kind is not None:
        if body.kind not in KINDS:
            raise HTTPException(400, f"kind must be one of {', '.join(KINDS)}")
        concept["kind"] = body.kind
    if body.unit is not None:
        if body.unit not in UNITS:
            raise HTTPException(400, f"unit must be one of {', '.join(UNITS)}")
        concept["unit"] = body.unit
    if body.marks is not None:
        if body.marks not in MARKS:
            raise HTTPException(400, f"marks must be one of {', '.join(MARKS)}")
        if concept["unit"] not in FILE_UNITS:
            raise HTTPException(400, f"marks is for labels over files; this one labels {concept['unit']}s")
        if body.marks != "file" or concept["unit"] == "record":
            concept["unit"] = MARKS_UNIT[body.marks]
    concept["marks"] = marks_of(concept["unit"], body.marks if body.marks is not None else concept["marks"])
    if body.spec is not None:
        concept["spec"] = body.spec
    if body.labels is not None:
        concept["labels"] = _labels_list(body.labels)
    classes = _classes_in(body.classes)
    if classes:
        concept["labels"] = _labels_list([cl["name"] for cl in classes])
        concept["classes"] = classes_of(concept["labels"], classes)
    else:
        concept["classes"] = classes_of(concept["labels"], concept["classes"])
    if body.glob is not None:
        concept["glob"] = ", ".join(glob_patterns(body.glob)) if concept["unit"] in FILE_UNITS else ""
    if body.model is not None:
        concept["model"] = body.model.strip()
    if body.shown is not None:
        concept["shown"] = bool(body.shown)
    if {k: concept[k] for k in DEFINITION} != before:
        concept["version"] += 1
    if any(concept[k] != before[k] for k in DEFINITION if k != "marks") or concept["unit"] != before["unit"]:
        # the label a card counted by is not the one defined now; what a label over files marks in the reader changes nothing a
        # card reads
        note_change(concept, "redefined", redefined_text(before["labels"], concept["labels"]))
    write_concept(ws, coloured(ws, concept))
    if body.shown is False:
        f = read_filters(ws).get("files")
        if f and f["concept"] == concept_id:
            clear_filter(c, "files")
    _notify(c, concept_id, "changed")
    return with_stats(ws, concept)


@router.delete("/ws/{c}/concepts/{concept_id}")
async def delete_concept_route(c: str, concept_id: str) -> dict:
    """Delete the concept, its labels, its card, any filter naming it and its run state; an apply in progress ends first."""
    ws, concept = load_concept(c, concept_id)
    task = _stop_apply((c, concept_id))
    if task is not None:
        try:
            await task
        except (asyncio.CancelledError, Exception):  # noqa: BLE001
            pass
    _concept_file(ws, concept_id).unlink(missing_ok=True)
    labels_file(ws, concept_id).unlink(missing_ok=True)
    labels_store.remove(labels_file(ws, concept_id))
    _runs.pop((c, concept_id), None)
    _cancels.pop((c, concept_id), None)
    _clear_filters_of(c, concept_id)
    await asyncio.to_thread(_drop_label_cards, c, concept_id)
    _notify(c, concept_id, "deleted")
    return {"ok": True}


@router.post("/ws/{c}/concepts/{concept_id}/apply")
async def apply_route(c: str, concept_id: str, body: ApplyBody, response: Response) -> dict:
    """Start an apply: 202 with the run record (409 while one runs), or with `wait: true` the summary once the run ends (202
    with `partial: true` past APPLY_WAIT_S). File units run over `paths`, else the label's glob. The label is the analyst's:
    a new label gets its card, and main hears of a version it has not heard of (tell_main)."""
    ws, concept = load_concept(c, concept_id)
    paths = _patterns(body.paths) or (glob_patterns(concept["glob"]) if concept["unit"] in FILE_UNITS else [])
    if concept["unit"] in FILE_UNITS and not paths:
        raise HTTPException(400, "paths is required: corpus-relative globs or a directory (e.g. ['*/board.jsonl'], 'agents'; '*' is the whole dataset)")
    ran_before = bool(concept["applications"])
    record = await start_apply(c, concept_id, paths, body.limit, body.created_by, comment=body.comment, examples=body.examples)
    # the browser is the analyst: their label gets its card and main hears of it; a label that ran before without a card
    # keeps having none
    cards = await asyncio.to_thread(_label_cards, ws, concept_id)
    card = dict(cards[0][1]) if cards else None
    if card is None and not ran_before:
        card = await asyncio.to_thread(label_card, c, concept, None, body.created_by)
    tell_main(c, concept, card)  # on the loop: the channel's queues are the loop's
    if not body.wait:
        response.status_code = 202
        return record
    result = await wait_apply(c, concept_id, APPLY_WAIT_S)
    if result.get("partial"):
        response.status_code = 202
    return result


@router.get("/ws/{c}/concepts/{concept_id}/apply/runs")
def apply_runs_route(c: str, concept_id: str) -> list[dict]:
    """The concept's run record this server knows: the running one, else the last one that ended here."""
    load_concept(c, concept_id)
    state = _runs.get((c, concept_id))
    return [state] if state else []


@router.post("/ws/{c}/concepts/{concept_id}/apply/cancel")
def cancel_apply_route(c: str, concept_id: str) -> dict:
    """Stop the concept's running apply after the current unit, chunk or batch; the rows written so far stay."""
    load_concept(c, concept_id)
    state = _runs.get((c, concept_id))
    running = bool(state and state.get("status") == "running")
    if running:
        _cancel_event(c, concept_id).set()
    return {"ok": True, "cancelling": running}


@router.get("/ws/{c}/concepts/{concept_id}/events")
async def events_route(c: str, concept_id: str) -> EventSourceResponse:
    """SSE: the current run state first (if any), then `progress` events and a final `done`."""
    load_concept(c, concept_id)
    q = _subscribe(c, concept_id)

    async def gen():
        try:
            state = _runs.get((c, concept_id))
            if state is not None:
                yield {"event": "done" if state["status"] in ("done", "error") else "progress", "data": json.dumps(state)}
            while True:
                event, data = await q.get()
                yield {"event": event, "data": data}
        finally:
            _unsubscribe(c, concept_id, q)

    return EventSourceResponse(gen(), ping=15, ping_message_factory=lambda: ServerSentEvent(data="{}", event="ping"))


@router.post("/ws/{c}/concepts/{concept_id}/labels")
def verdict_route(c: str, concept_id: str, body: VerdictBody) -> dict:
    ws, concept = load_concept(c, concept_id)
    row, concept = record_verdict(ws, concept, body.ref, body.label, body.note)
    _notify(c, concept_id, "changed")  # its revision stepped, so the cards that count by it show they are stale
    out = {"row": row, "calibration": concept["calibration"]}
    if index_building(ws, concept_id):
        out["building"] = True
        out["note"] = INDEX_BUILDING
    return out


def parse_lines(lines: str | None) -> tuple[int, int] | None:
    """`?lines=a-b` (1-based, inclusive) as (a, b); None when absent; 400 for anything else."""
    if lines is None or not lines.strip():
        return None
    m = re.fullmatch(r"\s*(\d+)\s*-\s*(\d+)\s*", lines)
    if not m or int(m[1]) < 1 or int(m[2]) < int(m[1]):
        raise HTTPException(400, "lines must be a range a-b of 1-based line numbers with a <= b, e.g. lines=1-500")
    return int(m[1]), int(m[2])


@router.get("/ws/{c}/concepts/{concept_id}/labels")
def labels_route(c: str, concept_id: str, path: str | None = None, lines: str | None = None) -> dict:
    """Latest label per ref (with the analyst's verdict); `?path=` narrows to one file, `&lines=a-b` to the rows on
    those lines of it (plus its whole-file rows), which is what a reader showing one page asks for."""
    ws, concept = load_concept(c, concept_id)
    span = parse_lines(lines)
    if span is not None and path is None:
        raise HTTPException(400, "lines needs path: the range is of one file's lines")
    out = {"concept": {"id": concept["id"], "name": concept["name"], "labels": concept["labels"], "unit": concept["unit"]},
           "rows": rows_for_path(ws, concept_id, path, span)}
    if index_building(ws, concept_id):
        out["building"] = True
        out["note"] = INDEX_BUILDING
    return out


@router.get("/ws/{c}/concepts/{concept_id}/coverage")
async def coverage_route(c: str, concept_id: str) -> dict:
    """{unit, files: [{path, covered, rows}], not_covered}: which corpus files the label's rows cover (file units)."""
    ws, concept = load_concept(c, concept_id)
    return await asyncio.to_thread(coverage, ws, concept)


@router.get("/ws/{c}/concepts/{concept_id}/rows")
async def rows_route(c: str, concept_id: str, value: str | None = None, limit: int = ROWS_LIMIT, offset: int = 0, text: bool = False,
                     after: int | None = None) -> dict:
    """{rows: [{ref, label, confidence, rationale, analyst, spans?}], total, next}: one page of the concept's labeled units,
    those with the effective value `value` when given. Pages by rowid key-set (`next` passed back as `after`; `offset` when
    no cursor is given). `text=1` adds each row's text or match window (concept_rows)."""
    ws, concept = load_concept(c, concept_id)
    texts = partial(unit_texts, c, concept) if text else None
    return await asyncio.to_thread(concept_rows, ws, concept_id, value.strip() if value is not None and value.strip() else None,
                                   max(1, min(int(limit), ROWS_MAX)), max(0, int(offset)), texts, after)


@router.get("/ws/{c}/labels")
def all_labels_route(c: str, path: str, lines: str | None = None) -> list[dict]:
    """Every concept's rows on one file in a single request (the reader opens one file, many concepts); `&lines=a-b`
    keeps the rows on those lines (the reader's page) plus the file's whole-file rows."""
    ws = _ws(c)
    span = parse_lines(lines)
    out = []
    for concept in list_concepts(ws):
        rows = rows_for_path(ws, concept["id"], path, span)
        if rows:
            out.append({"concept_id": concept["id"], "name": concept["name"], "labels": concept["labels"], "unit": concept["unit"],
                        "created_by": concept.get("created_by"), "rows": rows,
                        **({"building": True, "note": INDEX_BUILDING} if index_building(ws, concept["id"]) else {})})
    return out


PRESENCE_CACHE: dict[Path, tuple[tuple[int, int] | None, dict]] = {}  # labels file -> (its key, the store's presence)
RULER_BINS = 400      # the overview ruler's resolution by default
GLOB_LISTED = 200     # files the glob route lists


def _presence(ws: Path, concept_id: str) -> dict[str, dict[str, int]]:
    """{path: {value: n}} for one concept, from the store, kept until the labels file changes."""
    lf = labels_file(ws, concept_id)
    key = labels_store.file_key(lf)
    hit = PRESENCE_CACHE.get(lf)
    if hit is not None and hit[0] == key:
        return hit[1]
    st, _building_now = _store(ws, concept_id)
    out = st.presence() if st is not None else {}
    PRESENCE_CACHE[lf] = (key, out)
    return out


@router.get("/ws/{c}/labels/presence")
def presence_route(c: str) -> list[dict]:
    """[{concept_id, paths: {path: {value: n}}}]: for every label over files, the values it left on each file, which
    the files tree turns into a dot per label that is on (a stripe for a file label)."""
    ws = _ws(c)
    return [{"concept_id": k["id"], "paths": _presence(ws, k["id"])} for k in list_concepts(ws) if k["unit"] in FILE_UNITS]


@router.get("/ws/{c}/labels/ruler")
def ruler_route(c: str, path: str, bins: int = RULER_BINS) -> dict:
    """{path, total, bins, labels: [{concept_id, bins: {value: [bin, ...]}}]}: where on one file each label's values
    fall, its `total` lines cut into `bins`, for the reader's overview ruler. Labels without rows on the file are left
    out."""
    ws = _ws(c)
    bins = max(1, min(int(bins), 2_000))
    try:
        corpus_dir = config.corpus_dir(c)
        p = config.safe_corpus_path(corpus_dir, path)
        # a binary file has no lines to mark, and counting its newlines would read every byte of it
        if corpus.sniff_binary(p):
            return {"path": path, "total": 0, "bins": bins, "labels": []}
        total = corpus.line_count(p)
    except (ValueError, OSError) as e:
        raise HTTPException(404, str(e)) from e
    out = []
    for k in list_concepts(ws):
        if k["unit"] != "record":
            continue
        st, _building_now = _store(ws, k["id"])
        got = st.line_bins(path, total, bins) if st is not None else {}
        if got:
            out.append({"concept_id": k["id"], "bins": got})
    return {"path": path, "total": total, "bins": bins, "labels": out}


@router.get("/ws/{c}/labels/glob")
def glob_route(c: str, pattern: str = "") -> dict:
    """{files: [path, ...], total}: the corpus files a label's glob (comma-separated patterns) applies to, the first
    GLOB_LISTED of them."""
    try:
        corpus_dir = config.corpus_dir(c)
    except ValueError as e:
        raise HTTPException(404, str(e)) from e
    found = match_paths(corpus_dir, glob_patterns(pattern))
    return {"files": [s["path"] for s in found[:GLOB_LISTED]], "total": len(found)}


# --------------------------------------------------------------------------- a label from a description

SAMPLE_RECORDS = 6     # records of the first file a draft reads
SAMPLE_CUT = 700       # characters of each of them
DRAFT_OVER = {"files": "files", "canvas": "cards", "report": "sentences"}  # a draft's scope as the edit card's Over


class DraftBody(BaseModel):
    text: str = ""
    paths: list[str] = Field(default_factory=list)  # the globs the label would apply to (the open file, a view's claims)


def sample_records(c: str, paths: list[str]) -> dict[str, str]:
    """The slots of labels.md's `records` part for a draft: the files the globs name (the first few and how many), the
    first of them and its first SAMPLE_RECORDS non-empty lines, each cut at SAMPLE_CUT characters. Empty `lines` when no
    file matches or the first is binary. Blocking (a thread)."""
    corpus_dir = config.corpus_dir(c)
    found = match_paths(corpus_dir, _patterns(paths)) if paths else []
    if not found:
        return {"paths": "no file yet", "path": "", "cut": str(SAMPLE_CUT), "lines": ""}
    names = ", ".join(s["path"] for s in found[:5]) + (f" and {len(found) - 5} more files" if len(found) > 5 else "")
    first = found[0]["path"]
    p = config.safe_corpus_path(corpus_dir, first)
    lines: list[str] = []
    if not corpus.sniff_binary(p):
        with open(p, "rb") as f:
            for raw in f:
                text = corpus.decode_line(raw.rstrip(b"\r\n")).strip()
                if text:
                    lines.append(text[:SAMPLE_CUT])
                if len(lines) >= SAMPLE_RECORDS:
                    break
    return {"paths": names, "path": first, "cut": str(SAMPLE_CUT), "lines": "\n".join(lines)}


def draft_tool() -> Any:
    """A label as Label from prompt applies it: the model.ToolSpec of a draft's output."""
    from . import model

    return model.ToolSpec(
        name="label",
        description="Define the label the analyst described.",
        input_schema={
            "type": "object",
            "properties": {
                "name": {"type": "string"},
                "scope": {"type": "string", "enum": list(SCOPES)},
                "kind": {"type": "string", "enum": ["regex", "code", "prompt"]},
                "text": {"type": "string", "description": "The pattern, the function or the definition."},
                "values": {"type": "array", "items": {"type": "string"}, "minItems": 2},
                "marks": {"type": "string", "enum": list(MARKS)},
            },
            "required": ["name", "scope", "kind", "text", "values"],
            "additionalProperties": False,
        },
    )


def draft_of(output: dict | None, paths: list[str]) -> dict:
    """The draft Label from prompt turns into a label, from the `label` tool's output: {name, over, marks, glob, kind,
    text, values}; a regex that does not compile is 422, since nothing could run it."""
    out = output or {}
    scope = out.get("scope") if out.get("scope") in SCOPES else "files"
    kind = out.get("kind") if out.get("kind") in KINDS else "prompt"
    values = [" ".join(str(v).split()) for v in (out.get("values") or []) if str(v).strip()] or list(DEFAULT_LABELS)
    if len(values) < 2:
        values.append("no match" if values[0] != "no match" else "match")
    text = str(out.get("text") or "").strip()
    if not text:
        raise HTTPException(422, "the labels model gave the label no pattern, function or definition")
    if kind == "regex":
        try:
            re.compile(text)
        except re.error as e:
            raise HTTPException(422, f"the labels model gave a regex that does not compile ({e}): {text}") from e
    marks = out.get("marks") if out.get("marks") in MARKS else "span"
    return {"name": " ".join(str(out.get("name") or "").split())[:80] or "new label", "over": DRAFT_OVER[scope],
            "marks": marks if scope == "files" else None, "glob": ", ".join(_patterns(paths)) if scope == "files" else "",
            "kind": kind, "text": text, "values": values[:8]}


async def _labels_call(c: str, prompt: str, tool: Any) -> Any:
    """One structured call of the labels role (never raises; read the CallResult's status)."""
    from . import model

    model_name, effort = labels_model(c)
    with capture.scope("concepts draft", keep=True):
        return await model.structured(prompt, tool=tool, model=model_name, effort=effort, cwd=config.corpus_dir(c))


def _call_failed(call: Any) -> HTTPException:
    """A labels call that gave no output, as the error the bar shows: 429 at capacity, else 502 with its detail."""
    status = 429 if call.status == "rate_limited" else 502
    return HTTPException(status, f"the labels model gave no label ({call.status}): {call.detail or 'no detail'}")


@router.post("/ws/{c}/concepts/draft")
async def draft_route(c: str, body: DraftBody) -> dict:
    """Label from prompt, the new-label card's top row: the labels model defines a label from the analyst's description
    (labels.md `draft`), reading the first records of the files it would apply to, and the route answers the draft
    (draft_of) without storing anything. 400 for an empty description; 422 for a draft that could not run; 429 or 502 when
    the call gave none."""
    text = " ".join(body.text.split())
    if not text:
        raise HTTPException(400, "describe the label")
    try:
        records = await asyncio.to_thread(sample_records, c, body.paths)
    except ValueError as e:
        raise HTTPException(404, str(e)) from e
    prompt = labels_part("draft", description=text, records=labels_part("records", **records) if records["lines"] else "")
    call = await _labels_call(c, prompt, draft_tool())
    if call.status != "ok":
        raise _call_failed(call)
    return draft_of(call.output, body.paths)


@router.get("/ws/{c}/filters")
def filters_route(c: str) -> dict:
    return read_filters(_ws(c))


@router.put("/ws/{c}/filters")
def set_filter_route(c: str, body: FilterBody) -> dict:
    """The scope's label filter; the canvas's card parts stay."""
    return set_filter(c, body.scope, body.concept, body.value)


@router.put("/ws/{c}/filters/canvas/cards")
def set_card_filter_route(c: str, body: CardFilterBody) -> dict:
    """The canvas filter's card parts, all at once; its label part stays."""
    return set_card_filter(c, body.model_dump())


@router.delete("/ws/{c}/filters/{scope}")
def clear_filter_route(c: str, scope: str, whole: bool = False) -> dict:
    """The scope's label filter, and with `whole=true` the canvas's card parts too."""
    return clear_filter(c, scope, whole=whole)
