"""What the end-to-end test (scripts/e2e_release.sh) must leave as it was in the caller's setup: the plugins Claude Code
enables and has installed, its marketplaces, the folders its global config trusts, and where ~/.local/bin/thimble
points. The test saves this before the install and compares it after the run.

    python3 scripts/e2e/claude_files.py <the run's folder>                  print it, as one line of JSON
    python3 scripts/e2e/claude_files.py <the run's folder> --against FILE   compare it with the line saved in FILE

The comparison exits 1 and names each difference when a plugin, a marketplace or the link changed, a folder trusted
before is no longer trusted, or a folder in the run's folder became trusted. A folder outside the run's folder trusted
during the run is not counted, since other Claude Code sessions trust folders too.
"""
import json
import os
import sys
import time
from pathlib import Path


def read(path: Path):
    """The JSON in `path`, None when it is missing; read again while another program is halfway through writing it."""
    for attempt in range(5):
        try:
            return json.loads(path.read_text("utf-8"))
        except FileNotFoundError:
            return None
        except ValueError:
            if attempt == 4:
                raise
            time.sleep(0.2)


def snapshot() -> dict:
    custom = os.environ.get("CLAUDE_CONFIG_DIR")
    config = Path(custom).expanduser() if custom else Path.home() / ".claude"
    settings = read(config / "settings.json") or {}
    installed = read(config / "plugins" / "installed_plugins.json") or {}
    markets = read(config / "plugins" / "known_marketplaces.json") or {}
    projects = (read(config / ".claude.json" if custom else Path.home() / ".claude.json") or {}).get("projects") or {}
    link = Path.home() / ".local" / "bin" / "thimble"
    return {
        "enabledPlugins": settings.get("enabledPlugins"),
        "extraKnownMarketplaces": settings.get("extraKnownMarketplaces"),
        "installed": sorted((installed.get("plugins") or {}) if isinstance(installed, dict) else []),
        "marketplaces": {k: (v or {}).get("source") for k, v in markets.items()} if isinstance(markets, dict) else None,
        "trusted": sorted(k for k, v in projects.items() if isinstance(v, dict) and v.get("hasTrustDialogAccepted")),
        "local_bin_thimble": os.readlink(link) if link.is_symlink() else ("a file" if link.exists() else None),
    }


def differences(before: dict, after: dict, run: Path) -> list[str]:
    out = [f"{k}: {json.dumps(before.get(k))} → {json.dumps(after.get(k))}"
           for k in sorted(set(before) | set(after)) if k != "trusted" and before.get(k) != after.get(k)]
    was, now = set(before.get("trusted") or []), set(after.get("trusted") or [])
    out += [f"no longer trusted: {k}" for k in sorted(was - now)]
    out += [f"trusted during the run: {k}" for k in sorted(now - was) if Path(k) == run or run in Path(k).parents]
    return out


def main() -> int:
    run = Path(sys.argv[1]).resolve()
    now = snapshot()
    if "--against" not in sys.argv:
        print(json.dumps(now, sort_keys=True))
        return 0
    before = json.loads(Path(sys.argv[sys.argv.index("--against") + 1]).read_text("utf-8"))
    diff = differences(before, now, run)
    print("; ".join(diff))
    return 1 if diff else 0


if __name__ == "__main__":
    sys.exit(main())
