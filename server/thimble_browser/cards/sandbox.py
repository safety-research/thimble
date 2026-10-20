"""Runs a card's code (runner.py) in a sandbox and returns what it printed.

The sandbox sees: the Python it runs on, read-only; the folder of files, read-only; a fresh empty /tmp. It does not see
the person's home folder, thimble browser's own folder, the network or the server's environment (no keys, no tokens).
It runs as its own process group and is killed when its time is up.

On Linux the sandbox is bubblewrap (bwrap). Where no sandbox is found, code does not run, unless the person started
the server with --no-sandbox, which the page then says on every card.
"""
from __future__ import annotations

import asyncio
import json
import os
import shutil
import sys
from pathlib import Path
from typing import Any

RUNNER = Path(__file__).resolve().with_name("runner.py")
GRACE_S = 10.0


def available() -> str | None:
    """The sandbox this machine has, or None."""
    if sys.platform.startswith("linux") and shutil.which("bwrap"):
        return "bwrap"
    return None


def _python_roots() -> list[str]:
    """The folders the runner's Python reads: its venv and the install the venv points at."""
    roots = {sys.prefix, sys.base_prefix, sys.exec_prefix, sys.base_exec_prefix,
             str(Path(sys.executable).resolve().parent.parent)}
    return sorted(r for r in roots if r and Path(r).exists())


def bwrap_argv(corpus: Path) -> list[str]:
    argv = ["bwrap", "--unshare-all", "--die-with-parent", "--new-session",
            "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp"]
    for d in ("/usr", "/bin", "/lib", "/lib64", "/lib32", "/etc/fonts", "/etc/alternatives", "/etc/ld.so.cache",
              "/etc/localtime"):
        if os.path.exists(d):
            argv += ["--ro-bind", d, d]
    for d in _python_roots():
        argv += ["--ro-bind", d, d]
    argv += ["--ro-bind", str(RUNNER.parent), str(RUNNER.parent)]
    argv += ["--ro-bind", str(corpus), str(corpus), "--chdir", str(corpus)]
    return argv


def child_env() -> dict[str, str]:
    """The runner's whole environment: nothing of the server's."""
    return {"PATH": "/usr/bin:/bin", "HOME": "/tmp", "LANG": "C.UTF-8", "TMPDIR": "/tmp",
            "MPLCONFIGDIR": "/tmp/mpl", "XDG_CACHE_HOME": "/tmp/cache", "IPYTHONDIR": "/tmp/ipython",
            "PYTHONDONTWRITEBYTECODE": "1", "MPLBACKEND": "Agg"}


async def run_code(code: str, corpus: Path, *, timeout: float = 60.0, unsandboxed: bool = False) -> dict[str, Any]:
    """{status, outputs, frame} for `code` run over `corpus`."""
    corpus = corpus.resolve()
    req = json.dumps({"code": code, "corpus": str(corpus), "workspace": "/tmp", "timeout": timeout})
    py = sys.executable
    kind = available()
    if kind == "bwrap":
        argv = [*bwrap_argv(corpus), py, "-I", str(RUNNER)]
    elif unsandboxed:
        argv = [py, "-I", str(RUNNER)]
    else:
        return {"status": "error", "frame": None, "outputs": [{"application/vnd.thimble.error+json": {
            "ename": "NoSandbox", "traceback": [],
            "evalue": "thimble browser runs card code only in a sandbox, and found none (on Linux it needs bwrap)"}}]}
    proc = await asyncio.create_subprocess_exec(*argv, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                                                stderr=asyncio.subprocess.PIPE, env=child_env(), cwd=str(corpus),
                                                start_new_session=True)
    try:
        out, err = await asyncio.wait_for(proc.communicate(req.encode()), timeout + GRACE_S)
    except asyncio.TimeoutError:
        with _quiet():
            os.killpg(proc.pid, 9)
        await proc.wait()
        return {"status": "error", "frame": None, "outputs": [{"application/vnd.thimble.error+json": {
            "ename": "TimeoutError", "evalue": f"the code did not stop after {timeout:g} s", "traceback": []}}]}
    try:
        return json.loads(out.decode() or "null") or {}
    except ValueError:
        tail = err.decode(errors="replace")[-1500:]
        return {"status": "error", "frame": None, "outputs": [{"application/vnd.thimble.error+json": {
            "ename": "RunnerFailed", "evalue": "the card's code could not run", "traceback": [tail]}}]}


class _quiet:
    def __enter__(self) -> None:
        return None

    def __exit__(self, *exc: Any) -> bool:
        return True
