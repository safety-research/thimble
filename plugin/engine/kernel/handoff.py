"""A `thimble` command in Claude Code's Bash sandbox, run by the plugin outside it.

Claude Code's Bash sandbox lets a command write only its working folder and Claude Code's own temp folder, so a command
there may not write thimble's records in $THIMBLE_HOME (the labels, the change feed, the cache). The plugin's hooks
(hooks/handoff.ts) give the session's commands THIMBLE_HANDOFF, a folder of the session's own in Claude Code's temp
folder, which the sandbox lets them write. A command that may not write $THIMBLE_HOME leaves itself there as <id>.ask
(its arguments, its folder, its stdin, and the variables that say which session and folder it is for, CARRIED) and
waits: while the Bash call runs, the plugin takes it (<id>.took) and runs it with its own bin/thimble and its own
environment outside the sandbox, which leaves its output (<id>.out, <id>.err) and its exit code (<id>.done) there. The
command prints them and ends with that code. One the plugin does not take within TAKE_S runs here, as it would with no
plugin.

    handed_off(argv) -> the exit code of the command the plugin ran, or None: it runs here
"""
from __future__ import annotations

import json
import os
import secrets
import sys
import time
from pathlib import Path

from .cli import stdin_text
from .store import thimble_home

TAKE_S = 5.0  # how long the command waits for the plugin to take it
WAIT_S = 0.05  # how often it looks
STDIN_S = 0.1  # how long it waits for stdin to hold input: a heredoc or a pipe holds it at once (cli.stdin_text)
# the variables a request carries, which the commands read to know which session and which folder they are for
# (store.py session_id, conversation_id, find_root); the plugin takes only these from it (hooks/handoff.ts CARRIED)
CARRIED = ("THIMBLE_SESSION", "THIMBLE_CONVERSATION", "THIMBLE_START", "THIMBLE_ROOT")


def _writable(p: Path) -> bool:
    """Whether this process may write in `p`, or, while `p` is missing, in the nearest folder above it."""
    while not p.exists() and p.parent != p:
        p = p.parent
    return os.access(p, os.W_OK)


def handed_off(argv: list[str]) -> int | None:
    """When this process may not write $THIMBLE_HOME and the plugin serves THIMBLE_HANDOFF: the command `argv`, run by
    the plugin, its output printed here; its exit code. None when it runs here."""
    box = os.environ.get("THIMBLE_HANDOFF") or ""
    if not box or not os.path.isdir(box) or not os.access(box, os.W_OK) or _writable(thimble_home()):
        return None
    at = os.path.join(box, f"{os.getpid()}-{secrets.token_hex(4)}")
    ask = {"argv": list(argv), "cwd": os.getcwd(), "stdin": stdin_text(STDIN_S),
           "env": {k: os.environ[k] for k in CARRIED if k in os.environ}}
    try:
        with open(f"{at}.part", "w", encoding="utf-8") as f:
            json.dump(ask, f)
        os.replace(f"{at}.part", f"{at}.ask")
    except OSError:
        return None
    end = time.monotonic() + TAKE_S
    while not os.path.exists(f"{at}.took"):
        if time.monotonic() > end:
            try:
                os.remove(f"{at}.ask")
            except FileNotFoundError:
                break  # the plugin took it just now
            return None
        time.sleep(WAIT_S)
    while not os.path.exists(f"{at}.done"):
        time.sleep(WAIT_S)
    for name, out in ((".out", sys.stdout), (".err", sys.stderr)):
        try:
            with open(f"{at}{name}", "rb") as f:
                out.buffer.write(f.read())
                out.buffer.flush()
        except BrokenPipeError:
            # a reader that stopped early (`thimble label NAME --csv | head`), as cli.main has it
            os.dup2(os.open(os.devnull, os.O_WRONLY), out.fileno())
        except OSError:
            pass
    try:
        with open(f"{at}.done", encoding="utf-8") as f:
            code = int(f.read().strip() or 1)
    except (OSError, ValueError):
        code = 1
    for name in (".took", ".out", ".err", ".done"):
        try:
            os.remove(f"{at}{name}")
        except OSError:
            pass
    return code
