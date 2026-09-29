"""The card check: once a card has its takeaway, it is drawn offscreen, one model reading of the picture assesses it
against five criteria (prompts/card-check.md) and gives the card that replaces it, and the replacement is applied in
place, with Undo. Nothing of the check goes back to the card's author. Label cards are drawn from their label and get
no reading.

tools.call hands every thimble tool result to after_tool(); an add_card or edit_card result starts a check of its card
when wants_check() holds and the workspace's automatic check is on (settings.json `card_check`). A new change to the
card cancels a running check and starts the next. At most READ_CONCURRENCY readings run at once. Each check:
1. Draw: render.render_card shoots the card with the app's own card face; a card that did not draw ends the check
   `error`. Where no card can be drawn (render.down), no check begins, and one that began is taken off the card.
2. Critique: the `verify` role's model reads the question, takeaway, resolved links, code, the work that led to the
   card (context.render) and the picture, names what fails each criterion, and gives the replacement card.
3. Replace: the parts that differ and that the check may change (checkstore.fixable) are tried on a copy of the card
   and kept only when the code runs clean and the card draws, as one undo step with actor `check`.
A check past check_timeout(effort) ends `error`; waits for API capacity are left out of that time. A trial run on the
kernel is always settled, even when the check is stopped mid-trial. Timings go to
workspaces/<c>/card-checks/timings.jsonl and pictures under workspaces/<c>/card-checks/<card>/. A refused reading
runs again on the fallback model, and the record's `note` says so (FALLBACK_NOTE).
"""
from __future__ import annotations

import asyncio
import contextlib
import contextvars
import io
import json
import logging
import os
import re
import time
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from . import config, render, retry

log = logging.getLogger("thimble.card_check")

PROMPT = "card-check"
CHECK_TOOLS = ("add_card", "edit_card")
# card-check.md's five criteria. The reading states what fails each (empty when the card meets it) rather than a yes or
# no per question, since a problem statement has no polarity to misread.
CRITERIA = 5
# How long a check may run, from its drawing to its replacement's, by the effort it reads the card at (read_effort).
# A check past its time ends `error` with no mark. The drawing and the replacement's run keep their own limits
# (render.RENDER_TIMEOUT_S, the card's timeout_s).
CHECK_TIMEOUT_S = {"low": 45.0, "medium": 45.0, "high": 75.0, "xhigh": 120.0, "max": 180.0}
# How many readings run at once; a check waiting for one is `queued`, its clock stopped (_slot). The drawing and the
# revision run outside the slots.
READ_CONCURRENCY = max(1, int(os.environ.get("THIMBLE_CARD_CHECK_CONCURRENCY", "4") or "4"))
# After model.structured has spent its own retries on a capacity failure, the check waits these many seconds outside
# its slot and reads the card again; with the waits spent it ends `error`, saying the API was at capacity.
CAPACITY_WAITS_S = (30.0, 60.0, 120.0)
CAPACITY = ("overloaded", "rate_limited")  # the classes of retry.transient_class that mean the API is at capacity
CAPACITY_WORDS = {"overloaded": "Anthropic's API is overloaded", "rate_limited": "Anthropic's API rate limit was reached"}
AUTO_KEY = "card_check"  # settings.json: false turns the automatic check off for the workspace
TIMINGS_FILE = "timings.jsonl"  # under SHOTS_DIR: one line per finished check
# the reasons a check ends `stopped`, which the check mark's hover shows
STOPPED = ""  # the analyst stopped it: the hover says only when
AUTO_OFF = "the automatic card check was turned off"
CHANGED = "the card changed while it was checked"
SERVER_STOPPED = "the server stopped while the check ran"
FALLBACK_NOTE = "Downgrading {model} to {fallback}"  # the record's `note`
READ_IDLE_S = 60.0  # a reading with no sign of life this long is stalled (model.structured's idle clock)
PAUSE_POLL_S = 0.05  # how often a check waiting for a reading slot looks at its clock again (_within)
MAX_EDGE = 2576  # the longest edge of an image the model reads at full resolution
CONTEXT_CHARS = 30_000  # of the author's work before the card: enough for the request and the work behind the card
CODE_CHARS = 6000  # of the card's code the reading sees; a longer code is never replaced, since the reading saw part
CITE_CHARS = 400
SHOTS_DIR = "card-checks"
TIMINGS_KEPT = 500
MAIN = "main"  # the author key of main's shim, its forks and subagents (author_of)

_runs: dict[tuple[str, str], "_Run"] = {}
_timings: deque[dict[str, Any]] = deque(maxlen=TIMINGS_KEPT)
_read_sem: asyncio.Semaphore | None = None
_read_sem_loop: asyncio.AbstractEventLoop | None = None
_cleanup: set[asyncio.Task] = set()  # trial settles that outlive a stopped check
_current: contextvars.ContextVar["_Run | None"] = contextvars.ContextVar("card_check_run", default=None)


def enabled() -> bool:
    """THIMBLE_CARD_CHECK unset or on (the test suite turns it off in conftest.py)."""
    return os.environ.get("THIMBLE_CARD_CHECK", "on").strip().lower() not in ("0", "off", "false", "no")


def auto(c: str) -> bool:
    """Whether a card add_card or edit_card wrote is checked by itself in workspace `c`: settings.json `card_check`,
    on unless the analyst turned it off (auto_route)."""
    from . import ledger  # noqa: PLC0415

    try:
        return ledger.stored_settings(c).get(AUTO_KEY) is not False
    except Exception:  # noqa: BLE001 — an unreadable settings file leaves the check on, as a fresh workspace has it
        return True


@dataclass
class _Run:
    c: str
    cid: str
    author: str
    check: str
    task: asyncio.Task | None = None
    t0: float = field(default_factory=time.perf_counter)
    effort: str = ""  # the effort the card is read at (read_effort), resolved once when the check starts
    timing: dict[str, Any] = field(default_factory=dict)  # the check's times, for status_route
    phase: str = "queued"  # checkstore.PHASES, as the record says
    deadline: float = 0.0  # loop time the check's slot runs out at; model.structured's retry waits push it back
    outcome: str = ""  # how the check ended, for its timing: its record's status, or why it was cancelled
    reason: str = ""  # why it ended `error` or `stopped`
    waited: float = 0.0  # seconds spent waiting for API capacity, left out of the check's time
    note: str = ""  # FALLBACK_NOTE when the reading ran on the fallback model, kept on the finished record
    paused_at: float | None = None  # loop time it began to wait for a reading slot, while it waits (_slot)


# --------------------------------------------------------------------------- the tool path


