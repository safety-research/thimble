"""A `thimble` command in Claude Code's Bash sandbox, run by the plugin outside it.

Claude Code's Bash sandbox lets a command write only its working folder and Claude Code's own temp folder, so a command
there may not write thimble's records in $THIMBLE_HOME (the labels, the change feed, the cache). The plugin's hooks
(hooks/handoff.ts) give the session's commands THIMBLE_HANDOFF, a folder of the session's own in Claude Code's temp
folder, which the sandbox lets them write. A command that may not write $THIMBLE_HOME leaves itself there as <id>.ask
(its arguments, its folder, its stdin as the command reads it, and the variables that say which session and folder it
is for, CARRIED) and waits, touching <id>.live every BEAT_S, by which the plugin knows that it still waits: while the
Bash call runs, the plugin takes it (<id>.took) and runs it with its own bin/thimble and its own environment outside
the sandbox, which leaves its output (<id>.out, <id>.err) and its exit code (<id>.done) there. The command prints them
and ends with that code. One the plugin does not take within TAKE_S runs here, with its stdin, as it would with no
plugin; one it took that gives no result within RUN_S ends with an error that says so (GAVE_UP). However the command
ends, a signal too, its files go with it; when it is killed outright, the plugin sees its heartbeat stop, stops its run
and removes them.

    handed_off(argv) -> the exit code of the command the plugin ran, or None: it runs here
"""
from __future__ import annotations

import contextlib
import io
import json
import os
import secrets
import signal
import sys
import time
from pathlib import Path
from typing import Callable, Iterator

from .cli import stdin_text, stdin_wait
from .store import thimble_home

TAKE_S = 5.0  # how long the command waits for the plugin to take it
WAIT_S = 0.05  # how often it looks
BEAT_S = 0.25  # how often it touches <id>.live (hooks/handoff.ts FRESH_MS, STILL_LOOKS)
# how long it waits for the result of a run the plugin took: the plugin stops a run at 10 minutes and says so
# (handoff.ts RUN_MS); this, a little longer, is for when the plugin cannot (it reloaded, or its run died)
RUN_S = 630.0
# the variables a request carries, which the commands read to know which session and which folder they are for
# (store.py session_id, conversation_id, find_root); the plugin takes only these from it (hooks/handoff.ts CARRIED)
CARRIED = ("THIMBLE_SESSION", "THIMBLE_CONVERSATION", "THIMBLE_START", "THIMBLE_ROOT")
ENDS = (".live", ".part", ".ask", ".took", ".out", ".err", ".done")  # a request's files, by their ending
GAVE_UP = "thimble: no result came back from the plugin{within}, and it was stopped"


def _writable(p: Path) -> bool:
    """Whether this process may write in `p`, or, while `p` is missing, in the nearest folder above it."""
    while not p.exists() and p.parent != p:
        p = p.parent
    return os.access(p, os.W_OK)


@contextlib.contextmanager
def _files_go(at: str) -> Iterator[None]:
    """The request's files (`at` and an ending) go however the command ends: at its end, at an error, and at SIGTERM or
    SIGHUP (its Bash call was stopped), which end it as they would have, with 128 and the signal's number."""

    def end(signum: int, _frame: object) -> None:
        raise SystemExit(128 + signum)

    was = {}
    for s in (signal.SIGTERM, signal.SIGHUP):
        with contextlib.suppress(ValueError, OSError):  # (not the main thread)
            was[s] = signal.signal(s, end)
    try:
        yield
    finally:
        for name in ENDS:
            with contextlib.suppress(OSError):
                os.remove(f"{at}{name}")
        for s, h in was.items():
            signal.signal(s, signal.SIG_DFL if h is None else h)


def _heartbeat(live: str) -> Callable[[], None]:
    """A call that touches `live` when BEAT_S passed since it last did."""
    last = [time.monotonic()]

    def beat() -> None:
        now = time.monotonic()
        if now - last[0] >= BEAT_S:
            last[0] = now
            with contextlib.suppress(OSError):
                os.utime(live)

    return beat


def _here(wait: float, text: str) -> None:
    """The command runs here after all: the stdin read for it is its stdin again."""
    if wait:
        sys.stdin = io.StringIO(text)
    return None


def _result(at: str, beat: Callable[[], None]) -> int | str:
    """The exit code the plugin left in <id>.done, once it is there; "gone" when the run's files went without one (the
    plugin took the command for one whose heartbeat stopped), "late" after RUN_S."""
    end = time.monotonic() + RUN_S
    while True:
        try:
            with open(f"{at}.done", encoding="utf-8") as f:
                said = f.read().strip()
            if said.lstrip("-").isdigit():
                return int(said)
        except FileNotFoundError:
            if not os.path.exists(f"{at}.took"):
                return "gone"
        except OSError:
            pass
        if time.monotonic() > end:
            return "late"
        beat()
        time.sleep(WAIT_S)


def handed_off(argv: list[str]) -> int | None:
    """When this process may not write $THIMBLE_HOME and the plugin serves THIMBLE_HANDOFF: the command `argv`, run by
    the plugin, its output printed here; its exit code. None when it runs here."""
    box = os.environ.get("THIMBLE_HANDOFF") or ""
    if not box or not os.path.isdir(box) or not os.access(box, os.W_OK) or _writable(thimble_home()):
        return None
    at = os.path.join(box, f"{os.getpid()}-{secrets.token_hex(4)}")
    # stdin as the command reads it: as long as it waits for it (cli.stdin_wait), a slow pipe too; none when it reads none
    wait = stdin_wait(argv)
    text = stdin_text(wait) if wait else ""
    ask = {"argv": list(argv), "cwd": os.getcwd(), "stdin": text,
           "env": {k: os.environ[k] for k in CARRIED if k in os.environ}}
    with _files_go(at):
        try:
            # the heartbeat first: the plugin takes a request only while its command's heartbeat goes on
            with open(f"{at}.live", "w"):
                pass
            with open(f"{at}.part", "w", encoding="utf-8") as f:
                json.dump(ask, f)
            os.replace(f"{at}.part", f"{at}.ask")
        except OSError:
            return _here(wait, text)
        beat = _heartbeat(f"{at}.live")
        end = time.monotonic() + TAKE_S
        while not os.path.exists(f"{at}.took"):
            beat()
            if time.monotonic() > end:
                try:
                    os.remove(f"{at}.ask")
                except FileNotFoundError:
                    if os.path.exists(f"{at}.took"):
                        break  # the plugin took it just now
                return _here(wait, text)  # (or the plugin removed it, as one nobody waits for: it runs here all the same)
            time.sleep(WAIT_S)
        code = _result(at, beat)
        if not isinstance(code, int):
            within = " within 10 minutes, the most it may take" if code == "late" else ""
            print(GAVE_UP.format(within=within), file=sys.stderr)
            return 1
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
        return code
