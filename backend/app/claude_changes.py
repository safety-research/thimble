"""The two places thimble changes Claude Code's files, which are the user's.

- Trust. `claude --bg` starts only in a folder Claude Code trusts, and trust is kept in Claude Code's global config
  (`$CLAUDE_CONFIG_DIR/.claude.json`, else `~/.claude.json`). install.sh asks once whether to trust thimble's folder
  (trust_folder): the install itself when its workspaces folder is inside it, as in a checkout or a release copy, since
  a code ticket's worktree counts as the checkout it was cut from, else the workspaces folder; its entry covers every
  work folder below it: before it installs anything when it has python3
  (question), else at its trust step (install_trust), which records the answer in thimble's home (TRUST_FILE), so that
  an update does not ask again; `install.sh --trust-workspaces` or `--no-trust-workspaces` changes it later, and a no
  takes back the entry an earlier yes added. `thimble uninstall` takes back the entries thimble added, an older
  version's per-folder ones (OLD_TRUST) included (untrust).
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
QUESTION = ("Trust thimble's folder {folder} by adding it to {config}?\n"
            "It holds thimble's workspaces, where its agents run, and the code the dev agent changes. The orientation, "
            "its critic, the writers and code tickets need this: they run as Claude Code background agents, which show "
            "in your terminal's agent tray, and Claude Code starts those only in a folder it trusts. With a no, they "
            "can't start until the folder is trusted. `thimble uninstall` takes the entry back.")
CHANGE = "install.sh --trust-workspaces or --no-trust-workspaces changes it"
UNTRUSTED = ("the orientation, its critic, the writers and code tickets can't start until it is; "
             "`bash {install} --trust-workspaces` trusts it")
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
    value = os.environ.get("CLAUDE_CONFIG_DIR")
    return Path(value).expanduser() / ".claude.json" if value else Path.home() / ".claude.json"


def workspaces_dir(tree: Path) -> Path:
    """The workspaces folder the server of the install at `tree` uses, as cli.resolve_env finds it:
    THIMBLE_WORKSPACES_DIR, else the one server.json recorded when a server of this install wrote it (not an earlier
    install's, whose folder may be gone), else <tree>/workspaces."""
    st = _read(home() / "server.json")
    recorded = (st.get("env") or {}).get("workspaces_dir") if _same(st.get("repo"), tree) else None
    raw = os.environ.get("THIMBLE_WORKSPACES_DIR") or (recorded if isinstance(recorded, str) else "") or str(tree / "workspaces")
    return Path(raw).expanduser().resolve()


def _same(a: Any, b: Path) -> bool:
    try:
        return isinstance(a, str) and Path(a).expanduser().resolve() == Path(b).expanduser().resolve()
    except OSError:
        return False


def trust_folder(tree: Path) -> Path:
    """The folder install.sh asks to trust for the install at `tree` (module note): the install itself when its
    workspaces folder is inside it, since that one entry also covers a code ticket's worktree, else the workspaces
    folder."""
    ws, root = workspaces_dir(tree), Path(tree).expanduser().resolve()
    return root if ws.is_relative_to(root) else ws


def trusted(folder: Path, data: dict[str, Any]) -> bool:
    """Whether Claude Code's config `data` trusts `folder`, by the rule `claude --bg` applies to the folder it starts
    in, which it reads by its real path: the trust of the main checkout of the git repository holding the folder (a
    worktree's included), else of the folder or a folder above it, up to the root of that repository when there is
    one. An entry without the trust does not end the search (Claude Code writes one, hasTrustDialogAccepted false,
    for each folder it runs in), so a trusted folder covers the folders below it, except those inside a repository
    below it. An entry for a path through a symlink does not trust the folder the link leads to."""
    real = Path(os.path.realpath(folder))
    root = _git_root(real)
    if root and own_trust(_main_checkout(root), data):
        return True
    for f in (real, *real.parents):
        if own_trust(f, data):
            return True
        if f == root:
            break
    return False


def own_trust(folder: Path, data: dict[str, Any]) -> bool:
    """Whether `folder`'s own entry in Claude Code's config `data` holds the trust."""
    projects = data.get("projects") if isinstance(data.get("projects"), dict) else {}
    entry = projects.get(str(folder))
    return isinstance(entry, dict) and entry.get(TRUST_KEY) is True


def _git_root(folder: Path) -> Path | None:
    """The nearest folder at or above `folder` that holds a .git folder or file, as Claude Code finds a repository."""
    for f in (folder, *folder.parents):
        try:
            if (f / ".git").is_dir() or (f / ".git").is_file():
                return f
        except OSError:
            continue
    return None


def _main_checkout(root: Path) -> Path:
    """The main checkout of the repository whose worktree is `root` (its .git a file naming
    <repo>/.git/worktrees/<name>), else `root`."""
    try:
        line = (root / ".git").read_text("utf-8").strip() if (root / ".git").is_file() else ""
        if not line.startswith("gitdir:"):
            return root
        gitdir = (root / line[len("gitdir:"):].strip()).resolve()
        common = (gitdir / (gitdir / "commondir").read_text("utf-8").strip()).resolve()
        back = (gitdir / (gitdir / "gitdir").read_text("utf-8").strip()).resolve()
        if gitdir.parent != common / "worktrees" or back != (root / ".git").resolve():
            return root
        if common.name == ".git":
            return common.parent
        return root if (common / ".git").exists() else common
    except (OSError, ValueError):
        return root


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


def _answer(rec: dict[str, Any], folder: Path, config: Path, data: dict[str, Any]) -> str:
    """The answer in the trust record `rec` for `folder` and `config`, yes or no, else ''. A yes that added no entry was
    recorded because the folder was trusted already, so it counts only while the folder is trusted (`data`, the
    config)."""
    if rec.get("folder") != str(folder) or rec.get("config") != str(config) or rec.get("answer") not in ("yes", "no"):
        return ""
    if rec["answer"] == "yes" and not rec.get("added") and not trusted(folder, data):
        return ""
    return rec["answer"]


def question(tree: Path) -> str:
    """The trust question for the install at `tree`, which install.sh asks before it installs anything (module note);
    '' when install_trust would not ask it: an answer for this folder and config is recorded, or the folder is trusted."""
    folder, config = trust_folder(tree), global_config()
    data = _read(config)
    if _answer(_read(home() / TRUST_FILE), folder, config, data) or trusted(folder, data):
        return ""
    return QUESTION.format(folder=folder, config=config)


def skipped(tree: Path) -> str:
    """Why install.sh does not ask the trust question for the install at `tree`, naming the folder; '' when it asks it
    (question)."""
    folder, config = trust_folder(tree), global_config()
    rec, data = _read(home() / TRUST_FILE), _read(config)
    on = trusted(folder, data)
    answer = _answer(rec, folder, config, data)
    if answer == "no" and not on:
        return f"answered no at your earlier install, so {folder} is not trusted; --trust-workspaces changes it"
    if answer == "no":
        return f"answered no at your earlier install, but {config} trusts {folder} by an entry thimble did not add"
    if answer == "yes" and not on:
        return (f"answered yes at your earlier install, but {config} no longer trusts {folder}; --trust-workspaces "
                "trusts it again")
    if answer == "yes" and rec.get("added"):
        return f"already trusted from your earlier install ({folder}); --no-trust-workspaces changes it"
    if on:
        return f"already trusted in {config} ({folder}), by an entry thimble did not add"
    return ""


def install_trust(tree: Path, answer: str | None = None) -> str:
    """install.sh's trust step for the install at `tree` (module note): `answer` is yes or no from its flags or its
    question, else the recorded one, else asked on a terminal. The line to print."""
    folder, config = trust_folder(tree), global_config()
    rec = _read(home() / TRUST_FILE)
    same = rec.get("folder") == str(folder) and rec.get("config") == str(config)
    untrusted = UNTRUSTED.format(install=tree / "scripts" / "install.sh")
    recorded = _answer(rec, folder, config, _read(config))
    if answer is None and recorded:
        if recorded == "no" and not trusted(folder, _read(config)):
            return f"answered no at an earlier install, so {folder} is not trusted, and {untrusted}"
        return f"answered {recorded} at an earlier install; {CHANGE}"
    added = bool(rec.get("added") and rec.get("folder") and rec.get("config"))
    if added and (answer == "no" or not same):  # the entry an earlier yes added: refused now, or for another folder
        try:
            _set_trust(Path(rec["folder"]), Path(rec["config"]), False)
        except (OSError, ValueError) as e:
            return f"could not write {rec['config']} ({e}); nothing recorded"
        added = False
    record = {"folder": str(folder), "config": str(config), "answer": answer or "yes", "added": added}
    data = _read(config)
    if trusted(folder, data) and (answer != "yes" or own_trust(folder, data)):  # a yes writes the folder's own entry
        _write(home() / TRUST_FILE, record)
        return f"{folder} is trusted in {config}{' by an entry thimble did not add' if answer == 'no' else ''}"
    if answer is None:
        if not sys.stdin.isatty():
            return f"not asked (no terminal), so {folder} is not trusted, and {untrusted}"
        try:
            reply = input(QUESTION.format(folder=folder, config=config) + " [y/N] ")
            answer = "yes" if reply.strip().lower() in ("y", "yes") else "no"
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
    return f"not trusted, so {untrusted}"


def untrust() -> list[str]:
    """Take back the trust entries thimble added (module note), then their records; a line for each. OSError or
    ValueError, with the records kept, when Claude Code's config cannot be read or written."""
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
    if args[:1] == ["trust"] and len(args) in (2, 3):
        print(install_trust(Path(args[1]), {"--yes": "yes", "--no": "no"}.get(args[2]) if len(args) == 3 else None))
    elif args[:1] == ["question"] and len(args) == 2:
        print(question(Path(args[1])))
    elif args[:1] == ["skipped"] and len(args) == 2:
        print(skipped(Path(args[1])))
    elif args == ["undo"]:
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
        print("usage: claude_changes.py trust <tree> [--yes | --no] | question <tree> | skipped <tree> | undo",
              file=sys.stderr)
        sys.exit(2)
