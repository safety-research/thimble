"""Whether the headless Chromium thimble drives can start: the card harness's (render.py, the backend's Playwright) and
the pages' (a view's checks and review, and the screenshot tool: scripts/view_shot.mjs and scripts/ui_shot.mjs, the
frontend's Playwright). Which browser that is, the system's Chrome, Edge or Chromium or
Playwright's own, is thimble's config's `browser` (launch).

A launch that fails because the browser or its system libraries are missing stays failed for the rest of the server
run: the log warns once, with the command that fetches a browser that is not installed, and whatever needs that browser
is skipped. The words a launch leaves (missing) reach models, so they say what is unavailable and never how to install
it.

Where no system browser is found, the workbench uses Playwright's own headless Chromium, which thimble's install and
thimble update fetch, and thimble doctor checks: both ask `python -m app.headless [--fetch]` (check)."""
from __future__ import annotations

import asyncio
import importlib.util
import json
import logging
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Any, Mapping

log = logging.getLogger("thimble.headless")

HARNESS = "card harness"
PAGES = "views and screenshots"
NO_SCREENSHOTS = "screenshots are unavailable"
NOT_INSTALLED = "the headless Chromium is not installed"
NO_LIBRARIES = "this machine lacks the system libraries the headless Chromium needs"
NO_PLAYWRIGHT = "Playwright is not installed in backend/.venv"
SKIPPED = {HARNESS: "cards are not checked",
           PAGES: "views are checked without loading their page, and screenshots are unavailable"}
_LIBRARIES_RE = re.compile(r"missing dependencies|install-deps", re.I)
_NOT_INSTALLED_RE = re.compile(r"Executable doesn't exist|download new browsers", re.I)
_missing: dict[str, str] = {}
PROBE_TIMEOUT_S = 30.0
_plays: dict[str, bool | None] = {}
# the build of Chromium a Playwright launches headless, which `playwright install` fetches into Playwright's browsers
# folder (browsers_dir); the server's Playwright (the card harness) and the page's (views and screenshots) each pin one
CHROMIUM = "chromium-headless-shell"
FETCH_TIMEOUT_S = 900.0


class Missing(RuntimeError):
    """The page could not be shot: the headless Chromium or its system libraries are missing."""


def why_missing(text: str) -> str:
    """NO_LIBRARIES or NOT_INSTALLED when a launch's error says the browser or its libraries are missing, else ''."""
    if _LIBRARIES_RE.search(text or ""):
        return NO_LIBRARIES
    return NOT_INSTALLED if _NOT_INSTALLED_RE.search(text or "") else ""


def mark_missing(kind: str, why: str) -> None:
    """`kind`'s browser cannot start for the rest of the server run, because `why`; the first time, one warning, which
    names the command that fetches the browser when it is not installed."""
    if kind not in _missing:
        fix = f". Fetch it: {fetch_command(kind)}" if why == NOT_INSTALLED else ""
        log.warning("%s: %s, so %s until the server restarts%s", kind, why, SKIPPED[kind], fix)
    _missing[kind] = why


def missing(kind: str) -> str:
    """Why `kind`'s browser cannot start in this server run, '' while nothing says so."""
    return _missing.get(kind, "")


