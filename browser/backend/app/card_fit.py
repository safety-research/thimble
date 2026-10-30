"""A card that does not fit on the analyst's screen gets a critique and a new version before the analyst sees it.

tools.call hands every add_card and edit_card result to after_tool(). The card the call made, or whose content it
changed, is drawn offscreen by the card harness (render.render_card) at the card's width, which measures its body whole
(a custom card's page whole, with what its own scroll boxes hold past their height, and a table's rows past the ones it
shows first: render.Rendered.body) and the width its content lays out at (Rendered.width, in a room Rendered.frame px
wide). A body past card_size.BODY_MAX, or content wider than its room, does not fit:

1. The card is held (its `held` record, notebook.set_held): the canvas shows it as a card that still runs, with its
   question and the running line and without its content or its takeaway, and the card check waits for it
   (card_check.wants_check). It is held from the moment the call stores its content until the measure ends
   (notebook.MEASURING, which tools.call sets around the call: measuring), so the canvas shows no version that does
   not fit, even for that moment. The record names who made the version (holder): the session of one of thimble's
   agents (`author`), or a subagent of main's, such as a thread's fork (`agent`); neither for main's own call.
2. One model call (prompts/card-fit.md, on the `verify` role's model and speed at CRITIQUE_EFFORT) reads the question,
   the work that led to the card (_context: for a thread's fork's card, that thread with the analyst's question), the
   card's content and picture, and the card guidance (prompts/shared.md `## Cards`), and says what the card shows
   beyond what its question needs. The call's result carries that critique (prompts/tools.md `## card-held`) and the
   way to make the next version (`## card-revise-code`, `## card-revise-data`): edit_card, or for a kind edit_card
   cannot give this card, a new card and delete_card. The author reads what it needs to make that version, the card
   guidance's purpose for this card, and no measure: a version the analyst never saw is nothing to tell them about, and
   its size in the result came back in the replies as the reason for the card they see.
   A call that changes a held card but not its content, such as its takeaway or its place, says again that the card
   waits, and how to make its next version (`## card-waits`).
3. A version that fits shows at once (`## card-fits`). A new version that still does not fit gets one more critique
   (`## card-held-again`). After MAX_TRIES new versions, the version that comes closest to fitting (the least excess;
   notebook.restore_version brings back an earlier one as it stood when the next version replaced it, its question and
   takeaway with it, the takeaway still its author's) shows, cut at the card's edges as the canvas cuts any card
   (`## card-cut`). A new card that takes the place of a held one (add_card, then delete_card) counts on from the
   versions the held one had (deleting).
4. A card still held when the turn or run of the one who made its version ends shows as it stands: main's turn
   (session._end_turn calls turn_ended), a run of one of thimble's agents (subagents.run_ended calls run_ended), or a
   subagent of main's (session._finish_sub calls agent_ended). So does every held card when the server starts again
   (notebook.mark_interrupted_cells).

The card check's replacement of a card is a version too, and keeps_replacement holds it to the same measure: it takes
the card's place only when it fits, or comes no farther from fitting than the card as it stands. One that does not fit
gets a critique (critique_of) and one more version of the check's, as a version of the author's does.

Where no card can be drawn (render.down, or the harness failed on this card), or outside browser mode, where no server
hears main's turn end, nothing is held, and the page's own measure tells the author with its next call (card_size).
Each step is one line of workspaces/<c>/card-fit.jsonl.
"""
from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from . import config, ledger, render

log = logging.getLogger("thimble.card_fit")

FIT_TOOLS = ("add_card", "edit_card")
PROMPT = "card-fit"
HELD = "held"  # the card's record while it waits for a version that fits (notebook.set_held)
MAX_TRIES = 2  # new versions a card that does not fit gets before its closest version shows with its cut-off
CRITIQUE_EFFORT = "low"  # a few sentences on one card, while its author and the analyst wait
CRITIQUE_IDLE_S = 60.0  # a critique with no sign of life this long is stalled (model.structured's idle clock)
CONTEXT_CHARS = 8000  # of the work that led to the card: the analyst's request and what the author found
CONTENT_CHARS = 6000  # of the card's code or page, and of its outputs as text
LOG_FILE = "card-fit.jsonl"
NOT_MEASURED = ("label", "plan")  # a label card is drawn from its label, and a plan from its steps
ORDINALS = ("first", "second", "third", "fourth")  # the versions of a card, in the order its author made them


