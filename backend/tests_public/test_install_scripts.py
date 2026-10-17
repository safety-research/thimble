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
# requirements.txt prints $STUB_SYNC_OUT and exits with $STUB_SYNC_RC. `uv sync` makes .venv the same way and says, as
# uv does, that it checked the packages, or with $STUB_UV_SYNC set that it installed those
UV_STUB = f"""#!/bin/sh
case "$1" in
  --version) echo "uv 0.0.0";;
  venv) for a; do d="$a"; done; mkdir -p "$d/bin"
        printf '#!/bin/sh\\nexec %s -S "$@"\\n' {os.path.realpath(sys.executable)} > "$d/bin/python"; chmod +x "$d/bin/python";;
  sync) mkdir -p .venv/bin
        printf '#!/bin/sh\\nexec %s -S "$@"\\n' {os.path.realpath(sys.executable)} > .venv/bin/python; chmod +x .venv/bin/python
        if [ -n "${{STUB_UV_SYNC:-}}" ]; then echo "Installed 1 package in 1ms"; echo "$STUB_UV_SYNC"
        else echo "Checked 3 packages in 1ms"; fi;;
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
# the marketplace's folder ("versions", else 0.0.1), and `plugin disable` and `enable` switch it ("disabled"). As Claude
# Code does, `plugin install` copies the marketplace's plugin/ into a cache beside $CLAUDE_STATE ("copies", listed as
# installPath), `plugin update` copies it again only for another version, and `plugin uninstall` drops the options set
# with `plugin configure --values-stdin` ("options", which `plugin configure --json` lists) and the on or off; with
# "inplace" set, `plugin list` names the marketplace's plugin/ as readFromFolder, as Claude Code 2.1.301 does
CLAUDE_STUB = """#!{python} -I
import json, os, shutil, sys
path, args = os.environ["CLAUDE_STATE"], sys.argv[1:]
state = json.load(open(path)) if os.path.exists(path) else {"marketplaces": {}, "plugins": []}
with open(os.environ.get("STUB_LOG", os.devnull), "a") as log:
    log.write(" ".join(args) + "\\n")
words = [a for a in args if not a.startswith("--") and a not in ("user", "project", "local")]
scope = args[args.index("--scope") + 1] if "--scope" in args else "user"
here = os.path.realpath(os.getcwd())
versions, disabled = state.get("versions", {}), state.get("disabled", [])
copies, options = state.setdefault("copies", {}), state.setdefault("options", {})


def taken(p):
    if not isinstance(p, dict):
        return p == words[2] and scope == "user"
    return p["id"] == words[2] and p["scope"] == scope and (scope == "user" or os.path.realpath(p["projectPath"]) == here)


def plugin_dir(pid):
    return os.path.join(state["marketplaces"].get(pid.split("@")[1], ""), "plugin")


def folder_version(pid):
    return json.load(open(os.path.join(plugin_dir(pid), ".claude-plugin", "plugin.json")))["version"]


def copy(pid):
    to = os.path.join(os.path.dirname(path), "cache", pid.split("@")[1], folder_version(pid))
    shutil.rmtree(to, ignore_errors=True)
    shutil.copytree(plugin_dir(pid), to, symlinks=True)
    copies[pid] = to


def listed(p):
    row = {"id": p, "version": versions.get(p, "0.0.1"), "scope": "user", "enabled": p not in disabled}
    if p in copies:
        row["installPath"] = copies[p]
    if state.get("inplace"):
        row["readFromFolder"] = plugin_dir(p)
    return row


if args[:1] == ["--version"]:
    print("2.1.286 (Claude Code)")
elif words[:2] == ["plugin", "list"]:
    print(json.dumps([p if isinstance(p, dict) else listed(p) for p in state["plugins"]]))
elif words[:2] in (["plugin", "disable"], ["plugin", "enable"]):
    state["disabled"] = sorted(set(disabled) - {words[2]} | ({words[2]} if words[1] == "disable" else set()))
elif words[:2] == ["plugin", "update"]:
    if folder_version(words[2]) != versions.get(words[2]):
        copy(words[2])
    state["versions"] = {**versions, words[2]: folder_version(words[2])}
elif words[:2] == ["plugin", "configure"] and "--values-stdin" in args:
    options[words[2]] = {**options.get(words[2], {}), **json.load(sys.stdin)}
elif words[:2] == ["plugin", "configure"]:
    if words[2] not in state["plugins"]:
        sys.exit(f"No installed plugin has the id {words[2]}")
    set_ = options.get(words[2], {})
    print(json.dumps({"inputs": {"labels": "true", **set_}, "configured": sorted(set_)}))
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
    copy(words[2])
