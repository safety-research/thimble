"""The package and plugin manifests: each names the repository's license."""
import json
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