def author_of(session: str | None) -> str:
    """Whose work led to a card, for the context the reading gets: the caller's session key, `main` for main's shim (its
    forks and subagents too)."""
    return session or MAIN


_CARD_LINE = re.compile(r"^card:([A-Za-z0-9_-]+)\s*$", re.M)
_NOTED = re.compile(r"takeaway noted on card:([A-Za-z0-9_-]+)")


def card_of(name: str, args: dict[str, Any] | None, text: str, anchor: str | None = None) -> str | None:
    """The card an add_card or edit_card result made or changed: the `card:<id>` line the result opens its card's part
    with, the card a takeaway was noted on, else edit_card's `card` argument or the thread's anchor."""
    if name not in CHECK_TOOLS:
        return None
    m = _CARD_LINE.search(text) or _NOTED.search(text)
    if m:
        return m.group(1)
    if name == "edit_card":
        raw = str((args or {}).get("card") or (args or {}).get("cell") or anchor or "").strip().strip("[]")
        raw = re.sub(r"^(?:card|cell):", "", raw).split("#", 1)[0].split("@", 1)[0]
        return raw or None
    return None


def wants_check(cell: dict[str, Any] | None) -> bool:
    """Whether a card is read now: it has a takeaway, it is not a label card (thimble draws those from their label), a
    replacement could change it (it is not locked or made by the analyst: checkstore.fixable), and a card of code ran
    clean (an errored card goes back to its author through its own result)."""
    from . import checkstore, notebook  # noqa: PLC0415

    if not cell or cell.get("kind") == "label" or not str(cell.get("takeaway") or "").strip():
        return False
    if not checkstore.fixable(cell, checkstore.FIX_FIELDS):
        return False
    return cell.get("status") == "ok" if notebook.runnable(cell) else True


async def after_tool(c: str, name: str, args: dict[str, Any] | None, res: Any, *, session: str | None = None,
                     anchor: str | None = None) -> Any:
    """Called by tools.call with every result: starts the check of the card an add_card or edit_card result names. The
    result goes back unchanged, since nothing of the check reaches the card's author. Never raises."""
    if not enabled() or name not in CHECK_TOOLS:
        return res
    try:
        cid = card_of(name, args, res.text, anchor) if not res.is_error else None
        if cid and auto(c):
            start(c, cid, author_of(session))
    except Exception:  # noqa: BLE001 — the check never breaks a tool call
        log.exception("card check: after_tool failed for %s", name)
    return res


def start(c: str, cid: str, author: str, *, again: bool = False) -> _Run | None:
    """Begin a check of card `cid` for `author`; None when the card gets none (wants_check, checkstore.begin). A running
    check of the same card is cancelled first. `again` re-reads a card already read as it stands (again_route)."""
    from . import checkstore, notebook  # noqa: PLC0415

    old = _runs.pop((c, cid), None)
    if old is not None and old.task is not None and not old.task.done():
        old.outcome = "superseded"
        old.task.cancel()
    try:
        if render.down() or not wants_check(notebook.get_cell(c, cid)):
            checkstore.drop_stale(c, cid)
            return None
        check = checkstore.begin(c, cid, author=author, again=again)
    except Exception:  # noqa: BLE001
        log.exception("card check: begin failed for card:%s", cid)
        return None
    if not check:
        return None
    run = _Run(c, cid, author, str(check))
    _runs[(c, cid)] = run
    run.task = asyncio.get_running_loop().create_task(_guarded(run), name=f"card-check-{cid}")
    return run


def check_timeout(effort: str) -> float:
    """How long a check that reads its card at `effort` may run (CHECK_TIMEOUT_S); the longest time for a level the table
    does not name."""
    return CHECK_TIMEOUT_S.get(effort, max(CHECK_TIMEOUT_S.values()))


class _Capacity(Exception):
    """The reading failed because the API is at capacity after model.structured's own retries: the check waits and
    reads again (CAPACITY_WAITS_S)."""


class _PastTime(Exception):
    """The check ran past its deadline (_within)."""


def _ms(t0: float) -> int:
    return round((time.perf_counter() - t0) * 1000)


def _iso_in(seconds: float) -> str:
    return (datetime.now(timezone.utc) + timedelta(seconds=seconds)).isoformat(timespec="seconds")


def _phase(run: _Run, name: str, **kw: Any) -> bool:
    """Put the check in phase `name` on its record (checkstore.phase); False when the record is stale."""
    from . import checkstore  # noqa: PLC0415

    ok = checkstore.phase(run.c, run.cid, run.check, name, **kw)
    if ok:
        run.phase = name
    return ok


def _end(run: _Run, status: str, reason: str = "") -> None:
    """End the check's record `status` with `reason`; when the record is stale because the card changed under the check, the
    record is ended `stopped` saying so."""
    from . import checkstore  # noqa: PLC0415

    run.outcome, run.reason = status, reason
    if checkstore.finish(run.c, run.cid, run.check, status, reason, note=run.note):
        return
    if checkstore.end_pending(run.c, run.cid, "stopped", CHANGED, check_id=run.check):
        run.outcome, run.reason = "stopped", CHANGED


def _gone(run: _Run) -> None:
    """The card changed under the check (a stage or a revision was refused as stale): its record ends `stopped` unless
    a newer check has begun on it."""
    from . import checkstore  # noqa: PLC0415

    if checkstore.end_pending(run.c, run.cid, "stopped", CHANGED, check_id=run.check):
        run.outcome, run.reason = "stopped", CHANGED
    elif not run.outcome:
        run.outcome = "superseded"


async def _within(run: _Run, coro: Any, limit: float) -> Any:
    """Await `coro` until the check's deadline, `limit` seconds from now and pushed back by each retry wait
    model.structured reports (_on_retry); _PastTime past it, the work cancelled."""
    loop = asyncio.get_running_loop()
    run.deadline = loop.time() + limit
    task = asyncio.ensure_future(coro)
    try:
        while not task.done():
            if run.paused_at is not None:  # waiting for a reading slot: the clock stands (_slot)
                await asyncio.wait({task}, timeout=PAUSE_POLL_S)
                continue
            left = run.deadline - loop.time()
            if left <= 0:
                raise _PastTime
            await asyncio.wait({task}, timeout=left)
        return task.result()
    finally:
        if not task.done():
            task.cancel()
            with contextlib.suppress(BaseException):
                await task


def _on_retry(run: _Run) -> Any:
    """model.structured's on_retry for the check's reading: the wait is added to the check's deadline, and the record
    says the check waits for capacity until then, back to `checking` once the wait is over."""

    def heard(n: int, wait: float, cls: str, exc: BaseException | None) -> None:
        run.deadline += wait
        run.waited += wait
        if _phase(run, "waiting", until=_iso_in(wait), note=CAPACITY_WORDS.get(cls, f"the API answered {cls}")):
            asyncio.get_running_loop().call_later(wait, lambda: run.phase == "waiting" and _phase(run, "checking"))

    return heard


