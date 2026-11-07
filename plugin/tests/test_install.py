"""scripts/install.sh and its steps in the kernel (engine/kernel/install.py): the install puts the release in thimble's
home, as thimble update leaves it (live, the release checkout, release.json), has Claude Code load the plugin from there
with its settings as they were, builds the workbench there, and links the commands; it says what it does in the lines
the person reads. The world is made up: thimble's repository is a bare repository in the test's folder
(THIMBLE_UPDATE_URL), whose release holds this repository's kernel and scripts, and GitHub's release pages and files
are a server on 127.0.0.1 (releases_server.py, THIMBLE_RELEASES_URL), where each release has its file; `claude` is a
fake that keeps Claude Code's records as Claude Code does; node, uv and npm are fakes. All data here is made up."""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "plugin" / "engine"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from kernel import install as IN  # noqa: E402
from releases_server import Releases  # noqa: E402

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
    """The test's machine: thimble's repository (`bare`), its releases on GitHub (`gh`), the person's home, Claude
    Code's config, the fakes, and what the fake claude was asked."""

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
        self.gh = Releases(tmp / "releases", self.bare)
        self.gh.publish(self.bare, "v0.10.8")
        (tmp / "claude.py").write_text(CLAUDE)
        stub(self.bin / "claude", f'exec "{sys.executable}" "{tmp / "claude.py"}" "$@"\n')
        stub(self.bin / "node", NODE)
        stub(self.bin / "uv", UV)
        stub(self.bin / "npm", NPM)
        if os.environ.get("THIMBLE_TEST_BASH"):
            # the bash that runs the scripts: THIMBLE_TEST_BASH names another, such as the bash 3.2 that macOS has
            (self.bin / "bash").symlink_to(os.environ["THIMBLE_TEST_BASH"])

    def publish(self, tag: str = "", branch: str = "main", file: bool = True) -> str:
        """One more commit on `branch` of thimble's repository, tagged `tag` when it is a release, and then, with `file`,
        the release's file attached on GitHub, which makes it the newest release."""
        sh("git", "checkout", "-q", "-B", branch, cwd=self.work)
        (self.work / "README.md").write_text(f"{tag or branch} {len(self.calls())}\n")
        commit = commit_all(self.work, f"thimble {tag or branch}", tag)
        sh("git", "push", "-q", str(self.bare), branch, *([tag] if tag else []), cwd=self.work)
        if tag and file:
            self.gh.publish(self.bare, tag)
        return commit

    def env(self, **more: str) -> dict[str, str]:
        return {"PATH": f"{self.bin}:/usr/bin:/bin", "HOME": str(self.home), "THIMBLE_PYTHON": sys.executable,
                "CLAUDE_CONFIG_DIR": str(self.cc), "THIMBLE_HOME": str(self.th),
                "THIMBLE_BROWSER_HOME": str(self.home / ".thimble-browser"), "TMPDIR": str(self.tmp / "tmp"),
                "THIMBLE_UPDATE_URL": str(self.bare), "THIMBLE_RELEASES_URL": self.gh.url,
                "FAKE_CLAUDE_LOG": str(self.log), "SHELL": "/bin/zsh",
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
    world = World(tmp_path)
    yield world
    world.gh.stop()


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
        "",
        "Note: ~/.local/bin is not on your PATH, so a new terminal does not find thimble. Add this line to ~/.zshrc: "
        'export PATH="$HOME/.local/bin:$PATH"',
    ], text_of(p)
    live, rel = w.th / "fixes" / "live", w.release()
    v8 = sh("git", "rev-parse", "v0.10.8", cwd=w.bare)
    # the layout thimble update makes: live, a git repository of its own whose release commit, made from the release's
    # file, has the tag's files and no parent, on mine; and the release checkout
    made = sh("git", "rev-parse", "mine", cwd=live)
    assert sh("git", "rev-parse", "mine^{tree}", cwd=live) == sh("git", "rev-parse", "v0.10.8^{tree}", cwd=w.bare)
    assert sh("git", "log", "-1", "--format=%P|%an|%s", "mine", cwd=live) == "|thimble|thimble v0.10.8"
    assert sh("git", "symbolic-ref", "--short", "HEAD", cwd=live) == "mine"
    assert sh("git", "remote", cwd=live) == ""
    assert sh("git", "rev-parse", "HEAD", cwd=w.th / "fixes" / "release") == made
    # release.json: where it came from, GitHub's commit of the release, and the file's sha256
    f = w.gh.root / "v0.10.8" / "thimble-0.10.8.tar.gz"
    assert (rel["kind"], rel["base"], rel["commit"], rel["tag"], rel["pointed"]) == ("release", made, v8, "v0.10.8",
                                                                                     True)
    assert rel["source"] == f"{w.gh.url}/releases/download/v0.10.8/thimble-0.10.8.tar.gz"
    assert rel["sha256"] == hashlib.sha256(f.read_bytes()).hexdigest() and rel["repo"] == str(live)
    # GitHub: the newest release's page, then its SHA256SUMS and its file, each once; no archive
    assert w.gh.requests() == ["GET /releases/latest", "GET /releases/download/v0.10.8/SHA256SUMS",
                               "GET /assets/v0.10.8/SHA256SUMS", "GET /releases/download/v0.10.8/thimble-0.10.8.tar.gz",
                               "GET /assets/v0.10.8/thimble-0.10.8.tar.gz"]
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
    assert out.rstrip().splitlines()[-6:] == [
        "The commands thimble and thimble-browser are in ~/.local/bin.",
        "",
        "thimble 0.10.8 is installed.",
        "",
        "Try it now: run claude in a folder of data files.",
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
                       (("--made-up",), "unknown option --made-up"),
                       (("--ref", "main;made-up"), "--ref takes the name of a branch or tag of thimble, such as main or "
                                                  "v0.10.13"),
                       (("--ref", "../../made-up/fork"), "--ref takes the name of a branch or tag")):
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
    downloaded = w.gh.files()
    # the checks read the newest release from a page, and download no release's file
    got = subprocess.run([str(link), "update", "--check"], capture_output=True, text=True, env=w.env())
    assert got.stdout.strip() == "thimble 0.10.9 is out (you have 0.10.8): thimble update in a shell", text_of(got)
    subprocess.run([str(link), "doctor"], capture_output=True, text=True, env=w.env())
    assert w.gh.files() == downloaded
    p = subprocess.run([str(link), "update"], capture_output=True, text=True, env=w.env())
    assert p.returncode == 0, text_of(p)
    assert p.stdout.splitlines()[0] == "Updated thimble 0.10.8 → 0.10.9 (terminal plugin)"
    # the release commit made from 0.10.9's file, downloaded once: its tree is the tag's, and GitHub's commit is kept
    live = w.th / "fixes" / "live"
    made = sh("git", "rev-parse", "refs/thimble/releases/v0.10.9", cwd=live)
    assert sh("git", "rev-parse", "mine", cwd=live) == made
    assert sh("git", "rev-parse", f"{made}^{{tree}}", cwd=live) == sh("git", "rev-parse", "v0.10.9^{tree}", cwd=w.bare)
    rel = w.release()
    assert (rel["kind"], rel["tag"], rel["commit"], rel["base"]) == ("release", "v0.10.9", v9, made)
    assert w.gh.files() == [*downloaded, "/releases/download/v0.10.9/thimble-0.10.9.tar.gz"]
    assert sh("git", "rev-parse", "HEAD", cwd=w.th / "fixes" / "release") == made
    assert w.calls()[-1] == "plugin update thimble@thimble"


