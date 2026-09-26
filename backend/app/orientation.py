"""The orientation as the server sees it: its record, for the readers that need it without a session.

No model runs here. The orientation is its own Claude Code session beside main (orient_session.py, prompts/orient.md),
started when main calls `start_orientation`. The browser's Start sends a `start` channel event, which main answers by
calling that tool with the brief and the three output switches (`final_notebook`, the deck; `propose_views`;
`generate_report`). This module hears the Start (start_requested), keeps its settings (`effort`, `critique`,
`ultracode`), and is told when the session starts (started) and stops (finished).

The orientation's cards go to its deck, the root group `Orientation`, whatever group a call names, so the model never
writes into the analyst's Your work. The first run's outputs are drafts until it ends: the canvas leaves its deck cards
out (held) and its view proposals stay unlisted (holding) while they build. A follow-up (orient_session.message) resumes
the same session, and its changes land in place, one Undo reverting them all.

  orient/run.json    {status: requested|running|done|failed|stopped, passes, query, effort?, critique?, ultracode?,
                      permissions?, event?, requested?, started, ended, groups: {orientation}, chats: {orient?},
                      session?, pid?, agent_id?, error?, run (0 the first, then one per follow-up), queue: [{text, by,
                      ts}], followups: [{run, status, started, ended, messages, added, revised, deleted, views}],
                      report_asked?}
  orient/summary.md  the session's last message, kept as a record for the export

`query` is only ever the analyst's own words typed with Start. A run with a `final` group uses it as its deck. `status`
is the latest run's, so start_orientation refuses while any run goes.

Terminal-first mode (the workspace's `terminal_first` setting): the orientation runs as a background subagent of the
analyst's own session instead, the plugin agent SUBAGENT (plugin/agents/orient-subagent.md), so the analyst can watch
and message it in Claude Code's agent view. start_orientation writes its prompt to subagent_prompt_file and asks main to
start it; the mirror finds it as a subagent of main (session.py) and calls started and finished as for a session. It
gives up what its own session has: a write fence (the work folder is the only place it writes), its own permission
mode, Ultracode's workflows and effort, and the critique, since main's shim does not list `critique`. Its record has
`route: subagent`.

When run 0 ends, the deck and the held proposals appear, and the orientation's chat gets chips for them. A failed run 0
runs again in its session when a start asks for the same orientation. When the report was asked for, orient_session
sends the `write` channel event once no follow-up waits.
"""
from __future__ import annotations

import contextlib
import logging
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import HTTPException

from . import agents, cc_settings, config, investigation
from .ledger import read_json, write_json

log = logging.getLogger("thimble.orientation")

AGENT = "thimble-orient"  # prompts/orient.md's name, the agent its session runs as
SUBAGENT = "thimble-orient-subagent"  # plugin/agents/orient-subagent.md's name, the agent of terminal-first mode
TERMINAL_FIRST_KEY = "terminal_first"  # settings.json: the orientation runs as a subagent of main (module note)
SUBAGENT_ROUTE = "subagent"  # the record's `route` in terminal-first mode
SUBAGENT_PROMPT = "subagent-prompt.md"  # under orient/: the prompt the subagent reads first
PLUGIN = "thimble"  # the plugin's name (plugin/.claude-plugin/plugin.json), the scope of its agents and skills
AGENT_FILE = config.REPO_ROOT / "prompts" / "orient.md"
EFFORTS = ("low", "medium", "high", "xhigh", "max")  # Start's effort menu below Ultracode, its highest choice
DEFAULT_EFFORT = "max"
DEFAULT_ULTRACODE = True  # an orientation runs with Ultracode unless Start turns it off
ROLE = "orient"  # the two-way choice a page without the mode switcher sends
TITLE = "Orientation"  # the agent chat's title
ORIENT_KIND = "orient"  # the channel kind that tells main the orientation ended (prompts/main.md)
GROUP_PATHS = {"deck": "Orientation"}  # the orientation's one group, its deck
PERMISSIONS = tuple(cc_settings.ORIENT_MODES)  # Start's mode switcher for the orientation: manual, auto, bypass
OLD_PERMISSIONS = {"ask": "manual", "run": "auto"}  # the two-way choice a page loaded before the switcher sends
REPORT_DOC = "report"
WRITE_KIND = "write"  # the channel kind the Report tab's Write sends
RUNNING = ("requested", "running")
START_KIND = "start"  # the channel kind the browser's Start sends (prompts/main.md, Events from the browser)
REQUEST_WAIT_S = 600.0  # a Start whose subagent main has not started in this long is taken as dropped
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


def is_orient(agent_type: Any) -> bool:
    """Whether an Agent call's subagent_type, or a subagent's recorded agentType, is an orientation's agent, bare or
    scoped as `thimble:thimble-orient`: the session's agent or terminal-first mode's SUBAGENT."""
    return isinstance(agent_type, str) and agent_type.strip().rsplit(":", 1)[-1] in (AGENT, SUBAGENT)


