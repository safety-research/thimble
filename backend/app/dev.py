"""Tickets: the dev agent's tasks over thimble's own code, and view builds.

A ticket is one record of dev/tickets.jsonl (repo root, gitignored), numbered per workspace, with shots under
dev/tickets/<id>/shots/. Filing opens a dev agent chat (the ticket's thread) and lands a chip in main; tickets run one
at a time, urgent first.

The worker is a Claude Code background session (`claude --bg`), so the analyst can attach to it. A run cuts a git
worktree from the live branch, takes a before shot, then starts the session with prompts/dev.md. The server polls until
the turn is done and copies the transcript into the chat, then runs the gates over what the branch changed; a failure
wakes the session with the output, up to MAX_ATTEMPTS turns. Then an after shot, the analyst's Allow, a fast-forward of
the live branch (rebasing once if it moved), a UI rebuild, and a restart when backend or plugin files changed, deferred
while an orientation runs. Only a supervised server (`thimble server up`) restarts itself.
`fix_offline` is `thimble fix`, `revert_last_apply` is `thimble revert`.

Recovery. The live checkout changes only in the fast-forward, after every gate passed. A restart runs under
restart_watch.py, which rolls the apply back when the server does not come back. A turn or question past its limit fails
the ticket; a server restart queues an interrupted run again with its worktree (_recover).

View tickets. View proposals build at once, each as a ticket on its row of views/proposals.json, run by queue_view in a
pool of its own (VIEW_POOL). A view is three files of the workspace, so there is no worktree, stack or restart. run_view
starts a session on prompts/dev-view.md in the corpus folder (which Claude Code trusts) with `--add-dir` for the view's
folder; the worked examples are fenced read-only, and an edit of the corpus goes as the dev agent's `data` says, by
default to the analyst first (view_fence). After each turn the server runs the view's gate; a failure wakes the
session, a pass registers the view. Where an active extension runs the dev agent with a program (roles.py), each turn
is a run of that program instead (program_view_turn), checked the same way. A turn the API ended at capacity is no
attempt: the build waits and wakes the session again. An orientation's proposal that runs out of attempts gets up to
VIEW_REPAIRS new sessions, and is then dropped quietly; a view the analyst asked for fails with Retry. The orientation's Stop stops the
builds of the views it proposed (stop_orientation_views). Main's end stops every build of the workspace
(stop_workspace): a view the analyst asked for fails with Retry, and a session's proposal waits, queued, until a session
is main again (resume_views).

Permissions. A session of a workspace asks the analyst like the other agents: its --settings carry agent_session's
permission hook with the session's key (`view:<slug>`, `ticket:<id>`), and the run hosts that key on its chat
(agent_session.host), so each request shows on the card and is answered by the mode of the dev agent's row (modes.py),
or denied after PERMISSION_WAIT_S unanswered. Allowed unasked is only its work in its own folder: edits there, reads of
the folders its task names, and Bash in the sandbox (sandbox_allow's rule, before each call and on each request) with
its check command. A session with no workspace (`thimble fix`, while the server is down) has nobody to ask, so it keeps
UNHOSTED_TOOLS, has no web tools, and is refused what thimble's config would have it ask for.

Containment. A code ticket whose session's Bash runs in the sandbox is contained where thimble's sandbox runtime works
(ticket_box): its gates, and the server that shows its before and after shots, run in the ticket's box, with no network,
no home folder and writes only to the worktree and the ticket's cache folder, and the server's git commands in the
worktree run hardened (WORKTREE_GIT). Its code first runs outside a sandbox once merged, so thimble asks the analyst,
in every mode, just before the merge (APPLY_QUESTION, on the card; `thimble fix` in the terminal). The session is
stopped before the question, and the merge takes the commit the question named, by its id (checked_change). Anything
but an Allow ends the ticket stopped with its branch kept. Where the box can't run, the ticket runs its gates on the
validation stack, outside the sandbox, so thimble also asks before it starts (CODE_QUESTION); a no stops it before its
worktree exists.

thimble's config. Code tickets and view builds are the dev agent's sessions, with its `agents.dev` settings
(userconf.py, dev_config); agent_session's module note says what the config adds. Their Bash runs in the sandbox
where it can run. A code ticket's sandbox also writes what a commit in its worktree writes into the checkout's git
folder (ticket_fence), and reaches no server on loopback, so the session takes no shots of its own and the server's
after shot shows its change. By default the dev agent has no web tools and its network is off.

The offline fence. With the dev agent's network off, a view build's Bash runs in the sandbox with no network where the
sandbox runs; where it does not, every command but its check goes to the analyst. Deny rules refuse the commands that
reach the network or install software (offline_deny), and its Bash runs with the package managers offline and a proxy
that refuses every connection (view_env); these stop a mistake, not a command that means to get round them, which is
why the sandbox or the analyst decides. A view build runs the model settings of the session that asked for it, unless
the dev agent's are set (view_models).
"""
from __future__ import annotations

import asyncio
import contextlib
import fcntl
import json
import logging
import os
import re
import secrets
import shlex
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Awaitable, Callable, Iterator
from urllib.parse import urlsplit

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from . import agents, cc_settings, cli, config, headless, modes, procs, prompts, ticket_box, userconf
from .cli import SOURCE_CHANGED, home as thimble_home
from .ledger import atomic_write_text
from .session import find_transcript

log = logging.getLogger("thimble.dev")

router = APIRouter()

REPO = config.REPO_ROOT  # the live checkout; tests point it at a scratch git repository
# Tickets live here. A scratch stack sets THIMBLE_DEV_DIR so what it files does not land in the checkout's dev/.
DEV_DIR = Path(os.environ.get("THIMBLE_DEV_DIR") or config.REPO_ROOT / "dev")
STACK_API_PORT = int(os.environ.get("THIMBLE_STACK_PORT", "8301"))
STACK_UI_PORT = int(os.environ.get("THIMBLE_STACK_UI_PORT", "5301"))
# off: this server is itself a stack (dev_stack.sh) and neither starts one nor runs a ticket
STACK_ENABLED = os.environ.get("THIMBLE_DEV_STACK", "1").strip().lower() not in ("0", "false", "no", "off")
STACK_WAIT_S = 90
SHOT_TIMEOUT_S = 90
GATE_TIMEOUT_S = 900
# The tools a session with no workspace uses without a permission request, since nobody can answer one: its file tools,
# Bash, skills and workflows (module note, permissions). The session has every tool of a default Claude Code session
# less the ones _flags takes away.
UNHOSTED_TOOLS = ["Read", "Edit", "Write", "NotebookEdit", "Bash", "Grep", "Glob", "Skill", "Workflow"]
# how long a request of a session with a workspace waits for the analyst before it is denied (module note, permissions)
PERMISSION_WAIT_S = float(os.environ.get("THIMBLE_DEV_PERMISSION_WAIT_S", "") or 10 * 60)
# the thread's line for a request denied unanswered
EXPIRED_LINE = "nobody answered the request to use {tool} ({what}) within {wait}, so it was denied and the session went on"
WEB_TOOLS = ("WebFetch", "WebSearch")  # agent_session.WEB_TOOLS
# Not given to a fenced session, a view build in the corpus folder: EnterWorktree writes a git worktree into the
# session's own folder, which the fence's denies do not stop, and nobody answers AskUserQuestion or plan mode's approval.
FENCED_OFF_TOOLS = ("EnterWorktree", "ExitWorktree", "AskUserQuestion", "EnterPlanMode", "ExitPlanMode")
# The Bash commands a view build's session may not run in any permission mode while the dev agent's network is off
# (offline_deny): those that reach the network or install software, each by name and at a path, the subcommands that
# do, the modules that do as `python -m`, and a shell run inside a command, whose own commands no rule would see. Claude
# Code checks a rule against each command of a line, also after wrappers such as `timeout` and `env`.
OFFLINE_PROGRAMS = ("curl", "wget", "aria2c", "nc", "ncat", "netcat", "socat", "telnet", "ftp", "sftp", "scp", "ssh",
                    "rsync", "gh", "pip", "pip3", "pipx", "uv", "uvx", "poetry", "pdm", "conda", "mamba", "micromamba",
                    "npm", "npx", "pnpm", "pnpx", "yarn", "bun", "bunx", "corepack", "deno", "gem", "cargo", "apt",
                    "apt-get", "aptitude", "dpkg", "snap", "brew", "port", "yum", "dnf", "zypper", "pacman", "apk",
                    "nix", "nix-env", "sudo", "playwright")
OFFLINE_COMMANDS = ("git clone", "git fetch", "git pull", "git push", "git ls-remote", "git submodule", "go get",
                    "go install", "go mod download", "bash -c", "sh -c", "zsh -c", "eval")
OFFLINE_MODULES = ("pip", "ensurepip", "playwright", "uv")
# A view build's environment beside its key (view_env): the package managers and Playwright's browser download offline,
# and as CLAUDE_ENV_FILE, which Claude Code sources before each Bash command, OFFLINE_ENV_FILE. Neither reaches the
# session's own calls to the API. It goes in the session's --settings `env`, since Claude Code's background service
# starts a session with its own environment rather than the environment of the `claude --bg` that asked for it.
OFFLINE_ENV = {"npm_config_offline": "true", "PIP_NO_INDEX": "1", "UV_OFFLINE": "1",
               "PLAYWRIGHT_DOWNLOAD_HOST": "http://127.0.0.1:9"}
OFFLINE_ENV_FILE = Path(__file__).with_name("offline_env.sh")
ENV_FILE = "CLAUDE_ENV_FILE"
CLAUDE_BIN = config.CLAUDE_BIN
VIEW_CHECK = Path(__file__).with_name("view_check.py")  # the command a view build checks its draft with (view_fence)
CLI_TIMEOUT_S = 60
POLL_S = float(os.environ.get("THIMBLE_DEV_POLL_S", "3") or "3")  # between two reads of the session's transcript
# the longest gap between two looks at `claude agents` while the session's transcript is quiet and it is listed working
# or blocked: each look starts a `claude` process, and a growing transcript says the session works without one
STATE_GAP_MAX_S = float(os.environ.get("THIMBLE_DEV_STATE_GAP_S", "30") or "30")
UNLISTED_POLLS = 10  # polls a session just started may be missing from `claude agents` before the run gives up on it
LOOPBACK = {"127.0.0.1", "::1", "localhost", "testclient"}
MAX_ATTEMPTS = max(1, int(os.environ.get("THIMBLE_DEV_MAX_ATTEMPTS", "3") or "3"))
_capacity_sleep = asyncio.sleep  # a view build's wait while the API is at capacity (view_capacity_waits); tests replace it
# the new sessions an orientation's view build gets after its attempts ran out, each told what failed (run_view)
VIEW_REPAIRS = max(0, int(os.environ.get("THIMBLE_VIEW_REPAIRS", "2") or "2"))
# A turn that has not ended after TURN_TIMEOUT_S, or a session that has waited ASK_TIMEOUT_S for an answer, is stopped
# and its ticket fails, so one stuck session cannot hold the queue or a pool slot.
TURN_TIMEOUT_S = float(os.environ.get("THIMBLE_DEV_TURN_TIMEOUT_S", "") or 45 * 60)
ASK_TIMEOUT_S = float(os.environ.get("THIMBLE_DEV_ASK_TIMEOUT_S", "") or 15 * 60)
# How long a server may take to answer /api/health (boot_check, restart_watch.py) before the change counts as breaking
# its start.
BOOT_TIMEOUT_S = float(os.environ.get("THIMBLE_DEV_BOOT_TIMEOUT_S", "") or 90)
RESTART_WATCH_S = float(os.environ.get("THIMBLE_DEV_RESTART_WATCH_S", "") or 120)
BOOT_PREFIXES = ("backend/app/",)  # what the server imports when it starts
# a ticket a restart interrupted runs again this many times before it fails, since its session is resumed
REQUEUE_MAX = 1
# view tickets building at once; 0 holds them queued (the tests' default)
VIEW_POOL = max(0, int(os.environ.get("THIMBLE_VIEW_BUILDS", "3") or "3"))
# set on a view ticket's session so the plugin's watcher exits at once there (plugin/bin/.thimble-watch)
SESSION_ENV = "THIMBLE_SESSION"
SOURCES = ("ui", "analyst", "terminal")
STATUSES = ("queued", "running", "applied", "applied, restart pending", "failed", "needs manual merge", "reverted",
            "rolled back", "stopped", "dismissed")
# the ends that leave nothing applied and can be retried or discarded; main gets a chip for each but `stopped`
FAILED = ("failed", "needs manual merge", "rolled back", "stopped")
# Why this server cannot run a code ticket (runner_problem). Each is shown to the analyst in the ticket's thread and
# passed to main in file_dev_ticket's result.
RELEASE_LINE = ("thimble's own code can only be changed in a development install (a git clone of thimble), and this is "
                "a release install. Send the request with Report a problem in the top bar instead.")
NO_RUNNER_LINE = "This server runs no dev tickets (THIMBLE_DEV_STACK is off, as on a validation stack)."
NO_CLAUDE_LINE = "The dev agent runs in Claude Code, and `{bin}` is not on the PATH of thimble's server."
RESTART_PREFIXES = ("backend/app/", "plugin/")
UI_PREFIXES = ("frontend/",)
UI_BUILD_TIMEOUT_S = 900
UI_UPDATED_LINE = "thimble's page was updated ({title}); it reloads when you pause"
SHOT_NAME_RE = re.compile(r"(before|after)\.png")
ID_RE = re.compile(r"[a-f0-9]{8}")
TARGET_CHARS = 2000
RESULT_CHARS = 4000
ERROR_CHARS = 600  # of a failed view ticket's error on its proposal and chip
KERNEL_RESET_LINE = ("thimble restarted after a change ({title}). Cards keep their outputs, but run a card again before "
                     "building on what it computed.")
KERNEL_RESET_LINE_PLAIN = "thimble restarted. Cards keep their outputs, but run a card again before building on what it computed."
KERNEL_KEPT_LINE = "thimble restarted after a change ({title}); your notebook picked up where it left off."
KERNEL_KEPT_LINE_PLAIN = "thimble restarted; your notebook picked up where it left off."
RESTART_PENDING_LINE = "thimble will restart after a change ({title}) when orientation finishes"
RESTART_PENDING_LINE_PLAIN = "thimble will restart when orientation finishes"
PLAIN_REASONS = ("manual restart", SOURCE_CHANGED)
PLAIN_PREFIXES = ("revert of ", "rollback of ")  # a restart for a revert or a rollback names no change of its own
SUPERVISED_ENV = cli.SUPERVISED_ENV  # set by `thimble server up` on the uvicorn it spawns (cli._server_environ)
APPLIED_RESTART_LINE = "{label} applied; restart thimble's server to load it"
APPLIED_REBUILD_LINE = "{label} applied; run scripts/rebuild_ui.sh to load it"
EXECV: Callable[[list[str]], None] = lambda argv: os.execv(sys.executable, argv)  # replaces the process; never under tests


def reset_line(title: str, *, kept: bool = False) -> str:
    plain = title in PLAIN_REASONS or title.startswith(PLAIN_PREFIXES)
    if kept:
        return (KERNEL_KEPT_LINE_PLAIN if plain else KERNEL_KEPT_LINE).format(title=title)
    return (KERNEL_RESET_LINE_PLAIN if plain else KERNEL_RESET_LINE).format(title=title)


def pending_line(title: str) -> str:
    return (RESTART_PENDING_LINE_PLAIN if title in PLAIN_REASONS or title.startswith(PLAIN_PREFIXES)
            else RESTART_PENDING_LINE).format(title=title)


def kernels_kept(c: str) -> bool:
    """Whether this server's start reconnected a kernel of workspace `c` (notebook.LAST_RECONNECT)."""
    try:
        from . import notebook  # noqa: PLC0415
    except Exception:  # noqa: BLE001
        return False
    rec = getattr(notebook, "LAST_RECONNECT", None)
    if not isinstance(rec, dict):
        return False
    return any(str(k).startswith(f"{c}/") for k in rec.get("reconnected") or [])


async def _wait_kernels_reconnected() -> None:
    try:
        from . import notebook  # noqa: PLC0415
    except Exception:  # noqa: BLE001
        return
    wait = getattr(notebook, "wait_reconnect", None)
    if wait is None:
        return
    try:
        await wait()
    except Exception:  # noqa: BLE001
        log.debug("waiting for the kernel reconnect failed", exc_info=True)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# ----------------------------------------------------------------------------- storage


def tickets_path() -> Path:
    return DEV_DIR / "tickets.jsonl"


def applies_path() -> Path:
    return DEV_DIR / "applies.jsonl"


def ticket_dir(tid: str) -> Path:
    return DEV_DIR / "tickets" / tid


def shots_dir(tid: str) -> Path:
    return ticket_dir(tid) / "shots"


def _read_jsonl(p: Path, key: str) -> list[dict[str, Any]]:
    if not p.is_file():
        return []
    out: list[dict[str, Any]] = []
    with p.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                log.warning("skipping bad line in %s", p)
                continue
            if isinstance(rec, dict) and rec.get(key):
                out.append(rec)
    return out


def _write_jsonl(p: Path, items: list[dict[str, Any]]) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    atomic_write_text(p, "".join(json.dumps(c, ensure_ascii=False) + "\n" for c in items))


def _append_jsonl(p: Path, rec: dict[str, Any]) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    with p.open("a", encoding="utf-8") as f:
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")


def _read() -> list[dict[str, Any]]:
    return _read_jsonl(tickets_path(), "id")


# tickets.jsonl is read, changed and written whole by the event loop, worker threads and other processes of the same
# checkout: the lock serializes this process's threads and the flock the processes.
_tickets_lock = threading.RLock()
_tickets_depth = 0


@contextlib.contextmanager
def _locked() -> Iterator[None]:
    global _tickets_depth
    with _tickets_lock:
        fd = None
        if _tickets_depth == 0:
            try:
                tickets_path().parent.mkdir(parents=True, exist_ok=True)
                fd = os.open(tickets_path().with_suffix(".lock"), os.O_RDWR | os.O_CREAT, 0o644)
                fcntl.flock(fd, fcntl.LOCK_EX)
            except OSError:
                log.debug("tickets.jsonl is written without its file lock", exc_info=True)
                if fd is not None:
                    os.close(fd)
                fd = None
        _tickets_depth += 1
        try:
            yield
        finally:
            _tickets_depth -= 1
            if fd is not None:
                with contextlib.suppress(OSError):
                    fcntl.flock(fd, fcntl.LOCK_UN)
                os.close(fd)


def _update(tid: str, **fields: Any) -> dict[str, Any] | None:
    with _locked():
        items = _read()
        hit = None
        for t in items:
            if t.get("id") == tid:
                t.update(fields)
                hit = t
        if hit is not None:
            _write_jsonl(tickets_path(), items)
        return hit


def _claim(tid: str) -> dict[str, Any] | None:
    """Mark a queued ticket running for this process, or None when it is no longer queued (another server of the same
    checkout took it, or it was dismissed): the check and the change are one write under the lock."""
    with _locked():
        items = _read()
        hit = next((t for t in items if t.get("id") == tid), None)
        if hit is None or hit.get("status") != "queued":
            return None
        hit.update(status="running", attempts=int(hit.get("attempts") or 0) + 1, error=None, ts_end=None,
                   runner=os.getpid())
        _write_jsonl(tickets_path(), items)
        return hit


def _get(tid: str) -> dict[str, Any] | None:
    return next((t for t in _read() if t.get("id") == tid), None)


def _title_from(text: str) -> str:
    first = next((ln.strip() for ln in str(text or "").splitlines() if ln.strip()), "") or "untitled"
    return first[:80]


def _label(t: dict[str, Any]) -> str:
    return f"ticket #{t['n']}" if t.get("n") else "ticket"


def _workspaces() -> list[str]:
    try:
        return sorted(d.name for d in config.WORKSPACES_DIR.iterdir() if d.is_dir() and not d.name.startswith("."))
    except OSError:
        return []


def _emit_ws(c: str, event: dict[str, Any]) -> None:
    """One event on the workspace stream. Seam for tests."""
    try:
        from . import investigation  # noqa: PLC0415

        (config.WORKSPACES_DIR / c / "investigations" / "main").mkdir(parents=True, exist_ok=True)
        investigation.emit(c, "main", event)
    except Exception:  # noqa: BLE001
        log.debug("could not emit %s to %s", event.get("type"), c, exc_info=True)


def _emit_all(event: dict[str, Any], only: list[str] | None = None) -> None:
    for c in (only if only is not None else _workspaces()):
        _emit_ws(c, event)


def _ticket_event(t: dict[str, Any], status: str) -> None:
    if t.get("workspace"):
        _emit_ws(str(t["workspace"]), {"type": "ticket", "id": t["id"], "n": t.get("n"), "status": status})


# ----------------------------------------------------------------------------- the ticket's agent chat


def _open_chat(t: dict[str, Any]) -> str | None:
    """A new agent chat of role dev for the ticket, announced in its workspace's main; None without a workspace."""
    c = t.get("workspace")
    if not c:
        return None
    try:
        meta = agents.new_agent(str(c), "dev", f"{_label(t)}: {t['title']}", ticket=t["id"])
    except HTTPException as e:
        raise ValueError(str(e.detail)) from e
    return str(meta["id"])


def _close_chat(t: dict[str, Any], status: str, result: str | None) -> None:
    """End the ticket's agent chat when it is still running."""
    c, chat = t.get("workspace"), t.get("chat")
    if not c or not chat:
        return
    try:
        meta = agents.meta_or_none(str(c), str(chat))
        if meta is not None and meta.get("status") == "running":
            agents.finish_agent(str(c), str(chat), status, result)
    except Exception:  # noqa: BLE001
        log.exception("could not close the chat of ticket %s", t.get("id"))


def _chip(t: dict[str, Any], text: str, status: str | None = None) -> None:
    """A chip in main about the ticket, naming its agent chat (the ticket's thread) and, for its start and its apply, the
    `status` the browser words it by (`started`, `applied`)."""
    if t.get("workspace"):
        try:
            agents.chip(str(t["workspace"]), "ticket", text, ref=f"ticket:{t['id']}", n=t.get("n"), chat=t.get("chat"),
                        status=status)
        except Exception:  # noqa: BLE001
            log.exception("could not chip for ticket %s", t.get("id"))


