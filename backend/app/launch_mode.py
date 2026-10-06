"""The mode `thimble` starts a folder in: `browser` (thimble's server and the browser workspace) or `terminal` (Claude
Code alone, with thimble's plugin and the renderer plugin that draws thimble's work in the terminal, and no server, no
port and no browser). Not the permission mode of thimble's agents, which is app/modes.py.

    thimble mode                              this folder's mode, and where it comes from
    thimble mode browser | terminal           set this folder's mode; a folder inside it without its own takes it too
    thimble mode browser | terminal --default set the mode of every folder without a mode of its own
    thimble mode --unset [--default]          remove this folder's own mode (with --default: the default)

The store (STORE, in thimble's home; nothing is written in the folder): {"default": <mode> | null, "folders":
{<absolute folder>: <mode>}}. A folder takes its own entry, else the entry of the nearest folder above it, else the
default, else browser (resolve). Writes go through a lock beside the store and an atomic replace (_update).

The launcher resolves the mode at each start and writes it into the workspace's trusted/launch.json as `mode`
(cli.launch_record). Every other process of the session (the MCP shim, the hooks, the hooks module, the renderer,
`thimble state | act`) reads the session's mode from there (session_mode, current), not from the store, so a
`thimble mode` while a session runs takes effect at the next start. In terminal mode the launcher also puts ENV
(`terminal`), WS_ENV (the workspace folder) and THIMBLE_HOME into the session's environment and its --settings `env`.

Standard library only: the launcher runs this file with any python3 (`python3 -I launch_mode.py cli <cwd> [args]`),
without the tree's venv. The backend imports it as app.launch_mode; only `current` then uses app.config, to find the
workspace of a folder.
"""
from __future__ import annotations

import fcntl
import json
import os
import sys
import tempfile
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Callable, Iterator

MODES = ("browser", "terminal")
BROWSER, TERMINAL = MODES
BUILT_IN = BROWSER  # the mode of a folder with no entry and no default
STORE = "launch-modes.json"  # in thimble's home
ENV = "THIMBLE_MODE"  # `terminal` in a session the launcher started in terminal mode
WS_ENV = "THIMBLE_WS"  # the workspace folder of a session the launcher started in terminal mode
LAUNCH = "trusted/launch.json"  # in the workspace (cli.LAUNCH_FILE): the launch's record, with its `mode`
DEFAULT = "default"  # resolve's source when the default decides
BUILT_IN_SOURCE = "built-in"  # resolve's source when nothing is set
LOCK_WAIT_S = 5.0


def home() -> Path:
    """thimble's home: THIMBLE_HOME, else ~/.thimble, read fresh (cli.home)."""
    return Path(os.environ.get("THIMBLE_HOME") or "~/.thimble").expanduser()


def store() -> Path:
    return home() / STORE


def _normal(data: Any) -> dict[str, Any]:
    """The store with both keys, every value a mode: what is not a mode is dropped."""
    data = data if isinstance(data, dict) else {}
    folders = data.get("folders")
    return {"default": data.get("default") if data.get("default") in MODES else None,
            "folders": {str(k): v for k, v in folders.items() if v in MODES} if isinstance(folders, dict) else {}}


def read() -> dict[str, Any]:
    """The store, with both keys present; empty when it is missing or cannot be read."""
    try:
        return _normal(json.loads(store().read_text("utf-8")))
    except (OSError, ValueError):
        return _normal({})


@contextmanager
def _locked() -> Iterator[None]:
    """An exclusive flock on <store>.lock for a read-modify-write of the store, waited for up to LOCK_WAIT_S; after
    that the write goes on without it, since the store holds only preferences."""
    import time  # noqa: PLC0415

    h = home()
    h.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd = os.open(str(h / f"{STORE}.lock"), os.O_RDWR | os.O_CREAT, 0o600)
    try:
        end = time.monotonic() + LOCK_WAIT_S
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except OSError:
                if time.monotonic() > end:
                    break
                time.sleep(0.02)
        yield
    finally:
        os.close(fd)  # closing the descriptor releases the lock


def _update(change: Callable[[dict[str, Any]], Any]) -> Any:
    """Apply `change` to the store under the lock, re-read inside it, and write the store atomically when it changed;
    what `change` returned."""
    with _locked():
        data = read()
        before = json.dumps(data, sort_keys=True)
        out = change(data)
        if json.dumps(data, sort_keys=True) != before:
            fd, tmp = tempfile.mkstemp(dir=home(), prefix=".launch-modes.", suffix=".json")
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as f:
                    json.dump(data, f, indent=1, sort_keys=True)
                    f.write("\n")
                os.replace(tmp, store())
            finally:
                Path(tmp).unlink(missing_ok=True)
        return out


def folder(cwd: str | os.PathLike[str]) -> str:
    """The folder `cwd` as the store keys it: absolute, with links resolved."""
    return str(Path(cwd).expanduser().resolve())


def resolve(cwd: str | os.PathLike[str]) -> tuple[str, str]:
    """(mode, source) for the folder `cwd`: the source is the folder whose entry decides, DEFAULT or BUILT_IN_SOURCE."""
    data = read()
    here = Path(folder(cwd))
    for p in (here, *here.parents):
        m = data["folders"].get(str(p))
        if m:
            return m, str(p)
    if data["default"]:
        return data["default"], DEFAULT
    return BUILT_IN, BUILT_IN_SOURCE


def _check(mode: str) -> None:
    if mode not in MODES:
        raise ValueError(f"{mode!r} is not a mode ({', '.join(MODES)})")


