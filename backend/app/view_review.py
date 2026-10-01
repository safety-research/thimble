"""The view review: once a view the dev agent built passes its checks, its page is shot headless in four states, one
model reading of the pictures assesses it against seven criteria (prompts/view-review.md), and the problems it finds go
back to the view's build session to fix, up to ROUNDS times. The view reaches the analyst at once and the review runs
beside it; each revision that passes the view's checks replaces it, with Undo back to the view as it was built.

dev.run_view calls after_built() when a build or a change to a view passes. Each review:
1. Shots: views.shoot_states in four states, the overview with no label, with the test label on, filtered to it, and
   the first place that resolved (only the first and the last for a view over files without lines, which labels cannot
   mark). Pictures drawn without thimble's fonts end the review `failed`. Without the headless browser there is no
   review, and a review that finds it missing leaves no trace on the view.
2. Reading: the `verify` role's model reads the pictures, the proposal, what the shots measured and a sample of the
   records the pages fetched, and names what fails each criterion. A refused reading runs again on the fallback model,
   and the review's note says so (FALLBACK_NOTE). A picture in which the page has controls of its own that name the
   test label adds a problem to the last criterion (label_controls), and one with chips or buttons drawn as rounded
   pills of the page's own a problem to the formatting criterion (own_pills).
3. Revision: with problems left and rounds to go, the build session gets prompts/dev-view-review.md and the view's
   checks run after its turns (dev.review_revision). A revision that passes is the view (views.mark_built), and the
   review runs again; one that does not leaves the view at its last version that passed.

Before a view is built, its gate also has one model reading compare reader.py with the view's derived fields
(derived_review, the `derived` sections of prompts/view-review.md), and a field the reader derives that the list leaves
out fails the build.

The state rides on the proposal as `review {state, round, ts, revised, left, note, undo}` and goes out with the `view`
event. views/.reviewed/<slug>/ keeps the view as it was built for Undo until the next build or change passes, and
<slug>.last the last version that passed, restored when a revision fails or the review stops mid-revision. A review run
again keeps what the review before it revised, so Undo still reaches the view as it was built. A new change to the view
stops its review; a view replaced or deleted stops it with no trace (forget)."""
from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import re
import shutil
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException

from . import config, headless, retry, views
from .ledger import write_json

log = logging.getLogger("thimble.view_review")

PROMPT = "view-review"
REVISION_PROMPT = "dev-view-review"
ROUNDS = 2  # revisions a review may make
# How long a reading may take, by the effort it runs at; waits for API capacity are left out.
READ_TIMEOUT_S = {"low": 60.0, "medium": 60.0, "high": 120.0, "xhigh": 180.0, "max": 240.0}
CAPACITY_WAITS_S = (30.0, 60.0, 120.0)  # after model.structured's own retries, the waits before reading again
CAPACITY = ("overloaded", "rate_limited")
CAPACITY_WORDS = {"overloaded": "Anthropic's API is overloaded", "rate_limited": "Anthropic's API rate limit was reached"}
REVIEW_TOTAL_S = 25 * 60.0
REVIEW_CONCURRENCY = max(1, int(os.environ.get("THIMBLE_VIEW_REVIEW_CONCURRENCY", "2") or "2"))
READ_IDLE_S = 60.0
RECORDS_CHARS = 6000  # of the reader's answers the reading sees
ANSWERS_PER_STATE = 2
PHRASE_CHARS = 120  # of a problem, as the check mark's hover lists what was revised or is left
AUTO_KEY = "view_review"  # settings.json: false turns the review off for the workspace
REVIEWED_SUBDIR = ".reviewed"
STATES = ("running", "done", "failed", "stopped")
FALLBACK_NOTE = "Downgrading {model} to {fallback}"
FONTS_NOTE = "The view's pictures were drawn without thimble's fonts"
SHOTS_NOTE = "The view's pictures could not be taken: {why}"
REVISION_FAILED_NOTE = "A revision did not pass the view's checks, so the view is as it was before it."
PAST_TIME_NOTE = "The review ran past {minutes} minutes, so the view is at its last version that passed its checks."
STOPPED_NOTE = "The review was stopped."
CHANGED_NOTE = "The view changed while it was reviewed."
# the four states a view over files with lines is shot in, by name, and the two of a view over binary files only
LINED_STATES = ("overview", "labels on", "filtered", "detail")
PLAIN_STATES = ("overview", "detail")