@dataclass(frozen=True)
class Size:
    """A card as the harness drew it at its width: its body's whole height, of it what a custom page holds in scroll
    boxes of its own past their height (`inner`), and the width its content lays out at in its room (both 0 when nothing
    in it lays out wider), in CSS px."""

    body: float
    width: float = 0.0
    frame: float = 0.0
    inner: float = 0.0

    @property
    def tall(self) -> bool:
        from .card_size import BODY_MAX  # noqa: PLC0415

        return self.body > BODY_MAX

    @property
    def wide(self) -> bool:
        return self.frame > 0 and self.width > self.frame + 1  # as the page measures it: a px of rounding is no overflow

    @property
    def fits(self) -> bool:
        return not self.tall and not self.wide

    @property
    def excess(self) -> float:
        """How far past its limits the card draws, as shares of each limit; 0 for a card that fits."""
        from .card_size import BODY_MAX  # noqa: PLC0415

        over = max(0.0, self.body / BODY_MAX - 1)
        if self.wide:
            over += self.width / self.frame - 1
        return over

    def where(self) -> str:
        """What the critique reads of where the card runs past what the analyst sees at once, besides its picture, which
        shows its height: a box of its own that scrolls, which the picture shows at the box's height, and a width past
        its card's. No measure: the critique goes to the card's author, who needs what the card shows beyond its
        question, not how large it is. '' for a card that is only taller than the screen."""
        parts = []
        if self.tall and self.inner >= 1:
            parts.append("Much of it is in a box of its own that scrolls.")
        if self.wide:
            parts.append("It is wider than its card.")
        return " ".join(parts) + " " if parts else ""


def size_of(drawn: render.Rendered) -> Size:
    """A card as the harness drew it (render.render_card), measured."""
    return Size(body=drawn.body, width=drawn.width, frame=drawn.frame, inner=drawn.inner)


# (workspace, card) -> the version last settled: measured to fit, or shown with its cut-off or as it stood
_settled: dict[tuple[str, str], str] = {}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _ms(t0: float) -> int:
    return round((time.perf_counter() - t0) * 1000)


def _hint(name: str, **values: Any) -> str:
    from .tools import hint  # noqa: PLC0415 — tools imports this module

    return hint(name, **values)


def _log(c: str, **line: Any) -> None:
    """One step as a line of workspaces/<c>/card-fit.jsonl. Never raises."""
    try:
        ledger.append_jsonl_locked(config.workspace_dir(c) / LOG_FILE, {"ts": _now(), **line})
    except Exception:  # noqa: BLE001 — a line not written never changes what the card does
        log.debug("card fit: the line was not written", exc_info=True)


def held(cell: dict[str, Any] | None) -> bool:
    """Whether a card waits for its measure, or for a version that fits, before the analyst sees it."""
    return isinstance((cell or {}).get(HELD), dict)


def _record(cell: dict[str, Any] | None) -> dict[str, Any] | None:
    """The record of a card that waits for a version that fits; None for one that waits only for its measure, or for
    none."""
    rec = (cell or {}).get(HELD)
    return rec if isinstance(rec, dict) and "versions" in rec else None


def holds_here() -> bool:
    """Whether a card can be held here: the harness can draw it, and this is the server, which hears main's turn end
    (launch_mode: the server runs in browser mode)."""
    from . import launch_mode  # noqa: PLC0415

    return render.enabled() and not render.down() and launch_mode.current() == launch_mode.BROWSER


