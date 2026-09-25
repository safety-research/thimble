"""`thimble list` and `thimble purge`: the install's workspaces by id, and deleting one.

An id is a workspace's name: a registered folder's live workspace, or an archived run `/thimble fresh` moved aside
(ledger.archive_path). The rows come from the disk (the registry and the workspaces folder, as cli.resolve_env
resolves them), so `list` works with the server down; open sessions are counted only when this install's server
answers GET /api/channel/sessions for the same folders.

`purge <id>…` prints its plan and asks unless -y; --dry-run stops after the plan. A live workspace is deleted through
the server when it is up (DELETE /api/ws/<c>?idle=true), else from the disk, and its registration goes too. A
workspace a session holds open is refused, and every workspace is refused when the server's sessions cannot be read.
Only direct children of the workspaces folder and the registry are touched, never a link.

Imports only `config` and the standard library at load, as cli.py does (ledger's names are repeated here and a test
holds them equal)."""
from __future__ import annotations

import json
import os
import re
import shutil
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, TextIO

from . import config

ARCHIVE_DIR = ".archive"  # ledger.ARCHIVE_DIR
# ledger.archive_path's names: <c>-<local time>, with -2, -3 … for two archives of one second
ARCHIVE_RE = re.compile(r"^(?P<ws>.+)-(?P<when>\d{4}-\d{2}-\d{2}-\d{6})(?:-(?P<n>\d+))?$")
SIDECAR_SUFFIX = config.SIDECAR_SUFFIX
SESSIONS_PATH = "/api/channel/sessions"
UP, DOWN, OTHER, UNKNOWN = "up", "down", "other", "unknown"  # what answers on the port (server)


@dataclass
class Row:
    id: str
    kind: str  # "workspace" or "archive"
    workspace: str  # the workspace's name; an archive's is the one it was moved from
    folder: str | None  # the registered folder (its root), None when no registration names it
    path: Path | None  # the workspace or archive folder; None for a registration with no workspace yet
    sidecar: Path | None  # <data>/<c>.corpus.json, None for a corpus directory or no registration
    corpus_dir: Path | None  # <data>/<c>/ when the corpus is a directory in the registry (never deleted)
    last_used: float | None  # the newest mtime under `path`
    sessions: int | None = None  # open sessions, None when not counted

    @property
    def folder_gone(self) -> bool:
        return self.folder is not None and not Path(self.folder).is_dir()


def dirs() -> tuple[Path, Path]:
    """(the registry, the workspaces folder) the server runs with (cli.resolve_env), resolved."""
    from . import cli  # noqa: PLC0415 — cli imports this module lazily too

    env = cli.resolve_env()
    return Path(env["data_dir"]).resolve(), Path(env["workspaces_dir"]).resolve()


def _valid(name: str) -> bool:
    return config.NAME_RE.fullmatch(name) is not None and not name.startswith(".")


def _same(a: Path, b: Path) -> bool:
    """Whether two paths name one folder: equal once resolved, or one inode (macOS folds case, Path.resolve() does
    not)."""
    try:
        return a.resolve() == b.resolve() or os.path.samefile(a, b)
    except OSError:
        return False


def registrations(data: Path) -> dict[str, tuple[str, Path | None, Path | None]]:
    """name -> (folder, sidecar, corpus directory): every readable sidecar (its `root`, else `path`) and every corpus
    directory <data>/<c>/manifest.json, which wins a name both hold, as config.corpus_dir reads them."""
    out: dict[str, tuple[str, Path | None, Path | None]] = {}
    try:
        entries = sorted(data.iterdir())
    except OSError:
        return out
    for p in entries:
        if p.name.endswith(SIDECAR_SUFFIX) and p.is_file() and not p.is_symlink():
            name = p.name[: -len(SIDECAR_SUFFIX)]
            try:
                rec = json.loads(p.read_text("utf-8"))
            except (OSError, ValueError):
                continue
            if not _valid(name) or not isinstance(rec, dict) or not isinstance(rec.get("path"), str):
                continue
            root = rec.get("root") if isinstance(rec.get("root"), str) and rec.get("root") else rec["path"]
            out.setdefault(name, (root, p, None))
    for p in entries:
        if p.is_dir() and not p.is_symlink() and _valid(p.name) and (p / "manifest.json").is_file():
            out[p.name] = (str(p), None, p)
    return out


