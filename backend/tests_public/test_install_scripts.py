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
# (and install.sh fetches no browser for one); `uv pip …` is written to $STUB_LOG, and `uv pip sync` of a
# requirements.txt prints $STUB_SYNC_OUT and exits with $STUB_SYNC_RC
UV_STUB = f"""#!/bin/sh
case "$1" in
  --version) echo "uv 0.0.0";;
  venv) for a; do d="$a"; done; mkdir -p "$d/bin"
        printf '#!/bin/sh\\nexec %s -S "$@"\\n' {os.path.realpath(sys.executable)} > "$d/bin/python"; chmod +x "$d/bin/python";;
  pip) echo "uv $*" >> "${{STUB_LOG:-/dev/null}}"
       case "$2 $*" in sync*requirements.txt*) printf '%s\\n' "${{STUB_SYNC_OUT:-}}"; exit "${{STUB_SYNC_RC:-0}}";; esac;;
esac
"""


def stub_bin(tmp_path: Path) -> Path:
    """uv's stand-in (UV_STUB), so install.sh runs its steps without installing anything, and a node too old for the
    frontend step ($STUB_NODE names another version; npm then prints $STUB_NPM_OUT and exits with $STUB_NPM_RC)."""
    bin_ = tmp_path / "bin"
    bin_.mkdir(exist_ok=True)
    for name, body in {"uv": UV_STUB, "node": '#!/bin/sh\necho "${STUB_NODE:-v18.0.0}"\n',
                       "npm": '#!/bin/sh\necho "${STUB_NPM_OUT:-}"; exit "${STUB_NPM_RC:-0}"\n'}.items():
        (bin_ / name).write_text(body)
        (bin_ / name).chmod(0o755)
    return bin_


ANSWERS = ("--browser", "off", "--no-sandbox-deps")  # install.sh's questions --deps-only asks, answered

# Claude Code's stand-in for the plugin commands: the marketplaces (name → folder) and the installed plugins are kept in
# $CLAUDE_STATE, and each command is appended to $STUB_LOG
CLAUDE_STUB = """#!{python} -I
import json, os, sys
path, args = os.environ["CLAUDE_STATE"], sys.argv[1:]
state = json.load(open(path)) if os.path.exists(path) else {"marketplaces": {}, "plugins": []}
with open(os.environ.get("STUB_LOG", os.devnull), "a") as log:
    log.write(" ".join(args) + "\\n")
words = [a for a in args if a not in ("--json", "--scope", "user")]
if args[:1] == ["--version"]:
    print("2.1.286 (Claude Code)")
elif words[:2] == ["plugin", "list"]:
    print(json.dumps([{"id": p, "version": "0.0.1", "scope": "user", "enabled": True} for p in state["plugins"]]))
elif words[:3] == ["plugin", "marketplace", "list"]:
    print(json.dumps([{"name": n, "source": "directory", "path": f, "installLocation": f}
                      for n, f in state["marketplaces"].items()]))
elif words[:3] == ["plugin", "marketplace", "add"]:
    folder = os.path.abspath(words[3])
    name = json.load(open(os.path.join(folder, ".claude-plugin", "marketplace.json")))["name"]
    if state["marketplaces"].get(name, folder) != folder:
        sys.exit(f"marketplace {name} is registered from another folder")
    state["marketplaces"][name] = folder
elif words[:3] == ["plugin", "marketplace", "remove"]:
    state["marketplaces"].pop(words[3], None)
elif words[:2] == ["plugin", "install"]:
    if words[2].split("@")[1] not in state["marketplaces"]:
        sys.exit("no such marketplace")
    state["plugins"] = sorted(set(state["plugins"]) | {words[2]})
elif words[:2] == ["plugin", "uninstall"]:
    state["plugins"] = [p for p in state["plugins"] if p != words[2]]
json.dump(state, open(path, "w"))
"""


def claude_stub(bin_: Path) -> None:
    (bin_ / "claude").write_text(CLAUDE_STUB.replace("{python}", os.path.realpath(sys.executable)))
    (bin_ / "claude").chmod(0o755)


def plugin_changes(log: Path) -> list[str]:
    """The `claude plugin` commands in the stand-in's log that change something (every one but the listings)."""
    return [c for c in log.read_text().splitlines() if c.startswith("plugin ") and not c.endswith("list --json")]


