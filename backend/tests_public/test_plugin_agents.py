"""The plugin's contract with Claude Code: the /thimble skill pre-approves only the commands it injects."""
from __future__ import annotations

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
    assert [r for r in rules if r.startswith(cli + " ")] == [f"{cli} prompt *", f"{cli} server up *"]
    injected = [ln[2:].split("`")[0] for ln in body.splitlines() if ln.startswith("!`")]
    assert injected and all(any(c.startswith(r[:-1]) for r in rules if r.endswith(" *")) for c in injected), injected
