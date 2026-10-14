"""The permission mode of the agents thimble starts. Every agent of thimble's, code tickets' agents among them, is a
subagent of main, the analyst's Claude Code session, and runs in main's mode, as Claude Code runs its own subagents. An
extension's program that runs the dev agent stays a job of the server, with one row in thimble's config (AGENTS): the
dev agent's, in Manual, Auto or Bypass (MODES), `agents.dev.permissionMode` (userconf.MODE_ROWS). The rows of earlier
builds (IGNORED_ROWS) are read and ignored, so an earlier config or tab stays valid.

A row the analyst has not set follows main: the mode Claude Code reports to main's hooks (session.note_mode), which
thimble keeps until main reports again, over a restart of the server under the same session too, Manual before the first
report. So such a program runs in Bypass only when main does, or when the analyst chose Bypass for it in thimble's
config or on a session's card (that session alone, agent_session.set_mode), each a write only the analyst's browser may
make (hook_auth.analyst). A mode the analyst's or the org's Claude Code settings turn off (disabled) is never used.
Main's own mode is Claude Code's alone.

Manual and Bypass both run Claude Code's manual mode (FLAGS): in Bypass thimble grants every request itself
(agent_session.ask), so a card switches between them without restarting the session. Auto runs Claude Code's auto mode.
"""
from __future__ import annotations

from typing import Any

from . import cc_settings

MODES = ("manual", "auto", "bypass")
AGENTS = ("dev",)
IGNORED_ROWS = ("orient", "writer", "critic", "checks")  # rows of earlier builds: those agents run in main's mode
SETTING = "permission_modes"  # in GET and PUT /settings: {agent: mode}, the rows set in thimble's config
EARLIER = {"views": "dev"}  # rows of earlier builds, by the row they are now
FLAGS = {"manual": "default", "auto": "auto", "bypass": "default"}  # each mode's --permission-mode
OF_CLAUDE = {"auto": "auto", "bypassPermissions": "bypass"}  # by Claude Code's name; any other mode is Manual
CLAUDE_MODES = ("default", "manual", "acceptEdits", "plan", "auto", "dontAsk", "bypassPermissions")
NAMES = {"manual": "Manual", "auto": "Auto", "bypass": "Bypass"}


def flag(mode: str) -> str:
    """The --permission-mode a session in `mode` runs with."""
    return FLAGS.get(mode, "default")


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


def auto_off() -> str:
    """Who turns auto mode off: "org" when the org's managed tier does, "settings" when the analyst's own settings.json
    does (cc_settings.analyst_tiers), '' when neither does."""
    user, org = cc_settings.analyst_tiers()
    return "org" if _auto_disabled(org) else "settings" if _auto_disabled(user) else ""


def manual_hint(claude_mode: str | None) -> str:
    """What to tell the analyst about main's prompts when main runs in Claude Code's mode `claude_mode` (None when not
    known, which counts as Manual, as session_mode counts it): auto_off's "org" or "settings" when auto mode is turned
    off, "switch" when main asks in Manual and auto mode would ask less, '' in auto or bypass mode (unless turned off,
    where Claude Code starts main in Manual) and in dontAsk, which asks nothing."""
    if claude_mode == "dontAsk":
        return ""
    ours = OF_CLAUDE.get(claude_mode or "", "manual")
    if ours != "manual" and ours not in disabled():
        return ""
    return auto_off() or "switch"


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


def rows(c: str) -> dict[str, str]:
    """The rows thimble's config sets for workspace `c`."""
    from . import userconf  # noqa: PLC0415 — userconf reads config, which the session modules import

    return userconf.mode_rows(c)


def mode_for(c: str, agent: str) -> str:
    """The mode an agent of workspace `c` starts in: its row, else main's, else Manual, whichever is not turned off."""
    off = disabled()
    agent = EARLIER.get(agent, agent)
    return next(m for m in (rows(c).get(agent), session_mode(c), "manual") if m and m not in off)


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
