"""Events to a session on local transport, where no server holds them (events.py has the design of the server's
queue). Every process of the session that posts an event (the MCP shim, the hooks' backend calls, the terminal UI's
acts) writes it to a file in the workspace, and the session's watcher (plugin/bin/.thimble-watch, the asyncRewake hook)
takes it from there:

  events/queue.jsonl   one line per event, as the model reads it: {id, kind, text, line, said, at, to?}; then, once a
                       watcher took it, {taken: id, session, at}, which wakes that session with `text`; once main's held
                       hook printed its `said` in the terminal, {shown: id}. A line for main's terminal that sends main no
                       event (events.show) is {show: line, at}. Trimmed to the lines still needed once it grows past
                       TRIM_BYTES.
  held-events.json     the quiet events (events.QUIET_KINDS) as notes, which ask for nothing: they ride along with the
                       next event under MEANWHILE, or with the session's next prompt (the held hook). The server keeps
                       main's here too.

An event names the session it is for in `to` (a peer: a second session that turned thimble on beside a live main), or
none, which is main's; a session takes only its own (take: `to` that is the session, or a session --rekey moved to it,
and with no `to` only main). Once a press made main's transport the server, an event for main that a process of the
session still posts here (a label run that the shim started before the press and that ends after it) waits for thimble's
server, which takes main's waiting events and held notes into its own queue, in order, at each pull of main's watcher
(drain, held_for), and marks them taken by SERVER_TAKER, so no local watcher takes them too.

A write takes an exclusive flock on `<file>.lock` beside its file (the form of ledger.locked), re-reads the file and
appends to it or replaces it whole (a temporary file renamed over it). An append that holds the queue's lock and pops
the held events takes the queue's lock first, then the held file's.

Standard library only: the watcher imports this module under `python -S`.
"""
from __future__ import annotations

import contextlib
import fcntl
import json
import os
import re
import secrets
import time
from pathlib import Path
from typing import Any, Callable, Iterator

QUEUE = ("events", "queue.jsonl")  # under the workspace folder
HELD = "held-events.json"  # in the workspace folder: events.HELD_FILE
LOCK_WAIT_S = 2.0
LOCK_POLL_S = 0.01
TRIM_BYTES = 256 * 1024
KEEP_S = 24 * 3600.0  # a taken event's lines are dropped this long after it was posted, once the file is trimmed
MEANWHILE = "meanwhile:"  # events.MEANWHILE
SAID = "› "  # events.SAID: opens the analyst's own words in an event's line
# the kinds of event whose line main's terminal leaves out (said): Claude Code draws a hook's systemMessage under the
# hook's name (`UserPromptSubmit says: …`), a row no render hook reaches, and the terminal's own rows already say these:
# a thread's question in its fork's row and its `↳` row (thimble-term), a writer's end in its hand-back's row. A thread's
# event wakes main, whose turn Claude Code opens with a `● thimble` row no hook removes, so it keeps one short line under
# that row (short_line) rather than none
TOLD_IN_CHAT = ("thread", "written")
SHORT_CHARS = 60  # of a thread's question, or of a message to it, in its short line
SERVER_TAKER = "server"  # the `session` of a {taken} record the server wrote as it took the event into its queue (drain)


def queue_path(ws: Path) -> Path:
    return Path(ws).joinpath(*QUEUE)


def held_path(ws: Path) -> Path:
    return Path(ws) / HELD


@contextlib.contextmanager
def locked(path: Path, wait_s: float = LOCK_WAIT_S) -> Iterator[None]:
    """An exclusive flock on `<path>.lock` for the block (ledger.locked's form). A lock that does not come within
    `wait_s` is given up, and the block runs without it."""
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        fd = os.open(path.with_name(path.name + ".lock"), os.O_RDONLY | os.O_CREAT, 0o600)
    except OSError:
        fd = -1
    if fd >= 0:
        end = time.monotonic() + wait_s
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= end:
                    break
                time.sleep(LOCK_POLL_S)
            except OSError:
                break
    try:
        yield
    finally:
        if fd >= 0:
            os.close(fd)


