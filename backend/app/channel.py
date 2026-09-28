"""The channel: how the browser reaches the analyst's Claude Code session.

The `thimble` launcher starts the session with the plugin loaded as a development channel and main's prompt appended
(session_prompt). The plugin's MCP shim declares Claude Code's `claude/channel` capability and holds one SSE
subscription here, `GET /api/channel`; each event posted for the workspace becomes a `notifications/claude/channel`,
which the model sees as `<channel source="plugin:thimble:thimble" kind="…" …>body</channel>`.

The browser posts `POST /api/ws/{c}/events {kind, payload}`; server code calls post(). A kind is a bullet of main.md's
`## Events from the browser`, and other kinds are refused. A post with no subscriber is refused with 409. Claude Code
picks up a changed settings file only once it has been still for about a second, so an event within SETTINGS_SETTLE_S of
a chip change waits out the rest. An event of QUIET_KINDS asks main for nothing, so it wakes no turn: it waits in the
workspace's HELD_FILE and rides along, under MEANWHILE, with the next event or the analyst's next prompt in the terminal
(the plugin's UserPromptSubmit hook takes it with held_route).

Without channels, events are queued per workspace and session (_pending) and the plugin's watcher takes them with a long
poll (pull_route) as the text a channel would have shown (render); unacknowledged events return to the queue after
ACK_S. Permission prompts on the hook route come from the PermissionRequest hook; since Claude Code does not signal that
hook when the analyst answers in the terminal, the server ends the wait itself (clear_permissions, release_asks,
agent_moved).

Main's terminal shows each event as one line (terminal_line): the analyst's words after SAID, with the thread or button
they belong to, else a short line saying what happened. On the channel route Claude Code shows the start of the body
itself. On the hook route it shows only the watcher's fixed summary, so the watcher's acknowledgment keeps the event's
line (_lines) for the UserPromptSubmit hook, which Claude Code runs as the event's turn begins, to print (held_route);
the line of something the analyst did that sends main no event, such as a follow-up to the orientation, waits there
too (show). With every hook off (the Monitor route) nothing can print them.
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
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, AsyncIterator, Callable, NamedTuple

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel
from sse_starlette import EventSourceResponse

from . import cc_channel, config, ledger, procs, prompts

log = logging.getLogger("thimble.channel")


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
ATTR_CHARS = 120  # a payload value longer than this, or with a newline, goes into the body instead of an attribute
BODY_CHARS = 12_000  # the event body's ceiling: an event stays in main's context for the rest of the session
PING_S = 15  # the stream's keep-alive, so a proxy or the shim's read timeout never drops an idle subscription
NOT_LISTENING = ("no Claude Code session is listening in {cwd}. Start thimble with `thimble` in that folder, or say "
                 "/thimble in a Claude Code session there.")
PERMISSION_EVENT = "permission"  # the stream's event carrying the analyst's answer to a relayed permission prompt
PERMISSION_INPUT_CHARS = 50_000  # of a relayed request's input shown in the browser; past it the entry's `cut` says so
SETTINGS_SETTLE_S = 1.8  # Claude Code's settings watcher: 1 s still, 0.5 s polls, and a margin (module note)
SOURCE = cc_channel.SOURCE  # the `source` Claude Code gives the plugin server's channel events; render uses it too
PULL_WAIT_S = 25.0  # a pull's longest wait (module note); the watcher asks again
PULL_WAIT_MAX_S = 60.0
PULL_TICK_S = 1.0  # a waiting pull looks at its client and the events in flight this often
ACK_S = 15.0  # an event taken and not acknowledged within this goes back to the front of its queue
GONE = "gone"  # _pull_state: another session is main now
DORMANT = "dormant"  # _pull_state: another session is main now, and this one is main again when that one ends
HOOK_ASK_PREFIX = "h"  # the ids of the permission requests the PermissionRequest hook relays
SAID = "› "  # opens the analyst's own words in main's terminal (terminal_line)
LINE_CHARS = 160  # of an event's line in main's terminal: about two lines
_KEY_RE = re.compile(r"[^A-Za-z0-9_]")
_KIND_RE = re.compile(r"^- `([a-z_]+)`", re.M)

_subs: dict[str, set[asyncio.Queue]] = {}  # workspace -> the queues of its live subscriptions
_routes: dict[asyncio.Queue, tuple[str | None, str]] = {}  # a subscription's queue -> (its session, its delivery)
_pending: dict[tuple[str, str], deque] = {}  # (workspace, session or "") -> events waiting for a watcher (module note)
_taken: dict[str, tuple[str, str, dict[str, Any], float]] = {}  # event id -> (workspace, session, note, when taken)
_waiters: dict[str, set[tuple[asyncio.AbstractEventLoop, asyncio.Future]]] = {}  # workspace -> its waiting pulls
_asks: dict[str, "Ask"] = {}  # hook permission id -> the request waiting for the analyst
_lines: dict[tuple[str, str], list[str]] = {}  # (workspace, session) -> lines of events its watcher wrote out, to print
_settings_written: dict[str, float] = {}  # workspace -> when the chip last wrote the folder's local settings (monotonic)
_observers: dict[str, list[Callable[[str, dict[str, Any], dict[str, Any]], None]]] = {}  # kind -> observe()'s functions


# --------------------------------------------------------------------------- the prompt and the kinds


def kinds() -> list[str]:
    """The event kinds: the backticked words that open the bullets of main.md's events section, read fresh."""
    return _KIND_RE.findall(prompts.section(PROMPT, EVENTS_SECTION))


