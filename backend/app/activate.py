"""Activation: thimble turned on for one Claude Code session in one folder, and the command line of thimble's session
files.

    thimble activate --cwd DIR --session SID --via data|command|tool|launcher|press [--rekey-from OLD [--reason
                     clear|resume]] [--mod] [--hook] [--json]
    thimble guide --cwd DIR --session SID [--mark | --unmark] [--if-owed]
    thimble features [--cwd DIR] [--json] [--set KEY=on|off …]

A session starts with thimble off: the plugin's MCP shim lists only load_thimble and nothing is written. activate()
turns it on, at the first data read the terminal mod sees, at /thimble, at a call of load_thimble, from the `thimble`
command or at a press. It refuses a folder that is too broad to be a corpus (refusal: the home folder, /, a folder above
the home folder, thimble's home, Claude Code's config folder, a mount root, or a path that resolves to one of them).
Otherwise, under the session's lock (`<home>/up/<sid>.lock`), it registers the folder as a corpus (cli.register_here),
marks it active for the plugin's hooks (cli.mark_active), finds its extensions (cli.local_extensions), writes the hooks
module's roles file (cli.write_roles), records the session in launch.json (write_launch, as main, or as a peer beside
a live main), and writes the session's files under `<home>/up/` (contract C1):

    <sid>.active          {cwd, ws, path, via, role, mod, at}: the session marker, 0600. `mod` is true once an
                          activation ran with --mod (the terminal mod is present) and is never set back to false.
    <sid>/guide-marker    8 hex characters, 0600, made at activation: the guide's lead line names it (guide.py)
    <sid>/guide.json      {digest, at}: the guide as last sent (guide.mark)
    <sid>/listed.json     {digest, count, names, at}: the tools the shim last listed (write_listed, contract C4)

A second activation of the same session is cheap and changes nothing but `mod` (from false to true). --rekey-from
copies an earlier session's files to a new session id after /clear or /resume (rekey): for /clear the guide is owed
again under a new marker, for /resume both stay.

launch.json (`<ws>/trusted/launch.json`) has one writer, write_launch, under `<ws>/trusted/launch.lock`:
{session, pid, config_dir, via, transport, at, peers, moved}, every other field it held kept. A new main runs on the
local transport until the press (runtime's local.transport), and so does main's session continued in a new `claude`
process after a quit (continue_main, which the MCP shim and a later activation run); take_main makes a session main in
place of a live one, which goes to `moved` and is told so by a notice. Until every reader takes `transport`,
write_launch also writes the 0.8.0 `mode` that matches it (LEGACY_MODE).

load_thimble (contract C5) is answered by the shim directly, through activate() and answer(); tool_load_handler serves
a call that reaches tools.call instead.
"""
from __future__ import annotations

import argparse
import contextlib
import fcntl
import hashlib
import json
import os
import secrets
import sys
import threading
import time
from pathlib import Path
from typing import Any, Callable, Iterator

VIAS = ("data", "command", "tool", "launcher", "press")
# the triggers that make a session main in place of a live one (take_main); a data read or a model's load_thimble beside
# a live main makes a peer
TAKES_MAIN = ("command", "launcher", "press")
MAIN, PEER = "main", "peer"
LOCAL, SERVER = "local", "server"
UP_DIR = "up"  # under thimble's home (userconf.UP_DIR)
MARKER_SUFFIX = ".active"  # cli.HOOK_MARKER_SUFFIX
LOCK_SUFFIX = ".lock"
GUIDE_MARKER = "guide-marker"  # userconf.GUIDE_MARKER
GUIDE_FILE = "guide.json"
LISTED_FILE = "listed.json"
LAUNCH_FILE = "trusted/launch.json"  # cli.LAUNCH_FILE
LAUNCH_LOCK = "trusted/launch.lock"
LOCK_WAIT_S = 20.0  # how long a caller waits for the session's lock before it fails with IO
# the 0.8.0 launch.json `mode` that matches each transport, written beside `transport` until the runtime lane's readers
# all read `transport` (module note)
LEGACY_MODE = {LOCAL: "terminal", SERVER: "browser"}
REKEY_REASONS = ("clear", "resume")
TAKEOVER_KEY = "takeover"  # the notice the session that lost main gets (notices.post)
TAKEOVER_TEXT = "thimble's browser follows the other session in this folder now."
# the notice's act, `/thimble` (take it back), is the terminal's: local.NOTICE_ACTS maps the key to it (runtime lane)