def _replace(path: Path, text: str) -> None:
    tmp = path.with_name(f".{path.name}.{os.getpid()}.{secrets.token_hex(3)}.tmp")
    try:
        tmp.write_text(text, "utf-8")
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    finally:
        with contextlib.suppress(OSError):
            tmp.unlink()


def _lines(path: Path) -> list[dict[str, Any]]:
    try:
        raw = path.read_text("utf-8")
    except OSError:
        return []
    out = []
    for line in raw.splitlines():
        try:
            rec = json.loads(line)
        except ValueError:
            continue
        if isinstance(rec, dict):
            out.append(rec)
    return out


def _append(path: Path, *recs: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
    try:
        os.write(fd, "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in recs).encode("utf-8"))
        size = os.fstat(fd).st_size
    finally:
        os.close(fd)
    if size > TRIM_BYTES:
        _trim(path)


def _trim(path: Path) -> None:
    """The queue without what no one needs any more: taken events older than KEEP_S with their records, and lines
    shown. Called with the queue's lock held."""
    recs = _lines(path)
    floor = time.time() - KEEP_S
    taken = {str(r["taken"]) for r in recs if r.get("taken")}
    old = {str(r["id"]) for r in recs if r.get("id") and str(r["id"]) in taken and float(r.get("at") or 0) < floor}
    kept = [r for r in recs if not (str(r.get("id") or r.get("taken") or r.get("shown") or "") in old)
            and not (r.get("show") is not None and r.get("done"))]
    _replace(path, "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in kept))


# --------------------------------------------------------------------------- held events


def _main(ws: Path) -> str:
    """Main's session in the workspace folder `ws` (subagent_files.main_session), '' when none is recorded."""
    from . import subagent_files  # noqa: PLC0415 — standard library only

    try:
        return subagent_files.main_session(Path(ws))
    except (OSError, ValueError):
        return ""


def _moved_to(ws: Path, sid: str) -> str:
    from . import subagent_files  # noqa: PLC0415

    try:
        return subagent_files.moved_to(subagent_files.read(Path(ws)), sid)
    except (OSError, ValueError):
        return sid


def for_session(ws: Path, rec: dict[str, Any], session: str | None, main: str | None = None) -> bool:
    """Whether the event or note `rec` is for `session` (module note): its `to` is `session`, or a session --rekey moved
    to it; with no `to`, it is main's, and `session` must be main's (any session while none is recorded). A `session`
    of None asks for main's."""
    to = str(rec.get("to") or "")
    if to:
        return bool(session) and (to == session or _moved_to(ws, to) == session)
    main = _main(ws) if main is None else main
    return session is None or not main or session == main


def held(ws: Path, session: str | None = None, *, everyone: bool = False) -> list[dict[str, Any]]:
    """The quiet events waiting for the next event or the next prompt of `session` (main's when None), as notes; every
    session's with `everyone`."""
    try:
        notes = json.loads(held_path(ws).read_text("utf-8"))
    except (OSError, ValueError):
        return []
    notes = [n for n in notes if isinstance(n, dict)] if isinstance(notes, list) else []
    if everyone:
        return notes
    main = _main(ws)
    return [n for n in notes if for_session(ws, n, session, main)]


def _keep_held(ws: Path, notes: list[dict[str, Any]]) -> None:
    path = held_path(ws)
    if notes:
        _replace(path, json.dumps(notes, ensure_ascii=False))
    else:
        with contextlib.suppress(OSError):
            path.unlink()


def hold(ws: Path, note: dict[str, Any], to: str | None = None) -> None:
    """A quiet event (events.QUIET_KINDS) held for the next event or the next prompt of session `to` (main's when
    None)."""
    path = held_path(ws)
    with locked(path):
        _keep_held(ws, [*held(ws, everyone=True), {**note, **({"to": to} if to else {})}])


def pop_held(ws: Path, session: str | None = None) -> list[dict[str, Any]]:
    """The quiet events waiting for `session` (main's when None), as notes, and no longer waiting."""
    path = held_path(ws)
    with locked(path):
        everyone = held(ws, everyone=True)
        main = _main(ws)
        mine = [n for n in everyone if for_session(ws, n, session, main)]
        if mine:
            _keep_held(ws, [n for n in everyone if not any(n is m for m in mine)])
    return [{k: v for k, v in n.items() if k != "to"} for n in mine]


def keep_held(ws: Path, notes: list[dict[str, Any]]) -> None:
    """Main's held notes replaced by `notes` (the server's, events._keep_held); the notes held for other sessions
    stay."""
    path = held_path(ws)
    with locked(path):
        main = _main(ws)
        others = [n for n in held(ws, everyone=True) if not for_session(ws, n, None, main)]
        _keep_held(ws, [*others, *notes])


def held_line(note: dict[str, Any]) -> str:
    """events.held_line: a held event as one line under MEANWHILE."""
    attrs = " ".join(f'{k}="{v}"' for k, v in (note.get("meta") or {}).items() if k != "event")
    return f"[{attrs}] {' '.join(str(note.get('content') or '').split())}"


def meanwhile(notes: list[dict[str, Any]]) -> str:
    """Held events as MEANWHILE and one line each; '' for none."""
    return "\n".join([MEANWHILE, *(held_line(h) for h in notes)]) if notes else ""


def joined(notes: list[dict[str, Any]]) -> str:
    """The events' lines in main's terminal, one per line."""
    return "\n".join(str(n.get("terminal") or "") for n in notes if n.get("terminal"))


def said(notes: list[dict[str, Any]]) -> str:
    """The lines main's held hook prints in the terminal for these events: joined, those of TOLD_IN_CHAT as their short
    line, or left out."""
    out = []
    for n in notes:
        kind = str((n.get("meta") or {}).get("kind") or "")
        line = short_line(n) if kind in TOLD_IN_CHAT else str(n.get("terminal") or "")
        if line:
            out.append(line)
    return "\n".join(out)


def short_line(note: dict[str, Any]) -> str:
    """The one short line for an event of TOLD_IN_CHAT: a thread's question in quotation marks (`new thread: "Make a
    small table card…"`), or a message to a thread after its first question (`thread "Make a small…": "And on 19
    June?"`); '' for a writer's end, whose hand-back's row says it and which opens no `● thimble` row."""
    if str((note.get("meta") or {}).get("kind") or "") != "thread":
        return ""
    line = str(note.get("terminal") or "").removeprefix(SAID)
    if line.startswith("new thread: "):
        return f'new thread: "{_cut(line.removeprefix("new thread: "), SHORT_CHARS)}"'
    m = re.match(r'^thread (\u201c[^\u201d]*\u201d|"[^"]*"): (.+)$', line)
    return f'thread {m.group(1)}: "{_cut(m.group(2), SHORT_CHARS)}"' if m else _cut(line, SHORT_CHARS)


def _cut(text: str, n: int) -> str:
    """`text` cut to `n` characters at a word, with an ellipsis right after the last word kept."""
    text = " ".join(text.split())
    if len(text) <= n:
        return text
    head = text[: n - 1]
    word = head.rsplit(" ", 1)[0]
    return (word if len(word) > n // 2 else head).rstrip(" ,;:.") + "\u2026"


# --------------------------------------------------------------------------- the queue


def append(ws: Path, note: dict[str, Any], render: Callable[[dict[str, Any]], str],
           to: str | None = None) -> dict[str, Any]:
    """An event for session `to` (main's when None; events.post on local transport): the note ({content, meta,
    terminal}) with the session's held events riding along under MEANWHILE, as the model reads it (`render`,
    events.render), appended to the queue. The record."""
    path = queue_path(ws)
    with locked(path):
        riders = pop_held(ws, to)
        shown = said([note, *riders])
        if riders:
            note = {**note, "content": f"{note.get('content') or ''}\n\n{meanwhile(riders)}",
                    "terminal": joined([note, *riders])}
        meta = note.get("meta") or {}
        rec = {"id": str(meta.get("event") or secrets.token_hex(4)), "kind": str(meta.get("kind") or ""),
               "text": render(note), "line": str(note.get("terminal") or ""), "said": shown, "at": time.time(),
               **({"to": to} if to else {})}
        _append(path, rec)
    return rec


def show(ws: Path, line: str) -> None:
    """A line for main's terminal that sends main no event (events.show), printed as main's next turn begins."""
    if line:
        path = queue_path(ws)
        with locked(path):
            _append(path, {"show": line, "at": time.time()})


def waiting(ws: Path, session: str | None = None, *, everyone: bool = False) -> list[dict[str, Any]]:
    """The events for `session` (main's when None; every session's with `everyone`) that no watcher has taken yet,
    oldest first."""
    recs = _lines(queue_path(ws))
    taken = {str(r["taken"]) for r in recs if r.get("taken")}
    left = [r for r in recs if r.get("id") and r.get("text") and str(r["id"]) not in taken]
    if everyone:
        return left
    main = _main(ws)
    return [r for r in left if for_session(ws, r, session, main)]


def take(ws: Path, session: str) -> dict[str, Any] | None:
    """The oldest event for session `session` (module note) that no watcher has taken, now taken by it; None when none
    waits."""
    path = queue_path(ws)
    if not path.exists():
        return None
    with locked(path):
        left = waiting(ws, session)
        if not left:
            return None
        rec = left[0]
        _append(path, {"taken": rec["id"], "session": session, "at": time.time()})
    return rec


def drain(ws: Path) -> list[dict[str, Any]]:
    """Main's events that no watcher has taken, oldest first, each now taken by the server (SERVER_TAKER), which queues
    them for main's watcher's pull (module note); [] when none waits."""
    path = queue_path(ws)
    if not path.exists():
        return []
    with locked(path):
        left = waiting(ws)
        if left:
            now = time.time()
            _append(path, *({"taken": r["id"], "session": SERVER_TAKER, "at": now} for r in left))
    return left


def unshown(ws: Path, session: str) -> list[str]:
    """The lines main's terminal shows as main's next turn begins (the held hook): those of the events `session`'s
    watcher took that were not shown yet, and the lines that send main no event; each shown once."""
    path = queue_path(ws)
    if not path.exists():
        return []
    with locked(path):
        recs = _lines(path)
        by_id = {str(r["id"]): r for r in recs if r.get("id")}
        shown = {str(r["shown"]) for r in recs if r.get("shown")}
        out, marks = [], []
        for r in recs:
            if r.get("taken") and r.get("session") == session and str(r["taken"]) not in shown:
                ev = by_id.get(str(r["taken"])) or {}
                line = str(ev.get("said") if "said" in ev else ev.get("line") or "")
                marks.append({"shown": str(r["taken"])})
                shown.add(str(r["taken"]))
                if line:
                    out.append(line)
            elif r.get("show") is not None and not r.get("done"):
                out.append(str(r["show"]))
        if marks or any(r.get("show") is not None and not r.get("done") for r in recs):
            kept = [{**r, "done": True} if r.get("show") is not None else r for r in recs]
            _replace(path, "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in [*kept, *marks]))
    return list(dict.fromkeys(x for x in out if x))


def posted(ws: Path, event_id: str) -> bool:
    """Whether the event `event_id` was posted through the queue, so the mirror counts it as thimble's own (it reaches
    main's transcript when the watcher wakes main with it)."""
    return bool(event_id) and any(r.get("id") == event_id for r in _lines(queue_path(ws)))


def queued_words(ws: Path, session: str | None = None) -> list[str]:
    """The analyst's words of the events waiting for `session` (main's when None; their lines after SAID), for the
    statusline."""
    return [str(r.get("line") or "")[len(SAID):] for r in waiting(ws, session) if str(r.get("line") or "").startswith(SAID)]
