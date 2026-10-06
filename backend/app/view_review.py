"""The view review: once a view passes its checks, which code runs without pictures (views.check), a
`thimble:view-reviewer`, a subagent of the analyst's Claude Code session (subagents.py), looks at pictures of its page
and fixes what it finds, with a fresh context. The view reaches the analyst at once and the review runs beside it; each
revision that passes the view's checks replaces it, with Undo back to the view as it was built.

dev._settle calls after_built() when a build or a change to a view passes, and the review starts through thimble's
plugin module as part of the start that asked for the build (a follow-on start); Review again is the analyst's click.
The reviewer's registered prompt is the `review` section of prompts/view-review.md (the view-review task's part, which
an extension's prompt changes, tasks.py); its run's prompt names the view (prompts/dev-view-review.md, task). It works
in rounds, through two thimble tools (view_tools.py):
1. view_pictures: the overview as the Views bar opens it, then the states it asks for, up to EXTRA_SHOTS more a round
   (EXTRA_STATES, such as a control clicked or another pane width), shot into views-work/<slug>/review/<round>/ with
   what the checks found, how the page's text fits (views.layout_notes), the controls the first picture shows and a
   sample of the records the pages fetched. It reads the pictures with Read. Without the headless browser there are no
   pictures, and it is told so.
2. If it finds problems, it edits the view's files, checks them with view_check, and calls finish_review with what it
   revised and what it leaves. The gate runs: a pass keeps the revision (views.mark_built) and counts a round, and
   before ROUNDS rounds it is told to take the pictures again; a failure puts the view back as it was before the round
   (REVISION_FAILED_NOTE). A review with no problems calls finish_review with nothing revised. While it edits, readers
   see the view as it last passed (views.read_built's digest rule).
An extension's program that replaces the view-review task (tasks.program) reads the pictures in place of the reviewer:
each view_pictures call passes them to it (review_input, the input docs/agents.md documents), and the reviewer gets the
problems it found to fix. A program that fails ends the review failed with why (PROGRAM_FAILED_NOTE).
A reviewer that ends without finish_review after editing has the gate run once at its end (views.regate), which keeps
or undoes its edit the same way. A reviewer whose model refuses ends failed with that reason; Review again runs it again
on the model Settings name.

The state rides on the proposal as `review {state, round, ts, revised, left, note, undo, shots, agent_id, chat, ...}`
and goes out with the `view` event, `shots` counting the pictures the review took. views/.reviewed/<slug>/ keeps the
view as it was built for Undo until the next build or change passes, and <slug>.last the last version that passed,
restored when a revision fails. A review run again keeps what the review before it revised, so Undo still reaches the
view as it was built. A new change to the view stops its review; a view replaced or deleted stops it with no trace
(forget)."""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import shutil
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Request

from . import config, headless, subagents, views

log = logging.getLogger("thimble.view_review")

PROMPT = "view-review"  # prompts/view-review.md: its `review` section is the reviewer's registered prompt
TASK = "view-review"  # tasks.TASKS: a program that replaces it reads the pictures (program_reading)
TASK_PROMPT = "dev-view-review"  # prompts/dev-view-review.md: a review run's prompt
REVIEWER = "view-reviewer"  # subagents.TYPES
ROUNDS = 2  # revisions a review may make
RECORDS_CHARS = 6000  # of the reader's answers view_pictures gives
ANSWERS_PER_STATE = 2
PHRASE_CHARS = 120  # of a problem, as the check mark's hover lists what was revised or is left
AUTO_KEY = "view_review"  # settings.json: false turns the review off for the workspace
REVIEWED_SUBDIR = ".reviewed"
STATES = ("running", "done", "failed", "stopped")
FONTS_NOTE = "The view's pictures were drawn without thimble's fonts"
SHOTS_NOTE = "The view's pictures could not be taken: {why}"
NO_BROWSER_NOTE = "The headless browser that takes the pictures is not installed, so there are no pictures to review."
REVISION_FAILED_NOTE = "A revision did not pass the view's checks, so the view is as it was before it."
STOPPED_NOTE = "The review was stopped."
CHANGED_NOTE = "The view changed while it was reviewed."
QUIT_NOTE = "The review stopped when your Claude Code session ended."
LEFT_AS_IS = "the view's files, as the review left them"  # a revision the reviewer kept without finish_review
PROGRAM_FAILED_NOTE = "{extension}'s view-review program failed: {why}"
# the view-review task's output, which a program that replaces the task returns (docs/agents.md); the reviewer asks for
# more pictures itself, so the program's input has `ask` false and its `more` is not read
PROGRAM_SCHEMA = {"type": "object", "properties": {"problems": {"type": "array", "items": {"type": "string"}}},
                  "required": ["problems"]}