def install(tree: Path, dest: Path, tmp_path: Path, *flags: str, **extra: str) -> subprocess.CompletedProcess:
    env = env_for(tmp_path, PATH=f"{stub_bin(tmp_path)}:/usr/bin:/bin", **extra)
    return subprocess.run(["bash", str(tree / "scripts" / "install.sh"), "--dir", str(dest), "--deps-only", *ANSWERS,
                           *flags], capture_output=True, text=True, env=env, stdin=subprocess.DEVNULL, timeout=60)


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


def test_a_release_install_carries_the_extensions_thimble_ships(tmp_path):
    tree = fake_tree(tmp_path / "release")
    (tree / "extensions" / "video").mkdir(parents=True)
    (tree / "extensions" / "video" / "extension.json").write_text('{"name": "video"}\n')
    dest = tmp_path / "home" / ".thimble" / "app"
    r = install(tree, dest, tmp_path)
    assert r.returncode == 0, r.stdout + r.stderr
    assert (dest / "extensions" / "video" / "extension.json").read_text() == '{"name": "video"}\n'


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
    """The pins the index has kept and the newest versions the ranges allow for the others, with their hashes, and the
    packages that differ from the pins listed; --require-pinned stops there instead, and a hash mismatch always stops."""
    tree = pinned_release(tmp_path)
    dest = tmp_path / "home" / ".thimble" / "app"
    log = tmp_path / "uv.log"

    def run(fresh: bool = True, extra_flags: tuple[str, ...] = (),
            **extra: str) -> tuple[subprocess.CompletedProcess, list[str]]:
        log.write_text("")
        if fresh:
            shutil.rmtree(dest, ignore_errors=True)
        r = install(tree, dest, tmp_path, *extra_flags, STUB_LOG=str(log), **extra)
        return r, [ln.split(" --python")[0] for ln in log.read_text().splitlines()]

    r, calls = run()
    assert r.returncode == 0 and calls == [f"uv pip sync --require-hashes {tree}/backend/requirements.txt"], r.stdout
    r, calls = run(fresh=False)
    assert r.returncode == 0 and calls == [] and "installed by an earlier run" in r.stdout, "a re-run keeps them"
    missing = {"STUB_SYNC_RC": "1", "STUB_SYNC_OUT": "Because there is no version of httpx==0.28.1 and you require it"}
    r, calls = run(**missing)
    assert r.returncode == 0 and len(calls) == 3, r.stdout + r.stderr
    assert calls[1].startswith(f"uv pip compile {tree}/backend/pyproject.toml -o ") and "--generate-hashes" in calls[1]
    assert calls[2].startswith("uv pip sync --require-hashes ") and calls[2].endswith("prefs.txt")
    assert "keeps each pin the index has" in r.stdout
    venv = dest / "backend" / ".venv"  # a real environment holding an older httpx, as the ranges installed it
    shutil.rmtree(venv)
    subprocess.run([os.path.realpath(sys.executable), "-m", "venv", "--without-pip", str(venv)], check=True, timeout=60)
    [site] = venv.glob("lib/python3*/site-packages")
    (site / "httpx-0.27.2.dist-info").mkdir()
    (site / "httpx-0.27.2.dist-info" / "METADATA").write_text("Metadata-Version: 2.1\nName: httpx\nVersion: 0.27.2\n")
    r, calls = run(fresh=False, **missing)
    assert r.returncode == 0, r.stdout + r.stderr
    assert "differ from the versions backend/requirements.txt pins:\n  httpx 0.27.2 (pinned 0.28.1)" in r.stdout
    r, calls = run(**missing, extra_flags=("--require-pinned",))
    assert r.returncode == 1 and "--require-pinned" in r.stderr and len(calls) == 1, r.stdout + r.stderr
    r, calls = run(STUB_SYNC_RC="1", STUB_SYNC_OUT="Hash mismatch for `httpx==0.28.1`")
    assert r.returncode == 1 and "hash is not the one" in r.stderr and len(calls) == 1, r.stdout + r.stderr
    for rel in ("frontend/dist/index.html", "frontend/runtime/package-lock.json"):
        (tree / rel).parent.mkdir(parents=True, exist_ok=True)
        (tree / rel).write_text("{}")
    r, calls = run(STUB_NODE="v22.0.0", STUB_NPM_RC="1", STUB_NPM_OUT="npm error code EINTEGRITY")
    assert r.returncode == 1 and "frontend/runtime/package-lock.json pins" in r.stderr, "npm's hash mismatch stops it too"


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
    r = update(tmp_path, "--from", str(zp), "--browser", "off", "--no-plugin")
    assert r.returncode == 0 and f"the SHA-256 of {zp.name} matches" in r.stdout, r.stdout + r.stderr
    assert f"install.sh ran: --dir {tmp_path / 'inst'} --browser off --no-plugin" in r.stdout, "the answers passed on"
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
    ours = {str(tree): {"hasTrustDialogAccepted": True}}  # the install itself, which holds its workspaces

    def trust(*flag: str) -> dict:
        subprocess.run(["python3", "-I", str(tree / "backend" / "app" / "claude_changes.py"), "trust", str(tree), *flag],
                       capture_output=True, text=True, env=env, stdin=subprocess.DEVNULL, timeout=30, check=True)
        rec = home / "trust.json"
        return json.loads(rec.read_text()) if rec.exists() else {}

    def skipped() -> str:  # why install.sh would not ask the trust question
        cmd = ["python3", "-I", str(tree / "backend" / "app" / "claude_changes.py"), "skipped", str(tree)]
        return subprocess.run(cmd, capture_output=True, text=True, env=env, timeout=30, check=True).stdout.strip()

    assert trust() == {} and cfg.read_text() == before, "nothing is written without a yes"
    assert skipped() == ""
    yes = {"folder": str(tree), "config": str(cfg), "answer": "yes", "added": True}
    assert trust("--yes") == yes
    assert skipped() == (f"already trusted from your earlier install ({tree}); "
                         "--no-trust-workspaces changes it")
    data = json.loads(cfg.read_text())
    assert data["numStartups"] == 3 and data["projects"] == {"/x": {"lastCost": 1}, **ours}
    assert trust() == yes and json.loads(cfg.read_text()) == data, "asked once"
    assert trust("--no") == {**yes, "answer": "no", "added": False} and json.loads(cfg.read_text()) == json.loads(before)
    assert skipped() == (f"answered no at your earlier install, so {tree} is not trusted; "
                         "--trust-workspaces changes it")
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


