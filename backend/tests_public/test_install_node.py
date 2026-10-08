"""install.sh's Node check and the doctor's node line: a checkout, whose frontend tests (a code ticket's vitest gate)
need Node 20.19+, 22.13+ or 24+ (jsdom's engines), stops on an older node with what it found and what it needs, and the
doctor says it is a problem; the one upgrading picks how. install.sh runs against an invented checkout under tmp_path
with a throwaway HOME, stand-ins for uv, node and npm, and --deps-only, so no doctor and no `claude` runs, and with
--browser off, so no system browser is started."""
from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

from app import cli

REPO = Path(__file__).resolve().parents[2]


@pytest.fixture(autouse=True)
def _posix_tools():
    if not all(shutil.which(t) for t in ("bash", "python3")):
        pytest.skip("needs bash and python3")


def exe(path: Path, body: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("#!/bin/sh\n" + body)
    path.chmod(0o755)
    return path


def checkout(root: Path) -> Path:
    """A git checkout of thimble holding the real install.sh, the manifests it reads and a built UI."""
    (root / "scripts").mkdir(parents=True)
    shutil.copy(REPO / "scripts" / "install.sh", root / "scripts")
    shutil.copy(REPO / "scripts" / "plugin.sh", root / "scripts")
    (root / "plugin" / "bin").mkdir(parents=True)
    (root / "plugin" / ".claude-plugin").mkdir()
    (root / "plugin" / ".claude-plugin" / "plugin.json").write_text(json.dumps({"name": "thimble", "version": "0.0.1"}))
    (root / ".claude-plugin").mkdir()
    (root / ".claude-plugin" / "marketplace.json").write_text(json.dumps({"name": "thimble"}))
    (root / "backend").mkdir()
    (root / "backend" / "pyproject.toml").write_text('[project]\nrequires-python = ">=3.12"\n')
    (root / ".git").mkdir()
    (root / "frontend" / "dist").mkdir(parents=True)
    (root / "frontend" / "dist" / "index.html").write_text("<!doctype html>\n")
    (root / "frontend" / "package-lock.json").write_text("{}\n")
    return root


def stubs(tmp_path: Path, node: str) -> dict[str, str]:
    """PATH with uv, npm and a node printing `node` first; the environment install.sh runs in."""
    bin_ = tmp_path / "bin"
    exe(bin_ / "uv", 'case "$1" in --version) echo "uv 0.0.0";; esac\n')
    exe(bin_ / "npm", "exit 0\n")
    exe(bin_ / "node", f'echo "{node}"\n')
    home = tmp_path / "home"
    home.mkdir(exist_ok=True)
    return {"PATH": f"{bin_}:/usr/bin:/bin", "HOME": str(home), "THIMBLE_HOME": str(home / ".thimble")}


def install(tree: Path, env: dict[str, str], *flags: str) -> subprocess.CompletedProcess:
    return subprocess.run(["bash", str(tree / "scripts" / "install.sh"), "--deps-only", "--browser", "off",
                           "--no-sandbox-deps", *flags], capture_output=True, text=True, env=env,
                          stdin=subprocess.DEVNULL, timeout=60)


STOPS = "is older than a checkout needs: the frontend's tests, which a code ticket's checks run, need Node 20.19+, 22.13+ or 24+"


@pytest.mark.parametrize("version, stops", [("v20.11.0", True), ("v20.18.3", True), ("v21.7.3", True), ("v22.12.0", True),
                                            ("v20.19.0", False), ("v22.13.1", False), ("v24.0.0", False)])
def test_a_checkout_stops_on_a_node_older_than_its_frontend_tests_need(tmp_path, version, stops):
    """Below the floor a checkout's install stops, naming the node it found and the versions it needs, and asks
    nothing; its dry run says where it would stop and goes on. At or above the floor it says nothing of it."""
    tree = checkout(tmp_path / "thimble")
    env = stubs(tmp_path, version)
    r = install(tree, env)
    assert (STOPS in r.stderr) == stops, r.stdout + r.stderr
    if stops:
        assert r.returncode != 0 and f"node {version} at {tmp_path / 'bin' / 'node'}" in r.stderr
        assert "[y/N]" not in r.stdout and "[Y/n]" not in r.stdout
    dry = install(tree, env, "--dry-run")
    assert dry.returncode == 0, dry.stdout + dry.stderr
    assert (f"install.sh stops here: node {version}" in dry.stdout) == stops, dry.stdout


def test_a_release_install_does_not_need_the_frontend_tests_node(tmp_path):
    """A release carries no frontend tests, so Node 20 is enough and nothing stops."""
    tree = checkout(tmp_path / "thimble")
    shutil.rmtree(tree / ".git")
    r = install(tree, stubs(tmp_path, "v20.11.0"), "--dry-run")
    assert r.returncode == 0 and STOPS not in r.stdout + r.stderr, r.stdout + r.stderr


def test_the_doctor_says_a_node_too_old_for_the_frontend_tests_is_a_problem(tmp_path, monkeypatch):
    frontend = tmp_path / "frontend"
    exe(frontend / "node_modules" / ".bin" / "vitest", "exit 0\n")
    monkeypatch.setattr(cli, "FRONTEND_DIR", frontend)
    for version, problem in (("v20.11.0", True), ("v22.12.0", True), ("v20.19.0", False), ("v24.3.0", False)):
        exe(tmp_path / "bin" / "node", f'echo "{version}"\n')
        monkeypatch.setenv("PATH", f"{tmp_path / 'bin'}{os.pathsep}{os.environ['PATH']}")
        line = cli.node_line()
        assert ("older than the frontend's tests need (Node 20.19+, 22.13+ or 24+), so code tickets' vitest checks fail"
                in line) == problem, line
        if problem:
            assert line.endswith("; upgrade Node (https://nodejs.org)")
            assert "nodejs.org" not in cli.node_line(commands=False)
        else:
            assert line == version
    (frontend / "node_modules" / ".bin" / "vitest").unlink()  # a release install has no frontend tests
    exe(tmp_path / "bin" / "node", 'echo "v20.11.0"\n')
    assert cli.node_line() == "v20.11.0"
