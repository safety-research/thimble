"""Cell verification: the linking check every code cell goes through after it runs, stored on the cell as
`verification {exec_count, links, attempts, note, status}`. A deterministic pass links a takeaway's numbers to the
places the outputs show them, and a job then checks every value ref by execution, heals moved ones and records what
is
linked, quiet or broken. No model runs here."""
from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import re
import time
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException

from . import cite, config, heal, investigation, jobs, notebook, refs, undo

log = logging.getLogger("thimble.verify")
router = APIRouter()

ERROR_MIME = notebook.ERROR_MIME
# THIMBLE_SKIP_KEY=1 is the tests' switch: the hooks still link deterministically, but no links job is enqueued and
# nothing is rescanned at start; a test that wants the job sets CHECK_JOBS = True.
CHECK_JOBS = os.environ.get("THIMBLE_SKIP_KEY") != "1"

# ----------------------------------------------------------------------------------------------------------
# settings and the record
# ----------------------------------------------------------------------------------------------------------


def _fresh(cell: dict) -> dict:
    return {"exec_count": cell.get("exec_count"), "links": None, "attempts": 0, "note": None, "status": "ok"}


def _summarise(v: dict) -> dict:
    """`status`, the record's one-word state: checking while a stage is pending, failed when the links check did not
    finish, else ok. Numbers the outputs do not show leave the status ok and are named under `links.unresolved`."""
    links = v.get("links") if isinstance(v.get("links"), dict) else {}
    if links.get("status") == "pending":
        v["status"] = "checking"
    elif links.get("status") == "failed":
        v["status"] = "failed"
    else:
        v["status"] = "ok"
    return v


def _has_output(cell: dict) -> bool:
    for b in cell.get("outputs") or []:
        if not isinstance(b, dict):
            continue
        if any(k != "text/plain" and "/" in k for k in b):
            return True
        tp = b.get("text/plain")
        tp = "".join(map(str, tp)) if isinstance(tp, list) else tp
        if isinstance(tp, str) and tp.strip():
            return True
    return False


def _runnable(cell: dict) -> bool:
    from . import notebook  # lazy

    return notebook.runnable(cell) and cell.get("status") == "ok" and _has_output(cell)


# ----------------------------------------------------------------------------------------------------------
# the hooks (called by notebook._verify_hook before the notebook is written)
# ----------------------------------------------------------------------------------------------------------


def on_cell_ran(c: str, nb: dict, cell: dict) -> None:
    """A cell finished running: a fresh record for this `exec_count` and, when the cell keeps a takeaway, the deterministic
    links redone against the new outputs with the links job queued for what is left to check."""
    cell.pop("presentation", None)
    v = _fresh(cell)
    if str(cell.get("takeaway") or "").strip():
        # the fresh record goes on the cell before the links are redone: _link_now's enqueue reads the job's version
        # (_links_version) off the cell, and a stale record would queue a version the fresh record does not match
        cell["verification"] = v
        _link_now(c, cell, v, rerun=True)
    cell["verification"] = _summarise(v)


def on_takeaway(c: str, nb: dict, cell: dict) -> None:
    """A takeaway landed (the `takeaway` tool, the browser's edit): the deterministic pass rewrites its numbers into
    value refs in place and the links job is queued for what remains to check."""
    v = cell.get("verification") if isinstance(cell.get("verification"), dict) else None
    if v is None or v.get("exec_count") != cell.get("exec_count"):
        on_cell_ran(c, nb, cell)  # a cell this module has not seen for its current run: the whole record
        return
    _link_now(c, cell, v)
    cell["verification"] = _summarise(v)