def test_a_trusted_folder_above_a_clone_does_not_skip_the_trust_question_and_a_yes_writes_the_clone_s_entry(tmp_path):
    """A Dev install cloned into a folder Claude Code trusts, whose own entry is false (`claude --bg` refuses it):
    install.sh asks the trust question, also over the yes an earlier install recorded without adding an entry, and
    --trust-workspaces sets the clone's own entry, keeping what Claude Code keeps in it; --no-trust-workspaces takes the
    trust back."""
    parent = tmp_path / "Developer"
    tree = fake_tree(parent / "thimble", checkout=True)
    (tree / "backend" / "app").mkdir(parents=True)
    shutil.copy(REPO / "backend" / "app" / "claude_changes.py", tree / "backend" / "app")
    env = env_for(tmp_path)
    home = Path(env["THIMBLE_HOME"])
    home.mkdir()
    cfg = Path(env["HOME"]) / ".claude.json"
    kept = {"allowedTools": [], "lastAPIDuration": 1200}
    cfg.write_text(json.dumps({"projects": {str(parent): {"hasTrustDialogAccepted": True},
                                            str(tree): {"hasTrustDialogAccepted": False, **kept}}}))

    def run(*args: str) -> str:
        cmd = ["python3", "-I", str(tree / "backend" / "app" / "claude_changes.py"), *args]
        return subprocess.run(cmd, capture_output=True, text=True, env=env, stdin=subprocess.DEVNULL, timeout=30,
                              check=True).stdout.strip()

    def entry() -> dict:
        return json.loads(cfg.read_text())["projects"][str(tree)]

    assert run("question", str(tree)) and run("skipped", str(tree)) == ""
    (home / "trust.json").write_text(json.dumps({"folder": str(tree), "config": str(cfg), "answer": "yes",
                                                 "added": False}))
    assert run("question", str(tree)) and run("skipped", str(tree)) == ""
    assert "not trusted" in run("trust", str(tree)) and entry() == {"hasTrustDialogAccepted": False, **kept}
    assert run("trust", str(tree), "--yes").startswith("marked")
    assert entry() == {"hasTrustDialogAccepted": True, **kept}
    assert json.loads((home / "trust.json").read_text())["added"] is True
    assert run("question", str(tree)) == ""
    run("trust", str(tree), "--no")
    assert entry() == kept and run("question", str(tree)) == ""


