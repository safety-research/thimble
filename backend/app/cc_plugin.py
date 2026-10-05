"""thimble's plugin in the analyst's Claude Code session: where a plugin copy loads from, the `claude` process a command
runs under, and whether the plugin's hooks run there, which decides the route browser events take.

Browser events reach a session through the plugin's hooks (plugin/hooks/hooks.json, plugin/bin/.thimble-watch): the
HOOK route. Where the hooks are off, by `disableAllHooks` in the analyst's, the project's or the folder's local settings,
or in the `--settings` the session's `claude` was started with (the launcher passes the analyst's own there), or by the
org's managed tier (`disableAllHooks`, or `allowManagedHooksOnly` without this plugin enabled there), main
arms a Monitor on the watcher instead: the MONITOR route (`route`). The managed tier is the org's server-managed
settings (remote-settings.json in Claude Code's config dir) when they exist, else managed-settings.json with its
managed-settings.d drop-ins in the platform's managed folder (`managed`).

A plugin copy names its marketplace (`marketplace`): `inline` for a `--plugin-dir` copy, `<marketplace>` for an
installed one, which is a copy in Claude Code's plugin cache or, for a directory marketplace, the plugin folder in that
marketplace's own folder, which Claude Code loads in place (read from its registry).
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any, Mapping

from . import procs

PLUGIN = "thimble"
INLINE = "inline"  # the marketplace Claude Code gives a plugin loaded with --plugin-dir
MARKETPLACE_FILE = Path(".claude-plugin") / "marketplace.json"  # in a marketplace's folder: its name and its plugins
# Claude Code's registry, in its config dir: the marketplaces it knows with their sources, and the plugins installed
KNOWN_MARKETPLACES = Path("plugins") / "known_marketplaces.json"
INSTALLED_PLUGINS = Path("plugins") / "installed_plugins.json"
DIRECTORY_SOURCE = "directory"  # the source type of a marketplace that is a local folder
SESSIONS = "sessions"  # in Claude Code's config dir: <pid>.json for each running `claude` process
MAX_HOPS = 32  # claude_pid's walk up the process tree
REMOTE_SETTINGS = "remote-settings.json"  # the org's server-managed settings, in Claude Code's config dir
MANAGED_DIRS = {"darwin": Path("/Library/Application Support/ClaudeCode"), "linux": Path("/etc/claude-code")}
MANAGED_FILE = "managed-settings.json"
MANAGED_DROPINS = "managed-settings.d"
USER_SETTINGS = "settings.json"
PROJECT_SETTINGS = (Path(".claude") / "settings.json", Path(".claude") / "settings.local.json")
HOOK, MONITOR = "hook", "monitor"  # the routes (module note)
ROUTES = (HOOK, MONITOR)


def config_dir(environ: Mapping[str, str] | None = None) -> Path:
    env = os.environ if environ is None else environ
    return Path(env.get("CLAUDE_CONFIG_DIR") or (Path.home() / ".claude"))


def _read(path: Path) -> dict[str, Any] | None:
    """A settings file's object: None when it is missing or unreadable, {} when it holds something else."""
    try:
        d = json.loads(path.read_text("utf-8"))
    except (OSError, ValueError):
        return None
    return d if isinstance(d, dict) else {}


def marketplace(root: Path, environ: Mapping[str, str] | None = None) -> str:
    """The marketplace Claude Code loads the plugin copy at `root` from: <marketplace> for a copy in its plugin cache;
    for a copy in the folder of a directory marketplace, that marketplace's name when Claude Code's registry (in the
    config dir `environ` names) has it registered from that folder and the plugin installed from it; `inline` for any
    other folder (a --plugin-dir) or when those files cannot be read."""
    parts = Path(root).parts
    if len(parts) >= 5 and parts[-5:-3] == ("plugins", "cache") and parts[-2] == PLUGIN:
        return parts[-3]
    try:
        folder = Path(root).parent.resolve()
        name = (_read(folder / MARKETPLACE_FILE) or {}).get("name")
        if not (isinstance(name, str) and name):
            return INLINE
        known = (_read(config_dir(environ) / KNOWN_MARKETPLACES) or {}).get(name)
        source = known.get("source") if isinstance(known, dict) else None
        if not (isinstance(source, dict) and source.get("source") == DIRECTORY_SOURCE):
            return INLINE
        path = source.get("path")
        installed = (_read(config_dir(environ) / INSTALLED_PLUGINS) or {}).get("plugins")
        if (isinstance(path, str) and Path(path).is_absolute() and Path(path).resolve() == folder
                and isinstance(installed, dict) and f"{PLUGIN}@{name}" in installed):
            return name
    except (OSError, ValueError, RuntimeError):
        pass
    return INLINE