def session_prompt(workdir: str, terminal: bool | None = None) -> str:
    """Main's system-prompt append, as the launcher passes it with --append-system-prompt. Claude Code cuts MCP server
    instructions at 2 KB, so this text cannot travel as the shim's instructions, while an append reaches main and every
    fork of it whole. `terminal` picks the ending of a turn (render_prompts)."""
    return render_prompts(SESSION_PROMPTS, workdir, terminal)


def render_prompts(names: tuple[str, ...] | list[str], workdir: str, terminal: bool | None = None) -> str:
    """Prompt files for a session in `workdir`, rendered and joined by a blank line, with the corpus root and the citation
    forms of the folder's views filled in. Main's append and the shared skill's command both come from here. Main's
    prompt keeps one ending of a turn with nothing for the analyst (terminal_tools.main_prompt): without closing words
    when `terminal`, or when it is None and this process's environment says so (terminal_tools.on)."""
    from . import terminal_tools, views  # noqa: PLC0415 — views imports refs, which a launcher does not otherwise need

    c = config.workspace_for_cwd(workdir)
    forms = views.forms_text(c) if c else ""
    values = {"workdir": str(workdir), "forms": forms}
    parts = []
    for name in names:
        part = prompts.render(name, values).strip()
        if name == PROMPT:
            part = terminal_tools.main_prompt(part, terminal_tools.on() if terminal is None else terminal)
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
    subs = _subs.get(c) or set()
    if sid is None:
        return bool(subs)
    return any(_route(q)[0] in (sid, None) for q in subs)


def subscribed_sessions(c: str) -> list[str]:
    """The sessions whose shims hold a subscription for the workspace, as they named themselves ('' for none)."""
    return [str(_route(q)[0] or "") for q in _subs.get(c, ())]


def reachable(c: str) -> bool:
    """Whether an event posted now reaches a session: a channel's subscription, or one of the session that is main.
    Another `claude` in the folder subscribes on the hook route too, and never gets main's events (_publish)."""
    main = _main_sid(c)
    return any(_route(q)[1] == cc_channel.CHANNEL or (main and _route(q)[0] == main) for q in _subs.get(c, ()))


def _attr_key(key: str) -> str:
    return _KEY_RE.sub("_", str(key)).strip("_")


def notification(kind: str, event_id: str, text: str, fields: dict[str, Any]) -> dict[str, Any]:
    """{content, meta} of one channel notification: `kind` and `event` (its id) first, then each field as an attribute when
    it is a short scalar, else as a `<key>: <value>` line under the text. The id is `event`, never `id`, so that no
    attribute a prompt names by its role reads as "the id"."""
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
    if len(body) > BODY_CHARS:
        body = body[:BODY_CHARS].rstrip() + "\n…"
    return {"content": body, "meta": meta}


START_OUTPUTS = {"final": "final notebook", "views": "views", "report": "report"}  # orientation.start_passes, in words
# the kinds that say something ended and ask main for nothing: each waits and rides along with the next event, under
# MEANWHILE (prompts/main.md)
QUIET_KINDS = frozenset({"orient", "written", "labeled", "view"})
MEANWHILE = "meanwhile:"
HELD_FILE = "held-events.json"  # in the workspace: the quiet events waiting, as notifications, across restarts
_held: dict[str, list[dict[str, Any]]] = {}  # workspace -> HELD_FILE's notifications, once read


def describe(kind: str, payload: dict[str, Any]) -> str:
    """The body of an event that carries no text of its own: one line saying what the analyst did. Claude Code shows the
    terminal only an event's body, so this line is what the terminal shows of a Start or a Write."""
    if kind == "start":
        from . import orientation  # noqa: PLC0415

        on = [START_OUTPUTS.get(p, p) for p in orientation.start_passes(payload)]
        return "Start the orientation" + (f" ({', '.join(on)})" if on else "")
    if kind == "write":
        doc = str(payload.get("doc") or "").strip()
        return f"Write the {doc}" if doc else "Write the document"
    return f"The analyst sent `{kind}` from the browser"


