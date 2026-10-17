"""thimble's backend without its server: the local transport.

A session reaches thimble one of two ways (transport): locally, from the session's own processes, until the analyst's
first press of the browser workbench (`thimble open`, `/thimble browser`, a ↗ or `o` in the terminal panel), and through
thimble's server for the rest of that session after it. The switch is one way. Peers (a second session that turned
thimble on beside a live main) and sessions another took main from always stay local.

On local transport no server runs for the session. The plugin's MCP shim, one process per Claude Code session that main
and every subagent share, runs the same `tools.call` in its own process (call); the terminal UI reads the same JSON the
server's GET routes give the browser with `thimble state <surface>` (state), and makes the changes the browser's POST
routes make with `thimble act <kind>` (act). Each of these writes the same workspace files the server writes, so a
workspace opens the same way in either transport. After the press, an act whose state the server holds in memory (a
comment dismissed or opened again, a view proposal's answer, a notice's dismissal: SERVER_ACTS) goes to the server's
route for `thimble act`, POST /api/ws/{c}/act (app/term_acts.py), a token route of this command's own, and the others
run here. The browser's routes for those changes take only the browser's cookie, never the token this command proves.

The transport is read from the workspace's `trusted/launch.json` (subagent_files.transport), which only activation
writes (app/activate.py write_launch). A tool call here refuses a folder that holds no workspace (no tool call
registers a corpus: activation, `thimble demo` and the browser do), and a session another took main from
(TAKEOVER_LINE). A process that lost its environment (THIMBLE_HOME) finds no workspace under the default home and does
nothing.

Code a model wrote never runs in the shim: card code, code labels and the rerun of cards after a label changed run
through `thimble-run` in the caller's Bash, with the caller's permission mode (cardrun.py), before and after the press.
The shim runs the jobs a tool leaves running (a prompt label's run, the card check of a card `thimble-run` wrote) on
its event loop, and they end with the session; one that ends after the press writes its files under their locks and
posts its event, which the server takes from the event queue (events.py, event_files.py).

    python -m app.local state <surface> --cwd <dir> [args]          prints JSON (STATE_USAGE)
    python -m app.local act <kind> --cwd <dir> ('<json>' | --stdin)  prints {ok, ...} (ACT_USAGE)
    python -m app.local view host|text …                            terminal views (term_views.py)

Both print `{error}` and exit 1 when they fail, and open no port.
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from . import config

log = logging.getLogger("thimble.local")

LOCAL, SERVER = "local", "server"  # a session's transport (subagent_files.transport)
LAUNCH_FILE = "trusted/launch.json"  # activation's record of the session (activate.write_launch), with its `transport`
WS_ENV = "THIMBLE_WS"  # a workspace folder a process is told to use (the card runner's trial, cardrun.trial_env)
UI_LOG = "ui.jsonl"  # the UI tools' records for the renderer: {n, at, kind, args}
# the refusals of call(), in the tool route's words where it has them (tools.call_route)
NO_WORKSPACE = ("{cwd} is not inside a corpus thimble knows, so `{name}` was not run. Start thimble in that folder with "
                "`thimble`.")
# a call from a session that another session in the folder took main from (activate.take_main)
TAKEOVER_LINE = ("`{name}` was not run: another Claude Code session in this folder took over thimble. Ask the analyst "
                 "to type /thimble in this terminal to take it back.")

_started: set[str] = set()  # the workspaces this process has served a call for (_start)
# The plugin copy this session loaded, which the shim names from its own path (plugin/bin/thimble-mcp), so the commands
# the tools give name that copy's bin/thimble-run (cardrun.bin_path). None outside the shim.
PLUGIN_ROOT: Path | None = None


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


# --------------------------------------------------------------------------- the session's transport


def transport(c: str, sid: str | None = None) -> str:
    """How session `sid` of workspace `c` reaches thimble (module note): "server" only when `sid` (or, with no `sid`,
    main) is main's session and a press made its transport the server; "local" for peers, for sessions in `moved`, for
    any other session, and for a workspace that is not there. Read from launch.json at each call."""
    from . import subagent_files  # noqa: PLC0415 — standard library only

    try:
        return subagent_files.transport(config.workspace_path(c), sid)
    except (ValueError, OSError):
        return LOCAL


def terminal(c: str) -> bool:
    """Whether workspace `c`'s main runs on local transport (transport), kept for the callers that still ask in 0.8.0's
    words. False for a workspace that is not there."""
    try:
        config.workspace_path(c)
    except (ValueError, OSError):
        return False
    return transport(c) == LOCAL


def _pid_alive(pid: Any) -> bool:
    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 1:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def live_terminal(ws: Path) -> bool:
    """Whether the workspace folder `ws`'s main runs on local transport in a session that still runs (launch.json's
    `pid`). A server that starts leaves such a workspace's running cards alone (notebook.mark_interrupted_cells)."""
    from . import subagent_files  # noqa: PLC0415

    if subagent_files.transport(Path(ws)) != LOCAL:
        return False
    rec = subagent_files.launch(Path(ws))
    return _pid_alive(rec.get("pid"))


def session_here() -> str | None:
    """The Claude Code session this process runs under: Claude Code's record of the `claude` process above it
    (`<config dir>/sessions/<pid>.json`, which /clear rewrites), else CLAUDE_CODE_SESSION_ID; None for neither (the
    server, a shell)."""
    from . import cc_plugin  # noqa: PLC0415

    pid = cc_plugin.claude_pid()
    if pid:
        try:
            rec = json.loads((cc_plugin.config_dir() / cc_plugin.SESSIONS / f"{pid}.json").read_text("utf-8"))
            sid = rec.get("sessionId") if isinstance(rec, dict) else None
            if isinstance(sid, str) and sid:
                return sid
        except (OSError, ValueError):
            pass
    return os.environ.get("CLAUDE_CODE_SESSION_ID") or None


def settle_dirs() -> None:
    """The data and workspaces folders this process reads, as the launcher resolved them for the session
    (cli.resolve_env): THIMBLE_DATA_DIR and THIMBLE_WORKSPACES_DIR when set, else the folder THIMBLE_WS sits in and the
    data folder the last server.json names (as subagent_files.workspace_folder reads them), else config's defaults. The
    shim, `thimble-run` and `thimble state|act` call it before they look for a workspace."""
    home = Path(os.environ.get("THIMBLE_HOME") or (Path.home() / ".thimble")).expanduser()
    try:
        recorded = json.loads((home / "server.json").read_text("utf-8")).get("env") or {}
    except (OSError, ValueError, AttributeError):
        recorded = {}
    if not os.environ.get("THIMBLE_WORKSPACES_DIR"):
        named = os.environ.get(WS_ENV) or ""
        if named and Path(named).is_dir():
            config.WORKSPACES_DIR = Path(named).resolve().parent
    if not os.environ.get("THIMBLE_DATA_DIR") and isinstance(recorded, dict) and recorded.get("data_dir"):
        config.DATA_DIR = Path(str(recorded["data_dir"])).expanduser().resolve()


def workspace(cwd: str | None) -> str | None:
    """The workspace of the folder `cwd` (config.workspace_for_cwd), else the one THIMBLE_WS names when it is a
    workspace of this home; None for neither. Nothing is registered or made."""
    c = config.workspace_for_cwd(cwd) if cwd else None
    if c:
        return c
    named = os.environ.get(WS_ENV) or ""
    if named:
        p = Path(named)
        if p.parent.resolve() == config.WORKSPACES_DIR.resolve() and p.is_dir():
            return p.name
    return None


# --------------------------------------------------------------------------- tool calls


async def call(name: str, args: dict[str, Any], *, cwd: str, session: str | None = None,
               session_token: str | None = None, tool_use_id: str | None = None,
               caller: str | None = None, secondary: bool = False) -> dict[str, Any]:
    """One tool call in this process: {content, is_error}, the shape the server's tool route answers with
    (tools.call_route). The session is believed as the route believes it: with a token that proves it, else the call
    runs as main's, attributed to the agent of thimble's that made it (tools._as_caller). The analyst's session that
    makes the call (`caller`, else session_here) is refused with TAKEOVER_LINE when another session took main from it
    (launch.json `moved`). A `secondary` process, an agent's own shim (plugin/bin/thimble-mcp --private), never makes
    the shim's start (_start), whose marks of what an earlier session left running would mark main's shim's running
    work."""
    from . import hook_auth, subagent_files, tools  # noqa: PLC0415

    if not tools.known(name):
        return tools.err(f"no such tool: {name}").as_dict()
    c = workspace(cwd)
    if not c:
        return tools.err(NO_WORKSPACE.format(cwd=cwd or "(no folder)", name=name)).as_dict()
    if not session:
        who = caller or session_here()
        if who and who in subagent_files.moved(config.workspace_path(c)):
            return tools.err(TAKEOVER_LINE.format(name=name)).as_dict()
    if not secondary:
        _start(c)
    session = session or None
    if session and not hook_auth.session_proven(c, session, session_token or ""):
        if session_token:
            return tools.err(tools.hint("session-unproven", tool=name)).as_dict()
        session = None
    if session is None:
        refused, session = await tools._as_caller(c, name, tool_use_id or None)
        if refused:
            return tools.err(refused).as_dict()
    res = await tools.call(c, name, args, session=session, tool_use_id=tool_use_id or None)
    return res.as_dict()


def begin(cwd: str | None) -> str | None:
    """The shim's start on local transport, once the session's thimble is on: _start for the workspace of `cwd`, before
    any tool call. A session resumed with `--continue` may run cards with `thimble-run` before it calls a tool, and
    their card checks wait for the card watch, which would otherwise start only with the first call. The shim runs this
    in a worker thread, which has no event loop, and then starts the watch on its loop (watch). The workspace, or None
    for a folder of no workspace."""
    c = workspace(cwd)
    if not c:
        return None
    _start(c)
    return c


def _start(c: str) -> None:
    """The shim's start (begin), or a call for workspace `c` in this process: the first marks the cards an earlier session
    left `running` interrupted, and each starts the watch that starts the card check of each card `thimble-run` writes
    (watch) until one on the loop has started it."""
    from . import notebook  # noqa: PLC0415

    if c not in _started:
        _started.add(c)
        try:
            marked = notebook.mark_interrupted_cells(only=(c,))
            if marked:
                log.info("cards left running by an earlier session, marked interrupted: %s", ", ".join(marked))
        except Exception:  # noqa: BLE001 — never fails the call
            log.exception("%s: marking interrupted cards failed", c)
        try:
            stopped = _end_left_agents(c)
            if stopped:
                log.info("label runs' chats left running by an earlier session, marked stopped: %s", ", ".join(stopped))
        except Exception:  # noqa: BLE001 — never fails the call
            log.exception("%s: marking left label chats stopped failed", c)
    watch(c)


