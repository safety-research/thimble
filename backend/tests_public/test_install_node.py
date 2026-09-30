"""install.sh's Node question and the doctor's node line: in a checkout, whose frontend tests (a code ticket's vitest
gate) need Node 20.19+, 22.13+ or 24+ (jsdom's engines), a node that is missing or older is offered an upgrade with
Homebrew, and the doctor says it is a problem. install.sh runs against an invented checkout under tmp_path with a
throwaway HOME, stand-ins for uv, node, npm and brew, and --deps-only, so no doctor and no `claude` runs, and with
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


def stubs(tmp_path: Path, node: str, *, brew: bool = True, brew_node: str | None = None) -> dict[str, str]:
    """PATH with uv, npm and a node printing `node` first; with `brew`, a Homebrew in tmp_path/brew whose `install` and
    `upgrade` of node are logged and leave a node 24 in its bin; `brew_node` names the version of a node Homebrew holds
    already. The environment install.sh runs in."""
    bin_ = tmp_path / "bin"
    exe(bin_ / "uv", 'case "$1" in --version) echo "uv 0.0.0";; esac\n')
    exe(bin_ / "npm", "exit 0\n")
    exe(bin_ / "node", f'echo "{node}"\n')
    path = [str(bin_)]
    prefix = tmp_path / "brew"
    if brew:
        exe(prefix / "bin" / "brew", f"""echo "brew $*" >> "{tmp_path / 'brew.log'}"
case "$*" in
  "install node" | "upgrade node")
    mkdir -p "{prefix}/opt/node/bin"; printf '#!/bin/sh\\necho v24.1.0\\n' > "{prefix}/opt/node/bin/node"
    chmod +x "{prefix}/opt/node/bin/node"; ln -sf "{prefix}/opt/node/bin/node" "{prefix}/bin/node";;
esac
""")
        path.append(str(prefix / "bin"))
        if brew_node:
            exe(prefix / "opt" / "node" / "bin" / "node", f'echo "{brew_node}"\n')
    home = tmp_path / "home"
    home.mkdir(exist_ok=True)
    return {"PATH": ":".join([*path, "/usr/bin", "/bin"]), "HOME": str(home), "THIMBLE_HOME": str(home / ".thimble")}


def install(tree: Path, env: dict[str, str], *flags: str) -> subprocess.CompletedProcess:
    return subprocess.run(["bash", str(tree / "scripts" / "install.sh"), "--deps-only", "--browser", "off",
                           "--no-sandbox-deps", *flags], capture_output=True, text=True, env=env,
                          stdin=subprocess.DEVNULL, timeout=60)


def test_a_checkout_s_node_older_than_the_frontend_tests_need_is_offered_homebrew_s(tmp_path):
    """--dry-run lists the Node question with its flags for a node below the floor (brew install, or brew upgrade when
    Homebrew's node is old too), and runs no brew."""
    tree = checkout(tmp_path / "thimble")
    r = install(tree, stubs(tmp_path, "v20.11.0"), "--dry-run")
    assert r.returncode == 0, r.stdout + r.stderr
    out = r.stdout
    assert f"3. Node for the frontend's tests. A code ticket's checks run the frontend's tests, which need Node 20.19+, " \
           f"22.13+ or 24+; this machine has node v20.11.0 at {tmp_path / 'bin' / 'node'}." in out, out
    assert "install.sh runs `brew install node` (Homebrew)" in out
    assert "code tickets' checks fail until Node is upgraded" in out
    assert "   - yes: --upgrade-node\n   - no: --no-upgrade-node\n" in out
    assert "  - a newer Node for the frontend's tests: brew install node" in out, "the plan lists it under the questions"
    assert "node v20.11.0 is older than the frontend's tests need" in out
    assert not (tmp_path / "brew.log").exists()
    r = install(tree, stubs(tmp_path, "v20.11.0", brew_node="v20.5.0"), "--dry-run", "--upgrade-node")
    assert "3. Node: answered by --upgrade-node" in r.stdout and "+ brew upgrade node" in r.stdout, r.stdout
    assert not (tmp_path / "brew.log").exists()


@pytest.mark.parametrize("version,asked", [("v20.19.0", False), ("v22.13.1", False), ("v24.0.0", False),
                                           ("v20.18.3", True), ("v22.12.0", True), ("v21.7.3", True)])
def test_the_node_question_is_asked_only_below_the_frontend_tests_floor(tmp_path, version, asked):
    tree = checkout(tmp_path / "thimble")
    r = install(tree, stubs(tmp_path, version), "--dry-run")
    assert r.returncode == 0, r.stdout + r.stderr
    assert ("--upgrade-node" in r.stdout) == asked, r.stdout
    if not asked:
        assert f"3. Node: not asked, since node {version} at {tmp_path / 'bin' / 'node'} meets what the frontend's " \
               "tests need" in r.stdout


def test_a_release_or_a_machine_without_homebrew_is_not_asked(tmp_path):
    tree = checkout(tmp_path / "thimble")
    r = install(tree, stubs(tmp_path, "v20.11.0", brew=False), "--dry-run")
    assert "--upgrade-node" not in r.stdout and "Homebrew was not found" in r.stdout, r.stdout
    assert "https://nodejs.org" in r.stdout, "the frontend step says where to get Node"
    shutil.rmtree(tree / ".git")
    r = install(tree, stubs(tmp_path, "v20.11.0"), "--dry-run")
    assert "3. Node: not asked, since a release install has no frontend tests" in r.stdout, r.stdout


def test_without_a_terminal_the_node_question_needs_its_flag_and_each_answer_is_carried_out(tmp_path):
    """No terminal and no flag stops before anything is installed, naming both flags; a no goes on and says what fails;
    a yes runs brew, puts Homebrew's bin first for the rest of the run and says the PATH still finds the old node."""
    tree = checkout(tmp_path / "thimble")
    env = stubs(tmp_path, "v20.11.0")
    r = install(tree, env)
    assert r.returncode == 1 and "Node for the frontend's tests: --upgrade-node or --no-upgrade-node" in r.stderr, \
        r.stdout + r.stderr
    assert not (tmp_path / "brew.log").exists()
    r = install(tree, env, "--no-upgrade-node")
    assert r.returncode == 0, r.stdout + r.stderr
    assert "you answered no to upgrading it" in r.stdout and "Code tickets' checks fail until Node is upgraded" in r.stdout
    assert not (tmp_path / "brew.log").exists()
    r = install(tree, env, "--upgrade-node")
    assert r.returncode == 0, r.stdout + r.stderr
    assert (tmp_path / "brew.log").read_text().splitlines() == ["brew install node"]
    brew_bin = tmp_path / "brew" / "bin"
    assert f"the rest of the install uses node v24.1.0 at {brew_bin / 'node'}" in r.stdout, r.stdout
    assert f"Your PATH still finds {tmp_path / 'bin' / 'node'} (v20.11.0) before it" in r.stdout
    assert f'  export PATH="{brew_bin}:$PATH"' in r.stdout


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
            assert "install.sh --upgrade-node`, or upgrade Node" in line
            assert "install.sh" not in cli.node_line(commands=False), "the doctor a model reads names no install command"
        else:
            assert line == version
    (frontend / "node_modules" / ".bin" / "vitest").unlink()  # a release install has no frontend tests
    exe(tmp_path / "bin" / "node", 'echo "v20.11.0"\n')
    assert cli.node_line() == "v20.11.0"