_runs: dict[tuple[str, str], "_Run"] = {}
_sem: asyncio.Semaphore | None = None
_sem_loop: asyncio.AbstractEventLoop | None = None


@dataclass
class _Run:
    c: str
    slug: str
    task: asyncio.Task | None = None
    round: int = 0
    revised: list[str] = field(default_factory=list)
    reason: str = ""  # why the review was cancelled: STOPPED_NOTE or CHANGED_NOTE
    revising: bool = False  # a revision's session may be writing the view's files
    note: str = ""
    forget: bool = False  # the view was replaced or deleted: the review writes nothing more and keeps no copies
    restart: bool = False  # a build passed while the review was being stopped: a fresh review starts once it ends


def enabled() -> bool:
    """THIMBLE_VIEW_REVIEW unset or on (the test suite turns it off in conftest.py)."""
    return os.environ.get("THIMBLE_VIEW_REVIEW", "on").strip().lower() not in ("0", "off", "false", "no")


def auto(c: str) -> bool:
    """Whether a built view is reviewed by itself in workspace `c`: settings.json `view_review`, on unless turned off."""
    from . import ledger  # noqa: PLC0415

    try:
        return ledger.stored_settings(c).get(AUTO_KEY) is not False
    except Exception:  # noqa: BLE001 — an unreadable settings file leaves the review on, as a fresh workspace has it
        return True


def running(c: str, slug: str) -> bool:
    run = _runs.get((c, slug))
    return run is not None and run.task is not None and not run.task.done()


def revising(c: str, slug: str) -> bool:
    """Whether a revision the review asked for may be writing the view's files."""
    run = _runs.get((c, slug))
    return run is not None and run.revising


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _set(c: str, slug: str, run: "_Run | None" = None, **fields: Any) -> dict[str, Any]:
    """Merge fields into the proposal's `review` and send `view {slug, status: built, review}`; nothing for a run whose
    view was replaced or deleted, or once the proposal is gone."""
    if run is not None and run.forget:
        return {}
    prop = views.read_proposal(c, slug)
    if prop is None:
        return {}
    review = {**(prop.get("review") if isinstance(prop.get("review"), dict) else {}), **fields, "ts": _now()}
    views.update_proposal(c, slug, review=review)
    views._emit(c, slug, str(prop.get("status") or "built"), review=review)
    return review


def _phrase(problem: str) -> str:
    s = " ".join(str(problem).split())
    return s if len(s) <= PHRASE_CHARS else s[: PHRASE_CHARS - 1].rstrip() + "…"


# --------------------------------------------------------------------------- starting and stopping


def after_built(c: str, slug: str) -> None:
    """Start the review of a view that just passed its checks: a first build or a change, which is the new version Undo
    goes back to. A review of that view that is running goes on, since it drives its own revisions; a view thimble
    ships is never reviewed."""
    run = _runs.get((c, slug))
    if running(c, slug):
        if run is not None and run.reason:
            run.restart = True
        return
    view = views.read_view(c, slug)
    prop = views.read_proposal(c, slug)
    if view is None or view.get("origin") != "workspace" or prop is None:
        return
    _drop_copies(c, slug)
    if not enabled() or not auto(c) or headless.missing(headless.PAGES):
        if prop.get("review"):
            views.update_proposal(c, slug, review=None)
        return
    start(c, slug)