def _link_now(c: str, cell: dict, v: dict, *, rerun: bool = False) -> None:
    """cite.resolve over the takeaway (deterministic): the annotated text replaces the takeaway, links and unsourced
    numbers
    are recorded, and the job is queued unless there is nothing to check."""
    cid = str(cell.get("id") or "")
    text = cite.quote_refs(cell, str(cell.get("takeaway") or ""))
    if not text.strip() or not cid:
        v["links"] = None
        return
    try:
        ws = config.workspace_dir(c)
        outputs = notebook.hydrate_outputs(ws, cell.get("outputs")) if cell.get("outputs") else []
        res = cite.resolve(cid, text, outputs, keep_stale=True)
    except Exception:  # noqa: BLE001 — a resolver problem leaves the takeaway as written
        log.exception("verify: cite.resolve failed for cell %s", cid)
        v["links"] = {"status": "unchecked", "resolved": [], "unresolved": [], "broken": [], "checked": False,
                      "note": "the number resolver failed; the takeaway stands as written"}
        return
    cell["takeaway"] = res.annotated
    # a value ref re-pointed at the one place in this cell that holds its value keeps the place the text cited (`from`),
    # so the chip says the value was found elsewhere
    resolved = [{"value": l.token, "ref": l.ref, "tier": l.tier, **({"how": heal.CELL, "from": res.moved[(l.token, l.ref)]} if (l.token, l.ref) in res.moved else {})}
                for l in res.links]
    unresolved = list(dict.fromkeys(res.unresolved))
    quiet = [{"value": l.token, "ref": l.ref, "why": heal.WHY_GONE.format(value=l.token) if rerun else heal.WHY_MOVED, "gone": rerun}
             for l in res.stale]
    links = {"status": "pending", "resolved": resolved, "unresolved": unresolved, "broken": [], "quiet": quiet, "checked": False}
    if not CHECK_JOBS:  # the deterministic verdict stands as the record; nothing is checked by execution
        links["status"] = _links_status(resolved, unresolved, [], _numbers(res.annotated) or resolved or quiet, quiet=quiet)
        v["links"] = links
        return
    if not unresolved and not quiet and not _value_refs(res.annotated) and not _bare_refs(res.annotated):
        links["status"] = "unchecked" if not _numbers(res.annotated) else "ok"
        links["checked"] = True
        v["links"] = links
        return
    v["links"] = links
    if _runnable(cell) or _value_refs(res.annotated) or _bare_refs(res.annotated):
        _enqueue_links(c, cell, _links_version(cell))
    else:  # an errored or silent cell with numbers in its takeaway: nothing here can vouch for them
        links["status"] = _links_status(resolved, unresolved, [], True)
        links["checked"] = True


def _links_version(cell: dict) -> str:
    """The links job's version: the run, the takeaway's text, and the relink count (`_relink`), so a relink is a new
    job."""
    h = hashlib.sha1(str(cell.get("takeaway") or "").encode("utf-8", "surrogatepass")).hexdigest()[:10]
    v = cell.get("verification") if isinstance(cell.get("verification"), dict) else {}
    n = v.get("relinks") if isinstance(v.get("relinks"), int) and not isinstance(v.get("relinks"), bool) else 0
    return f"{cell.get('exec_count')}:{h}" + (f":r{n}" if n > 0 else "")


def _enqueue_links(c: str, cell: dict, version: str) -> bool:
    cid = str(cell.get("id") or "")
    # The job's repair of the takeaway runs in a worker outside the tool call, so it takes the undo batch the call was
    # in
    # (undo.py, batches).
    batch = undo.current_batch()

    async def job() -> None:
        with undo.batching(batch):
            await _links_job(c, cid, version)

    return jobs.enqueue("links", f"card:{cid}", version, job, workspace=c,
                        on_failed=lambda note: _links_failed(c, cid, version, note))


# ----------------------------------------------------------------------------------------------------------
# storage helpers (jobs run on the loop; the notebook cache is theirs to use)
# ----------------------------------------------------------------------------------------------------------


def _save_cell(c: str, cid: str, mutate) -> dict | None:
    """Locate the cell, apply `mutate(cell)` (False from it = do not write), write the notebook, return the cell."""
    ws = config.workspace_dir(c)
    hit = notebook._locate(ws, cid)
    if hit is None:
        return None
    nb, cell = hit
    if mutate(cell) is False:
        return None
    notebook.write_notebook(ws, nb)
    return cell


def _emit_cell(c: str, cell: dict | None, kind: str) -> None:
    """The per-notebook SSE (the whole cell) and the workspace stream's `cell {kind}`; loop thread only, never raises."""
    if cell is None:
        return
    try:
        notebook._emit(c, cell)
    except Exception:  # noqa: BLE001
        log.debug("verify: notebook emit failed", exc_info=True)
    try:
        investigation.emit(c, "main", {"type": "cell", "notebook": cell.get("notebook"), "cell": cell.get("id"),
                                       "kind": kind})
    except Exception:  # noqa: BLE001 — off the loop, or a workspace without a stream: the cell carries the state
        log.debug("verify: workspace event %s for cell %s not emitted", kind, cell.get("id"), exc_info=True)


# ----------------------------------------------------------------------------------------------------------
# values, refs, shapes
# ----------------------------------------------------------------------------------------------------------