class Log:
    """Where a run writes its steps: the ticket's agent chat, or nowhere for a ticket without a workspace."""

    def __init__(self, rec: agents.Recorder | None) -> None:
        self.rec = rec

    def text(self, delta: str, **extra: Any) -> None:
        if self.rec is not None and delta:
            self.rec.text(delta, **extra)

    def tool_use(self, id_: str, name: str, input_: Any, **extra: Any) -> None:
        if self.rec is not None:
            self.rec.tool_use(id_, name, input_, **extra)

    def tool_result(self, id_: str, summary: str, *, is_error: bool = False, **extra: Any) -> None:
        if self.rec is not None:
            self.rec.tool_result(id_, summary, is_error=is_error, **extra)

    def error(self, message: str) -> None:
        if self.rec is not None:
            self.rec.error(message)

    def stage(self, line: str) -> None:
        self.text(f"\n· {line}\n")

    def shot(self, ticket: str, phase: str, name: str, note: str = "") -> None:
        """A before or after shot the run took, as a record the ticket's thread shows as the picture."""
        if self.rec is not None:
            self.rec.record("shot", ticket=ticket, phase=phase, name=name, **({"note": note} if note else {}))


def _log_for(t: dict[str, Any]) -> Log:
    c, chat = t.get("workspace"), t.get("chat")
    if c and chat and agents.meta_or_none(str(c), str(chat)) is not None:
        return Log(agents.Recorder(str(c), str(chat)))
    return Log(None)


# ----------------------------------------------------------------------------- filing


def file_ticket(workspace: str | None, title: str, body: str, source: str = "analyst", *, urgent: bool = False,
                target: dict[str, Any] | None = None, start: bool = True) -> dict[str, Any]:
    """Store a ticket, open its agent chat, chip main, and start it when nothing runs. Raises ValueError on an empty
    ticket, an unknown source or an unknown workspace."""
    title = str(title or "").strip()
    if not title:
        title = _title_from(body)
    if title == "untitled" and not str(body or "").strip():
        raise ValueError("empty ticket")
    if source not in SOURCES:
        raise ValueError(f"source must be one of {SOURCES}")
    with _locked():
        items = _read()
        n = 1 + max((int(t.get("n") or 0) for t in items if t.get("workspace") == workspace), default=0)
        rec: dict[str, Any] = {"id": secrets.token_hex(4), "n": n, "ts": _now(), "title": title, "body": str(body or ""),
                               "source": source, "urgent": bool(urgent), "workspace": workspace, "target": target or {},
                               "status": "queued", "attempts": 0, "chat": None, "branch": None, "worktree": None,
                               "base": None, "touched": [], "commit": None, "restart": None, "error": None,
                               "result": None, "before_shot": None, "after_shot": None, "shots_differ": None,
                               "validation": None, "session": None, "session_id": None, "ts_end": None,
                               "ui_build": None}
        rec["chat"] = _open_chat(rec)
        items.append(rec)
        _write_jsonl(tickets_path(), items)
    log.info("ticket %s filed (%s, %s): %s", rec["id"], _label(rec), source, title)
    _chip(rec, f"{_label(rec)}: {title}", "started")
    _ticket_event(rec, "queued")
    if start:
        # a ticket this server can never run fails at once with the reason, rather than waiting in the queue unseen
        if why := runner_problem():
            return _fail_now(rec, why)
        _start_next_if_idle()
    return rec


def runner_problem(*, fixing: bool = False) -> str:
    """Why this server cannot run a code ticket, '' when it can: the live tree is not a git checkout, the server is
    itself a validation stack (unless `fixing`), or the claude CLI is missing."""
    if not (REPO / ".git").exists():
        return RELEASE_LINE
    if not fixing and not STACK_ENABLED:
        return NO_RUNNER_LINE
    problem = getattr(SESSIONS, "problem", None)
    return problem() if callable(problem) else ""


def _fail_now(t: dict[str, Any], why: str) -> dict[str, Any]:
    """End a ticket that cannot run as failed with `why`: its chat, a chip in main and the stream say so."""
    rec = _update(t["id"], status="failed", error=why, ts_end=_now()) or {**t, "status": "failed", "error": why}
    log.warning("ticket %s cannot run: %s", t["id"], why)
    _close_chat(rec, "failed", why)
    _chip(rec, f"{_label(rec)} failed: {why}", "failed")
    _ticket_event(rec, "failed")
    return rec


def _queued() -> list[dict[str, Any]]:
    """The queued tickets this server may run, urgent first: those of its own workspaces and those filed with none."""
    mine = set(_workspaces())
    items = [t for t in _read() if t.get("status") == "queued" and (not t.get("workspace") or t["workspace"] in mine)]
    return [t for t in items if t.get("urgent")] + [t for t in items if not t.get("urgent")]


def _next_queued() -> dict[str, Any] | None:
    return next(iter(_queued()), None)


# ----------------------------------------------------------------------------- run state


@dataclass
class Run:
    ticket_id: str
    title: str
    ts_start: str
    status: str = "running"
    session: str | None = None  # the background session's short id, as `claude agents` lists it and `claude attach` takes
    session_id: str | None = None  # its full id: the transcript's name and what `--resume` continues
    task: asyncio.Task | None = None
    stop_reason: str | None = None  # `stopped` or `dismissed` when the analyst ended the run (stop_ticket)


_current: Run | None = None
_restart_pending: dict[str, Any] | None = None
_poller: asyncio.Task | None = None
_announced = False


def _running() -> bool:
    return _current is not None and _current.status == "running"


def dev_session_name(workspace: str | None) -> str:
    """The name `claude agents` shows a code ticket's background session under: thimble:dev · <workspace>, or
    thimble:dev for a ticket of no workspace (config.session_name)."""
    return config.session_name("dev", workspace)


def view_session_name(c: str, slug: str) -> str:
    """The name `claude agents` shows a view build's background session under: thimble:view-<slug> · <c>."""
    return config.session_name(f"view-{slug}", c)


def running_builds(c: str) -> list[dict[str, Any]]:
    """The code ticket, view builds and view review revisions that run for workspace `c`, for the terminal's list of
    thimble's agents (bg_session.agent_rows): {name, label, state, kind}."""
    rows: list[dict[str, Any]] = []
    t = _get(_current.ticket_id) if _running() and _current is not None and not _current.ticket_id.startswith("view:") else None
    if t is not None and t.get("workspace") in (None, c):
        rows.append({"name": dev_session_name(t.get("workspace")), "label": f"dev ticket: {t.get('title') or t['id']}",
                     "state": "working", "kind": "build"})
    for (cc, slug), run in [*_view_runs.items(), *_review_runs.items()]:
        if cc == c and run.status == "running":
            rows.append({"name": view_session_name(c, slug), "label": f"view: {run.title or slug}", "state": "working",
                         "kind": "build"})
    return rows


# ----------------------------------------------------------------------------- git helpers (blocking; run in threads)


class GitError(RuntimeError):
    pass


# A ticket's session can write its worktree and the worktree's own git folder (ticket_fence), so the server's git
# commands there run with no fsmonitor command and no hooks, with the git folders named from the live checkout's side
# (GIT_DIR, GIT_COMMON_DIR, GIT_WORK_TREE) so that no `.git` file or commondir the session wrote is read, and only while
# the worktree still points where it should (_check_worktree).
WORKTREE_GIT = ("-c", "core.fsmonitor=", "-c", "core.hooksPath=/dev/null")
WORKTREE_MOVED = ("the ticket's worktree no longer points at the live checkout's git folder ({why}), so thimble ran no "
                  "git command in it")


def _in_worktrees(cwd: Path) -> bool:
    try:
        return Path(cwd).resolve().is_relative_to(worktrees_dir().resolve())
    except OSError:
        return False


def _own_config(own: Path) -> bool:
    """Whether the worktree's git folder holds a config.worktree that could set something. Claude Code's sandbox leaves
    an empty one there, which sets nothing."""
    cfg = own / "config.worktree"
    return cfg.is_symlink() or (cfg.exists() and not (cfg.is_file() and cfg.stat().st_size == 0))


def _check_worktree(wt: Path) -> tuple[Path, Path]:
    """(the worktree's own git folder, the live checkout's git folder): the checkout's `worktrees/<name>`. GitError
    (WORKTREE_MOVED) unless `wt/.git` names that folder, whose commondir is the checkout's git folder, with no config of
    its own (_own_config)."""
    common = Path(subprocess.run(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], cwd=str(REPO),
                                 capture_output=True, text=True, timeout=60).stdout.strip()).resolve()
    own = common / "worktrees" / Path(wt).name
    try:
        text = (Path(wt) / ".git").read_text("utf-8").strip()
        why = ("its .git is not a gitdir line" if not text.startswith("gitdir: ") else
               "its .git names another git folder" if Path(text.removeprefix("gitdir: ")).resolve() != own else
               "its git folder names another commondir"
               if (own / (own / "commondir").read_text("utf-8").strip()).resolve() != common else
               "its git folder has a config of its own" if _own_config(own) else "")
    except OSError as e:
        why = f"{type(e).__name__}: {e}"
    if why:
        raise GitError(WORKTREE_MOVED.format(why=why))
    return own, common


def _git_run(cwd: Path, args: "tuple[str, ...] | list[str]", timeout: int = 120) -> subprocess.CompletedProcess:
    """`git` with `args` in `cwd`, hardened in a ticket's worktree (WORKTREE_GIT and the git folders above)."""
    argv, env = ["git", *args], None
    if _in_worktrees(cwd):
        own, common = _check_worktree(cwd)
        argv = ["git", *WORKTREE_GIT, *args]
        env = {**os.environ, "GIT_DIR": str(own), "GIT_COMMON_DIR": str(common), "GIT_WORK_TREE": str(cwd)}
    return subprocess.run(argv, cwd=str(cwd), capture_output=True, text=True, timeout=timeout, env=env)


def _git(cwd: Path, *args: str, check: bool = True, timeout: int = 120) -> str:
    out = _git_run(cwd, args, timeout)
    if check and out.returncode != 0:
        raise GitError((out.stderr.strip() or out.stdout.strip() or f"git {' '.join(args)} failed")[:800])
    return out.stdout.rstrip()


def live_branch() -> str:
    return _git(REPO, "rev-parse", "--abbrev-ref", "HEAD")


def live_head() -> str:
    return _git(REPO, "rev-parse", "HEAD")


def worktrees_dir() -> Path:
    return thimble_home() / "dev"


def worktree_path(tid: str) -> Path:
    return worktrees_dir() / tid


def _link(src: Path, dst: Path) -> None:
    real = Path(os.path.realpath(src))
    if not real.exists() or dst.is_symlink() or dst.exists():
        return
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.symlink_to(real, target_is_directory=real.is_dir())


def create_worktree(tid: str) -> tuple[Path, str, str]:
    """`git worktree add -b dev/<id>` off the live branch, node_modules and .venv linked in. (path, branch, base sha)."""
    wt = worktree_path(tid)
    branch = f"dev/{tid}"
    if wt.exists():
        _git(REPO, "worktree", "remove", "--force", str(wt), check=False)
        shutil.rmtree(wt, ignore_errors=True)
    _git(REPO, "worktree", "prune", check=False)
    wt.parent.mkdir(parents=True, exist_ok=True)
    base = live_head()
    if _git(REPO, "rev-parse", "--verify", "--quiet", f"refs/heads/{branch}", check=False):
        _git(REPO, "branch", "-f", branch, live_branch())  # a retry: the branch survives; reset to the live head
        _git(REPO, "worktree", "add", str(wt), branch)
    else:
        _git(REPO, "worktree", "add", "-b", branch, str(wt), live_branch())
    _link(REPO / "frontend" / "node_modules", wt / "frontend" / "node_modules")
    _link(REPO / "backend" / ".venv", wt / "backend" / ".venv")
    return wt, branch, base


def remove_worktree(wt: Path) -> None:
    _git(REPO, "worktree", "remove", "--force", str(wt), check=False)
    shutil.rmtree(wt, ignore_errors=True)
    _git(REPO, "worktree", "prune", check=False)


def delete_branch(branch: str) -> None:
    if branch:
        _git(REPO, "branch", "-D", branch, check=False)


def remove_ticket_tree(t: dict[str, Any]) -> None:
    wt = t.get("worktree")
    if wt and Path(wt) != REPO and Path(wt).exists():
        remove_worktree(Path(wt))
    delete_branch(str(t.get("branch") or ""))


_LINKED = {"frontend/node_modules", "backend/.venv"}


def touched_files(tree: Path) -> list[str]:
    """Paths with uncommitted changes in `tree` (staged, unstaged, untracked), relative to its root."""
    out: set[str] = set()
    for ln in _git(tree, "status", "--porcelain", "--untracked-files=all").splitlines():
        if len(ln) < 4:
            continue
        rest = ln[3:]
        if " -> " in rest:
            rest = rest.split(" -> ", 1)[1]
        out.add(rest.strip().strip('"'))
    return sorted(out - _LINKED)


def _diff_files(tree: Path, old: str, new: str) -> list[str]:
    out = _git(tree, "diff", "--name-only", old, new)
    return sorted({ln.strip() for ln in out.splitlines() if ln.strip()} - _LINKED)


def branch_files(tree: Path, base: str) -> list[str]:
    """Paths the commits on `tree`'s branch changed since `base`, relative to its root: what the session committed."""
    return _diff_files(tree, base, "HEAD")


def needs_restart(touched: list[str]) -> bool:
    return any(p.startswith(RESTART_PREFIXES) for p in touched)


def needs_ui_build(touched: list[str]) -> bool:
    return any(p.startswith(UI_PREFIXES) for p in touched)


def dist_dir() -> Path:
    return REPO / "frontend" / "dist"


def serves_built_ui() -> bool:
    """Whether this server serves the live checkout's frontend/dist at / (main.frontend_dist's rule)."""
    if os.environ.get("THIMBLE_DEV", "").strip().lower() in ("1", "true", "yes", "on"):
        return False
    d = dist_dir()
    try:
        if Path(config.FRONTEND_DIST).resolve() != d.resolve():
            return False
    except OSError:
        return False
    return (d / "index.html").is_file()


def dirty_in_live(touched: list[str]) -> list[str]:
    if not touched:
        return []
    out = _git(REPO, "status", "--porcelain", "--", *touched, check=False)
    return sorted({ln[3:].split(" -> ")[-1].strip() for ln in out.splitlines() if len(ln) > 3})


def _manual_merge(files: list[str], branch: str, detail: str = "") -> str:
    return (f"needs manual merge: {', '.join(files)}" + (f" ({detail})" if detail else "")
            + f"; the change is kept on branch {branch}")


BRANCH_MOVED = "the ticket's branch changed after its checks"


def rebase_branch(wt: Path, branch: str, base: str, touched: list[str], expect: str | None = None) -> dict[str, Any]:
    """Bring the ticket's branch onto the live branch's head before its apply: nothing when the live branch has not
    moved since `base`, else one rebase in the worktree. Refused on uncommitted live changes in touched files, on a
    conflict, when the branch is not at `expect` (the commit the analyst was asked about) or when the rebase changed a
    file outside `touched`. {ok, rebased, head, commit, error, conflicts}; `head` is the live head the branch now sits on
    and `commit` the branch's head, the commit to merge."""
    result: dict[str, Any] = {"ok": False, "rebased": False, "head": None, "commit": None, "error": None,
                              "conflicts": []}
    dirty = dirty_in_live(touched)
    if dirty:
        result.update(error=_manual_merge(dirty, branch, "uncommitted changes in the live checkout"), conflicts=dirty)
        return result
    head = live_head()
    result["head"] = head
    if _git(wt, "symbolic-ref", "HEAD", check=False) != f"refs/heads/{branch}":
        result.update(error=_manual_merge(touched, branch, "the ticket's worktree is no longer on its branch"),
                      conflicts=touched)
        return result
    tip = _git(wt, "rev-parse", "HEAD", check=False)
    if expect and tip != expect:
        result.update(error=_manual_merge(touched, branch, BRANCH_MOVED), conflicts=touched)
        return result
    if _git_run(wt, ("merge-base", "--is-ancestor", head, "HEAD"), 60).returncode == 0:
        result.update(ok=True, commit=tip)  # the branch already sits on the live head
        return result
    rb = _git_run(wt, ("-c", "user.name=thimble dev", "-c", "user.email=dev@thimble.local", "rebase", head))
    if rb.returncode != 0:
        conflicts = _git(wt, "diff", "--name-only", "--diff-filter=U", check=False).splitlines()
        _git(wt, "rebase", "--abort", check=False)
        result.update(error=_manual_merge(conflicts or touched, branch, "it conflicts with the live branch"),
                      conflicts=conflicts or touched)
        return result
    new = _git(wt, "rev-parse", "HEAD")
    if set(_diff_files(wt, head, new)) - set(touched):
        result.update(error=_manual_merge(touched, branch, BRANCH_MOVED), conflicts=touched)
        return result
    result.update(ok=True, rebased=True, commit=new)
    return result


def merge_branch(branch: str, touched: list[str], expect_head: str | None, commit: str) -> dict[str, Any]:
    """Fast-forward the live branch to `commit`, the head of `branch` that rebase_branch put on `expect_head`, by its id,
    so that nothing that moves the branch meanwhile reaches the live checkout. Refused when the live head moved since
    (the caller rebases and checks again) or on uncommitted live changes in touched files.
    {ok, commit, prev_head, moved, error, conflicts}."""
    result: dict[str, Any] = {"ok": False, "commit": None, "prev_head": None, "moved": False, "error": None,
                              "conflicts": []}
    dirty = dirty_in_live(touched)
    if dirty:
        result.update(error=_manual_merge(dirty, branch, "uncommitted changes in the live checkout"), conflicts=dirty)
        return result
    head = live_head()
    result["prev_head"] = head
    if expect_head and head != expect_head:
        result["moved"] = True
        return result
    mg = subprocess.run(["git", "merge", "--ff-only", commit], cwd=str(REPO), capture_output=True, text=True, timeout=120)
    if mg.returncode != 0:
        result.update(error=_manual_merge(touched, branch, (mg.stderr or mg.stdout).strip()[:200]), conflicts=touched)
        return result
    result.update(ok=True, commit=live_head())
    return result


def apply_branch(tid: str, wt: Path, branch: str, base: str, touched: list[str]) -> dict[str, Any]:
    """rebase_branch then merge_branch, with no gates between them: for a caller that has checked the branch on the
    live head already. {ok, commit, prev_head, rebased, error, conflicts}."""
    rb = rebase_branch(wt, branch, base, touched)
    if not rb["ok"]:
        return {"ok": False, "commit": None, "prev_head": None, "rebased": False, "error": rb["error"],
                "conflicts": rb["conflicts"]}
    mg = merge_branch(branch, touched, rb["head"], rb["commit"])
    if mg["moved"]:
        mg = {**mg, "error": _manual_merge(touched, branch, "the live branch moved during the apply"),
              "conflicts": touched}
    return {"ok": mg["ok"], "commit": mg["commit"], "prev_head": mg["prev_head"], "rebased": rb["rebased"],
            "error": mg["error"], "conflicts": mg["conflicts"]}


def record_apply(t: dict[str, Any], res: dict[str, Any], restart: str | None) -> dict[str, Any]:
    rec = {"ts": _now(), "ticket_id": t["id"], "title": t["title"], "workspace": t.get("workspace"),
           "commit": res.get("commit"), "prev_head": res.get("prev_head"), "touched": t.get("touched") or [],
           "restart": restart, "rebased": bool(res.get("rebased")), "kind": "apply"}
    _append_jsonl(applies_path(), rec)
    return rec


def last_apply() -> dict[str, Any] | None:
    applies = [a for a in _read_jsonl(applies_path(), "ts") if a.get("kind", "apply") == "apply"]
    reverted = {a.get("reverts") for a in _read_jsonl(applies_path(), "ts") if a.get("kind") == "revert"}
    for a in reversed(applies):
        if a.get("commit") and a["commit"] not in reverted:
            return a
    return None


def apply_of(tid: str) -> dict[str, Any] | None:
    """The ticket's apply record that no revert has undone, or None."""
    rows = _read_jsonl(applies_path(), "ts")
    reverted = {a.get("reverts") for a in rows if a.get("kind") == "revert"}
    return next((a for a in reversed(rows) if a.get("kind", "apply") == "apply" and a.get("ticket_id") == tid
                 and a.get("commit") and a["commit"] not in reverted), None)


def revert_last_apply() -> dict[str, Any]:
    """`git revert` the last apply's commits in the live checkout; refused when the live tree has uncommitted changes
    in the files it would touch. {ok, reverted, commit, title, workspace, restart, touched, ticket_id, error}."""
    a = last_apply()
    if a is None:
        return {"ok": False, "error": "nothing to revert"}
    return revert_apply(a)


def revert_apply(a: dict[str, Any], *, status: str = "reverted", why: str | None = None) -> dict[str, Any]:
    """`git revert` one apply's commits (revert_last_apply's work); the ticket takes `status` and, when given, `why` as
    its error (a rollback says why the change was taken back)."""
    touched = [str(p) for p in (a.get("touched") or [])]
    dirty = dirty_in_live(touched)
    if dirty:
        return {"ok": False, "error": "needs manual revert: uncommitted changes in " + ", ".join(dirty), "title": a.get("title")}
    rng = f"{a['prev_head']}..{a['commit']}" if a.get("prev_head") else a["commit"]
    rv = subprocess.run(["git", "-c", "user.name=thimble dev", "-c", "user.email=dev@thimble.local", "revert",
                         "--no-edit", rng], cwd=str(REPO), capture_output=True, text=True, timeout=120)
    if rv.returncode != 0:
        _git(REPO, "revert", "--abort", check=False)
        return {"ok": False, "error": "revert failed: " + (rv.stderr or rv.stdout).strip()[:300], "title": a.get("title")}
    commit = live_head()
    restart = "requested" if needs_restart(touched) else None
    _append_jsonl(applies_path(), {"ts": _now(), "kind": "revert", "reverts": a["commit"], "commit": commit,
                                   "ticket_id": a.get("ticket_id"), "title": a.get("title"), "touched": touched,
                                   "restart": restart, **({"why": why} if why else {})})
    log.info("reverted the apply of %r (%s) as %s", a.get("title"), str(a["commit"])[:7], str(commit)[:7])
    if a.get("ticket_id"):
        t = _update(str(a["ticket_id"]), status=status, **({"error": why} if why else {}))
        if t:
            _ticket_event(t, status)
    return {"ok": True, "reverted": a["commit"], "commit": commit, "title": a.get("title"), "restart": restart,
            "touched": touched, "ticket_id": a.get("ticket_id"), "workspace": a.get("workspace")}


# ----------------------------------------------------------------------------- gates and the validation stack


