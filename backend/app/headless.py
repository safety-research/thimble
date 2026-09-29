"""Whether the headless Chromium thimble drives can start: the card harness's (render.py, the backend's Playwright) and
the pages' (a view's checks and review, the screenshot tool and a video's frames: scripts/view_shot.mjs and
scripts/ui_shot.mjs, the frontend's Playwright).

A launch that fails because the browser or its system libraries are missing stays failed for the rest of the server
run: the log warns once, and whatever needs that browser is skipped. The words here reach models, so they say what is
unavailable and never how to install it; `thimble doctor` names the commands."""
from __future__ import annotations

import logging
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
