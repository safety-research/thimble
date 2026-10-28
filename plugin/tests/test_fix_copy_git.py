"""thimble fix (engine/kernel/fixes.py) and the copy's git link: the fixer's sandbox writes its copy, the copy's .git
too, so git runs on the copy's own worktree entry in live's repository, as live's records have it, and never follows
the copy's .git. A copy whose .git points at the person's clone fails and leaves the clone as it was; one with a git
folder of the fixer's own runs none of its settings' commands; the sandbox reads live's git folder, never the one a
copy's .git names. The world is test_fixes.py's made-up thimble 0.10.2. All data here is made up."""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_fixes import FX, made, release_with, sh, world  # noqa: E402, F401  (world is the fixture)


def snapshot(repo: Path) -> dict:
    """What git may change in a repository: its branches and refs, HEAD, its index and the state of its files."""
    gd = Path(sh("git", "rev-parse", "--absolute-git-dir", cwd=repo))
    return {"refs": sh("git", "for-each-ref", "--format=%(refname) %(objectname)", cwd=repo),
            "head": (gd / "HEAD").read_text(), "index": (gd / "index").read_bytes() if (gd / "index").exists() else b"",
            "status": sh("git", "--no-optional-locks", "status", "--porcelain", "--ignored", cwd=repo)}


def test_a_copy_whose_git_link_points_at_the_persons_clone_fails_and_leaves_the_clone_as_it_was(world):
    # a clone install: live is a worktree of the person's clone, which holds the release commit too
    clone = world["rel"]
    r = made(world)
    before = snapshot(clone)
    (Path(r["work"]) / ".git").write_text(f"gitdir: {clone / '.git'}\n")
    out = FX.done(r["id"], "Bar says read", "")
    assert out["state"] == "failed" and "no longer a git checkout" in out["error"] and "y starts it again" in out["error"]
    assert out["work"] is None and snapshot(clone) == before


def test_a_copy_with_a_git_folder_of_its_fixers_own_runs_none_of_its_settings_commands(world, tmp_path):
    r = made(world)
    wt = Path(r["work"])
    ran = tmp_path / "ran-outside"
    (wt / "made-up-monitor").write_text(f"#!/bin/sh\ntouch '{ran}'\nexit 1\n")
    (wt / "made-up-monitor").chmod(0o755)
    (wt / ".git").unlink()
    sh("git", "init", "-q", str(wt))
    sh("git", "config", "core.fsmonitor", str(wt / "made-up-monitor"), cwd=wt)
    out = FX.done(r["id"], "Bar says read", "")
    assert out["state"] == "failed" and "no longer a git checkout" in out["error"]
    assert not ran.exists()


def test_the_fixers_sandbox_reads_lives_git_folder_never_the_one_a_copys_git_link_names(world, tmp_path):
    release_with(world, {"plugin/sandbox/run.mjs": "// the release's sandbox code\n"})
    other = tmp_path / "other"
    other.mkdir()
    sh("git", "init", "-q", cwd=other)
    (FX.thimble_home() / "srt" / "node_modules").mkdir(parents=True)
    r = FX.new("a change")
    (Path(r["work"]) / ".git").write_text(f"gitdir: {other / '.git'}\n")
    argv = world["real_sandbox"](r["id"])
    reads = [x["path"] for x in json.loads(argv[argv.index("--srt") + 2])["filesystem"]["allowRead"]]
    assert str((other / ".git").resolve()) not in reads
    assert str((world["rel"] / ".git").resolve()) in reads