# the refusals, as {"code", "message", "fix"} (contract C2)
REFUSED_MESSAGE = ("thimble does not open this folder (your home folder, /, a folder above them or a mount root). cd "
                   "into the data folder and start claude there.")
REFUSED_FIX = "cd into the folder that holds your data and start claude there."
ERRORS = ("REFUSED_HOME", "REFUSED_ROOT", "REFUSED_BROAD", "IO", "NO_VENV")


class Refused(Exception):
    """activate() cannot turn thimble on here: `error` is the contract's {code, message, fix}."""

    def __init__(self, code: str, message: str, fix: str) -> None:
        super().__init__(message)
        self.error = {"code": code, "message": message, "fix": fix}


# --------------------------------------------------------------------------- the session's files


def home() -> Path:
    """thimble's home: THIMBLE_HOME, else ~/.thimble, read fresh."""
    return Path(os.environ.get("THIMBLE_HOME") or "~/.thimble").expanduser()


def safe_sid(sid: str | None) -> str:
    """The session id kept to letters, digits, `-` and `_`, as cli.hook_result_path names it; ValueError when none
    is left."""
    name = "".join(ch for ch in str(sid or "") if ch.isalnum() or ch in "-_")
    if not name:
        raise ValueError(f"no session id in {sid!r}")
    return name


def up_dir() -> Path:
    from . import config  # noqa: PLC0415

    return config.private_dir(config.private_dir(home()) / UP_DIR)


def marker_path(sid: str) -> Path:
    return home() / UP_DIR / f"{safe_sid(sid)}{MARKER_SUFFIX}"


def session_dir(sid: str, make: bool = False) -> Path:
    if make:
        from . import config  # noqa: PLC0415

        return config.private_dir(up_dir() / safe_sid(sid))
    return home() / UP_DIR / safe_sid(sid)


def _read_json(path: Path) -> dict[str, Any]:
    try:
        got = json.loads(path.read_text("utf-8"))
    except (OSError, ValueError):
        return {}
    return got if isinstance(got, dict) else {}


def write_private(path: Path, data: Any) -> None:
    """`data` as JSON (or a str as it is) at `path`, mode 0600, replaced in one step."""
    text = data if isinstance(data, str) else json.dumps(data, indent=1) + "\n"
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{secrets.token_hex(4)}.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


def read_marker(sid: str) -> dict[str, Any]:
    """The session marker (C1), {} when the session is not active."""
    try:
        return _read_json(marker_path(sid))
    except ValueError:
        return {}


def active(sid: str | None) -> bool:
    try:
        return bool(sid) and marker_path(str(sid)).is_file()
    except ValueError:
        return False


# the session locks this thread holds now: session_lock is reentrant within a thread, and two threads lock apart
_held = threading.local()


@contextlib.contextmanager
def session_lock(sid: str, wait_s: float = LOCK_WAIT_S) -> Iterator[None]:
    """An exclusive flock on `<home>/up/<sid>.lock` for the block, waited for up to `wait_s` (Refused IO after it).
    Reentrant: a block inside a block of the same session in this thread takes no second lock."""
    name = safe_sid(sid)
    held: set[str] = _held.__dict__.setdefault("names", set())
    if name in held:
        yield
        return
    path = up_dir() / f"{name}{LOCK_SUFFIX}"
    fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o600)
    try:
        until = time.monotonic() + wait_s
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= until:
                    raise Refused("IO", f"thimble could not take the lock {path} within {wait_s:.0f} s",
                                  "Try again; `thimble doctor` shows what holds it.") from None
                time.sleep(0.02)
        held.add(name)
        try:
            yield
        finally:
            held.discard(name)
            fcntl.flock(fd, fcntl.LOCK_UN)
    finally:
        os.close(fd)


