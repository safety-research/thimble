"""The thimble command's parts for a person in a shell: the browser workbench (thimble browser, thimble demo) and a
checklist of what works (thimble doctor)."""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

from . import fixes as FX


def browser_launcher() -> Path | None:
    """The thimble-browser to run: the checkout scripts/install.sh installed the workbench in (its launcher runs live's
    once thimble update put the workbench there), else this thimble's own when its packages are installed, else the one
    on PATH."""
    seed = FX._browser_seed()
    for b in (seed, FX.PLUGIN.parent / "browser"):
        if b and (b / "scripts" / "thimble-browser").is_file() and (b / "backend" / ".venv").is_dir():
            return b / "scripts" / "thimble-browser"
    found = shutil.which("thimble-browser")
    return Path(found) if found else None


def browser(what: str, args: list[str]) -> int:
    """thimble browser [FOLDER] runs thimble-browser; thimble demo [NAME...] runs thimble-browser --demo, the workbench's
    demo datasets."""
    if FX.in_claude_code() and what == "browser":
        print("thimble browser: run it in a shell, not inside Claude Code: it starts a server that runs until Ctrl-C",
              file=sys.stderr)
        return 1
    run = browser_launcher()
    if not run:
        print(f"thimble {what}: the browser workbench is not installed. In a thimble checkout, run scripts/install.sh "
              "(without --no-browser)", file=sys.stderr)
        return 1
    argv = [str(run), *(["--demo"] if what == "demo" else []), *args]
    try:
        os.execv(argv[0], argv)
    except OSError as e:
        print(f"thimble {what}: could not run {run} ({e.strerror})", file=sys.stderr)
        return 1
    return 0


def _run(argv: list[str], timeout: float = 60) -> subprocess.CompletedProcess | None:
    try:
        return subprocess.run(argv, capture_output=True, text=True, timeout=timeout, stdin=subprocess.DEVNULL)
    except (OSError, subprocess.TimeoutExpired):
        return None


def doctor(a: Any) -> int:
    """thimble doctor: one line per part, ✓ when it works, × with the one step that fixes it."""
    c = FX.Paint()
    rows: list[tuple[bool, str]] = []
    rel = FX.release()
    pointed = bool(rel.get("pointed")) and (FX.live_dir() / ".git").exists()
    here = FX.live_dir() / "plugin" if pointed else FX.PLUGIN
    version = FX.release_name(rel) if pointed else FX._version_at(FX.PLUGIN.parent, "HEAD") or "?"
    rows.append((True, f"thimble {version}, the terminal plugin from {FX._tilde(str(here))}"))
    claude = shutil.which(FX.claude()) or (FX.claude() if Path(FX.claude()).is_file() else "")
    p = _run([claude, "--version"], 30) if claude else None
    if p and p.returncode == 0:
        rows.append((True, f"Claude Code {p.stdout.split()[0] if p.stdout.split() else ''}".rstrip()))
        q = _run([claude, "plugin", "list", "--json"], 60)
        try:
            plugins = json.loads(q.stdout) if q and q.returncode == 0 else []
        except ValueError:
            plugins = []
        mine = [x for x in plugins if isinstance(x, dict) and x.get("id") == "thimble@thimble"]
        if not mine:
            rows.append((False, "the thimble plugin is not installed in Claude Code: run scripts/install.sh in a thimble "
                                "checkout"))
        elif mine[0].get("enabled") is False:
            rows.append((False, "the thimble plugin is off in Claude Code: claude plugin enable thimble@thimble"))
        else:
            rows.append((True, f"the thimble plugin is on in Claude Code ({mine[0].get('version') or 'installed'})"))
    else:
        rows.append((False, "Claude Code (the claude command) is not on PATH: install it from https://claude.com/claude-code"))
    node = shutil.which("node")
    setup = here / "sandbox" / "setup.mjs"
    if not node:
        rows.append((False, "Node is not on PATH: thimble's plugin needs Node 22.12 or later (https://nodejs.org)"))
    elif setup.is_file():
        p = _run([node, str(setup), "--json", "--probe"], 300)
        try:
            d = json.loads((p.stdout or "").strip().splitlines()[-1]) if p else {}
        except (ValueError, IndexError):
            d = {}
        if d.get("ok"):
            rows.append((True, "the sandbox that cards run in works"))
        else:
            rows.append((False, f"the sandbox that cards run in does not work: {d.get('why') or 'no answer'}"
                         + (f". {d['fix']}" if d.get("fix") else "")))
    b = browser_launcher()
    if b:
        rows.append((True, f"the browser workbench: thimble-browser ({FX._tilde(str(b.parent.parent))})"))
    else:
        rows.append((False, "the browser workbench is not installed: scripts/install.sh in a thimble checkout installs it"))
    on_path = shutil.which("thimble")
    if on_path:
        rows.append((True, f"the thimble command is on PATH ({FX._tilde(on_path)})"))
    else:
        rows.append((False, "the thimble command is not on PATH: add ~/.local/bin to PATH in your shell's startup file"))
    recs = FX.records() if (FX.home() / "fixes.jsonl").exists() else {}
    n_on = sum(r.get("state") == "on" for r in recs.values())
    aside = sum(r.get("state") == "pending" for r in recs.values())
    if aside:
        rows.append((False, f"{aside} of your fixes {'is' if aside == 1 else 'are'} set aside since thimble update: "
                            "thimble reapply brings them back"))
    elif recs:
        rows.append((True, f"your fixes: {n_on} on (thimble fixes lists them)"))
    if not getattr(a, "offline", False):
        try:
            u = FX.update(check=True)
            rows.append((not u["newer"], f"thimble {u['to']} is out (you have {u['from']}): thimble update" if u["newer"]
                         else f"thimble {u['from']} is the newest release"))
        except FX.FixError as e:
            rows.append((False, f"could not look for a newer release: {e}"))
    for ok, text in rows:
        print(f"  {c('green', '✓') if ok else c('bold', '×')} {text}")
    return 0 if all(ok for ok, _ in rows) else 1
