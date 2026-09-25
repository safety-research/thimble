"""scripts/install.sh's frontend step on a clone after a pull: npm ci runs when package-lock.json changed since the
packages were installed (by this script's stamp, or by npm's own record of an install made without it), frontend/dist is
rebuilt through scripts/rebuild_ui.sh when a file it is built from is newer than it, and a release's prebuilt
frontend/dist is kept as it is. The real install.sh and rebuild_ui.sh run with --deps-only against an invented tree,
with uv, node, npm and npx replaced by stubs that record their calls."""
from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
T0 = 1_700_000_000  # the time of the earlier install; a pulled file is written an hour later

STUBS = {
    "uv": 'case "$1" in --version) echo "uv 0.0.0";; esac\n',
    "node": 'case "$1" in -v) echo v22.0.0;; esac\n',
    "npm": 'echo "npm $*" >> "$STUB_LOG"\n'
           'if [ "$1" = ci ]; then rm -rf node_modules; mkdir node_modules; cp package-lock.json node_modules/.package-lock.json; fi\n',
    "npx": 'echo "npx $*" >> "$STUB_LOG"\n'
           'if [ "$1" = vite ] && [ "$3" = --outDir ]; then mkdir -p "$4" && echo rebuilt > "$4/index.html"; fi\n'
           'if [ "$*" = "vite build" ]; then mkdir -p dist && echo built > dist/index.html; fi\n',
}


def tree(tmp_path: Path, *, checkout: bool = True) -> Path:
    """A thimble tree holding the real install.sh and rebuild_ui.sh, a built frontend/dist and packages installed from
    lockfile v1 at T0, a backend/.venv whose python has no playwright, and a .git when `checkout`."""
    root = tmp_path / "thimble"
    for rel in ("scripts/install.sh", "scripts/rebuild_ui.sh"):
        (root / rel).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(REPO / rel, root / rel)
    (root / "backend").mkdir()
    (root / "backend" / "pyproject.toml").write_text('[project]\nrequires-python = ">=3.12"\n')
    (root / "plugin" / "bin").mkdir(parents=True)
    (root / "plugin" / ".claude-plugin").mkdir()
    (root / "plugin" / ".claude-plugin" / "plugin.json").write_text('{"version": "0.0.1"}')
    venv = root / "backend" / ".venv" / "bin"
    venv.mkdir(parents=True)
    (venv / "python").write_text("#!/bin/sh\nexit 1\n")
    (venv / "python").chmod(0o755)
    fe = root / "frontend"
    for rel, text in {"src/App.tsx": "app\n", "index.html": "<div id=root>\n", "package.json": "{}\n",
                      "package-lock.json": "v1\n", "vite.config.ts": "\n", "tsconfig.app.json": "{}\n",
                      "dist/index.html": "old build\n", "node_modules/.package-lock.json": "v1\n",
                      "node_modules/.thimble-package-lock.json": "v1\n"}.items():
        (fe / rel).parent.mkdir(parents=True, exist_ok=True)
        (fe / rel).write_text(text)
    for p in root.rglob("*"):
        os.utime(p, (T0, T0))
    if checkout:
        (root / ".git").mkdir()
    return root


def pull(root: Path, rel: str, text: str) -> None:
    """A file a pull changed: new content, written after the install."""
    p = root / "frontend" / rel
    p.write_text(text)
    os.utime(p, (T0 + 3600, T0 + 3600))


def install(root: Path, tmp_path: Path) -> tuple[str, list[str]]:
    """install.sh --deps-only over `root` in place: its output and the stubbed npm and npx calls."""
    bin_ = tmp_path / "bin"
    bin_.mkdir(exist_ok=True)
    for name, body in STUBS.items():
        (bin_ / name).write_text("#!/bin/sh\n" + body)
        (bin_ / name).chmod(0o755)
    log = tmp_path / "calls.log"
    log.write_text("")
    env = {"PATH": f"{bin_}:/usr/bin:/bin", "HOME": str(tmp_path / "home"), "THIMBLE_HOME": str(tmp_path / "home"),
           "STUB_LOG": str(log)}
    r = subprocess.run(["bash", str(root / "scripts" / "install.sh"), "--dir", str(root), "--deps-only"],
                       capture_output=True, text=True, env=env, timeout=60)
    assert r.returncode == 0, r.stdout + r.stderr
    calls = [c for c in log.read_text().splitlines() if "playwright" not in c]
    return r.stdout, calls


@pytest.fixture(autouse=True)
def _posix_tools():
    if not all(shutil.which(t) for t in ("bash", "find", "cmp", "python3")):
        pytest.skip("needs bash, find, cmp and python3")


def test_a_pulled_clone_gets_its_packages_and_a_current_build(tmp_path):
    root = tree(tmp_path)
    pull(root, "package-lock.json", "v2\n")
    pull(root, "src/App.tsx", "app, pulled\n")
    out, calls = install(root, tmp_path)
    assert calls == ["npm ci --no-audit --no-fund", "npx tsc --noEmit -p tsconfig.app.json",
                     "npx vite build --outDir dist.new --emptyOutDir"]
    assert (root / "frontend" / "dist" / "index.html").read_text() == "rebuilt\n"
    assert (root / "frontend" / "node_modules" / ".thimble-package-lock.json").read_text() == "v2\n"
    assert "rebuilding frontend/dist, which is older than frontend/" in out


def test_a_changed_source_alone_rebuilds_without_reinstalling(tmp_path):
    root = tree(tmp_path)
    pull(root, "src/App.tsx", "app, pulled\n")
    out, calls = install(root, tmp_path)
    assert calls == ["npx tsc --noEmit -p tsconfig.app.json", "npx vite build --outDir dist.new --emptyOutDir"]
    assert "older than frontend/src/App.tsx" in out


def test_packages_installed_without_the_script_are_reinstalled_after_the_lockfile_changed(tmp_path):
    root = tree(tmp_path)
    (root / "frontend" / "node_modules" / ".thimble-package-lock.json").unlink()
    pull(root, "package-lock.json", "v2\n")
    _, calls = install(root, tmp_path)
    assert calls[0] == "npm ci --no-audit --no-fund"
    assert (root / "frontend" / "dist" / "index.html").read_text() == "rebuilt\n"


def test_packages_installed_without_the_script_after_the_lockfile_are_kept(tmp_path):
    root = tree(tmp_path)
    (root / "frontend" / "node_modules" / ".thimble-package-lock.json").unlink()
    out, calls = install(root, tmp_path)
    assert calls == []
    assert "installed after the last change to package-lock.json: kept" in out
    assert (root / "frontend" / "node_modules" / ".thimble-package-lock.json").read_text() == "v1\n"


def test_a_current_clone_is_left_as_it_is(tmp_path):
    root = tree(tmp_path)
    out, calls = install(root, tmp_path)
    assert calls == []
    assert (root / "frontend" / "dist" / "index.html").read_text() == "old build\n"
    assert "frontend/node_modules matches package-lock.json" in out


def test_a_release_keeps_its_prebuilt_ui(tmp_path):
    root = tree(tmp_path, checkout=False)
    pull(root, "src/App.tsx", "app, unzipped later\n")
    _, calls = install(root, tmp_path)
    assert not [c for c in calls if c.startswith("npx")]
    assert (root / "frontend" / "dist" / "index.html").read_text() == "old build\n"
