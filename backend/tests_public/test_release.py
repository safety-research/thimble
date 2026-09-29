"""scripts/release.sh, built without the UI into a temporary folder: it ships only files in git's index, says in
RELEASE.json whether any of them has uncommitted changes, and writes the zip's digest to SHA256SUMS beside it."""
from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
import zipfile

import pytest

from app import config

NEEDS = pytest.mark.skipif(not shutil.which("zip") or not shutil.which("git"), reason="release.sh needs zip and git")


def small_repo(tmp_path, *more):
    """A git repo holding release.sh, check_content.py, the manifests release.sh reads and the files `more` names, all
    committed."""
    root = tmp_path / "repo"
    for rel in ("scripts/release.sh", "scripts/check_content.py", "plugin/.claude-plugin/plugin.json",
                ".claude-plugin/marketplace.json", "LICENSE", *more):
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


def release(root, out, read=()):
    """release.sh's run, the zip's files and its RELEASE.json, and with `read` also the text of those files."""
    r = subprocess.run(["bash", str(root / "scripts" / "release.sh"), "--skip-frontend", "--out", str(out)],
                       capture_output=True, text=True, timeout=300)
    if r.returncode != 0:
        return r, set(), {}
    [zip_path] = list(out.glob("thimble-*.zip"))
    with zipfile.ZipFile(zip_path) as z:
        top = z.namelist()[0].split("/")[0]
        files = {n[len(top) + 1:] for n in z.namelist() if not n.endswith("/")}
        meta = json.loads(z.read(f"{top}/RELEASE.json"))
        meta.update({rel: z.read(f"{top}/{rel}").decode() for rel in read})
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


@NEEDS
@pytest.mark.skipif(not shutil.which("uv"), reason="release.sh exports backend/requirements.txt with uv")
def test_a_release_pins_the_backend_with_hashes_and_carries_the_frontend_s_runtime_packages_alone(tmp_path):
    """backend/requirements.txt holds uv.lock's runtime packages with their hashes, which install.sh installs from any
    index; frontend/runtime holds the packages the server and its scripts load, with the whole of their part of
    package-lock.json (so npm ci needs nothing else) at its versions and hashes, and nothing the UI alone needs."""
    root = small_repo(tmp_path, "backend/pyproject.toml", "backend/uv.lock", "frontend/package.json",
                      "frontend/package-lock.json")
    runtime = ("frontend/runtime/package.json", "frontend/runtime/package-lock.json")
    r, files, meta = release(root, tmp_path / "out", read=("backend/requirements.txt", *runtime))
    assert r.returncode == 0, r.stderr
    text = meta["backend/requirements.txt"]
    pins = [ln for ln in text.splitlines() if ln and not ln[0].isspace() and not ln.startswith("#")]
    assert any(ln.startswith("fastapi==") for ln in pins) and not any(ln.startswith("pytest==") for ln in pins)
    assert all(ln.endswith(" \\") for ln in pins) and text.count("--hash=sha256:") >= len(pins), "each with its hashes"
    full = json.loads((root / "frontend" / "package-lock.json").read_text())["packages"]
    ranges = {**json.loads((root / "frontend" / "package.json").read_text())["devDependencies"],
              **json.loads((root / "frontend" / "package.json").read_text())["dependencies"]}
    manifest, lock = json.loads(meta[runtime[0]]), json.loads(meta[runtime[1]])["packages"]
    names = {"vega", "vega-lite", "vega-embed", "playwright", "@fontsource/geist-mono", "@fontsource/hanken-grotesk"}
    assert manifest["dependencies"] == {n: ranges[n] for n in names} == lock[""]["dependencies"]
    for path, entry in lock.items():
        if not path:
            continue
        assert "resolved" not in entry and "dev" not in entry, path
        assert (entry["version"], entry["integrity"]) == (full[path]["version"], full[path]["integrity"]), path
        for dep in entry.get("dependencies", {}):
            at = path
            while f"{at}/node_modules/{dep}" not in lock and at:
                at = at[:at.rfind("/node_modules/")] if "/node_modules/" in at else ""
            assert f"{at}/node_modules/{dep}".lstrip("/") in lock, f"{path} needs {dep}"
    assert "node_modules/vega-lite/node_modules/vega-expression" in lock, "a nested version is kept where it was"
    assert not {"node_modules/react", "node_modules/vite", "node_modules/@blocknote/core"} & set(lock)


@NEEDS
def test_the_zip_carries_the_config_s_reference_the_install_guide_links(tmp_path):
    """INSTALL.md links docs/config.md, which the zip carries; a page's link to a file the zip leaves out goes to GitHub."""
    root = small_repo(tmp_path, "INSTALL.md", "docs/config.md")
    (root / "docs" / "config.md").write_text((root / "docs" / "config.md").read_text() + "\nSee [the notes](notes.md).\n")
    git(root, "commit", "-q", "-am", "link")
    r, files, meta = release(root, tmp_path / "out", read=("INSTALL.md", "docs/config.md"))
    assert r.returncode == 0, r.stderr
    assert "docs/config.md" in files
    assert "](docs/config.md)" in meta["INSTALL.md"]
    assert "/blob/" in meta["docs/config.md"] and "/docs/notes.md)" in meta["docs/config.md"]