elif words[:2] == ["plugin", "uninstall"]:
    state["plugins"] = [p for p in state["plugins"] if not taken(p)]
    if scope == "user":
        copies.pop(words[2], None), options.pop(words[2], None)
        state["disabled"] = [p for p in disabled if p != words[2]]
json.dump(state, open(path, "w"))
"""


def claude_stub(bin_: Path) -> None:
    (bin_ / "claude").write_text(CLAUDE_STUB.replace("{python}", os.path.realpath(sys.executable)))
    (bin_ / "claude").chmod(0o755)


def plugin_changes(log: Path) -> list[str]:
    """The `claude plugin` commands in the stand-in's log that change something (every one but the listings and the
    read of the options)."""
    return [c for c in log.read_text().splitlines()
            if c.startswith("plugin ") and not c.endswith("list --json") and not c.startswith("plugin configure --json")]


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
    """3.15 and 3.21, bug hunt F15: a kept home keeps its settings, server state and the rest, but not the browsers'
    sign-in keys (paired.json, session.key), the press's sign-in files and one-time links (open/, links/), the sessions'
    markers with their guide markers (up/) or the folders' markers (active/). The plan names what stays exactly, says
    that a Dev install's workspaces are in the clone, and that the downloaded headless Chromium stays."""
    tree = fake_tree(tmp_path / "thimble", checkout=True)
    env = env_for(tmp_path)
    home = Path(env["THIMBLE_HOME"])
    home.mkdir()
    (home / "app-dir").write_text(f"{tree}\n")
    (home / "plugin.json").write_text(json.dumps({"registered": ""}))  # install.sh registered no plugin
    for rel in ("open/a1.html", "links/s1.json", "up/s1.active", "up/s1/guide-marker", "active/%w%corpus", "paired.json",
                "session.key", "config.json", "demo/collusion-wiki/f", "server.log", "tour.json"):
        (home / rel).parent.mkdir(parents=True, exist_ok=True)
        (home / rel).write_text("x")
    browsers = tmp_path / "home" / ".cache" / "ms-playwright"
    (browsers / "chromium_headless_shell-1200").mkdir(parents=True)
    r = subprocess.run(["bash", str(tree / "plugin" / "bin" / "thimble"), "uninstall", "--yes", "--keep-home"],
                       capture_output=True, text=True, env=env, stdin=subprocess.DEVNULL, timeout=60)
    assert r.returncode == 0, r.stdout + r.stderr
    assert sorted(p.name for p in home.iterdir()) == ["app-dir", "config.json", "demo", "server.log", "tour.json"]
    assert ": the browsers' sign-in files and keys (every browser signs in again), the one-time links, and the markers " \
           "of the sessions and folders thimble was on in" in r.stdout, r.stdout
    assert (f"  {home} stays (--keep-home), with your settings (config.json); the demo datasets you downloaded (demo/); "
            "logs (server.log); thimble's own state (app-dir, tour.json)\n") in r.stdout, r.stdout
    assert f"the clone at {tree} is left in place, with your workspaces (notebooks, labels, reports) in {tree}/workspaces" \
           in r.stdout
    assert f"the headless Chromium for screenshots stays in {browsers}" in r.stdout


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


@pytest.mark.skipif(not shutil.which("unzip"), reason="update.sh unpacks with unzip")
def test_update_dry_run_shows_the_install_s_own_dry_run_and_thimble_help_lists_it(tmp_path):
    """`thimble update --dry-run` changes nothing. From a zip it checks it, unpacks it into a temporary folder and runs
    that release's install.sh with --dry-run; in a checkout it prints the pull and runs install.sh's dry run, which
    names `thimble update` as the command that installs. `thimble help` lists --dry-run."""
    zp = release_zip(tmp_path / "rel")
    inst = fake_tree(tmp_path / "rel" / "inst")
    before = sorted(p.relative_to(inst).as_posix() for p in inst.rglob("*"))
    r = update(tmp_path / "rel", "--from", str(zp), "--dry-run")
    assert r.returncode == 0, r.stdout + r.stderr
    assert "thimble update --dry-run: what the update would do; nothing changes" in r.stdout and "update.sh" not in r.stdout
    assert f"the release install.sh ran: --dir {inst} --dry-run" in r.stdout, r.stdout
    assert sorted(p.relative_to(inst).as_posix() for p in inst.rglob("*")) == before, "nothing changed"

    clone = fake_tree(tmp_path / "dev" / "inst", checkout=True)
    r = update(tmp_path / "dev", "--dry-run", "--browser", "off", path=f"{stub_bin(tmp_path / 'dev')}:/usr/bin:/bin",
               STUB_NODE="v22.13.0")
    assert r.returncode == 0, r.stdout + r.stderr
    assert f"+ git -C {clone} pull --ff-only" in r.stdout and "installer · Dev install" in r.stdout, r.stdout
    assert "Nothing to ask: install with  thimble update" in r.stdout and not (clone / "backend" / ".venv").exists()

    usage = subprocess.run(["bash", str(inst / "plugin" / "bin" / "thimble"), "help"], capture_output=True, text=True,
                           env=env_for(tmp_path / "rel"), timeout=60)
    assert "thimble update [--from <zip>] [--dry-run]" in usage.stdout, usage.stdout


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
    assert "✓ Added thimble's plugin to Claude Code (thimble@thimble-local): thimble is on in every claude session" in out
    assert ("\nNext: run claude in a folder with your files. thimble is on in every session.\n"
            "  /thimble browser opens the same session in the browser workbench.\n"
            "  /plugin turns thimble on or off.\n") in out, "the README's way to start: " + out
    assert "thimble mode" not in out and "type /thimble" not in out, out
    assert not record.exists(), "0.7's record goes once the plugin is in place"
    assert run(uninstall)[1] == ["plugin uninstall thimble@thimble-local", "plugin marketplace remove thimble-local"]


