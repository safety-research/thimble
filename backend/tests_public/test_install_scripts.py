"""scripts/install.sh, scripts/update.sh and plugin/bin/thimble's uninstall, run for real against invented trees under
tmp_path with a throwaway HOME: the Python they start never imports a module from the folder they run in."""
from __future__ import annotations

import importlib.metadata
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]


@pytest.fixture(autouse=True)
def _posix_tools():
    if not all(shutil.which(t) for t in ("bash", "python3")):
        pytest.skip("needs bash and python3")


def fake_tree(root: Path, *, checkout: bool = False) -> Path:
    """A thimble tree holding the real scripts and plugin/bin/thimble, and the manifests they read."""
    for rel in ("scripts/install.sh", "scripts/update.sh", "plugin/bin/thimble", "plugin/bin/thimble-app-dir"):
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


# uv's stand-in: `uv venv DIR` makes DIR/bin/python the base interpreter without site-packages, so it holds no package
# (and install.sh fetches no browser for one); `uv pip …` is written to $STUB_LOG, and `uv pip sync` prints
# $STUB_SYNC_OUT and exits with $STUB_SYNC_RC
UV_STUB = f"""#!/bin/sh
case "$1" in
  --version) echo "uv 0.0.0";;
  venv) for a; do d="$a"; done; mkdir -p "$d/bin"
        printf '#!/bin/sh\\nexec %s -S "$@"\\n' {os.path.realpath(sys.executable)} > "$d/bin/python"; chmod +x "$d/bin/python";;
  pip) echo "uv $*" >> "${{STUB_LOG:-/dev/null}}"
       if [ "$2" = sync ]; then printf '%s\\n' "${{STUB_SYNC_OUT:-}}"; exit "${{STUB_SYNC_RC:-0}}"; fi;;
esac
"""


def stub_bin(tmp_path: Path) -> Path:
    """uv's stand-in (UV_STUB), so install.sh runs its steps without installing anything, and a node too old for the
    frontend step."""
    bin_ = tmp_path / "bin"
    bin_.mkdir(exist_ok=True)
    for name, body in {"uv": UV_STUB, "node": "#!/bin/sh\necho v18.0.0\n"}.items():
        (bin_ / name).write_text(body)
        (bin_ / name).chmod(0o755)
    return bin_


def install(tree: Path, dest: Path, tmp_path: Path, *flags: str, **extra: str) -> subprocess.CompletedProcess:
    env = env_for(tmp_path, PATH=f"{stub_bin(tmp_path)}:/usr/bin:/bin", **extra)
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


def pinned_release(tmp_path: Path) -> Path:
    """A release tree whose backend/requirements.txt pins its one dependency with a hash, as release.sh writes it."""
    tree = fake_tree(tmp_path / "release")
    (tree / "backend" / "pyproject.toml").write_text('[project]\nrequires-python = ">=3.12"\ndependencies = ["httpx>=0.27"]\n')
    (tree / "backend" / "requirements.txt").write_text("httpx==0.28.1 \\\n    --hash=sha256:" + "0" * 64 + "\n")
    return tree


def test_a_release_installs_the_backend_with_the_tool_set_up_with_a_package_index(tmp_path):
    """uv pip installs the pinned packages from uv's index, and pip from pip's where pip has an index and uv has none
    (uv sync would fetch the URLs uv.lock names, whatever index is set up)."""
    tree = pinned_release(tmp_path)
    dest = tmp_path / "home" / ".thimble" / "app"
    req = tree / "backend" / "requirements.txt"
    uv = f"+ uv pip sync --require-hashes {req} --python {dest}/backend/.venv/bin/python"
    pip = f"-m pip install --quiet --disable-pip-version-check --require-hashes --no-deps -r {req}"
    pip_conf = tmp_path / "home" / ".config" / "pip" / "pip.conf"
    for extra, conf, tool in (({}, "", uv), ({"PIP_INDEX_URL": "https://mirror.example/simple"}, "", pip),
                              ({}, "[global]\nindex-url = https://mirror.example/simple\n", pip),
                              ({"PIP_INDEX_URL": "https://a.example/simple", "UV_DEFAULT_INDEX": "https://b.example/simple"},
                               "", uv)):
        if conf:
            pip_conf.parent.mkdir(parents=True, exist_ok=True)
            pip_conf.write_text(conf)
        r = install(tree, dest, tmp_path, "--dry-run", **extra)
        pip_conf.unlink(missing_ok=True)
        assert r.returncode == 0 and tool in r.stdout, (extra, conf, r.stdout + r.stderr)
        assert "uv sync" not in r.stdout