def set_folder(cwd: str | os.PathLike[str], mode: str) -> str | None:
    """Set the folder `cwd`'s own mode; the own mode it replaced, None when it had none."""
    _check(mode)

    def change(data: dict[str, Any]) -> str | None:
        old = data["folders"].get(folder(cwd))
        data["folders"][folder(cwd)] = mode
        return old

    return _update(change)


def set_default(mode: str | None) -> str | None:
    """Set the default mode, or remove it with None; the default it replaced."""
    if mode is not None:
        _check(mode)

    def change(data: dict[str, Any]) -> str | None:
        old, data["default"] = data["default"], mode
        return old

    return _update(change)


def unset(cwd: str | os.PathLike[str]) -> str | None:
    """Remove the folder `cwd`'s own mode; the mode it had, None when it had none."""
    return _update(lambda data: data["folders"].pop(folder(cwd), None))


def session_mode(ws: str | os.PathLike[str] | None) -> str:
    """The mode the session in workspace folder `ws` was started in: launch.json's `mode`, else browser (no workspace,
    no launch.json, a launch from before modes, or a value that is not a mode)."""
    if not ws:
        return BROWSER
    try:
        data = json.loads((Path(ws) / LAUNCH).read_text("utf-8"))
    except (OSError, ValueError):
        return BROWSER
    mode = data.get("mode") if isinstance(data, dict) else None
    return mode if mode in MODES else BROWSER


def workspace_of(cwd: str | os.PathLike[str]) -> Path | None:
    """The workspace folder of the folder `cwd`: the corpus it is in (config.workspace_for_cwd), or the workspace whose
    folder holds it, such as an agent's work folder (config.workspace_for_folder). None when there is none, and when
    this file runs alone, without the backend."""
    try:
        from . import config  # noqa: PLC0415 — the backend's, absent when the launcher runs this file alone
    except ImportError:
        return None
    try:
        c = config.workspace_for_cwd(str(cwd)) or config.workspace_for_folder(cwd)
        return config.workspace_path(c) if c else None
    except (OSError, ValueError, RuntimeError):
        return None


def current(cwd: str | os.PathLike[str] | None = None) -> str:
    """The mode of the session this process belongs to: session_mode of the workspace of `cwd` (default: this
    process's folder) when that workspace has a launch.json, else of WS_ENV's workspace; browser when neither names
    one. The server, whose folder is no corpus and which has no WS_ENV, is always in browser mode."""
    if cwd is None:
        try:
            cwd = os.getcwd()
        except OSError:
            cwd = None
    ws = workspace_of(cwd) if cwd is not None else None
    if ws is None or not (ws / LAUNCH).is_file():
        named = os.environ.get(WS_ENV, "").strip()
        ws = Path(named) if named and Path(named).is_absolute() else None
    return session_mode(ws)


def source_text(cwd: str | os.PathLike[str], source: str) -> str:
    """Where resolve's `source` comes from, for the folder `cwd`, in words."""
    if source == DEFAULT:
        return "your default"
    if source == BUILT_IN_SOURCE:
        return "thimble's default"
    return "set for this folder" if source == folder(cwd) else f"set for {source}"


def describe(cwd: str | os.PathLike[str]) -> str:
    mode, source = resolve(cwd)
    return f"thimble: `thimble` in this folder starts in {mode} mode ({source_text(cwd, source)})."


NEXT_START = ("thimble: a change takes effect at the next `thimble`; a session that runs now keeps its mode until you "
              "quit it.")
USAGE = ("usage: thimble mode                               this folder's mode, and where it comes from\n"
         "       thimble mode browser | terminal            set this folder's mode\n"
         "       thimble mode browser | terminal --default  set the mode of every folder without its own\n"
         "       thimble mode --unset [--default]           remove this folder's own mode, or the default\n"
         "browser mode opens thimble's workspace in the browser; terminal mode shows it in Claude Code alone, with no "
         "server.")


def cli(argv: list[str], cwd: str) -> int:
    """`thimble mode …` (module note) for the folder `cwd`: what it changed, the mode the folder starts in now, and
    when a change takes effect. Exit 2, changing nothing, on a wrong argument."""
    words = [a for a in argv if not a.startswith("-")]
    flags = [a for a in argv if a.startswith("-")]
    if any(f in ("-h", "--help") for f in flags):
        print(USAGE)
        return 0
    default, drop = "--default" in flags, "--unset" in flags
    if (any(f not in ("--default", "--unset") for f in flags) or len(words) > 1 or len(flags) != len(set(flags))
            or (words and words[0] not in MODES) or (drop and words) or (default and not drop and not words)):
        print(USAGE, file=sys.stderr)
        return 2
    changed = False
    if drop and default:
        old = set_default(None)
        print(f"thimble: removed the default mode ({old})." if old else "thimble: no default mode is set.")
        changed = bool(old)
    elif drop:
        old = unset(cwd)
        print(f"thimble: removed this folder's own mode ({old})." if old else "thimble: this folder has no mode of its own.")
        changed = bool(old)
    elif default:
        old = set_default(words[0])
        print(f"thimble: folders without a mode of their own start in {words[0]} mode.")
        changed = old != words[0]
    elif words:
        changed = set_folder(cwd, words[0]) != words[0]
    print(describe(cwd))
    if changed:
        print(NEXT_START)
    return 0


if __name__ == "__main__":
    # `launch_mode.py get <cwd>`: the mode alone; `launch_mode.py cli <cwd> [args]`: thimble mode
    if len(sys.argv) >= 3 and sys.argv[1] == "get":
        print(resolve(sys.argv[2])[0])
        sys.exit(0)
    if len(sys.argv) >= 3 and sys.argv[1] == "cli":
        sys.exit(cli(sys.argv[3:], sys.argv[2]))
    print("usage: launch_mode.py get <cwd> | cli <cwd> [args]", file=sys.stderr)
    sys.exit(2)
