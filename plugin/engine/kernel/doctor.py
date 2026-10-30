"""thimble doctor: a checklist, for a person in a shell, of what thimble needs. One line per part: ✓ when it works, ×
when it does not, with the step that fixes it on the line below. A fix that needs no one's choice it makes itself: the
card sandbox, when its own files are missing or broken, is installed again, as scripts/install.sh does (setup.mjs
--repair). It looks for a newer release as thimble update --check does, unless --offline."""
from __future__ import annotations

import json
import re
import shutil
import subprocess
from pathlib import Path
from typing import Any

from . import fixes as FX
from .store import thimble_home

NODE_MIN = (22, 18)  # the terminal plugin's, as scripts/install.sh and sandbox/setup.mjs name it
CLAUDE_CODE_MIN = (2, 1, 307)  # as scripts/install.sh, INSTALL.md and CI name it

Row = tuple[bool, str, str]  # works, what, and the fix ('' when it works)


def _run(argv: list[str], timeout: float = 60) -> subprocess.CompletedProcess | None:
    try:
        return subprocess.run(argv, capture_output=True, text=True, timeout=timeout, stdin=subprocess.DEVNULL)
    except (OSError, subprocess.TimeoutExpired):
        return None


def _numbers(version: str) -> tuple[int, ...]:
    """v22.20.0 → (22, 20, 0); 2.1.312 → (2, 1, 312); () when it names no version."""
    m = re.match(r"v?(\d+(?:\.\d+)*)", version.strip())
    return tuple(int(x) for x in m.group(1).split(".")) if m else ()


def _dotted(v: tuple[int, ...]) -> str:
    return ".".join(map(str, v))


def claude_code() -> list[Row]:
    """Claude Code and the thimble plugin in it."""
    claude = shutil.which(FX.claude()) or (FX.claude() if Path(FX.claude()).is_file() else "")
    p = _run([claude, "--version"], 30) if claude else None
    if not p or p.returncode != 0:
        return [(False, "Claude Code (the claude command) is not on PATH",
                 "Install it: https://claude.com/claude-code")]
    version = (p.stdout.split() or ["?"])[0]
    n = _numbers(version)
    rows = [(True, f"Claude Code {version}", "") if not n or n >= CLAUDE_CODE_MIN else
            (False, f"Claude Code {version} is older than {_dotted(CLAUDE_CODE_MIN)}, which thimble needs",
             "Update it with the package manager that installed it, or: claude update")]
    q = _run([claude, "plugin", "list", "--json"], 60)
    try:
        plugins = json.loads(q.stdout) if q and q.returncode == 0 else None
    except ValueError:
        plugins = None
    mine = [x for x in plugins or [] if isinstance(x, dict) and x.get("id") == "thimble@thimble"]
    if not isinstance(plugins, list):
        rows.append((False, "Claude Code did not list its plugins", "See why: claude plugin list"))
    elif not mine:
        rows.append((False, "the thimble plugin is not installed in Claude Code",
                     "Install it: claude plugin install thimble@thimble" if FX._marketplace() else
                     "Install it: claude plugin marketplace add safety-research/thimble && claude plugin install "
                     "thimble@thimble"))
    elif mine[0].get("enabled") is False:
        rows.append((False, "the thimble plugin is off in Claude Code",
                     "Turn it on: claude plugin enable thimble@thimble"))
    else:
        rows.append((True, f"the thimble plugin is on in Claude Code ({mine[0].get('version') or 'installed'})", ""))
    return rows


def node() -> tuple[str, Row]:
    """The node on PATH, which the plugin's hooks and cards run on, and its row."""
    found = shutil.which("node") or ""
    fix = f"Install Node {_dotted(NODE_MIN)} or later, from your system's packages or https://nodejs.org"
    if not found:
        return "", (False, "Node is not on PATH, and thimble's plugin runs on it", fix)
    p = _run([found, "--version"], 30)
    version = (p.stdout.strip() if p and p.returncode == 0 else "").removeprefix("v")
    n = _numbers(version)
    if n and n < NODE_MIN:
        return found, (False, f"Node {version} is older than {_dotted(NODE_MIN)}, which thimble's plugin needs", fix)
    return found, (True, f"Node {version or '(version unknown)'}", "")