@pytest.mark.skipif(not sys.platform.startswith("linux") or os.geteuid() == 0, reason="a Linux user who needs sudo")
def test_install_sh_installs_the_sandbox_s_missing_packages_only_on_a_yes_and_through_sudo(tmp_path):
    """Where bubblewrap and socat are missing, a run without a terminal needs --sandbox-deps or --no-sandbox-deps; a yes
    runs the package manager's install through sudo, a no says the agents won't run and how to set the sandbox up later.
    sudo and the package managers are stand-ins that only log."""
    tree = fake_tree(tmp_path / "release")
    bin_ = stub_bin(tmp_path)
    log = tmp_path / "sudo.log"
    for name in ("sudo", "apt-get", "dnf", "pacman", "zypper", "apk", "apparmor_parser"):
        (bin_ / name).write_text(f'#!/bin/sh\necho "{name} $*" >> "$SUDO_LOG"\n')
        (bin_ / name).chmod(0o755)
    tools = tmp_path / "tools"  # the system's programs, bwrap and socat left out
    tools.mkdir()
    for folder in ("/usr/bin", "/bin"):
        for exe in Path(folder).iterdir():
            if exe.name not in ("bwrap", "socat") and not (tools / exe.name).exists():
                (tools / exe.name).symlink_to(exe)
    env = env_for(tmp_path, PATH=f"{bin_}:{tools}", SUDO_LOG=str(log))

    def run(*flags: str) -> subprocess.CompletedProcess:
        log.write_text("")
        return subprocess.run(["bash", str(tree / "scripts" / "install.sh"), "--dir", str(tmp_path / "app"),
                               "--deps-only", "--browser", "off", *flags], capture_output=True, text=True, env=env,
                              stdin=subprocess.DEVNULL, timeout=60)

    r = run()
    assert r.returncode == 1 and "--sandbox-deps or --no-sandbox-deps" in r.stderr, r.stdout + r.stderr
    assert log.read_text() == ""
    r = run("--no-sandbox-deps")
    assert r.returncode == 0 and log.read_text() == "", r.stdout + r.stderr
    later = f"To set it up later, run: bash {tmp_path / 'app'}/scripts/install.sh --sandbox-deps"
    assert "won't run until the sandbox works" in r.stdout and later in r.stdout
    r = run("--sandbox-deps")
    assert r.returncode == 0, r.stdout + r.stderr
    assert "sudo apt-get install -y bubblewrap socat" in log.read_text().splitlines()
    assert "still doesn't run" in r.stdout, "the stand-ins installed nothing"


SYSTEM_BROWSERS = ("/opt/google/chrome/chrome", "/opt/microsoft/msedge/msedge",
                   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
                   "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge")