def _on_fallback(run: _Run) -> Any:
    """model.structured's on_fallback for the check's reading: the time the refused reading took is added to the
    check's deadline, so the reading on the fallback model gets the check's whole time."""

    def heard(spent: float) -> None:
        run.deadline += spent

    return heard


async def _guarded(run: _Run) -> None:
    """The whole check: the check within its time (the wait for a reading slot left out of it, _slot), the waits for
    capacity outside the slot, and its record ended however the check ends."""
    token = _current.set(run)
    try:
        cell = notebook_cell(run.c, run.cid) or {}
        run.effort = await asyncio.to_thread(read_effort, run.c)
        waits = list(CAPACITY_WAITS_S)
        while True:
            if not _phase(run, "checking"):
                _gone(run)
                return
            try:
                await _within(run, _check(run), check_timeout(run.effort))
                return
            except _Capacity as e:
                why = str(e)
            if not waits:
                _end(run, "error", f"{why}, and it still was after {len(CAPACITY_WAITS_S)} more tries")
                return
            wait = waits.pop(0)
            run.waited += wait
            log.info("card check: card:%s waits %.0f s for capacity (%s)", run.cid, wait, why)
            if not _phase(run, "waiting", until=_iso_in(wait), note=why):
                _gone(run)
                return
            await asyncio.sleep(wait)
    except asyncio.CancelledError:
        if not run.outcome:
            run.outcome = "cancelled"
        raise
    except _PastTime:
        limit = check_timeout(run.effort)
        log.warning("card check: card:%s ran past %.0f s at %s effort", run.cid, limit, run.effort)
        run.timing["timed_out_s"] = limit
        _end(run, "error", f"it ran past its {limit:.0f} s at {run.effort or 'default'} effort")
    except Exception as e:  # noqa: BLE001
        log.exception("card check: card:%s failed", run.cid)
        _end(run, "error", f"{type(e).__name__}: {e}")
    finally:
        _current.reset(token)
        if _runs.get((run.c, run.cid)) is run:
            _runs.pop((run.c, run.cid), None)
        _log_timing(run)


def notebook_cell(c: str, cid: str) -> dict[str, Any] | None:
    from . import notebook  # noqa: PLC0415

    return notebook.get_cell(c, cid)


def _log_timing(run: _Run) -> None:
    """The check's times, kept in memory for status_route and appended to the workspace's timings file, once per check;
    a check that never began its work (superseded while queued) leaves no line."""
    t = run.timing
    if not t or t.get("logged"):
        return
    t["logged"] = True
    t.setdefault("card", run.cid)
    t.update(ws=run.c, check=run.check, outcome=run.outcome or "unknown", total_ms=_ms(run.t0))
    if run.reason:
        t["reason"] = run.reason
    if run.waited:
        t["capacity_wait_s"] = round(run.waited, 2)
    _timings.append(t)
    try:
        d = config.workspace_dir(run.c) / SHOTS_DIR
        d.mkdir(parents=True, exist_ok=True)
        with (d / TIMINGS_FILE).open("a", encoding="utf-8") as f:
            f.write(json.dumps({k: v for k, v in t.items() if k != "logged"}, ensure_ascii=False, default=str) + "\n")
    except (OSError, ValueError):  # a workspace removed meanwhile keeps its line in memory only
        log.debug("card check: timing of card:%s not written", run.cid, exc_info=True)


def running(c: str, author: str | None = None) -> list[_Run]:
    return [r for (cc, _), r in list(_runs.items()) if cc == c and (author is None or r.author == author)
            and r.task is not None and not r.task.done()]


def stop(c: str, cid: str, reason: str = STOPPED) -> bool:
    """Stop the check of card `cid`: its task cancelled (a trial it ran on the kernel is still settled, _replace) and its
    record ended `stopped` with `reason`; a record left pending with no task behind it ends too. False when the card
    has no pending check."""
    from . import checkstore  # noqa: PLC0415

    run = _runs.pop((c, cid), None)
    live = run is not None and run.task is not None and not run.task.done()
    if run is not None and live:
        run.outcome, run.reason = "stopped", reason
        run.task.cancel()
    ended = checkstore.end_pending(c, cid, "stopped", reason)
    return ended or live


def stop_all(c: str, reason: str = STOPPED) -> list[str]:
    """Stop every check of workspace `c` (stop); the cards whose check stopped."""
    return [r.cid for r in running(c) if stop(c, r.cid, reason)]


# --------------------------------------------------------------------------- the check


def _shot_path(c: str, cid: str, name: str) -> Path:
    d = config.workspace_dir(c) / SHOTS_DIR / cid
    d.mkdir(parents=True, exist_ok=True)
    return d / name


def _keep(c: str, cid: str, name: str, png: bytes | None) -> str | None:
    """A picture kept under the workspace; its path relative to the workspace, None when there is none."""
    if not png:
        return None
    p = _shot_path(c, cid, name)
    p.write_bytes(png)
    return str(p.relative_to(config.workspace_dir(c)))


async def _draw(c: str, cell: dict[str, Any]) -> render.Rendered | None:
    """The card drawn by the harness; None when the harness cannot run here."""
    try:
        return await render.render_card(c, cell)
    except render.Unavailable as e:
        log.debug("card check: no picture of card:%s (%s)", cell.get("id"), e)
        return None