def write_listed(sid: str, names: list[str]) -> dict[str, Any]:
    """`<home>/up/<sid>/listed.json` (contract C4) for the tools the shim listed: the sha1 of their sorted names, their
    count, the names and when. The record."""
    ordered = sorted(names)
    rec = {"digest": hashlib.sha1("\n".join(ordered).encode()).hexdigest(), "count": len(ordered), "names": ordered,
           "at": time.time()}
    write_private(session_dir(sid, make=True) / LISTED_FILE, rec)
    return rec


def read_listed(sid: str) -> dict[str, Any]:
    try:
        return _read_json(session_dir(sid) / LISTED_FILE)
    except ValueError:
        return {}


# --------------------------------------------------------------------------- refusals


def _real(p: str | os.PathLike[str] | None) -> str | None:
    if not p:
        return None
    try:
        return os.path.realpath(os.path.expanduser(str(p)))
    except (OSError, ValueError):
        return None


def mount_points(path: str = "/proc/mounts") -> set[str]:
    """The mount points /proc/mounts lists, each with its octal escapes undone; empty where there is no such file."""
    out: set[str] = set()
    try:
        lines = Path(path).read_text("utf-8", errors="replace").splitlines()
    except OSError:
        return out
    for line in lines:
        parts = line.split()
        if len(parts) >= 2:
            out.add(parts[1].encode("latin-1", "backslashreplace").decode("unicode_escape", "replace"))
    return out


def refusal(cwd: str | os.PathLike[str]) -> dict[str, str] | None:
    """Why `cwd` cannot be a corpus, as the contract's {code, message, fix}, or None when it can (module note): the home
    folder or thimble's home or Claude Code's config folder (REFUSED_HOME), / or a mount root (REFUSED_ROOT), a folder
    above the home folder (REFUSED_BROAD), each also through a link. Extends cli.refused, which refuses the first two."""
    real = _real(cwd)
    if real is None:
        return {"code": "IO", "message": f"thimble cannot read the folder {cwd}", "fix": REFUSED_FIX}
    home_dir = _real(Path.home())
    homes = {h for h in (home_dir, _real(home()), _real(os.environ.get("CLAUDE_CONFIG_DIR") or Path.home() / ".claude"))
             if h}
    if real in homes:
        return {"code": "REFUSED_HOME", "message": REFUSED_MESSAGE, "fix": REFUSED_FIX}
    if real == os.path.abspath(os.sep) or real in {_real(m) for m in mount_points()}:
        return {"code": "REFUSED_ROOT", "message": REFUSED_MESSAGE, "fix": REFUSED_FIX}
    if home_dir and home_dir.startswith(real.rstrip(os.sep) + os.sep):
        return {"code": "REFUSED_BROAD", "message": REFUSED_MESSAGE, "fix": REFUSED_FIX}
    from . import cli  # noqa: PLC0415 — cli's own rule, so the two never disagree

    if cli.refused(Path(real)):
        return {"code": "REFUSED_HOME", "message": REFUSED_MESSAGE, "fix": REFUSED_FIX}
    return None


# --------------------------------------------------------------------------- launch.json


def _ws(c: str) -> Path:
    from . import config  # noqa: PLC0415

    return config.workspace_dir(c)


def read_launch(c: str) -> dict[str, Any]:
    return _read_json(_ws(c) / LAUNCH_FILE)


def transport_of(rec: dict[str, Any], sid: str | None = None) -> str:
    """The transport launch.json gives the session `sid` (contract C11's rule, which runtime's local.transport
    implements): `server` only when `sid` (or no sid) is main and the record says server (a legacy `mode: browser`
    counts), and never for a peer or a session in `moved`."""
    if sid and (sid in (rec.get("peers") or []) or sid in (rec.get("moved") or [])):
        return LOCAL
    if sid and rec.get("session") and str(rec.get("session")) != sid:
        return LOCAL
    said = rec.get("transport") or {"browser": SERVER, "terminal": LOCAL}.get(str(rec.get("mode")))
    return SERVER if said == SERVER else LOCAL


