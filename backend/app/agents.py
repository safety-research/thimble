"""Chats: main, its threads and the background agents, stored and served. No model runs here.

Main is the analyst's Claude Code session, which the browser mirrors (session.py). A thread is born from a ⌘-click or
⌘-drag, carries its anchor, and runs as a fork of main (threads.py). An agent chat is background work with a `status`,
started through `start_agent`.

Storage: `workspaces/<c>/chats/<id>.meta.json` and `<id>.jsonl`, append-only, a record's line index its id. Records:
`user`, `text`, `tool_use`, `tool_result`, `done`, `error`, `chip` (an act with no reply, appended to main) and `agent`
(a spawned agent chat, appended to main). Whether a chat is running is kept in memory (set_running).
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import re
import secrets
import threading
from collections import OrderedDict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Awaitable, Callable

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel

from . import config, investigation, ledger, tools
from .ledger import atomic_write_text

log = logging.getLogger("thimble.agents")
router = APIRouter()


# --------------------------------------------------------------------------- constants

KIND_MAIN, KIND_THREAD, KIND_AGENT = "main", "thread", "agent"
KINDS = (KIND_MAIN, KIND_THREAD, KIND_AGENT)
MAIN_ID = "main"
ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
CELL_REF_RE = re.compile(r"^(?:card|cell):([A-Za-z0-9_-]+)")  # a card ref, by either prefix (cite.CARD_RE)
SUMMARY_LIMIT = 300  # chars of a tool result kept in the log
STOPPED_LINE = "stopped"
AGENT_STATUSES = ("running", "done", "failed", "stopped")
# the browser's SSE reads these; a coalesced `chat` record on the workspace stream tells every other page to re-read
EVENT_COALESCE_S = 0.25
# `by` of the analyst's line: typed in the terminal (the mirror reads it from the transcript) or in the browser (logged
# when the browser event is posted)
TERMINAL, BROWSER = "terminal", "browser"
ANCHOR_TEXT_CHARS = 2_000  # of what the pointed-at element showed, kept on the thread's meta


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def _ws(c: str) -> Path:
    try:
        return config.workspace_dir(c)
    except ValueError as e:
        raise HTTPException(404, str(e)) from e


# --------------------------------------------------------------------------- storage


def chats_dir(c: str) -> Path:
    d = _ws(c) / "chats"
    d.mkdir(parents=True, exist_ok=True)
    return d


def paths(c: str, chat_id: str) -> tuple[Path, Path]:
    """(meta path, log path). 404 on a malformed id so nothing escapes chats/."""
    if not ID_RE.match(chat_id or ""):
        raise HTTPException(404, f"invalid chat id: {chat_id!r}")
    d = chats_dir(c)
    return d / f"{chat_id}.meta.json", d / f"{chat_id}.jsonl"


def read_meta(c: str, chat_id: str) -> dict:
    meta_path, _ = paths(c, chat_id)
    if not meta_path.is_file():
        raise HTTPException(404, f"no such chat: {chat_id}")
    return _defaults(json.loads(meta_path.read_text("utf-8")))


def meta_or_none(c: str, chat_id: str) -> dict | None:
    try:
        return read_meta(c, chat_id)
    except HTTPException:
        return None


def write_meta(c: str, meta: dict) -> None:
    """Replace the chat's meta whole, under its lock (ledger.locked), which a caller that read the meta to change it
    holds already (change_meta)."""
    meta_path, _ = paths(c, meta["id"])
    with ledger.locked(meta_path):
        atomic_write_text(meta_path, json.dumps(meta, indent=1))


def change_meta(c: str, chat_id: str, change: Callable[[dict], Any]) -> dict:
    """Read the chat's meta, pass it to `change`, which changes it in place, and write it, all under the meta's lock:
    the mirror, the tools and `thimble act` change metas from more than one process in terminal mode. 404 for a chat
    that does not exist."""
    meta_path, _ = paths(c, chat_id)
    with ledger.locked(meta_path):
        meta = read_meta(c, chat_id)
        change(meta)
        write_meta(c, meta)
    return meta


def _defaults(meta: dict) -> dict:
    meta.setdefault("kind", KIND_THREAD if meta.get("anchor") else KIND_MAIN)
    meta.setdefault("role", meta["kind"] if meta["kind"] != KIND_AGENT else "agent")
    meta.setdefault("title", "")
    meta.setdefault("parent", None if meta["kind"] == KIND_MAIN else MAIN_ID)
    meta.setdefault("anchor", None)
    meta.setdefault("anchor_text", None)
    meta.setdefault("model", None)
    meta.setdefault("effort", None)
    meta.setdefault("group", None)  # the canvas group (a notebook id) this chat's cards land in; made on first use
    if meta["kind"] == KIND_MAIN:
        meta.setdefault("attached", None)  # the Claude Code session that is main, {session, cwd, since, model?} (session.py)
    if meta["kind"] == KIND_THREAD:
        meta.setdefault("fork", None)  # {agent_id, tool_use_id, session} of main's fork for it, once the mirror found it (threads.py)
    if meta["kind"] == KIND_AGENT:
        meta.setdefault("status", "running")
        meta.setdefault("result", None)
        meta.setdefault("ts_end", None)
    return meta


def append(log_path: Path, record: dict) -> None:
    """Append one record to a chat's log under the log's lock, since a record's line index is its id and more than one
    process appends in terminal mode (the mirror, the tools)."""
    with ledger.locked(log_path):
        ledger.heal_tail(log_path)
        with log_path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")


# workspaces/<c>/permissions.jsonl: each permission request of the workspace's sessions and its answer, which a problem
# report carries (feedback.py). Past PERMISSIONS_LOG_MAX it starts again, the previous log kept as permissions.1.jsonl.
PERMISSIONS_LOG = "permissions.jsonl"
PERMISSIONS_LOG_MAX = 5_000_000


def log_permission(c: str, event: str, **fields: Any) -> None:
    """One line of the permission log: `asked` (a request, as its card shows it) or `answered` (with `answer`). It
    never raises, since a log that cannot be written must not hold up the answer."""
    try:
        p = _ws(c) / PERMISSIONS_LOG
        if p.is_file() and p.stat().st_size > PERMISSIONS_LOG_MAX:
            p.replace(p.with_name("permissions.1.jsonl"))
        append(p, {"ts": _now(), "event": event, **{k: v for k, v in fields.items() if v is not None}})
    except Exception:  # noqa: BLE001
        log.warning("%s: the permission log could not be written", c, exc_info=True)


def count_lines(path: Path) -> int:
    if not path.is_file():
        return 0
    with path.open("rb") as f:
        return sum(1 for _ in f)


def read_events(log_path: Path) -> list[dict]:
    if not log_path.is_file():
        return []
    out: list[dict] = []
    with log_path.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                log.warning("skipping a bad line in %s", log_path)
    return out


class _Tally:
    """What has been read of one chat log: up to `offset`, the end of its last whole line, whose last bytes are `tail`;
    the counts _stats gives, and in `lines`, when kept, the text of each record for the chat's route."""

    __slots__ = ("ino", "offset", "tail", "n", "last", "lines", "seen")

    def __init__(self, ino: int, keep: bool) -> None:
        self.ino, self.offset, self.tail, self.n, self.last = ino, 0, b"", 0, None
        self.lines: list[bytes] | None = [] if keep else None
        self.seen: tuple[int, int, int] | None = None  # the log's (inode, size, mtime) when it was last read


