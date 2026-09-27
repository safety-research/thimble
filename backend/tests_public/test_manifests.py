"""The package and plugin manifests: each names the repository's license, and a description that counts the plugin's
hooks counts them right."""
import json
import re
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
LICENSE = "Apache-2.0"


def test_every_manifest_names_the_license():
    assert (ROOT / "LICENSE").read_text().lstrip().startswith("Apache License")
    assert tomllib.loads((ROOT / "backend" / "pyproject.toml").read_text())["project"]["license"] == LICENSE
    assert json.loads((ROOT / "frontend" / "package.json").read_text())["license"] == LICENSE
    assert json.loads((ROOT / "frontend" / "package-lock.json").read_text())["packages"][""]["license"] == LICENSE
    assert json.loads((ROOT / "plugin" / ".claude-plugin" / "plugin.json").read_text())["license"] == LICENSE
    market = json.loads((ROOT / ".claude-plugin" / "marketplace.json").read_text())
    assert [p.get("license") for p in market["plugins"]] == [LICENSE]


NUMBERS = {w: n for n, w in enumerate("zero one two three four five six seven eight nine ten eleven twelve".split())}


def test_a_manifest_that_counts_the_hooks_counts_them_right():
    hooks = json.loads((ROOT / "plugin" / "hooks" / "hooks.json").read_text())["hooks"]
    commands = sum(len(group["hooks"]) for groups in hooks.values() for group in groups)
    for rel in (".claude-plugin/marketplace.json", "plugin/.claude-plugin/plugin.json"):
        text = (ROOT / rel).read_text()
        for word in re.findall(r"\b(\w+) hooks\b", text):
            n = int(word) if word.isdigit() else NUMBERS.get(word.lower())
            assert n is None or n == commands, f"{rel} says {word} hooks; hooks.json has {commands}"
