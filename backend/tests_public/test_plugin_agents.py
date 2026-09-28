"""The plugin's contract with Claude Code: the agent definitions thimble passes with --agents (prompts/writer.md,
orient.md, critic.md and check.md) and any in plugin/agents parse with the frontmatter fields Claude Code reads
(https://code.claude.com/docs/en/sub-agents, "Supported frontmatter fields"); no agent but the tray entries names tools,
and each session keeps the thimble tools of its own; the shared skill prints the rules every thimble agent
shares; the orient skill starts the orientation through its tool; and every worked example a view ticket's prompt
names is a complete viewer in plugin/viewers."""
from __future__ import annotations

import json
import re
from pathlib import Path

import yaml

from app import config, prompts, tools

PLUGIN = config.REPO_ROOT / "plugin"
AGENTS = PLUGIN / "agents"
SKILL = PLUGIN / "skills" / "orient" / "SKILL.md"
SHARED = PLUGIN / "skills" / "shared" / "SKILL.md"
DEFINITIONS = {name: config.REPO_ROOT / "prompts" / f"{name}.md" for name in ("orient", "writer", "critic", "check")}
CORPUS = "mini"
PREFIX = "mcp__plugin_thimble_thimble__"  # how Claude Code names the plugin's MCP server's tools (tools.SERVER_NAME)
# the session each definition runs as the agent of (agent_session.py), whose tool list its own thimble tools come from
SESSION_OF = {"orient": "orient", "writer": "writer:report", "critic": "critique:orient", "check": "check:unverified:report"}
# the others are thimble-<stem>; the plugin's own agents are named for the tray, where Claude Code shows `thimble:<name>`
NAMES = {"writer": "writer", "critic": "critic", "check": "check", "orient-subagent": "orient", "writer-tray": "writer",
         "critic-tray": "critic"}
# the plugin's tray entries, thin relays of a background session (bg_session.py), which name their few tools
TRAY = ("writer-tray", "critic-tray")
TRAY_BUILTIN = {"Read", "SendMessage"}
# the fields Claude Code reads in an agent's frontmatter; hooks, mcpServers and permissionMode are ignored for plugin
# subagents, so an agent here must not lean on them
FIELDS = {"name", "description", "tools", "disallowedTools", "model", "permissionMode", "maxTurns", "skills", "mcpServers",
          "hooks", "memory", "background", "omitClaudeMd", "effort", "isolation", "color", "initialPrompt", "experimental"}
IGNORED_FOR_PLUGINS = {"hooks", "mcpServers", "permissionMode"}
SHARED_PROMPTS = ("preamble", "shared")  # what the shared skill's command renders: what thimble is, then the rules


def split(text: str) -> tuple[dict, str]:
    """(frontmatter, body) of an agent or skill file; the frontmatter must open on the first line."""
    assert text.startswith("---\n"), "the frontmatter must be the file's first line"
    head, _, body = text[4:].partition("\n---\n")
    front = yaml.safe_load(head)
    assert isinstance(front, dict), head
    return front, body


def tool_list(front: dict) -> list[str]:
    raw = front.get("tools")
    if isinstance(raw, str):
        return [t.strip() for t in raw.split(",") if t.strip()]
    return [str(t) for t in raw or []]


def agents() -> dict[str, tuple[dict, str]]:
    """Every agent definition by stem: the plugin's own and the four passed with --agents."""
    return {**{p.stem: split(p.read_text("utf-8")) for p in sorted(AGENTS.glob("*.md"))},
            **{name: split(path.read_text("utf-8")) for name, path in DEFINITIONS.items()}}


def test_the_thimble_skill_pre_approves_only_the_commands_it_injects():
    """/thimble's allowed-tools let its two injected commands run without a prompt, and no other thimble subcommand
    (`update --from`, `uninstall --yes`)."""
    front, body = split((PLUGIN / "skills" / "thimble" / "SKILL.md").read_text("utf-8"))
    rules = re.findall(r"Bash\(([^)]*)\)", front["allowed-tools"])
    cli = "${CLAUDE_PLUGIN_ROOT}/bin/thimble"
    assert [r for r in rules if r.startswith(cli + " ")] == [f"{cli} prompt *", f"{cli} server up *"]
    injected = [ln[2:].split("`")[0] for ln in body.splitlines() if ln.startswith("!`")]
    assert injected and all(any(c.startswith(r[:-1]) for r in rules if r.endswith(" *")) for c in injected), injected