async def _run(cmd: list[str], *, cwd: Path, timeout: float, env: dict[str, str] | None = None,
               environ: dict[str, str] | None = None) -> tuple[int, str]:
    """`cmd` in `cwd` with its output joined: (exit code, output), -1 on a timeout or a missing program. The environment
    is `environ` when given, else this process's with `env` over it."""
    try:
        proc = await asyncio.create_subprocess_exec(*cmd, cwd=str(cwd), stdout=asyncio.subprocess.PIPE,
                                                    stderr=asyncio.subprocess.STDOUT,
                                                    env=environ if environ is not None else {**os.environ, **(env or {})})
    except OSError as e:
        return -1, f"{cmd[0]} could not start: {e}"
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), timeout)
    except asyncio.TimeoutError:
        try:
            proc.kill()
        except ProcessLookupError:
            pass
        await proc.wait()
        return -1, f"timed out after {timeout:.0f} s (or a child of the command kept its output pipe open)"
    return proc.returncode if proc.returncode is not None else -1, out.decode("utf-8", "replace")


# The backend's test folder, the suite CI runs; the gates run the files of it that a ticket's changes name.
BACKEND_SUITE = "tests_public"


def _tests_for(touched: list[str], tree: Path) -> list[str]:
    tests: set[str] = set()
    for p in touched:
        if p.startswith(f"backend/{BACKEND_SUITE}/test_") and p.endswith(".py"):
            tests.add(p[len("backend/"):])
        elif p.startswith("backend/app/") and p.endswith(".py"):
            mod = Path(p).stem
            for hit in sorted((tree / "backend" / BACKEND_SUITE).glob(f"test_{mod}*.py")):
                tests.add(f"{BACKEND_SUITE}/{hit.name}")
    return sorted(tests)


def _frontend_tests(fe: Path, boxed: bool = False) -> tuple[str, list[str]] | None:
    """The frontend tests' gate as (name, command): vitest over tests/public, the suite CI runs; None when vitest is not
    installed or the checkout has no tests there. `boxed` names vitest's own file, with its config read in memory, since
    a box can't write node_modules."""
    vitest = fe / "node_modules" / ".bin" / "vitest"
    if vitest.exists() and any((fe / "tests" / "public").glob("*.test.ts*")):
        return "vitest", [str(vitest), "run", "--configLoader", "runner"] if boxed else ["npx", "vitest", "run"]
    return None


def _gate_environ(extra: dict[str, str] | None = None) -> dict[str, str]:
    """The environment a gate runs in: this server's without its THIMBLE_* names, so a test or a server a gate starts
    never reaches the live server's home, workspaces, dev folder or port, with `extra` over it."""
    return {**{k: v for k, v in os.environ.items() if not k.startswith("THIMBLE_")}, **(extra or {})}


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def _health(url: str, timeout: float = 1.0) -> dict[str, Any] | None:
    """/api/health's body at `url` when it answers ok, else None. Blocking."""
    try:
        with urllib.request.urlopen(f"{url}/api/health", timeout=timeout) as r:
            body = json.loads(r.read() or b"{}")
    except Exception:  # noqa: BLE001
        return None
    return body if isinstance(body, dict) and body.get("ok") else None


async def boot_check(tree: Path) -> dict[str, Any]:
    """The server-start gate: the tree's server started on a free port with scratch folders until /api/health answers or
    BOOT_TIMEOUT_S passes, then stopped, so a change that breaks startup fails in the worktree. {name, ok, tail}."""
    py = tree / "backend" / ".venv" / "bin" / "python"
    if not py.exists():
        return {"name": "server start", "ok": False, "tail": "backend/.venv is missing in the worktree"}
    port = _free_port()
    scratch = Path(tempfile.mkdtemp(prefix="thimble-boot-"))
    environ = _gate_environ({"THIMBLE_SKIP_KEY": "1", "THIMBLE_HOME": str(scratch / "home"),
                             "THIMBLE_WORKSPACES_DIR": str(scratch / "ws"), "THIMBLE_DATA_DIR": str(scratch / "data"),
                             "THIMBLE_DEV_DIR": str(scratch / "dev"), "THIMBLE_DEV_STACK": "0",
                             "THIMBLE_VIEW_BUILDS": "0", "THIMBLE_PORT": str(port)})
    out_path = scratch / "server.log"
    ok, why = False, ""
    started = time.monotonic()
    with out_path.open("wb") as out:
        try:
            proc = await asyncio.create_subprocess_exec(
                str(py), "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", str(port),
                cwd=str(tree / "backend"), stdout=out, stderr=asyncio.subprocess.STDOUT, env=environ,
                start_new_session=True)
        except OSError as e:
            shutil.rmtree(scratch, ignore_errors=True)
            return {"name": "server start", "ok": False, "tail": f"the server could not start: {e}"}
        try:
            while time.monotonic() - started < BOOT_TIMEOUT_S:
                if proc.returncode is not None:
                    why = f"the server exited ({proc.returncode}) before it answered"
                    break
                if await asyncio.to_thread(_health, f"http://127.0.0.1:{port}"):
                    ok = True
                    break
                with contextlib.suppress(asyncio.TimeoutError):
                    await asyncio.wait_for(proc.wait(), 0.5)
            else:
                why = f"the server did not answer /api/health within {BOOT_TIMEOUT_S:.0f} s"
        finally:
            if proc.returncode is None:
                with contextlib.suppress(ProcessLookupError, PermissionError):
                    os.killpg(proc.pid, signal.SIGTERM)
                try:
                    await asyncio.wait_for(proc.wait(), 10)
                except asyncio.TimeoutError:
                    with contextlib.suppress(ProcessLookupError, PermissionError):
                        os.killpg(proc.pid, signal.SIGKILL)
                    await proc.wait()
    tail = out_path.read_text("utf-8", errors="replace")[-3000:]
    shutil.rmtree(scratch, ignore_errors=True)
    if ok:
        return {"name": "server start", "ok": True, "tail": f"answered in {time.monotonic() - started:.1f} s"}
    return {"name": "server start", "ok": False, "tail": f"{why}\n{tail}".strip()}


async def run_gates(tree: Path, touched: list[str], *, scratch: Path | None = None,
                    box: "ticket_box.Box | None" = None) -> dict[str, Any]:
    """The gates for what a ticket touched: tsc and frontend tests for frontend files, pytest, an import and boot_check
    for backend modules, `prompts.load` for prompt files, each without THIMBLE_* env, and each in `box` when given (a
    contained ticket: ticket_box). {ok, steps: [{name, ok, tail}]}. Seam for tests."""
    async def run(cmd: list[str], cwd: Path, timeout: float, env: dict[str, str] | None = None) -> tuple[int, str]:
        if box is not None:
            return await ticket_box.run(box, cmd, cwd=cwd, timeout=timeout, env=env)
        return await _run(cmd, cwd=cwd, timeout=timeout, environ=_gate_environ(env))

    steps: list[dict[str, Any]] = []
    frontend = [p for p in touched if p.startswith("frontend/")]
    backend = [p for p in touched if p.startswith("backend/")]
    prompt_files = [p for p in touched if p.startswith("prompts/") and p.endswith(".md")]
    fe = tree / "frontend"
    if frontend and (fe / "node_modules").exists():
        tsc = [str(fe / "node_modules" / ".bin" / "tsc")] if box is not None else ["npx", "tsc"]
        checks = [("tsc", [*tsc, "--noEmit", "-p", "tsconfig.app.json"])]
        fe_tests = _frontend_tests(fe, box is not None)
        if fe_tests:
            checks.append(fe_tests)
        results = await asyncio.gather(*(run(cmd, fe, GATE_TIMEOUT_S) for _, cmd in checks), return_exceptions=True)
        for (name, _), res in zip(checks, results):
            if isinstance(res, BaseException):
                steps.append({"name": name, "ok": False, "tail": f"{type(res).__name__}: {res}"[-3000:]})
            else:
                code, out = res
                steps.append({"name": name, "ok": code == 0, "tail": out[-3000:]})
    elif frontend:
        steps.append({"name": "tsc", "ok": False, "tail": "frontend/node_modules is missing in the worktree"})
    if backend:
        tests = _tests_for(touched, tree)
        py = tree / "backend" / ".venv" / "bin" / "python"
        if tests and py.exists():
            ws = scratch or (box.cache / "gate-workspaces" if box is not None else tree / ".gate-workspaces")
            code, out = await run([str(py), "-m", "pytest", *tests, "-q", "-p", "no:cacheprovider"], tree / "backend",
                                  GATE_TIMEOUT_S, {"THIMBLE_SKIP_KEY": "1", "THIMBLE_WORKSPACES_DIR": str(ws)})
            steps.append({"name": f"pytest {' '.join(tests)}", "ok": code == 0, "tail": out[-3000:]})
        elif not py.exists():
            steps.append({"name": "pytest", "ok": False, "tail": "backend/.venv is missing in the worktree"})
        else:
            steps.append({"name": "pytest", "ok": True, "tail": "no tests match the touched modules (skipped)"})
        # a module the ticket deleted is not imported: its absence is what the ticket asked for
        mods = [p for p in backend if p.startswith("backend/app/") and p.endswith(".py") and (tree / p).is_file()]
        if mods and py.exists():
            names = ", ".join(f"app.{Path(p).stem}" for p in mods)
            code, out = await run([str(py), "-c", f"import {names}"], tree / "backend", 120, {"THIMBLE_SKIP_KEY": "1"})
            steps.append({"name": f"import {names}", "ok": code == 0, "tail": out[-2000:]})
        if any(p.startswith(BOOT_PREFIXES) for p in backend) and py.exists():
            steps.append(await (ticket_box.boot_check(box, port=STACK_API_PORT) if box is not None else boot_check(tree)))
    if prompt_files:
        py = tree / "backend" / ".venv" / "bin" / "python"
        names = [p[len("prompts/"):-3] for p in prompt_files if (tree / p).exists()]
        if names and py.exists():
            code, out = await run([str(py), "-c", "import sys; from app import prompts\n"
                                   "for n in sys.argv[1:]: prompts.load(n)\nprint('ok')", *names], tree / "backend", 60,
                                  {"THIMBLE_PROMPTS_DIR": str(tree / "prompts")})
            steps.append({"name": "prompts load", "ok": code == 0, "tail": out[-2000:]})
    return {"ok": all(s["ok"] for s in steps), "steps": steps}


def _gate_report(v: dict[str, Any]) -> str:
    lines = []
    for s in v.get("steps", []):
        lines.append(f"[{'ok' if s['ok'] else 'FAILED'}] {s['name']}")
        if not s["ok"] and s.get("tail"):
            lines += ["    " + ln for ln in s["tail"].strip().splitlines()[-40:]]
    return "\n".join(lines) or "(no gates applied)"


def stack_script() -> Path:
    return REPO / "scripts" / "dev" / "dev_stack.sh"


async def start_stack(tid: str, wt: Path, workspace: str | None) -> dict[str, str] | None:
    """`scripts/dev/dev_stack.sh start` on the worktree (8301/5301, a snapshot copy of the workspace). None when disabled
    or unavailable. Seam for tests."""
    if not STACK_ENABLED or not stack_script().is_file() or not (wt / "frontend" / "node_modules").exists():
        return None
    if not (thimble_home() / "server.json").is_file():
        return None
    snap = worktrees_dir() / f"{tid}.workspaces"
    cmd = ["bash", str(stack_script()), "start", "--worktree", str(wt), "--workspaces", str(snap)]
    if workspace:
        cmd += ["--corpus", workspace]
    code, out = await _run(cmd, cwd=REPO, timeout=STACK_WAIT_S + 30)
    if code != 0:
        log.warning("dev stack did not start: %s", out[-500:])
        return None
    return {"ui": f"http://127.0.0.1:{STACK_UI_PORT}", "api": f"http://127.0.0.1:{STACK_API_PORT}"}


async def stop_stack(tid: str | None = None) -> None:
    if not stack_script().is_file():
        return
    await _run(["bash", str(stack_script()), "stop"], cwd=REPO, timeout=60)
    if tid:
        shutil.rmtree(worktrees_dir() / f"{tid}.workspaces", ignore_errors=True)


# ----------------------------------------------------------------------------- screenshots


def shot_script() -> Path:
    """The page screenshot script, outside scripts/dev/ since main's `screenshot` tool runs it in every install."""
    return REPO / "scripts" / "ui_shot.mjs"


async def run_shot(url: str, out: Path, selector: str | None = None, *, info_out: Path | None = None,
                   viewport: str | None = None, scale: float | None = None, storage: dict[str, str] | None = None,
                   press: list[str] | None = None, wait_ms: int | None = None, offline: bool = False,
                   own_origin: bool = False) -> int:
    """`node scripts/ui_shot.mjs`: 0 ok, 2 selector not found (the viewport is written instead), 1 error, -1 timeout.
    Options map to the script's options of the same names. headless.Missing when the browser is missing, which stays so
    for the rest of the server run."""
    path = headless.launch(headless.PAGES)
    if path is None or headless.missing(headless.PAGES):
        raise headless.Missing(headless.missing(headless.PAGES))
    cmd = ["node", str(shot_script()), "--url", url, "--out", str(out), *(["--offline"] if offline else []),
           *(["--own-origin"] if own_origin else [])]
    if selector:
        cmd += ["--selector", selector]
    if info_out is not None:
        cmd += ["--info", str(info_out)]
    if viewport:
        cmd += ["--viewport", viewport]
    if scale:
        cmd += ["--scale", str(scale)]
    for k, v in (storage or {}).items():
        cmd += ["--storage", f"{k}={v}"]
    for key in press or []:
        cmd += ["--press", key]
    if wait_ms is not None:
        cmd += ["--wait", str(int(wait_ms))]
    env = {**os.environ, **({userconf.BROWSER_ENV: path} if path else {})}
    proc = await asyncio.create_subprocess_exec(*cmd, cwd=str(REPO), stdout=asyncio.subprocess.PIPE,
                                                stderr=asyncio.subprocess.PIPE, env=env)
    try:
        _, err = await asyncio.wait_for(proc.communicate(), SHOT_TIMEOUT_S)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        log.warning("ui_shot timed out for %s", url)
        return -1
    if proc.returncode not in (0, 2):
        text = err.decode(errors="replace")
        if gone := headless.why_missing(text):
            headless.mark_missing(headless.PAGES, gone)
            raise headless.Missing(gone)
        log.warning("ui_shot exit %s for %s: %s", proc.returncode, url, text[-500:])
    return proc.returncode if proc.returncode is not None else -1


def rebase_url(target: dict[str, Any] | None, base: str) -> str:
    """The target's path and query on `base` (the validation stack's UI)."""
    t = target if isinstance(target, dict) else {}
    parts = urlsplit(str(t.get("url") or ""))
    path = parts.path or "/"
    if not path.startswith("/"):
        path = "/" + path
    return base.rstrip("/") + path + (f"?{parts.query}" if parts.query else "")


def target_selector(target: dict[str, Any] | None) -> str | None:
    t = target if isinstance(target, dict) else {}
    return str(t.get("stable_selector") or t.get("selector") or "") or None


async def _take_shot(t: dict[str, Any], run_log: Log, phase: str, base_url: str | None, *,
                     own_origin: bool = False) -> str | None:
    """The before or after shot of the ticket's target on the stack (`own_origin` for a server in the ticket's box,
    whose page then reaches nothing but that server); the file name stored on the ticket, or None."""
    if not base_url:
        return None
    selector = target_selector(t.get("target"))
    url = rebase_url(t.get("target"), base_url)
    d = shots_dir(t["id"])
    d.mkdir(parents=True, exist_ok=True)
    out = d / f"{phase}.png"
    try:
        code = await run_shot(url, out, selector, own_origin=own_origin)
    except Exception as e:  # noqa: BLE001
        run_log.stage(f"{phase} shot failed: {type(e).__name__}: {e}")
        return None
    stored = out.name if code in (0, 2) and out.is_file() else None
    note = "" if code == 0 or not selector else " (selector not found; the viewport instead)" if code == 2 else f" (exit {code})"
    _update(t["id"], **{f"{phase}_shot": stored})
    if stored:
        run_log.shot(t["id"], phase, stored, "the viewport; the selector was not found" if code == 2 and selector else "")
    else:
        run_log.stage(f"{phase} shot failed{note}")
    return stored


# ----------------------------------------------------------------------------- the worker: a Claude Code background session


def _fence(*texts: str) -> str:
    n = 3
    for t in texts:
        run = 0
        for ch in t:
            run = run + 1 if ch == "`" else 0
            n = max(n, run + 1)
    return "`" * n


def fenced(label: str, text: str) -> str:
    f = _fence(text)
    return f"{label} (data):\n{f}\n{text or '-'}\n{f}"


def summarize_input(name: str, inp: Any) -> dict[str, Any]:
    """What the log shows for a tool call: the path, command, pattern or url, never file contents."""
    d = inp if isinstance(inp, dict) else {}
    out: dict[str, Any] = {}
    for key in ("file_path", "path", "command", "pattern", "description", "url", "selector", "title"):
        if key in d and isinstance(d[key], (str, int, float)):
            out[key] = str(d[key])[:300]
    if not out and d:
        out["keys"] = sorted(map(str, d))[:10]
    return out


def _result_text(content: Any) -> str:
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    parts: list[str] = []
    for item in content if isinstance(content, list) else [content]:
        if isinstance(item, dict):
            if item.get("type") == "text":
                parts.append(str(item.get("text", "")))
            elif item.get("type") == "image":
                parts.append("[image]")
        else:
            parts.append(str(item))
    return "\n".join(parts)


def _cli_env() -> dict[str, str]:
    """The environment the `claude` commands run with: this server's, less an inherited Claude Code session identity
    (config.passes: it would make the new session look nested) and THIMBLE_*, with the analyst's CLAUDE_CONFIG_DIR
    (config.claude_env)."""
    return config.claude_env({k: v for k, v in config.passed_environ().items() if not k.startswith("THIMBLE_")})


class SessionError(RuntimeError):
    """A background session that could not start, did not end its turn, or ended it any way but done. Its message is
    written for the analyst and becomes the ticket's error as it is."""


# `claude --bg` refuses a folder Claude Code does not trust. A code ticket's worktree is trusted when the live checkout
# is, so the line names the checkout rather than the temporary worktree.
UNTRUSTED_RE = re.compile(r"not trusted", re.IGNORECASE)
UNTRUSTED_LINE = ("Claude Code does not trust {folder}, so the dev agent's session could not start. Run `claude` in "
                  "{folder} once and accept its trust prompt, then Retry.")


def read_only_fence(folders: "tuple[Path, ...] | list[Path]", outside: "tuple[str, ...] | list[str]" = (),
                    conf: "userconf.Session | None" = None) -> dict[str, Any]:
    """The --settings keys that keep `folders` unchanged by a background session: a deny of Edit in each (which Claude
    Code's path checks also apply to Bash commands naming those files) and, where the session's Bash runs in the
    sandbox (`conf`, by default where the sandbox can run), the sandbox, with no network unless the config's is on,
    which turns the deny into a write deny for scripts too, and whose commands run unasked unless the config asks about
    some; `outside` commands run outside it. Reads stay allowed. {} for no folders."""
    if not folders:
        return {}
    out: dict[str, Any] = {"permissions": {"deny": [f"Edit(/{Path(f)}/**)" for f in folders]}}
    if conf.sandboxed if conf is not None else cc_settings.sandbox_ok():
        box = cc_settings.offline_sandbox(auto_allow=not (conf and conf.install_asks()),
                                          network=bool(conf and conf.network), required=bool(conf and conf.enforced))
        out["sandbox"] = {**box, **({"excludedCommands": list(outside)} if outside else {})}
    return out


def agent_row(key: str) -> str:
    """The row of the permission modes (modes.AGENTS) a dev session asks by: the dev agent's, for a view build too."""
    return "dev"


def dev_config(workspace: str | None, *, sandbox: bool, hosted: bool = True) -> userconf.Session:
    """What thimble's config asks of a dev session (userconf.session): `sandbox` for a view build, whose Bash runs in the
    sandbox where it can; `hosted` False for one nobody can answer (module note, permissions). ConfigError as
    userconf.session raises it."""
    conf = userconf.session(workspace, "dev", sandbox=sandbox)
    if not hosted:
        conf.hosted = False
    return conf


def own_work(folder: Path, reads: "tuple[Path, ...] | list[Path]" = ()) -> list[str]:
    """The allow rules of a session's work in its own folder `folder`: edits there, and reads of `reads`."""
    return [f"Edit(/{Path(folder)}/**)", *(f"Read(/{Path(r)}/**)" for r in reads)]


def _host(c: str | None, asking: dict[str, Any], chat: str | None, run_log: "Log") -> None:
    """Answer the permission requests of the session `asking` names (Sessions._flags) on its chat, each denied
    unanswered noted in the thread (module note, permissions); nothing without a workspace or a chat."""
    from . import agent_session  # noqa: PLC0415

    if not c or not chat:
        return

    def expired(_run: Any, entry: dict[str, Any]) -> None:
        run_log.stage(EXPIRED_LINE.format(tool=entry.get("tool"), what=entry.get("what"),
                                          wait=agent_session.wait_words(PERMISSION_WAIT_S)))

    box = asking.get("sandbox")
    agent_session.host(c, str(asking["key"]), chat, agent=agent_row(str(asking["key"])), wait_s=PERMISSION_WAIT_S,
                       on_expired=expired, sandbox=(list(box[0]), list(box[1])) if box else None,
                       conf=asking.get("config"))


def _unhost(c: str | None, key: str) -> None:
    from . import agent_session  # noqa: PLC0415

    if c:
        agent_session.unhost(c, key)


def trust_folder(cwd: Path) -> Path:
    """The folder the analyst must trust for a session in `cwd`: the live checkout for a ticket's worktree, else cwd."""
    try:
        return REPO if Path(cwd).resolve().is_relative_to(worktrees_dir().resolve()) else Path(cwd)
    except OSError:
        return Path(cwd)


def ticket_fence(wt: Path, network: bool = False, required: bool = False) -> dict[str, Any]:
    """The --settings of a code ticket's session whose Bash runs in the sandbox: no network unless the dev agent's is
    on, and writes to the worktree, its session's folder, and to what a commit there writes into the checkout's git
    folder: the objects, the ticket branch's ref and its log, and the worktree's own git folder. The git folder's hooks
    and config stay read-only. `required` as cc_settings.offline_sandbox takes it."""
    common = Path(_git(wt, "rev-parse", "--path-format=absolute", "--git-common-dir"))
    own = Path(_git(wt, "rev-parse", "--absolute-git-dir"))
    group = Path(_git(wt, "symbolic-ref", "--short", "HEAD")).parent  # `dev` of dev/<id>
    box = cc_settings.offline_sandbox(network=network, required=required)
    box["filesystem"] = {"allowWrite": [str(common / "objects"), str(common / "refs" / "heads" / group),
                                        str(common / "logs" / "refs" / "heads" / group), str(own)]}
    return {"sandbox": box}


