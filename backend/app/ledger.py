"""The plain-file helpers every store uses (atomic JSON writes, JSONL appends, per-log sequence numbers), the workspace
settings routes, the workspace reset, its archive (`/thimble fresh`) and an archive's restore (`/thimble resume`).

`BOOT_ID` names this server process: a log that stamps it shows a restart as a change of boot id, and `last_seq` /
`heal_tail` let a per-log sequence counter resume after one.
"""
from __future__ import annotations

import contextlib
import json
import logging
import os
import re
import secrets
import shutil
import tempfile
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Iterator

from fastapi import APIRouter, Body, HTTPException, Request

from . import config

log = logging.getLogger("thimble.ledger")
router = APIRouter()

# GET /settings layers these under what the file stores (tools.RESULT_LINES_KEY: lines of each output a card's result
# shows).
SETTINGS_DEFAULTS: dict[str, Any] = {"run_cell_result_lines": 40}
# Settings earlier builds stored that nothing reads any more: GET leaves them out, a PUT that sends one (a tab still
# running an earlier build) is taken with the key dropped, and the next PUT removes it from the file. orient_route and
# terminal_first picked how the orientation ran, hide_chat hid the browser's chat column.
RETIRED_KEYS = frozenset({"orient_route", "terminal_first", "hide_chat"})


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


def write_under(base: Path, path: Path, text: str) -> None:
    """`text` written to `path` under `base` by the server: its folders made, none of them a symlink (unlinked), and a
    symlink at `path` itself replaced rather than followed (atomic_write_text). For a file thimble writes into a folder
    that its agents' Bash or a kernel can write (a check's task file, a writer's context file, the critic's brief and
    digest), where a planted link would have the server, which no sandbox holds, write outside it. OSError for a link."""
    try:
        unlinked(base, path)
        path.parent.mkdir(parents=True, exist_ok=True)
        atomic_write_text(unlinked(base, path), text)
    except ValueError as e:
        raise OSError(str(e)) from None


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


# --------------------------------------------------------------------------- locks between processes
#
# A store that more than one process writes (in terminal mode the MCP shim, `thimble-run` in main's Bash, the hooks'
# backend calls and `thimble act`; in browser mode the server and the hooks) is changed under locked(): an flock on a
# lock file beside the store, then a read of the store as it is now, then an atomic replace or an append. The lock is
# re-entrant in one thread, so a store function that calls another under the same lock does not wait on itself. Never
# await while holding it: the coroutines of one event loop share its thread. A holder that keeps the lock past `wait_s`
# (a stuck process, or a cell that took the lock file) does not block the caller for ever: the caller waits `wait_s`,
# logs, and goes on without the lock, as subagents.json's lock does.

LOCK_SUFFIX = ".lock"  # a file store's lock file is <file>.lock beside it
DIR_LOCK = ".lock"  # a folder store's lock file is <folder>/.lock inside it
LOCK_WAIT_S = 2.0
_LOCK_POLL_S = (0.002, 0.005, 0.01, 0.02, 0.05)  # the waits between flock tries, the last repeated until wait_s
_held = threading.local()  # .depth: {lock file: how many times this thread holds it}
_guards: dict[str, threading.Lock] = {}  # one per lock file: this process's threads wait here, not on the flock
_guards_lock = threading.Lock()


def lock_file(path: Path) -> Path:
    """The lock file of the store at `path`: `<path>.lock` beside a file, `<path>/.lock` inside a folder."""
    path = Path(path)
    return path / DIR_LOCK if path.is_dir() else path.with_name(path.name + LOCK_SUFFIX)


def _guard(key: str) -> threading.Lock:
    with _guards_lock:
        g = _guards.get(key)
        if g is None:
            g = _guards[key] = threading.Lock()
        return g


def _open_lock(lf: Path) -> int | None:
    """An fd on the lock file `lf`, made when missing; read-only where this process may not write its folder (a lock
    file the launcher made beside a store main's sandbox reads); None when it cannot be opened."""
    cloexec = getattr(os, "O_CLOEXEC", 0)
    for flags in (os.O_RDWR | os.O_CREAT, os.O_RDONLY):
        try:
            return os.open(lf, flags | cloexec, 0o600)
        except FileNotFoundError:
            try:
                lf.parent.mkdir(parents=True, exist_ok=True)
                return os.open(lf, flags | cloexec, 0o600)
            except OSError:
                continue
        except OSError:
            continue
    return None


