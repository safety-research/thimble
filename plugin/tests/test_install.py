"""scripts/install.sh gives a fresh install each feature's default as --config KEY=VALUE, in the form
`claude plugin install` takes: a string bare, a boolean as true or false, and no empty value (Claude Code refuses one,
and one refused value drops them all)."""
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]


def defaults_snippet():
    """The python install.sh runs to print the defaults."""
    text = (ROOT / "scripts" / "install.sh").read_text()
    return re.search(r"config=\(\)\n.*?\"\$py\" -c '\n(.*?)\n'\)", text, re.S).group(1)


def test_the_defaults_are_given_as_claude_code_takes_them(tmp_path):
    market = tmp_path / "market"
    (market / ".claude-plugin").mkdir(parents=True)
    (market / ".claude-plugin" / "marketplace.json").write_text(json.dumps({"plugins": [{"name": "thimble", "source": "./plugin"}]}))
    (market / "plugin" / ".claude-plugin").mkdir(parents=True)
    user_config = {
        "minimal": {"type": "boolean", "default": False},
        "citations": {"type": "string", "default": "manual", "options": ["auto cite", "manual", "off"]},
        "claimsMode": {"type": "string", "default": "on demand", "options": ["auto", "on demand", "off"]},
        "defaultsAt": {"type": "string", "default": ""},
        "noDefault": {"type": "string"},
    }
    (market / "plugin" / ".claude-plugin" / "plugin.json").write_text(json.dumps({"userConfig": user_config}))
    cc = tmp_path / "cc"
    (cc / "plugins").mkdir(parents=True)
    (cc / "plugins" / "known_marketplaces.json").write_text(json.dumps({"thimble": {"installLocation": str(market)}}))
    p = subprocess.run([sys.executable, "-c", defaults_snippet()], capture_output=True, text=True,
                       env={"CLAUDE_CONFIG_DIR": str(cc), "PATH": "/usr/bin:/bin"})
    assert p.returncode == 0, p.stderr
    assert p.stdout.splitlines() == ["minimal=false", "citations=manual", "claimsMode=on demand"]


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