class Sessions:
    """Claude Code background sessions through the `claude` CLI: `claude --bg` starts one and prints its short id,
    `claude agents --json --all --cwd` reports its state, `claude --bg --resume <session id>` wakes it with a new
    message, and `claude stop` ends its process while keeping the conversation. Tests replace dev.SESSIONS with a fake.
    """

    async def _run(self, args: list[str], cwd: Path, env: dict[str, str] | None = None) -> tuple[int, str]:
        return await _run([CLAUDE_BIN, *args], cwd=cwd, timeout=CLI_TIMEOUT_S, env=None, environ={**_cli_env(), **(env or {})})

    def problem(self) -> str:
        """Why no session can start here, '' when the CLI is on the PATH (runner_problem)."""
        return "" if shutil.which(CLAUDE_BIN, path=_cli_env().get("PATH")) else NO_CLAUDE_LINE.format(bin=CLAUDE_BIN)

    def _flags(self, workspace: str | None, name: str, add_dirs: "tuple[Path, ...] | list[Path]" = (),
               fence: dict[str, Any] | None = None, asking: dict[str, Any] | None = None,
               models: dict[str, Any] | None = None) -> list[str]:
        """The session's flags: its `models` ({model, effort, fast}, where None leaves one to the analyst's Claude Code
        settings), else the dev role's, `--add-dir` folders, the `fence` settings, thimble's config for the dev agent and
        how it asks (module note, permissions). `asking` names the session's key, {key, allow, sandbox?, config?}, the
        allow rules of its work in its own folder, for a session whose Bash runs in the sandbox, sandbox_allow's rule,
        and what the config asks of it (dev_config); with it and a workspace, the permission hook answers its requests by
        the dev agent's mode, and a process in Auto runs in auto mode. Without, it keeps UNHOSTED_TOOLS and gets no web
        tools. It gets no MCP server, since its task needs none of the analyst's, not the tools that schedule a later
        turn (agent_session.LATER_TOOLS), since the session is stopped once its turn ends, and, when fenced, not
        FENCED_OFF_TOOLS."""
        from . import agent_session  # noqa: PLC0415 — agent_session is large and this module otherwise needs none of it

        conf_models = models or config.models_for(workspace)["dev"]
        hosted = bool(workspace and asking and asking.get("key"))
        conf = (asking or {}).get("config") or dev_config(workspace, sandbox=bool(fence and "sandbox" in fence),
                                                           hosted=hosted)
        denied = [*agent_session.LATER_TOOLS, *(FENCED_OFF_TOOLS if fence else ())]
        settings: dict[str, Any] = {} if conf_models.get("fast") is None else {"fastMode": bool(conf_models["fast"])}
        settings.update(fence or {})
        settings = agent_session.with_config(settings, conf.settings())
        mode = modes.flag(modes.mode_for(str(workspace), "dev")) if hosted else "default"
        if hosted:
            perms = dict(settings.get("permissions") or {})
            allow = [*(perms.get("allow") or []), *(asking or {}).get("allow", [])]
            settings["permissions"] = {**perms, **({"allow": list(dict.fromkeys(allow))} if allow else {})}
            if conf.web == "ask":
                settings = agent_session.with_web_asks(settings, mode)
            hooks = agent_session.permission_hooks(str(workspace), mode == "auto", session=str((asking or {})["key"]),
                                                   home=str(thimble_home()), wait=conf.may_ask())
            box = (asking or {}).get("sandbox")
            if box and "sandbox" in settings:
                # before a call both hooks run; a request is the permission hook's alone, which applies the same rule
                pre = agent_session.sandbox_hooks((list(box[0]), list(box[1])), conf.install_asks())[agent_session.PRE]
                hooks[agent_session.PRE] = [*pre, *hooks.get(agent_session.PRE, [])]
            settings["hooks"] = hooks
        if not hosted or conf.web == "off":
            denied += agent_session.WEB_TOOLS
        allowed = [] if hosted else ["--allowedTools", ",".join(UNHOSTED_TOOLS)]
        flags = ["-n", name, *(["--model", str(conf_models["model"])] if conf_models.get("model") else []), *allowed,
                 "--disallowedTools", ",".join(dict.fromkeys(denied)), "--strict-mcp-config", "--permission-mode", mode]
        for d in add_dirs:
            flags += ["--add-dir", str(d)]
        if conf_models.get("effort"):
            flags += ["--effort", str(conf_models["effort"])]
        if settings:
            flags += ["--settings", json.dumps(settings)]
        return flags

    async def start(self, cwd: Path, prompt: str, *, name: str, workspace: str | None,
                    add_dirs: "tuple[Path, ...] | list[Path]" = (), env: dict[str, str] | None = None,
                    fence: dict[str, Any] | None = None, asking: dict[str, Any] | None = None,
                    models: dict[str, Any] | None = None) -> dict[str, str]:
        """A new background session in `cwd` whose first message is `prompt`, with `env` over the CLI's environment, the
        settings `fence`, how it asks, `asking`, and its `models` (_flags). {id, session_id}; RuntimeError when the CLI
        could not start one."""
        since = time.time() * 1000 - 5000
        flags = self._flags(workspace, name, add_dirs, fence, asking, models)
        code, out = await self._run(["--bg", *flags, "--", prompt], cwd, env)
        if code != 0 and UNTRUSTED_RE.search(out):
            raise SessionError(UNTRUSTED_LINE.format(folder=trust_folder(cwd)))
        if code != 0:
            raise SessionError(f"`claude --bg` failed (exit {code}): {out.strip()[-400:]}")
        return await self._identify(cwd, _bg_id(out), since)

    async def resume(self, cwd: Path, session_id: str, prompt: str, *, env: dict[str, str] | None = None,
                     name: str = "", workspace: str | None = None,
                     add_dirs: "tuple[Path, ...] | list[Path]" = (),
                     fence: dict[str, Any] | None = None, asking: dict[str, Any] | None = None,
                     models: dict[str, Any] | None = None) -> dict[str, str]:
        """Wake the session `session_id` with `prompt` in a copy under a new id, started with the same flags as a new
        session (_flags), since Claude Code keeps none of a stopped session's options. A process that still runs is
        stopped first; the caller follows the copy by the returned ids."""
        short = session_id[:8]
        await self._running(cwd, short)
        flags = self._flags(workspace, name, add_dirs, fence, asking, models)
        code, out = await self._run(["--bg", "--resume", session_id, *flags, "--", prompt], cwd, env)
        if code != 0:
            raise SessionError(f"`claude --bg --resume` failed (exit {code}): {out.strip()[-400:]}")
        return await self._identify(cwd, _bg_id(out) or short, 0)

    async def _running(self, cwd: Path, short: str) -> bool:
        """Whether the session's process is still up (the listing's `pid`) after `claude stop` and a wait of up to
        UNLISTED_POLLS seconds for it to exit."""
        for n in range(UNLISTED_POLLS):
            hit = next((e for e in await self._listing(cwd) if e.get("id") == short), None)
            if hit is None or not hit.get("pid"):
                return False
            if n == 0:
                await asyncio.to_thread(self.stop, short)
            await asyncio.sleep(1.0)
        return True

    async def _listing(self, cwd: Path) -> list[dict[str, Any]]:
        code, out = await self._run(["agents", "--json", "--all", "--cwd", str(cwd)], cwd)
        if code != 0:
            return []
        try:
            data = json.loads(out[out.index("["):]) if "[" in out else []
        except ValueError:
            return []
        return [e for e in data if isinstance(e, dict) and e.get("kind", "background") == "background"]

    async def _identify(self, cwd: Path, short: str | None, since_ms: float) -> dict[str, str]:
        """The session's short and full ids: the `claude agents` entry with the printed short id, else the newest one
        started in `cwd` since the call. Only an entry whose session id begins with its id counts (_names_itself), since
        right after a resume the listing can briefly pair the id with another session id."""
        for _ in range(UNLISTED_POLLS):
            entries = [e for e in await self._listing(cwd) if _names_itself(e)]
            hit = next((e for e in entries if short and e.get("id") == short), None)
            if hit is None and not short:
                recent = [e for e in entries if float(e.get("startedAt") or 0) >= since_ms]
                hit = max(recent, key=lambda e: float(e.get("startedAt") or 0), default=None)
            if hit is not None and hit.get("sessionId"):
                return {"id": str(hit.get("id") or str(hit["sessionId"])[:8]), "session_id": str(hit["sessionId"])}
            await asyncio.sleep(IDENTIFY_POLL_S)
        raise SessionError("the background session did not appear in `claude agents`")

    async def state(self, cwd: Path, short: str) -> str | None:
        """The session's state as `claude agents` reports it, or None when not listed; `idle` for a session whose
        process is idle while its state says working. That state summarizes whether the task looks finished, not whether
        the turn is, so the caller decides from the transcript."""
        hit = next((e for e in await self._listing(cwd) if e.get("id") == short), None)
        if hit is None:
            return None
        state = str(hit.get("state") or hit.get("status") or "")
        if state == "working" and hit.get("status") == "idle":
            return "idle"
        return state or None

    def stop(self, short: str | None) -> None:
        """End the session's process; its conversation stays. Blocking and quick; never raises."""
        if not short:
            return
        try:
            subprocess.run([CLAUDE_BIN, "stop", short], capture_output=True, text=True, timeout=CLI_TIMEOUT_S,
                           env=_cli_env())
        except (OSError, subprocess.SubprocessError):
            log.debug("could not stop background session %s", short, exc_info=True)

    def transcript(self, session_id: str) -> Path | None:
        found = find_transcript(session_id)
        return Path(found) if found else None


SESSIONS = Sessions()
_BG_ID_RE = re.compile(r"^backgrounded\W+([0-9a-f]{8})\b", re.MULTILINE)
IDENTIFY_POLL_S = 1.0  # between two listings while a session is identified (Sessions._identify)


def _names_itself(entry: dict[str, Any]) -> bool:
    """Whether a `claude agents` entry's session id is the session its id names: a background session's id is the
    first eight characters of its session id (Sessions._identify)."""
    short, sid = str(entry.get("id") or ""), str(entry.get("sessionId") or "")
    return not short or not sid or sid.startswith(short)


def _bg_id(out: str) -> str | None:
    """The short id `claude --bg` prints on its `backgrounded · <id> · <name>` line, or None."""
    m = _BG_ID_RE.search(out or "")
    return m.group(1) if m else None


class Tail:
    """A background session's transcript read as it grows, written into the ticket's chat: the assistant's text and tool
    calls (summarized, never file contents) and the results that answer them. Other records and lines that do not parse
    are skipped: the chat is a view of the session, and the session itself stays the record (`claude attach`)."""

    def __init__(self, session_id: str, pos: int = 0, *, after: str | None = None, copied: "set[str] | None" = None) -> None:
        self.session_id = session_id
        self.path: Path | None = None  # found once: the lookup globs every project folder of the Claude config
        self.pos = pos
        self.last_text = ""  # the assistant's last text in the latest turn: the session's report
        self.turn_ended = False  # the latest turn's `turn_duration` record has been read
        self.api_error = False  # the latest turn ended on Claude Code's API error message (`isApiErrorMessage`)
        # When the transcript begins with a copy of an earlier conversation (a resume that landed in a new session): the
        # uuids of the copied records, which are skipped, and the message that opens the turn to follow. Both are
        # needed, since a wake's message can repeat an earlier one word for word.
        self.copied = copied or set()
        self.after = after.strip() if after else None

    def read(self, run_log: Log) -> None:
        path = self.path = self.path or SESSIONS.transcript(self.session_id)
        if path is None:
            return
        try:
            with path.open("rb") as f:
                f.seek(self.pos)
                chunk = f.read()
        except OSError:
            return
        end = chunk.rfind(b"\n")
        if end < 0:
            return
        self.pos += end + 1
        for line in chunk[:end].splitlines():
            try:
                rec = json.loads(line)
            except ValueError:
                continue
            if isinstance(rec, dict) and not rec.get("isSidechain"):
                self._record(rec, run_log)

    def _record(self, rec: dict[str, Any], run_log: Log) -> None:
        msg = rec.get("message") if isinstance(rec.get("message"), dict) else {}
        content = msg.get("content")
        if rec.get("uuid") in self.copied:
            return
        if self.after is not None:
            if rec.get("type") == "user" and isinstance(content, str) and content.strip() == self.after:
                self.after = None
            else:
                return
        if rec.get("type") == "user" and isinstance(content, str):
            self.last_text, self.turn_ended, self.api_error = "", False, False  # a new message opens a new turn
            return
        if rec.get("type") == "assistant":
            self.api_error = bool(rec.get("isApiErrorMessage"))
        if rec.get("type") == "system" and rec.get("subtype") == "turn_duration":
            self.turn_ended = True
            return
        for b in content if isinstance(content, list) else []:
            if not isinstance(b, dict):
                continue
            if rec.get("type") == "assistant" and b.get("type") == "text" and str(b.get("text") or "").strip():
                self.last_text = str(b["text"]).strip()
                run_log.text(self.last_text + "\n")
            elif rec.get("type") == "assistant" and b.get("type") == "tool_use":
                run_log.tool_use(str(b.get("id") or ""), str(b.get("name") or ""), summarize_input(str(b.get("name")), b.get("input")))
            elif rec.get("type") == "user" and b.get("type") == "tool_result":
                run_log.tool_result(str(b.get("tool_use_id") or ""), _result_text(b.get("content")), is_error=bool(b.get("is_error")))


def _uuids(p: Path | None) -> set[str]:
    """The uuids of a transcript's records (empty when there is none)."""
    out: set[str] = set()
    if p is None:
        return out
    try:
        with p.open("rb") as f:
            for line in f:
                try:
                    rec = json.loads(line)
                except ValueError:
                    continue
                if isinstance(rec, dict) and rec.get("uuid"):
                    out.add(str(rec["uuid"]))
    except OSError:
        pass
    return out


def _size(p: Path | None) -> int:
    try:
        return p.stat().st_size if p is not None else 0
    except OSError:
        return 0


async def _worker_turn(run: Run, run_log: Log, cwd: Path, prompt: str, resume: str | None, *, name: str,
                       workspace: str | None, on_session: Callable[[str, str], Any],
                       add_dirs: "tuple[Path, ...] | list[Path]" = (), env: dict[str, str] | None = None,
                       answered: bool = True, fence: dict[str, Any] | None = None,
                       turn_timeout_s: float | None = None, asking: dict[str, Any] | None = None,
                       models: dict[str, Any] | None = None) -> str:
    """One turn of a ticket's background session, started with `prompt` or woken with it when `resume` names the
    session, then watched until the turn ends, its transcript copied into the chat. The transcript is read every POLL_S;
    while it grows the session works, and once it is quiet `claude agents` is asked for the session's state, at gaps that
    double up to STATE_GAP_MAX_S while that state stays working or blocked. `on_session(short id, full id)` records the
    session. Returns the session's report; SessionError when it ended any way but done, ran past
    TURN_TIMEOUT_S (not counting the time its permission requests wait on the card), or waited ASK_TIMEOUT_S on a
    question (the session is then stopped). With `answered` False, a
    `blocked` session whose transcript shows its turn ended counts as ended, since Claude Code lists a finished turn
    `blocked` when its last message reads as a question. A turn that ended on an API error is not a question: a view
    ticket's turn returns the error text, a code ticket's raises it. `asking` is how it asks and `models` its model
    settings (Sessions._flags); while one of its permission requests waits on the card, it is no question."""
    from . import agent_session  # noqa: PLC0415

    fenced = {**({"fence": fence} if fence else {}), **({"asking": asking} if asking else {}),
              **({"models": models} if models else {})}
    key = str((asking or {}).get("key") or "")
    if workspace and key.startswith("view:") and (program := view_program(workspace)) is not None:
        return await program_view_turn(workspace, key[len("view:"):], prompt, list(add_dirs), program, run_log.rec)
    if resume:
        tail = Tail(resume, _size(SESSIONS.transcript(resume)))
        sess = await SESSIONS.resume(cwd, resume, prompt, env=env, name=name, workspace=workspace,
                                     add_dirs=add_dirs, **fenced)
        if sess["session_id"] != resume:
            # the resume started a copy under a new id: follow the turn in the copy's transcript
            tail = Tail(sess["session_id"], after=prompt, copied=_uuids(SESSIONS.transcript(resume)))
    else:
        sess = await SESSIONS.start(cwd, prompt, name=name, workspace=workspace, add_dirs=add_dirs, env=env,
                                    **fenced)
        tail = Tail(sess["session_id"])
    run.session, run.session_id = sess["id"], sess["session_id"]
    on_session(run.session, run.session_id)
    if answered:
        run_log.stage(f"background session {run.session} woken" if resume else
                      f"background session {run.session} (`claude attach {run.session}` opens it)")
    waiting, unlisted, early, idle = False, 0, 0, 0
    started = time.monotonic()
    limit = TURN_TIMEOUT_S if turn_timeout_s is None else turn_timeout_s
    asked_at = 0.0
    gap, looked = POLL_S, 0.0  # between two looks at the session's state, which doubles while it stays the same
    carded, card_from = 0.0, None  # time with a permission request on the card, which the turn's limit leaves out
    while True:
        await asyncio.sleep(POLL_S)
        pos = tail.pos
        tail.read(run_log)
        now = time.monotonic()
        on_card = bool(key and workspace and agent_session.asking(workspace, key))
        if on_card and card_from is None:
            card_from = now
        elif not on_card and card_from is not None:
            carded, card_from = carded + now - card_from, None
        if now - started - carded - (now - card_from if card_from is not None else 0.0) > limit:
            state = "timed out"
            break
        if waiting and time.monotonic() - asked_at > ASK_TIMEOUT_S:
            state = "unanswered"
            break
        if tail.pos != pos and not tail.turn_ended:
            unlisted, gap = 0, POLL_S
            if not waiting:
                continue  # the transcript grew: the session works
            looked = 0.0  # it grew while the session waited for an answer: its state says whether it still waits
        if not tail.turn_ended and time.monotonic() - looked < gap:
            continue
        state = await SESSIONS.state(cwd, run.session)
        looked = time.monotonic()
        gap = min(gap * 2, STATE_GAP_MAX_S) if state in ("working", "blocked") else POLL_S
        if state == "working":
            waiting, unlisted = False, 0
            continue
        if state == "idle":
            # the process is idle while the listing says working: the turn is over once the transcript says so, or after
            # as many polls as a session may go unlisted
            idle += 1
            if tail.turn_ended or idle > UNLISTED_POLLS:
                state = "done"
                break
            continue
        if state == "blocked":
            # Claude Code lists the session blocked a moment before the transcript's turn_duration record, so read it
            # again first
            tail.read(run_log)
            if tail.turn_ended and (tail.api_error or not answered):
                state = "done" if not answered else "api error"
                break
            if key and workspace and agent_session.asking(workspace, key):
                waiting = False  # it waits on the card, which denies the request in time
                continue
            if not waiting:
                if not tail.api_error:
                    run_log.stage(f"the session is waiting for an answer; `claude attach {run.session}` opens it")
                waiting, asked_at = True, time.monotonic()
            continue
        if state is None and unlisted < UNLISTED_POLLS:
            unlisted += 1
            continue
        if state == "done" and not tail.turn_ended and early < UNLISTED_POLLS:
            early += 1  # a woken session can still list its last turn's `done` before this turn begins
            continue
        break
    tail.read(run_log)
    # Stopping an idle session frees its process; a follow-up starts it again (Sessions.resume).
    await asyncio.to_thread(SESSIONS.stop, run.session)
    if state == "timed out":
        raise SessionError(f"the session had not finished after {_minutes(limit)}, so it was stopped; Retry "
                           "wakes it again")
    if state == "unanswered":
        raise SessionError(f"the session waited {_minutes(ASK_TIMEOUT_S)} for an answer nobody gave, so it was "
                           f"stopped; `claude attach {run.session}` shows its question, and Retry wakes it again")
    if state != "done":
        # the session's last words are most often the reason, so they go in the error
        last = " ".join(tail.last_text.split())[:SESSION_WORDS_CHARS]
        if state == "api error":
            raise SessionError(f"Anthropic's API ended the session's turn: {last}")
        raise SessionError(f"the background session ended {state or 'without a trace in claude agents'}"
                           + (f": {last}" if last else ""))
    return tail.last_text


SESSION_WORDS_CHARS = 300  # of a session's last text in the error of a session that ended any way but done


def _minutes(seconds: float) -> str:
    return f"{seconds / 60:.0f} min" if seconds >= 60 else f"{seconds:.0f} s"


# ----------------------------------------------------------------------------- the ticket run


def _target_lines(t: dict[str, Any]) -> str:
    tg = t.get("target") if isinstance(t.get("target"), dict) else {}
    if not tg:
        return "-"
    return json.dumps(tg, ensure_ascii=False)[:TARGET_CHARS]


def build_prompt(t: dict[str, Any], *, worktree: Path, ui_url: str, api_url: str, before_shot: str | None,
                 sandboxed: bool = False) -> str:
    with prompts.custom(userconf.prompt_files(t.get("workspace"), "dev")):
        return _ticket_prompt(t, worktree=worktree, ui_url=ui_url, api_url=api_url, before_shot=before_shot,
                              sandboxed=sandboxed)


# the code-ticket prompt's line on the stack's pages, by whether the session's Bash runs in the sandbox (TICKET_STACK)
TICKET_STACK_LINES = {
    False: ("The validation stack, UI {ui_url} and API {api_url}, reloads on your edits. To see a page of it, run "
            "`node scripts/ui_shot.mjs --url <page> --out <png> --selector '<css>'` and open the PNG with Read. Save "
            "shots under {shots}. The before shot of the ticket's target is {before}. After you commit, take an after "
            "shot of the target with the before shot's selector."),
    True: ("Your Bash runs in Claude Code's sandbox: it changes only this worktree and your commits, and there is no "
           "server for you to reach, so take no shots. The before shot of the ticket's target is {before}; open it with "
           "Read. The server takes the after shot once its gates pass."),
}


