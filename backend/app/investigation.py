"""The workspace event stream and the document directory, workspaces/<c>/investigations/main/ (created on first touch).

The directory holds the documents and events.jsonl, the workspace event stream: append-only JSONL stamped {ts, seq} by
emit(). seq is monotonic, and GET /ws/{c}/events replays from any seq (Last-Event-ID or ?after=), so a reload or a
restart loses nothing. When the whole log is replaced (`/thimble fresh`, `resume`), the stream sends `reset` and replays
the new log from its start. Every module emits through emit(c, "main", event): one writer, one seq counter.

emit() runs on the event-loop thread only; a module that must emit from a thread schedules it onto the loop. A torn last
line (a crash mid-append) is healed before the next append and skipped by the reader.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from sse_starlette import EventSourceResponse, ServerSentEvent

from . import config
from .ledger import append_jsonl, write_json_once

log = logging.getLogger("thimble.investigation")
router = APIRouter()

ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
MAIN = "main"  # the one investigation: every document and the event stream live under it


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _created() -> str:
    """Microseconds, so list order is creation order even within one second (notebook._created)."""
    return datetime.now(timezone.utc).isoformat(timespec="microseconds")


def _ws(workspace: str) -> Path:
    try:
        return config.workspace_dir(workspace)
    except ValueError as e:
        raise HTTPException(404, str(e)) from e


# ----------------------------------------------------------------------------------------------------------
# storage
# ----------------------------------------------------------------------------------------------------------


def inv_dir(c: str, inv_id: str) -> Path:
    """workspaces/<c>/investigations/<id>. Raises 404 for a malformed id (which would otherwise escape the dir)."""
    if not ID_RE.match(inv_id or ""):
        raise HTTPException(404, f"invalid investigation id: {inv_id!r}")
    return _ws(c) / "investigations" / inv_id


def _existing(c: str, inv_id: str) -> Path:
    d = inv_dir(c, inv_id)
    if not d.is_dir():
        if inv_id == MAIN:
            return ensure_main(c)
        raise HTTPException(404, f"no such investigation: {inv_id}")
    return d


def ensure_main(c: str) -> Path:
    """workspaces/<c>/investigations/main, created on first touch (the event stream, a document). 404 for an unknown
    workspace."""
    d = inv_dir(c, MAIN)
    if not d.is_dir():
        d.mkdir(parents=True, exist_ok=True)
    if not (d / "investigation.json").is_file():
        # several first-touch requests get here together: each writes a temp of its own and the first to land is kept
        write_json_once(d / "investigation.json", {"id": MAIN, "title": "", "created": _created()})
    return d


def _read_jsonl(path: Path) -> list[dict]:
    """Every parseable object line. A torn last line (a crash mid-append) is skipped, never a failure."""
    out: list[dict] = []
    if not path.is_file():
        return out
    for line in path.read_text("utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except ValueError:
            log.warning("skipping malformed line in %s", path)
            continue
        if isinstance(rec, dict):
            out.append(rec)
    return out


# --- progress events ---------------------------------------------------------------------------------------

_subscribers: dict[tuple[str, str], set[asyncio.Queue]] = {}  # (workspace, investigation id) -> queues
EVENTS_POLL_S = 3.0  # how often an idle SSE subscriber re-reads events.jsonl for another process's events
_seq: dict[tuple[str, str], int] = {}  # next seq per investigation; recounted from events.jsonl when unknown
_RESET = object()  # queued to a subscriber when the workspace's log was replaced (reset_streams)


def log_id(c: str, inv_id: str = MAIN) -> str:
    """Which log the stream serves: the investigation's creation stamp. The tab sends it back on reopen (?log=), so a
    reopen onto another log is told apart even when seq numbers overlap."""
    try:
        data = json.loads((inv_dir(c, inv_id) / "investigation.json").read_text("utf-8"))
    except (OSError, ValueError):
        return ""
    return str(data.get("created") or "") if isinstance(data, dict) else ""


def reset_streams(c: str, inv_id: str = MAIN) -> None:
    """The workspace's log was replaced: forget its seq counter and tell every open stream to start over."""
    key = (c, inv_id)
    _seq.pop(key, None)
    for q in _subscribers.get(key, ()):
        q.put_nowait(_RESET)


def _last_stored_seq(path: Path) -> int:
    """The highest seq in the file's tail (-1 when none): another process may have appended since this process last
    did."""
    try:
        with open(path, "rb") as f:
            f.seek(0, 2)
            size = f.tell()
            f.seek(max(0, size - 16_384))
            tail = f.read().decode("utf-8", "replace")
    except OSError:
        return -1
    best = -1
    for line in tail.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            e = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(e, dict) and isinstance(e.get("seq"), int):
            best = max(best, e["seq"])
    return best


