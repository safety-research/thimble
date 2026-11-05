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


def release_tree(at: Path, old_kernel: bool = False) -> Path:
    """A made-up release of thimble: this repository's kernel, launcher, manifest and scripts, and a made-up workbench
    (its lock files, its setup's code, and a launcher whose setup says what it was given). old_kernel: a release from
    before the install had steps in the kernel (no kernel/install.py)."""
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
    if old_kernel:
        (at / "plugin" / "engine" / "kernel" / "install.py").unlink()
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

    def claude_code(self, source: dict, location: Path) -> None:
        """Claude Code with thimble's marketplace from `source` (its folder `location`) and the plugin installed."""
        (self.cc / "plugins").mkdir(parents=True, exist_ok=True)
        (self.cc / "plugins" / "known_marketplaces.json").write_text(json.dumps({"thimble": {
            "source": source, "installLocation": str(location)}}))
        s = json.loads((self.cc / "settings.json").read_text()) if (self.cc / "settings.json").exists() else {}
        s.setdefault("extraKnownMarketplaces", {})["thimble"] = {"source": source}
        (self.cc / "settings.json").write_text(json.dumps(s, indent=2))
        subprocess.run([str(self.bin / "claude"), "plugin", "install", "thimble@thimble"], env=self.env(), check=True)


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


def test_run_by_claude_the_end_says_to_reload_the_plugins_in_its_session(w):
    """Claude Code sets CLAUDECODE for the commands Claude runs: the install's end then says how to try the plugin in
    that very session, where a terminal's says to start claude."""
    p = w.install("--no-browser", CLAUDECODE="1")
    assert p.returncode == 0, text_of(p)
    assert before_notes(p.stdout)[-3:] == ["thimble 0.10.8 is installed.", "",
                                           "Try it now: type /reload-plugins in this Claude Code session."], p.stdout


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


@pytest.mark.parametrize("system", ["MINGW64_NT-10.0-22631", "MSYS_NT-10.0-22631", "CYGWIN_NT-10.0-22631"])
def test_on_windows_itself_the_install_stops_at_once_and_names_wsl_2(w, system):
    """Git Bash, MSYS2 or Cygwin on Windows itself, as uname -s names them: thimble runs on Windows only in WSL 2, so
    the install says so and stops before it runs any program of its own or downloads anything."""
    stub(w.bin / "uname", f'echo "{system}"\n')
    ran = w.tmp / "python-ran.log"
    stub(w.bin / "python3", f'echo "$@" >> "{ran}"\nexec "{sys.executable}" "$@"\n')
    p = w.install("--no-browser", THIMBLE_PYTHON=str(w.bin / "python3"))
    assert p.returncode == 2 and p.stdout == "", text_of(p)
    assert p.stderr == "install.sh: thimble runs on Windows only in WSL 2 (wsl --install)\n"
    assert not ran.exists() and w.calls() == [] and not w.th.exists() and not w.cc.exists()
    assert not list((w.tmp / "tmp").glob("thimble-install.*"))


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


def test_an_old_claude_code_is_updated_by_what_installed_it(w):
    """Claude Code below the plugin's minimum: the fix is the update that reaches it, by where its claude lives. A build
    from Homebrew or npm does not update itself (its claude update says updates are disabled, or to use the package
    manager)."""
    for at, fix in ((w.tmp / "opt" / "homebrew" / "Caskroom" / "claude-code" / "2.1.283" / "claude",
                     "brew upgrade claude-code"),
                    (w.tmp / "lib" / "node_modules" / "@anthropic-ai" / "claude-code" / "cli.js",
                     "npm install -g @anthropic-ai/claude-code@latest"),
                    (w.tmp / "own" / ".local" / "share" / "claude" / "versions" / "2.1.283", "claude update")):
        stub(at, f'exec "{sys.executable}" "{w.tmp / "claude.py"}" "$@"\n')
        (w.bin / "claude").unlink()
        (w.bin / "claude").symlink_to(at)
        p = w.install("--no-browser", FAKE_CLAUDE_VERSION="2.1.283")
        assert p.returncode == 1
        assert f"  - Claude Code 2.1.307 or later (the one here is 2.1.283): {fix}" in p.stdout.splitlines(), p.stdout


def test_a_download_that_fails_says_git_s_last_line_and_installs_nothing(w):
    p = w.install("--no-browser", THIMBLE_UPDATE_URL=str(w.tmp / "no-such-repository.git"))
    assert p.returncode == 1, text_of(p)
    lines = p.stdout.splitlines()
    assert lines[-2].startswith("Downloading thimble into ~/.thimble... failed: ") and "no-such-repository" in lines[-2]
    assert lines[-1] == "Check the network, then run the install again. Nothing was installed."
    p = w.install("--no-browser", "--ref", "no-such-branch")
    assert p.returncode == 1
    assert p.stdout.splitlines()[-2].startswith("Downloading thimble no-such-branch into ~/.thimble... failed: ")
    assert p.stdout.splitlines()[-1] == ("Check the network and the name no-such-branch, then run the install again. "
                                         "Nothing was installed.")
    assert not (w.th / "fixes").exists()


def test_cards_that_cannot_draw_are_said_last_with_their_fix(w):
    p = w.install("--no-browser", FAKE_SANDBOX="missing")
    assert p.returncode == 0, text_of(p)
    lines = p.stdout.splitlines()
    assert "  Cards cannot draw here yet: the note at the end says why." in lines
    assert lines[-2] == ("Note: cards cannot draw yet: bubblewrap, socat and ripgrep are missing. Install them: sudo "
                         "apt-get install bubblewrap socat ripgrep")


# ------------------------------------------------------------------ again, and later


