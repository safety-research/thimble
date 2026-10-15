"""Claude Code's permission updates as thimble's permission cards offer them as "don't ask again": the
`permission_suggestions` of a PermissionRequest, which become a card's "Always allow", and the `updatedPermissions`
a hook's answer returns when the analyst chose it.

A code ticket's session keeps each update for the session alone (agent_session.offer), or a web rule for the workspace
(WORKSPACE). Main's card in the browser keeps each update where Claude Code gave it (main_offer, events.py), as Claude
Code's own dialog's "Yes, and don't ask again" applies it, and its tooltip says where that is (main_tip). This module
imports no other part of thimble, so events.py and agent_session.py both use it.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

EDIT_MODE = "acceptEdits"  # the one mode a suggestion may switch a session to (allowing)
# the `destination` of a "don't ask again" update kept for the workspace, never sent to Claude Code
WORKSPACE = "workspace"
# the destinations Claude Code takes for an update a PermissionRequest hook returns, and where it keeps each, in the
# words of the tooltip of main's "Always allow" (main_tip)
DESTINATIONS = {"session": "for the rest of this session", "cliArg": "for the rest of this session",
                "localSettings": "in this folder (your project local settings)",
                "projectSettings": "in this folder (its shared project settings)",
                "userSettings": "in every folder (your user settings)"}


def allowing(suggestions: Any, keep: bool) -> list[dict[str, Any]]:
    """The allow rules, working directories and switch to acceptEdits among a request's permission_suggestions: with
    the `destination` each names when `keep`, leaving out one whose destination Claude Code does not take
    (DESTINATIONS); else each with destination session. [] when it suggests none."""
    out: list[dict[str, Any]] = []
    for s in suggestions if isinstance(suggestions, list) else []:
        kind = s.get("type") if isinstance(s, dict) else None
        where = s.get("destination") if keep and isinstance(s, dict) else "session"
        if not isinstance(where, str) or where not in DESTINATIONS:
            continue
        if kind == "addRules" and s.get("behavior") == "allow":
            rules = [{"toolName": r["toolName"], **({"ruleContent": r["ruleContent"]} if r.get("ruleContent") else {})}
                     for r in s.get("rules") or [] if isinstance(r, dict) and isinstance(r.get("toolName"), str)
                     and r["toolName"] and isinstance(r.get("ruleContent", ""), str)]
            if rules:
                out.append({"type": "addRules", "rules": rules, "behavior": "allow", "destination": where})
        elif kind == "addDirectories":
            dirs = [d for d in s.get("directories") or [] if isinstance(d, str) and d]
            if dirs:
                out.append({"type": "addDirectories", "directories": dirs, "destination": where})
        elif kind == "setMode" and s.get("mode") == EDIT_MODE:
            out.append({"type": "setMode", "mode": EDIT_MODE, "destination": where})
    return out


def main_offer(suggestions: Any) -> list[dict[str, Any]]:
    """The updates of a request of main's session that its card in the browser offers as "Always allow": the allow
    rules, working directories and switch to acceptEdits Claude Code suggested, each with the `destination` Claude Code
    gave it (events.hook_permission_route); [] when it suggests none."""
    return allowing(suggestions, keep=True)


def rule_text(rule: dict[str, Any]) -> str:
    """A permission rule as Claude Code writes it in its settings and in /permissions: `Bash(npm test *)`, or the tool
    alone."""
    return f"{rule['toolName']}({rule['ruleContent']})" if rule.get("ruleContent") else str(rule["toolName"])


def offer_text(updates: list[dict[str, Any]]) -> str:
    """What a "don't ask again" adds, in Claude Code's terms: its rules, `all edits` for acceptEdits (Claude Code's
    "allow all edits during this session") and `files in <folder>/` for a working directory, named by its last part as
    Claude Code's dialog names it; a web rule kept for the workspace by its site, or as web search."""
    parts = [web_text(r) if u.get("destination") == WORKSPACE else rule_text(r)
             for u in updates if u["type"] == "addRules" for r in u["rules"]]
    parts += [f"files in {Path(d).name or d}/"
              for u in updates if u["type"] == "addDirectories" for d in u["directories"]]
    parts += ["all edits" for u in updates if u["type"] == "setMode"]
    return ", ".join(parts)


def web_text(rule: dict[str, Any]) -> str:
    """A web rule kept for the workspace, in the card's words: `<site> in this workspace`, `web search in this
    workspace`."""
    site = str(rule.get("ruleContent") or "").removeprefix("domain:")
    return f"{site or 'web search'} in this workspace"


def main_tip(updates: list[dict[str, Any]]) -> str:
    """The tooltip of main's "Always allow" (main_offer): what it adds (offer_text) and where Claude Code keeps it
    (DESTINATIONS), the updates of one destination together."""
    groups: dict[str, list[dict[str, Any]]] = {}
    for u in updates:
        groups.setdefault(DESTINATIONS[u["destination"]], []).append(u)
    return "Allow, and don't ask again for " + "; ".join(f"{offer_text(us)} {where}" for where, us in groups.items())