def test_install_sh_asks_before_it_installs_and_downloads_no_browser_without_a_yes(tmp_path):
    """On a terminal install.sh shows what it installs, then asks about the browser, the plugin and the trust; the
    browser is downloaded only on a yes, and not again once it is there; a re-run asks nothing. Without a terminal it
    refuses while a question has no flag, having downloaded nothing and written nothing into Claude Code's config."""
    import pty

    tree = fake_tree(tmp_path / "release")
    (tree / "backend" / "app").mkdir()
    shutil.copy(REPO / "backend" / "app" / "claude_changes.py", tree / "backend" / "app")
    bin_ = stub_bin(tmp_path)
    (bin_ / "claude").write_text('#!/bin/sh\ncase "$1 $2" in "--version ") echo 2.1.284;; "plugin list") echo "[]";; esac\n')
    (bin_ / "claude").chmod(0o755)
    log, cache = tmp_path / "playwright.log", tmp_path / "cache" / "chromium_headless_shell-1"

    def run(*flags: str, typed: str | None = None) -> subprocess.CompletedProcess:
        venv = tmp_path / "home" / ".thimble" / "app" / "backend" / ".venv" / "bin" / "python"
        if not venv.exists():  # a backend whose Playwright logs its downloads, and has its browser once it downloaded it
            venv.parent.mkdir(parents=True)
            shutil.copytree(tree / "plugin", venv.parents[3] / "plugin")  # an earlier install, which install.sh copies over
            venv.write_text(f"""#!/bin/sh
case "$*" in
  *"playwright install --dry-run"*) printf 'browser: chromium-headless-shell\\n  Install location:    %s\\n' {cache};;
  *"playwright install"*) echo "$*" >> {log}; mkdir -p {cache}; : > {cache}/INSTALLATION_COMPLETE;;
  *"import playwright"*) ;;
  *) exec {os.path.realpath(sys.executable)} -S "$@";;
esac
""")
            venv.chmod(0o755)
        cmd = ["bash", str(tree / "scripts" / "install.sh"), "--no-sandbox-deps", *flags]
        env = env_for(tmp_path, PATH=f"{bin_}:/usr/bin:/bin")
        if typed is None:
            return subprocess.run(cmd, capture_output=True, text=True, env=env, stdin=subprocess.DEVNULL, timeout=60)
        term, stdin = pty.openpty()
        os.write(term, typed.encode())
        try:
            return subprocess.run(cmd, capture_output=True, text=True, env=env, stdin=stdin, timeout=60)
        finally:
            os.close(term)
            os.close(stdin)

    home = tmp_path / "home"
    cfg, conf = home / ".claude.json", home / ".thimble" / "config.json"
    cfg.parent.mkdir(parents=True, exist_ok=True)
    cfg.write_text(json.dumps({"projects": {}}))
    r = run()
    system = any(Path(p).exists() for p in SYSTEM_BROWSERS)
    assert r.returncode == 1 and "[y/N]" not in r.stdout and "Not answered:" in r.stderr, r.stdout + r.stderr
    assert ("--browser bundled or --browser off" in r.stderr) != system, "a system browser found is used unasked"
    assert "--plugin or --no-plugin" in r.stderr and "--trust-workspaces or --no-trust-workspaces" in r.stderr
    assert "and only on a yes to its question:" in r.stdout
    assert not log.exists() and not conf.exists() and json.loads(cfg.read_text()) == {"projects": {}}
    r = run(typed="y\nn\ny\n")  # download, no plugin, trust
    out = r.stdout
    assert r.returncode == 0, out + r.stderr
    assert out.index("what install.sh installs, and where") < out.index("A browser for screenshots") < out.index("== 2/12")
    assert out.index("every claude session") < out.index("Trust thimble's folder") < out.index("== 2/12")
    assert log.read_text().splitlines() == ["-I -m playwright install chromium-headless-shell"]
    assert json.loads(conf.read_text()) == {"browser": "bundled"}
    assert json.loads((home / ".thimble" / "plugin.json").read_text())["answer"] == "no"
    assert json.loads(cfg.read_text())["projects"] == {str(tree.parents[0] / "home" / ".thimble" / "app"):
                                                       {"hasTrustDialogAccepted": True}}
    r = run(typed="")
    assert r.returncode == 0 and "[y/N]" not in r.stdout and "[Y/n]" not in r.stdout, r.stdout + r.stderr
    assert "only on a yes" not in r.stdout, "the plan of a re-run lists no question it will not ask"
    assert "a browser for screenshots: Playwright's headless Chromium, downloaded" in r.stdout
    assert "not fetched again" in r.stdout and len(log.read_text().splitlines()) == 1
    ws = tree.parents[0] / "home" / ".thimble" / "app"  # the release copy, which holds its workspaces
    trusted = f"the trust: already trusted from your earlier install ({ws}); --no-trust-workspaces changes it"
    assert "questions install.sh does not ask this time:\n  - the browser: answered bundled" in r.stdout
    assert f"  - {trusted}" in r.stdout, "the plan says which questions it skips, why, and the folder"
    r = run("--dry-run")
    assert f"1. the browser: answered bundled at your earlier install ({conf}); --browser changes it" in r.stdout
    assert f"3. the plugin: answered no at your earlier install ({home / '.thimble' / 'plugin.json'}); --plugin " \
           "changes it" in r.stdout
    assert f"4. {trusted}" in r.stdout, r.stdout
    r = run("--browser", "off", "--no-trust-workspaces")
    assert r.returncode == 0 and json.loads(conf.read_text()) == {"browser": "off"}, r.stdout + r.stderr
    assert json.loads(cfg.read_text())["projects"] == {} and len(log.read_text().splitlines()) == 1
    # an install before 0.3.0 kept no answers but downloaded the Chromium: an update without a terminal asks no browser
    # question, and names `thimble update` for the flags it lacks
    conf.unlink()
    (home / ".thimble" / "plugin.json").unlink()
    r = run()
    assert r.returncode == 1 and "--browser" not in r.stderr and "--plugin or --no-plugin" in r.stderr, r.stderr
    assert "run `thimble update` again with a flag for each" in r.stderr