def test_running_it_again_leaves_the_install_as_it_is(w):
    assert w.install("--no-browser").returncode == 0
    before = w.calls()
    p = w.install("--no-browser")
    assert p.returncode == 0, text_of(p)
    assert p.stdout.splitlines()[-1] == ("thimble 0.10.8 is installed in ~/.thimble. The plugin and the commands are "
                                         "in place.")
    assert "Downloading" not in p.stdout
    assert w.calls()[len(before):] == ["--version"], "nothing changes in Claude Code"


def test_a_newer_release_is_said_with_thimble_update(w):
    assert w.install("--no-browser").returncode == 0
    w.publish("v0.10.9")
    p = w.install("--no-browser")
    assert p.stdout.splitlines()[-2:] == [
        "thimble 0.10.8 is installed in ~/.thimble. The plugin and the commands are in place.",
        "thimble 0.10.9 is out: thimble update moves to it and keeps your fixes."], text_of(p)


def test_a_part_left_out_before_is_put_in_place(w):
    assert w.install("--no-browser").returncode == 0
    p = w.install()
    assert p.returncode == 0, text_of(p)
    assert p.stdout.split("\n\n")[2] == "thimble 0.10.8 is installed in ~/.thimble.", p.stdout
    assert "  Claude Code loads it from ~/.thimble." in p.stdout.splitlines()
    assert "The commands thimble and thimble-browser are in ~/.local/bin." in p.stdout.splitlines()


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


def github_install(w, configs: dict) -> Path:
    """thimble 0.10.7 as its install left it: the plugin from GitHub (Claude Code's clone of it, in its marketplaces),
    its settings, the thimble command a link into Claude Code's clone, and the workbench built in the clone ~/thimble,
    with its launcher."""
    clone = w.cc / "plugins" / "marketplaces" / "thimble"
    sh("git", "clone", "-q", str(w.bare), str(clone))
    w.cc.mkdir(exist_ok=True)
    (w.cc / "settings.json").write_text(json.dumps({"pluginConfigs": {"thimble@thimble": {"options": configs}},
                                                    "theme": "light"}))
    w.claude_code({"source": "github", "repo": "safety-research/thimble"}, clone)
    old = w.home / "thimble"
    sh("git", "clone", "-q", str(w.bare), str(old))
    (old / "browser" / "backend" / ".venv" / "bin").mkdir(parents=True)
    (old / "browser" / "frontend" / "node_modules").mkdir(parents=True)
    bin_ = w.home / ".local" / "bin"
    bin_.mkdir(parents=True)
    (bin_ / "thimble").symlink_to(clone / "plugin" / "bin" / "thimble")
    (bin_ / "thimble-browser").write_text(f"#!/bin/sh\n# thimble-browser, {IN.MARKER}: starts the browser workbench of "
                                          f"this checkout.\nexec '{old}/browser/scripts/thimble-browser' \"$@\"\n")
    (bin_ / "thimble-browser").chmod(0o755)
    (w.home / ".thimble-browser").mkdir()
    (w.home / ".thimble-browser" / "checkout").write_text(f"{old / 'browser'}\n")
    return old


def test_an_install_from_github_with_a_clone_moves_into_thimbles_home_and_keeps_its_settings(w):
    configs = {"minimal": True, "citations": "manual"}
    old = github_install(w, configs)
    calls = len(w.calls())
    p = w.install()
    assert p.returncode == 0, text_of(p)
    live = w.th / "fixes" / "live"
    assert w.calls()[calls + 1:calls + 3] == [f"plugin marketplace add {live}", "plugin update thimble@thimble"]
    s = w.settings()
    assert s["pluginConfigs"]["thimble@thimble"]["options"] == configs and s["theme"] == "light"
    assert s["extraKnownMarketplaces"]["thimble"]["source"] == {"source": "directory", "path": str(live)}
    # the workbench's packages came from the clone, by hard links, while their lock files are the same
    assert (live / "browser" / "backend" / ".venv" / "bin").is_dir()
    assert not (w.home / ".thimble-browser" / "checkout").exists()
    launcher = (w.home / ".local" / "bin" / "thimble-browser").read_text()
    assert f"exec {live / 'browser' / 'scripts' / 'thimble-browser'}" in launcher
    after = p.stdout.split("The commands thimble and thimble-browser are in ~/.local/bin.\n\n", 1)[1].splitlines()
    assert after[:2] == ["Claude Code loaded thimble from GitHub. It now loads it from ~/.thimble.",
                         "  ~/thimble is no longer used, so you can delete it."], p.stdout
    assert old.is_dir(), "the install never deletes a folder of the person's"


def test_a_dev_install_from_a_clone_moves_into_thimbles_home(w):
    """An install with --local before 0.10.8: Claude Code loads the plugin from the clone ~/code/thimble, and the
    command links into it. The release install moves both, and names the clone as no longer used, never as one to
    delete: the person works on thimble's code there."""
    clone = w.home / "code" / "thimble"
    sh("git", "clone", "-q", str(w.bare), str(clone))
    w.claude_code({"source": "directory", "path": str(clone)}, clone)
    (w.home / ".local" / "bin").mkdir(parents=True)
    (w.home / ".local" / "bin" / "thimble").symlink_to(clone / "plugin" / "bin" / "thimble")
    p = w.install("--no-browser")
    assert p.returncode == 0, text_of(p)
    assert p.stdout.split("The command thimble is in ~/.local/bin.\n\n", 1)[1].splitlines()[:2] == [
        "Claude Code loaded thimble from ~/code/thimble. It now loads it from ~/.thimble.",
        "  ~/code/thimble is no longer used."], p.stdout


