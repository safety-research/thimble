"""Anthropic's sandbox runtime (srt, npm @anthropic-ai/sandbox-runtime), installed with thimble in frontend/node_modules:
it confines a process with Seatbelt on macOS and bubblewrap on Linux. The notebook kernel (kernel_wrap, kernel_srt.mjs)
and a code ticket's box (ticket_box) run in it; this module finds the package and the Node that runs it. Stdlib only."""
from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

PACKAGE = ("frontend", "node_modules", "@anthropic-ai", "sandbox-runtime")  # under the install tree
NODE_MIN = (20, 11)  # the package's `engines`

NO_NODE = "Node is not installed, and thimble's sandbox runtime needs Node {want} or later"
OLD_NODE = "Node {have} is too old for thimble's sandbox runtime, which needs Node {want} or later"
NO_PACKAGE = ("thimble's sandbox runtime (npm @anthropic-ai/sandbox-runtime) is not installed in {where}; run the "
              "installer again")


def node() -> str | None:
    """The `node` that runs srt: the one on PATH."""
    return shutil.which("node")


def package(root: Path) -> Path | None:
    """srt's package folder in the install tree at `root`; None when it is not installed."""
    p = root.joinpath(*PACKAGE)
    return p if (p / "dist" / "index.js").is_file() and (p / "dist" / "cli.js").is_file() else None


def node_version(exe: str) -> tuple[int, ...] | None:
    try:
        out = subprocess.run([exe, "--version"], capture_output=True, text=True, timeout=10).stdout.strip()
        return tuple(int(x) for x in out.lstrip("v").split(".")[:2])
    except (OSError, subprocess.SubprocessError, ValueError):
        return None


def missing(root: Path, exe: str | None) -> str:
    """Why srt can't run from the install tree at `root` with Node `exe`, '' when Node and the package are there."""
    want = ".".join(map(str, NODE_MIN))
    if not exe:
        return NO_NODE.format(want=want)
    have = node_version(exe)
    if have is None or have < NODE_MIN:
        return OLD_NODE.format(have=".".join(map(str, have or ())) or "?", want=want)
    if package(root) is None:
        return NO_PACKAGE.format(where=root.joinpath(*PACKAGE))
    return ""