def watch(c: str) -> bool:
    """Start the card watch of workspace `c` on this thread's running loop, once per process (cardrun.CardWatch.start).
    False with no running loop: a worker thread, such as the one the shim runs begin in, or a one-call process (tests,
    the CLI), which checks no cards."""
    from . import cardrun  # noqa: PLC0415

    try:
        cardrun.CardWatch.start(c)
    except RuntimeError:
        return False
    return True


def _end_left_agents(c: str) -> list[str]:
    """The chats of label runs an earlier session left `running` (a label run is a task of the session's own process,
    so none of them runs now), each ended `stopped` (agents.end_left_label_chats): the ids."""
    from . import agents  # noqa: PLC0415

    return agents.end_left_label_chats(c)


async def close() -> None:
    """The end of the shim's session: the jobs it ran end with it, as the server's jobs end with the session (the card checks, a label's run, the card watch), and the browser and kernels it started stop. Never
    raises."""
    from . import cardrun  # noqa: PLC0415

    cardrun.CardWatch.stop_all()
    mods = sys.modules
    for c in list(_started):
        if "app.card_check" in mods:
            with contextlib.suppress(Exception):
                mods["app.card_check"].stop_all(c, mods["app.card_check"].SESSION_ENDED)
        if "app.concepts" in mods:
            with contextlib.suppress(Exception):
                mods["app.concepts"].stop_workspace(c)
    # the chats that follow those runs (a label's `label …` agent) end `stopped`, as a stopped agent's does, before this
    # process goes: else they stayed `running` after the quit
    if "app.agents" in mods:
        ag = mods["app.agents"]
        tasks = {k: t for k, t in list(ag._agent_tasks.items()) if k[0] in _started}
        for t in tasks.values():
            t.cancel()
        if tasks:
            with contextlib.suppress(Exception):
                await asyncio.wait(list(tasks.values()), timeout=2)
        for (c, chat), t in tasks.items():
            if not t.done():
                with contextlib.suppress(Exception):
                    ag.finish_agent(c, chat, "stopped", ag.STOPPED_LINE)
    # the regex scan pool's spawned workers, as the server's shutdown ends them: once this process has gone, nothing
    # ends a worker that waits on its queue, and it stays after Claude Code quits
    if "app.concepts" in mods:
        with contextlib.suppress(Exception):
            mods["app.concepts"]._pool_shutdown(end=True)
    if "app.render" in mods:
        with contextlib.suppress(Exception):
            await mods["app.render"].shutdown()
    if "app.notebook" in mods:
        with contextlib.suppress(Exception):
            await mods["app.notebook"].shutdown_all()


# --------------------------------------------------------------------------- what the UI tools leave for the renderer


def ui_append(c: str, kind: str, args: dict[str, Any]) -> dict[str, Any]:
    """Append one record to the workspace's ui.jsonl under its lock: {n, at, kind, args}, `n` one past the last. The UI
    tools (set_layout, open_view, set_filter, clear_filter, show_label) write it on local transport, where the terminal
    UI follows it (`thimble state ui --after <n>`)."""
    from . import ledger  # noqa: PLC0415

    path = config.workspace_dir(c) / UI_LOG
    with ledger.locked(path):
        ledger.heal_tail(path)
        rec = {"n": max(ledger.last_seq(path, "n"), 0) + 1, "at": _now(), "kind": kind, "args": args}
        ledger.append_jsonl(path, rec)
    return rec


UI_KINDS = ("layout", "open_view", "filter", "label")


def ui_note(c: str, kind: str, args: dict[str, Any]) -> None:
    """ui_append on local transport, where a UI tool's change reaches the terminal UI through ui.jsonl alone; nothing on
    the server, whose page hears the stream. Never raises: the tool's change is made either way."""
    try:
        if terminal(c):
            ui_append(c, kind, args)
    except Exception:  # noqa: BLE001
        log.warning("%s: the %s record for the terminal was not written", c, kind, exc_info=True)


def ui_records(c: str, after: int = 0) -> list[dict[str, Any]]:
    """The ui.jsonl records with `n` above `after`, oldest first."""
    path = config.workspace_path(c) / UI_LOG
    try:
        text = path.read_text("utf-8")
    except OSError:
        return []
    out = []
    for line in text.splitlines():
        try:
            rec = json.loads(line)
        except ValueError:
            continue
        if isinstance(rec, dict) and isinstance(rec.get("n"), int) and rec["n"] > after:
            out.append(rec)
    return out


# --------------------------------------------------------------------------- thimble state


STATE_USAGE = ("thimble state <surface> --cwd <dir> [args]; surfaces: home, cards [--since <iso>], card <id>, labels, "
               "label <id> [--rows <json>], docs, doc <slug>, threads, thread <id> [--after <n>], agents [--tail <n>], "
               "files [path] [--start <n>], turns <path> [--start <n>] [--line <n>], opens <paths json>, "
               "find <text>, grep <text>, findin <path> <text> [--after <n>], marks <path> [--lines <a-b>], "
               "tables <path>, rows <path> --table <name> [--start <n>] [--order <column>], resolve <refs json>, "
               "ui [--after <n>]")


LABEL_ROWS = 3  # records per value `state label` gives with their words (rows)
LABEL_ROWS_MAX = 200  # records per value `state label --rows` gives at most, the label panel's `… N more` pages
LABEL_VERDICT_ROWS = 6  # records per value the analyst set or agreed with that `state label` adds to them
OPENS_MAX = 100  # files one `state opens` reads the head of
GREP_STATE_S = 20.0  # seconds one `state grep` reads the files' text before it answers with what it found
DB_PAGE = 100  # rows of a database table one `state rows` gives, the renderer's page
FILE_PAGE = 200  # lines of a file `state files <file>` gives, the renderer's page (its earlier and later steps)
TURNS_PAGE = 200  # turns of a whole-file JSON transcript `state turns <file>` gives, the renderer's page


class StateError(Exception):
    """A state or act request that cannot be answered, with the line `{error}` carries."""


def _flag(args: list[str], name: str, default: str | None = None) -> str | None:
    if name in args:
        i = args.index(name)
        if i + 1 < len(args):
            return args[i + 1]
        raise StateError(f"{name} needs a value")
    return default


def _positional(args: list[str]) -> list[str]:
    out, skip = [], False
    for a in args:
        if skip:
            skip = False
            continue
        if a.startswith("--"):
            skip = True
            continue
        out.append(a)
    return out


def _int(v: str | None, default: int, what: str) -> int:
    if v is None:
        return default
    try:
        return int(v)
    except ValueError:
        raise StateError(f"{what} must be a whole number, not {v!r}") from None


async def state(c: str, surface: str, args: list[str] | None = None) -> Any:
    """The JSON the server's GET route for `surface` gives the browser (STATE_USAGE), read from the workspace files."""
    from fastapi import HTTPException  # noqa: PLC0415

    args = list(args or [])
    pos = _positional(args)
    fn = _SURFACES.get(surface)
    if fn is None:
        raise StateError(f"no surface {surface!r}; {STATE_USAGE}")
    try:
        return await fn(c, args, pos)
    except HTTPException as e:
        raise StateError(str(e.detail)) from None


async def _home(c: str, args: list[str], pos: list[str]) -> Any:
    from . import agents, orientation, tools, views  # noqa: PLC0415

    out = await asyncio.to_thread(tools.holdings, c)
    threads = [m for m in agents.list_chats(c) if m.get("kind") == agents.KIND_THREAD]
    out["threads"] = len(threads)
    out["unread"] = [m["id"] for m in threads if _unread(c, m)]
    try:  # the views proposed and built for this corpus, each one line in the terminal (the browser shows the view itself)
        out["views"] = _home_views(c)
    except Exception:  # noqa: BLE001 — the row above the prompt still shows the rest
        out["views"] = []
    # the view proposal waiting for the analyst's answer and every agent's open notices, rows above the prompt
    try:
        out["offer"] = _offer(c)
    except Exception:  # noqa: BLE001 — as for the views
        log.debug("%s: the view proposal was not read", c, exc_info=True)
        out["offer"] = None
    try:
        out["notices"] = _notices(c)
    except Exception:  # noqa: BLE001
        log.warning("%s: the open notices were not read", c, exc_info=True)
        out["notices"] = []
    run = orientation.read_run(c) or {}
    out["orientation"] = run.get("status")
    out["coverage"] = run.get("coverage")  # run 0's coverage line (orient_session.measure), which home shows under Files
    out["transport"] = transport(c)
    return out


def _home_views(c: str) -> list[dict[str, Any]]:
    """The views home lists, newest first by the renderer: each built one and each proposal not dropped, held or merely
    suggested, with its state (built, building, failed, proposed, or not built for a view whose files are missing), when
    it was proposed (or built), and the files it claims."""
    from . import term_views, views  # noqa: PLC0415

    props = {p["slug"]: p for p in views.list_proposals(c)}
    built = {v["slug"]: v for v in views.list_views(c) if v.get("origin") != "builtin"}
    rows: list[dict[str, Any]] = []
    for slug in dict.fromkeys([*built, *props]):
        v, p = built.get(slug), props.get(slug) or {}
        if p.get("held") or p.get("status") in ("dropped", "suggested"):
            continue
        if v is not None and v.get("ok"):
            status = "built"
        elif p.get("status") in ("building", "failed"):
            status = str(p["status"])
        else:
            status = "proposed" if p else "not built"
        term = status == "built" and term_views.has_term(v)
        row = {"slug": slug, "name": str(p.get("name") or (v or {}).get("name") or slug), "status": status,
               "ts": str(p.get("ts") or (v or {}).get("built") or ""),
               "files": [str(x) for x in ((v or {}).get("claims") or p.get("claims") or [])],
               # whether the terminal draws it: a view.term.js among the files its last pass covered
               "term": term}
        if status == "built" and not term:
            # where the terminal page of a view built for the browser stands: building, failed (and why) or missing,
            # which its first open in the terminal builds (views.page_ask)
            row["page"], why = views.page_state(c, slug, views.TERM_PAGE, view=v, prop=p)
            if why:
                row["page_why"] = why
        rows.append(row)
    return rows