@pytest.mark.parametrize("work", ["a changed file", "a new file", "a stash", "a commit of its own", "a worktree"])
def test_a_clone_that_holds_work_of_its_own_is_never_called_one_to_delete(w, work):
    """The clone ~/thimble of 0.10.7's install (its workbench) is no longer used after the release install. Before, the
    install said that the person could delete it, whatever it held; now only when it holds nothing that its remote
    does not (test_an_install_from_github_…), and a clone with work of the person's in it it does not name at all."""
    old = github_install(w, {})
    lock = old / "browser" / "backend" / "uv.lock"
    if work == "a changed file":
        lock.write_text("the person's change\n")
    elif work == "a new file":
        (old / "notes.txt").write_text("the person's notes\n")
    elif work == "a stash":
        lock.write_text("the person's change\n")
        sh("git", "stash", "-q", cwd=old)
    elif work == "a commit of its own":
        sh("git", "checkout", "-q", "-b", "wip", cwd=old)
        lock.write_text("the person's change\n")
        commit_all(old, "the person's change")
    else:
        sh("git", "worktree", "add", "-q", str(w.home / "thimble-wip"), cwd=old)
    p = w.install()
    assert p.returncode == 0, text_of(p)
    assert "~/thimble is no longer used" not in p.stdout, p.stdout
    assert "delete" not in p.stdout


def test_an_install_whose_claude_code_loads_live_keeps_it_and_its_fixes(w):
    """Claude Code loads thimble from live already, with a fix on, and that release's kernel has no install steps (a
    release before 0.10.8): the install keeps live as it is, runs the steps of the release it downloads, and says
    what is installed and that thimble update moves to the newer release."""
    old = release_tree(w.tmp / "old-release", old_kernel=True)
    sh("git", "init", "-q", "-b", "main", str(old))
    base = commit_all(old, "thimble 0.10.7", "v0.10.7")
    live, rel_dir = w.th / "fixes" / "live", w.th / "fixes" / "release"
    sh("git", "clone", "-q", str(old), str(live))
    sh("git", "checkout", "-q", "-b", "mine", cwd=live)
    (live / "plugin" / "fix.txt").write_text("a made-up fix\n")
    fix = commit_all(live, "a made-up fix")
    sh("git", "worktree", "add", "-q", "--detach", str(rel_dir), base, cwd=live)
    (w.th / "fixes" / "release.json").write_text(json.dumps({"kind": "github", "base": base, "tag": "v0.10.7",
                                                             "pointed": True, "repo": str(live), "version": ""}))
    w.claude_code({"source": "directory", "path": str(live)}, live)
    (w.home / ".local" / "bin").mkdir(parents=True)
    (w.home / ".local" / "bin" / "thimble").symlink_to(rel_dir / "plugin" / "bin" / "thimble")
    p = w.install("--no-browser")
    assert p.returncode == 0, text_of(p)
    assert p.stdout.splitlines()[-3:] == [
        "Downloading thimble 0.10.8 for its install steps... done.",
        "thimble 0.10.7 is installed in ~/.thimble. The plugin and the commands are in place.",
        "thimble 0.10.8 is out: thimble update moves to it and keeps your fixes."], text_of(p)
    assert sh("git", "rev-parse", "mine", cwd=live) == fix, "the fix stays"


# ------------------------------------------------------------------ an earlier install moved by thimble update alone


def updated_by_thimble_update(w) -> tuple[Path, Path]:
    """thimble 0.10.7 as its install left it (github_install), moved to a newer release by thimble update alone: Claude
    Code loads live, the workbench is built there (browser-ready), and the launcher on PATH still starts the clone's
    workbench, whose script hands it to live's. Both scripts are this repository's; live's server is a stand-in that
    logs its start. The clone, and that log."""
    old = github_install(w, {})
    w.publish("v0.10.9")
    p = subprocess.run([str(w.home / ".local" / "bin" / "thimble"), "update"], capture_output=True, text=True,
                       env=w.env())
    assert p.returncode == 0, text_of(p)
    live = w.th / "fixes" / "live"
    assert (w.th / "fixes" / "browser-ready").read_text().strip() == str(live / "browser")
    for b in (old / "browser", live / "browser"):
        shutil.copy(ROOT / "browser" / "scripts" / "thimble-browser", b / "scripts" / "thimble-browser")
    log = w.tmp / "server.log"
    stub(live / "browser" / "backend" / ".venv" / "bin" / "python", f'echo "server $*" >> "{log}"\n')
    (w.home / "data").mkdir()
    return old, log


def start(w) -> subprocess.CompletedProcess:
    """thimble-browser in ~/data, by the launcher on PATH, as the person starts it in a terminal."""
    env = w.env(PATH=f"{w.bin}:{w.home / '.local' / 'bin'}:/usr/bin:/bin")
    return subprocess.run(["thimble-browser"], capture_output=True, text=True, env=env, cwd=w.home / "data",
                          stdin=subprocess.DEVNULL, timeout=120)


def test_thimble_browser_from_live_points_an_earlier_install_s_launcher_at_live_and_the_clone_can_go(w):
    old, log = updated_by_thimble_update(w)
    launcher = w.home / ".local" / "bin" / "thimble-browser"
    live_script = w.th / "fixes" / "live" / "browser" / "scripts" / "thimble-browser"
    p = start(w)
    assert p.returncode == 0, text_of(p)
    # the clone's script handed the workbench to live's, which pointed the launcher at live and said nothing of it
    assert p.stderr.splitlines() == ["thimble-browser: from ~/.thimble/fixes/live, the release thimble update "
                                     "installed, with your fixes"], p.stderr
    assert launcher.read_text().splitlines() == [
        "#!/bin/sh", f"# thimble-browser, {IN.MARKER}: starts the browser workbench in ~/.thimble/fixes/live/browser.",
        f'exec {live_script} "$@"']
    assert launcher.stat().st_mode & 0o777 == 0o755
    assert log.read_text().splitlines() == [f"server -m app.cli browser --cwd {w.home / 'data'} --session new"]
    # the clone can go: the launcher starts live's workbench itself, with nothing to say
    shutil.rmtree(old)
    p = start(w)
    assert (p.returncode, p.stderr) == (0, ""), text_of(p)
    assert len(log.read_text().splitlines()) == 2