NO_MORE = ("No picture is left in this round: the overview and {n} more states are taken. Judge from those, then call "
           "finish_review.")
# the states the reviewer may ask to see beside the overview, each with its pane: the overview with the test label on and
# filtered to it, beside the Labels pane; the first place a citation opens and the place a ref names, with the test
# label on; the overview in the pane of a 1920 px window and beside the Labels pane; and the overview after clicking
# the controls it names
EXTRA_STATES = {"labels": views.PANE_NARROW, "filtered": views.PANE_NARROW, "detail": views.PANE_NARROW,
                "open": views.PANE_NARROW, "wide": views.PANE_WIDE, "narrow": views.PANE_NARROW,
                "control": views.PANE_SIZE}
EXTRA_SHOTS = 3
CONTROLS_CLICKED = 3  # controls one `control` state clicks in turn

_stopping: dict[tuple[str, str], tuple[str, bool]] = {}  # (workspace, agent id) -> (why stop() stopped it, forget)
_restart: set[tuple[str, str]] = set()  # (workspace, slug): a build passed while its review was being stopped
# a reviewer's start Claude Code refused at its subagent limit waits and is tried again, as a build's does (live check
# L19: the builder that had just passed still counted as running, so its review was refused and failed)
LIMIT_TRIES = 10  # tries at most, LIMIT_RETRY_S apart (dev.LIMIT_RETRY_S), before the review fails with the limit's text
QUEUED_NOTE = "Waits for a free subagent: Claude Code runs only so many at once."
_limit_tries: dict[tuple[str, str], int] = {}  # (workspace, slug) -> starts refused at the limit so far
_again: dict[tuple[str, str], bool] = {}  # (workspace, slug) -> whether the start waiting for a free place was Review again


class NoPictures(Exception):
    """view_pictures took none: why, as its error result."""


def key(slug: str) -> str:
    from . import view_tools  # noqa: PLC0415

    return view_tools.review_key(slug)


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
    """Whether a reviewer of the view runs (or waits for its own subagent)."""
    return subagents.running(c, key(slug))


def revising(c: str, slug: str) -> bool:
    """Whether a reviewer may be writing the view's files: while one runs."""
    return running(c, slug)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def review_of(prop: dict[str, Any] | None) -> dict[str, Any]:
    r = (prop or {}).get("review")
    return dict(r) if isinstance(r, dict) else {}


def _set(c: str, slug: str, **fields: Any) -> dict[str, Any]:
    """Merge fields into the proposal's `review` and send `view {slug, status, review}`; nothing once the proposal is
    gone. The `view` event leaves the review's own bookkeeping out (public)."""
    prop = views.read_proposal(c, slug)
    if prop is None:
        return {}
    review = {**review_of(prop), **fields, "ts": _now()}
    views.update_proposal(c, slug, review=review)
    views._emit(c, slug, str(prop.get("status") or "built"), review=public(review))
    return review


def public(review: dict[str, Any]) -> dict[str, Any]:
    """The review as the browser reads it, without the digest and the counts of a round."""
    return {k: v for k, v in review.items() if k not in ("digest", "pictured", "extra_left")}


def _phrase(problem: str) -> str:
    s = " ".join(str(problem).split())
    return s if len(s) <= PHRASE_CHARS else s[: PHRASE_CHARS - 1].rstrip() + "…"


# --------------------------------------------------------------------------- the prompts


def _sections(text: str) -> dict[str, str]:
    marks = [*re.finditer(r"^## (.+?)[ \t]*$", text, re.M)]
    return {m.group(1).strip(): text[m.end():marks[i + 1].start() if i + 1 < len(marks) else len(text)].strip()
            for i, m in enumerate(marks)}