def holder(c: str, name: str, session: str | None, tool_use_id: str | None) -> dict[str, str]:
    """Who makes the version an add_card or edit_card call stores, as the card's held record names it: `author`, the
    session of one of thimble's agents the call runs as (tools.Ctx.session, such as `orient` or `writer:<doc>`, its
    descendants' calls too), or `agent`, the subagent of main's that made a call through main's shim, such as a thread's
    fork (the caller hook's line, subagent_files.find_caller). {} for main's own call, for any other tool, and where no
    card is held."""
    if name not in FIT_TOOLS or not holds_here():
        return {}
    if session:
        return {"author": session}
    try:
        from . import subagent_files  # noqa: PLC0415

        line = subagent_files.find_caller(config.workspace_dir(c), tool_use_id) if tool_use_id else None
    except Exception:  # noqa: BLE001 — a line not read: the call counts as main's own, whose turn end shows its cards
        log.debug("card fit: the caller of %s was not read", tool_use_id, exc_info=True)
        line = None
    agent = str((line or {}).get("agent_id") or "")
    return {"agent": agent} if agent else {}


@contextlib.contextmanager
def measuring(name: str, who: dict[str, str] | None = None) -> Iterator[None]:
    """Around a tool's call (tools.call): the card an add_card or edit_card call makes, or whose content it changes, is
    held from the moment its content is stored until after_tool measures it (notebook.MEASURING), its record naming
    `who` made it (holder)."""
    from . import notebook  # noqa: PLC0415

    token = (notebook.MEASURING.set({**notebook.MEASURING_HELD, **(who or {})})
             if name in FIT_TOOLS and holds_here() else None)
    try:
        yield
    finally:
        if token is not None:
            notebook.MEASURING.reset(token)


def _measures(cell: dict[str, Any] | None) -> bool:
    """Whether a card is measured: one its author can change (not the analyst's own), of a kind drawn from its content,
    and for a card of code one whose code ran clean (an errored card goes back to its author through its result)."""
    from . import card_size, notebook  # noqa: PLC0415

    if not cell or cell.get("kind") in NOT_MEASURED:
        return False
    if str(cell.get("created_by") or "") in card_size.BY_HAND:
        return False
    return cell.get("status") == "ok" if notebook.runnable(cell) else True


def forget(c: str | None = None) -> None:
    """What this process remembers of the cards settled, gone (tests; a workspace removed)."""
    for k in [k for k in _settled if c is None or k[0] == c]:
        _settled.pop(k, None)
    for key in [k for k in _carried if c is None or k[0] == c]:
        _carried.pop(key, None)


def _sections() -> dict[str, str]:
    """card-fit.md's `## ` sections, read fresh, includes pasted in."""
    import re  # noqa: PLC0415

    from . import prompts  # noqa: PLC0415

    text = prompts.load(PROMPT)
    marks = [*re.finditer(r"^## (.+?)[ \t]*$", text, re.M)]
    return {m.group(1).strip(): text[m.end():marks[i + 1].start() if i + 1 < len(marks) else len(text)].strip()
            for i, m in enumerate(marks)}


# --------------------------------------------------------------------------- the tool path


async def after_tool(c: str, name: str, args: dict[str, Any] | None, res: Any, *, session: str | None = None,
                     anchor: str | None = None, by: str | None = None, agent: str = "") -> Any:
    """Called by tools.call with every result: measures the card an add_card or edit_card result names when its content
    changed, and holds, critiques or shows it (module note). `by` is the caller as the cards it changes name it
    (tools.Ctx.cell_author), and `agent` the subagent of main's that made the call (holder). The result, with what its
    author reads after it. Never raises."""
    if name not in FIT_TOOLS or not holds_here():
        return res
    cid = None
    try:
        from . import card_check  # noqa: PLC0415 — card_check imports the harness

        cid = card_check.card_of(name, args, res.text, anchor)
        line = (await fit(c, cid, card_check.author_of(session), by=by, agent=agent)
                if cid and not res.is_error else "")
        if line:
            for b in res.content:
                if b.get("type") == "text":
                    b["text"] = f"{b.get('text', '')}\n\n{line}" if str(b.get("text", "")) else line
                    break
            else:
                res.content.append({"type": "text", "text": line})
    except Exception:  # noqa: BLE001 — the measure never breaks a tool call
        log.exception("card fit: after_tool failed for %s", name)
    finally:
        if cid:
            _measured(c, cid)
    return res