def test_a_dev_install_s_launcher_stays_on_its_clone(w):
    """A dev install (--local) whose workbench runs from live: its launcher starts the clone on purpose."""
    old, log = updated_by_thimble_update(w)
    rel = {**w.release(), "kind": "clone", "repo": str(old)}
    (w.th / "fixes" / "release.json").write_text(json.dumps(rel, indent=1) + "\n")
    launcher = w.home / ".local" / "bin" / "thimble-browser"
    before = launcher.read_text()
    p = start(w)
    assert p.returncode == 0 and len(log.read_text().splitlines()) == 1, text_of(p)
    assert launcher.read_text() == before
    # the kernel's step alone leaves it too
    p = subprocess.run([sys.executable, str(ROOT / "plugin" / "engine" / "thimble.py"), "install", "launcher",
                        "--bin-dir", str(launcher.parent)], capture_output=True, text=True, env=w.env())
    assert (p.returncode, p.stdout, p.stderr) == (0, "", "") and launcher.read_text() == before


@pytest.mark.skipif(os.geteuid() == 0, reason="root writes a folder it may not write")
def test_a_launcher_that_cannot_be_pointed_at_live_says_why_and_the_workbench_starts(w):
    old, log = updated_by_thimble_update(w)
    bin_ = w.home / ".local" / "bin"
    bin_.chmod(0o555)
    try:
        p = start(w)
    finally:
        bin_.chmod(0o755)
    assert p.returncode == 0 and len(log.read_text().splitlines()) == 1, text_of(p)
    assert p.stderr.splitlines()[1:] == [
        "thimble-browser: ~/.local/bin/thimble-browser could not be pointed at ~/.thimble/fixes/live (Permission "
        "denied), so it still starts the workbench through ~/thimble: keep that folder until it can."], p.stderr
    assert IN.launcher_target(bin_ / "thimble-browser") == str(old / "browser" / "scripts" / "thimble-browser")


def test_a_launcher_names_its_script_in_the_shell_s_quotes(tmp_path):
    to = tmp_path / "it's here" / "browser" / "scripts" / "thimble-browser"
    p = tmp_path / "thimble-browser"
    IN.write_launcher(p, to)
    assert IN.launcher_target(p) == str(to) and p.stat().st_mode & 0o777 == 0o755
    # as the installs of 0.10.2 to 0.10.7 wrote it
    p.write_text(f"#!/bin/sh\n# thimble-browser, {IN.MARKER}: starts the browser workbench of this checkout.\n"
                 "exec '/a b/thimble/browser/scripts/thimble-browser' \"$@\"\n")
    assert IN.launcher_target(p) == "/a b/thimble/browser/scripts/thimble-browser"
    # the workbench's own script names the marker in its code: no launcher
    assert IN.launcher_target(ROOT / "browser" / "scripts" / "thimble-browser") == ""

def test_a_live_with_no_release_json_goes_aside_with_its_fixes_and_the_install_says_where(w):
    """~/.thimble/fixes/live holds a fix commit, and release.json beside it is gone. Before, the install deleted live
    with the fix; now it moves live aside, beside it, by the date and time, says where in a line at the end, and
    installs the release in its place."""
    live = w.th / "fixes" / "live"
    sh("git", "clone", "-q", str(w.bare), str(live))
    sh("git", "checkout", "-q", "-b", "mine", cwd=live)
    (live / "plugin" / "my-fix.txt").write_text("a made-up fix\n")
    fix = commit_all(live, "a made-up fix")
    p = w.install("--no-browser")
    assert p.returncode == 0, text_of(p)
    aside = [d for d in (w.th / "fixes").iterdir() if d.name.startswith("live-")]
    assert len(aside) == 1 and re.fullmatch(r"live-\d{8}-\d{6}", aside[0].name), aside
    assert sh("git", "rev-parse", "mine", cwd=aside[0]) == fix
    assert (aside[0] / "plugin" / "my-fix.txt").is_file()
    assert (f"Note: ~/.thimble/fixes/live had no release.json beside it that thimble could read, so the install moved "
            f"it to ~/.thimble/fixes/{aside[0].name}, with any fixes in it.") in p.stdout.splitlines(), p.stdout
    assert sh("git", "rev-parse", "mine", cwd=live) == sh("git", "rev-parse", "v0.10.8", cwd=w.bare)


# ------------------------------------------------------------------ what is the person's