def _next_seq(key: tuple[str, str], path: Path) -> int:
    n = _seq.get(key)
    if n is None:
        # Resume after the highest stored seq, never at the line count: _read_jsonl skips a corrupted line, so the count
        # could collide with a stored seq and the SSE replay dedupe would drop the new event.
        seqs = [e["seq"] for e in _read_jsonl(path) if isinstance(e.get("seq"), int)]
        n = max(seqs) + 1 if seqs else 0
    else:
        n = max(n, _last_stored_seq(path) + 1)  # never below what another process already wrote
    _seq[key] = n + 1
    return n


def _append_line(path: Path, obj: dict) -> None:
    """append_jsonl, healing a torn tail first, so a new record is not glued onto a fragment left by a crash mid-append.
    """
    try:
        with open(path, "rb") as f:
            f.seek(-1, 2)
            torn = f.read(1) != b"\n"
    except OSError:  # no file yet, or an empty one (seek(-1) past the start): nothing to heal
        torn = False
    if torn:
        with open(path, "ab") as f:
            f.write(b"\n")
    append_jsonl(path, obj)


def emit(c: str, inv_id: str, event: dict) -> None:
    """Stamp {ts, seq} onto the event, append it to events.jsonl and push it to live SSE subscribers. Event-loop thread
    only; calling from a worker thread raises."""
    asyncio.get_running_loop()  # raises RuntimeError off the event-loop thread: that caller is the bug
    d = _existing(c, inv_id)
    key = (c, inv_id)
    ev = {**event, "ts": _now(), "seq": _next_seq(key, d / "events.jsonl")}
    _append_line(d / "events.jsonl", ev)
    for q in _subscribers.get(key, ()):
        q.put_nowait(ev)


# ----------------------------------------------------------------------------------------------------------
# routes
# ----------------------------------------------------------------------------------------------------------


def _top(events: list[dict]) -> int:
    """The highest seq among the records, -1 for none."""
    return max((e["seq"] for e in events if isinstance(e.get("seq"), int)), default=-1)


async def _stream(c: str, inv_id: str, request: Request, after: int | None = None,
                  log: str | None = None) -> EventSourceResponse:
    """Every SSE record carries id = seq, so `Last-Event-ID` or ?after=<seq> replays from seq+1 and then streams live;
    with neither, the whole history replays first. A `live` event (carrying log_id) follows the replay, so the browser
    tells history from new records. A reopen onto another log, or a log replaced under an open stream, gets `reset`
    first."""
    d = _existing(c, inv_id)
    if after is None:
        lei = request.headers.get("last-event-id")
        if lei is not None:
            try:
                after = int(lei)
            except ValueError:
                after = None
    key = (c, inv_id)
    q: asyncio.Queue = asyncio.Queue()
    _subscribers.setdefault(key, set()).add(q)  # subscribe BEFORE reading the file: no event can fall in the gap
    stored = _read_jsonl(d / "events.jsonl")
    moved = (after is not None and after > _top(stored)) or bool(log and log != log_id(c, inv_id))

    def history(events: list[dict], last: int):
        """The records after `last`, then `live` with the log's id."""
        for ev in events:
            if isinstance(ev.get("seq"), int) and ev["seq"] > last:
                last = ev["seq"]
                yield {"data": json.dumps(ev, ensure_ascii=False), "id": str(ev["seq"])}
        yield {"event": "live", "data": json.dumps({"log": log_id(c, inv_id)})}

    async def gen():
        last = -1 if after is None or moved else after
        # A comment first, so a proxy (Vite's in dev mode) passes the headers on at once and EventSource opens now.
        yield {"comment": "open"}
        try:
            if moved:
                yield {"event": "reset", "data": "{}"}
            for rec in history(stored, last):
                yield rec
            last = max(last, _top(stored))
            while True:
                try:
                    ev = await asyncio.wait_for(q.get(), timeout=EVENTS_POLL_S)
                except asyncio.TimeoutError:
                    # nothing from this process: tail the file for events another process wrote
                    for ev in _read_jsonl(d / "events.jsonl"):
                        if isinstance(ev.get("seq"), int) and ev["seq"] > last:
                            last = ev["seq"]
                            yield {"data": json.dumps(ev, ensure_ascii=False), "id": str(ev["seq"])}
                    continue
                if ev is _RESET:  # the log was replaced under this stream: start over on the new one
                    fresh = _read_jsonl(d / "events.jsonl")
                    yield {"event": "reset", "data": "{}"}
                    for rec in history(fresh, -1):
                        yield rec
                    last = _top(fresh)
                    continue
                if isinstance(ev.get("seq"), int) and ev["seq"] > last:  # already replayed events are skipped
                    last = ev["seq"]
                    yield {"data": json.dumps(ev, ensure_ascii=False), "id": str(ev["seq"])}
        finally:
            _subscribers.get(key, set()).discard(q)

    return EventSourceResponse(gen(), ping=15, ping_message_factory=lambda: ServerSentEvent(data="{}", event="ping"))


@router.get("/ws/{c}/events")
async def workspace_events(c: str, request: Request, after: int | None = None,
                           log: str | None = None) -> EventSourceResponse:
    """The workspace event stream."""
    return await _stream(c, MAIN, request, after, log)