def test_a_pinned_install_falls_back_to_pyproject_s_ranges_only_when_the_index_lacks_a_version(tmp_path):
    tree = pinned_release(tmp_path)
    dest = tmp_path / "home" / ".thimble" / "app"
    log = tmp_path / "uv.log"

    def run(**extra: str) -> tuple[subprocess.CompletedProcess, list[str]]:
        log.write_text("")
        r = install(tree, dest, tmp_path, STUB_LOG=str(log), **extra)
        return r, [ln.split(" --python")[0] for ln in log.read_text().splitlines()]

    r, calls = run()
    assert r.returncode == 0 and calls == [f"uv pip sync --require-hashes {tree}/backend/requirements.txt"], r.stdout
    r, calls = run(STUB_SYNC_RC="1", STUB_SYNC_OUT="Because there is no version of httpx==0.28.1 and you require it")
    assert r.returncode == 0 and len(calls) == 2 and calls[1].startswith("uv pip install -r "), r.stdout + r.stderr
    assert "installed instead" in r.stdout
    r, calls = run(STUB_SYNC_RC="1", STUB_SYNC_OUT="Hash mismatch for `httpx==0.28.1`")
    assert r.returncode == 1 and "hash is not the one" in r.stderr and len(calls) == 1, r.stdout + r.stderr


def test_install_sh_python_links_a_prepared_environment_and_installs_nothing_into_it(tmp_path):
    """--python checks the environment before anything changes, refuses one that lacks a dependency, or an install whose
    own backend/.venv is in the way, and links backend/.venv to it; later runs keep the link."""
    tree = fake_tree(tmp_path / "release")
    (tree / "backend" / "app").mkdir()
    shutil.copy(REPO / "backend" / "app" / "env_check.py", tree / "backend" / "app")
    byo = tmp_path / "byo"
    subprocess.run([os.path.realpath(sys.executable), "-m", "venv", "--without-pip", str(byo)], check=True, timeout=60)
    [site] = byo.glob("lib/python3*/site-packages")  # prepared with packaging alone, which the check reads versions with
    dist = importlib.metadata.distribution("packaging")
    info = next(f.parts[0] for f in dist.files if f.parts[0].endswith(".dist-info"))
    for name in ("packaging", info):
        shutil.copytree(Path(dist.locate_file(name)), site / name)
    before = sorted(p.relative_to(byo) for p in byo.rglob("*"))
    dest = tmp_path / "home" / ".thimble" / "app"
    log = tmp_path / "uv.log"
    pyproject = tree / "backend" / "pyproject.toml"
    pyproject.write_text('[project]\nrequires-python = ">=3.12"\ndependencies = ["no-such-package-here>=1"]\n')
    r = install(tree, dest, tmp_path, "--python", str(byo / "bin" / "python"), STUB_LOG=str(log))
    assert r.returncode == 1 and "no-such-package-here (not installed)" in r.stderr, r.stdout + r.stderr
    assert not dest.exists(), "refused before anything changed"
    pyproject.write_text('[project]\nrequires-python = ">=3.12"\ndependencies = []\n')
    r = install(tree, dest, tmp_path, "--python", str(byo / "bin" / "python"), STUB_LOG=str(log))
    venv = dest / "backend" / ".venv"
    assert r.returncode == 0 and venv.is_symlink() and venv.resolve() == byo.resolve(), r.stdout + r.stderr
    assert install(tree, dest, tmp_path, STUB_LOG=str(log)).returncode == 0 and venv.is_symlink()
    assert not log.exists() or log.read_text() == "", "nothing installed"
    assert sorted(p.relative_to(byo) for p in byo.rglob("*")) == before
    venv.unlink()
    venv.mkdir()
    r = install(tree, dest, tmp_path, "--python", str(byo / "bin" / "python"))
    assert r.returncode == 1 and "delete it" in r.stderr and venv.is_dir() and not venv.is_symlink()


def test_env_check_names_what_an_environment_lacks(tmp_path):
    from app import env_check

    pyproject = tmp_path / "pyproject.toml"
    pyproject.write_text('[project]\nrequires-python = ">=3.12"\n'
                         'dependencies = ["pytest>=8", "pytest>=999", "no-such-package-here", "httpx; python_version < \'3\'"]\n')
    found = next(ln for ln in env_check.missing(pyproject) if ln.startswith("pytest"))
    assert env_check.missing(pyproject) == ["no-such-package-here (not installed)", found]
    assert found.startswith("pytest>=999 (found ")


