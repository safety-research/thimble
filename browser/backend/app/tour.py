"""The product tour's first-launch state: tour.json in thimble's home, one offer for the person. Each dashboard the page
opens offers the tour until the analyst answers the offer, and the page records here that they did, whatever they chose,
so a page no one looked at (one opened as the server started) does not use the offer up; Settings replays the tour at
any time without reading this.

The answer is written in this server's home ($THIMBLE_HOME/tour.json: THIMBLE_HOME, else ~/.thimble) and read from each
of thimble's homes on this machine (homes): this server's, the browser workbench's (THIMBLE_BROWSER_HOME, else
~/.thimble-browser), where thimble-browser runs its server, and the terminal plugin's (THIMBLE_PLUGIN_HOME, else
~/.thimble), where a server started without thimble-browser runs (cli.home). So an answer given in a page of one counts
in the pages of the others.

GET /tour answers {"seen": bool}; POST /tour/seen records the answer. Nothing here touches Claude Code's files.
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


def homes() -> list[Path]:
    """thimble's homes on this machine, each once: this server's, the browser workbench's and the terminal plugin's
    (module note), read fresh from the environment."""
    env = os.environ.get
    named = (env("THIMBLE_HOME") or "~/.thimble", env("THIMBLE_BROWSER_HOME") or "~/.thimble-browser",
             env("THIMBLE_PLUGIN_HOME") or "~/.thimble")
    return list(dict.fromkeys(Path(h).expanduser() for h in named))


def _read(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text())
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def read() -> dict[str, Any]:
    """The state recorded in this server's home, {} when there is none or it does not parse."""
    return _read(state_file())


def seen() -> bool:
    """Whether the person answered the offer in a page of any of thimble's homes (homes)."""
    return any(_read(h / FILE).get("seen") for h in homes())


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
