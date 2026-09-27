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
