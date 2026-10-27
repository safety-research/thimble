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
    # Claude Code's own install updates itself, unless whoever manages the machine turned that off
    line = needs(tmp_path / "own", tmp_path / "own" / "home" / ".local" / "share" / "claude" / "versions" / "2.1.283")
    assert "or later: claude update" in line
    assert "whoever manages this machine" in line


def test_what_does_not_work_yet_is_what_the_install_says_last(tmp_path):
    """A whole install, with made-up commands, whose card sandbox does not work yet: its line, and the why and fix in
    it, come again at the end, after the browser workbench's start lines, so what is left to do is said last."""
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
         '*) echo "thimble: cards cannot run yet: the made-up runner did not start."; echo "  Run the made-up fix."; exit 1 ;; esac\n')
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
    # from the first note on, every line is a note, and one of them is the sandbox's, with its why and its fix
    assert notes and all(line.startswith("Note: ") for line in notes), lines
    assert any("the made-up runner did not start. Run the made-up fix." in line for line in notes), notes