_tallies: dict[str, _Tally] = {}
_kept: OrderedDict[str, None] = OrderedDict()  # the logs whose tallies keep their records' text, least recent first
_tallies_lock = threading.Lock()
TALLY_TAIL = 64  # bytes before a tally's offset it compares, to tell a log that grew from one written again
KEPT_LOGS = 16  # chat logs whose records' text is kept for the chat route


def _read_on(log_path: Path, keep: bool = False) -> _Tally | None:
    """The log's tally brought up to date (None when it cannot be read). A chat's log only grows, so the read goes on
    from where the last one stopped; a log that is shorter, another file, or changed before that point is read from its
    start. With `keep` the records' text is kept too."""
    key = str(log_path)
    with _tallies_lock:
        t = _tallies.get(key)
        try:
            st = os.stat(log_path)
        except OSError:
            _tallies.pop(key, None)
            return None
        if t is not None and t.seen == (st.st_ino, st.st_size, st.st_mtime_ns) and not (keep and t.lines is None):
            if keep and key in _kept:
                _kept.move_to_end(key)
            return t
        try:
            with log_path.open("rb") as f:
                st = os.fstat(f.fileno())
                if t is not None and (t.ino != st.st_ino or st.st_size < t.offset or (keep and t.lines is None)):
                    t = None
                if t is not None and t.tail:
                    f.seek(t.offset - len(t.tail))
                    if f.read(len(t.tail)) != t.tail:
                        t = None
                if t is None:
                    t = _Tally(st.st_ino, keep)
                f.seek(t.offset)
                data = f.read(max(0, st.st_size - t.offset))
        except OSError:
            _tallies.pop(key, None)
            return None
        whole = data[:data.rfind(b"\n") + 1]
        for line in whole.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                r = json.loads(line)
            except ValueError:
                log.warning("skipping a bad line in %s", log_path)
                continue
            if t.lines is not None:
                t.lines.append(_strict(line, r))
            if not isinstance(r, dict):
                continue
            if r.get("type") in ("user", "done", "chip", "agent"):
                t.n += 1
            if r.get("ts"):
                t.last = r["ts"]
        if whole:
            t.tail = (t.tail + whole)[-TALLY_TAIL:]
            t.offset += len(whole)
        t.seen = (st.st_ino, st.st_size, st.st_mtime_ns)
        _tallies[key] = t
        if t.lines is not None:
            _kept[key] = None
            _kept.move_to_end(key)
            while len(_kept) > KEPT_LOGS:
                old = _tallies.get(_kept.popitem(last=False)[0])
                if old is not None:
                    old.lines = None
        return t


def _finite(v: Any) -> Any:
    if isinstance(v, float) and (v != v or v in (float("inf"), float("-inf"))):
        return None
    if isinstance(v, dict):
        return {k: _finite(x) for k, x in v.items()}
    if isinstance(v, list):
        return [_finite(x) for x in v]
    return v


def _strict(line: bytes, record: Any) -> bytes:
    """A record's text as strict JSON, which a browser parses: as the log holds it, unless it may hold a NaN or an
    infinity, which Python writes and reads but JSON has not, and which then read as null."""
    if b"NaN" not in line and b"Infinity" not in line:
        return line
    return json.dumps(_finite(record), ensure_ascii=False).encode("utf-8")


def _stats(log_path: Path) -> tuple[int, str | None]:
    """(records that are the analyst's messages or the model's replies, the last timestamp)."""
    t = _read_on(log_path)
    return (t.n, t.last) if t is not None else (0, None)


def events_json(log_path: Path) -> bytes:
    """The log's records as a JSON array, as read_events reads them, each record's text as the log holds it."""
    t = _read_on(log_path, keep=True)
    lines = t.lines if t is not None and t.lines is not None else []
    return b"[" + b",".join(lines) + b"]"


def chat_response(meta: dict, log_path: Path) -> Response:
    """{meta, events}, the chat route's answer, made from the records' text as the log holds it and kept between reads
    (events_json), since the browser reads a chat again on every record it gets."""
    body = b'{"meta":' + json.dumps(meta, ensure_ascii=False).encode("utf-8") + b',"events":' + events_json(log_path) + b"}"
    return Response(content=body, media_type="application/json")


# the /thimble skill's own line in main (the mirror writes a slash command as its command line, `/thimble:thimble`)
THIMBLE_COMMAND_RE = re.compile(r"^/thimble(?::thimble)?(?:\s|$)")


def held_chats(ws: Path) -> int:
    """How many chats in the workspace folder `ws` hold a `user` record other than the /thimble command every session opens
    with. Read from ws/chats, creating nothing."""
    d = ws / "chats"
    if not d.is_dir():
        return 0
    return sum(1 for p in d.glob("*.jsonl")
               if any(r.get("type") == "user" and not THIMBLE_COMMAND_RE.match(str(r.get("text") or "").strip())
                      for r in read_events(p)))


