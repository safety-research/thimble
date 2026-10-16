"""Turning thimble on in a Claude Code session (0.9.0 build spec 3.3, contracts C1, C2, C4 and C5): one activation that
registers the session's folder as a workspace, marks the folder and the session, and writes launch.json, the one writer
of that file.

    <home>/up/<sid>.active        C1: {cwd, ws, path, via, role, mod, at}, 0600; `mod` never goes back to false
    <home>/up/<sid>/listed.json   C4: {digest, count, names, at}, the shim's record of the tools it listed
    <ws>/trusted/launch.json      {session, pid, config_dir, via, transport, at, peers, moved} (write_launch)

    thimble activate --cwd DIR --session SID --via data|command|tool|launcher|press [--rekey-from OLD] [--mod] [--hook]
        --json      prints C2's JSON, {"ok": true, ...} or {"ok": false, "error": {code, message, fix}}; exit 0
    thimble guide ...      guide.py (C3)
    thimble features ...   features.py (C6)

load_thimble (C5) is the one tool the shim lists before thimble is on (LOAD_TOOL); a call runs tool_load, which
activates and answers the guide.

SCAFFOLD STUB (core lane): refuses $HOME, `/`, a folder above $HOME, THIMBLE_HOME and CLAUDE_CONFIG_DIR (not mount roots);
registers with cli.register_here, marks the folder (cli.mark_active), refreshes the extensions and writes roles.json
(cli.local_extensions, cli.write_roles), writes launch.json with `transport: "local"` (main, or a peer beside a live
main), the session marker and the session's guide marker. --rekey-from and --hook are read and not acted on.
"""
from __future__ import annotations

import contextlib
import fcntl
import hashlib
import json
import os
import sys
import tempfile
import time
from collections.abc import Iterator
from pathlib import Path
from typing import Any

VIAS = ("data", "command", "tool", "launcher", "press")
# C5: the tool the shim lists before thimble is on (model-visible: its name and description)
LOAD_TOOL = {
    "name": "load_thimble",
    "description": ("Turn on thimble in this session. thimble adds cards (tables, charts and plan cards that the terminal "
                    "draws), labels that a model applies to every record of a file, and checked citations. Call this "
                    "once before you make a card, a plan card or a label. It returns thimble's guidance, and thimble's "
                    "other tools load after it."),
    "input_schema": {"type": "object", "properties": {}},
}
LISTED_FILE = "listed.json"


def _home() -> Path:
    return Path(os.environ.get("THIMBLE_HOME") or "~/.thimble").expanduser()


def _name(sid: str) -> str:
    return "".join(ch for ch in str(sid or "") if ch.isalnum() or ch in "-_")


def marker_path(sid: str) -> Path:
    """<home>/up/<sid>.active, the session marker (C1)."""
    return _home() / "up" / f"{_name(sid)}.active"


def read_marker(sid: str) -> dict[str, Any]:
    """The session marker's record, {} when there is none."""
    try:
        got = json.loads(marker_path(sid).read_text("utf-8"))
    except (OSError, ValueError):
        return {}
    return got if isinstance(got, dict) else {}