def _offer(c: str) -> dict[str, Any] | None:
    """The view proposal waiting for the analyst's answer (views.open_offer), as the rows above the prompt show it: its
    slug, name, description, the analyst's task (empty for a viewer of a file type) and the files it claims, and
    `refused`, why accept could not start its build and how to fix that (views.click_refused), while that stands. None
    while none waits, while view proposals are off (views.propose_enabled), and while it is dismissed in main's session
    (views.offer_hidden). It is not among the `views` until it is accepted."""
    from . import views  # noqa: PLC0415

    if not views.propose_enabled(c):
        return None
    row = views.open_offer(c)
    if not row or views.offer_hidden(c, row):
        return None
    refused = row.get("refused") if isinstance(row.get("refused"), dict) else {}
    return {"slug": str(row["slug"]), "name": str(row.get("name") or row["slug"]),
            "description": str(row.get("description") or ""), "task": str(row.get("task") or ""),
            "claims": [str(x) for x in (row.get("claims") or [])],
            **({"refused": str(refused["reason"])} if refused.get("reason") else {})}


# Every agent's open notices (notices.py: a failure with its fix, from the orientation and its helpers, the critic,
# writers, view builds and reviews, report checks, code tickets and the dev agent, card checks, labels and the view
# proposer), which the rows above the prompt show, since Claude Code's own terminal shows only main's requests; a notice
# of main's own request (kind "safeguards" or notices.API in main's chat: a reply the safeguards switched, an API error)
# is left out, as Claude Code shows it there. Each action maps to the act that takes it in the terminal: a `thimble act` kind, or for `settings` (Open
# Settings: the terminal has no Settings pane) "settings", which says where thimble's config is, since Settings writes it.
# "ticket-open" is no `thimble act` kind: the terminal UI opens the ticket in the browser workbench (its `ref`), where
# the analyst allows its change. Nor are a label's "label-open" (the terminal UI opens the label's panel), "label-again"
# (it runs `thimble act label-run` with `again`), the orientation's "orient-again" (it asks main to start it again),
# and, for main's reply the safeguards stopped, "card-again" (it sends main the act's `text`) and "ask-again" (it puts
# the act's `text`, the analyst's last message, back in Claude Code's prompt).
NOTICE_ACTS = {"proposals-retry": "view-propose-now", "proposals-off": "view-proposals-off", "view-retry": "view-retry",
               "settings": "settings", "ticket-open": "ticket-open", "sign-out": "sign-out", "label-open": "label-open",
               "label-again": "label-again", "orient-again": "orient-again", "card-again": "card-again",
               "ask-again": "ask-again"}
TEXT_ACTS = ("card-again", "ask-again")  # the acts that take the action's `text`


def _notice_acts(action: Any) -> list[dict[str, str]]:
    """A notice's `action` (one {label, do, slug?, text?} or a list of them) as the terminal takes it: {label, act,
    slug?, config?, ref?, text?} each, in its order, `config` the file of thimble's config for "settings", `ref` the
    ticket to open in the browser (`ticket:<slug>`) for "ticket-open" and `text` the words of a TEXT_ACTS act; a Retry
    with no view, a ticket's open with no ticket, and a TEXT_ACTS act with no words, are left out."""
    from . import userconf  # noqa: PLC0415

    out: list[dict[str, str]] = []
    for a in action if isinstance(action, list) else [action]:
        if not isinstance(a, dict) or (act := NOTICE_ACTS.get(str(a.get("do") or ""))) is None:
            continue
        slug = str(a.get("slug") or "")
        if act in ("view-retry", "label-open", "label-again") and not slug:
            continue
        ticket = " ".join(str(a.get("slug") or a.get("ticket") or "").split()).removeprefix("ticket:")
        if act == "ticket-open" and not ticket:
            continue
        text = str(a.get("text") or "") if act in TEXT_ACTS else ""
        if act in TEXT_ACTS and not text.strip():
            continue
        out.append({"label": str(a.get("label") or "") or act, "act": act,
                    **({"slug": slug} if slug and act != "ticket-open" else {}),
                    **({"config": str(userconf.global_file())} if act == "settings" else {}),
                    **({"ref": f"ticket:{ticket}"} if act == "ticket-open" else {}),
                    **({"text": text} if text else {})})
    return out


def _notices(c: str) -> list[dict[str, Any]]:
    """Every agent's open notices (notices.open_notices), newest first: {id, key, kind, text, agent, chat, at, acts,
    open}. `text` reads alone (it names the agent and the failure), `agent` names the agent ("Orientation", "View build:
    Agent Network"), `acts` are its actions as `thimble act` takes them (_notice_acts), and `open` says how its own
    thread opens: "thread" for a side thread, "agent" for an agent's chat, "" for main's, for none, or for a chat that
    is gone."""
    from . import agents, notices  # noqa: PLC0415

    rows = [n for n in notices.open_notices(c) if isinstance(n, dict) and str(n.get("text") or "").strip()
            and not (n.get("chat") == agents.MAIN_ID and n.get("kind") in ("safeguards", notices.API))]
    rows = sorted(reversed(rows), key=lambda n: str(n.get("ts") or ""), reverse=True)  # newest first, ties as given
    out: list[dict[str, Any]] = []
    for n in rows:
        chat, kind = str(n.get("chat") or ""), None
        if chat and chat != agents.MAIN_ID:
            with contextlib.suppress(OSError, ValueError):
                kind = (agents.meta_or_none(c, chat) or {}).get("kind")
        out.append({"id": str(n.get("id") or ""), "key": str(n.get("key") or ""), "kind": str(n.get("kind") or ""),
                    "text": " ".join(str(n["text"]).split()), "agent": str(n.get("agent") or ""), "chat": chat,
                    "at": str(n.get("ts") or ""), "acts": _notice_acts(n.get("action")),
                    "open": kind if kind in (agents.KIND_THREAD, agents.KIND_AGENT) else ""})
    return out


async def _cards(c: str, args: list[str], pos: list[str]) -> Any:
    from . import notebook  # noqa: PLC0415

    out = await notebook.canvas_route(c)
    since = _flag(args, "--since")
    if since:
        out = {**out, "cells": [x for x in out["cells"] if str(x.get("ts") or "") >= since
                                or str(x.get("created_ts") or "") >= since]}
    return out


async def _card(c: str, args: list[str], pos: list[str]) -> Any:
    from . import notebook  # noqa: PLC0415

    if not pos:
        raise StateError("card needs a card id")
    return await notebook.get_cell_route(c, pos[0].removeprefix("card:"))


async def _labels(c: str, args: list[str], pos: list[str]) -> Any:
    from . import concepts  # noqa: PLC0415

    ws = config.workspace_dir(c)

    def listed() -> list[dict]:
        """The concepts route's list, each label the analyst set a record of to another value with `verdicts` as
        `state label` gives them (home's label rows count as thimble.labels() reads the rows), and one with rows and no
        run that ended with its scope's size (`scope_total`, _scope_total)."""
        out = concepts.list_concepts_route(c)
        for k in out:
            applied, moved = concepts.verdicts_applied(ws, str(k.get("id") or ""), dict(k.get("counts") or {}))
            if moved:
                k["verdicts"] = {"counts": applied, "set": moved}
            if (n := _scope_total(c, k)) is not None:
                k["scope_total"] = n
        return out

    return await asyncio.to_thread(listed)


SCOPE_COUNT_MAX = 10_000_000  # the records _scope_total counts a label's scope to


def _scope_total(c: str, label: dict[str, Any]) -> int | None:
    """How many records (or files, or runs) a label's scope holds, for a label with labeled rows and no run that ended:
    one whose first run goes on, in main's process, or stopped part way, as when Claude Code quit under it. Its run
    record would say it, and none was kept; the renderer says `3,150 of 4,579` (live check term-fix9, quirk 4: such a
    label read `not run yet` beside its counts). None for any other label. Blocking."""
    from . import concepts  # noqa: PLC0415

    if label.get("applications") or label.get("last_run") or label.get("unit") not in concepts.FILE_UNITS:
        return None
    labeled = label.get("n_labeled")
    if not isinstance(labeled, int):
        labeled = sum(v for v in (label.get("counts") or {}).values() if isinstance(v, int))
    if not labeled:
        return None
    try:
        corpus_dir = config.corpus_dir(c)
        sources = concepts.match_paths(corpus_dir, concepts.glob_patterns(label.get("glob")))
        return concepts.units_at_least(corpus_dir, sources, str(label["unit"]), SCOPE_COUNT_MAX)[0] if sources else None
    except Exception:  # noqa: BLE001 — a scope that cannot be counted is said without its size
        log.debug("scope not counted", exc_info=True)
        return None


