"""Code tickets in every install (dev.py): a tree that is a git repository runs them, a release install with its git
baseline too, even without the validation stack's tools; a change to the browser UI there fails its gate with the easy
fix, and the backend's gates still run."""
from __future__ import annotations

import subprocess
from pathlib import Path

from app import dev, subagents


def _git_tree(tmp_path: Path) -> Path:
    """A release-like install: the tree committed as one baseline, with no frontend/node_modules and no
    scripts/dev/dev_stack.sh."""
    tree = tmp_path / "app"
    (tree / "backend" / "app").mkdir(parents=True)
    (tree / "frontend" / "src").mkdir(parents=True)
    (tree / "prompts").mkdir()
    (tree / "README.md").write_text("thimble\n")
    (tree / "prompts" / "note.md").write_text("A note.\n")
    (tree / "frontend" / "src" / "a.ts").write_text("export const a = 1\n")
    run = ["git", "-c", "user.name=thimble", "-c", "user.email=thimble@localhost", "-c", "core.hooksPath=/dev/null"]
    subprocess.run([*run, "init", "-q"], cwd=tree, check=True)
    subprocess.run([*run, "add", "."], cwd=tree, check=True)
    subprocess.run([*run, "commit", "-q", "-m", "thimble 0.9.0"], cwd=tree, check=True)
    return tree


def test_a_git_tree_without_the_validation_stack_runs_code_tickets(tmp_path, monkeypatch, workspaces_tmp):
    tree = _git_tree(tmp_path)
    monkeypatch.setattr(dev, "REPO", tree)
    monkeypatch.setattr(dev, "STACK_ENABLED", True)
    assert not (tree / "frontend" / "node_modules").exists() and not dev.stack_script().is_file()
    assert dev.ticket_problem() == "" and dev.tickets_run_here()
    monkeypatch.setattr(dev, "REPO", tmp_path / "no-git")
    assert dev.ticket_problem() == dev.RELEASE_LINE and "`thimble update`" in dev.RELEASE_LINE
    assert "development install" not in dev.RELEASE_LINE


async def test_a_frontend_change_fails_with_the_easy_fix_and_the_other_gates_run(tmp_path, monkeypatch):
    tree = _git_tree(tmp_path)
    got = await dev.run_gates(tree, ["frontend/src/a.ts"])
    assert not got["ok"]
    assert got["steps"] == [{"name": "tsc", "ok": False, "tail": dev.FRONTEND_FIX}]
    assert dev.FRONTEND_FIX == ("This install cannot rebuild the browser UI. Install thimble from a git clone to change "
                                "the UI.")
    # a prompt-only change runs its own gate (no frontend step)
    got = await dev.run_gates(tree, ["README.md"])
    assert got == {"ok": True, "steps": []}


def test_the_ticket_agent_registers_where_tickets_run(tmp_path, monkeypatch, workspaces_tmp):
    from app import config

    config.workspace_dir("mini")
    tree = _git_tree(tmp_path)
    monkeypatch.setattr(dev, "REPO", tree)
    monkeypatch.setattr(dev, "STACK_ENABLED", True)
    assert subagents.TYPES["dev-ticket"].when == "app.dev:tickets_run_here"
    assert dev.tickets_run_here("mini")