def test_git_against_thimbles_repository_takes_no_config_of_a_repository_around_the_folder(w):
    """The person's folder is in a git repository whose config rewrites thimble's address into a command (a
    downloaded repository with its .git/config planted). Before, the install's look for the newest release ran there,
    and a session's check for a newer one, which the plugin runs at each start once the install points Claude Code at
    live, ran in the session's folder: the command ran. Now git against thimble's repository runs from /, with no ext::
    transport, also when the person's own config allows it."""
    ran = w.tmp / "planted-ran"
    planted = f"ext::sh -c touch% {ran}"
    sh("git", "init", "-q", str(w.home))
    sh("git", "config", "protocol.ext.allow", "always", cwd=w.home)
    sh("git", "config", f"url.{planted}.insteadOf", str(w.bare), cwd=w.home)
    p = w.install("--no-browser")
    assert p.returncode == 0 and not ran.exists(), text_of(p)
    # a branch: its tip and the newest release, read from thimble's repository, and fetched into live
    tip = w.publish(branch="try-r109")
    p = w.install("--no-browser", "--ref", "try-r109")
    assert p.returncode == 0 and not ran.exists(), text_of(p)
    assert sh("git", "rev-parse", "mine", cwd=w.th / "fixes" / "live") == tip
    (w.home / "runs").mkdir()
    check = [str(w.home / ".local" / "bin" / "thimble"), "fix", "update", "--check", "--once", "--json"]
    got = subprocess.run(check, cwd=w.home / "runs", env=w.env(THIMBLE_ROOT=str(w.home / "runs")),
                         capture_output=True, text=True, timeout=120)
    assert got.returncode == 0 and not ran.exists(), text_of(got)
    # the person's own config, which allows ext:: and rewrites thimble's address
    (w.home / ".gitconfig").write_text(
        f'[protocol "ext"]\n\tallow = always\n[url "{planted}"]\n\tinsteadOf = {w.bare}\n')
    got = subprocess.run(check, cwd=w.tmp, env=w.env(), capture_output=True, text=True, timeout=120)
    assert not ran.exists(), text_of(got)


def test_the_plugin_step_writes_claude_codes_settings_through_a_link(w):
    """Claude Code's settings.json is a link into a dotfiles folder. Before, the install wrote a file of its own in the
    link's place, and the dotfiles copy kept GitHub as the marketplace's source; now the file the link names takes the
    new source, keeps its mode and the rest of its settings, and the link stays."""
    dot = w.home / "dotfiles" / "claude-settings.json"
    dot.parent.mkdir()
    dot.write_text(json.dumps({"extraKnownMarketplaces": {"thimble": {"source": {"source": "github",
                                                                                   "repo": "safety-research/thimble"}}},
                               "permissions": {"deny": ["Read(~/.ssh/**)"]}}, indent=2))
    dot.chmod(0o600)
    w.cc.mkdir()
    (w.cc / "settings.json").symlink_to(dot)
    p = w.install("--no-browser")
    assert p.returncode == 0, text_of(p)
    assert (w.cc / "settings.json").is_symlink() and os.readlink(w.cc / "settings.json") == str(dot)
    s = json.loads(dot.read_text())
    assert s["extraKnownMarketplaces"]["thimble"]["source"] == {"source": "directory",
                                                                "path": str(w.th / "fixes" / "live")}
    assert s["permissions"] == {"deny": ["Read(~/.ssh/**)"]}
    assert dot.stat().st_mode & 0o777 == 0o600
    assert sorted(x.name for x in dot.parent.iterdir()) == ["claude-settings.json"]


# ------------------------------------------------------------------ thimble 0.9


def test_thimble_0_9_stops_the_install_with_the_commands_that_remove_it(w):
    w.cc.mkdir()
    (w.cc / "settings.json").write_text(json.dumps({"enabledPlugins": {"thimble@thimble-local": True}}))
    p = w.install("--no-browser")
    assert p.returncode == 1, text_of(p)
    lines = p.stdout.splitlines()
    at = lines.index("Downloading thimble 0.10.8 into ~/.thimble...")
    assert lines[at + 1] == ""
    assert lines[at + 2].startswith("thimble 0.9 is installed here. Remove it before you install")
    assert "  claude plugin uninstall thimble@thimble-local" in lines
    assert lines[-2:] == ["", "Remove it with the commands above, then run the install again. Nothing was installed."]
    assert not (w.th / "fixes").exists()


def test_a_thimble_link_into_a_folder_that_is_gone_is_called_that_and_its_fix_is_still_rm_f(w):
    """A ~/.local/bin/thimble that links into a thimble folder that is gone (a 0.10 clone installed with --local, then
    deleted) says nothing of which thimble it was: the install calls it what it is, and its fix is rm -f of the link."""
    (w.home / ".local" / "bin").mkdir(parents=True)
    (w.home / ".local" / "bin" / "thimble").symlink_to(w.home / "thimble" / "plugin" / "bin" / "thimble")
    p = w.install("--no-browser")
    assert p.returncode == 1, text_of(p)
    lines = p.stdout.splitlines()
    assert ("~/.local/bin/thimble is a link to a thimble folder that is gone. Remove it before you install 0.10."
            in lines), lines
    assert "  - ~/.local/bin/thimble, a link to ~/thimble/plugin/bin/thimble, in a thimble folder that is gone" in lines
    fix = lines.index("To remove it, run this:")
    assert lines[fix + 1:] == ["  rm -f ~/.local/bin/thimble", "",
                               "Remove it with the commands above, then run the install again. Nothing was installed."]
    assert "thimble 0.9" not in p.stdout


# ------------------------------------------------------------------ a branch, and the dev install


def test_ref_installs_a_branch_which_thimble_update_tells_from_a_newer_release(w):
    tip = w.publish(branch="try-r109")
    p = w.install("--no-browser", "--ref", "try-r109")
    assert p.returncode == 0, text_of(p)
    assert "Downloading thimble try-r109 into ~/.thimble... done." in p.stdout.splitlines()
    assert f"thimble try-r109 at {tip[:7]} is installed." in p.stdout.splitlines()
    assert w.release()["ref"] == "try-r109" and "tag" not in w.release()
    # the branch holds the newest release, 0.10.8: no newer release is out
    link = w.home / ".local" / "bin" / "thimble"
    got = subprocess.run([str(link), "update", "--check"], capture_output=True, text=True, env=w.env())
    assert got.stdout.strip() == (f"thimble try-r109 at {tip[:7]} is up to date; the newest release is 0.10.8."), \
        text_of(got)


