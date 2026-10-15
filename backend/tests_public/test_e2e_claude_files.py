"""The release test's check of the caller's Claude Code files (scripts/e2e/claude_files.py): a marketplace added or
removed during the run fails it, except the official marketplace Claude Code adds on its own at its first interactive
start in a config folder."""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "e2e" / "claude_files.py"
OFFICIAL = {"claude-plugins-official": {"source": {"source": "github", "repo": "anthropics/claude-plugins-official"},
                                        "installLocation": "/made/up/marketplaces/claude-plugins-official",
                                        "lastUpdated": "2026-10-15T00:00:00.000Z"}}
OTHER = {"some-team": {"source": {"source": "github", "repo": "some-org/some-plugins"},
                       "installLocation": "/made/up/marketplaces/some-team", "lastUpdated": "2026-10-15T00:00:00.000Z"}}


def run(tmp_path: Path, *args: str) -> subprocess.CompletedProcess:
    env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": str(tmp_path / "home"),
           "CLAUDE_CONFIG_DIR": str(tmp_path / "cc")}
    return subprocess.run([sys.executable, "-I", str(SCRIPT), str(tmp_path / "run"), *args], env=env,
                          capture_output=True, text=True, check=False)


def marketplaces(tmp_path: Path, known: dict | None) -> None:
    path = tmp_path / "cc" / "plugins" / "known_marketplaces.json"
    if known is None:
        path.unlink(missing_ok=True)
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(known))


def compare(tmp_path: Path, before: dict | None, after: dict | None) -> subprocess.CompletedProcess:
    (tmp_path / "home").mkdir(exist_ok=True)
    (tmp_path / "run").mkdir(exist_ok=True)
    marketplaces(tmp_path, before)
    saved = tmp_path / "before.json"
    saved.write_text(run(tmp_path).stdout)
    marketplaces(tmp_path, after)
    return run(tmp_path, "--against", str(saved))


def test_the_official_marketplace_claude_code_adds_on_its_own_is_not_a_change(tmp_path):
    """Claude Code 2.1.300 adds claude-plugins-official at its first interactive start in a config folder, as the
    hooks module's contract check makes it; the run did not change the caller's marketplaces."""
    r = compare(tmp_path, None, OFFICIAL)
    assert (r.returncode, r.stdout.strip()) == (0, "")


def test_any_other_change_to_the_marketplaces_is_one(tmp_path):
    r = compare(tmp_path, None, OTHER)
    assert r.returncode == 1 and r.stdout.startswith("marketplaces: {} → "), r.stdout
    r = compare(tmp_path, {}, {**OFFICIAL, **OTHER})
    assert r.returncode == 1 and '"some-team"' in r.stdout, "the official one goes uncounted, the other does not"
    r = compare(tmp_path, OFFICIAL, None)
    assert r.returncode == 1 and "claude-plugins-official" in r.stdout, "removed"
    moved = {"claude-plugins-official": {**OFFICIAL["claude-plugins-official"],
                                         "source": {"source": "github", "repo": "someone/claude-plugins-official"}}}
    r = compare(tmp_path, None, moved)
    assert r.returncode == 1 and "someone/claude-plugins-official" in r.stdout, "another source under that name"