def _measured(c: str, cid: str) -> None:
    """Card `cid`'s measure ended: a card that waited only for it (notebook.MEASURING_HELD) shows."""
    from . import notebook  # noqa: PLC0415

    try:
        cell = notebook.get_cell(c, cid)
        if held(cell) and _record(cell) is None:
            notebook.set_held(c, cid, None)
    except Exception:  # noqa: BLE001 — a card left waiting shows when the turn or run of the one who made it ends
        log.exception("card fit: card:%s did not show after its measure", cid)


async def fit(c: str, cid: str, author: str, *, by: str | None = None, agent: str = "") -> str:
    """Card `cid` measured, then held with a critique, shown, or shown with its cut-off (module note); the line its
    author reads after the call's result, '' for none. `author` is the session whose work led to the card (card_check's
    author_of), `by` the caller as the cards it changes name it, and `agent` the subagent of main's that made this
    version (holder), '' for none."""
    from . import card_size, notebook  # noqa: PLC0415

    cell = notebook.get_cell(c, cid)
    if cell is None or not _measures(cell):
        return ""
    v = card_size.version(cell)
    hold = _record(cell)
    if hold is not None and hold.get("version") == v:
        # its content is as it was measured: the call set a takeaway or a question, or moved the card, which still waits
        return _hint("card-waits", cid=cid, how=_revise(cell, cid))
    if hold is None and _settled.get((c, cid)) == v:
        return ""
    t0 = time.perf_counter()
    drawn = await _measure(c, cell)
    line = {"card": cid, "kind": cell.get("kind"), "author": author, "render_ms": _ms(t0)}
    if drawn is None:
        if hold is not None:
            show(c, cid, "not drawn", check=False, **line)
        return ""
    size, png = drawn
    line.update(body=round(size.body), inner=round(size.inner), width=round(size.width), frame=round(size.frame))
    # the versions a held card it takes the place of had (deleting), for a card measured for the first time
    before = int(hold.get("before") or 0) if hold is not None else _carry(c, cell, author, agent)
    if size.fits:
        _settled[(c, cid)] = v
        if hold is None:
            _log(c, action="fits", **line, **({"before": before} if before else {}))
            return ""
        show(c, cid, "fits", check=False, tries=before + len(hold.get("versions") or []), **line)
        return _hint("card-fits", cid=cid)
    card_size.told(c, cell)  # the page's measure and the card check's say nothing more of this version
    versions = [*((hold or {}).get("versions") or []),
                {"version": v, "excess": round(size.excess, 4), "entry": _last_edit(cell), "at": _now()}]
    tries = before + len(versions) - 1  # the new versions made since the first that did not fit
    if tries >= MAX_TRIES:
        return await _cut(c, cid, by, versions, {**line, "tries": tries})
    notebook.set_held(c, cid, {"version": v, "since": (hold or {}).get("since") or _now(), "author": author,
                               **({"agent": agent} if agent else {}), "body": round(size.body),
                               "width": round(size.width), "frame": round(size.frame), "versions": versions,
                               **({"before": before} if before else {})})
    t1 = time.perf_counter()
    critique, why = await _critique(c, cell, author, size, png)
    _log(c, action="held", tries=tries, critique_ms=_ms(t1), critique=critique, why=why, **line)
    said = critique or _hint("card-critique-failed", why=why or "the call gave no critique")
    return _hint("card-held" if tries == 0 else "card-held-again", cid=cid, critique=said, how=_revise(cell, cid))


# (workspace, author, agent) -> (the versions a held card had, the time of its newest version): a held card deleted before
# the card that takes its place was measured (deleting), for that card's first measure (_carry); dropped when the turn
# or run of its author ends (_release)
_carried: dict[tuple[str, str, str], tuple[int, str]] = {}


