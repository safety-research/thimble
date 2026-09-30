"""A code ticket's box: the server runs the ticket's checks and its preview server in Anthropic's sandbox runtime
(app/srt.py: Seatbelt on macOS, bubblewrap on Linux), through its `srt` command, so the code the dev agent edited runs in
a sandbox until the analyst allows the change into thimble's own code.

What a box allows (Box.settings):
  read     the system, minus the home folder, thimble's home, the Claude config folder, the live checkout, the live
           workspaces, the temp folders and where user data lives on the system (kernel_wrap.SRT_HIDDEN); of those,
           only the worktree, the ticket's cache folder, the Python and Node the checks run, the live checkout's venv
           and node_modules, and `reads` (the workspace's corpus). The worktree links to that venv and node_modules
           (LINKED), and nothing runs in the box once a link points elsewhere (link_problem): the session can change
           the links, so what the box may read is never taken from them
  write    the worktree and the cache folder (TMPDIR, HOME, the UI build, the preview server's home and workspace copy)
  network  none: srt's proxy refuses every host
  env      ENV_KEEP of the server's environment and the caller's names, so no key or login reaches the box
srt's own settings and sockets live in `host_tmp`, outside the box, where nothing inside can change them.

The preview server (Preview) opens no port inside the box. The host listens on 127.0.0.1 and passes each connection it
accepts over the server's stdin, a Unix socket (app/handoff_serve.py), so nothing in the box listens or connects, and on
macOS the Seatbelt profile needs no network rule at all.
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import os
import pwd
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Sequence

from . import cli, config, kernel_wrap, srt

ENV_KEEP = ("PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "USER", "LOGNAME", "TERM")
PROBE_S = 60.0
KILL_WAIT_S = 5.0
HEALTH_WAIT_S = 90.0

SRT_FAILED = "thimble's sandbox runtime could not start a sandbox: {why}"
LINKED = (Path("backend") / ".venv", Path("frontend") / "node_modules")  # the live checkout's, linked into a worktree
LINK_MOVED = ("the worktree's {link} no longer links to the live checkout's {link}, so thimble ran nothing from it in "
              "the sandbox")

_probe: dict[str, str] = {}  # problem()'s answer, probed once per process


def srt_argv() -> list[str] | None:
    """The command that runs srt: Node with the package's cli.js; None when either is missing."""
    node, package = srt.node(), srt.package(config.REPO_ROOT)
    return [node, str(package / "dist" / "cli.js")] if node and package else None


def problem(refresh: bool = False) -> str:
    """Why a box can't run here, '' when it can: Node, the package, and one sandboxed `true`. Probed once per process."""
    if "why" in _probe and not refresh:
        return _probe["why"]
    why = srt.missing(config.REPO_ROOT, srt.node())
    if not why:
        with tempfile.TemporaryDirectory(prefix="thimble-box-probe-") as d:
            root = Path(d)
            for sub in ("tree", "cache", "srt"):
                (root / sub).mkdir()
            box = Box(root / "tree", root / "cache", root / "srt")
            try:
                done = subprocess.run(box.argv(["true"]), cwd=str(box.tree), env=box.environ(), capture_output=True,
                                      text=True, timeout=PROBE_S, stdin=subprocess.DEVNULL)
                tail = (done.stderr or done.stdout).strip().splitlines()
                why = "" if done.returncode == 0 else SRT_FAILED.format(why=(tail[-1] if tail else f"exit {done.returncode}"))
            except (OSError, subprocess.SubprocessError) as e:
                why = SRT_FAILED.format(why=f"{type(e).__name__}: {e}")
    _probe["why"] = why
    return why


def works() -> bool:
    return not problem()


def _real(p: Path | str) -> Path:
    return Path(os.path.realpath(p))


def _under(p: Path, root: Path) -> bool:
    return p == root or root in p.parents


def denied_roots() -> list[Path]:
    """The folders a box can't read, but for what Box.settings lets back in (module note): the kernel's (kernel_wrap)
    and thimble's own. The home folder is HOME's and the account's, where the two differ."""
    system = "darwin" if sys.platform == "darwin" else "linux"
    roots = [Path.home(), Path(pwd.getpwuid(os.getuid()).pw_dir), cli.home(), config.claude_config_dir(),
             config.REPO_ROOT, config.WORKSPACES_DIR, config.DATA_DIR, Path("/tmp"), Path(tempfile.gettempdir()),
             *map(Path, kernel_wrap.SRT_HIDDEN[system])]
    out: list[Path] = []
    for r in roots:
        p = _real(r)
        if p != Path("/") and p.exists() and not any(_under(p, q) for q in out):
            out = [q for q in out if not _under(q, p)] + [p]
    return out


