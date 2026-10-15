"""Claude Code's permission updates as thimble's permission cards offer them as "don't ask again": the
`permission_suggestions` of a PermissionRequest, which become a card's "Always allow", and the `updatedPermissions`
a hook's answer returns when the analyst chose it.

A code ticket's session keeps each update for the session alone (agent_session.offer), or a web rule for the workspace
(WORKSPACE). Main's card in the browser keeps each update where Claude Code gave it (main_offer, events.py), as Claude
Code's own dialog's "Yes, and don't ask again" applies it. Its button and tooltip say it in the words of that dialog
(main_words), and the tooltip says where Claude Code keeps it. This module imports no other part of thimble, so
events.py and agent_session.py both use it.
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any

EDIT_MODE = "acceptEdits"  # the one mode a suggestion may switch a session to (allowing)
# the `destination` of a "don't ask again" update kept for the workspace, never sent to Claude Code
WORKSPACE = "workspace"
# the destinations Claude Code takes for an update a PermissionRequest hook returns: those it keeps for the session
# alone, and those it saves in a settings file, with where that is in the tooltip of main's card (main_words)
SESSION_ONLY = ("session", "cliArg")
SAVED_IN = {"localSettings": "this folder's local settings (.claude/settings.local.json)",
            "projectSettings": "this folder's shared project settings (.claude/settings.json)",
            "userSettings": "your user settings, for any project"}
DESTINATIONS = (*SESSION_ONLY, *SAVED_IN)
# Claude Code's name for acceptEdits in its permission dialog
EDIT_MODE_WORDS = "accept edits (auto-approve file edits and common file commands)"
# the tools whose permission dialog in Claude Code 2.1.300, its file edit dialog, offers the switch to acceptEdits that
# Claude Code suggests: its Bash dialog offers only rules and folders, and its other dialogs only rules, so their
# "don't ask again" never switches the mode, though the request's suggestions may hold that switch (main_offer)
MODE_DIALOG_TOOLS = ("Edit", "MultiEdit", "Write", "NotebookEdit")


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


def main_offer(suggestions: Any, tool: str) -> list[dict[str, Any]]:
    """The updates of a request of main's session for `tool` that its card in the browser offers as "Always allow": the
    allow rules, working directories and switch to acceptEdits Claude Code suggested, each with the `destination` Claude
    Code gave it (events.hook_permission_route), the switch only where Claude Code's own dialog offers it
    (MODE_DIALOG_TOOLS); [] when it suggests none."""
    updates = allowing(suggestions, keep=True)
    return updates if tool in MODE_DIALOG_TOOLS else [u for u in updates if u["type"] != "setMode"]


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


def listed(items: list[str]) -> str:
    """Items as Claude Code's permission dialog lists them: `a`, `a and b`, `a, b, and c`."""
    return " and ".join(items) if len(items) <= 2 else ", ".join(items[:-1]) + ", and " + items[-1]


def tool_words(tool: str) -> str:
    """A tool as Claude Code's permission dialog names it: an MCP tool `mcp__<server>__<tool>` as `<server> — <Tool>`,
    with each `_` of its tool name a space and each word capitalized, and a plugin's server `plugin_<plugin>_<server>`
    as Claude Code names it, `plugin:<plugin>:<server>` (a plugin's name holds no `_`); any other tool by its name."""
    parts = _mcp_parts(tool)
    return tool if parts is None else f"{parts[0]} \u2014 {parts[1]}"


def tool_title(tool: str) -> str:
    """A tool as the button of main's card names it: an MCP tool by its title alone (`Add Card`), since the server's
    name before it would push what the button allows past its end; any other tool by its name."""
    parts = _mcp_parts(tool)
    return tool if parts is None else parts[1]


def _mcp_parts(tool: str) -> tuple[str, str] | None:
    """(the server, the tool's title) of an MCP tool as Claude Code's permission dialog names them (tool_words); None
    for any other tool."""
    parts = tool.split("__")
    if len(parts) < 3 or parts[0] != "mcp" or not parts[1]:
        return None
    server, name = parts[1], "__".join(parts[2:])
    plugin, _, rest = server.removeprefix("plugin_").partition("_")
    if server.startswith("plugin_") and plugin and rest:
        server = f"plugin:{plugin}:{rest}"
    title = re.sub(r"\b\w", lambda m: m.group().upper(), re.sub(r"_+", " ", name).strip(), flags=re.ASCII)
    return server, title or name