def ensure_main(c: str) -> dict:
    """The workspace's main chat, created on first touch."""
    meta = meta_or_none(c, MAIN_ID)
    if meta is None:
        meta = _defaults({"id": MAIN_ID, "kind": KIND_MAIN, "role": "main", "title": "main", "created_at": _now()})
        write_meta(c, meta)
        _, log_path = paths(c, MAIN_ID)
        log_path.touch()
    return meta


def new_thread(c: str, anchor: str | None, anchor_text: str | None, title: str | None = None, *,
               surface: str | None = None, element: str | None = None, selector: str | None = None,
               image: str | None = None, parent: str | None = None, comment: str | None = None) -> dict:
    """A thread born from a ⌘-click or ⌘-drag: `anchor` is what was pointed at (refs joined by ','), with its visible text,
    surface, element kind, CSS selector and a captured PNG. `parent` is the chat the analyst was reading (thread_parent).
    `comment` is the id of the comment whose Ask opened it, kept as `anchor_comment` (comments.thread_comment), so its
    anchor line names the comment as well as its passage or step. Its first message is a browser event of kind `thread`,
    which main answers by forking."""
    from . import comments, threads  # noqa: PLC0415

    ensure_main(c)
    cid = secrets.token_hex(4)
    clean = lambda v, n=200: (str(v or "").strip()[:n] or None)  # noqa: E731
    named = (title or "").strip() or _title_from(anchor, anchor_text)
    # the terminal names a thread by its first question and its subject by the citation's or the passage's words, which
    # a -2 would change; its fork's name is kept apart from other threads' all the same (threads.fork_name)
    named = named if surface == "terminal" else _unique_title(c, named)
    meta = _defaults({"id": cid, "kind": KIND_THREAD, "role": "thread", "title": named,
                      "created_at": _now(), "parent": thread_parent(c, parent, anchor, element), "anchor": clean(anchor, 4000),
                      "anchor_text": clean(anchor_text, ANCHOR_TEXT_CHARS), "anchor_surface": clean(surface, 40),
                      "anchor_element": clean(element, 80), "anchor_selector": clean(selector, 400)})
    meta["anchor_image"] = threads.save_image(c, cid, image) if image else None
    try:
        meta["anchor_comment"] = comments.thread_comment(c, comment) if comment else None
    except Exception:  # noqa: BLE001 — a thread whose line cannot name its comment still opens
        log.warning("%s: thread %s: comment %s not read", c, cid, comment, exc_info=True)
        meta["anchor_comment"] = None
    write_meta(c, meta)
    _, log_path = paths(c, cid)
    log_path.touch()
    log.info("%s: thread %s opened on %s from %s (%s)", c, cid, (meta["anchor"] or "-")[:120], meta["parent"],
             meta["anchor_surface"] or "-")
    _notify(c, cid)
    return meta


_CHAT_ANCHOR_RE = re.compile(r"^(?:chat:([A-Za-z0-9_-]{1,64})(?:#|$)|call:([A-Za-z0-9_-]{1,64})/)")
_VIEW_ANCHOR_RE = re.compile(r"^view:([a-z0-9][a-z0-9-]{0,39})(?:[/#]|$)")


def view_chat(c: str, slug: str) -> str | None:
    """The dev chat that builds and changes the view `slug`: its proposal's chat, else the latest dev chat opened for
    it; None when it has none."""
    from . import views  # noqa: PLC0415

    chat = str((views.read_proposal(c, slug) or {}).get("chat") or "")
    if chat and meta_or_none(c, chat) is not None:
        return chat
    builds = [m for m in list_chats(c) if m.get("role") == "dev" and m.get("view") == slug]
    return str(max(builds, key=lambda m: str(m.get("created_at") or ""))["id"]) if builds else None


def thread_parent(c: str, parent: str | None, anchor: str | None, element: str | None = None) -> str:
    """The chat a new thread hangs under: the one the browser names, else the chat the anchor's first ref points into, else
    the dev chat of the view it is about, else main."""
    first = str(anchor or "").split(",", 1)[0].strip()
    m = _CHAT_ANCHOR_RE.match(first)
    for cand in (parent, (m.group(1) or m.group(2)) if m else None):
        cand = str(cand or "").strip()
        if cand and ID_RE.match(cand) and (cand == MAIN_ID or meta_or_none(c, cand) is not None):
            return cand
    v = _VIEW_ANCHOR_RE.match(str(element or "").strip()) or _VIEW_ANCHOR_RE.match(first)
    return (view_chat(c, v.group(1)) if v else None) or MAIN_ID


def _unique_title(c: str, title: str) -> str:
    """`title`, or `title-2`, `title-3` … when a thread already has it, so two threads on records that open alike have
    two names in the tree and in the chips."""
    taken = {str(m.get("title") or "") for m in list_chats(c) if m.get("kind") == KIND_THREAD}
    if title not in taken:
        return title
    n = 2
    while f"{title}-{n}" in taken:
        n += 1
    return f"{title}-{n}"


def _title_from(anchor: str | None, text: str | None) -> str:
    """`main/<slug>`'s slug part: from the pointed-at text when there is any, else the anchor's kind."""
    words = re.findall(r"[A-Za-z0-9]+", (text or "")[:80])
    if words:
        return "-".join(w.lower() for w in words[:4])
    a = (anchor or "").split(":", 1)[0]
    return {"cell": "card"}.get(a, a) or "thread"  # a card's anchor may be written as `cell:`


_meta_texts: dict[str, tuple[tuple[int, int, int], str]] = {}  # meta file -> ((inode, mtime_ns, size), its text)
META_SUFFIX = ".meta.json"


def _meta_text(path: str) -> str:
    """A meta file's text, read again only when the file changed (write_meta replaces it whole)."""
    st = os.stat(path)
    key = (st.st_ino, st.st_mtime_ns, st.st_size)
    hit = _meta_texts.get(path)
    if hit is not None and hit[0] == key:
        return hit[1]
    with open(path, encoding="utf-8") as f:
        text = f.read()
    _meta_texts[path] = (key, text)
    return text


