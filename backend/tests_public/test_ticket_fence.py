"""`thimble fix`'s session (app/dev.py), the one `claude -p` job thimble still starts, runs in the sandbox, writing only
its worktree and its commits. A code ticket's agent and view builds are subagents of main inside main's fence
(test_code_tickets.py, test_view_subagents.py, test_main_fence.py)."""
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


def test_the_fix_session_runs_in_the_sandbox_writing_its_worktree_and_its_commits(board, monkeypatch, tmp_path):
    """`thimble fix`'s Bash runs in the sandbox, with no network when the dev agent's is off. Beside its worktree it
    writes only what a commit there writes into the checkout's git folder: the objects, the ticket branch's ref and log,
    and the worktree's own git folder, so the git folder's hooks and config stay read-only. Nobody can answer it, so it
    keeps its own tools, gets no web tools and asks by no permission hook."""
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
    conf = dev.dev_config(None, sandbox=True)
    fence = dev.ticket_fence(wt, conf.network)
    box, common = fence["sandbox"], (repo / ".git").resolve()
    assert box["network"] == {"deniedDomains": ["*"]} and not box["allowUnsandboxedCommands"]
    assert box["filesystem"]["allowWrite"] == [str(common / "objects"), str(common / "refs" / "heads" / "dev"),
                                               str(common / "logs" / "refs" / "heads" / "dev"), str(common / "worktrees" / "7")]
    flags = dev.Sessions()._flags(None, "thimble fix", fence=fence)
    settings = json.loads(flags[flags.index("--settings") + 1])
    secret = {**box, "filesystem": {**box["filesystem"], "denyRead": userconf.private_paths()}}
    assert settings["sandbox"] == secret, "and it never reads server.json"
    assert "hooks" not in settings and flags[flags.index("--permission-mode") + 1] == "default"
    assert flags[flags.index("--allowedTools") + 1] == ",".join(dev.UNHOSTED_TOOLS)
    assert {"WebFetch", "WebSearch"} <= set(flags[flags.index("--disallowedTools") + 1].split(","))
    assert settings["env"]["THIMBLE_SESSION"] == dev.SESSION_KEY


def test_a_ticket_s_agent_is_told_its_worktree_its_folder_and_where_its_pictures_are(board, tmp_path):
    """A code ticket's agent's prompt names the ticket, its worktree and the agent's own folder beside it, and the
    picture before the change: in the box it takes no pictures of its own, and without the box it is told the
    validation stack's addresses. The ticket and its captured target are fenced as data."""
    t = {"id": "7", "n": 3, "title": "Bigger font", "body": "the labels are ```small```", "workspace": CORPUS,
         "target": {"selector": ".label"}}
    wt, work = tmp_path / "trees" / "7", tmp_path / "trees" / "7.work"
    boxed = dev.build_ticket_task(t, worktree=wt, work=work, before_shot="before.png", in_box=True)
    assert "ticket #3" in boxed and str(wt) in boxed and str(work) in boxed
    assert str(dev.shots_dir("7") / "before.png") in boxed and "take no pictures" in boxed
    assert "ticket (data):\n````\nthe labels are ```small```\n````" in boxed and "captured target (data)" in boxed
    staged = dev.build_ticket_task(t, worktree=wt, work=work, before_shot=None, in_box=False,
                                   stack={"ui": "http://127.0.0.1:5301", "api": "http://127.0.0.1:8301"})
    assert "http://127.0.0.1:5301" in staged and "none: thimble could not take one" in staged
    assert dev.ticket_work_dir("7").parent == dev.worktrees_dir()


def test_the_fix_session_runs_in_the_dev_row_s_fast_mode_and_subagents_take_none_from_it(board, monkeypatch):
    """`thimble fix` keeps the dev row's fast mode, on by default and off where thimble's config turns it off. A code
    ticket's agent and a view build take no fast mode from that row, since Claude Code gives a subagent none of its own
    (its agent definition has no such field): their registrations name only the model and the effort."""
    monkeypatch.setitem(userconf.DEFAULTS["sandbox"], "enforce", False)  # the flags below come with no fence

    def fast() -> object:
        flags = dev.Sessions()._flags(CORPUS, "thimble fix")
        return json.loads(flags[flags.index("--settings") + 1]).get("fastMode")

    assert config.models_for(CORPUS)["dev"]["fast"] is True and fast() is True
    userconf.global_file().parent.mkdir(parents=True, exist_ok=True)
    userconf.global_file().write_text(json.dumps({"agents": {"dev": {"fast": False}}}))
    assert fast() is False
    userconf.global_file().write_text(json.dumps({"agents": {"dev": {"fast": True}}}))
    assert fast() is True and "fast" not in config.chosen(CORPUS, "dev")
