"""Browser events: how the browser reaches the analyst's Claude Code session.

The `thimble` launcher starts the session with the plugin loaded and main's prompt appended (session_prompt). The
plugin's MCP shim holds one SSE subscription here, `GET /api/events`, which attaches its session to the workspace and
is its liveness (session.connected); the stream carries no events.

The browser posts `POST /api/ws/{c}/events {kind, payload}`; server code calls post(). A kind is a bullet of main.md's
`## Events from the browser`, and other kinds are refused. A post with no subscriber is refused with 409. An event of
QUIET_KINDS asks main for nothing, so it wakes no turn: it waits in the workspace's HELD_FILE and rides along, under
MEANWHILE, with the next event or the analyst's next prompt in the terminal (the plugin's UserPromptSubmit hook takes it
with held_route).

Each event is queued per workspace and session (_pending), and the plugin's watcher takes it with a long poll
(pull_route) as the text the model reads (render); unacknowledged events return to the queue after ACK_S. The watcher
runs as the plugin's asyncRewake hooks, which wake the session with the event (the HOOK route), or, where the plugin's
hooks are off, as main's Monitor (the MONITOR route, cc_plugin.route). Permission prompts come from the
PermissionRequest hook; since Claude Code does not signal that hook when the analyst answers in the terminal, the server
ends the wait itself (clear_permissions, release_asks, agent_moved). A prompt of one of thimble's agents is asked in the
terminal alone (`terminal` on its entry, which the browser shows as that agent waiting for the analyst's answer there);
it ends with its call's result (calls_done), its agent's end (agent_moved), or once Claude Code's record of main's
session says no dialog is open after it was seen open (terminal_dialogs). A prompt's card offers "Always allow" where
Claude Code's own dialog offers "don't ask again", in that dialog's words (permission_updates.main_words): the request's
permission_suggestions that dialog applies for the tool, each kept where Claude Code gave it
(permission_updates.main_offer), none when the org's managed tier sets allowManagedPermissionRulesOnly (_main_offer).

Main's terminal shows each event as one line (terminal_line): the analyst's words after SAID, with the thread or button
they belong to, else a short line saying what happened. Claude Code shows a woken turn only as the hook's fixed summary,
so the watcher's acknowledgment keeps the event's line (_lines) for the UserPromptSubmit hook, which Claude Code runs
as the event's turn begins, to print (held_route); the line of something the analyst did that sends main no event, such
as a follow-up to the orientation, waits there too (show). With every hook off (the Monitor route) nothing can print
them. A message the analyst sends while main's turn runs reaches the session only at the turn's next tool call, or once
the turn ends, so main's statusline shows its words at once, after QUEUED, until the held hook prints its line
(queued_line, which tray.agents_route adds to the statusline).

Terminal mode (the session launch.json names runs in terminal mode, subagent_files.session_mode) has no server, so no
subscription, watcher poll or in-memory queue: post() writes the event to the workspace's events/queue.jsonl, a quiet
one to held-events.json (event_files.py), and main's watcher takes it from the file. An event reaches main while main's
`claude` process runs (launch.json's pid); none is refused for want of a subscription.

A session started before an update to 0.6.0 runs 0.5.0's MCP shim, and perhaps the hooks of 0.5.0's cached plugin copy,
until Claude Code restarts. Those call the routes 0.5.0 named for Claude Code channels, which answer as their new routes
for this release (OLD_PATHS, which main.OldEventRoutes applies), so such a session still hears the browser.
"""
from __future__ import annotations

import asyncio
import html
import json
import logging
import re
import secrets
import time
from collections import deque
from pathlib import Path
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator, Callable, NamedTuple

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel
from sse_starlette import EventSourceResponse

from . import cc_plugin, config, event_files, ledger, permission_updates, procs, prompts
from . import subagent_files as files

log = logging.getLogger("thimble.events")


@asynccontextmanager
async def _lifespan(app: Any):
    from . import session  # noqa: PLC0415

    session.start_sweep()  # detaches a session recorded as main whose shim does not come back after a restart
    yield


router = APIRouter(lifespan=_lifespan)

PROMPT = "main"  # main's system-prompt append, whose events section names the kinds
EVENTS_SECTION = "Events from the browser"
SESSION_PROMPTS = (PROMPT,)
MAIN, THREAD = "main", "thread"
START_AGENT = "start_agent"  # asks main to start the agent of what a thread's fork filed (tools._ask_main)
ATTR_CHARS = 120  # a payload value longer than this, or with a newline, goes into the body instead of an attribute
# the event body's ceiling: an event stays in main's context for the rest of the session. A START_AGENT event's body is
# never cut, since its text is the exact Agent call main makes, which a cut would break (main's own start tool's result
# carries the same call whole)
BODY_CHARS = 12_000
PING_S = 15  # the stream's keep-alive, so a proxy or the shim's read timeout never drops an idle subscription
NOT_LISTENING = ("no Claude Code session is listening in {cwd}. Start thimble with `thimble` in that folder, or say "
                 "/thimble in a Claude Code session there.")
PERMISSION_INPUT_CHARS = 50_000  # of a relayed request's input shown in the browser; past it the entry's `cut` says so
TAG = "thimble-event"  # the element an event is rendered as for the model (render), which the mirror reads back
PULL_WAIT_S = 25.0  # a pull's longest wait (module note); the watcher asks again
PULL_WAIT_MAX_S = 60.0
PULL_TICK_S = 1.0  # a waiting pull looks at its client and the events in flight this often
ACK_S = 15.0  # an event taken and not acknowledged within this goes back to the front of its queue
GONE = "gone"  # _pull_state: another session is main now
DORMANT = "dormant"  # _pull_state: another session is main now, and this one is main again when that one ends
HOOK_ASK_PREFIX = "h"  # the ids of the permission requests the PermissionRequest hook relays
SAID = "› "  # opens the analyst's own words in main's terminal (terminal_line)
QUEUED = "queued from the browser: "  # opens the statusline's line of a message main has not got yet (queued_line)
QUEUED_TERMINAL = "queued: "  # the same in terminal mode, where the analyst's words come from the terminal's panes
LINE_CHARS = 160  # of an event's line in main's terminal: about two lines
NOTICES_KEPT = 50  # a session's queued messages kept for its statusline; the oldest go first
# 0.5.0's routes (module note) -> the route each answers as. A 0.5.0 shim's own relay of a channel's permission prompt
# (/api/channel/permission) has none: the PermissionRequest hook relays the same prompt.
OLD_PATHS = {"/api/channel": "/api/events", "/api/channel/pull": "/api/events/pull", "/api/channel/ack": "/api/events/ack",
             "/api/channel/held": "/api/events/held", "/api/channel/mode": "/api/events/mode",
             "/api/channel/main": "/api/events/main", "/api/channel/sessions": "/api/events/sessions",
             "/api/channel/permission/hook": "/api/events/permission"}
_KEY_RE = re.compile(r"[^A-Za-z0-9_]")
_KIND_RE = re.compile(r"^- `([a-z_]+)`", re.M)


class Sub:
    """A shim's subscription: the session it named (None for none) and the route its session hears events by
    (cc_plugin.HOOK or MONITOR)."""

    __slots__ = ("session", "delivery")

    def __init__(self, session: str | None, delivery: str = cc_plugin.HOOK) -> None:
        self.session = session
        self.delivery = delivery


_subs: dict[str, set[Sub]] = {}  # workspace -> its live subscriptions
_pending: dict[tuple[str, str], deque] = {}  # (workspace, session or "") -> events waiting for a watcher (module note)
_taken: dict[str, tuple[str, str, dict[str, Any], float]] = {}  # event id -> (workspace, session, note, when taken)
_waiters: dict[str, set[tuple[asyncio.AbstractEventLoop, asyncio.Future]]] = {}  # workspace -> its waiting pulls
_asks: dict[str, "Ask"] = {}  # hook permission id -> the request waiting for the analyst
_terminal: dict[str, "Ask"] = {}  # hook permission id -> a request of thimble's agents the terminal answers (its card)
# the requests of _terminal seen open while Claude Code's record of main's session said a dialog was open in the
# terminal (terminal_dialogs), and by workspace when that record last began to say none is
_seen_open: set[str] = set()
_closed_since: dict[str, float] = {}
_offers: dict[str, list[dict[str, Any]]] = {}  # hook permission id -> what its card's "Always allow" adds (_main_offer)
# (workspace, session) -> (event id, line) of events its watcher wrote out, and lines that send no event, to print
_lines: dict[tuple[str, str], list[tuple[str, str]]] = {}
# (workspace, session) -> (event id, words) of the analyst's messages queued for it, not yet printed (queued_line)
_notices: dict[tuple[str, str], list[tuple[str, str]]] = {}
_observers: dict[str, list[Callable[[str, dict[str, Any], dict[str, Any]], None]]] = {}  # kind -> observe()'s functions