def transport(c: str, sid: str | None = None) -> str:
    """The transport of session `sid` in workspace `c`: runtime's local.transport when it has one, else transport_of
    launch.json (the stub of contract C11)."""
    try:
        from . import local  # noqa: PLC0415

        own = getattr(local, "transport", None)
        if callable(own):
            return str(own(c, sid))
    except ImportError:
        pass
    return transport_of(read_launch(c), sid)


@contextlib.contextmanager
def _launch_locked(c: str) -> Iterator[Path]:
    ws = _ws(c)
    from . import subagent_files  # noqa: PLC0415 — standard library only

    subagent_files.ensure(ws)  # the trusted folder, in a workspace made before it
    path = ws / LAUNCH_LOCK
    fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        try:
            yield ws / LAUNCH_FILE
        finally:
            fcntl.flock(fd, fcntl.LOCK_UN)
    finally:
        os.close(fd)


def write_launch(c: str, sid: str, *, role: str, transport: str, via: str, pid: int | None = None,
                 config_dir: str | None = None, moved: str | None = None,
                 only_if: Callable[[dict[str, Any]], bool] | None = None) -> dict[str, Any] | None:
    """launch.json of workspace `c` changed for session `sid`, read and written under `<ws>/trusted/launch.lock`; the
    one writer of the file (module note). As main: `session`, `pid` (main's `claude`, cc_plugin.claude_pid, unless
    given), `config_dir`, `via`, `transport` and `at` are the session's, `sid` leaves `peers` and `moved`, and `moved`
    names a session this one took main from. As a peer: `sid` joins `peers` and the rest stays. Every other field the
    file held is kept. With `only_if`, nothing is written unless it holds for the record the lock finds. Returns the
    record written, None when `only_if` kept it from being written."""
    if role not in (MAIN, PEER):
        raise ValueError(f"role {role!r}: one of {MAIN}, {PEER}")
    if transport not in (LOCAL, SERVER):
        raise ValueError(f"transport {transport!r}: one of {LOCAL}, {SERVER}")
    from .ledger import atomic_write_text  # noqa: PLC0415

    with _launch_locked(c) as path:
        rec = _read_json(path)
        if only_if is not None and not only_if(rec):
            return None
        peers =[p for p in rec.get("peers") or [] if isinstance(p, str)]
        gone = [p for p in rec.get("moved") or [] if isinstance(p, str)]
        if role == MAIN:
            if pid is None:
                from . import cc_plugin  # noqa: PLC0415

                pid = cc_plugin.claude_pid()
            rec.update({"session": sid, "via": via, "transport": transport, "at": time.time(),
                        "mode": LEGACY_MODE[transport]})
            if pid and pid > 1:
                rec["pid"] = int(pid)
            rec["config_dir"] = config_dir if config_dir is not None else os.environ.get("CLAUDE_CONFIG_DIR", "")
            peers = [p for p in peers if p != sid]
            gone = [p for p in gone if p != sid]
            if moved and moved != sid and moved not in gone:
                gone.append(moved)
        elif sid not in peers and sid != rec.get("session"):
            peers.append(sid)
        rec["peers"], rec["moved"] = peers, gone
        atomic_write_text(path, json.dumps(rec, indent=1) + "\n")
        return rec


def main_alive(c: str, rec: dict[str, Any] | None = None) -> bool:
    """Whether the session launch.json names as main runs now: its `claude` process runs and Claude Code's own record
    of that process names the session, or one it moved to (cli.live_launch, either way it reads a record)."""
    from . import cli  # noqa: PLC0415

    rec = read_launch(c) if rec is None else rec
    if not rec.get("session") or not rec.get("pid"):
        return False
    try:
        return cli.live_launch({**rec, "via": cli.VIA_SKILL}, c) or cli.live_launch(rec, c)
    except Exception:  # noqa: BLE001 — a record that cannot be checked is no live main
        return False