def nothing_installed(w) -> None:
    assert not (w.th / "fixes").exists() and not w.cc.exists()
    assert not any((w.tmp / "tmp").iterdir()), "the download goes"


def test_a_release_file_that_is_missing_broken_or_out_of_reach_says_what_to_do_and_installs_nothing(w):
    w.publish("v0.10.9")
    issues = "https://github.com/safety-research/thimble/issues"
    w.gh.drop("v0.10.9")
    p = w.install("--no-browser")
    assert p.returncode == 1 and p.stdout.splitlines()[-2:] == [
        "Downloading thimble 0.10.9 into ~/.thimble... failed: thimble 0.10.9 has no release file on GitHub "
        "(thimble-0.10.9.tar.gz).",
        f"Run the install again in a few minutes; if it says this again, report it at {issues}. Nothing was "
        "installed."], text_of(p)
    nothing_installed(w)
    w.gh.publish(w.bare, "v0.10.9")
    w.gh.spoil("v0.10.9")
    p = w.install("--no-browser")
    assert p.returncode == 1 and p.stdout.splitlines()[-2:] == [
        "Downloading thimble 0.10.9 into ~/.thimble... failed: thimble-0.10.9.tar.gz does not have the sha256 its "
        "SHA256SUMS gives, so the download is broken.",
        "Run the install again. Nothing was installed."], text_of(p)
    nothing_installed(w)
    # a file that holds a link out of its folder, though its sha256 is the one SHA256SUMS gives
    f = w.gh.root / "v0.10.9" / "thimble-0.10.9.tar.gz"
    with tarfile.open(f, "w:gz") as t:
        for name, kind in (("thimble-0.10.9", tarfile.DIRTYPE), ("thimble-0.10.9/plugin", tarfile.SYMTYPE)):
            info = tarfile.TarInfo(name)
            info.type, info.linkname = kind, "../../made-up"
            t.addfile(info)
    (f.parent / "SHA256SUMS").write_text(f"{hashlib.sha256(f.read_bytes()).hexdigest()}  thimble-0.10.9.tar.gz\n")
    p = w.install("--no-browser")
    assert p.returncode == 1 and p.stdout.splitlines()[-2:] == [
        "Downloading thimble 0.10.9 into ~/.thimble... failed: thimble-0.10.9.tar.gz holds thimble-0.10.9/plugin, a "
        "link or a path out of its folder.",
        f"Report it at {issues}. Nothing was installed."], text_of(p)
    nothing_installed(w)
    # GitHub's page of the latest release answers 503, which curl tries again, then takes for an answer
    w.gh.refuse(503)
    p = w.install("--no-browser")
    assert p.returncode == 1 and p.stdout.splitlines()[-4:] == [
        "  Node.js 22.20.0, Python " + ".".join(map(str, sys.version_info[:3])) + ", git "
        f"{sh('git', '--version').split()[2]}, Claude Code 2.1.316: all here.", "",
        f"Downloading thimble into ~/.thimble... failed: thimble found no release at {w.gh.url} (GitHub answered 503).",
        "Check the network, then run the install again. Nothing was installed."], text_of(p)
    nothing_installed(w)
    w.gh.stop()
    p = w.install("--no-browser")
    lines = p.stdout.splitlines()
    assert p.returncode == 1 and lines[-2].startswith("Downloading thimble into ~/.thimble... failed: ") and \
        "curl" not in lines[-2] and lines[-3] == "", text_of(p)
    assert lines[-1] == "Check the network, then run the install again. Nothing was installed."
    nothing_installed(w)