def list_chats(c: str) -> list[dict]:
    ensure_main(c)
    out: list[dict] = []
    d = str(chats_dir(c))
    try:
        with os.scandir(d) as it:
            names = [e.name for e in it if e.name.endswith(META_SUFFIX)]
    except OSError:
        names = []
    for name in names:
        p = f"{d}/{name}"
        try:
            meta = _defaults(json.loads(_meta_text(p)))
        except (ValueError, OSError):
            log.warning("bad meta file %s", p)
            continue
        n, last = _stats(Path(f"{d}/{name[:-len(META_SUFFIX)]}.jsonl"))
        meta["n_messages"] = n
        meta["last_ts"] = last or meta.get("created_at")
        meta["running"] = _running(c, meta["id"])
        out.append(meta)
    out.sort(key=lambda m: (m["kind"] != KIND_MAIN, m.get("created_at") or ""))
    return out


# --------------------------------------------------------------------------- where a chat's cards land


def group_for(c: str, meta: dict) -> str:
    """The canvas group (a notebook id) a chat's cards land in: main's is the analyst's own group; a thread's is a group
    of its own beside its anchor, made on first use and remembered on the meta."""
    if meta.get("kind") == KIND_MAIN or meta.get("kind") == KIND_AGENT:
        return tools.analyst_notebook(c)
    if meta.get("group"):
        from . import notebook  # noqa: PLC0415

        if notebook.read_notebook(_ws(c), str(meta["group"])) is not None:
            return str(meta["group"])
    from . import notebook  # noqa: PLC0415

    anchor = str(meta.get("anchor") or "")
    m = CELL_REF_RE.match(anchor)
    parent = None
    if m:
        hit = notebook.find_cell(_ws(c), m.group(1))
        parent = hit[0] if hit else None
    nb = notebook.create_notebook(_ws(c), f"main/{meta.get('title') or meta['id']}", role=notebook.DEFAULT_ROLE,
                                  parent=parent, anchor=m.group(1) if m else None, chat=meta["id"])
    meta["group"] = nb["id"]
    change_meta(c, str(meta["id"]), lambda m_: m_.update(group=nb["id"]))
    return nb["id"]


# --------------------------------------------------------------------------- running, and the cards a chat made


_busy: set[tuple[str, str]] = set()  # (workspace, chat) running for browser events and the mirror


def set_running(c: str, chat_id: str, on: bool) -> None:
    """Mark a chat running or not (main while the session's turn is open, a thread while its event waits or its fork
    runs), and tell the pages when that changed."""
    key = (c, chat_id)
    if on == (key in _busy):
        return
    if on:
        _busy.add(key)
    else:
        _busy.discard(key)
    _notify(c, chat_id)


def _running(c: str, chat_id: str) -> bool:
    return (c, chat_id) in _busy or (c, chat_id) in _agent_tasks


def running(c: str, chat_id: str) -> bool:
    """Whether a chat is running: main while its session's turn is open, a thread while its event waits or its fork
    runs (set_running), an agent chat while its task runs."""
    return _running(c, chat_id)


_CELL_LINE_RE = re.compile(r"^(?:card|cell):([A-Za-z0-9_-]+)$", re.M)


def cell_id(text: str) -> str | None:
    m = _CELL_LINE_RE.search(text or "")
    return m.group(1) if m else None


CLAIM_EDIT_S = 120  # an `edited` entry this recent is the edit_card call the mirror just read (claim_cell)


def claim_cell(c: str, cid: str, chat_id: str, *, edit: bool = False) -> None:
    """Credit a card a subagent or thread fork made (add_card) or changed (edit_card) to its chat. Every card from the shared
    shim is stamped `terminal`; the mirror knows whose transcript a call is in and replaces that stamp with `chat:<id>`."""
    if not cid or not chat_id:
        return
    try:
        from . import notebook  # noqa: PLC0415

        ws = notebook._ws(c)
        with notebook.editing(ws):
            _claim(c, ws, cid, chat_id, edit)
    except Exception:  # noqa: BLE001 — who made a card is bookkeeping; it never breaks the mirror
        log.debug("could not credit cell %s to chat %s", cid, chat_id, exc_info=True)


def _claim(c: str, ws: Path, cid: str, chat_id: str, edit: bool) -> None:
    """claim_cell's change, with the groups' lock held."""
    from . import notebook  # noqa: PLC0415

    hit = notebook._locate(ws, cid)
    if hit is None:
        return
    nb, cell = hit
    who = f"chat:{chat_id}"
    changed = False
    if edit:
        last = (cell.get("edited") or [None])[-1]
        if isinstance(last, dict) and last.get("by") == tools.TERMINAL:
            try:
                age = (datetime.now(timezone.utc) - datetime.fromisoformat(str(last.get("ts")))).total_seconds()
            except ValueError:
                age = CLAIM_EDIT_S + 1
            if age <= CLAIM_EDIT_S:
                last["by"] = who
                changed = True
    elif cell.get("created_by") == tools.TERMINAL:
        kernel = notebook._kernel_for(nb, None, cell, ws)
        cell["created_by"] = who
        if cell.get("kernel") is None and notebook._kernel_for(nb, None, cell, ws) != kernel:
            cell["kernel"] = kernel or ""
        changed = True
    if changed:
        notebook.write_notebook(ws, nb)
        notebook._emit(c, cell)


# --------------------------------------------------------------------------- workspace events (coalesced)

_pending_notify: dict[tuple[str, str], asyncio.TimerHandle] = {}


def _notify(c: str, chat_id: str) -> None:
    """One `chat {chat}` record on the workspace stream per chat per EVENT_COALESCE_S: the browser re-reads the log."""
    key = (c, chat_id)
    if key in _pending_notify:
        return
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        _emit_chat(c, chat_id)
        return

    def fire() -> None:
        _pending_notify.pop(key, None)
        _emit_chat(c, chat_id)

    _pending_notify[key] = loop.call_later(EVENT_COALESCE_S, fire)


notify = _notify  # the name the events module, the mirror and the thread module call


def _emit_chat(c: str, chat_id: str) -> None:
    try:
        investigation.emit(c, investigation.MAIN, {"type": "chat", "chat": chat_id})
    except Exception:  # noqa: BLE001
        log.debug("chat event for %s/%s not emitted", c, chat_id, exc_info=True)