def reviewer_prompt(c: str) -> str:
    """The reviewer's registered prompt: the `review` section of prompts/view-review.md, read with its includes (the
    caller sets the active extensions' change of it, prompts.custom), its slots filled."""
    from . import prompts  # noqa: PLC0415

    text = _sections(prompts.load(PROMPT)).get("review", "")
    return prompts._fill(text, {"rounds": str(ROUNDS), "shots": str(EXTRA_SHOTS)}, f"{PROMPT}.md").strip()


def work_dir(c: str, slug: str) -> Path:
    """The reviewer's own folder: the view's build folder, where its pictures go under review/<round>/."""
    from . import dev  # noqa: PLC0415

    return dev.view_work_dir(c, slug)


def task(c: str, prop: dict[str, Any]) -> str:
    """A review run's prompt (prompts/dev-view-review.md): the view's name and slug, its folder and the reviewer's own,
    and the proposal fenced as data."""
    from . import prompts, view_tools  # noqa: PLC0415

    slug = str(prop["slug"])
    return prompts.render(TASK_PROMPT, {"name": str(prop.get("name") or slug), "slug": slug,
                                        "folder": str(views.views_dir(c) / slug), "work": str(work_dir(c, slug)),
                                        "proposal": view_tools.fenced_proposal(prop)})


# --------------------------------------------------------------------------- starting and stopping


def after_built(c: str, slug: str) -> None:
    """Start the review of a view that just passed its checks: a first build or a change, which is the new version Undo
    goes back to. A reviewer of that view that runs goes on, since it drives its own rounds; one that is being stopped
    is followed by a new review once it ends. A view thimble ships is never reviewed."""
    run = subagents.current(c, key(slug))
    if run is not None:
        if (c, run.agent_id) in _stopping:
            _restart.add((c, slug))
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


def start(c: str, slug: str, again: bool = False, route: str = subagents.FOLLOW_ON) -> bool:
    """Start a review on the server's loop (from a worker thread too); False when one runs. `again` (the analyst's
    Review again, a click) keeps what the review before it revised, and its copy of the view as built."""
    if running(c, slug):
        return False
    from . import dev  # noqa: PLC0415

    dev._soon(lambda: begin(c, slug, again=again, route=route), f"view-review:{c}:{slug}")
    return True


async def begin(c: str, slug: str, *, again: bool = False, route: str = subagents.FOLLOW_ON) -> subagents.Answer:
    """The reviewer's start (subagents.start_job, `thimble:view-reviewer`) on Settings' dev row, the view's copies made
    first: as built for Undo (unless a review before it kept one), and as it is now, restored when a revision fails."""
    prop = views.read_proposal(c, slug)
    if prop is None:
        return subagents.refusal(subagents.ERROR, f"no proposal {slug}")
    if running(c, slug):
        return subagents.refusal(subagents.HOOK, "the view's review is already running")
    before = review_of(prop)
    revised = [str(x) for x in before.get("revised") or []] if again and _reviewed_dir(c, slug).is_dir() else []
    d = views.views_dir(c) / slug
    if not _reviewed_dir(c, slug).is_dir():
        await asyncio.to_thread(_copy_view, d, _reviewed_dir(c, slug))
    await asyncio.to_thread(_copy_view, d, _reviewed_dir(c, slug, last=True))
    work_dir(c, slug).mkdir(parents=True, exist_ok=True)
    _set(c, slug, state="running", round=0, revised=revised, left=[], note="", undo=False, shots=0, agent_id=None,
         chat=None, finished=None, digest=views.digest(d), pictured=None, extra_left=None, refused=None)
    _again[(c, slug)] = again
    if route == subagents.FOLLOW_ON:
        await subagents.out_of_plan(c)
    name = str(prop.get("name") or slug)
    ans = await subagents.start_job(c, REVIEWER, key(slug), task(c, prop), subagents.values_for(c, REVIEWER), route,
                                    description=f"review: {name}",
                                    chat={"title": f"review: {name}", "view": slug, "review": True, "announce": False},
                                    work=work_dir(c, slug))
    if ans.refused and ans.get("request") is None:
        subagent_refused(c, {"kind": "start", "key": key(slug), "reason": ans.reason, "refused_kind": ans.kind})
    return ans


