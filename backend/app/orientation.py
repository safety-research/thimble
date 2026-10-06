"""The orientation as the server sees it: its record, for the readers that need it without its agent.

No model runs here. The orientation is `thimble:orientation`, a subagent of the analyst's Claude Code session
(orient_session.py, subagents.py, prompts/orient.md), started by Start in the browser (a click through thimble's plugin
module) or by main's Agent call after `start_orientation`. Each takes the request and four switches (the deck, group
`Orientation`; the views; the critique; the report) and the run's model and effort. This module keeps the run's record:
asked for (start_requested), starting until the agent starts (started) or the start does not happen (refuse), and
its end (finished).

The orientation's cards go to its deck, the root group `Orientation`, whatever group a call names, so the model never
writes into the analyst's Your work. Its deck cards show on the canvas as it adds them; the first run's view proposals
stay unlisted (holding) while they build. A follow-up continues the same agent, and its changes land in place, one Undo
reverting them all.

  orient/run.json    {status: requested|starting|running|done|failed|stopped|refused, passes, query, critique?,
                      model?, effort?, route?: subagent|program, started_by?: click|typed, agent_id?, request?,
                      refused?: {reason, kind, at, expired?}, requested?, started, ended, groups: {orientation},
                      chats: {orient?}, session?, error?, run (0 the first, then one per follow-up),
                      followups: [{run, status, started, ended, messages, added, revised, deleted, views}],
                      report_asked?, coverage? (run 0's coverage line, orient_session.measure), coverage_told? (a
                      later run's prompt carried it)}
  orient/summary.md  the agent's last message, then run 0's coverage line, kept as a record for the export

`query` is only ever the analyst's own words. A run with a `final` group uses it as its deck. `status` is the latest
run's, so start_orientation refuses while any run goes. `model` and `effort` are the run's exact values.

When run 0 ends, the held proposals appear, and the orientation's chat gets chips for them. When the report was asked
for, orient_session starts the report's writer through the module (request_report) once the run ends.
"""
from __future__ import annotations

import contextlib
import logging
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


from . import agents, config, investigation
from .ledger import read_json, write_json

log = logging.getLogger("thimble.orientation")

PLUGIN = "thimble"  # the plugin's name (plugin/.claude-plugin/plugin.json), the scope of its agents and skills
DEFAULT_CRITIQUE = False  # an orientation runs no critique unless Start or start_orientation's `critique` turns it on
ROLE = "orient"  # the orientation's chat role
TITLE = "Orientation"  # the agent chat's title
ORIENT_KIND = "orient"  # the event kind that tells main the orientation ended (prompts/main.md)
GROUP_PATHS = {"deck": "Orientation"}  # the orientation's one group, its deck
REPORT_DOC = "report"
RUNNING = ("requested", "starting", "running")
# a start that has no agent this long after it was asked for is taken as dropped (a click's answer comes within
# module_bridge's wait, and a typed start ends with main's turn: subagents, R1–R3)
REQUEST_WAIT_S = 600.0
PART_SWITCHES = {"final": "final", "views": "views", "report": "report"}  # part_on: the parts the record's passes name
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
    write_json(run_file(c), run)
    return run


def record(c: str, **fields: Any) -> dict[str, Any] | None:
    """Set fields on the run's record (orient_session keeps Start's choices, the queue and the cards a follow-up
    revised there); None when there is no record."""
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


def flag(value: Any, default: bool) -> bool:
    """A Start choice sent as a boolean, or as the string an event attribute carries."""
    if isinstance(value, bool):
        return value
    if isinstance(value, str) and value.strip().lower() in ("true", "false"):
        return value.strip().lower() == "true"
    return default


def part_on(c: str, part: str) -> bool:
    """Whether the latest orientation's run has `part` on: an output its switches turned on (final, views, report), or
    the critique. One registration serves every run, so a tool of a part that is off refuses a call instead of leaving
    the agent's tools (orient_session.PART_TOOLS)."""
    run = read_run(c) or {}
    if part == "critique":
        return bool(run.get("critique"))
    return part in (run.get("passes") or [])


def ensure_groups(c: str, deck: bool = False) -> dict[str, str]:
    """{orientation}: the id of the deck, the root group `Orientation`, found or made by the path add_card resolves, so
    a later orientation appends to it. A deck made here is a column. With `deck`, an Orientation stored as a row holding
    Final and Scratch becomes a column too; a Scratch inside it is moved out first (notebook.migrate_scratch)."""
    from . import notebook, tools  # noqa: PLC0415 — both import far more than the mirror needs at import

    ws = config.workspace_dir(c)
    notebook.migrate_scratch(c)
    made: list[str] = []
    top = tools.group_path(ws, GROUP_PATHS["deck"], made=made)
    nb = notebook.read_notebook(ws, top)
    if nb is not None and nb.get("kind") != notebook.DEFAULT_GROUP_KIND and (deck or GROUP_PATHS["deck"] in made):
        nb["kind"] = notebook.DEFAULT_GROUP_KIND
        notebook.write_notebook(ws, nb)
    return {"orientation": top}


