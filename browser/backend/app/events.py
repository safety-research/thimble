"""Browser events: how the browser reaches main, which the server runs (runtime.py).

The browser posts `POST /api/ws/{c}/events {kind, payload}`; server code calls post(). A kind is a bullet of main.md's
`## Events from the browser`, and other kinds are refused. An event goes to main as the text the model reads (render),
through runtime.deliver (_publish); a `thread` event goes to the thread's fork. An event of QUIET_KINDS asks main for
nothing, so it wakes no turn: it waits in the workspace's HELD_FILE and rides along, under MEANWHILE, with main's next
event or the result of main's next thimble call (with_held).

Each event has one line that says what it was (terminal_line): the analyst's words after SAID, with the thread or button
they belong to, else a short line saying what happened.
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
from typing import Any, Callable, NamedTuple

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from . import cc_plugin, config, labels_off, ledger, nofollow, permission_updates, prompts, runtime_tools

log = logging.getLogger("thimble.events")


router = APIRouter()

PROMPT = "main"  # main's system-prompt append, whose events section names the kinds
EVENTS_SECTION = "Events from the browser"
SESSION_PROMPTS = (PROMPT,)
MAIN, THREAD = "main", "thread"
ATTR_CHARS = 120  # a payload value longer than this, or with a newline, goes into the body instead of an attribute
BODY_CHARS = 12_000  # the event body's ceiling: an event stays in main's context for the rest of the session
TAG = "thimble-event"  # the element an event is rendered as for the model (render), which the mirror reads back
SAID = "› "  # opens the analyst's own words in main's terminal (terminal_line)
LINE_CHARS = 160  # of an event's line in main's terminal: about two lines
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


def session_prompt(workdir: str, edits: bool | None = None, c: str | None = None) -> str:
    """Main's system-prompt append, as the launcher passes it with --append-system-prompt. Claude Code cuts MCP server
    instructions at 2 KB, so this text cannot travel as the shim's instructions, while an append reaches main and every
    fork of it whole. `edits`: whether main may write the corpus, `c` its workspace (render_prompts)."""
    return render_prompts(SESSION_PROMPTS, workdir, edits, c)


# main.md's {{corpus_writes}} in the browser: what main's sandbox lets it write, by Settings' Read only switch
# (ledger.corpus_edits, false while it is on); None for a main the server does not run (the launcher's), whose sandbox
# the switch does not reach
CORPUS_WRITES: dict[bool | None, str] = {
    None: "Bash reads the corpus and writes only your own folders, and file edits go only there.",
    True: ("Bash reads and writes the corpus folder and your own folders, and file edits go there too. thimble's own "
           f"files stay unwritable. The analyst can turn on \"{runtime_tools.READ_ONLY_SWITCH}\" in Settings to stop "
           "this."),
    False: ("Bash reads the corpus folder but cannot write it, since the analyst turned on "
            f"\"{runtime_tools.READ_ONLY_SWITCH}\" in Settings; it writes only your own folders, and file edits go "
            "only there. When a file has to go into the corpus folder, tell the analyst they can turn "
            f"\"{runtime_tools.READ_ONLY_SWITCH}\" off in Settings."),
}

# main.md's {{network}} in the browser (network_words), by the way main reaches Claude and whether Settings leaves main
# its web: which requests to a host ask the analyst first, as Settings' row for main says (runtime.network). On Claude
# Code sign-in ("ask") a Bash command's (host_asks) and nothing else; with an API key or WIF ("on") none. Web fetches and
# web searches are named only while main has them (userconf.main_web_off)
NETWORK: dict[tuple[str, bool], str] = {
    ("ask", True): ("A Bash command's request to a host the analyst has not allowed asks them first, while web fetches, "
                    "web searches and card code reach any host without asking."),
    ("ask", False): ("A Bash command's request to a host the analyst has not allowed asks them first, while card code "
                     "reaches any host without asking."),
    ("on", True): "Bash commands, web fetches, web searches and card code reach any host without asking the analyst.",
    ("on", False): "Bash commands and card code reach any host without asking the analyst.",
}


def network_words(c: str | None, edits: bool | None) -> str:
    """main.md's {{network}}: NETWORK's sentence for the way main reaches Claude, with its web fetches and web searches
    while Settings leaves them to it (userconf.main_web_off). The main the server runs (`edits` True or False) reaches
    Claude the way the workbench is set to (runtime.network); one it does not run (`edits` None), the analyst's own
    Claude Code session such as the launcher's (plugin/bin/thimble), through Claude Code, so on Claude Code sign-in's
    terms whatever way the workbench is set to."""
    from . import runtime, userconf  # noqa: PLC0415

    return NETWORK[(runtime.network() if edits is not None else "ask", not userconf.main_web_off(c))]


def render_prompts(names: tuple[str, ...] | list[str], workdir: str, edits: bool | None = None,
                   c: str | None = None) -> str:
    """Prompt files for a session in `workdir`, rendered and joined by a blank line, with the corpus root and the citation
    forms of the folder's views filled in. Main's append and the shared skill's command both come from here. `edits`:
    whether main may write the corpus (CORPUS_WRITES), None where the server does not run main (runtime.py). Which
    requests to a host ask the analyst follows the way main reaches Claude (network_words). While the workspace's
    Label tool is off (ledger.labels_on), each text leaves out what it says of labels (labels_off.py). The workspace is
    `c`, else the one `workdir` opens as (config.workspace_for_cwd): a session of the folder that runs beside its own
    (config.sessions_of) shares its folder, and its prompt reads its own labels and views."""
    from . import views  # noqa: PLC0415 — views imports refs, which a launcher does not otherwise need

    c = c or config.workspace_for_cwd(workdir)
    labels = ledger.labels_on(c)
    forms = views.forms_text(c) if c else ""
    values = {"workdir": str(workdir), "forms": forms, "corpus_writes": CORPUS_WRITES[edits],
              "network": network_words(c, edits)}
    parts = []
    for name in names:
        part = prompts.render(name, values).strip()
        if not labels:
            part = labels_off.prompt(name, part).strip()
        parts.append(part)
    return re.sub(r"\n{3,}", "\n\n", "\n\n".join(parts))  # an empty {{forms}} leaves a blank line of its own


# --------------------------------------------------------------------------- posting


def observe(kind: str, fn: Callable[[str, dict[str, Any], dict[str, Any]], None]) -> None:
    """Call `fn(c, payload, posted)` after each event of `kind` is posted; an observer that raises is logged and skipped."""
    if fn not in _observers.setdefault(kind, []):
        _observers[kind].append(fn)


def subscribed_sessions(c: str) -> list[str]:
    """The sessions whose shims hold a subscription for the workspace, as they named themselves ('' for none)."""
    return [str(sub.session or "") for sub in _subs.get(c, ())]


def _attr_key(key: str) -> str:
    return _KEY_RE.sub("_", str(key)).strip("_")


def build_note(kind: str, event_id: str, text: str, fields: dict[str, Any]) -> dict[str, Any]:
    """{content, meta} of one event: `kind` and `event` (its id) first, then each field as an attribute when
    it is a short scalar, else as a `<key>: <value>` line under the text, the whole cut at BODY_CHARS. The id is
    `event`, never `id`, so that no attribute a prompt names by its role reads as "the id"."""
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


# the kinds that say something ended and ask main for nothing: each waits and rides along with main's next event, under
# MEANWHILE (prompts/main.md)
QUIET_KINDS = frozenset({"written", "labeled", "label_ask", "view", "citations"})
MEANWHILE = "meanwhile:"
HELD_FILE = "held-events.json"  # in the workspace: the quiet events waiting, as notes, across restarts
_held: dict[str, list[dict[str, Any]]] = {}  # workspace -> HELD_FILE's notes, once read


def describe(kind: str, payload: dict[str, Any]) -> str:
    """The body of an event that carries no text of its own: one line saying what the analyst did."""
    return f"The analyst sent `{kind}` from the browser"


def terminal_line(kind: str, words: str, fields: dict[str, Any]) -> str:
    """An event's line in main's terminal (module note): the analyst's `words` after SAID, else a short line saying what
    happened, on one line and cut at LINE_CHARS."""
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
    elif kind == "label_ask":
        line = f"label {fields.get('name') or ''}: the analyst chose {fields.get('choice') or ''}"
    elif kind == "label_done":
        line = f"label finished: {fields.get('name') or ''}"
    elif kind == "rerun":
        line = f"cards run again: label {fields.get('name') or ''} changed"
    elif kind == "written":
        line = f"the {fields.get('doc') or 'document'} writer ended"
    elif kind == "checked":
        line = f"a comments agent on the {fields.get('doc') or 'document'} ended"
    elif kind == "citations":
        line = "the check of the last reply's citations changed some"
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
    main's terminal shows instead of terminal_line's: at once, or, when the server runs main and main's turn runs, where
    main reads it, and as waiting until then (runtime.deliver). `event_id` is the event's id when the caller recorded it
    first (fixes.ask keeps it). 409 when no session listens, 400 for a kind main.md names no bullet for (when
    `check_kind`), or for a message with no text."""
    from . import agents, runtime, session, threads  # noqa: PLC0415

    kind = str(kind or "").strip()
    payload = dict(payload or {})
    if check_kind and kind not in kinds():
        raise HTTPException(400, f"unknown event kind {kind!r}; the kinds are {', '.join(kinds())} (prompts/{PROMPT}.md)")
    if kind in labels_off.EVENTS and not ledger.labels_on(c):
        # Labels is off in the workspace's Settings: main is told nothing of labels (labels_off.py)
        log.info("%s: no %s event, since Labels is off in Settings", c, kind)
        return {"id": event_id or secrets.token_hex(4), "kind": kind, "delivered": 0, "labels_off": True}
    runtime.ensure(c)
    event_id = event_id or secrets.token_hex(4)
    out: dict[str, Any] = {"id": event_id, "kind": kind}
    seen = dict(payload)  # what an observer reads, before the builders below take their keys out
    if kind == MAIN:
        words = str(payload.pop("text", "") or "").strip()
        if not words:
            raise HTTPException(400, "empty message")
        # a message that comes while the server's main works waits for main to read it: its line goes in there, so the
        # rest of the turn does not read as its answer (runtime.deliver)
        waits = mirror and runtime.ensure(c).main.running
        if mirror and not waits:
            agents.mirror(c, "user", by=agents.BROWSER, text=words, event=event_id)
        note = build_note(kind, event_id, words, {**payload, **_ultracode(c), **_filters(c)})
        if waits:
            note["said"] = words
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
        note = build_note(kind, event_id, words or describe(kind, payload), payload)
        if kind == "card":  # a card request: main reads it at its running turn's next tool call (runtime.deliver)
            note["ask"] = True
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
    """The quiet events waiting for the workspace's next event, as notes."""
    if c not in _held:
        try:  # in the workspace, which a card's code writes: never through a link or a FIFO left there (nofollow)
            notes = json.loads(nofollow.read_text(config.workspace_dir(c) / HELD_FILE))
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
            nofollow.unlink(path)  # the entry itself, never through a link a card's code left on its way
    except OSError:
        log.warning("%s: the held events were not saved to %s", c, path, exc_info=True)