async def _label(c: str, args: list[str], pos: list[str]) -> Any:
    from . import concepts  # noqa: PLC0415

    if not pos:
        raise StateError("label needs a label id or name")
    ws = config.workspace_dir(c)
    found = concepts.find_concept(ws, pos[0])
    if found is None:
        raise StateError(f"no label {pos[0]!r}")
    out = await concepts.get_concept_route(c, str(found["id"]))
    # `--rows {"<value>": n}`: n records of that value in place of LABEL_ROWS, as the browser's examples page through
    # them (`N more`)
    raw = _flag(args, "--rows")
    try:
        asked = json.loads(raw) if raw else {}
    except ValueError as e:
        raise StateError(f"--rows: not JSON ({e})") from None
    if not isinstance(asked, dict):
        raise StateError('--rows takes a JSON object of rows per value, such as {"yes": 13}')
    # the examples the label card shows under its bars, per value (the browser asks the rows route for them), and a
    # page of records per value as the rows route gives them with their words (text=1): each with its value, why, and
    # the analyst's verdict, which the renderer's label card draws with agree and disagree; `totals` how many records
    # have each value, so the panel says how many more there are
    ex: dict[str, list[dict[str, str]]] = {}
    rows: list[dict[str, Any]] = []
    totals: dict[str, int] = {}
    # the records the analyst set or agreed with, under the value they gave: a record set to another value stays in the
    # list under that value (its row comes last among the store's, past the page each value shows)
    judged = await asyncio.to_thread(_verdict_rows, c, str(found["id"]))
    for value in out.get("labels") or []:
        pairs = await asyncio.to_thread(concepts.examples, c, str(found["id"]), str(value))
        ex[str(value)] = [{"ref": r, "text": t} for r, t in pairs]
        n = _int(str(asked[value]), LABEL_ROWS, "--rows") if value in asked else LABEL_ROWS
        page = await concepts.rows_route(c, str(found["id"]), value=str(value), limit=max(1, min(n, LABEL_ROWS_MAX)), text=True)
        totals[str(value)] = int(page.get("total") or 0)
        mine = [r for r in judged if r.get("analyst") == value][:LABEL_VERDICT_ROWS]
        refs = {r.get("ref") for r in mine}
        rows += mine + [r for r in page.get("rows") or [] if isinstance(r, dict) and r.get("ref") not in refs]
    # the counts as thimble.labels() reads the rows, each record the analyst set to another value under that value, and
    # how many records that is (the label panel's counts, and its `set by you`)
    applied, moved = await asyncio.to_thread(concepts.verdicts_applied, ws, str(found["id"]), dict(out.get("counts") or {}))
    scope = await asyncio.to_thread(_scope_total, c, out)
    facts = await asyncio.to_thread(_scope_facts, c, out)
    # the value of this label its scope's filter keeps (a label card's value, the Labels pane's funnel), else None
    f = concepts.read_filters(ws).get(concepts.SCOPE_OF_UNIT.get(str(out.get("unit")), "files")) or {}
    return {**out, "examples": ex, "rows": rows, "totals": totals, "verdicts": {"counts": applied, "set": moved},
            "filter": f.get("value") if f.get("concept") == found["id"] else None,
            **({"scope_total": scope} if scope is not None else {}), **facts}


def _scope_facts(c: str, label: dict[str, Any]) -> dict[str, Any]:
    """What the label panel's header says beside a label's definition: how many files its glob matches (`scope_files`,
    for a label over files) and what its records are called there (`scope_unit`, _record_noun); the model a prompt label
    runs on, by the name the analyst reads (`run_model`, concepts.label_model); and for the panel's `model:` choice, by
    their ids, the model it runs on (`model_id`), the labels role's (`model_role`, Settings' row for labels, which a
    label with no model of its own runs on) and the models to choose from (`model_choices`, as the browser's label
    editor offers them: the one it runs on, every role's, then the aliases' models). A fact that cannot be read is left
    out. Blocking."""
    from . import concepts  # noqa: PLC0415
    from .session import model_label  # noqa: PLC0415

    out: dict[str, Any] = {}
    if label.get("unit") in concepts.FILE_UNITS:
        try:
            found = concepts.match_paths(config.corpus_dir(c), concepts.glob_patterns(label.get("glob")))
            out["scope_files"] = len(found)
            out["scope_unit"] = _record_noun(str(label.get("unit")), [str(s.get("path") or "") for s in found])
        except Exception:  # noqa: BLE001 — a scope that cannot be matched is said without its count
            log.debug("scope files not counted", exc_info=True)
    try:
        role = config.base_model(concepts.labels_model(c)["model"])
        model = config.base_model(concepts.label_model(c, label))
        roles = (config.base_model(str(r.get("model") or "")) for r in config.models_for(c).values())
        choices = [model, role, *roles, *config.MODEL_ALIASES.values()]
        out.update({"model_id": model, "model_role": role, "model_choices": list(dict.fromkeys(m for m in choices if m))})
        if label.get("kind") == "prompt":
            out["run_model"] = model_label(model)
    except Exception:  # noqa: BLE001 — no model row rather than no panel
        log.debug("label model not read", exc_info=True)
    return out


# what one record of a file is called, by the file's type (concepts: a line of text, a row of a database's table or a
# CSV file, a page of a PDF, a value of a JSON document)
_RECORD_NOUNS = {**dict.fromkeys(("db", "sqlite", "sqlite3", "duckdb", "csv", "tsv", "xlsx", "parquet", "arrow", "feather"), "rows"),
                 "pdf": "pages", "json": "entries"}


def _record_noun(unit: str, paths: list[str]) -> str:
    """What a label's records are called in the label panel's scope row (`· 44 lines`): `files` for a label over whole
    files, `run folders` for one over runs; for one over records, the word its files' type gives them (`lines`, `rows`,
    `pages`, `entries`), `records` when its files differ or none matched. Pure."""
    from . import coverage  # noqa: PLC0415

    if unit == "agent":
        return "files"
    if unit == "run":
        return "run folders"
    nouns = set()
    for p in paths:
        ext = coverage.ext_of(p)
        nouns.add(_RECORD_NOUNS.get(ext) or ("lines" if ext in coverage.LINE_EXTS else "records"))
    return nouns.pop() if len(nouns) == 1 else "records"


def _verdict_rows(c: str, concept_id: str) -> list[dict[str, Any]]:
    """The label's rows the analyst gave a value, latest first, as the rows route gives them with their words (ref, label,
    confidence, rationale, analyst, text). Blocking."""
    from . import concepts  # noqa: PLC0415

    ws, concept = concepts.load_concept(c, concept_id)
    # the analyst's latest values with their words, as a prompt run's examples are read (a record with no words is left
    # out), then each one's row for the value the label gave it and why
    shots = concepts.few_shot_examples(ws, concept, limit=LABEL_VERDICT_ROWS * 4)
    by_ref = {str(r.get("ref")): r for r in concepts.rows_for_refs(ws, concept_id, [s["ref"] for s in shots])}
    out = []
    for s in shots:
        r = by_ref.get(s["ref"], {})
        out.append({"ref": s["ref"], "label": r.get("label"), "confidence": r.get("confidence"),
                    "rationale": r.get("rationale"), "analyst": s["value"], "text": s["text"]})
    return out


async def _docs(c: str, args: list[str], pos: list[str]) -> Any:
    from . import investigation, report_types  # noqa: PLC0415

    return await report_types.types_state_route(c, investigation.MAIN)


async def _doc(c: str, args: list[str], pos: list[str]) -> Any:
    from . import investigation, report_types  # noqa: PLC0415

    if not pos:
        raise StateError("doc needs a document's slug")
    return await report_types.get_doc_route(c, investigation.MAIN, pos[0].removeprefix("report:"))


def _unread(c: str, meta: dict[str, Any]) -> bool:
    """Whether a thread has an answer the analyst has not opened since it came (threads.seen)."""
    from . import threads  # noqa: PLC0415

    return threads.unread(c, meta)


def answered(events: list[dict[str, Any]]) -> int:
    """How many of a thread's questions have an answer: each question (a `user` record and the records after it) counts
    once, at its first `done` record or its first reply (the `text` record `reply_in_thread` writes, threads.reply). In
    the terminal main often answers with `reply_in_thread` alone, and no `done` record follows."""
    n, got = 0, False
    for r in events:
        kind = r.get("type")
        if kind == "user":
            got = False
        elif not got and (kind == "done" or (kind == "text" and r.get("reply"))):
            got = True
            n += 1
    return n


# the kinds of a thread's `error` record that end its run as a stop, not a failure: the analyst's stop, and the Claude
# Code session that ended under it (threads.SESSION_ENDED, as when the analyst quits)
STOP_KINDS = ("stopped", "session-ended")


def last_turn(events: list[dict[str, Any]]) -> str:
    """How a thread's latest question stands, as its records say: `answered` (a reply, or `done`), `stopped` (an error
    record of a STOP_KINDS kind, or whose words say it stopped), `failed` (any other error), '' while it runs or before
    any question. Words after an end are its answer, as the renderer reads them (hooks/model.ts threadOf)."""
    state = ""
    for r in events:
        kind = r.get("type")
        if kind == "user":
            state = ""
        elif kind == "done" or (kind == "text" and r.get("reply")):
            state = "answered"
        elif kind == "error":
            words = str(r.get("message") or r.get("error") or "")
            state = "stopped" if r.get("kind") in STOP_KINDS or words.lstrip().lower().startswith("stopped") else "failed"
    return state


def _answers(c: str, meta: dict[str, Any]) -> tuple[int, str, str]:
    """How many of a thread's questions have an answer (answered), which the renderer counts to put a row under main's
    latest reply when a new one comes; its first question, which names the thread in the terminal (its title is a
    slug); and how its latest question stands (last_turn), which the threads panel shows before it reads the thread."""
    from . import agents  # noqa: PLC0415

    try:
        events = agents.read_events(agents.paths(c, str(meta["id"]))[1])
    except Exception:  # noqa: BLE001 — a thread that cannot be read shows nothing new
        return 0, "", ""
    first = next((str(r.get("text") or "").strip() for r in events if r.get("type") == "user" and str(r.get("text") or "").strip()), "")
    return answered(events), first[:QUESTION_CHARS], last_turn(events)


QUESTION_CHARS = 300


def _thread_marks(c: str, meta: dict[str, Any]) -> None:
    """A thread's meta with `unread`, `answers`, its first `question` and its latest question's `turn` (_unread,
    _answers)."""
    meta["unread"] = _unread(c, meta)
    meta["answers"], meta["question"], meta["turn"] = _answers(c, meta)


async def _threads(c: str, args: list[str], pos: list[str]) -> Any:
    from . import agents  # noqa: PLC0415

    out = agents.list_chats(c)
    for m in out:
        if m.get("kind") == agents.KIND_THREAD:
            _thread_marks(c, m)
    return out


async def _thread(c: str, args: list[str], pos: list[str]) -> Any:
    from . import agents  # noqa: PLC0415

    if not pos:
        raise StateError("thread needs a chat id")
    chat = pos[0].removeprefix("thread:").removeprefix("chat:")
    resp = await agents.get_route(c, chat)
    body = json.loads(resp.body)
    after = _flag(args, "--after")
    if after is not None:
        n = _int(after, 0, "--after")
        body["events"] = body["events"][n:]
        body["after"] = n
    if body.get("meta", {}).get("kind") == agents.KIND_THREAD:
        _thread_marks(c, body["meta"])
    return body


