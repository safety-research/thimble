"""The permission mode of the agents thimble starts. Every agent of thimble's, code tickets' agents among them, is a
subagent of main, and runs in main's mode, as Claude Code runs its own subagents. The
dev agent has one row in thimble's config (AGENTS), in Manual, Auto or Bypass (MODES), `agents.dev.permissionMode`
(userconf.MODE_ROWS), which a code ticket's card follows (agent_session.host). The rows of earlier
builds (IGNORED_ROWS) are read and ignored, so an earlier config or tab stays valid.

A row the analyst has not set follows main's mode as the server knows it (session.main_mode), Manual when it knows
none, and Manual while main runs in Bypass. A row set to Bypass takes effect only once the analyst chose Bypass for it
in Settings (chosen: a record only the analyst's browser can make, hook_auth.analyst, and file tools may not edit);
"bypass" written into the config alone counts as Manual. A mode the analyst's or the org's Claude Code settings turn off
(disabled) is never used. Main's own mode is Claude Code's alone, and code tickets' agents and view builders, which are
main's subagents, run in it.

Manual and Bypass both run Claude Code's manual mode: in Bypass thimble grants every request itself
(agent_session.ask), so a card switches between them without restarting the session. Auto runs Claude Code's auto mode.
"""
from __future__ import annotations

import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from . import cc_settings

MODES = ("manual", "auto", "bypass")
AGENTS = ("dev",)
IGNORED_ROWS = ("orient", "writer", "critic", "checks")  # rows of earlier builds: those agents run in main's mode
SETTING = "permission_modes"  # in GET and PUT /settings: {agent: mode}, the rows set in thimble's config
EARLIER = {"views": "dev"}  # rows of earlier builds, by the row they are now
OF_CLAUDE = {"auto": "auto", "bypassPermissions": "bypass"}  # by Claude Code's name; any other mode is Manual
CLAUDE_MODES = ("default", "manual", "acceptEdits", "plan", "auto", "dontAsk", "bypassPermissions")
NAMES = {"manual": "Manual", "auto": "Auto", "bypass": "Bypass"}


def _auto_disabled(d: dict[str, Any]) -> bool:
    """Whether the settings `d` turn auto mode off: `disableAutoMode` or `permissions.disableAutoMode` set to "disable"."""
    perms = d.get("permissions") if isinstance(d.get("permissions"), dict) else {}
    return "disable" in (d.get("disableAutoMode"), perms.get("disableAutoMode"))


def disabled() -> set[str]:
    """The modes the analyst's or the org's Claude Code settings turn off (cc_settings.analyst_tiers): Bypass by
    `permissions.disableBypassPermissionsMode`, Auto by `disableAutoMode` or `permissions.disableAutoMode`, each set to
    "disable"."""
    off: set[str] = set()
    for d in cc_settings.analyst_tiers():
        perms = d.get("permissions") if isinstance(d.get("permissions"), dict) else {}
        if perms.get("disableBypassPermissionsMode") == "disable":
            off.add("bypass")
        if _auto_disabled(d):
            off.add("auto")
    return off


def refused(mode: Any) -> str | None:
    """Why `mode` cannot be chosen, or None when it can."""
    if mode not in MODES:
        return f"no permission mode {mode!r}; one of {', '.join(MODES)}"
    if mode in disabled():
        return f"{NAMES[mode]} is turned off by your Claude Code settings"
    return None


def session_mode(c: str) -> str:
    """The mode main runs in, as its hooks last reported it (session.main_mode); Manual before any report."""
    from . import session  # noqa: PLC0415 — session imports this module

    return OF_CLAUDE.get(session.main_mode(c) or "", "manual")


def chosen() -> set[str]:
    """The rows the analyst chose Bypass for in Settings: userconf.bypass_file, which only `choose` writes (from the
    settings PUT, a write only the analyst's browser may make) and which file tools may not edit
    (userconf.Session.settings)."""
    from . import userconf  # noqa: PLC0415 — userconf reads config, which the session modules import

    try:
        got = json.loads(userconf.bypass_file().read_text("utf-8"))
    except (OSError, ValueError):
        return set()
    rows = got.get("rows") if isinstance(got, dict) else None
    return {str(r) for r in rows if r in AGENTS} if isinstance(rows, list) else set()


def choose(patch: dict[str, Any]) -> None:
    """Record a Settings PUT's `permission_modes`: a row set to Bypass joins `chosen`, any other value or None leaves
    it. Written atomically, mode 600."""
    from . import config, userconf  # noqa: PLC0415

    if not isinstance(patch, dict):
        return
    now = chosen()
    for agent, mode in patch.items():
        row = EARLIER.get(agent, agent)
        if row not in AGENTS:
            continue
        if mode == "bypass":
            now.add(row)
        else:
            now.discard(row)
    path = userconf.bypass_file()
    config.private_dir(path.parent)
    rec = {"rows": sorted(now), "at": datetime.now(timezone.utc).isoformat(timespec="seconds")}
    fd, tmp = tempfile.mkstemp(prefix=".bypass.", dir=str(path.parent))  # mode 600
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(json.dumps(rec, indent=1) + "\n")
        os.replace(tmp, path)
    finally:
        Path(tmp).unlink(missing_ok=True)


def rows(c: str) -> dict[str, str]:
    """The rows thimble's config sets for workspace `c`, a Bypass the analyst did not choose in Settings read as
    Manual."""
    from . import userconf  # noqa: PLC0415 — userconf reads config, which the session modules import

    ok = chosen()
    return {r: ("manual" if m == "bypass" and r not in ok else m) for r, m in userconf.mode_rows(c).items()}


def mode_for(c: str, agent: str) -> str:
    """The mode an agent of workspace `c` starts in: its row (rows), else main's with Bypass read as Manual, else Manual,
    whichever is not turned off."""
    off = disabled()
    agent = EARLIER.get(agent, agent)
    main = session_mode(c)
    return next(m for m in (rows(c).get(agent), "manual" if main == "bypass" else main, "manual") if m and m not in off)


def patch_error(patch: Any) -> str | None:
    """Why a PUT's `permission_modes` ({agent: mode, or None for main's}) cannot be saved, or None when it can. A row of
    IGNORED_ROWS is taken and dropped (userconf.pane_patch)."""
    if not isinstance(patch, dict):
        return "permission_modes takes {agent: mode}"
    for agent, mode in patch.items():
        if agent in IGNORED_ROWS:
            continue
        if EARLIER.get(agent, agent) not in AGENTS:
            return f"no agent {agent!r}; one of {', '.join(AGENTS)}"
        if mode is not None and (why := refused(mode)):
            return why
    return None
