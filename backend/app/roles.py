"""Which agent runs each of thimble's roles in a workspace: thimble's own, or what an active extension's
agents/<role>/agent.json gives. The roles are main, orientation, critic, writer and dev.

agent.json holds `description` and one of three ways:
  prompt   "prompt": "prompt.md", a Markdown file added to thimble's prompt for the role, or, with "replace": true, put
           in its place; `subagents` are Claude Code subagents ({name: {description, prompt: "<file>.md", tools?,
           model?, ...}}) the role's session gets with --agents, each named `<extension>-<name>`
  sdk      "sdk": "<program>.py", a Claude Agent SDK program whose `run(input)` harness.py calls
  command  "command": ["<program>", "<arg>", ...], any program, which harness.py starts and talks to in JSON lines
main takes prompt additions only. `model` and `effort` are defaults the analyst's config overrides.

A replacing prompt, an SDK program and a command each replace the role's agent. Additions combine: each is added under
its extension's name. When two active extensions replace the same role, thimble runs its own agent for it, and Settings
names both (`conflict`).

Placeholders in an extension's prompt: {{default}} is thimble's own prompt for the role and {{default#<heading>}} its
`## <heading>` section, {{dir}} the extension's folder, and {{files}} the files its views and card types cover here.

The prompt way works through the prompt files: prompt_file renders a role's replacement or additions into a file in
the workspace (PROMPTS_DIR), which userconf.prompt_files hands to prompts.custom, so every place that builds the role's
prompt reads it. Main's additions join its prompt in events.render_prompts. The orientation's prompt way is
extensions.py's: its prompt adds to the orientation's instructions or replaces them, and its subagents join the
orientation's session (extensions.agent_definitions), so prompt_text and subagents leave it out.
"""
from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import config

log = logging.getLogger("thimble.roles")

ROLES = ("main", "orientation", "critic", "writer", "dev")
SESSION_ROLES = ROLES[1:]
WAYS = ("prompt", "sdk", "command")
CODE_WAYS = ("sdk", "command")
AGENT_JSON = "agent.json"
FIELDS = ("description", "prompt", "replace", "subagents", "sdk", "command", "model", "effort", "tools",
          "disallowedTools")
# a subagent's fields, as extension.schema.json takes them; mcpServers reaches a session by server names only, since
# a server given whole would start outside the session's sandbox
SUBAGENT_FIELDS = ("description", "prompt", "tools", "disallowedTools", "model", "effort", "mcpServers", "maxTurns",
                   "skills", "color")
NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,39}$")
# the prompt file under prompts/ each role's prompt is built from (userconf.PROMPT_FILES); main's is main.md
PROMPT_FILES = {"main": "main", "orientation": "orient", "critic": "critic", "writer": "writer", "dev": "dev"}
PROMPTS_DIR = "agents"  # in the workspace: each role's prompt as its extensions change it (prompt_file)
PROMPT_ELSEWHERE = ("main", "orientation")  # whose prompt way events.py and extensions.py apply (module note)
FRONT_RE = re.compile(r"\A---\n.*?\n---\n", re.S)
ADDED_HEADING = "## From the {name} extension"


@dataclass
class Part:
    """One extension's agent.json for one role."""

    extension: str
    role: str
    folder: Path  # agents/<role>/ in the extension's folder
    root: Path  # the extension's folder
    spec: dict[str, Any]
    files: list[str] = field(default_factory=list)  # what its views and card types cover in the workspace
    problems: list[str] = field(default_factory=list)

    @property
    def way(self) -> str:
        return next((w for w in WAYS if self.spec.get(w) is not None), "prompt")

    @property
    def replaces(self) -> bool:
        return self.way in CODE_WAYS or self.spec.get("replace") is True

    @property
    def description(self) -> str:
        return str(self.spec.get("description") or "").strip()

    def path(self, rel: Any) -> Path | None:
        """`rel`, a file named in agent.json, as a path inside the extension's folder; None when it leaves it."""
        if not isinstance(rel, str) or not rel.strip():
            return None
        p = (self.folder / rel.strip()).resolve()
        try:
            p.relative_to(self.root.resolve())
        except ValueError:
            return None
        return p