async def _check(run: _Run) -> None:
    from . import checkstore, notebook  # noqa: PLC0415

    c, cid = run.c, run.cid
    cell = notebook.get_cell(c, cid)
    if cell is None:
        _end(run, "error", "the card is gone")
        return
    timing = run.timing
    timing.update(card=cid, kind=cell.get("kind"), ts=time.time(), effort=run.effort)
    t0 = time.perf_counter()
    drawn = await _draw(c, cell)
    timing["render_ms"] = _ms(t0)
    if drawn is None:
        run.outcome = "skipped"
        checkstore.discard(c, cid, run.check)
        return
    if not drawn.ok:
        if not checkstore.stage(c, cid, run.check, "render", {"status": "error", "ms": timing["render_ms"],
                                                              "message": drawn.error}):
            _gone(run)
            return
        _end(run, "error", f"the card did not draw: {drawn.error}")
        return
    typed = (typed_numbers(str(cell.get("code") or ""), shown_numbers(notebook.get_cell(c, cid, full_outputs=True) or cell))
             if cell.get("code") else [])
    if typed:
        timing["typed"] = len(typed)
        log.info("card check: card:%s shows numbers its code types in: %s", cid, ", ".join(typed))
    if not checkstore.stage(c, cid, run.check, "render", {
            "status": "ok", "ms": timing["render_ms"],
            **({"image": p} if (p := _keep(c, cid, f"{run.check}-card.png", drawn.png)) else {}),
            **({"typed": typed} if typed else {})}):
        _gone(run)
        return
    tr = time.perf_counter()
    reading = await _read(c, cell, drawn.png, run)
    timing["critique_ms"] = _ms(tr)
    if isinstance(reading, str):
        if not checkstore.stage(c, cid, run.check, "critique", {"status": "error", "ms": timing["critique_ms"],
                                                                "effort": run.effort, "message": reading}):
            _gone(run)
            return
        _end(run, "error", reading)
        return
    assessment, card, model_used = reading
    failed = _failed(assessment)
    timing["failed"] = len(failed)
    if not checkstore.stage(c, cid, run.check, "critique", {"status": "ok", "ms": timing["critique_ms"],
                                                            "effort": run.effort, "assessment": assessment,
                                                            "model": model_used}):
        _gone(run)  # the card changed while the model read it; a change by a tool began the next check
        return
    patch = _patch(cell, card, notebook.get_cell(c, cid, full_outputs=True))
    if patch and not failed:
        # a card that meets every criterion stays as it is: the prompt asks for changes only to what fails one
        log.info("card check: card:%s failed no criterion, so its replacement's changes to %s were not applied", cid,
                 ", ".join(sorted(patch)))
        timing["not_applied"] = sorted(patch)
        patch = {}
    timing["changed"] = sorted(patch)
    if patch:
        await _replace(run, cell, patch, failed, timing)
    else:
        _end(run, "ok")


# --------------------------------------------------------------------------- an author's edit after a fix


def _merge3(base: list[str], ours: list[str], theirs: list[str]) -> list[str] | None:
    """Two changes of `base` in one: `ours` and `theirs` each change some stretches of it, and the result takes the
    changes of both. None when a stretch one changed overlaps a stretch the other changed differently, or both insert
    at the same place, since neither can then be applied without guessing; the same change made by both is taken
    once."""
    from difflib import SequenceMatcher  # noqa: PLC0415

    def changes(other: list[str], side: int) -> list[tuple[int, int, tuple[str, ...], int]]:
        ops = SequenceMatcher(a=base, b=other, autojunk=False).get_opcodes()
        return [(i1, i2, tuple(other[j1:j2]), side) for tag, i1, i2, j1, j2 in ops if tag != "equal"]

    mine, yours = changes(ours, 0), changes(theirs, 1)
    for a1, a2, ra, _ in mine:
        for b1, b2, rb, _ in yours:
            if (a1, a2, ra) == (b1, b2, rb):
                continue
            crossed = max(a1, b1) < min(a2, b2)
            same_spot = a1 == a2 == b1 == b2
            inside = (a1 == a2 and b1 < a1 < b2) or (b1 == b2 and a1 < b1 < a2)
            if crossed or same_spot or inside:
                return None
    out: list[str] = []
    pos = 0
    done: set[tuple[int, int, tuple[str, ...]]] = set()
    for i1, i2, repl, _ in sorted(mine + yours, key=lambda ch: (ch[0], ch[1], ch[3])):
        if (i1, i2, repl) in done:
            continue
        done.add((i1, i2, repl))
        out.extend(base[pos:i1])
        out.extend(repl)
        pos = max(pos, i2)
    out.extend(base[pos:])
    return out


def merge_edit(field: str, before: str, after: str, new: str) -> str | None:
    """An author's edit of a card's `field` (`title`, `code` or `takeaway`) that the card check had rewritten, written against
    the card before the fix (`before`): a three-way merge of the author's change onto the check's version (`after`), word by
    word for text and line by line for code. None when the changes overlap or the merge equals either side, so the caller
    keeps the author's value as given."""
    def split(text: str) -> list[str]:
        # words and marks apart, so a clause added before a comma and a fix that changed the comma both apply
        return text.splitlines(keepends=True) if field == "code" else re.findall(r"\s+|\w+|[^\w\s]", text)

    merged = _merge3(split(before or ""), split(after or ""), split(new or ""))
    if merged is None:
        return None
    text = "".join(merged)
    return None if text.strip() in ((new or "").strip(), (after or "").strip()) else text


# --------------------------------------------------------------------------- numbers typed into the code

# A card whose code types in the numbers it shows shows numbers nothing on the card computes, so no rerun can catch one
# that is wrong. The check flags them on its record (the render stage's `typed`), and the card's check mark shows it.
# How many numbers one list, tuple, set or dict of the code must hold, and how many of them the card must show, for its
# numbers to count as typed in rather than as settings of the code.
TYPED_MIN = 3
TYPED_KEPT = 12  # how many of the typed numbers the record keeps, in the code's order
# keyword arguments and calls whose numbers are a chart's or a computation's settings (sizes, ticks, limits, bins,
# steps), not the card's data
SETTING_KEYWORDS = frozenset({
    "figsize", "bins", "xticks", "yticks", "xlim", "ylim", "extent", "rect", "ticks", "levels", "range", "dpi",
    "width_ratios", "height_ratios", "domain", "bbox_to_anchor", "loc", "color", "colors", "linewidth", "lw", "alpha",
    "margins", "pad", "size", "sizes", "percentiles", "q", "quantiles", "labels_pad", "scheme", "zorder",
})
SETTING_CALLS = frozenset({
    "set_xticks", "set_yticks", "xticks", "yticks", "set_xlim", "set_ylim", "xlim", "ylim", "subplots_adjust",
    "set_position", "axis", "arange", "linspace", "percentile", "quantile", "cut", "qcut", "figure", "subplots",
    "add_axes", "range", "clip", "round", "isin", "between", "digitize", "histogram", "set_size_inches",
})
# a number as text: with thousands separators (3,017), or plain (3017, 0.25), a minus before it or not
_NUM_TEXT = re.compile(r"-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|-?\d+(?:\.\d+)?")


def _number(node: Any) -> float | None:
    """The value of a number the code writes out (a literal, or a minus before one), else None; a bool is no number."""
    import ast  # noqa: PLC0415

    if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.USub):
        inner = _number(node.operand)
        return -inner if inner is not None else None
    if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)) and not isinstance(node.value, bool):
        return float(node.value)
    return None


def _num_text(v: float) -> str:
    """A number as the record and the shown values compare it: a whole number without its `.0`."""
    return str(int(v)) if float(v).is_integer() else repr(v)


