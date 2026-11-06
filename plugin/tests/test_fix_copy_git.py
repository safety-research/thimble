"""thimble fix (engine/kernel/fixes.py) and the copy's git link: the fixer's sandbox writes its copy, the copy's .git
too, so git runs on the copy's own worktree entry in live's repository, as live's records have it, and never follows
the copy's .git. A copy whose .git points at the person's clone fails and leaves the clone as it was. The world is
test_fixes.py's made-up thimble 0.10.2. All data here is made up."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_fixes import FX, made, sh, world  # noqa: E402, F401  (world is the fixture)


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