def _value_ref_spans(text: str) -> list[tuple[str, str, int, int]]:
    """[(display, ref, start, end)] for every [[display|ref]] in `text`, with the token's place (kept local rather than
    importing report.py)."""
    out: list[tuple[str, str, int, int]] = []
    for m in refs._BRACKETS.finditer(text or ""):
        inner = m.group(1)
        if "|" in inner:
            display, ref = inner.split("|", 1)
            if display.strip() and ref.strip():
                out.append((display.strip(), ref.strip(), m.start(), m.end()))
    return out


def _value_refs(text: str) -> list[tuple[str, str]]:
    """[(display, ref)] for every [[display|ref]] in `text`."""
    return [(d, r) for d, r, _, _ in _value_ref_spans(text)]


def _numbers(text: str) -> list[str]:
    """The number tokens outside [[…]] markup (what linking is about)."""
    out: list[str] = []
    pos = 0
    for m in cite._SPAN_RE.finditer(text or ""):
        out += cite._NUM_RE.findall(text[pos:m.start()])
        pos = m.end()
    out += cite._NUM_RE.findall((text or "")[pos:])
    return out


def _unlinked(text: str) -> list[str]:
    """The numbers outside [[…]] markup, one per token as written (`29` and `29.0` are two): what a finished
    deterministic
    pass lists under `unresolved`."""
    return list(dict.fromkeys(_numbers(text)))


def _value_matches(display: str, excerpt: str, *, decrease: bool = False) -> bool:
    """cite.value_in: a numeric display must cite a whole number token of the excerpt, the same value or with only its
    shown
    decimals dropped; a non-numeric display is a comma-insensitive substring check."""
    return cite.value_in(display, excerpt, decrease=decrease)


WHY_SPAN_MISSING = "the cited line or table value is not in this output"
WHY_VALUE = "the value is not at this reference"
# the quiet mark of a citation a re-run left with nothing to point at
WHY_GONE = heal.WHY_GONE


async def _ref_check(corpus: Path, ref: str, display: str | None, *, decrease: bool = False) -> str | None:
    """Verification by execution: None when the ref resolves (and, with a `display`, its excerpt shows the value); else
    why not,
    in the resolver's words."""
    try:
        out = await asyncio.to_thread(refs.resolve, corpus, ref)
    except refs.RefError as e:
        return f"{'not found' if e.status == 404 else 'malformed'} ({e.status}): {e.detail}"
    except Exception as e:  # noqa: BLE001 — the resolver itself failed
        return f"could not be checked: {type(e).__name__}: {e}"
    if (out.get("meta") or {}).get("span_missing"):
        return WHY_SPAN_MISSING
    if display is not None and not _value_matches(display, str(out.get("excerpt") or ""), decrease=decrease):
        return WHY_VALUE
    return None


def _bare_refs(text: str) -> list[str]:
    """The `[[ref]]` tokens without a value (a citation of a whole cell, a file line), in order, deduplicated."""
    out: list[str] = []
    for m in refs._BRACKETS.finditer(text or ""):
        inner = m.group(1).strip()
        if "|" not in inner and inner and inner not in out:
            out.append(inner)
    return out


# ----------------------------------------------------------------------------------------------------------
# material
# ----------------------------------------------------------------------------------------------------------


def table_address(cell_id: str, out: int) -> str:
    """The header of a table output in what a model reads (`[out<i>: table — …]`): values are cited by column header and
    row
    label."""
    return f"[out{out}: table — cite a value by its column header and row label: card:{cell_id}#<column>/<row>]"


# ----------------------------------------------------------------------------------------------------------
# the jobs
# ----------------------------------------------------------------------------------------------------------


