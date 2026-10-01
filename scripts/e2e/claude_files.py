"""What the end-to-end test (scripts/e2e_release.sh) must leave as it was in the caller's setup, as one line of JSON:
the plugins Claude Code enables and has installed, its marketplaces, the folders under the run's own folder that its
global config trusts, and where ~/.local/bin/thimble points. The test prints this before the install and after the run
and compares the two.

    python3 scripts/e2e/claude_files.py <the run's folder>
"""
import json
import os
import sys
from pathlib import Path


def read(path: Path):
    try:
        return json.loads(path.read_text("utf-8"))
    except FileNotFoundError:
        return None


def main(run: Path) -> None:
    custom = os.environ.get("CLAUDE_CONFIG_DIR")
    config = Path(custom).expanduser() if custom else Path.home() / ".claude"
    settings = read(config / "settings.json") or {}
    installed = read(config / "plugins" / "installed_plugins.json") or {}
    markets = read(config / "plugins" / "known_marketplaces.json") or {}
    projects = (read(config / ".claude.json" if custom else Path.home() / ".claude.json") or {}).get("projects") or {}
    link = Path.home() / ".local" / "bin" / "thimble"
    print(json.dumps({
        "enabledPlugins": settings.get("enabledPlugins"),
        "extraKnownMarketplaces": settings.get("extraKnownMarketplaces"),
        "installed": sorted((installed.get("plugins") or {}) if isinstance(installed, dict) else []),
        "marketplaces": {k: (v or {}).get("source") for k, v in markets.items()} if isinstance(markets, dict) else None,
        "trusted_in_run": sorted(k for k, v in projects.items()
                                 if k.startswith(str(run)) and isinstance(v, dict) and v.get("hasTrustDialogAccepted")),
        "local_bin_thimble": os.readlink(link) if link.is_symlink() else ("a file" if link.exists() else None),
    }, sort_keys=True))


if __name__ == "__main__":
    main(Path(sys.argv[1]).resolve())
