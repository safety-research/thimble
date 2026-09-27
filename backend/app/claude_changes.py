"""What terminal-first changes in Claude Code's own files, recorded in thimble's home so that it can be put back.

- Trust. `claude --bg` starts only in a folder Claude Code trusts, so a background session's work folder under thimble's
  workspaces is marked trusted (`hasTrustDialogAccepted` in the `projects` of Claude Code's global config), one folder
  at a time, and only once the analyst has agreed to it (consented), which Settings asks the first time terminal-first
  is turned on. TRUST_FILE records each folder marked, in which config file, and what its entry held before.
- The statusline. cc_settings.set_statusline sets `statusLine` in a corpus folder's .claude/settings.local.json and
  records what it held before in STATUSLINE_FILE; restore_statusline puts that back.

untrust and restore_statusline undo both: for a workspace when terminal-first is turned off (ledger.put_settings), and
for every folder on `thimble uninstall`, which runs `python -m app.claude_changes undo` before it removes thimble's home.
The module imports only the standard library, so the uninstall can run it with any Python 3.
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

CONSENT_FILE = "terminal-first-consent.json"  # in thimble's home: {at}, when the analyst agreed to the changes
TRUST_FILE = "trusted-folders.json"  # in thimble's home: {folder: {config, created, had?}} (trust)
STATUSLINE_FILE = "statusline-overrides.json"  # in thimble's home: {folder: {ours, previous}} (cc_settings.set_statusline)
LOCAL_SETTINGS = Path(".claude") / "settings.local.json"
TRUST_KEY = "hasTrustDialogAccepted"


def home() -> Path:
    return Path(os.environ.get("THIMBLE_HOME") or "~/.thimble").expanduser()


def _read(path: Path) -> dict[str, Any]:
    try:
        d = json.loads(path.read_text("utf-8"))
    except (OSError, ValueError):
        return {}
    return d if isinstance(d, dict) else {}


def _write(path: Path, data: dict[str, Any], indent: int = 2) -> None:
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
            f.write(json.dumps(data, indent=indent, ensure_ascii=False) + "\n")
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


# --------------------------------------------------------------------------- consent


def consented() -> bool:
    """Whether the analyst agreed to terminal-first's changes to Claude Code's files on this install."""
    return bool(_read(home() / CONSENT_FILE).get("at"))


def consent() -> None:
    _write(home() / CONSENT_FILE, {"at": datetime.now(timezone.utc).isoformat(timespec="seconds")})


# --------------------------------------------------------------------------- trust


def trusted(folder: Path, data: dict[str, Any]) -> bool:
    """Whether Claude Code's config `data` trusts `folder`, by its own entry or a folder's above it."""
    projects = data.get("projects") if isinstance(data.get("projects"), dict) else {}
    for f in (folder, *folder.parents):
        entry = projects.get(str(f))
        if isinstance(entry, dict) and entry.get(TRUST_KEY) is True:
            return True
    return False


def trust(folder: Path, config_path: Path) -> bool:
    """Mark `folder` alone trusted in the Claude Code config at `config_path` and record it (TRUST_FILE). True when it is
    trusted; False when the config cannot be read or written."""
    try:
        data = json.loads(config_path.read_text("utf-8")) if config_path.is_file() else {}
    except (OSError, ValueError):
        return False
    if not isinstance(data, dict):
        return False
    if trusted(folder, data):
        return True
    projects = data.setdefault("projects", {})
    if not isinstance(projects, dict):
        return False
    entry = projects.get(str(folder))
    created = not isinstance(entry, dict)
    record: dict[str, Any] = {"config": str(config_path), "created": created}
    if not created and TRUST_KEY in entry:
        record["had"] = entry[TRUST_KEY]
    grants = _read(home() / TRUST_FILE)
    grants[str(folder)] = grants.get(str(folder)) or record  # the first record keeps what the entry held before thimble
    _write(home() / TRUST_FILE, grants)
    projects[str(folder)] = {**(entry if isinstance(entry, dict) else {}), TRUST_KEY: True}
    try:
        _write(config_path, data)
    except OSError:
        return False
    return True


def untrust(under: Path | None = None) -> list[str]:
    """Put back the trust of each folder marked (TRUST_FILE) inside `under`, or every one: its entry's key as it was, the
    entry gone when thimble made it and nothing else was added to it. The folders put back."""
    grants = _read(home() / TRUST_FILE)
    mine = [f for f in grants if under is None or Path(f) == under or under in Path(f).parents]
    if not mine:
        return []
    done: list[str] = []
    by_config: dict[str, list[str]] = {}
    for f in mine:
        rec = grants[f] if isinstance(grants[f], dict) else {}
        by_config.setdefault(str(rec.get("config") or ""), []).append(f)
    for cfg, folders in by_config.items():
        path = Path(cfg) if cfg else None
        data = _read(path) if path is not None else {}
        projects = data.get("projects") if isinstance(data.get("projects"), dict) else None
        if path is not None and projects is not None:
            for f in folders:
                rec = grants[f] if isinstance(grants[f], dict) else {}
                entry = projects.get(f)
                if isinstance(entry, dict):
                    if "had" in rec:
                        entry[TRUST_KEY] = rec["had"]
                    else:
                        entry.pop(TRUST_KEY, None)
                    if rec.get("created") and not entry:
                        projects.pop(f, None)
            try:
                _write(path, data)
            except OSError:
                continue
        for f in folders:
            grants.pop(f, None)
            done.append(f)
    _write(home() / TRUST_FILE, grants)
    return done


# --------------------------------------------------------------------------- the statusline


def statuslines() -> dict[str, Any]:
    return _read(home() / STATUSLINE_FILE)


def restore_statusline(cwd: Path) -> bool:
    """Put back the folder's own `statusLine` in place of thimble's, when thimble's is still there; True when it did."""
    kept = statuslines()
    rec = kept.pop(str(cwd.resolve()), None)
    if rec is None:
        return False
    _write(home() / STATUSLINE_FILE, kept, indent=1)
    path = cwd / LOCAL_SETTINGS
    d = _read(path)
    line = d.get("statusLine")
    if not isinstance(line, dict) or not isinstance(rec, dict) or line.get("command") != rec.get("ours"):
        return False
    if rec.get("previous"):
        d["statusLine"] = rec["previous"]
    else:
        d.pop("statusLine", None)
    try:
        if d:
            _write(path, d)
        else:
            path.unlink()
    except OSError:
        return False
    return True


def undo() -> list[str]:
    """Every change recorded here put back: each corpus folder's statusline and each work folder's trust. A line each."""
    lines = [f"statusline of {f} put back" for f in list(statuslines()) if restore_statusline(Path(f))]
    return lines + [f"trust of {f} taken back" for f in untrust()]


if __name__ == "__main__":
    if sys.argv[1:] != ["undo"]:
        print("usage: python -m app.claude_changes undo", file=sys.stderr)
        sys.exit(2)
    for ln in undo():
        print(f"  {ln}")