async def _links_job(c: str, cid: str, version: str) -> None:
    cell = notebook.get_cell(c, cid, full_outputs=True)
    if cell is None or _links_version(cell) != version:
        return  # the takeaway or the run changed meanwhile: its own job runs
    version = _links_version(cell)
    t0 = time.monotonic()
    raw = str(cell.get("takeaway") or "")
    # the markdown-link hybrid `[[48]](cell:…)` read as `[[48|cell:…]]` and a lone `[[48]]` as the number 48, for a
    # takeaway
    # rescanned at start
    text = cite.quote_refs(cell, cite.qualify_bare_spans(cid, cite.normalise_markup(raw)))
    v = cell.get("verification") if isinstance(cell.get("verification"), dict) else {}
    stored = v.get("links") if isinstance(v.get("links"), dict) else {}
    corpus = config.corpus_dir(c)
    ws = config.workspace_dir(c)
    stored_by = {(l.get("value"), l.get("ref")): l for l in stored.get("resolved") or [] if isinstance(l, dict)}
    tiers = {k: l.get("tier") for k, l in stored_by.items()}
    # the refs a re-run orphaned (_link_now(rerun=True) listed them quiet with their cause): the healing pass looks for
    # their values elsewhere and, finding nothing, marks them "was <v> in an earlier run"
    gone = {(q.get("value"), q.get("ref")) for q in stored.get("quiet") or [] if isinstance(q, dict) and q.get("gone")}
    # value refs that are not cells (a file line, a db row) are checked by execution here, one verdict per (value, ref) —
    # two values cited at one line are two checks; the pass reads the verdicts
    external: dict[tuple[str, str], Any] = {}
    for display, ref, start, end in _value_ref_spans(text):
        if cite.is_card_ref(ref) or (display, ref) in external:
            continue
        why = await _ref_check(corpus, ref, display, decrease=cite.says_decrease(text, start, end))
        if why == WHY_VALUE:
            external[(display, ref)] = {"why": why, "source": await _source_at(corpus, ref)}
        else:
            external[(display, ref)] = why

    def load(x: str) -> dict | None:
        return cell if x == cid else notebook.get_cell(c, x, full_outputs=True)

    def whole_notebook() -> list[dict]:
        cells: list[dict] = []
        for info in notebook.list_notebooks(ws):
            nb = notebook.read_notebook(ws, info["id"])
            cells += [x for x in (nb or {}).get("cells") or [] if isinstance(x, dict)]
        return heal.newest_first(cells)

    relinks = v.get("relinks") if isinstance(v.get("relinks"), int) and not isinstance(v.get("relinks"), bool) else 0
    prior = stored.get("healed") if isinstance(stored.get("healed"), dict) else {}
    analyst = not heal.is_ai_author(cell.get("takeaway_author"))
    healed = await heal.heal(text, load=load, notebook=whole_notebook, analyst=analyst, external=external,
                             gone=gone, prior=prior.get("changes") or (), cache=heal.Cache())
    text = healed.text
    resolved: list[dict] = []
    broken: list[dict] = []
    quiet: list[dict] = []
    for ch in healed.changes:
        if ch.state == heal.LINKED:
            entry = {"value": ch.value, "ref": ch.to or ch.ref, "tier": ch.tier or tiers.get((ch.value, ch.ref), 0) or 0}
            if ch.how != heal.KEPT:
                entry["how"] = ch.how
                if ch.to and ch.to != ch.ref:
                    entry["from"] = ch.ref  # the place the text cited: the chip says the value was found elsewhere
            else:
                old = stored_by.get((ch.value, ch.to or ch.ref))
                if isinstance(old, dict) and old.get("from"):  # the hook (_link_now) moved it before the job: the move stays on record
                    entry["how"], entry["from"] = old.get("how") or heal.CELL, old["from"]
            resolved.append(entry)
        elif ch.state == heal.CONTRADICTED:
            shown = heal._corrected_display(ch.value, ch.source or "") if ch.corrected else None
            entry = {"value": shown or ch.value, "ref": ch.to or ch.ref, "tier": tiers.get((ch.value, ch.ref), 0) or 0,
                     "why": ch.why, "source": ch.source}
            if ch.corrected:
                entry.update(was=ch.was, corrected=True)
            broken.append(entry)
        elif ch.state == heal.QUIET and ch.to:
            # kept where it stands with no home (the analyst's own token): the grey chip, the hover naming the cause
            quiet.append({"value": ch.value, "ref": ch.to, "why": ch.why or heal.WHY_NO_HOME})
    for ref in _bare_refs(text):  # a citation with no value has to resolve, and is grey when it does not
        why = await _ref_check(corpus, ref, None)
        if why is not None:
            quiet.append({"value": None, "ref": ref, "why": why})
    unresolved = [t for t in (stored.get("unresolved") or []) if isinstance(t, str)] or _unlinked(text)
    if text != raw:  # tokens were put right or unwrapped: what is unlinked is read off the text as it stands
        unresolved = _unlinked(text)
    still = unresolved  # a number no output shows stays unlinked, for the agent that wrote the takeaway to cite
    # a re-run's orphan that found no home keeps its cause on the grey mark ("was 44 in an earlier run")
    changes = [ch.record() for ch in healed.changes if ch.how != heal.KEPT]
    links = {"status": _links_status(resolved, still, broken, _numbers(text) or resolved, quiet=quiet), "resolved": resolved,
             "unresolved": still, "broken": broken, "quiet": quiet, "checked": True,
             "healed": {"version": heal.version(text, [x for x in (load(i) for i in heal.cited_cell_ids(text)) if x]),
                        "relinks": relinks, "changes": changes, "ms": int((time.monotonic() - t0) * 1000)}}

    def mutate(cell: dict) -> bool:
        if _links_version(cell) != version:
            return False
        cell["takeaway"] = text
        rec = cell.get("verification")
        if not isinstance(rec, dict) or rec.get("exec_count") != cell.get("exec_count"):
            rec = _fresh(cell)
            cell["verification"] = rec
        rec["links"] = links
        _summarise(rec)
        return True

    saved = _save_cell(c, cid, mutate)
    if saved is None:
        return
    _emit_cell(c, saved, "verified")


