"""The orientation as the server sees it: its record, for the readers that need it without its agent.

No model runs here. The orientation is `thimble:orientation`, a subagent of the analyst's Claude Code session
(orient_session.py, subagents.py, prompts/orient.md), started by main's Agent call after `start_orientation`, or by a
click through thimble's plugin module (POST /ws/{c}/start, which a pre-cache sends; the page no longer does). Each takes
the request and the run's model and effort, nothing else: the orientation decides how far to explore and whether to
start a critic, and leaves its findings as cards in its deck, group `Orientation`. This module keeps the run's record:
asked for (start_requested), starting until the agent starts (started) or the start does not happen (refuse), and its
end (finished).

The orientation's cards go to its deck, the root group `Orientation`, whatever group a call names, so the model never
writes into the analyst's Your work. Its deck cards show on the canvas as it adds them. A follow-up continues the same
agent, and its changes land in place, one Undo reverting them all.

  orient/run.json    {status: requested|starting|running|done|failed|stopped|refused, passes, query, model?, effort?,
                      route?: subagent|program, started_by?: click|typed, agent_id?, request?,
                      refused?: {reason, kind, at, expired?}, requested?, started, ended, groups: {orientation},
                      chats: {orient?}, session?, error?, run (0 the first, then one per follow-up),
                      followups: [{run, status, started, ended, messages, added, revised, deleted, views}],
                      coverage? (run 0's coverage line, orient_session.measure), coverage_told? (a later run's prompt
                      carried it)}
  orient/summary.md  the agent's last message, then run 0's coverage line, kept as a record for the export

`passes` is `["final"]`, the deck (DECK), which the readers of a deck look for (deck_of, tray, thimble-agents). A record
from before 0.8.0 may name other passes (`views`, `report`) and keep `critique`, `report_asked` and `revised_cards`,
from the switches a start had then; it still loads, and nothing acts on those keys. `query` is only ever the analyst's
own words. A run with a `final` group uses it as its deck. `status` is the latest run's, so start_orientation refuses
while any run goes. `model` and `effort` are the run's exact values.
"""
from __future__ import annotations

import contextlib
import logging
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


from . import agents, config, investigation, ledger
from .ledger import read_json, write_json

log = logging.getLogger("thimble.orientation")

PLUGIN = "thimble"  # the plugin's name (plugin/.claude-plugin/plugin.json), the scope of its agents and skills
DECK = "final"  # a record's one pass, the deck (module note)
ROLE = "orient"  # the orientation's chat role
TITLE = "Orientation"  # the agent chat's title
ORIENT_KIND = "orient"  # the event kind that tells main the orientation ended (prompts/main.md)
GROUP_PATHS = {"deck": "Orientation"}  # the orientation's one group, its deck
RUNNING = ("requested", "starting", "running")
# a start that has no agent this long after it was asked for is taken as dropped (a click's answer comes within
# module_bridge's wait, and a typed start ends with main's turn: subagents, R1–R3)
REQUEST_WAIT_S = 600.0
# analyst-facing lines
CARDS_CHIP = "the orientation's cards"
FOLLOWUP_LABEL = "the orientation's follow-up"  # the undo label of a follow-up's changes (undo.batching)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# --------------------------------------------------------------------------- storage


def orient_dir(c: str) -> Path:
    d = config.workspace_dir(c) / "orient"
    d.mkdir(parents=True, exist_ok=True)
    return d


def run_file(c: str) -> Path:
    return orient_dir(c) / "run.json"


def summary_file(c: str) -> Path:
    return orient_dir(c) / "summary.md"


def read_run(c: str) -> dict[str, Any] | None:
    try:
        run = read_json(config.workspace_dir(c) / "orient" / "run.json", None)
    except (OSError, ValueError):
        return None
    return run if isinstance(run, dict) else None


def summary(c: str) -> str | None:
    p = summary_file(c)
    return p.read_text("utf-8") if p.is_file() else None