def _plain(v: float) -> bool:
    """A number that settles nothing alone when it is typed in: a single digit, or a year (a list of years is an axis)."""
    return (float(v).is_integer() and -9 <= v <= 9) or (float(v).is_integer() and 1900 <= v <= 2100)


def typed_numbers(code: str, shown: set[str]) -> list[str]:
    """The numbers the card's code types into its data that the card also shows: numbers written out in a list, tuple, set or
    dict holding at least TYPED_MIN of them, excluding chart/computation settings (SETTING_KEYWORDS, SETTING_CALLS) and
    subscript indexes, kept only when at least TYPED_MIN non-trivial ones are among `shown`. At most TYPED_KEPT, in the
    code's order; [] for code that does not parse."""
    import ast  # noqa: PLC0415

    try:
        tree = ast.parse(code or "")
    except (SyntaxError, ValueError):
        return []
    parent: dict[int, Any] = {}
    for node in ast.walk(tree):
        for child in ast.iter_child_nodes(node):
            parent[id(child)] = node
    containers = (ast.List, ast.Tuple, ast.Set, ast.Dict)
    loads: dict[str, list[Any]] = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load):
            loads.setdefault(node.id, []).append(node)

    def chooses(node: Any, up: Any) -> bool:
        """Whether `node` is what a loop goes over, what a membership test looks in, or what `.isin` keeps."""
        if isinstance(up, (ast.For, ast.comprehension)) and up.iter is node:
            return True
        if isinstance(up, ast.Compare) and node in up.comparators:
            return all(isinstance(o, (ast.In, ast.NotIn)) for o in up.ops)
        return isinstance(up, ast.Call) and isinstance(up.func, ast.Attribute) and up.func.attr == "isin" and node in up.args

    def setting(node: Any) -> bool:
        """Whether a container is a setting: an argument of a setting call or keyword, or a subscript's index; or a
        choice of what to look at, the items a loop goes over or a membership test's (`for n in [107, 108]`,
        `i in (4489, 4922)`), which name records rather than measure them."""
        up = parent.get(id(node))
        while isinstance(up, containers):  # a tuple inside a keyword's list is the keyword's too
            node, up = up, parent.get(id(up))
        if isinstance(up, ast.keyword):
            return (up.arg or "") in SETTING_KEYWORDS
        if isinstance(up, ast.Subscript) and up.slice is node:
            return True
        if chooses(node, up):
            return True
        if isinstance(up, ast.Assign) and up.value is node and len(up.targets) == 1 and isinstance(up.targets[0], ast.Name):
            # a name for such a choice (`claimed = [107, 108]` then `for n in claimed`) is one too
            uses = loads.get(up.targets[0].id, [])
            return bool(uses) and all(chooses(u, parent.get(id(u))) for u in uses)
        if isinstance(up, ast.Call) and node in up.args:
            f = up.func
            name = f.attr if isinstance(f, ast.Attribute) else f.id if isinstance(f, ast.Name) else ""
            return name in SETTING_CALLS
        return False

    def numbers_in(node: Any, out: list[float], inner: set[int]) -> None:
        if isinstance(node, ast.Dict):
            items = node.values
        elif isinstance(node, (ast.List, ast.Tuple, ast.Set)):
            items = node.elts
        else:
            return
        for item in items:
            v = _number(item)
            if v is not None:
                out.append(v)
            elif isinstance(item, containers):
                inner.add(id(item))
                numbers_in(item, out, inner)
            elif isinstance(item, ast.Call):  # a row built by a call, pd.Series([...]) or dict(n=...)
                for arg in [*item.args, *(k.value for k in item.keywords if (k.arg or "") not in SETTING_KEYWORDS)]:
                    if isinstance(arg, containers):
                        inner.add(id(arg))
                        numbers_in(arg, out, inner)
                    elif (w := _number(arg)) is not None:
                        out.append(w)

    typed: list[float] = []
    counted: set[int] = set()
    for node in ast.walk(tree):  # breadth first, so a container is met before the ones inside it
        if not isinstance(node, containers) or id(node) in counted or setting(node):
            continue
        found: list[float] = []
        numbers_in(node, found, counted)
        if len(found) >= TYPED_MIN:
            typed.extend(found)
    seen = [t for t in typed if _num_text(t) in shown]
    if len({_num_text(t) for t in seen if not _plain(t)}) < TYPED_MIN:
        return []
    return list(dict.fromkeys(_num_text(t) for t in seen if not _plain(t)))[:TYPED_KEPT]


def shown_numbers(cell: dict[str, Any]) -> set[str]:
    """Every number the card's outputs show as text: a table's rows, a chart's data, a drawing's labels and printed
    output, as typed_numbers compares them (thousands separators dropped, a whole number without its `.0`). Images
    are left out, since the digits of their encoding are no values."""
    out: set[str] = set()
    for o in cell.get("outputs") or []:
        bundle = o.get("data") if isinstance(o, dict) and isinstance(o.get("data"), dict) else o
        if not isinstance(bundle, dict):
            continue
        for mime, v in bundle.items():
            if str(mime).startswith("image/"):
                continue
            text = v if isinstance(v, str) else json.dumps(v, ensure_ascii=False, default=str)
            for m in _NUM_TEXT.finditer(text):
                raw = m.group(0).replace(",", "")
                try:
                    out.add(_num_text(float(raw)))
                except ValueError:
                    continue
    return out


def _lines(code: str) -> str:
    """Code as compared: its lines without trailing spaces, and no blank lines around it."""
    return "\n".join(line.rstrip() for line in code.strip().splitlines())


def _patch(cell: dict[str, Any], card: dict[str, str], full: dict[str, Any] | None = None) -> dict[str, Any]:
    """The parts of the replacement card that differ from `cell` and that the check may change (checkstore.fixable), as cell
    fields: `title`, `code` (only when the reading saw the whole code) and `takeaway`, the takeaway compared as it would be
    stored (its values linked against `full`). An empty part leaves the card's own."""
    from . import checkstore  # noqa: PLC0415

    patch: dict[str, Any] = {}
    title = " ".join(card["question"].split())
    if title and title != " ".join(str(cell.get("title") or "").split()):
        patch["title"] = title
    code, old = card["code"], str(cell.get("code") or "")
    if code.strip() and len(old.strip()) <= CODE_CHARS and _lines(code) != _lines(old):
        patch["code"] = code
    take, own = card["takeaway"].strip(), str(cell.get("takeaway") or "").strip()
    if take and take != own and ("code" in patch or full is None or checkstore._resolved(full, take) != own):
        patch["takeaway"] = take
    allowed = checkstore.fixable(cell, list(patch))
    return {k: v for k, v in patch.items() if k in allowed}