def _links_status(resolved: list, unresolved: list, broken: list, had_numbers: Any, quiet: list | None = None) -> str:
    """The word for a finished check from its counts: unchecked, ok, partial or unresolved."""
    if not resolved and not unresolved and not broken and not quiet and not had_numbers:
        return "unchecked"
    if not unresolved and not broken and not quiet:
        return "ok"
    if resolved:
        return "partial"
    return "unresolved"


async def _source_at(corpus: Path, ref: str) -> str | None:
    """The number(s) the place `ref` shows, for the hover of a contradicted mark; None when it shows none or does not
    resolve."""
    try:
        out = await asyncio.to_thread(refs.resolve, corpus, ref)
    except Exception:  # noqa: BLE001
        return None
    span = (out.get("meta") or {}).get("span") if isinstance(out.get("meta"), dict) else None
    if isinstance(span, dict) and span.get("value") is not None:
        v = str(span["value"]).strip()
        return v if cite._NUM_RE.fullmatch(v) else None
    text = str(span.get("text") if isinstance(span, dict) and span.get("text") is not None else out.get("excerpt") or "")
    nums = cite._NUM_RE.findall(text)
    return ", ".join(nums[:3]) if nums else None


def _links_failed(c: str, cid: str, version: str, note: str) -> None:
    """The links job gave up after both attempts: the deterministic links stand, unlinked numbers are listed,
    `links.status`
    is `failed` (the only path that writes it), and the note says why."""
    def mutate(cell: dict) -> bool:
        if _links_version(cell) != version:
            return False
        rec = cell.get("verification")
        if not isinstance(rec, dict):
            rec = _fresh(cell)
            cell["verification"] = rec
        links = rec.get("links") if isinstance(rec.get("links"), dict) else {"resolved": [], "unresolved": _numbers(str(cell.get("takeaway") or "")), "broken": []}
        links["status"] = "failed"
        links["checked"] = False
        rec["links"] = links
        rec["attempts"] = jobs.ATTEMPTS
        rec["note"] = note
        _summarise(rec)
        return True

    saved = _save_cell(c, cid, mutate)
    _emit_cell(c, saved, "verified")


# ----------------------------------------------------------------------------------------------------------
# rescan at start (jobs.on_start)
# ----------------------------------------------------------------------------------------------------------


# the one finished shape a start re-checks: every broken entry a 404 on a file named by a number, which a takeaway in
# the markdown-link form yields
_NUMBER_FILE_404_RE = re.compile(r"not found \(404\): no such file: '-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?%?'")


def _heals_at_start(links: dict) -> bool:
    """Whether a finished links record is the hybrid form's (nothing broken but numbers read as file names), so one more
    run
    of the job links them."""
    # the 404s may be listed under `broken` or `quiet`
    entries = [b for k in ("broken", "quiet") if isinstance(links.get(k), list) for b in links[k]]
    return bool(entries) and all(
        isinstance(b, dict) and _NUMBER_FILE_404_RE.fullmatch(str(b.get("why") or "")) is not None for b in entries)


