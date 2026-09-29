"""scripts/install.sh, scripts/update.sh and plugin/bin/thimble's uninstall, run for real against invented trees under
tmp_path with a throwaway HOME: the Python they start never imports a module from the folder they run in."""
from __future__ import annotations

import json
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
