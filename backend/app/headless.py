"""Whether the headless Chromium thimble drives can start: the card harness's (render.py, the backend's Playwright) and
the pages' (a view's checks and review, the screenshot tool and a video's frames: scripts/view_shot.mjs and
scripts/ui_shot.mjs, the frontend's Playwright). Which browser that is, the system's Chrome, Edge or Chromium or
Playwright's own, is thimble's config's `browser` (launch).

A launch that fails because the browser or its system libraries are missing stays failed for the rest of the server
run: the log warns once, and whatever needs that browser is skipped. The words here reach models, so they say what is
unavailable and never how to install it; `thimble doctor` names the commands."""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re

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


class Missing(RuntimeError):
    """The page could not be shot: the headless Chromium or its system libraries are missing."""


def why_missing(text: str) -> str:
    """NO_LIBRARIES or NOT_INSTALLED when a launch's error says the browser or its libraries are missing, else ''."""
    if _LIBRARIES_RE.search(text or ""):
        return NO_LIBRARIES
    return NOT_INSTALLED if _NOT_INSTALLED_RE.search(text or "") else ""


def mark_missing(kind: str, why: str) -> None:
    """`kind`'s browser cannot start for the rest of the server run, because `why`; the first time, one warning."""
    if kind not in _missing:
        log.warning("%s: %s, so %s until the server restarts", kind, why, SKIPPED[kind])
    _missing[kind] = why


def missing(kind: str) -> str:
    """Why `kind`'s browser cannot start in this server run, '' while nothing says so."""
    return _missing.get(kind, "")


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