def _runtime_reads(live: Path) -> list[Path]:
    """What the checks run from outside the worktree, all from the live checkout `live`: its venv and node_modules, the
    venv's Python installation (each folder on the way to the interpreter, and the one pyvenv.cfg names), Node's bin
    folder and srt's own package."""
    out = [_real(live / rel) for rel in LINKED if (live / rel).exists()]
    venv = live / "backend" / ".venv"
    home = _real(Path.home())
    too_wide = {home, home / ".local"}
    py = venv / "bin" / "python"
    if py.exists():
        prefixes = kernel_wrap.interpreter_dirs(py)
        with contextlib.suppress(OSError):
            for line in (venv / "pyvenv.cfg").read_text("utf-8").splitlines():
                key, _, value = line.partition("=")
                if key.strip() == "home" and value.strip():
                    prefixes += [Path(value.strip()).parent, _real(value.strip()).parent]
        out += [p for p in prefixes if p not in too_wide]
    node = srt.node()
    if node:
        out.append(_real(node).parent)
    package = srt.package(config.REPO_ROOT)
    if package:  # its seccomp helper runs inside the box
        out.append(_real(package))
    return out


def link_problem(tree: Path, live: Path) -> str:
    """'' while each of LINKED in the worktree `tree` is missing or leads to the live checkout's, else why not."""
    for rel in LINKED:
        link = tree / rel
        if (link.exists() or link.is_symlink()) and _real(link) != _real(live / rel):
            return LINK_MOVED.format(link=rel.as_posix())
    return ""


@dataclass
class Box:
    """One ticket's sandbox (module note). `reads` are extra read-only folders; `live` is the live checkout the
    worktree's venv and node_modules link to, config.REPO_ROOT when None."""
    tree: Path
    cache: Path
    host_tmp: Path
    reads: tuple[Path, ...] = ()
    live: Path | None = None

    @property
    def checkout(self) -> Path:
        return self.live or config.REPO_ROOT

    def link_problem(self) -> str:
        return link_problem(self.tree, self.checkout)

    def settings(self) -> dict[str, Any]:
        tree, cache = _real(self.tree), _real(self.cache)
        reads = [tree, cache, *_runtime_reads(self.checkout), *(_real(p) for p in self.reads if Path(p).exists())]
        return {
            "network": {"allowedDomains": [], "deniedDomains": []},
            "filesystem": {"denyRead": [str(p) for p in denied_roots()],
                           "allowRead": sorted({str(p) for p in reads}),
                           "allowWrite": [str(tree), str(cache)], "denyWrite": []},
        }

    def settings_file(self) -> Path:
        self.host_tmp.mkdir(parents=True, exist_ok=True)
        p = self.host_tmp / "srt-settings.json"
        p.write_text(json.dumps(self.settings(), indent=1), "utf-8")
        return p

    def argv(self, cmd: Sequence[str]) -> list[str]:
        argv = srt_argv()
        if argv is None:
            raise RuntimeError(srt.missing(config.REPO_ROOT, srt.node()) or "thimble's sandbox runtime is not installed")
        return [*argv, "--settings", str(self.settings_file()), "--", *cmd]

    def environ(self, extra: dict[str, str] | None = None) -> dict[str, str]:
        """The box's environment: ENV_KEEP, HOME and TMPDIR in the cache folder, and `extra`. srt reads TMPDIR for its
        own files (host_tmp) and CLAUDE_CODE_TMPDIR for the TMPDIR it gives the command."""
        for sub in ("home", "tmp"):
            (self.cache / sub).mkdir(parents=True, exist_ok=True)
        self.host_tmp.mkdir(parents=True, exist_ok=True)
        env = {k: os.environ[k] for k in ENV_KEEP if k in os.environ}
        env.setdefault("LANG", "C.UTF-8")
        return {**env, "HOME": str(self.cache / "home"), "TMPDIR": str(self.host_tmp),
                "CLAUDE_CODE_TMPDIR": str(self.cache / "tmp"), "PYTHONDONTWRITEBYTECODE": "1",
                "VITE_CACHE_DIR": str(self.cache / "vite"), "NO_COLOR": "1", **(extra or {})}