def pop_held(c: str) -> list[dict[str, Any]]:
    """The quiet events waiting, as notes, and no longer waiting. While Labels is off in the workspace's Settings, one of
    labels held from before goes with no word to main (labels_off.EVENTS)."""
    notes = held(c)
    if notes:
        _keep_held(c, [])
    if notes and not ledger.labels_on(c):
        notes = [n for n in notes if (n.get("meta") or {}).get("kind") not in labels_off.EVENTS]
    return notes


def hold_again(c: str, notes: list[dict[str, Any]]) -> None:
    """Quiet events that rode along with the analyst's message a rewind goes back to, or with an event main never read,
    which a rewind took back (runtime.Space.take_back): they wait again for main's next event, before those held
    since."""
    _keep_held(c, [*notes, *held(c)])


def meanwhile(notes: list[dict[str, Any]]) -> str:
    """Held events as MEANWHILE and one line each; '' for none."""
    return "\n".join([MEANWHILE, *(held_line(h) for h in notes)]) if notes else ""


def with_held(c: str, res: Any) -> Any:
    """`res` (a tools.ToolResult of main's thimble call, when the server runs main) with the quiet events waiting after
    its text, as MEANWHILE, and no longer waiting: a turn of main's that still runs reads them there, as a card's author
    reads the card's notes (card_size.with_notes), and does not end as if they had not come, such as a label's ask the
    analyst answered meanwhile."""
    text = meanwhile(pop_held(c))
    if not text:
        return res
    for b in res.content:
        if b.get("type") == "text":
            b["text"] = f"{b.get('text', '')}\n\n{text}" if str(b.get("text", "")) else text
            return res
    res.content.append({"type": "text", "text": text})
    return res


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
    return {"id": event_id, "kind": kind, "delivered": _publish(c, note)}


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


