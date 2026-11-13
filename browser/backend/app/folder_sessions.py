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

A folder can have several sessions open at once, in two shells or two tabs. Each session open beside the folder's own
is a workspace of its own, `c.2`, `c.3` … (config.add_session), so they run side by side, each with its own main,
agents, kernels, temp folder, chat, canvas, report, labels and settings, and only the folder's files are shared, as two
Claude Code sessions in one folder share them. A session is open while a page shows it (a tab follows its events) or a
thimble-browser holds it (cli.hold_session); one the picker opened a moment ago counts as open too, until its tab has
loaded (is_open). An open session is never moved aside: a new or resumed session goes into the first of the folder's
workspaces that is not open, or a new one (open_session). The page's session picker (GET /api/ws/{c}/sessions, POST
/api/ws/{c}/sessions/open) and thimble-browser's --new, --continue and --resume (POST /api/ws/{c}/sessions, the CLI's
route) choose the same way.

A workbench that ran with another workspaces folder (THIMBLE_WORKSPACES_DIR) left its sessions there, and a start with
this one finds none of them. `elsewhere` reads a workspace's sessions in such a folder, so that the start says where
they are (cli.elsewhere_line).
"""
from __future__ import annotations

import time
from pathlib import Path
from typing import Any

OPENING_S = 60.0  # how long a session opened from the page or the CLI counts as open before a tab shows it (is_open)
_opening: dict[str, float] = {}  # workspace -> when open_session opened it


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


def listing(c: str, held: frozenset[str] | set[str] = frozenset()) -> list[dict[str, Any]]:
    """The sessions of the folder of workspace `c` that hold anything, in each of its workspaces (config.sessions_of),
    the latest first: summary's fields, `slot`, the workspace the session is open in or was moved aside from, and
    `archive`, the name of the session's folder in the archive, or None for a session open now. A session open in a
    workspace of `held` (one a thimble-browser in another shell holds) is listed even when it holds nothing yet, with
    `held` True."""
    from . import config, ledger  # noqa: PLC0415

    found = []
    for slot in config.sessions_of(config.session_of(c)):
        found += [(slot, None, config.WORKSPACES_DIR / slot), *((slot, p.name, p) for p in ledger.archives(slot))]
    rows = []
    for slot, archive, ws in found:
        live = archive is None and slot in held
        s = summary(ws) if ws.is_dir() else None
        if live and s is None:
            s = {"at": time.time(), "first": "", "turns": 0, "cards": 0, "labels": 0, "documents": [], "threads": 0,
                 "chat": "", "chats": []}
        if s is not None and (live or holds(s)):
            rows.append({**s, "archive": archive, "slot": slot, "held": live})
    return sorted(rows, key=lambda r: r["at"], reverse=True)


def elsewhere(c: str, folder: Path) -> list[dict[str, Any]]:
    """listing, of the workspaces folder `folder` in place of the server's: the sessions of workspace `c` that a
    workbench which ran with that folder left there. Reads only, and a folder that is not there costs one look."""
    if not folder.is_dir():
        return []
    from . import config  # noqa: PLC0415

    held = config.WORKSPACES_DIR
    config.WORKSPACES_DIR = folder
    try:
        return listing(c)
    finally:
        config.WORKSPACES_DIR = held


# --------------------------------------------------------------------------- open sessions, and opening one


def is_open(w: str) -> bool:
    """Whether workspace `w`'s session is open now (module note): a tab follows its events, a thimble-browser holds it
    (cli.held_elsewhere), or open_session opened it within OPENING_S."""
    from . import cli, investigation  # noqa: PLC0415

    if investigation._subscribers.get((w, investigation.MAIN)):
        return True
    if time.monotonic() - _opening.get(w, -OPENING_S) < OPENING_S:
        return True
    return cli.held_elsewhere(w)


def sessions(c: str) -> dict[str, Any]:
    """The page's session picker for the folder of workspace `c` (GET /api/ws/{c}/sessions): {folder (its own
    workspace), label (the folder's name), path, sessions: listing's rows of every session open now (`open`, even one
    that holds nothing yet) and of those moved aside, the latest first}."""
    from . import config  # noqa: PLC0415

    folder = config.session_of(c)
    rec = config.read_sidecar(folder) or {}
    path = str(rec.get("shown") or rec.get("path") or config.corpus_dir(folder))
    opened = {w for w in config.sessions_of(folder) if is_open(w)}
    rows = [{k: v for k, v in r.items() if k not in ("held", "chats")} | {"open": r["held"]} for r in listing(folder, opened)]
    return {"folder": folder, "label": Path(path).name or folder, "path": path, "sessions": rows}


async def open_session(c: str, *, new: bool = False, archive: str | None = None, slot: str | None = None,
                       chat: str | None = None, reserve: bool = False) -> dict[str, Any]:
    """Open a session of the folder of workspace `c`, and its chat of main: a new one (`new`), one moved aside
    (`archive`, the name of its folder in the archive), or the one open in a workspace of the folder (`slot`). A
    session open now (is_open) is opened as it is, nothing moved. A new or archived one goes into the first of the
    folder's workspaces that is not open, else a new one (config.add_session): there a session that holds anything
    moves aside (ledger.archive_workspace) and the archived one comes back (ledger.restore_workspace). The chat is
    `chat`, else the session's latest chat of main with a turn, else a new one. With `reserve` (the page's picker, whose
    tab then loads the workspace) the workspace counts as open for OPENING_S (is_open); the CLI holds the one it opens
    itself (cli.hold_session). {name: the workspace that shows it, open: whether it was open already}. ValueError for a
    slot or archive the folder does not have."""
    from . import config, ledger, runtime  # noqa: PLC0415

    folder = config.session_of(c)
    family = config.sessions_of(folder)
    if not new and not archive:
        target = slot or folder
        if target not in family:
            raise ValueError(f"{target!r} is not a session of {folder!r}")
        if is_open(target):
            return {"name": target, "open": True}
        ws = config.WORKSPACES_DIR / target
        pick = chat or (summary(ws)["chat"] if ws.is_dir() else "") or runtime.NEW
    else:
        src = None
        if archive:
            src = next((p for w in family for p in ledger.archives(w) if p.name == archive), None)
            if src is None:
                raise ValueError(f"{folder!r} has no session moved aside as {archive!r}")
        target = next((w for w in family if not is_open(w)), None) or config.add_session(folder)["name"]
        if reserve:
            _opening[target] = time.monotonic()  # held from here, so a second open at once takes another workspace
        if src is not None:
            pick = chat or summary(src)["chat"] or runtime.NEW
            await ledger.restore_workspace(target, {"archive": archive})
        else:
            pick = chat or runtime.NEW
            ws = config.WORKSPACES_DIR / target
            if ws.is_dir() and holds(summary(ws)):
                await ledger.archive_workspace(target)
    if reserve:
        _opening[target] = time.monotonic()
    await runtime.ensure(target).switch(None if pick == runtime.NEW else pick)
    return {"name": target, "open": False}