def test_the_plugin_is_registered_only_on_a_yes_and_uninstall_removes_only_what_install_added(tmp_path):
    """install.sh --no-plugin registers nothing and records the no, so uninstall runs no `claude plugin` step; --plugin
    registers at user scope and a later --no-plugin takes that back; uninstall removes what a yes registered."""
    tree = fake_tree(tmp_path / "release")
    dest = tmp_path / "home" / ".thimble" / "app"
    bin_ = stub_bin(tmp_path)
    claude_stub(bin_)
    log = tmp_path / "claude.log"
    env = env_for(tmp_path, PATH=f"{bin_}:/usr/bin:/bin", STUB_LOG=str(log), CLAUDE_STATE=str(tmp_path / "claude.json"))
    record = Path(env["THIMBLE_HOME"]) / "plugin.json"

    def run(cmd: list[str]) -> list[str]:
        log.write_text("")
        r = subprocess.run(cmd, capture_output=True, text=True, env=env, stdin=subprocess.DEVNULL, timeout=60)
        assert r.returncode == 0, r.stdout + r.stderr
        return plugin_changes(log)

    def install(flag: str) -> list[str]:
        return run(["bash", str(tree / "scripts" / "install.sh"), "--dir", str(dest), *ANSWERS, flag,
                    "--no-trust-workspaces"])

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


def test_thimble_cc_mod_s_marketplace_outlives_a_no_and_uninstall_removes_it(tmp_path):
    """`thimble cc-mod on` registers thimble's marketplace when a no left it out. A --no-plugin re-run leaves it; a yes
    then a no takes back the thimble plugin and keeps the marketplace while thimble-cc-mod from it is on, since removing
    a marketplace turns its plugins off; uninstall removes the marketplace and names what that turns off."""
    tree = fake_tree(tmp_path / "release")
    dest = tmp_path / "home" / ".thimble" / "app"
    bin_ = stub_bin(tmp_path)
    claude_stub(bin_)
    log, state = tmp_path / "claude.log", tmp_path / "claude.json"
    env = env_for(tmp_path, PATH=f"{bin_}:/usr/bin:/bin", STUB_LOG=str(log), CLAUDE_STATE=str(state))
    record = Path(env["THIMBLE_HOME"]) / "plugin.json"

    def run(cmd: list[str]) -> tuple[str, list[str]]:
        log.write_text("")
        r = subprocess.run(cmd, capture_output=True, text=True, env=env, stdin=subprocess.DEVNULL, timeout=60)
        assert r.returncode == 0, r.stdout + r.stderr
        return r.stdout, plugin_changes(log)

    def install(flag: str) -> list[str]:
        return run(["bash", str(tree / "scripts" / "install.sh"), "--dir", str(dest), *ANSWERS, flag,
                    "--no-trust-workspaces"])[1]

    assert install("--no-plugin") == []
    state.write_text(json.dumps({"marketplaces": {"thimble-local": str(dest)}, "plugins": ["thimble-cc-mod@thimble-local"]}))
    assert install("--no-plugin") == [] and json.loads(record.read_text()) == {"answer": "no", "registered": ""}
    assert install("--plugin")[-2:] == ["plugin install --scope user thimble@thimble-local",
                                        "plugin update --scope user thimble@thimble-local"]
    assert install("--no-plugin") == ["plugin uninstall thimble@thimble-local"]
    assert json.loads(state.read_text())["marketplaces"] == {"thimble-local": str(dest)}
    assert json.loads(record.read_text()) == {"answer": "no", "registered": ""}
    out, changes = run(["bash", str(dest / "plugin" / "bin" / "thimble"), "uninstall", "--yes"])
    assert changes == ["plugin marketplace remove thimble-local"] and "thimble-cc-mod off" in out, out
    assert json.loads(state.read_text())["marketplaces"] == {}


