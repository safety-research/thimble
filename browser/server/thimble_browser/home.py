"""Where thimble browser keeps its things, and the workspaces it knows.

The home folder is $THIMBLE_BROWSER_HOME, else ~/.thimble-browser. It holds:
- server.json: the port and pid of the server that runs now;
- browsers.json: the sha256 of each signed-in browser's cookie and key (auth.py);
- workspaces/<name>/: one folder per folder of files the person opened: workspace.json (the folder's path), its
  chats, its cards, its canvas and its documents;
- tmp/<name>/: the workspace's temp folder, `$TMPDIR` of the code Claude runs there, where it writes a card's rows.

thimble browser never writes into the folder of files itself.
"""
from __future__ import annotations

import json
import os
import re
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def root() -> Path:
    env = os.environ.get("THIMBLE_BROWSER_HOME")
    p = Path(env).expanduser() if env else Path.home() / ".thimble-browser"
    p.mkdir(parents=True, exist_ok=True)
    try:
        p.chmod(0o700)
    except OSError:
        pass
    return p


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def read_json(p: Path, default: Any = None) -> Any:
    try:
        return json.loads(p.read_text())
    except (OSError, ValueError):
        return default


def write_json(p: Path, obj: Any) -> None:
    """Write `obj` to `p` in one step (a temp file renamed over it)."""
    p.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=p.parent, prefix=".tmp-")
    with os.fdopen(fd, "w") as f:
        json.dump(obj, f, indent=1, ensure_ascii=False)
    os.replace(tmp, p)


def workspaces_dir() -> Path:
    d = root() / "workspaces"
    d.mkdir(parents=True, exist_ok=True)
    return d


NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$")


def slug(text: str) -> str:
    s = re.sub(r"[^A-Za-z0-9._-]+", "-", text).strip("-.") or "files"
    return s[:60]


def workspace_dir(name: str) -> Path:
    if not NAME_RE.match(name):
        raise KeyError(name)
    d = workspaces_dir() / name
    if not (d / "workspace.json").is_file():
        raise KeyError(name)
    return d


def temp_dir(name: str) -> Path:
    """The workspace's temp folder (mode 700): the one folder the code Claude runs may write, kept between runs, so
    a card can read the rows its code wrote."""
    workspace_dir(name)
    d = root() / "tmp" / name
    d.mkdir(parents=True, exist_ok=True, mode=0o700)
    return d


def corpus_of(name: str) -> Path:
    meta = read_json(workspace_dir(name) / "workspace.json", {})
    return Path(meta["corpus"])


def open_folder(folder: Path) -> str:
    """The workspace of `folder`, made the first time it is opened."""
    folder = folder.expanduser().resolve()
    if not folder.is_dir():
        raise NotADirectoryError(str(folder))
    for d in sorted(workspaces_dir().iterdir()):
        meta = read_json(d / "workspace.json", {})
        if meta.get("corpus") == str(folder):
            return d.name
    base = slug(folder.name)
    name, n = base, 2
    while (workspaces_dir() / name).exists():
        name, n = f"{base}-{n}", n + 1
    write_json(workspaces_dir() / name / "workspace.json", {"corpus": str(folder), "created": now()})
    return name


def list_workspaces() -> list[dict[str, Any]]:
    rows = []
    for d in sorted(workspaces_dir().iterdir()):
        meta = read_json(d / "workspace.json")
        if isinstance(meta, dict) and meta.get("corpus"):
            rows.append({"name": d.name, "corpus": meta["corpus"], "created": meta.get("created")})
    return rows