def test_running_it_again_leaves_the_install_as_it_is_and_downloads_nothing(w):
    assert w.install("--no-browser").returncode == 0
    calls, asked = w.calls(), len(w.gh.requests())
    p = w.install("--no-browser")
    assert p.returncode == 0, text_of(p)
    assert p.stdout.splitlines()[-1] == ("thimble 0.10.8 is installed in ~/.thimble. The plugin and the commands are "
                                         "in place.")
    assert "Downloading" not in p.stdout
    assert w.calls()[len(calls):] == ["--version"], "nothing changes in Claude Code"
    assert w.gh.requests()[asked:] == ["GET /releases/latest", "GET /releases/latest"], "the newest release's page"


def test_a_newer_release_is_said_with_thimble_update(w):
    assert w.install("--no-browser").returncode == 0
    w.publish("v0.10.9")
    p = w.install("--no-browser")
    assert p.stdout.splitlines()[-2:] == [
        "thimble 0.10.8 is installed in ~/.thimble. The plugin and the commands are in place.",
        "thimble 0.10.9 is out: thimble update moves to it and keeps your fixes."], text_of(p)


def test_ref_installs_a_release_from_its_file_and_a_branch_from_github_s_archive(w, tmp_path):
    w.publish("v0.10.9")
    p = w.install("--no-browser", "--ref", "v0.10.8")
    assert p.returncode == 0, text_of(p)
    assert "Downloading thimble 0.10.8 into ~/.thimble... done." in p.stdout.splitlines()
    assert (w.release()["tag"], w.release()["kind"]) == ("v0.10.8", "release") and "ref" not in w.release()
    assert w.gh.files() == ["/releases/download/v0.10.8/thimble-0.10.8.tar.gz"]
    # a branch: GitHub's archive of it, which counts nothing, and the newest release then, which says whether a later
    # release is newer
    (tmp_path / "other").mkdir()
    (tmp_path / "third").mkdir()
    other = World(tmp_path / "other")
    third = World(tmp_path / "third")
    try:
        other.publish("v0.10.9")
        tip = other.publish(branch="try-r110")
        p = other.install("--no-browser", "--ref", "try-r110")
        assert p.returncode == 0, text_of(p)
        assert "Downloading thimble try-r110 into ~/.thimble... done." in p.stdout.splitlines()
        assert f"thimble try-r110 at {tip[:7]} is installed." in p.stdout.splitlines()
        rel = other.release()
        assert (rel["ref"], rel["based_on"], rel["commit"], "tag" in rel) == ("try-r110", "v0.10.9", tip, False)
        assert rel["source"] == f"{other.gh.url}/archive/try-r110.tar.gz"
        assert other.gh.files() == [] and "GET /archive/try-r110.tar.gz" in other.gh.requests()
        link = other.home / ".local" / "bin" / "thimble"
        got = subprocess.run([str(link), "update", "--check"], capture_output=True, text=True, env=other.env())
        assert got.stdout.strip() == f"thimble try-r110 at {tip[:7]} is up to date; the newest release is 0.10.9.", \
            text_of(got)
        other.publish("v0.10.10")
        got = subprocess.run([str(link), "update", "--check"], capture_output=True, text=True, env=other.env())
        assert got.stdout.strip() == f"thimble 0.10.10 is out (you have try-r110 at {tip[:7]}): thimble update in a " \
            "shell", text_of(got)
        # a branch or tag that GitHub does not have
        p = third.install("--no-browser", "--ref", "no-such-branch")
        assert p.returncode == 1 and p.stdout.splitlines()[-2:] == [
            "Downloading thimble no-such-branch into ~/.thimble... failed: GitHub has no branch or tag named "
            "no-such-branch.",
            "Check the name no-such-branch, then run the install again. Nothing was installed."], text_of(p)
    finally:
        other.gh.stop()
        third.gh.stop()


