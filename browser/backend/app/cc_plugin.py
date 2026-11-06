"""Claude Code's managed settings as thimble reads them: the org's server-managed settings (remote-settings.json in
Claude Code's config dir) when they exist, else managed-settings.json with its managed-settings.d drop-ins in the
platform's managed folder (`managed`).
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any, Mapping

REMOTE_SETTINGS = "remote-settings.json"  # the org's server-managed settings, in Claude Code's config dir
MANAGED_DIRS = {"darwin": Path("/Library/Application Support/ClaudeCode"), "linux": Path("/etc/claude-code")}
MANAGED_FILE = "managed-settings.json"
MANAGED_DROPINS = "managed-settings.d"
HOOK = "hook"  # the route a subscription named (events.Sub)


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


def managed_rules_only(environ: Mapping[str, str] | None = None) -> bool:
    """Whether the org's managed tier sets `allowManagedPermissionRulesOnly`, under which Claude Code ignores every
    permission rule a session saves, so its dialog offers no "don't ask again"."""
    return (managed(environ) or {}).get("allowManagedPermissionRulesOnly") is True
