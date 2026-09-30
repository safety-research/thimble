"""The plain-file helpers every store uses (atomic JSON writes, JSONL appends, per-log sequence numbers), the workspace
settings routes, the workspace reset, its archive (`/thimble fresh`) and an archive's restore (`/thimble resume`).

`BOOT_ID` names this server process: a log that stamps it shows a restart as a change of boot id, and `last_seq` /
`heal_tail` let a per-log sequence counter resume after one.
"""
from __future__ import annotations

import json
import logging
import os
import re
import secrets
import shutil
import tempfile
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from fastapi import APIRouter, Body, HTTPException, Request

from . import config

log = logging.getLogger("thimble.ledger")
router = APIRouter()

# GET /settings layers these under what the file stores (tools.RESULT_LINES_KEY: lines of each output a card's result
# shows). hide_chat: the browser shows no chat column, only a dock (frontend shell/Shell)
SETTINGS_DEFAULTS: dict[str, Any] = {"run_cell_result_lines": 40, "hide_chat": False}
# Settings earlier builds stored that nothing reads any more: GET leaves them out, a PUT that sends one (a tab still
# running an earlier build) is taken with the key dropped, and the next PUT removes it from the file. Each picked how
# an earlier build ran the orientation.
RETIRED_KEYS = frozenset({"orient_route", "terminal_first"})


# --------------------------------------------------------------------------- plain-file helpers


# One id per server process, drawn at import: two boot ids in one log mean the server restarted between them, and a
# sequence that continues across the change says nothing was lost.
BOOT_ID: str = secrets.token_hex(4)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def ws_dir(name: str) -> Path:
    try:
        return config.workspace_dir(name)
    except ValueError as e:
        raise HTTPException(404, str(e))


def read_json(path: Path, default: Any) -> Any:
    if not path.is_file():
        return default
    return json.loads(path.read_text("utf-8"))


def _own_tmp(path: Path) -> Path:
    """A temp file of this writer's own beside `path`, so two concurrent writers never share a temp name. The `.tmp`
    suffix keeps the file under the export's ignore patterns."""
    fd, tmp = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent))
    os.close(fd)
    return Path(tmp)


def atomic_write_bytes(path: Path, data: bytes) -> None:
    """Write-to-temp + os.replace: a reader sees the old file or the new one, never a torn one; concurrent writers both
    land whole and the later wins; a failed write leaves no temp. A symlink at `path` is replaced, not followed."""
    tmp = _own_tmp(path)
    try:
        tmp.write_bytes(data)
        os.replace(tmp, path)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise


def atomic_write_text(path: Path, text: str) -> None:
    atomic_write_bytes(path, text.encode("utf-8"))


def unlinked(base: Path, path: Path) -> Path:
    """`path`, which must lie under `base` with no symlink among the folders between them, so that a write or removal
    there stays under `base` (a kernel can plant symlinks in a workspace); ValueError otherwise."""
    try:
        rel = path.relative_to(base)
    except ValueError:
        raise ValueError(f"{path} is not under {base}") from None
    at = base
    for part in rel.parts[:-1]:
        at = at / part
        if at.is_symlink():
            raise ValueError(f"{at} is a symlink")
    return path


def write_json(path: Path, obj: Any) -> None:
    atomic_write_text(path, json.dumps(obj, indent=2, ensure_ascii=False))


def write_json_once(path: Path, obj: Any) -> bool:
    """write_json for a file created once and never rewritten: if `path` exists by the time this writer would replace
    it, the other writer's file is kept and this temp removed. True when this call wrote the file."""
    tmp = _own_tmp(path)
    try:
        tmp.write_text(json.dumps(obj, indent=2, ensure_ascii=False), "utf-8")
        if path.exists():
            return False
        os.replace(tmp, path)
        return True
    finally:
        tmp.unlink(missing_ok=True)


