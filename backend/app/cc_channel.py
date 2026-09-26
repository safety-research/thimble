"""Whether the analyst's Claude Code session loaded thimble's channel, and if not, which route browser events take.

Claude Code registers the plugin's channel only in a session started with `--dangerously-load-development-channels
plugin:thimble@<marketplace>` (or `--channels`), and tells no child process, so `on` reads the `claude` process's
command line (claude_pid walks up to it). THIMBLE_CHANNEL, which the `thimble` launcher exports, is the explicit signal
and wins. An entry counts when it names this plugin copy: `plugin:thimble@inline` for a `--plugin-dir` copy,
`plugin:thimble@<marketplace>` for an installed one.

Claude Code still refuses the channel after the flag for a third-party provider (Bedrock, Vertex, Foundry), for a
login that is not a claude.ai one (an API key, auth token, apiKeyHelper or ANTHROPIC_PROFILE, or no OAuth token with the
`user:inference` scope; on macOS an `oauthAccount` in `.claude.json` stands for the Keychain token), and by the org's
managed settings (`channelsEnabled`; `--channels` also needs `allowedChannelPlugins`). Without channels, browser events
go through the plugin's hooks, unless hooks are disabled too; then the model arms a Monitor. `delivery` names the route
and the reason.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any, Mapping, NamedTuple

from . import procs

ENV = "THIMBLE_CHANNEL"  # the explicit signal: the launcher exports it (plugin/bin/thimble)
# how Claude Code marks the environment of a background session it runs from its daemon, such as the copy of a session
# its agent view makes on ←; the daemon's environment, and so the copy's, can hold ENV from the session that started it
BG_KIND_ENV, BG_KIND = "CLAUDE_CODE_SESSION_KIND", "bg"
PLUGIN = "thimble"
SOURCE = "plugin:thimble:thimble"  # the `source` of the plugin server's channel events, as Claude Code shows them
INLINE = "inline"  # the marketplace Claude Code gives a plugin loaded with --plugin-dir
FLAGS = ("--dangerously-load-development-channels", "--channels")
DEV_FLAG = FLAGS[0]  # the development flag skips the org's channel allowlist; `--channels` does not
MAX_HOPS = 32  # claude_pid's walk up the process tree
PROVIDER_ENVS = ("CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY")
REMOTE_SETTINGS = "remote-settings.json"  # the org's server-managed settings, in Claude Code's config dir
MANAGED_DIRS = {"darwin": Path("/Library/Application Support/ClaudeCode"), "linux": Path("/etc/claude-code")}
MANAGED_FILE = "managed-settings.json"
MANAGED_DROPINS = "managed-settings.d"
TEAM_ORGS = ("claude_team", "claude_enterprise")  # oauthAccount.organizationType of a claude.ai Team or Enterprise seat
TEAM_SUBSCRIPTIONS = ("team", "enterprise")  # the OAuth token's subscriptionType for the same seats
USER_SETTINGS = "settings.json"
PROJECT_SETTINGS = (Path(".claude") / "settings.json", Path(".claude") / "settings.local.json")
CREDENTIALS = ".credentials.json"  # Claude Code's own login in its config dir (the Keychain on macOS)
INFERENCE_SCOPE = "user:inference"  # the scope that makes an OAuth token a claude.ai login
# The login sources that make a session's login not a claude.ai one (module note), by environment variable
KEY_ENVS = ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR", "ANTHROPIC_PROFILE")
OAUTH_ENVS = ("CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR")
SETTINGS_FLAG = "--settings"  # a settings file or inline JSON on Claude Code's command line (its "flag" tier)
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


def marketplace(root: Path) -> str:
    """The marketplace Claude Code loaded the plugin copy at `root` from: <marketplace> for a copy in its plugin cache,
    `inline` for any other folder (a --plugin-dir)."""
    parts = Path(root).parts
    if len(parts) >= 5 and parts[-5:-3] == ("plugins", "cache") and parts[-2] == PLUGIN:
        return parts[-3]
    return INLINE


def channel(root: Path) -> str:
    """The channel entry that loads the plugin copy at `root`: `plugin:thimble@<marketplace>`."""
    return f"plugin:{PLUGIN}@{marketplace(root)}"


def claude_pid(environ: Mapping[str, str] | None = None) -> int | None:
    """The `claude` process a command Claude Code started runs under (module note); None when no ancestor is one."""
    env = os.environ if environ is None else environ
    named = env.get("CLAUDE_PID") or ""
    sessions = Path(env.get("CLAUDE_CONFIG_DIR") or (Path.home() / ".claude")) / "sessions"
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
    entry = channel(root)
    return {flag for flag, e in flagged(procs.argv(pid)) if e == entry}


def on(pid: int | None, root: Path, environ: Mapping[str, str] | None = None) -> bool:
    """Whether the session of the `claude` process `pid` was started to hear the channel of the plugin copy at `root`:
    THIMBLE_CHANNEL is set, or that process's command line names the copy's channel entry (module note). Whether Claude
    Code then loads the channel is `delivery`'s question."""
    return bool(flags(pid, root, environ))


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
    managed-settings.json key by key, which is all the top-level keys read here need."""
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
        tier = {**(tier or {}), **(_read(p) or {})}
    return tier


def _state_file(environ: Mapping[str, str] | None = None) -> Path:
    """Claude Code's `.claude.json`: in CLAUDE_CONFIG_DIR when set, else in the home directory."""
    env = os.environ if environ is None else environ
    return Path(env["CLAUDE_CONFIG_DIR"]) / ".claude.json" if env.get("CLAUDE_CONFIG_DIR") else Path.home() / ".claude.json"