def terminal_line(kind: str, words: str, fields: dict[str, Any]) -> str:
    """An event's line in main's terminal (module note): the analyst's `words` after SAID, else a short line saying what
    happened, on one line and cut at LINE_CHARS."""
    words = " ".join(str(words or "").split())
    if kind in (MAIN, "card"):
        line = SAID + words
    elif kind == THREAD:
        line = f"{SAID}thread {fields.get('name') or ''}: {words}"
    elif kind in ("start", "write"):
        line = SAID + describe(kind, fields) + (f": {words}" if words else "")
    elif kind == "labeled":
        line = f"label {fields.get('what') or 'defined'}: {fields.get('name') or ''}"
    elif kind == "view":
        line = f"view built: {fields.get('view') or ''}"
    elif kind == "written":
        line = f"the {fields.get('doc') or 'document'} writer ended"
    elif kind == "checked":
        line = f"a check of the {fields.get('doc') or 'document'} ended"
    elif kind == "agent":
        line = f"agent: {fields.get('name') or ''}"
    else:
        line = words
    return line if len(line) <= LINE_CHARS else line[: LINE_CHARS - 1].rsplit(" ", 1)[0] + "…"


def post(c: str, kind: str, payload: dict[str, Any] | None = None, *, check_kind: bool = True,
         mirror: bool = True, line: str | None = None) -> dict[str, Any]:
    """Send one event to the workspace's session: {id, kind, delivered, thread?}. A `main` event shows in main's chat
    as the analyst's line unless `mirror` is False, for a request server code writes to main, which passes the `line`
    main's terminal shows instead of terminal_line's. 409 when no session listens, 400 for a kind main.md names no
    bullet for (when `check_kind`), or for a message with no text."""
    from . import agents, session, threads  # noqa: PLC0415

    kind = str(kind or "").strip()
    payload = dict(payload or {})
    if check_kind and kind not in kinds():
        raise HTTPException(400, f"unknown event kind {kind!r}; the kinds are {', '.join(kinds())} (prompts/{PROMPT}.md)")
    if not reachable(c):
        raise HTTPException(409, NOT_LISTENING.format(cwd=config.corpus_dir(c)))
    event_id = secrets.token_hex(4)
    out: dict[str, Any] = {"id": event_id, "kind": kind}
    seen = dict(payload)  # what an observer reads, before the builders below take their keys out
    if kind == MAIN:
        words = str(payload.pop("text", "") or "").strip()
        if not words:
            raise HTTPException(400, "empty message")
        if mirror:
            agents.mirror(c, "user", by=agents.BROWSER, text=words, event=event_id)
        note = notification(kind, event_id, words, {**payload, **_ultracode(c), **_filters(c)})
    elif kind == THREAD:
        words = str(payload.get("text") or "")
        built = threads.event(c, payload, event_id)
        if built is None:  # it waits for the thread's fork, which gets it once known (threads.flush)
            return {**out, "thread": str(payload.get("thread") or ""), "delivered": 0, "queued": True}
        text, payload, thread_id = built
        note = notification(kind, event_id, text, {**payload, **_filters(c)})
        out["thread"] = thread_id
    else:
        words = str(payload.pop("text", "") or "").strip()
        note = notification(kind, event_id, words or describe(kind, payload), payload)
    note["terminal"] = terminal_line(kind, words, payload) if line is None else line
    if kind in QUIET_KINDS:
        _keep_held(c, [*held(c), note])
        out.update(delivered=0, held=True)
        log.info("%s: event %s kind=%s held for the next event", c, event_id, kind)
        _observe(c, kind, seen, out)
        return out
    session.expect(c, event_id, thread=out.get("thread"))
    out["delivered"] = _publish(c, note)
    _observe(c, kind, seen, out)
    return out


def held_line(note: dict[str, Any]) -> str:
    """A held event as one line under MEANWHILE: its attributes but the id in brackets, then its text on one line."""
    attrs = " ".join(f'{k}="{v}"' for k, v in (note.get("meta") or {}).items() if k != "event")
    return f"[{attrs}] {' '.join(str(note.get('content') or '').split())}"


def held(c: str) -> list[dict[str, Any]]:
    """The quiet events waiting for the workspace's next event, as notifications."""
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
    """The quiet events waiting, as notifications, and no longer waiting."""
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
    note = {**notification(kind, event_id, text, fields), "terminal": line}
    return {"id": event_id, "kind": kind, "delivered": _publish(c, note)}


