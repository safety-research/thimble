"""The numbering of a chat's tool calls in its calls store (calls.py).

Store: `workspaces/<c>/calls/<chat>.jsonl` (calls.py has the record shapes). A call's number is assigned once, the
first time any process sees its tool_use_id, under an flock on its lock (nofollow.lock_file, in the workspace's locks
folder, where no kernel reaches it, as ledger.locked takes it): the call-ref hook's route
(calls.hook_route) and the backend's mirror (calls.Numbering) both number calls, and without the lock two writers
could give two calls one number. The file is read again under the lock, so a number another process gave is found
there, and a new number is one past the highest stored.

A card's code writes the workspace, so the store, its folder and its lock are opened from the workspace's folder as
nofollow opens them (_ws_of), never through a link a card put there.
"""
from __future__ import annotations

import fcntl
import json
import os
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from . import nofollow

CALLS_DIR = "calls"  # calls.CALLS_DIR
CHAT_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")  # calls.CHAT_RE
LOCK_WAIT_S = 2.0  # ledger.LOCK_WAIT_S
# a call's first line, as _record writes it: {"n": <n>, "id": "<tool_use_id>", ...}; result and chat lines have no id
_ID_LINE = re.compile(rb'^\{"n": (\d+), "id": ')


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def path(ws: Path, chat: str) -> Path:
    """The calls store of chat `chat` in the workspace folder `ws`; ValueError for a malformed chat id."""
    if not CHAT_RE.match(chat or ""):
        raise ValueError(f"invalid chat id: {chat!r}")
    return Path(ws) / CALLS_DIR / f"{chat}.jsonl"


def _ws_of(store: Path) -> Path:
    """The workspace folder a store lies in (path), the root nofollow opens it from."""
    return Path(store).parent.parent


def line(rec: dict[str, Any]) -> str:
    """One record as the store holds it (calls._append writes the same)."""
    return json.dumps(rec, ensure_ascii=False, default=str) + "\n"


class _Lock:
    """An flock on the store's lock file (nofollow.lock_file) for the length of a `with`, waited for up to LOCK_WAIT_S;
    past that the caller goes on without it (ledger.locked's rule). The backend takes the same lock through
    ledger.locked, which also keeps the threads of one process apart."""

    def __init__(self, store: Path) -> None:
        self.lf = nofollow.lock_file(store)
        self.root = _ws_of(store)
        self.fd: int | None = None

    def __enter__(self) -> "_Lock":
        try:
            self.fd = nofollow.open(self.lf, os.O_RDWR | os.O_CREAT, 0o600, root=self.root, make=True)
        except OSError:
            return self
        deadline = time.monotonic() + LOCK_WAIT_S
        while True:
            try:
                fcntl.flock(self.fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                return self
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    os.close(self.fd)
                    self.fd = None
                    return self
                time.sleep(0.01)
            except OSError:
                os.close(self.fd)
                self.fd = None
                return self

    def __exit__(self, *exc: Any) -> None:
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None


def scan(store: Path) -> tuple[dict[str, int], int]:
    """({tool_use_id: n}, the highest n) of the calls stored in `store`, from their first lines alone: a result line can
    be long, and it is skipped without being parsed. ({}, 0) for a missing store."""
    try:
        data = nofollow.read_bytes(store, root=_ws_of(store))
    except OSError:
        return {}, 0
    by_id: dict[str, int] = {}
    top = 0
    for raw in data.splitlines():
        m = _ID_LINE.match(raw)
        if not m:
            continue
        try:
            rec = json.loads(raw)
        except ValueError:
            continue  # a torn last line
        n = rec.get("n")
        if not isinstance(n, int) or isinstance(n, bool):
            continue
        by_id.setdefault(str(rec.get("id")), n)
        top = max(top, n)
    return by_id, top


def _mend(store: Path) -> None:
    """End a torn last line (ledger.heal_tail), so an append never glues onto it."""
    try:
        fd = nofollow.open(store, os.O_RDWR | os.O_APPEND, root=_ws_of(store))
    except OSError:
        return
    try:
        size = os.fstat(fd).st_size
        if size and os.pread(fd, 1, size - 1) != b"\n":
            os.write(fd, b"\n")
    except OSError:
        pass
    finally:
        os.close(fd)


def number(ws: Path, chat: str, tool_use_id: str, name: str, inp: Any = None, agent: str | None = None, *,
           at: str | None = None, held: bool = False) -> int:
    """The number of call `tool_use_id` in chat `chat`'s sequence, given the first time any process sees it: `{n, id,
    chat, name, input, ts, agent?}` appended to the store under its lock. `at` is the chat whose log holds the call's
    record, when the caller knows it. `held`: the caller holds the store's lock already (calls.py, through
    ledger.locked)."""
    tid = str(tool_use_id or "")
    if not tid:
        raise ValueError("a call needs its tool_use_id")
    store = path(ws, chat)
    nofollow.makedirs(store.parent, root=ws)
    lock = None if held else _Lock(store)
    if lock is not None:
        lock.__enter__()
    try:
        by_id, top = scan(store)
        if tid in by_id:
            return by_id[tid]
        n = top + 1
        rec: dict[str, Any] = {"n": n, "id": tid, "chat": at, "name": str(name or ""), "input": inp, "ts": now()}
        if agent:
            rec["agent"] = agent
        _mend(store)
        nofollow.append_bytes(store, line(rec).encode("utf-8"), root=ws)
        return n
    finally:
        if lock is not None:
            lock.__exit__()