def _ticket_prompt(t: dict[str, Any], *, worktree: Path, ui_url: str, api_url: str, before_shot: str | None,
                   sandboxed: bool = False) -> str:
    before = (str(shots_dir(t["id"]) / before_shot) if before_shot else
              "(none: the stack was not available for a before shot)")
    return prompts.render_dev("dev-ticket", {
        "ticket": str(t["id"]),
        "title": str(t.get("title") or ""),
        "body": fenced("ticket", str(t.get("body") or "")),
        "target": fenced("captured target", _target_lines(t)),
        "source": str(t.get("source") or "ui"),
        "worktree": str(worktree),
        "ui_url": ui_url,
        "api_url": api_url,
        "stack": TICKET_STACK_LINES[sandboxed].format(shots=shots_dir(t["id"]), before=before, ui_url=ui_url,
                                                      api_url=api_url),
    })


def build_fix_prompt(t: dict[str, Any], *, worktree: Path, doctor: str) -> str:
    values = {"ticket": str(t["id"]), "title": str(t.get("title") or ""), "body": fenced("ticket", str(t.get("body") or "")),
              "worktree": str(worktree), "doctor": fenced("thimble doctor", doctor)}
    with prompts.custom(userconf.prompt_files(None, "dev")):
        return prompts.render_dev("dev-fix", values)


def build_gates_prompt(report: str) -> str:
    """The message that wakes a ticket's session when the server's gates fail over its work: a code ticket's branch
    (_gate_report) or a view ticket's folder (views.gate_lines)."""
    return prompts.render("dev-gates", {"report": fenced("gate output", report)})


async def _check(wt: Path, base: str, run_log: Log,
                 box: "ticket_box.Box | None" = None) -> tuple[list[str], dict[str, Any] | None]:
    """What the session's branch changed since `base`, and the gates over it (in `box` when given) with a failed
    `commit` step for changes it left uncommitted (None when it committed nothing and left nothing: there is nothing to
    check)."""
    touched = await asyncio.to_thread(branch_files, wt, base)
    left = await asyncio.to_thread(touched_files, wt)
    if not touched and not left:
        return [], None
    run_log.stage("gates over " + ", ".join(sorted(set(touched) | set(left))))
    validation = await run_gates(wt, sorted(set(touched) | set(left)), box=box)
    if left:
        validation = {"ok": False, "steps": [*validation["steps"], {"name": "commit", "ok": False,
                                                                     "tail": "uncommitted changes: " + ", ".join(left)}]}
    for s in validation["steps"]:
        run_log.stage(f"gate {s['name']}: {'ok' if s['ok'] else 'failed'}")
    return touched, validation


class TicketError(RuntimeError):
    """A ticket that cannot go on, with a message written for the analyst (runner_problem's lines)."""


class NotAllowed(TicketError):
    """The analyst did not allow the ticket's change into thimble's own code (module note, permissions): it ends
    stopped."""


class BranchMoved(TicketError):
    """The ticket's branch is not the change its gates checked: it ends `needs manual merge`, with nothing applied."""


def checked_change(wt: Path, branch: str, base: str, touched: list[str]) -> str:
    """The commit the analyst is asked to apply: the head of the ticket's branch, once its session has stopped.
    BranchMoved when the branch's files since `base` are not `touched`, the files its gates checked."""
    change = _git(wt, "rev-parse", "HEAD")
    if _diff_files(wt, base, change) != sorted(touched):
        raise BranchMoved(_manual_merge(touched, branch, BRANCH_MOVED))
    return change


# the card's tool name for thimble's questions about its own code (frontend chat/permissions.ts ASKS_TO)
CODE_TOOL = "ThimbleCode"
APPLY_QUESTION = "Apply this change to thimble's own code?"
APPLY_WHY = ("It changes {files}. thimble asks this before any change reaches its own code, in every permission mode. "
             "Unanswered, it is not applied after {wait}, and it stays on branch {branch}.")
APPLY_NOT_ALLOWED = ("the analyst did not allow the change into thimble's own code, so it was not applied; it stays on "
                     "branch {branch}")
# where the ticket's checks can't run in a box (ticket_box.problem), the question comes before the ticket starts too
CODE_QUESTION = ("This edits thimble's own code, which then runs outside the sandbox (its test server, its checks and "
                 "git). Allow?")
CODE_WHY = ("The ticket's checks can't run in a sandbox here ({why}), so thimble asks this before every code ticket, in "
            "every permission mode. Unanswered, the ticket is cancelled after {wait}.")
CODE_NOT_ALLOWED = "the analyst did not allow it to edit thimble's own code, so it did not start"
CODE_NOBODY = ("it has no workspace, so no permission card could ask the analyst about thimble's own code, and it did "
               "not start")
FILES_SHOWN = 8


def contained(conf: "userconf.Session | str | None") -> bool:
    """Whether a code ticket with the dev agent's config `conf` is contained: its session's Bash runs in the sandbox and
    its checks and preview server in a box (ticket_box)."""
    return isinstance(conf, userconf.Session) and conf.sandboxed and ticket_box.works()


async def _code_refusal(t: dict[str, Any]) -> str:
    """'' once the analyst allowed an uncontained ticket on its chat's card (CODE_QUESTION), else why it did not start."""
    from . import agent_session  # noqa: PLC0415

    if not t.get("workspace") or not t.get("chat"):
        return CODE_NOBODY
    why = CODE_WHY.format(why=ticket_box.problem() or "Claude Code's sandbox is off for the dev agent",
                          wait=agent_session.wait_words(PERMISSION_WAIT_S))
    got = await agent_session.ask(str(t["workspace"]), ticket_key(t["id"]), CODE_TOOL, {"description": CODE_QUESTION},
                                  force=True, why=why)
    return "" if got.get("behavior") == "allow" else CODE_NOT_ALLOWED


def files_words(touched: list[str]) -> str:
    shown = ", ".join(touched[:FILES_SHOWN])
    return shown + (f" and {len(touched) - FILES_SHOWN} more" if len(touched) > FILES_SHOWN else "") or "no files"


Approve = Callable[[dict[str, Any], list[str]], Awaitable[bool]]


async def _apply_refusal(t: dict[str, Any], touched: list[str], branch: str, approve: "Approve | None" = None) -> str:
    """'' once the analyst allowed the ticket's change into thimble's own code (APPLY_QUESTION), by `approve` when given
    (`thimble fix`, in the terminal), else on the ticket's card in every mode; else why it was not applied."""
    from . import agent_session  # noqa: PLC0415

    if approve is not None:
        allowed = await approve(t, touched)
    elif not t.get("workspace") or not t.get("chat"):
        return CODE_NOBODY
    else:
        why = APPLY_WHY.format(files=files_words(touched), wait=agent_session.wait_words(PERMISSION_WAIT_S),
                               branch=branch)
        got = await agent_session.ask(str(t["workspace"]), ticket_key(t["id"]), CODE_TOOL,
                                      {"description": APPLY_QUESTION, "files": touched}, force=True, why=why)
        allowed = got.get("behavior") == "allow"
    return "" if allowed else APPLY_NOT_ALLOWED.format(branch=branch)


def box_dir(tid: str) -> Path:
    """A contained ticket's cache folder, which its box writes (ticket_box)."""
    return worktrees_dir() / f"{tid}.box"


def box_host_dir(tid: str) -> Path:
    """The sandbox runtime's own folder for the ticket's box, outside it."""
    return worktrees_dir() / f"{tid}.srt"


def ticket_box_of(t: dict[str, Any], wt: Path) -> ticket_box.Box:
    """The ticket's box over its worktree, reading its workspace's corpus besides (for the preview server)."""
    reads: tuple[Path, ...] = ()
    if t.get("workspace"):
        with contextlib.suppress(ValueError):
            reads = (config.corpus_dir(str(t["workspace"])),)
    return ticket_box.Box(wt, box_dir(t["id"]), box_host_dir(t["id"]), reads, live=REPO)


def remove_box(tid: str) -> None:
    shutil.rmtree(box_dir(tid), ignore_errors=True)
    shutil.rmtree(box_host_dir(tid), ignore_errors=True)


def _seed_preview(t: dict[str, Any], env: dict[str, str]) -> None:
    """The preview server's copy of the ticket's workspace (its kernels left out) and the record of its corpus, once."""
    c = t.get("workspace")
    if not c:
        return
    ws, data = Path(env["THIMBLE_WORKSPACES_DIR"]), Path(env["THIMBLE_DATA_DIR"])
    src = config.workspace_path(str(c))
    if src.is_dir() and not (ws / str(c)).exists():
        ws.mkdir(parents=True, exist_ok=True)
        shutil.copytree(src, ws / str(c), symlinks=True, ignore=shutil.ignore_patterns("kernels"))
    try:
        corpus = config.corpus_dir(str(c))
    except ValueError:
        return
    rec = config.read_sidecar(str(c)) or {"name": c, "path": str(corpus), "root": str(corpus),
                                          "manifest": config.corpus_manifest(str(c))}
    data.mkdir(parents=True, exist_ok=True)
    (data / f"{c}{config.SIDECAR_SUFFIX}").write_text(json.dumps(rec), "utf-8")


async def _preview_shot(t: dict[str, Any], run_log: Log, phase: str, box: ticket_box.Box,
                        touched: "list[str] | None" = None) -> str | None:
    """A contained ticket's before or after shot: the UI built in the box (for the after shot only when the ticket
    changed frontend files), the worktree's server started in it on a copy of the workspace, the page kept to that
    server (run_shot's own_origin)."""
    fe, dist = box.tree / "frontend", box.cache / "dist"
    vite = fe / "node_modules" / ".bin" / "vite"
    if not vite.exists():
        run_log.stage(f"no {phase} shot: frontend/node_modules is missing in the worktree")
        return None
    if phase == "before" or needs_ui_build(touched or []) or not (dist / "index.html").is_file():
        code, out = await ticket_box.run(box, [str(vite), "build", "--configLoader", "runner", "--outDir", str(dist),
                                               "--emptyOutDir"], cwd=fe, timeout=UI_BUILD_TIMEOUT_S)
        if code != 0:
            run_log.stage(f"no {phase} shot: the UI did not build in the sandbox ({last_error_line(out) or out[-300:]})")
            return None
    env = {**ticket_box.server_env(box.cache / "preview"), "THIMBLE_FRONTEND_DIST": str(dist)}
    await asyncio.to_thread(_seed_preview, t, env)
    preview = ticket_box.Preview(box, env, port=STACK_API_PORT)
    try:
        url = await preview.start()
    except ticket_box.PreviewError as e:
        run_log.stage(f"no {phase} shot: the ticket's server did not start in the sandbox ({last_error_line(str(e))})")
        return None
    try:
        return await _take_shot(t, run_log, phase, url, own_origin=True)
    finally:
        await preview.stop()


def _kept_worktree(t: dict[str, Any]) -> tuple[Path, str, str] | None:
    """The worktree a restart interrupted, kept with the session's commits so the resumed session goes on from them:
    (path, branch, base) when it is still a worktree on the ticket's branch, else None."""
    wt, branch, base = t.get("worktree"), t.get("branch"), t.get("base")
    if not (t.get("interrupted") and wt and branch and base and Path(wt).is_dir()):
        return None
    try:
        return (Path(wt), str(branch), str(base)) if _git(Path(wt), "rev-parse", "--abbrev-ref", "HEAD") == branch else None
    except (GitError, OSError, subprocess.SubprocessError):
        return None


def _merge_and_record(t: dict[str, Any], branch: str, touched: list[str], expect_head: str | None, rebased: bool,
                      restart: str | None, commit: str) -> dict[str, Any]:
    """The apply's commit point: the fast-forward, the ticket marked applied and the apply recorded in one call, so a
    server ended right after (uvicorn's reloader) never leaves the two disagreeing; _recover finishes the rest.
    Blocking."""
    mg = merge_branch(branch, touched, expect_head, commit)
    if mg["ok"]:
        _update(t["id"], status="applied", commit=mg["commit"], restart=restart, error=None, touched=touched)
        record_apply({**t, "touched": touched}, {**mg, "rebased": rebased}, restart)
        log.info("ticket %s applied as %s (%s)", t["id"], str(mg["commit"])[:7], ", ".join(touched))
        if _reloads(touched):
            spawn_restart_watch({**t, "commit": mg["commit"]}, mg["prev_head"], respawn=False)
    return mg


async def _apply(t: dict[str, Any], wt: Path, branch: str, base: str, touched: list[str], restart: str | None,
                 run_log: Log, box: "ticket_box.Box | None" = None, change: str | None = None) -> dict[str, Any]:
    """Rebase `change`, the commit the analyst allowed, onto the live head, run the gates again (in `box`) when it
    moved, then fast-forward to the result (_merge_and_record). The live checkout changes only in that last step, after
    every gate has passed on the commits it receives. {ok, status, error, commit}."""
    for _ in range(2):
        rb = await asyncio.to_thread(rebase_branch, wt, branch, base, touched, change)
        if not rb["ok"]:
            return {"ok": False, "status": "needs manual merge", "error": rb["error"], "commit": None}
        if rb["rebased"]:
            run_log.stage("rebased onto the live branch; gates again")
            validation = await run_gates(wt, touched, box=box)
            _update(t["id"], validation=validation)
            for s in validation["steps"]:
                run_log.stage(f"gate {s['name']}: {'ok' if s['ok'] else 'failed'}")
            if not validation["ok"]:
                return {"ok": False, "status": "failed", "commit": None,
                        "error": "gates failed after the rebase onto the live branch; nothing was applied"}
        mg = await asyncio.to_thread(_merge_and_record, t, branch, touched, rb["head"], rb["rebased"], restart,
                                     str(rb["commit"]))
        if mg["moved"]:
            base, change = str(rb["head"]), rb["commit"]  # the live branch moved again between the rebase and the merge
            continue
        return {"ok": mg["ok"], "status": "applied" if mg["ok"] else "needs manual merge", "error": mg["error"],
                "commit": mg["commit"]}
    return {"ok": False, "status": "needs manual merge", "commit": None,
            "error": _manual_merge(touched, branch, "the live branch kept moving during the apply")}


UI_BUILD_FAILED_LINE = "the UI build failed after the change was applied, so it was rolled back"


def ticket_key(tid: str) -> str:
    """A code ticket's session key, which its permission hook names (module note, permissions)."""
    return f"ticket:{tid}"


async def run_ticket(t: dict[str, Any], run: Run, *, doctor: str | None = None, allowed: bool = False,
                     approve: "Approve | None" = None) -> dict[str, Any]:
    """The whole ticket (_run_ticket), its session's permission requests answered on its chat meanwhile, as thimble's
    config asks (dev_config). `allowed` when the analyst already allowed an uncontained ticket to start, and `approve`
    asks the analyst before the change is applied (`thimble fix`, in the terminal; the ticket's card otherwise)."""
    try:
        conf: userconf.Session | str = dev_config(t.get("workspace"), sandbox=True, hosted=bool(t.get("workspace")))
    except userconf.ConfigError as e:
        conf = str(e)
    if not isinstance(conf, str):
        _host(t.get("workspace"), {"key": ticket_key(t["id"]), "config": conf}, t.get("chat"), _log_for(t))
    try:
        return await _run_ticket(t, run, doctor=doctor, conf=conf, allowed=allowed, approve=approve)
    finally:
        _unhost(t.get("workspace"), ticket_key(t["id"]))


async def _run_ticket(t: dict[str, Any], run: Run, *, doctor: str | None = None,
                      conf: "userconf.Session | str | None" = None, allowed: bool = False,
                      approve: "Approve | None" = None) -> dict[str, Any]:
    """The whole ticket: worktree, before shot, the session's turns with gates fed back, the session stopped and its
    commit taken (checked_change), after shot, the analyst's Allow (_apply_refusal) and the apply of that commit, UI
    rebuild (rolled back when it fails), then the restart rules. A contained ticket
    (`contained`) runs its gates and shots in its box; an uncontained one asks the analyst first unless `allowed`
    (_code_refusal) and runs them on the validation stack. `doctor` is `thimble fix`'s path: no stack, shots, rebuild or
    restart. A stopped run ends `stopped` or `dismissed`, as does one the analyst did not allow; one a shutdown cuts short
    is queued again up to REQUEUE_MAX times. Returns the ticket's record."""
    tid = t["id"]
    fixing = doctor is not None
    run_log = _log_for(t)
    wt: Path | None = None
    branch = base = None
    stack: dict[str, str] | None = None
    box: ticket_box.Box | None = None
    status, error, result_text = "failed", None, ""
    touched: list[str] = []
    restart: str | None = None
    applied = False  # the commit point passed (_merge_and_record)
    requeue = False  # a shutdown cut the run short and it runs again at the next start
    try:
        if why := runner_problem(fixing=fixing) or (conf if isinstance(conf, str) else ""):
            raise TicketError(why)
        if approve is None and not (t.get("workspace") and t.get("chat")):
            raise NotAllowed(CODE_NOBODY)
        boxed = isinstance(conf, userconf.Session) and conf.sandboxed
        in_box = boxed and await asyncio.to_thread(ticket_box.works)
        if not in_box and not allowed and (why := await _code_refusal(t)):
            raise NotAllowed(why)
        kept = await asyncio.to_thread(_kept_worktree, t)
        if kept is not None:
            wt, branch, base = kept
            run_log.stage(f"worktree kept on {branch} across the restart")
        else:
            wt, branch, base = await asyncio.to_thread(create_worktree, tid)
            run_log.stage(f"worktree ready on {branch}")
        _update(tid, worktree=str(wt), branch=branch, base=base)
        if in_box:
            box = ticket_box_of(t, wt)
            run_log.stage("the checks and the ticket's server run in thimble's sandbox runtime")
        elif not fixing:
            stack = await start_stack(tid, wt, t.get("workspace"))
            run_log.stage(f"validation stack {'up at ' + stack['ui'] if stack else 'not available'}")
        ui_url = stack["ui"] if stack else None
        api_url = stack["api"] if stack else f"http://127.0.0.1:{config_port()}"
        if box is not None:
            before = None if fixing else await _preview_shot(t, run_log, "before", box)
        else:
            before = await _take_shot(t, run_log, "before", ui_url)
        fence = await asyncio.to_thread(ticket_fence, wt, conf.network, conf.enforced) if boxed else None
        if fixing:
            prompt = build_fix_prompt(t, worktree=wt, doctor=doctor or "")
        else:
            prompt = build_prompt(t, worktree=wt, ui_url=ui_url or "(no validation stack; take no shots)", api_url=api_url,
                                  before_shot=before, sandboxed=boxed)
        resume = t.get("session_id") if int(t.get("attempts") or 0) > 1 else None
        ok = False
        for attempt in range(1, MAX_ATTEMPTS + 1):
            run_log.stage(f"worker, attempt {attempt}")
            result_text = await _worker_turn(run, run_log, wt, prompt, resume, fence=fence,
                                             name=dev_session_name(t.get("workspace")), workspace=t.get("workspace"),
                                             on_session=lambda short, sid: _update(tid, session=short, session_id=sid),
                                             **({"asking": {"key": ticket_key(tid), "allow": own_work(wt, (shots_dir(tid),)),
                                                            **({"config": conf} if conf is not None else {})}}
                                                if t.get("workspace") else {}))
            resume = run.session_id
            touched, validation = await _check(wt, base, run_log, box)
            _update(tid, touched=touched, validation=validation)
            if validation is None:
                error = "the session committed no change"
                run_log.error(error)
                break
            if validation["ok"]:
                ok = True
                break
            error = "gates failed after %d attempt%s" % (attempt, "" if attempt == 1 else "s")
            prompt = build_gates_prompt(_gate_report(validation))
        if ok:
            await asyncio.to_thread(SESSIONS.stop, run.session)  # from here on only the server moves the branch
            change = await asyncio.to_thread(checked_change, wt, str(branch), str(base), touched)
            if box is not None:
                after = None if fixing else await _preview_shot(t, run_log, "after", box, touched)
            else:
                after = await _take_shot(t, run_log, "after", ui_url)
            if before and after:
                differ = (shots_dir(tid) / before).read_bytes() != (shots_dir(tid) / after).read_bytes()
                _update(tid, shots_differ=differ)
            if why := await _apply_refusal(t, touched, str(branch), approve):
                raise NotAllowed(why)
            restart = "requested" if needs_restart(touched) and not fixing else None
            res = await _apply(t, wt, str(branch), str(base), touched, restart, run_log, box, change)
            if res["ok"]:
                applied = True
                status, error = "applied", None
                run_log.stage(f"applied to the live branch ({str(res['commit'])[:7]})")
            else:
                status, error, restart = res["status"], res["error"], None
                run_log.error(error or "apply failed")
    except asyncio.CancelledError:
        if not applied:
            if run.stop_reason:
                status, error = run.stop_reason, None
            elif int(t.get("interrupted") or 0) < REQUEUE_MAX and not fixing:
                status, error, requeue = "queued", None, True
            else:
                status, error = "failed", "server shut down during the run"
        raise
    except Exception as e:  # noqa: BLE001
        if isinstance(e, (TicketError, SessionError)):
            error = str(e)
        else:
            log.exception("ticket run failed")
            error = f"{type(e).__name__}: {e}"
        if not applied:
            status = ("stopped" if isinstance(e, NotAllowed) else "needs manual merge" if isinstance(e, BranchMoved)
                      else "failed")
        run_log.error(error)
    finally:
        try:
            await asyncio.to_thread(SESSIONS.stop, run.session)  # before its worktree goes
            if not fixing and box is None:
                await stop_stack(tid)
            if wt is not None and not requeue:
                await asyncio.to_thread(remove_worktree, wt)
                await asyncio.to_thread(remove_box, tid)
            if branch and status in ("applied", "dismissed"):
                await asyncio.to_thread(delete_branch, branch)
        except Exception:  # noqa: BLE001
            log.exception("cleanup after ticket failed")
        if requeue:
            # the chat stays open: the run goes on in it at the next start (_recover starts the queue)
            run.status = "queued"
            run_log.stage("the server restarted during the run; the ticket goes on when it is back")
            rec = _update(tid, status="queued", interrupted=int(t.get("interrupted") or 0) + 1, runner=None) or t
            _ticket_event(rec, "queued")
        else:
            rebuild_by_hand = False
            if applied and not fixing and needs_ui_build(touched) and serves_built_ui():
                if supervised():
                    if await rebuild_ui({**t, "status": status}) == "failed":
                        rolled = await _roll_back(tid, UI_BUILD_FAILED_LINE, run_log)
                        if rolled:
                            status, error, restart = "rolled back", rolled, None
                else:
                    rebuild_by_hand = True
            run.status = status
            rec = _update(tid, status=status, error=error, result=result_text[:RESULT_CHARS], ts_end=_now(),
                          restart=restart, finished=True) or t
            _finish(rec, error or result_text[:400] or None)
            if rebuild_by_hand:
                _chip(rec, APPLIED_REBUILD_LINE.format(label=_label(rec)))
            if status == "applied" and restart == "requested":
                await request_restart(rec)
                rec = _get(tid) or rec
    return rec