def subagent_started(c: str, run: subagents.Run, req: dict[str, Any]) -> None:
    """A reviewer's run started: the review names its agent and chat."""
    slug = run.key.split(":", 1)[-1]
    _limit_tries.pop((c, slug), None)
    _set(c, slug, state="running", agent_id=run.agent_id, chat=run.chat)


def subagent_refused(c: str, req: dict[str, Any]) -> None:
    """A reviewer's start that did not happen: at Claude Code's subagent limit it waits (`queued`) and is tried again
    LIMIT_RETRY_S later, up to LIMIT_TRIES times, as a build waits in its queue; otherwise, or after the last try, the
    review fails with the refusal, and Review again starts it."""
    if req.get("kind") != "start":
        return
    slug = str(req.get("key") or "").split(":", 1)[-1]
    reason = str(req.get("reason") or req.get("refused_kind") or "")
    if req.get("refused_kind") == subagents.LIMIT and req.get("route") != subagents.TYPED:
        tries = _limit_tries.get((c, slug), 0) + 1
        if tries <= LIMIT_TRIES and _retry(c, slug, str(req.get("route") or subagents.FOLLOW_ON)):
            _limit_tries[(c, slug)] = tries
            _set(c, slug, state="queued", note=QUEUED_NOTE, refused=None)
            return
    _limit_tries.pop((c, slug), None)
    _set(c, slug, state="failed", note=reason, refused={"kind": req.get("refused_kind"), "reason": reason,
                                                        "request": req.get("id")})


def _retry(c: str, slug: str, route: str) -> bool:
    """The review's start tried again in dev.LIMIT_RETRY_S, on the server's loop; False with no loop to wait on."""
    from . import dev  # noqa: PLC0415

    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return False

    def again() -> None:
        if review_of(views.read_proposal(c, slug)).get("state") == "queued" and not running(c, slug):
            start(c, slug, again=_again.get((c, slug), False), route=route)

    loop.call_later(dev.LIMIT_RETRY_S, again)
    return True


def subagent_ended(c: str, run: subagents.Run, status: str, report: str) -> None:
    """A reviewer's run ended: settled in a task (_ended)."""
    from . import view_tools  # noqa: PLC0415

    view_tools.cancel_grace(c, run.agent_id)
    why, forget = _stopping.pop((c, run.agent_id), ("", False))
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        log.warning("%s: no loop settles the end of the review %s", c, run.key)
        return
    loop.create_task(_ended(c, run, status, report, why, forget), name=f"view-review-end:{c}:{run.key}")


async def _ended(c: str, run: subagents.Run, status: str, report: str, why: str, forget: bool) -> None:
    """What a reviewer's end means for its view: a revision it never finished is gated once (views.regate: a pass
    keeps it, a failure undoes it); a review it did not finish ends stopped, failed or done as its run did. A build
    that passed while it was being stopped starts a new review."""
    from . import work_files  # noqa: PLC0415

    slug = run.key.split(":", 1)[-1]
    try:
        prop = views.read_proposal(c, slug)
        review = review_of(prop)
        if prop is None or forget or review.get("agent_id") not in (None, run.agent_id):
            return
        note = ""
        from . import view_tools  # noqa: PLC0415

        taken_over = why == CHANGED_NOTE or subagents.running(c, view_tools.build_key(slug))
        if not review.get("finished") and not taken_over:  # a change's builder owns the folder now
            rep = await views.regate(c, slug)
            if rep is not None and not rep.get("ok"):
                note = REVISION_FAILED_NOTE
            elif rep is not None:
                review = _set(c, slug, revised=[*review.get("revised", []), LEFT_AS_IS])
        if review.get("finished"):
            pass
        elif status == "stopped":
            a = subagents.agent(c, run.agent_id) or {}
            quit_ = a.get("stopped_by") == subagents.STOPPED_QUIT
            plan = a.get("stopped_by") == subagents.STOPPED_PLAN  # main went into plan mode (U4)
            _set(c, slug, state="stopped", note=note or (QUIT_NOTE if quit_ else subagents.plan_line("view-reviewer")
                                                         if plan else why or STOPPED_NOTE))
        elif status == "failed":
            said = " ".join(str(report or "").split())[:400]
            _set(c, slug, state="failed", note=note or (f"The review did not finish: {said}" if said else
                                                        "The review did not finish."))
        else:
            _set(c, slug, state="done", note=note, finished=True)
        work_files.after_run(c, work_dir(c, slug), status)
    except Exception:  # noqa: BLE001
        log.exception("%s: the end of the review of %s was not settled", c, slug)
    finally:
        if forget:
            _drop_copies(c, slug)
        if (c, slug) in _restart:
            _restart.discard((c, slug))
            after_built(c, slug)