# --------------------------------------------------------------------------- the prompt and the kinds


def kinds() -> list[str]:
    """The event kinds: the backticked words that open the bullets of main.md's events section, read fresh."""
    return _KIND_RE.findall(prompts.section(PROMPT, EVENTS_SECTION))


def session_prompt(workdir: str, terminal: bool | None = None, edits: bool | None = None) -> str:
    """Main's system-prompt append, as the launcher passes it with --append-system-prompt. Claude Code cuts MCP server
    instructions at 2 KB, so this text cannot travel as the shim's instructions, while an append reaches main and every
    fork of it whole. `terminal` picks the ending of a turn and `edits` whether main may write the corpus
    (render_prompts)."""
    return render_prompts(SESSION_PROMPTS, workdir, terminal, edits)


# main.md's {{corpus_writes}} in the browser: what main's sandbox lets it write, by Settings' switch (ledger.corpus_edits);
# None for a main the server does not run (the launcher's), whose sandbox the switch does not reach
CORPUS_WRITES: dict[bool | None, str] = {
    None: "Bash reads the corpus and writes only your own folders, and file edits go only there.",
    True: ("Bash reads and writes the corpus folder and your own folders, and file edits go there too. thimble's own "
           "files stay unwritable. The analyst can turn this off in Settings with \"Claude can edit files in this "
           "folder\"."),
    False: ("Bash reads the corpus folder but cannot write it, since the analyst turned \"Claude can edit files in this "
            "folder\" off in Settings; it writes only your own folders, and file edits go only there. When a file has "
            "to go into the corpus folder, tell the analyst they can turn \"Claude can edit files in this folder\" "
            "back on in Settings."),
}


def render_prompts(names: tuple[str, ...] | list[str], workdir: str, terminal: bool | None = None,
                   edits: bool | None = None) -> str:
    """Prompt files for a session in `workdir`, rendered and joined by a blank line, with the corpus root and the citation
    forms of the folder's views filled in. Main's append and the shared skill's command both come from here. Main's
    prompt keeps one ending of a turn with nothing for the analyst (terminal_tools.main_prompt): without closing words
    when `terminal`, or when it is None and this process's environment says so (terminal_tools.on). `edits`: whether
    main may write the corpus (CORPUS_WRITES), None where the server does not run main (runtime.py)."""
    from . import cardtypes, terminal_tools, views  # noqa: PLC0415 — views imports refs, which a launcher does not otherwise need

    c = config.workspace_for_cwd(workdir)
    forms = views.forms_text(c) if c else ""
    values = {"workdir": str(workdir), "forms": forms, "card_types": cardtypes.prompt_text(c),
              "corpus_writes": CORPUS_WRITES[edits]}
    parts = []
    for name in names:
        part = prompts.render(name, values).strip()
        if name == PROMPT:
            part = terminal_tools.main_prompt(part, terminal_tools.on() if terminal is None else terminal)
            from . import roles  # noqa: PLC0415 — roles reads the extensions

            if added := roles.main_additions(c):
                part = f"{part}\n\n{added}"
        parts.append(part)
    return re.sub(r"\n{3,}", "\n\n", "\n\n".join(parts))  # an empty {{forms}} leaves a blank line of its own


# --------------------------------------------------------------------------- posting


def observe(kind: str, fn: Callable[[str, dict[str, Any], dict[str, Any]], None]) -> None:
    """Call `fn(c, payload, posted)` after each event of `kind` is posted; an observer that raises is logged and skipped."""
    if fn not in _observers.setdefault(kind, []):
        _observers[kind].append(fn)


def listening(c: str, sid: str | None = None) -> bool:
    """Whether a session's shim holds a subscription for the workspace, on any route; with `sid`, one of that session's or
    of a shim that named no session."""
    from . import runtime  # noqa: PLC0415

    if runtime.enabled():  # the server runs main itself (runtime.py): main always listens
        return True
    subs = _subs.get(c) or set()
    if sid is None:
        return bool(subs)
    return any(sub.session in (sid, None) for sub in subs)


def subscribed_sessions(c: str) -> list[str]:
    """The sessions whose shims hold a subscription for the workspace, as they named themselves ('' for none)."""
    return [str(sub.session or "") for sub in _subs.get(c, ())]


def connected_workspaces() -> list[str]:
    """The workspaces a session's shim holds a subscription for."""
    return sorted(c for c, subs in _subs.items() if subs)


def reachable(c: str) -> bool:
    """Whether an event posted now reaches a session: a subscription of the session that is main, or a session main just
    continued in whose shim has not subscribed yet (_awaits_shim). Another `claude` in the folder subscribes too, and
    never gets main's events, nor does a parked session (_publish). In terminal mode, which has no subscription, main's
    `claude` process runs (launch.json's pid), whose watcher takes the event from the queue file."""
    from . import runtime  # noqa: PLC0415

    if runtime.enabled():  # the server runs main itself (runtime.py)
        runtime.ensure(c)
        return True
    ws = _terminal_ws(c)
    if ws is not None:
        return files.main_pid(ws) is not None
    _read_main(c)
    main = _main_sid(c)
    return _awaits_shim(c) or bool(main and any(sub.session == main for sub in _live_subs(c, main)))


def _attr_key(key: str) -> str:
    return _KEY_RE.sub("_", str(key)).strip("_")


def build_note(kind: str, event_id: str, text: str, fields: dict[str, Any], *,
               cap: int | None = BODY_CHARS) -> dict[str, Any]:
    """{content, meta} of one event: `kind` and `event` (its id) first, then each field as an attribute when
    it is a short scalar, else as a `<key>: <value>` line under the text, the whole cut at `cap` (none when None). The
    id is `event`, never `id`, so that no attribute a prompt names by its role reads as "the id"."""
    meta: dict[str, str] = {"kind": kind, "event": event_id}
    lines: list[str] = []
    for k, v in fields.items():
        key = _attr_key(k)
        if not key or v is None or v == "" or key in meta:
            continue
        if isinstance(v, (dict, list)):
            lines.append(f"{key}: {json.dumps(v, ensure_ascii=False)}")
            continue
        s = str(v).strip() if not isinstance(v, bool) else ("true" if v else "false")
        if len(s) <= ATTR_CHARS and "\n" not in s:
            meta[key] = s
        else:
            lines.append(f"{key}:\n{s}" if "\n" in s else f"{key}: {s}")
    body = "\n".join([t for t in [str(text or "").strip(), *lines] if t])
    if cap is not None and len(body) > cap:
        body = body[:cap].rstrip() + "\n…"
    return {"content": body, "meta": meta}


# the kinds that say something ended and ask main for nothing: each waits and rides along with the next event, under
# MEANWHILE (prompts/main.md)
QUIET_KINDS = frozenset({"orient", "written", "labeled", "label_ask", "view", "card_types", "citations"})
MEANWHILE = "meanwhile:"
HELD_FILE = "held-events.json"  # in the workspace: the quiet events waiting, as notes, across restarts
_held: dict[str, list[dict[str, Any]]] = {}  # workspace -> HELD_FILE's notes, once read


def describe(kind: str, payload: dict[str, Any]) -> str:
    """The body of an event that carries no text of its own: one line saying what the analyst did."""
    return f"The analyst sent `{kind}` from the browser"