def _signal_group(proc: asyncio.subprocess.Process, sig: int) -> None:
    if proc.returncode is None:
        with contextlib.suppress(ProcessLookupError, PermissionError):
            os.killpg(proc.pid, sig)


async def _end_group(proc: asyncio.subprocess.Process) -> None:
    """SIGTERM to the process group, then SIGKILL after KILL_WAIT_S. srt removes the empty files it puts in the working
    directory for the box's run only when it gets to exit, so a SIGKILL first would leave them in the worktree."""
    _signal_group(proc, signal.SIGTERM)
    try:
        await asyncio.wait_for(proc.wait(), KILL_WAIT_S)
    except asyncio.TimeoutError:
        _signal_group(proc, signal.SIGKILL)
        await proc.wait()


async def run(box: Box, cmd: Sequence[str], *, cwd: Path, timeout: float,
              env: dict[str, str] | None = None) -> tuple[int, str]:
    """`cmd` in the box from `cwd`, its output joined: (exit code, output), -1 on a timeout, when srt can't start or when
    the worktree's links lead elsewhere (link_problem)."""
    if why := box.link_problem():
        return -1, why
    try:
        proc = await asyncio.create_subprocess_exec(*box.argv(cmd), cwd=str(cwd), env=box.environ(env),
                                                    stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE,
                                                    stderr=asyncio.subprocess.STDOUT, start_new_session=True)
    except (OSError, RuntimeError) as e:
        return -1, f"the sandbox runtime could not start: {e}"
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), timeout)
    except asyncio.TimeoutError:
        await _end_group(proc)
        return -1, f"timed out after {timeout:.0f} s"
    except asyncio.CancelledError:
        _signal_group(proc, signal.SIGTERM)
        asyncio.get_running_loop().call_later(KILL_WAIT_S, _signal_group, proc, signal.SIGKILL)
        raise
    return proc.returncode if proc.returncode is not None else -1, out.decode("utf-8", "replace")


def fetch(url: str, timeout: float = 5.0) -> bytes:
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return r.read()


def _health(url: str) -> bool:
    try:
        body = json.loads(fetch(f"{url}/api/health", 1.0) or b"{}")
    except Exception:  # noqa: BLE001
        return False
    return isinstance(body, dict) and bool(body.get("ok"))


class PreviewError(RuntimeError):
    """The preview server did not answer; the message ends with its log's tail."""


