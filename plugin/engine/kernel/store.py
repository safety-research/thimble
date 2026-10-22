"""Where the kernel keeps its records.

In the folder under analysis (the root), the `thimble/` folder holds what the person may keep, share or diff:

    thimble/labels/<name>.json              each label with every version of its values (labels.py)

Under $THIMBLE_HOME/lean/events/<session>.jsonl the session's change feed: one line per change the plugin acts on (a
label whose records wait for the model, a fix's share that waits for the person), so the plugin learns of it from the
kernel, not from what a command printed.

Outside it, under $THIMBLE_HOME/lean (default ~/.thimble/lean): seen/<session>.jsonl, where the hooks module keeps the
files that Claude's own Read, Grep and Bash calls touched in each session (so a coding session in another folder never
gets a thimble/ folder), and cache/<folder>/, the files' row counts, safe to delete. Nothing here writes into a source
file.
"""
from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any

DIR = "thimble"


def thimble_home() -> Path:
    return Path(os.environ.get("THIMBLE_HOME") or os.path.expanduser("~/.thimble"))


def _holding(start: Path) -> Path | None:
    """The nearest folder at or above `start` that holds a thimble/ record folder, or None."""
    d = start
    while True:
        t = d / DIR
        if (t / "labels").is_dir():
            return d
        if d.parent == d:
            return None
        d = d.parent


def find_root(start: str | Path | None = None) -> Path:
    """The folder under analysis: THIMBLE_ROOT, else the nearest folder at or above `start` (the working folder) that
    holds a thimble/ record folder, else `start` itself.

    In a Claude Code session the hooks set THIMBLE_START to the folder the session started in. A `cd` inside that folder
    does not move the records: they stay in the start folder's thimble/ (or one above it), so a session whose first
    command is `cd src` keeps one record folder, not a second one inside the source tree. When no folder at or above
    the start folder holds records, a folder between it and the working folder that holds them is used. A working
    folder outside the start folder is found as before, and so is any folder outside a session."""
    env = os.environ.get("THIMBLE_ROOT")
    if env:
        return Path(env).resolve()
    here = Path(start or os.getcwd()).resolve()
    anchor = os.environ.get("THIMBLE_START")
    if anchor:
        a = Path(anchor).resolve()
        if here == a or a in here.parents:
            return _holding(a) or _holding(here) or a
    return _holding(here) or here


def session_id() -> str:
    return os.environ.get("THIMBLE_SESSION") or os.environ.get("CLAUDE_CODE_SESSION_ID") or "cli"


class Store:
    def __init__(self, root: str | Path | None = None, session: str | None = None):
        self.root = Path(root).resolve() if root else find_root()
        self.session = session or session_id()
        self.dir = self.root / DIR
        self.cache = thimble_home() / "lean" / "cache" / safe(str(self.root))[-100:]

    def sub(self, name: str) -> Path:
        d = self.dir / name
        d.mkdir(parents=True, exist_ok=True)
        return d

    # ---------------------------------------------------------------- the change feed

    def emit(self, row: dict[str, Any]) -> None:
        """One event of the session's change feed: $THIMBLE_HOME/lean/events/<session>.jsonl, one JSON line each,
        appended in one write. A surface follows the file by its size; an event names its folder, so the reader needs
        no other context."""
        try:
            d = thimble_home() / "lean" / "events"
            d.mkdir(parents=True, exist_ok=True)
            row = {"t": round(time.time(), 3), "session": self.session, "root": str(self.root), **row}
            line = json.dumps(row, ensure_ascii=False, default=str) + "\n"
            fd = os.open(d / f"{safe(self.session)}.jsonl", os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
            try:
                os.write(fd, line.encode())
            finally:
                os.close(fd)
        except OSError:
            pass

    # ---------------------------------------------------------------- what the hooks saw

    def seen(self, session: str | None = "") -> list[dict[str, Any]]:
        """The Read, Grep and Bash calls the hooks module kept for this session (or `session`, or every session when
        None) whose working folder is under the root, with absolute paths."""
        d = thimble_home() / "lean" / "seen"
        want = self.session if session == "" else session
        files = sorted(d.glob("*.jsonl")) if want is None else [d / f"{safe(want)}.jsonl"]
        out = []
        root = str(self.root)
        for f in files:
            try:
                lines = f.read_text().splitlines()
            except OSError:
                continue
            for line in lines:
                try:
                    r = json.loads(line)
                except ValueError:
                    continue
                cwd = str(r.get("cwd") or "")
                if cwd == root or cwd.startswith(root + os.sep) or root.startswith(cwd.rstrip("/") + os.sep):
                    out.append(r)
        return out

    def rel(self, path: str) -> str | None:
        """A path relative to the root, or None when it is outside the root."""
        try:
            p = Path(path)
            if not p.is_absolute():
                p = self.root / p
            r = os.path.relpath(os.path.normpath(p), self.root)
        except ValueError:
            return None
        return None if r.startswith("..") else r

    # ---------------------------------------------------------------- json files

    @staticmethod
    def read_json(p: Path) -> Any:
        try:
            return json.loads(p.read_text())
        except (OSError, ValueError):
            return None

    @staticmethod
    def write_json(p: Path, obj: Any) -> None:
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_name(p.name + ".tmp")
        tmp.write_text(json.dumps(obj, indent=1, ensure_ascii=False, default=str) + "\n")
        os.replace(tmp, p)


def safe(s: str) -> str:
    return "".join(c if c.isalnum() or c in "-_" else "-" for c in s)[:120] or "none"