def test_a_re_run_installs_the_plugin_again_when_its_files_changed_at_the_same_version(tmp_path):
    """While the version stays the same (a checkout between releases), a re-run compares the copy of the plugin Claude
    Code loads with this install's plugin/: a copy whose files differ is uninstalled and installed again with Claude
    Code's own commands, keeping the options the user set and its off; an unchanged copy, or plugin/ itself when Claude
    Code reads it in place, gets no command; a new version is updated. One line says which, and the opening screen says
    what a run will do."""
    tree = fake_tree(tmp_path / "release")
    dest = tmp_path / "home" / ".thimble" / "app"
    bin_ = stub_bin(tmp_path)
    claude_stub(bin_)
    log, state = tmp_path / "claude.log", tmp_path / "claude.json"
    env = env_for(tmp_path, PATH=f"{bin_}:/usr/bin:/bin", STUB_LOG=str(log), CLAUDE_STATE=str(state))
    pid = "thimble@thimble-local"
    marker = tree / "plugin" / "bin" / "thimble-app-dir"

    def install(*flags: str) -> tuple[str, list[str]]:
        log.write_text("")
        r = subprocess.run(["bash", str(tree / "scripts" / "install.sh"), "--dir", str(dest), *ANSWERS, *flags],
                           capture_output=True, text=True, env=env, stdin=subprocess.DEVNULL, timeout=60, check=False)
        assert r.returncode == 0, r.stdout + r.stderr
        return r.stdout, plugin_changes(log)

    def claude(*args: str, stdin: str = "") -> None:
        subprocess.run([str(bin_ / "claude"), *args], input=stdin, text=True, env=env, check=True, timeout=60)

    install()
    out, changes = install()
    assert changes == [] and f"✓ thimble's plugin in Claude Code is this install's, unchanged ({pid} 0.0.1): nothing to " \
                             "update" in out, out
    claude("plugin", "configure", "--values-stdin", pid, stdin='{"labels": "false"}')
    claude("plugin", "disable", "--scope", "user", pid)
    copy = Path(json.loads(state.read_text())["copies"][pid])
    (copy / "bin" / "__pycache__").mkdir()
    (copy / "bin" / "__pycache__" / "thimble-mcp.pyc").write_bytes(b"a run")  # what running the copy adds to it
    (tree / "plugin" / "hooks" / "term" / "types").mkdir(parents=True)
    (tree / "plugin" / "hooks" / "term" / "types" / "index.d.ts").write_text("x")  # what Claude Code's copy leaves out
    out, changes = install()
    assert changes == [] and f"unchanged ({pid} 0.0.1): nothing to update; it is off" in out, out

    marker.write_text(marker.read_text() + "# a commit pulled\n")
    out, changes = install("--dry-run")
    assert changes == [] and (f"✓ thimble's plugin ({pid} 0.0.1): its files changed, so it is installed again (claude "
                              "plugin uninstall, then install), with its options and on or off as you set them") in out
    out, changes = install()
    assert changes == [f"plugin uninstall --keep-data --scope user {pid}", f"plugin install --scope user {pid}",
                       f"plugin configure --values-stdin {pid}", f"plugin disable --scope user {pid}"], out
    assert (f"✓ Installed thimble's plugin in Claude Code again ({pid} 0.0.1), since its files had changed: a claude "
            "session uses it from its next start, or after /reload-plugins; it is off in Claude Code, and /plugin turns "
            "it on") in out, out
    now = json.loads(state.read_text())
    assert now["options"] == {pid: {"labels": "false"}} and now["disabled"] == [pid], "its options and its off kept"
    assert (Path(now["copies"][pid]) / "bin" / "thimble-app-dir").read_text().endswith("# a commit pulled\n")
    assert install()[1] == [], "the copy is this install's now"

    state.write_text(json.dumps({**now, "inplace": True}))  # Claude Code 2.1.301 reads a directory marketplace in place
    marker.write_text(marker.read_text() + "# another commit\n")
    out, changes = install()
    assert changes == [] and (f"✓ thimble's plugin in Claude Code is this install's ({pid} 0.0.1), read from "
                              "~/.thimble/app/plugin itself: nothing to update. A claude session open since before uses "
                              "any changed files after /reload-plugins") in out, out
    (tree / "plugin" / ".claude-plugin" / "plugin.json").write_text(json.dumps({"name": "thimble", "version": "0.0.2"}))
    out, changes = install()
    assert changes == ["plugin marketplace update thimble-local", f"plugin update --scope user {pid}"], out