def show(c: str, line: str) -> None:
    """A line for main's terminal about something the analyst did in the browser that sends main no event (a follow-up
    to the orientation), printed as main's next turn begins (held_route); kept only on the hook route, whose held hook
    runs on every turn."""
    main = _main_sid(c)
    if main and line and (main, cc_channel.HOOK) in [_route(q) for q in _subs.get(c, ())]:
        _lines.setdefault((c, main), []).append(line)


def hand(c: str, event_id: str, text: str, fields: dict[str, Any], *, thread: str) -> str:
    """A thread's event that main gets in a tool's result instead of on a turn of its own (the /thimble:ask command):
    the event as rendered, with the filters. The mirror counts it as an event of main's turn (session.handed)."""
    from . import session  # noqa: PLC0415

    session.handed(c, event_id, thread)
    return render(notification(THREAD, event_id, text, {**fields, **_filters(c)}))


def _ultracode(c: str) -> dict[str, Any]:
    """`ultracode: true` on a browser message to main while the composer's chip has Ultracode on: a channel message gets none
    of the keyword's effect in Claude Code, so main.md asks for the Workflow tool itself. A thread event carries nothing."""
    from . import agents, cc_settings  # noqa: PLC0415

    held = (agents.meta_or_none(c, agents.MAIN_ID) or {}).get("attached") or {}
    return {"ultracode": True} if held.get("effort_choice") == cc_settings.ULTRACODE else {}


def _filters(c: str) -> dict[str, Any]:
    """The filters set now, on each browser message to main and to a thread (filters.event_attrs), so the model answers
    about what the analyst sees, whoever set a filter last; none when unreadable, since the message matters more."""
    from . import filters  # noqa: PLC0415

    try:
        return filters.event_attrs(c)
    except Exception:  # noqa: BLE001
        log.debug("the filters were not read for %s", c, exc_info=True)
        return {}


def _route(q: asyncio.Queue) -> tuple[str | None, str]:
    """(session, delivery) of a subscription; a queue registered without them (a test's) is a channel's."""
    return _routes.get(q, (None, cc_channel.CHANNEL))


def _main_sid(c: str) -> str | None:
    from . import session  # noqa: PLC0415

    lv = session.current(c)
    return lv.sid if lv is not None else None


def _publish(c: str, note: dict[str, Any]) -> int:
    """Hand the notification to the subscriptions of the session that is main when it has any, else to every channel's. A
    channel's gets it on its stream; a session on the hook or Monitor route gets it queued for the watcher. Returns the
    number reached."""
    subs = list(_subs.get(c, ()))
    main = _main_sid(c)
    mine = [q for q in subs if main and _route(q)[0] == main]
    if held(c) and (mine or any(_route(q)[1] == cc_channel.CHANNEL for q in subs)):
        riders = pop_held(c)
        note = {**note, "content": f"{note.get('content') or ''}\n\n{meanwhile(riders)}",
                "terminal": _joined([note, *riders])}
    n = 0
    queued: set[str] = set()
    for q in mine or [q for q in subs if _route(q)[1] == cc_channel.CHANNEL]:
        sid, delivery = _route(q)
        if delivery == cc_channel.CHANNEL:  # the notification alone: Claude Code shows the body's start itself
            q.put_nowait({"content": note.get("content"), "meta": note.get("meta")})
            n += 1
        else:
            queued.add(sid or "")
    for key in queued:
        _pending.setdefault((c, key), deque()).append(note)
        n += 1
    if queued:
        _wake(c)
    meta = note.get("meta") or {}
    log.info("%s: event %s kind=%s delivered=%d", c, meta.get("event"), meta.get("kind"), n)
    return n


def _publish_verdict(c: str, verdict: dict[str, Any]) -> None:
    """The analyst's answer to a prompt the shim relayed, to the channel subscriptions (only a channel relays one)."""
    for q in list(_subs.get(c, ())):
        if _route(q)[1] == cc_channel.CHANNEL:
            q.put_nowait({PERMISSION_EVENT: verdict})


def _wake(c: str) -> None:
    """Wake the workspace's waiting pulls, from any thread."""
    for loop, fut in list(_waiters.get(c, ())):
        if not fut.done():
            loop.call_soon_threadsafe(lambda f=fut: f.done() or f.set_result(None))


def render(note: dict[str, Any]) -> str:
    """An event as Claude Code shows a channel event to the model: `<channel source="plugin:thimble:thimble" kind="…"
    event="…" …>`, the body on its own lines, `</channel>` (escaped inside the body)."""
    meta = {"source": SOURCE, **{str(k): str(v) for k, v in (note.get("meta") or {}).items()}}
    attrs = " ".join(f'{k}="{html.escape(v, quote=True)}"' for k, v in meta.items())
    body = str(note.get("content") or "").replace("</channel>", "&lt;/channel&gt;")
    return f"<channel {attrs}>\n{body}\n</channel>"