def deck_of(run: dict[str, Any] | None) -> str | None:
    """The id of a run's deck when its deck is on: a recorded `final` group, else its Orientation group; None when off.
    """
    if not run or "final" not in (run.get("passes") or []):
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
    one, is alive (a Start not yet taken up is not active)."""
    run = read_run(c)
    chat = (run or {}).get("chats", {}).get(ROLE) if run and run.get("status") == "running" else None
    meta = agents.meta_or_none(c, str(chat)) if chat else None
    return meta is not None and meta.get("status") == "running" and not _gone(run or {})


def running(c: str) -> bool:
    """Whether an orientation is running: its record says so and its agent chat has not ended, or a Start was sent
    less than REQUEST_WAIT_S ago and main has not started the orientation yet (after that the request is taken as
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


def start_requested(c: str, payload: dict[str, Any]) -> dict[str, Any] | None:
    """A start of the orientation was asked for (orient_session.start): the run is recorded as `starting`, with its
    passes, request, critique, the run's exact model and effort, the request id and who started it (`started_by`:
    click or typed), and the deck is made when on. A start while an orientation runs keeps the running record."""
    if running(c):
        log.info("%s: a start while an orientation runs; the record of the running one is kept", c)
        return None
    text = str(payload.get("text") or "").strip()
    passes = [p for p in ("final", "views", "report") if p in (payload.get("passes") or [])]
    return _write_run(c, {"status": "starting", "passes": passes, "query": text or None,
                          "critique": flag(payload.get("critique"), DEFAULT_CRITIQUE),
                          "model": payload.get("model") or None, "effort": payload.get("effort") or None,
                          "route": "subagent", "started_by": payload.get("started_by") or "click",
                          "request": payload.get("request"), "agent_id": None, "refused": None,
                          "requested": _now(), "started": None, "ended": None,
                          "groups": ensure_groups(c, deck=True) if "final" in passes else {}, "chats": {}, "error": None})


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


def request(c: str, brief: str, passes: "list[str]", **fields: Any) -> dict[str, Any]:
    """Record an orientation main asked for with no Start waiting, as a Start records one (start_requested): requested,
    with its passes and brief, and the deck made when on. `fields` go on the record too."""
    return _write_run(c, {"status": "requested", "passes": list(passes), "query": brief.strip() or None,
                          "requested": _now(), "started": None, "ended": None,
                          "groups": ensure_groups(c, deck=True) if "final" in passes else {}, "chats": {}, "error": None,
                          **fields})


def start_passes(payload: dict[str, Any]) -> list[str]:
    """The outputs a Start turned on, from its switches (`final_notebook` for the deck, `propose_views`,
    `generate_report`); with all three off the orientation leaves its thread. `analyze_data` and `report` are accepted
    as alternate names."""
    final = flag(payload.get("final_notebook", payload.get("analyze_data")), True)
    views = flag(payload.get("propose_views"), True)
    report = flag(payload.get("generate_report", payload.get("report")), False)
    return [p for p, on in (("final", final), ("views", views), ("report", report)) if on]


def started(c: str, chat_id: str, *, session: str | None = None, pid: int | None = None,
            passes: "list[str] | None" = None, agent_id: str | None = None, route: str | None = None) -> dict[str, Any]:
    """The orientation's agent (or program) started: a starting or requested run becomes running with its chat, as
    run 0, its agent id and route, and an orientation nobody asked Start for opens a run of its own. `passes` from the
    start win over the record's; without them a requested run keeps its own and a new run has deck and views."""
    run = read_run(c)
    asked = bool(run and run.get("status") in ("requested", "starting"))
    if passes is None:
        passes = list((run or {}).get("passes") or ["final", "views"]) if asked else ["final", "views"]
    groups = ensure_groups(c, deck=True) if "final" in passes else {}
    extra = {k: v for k, v in (("session", session), ("pid", pid), ("agent_id", agent_id), ("route", route)) if v is not None}
    fresh = {"run": 0, "followups": [], "report_asked": False, "coverage": None, "coverage_told": False}
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


def finished(c: str, chat_id: str, status: str, result: str | None, report: bool = True) -> dict[str, Any] | None:
    """The first run stopped: its last message is kept as summary.md, the run ends with the session's status, and main's
    chat gets the orientation's landing (an `artifact` chip naming its chat), with the deck when it has cards, and for a
    failed run always, since the landing is where main's chat says it failed and why. With `report`, a done run that
    asked for the report asks for it. A notification for another session, or for a run already ended, changes
    nothing."""
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
    if report and status == "done" and "report" in (run.get("passes") or []):
        request_report(c)
    return read_run(c) or run


def _has_cards(c: str, group: str) -> bool:
    from . import notebook  # noqa: PLC0415

    return bool((notebook.read_notebook(config.workspace_dir(c), group) or {}).get("cells"))


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


def request_report(c: str, request: str = "") -> bool:
    """The report pass: the report's writer, started through thimble's module as part of the orientation's own start
    (write_session.follow_on), with `request` its text (a revision's, naming the cards a follow-up changed), carrying
    the orientation's chat and run so the browser shows it on the orientation's card. False when it could not start
    (logged, never raised: the orientation itself is done)."""
    from . import write_session  # noqa: PLC0415

    run = read_run(c)
    if run is None:
        return False
    chat = str((run.get("chats") or {}).get(ROLE) or "")
    meta = agents.meta_or_none(c, chat) if chat else None
    run["report_asked"] = True
    _write_run(c, run)
    try:
        write_session.follow_on(c, REPORT_DOC, request.strip(), orient=chat or None,
                                orient_run=int((meta or {}).get("run") or 0))
    except Exception:  # noqa: BLE001
        log.exception("orientation %s: the report pass did not start", c)
        return False
    return True
