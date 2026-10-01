"""The view review: once a view the dev agent built passes its checks, which code runs without pictures (views.check),
one picture of its page as it opens in its pane (views.PANE_SIZE) goes to one model reading (prompts/view-review.md),
with what the checks found, how the page's text fits (views.layout_notes) and the controls it shows. The reading names
the problems it sees and may ask for up to EXTRA_SHOTS pictures of other states (EXTRA_STATES), such as a control
clicked or another pane width, which are taken and read once more with the first. The problems go back to the view's build session to fix, up to ROUNDS times. The view reaches the
analyst at once and the review runs beside it; each revision that passes the view's checks replaces it, with Undo back
to the view as it was built.

dev.run_view calls after_built() when a build or a change to a view passes. Each round:
1. The picture: views.shoot_states with no label, the view as the Views bar opens it. Pictures drawn without thimble's
   fonts end the review `failed`. Without the headless browser there is no review, and a review that finds it missing
   leaves no trace on the view.
2. The reading: the `verify` role's model reads the picture, the proposal, what the checks found (views.gate_notes) and
   a sample of the records the page fetched, and returns its problems and the extra states it wants to see. Those are
   shot and read with the first picture once more, whose problems stand. A refused reading runs again on the fallback
   model, and the review's note says so (FALLBACK_NOTE).
3. Revision: with problems left and rounds to go, the build session gets prompts/dev-view-review.md and the view's
   checks run after its turns (dev.review_revision). A revision that passes is the view (views.mark_built), and the
   review runs again; one that does not leaves the view at its last version that passed.

The state rides on the proposal as `review {state, round, ts, revised, left, note, undo, shots}` and goes out with the
`view` event, `shots` counting the pictures the review took. views/.reviewed/<slug>/ keeps the view as it was built for
Undo until the next build or change passes, and <slug>.last the last version that passed, restored when a revision
fails or the review stops mid-revision. A review run again keeps what the review before it revised, so Undo still
reaches the view as it was built. A new change to the view stops its review; a view replaced or deleted stops it with
no trace (forget)."""
from __future__ import annotations

import asyncio
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
# the states the reading may ask to see beside the overview, each with its pane: the overview with the test label on and
# filtered to it, beside the Labels pane; the first place a citation opens and the place a ref names, with the test
# label on; the overview in the pane of a 1920 px window and beside the Labels pane; and the overview after clicking
# the controls it names
EXTRA_STATES = {"labels": views.PANE_NARROW, "filtered": views.PANE_NARROW, "detail": views.PANE_NARROW,
                "open": views.PANE_NARROW, "wide": views.PANE_WIDE, "narrow": views.PANE_NARROW,
                "control": views.PANE_SIZE}
EXTRA_SHOTS = 3
CONTROLS_CLICKED = 3  # controls one `control` state clicks in turn

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
    shots: int = 0  # pictures taken
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
    _set(c, slug, state="running", round=0, revised=run.revised, left=[], note="", undo=False, shots=0)
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
        shots = await shoot(c, slug, view, files, [{"state": "overview"}], run)
        if any(s.get("unavailable") for s in shots):
            _settle(run)
            views.update_proposal(c, slug, review=None)
            views._emit(c, slug, str(prop.get("status") or "built"), review=None)
            return
        if why := _unusable(shots):
            _set(c, slug, run, state="failed", note=why, revised=run.revised, shots=run.shots)
            return
        got = await read(c, run, prop, view, shots, ask=True)
        if isinstance(got, str):
            _set(c, slug, run, state="failed", note=got, revised=run.revised, shots=run.shots)
            return
        problems, more = got
        if more:
            extra = await shoot(c, slug, view, files, more, run)
            if not any(s.get("unavailable") for s in extra) and not _unusable(extra):
                shots += extra
                got = await read(c, run, prop, view, shots, ask=False)
                if isinstance(got, str):
                    _set(c, slug, run, state="failed", note=got, revised=run.revised, shots=run.shots)
                    return
                problems = got[0]
        if not problems:
            _set(c, slug, run, state="done", left=[], revised=run.revised, note=run.note, shots=run.shots)
            return
        if run.round >= ROUNDS:
            _set(c, slug, run, state="done", left=[_phrase(p) for p in problems], revised=run.revised, note=run.note,
                 shots=run.shots)
            return
        d = views.views_dir(c) / slug
        if not _reviewed_dir(c, slug).is_dir():
            await asyncio.to_thread(_copy_view, d, _reviewed_dir(c, slug))
        await asyncio.to_thread(_copy_view, d, _reviewed_dir(c, slug, last=True))
        _set(c, slug, run, state="running", round=run.round + 1, revised=run.revised, shots=run.shots)
        run.revising = True
        ok, why = await revise(c, slug, prop, problems, shots)
        if not ok:
            _settle(run)
            _set(c, slug, run, state="done", left=[_phrase(p) for p in problems], revised=run.revised,
                 note=REVISION_FAILED_NOTE, shots=run.shots)
            return
        run.revising = False
        views.mark_built(c, slug)
        run.revised += [_phrase(p) for p in problems]
        run.round += 1