def release_zip(tmp_path: Path, name: str = "thimble-0.0.2-abc1234") -> Path:
    """A release zip whose install.sh only says that it ran, beside a SHA256SUMS that lists it."""
    import hashlib
    import zipfile

    tree = fake_tree(tmp_path / "build" / name)
    (tree / "scripts" / "install.sh").write_text('#!/bin/bash\necho "the release install.sh ran: $*"\n')
    out = tmp_path / "dl"
    out.mkdir()
    zp = out / f"{name}.zip"
    with zipfile.ZipFile(zp, "w") as z:
        for p in sorted(tree.rglob("*")):
            z.write(p, p.relative_to(tree.parent).as_posix())
    (out / "SHA256SUMS").write_text(f"{hashlib.sha256(zp.read_bytes()).hexdigest()}  {zp.name}\n")
    return zp


def update(tmp_path: Path, *args: str, path: str = "/usr/bin:/bin", **extra: str) -> subprocess.CompletedProcess:
    inst = tmp_path / "inst"
    if not inst.exists():
        fake_tree(inst)
    return subprocess.run(["bash", str(inst / "scripts" / "update.sh"), "--dir", str(inst), *args], capture_output=True,
                          text=True, env=env_for(tmp_path, PATH=path, **extra), timeout=60)


@pytest.mark.skipif(not shutil.which("unzip"), reason="update.sh unpacks with unzip")
def test_update_from_a_zip_checks_it_against_sha256sums_before_running_its_installer(tmp_path):
    zp = release_zip(tmp_path)
    sums = zp.parent / "SHA256SUMS"
    r = update(tmp_path, "--from", str(zp))
    assert r.returncode == 0 and f"the SHA-256 of {zp.name} matches" in r.stdout, r.stdout + r.stderr
    assert "the release install.sh ran: --dir" in r.stdout
    listed = sums.read_text()
    sums.write_text("0" * 64 + f"  {zp.name}\n")
    r = update(tmp_path, "--from", str(zp))
    assert r.returncode == 1 and "refusing to install it" in r.stderr and "install.sh ran" not in r.stdout
    other = tmp_path / "other-SHA256SUMS"
    other.write_text(listed.replace(zp.name, "thimble-0.0.1-0000000.zip"))
    r = update(tmp_path, "--from", str(zp), "--sums", str(other))
    assert r.returncode == 1 and f"lists no SHA-256 for {zp.name}" in r.stderr and "install.sh ran" not in r.stdout
    sums.unlink()
    r = update(tmp_path, "--from", str(zp))
    assert r.returncode == 0 and "its SHA-256 is not checked" in r.stdout, "a zip on disk with no SHA256SUMS"


@pytest.mark.skipif(not shutil.which("unzip"), reason="update.sh unpacks with unzip")
def test_update_from_a_url_needs_the_sha256sums_beside_it_and_https_redirects(tmp_path):
    zp = release_zip(tmp_path)
    bin_ = tmp_path / "bin"
    bin_.mkdir()
    (bin_ / "curl").write_text("""#!/bin/bash
echo "curl $*" >> "$STUB_LOG"
out=""; while [ $# -gt 1 ]; do [ "$1" = -o ] && out="$2"; shift; done
case "$1" in
  */SHA256SUMS) [ -f "$STUB_DIR/SHA256SUMS" ] || exit 22; cp "$STUB_DIR/SHA256SUMS" "$out";;
  *) cp "$STUB_DIR/$(basename "$1")" "$out";;
esac
""")
    (bin_ / "curl").chmod(0o755)
    log = tmp_path / "curl.log"
    url = f"https://example.com/releases/download/v0.0.2/{zp.name}"
    r = update(tmp_path, "--from", url, path=f"{bin_}:/usr/bin:/bin", STUB_LOG=str(log), STUB_DIR=str(zp.parent))
    assert r.returncode == 0 and "the release install.sh ran" in r.stdout, r.stdout + r.stderr
    calls = log.read_text().splitlines()
    assert len(calls) == 2 and calls[1].endswith("https://example.com/releases/download/v0.0.2/SHA256SUMS")
    assert all("--proto =https --proto-redir =https" in c for c in calls), calls
    (zp.parent / "SHA256SUMS").unlink()
    r = update(tmp_path, "--from", url, path=f"{bin_}:/usr/bin:/bin", STUB_LOG=str(log), STUB_DIR=str(zp.parent))
    assert r.returncode == 1 and "no SHA256SUMS beside the zip" in r.stderr and "install.sh ran" not in r.stdout


