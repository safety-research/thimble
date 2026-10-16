"""scripts/install.sh, scripts/update.sh and plugin/bin/thimble's uninstall, run for real against invented trees under
tmp_path with a throwaway HOME: the Python they start never imports a module from the folder they run in."""
from __future__ import annotations

import json
import os
import re
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
    for rel in ("scripts/install.sh", "scripts/plugin.sh", "scripts/update.sh", "plugin/bin/thimble",
                "plugin/bin/thimble-app-dir"):
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
    """A throwaway HOME, and SHELL so that the startup file install.sh writes does not depend on the machine's user."""
    home = tmp_path / "home"
    home.mkdir(exist_ok=True)
    return {"PATH": "/usr/bin:/bin", "HOME": str(home), "THIMBLE_HOME": str(home / ".thimble"), "SHELL": "/bin/sh",
            **extra}


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


ANSWERS = ("--browser", "off")  # install.sh's question, answered

# Claude Code's stand-in for the plugin commands: the marketplaces (name → folder) and the installed plugins are kept in
# $CLAUDE_STATE, and each command is appended to $STUB_LOG. A plugin is its id (installed at user scope) or, as
# `claude plugin list --json` lists one, {"id", "scope", "projectPath"}; `plugin uninstall --scope project|local` takes
# out the one of the folder it runs in. `plugin install` and `plugin update` record the version of the plugin.json in
# the marketplace's folder ("versions", else 0.0.1), and `plugin disable` and `enable` switch it ("disabled")
CLAUDE_STUB = """#!{python} -I
import json, os, sys
path, args = os.environ["CLAUDE_STATE"], sys.argv[1:]
state = json.load(open(path)) if os.path.exists(path) else {"marketplaces": {}, "plugins": []}
with open(os.environ.get("STUB_LOG", os.devnull), "a") as log:
    log.write(" ".join(args) + "\\n")
words = [a for a in args if a not in ("--json", "--scope", "user", "project", "local")]
scope = args[args.index("--scope") + 1] if "--scope" in args else "user"
here = os.path.realpath(os.getcwd())
versions, disabled = state.get("versions", {}), state.get("disabled", [])


def taken(p):
    if not isinstance(p, dict):
        return p == words[2] and scope == "user"
    return p["id"] == words[2] and p["scope"] == scope and (scope == "user" or os.path.realpath(p["projectPath"]) == here)


def folder_version(pid):
    folder = state["marketplaces"].get(pid.split("@")[1], "")
    return json.load(open(os.path.join(folder, "plugin", ".claude-plugin", "plugin.json")))["version"]


if args[:1] == ["--version"]:
    print("2.1.286 (Claude Code)")
elif words[:2] == ["plugin", "list"]:
    print(json.dumps([p if isinstance(p, dict) else {"id": p, "version": versions.get(p, "0.0.1"), "scope": "user",
                                                     "enabled": p not in disabled}
                      for p in state["plugins"]]))
elif words[:2] in (["plugin", "disable"], ["plugin", "enable"]):
    state["disabled"] = sorted(set(disabled) - {words[2]} | ({words[2]} if words[1] == "disable" else set()))
elif words[:2] == ["plugin", "update"]:
    state["versions"] = {**versions, words[2]: folder_version(words[2])}
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
    state["plugins"] = sorted({p for p in state["plugins"] if isinstance(p, str)} | {words[2]}) + \\
        [p for p in state["plugins"] if isinstance(p, dict)]
    state["versions"] = {**versions, words[2]: folder_version(words[2])}
elif words[:2] == ["plugin", "uninstall"]:
    state["plugins"] = [p for p in state["plugins"] if not taken(p)]
json.dump(state, open(path, "w"))
"""


def claude_stub(bin_: Path) -> None:
    (bin_ / "claude").write_text(CLAUDE_STUB.replace("{python}", os.path.realpath(sys.executable)))
    (bin_ / "claude").chmod(0o755)


def plugin_changes(log: Path) -> list[str]:
    """The `claude plugin` commands in the stand-in's log that change something (every one but the listings)."""
    return [c for c in log.read_text().splitlines() if c.startswith("plugin ") and not c.endswith("list --json")]