def terminal_first(c: str) -> bool:
    """Whether the workspace runs the orientation as a subagent of main (TERMINAL_FIRST_KEY)."""
    from .ledger import stored_settings  # noqa: PLC0415

    try:
        return stored_settings(c).get(TERMINAL_FIRST_KEY) is True
    except Exception:  # noqa: BLE001 — a workspace whose settings cannot be read runs the default route
        return False


def subagent_prompt_file(c: str) -> Path:
    """The file the orientation's subagent reads its prompt from (terminal-first mode)."""
    return orient_dir(c) / SUBAGENT_PROMPT


def subagent_run(c: str) -> dict[str, Any] | None:
    """The latest run's record when it ran or runs as a subagent of main, else None."""
    run = read_run(c)
    return run if run and run.get("route") == SUBAGENT_ROUTE else None


def effort(value: Any) -> str:
    """Start's effort, one of EFFORTS; anything else is the default."""
    v = str(value or "").strip().lower()
    return v if v in EFFORTS else DEFAULT_EFFORT


def flag(value: Any, default: bool) -> bool:
    """A Start choice sent as a boolean, or as the string a channel attribute carries."""
    if isinstance(value, bool):
        return value
    if isinstance(value, str) and value.strip().lower() in ("true", "false"):
        return value.strip().lower() == "true"
    return default


def permissions(value: Any) -> str | None:
    """Start's permission choice, one of PERMISSIONS (or the two-way choice mapped by OLD_PERMISSIONS); None for
    anything else."""
    v = str(value or "").strip().lower()
    v = OLD_PERMISSIONS.get(v, v)
    return v if v in PERMISSIONS else None


def choices(c: str) -> dict[str, Any]:
    """{effort, critique, ultracode, permissions} for the next orientation session: the requested run's, recorded from
    Start, else the defaults; `permissions` None is the workspace's stored choice or the analyst's own mode
    (orient_session.permission_flag)."""
    run = read_run(c)
    if run and run.get("status") == "requested":
        return {"effort": effort(run.get("effort")), "critique": flag(run.get("critique"), True),
                "ultracode": flag(run.get("ultracode"), DEFAULT_ULTRACODE), "permissions": permissions(run.get("permissions"))}
    return {"effort": DEFAULT_EFFORT, "critique": True, "ultracode": DEFAULT_ULTRACODE, "permissions": None}


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


def holding(c: str) -> bool:
    """Whether a view proposal the orientation makes now stays unlisted and unannounced, building meanwhile, until its
    first run ends."""
    return drafting(c)