def _flock(lf: Path, deadline: float) -> int | None:
    """An fd holding an exclusive flock on `lf`, or None when it cannot be opened or stays taken until `deadline`."""
    import fcntl  # noqa: PLC0415 — POSIX only, and only where a lock is taken

    fd = _open_lock(lf)
    if fd is None:
        return None
    step = 0
    while True:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return fd
        except BlockingIOError:
            pass
        except OSError:
            os.close(fd)
            return None
        left = deadline - time.monotonic()
        if left <= 0:
            os.close(fd)
            return None
        time.sleep(min(left, _LOCK_POLL_S[min(step, len(_LOCK_POLL_S) - 1)]))
        step += 1


@contextlib.contextmanager
def locked(path: Path, wait_s: float = LOCK_WAIT_S) -> Iterator[bool]:
    """Hold the store at `path` for one change (module note above). Yields True while the lock is held, False when it
    could not be had within `wait_s`, in which case the change goes on and a warning is logged. Re-entrant in one
    thread."""
    lf = lock_file(Path(path))
    key = str(lf)
    depth: dict[str, int] | None = getattr(_held, "depth", None)
    if depth is None:
        depth = _held.depth = {}
    if depth.get(key):
        depth[key] += 1
        try:
            yield True
        finally:
            depth[key] -= 1
        return
    deadline = time.monotonic() + max(0.0, wait_s)
    guard = _guard(key)
    got_guard = guard.acquire(timeout=max(0.0, wait_s))
    fd = _flock(lf, deadline) if got_guard else None
    if fd is None:
        log.warning("%s: not locked within %.1f s, so the change goes on without the lock", lf, wait_s)
    depth[key] = 1
    try:
        yield fd is not None
    finally:
        depth.pop(key, None)
        if fd is not None:
            os.close(fd)  # closing the fd lets the flock go
        if got_guard:
            guard.release()


def update_json(path: Path, change: Any, default: Any = None, *, indent: int = 2) -> Any:
    """Read the JSON file at `path` under its lock (locked), pass it to `change` (`default` when the file is missing or
    unreadable), and write what `change` returns atomically; when `change` returns None nothing is written. Returns what
    the file holds afterwards."""
    with locked(path):
        try:
            data = json.loads(path.read_text("utf-8")) if path.is_file() else default
        except (OSError, ValueError):
            data = default
        new = change(data)
        if new is None:
            return data
        atomic_write_text(path, json.dumps(new, indent=indent, ensure_ascii=False))
        return new