def stop(c: str, slug: str, reason: str = STOPPED_NOTE, forget: bool = False) -> bool:
    """Stop the view's reviewer, if one runs, through main's module (subagents.stop); its end gates a revision it left
    unfinished, unless `forget` (the view is replaced or deleted), which leaves no state and no copies behind."""
    from . import dev  # noqa: PLC0415

    run = subagents.current(c, key(slug))
    if run is None:
        if forget:
            _drop_copies(c, slug)
        return False
    _stopping[(c, run.agent_id)] = (reason, forget)
    agent_id = run.agent_id
    dev._soon(lambda: subagents.stop(c, agent_id), f"view-review-stop:{c}:{slug}")
    if forget:
        _drop_copies(c, slug)
    return True


async def shutdown() -> None:
    """Nothing: reviewers are subagents of main, which go on while the server restarts."""


# --------------------------------------------------------------------------- the copies of the view's files


def _reviewed_dir(c: str, slug: str, last: bool = False) -> Path:
    return views.state_dir(c) / REVIEWED_SUBDIR / (f"{slug}.last" if last else slug)


def _copy_view(src: Path, dst: Path) -> None:
    """The view's files at `src`'s top level copied to `dst`, which is emptied first; the cache stays behind."""
    shutil.rmtree(dst, ignore_errors=True)
    dst.mkdir(parents=True, exist_ok=True)
    for p in src.iterdir() if src.is_dir() else []:
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
    review = review_of(views.read_proposal(c, slug))
    if not review.get("revised") or not src.is_dir():
        raise HTTPException(409, "the review revised nothing to undo")
    _restore(c, slug, src)
    views.mark_built(c, slug)
    _drop_copies(c, slug)
    return public(_set(c, slug, revised=[], left=[], undo=True, note=""))


# --------------------------------------------------------------------------- the pictures (view_pictures)