def browsers_dir(environ: Mapping[str, str] | None = None, platform_: str | None = None) -> Path:
    """The folder Playwright installs its browsers into, resolved as Playwright resolves it: PLAYWRIGHT_BROWSERS_PATH (or
    npm's config spellings; "0" is inside the package), else ms-playwright in the platform's cache folder."""
    env = os.environ if environ is None else environ
    plat = platform_ or sys.platform
    value = next((env[k] for k in ("PLAYWRIGHT_BROWSERS_PATH", "npm_config_playwright_browsers_path",
                                   "npm_package_config_playwright_browsers_path") if k in env), None)
    if value == "0":
        spec = importlib.util.find_spec("playwright")
        package = Path(spec.origin).parent if spec and spec.origin else Path.cwd()
        return package / "driver" / "package" / ".local-browsers"
    if value:
        return Path(env.get("INIT_CWD") or Path.cwd()) / value
    if plat == "darwin":
        cache = Path.home() / "Library" / "Caches"
    elif plat == "win32":
        cache = Path(env.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local")
    else:
        cache = Path(env.get("XDG_CACHE_HOME") or Path.home() / ".cache")
    return cache / "ms-playwright"


def fetched(browsers_json: Path) -> bool:
    """Whether the headless Chromium the Playwright with this browsers.json launches is in Playwright's browsers folder;
    with no readable browsers.json, whether any headless Chromium is."""
    browsers = browsers_dir()
    try:
        data = json.loads(browsers_json.read_text("utf-8"))
        rev = next(str(b["revision"]) for b in data["browsers"] if b.get("name") == CHROMIUM)
    except (OSError, ValueError, KeyError, TypeError, StopIteration):
        return any(browsers.glob("chromium_headless_shell-*"))
    return (browsers / f"chromium_headless_shell-{rev}").is_dir()


def browsers_json(kind: str) -> Path | None:
    """The browsers.json of `kind`'s Playwright, which names its build of Chromium: the server's (backend/.venv) for the
    card harness, the page's (frontend/node_modules) for views and screenshots. None when it is not installed."""
    from . import config  # noqa: PLC0415

    if kind == HARNESS:
        spec = importlib.util.find_spec("playwright")
        p = Path(spec.origin).parent / "driver" / "package" / "browsers.json" if spec and spec.origin else None
    else:
        p = config.REPO_ROOT / "frontend" / "node_modules" / "playwright-core" / "browsers.json"
    return p if p is not None and p.is_file() else None


def fetch_argv(kind: str) -> tuple[list[str], Path]:
    """The command that fetches `kind`'s build of Chromium into Playwright's browsers folder, and the folder it runs in."""
    from . import config  # noqa: PLC0415

    if kind == HARNESS:
        return [sys.executable, "-m", "playwright", "install", CHROMIUM], config.REPO_ROOT / "backend"
    return ["npx", "playwright", "install", CHROMIUM], config.REPO_ROOT / "frontend"


def fetch_command(kind: str) -> str:
    """fetch_argv as a person types it in a shell, with ~ for their home."""
    argv, cwd = fetch_argv(kind)

    def tilde(p: str) -> str:
        home = str(Path.home())
        return "~" + p[len(home):] if p.startswith(home + os.sep) else p

    if kind == HARNESS:
        return " ".join([tilde(argv[0]), *argv[1:]])
    return f"cd {tilde(str(cwd))} && {' '.join(argv)}"


def unfetched() -> list[str]:
    """The kinds whose browser is Playwright's own Chromium, as thimble's config and the browsers found choose it
    (userconf.browser: no system browser), and whose Playwright's build of it is not in Playwright's browsers folder."""
    from . import userconf  # noqa: PLC0415

    if userconf.browser()[0] != "bundled":
        return []
    return [k for k in (HARNESS, PAGES) if (j := browsers_json(k)) is not None and not fetched(j)]


def check(fetch: bool = False) -> dict[str, Any]:
    """Whether the workbench has the browser it draws cards and loads views in, as thimble's install, thimble update and
    thimble doctor ask it (`python -m app.headless [--fetch]`, plugin/engine/kernel/fixes.py browser_chromium). With
    `fetch`, Playwright first fetches each build of Chromium that is missing (unfetched). {"ok": True}, else {"ok":
    False, "why", "fix"}: what goes unchecked, and what the download said when it failed, and the commands that fetch
    the builds still missing."""
    error = ""
    for kind in unfetched() if fetch else []:
        argv, cwd = fetch_argv(kind)
        try:
            p = subprocess.run(argv, cwd=cwd, capture_output=True, text=True, timeout=FETCH_TIMEOUT_S,
                               stdin=subprocess.DEVNULL)
        except FileNotFoundError:
            error = error or f"{argv[0]} is not installed"
            continue
        except subprocess.TimeoutExpired:
            error = error or f"it took longer than {int(FETCH_TIMEOUT_S)} s"
            continue
        if p.returncode and not error:
            said = [x.strip() for x in f"{p.stderr}\n{p.stdout}".splitlines() if x.strip()]
            # Playwright's first error line, on stderr, names the cause (connect ECONNREFUSED, a 404, no space left);
            # its last ones only say that the download failed
            error = next((x[len("Error: "):] for x in said if x.startswith("Error: ")), said[-1] if said else
                         f"{argv[0]} ended with {p.returncode}")
    kinds = unfetched()
    if not kinds:
        return {"ok": True}
    why = "no headless Chromium, so " + "; ".join(SKIPPED[k] for k in kinds)
    return {"ok": False, "why": why + (f" (its download failed: {error})" if error else ""),
            "fix": "Fetch it: " + " && ".join(fetch_command(k) for k in kinds)}


def launch(kind: str) -> str | None:
    """The browser `kind` starts by thimble's config (userconf.browser): the system browser's path, '' for Playwright's
    own Chromium; None, with `kind` marked missing, when the config turns it off or names a system browser that is not
    there."""
    from . import userconf  # noqa: PLC0415 — userconf imports config, which the importers of this module import

    which, what = userconf.browser()
    if which == "off":
        mark_missing(kind, what)
        return None
    return what


async def plays_recordings(path: str) -> bool | None:
    """Whether the pages' browser at `path` ('' for Playwright's own Chromium) plays H.264 video and AAC audio, which
    most screen recordings hold: scripts/media_probe.mjs, once per path in a server run. None when the probe could not
    tell."""
    if path in _plays:
        return _plays[path]
    from . import config, userconf  # noqa: PLC0415

    got: bool | None = None
    try:
        proc = await asyncio.create_subprocess_exec(
            "node", str(config.REPO_ROOT / "scripts" / "media_probe.mjs"), cwd=str(config.REPO_ROOT),
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
            env={**os.environ, **({userconf.BROWSER_ENV: path} if path else {})})
        try:
            out, _ = await asyncio.wait_for(proc.communicate(), PROBE_TIMEOUT_S)
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()
            out = b""
        ans = json.loads(out.decode("utf-8", "replace").strip().splitlines()[-1]) if out.strip() else None
        if isinstance(ans, dict):
            got = bool(ans.get("h264")) and bool(ans.get("aac"))
    except (OSError, ValueError) as e:
        log.info("the media probe of %s failed: %s", path or "Playwright's Chromium", e)
    _plays[path] = got
    return got


if __name__ == "__main__":
    # thimble's install, thimble update and thimble doctor: the answer is the last line of stdout
    print(json.dumps(check(fetch="--fetch" in sys.argv[1:])))