def terminal_line(kind: str, words: str, fields: dict[str, Any]) -> str:
    """An event's line in main's terminal (module note): the analyst's `words` after SAID, else a short line saying what
    happened, on one line and cut at LINE_CHARS. An `orient` event's text keeps its lines, since its second is the
    orientation's coverage line (orient_session.status_text), which is cut only past three times that."""
    if kind == "orient" and "\n" in str(words or "").strip():
        first, *rest = [part for part in str(words).splitlines() if part.strip()]
        return "\n".join([terminal_line(kind, first, fields), *(_cut(" ".join(r.split()), 3 * LINE_CHARS) for r in rest)])
    words = " ".join(str(words or "").split())
    if kind in (MAIN, "card"):
        line = SAID + words
    elif kind == THREAD:
        # the thread by its first question (threads.line_name), never its fork's name, which is a slug
        name = str(fields.get("name") or "")
        line = f"{SAID}thread {name}: {words}" if name else f"{SAID}new thread: {words}"
    elif kind == "labeled":
        line = f"label {fields.get('what') or 'defined'}: {fields.get('name') or ''}"
    elif kind == "view":
        line = f"view built: {fields.get('view') or ''}"
    elif kind == "card_types":
        line = f"card types: {fields.get('types') or ''}"
    elif kind == "label_ask":
        line = f"label {fields.get('name') or ''}: the analyst chose {fields.get('choice') or ''}"
    elif kind == "label_done":
        line = f"label finished: {fields.get('name') or ''}"
    elif kind == "rerun":
        line = f"cards run again: label {fields.get('name') or ''} changed"
    elif kind == "written":
        line = f"the {fields.get('doc') or 'document'} writer ended"
    elif kind == "checked":
        line = f"a check of the {fields.get('doc') or 'document'} ended"
    elif kind == "citations":
        line = "the check of the last reply's citations changed some"
    elif kind == START_AGENT:
        asked = f" (thread {fields['from_thread']})" if fields.get("from_thread") else ""
        line = f"start {fields.get('agent') or 'the dev agent'} for {fields.get('filed') or 'a thread'}{asked}"
    else:
        line = words
    return _cut(line, LINE_CHARS)


