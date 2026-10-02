"""Whether the analyst's Claude Code session loaded thimble's channel, and if not, which route browser events take.

Claude Code registers the plugin's channel only in a session started with `--dangerously-load-development-channels
plugin:thimble@<marketplace>` (or `--channels`), and tells no child process, so `on` reads the `claude` process's
command line (claude_pid walks up to it). THIMBLE_CHANNEL, which the `thimble` launcher exports, is the explicit signal
and wins. An entry counts when it names this plugin copy: `plugin:thimble@inline` for a `--plugin-dir` copy,
`plugin:thimble@<marketplace>` for an installed one, which is a copy in Claude Code's plugin cache or, for a directory
marketplace, the plugin folder in that marketplace's own folder, which Claude Code loads in place (`marketplace` reads
its registry for that). A background session of Claude Code's (a job its daemon runs) has no channels (`background`).

Claude Code still refuses the channel after the flag for a third-party provider (Bedrock, Vertex, Foundry), for a
login that is not a claude.ai one as `claude auth status`, run in the session's folder with its environment, reports
it, and by the org's managed settings (`channelsEnabled`; `--channels` also needs `allowedChannelPlugins`). Without
channels, browser events go through the plugin's hooks, unless hooks are disabled too; then the model arms a Monitor.
`delivery` names the route and the reason.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any, Mapping, NamedTuple

from . import config, procs

ENV = "THIMBLE_CHANNEL"  # the explicit signal: the launcher exports it (plugin/bin/thimble)
# how Claude Code marks the environment of a background session it runs from its daemon, such as the copy of a session
# its agent view makes on ←; the daemon's environment, and so the copy's, can hold ENV from the session that started it
BG_KIND_ENV, BG_KIND = "CLAUDE_CODE_SESSION_KIND", "bg"
PLUGIN = "thimble"
SOURCE = "plugin:thimble:thimble"  # the `source` of the plugin server's channel events, as Claude Code shows them
INLINE = "inline"  # the marketplace Claude Code gives a plugin loaded with --plugin-dir
MARKETPLACE_FILE = Path(".claude-plugin") / "marketplace.json"  # in a marketplace's folder: its name and its plugins
# Claude Code's registry, in its config dir: the marketplaces it knows with their sources, and the plugins installed
KNOWN_MARKETPLACES = Path("plugins") / "known_marketplaces.json"
INSTALLED_PLUGINS = Path("plugins") / "installed_plugins.json"
DIRECTORY_SOURCE = "directory"  # the source type of a marketplace that is a local folder
SESSIONS = "sessions"  # in Claude Code's config dir: <pid>.json for each running `claude` process, with its `kind`
FLAGS = ("--dangerously-load-development-channels", "--channels")
DEV_FLAG = FLAGS[0]  # the development flag skips the org's channel allowlist; `--channels` does not
MAX_HOPS = 32  # claude_pid's walk up the process tree
PROVIDER_ENVS = ("CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY")
REMOTE_SETTINGS = "remote-settings.json"  # the org's server-managed settings, in Claude Code's config dir
MANAGED_DIRS = {"darwin": Path("/Library/Application Support/ClaudeCode"), "linux": Path("/etc/claude-code")}
MANAGED_FILE = "managed-settings.json"
MANAGED_DROPINS = "managed-settings.d"
TEAM_SUBSCRIPTIONS = ("team", "enterprise")  # `claude auth status`'s subscriptionType of a claude.ai Team or Enterprise seat
USER_SETTINGS = "settings.json"
PROJECT_SETTINGS = (Path(".claude") / "settings.json", Path(".claude") / "settings.local.json")
CLAUDE_AI_METHODS = ("claude.ai", "oauth_token")  # `claude auth status`'s authMethod of a login channels work with
# the routes (module note) and why channels are off
CHANNEL, HOOK, MONITOR = "channel", "hook", "monitor"
MODES = (CHANNEL, HOOK, MONITOR)
# no flag; the org's policy; Bedrock, Vertex or Foundry; a login that is not a claude.ai one (an API key, a helper)
SESSION, ORG, PROVIDER, ACCOUNT = "session", "org", "provider", "account"


class Delivery(NamedTuple):
    """How browser events reach a session: `mode` is CHANNEL, HOOK or MONITOR, and `reason` says why channels are off
    (SESSION, ORG, PROVIDER or ACCOUNT; empty on CHANNEL)."""

    mode: str
    reason: str = ""


def flagged(args: list[str]) -> list[tuple[str, str]]:
    """(flag, entry) for each channel entry a Claude Code command line names (module note)."""
    found: list[tuple[str, str]] = []
    i = 0
    while i < len(args):
        arg = args[i]
        i += 1
        if arg == "--":
            break
        flag, eq, value = arg.partition("=")
        if flag not in FLAGS:
            continue
        if eq:
            found.append((flag, value))
            continue
        if i < len(args):  # the first value is taken whatever it looks like, the rest up to the next option
            found.append((flag, args[i]))
            i += 1
        while i < len(args) and not args[i].startswith("-"):
            found.append((flag, args[i]))
            i += 1
    return found


def entries(args: list[str]) -> list[str]:
    """The channel entries a Claude Code command line names (module note)."""
    return [entry for _, entry in flagged(args)]


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


def channel(root: Path, environ: Mapping[str, str] | None = None) -> str:
    """The channel entry that loads the plugin copy at `root`: `plugin:thimble@<marketplace>`."""
    return f"plugin:{PLUGIN}@{marketplace(root, environ)}"


def claude_pid(environ: Mapping[str, str] | None = None) -> int | None:
    """The `claude` process a command Claude Code started runs under (module note); None when no ancestor is one."""
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


def flags(pid: int | None, root: Path, environ: Mapping[str, str] | None = None) -> set[str]:
    """The flags that name the channel of the plugin copy at `root` on the command line of the `claude` process `pid`
    (module note); THIMBLE_CHANNEL counts as the development flag, which the launcher passes, except in a background
    session of Claude Code's (BG_KIND_ENV), which inherits it without the flag: there the command line alone counts, so
    such a copy of main never claims main's place on the channel."""
    env = os.environ if environ is None else environ
    if env.get(ENV) and env.get(BG_KIND_ENV) != BG_KIND:
        return {DEV_FLAG}
    if pid is None:
        return set()
    entry = channel(root, env)
    return {flag for flag, e in flagged(procs.argv(pid)) if e == entry}