def sandbox(node_bin: str, plugin: Path) -> list[Row]:
    """The sandbox that cards run in: setup.mjs installs it when it is missing, draws a test card in it, and installs it
    again when its own files are broken (--repair)."""
    setup = plugin / "sandbox" / "setup.mjs"
    if not node_bin or not setup.is_file():
        return []
    p = _run([node_bin, str(setup), "--json", "--probe", "--repair"], 300)
    try:
        d: dict[str, Any] = json.loads((p.stdout or "").strip().splitlines()[-1]) if p else {}
    except (ValueError, IndexError):
        d = {}
    if d.get("ok"):
        return [(True, "the sandbox that cards run in works" + (", installed again" if d.get("repaired") else ""), "")]
    why = str(d.get("why") or "its check gave no answer").rstrip(".")
    return [(False, f"the sandbox that cards run in does not work: {why}",
             d.get("fix") or f"See its whole message: node {FX._tilde(str(setup))} --probe")]


def browser() -> Row:
    """The browser workbench's launcher: in the checkout scripts/install.sh installed it in, in this thimble's own
    checkout when its packages are installed, or on PATH."""
    for b in (FX._browser_seed(), FX.PLUGIN.parent / "browser"):
        if b and (b / "scripts" / "thimble-browser").is_file() and (b / "backend" / ".venv").is_dir():
            return True, f"the browser workbench: {FX._tilde(str(b / 'scripts' / 'thimble-browser'))}", ""
    found = shutil.which("thimble-browser")
    if found:
        return True, f"the browser workbench: {FX._tilde(found)}", ""
    return False, "the browser workbench is not installed", "Install it from a thimble checkout: scripts/install.sh"


def on_path() -> Row:
    """The thimble command in a shell: scripts/install.sh links it, and names the link in cli-link."""
    found = shutil.which("thimble")
    if found:
        return True, f"the thimble command is on PATH ({FX._tilde(found)})", ""
    try:
        link = Path((thimble_home() / "cli-link").read_text().strip())
    except OSError:
        link = None
    if link and link.exists():
        return (False, f"the thimble command ({FX._tilde(str(link))}) is not on PATH",
                "Add this line to your shell's startup file (~/.zshrc or ~/.bashrc): "
                f"export PATH=\"{link.parent}:$PATH\"")
    return False, "the thimble command is not on PATH", "Link it from a thimble checkout: scripts/install.sh"


def your_fixes() -> list[Row]:
    recs = [r for r in FX.records().values() if r.get("state") not in ("removed", "released", "merged")]
    if not recs:
        return []
    aside = sum(r.get("state") == "pending" for r in recs)
    if aside:
        return [(False, f"{aside} of your fixes {'is' if aside == 1 else 'are'} set aside since thimble update",
                 f"Bring {'it' if aside == 1 else 'them'} back: thimble reapply")]
    on = sum(r.get("state") == "on" for r in recs) if FX.is_on() else 0
    return [(True, f"your fixes: {on} on (thimble fixes lists them)", "")]


def newest() -> Row:
    """Whether a newer release is out (thimble update --check), or, on a dev install, a newer commit of the checkout."""
    try:
        r = FX.update(check=True)
    except FX.FixError as e:
        return False, "thimble could not look for a newer release", str(e)[:1].upper() + str(e)[1:]
    if not r["newer"]:
        return True, (r.get("line") or f"thimble {r['from']} is the newest release").rstrip("."), ""
    return (False, f"your checkout is at {r['to']}, and thimble runs {r['from']}" if r.get("dev") else
            f"thimble {r['to']} is out (you have {r['from']})", "Get it: thimble update")


def checks(offline: bool = False) -> list[Row]:
    rel = FX.release()
    # the plugin Claude Code loads: live, once the first fix pointed its marketplace there, else this one
    plugin = FX.live_dir() / "plugin" if rel.get("pointed") and (FX.live_dir() / ".git").exists() else FX.PLUGIN
    rows: list[Row] = [(True, f"thimble {FX.version_name() or '(version unknown)'}, the terminal plugin from "
                              f"{FX._tilde(str(plugin))}", "")]
    rows += claude_code()
    node_bin, row = node()
    rows += [row, *sandbox(node_bin, plugin), browser(), on_path(), *your_fixes()]
    if not offline:
        rows.append(newest())
    return rows


def cmd(a: Any) -> int:
    """thimble doctor [--offline]: the checklist; 1 when a part does not work."""
    c = FX.Paint()
    rows = checks(getattr(a, "offline", False))
    for ok, what, fix in rows:
        print(f"  {c('green', '✓') if ok else c('bold', '×')} {what}")
        if not ok:
            print(f"      {c('cmd', fix)}")
    return 0 if all(ok for ok, _, _ in rows) else 1