def _publish(c: str, note: dict[str, Any]) -> int:
    """Hand the event to main (runtime.deliver), with the held ones riding along; a thread's event goes to the thread's
    fork, so they wait for main's own. Returns the number reached, 1."""
    from . import runtime  # noqa: PLC0415

    if held(c) and (note.get("meta") or {}).get("kind") != THREAD:
        riders = pop_held(c)
        # `riders` too, so a rewind that takes the event back, or goes back to its message, holds them again
        # (hold_again)
        note = {**note, "content": f"{note.get('content') or ''}\n\n{meanwhile(riders)}", "riders": riders}
    runtime.deliver(c, note)
    log.info("%s: event %s kind=%s delivered to the runtime", c, (note.get("meta") or {}).get("event"),
             (note.get("meta") or {}).get("kind"))
    return 1


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


class MainChoice(BaseModel):
    effort: str | None = None
    fast: bool | None = None
    model: str | None = None


MODEL_ID = re.compile(r"claude-[a-z0-9][a-z0-9.-]{1,62}")  # a model id as the API takes it, without a `[1m]` tag


def _choose(c: str, choice: dict[str, Any]) -> None:
    """The composer's choice for main, kept in the workspace's settings as models.main and applied at main's next
    launch (cli.launch_args); on main's `attached` too, as model_choice, effort_choice and fast_choice (session.chosen),
    for the chip to show at once. A model chosen sets there the effort main runs at on it while the composer chose none
    (cc_settings.session_effort)."""
    from . import agents, cc_settings, ledger, session  # noqa: PLC0415

    try:
        corpus = config.corpus_dir(c)
    except ValueError as e:
        raise HTTPException(404, str(e)) from e
    ledger.put_settings(c, {config.MODELS_KEY: {"main": choice}})
    meta = agents.ensure_main(c)
    if meta.get("attached"):
        fresh = session.chosen(choice)
        if "model" in choice:
            fresh["settings_effort"] = cc_settings.session_effort(corpus, choice["model"])
        meta["attached"] = {**meta["attached"], **fresh}
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
    turn). A model without fast mode turns fast mode off, as Claude Code's /model does, so fast mode comes back on only
    from the bolt, never with a model picked again. 400 for what is no model id."""
    model = config.base_model(str(body.model or "")).lower()
    if not MODEL_ID.fullmatch(model):
        raise HTTPException(400, "choose a model by its id, such as claude-opus-5-5")
    _choose(c, {"model": model, **({} if config.has_fast_mode(model) else {"fast": False})})
    return {"model": model}


@router.put("/ws/{c}/session/fast")
async def fast_route(c: str, body: MainChoice) -> dict[str, Any]:
    """The composer's fast-mode switch: main's fast mode from its next launch (_choose)."""
    _choose(c, {"fast": bool(body.fast)})
    return {"fast": bool(body.fast)}


@router.get("/events/sessions")
async def sessions_route() -> dict[str, Any]:
    """`thimble list` and `thimble purge`: `{workspaces: {<c>: [session…]}, data_dir, workspaces_dir}`, the sessions whose
    shims hold a subscription, per workspace, and the folders the server works on."""
    return {"workspaces": {c: subscribed_sessions(c) for c, subs in _subs.items() if subs},
            "data_dir": str(config.DATA_DIR.resolve()), "workspaces_dir": str(config.WORKSPACES_DIR.resolve())}


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


class Ask(NamedTuple):
    """A prompt the PermissionRequest hook relayed, waiting for the analyst."""

    c: str
    loop: asyncio.AbstractEventLoop
    fut: asyncio.Future
    since: float  # time.monotonic() when it opened, for release_asks
    at: float = 0.0  # time.time() when it opened, compared with the agent's transcript timestamps (calls_done)
    agent: str | None = None  # the subagent or fork that asked; None for main
    call: tuple[str, str] = ("", "")  # the call it asks about (call_key), which calls_done matches to its result


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
