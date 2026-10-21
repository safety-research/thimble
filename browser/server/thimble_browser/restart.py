"""Try a fix in thimble browser itself: restart this server from the fix's copy of thimble, and back to the release.

The terminal plugin turns a fix on by pointing Claude Code's marketplace at the copy (plugin/engine/kernel/fix.py,
`use`). thimble browser never does that: Try it on the page's fix line restarts this server, on the same port and with
the same arguments, from the copy's own browser/server, and the page reloads when the server answers again. The browser
stays signed in, because its sign-ins are kept in the browser's home (auth.py), which the copy shares. Undo restarts
it from the release.

The page: when the copy's browser/frontend is the same as the release's, the copy's server serves the release's built
page. When the fix changed it, Try it builds the copy's page first (vite, with the release's node_modules) into the
fix's folder, outside the copy, so the build adds nothing to the fix's diff.

While the server runs from a copy, RELEASE_ENV names the release's server folder (for Undo) and DIST_ENV the built page
it serves. A new `thimble-browser` starts from the release again.
"""
from __future__ import annotations

import asyncio
import filecmp
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

RELEASE_ENV = "THIMBLE_BROWSER_RELEASE"
DIST_ENV = "THIMBLE_BROWSER_DIST"
SERVER = Path(__file__).resolve().parents[1]
RUN: dict[str, Any] = {}  # __main__.main: {"argv": the server's arguments, "port": the port it listens on}
BUILD_S = 300.0
SKIP = {"node_modules", "dist", ".vite"}
# runs the server from the folder given first: -I keeps the folder this runs in (the person's files) off sys.path
BOOT = ("import sys; sys.path.insert(0, sys.argv.pop(1)); from thimble_browser.__main__ import main; "
        "sys.exit(main(sys.argv[1:]))")


class NotTried(RuntimeError):
    """The fix could not be loaded: the message is the one line the page shows."""


def release_server() -> Path:
    return Path(os.environ.get(RELEASE_ENV) or SERVER)


def running_slug(server: Path = SERVER) -> str | None:
    """The fix whose copy this server runs from, or None for the release."""
    from .kernel_fix import fix  # noqa: PLC0415

    home = Path(os.path.realpath(fix.fixes_home()))
    here = Path(os.path.realpath(server))
    if home not in here.parents:
        return None
    parts = here.relative_to(home).parts
    return parts[0] if len(parts) >= 2 and parts[1] == "worktree" else None


def _files(root: Path) -> dict[str, Path]:
    out = {}
    for d, dirs, files in os.walk(root):
        dirs[:] = [x for x in dirs if x not in SKIP]
        for f in files:
            p = Path(d) / f
            out[str(p.relative_to(root))] = p
    return out


def page_changed(copy_frontend: Path, release_frontend: Path) -> bool:
    """Whether the copy's page source differs from the release's (a file added, removed or changed)."""
    a, b = _files(copy_frontend), _files(release_frontend)
    if a.keys() != b.keys():
        return True
    return any(not filecmp.cmp(a[k], b[k], shallow=False) for k in a)


def build_page(copy_frontend: Path, release_frontend: Path, out: Path) -> None:
    """Build the copy's page into `out` with the release's packages: node_modules is linked in the fix's folder, the
    copy's parent, where Node finds it, so nothing is added to the copy."""
    vite = release_frontend / "node_modules" / ".bin" / "vite"
    if not vite.exists():
        raise NotTried("the fix changes the page, and thimble browser cannot build it: the page's packages are not "
                       f"installed in {release_frontend}. Run scripts/install.sh again, then Try it.")
    link = copy_frontend.parents[2] / "node_modules"
    if not link.exists():
        link.symlink_to(release_frontend / "node_modules", target_is_directory=True)
    try:
        r = subprocess.run([str(vite), "build", "--logLevel", "error", "--outDir", str(out), "--emptyOutDir"],
                           cwd=str(copy_frontend), capture_output=True, text=True, timeout=BUILD_S)
    except (OSError, subprocess.SubprocessError) as e:
        raise NotTried(f"the copy's page did not build ({e}). Ask Claude to fix the page, then Try it again.") from None
    if r.returncode != 0 or not (out / "index.html").is_file():
        last = (r.stderr or r.stdout or "").strip().splitlines()[-1:] or ["no output"]
        raise NotTried(f"the copy's page did not build: {last[0][:300]}. Ask Claude to fix the page, then Try it again.")


def page_for(copy: Path, release_server_dir: Path, fix_dir: Path) -> Path:
    """The built page the copy's server serves: the release's own when the copy's page source is the same."""
    copy_frontend = copy / "browser" / "frontend"
    release_frontend = release_server_dir.parent / "frontend"
    if not copy_frontend.is_dir() or not page_changed(copy_frontend, release_frontend):
        return release_frontend / "dist"
    out = fix_dir / "page"
    build_page(copy_frontend, release_frontend, out)
    return out


def argv_for(server: Path) -> list[str]:
    """The command that starts this server again from `server`, on the same port, with no new browser window."""
    return [sys.executable, "-I", "-c", BOOT, str(server), *RUN.get("argv", []), "--port", str(RUN.get("port", 8000)),
            "--no-open"]


def env_for(changes: dict[str, str | None]) -> dict[str, str]:
    env = dict(os.environ)
    for k, v in changes.items():
        if v is None:
            env.pop(k, None)
        else:
            env[k] = v
    return env


def schedule(server: Path, changes: dict[str, str | None], delay: float = 0.5) -> None:
    """Replace this process with the server from `server`, after `delay` seconds, so that the reply goes out first."""
    if not RUN:
        raise NotTried("this server was not started by thimble-browser, so it cannot restart itself. Start it with "
                       "thimble-browser.")
    argv, env = argv_for(server), env_for(changes)
    sys.stdout.flush()
    sys.stderr.flush()
    asyncio.get_running_loop().call_later(delay, os.execve, argv[0], argv, env)


def try_fix(slug: str) -> dict[str, Any]:
    """Prepare the restart from the fix's copy: {server, changes, said}."""
    from .kernel_fix import fix  # noqa: PLC0415

    fx = fix.load(slug)
    wt = fx.get("worktree")
    if not wt or not (Path(wt) / "browser" / "server" / "thimble_browser").is_dir():
        raise NotTried(f"the fix {slug} has no copy of thimble browser to run")
    if running_slug() == slug:
        return {"server": None, "changes": {}, "said": f"thimble browser already runs your fix “{fx['title']}”."}
    rel = release_server()
    page = page_for(Path(wt), rel, fix.fix_dir(slug))
    return {"server": Path(wt) / "browser" / "server", "changes": {RELEASE_ENV: str(rel), DIST_ENV: str(page)},
            "said": f"Restarting thimble browser with your fix “{fx['title']}”. The page reloads when it is back."}


def undo_fix() -> dict[str, Any]:
    """Prepare the restart from the release: {server, changes, said}."""
    if not running_slug():
        return {"server": None, "changes": {}, "said": "thimble browser already runs the release."}
    return {"server": release_server(), "changes": {RELEASE_ENV: None, DIST_ENV: None},
            "said": "Restarting thimble browser without your fix. The page reloads when it is back."}
