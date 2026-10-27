"""scripts/install.sh gives a fresh install each feature's default as --config KEY=VALUE, in the form
`claude plugin install` takes: a string bare, a boolean as true or false, and no empty value (Claude Code refuses one,
and one refused value drops them all)."""
import json
import re
import subprocess
import sys
from pathlib import Path

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
    env = {"PATH": f"{bin_}:/usr/bin:/bin", "HOME": str(home), "THIMBLE_PYTHON": sys.executable}
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
           "THIMBLE_HOME": str(tmp_path / "thimble"), "THIMBLE_BROWSER_HOME": str(tmp_path / "browser-home")}
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
           "THIMBLE_HOME": str(tmp_path / "thimble"), "THIMBLE_BROWSER_HOME": str(tmp_path / "browser-home")}
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


def plugin_install(tmp_path, source, claude="exit 0\n"):
    """scripts/install.sh --no-browser with made-up commands, when Claude Code's marketplace thimble (in its list and in
    its user settings) is the folder `source`, and this shell's THIMBLE_HOME is tmp_path/thimble. The made-up claude
    logs each call, says its version, lists no plugin, and else runs `claude`. The run, and the plugin calls."""
    entry = {"source": "directory", "path": str(source)}
    cc = tmp_path / "cc"
    (cc / "plugins").mkdir(parents=True)
    (cc / "plugins" / "known_marketplaces.json").write_text(json.dumps({"thimble": {"source": entry, "installLocation": str(source)}}))
    (cc / "settings.json").write_text(json.dumps({"extraKnownMarketplaces": {"thimble": {"source": entry}}}))
    bin_ = tmp_path / "stubs"
    log = tmp_path / "claude.log"
    stub(bin_ / "claude", f'echo "$@" >> "{log}"\n'
         'case "$1 $2" in "--version ") echo "2.1.311 (Claude Code)"; exit 0 ;; "plugin list") echo "[]"; exit 0 ;; esac\n'
         + claude)
    stub(bin_ / "node", "echo v22.20.0\n")
    home = tmp_path / "home"
    home.mkdir()
    env = {"PATH": f"{bin_}:/usr/bin:/bin", "HOME": str(home), "THIMBLE_PYTHON": sys.executable, "CLAUDE_CONFIG_DIR": str(cc),
           "THIMBLE_HOME": str(tmp_path / "thimble")}
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
