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