def continue_main(c: str, sid: str, pid: int | None = None) -> bool:
    """Main's session `sid` continued in a new `claude` process (`claude -c`, `claude --resume`, which keep its id; bug
    hunt H1): when launch.json names `sid` as main (followed through the moves --rekey recorded), the process it records
    no longer runs it, and the `claude` process `pid` (cc_plugin.claude_pid unless given) does, that process is main's
    from now on, on the local transport, as a new main starts (write_launch, with `at` now, from which a pass of the
    mirror reads a session it saw end). The server that followed the old process stopped with it, so the one-way switch
    to the server held only for that process; a press, or a signed-in browser on a running server
    (session.follow_browser), moves the session to the server again. True when it wrote launch.json."""
    from . import cc_plugin, cli, subagent_files  # noqa: PLC0415

    pid = cc_plugin.claude_pid() if pid is None else pid
    if not pid or pid <= 1:
        return False
    ws = _ws(c)
    config_dir = os.environ.get("CLAUDE_CONFIG_DIR", "")

    def continued(rec: dict[str, Any]) -> bool:
        named = str(rec.get("session") or "")
        if not named or rec.get("pid") == pid:
            return False
        if subagent_files.moved_to(subagent_files.read(ws), named) != sid or main_alive(c, rec):
            return False
        return cli.live_launch({"session": sid, "pid": pid, "config_dir": config_dir}, c)

    rec = read_launch(c)
    if not continued(rec):  # the common case, looked at without the lock
        return False
    done = write_launch(c, sid, role=MAIN, transport=LOCAL, via=str(rec.get("via") or "command"), pid=pid,
                        config_dir=config_dir, only_if=continued)
    if done is None:
        return False
    cli._log(f"activate: session {sid} of {c} continues in claude pid {pid}, on the local transport")
    return True


def take_main(c: str, sid: str, via: str) -> str | None:
    """Make session `sid` main of workspace `c` in place of a live main (a press, /thimble or the `thimble` command):
    the old main goes to `moved` (write_launch) and gets the TAKEOVER_KEY notice. The previous main's id, None when
    there was none or it was `sid`. The transport stays what the record had for main."""
    rec = read_launch(c)
    old = str(rec.get("session") or "") or None
    was = transport_of(rec)
    write_launch(c, sid, role=MAIN, transport=was, via=via, moved=old if old and old != sid else None)
    if old and old != sid:
        try:
            from . import notices  # noqa: PLC0415

            notices.post(c, kind="session", text=TAKEOVER_TEXT, key=TAKEOVER_KEY)
        except Exception as e:  # noqa: BLE001 — the takeover stands without its notice
            from . import cli  # noqa: PLC0415

            cli._log(f"activate: the takeover notice of {c} was not posted: {e}")
        return old
    return None


# --------------------------------------------------------------------------- activation


def _settings(c: str | None) -> dict[str, bool]:
    from . import features  # noqa: PLC0415

    return features.settings(c)


def _register(cwd: str) -> str:
    """cli.register_here and cli.mark_active for `cwd`, then the workspace's extensions found again and the hooks
    module's roles file written (refresh): in this process when the workspace has no roles file yet, else in a detached
    process (refresh_later), since both import the server's stack and the roles file of the last session serves until
    the new one is written. The workspace's name; Refused IO when the folder cannot be registered."""
    from . import cli, subagent_files  # noqa: PLC0415

    c = cli.register_here(Path(cwd))
    if not c:
        raise Refused("IO", f"thimble could not register {cwd} as a corpus", "`thimble doctor` says why.")
    cli.mark_active(cwd)
    if subagent_files.roles_path(_ws(c)).is_file():
        refresh_later(c)
    else:
        refresh(c)
    return c


def refresh(c: str) -> None:
    """The workspace's extensions found again (cli.local_extensions) and the hooks module's roles file written
    (cli.write_roles), as the 0.8.0 launcher did before main started. Never raises."""
    from . import cli  # noqa: PLC0415

    cli.local_extensions(c)
    cli.write_roles(c)


