"""The product tour's first-launch state: $THIMBLE_HOME/tour.json (THIMBLE_HOME, else ~/.thimble), one for every
workspace this install opens. The page offers the tour once, the first time the dashboard opens, and records here that
it did, whatever the analyst chose; Settings replays the tour at any time without reading this.

GET /tour answers {"seen": bool}; POST /tour/seen records the offer. Nothing here touches Claude Code's files.

The tour runs in a demo workspace, never over the analyst's own files (frontend lib/tourFrame). When no demo dataset
(`thimble demo`) or worked example (`thimble demo --examples`) is installed, POST /tour/workspace sets one up on the
spot from files every install ships, with no network: the worked example `timeline` (plugin/viewers/timeline, whose
records the tour's own examples come from), opened as `thimble demo --examples` opens it (demo_examples.open_example)
as the workspace example-timeline, on a copy of its sample in $THIMBLE_HOME/examples, with its view installed built.
Its sample labels are left for `thimble demo --examples`, which adds what is missing. A second call reuses the
workspace. It answers {"name": <workspace>}, or 500 when the example could not be set up.
"""
from __future__ import annotations

import json
import logging
import os
import shutil
import tempfile
import threading
import time
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException

log = logging.getLogger("thimble.tour")
router = APIRouter()

FILE = "tour.json"
EXAMPLE = "timeline"  # the worked example the tour sets up when no demo is installed (module note)
_setup = threading.Lock()


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


def tour_workspace() -> str:
    """The worked example EXAMPLE opened as a workspace (module note), made once and reused: its name."""
    from . import config, demo_examples, views  # noqa: PLC0415 — the server's modules, loaded only for the tour

    src = views.EXAMPLES_DIR / EXAMPLE
    with _setup:
        folder = state_file().parent / demo_examples.FOLDER / f"{demo_examples.PREFIX}{EXAMPLE}"
        if not folder.is_dir():
            config.private_dir(folder.parent)
            # copied beside its place and renamed into it, so a copy cut short is never taken for the sample
            tmp = folder.with_name(f".{folder.name}.copy-{os.getpid()}")
            shutil.rmtree(tmp, ignore_errors=True)
            shutil.copytree(src / "sample", tmp, symlinks=False)
            os.replace(tmp, folder)
        name = str(config.register_corpus(folder, exact=True)["name"])
        ws = config.workspace_dir(name)
        try:
            built = json.loads((ws / views.LOCAL_SUBDIR / views.VIEWS_SUBDIR / EXAMPLE / views.VIEW_JSON).read_text("utf-8"))
        except (OSError, ValueError):
            built = {}
        if not (isinstance(built, dict) and built.get("built")):
            views.install_view(ws, src, EXAMPLE)
    return name


@router.post("/tour/workspace")
def post_workspace() -> dict[str, str]:
    try:
        return {"name": tour_workspace()}
    except (OSError, ValueError) as e:
        log.warning("could not set up the tour's workspace: %s", e)
        raise HTTPException(500, f"the tour's example workspace could not be set up: {e}") from e