def append_jsonl(path: Path, obj: Any) -> None:
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(obj, ensure_ascii=False) + "\n")


APPEND_CHUNK = 10_000  # rows serialised per write in append_jsonl_many
TAIL_BYTES = 16_384  # what last_seq reads from the end of a log


def append_jsonl_many(path: Path, objs: Iterable[Any], *, sync: bool = False) -> int:
    """Append every row of `objs` with one open, byte-for-byte as append_jsonl per row; an empty batch creates nothing.
    Returns the count. Rows are serialised APPEND_CHUNK at a time, each write a whole number of lines. With `sync` the
    file is fsync'd before closing, so the rows survive a power cut once the caller answers."""
    n = 0
    buf: list[str] = []
    f = None
    try:
        for o in objs:
            if f is None:
                f = open(path, "a", encoding="utf-8")
            buf.append(json.dumps(o, ensure_ascii=False) + "\n")
            n += 1
            if len(buf) >= APPEND_CHUNK:
                f.write("".join(buf))
                buf.clear()
        if buf:
            f.write("".join(buf))
        if sync and f is not None:
            f.flush()
            os.fsync(f.fileno())
    finally:
        if f is not None:
            f.close()
    return n


def heal_tail(path: Path) -> bool:
    """Terminate a torn last line so the next append does not glue onto the fragment; readers skip the fragment itself.
    True when a newline was added; nothing for a missing or empty file."""
    try:
        with open(path, "rb") as f:
            f.seek(-1, 2)
            torn = f.read(1) != b"\n"
    except OSError:
        return False
    if torn:
        with open(path, "ab") as f:
            f.write(b"\n")
    return torn


_seqs: dict[Path, int] = {}  # next seq per log file this process hands out; resumed from the file's tail when unknown
_seq_locks: dict[Path, threading.RLock] = {}  # one per log file: the counter and the append it numbers are taken together
_seq_locks_guard = threading.Lock()


def seq_lock(path: Path) -> threading.RLock:
    """The lock of the log at `path`. A caller that heals the tail, draws seqs and appends holds it across the three so
    two threads cannot interleave. Re-entrant."""
    with _seq_locks_guard:
        lock = _seq_locks.get(path)
        if lock is None:
            lock = _seq_locks[path] = threading.RLock()
        return lock


def next_seq(path: Path, n: int = 1) -> int:
    """The first of `n` consecutive seqs for the log at `path`: after the highest this process handed out and the
    highest stored. A seq is never reused; the read and the advance are one step under seq_lock(path)."""
    with seq_lock(path):
        nxt = max(_seqs.get(path, 0), last_seq(path) + 1)
        _seqs[path] = nxt + n
        return nxt


def last_seq(path: Path, key: str = "seq") -> int:
    """The highest integer `key` among the parseable lines in the file's last TAIL_BYTES (-1 when none): what a
    per-log sequence resumes after. A torn or foreign last line is skipped, never counted."""
    try:
        with open(path, "rb") as f:
            f.seek(0, 2)
            size = f.tell()
            f.seek(max(0, size - TAIL_BYTES))
            tail = f.read().decode("utf-8", "replace")
    except OSError:
        return -1
    best = -1
    for line in tail.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            e = json.loads(line)
        except ValueError:
            continue
        if isinstance(e, dict) and isinstance(e.get(key), int) and not isinstance(e.get(key), bool):
            best = max(best, e[key])
    return best


# --------------------------------------------------------------------------- settings


def stored_settings(c: str) -> dict[str, Any]:
    """What workspaces/<c>/settings.json holds, no defaults layered; {} for a missing or empty file. 404 for an unknown
    workspace; a broken file raises as read_json does."""
    stored = read_json(ws_dir(c) / "settings.json", {})
    return stored if isinstance(stored, dict) else {}