# --------------------------------------------------------------------------- chips and agents (background work)


def chip(c: str, kind: str, text: str, **fields: Any) -> dict:
    """An act with no reply, shown in main: `{type: chip, kind, text, ref?, chat? …}`. Kinds the frontend knows:
    filter, ticket, artifact, view, label, thread."""
    ensure_main(c)
    _, log_path = paths(c, MAIN_ID)
    rec = {"type": "chip", "ts": _now(), "kind": kind, "text": text, **{k: v for k, v in fields.items() if v is not None}}
    append(log_path, rec)
    _notify(c, MAIN_ID)
    return rec


def mirror(c: str, type_: str, **data: Any) -> dict:
    """A record on main, appended and announced: the mirror's (session.py, `by: terminal`) and a browser message the
    events module posted (events.py, `by: browser`)."""
    ensure_main(c)
    _, log_path = paths(c, MAIN_ID)
    rec = {"type": type_, "ts": _now(), **data}
    append(log_path, rec)
    _notify(c, MAIN_ID)
    return rec


class Recorder:
    """What a background run writes into its agent chat's log: the same record shapes an interactive turn writes, so
    one frontend fold renders both. `text` records are coalesced by the writer; everything else is one line each."""

    def __init__(self, c: str, chat_id: str) -> None:
        self.c, self.chat_id = c, chat_id
        _, self.log_path = paths(c, chat_id)
        self.index = count_lines(self.log_path)

    def record(self, type_: str, **data: Any) -> dict:
        rec = {"type": type_, **({} if type_ == "text" else {"ts": _now()}), **data}
        if not self.log_path.with_name(f"{self.chat_id}.meta.json").is_file():
            return rec  # the chat was deleted while its run went on: nothing recreates its log outside the trash
        append(self.log_path, rec)
        self.index += 1
        _notify(self.c, self.chat_id)
        return rec

    def text(self, delta: str, **extra: Any) -> None:
        if delta:
            self.record("text", delta=delta, **extra)

    def tool_use(self, id_: str, name: str, input_: Any, **extra: Any) -> int:
        idx = self.index
        self.record("tool_use", id=id_, name=name, input=input_, **extra)
        return idx

    def tool_result(self, id_: str, summary: str, *, is_error: bool = False, **extra: Any) -> None:
        data = {"id": id_, "summary": (summary or "")[:SUMMARY_LIMIT], **extra}
        if is_error:
            data["is_error"] = True
        self.record("tool_result", **data)

    def error(self, message: str, **extra: Any) -> None:
        self.record("error", message=message, **extra)


_agent_tasks: dict[tuple[str, str], asyncio.Task] = {}


def new_agent(c: str, role: str, title: str, *, parent: str = MAIN_ID, by: str | None = None, announce: bool = True,
              call: str | None = None, **fields: Any) -> dict:
    """An agent chat in status running, announced in main by an `agent` record unless `announce` is off. The owner runs the
    work and ends it with finish_agent. `call` is the id of the tool call that started it; `fields` land on the meta."""
    ensure_main(c)
    cid = secrets.token_hex(4)
    meta = _defaults({"id": cid, "kind": KIND_AGENT, "role": role, "title": title, "created_at": _now(), "parent": parent,
                      "status": "running", **fields})
    write_meta(c, meta)
    _, log_path = paths(c, cid)
    log_path.touch()
    if parent and announce:
        _, main_log = paths(c, parent)
        append(main_log, {"type": "agent", "ts": _now(), "chat": cid, "role": role, "title": title, **({"by": by} if by else {}),
                          **({"tool_use_id": call} if call else {}),
                          # a view's build (a dev chat that is no code ticket), which main's note names so
                          **({"view": str(fields["view"])} if fields.get("view") else {})})
        _notify(c, parent)
    _notify(c, cid)
    return meta


_finish_hooks: list[Callable[[str, dict], None]] = []


def on_agent_finished(fn: Callable[[str, dict], None]) -> None:
    """Call `fn(c, meta)` after every agent chat ends (finish_agent), for a module whose state follows an agent, such as
    the document the writer agent was writing (report_types.writer_finished). A hook that raises is logged and skipped."""
    if fn not in _finish_hooks:
        _finish_hooks.append(fn)


def finish_agent(c: str, chat_id: str, status: str, result: str | None = None, **fields: Any) -> dict:
    def end(meta: dict) -> None:
        meta["status"] = status if status in AGENT_STATUSES else "done"
        meta["result"] = result
        meta["ts_end"] = _now()
        meta.update({k: v for k, v in fields.items() if v is not None})

    meta = change_meta(c, chat_id, end)
    _, log_path = paths(c, chat_id)
    if status == "done":
        append(log_path, {"type": "done", "ts": _now(), "result": result})
    elif status != "running":
        append(log_path, {"type": "error", "ts": _now(), "message": result or status, "kind": status})
    _notify(c, chat_id)
    if meta.get("parent"):
        _notify(c, str(meta["parent"]))
    for fn in list(_finish_hooks):
        try:
            fn(c, meta)
        except Exception:  # noqa: BLE001 — the chat has ended; a hook's own state is secondary
            log.exception("%s: an agent-finished hook failed for %s", c, chat_id)
    return meta


def update_agent(c: str, chat_id: str, **fields: Any) -> dict:
    meta = change_meta(c, chat_id, lambda m: m.update(fields))
    _notify(c, chat_id)
    return meta


def start_agent(c: str, role: str, title: str, run: Callable[[Recorder], Awaitable[Any]], *,
                parent: str = MAIN_ID, **fields: Any) -> dict:
    """Create an agent chat and run `run(recorder)` as a task; its return (a string or None) is the result, an
    exception fails it, a cancellation stops it."""
    meta = new_agent(c, role, title, parent=parent, **fields)
    cid = meta["id"]
    rec = Recorder(c, cid)

    async def go() -> None:
        try:
            result = await run(rec)
            finish_agent(c, cid, "done", str(result) if result is not None else None)
        except asyncio.CancelledError:
            finish_agent(c, cid, "stopped", STOPPED_LINE)
            raise
        except Exception as e:  # noqa: BLE001
            log.exception("agent %s/%s (%s) failed", c, cid, role)
            finish_agent(c, cid, "failed", f"{type(e).__name__}: {e}"[:400])
        finally:
            _agent_tasks.pop((c, cid), None)

    _agent_tasks[(c, cid)] = asyncio.get_running_loop().create_task(go(), name=f"agent:{role}:{c}:{cid}")
    return meta


