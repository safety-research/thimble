"""The numbering of a chat's tool calls in its calls store, shared by the backend (calls.py) and the plugin's hooks.

Store: `workspaces/<c>/calls/<chat>.jsonl` (calls.py has the record shapes). A call's number is assigned once, the
first time any process sees its tool_use_id, under an flock on `calls/<chat>.jsonl.lock`: the hook that runs on each
tool call (`--agents`, terminal mode) and the backend's mirror (calls.Numbering) both number calls, and without the
lock two processes could give two calls one number. The file is read again under the lock, so a number another process
gave is found there, and a new number is one past the highest stored.

Standard library only: the plugin's hooks import this module under `python -S` (as app/subagent_files.py).
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

CALLS_DIR = "calls"  # calls.CALLS_DIR
CHAT_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")  # calls.CHAT_RE
LOCK_SUFFIX = ".lock"  # ledger.LOCK_SUFFIX: the lock file is <store>.lock beside it, the lock ledger.locked takes
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


def line(rec: dict[str, Any]) -> str:
    """One record as the store holds it (calls._append writes the same)."""
    return json.dumps(rec, ensure_ascii=False, default=str) + "\n"


class _Lock:
    """An flock on `<store>.lock` for the length of a `with`, waited for up to LOCK_WAIT_S; past that the caller goes on
    without it (ledger.locked's rule). The backend takes the same lock through ledger.locked, which also keeps the
    threads of one process apart."""

    def __init__(self, store: Path) -> None:
        self.lf = store.with_name(store.name + LOCK_SUFFIX)
        self.fd: int | None = None

    def __enter__(self) -> "_Lock":
        self.lf.parent.mkdir(parents=True, exist_ok=True)
        try:
            self.fd = os.open(self.lf, os.O_RDWR | os.O_CREAT | getattr(os, "O_CLOEXEC", 0), 0o600)
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
        data = store.read_bytes()
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
        with open(store, "rb") as f:
            f.seek(-1, 2)
            torn = f.read(1) != b"\n"
    except OSError:
        return
    if torn:
        with open(store, "ab") as f:
            f.write(b"\n")


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
    store.parent.mkdir(parents=True, exist_ok=True)
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
        with open(store, "a", encoding="utf-8") as f:
            f.write(line(rec))
        return n
    finally:
        if lock is not None:
            lock.__exit__()