def _finish(rec: dict[str, Any], summary: str | None) -> None:
    """A ticket's end, once its status is stored: the server log's line, its chat closed, the chip in main (applied,
    or failed with the reason; nothing for a run the analyst stopped or dismissed) and the stream's event."""
    status = str(rec.get("status") or "")
    log.log(logging.INFO if status in ("applied", "stopped", "dismissed") else logging.WARNING,
            "ticket %s (%s) ended %s%s", rec.get("id"), _label(rec), status,
            f": {rec['error']}" if rec.get("error") else "")
    chat_status = "done" if status == "applied" else "stopped" if status in ("stopped", "dismissed") else "failed"
    _close_chat(rec, chat_status, summary if status != "dismissed" else "dismissed")
    if status == "applied":
        _chip(rec, f"{_label(rec)} applied", "applied")
    elif status in FAILED and status != "stopped":
        why = str(rec.get("error") or "no reason given")
        _chip(rec, f"{_label(rec)}: {why}" if why.startswith(status) else f"{_label(rec)} {status}: {why}", status)
    _ticket_event(rec, status)


async def _roll_back(tid: str, why: str, run_log: Log) -> str | None:
    """Revert the ticket's apply because what came after it failed (`why`): the ticket's error with the reason, or
    None when there was no apply to revert or the revert was refused (it is logged, and the apply stays)."""
    a = await asyncio.to_thread(apply_of, tid)
    if a is None:
        return None
    res = await asyncio.to_thread(revert_apply, a, status="rolled back", why=why)
    if not res.get("ok"):
        log.error("could not roll back ticket %s: %s", tid, res.get("error"))
        run_log.error(f"{why}, but the rollback failed: {res.get('error')}")
        return None
    run_log.stage(f"{why} ({str(res.get('commit') or '')[:7]})")
    return why


def config_port() -> int:
    v = os.environ.get("THIMBLE_PORT")
    return int(v) if v and v.isdigit() else 8300


async def _run_task(run: Run, t: dict[str, Any]) -> None:
    try:
        await run_ticket(t, run)
    except asyncio.CancelledError:
        pass
    except Exception as e:  # noqa: BLE001
        log.exception("ticket task crashed")
        why = f"the run crashed: {type(e).__name__}: {e}"[:ERROR_CHARS]
        rec = _update(t["id"], status="failed", error=why, ts_end=_now(), finished=True) or {**t, "status": "failed"}
        run.status = "failed"
        _finish(rec, why)
    _start_next_if_idle()


def _start_run(t: dict[str, Any]) -> Run | None:
    """Claim the ticket and start its run; None when another server of the checkout claimed it first."""
    global _current
    rec = _claim(t["id"])
    if rec is None:
        return None
    rec = _update(t["id"], finished=False) or rec
    run = Run(ticket_id=t["id"], title=t["title"], ts_start=_now())
    _ticket_event(rec, "running")
    _current = run
    run.task = asyncio.create_task(_run_task(run, rec))
    return run


def _start_next_if_idle() -> None:
    if _closing or _running() or not STACK_ENABLED:
        return
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return  # no loop (the CLI): tickets wait for the server
    for t in _queued():
        if _start_run(t) is not None:
            return


def _pid_alive(pid: Any) -> bool:
    try:
        os.kill(int(pid), 0)
    except (OSError, ValueError, TypeError):
        return False
    return True


def _recover() -> None:
    """After a start, recover what a restart cut short: a ticket this server or a dead server was running is queued
    again with its worktree up to REQUEUE_MAX times (past that it fails); another live server's ticket is left alone. An
    applied ticket whose bookkeeping was cut short is finished. A rollback the restart watch made is recorded first.
    Then the queue starts."""
    try:
        recover_rollback()
    except Exception:  # noqa: BLE001 — the rest of the recovery does not depend on it
        log.exception("recording the restart watch's rollback failed")
    for t in _read():
        runner = t.get("runner")
        if runner and runner != os.getpid() and _pid_alive(runner):
            continue
        if _current is not None and _current.ticket_id == t.get("id") and _current.status == "running":
            continue  # this process's own run, started since the restart
        status = t.get("status")
        if status == "running":
            SESSIONS.stop(t.get("session"))
            if int(t.get("interrupted") or 0) < REQUEUE_MAX:
                rec = _update(t["id"], status="queued", interrupted=int(t.get("interrupted") or 0) + 1, runner=None) or t
                _log_for(rec).stage("the server restarted during the run; the ticket goes on now it is back")
                _ticket_event(rec, "queued")
            else:
                why = "server restarted during the run"
                rec = _update(t["id"], status="failed", error=why, ts_end=_now(), finished=True) or t
                _finish(rec, why)
        elif status in ("applied", "applied, restart pending") and (t.get("finished") is False or status != "applied"
                                                                    or t.get("restart") in ("restarting", "pending")):
            fields: dict[str, Any] = {"status": "applied", "finished": True}
            if status != "applied" or t.get("restart") in ("restarting", "pending"):
                fields["restart"] = "done"  # this start is the restart the ticket asked for
            rec = _update(t["id"], **fields) or t
            if t.get("finished") is False:
                with contextlib.suppress(Exception):
                    remove_ticket_tree(rec)
                _finish(rec, str(rec.get("result") or "")[:400] or None)
    _start_next_if_idle()


# view tickets


_view_runs: dict[tuple[str, str], Run] = {}  # (workspace, slug) -> the build running
_view_queue: list[tuple[str, str]] = []  # (workspace, slug) waiting for room in the pool, in the order queued
_view_stopping: dict[tuple[str, str], Run] = {}  # builds stop_view cancelled whose tasks have not ended yet
_parked: set[tuple[str, str]] = set()  # a session's view tickets main's end stopped, until a session is main again
_closing = False  # the server is shutting down: a build that ends starts no other


def queue_view(c: str, slug: str) -> None:
    """Queue the view ticket of the proposal `slug` and start what the pool has room for (views.propose, views.retry,
    recover_views). A ticket already queued or running is left as it is."""
    key = (c, slug)
    _parked.discard(key)
    if key not in _view_queue and key not in _view_runs:
        _view_queue.append(key)
    _start_views()


def _start_views() -> None:
    if _closing:
        return
    from . import views  # noqa: PLC0415 — views imports this module lazily too

    try:
        asyncio.get_running_loop()
    except RuntimeError:
        # a route's worker thread: the server's loop starts the build; with no loop (the CLI) the tickets wait for the
        # server
        loop = views._loop
        if loop is not None and loop.is_running() and not loop.is_closed():
            loop.call_soon_threadsafe(_start_views)
        return

    while _view_queue and len(_view_runs) < VIEW_POOL:
        c, slug = _view_queue.pop(0)
        prop = views.read_proposal(c, slug)
        if prop is None or prop.get("status") not in views.PENDING:
            continue
        run = Run(ticket_id=f"view:{slug}", title=str(prop.get("name") or slug), ts_start=_now())
        _view_runs[(c, slug)] = run
        run.task = asyncio.create_task(_view_task(c, slug, run), name=f"view:{c}:{slug}")


async def _view_task(c: str, slug: str, run: Run) -> None:
    try:
        await run_view(c, slug, run)
    except asyncio.CancelledError:
        pass
    except Exception as e:  # noqa: BLE001
        log.exception("view ticket %s/%s crashed", c, slug)
        _view_failed(c, slug, f"the run crashed: {type(e).__name__}: {e}"[:400])
    finally:
        if _view_runs.get((c, slug)) is run:
            del _view_runs[(c, slug)]
        if _view_stopping.get((c, slug)) is run:
            del _view_stopping[(c, slug)]
        _start_views()


def stop_view(c: str, slug: str, why: str) -> bool:
    """Take the view ticket out of the queue and cancel its build, which stops its session and ends its chat `stopped`
    with `why`. Never blocks; the run leaves the pool at once so a replacement under the same slug starts. Whether a
    build was cancelled."""
    key = (c, slug)
    if key in _view_queue:
        _view_queue.remove(key)
    run = _view_runs.get(key)
    if run is not None and run.task is not None and not run.task.done():
        run.status = why
        run.task.cancel()
        del _view_runs[key]
        _view_stopping[key] = run
        return True
    return False


# why the builds of a workspace that is archived or reset stopped (stop_views)
WORKSPACE_CLOSED = "the workspace was archived"


async def stop_views(c: str) -> None:
    """Stop every view build of the workspace, drop its queued tickets and wait for the builds to wind down. Their
    proposals keep `queued` or `building`, so a restored archive queues them again."""
    for key in [k for k in _view_queue if k[0] == c]:
        _view_queue.remove(key)
    for cc, slug in [k for k in _view_runs if k[0] == c]:
        stop_view(cc, slug, WORKSPACE_CLOSED)
    tasks = [r.task for k, r in _view_stopping.items() if k[0] == c and r.task is not None and not r.task.done()]
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)


# why the builds of the views an orientation proposed stopped (stop_orientation_views)
ORIENTATION_STOPPED = "the orientation was stopped"


def stop_orientation_views(c: str) -> list[str]:
    """The analyst stopped the orientation: the builds of the views it proposed stop, queued or running, and so do the
    reviews of its views, so none of its builds starts after the Stop. A new view is dropped, and a change to a built
    view leaves the view as it was. Views and changes the analyst asked for go on. The slugs stopped."""
    from . import view_review, views  # noqa: PLC0415

    stopped: list[str] = []
    for p in views.list_proposals(c):
        if not p.get("orientation") or p.get("asked"):
            continue
        slug = str(p["slug"])
        reviewed = view_review.stop(c, slug)
        if p.get("status") not in views.PENDING:
            if reviewed:
                stopped.append(slug)
            continue
        if p.get("revision"):
            # a running build puts the view back itself once its session has stopped (run_view)
            if not stop_view(c, slug, ORIENTATION_STOPPED):
                views.end_revision(c, slug)
        else:
            stop_view(c, slug, ORIENTATION_STOPPED)
            views.drop(c, slug, ORIENTATION_STOPPED)
        stopped.append(slug)
    return stopped


def recover_views(c: str) -> None:
    """Queue again the workspace's view tickets that are queued or building with no build, queue entry or winding-down
    run in this process (after a restart or an archive restore). A building one's session is stopped first so its run
    resumes it. One main's end stopped waits for resume_views."""
    from . import views  # noqa: PLC0415

    for p in views.list_proposals(c):
        key = (c, str(p["slug"]))
        if (p.get("status") not in views.PENDING or key in _view_runs or key in _view_queue or key in _view_stopping
                or key in _parked):
            continue
        if p.get("status") == "building" and p.get("session"):
            SESSIONS.stop(str(p["session"]))
        queue_view(*key)


def _view_chat(c: str, prop: dict[str, Any]) -> str | None:
    """The build's agent chat, role dev with the view's slug on its meta: the earlier run's, running again, else a new
    one. A view the analyst asked for is built in a dev thread announced in main; an orientation's proposal gets no row
    in main."""
    chat = prop.get("chat")
    asked = bool(prop.get("asked"))
    title = f"view: {prop.get('name') or prop['slug']}"
    meta = agents.meta_or_none(c, str(chat)) if chat else None
    if meta is not None:
        agents.update_agent(c, str(chat), status="running", ts_end=None, result=None, **({"asked": True} if asked else {}))
        if asked and not meta.get("asked"):
            agents.mirror(c, "agent", chat=str(chat), role="dev", title=str(meta.get("title") or title))
        return str(chat)
    try:
        return str(agents.new_agent(c, "dev", title, view=prop["slug"], announce=asked,
                                    **({"asked": True} if asked else {}))["id"])
    except HTTPException:
        log.exception("no chat for the view ticket %s/%s", c, prop.get("slug"))
        return None


def build_view_prompt(c: str, prop: dict[str, Any], folder: Path, corpus: Path) -> str:
    """The view ticket's first message: prompts/dev.md with prompts/dev-view.md as its task, the proposal's fields (its
    spec as bullets, views.spec_lines), the slug, the view's folder, the corpus, the worked examples and the check
    command's URL."""
    from . import views  # noqa: PLC0415

    values = {"name": str(prop.get("name") or prop["slug"]), "slug": str(prop["slug"]),
              "description": str(prop.get("why") or ""),
              "claims": ", ".join(prop.get("claims") or []), "spec": views.spec_lines(prop), "folder": str(folder),
              "corpus": str(corpus), "examples": str(views.EXAMPLES_DIR), "check": view_check_command(c, str(prop["slug"])),
              "network": view_network_line(c)}
    with prompts.custom(userconf.prompt_files(c, "dev")):
        return prompts.render_dev("dev-view", values)


VIEW_NETWORK_LINES = {
    "sandboxed": "There is no network, so nothing can be fetched or installed. ",
    "asked": "Fetch and install nothing. Every command but the check command waits for the analyst's permission. ",
    "on": "",
}


def view_network_line(c: str) -> str:
    """The view-build prompt's line on the network, true of how the build's Bash runs (dev_config)."""
    try:
        conf = dev_config(c, sandbox=True)
    except userconf.ConfigError:
        return VIEW_NETWORK_LINES["sandboxed"]
    return VIEW_NETWORK_LINES["on" if conf.network else "sandboxed" if conf.sandboxed else "asked"]


def view_check_command(c: str, slug: str) -> str:
    """The command a view build's session checks its draft with (view_check.py): this server's interpreter without
    site-packages, the script, thimble's home (whose server.json holds the token the post proves; a background session's
    environment does not name it), the view's folder (where the request goes as a file when the post cannot reach the
    server) and the view's check URL. The fence runs it outside the sandbox by this prefix."""
    from . import views  # noqa: PLC0415

    url = f"http://127.0.0.1:{config_port()}/api/ws/{c}/views/{slug}/check"
    home = shlex.quote(str(thimble_home()))
    folder = shlex.quote(str(views.views_dir(c) / slug))
    return f"{shlex.quote(sys.executable)} -S {shlex.quote(str(VIEW_CHECK))} --home {home} --folder {folder} {url}"


def build_view_change_prompt(prop: dict[str, Any], folder: Path) -> str:
    """The message of a change to a view (views.revise): prompts/dev-view-change.md with the proposal's fields and the
    analyst's request fenced as data."""
    from . import views  # noqa: PLC0415

    request = str(prop.get("change") or "").strip()
    return prompts.render("dev-view-change", {
        "name": str(prop.get("name") or prop["slug"]),
        "description": str(prop.get("why") or ""),
        "claims": ", ".join(prop.get("claims") or []),
        "spec": views.spec_lines(prop),
        "request": fenced("the analyst's request", request) if request else "",
        "folder": str(folder),
    })


def _change_failed_chip(c: str, prop: dict[str, Any], why: str) -> None:
    """Main's chip for a change to a built view that failed, since the view's own chip shows it built again."""
    try:
        agents.chip(c, "ticket", f"the change to the view {prop.get('name') or prop.get('slug')} failed, so it is as it "
                    f"was: {why}", ref=f"view:{prop.get('slug')}", chat=prop.get("chat"), status="failed")
    except Exception:  # noqa: BLE001
        log.exception("could not chip the failed change to %s/%s", c, prop.get("slug"))


def _view_failed(c: str, slug: str, error: str, chat: str | None = None, *, drop_why: str | None = None) -> None:
    """A build that ended without its view: a change to a built view leaves the view as it was (views.end_revision), a
    view the analyst asked for fails, its chip showing why with Retry, and an orientation's proposal is dropped
    (_view_dropped), with `drop_why` as its line's reason when given."""
    from . import views  # noqa: PLC0415

    current = views.read_proposal(c, slug) or {}
    chat = chat or current.get("chat")
    if current.get("revision"):
        views.end_revision(c, slug, error, failed_change=str(current.get("change") or ""))
        if chat:
            _close_chat({"workspace": c, "chat": chat}, "failed", error)
        _change_failed_chip(c, current, error)
        return
    if not current.get("asked"):
        _view_dropped(c, slug, drop_why or error, chat)
        return
    views.update_proposal(c, slug, status="failed", error=error)
    views._emit(c, slug, "failed", chat=chat)
    if chat:
        _close_chat({"workspace": c, "chat": chat}, "failed", error)


# the line an orientation's thread gets for a proposal of its own that could not be built
DROPPED_LINE = "The view {name} could not be built, so it was left out of the proposals: {why}"
DROPPED_WHY_CHARS = 240


def _view_dropped(c: str, slug: str, why: str, chat: str | None = None) -> None:
    """An orientation's proposal whose build failed through its repairs is dropped quietly: its chat ends failed with
    the reason and the orientation's thread gets one line. Nothing is chipped in main, since the analyst never asked for
    it."""
    from . import orientation, views  # noqa: PLC0415

    prop = views.drop(c, slug, why) or {}
    if chat:
        _close_chat({"workspace": c, "chat": chat}, "failed", why)
    reason = " ".join(str(why or "").split())
    if len(reason) > DROPPED_WHY_CHARS:
        reason = reason[: DROPPED_WHY_CHARS - 1].rstrip() + "…"
    orient = ((orientation.read_run(c) or {}).get("chats") or {}).get(orientation.ROLE)
    if not orient or agents.meta_or_none(c, str(orient)) is None:
        return
    line = DROPPED_LINE.format(name=prop.get("name") or slug, why=reason or "its checks did not pass")
    try:
        agents.Recorder(c, str(orient)).text(f"\n· {line}\n")
    except Exception:  # noqa: BLE001 — the proposal is dropped either way
        log.exception("could not note the dropped view %s/%s in the orientation's thread", c, slug)


def view_read_only(corpus: Path, folder: Path) -> tuple[Path, ...]:
    """The folders a view build's session must not change: the corpus folder and the worked examples. A folder that
    holds the view's own folder is left out, since its deny would cover the view's files too."""
    from . import views  # noqa: PLC0415

    out = []
    for f in (corpus, views.EXAMPLES_DIR):
        try:
            if folder.resolve().is_relative_to(Path(f).resolve()):
                log.warning("view build in %s: %s holds the view's folder, so it is not fenced", folder, f)
                continue
        except OSError:
            continue
        out.append(Path(f))
    return tuple(out)


def view_fence(c: str, slug: str, corpus: Path, folder: Path, conf: userconf.Session) -> dict[str, Any]:
    """The settings that fence a view build's session: the view_read_only folders read-only, but for the corpus, whose
    edits follow the dev agent's `data` (data_fence), its check command run outside the sandbox, where it can reach
    this server, and while the dev agent's network is off (`conf`), offline_deny and the offline environment
    (view_env)."""
    check = view_check_command(c, slug)
    fixed = view_read_only(corpus, folder)
    out = read_only_fence(fixed, outside=(check, f"{check} *"), conf=conf)
    if Path(corpus) in fixed:
        out = data_fence(out, Path(corpus), conf.data)
    if conf.network:
        return {**out, "env": view_env(slug, offline=False)}
    conf.offline = True
    perms = dict(out.get("permissions") or {})
    deny = [*(perms.get("deny") or []), *offline_deny()]
    return {**out, "permissions": {**perms, "deny": deny}, "env": view_env(slug)}


def data_fence(fence: dict[str, Any], corpus: Path, data: str) -> dict[str, Any]:
    """`fence` (read_only_fence) with the corpus's Edit deny as `data` (userconf.Session.data) says: kept for "off", an
    ask for "ask", whose sandbox then keeps Bash from writing the corpus, and gone for "allow", whose sandbox lets Bash
    write it."""
    if data == "off":
        return fence
    rule = f"Edit(/{corpus}/**)"
    perms = dict(fence.get("permissions") or {})
    perms["deny"] = [r for r in perms.get("deny") or [] if r != rule]
    if data == "ask":
        perms["ask"] = [*(perms.get("ask") or []), rule]
    out = {**fence, "permissions": perms}
    if isinstance(out.get("sandbox"), dict):
        key = "denyWrite" if data == "ask" else "allowWrite"
        fs = dict(out["sandbox"].get("filesystem") or {})
        fs[key] = [*(fs.get(key) or []), str(corpus)]
        out["sandbox"] = {**out["sandbox"], "filesystem": fs}
    return out


def offline_deny() -> list[str]:
    """The deny rules of a view build whose network is off, in every permission mode: Bash commands by OFFLINE_PROGRAMS,
    OFFLINE_COMMANDS and OFFLINE_MODULES."""
    return [*(r for p in OFFLINE_PROGRAMS for r in (f"Bash({p}:*)", f"Bash(*/{p} *)")),
            *(f"Bash({cmd}:*)" for cmd in OFFLINE_COMMANDS), *(f"Bash(* -m {m} *)" for m in OFFLINE_MODULES)]


def view_models(c: str, prop: dict[str, Any]) -> dict[str, Any]:
    """The model, effort and fast mode of a view build's session: each the analyst chose for the dev agent in Settings
    (config.chosen), else the one of the session that asked for the view (asker_models)."""
    dev, mine, asker = config.models_for(c)["dev"], config.chosen(c, "dev"), asker_models(c, prop)
    out = {k: dev[k] if k in mine else asker.get(k) for k in ("model", "effort", "fast")}
    if out["fast"] and out["model"] and not config.has_fast_mode(out["model"]):
        out["fast"] = False
    return out


def asker_models(c: str, prop: dict[str, Any]) -> dict[str, Any]:
    """The model settings of the session that asked for the view `prop`. For the orientation's proposals the
    orientation's: its model without the 1M tag, as its subagents run it, the effort it runs at and its fast mode. For
    the analyst's, main's as its replies report them (session._note_model); before main's first reply, the model and
    fast mode are left to the analyst's Claude Code settings (None) and the effort is main's launch effort."""
    from . import orient_session, orientation  # noqa: PLC0415

    if prop.get("orientation"):
        own, run = config.models_for(c)["orient"], orientation.read_run(c)
        effort = orient_session.effort_of(run) if run else cc_settings.level_of(own["effort"])
        return {"model": config.base_model(own["model"]), "effort": effort, "fast": bool(own["fast"])}
    held = (agents.meta_or_none(c, agents.MAIN_ID) or {}).get("attached") or {}
    effort = held.get("effort") if held.get("effort") in cc_settings.EFFORTS else None
    return {"model": held.get("model") or None,
            "effort": effort or cc_settings.main_effort_flag(config.corpus_dir(c)) or None,
            "fast": held["fast"] if isinstance(held.get("fast"), bool) else None}


def view_env(slug: str, offline: bool = True) -> dict[str, str]:
    """A view build's session's environment: its key, and when `offline`, OFFLINE_ENV and OFFLINE_ENV_FILE."""
    return {SESSION_ENV: view_key(slug), **({**OFFLINE_ENV, ENV_FILE: str(OFFLINE_ENV_FILE)} if offline else {})}