def test_claude_codes_config_changes_only_on_a_yes_and_uninstall_takes_back_what_thimble_wrote(tmp_path):
    """install.sh's trust step writes nothing into Claude Code's config without a yes (no terminal, no flag), then with
    --trust-workspaces the one entry, keeping the rest, and asks no more; a later --no-trust-workspaces takes it back.
    Uninstall takes back the entries thimble added, an older version's per-folder one too, and the keys an older
    version wrote into a folder's settings.local.json, where they still hold thimble's value."""
    tree = fake_tree(tmp_path / "app")
    (tree / "backend" / "app").mkdir(parents=True)
    shutil.copy(REPO / "backend" / "app" / "claude_changes.py", tree / "backend" / "app")
    env = env_for(tmp_path)
    home = Path(env["THIMBLE_HOME"])
    home.mkdir()
    (home / "app-dir").write_text(f"{tree}\n")
    cfg = Path(env["HOME"]) / ".claude.json"
    before = json.dumps({"numStartups": 3, "projects": {"/x": {"lastCost": 1}}})
    cfg.write_text(before)
    ours = {str(tree / "workspaces"): {"hasTrustDialogAccepted": True}}

    def trust(*flag: str) -> dict:
        subprocess.run(["python3", "-I", str(tree / "backend" / "app" / "claude_changes.py"), "trust", str(tree), *flag],
                       capture_output=True, text=True, env=env, stdin=subprocess.DEVNULL, timeout=30, check=True)
        rec = home / "trust.json"
        return json.loads(rec.read_text()) if rec.exists() else {}

    assert trust() == {} and cfg.read_text() == before, "nothing is written without a yes"
    yes = {"folder": str(tree / "workspaces"), "config": str(cfg), "answer": "yes", "added": True}
    assert trust("--yes") == yes
    data = json.loads(cfg.read_text())
    assert data["numStartups"] == 3 and data["projects"] == {"/x": {"lastCost": 1}, **ours}
    assert trust() == yes and json.loads(cfg.read_text()) == data, "asked once"
    assert trust("--no") == {**yes, "answer": "no", "added": False} and json.loads(cfg.read_text()) == json.loads(before)
    assert trust("--yes") == yes
    old = str(tmp_path / "old-workspace")
    data = json.loads(cfg.read_text())
    cfg.write_text(json.dumps({**data, "projects": {**data["projects"], old: {"hasTrustDialogAccepted": True}}}))
    (home / "trusted-folders.json").write_text(json.dumps({old: {"config": str(cfg), "created": True}}))
    folder = tmp_path / "corpus"
    (folder / ".claude").mkdir(parents=True)
    (folder / ".claude" / "settings.local.json").write_text(json.dumps({"env": {"CLAUDE_CODE_EFFORT_LEVEL": "max",
                                                                                "MINE": "1"}}))
    (home / "effort-overrides.json").write_text(json.dumps({str(folder): "max"}))
    r = subprocess.run(["bash", str(tree / "plugin" / "bin" / "thimble"), "uninstall", "--yes"], capture_output=True,
                       text=True, env=env, timeout=60)
    assert json.loads(cfg.read_text()) == json.loads(before), r.stdout + r.stderr
    assert json.loads((folder / ".claude" / "settings.local.json").read_text()) == {"env": {"MINE": "1"}}
    assert not home.exists(), "removed once what it recorded was put back"


