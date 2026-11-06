"""A code ticket's box and worktree are security boundaries (app/ticket_box.py, app/dev.py): code a ticket edited, run
in its box, reads no home folder, writes only its worktree and reaches no network, and the server runs no git command
and removes nothing where a link or a planted git folder leads."""
from __future__ import annotations

import asyncio
import json
import shutil
import socket
import subprocess
import sys
from pathlib import Path

import pytest

from app import dev, ticket_box

BACKEND = Path(__file__).resolve().parent.parent


@pytest.fixture(autouse=True)
def _fresh(workspaces_tmp, monkeypatch):
    monkeypatch.setattr(dev, "_current", None)
    yield


def _git(cwd: Path, *args: str) -> str:
    return subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "core.hooksPath=/dev/null",
                           *args], cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()


def _repo(tmp_path: Path) -> Path:
    """A checkout like thimble's: its .gitignore names the venv and node_modules folders (the latter as a folder, which
    the worktree's link to it is not), and both are there for a worktree to link to."""
    repo = tmp_path / "repo"
    repo.mkdir()
    _git(repo, "init", "-q", "-b", "main")
    (repo / "README.md").write_text("a\n")
    (repo / ".gitignore").write_text("backend/.venv\nfrontend/node_modules/\n")
    (repo / "backend" / ".venv").mkdir(parents=True)
    (repo / "frontend" / "node_modules").mkdir(parents=True)
    _git(repo, "add", "README.md", ".gitignore")
    _git(repo, "commit", "-qm", "a")
    return repo


def test_the_box_reads_nothing_its_worktree_s_links_point_to(tmp_path):
    """The session can change its worktree's links to the live venv and node_modules: what the box may read is taken
    from the live checkout, and nothing runs in the box once a link leads elsewhere."""
    live, tree, elsewhere = tmp_path / "live", tmp_path / "tree", tmp_path / "elsewhere"
    for d in (live / "backend" / ".venv", live / "frontend" / "node_modules", tree / "backend", tree / "frontend",
              elsewhere):
        d.mkdir(parents=True)
    (tree / "backend" / ".venv").symlink_to(live / "backend" / ".venv")
    (tree / "frontend" / "node_modules").symlink_to(elsewhere)
    box = ticket_box.Box(tree, tmp_path / "cache", tmp_path / "srt", live=live)
    reads = box.settings()["filesystem"]["allowRead"]
    assert str(live / "frontend" / "node_modules") in reads and not any(r.startswith(str(elsewhere)) for r in reads)
    assert asyncio.run(ticket_box.run(box, ["true"], cwd=tree, timeout=5)) == (
        -1, ticket_box.LINK_MOVED.format(link="frontend/node_modules"))


def test_the_server_runs_no_git_in_a_worktree_that_points_elsewhere(monkeypatch, tmp_path):
    """The session can write its worktree and the worktree's own git folder. The server's git commands there run with
    no fsmonitor and no hooks, name the git folders themselves, and don't run at all once `.git` or the git folder's
    commondir names another git folder, whose config could run a command."""
    repo, marker = _repo(tmp_path), tmp_path / "ran-outside"
    monkeypatch.setattr(dev, "REPO", repo)
    wt, _branch, _base = dev.create_worktree("t9")
    pointer = (wt / ".git").read_text()
    own = Path(pointer.removeprefix("gitdir: ").strip())
    (own / "config.worktree").write_text("")  # what Claude Code's sandbox leaves there
    assert dev.touched_files(wt) == []
    (own / "config.worktree").write_text(f"[core]\n\tfsmonitor = touch {marker}; false\n")
    with pytest.raises(dev.GitError, match="a config of its own"):
        dev.touched_files(wt)
    (own / "config.worktree").unlink()
    evil = wt / ".evil"
    _git(wt, "init", "-q", "--bare", str(evil))
    _git(evil, "config", "core.fsmonitor", f"touch {marker}; false")
    _git(evil, "config", "core.worktree", str(wt))
    (wt / ".git").write_text(f"gitdir: {evil}\n")
    with pytest.raises(dev.GitError, match="no longer points"):
        dev.touched_files(wt)
    (wt / ".git").write_text(pointer)
    (own / "commondir").write_text(str(evil))
    with pytest.raises(dev.GitError, match="another commondir"):
        dev.branch_files(wt, "HEAD")
    assert not marker.exists()