def append_jsonl_locked(path: Path, obj: Any) -> None:
    """append_jsonl under the file's lock, after mending a torn last line (heal_tail), for a log that more than one
    process appends to."""
    with locked(path):
        heal_tail(path)
        append_jsonl(path, obj)


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
    `config_error`, the config's error or ''; `config_ignored`, the keys its files hold that this build reads and ignores
    (userconf.ignored); `agents`, agent_rows; `tasks`, task_rows; `card_wait`, the minutes a code ticket's question on its
    card waits (userconf.card_wait_s)."""
    from . import extensions, modes, userconf  # noqa: PLC0415 — they import this module

    kept = {k: v for k, v in stored.items() if k not in RETIRED_KEYS and k != modes.SETTING}
    models = {**config.models_for(c), **extensions.agent_models(c)}
    return {**SETTINGS_DEFAULTS, **kept, config.MODELS_KEY: models, modes.SETTING: modes.rows(c) if c else {},
            "disabled_modes": sorted(modes.disabled()), "config_error": userconf.problem(c),
            "config_ignored": userconf.ignored(c), "agents": agent_rows(c), "tasks": task_rows(c),
            "card_wait": round(userconf.card_wait_s() / 60, 2)}


def agent_rows(c: str | None) -> dict[str, Any]:
    """Who runs each agent thimble starts and what it may do. Two fences: `main`'s, which thimble's agents share as main's
    subagents (its sandbox, whether the sandbox can run here, its network, web tools and edits of the corpus, the
    orientation's keys in thimble's config, userconf's one fence), with the extensions that add to main's prompt; and
    `dev`'s, which `thimble fix` and an extension's program that runs the dev agent keep. Each other agent's row
    (orient, writer, critic, checks) names its role's agent (roles.public: thimble's own, or an extension's prompt, Agent SDK program or command,
    with the extensions that add to its prompt and a conflict) and its own `web`, "off" or main's. `labels` and
    `cardCheck` (userconf.CALLS) follow, by their config names: who runs their tasks (`tasks`, the first one an
    extension runs) and the settings a program of those tasks runs under, with the sandbox always on and no web."""
    from . import roles, tasks, userconf  # noqa: PLC0415

    conf = userconf.load_or_defaults(c)[0]
    runs = conf["sandbox"]["use"] != "never" and userconf.sandbox_runs()
    by_role = {r["role"]: r for r in roles.public(c)}
    blank = {"way": "thimble", "extension": "", "additions": [], "conflict": []}

    def fence(agent: str) -> dict[str, Any]:
        mine = userconf.agent_conf(conf, agent)
        on = conf["sandbox"]["use"] != "never" and (agent == "orientation" or mine.get("sandbox", "on") == "on")
        return {"sandbox": "on" if on else "off", "sandbox_runs": runs, "network": mine.get("network") or "on",
                "web": mine.get("web") or "ask", "data": mine.get("data") or "ask", "config": f"agents.{agent}"}

    out: dict[str, Any] = {"main": {"additions": by_role["main"]["additions"], **fence("orientation")}}
    for agent in userconf.SUBAGENT_ROLES:
        role = by_role.get(agent) or blank
        out[userconf.ROLES[agent]] = {"way": role["way"], "extension": role["extension"],
                                      "additions": role["additions"], "conflict": role["conflict"],
                                      "web": userconf.agent_conf(conf, agent)["web"], "config": f"agents.{agent}",
                                      "memory": userconf.agent_conf(conf, agent).get("memory") or "inherit"}
    for agent, row in userconf.MODE_ROWS.items():
        role = by_role.get(agent) or blank
        out[row] = {"way": role["way"], "extension": role["extension"], "additions": role["additions"],
                    "conflict": role["conflict"], **fence(agent)}
    by_task = task_rows(c)
    for agent in userconf.CALLS:
        mine = conf["agents"][agent]
        own = [t for t in by_task if t["task"] in tasks.TASKS and tasks.TASKS[t["task"]].agent == agent]
        lead = next((t for t in own if t["way"] != "thimble" or t["conflict"]), None)
        added = list(dict.fromkeys(e for t in own for e in t["additions"]))
        out[agent] = {"way": lead["way"] if lead else "thimble", "extension": lead["extension"] if lead else "",
                      "additions": added, "conflict": lead["conflict"] if lead else [], "sandbox": "on",
                      "sandbox_runs": runs, "network": mine.get("network", "on"), "web": "off",
                      "data": mine.get("data", "ask"), "config": f"agents.{agent}", "tasks": [t["task"] for t in own]}
    return out


def task_rows(c: str | None) -> list[dict[str, Any]]:
    """Who runs each of thimble's seven tasks (tasks.public): thimble's own, or an extension's prompt, Agent SDK program
    or command, with the extensions that add to its prompt and those that all replace it."""
    from . import tasks  # noqa: PLC0415

    try:
        return tasks.public(c)
    except Exception:  # noqa: BLE001 — Settings still shows when an extension's task cannot be read
        log.exception("%s: the tasks' rows could not be read", c)
        return []


@router.get("/ws/{c}/settings")
def get_settings(c: str) -> dict[str, Any]:
    return with_features(stored_settings(c), c)


# The keys PUT /settings may change: SETTINGS_DEFAULTS, the models the browser's settings panel saves, the rows of
# the permission modes and the subagents' web switches (WEB_KEY), which only the analyst's browser may change
# (hook_auth.analyst). The models and the permission
# modes are written to thimble's config (userconf.save), the rest to the workspace's settings.json. Every other key is
# the server's own or the analyst's to edit in the file (kernel_wrap, orient_instructions), since a kernel cell or a
# session's command can reach the route on loopback. RETIRED_KEYS are taken too, and dropped.
WEB_KEY = "web"  # {row: "off" | None}: a subagent of main kept off WebFetch and WebSearch, or back on main's rule
WEB_ROWS = {"critic": "critic", "writer": "writer", "checks": "checks"}  # the web switches' rows, by thimble's config's agent
PUT_KEYS = frozenset({*SETTINGS_DEFAULTS, config.MODELS_KEY, "permission_modes", WEB_KEY, *RETIRED_KEYS})


def web_patch(rows: Any) -> dict[str, Any]:
    """The Settings pane's web switches as a patch of thimble's config: each row's agent `web` "off", or None for back to
    main's rule. ValueError for a row or a value it does not take; the orientation's web is main's fence's, so it is
    not among the rows."""
    if not isinstance(rows, dict):
        raise ValueError("web: a map of rows to \"off\" or null")
    agents: dict[str, Any] = {}
    for row, value in rows.items():
        if row not in WEB_ROWS:
            raise ValueError(f"web: no row {row!r}; one of {', '.join(WEB_ROWS)}")
        if value not in ("off", None):
            raise ValueError(f"web: {row} takes \"off\" or null")
        agents[WEB_ROWS[row]] = {"web": value}
    return {"agents": agents} if agents else {}


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
    if WEB_KEY in settings:
        if not hook_auth.analyst(request):
            raise HTTPException(403, hook_auth.ANALYST_ONLY)
        try:
            web_patch(settings[WEB_KEY])
        except ValueError as e:
            raise HTTPException(400, str(e)) from e
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
    for name, conf in web_patch(settings.get(WEB_KEY) or {}).get("agents", {}).items():
        patch.setdefault("agents", {}).setdefault(name, {}).update(conf)
    if patch:
        userconf.save(c, patch)
        push_roles(c)
    settings = {k: v for k, v in settings.items() if k not in (modes.SETTING, WEB_KEY)}
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


def push_roles(c: str) -> None:
    """Have main's hooks module register thimble's agent types again with the values Settings now name
    (module_bridge.push_roles), so the next start of each runs on them. Never raises: a module that is not running
    registers them at its next session's start."""
    try:
        from . import module_bridge  # noqa: PLC0415 — module_bridge imports the session modules

        module_bridge.push_roles(c)
    except Exception:  # noqa: BLE001 — the save stands; the module registers the roles when it next starts
        log.warning("%s: the agent types were not registered again after a Settings save", c, exc_info=True)


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
    """Stop thimble's agents in the workspace (through the module, subagents.stop) and detach the analyst's session from
    it, before its folder goes."""
    from . import session, subagents  # lazy: session imports this module

    for agent_id, a in subagents.agents_of(c).items():
        if a.get("status") in ("running", "waiting"):
            try:
                await subagents.stop(c, agent_id)
            except Exception:  # noqa: BLE001 — the folder goes either way
                log.warning("%s: the agent %s was not stopped", c, agent_id, exc_info=True)
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
        from . import events  # noqa: PLC0415 — lazy, as in _end_work

        n = len(events.subscribed_sessions(c))
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
    from . import investigation, views  # noqa: PLC0415 — lazy: investigation imports this module

    try:
        views.move_to_local(path)  # an archive an older thimble made keeps its views in views/
    except OSError:
        log.exception("%s: the restored views were not moved into the local extension", c)

    investigation.reset_streams(c)  # an open tab starts over on the restored workspace
    log.info("%s: archive %s restored", c, name)
    return {"restored": str(src), "archived": replaced}