def test_thimble_trust_asks_on_a_terminal_and_remove_takes_back_only_its_entry(tmp_path):
    """`thimble trust` writes install.sh's entry only on a yes typed on a terminal, whatever an earlier install answered,
    and nothing without a terminal; --remove takes back the entry thimble added and leaves one it did not add."""
    import pty

    tree = fake_tree(tmp_path / "app")
    (tree / "backend" / "app").mkdir(parents=True)
    shutil.copy(REPO / "backend" / "app" / "claude_changes.py", tree / "backend" / "app")
    env = env_for(tmp_path)
    home = Path(env["THIMBLE_HOME"])
    home.mkdir()
    cfg = Path(env["HOME"]) / ".claude.json"
    before = {"projects": {"/x": {"lastCost": 1}}}
    cfg.write_text(json.dumps(before))
    folder = str(tree / "workspaces")
    (home / "trust.json").write_text(json.dumps({"folder": folder, "config": str(cfg), "answer": "no", "added": False}))

    def trust(*args: str, typed: str | None = None) -> subprocess.CompletedProcess:
        cmd = ["bash", str(tree / "plugin" / "bin" / "thimble"), "trust", *args]
        if typed is None:
            return subprocess.run(cmd, capture_output=True, text=True, env=env, stdin=subprocess.DEVNULL, timeout=30)
        term, stdin = pty.openpty()
        os.write(term, typed.encode())
        try:
            return subprocess.run(cmd, capture_output=True, text=True, env=env, stdin=stdin, timeout=30)
        finally:
            os.close(term)
            os.close(stdin)

    r = trust()
    assert r.returncode == 1 and "no terminal" in r.stdout and json.loads(cfg.read_text()) == before, r.stdout + r.stderr
    r = trust(typed="n\n")
    assert "Trust thimble's workspaces folder" in r.stdout and json.loads(cfg.read_text()) == before, r.stdout + r.stderr
    r = trust(typed="y\n")
    assert r.returncode == 0 and json.loads(cfg.read_text())["projects"] == {**before["projects"],
                                                                           folder: {"hasTrustDialogAccepted": True}}
    assert json.loads((home / "trust.json").read_text()) == {"folder": folder, "config": str(cfg), "answer": "yes",
                                                             "added": True}
    r = trust("--remove")
    assert "took back" in r.stdout and json.loads(cfg.read_text()) == before, r.stdout + r.stderr
    assert "nothing to take back" in trust("--remove").stdout
    theirs = {"projects": {folder: {"hasTrustDialogAccepted": True}}}
    cfg.write_text(json.dumps(theirs))
    r = trust("--remove")
    assert "did not add" in r.stdout and json.loads(cfg.read_text()) == theirs, r.stdout + r.stderr


def test_the_plugin_is_registered_only_on_a_yes_and_uninstall_removes_only_what_install_added(tmp_path):
    """install.sh --no-plugin registers nothing and records the no, so uninstall runs no `claude plugin` step; --plugin
    registers at user scope and a later --no-plugin takes that back; uninstall removes what a yes registered."""
    tree = fake_tree(tmp_path / "release")
    dest = tmp_path / "home" / ".thimble" / "app"
    bin_ = stub_bin(tmp_path)
    (bin_ / "claude").write_text('#!/bin/sh\necho "$*" >> "$STUB_LOG"\n'
                                 'case "$1 $2" in "--version ") echo 2.1.284;; "plugin list") echo "[]";; esac\n')
    (bin_ / "claude").chmod(0o755)
    log = tmp_path / "claude.log"
    env = env_for(tmp_path, PATH=f"{bin_}:/usr/bin:/bin", STUB_LOG=str(log))
    record = Path(env["THIMBLE_HOME"]) / "plugin.json"

    def run(cmd: list[str]) -> list[str]:
        log.write_text("")
        r = subprocess.run(cmd, capture_output=True, text=True, env=env, stdin=subprocess.DEVNULL, timeout=60)
        assert r.returncode == 0, r.stdout + r.stderr
        return [c for c in log.read_text().splitlines() if c.startswith("plugin ") and c != "plugin list --json"]

    def install(flag: str) -> list[str]:
        return run(["bash", str(tree / "scripts" / "install.sh"), "--dir", str(dest), flag, "--no-trust-workspaces"])

    uninstall = ["bash", str(dest / "plugin" / "bin" / "thimble"), "uninstall", "--yes"]
    assert install("--no-plugin") == [] and json.loads(record.read_text()) == {"answer": "no", "registered": ""}
    assert run(uninstall) == [] and not record.exists()
    assert install("--plugin") == [f"plugin marketplace add {dest}", "plugin marketplace update thimble-local",
                                   "plugin install --scope user thimble@thimble-local",
                                   "plugin update --scope user thimble@thimble-local"]
    assert json.loads(record.read_text()) == {"answer": "yes", "registered": "thimble-local"}
    taken_back = ["plugin uninstall thimble@thimble-local", "plugin marketplace remove thimble-local"]
    assert install("--no-plugin") == taken_back and json.loads(record.read_text())["registered"] == ""
    install("--plugin")
    assert run(uninstall) == taken_back and not record.exists()