def problems(spec: Any, role: str, folder: Path, root: Path) -> list[str]:
    """What is wrong with an agent.json for `role` in `folder`, each naming the field."""
    if not isinstance(spec, dict):
        return [f"agents/{role}/{AGENT_JSON} must hold one JSON object"]
    out: list[str] = []
    where = f"agents/{role}/{AGENT_JSON}"
    for k in spec:
        if k not in FIELDS:
            near = next((f for f in FIELDS if f.lower().startswith(str(k).lower()[:3])), "")
            out.append(f"{where}: unknown key {k!r}" + (f". Did you mean {near!r}?" if near else ""))
    ways = [w for w in WAYS if spec.get(w) is not None]
    if len(ways) != 1:
        out.append(f"{where}: name exactly one of prompt, sdk or command")
        return out
    way = ways[0]
    part = Part("", role, folder, root, spec)
    if role == "main" and (way != "prompt" or spec.get("replace") is True or spec.get("subagents")):
        out.append(f"{where}: main takes prompt additions only")
    if way == "command":
        cmd = spec["command"]
        if not isinstance(cmd, list) or not cmd or not all(isinstance(a, str) and a for a in cmd):
            out.append(f"{where}: command must be a list of strings, such as [\"python\", \"orient.py\"]")
    else:
        p = part.path(spec[way])
        if p is None or not p.is_file():
            out.append(f"{where}: {way} names {spec[way]!r}, which is not a file in the extension's folder")
        elif way == "sdk" and p.suffix != ".py":
            out.append(f"{where}: sdk names a Python program, a .py file")
    if "replace" in spec and not isinstance(spec["replace"], bool):
        out.append(f"{where}: replace takes true or false")
    subs = spec.get("subagents")
    if subs is not None:
        if way != "prompt" or not isinstance(subs, dict):
            out.append(f"{where}: subagents is an object of Claude Code subagents, for the prompt way")
        else:
            for name, sub in subs.items():
                if not NAME_RE.match(str(name)) or not isinstance(sub, dict):
                    out.append(f"{where}: subagent {name!r} needs a lower-case name and an object")
                    continue
                if bad := [k for k in sub if k not in SUBAGENT_FIELDS]:
                    out.append(f"{where}: subagent {name!r} has unknown keys {', '.join(map(repr, bad))}")
                sp = part.path(sub.get("prompt"))
                if sp is None or not sp.is_file():
                    out.append(f"{where}: subagent {name!r} names a prompt file that is not in the extension's folder")
    for k in ("tools", "disallowedTools"):
        if k in spec and not (isinstance(spec[k], list) and all(isinstance(t, str) for t in spec[k])):
            out.append(f"{where}: {k} must be a list of tool names")
    return out


def read_part(name: str, root: Path, role: str, files: list[str] | None = None) -> Part | None:
    """The agent.json of `role` in the extension `name` at `root`; None when it has none."""
    folder = root / "agents" / role
    p = folder / AGENT_JSON
    if not p.is_file():
        return None
    try:
        spec = json.loads(p.read_text("utf-8"))
    except (OSError, ValueError) as e:
        return Part(name, role, folder, root, {}, problems=[f"agents/{role}/{AGENT_JSON} does not parse: {e}"])
    return Part(name, role, folder, root, spec if isinstance(spec, dict) else {}, list(files or []),
                problems(spec, role, folder, root))


def parts(c: str | None, role: str) -> list[Part]:
    """The agent.json of `role` of each active extension in workspace `c` that has one and no problem in it."""
    if not c:
        return []
    from . import extensions  # noqa: PLC0415 — extensions imports the views module

    out: list[Part] = []
    for e in extensions.active(c):
        files = [str(x) for x in e.get("files") or [] if isinstance(x, str)]
        part = read_part(str(e["name"]), Path(str(e["src"])), role, files)
        if part is None:
            continue
        if part.problems:
            log.warning("%s: %s's %s agent is not used: %s", c, part.extension, role, "; ".join(part.problems))
            continue
        out.append(part)
    return out


