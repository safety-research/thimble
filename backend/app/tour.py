"""The product tour's first-launch state: $THIMBLE_HOME/tour.json (THIMBLE_HOME, else ~/.thimble), one for every
workspace this install opens. The page offers the tour once, the first time the dashboard opens, and records here that
it did, whatever the analyst chose; Settings replays the tour at any time without reading this.

GET /tour answers {"seen": bool}; POST /tour/seen records the offer. Nothing here touches Claude Code's files.
"""
from __future__ import annotations

import json
import logging
import os
import tempfile
import time
from pathlib import Path
from typing import Any

from fastapi import APIRouter

log = logging.getLogger("thimble.tour")
router = APIRouter()

FILE = "tour.json"


def state_file() -> Path:
    """$THIMBLE_HOME/tour.json, read fresh from the environment so tests and scratch stacks can point it away."""
    return Path(os.environ.get("THIMBLE_HOME") or "~/.thimble").expanduser() / FILE


def read() -> dict[str, Any]:
    """The recorded state, {} when there is none or it does not parse."""
    try:
        data = json.loads(state_file().read_text())
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def seen() -> bool:
    return bool(read().get("seen"))


def mark_seen() -> None:
    """Record the offer, written whole through a temporary file so a reader never sees half of it."""
    path = state_file()
    path.parent.mkdir(parents=True, exist_ok=True)
    data = {**read(), "seen": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".tour-", suffix=".json")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(data, f)
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


@router.get("/tour")
def get_tour() -> dict[str, bool]:
    return {"seen": seen()}


@router.post("/tour/seen")
def post_seen() -> dict[str, bool]:
    try:
        mark_seen()
    except OSError as e:
        # the tour is offered again next time; the page goes on either way
        log.warning("could not record the tour in %s: %s", state_file(), e)
        return {"seen": False}
    return {"seen": True}
