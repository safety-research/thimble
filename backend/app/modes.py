"""The permission mode of the agents thimble starts. Every agent of thimble's, code tickets' agents among them, is a
subagent of main, the analyst's Claude Code session, and runs in main's mode, as Claude Code runs its own subagents. An
extension's program that runs the dev agent stays a job of the server, with one row in thimble's config (AGENTS): the
dev agent's, in Manual, Auto or Bypass (MODES), `agents.dev.permissionMode` (userconf.MODE_ROWS). The rows of earlier
builds (IGNORED_ROWS) are read and ignored, so an earlier config or tab stays valid.

A row the analyst has not set follows main: the mode Claude Code reports to main's hooks (session.note_mode), which
thimble keeps until main reports again, over a restart of the server under the same session too, Manual before the first
report, and Manual while main runs in Bypass. A row set to Bypass takes effect only once the analyst chose Bypass for it
in Settings (chosen: a record only the analyst's browser can make, hook_auth.analyst, and file tools may not edit);
"bypass" written into the config alone counts as Manual. A mode the analyst's or the org's Claude Code settings turn off
(disabled) is never used. Main's own mode is Claude Code's alone, and code tickets' agents and view builders, which are
main's subagents, run in it.

Manual and Bypass both run Claude Code's manual mode (FLAGS): in Bypass thimble grants every request itself
(agent_session.ask), so a card switches between them without restarting the session. Auto runs Claude Code's auto mode.

While main reports Claude Code's Manual mode (subagent_files.MANUAL_MODES), Claude Code asks before most commands of
main's and of thimble's agents, and asks thimble's agents' prompts in the terminal alone, where each agent waits until
the analyst answers. thimble then shows the notice `manual-mode` (manual_notice) in red, which says both: in the browser
above the chat's composer, in terminal mode above Claude Code's prompt, until main reports another mode or the analyst
dismisses it, which holds for the workspace (notices.py). While one of those prompts is open the browser shows the agent
as waiting for the analyst's answer in the terminal (events.py, the terminal's prompts). In browser mode, main's
terminal also says once per session that Claude Code is in Manual mode (manual_line, session.note_mode).
"""
from __future__ import annotations

import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from . import cc_settings
from .subagent_files import MANUAL_MODES

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
    """What to tell the analyst about prompts when main reports Claude Code's mode `claude_mode`: '' unless it is Manual
    mode (MANUAL_MODES); then auto_off's "org" or "settings" when auto mode is turned off, else "switch"."""
    if claude_mode not in MANUAL_MODES:
        return ""
    return auto_off() or "switch"


# what main's terminal shows once per session when main reports Manual mode, by manual_hint
MANUAL_LINE = ("thimble: Claude Code is in Manual mode, so it asks you before most commands that main or thimble's "
               "agents run.")
MANUAL_LINES = {
    "switch": f"{MANUAL_LINE} For fewer prompts, press shift+tab to switch to auto mode, or start with "
              "`thimble --permission-mode auto`.",
    "org": f"{MANUAL_LINE} Your organization turned auto mode off.",
    "settings": f"{MANUAL_LINE} Your Claude Code settings turn auto mode off (disableAutoMode).",
}


def manual_line(claude_mode: str | None) -> str:
    """The line main's terminal shows about Manual mode when main reports `claude_mode` (MANUAL_LINES), '' when it is
    not Manual mode."""
    hint = manual_hint(claude_mode)
    return MANUAL_LINES[hint] if hint else ""


# the words of the `manual-mode` notice (notices.py), by manual_hint, in the browser above the composer and in terminal
# mode's band above Claude Code's prompt
MANUAL_NOTICE = ("Manual mode: Claude Code asks before most commands, and thimble's agents wait in your terminal until you "
                 "answer there.")
MANUAL_NOTICES = {
    "switch": f"{MANUAL_NOTICE} In your terminal, press shift+tab for auto mode, or start with "
              "`thimble --permission-mode auto`.",
    "org": f"{MANUAL_NOTICE} Your organization turned auto mode off.",
    "settings": f"{MANUAL_NOTICE} Your Claude Code settings turn auto mode off (disableAutoMode).",
}


def manual_notice(claude_mode: str | None) -> str:
    """The `manual-mode` notice's words when main reports `claude_mode` (MANUAL_NOTICES), '' outside Manual mode."""
    hint = manual_hint(claude_mode)
    return MANUAL_NOTICES[hint] if hint else ""


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
    settings PUT, a write only the analyst's browser may make) and which file tools may not edit (module_rules)."""
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