def test_ref_moves_an_install_that_is_there_to_that_branch(w):
    assert w.install("--no-browser").returncode == 0
    tip = w.publish(branch="try-r109")
    p = w.install("--no-browser", "--ref", "try-r109")
    assert p.returncode == 0, text_of(p)
    lines = p.stdout.splitlines()
    assert ("thimble 0.10.8 is installed in ~/.thimble. It moves to try-r109 at "
            f"{tip[:7]} now, and keeps your fixes (a few minutes)...") in lines, lines
    assert f"Updated thimble 0.10.8 → try-r109 at {tip[:7]} (terminal plugin)" in lines
    assert lines[-1] == (f"thimble try-r109 at {tip[:7]} is installed in ~/.thimble. The plugin and the commands are "
                         "in place.")
    assert sh("git", "rev-parse", "mine", cwd=w.th / "fixes" / "live") == tip and w.release()["ref"] == "try-r109"


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


def made_fix(w, monkeypatch, words: str, on: bool = True) -> dict:
    """A fix made as thimble makes one, in the test's process with the person's environment: its copy cut from mine,
    the fixer's change written here, done with no tests, then on with a made-up key press (`on`); a fix left ready
    keeps its copy, a checkout in fixes/work."""
    from kernel import fixes as FX  # noqa: PLC0415

    for k, v in w.env().items():
        monkeypatch.setenv(k, v)
    rec = FX.new(words)
    (Path(rec["work"]) / "plugin" / f"made-up-{rec['id']}.txt").write_text(f"{words}\n")
    rec = FX.done(rec["id"], words, "", tests=False)
    assert rec["state"] == "ready", rec
    if on:
        secret = os.urandom(16).hex()
        FX.write_json(FX.home() / "asks" / f"{rec['id']}.json", {"key": FX.key_hash(secret)})
        FX.apply(rec["id"], secret)
    return FX.get(rec["id"])


def checkouts(repo: Path) -> list[str]:
    """The checkouts of `repo`'s repository, as git lists them (its own first), each one that git runs in."""
    out = sh("git", "worktree", "list", "--porcelain", cwd=repo)
    paths = [x[len("worktree "):] for x in out.splitlines() if x.startswith("worktree ")]
    for p in paths:
        sh("git", "status", "--short", cwd=Path(p))
    return [paths[0], *sorted(paths[1:])]


def aside_of(w, kind: str) -> list[Path]:
    return sorted(p for p in w.th.iterdir() if p.name.startswith(f"fixes-{kind}-"))


def test_local_sets_the_release_aside_with_its_fixes_and_the_install_brings_it_back(w, monkeypatch):
    """release, --local, release: the release install goes aside with its fixes (one on, one ready with its copy) into
    a dated folder whose checkouts work there, and comes back as it was; Claude Code and the command follow."""
    from kernel import fixes as FX  # noqa: PLC0415

    assert w.install("--no-browser").returncode == 0
    on, ready = made_fix(w, monkeypatch, "say read, not coverage"), made_fix(w, monkeypatch, "name the tab", on=False)
    fixes = w.th / "fixes"
    mine = sh("git", "rev-parse", "mine", cwd=fixes / "live")
    clone = w.home / "thimble"
    sh("git", "clone", "-q", str(w.bare), str(clone))
    p = w.install("--local", "--no-browser", script=clone / "scripts" / "install.sh")
    assert p.returncode == 0, text_of(p)
    [aside] = aside_of(w, "release")
    lines = p.stdout.splitlines()
    at = lines.index("Checking what thimble needs...") + 3
    assert lines[at:at + 3] == [f"The release installed in ~/.thimble is set aside, with its fixes, in ~/.thimble/"
                                f"{aside.name}. The install without --local brings it back.", "", "The plugin"], lines
    assert re.fullmatch(r"fixes-release-\d{8}-\d{6}", aside.name) and not fixes.exists()
    assert checkouts(aside / "live") == [str(aside / "live"), str(aside / "release"), str(aside / "work" / "2")]
    assert sh("git", "rev-parse", "mine", cwd=aside / "live") == mine
    assert w.settings()["extraKnownMarketplaces"]["thimble"]["source"] == {"source": "directory", "path": str(clone)}
    assert os.readlink(w.home / ".local" / "bin" / "thimble") == str(clone / "plugin" / "bin" / "thimble")
    assert "Claude Code loaded thimble from ~/.thimble/fixes/live. It now loads it from ~/thimble." in lines
    # the install without --local brings it back, and points Claude Code and the command at it again; the clone,
    # which holds an edit of the person's, is not called one to delete. The fixes folder that a lock of the dev
    # install made (thimble update takes one) goes, since it holds nothing else
    (clone / "README.md").write_text("a made-up edit\n")
    fixes.mkdir()
    (fixes / "fixes.lock").touch()
    p = w.install("--no-browser")
    assert p.returncode == 0, text_of(p)
    lines = p.stdout.splitlines()
    at = lines.index("Downloading thimble 0.10.8 for its install steps... done.")
    assert lines[at + 1:at + 4] == ["The release that scripts/install.sh --local set aside is back in ~/.thimble, with "
                                    "its fixes.", "thimble 0.10.8 is installed in ~/.thimble.", ""], lines
    assert not aside.exists() and sh("git", "rev-parse", "mine", cwd=fixes / "live") == mine
    assert checkouts(fixes / "live") == [str(fixes / "live"), str(fixes / "release"), str(fixes / "work" / "2")]
    assert (FX.get(on["id"])["state"], FX.get(ready["id"])["state"]) == ("on", "ready")
    assert (fixes / "live" / "plugin" / f"made-up-{on['id']}.txt").is_file()
    assert "  Added to Claude Code from ~/.thimble." in lines and w.calls()[-1] == "plugin update thimble@thimble"
    assert w.settings()["extraKnownMarketplaces"]["thimble"]["source"] == {"source": "directory",
                                                                           "path": str(fixes / "live")}
    assert os.readlink(w.home / ".local" / "bin" / "thimble") == str(fixes / "release" / "plugin" / "bin" / "thimble")
    assert "Claude Code loaded thimble from ~/thimble. It now loads it from ~/.thimble." in lines
    assert "no longer used" not in p.stdout and (clone / "README.md").read_text() == "a made-up edit\n"