def test_a_re_run_with_nothing_to_do_says_so_in_one_line_and_one_that_changes_something_shows_only_that(tmp_path):
    """A re-run of a Dev install that finds every step done prints no opening screen and no step lines: one line that
    nothing needed doing, and how to start. When a step does change something, the title and that step's line show,
    and the last line says the rest was up to date."""
    tree = fake_tree(tmp_path / "thimble", checkout=True)
    (tree / "backend" / "uv.lock").write_text("version = 1\n")
    fe = tree / "frontend"
    (fe / "dist").mkdir(parents=True)
    (fe / "package-lock.json").write_text("{}\n")
    (fe / "dist" / "index.html").write_text("<html></html>")
    os.utime(fe / "package-lock.json", (1, 1))  # older than the build, which is then current
    bin_ = stub_bin(tmp_path)
    claude_stub(bin_)
    (bin_ / "npm").write_text('#!/bin/sh\nwhile [ $# -gt 1 ]; do [ "$1" = --prefix ] && mkdir -p "$2/node_modules"; '
                              'shift; done\n')  # npm ci makes node_modules
    # the lines of `thimble doctor --verbose` that install.sh reads
    (tree / "plugin" / "bin" / "thimble").write_text('#!/bin/sh\necho "  auth: logged in (stub)"\n'
                                                     'echo "  network: api.anthropic.com answers"\n')
    env = env_for(tmp_path, PATH=f"{tmp_path / 'home' / '.local' / 'bin'}:{bin_}:/usr/bin:/bin", STUB_NODE="v22.13.0",
                  CLAUDE_STATE=str(tmp_path / "claude.json"))

    def install(**extra: str) -> str:
        r = subprocess.run(["bash", str(tree / "scripts" / "install.sh"), *ANSWERS], capture_output=True, text=True,
                           env={**env, **extra}, stdin=subprocess.DEVNULL, timeout=60)
        assert r.returncode == 0, r.stdout + r.stderr
        return r.stdout

    where = tree.resolve()
    first = install()
    assert "\nInstalling\n" in first and f"\nDone: thimble 0.0.1 is installed in {where}\n" in first, first
    assert install().strip() == (f"thimble 0.0.1 is installed in {where} and up to date: nothing needed doing.\n"
                                 "Next: run claude in a folder with your files. thimble is on in every session.\n"
                                 "  /thimble browser opens the same session in the browser workbench.\n"
                                 "  /plugin turns thimble on or off.")
    lines = install(STUB_UV_SYNC=" + idna==3.10").strip().splitlines()
    assert lines[0].startswith("thimble 0.0.1 installer · ") and lines[1:4] == [
        f"✓ Python packages installed in {where}/backend/.venv (the versions backend/uv.lock pins)", "",
        f"Done: thimble 0.0.1 is installed in {where}; the rest was up to date."], lines


def test_install_sh_leaves_out_what_thimble_doctor_leaves_out_when_it_compares_plugin_copies():
    """scripts/plugin.sh compares a plugin copy with plugin/ as `thimble doctor` does (app/cli.py _plugin_files), the
    same files left out, so the two never disagree on whether Claude Code's copy is this install's."""
    import ast

    from app import cli

    text = (REPO / "scripts" / "plugin.sh").read_text()
    for name in ("COPY_IGNORED", "COPY_LEFT_OUT", "COPY_LEFT_OUT_SUFFIX"):
        found = re.search(rf"^{name} = (\(.*?\)|\"[^\"]*\")$", text, re.MULTILINE | re.DOTALL)
        assert found and ast.literal_eval(found.group(1)) == getattr(cli, name), name


# ----------------------------------------------------------------------------- the shell startup files


STARTUP_FILES = (".bash_login", ".bash_profile", ".bashrc", ".config/fish/conf.d/thimble.fish", ".profile", ".zshrc")


def startup(home: Path) -> dict[str, str]:
    """{each startup file under HOME: its text}."""
    return {f: (home / f).read_text() for f in STARTUP_FILES if (home / f).exists()}