def end_left_label_chats(c: str) -> list[str]:
    """The chats that follow a label's run (role `labels`) still `running` with no task of this process behind them,
    each ended `stopped`: the ids. A label's run is a task of the process that started it (the server, or in terminal
    mode the session's own shim), so once main quit (subagents.hook_end) or a new shim starts (local._start), such a
    chat follows nothing. Live check term-fix8, low quirk: the `label …` record stayed running after the quit."""
    out = []
    for m in list_chats(c):
        cid = str(m.get("id") or "")
        if m.get("kind") == KIND_AGENT and m.get("role") == "labels" and m.get("status") == "running" and (c, cid) not in _agent_tasks:
            finish_agent(c, cid, "stopped", STOPPED_LINE)
            out.append(cid)
    return out


async def stop_agent(c: str, chat_id: str) -> bool:
    task = _agent_tasks.get((c, chat_id))
    if task is None:
        return False
    task.cancel()
    return True


async def shutdown() -> None:
    _busy.clear()
    for task in list(_agent_tasks.values()):
        task.cancel()
    _agent_tasks.clear()


# --------------------------------------------------------------------------- routes


class NewThread(BaseModel):
    anchor: str | None = None
    anchor_text: str | None = None
    title: str | None = None
    surface: str | None = None
    element: str | None = None
    selector: str | None = None
    image: str | None = None  # a data:image/png;base64 URL of the element, captured at the click
    parent: str | None = None  # the chat the analyst was reading when they asked (thread_parent)
    text: str | None = None  # the first question, posted as the thread's first event (create_route)
    comment: str | None = None  # the id of the comment whose Ask opened it (new_thread)


class ChatUpdate(BaseModel):
    title: str | None = None
    model: str | None = None
    effort: str | None = None
    name: str | None = None  # the analyst's name for the chat in the thread tree (rename_chat)


@router.get("/ws/{c}/chats")
async def list_route(c: str) -> list[dict]:
    return list_chats(c)


def _orientation_status(c: str) -> str | None:
    """The status of the workspace's orientation from orient/run.json (requested, running, done, failed or stopped),
    None when none was ever asked for, for main's meta: the browser's Start gate stays open until then, whatever main
    holds."""
    from . import orientation  # noqa: PLC0415 — orientation imports this module

    status = (orientation.read_run(c) or {}).get("status")
    return str(status) if status else None


@router.get("/ws/{c}/instance")
async def instance_route(c: str) -> dict:
    """The workspace instance's birth stamp, its main chat's `created_at`: the browser clears what it kept under the
    workspace's name when the stamp changed (frontend lib/workspace syncInstance). Reads main's meta alone, no log."""
    return {"stamp": ensure_main(c).get("created_at") or None}


def _main_state(c: str) -> dict:
    """What main's meta adds for the browser (module_bridge.main_meta): `fenced`, `launched`, `module` and `module_why`,
    which the unfenced banner and Start's no-module line read."""
    from . import module_bridge  # noqa: PLC0415 — module_bridge imports the session modules

    return module_bridge.main_meta(c)


@router.get("/ws/{c}/chats/main")
async def main_route(c: str) -> Response:
    meta = ensure_main(c)
    meta["running"] = _running(c, MAIN_ID)
    meta["orientation"] = _orientation_status(c)
    meta.update(_main_state(c))
    _, log_path = paths(c, MAIN_ID)
    return chat_response(meta, log_path)


@router.post("/ws/{c}/chats", status_code=201)
async def create_route(c: str, body: NewThread) -> dict:
    """A new thread. With `text` the question goes out as the thread's first event in the same call, and when no
    session listens nothing is made (409, events.post's message), so the browser keeps the draft and no thread is left
    empty."""
    from . import events, threads  # noqa: PLC0415 — both import this module

    text = (body.text or "").strip()
    if text and not events.reachable(c):
        raise HTTPException(409, events.NOT_LISTENING.format(cwd=config.corpus_dir(c)))
    meta = new_thread(c, body.anchor, body.anchor_text, body.title, surface=body.surface, element=body.element,
                      selector=body.selector, image=body.image, parent=body.parent, comment=body.comment)
    if not text:
        return meta
    await threads.warm(c, meta)
    try:
        posted = events.post(c, events.THREAD, {"thread": meta["id"], "text": text})
    except Exception:
        _trash(c, meta["id"])
        raise
    meta = read_meta(c, meta["id"])
    meta["running"] = _running(c, meta["id"])
    meta["event"] = posted.get("id")
    return meta


@router.get("/ws/{c}/chats/{chat_id}")
async def get_route(c: str, chat_id: str) -> Response:
    meta = ensure_main(c) if chat_id == MAIN_ID else read_meta(c, chat_id)
    _, log_path = paths(c, chat_id)
    meta["running"] = _running(c, chat_id)
    if chat_id == MAIN_ID:
        meta["orientation"] = _orientation_status(c)
        meta.update(_main_state(c))
    elif meta.get("kind") == KIND_THREAD:
        from . import threads  # noqa: PLC0415

        meta[threads.HAND_BACK_KEY] = threads.hand_back_state(c, meta)
    return chat_response(meta, log_path)


@router.put("/ws/{c}/chats/{chat_id}")
async def update_route(c: str, chat_id: str, body: ChatUpdate) -> dict:
    with ledger.locked(paths(c, chat_id)[0]):
        meta = _update(c, chat_id, body)
    _notify(c, chat_id)
    return meta