def test_a_dev_install_s_fixes_go_aside_for_the_release_and_come_back_with_local(w, monkeypatch):
    """--local with a fix on (live, a worktree of the clone), then the release, then --local again: the dev install's
    fixes go aside with the clone's links to them, the clone is not called unused, and they come back."""
    from kernel import fixes as FX  # noqa: PLC0415

    clone = w.home / "thimble"
    sh("git", "clone", "-q", str(w.bare), str(clone))
    script = clone / "scripts" / "install.sh"
    assert w.install("--local", "--no-browser", script=script).returncode == 0
    fix = made_fix(w, monkeypatch, "say read, not coverage")
    fixes = w.th / "fixes"
    mine = sh("git", "rev-parse", "mine", cwd=clone)
    assert w.release()["kind"] == "clone" and checkouts(clone)[1:] == [str(fixes / "live"), str(fixes / "release")]
    p = w.install("--no-browser")
    assert p.returncode == 0, text_of(p)
    [aside] = aside_of(w, "dev")
    lines = p.stdout.splitlines()
    at = lines.index("Downloading thimble 0.10.8 into ~/.thimble... done.")
    assert lines[at + 1] == (f"The fixes of your dev install are set aside in ~/.thimble/{aside.name}. "
                             "scripts/install.sh --local in ~/thimble brings them back."), lines
    assert w.release()["kind"] == "github" and "~/thimble is no longer used" not in p.stdout
    assert checkouts(clone)[1:] == [str(aside / "live"), str(aside / "release")]
    # Claude Code copies the release, which took the place of the dev install's live
    assert "  Claude Code loads it from ~/.thimble." in lines and w.calls()[-1] == "plugin update thimble@thimble"
    # --local again: the release goes aside, and the dev install's fixes come back
    p = w.install("--local", "--no-browser", script=script)
    assert p.returncode == 0, text_of(p)
    [release] = aside_of(w, "release")
    lines = p.stdout.splitlines()
    at = lines.index("Checking what thimble needs...") + 3
    assert lines[at:at + 2] == [
        f"The release installed in ~/.thimble is set aside, with its fixes, in ~/.thimble/{release.name}. The "
        "install without --local brings it back.",
        "The fixes of this clone's dev install, set aside before, are back in ~/.thimble."], lines
    assert not aside.exists() and w.release()["kind"] == "clone" and FX.get(fix["id"])["state"] == "on"
    assert sh("git", "rev-parse", "mine", cwd=clone) == mine
    assert checkouts(clone)[1:] == [str(fixes / "live"), str(fixes / "release")]
    assert ("  Claude Code loads it from your fixes, in ~/.thimble/fixes/live: thimble update moves them to this "
            "clone's commit.") in lines and w.calls()[-1] == "plugin update thimble@thimble"


def test_a_dev_install_of_another_clone_goes_aside_and_comes_back_with_its_clone(w, monkeypatch):
    """--local in clone a with a fix on, then in clone b: a's dev install goes aside, as a dev install of a; --local in a
    again brings it back."""
    from kernel import fixes as FX  # noqa: PLC0415

    a, b = w.home / "a" / "thimble", w.home / "b" / "thimble"
    for clone in (a, b):
        sh("git", "clone", "-q", str(w.bare), str(clone))
    assert w.install("--local", "--no-browser", script=a / "scripts" / "install.sh").returncode == 0
    fix = made_fix(w, monkeypatch, "say read, not coverage")
    p = w.install("--local", "--no-browser", script=b / "scripts" / "install.sh")
    assert p.returncode == 0, text_of(p)
    [aside] = aside_of(w, "dev")
    assert (f"The dev install of ~/a/thimble is set aside, with its fixes, in ~/.thimble/{aside.name}. "
            "scripts/install.sh --local in ~/a/thimble brings it back.") in p.stdout.splitlines(), p.stdout
    assert not (w.th / "fixes").exists() and checkouts(a)[1:] == [str(aside / "live"), str(aside / "release")]
    assert w.settings()["extraKnownMarketplaces"]["thimble"]["source"] == {"source": "directory", "path": str(b)}
    p = w.install("--local", "--no-browser", script=a / "scripts" / "install.sh")
    assert p.returncode == 0, text_of(p)
    assert ("The fixes of this clone's dev install, set aside before, are back in ~/.thimble."
            in p.stdout.splitlines()), p.stdout
    assert not aside.exists() and FX.get(fix["id"])["state"] == "on" and w.release()["repo"] == str(a)
    assert w.settings()["extraKnownMarketplaces"]["thimble"]["source"] == {"source": "directory",
                                                                           "path": str(w.th / "fixes" / "live")}


def test_local_outside_a_clone_says_where_it_works(w):
    p = w.install("--local")
    assert p.returncode == 2 and "--local installs from a clone of thimble" in p.stderr, text_of(p)


# ------------------------------------------------------------------ the kernel's steps alone