def _unusable(shots: list[dict[str, Any]]) -> str:
    """Why pictures cannot be read, as the review's note: a page that did not load, or one drawn without thimble's fonts;
    '' when they can."""
    bad = [s for s in shots if not s.get("ok")]
    if bad:
        why = "; ".join(dict.fromkeys(e for s in bad for e in s.get("errors") or [])) or "the page did not load"
        return SHOTS_NOTE.format(why=why[:400])
    if not all(s.get("fonts") for s in shots):
        return FONTS_NOTE
    return ""


async def shoot(c: str, slug: str, view: dict[str, Any], files: list[tuple[str, int, int]], wanted: list[dict[str, Any]],
                run: _Run) -> list[dict[str, Any]]:
    """Pictures of the states `wanted`, each {state, ref?, controls?, why?}: `overview` with no label, as the Views bar
    opens the view in its pane, or one of EXTRA_STATES in its pane. Each result carries its state, ref, controls, the
    reading's why and the pane's size."""
    base = views.cache_dir(c, view) / "review"
    overview = {"ref": None, "path": files[0][0]} if files else {"ref": None}
    stem = f"round-{run.round}-{int(time.time())}"
    states: list[dict[str, Any]] = []
    for i, w in enumerate(wanted):
        state, out = str(w.get("state")), base / f"{stem}-{run.shots + i + 1}.png"
        st: dict[str, Any] = {"out": out, "open": overview, "labels": views.NO_LABELS,
                              "size": EXTRA_STATES.get(state, views.PANE_SIZE)}
        if state == "labels":
            st["labels"] = views.probe_context()
        elif state == "filtered":
            st["labels"] = views.probe_context(True)
        elif state == "detail":
            locs = views._kept_locators(c, slug) or ([f"{files[0][0]}#L1"] if files else [])
            place = await views.first_place(c, slug, [{"ok": True, "locator": loc} for loc in locs]) if locs else None
            st.update(open=place or overview, labels=views.probe_context())
        elif state == "open":
            ref = str(w.get("ref") or "")
            place = await views.open_place(c, slug, ref, views.locator_of(ref)) if views.locator_of(ref) else overview
            st.update(open=place, labels=views.probe_context())
        elif state == "control":
            st["actions"] = list(w.get("controls") or [])[:CONTROLS_CLICKED]
        states.append(st)
    got = await views.shoot_states(c, slug, states, answers=ANSWERS_PER_STATE) if states else []
    results = [{**r, "state": w.get("state"), "ref": w.get("ref"), "controls": w.get("controls"), "why": w.get("why"),
                "size": st["size"]} for w, st, r in zip(wanted, states, got)]
    run.shots += sum(1 for r in results if r.get("png"))
    return results


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


def pictures_text(shots: list[dict[str, Any]]) -> str:
    """One line per picture: its number, its state and pane, the ref it opened or the controls it clicked, why the
    reading asked for it, and how its text fits as layout_notes words it; then the controls the first picture shows."""
    words = {"overview": "the view as it opens, with no label on", "labels": "the overview with the test label on",
             "filtered": "the overview filtered to the test label", "detail": "the place the first citation opens",
             "open": "the place {ref} opens, with the test label on", "wide": "the view as it opens",
             "narrow": "the view as it opens, with no label on", "control": "the overview after clicking {controls}"}
    lines = []
    for i, s in enumerate(shots, 1):
        clicked = [a for a in s.get("actions") or [] if isinstance(a, dict)]
        controls = ", then ".join(repr(a.get("control")) + ("" if a.get("found") else " (not found)") for a in clicked)
        what = words.get(str(s.get("state")), words["overview"]).format(ref=s.get("ref") or "the ref",
                                                                         controls=controls or "nothing")
        lay = s.get("layout") if isinstance(s.get("layout"), dict) else {}
        size = s.get("size") or views.PANE_SIZE
        line = f"{i}: {what}, {size[0]} px wide" + (f" (asked for: {s['why']})" if s.get("why") else "")
        fit = views.layout_parts(lay, wide=s.get("state") == "wide") if s.get("ok") else []
        if (n := int(lay.get("outside") or 0)) and s.get("ok"):
            fit.append(views._hint("view-layout-outside", n=f"{n:,}", of=f"{int(lay.get('anchored') or 0):,}"))
        lines.append(line + (f". Measured: {'; '.join(fit)}" if fit else ""))
    first = shots[0].get("controls") if shots else None
    if first:
        lines.append("The controls picture 1 shows, by their text: " + "; ".join(str(x) for x in first))
    return "\n".join(lines)


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