def _cut(line: str, n: int) -> str:
    """`line` cut to `n` characters at a word, with an ellipsis."""
    if len(line) <= n:
        return line
    cut = line[: n - 1]
    at_word = cut.rsplit(" ", 1)[0]  # a line with no space late enough, such as a URL or Japanese, is cut mid-word
    return (at_word if len(at_word) > n // 2 else cut) + "…"


def post(c: str, kind: str, payload: dict[str, Any] | None = None, *, check_kind: bool = True,
         mirror: bool = True, line: str | None = None, event_id: str | None = None) -> dict[str, Any]:
    """Send one event to the workspace's session: {id, kind, delivered, thread?}. A `main` event shows in main's chat
    as the analyst's line unless `mirror` is False, for a request server code writes to main, which passes the `line`
    main's terminal shows instead of terminal_line's. `event_id` is the event's id when the caller recorded it first
    (a START_AGENT event's request keeps it). 409 when no session listens, 400 for a kind main.md names no bullet for
    (when `check_kind`), or for a message with no text."""
    from . import agents, session, threads  # noqa: PLC0415

    kind = str(kind or "").strip()
    payload = dict(payload or {})
    if check_kind and kind not in kinds():
        raise HTTPException(400, f"unknown event kind {kind!r}; the kinds are {', '.join(kinds())} (prompts/{PROMPT}.md)")
    ws = _terminal_ws(c)
    if not reachable(c):
        raise HTTPException(409, NOT_LISTENING.format(cwd=config.corpus_dir(c)))
    event_id = event_id or secrets.token_hex(4)
    out: dict[str, Any] = {"id": event_id, "kind": kind}
    seen = dict(payload)  # what an observer reads, before the builders below take their keys out
    if kind == MAIN:
        words = str(payload.pop("text", "") or "").strip()
        if not words:
            raise HTTPException(400, "empty message")
        if mirror:
            agents.mirror(c, "user", by=agents.BROWSER, text=words, event=event_id)
        note = build_note(kind, event_id, words, {**payload, **_ultracode(c), **_filters(c)})
    elif kind == THREAD:
        words = str(payload.get("text") or "")
        built = threads.event(c, payload, event_id)
        if built is None:  # it waits for the thread's fork, which gets it once known (threads.flush)
            return {**out, "thread": str(payload.get("thread") or ""), "delivered": 0, "queued": True}
        text, payload, thread_id = built
        note = build_note(kind, event_id, text, {**payload, **_filters(c)})
        out["thread"] = thread_id
        if line is None:
            line = terminal_line(kind, words, {"name": threads.line_name(c, thread_id, [words])})
    else:
        words = str(payload.pop("text", "") or "").strip()
        note = build_note(kind, event_id, words or describe(kind, payload), payload,
                          cap=None if kind == START_AGENT else BODY_CHARS)
    note["terminal"] = terminal_line(kind, words, payload) if line is None else line
    if kind in QUIET_KINDS:
        if ws is None:
            _keep_held(c, [*held(c), note])
        else:
            event_files.hold(ws, note)
        out.update(delivered=0, held=True)
        log.info("%s: event %s kind=%s held for the next event", c, event_id, kind)
        _observe(c, kind, seen, out)
        return out
    session.expect(c, event_id, thread=out.get("thread"))
    if ws is None:
        out["delivered"] = _publish(c, note)
    else:
        event_files.append(ws, note, render)
        out["delivered"] = 1
        log.info("%s: event %s kind=%s queued for main's watcher", c, event_id, kind)
    _observe(c, kind, seen, out)
    return out


def held_line(note: dict[str, Any]) -> str:
    """A held event as one line under MEANWHILE: its attributes but the id in brackets, then its text on one line."""
    attrs = " ".join(f'{k}="{v}"' for k, v in (note.get("meta") or {}).items() if k != "event")
    return f"[{attrs}] {' '.join(str(note.get('content') or '').split())}"


def _terminal_ws(c: str) -> Path | None:
    """The workspace folder of `c` when its session runs in terminal mode (module note), else None."""
    try:
        ws = config.workspace_path(c)
    except ValueError:
        return None
    return ws if files.terminal(ws) else None


def held(c: str) -> list[dict[str, Any]]:
    """The quiet events waiting for the workspace's next event, as notes (in terminal mode, event_files')."""
    ws = _terminal_ws(c)
    if ws is not None:
        return event_files.held(ws)
    if c not in _held:
        try:
            notes = json.loads((config.workspace_dir(c) / HELD_FILE).read_text("utf-8"))
        except (OSError, ValueError):
            notes = []
        _held[c] = [n for n in notes if isinstance(n, dict)] if isinstance(notes, list) else []
    return list(_held[c])


def _keep_held(c: str, notes: list[dict[str, Any]]) -> None:
    _held[c] = list(notes)
    path = config.workspace_dir(c) / HELD_FILE
    try:
        if notes:
            ledger.atomic_write_text(path, json.dumps(notes, ensure_ascii=False))
        else:
            path.unlink(missing_ok=True)
    except OSError:
        log.warning("%s: the held events were not saved to %s", c, path, exc_info=True)


def pop_held(c: str) -> list[dict[str, Any]]:
    """The quiet events waiting, as notes, and no longer waiting."""
    ws = _terminal_ws(c)
    if ws is not None:
        return event_files.pop_held(ws)
    notes = held(c)
    if notes:
        _keep_held(c, [])
    return notes


def meanwhile(notes: list[dict[str, Any]]) -> str:
    """Held events as MEANWHILE and one line each; '' for none."""
    return "\n".join([MEANWHILE, *(held_line(h) for h in notes)]) if notes else ""


def _joined(notes: list[dict[str, Any]]) -> str:
    """The events' lines in main's terminal, one per line."""
    return "\n".join(str(n.get("terminal") or "") for n in notes if n.get("terminal"))


def _observe(c: str, kind: str, seen: dict[str, Any], out: dict[str, Any]) -> None:
    for fn in list(_observers.get(kind, ())):
        try:
            fn(c, seen, out)
        except Exception:  # noqa: BLE001 — the event is posted; an observer's state is secondary
            log.exception("%s: the %s observer %s failed", c, kind, getattr(fn, "__name__", fn))


def send(c: str, kind: str, text: str, fields: dict[str, Any], *, thread: str | None = None,
         line: str = "") -> dict[str, Any]:
    """Send an event whose body server code built (threads.flush and ask_again), with its `line` in main's terminal:
    {id, kind, delivered}. The caller has logged whatever the chats show, and checked that a session listens."""
    from . import session  # noqa: PLC0415

    event_id = secrets.token_hex(4)
    session.expect(c, event_id, thread=thread)
    note = {**build_note(kind, event_id, text, fields), "terminal": line}
    ws = _terminal_ws(c)
    if ws is not None:
        event_files.append(ws, note, render)
        return {"id": event_id, "kind": kind, "delivered": 1}
    return {"id": event_id, "kind": kind, "delivered": _publish(c, note)}


def show(c: str, line: str) -> None:
    """A line for main's terminal about something the analyst did in the browser that sends main no event (a follow-up
    to the orientation), printed as main's next turn begins (held_route); kept only on the hook route, whose held hook
    runs on every turn. In terminal mode it waits in the event queue for the held hook (event_files.show)."""
    ws = _terminal_ws(c)
    if ws is not None:
        event_files.show(ws, line)
        return
    main = _main_sid(c)
    if main and line and any(sub.session == main and sub.delivery == cc_plugin.HOOK for sub in _subs.get(c, ())):
        _lines.setdefault((c, main), []).append(("", line))


def hand(c: str, event_id: str, text: str, fields: dict[str, Any], *, thread: str) -> str:
    """A thread's event that main gets in a tool's result instead of on a turn of its own (the /thimble:ask command):
    the event as rendered, with the filters. The mirror counts it as an event of main's turn (session.handed)."""
    from . import session  # noqa: PLC0415

    session.handed(c, event_id, thread)
    return render(build_note(THREAD, event_id, text, {**fields, **_filters(c)}))


def _ultracode(c: str) -> dict[str, Any]:
    """`ultracode: true` on a browser message to main while the composer's chip has Ultracode on (for this session, else
    as models.main keeps it): a browser message gets none of the keyword's effect in Claude Code, so main.md asks for the
    Workflow tool itself. A thread event carries nothing."""
    from . import agents, cc_settings, ledger  # noqa: PLC0415

    held = (agents.meta_or_none(c, agents.MAIN_ID) or {}).get("attached") or {}
    choice = held.get("effort_choice")
    if choice is None:
        try:
            choice = ((ledger.stored_settings(c).get(config.MODELS_KEY) or {}).get("main") or {}).get("effort")
        except Exception:  # noqa: BLE001 — a settings file that cannot be read chooses nothing
            choice = None
    return {"ultracode": True} if choice == cc_settings.ULTRACODE else {}


def _filters(c: str) -> dict[str, Any]:
    """The filters set now, on each browser message to main and to a thread (filters.event_attrs), so the model answers
    about what the analyst sees, whoever set a filter last; none when unreadable, since the message matters more."""
    from . import filters  # noqa: PLC0415

    try:
        return filters.event_attrs(c)
    except Exception:  # noqa: BLE001
        log.debug("the filters were not read for %s", c, exc_info=True)
        return {}


def _main_sid(c: str) -> str | None:
    from . import session  # noqa: PLC0415

    lv = session.current(c)
    return lv.sid if lv is not None else None


def _read_main(c: str) -> None:
    """Read main's transcript now, so that a session it continued in is main before an event picks its recipients."""
    from . import session  # noqa: PLC0415

    lv = session.current(c)
    if lv is not None:
        session._read_now(lv)


def _live_subs(c: str, main: str | None) -> list[Sub]:
    """The workspace's subscriptions but those of parked sessions (session._parked), which never get an event."""
    from . import session  # noqa: PLC0415

    def parked(sid: str | None) -> bool:
        return bool(sid) and sid != main and session._parked(c, str(sid))

    return [sub for sub in _subs.get(c, ()) if not parked(sub.session)]


def _awaits_shim(c: str) -> bool:
    """Whether main is a session it continued in less than session.GRACE_S ago (session._continue) whose shim has not
    subscribed yet: its events wait in its queue (_pending) for its watcher's pull."""
    from . import session  # noqa: PLC0415

    lv = session.current(c)
    return (lv is not None and lv.came_from is not None and lv.moved_at is not None
            and time.monotonic() - lv.moved_at < session.GRACE_S
            and not any(sub.session == lv.sid for sub in _subs.get(c, ())))


def _publish(c: str, note: dict[str, Any]) -> int:
    """Queue the event for the watcher of the session that is main when its shim holds a subscription, or of a session
    main just continued in whose shim has not subscribed yet (_awaits_shim); a parked session's subscription, or another
    session's, gets nothing. The analyst's words show on main's statusline until main gets them (_notice). Returns the
    number reached. When the server runs main itself (runtime.py), the event goes to it, with the held ones riding
    along as below."""
    from . import runtime  # noqa: PLC0415

    if runtime.enabled():
        if held(c):
            riders = pop_held(c)
            note = {**note, "content": f"{note.get('content') or ''}\n\n{meanwhile(riders)}"}
        runtime.deliver(c, note)
        log.info("%s: event %s kind=%s delivered to the runtime", c, (note.get("meta") or {}).get("event"),
                 (note.get("meta") or {}).get("kind"))
        return 1
    _read_main(c)
    main = _main_sid(c)
    mine = [sub for sub in _live_subs(c, main) if main and sub.session == main]
    to = main if mine or _awaits_shim(c) else None
    meta = note.get("meta") or {}
    if to is None:
        log.info("%s: event %s kind=%s delivered=0", c, meta.get("event"), meta.get("kind"))
        return 0
    if not mine or any(sub.delivery == cc_plugin.HOOK for sub in mine):
        _notice(c, to, note)
    if held(c):
        riders = pop_held(c)
        note = {**note, "content": f"{note.get('content') or ''}\n\n{meanwhile(riders)}",
                "terminal": _joined([note, *riders])}
    _pending.setdefault((c, to), deque()).append(note)
    _wake(c)
    if mine:
        log.info("%s: event %s kind=%s delivered=1", c, meta.get("event"), meta.get("kind"))
    else:
        log.info("%s: event %s kind=%s waits for session %s's shim", c, meta.get("event"), meta.get("kind"), to)
    return 1


def _notice(c: str, sid: str, note: dict[str, Any]) -> None:
    """Keep the analyst's words of an event that carries them (terminal_line's SAID) for session `sid`'s statusline
    (queued_line); the held hook forgets them once the session gets the event (held_route), and the Monitor route's ack
    does (ack_route). Only main gets events, so the words kept for another session of the workspace, one main was
    before, go."""
    line = str(note.get("terminal") or "")
    if not line.startswith(SAID):
        return
    for key in [k for k in _notices if k[0] == c and k[1] != sid]:
        del _notices[key]
    kept = _notices.setdefault((c, sid), [])
    kept.append((str((note.get("meta") or {}).get("event") or ""), line[len(SAID):]))
    del kept[:-NOTICES_KEPT]


def _wake(c: str) -> None:
    """Wake the workspace's waiting pulls, from any thread."""
    for loop, fut in list(_waiters.get(c, ())):
        if not fut.done():
            loop.call_soon_threadsafe(lambda f=fut: f.done() or f.set_result(None))


def render(note: dict[str, Any]) -> str:
    """An event as the model reads it: `<thimble-event kind="…" event="…" …>`, the body on its own lines, then
    `</thimble-event>` (escaped inside the body)."""
    meta = {str(k): str(v) for k, v in (note.get("meta") or {}).items()}
    attrs = " ".join(f'{k}="{html.escape(v, quote=True)}"' for k, v in meta.items())
    body = str(note.get("content") or "").replace(f"</{TAG}>", f"&lt;/{TAG}&gt;")
    return f"<{TAG} {attrs}>\n{body}\n</{TAG}>"


def _pull_state(c: str, sid: str, pid: int | None = None) -> str | None:
    """Why a watcher for session `sid` should stop: GONE when another session is main and `sid` is not the one /clear
    started in `pid`, DORMANT when it becomes main again once main ends; None to wait."""
    from . import session  # noqa: PLC0415

    main = _main_sid(c)
    if sid and main and main != sid and not session.may_follow(c, sid, pid):
        return DORMANT if session.may_return(c, sid) else GONE
    return None


def _requeue(c: str) -> None:
    """Events taken ACK_S ago and never acknowledged go back to the front of their queues, oldest first."""
    now = time.monotonic()
    stale = sorted(((when, eid) for eid, (cc, _, _, when) in _taken.items() if cc == c and now - when > ACK_S), reverse=True)
    for _, eid in stale:
        cc, key, note, _ = _taken.pop(eid)
        _pending.setdefault((cc, key), deque()).appendleft(note)


def _take(c: str, sid: str) -> tuple[str, dict[str, Any]] | None:
    """(its id, the event) of the next event for session `sid`, from its own queue, else from the queue of a
    subscription that named no session; it waits in flight until acknowledged."""
    for key in dict.fromkeys((sid, "")):
        q = _pending.get((c, key))
        if q:
            note = q.popleft()
            event_id = str((note.get("meta") or {}).get("event") or secrets.token_hex(4))
            _taken[event_id] = (c, key, note, time.monotonic())
            return event_id, note
    return None


def move_events(c: str, old: str, new: str) -> None:
    """Main followed its process from session `old` to `new` (/clear): the events in flight to `old`'s watcher, then those
    queued for it, go to the front of `new`'s queue in the order they were posted."""
    flying = sorted((when, eid) for eid, (cc, key, _, when) in _taken.items() if cc == c and key == old)
    moved = [_taken.pop(eid)[2] for _, eid in flying] + list(_pending.pop((c, old), ()))
    if moved:
        _pending.setdefault((c, new), deque()).extendleft(reversed(moved))
        _wake(c)
    if (c, old) in _notices:
        _notices[(c, new)] = [*_notices.pop((c, old)), *_notices.get((c, new), [])]


def queued_line(c: str, sid: str | None, chars: int = 110) -> str:
    """Main's statusline line for the messages the analyst sent that session `sid` has not got yet (module note): the
    oldest one's words after QUEUED, cut at `chars`, and how many more wait; '' for none, and for a session that is not
    main."""
    if not sid or sid != _main_sid(c):
        return ""
    ws = _terminal_ws(c)
    waiting = event_files.queued_words(ws) if ws is not None else [words for _, words in _notices.get((c, sid), [])]
    if not waiting:
        return ""
    more = f" (and {len(waiting) - 1} more)" if len(waiting) > 1 else ""
    line = f"thimble · {QUEUED if ws is None else QUEUED_TERMINAL}{waiting[0]}"
    room = chars - len(more)
    return (line if len(line) <= room else line[: room - 1].rstrip() + "…") + more


def pending(c: str) -> int:
    """How many events wait for a watcher in the workspace (queued or in flight)."""
    return sum(len(q) for (cc, _), q in _pending.items() if cc == c) + sum(1 for v in _taken.values() if v[0] == c)


# --------------------------------------------------------------------------- routes


class EventBody(BaseModel):
    kind: str
    payload: dict[str, Any] = {}


BROWSER_KINDS = ("main", "thread", "card")  # the kinds the browser posts (events_route); the server posts the others


@router.post("/ws/{c}/events")
async def events_route(c: str, body: EventBody) -> dict[str, Any]:
    """The browser's one way to reach the session: a message to main or a thread, or a card's event (BROWSER_KINDS);
    400 for any other kind, which only the server's own code posts (post)."""
    if body.kind not in BROWSER_KINDS:
        raise HTTPException(400, "the browser sends only main, thread and card events")
    try:
        config.workspace_dir(c)
    except ValueError as e:
        raise HTTPException(404, str(e)) from e
    return post(c, body.kind, body.payload)


class SessionBody(BaseModel):
    session: str
    cwd: str | None = None
    sandbox: bool | None = None  # whether Claude Code's sandbox is on in the session (cli.own_sandbox_here)
    warnings: list[str] = []  # the keys of what /thimble found in the shell (notices.setup_text), never words


@router.post("/ws/{c}/session")
async def session_route(c: str, body: SessionBody) -> dict[str, Any]:
    """`/thimble` names its session (`thimble server up --session`), for a shim that could not tell which one it serves.
    `replaced` names the session that was main and still runs in another terminal, which this one takes over from."""
    from . import session  # noqa: PLC0415

    try:
        corpus = config.corpus_dir(c)
    except ValueError as e:
        raise HTTPException(404, str(e)) from e
    _read_main(c)  # a session main continued in is main already, so naming it takes over from none
    before = session.current(c)
    # a session another terminal runs, whose shim is still subscribed, stops hearing the browser: /thimble says so
    replaced = before.sid if before is not None and before.sid != body.session and listening(c, before.sid) else None
    lv = session.attach(c, body.session, body.cwd or str(corpus))
    if replaced and session._parked(c, replaced):  # it waits parked and is never main again (session.may_return)
        replaced = None
    if lv is not None:
        _setup(c, body)
    return {"attached": bool(lv), "session": body.session, "listening": listening(c), "replaced": replaced}


def _setup(c: str, body: SessionBody) -> None:
    """What /thimble found about main's session: whether Claude Code's sandbox is on in it (main's `attached.sandbox`,
    which Settings shows), and a `setup` notice for each key of `warnings` the server has words for (notices.setup_text),
    with the open ones whose key /thimble no longer names cleared. The words never come from the request."""
    from . import agents, notices  # noqa: PLC0415

    if body.sandbox is not None:
        meta = agents.ensure_main(c)
        held = meta.get("attached") or {}
        if held.get("session") == body.session and held.get("sandbox") is not body.sandbox:
            meta["attached"] = {**held, "sandbox": body.sandbox}
            agents.write_meta(c, meta)
            agents.notify(c, agents.MAIN_ID)
    named = [k for k in dict.fromkeys(str(w) for w in body.warnings) if notices.setup_text(k)]
    for key in named:
        notices.post(c, kind="setup", key=key, text=notices.setup_text(key))
    for n in notices.open_notices(c):
        if n.get("kind") == "setup" and n.get("key") not in named:
            notices.clear(c, str(n.get("key") or ""))


class MainChoice(BaseModel):
    effort: str | None = None
    fast: bool | None = None
    model: str | None = None


MODEL_ID = re.compile(r"claude-[a-z0-9][a-z0-9.-]{1,62}")  # a model id as the API takes it, without a `[1m]` tag


def _choose(c: str, choice: dict[str, Any]) -> None:
    """The composer's choice for main, kept in the workspace's settings as models.main and applied at main's next
    launch (cli.launch_args); on main's `attached` too, as effort_choice and fast_choice, for the chip to show."""
    from . import agents, ledger  # noqa: PLC0415

    try:
        config.corpus_dir(c)
    except ValueError as e:
        raise HTTPException(404, str(e)) from e
    ledger.put_settings(c, {config.MODELS_KEY: {"main": choice}})
    meta = agents.ensure_main(c)
    if meta.get("attached"):
        meta["attached"] = {**meta["attached"], **{f"{k}_choice": v for k, v in choice.items()}}
        agents.write_meta(c, meta)
        agents.notify(c, agents.MAIN_ID)


@router.put("/ws/{c}/session/effort")
async def effort_route(c: str, body: MainChoice) -> dict[str, Any]:
    """The composer's effort chip: main's effort (low to max, or ultracode) from its next launch (_choose)."""
    from . import cc_settings  # noqa: PLC0415

    choice = str(body.effort or "").strip().lower()
    try:
        level = cc_settings.level_of(choice)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    _choose(c, {"effort": choice})
    return {"effort": level, "choice": choice}


@router.put("/ws/{c}/session/model")
async def model_route(c: str, body: MainChoice) -> dict[str, Any]:
    """The composer's model menu: the model main's next turn runs on (_choose; runtime.Space.spec_of reads it at each
    turn). 400 for what is no model id."""
    model = config.base_model(str(body.model or "")).lower()
    if not MODEL_ID.fullmatch(model):
        raise HTTPException(400, "choose a model by its id, such as claude-opus-5-5")
    _choose(c, {"model": model})
    return {"model": model}


@router.put("/ws/{c}/session/fast")
async def fast_route(c: str, body: MainChoice) -> dict[str, Any]:
    """The composer's fast-mode switch: main's fast mode from its next launch (_choose)."""
    _choose(c, {"fast": bool(body.fast)})
    return {"fast": bool(body.fast)}


@router.get("/events")
async def subscribe(request: Request, cwd: str, session: str | None = None, pid: int | None = None,
                    delivery: str = cc_plugin.HOOK, config_dir: str | None = None) -> EventSourceResponse:
    """The shim's subscription, with the route its session hears events by (`delivery`), the pid of its `claude` and that
    session's CLAUDE_CONFIG_DIR ("" for unset): a `ready` event, then only the keep-alive, for as long as the session
    lives (module note). 404 while the folder is not a workspace yet: the shim retries, and `/thimble` registers the
    folder."""
    from . import session as session_mod  # noqa: PLC0415

    c = config.workspace_for_cwd(cwd)
    if not c:
        raise HTTPException(404, f"{cwd} is not a thimble workspace yet; /thimble opens it")
    sub = Sub(session or None, delivery if delivery in cc_plugin.ROUTES else cc_plugin.HOOK)
    _subs.setdefault(c, set()).add(sub)
    session_mod.connected(c, session, cwd, pid, config_dir)
    _wake(c)  # the session may be main now (session.connected): a pull that waits looks again
    from . import extensions  # noqa: PLC0415

    asyncio.get_running_loop().create_task(extensions.connected(c), name=f"extensions-{c}")
    log.info("%s: subscribed (session %s, pid %s, Claude Code %s, %s)", c, session, pid,
             procs.version_of(pid) or "version unknown", sub.delivery)

    async def gen() -> AsyncIterator[dict[str, str]]:
        try:
            yield {"event": "ready", "data": json.dumps({"workspace": c})}
            await asyncio.Event().wait()  # until the shim goes away, which cancels the stream
        finally:
            subs = _subs.get(c)
            if subs is not None:
                subs.discard(sub)
            log.info("%s: unsubscribed (session %s)", c, session)
            session_mod.disconnected(c, session)

    return EventSourceResponse(gen(), ping=PING_S, sep="\n")


async def _wait(c: str, timeout: float) -> None:
    """Wait up to `timeout` for _wake(c)."""
    loop = asyncio.get_running_loop()
    fut: asyncio.Future = loop.create_future()
    entry = (loop, fut)
    _waiters.setdefault(c, set()).add(entry)
    try:
        await asyncio.wait_for(fut, timeout)
    except asyncio.TimeoutError:
        pass
    finally:
        _waiters.get(c, set()).discard(entry)


def _stopping() -> bool:
    """Whether the server has begun to stop (session._shutting_down), so a long poll answers at once rather than holding the
    stop until uvicorn cancels it."""
    from . import session  # noqa: PLC0415 — session imports this module

    return session._shutting_down()


@router.get("/events/pull")
async def pull_route(request: Request, cwd: str, session: str | None = None, wait: float = PULL_WAIT_S,
                     pid: int | None = None) -> Any:
    """The watcher's long poll: `{id, text}` for the next event of the session, 204 when none came within `wait` seconds, 404
    when the folder is no workspace, 410 when another session is main (see _pull_state). The event stays in flight until
    the watcher acknowledges it (ack_route)."""
    c = config.workspace_for_cwd(cwd)
    if not c:
        raise HTTPException(404, f"{cwd} is not a thimble workspace")
    sid = session or ""
    deadline = time.monotonic() + min(max(wait, 0.0), PULL_WAIT_MAX_S)
    while True:
        _requeue(c)
        state = _pull_state(c, sid, pid)
        if state == GONE:
            raise HTTPException(410, "another session is main in this workspace now")
        if await request.is_disconnected() or _stopping():  # the watcher asks the next server
            return Response(status_code=204)
        taken = _take(c, sid) if state is None else None
        if taken is not None:
            return {"id": taken[0], "text": render(taken[1])}
        left = deadline - time.monotonic()
        if left <= 0:
            return Response(status_code=204)
        await _wait(c, min(left, PULL_TICK_S))


class AckBody(BaseModel):
    cwd: str
    session: str | None = None
    id: str
    terminal: bool = False  # the hook's watcher: the UserPromptSubmit hook prints the event's line (module note)


@router.post("/events/ack")
async def ack_route(body: AckBody) -> dict[str, Any]:
    """The watcher wrote the event out: it leaves the flight. 404 when it is not in flight."""
    taken = _taken.pop(body.id, None)
    if taken is None:
        raise HTTPException(404, "no such event is in flight")
    key = (taken[0], body.session or "")
    if body.terminal and taken[2].get("terminal"):
        _lines.setdefault(key, []).append((body.id, str(taken[2]["terminal"])))
    elif key in _notices:  # the Monitor route: no held hook prints its line, so the statusline lets it go now
        _notices[key] = [n for n in _notices[key] if n[0] != body.id]
    return {"acknowledged": body.id}


class HeldBody(BaseModel):
    cwd: str
    session: str | None = None


@router.post("/events/held")
async def held_route(body: HeldBody) -> dict[str, Any]:
    """The UserPromptSubmit hook, as a turn of main's begins (a prompt typed in the terminal, or an event the watcher
    wrote out): `{text, terminal}`, the quiet events waiting as MEANWHILE, which the hook adds to the prompt ('' when
    none wait or `session` is not main), and the lines main's terminal shows of the events the session's watcher wrote
    out and of those quiet events, which it prints, each line once. An event printed here no longer shows on the
    statusline (queued_line). 404 when the folder is no workspace."""
    c = config.workspace_for_cwd(body.cwd)
    if not c:
        raise HTTPException(404, f"{body.cwd} is not a thimble workspace")
    main = _main_sid(c)
    key = (c, body.session or "")
    riders = pop_held(c) if main and body.session == main else []
    written = _lines.pop(key, [])
    shown = {event_id for event_id, _ in written if event_id}
    if shown and key in _notices:
        _notices[key] = [n for n in _notices[key] if n[0] not in shown]
    lines = [*(line for _, line in written), _joined(riders)]
    return {"text": meanwhile(riders), "terminal": "\n".join(dict.fromkeys(x for x in lines if x))}


class ModeBody(BaseModel):
    cwd: str
    session: str | None = None
    permission_mode: str = ""


@router.post("/events/mode")
async def mode_route(body: ModeBody) -> dict[str, Any]:
    """The mode hook, as a turn of main's begins and ends: the permission mode Claude Code reports for the session,
    which main's meta keeps when the session is main (session.note_mode). `terminal` is the line the hook shows in
    main's terminal the first time main reports Manual mode in a session (modes.manual_line). 404 when the folder is no
    workspace."""
    from . import session  # noqa: PLC0415

    c = config.workspace_for_cwd(body.cwd)
    if not c:
        raise HTTPException(404, f"{body.cwd} is not a thimble workspace")
    line = session.note_mode(c, body.session, body.permission_mode, tell=True)
    return {"terminal": line} if line else {}


@router.get("/events/main")
async def main_route(cwd: str, pid: int | None = None) -> dict[str, Any]:
    """`{workspace, main}`: whether `pid`, a `claude` process, runs the session that is main in the folder's workspace. The
    SessionStart hook asks before it gives main its prompt again after /clear or /compact. 404 when the folder is no
    workspace."""
    from . import session  # noqa: PLC0415

    c = config.workspace_for_cwd(cwd)
    if not c:
        raise HTTPException(404, f"{cwd} is not a thimble workspace")
    return {"workspace": c, "main": bool(pid) and session.main_pid(c) == pid}


@router.get("/events/sessions")
async def sessions_route() -> dict[str, Any]:
    """`thimble list` and `thimble purge`: `{workspaces: {<c>: [session…]}, data_dir, workspaces_dir}`, the sessions whose
    shims hold a subscription, per workspace, and the folders the server works on."""
    return {"workspaces": {c: subscribed_sessions(c) for c, subs in _subs.items() if subs},
            "data_dir": str(config.DATA_DIR.resolve()), "workspaces_dir": str(config.WORKSPACES_DIR.resolve())}


def _asking_chat(c: str, agent: str | None) -> str | None:
    """The chat of the subagent or fork `agent` of main's session (a thread whose fork it is, or a subagent's chat),
    so the browser can mark the thread that waits; for one of thimble's agents or a descendant that no chat names yet,
    the chat subagents.json gives it or its nearest ancestor (_registry_chat); None for main or an agent no chat
    follows."""
    from . import agents  # noqa: PLC0415

    if not agent:
        return None
    for meta in agents.list_chats(c):
        if (meta.get("fork") or {}).get("agent_id") == agent or meta.get("agent_id") == agent:
            return str(meta["id"])
    return _registry_chat(c, agent)


def _registry_chat(c: str, agent: str) -> str | None:
    """The chat subagents.json records for `agent`, else for the agent it descends from that is nearest to it (a
    helper of the orientation's whose own chat the mirror has not made yet asks for the orientation); None for an agent
    the registry does not hold."""
    from . import subagents  # noqa: PLC0415

    seen: set[str] = set()
    at: str | None = agent
    try:
        while at and at not in seen:
            seen.add(at)
            rec = subagents.agent(c, at) or {}
            if rec.get("chat"):
                return str(rec["chat"])
            at = str(rec.get("parent") or "") or None
    except Exception:  # noqa: BLE001 — a registry that cannot be read names no chat
        return None
    return None


def _thimble_agent(c: str, agent: str | None) -> bool:
    """Whether `agent` is one of thimble's agents or a descendant of one (subagents.json)."""
    if not agent:
        return False
    from . import subagents  # noqa: PLC0415

    try:
        return subagents.agent(c, agent) is not None
    except Exception:  # noqa: BLE001
        return False


def _main_offer(suggestions: Any, preview: str, tool: str) -> list[dict[str, Any]]:
    """What the card's "Always allow" adds to a relayed request of main's session for `tool` (module note): its
    permission_suggestions as Claude Code gave them, as far as Claude Code's own dialog for the tool applies them
    (permission_updates.main_offer); [] when it suggests none, when the card shows only the start of the request (as
    for every card's "don't ask again"), or when the org's managed tier sets allowManagedPermissionRulesOnly, under
    which Claude Code ignores the rules a session saves."""
    updates = permission_updates.main_offer(suggestions, tool)
    if not updates or len(preview) > PERMISSION_INPUT_CHARS:
        return []
    return [] if cc_plugin.managed_rules_only({config.CONFIG_DIR_ENV: str(config.claude_config_dir())}) else updates


def _hold(c: str, request_id: str, tool: str, what: str, preview: str, agent: str | None = None,
          tool_input: Any = None, terminal: bool = False, offer: list[dict[str, Any]] | None = None,
          cwd: str = "") -> None:
    """Put a relayed permission request on main's meta, where the browser shows it; `chat` names the thread or subagent
    chat whose agent asked, when the hook said which (_asking_chat), and `terminal` says the terminal answers it, so the
    card shows it without buttons. `tool_input` is the call's input, which the card shows as `preview`. An `offer`
    (_main_offer) is the card's "don't ask again": `always` names what it adds (permission_updates.offer_text), and
    `always_label` and `always_tip` are its button and tooltip, in the words of Claude Code's own dialog for the
    session in `cwd`, the tooltip with where Claude Code keeps it (permission_updates.main_words)."""
    from . import agents  # noqa: PLC0415

    meta = agents.ensure_main(c)
    pending = [p for p in meta.get("permissions") or [] if isinstance(p, dict) and p.get("id") != request_id]
    chat = _asking_chat(c, agent)
    entry = {"id": request_id, "tool": tool, "what": what or tool, "input": preview[:PERMISSION_INPUT_CHARS],
             "since": _now(), **({"cut": len(preview)} if len(preview) > PERMISSION_INPUT_CHARS else {}),
             **({"chat": chat} if chat else {}), **({"terminal": True} if terminal else {}),
             **({"always": permission_updates.offer_text(offer), **permission_updates.main_words(offer, cwd)}
                if offer else {})}
    pending.append(entry)
    meta["permissions"] = pending
    agents.write_meta(c, meta)
    agents.notify(c, agents.MAIN_ID)
    agents.log_permission(c, "asked", **{"chat": agents.MAIN_ID, **entry})


GONE_ANSWER = "none: answered in the terminal, or the session moved on"  # the permission log's word for a dropped request


def _drop(c: str, ids: set[str] | None = None, keep: set[str] | frozenset[str] = frozenset(),
          answer: str | None = GONE_ANSWER) -> None:
    """Take relayed permission requests off main's meta: those named, or all of them but those in `keep`; each is
    logged with `answer` (agents.log_permission) unless it is None."""
    from . import agents  # noqa: PLC0415

    meta = agents.meta_or_none(c, agents.MAIN_ID)
    held = [p for p in (meta or {}).get("permissions") or [] if isinstance(p, dict)]
    left = [p for p in held if p.get("id") in keep or (ids is not None and p.get("id") not in ids)]
    if meta and len(left) != len(held):
        meta["permissions"] = left
        agents.write_meta(c, meta)
        agents.notify(c, agents.MAIN_ID)
        for p in held:
            if answer and p not in left:
                agents.log_permission(c, "answered", id=p.get("id"), chat=agents.MAIN_ID, answer=answer)


class HookPermission(BaseModel):
    cwd: str
    session: str | None = None
    tool_name: str = ""
    tool_input: Any = None
    agent_id: str | None = None
    suggestions: Any = None  # the request's permission_suggestions, the card's "Always allow" (_main_offer)


class Ask(NamedTuple):
    """A prompt the PermissionRequest hook relayed, waiting for the analyst."""

    c: str
    loop: asyncio.AbstractEventLoop
    fut: asyncio.Future
    since: float  # time.monotonic() when it opened, for release_asks
    at: float = 0.0  # time.time() when it opened, compared with the agent's transcript timestamps (calls_done)
    agent: str | None = None  # the subagent or fork that asked; None for main
    call: tuple[str, str] = ("", "")  # the call it asks about (call_key), which calls_done matches to its result


@router.post("/events/permission")
async def hook_permission_route(request: Request, body: HookPermission) -> dict[str, Any]:
    """The PermissionRequest hook relays a prompt of main's session: it waits on main's meta until the analyst answers,
    `{id, behavior: allow | deny}`, with `updatedPermissions`, what the card's "Always allow" named, when the analyst
    chose it (_main_offer), or the prompt or hook goes away, `{id, behavior: null}`. A prompt of one of
    thimble's agents (or a descendant) is answered `null` at once, since Claude Code shows no dialog while a hook holds
    a background subagent's request (U6b): it shows on the card without buttons (`terminal`), and the terminal answers
    it; the card goes with the call's result or the agent's end. 404 when the folder is no workspace, 409 when the
    session is not main."""
    c = config.workspace_for_cwd(body.cwd)
    if not c:
        raise HTTPException(404, f"{body.cwd} is not a thimble workspace")
    sid = body.session or ""
    main = _main_sid(c)
    if not main or (sid and sid != main):
        raise HTTPException(409, "this session's prompts are not relayed here")
    inp = body.tool_input if isinstance(body.tool_input, dict) else {}
    what = str(inp.get("description") or "").strip() or body.tool_name
    preview = json.dumps(body.tool_input, ensure_ascii=False) if body.tool_input is not None else ""
    request_id = HOOK_ASK_PREFIX + secrets.token_hex(4)
    loop = asyncio.get_running_loop()
    if _thimble_agent(c, body.agent_id):
        _terminal[request_id] = Ask(c, loop, loop.create_future(), time.monotonic(), time.time(), body.agent_id,
                                    call_key(body.tool_name, body.tool_input))
        _hold(c, request_id, body.tool_name, what, preview, body.agent_id, body.tool_input, terminal=True)
        return {"id": request_id, "behavior": None}
    fut: asyncio.Future = loop.create_future()
    _asks[request_id] = Ask(c, loop, fut, time.monotonic(), time.time(), body.agent_id or None,
                            call_key(body.tool_name, body.tool_input))
    offer = _main_offer(body.suggestions, preview, body.tool_name)
    if offer:
        _offers[request_id] = offer
    _hold(c, request_id, body.tool_name, what, preview, body.agent_id or None, body.tool_input, offer=offer,
          cwd=body.cwd)
    try:
        while not fut.done():
            try:
                await asyncio.wait_for(asyncio.shield(fut), PULL_TICK_S)
            except asyncio.TimeoutError:
                if await request.is_disconnected() or _stopping():  # Claude Code's own prompt stays open
                    break
    finally:
        _asks.pop(request_id, None)
        _offers.pop(request_id, None)
        if not fut.done():
            _drop(c, {request_id})  # the hook went away: Claude Code decided without it
    return {"id": request_id, **(fut.result() if fut.done() else {"behavior": None})}


def _answer_ask(request_id: str, behavior: str | None, updates: list[dict[str, Any]] | None = None) -> bool:
    """End a hook's wait with the analyst's answer, or with none, and with the "Always allow" `updates` the analyst
    chose; False when no hook waits on that request. An agent's prompt the analyst answered here is remembered
    (_answered), so its call's result ends no other prompt."""
    held = _asks.pop(request_id, None)
    if held is None:
        return False
    if behavior is not None:
        _answered.setdefault((held.c, held.agent or ""), []).append(held.call)
    fut = held.fut
    answer = {"behavior": behavior, **({"updatedPermissions": updates} if updates else {})}
    held.loop.call_soon_threadsafe(lambda: fut.done() or fut.set_result(answer))
    return True


class PermissionAnswer(BaseModel):
    id: str
    allow: bool
    always: bool = False  # the card's "Always allow": also what it named (_offers)


@router.post("/ws/{c}/permission")
async def permission_route(c: str, body: PermissionAnswer, request: Request) -> dict[str, Any]:
    """The analyst's answer to a relayed permission prompt of main's: it goes to the waiting hook, and the request leaves
    the card. With `always`, an allow also adds what the card's "Always allow" named, exactly (_offers); a request
    that offers none is allowed once. 403 for a request that is not the analyst's browser's (hook_auth.analyst), 404
    when no such request waits."""
    from . import agents, hook_auth  # noqa: PLC0415

    if not hook_auth.analyst(request):
        raise HTTPException(403, hook_auth.ANALYST_ONLY)

    meta = agents.ensure_main(c)
    pending = [p for p in meta.get("permissions") or [] if isinstance(p, dict)]
    if not any(p.get("id") == body.id for p in pending):
        raise HTTPException(404, "no such permission request is waiting")
    behavior = "allow" if body.allow else "deny"
    chosen = _offers.get(body.id) if body.allow and body.always else None
    said = f"allow, don't ask again: {permission_updates.offer_text(chosen)}" if chosen else behavior
    _drop(c, {body.id}, answer=said)
    _answer_ask(body.id, behavior, chosen)
    return {"answered": body.id, "allow": body.allow}


def clear_permissions(c: str) -> None:
    """Main's session is no longer waiting on a prompt of its own: end the hooks of main's own requests and drop them,
    and any a previous server's hook left. A subagent's or fork's request stays, as agent_moved ends it, and so does a
    prompt of thimble's agents that the terminal asks (_terminal), which ends as terminal_dialogs, calls_done or
    agent_moved says."""
    agents_asking = {i for i, a in (*_asks.items(), *_terminal.items()) if a.c == c and a.agent}
    for request_id in [i for i, a in _asks.items() if a.c == c and not a.agent]:
        _answer_ask(request_id, None)
    _drop(c, keep=agents_asking)


def release_asks(c: str, older_than: float) -> None:
    """End the waits of main's hook-relayed requests older than `older_than` seconds and take them off main's meta, since a
    prompt answered in the terminal before the tail saw the wait never shows as a change."""
    now = time.monotonic()
    gone = {i for i, a in _asks.items() if a.c == c and not a.agent and now - a.since > older_than}
    for request_id in gone:
        _answer_ask(request_id, None)
    if gone:
        _drop(c, gone)


def asking(c: str) -> set[str]:
    """The subagents and forks whose hook-relayed prompts wait in the workspace, the terminal's included."""
    return {a.agent for a in (*_asks.values(), *_terminal.values()) if a.c == c and a.agent}


def _end_terminal(c: str, gone: set[str]) -> None:
    for request_id in gone:
        _terminal.pop(request_id, None)
        _seen_open.discard(request_id)
    if gone:
        _drop(c, gone)


# how long Claude Code's record of main's session must say no dialog is open before the prompts of thimble's agents seen
# open are taken as answered (terminal_dialogs): a record that changes between two dialogs of a queue for a moment
# ends none of them
TERMINAL_CLOSED_S = 1.0


def terminal_dialogs(c: str, open_: bool) -> None:
    """What Claude Code's record of main's session says as the mirror reads it (session._watch_wait): whether a dialog
    is open in the terminal (`open_`), where Claude Code asks every prompt of thimble's agents. Each of their prompts
    open while the record says one is is marked seen; once the record has said for TERMINAL_CLOSED_S that none is, the
    analyst has answered every one, so the seen ones end and the browser stops showing their agents as waiting, though a
    call the analyst allowed may run long before its result ends the prompt (calls_done). A prompt never seen while a
    dialog was open waits for its call's result or its agent's end, since a record read just after the prompt opened
    may not show its dialog yet."""
    mine = {i for i, a in _terminal.items() if a.c == c}
    if open_:
        _closed_since.pop(c, None)
        _seen_open.update(mine)
        return
    since = _closed_since.setdefault(c, time.monotonic())
    if time.monotonic() - since >= TERMINAL_CLOSED_S:
        _end_terminal(c, mine & _seen_open)


# (workspace, agent, '' for main) -> the call_keys of its prompts the analyst answered here whose results have not come
# yet
_answered: dict[tuple[str, str], list[tuple[str, str]]] = {}
# the input field that names a call of each tool, compared when a prompt is matched to its call's result (call_key)
CALL_FIELDS = {"Bash": "command", "Monitor": "command", "WebFetch": "url", "WebSearch": "query", "Read": "file_path",
               "Write": "file_path", "Edit": "file_path", "NotebookEdit": "notebook_path", "Glob": "pattern",
               "Grep": "pattern"}


def call_key(tool: str, tool_input: Any) -> tuple[str, str]:
    """A call as a prompt and its transcript line both name it: the tool and the field that names the call
    (CALL_FIELDS), or the whole input, with runs of white space made one."""
    inp = tool_input if isinstance(tool_input, dict) else {}
    field = CALL_FIELDS.get(tool)
    value = inp.get(field) if field else None
    text = value if isinstance(value, str) else json.dumps(inp, sort_keys=True, ensure_ascii=False)
    return str(tool or ""), " ".join(text.split())


def agent_moved(c: str, agent: str, after: float) -> None:
    """The subagent or fork `agent` stopped (`after` infinite), or wrote a record at `after`: the prompts it opened
    before then are gone, so their hooks' waits end. The mirror calls it when an agent stops, and subagents.run_ended
    when a run of one of thimble's agents ends (a Stop of one whose prompt was open); a prompt of a working
    agent ends with its call's result (calls_done), since an agent with several calls open goes on writing while
    their prompts wait."""
    gone = {i for i, a in _asks.items() if a.c == c and a.agent == agent and a.at < after}
    for request_id in gone:
        _answer_ask(request_id, None)
    if gone:
        _drop(c, gone)
    _end_terminal(c, {i for i, a in _terminal.items() if a.c == c and a.agent == agent and a.at < after})


def calls_done(c: str, agent: str | None, done: "list[tuple[tuple[str, str], float]]") -> None:
    """Calls of the subagent or fork `agent`, or of main when it is None, got their results (each call_key with the
    result's time): the prompt each one waited on was answered, in the terminal or here, so its hook's wait ends and
    the browser drops its card. A call is matched to the prompt with its call_key, else, for a subagent's call of a tool
    whose key is its whole input (no CALL_FIELDS entry, so a field the prompt and the call do not share can tell them
    apart), to the one prompt of its tool that agent has open; any other prompt stays. A call of a tool CALL_FIELDS
    names that matches no prompt is one the agent made without a prompt, such as an `ls` beside a prompted `wc -l`."""
    gone: set[str] = set()
    answered = _answered.get((c, agent or ""), [])
    for key, at in done:
        if key in answered:
            answered.remove(key)  # the prompt the analyst answered in the browser, gone already
            continue
        open_ = sorted(((i, a) for i, a in _asks.items() if a.c == c and a.agent == agent and i not in gone
                        and a.call[0] == key[0] and a.at <= at), key=lambda x: x[1].at)
        hit = next((i for i, a in open_ if a.call == key), None)
        if hit is None and len(open_) == 1 and agent is not None and key[0] not in CALL_FIELDS:
            hit = open_[0][0]  # main's prompts and calls carry the same input
        if hit is not None:
            gone.add(hit)
    for request_id in gone:
        _answer_ask(request_id, None)
    if gone:
        _drop(c, gone)
    if agent is not None:  # a call of one of thimble's agents ran: the terminal answered its prompt
        keys = {key for key, _ in done}
        _end_terminal(c, {i for i, a in _terminal.items() if a.c == c and a.agent == agent and a.call in keys})


def _now() -> str:
    """A relayed request's time, as the sessions' requests stamp theirs (session._now), which the card orders them by."""
    from datetime import datetime, timezone  # noqa: PLC0415

    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


async def shutdown() -> None:
    _subs.clear()
    _pending.clear()
    _taken.clear()
    _lines.clear()
    _notices.clear()
    for request_id in list(_asks):
        _answer_ask(request_id, None)
    _answered.clear()
    _terminal.clear()
    _seen_open.clear()
    _closed_since.clear()