def _pull_state(c: str, sid: str, pid: int | None = None) -> str | None:
    """Why a watcher for session `sid` should stop: CHANNEL when its channel delivers its events, GONE when another session is
    main and `sid` is not the one /clear started in `pid`, DORMANT when it becomes main again once main ends; None to wait."""
    from . import session  # noqa: PLC0415

    if sid and (sid, cc_channel.CHANNEL) in [_route(q) for q in _subs.get(c, ())]:
        return cc_channel.CHANNEL
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


def pending(c: str) -> int:
    """How many events wait for a watcher in the workspace (queued or in flight)."""
    return sum(len(q) for (cc, _), q in _pending.items() if cc == c) + sum(1 for v in _taken.values() if v[0] == c)


# --------------------------------------------------------------------------- routes


class EventBody(BaseModel):
    kind: str
    payload: dict[str, Any] = {}


@router.post("/ws/{c}/events")
async def events_route(c: str, body: EventBody) -> dict[str, Any]:
    """The browser's one way to reach the session, after the chip's last change has settled."""
    try:
        config.workspace_dir(c)
    except ValueError as e:
        raise HTTPException(404, str(e)) from e
    wait = _settings_written.get(c, 0.0) + SETTINGS_SETTLE_S - time.monotonic()
    if wait > 0:
        await asyncio.sleep(wait)
    return post(c, body.kind, body.payload)


class SessionBody(BaseModel):
    session: str
    cwd: str | None = None
    env_pid: int | None = None  # the process sending this, whose environment has the session's CLAUDE_CONFIG_DIR


@router.post("/ws/{c}/session")
async def session_route(c: str, body: SessionBody) -> dict[str, Any]:
    """`/thimble` names its session (`thimble server up --session`), for a shim that could not tell which one it serves.
    `replaced` names the session that was main and still runs in another terminal, which this one takes over from."""
    from . import session  # noqa: PLC0415

    try:
        corpus = config.corpus_dir(c)
    except ValueError as e:
        raise HTTPException(404, str(e)) from e
    before = session.current(c)
    # a session another terminal runs, whose shim is still subscribed, stops hearing the browser: /thimble says so
    replaced = before.sid if before is not None and before.sid != body.session and listening(c, before.sid) else None
    known, value = config.process_claude_config(body.env_pid)
    lv = session.attach(c, body.session, body.cwd or str(corpus), config_dir=(value or "") if known else None)
    return {"attached": bool(lv), "session": body.session, "listening": listening(c), "replaced": replaced}


class EffortBody(BaseModel):
    effort: str


@router.put("/ws/{c}/session/effort")
async def effort_route(c: str, body: EffortBody) -> dict[str, Any]:
    """The composer's effort chip: main's effort from its next request (low to max, or ultracode), written where the running
    session reads it and kept on main's `attached` as `effort_choice`. 409 without an attached session."""
    from . import agents, cc_settings  # noqa: PLC0415

    try:
        corpus = config.corpus_dir(c)
    except ValueError as e:
        raise HTTPException(404, str(e)) from e
    meta = agents.ensure_main(c)
    held = meta.get("attached") or {}
    if not held.get("session"):
        raise HTTPException(409, "no Claude Code session is attached; start thimble with `thimble` in the corpus folder")
    try:
        level = cc_settings.set_main_effort(Path(str(held.get("cwd") or corpus)), body.effort)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    _settings_written[c] = time.monotonic()
    choice = body.effort.strip().lower()
    meta["attached"] = {**held, "effort_choice": choice}
    agents.write_meta(c, meta)
    agents.notify(c, agents.MAIN_ID)
    return {"effort": level, "choice": choice}


class FastBody(BaseModel):
    fast: bool


@router.put("/ws/{c}/session/fast")
async def fast_route(c: str, body: FastBody) -> dict[str, Any]:
    """The composer's fast-mode switch: main's fast mode off or back on from its next request, kept on main's `attached` as
    `fast_choice`. 409 without an attached session."""
    from . import agents, cc_settings  # noqa: PLC0415

    try:
        corpus = config.corpus_dir(c)
    except ValueError as e:
        raise HTTPException(404, str(e)) from e
    meta = agents.ensure_main(c)
    held = meta.get("attached") or {}
    if not held.get("session"):
        raise HTTPException(409, "no Claude Code session is attached; start thimble with `thimble` in the corpus folder")
    cc_settings.set_main_fast(Path(str(held.get("cwd") or corpus)), body.fast)
    _settings_written[c] = time.monotonic()
    meta["attached"] = {**held, "fast_choice": body.fast}
    agents.write_meta(c, meta)
    agents.notify(c, agents.MAIN_ID)
    return {"fast": body.fast}