# --------------------------------------------------------------------------- rename

# the files whose absolute paths of the workspace folder a rename points at the new folder: text thimble writes
REPOINTED_SUFFIXES = (".json", ".jsonl", ".md", ".txt", ".py", ".html", ".js", ".mjs", ".css", ".svg", ".csv")


def repoint(root: Path, old: str, new: str) -> int:
    """In the text files under `root` (REPOINTED_SUFFIXES; no link followed or rewritten), the absolute path `old`, where
    no character of a name follows it, replaced by `new`, as written plain and as JSON escapes it; each file written
    whole (atomic_write_bytes) with its mode kept. How many files changed; a file that cannot be read or written is
    logged and left as it was."""
    forms = {old: new, json.dumps(old)[1:-1]: json.dumps(new)[1:-1]}
    pats = [(re.compile(re.escape(a) + r"(?![A-Za-z0-9._-])"), b) for a, b in forms.items()]
    needles = {a.encode("utf-8") for a in forms}
    changed = 0
    for dirpath, _dirs, files in os.walk(root):  # os.walk follows no link to a folder
        for f in files:
            p = Path(dirpath) / f
            if p.suffix not in REPOINTED_SUFFIXES or p.is_symlink():
                continue
            try:
                data = p.read_bytes()
                if not any(n in data for n in needles):
                    continue
                text = data.decode("utf-8")
            except (OSError, UnicodeDecodeError):
                continue
            out = text
            for pat, to in pats:
                out = pat.sub(lambda _m, to=to: to, out)
            if out == text:
                continue
            try:
                mode = p.stat().st_mode & 0o777
                atomic_write_bytes(p, out.encode("utf-8"))
                os.chmod(p, mode)
                changed += 1
            except OSError as e:
                log.warning("%s: the paths of the renamed workspace were not rewritten: %s", p, e)
    return changed