def claude_pid(environ: Mapping[str, str] | None = None) -> int | None:
    """The `claude` process a command Claude Code started runs under: CLAUDE_PID, else the nearest ancestor that has a
    session record in Claude Code's config dir; None when no ancestor is one."""
    env = os.environ if environ is None else environ
    named = env.get("CLAUDE_PID") or ""
    sessions = config_dir(env) / SESSIONS
    pid: int | None = os.getppid()
    for _ in range(MAX_HOPS):
        if pid is None or pid <= 1:
            return None
        if str(pid) == named or (sessions / f"{pid}.json").is_file():
            return pid
        pid = procs.ppid(pid)
    return None


def managed(environ: Mapping[str, str] | None = None) -> dict[str, Any] | None:
    """The org's managed tier (module note): the first source that exists, None when none does. The drop-ins merge over
    managed-settings.json key by key, and within an object such as `permissions` key by key too."""
    remote = config_dir(environ) / REMOTE_SETTINGS
    if remote.is_file():
        return _read(remote) or {}
    base = MANAGED_DIRS.get(sys.platform)
    if base is None:
        return None
    tier = _read(base / MANAGED_FILE) if (base / MANAGED_FILE).is_file() else None
    try:
        dropins = sorted((base / MANAGED_DROPINS).glob("*.json"))
    except OSError:
        dropins = []
    for p in dropins:
        tier = tier or {}
        for k, v in (_read(p) or {}).items():
            tier[k] = {**tier[k], **v} if isinstance(v, dict) and isinstance(tier.get(k), dict) else v
    return tier


def flag_settings(environ: Mapping[str, str] | None = None) -> dict[str, Any] | None:
    """The settings the `claude` process a command runs under (claude_pid) was started with by its last `--settings`,
    inline JSON or a file relative to that process's folder; None without one, or when it cannot be read. Without /proc
    the command line comes split on white space (procs.argv), so inline JSON is read from the words joined again."""
    pid = claude_pid(environ)
    args = procs.argv(pid) if pid else []
    at, value = -1, ""
    for i, a in enumerate(args):
        if a == "--settings" and i + 1 < len(args):
            at, value = i + 1, args[i + 1]
        elif a.startswith("--settings="):
            at, value = i, a[len("--settings="):]
    if at < 0:
        return None
    try:
        if value.lstrip().startswith("{"):
            try:
                d = json.loads(value)
            except ValueError:
                d = json.JSONDecoder().raw_decode(" ".join([value, *args[at + 1:]]).lstrip())[0]
        else:
            d = _read((procs.cwd(pid) or Path.cwd()) / Path(value).expanduser())
    except (ValueError, OSError):
        return None
    return d if isinstance(d, dict) else None


def hooks_blocked(cwd: Path, root: Path, environ: Mapping[str, str] | None = None) -> bool:
    """Whether the plugin's hooks are off for a session in `cwd` (module note): by the managed tier, or by
    `disableAllHooks` as the analyst's, the project's and the folder's local settings and the session's `--settings`
    (flag_settings) resolve it, the later winning, as Claude Code ranks them."""
    tier = managed(environ) or {}
    if tier.get("disableAllHooks") is True:
        return True
    if tier.get("allowManagedHooksOnly") is True:
        enabled = tier.get("enabledPlugins")
        if not (isinstance(enabled, dict) and enabled.get(f"{PLUGIN}@{marketplace(root, environ)}") is True):
            return True
    value = None
    for path in (config_dir(environ) / USER_SETTINGS, *(Path(cwd) / p for p in PROJECT_SETTINGS)):
        v = (_read(path) or {}).get("disableAllHooks")
        if isinstance(v, bool):
            value = v
    v = (flag_settings(environ) or {}).get("disableAllHooks")
    if isinstance(v, bool):
        value = v
    return value is True


def route(cwd: Path | str, root: Path, environ: Mapping[str, str] | None = None) -> str:
    """The route browser events take to a session in `cwd` with the plugin copy at `root` (module note): HOOK, or
    MONITOR where the plugin's hooks are off."""
    return MONITOR if hooks_blocked(Path(cwd), root, environ) else HOOK