def seed_home(home: Path, port: int) -> None:
    """<home>/server.json for a server no supervisor starts: its address, a new token and the ui_key it held, in a
    folder only its owner reads, as cli.write_state writes the live server's, so a tool that reads it can write to that
    server (hook_auth.LocalWriteGuard). No pid, so no `thimble` command takes it for a server of its own."""
    config.private_dir(home)
    p = home / "server.json"
    try:
        held = json.loads(p.read_text("utf-8"))
    except (OSError, ValueError):
        held = {}
    held = held if isinstance(held, dict) else {}
    state = {"port": port, "api": f"http://127.0.0.1:{port}", "token": cli.new_token(),
             "ui_key": held.get("ui_key") or cli.new_token()}
    tmp = p.with_suffix(".json.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(json.dumps(state, indent=2) + "\n")
    tmp.replace(p)


class Preview:
    """The worktree's server in the box, on http://127.0.0.1:<port> through the host (module note). `port` 0, or a
    port in use, takes a free one. `env` is the server's environment inside the box; its THIMBLE_HOME gets a server.json
    (seed_home)."""

    def __init__(self, box: Box, env: dict[str, str], *, port: int = 0, log: Path | None = None) -> None:
        self.box, self.env, self.port = box, env, port
        self.log = log or box.cache / "preview.log"
        self.url = ""
        self.proc: asyncio.subprocess.Process | None = None
        self._listener: socket.socket | None = None
        self._ctl: socket.socket | None = None

    def _listen(self) -> socket.socket:
        for port in dict.fromkeys((self.port, 0)):
            s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                s.bind(("127.0.0.1", port))
            except OSError:
                s.close()
                continue
            s.listen(64)
            s.setblocking(False)
            return s
        raise PreviewError("no free port on 127.0.0.1")

    def _accept(self) -> None:
        assert self._listener is not None and self._ctl is not None
        while True:
            try:
                conn, _ = self._listener.accept()
            except (BlockingIOError, InterruptedError):
                return
            except OSError:
                return
            with conn:
                with contextlib.suppress(OSError):  # a server that stops reading loses the connection, never blocks us
                    socket.send_fds(self._ctl, [b"c"], [conn.fileno()])

    async def start(self, wait_s: float = HEALTH_WAIT_S) -> str:
        """Start it and wait for /api/health; the URL. PreviewError when it exits or does not answer in time, or when
        the worktree's links lead elsewhere (link_problem)."""
        if why := self.box.link_problem():
            raise PreviewError(why)
        self._listener = self._listen()
        self.port = self._listener.getsockname()[1]
        self.url = f"http://127.0.0.1:{self.port}"
        self._ctl, child = socket.socketpair()
        self._ctl.setblocking(False)
        py = self.box.tree / "backend" / ".venv" / "bin" / "python"
        self.log.parent.mkdir(parents=True, exist_ok=True)
        if self.env.get("THIMBLE_HOME"):
            seed_home(Path(self.env["THIMBLE_HOME"]), self.port)
        with self.log.open("ab") as out:
            try:
                self.proc = await asyncio.create_subprocess_exec(
                    *self.box.argv([str(py), "-m", "app.handoff_serve"]), cwd=str(self.box.tree / "backend"),
                    env=self.box.environ({**self.env, "THIMBLE_PORT": str(self.port)}), stdin=child, stdout=out,
                    stderr=asyncio.subprocess.STDOUT, start_new_session=True)
            except (OSError, RuntimeError) as e:
                child.close()
                await self.stop()
                raise PreviewError(f"the sandbox runtime could not start: {e}") from e
        child.close()
        asyncio.get_running_loop().add_reader(self._listener.fileno(), self._accept)
        started = time.monotonic()
        while time.monotonic() - started < wait_s:
            if self.proc.returncode is not None:
                break
            if await asyncio.to_thread(_health, self.url):
                return self.url
            with contextlib.suppress(asyncio.TimeoutError):
                await asyncio.wait_for(self.proc.wait(), 0.5)
        why = (f"it exited ({self.proc.returncode}) before it answered" if self.proc.returncode is not None else
               f"it did not answer /api/health within {wait_s:.0f} s")
        await self.stop()
        raise PreviewError(f"{why}\n{self.tail()}".strip())

    def tail(self, chars: int = 3000) -> str:
        try:
            return self.log.read_text("utf-8", errors="replace")[-chars:]
        except OSError:
            return ""

    async def stop(self) -> None:
        """Close the host's ends (the server exits on its own), then end its process group."""
        if self._listener is not None:
            with contextlib.suppress(Exception):
                asyncio.get_running_loop().remove_reader(self._listener.fileno())
            self._listener.close()
            self._listener = None
        if self._ctl is not None:
            self._ctl.close()
            self._ctl = None
        proc, self.proc = self.proc, None
        if proc is None or proc.returncode is not None:
            return
        with contextlib.suppress(asyncio.TimeoutError):
            await asyncio.wait_for(proc.wait(), KILL_WAIT_S)
            return
        await _end_group(proc)

    async def __aenter__(self) -> "Preview":
        await self.start()
        return self

    async def __aexit__(self, *_exc: Any) -> None:
        await self.stop()


def server_env(cache: Path) -> dict[str, str]:
    """The environment of a thimble server in the box: every folder of its own in the cache folder, no ticket runner,
    no view builds, no kernel wrapper (the box is one) and no API key."""
    return {"THIMBLE_SKIP_KEY": "1", "THIMBLE_HOME": str(cache / "server" / "home"),
            "THIMBLE_WORKSPACES_DIR": str(cache / "server" / "workspaces"),
            "THIMBLE_DATA_DIR": str(cache / "server" / "data"), "THIMBLE_DEV_DIR": str(cache / "server" / "dev"),
            "THIMBLE_DEV_STACK": "0", "THIMBLE_VIEW_BUILDS": "0", "THIMBLE_KERNEL_WRAP": "none"}


async def boot_check(box: Box, *, port: int = 0) -> dict[str, Any]:
    """The server-start gate in the box: the tree's server until /api/health answers, then stopped. {name, ok, tail}."""
    scratch = box.cache / "boot"
    shutil.rmtree(scratch, ignore_errors=True)
    started = time.monotonic()
    preview = Preview(box, server_env(scratch), port=port, log=scratch / "server.log")
    try:
        await preview.start()
    except PreviewError as e:
        return {"name": "server start", "ok": False, "tail": str(e)}
    finally:
        await preview.stop()
    return {"name": "server start", "ok": True, "tail": f"answered in {time.monotonic() - started:.1f} s"}