@router.get("/channel")
async def subscribe(request: Request, cwd: str, session: str | None = None, pid: int | None = None,
                    delivery: str = cc_channel.CHANNEL) -> EventSourceResponse:
    """The shim's subscription, with the route its session hears events by (`delivery`) and the pid of its `claude`, whose
    environment gives the session's CLAUDE_CONFIG_DIR (session.attach). 404 while the folder is not a workspace yet: the
    shim retries, and `/thimble` registers the folder."""
    from . import session as session_mod  # noqa: PLC0415

    c = config.workspace_for_cwd(cwd)
    if not c:
        raise HTTPException(404, f"{cwd} is not a thimble workspace yet; /thimble opens it")
    if delivery not in cc_channel.MODES:
        delivery = cc_channel.CHANNEL
    q: asyncio.Queue = asyncio.Queue()
    _subs.setdefault(c, set()).add(q)
    _routes[q] = (session or None, delivery)
    session_mod.connected(c, session, cwd, pid, claim=delivery == cc_channel.CHANNEL)
    _wake(c)  # a watcher of this session's that waits learns it delivers by channel now
    log.info("%s: channel subscribed (session %s, pid %s, Claude Code %s, %s)", c, session, pid,
             procs.version_of(pid) or "version unknown", delivery)

    async def gen() -> AsyncIterator[dict[str, str]]:
        try:
            yield {"event": "ready", "data": json.dumps({"workspace": c})}
            while True:
                note = await q.get()
                if PERMISSION_EVENT in note:
                    yield {"event": PERMISSION_EVENT, "data": json.dumps(note[PERMISSION_EVENT], ensure_ascii=False)}
                    continue
                yield {"event": "channel", "data": json.dumps(note, ensure_ascii=False)}
        finally:
            subs = _subs.get(c)
            if subs is not None:
                subs.discard(q)
            _routes.pop(q, None)
            log.info("%s: channel unsubscribed (session %s)", c, session)
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


@router.get("/channel/pull")
async def pull_route(request: Request, cwd: str, session: str | None = None, wait: float = PULL_WAIT_S,
                     pid: int | None = None) -> Any:
    """The watcher's long poll: `{id, text}` for the next event of the session, 204 when none came within `wait` seconds, 404
    when the folder is no workspace, 409 when the session's channel delivers its events, 410 when another session is main
    (see _pull_state). The event stays in flight until the watcher acknowledges it (ack_route)."""
    c = config.workspace_for_cwd(cwd)
    if not c:
        raise HTTPException(404, f"{cwd} is not a thimble workspace")
    sid = session or ""
    deadline = time.monotonic() + min(max(wait, 0.0), PULL_WAIT_MAX_S)
    while True:
        _requeue(c)
        state = _pull_state(c, sid, pid)
        if state == cc_channel.CHANNEL:
            raise HTTPException(409, "this session's channel delivers its events")
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


@router.post("/channel/ack")
async def ack_route(body: AckBody) -> dict[str, Any]:
    """The watcher wrote the event out: it leaves the flight. 404 when it is not in flight."""
    taken = _taken.pop(body.id, None)
    if taken is None:
        raise HTTPException(404, "no such event is in flight")
    if body.terminal and taken[2].get("terminal"):
        _lines.setdefault((taken[0], body.session or ""), []).append(str(taken[2]["terminal"]))
    return {"acknowledged": body.id}


class HeldBody(BaseModel):
    cwd: str
    session: str | None = None


@router.post("/channel/held")
async def held_route(body: HeldBody) -> dict[str, Any]:
    """The UserPromptSubmit hook, as a turn of main's begins (a prompt typed in the terminal, or an event the watcher
    wrote out): `{text, terminal}`, the quiet events waiting as MEANWHILE, which the hook adds to the prompt ('' when
    none wait or `session` is not main), and the lines main's terminal shows of the events the session's watcher wrote
    out and of those quiet events, which it prints. 404 when the folder is no workspace."""
    c = config.workspace_for_cwd(body.cwd)
    if not c:
        raise HTTPException(404, f"{body.cwd} is not a thimble workspace")
    main = _main_sid(c)
    riders = pop_held(c) if main and body.session == main else []
    lines = [*_lines.pop((c, body.session or ""), []), _joined(riders)]
    return {"text": meanwhile(riders), "terminal": "\n".join(x for x in lines if x)}