def read_folder(content: str) -> str:
    """The folder of a Read rule as Claude Code's permission dialog shows it: `//data/notes/**` as `/data/notes`."""
    folder = content.removesuffix("/**").removeprefix("./")
    return "/" + folder[2:] if folder.startswith("//") else folder


def _short(folder: str) -> str:
    """A folder named by its last part, as the card's button names it: `notes/`."""
    return f"{Path(folder).name or folder.rstrip('/')}/"


def _clauses(u: dict[str, Any], cwd: str) -> list[tuple[str, str, bool]]:
    """What one update adds, as Claude Code 2.1.300's permission dialog words it after its "Yes, and" (or "Yes,"):
    (the button's words, the tooltip's, whether it needs the card's "Allow, and" before it to say it allows). The
    tooltip's words carry what Claude Code's row adds after them: the folder of a whole tool's rule saved in a folder's
    settings, and `for this session` (`during this session` for reading) for an update kept for the session alone."""
    session = u["destination"] in SESSION_ONLY
    tail = " for this session" if session else ""
    if u["type"] == "setMode":
        return [("switch to accept edits", f"switch to {EDIT_MODE_WORDS}{tail}", True)]
    if u["type"] == "addDirectories":
        dirs = u["directories"]
        return [(f"always allow access to {listed([_short(d) for d in dirs])}",
                 f"always allow access to {', '.join(dirs)}{tail}", False)]
    rules = u["rules"]
    whole = [r["toolName"] for r in rules if not r.get("ruleContent")]
    bash = [r["ruleContent"] for r in rules if r.get("ruleContent") and r["toolName"] == "Bash"]
    reads = [read_folder(r["ruleContent"]) for r in rules if r.get("ruleContent") and r["toolName"] == "Read"]
    sites = [r["ruleContent"].removeprefix("domain:") for r in rules if r.get("ruleContent")
             and r["toolName"] == "WebFetch" and r["ruleContent"].startswith("domain:")]
    other = [rule_text(r) for r in rules if r.get("ruleContent") and r["toolName"] not in ("Bash", "Read")
             and not (r["toolName"] == "WebFetch" and r["ruleContent"].startswith("domain:"))]
    out: list[tuple[str, str, bool]] = []
    if whole:
        words = f"don't ask again for {listed([tool_words(t) for t in whole])} commands"
        here = f" in {cwd}" if cwd and u["destination"] in ("localSettings", "projectSettings") else ""
        # the button: MCP tools by their titles, with neither the server nor `commands` (tool_title)
        short = (f"don't ask again for {listed([tool_title(t) for t in whole])}"
                 if all(_mcp_parts(t) for t in whole) else words)
        out.append((short, f"{words}{here}{tail}", True))
    if bash:
        words = ("don\u2019t ask again for any Bash command" if bash == ["*"]
                 else f"don\u2019t ask again for: {listed(bash)}")
        out.append((words, f"{words}{tail}", True))
    if reads:
        out.append((f"allow reading from {listed([_short(d) for d in reads])}",
                    f"allow reading from {listed(reads)}{' during this session' if session else ''}", False))
    for named in (sites, other):
        if named:
            words = f"don't ask again for {listed(named)}"
            out.append((words, f"{words}{tail}", True))
    return out


def main_words(updates: list[dict[str, Any]], cwd: str = "") -> dict[str, str]:
    """The button of main's card's "don't ask again" (main_offer) and its tooltip, in the words of the row of Claude
    Code 2.1.300's own permission dialog for the same updates (_clauses), with the card's "Allow" for its "Yes", the
    rows of several updates in its order (the switch of mode, folders, rules) and joined by `; ` as Claude Code joins
    them: `always_label`, short (a folder by its last part, acceptEdits by its name, an MCP tool by its title, without
    the session's folder), and
    `always_tip`, whole, which then says where Claude Code saves the updates it keeps in a settings file (SAVED_IN).
    `cwd` is the session's folder, which Claude Code names in the row of a whole tool's rule."""
    order = ("setMode", "addDirectories", "addRules")
    rows = [c for u in sorted(updates, key=lambda u: order.index(u["type"])) for c in _clauses(u, cwd)]
    if not rows:
        return {}

    def joined(k: int) -> str:
        first, *rest = rows
        head = f"Allow, and {first[k]}" if first[2] else first[k][:1].upper() + first[k][1:]
        return "; ".join([head, *(r[k] for r in rest)])

    saved = list(dict.fromkeys(SAVED_IN[u["destination"]] for u in updates if u["destination"] in SAVED_IN))
    tip = joined(1) + (f". Claude Code saves this in {listed(saved)}." if saved else "")
    return {"always_label": joined(0), "always_tip": tip}