def install(tree: Path, dest: Path, tmp_path: Path, *flags: str, **extra: str) -> subprocess.CompletedProcess:
    """install.sh --deps-only with --verbose, whose stdout then has the commands it runs (and, with --dry-run, would run)
    and their output, which the terminal otherwise leaves to the log."""
    env = env_for(tmp_path, PATH=f"{stub_bin(tmp_path)}:/usr/bin:/bin", **extra)
    return subprocess.run(["bash", str(tree / "scripts" / "install.sh"), "--dir", str(dest), "--deps-only", "--verbose",
                           *ANSWERS, *flags], capture_output=True, text=True, env=env, stdin=subprocess.DEVNULL, timeout=60)


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


def git(cwd: Path, *args: str) -> str:
    """git in `cwd` with no global or system config, as a test's throwaway HOME gives it."""
    env = {"PATH": "/usr/bin:/bin", "HOME": str(cwd), "GIT_CONFIG_NOSYSTEM": "1"}
    return subprocess.run(["git", "-C", str(cwd), *args], capture_output=True, text=True, env=env, check=True,
                          timeout=60).stdout.strip()


@pytest.mark.skipif(not (shutil.which("git") and shutil.which("unzip")), reason="a git baseline, and update.sh unzips")
def test_update_keeps_the_changes_since_the_release_on_a_branch_and_resets_to_the_release(tmp_path):
    """3.16: before a release install takes the next release, update.sh puts its commits after the baseline (a code
    ticket's), its edits not committed and its new files on a branch local-fixes-<date>, says so in one line naming the
    branch and the folder, and resets the tree to the baseline."""
    inst = fake_tree(tmp_path / "inst")
    (inst / "RELEASE.json").write_text(json.dumps({"version": "0.0.1"}))
    git(inst, "init", "-q")
    git(inst, "config", "user.name", "thimble")
    git(inst, "config", "user.email", "thimble@localhost")
    git(inst, "add", "--all", ".")
    git(inst, "commit", "-q", "-m", "thimble 0.0.1")
    git(inst, "update-ref", "refs/thimble/baseline", "HEAD")
    base = git(inst, "rev-parse", "HEAD")
    (inst / "backend" / "pyproject.toml").write_text('[project]\nrequires-python = ">=3.13"\n')
    git(inst, "commit", "-q", "-am", "a code ticket's change")
    (inst / "README.md").write_text("an edit\n")
    (inst / "backend" / "fix.py").write_text("x = 1\n")
    zp = release_zip(tmp_path)
    r = update(tmp_path, "--from", str(zp))
    assert r.returncode == 0, r.stdout + r.stderr
    [line] = [ln for ln in r.stdout.splitlines() if "local-fixes-" in ln]
    branch = re.search(r"local-fixes-[0-9-]+", line).group(0)
    assert line.endswith(f"on the branch {branch} in {inst}")
    assert git(inst, "rev-parse", "HEAD") == base and not (inst / "backend" / "fix.py").exists()
    assert ">=3.13" in git(inst, "show", f"{branch}:backend/pyproject.toml")
    assert git(inst, "show", f"{branch}:README.md") == "an edit" and git(inst, "show", f"{branch}:backend/fix.py") == "x = 1"
    assert git(inst, "log", "--format=%s", branch).splitlines()[1:] == ["a code ticket's change", "thimble 0.0.1"]
    r = update(tmp_path, "--from", str(zp))
    assert r.returncode == 0 and "local-fixes-" not in r.stdout, "nothing since the release: no branch"


