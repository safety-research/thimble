"""Facts about processes, portably: the command line, the parent, the working directory, liveness, this user's pids.

Linux answers from /proc; macOS has none, so every reader falls back to `ps` (POSIX options only) and `lsof -d cwd`.
Imports nothing heavy, since cli.py runs per hook call. Every reader returns "unknown" (an empty list, None, False)
rather than raising.
"""
from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

HAVE_PROC = Path("/proc/self/stat").is_file()  # Linux; tests set it False to exercise the ps/lsof path
TOOL_TIMEOUT_S = 5.0  # ps / lsof: a stuck one must not hang a stop


def _run(cmd: list[str]) -> str | None:
    """stdout of `cmd`; None when it could not run (missing, timed out) — distinct from "" (ran, no rows)."""
    if shutil.which(cmd[0]) is None:
        return None
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=TOOL_TIMEOUT_S, check=False).stdout
    except (OSError, subprocess.TimeoutExpired):
        return None


def _valid(pid: object) -> bool:
    return isinstance(pid, int) and not isinstance(pid, bool) and pid > 0


def _stat_fields(pid: int) -> list[str] | None:
    """Linux: the fields of /proc/<pid>/stat after "(comm) " — state, ppid, pgrp, session, ...; None when unreadable."""
    try:
        st = Path(f"/proc/{pid}/stat").read_text()
    except OSError:
        return None
    return st[st.rfind(")") + 2:].split()


def alive(pid: object) -> bool:
    """A live, non-zombie process. A process this user may not signal counts as alive, as does one whose state cannot be
    read after kill(pid, 0) succeeded."""
    if not _valid(pid):
        return False
    try:
        os.kill(pid, 0)  # type: ignore[arg-type]
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    if HAVE_PROC:
        fields = _stat_fields(pid)  # type: ignore[arg-type]
        return not fields or fields[0] not in ("Z", "X")
    out = _run(["ps", "-o", "stat=", "-p", str(pid)])
    if out is None:
        return True
    state = out.strip()
    return bool(state) and not state.startswith("Z")


def argv(pid: object) -> list[str]:
    """The process's command line as arguments; [] when gone or unreadable. Without /proc, `ps -o command=` output is
    split on whitespace: enough for the tokens callers look for, not a faithful argv."""
    if not _valid(pid):
        return []
    if HAVE_PROC:
        try:
            raw = Path(f"/proc/{pid}/cmdline").read_bytes()
        except OSError:
            return []
        return [a.decode("utf-8", "replace") for a in raw.split(b"\0") if a]
    return (_run(["ps", "-ww", "-o", "command=", "-p", str(pid)]) or "").split()


def cmdline(pid: object) -> str:
    return " ".join(argv(pid))


def environ(pid: object) -> dict[str, str] | None:
    """The environment the process was started with (/proc/<pid>/environ); None when it cannot be read (gone, another
    user's, or no /proc)."""
    if not _valid(pid) or not HAVE_PROC:
        return None
    try:
        raw = Path(f"/proc/{pid}/environ").read_bytes()
    except OSError:
        return None
    out: dict[str, str] = {}
    for entry in raw.split(b"\0"):
        name, eq, value = entry.partition(b"=")
        if eq and name:
            out[name.decode("utf-8", "replace")] = value.decode("utf-8", "replace")
    return out


def ppid(pid: object) -> int | None:
    """The parent of `pid`; None when it is gone or unreadable."""
    if not _valid(pid):
        return None
    if HAVE_PROC:
        fields = _stat_fields(pid)  # type: ignore[arg-type]
        parent = fields[1] if fields and len(fields) > 1 else ""
    else:
        parent = (_run(["ps", "-o", "ppid=", "-p", str(pid)]) or "").strip()
    return int(parent) if parent.isdigit() else None


def pgid(pid: object) -> int | None:
    """The process group of `pid`; None when it is gone."""
    if not _valid(pid):
        return None
    try:
        return os.getpgid(pid)  # type: ignore[arg-type]
    except (ProcessLookupError, PermissionError):
        return None