def _update(c: str, chat_id: str, body: ChatUpdate) -> dict:
    """update_route's change, with the meta's lock held."""
    meta = read_meta(c, chat_id)
    if body.title is not None:
        old = str(meta.get("title") or "")
        meta["title"] = body.title.strip()[:120]
        if meta.get("kind") == KIND_THREAD and meta.get("group") and meta["title"] and meta["title"] != old:
            _rename_group(c, str(meta["group"]), f"main/{old}", f"main/{meta['title']}")
    if body.model is not None:
        meta["model"] = body.model.strip() or None
    if body.effort is not None:
        eff = body.effort.strip().lower()
        if eff and eff not in config.EFFORTS:
            raise HTTPException(400, f"effort must be one of {', '.join(config.EFFORTS)}")
        meta["effort"] = eff or None
    if body.name is not None:
        _rename(c, meta, body.name)
    write_meta(c, meta)
    return meta


def _rename(c: str, meta: dict, name: str) -> None:
    """Set a chat's name as the thread tree shows it: a thread's title, which its canvas group follows, or another chat's
    `name`. 400 for main or an empty name."""
    if meta.get("kind") == KIND_MAIN:
        raise HTTPException(400, "main cannot be renamed")
    clean = " ".join(str(name).split())[:120]
    if not clean:
        raise HTTPException(400, "the name is empty")
    if meta.get("kind") != KIND_THREAD:
        meta["name"] = clean
        return
    old = str(meta.get("title") or "")
    meta["title"] = clean
    if meta.get("group") and clean != old:
        _rename_group(c, str(meta["group"]), f"main/{old}", f"main/{clean}")


def rename_chat(c: str, chat_id: str, name: str) -> dict:
    """Rename a chat as the thread tree lists it (_rename); the browser's Rename and main's rename_thread."""
    meta = change_meta(c, chat_id, lambda m: _rename(c, m, name))
    _notify(c, chat_id)
    return meta


def _rename_group(c: str, group: str, old: str, new: str) -> None:
    """A renamed thread's canvas group follows its name while the group still has the name the thread gave it."""
    from . import notebook  # noqa: PLC0415

    with notebook.editing(_ws(c)):
        nb = notebook.read_notebook(_ws(c), group)
        if nb is not None and nb.get("title") == old:
            nb["title"] = new
            notebook.write_notebook(_ws(c), nb)


def _trash(c: str, chat_id: str) -> None:
    """Move a chat's two files to chats/trash/, outside list_chats' glob, so what was said in it stays in the workspace
    export (export.py) as a deleted group's cards stay in notebooks/trash/."""
    trash = chats_dir(c) / "trash"
    trash.mkdir(exist_ok=True)
    for p in paths(c, chat_id):
        if p.exists():
            p.replace(trash / p.name)


STEP_ROLE = "step"  # a subagent's chat under the session that ran it (agent_session.STEP_ROLE)
DELETE_WAIT_S = 8.0  # the longest wait for a stopped server task to end before its chat is deleted


async def _stop_for_delete(c: str, meta: dict) -> None:
    """Stop an agent chat that runs: one of thimble's agents (through the module, subagents.stop) or its server task.
    A thread's fork runs inside main's session, which the server cannot stop."""
    if meta.get("kind") != KIND_AGENT:
        return
    cid = str(meta["id"])
    if _runs_as_subagent(meta):
        from . import subagents  # noqa: PLC0415 — subagents imports this module

        with contextlib.suppress(Exception):
            await subagents.stop(c, str(meta["agent_id"]))
        return
    task = _agent_tasks.get((c, cid))
    if task is not None:
        task.cancel()
        await asyncio.wait({task}, timeout=DELETE_WAIT_S)


def _runs_as_subagent(meta: dict) -> bool:
    """Whether an agent chat is one of thimble's agents that runs, which a delete stops through the module."""
    return (meta.get("kind") == KIND_AGENT and meta.get("route") == "subagent" and bool(meta.get("agent_id"))
            and meta.get("status") == "running")


def _with_steps(c: str, chat_id: str) -> list[dict]:
    """A chat's meta and its steps' metas, the chat's first; 409 for main."""
    meta = read_meta(c, chat_id)
    if meta.get("kind") == KIND_MAIN:
        raise HTTPException(409, "main cannot be deleted")
    return [meta, *(m for m in list_chats(c) if m.get("role") == STEP_ROLE and m.get("parent") == chat_id)]


async def delete_chat(c: str, chat_id: str) -> list[str]:
    """Delete a chat and the chats of its steps, stopping each that runs, and move their files to the trash (_trash).
    The ids deleted, the chat's first; 409 for main."""
    gone = _with_steps(c, chat_id)
    for m in gone:
        await _stop_for_delete(c, m)
    for m in gone:
        discard_chat(c, str(m["id"]), str(m.get("role") or ""))
    return [str(m["id"]) for m in gone]


def discard_chat(c: str, chat_id: str, role: str = "") -> None:
    """A chat that runs no task goes to the trash, and the pages are told (delete_chat; the mirror's agent chat that
    turned out to be a thread's fork, session._into_thread)."""
    if chat_id == MAIN_ID:
        return
    _busy.discard((c, chat_id))
    _trash(c, chat_id)
    log.info("%s: chat %s (%s) deleted", c, chat_id, role or "?")
    try:
        investigation.emit(c, investigation.MAIN, {"type": "chat", "chat": chat_id, "deleted": True})
    except Exception:  # noqa: BLE001 — off the event loop (a pass of terminal mode's mirror), no page listens
        log.debug("chat deletion for %s/%s not emitted", c, chat_id, exc_info=True)


@router.delete("/ws/{c}/chats/{chat_id}")
async def delete_route(c: str, chat_id: str, request: Request) -> dict:
    """Delete a chat (delete_chat). Deleting one of thimble's agents that runs, or a chat one runs as a step of, stops it
    through the module, which is a click, so it takes the analyst's cookie (403 without it), as Stop does."""
    if any(_runs_as_subagent(m) for m in _with_steps(c, chat_id)):
        from . import subagents  # noqa: PLC0415 — subagents imports this module

        subagents.analyst_only(request)
    ids = await delete_chat(c, chat_id)
    return {"deleted": chat_id, "chats": ids}