def with_features(stored: dict[str, Any], c: str | None = None) -> dict[str, Any]:
    """The effective settings: SETTINGS_DEFAULTS under `stored` less RETIRED_KEYS, `models` as config.models_for resolves
    them from thimble's config with a row per agent of the active extensions (extensions.agent_models), the permission
    modes the config sets (modes.rows), `disabled_modes`, those the analyst's Claude Code settings turn off,
    `config_error`, the config's error or '', and `untrusted`, {folder, command} while Claude Code does not trust the
    workspaces folder, so the background sessions cannot start (bg_session.trusted)."""
    from . import bg_session, cli, extensions, modes, userconf  # noqa: PLC0415 — they import this module

    kept = {k: v for k, v in stored.items() if k not in RETIRED_KEYS and k != modes.SETTING}
    untrusted = None if c is None or bg_session.trusted(c) else {"folder": str(config.WORKSPACES_DIR),
                                                                  "command": cli.trust_command()}
    models = {**config.models_for(c), **extensions.agent_models(c)}
    return {**SETTINGS_DEFAULTS, **kept, config.MODELS_KEY: models, modes.SETTING: modes.rows(c) if c else {},
            "disabled_modes": sorted(modes.disabled()), "config_error": userconf.problem(c), "untrusted": untrusted}


@router.get("/ws/{c}/settings")
def get_settings(c: str) -> dict[str, Any]:
    return with_features(stored_settings(c), c)


# The keys PUT /settings may change: the settings the browser's settings panel and switches save, and the rows of the
# permission modes, which only the analyst's browser may change (hook_auth.analyst). The models and the permission modes
# are written to thimble's config (userconf.save), the rest to the workspace's settings.json. Every other key is the
# server's own or the analyst's to edit in the file (kernel_wrap, orient_instructions), since a kernel cell or a
# session's command can reach the route on loopback. RETIRED_KEYS are taken too, and dropped.
PUT_KEYS = frozenset({*SETTINGS_DEFAULTS, config.MODELS_KEY, "permission_modes", *RETIRED_KEYS})


@router.put("/ws/{c}/settings")
def put_settings_route(c: str, request: Request, settings: dict[str, Any] = Body(...)) -> dict[str, Any]:
    """put_settings for the browser, which may change PUT_KEYS only (RETIRED_KEYS among them are dropped); 400 names any
    other key, or why a permission mode cannot be chosen, and 403 refuses a change of permission modes from anything but
    the analyst's browser."""
    from . import hook_auth, modes  # noqa: PLC0415 — modes imports this module

    refused = sorted(set(settings) - PUT_KEYS)
    if refused:
        raise HTTPException(400, f"these settings cannot be changed here: {', '.join(refused)}")
    from . import userconf  # noqa: PLC0415

    if modes.SETTING in settings:
        if not hook_auth.analyst(request):
            raise HTTPException(403, hook_auth.ANALYST_ONLY)
        if why := modes.patch_error(settings[modes.SETTING]):
            raise HTTPException(400, why)
    try:
        return put_settings(c, {k: v for k, v in settings.items() if k not in RETIRED_KEYS})
    except userconf.ConfigError as e:
        raise HTTPException(400, str(e)) from e


