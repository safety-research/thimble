"""The plugin's contract with Claude Code: the /thimble skill pre-approves only the commands it injects, and the shared
skill's command writes nothing outside $TMPDIR."""
from __future__ import annotations

import os
import re
import subprocess
from pathlib import Path

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


def _files(*roots: Path, skip: Path | None = None) -> dict[str, tuple[int, int]]:
    """Every file under `roots` with its (mtime_ns, size), leaving out `skip` and Python's bytecode caches, which Python
    writes only where it can and leaves out silently in the sandbox, whose tree is read-only."""
    out: dict[str, tuple[int, int]] = {}
    for root in roots:
        for p in root.rglob("*"):
            if "__pycache__" in p.parts or (skip is not None and (p == skip or skip in p.parents)) or not p.is_file():
                continue
            st = p.stat()
            out[str(p)] = (st.st_mtime_ns, st.st_size)
    return out


def test_the_shared_skill_s_command_writes_nothing_outside_tmpdir(tmp_path, mini_dir, monkeypatch):
    """thimble's critic and writers load thimble:shared (skills: ["thimble:shared"]). Its `!` command runs in main's
    sandbox, where only $TMPDIR and the agents' work folders are writable (spike U3), so it writes nothing else: not
    thimble's home, the workspace, the corpus, Claude Code's config, the home folder or thimble's own tree. The command
    runs as the skill spells it, once Claude Code has put in the plugin root and the project folder, in a workspace the
    server made already, as a critic's or a writer's is."""
    monkeypatch.setattr(config, "WORKSPACES_DIR", tmp_path / "ws")
    config.workspace_dir(mini_dir.name)  # what the server makes when the workspace opens, the files the hooks trust among them
    front, body = split((PLUGIN / "skills" / "shared" / "SKILL.md").read_text("utf-8"))
    injected = [ln[2:].split("`")[0] for ln in body.splitlines() if ln.startswith("!`")]
    assert len(injected) == 1 and "prompt preamble shared" in injected[0], injected
    command = injected[0].replace("${CLAUDE_PLUGIN_ROOT}", str(PLUGIN)).replace("${CLAUDE_PROJECT_DIR}", str(mini_dir))
    rules = re.findall(r"Bash\(([^)]*)\)", front["allowed-tools"])
    assert any(injected[0].startswith(r[:-1]) for r in rules if r.endswith(" *")), (rules, injected)
    home, scratch = tmp_path / "home", tmp_path / "tmpdir"
    for d in (home / ".claude", scratch, tmp_path / "thimble-home"):
        d.mkdir(parents=True)
    env = {"PATH": os.environ["PATH"], "HOME": str(home), "TMPDIR": str(scratch),
           "CLAUDE_CONFIG_DIR": str(home / ".claude"), "THIMBLE_HOME": str(tmp_path / "thimble-home"),
           "THIMBLE_WORKSPACES_DIR": str(tmp_path / "ws"), "THIMBLE_DATA_DIR": os.environ["THIMBLE_DATA_DIR"],
           "THIMBLE_SKIP_KEY": "1"}
    roots = (tmp_path, mini_dir.parent, PLUGIN, config.REPO_ROOT / "prompts", config.REPO_ROOT / "backend" / "app")
    before = _files(*roots, skip=scratch)
    done = subprocess.run(["bash", "-c", command], env=env, cwd=mini_dir, capture_output=True, text=True, timeout=120)
    assert done.returncode == 0 and "thimble" in done.stdout, (done.stdout[-2000:], done.stderr[-2000:])
    after = _files(*roots, skip=scratch)
    changed = sorted(p for p in set(before) | set(after) if before.get(p) != after.get(p))
    assert not changed, f"the shared skill's command wrote outside $TMPDIR: {changed}"