async def _agents(c: str, args: list[str], pos: list[str]) -> Any:
    from . import agents, orientation  # noqa: PLC0415

    tail = _int(_flag(args, "--tail"), 5, "--tail")
    out = []
    for m in agents.list_chats(c):
        if m.get("kind") != agents.KIND_AGENT:
            continue
        _, log_path = agents.paths(c, str(m["id"]))
        events = agents.read_events(log_path)
        # the chat's meta, with a row's names as the agents' row above the prompt reads them, and its last records
        row = {"name": f"thimble:{m.get('role')}", "label": m.get("title") or m.get("role"), "chat": m["id"],
               "state": m.get("status"), "started": m.get("created_at")}
        out.append({**m, **row, "tail": events[-tail:] if tail > 0 else []})
    return {"agents": out, "orientation": orientation.read_run(c)}


async def _files(c: str, args: list[str], pos: list[str]) -> Any:
    """Every source (GET /sources); with a folder, its own entries (?path=&depth=1); with a file, a page of its records
    from `--start` (GET /source, FILE_PAGE lines), which the renderer's file view pages through."""
    from . import corpus  # noqa: PLC0415

    if pos:
        rel = pos[0].strip().strip("/")
        try:
            is_file = config.safe_corpus_path(config.corpus_dir(c), rel or ".").is_file()
        except ValueError as e:
            raise StateError(str(e)) from None
        if is_file:
            start = max(1, _int(_flag(args, "--start"), 1, "--start"))
            return await asyncio.to_thread(corpus._page, config.corpus_dir(c), rel, start, start + FILE_PAGE - 1)
        return await asyncio.to_thread(corpus.get_sources, c, 0, pos[0], 1)
    return await asyncio.to_thread(corpus.get_sources, c)


async def _turns(c: str, args: list[str], pos: list[str]) -> Any:
    """A page of the turns of a whole-file JSON transcript (GET /source/turns, TURNS_PAGE turns) from turn `--start`,
    or around the first turn on `--line`, which the renderer's file view shows as the Transcript tab. A file whose parse
    finds no turns gives none, with `none` saying so, and the view opens its other tab, as the browser does."""
    from fastapi import HTTPException  # noqa: PLC0415

    from . import corpus, transcripts  # noqa: PLC0415

    if not pos:
        raise StateError("turns needs a file's path")
    rel = pos[0].strip().strip("/")
    root = config.corpus_dir(c)
    p = corpus._file(root, rel)
    start = max(0, _int(_flag(args, "--start"), 0, "--start"))
    line = _flag(args, "--line")
    try:
        return await asyncio.to_thread(transcripts.turns_page, p, rel, start, TURNS_PAGE,
                                       _int(line, 1, "--line") if line is not None else None)
    except HTTPException as e:
        if e.status_code != 415:
            raise
        return {"path": rel, "total": 0, "start": 0, "turns": [], "n_groups": 0, "groups": {}, "none": str(e.detail)}


async def _opens(c: str, args: list[str], pos: list[str]) -> Any:
    """What the file view opens each of these files as where it is not the file's lines: `transcript` for a file whose
    head reads as a transcript surely enough that the Transcript tab comes first (transcripts.STRONG, the renderer's
    rule), by path. A file that opens as its lines, or is not a file of the corpus, is left out. At most OPENS_MAX."""
    from . import transcripts  # noqa: PLC0415

    if not pos:
        raise StateError("opens needs a JSON list of paths")
    try:
        wanted = json.loads(pos[0])
    except ValueError as e:
        raise StateError(f"opens: the paths are not JSON ({e})") from None
    if not isinstance(wanted, list):
        raise StateError("opens needs a JSON list of paths")
    root = config.corpus_dir(c)

    def run() -> dict[str, str]:
        out: dict[str, str] = {}
        for rel in [x.strip().strip("/") for x in wanted if isinstance(x, str)][:OPENS_MAX]:
            try:
                p = config.safe_corpus_path(root, rel)
            except ValueError:
                continue
            if not rel or not p.is_file():
                continue
            hint = transcripts.sniff(p, rel)
            if hint is not None and float(hint.get("score") or 0) >= transcripts.STRONG:
                out[rel] = "transcript"
        return out

    return await asyncio.to_thread(run)


async def _find(c: str, args: list[str], pos: list[str]) -> Any:
    """The file browser's search by name (GET /sources/find): {q, files, total}, the files whose path holds every word
    of the text, best first."""
    from . import corpus  # noqa: PLC0415

    if not pos or not pos[0].strip():
        raise StateError("find needs the text to find")
    return await asyncio.to_thread(corpus.find_sources, c, pos[0])


async def _grep(c: str, args: list[str], pos: list[str]) -> Any:
    """The file browser's search inside the files (GET /sources/grep), read whole: {q, files, done}, each file whose
    text holds the text with its first matching lines (`matches`, each {line, text, hit}) and its count (`total`), then
    how many files it read (`done`). It stops after GREP_STATE_S seconds, `done.complete` false then, since a state
    read answers once."""
    from . import corpus  # noqa: PLC0415

    q = pos[0] if pos else ""
    if not q.strip() or "\n" in q:
        raise StateError("grep needs text on one line")
    root = corpus._corpus(c)

    def run() -> dict[str, Any]:
        deadline = time.monotonic() + GREP_STATE_S
        files: list[dict[str, Any]] = []
        done: dict[str, Any] | None = None
        for item in corpus.grep_files(root, corpus.search_paths(root).ordered, q, stop=lambda: time.monotonic() > deadline):
            if item.get("done"):
                done = item
            elif not item.get("progress"):
                files.append(item)
        return {"q": q, "files": files, "done": done}

    return await asyncio.to_thread(run)


async def _findin(c: str, args: list[str], pos: list[str]) -> Any:
    """The file view's find (GET /source/find): the lines of one file past line `--after` that hold the text, searched
    over the whole file, {lines, counts, total, complete, total_lines, ...}."""
    from . import corpus  # noqa: PLC0415

    if len(pos) < 2:
        raise StateError("findin needs a file's path and the text to find")
    return await asyncio.to_thread(corpus.find_in_source, c, pos[0].strip().strip("/"), pos[1],
                                   max(0, _int(_flag(args, "--after"), 0, "--after")))


async def _marks(c: str, args: list[str], pos: list[str]) -> Any:
    """Every label's rows on one file (GET /labels?path=&lines=a-b): [{concept_id, name, labels, unit, rows}], with
    `--lines a-b` the rows on those lines and the file's whole-file rows, which the file view marks its records with."""
    from . import concepts  # noqa: PLC0415

    if not pos:
        raise StateError("marks needs a file's path")
    return await asyncio.to_thread(concepts.all_labels_route, c, pos[0].strip().strip("/"), _flag(args, "--lines"))


async def _tables(c: str, args: list[str], pos: list[str]) -> Any:
    """A database file's tables (GET /forge/tables): [{name, row_count}]."""
    from . import corpus  # noqa: PLC0415

    if not pos:
        raise StateError("tables needs a database file's path")
    return await asyncio.to_thread(corpus.database_tables, corpus._corpus(c), pos[0].strip().strip("/"))


async def _rows(c: str, args: list[str], pos: list[str]) -> Any:
    """A page of a database table's rows (GET /forge/rows): DB_PAGE rows from row `--start` (from 1), sorted by
    `--order` (a column, then asc or desc); {table, columns, rows, pk, total}."""
    from . import corpus  # noqa: PLC0415

    table = _flag(args, "--table")
    if not pos or not table:
        raise StateError("rows needs a database file's path and --table")
    start = max(1, _int(_flag(args, "--start"), 1, "--start"))
    return await asyncio.to_thread(corpus.database_rows, corpus._corpus(c), pos[0].strip().strip("/"), table, start - 1,
                                   DB_PAGE, _flag(args, "--order"))


async def _resolve(c: str, args: list[str], pos: list[str]) -> Any:
    from . import refs, verify  # noqa: PLC0415

    if not pos:
        raise StateError("resolve needs a JSON list of refs, each a string or {ref, value}")
    try:
        wanted = json.loads(pos[0])
    except ValueError as e:
        raise StateError(f"resolve: the refs are not JSON ({e})") from None
    if not isinstance(wanted, list):
        raise StateError("resolve needs a JSON list")
    corpus_dir = config.corpus_dir(c)

    def one(item: Any) -> dict[str, Any]:
        """The ref route's answer for one ref (refs.resolve), `{ref, error}` when it does not resolve, with `retry`
        true when it may resolve soon (refs.RefError.retry: a view's key while the view is built or indexed); with
        `state` (ok, missing, differs) and its `why`, the value checked as the takeaway's links check it (verify)."""
        ref = str(item.get("ref") if isinstance(item, dict) else item or "").strip()
        value = item.get("value") if isinstance(item, dict) else None
        given = {"value": value} if value is not None else {}
        try:
            got = dict(refs.resolve(corpus_dir, ref))
        except refs.RefError as e:
            later = {"retry": True} if getattr(e, "retry", False) else {}
            return {"ref": ref, **given, "error": str(e.detail), **later, "state": "missing", "why": str(e.detail)}
        except Exception as e:  # noqa: BLE001 — one bad ref never takes the others down
            why = f"{type(e).__name__}: {e}"
            return {"ref": ref, **given, "error": why, "state": "missing", "why": why}
        got.update(ref=ref, **given)
        if (got.get("meta") or {}).get("span_missing"):
            return {**got, "state": "missing", "why": verify.WHY_SPAN_MISSING}
        if value is not None and not verify._value_matches(str(value), str(got.get("excerpt") or "")):
            return {**got, "state": "differs", "why": verify.WHY_VALUE}
        return {**got, "state": "ok"}

    return await asyncio.to_thread(lambda: [one(x) for x in wanted])


async def _ui(c: str, args: list[str], pos: list[str]) -> Any:
    return ui_records(c, _int(_flag(args, "--after"), 0, "--after"))


_SURFACES = {"home": _home, "cards": _cards, "card": _card, "labels": _labels, "label": _label, "docs": _docs,
             "doc": _doc, "threads": _threads, "thread": _thread, "agents": _agents, "files": _files,
             "turns": _turns, "opens": _opens, "find": _find, "grep": _grep, "findin": _findin, "marks": _marks, "tables": _tables,
             "rows": _rows, "resolve": _resolve, "ui": _ui}


# --------------------------------------------------------------------------- thimble act