def last_used(path: Path) -> float | None:
    """The newest modification time of `path` or anything under it; None when it cannot be read."""
    try:
        newest = path.stat().st_mtime
    except OSError:
        return None
    for top, subdirs, files in os.walk(path):
        for n in (*subdirs, *files):
            try:
                newest = max(newest, os.lstat(os.path.join(top, n)).st_mtime)
            except OSError:
                pass
    return newest


def _archive_order(r: Row) -> tuple[str, int]:
    """An archive's place: its time, then the -2, -3 of one second (ledger.archives' order)."""
    m = ARCHIVE_RE.match(r.id)
    return (m.group("when"), int(m.group("n") or 1)) if m else ("", 0)


def rows(data: Path, ws: Path, sessions: dict[str, int] | None = None) -> list[Row]:
    """Every id: each workspace (registered, or a folder in `ws`) followed by its archived runs, newest first; the
    workspaces most recently used first, a registration with no workspace yet last."""
    regs = registrations(data)
    names = set(regs)
    try:
        on_disk = {p.name for p in ws.iterdir() if p.is_dir() and not p.is_symlink() and _valid(p.name)}
    except OSError:
        on_disk = set()
    # a folder that is a registered name's own under another case (macOS folds case) is that workspace, not a second
    # one: purged under its own name it would go around the registered one's open sessions
    names |= {n for n in on_disk if not any(r != n and r.lower() == n.lower() and _same(ws / r, ws / n) for r in regs)}
    archives: dict[str, list[Row]] = {}
    try:
        found = sorted((ws / ARCHIVE_DIR).iterdir())
    except OSError:
        found = []
    for p in found:
        m = ARCHIVE_RE.match(p.name)
        if not m or not p.is_dir() or p.is_symlink():
            continue
        c = m.group("ws")
        folder = regs[c][0] if c in regs else None
        archives.setdefault(c, []).append(Row(p.name, "archive", c, folder, p, None, None, last_used(p)))
    groups: list[list[Row]] = []
    for c in names | set(archives):
        group: list[Row] = []
        if c in names:
            folder, sidecar, corpus_dir = regs.get(c, (None, None, None))
            path = ws / c
            has = path.is_dir() and not path.is_symlink()
            count = None if sessions is None else sessions.get(c, 0)
            group.append(Row(c, "workspace", c, folder, path if has else None, sidecar, corpus_dir,
                             last_used(path) if has else None, count))
        group += sorted(archives.get(c, []), key=_archive_order, reverse=True)
        groups.append(group)
    groups.sort(key=lambda g: (-max((r.last_used or 0.0) for r in g), g[0].workspace))
    return [r for g in groups for r in g]


def ago(t: float | None, now: float) -> str:
    if t is None:
        return "-"
    s = max(now - t, 0.0)
    if s < 60:
        return "just now"
    if s < 3600:
        return f"{int(s // 60)} min ago"
    if s < 86400:
        return f"{int(s // 3600)} h ago"
    if s < 7 * 86400:
        return f"{int(s // 86400)} d ago"
    return time.strftime("%Y-%m-%d", time.localtime(t))


def tilde(p: str) -> str:
    h = str(Path.home())
    return "~" + p[len(h):] if p == h or p.startswith(h + os.sep) else p


def _folder_cell(r: Row) -> str:
    if r.folder is None:
        return "(not registered)"
    return tilde(r.folder) + (" (folder gone)" if r.folder_gone else "")


def _used_cell(r: Row, now: float) -> str:
    return "no workspace" if r.kind == "workspace" and r.path is None else ago(r.last_used, now)


def _sessions_cell(r: Row, unknown: bool) -> str:
    if r.kind == "archive":
        return "archived"
    if unknown:
        return "?"
    return "-" if not r.sessions else f"{r.sessions} open"


def table(found: list[Row], now: float, unknown: bool = False) -> list[str]:
    """The rows as columns; SESSIONS is `?` when the server answers without saying them (UNKNOWN)."""
    head = ("ID", "FOLDER", "LAST USED", "SESSIONS")
    cells = [(r.id, _folder_cell(r), _used_cell(r, now), _sessions_cell(r, unknown)) for r in found]
    widths = [max(len(row[i]) for row in [head, *cells]) for i in range(3)]
    return ["  ".join([*(row[i].ljust(widths[i]) for i in range(3)), row[3]]).rstrip() for row in [head, *cells]]