def start(c: str, slug: str, again: bool = False) -> _Run | None:
    """Start a review on the running loop (the server's loop from a worker thread); None when one is running. `again`
    (the analyst's Review again) keeps what the review before it revised, and its copy of the view as built."""
    if running(c, slug):
        return None
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = views._loop
        if loop is None or not loop.is_running() or loop.is_closed():
            return None
        loop.call_soon_threadsafe(start, c, slug, again)
        return None
    run = _Run(c, slug)
    if again and _reviewed_dir(c, slug).is_dir():
        before = (views.read_proposal(c, slug) or {}).get("review")
        run.revised = [str(x) for x in (before.get("revised") or [])] if isinstance(before, dict) else []
    _runs[(c, slug)] = run
    _set(c, slug, state="running", round=0, revised=run.revised, left=[], note="", undo=False)
    run.task = loop.create_task(_guarded(run), name=f"view-review:{c}:{slug}")
    return run


def stop(c: str, slug: str, reason: str = STOPPED_NOTE, forget: bool = False) -> bool:
    """Stop the view's review, if one runs. A revision in progress is put back to the last version that passed, unless
    `forget` (the view is replaced or deleted), which leaves no state and no copies behind."""
    from . import dev  # noqa: PLC0415

    run = _runs.get((c, slug))
    if run is None or run.task is None or run.task.done():
        if forget:
            _drop_copies(c, slug)
        return False
    run.reason = reason
    run.forget = run.forget or forget
    if run.revising:
        # the revision's session stops and the view is put back now, before a change that stops the review copies it
        dev.stop_review_session(c, slug)
        if not run.forget:
            _settle(run)
        run.revising = False
    if forget:
        _drop_copies(c, slug)
    loop = run.task.get_loop()
    try:
        on_loop = asyncio.get_running_loop() is loop
    except RuntimeError:
        on_loop = False
    if on_loop:
        run.task.cancel()
    elif not loop.is_closed():
        loop.call_soon_threadsafe(run.task.cancel)
    return True


async def shutdown() -> None:
    for run in list(_runs.values()):
        if run.task is not None and not run.task.done():
            run.reason = "The server stopped while the review ran."
            run.task.cancel()
    tasks = [r.task for r in _runs.values() if r.task is not None]
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)


# --------------------------------------------------------------------------- the copies of the view's files


def _reviewed_dir(c: str, slug: str, last: bool = False) -> Path:
    return views.state_dir(c) / REVIEWED_SUBDIR / (f"{slug}.last" if last else slug)


def _copy_view(src: Path, dst: Path) -> None:
    """The view's files at `src`'s top level copied to `dst`, which is emptied first; the cache stays behind."""
    shutil.rmtree(dst, ignore_errors=True)
    dst.mkdir(parents=True, exist_ok=True)
    for p in src.iterdir():
        if p.is_file():
            shutil.copy2(p, dst / p.name)


def _drop_copies(c: str, slug: str) -> None:
    shutil.rmtree(_reviewed_dir(c, slug), ignore_errors=True)
    shutil.rmtree(_reviewed_dir(c, slug, last=True), ignore_errors=True)


def _restore(c: str, slug: str, src: Path) -> bool:
    """Put the view's files back from the copy `src` (its cache kept) and drop its memo; False without a copy."""
    if not src.is_dir():
        return False
    d = views.views_dir(c) / slug
    for p in d.iterdir() if d.is_dir() else []:
        if p.is_file():
            p.unlink(missing_ok=True)
    d.mkdir(parents=True, exist_ok=True)
    for p in src.iterdir():
        if p.is_file():
            shutil.copy2(p, d / p.name)
    views._forget(c, slug)
    return True