def held(c: str) -> set[str]:
    """The ids of the cards the orientation's running first run has put in its deck since it started: the canvas leaves
    them out until it ends, so the deck appears whole. Earlier deck cards stay shown and follow-up changes are never
    held. Empty when no first run goes or its deck is off."""
    from . import notebook  # noqa: PLC0415

    run = read_run(c)
    deck = deck_of(run) if drafting(c) else None
    since = _at((run or {}).get("started"))
    if not deck or since is None:
        return set()
    nb = notebook.read_notebook(config.workspace_dir(c), deck)
    out: set[str] = set()
    for cell in (nb or {}).get("cells") or []:
        at = _at(cell.get("created_ts")) if isinstance(cell, dict) else None
        if at is not None and at >= since and cell.get("id"):
            out.add(str(cell["id"]))
    return out


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
    less than REQUEST_WAIT_S ago and main has not started the subagent yet (after that the request is taken as
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


def start_requested(c: str, payload: dict[str, Any], posted: dict[str, Any]) -> None:
    """The browser's Start, heard after the `start` event is posted: the run is recorded as requested with its passes,
    focus and choices, and the deck is made when on. A Start while an orientation runs is main's to answer; the running
    record is kept."""
    if running(c):
        log.info("%s: a Start while an orientation runs; the record of the running one is kept", c)
        return
    text = str(payload.get("text") or "").strip()
    passes = start_passes(payload)
    _write_run(c, {"status": "requested", "passes": passes, "query": text or None, "effort": effort(payload.get("effort")),
                   "critique": flag(payload.get("critique"), True),
                   "ultracode": flag(payload.get("ultracode"), DEFAULT_ULTRACODE),
                   "permissions": permissions(payload.get("permissions")),
                   "event": posted.get("id"), "requested": _now(), "started": None, "ended": None,
                   "groups": ensure_groups(c, deck=True) if "final" in passes else {}, "chats": {}, "error": None})


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


def started(c: str, chat_id: str, *, agent_id: str | None = None, session: str | None = None,
            pid: int | None = None, passes: "list[str] | None" = None) -> dict[str, Any]:
    """The orientation's session started, or the mirror found orient.md as a subagent of main: a requested run becomes
    running with its chat, as run 0, and an orientation nobody asked Start for opens a run of its own. `passes` from
    start_orientation win over the Start's; without them a requested run keeps its own and a new run has deck and views.
    """
    run = read_run(c)
    requested = bool(run and run.get("status") == "requested")
    if passes is None:
        passes = list((run or {}).get("passes") or ["final", "views"]) if requested else ["final", "views"]
    groups = ensure_groups(c, deck=True) if "final" in passes else {}
    extra = {k: v for k, v in (("session", session), ("pid", pid)) if v is not None}
    fresh = {"run": 0, "queue": [], "followups": [], "report_asked": False}
    if run and requested:
        run.update(status="running", started=_now(), passes=list(passes), groups=groups, chats={ROLE: chat_id},
                   agent_id=agent_id, **fresh, **extra)
    elif run and run.get("status") == "running" and (run.get("chats") or {}).get(ROLE) == chat_id:
        if agent_id and not run.get("agent_id"):
            run["agent_id"] = agent_id
        return _write_run(c, run)
    else:
        run = {"status": "running", "passes": list(passes), "query": None, "started": _now(), "ended": None, "groups": groups,
               "chats": {ROLE: chat_id}, "agent_id": agent_id, "error": None, **fresh, **extra}
    _write_run(c, run)
    if groups.get("orientation"):  # the chat's group is where the cards it writes land: the deck
        agents.update_agent(c, chat_id, group=groups["orientation"])
    _emit(c, "started", passes=run["passes"])
    return run


def finished(c: str, chat_id: str, status: str, result: str | None, report: bool = True) -> dict[str, Any] | None:
    """The first run stopped: its last message is kept as summary.md, the run ends with the session's status (ending
    held), the held view proposals are released, and the orientation's chat gets chips for the deck and each proposal.
    With `report`, a done run that asked for the report asks for it. A notification for another session, or for a run
    already ended, changes nothing."""
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
    if deck and _has_cards(c, deck):
        agents.chip(c, "artifact", CARDS_CHIP, ref=f"group:{deck}", chat=chat_id)
    release_views(c, chat_id)
    _emit(c, run["status"], **({"error": run["error"]} if run.get("error") else {}))
    if report and status == "done" and "report" in (run.get("passes") or []):
        request_report(c)
    return read_run(c) or run


def _has_cards(c: str, group: str) -> bool:
    from . import notebook  # noqa: PLC0415

    return bool((notebook.read_notebook(config.workspace_dir(c), group) or {}).get("cells"))


def release_views(c: str, chat_id: str | None = None) -> list[dict[str, Any]]:
    """The view proposals held while the first run drafted, listed and announced now with the status their builds
    reached (views.release_held), each with a chip on the orientation's chat `chat_id`; [] when none was held."""
    from . import views  # noqa: PLC0415 — views imports refs and the dev runner

    try:
        released = views.release_held(c)
    except Exception:  # noqa: BLE001 — the orientation has ended either way
        log.exception("%s: the orientation's view proposals were not released", c)
        return []
    for prop in released:
        agents.chip(c, "view", str(prop.get("name") or prop.get("slug")), ref=f"view:{prop.get('slug')}",
                    status=str(prop.get("status") or "queued"), chat=chat_id)
    return released


def restarted(c: str, chat_id: str, *, pid: int | None = None) -> dict[str, Any] | None:
    """The failed first run runs again in its own session: the record runs again as run 0, so its deck and proposals are
    drafts again until it ends. None when the record is not that orientation's."""
    run = read_run(c)
    if not run or (run.get("chats") or {}).get(ROLE) != chat_id:
        return None
    run.update(status="running", ended=None, error=None, **({"pid": pid} if pid else {}))
    _write_run(c, run)
    _emit(c, "started", passes=run.get("passes") or [])
    return run


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
    """The report pass: the `write` event the Report tab's Write sends, for the report, which main answers with
    start_writing, `request` its text (a revision's, naming the cards a follow-up changed). False when no session
    listens or the event is refused (logged, never raised: the orientation itself is done)."""
    from . import channel  # noqa: PLC0415

    payload: dict[str, Any] = {"doc": REPORT_DOC}
    if request.strip():
        payload["text"] = request.strip()
    try:
        channel.post(c, WRITE_KIND, payload, check_kind=False)
    except HTTPException as e:
        log.warning("orientation %s: the report pass was not sent (%s %s)", c, e.status_code, e.detail)
        return False
    run = read_run(c)
    if run is not None:
        run["report_asked"] = True
        _write_run(c, run)
        chat = (run.get("chats") or {}).get(ROLE)
        if chat:  # the writer that answers is the orientation's (report_types.write_for_orientation)
            from . import report_types  # noqa: PLC0415

            meta = agents.meta_or_none(c, chat) or {}
            report_types.write_for_orientation(c, REPORT_DOC, str(chat), int(meta.get("run") or 0))
    return True


def _listen() -> None:
    """start_requested on the channel's `start` events."""
    from . import channel  # noqa: PLC0415

    channel.observe(START_KIND, start_requested)


_listen()