@dataclass
class Probe:
    state: str  # UP, DOWN, OTHER or UNKNOWN (server)
    sessions: dict[str, int] | None = None  # workspace -> its open sessions, when UP
    note: str = ""  # why they are not counted, when not UP


def server(data: Path, ws: Path) -> Probe:
    """What answers on this install's port. UP: this install's server on `data` and `ws`, with its sessions per
    workspace.
    DOWN: nothing. OTHER: a server that never serves these workspaces. UNKNOWN: something that does not report its
    sessions and folders, or shares only one folder; purge deletes nothing then."""
    from . import cli  # noqa: PLC0415

    url, p = cli.api_url(), cli.port()
    if not cli.healthy(url):
        if not cli.listening(p):
            return Probe(DOWN, note="the server is not running")
        return Probe(UNKNOWN, note=f"something other than a healthy thimble server answers on port {p}")
    other = cli.foreign_home(url)
    if other:
        return Probe(OTHER, note=f"the server on port {p} is another install's ({other})")
    status, body = cli._request("GET", url + SESSIONS_PATH, timeout=cli.HEALTH_TIMEOUT_S * 3)
    body = body if status == 200 and isinstance(body, dict) else {}
    got, its_data, its_ws = body.get("workspaces"), body.get("data_dir"), body.get("workspaces_dir")
    if not isinstance(got, dict) or not isinstance(its_data, str) or not isinstance(its_ws, str):
        return Probe(UNKNOWN, note="the running server is older than this thimble; `thimble server restart` fixes it")
    same = (_same(Path(its_data), data), _same(Path(its_ws), ws))
    if same == (True, True):
        return Probe(UP, {str(c): len(s) for c, s in got.items() if isinstance(s, list)})
    if same == (False, False):
        return Probe(OTHER, note=f"the server on port {p} works on other folders ({its_data}, {its_ws})")
    return Probe(UNKNOWN, note=f"the server on port {p} uses {its_data} and {its_ws}, only one of which "
                               "is listed here")


# ----------------------------------------------------------------------------- the commands


def list_lines(now: float | None = None) -> list[str]:
    data, ws = dirs()
    probe = server(data, ws)
    found = rows(data, ws, probe.sessions)
    if not found:
        return ["thimble: no workspaces yet; run `thimble` in a folder of transcripts to start one"]
    unknown = probe.state == UNKNOWN
    lines = table(found, time.time() if now is None else now, unknown=unknown)
    if probe.state != UP:
        # UNKNOWN's `?` says they are not counted; its note says why
        lines.append(f"Open sessions unknown: {probe.note}." if unknown else
                     f"({probe.note}, so open sessions are not counted)")
    return lines


def _child(root: Path, name: str) -> Path | None:
    """root/name when it is a direct child of `root` and not a link (reset_workspace's guard), else None."""
    p = root / name
    if not _valid(name) and not ARCHIVE_RE.match(name):
        return None
    if p.is_symlink() or p.resolve().parent != root.resolve() or p.resolve() == root.resolve():
        return None
    return p


def resolve(ids: list[str], found: list[Row]) -> tuple[list[Row], list[str], list[str]]:
    """(the rows the ids name, in the order given, each once; the ids that name none; the ids that name two, a
    workspace and an archive)."""
    by_id: dict[str, list[Row]] = {}
    for r in found:
        by_id.setdefault(r.id, []).append(r)
    picked: list[Row] = []
    unknown: list[str] = []
    ambiguous: list[str] = []
    for i in ids:
        named = by_id.get(i, [])
        if not named:
            unknown.append(i)
        elif len(named) > 1:
            ambiguous.append(i)
        elif named[0] not in picked:
            picked.append(named[0])
    return picked, unknown, ambiguous


def targets(picked: list[Row]) -> list[str]:
    """What purge deletes, one phrase per directory or file, in order."""
    out: list[str] = []
    for r in picked:
        if r.path is not None:
            out.append(tilde(str(r.path)))
        if r.kind == "workspace" and r.sidecar is not None:
            out.append(f"the registration {tilde(str(r.sidecar))}")
    return out


def _served(r: Row) -> bool:
    """Whether the server knows the live workspace, so its DELETE ends what runs for it: a registered folder that is
    there."""
    return r.folder is not None and not r.folder_gone