def _write_run(c: str, run: dict[str, Any]) -> dict[str, Any]:
    with ledger.locked(run_file(c)):
        write_json(run_file(c), run)
    return run


def _run_change(fn: Any) -> Any:
    """Run a change to run.json under its lock (ledger.locked), from its read to its write: the server or the terminal
    mode's shim, the hooks' backend calls and `thimble act stop` change it from more than one process."""
    import functools  # noqa: PLC0415

    @functools.wraps(fn)
    def wrapper(c: str, *args: Any, **kwargs: Any) -> Any:
        with ledger.locked(run_file(c)):
            return fn(c, *args, **kwargs)

    return wrapper


@_run_change
def record(c: str, **fields: Any) -> dict[str, Any] | None:
    """Set fields on the run's record (orient_session keeps the run's model and effort, the coverage line and the
    extension whose program ran it there); None when there is no record."""
    run = read_run(c)
    if run is None:
        return None
    run.update(fields)
    return _write_run(c, run)


def _emit(c: str, status: str, **fields: Any) -> None:
    try:
        investigation.emit(c, investigation.MAIN, {"type": "orient", "status": status, **fields})
    except Exception:  # noqa: BLE001 — the stream is a courtesy; run.json is the record
        log.warning("orientation %s: could not emit %s", c, status, exc_info=True)


def ensure_groups(c: str, deck: bool = False) -> dict[str, str]:
    """{orientation}: the id of the deck, the root group `Orientation`, found or made by the path add_card resolves, so
    a later orientation appends to it. A deck made here is a column. With `deck`, an Orientation stored as a row holding
    Final and Scratch becomes a column too; a Scratch inside it is moved out first (notebook.migrate_scratch)."""
    from . import notebook, tools  # noqa: PLC0415 — both import far more than the mirror needs at import

    ws = config.workspace_dir(c)
    notebook.migrate_scratch(c)
    made: list[str] = []
    with notebook.editing(ws):
        top = tools.group_path(ws, GROUP_PATHS["deck"], made=made)
        nb = notebook.read_notebook(ws, top)
        if nb is not None and nb.get("kind") != notebook.DEFAULT_GROUP_KIND and (deck or GROUP_PATHS["deck"] in made):
            nb["kind"] = notebook.DEFAULT_GROUP_KIND
            notebook.write_notebook(ws, nb)
    return {"orientation": top}


def deck_of(run: dict[str, Any] | None) -> str | None:
    """The id of a run's deck: a recorded `final` group, else its Orientation group; None for a record from before
    0.8.0 whose start turned the deck off (its passes lack DECK)."""
    if not run or DECK not in (run.get("passes") or []):
        return None
    groups = run.get("groups") or {}
    return str(groups.get("final") or groups.get("orientation") or "") or None


def _at(ts: Any) -> datetime | None:
    try:
        at = datetime.fromisoformat(str(ts or "").replace("Z", "+00:00"))
    except ValueError:
        return None
    return at if at.tzinfo else at.replace(tzinfo=timezone.utc)


def drafting(c: str) -> bool:
    """Whether the orientation's first run is going, the one whose outputs stay drafts until it ends: its record says
    running, as run 0, and its session is alive."""
    run = read_run(c)
    return bool(run and run.get("status") == "running" and int(run.get("run") or 0) == 0 and running(c))


def _gone(run: dict[str, Any]) -> bool:
    """Whether a run's own session process is gone (a server that died under it never recorded its end)."""
    pid = run.get("pid")
    if not run.get("session") or not isinstance(pid, int) or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return True
    except OSError:
        return False
    return False


def active(c: str) -> bool:
    """Whether an orientation has started and still runs: its chat is running and its session's process, when it has
    one, is alive (a start not yet taken up is not active)."""
    run = read_run(c)
    chat = (run or {}).get("chats", {}).get(ROLE) if run and run.get("status") == "running" else None
    meta = agents.meta_or_none(c, str(chat)) if chat else None
    return meta is not None and meta.get("status") == "running" and not _gone(run or {})


