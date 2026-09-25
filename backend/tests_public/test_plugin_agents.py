"""The plugin's contract with Claude Code: the agent definitions thimble passes with --agents (prompts/writer.md,
orient.md, critic.md and check.md) and any in plugin/agents parse with the frontmatter fields Claude Code reads
(https://code.claude.com/docs/en/sub-agents, "Supported frontmatter fields"); every tool an agent names is a built-in
or a thimble MCP tool of its session under the plugin prefix; the shared skill prints the rules every thimble agent
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
# the session each definition runs as the agent of (agent_session.py), whose tool list its tools must come from
SESSION_OF = {"orient": "orient", "writer": "writer:report", "critic": "critique:orient", "check": "check:unverified:report"}
# Agent: the orientation starts its subagents; Workflow: the orientation's and a writer's sessions run workflows of
# their own; Bash: a check's session, fenced to a work folder of its own, counts and searches the corpus
BUILTIN = {"Read", "Grep", "Glob", "Skill", "Agent", "Workflow", "Bash"}
NAMES = {"writer": "writer", "critic": "critic", "check": "check"}  # the others are thimble-<stem>
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


def test_agent_files_parse_with_the_fields_claude_code_reads():
    seen = agents()
    assert set(DEFINITIONS) <= set(seen)
    for stem, (front, body) in seen.items():
        assert re.fullmatch(r"[a-z][a-z0-9-]*", str(front.get("name") or "")), (stem, front.get("name"))
        assert front["name"] == NAMES.get(stem, f"thimble-{stem}")
        assert not set(front) - FIELDS, (stem, set(front) - FIELDS)
        assert not set(front) & IGNORED_FOR_PLUGINS, (stem, "ignored for plugin subagents")
        assert body.strip(), (stem, "an empty body")
        # main reads a description to pick the agent, so it says briefly what the agent does and when to start it
        desc = str(front.get("description") or "")
        assert 12 <= len(desc.split()) <= 35 and "start" in desc.lower(), (stem, desc)
    assert "model" not in seen["orient"][0], "the orientation's session runs on the analyst's own model"
    assert "`start_orientation` tool" in seen["orient"][0]["description"], "main orients with the tool, not the agent"


def test_agent_tools_are_builtins_or_registry_tools_under_the_plugin_prefix():
    """Each tool an agent names is a built-in or a tool its session's shim lists. The orientation names none: it
    inherits every tool, less its session's --disallowedTools, which never take the built-ins or the web."""
    from app import orient_session

    assert PREFIX == f"mcp__plugin_thimble_{tools.SERVER_NAME}__"
    for stem, (front, _) in agents().items():
        listed = tool_list(front)
        if stem == "orient":
            assert not listed and "tools" not in front
            continue
        assert listed, (stem, "tools must be listed, the agent is not meant to inherit Bash or Write")
        names = {x["name"] for x in tools.list(tools.ANALYST, SESSION_OF.get(stem))}
        for t in listed:
            if t not in BUILTIN:
                assert t.startswith(PREFIX) and t[len(PREFIX):] in names, (stem, t, "not a tool of the session's role")
    denied = set(orient_session.disallowed([*orient_session.PARTS, *orient_session.LINES]))
    assert not {"Read", "Grep", "Glob", "Bash", "Skill", "Agent", "Workflow", "WebFetch", "WebSearch"} & denied
    kept = set(orient_session.ORIENT_TOOLS)
    assert kept <= set(tools.REGISTRY)
    assert {t[len(PREFIX):] for t in denied if t.startswith(PREFIX)} == set(tools.REGISTRY) - kept


def test_the_shared_skill_renders_the_prompt_file_every_thimble_agent_shares(capsys):
    """plugin/skills/shared is a skill a model may call. Its body is one injected command, `thimble prompt shared`,
    allowed by its own allowed-tools, whose output is prompts/shared.md rendered as main's append renders it."""
    from app import channel, cli

    front, body = split(SHARED.read_text("utf-8"))
    assert front["name"] == "shared" and front.get("user-invocable") is False and not front.get("disable-model-invocation")
    lines = [ln for ln in body.splitlines() if ln.strip()]
    assert len(lines) == 1 and lines[0].startswith("!`${CLAUDE_PLUGIN_ROOT}/bin/thimble prompt " + " ".join(SHARED_PROMPTS) + " ")
    assert "Bash(${CLAUDE_PLUGIN_ROOT}/bin/thimble prompt *)" in front["allowed-tools"]
    cwd = str(config.corpus_dir(CORPUS))
    assert cli.main(["prompt", *SHARED_PROMPTS, "--cwd", cwd]) == 0
    assert capsys.readouterr().out.strip() == channel.render_prompts(SHARED_PROMPTS, cwd).strip()
    assert cli.main(["prompt", "no-such-prompt", "--cwd", cwd]) == 1
    assert capsys.readouterr().out.startswith("thimble: ")


def test_orient_skill_calls_the_start_orientation_tool_with_the_focus_as_its_brief():
    front, body = split(SKILL.read_text("utf-8"))
    assert front["name"] == "orient" and front["disable-model-invocation"] is True
    assert "focus" in str(front.get("argument-hint") or "")
    assert "`start_orientation`" in body and "$ARGUMENTS" in body
    assert not [ln for ln in body.splitlines() if ln.startswith("!`")], "the skill runs no command"


def test_every_worked_example_a_view_ticket_names_is_a_complete_viewer():
    """A view ticket (prompts/dev-view.md) tells the dev agent to read the worked example closest to its task, by
    folder name under plugin/viewers. Each one it names must be there with its three files: view.json, which normalizes
    to a view that accepts citations, a reader.py that compiles, and a view.html that marks anchors. The prompt states
    the contract of each file."""
    from app import views

    body = prompts.load("dev-view")
    for word in ("`data-anchor`", "`build_index(paths)`", "`records(index, query)`", "`resolve(index, locator)`",
                 "`thimble.fetch(query)`", "`thimble.onOpen(fn)`", "`thimble.navigate(ref)`", "`accepts`", "`declares`"):
        assert word in body, word
    examples = prompts.section("dev-view", "Start from an example")
    named = re.findall(r"^- `([a-z-]+)` ", examples, re.M) + re.findall(r"thimble also ships `([a-z-]+)`", examples)
    assert named, "the prompt names its worked examples"
    viewers = Path(views.EXAMPLES_DIR)
    for shape in named:
        d = viewers / shape
        assert d.is_dir(), f"prompts/dev-view.md names the example `{shape}`, which plugin/viewers does not hold"
        assert sorted(x.name for x in d.iterdir() if not x.name.startswith("__")) == ["reader.py", "view.html", "view.json"]
        compile((d / "reader.py").read_text("utf-8"), str(d / "reader.py"), "exec")
        v = views._normalize_view(shape, json.loads((d / "view.json").read_text("utf-8")), where=d)
        assert v["ok"] and v["accepts"] and v["name"], shape
        page = (d / "view.html").read_text("utf-8")
        assert "thimble.onOpen" in page and "data-anchor" in page, shape