def deleting(c: str, cell: dict[str, Any] | None) -> None:
    """Card `cell` is about to be deleted (tools' delete_card). A held card's versions count for the card of its
    author's that takes its place, as the result of its call says to make it (add_card, then delete_card), so that the
    new card goes on from them and does not get MAX_TRIES new versions of its own: each card its author made since its
    newest version that waits now, or one still measured, or, when its author made none since, the next card of its
    author's that fit measures (_carry). Never raises."""
    from . import notebook  # noqa: PLC0415

    rec = _record(cell)
    if rec is None or cell is None:
        return
    try:
        spent = int(rec.get("before") or 0) + len(rec.get("versions") or [])
        versions = rec.get("versions") or [{}]
        last = str(versions[-1].get("at") or rec.get("since") or "")
        ws = config.workspace_dir(c)
        made = []  # the cards of the same author made since its newest version, which may take its place
        for nb in notebook.list_notebooks(ws):
            for other in (notebook.read_notebook(ws, str(nb.get("id") or "")) or {}).get("cells") or []:
                if (other.get("id") != cell.get("id") and other.get("created_by") == cell.get("created_by")
                        and other.get("kind") not in NOT_MEASURED and str(other.get("created_ts") or "") >= last):
                    made.append(other)
        for other in made:
            orec = _record(other)
            if orec is not None and int(orec.get("before") or 0) < spent:
                notebook.set_held(c, str(other.get("id")), {**orec, "before": spent})
        # a card made since that is still measured, as when add_card and delete_card run at once, takes them at its
        # first measure (_carry), as does the next card its author makes when it made none since
        if not made or any(held(o) and _record(o) is None for o in made):
            _carried[(c, *_holder_of(rec))] = (spent, last)
    except Exception:  # noqa: BLE001 — the new card counts its versions from none
        log.exception("card fit: the versions of card:%s were not passed on", (cell or {}).get("id"))


def _carry(c: str, cell: dict[str, Any], author: str, agent: str) -> int:
    """The versions a held card of `author` and `agent` had when it was deleted before this card's first measure
    (deleting), which this card, made since that card's newest version, goes on from; 0 for none."""
    key = (c, author or "", agent or "")
    got = _carried.get(key)
    if got is None or str(cell.get("created_ts") or "") < got[1] or (c, str(cell.get("id"))) in _settled:
        return 0
    _carried.pop(key, None)
    return got[0]


def _revise(cell: dict[str, Any], cid: str) -> str:
    """How the author makes the next version of held card `cid`: with edit_card, which turns a card of code into any
    kind that runs code and keeps any other card in its kind (tools' edit_card), or as a new card of another kind with
    add_card, the held one then deleted."""
    from . import notebook  # noqa: PLC0415

    if notebook.runnable(cell):
        return _hint("card-revise-code", cid=cid)
    return _hint("card-revise-data", cid=cid, kind=str(cell.get("kind") or notebook.DEFAULT_KIND))


def _last_edit(cell: dict[str, Any]) -> str:
    """The id of the card's newest edit (notebook's history, `edited`), which made the version it is now; '' for a
    card never edited."""
    edits = cell.get("edited") if isinstance(cell.get("edited"), list) else []
    last = edits[-1] if edits else None
    return str(last.get("id") or "") if isinstance(last, dict) else ""


# the fields of an edit that make a new version (card_size.version: what the card draws from); an edit of the question or
# the takeaway alone belongs to the version it was made on
DRAWN_FIELDS = ("kind", "code", "payload")


def _replaced(cell: dict[str, Any] | None, entry: str) -> str:
    """The id of the edit that replaced the version of a card whose newest edit was `entry` ('' for the card as it was
    made): the first edit after it that changed what the card draws from (DRAWN_FIELDS). An edit after it of the
    question or the takeaway alone, such as a takeaway its author wrote on that version while it waited, is part of that
    version, which comes back with it. '' when the card's history has none."""
    edits = [e for e in (cell or {}).get("edited") or [] if isinstance(e, dict)]
    ids = [str(e.get("id") or "") for e in edits]
    if entry and entry not in ids:
        return ""
    after = edits[ids.index(entry) + 1:] if entry else edits
    first = next((e for e in after if set(e.get("fields") or []) & set(DRAWN_FIELDS)), None)
    return str(first.get("id") or "") if first else ""


