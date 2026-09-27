"""scripts/install.sh, scripts/update.sh and plugin/bin/thimble's uninstall, run for real against invented trees under
tmp_path with a throwaway HOME: the Python they start never imports a module from the folder they run in."""
from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]


@pytest.fixture(autouse=True)
def _posix_tools():
    if not all(shutil.which(t) for t in ("bash", "python3")):
        pytest.skip("needs bash and python3")


def fake_tree(root: Path, *, checkout: bool = False) -> Path:
    """A thimble tree holding the real scripts and plugin/bin/thimble, and the manifests they read."""
    for rel in ("scripts/install.sh", "scripts/update.sh", "plugin/bin/thimble"):
        (root / rel).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(REPO / rel, root / rel)
    (root / "backend").mkdir(parents=True, exist_ok=True)
    (root / "backend" / "pyproject.toml").write_text('[project]\nrequires-python = ">=3.12"\n')
    (root / "plugin" / ".claude-plugin").mkdir(parents=True, exist_ok=True)
    (root / "plugin" / ".claude-plugin" / "plugin.json").write_text(json.dumps({"name": "thimble", "version": "0.0.1"}))
    (root / ".claude-plugin").mkdir(exist_ok=True)
    (root / ".claude-plugin" / "marketplace.json").write_text(json.dumps({"name": "thimble-local"}))
    if checkout:
        (root / ".git").mkdir()
    return root


def env_for(tmp_path: Path, **extra: str) -> dict[str, str]:
    home = tmp_path / "home"
    home.mkdir(exist_ok=True)
    return {"PATH": "/usr/bin:/bin", "HOME": str(home), "THIMBLE_HOME": str(home / ".thimble"), **extra}


def trap_folder(tmp_path: Path) -> tuple[Path, Path]:
    """A folder whose json.py writes a marker when imported: a script run from it must not import it."""
    cwd = tmp_path / "cwd"
    cwd.mkdir()
    marker = tmp_path / "imported"
    (cwd / "json.py").write_text(f"open({str(marker)!r}, 'w').close()\nfrom importlib import import_module\n")
    return cwd, marker


def test_update_sh_does_not_import_from_the_folder_it_runs_in(tmp_path):
    tree = fake_tree(tmp_path / "app", checkout=True)
    cwd, marker = trap_folder(tmp_path)
    r = subprocess.run(["bash", str(tree / "scripts" / "update.sh"), "--dir", str(tree), "--dry-run"], cwd=cwd,
                       capture_output=True, text=True, env=env_for(tmp_path), timeout=60)
    assert r.returncode == 0, r.stdout + r.stderr
    assert "thimble 0.0.1 at" in r.stdout
    assert not marker.exists(), "json_get imported json.py from the working directory"


def test_uninstall_does_not_import_from_the_folder_it_runs_in(tmp_path):
    tree = fake_tree(tmp_path / "app")
    env = env_for(tmp_path)
    Path(env["THIMBLE_HOME"]).mkdir()
    (Path(env["THIMBLE_HOME"]) / "app-dir").write_text(f"{tree}\n")
    cwd, marker = trap_folder(tmp_path)
    r = subprocess.run(["bash", str(tree / "plugin" / "bin" / "thimble"), "uninstall"], cwd=cwd, input="n\n",
                       capture_output=True, text=True, env=env, timeout=60)
    assert r.returncode == 0 and "nothing removed" in r.stdout, r.stdout + r.stderr
    assert "claude plugin uninstall thimble@thimble-local" in r.stdout, "the marketplace name was read"
    assert not marker.exists(), "json_get imported json.py from the working directory"


def test_install_sh_does_not_import_from_the_folder_it_runs_in(tmp_path):
    tree = fake_tree(tmp_path / "release")
    cwd, marker = trap_folder(tmp_path)
    r = subprocess.run(["bash", str(tree / "scripts" / "install.sh"), "--dir", str(tmp_path / "dest"), "--dry-run",
                        "--deps-only"], cwd=cwd, capture_output=True, text=True, env=env_for(tmp_path), timeout=60)
    assert r.returncode == 0, r.stdout + r.stderr
    assert "thimble 0.0.1 from" in r.stdout
    assert not marker.exists(), "install.sh's Python imported json.py from the working directory"


def stub_bin(tmp_path: Path) -> Path:
    """uv that does nothing but name itself, so install.sh runs its steps without creating a venv, and a node too old
    for the frontend step."""
    bin_ = tmp_path / "bin"
    bin_.mkdir(exist_ok=True)
    for name, body in {"uv": 'case "$1" in --version) echo "uv 0.0.0";; esac', "node": "echo v18.0.0"}.items():
        (bin_ / name).write_text(f"#!/bin/sh\n{body}\n")
        (bin_ / name).chmod(0o755)
    return bin_


def install(tree: Path, dest: Path, tmp_path: Path, *flags: str) -> subprocess.CompletedProcess:
    env = env_for(tmp_path, PATH=f"{stub_bin(tmp_path)}:/usr/bin:/bin")
    return subprocess.run(["bash", str(tree / "scripts" / "install.sh"), "--dir", str(dest), "--deps-only", *flags],
                          capture_output=True, text=True, env=env, timeout=60)


def test_a_release_install_carries_the_files_the_readme_links(tmp_path):
    tree = fake_tree(tmp_path / "release")
    (tree / "README.md").write_text("[Install](INSTALL.md) ![banner](docs/assets/thimble-banner.svg)\n")
    (tree / "INSTALL.md").write_text("# Install\n")
    (tree / "docs" / "assets").mkdir(parents=True)
    (tree / "docs" / "assets" / "thimble-banner.svg").write_text("<svg/>\n")
    dest = tmp_path / "home" / ".thimble" / "app"
    r = install(tree, dest, tmp_path)
    assert r.returncode == 0, r.stdout + r.stderr
    for rel in ("README.md", "INSTALL.md", "docs/assets/thimble-banner.svg"):
        assert (dest / rel).read_text() == (tree / rel).read_text(), rel


def test_install_sh_copies_only_into_an_empty_folder_or_an_earlier_install(tmp_path):
    tree = fake_tree(tmp_path / "release")
    home = tmp_path / "home"
    home.mkdir()
    (home / "notes.txt").write_text("keep\n")
    (home / "scripts").mkdir()
    (home / "scripts" / "mine.sh").write_text("keep\n")
    for dest, why in ((home, "your home directory"), (home / "scripts", "neither empty nor a thimble install")):
        r = install(tree, dest, tmp_path)
        assert r.returncode == 1 and why in r.stderr, (dest, r.stdout + r.stderr)
    r = install(tree, Path("/"), tmp_path, "--dry-run")  # a dry run, so a script without the check removes nothing
    assert r.returncode == 1 and "the root directory" in r.stderr, r.stdout + r.stderr
    assert (home / "scripts" / "mine.sh").read_text() == "keep\n" and (home / "notes.txt").is_file()
    (tmp_path / "file").write_text("")
    assert "is not a directory" in install(tree, tmp_path / "file", tmp_path).stderr
    empty = tmp_path / "empty"
    empty.mkdir()
    assert install(tree, empty, tmp_path).returncode == 0
    (empty / "workspaces").mkdir()
    r = install(tree, empty, tmp_path)
    assert r.returncode == 0, "an earlier install is installed over: " + r.stdout + r.stderr
    assert (empty / "workspaces").is_dir()
