"""Where the kernel keeps its records: the layout of $THIMBLE_HOME that the plugin's core/layout.mjs writes down, with
the same names (safe_name, folder_name; a test on each side checks one name).

The folder under analysis (the root) is the person's record, and thimble writes nothing in it. Under $THIMBLE_HOME
(default ~/.thimble):

    folders/<folder>/labels/<name>.json   each label of a root with every version of its values (labels.py)
    cache/<folder>/                       the root's files' row counts, safe to delete
    events/<conversation>.jsonl           the session's change feed: one line per change the plugin acts on (a label
                                          whose records wait for the model, a large label run that waits for the
                                          person's choice),
                                          so the plugin learns of it from the kernel, not from what a command printed
    seen/<conversation>.jsonl             the files that Claude's own Read, Grep and Bash calls touched (the hooks
                                          module writes it, coverage reads it)

<folder> is folder_name of the root's real path. A root that already holds a thimble/labels folder of its own (the
person made it, or an earlier thimble wrote it there) keeps its labels there. Nothing here writes into a source file.
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Any

DIR = "thimble"


def thimble_home() -> Path:
    return Path(os.environ.get("THIMBLE_HOME") or os.path.expanduser("~/.thimble"))


def safe_name(s: str) -> str:
    """A name for a file or a folder: letters, digits, - and _, at most 80 characters (layout.mjs safeName)."""
    return re.sub(r"[^A-Za-z0-9_-]", "-", s)[:80] or "none"


def short_hash(s: str) -> str:
    """12 hex digits made from any text, two FNV-1a hashes over its code points (layout.mjs shortHash). Not for
    security: it only keeps names apart."""
    h1, h2 = 0x811C9DC5, 0x9747B28C
    for ch in s:
        h1 = ((h1 ^ ord(ch)) * 0x01000193) & 0xFFFFFFFF
        h2 = ((h2 ^ ord(ch)) * 0x5BD1E995) & 0xFFFFFFFF
    return f"{h1:08x}{h2:08x}"[:12]


def folder_name(real: str) -> str:
    """A folder's name under folders/ and cache/: the end of its path, to read, and a hash of the whole path, so two
    folders never share one (layout.mjs folderName)."""
    tail = re.sub(r"[^A-Za-z0-9_-]", "-", real)[-40:].lstrip("-")
    return f"{tail or 'root'}-{short_hash(real)}"


def kept_dir(root: Path) -> Path:
    """Where a root's labels are kept: folders/<folder_name of its real path>/ (the plugin's core/home.ts finds them by
    the same name)."""
    return thimble_home() / "folders" / folder_name(str(Path(root).resolve()))


def records_dir(root: Path) -> Path:
    """The root's record folder: kept_dir(root), or root/thimble/ when the root holds labels of its own there and none
    are kept, so a root's labels never split between two folders. A folder the person can write in may still be a
    record no tool should change (a shared dataset), so writing in it is never the default."""
    own, kept = root / DIR, kept_dir(root)
    if not kept.is_dir() and (own / "labels").is_dir():
        return own
    return kept


def _holding(start: Path) -> Path | None:
    """The nearest folder at or above `start` that holds a thimble/ record folder (its own, or one kept for it under
    THIMBLE_HOME), or None."""
    d = start
    while True:
        if (d / DIR / "labels").is_dir() or (kept_dir(d) / "labels").is_dir():
            return d
        if d.parent == d:
            return None
        d = d.parent


def temp_folders() -> list[Path]:
    """thimble's temp folders, as real paths (the plugin's core/home.ts tempDir, hooks/temp_allow.py temp_folders): the
    session's commands get thimble's folder as their TMPDIR, so TMPDIR itself when it is a folder named thimble, then
    thimble/ in TMPDIR, then $THIMBLE_HOME/tmp; only those that exist."""
    tmp = (os.environ.get("TMPDIR") or "").rstrip("/")
    cands = [Path(tmp)] if tmp and os.path.basename(os.path.realpath(tmp)) == "thimble" else []
    cands += ([Path(tmp) / "thimble"] if tmp else []) + [thimble_home() / "tmp"]
    out: list[Path] = []
    for c in cands:
        if c.is_dir() and not c.is_symlink():
            r = c.resolve()
            if r not in out:
                out.append(r)
    return out


def in_temp(path: str | Path) -> bool:
    """Whether `path` (its real path) lies in one of thimble's temp folders: a file Claude derived for the session (a
    table of the records, a filtered copy) belongs to the session's root, not to a root of its own."""
    try:
        p = Path(path).resolve()
    except (OSError, RuntimeError):
        return False
    return any(p == t or t in p.parents for t in temp_folders())


def find_root(start: str | Path | None = None) -> Path:
    """The folder under analysis: THIMBLE_ROOT, else the nearest folder at or above `start` (the working folder) that
    holds a thimble/ record folder, else `start` itself.

    In a Claude Code session the hooks set THIMBLE_START to the folder the session started in. A `cd` inside that folder
    does not move the records: they stay in the start folder's thimble/ (or one above it), so a session whose first
    command is `cd src` keeps one record folder, not a second one inside the source tree. When no folder at or above
    the start folder holds records, a folder between it and the working folder that holds them is used. A working
    folder in thimble's temp folder (Claude derived a file there and labels it) is the start folder's too: its labels
    belong to the session's root, so they show in the session's answers and bar. Any other working folder outside the
    start folder is found as before, and so is any folder outside a session."""
    env = os.environ.get("THIMBLE_ROOT")
    if env:
        return Path(env).resolve()
    here = Path(start or os.getcwd()).resolve()
    anchor = os.environ.get("THIMBLE_START")
    if anchor:
        a = Path(anchor).resolve()
        if here == a or a in here.parents:
            return _holding(a) or _holding(here) or a
        if in_temp(here):
            return _holding(a) or a
    return _holding(here) or here


def session_id() -> str:
    return os.environ.get("THIMBLE_SESSION") or os.environ.get("CLAUDE_CODE_SESSION_ID") or "cli"


class Store:
    def __init__(self, root: str | Path | None = None, session: str | None = None):
        self.root = Path(root).resolve() if root else find_root()
        self.session = session or session_id()
        self.dir = records_dir(self.root)
        self.cache = thimble_home() / "cache" / folder_name(str(self.root))

    def sub(self, name: str) -> Path:
        d = self.dir / name
        d.mkdir(parents=True, exist_ok=True)
        return d

    # ---------------------------------------------------------------- the change feed

    def emit(self, row: dict[str, Any]) -> None:
        """One event of the session's change feed: $THIMBLE_HOME/events/<session>.jsonl, one JSON line each,
        appended in one write. A surface follows the file by its size; an event names its folder, so the reader needs
        no other context."""
        try:
            d = thimble_home() / "events"
            d.mkdir(parents=True, exist_ok=True)
            row = {"t": round(time.time(), 3), "session": self.session, "root": str(self.root), **row}
            line = json.dumps(row, ensure_ascii=False, default=str) + "\n"
            fd = os.open(d / f"{safe_name(self.session)}.jsonl", os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
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
        d = thimble_home() / "seen"
        want = self.session if session == "" else session
        files = sorted(d.glob("*.jsonl")) if want is None else [d / f"{safe_name(want)}.jsonl"]
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
