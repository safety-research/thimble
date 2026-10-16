"""Opening a page in the person's browser for `thimble open` (0.9.0 build spec 3.15): the redirect file that carries the
sign-in code (never argv), the detached opener, the snap, flatpak and VS Code fallbacks, and the remote cases (SSH, ET,
no display).

SCAFFOLD STUB (browser lane): nothing opens yet; open_url answers False and doctor_lines says so.
"""
from __future__ import annotations


def open_url(url: str) -> bool:
    """Open `url` in the person's browser, detached; whether an opener ran. The stub runs none."""
    return False


def doctor_lines() -> list[str]:
    """The doctor's lines on how a press opens the browser here."""
    return ["browser opener: not built yet (thimble open answers NOT_BUILT)"]
