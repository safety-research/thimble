"""Where the kernel keeps its records.

In the folder under analysis (the root), the `thimble/` folder holds what the person may keep, share or diff:

    thimble/objects/<nn>-<slug>.json        one object each: program + data + lineage (objects.py)
    thimble/objects/.versions/<id>/v<k>.json  its earlier versions
    thimble/queries/q<n>.json               each query with its code, inputs, output and row lineage (query.py)
    thimble/labels/<name>.json              each label with every version of its values (labels.py)
    thimble/kept/<name>.pkl                 results a query kept with keep(), which a later query reads with use()
    thimble/results/q<n>.pkl                each query's output table, which a later query reads with use("q<n>")
    thimble/ledger.jsonl                    one line per `lean` call that read rows (what was read and how)

Outside it, under $THIMBLE_HOME/lean (default ~/.thimble/lean): seen/<session>.jsonl, where the hooks module keeps the
files that Claude's own Read, Grep and Bash calls touched in each session (so a coding session in another folder never
gets a thimble/ folder), and cache/<folder>/, row counts and loaded frames, safe to delete. Nothing here writes into a
source file.
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


def find_root(start: str | Path | None = None) -> Path:
    """The folder under analysis: LEAN_ROOT, else the nearest folder at or above `start` (the working folder) that
    holds a thimble/ record folder, else `start` itself."""
    env = os.environ.get("LEAN_ROOT")
    if env:
        return Path(env).resolve()
    here = Path(start or os.getcwd()).resolve()
    d = here
    while True:
        t = d / DIR
        if (t / "queries").is_dir() or (t / "objects").is_dir() or (t / "ledger.jsonl").is_file():
            return d
        if d.parent == d:
            return here
        d = d.parent


def session_id() -> str:
    return os.environ.get("LEAN_SESSION") or os.environ.get("CLAUDE_CODE_SESSION_ID") or "cli"


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

    # ---------------------------------------------------------------- ledger

    def log(self, row: dict[str, Any]) -> None:
        self.dir.mkdir(parents=True, exist_ok=True)
        row = {"t": round(time.time(), 3), "session": self.session, **row}
        with open(self.dir / "ledger.jsonl", "a") as f:
            f.write(json.dumps(row, ensure_ascii=False, default=str) + "\n")

    def ledger(self, session: str | None = "") -> list[dict[str, Any]]:
        """Rows of the ledger: of this session (the default), of `session`, or of every session (None)."""
        want = self.session if session == "" else session
        out = []
        try:
            with open(self.dir / "ledger.jsonl") as f:
                for line in f:
                    try:
                        r = json.loads(line)
                    except ValueError:
                        continue
                    if want is None or r.get("session") == want:
                        out.append(r)
        except OSError:
            pass
        return out

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