ACT_USAGE = ("thimble act <kind> --cwd <dir> ('<json>' | --stdin) [--session <id>]; kinds: thread {anchor | anchor_text, message}, thread-message {thread, message}, "
             "verdict {label, ref, value}, label {label, name?, kind?, body?, glob?, values?}, label-run {label, limit?, again?}, label-stop {label}, "
             "label-delete {label}, label-undelete {label}, label-show {label, on?, values?, colors?}, label-filter {label, value?}, seen {thread}, "
             "stop {agent}, view-accept {slug}, view-reject {slug}, view-dismiss {slug}, view-proposals-off {}, "
             "view-propose-now {notice?}, view-retry {slug, notice?}, view-term-page {slug}, notice-dismiss {id}, sign-out {slug}")


# The acts whose state thimble's server holds in memory once main's transport is server: the comments of a document and
# of Claude's answers, which its routes change and announce to the browser, and the view proposals, builds and notices,
# whose queue and writer then live in the server (H6). After the press each goes to ACT_ROUTE (app/term_acts.py), which
# makes the change the browser's route `kind -> the route's path` makes, the fields that path names checked here first;
# every other act runs here.
ACT_ROUTE = "/api/ws/{c}/act"
SERVER_ACTS = {
    "comment-resolve": "/api/ws/{c}/investigations/main/types/{doc}/comments/{comment}/dismiss",
    "comment-reopen": "/api/ws/{c}/investigations/main/types/{doc}/comments/{comment}/reopen",
    "answer-comment-resolve": "/api/ws/{c}/answer-comments/{comment}/{how}",
    "view-accept": "/api/ws/{c}/views/proposals/{slug}/accept",
    "view-reject": "/api/ws/{c}/views/proposals/{slug}/reject",
    "view-retry": "/api/ws/{c}/views/proposals/{slug}/retry",
    # the browser has no dismiss: its card follows the terminal's (views.hide_offer); the path names the field it needs
    "view-dismiss": "/api/ws/{c}/views/proposals/{slug}",
    "view-term-page": "/api/ws/{c}/views/{slug}/frame",  # the browser's first open of a view builds its page there
    "view-propose-now": "/api/ws/{c}/views/propose-now",
    "notice-dismiss": "/api/ws/{c}/notices/{id}/dismiss",
}
SERVER_ACT_TIMEOUT_S = 10.0


def server_route(c: str, kind: str, payload: dict[str, Any]) -> str | None:
    """The server's route that an act of SERVER_ACTS takes (its path), or None for an act that runs here. StateError
    when the payload lacks a field the route names."""
    import string  # noqa: PLC0415
    from urllib.parse import quote  # noqa: PLC0415

    path = SERVER_ACTS.get(kind)
    if path is None:
        return None
    values = {"c": c, "how": "reopen" if payload.get("reopen") is True else "dismiss",
              "doc": str(payload.get("doc") or "").strip().removeprefix("report:")}
    for name in ("comment", "slug", "id"):
        values[name] = " ".join(str(payload.get(name) or "").split())
    names = [f for _, f, _, _ in string.Formatter().parse(path) if f]
    missing = [f for f in names if not values.get(f)]
    if missing:
        raise StateError(f"`{missing[0]}` is empty")
    return path.format(**{k: quote(v, safe="") for k, v in values.items()})


def _post_to_server(c: str, kind: str, payload: dict[str, Any]) -> dict[str, Any]:
    """The act `kind` posted to thimble's server (ACT_ROUTE) with the token's proof (cli._request): its JSON answer, or
    StateError with why."""
    from urllib.parse import quote  # noqa: PLC0415

    from . import cli  # noqa: PLC0415

    status, body = cli._request("POST", f"{cli.api_url()}/api/ws/{quote(c, safe='')}/act",
                                {"kind": kind, "payload": payload}, timeout=SERVER_ACT_TIMEOUT_S)
    if status != 200:
        why = body.get("detail") if isinstance(body, dict) else body
        raise StateError(f"thimble's server did not take this change ({status or 'no answer'}: {why})")
    return body if isinstance(body, dict) else {}


async def act(c: str, kind: str, payload: dict[str, Any], session: str | None = None) -> dict[str, Any]:
    """The change the browser's POST route for `kind` makes (ACT_USAGE): {ok: true, ...}. After the press, an act of
    SERVER_ACTS made for a session whose transport is the server goes to the server's route (module note)."""
    from fastapi import HTTPException  # noqa: PLC0415

    fn = _ACTS.get(kind)
    if fn is None and kind not in SERVER_ACTS:
        raise StateError(f"no act {kind!r}; {ACT_USAGE}")
    if not isinstance(payload, dict):
        raise StateError("the act's argument must be a JSON object")
    if kind in SERVER_ACTS and transport(c, session) == SERVER:
        if server_route(c, kind, payload) is not None:
            got = await asyncio.to_thread(_post_to_server, c, kind, payload)
            return {"ok": True, **{k: v for k, v in got.items() if k != "ok"}, "via": "server"}
    if fn is None:
        raise StateError(f"no act {kind!r}; {ACT_USAGE}")
    try:
        return {"ok": True, **(await fn(c, payload))}
    except HTTPException as e:
        raise StateError(str(e.detail)) from None


def _text(payload: dict[str, Any], key: str) -> str:
    v = " ".join(str(payload.get(key) or "").split()) if key != "message" else str(payload.get(key) or "").strip()
    if not v:
        raise StateError(f"`{key}` is empty")
    return v


async def _act_thread(c: str, payload: dict[str, Any]) -> dict[str, Any]:
    """A new side thread on what the analyst pointed at, with its first question: the browser's ⌘-click
    (agents.create_route). A sentence or a selection has no ref: its words come as `anchor_text`, with no `anchor`."""
    from . import agents  # noqa: PLC0415

    anchor = " ".join(str(payload.get("anchor") or "").split()) or None
    if anchor is None and not " ".join(str(payload.get("anchor_text") or "").split()):
        raise StateError("`anchor` and `anchor_text` are both empty")
    body = agents.NewThread(anchor=anchor, anchor_text=payload.get("anchor_text"),
                            title=payload.get("title"), surface=payload.get("surface") or "terminal",
                            element=payload.get("element"), parent=payload.get("parent"), text=_text(payload, "message"))
    meta = await agents.create_route(c, body)
    return {"thread": meta["id"], "event": meta.get("event")}


async def _act_thread_message(c: str, payload: dict[str, Any]) -> dict[str, Any]:
    """A message to a thread that exists, as its composer sends it (a `thread` event)."""
    from . import events  # noqa: PLC0415

    thread = _text(payload, "thread").removeprefix("thread:")
    posted = events.post(c, events.THREAD, {"thread": thread, "text": _text(payload, "message")})
    return {"thread": thread, "event": posted.get("id"), **({"queued": True} if posted.get("queued") else {})}


async def _act_verdict(c: str, payload: dict[str, Any]) -> dict[str, Any]:
    """The analyst's verdict on one labeled record (concepts.verdict_route)."""
    from . import concepts  # noqa: PLC0415

    ws = config.workspace_dir(c)
    found = concepts.find_concept(ws, _text(payload, "label"))
    if found is None:
        raise StateError(f"no label {payload.get('label')!r}")
    body = concepts.VerdictBody(ref=_text(payload, "ref"), label=_text(payload, "value"), note=payload.get("note"))
    out = await asyncio.to_thread(concepts.verdict_route, c, str(found["id"]), body)
    return {"label": found["id"], **out}


async def _act_label(c: str, payload: dict[str, Any]) -> dict[str, Any]:
    """The analyst's edit of a label in the terminal's label panel, saved as the browser's label editor saves it (PUT
    /concepts/{id}, concepts.update_concept_route; LabelCard's patchOf): `name`, `kind` (prompt, regex or code), `body` (a
    prompt label's prompt, else its pattern or code), `glob` (the files it applies to), `values` and `model` (the model a
    prompt label's calls run on, by its id; '' for the labels role's, Settings' row for labels). A field left out stays
    as it is."""
    from . import concepts  # noqa: PLC0415

    ws = config.workspace_dir(c)
    found = concepts.find_concept(ws, _text(payload, "label"))
    if found is None:
        raise StateError(f"no label {payload.get('label')!r}")
    patch: dict[str, Any] = {}
    if payload.get("name") is not None:
        patch["name"] = _text(payload, "name")
    kind = str(payload["kind"]).strip().lower() if payload.get("kind") is not None else found["kind"]
    if payload.get("kind") is not None:
        patch["kind"] = kind
    if payload.get("body") is not None:
        body = str(payload["body"]).strip()
        if not body:
            raise StateError("`body` is empty")
        patch.update({"description": body, "spec": ""} if kind == "prompt" else {"spec": body})
    if payload.get("glob") is not None:
        patch["glob"] = _text(payload, "glob")
    if payload.get("values") is not None:
        values = [" ".join(str(v).split()) for v in payload["values"]] if isinstance(payload["values"], list) else []
        if len([v for v in values if v]) < 2:
            raise StateError("`values` needs two values or more")
        patch["labels"] = [v for v in values if v]
    if payload.get("model") is not None:
        patch["model"] = config.base_model(str(payload["model"]))
    if not patch:
        raise StateError("nothing to change: give name, kind, body, glob, values or model")
    out = await asyncio.to_thread(concepts.update_concept_route, c, str(found["id"]), concepts.ConceptPatch(**patch))
    return {"label": found["id"], "concept": out}