# The thimble code a view's reader and page run against, which a view build's session reads unasked: the kernel's
# `thimble` module, the page's bridge and styles, the checks, and the rest of the server's code beside them.
VIEW_CODE = ("backend/app/", "scripts/view_shot.mjs")


def view_key(slug: str) -> str:
    """A view build's session key, which its permission hook names (module note, permissions)."""
    return f"view:{slug}"


def view_asking(c: str, slug: str, folder: Path, conf: userconf.Session) -> dict[str, Any]:
    """How a view build's session asks (Sessions._flags): its key, what thimble's config asks of it (`conf`), and allowed
    unasked its edits in the view's folder, reads of the worked examples and of the thimble code a view runs against
    (VIEW_CODE), its check command, and Bash in the sandbox where its Bash runs there, but for the commands the config
    asks about."""
    from . import agent_session, views  # noqa: PLC0415

    check = view_check_command(c, slug)
    conf.own_bash = [check]
    code = [f"Read(/{config.REPO_ROOT / rel}{'/**' if rel.endswith('/') else ''})" for rel in VIEW_CODE]
    out: dict[str, Any] = {"key": view_key(slug), "config": conf,
                           "allow": [*own_work(folder, (views.EXAMPLES_DIR,)), *code, f"Bash({check})",
                                     f"Bash({check} *)"]}
    if conf.sandboxed:
        names, asks = agent_session.sandbox_rule(config.corpus_dir(c))
        out["sandbox"] = [names, asks]
    return out


def view_capacity_waits() -> list[float]:
    """The waits of a view build whose turns the API keeps ending at capacity: the same schedule as agent_session's
    retries."""
    from . import agent_session  # noqa: PLC0415

    return agent_session.retry_knobs()


def _view_failure(report: dict[str, Any] | None, folder: Path, error: str, result_text: str) -> str:
    """Why a build's last turn left no view: the gate's first failing line when a view.json was written (with none,
    the gate's line only says so), else the session's own error, else its report (why it wrote none)."""
    from . import views  # noqa: PLC0415

    failed = views.first_failure(report) if report is not None and (folder / views.VIEW_JSON).is_file() else ""
    return (failed or error or result_text or "the checks did not pass")[:ERROR_CHARS]


# how much of a change's request its stage line carries (run_view)
CHANGE_CHARS = 2000


def _one_line(text: str) -> str:
    """`text` as one line, each paragraph that ends without a stop given one, so a request filed as a title and a body
    reads with the title as its first sentence."""
    paras = [" ".join(p.split()) for p in re.split(r"\n\s*\n", text) if p.strip()]
    return " ".join(p if p[-1] in ".!?" else f"{p}." for p in paras)


# the stage line of a repair (run_view): an orientation's build that ran out of attempts starts again in a new session
REPAIR_LINE = "the view did not pass, so a new session builds it again from what failed (repair {n} of {of})"


async def run_view(c: str, slug: str, run: Run) -> None:
    """The whole view ticket (_run_view), its session's permission requests and check requests answered meanwhile."""
    from . import views  # noqa: PLC0415

    checks = views.watch_checks(c, slug)
    try:
        await _run_view(c, slug, run)
    finally:
        checks.cancel()
        _unhost(c, view_key(slug))


async def _run_view(c: str, slug: str, run: Run) -> None:
    """The whole view ticket: the chat, the session's turns with the gate fed back, then the view registered and main
    told, or the build's failure. An orientation's proposal first gets VIEW_REPAIRS new sessions. A run over a proposal
    that has a session runs the gate first when the session wrote a view, since an interrupted build may have finished,
    and otherwise tells the session to go on. A change (`changed`) wakes the
    session with what changed; a change to a built view (`revision`) is built only when its files differ, and on failure
    or dismissal the view goes back to how it was."""
    from . import agent_session, session, tools, view_review, views  # noqa: PLC0415

    prop = views.read_proposal(c, slug)
    if prop is None:
        return
    revision = bool(prop.get("revision"))
    change = bool(prop.get("changed"))
    conf, why = None, ""
    try:
        conf = dev_config(c, sandbox=True)
    except userconf.ConfigError as e:
        why = str(e)
    # without Node or the frontend's packages, or with an error in thimble's config, no session could pass the checks,
    # so the build ends at once
    if why := why or await asyncio.to_thread(views.build_problem):
        run.status = "failed"
        if revision:
            views.end_revision(c, slug, why, failed_change=str(prop.get("change") or ""))
            _change_failed_chip(c, prop, why)
        else:
            _view_failed(c, slug, why, prop.get("chat"))
        log.warning("view ticket %s/%s cannot build: %s", c, slug, why)
        return
    views.ensure_local(config.workspace_dir(c))
    folder = views.views_dir(c) / slug
    folder.mkdir(parents=True, exist_ok=True)
    corpus = config.corpus_dir(c)
    chat = _view_chat(c, prop)
    prop = views.update_proposal(c, slug, status="building", error=None, chat=chat,
                                 attempts=int(prop.get("attempts") or 0) + 1) or prop
    views._emit(c, slug, "building", chat=chat)
    run_log = Log(agents.Recorder(c, chat)) if chat else Log(None)
    asking = view_asking(c, slug, folder, conf)
    _host(c, asking, chat, run_log)
    resume = prop.get("session_id")
    report: dict[str, Any] | None = None
    built, error, result_text = False, "", ""
    capacity = ""  # why the last turn ended, when the API ended it (capacity_failure)
    unchanged = False  # a change to a built view whose session ended its turn with the view's files as they were

    def on_session(short: str, sid: str) -> None:
        views.update_proposal(c, slug, session=short, session_id=sid)

    async def gate(quiet: bool = False) -> dict[str, Any]:
        # one line in the thread per gate: its outcome and the first failure; unsaid after a turn the API ended
        rep = await views.gate(c, slug, views._kept_locators(c, slug))
        checks = rep.get("checks") or []
        if not quiet or rep.get("ok"):
            loaded = "the page loaded" if (rep.get("page") or {}).get("ok") else "the page was not loaded"
            run_log.stage(f"checks passed: {len(checks)} ref(s), {loaded}" if rep.get("ok")
                          else f"checks failed: {views.first_failure(rep) or 'the page did not load'}")
        return rep

    try:
        if change:
            asked_change = build_view_change_prompt(prop, folder)
            prompt = asked_change if resume else f"{build_view_prompt(c, prop, folder, corpus)}\n\n{asked_change}"
            run_log.stage("the change asked for: " + _one_line(str(prop.get("change") or prop.get("arrangement") or ""))[:CHANGE_CHARS])
        elif resume and (folder / views.VIEW_JSON).is_file():
            report = await gate()
            built = bool(report["ok"])
            prompt = build_gates_prompt("\n".join(views.gate_lines(report)))
        elif resume:
            prompt = tools.hint(agent_session.RESUMED_PROMPT, stopped="")
        else:
            prompt = build_view_prompt(c, prop, folder, corpus)
        told = prompt  # the last gate report the session was sent
        waits, waited = view_capacity_waits(), 0.0
        # an orientation's proposal repairs itself rather than showing a failure
        repairs = 0 if prop.get("asked") or revision else VIEW_REPAIRS
        attempt, broke = 0, False
        while not built:
            if attempt >= MAX_ATTEMPTS or broke:
                if not repairs:
                    break
                repairs -= 1
                # a new session: the ticket, then what failed, with the draft left in the view's folder
                failed = ("\n".join(views.gate_lines(report)) if report is not None and (folder / views.VIEW_JSON).is_file()
                          else _view_failure(report, folder, error, result_text))
                run_log.stage(REPAIR_LINE.format(n=VIEW_REPAIRS - repairs, of=VIEW_REPAIRS))
                await asyncio.to_thread(SESSIONS.stop, run.session)
                views.update_proposal(c, slug, session=None, session_id=None)
                resume, run.session, run.session_id = None, None, None
                told = build_gates_prompt(failed)
                prompt = f"{build_view_prompt(c, prop, folder, corpus)}\n\n{told}"
                attempt, broke = 0, False
            attempt += 1
            run_log.stage("the session writes the view" if attempt == 1 else
                          f"the session fixes what the checks found (attempt {attempt} of {MAX_ATTEMPTS})")
            error = ""
            turn_start = time.monotonic()
            try:
                # the view's folder is its one extra working directory; the worked examples are only read, since as a
                # working directory they would receive the sandbox's `.claude/.cc-writes/`
                result_text = await _worker_turn(run, run_log, corpus, prompt, resume, name=view_session_name(c, slug),
                                                 workspace=c, on_session=on_session, add_dirs=(folder,),
                                                 answered=False, fence=view_fence(c, slug, corpus, folder, conf),
                                                 asking=asking, models=view_models(c, prop))
            except RuntimeError as e:
                error, result_text = str(e), ""
            capacity = capacity_failure(error) or capacity_failure(result_text)
            if error and not capacity:
                run_log.error(error)
                # a first build may have written a working view before it failed; a change's folder holds the old view,
                # whose checks say nothing of the change
                if (folder / views.VIEW_JSON).is_file() and not change:
                    report = await gate()
                    built = bool(report["ok"])
                broke = True
                continue
            resume = run.session_id or resume
            written = (folder / views.VIEW_JSON).is_file()
            if not (capacity and (change or not written)):
                # a change the API cut short is not checked: the view as it was passes the checks too
                report = await gate(quiet=bool(capacity))
                built = bool(report["ok"])
            if built and revision and views.unchanged_since_built(c, slug):
                built, unchanged = False, True
                break
            if built or not capacity:
                capacity = ""
                if not built:
                    prompt = told = build_gates_prompt("\n".join(views.gate_lines(report)))
                continue
            if time.monotonic() - turn_start > _retry_streak_s():
                # the turn worked a while before the API stopped it: a new streak of waits
                waits, waited = view_capacity_waits(), 0.0
            if not waits:
                break  # the API stayed at capacity through every wait, which the failure names (below)
            # the turn ended on the API's error rather than the session's work: wake the same session after a wait,
            # which is no attempt
            wait = waits.pop(0)
            waited += wait
            run_log.stage(f"{capacity}, so the build waits {_minutes(wait)} and goes on")
            await _capacity_sleep(wait)
            attempt -= 1
            if resume:
                # the gate's report only when the session wrote a view and was not sent that report already
                gates = build_gates_prompt("\n".join(views.gate_lines(report))) if written and report else ""
                if gates and not change and gates != told:
                    prompt = told = gates
                else:
                    prompt = tools.hint(agent_session.RETRY_PROMPT)
    except asyncio.CancelledError:
        await asyncio.to_thread(SESSIONS.stop, run.session)
        if run.status == MAIN_ENDED:
            _view_failed(c, slug, MAIN_ENDED, chat)
            raise
        why = run.status if run.status not in ("running",) else "server shut down during the run"
        if chat:
            _close_chat({"workspace": c, "chat": chat}, "stopped", why)
        if revision and run.status in ("dismissed", ORIENTATION_STOPPED):
            views.end_revision(c, slug)  # its session has stopped, so nothing writes into the folder any more
        raise
    if built:
        view = views.mark_built(c, slug)
        views.update_proposal(c, slug, changed=None, change=None, revision=None)
        views.drop_built_copy(c, slug)
        run.status = "built"
        log.info("view ticket %s/%s built%s", c, slug, " (a change)" if revision else "")
        if chat:
            _close_chat({"workspace": c, "chat": chat}, "done", result_text[:400] or None)
        view_review.after_built(c, slug)
        try:
            session.push_event(c, "view", views.built_line(view), view=slug)
        except Exception:  # noqa: BLE001 — the view is built; main learns its forms at its next prompt render
            log.exception("the view event for %s/%s was not sent", c, slug)
        return
    run.status = "failed"
    drop_why = None
    if capacity:
        # the API ended the last turn, so a file the gate found missing or empty is its doing: its error says why
        api = " ".join((error or result_text).split())
        drop_why = CAPACITY_WHY.format(why=capacity, waited=_minutes(waited))
        why = CAPACITY_FAILED.format(why=capacity, waited=_minutes(waited), error=api)[:ERROR_CHARS]
    elif unchanged:
        said = " ".join(result_text.split())
        why = (UNCHANGED_LINE + (f": {said}" if said else ""))[:ERROR_CHARS]
    else:
        why = _view_failure(report, folder, error, result_text)
    log.warning("view ticket %s/%s failed: %s", c, slug, why)
    if revision:
        views.end_revision(c, slug, why, failed_change=str(prop.get("change") or ""))
        if chat:
            _close_chat({"workspace": c, "chat": chat}, "failed", why)
        _change_failed_chip(c, prop, why)
        return
    _view_failed(c, slug, why, chat, drop_why=drop_why)


def view_program(c: str) -> Any:
    """The program an active extension runs the dev agent with (roles.py), which then takes each turn of the
    workspace's view builds (program_view_turn); None for thimble's own dev agent."""
    from . import roles  # noqa: PLC0415

    agent = roles.agent_for(c, "dev")
    return agent.replacing if agent.code else None


VIEW_PROGRAM_TOOLS = ("read_ref",)  # the thimble tools a dev program's view build may call


def view_program_dir(c: str, slug: str) -> Path:
    """A dev program's own folder for the view `slug`, beside the view's folder, which holds only the view."""
    return config.workspace_dir(c) / "views-work" / slug


async def program_view_turn(c: str, slug: str, message: str, folders: list[Path], part: Any,
                            rec: agents.Recorder | None) -> str:
    """A turn of a view build, a change or a review's revision taken by the dev agent's program (harness.run_in) in
    the build's chat, in place of thimble's session: its input is the view's proposal, its folder and the message
    thimble's session would get this turn (the build's prompt, then what the checks found or what the review asks
    for). It writes the view's files in its folder, which the build then checks as it checks a session's work. What it
    returns is the turn's reply; RuntimeError when it fails or may not start."""
    from . import harness  # noqa: PLC0415
    from . import views  # noqa: PLC0415

    prop = views.read_proposal(c, slug) or {"slug": slug}
    folder = folders[0] if folders else views.views_dir(c) / slug
    job = harness.Job(c, "dev", view_key(slug), f"view: {prop.get('name') or slug}", {
        "task": "view", "slug": slug, "name": str(prop.get("name") or slug), "description": str(prop.get("why") or ""),
        "scope": list(prop.get("claims") or []), "spec": views.spec_lines(prop), "change": str(prop.get("change") or ""),
        "folder": str(folder), "corpus": str(config.corpus_dir(c)), "examples": str(views.EXAMPLES_DIR),
        "message": message,
    }, VIEW_PROGRAM_TOOLS, view_program_dir(c, slug), writes=(folder,))
    try:
        return await harness.run_in(job, part, rec)
    except harness.HarnessError as e:
        raise RuntimeError(str(e)) from e


# a turn of a revision the view review asked for, and the stage line its thread gets
REVIEW_TURN_TIMEOUT_S = float(os.environ.get("THIMBLE_VIEW_REVIEW_TURN_S", "") or 12 * 60)
REVIEW_LINE = "a review of the view's pictures found problems, so the session fixes them"
_review_runs: dict[tuple[str, str], Run] = {}  # (workspace, slug) -> the revision the view review is running


def stop_review_session(c: str, slug: str) -> None:
    """Stop the background session of the view review's revision, if one runs (view_review.stop)."""
    run = _review_runs.get((c, slug))
    if run is not None:
        SESSIONS.stop(run.session)


async def review_revision(c: str, slug: str, message: str) -> tuple[bool, str]:
    """A revision the view review asks for: the view's build session woken with `message` (prompts/dev-view-review.md)
    in the view's thread, the view's checks run after each turn and fed back up to MAX_ATTEMPTS times. (passed, the
    session's report or why it did not pass). A view with no build session gets a new one, started with its ticket. Its
    session asks as a build's does (view_asking). A turn the API ended at capacity is no attempt: the session is woken
    again after a build's waits (view_capacity_waits)."""
    from . import agent_session, tools, views  # noqa: PLC0415

    prop = views.read_proposal(c, slug)
    if prop is None:
        return False, "the view has no proposal"
    folder = views.views_dir(c) / slug
    corpus = config.corpus_dir(c)
    chat = _view_chat(c, prop)
    if chat and chat != prop.get("chat"):
        views.update_proposal(c, slug, chat=chat)
    run_log = Log(agents.Recorder(c, chat)) if chat else Log(None)
    try:
        conf = dev_config(c, sandbox=True)
    except userconf.ConfigError as e:
        run_log.error(str(e))
        return False, str(e)
    run = Run(ticket_id=f"view-review:{slug}", title=str(prop.get("name") or slug), ts_start=_now())
    _review_runs[(c, slug)] = run
    asking = view_asking(c, slug, folder, conf)
    _host(c, asking, chat, run_log)
    resume = prop.get("session_id")
    prompt = message if resume else f"{build_view_prompt(c, prop, folder, corpus)}\n\n{message}"
    run_log.stage(REVIEW_LINE)
    why, result_text = "", ""

    def on_session(short: str, sid: str) -> None:
        views.update_proposal(c, slug, session=short, session_id=sid)

    waits, waited = view_capacity_waits(), 0.0
    attempt = 0
    checks = views.watch_checks(c, slug)
    try:
        while attempt < MAX_ATTEMPTS:
            attempt += 1
            if attempt > 1:
                run_log.stage(f"the session fixes what the checks found (attempt {attempt} of {MAX_ATTEMPTS})")
            error = ""
            turn_start = time.monotonic()
            try:
                result_text = await _worker_turn(run, run_log, corpus, prompt, resume, name=view_session_name(c, slug),
                                                 workspace=c, on_session=on_session, add_dirs=(folder,),
                                                 answered=False, fence=view_fence(c, slug, corpus, folder, conf),
                                                 turn_timeout_s=REVIEW_TURN_TIMEOUT_S, asking=asking,
                                                 models=view_models(c, prop))
            except RuntimeError as e:
                error, result_text = str(e), ""
            capacity = capacity_failure(error) or capacity_failure(result_text)
            if error and not capacity:
                why = error
                run_log.error(why)
                break
            resume = run.session_id or resume
            if capacity:
                # the view as it was passes the checks too, so a turn the API cut short is not checked
                if time.monotonic() - turn_start > _retry_streak_s():
                    waits, waited = view_capacity_waits(), 0.0
                if not waits:
                    why = REVIEW_CAPACITY_WHY.format(why=capacity, waited=_minutes(waited))
                    break
                wait = waits.pop(0)
                waited += wait
                run_log.stage(f"{capacity}, so the revision waits {_minutes(wait)} and goes on")
                await _capacity_sleep(wait)
                attempt -= 1
                if resume:
                    prompt = tools.hint(agent_session.RETRY_PROMPT)
                continue
            rep = await views.gate(c, slug, views._kept_locators(c, slug))
            if rep.get("ok"):
                run_log.stage(f"checks passed: {len(rep.get('checks') or [])} ref(s), the page loaded")
                if chat:
                    _close_chat({"workspace": c, "chat": chat}, "done", result_text[:400] or None)
                return True, result_text
            why = views.first_failure(rep) or "the checks did not pass"
            run_log.stage(f"checks failed: {why}")
            prompt = build_gates_prompt("\n".join(views.gate_lines(rep)))
    except asyncio.CancelledError:
        await asyncio.to_thread(SESSIONS.stop, run.session)
        if chat:
            _close_chat({"workspace": c, "chat": chat}, "stopped", "the review was stopped")
        raise
    finally:
        checks.cancel()
        _unhost(c, view_key(slug))
        if _review_runs.get((c, slug)) is run:
            del _review_runs[(c, slug)]
    if chat:
        _close_chat({"workspace": c, "chat": chat}, "failed", why[:ERROR_CHARS] or None)
    return False, why


CAPACITY_WORDS = {"overloaded": "Anthropic's API was overloaded", "rate_limited": "Anthropic's API rate limit was reached",
                  "server_error": "Anthropic's API had a server error"}
# a view build whose last turn the API ended once every wait (view_capacity_waits) was spent: the failure on the chip
# of a view the analyst asked for, and the reason in the line an orientation's dropped proposal gets
CAPACITY_WHY = "{why} each time the build tried over {waited}"
REVIEW_CAPACITY_WHY = "{why} each time the revision tried over {waited}"
CAPACITY_FAILED = CAPACITY_WHY + ", so it stopped; Retry goes on from there. ({error})"
# the failure of a change to a built view whose session ended its turn with the view's files as they were built
UNCHANGED_LINE = "the session changed none of the view's files"


def _retry_streak_s() -> float:
    """The run time after which a session's next capacity failure starts its schedule afresh (agent_session's
    RETRY_MAX_S); a view build's turn follows the same rule."""
    from . import agent_session  # noqa: PLC0415

    return agent_session.RETRY_MAX_S


def capacity_failure(text: str | None) -> str:
    """Why a view build's turn ended when the API stopped it, in plain words ('' when it did not): the `API Error: …`
    line Claude Code ends such a turn with (retry.transient_class)."""
    from . import retry  # noqa: PLC0415

    t = str(text or "")
    if "API Error" not in t:
        return ""
    return CAPACITY_WORDS.get(retry.transient_class(None, t) or "", "")


FIX_BODY = "thimble's server is down or unhealthy (thimble doctor, below)."


def ticket_contained(c: str | None) -> bool:
    """Whether a code ticket of workspace `c` (None: `thimble fix`'s) runs contained (`contained`), so the analyst is
    asked only before its change is applied. Blocking: the first call probes the box."""
    try:
        return contained(dev_config(c, sandbox=True, hosted=bool(c)))
    except userconf.ConfigError:
        return False


def fix_contained() -> bool:
    return ticket_contained(None)


async def fix_offline(doctor: str, approve: Approve, title: str = "fix: thimble server is down") -> str:
    """`thimble fix`: one ticket on prompts/dev-fix.md, run by a background session in a worktree without a stack and
    fast-forwarded into the live checkout once `approve` says yes; the caller restarts the server, and has asked the
    analyst's Allow (CODE_QUESTION) in the terminal first where the ticket is not contained (fix_contained)."""
    t = file_ticket(None, title, FIX_BODY, "terminal", start=False)
    run = Run(ticket_id=t["id"], title=t["title"], ts_start=_now())
    _update(t["id"], status="running", attempts=1, runner=os.getpid(), finished=False)
    rec = await run_ticket({**t, "attempts": 1}, run, doctor=doctor, allowed=True, approve=approve)
    return f"fix ticket {rec.get('status')}: {rec.get('error') or (rec.get('result') or '')[:600]}"