def on(pid: int | None, root: Path, environ: Mapping[str, str] | None = None) -> bool:
    """Whether the session of the `claude` process `pid` was started to hear the channel of the plugin copy at `root`:
    THIMBLE_CHANNEL is set, or that process's command line names the copy's channel entry (module note). Whether Claude
    Code then loads the channel is `delivery`'s question."""
    return bool(flags(pid, root, environ))


def background(pid: int | None, environ: Mapping[str, str] | None = None) -> bool:
    """Whether the `claude` process `pid` runs a background session of Claude Code's (a job its daemon runs): the
    environment says so (BG_KIND_ENV), or the state file Claude Code keeps for that process gives its `kind` as one."""
    env = os.environ if environ is None else environ
    if env.get(BG_KIND_ENV) == BG_KIND:
        return True
    return pid is not None and (_read(config_dir(env) / SESSIONS / f"{pid}.json") or {}).get("kind") == BG_KIND


# --------------------------------------------------------------------------- what Claude Code refuses after the flag


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


def login(environ: Mapping[str, str] | None = None, cwd: Path | str | None = None) -> dict[str, Any]:
    """What `claude auth status` reports for a session in `cwd` with the environment `environ` (config.auth_status); {}
    when it cannot tell."""
    env = os.environ if environ is None else environ
    return config.auth_status(config.passed_environ(env), cwd) or {}


def _truthy(value: str | None) -> bool:
    return str(value or "").strip().lower() not in ("", "0", "false", "no", "off")


def channels_blocked(root: Path, named: set[str], environ: Mapping[str, str] | None = None,
                     cwd: Path | str | None = None, status: dict[str, Any] | None = None) -> str:
    """Why Claude Code would not load the channel of the plugin copy at `root` in a session in `cwd` whose command line
    names it with the flags `named` (module note): PROVIDER, ACCOUNT, ORG, or "" when nothing stops it. `status` is what
    `claude auth status` reports for the session, asked now when it is None."""
    env = os.environ if environ is None else environ
    if any(_truthy(env.get(k)) for k in PROVIDER_ENVS):
        return PROVIDER
    status = login(env, cwd) if status is None else status
    if status.get("authMethod") not in CLAUDE_AI_METHODS or status.get("apiKeySource"):
        return ACCOUNT
    tier = managed(env)
    allowed = (tier or {}).get("channelsEnabled")
    if allowed is False:
        return ORG
    if allowed is not True:
        sub = status.get("subscriptionType") or env.get("CLAUDE_CODE_SUBSCRIPTION_TYPE")
        if sub in TEAM_SUBSCRIPTIONS:
            return ORG
    if named and DEV_FLAG not in named:
        listed = (tier or {}).get("allowedChannelPlugins")
        mkt = marketplace(root, env)
        if not any(isinstance(p, dict) and p.get("plugin") == PLUGIN and p.get("marketplace") == mkt
                   for p in (listed if isinstance(listed, list) else [])):
            return ORG
    return ""


def hooks_blocked(cwd: Path, root: Path, environ: Mapping[str, str] | None = None) -> bool:
    """Whether the plugin's hooks are off for a session in `cwd` (module note): by the managed tier, or by
    `disableAllHooks` as the analyst's, the project's and the folder's local settings resolve it, the later winning."""
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
    return value is True


def delivery(pid: int | None, root: Path, cwd: Path | str, environ: Mapping[str, str] | None = None,
             explain: bool = False, status: dict[str, Any] | None = None) -> Delivery:
    """How browser events reach the session of the `claude` process `pid` in `cwd` (module note): the channel when the
    flag names this copy's and nothing refuses it, else the hooks, else the Monitor, with why channels are off. For a
    session started without the flag the reason is SESSION, unless `explain` asks what else would refuse the channel.
    `status` as channels_blocked takes it."""
    named = flags(pid, root, environ)
    blocked = channels_blocked(root, named, environ, cwd, status) if named or explain else ""
    if named and not blocked:
        return Delivery(CHANNEL)
    reason = blocked or SESSION
    return Delivery(MONITOR if hooks_blocked(Path(cwd), root, environ) else HOOK, reason)