def running(c: str) -> bool:
    """Whether an orientation is running: its record says so and its agent chat has not ended, or a start was asked
    for less than REQUEST_WAIT_S ago and main has not started the orientation yet (after that the request is taken as
    dropped)."""
    run = read_run(c)
    if not run or run.get("status") not in RUNNING:
        return False
    chat = (run.get("chats") or {}).get(ROLE)
    if chat:
        meta = agents.meta_or_none(c, str(chat))
        return meta is not None and meta.get("status") == "running" and not _gone(run)
    try:
        asked = datetime.fromisoformat(str(run.get("requested") or ""))
    except ValueError:
        return False
    return (datetime.now(timezone.utc) - asked).total_seconds() < REQUEST_WAIT_S


# --------------------------------------------------------------------------- the three moments


@_run_change
def start_requested(c: str, payload: dict[str, Any]) -> dict[str, Any] | None:
    """A start of the orientation was asked for (orient_session.start): the run is recorded as `starting`, with its
    request, the run's exact model and effort, the request id and who started it (`started_by`: click or typed), and
    its deck is made. A start while an orientation runs keeps the running record."""
    if running(c):
        log.info("%s: a start while an orientation runs; the record of the running one is kept", c)
        return None
    text = str(payload.get("text") or "").strip()
    return _write_run(c, {"status": "starting", "passes": [DECK], "query": text or None,
                          "model": payload.get("model") or None, "effort": payload.get("effort") or None,
                          "route": "subagent", "started_by": payload.get("started_by") or "click",
                          "request": payload.get("request"), "agent_id": None, "refused": None,
                          "requested": _now(), "started": None, "ended": None,
                          "groups": ensure_groups(c, deck=True), "chats": {}, "error": None})


@_run_change
def refuse(c: str, reason: str, kind: str, **fields: Any) -> dict[str, Any] | None:
    """A start that did not happen: the record ends `refused` with {reason, kind, at} and `fields` (the request, a
    click that expired), which the browser's card shows with the kind's buttons. None when there is no starting
    record."""
    run = read_run(c)
    if not run or run.get("status") not in ("requested", "starting"):
        return None
    run.update(status="refused", ended=_now(), refused={"reason": str(reason or ""), "kind": kind, "at": _now(),
                                                         **{k: v for k, v in fields.items() if v is not None}})
    _write_run(c, run)
    _emit(c, "refused", kind=kind, reason=str(reason or ""))
    return run


@_run_change
def request(c: str, brief: str, **fields: Any) -> dict[str, Any]:
    """Record a start of the orientation that an extension's program runs (orient_session.start), as start_requested
    records thimble's own: requested, with its brief, and its deck made. `fields` go on the record too."""
    return _write_run(c, {"status": "requested", "passes": [DECK], "query": brief.strip() or None,
                          "requested": _now(), "started": None, "ended": None,
                          "groups": ensure_groups(c, deck=True), "chats": {}, "error": None, **fields})


@_run_change
def started(c: str, chat_id: str, *, session: str | None = None, pid: int | None = None, agent_id: str | None = None,
            route: str | None = None) -> dict[str, Any]:
    """The orientation's agent (or program) started: a starting or requested run becomes running with its chat, as
    run 0, its agent id and route, and an orientation no start asked for opens a run of its own. A requested run keeps
    its passes, and a new run has the deck."""
    run = read_run(c)
    asked = bool(run and run.get("status") in ("requested", "starting"))
    passes = list((run or {}).get("passes") or [DECK]) if asked else [DECK]
    groups = ensure_groups(c, deck=True) if DECK in passes else {}
    extra = {k: v for k, v in (("session", session), ("pid", pid), ("agent_id", agent_id), ("route", route)) if v is not None}
    fresh = {"run": 0, "followups": [], "coverage": None, "coverage_told": False}
    if run and asked:
        run.update(status="running", started=_now(), passes=list(passes), groups=groups, chats={ROLE: chat_id},
                   refused=None, **fresh, **extra)
    elif run and run.get("status") == "running" and (run.get("chats") or {}).get(ROLE) == chat_id:
        run.update(extra)
        return _write_run(c, run)
    else:
        run = {"status": "running", "passes": list(passes), "query": None, "started": _now(), "ended": None, "groups": groups,
               "chats": {ROLE: chat_id}, "error": None, **fresh, **extra}
    _write_run(c, run)
    if groups.get("orientation"):  # the chat's group is where the cards it writes land: the deck
        agents.update_agent(c, chat_id, group=groups["orientation"])
    _emit(c, "started", passes=run["passes"])
    return run