async def shutdown() -> None:
    """Lifespan shutdown: cancel the running ticket, stop the stack, record the ticket as failed; cancel the view
    tickets' builds, which stop their sessions and stay building for recover_views."""
    global _closing
    _closing = True
    view_tasks = [r.task for r in _view_runs.values() if r.task is not None and not r.task.done()]
    for task in view_tasks:
        task.cancel()
    if view_tasks:
        await asyncio.gather(*view_tasks, return_exceptions=True)
    run = _current
    if run is None or run.status != "running":
        return
    task = run.task
    if task is not None and not task.done():
        task.cancel()
        try:
            await task
        except (asyncio.CancelledError, Exception):  # noqa: BLE001
            pass
    if run.status == "running":
        run.status = "failed"
        why = "server shut down during the run"
        rec = _update(run.ticket_id, status="failed", error=why, ts_end=_now(), finished=True)
        if rec:
            _finish(rec, why)


# ----------------------------------------------------------------------------- the served UI's build


def rebuild_ui_script() -> Path:
    return REPO / "scripts" / "rebuild_ui.sh"


async def _rebuild_ui_cmd() -> tuple[int, str]:
    """scripts/rebuild_ui.sh over the live checkout's frontend, the typecheck skipped since the gates ran it."""
    script = rebuild_ui_script()
    if not script.is_file():
        return 1, f"{script} is missing"
    return await _run(["bash", str(script), "--frontend", str(REPO / "frontend"), "--skip-typecheck"], cwd=REPO,
                      timeout=UI_BUILD_TIMEOUT_S)


REBUILD_UI: Callable[[], Awaitable[tuple[int, str]]] = _rebuild_ui_cmd
_ui_build_lock: asyncio.Lock | None = None


def ui_updated_line(title: str) -> str:
    return UI_UPDATED_LINE.format(title=title)


async def rebuild_ui(t: dict[str, Any] | None, *, reason: str = "ticket") -> str:
    """Rebuild the served UI after a frontend change landed in the live checkout; on success the ticket's workspace
    hears `server ui_updated` (every workspace when the ticket names none). Builds one at a time. "built" | "failed"."""
    global _ui_build_lock
    if _ui_build_lock is None:
        _ui_build_lock = asyncio.Lock()
    title = str((t or {}).get("title") or reason)
    tid = str(t["id"]) if t and t.get("id") else None
    workspace = str((t or {}).get("workspace") or "") or None
    if tid:
        _update(tid, ui_build="building")
    async with _ui_build_lock:
        try:
            code, out = await REBUILD_UI()
        except Exception as e:  # noqa: BLE001
            log.exception("the UI build could not run")
            code, out = 1, f"{type(e).__name__}: {e}"
    ok = code == 0
    if tid:
        _update(tid, ui_build="built" if ok else "failed", **({} if ok else {"ui_build_error": out[-1500:]}))
    if not ok:
        log.error("the UI build after %r failed (%d): %s", title, code, out[-800:])
        return "failed"
    _emit_all({"type": "server", "status": "ui_updated", "title": title, "text": ui_updated_line(title)},
              only=[workspace] if workspace else None)
    return "built"


# ----------------------------------------------------------------------------- restart rules


def orient_running() -> list[str]:
    """Workspaces whose orient/run.json says running."""
    out = []
    for c in _workspaces():
        p = config.WORKSPACES_DIR / c / "orient" / "run.json"
        try:
            if json.loads(p.read_text("utf-8")).get("status") == "running":
                out.append(c)
        except (OSError, ValueError, AttributeError):
            continue
    return out


def restart_file() -> Path:
    return thimble_home() / "restart.json"


def supervised() -> bool:
    """Whether the supervisor started this process (`thimble server up` set SUPERVISED_ENV and recorded its pid in
    server.json). Only such a server restarts itself or rebuilds its UI after an apply."""
    if os.environ.get(SUPERVISED_ENV) != "1":
        return False
    return cli.read_state().get("pid") == os.getpid()


def _under_reloader() -> bool:
    """This server is the worker of uvicorn's `--reload` (a dev-mode server, cli.backend_cmd), which the reloader ends
    and starts again as soon as a .py file under backend/app changes."""
    parent = procs.argv(os.getppid())
    return "--reload" in parent and any("uvicorn" in a for a in parent)


def _reloads(touched: list[str]) -> bool:
    """Whether the apply of `touched` restarts this server through uvicorn's reloader, which watches the .py files."""
    return any(p.startswith(BOOT_PREFIXES) and p.endswith(".py") for p in touched) and _under_reloader()


try:
    # read once at start, so the copy spawn_restart_watch writes is the known-good one even when the ticket changed the
    # file
    _WATCH_SRC = Path(__file__).with_name("restart_watch.py").read_text("utf-8")
except OSError:
    _WATCH_SRC = ""


def spawn_restart_watch(t: dict[str, Any], prev_head: str | None, *, respawn: bool) -> int | None:
    """Start restart_watch.py detached over the restart after ticket `t`'s apply: it rolls the apply back when no server
    with a new boot token answers within RESTART_WATCH_S. With `respawn` (an execv restart) it also restarts the server.
    The pid, or None."""
    if not _WATCH_SRC or not t.get("commit") or not prev_head:
        return None
    home = thimble_home()
    script = home / "restart-watch.py"
    args = {"port": config_port(), "boot": config.BOOT_ID, "repo": str(REPO), "commit": t["commit"],
            "prev_head": prev_head, "ticket_id": t.get("id"), "title": t.get("title"), "home": str(home),
            "wait_s": RESTART_WATCH_S, "pid": os.getpid() if respawn else None,
            "argv": _restart_argv() if respawn else None, "cwd": os.getcwd(), "server_json": str(cli.server_json())}
    try:
        home.mkdir(parents=True, exist_ok=True)
        atomic_write_text(script, _WATCH_SRC)
        with cli.log_path().open("ab") as out:
            proc = subprocess.Popen([sys.executable, str(script), json.dumps(args)], cwd=str(home),
                                    stdin=subprocess.DEVNULL, stdout=out, stderr=subprocess.STDOUT,
                                    start_new_session=True, close_fds=True)
    except OSError:
        log.exception("the restart watch did not start; the restart goes on without it")
        return None
    log.info("restart watch %d over the apply of %r (%s)", proc.pid, t.get("title"), str(t["commit"])[:7])
    return proc.pid


def rollback_file() -> Path:
    return thimble_home() / "rollback.json"


_ERROR_LINE_RE = re.compile(r"^\w+(\.\w+)*(Error|Exception|Exit|Interrupt)\b.*|^\w*Error:.*")


def last_error_line(log_tail: str) -> str:
    """The last line of a server log's tail that names an exception (`RuntimeError: ...`), else its last line; ''
    for an empty tail."""
    lines = [ln.strip() for ln in (log_tail or "").splitlines() if ln.strip()]
    hit = next((ln for ln in reversed(lines) if _ERROR_LINE_RE.match(ln)), None)
    return (hit or (lines[-1] if lines else ""))[:300]


ROLLBACK_LINE = "thimble did not come back after this change, so it was rolled back and the previous code started again"


def recover_rollback() -> dict[str, Any] | None:
    """After a start: record a rollback the restart watch made (rollback.json) as the revert of its apply, mark its
    ticket `rolled back` and tell main. What was recovered, or None."""
    p = rollback_file()
    try:
        rb = json.loads(p.read_text("utf-8"))
    except (OSError, ValueError):
        return None
    with contextlib.suppress(OSError):
        p.unlink()
    if not isinstance(rb, dict):
        return None
    tid = str(rb.get("ticket_id") or "")
    if rb.get("ok"):
        _append_jsonl(applies_path(), {"ts": rb.get("ts") or _now(), "kind": "revert", "reverts": rb.get("commit"),
                                       "commit": rb.get("reverted"), "ticket_id": tid or None, "title": rb.get("title"),
                                       "why": ROLLBACK_LINE})
    why = ROLLBACK_LINE if rb.get("ok") else f"thimble did not come back after this change, and the rollback failed: {rb.get('error')}"
    log.error("ticket %s: %s", tid or "?", why)
    t = _get(tid) if tid else None
    if t is not None:
        # the whole tail stays on the ticket; its thread gets the line saying why the server did not start
        tail = str(rb.get("log_tail") or "")[-4000:]
        rec = _update(tid, status="rolled back", error=why, restart=None, finished=True,
                      rollback_log=tail or None) or t
        run_log = _log_for(rec)
        if cause := last_error_line(tail):
            run_log.stage(f"the server did not start after the change: {cause}")
        if rec.get("workspace") and rec.get("chat"):
            with contextlib.suppress(Exception):
                agents.update_agent(str(rec["workspace"]), str(rec["chat"]), status="failed", result=why)
        _chip(rec, f"{_label(rec)} rolled back: {why}", "rolled back")
        _ticket_event(rec, "rolled back")
    return rb


async def request_restart(t: dict[str, Any] | None, reason: str = "ticket") -> str:
    """Restart now, or defer while an orientation runs; on a server the supervisor did not start, neither (the ticket's
    restart is "manual" and its chip says so). "restarting" | "restart_pending" | "manual"."""
    global _restart_pending, _poller
    title = str((t or {}).get("title") or reason)
    if t and t.get("id") and _reloads(t.get("touched") or []):
        # uvicorn's reloader has restarted the server already, as the apply changed its files
        _update(t["id"], restart="reloaded")
        return "reloaded"
    if not supervised():
        if t and t.get("id"):
            rec = _update(t["id"], restart="manual")
            if rec:
                _chip(rec, APPLIED_RESTART_LINE.format(label=_label(rec)))
        log.info("not restarting for %r: this server was not started by the supervisor", title)
        return "manual"
    running = orient_running()
    if running:
        _restart_pending = {"ticket_id": (t or {}).get("id"), "title": title, "requested": _now(), "waiting_on": running}
        if t and t.get("id"):
            rec = _update(t["id"], status="applied, restart pending", restart="pending")
            if rec:
                _ticket_event(rec, "applied, restart pending")
        _emit_all({"type": "server", "status": "restart_pending", "title": title, "text": pending_line(title)})
        if _poller is None or _poller.done():
            _poller = asyncio.create_task(_pending_poller())
        return "restart_pending"
    tid = str(t["id"]) if t and t.get("id") else None
    if tid:
        _update(tid, restart="restarting")
    asyncio.get_running_loop().call_later(0.5, lambda: asyncio.ensure_future(_do_restart(title, ticket_id=tid)))
    return "restarting"


async def _pending_poller() -> None:
    while _restart_pending is not None:
        await asyncio.sleep(2.0)
        if _restart_pending is not None and not orient_running():
            await orient_ended(None)
            return


async def orient_ended(c: str | None) -> None:
    """Fires a deferred restart once no orientation is running. The pending poller calls it, since an
    orientation's end is recorded only in orient/run.json (orientation.finished)."""
    global _restart_pending
    if _restart_pending is None or orient_running():
        return
    pending, _restart_pending = _restart_pending, None
    if pending.get("ticket_id"):
        _update(str(pending["ticket_id"]), restart="restarting")
    await _do_restart(str(pending.get("title") or "ticket"), ticket_id=pending.get("ticket_id"))


def _restart_argv() -> list[str]:
    return [sys.executable, "-m", "uvicorn", *sys.argv[1:]]


async def _shutdown_others() -> None:
    """The other modules' `shutdown()`, as main's lifespan would run them."""
    for name, mod in list(sys.modules.items()):
        if not name.startswith("app.") or name == __name__ or mod is None:
            continue
        fn = getattr(mod, "shutdown", None)
        if fn is None or not asyncio.iscoroutinefunction(fn):
            continue
        try:
            await fn()
        except Exception:  # noqa: BLE001
            log.exception("shutdown of %s before restart failed", name)


async def _do_restart(title: str, *, ticket_id: str | None = None) -> None:
    """Restart this server in place (execv). After a ticket's apply, the restart watch goes first, so a change that
    keeps the server from coming back is rolled back and the previous code started again."""
    global _closing
    _emit_all({"type": "server", "status": "restarting", "title": title})
    try:
        restart_file().parent.mkdir(parents=True, exist_ok=True)
        restart_file().write_text(json.dumps({"title": title, "ts": _now()}) + "\n", "utf-8")
    except OSError:
        log.exception("could not write restart.json")
    if ticket_id:
        t, a = _get(ticket_id), apply_of(ticket_id)
        if t is not None and a is not None:
            spawn_restart_watch({**t, "commit": a.get("commit")}, a.get("prev_head"), respawn=True)
    cli.hand_over_kernels(os.getpid())  # the same pid after the execv takes its kernels back (notebook.shutdown)
    await shutdown()
    await _shutdown_others()
    await asyncio.sleep(0.2)
    log.info("restarting for %r", title)
    try:
        EXECV(_restart_argv())
    except OSError:
        log.exception("the restart's execv failed; this server goes on")
    _closing = False  # reached only when no execv replaced the process: this server goes on running tickets


async def announce_restart() -> dict[str, Any] | None:
    """After a restart: one `server restarted` event and one chip per workspace saying whether cells must be re-run;
    restart.json is consumed. What was announced, or None."""
    global _announced
    _announced = True
    p = restart_file()
    try:
        rec = json.loads(p.read_text("utf-8"))
    except (OSError, ValueError):
        return None
    try:
        p.unlink()
    except OSError:
        pass
    title = str(rec.get("title") or "manual restart")
    await _wait_kernels_reconnected()
    spaces = _workspaces()
    texts: dict[str, str] = {}
    for c in spaces:
        texts[c] = reset_line(title, kept=kernels_kept(c))
        _emit_ws(c, {"type": "server", "status": "restarted", "title": title, "text": texts[c]})
        try:
            agents.chip(c, "say", texts[c])
        except Exception:  # noqa: BLE001
            log.exception("restart chip for %s failed", c)
    return {"title": title, "workspaces": spaces, "text": reset_line(title), "texts": texts}


async def _on_first_request() -> None:
    if not _announced:
        _recover()
        await announce_restart()
        _start_next_if_idle()


# ----------------------------------------------------------------------------- routes


class NewTicket(BaseModel):
    workspace: str | None = None
    title: str = ""
    body: str = ""
    target: dict[str, Any] = Field(default_factory=dict)
    source: str = "ui"
    urgent: bool = False


def _is_loopback(request: Request) -> bool:
    host = request.client.host if request.client else ""
    return host in LOOPBACK


def _ticket_or_404(tid: str) -> dict[str, Any]:
    t = _get(tid)
    if t is None:
        raise HTTPException(404, "no such ticket")
    return t


@router.post("/dev/tickets", status_code=202)
async def post_ticket(body: NewTicket, request: Request) -> dict[str, Any]:
    await _on_first_request()
    if not _is_loopback(request):
        raise HTTPException(403, "tickets are filed from localhost only")
    try:
        return file_ticket(body.workspace, body.title, body.body, body.source, urgent=body.urgent, target=body.target)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


@router.get("/dev/tickets")
async def list_tickets(workspace: str | None = None) -> list[dict[str, Any]]:
    await _on_first_request()
    items = _read()
    if workspace is not None:
        items = [t for t in items if t.get("workspace") == (workspace or None)]
    return items


@router.get("/dev/tickets/{tid}")
async def get_ticket(tid: str) -> dict[str, Any]:
    return _ticket_or_404(tid)


@router.get("/dev/tickets/{tid}/shots/{name}")
def ticket_shot(tid: str, name: str) -> FileResponse:
    if not ID_RE.fullmatch(tid) or not SHOT_NAME_RE.fullmatch(name):
        raise HTTPException(400, "bad name")
    _ticket_or_404(tid)
    p = shots_dir(tid) / name
    if not p.is_file():
        raise HTTPException(404, "no such shot")
    return FileResponse(p, media_type="image/png")


def _stop_run(tid: str, why: str) -> bool:
    """Cancel this process's run of the ticket, which ends it `why` (stopped or dismissed) once its session is stopped
    and its worktree removed; False when this process is not running it."""
    run = _current
    if run is None or run.ticket_id != tid or run.status != "running" or run.task is None or run.task.done():
        return False
    run.stop_reason = why
    run.task.cancel()
    return True


# why the build of a view the analyst asked for stopped when main's session ended (stop_workspace), its Retry's line
MAIN_ENDED = "thimble stopped when its Claude Code session ended"


def stop_workspace(c: str) -> int:
    """Stop what runs for workspace `c` here, main's session having ended (agents.stop_all): its code ticket, which ends
    `stopped` (Retry runs it again), its view builds, queued or running, and the reviews of its views. A view the analyst
    asked for fails with MAIN_ENDED and Retry; a session's proposal waits for resume_views. Returns how many were
    stopped."""
    from . import view_review, views  # noqa: PLC0415

    n = 0
    t = _get(_current.ticket_id) if _current is not None and not _current.ticket_id.startswith("view:") else None
    if t is not None and t.get("workspace") == c and _stop_run(_current.ticket_id, "stopped"):
        n += 1
    for key in [k for k in [*_view_queue, *_view_runs] if k[0] == c]:
        asked = bool((views.read_proposal(*key) or {}).get("asked"))
        if key in _view_queue:
            _view_queue.remove(key)
            if asked:
                _view_failed(*key, MAIN_ENDED)
        run = _view_runs.get(key)
        if run is not None and run.task is not None and not run.task.done():
            run.status = MAIN_ENDED if asked else "stopped"
            run.task.cancel()
            n += 1
        if not asked:
            _parked.add(key)
    for p in views.list_proposals(c):
        if view_review.stop(c, str(p["slug"])):
            n += 1
    return n


def workspaces_at_work() -> set[str]:
    """The workspaces this server runs a code ticket, a view build or a view review for, or has view tickets queued for."""
    from . import view_review  # noqa: PLC0415

    t = _get(_current.ticket_id) if _running() and _current is not None and not _current.ticket_id.startswith("view:") else None
    return ({c for c, _ in [*_view_queue, *_view_runs]} | {c for c, _ in view_review._runs}
            | ({str(t["workspace"])} if t is not None and t.get("workspace") else set()))


def resume_views(c: str) -> None:
    """A session is main in workspace `c`: the view tickets stop_workspace left waiting, and those a previous server
    left, are queued again (recover_views)."""
    _parked.difference_update({k for k in _parked if k[0] == c})
    recover_views(c)


@router.post("/dev/tickets/{tid}/stop", status_code=202)
async def stop_ticket(tid: str) -> dict[str, Any]:
    """Stop the running ticket: its session is stopped, nothing is applied, and it ends `stopped`, which Retry runs
    again. 409 when it is not running here."""
    t = _ticket_or_404(tid)
    if t.get("status") != "running" or not _stop_run(tid, "stopped"):
        raise HTTPException(409, f"the ticket is {t.get('status')}, not running here")
    log.info("ticket %s stopped by the analyst", tid)
    return {"ok": True}


@router.post("/dev/tickets/{tid}/dismiss")
async def dismiss_ticket(tid: str) -> dict[str, bool]:
    """Drop the ticket: a running one is stopped first. Its branch goes with it, and an applied change stays."""
    t = _ticket_or_404(tid)
    if t.get("status") == "running":
        if not _stop_run(tid, "dismissed"):
            raise HTTPException(409, "the ticket is running in another server of this checkout")
        return {"ok": True}
    rec = _update(tid, status="dismissed") or t
    _close_chat(rec, "stopped", "dismissed")
    _ticket_event(rec, "dismissed")
    try:
        await asyncio.to_thread(remove_ticket_tree, t)
    except Exception:  # noqa: BLE001
        log.exception("cleanup after dismiss failed")
    return {"ok": True}


RETRYABLE = (*FAILED, "reverted", "dismissed")


@router.post("/dev/tickets/{tid}/retry", status_code=202)
async def retry_ticket(tid: str, request: Request) -> dict[str, Any]:
    """Queue the ticket again, in a new agent chat; its run wakes the ticket's session. A ticket this server cannot run
    fails again at once, saying why. 409 for one that is queued, running or applied."""
    t = _ticket_or_404(tid)
    if t.get("status") not in RETRYABLE:
        raise HTTPException(409, f"the ticket is {t.get('status')}")
    _close_chat(t, "stopped", "retried")
    try:
        chat = _open_chat(t)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    rec = _update(tid, status="queued", error=None, ts_end=None, chat=chat, interrupted=0) or t
    log.info("ticket %s queued again (Retry)", tid)
    _ticket_event(rec, "queued")
    if why := runner_problem():
        return _fail_now(rec, why)
    if _is_loopback(request):
        _start_next_if_idle()
    return _get(tid) or rec


@router.get("/dev/status")
async def status() -> dict[str, Any]:
    """The runner's state: what runs, how many wait, a pending restart and the last apply."""
    await _on_first_request()
    _start_next_if_idle()
    run = _current
    running = run is not None and run.status == "running"
    rt = _get(run.ticket_id) if running and run else None
    la = last_apply()
    return {
        "running": running,
        "current": {"id": rt["id"], "n": rt.get("n"), "title": rt["title"], "workspace": rt.get("workspace"),
                    "ts_start": run.ts_start} if running and run and rt else None,
        "queued": sum(1 for t in _read() if t.get("status") == "queued"),
        "restart_pending": (_restart_pending or {}).get("title"),
        "last_apply": {"ts": la["ts"], "title": la["title"], "commit": la["commit"]} if la else None,
    }


@router.post("/dev/restart", status_code=202)
async def post_restart(request: Request) -> dict[str, Any]:
    if not _is_loopback(request):
        raise HTTPException(403, "restart is only available from localhost")
    return {"status": await request_restart(None, reason="manual restart")}


@router.post("/dev/announce")
async def post_announce() -> dict[str, Any]:
    """`thimble restart` calls this once the new server answers: the restart notice goes out."""
    _recover()
    return {"announced": await announce_restart()}


@router.post("/dev/revert")
async def post_revert(request: Request) -> dict[str, Any]:
    if not _is_loopback(request):
        raise HTTPException(403, "revert is only available from localhost")
    if _running():
        raise HTTPException(409, "a ticket is running")
    res = await asyncio.to_thread(revert_last_apply)
    if res.get("ok") and needs_ui_build([str(p) for p in res.get("touched") or []]) and serves_built_ui():
        res["ui_build"] = "building"
        asyncio.create_task(rebuild_ui({"title": f"revert of {res.get('title')}", "id": res.get("ticket_id"),
                                        "workspace": res.get("workspace")}, reason="revert"))
    if res.get("ok") and res.get("restart"):
        res["restart"] = await request_restart({"title": f"revert of {res.get('title')}"}, reason="revert")
    return res