def test_uninstall_with_keep_home_still_removes_the_sign_in_files_and_the_session_markers(tmp_path):
    """3.15 and 3.21: a kept home keeps its server state and workspaces, but not the press's sign-in files and one-time
    links (open/, links/), the sessions' markers with their guide markers (up/) or the folders' markers (active/)."""
    tree = fake_tree(tmp_path / "app")
    env = env_for(tmp_path)
    home = Path(env["THIMBLE_HOME"])
    home.mkdir()
    (home / "app-dir").write_text(f"{tree}\n")
    (home / "plugin.json").write_text(json.dumps({"registered": ""}))  # install.sh registered no plugin
    for rel in ("open/a1.html", "links/s1.json", "up/s1.active", "up/s1/guide-marker", "active/%w%corpus",
                "workspaces/w/notebook.json"):
        (home / rel).parent.mkdir(parents=True, exist_ok=True)
        (home / rel).write_text("x")
    r = subprocess.run(["bash", str(tree / "plugin" / "bin" / "thimble"), "uninstall", "--yes", "--keep-home"],
                       capture_output=True, text=True, env=env, stdin=subprocess.DEVNULL, timeout=60)
    assert r.returncode == 0, r.stdout + r.stderr
    assert sorted(p.name for p in home.iterdir()) == ["app-dir", "workspaces"]
    assert "the browser's sign-in files and one-time links, and the markers of the sessions and folders" in r.stdout


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
    r = update(tmp_path, "--from", str(zp), "--browser", "off", "--no-plugin", "--no-modify-path")
    assert r.returncode == 0 and f"the SHA-256 of {zp.name} matches" in r.stdout, r.stdout + r.stderr
    assert f"install.sh ran: --dir {tmp_path / 'inst'} --browser off --no-plugin --no-modify-path" in r.stdout, \
        "the answers passed on"
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


def test_install_sh_adds_the_plugin_with_claude_code_s_commands_and_uninstall_removes_what_it_added(tmp_path):
    """install.sh adds this install's folder as a marketplace and installs thimble from it at user scope, with Claude
    Code's own commands, and says so on its opening screen; it removes the record 0.7's plugin question left. --no-plugin
    runs no `claude plugin` command that changes anything. Uninstall removes what install added."""
    tree = fake_tree(tmp_path / "release")
    dest = tmp_path / "home" / ".thimble" / "app"
    bin_ = stub_bin(tmp_path)
    claude_stub(bin_)
    log = tmp_path / "claude.log"
    env = env_for(tmp_path, PATH=f"{bin_}:/usr/bin:/bin", STUB_LOG=str(log), CLAUDE_STATE=str(tmp_path / "claude.json"))
    record = Path(env["THIMBLE_HOME"]) / "plugin.json"

    def run(cmd: list[str]) -> tuple[str, list[str]]:
        log.write_text("")
        r = subprocess.run(cmd, capture_output=True, text=True, env=env, stdin=subprocess.DEVNULL, timeout=60)
        assert r.returncode == 0, r.stdout + r.stderr
        return r.stdout, plugin_changes(log)

    def install(*flags: str) -> tuple[str, list[str]]:
        return run(["bash", str(tree / "scripts" / "install.sh"), "--dir", str(dest), *ANSWERS, *flags])

    uninstall = ["bash", str(dest / "plugin" / "bin" / "thimble"), "uninstall", "--yes"]
    out, changes = install("--no-plugin")
    assert changes == [] and "✓ thimble's plugin: left as it is (--no-plugin)" in out, out
    assert "✓ Claude Code's plugins left as they are (--no-plugin)" in out
    assert run(uninstall)[1] == []
    out, changes = install("--dry-run")
    assert changes == [] and ("✓ adds thimble's plugin with Claude Code's own commands: claude plugin marketplace add "
                              "~/.thimble/app, then claude plugin install --scope user thimble@thimble-local (Claude Code "
                              "writes it to ~/.claude/settings.json and ~/.claude/plugins)") in out, out
    record.parent.mkdir(parents=True, exist_ok=True)
    record.write_text(json.dumps({"answer": "no", "registered": ""}))  # 0.7's no
    out, changes = install()
    assert changes == [f"plugin marketplace add {dest}", "plugin install --scope user thimble@thimble-local"], out
    assert "✓ Added thimble's plugin to Claude Code (thimble@thimble-local): /thimble works in any claude session" in out
    assert "Next: in a folder of transcripts, start claude and type /thimble (in a session that was open before, " \
           "/reload-plugins first), or run thimble there." in out, out
    assert not record.exists(), "0.7's record goes once the plugin is in place"
    assert run(uninstall)[1] == ["plugin uninstall thimble@thimble-local", "plugin marketplace remove thimble-local"]


# ----------------------------------------------------------------------------- the shell startup files


STARTUP_FILES = (".bash_login", ".bash_profile", ".bashrc", ".config/fish/conf.d/thimble.fish", ".profile", ".zshrc")


def startup(home: Path) -> dict[str, str]:
    """{each startup file under HOME: its text}."""
    return {f: (home / f).read_text() for f in STARTUP_FILES if (home / f).exists()}