@router.get("/channel/main")
async def main_route(cwd: str, pid: int | None = None) -> dict[str, Any]:
    """`{workspace, main}`: whether `pid`, a `claude` process, runs the session that is main in the folder's workspace. The
    SessionStart hook asks before it gives main its prompt again after /clear or /compact. 404 when the folder is no
    workspace."""
    from . import session  # noqa: PLC0415

    c = config.workspace_for_cwd(cwd)
    if not c:
        raise HTTPException(404, f"{cwd} is not a thimble workspace")
    return {"workspace": c, "main": bool(pid) and session.main_pid(c) == pid}


@router.get("/channel/sessions")
async def sessions_route() -> dict[str, Any]:
    """`thimble list` and `thimble purge`: `{workspaces: {<c>: [session…]}, data_dir, workspaces_dir}`, the sessions whose
    shims hold a subscription, per workspace, and the folders the server works on."""
    return {"workspaces": {c: subscribed_sessions(c) for c, subs in _subs.items() if subs},
            "data_dir": str(config.DATA_DIR.resolve()), "workspaces_dir": str(config.WORKSPACES_DIR.resolve())}


class PermissionRequest(BaseModel):
    cwd: str
    session: str | None = None
    request_id: str
    tool_name: str = ""
    description: str = ""
    input_preview: str = ""


@router.post("/channel/permission")
async def permission_request_route(body: PermissionRequest) -> dict[str, Any]:
    """The shim relays a permission prompt of main's session (`claude/channel/permission`): it waits on main's meta, where
    the browser shows it with Allow and Deny, until the analyst answers or the session moves on."""
    c = config.workspace_for_cwd(body.cwd)
    if not c:
        raise HTTPException(404, f"{body.cwd} is not a thimble workspace")
    _hold(c, body.request_id, body.tool_name, body.description or body.tool_name, body.input_preview)
    return {"waiting": body.request_id}


def _asking_chat(c: str, agent: str | None) -> str | None:
    """The chat of the subagent or fork `agent` of main's session (a thread whose fork it is, or a subagent's chat),
    so the browser can mark the thread that waits; None for main or an agent no chat follows."""
    from . import agents  # noqa: PLC0415

    if not agent:
        return None
    for meta in agents.list_chats(c):
        if (meta.get("fork") or {}).get("agent_id") == agent or meta.get("agent_id") == agent:
            return str(meta["id"])
    return None


def _hold(c: str, request_id: str, tool: str, what: str, preview: str, agent: str | None = None) -> None:
    """Put a relayed permission request on main's meta, where the browser shows it; `chat` names the thread or subagent
    chat whose agent asked, when the hook said which (_asking_chat)."""
    from . import agents  # noqa: PLC0415

    meta = agents.ensure_main(c)
    pending = [p for p in meta.get("permissions") or [] if isinstance(p, dict) and p.get("id") != request_id]
    chat = _asking_chat(c, agent)
    entry = {"id": request_id, "tool": tool, "what": what or tool, "input": preview[:PERMISSION_INPUT_CHARS],
             "since": _now(), **({"cut": len(preview)} if len(preview) > PERMISSION_INPUT_CHARS else {}),
             **({"chat": chat} if chat else {})}
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


class Ask(NamedTuple):
    """A prompt the PermissionRequest hook relayed, waiting for the analyst."""

    c: str
    loop: asyncio.AbstractEventLoop
    fut: asyncio.Future
    since: float  # time.monotonic() when it opened, for release_asks
    at: float = 0.0  # time.time() when it opened, compared with the agent's transcript timestamps (calls_done)
    agent: str | None = None  # the subagent or fork that asked; None for main
    call: tuple[str, str] = ("", "")  # the call it asks about (call_key), which calls_done matches to its result


@router.post("/channel/permission/hook")
async def hook_permission_route(request: Request, body: HookPermission) -> dict[str, Any]:
    """The PermissionRequest hook of a session on the hook route relays its prompt: it waits on main's meta until the analyst
    answers, `{id, behavior: allow | deny}`, or the prompt or hook goes away, `{id, behavior: null}`. 404 when the folder is
    no workspace, 409 when the session is not main or its channel relays its prompts itself."""
    c = config.workspace_for_cwd(body.cwd)
    if not c:
        raise HTTPException(404, f"{body.cwd} is not a thimble workspace")
    sid = body.session or ""
    main = _main_sid(c)
    if _pull_state(c, sid) == cc_channel.CHANNEL or not main or (sid and sid != main):
        raise HTTPException(409, "this session's prompts are not relayed here")
    inp = body.tool_input if isinstance(body.tool_input, dict) else {}
    what = str(inp.get("description") or "").strip() or body.tool_name
    preview = json.dumps(body.tool_input, ensure_ascii=False) if body.tool_input is not None else ""
    request_id = HOOK_ASK_PREFIX + secrets.token_hex(4)
    loop = asyncio.get_running_loop()
    fut: asyncio.Future = loop.create_future()
    _asks[request_id] = Ask(c, loop, fut, time.monotonic(), time.time(), body.agent_id or None,
                            call_key(body.tool_name, body.tool_input))
    _hold(c, request_id, body.tool_name, what, preview, body.agent_id or None)
    try:
        while not fut.done():
            try:
                await asyncio.wait_for(asyncio.shield(fut), PULL_TICK_S)
            except asyncio.TimeoutError:
                if await request.is_disconnected() or _stopping():  # Claude Code's own prompt stays open
                    break
    finally:
        _asks.pop(request_id, None)
        if not fut.done():
            _drop(c, {request_id})  # the hook went away: Claude Code decided without it
    return {"id": request_id, "behavior": fut.result() if fut.done() else None}