def undo(c: str, slug: str) -> dict[str, Any]:
    """Put the view back as it was built, before the review revised it: its files restored, `built` stamped and the
    `view` event sent. 409 while a review runs or when there is nothing to undo."""
    if running(c, slug):
        raise HTTPException(409, "the view's review is still running")
    src = _reviewed_dir(c, slug)
    prop = views.read_proposal(c, slug) or {}
    review = prop.get("review") if isinstance(prop.get("review"), dict) else {}
    if not review.get("revised") or not src.is_dir():
        raise HTTPException(409, "the review revised nothing to undo")
    _restore(c, slug, src)
    views.mark_built(c, slug)
    _drop_copies(c, slug)
    return _set(c, slug, revised=[], left=[], undo=True, note="")


# --------------------------------------------------------------------------- the review


async def _guarded(run: _Run) -> None:
    c, slug = run.c, run.slug
    try:
        await asyncio.wait_for(_review(run), REVIEW_TOTAL_S)
    except asyncio.TimeoutError:
        _settle(run)
        _set(c, slug, run, state="failed", note=PAST_TIME_NOTE.format(minutes=round(REVIEW_TOTAL_S / 60)),
             revised=run.revised)
    except asyncio.CancelledError:
        _settle(run)
        _set(c, slug, run, state="stopped", note=run.reason or STOPPED_NOTE, revised=run.revised)
    except Exception as e:  # noqa: BLE001
        log.exception("view review %s/%s failed", c, slug)
        _settle(run)
        _set(c, slug, run, state="failed", note=f"The review did not finish: {type(e).__name__}: {e}",
             revised=run.revised)
    finally:
        if _runs.get((c, slug)) is run:
            _runs.pop((c, slug), None)
        if run.forget:
            _drop_copies(c, slug)
        if run.restart:
            after_built(c, slug)


def _settle(run: _Run) -> None:
    """A review cut short mid-revision puts the view back to the last version that passed its checks."""
    if run.revising and not run.forget and _restore(run.c, run.slug, _reviewed_dir(run.c, run.slug, last=True)):
        views.mark_built(run.c, run.slug)
    run.revising = False


async def _review(run: _Run) -> None:
    c, slug = run.c, run.slug
    while True:
        prop = views.read_proposal(c, slug) or {}
        view = views.read_view(c, slug)
        if view is None:
            return
        files = await asyncio.to_thread(views.claimed_files, c, view)
        lined = views.lined(view, files)
        shots = await shoot(c, slug, view, files, prop, lined, run.round)
        if any(s.get("unavailable") for s in shots):
            _settle(run)
            views.update_proposal(c, slug, review=None)
            views._emit(c, slug, str(prop.get("status") or "built"), review=None)
            return
        bad = [s for s in shots if not s.get("ok")]
        if bad:
            why = "; ".join(dict.fromkeys(e for s in bad for e in s.get("errors") or [])) or "the page did not load"
            _set(c, slug, run, state="failed", note=SHOTS_NOTE.format(why=why[:400]), revised=run.revised)
            return
        if not all(s.get("fonts") for s in shots):
            _set(c, slug, run, state="failed", note=FONTS_NOTE, revised=run.revised)
            return
        got = await read(c, run, prop, view, shots, lined)
        if isinstance(got, str):
            _set(c, slug, run, state="failed", note=got, revised=run.revised)
            return
        got[2] += [p for p in own_pills(shots) if p not in got[2]]
        if lined:
            got[-1] += [p for p in label_controls(shots) if p not in got[-1]]
        problems = [p for crit in got for p in crit]
        if not problems:
            _set(c, slug, run, state="done", left=[], revised=run.revised, note=run.note)
            return
        if run.round >= ROUNDS:
            _set(c, slug, run, state="done", left=[_phrase(p) for p in problems], revised=run.revised, note=run.note)
            return
        d = views.views_dir(c) / slug
        if not _reviewed_dir(c, slug).is_dir():
            await asyncio.to_thread(_copy_view, d, _reviewed_dir(c, slug))
        await asyncio.to_thread(_copy_view, d, _reviewed_dir(c, slug, last=True))
        _set(c, slug, run, state="running", round=run.round + 1, revised=run.revised)
        run.revising = True
        ok, why = await revise(c, slug, prop, got, shots)
        if not ok:
            _settle(run)
            _set(c, slug, run, state="done", left=[_phrase(p) for p in problems], revised=run.revised,
                 note=REVISION_FAILED_NOTE)
            return
        run.revising = False
        views.mark_built(c, slug)
        run.revised += [_phrase(p) for p in problems]
        run.round += 1