async def _cut(c: str, cid: str, by: str | None, versions: list[dict[str, Any]], line: dict[str, Any]) -> str:
    """After MAX_TRIES new versions that did not fit: the version that comes closest to fitting shows, with its cut-off.
    An earlier version comes back as it stood (notebook.restore_version, before the edit that replaced it), as an edit
    of `by`'s, its takeaway still the author's (tools.TAKEAWAY_AUTHOR), as every version of a held card is."""
    from . import canvas_history, card_size, notebook  # noqa: PLC0415
    from .tools import TAKEAWAY_AUTHOR  # noqa: PLC0415 — tools imports this module

    best = min(range(len(versions)), key=lambda i: (float(versions[i].get("excess") or 0), -i))
    if best < len(versions) - 1 and (
            entry := _replaced(notebook.get_cell(c, cid), str(versions[best].get("entry") or ""))):
        try:
            with canvas_history.acting(by):
                cell = await asyncio.to_thread(notebook.restore_version, c, cid, entry, by=by,
                                               takeaway_author=TAKEAWAY_AUTHOR)
            card_size.told(c, cell)
        except Exception:  # noqa: BLE001 — the card keeps its newest version
            log.exception("card fit: card:%s could not go back to its %s version", cid, ORDINALS[best])
            best = len(versions) - 1
    show(c, cid, "cut", check=False, best=best, **line)
    which = "this version" if best == len(versions) - 1 else f"your {ORDINALS[min(best, len(ORDINALS) - 1)]} version"
    return _hint("card-cut", cid=cid, which=which)


def keeps_replacement(before: render.Rendered | None, after: render.Rendered) -> bool:
    """Whether the card check's replacement, drawn as `after`, takes the place of the card drawn as `before`: the check's
    version gets the measure any version gets, so it is kept when it fits, or when it comes no farther from fitting
    than the card as it stands (a new takeaway on a card shown with its cut-off). Where no card is held (holds_here),
    no version is measured, and neither is the check's."""
    if not holds_here():
        return True
    new = size_of(after)
    return new.fits or (before is not None and new.excess <= size_of(before).excess)


def show(c: str, cid: str, why: str, *, check: bool = True, **line: Any) -> bool:
    """Card `cid` no longer held: the canvas shows it as it stands, and that version is settled (fit measures it no
    more). With `check`, the card check reads it when the workspace checks cards by itself; a tool's call leaves that to
    card_check.after_tool. Whether it was held."""
    from . import card_check, card_size, notebook  # noqa: PLC0415

    cell = notebook.get_cell(c, cid)
    if cell is None or not held(cell):
        return False
    since, author = str(cell[HELD].get("since") or ""), str(cell[HELD].get("author") or card_check.MAIN)
    shown = notebook.set_held(c, cid, None) or cell
    _settled[(c, cid)] = card_size.version(shown)
    _log(c, action="shown", why=why, since=since, **{"card": cid, "author": author, **line})
    if check and card_check.enabled() and card_check.auto(c):
        try:
            card_check.start(c, cid, author)
        except RuntimeError:  # no running loop (a worker thread): the card's next change begins its check
            log.debug("card fit: no check of card:%s begun off the loop", cid)
    return True


def _holder_of(rec: dict[str, Any]) -> tuple[str, str]:
    """(author, agent) of a held record (holder): the session of the agent of thimble's that made its version, else
    `main`, and the subagent of main's that made it, else ''."""
    from . import card_check  # noqa: PLC0415

    return str(rec.get("author") or card_check.MAIN), str(rec.get("agent") or "")


def _release(c: str, theirs: Callable[[str, str], bool], why: str) -> list[str]:
    """Each card held in workspace `c` whose record's (author, agent) `theirs` takes shows as it stands, since no
    version that fits comes for it now. The cards shown."""
    from . import notebook  # noqa: PLC0415

    for key in [k for k in _carried if k[0] == c and theirs(k[1], k[2])]:
        _carried.pop(key, None)  # no card takes the place of the held one it deleted now
    out = []
    try:
        ws = config.workspace_dir(c)
        for nb in notebook.list_notebooks(ws):
            for cell in (notebook.read_notebook(ws, str(nb.get("id") or "")) or {}).get("cells") or []:
                rec = cell.get(HELD)
                if isinstance(rec, dict) and theirs(*_holder_of(rec)) and show(c, str(cell.get("id")), why):
                    out.append(str(cell.get("id")))
    except Exception:  # noqa: BLE001 — a card left held shows at the server's next start
        log.exception("%s: the held cards were not shown (%s)", c, why)
    return out