@dataclass
class RoleAgent:
    """Who runs one role in a workspace: `way` is `thimble`, `prompt` (an extension's prompt in place of thimble's),
    `sdk` or `command`; `additions` add to the prompt either way; `conflict` names the extensions that both replace the
    role, in which case thimble's own agent runs."""

    role: str
    way: str = "thimble"
    replacing: Part | None = None
    additions: list[Part] = field(default_factory=list)
    conflict: list[str] = field(default_factory=list)

    @property
    def extension(self) -> str:
        return self.replacing.extension if self.replacing is not None else ""

    @property
    def code(self) -> bool:
        return self.way in CODE_WAYS


def agent_for(c: str | None, role: str) -> RoleAgent:
    if role not in ROLES:
        raise ValueError(f"no role {role!r}; one of {', '.join(ROLES)}")
    found = parts(c, role)
    replacing = [p for p in found if p.replaces]
    additions = [p for p in found if not p.replaces]
    out = RoleAgent(role, additions=additions)
    if len(replacing) > 1:
        out.conflict = [p.extension for p in replacing]
    elif replacing:
        out.replacing, out.way = replacing[0], replacing[0].way
    return out


# --------------------------------------------------------------------------- the prompt way


PLACEHOLDER_RE = re.compile(r"\{\{default(?:#([^}\n]+))?\}\}|\{\{dir\}\}|\{\{files\}\}")
SLOT_RE = re.compile(r"\{\{([a-z_][a-z0-9_]*)\}\}")


def _literal(text: str) -> str:
    """`text` with its double braces taken apart, so prompts.render reads none of it as a slot."""
    return text.replace("{{", "{ {").replace("}}", "} }")


def _keep_slots(text: str, slots: set[str]) -> str:
    """`text` with each `{{slot}}` of `slots` kept for prompts.render to fill and every other double brace literal."""
    out, at = [], 0
    for m in SLOT_RE.finditer(text):
        out += [_literal(text[at:m.start()]), m.group(0) if m.group(1) in slots else _literal(m.group(0))]
        at = m.end()
    return "".join([*out, _literal(text[at:])])


def _fill(text: str, part: Part, default: str, role: str, slots: set[str] | None = None) -> str:
    """An extension's prompt text with its placeholders filled (module note). With `slots`, the text goes into one of
    thimble's prompt files: the slots of the role's own file stay for prompts.render, every other double brace of the
    extension's text is literal, and thimble's own text keeps its slots. Without, the text is sent as it is."""
    from . import prompts  # noqa: PLC0415

    def value(m: re.Match[str]) -> str:
        token = m.group(0)
        if token == "{{dir}}":
            return str(part.root)
        if token == "{{files}}":
            return ", ".join(f"`{x}`" for x in part.files) or "(none)"
        heading = (m.group(1) or "").strip()
        if not heading:
            return default
        try:
            return prompts.section(PROMPT_FILES[role], heading).strip()
        except prompts.PromptError:
            log.warning("%s's %s prompt names {{default#%s}}, which thimble's prompt has no section for",
                        part.extension, role, heading)
            return ""

    out, at = [], 0
    for m in PLACEHOLDER_RE.finditer(text):
        got = value(m)
        own = text[at:m.start()]
        if slots is None:
            out += [own, got]
        else:
            thimbles = m.group(0).startswith("{{default")
            out += [_keep_slots(own, slots), got if thimbles else _literal(got)]
        at = m.end()
    rest = text[at:]
    return "".join([*out, rest if slots is None else _keep_slots(rest, slots)])


def _body(part: Part, rel: Any) -> str:
    p = part.path(rel)
    try:
        return p.read_text("utf-8").strip() if p is not None else ""
    except OSError:
        return ""