async def shoot(c: str, slug: str, view: dict[str, Any], files: list[tuple[str, int, int]], prop: dict[str, Any],
                lined: bool, rnd: int) -> list[dict[str, Any]]:
    """The review's pictures, each result with its state's name: four states for a view over files with lines, else
    the overview and the detail with no label."""
    base = views.cache_dir(c, view) / "review"
    overview = {"ref": None, "path": files[0][0]} if files else {"ref": None}
    locs = views._kept_locators(c, slug) or []
    checks = [{"ok": True, "locator": loc} for loc in locs]
    if not checks and files and any(views._is_line_form(f["form"]) for f in view.get("accepts") or []):
        checks = [{"ok": True, "locator": f"{files[0][0]}#L1"}]
    detail = (await views.first_place(c, slug, checks) if checks else None) or overview
    stem = f"round-{rnd}-{int(time.time())}"
    if lined:
        states = [(LINED_STATES[0], overview, views.NO_LABELS), (LINED_STATES[1], overview, views.probe_context()),
                  (LINED_STATES[2], overview, views.probe_context(True)), (LINED_STATES[3], detail, views.probe_context())]
    else:
        states = [(PLAIN_STATES[0], overview, views.NO_LABELS), (PLAIN_STATES[1], detail, views.NO_LABELS)]
    shots = await views.shoot_states(c, slug, [{"out": base / f"{stem}-{i + 1}.png", "open": place, "labels": ctx}
                                               for i, (_, place, ctx) in enumerate(states)], answers=ANSWERS_PER_STATE)
    return [{**s, "state": name} for s, (name, _, _) in zip(shots, states)]


# --------------------------------------------------------------------------- the reading


def _sections() -> dict[str, str]:
    from . import prompts  # noqa: PLC0415

    text = prompts.load(PROMPT)
    marks = [*re.finditer(r"^## (.+?)[ \t]*$", text, re.M)]
    return {m.group(1).strip(): text[m.end():marks[i + 1].start() if i + 1 < len(marks) else len(text)].strip()
            for i, m in enumerate(marks)}


def _fill(template: str, values: dict[str, str]) -> str:
    from . import prompts  # noqa: PLC0415

    return prompts._fill(template, values, f"{PROMPT}.md")


def measured(shots: list[dict[str, Any]]) -> str:
    """One line per picture: what it anchored, what the test label marked and what thimble hid for the filter."""
    lines = []
    for i, s in enumerate(shots, 1):
        line = (f"{i} {s.get('state')}: {int(s.get('records') or 0)} records and {int(s.get('units') or 0)} units "
                f"anchored, {int(s.get('marked') or 0)} marked, fonts {'ok' if s.get('fonts') else 'missing'}")
        if s.get("state") == "filtered":
            hidden = int(s.get("hidden") or 0)
            line += f", {hidden} hidden by thimble" + ("" if hidden else " (the page filters in its reader)")
        if int(s.get("controls") or 0):
            line += f", {int(s['controls'])} controls of the page's own naming the test label"
        if int(s.get("pills") or 0):
            line += f", {int(s['pills'])} chips or buttons drawn as rounded pills of the page's own"
        lines.append(line)
    return "\n".join(lines)