def _delete_workspace(r: Row, ws: Path, up: bool) -> str | None:
    """Delete a live workspace's folder, through the server when it is up; an error line, or None."""
    from . import cli  # noqa: PLC0415

    if r.path is None:
        return None
    p = _child(ws, r.id)
    if p is None:
        return f"{r.id}: refusing to delete {r.path}: not a folder directly in {ws}"
    if up and _served(r):
        # idle: the server refuses (409) a workspace a session holds open at this moment, not only before purge asked
        status, body = cli._request("DELETE", f"{cli.api_url()}/api/ws/{r.id}?idle=true", timeout=60.0)
        if status == 200:
            return None
        detail = str(body.get("detail") if isinstance(body, dict) else body)[:200]
        if status == 409:
            return f"{r.id}: not deleted, a session opened on it since purge counted them ({detail})"
        if status != 404:  # the disk would go around a server that may still run something for it
            return f"{r.id}: not deleted: the server answered {status or 'nothing'} ({detail})"
        # the corpus unknown to the server (404): nothing of it runs there, so the disk
        cli._log(f"purge {r.id}: DELETE /api/ws answered 404 {detail}; deleting from the disk")
    try:
        shutil.rmtree(p)
    except FileNotFoundError:
        pass
    except OSError as e:
        return f"{r.id}: could not delete {p}: {e}"
    return None


def _delete(r: Row, data: Path, ws: Path, up: bool) -> str | None:
    if r.kind == "archive":
        p = _child(ws / ARCHIVE_DIR, r.id)
        if p is None:
            return f"{r.id}: refusing to delete {r.path}: not a folder directly in {ws / ARCHIVE_DIR}"
        try:
            shutil.rmtree(p)
        except OSError as e:
            return f"{r.id}: could not delete {p}: {e}"
        return None
    err = _delete_workspace(r, ws, up)
    if err:
        return err
    if r.sidecar is not None:
        s = _child(data, r.id + SIDECAR_SUFFIX)
        if s is None or not s.is_file():
            return f"{r.id}: refusing to remove {r.sidecar}: not a file directly in {data}"
        try:
            s.unlink()
        except FileNotFoundError:
            pass
        except OSError as e:
            return f"{r.id}: could not remove {s}: {e}"
    return None


def purge(ids: list[str], *, yes: bool = False, dry_run: bool = False, stdin: TextIO | None = None,
          out: Callable[[str], None] = print) -> int:
    """Delete what the ids name, then say what went, one line each. `yes` and `stdin` are accepted and unused."""
    del yes, stdin
    data, ws = dirs()
    probe = server(data, ws)
    found = rows(data, ws, probe.sessions)
    picked, unknown, ambiguous = resolve(ids, found)
    if unknown:
        out(f"thimble purge: nothing is called {', '.join(unknown)}. Run `thimble list` to see the ids.")
    if ambiguous:
        out(f"thimble purge: {', '.join(ambiguous)} is both a workspace and an archived run. Delete the one you mean "
            f"by hand, in {tilde(str(ws))} or {tilde(str(ws / ARCHIVE_DIR))}.")
    if unknown or ambiguous:
        return 1
    held = [r for r in picked if r.kind == "workspace" and r.sessions]
    if held:
        for r in held:
            many = r.sessions > 1
            out(f"thimble purge: {r.id} has {r.sessions} session{'s' if many else ''} running (claude in "
                f"{tilde(r.folder or '?')}). Quit {'them' if many else 'it'} before purging. Nothing deleted.")
        return 1
    live = [r.id for r in picked if r.kind == "workspace"]
    if probe.state == UNKNOWN and live:
        out(f"thimble purge: {', '.join(live)} might still have a session running. Run `thimble server stop` before "
            "purging. Nothing deleted.")
        return 1
    if dry_run:
        for t in targets(picked):
            out(f"thimble purge: would delete {t}")
        return 0
    errors = 0
    for r in picked:
        err = _delete(r, data, ws, probe.state == UP)
        if err:
            errors += 1
            out(f"thimble purge: {err}")
        else:
            for t in targets([r]):
                out(f"thimble purge: deleted {t}")
    if probe.state != UP and live:
        # a Claude session outlives its server, and its next write makes the workspace again
        out(f"(open sessions not checked: {probe.note})")
    return 1 if errors else 0