def _default_text(role: str) -> tuple[str, str]:
    """(frontmatter, body) of thimble's own prompt file for `role`, includes pasted in and slots left in place."""
    from . import prompts  # noqa: PLC0415

    text = prompts.load(PROMPT_FILES[role])
    m = FRONT_RE.match(text)
    return (m.group(0), text[m.end():].strip()) if m else ("", text.strip())


def additions_text(agent: RoleAgent, default: str = "", slots: set[str] | None = None) -> str:
    """The additions of `agent`, each under its extension's name, placeholders filled as _fill fills them."""
    out = []
    for part in agent.additions:
        body = _fill(_body(part, part.spec.get("prompt")), part, default, agent.role, slots)
        if body:
            out.append(f"{ADDED_HEADING.format(name=part.extension)}\n\n{body}")
    return "\n\n".join(out)


def prompt_text(c: str | None, role: str) -> str | None:
    """The text of the prompt file `role` runs with in workspace `c` when its extensions change it: thimble's file
    with an extension's replacement in place of its body and the additions after it; None when no extension changes
    it, or when an SDK program or a command runs the role."""
    if role in PROMPT_ELSEWHERE:
        return None
    agent = agent_for(c, role)
    if agent.code or (agent.replacing is None and not agent.additions):
        return None
    front, default = _default_text(role)
    slots = set(SLOT_RE.findall(default))
    body = default
    if agent.replacing is not None:
        own = _body(agent.replacing, agent.replacing.spec.get("prompt"))
        body = _fill(own, agent.replacing, default, role, slots) if own else default
    added = additions_text(agent, default, slots)
    if added:
        body = f"{body}\n\n{added}"
    return f"{front}{body}\n"


def prompt_file(c: str | None, role: str) -> Path | None:
    """prompt_text written to the workspace's PROMPTS_DIR, as userconf.prompt_files hands it on; None when it is
    None."""
    text = prompt_text(c, role)
    if text is None or not c:
        return None
    folder = config.workspace_dir(c) / PROMPTS_DIR
    folder.mkdir(parents=True, exist_ok=True)
    p = folder / f"{PROMPT_FILES[role]}.md"
    if not p.is_file() or p.read_text("utf-8") != text:
        p.write_text(text, "utf-8")
    return p


def main_additions(c: str | None) -> str:
    """The additions to main's prompt of the active extensions in workspace `c`."""
    if not c:
        return ""
    return additions_text(agent_for(c, "main"))


def subagents(c: str | None, role: str) -> dict[str, dict[str, Any]]:
    """The subagents the extensions give `role`'s session, as `--agents` takes them, each named
    `<extension>-<name>`, with its prompt file read."""
    if role in PROMPT_ELSEWHERE:
        return {}
    agent = agent_for(c, role)
    found = ([agent.replacing] if agent.replacing is not None and agent.way == "prompt" else []) + agent.additions
    out: dict[str, dict[str, Any]] = {}
    for part in found:
        for name, sub in (part.spec.get("subagents") or {}).items():
            prompt = _fill(_body(part, sub.get("prompt")), part, "", role)
            entry = {k: v for k, v in sub.items() if k in SUBAGENT_FIELDS and k not in ("prompt", "mcpServers")}
            names = [n for n in sub.get("mcpServers") or [] if isinstance(n, str)] \
                if isinstance(sub.get("mcpServers"), list) else []
            if names:
                entry["mcpServers"] = names
            entry["prompt"] = prompt
            entry.setdefault("description", name)
            out[f"{part.extension}-{name}"] = entry
    return out


def public(c: str | None) -> list[dict[str, Any]]:
    """The Settings rows of the roles: each one's agent (`thimble`, or the extension and its way), what its description
    says, the extensions that add to its prompt, and a conflict."""
    rows = []
    for role in ROLES:
        a = agent_for(c, role)
        rows.append({"role": role, "way": a.way, "extension": a.extension,
                     "description": a.replacing.description if a.replacing is not None else "",
                     "additions": [p.extension for p in a.additions], "conflict": a.conflict})
    return rows
