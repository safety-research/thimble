"""A card that does not fit on the analyst's screen shows once the card check has read it, as the check's replacement.

tools.call hands every add_card and edit_card result to after_tool(). The card the call made, or whose content it
changed, is drawn offscreen by the card harness (render.render_card) at the card's width, which measures its body whole
(a custom card's page whole, with what its own scroll boxes hold past their height, and a table's rows past the ones it
shows first: render.Rendered.body) and the width its content lays out at (Rendered.width, in a room Rendered.frame px
wide). No model takes part in the measure. A body past card_size.BODY_MAX, or content wider than its room, does not fit:

1. A card that fits shows at once, and the card check reads it as it reads any card (card_check).
2. A card that does not fit is held (its `held` record, notebook.set_held): the canvas shows it as a card that still
   runs, with its question and the running line and without its content or its takeaway. It is held from the moment the
   call stores its content until the measure ends (notebook.MEASURING, which tools.call sets around the call:
   measuring), so the canvas shows no version that does not fit, even for that moment. The card check reads it with one
   more criterion (prompts/card-check.md `## too-large`), and the card shows when that check ends (checked): as the
   check's replacement, or as it stands when the check left it. A replacement that still does not fit shows as any card
   does, its rest behind Show all. The call's result says nothing of it: the author reads what it read before.
3. A held card whose check has not begun, such as one with no takeaway yet, shows as it stands when the turn or run of
   the one who made it ends: main's turn (session._end_turn calls turn_ended), a run of one of thimble's agents
   (subagents.run_ended calls run_ended), or a subagent of main's (session._finish_sub calls agent_ended). The record
   names who made the version (holder): the session of one of thimble's agents (`author`), or a subagent of main's, such
   as a thread's fork (`agent`); neither for main's own call. Every held card shows when the server starts again
   (notebook.mark_interrupted_cells).

Where no card can be drawn (render.down, or the harness failed on this card), outside browser mode, where no server
hears main's turn end, or where the workspace does not check cards by itself (card_check.auto), nothing is held. Each
step is one line of workspaces/<c>/card-fit.jsonl.
"""
from __future__ import annotations

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
HELD = "held"  # the card's record while it is held (notebook.set_held)
LOG_FILE = "card-fit.jsonl"
NOT_MEASURED = ("label", "plan")  # a label card is drawn from its label, and a plan from its steps


@dataclass(frozen=True)
class Size:
    """A card as the harness drew it at its width: its body's whole height, and the width its content lays out at in its
    room (both 0 when nothing in it lays out wider), in CSS px."""

    body: float
    width: float = 0.0
    frame: float = 0.0

    @property
    def fits(self) -> bool:
        from .card_size import BODY_MAX  # noqa: PLC0415

        # as the page measures a width: a px of rounding is no overflow
        return self.body <= BODY_MAX and not (self.frame > 0 and self.width > self.frame + 1)


def size_of(drawn: render.Rendered) -> Size:
    """A card as the harness drew it (render.render_card), measured."""
    return Size(body=drawn.body, width=drawn.width, frame=drawn.frame)


# (workspace, card) -> the version last settled: measured to fit, or shown
_settled: dict[tuple[str, str], str] = {}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _ms(t0: float) -> int:
    return round((time.perf_counter() - t0) * 1000)


def _log(c: str, **line: Any) -> None:
    """One step as a line of workspaces/<c>/card-fit.jsonl. Never raises."""
    try:
        ledger.append_jsonl_locked(config.workspace_dir(c) / LOG_FILE, {"ts": _now(), **line})
    except Exception:  # noqa: BLE001 — a line not written never changes what the card does
        log.debug("card fit: the line was not written", exc_info=True)


def held(cell: dict[str, Any] | None) -> bool:
    """Whether a card is held: it waits for its measure, or, as one that does not fit, for its check."""
    return isinstance((cell or {}).get(HELD), dict)


def too_large(cell: dict[str, Any] | None) -> bool:
    """Whether a card is held as one that does not fit on the analyst's screen, as measured: the card check reads it
    with one more criterion (card_check)."""
    return held(cell) and not cell[HELD].get("measuring")


def holds_here(c: str) -> bool:
    """Whether a card can be held in workspace `c`: the harness can draw it, this is the server, which hears main's turn
    end (launch_mode: the server runs in browser mode), and the card check reads a card by itself (card_check.auto)."""
    from . import card_check, launch_mode  # noqa: PLC0415

    return (render.enabled() and not render.down() and launch_mode.current() == launch_mode.BROWSER
            and card_check.enabled() and card_check.auto(c))


def holder(c: str, name: str, session: str | None, tool_use_id: str | None) -> dict[str, str]:
    """Who makes the version an add_card or edit_card call stores, as the card's held record names it: `author`, the
    session of one of thimble's agents the call runs as (tools.Ctx.session, such as `orient` or `writer:<doc>`, its
    descendants' calls too), or `agent`, the subagent of main's that made a call through main's shim, such as a thread's
    fork (the caller hook's line, subagent_files.find_caller). {} for main's own call, for any other tool, and where no
    card is held."""
    if name not in FIT_TOOLS or not holds_here(c):
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
def measuring(c: str, name: str, who: dict[str, str] | None = None) -> Iterator[None]:
    """Around a tool's call (tools.call): the card an add_card or edit_card call makes, or whose content it changes, is
    held from the moment its content is stored until after_tool measures it (notebook.MEASURING), its record naming
    `who` made it (holder)."""
    from . import notebook  # noqa: PLC0415

    token = (notebook.MEASURING.set({**notebook.MEASURING_HELD, **(who or {})})
             if name in FIT_TOOLS and holds_here(c) else None)
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