async def _act_label_run(c: str, payload: dict[str, Any]) -> dict[str, Any]:
    """Run a label on a sample of `limit` records, or on every record with no `limit`, as the browser's Re-run does
    (concepts.apply_route): a label that never ran gets its card, and main hears of a version it has not heard of
    (tell_main). The run goes on in this process until it ends and its summary is the answer, so the renderer starts it
    beside the session, which it ends with. A code label's code runs only in main's sandbox: as apply_label does, the run
    waits for `thimble-run label` (concepts.PENDING_RUN), and the answer gives its command (`deferred`); a code label
    whose last run already covers this one (the same version over the same files and sample, concepts.covered) runs
    nothing and waits for nothing, and the answer says so (`unchanged`), so main is not asked to run what apply_label
    would answer with the old rows (bug hunt B31). With `again`, a prompt label runs only over the units its last run
    could not label (a label notice's act, concepts.start_again), and main hears of it once it ends (`label_done`)."""
    from . import cardrun, concepts  # noqa: PLC0415

    ws = config.workspace_dir(c)
    found = concepts.find_concept(ws, _text(payload, "label"))
    if found is None:
        raise StateError(f"no label {payload.get('label')!r}")
    cid = str(found["id"])
    again = payload.get("again") is True
    limit = _int(str(payload["limit"]), 0, "limit") if payload.get("limit") not in (None, "") and not again else 0
    if limit < 0:
        raise StateError("limit must be 1 or more, or left out for every record")
    files = found["unit"] in concepts.FILE_UNITS
    paths = concepts.glob_patterns(found["glob"]) if files else []
    if found["kind"] == "code" and cardrun.defers(c) and not again:
        if concepts.running_apply(c, cid) is None and await asyncio.to_thread(concepts.covered, c, found, paths, limit or None):
            return {"label": cid, "unchanged": True}
        args: dict[str, Any] = {"scope": concepts.SCOPE_OF_UNIT.get(found["unit"], "files"), "name": found["name"],
                                "predicate": {"kind": "code", "text": found["spec"]}, "values": found["labels"],
                                **({"paths": paths} if files else {}), **({"limit": limit} if limit else {})}
        concepts.set_pending_run(c, cid, args, None)
        cardrun.mirror(c)
        return {"label": cid, "deferred": True, "command": cardrun.command("label", cid)}
    ran_before = bool(found["applications"])
    stop = _label_stop_file(c, cid)
    stop.unlink(missing_ok=True)
    told = None
    if again:
        await concepts.start_again(c, cid, "user")
        told = concepts.tell_when_done(c, cid)
    else:
        await concepts.start_apply(c, cid, paths, limit or None, "user")
        cards = await asyncio.to_thread(concepts._label_cards, ws, cid)
        card = dict(cards[0][1]) if cards else None
        if card is None and not ran_before:
            card = await asyncio.to_thread(concepts.label_card, c, found, None, "user")
        concepts.tell_main(c, found, card)
    # `label-stop` from another process asks this run to stop after its current unit, as the browser's Stop does; so does
    # `label-delete` from another process, which removes the label's file
    ended = threading.Event()
    defined = concepts._concept_file(ws, cid)

    def watch() -> None:
        while not ended.wait(LABEL_STOP_POLL_S):
            if stop.exists() or not defined.is_file():
                concepts._cancel_event(c, cid).set()
                stop.unlink(missing_ok=True)
                return

    threading.Thread(target=watch, name=f"label-stop-{cid}", daemon=True).start()
    try:
        summary = await concepts.wait_apply(c, cid, float("inf"))
    finally:
        ended.set()
    if told is not None:  # this process ends with the run: main's `label_done` goes out first
        with contextlib.suppress(Exception):
            await asyncio.wait_for(asyncio.shield(told), LABEL_DONE_WAIT_S)
    return {"label": cid, "summary": summary}


LABEL_STOP_POLL_S = 0.5
LABEL_DONE_WAIT_S = 30.0  # how long a `label-run` with `again` waits for its `label_done` to go out


def _label_stop_file(c: str, cid: str) -> Path:
    """The file that asks a running `label-run` of label `cid` to stop (`label-stop`); the run's process watches for it."""
    return config.workspace_dir(c) / "concepts" / f"{cid}.stop"


async def _act_label_stop(c: str, payload: dict[str, Any]) -> dict[str, Any]:
    """Stop a label's run that `label-run` started, after its current unit; the rows written so far stay (the browser's
    Stop, concepts.cancel_apply_route). The run lives in that act's own process, which watches for the stop file."""
    from . import concepts  # noqa: PLC0415

    ws = config.workspace_dir(c)
    found = concepts.find_concept(ws, _text(payload, "label"))
    if found is None:
        raise StateError(f"no label {payload.get('label')!r}")
    cid = str(found["id"])
    stop = _label_stop_file(c, cid)
    stop.parent.mkdir(parents=True, exist_ok=True)
    stop.write_text(_now(), "utf-8")
    return {"label": cid, "stopping": True}


async def _act_label_delete(c: str, payload: dict[str, Any]) -> dict[str, Any]:
    """Delete a label from the terminal's label panel, as the browser's Delete label does (DELETE /concepts/{id},
    concepts.delete_concept_route): the label, its marks, its card and any filter that uses it. A run of it in this
    process ends inside the route; a `label-run` of it in another process stops once it sees the label's file gone."""
    from . import concepts  # noqa: PLC0415

    ws = config.workspace_dir(c)
    found = concepts.find_concept(ws, _text(payload, "label"))
    if found is None:
        raise StateError(f"no label {payload.get('label')!r}")
    cid = str(found["id"])
    await concepts.delete_concept_route(c, cid)
    _label_stop_file(c, cid).unlink(missing_ok=True)
    return {"label": cid, "name": found["name"], "deleted": True}


async def _act_label_undelete(c: str, payload: dict[str, Any]) -> dict[str, Any]:
    """Undo the delete of label `label` (its id), as the top bar's Undo does right after it (POST /undo, undo.undo): the
    label back with its marks, its card and its filters. Only while that delete is the change an undo reverts next, so
    no later change is undone with it."""
    from . import concepts, undo  # noqa: PLC0415

    cid = _text(payload, "label").removeprefix("concept:")
    # on the loop, as the undo route runs, where the restored card's stream records are emitted
    undo.undo(c, ("label", cid))
    k = concepts.read_concept(config.workspace_dir(c), cid)
    return {"label": cid, "name": (k or {}).get("name") or "", "restored": k is not None}


async def _act_label_show(c: str, payload: dict[str, Any]) -> dict[str, Any]:
    """A label over files turned on or off in Files and the views (`on`), its values highlighted while it is on
    (`values`), or its values given colors by name (`colors`, or `colours`, its British alias; concepts.COLOUR_NAMES),
    as the Labels pane's toggle and palette do and show_label does (concepts.show_concept). It runs nothing."""
    from . import concepts  # noqa: PLC0415

    ws = config.workspace_dir(c)
    found = concepts.find_concept(ws, _text(payload, "label"))
    if found is None:
        raise StateError(f"no label {payload.get('label')!r}")
    on = payload.get("on")
    if on is not None and not isinstance(on, bool):
        raise StateError("`on` must be true or false")
    values = payload.get("values")
    if values is not None and not (isinstance(values, list) and all(isinstance(v, str) for v in values)):
        raise StateError("`values` must be a list of the label's values")
    colours = payload.get("colors", payload.get("colours"))
    if colours is not None and not (isinstance(colours, dict) and all(isinstance(v, str) for v in colours.values())):
        raise StateError("`colors` must map values to color names")
    if on is None and not colours:
        raise StateError("nothing to change: give on or colors")
    k = await asyncio.to_thread(concepts.show_concept, c, str(found["id"]), on, values, colours)
    return {"label": k["id"], "shown": bool(k["shown"]), "classes": k["classes"]}


async def _act_label_filter(c: str, payload: dict[str, Any]) -> dict[str, Any]:
    """Keep only the units label `label` gives `value`, as a label card's value or the Labels pane's funnel does (PUT
    /filters, concepts.set_filter): the filter of the label's scope, Files for a label over files (which turns it on with
    that value alone highlighted), the canvas for one over cards, the report for one over sentences. With no `value`, the
    scope's filter goes when it names this label (DELETE /filters/{scope})."""
    from . import concepts  # noqa: PLC0415

    ws = config.workspace_dir(c)
    found = concepts.find_concept(ws, _text(payload, "label"))
    if found is None:
        raise StateError(f"no label {payload.get('label')!r}")
    cid = str(found["id"])
    scope = concepts.SCOPE_OF_UNIT[found["unit"]]
    value = " ".join(str(payload.get("value") or "").split())
    if not value:
        f = concepts.read_filters(ws).get(scope) or {}
        if f.get("concept") == cid:
            await asyncio.to_thread(concepts.clear_filter, c, scope)
        return {"label": cid, "scope": scope, "filter": None}
    if value not in found["labels"]:
        raise StateError(f"the label {found['name']!r} has no value {value!r}; its values are {', '.join(found['labels'])}")
    await asyncio.to_thread(concepts.set_filter, c, scope, cid, value)
    return {"label": cid, "scope": scope, "filter": value}


async def _act_seen(c: str, payload: dict[str, Any]) -> dict[str, Any]:
    """The analyst opened a thread: its answers so far are seen (threads.mark_seen)."""
    from . import threads  # noqa: PLC0415

    thread = _text(payload, "thread").removeprefix("thread:")
    return {"thread": thread, "seen": threads.mark_seen(c, thread)}


async def _act_stop(c: str, payload: dict[str, Any]) -> dict[str, Any]:
    """Stop one of thimble's agents, by its chat or its agent id, through the hooks module (subagents.stop), as the
    browser's Stop does."""
    from . import agents, subagents  # noqa: PLC0415

    who = _text(payload, "agent").removeprefix("chat:").removeprefix("thread:")
    meta = agents.meta_or_none(c, who) if agents.ID_RE.match(who) else None
    # an agent's chat names its agent; a side thread's, the fork of main that answers it
    fork = (meta or {}).get("fork") if isinstance((meta or {}).get("fork"), dict) else {}
    agent_id = str((meta or {}).get("agent_id") or fork.get("agent_id") or who)
    ans = await subagents.stop(c, agent_id)
    if ans.refused:
        return {"stopped": False, "kind": ans.kind, "reason": ans.reason}
    return {"stopped": True, **({"done": True} if ans.get("done") else {})}


BACKEND_DIR = Path(__file__).resolve().parents[1]  # where `python -m app.local_hooks` runs


def _hand_over(kind: str, c: str, body: dict[str, Any] | None = None) -> None:
    """`python -m app.local_hooks <kind>` started detached with the corpus folder and `body` on its stdin, as a hook
    starts it (.thimble-watch spawn_local), and not waited for: the holder of the workspace's passes runs it, the one
    process that writes proposals.json and follows to its end a build it queues. OSError when it cannot start."""
    import subprocess  # noqa: PLC0415

    proc = subprocess.Popen([sys.executable, "-m", "app.local_hooks", kind], cwd=str(BACKEND_DIR),
                            stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                            start_new_session=True, close_fds=True)
    if proc.stdin is None:
        return
    try:
        proc.stdin.write(json.dumps({"cwd": str(config.corpus_dir(c)), **(body or {})}).encode("utf-8"))
        proc.stdin.close()
    except OSError:
        pass