def cwd(pid: object) -> Path | None:
    """The process's working directory (resolved, as the kernel reports it); None when unknown — gone, another user's,
    or (without /proc) no lsof."""
    if not _valid(pid):
        return None
    if HAVE_PROC:
        try:
            return Path(os.readlink(f"/proc/{pid}/cwd"))
        except OSError:
            return None
    out = _run(["lsof", "-a", "-p", str(pid), "-d", "cwd", "-Fn"])
    for line in (out or "").splitlines():
        if line.startswith("n") and len(line) > 1:
            return Path(line[1:])
    return None


def pids() -> list[int]:
    """This user's processes, sorted."""
    uid = os.getuid()
    if HAVE_PROC:
        found: list[int] = []
        for entry in Path("/proc").iterdir():
            if not entry.name.isdigit():
                continue
            try:
                if entry.stat().st_uid == uid:
                    found.append(int(entry.name))
            except OSError:
                continue
        return sorted(found)
    found = []
    for line in (_run(["ps", "-A", "-o", "uid=,pid="]) or "").splitlines():
        parts = line.split()
        if len(parts) == 2 and parts[0].isdigit() and parts[1].isdigit() and int(parts[0]) == uid:
            found.append(int(parts[1]))
    return sorted(found)


def parents() -> dict[int, int]:
    """{pid: parent pid} of this user's live processes, in one pass: /proc, or a single `ps` (one per process is slow on
    macOS)."""
    if HAVE_PROC:
        return {p: q for p in pids() if (q := ppid(p)) is not None}
    uid = os.getuid()
    found: dict[int, int] = {}
    for line in (_run(["ps", "-A", "-o", "uid=,pid=,ppid="]) or "").splitlines():
        parts = line.split()
        if len(parts) == 3 and all(x.isdigit() for x in parts) and int(parts[0]) == uid:
            found[int(parts[1])] = int(parts[2])
    return found


def descendants(pid: object) -> list[int]:
    """This user's processes below `pid` (its children, theirs, and so on), whatever process group or session each one
    is in; [] when `pid` has none or is gone. One pass over parents()."""
    if not _valid(pid):
        return []
    up = parents()
    out: list[int] = []
    level = {pid}
    while level:
        level = {p for p, parent in up.items() if parent in level and p not in out and p != pid}
        out.extend(sorted(level))
    return out


def commands() -> dict[int, list[str]]:
    """{pid: argv} of this user's live processes, in one pass: /proc, or a single `ps`. The argv has the caveat of
    argv()."""
    uid = os.getuid()
    if HAVE_PROC:
        return {pid: argv(pid) for pid in pids()}
    found: dict[int, list[str]] = {}
    for line in (_run(["ps", "-A", "-ww", "-o", "uid=,pid=,command="]) or "").splitlines():
        parts = line.split()
        if len(parts) >= 2 and parts[0].isdigit() and parts[1].isdigit() and int(parts[0]) == uid:
            found[int(parts[1])] = parts[2:]
    return found


def under(p: Path | str | None, root: Path | str | None) -> bool:
    """`p` is `root` or lies inside it, both resolved (a /proc cwd is already resolved; a recorded path may not be)."""
    if p is None or root is None:
        return False
    try:
        return Path(p).resolve().is_relative_to(Path(root).resolve())
    except (OSError, ValueError):
        return False


def listener(port: int) -> int | None:
    """The pid that listens on TCP `port`, by `lsof`, else `ss`; None when nothing listens, the tools are missing, or
    the listener belongs to another user (neither tool names another user's process to a normal user)."""
    out = _run(["lsof", "-nP", "-t", f"-iTCP:{int(port)}", "-sTCP:LISTEN"])
    for line in (out or "").split():
        if line.isdigit():
            return int(line)
    out = _run(["ss", "-ltnpH", f"sport = :{int(port)}"])
    for token in (out or "").replace(",", " ").split():
        if token.startswith("pid=") and token[4:].isdigit():
            return int(token[4:])
    return None


def version_of(pid: object) -> str | None:
    """The Claude Code version a `claude` process runs, read from its executable's path where the native installer
    names the file after the version (`~/.local/share/claude/versions/2.1.282`); None when that path says nothing, the
    process is gone, or there is no /proc."""
    if not _valid(pid) or not HAVE_PROC:
        return None
    try:
        name = Path(os.readlink(f"/proc/{pid}/exe")).name
    except OSError:
        return None
    parts = name.split(".")
    return name if len(parts) == 3 and all(p.isdigit() for p in parts) else None
