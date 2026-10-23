"""A folder's sessions in the browser workbench, as `claude` keeps a folder's sessions: each start of thimble-browser is
a new session, as empty as the folder's first start (no chat, no cards, no report, no labels); `--continue` brings back
the latest session and `--resume` one picked from a list, whole: its chat, canvas, report and labels (cli.pick_session,
cli.open_session).

A session is a workspace folder. The page opens WORKSPACES_DIR/<c>/; each earlier session is a folder that a new one
moved aside, WORKSPACES_DIR/.archive/<c>-<time>/ (ledger.archive_workspace, the archive `/thimble fresh` makes too), and
bringing one back moves it into place again (ledger.restore_workspace), the open one going to the archive. So the
workspace keeps its one name for every route, agent and tab (a tab drops what it kept for the workspace when the
workspace's instance changes, App.tsx), and a workspace from before sessions is its folder's first session. Main's chats
inside a session are runtime.py's.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any


def _mtime(paths: list[Path]) -> float:
    out = 0.0
    for p in paths:
        try:
            out = max(out, p.stat().st_mtime)
        except OSError:
            continue
    return out


def summary(ws: Path) -> dict[str, Any]:
    """What the session in the workspace folder `ws` holds: {at (its last write that the analyst sees: a chat, a card, a
    label, a document; epoch seconds), first (the first message typed in it, one line), turns (main's, in all its
    chats), cards, labels, documents (their slugs), threads (the chats with a message in them, as agents.held_chats
    counts), chat (the chat of main to open: the latest that holds a turn, '' when none), chats (the ids of the chats of
    main that hold a turn)}. Reads only, so it reads a session moved aside as it reads the open one."""
    from . import agents, concepts, notebook, report_types, runtime  # noqa: PLC0415 — heavy, and the launcher's

    chats = runtime.chats_in(ws / runtime.DIR)
    earliest = min(chats, key=lambda r: (r.get("start") or "~", r["at"]), default=None)
    cards = sum(int(r.get("n_cells") or 0) for r in notebook.list_notebooks(ws, figures=False))
    labels = len(concepts.list_concepts(ws, trials=False))
    types = ws / "report-types"
    customs = sorted(d.name for d in types.iterdir() if d.is_dir()) if types.is_dir() else []
    slugs = [*report_types.BUILTIN_SLUGS, *customs]
    inv = ws / "investigations" / "main"
    docs = [s for s in slugs if (inv / f"{s}.json").is_file()]
    seen = [*(ws / runtime.DIR).glob("*.jsonl"), *(ws / "chats").glob("*.jsonl"), *(ws / "notebooks").glob("*.json"),
            *concepts.concepts_dir(ws).glob("*.json"), *(inv / f"{s}.json" for s in docs)]
    return {"at": _mtime(seen) or _mtime([ws]), "first": earliest["first"] if earliest else "",
            "turns": sum(int(r["turns"]) for r in chats), "cards": cards, "labels": labels, "documents": docs,
            "threads": agents.held_chats(ws), "chat": chats[0]["id"] if chats else "",
            "chats": [str(r["id"]) for r in chats]}


def holds(s: dict[str, Any]) -> bool:
    """Whether a session's summary holds anything the analyst would miss in a new session."""
    return bool(s["turns"] or s["cards"] or s["labels"] or s["documents"] or s["threads"])


def listing(c: str) -> list[dict[str, Any]]:
    """The sessions of workspace `c` that hold anything, the latest first: summary's fields, and `archive`, the name of
    the session's folder in the archive, or None for the session the page opens now."""
    from . import config, ledger  # noqa: PLC0415

    found = [(None, config.WORKSPACES_DIR / c), *((p.name, p) for p in ledger.archives(c))]
    rows = []
    for archive, ws in found:
        if ws.is_dir() and holds(s := summary(ws)):
            rows.append({**s, "archive": archive})
    return sorted(rows, key=lambda r: r["at"], reverse=True)