def put_settings(c: str, settings: dict[str, Any]) -> dict[str, Any]:
    """Merges into the stored settings, so a partial PUT keeps the rest. The models of the agents and the permission
    modes go to thimble's config (userconf.save), which raises userconf.ConfigError for a value it does not take;
    main's model settings and everything else to settings.json, where only what was stored plus the patch is written,
    never SETTINGS_DEFAULTS, so a changed default takes effect, and RETIRED_KEYS are left out. Returns the effective
    settings."""
    from . import modes, userconf  # noqa: PLC0415 — they import this module

    models = settings.get(config.MODELS_KEY) if isinstance(settings.get(config.MODELS_KEY), dict) else {}
    patch = userconf.pane_patch(models, settings.get(modes.SETTING) if isinstance(settings.get(modes.SETTING), dict)
                                else None)
    if patch:
        userconf.save(c, patch)
    settings = {k: v for k, v in settings.items() if k != modes.SETTING}
    if config.MODELS_KEY in settings:
        settings[config.MODELS_KEY] = {k: v for k, v in models.items() if k == "main"}
        if not settings[config.MODELS_KEY]:
            settings.pop(config.MODELS_KEY)
    path = ws_dir(c) / "settings.json"
    stored = read_json(path, {})
    stored = stored if isinstance(stored, dict) else {}
    merged = {k: v for k, v in {**stored, **settings}.items() if k not in RETIRED_KEYS}
    # main's model settings merge within main, so a PUT of its effort keeps its fast mode
    if isinstance(settings.get(config.MODELS_KEY), dict):
        held = stored.get(config.MODELS_KEY) if isinstance(stored.get(config.MODELS_KEY), dict) else {}
        merged[config.MODELS_KEY] = {**held, **{
            role: {**held[role], **conf} if isinstance(conf, dict) and isinstance(held.get(role), dict) else conf
            for role, conf in settings[config.MODELS_KEY].items()}}
    if merged != stored or not path.exists() and settings:
        write_json(path, merged)
    return with_features(merged, c)


# --------------------------------------------------------------------------- reset and archive

# workspaces/.archive/<c>-<local time>/: a workspace `/thimble fresh` moved aside. A leading-dot name is never a
# workspace's, so nothing under it is read as one.
ARCHIVE_DIR = ".archive"
ARCHIVE_TIME = "%Y-%m-%d-%H%M%S"


async def _end_work(c: str) -> None:
    """End what the server runs for the workspace: its jobs, its view builds, a pending write, a label apply, the
    kernels, the agent chats the server runs. Nothing writes into its directory afterwards."""
    from . import agents as chat, concepts, dev, jobs, notebook, report_types  # lazy: keeps ledger importable on its own and avoids an import cycle

    jobs.cancel_workspace(c)  # a verification: none writes into the removed directory
    await dev.stop_views(c)  # the dev agent's view builds, awaited: their proposals stay queued or building
    report_types.cancel_workspace(c)  # a write the session was asked for: its pending state is forgotten
    await concepts.cancel_workspace(c)  # a concept apply in progress: cancelled and awaited
    await notebook.shutdown_workspace(c)  # the shared kernel, every dedicated one, and any a previous server recorded
    notebook._kernels.pop(c, None)
    for (cc, chat_id), task in list(chat._agent_tasks.items()):  # a background agent chat the server runs
        if cc == c:
            task.cancel()


async def _stop_sessions(c: str, why: str) -> None:
    """Stop the Claude Code sessions the server runs for the workspace (an orientation's, a writer's: they never
    subscribe to the channel) and detach the analyst's session from it, before its folder goes."""
    from . import agent_session, session  # lazy: session imports this module

    for run in [r for (cc, _), r in list(agent_session._runs.items()) if cc == c]:
        await agent_session.stop_run(run)
    lv = session.current(c)
    if lv is not None:
        session.detach(c, lv.sid, why)


@router.delete("/ws/{c}")
async def reset_workspace(c: str, idle: bool = False) -> dict[str, bool]:
    """`thimble purge`: stop the workspace's sessions, end what else runs, then delete workspaces/<c>/ entirely; the
    corpus is untouched. idle=true: 409 while a session holds the workspace open."""
    path = ws_dir(c).resolve()  # validates the corpus name (404 otherwise) and that the corpus exists
    if path.parent != config.WORKSPACES_DIR.resolve() or path == config.WORKSPACES_DIR.resolve():
        raise HTTPException(400, f"refusing to delete {path}")
    if idle:
        from . import channel  # noqa: PLC0415 — lazy, as in _end_work

        n = len(channel.subscribed_sessions(c))
        if n:
            raise HTTPException(409, f"{c} has {n} open session{'s' if n > 1 else ''}: quit "
                                     f"{'them' if n > 1 else 'it'} first")
    await _stop_sessions(c, "deleted")
    await _end_work(c)
    shutil.rmtree(path, ignore_errors=True)
    return {"ok": True}