def test_ref_to_a_release_from_before_release_files_gives_its_own_script(w):
    """A release from before release files has a kernel that cannot install from one: the script names that release's
    own script, which installs it with git, as before."""
    cli = w.work / "plugin" / "engine" / "kernel" / "cli.py"
    cli.write_text(cli.read_text().replace('"--file"', '"--from-file"'))
    w.publish("v0.10.7", file=False)
    p = w.install("--no-browser", "--ref", "v0.10.7")
    assert p.returncode == 1 and p.stdout.splitlines()[-2:] == [
        "Downloading thimble 0.10.7 into ~/.thimble... failed: thimble 0.10.7 comes from before thimble's releases had "
        "files, so this script cannot install it.",
        "Its own script can: curl -fsSL https://raw.githubusercontent.com/safety-research/thimble/v0.10.7/scripts/"
        "install.sh | bash -s -- --ref v0.10.7. Nothing was installed."], text_of(p)
    assert w.gh.requests()[-2:] == ["GET /releases/download/v0.10.7/SHA256SUMS", "GET /archive/v0.10.7.tar.gz"]
    nothing_installed(w)


def live_head(w) -> str:
    return sh("git", "rev-parse", "mine", cwd=w.th / "fixes" / "live")


def test_ref_moves_an_install_that_is_there_and_downloads_only_what_it_moves_to(w):
    assert w.install("--no-browser").returncode == 0
    v9 = w.publish("v0.10.9")
    head, before = live_head(w), w.gh.files()
    # the release that is installed: nothing is downloaded, and nothing moves
    p = w.install("--no-browser", "--ref", "v0.10.8")
    assert p.returncode == 0, text_of(p)
    assert "It moves to" not in p.stdout and live_head(w) == head and w.gh.files() == before, text_of(p)
    # another release: its file, once, and the install moves to it with its fixes
    p = w.install("--no-browser", "--ref", "v0.10.9")
    assert p.returncode == 0, text_of(p)
    lines = p.stdout.splitlines()
    assert ("thimble 0.10.8 is installed in ~/.thimble. It moves to 0.10.9 now, and keeps your fixes (a few "
            "minutes)...") in lines, lines
    assert "Updated thimble 0.10.8 → 0.10.9 (terminal plugin)" in lines
    assert lines[-1] == "thimble 0.10.9 is installed in ~/.thimble. The plugin and the commands are in place."
    made = sh("git", "rev-parse", "refs/thimble/releases/v0.10.9", cwd=w.th / "fixes" / "live")
    assert live_head(w) == made and (w.release()["tag"], w.release()["commit"]) == ("v0.10.9", v9)
    assert w.gh.files() == [*before, "/releases/download/v0.10.9/thimble-0.10.9.tar.gz"]
    # a branch at the commit that is installed: GitHub's archive of it says so, and nothing moves
    p = w.install("--no-browser", "--ref", "main")
    assert p.returncode == 0, text_of(p)
    assert "It moves to" not in p.stdout and live_head(w) == made and w.release()["tag"] == "v0.10.9", text_of(p)
    assert w.gh.requests()[-2:] == ["GET /archive/main.tar.gz", "GET /releases/latest"]