def label_controls(shots: list[dict[str, Any]]) -> list[str]:
    """A problem for the first picture in which the page has controls of its own naming the test label (the shot's
    `controls`); [] when no picture has any."""
    for i, s in enumerate(shots, 1):
        if n := int(s.get("controls") or 0):
            return [_fill(_sections()["label-controls"], {"picture": str(i), "count": str(n)})]
    return []


def own_pills(shots: list[dict[str, Any]]) -> list[str]:
    """A problem for the first picture in which the page drew chips or buttons as rounded pills of its own rather than
    with thimble's parts (the shot's `pills`); [] when no picture has any."""
    for i, s in enumerate(shots, 1):
        if n := int(s.get("pills") or 0):
            return [_fill(_sections()["own-pills"], {"picture": str(i), "count": str(n)})]
    return []


def records_text(shots: list[dict[str, Any]]) -> str:
    """The first reader answers of each picture's page, as JSON, RECORDS_CHARS at most in all."""
    parts = []
    for i, s in enumerate(shots, 1):
        for a in (s.get("answers") or [])[:ANSWERS_PER_STATE]:
            parts.append(f"picture {i}: {json.dumps(a, ensure_ascii=False, default=str)}")
    text = "\n".join(parts)
    return text if len(text) <= RECORDS_CHARS else text[: RECORDS_CHARS - 1] + "…"


def _role(c: str) -> dict[str, Any]:
    return config.models_for(c).get("verify") or dict(config.ROLE_MODELS_DEFAULT["verify"])


def _semaphore() -> asyncio.Semaphore:
    global _sem, _sem_loop
    loop = asyncio.get_running_loop()
    if _sem is None or _sem_loop is not loop:
        _sem, _sem_loop = asyncio.Semaphore(REVIEW_CONCURRENCY), loop
    return _sem


async def _call(c: str, system: str, user: str, tool: Any, images: list[tuple[bytes, str]], effort: str) -> Any:
    """The reading: one model.structured call on the `verify` role's model at `effort`. Tests replace it."""
    from . import model  # noqa: PLC0415

    role = _role(c)
    return await model.structured(
        user, tool=tool, model=role.get("model") or config.ROLE_MODELS_DEFAULT["verify"]["model"], effort=effort or None,
        system_append=system, cwd=config.corpus_dir(c),
        speed="fast" if role.get("fast") else "standard", images=images, idle_timeout_s=READ_IDLE_S)


async def read(c: str, run: _Run, prop: dict[str, Any], view: dict[str, Any], shots: list[dict[str, Any]],
               lined: bool) -> list[list[str]] | str:
    """The problems that fail each criterion, from one reading of the pictures; why not, as the note the check mark
    shows, when the reading failed. Capacity failures wait CAPACITY_WAITS_S outside the reading slots."""
    from . import card_check, model, tools  # noqa: PLC0415

    secs = _sections()
    n = len(re.findall(r"^- ", secs["review"] + ("\n" + secs["criteria-labels"] if lined else ""), re.M))
    system = _fill(secs["review"], {"pictures": secs["pictures-labels" if lined else "pictures-plain"],
                                    "label_criteria": secs["criteria-labels"] if lined else ""})
    user = _fill(secs["view"], {"name": str(prop.get("name") or view["name"]),
                                "description": str(prop.get("why") or view["description"]),
                                "claims": ", ".join(prop.get("claims") or view["claims"]),
                                "spec": views.spec_lines(prop), "measured": measured(shots),
                                "records": records_text(shots) or "-"})
    desc, schema = tools.split_section(secs["findings"])
    schema["properties"]["assessment"]["minItems"] = schema["properties"]["assessment"]["maxItems"] = n
    tool = model.ToolSpec(name="findings", description=desc, input_schema=schema)
    images = [(await asyncio.to_thread(card_check.fit_image, Path(s["png"]).read_bytes()), "image/png") for s in shots]
    effort = str(_role(c).get("effort") or config.ROLE_MODELS_DEFAULT["verify"]["effort"])
    waits = list(CAPACITY_WAITS_S)
    while True:
        async with _semaphore():
            try:
                res = await asyncio.wait_for(_call(c, system, user, tool, images, effort), READ_TIMEOUT_S.get(effort, 120.0))
            except asyncio.TimeoutError:
                return f"The review did not finish: the reading ran past {READ_TIMEOUT_S.get(effort, 120.0):.0f} s"
        if res.refused_by:
            from .session import model_label  # noqa: PLC0415

            run.note = FALLBACK_NOTE.format(model=model_label(res.refused_by), fallback=model_label(res.model_requested))
        if res.status == "ok" and isinstance(res.output, dict):
            out = _assessment(res.output.get("assessment"), n)
            return out if out is not None else "The review did not finish: the reading gave no whole assessment"
        cls = "rate_limited" if res.status == "rate_limited" else retry.transient_class(None, res.detail)
        if cls in CAPACITY and waits:
            await asyncio.sleep(waits.pop(0))
            continue
        if cls in CAPACITY:
            return f"The review did not finish: {CAPACITY_WORDS[cls]}"
        return f"The review did not finish: the reading ended {res.status}" + (f" ({res.detail})" if res.detail else "")


