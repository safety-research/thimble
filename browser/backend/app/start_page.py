"""The workspaces this server knows, for the start page (the page whose URL names no workspace, or one this server does
not hold) and the top bar's switcher (frontend shell/WorkspaceList.tsx): GET /api/workspaces.

Each corpus of GET /corpora is one row, of kind `folder`, labeled by its folder's name, with its path, ordered by folder
name. A folder with sessions open at once (config.sessions_of) has a row for each, labeled with its number after the
folder's name, `logs · session 2`.

A registered folder that is gone is left out, since its workspace cannot open. The route is a read like GET /corpora,
open to the page with or without the key's cookie (hook_auth guards writes only).
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi import APIRouter

from . import config

router = APIRouter()


def rows() -> list[dict[str, Any]]:
    """Every workspace as a row of the start page (module note)."""
    from .corpus import list_corpora  # noqa: PLC0415

    out: list[dict[str, Any]] = []
    for c in list_corpora():
        name = str(c["name"])
        try:
            here = Path(c["path"]) if c.get("path") else config.corpus_dir(name)
        except ValueError:
            continue
        if not here.is_dir():
            continue
        shown = str(c.get("shown") or here)
        folder = Path(shown).name or name
        row = {"name": name, "folder": folder, "path": shown, "kind": "folder", "label": folder}
        if c.get("session"):  # one of a folder's sessions open at once (config.sessions_of)
            row.update(session=int(c["session"]), label=f"{folder} · session {c['session']}")
        out.append(row)
    out.sort(key=lambda r: (r["folder"].lower(), r["path"], r.get("session") or 0))
    return out


@router.get("/workspaces")
def list_workspaces() -> list[dict[str, Any]]:
    """The start page's rows (module note): {name, kind, label, folder, path, session?}."""
    return rows()
