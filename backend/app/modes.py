"""The permission mode of each agent thimble starts, one row per agent in the settings (AGENTS): the orientation with its
subagents, the writers, the critic and the report checks, the dev agent's tickets, and view builds. Each runs in Manual,
Auto or Bypass (MODES).

A row the analyst has not set follows main, the Claude Code session that started thimble: the mode Claude Code reports
to main's hooks (session.note_mode), Manual before the first report. So an agent runs in Bypass only when main does, or
when the analyst chose Bypass for it in thimble: in Settings, on Start (the orientation's row), or on a session's card
(that session alone, agent_session.set_mode). A mode the analyst's Claude Code settings turn off (disabled) is never
used. Main's own mode is Claude Code's alone.

Manual and Bypass both run Claude Code's manual mode (FLAGS): in Bypass thimble grants every request itself
(agent_session.ask), so a card switches between them without restarting the session. Auto runs Claude Code's auto mode.
"""
from __future__ import annotations

from typing import Any

from . import agents, cc_settings, ledger

MODES = ("manual", "auto", "bypass")
AGENTS = ("orient", "writer", "critic", "dev", "views")
SETTING = "permission_modes"  # in the workspace's settings: {agent: mode}, the rows the analyst set
FLAGS = {"manual": "default", "auto": "auto", "bypass": "default"}  # each mode's --permission-mode
OF_CLAUDE = {"auto": "auto", "bypassPermissions": "bypass"}  # by Claude Code's name; any other mode is Manual
CLAUDE_MODES = ("default", "manual", "acceptEdits", "plan", "auto", "dontAsk", "bypassPermissions")
NAMES = {"manual": "Manual", "auto": "Auto", "bypass": "Bypass"}


def flag(mode: str) -> str:
    """The --permission-mode a session in `mode` runs with."""
    return FLAGS.get(mode, "default")


def disabled() -> set[str]:
    """The modes the analyst's Claude Code settings turn off: Bypass by `permissions.disableBypassPermissionsMode`,
    Auto by `disableAutoMode` or `permissions.disableAutoMode`, each set to "disable"."""
    off: set[str] = set()
    for path in cc_settings.analyst_sources():
        d = cc_settings._read(path)
        perms = d.get("permissions") if isinstance(d.get("permissions"), dict) else {}
        if perms.get("disableBypassPermissionsMode") == "disable":
            off.add("bypass")
        if "disable" in (d.get("disableAutoMode"), perms.get("disableAutoMode")):
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
    """The mode main runs in, as its hooks last reported it; Manual before any report."""
    held = (agents.meta_or_none(c, agents.MAIN_ID) or {}).get("attached") or {}
    return OF_CLAUDE.get(str(held.get("permission_mode") or ""), "manual")


def chosen(stored: dict[str, Any]) -> dict[str, str]:
    """The rows the analyst set, from a workspace's stored settings."""
    got = stored.get(SETTING)
    return {a: m for a, m in got.items() if a in AGENTS and m in MODES} if isinstance(got, dict) else {}


def mode_for(c: str, agent: str) -> str:
    """The mode an agent of workspace `c` starts in: its row, else main's, else Manual, whichever is not turned off."""
    off = disabled()
    return next(m for m in (chosen(ledger.stored_settings(c)).get(agent), session_mode(c), "manual") if m and m not in off)


def patch_error(patch: Any) -> str | None:
    """Why a PUT's `permission_modes` ({agent: mode, or None for main's}) cannot be saved, or None when it can."""
    if not isinstance(patch, dict):
        return "permission_modes takes {agent: mode}"
    for agent, mode in patch.items():
        if agent not in AGENTS:
            return f"no agent {agent!r}; one of {', '.join(AGENTS)}"
        if mode is not None and (why := refused(mode)):
            return why
    return None