def turn_ended(c: str) -> list[str]:
    """Main's turn ended in workspace `c` (session._end_turn): each card main's own calls hold shows as it stands. A
    card an agent of thimble's or a subagent of main's holds waits for that one's own end (run_ended, agent_ended). The
    cards shown."""
    from . import card_check  # noqa: PLC0415

    return _release(c, lambda author, agent: author == card_check.MAIN and not agent, "turn ended")


def run_ended(c: str, key: str) -> list[str]:
    """A run of the agent of thimble's whose session is `key` ended (subagents.run_ended; an extension's program,
    harness): each card it holds shows as it stands. The cards shown."""
    return _release(c, lambda author, agent: author == key, "run ended") if key else []


def agent_ended(c: str, agent_id: str) -> list[str]:
    """The subagent of main's `agent_id` ended, such as a thread's fork (session._finish_sub): each card it holds shows
    as it stands. The cards shown."""
    return _release(c, lambda author, agent: agent == agent_id, "agent ended") if agent_id else []


# --------------------------------------------------------------------------- the measure and the critique


async def _measure(c: str, cell: dict[str, Any]) -> tuple[Size, bytes | None] | None:
    """The card as the harness draws it: its size and its picture; None where no card can be drawn, or this card did not
    draw (its author reads its run's result, and the page measures what it shows)."""
    try:
        drawn = await render.render_card(c, {k: v for k, v in cell.items() if k != HELD})
    except render.Unavailable as e:
        log.debug("card fit: card:%s not drawn (%s)", cell.get("id"), e)
        return None
    if not drawn.ok:
        log.info("card fit: card:%s did not draw: %s", cell.get("id"), drawn.error)
        return None
    return size_of(drawn), drawn.png


def _guidance() -> str:
    """The card guidance the critique holds the card to: prompts/shared.md's `## Cards`, without its part on a group of
    cards."""
    from . import prompts  # noqa: PLC0415

    return prompts.without(prompts.section("shared", "Cards"), ["Several cards"], strict=False).strip()


def _content(c: str, cell: dict[str, Any]) -> str:
    """What the card shows, as the critique reads it: a custom card's page, a note's text, an example's records, or a
    card of code's code and the start of its outputs (a card check's replacement, its own: checkstore.candidate)."""
    from . import notebook  # noqa: PLC0415

    payload = cell.get("payload") if isinstance(cell.get("payload"), dict) else {}
    kind = str(cell.get("kind") or notebook.DEFAULT_KIND)
    if kind == "custom":
        return f"```html\n{str(payload.get('html') or '')[:CONTENT_CHARS]}\n```"
    if kind == "note":
        return str(payload.get("text") or cell.get("text") or "")[:CONTENT_CHARS]
    if kind == "example":
        return "\n".join(f"- {r if isinstance(r, str) else r.get('ref', '')}" for r in payload.get("refs") or [])
    if not notebook.runnable(cell):
        return str(payload)[:CONTENT_CHARS]
    full = cell if cell.get("candidate") else notebook.get_cell(c, str(cell.get("id")), full_outputs=True) or cell
    shown = notebook.outputs_text(full.get("outputs") or [], CONTENT_CHARS)
    return f"```python\n{str(cell.get('code') or '')[:CONTENT_CHARS]}\n```\n\nIts output\n{shown}"


def _thread_of(c: str, cell: dict[str, Any]) -> str:
    """The side thread whose fork made card `cell`: the chat the card is credited to from the start (tools._as_fork),
    else the chat of the subagent its held record names (holder; session.chat_of_agent), when that chat is a thread;
    '' for any other card."""
    from . import agents, session  # noqa: PLC0415

    by = str(cell.get("created_by") or "")
    rec = cell.get(HELD) if isinstance(cell.get(HELD), dict) else {}
    chat = by.removeprefix("chat:") if by.startswith("chat:") else session.chat_of_agent(c, str(rec.get("agent") or ""))
    meta = agents.meta_or_none(c, chat) if chat else None
    return str(chat) if meta is not None and meta.get("kind") == agents.KIND_THREAD else ""


