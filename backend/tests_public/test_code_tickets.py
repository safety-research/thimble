"""A code ticket (app/dev.py) starts only on the analyst's Allow, since thimble runs its edited code outside the sandbox,
and the server's git commands in its worktree run hardened."""
from __future__ import annotations

import asyncio
import subprocess
from pathlib import Path

import pytest

from app import agent_session, agents, dev, ledger, modes

CORPUS = "mini"


@pytest.fixture(autouse=True)
def _fresh(workspaces_tmp):
    agent_session._hosted.clear()
    yield
    agent_session._hosted.clear()


async def _question(chat: str) -> dict:
    for _ in range(300):
        live = [p for p in agents.read_meta(CORPUS, chat).get("permissions") or [] if not p.get("expired")]
        if live:
            return live[0]
        await asyncio.sleep(0.01)
    raise AssertionError("no question on the card")


async def test_a_code_ticket_asks_the_analyst_in_every_mode_and_a_no_stops_it_before_its_worktree(monkeypatch):
    """The question waits on the ticket's card in Bypass too, in plain words with thimble's reason; Allow lets the
    ticket go on, anything else stops it, and a ticket with no workspace, which nobody can be asked about, never
    starts."""
    ledger.put_settings(CORPUS, {modes.SETTING: {"dev": "bypass"}})
    t = dev.file_ticket(CORPUS, "Fix the chart", "the bars are cut off", start=False)
    run = agent_session.host(CORPUS, dev.ticket_key(t["id"]), t["chat"], agent="dev", wait_s=10)
    assert run.mode == "bypass"
    allowed = asyncio.ensure_future(dev._code_refusal(t))
    q = await _question(t["chat"])
    assert (q["tool"], q["what"]) == (dev.CODE_TOOL, dev.CODE_QUESTION) and "every permission mode" in q["why"]
    assert not allowed.done()
    assert agent_session.answer(CORPUS, t["chat"], q["id"], True)
    assert await allowed == ""
    denied = asyncio.ensure_future(dev._code_refusal(t))
    assert agent_session.answer(CORPUS, t["chat"], (await _question(t["chat"]))["id"], False)
    assert await denied == dev.CODE_NOT_ALLOWED
    assert await dev._code_refusal({**t, "workspace": None}) == dev.CODE_NOBODY

    async def no(_t):
        return dev.CODE_NOT_ALLOWED

    def never(*_a, **_k):
        raise AssertionError("a worktree for a ticket the analyst did not allow")

    async def nothing(*_a, **_k):
        return None

    monkeypatch.setattr(dev, "runner_problem", lambda **_k: "")
    monkeypatch.setattr(dev, "_code_refusal", no)
    monkeypatch.setattr(dev, "create_worktree", never)
    monkeypatch.setattr(dev, "stop_stack", nothing)
    rec = await dev._run_ticket(t, dev.Run(ticket_id=t["id"], title=t["title"], ts_start=""))
    assert (rec["status"], rec["error"]) == ("stopped", dev.CODE_NOT_ALLOWED)


def test_the_server_runs_no_git_in_a_worktree_that_points_elsewhere(monkeypatch, tmp_path):
    """The session can write its worktree and the worktree's own git folder. The server's git commands there run with
    no fsmonitor and no hooks, and not at all once `.git` or the git folder's commondir names another git folder, whose
    config could run a command."""
    repo, marker = tmp_path / "repo", tmp_path / "ran-outside"
    repo.mkdir()

    def git(cwd: Path, *args: str) -> None:
        subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "core.hooksPath=/dev/null",
                        *args], cwd=cwd, check=True, capture_output=True)

    git(repo, "init", "-q")
    (repo / "a.txt").write_text("a")
    git(repo, "add", "a.txt")
    git(repo, "commit", "-qm", "a")
    monkeypatch.setattr(dev, "REPO", repo)
    wt, _branch, _base = dev.create_worktree("t9")
    assert dev._git_argv(wt, ("status",))[1:5] == list(dev.WORKTREE_GIT) and dev._git_argv(repo, ("status",)) == ["git", "status"]
    assert dev.touched_files(wt) == []
    pointer = (wt / ".git").read_text()
    evil = wt / ".evil"
    git(wt, "init", "-q", "--bare", str(evil))
    git(evil, "config", "core.fsmonitor", f"touch {marker}; false")
    git(evil, "config", "core.worktree", str(wt))
    (wt / ".git").write_text(f"gitdir: {evil}\n")
    with pytest.raises(dev.GitError, match="no longer points"):
        dev.touched_files(wt)
    (wt / ".git").write_text(pointer)
    own = Path(pointer.removeprefix("gitdir: ").strip())
    (own / "commondir").write_text(str(evil))
    with pytest.raises(dev.GitError, match="another commondir"):
        dev.branch_files(wt, "HEAD")
    assert not marker.exists()