def refresh_later(c: str) -> None:
    """refresh in a detached process (`python -m app.activate refresh --ws <c>`), with no stdio and in a session of its
    own, so the activation returns at once. Never raises."""
    import subprocess  # noqa: PLC0415

    from . import cli, config  # noqa: PLC0415

    try:
        env = {**os.environ, "THIMBLE_DATA_DIR": str(config.DATA_DIR), "THIMBLE_WORKSPACES_DIR": str(config.WORKSPACES_DIR)}
        subprocess.Popen([sys.executable, "-m", "app.activate", "refresh", "--ws", c], cwd=str(config.REPO_ROOT / "backend"),
                         env=env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         start_new_session=True, close_fds=True)
    except OSError as e:
        cli._log(f"activate: the roles of {c} were not refreshed: {e}")


def _role_for(c: str, sid: str, via: str) -> tuple[str, str | None]:
    """(main or peer, the session that lost main) for a new activation of `sid` in workspace `c` (module note)."""
    rec = read_launch(c)
    main = str(rec.get("session") or "")
    if not main or main == sid or not main_alive(c, rec):
        return MAIN, None
    if via in TAKES_MAIN:
        return MAIN, main
    return PEER, None


def rekey(old: str, new: str, reason: str = "clear") -> bool:
    """Copy session `old`'s files to session `new` (module note): the marker (with `mod`), guide.json (emptied for
    clear) and the guide marker (a new one for clear). True when `old` was active."""
    if reason not in REKEY_REASONS:
        raise ValueError(f"reason {reason!r}: one of {', '.join(REKEY_REASONS)}")
    was = read_marker(old)
    if not was:
        return False
    from . import guide  # noqa: PLC0415

    write_private(marker_path(new), {**was, "at": time.time()})
    src, dst = session_dir(old), session_dir(new, make=True)
    for name in (GUIDE_MARKER, GUIDE_FILE):
        f = src / name
        if f.is_file() and not (dst / name).exists():
            write_private(dst / name, f.read_text("utf-8"))
    if reason == "clear":
        guide.reset(new)
    else:
        guide.marker(new)
    return True


def _answer(rec: dict[str, Any], sid: str, *, first: bool, took: str | None, c: str | None) -> dict[str, Any]:
    return {"ok": True, "session": sid, "ws": rec.get("ws"), "path": rec.get("path"), "role": rec.get("role", MAIN),
            "took_over": took, "first_in_folder": first, "settings": _settings(c)}