def _failed(assessment: list[dict[str, Any]]) -> list[str]:
    """What was wrong: the problems of the criteria the card failed, in the criteria's order."""
    return [a["problem"] for a in assessment if a["problem"]]


async def _replace(run: _Run, cell: dict[str, Any], patch: dict[str, Any], failed: list[str],
                   timing: dict[str, Any]) -> None:
    """Apply the replacement once, kept only when its code runs clean and the replaced card draws; otherwise the card stays,
    the replacement is recorded as a rejected fix and the check ends `error`. The fix's reason is the problem of the first
    criterion the card failed.

    The trial on the card's kernel is settled however the check ends: a check stopped or past its time mid-trial leaves it
    running to its end in a task of its own, which then puts back the names it bound."""
    from . import checkstore  # noqa: PLC0415

    c, cid = run.c, run.cid
    t0 = time.perf_counter()
    if not _phase(run, "revising"):
        _gone(run)
        return
    trial = _spawn(checkstore.candidate(c, cid, patch))
    try:
        cand = await asyncio.shield(trial)
    except asyncio.CancelledError:
        _spawn(_settle_after(c, cid, trial))
        raise
    except Exception as e:  # noqa: BLE001 — a card gone meanwhile, or code on a card that runs none
        cand = None
        log.info("card check: the replacement of card:%s cannot be applied (%s)", cid, e)
    tid = str((cand or {}).get("trial") or "")
    keep, settled = False, False
    try:
        why = await _not_kept(run, cand)
        timing["replace_ms"] = _ms(t0)
        if why:
            timing["replacement"] = "rejected"
            log.info("card check: the replacement of card:%s was not kept, since %s", cid, why)
            settled = True
            await _settle(c, cid, tid, keep=False)
            checkstore.record_rejected(c, cid, run.check, patch, why)
            _end(run, "error", f"its revision was not kept: {why}")
            return
        applied = checkstore.apply_fix(c, cid, run.check, patch, cand, failed[0] if failed else "")
        keep, settled = applied is not None, True
        if applied is None:
            await _settle(c, cid, tid, keep=False)
            _gone(run)  # changed since the check began, or no longer the model's to change
            return
        # the record says `fixed` in the same turn the fix lands, so a Stop during the settle below cannot mark a card
        # that was revised as stopped
        timing["replacement"] = "applied"
        _end(run, "fixed")
        await _settle(c, cid, tid, keep=True)
    finally:
        if not settled and tid:  # stopped or past its time before the settle began
            _spawn(_settle_now(c, cid, tid, keep))


async def _not_kept(run: _Run, cand: dict[str, Any] | None) -> str:
    """Why a replacement is not kept, '' when it is: its code must run clean and the replaced card must draw."""
    if not cand:
        return "it could not be applied"
    if str(cand.get("status") or "ok") != "ok":
        return "its code did not run clean: " + _run_error(cand)
    after = await _draw(run.c, cand)
    if after is None:
        return "no picture could show the replaced card"
    if not after.ok:
        return f"the replaced card did not draw ({after.error})"
    _keep(run.c, run.cid, f"{run.check}-revised.png", after.png)
    return ""


def _spawn(coro: Any) -> asyncio.Task:
    """A task that runs to its end whatever happens to the check that started it (a trial and its settle)."""
    t = asyncio.ensure_future(coro)
    _cleanup.add(t)
    t.add_done_callback(_cleanup.discard)
    return t


async def _settle(c: str, cid: str, tid: str, *, keep: bool) -> None:
    """The end of a replacement's trial on the card's kernel (notebook.trial_settle): kept, or its variables put back.
    It runs in a task of its own, so a check stopped while it runs does not leave it half done."""
    if not tid:
        return
    await asyncio.shield(_spawn(_settle_now(c, cid, tid, keep)))


async def _settle_now(c: str, cid: str, tid: str, keep: bool) -> None:
    from . import notebook  # noqa: PLC0415

    try:
        await notebook.trial_settle(c, cid, tid, keep=keep)
    except Exception:  # noqa: BLE001 — a trial left unsettled leaves the kernel as the trial left it
        log.exception("card check: the trial of card:%s was not settled", cid)


async def _settle_after(c: str, cid: str, trial: asyncio.Task) -> None:
    """A check stopped while its revision's trial ran: once the trial is over, its names are put back."""
    try:
        cand = await trial
    except Exception:  # noqa: BLE001 — a trial that failed bound nothing to put back
        return
    tid = str((cand or {}).get("trial") or "")
    if tid:
        log.info("card check: the check of card:%s stopped during its revision's trial; its names are put back", cid)
        await _settle_now(c, cid, tid, False)


def _run_error(cell: dict[str, Any]) -> str:
    """The error a candidate's run ended in, in one line."""
    for b in cell.get("outputs") or []:
        e = b.get("application/vnd.thimble.error+json") if isinstance(b, dict) else None
        if isinstance(e, dict):
            return f"{e.get('ename') or 'Error'}: {str(e.get('evalue') or '')[:200]}"
    return str(cell.get("status") or "error")


# --------------------------------------------------------------------------- the reading


def _sections() -> dict[str, str]:
    """card-check.md's `## ` sections, read fresh, includes pasted in."""
    from . import prompts  # noqa: PLC0415

    text = prompts.load(PROMPT)
    marks = [*re.finditer(r"^## (.+?)[ \t]*$", text, re.M)]
    return {m.group(1).strip(): text[m.end():marks[i + 1].start() if i + 1 < len(marks) else len(text)].strip()
            for i, m in enumerate(marks)}


def _fill(template: str, values: dict[str, str]) -> str:
    from . import prompts  # noqa: PLC0415

    return prompts._fill(template, values, f"{PROMPT}.md")


def _tool(secs: dict[str, str], name: str) -> Any:
    from . import model, tools  # noqa: PLC0415

    desc, schema = tools.split_section(secs[name])
    return model.ToolSpec(name=name.replace("-", "_"), description=desc, input_schema=schema)


def fit_image(png: bytes, max_edge: int = MAX_EDGE) -> bytes:
    """A PNG whose longer edge is at most `max_edge` px, scaled down when it is longer (a tall timeline at scale 2),
    since the model reads a larger image scaled down anyway and the upload costs time."""
    try:
        from PIL import Image  # noqa: PLC0415 — Pillow comes with matplotlib
    except ImportError:
        return png
    im = Image.open(io.BytesIO(png))
    w, h = im.size
    if max(w, h) <= max_edge:
        return png
    k = max_edge / max(w, h)
    out = io.BytesIO()
    im.resize((max(1, round(w * k)), max(1, round(h * k))), Image.LANCZOS).save(out, format="PNG", optimize=False)
    return out.getvalue()