def test_ref_to_a_prerelease_installs_its_file_by_its_name_beside_the_newest_release(w):
    """A prerelease has its file too (the Action attaches one to each release that is published), but its version is no
    release's: the install records it as it records a branch, by its name and beside the newest release then
    (based_on), so that thimble update moves only to a newer release, never back to an older one. --ref on an install
    that is there records it the same way, at the same commit."""
    rc = w.publish("v0.11.0-rc1", file=False)
    w.gh.publish(w.bare, "v0.11.0-rc1", latest=False)
    p = w.install("--no-browser", "--ref", "v0.11.0-rc1")
    assert p.returncode == 0, text_of(p)
    assert f"thimble v0.11.0-rc1 at {rc[:7]} is installed." in p.stdout.splitlines()
    rel, made = w.release(), live_head(w)
    assert (rel["ref"], rel["based_on"], rel["commit"], "tag" in rel) == ("v0.11.0-rc1", "v0.10.8", rc, False)
    assert rel["source"] == f"{w.gh.url}/releases/download/v0.11.0-rc1/thimble-0.11.0-rc1.tar.gz"
    link = w.home / ".local" / "bin" / "thimble"
    for args in (["update", "--check"], ["update"]):
        got = subprocess.run([str(link), *args], capture_output=True, text=True, env=w.env())
        assert got.stdout.strip() == (f"thimble v0.11.0-rc1 at {rc[:7]} is up to date; the newest release is "
                                      "0.10.8."), text_of(got)
    assert live_head(w) == made
    # back to 0.10.8, then to the prerelease again, on the install that is there
    assert w.install("--no-browser", "--ref", "v0.10.8").returncode == 0
    p = w.install("--no-browser", "--ref", "v0.11.0-rc1")
    assert p.returncode == 0, text_of(p)
    rel = w.release()
    assert (rel["ref"], rel["based_on"], rel["commit"], "tag" in rel) == ("v0.11.0-rc1", "v0.10.8", rc, False)
    assert live_head(w) == made
    # each install downloaded its release's file, which GitHub counts
    assert w.gh.files() == ["/releases/download/v0.11.0-rc1/thimble-0.11.0-rc1.tar.gz",
                            "/releases/download/v0.10.8/thimble-0.10.8.tar.gz",
                            "/releases/download/v0.11.0-rc1/thimble-0.11.0-rc1.tar.gz"]


