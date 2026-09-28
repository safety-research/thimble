"""The two places thimble changes Claude Code's files, which are the user's.

- Trust. `claude --bg` starts only in a folder Claude Code trusts, and trust is kept in Claude Code's global config
  (`$CLAUDE_CONFIG_DIR/.claude.json`, else `~/.claude.json`). install.sh asks once whether to trust thimble's
  workspaces folder, whose entry covers every work folder below it (install_trust), and records the answer in thimble's
  home (TRUST_FILE), so that an update does not ask again. `thimble uninstall` takes back an entry thimble added
  (untrust).
- Older versions wrote statusLine, CLAUDE_CODE_EFFORT_LEVEL and CLAUDE_CODE_DISABLE_FAST_MODE into folders'
  .claude/settings.local.json and recorded them in thimble's home. cleanup removes each key that still holds thimble's
  value, and the records with it, so it runs once.

Standard library only, so install.sh and `thimble uninstall` run this file with any Python 3.
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path
from typing import Any

TRUST_FILE = "trust.json"  # in thimble's home: {folder, config, answer: yes | no, added}
TRUST_KEY = "hasTrustDialogAccepted"
QUESTION = ("Claude Code starts thimble's background sessions (Terminal-first) only in folders it trusts. Mark thimble's "
            "workspaces folder\n  {folder}\ntrusted in {config}? It covers every work folder thimble makes there. [y/N] ")
# the records of the keys older versions wrote: file in thimble's home -> the key in a folder's settings.local.json
# (None: statusLine, recorded as {ours, previous})
OLD_RECORDS = {"effort-overrides.json": "CLAUDE_CODE_EFFORT_LEVEL", "fast-overrides.json": "CLAUDE_CODE_DISABLE_FAST_MODE",
               "statusline-overrides.json": None}
OLD_FILES = ("terminal-first-consent.json", "trusted-folders.json")
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
    value = os.environ.get("CLAUDE_CONFIG_DIR")
    return Path(value).expanduser() / ".claude.json" if value else Path.home() / ".claude.json"


def workspaces_dir(tree: Path) -> Path:
    """The workspaces folder the server of the install at `tree` uses, as cli.resolve_env finds it:
    THIMBLE_WORKSPACES_DIR, else the one server.json recorded, else <tree>/workspaces."""
    recorded = (_read(home() / "server.json").get("env") or {}).get("workspaces_dir")
    raw = os.environ.get("THIMBLE_WORKSPACES_DIR") or (recorded if isinstance(recorded, str) else "") or str(tree / "workspaces")
    return Path(raw).expanduser().resolve()


def trusted(folder: Path, data: dict[str, Any]) -> bool:
    """Whether Claude Code's config `data` trusts `folder`, by its own entry or a folder's above it."""
    projects = data.get("projects") if isinstance(data.get("projects"), dict) else {}
    for f in (folder, *folder.parents):
        entry = projects.get(str(f))
        if isinstance(entry, dict) and entry.get(TRUST_KEY) is True:
            return True
    return False


def _set_trust(folder: Path, config: Path, on: bool) -> None:
    """Set (or take back) `folder`'s trust in `config`, read again right before the write so that what Claude Code
    saved meanwhile is kept. A taken-back entry that holds nothing else goes."""
    data = json.loads(config.read_text("utf-8")) if config.is_file() else {}
    if not isinstance(data, dict) or not isinstance(data.setdefault("projects", {}), dict):
        raise ValueError(f"{config} does not hold Claude Code's config")
    projects = data["projects"]
    entry = projects.get(str(folder)) if isinstance(projects.get(str(folder)), dict) else {}
    if on:
        projects[str(folder)] = {**entry, TRUST_KEY: True}
    else:
        entry.pop(TRUST_KEY, None)
        if entry:
            projects[str(folder)] = entry
        else:
            projects.pop(str(folder), None)
    _write(config, data)


def install_trust(tree: Path, answer: str | None = None) -> str:
    """install.sh's trust step for the install at `tree` (module note): `answer` is yes or no from its flags, else the
    recorded one, else asked on a terminal. The line to print."""
    folder, config = workspaces_dir(tree), global_config()
    rec = _read(home() / TRUST_FILE)
    same = rec.get("folder") == str(folder) and rec.get("config") == str(config)
    if answer is None and same and rec.get("answer") in ("yes", "no"):
        return (f"answered {rec['answer']} at an earlier install; install.sh --trust-workspaces or --no-trust-workspaces "
                "changes it")
    record = {"folder": str(folder), "config": str(config), "answer": "yes", "added": bool(same and rec.get("added"))}
    if trusted(folder, _read(config)):
        _write(home() / TRUST_FILE, record)
        return f"{folder} is trusted in {config}"
    if answer is None:
        if not sys.stdin.isatty():
            return (f"not asked (no terminal), so nothing was written. Terminal-first's background sessions need {folder} "
                    "trusted, which install.sh --trust-workspaces does")
        try:
            answer = "yes" if input(QUESTION.format(folder=folder, config=config)).strip().lower() in ("y", "yes") else "no"
        except EOFError:
            answer = "no"
    if answer == "yes":
        folder.mkdir(parents=True, exist_ok=True)
        try:
            _set_trust(folder, config, True)
        except (OSError, ValueError) as e:
            return f"could not write {config} ({e}); nothing recorded"
    _write(home() / TRUST_FILE, {**record, "answer": answer, "added": answer == "yes"})
    if answer == "yes":
        return f"marked {folder} trusted in {config}"
    return "not trusted. Terminal-first's background sessions need it, which install.sh --trust-workspaces does"


def untrust() -> list[str]:
    """Take back the trust entry install_trust added, if it did; a line for what was done."""
    rec = _read(home() / TRUST_FILE)
    if not rec.get("added") or not rec.get("folder") or not rec.get("config"):
        return []
    try:
        _set_trust(Path(rec["folder"]), Path(rec["config"]), False)
    except (OSError, ValueError):
        return []
    (home() / TRUST_FILE).unlink(missing_ok=True)
    return [f"trust of {rec['folder']} taken back in {rec['config']}"]


# --------------------------------------------------------------------------- the keys older versions wrote


def cleanup() -> list[str]:
    """Remove from each recorded folder's settings.local.json the keys older versions wrote that still hold thimble's
    value (a statusLine gets back the one it replaced), then the records (module note). A file left empty goes. A line
    for each file changed."""
    edits: dict[str, list[tuple[str | None, Any]]] = {}
    for record, key in OLD_RECORDS.items():
        for folder, value in _read(home() / record).items():
            edits.setdefault(folder, []).append((key, value))
    done: list[str] = []
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
            continue
        done.append(f"removed the keys an older thimble wrote into {path}")
    for name in (*OLD_RECORDS, *OLD_FILES):
        (home() / name).unlink(missing_ok=True)
    return done


if __name__ == "__main__":
    args = sys.argv[1:]
    if args[:1] == ["trust"] and len(args) in (2, 3):
        print(install_trust(Path(args[1]), {"--yes": "yes", "--no": "no"}.get(args[2]) if len(args) == 3 else None))
    elif args == ["undo"]:
        for ln in [*cleanup(), *untrust()]:
            print(f"  {ln}")
    else:
        print("usage: claude_changes.py trust <tree> [--yes | --no] | undo", file=sys.stderr)
        sys.exit(2)