def two_checkouts(tmp_path: Path) -> tuple[Path, Path, dict[str, str]]:
    """A first checkout whose plugin Claude Code has registered (marketplace "thimble") and which ~/.local/bin/thimble
    runs, and a second checkout with its own THIMBLE_HOME under the same HOME; the second's environment."""
    first, second = (fake_tree(tmp_path / d / "thimble", checkout=True) for d in ("dev", "clone"))
    for tree in (first, second):
        (tree / ".claude-plugin" / "marketplace.json").write_text(json.dumps({"name": "thimble"}))
    (second / "frontend" / "dist").mkdir(parents=True)
    (second / "frontend" / "dist" / "index.html").write_text("<!doctype html>\n")
    bin_ = stub_bin(tmp_path)
    claude_stub(bin_)
    (tmp_path / "claude.json").write_text(json.dumps({"marketplaces": {"thimble": str(first)},
                                                      "plugins": ["thimble@thimble"]}))
    env = env_for(tmp_path, PATH=f"{bin_}:/usr/bin:/bin", CLAUDE_STATE=str(tmp_path / "claude.json"),
                  STUB_LOG=str(tmp_path / "claude.log"), THIMBLE_HOME=str(tmp_path / "second-home"))
    link = Path(env["HOME"]) / ".local" / "bin" / "thimble"
    link.parent.mkdir(parents=True)
    link.symlink_to(first / "plugin" / "bin" / "thimble")
    return first, second, env


def test_install_sh_leaves_another_installs_plugin_and_command_as_they_are(tmp_path):
    """A second install under the same HOME finds Claude Code's thimble plugin registered from the first install's folder
    and ~/.local/bin/thimble linked into it. Neither is its own: --no-plugin uninstalls nothing, --plugin adds no second
    plugin beside it, and the link stays; install.sh names the first install's folder and the command that would switch
    the link, and its dry run shows the same. On a terminal it asks before switching either. A THIMBLE_HOME shared with
    the first install, whose record names that registration, does not make it the second's either."""
    import pty

    first, second, env = two_checkouts(tmp_path)
    state, log = Path(env["CLAUDE_STATE"]), Path(env["STUB_LOG"])
    link = Path(env["HOME"]) / ".local" / "bin" / "thimble"
    registered, linked = state.read_text(), str(first / "plugin" / "bin" / "thimble")
    record = Path(env["THIMBLE_HOME"]) / "plugin.json"
    switch_link = f"ln -sfn {second}/plugin/bin/thimble {link}"

    def run(*flags: str, typed: str | None = None) -> tuple[subprocess.CompletedProcess, list[str]]:
        log.write_text("")
        cmd = ["bash", str(second / "scripts" / "install.sh"), *ANSWERS, "--no-trust-workspaces", *flags]
        if typed is None:
            r = subprocess.run(cmd, capture_output=True, text=True, env=env, stdin=subprocess.DEVNULL, timeout=60)
        else:
            term, stdin = pty.openpty()
            os.write(term, typed.encode())
            try:
                r = subprocess.run(cmd, capture_output=True, text=True, env=env, stdin=stdin, timeout=60)
            finally:
                os.close(term)
                os.close(stdin)
        assert r.returncode == 0, r.stdout + r.stderr
        return r, plugin_changes(log)

    def untouched() -> bool:
        return state.read_text() == registered and os.readlink(link) == linked

    for flags in (("--plugin",), ("--no-plugin",), ("--plugin", "--dry-run"), ("--no-plugin", "--dry-run")):
        r, changes = run(*flags)
        assert changes == [] and untouched(), (flags, changes, r.stdout)
        assert f"thimble@thimble, from {first}" in r.stdout and switch_link in r.stdout, r.stdout
        assert "+ ln -sfn" not in r.stdout and "[y/N]" not in r.stdout
    assert json.loads(record.read_text()) == {"answer": "no", "registered": ""}
    r, changes = run("--plugin", typed="n\nn\n")
    assert r.stdout.count("[y/N]") == 2 and changes == [] and untouched(), r.stdout
    assert json.loads(record.read_text()) == {"answer": "yes", "registered": ""}
    r, changes = run("--plugin", typed="y\ny\n")
    assert changes == ["plugin uninstall thimble@thimble", "plugin marketplace remove thimble",
                       f"plugin marketplace add {second}", "plugin marketplace update thimble",
                       "plugin install --scope user thimble@thimble", "plugin update --scope user thimble@thimble"]
    assert json.loads(state.read_text())["marketplaces"] == {"thimble": str(second)}
    assert os.readlink(link) == f"{second}/plugin/bin/thimble"
    # the first install's own record, in a THIMBLE_HOME both installs share
    state.write_text(registered)
    link.unlink()
    link.symlink_to(linked)
    record.write_text(json.dumps({"answer": "yes", "registered": "thimble"}))
    for flags in (("--no-plugin",), ("--plugin",)):
        r, changes = run(*flags)
        assert changes == [] and untouched(), (flags, changes, r.stdout)