def activate(cwd: str | os.PathLike[str], sid: str, via: str, *, mod: bool = False, rekey_from: str | None = None,
             reason: str = "clear") -> dict[str, Any]:
    """Turn thimble on for session `sid` in the folder `cwd` (module note): the contract's answer (C2), {"ok": true,
    session, ws, path, role, took_over, first_in_folder, settings} or {"ok": false, "error": {code, message, fix}}.
    Idempotent under the session's lock: a session already active keeps its role and `via`, and takes `mod` true when
    this call has it."""
    if via not in VIAS:
        return {"ok": False, "error": {"code": "IO", "message": f"via {via!r} is not one of {', '.join(VIAS)}",
                                       "fix": "Pass one of them."}}
    try:
        sid = safe_sid(sid)
        cwd = str(cwd)
        if why := refusal(cwd):
            return {"ok": False, "error": why}
        from . import cli, config, guide  # noqa: PLC0415

        with session_lock(sid):
            if rekey_from and safe_sid(rekey_from) != sid and not read_marker(sid):
                rekey(safe_sid(rekey_from), sid, reason)
            was = read_marker(sid)
            if was and _real(was.get("cwd")) == _real(cwd) and was.get("ws"):
                if mod and not was.get("mod"):
                    was = {**was, "mod": True}
                    write_private(marker_path(sid), was)
                guide.marker(sid)
                try:  # a session continued in a new `claude` process (claude -c) is main there, locally
                    with cli.server_dirs():
                        continue_main(str(was["ws"]), sid)
                except Exception as e:  # noqa: BLE001 — the activation stands; the shim looks again
                    cli._log(f"activate: launch.json of {was['ws']} was not moved to this process: {e}")
                return _answer(was, sid, first=False, took=None, c=str(was["ws"]))
            with cli.server_dirs():
                first = config.workspace_for_cwd(str(Path(cwd).resolve())) is None
                c = _register(cwd)
                role, took = _role_for(c, sid, via)
                rec = read_launch(c)
                if role == MAIN:
                    if took:
                        took = take_main(c, sid, via)
                    write_launch(c, sid, role=MAIN, transport=transport_of(rec) if took else LOCAL, via=via)
                else:
                    write_launch(c, sid, role=PEER, transport=LOCAL, via=via)
                path = str(config.workspace_dir(c))
            marker = {"cwd": os.path.abspath(cwd), "ws": c, "path": path, "via": via, "role": role,
                      "mod": bool(mod or was.get("mod")), "at": time.time()}
            write_private(marker_path(sid), marker)
            guide.marker(sid)
            return _answer(marker, sid, first=first, took=took, c=c)
    except Refused as e:
        return {"ok": False, "error": e.error}
    except (OSError, ValueError) as e:
        return {"ok": False, "error": {"code": "IO", "message": f"thimble could not open this folder: {e}",
                                       "fix": "Try again; `thimble doctor` says more."}}


# --------------------------------------------------------------------------- load_thimble (C5)


def answer(cwd: str | os.PathLike[str], sid: str) -> str:
    """load_thimble's answer once the session is active: the guide (guide.render), marked sent here only when no mod
    ran an activation of this session (the marker has no `mod`); with the mod, the mod marks it when the row that
    carries it is stored (guide.py)."""
    from . import guide  # noqa: PLC0415

    text = guide.render(str(cwd), sid)
    if not read_marker(sid).get("mod"):
        guide.mark(str(cwd), sid)
    return text


def tool_load(cwd: str | os.PathLike[str], sid: str) -> str:
    """activate (via tool) and answer (contract C5). Refused, with the contract's error, when the folder is refused."""
    got = activate(cwd, sid, "tool")
    if not got.get("ok"):
        err = got.get("error") or {}
        raise Refused(str(err.get("code") or "IO"), str(err.get("message") or ""), str(err.get("fix") or ""))
    return answer(cwd, sid)


def refusal_text(error: dict[str, Any]) -> str:
    """A refusal as load_thimble's error result: its message and its fix."""
    return " ".join(x for x in (str(error.get("message") or ""), str(error.get("fix") or "")) if x)


async def tool_load_handler(ctx: Any, args: dict[str, Any]) -> Any:
    """load_thimble reached through tools.call (the shim answers it itself, contract C5): the guide of the call's
    workspace for the session CLAUDE_CODE_SESSION_ID names, else without a lead line."""
    from . import config, guide, tools  # noqa: PLC0415

    cwd = str(config.corpus_dir(ctx.c))
    sid = os.environ.get("CLAUDE_CODE_SESSION_ID") or ""
    if not sid:
        return tools.ok(guide.render(cwd))
    try:
        return tools.ok(tool_load(cwd, sid))
    except Refused as e:
        return tools.err(refusal_text(e.error))


# --------------------------------------------------------------------------- the command line


def _session_arg(value: str | None) -> str:
    return value or os.environ.get("CLAUDE_CODE_SESSION_ID") or os.environ.get("CLAUDE_SESSION_ID") or ""


def _cwd_arg(value: str | None) -> str:
    return value or os.environ.get("CLAUDE_PROJECT_DIR") or os.environ.get("THIMBLE_CALLER_CWD") or os.getcwd()


def _print(data: Any) -> None:
    sys.stdout.write(json.dumps(data) + "\n")


