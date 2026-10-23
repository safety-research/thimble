"""The places earlier versions of thimble changed Claude Code's files, which are the user's, and how `thimble uninstall`
puts them back.

- Trust. Up to 0.5.0, thimble's agents ran as Claude Code background sessions, which start only in a folder Claude Code
  trusts, so install.sh asked whether to trust thimble's folder and, on a yes, added it to Claude Code's global config
  (`$CLAUDE_CONFIG_DIR/.claude.json`, else `~/.claude.json`), recording the answer in thimble's home (TRUST_FILE). From
  0.6.0 the agents run as `claude -p` sessions, which need no trust, so nothing asks or writes it any more. `thimble
  uninstall` takes back the entries an earlier install added, an older version's per-folder ones (OLD_TRUST) included
  (untrust).
- Older versions wrote statusLine, CLAUDE_CODE_EFFORT_LEVEL and CLAUDE_CODE_DISABLE_FAST_MODE into folders'
  .claude/settings.local.json and recorded them in thimble's home. cleanup removes each key that still holds thimble's
  value, and the records with it, so it runs once.

Standard library only, so `thimble uninstall` runs this file with any Python 3.
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path
from typing import Any

TRUST_FILE = "trust.json"  # in thimble's home, written by 0.5.0 and earlier: {folder, config, answer: yes | no, added}
TRUST_KEY = "hasTrustDialogAccepted"
# the records of the keys older versions wrote: file in thimble's home -> the key in a folder's settings.local.json
# (None: statusLine, recorded as {ours, previous})
OLD_RECORDS = {"effort-overrides.json": "CLAUDE_CODE_EFFORT_LEVEL", "fast-overrides.json": "CLAUDE_CODE_DISABLE_FAST_MODE",
               "statusline-overrides.json": None}
OLD_TRUST = "trusted-folders.json"  # an older version's per-folder trust entries: {folder: {config, ...}}
LOCAL_SETTINGS = Path(".claude") / "settings.local.json"


def home() -> Path:
    return Path(os.environ.get("THIMBLE_HOME") or "~/.thimble").expanduser()


def _read(path: Path) -> dict[str, Any]:
    try:
        d = json.loads(path.read_text("utf-8"))
    except (OSError, ValueError):
        return {}
    return d if isinstance(d, dict) else {}


def _write(path: Path, data: dict[str, Any]) -> None:
    """`data` as `path`'s JSON, written to a temp file and moved into place, keeping the file's mode (0600 for a new
    one)."""
    try:
        mode = path.stat().st_mode & 0o777
    except OSError:
        mode = 0o600
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            os.fchmod(f.fileno(), mode)
            f.write(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


# --------------------------------------------------------------------------- trust


def global_config() -> Path:
    """Claude Code's global config, which keeps the folders it trusts."""
    value = os.environ.get("CLAUDE_CONFIG_DIR")
    return Path(value).expanduser() / ".claude.json" if value else Path.home() / ".claude.json"


def _set_trust(folder: Path, config: Path, on: bool) -> None:
    """Set (or take back) `folder`'s trust in `config`, read again right before the write so that what Claude Code
    saved meanwhile is kept. A taken-back entry that holds nothing else goes; one that holds no trust is left alone."""
    data = json.loads(config.read_text("utf-8")) if config.is_file() else {}
    if not isinstance(data, dict) or not isinstance(data.setdefault("projects", {}), dict):
        raise ValueError(f"{config} does not hold Claude Code's config")
    projects = data["projects"]
    entry = projects.get(str(folder)) if isinstance(projects.get(str(folder)), dict) else {}
    if on:
        projects[str(folder)] = {**entry, TRUST_KEY: True}
    else:
        if TRUST_KEY not in entry:
            return
        del entry[TRUST_KEY]
        if entry:
            projects[str(folder)] = entry
        else:
            projects.pop(str(folder), None)
    _write(config, data)


def untrust() -> list[str]:
    """Take back the trust entries an earlier install added (module note), then their records; a line for each.
    OSError or ValueError, with the records kept, when Claude Code's config cannot be read or written."""
    rec = _read(home() / TRUST_FILE)
    grants = [(rec["folder"], rec["config"])] if rec.get("added") and rec.get("folder") and rec.get("config") else []
    grants += [(f, g["config"]) for f, g in _read(home() / OLD_TRUST).items() if isinstance(g, dict) and g.get("config")]
    for folder, config in grants:
        _set_trust(Path(folder), Path(config), False)
    for name in (TRUST_FILE, OLD_TRUST):
        (home() / name).unlink(missing_ok=True)
    return [f"trust of {folder} taken back in {config}" for folder, config in grants]


# --------------------------------------------------------------------------- the keys older versions wrote


def cleanup() -> list[str]:
    """Remove from each recorded folder's settings.local.json the keys older versions wrote that still hold thimble's
    value (a statusLine gets back the one it replaced), then the records (module note), which keep only the folders
    whose file could not be written. A file left empty goes. A line for each file changed."""
    edits: dict[str, list[tuple[str | None, Any]]] = {}
    for record, key in OLD_RECORDS.items():
        for folder, value in _read(home() / record).items():
            edits.setdefault(folder, []).append((key, value))
    done: list[str] = []
    failed: set[str] = set()
    for folder, todo in edits.items():
        path = Path(folder) / LOCAL_SETTINGS
        d = _read(path)
        changed = False
        for key, value in todo:
            env, line = d.get("env"), d.get("statusLine")
            if key and isinstance(env, dict) and isinstance(value, str) and str(env.get(key)) == value:
                del env[key]
                if not env:
                    del d["env"]
                changed = True
            elif not key and isinstance(value, dict) and isinstance(line, dict) and line.get("command") == value.get("ours"):
                if value.get("previous"):
                    d["statusLine"] = value["previous"]
                else:
                    del d["statusLine"]
                changed = True
        if not changed:
            continue
        try:
            if d:
                _write(path, d)
            else:
                path.unlink()
        except OSError:
            failed.add(folder)
            continue
        done.append(f"removed the keys an older thimble wrote into {path}")
    for name in OLD_RECORDS:
        left = {f: v for f, v in _read(home() / name).items() if f in failed}
        if left:
            _write(home() / name, left)
        else:
            (home() / name).unlink(missing_ok=True)
    return done


if __name__ == "__main__":
    args = sys.argv[1:]
    if args == ["undo"]:
        failed = False
        for step in (cleanup, untrust):
            try:
                for ln in step():
                    print(f"  {ln}")
            except (OSError, ValueError) as e:
                print(f"  could not put back what thimble changed in Claude Code's files: {e}", file=sys.stderr)
                failed = True
        if any((home() / name).exists() for name in OLD_RECORDS):
            print("  some folders' .claude/settings.local.json could not be written", file=sys.stderr)
            failed = True
        sys.exit(1 if failed else 0)
    else:
        print("usage: claude_changes.py undo", file=sys.stderr)
        sys.exit(2)