def account_type(environ: Mapping[str, str] | None = None) -> str:
    """`oauthAccount.organizationType` from Claude Code's `.claude.json`; "" when there is none, as for an API key."""
    account = (_read(_state_file(environ)) or {}).get("oauthAccount")
    value = account.get("organizationType") if isinstance(account, dict) else None
    return value if isinstance(value, str) else ""


def _oauth(environ: Mapping[str, str] | None = None) -> dict[str, Any] | None:
    """`claudeAiOauth` from Claude Code's `.credentials.json` in its config dir: None when the file is missing or holds
    none. Only the token's presence, scopes and subscription type are read from it, and nothing of it leaves here."""
    o = (_read(config_dir(environ) / CREDENTIALS) or {}).get("claudeAiOauth")
    return o if isinstance(o, dict) else None


def _truthy(value: str | None) -> bool:
    return str(value or "").strip().lower() not in ("", "0", "false", "no", "off")


def _flag_settings(argv: list[str], cwd: Path) -> list[dict[str, Any]]:
    """The settings a `--settings` on Claude Code's command line gives: inline JSON, or a file relative to `cwd`."""
    out: list[dict[str, Any]] = []
    for i, arg in enumerate(argv):
        if arg == "--":
            break
        flag, eq, value = arg.partition("=")
        if flag != SETTINGS_FLAG:
            continue
        value = value if eq else (argv[i + 1] if i + 1 < len(argv) else "")
        if value.lstrip().startswith("{"):
            try:
                d = json.loads(value)
            except ValueError:
                d = None
            out.append(d if isinstance(d, dict) else {})
        elif value:
            out.append(_read(Path(cwd) / Path(value).expanduser()) or {})
    return out


def claude_ai_login(cwd: Path | str, environ: Mapping[str, str] | None = None, argv: list[str] | None = None) -> bool:
    """Whether the session in `cwd`, with the environment `environ` and the command line `argv`, runs on a claude.ai
    login, the only one channels work with (module note): no API key, auth token or apiKeyHelper in any tier, no
    Anthropic profile, and an OAuth token with the inference scope."""
    env = os.environ if environ is None else environ
    tiers = [_read(config_dir(env) / USER_SETTINGS), *(_read(Path(cwd) / p) for p in PROJECT_SETTINGS), managed(env),
             *_flag_settings(argv or [], Path(cwd))]
    blocks = [t.get("env") for t in tiers if t and isinstance(t.get("env"), dict)]
    if any(env.get(k) or any(b.get(k) for b in blocks) for k in KEY_ENVS):
        return False
    if any(isinstance(t.get("apiKeyHelper"), str) and t["apiKeyHelper"].strip() for t in tiers if t):
        return False
    if env.get(OAUTH_ENVS[0]):
        scopes = str(env.get("CLAUDE_CODE_OAUTH_SCOPES") or INFERENCE_SCOPE).split()
        return INFERENCE_SCOPE in scopes
    if env.get(OAUTH_ENVS[1]):
        return True
    o = _oauth(env)
    if o is not None:
        scopes = o.get("scopes")
        return bool(o.get("accessToken")) and isinstance(scopes, list) and INFERENCE_SCOPE in scopes
    if sys.platform == "darwin":  # the Keychain holds the token (module note)
        return isinstance((_read(_state_file(env)) or {}).get("oauthAccount"), dict)
    return False


def channels_blocked(root: Path, named: set[str], environ: Mapping[str, str] | None = None,
                     cwd: Path | str | None = None, argv: list[str] | None = None) -> str:
    """Why Claude Code would not load the channel of the plugin copy at `root` in a session in `cwd` whose command line
    `argv` names it with the flags `named` (module note): PROVIDER, ACCOUNT, ORG, or "" when nothing stops it."""
    env = os.environ if environ is None else environ
    if any(_truthy(env.get(k)) for k in PROVIDER_ENVS):
        return PROVIDER
    if not claude_ai_login(Path(cwd) if cwd is not None else Path(os.devnull), env, argv):
        return ACCOUNT
    tier = managed(env)
    allowed = (tier or {}).get("channelsEnabled")
    if allowed is False:
        return ORG
    if allowed is not True:
        sub = (_oauth(env) or {}).get("subscriptionType") or env.get("CLAUDE_CODE_SUBSCRIPTION_TYPE")
        if sub in TEAM_SUBSCRIPTIONS or account_type(env) in TEAM_ORGS:
            return ORG
    if named and DEV_FLAG not in named:
        listed = (tier or {}).get("allowedChannelPlugins")
        if not any(isinstance(p, dict) and p.get("plugin") == PLUGIN and p.get("marketplace") == marketplace(root)
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
        if not (isinstance(enabled, dict) and enabled.get(f"{PLUGIN}@{marketplace(root)}") is True):
            return True
    value = None
    for path in (config_dir(environ) / USER_SETTINGS, *(Path(cwd) / p for p in PROJECT_SETTINGS)):
        v = (_read(path) or {}).get("disableAllHooks")
        if isinstance(v, bool):
            value = v
    return value is True


def delivery(pid: int | None, root: Path, cwd: Path | str, environ: Mapping[str, str] | None = None) -> Delivery:
    """How browser events reach the session of the `claude` process `pid` in `cwd` (module note): the channel when the
    flag names this copy's and nothing refuses it, else the hooks, else the Monitor, with why channels are off."""
    named = flags(pid, root, environ)
    blocked = channels_blocked(root, named, environ, cwd, procs.argv(pid) if pid else [])
    if named and not blocked:
        return Delivery(CHANNEL)
    reason = blocked or SESSION
    return Delivery(MONITOR if hooks_blocked(Path(cwd), root, environ) else HOOK, reason)