def _citations_text(c: str, cell: dict[str, Any]) -> str:
    """What each of the card's links resolves to, one line each: the value the source shows and its excerpt, or why
    the link does not resolve."""
    refs = render.cited_refs(cell)
    if not refs:
        return ""
    resolved = render.resolve_all(c, refs)
    lines = []
    for ref in refs:
        r = resolved.get(ref) or {}
        if "error" in r and "status" in r:
            lines.append(f"- {ref} does not resolve ({r['error']})")
            continue
        excerpt = str(r.get("excerpt") or "").strip().replace("\n", " ")
        meta = r.get("meta") if isinstance(r.get("meta"), dict) else {}
        shown = meta.get("value") or meta.get("shown")
        bit = f"{ref} shows {shown}" if shown not in (None, "") else ref
        lines.append(f"- {bit}: {excerpt[:CITE_CHARS]}" if excerpt else f"- {bit}")
    return "\n".join(lines)


def _context_text(c: str, cell: dict[str, Any], author: str) -> str:
    """The work that led to the card: the context engine's parts for its author (context.render, CONTEXT_CHARS, focused on
    the card): main's conversation and threads for main's cards, the orientation's thread for the orientation's, the
    chat of the session that made it otherwise."""
    from . import context  # noqa: PLC0415

    try:
        focus = (f"card:{cell.get('id')}",)
        if author == MAIN:
            return context.render(c, budget=CONTEXT_CHARS, focus=focus, parts=("conversation", "threads"))
        if author == "orient":
            return context.render(c, budget=CONTEXT_CHARS, focus=focus, parts=("orientation",))
        chat = _session_chat(c, cell, author)
        return context.render(c, budget=CONTEXT_CHARS, focus=focus, parts=("session",), chat=chat) if chat else ""
    except Exception:  # noqa: BLE001 — the check reads the card without its context rather than not at all
        log.debug("card check: no context for card:%s", cell.get("id"), exc_info=True)
        return ""


@contextlib.asynccontextmanager
async def _slot(run: _Run) -> Any:
    """One of the READ_CONCURRENCY reading slots. A check that waits for one says `queued`, and the wait moves its deadline,
    so a burst of cards does not use up the time of the ones behind."""
    sem = _semaphore()
    if not sem.locked():
        run.timing.setdefault("queue_ms", 0)
        async with sem:
            yield
        return
    loop = asyncio.get_running_loop()
    run.paused_at = loop.time()
    _phase(run, "queued")
    try:
        await sem.acquire()
    finally:
        waited = loop.time() - run.paused_at
        run.paused_at = None
        run.deadline += waited
        run.timing["queue_ms"] = int(run.timing.get("queue_ms") or 0) + round(waited * 1000)
    try:
        _phase(run, "checking")
        yield
    finally:
        sem.release()


def _semaphore() -> asyncio.Semaphore:
    """The reading slots (READ_CONCURRENCY), made on the running loop (each test has a loop of its own)."""
    global _read_sem, _read_sem_loop
    loop = asyncio.get_running_loop()
    if _read_sem is None or _read_sem_loop is not loop:
        _read_sem, _read_sem_loop = asyncio.Semaphore(READ_CONCURRENCY), loop
    return _read_sem


def _session_chat(c: str, cell: dict[str, Any], author: str) -> str | None:
    """The chat of the session that made a card that is not main's: the running session's, else the chat the card is
    stamped with, else the orientation's latest chat for the orientation's card, or a writer's latest chat for its
    document once the writer has ended; None when none is found."""
    from . import agent_session, agents, orientation  # noqa: PLC0415

    run = agent_session.current(c, author)
    if run is not None:
        return run.chat
    by = str(cell.get("created_by") or "")
    if by.startswith("chat:"):
        return by.removeprefix("chat:")
    if author == "orient":
        return str(((orientation.read_run(c) or {}).get("chats") or {}).get(orientation.ROLE) or "") or None
    if author.startswith("writer:"):
        doc = author.split(":", 1)[1]
        chats = [m for m in agents.list_chats(c) if m.get("role") == "writer" and m.get("doc") == doc]
        return max(chats, key=lambda m: str(m.get("created_at") or ""))["id"] if chats else None
    return None


def _role(c: str) -> dict[str, Any]:
    return config.models_for(c).get("verify") or dict(config.ROLE_MODELS_DEFAULT["verify"])


def read_effort(c: str) -> str:
    """The effort the card check reads a card at: the `verify` role's (config.models_for)."""
    return str(_role(c).get("effort") or config.ROLE_MODELS_DEFAULT["verify"]["effort"])


async def _call(c: str, system: str, user: str, tool: Any, images: list[tuple[bytes, str]], *, effort: str) -> Any:
    """The reading: one model.structured call on the `verify` role's model and fast mode at `effort`. Retry waits and a
    refused reading before the fallback are left out of the check's time (_on_retry, _on_fallback)."""
    from . import model  # noqa: PLC0415

    role = _role(c)
    run = _current.get()
    return await model.structured(
        user, tool=tool, model=role.get("model") or config.ROLE_MODELS_DEFAULT["verify"]["model"],
        effort=effort or None,
        system_append=system, cwd=config.corpus_dir(c),
        speed="fast" if role.get("fast") else "standard", images=images, idle_timeout_s=READ_IDLE_S,
        on_retry=_on_retry(run) if run is not None else None,
        on_fallback=_on_fallback(run) if run is not None else None)


def _assessment(raw: Any) -> list[dict[str, Any]] | None:
    """The reading's assessment as CRITERIA items {problem}, its spaces collapsed and '' for a criterion the card meets;
    None when it has another number of items or an item without its problem as text."""
    if not isinstance(raw, list) or len(raw) != CRITERIA:
        return None
    out = []
    for a in raw:
        problem = a.get("problem") if isinstance(a, dict) else None
        if not isinstance(problem, str):
            return None
        out.append({"problem": " ".join(problem.split())})
    return out