# --------------------------------------------------------------------------- the tool path


async def after_tool(c: str, name: str, args: dict[str, Any] | None, res: Any, *, session: str | None = None,
                     anchor: str | None = None, agent: str = "") -> Any:
    """Called by tools.call with every result: measures the card an add_card or edit_card result names when its content
    changed, and holds or shows it (module note). `agent` is the subagent of main's that made the call (holder). The
    result goes back unchanged. Never raises."""
    if name not in FIT_TOOLS or not holds_here(c):
        return res
    cid = None
    try:
        from . import card_check  # noqa: PLC0415 — card_check imports the harness

        cid = card_check.card_of(name, args, res.text, anchor)
        if cid and not res.is_error:
            await fit(c, cid, card_check.author_of(session), agent=agent)
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
        if held(cell) and not too_large(cell):
            notebook.set_held(c, cid, None)
    except Exception:  # noqa: BLE001 — a card left waiting shows when the turn or run of the one who made it ends
        log.exception("card fit: card:%s did not show after its measure", cid)


async def fit(c: str, cid: str, author: str, *, agent: str = "") -> None:
    """Card `cid` measured, then shown, or held for its check (module note). `author` is the session whose work led to
    the card (card_check's author_of), and `agent` the subagent of main's that made this version (holder), '' for
    none."""
    from . import card_size, notebook  # noqa: PLC0415

    cell = notebook.get_cell(c, cid)
    if cell is None or not _measures(cell):
        return
    v = card_size.version(cell)
    if too_large(cell) and cell[HELD].get("version") == v:
        return  # its content is as it was measured: the call set a takeaway or a question, or moved the card
    if not too_large(cell) and _settled.get((c, cid)) == v:
        return
    t0 = time.perf_counter()
    size = await _measure(c, cell)
    if size is None:
        return  # it shows once its measure ends (_measured)
    line = {"card": cid, "kind": cell.get("kind"), "author": author, "render_ms": _ms(t0), "body": round(size.body),
            "width": round(size.width), "frame": round(size.frame)}
    if size.fits:
        _settled[(c, cid)] = v
        _log(c, action="fits", **line)
        return
    notebook.set_held(c, cid, {"version": v, "since": _now(), "author": author, **({"agent": agent} if agent else {}),
                               "body": round(size.body), "width": round(size.width), "frame": round(size.frame)})
    _log(c, action="held", **line)


def show(c: str, cid: str, why: str, **line: Any) -> bool:
    """Card `cid` no longer held: the canvas shows it as it stands, and that version is settled (fit measures it no
    more). Whether it was held."""
    from . import card_check, card_size, notebook  # noqa: PLC0415

    cell = notebook.get_cell(c, cid)
    if cell is None or not held(cell):
        return False
    since, author = str(cell[HELD].get("since") or ""), str(cell[HELD].get("author") or card_check.MAIN)
    shown = notebook.set_held(c, cid, None) or cell
    _settled[(c, cid)] = card_size.version(shown)
    _log(c, action="shown", why=why, **({"since": since} if since else {}), **{"card": cid, "author": author, **line})
    return True


def checked(c: str, cid: str, version: str) -> bool:
    """The card check of card `cid`, which began on the version `version` (card_size.version), ended (card_check): the
    card, held as that version did not fit, shows as the check left it. A newer version the author made since waits
    for its own measure and check, and so does a card that a newer check reads now. Whether it showed."""
    from . import card_check, notebook  # noqa: PLC0415

    cell = notebook.get_cell(c, cid)
    if not too_large(cell) or cell[HELD].get("version") != version or any(r.cid == cid for r in card_check.running(c)):
        return False
    return show(c, cid, "checked")


def _holder_of(rec: dict[str, Any]) -> tuple[str, str]:
    """(author, agent) of a held record (holder): the session of the agent of thimble's that made its version, else
    `main`, and the subagent of main's that made it, else ''."""
    from . import card_check  # noqa: PLC0415

    return str(rec.get("author") or card_check.MAIN), str(rec.get("agent") or "")


def _release(c: str, theirs: Callable[[str, str], bool], why: str) -> list[str]:
    """Each card held in workspace `c` whose record's (author, agent) `theirs` takes, and that no check reads now, shows
    as it stands: no check begins for it now. A card a check reads shows when that check ends (checked). The cards
    shown."""
    from . import card_check, notebook  # noqa: PLC0415

    out = []
    try:
        reading = {r.cid for r in card_check.running(c)}
        ws = config.workspace_dir(c)
        for nb in notebook.list_notebooks(ws):
            for cell in (notebook.read_notebook(ws, str(nb.get("id") or "")) or {}).get("cells") or []:
                rec, cid = cell.get(HELD), str(cell.get("id"))
                if isinstance(rec, dict) and theirs(*_holder_of(rec)) and cid not in reading and show(c, cid, why):
                    out.append(cid)
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


async def _measure(c: str, cell: dict[str, Any]) -> Size | None:
    """The card's size as the harness draws it; None where no card can be drawn, or this card did not draw (its author
    reads its run's result, and the page measures what it shows)."""
    try:
        drawn = await render.render_card(c, {k: v for k, v in cell.items() if k != HELD})
    except render.Unavailable as e:
        log.debug("card fit: card:%s not drawn (%s)", cell.get("id"), e)
        return None
    if not drawn.ok:
        log.info("card fit: card:%s did not draw: %s", cell.get("id"), drawn.error)
        return None
    return size_of(drawn)
