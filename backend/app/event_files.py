"""Events to main in terminal mode, where no server holds them (events.py has the design of browser mode). Every process
of the session that posts an event (the MCP shim, the hooks' backend calls, the renderer's acts) writes it to a file in
the workspace, and main's watcher (plugin/bin/.thimble-watch, the asyncRewake hook) takes it from there:

  events/queue.jsonl   one line per event, as the model reads it: {id, kind, text, line, at}; then, once main's watcher
                       took it, {taken: id, session, at}, which wakes main with `text`; once main's held hook printed
                       its `line` in the terminal, {shown: id}. A line for main's terminal that sends main no event
                       (events.show) is {show: line, at}. Trimmed to the lines still needed once it grows past
                       TRIM_BYTES.
  held-events.json     the quiet events (events.QUIET_KINDS) as notes, which ask main for nothing: they ride along with
                       the next event under MEANWHILE, or with main's next prompt (the held hook), as in browser mode,
                       whose file this is.

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


def held(ws: Path) -> list[dict[str, Any]]:
    """The quiet events waiting for the next event or main's next prompt, as notes."""
    try:
        notes = json.loads(held_path(ws).read_text("utf-8"))
    except (OSError, ValueError):
        return []
    return [n for n in notes if isinstance(n, dict)] if isinstance(notes, list) else []


def _keep_held(ws: Path, notes: list[dict[str, Any]]) -> None:
    path = held_path(ws)
    if notes:
        _replace(path, json.dumps(notes, ensure_ascii=False))
    else:
        with contextlib.suppress(OSError):
            path.unlink()


def hold(ws: Path, note: dict[str, Any]) -> None:
    """A quiet event (events.QUIET_KINDS) held for the next event or main's next prompt."""
    path = held_path(ws)
    with locked(path):
        _keep_held(ws, [*held(ws), note])


def pop_held(ws: Path) -> list[dict[str, Any]]:
    """The quiet events waiting, as notes, and no longer waiting."""
    path = held_path(ws)
    with locked(path):
        notes = held(ws)
        if notes:
            _keep_held(ws, [])
    return notes


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


# --------------------------------------------------------------------------- the queue


def append(ws: Path, note: dict[str, Any], render: Callable[[dict[str, Any]], str]) -> dict[str, Any]:
    """An event for main (events.post in terminal mode): the note ({content, meta, terminal}) with the held events
    riding along under MEANWHILE, as the model reads it (`render`, events.render), appended to the queue. The record."""
    path = queue_path(ws)
    with locked(path):
        riders = pop_held(ws)
        if riders:
            note = {**note, "content": f"{note.get('content') or ''}\n\n{meanwhile(riders)}",
                    "terminal": joined([note, *riders])}
        meta = note.get("meta") or {}
        rec = {"id": str(meta.get("event") or secrets.token_hex(4)), "kind": str(meta.get("kind") or ""),
               "text": render(note), "line": str(note.get("terminal") or ""), "at": time.time()}
        _append(path, rec)
    return rec


def show(ws: Path, line: str) -> None:
    """A line for main's terminal that sends main no event (events.show), printed as main's next turn begins."""
    if line:
        path = queue_path(ws)
        with locked(path):
            _append(path, {"show": line, "at": time.time()})


def waiting(ws: Path) -> list[dict[str, Any]]:
    """The events main's watcher has not taken yet, oldest first."""
    recs = _lines(queue_path(ws))
    taken = {str(r["taken"]) for r in recs if r.get("taken")}
    return [r for r in recs if r.get("id") and r.get("text") and str(r["id"]) not in taken]


def take(ws: Path, session: str) -> dict[str, Any] | None:
    """The oldest event main's watcher has not taken, now taken by main's session `session`; None when none waits."""
    path = queue_path(ws)
    if not path.exists():
        return None
    with locked(path):
        left = waiting(ws)
        if not left:
            return None
        rec = left[0]
        _append(path, {"taken": rec["id"], "session": session, "at": time.time()})
    return rec


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
                line = str((by_id.get(str(r["taken"])) or {}).get("line") or "")
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


def queued_words(ws: Path) -> list[str]:
    """The analyst's words of the events waiting for main (their lines after SAID), for the statusline."""
    return [str(r.get("line") or "")[len(SAID):] for r in waiting(ws) if str(r.get("line") or "").startswith(SAID)]