def test_uninstall_removes_the_plugin_only_when_it_is_registered_from_this_install(tmp_path):
    """thimble uninstall removes thimble@<name> only when Claude Code has it from this install's folder: another
    checkout's registration under the same name stays, as does the link into that checkout, whether or not a record
    (here one the other install wrote into a THIMBLE_HOME both share) names it."""
    first, second, env = two_checkouts(tmp_path)
    state, log, home = Path(env["CLAUDE_STATE"]), Path(env["STUB_LOG"]), Path(env["THIMBLE_HOME"])
    link = Path(env["HOME"]) / ".local" / "bin" / "thimble"
    registered = state.read_text()

    def uninstall() -> list[str]:
        home.mkdir(exist_ok=True)
        (home / "app-dir").write_text(f"{second}\n")
        log.write_text("")
        r = subprocess.run(["bash", str(second / "plugin" / "bin" / "thimble"), "uninstall", "--yes"],
                           capture_output=True, text=True, env=env, stdin=subprocess.DEVNULL, timeout=60)
        assert r.returncode == 0, r.stdout + r.stderr
        return plugin_changes(log)

    assert uninstall() == [] and state.read_text() == registered
    assert os.readlink(link) == str(first / "plugin" / "bin" / "thimble")
    home.mkdir()
    (home / "plugin.json").write_text(json.dumps({"answer": "yes", "registered": "thimble"}))
    assert uninstall() == [] and state.read_text() == registered
    state.write_text(json.dumps({"marketplaces": {"thimble": str(second)}, "plugins": ["thimble@thimble"]}))
    assert uninstall() == ["plugin uninstall thimble@thimble", "plugin marketplace remove thimble"]


def test_thimble_bin_dir_moves_the_command_s_link_and_leaves_the_one_in_local_bin_alone(tmp_path):
    """With THIMBLE_BIN_DIR set, the `thimble` link goes there, and a ~/.local/bin/thimble into another tree stays."""
    tree = fake_tree(tmp_path / "release")
    dest = tmp_path / "home" / ".thimble" / "app"
    bin_ = stub_bin(tmp_path)
    own = tmp_path / "own-bin"
    env = env_for(tmp_path, PATH=f"{bin_}:/usr/bin:/bin", THIMBLE_BIN_DIR=str(own))
    other = tmp_path / "other" / "plugin" / "bin" / "thimble"
    local = Path(env["HOME"]) / ".local" / "bin" / "thimble"
    local.parent.mkdir(parents=True)
    local.symlink_to(other)
    r = subprocess.run(["bash", str(tree / "scripts" / "install.sh"), "--dir", str(dest), *ANSWERS, "--no-plugin",
                        "--no-trust-workspaces"], capture_output=True, text=True, env=env, stdin=subprocess.DEVNULL,
                       timeout=60)
    assert r.returncode == 0, r.stdout + r.stderr
    assert os.readlink(own / "thimble") == str(dest / "plugin" / "bin" / "thimble")
    assert os.readlink(local) == str(other)