def rescan(c: str | None = None) -> int:
    """Derive the pending cell jobs from state: a code cell that ran clean whose `verification.exec_count` differs gets
    a
    fresh record, a pending record is re-enqueued, and a hybrid-form record (_heals_at_start) is re-run once. Returns
    the
    number of cells touched. Nothing under the tests' switch (CHECK_JOBS)."""
    if not CHECK_JOBS:
        return 0
    if c is not None:
        names = [c]
    else:
        root = config.WORKSPACES_DIR
        names = sorted(p.name for p in root.iterdir() if p.is_dir()) if root.is_dir() else []
    touched = 0
    for name in names:
        try:
            ws = config.workspace_dir(name)
        except ValueError:
            continue
        for info in notebook.list_notebooks(ws):
            nb = notebook.read_notebook(ws, info["id"])
            if nb is None:
                continue
            changed = False
            for cell in nb.get("cells") or []:
                if not isinstance(cell, dict) or cell.get("kind", "code") != "code" or not cell.get("id"):
                    continue
                if not _runnable(cell):
                    continue
                v = cell.get("verification")
                if not isinstance(v, dict) or v.get("exec_count") != cell.get("exec_count"):
                    on_cell_ran(name, nb, cell)
                    changed = True
                    touched += 1
                    continue
                links = v.get("links") if isinstance(v.get("links"), dict) else {}
                hit = False
                if str(cell.get("takeaway") or "").strip() and (links.get("status") == "pending" or _heals_at_start(links)):
                    if links.get("status") != "pending":
                        links.update(status="pending", checked=False)
                        changed = True
                    hit |= _enqueue_links(name, cell, _links_version(cell))
                if hit:
                    touched += 1
            if changed:
                notebook.write_notebook(ws, nb)
    if touched:
        log.info("verify: rescan enqueued checks for %d cell(s)", touched)
    return touched


jobs.on_start(rescan)


# ----------------------------------------------------------------------------------------------------------
# routes
# ----------------------------------------------------------------------------------------------------------


def _relink(c: str, cell_id: str) -> dict[str, Any]:
    """Link the takeaway's numbers again: the deterministic pass runs at once (_link_now) and the links job is queued
    under a
    new version (the `relinks` count), so a finished check runs again and an earlier job lands stale."""
    ws = notebook._ws(c)
    hit = notebook._locate(ws, cell_id)
    if hit is None:
        raise HTTPException(404, f"no such card: {cell_id}")
    nb, cell = hit
    if not str(cell.get("takeaway") or "").strip():
        raise HTTPException(409, "the card has no takeaway; nothing to link")
    v = cell.get("verification") if isinstance(cell.get("verification"), dict) else None
    if v is None or v.get("exec_count") != cell.get("exec_count"):
        v = _fresh(cell)
    prev = v.get("relinks") if isinstance(v.get("relinks"), int) and not isinstance(v.get("relinks"), bool) else 0
    v["relinks"] = prev + 1
    v["note"] = None
    # an earlier pass re-pointed a ref and recorded where the text had cited it (`from`); the move is carried forward
    stored = v.get("links") if isinstance(v.get("links"), dict) else {}
    moved = {(str(e.get("value")), str(e.get("ref"))): e for e in (stored.get("resolved") or [])
             if isinstance(e, dict) and e.get("from")}
    cell["verification"] = v  # _links_version reads the count from the cell
    _link_now(c, cell, v)
    links_now = v.get("links") if isinstance(v.get("links"), dict) else {}
    for entry in links_now.get("resolved") or []:
        old = moved.get((str(entry.get("value")), str(entry.get("ref")))) if isinstance(entry, dict) else None
        if old is not None and not entry.get("from"):
            entry["how"], entry["from"] = old.get("how") or heal.CELL, old["from"]
    cell["verification"] = _summarise(v)
    links = v.get("links") if isinstance(v.get("links"), dict) else {}
    notebook.write_notebook(ws, nb)
    _emit_cell(c, cell, "verified")
    return {"queued": links.get("status") == "pending", "status": str(links.get("status") or "unchecked")}


@router.post("/ws/{c}/notebooks/{nb}/cells/{cell_id}/relink", status_code=202)
async def relink_route(c: str, nb: str, cell_id: str) -> dict[str, Any]:
    """Run the takeaway's linking again: the link glyph after the takeaway. 202."""
    return _relink(c, cell_id)


@router.post("/ws/{c}/cells/{cell_id}/relink", status_code=202)
async def relink_route_short(c: str, cell_id: str) -> dict[str, Any]:
    return _relink(c, cell_id)


@router.get("/ws/{c}/cells/{cell_id}/verification")
async def verification_route(c: str, cell_id: str) -> dict[str, Any]:
    """The cell's verification record, plus the queue's view of its jobs."""
    ws = notebook._ws(c)
    hit = notebook.find_cell(ws, cell_id)
    if hit is None:
        raise HTTPException(404, f"no such card: {cell_id}")
    _, cell = hit
    return {"verification": cell.get("verification"), "job": jobs.status(f"card:{cell_id}")}
