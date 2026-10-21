"""The chats of a workspace: `chats/<id>.jsonl`, one record per line, and `chats/<id>.meta.json`.

The records are the ones the page folds into rows (frontend chat/model.ts): `user` (the person's message), `text` (a
piece of Claude's reply), `tool_use` and `tool_result` (what Claude did), `done` (the end of a turn) and `error`.
`main` always exists; a thread is another chat with its own Claude session.
"""
from __future__ import annotations

import json
import threading
from pathlib import Path
from typing import Any

from . import home
from .hub import hub

_lock = threading.Lock()


def _dir(ws: str) -> Path:
    d = home.workspace_dir(ws) / "chats"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _meta_path(ws: str, chat: str) -> Path:
    if not home.NAME_RE.match(chat):
        raise KeyError(chat)
    return _dir(ws) / f"{chat}.meta.json"


def new_meta(chat: str, *, kind: str = "main", title: str = "", parent: str | None = None,
             anchor: str | None = None, anchor_text: str | None = None) -> dict[str, Any]:
    return {"id": chat, "kind": kind, "role": "main" if kind == "main" else "thread", "title": title or chat,
            "created_at": home.now(), "parent": parent, "anchor": anchor, "anchor_text": anchor_text,
            "model": None, "effort": None, "group": None, "session_id": None}


def ensure_main(ws: str) -> None:
    p = _meta_path(ws, "main")
    if not p.exists():
        home.write_json(p, new_meta("main", title="main"))


def meta(ws: str, chat: str) -> dict[str, Any]:
    if chat == "main":
        ensure_main(ws)
    m = home.read_json(_meta_path(ws, chat))
    if not isinstance(m, dict):
        raise KeyError(chat)
    return m


def save_meta(ws: str, m: dict[str, Any]) -> None:
    home.write_json(_meta_path(ws, m["id"]), m)


def records(ws: str, chat: str) -> list[dict[str, Any]]:
    p = _dir(ws) / f"{chat}.jsonl"
    out = []
    try:
        with open(p, encoding="utf-8") as f:
            for line in f:
                try:
                    out.append(json.loads(line))
                except ValueError:
                    continue
    except OSError:
        pass
    return out


def read_paths(ws: str, folder: Path) -> list[str]:
    """The paths in `folder` of the files Claude read in the workspace's chats (its Read calls), so a citation of a
    path that several files end with is read at the one Claude read (corpus.locate)."""
    root = folder.resolve()
    out: list[str] = []
    for log in sorted(_dir(ws).glob("*.jsonl")):
        for rec in records(ws, log.stem):
            inp = rec.get("input") if rec.get("type") == "tool_use" and rec.get("name") == "Read" else None
            p = inp.get("file_path") if isinstance(inp, dict) else None
            if not isinstance(p, str) or not p:
                continue
            q = Path(p) if Path(p).is_absolute() else root / p
            try:
                out.append(str(q.resolve().relative_to(root)))
            except (ValueError, OSError):
                continue
    return out


def append(ws: str, chat: str, rec: dict[str, Any], *, notify: bool = True) -> None:
    rec = {**rec}
    rec.setdefault("ts", home.now())
    with _lock:
        with open(_dir(ws) / f"{chat}.jsonl", "a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    if notify:
        hub.publish(ws, {"type": "chat", "chat": chat})


def listing(ws: str, running: set[str]) -> list[dict[str, Any]]:
    ensure_main(ws)
    rows = []
    for p in sorted(_dir(ws).glob("*.meta.json")):
        m = home.read_json(p)
        if not isinstance(m, dict):
            continue
        recs = records(ws, m["id"])
        rows.append({**m, "n_messages": sum(1 for r in recs if r.get("type") == "user"),
                     "last_ts": recs[-1].get("ts") if recs else None, "running": m["id"] in running})
    rows.sort(key=lambda m: (m["id"] != "main", m.get("created_at") or ""))
    return rows


def delete(ws: str, chat: str) -> None:
    for p in (_meta_path(ws, chat), _dir(ws) / f"{chat}.jsonl"):
        try:
            p.unlink()
        except OSError:
            pass
    hub.publish(ws, {"type": "chat", "chat": chat, "deleted": True})