def _assessment(raw: Any, n: int) -> list[list[str]] | None:
    """The reading's assessment as n lists of problem sentences; None for another number of items or a malformed one."""
    if not isinstance(raw, list) or len(raw) != n:
        return None
    out = []
    for a in raw:
        problems = a.get("problems") if isinstance(a, dict) else None
        if not isinstance(problems, list) or not all(isinstance(p, str) for p in problems):
            return None
        out.append([" ".join(p.split()) for p in problems if p.strip()])
    return out


# --------------------------------------------------------------------------- the derived fields

DERIVED_FILE = "derived-review.json"  # in the view's cache: {key, undeclared} of the last reading that answered
READER_CHARS = 120_000  # of reader.py the reading sees


def _kept(path: Path) -> Any:
    try:
        return json.loads(path.read_text("utf-8"))
    except (OSError, ValueError):
        return {}


def _keep(path: Path, obj: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    write_json(path, obj)


def _derived_key(reader: str, derived: list[dict[str, str]], prompt: str) -> str:
    import hashlib  # noqa: PLC0415

    return hashlib.sha1("\0".join((reader, json.dumps(derived, sort_keys=True), prompt)).encode("utf-8")).hexdigest()[:20]


async def derived_review(c: str, slug: str, derived: list[dict[str, str]]) -> list[dict[str, str]] | str:
    """The fields reader.py derives that `derived` (the view's list, views.shown) does not name, [{field, how}], from one
    reading on the `verify` role's model, kept per reader, list and prompt so the gate after the session's own check
    does not ask again; why not, as a line, when the reading failed. Capacity failures wait CAPACITY_WAITS_S."""
    from . import model, tools  # noqa: PLC0415

    view = views.read_view(c, slug)
    if view is None:
        return f"no view {slug!r}"
    reader = await asyncio.to_thread((Path(view["dir"]) / views.READER_PY).read_text, "utf-8")
    secs = _sections()
    key = _derived_key(reader, derived, secs["derived"] + secs["derived-view"])
    kept_at = views.cache_dir(c, view) / DERIVED_FILE
    kept = await asyncio.to_thread(_kept, kept_at)
    if isinstance(kept, dict) and kept.get("key") == key and isinstance(kept.get("undeclared"), list):
        return kept["undeclared"]
    listed = "\n".join(f"- {d['field']}: {d['how']}" + (f" (from {d['from']})" if d.get("from") else "") for d in derived)
    user = _fill(secs["derived-view"], {"name": view["name"], "description": view["description"] or "-",
                                        "claims": ", ".join(view["claims"]), "derived": listed or "- none",
                                        "reader": reader[:READER_CHARS]})
    desc, schema = tools.split_section(secs["derived-findings"])
    tool = model.ToolSpec(name="findings", description=desc, input_schema=schema)
    effort = str(_role(c).get("effort") or config.ROLE_MODELS_DEFAULT["verify"]["effort"])
    waits = list(CAPACITY_WAITS_S)
    while True:
        try:
            res = await asyncio.wait_for(_call(c, _fill(secs["derived"], {}), user, tool, [], effort),
                                         READ_TIMEOUT_S.get(effort, 120.0))
        except asyncio.TimeoutError:
            return f"the reading ran past {READ_TIMEOUT_S.get(effort, 120.0):.0f} s"
        if res.status == "ok" and isinstance(res.output, dict) and isinstance(res.output.get("undeclared"), list):
            named = {d["field"] for d in derived}
            out = [{"field": " ".join(str(x.get("field") or "").split()), "how": " ".join(str(x.get("how") or "").split())}
                   for x in res.output["undeclared"] if isinstance(x, dict)]
            out = [x for x in out if x["field"] and x["field"] not in named]
            with contextlib.suppress(OSError):
                await asyncio.to_thread(_keep, kept_at, {"key": key, "undeclared": out})
            return out
        cls = "rate_limited" if res.status == "rate_limited" else retry.transient_class(None, res.detail)
        if cls in CAPACITY and waits:
            await asyncio.sleep(waits.pop(0))
            continue
        if cls in CAPACITY:
            return CAPACITY_WORDS[cls]
        return f"the reading ended {res.status}" + (f" ({res.detail})" if res.detail else "")


# --------------------------------------------------------------------------- the revision


def revision_prompt(c: str, slug: str, problems: list[list[str]], shots: list[dict[str, Any]]) -> str:
    """The message the build session gets: the pictures by path and the problems, one bullet each, in criterion order."""
    from . import prompts  # noqa: PLC0415

    pics = ", ".join(f"{s.get('state')} {s['png']}" for s in shots if s.get("png"))
    findings = "\n".join(f"- {p}" for crit in problems for p in crit)
    return prompts.render(REVISION_PROMPT, {"pictures": pics, "findings": findings,
                                            "folder": str(views.views_dir(c) / slug)})


async def revise(c: str, slug: str, prop: dict[str, Any], problems: list[list[str]],
                 shots: list[dict[str, Any]]) -> tuple[bool, str]:
    """One revision by the view's build session (dev.review_revision): whether the view passed its checks after it."""
    from . import dev  # noqa: PLC0415

    return await dev.review_revision(c, slug, revision_prompt(c, slug, problems, shots))


# --------------------------------------------------------------------------- routes

router = APIRouter()


def _review_view(c: str, slug: str) -> dict[str, Any]:
    config.workspace_dir(c)
    view = views.read_built(c, slug)
    if view is None or view.get("origin") != "workspace" or views.read_proposal(c, slug) is None:
        raise HTTPException(404, f"no reviewable view: {slug}")
    return view


@router.post("/ws/{c}/views/{slug}/review")
async def again_route(c: str, slug: str) -> dict[str, Any]:
    """Review the view again (the refresh glyph of a review that failed or was stopped); 409 while one runs."""
    _review_view(c, slug)
    views._bind_loop()
    if start(c, slug, again=True) is None:
        raise HTTPException(409, "the view's review is already running")
    return {"ok": True}


@router.delete("/ws/{c}/views/{slug}/review")
async def stop_route(c: str, slug: str) -> dict[str, Any]:
    _review_view(c, slug)
    return {"ok": stop(c, slug)}


@router.post("/ws/{c}/views/{slug}/review/undo")
async def undo_route(c: str, slug: str) -> dict[str, Any]:
    """Put the view back as it was built before the review revised it."""
    _review_view(c, slug)
    return {"ok": True, "review": await asyncio.to_thread(undo, c, slug)}