async def shoot(c: str, slug: str, view: dict[str, Any], files: list[tuple[str, int, int]], wanted: list[dict[str, Any]],
                out: Path, first: int = 1) -> list[dict[str, Any]]:
    """Pictures of the states `wanted`, each {state, ref?, controls?, why?}, into the folder `out`: `overview` with no
    label, as the Views bar opens the view in its pane, or one of EXTRA_STATES in its pane. Each result carries its
    state, ref, controls, why and the pane's size; `first` numbers the first picture."""
    out.mkdir(parents=True, exist_ok=True)
    overview = {"ref": None, "path": files[0][0]} if files else {"ref": None}
    stem = f"picture-{int(time.time())}"
    states: list[dict[str, Any]] = []
    for i, w in enumerate(wanted):
        state = str(w.get("state"))
        st: dict[str, Any] = {"out": out / f"{stem}-{first + i}.png", "open": overview, "labels": views.NO_LABELS,
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
    return [{**r, "state": w.get("state"), "ref": w.get("ref"), "controls": w.get("controls"), "why": w.get("why"),
             "size": st["size"]} for w, st, r in zip(wanted, states, got)]


def _unusable(shots: list[dict[str, Any]]) -> str:
    """Why pictures cannot be read: a page that did not load, or one drawn without thimble's fonts; '' when they can."""
    bad = [s for s in shots if not s.get("ok")]
    if bad:
        why = "; ".join(dict.fromkeys(e for s in bad for e in s.get("errors") or [])) or "the page did not load"
        return SHOTS_NOTE.format(why=why[:400])
    if not all(s.get("fonts") for s in shots):
        return FONTS_NOTE
    return ""


def _wanted(states: Any, left: int) -> list[dict[str, Any]]:
    """The extra states asked for, each {state, ref?, controls?, why} of EXTRA_STATES (an `open` with a ref, a `control`
    with the controls to click), `left` at most."""
    more: list[dict[str, Any]] = []
    for m in states if isinstance(states, list) else []:
        if not isinstance(m, dict) or m.get("state") not in EXTRA_STATES:
            continue
        if m["state"] == "open" and not m.get("ref"):
            continue
        controls = [" ".join(str(x).split()) for x in m.get("controls") or [] if str(x).strip()][:CONTROLS_CLICKED]
        if m["state"] == "control" and not controls:
            continue
        more.append({"state": m["state"], "ref": str(m.get("ref") or "") or None, "controls": controls or None,
                     "why": " ".join(str(m.get("why") or "").split())})
    return more[:max(0, left)]


async def pictures(c: str, slug: str, agent_id: str, states: Any) -> tuple[str, str, str]:
    """view_pictures for the reviewer `agent_id`: in a round's first call the overview, then the states asked for, up
    to EXTRA_SHOTS a round, into views-work/<slug>/review/<round>/. (The pictures' lines, each its number, path and
    what it shows, then what the checks found; the records the pages fetched; what an extension's program that replaces
    the view-review task found in them, program_reading.) NoPictures for none, or for a program that failed."""
    prop = views.read_proposal(c, slug)
    view = views.read_view(c, slug)
    if prop is None or view is None:
        raise NoPictures(f"view_pictures: the view {slug} is gone")
    if headless.missing(headless.PAGES):
        raise NoPictures(NO_BROWSER_NOTE)
    review = review_of(prop)
    rnd = int(review.get("round") or 0)
    same_round = review.get("pictured") == rnd and review.get("extra_left") is not None
    left = int(review["extra_left"]) if same_round else EXTRA_SHOTS
    wanted: list[dict[str, Any]] = [] if review.get("pictured") == rnd else [{"state": "overview"}]
    wanted += _wanted(states, left)
    if not wanted:
        raise NoPictures(NO_MORE.format(n=EXTRA_SHOTS))
    files = await asyncio.to_thread(views.claimed_files, c, view)
    done = int(review.get("shots") or 0)
    with views.live_reads():  # the reviewer looks at its own revision, which no gate has passed yet
        shots = await shoot(c, slug, view, files, wanted, work_dir(c, slug) / "review" / str(rnd + 1), first=done + 1)
    if any(s.get("unavailable") for s in shots):
        raise NoPictures(NO_BROWSER_NOTE)
    if why := _unusable(shots):
        raise NoPictures(why)
    extra = sum(1 for w in wanted if w["state"] != "overview")
    _set(c, slug, pictured=rnd, extra_left=left - extra, shots=done + sum(1 for s in shots if s.get("png")))
    lines = [f"{i}: {s['png']} ({_about(s)})" for i, s in enumerate(shots, done + 1) if s.get("png")]
    if shots and shots[0].get("controls") and shots[0].get("state") == "overview":
        lines.append(f"The controls picture {done + 1} shows, by their text: "
                     + "; ".join(str(x) for x in shots[0]["controls"]))
    checks = views.gate_notes(c, slug)
    if checks:
        lines += ["", "What the view's checks found:", *checks]
    return "\n".join(lines), records_text(shots) or "-", await program_reading(c, slug, agent_id, prop, view, shots)


def review_input(c: str, prop: dict[str, Any], view: dict[str, Any], shots: list[dict[str, Any]]) -> dict[str, Any]:
    """The view-review task's input (tasks.py, docs/agents.md): the view (its name, description, the files it claims,
    its spec and what its checks found), each picture's path and what it shows (_about), the controls the first picture
    shows, the first records the pages fetched, and `ask` false, since the reviewer asks for more pictures itself."""
    return {"view": {"slug": str(view["slug"]), "name": str(prop.get("name") or view["name"]),
                     "description": str(prop.get("why") or view["description"]),
                     "claims": [str(x) for x in prop.get("claims") or view["claims"]], "spec": views.spec_lines(prop),
                     "checks": list(views.gate_notes(c, view["slug"]))},
            "pictures": [{"path": str(s["png"]), "about": _about(s)} for s in shots if s.get("png")],
            "controls": [str(x) for x in (shots[0].get("controls") or [])] if shots else [],
            "records": records_text(shots), "ask": False}


async def program_reading(c: str, slug: str, agent_id: str, prop: dict[str, Any], view: dict[str, Any],
                          shots: list[dict[str, Any]]) -> str:
    """'' when thimble's reviewer reads the pictures `shots` itself; else the problems that the program of the one
    extension that replaces the view-review task here (tasks.program) found in them, as the reviewer's hint. A program
    that fails, or answers with no list of problems, ends the review failed (PROGRAM_FAILED_NOTE): NoPictures."""
    from . import tasks, tools, view_tools  # noqa: PLC0415

    part = tasks.program(c, TASK)
    if part is None:
        return ""
    res = await tasks.call(c, TASK, review_input(c, prop, view, shots), schema=PROGRAM_SCHEMA)
    if res.status != "ok" or not isinstance(res.output, dict):
        why = " ".join(str(res.detail or f"it ended {res.status}").split())[:400]
        _set(c, slug, state="failed", note=PROGRAM_FAILED_NOTE.format(extension=part.extension, why=why), finished=True)
        view_tools.stop_after_grace(c, key(slug), agent_id)
        raise NoPictures(tools.hint("view-review-program-failed", extension=part.extension, why=why))
    problems = [" ".join(str(p).split()) for p in res.output.get("problems") or [] if str(p).strip()]
    return tools.hint("view-review-program", extension=part.extension,
                      problems="\n".join(f"- {p}" for p in problems) or "- none")


def _about(s: dict[str, Any]) -> str:
    """What one picture shows, and how its text fits as layout_notes words it."""
    words = {"overview": "the view as it opens, with no label on", "labels": "the overview with the test label on",
             "filtered": "the overview filtered to the test label", "detail": "the place the first citation opens",
             "open": "the place {ref} opens, with the test label on", "wide": "the view as it opens",
             "narrow": "the view as it opens, with no label on", "control": "the overview after clicking {controls}"}
    clicked = [a for a in s.get("actions") or [] if isinstance(a, dict)]
    controls = ", then ".join(repr(a.get("control")) + ("" if a.get("found") else " (not found)") for a in clicked)
    what = words.get(str(s.get("state")), words["overview"]).format(ref=s.get("ref") or "the ref",
                                                                     controls=controls or "nothing")
    lay = s.get("layout") if isinstance(s.get("layout"), dict) else {}
    size = s.get("size") or views.PANE_SIZE
    line = f"{what}, {size[0]} px wide" + (f", asked for: {s['why']}" if s.get("why") else "")
    fit = views.layout_parts(lay, wide=s.get("state") == "wide") if s.get("ok") else []
    if (n := int(lay.get("outside") or 0)) and s.get("ok"):
        fit.append(views._hint("view-layout-outside", n=f"{n:,}", of=f"{int(lay.get('anchored') or 0):,}"))
    return line + (f". Measured: {'; '.join(fit)}" if fit else "")


def records_text(shots: list[dict[str, Any]]) -> str:
    """The first reader answers of each picture's page, as JSON, RECORDS_CHARS at most in all."""
    parts = []
    for i, s in enumerate(shots, 1):
        for a in (s.get("answers") or [])[:ANSWERS_PER_STATE]:
            parts.append(f"picture {i}: {json.dumps(a, ensure_ascii=False, default=str)}")
    text = "\n".join(parts)
    return text if len(text) <= RECORDS_CHARS else text[: RECORDS_CHARS - 1] + "…"


# --------------------------------------------------------------------------- a round's end (finish_review)


async def finish(c: str, slug: str, agent_id: str, revised: list[str], left: list[str]) -> str | None:
    """finish_review for the reviewer `agent_id`: the hint its result is. Files unchanged since the round began: the
    review is done (`finish-review-done`). A revision: the gate runs, and a pass keeps it (views.mark_built), counts the
    round and asks for another look before ROUNDS rounds (`finish-review-again`), else ends the review; a failure puts
    the view back as it was before the round (`finish-review-restored`). A call after the review ended runs nothing.
    None when the reviewer was stopped while the gate ran, which then registers nothing."""
    from . import dev, view_tools  # noqa: PLC0415

    prop = views.read_proposal(c, slug)
    review = review_of(prop)
    if prop is None or review.get("finished"):
        return "finish-review-done"
    d = views.views_dir(c) / slug
    done_before = [str(x) for x in review.get("revised") or []]
    if views.digest(d) == review.get("digest"):
        _set(c, slug, state="done", left=[_phrase(x) for x in [*revised, *left]], revised=done_before, finished=True)
        view_tools.stop_after_grace(c, key(slug), agent_id)
        return "finish-review-done"
    rep = await views.gate(c, slug, views._kept_locators(c, slug))
    if not view_tools.still_running(c, key(slug), agent_id):
        return None
    dev.gate_step(c, slug, rep, chat=review.get("chat"))
    if not rep.get("ok"):
        _restore(c, slug, _reviewed_dir(c, slug, last=True))
        views.mark_built(c, slug)
        _set(c, slug, state="done", note=REVISION_FAILED_NOTE, revised=done_before,
             left=[_phrase(x) for x in [*revised, *left]], finished=True, digest=views.digest(d))
        view_tools.stop_after_grace(c, key(slug), agent_id)
        return "finish-review-restored"
    views.mark_built(c, slug)
    await asyncio.to_thread(_copy_view, d, _reviewed_dir(c, slug, last=True))
    rnd = int(review.get("round") or 0) + 1
    now = [*done_before, *(_phrase(x) for x in revised or [LEFT_AS_IS])]
    if rnd < ROUNDS:
        _set(c, slug, state="running", round=rnd, revised=now, left=[_phrase(x) for x in left], digest=views.digest(d))
        return "finish-review-again"
    _set(c, slug, state="done", round=rnd, revised=now, left=[_phrase(x) for x in left], finished=True,
         digest=views.digest(d))
    view_tools.stop_after_grace(c, key(slug), agent_id)
    return "finish-review-done"


# --------------------------------------------------------------------------- the view-review task


async def review_task(c: str, inp: dict[str, Any], *, model: str | None = None, **_: Any) -> Any:
    """The view-review task's own implementation (tasks.py), which a program that replaces the task is lent as
    `thimble.default(input)`: the review is a subagent with pictures and tools now, so there is no one-call reading to
    lend, and the call fails. The task's prompt part,
    the `review` section of prompts/view-review.md, is the reviewer's registered prompt, which an extension's prompt
    still changes (view_tools.reviewer_definition)."""
    from . import model as model_mod  # noqa: PLC0415

    return model_mod.CallResult(status="error", detail="thimble's view review runs as a subagent, with no one-call "
                                                       "reading to run")


# --------------------------------------------------------------------------- routes

router = APIRouter()


def _review_view(c: str, slug: str) -> dict[str, Any]:
    config.workspace_dir(c)
    view = views.read_built(c, slug)
    if view is None or view.get("origin") != "workspace" or views.read_proposal(c, slug) is None:
        raise HTTPException(404, f"no reviewable view: {slug}")
    return view


@router.post("/ws/{c}/views/{slug}/review")
async def again_route(c: str, slug: str, request: Request) -> dict[str, Any]:
    """Review again, a click: a reviewer starts through main's module on Settings' dev row (begin). Answers the module's
    answer, or the refusal's {kind, reason}; 409 while a review runs."""
    subagents.analyst_only(request)
    _review_view(c, slug)
    views._bind_loop()
    if running(c, slug):
        raise HTTPException(409, "the view's review is already running")
    ans = await begin(c, slug, again=True, route=subagents.CLICK)
    return {"ok": not ans.refused, **dict(ans), **({"kind": ans.kind, "reason": ans.reason} if ans.refused else {})}


@router.delete("/ws/{c}/views/{slug}/review")
async def stop_route(c: str, slug: str, request: Request) -> dict[str, Any]:
    """Stop the view's reviewer, a click."""
    subagents.analyst_only(request)
    _review_view(c, slug)
    views._bind_loop()
    return {"ok": stop(c, slug)}


@router.post("/ws/{c}/views/{slug}/review/undo")
async def undo_route(c: str, slug: str) -> dict[str, Any]:
    """Put the view back as it was built before the review revised it."""
    _review_view(c, slug)
    return {"ok": True, "review": await asyncio.to_thread(undo, c, slug)}