def move_workspace(c: str, to: str, workspaces: Path | None = None) -> Path | None:
    """The disk part of a rename (rename_workspace, and `thimble demo` with no server running): workspaces/<c>/ moved to
    workspaces/<to>/ (`workspaces`: config.WORKSPACES_DIR), the registration of `c` made `to`'s (config.rename_corpus),
    the archives of `c` moved to `to`'s names where none of `to` holds that name, and the absolute path of the old folder
    in its text files pointed at the new one (repoint). The caller makes sure nothing runs for `c`. The new folder, None
    when `c` had none yet. ValueError, with nothing changed, when `c` is no registered folder's corpus or `to` is invalid
    or taken (a corpus or a workspace folder of that name); an OSError of the move puts the folder back."""
    root = (workspaces or config.WORKSPACES_DIR).resolve()
    if config.NAME_RE.fullmatch(to) is None or to.startswith(".") or to == c:
        raise ValueError(f"invalid workspace name: {to!r}")
    if config.read_sidecar(c) is None:
        raise ValueError(f"{c!r} is not a registered folder's corpus")
    if config.name_taken(to) or (root / to).exists() or (root / to).is_symlink():
        raise ValueError(f"the name {to!r} is taken")
    src, dest = root / c, root / to
    has = src.is_dir() and not src.is_symlink()
    if has:
        if src.resolve().parent != root:
            raise ValueError(f"refusing to move {src}")
        src.rename(dest)
    try:
        config.rename_corpus(c, to)
    except BaseException:
        if has:
            dest.rename(src)
        raise
    pattern = re.compile(rf"^{re.escape(c)}(-\d{{4}}-\d{{2}}-\d{{2}}-\d{{6}}(?:-\d+)?)$")
    try:
        held = sorted((root / ARCHIVE_DIR).iterdir())
    except OSError:
        held = []
    for p in held:
        m = pattern.match(p.name)
        if m and p.is_dir() and not p.is_symlink() and not (p.parent / f"{to}{m.group(1)}").exists():
            try:
                p.rename(p.parent / f"{to}{m.group(1)}")
            except OSError as e:
                log.warning("%s: the archive %s was not renamed: %s", c, p.name, e)
    if has:
        repoint(dest, str(src), str(dest))
    log.info("%s: workspace renamed %s", c, to)
    return dest if has else None


@router.post("/ws/{c}/rename")
async def rename_workspace(c: str, body: dict[str, Any] = Body(...)) -> dict[str, str | None]:
    """`thimble demo` (demo.settle_name): the workspace `c` renamed `to`, with everything it holds (move_workspace). 409
    while a session holds it open (purge's idle delete refuses the same) or when `to` is taken; 404 for no corpus `c`;
    400 for an invalid name and for a corpus directory, which keeps its name. Before the move it stops thimble's agents
    and ends what else runs for it, as the archive does, and an open tab on the old name starts over.
    {name, workspace: the new folder or null}."""
    from . import events, investigation, local  # noqa: PLC0415 — lazy, as in _end_work

    to = str(body.get("to") or "").strip()
    try:
        config.corpus_dir(c)
    except ValueError as e:
        raise HTTPException(404, str(e)) from e
    if config.NAME_RE.fullmatch(to) is None or to.startswith(".") or to == c:
        raise HTTPException(400, f"invalid workspace name: {to!r}")
    if config.read_sidecar(c) is None or config._dir_corpus(c) is not None:
        raise HTTPException(400, f"{c} is a corpus directory of the data folder, which keeps its name")
    if config.name_taken(to) or (config.WORKSPACES_DIR / to).exists():
        raise HTTPException(409, f"the name {to} is taken")
    n = len(events.subscribed_sessions(c))
    if n or local.live_terminal(config.WORKSPACES_DIR / c):
        raise HTTPException(409, f"{c} is open in a Claude Code session" if not n else
                            f"{c} has {n} open session{'s' if n > 1 else ''}")
    await _stop_sessions(c, "renamed")
    await _end_work(c)
    try:
        dest = move_workspace(c, to)
    except ValueError as e:
        raise HTTPException(409, str(e)) from e
    investigation.reset_streams(c)
    return {"name": to, "workspace": str(dest) if dest else None}