@router.post("/ws/{c}/chats/{chat_id}/ask-again")
async def ask_again_route(c: str, chat_id: str) -> dict:
    """Send a thread's unanswered questions to the session again (threads.ask_again): the thread's run stopped with
    its session, failed, or ended without a reply. 409 when no session listens or the thread is working."""
    from . import threads  # noqa: PLC0415

    return threads.ask_again(c, chat_id)


@router.post("/ws/{c}/chats/{chat_id}/hand-back")
async def hand_back_route(c: str, chat_id: str) -> dict:
    """Hand a finished thread's answer back to main as the analyst's message (threads.hand_back). 409 while the thread
    runs, when that answer was handed back already, or when no session listens."""
    from . import threads  # noqa: PLC0415

    return threads.hand_back(c, chat_id)


@router.post("/ws/{c}/chats/{chat_id}/interrupt")
async def interrupt_route(c: str, chat_id: str, request: Request) -> dict:
    """Stop: one of thimble's agents, any role's chat (route subagent), through the module (subagents.stop, TaskStop),
    which is a click, so the analyst's cookie (403 without it); a stop of an agent that had ended counts as done
    ({stopped, done}); without the module {stopped: false, kind: no-module}, and the card says to press Esc in the
    agent's view. A server task stops as before. Main and its threads run in the analyst's session, which the browser
    does not interrupt; the analyst's own subagent of main is main's to stop, so main is asked to."""
    meta = read_meta(c, chat_id)
    if meta.get("kind") != KIND_AGENT:
        return {"stopped": False}
    if meta.get("route") == "subagent" and meta.get("agent_id"):
        from . import subagents  # noqa: PLC0415 — subagents imports this module

        subagents.analyst_only(request)
        ans = await subagents.stop(c, str(meta["agent_id"]))
        if ans.refused:
            return {"stopped": False, "kind": ans.kind, "reason": ans.reason}
        return {"stopped": True, **({"done": True} if ans.get("done") else {})}
    if await stop_agent(c, chat_id):
        return {"stopped": True}
    if meta.get("agent_id") and meta.get("parent") == MAIN_ID and meta.get("status") == "running":
        # the analyst's own subagent of main: only main can stop it
        from . import events, tools  # noqa: PLC0415

        title = str(meta.get("title") or "a subagent")
        text = tools.hint("stop-subagent", title=title, agent_id=str(meta["agent_id"]))
        events.post(c, events.MAIN, {"text": text}, mirror=False,
                     line=events.terminal_line(events.MAIN, f"Stop {title}", {}))
        return {"stopped": False, "asked": "main"}
    return {"stopped": False}


async def stop_all(c: str) -> list[str]:
    """Stop everything thimble runs for workspace `c`, main's session having ended with none taking over
    (session.disconnected, or main's SessionEnd hook), so nothing works on after the analyst quit: its report checks and
    card checks, its dev ticket and view builds (dev.stop_workspace), its label runs (concepts.stop_workspace), the
    chats of thimble's agents, which died with main (subagents.close_running), its server tasks and its kernels.
    Returns what it stopped, for the log."""
    from . import card_check, checks, concepts, dev, notebook, subagents  # noqa: PLC0415 — each imports this module

    stopped: list[str] = []
    steps: list[tuple[str, Callable[[str], int]]] = [("report check", checks.stop_workspace),
                                                     ("card check", card_check.stop_workspace), ("dev build", dev.stop_workspace),
                                                     ("label run", concepts.stop_workspace)]
    for what, fn in steps:
        try:
            stopped += [what] * fn(c)
        except Exception:  # noqa: BLE001 — one part that will not stop leaves the others to stop
            log.warning("%s: could not stop the %ss", c, what, exc_info=True)
    try:
        stopped += [f"agent {a}" for a in subagents.close_running(c, subagents.STOPPED_QUIT)]
    except Exception:  # noqa: BLE001
        log.warning("%s: thimble's agents' chats were not closed", c, exc_info=True)
    for cc, chat in [k for k in _agent_tasks if k[0] == c]:
        if await stop_agent(cc, chat):
            stopped.append(str((meta_or_none(c, chat) or {}).get("title") or chat))
    try:
        await notebook.shutdown_workspace(c)
    except Exception:  # noqa: BLE001
        log.warning("%s: could not stop the kernels", c, exc_info=True)
    return stopped


def at_work() -> set[str]:
    """The workspaces where this server runs something stop_all stops."""
    from . import concepts, dev  # noqa: PLC0415

    return {c for c, _ in _agent_tasks} | dev.workspaces_at_work() | concepts.workspaces_at_work()


# --------------------------------------------------------------------------- text helpers other modules import

_BLANK_RUN_RE = re.compile(r"\n{3,}")


def paragraphs(text: Any) -> str:
    """A model's prose with its paragraphing kept and the rest of its whitespace tidied."""
    lines = [" ".join(ln.split()) for ln in str(text or "").replace("\r\n", "\n").replace("\r", "\n").split("\n")]
    return _BLANK_RUN_RE.sub("\n\n", "\n".join(lines)).strip()


async def check_refs(c: str, refs_: list[str]) -> tuple[list[str], list[str]]:
    """Split refs into (resolved, broken) through refs.resolve; never raises."""
    if not refs_:
        return [], []
    from . import refs as refs_mod  # noqa: PLC0415

    corpus = config.corpus_dir(c)

    async def one(r: str) -> bool:
        try:
            res = refs_mod.resolve(corpus, r, workspace=c) if "workspace" in refs_mod.resolve.__code__.co_varnames else refs_mod.resolve(corpus, r)
            if asyncio.iscoroutine(res):
                res = await res
            return res is not None
        except Exception:  # noqa: BLE001
            return False

    ok = await asyncio.gather(*(one(r) for r in refs_))
    return [r for r, hit in zip(refs_, ok) if hit], [r for r, hit in zip(refs_, ok) if not hit]


__all__ = ["KIND_MAIN", "KIND_THREAD", "KIND_AGENT", "MAIN_ID", "Recorder", "chip", "ensure_main", "finish_agent",
           "end_left_label_chats", "list_chats", "mirror", "new_agent", "new_thread", "paths", "read_events", "read_meta", "start_agent",
           "stop_agent",
           "set_running", "update_agent", "write_meta"]
