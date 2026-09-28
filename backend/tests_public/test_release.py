"""scripts/release.sh, built without the UI into a temporary folder: the zip carries what an install runs (the
screenshot script main's `screenshot` tool needs among it) and the docs the readme links, and every other link of the
readme points at GitHub, so none is broken in an unzipped install. It ships only files in git's index, says in
RELEASE.json whether any of them has uncommitted changes, refuses a staged tree scripts/check_content.py objects to, and
writes the zip's digest to SHA256SUMS beside it."""
from __future__ import annotations

import hashlib
import json
import re
import shutil
import subprocess
import zipfile

import pytest

from app import config

NEEDS = pytest.mark.skipif(not shutil.which("zip") or not shutil.which("git"), reason="release.sh needs zip and git")


def small_repo(tmp_path):
    """A git repo holding release.sh, check_content.py and the manifests release.sh reads, all committed."""
    root = tmp_path / "repo"
    for rel in ("scripts/release.sh", "scripts/check_content.py", "plugin/.claude-plugin/plugin.json",
                ".claude-plugin/marketplace.json", "LICENSE"):
        (root / rel).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(config.REPO_ROOT / rel, root / rel)
    (root / "README.md").write_text("# thimble\n")
    (root / "plugin" / "bin").mkdir()
    (root / "plugin" / "bin" / "tool").write_text("#!/bin/sh\n")
    git(root, "init", "-q")
    git(root, "add", ".")
    git(root, "commit", "-q", "-m", "init")
    return root


def git(root, *args):
    subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "core.hooksPath=/dev/null",
                    "-C", str(root), *args], check=True, capture_output=True)


def release(root, out):
    r = subprocess.run(["bash", str(root / "scripts" / "release.sh"), "--skip-frontend", "--out", str(out)],
                       capture_output=True, text=True, timeout=300)
    if r.returncode != 0:
        return r, set(), {}
    [zip_path] = list(out.glob("thimble-*.zip"))
    with zipfile.ZipFile(zip_path) as z:
        top = z.namelist()[0].split("/")[0]
        files = {n[len(top) + 1:] for n in z.namelist() if not n.endswith("/")}
        meta = json.loads(z.read(f"{top}/RELEASE.json"))
    assert (out / "SHA256SUMS").read_text() == f"{hashlib.sha256(zip_path.read_bytes()).hexdigest()}  {zip_path.name}\n"
    return r, files, meta


@NEEDS
def test_only_files_in_the_index_ship_and_dirty_says_whether_they_changed(tmp_path):
    root = small_repo(tmp_path)
    (root / "plugin" / "untracked.txt").write_text("not added\n")
    r, files, meta = release(root, tmp_path / "out1")
    assert r.returncode == 0, r.stderr
    assert "plugin/bin/tool" in files and "plugin/untracked.txt" not in files
    assert meta["dirty"] is False
    (root / "plugin" / "bin" / "tool").write_text("#!/bin/sh\necho edited\n")
    r, files, meta = release(root, tmp_path / "out2")
    assert r.returncode == 0 and meta["dirty"] is True, r.stderr
