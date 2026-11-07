"""scripts/install.sh and its steps in the kernel (engine/kernel/install.py): the install puts the release in thimble's
home, as thimble update leaves it (live, the release checkout, release.json), has Claude Code load the plugin from there
with its settings as they were, builds the workbench there, and links the commands; it says what it does in the lines
the person reads. The world is made up: thimble's repository is a bare repository in the test's folder
(THIMBLE_UPDATE_URL), whose release holds this repository's kernel and scripts; `claude` is a fake that keeps Claude
Code's records as Claude Code does; node, uv and npm are fakes. All data here is made up."""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "plugin" / "engine"))

from kernel import install as IN  # noqa: E402

GIT_ID = {"GIT_AUTHOR_NAME": "Release", "GIT_AUTHOR_EMAIL": "release@example.invalid",
          "GIT_COMMITTER_NAME": "Release", "GIT_COMMITTER_EMAIL": "release@example.invalid"}


def sh(*cmd: str, cwd: Path | None = None) -> str:
    return subprocess.run(cmd, cwd=cwd, check=True, capture_output=True, text=True,
                          env={**os.environ, **GIT_ID, "GIT_CONFIG_NOSYSTEM": "1"}).stdout.strip()


def stub(path: Path, text: str) -> Path:
    """An executable shell script at path."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("#!/bin/sh\n" + text)
    path.chmod(0o755)
    return path


# Claude Code's commands that the install runs, as Claude Code 2.1.316 keeps their records: the marketplace in its list
# (plugins/known_marketplaces.json) and in its user settings (extraKnownMarketplaces), where add refuses a source other
# than the one the settings give; the plugin in plugins/installed_plugins.json, by the commit of its marketplace's
# folder; install's --config values in settings' pluginConfigs, and the plugin on in enabledPlugins. Each call is
# logged.
CLAUDE = r'''
import json, os, subprocess, sys
cc = os.environ["CLAUDE_CONFIG_DIR"]
args = sys.argv[1:]
with open(os.environ["FAKE_CLAUDE_LOG"], "a") as f:
    f.write(" ".join(args) + "\n")
known_at = os.path.join(cc, "plugins", "known_marketplaces.json")
installed_at = os.path.join(cc, "plugins", "installed_plugins.json")
settings_at = os.path.join(cc, "settings.json")
def load(p, d):
    try:
        return json.load(open(p))
    except (OSError, ValueError):
        return d
def save(p, v):
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w") as f:
        json.dump(v, f, indent=2)
if args[:1] == ["--version"]:
    print(os.environ.get("FAKE_CLAUDE_VERSION", "2.1.316") + " (Claude Code)")
elif args[:3] == ["plugin", "marketplace", "add"]:
    src = args[3]
    source = ({"source": "directory", "path": os.path.realpath(src)} if os.path.isdir(src)
              else {"source": "github", "repo": src})
    settings = load(settings_at, {})
    declared = settings.setdefault("extraKnownMarketplaces", {})
    if declared.get("thimble", {}).get("source", source) != source:
        sys.exit("Failed to add marketplace: Cannot add marketplace \"thimble\": its source doesn't match its "
                 "extraKnownMarketplaces entry in user or managed settings")
    known = load(known_at, {})
    known["thimble"] = {"source": source,
                        "installLocation": source.get("path") or os.path.join(cc, "plugins", "marketplaces", "thimble")}
    declared["thimble"] = {"source": source}
    save(known_at, known)
    save(settings_at, settings)
elif args[:2] in (["plugin", "install"], ["plugin", "update"]):
    loc = (load(known_at, {}).get("thimble") or {}).get("installLocation")
    if not loc:
        sys.exit("Plugin thimble@thimble not found in any marketplace")
    sha = subprocess.run(["git", "-C", loc, "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
    installed = load(installed_at, {"version": 2, "plugins": {}})
    if args[1] == "update" and "thimble@thimble" not in installed["plugins"]:
        sys.exit("Plugin thimble@thimble is not installed")
    copy = os.path.join(cc, "plugins", "cache", "thimble", sha[:12])
    installed["plugins"]["thimble@thimble"] = [{"scope": "user", "gitCommitSha": sha, "installPath": copy}]
    save(installed_at, installed)
    if args[1] == "install":
        settings = load(settings_at, {})
        settings.setdefault("enabledPlugins", {})["thimble@thimble"] = True
        pairs = [args[i + 1] for i, a in enumerate(args) if a == "--config"]
        if pairs:
            opts = settings.setdefault("pluginConfigs", {}).setdefault("thimble@thimble", {}).setdefault("options", {})
            for kv in pairs:
                k, v = kv.split("=", 1)
                opts[k] = {"true": True, "false": False}.get(v, v)
        save(settings_at, settings)
'''

# node: its version, and setup.mjs --json --probe --repair's answer (FAKE_SANDBOX: ok, or the packages that are missing)
NODE = ('case "$1" in\n'
        '  --version) echo "${FAKE_NODE_VERSION:-v22.20.0}" ;;\n'
        '  *) if [ "${FAKE_SANDBOX:-ok}" = ok ]; then echo \'{"ok": true}\'; else echo \'' + json.dumps({
            "ok": False, "why": "this machine lacks what the sandbox needs: made-up",
            "fix": "Install them: sudo apt-get install bubblewrap socat ripgrep",
            "missing": ["bubblewrap", "socat", "ripgrep"]}) + '\'; exit 1; fi ;;\n'
        'esac\n')
# uv and npm: their versions, and what uv sync, npm ci and npm run build leave
UV = ('[ "$1" = --version ] && { echo "uv 0.9.5"; exit 0; }\n'
      '[ "$1" = sync ] && mkdir -p "$3/.venv/bin" && echo made-up > "$3/.venv/bin/python"\nexit 0\n')
NPM = ('[ "$1" = --version ] && { echo "10.9.2"; exit 0; }\n'
       'case "$3" in ci) mkdir -p "$2/node_modules" ;; '
       'run) mkdir -p "$2/dist" && echo "<title>thimble</title>" > "$2/dist/index.html" ;; esac\nexit 0\n')
# the workbench's launcher in the made-up release: its setup says what it was given and whether a person can answer
THIMBLE_BROWSER = ('if [ "$1" = --setup ]; then\n'
                   '  echo "$@" > "$(dirname "$0")/setup-args"\n'
                   '  if [ -t 0 ]; then echo "Sign-in: asked in a terminal."\n'
                   '  else echo "Sign-in: not chosen yet. The workbench asks when it starts."; fi\n'
                   'fi\n')


def release_tree(at: Path) -> Path:
    """A made-up release of thimble: this repository's kernel, launcher, manifest and scripts, and a made-up workbench
    (its lock files, its setup's code, and a launcher whose setup says what it was given)."""
    for part in ("plugin/bin", "plugin/engine", "plugin/.claude-plugin"):
        shutil.copytree(ROOT / part, at / part, ignore=shutil.ignore_patterns("__pycache__"))
    (at / "plugin" / "sandbox").mkdir(parents=True)
    (at / "plugin" / "sandbox" / "setup.mjs").write_text("// made up: the fake node answers for it\n")
    (at / "scripts").mkdir()
    shutil.copy(ROOT / "scripts" / "install.sh", at / "scripts" / "install.sh")
    shutil.copy(ROOT / "scripts" / "thimble09.py", at / "scripts" / "thimble09.py")
    (at / ".claude-plugin").mkdir()
    shutil.copy(ROOT / ".claude-plugin" / "marketplace.json", at / ".claude-plugin" / "marketplace.json")
    for part, lock in (("backend", "uv.lock"), ("frontend", "package-lock.json")):
        (at / "browser" / part).mkdir(parents=True)
        (at / "browser" / part / lock).write_text(f"made-up {lock}\n")
    stub(at / "browser" / "scripts" / "thimble-browser", THIMBLE_BROWSER)
    (at / "browser" / "backend" / "app").mkdir()
    shutil.copy(ROOT / "browser" / "backend" / "app" / "claude_access.py", at / "browser" / "backend" / "app")
    return at


def commit_all(repo: Path, message: str, tag: str = "") -> str:
    sh("git", "add", "-A", cwd=repo)
    sh("git", "commit", "-q", "-m", message, cwd=repo)
    if tag:
        sh("git", "tag", tag, cwd=repo)
    return sh("git", "rev-parse", "HEAD", cwd=repo)


class World:
    """The test's machine: thimble's repository (`bare`), the person's home, Claude Code's config, the fakes, and what
    the fake claude was asked."""

    def __init__(self, tmp: Path):
        self.tmp, self.home, self.bare = tmp, tmp / "home", tmp / "upstream.git"
        self.cc, self.th = self.home / ".claude", self.home / ".thimble"
        self.bin, self.log = tmp / "fakes", tmp / "claude.log"
        self.home.mkdir()
        (tmp / "tmp").mkdir()
        self.work = release_tree(tmp / "work")
        sh("git", "init", "-q", "-b", "main", str(self.work))
        commit_all(self.work, "thimble 0.10.8", "v0.10.8")
        sh("git", "clone", "-q", "--bare", str(self.work), str(self.bare))
        (tmp / "claude.py").write_text(CLAUDE)
        stub(self.bin / "claude", f'exec "{sys.executable}" "{tmp / "claude.py"}" "$@"\n')
        stub(self.bin / "node", NODE)
        stub(self.bin / "uv", UV)
        stub(self.bin / "npm", NPM)
        if os.environ.get("THIMBLE_TEST_BASH"):
            # the bash that runs the scripts: THIMBLE_TEST_BASH names another, such as the bash 3.2 that macOS has
            (self.bin / "bash").symlink_to(os.environ["THIMBLE_TEST_BASH"])

    def publish(self, tag: str = "", branch: str = "main") -> str:
        """One more commit on `branch` of thimble's repository, tagged `tag` when it is a release."""
        sh("git", "checkout", "-q", "-B", branch, cwd=self.work)
        (self.work / "README.md").write_text(f"{tag or branch} {len(self.calls())}\n")
        commit = commit_all(self.work, f"thimble {tag or branch}", tag)
        sh("git", "push", "-q", str(self.bare), branch, *([tag] if tag else []), cwd=self.work)
        return commit

    def env(self, **more: str) -> dict[str, str]:
        return {"PATH": f"{self.bin}:/usr/bin:/bin", "HOME": str(self.home), "THIMBLE_PYTHON": sys.executable,
                "CLAUDE_CONFIG_DIR": str(self.cc), "THIMBLE_HOME": str(self.th),
                "THIMBLE_BROWSER_HOME": str(self.home / ".thimble-browser"), "TMPDIR": str(self.tmp / "tmp"),
                "THIMBLE_UPDATE_URL": str(self.bare), "FAKE_CLAUDE_LOG": str(self.log), "SHELL": "/bin/zsh",
                "LANG": "C.UTF-8", **GIT_ID, "GIT_CONFIG_NOSYSTEM": "1", **more}

    def install(self, *args: str, script: Path | None = None, **env: str) -> subprocess.CompletedProcess:
        """The install, with no terminal: piped into bash, as `curl ... | bash -s -- ARGS` runs it, or run as a file in
        a clone (`script`)."""
        if script is None:
            return subprocess.run(["bash", "-s", "--", *args], input=(ROOT / "scripts" / "install.sh").read_text(),
                                  capture_output=True, text=True, env=self.env(**env), cwd=self.home, timeout=300)
        return subprocess.run(["bash", str(script), *args], capture_output=True, text=True, env=self.env(**env),
                              cwd=self.home, stdin=subprocess.DEVNULL, timeout=300)

    def calls(self) -> list[str]:
        return self.log.read_text().splitlines() if self.log.exists() else []

    def settings(self) -> dict:
        return json.loads((self.cc / "settings.json").read_text())

    def release(self) -> dict:
        return json.loads((self.th / "fixes" / "release.json").read_text())


@pytest.fixture
def w(tmp_path) -> World:
    return World(tmp_path)


def text_of(p: subprocess.CompletedProcess) -> str:
    return p.stdout + p.stderr


def before_notes(out: str) -> list[str]:
    """The install's lines up to its notes."""
    return out.split("\n\nNote: ", 1)[0].rstrip().splitlines()


# ------------------------------------------------------------------ a fresh install


def test_a_fresh_install_lays_the_release_out_in_thimbles_home_and_says_so(w):
    p = w.install("--no-browser")
    assert p.returncode == 0, text_of(p)
    assert p.stdout.splitlines() == [
        "Installing thimble.",
        "",
        "Checking what thimble needs...",
        f"  Node.js 22.20.0, Python {'.'.join(map(str, sys.version_info[:3]))}, git "
        f"{sh('git', '--version').split()[2]}, Claude Code 2.1.316: all here.",
        "",
        "Downloading thimble 0.10.8 into ~/.thimble... done.",
        "",
        "The plugin",
        "  Added to Claude Code from ~/.thimble.",
        "  Cards run in Anthropic's sandbox runtime: it works here.",
        "",
        "The command thimble is in ~/.local/bin.",
        "",
        "thimble 0.10.8 is installed.",
        "",
        "Try it now: run claude in a folder of data files.",
        "Take the two-minute tour: run thimble tour",
        "",
        "Note: ~/.local/bin is not on your PATH, so a new terminal does not find thimble. Add this line to ~/.zshrc: "
        'export PATH="$HOME/.local/bin:$PATH"',
    ], text_of(p)
    live, rel = w.th / "fixes" / "live", w.release()
    v8 = sh("git", "rev-parse", "v0.10.8", cwd=w.bare)
    # the layout thimble update makes: live at the release on mine, its origin thimble's repository, and the release
    # checkout
    assert sh("git", "rev-parse", "mine", cwd=live) == v8
    assert sh("git", "symbolic-ref", "--short", "HEAD", cwd=live) == "mine"
    assert sh("git", "remote", "get-url", "origin", cwd=live) == str(w.bare)
    assert sh("git", "rev-parse", "HEAD", cwd=w.th / "fixes" / "release") == v8
    assert (rel["kind"], rel["base"], rel["tag"], rel["pointed"]) == ("github", v8, "v0.10.8", True)
    assert rel["repo"] == str(live)
    # Claude Code loads it from live, with each setting's default
    manifest = json.loads((ROOT / "plugin" / ".claude-plugin" / "plugin.json").read_text())
    assert w.calls()[1:] == [f"plugin marketplace add {live}",
                             " ".join(["plugin", "install", "thimble@thimble", *IN.defaults(manifest)])]
    s = w.settings()
    assert s["extraKnownMarketplaces"]["thimble"]["source"] == {"source": "directory", "path": str(live)}
    assert s["pluginConfigs"]["thimble@thimble"]["options"]["minimal"] is False
    # the command: a link to the release checkout's launcher, which names the release
    link = w.home / ".local" / "bin" / "thimble"
    assert os.readlink(link) == str(w.th / "fixes" / "release" / "plugin" / "bin" / "thimble")
    assert (w.th / "cli-link").read_text().strip() == str(link)
    got = subprocess.run([str(link), "--version"], capture_output=True, text=True, env=w.env())
    assert got.stdout.strip() == "thimble 0.10.8", got.stderr
    assert not any((w.tmp / "tmp").iterdir()), "the download goes after the install"


def test_both_products_build_the_workbench_in_live_and_link_its_command(w):
    p = w.install(PATH=f"{w.bin}:{w.home / '.local' / 'bin'}:/usr/bin:/bin")
    assert p.returncode == 0, text_of(p)
    out = p.stdout
    assert "uv 0.9.5, npm 10.9.2: all here." in out
    section = out.split("\nThe workbench\n", 1)[1].split("\n\n", 1)[0].splitlines()
    assert re.fullmatch(r"  Installing its packages and building its page \(a few minutes\)\.\.\. done, \d+ MB\.",
                        section[0]), section
    assert section[1:] == ["  Sign-in: not chosen yet. The workbench asks when it starts."], section
    assert out.rstrip().splitlines()[-7:] == [
        "The commands thimble and thimble-browser are in ~/.local/bin.",
        "",
        "thimble 0.10.8 is installed.",
        "",
        "Try it now: run claude in a folder of data files.",
        "Take the two-minute tour: run thimble tour",
        "The browser workbench: run thimble-browser in a folder of files, in a terminal of its own, and open the link "
        "it prints."], out
    live = w.th / "fixes" / "live"
    assert (w.th / "fixes" / "browser-ready").read_text().strip() == str(live / "browser")
    launcher = (w.home / ".local" / "bin" / "thimble-browser").read_text()
    assert IN.MARKER in launcher and f"exec {live / 'browser' / 'scripts' / 'thimble-browser'} \"$@\"" in launcher
    assert (live / "browser" / "scripts" / "setup-args").read_text().split() == ["--setup", "--keep"]
    assert (w.home / ".thimble-browser").stat().st_mode & 0o777 == 0o700


@pytest.mark.parametrize("args, given", [
    (("--sign-in", "claude-code"), "--setup --how claude-code"),
    (("--sign-in", "api-key"), "--setup --how api-key"),
    (("--wif-file", "/made/up/wif.toml"), "--setup --how wif --wif-file /made/up/wif.toml")])
def test_the_sign_in_choice_goes_to_the_workbench_s_setup(w, args, given):
    p = w.install(*args)
    assert p.returncode == 0, text_of(p)
    assert (w.th / "fixes" / "live" / "browser" / "scripts" / "setup-args").read_text().strip() == given


def test_the_options_that_cannot_work_stop_before_anything(w):
    for args, said in ((("--sign-in", "key"), "--sign-in is claude-code, api-key or wif"),
                       (("--sign-in", "wif"), "--sign-in wif needs --wif-file PATH"),
                       (("--no-browser", "--sign-in", "api-key"), "--sign-in sets up the workbench"),
                       (("--made-up",), "unknown option --made-up")):
        p = w.install(*args)
        assert p.returncode == 2 and said in p.stderr, text_of(p)
    assert not w.th.exists()


# ------------------------------------------------------------------ what is missing, and what fails


def test_what_is_missing_is_said_with_its_fix_and_nothing_is_installed(w):
    (w.bin / "uv").unlink()
    stub(w.bin / "node", "echo v20.11.0\n")
    p = w.install()
    assert p.returncode == 1, text_of(p)
    lines = p.stdout.splitlines()
    at = lines.index("Checking what thimble needs...")
    assert lines[at + 1] == "thimble needs these first:"
    assert lines[at + 2].startswith("  - Node.js 22.18 or later (the one here is 20.11.0): ")
    assert lines[at + 3] in ("  - uv: curl -LsSf https://astral.sh/uv/install.sh | sh", "  - uv: brew install uv")
    assert lines[at + 4:] == ["Run the install again after that. Nothing was installed."]
    assert not w.th.exists() and not w.cc.exists()


def wsl(w, kernel: str) -> None:
    """Windows' WSL, as its kernel names itself in uname -r: WSL 1's says Microsoft, WSL 2's microsoft."""
    stub(w.bin / "uname", f'if [ "$1" = -r ]; then echo "{kernel}"; else echo Linux; fi\n')


def test_in_wsl_2_a_windows_program_on_its_drives_is_said_and_the_install_goes_on(w):
    """In WSL 2, WSL puts Windows' folders on PATH, so a node or npm that Windows has can be found before Linux's; the
    install names each one it finds on Windows' drives (THIMBLE_WSL_DRIVES stands in for /mnt). Linux's are not
    named."""
    wsl(w, "5.15.153.1-microsoft-standard-WSL2")
    drives = w.tmp / "drives"
    stub(drives / "c" / "nodejs" / "node", NODE)
    (w.bin / "node").unlink()
    path = f"{w.bin}:{drives / 'c' / 'nodejs'}:/usr/bin:/bin"
    p = w.install("--no-browser", PATH=path, THIMBLE_WSL_DRIVES=str(drives), WSL_DISTRO_NAME="Made-Up")
    assert p.returncode == 0, text_of(p)
    lines = p.stdout.splitlines()
    said = [line for line in lines if "Windows' own" in line]
    assert said == ["  node here is Windows' own, on its drives: install a Linux one in WSL, first on PATH."], lines
    assert lines.index(said[0]) == lines.index("Checking what thimble needs...") + 1
    assert (w.th / "fixes" / "live" / ".git").exists()
    # Linux's node first on PATH: nothing is said
    stub(w.bin / "node", NODE)
    p = w.install("--no-browser", PATH=path, THIMBLE_WSL_DRIVES=str(drives), WSL_DISTRO_NAME="Made-Up")
    assert p.returncode == 0 and "Windows' own" not in p.stdout, text_of(p)


# ------------------------------------------------------------------ again, and later


def test_thimble_update_moves_the_install_to_a_newer_release_in_place(w):
    assert w.install("--no-browser").returncode == 0
    v9 = w.publish("v0.10.9")
    link = w.home / ".local" / "bin" / "thimble"
    p = subprocess.run([str(link), "update"], capture_output=True, text=True, env=w.env())
    assert p.returncode == 0, text_of(p)
    assert p.stdout.splitlines()[0] == "Updated thimble 0.10.8 → 0.10.9 (terminal plugin)"
    assert sh("git", "rev-parse", "mine", cwd=w.th / "fixes" / "live") == v9 and w.release()["tag"] == "v0.10.9"
    assert w.calls()[-1] == "plugin update thimble@thimble"


# ------------------------------------------------------------------ an earlier install moves into thimble's home


# ------------------------------------------------------------------ an earlier install moved by thimble update alone


# ------------------------------------------------------------------ what is the person's


# ------------------------------------------------------------------ thimble 0.9


# ------------------------------------------------------------------ a branch, and the dev install


def test_local_installs_from_the_clone_as_the_dev_install(w):
    clone = w.home / "thimble"
    sh("git", "clone", "-q", str(w.bare), str(clone))
    p = w.install("--local", "--no-browser", script=clone / "scripts" / "install.sh")
    assert p.returncode == 0, text_of(p)
    assert "  Added to Claude Code from ~/thimble." in p.stdout.splitlines()
    assert before_notes(p.stdout)[-4:] == [
        "thimble is installed from your clone ~/thimble.", "", "Try it now: run claude in a folder of data files.",
        "Take the two-minute tour: run thimble tour"], p.stdout
    assert w.settings()["extraKnownMarketplaces"]["thimble"]["source"] == {"source": "directory", "path": str(clone)}
    assert os.readlink(w.home / ".local" / "bin" / "thimble") == str(clone / "plugin" / "bin" / "thimble")
    assert not (w.th / "fixes").exists()


def test_an_install_inside_claude_code_names_reload_plugins_and_the_tour_starts_there(w):
    """Run by Claude in a Claude Code session (CLAUDECODE set), the end says /reload-plugins and writes the session's id
    to tour-next, so thimble starts its tour when it loads there (plugin/tour/tour.ts). Without the session's id, it
    names /thimble:tour."""
    clone = w.home / "thimble"
    sh("git", "clone", "-q", str(w.bare), str(clone))
    p = w.install("--local", "--no-browser", script=clone / "scripts" / "install.sh", CLAUDECODE="1",
                  CLAUDE_CODE_SESSION_ID="made-up-session")
    assert p.returncode == 0, text_of(p)
    assert before_notes(p.stdout)[-3:] == [
        "thimble is installed from your clone ~/thimble.", "",
        "Try it now: type /reload-plugins in this Claude Code session. A two-minute tour of thimble starts then."], p.stdout
    assert (w.th / "tour-next").read_text() == "made-up-session\n"
    assert "thimble tour" not in p.stdout
    (w.th / "tour-next").unlink()
    p = w.install("--local", "--no-browser", script=clone / "scripts" / "install.sh", CLAUDECODE="1")
    assert "then /thimble:tour for a two-minute tour." in p.stdout
    assert not (w.th / "tour-next").exists()


# ------------------------------------------------------------------ the kernel's steps alone


def test_the_steps_write_notes_and_state_only_in_the_folder_the_script_makes_for_them(w):
    """--notes and --state name files in the folder scripts/install.sh makes for one install ($TMPDIR/thimble-install.
    XXXXXX). Before, a step wrote any file they named (the state over the person's notes); now it refuses another, a
    link from such a folder to one elsewhere too, with one line, and writes nothing. The script's own run works as
    before (every other test here)."""
    notes = w.home / "notes.txt"
    notes.write_text("the person's notes\n")
    work = w.tmp / "tmp" / "thimble-install.made-up"
    work.mkdir()
    (work / "state.json").symlink_to(notes)
    for option, path in (("--notes", notes), ("--state", notes), ("--state", work / "state.json")):
        p = subprocess.run([sys.executable, str(ROOT / "plugin" / "engine" / "thimble.py"), "install", "commands",
                            "--bin-dir", str(w.tmp / "bin"), option, str(path)], env=w.env(), cwd=w.home,
                           capture_output=True, text=True, timeout=60)
        assert p.returncode == 1 and p.stdout.startswith(
            "thimble install writes --notes and --state only in the folder scripts/install.sh makes for them ("), \
            text_of(p)
    assert notes.read_text() == "the person's notes\n"
    assert not (w.tmp / "bin").exists() and not w.th.exists()


# ------------------------------------------------------------------ the docs