def stub(path, text):
    """An executable shell script at path."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("#!/bin/sh\n" + text)
    path.chmod(0o755)
    return path


def same_login(tmp_path: Path, path: str) -> str:
    """A made-up login shell for an install run (SHELL), whose `-lic env` gives `path`, the run's own PATH: so the install's
    card test runs on the run's made-up node wherever the tests run, never on a node the machine's own login shell finds
    (bash sets SHELL to the user's login shell when it is unset)."""
    return str(stub(tmp_path / "same-login", f'echo "PATH={path}"\n'))


def needs(tmp_path, claude, stubs=()):
    """scripts/install.sh --no-browser with only stubs on PATH, where claude is a link to the made-up Claude Code 2.1.283
    at `claude`: it says what is missing and stops before it installs anything. `stubs`: other commands, by name."""
    bin_ = tmp_path / "stubs"
    stub(bin_ / "node", "echo v22.20.0\n")
    stub(claude, 'echo "2.1.283 (Claude Code)"\n')
    (bin_ / "claude").symlink_to(claude)
    for name, text in stubs:
        stub(bin_ / name, text)
    home = tmp_path / "home"
    home.mkdir(exist_ok=True)
    env = {"PATH": f"{bin_}:/usr/bin:/bin", "HOME": str(home), "THIMBLE_PYTHON": sys.executable,
           "SHELL": same_login(tmp_path, f"{bin_}:/usr/bin:/bin")}
    p = subprocess.run([str(ROOT / "scripts" / "install.sh"), "--no-browser"], capture_output=True, text=True, env=env)
    assert p.returncode == 1, p.stdout + p.stderr
    return next(line for line in p.stdout.splitlines() if "Claude Code is 2.1.283" in line)


def test_an_old_claude_code_is_updated_by_what_installed_it(tmp_path):
    """Claude Code below the plugin's minimum: the fix is the update that reaches it, by where its claude lives. A build
    from Homebrew, npm or the system's packages does not update itself (its claude update says updates are disabled, or
    to use the package manager)."""
    line = needs(tmp_path / "brew", tmp_path / "brew" / "opt" / "homebrew" / "Caskroom" / "claude-code" / "2.1.283" / "claude")
    assert line.endswith("2.1.307 or later: brew upgrade claude-code")
    line = needs(tmp_path / "npm", tmp_path / "npm" / "lib" / "node_modules" / "@anthropic-ai" / "claude-code" / "cli.js")
    assert line.endswith("2.1.307 or later: npm install -g @anthropic-ai/claude-code@latest")
    # a file the system's package manager owns (here a made-up dpkg owns every file), even in npm's layout
    line = needs(tmp_path / "deb", tmp_path / "deb" / "usr" / "lib" / "node_modules" / "@anthropic-ai" / "claude-code" / "cli.js",
                 [("dpkg", 'exit 0\n')])
    assert "or later: update it with the package manager that installed" in line
    # Claude Code's own install updates itself
    line = needs(tmp_path / "own", tmp_path / "own" / "home" / ".local" / "share" / "claude" / "versions" / "2.1.283")
    assert "or later: claude update" in line


def test_what_does_not_work_yet_is_what_the_install_says_last(tmp_path):
    """A whole install, with made-up commands, whose card sandbox does not work yet: its line, and the why and fix in
    it, come again at the end, after the browser workbench's start lines, so what is left to do is said last. The fix
    ends in a command, and no words follow it, so that it can be copied and run as it is."""
    market = tmp_path / "market"
    (market / ".claude-plugin").mkdir(parents=True)
    (market / ".claude-plugin" / "marketplace.json").write_text(json.dumps({"plugins": [{"name": "thimble", "source": "./plugin"}]}))
    (market / "plugin" / ".claude-plugin").mkdir(parents=True)
    (market / "plugin" / ".claude-plugin" / "plugin.json").write_text(json.dumps({"userConfig": {}}))
    stub(market / "plugin" / "sandbox" / "setup.mjs", "")
    stub(market / "plugin" / "bin" / "thimble", "")
    cc = tmp_path / "cc"
    (cc / "plugins").mkdir(parents=True)
    (cc / "plugins" / "known_marketplaces.json").write_text(json.dumps({"thimble": {"installLocation": str(market)}}))
    bin_ = tmp_path / "stubs"
    # node's version, and setup.mjs --probe, which says why the sandbox does not work and its fix
    stub(bin_ / "node", 'case "$1" in --version) echo v22.20.0 ;;\n'
         '*) echo "thimble: cards cannot run yet: the made-up runner did not start."\n'
         '   echo "  Install them: sudo made-up-get install bubblewrap socat"; exit 1 ;; esac\n')
    stub(bin_ / "claude", 'case "$1" in --version) echo "2.1.311 (Claude Code)" ;; plugin) [ "$2" = list ] && echo "[]" ;; esac\nexit 0\n')
    stub(bin_ / "uv", '[ "$1" = --version ] && echo "uv 0.9.0"\nexit 0\n')
    stub(bin_ / "npm", "exit 0\n")
    stub(bin_ / "bwrap", "exit 0\n")
    home = tmp_path / "home"
    home.mkdir()
    env = {"PATH": f"{bin_}:/usr/bin:/bin", "HOME": str(home), "THIMBLE_PYTHON": sys.executable, "CLAUDE_CONFIG_DIR": str(cc),
           "THIMBLE_HOME": str(tmp_path / "thimble"), "THIMBLE_BROWSER_HOME": str(tmp_path / "browser-home"),
           "SHELL": same_login(tmp_path, f"{bin_}:/usr/bin:/bin")}
    p = subprocess.run([str(ROOT / "scripts" / "install.sh"), "--no-setup", "--bin-dir", str(tmp_path / "bin")],
                       capture_output=True, text=True, env=env, stdin=subprocess.DEVNULL)
    assert p.returncode == 0, p.stdout + p.stderr
    lines = [line for line in p.stdout.splitlines() if line.strip()]
    start = lines.index("To start the browser workbench, run this in a folder of files:")
    notes = lines[start:]
    while notes and not notes[0].startswith("Note: "):
        notes.pop(0)
    # from the first note on, every line is a note, or the fix of one, indented under it
    assert notes and all(line.startswith(("Note: ", "  ")) for line in notes), lines
    # one of them is the sandbox's: its why, then its fix, whose command comes last
    said = [n.strip() for n in "\n".join(notes).split("Note: ") if n.strip()]
    sandbox = next((n for n in said if "the made-up runner did not start." in n), "")
    assert sandbox.endswith("Install them: sudo made-up-get install bubblewrap socat"), said


def install_with_login_shell(tmp_path, login_path, shell=None):
    """scripts/install.sh --no-browser with made-up commands, run from a shell whose node fails the card test (it says
    the made-up sandbox does not work), for a person whose login shell (SHELL, a made-up one) starts with the PATH
    `login_path`, where a made-up node passes it; `shell`: what the login shell does instead, after it notes its
    arguments. Its output, and the arguments the login shell was started with."""
    market = tmp_path / "market"
    (market / ".claude-plugin").mkdir(parents=True)
    (market / ".claude-plugin" / "marketplace.json").write_text(json.dumps({"plugins": [{"name": "thimble", "source": "./plugin"}]}))
    (market / "plugin" / ".claude-plugin").mkdir(parents=True)
    (market / "plugin" / ".claude-plugin" / "plugin.json").write_text(json.dumps({"userConfig": {}}))
    stub(market / "plugin" / "sandbox" / "setup.mjs", "")
    stub(market / "plugin" / "bin" / "thimble", "")
    cc = tmp_path / "cc"
    (cc / "plugins").mkdir(parents=True)
    (cc / "plugins" / "known_marketplaces.json").write_text(json.dumps({"thimble": {"installLocation": str(market)}}))
    bin_ = tmp_path / "stubs"
    stub(bin_ / "node", 'case "$1" in --version) echo v22.20.0 ;;\n'
         '*) echo "thimble: cards cannot run yet: the made-up node of this shell."; exit 1 ;; esac\n')
    stub(bin_ / "claude", 'case "$1" in --version) echo "2.1.311 (Claude Code)" ;; plugin) [ "$2" = list ] && echo "[]" ;; esac\nexit 0\n')
    stub(tmp_path / "new-terminal" / "node", 'echo "thimble: cards run in the made-up sandbox; the runner drew a test card in 5 ms ($*)."\n')
    started = tmp_path / "login.log"
    login = stub(tmp_path / "login-shell", f'echo "$@" > "{started}"\n'
                 + (shell if shell is not None else f'echo "made-up: welcome"\necho "PATH={login_path}"\n'))
    home = tmp_path / "home"
    home.mkdir()
    env = {"PATH": f"{bin_}:/usr/bin:/bin", "HOME": str(home), "THIMBLE_PYTHON": sys.executable, "CLAUDE_CONFIG_DIR": str(cc),
           "THIMBLE_HOME": str(tmp_path / "thimble"), "SHELL": str(login)}
    p = subprocess.run([str(ROOT / "scripts" / "install.sh"), "--no-browser", "--bin-dir", str(tmp_path / "bin")],
                       capture_output=True, text=True, env=env, stdin=subprocess.DEVNULL)
    assert p.returncode == 0, p.stdout + p.stderr
    return p.stdout, started.read_text().split()


def test_the_card_test_runs_on_the_node_a_new_terminal_finds(tmp_path):
    """The install draws a test card as a session does: on the node a new terminal finds, from the PATH the person's
    login shell starts with (a login shell, interactive, as a terminal starts it), and with --repair, which installs
    the sandbox again when that repairs it. This shell's own node is not the one a session runs on."""
    out, started = install_with_login_shell(tmp_path, f"{tmp_path / 'new-terminal'}:/usr/bin:/bin")
    assert started == ["-lic", "env"]
    market = tmp_path / "market" / "plugin" / "sandbox" / "setup.mjs"
    assert f"thimble: cards run in the made-up sandbox; the runner drew a test card in 5 ms ({market} --probe --repair)." in out.splitlines()
    assert "cards cannot run yet" not in out


def test_a_new_terminal_that_finds_no_node_is_said(tmp_path):
    """A new terminal that finds no node cannot start the card runner: a note says so, with the line that puts this
    shell's node on its PATH, and the card test runs on this shell's node."""
    out, _ = install_with_login_shell(tmp_path, str(tmp_path / "nothing"))
    notes = [x for x in out.splitlines() if x.startswith("Note: a new terminal finds no node")]
    assert notes == [f"Note: a new terminal finds no node, and the plugin's cards run on the node a new terminal finds. Add this line to your shell's startup file (~/.zshrc or ~/.bashrc): export PATH=\"{tmp_path / 'stubs'}:$PATH\""]
    assert "the made-up node of this shell" in out


def test_a_login_shell_that_cannot_start_as_a_terminal_starts_it_is_said(tmp_path):
    """A login shell that refuses -lic (tcsh takes -l only as its one flag) gives no PATH: the card test runs on this
    shell's node, and one line, before the test's own, names that node and says the login shell could not be started."""
    out, started = install_with_login_shell(tmp_path, "", shell="echo \"Unknown option: \\`-l'\" >&2\nexit 1\n")
    assert started == ["-lic", "env"]
    lines = out.splitlines()
    said = [x for x in lines if str(tmp_path / "login-shell") in x]
    assert said == [f"Your login shell ({tmp_path / 'login-shell'}) could not be started as a new terminal starts it, so "
                    f"the test card runs on this shell's node: {tmp_path / 'stubs' / 'node'}"], out
    assert lines.index(said[0]) + 1 == lines.index("thimble: cards cannot run yet: the made-up node of this shell."), out


# a terminal (a pty) whose shell runs a command as a person's shell does: in a process group of its own, which it puts
# in the terminal's foreground; then it says how the command ended, or that it stopped. It answers the command's
# question ("[Y/n]: ") with n, and prints what the terminal showed
TERMINAL = r'''
import os, pty, select, signal, sys, time
pid, fd = pty.fork()
if pid == 0:
    signal.signal(signal.SIGTTOU, signal.SIG_IGN)
    job = os.fork()
    if job == 0:
        os.setpgid(0, 0)
        os.tcsetpgrp(0, os.getpid())
        signal.signal(signal.SIGTTOU, signal.SIG_DFL)
        os.execv("/bin/bash", ["bash", sys.argv[1]])
    try:
        os.setpgid(job, job)
    except OSError:
        pass
    _, status = os.waitpid(job, os.WUNTRACED)
    if os.WIFSTOPPED(status):
        print("stopped by " + signal.Signals(os.WSTOPSIG(status)).name, flush=True)
        os.kill(job, signal.SIGKILL)
        os.waitpid(job, 0)
    else:
        print("exit %d" % os.waitstatus_to_exitcode(status), flush=True)
    os._exit(0)
shown, answered, end = b"", False, time.time() + 90
while time.time() < end:
    if not select.select([fd], [], [], 1)[0]:
        continue
    try:
        got = os.read(fd, 4096)
    except OSError:
        break
    if not got:
        break
    shown += got
    if not answered and b"[Y/n]: " in shown:
        os.write(fd, b"n\n")
        answered = True
if time.time() >= end:
    os.kill(pid, signal.SIGKILL)
os.waitpid(pid, 0)
sys.stdout.write(shown.decode(errors="replace"))
'''


def fresh_path_in_a_terminal(tmp_path, shell, startup):
    """install.sh's fresh_path, in a terminal, as the install runs it there, for a person whose login shell is `shell`
    with the startup files `startup` (name: text) in their home; then a question the install reads from the terminal
    after it, as Keep it? [Y/n]. What the terminal showed: how long fresh_path took and what it said, the answer read,
    and how the install ended."""
    home = tmp_path / "home"
    home.mkdir()
    for name, text in startup.items():
        (home / name).write_text(text)
    fresh_path = re.search(r"^fresh_path\(\) \{\n.*?^\}\n", (ROOT / "scripts" / "install.sh").read_text(), re.S | re.M).group(0)
    script = tmp_path / "install-part.sh"
    script.write_text(f"set -euo pipefail\npy='{sys.executable}'\n{fresh_path}"
                      'start=$SECONDS\nfound="$(fresh_path)"\necho "fresh_path: $((SECONDS - start)) s [$found]"\n'
                      'printf "Keep it? [Y/n]: "\nread -r keep || keep="nothing"\necho "read: [$keep]"\n')
    terminal = tmp_path / "terminal.py"
    terminal.write_text(TERMINAL)
    env = {"HOME": str(home), "USER": "analyst", "LOGNAME": "analyst", "SHELL": shell, "PATH": "/usr/bin:/bin",
           "TERM": "xterm-256color", "LANG": "C.UTF-8"}
    return subprocess.run([sys.executable, str(terminal), str(script)], capture_output=True, text=True, env=env,
                          timeout=150).stdout


@pytest.mark.parametrize("shell", ["bash", "zsh"])
def test_a_new_terminals_path_is_read_and_the_install_still_reads_its_terminal(tmp_path, shell):
    """The login shell that says a new terminal's PATH runs interactive, as a terminal starts it, and an interactive
    shell takes the terminal it finds as its own: the install's next question would then stop it (suspended, tty
    input). It runs without the terminal, and the install reads the answer typed after it."""
    at = shutil.which(shell)
    if not at:
        pytest.skip(f"no {shell} on this machine")
    startup = ({".bash_profile": ". ~/.bashrc\n", ".bashrc": "export PATH=/made-up/fast:$PATH\n"} if shell == "bash"
               else {".zshrc": "export PATH=/made-up/fast:$PATH\n"})
    shown = fresh_path_in_a_terminal(tmp_path, at, startup)
    assert re.search(r"fresh_path: \d+ s \[/made-up/fast:", shown), shown
    assert "read: [n]" in shown and "exit 0" in shown, shown


def test_a_startup_file_that_takes_30_s_is_cut_at_20_s(tmp_path):
    """A login shell whose startup file takes 30 s gives no PATH: it is stopped at 20 s, with what it started (an
    interactive shell ignores SIGTERM), and the install goes on and reads its terminal."""
    shown = fresh_path_in_a_terminal(tmp_path, shutil.which("bash") or "/bin/bash",
                                     {".bash_profile": ". ~/.bashrc\n", ".bashrc": "sleep 30\nexport PATH=/made-up/slow:$PATH\n"})
    took = re.search(r"fresh_path: (\d+) s \[(.*)\]", shown)
    assert took and 18 <= int(took.group(1)) <= 26 and took.group(2) == "", shown
    assert "read: [n]" in shown and "exit 0" in shown, shown


def test_a_home_whose_fixes_claude_code_loads_is_left_to_thimble_update_and_the_rest_installs(tmp_path):
    """Once a fix went on, Claude Code's marketplace thimble is the fixes' live folder, which its settings keep, and it
    refuses another source for the name. The install leaves the plugin to thimble update, says so in one line, and
    installs the browser workbench."""
    live = tmp_path / "thimble" / "fixes" / "live"
    (live / "plugin" / "bin").mkdir(parents=True)
    (live / ".git").mkdir()  # a checkout, with the home's release.json beside it
    (live.parent / "release.json").write_text("{}\n")
    entry = {"source": "directory", "path": str(live)}
    cc = tmp_path / "cc"
    (cc / "plugins").mkdir(parents=True)
    (cc / "plugins" / "known_marketplaces.json").write_text(json.dumps({"thimble": {"source": entry, "installLocation": str(live)}}))
    (cc / "settings.json").write_text(json.dumps({"extraKnownMarketplaces": {"thimble": {"source": entry}}}))
    bin_ = tmp_path / "stubs"
    log = tmp_path / "claude.log"
    stub(bin_ / "claude", f'echo "$@" >> "{log}"\n'
         'case "$1 $2" in "--version ") echo "2.1.311 (Claude Code)" ;;\n'
         '"plugin marketplace") echo "Cannot add marketplace: its source does not match its settings" >&2; exit 1 ;; esac\n'
         'exit 0\n')
    stub(bin_ / "node", "echo v22.20.0\n")
    stub(bin_ / "uv", '[ "$1" = --version ] && echo "uv 0.9.0"\nexit 0\n')
    stub(bin_ / "npm", "exit 0\n")
    stub(bin_ / "bwrap", "exit 0\n")
    home = tmp_path / "home"
    home.mkdir()
    env = {"PATH": f"{bin_}:/usr/bin:/bin", "HOME": str(home), "THIMBLE_PYTHON": sys.executable, "CLAUDE_CONFIG_DIR": str(cc),
           "THIMBLE_HOME": str(tmp_path / "thimble"), "THIMBLE_BROWSER_HOME": str(tmp_path / "browser-home"),
           "SHELL": same_login(tmp_path, f"{bin_}:/usr/bin:/bin")}
    p = subprocess.run([str(ROOT / "scripts" / "install.sh"), "--no-setup", "--bin-dir", str(tmp_path / "bin")],
                       capture_output=True, text=True, env=env, stdin=subprocess.DEVNULL)
    assert p.returncode == 0, p.stdout + p.stderr
    lines = p.stdout.splitlines()
    assert [x for x in lines if "thimble update" in x] == [
        f"Claude Code loads thimble from your fixes ({live.resolve()}), so the plugin is left as it is: run thimble "
        "update, which updates both products and keeps your fixes."]
    assert [x for x in log.read_text().splitlines() if x.startswith("plugin")] == []
    assert "To start the browser workbench, run this in a folder of files:" in lines
    assert (tmp_path / "bin" / "thimble-browser").exists() and not (tmp_path / "bin" / "thimble").exists()


# The made-up claude's `plugin marketplace add SOURCE` and `plugin marketplace remove NAME`, as Claude Code 2.1.307 does
# them. It keeps a marketplace in its list (plugins/known_marketplaces.json) and in its user settings
# (extraKnownMarketplaces in settings.json). remove says that the name is not found when the list does not have it, and
# changes nothing; else it removes the name from both. add refuses a source other than the one the settings give for
# thimble (Claude Code 2.1.307 refuses GitHub's so); else it puts thimble in both.
MARKETPLACE = r'''
import json, os, sys
cc = os.environ["CLAUDE_CONFIG_DIR"]
files = {"known": os.path.join(cc, "plugins", "known_marketplaces.json"), "settings": os.path.join(cc, "settings.json")}
data = {}
for k, at in files.items():
    try:
        data[k] = json.load(open(at, encoding="utf-8"))
    except OSError:
        data[k] = {}
known, declared = data["known"], data["settings"].setdefault("extraKnownMarketplaces", {})
verb, arg = (sys.argv[1:] + ["", ""])[:2]
if verb == "remove":
    if arg not in known:
        sys.exit(f"Failed to remove marketplace: Marketplace '{arg}' not found")
    del known[arg]
    declared.pop(arg, None)
elif verb == "add":
    source = ({"source": "directory", "path": os.path.realpath(arg)} if os.path.isdir(arg)
              else {"source": "github", "repo": arg})
    if declared.get("thimble", {}).get("source", source) != source:
        sys.exit('Failed to add marketplace: Cannot add marketplace "thimble": its source doesn\'t match its '
                 "extraKnownMarketplaces entry in user or managed settings; add it from the source that entry lists, "
                 "or change the entry.")
    known["thimble"] = {"source": source, "installLocation": os.path.join(cc, "plugins", "marketplaces", "thimble")}
    declared["thimble"] = {"source": source}
else:
    sys.exit(0)
for k, at in files.items():
    with open(at, "w", encoding="utf-8") as f:
        json.dump(data[k], f, indent=2, ensure_ascii=False)
        f.write("\n")
'''


def plugin_install(tmp_path, source, claude="", listed=True, settings=None):
    """scripts/install.sh --no-browser with made-up commands, when Claude Code's marketplace thimble (in its list unless
    `listed` is false, and in its user settings, a file of mode 640 with the other `settings`) is the folder `source`,
    and this shell's THIMBLE_HOME is tmp_path/thimble. The made-up claude logs each call, says its version, lists no
    plugin, runs `claude`, then adds and removes a marketplace as Claude Code does (MARKETPLACE), and else succeeds;
    with `claude` None, there is no claude command. The run, and the plugin calls."""
    entry = {"source": "directory", "path": str(source)}
    cc = tmp_path / "cc"
    (cc / "plugins").mkdir(parents=True)
    known = {"thimble": {"source": entry, "installLocation": str(source)}} if listed else {}
    (cc / "plugins" / "known_marketplaces.json").write_text(json.dumps(known))
    others = settings or {}
    declared = {**others.get("extraKnownMarketplaces", {}), "thimble": {"source": entry}}
    (cc / "settings.json").write_text(json.dumps({**others, "extraKnownMarketplaces": declared}, indent=2,
                                                 ensure_ascii=False) + "\n", encoding="utf-8")
    (cc / "settings.json").chmod(0o640)
    bin_ = tmp_path / "stubs"
    log = tmp_path / "claude.log"
    if claude is not None:
        model = tmp_path / "marketplace.py"
        model.write_text(MARKETPLACE)
        stub(bin_ / "claude", f'echo "$@" >> "{log}"\n'
             'case "$1 $2" in "--version ") echo "2.1.311 (Claude Code)"; exit 0 ;; "plugin list") echo "[]"; exit 0 ;; esac\n'
             + claude
             + f'[ "$1 $2" = "plugin marketplace" ] && exec "{sys.executable}" "{model}" "$3" "$4"\nexit 0\n')
    stub(bin_ / "node", "echo v22.20.0\n")
    home = tmp_path / "home"
    home.mkdir()
    env = {"PATH": f"{bin_}:/usr/bin:/bin", "HOME": str(home), "THIMBLE_PYTHON": sys.executable, "CLAUDE_CONFIG_DIR": str(cc),
           "THIMBLE_HOME": str(tmp_path / "thimble"),
           "SHELL": same_login(tmp_path, f"{bin_}:/usr/bin:/bin")}
    p = subprocess.run([str(ROOT / "scripts" / "install.sh"), "--no-browser", "--bin-dir", str(tmp_path / "bin")],
                       capture_output=True, text=True, env=env, stdin=subprocess.DEVNULL)
    return p, [x for x in log.read_text().splitlines() if x.startswith("plugin")] if log.exists() else []


def test_after_the_documented_uninstall_a_marketplace_on_the_deleted_fixes_goes_and_the_plugin_installs(tmp_path):
    """claude plugin uninstall thimble@thimble, then rm -rf ~/.thimble: Claude Code's marketplace thimble still names
    the fixes' live folder, which is gone, and Claude Code refuses another source for the name while it does. The
    install removes that marketplace and installs the plugin as usual."""
    p, calls = plugin_install(tmp_path, tmp_path / "thimble" / "fixes" / "live")
    assert p.returncode == 0, p.stdout + p.stderr
    assert calls == ["plugin marketplace remove thimble", "plugin marketplace add safety-research/thimble",
                     "plugin list --json", "plugin install thimble@thimble"]
    assert "loads thimble from your fixes" not in p.stdout


def test_a_home_with_fixes_whose_thimble_home_is_not_the_shells_is_left_to_thimble_update(tmp_path):
    """Claude Code runs with another THIMBLE_HOME than this shell: its marketplace is that home's live folder (a
    checkout with release.json beside it), and the install leaves the plugin to thimble update all the same."""
    live = tmp_path / "other-home" / "fixes" / "live"
    (live / ".git").mkdir(parents=True)
    (live.parent / "release.json").write_text("{}\n")
    p, calls = plugin_install(tmp_path, live, '[ "$1 $2" = "plugin marketplace" ] && exit 1\nexit 0\n')
    assert p.returncode == 0, p.stdout + p.stderr
    assert calls == []
    assert (f"Claude Code loads thimble from your fixes ({live.resolve()}), so the plugin is left as it is: run thimble "
            "update, which updates both products and keeps your fixes.") in p.stdout.splitlines()


def test_without_claude_the_commands_it_prints_first_remove_a_marketplace_on_the_deleted_fixes(tmp_path):
    """No claude command, and Claude Code's marketplace thimble still names the fixes' live folder, which is gone: the
    commands to run once Claude Code is installed remove that marketplace before they add thimble's."""
    if any((Path(d) / "claude").exists() for d in ("/usr/bin", "/bin")):
        pytest.skip("this machine has a claude in /usr/bin or /bin, which the install finds")
    p, _ = plugin_install(tmp_path, tmp_path / "thimble" / "fixes" / "live", None)
    assert p.returncode == 0, p.stdout + p.stderr
    lines = p.stdout.splitlines()
    at = lines.index("Claude Code (the claude command) is not installed. Install it, then run:")
    assert lines[at + 1:at + 4] == ["  claude plugin marketplace remove thimble",
                                    "  claude plugin marketplace add safety-research/thimble",
                                    "  claude plugin install thimble@thimble"]


def test_a_marketplace_on_the_deleted_fixes_that_only_the_settings_name_goes_from_them_and_the_plugin_installs(tmp_path):
    """Claude Code's list has no marketplace thimble, and only its user settings name the fixes' live folder, which is
    gone: claude plugin marketplace remove thimble fails with "Marketplace 'thimble' not found", and Claude Code refuses
    GitHub's source for thimble while its settings name that folder. The install removes thimble from the settings, and
    only it: the other settings and the file's mode stay. It shows no failure, and installs the plugin as usual."""
    others = {"env": {"MADE_UP_NAME": "été"},
              "extraKnownMarketplaces": {"made-up": {"source": {"source": "directory", "path": "/made/up/market"}}}}
    p, calls = plugin_install(tmp_path, tmp_path / "thimble" / "fixes" / "live", listed=False, settings=others)
    assert p.returncode == 0, p.stdout + p.stderr
    assert calls == ["plugin marketplace remove thimble", "plugin marketplace add safety-research/thimble",
                     "plugin list --json", "plugin install thimble@thimble"]
    assert "not found" not in p.stdout + p.stderr
    settings = tmp_path / "cc" / "settings.json"
    # thimble's entry is now the one the add wrote (GitHub's), and the rest is as it was
    assert json.loads(settings.read_text(encoding="utf-8")) == {
        "env": {"MADE_UP_NAME": "été"},
        "extraKnownMarketplaces": {"made-up": {"source": {"source": "directory", "path": "/made/up/market"}},
                                   "thimble": {"source": {"source": "github", "repo": "safety-research/thimble"}}}}
    assert settings.stat().st_mode & 0o777 == 0o640


def test_a_failure_of_the_remove_other_than_not_found_stops_the_install(tmp_path):
    """Only Claude Code's settings name the fixes' live folder, which is gone, and claude plugin marketplace remove
    thimble fails for a reason other than "not found": the install stops with what Claude Code said, and changes
    nothing in the settings."""
    live = tmp_path / "thimble" / "fixes" / "live"
    p, calls = plugin_install(tmp_path, live, '[ "$1 $2 $3" = "plugin marketplace remove" ] && '
                              '{ echo "made-up failure" >&2; exit 1; }\n', listed=False)
    assert p.returncode == 1 and "made-up failure" in p.stderr and calls == ["plugin marketplace remove thimble"]
    settings = json.loads((tmp_path / "cc" / "settings.json").read_text())
    assert settings == {"extraKnownMarketplaces": {"thimble": {"source": {"source": "directory", "path": str(live)}}}}


def test_install_md_updates_with_thimble_update():
    """INSTALL.md's update is the shell's thimble update, which updates both products and keeps the fixes; no line says
    that 0.10 has no thimble command, or that another command replaces thimble update."""
    text = (ROOT / "INSTALL.md").read_text()
    update = " ".join(text.split("## Update and uninstall", 1)[1].split("\n## ", 1)[0].split())
    assert "run `thimble update` in a shell" in update and "keeps your fixes" in update
    flat = " ".join(text.split())
    assert "has no `thimble`" not in flat and "replaces `thimble update`" not in flat


def test_install_md_says_when_each_way_updates_the_plugin():
    """INSTALL.md says what the code does: scripts/install.sh and claude plugin update reach the plugin until Claude Code
    loads it from the fixes, and thimble update after; --local is an option of scripts/install.sh, not of thimble
    update; the first fix asked for, or thimble update, sets a leftover mine aside only when the code does."""
    text = " ".join((ROOT / "INSTALL.md").read_text().split())
    install = text.split("## Install", 1)[1].split(" ## ", 1)[0]
    assert ("From the first fix you use, or the first update by `thimble update`, Claude Code loads the plugin from your "
            "fixes, and the script leaves the plugin to `thimble update`.") in install
    update = text.split("## Update and uninstall", 1)[1].split(" ## ", 1)[0]
    assert "after an install with `scripts/install.sh --local`, it moves them to the commit your checkout has" in update
    assert "`claude plugin update thimble@thimble` until you use its first fix" in update
    assert ("the first fix you ask for, or a `thimble update` that moves to a new commit of your checkout, sets them aside"
            in update and "it tracks no upstream" in update)


def test_install_md_says_how_a_plugin_without_a_clone_updates_after_its_first_fix():
    """Without a clone, no thimble command is in the shell; after the first fix, claude plugin update leaves the plugin
    as it is, and thimble update refuses inside Claude Code. INSTALL.md's update gives what works: live's launcher, run
    by its path in a shell, which passes update to the release checkout when there is one."""
    text = " ".join((ROOT / "INSTALL.md").read_text().split())
    update = text.split("## Update and uninstall", 1)[1].split(" ## ", 1)[0]
    assert ("Without a clone, your shell does not find `thimble`: run "
            "`~/.thimble/fixes/live/plugin/bin/thimble update` (if you set `THIMBLE_HOME`, use it in place of "
            "`~/.thimble`).") in update
    assert (ROOT / "plugin" / "bin" / "thimble").is_file()


def whole_install(tmp_path, *args):
    """scripts/install.sh with made-up commands, both products, no terminal and no question how the workbench reaches
    Claude (--no-setup, as Claude runs it): the run. The made-up claude installs a plugin with no sandbox to check."""
    market = tmp_path / "market"
    (market / ".claude-plugin").mkdir(parents=True)
    (market / ".claude-plugin" / "marketplace.json").write_text(json.dumps({"plugins": [{"name": "thimble", "source": "./plugin"}]}))
    (market / "plugin" / ".claude-plugin").mkdir(parents=True)
    (market / "plugin" / ".claude-plugin" / "plugin.json").write_text(json.dumps({"userConfig": {}}))
    cc = tmp_path / "cc"
    (cc / "plugins").mkdir(parents=True)
    (cc / "plugins" / "known_marketplaces.json").write_text(json.dumps({"thimble": {"installLocation": str(market)}}))
    bin_ = tmp_path / "stubs"
    stub(bin_ / "node", "echo v22.20.0\n")
    stub(bin_ / "claude", 'case "$1" in --version) echo "2.1.311 (Claude Code)" ;; plugin) [ "$2" = list ] && echo "[]" ;; esac\nexit 0\n')
    stub(bin_ / "uv", '[ "$1" = --version ] && echo "uv 0.9.0"\nexit 0\n')
    stub(bin_ / "npm", "exit 0\n")
    stub(bin_ / "bwrap", "exit 0\n")
    home = tmp_path / "home"
    home.mkdir()
    env = {"PATH": f"{bin_}:/usr/bin:/bin", "HOME": str(home), "THIMBLE_PYTHON": sys.executable, "CLAUDE_CONFIG_DIR": str(cc),
           "THIMBLE_HOME": str(tmp_path / "thimble"), "THIMBLE_BROWSER_HOME": str(tmp_path / "browser-home"),
           "SHELL": same_login(tmp_path, f"{bin_}:/usr/bin:/bin")}
    p = subprocess.run([str(ROOT / "scripts" / "install.sh"), "--no-setup", "--bin-dir", str(tmp_path / "bin"), *args],
                       capture_output=True, text=True, env=env, stdin=subprocess.DEVNULL)
    assert p.returncode == 0, p.stdout + p.stderr
    return p


def test_the_install_gives_the_workbench_s_claude_code_sign_in_first_and_recommends_it(tmp_path):
    """Claude, when it asks how the workbench reaches Claude (CLAUDE.md, step 4), and the install's note when no terminal
    asked it (an agent runs the script, or --no-setup), give the Claude Code sign-in first and recommend it, as the
    question in a terminal does (claude_access.setup, the browser's server tests). Claude asks in a few words per
    option."""
    text = " ".join((ROOT / "CLAUDE.md").read_text().split())
    ask = text.split(" 4. When the workbench was installed", 1)[1].split(" Then: ", 1)[0]
    at = [ask.index(way) for way in ("Claude Code sign-in", "Anthropic API key", "Workload Identity Federation")]
    assert at == sorted(at), ask
    sign_in = ask.split("Claude Code sign-in", 1)[1].split(", an Anthropic API key", 1)[0]
    assert "first" in sign_in and "recommended" in sign_in, ask
    assert "a few words per option" in ask, ask
    note = next(line for line in whole_install(tmp_path).stdout.splitlines()
                if line.startswith("Note: Claude access is not set up yet."))
    at = [note.index(way) for way in ("Their Claude Code sign-in", "An Anthropic API key", "Workload Identity Federation:")]
    assert at == sorted(at), note
    assert "Their Claude Code sign-in (recommended), only after they accept" in note


def test_the_readme_and_the_install_summary_say_when_to_use_each_product(tmp_path):
    """The README's usage, the install's last lines when it installed both products, and the reply Claude ends an install
    with (CLAUDE.md, step 5) say when to use the terminal plugin and when the browser workbench. An install of one
    product has no choice to explain."""
    plugin, web = "Use the terminal plugin when you work in Claude Code", "Use the browser workbench when you want"
    readme = " ".join((ROOT / "README.md").read_text().replace("**", "").split())
    usage = readme.split("## Usage", 1)[1].split(" ### ", 1)[0]
    assert plugin in usage and web in usage, usage
    out = " ".join(whole_install(tmp_path / "both").stdout.split())
    summary = out.split("== The browser workbench", 1)[1].split("To start the browser workbench", 1)[0]
    assert plugin in summary and web in summary, summary
    alone = whole_install(tmp_path / "plugin", "--no-browser").stdout
    assert "Use the terminal plugin when" not in alone and "Use the browser workbench when" not in alone
    text = " ".join((ROOT / "CLAUDE.md").read_text().split())
    reply = text.split(" 5. While something the user chose", 1)[1].split(" 6. ", 1)[0]
    assert "- The plugin, when they work in Claude Code:" in reply and "- The workbench, when they want" in reply, reply


def test_the_install_summary_says_once_that_reload_plugins_loads_the_plugin_in_an_open_session(tmp_path):
    """A claude session that is already open, such as the one Claude runs the install in, loads the plugin with
    /reload-plugins. It keeps the PATH it started with, so after a change to Node, a new terminal has the plugin. The
    plugin's summary says both, once, whichever products the install installed."""
    for name, args in (("both", ()), ("plugin", ("--no-browser",))):
        out = " ".join(whole_install(tmp_path / name, *args).stdout.split())
        assert out.count("/reload-plugins") == 1, out
        summary = out.split("The plugin works in", 1)[1].split(" == ", 1)[0]
        open_session = summary.split("/reload-plugins", 1)[1].split(". ", 1)[0]
        assert "already open" in open_session, summary
        assert "change to Node" in summary and "new terminal" in summary and "PATH" in summary, summary


def test_claude_s_reply_after_an_install_says_that_reload_plugins_loads_the_plugin_in_the_open_sessions():
    """The reply Claude ends an install with (CLAUDE.md, step 5) says that /reload-plugins loads the plugin in this
    session and in the other open ones, and that a session keeps the PATH it started with, so after a change to Node a
    new terminal has it. The sample's line (step 6) gives a command for a new terminal when the sample lies outside this
    session's folder, or after such a change."""
    text = " ".join((ROOT / "CLAUDE.md").read_text().split())
    reply = text.split(" 5. While something the user chose", 1)[1].split(" 6. ", 1)[0]
    plugin = reply.split("- The plugin, when they work in Claude Code:", 1)[1].split(" - The workbench", 1)[0]
    loads = plugin.split("`/reload-plugins` loads it", 1)[1].split(". ", 1)[0]
    assert "this session" in loads and "other open" in loads, plugin
    assert "PATH" in plugin and "change to Node" in plugin and "new terminal" in plugin, plugin
    sample = text.split(" 6. When the plugin works", 1)[1].split(" ## ", 1)[0]
    when = sample.split("the line gives a command to run in a new terminal", 1)[0]
    assert "outside this session's folder" in when and "Node" in when, sample