def update_as_before_release_files(w, tag: str) -> str:
    """thimble update to the release `tag` as a thimble from before release files makes it, with git: the tag fetched
    from thimble's repository into live, mine and the release checkout moved to GitHub's commit, and release.json given
    that commit as base and the tag. The fields that thimble does not know (made, commit, source, sha256) stay as they
    were. GitHub's commit of the release."""
    live, rel = w.th / "fixes" / "live", w.release()
    sh("git", "fetch", "-q", "--no-tags", str(w.bare), f"+refs/tags/{tag}:refs/thimble/releases/{tag}", cwd=live)
    new = sh("git", "rev-parse", f"refs/thimble/releases/{tag}^{{commit}}", cwd=live)
    sh("git", "checkout", "-q", "-B", "mine", new, cwd=live)
    sh("git", "checkout", "-q", "--detach", new, cwd=w.th / "fixes" / "release")
    rel.update(base=new, checked=new, tag=tag, version="", updated=1.0)
    (w.th / "fixes" / "release.json").write_text(json.dumps(rel, indent=2) + "\n")
    return new


def test_ref_moves_an_install_that_a_thimble_before_release_files_updated(w):
    """A thimble from before release files moves base to GitHub's commit of the newer release, and leaves the fields of
    release.json it does not know as they were: they name the release it moved from. --ref back to that release moves
    the install there, as it moves any install, and the release is the same commit as a fresh install's."""
    assert w.install("--no-browser").returncode == 0
    made, v8 = live_head(w), sh("git", "rev-parse", "v0.10.8", cwd=w.bare)
    v9 = w.publish("v0.10.9")
    assert update_as_before_release_files(w, "v0.10.9") == v9
    assert IN.FX.github_commit(w.release()) == v9
    p = w.install("--no-browser", "--ref", "v0.10.8")
    assert p.returncode == 0, text_of(p)
    assert ("thimble 0.10.9 is installed in ~/.thimble. It moves to 0.10.8 now, and keeps your fixes (a few "
            "minutes)...") in p.stdout.splitlines(), text_of(p)
    rel = w.release()
    assert (live_head(w), rel["made"], rel["tag"], rel["commit"]) == (made, made, "v0.10.8", v8)


def test_a_branch_is_named_by_github_s_commit_of_what_live_is_on():
    made, github, moved = "1" * 40, "2" * 40, "3" * 40
    rel = {"kind": "release", "ref": "try-r110", "base": made, "made": made, "commit": github, "based_on": "v0.10.8"}
    assert IN.FX.release_name(rel) == "try-r110 at 2222222"
    # a thimble from before release files moved live to another branch with git: GitHub's commit is base
    rel.update(ref="try-r111", base=moved)
    assert IN.FX.release_name(rel) == "try-r111 at 3333333"


def test_ref_over_a_dev_install_sets_its_fixes_aside_and_installs_the_branch(w, monkeypatch):
    clone = w.home / "thimble"
    sh("git", "clone", "-q", str(w.bare), str(clone))
    assert w.install("--local", "--no-browser", script=clone / "scripts" / "install.sh").returncode == 0
    made_fix(w, monkeypatch, "say read, not coverage")
    assert w.release()["kind"] == "clone"
    tip = w.publish(branch="try-r110")
    p = w.install("--no-browser", "--ref", "try-r110")
    assert p.returncode == 0, text_of(p)
    assert "The fixes of your dev install are set aside in ~/.thimble/fixes-dev-" in p.stdout, p.stdout
    rel = w.release()
    assert (rel["kind"], rel["ref"], rel["commit"], rel["based_on"]) == ("release", "try-r110", tip, "v0.10.8")
    assert w.settings()["extraKnownMarketplaces"]["thimble"]["source"] == {"source": "directory",
                                                                          "path": str(w.th / "fixes" / "live")}


def made_fix(w, monkeypatch, words: str) -> dict:
    """A fix made as thimble makes one, in the test's process with the person's environment: its copy cut from mine,
    the fixer's change written there, done with no tests, then on with a made-up key press."""
    from kernel import fixes as FX  # noqa: PLC0415

    for k, v in w.env().items():
        monkeypatch.setenv(k, v)
    monkeypatch.delenv("CLAUDECODE", raising=False)
    rec = FX.new(words)
    (Path(rec["work"]) / "plugin" / f"made-up-{rec['id']}.txt").write_text(f"{words}\n")
    rec = FX.done(rec["id"], words, "", tests=False)
    assert rec["state"] == "ready", rec
    secret = os.urandom(16).hex()
    FX.write_json(FX.home() / "asks" / f"{rec['id']}.json", {"key": FX.key_hash(secret)})
    FX.apply(rec["id"], secret)
    return FX.get(rec["id"])