def test_the_defaults_are_given_as_claude_code_takes_them():
    user_config = {"minimal": {"type": "boolean", "default": False},
                   "citations": {"type": "string", "default": "manual", "options": ["auto cite", "manual", "off"]},
                   "claimsMode": {"type": "string", "default": "on demand", "options": ["auto", "on demand", "off"]},
                   "defaultsAt": {"type": "string", "default": ""}, "noDefault": {"type": "string"}}
    assert IN.defaults({"userConfig": user_config}) == ["--config", "minimal=false", "--config", "citations=manual",
                                                        "--config", "claimsMode=on demand"]


def test_every_default_of_the_plugin_has_a_form_claude_code_takes():
    """Each default of the real manifest is a boolean or a string; a string default that is an option is one. None is
    empty: the installer cannot give an empty value, and Claude Code says a field it has no value for is not set."""
    manifest = json.loads((ROOT / "plugin" / ".claude-plugin" / "plugin.json").read_text())
    for key, field in manifest["userConfig"].items():
        d = field.get("default")
        assert isinstance(d, (bool, str)), key
        assert d != "", key
        if isinstance(d, str) and "options" in field:
            assert d in field["options"], key


def test_the_install_command_s_verbs_are_the_kernel_s():
    from kernel import cli  # noqa: PLC0415

    assert tuple(IN.VERBS) == cli.INSTALL_VERBS
    assert "thimble install" not in cli._help(), "only the script runs it"


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


def test_the_script_s_steps_read_top_to_bottom_with_no_python_program_in_it():
    """scripts/install.sh says each step in a comment, and keeps its logic in the kernel: no Python program in the
    shell beyond one line."""
    text = (ROOT / "scripts" / "install.sh").read_text()
    steps = re.findall(r"^\s*# (\d)\. (.+)$", text, re.M)
    assert [n for n, _ in steps] == ["1", "2", "3", "3", "4", "5", "6", "7", "8"], steps
    assert not re.search(r"-c '\n", text) and "<<'PY'" not in text and len(text.splitlines()) < 400
    for gone in ("fresh_path", "stamp_version", "--key-file", "--find-wif"):
        assert gone not in text, gone


# ------------------------------------------------------------------ the docs


def flat(doc: str) -> str:
    return " ".join((ROOT / doc).read_text().split())


def test_claude_s_notes_install_with_the_one_command_and_its_options():
    notes = flat("CLAUDE.md").split("## Installing thimble for a user", 1)[1].split(" ## ", 1)[0]
    assert ("curl -fsSL https://raw.githubusercontent.com/safety-research/thimble/main/scripts/install.sh | bash -s -- "
            "OPTIONS") in notes
    for option in ("`--sign-in claude-code`", "`--sign-in api-key`", "`--sign-in wif --wif-file PATH`",
                   "`--no-browser`", "`--ref`", "`scripts/install.sh --local`"):
        assert option in notes, option
    assert "Never ask for the key yourself." in notes
    for gone in ("--key-file", "--find-wif", "pbpaste", "thimble-<version>", "examples/sample"):
        assert gone not in notes, gone


def test_the_readme_and_install_md_give_the_same_command():
    command = "curl -fsSL https://raw.githubusercontent.com/safety-research/thimble/main/scripts/install.sh | bash"
    readme = flat("README.md").split("## Installation", 1)[1].split(" ## ", 1)[0]
    assert command in readme and "INSTALL.md" in readme
    # an installing Claude reads the README first: without this pointer it never read CLAUDE.md's steps
    assert "Agents installing thimble: follow [CLAUDE.md](CLAUDE.md)." in readme
    install = flat("INSTALL.md")
    assert command in install
    for section in ("## What you need", "## Install", "## Where things go", "## Update", "## Uninstall",
                    "## The dev install", "## When something does not work"):
        assert section in install, section
    for doc in ("README.md", "INSTALL.md", "browser/README.md", "CONTRIBUTING.md"):
        text = flat(doc)
        for gone in ("--key-file", "--find-wif", "thimble-<version>", "--no-setup", "--no-plugin"):
            assert gone not in text, (doc, gone)


def test_the_update_help_and_install_md_keep_the_width_of_the_text_around_them():
    cli = (ROOT / "plugin" / "engine" / "kernel" / "cli.py").read_text()
    helps = re.search(r'UPDATE_HELP = """(.*?)"""', cli, re.S)
    for text in (helps.group(1), (ROOT / "INSTALL.md").read_text()):
        assert [line for line in text.splitlines() if len(line) > 120] == []


def test_what_claude_reads_about_the_version_says_where_it_comes_from():
    """The manifest has no version, since a release names its version by its tag (CONTRIBUTING.md's row of the
    manifest); thimble --version names it from the release thimble's home holds."""
    assert "version" not in json.loads((ROOT / "plugin" / ".claude-plugin" / "plugin.json").read_text())
    row = flat("CONTRIBUTING.md").split("| the manifest:", 1)[1].split(" |", 1)[0]
    assert "by its tag" in row and "release.json" in row, row


def test_every_repository_path_the_install_docs_name_is_there():
    """A path in a code span of the install docs that names a file of the repository (plugin/, browser/, scripts/...)
    is there, so that Claude, which reads them first, never looks for one that is not."""
    files = subprocess.run(["git", "ls-files"], cwd=ROOT, capture_output=True, text=True, check=True).stdout.split()
    for doc in ("README.md", "CLAUDE.md", "INSTALL.md", "browser/README.md"):
        at = (ROOT / doc).parent
        for span in re.findall(r"`([^`\n]+)`", (ROOT / doc).read_text()):
            for word in span.split():
                p = word.strip("'\"(),.").split("#")[0]
                if re.fullmatch(r"(plugin|browser|scripts|backend|docs|examples)/[\w./-]+", p):
                    rel = os.path.relpath(at / p, ROOT)
                    assert any(f in (rel, p) or f.startswith(rel.rstrip("/") + "/") for f in files), (doc, p)