def _answer_ask(request_id: str, behavior: str | None) -> bool:
    """End a hook's wait with the analyst's answer, or with none; False when no hook waits on that request. An agent's
    prompt the analyst answered here is remembered (_answered), so its call's result ends no other prompt."""
    held = _asks.pop(request_id, None)
    if held is None:
        return False
    if behavior is not None:
        _answered.setdefault((held.c, held.agent or ""), []).append(held.call)
    fut = held.fut
    held.loop.call_soon_threadsafe(lambda: fut.done() or fut.set_result(behavior))
    return True


class PermissionAnswer(BaseModel):
    id: str
    allow: bool


@router.post("/ws/{c}/permission")
async def permission_route(c: str, body: PermissionAnswer) -> dict[str, Any]:
    """The analyst's answer to a relayed permission prompt of main's: it goes to the waiting hook, or else to the session's
    shim on the stream. 404 when no such request waits."""
    from . import agents  # noqa: PLC0415

    meta = agents.ensure_main(c)
    pending = [p for p in meta.get("permissions") or [] if isinstance(p, dict)]
    if not any(p.get("id") == body.id for p in pending):
        raise HTTPException(404, "no such permission request is waiting")
    behavior = "allow" if body.allow else "deny"
    _drop(c, {body.id}, answer=behavior)
    if not _answer_ask(body.id, behavior):
        _publish_verdict(c, {"request_id": body.id, "behavior": behavior})
    return {"answered": body.id, "allow": body.allow}


def clear_permissions(c: str) -> None:
    """Drop main's relayed permission requests and end the hooks that wait on them: the session is no longer waiting on a
    prompt. A subagent's or fork's request stays; agent_moved ends it."""
    agents_asking = {i for i, a in _asks.items() if a.c == c and a.agent}
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
    """The subagents and forks whose hook-relayed prompts wait in the workspace."""
    return {a.agent for a in _asks.values() if a.c == c and a.agent}


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
    before then are gone, so their hooks' waits end. The mirror calls it when an agent stops; a prompt of a working
    agent ends with its call's result (calls_done), since an agent with several calls open goes on writing while
    their prompts wait."""
    gone = {i for i, a in _asks.items() if a.c == c and a.agent == agent and a.at < after}
    for request_id in gone:
        _answer_ask(request_id, None)
    if gone:
        _drop(c, gone)


def calls_done(c: str, agent: str | None, done: "list[tuple[tuple[str, str], float]]") -> None:
    """Calls of the subagent or fork `agent`, or of main when it is None, got their results (each call_key with the
    result's time): the prompt each one waited on was answered, in the terminal or here, so its hook's wait ends and
    the browser drops its card. A call is matched to the prompt with its call_key, else, for a subagent, to the one
    prompt of its tool that agent has open; any other prompt stays."""
    gone: set[str] = set()
    answered = _answered.get((c, agent or ""), [])
    for key, at in done:
        if key in answered:
            answered.remove(key)  # the prompt the analyst answered in the browser, gone already
            continue
        open_ = sorted(((i, a) for i, a in _asks.items() if a.c == c and a.agent == agent and i not in gone
                        and a.call[0] == key[0] and a.at <= at), key=lambda x: x[1].at)
        hit = next((i for i, a in open_ if a.call == key), None)
        if hit is None and len(open_) == 1 and agent is not None:  # main's prompts and calls carry the same input
            hit = open_[0][0]
        if hit is not None:
            gone.add(hit)
    for request_id in gone:
        _answer_ask(request_id, None)
    if gone:
        _drop(c, gone)


def _now() -> str:
    from datetime import datetime, timezone  # noqa: PLC0415

    return datetime.now(timezone.utc).isoformat(timespec="seconds")


async def shutdown() -> None:
    _subs.clear()
    _routes.clear()
    _pending.clear()
    _taken.clear()
    for request_id in list(_asks):
        _answer_ask(request_id, None)
    _answered.clear()
