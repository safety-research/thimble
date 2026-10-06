"""A code ticket's session (app/dev.py) runs in the sandbox, writing only its worktree and its commits. View builds
are subagents of main inside main's fence (test_view_subagents.py)."""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

from app import config, dev, userconf

CORPUS = "boards"


@pytest.fixture()
def board(tmp_path, monkeypatch, workspaces_tmp) -> Path:
    d = tmp_path / "data"
    corpus = d / CORPUS
    corpus.mkdir(parents=True)
    (corpus / "manifest.json").write_text(json.dumps({"name": CORPUS, "description": "a message board"}))
    (corpus / "board.jsonl").write_text("".join(json.dumps({"body": b}) + "\n" for b in ("first post", "second post")))
    monkeypatch.setattr(config, "DATA_DIR", d.resolve())
    return corpus


def test_a_code_ticket_s_session_runs_in_the_sandbox_writing_its_worktree_and_its_commits(board, monkeypatch, tmp_path):
    """A code ticket's Bash runs in the sandbox, with no network when the dev agent's is off. Beside its worktree it
    writes only what a commit there
    writes into the checkout's git folder: the objects, the ticket branch's ref and log, and the worktree's own git
    folder, so the git folder's hooks and config stay read-only. It cannot reach the stack, so its prompt asks for no
    shots."""
    monkeypatch.setenv("THIMBLE_SANDBOX", "1")
    repo, wt = tmp_path / "repo", tmp_path / "wt" / "7"
    repo.mkdir()

    def git(*args: str) -> None:
        subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", *args], cwd=repo, check=True,
                       capture_output=True)

    git("init", "-q")
    (repo / "a.txt").write_text("a")
    git("add", "a.txt")
    git("commit", "-qm", "a")
    git("worktree", "add", "-q", "-b", "dev/7", str(wt))
    userconf.global_file().parent.mkdir(parents=True, exist_ok=True)
    userconf.global_file().write_text(json.dumps({"agents": {"dev": {"network": "off"}}}))
    conf = dev.dev_config(CORPUS, sandbox=True)
    fence = dev.ticket_fence(wt, conf.network)
    box, common = fence["sandbox"], (repo / ".git").resolve()
    assert box["network"] == {"deniedDomains": ["*"]} and not box["allowUnsandboxedCommands"]
    assert box["filesystem"]["allowWrite"] == [str(common / "objects"), str(common / "refs" / "heads" / "dev"),
                                               str(common / "logs" / "refs" / "heads" / "dev"), str(common / "worktrees" / "7")]
    flags = dev.Sessions()._flags(CORPUS, "thimble ticket 7: x", fence=fence, asking={"key": "ticket:7", "config": conf})
    secret = {**box, "filesystem": {**box["filesystem"], "denyRead": userconf.private_paths()}}
    assert json.loads(flags[flags.index("--settings") + 1])["sandbox"] == secret, "and it never reads server.json"
    t = {"id": "7", "title": "x", "body": "y", "workspace": CORPUS}
    boxed = dev.build_prompt(t, worktree=wt, ui_url="u", api_url="a", before_shot=None, sandboxed=True)
    assert dev.TICKET_STACK_LINES[True].split(":")[0] in boxed and "ui_shot" not in boxed
    assert "ui_shot" in dev.build_prompt(t, worktree=wt, ui_url="u", api_url="a", before_shot=None)