async def read(c: str, run: _Run, prop: dict[str, Any], view: dict[str, Any], shots: list[dict[str, Any]], *,
               ask: bool) -> tuple[list[str], list[dict[str, Any]]] | str:
    """(problems, the extra states it asks to see, EXTRA_SHOTS at most and none unless `ask`) from one reading of the
    pictures; why not, as the note the check mark shows, when the reading failed. Capacity failures wait
    CAPACITY_WAITS_S outside the reading slots."""
    from . import card_check, model, tools  # noqa: PLC0415

    secs = _sections()
    user = _fill(secs["view"], {"name": str(prop.get("name") or view["name"]),
                                "description": str(prop.get("why") or view["description"]),
                                "claims": ", ".join(prop.get("claims") or view["claims"]),
                                "spec": views.spec_lines(prop),
                                "checks": "\n".join(views.gate_notes(c, view["slug"])) or "-",
                                "pictures": pictures_text(shots), "records": records_text(shots) or "-"})
    user += "\n\n" + secs["ask" if ask else "final"]
    desc, schema = tools.split_section(secs["findings"])
    if not ask:
        schema["properties"].pop("more", None)
    tool = model.ToolSpec(name="findings", description=desc, input_schema=schema)
    images = [(await asyncio.to_thread(card_check.fit_image, Path(s["png"]).read_bytes()), "image/png")
              for s in shots if s.get("png")]
    effort = str(_role(c).get("effort") or config.ROLE_MODELS_DEFAULT["verify"]["effort"])
    waits = list(CAPACITY_WAITS_S)
    while True:
        async with _semaphore():
            try:
                res = await asyncio.wait_for(_call(c, _fill(secs["review"], {}), user, tool, images, effort),
                                             READ_TIMEOUT_S.get(effort, 120.0))
            except asyncio.TimeoutError:
                return f"The review did not finish: the reading ran past {READ_TIMEOUT_S.get(effort, 120.0):.0f} s"
        if res.refused_by:
            from .session import model_label  # noqa: PLC0415

            run.note = FALLBACK_NOTE.format(model=model_label(res.refused_by), fallback=model_label(res.model_requested))
        if res.status == "ok" and isinstance(res.output, dict):
            out = _findings(res.output, ask)
            return out if out is not None else "The review did not finish: the reading gave no list of problems"
        cls = "rate_limited" if res.status == "rate_limited" else retry.transient_class(None, res.detail)
        if cls in CAPACITY and waits:
            await asyncio.sleep(waits.pop(0))
            continue
        if cls in CAPACITY:
            return f"The review did not finish: {CAPACITY_WORDS[cls]}"
        return f"The review did not finish: the reading ended {res.status}" + (f" ({res.detail})" if res.detail else "")


def _findings(raw: dict[str, Any], ask: bool) -> tuple[list[str], list[dict[str, Any]]] | None:
    """The reading's problems as sentences and, with `ask`, the extra states it asks for, each {state, ref?, controls?,
    why} of EXTRA_STATES (an `open` with a ref, a `control` with the controls to click), EXTRA_SHOTS at most; None for a
    malformed answer."""
    problems = raw.get("problems")
    if not isinstance(problems, list) or not all(isinstance(p, str) for p in problems):
        return None
    more: list[dict[str, Any]] = []
    for m in raw.get("more") or [] if ask else []:
        if not isinstance(m, dict) or m.get("state") not in EXTRA_STATES or (m["state"] == "open" and not m.get("ref")):
            continue
        controls = [" ".join(str(x).split()) for x in m.get("controls") or [] if str(x).strip()][:CONTROLS_CLICKED]
        if m["state"] == "control" and not controls:
            continue
        more.append({"state": m["state"], "ref": str(m.get("ref") or "") or None, "controls": controls or None,
                     "why": " ".join(str(m.get("why") or "").split())})
    return [" ".join(p.split()) for p in problems if p.strip()], more[:EXTRA_SHOTS]


# --------------------------------------------------------------------------- the revision


def revision_prompt(c: str, slug: str, problems: list[str], shots: list[dict[str, Any]]) -> str:
    """The message the build session gets: the pictures by path and the problems, one bullet each."""
    from . import prompts  # noqa: PLC0415

    pics = ", ".join(f"{i} ({s.get('state')}) {s['png']}" for i, s in enumerate(shots, 1) if s.get("png"))
    findings = "\n".join(f"- {p}" for p in problems)
    return prompts.render(REVISION_PROMPT, {"pictures": pics, "findings": findings,
                                            "folder": str(views.views_dir(c) / slug)})


async def revise(c: str, slug: str, prop: dict[str, Any], problems: list[str],
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