def install_as_before_release_files(w) -> None:
    """thimble 0.10.8 as an install script from before release files installed it: git cloned the release, and the
    kernel's steps took that clone (--from), so live is a clone with GitHub's history."""
    work = w.tmp / "tmp" / "thimble-install.older"
    clone = work / "thimble"
    sh("git", "-c", "advice.detachedHead=false", "clone", "-q", "--depth", "1", "--branch", "v0.10.8", f"file://{w.bare}",
       str(clone))
    for step in (["release", "--from", str(clone)], ["plugin"], ["commands"]):
        p = subprocess.run([sys.executable, "-B", str(clone / "plugin" / "engine" / "thimble.py"), "install", *step,
                            "--bin-dir", str(w.home / ".local" / "bin"), "--notes", str(work / "notes"), "--state",
                            str(work / "state.json")], env=w.env(), cwd=w.home, capture_output=True, text=True,
                           timeout=300)
        assert p.returncode == 0, text_of(p)
    shutil.rmtree(work)


def test_an_install_from_a_script_before_release_files_updates_to_a_release_file_with_its_fixes(w, monkeypatch):
    install_as_before_release_files(w)
    v8 = sh("git", "rev-parse", "v0.10.8", cwd=w.bare)
    rel = w.release()
    assert (rel["kind"], rel["base"], rel["commit"], rel["tag"]) == ("github", v8, v8, "v0.10.8")
    rec = made_fix(w, monkeypatch, "say read, not coverage")
    v9 = w.publish("v0.10.9")
    from kernel import fixes as FX  # noqa: PLC0415

    # the fix's checks run as in test_fixes.py: no sandbox runtime here
    monkeypatch.setattr(FX, "sandbox_argv", lambda *a, **k: ["/bin/bash", "-c"])
    monkeypatch.setenv("THIMBLE_FIX_TESTS", "true")
    out = FX.update()
    assert (out["from"], out["to"], out["back"], out["aside"]) == ("0.10.8", "0.10.9", [rec["id"]], [])
    live = FX.live_dir()
    made = sh("git", "rev-parse", "refs/thimble/releases/v0.10.9", cwd=live)
    assert sh("git", "rev-parse", "mine^", cwd=live) == made and FX.get(rec["id"])["state"] == "on"
    assert (live / "plugin" / f"made-up-{rec['id']}.txt").is_file()
    rel = w.release()
    assert (rel["kind"], rel["tag"], rel["commit"], rel["base"]) == ("release", "v0.10.9", v9, made)
    assert sh("git", "rev-parse", "HEAD", cwd=FX.release_dir()) == made and made in (FX.home() / "off.sh").read_text()
    assert w.gh.files() == ["/releases/download/v0.10.9/thimble-0.10.9.tar.gz"]
    # the older script's way, given a folder that is no git clone, stops before anything
    folder = w.tmp / "tmp" / "thimble-install.x" / "thimble-0.10.8"
    folder.mkdir(parents=True)
    p = subprocess.run([sys.executable, "-B", str(ROOT / "plugin" / "engine" / "thimble.py"), "install", "release",
                        "--from", str(folder)], env={**w.env(), "THIMBLE_HOME": str(w.tmp / "other-home")},
                       capture_output=True, text=True, timeout=60)
    assert (p.returncode, p.stdout.strip()) == (1, f"--from takes a git clone of thimble, and {folder} is not one; "
                                                   "give the release's file with --file."), text_of(p)
    assert not (w.tmp / "other-home" / "fixes" / "live").exists()


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
    assert before_notes(p.stdout)[-3:] == [
        "thimble is installed from your clone ~/thimble.", "", "Try it now: run claude in a folder of data files."], \
        p.stdout
    assert w.settings()["extraKnownMarketplaces"]["thimble"]["source"] == {"source": "directory", "path": str(clone)}
    assert os.readlink(w.home / ".local" / "bin" / "thimble") == str(clone / "plugin" / "bin" / "thimble")
    assert not (w.th / "fixes").exists()


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