@_run_change
def finished(c: str, chat_id: str, status: str, result: str | None) -> dict[str, Any] | None:
    """The first run stopped: its last message is kept as summary.md, the run ends with the session's status, and main's
    chat gets the orientation's landing (an `artifact` chip naming its chat), with the deck when it has cards, and for a
    failed run always, since the landing is where main's chat says it failed and why. A notification for another
    session, or for a run already ended, changes nothing."""
    run = read_run(c)
    if not run or (run.get("chats") or {}).get(ROLE) != chat_id or run.get("status") not in RUNNING:
        return None
    text = str(result or "").strip()
    if status == "done" and text:
        summary_file(c).write_text(text + "\n", "utf-8")
    run.update(status=status if status in ("done", "failed", "stopped") else "done", ended=_now(),
               error=None if status == "done" else (text[:400] or status))
    _write_run(c, run)
    deck = deck_of(run)
    cards = bool(deck and _has_cards(c, deck))
    if cards or run["status"] == "failed":
        agents.chip(c, "artifact", CARDS_CHIP, ref=f"group:{deck}" if cards else None, chat=chat_id)
    _emit(c, run["status"], **({"error": run["error"]} if run.get("error") else {}))
    return read_run(c) or run


def _has_cards(c: str, group: str) -> bool:
    from . import notebook  # noqa: PLC0415

    return bool((notebook.read_notebook(config.workspace_dir(c), group) or {}).get("cells"))


@_run_change
def run_started(c: str, chat_id: str, k: int, messages: "list[dict[str, Any]]", *, pid: int | None = None) -> dict[str, Any] | None:
    """A follow-up of the orientation `chat_id` started as run `k` (orient_session.message): the record runs again,
    with the messages it carries and when it started."""
    run = read_run(c)
    if not run or (run.get("chats") or {}).get(ROLE) != chat_id:
        return None
    ups = [u for u in run.get("followups") or [] if isinstance(u, dict) and u.get("run") != k]
    ups.append({"run": k, "status": "running", "started": _now(), "ended": None,
                "messages": [{"text": str(m.get("text") or ""), "by": m.get("by")} for m in messages]})
    run.update(status="running", run=k, followups=ups, error=None, **({"pid": pid} if pid else {}))
    _write_run(c, run)
    _emit(c, "started", run=k)
    return run


@_run_change
def run_finished(c: str, chat_id: str, k: int, status: str, made: dict[str, int]) -> dict[str, Any] | None:
    """A follow-up ended: the record says so, with what it changed (`made`: added, revised, deleted, views), which the
    orientation's chat shows on its card (its meta's `followups`)."""
    run = read_run(c)
    if not run or (run.get("chats") or {}).get(ROLE) != chat_id or int(run.get("run") or 0) != k:
        return None
    status = status if status in ("done", "failed", "stopped") else "done"
    for u in run.get("followups") or []:
        if isinstance(u, dict) and u.get("run") == k:
            u.update(status=status, ended=_now(), **made)
    run.update(status=status, ended=_now())
    _write_run(c, run)
    with contextlib.suppress(Exception):
        agents.update_agent(c, chat_id, followups=run.get("followups") or [])
    _emit(c, status, run=k, **made)
    return run