def cmd_activate(a: argparse.Namespace) -> int:
    sid = _session_arg(a.session)
    if not sid:
        _print({"ok": False, "error": {"code": "IO", "message": "no session id", "fix": "Pass --session."}})
        return 0
    got = activate(_cwd_arg(a.cwd), sid, a.via, mod=a.mod, rekey_from=a.rekey_from, reason=a.reason)
    if a.json or a.hook or not sys.stdout.isatty():
        _print(got)
    elif got.get("ok"):
        print(f"thimble is on in {got.get('path')} ({got.get('role')})")
    else:
        print(f"thimble: {refusal_text(got.get('error') or {})}")
    return 0


def cmd_guide(a: argparse.Namespace) -> int:
    from . import guide  # noqa: PLC0415

    sid = _session_arg(a.session)
    cwd = _cwd_arg(a.cwd)
    if not sid:
        if a.mark or a.unmark or a.if_owed:
            return 0
        sys.stdout.write(guide.render(cwd))
        return 0
    if a.unmark:
        guide.unmark(cwd, sid)
        return 0
    if a.if_owed and a.mark:
        text = guide.take_if_owed(cwd, sid)
        if text:
            sys.stdout.write(text)
        return 0
    if a.if_owed and not guide.owed(cwd, sid):
        return 0
    sys.stdout.write(guide.render(cwd, sid))
    if a.mark:
        guide.mark(cwd, sid)
    return 0


def cmd_refresh(a: argparse.Namespace) -> int:
    from . import cli  # noqa: PLC0415

    with cli.server_dirs():
        refresh(a.ws)
    return 0


def cmd_features(a: argparse.Namespace) -> int:
    from . import config, features, userconf  # noqa: PLC0415

    c = config.workspace_for_cwd(str(Path(a.cwd).resolve())) if a.cwd else None
    try:
        changes = {}
        for item in a.set or []:
            key, sep, word = item.partition("=")
            if not sep:
                raise features.FeatureError(f"--set {item!r}: write KEY=on or KEY=off")
            changes[key.strip()] = word.strip()
        if changes:
            features.set_settings(changes, "cli")
    except (features.FeatureError, userconf.ConfigError) as e:
        if a.json or not sys.stdout.isatty():
            _print({"error": str(e)})
        else:
            print(f"thimble features: {e}")
        return 1
    rep = features.report(c)
    if a.json or not sys.stdout.isatty():
        _print(rep)
    else:
        for key, on in rep["settings"].items():
            print(f"{key:<14} {'on' if on else 'off'}")
    return 0


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="thimble", description="thimble's session files")
    sub = p.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("activate", help="turn thimble on for a session in a folder")
    a.add_argument("--cwd")
    a.add_argument("--session")
    a.add_argument("--via", choices=VIAS, default="command")
    a.add_argument("--rekey-from", dest="rekey_from")
    a.add_argument("--reason", choices=REKEY_REASONS, default="clear")
    a.add_argument("--mod", action="store_true")
    a.add_argument("--hook", action="store_true")
    a.add_argument("--json", action="store_true")
    a.set_defaults(fn=cmd_activate)
    g = sub.add_parser("guide", help="print thimble's guidance for a session")
    g.add_argument("--cwd")
    g.add_argument("--session")
    marks = g.add_mutually_exclusive_group()
    marks.add_argument("--mark", action="store_true")
    marks.add_argument("--unmark", action="store_true")
    g.add_argument("--if-owed", dest="if_owed", action="store_true")
    g.set_defaults(fn=cmd_guide)
    f = sub.add_parser("features", help="read or set thimble's feature switches")
    f.add_argument("--cwd")
    f.add_argument("--json", action="store_true")
    f.add_argument("--set", action="append", metavar="KEY=on|off")
    f.set_defaults(fn=cmd_features)
    r = sub.add_parser("refresh", help=argparse.SUPPRESS)  # refresh_later's detached process
    r.add_argument("--ws", required=True)
    r.set_defaults(fn=cmd_refresh)
    return p


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    return int(args.fn(args) or 0)


if __name__ == "__main__":
    sys.exit(main())