async def _read(c: str, cell: dict[str, Any], png: bytes | None,
                run: _Run) -> tuple[list[dict[str, Any]], dict[str, str], str] | str:
    """(assessment, the replacement card {question, code, takeaway}, model) from the model's reading of the card's
    picture; why not, as a sentence, when the call failed or its output lacks a part. _Capacity when the API is at
    capacity after model.structured's own retries."""
    secs = _sections()
    none = secs.get("none", "")
    code = str(cell.get("code") or "").strip()
    user = _fill(secs["card"], {
        "card": run.cid,
        "kind": str(cell.get("kind") or "code"),
        "question": str(cell.get("title") or ""),
        "takeaway": str(cell.get("takeaway") or "").strip() or none,
        "citations": await asyncio.to_thread(_citations_text, c, cell) or none,
        "code": f"```python\n{code[:CODE_CHARS]}\n```" if code else none,
        "context": await asyncio.to_thread(_context_text, c, cell, run.author) or none,
    })
    images = [(await asyncio.to_thread(fit_image, png), "image/png")] if png else []
    effort = run.effort or await asyncio.to_thread(read_effort, c)
    t0, outcome = time.perf_counter(), "stopped"  # stopped: the check ran past its time, or the card changed
    try:
        async with _slot(run):
            t0 = time.perf_counter()
            res = await _call(c, _fill(secs["check"], {}), user, _tool(secs, "critique"), images, effort=effort)
        outcome = res.status
    finally:
        log.info("card check: the reading of card:%s at %s effort ended %s after %.1f s (the check's limit %.0f s)",
                 run.cid, effort, outcome, time.perf_counter() - t0, check_timeout(effort))
    run.note = ""
    if res.refused_by:
        from .session import model_label  # noqa: PLC0415

        run.note = FALLBACK_NOTE.format(model=model_label(res.refused_by), fallback=model_label(res.model_requested))
        run.timing["refused_by"] = res.refused_by
    if res.status != "ok" or not isinstance(res.output, dict):
        log.warning("card check: the reading of card:%s failed (%s: %s)", run.cid, res.status, res.detail)
        cls = "rate_limited" if res.status == "rate_limited" else retry.transient_class(None, res.detail)
        if cls in CAPACITY:
            raise _Capacity(CAPACITY_WORDS[cls])
        return _read_failure(res.status, res.detail)
    out = res.output
    assessment = _assessment(out.get("assessment"))
    card = {k: out.get(k) for k in ("question", "code", "takeaway")}
    if assessment is None or not all(isinstance(v, str) for v in card.values()):
        log.warning("card check: the reading of card:%s gave no whole assessment and card", run.cid)
        return "the model's reading gave no whole assessment and card"
    return assessment, card, str(res.model_used or res.model_requested or "")


def _read_failure(status: str, detail: str) -> str:
    """Why a reading failed, in the words the check mark's hover shows."""
    lead = {"refused": "the model declined to read the card", "truncated": "the model's reading was cut off",
            "no_tool_call": "the model gave no assessment", "timeout": "the model stopped answering"}.get(
        status, "the model's reading failed")
    return f"{lead} ({detail})" if detail else lead


# --------------------------------------------------------------------------- routes

router = APIRouter()


@router.get("/ws/{c}/card-checks")
async def status_route(c: str) -> dict[str, Any]:
    """Whether the check runs (`enabled`, `auto`, `render`), how many run at once, the checks running now with their phase and
    start, and the times of the last checks, for measurement and debugging."""
    now = time.perf_counter()
    try:
        why = render.why()
    except Exception as e:  # noqa: BLE001 — the status answers even when the harness cannot say why it is down
        why = f"{type(e).__name__}: {e}"
    return {"enabled": enabled(), "auto": auto(c), "render": render.available(), "render_why": why,
            "concurrency": READ_CONCURRENCY,
            "running": [{"card": r.cid, "author": r.author, "check": r.check, "effort": r.effort, "phase": r.phase,
                         "for_s": round(now - r.t0, 1)} for r in running(c)],
            "timings": [t for t in _timings if not t.get("ws") or t.get("ws") == c]}


class AutoBody(BaseModel):
    on: bool


@router.put("/ws/{c}/card-checks/auto")
async def auto_route(c: str, body: AutoBody) -> dict[str, Any]:
    """The canvas's switch: the automatic check on or off for the workspace (settings.json `card_check`). Off stops the
    checks that run (stop_all); a card's mark still runs its check on a click. Answers status_route's record."""
    from . import ledger  # noqa: PLC0415

    ledger.put_settings(c, {AUTO_KEY: body.on})
    if not body.on:
        stop_all(c, AUTO_OFF)
    return await status_route(c)


@router.post("/ws/{c}/cells/{cid}/check/stop")
async def stop_route(c: str, cid: str) -> dict[str, Any]:
    """Stop the card's check (the click on a running mark): its record ends `stopped` and the card stays as it is. 404
    for a card that is gone; `stopped` false when the card had no check running."""
    from . import notebook  # noqa: PLC0415

    if notebook.get_cell(c, cid) is None:
        raise HTTPException(404, f"no card {cid}")
    return {"card": cid, "stopped": stop(c, cid)}


@router.post("/ws/{c}/card-checks/stop")
async def stop_all_route(c: str) -> dict[str, Any]:
    """Stop every check of the workspace, queued or running (the canvas's Stop all); the cards whose check stopped."""
    return {"stopped": stop_all(c)}


@router.post("/ws/{c}/cells/{cid}/check")
async def again_route(c: str, cid: str) -> dict[str, Any]:
    """Run the card's check again, from the click on its check mark, with the work of the author the last check named as its
    context, else main's. 409 when the card gets no check (wants_check) or the check is off."""
    from . import checkstore, notebook  # noqa: PLC0415

    cell = notebook.get_cell(c, cid)
    if cell is None:
        raise HTTPException(404, f"no card {cid}")
    if not enabled():
        raise HTTPException(409, "the card check is off (THIMBLE_CARD_CHECK)")
    if render.down():
        raise HTTPException(409, f"no card can be drawn here: {render.why()}")
    if not wants_check(cell):
        raise HTTPException(409, "this card gets no check: it has no takeaway, is a label card, or is the analyst's or locked")
    rec = checkstore.current(c, cid) or {}
    run = start(c, cid, str(rec.get("author") or MAIN), again=True)
    if run is None:
        raise HTTPException(409, "the check could not begin")
    return {"card": cid, "check": run.check}


async def shutdown() -> None:
    """main's lifespan hook: the running checks end with the server, each record ended `error`, so no card keeps the
    spinner of a check nothing runs any more and its mark offers to run it again."""
    from . import checkstore  # noqa: PLC0415

    for run in list(_runs.values()):
        if run.task is not None and not run.task.done():
            run.outcome, run.reason = "error", SERVER_STOPPED
            run.task.cancel()
            try:
                checkstore.end_pending(run.c, run.cid, "error", SERVER_STOPPED, check_id=run.check)
            except Exception:  # noqa: BLE001 — a record left pending never stops the server's shutdown
                log.exception("card check: card:%s left pending at shutdown", run.cid)
    _runs.clear()