def _write_private(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    os.chmod(path.parent, 0o700)
    fd, tmp = tempfile.mkstemp(prefix=".up.", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f)
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    finally:
        Path(tmp).unlink(missing_ok=True)


def _error(code: str, message: str, fix: str) -> dict[str, Any]:
    return {"ok": False, "error": {"code": code, "message": message, "fix": fix}}


def _refused(cwd: Path) -> dict[str, Any] | None:
    """C2's refusal of a folder, or None: $HOME, `/`, a folder above $HOME, THIMBLE_HOME or CLAUDE_CONFIG_DIR."""
    try:
        p = cwd.expanduser().resolve()
        home = Path.home().resolve()
    except (OSError, RuntimeError):
        return _error("IO", f"thimble could not read the folder {cwd}", "cd into the data folder and try again")
    fix = "cd into the data folder and start claude there"
    if p == Path(p.anchor):
        return _error("REFUSED_ROOT", "thimble does not open the file system's root", fix)
    if p == home:
        return _error("REFUSED_HOME", "thimble does not open your home folder", fix)
    if p in home.parents:
        return _error("REFUSED_BROAD", f"thimble does not open {p}, a folder above your home folder", fix)
    for env in ("THIMBLE_HOME", "CLAUDE_CONFIG_DIR"):
        other = os.environ.get(env)
        if other:
            with contextlib.suppress(OSError, RuntimeError):
                if p == Path(other).expanduser().resolve():
                    return _error("REFUSED_BROAD", f"thimble does not open its own folder {p} ({env})", fix)
    return None


@contextlib.contextmanager
def _flock(path: Path) -> Iterator[None]:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        os.close(fd)


def _alive(pid: Any) -> bool:
    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 1:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def write_launch(c: str, sid: str, *, role: str, transport: str, via: str) -> dict[str, Any]:
    """The one writer of `<ws>/trusted/launch.json`, read-modify-write under `<ws>/trusted/launch.lock`: as main, the
    session, its `claude` process and config folder, `via` and `transport`; as a peer, `sid` added to `peers`. The
    record after."""
    from . import cc_plugin, config, subagent_files  # noqa: PLC0415

    ws = config.workspace_dir(c)
    subagent_files.ensure(ws)
    path = ws / "trusted" / "launch.json"
    with _flock(ws / "trusted" / "launch.lock"):
        try:
            rec = json.loads(path.read_text("utf-8"))
        except (OSError, ValueError):
            rec = {}
        rec = rec if isinstance(rec, dict) else {}
        if role == "main":
            old = rec.get("session")
            moved = [s for s in (rec.get("moved") or []) if s != sid]
            if old and old != sid:
                moved.append(old)
            pid = cc_plugin.claude_pid()
            rec.update({"session": sid, "via": via, "transport": transport, "at": time.time(),
                        "config_dir": os.environ.get("CLAUDE_CONFIG_DIR", ""), "moved": moved,
                        "peers": [s for s in (rec.get("peers") or []) if s != sid]})
            if pid:
                rec["pid"] = pid
            else:
                rec.pop("pid", None)
        else:
            rec["peers"] = sorted({*(rec.get("peers") or []), sid})
        tmp = path.with_name(f".{path.name}.tmp")
        tmp.write_text(json.dumps(rec, indent=1) + "\n", "utf-8")
        os.replace(tmp, path)
    return rec


def take_main(c: str, sid: str, via: str) -> str | None:
    """Make `sid` workspace `c`'s main (a press, /thimble, the `thimble` command); the previous main, None when there
    was none or it was `sid`."""
    from . import config  # noqa: PLC0415

    try:
        old = json.loads((config.workspace_dir(c) / "trusted" / "launch.json").read_text("utf-8")).get("session")
    except (OSError, ValueError, AttributeError):
        old = None
    write_launch(c, sid, role="main", transport="local", via=via)
    return old if old and old != sid else None


def _role(c: str, sid: str) -> str:
    """main, unless launch.json names another session whose `claude` process is alive (then peer)."""
    from . import config  # noqa: PLC0415

    try:
        rec = json.loads((config.workspace_dir(c) / "trusted" / "launch.json").read_text("utf-8"))
    except (OSError, ValueError):
        return "main"
    other = rec.get("session") if isinstance(rec, dict) else None
    return "peer" if other and other != sid and _alive(rec.get("pid")) else "main"


def activate(cwd: str, sid: str, via: str, *, mod: bool = False) -> dict[str, Any]:
    """C2: thimble on for session `sid` in folder `cwd`, idempotent under `<home>/up/<sid>.lock`."""
    from . import cli, config, features, guide  # noqa: PLC0415

    if via not in VIAS:
        return _error("IO", f"--via takes {', '.join(VIAS)}", "pass one of them")
    if not _name(sid):
        return _error("IO", "thimble activate needs the session's id (--session)", "pass --session")
    folder = Path(cwd)
    if (why := _refused(folder)) is not None:
        return why
    with _flock(_home() / "up" / f"{_name(sid)}.lock"):
        before = read_marker(sid)
        with cli.server_dirs():
            known = config.workspace_for_cwd(str(folder))
            c = cli.register_here(folder)
            if not c:
                return _error("IO", f"thimble could not register {folder} as a workspace", "run thimble doctor")
            cli.mark_active(folder)
            if not before:
                cli.local_extensions(c)
                cli.write_roles(c)
            role = before.get("role") or _role(c, sid)
            if role == "main":
                write_launch(c, sid, role="main", transport="local", via=before.get("via") or via)
            else:
                write_launch(c, sid, role="peer", transport="local", via=via)
            path = str(config.workspace_dir(c))
        rec = {"cwd": str(folder.resolve()), "ws": c, "path": path, "via": before.get("via") or via, "role": role,
               "mod": bool(before.get("mod")) or mod, "at": before.get("at") or time.time()}
        _write_private(marker_path(sid), rec)
        guide.marker(sid)
    return {"ok": True, "session": sid, "ws": c, "path": path, "role": role, "took_over": None,
            "first_in_folder": known is None, "settings": features.settings(c)}


def tool_load(cwd: str, sid: str) -> str:
    """C5: a call of load_thimble: thimble on (`via: tool`), then the guide, marked sent here only when no mod has run
    activation in this session (the marker's `mod`). A refusal raises ValueError with C2's message and fix."""
    from . import guide  # noqa: PLC0415

    got = activate(cwd, sid, "tool")
    if not got.get("ok"):
        err = got.get("error") or {}
        raise ValueError(f"{err.get('message', 'thimble did not turn on')}. {err.get('fix', '')}".strip())
    text = guide.render(cwd, sid)
    if not read_marker(sid).get("mod"):
        guide.mark(cwd, sid)
    return text


def write_listed(sid: str, names: list[str]) -> None:
    """C4: the shim listed `names` for session `sid` (<home>/up/<sid>/listed.json). Never raises."""
    if not _name(sid):
        return
    names = sorted(names)
    rec = {"digest": hashlib.sha1("\n".join(names).encode()).hexdigest(), "count": len(names), "names": names,
           "at": time.time()}
    with contextlib.suppress(OSError):
        _write_private(_home() / "up" / _name(sid) / LISTED_FILE, rec)


def _flag(argv: list[str], name: str) -> str | None:
    if name in argv:
        i = argv.index(name)
        return argv[i + 1] if i + 1 < len(argv) else None
    return None


def main(argv: list[str]) -> int:
    """`activate …`, `guide …` or `features …` (module note): JSON on stdout, exit 0."""
    if not argv or argv[0] not in ("activate", "guide", "features"):
        sys.stdout.write(json.dumps({"error": "usage: thimble activate|guide|features ..."}) + "\n")
        return 0
    verb, rest = argv[0], argv[1:]
    if verb == "guide":
        from . import guide  # noqa: PLC0415

        return guide.main(rest)
    if verb == "features":
        from . import features  # noqa: PLC0415

        return features.main(rest)
    cwd = _flag(rest, "--cwd") or os.environ.get("THIMBLE_CALLER_CWD") or os.getcwd()
    sid = _flag(rest, "--session") or os.environ.get("CLAUDE_CODE_SESSION_ID") or ""
    via = _flag(rest, "--via") or "command"
    try:
        out = activate(cwd, sid, via, mod="--mod" in rest)
    except Exception as e:  # noqa: BLE001 — the caller reads JSON, never a traceback
        out = _error("IO", f"thimble could not turn on: {type(e).__name__}: {e}", "run thimble doctor")
    sys.stdout.write(json.dumps(out) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