def _context(c: str, cell: dict[str, Any], author: str) -> str:
    """The work that led to the card, as the card check reads it (card_check._context_text) in fewer words: for a card
    of main's, main's conversation and its threads, and a thread's fork's card reads that thread whole whatever the
    budget cuts, since the analyst's request is its question; the chat of the session that made it otherwise."""
    from . import card_check, context  # noqa: PLC0415

    try:
        focus = (f"card:{cell.get('id')}",)
        if author == card_check.MAIN:
            thread = _thread_of(c, cell)
            return context.render(c, budget=CONTEXT_CHARS, focus=(*focus, *((f"thread:{thread}",) if thread else ())),
                                  parts=("conversation", "threads"))
        chat = card_check._session_chat(c, cell, author)
        return context.render(c, budget=CONTEXT_CHARS, focus=focus, parts=("session",), chat=chat) if chat else ""
    except Exception:  # noqa: BLE001 — the critique reads the card without its context rather than not at all
        log.debug("card fit: no context for card:%s", cell.get("id"), exc_info=True)
        return ""


async def critique_of(c: str, cell: dict[str, Any], author: str, drawn: render.Rendered) -> str:
    """The critique of a version of card `cell` that does not fit, drawn as `drawn` (render.render_card), which one other
    than its author made: the card check's replacement, which gets a critique and one more version as a version of its
    author's does (card_check._revise_to_fit). `author` is the session whose work led to the card. '' when the call
    failed. One `critique` line of the log."""
    size, t0 = size_of(drawn), time.perf_counter()
    critique, why = await _critique(c, cell, author, size, drawn.png)
    _log(c, action="critique", card=str(cell.get("id") or ""), by="check", kind=cell.get("kind"), author=author,
         critique_ms=_ms(t0), critique=critique, why=why, body=round(size.body), width=round(size.width),
         frame=round(size.frame))
    return critique


async def _critique(c: str, cell: dict[str, Any], author: str, size: Size,
                    png: bytes | None) -> tuple[str, str]:
    """(the critique, '') from one model call on the card (module note); ('', why) when the call failed."""
    from . import card_check, model, prompts, tools  # noqa: PLC0415

    secs = _sections()
    none = secs.get("none", "None.")
    user = prompts._fill(secs["card"], {
        "card": str(cell.get("id") or ""), "kind": str(cell.get("kind") or "code"), "where": size.where(),
        "question": str(cell.get("title") or "") or none,
        "takeaway": str(cell.get("takeaway") or "").strip() or none,
        "content": await asyncio.to_thread(_content, c, cell) or none,
        "context": await asyncio.to_thread(_context, c, cell, author) or none,
    }, f"{PROMPT}.md")
    system = prompts._fill(secs["critic"], {"guidance": await asyncio.to_thread(_guidance)}, f"{PROMPT}.md")
    desc, schema = tools.split_section(secs["critique"])
    role = config.call_settings(c, "verify")
    images = []
    if png:
        try:
            images = [(await asyncio.to_thread(card_check.fit_image, png), "image/png")]
        except Exception:  # noqa: BLE001 — a picture that does not open: the critique reads the card's content alone
            log.warning("card fit: the picture of card:%s did not open", cell.get("id"))
    res = await model.structured(user, tool=model.ToolSpec(name="critique", description=desc, input_schema=schema),
                                 model=role["model"], effort=CRITIQUE_EFFORT, speed=role["speed"],
                                 refusal=role["refusal"], system=system, cwd=config.corpus_dir(c), images=images,
                                 idle_timeout_s=CRITIQUE_IDLE_S)
    text = " ".join(str((res.output or {}).get("critique") or "").split()) if res.status == "ok" else ""
    if text:
        return text, ""
    log.warning("card fit: the critique of card:%s failed (%s: %s)", cell.get("id"), res.status, res.detail)
    return "", res.detail or res.status