def test_a_link_in_place_of_a_worktree_leads_no_git_command_or_removal_elsewhere(monkeypatch, tmp_path):
    """Main's fence lets main's Bash and its subagents write the folder of the tickets' worktrees, so an agent can put a
    link there in place of its worktree. The server then runs no git command where the link leads (the live checkout,
    where a commit, a reset and a clean would change the analyst's work), its box runs nothing, and removing the
    ticket's worktree removes the link alone, never another worktree of the live checkout it leads to."""
    repo = _repo(tmp_path)
    monkeypatch.setattr(dev, "REPO", repo)
    (repo / "mine.txt").write_text("the analyst's work in progress\n")
    other = tmp_path / "other-worktree"
    _git(repo, "worktree", "add", "-q", "-b", "other", str(other))
    (other / "draft.txt").write_text("not committed\n")
    head = _git(repo, "rev-parse", "HEAD")
    wt, _branch, _base = dev.create_worktree("t8")
    shutil.rmtree(wt)
    wt.symlink_to(repo)
    for git_call in (lambda: dev.touched_files(wt), lambda: dev.commit_worktree(wt, "t8"),
                     lambda: dev.reset_worktree(wt, head)):
        with pytest.raises(dev.GitError, match="a link"):
            git_call()
    assert _git(repo, "rev-parse", "HEAD") == head and (repo / "mine.txt").exists()
    assert _git(repo, "status", "--porcelain") == "?? mine.txt", "nothing was staged or committed in the live checkout"
    box = ticket_box.Box(wt, tmp_path / "cache", tmp_path / "srt", live=repo)
    assert asyncio.run(ticket_box.run(box, ["true"], cwd=wt, timeout=5)) == (-1, ticket_box.TREE_LINKED)
    wt.unlink()
    wt.symlink_to(other)
    dev.remove_worktree(wt)
    assert not wt.is_symlink() and not wt.exists()
    assert (other / "draft.txt").read_text() == "not committed\n", "the worktree the link led to is still there"
    assert str(other) in _git(repo, "worktree", "list")
    dev.worktree_path("t7").symlink_to(other)  # planted before the ticket was filed
    wt7, _b, _s = dev.create_worktree("t7")
    assert wt7.is_dir() and not wt7.is_symlink() and (other / "draft.txt").exists()


APP = '''
import json, pathlib, socket
def attempt(f):
    try:
        f()
        return True
    except Exception:
        return False
attempt(lambda: pathlib.Path(OUTSIDE).write_text("x"))
RESULT = {
    "home": attempt(lambda: pathlib.Path(HOME, ".ssh", "id").read_text()),
    "network": attempt(lambda: socket.create_connection(("127.0.0.1", PORT), timeout=2)),
    "tree": attempt(lambda: pathlib.Path(TREE, "ok").write_text("x")),
}
async def app(scope, receive, send):
    if scope["type"] == "lifespan":
        while (await receive())["type"] != "lifespan.shutdown":
            await send({"type": "lifespan.startup.complete"})
        await send({"type": "lifespan.shutdown.complete"})
        return
    await send({"type": "http.response.start", "status": 200, "headers": [(b"content-type", b"application/json")]})
    await send({"type": "http.response.body", "body": json.dumps({"ok": True, **RESULT}).encode()})
'''


@pytest.mark.skipif(not ticket_box.works(), reason=f"thimble's sandbox runtime can't run here: {ticket_box.problem()}")
async def test_the_box_s_server_reads_no_home_writes_only_its_tree_and_reaches_no_network(monkeypatch, tmp_path):
    """Code a ticket edited, imported by the server in its box, can't read the home folder, write outside its worktree
    and cache, or connect to a port on this machine, and the server still answers the host through the handoff."""
    home = tmp_path / "home"
    (home / ".ssh").mkdir(parents=True)
    (home / ".ssh" / "id").write_text("secret")
    monkeypatch.setenv("HOME", str(home))
    listener = socket.create_server(("127.0.0.1", 0))
    tree = tmp_path / "tree"
    (tree / "backend" / "app").mkdir(parents=True)
    (tree / "backend" / "app" / "__init__.py").write_text("")
    shutil.copy(BACKEND / "app" / "handoff_serve.py", tree / "backend" / "app" / "handoff_serve.py")
    (tree / "backend" / ".venv").symlink_to(Path(sys.prefix), target_is_directory=True)
    (tmp_path / "live" / "backend").mkdir(parents=True)
    (tmp_path / "live" / "backend" / ".venv").symlink_to(Path(sys.prefix), target_is_directory=True)
    consts = {"HOME": str(home), "OUTSIDE": str(tmp_path / "escaped"), "PORT": listener.getsockname()[1],
              "TREE": str(tree)}
    (tree / "backend" / "app" / "main.py").write_text("".join(f"{k} = {v!r}\n" for k, v in consts.items()) + APP)
    preview = ticket_box.Preview(ticket_box.Box(tree, tmp_path / "cache", tmp_path / "srt", live=tmp_path / "live"), {})
    try:
        url = await preview.start(wait_s=60)
        body = json.loads(await asyncio.to_thread(ticket_box.fetch, f"{url}/api/health"))
    finally:
        await preview.stop()
        listener.close()
    # a write outside is refused, or on Linux lands in the empty folder the box shows there, which the host never sees
    assert body == {"ok": True, "home": False, "network": False, "tree": True}
    assert not (tmp_path / "escaped").exists() and (tree / "ok").exists()
