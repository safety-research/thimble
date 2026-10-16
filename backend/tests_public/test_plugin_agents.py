"""The plugin's contract with Claude Code: the /thimble skill pre-approves only the commands it injects and has Claude
read the whole prompt Claude Code shows only the start of."""
from __future__ import annotations

import json
import re

import yaml

from app import config

PLUGIN = config.REPO_ROOT / "plugin"


def split(text: str) -> tuple[dict, str]:
    """(frontmatter, body) of an agent or skill file; the frontmatter must open on the first line."""
    assert text.startswith("---\n"), "the frontmatter must be the file's first line"
    head, _, body = text[4:].partition("\n---\n")
    front = yaml.safe_load(head)
    assert isinstance(front, dict), head
    return front, body


def test_the_thimble_skill_pre_approves_only_the_commands_it_injects():
    """/thimble's allowed-tools let its two injected commands run without a prompt, and no other thimble subcommand
    (`update --from`, `uninstall --yes`)."""
    front, body = split((PLUGIN / "skills" / "thimble" / "SKILL.md").read_text("utf-8"))
    rules = re.findall(r"Bash\(([^)]*)\)", front["allowed-tools"])
    cli = "${CLAUDE_PLUGIN_ROOT}/bin/thimble"
    assert [r for r in rules if r.startswith(cli + " ")] == [f"{cli} activate *", f"{cli} guide *", f"{cli} server up *"]
    injected = [ln[2:].split("`")[0] for ln in body.splitlines() if ln.startswith("!`")]
    assert injected and all(any(c.startswith(r[:-1]) for r in rules if r.endswith(" *")) for c in injected), injected


def test_the_thimble_skill_has_claude_read_the_whole_prompt_when_claude_code_shows_only_its_start():
    """In a plain `claude` session Claude Code shows only the start of the long prompt /thimble prints and saves all of
    it to a file it names. /thimble's skill then tells Claude to Read that file, in the words of the clear/compact
    hook's lead (plugin/hooks/hooks.json)."""
    sentence = ("When Claude Code shows only the start of it and names a file that holds all of it, Read that file "
                "before you reply to anything.")
    _, body = split((PLUGIN / "skills" / "thimble" / "SKILL.md").read_text("utf-8"))
    [para] = [p for p in body.split("\n\n") if p.startswith("When this message holds thimble's guidance")]
    assert para.endswith("It does not change your reply to this command. " + sentence), para
    hooks = json.loads((PLUGIN / "hooks" / "hooks.json").read_text("utf-8"))
    commands = [h["command"] for group in hooks["hooks"]["SessionStart"] if "compact" in group.get("matcher", "").split("|")
                for h in group["hooks"]]
    assert commands and all(sentence in c for c in commands), commands