def archive_path(c: str, when: datetime | None = None) -> Path:
    """Where archive_workspace moves workspaces/<c>/: workspaces/.archive/<c>-<local time>, with -2, -3 … when two
    archives of the same second meet."""
    base = config.WORKSPACES_DIR.resolve() / ARCHIVE_DIR / f"{c}-{(when or datetime.now()).strftime(ARCHIVE_TIME)}"
    p, n = base, 1
    while p.exists():
        n += 1
        p = base.with_name(f"{base.name}-{n}")
    return p


@router.post("/ws/{c}/archive")
async def archive_workspace(c: str) -> dict[str, str | None]:
    """`/thimble fresh`: stop the workspace's sessions, detach the analyst's session, end what else runs, then move
    workspaces/<c>/ to archive_path; nothing is deleted. {archived: the folder it went to, or null}."""
    from . import investigation  # lazy: investigation imports this module

    try:
        path = config.workspace_path(c).resolve()  # validated, never created
    except ValueError as e:
        raise HTTPException(404, str(e)) from e
    if path.parent != config.WORKSPACES_DIR.resolve():
        raise HTTPException(400, f"refusing to move {path}")
    if not path.is_dir():
        return {"archived": None}
    await _stop_sessions(c, "archived")
    await _end_work(c)
    dest = archive_path(c)
    dest.parent.mkdir(parents=True, exist_ok=True)
    path.rename(dest)
    investigation.reset_streams(c)  # an open tab starts over on the empty workspace
    log.info("%s: workspace archived to %s", c, dest)
    return {"archived": str(dest)}


def archives(c: str) -> list[Path]:
    """The workspace's archives (archive_path's names for `c`), newest first."""
    pattern = re.compile(rf"^{re.escape(c)}-(\d{{4}}-\d{{2}}-\d{{2}}-\d{{6}})(?:-(\d+))?$")
    found: list[tuple[str, int, Path]] = []
    try:
        entries = list((config.WORKSPACES_DIR.resolve() / ARCHIVE_DIR).iterdir())
    except OSError:
        return []
    for p in entries:
        m = pattern.match(p.name)
        if m and p.is_dir():
            found.append((m.group(1), int(m.group(2) or 1), p))
    return [p for _, _, p in sorted(found, key=lambda t: (t[0], t[1]), reverse=True)]


@router.get("/ws/{c}/archives")
async def archives_route(c: str) -> dict[str, list[str]]:
    """`/thimble restore` with no name (cli): the names of the workspace's archives, newest first."""
    try:
        config.workspace_path(c)
    except ValueError as e:
        raise HTTPException(404, str(e)) from e
    return {"archives": [p.name for p in archives(c)]}


@router.post("/ws/{c}/restore")
async def restore_workspace(c: str, body: dict[str, Any] = Body(...)) -> dict[str, str | None]:
    """`/thimble restore <archive>`: archive the current workspace as `/thimble fresh` does, then move the named archive
    back as workspaces/<c>/. {restored, archived}. 404 when there is no archive of that name."""
    name = str(body.get("archive") or "").strip()
    src = next((p for p in archives(c) if p.name == name), None)
    if src is None:
        raise HTTPException(404, f"{c} has no archive named {name!r}")
    replaced = (await archive_workspace(c))["archived"]
    path = config.workspace_path(c).resolve()
    src.rename(path)
    from . import investigation  # noqa: PLC0415 — lazy: investigation imports this module

    investigation.reset_streams(c)  # an open tab starts over on the restored workspace
    log.info("%s: archive %s restored", c, name)
    return {"restored": str(src), "archived": replaced}