def _queued(kind: str, c: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
    """`kind` handed to the holder (_hand_over): {queued: true}, or {queued: false, reason} when it cannot start."""
    try:
        _hand_over(kind, c, body)
    except OSError as e:
        return {"queued": False, "reason": f"thimble could not start its {kind} call: {e}"}
    return {"queued": True}


def _offer_answer(c: str, payload: dict[str, Any], kind: str) -> dict[str, Any]:
    """The analyst's accept, reject or dismiss of the view proposal that waits (views.open_offer), handed to the holder
    (local_hooks `view-accept`: views.accept, its build queued; `view-reject`; `view-dismiss`): this process reads and
    writes nothing more. {queued: true} at once, or {queued: false, reason} when the proposal is gone or no longer
    waits."""
    from . import views  # noqa: PLC0415

    slug = _text(payload, "slug")
    row = views.read_proposal(c, slug)
    if row is None:
        return {"queued": False, "reason": f"there is no view proposal {slug!r}"}
    waiting = views.open_offer(c) if views.propose_enabled(c) else None
    if not waiting or waiting.get("slug") != slug:
        return {"queued": False, "reason": f"the view proposal {str(row.get('name') or slug)!r} no longer waits"}
    return _queued(kind, c, {"slug": slug})


async def _act_view_accept(c: str, payload: dict[str, Any]) -> dict[str, Any]:
    """Accept the view proposal, as the browser's Accept does (POST …/proposals/{slug}/accept)."""
    return _offer_answer(c, payload, "view-accept")


async def _act_view_reject(c: str, payload: dict[str, Any]) -> dict[str, Any]:
    """Reject the view proposal, as the browser's Reject does (POST …/proposals/{slug}/reject)."""
    return _offer_answer(c, payload, "view-reject")


async def _act_view_dismiss(c: str, payload: dict[str, Any]) -> dict[str, Any]:
    """Dismiss the view proposal from the row above the prompt: hidden for main's session, there and in the browser's
    card, and not answered (views.hide_offer)."""
    return _offer_answer(c, payload, "view-dismiss")


async def _act_view_proposals_off(c: str, payload: dict[str, Any]) -> dict[str, Any]:
    """Turn view proposals off, as the browser's Don't ask again does (PUT settings `propose_views: false`):
    `views.propose: false` in thimble's config (userconf.save writes it where the key was set, else in the file in
    thimble's home). {off: true, config: the file that holds it now}; StateError naming the config's error when it
    cannot be written."""
    from . import userconf  # noqa: PLC0415

    try:
        userconf.save(c, {"views": {"propose": False}})
    except userconf.ConfigError as e:
        raise StateError(str(e)) from None
    written = userconf.global_file()
    with contextlib.suppress(OSError, ValueError, AttributeError):
        if "propose" in (json.loads(userconf.workspace_file(c).read_text("utf-8")).get("views") or {}):
            written = userconf.workspace_file(c)
    return {"off": True, "config": str(written)}


async def _act_view_propose_now(c: str, payload: dict[str, Any]) -> dict[str, Any]:
    """Check for a view proposal now, as a notice's Try again does in the browser (POST …/views/propose-now): handed to
    the holder (local_hooks `view-propose-now`: proposer.run_now), which runs it and writes what comes of it.
    {queued: false, reason} at once while view proposals are off or one waits for an answer, which the holder would
    refuse with no word to the terminal."""
    from . import views  # noqa: PLC0415

    if not views.propose_enabled(c):
        return {"queued": False, "reason": 'view proposals are off; set "views": {"propose": true} in thimble\'s config'}
    if views.open_offer(c) is not None:
        return {"queued": False, "reason": "a view proposal waits for your answer above the prompt"}
    return _queued("view-propose-now", c, _notice_ref(payload))


async def _act_view_retry(c: str, payload: dict[str, Any]) -> dict[str, Any]:
    """Build again a view whose build failed, as a notice's Retry does in the browser (POST …/proposals/{slug}/retry):
    handed to the holder (local_hooks `view-retry`: views.retry), which follows the build. {queued: false, reason} for a
    view with nothing failed."""
    from . import views  # noqa: PLC0415

    slug = _text(payload, "slug")
    row = views.read_proposal(c, slug)
    if row is None:
        return {"queued": False, "reason": f"there is no view {slug!r}"}
    if row.get("status") != "failed" and not (row.get("status") == "built" and row.get("failed_change") is not None):
        return {"queued": False, "reason": f"the view {str(row.get('name') or slug)!r} is {row.get('status')}, not failed"}
    return _queued("view-retry", c, {"slug": slug, **_notice_ref(payload)})


async def _act_view_term_page(c: str, payload: dict[str, Any]) -> dict[str, Any]:
    """The terminal's open of a built view that has no terminal page (built for the browser): its build queued as the
    browser's first open of a terminal-built view queues one (views.ensure_page), handed to the holder (local_hooks
    `view-term-page`), which follows the build. {queued: true} at once, also while a build of the view goes; {ready:
    true} when it has the page; {queued: false, reason} with the fix when it cannot be built now (views.page_ask)."""
    from . import views  # noqa: PLC0415

    got = views.page_ask(c, _text(payload, "slug"), views.TERM_PAGE)
    if got.pop("build", False):
        return _queued("view-term-page", c, {"slug": _text(payload, "slug")})
    return got


def _notice_ref(payload: dict[str, Any]) -> dict[str, Any]:
    """The id of the notice whose act the press was (`notice`), which the holder dismisses before it runs the act, so
    that a failure that comes again shows as a notice of its own: {notice: id}, or {} for none."""
    notice_id = " ".join(str(payload.get("notice") or "").split())
    return {"notice": notice_id} if notice_id else {}


async def _act_notice_dismiss(c: str, payload: dict[str, Any]) -> dict[str, Any]:
    """A notice dismissed, as its × does in the browser: handed to the holder (local_hooks `notice-dismiss`:
    notices.dismiss), which writes it, so the notice is gone in every view and after a relaunch. {queued: true}."""
    return _queued("notice-dismiss", c, {"id": _text(payload, "id")})


async def _act_sign_out(c: str, payload: dict[str, Any]) -> dict[str, Any]:
    """A sign-in notice's Sign it out in the terminal: the browser the notice names (`slug`, its id) signed out by
    thimble's server, as `thimble unpair` signs out every browser (POST /api/ui/unpair {browser}, a token route), and
    its notice gone. {queued: true}; StateError when the server does not take it."""
    from . import cli  # noqa: PLC0415

    browser = _text(payload, "slug")
    status, body = await asyncio.to_thread(cli._request, "POST", f"{cli.api_url()}/api/ui/unpair",
                                           {"browser": browser}, SERVER_ACT_TIMEOUT_S)
    if status not in (200, 204):
        why = body.get("detail") if isinstance(body, dict) else body
        raise StateError(f"thimble's server did not sign that browser out ({status or 'no answer'}: {why})")
    return {"queued": True, "signed_out": browser}


_ACTS = {"thread": _act_thread, "thread-message": _act_thread_message, "verdict": _act_verdict, "label": _act_label,
         "label-run": _act_label_run, "label-stop": _act_label_stop, "label-delete": _act_label_delete,
         "label-undelete": _act_label_undelete, "label-show": _act_label_show, "label-filter": _act_label_filter,
         "seen": _act_seen, "stop": _act_stop, "view-accept": _act_view_accept,
         "view-reject": _act_view_reject, "view-dismiss": _act_view_dismiss,
         "view-proposals-off": _act_view_proposals_off,
         "view-propose-now": _act_view_propose_now, "view-retry": _act_view_retry,
         "view-term-page": _act_view_term_page, "notice-dismiss": _act_notice_dismiss, "sign-out": _act_sign_out}


# --------------------------------------------------------------------------- the command line


def _fail(text: str) -> int:
    sys.stdout.write(json.dumps({"error": text}) + "\n")
    return 1


def main(argv: list[str]) -> int:
    """`state <surface> --cwd <dir> [args]` or `act <kind> --cwd <dir> '<json>'` (module note); `view host|text …`,
    terminal views (term_views.main)."""
    logging.basicConfig(level=logging.WARNING, stream=sys.stderr, format="thimble %(levelname)s: %(message)s")
    if argv[:1] == ["view"]:
        settle_dirs()
        from . import term_views  # noqa: PLC0415

        return term_views.main(argv[1:])
    if len(argv) < 2 or argv[0] not in ("state", "act"):
        return _fail(f"usage: {STATE_USAGE} | {ACT_USAGE}")
    verb, what, rest = argv[0], argv[1], argv[2:]
    settle_dirs()
    try:
        cwd = _flag(rest, "--cwd", os.getcwd()) or os.getcwd()
        c = workspace(cwd)
        if not c:
            return _fail(f"{cwd} is not inside a corpus thimble knows")
        if verb == "state":
            out: Any = asyncio.run(state(c, what, [a for a in rest]))
        else:
            # --stdin: the act's JSON on standard input, for a payload past what one argument may hold (coverage facts
            # that name 100,000 paths)
            stdin = "--stdin" in rest
            rest = [a for a in rest if a != "--stdin"]
            raw = _positional(rest)
            try:
                text = sys.stdin.read() if stdin else (raw[0] if raw else "")
                payload = json.loads(text) if text.strip() else {}
            except ValueError as e:
                return _fail(f"the act's argument is not JSON: {e}")
            out = asyncio.run(act(c, what, payload, session=_flag(rest, "--session") or session_here()))
    except StateError as e:
        return _fail(str(e))
    except Exception as e:  # noqa: BLE001 — the renderer reads {error} rather than a traceback
        log.debug("thimble %s %s failed", verb, what, exc_info=True)
        return _fail(f"{type(e).__name__}: {e}")
    sys.stdout.write(json.dumps(out, ensure_ascii=False, default=str) + "\n")
    return 0


# the report in the terminal (term_report.py): the checks its comments name, and a comment resolved or opened again
from . import term_report as _term_report  # noqa: E402 — it joins the surfaces and acts above

_SURFACES.update(_term_report.SURFACES)
_ACTS.update(_term_report.ACTS)
STATE_USAGE += _term_report.STATE_USAGE
ACT_USAGE += _term_report.ACT_USAGE

# 0.9.0's surfaces and acts (state_more.py): coverage, the labels' unsure records, the checks' comments on answers
from . import state_more as _state_more  # noqa: E402 — it joins the surfaces and acts above

_SURFACES.update(_state_more.SURFACES)
_ACTS.update(_state_more.ACTS)
STATE_USAGE += _state_more.STATE_USAGE
ACT_USAGE += _state_more.ACT_USAGE


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
