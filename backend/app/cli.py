"""The supervisor behind `plugin/bin/thimble`: the server's lifecycle from a shell or the /thimble skill.

    thimble server up [--cwd <path>] [--session <id>] [--action status|fix|repair|fresh|restore|feedback]
                      [--archive <name>]
    thimble server status [--cwd <path>] | repair | stop [--yes] | restart [--keep-vite] [--yes]
    thimble doctor | fix | revert | stop [--yes] | restart [--keep-vite] [--yes]
    thimble update [--from <zip>] [--dry-run]
    thimble feedback ["description"] [--no-logs]   (a problem report as a zip; feedback.py)
    thimble list                           (the workspaces by id, archived runs included; runs.py)
    thimble purge <id>… [--dry-run]        (delete workspaces or archived runs by id; runs.py)
    thimble launch-args --cwd <path>       (the launcher's: plugin folder, allowed tools, main's effort and settings, turn tools, main's name, session id, env, unset, note, mode and export lines, main's prompt)
    thimble prompt <name>… [--cwd <path>]  (prompt files rendered for a session in <path>, for skills and hooks)
    thimble extension add <folder | git URL | built-in name> [--yes] | on <name> | off <name> | list | remove <name>
                                                                                              (extensions.py)

`server up` (alias `ensure`) is the one starter: `GET /api/health`, then under `flock <home>/server.lock` spawn uvicorn
on THIMBLE_PORT (8300) as its own session leader (plus Vite on 5300 when THIMBLE_DEV is on), wait for health, map the
cwd to a workspace, print `thimble: <url>` (LINK_LINE in a session), and name the session to the server. It always
exits 0, since a skill fails whole when its command exits non-zero. `--action fresh` moves the workspace aside into
<workspaces>/.archive/; `--action restore` restores an archive. Where the plugin's hooks are off, /thimble also prints
the command main's Monitor runs (cc_plugin.route, monitor_lines).

<home> is `~/.thimble` or THIMBLE_HOME. <home>/server.json records {port, pid, url, repo, env, token, ui_key}, readable
by its owner alone; `token` is new at each start and is what the plugin's hooks prove they hold, and `ui_key`, kept
across starts, is what the link gives the browser to answer permission requests and change permission modes
(hook_auth.py). Only a terminal gets that link: `up` from a shell prints it, and /thimble prints LINK_LINE for main's
Stop hook to show it (leave_link). Its `pid` is trusted only while it is a thimble server on its port (is_server checks
the command line and working folder, since a pid recorded inside a sandbox's pid namespace can name an unrelated host
process). reconcile makes the record true before `up` acts on it. A server whose /api/health names another
THIMBLE_HOME belongs to another install and is refused.

Claude Code's Bash sandbox gives each command its own network and pid namespace, where a server would die with the
command and the host's cannot be reached. So /thimble's work runs in the plugin's UserPromptExpansion hook, which Claude
Code runs outside the sandbox just before the skill's commands (`server up --hook`, hook_up): it keeps what `up` printed
in <home>/up/<session>.json, and the skill's `up` prints that (take_hook_result), or does the work itself when the hook
left nothing. In the sandbox without the hook's result `up` starts nothing and prints the `sandbox.excludedCommands`
entries that would run it outside (sandbox_line). `restart` and `stop` name the work
they would interrupt (running_work) and ask first unless `--yes`. In dev mode an `up` that finds the source tree changed
while the server is idle restarts the backend (THIMBLE_NO_AUTORESTART=1 disables it). This module imports only
`config`, `procs`, `cc_plugin`, `launch_mode` and the standard library (others lazily), never `app.notebook`.

Terminal mode (`thimble mode terminal`, launch_mode.py) starts no server: launch-args then registers the folder and
writes launch.json with `mode: terminal`, the hooks module's roles file and main's fence with the card folders, and the
launcher loads the renderer plugin (TERMINAL_RENDERER) and opens Claude Code with no first prompt. `server up --hook`
and /thimble start nothing there and print the `thimble-terminal-home` hint (terminal_session). One mode per workspace
at a time: `thimble`, and a /thimble that opens the browser, refuse while launch.json names a live `claude` of the
other mode (open_elsewhere).
"""
from __future__ import annotations

import argparse
import errno
import fcntl
import hashlib
import importlib.util
import io
import json
import os
import platform
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
import traceback
import urllib.error
import urllib.parse
import urllib.request
import uuid
from contextlib import contextmanager, redirect_stdout, suppress
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator, Mapping, NamedTuple

from . import cc_plugin, config, headless, launch_mode, procs

DEFAULT_PORT = 8300
DEFAULT_UI_PORT = 5300
VALIDATION_PORTS = (8301, 5301)  # scripts/dev/dev_stack.sh's defaults; THIMBLE_STACK_PORT and _UI_PORT move them
BACKEND_DIR = config.REPO_ROOT / "backend"
FRONTEND_DIR = config.REPO_ROOT / "frontend"
PLUGIN_DIR = config.REPO_ROOT / "plugin"
WAIT_S = 20.0
LOCK_WAIT_S = 30.0
STOP_WAIT_S = 6.0
HEALTH_TIMEOUT_S = 1.0
LOG_TAIL = 15
FIX_INSTRUCTION = "File a `file_dev_ticket` titled 'fix: …' describing what broke; the dev agent runs it as a ticket."
# `thimble fix` and `thimble revert` change thimble's own code, which only a development install (a git clone of thimble)
# can do: a release install has no dev agent to repair it and no applied change to take back (dev.RELEASE_LINE)
DEV_ONLY_LINES = {
    "fix": ("thimble fix changes thimble's own code, which only a development install (a git clone of thimble) can do, "
            "and this is a release install. `thimble doctor` says what is wrong, and `thimble feedback` writes a problem "
            "report to send the developer."),
    "revert": ("thimble revert takes back a change thimble's dev agent made to thimble's own code, which happens only in a "
               "development install (a git clone of thimble). This is a release install, so there is nothing to revert."),
}
FINGERPRINT_GLOBS = ("backend/app/**/*.py", "prompts/**/*", "plugin/bin/*", "plugin/.mcp.json")
NO_AUTORESTART_ENV = "THIMBLE_NO_AUTORESTART"
SOURCE_CHANGED = "source changed"  # restart.json's title; dev.PLAIN_REASONS
RESTARTED_LINE = "thimble: server restarted (source changed)"
NOT_RESTARTED_LINE = "thimble: source changed since the server started; not restarting while {reason}"
REGISTER_FAILED_LINE = "thimble: could not open {path} as a workspace (the server refused to register it); see {log} and say `/thimble` again."
NO_UI_LINE = "thimble: the dashboard is not built yet, so its link shows no page; run `thimble doctor` in a shell for the fix."
NO_AUTH_LINE = "thimble: WARNING - {problem}. Nothing that calls a model runs until then."
FEEDBACK = "feedback"  # /thimble feedback: the problem report (feedback.py)
# where the server did not start: how to send the developer a problem report, which needs no server
REPORT_LINE = ("thimble: to report it, say `/thimble feedback` or run `thimble feedback \"the server did not start\"` in a "
               "shell; either writes a zip with the logs to send the developer.")
# a server of this install that runs, holding its port, but does not answer (out of file descriptors, or its loop held)
STUCK_LINE = "thimble's server (pid {pid}) is running but does not answer; restart it with `thimble server restart`"
STUCK_AFTER_S = 60.0  # a server server.json says started less long ago may still be starting, so is not called stuck
UNINSTALL_SHELL_LINE = "thimble: uninstall is a shell command, not a /thimble action. Run `thimble uninstall` in a terminal; it says what it will remove and asks first."
# What /thimble prints where the plugin's hooks are off, so that thimble connects through main's Monitor
# (cc_plugin.route): on that route permission prompts stay in the terminal, and after /clear the Monitor is gone, so the
# note asks for /thimble again.
MONITOR_NOTE = ("thimble: WARNING - your settings or your organization's turn thimble's plugin hooks off in this "
                "session, so thimble connects through a Monitor instead. Permission prompts appear only here in the "
                "terminal, and Claude may ask you to confirm here what you approved in the browser. After /clear, say "
                "/thimble again.")
# the same in thimble's fence, which lets out only the /thimble of the session `thimble` started (SANDBOX_ACTIONS)
MONITOR_NOTE_FENCED = MONITOR_NOTE.replace("After /clear, say /thimble again.",
                                           "After /clear, quit and run `thimble -c` in this folder.")
MONITOR_MARK = "thimble-monitor:"  # then the command main's Monitor runs (plugin/skills/thimble/SKILL.md)
WATCHER = "bin/.thimble-watch"  # the plugin's hidden watcher, under its root
FRESH = "fresh"  # /thimble fresh: the folder's workspace moved aside, an empty one opened
RESUME = "restore"  # /thimble restore [<archive>]: an archive restored in its place, or the archives listed
ALIASES = {"resume": RESUME}  # another name the action takes
OPENING = ("", "on", FRESH, RESUME)  # the actions that open the workspace (and arm the Monitor where hooks are off)
RESUME_LINE = "thimble: resuming the dashboard from your last run; `/thimble fresh` starts over"
# /thimble in a session new to a workspace `thimble demo` installed from a pre-cache, which then gives the session what
# the orientation left as context (precached.py)
PRECACHED_LINE = ("thimble: opening the orientation that ran in advance on these files; this session starts fresh, "
                  "from its cards and report; `/thimble fresh` starts over")
# what /thimble prints in place of the link, which carries the ui_key and so is kept out of the model's context: main's
# Stop hook shows it under the reply (leave_link, plugin/bin/.thimble-watch)
LINK_LINE = "thimble: the dashboard link is under this reply (or run `thimble up` in a shell)"
# /thimble in a session the launcher did not start (no THIMBLE_LAUNCHED) and that runs outside thimble's fence
# (cc_plugin.fenced_argv): main and its subagents run unfenced there, and thimble's agents cannot start, since the hooks
# module serves only a launched, fenced main
UNFENCED_LINE = ("thimble: WARNING - this session was not started with `thimble`, so it and its subagents run without "
                 "thimble's sandbox and can change your files, and thimble's agents cannot start in it. Quit and run "
                 "`thimble` in this folder.")
LINKS_DIR = "links"  # under <home>: the link each session's Stop hook shows once
FRESH_LINE = ("thimble: Cleared the session at {cwd}. The last run is archived at {path}. To bring it back, run: "
              "/thimble restore {name}")
NOTHING_ARCHIVED_LINE = "thimble: this folder had no workspace to archive"
ARCHIVE_FAILED_LINE = "thimble: could not archive the last run, so the dashboard still shows it; see {log}"
RESTORED_LINE = "thimble: Restored the run archived as {name}."
RESTORED_REPLACED_LINE = ("thimble: Restored the run archived as {name}. The run it replaced is archived at {path}; to go back "
                          "to it, run: /thimble restore {replaced}")
NO_SUCH_ARCHIVE_LINE = "thimble: this folder has no archived run named {name}; `/thimble restore` lists them"
RESTORE_FAILED_LINE = "thimble: could not restore {name}, so the dashboard still shows the current run; see {log}"
ARCHIVES_LINE = "thimble: this folder's archived runs, newest first: {names}. `/thimble restore <name>` brings one back."
REVERTED_LINE = "thimble: reverted \"{title}\" ({commit})"
NO_ARCHIVES_LINE = "thimble: this folder has no archived runs"
ARCHIVE_TIMEOUT_S = 60.0  # the archive stops an orientation's or a writer's session first, a few seconds each
# marks the uvicorn `start` spawns, so a server knows the supervisor started it and may restart itself after a ticket
# applies (dev.supervised); a server started by hand lacks it and is never restarted by a ticket
SUPERVISED_ENV = "THIMBLE_SUPERVISED"
# the launcher exports it (plugin/bin/thimble), and Claude Code passes it on to the skill's command: main's prompt is
# appended to the session's system prompt already (launched)
LAUNCHED_ENV = cc_plugin.LAUNCHED_ENV  # "THIMBLE_LAUNCHED"
PLUGIN_ROOT_ENV = "THIMBLE_PLUGIN_ROOT"  # bin/thimble exports its plugin copy: the tree's plugin/, or an installed copy
MCP_TOOLS_RULE = "mcp__plugin_thimble_thimble"  # every tool of the plugin's thimble server, in a permission rule
# The agents defined for a session thimble starts with `--agents` (agent_definition: the writer's, the orientation's and
# the critic's own sessions), each from a prompt file in a plugin agent's form (prompts.agent_file).
AGENT_FIELDS = ("model", "effort", "background")  # the frontmatter fields passed on as they are
PLUGIN_NAME = "thimble"  # the plugin's name, which prefixes its skills (`thimble:shared`) outside a plugin agent's file
ANCHORS_DIR = "anchors"  # threads.IMAGE_DIR: each workspace's pictures of the elements its threads were opened on
RESTART_MARK_S = 60.0  # a `source_restart` mark in server.json younger than this means a restart is under way
REFUSED_LINE = "thimble: {path} is not a folder to open as a workspace; say /thimble from the folder that holds the corpus."
TAKEOVER_LINE = ("thimble: this session is main now. The session {other} in another terminal no longer hears the "
                 "browser, and is main again once this one exits.")
FOREIGN_LINE = ("thimble: port {port} is held by the thimble server of another install (THIMBLE_HOME {other}), so this "
                "install does not use it. Set THIMBLE_PORT to a free port, or stop that server with "
                "`THIMBLE_HOME={other} thimble server stop`.")
SANDBOX_ENV = "SANDBOX_RUNTIME"  # "1" in a command Claude Code's Bash sandbox runs (module note, the Bash sandbox)
# /thimble in the sandbox when the plugin's UserPromptExpansion hook left nothing (module note, the Bash sandbox)
SANDBOX_LINE = ("thimble: WARNING - Claude Code's Bash sandbox is on in this session and keeps /thimble from reaching "
                "thimble's server, and the plugin's hook that starts the server outside the sandbox did not finish (it "
                "needs a recent Claude Code, and a failure is in {log}), so there is no link. Update Claude Code and "
                "say /thimble again, or add \"{rule}\" to sandbox.excludedCommands in {settings}.")
SANDBOX_NO_HOOKS_LINE = ("thimble: WARNING - Claude Code's Bash sandbox is on in this session and keeps /thimble from "
                         "reaching thimble's server, and with the plugin's hooks off nothing can start the server "
                         "outside the sandbox, so there is no link. To fix it, add \"{rule}\" and \"{watch}\" to "
                         "sandbox.excludedCommands in {settings}, then say /thimble again.")
# In thimble's fence with the plugin's hooks off (main_fence), sandbox.excludedCommands lets out only the skill's own
# command for these actions, exactly as Claude Code spells it for main's session (sandbox_rules): the plain /thimble and
# /thimble status. Any other action, or the same command under another session id, stays in the sandbox, so main's Bash
# cannot run `--action fresh` or `fix` outside it; the command then says what to do instead (fenced_sandbox_line). The
# Monitor route's watcher is let out the same way, only as the command /thimble gives main's Monitor for main's session
# (watch_rules); with the hooks on nothing is let out.
SANDBOX_ACTIONS = ("", "status")
FENCE_ACTION_LINE = ("thimble: Claude Code's hooks are off in this session, so thimble's sandbox lets /thimble reach "
                     "thimble's server only to open the workspace or show its status. To run /thimble {words}, run "
                     "`thimble server up --action {action}{archive}` in a terminal in this folder.")
FENCE_SESSION_LINE = ("thimble: Claude Code's hooks are off in this session, so thimble's sandbox lets /thimble reach "
                      "thimble's server only in the session `thimble` started, and /clear or /resume gave this session "
                      "a new id. Quit, and run `thimble -c` in this folder.")
HOOK_RESULTS_DIR = "up"  # under <home>: what /thimble's hook left for the skill's command to print (hook_up)
# /thimble in a session the launcher started in terminal mode starts nothing: the renderer opens the home panel, and the
# skill's command prints this hint of prompts/tools.md (TERMINAL_HOME_LINE when the file has none), which main repeats
TERMINAL_HOME_HINT = "thimble-terminal-home"
TERMINAL_HOME_LINE = ("thimble: terminal mode. For the browser workspace, quit, run `thimble mode browser`, and start "
                      "`thimble` again.")
TERMINAL_ACTION_LINE = ("thimble: `/thimble {action}` works only in browser mode. For the browser workspace, quit, run "
                        "`thimble mode browser`, and start `thimble` again.")
HOOK_RESULT_S = 60.0  # a result older than this is not the one the hook left for this /thimble
MANUAL_RESTART = "manual restart"  # dev.PLAIN_REASONS
# what `restart` says before it asks (running_work, module note)
RUNNING_HEAD = "thimble: running now:"
RUNNING_BACK_LINE = ("A restart stops them. Once the server is back, the orientations and writers resume by themselves, "
                     "and a view build or dev ticket starts again.")
RUNNING_ENDS = " (the restart ends it)"
RESTART_QUESTION = "Restart the server now? [y/N] "
RESTART_UNASKED_LINE = "thimble: not restarted, since there is no terminal to ask in; pass --yes to restart anyway."
RESTART_DECLINED_LINE = "thimble: not restarted."
STOP_BACK_LINE = ("A stop ends them. The server's next start resumes the orientations and writers, and starts a view "
                  "build or dev ticket again.")
STOP_QUESTION = "Stop the server now? [y/N] "
STOP_UNASKED_LINE = "thimble: not stopped, since there is no terminal to ask in; pass --yes to stop anyway."
STOP_DECLINED_LINE = "thimble: not stopped."
RUNNING_KINDS = {"orient": "the orientation", "writer": "the writer", "check": "the report check",
                 "view": "the view build"}
NOTICES: list[str] = []  # lines `ensure_running` leaves for `cmd_ensure`
MAIN = "main"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# ----------------------------------------------------------------------------- files under <home>


def home() -> Path:
    """`~/.thimble`, or THIMBLE_HOME, read fresh so tests and scratch stacks can point it away."""
    return Path(os.environ.get("THIMBLE_HOME") or "~/.thimble").expanduser()


def ensure_home() -> Path:
    """<home>, made if missing and kept private (0700), since it holds the server's log, state and registry."""
    return config.private_dir(home())


def server_json() -> Path:
    return home() / "server.json"


def lock_path() -> Path:
    return home() / "server.lock"


def log_path() -> Path:
    return home() / "server.log"


def vite_log_path() -> Path:
    return home() / "vite.log"


def read_state() -> dict[str, Any]:
    try:
        data = json.loads(server_json().read_text("utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def new_token() -> str:
    return secrets.token_urlsafe(32)


def write_state(state: dict[str, Any]) -> None:
    """server.json, written whole into the private home (ensure_home), with the token and the ui_key the file held when
    `state` names none, else new ones (hook_auth.py)."""
    ensure_home()
    held = read_state()
    if not state.get("token"):
        state = {**state, "token": held.get("token") or new_token()}
    if not state.get("ui_key"):
        state = {**state, "ui_key": held.get("ui_key") or new_token()}
    p = server_json()
    tmp = p.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(state, indent=2) + "\n", "utf-8")
    tmp.replace(p)


def _read_json(p: Path) -> Any:
    try:
        return json.loads(p.read_text("utf-8"))
    except (OSError, ValueError):
        return None


def _log(line: str) -> None:
    """Supervisor diagnostics go to the server log, never to stdout."""
    try:
        ensure_home()
        with log_path().open("a", encoding="utf-8") as f:
            f.write(f"{_now()} thimble-server: {line}\n")
    except OSError:
        pass


# ----------------------------------------------------------------------------- configuration resolution


def port() -> int:
    v = os.environ.get("THIMBLE_PORT")
    if v and v.isdigit():
        return int(v)
    return int(read_state().get("port") or DEFAULT_PORT)


def ui_port() -> int:
    v = os.environ.get("THIMBLE_UI_PORT")
    if v and v.isdigit():
        return int(v)
    return int(read_state().get("ui_port") or DEFAULT_UI_PORT)


def api_url(p: int | None = None) -> str:
    return f"http://127.0.0.1:{p or port()}"


STATE_ENV_KEYS = ("data_dir", "workspaces_dir", "plugin_dir", "home")


def _same_tree(a: Any, b: Path) -> bool:
    try:
        return isinstance(a, str) and Path(a).expanduser().resolve() == Path(b).expanduser().resolve()
    except OSError:
        return False


def resolve_env() -> dict[str, Any]:
    """The names the server runs with: the caller's THIMBLE_* first, then the last server.json, then the defaults. A
    workspaces folder server.json recorded counts only when a server of this install wrote it, so a new install beside
    an earlier one never keeps that one's folder."""
    state = read_state()
    st = state.get("env") or {}
    data_dir = os.environ.get("THIMBLE_DATA_DIR") or st.get("data_dir") or str(config.default_data_dir())
    ours = _same_tree(state.get("repo"), config.REPO_ROOT)
    ws_dir = os.environ.get("THIMBLE_WORKSPACES_DIR") or (st.get("workspaces_dir") if ours else None) or str(config.WORKSPACES_DIR)
    # dev mode is the environment's alone, never server.json's, so a later /thimble from any session never spawns Vite
    # unasked
    dev = (os.environ.get("THIMBLE_DEV") or "").strip().lower() in ("1", "true", "yes", "on")
    return {"data_dir": str(Path(data_dir).expanduser()), "workspaces_dir": str(Path(ws_dir).expanduser()),
            "plugin_dir": str(PLUGIN_DIR), "home": str(home()), "dev": dev}


def _server_environ(env: dict[str, Any], p: int, ui: int) -> dict[str, str]:
    base = config.passed_environ()  # without the calling session's identity (config.passes)
    # the server runs in browser mode whoever starts it: no terminal session's mode or workspace (launch_mode.current)
    for name in (launch_mode.ENV, launch_mode.WS_ENV):
        base.pop(name, None)
    base.update({
        "THIMBLE_DATA_DIR": env["data_dir"],
        "THIMBLE_WORKSPACES_DIR": env["workspaces_dir"],
        "THIMBLE_PORT": str(p),
        "THIMBLE_UI_PORT": str(ui),
        "THIMBLE_FRONTEND_URL": f"http://127.0.0.1:{ui}",
        "THIMBLE_HOME": str(home()),
        "THIMBLE_DEV": "1" if env["dev"] else "0",
        SUPERVISED_ENV: "1",
    })
    return base


# ----------------------------------------------------------------------------- probes


def healthy(url: str | None = None, timeout: float = HEALTH_TIMEOUT_S) -> bool:
    try:
        with urllib.request.urlopen(f"{url or api_url()}/api/health", timeout=timeout) as r:
            return r.status == 200 and bool(json.loads(r.read() or b"{}").get("ok"))
    except Exception:  # noqa: BLE001
        return False


def listening(p: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.3)
        return s.connect_ex(("127.0.0.1", p)) == 0


def pid_alive(pid: int | None) -> bool:
    return procs.alive(pid)


def _cmdline(pid: int) -> str:
    return procs.cmdline(pid)


def server_argv_matches(argv: list[str], p: int) -> bool:
    """The identity of the pid server.json names: `uvicorn` in some argument, `app.main:app`, and `--port <p>` as
    whole arguments, whatever argv[0] is."""
    if not any("uvicorn" in a for a in argv) or "app.main:app" not in argv:
        return False
    want = str(p)
    return any((a == "--port" and i + 1 < len(argv) and argv[i + 1] == want) or a == f"--port={want}" for i, a in enumerate(argv))


def argv_check(*tokens: str):
    """`check` for _kill: every token appears in the command line. Returns the refusal reason or None."""

    def check(pid: int) -> str | None:
        cmd = _cmdline(pid)
        if cmd and all(t in cmd for t in tokens):
            return None
        return f"its command line is {cmd[:60].strip()!r}" if cmd else "its command line could not be read"

    return check


def server_check(p: int, repo: str | None = None):
    """`check` for _kill on the backend: server_argv_matches on port `p`, and a working directory under this tree or
    the checkout server.json recorded."""

    def check(pid: int) -> str | None:
        argv = procs.argv(pid)
        if not server_argv_matches(argv, p):
            cmd = " ".join(argv)
            return (f"its command line is {cmd[:60].strip()!r}, not uvicorn app.main:app --port {p}" if cmd
                    else "its command line could not be read")
        wd = procs.cwd(pid)
        if wd is not None and not procs.under(wd, config.REPO_ROOT) and not (repo and procs.under(wd, repo)):
            return f"it runs uvicorn app.main:app on port {p} from {wd}, not this checkout ({config.REPO_ROOT})"
        return None

    return check


def is_server(pid: Any, p: int, repo: str | None = None) -> bool:
    """Whether `pid` is a thimble server on port `p` (server_check), not merely a live pid (module note)."""
    return bool(pid) and pid_alive(pid) and server_check(p, repo)(int(pid)) is None


def health_leader(url: str | None = None) -> int | None:
    """The pid the server answering at `url` names as the leader of its process session (`leader` of /api/health). None
    when nothing answers or it names none. Seam for tests."""
    status, body = _request("GET", f"{url or api_url()}/api/health", timeout=HEALTH_TIMEOUT_S)
    leader = body.get("leader") if status == 200 and isinstance(body, dict) else None
    return leader if isinstance(leader, int) and not isinstance(leader, bool) and leader > 0 else None


def foreign_home(url: str | None = None) -> str | None:
    """The THIMBLE_HOME of the server answering at `url` when it is another install's; None when it is this install's, names
    none, or nothing answers. Two installs share a port by default."""
    status, body = _request("GET", f"{url or api_url()}/api/health", timeout=HEALTH_TIMEOUT_S)
    other = body.get("home") if status == 200 and isinstance(body, dict) else None
    if not isinstance(other, str) or not other:
        return None
    try:
        same = Path(other).resolve() == home().expanduser().resolve()
    except OSError:
        same = other == str(home())
    return None if same else other


def refuse_foreign(url: str | None = None) -> bool:
    """Print FOREIGN_LINE and return True when another install's server holds the port (foreign_home)."""
    other = foreign_home(url)
    if other:
        _log(f"port {port()} is held by the thimble server of {other}; not used")
        print(FOREIGN_LINE.format(port=port(), other=other))
    return bool(other)


def reconcile(st: dict[str, Any] | None = None) -> dict[str, Any]:
    """server.json made true: a recorded pid that is no thimble server on its port is cleared, a healthy server of this
    checkout on the port is adopted when none is recorded, and a dead Vite pid is cleared. The state, written back when it
    changed; {} when there is no record."""
    st = read_state() if st is None else st
    if not st:
        return st
    p = int(st.get("port") or port())
    changed = False
    pid = st.get("pid")
    if pid and not is_server(pid, p, st.get("repo")):
        _log(f"server.json named pid {pid}, which is not a thimble server on port {p}; cleared")
        st["pid"], changed = None, True
    if not st.get("pid"):
        leader = health_leader(api_url(p))
        if leader and is_server(leader, p, st.get("repo")) and not foreign_home(api_url(p)):
            _log(f"adopted the thimble server on port {p}, pid {leader}, which server.json did not name")
            st.update(pid=leader, stopped=None)
            changed = True
    vite = st.get("vite_pid")
    if vite and (not pid_alive(vite) or argv_check("vite")(int(vite)) is not None):
        st["vite_pid"], changed = None, True
    if changed:
        write_state(st)
    return st


def in_sandbox() -> bool:
    """Whether this command runs inside Claude Code's Bash sandbox."""
    return os.environ.get(SANDBOX_ENV, "").strip() == "1"


def sandbox_rule(root: Path | None = None) -> str:
    """The `sandbox.excludedCommands` entry that runs /thimble's `server up` outside the sandbox: the plugin copy's
    own path (`root`, by default plugin_root), as the skill's command spells it once Claude Code has put in its plugin
    root."""
    return f"{(root or plugin_root()) / 'bin' / 'thimble'} server up *"


def sandbox_rules(root: Path, cwd: Path, session: str | None) -> list[str]:
    """The `sandbox.excludedCommands` entries that let out the /thimble skill's own command for SANDBOX_ACTIONS in main's
    session `session`, in the corpus `cwd`, with the plugin copy at `root`: exactly the command Claude Code runs once it
    has put in the plugin root, the project folder (as `cwd` names it, and as its real path names it) and the session
    id, without the `2>&1` the skill adds, which Claude Code leaves out of the match (module note: a command that differs
    in any way stays in the sandbox). None without a session id, or where a value holds a character the skill's quotes
    would not keep."""
    if not session or not SESSION_ID_RE.fullmatch(session):
        return []
    folders = list(dict.fromkeys([str(cwd), os.path.realpath(cwd)]))
    if any(ch in f for f in folders for ch in '"\\$`\n'):
        return []
    return [f'{root / "bin" / "thimble"} server up --cwd "{f}" --session "{session}" --action "{a}" --archive ""'
            for f in folders for a in SANDBOX_ACTIONS]


def fenced_sandbox_line(cwd: Path, action: str, archive: str) -> str:
    """What /thimble prints in thimble's fence with the plugin's hooks off when its command ran in the sandbox (module
    note, SANDBOX_ACTIONS): the terminal command for an action the fence keeps in, else that /clear or /resume changed
    the session id; '' outside thimble's fence or with the hooks on."""
    if os.environ.get(cc_plugin.FENCE_MARK, "").strip() != "1" or not cc_plugin.hooks_blocked(cwd, plugin_root()):
        return ""
    if action in SANDBOX_ACTIONS:
        return FENCE_SESSION_LINE
    named = f" --archive {shlex.quote(archive)}" if archive else ""
    return FENCE_ACTION_LINE.format(words=" ".join(w for w in (action, archive) if w), action=shlex.quote(action),
                                    archive=named)


def watch_rule(root: Path | None = None) -> str:
    """The `sandbox.excludedCommands` entry that runs the Monitor route's watcher of the plugin copy at `root` (by
    default plugin_root) outside the sandbox, for a session outside thimble's fence (sandbox_line)."""
    return f"{(root or plugin_root()) / WATCHER} --stream *"


def watch_rules(root: Path, cwd: Path, session: str | None) -> list[str]:
    """The `sandbox.excludedCommands` entries that let out the Monitor route's watcher in thimble's fence: exactly the
    command /thimble gives main's Monitor for main's session `session` (monitor_lines), with the corpus `cwd` as the
    launcher names it and as its real path names it, as sandbox_rules does for the skill's command. Any other watcher
    command, such as one for another folder or session, stays in the sandbox, where it cannot read the server's token.
    None without a session id."""
    if not session or not SESSION_ID_RE.fullmatch(session):
        return []
    return [shlex.join([str(root / WATCHER), "--stream", "--cwd", f, "--session", session])
            for f in dict.fromkeys([str(cwd), os.path.realpath(cwd)])]


def sandbox_line(cwd: Path) -> str:
    """What /thimble prints in the sandbox when the hook left no result (module note, the Bash sandbox): with the
    plugin's hooks off, the Monitor route's watcher needs an entry too."""
    from . import cc_settings  # noqa: PLC0415 — the settings' path, needed on this path alone

    settings = cc_settings.config_dir() / "settings.json"
    if cc_plugin.hooks_blocked(cwd, plugin_root()):
        return SANDBOX_NO_HOOKS_LINE.format(rule=sandbox_rule(), watch=watch_rule(), settings=settings)
    return SANDBOX_LINE.format(rule=sandbox_rule(), settings=settings, log=log_path())


def _request(method: str, url: str, body: dict | None = None, timeout: float = 5.0) -> tuple[int, Any]:
    """(status, parsed json | text). Transport failures are (0, message); an HTTP error is (status, its body). The
    request proves the server's token (hook_auth) so its writes pass LocalWriteGuard, which a notebook kernel cannot."""
    from . import hook_auth  # noqa: PLC0415

    data = json.dumps(body).encode() if body is not None else None
    headers = {"Content-Type": "application/json"}
    tok = hook_auth.token()
    if tok:
        headers.update(hook_auth.headers(tok, secrets.token_hex(16)))
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
            status = r.status
    except urllib.error.HTTPError as e:
        raw, status = e.read(), e.code
    except Exception as e:  # noqa: BLE001
        return 0, f"{type(e).__name__}: {e}"
    try:
        return status, json.loads(raw or b"null")
    except ValueError:
        return status, raw.decode("utf-8", "replace")


# ----------------------------------------------------------------------------- lock / start / stop


@contextmanager
def lock(wait_s: float = LOCK_WAIT_S) -> Iterator[None]:
    """`flock <home>/server.lock`, exclusive; waits up to `wait_s` for another up to finish."""
    ensure_home()
    fd = os.open(lock_path(), os.O_RDWR | os.O_CREAT, 0o600)
    try:
        deadline = time.monotonic() + wait_s
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise TimeoutError(f"could not take {lock_path()} within {wait_s:.0f} s")
                time.sleep(0.05)
        yield
    finally:
        try:
            fcntl.flock(fd, fcntl.LOCK_UN)
        finally:
            os.close(fd)


def _detach() -> None:
    signal.signal(signal.SIGHUP, signal.SIG_IGN)


def spawn(cmd: list[str], *, cwd: Path, env: dict[str, str], log_file: Path) -> int:
    """Start `cmd` as its own session leader, stdin from /dev/null, output appended to `log_file`; the pid. Seam for tests."""
    config.private_dir(log_file.parent)
    with log_file.open("ab") as out:
        proc = subprocess.Popen(cmd, cwd=str(cwd), stdin=subprocess.DEVNULL, stdout=out, stderr=subprocess.STDOUT,
                                env=env, start_new_session=True, preexec_fn=_detach, close_fds=True)
    return proc.pid


# The server's event loop: Python's own, which starts a child process with vfork. uvloop forks the whole server for each
# child, which holds the loop for as long as the kernel takes to copy the server's memory map.
SERVER_LOOP = "asyncio"


def backend_cmd(p: int, dev: bool = False) -> list[str]:
    """In dev mode the backend reloads on edits to app/, as Vite does for the frontend; THIMBLE_NO_AUTORESTART turns
    it off."""
    cmd = [sys.executable, "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", str(p),
           "--loop", SERVER_LOOP, "--timeout-graceful-shutdown", "3"]
    return cmd + ["--reload", "--reload-dir", "app"] if dev else cmd


def vite_cmd(ui: int) -> list[str]:
    return ["npx", "vite", "--port", str(ui), "--strictPort", "--host", "127.0.0.1"]


def start(p: int | None = None) -> dict[str, Any]:
    """Spawn the backend (and Vite in dev mode) and write server.json. The caller holds the lock."""
    p = p or port()
    ui = ui_port()
    env = resolve_env()
    environ = _server_environ(env, p, ui)
    if rotate_log(log_path()):
        _log(f"the previous log passed {human_bytes(LOG_ROTATE_BYTES)} and was moved to {log_path().name}.1")
    try:
        offset = log_path().stat().st_size
    except OSError:
        offset = 0
    pid = spawn(backend_cmd(p, autorestart_enabled()), cwd=BACKEND_DIR, env=environ, log_file=log_path())
    LAST_START.clear()
    LAST_START.update(pid=pid, port=p, log_offset=offset)
    _log(f"started uvicorn pid {pid} on {p} (data_dir {env['data_dir']}, workspaces_dir {env['workspaces_dir']})")
    vite_pid = read_state().get("vite_pid") if listening(ui) else None
    if env["dev"] and not listening(ui):
        vite_pid = start_vite(ui, p, environ)
    state = {
        "port": p, "pid": pid, "url": f"http://127.0.0.1:{ui}" if env["dev"] else api_url(p),
        "api": api_url(p), "ui_port": ui, "vite_pid": vite_pid, "dev": env["dev"], "repo": str(config.REPO_ROOT),
        "branch": git_branch(), "started": _now(), "stopped": None,
        "source_fingerprint": source_fingerprint(),
        "env": {k: env[k] for k in STATE_ENV_KEYS}, "token": new_token(),
    }
    write_state(state)
    return state


def start_vite(ui: int, p: int, environ: dict[str, str] | None = None) -> int | None:
    if not (FRONTEND_DIR / "node_modules").is_dir():
        _log(f"not starting Vite: {FRONTEND_DIR / 'node_modules'} is missing")
        return None
    env = dict(environ or _server_environ(resolve_env(), p, ui))
    env["BACKEND_PORT"] = str(p)
    pid = spawn(vite_cmd(ui), cwd=FRONTEND_DIR, env=env, log_file=vite_log_path())
    _log(f"started vite pid {pid} on {ui} (proxy → {p})")
    return pid


def wait_healthy(url: str, wait_s: float, pid: int | None = None) -> bool:
    """Up to `wait_s` for the server at `url` to answer; with `pid` (the uvicorn just spawned) the wait ends as soon as
    that process has exited, since a server that failed at start will not answer later."""
    deadline = time.monotonic() + wait_s
    while True:
        if healthy(url):
            return True
        if time.monotonic() >= deadline:
            return False
        if pid is not None and spawned_exited(pid):
            return healthy(url)
        time.sleep(0.1)


def spawned_exited(pid: int) -> bool:
    """Whether a process `start` spawned has exited. Seam for tests, whose spawned pids are made up."""
    return not procs.alive(pid)


LAST_START: dict[str, Any] = {}  # the last `start` of this process: the pid it spawned, its port, the log's size before


def start_error(since: int) -> str:
    """The last error line uvicorn or Python wrote to the server log after byte `since` (a traceback's last line, or
    uvicorn's `ERROR:` line), or ''."""
    try:
        with log_path().open("rb") as f:
            f.seek(since)
            text = f.read(1_000_000).decode("utf-8", "replace")
    except OSError:
        return ""
    found = ""
    for line in text.splitlines():
        s = line.strip()
        if s.startswith("ERROR:") or re.match(r"^[A-Za-z_][\w.]*(Error|Exception|Exit)\b.*", s):
            found = s
    return found[:300]


def start_failure(url: str) -> str:
    """Why no server answers at `url` after a start: another program on the port, a server of this install that runs
    there but does not answer (STUCK_LINE), the error the server `start` spawned in this process exited with, or that it
    is still starting. '' when none of these is found."""
    p = int(LAST_START.get("port") or port())
    pid = LAST_START.get("pid")
    if listening(p) and not healthy(url):
        holder = procs.listener(p)
        if holder != pid:
            return STUCK_LINE.format(pid=holder) if holder and is_server(holder, p) else port_line(p, False)
    if pid and spawned_exited(pid):
        err = start_error(int(LAST_START.get("log_offset") or 0))
        return f"the server exited while starting{': ' + err if err else ''}"
    if pid:
        return f"the server (pid {pid}) is still starting; this machine may be slow"
    stuck = stuck_server(url)
    return STUCK_LINE.format(pid=stuck) if stuck else ""


def _started_within(st: dict[str, Any], seconds: float) -> bool:
    """Whether server.json's `started` is less than `seconds` ago."""
    try:
        started = datetime.fromisoformat(str(st.get("started") or ""))
    except ValueError:
        return False
    if started.tzinfo is None:
        started = started.replace(tzinfo=timezone.utc)
    return (datetime.now(timezone.utc) - started).total_seconds() < seconds


def stuck_server(url: str | None = None) -> int | None:
    """The pid of a server of this install that runs, holding its port or named by server.json, but does not answer at
    `url`; None when it answers, when none runs, and for the server server.json says started less than STUCK_AFTER_S
    ago, which may still be starting."""
    st = read_state()
    p = int(st.get("port") or port())
    recorded = st.get("pid")
    holder = procs.listener(p) if listening(p) else None
    for pid in dict.fromkeys(q for q in (holder, recorded) if q):
        if pid == recorded and _started_within(st, STUCK_AFTER_S):
            continue
        if is_server(pid, p, st.get("repo")):
            return None if healthy(url or api_url(p)) else int(pid)
    return None


def session_pids(leader: int) -> list[int]:
    """Every live pid whose session id is `leader`, the leader first; empty without /proc."""
    pids: list[int] = []
    if not procs.HAVE_PROC:
        return pids
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            stat = (entry / "stat").read_text()
        except OSError:
            continue
        fields = stat[stat.rfind(")") + 2:].split()
        if len(fields) > 3 and fields[3] == str(leader):
            pids.append(int(entry.name))
    return sorted(pids, key=lambda q: (q != leader, q))


def _signal_all(pids: list[int], sig: int, group: int | None = None) -> None:
    for q in pids:
        try:
            os.kill(q, sig)
        except (ProcessLookupError, PermissionError):
            pass
    if group is not None:
        try:
            os.killpg(group, sig)
        except (ProcessLookupError, PermissionError):
            pass


def _kill(pid: int | None, check, label: str) -> str:
    """SIGTERM then SIGKILL the session `pid` leads, only while `check(pid)` finds it is still the process server.json
    meant. Never a name pattern, never a port."""
    if not pid or not pid_alive(pid):
        return f"{label}: not running"
    reason = check(pid)
    if reason is not None:
        return f"{label}: pid {pid} is not ours ({reason}); left alone. If it is thimble's {label} after all, stop it by hand: kill {pid}"
    try:
        leader = os.getsid(pid) == pid
    except ProcessLookupError:
        return f"{label}: not running"
    victims = (session_pids(pid) or [pid]) if leader else [pid]
    group = pid if leader and not procs.HAVE_PROC else None
    _signal_all(victims, signal.SIGTERM, group)
    deadline = time.monotonic() + STOP_WAIT_S
    while any(pid_alive(q) for q in victims) and time.monotonic() < deadline:
        time.sleep(0.1)
    left = [q for q in victims if pid_alive(q)]
    more = f" ({len(victims)} processes)" if len(victims) > 1 else ""
    if left:
        _signal_all(left, signal.SIGKILL, group)
        return f"{label}: pid {pid} killed{more}"
    return f"{label}: pid {pid} stopped{more}"


KERNELS_DIR = "kernels"  # workspaces/<c>/kernels/ (notebook.KERNELS_DIR)
KERNEL_WAIT_S = 3.0


def _kernel_argv(pid: int) -> list[str]:
    return procs.argv(pid)


def _is_kernel(pid: int | None, conn: str) -> bool:
    if not pid or not pid_alive(pid):
        return False
    argv = _kernel_argv(pid)
    return any("ipykernel_launcher" in a for a in argv) and conn in argv


def kernel_processes(ws_dir: Path) -> list[tuple[int, int | None, str, Path | None]]:
    """(pid, pgid, connection file, record) of every kernel of the workspaces under `ws_dir`: the ones the records
    name, plus any live ipykernel of this user no record claims whose connection file or working directory lies under
    a workspace. A record whose pid is dead or another program's is listed with pid 0."""
    out: list[tuple[int, int | None, str, Path | None]] = []
    seen: set[str] = set()
    for rec_path in sorted(ws_dir.glob(f"*/{KERNELS_DIR}/*.json")):
        if rec_path.name.endswith(".conn.json"):
            continue
        rec = _read_json(rec_path)
        if not isinstance(rec, dict):
            continue
        conn = str(rec.get("connection_file") or "")
        pid, pgid = rec.get("pid"), rec.get("pgid")
        pid = pid if isinstance(pid, int) and pid > 0 else 0
        pgid = pgid if isinstance(pgid, int) and pgid > 0 else None
        seen.add(conn)
        out.append((pid if _is_kernel(pid, conn) else 0, pgid, conn, rec_path))
    prefix = f"{ws_dir}/"
    for pid, argv in procs.commands().items():
        if not any("ipykernel_launcher" in a for a in argv) or "-f" not in argv:
            continue
        i = argv.index("-f") + 1
        conn = argv[i] if i < len(argv) else ""
        if not conn or conn in seen:
            continue
        by_conn = conn.startswith(prefix) and f"/{KERNELS_DIR}/" in conn and conn.endswith(".conn.json")
        if by_conn or _cwd_in_workspace(pid, ws_dir):
            seen.add(conn)
            out.append((pid, None, conn, None))
    return out


def _cwd_in_workspace(pid: int, ws_dir: Path) -> bool:
    wd = procs.cwd(pid)
    if wd is None or not procs.under(wd, ws_dir):
        return False
    try:
        return len(wd.resolve().relative_to(ws_dir.resolve()).parts) >= 1
    except (OSError, ValueError):
        return False


def stop_kernels(ws_dir: Path | None = None) -> str:
    """End every notebook kernel of the workspaces under `ws_dir` and drop their records and connection files."""
    ws_dir = Path(ws_dir if ws_dir is not None else resolve_env()["workspaces_dir"]).expanduser()
    found = kernel_processes(ws_dir) if ws_dir.is_dir() else []
    live = [(pid, pgid, conn) for pid, pgid, conn, _ in found if pid]
    for pid, pgid, _conn in live:
        _signal_group(pid, pgid, signal.SIGTERM)
    deadline = time.monotonic() + KERNEL_WAIT_S
    while any(pid_alive(pid) for pid, _, _ in live) and time.monotonic() < deadline:
        time.sleep(0.1)
    killed = [pid for pid, _, _ in live if pid_alive(pid)]
    for pid, pgid, _conn in live:
        if pid in killed:
            _signal_group(pid, pgid, signal.SIGKILL)
    dropped = 0
    for _pid, _pgid, conn, rec_path in found:
        for f in (rec_path, Path(conn) if conn and procs.under(conn, ws_dir) else None):
            if f is not None and f.is_file():
                try:
                    f.unlink()
                    dropped += 1
                except OSError:
                    pass
    if not live:
        return "kernels: none running" + (f" ({dropped} stale file(s) dropped)" if dropped else "")
    more = f", {len(killed)} killed" if killed else ""
    return f"kernels: {len(live)} stopped{more}"


def _signal_group(pid: int, pgid: int | None, sig: int) -> None:
    try:
        os.killpg(pgid or pid, sig)
    except (ProcessLookupError, PermissionError):
        try:
            os.kill(pid, sig)
        except (ProcessLookupError, PermissionError):
            pass


KERNEL_HANDOFF = "kernels-handoff.json"  # <home>/: the restarting server whose kernels the next one takes back
HANDOFF_S = 120.0  # a hand-off older than this is from a restart that never came back, and names no one


def hand_over_kernels(pid: int) -> bool:
    """Leave word that server `pid` is restarting, so its kernels stay running for the next server to take back
    (notebook.shutdown, notebook.reconnect_all); without it a server stops its kernels when it exits. False when the
    file could not be written."""
    path = home() / KERNEL_HANDOFF
    try:
        ensure_home()
        tmp = path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps({"pid": int(pid), "ts": time.time()}) + "\n", "utf-8")
        tmp.replace(path)
    except OSError as e:
        _log(f"could not write {path}: {e}")
        return False
    return True


def kernel_handoff() -> int | None:
    """The pid of the restarting server the hand-off names (hand_over_kernels); None when there is none or it is stale."""
    d = _read_json(home() / KERNEL_HANDOFF)
    if not isinstance(d, dict) or time.time() - float(d.get("ts") or 0) > HANDOFF_S:
        return None
    pid = d.get("pid")
    return pid if isinstance(pid, int) and pid > 0 else None


def clear_kernel_handoff(pid: int) -> None:
    """Remove the hand-off once the server it names has been taken over."""
    path = home() / KERNEL_HANDOFF
    d = _read_json(path)
    if isinstance(d, dict) and d.get("pid") == pid:
        try:
            path.unlink()
        except OSError:
            pass


def stop(*, vite: bool = True, kernels: bool = True) -> list[str]:
    """Stop the kernels, the backend recorded in server.json (by pid), Vite unless `vite=False`, then the kernels once
    more. With `kernels=False` (a restart) they stay for the next server to reconnect: the hand-off tells the server so
    before it gets its SIGTERM (hand_over_kernels)."""
    st = read_state()
    p = int(st.get("port") or port())
    lines = [stop_kernels()] if kernels else []
    recorded = is_server(st.get("pid"), p, st.get("repo"))
    if not kernels and st.get("pid") and pid_alive(st.get("pid")):
        hand_over_kernels(int(st["pid"]))
    lines.append(_kill(st.get("pid"), server_check(p, st.get("repo")), "server"))
    if not recorded:  # a stale record (module note): the server answering on the port, when it is this checkout's
        leader = health_leader(api_url(p))
        if leader and leader != st.get("pid") and is_server(leader, p, st.get("repo")):
            lines.append(_kill(leader, server_check(p, st.get("repo")), "server"))
    if vite and st.get("vite_pid"):  # a release install, and a checkout that serves the build, run no Vite
        lines.append(_kill(st.get("vite_pid"), argv_check("vite"), "vite"))
    if kernels:
        again = stop_kernels()
        if not again.startswith("kernels: none running"):
            lines.append(again)
    if listening(p) and not pid_alive(st.get("pid")):
        lines.append(f"port {p} is still in use by a process thimble did not start; not touching it")
    if st:
        st.update({"pid": None, "stopped": _now()})
        if vite:
            st["vite_pid"] = None
        write_state(st)
    for ln in lines:
        _log(ln)
    return lines


def stop_self() -> None:
    """The server stops itself, since no workspace has a main session (session._stop_server): when server.json names
    this server, Vite (dev mode) is stopped and the record marked stopped, so an `up` meanwhile starts a new server; then
    SIGTERM goes to the uvicorn `start` spawned, the `--reload` supervisor in dev mode, which ends its worker, else to
    this process. uvicorn then runs the lifespan's shutdown."""
    me, leader = os.getpid(), os.getsid(0)
    st = read_state()
    p = int(st.get("port") or port())
    target = leader if leader != me and is_server(leader, p, st.get("repo")) else me
    if st.get("pid") in (me, target):
        if st.get("vite_pid"):
            _log(_kill(st.get("vite_pid"), argv_check("vite"), "vite"))
        st.update({"pid": None, "vite_pid": None, "stopped": _now()})
        write_state(st)
    _log(f"no workspace has a main session: the server (pid {target}) stops")
    os.kill(target, signal.SIGTERM)


def starting(url: str) -> bool:
    """A server this module spawned is alive but not yet answering."""
    st = read_state()
    pid = st.get("pid")
    p = str(st.get("port") or port())
    if not pid_alive(pid) or url != api_url(int(p)):
        return False
    return server_argv_matches(procs.argv(int(pid)), int(p))


def ensure_running(wait_s: float) -> bool:
    """Health, then under the lock start if still unhealthy and wait. Restarts Vite in dev mode when only it is down,
    and a healthy server whose source changed since it started (auto_restart)."""
    url = api_url()
    if healthy(url):
        with lock():
            reconcile()
        verdict = auto_restart(url, wait_s)
        if verdict is not None:
            return verdict
        env = resolve_env()
        if env["dev"] and owned() and not listening(ui_port()):
            with lock():
                if not listening(ui_port()):
                    st = read_state()
                    st["vite_pid"] = start_vite(ui_port(), port())
                    st["url"] = f"http://127.0.0.1:{ui_port()}"
                    write_state(st)
        return True
    with lock():
        reconcile()
        spawned = None
        if not healthy(url) and not starting(url):
            spawned = start().get("pid")
        up = wait_healthy(url, wait_s, spawned)
        reconcile()  # a uvicorn that could not bind the port leaves no dead pid; the server answering is adopted
        return up


# ----------------------------------------------------------------------------- source fingerprint, auto-restart


def source_files(root: Path | None = None) -> list[Path]:
    root = Path(root or config.REPO_ROOT)
    found: set[Path] = set()
    for pattern in FINGERPRINT_GLOBS:
        found.update(p for p in root.glob(pattern) if p.is_file())
    return sorted(found)


def source_fingerprint(root: Path | None = None) -> str:
    """sha256 over (relative path, mtime_ns, size) of `source_files`; contents are not read."""
    root = Path(root or config.REPO_ROOT)
    h = hashlib.sha256()
    for p in source_files(root):
        try:
            st = p.stat()
        except OSError:
            continue
        h.update(f"{p.relative_to(root).as_posix()}\0{st.st_mtime_ns}\0{st.st_size}\n".encode())
    return h.hexdigest()


def source_changed(state: dict[str, Any] | None = None) -> bool | None:
    """Whether the tree differs from what the running server recorded at its start; None when nothing comparable is recorded."""
    st = read_state() if state is None else state
    recorded = st.get("source_fingerprint")
    if not recorded or str(st.get("repo") or config.REPO_ROOT) != str(config.REPO_ROOT):
        return None
    return recorded != source_fingerprint()


def record_source_fingerprint(pid: int | None = None) -> bool:
    """Called by the server at start-up: when server.json is about this process, refresh its fingerprint."""
    st = read_state()
    if not st or st.get("pid") != (pid or os.getpid()):
        return False
    fp = source_fingerprint()
    if st.get("source_fingerprint") == fp:
        return False
    st["source_fingerprint"] = fp
    write_state(st)
    return True


def autorestart_off() -> str | None:
    """Why the source-change auto-restart is off: not in dev mode (THIMBLE_DEV; a release install's server never
    restarts itself under the analyst), or NO_AUTORESTART_ENV set. None when on."""
    if (os.environ.get(NO_AUTORESTART_ENV) or "").strip().lower() not in ("", "0", "false", "no", "off"):
        return NO_AUTORESTART_ENV
    if not resolve_env()["dev"]:
        return "THIMBLE_DEV off"
    return None


def autorestart_enabled() -> bool:
    return autorestart_off() is None


def owned(st: dict[str, Any] | None = None) -> bool:
    """Whether the server on the port is one this module started: server.json's pid is a thimble server on its port
    (is_server). A healthy server beside a stale record is somebody else's and is left alone (no restart, no Vite, no
    announcement)."""
    st = st if st is not None else read_state()
    return is_server(st.get("pid"), int(st.get("port") or port()), st.get("repo"))


def _workspace_names(workspaces_dir: Path) -> list[str]:
    try:
        return sorted(d.name for d in workspaces_dir.iterdir() if d.is_dir() and not d.name.startswith("."))
    except OSError:
        return []


def busy_reason(url: str) -> str | None:
    """Why the server must not be restarted now: an orientation, job, ticket, report generation, or any other session or view
    build its stop would end (running_work). None when idle; a server that does not answer is a reason."""
    names = _workspace_names(Path(resolve_env()["workspaces_dir"]))
    running = [c for c in names if orient_status(c) == "running"]
    if running:
        return f"an orientation is running in {', '.join(running)}"
    status, body = _request("GET", f"{url}/api/jobs", timeout=3.0)
    if status == 200 and isinstance(body, dict):
        n_run, n_q = int(body.get("running") or 0), int(body.get("depth") or 0)
        if n_run or n_q:
            return f"{n_run} job{'s' if n_run != 1 else ''} running and {n_q} queued"
    elif status != 404:
        return f"/api/jobs did not answer ({status or str(body)[:80]})"
    status, body = _request("GET", f"{url}/api/dev/status", timeout=3.0)
    if status == 200 and isinstance(body, dict) and body.get("running"):
        cur = body.get("current") if isinstance(body.get("current"), dict) else {}
        return f"a dev ticket is running ({cur.get('title') or 'untitled'})"
    for c in names:
        status, body = _request("GET", f"{url}/api/ws/{c}/investigations/{MAIN}/types", timeout=3.0)
        if status == 200 and isinstance(body, dict):
            gen = [slug for slug, e in body.items() if isinstance(e, dict) and e.get("status") == "generating"]
            if gen:
                return f"a report is generating in {c} ({', '.join(gen)})"
    for ln in running_work(url)[:1]:
        return f"it runs {ln}"
    return None


def _restart_under_way(st: dict[str, Any]) -> dict[str, Any] | None:
    mark = st.get("source_restart")
    if isinstance(mark, dict) and time.time() - float(mark.get("requested") or 0) < RESTART_MARK_S:
        return mark
    return None


def _leave_restart_reason(title: str) -> None:
    """<home>/restart.json for the new server's announcement (dev.announce_restart), unless one is there already."""
    rf = home() / "restart.json"
    if rf.is_file():
        return
    try:
        ensure_home()
        rf.write_text(json.dumps({"title": title, "ts": _now()}) + "\n", "utf-8")
    except OSError as e:
        _log(f"could not write {rf}: {e}")


def spawn_restart() -> int:
    """`thimble restart --keep-vite --yes` as a detached session leader, so the restart outlives the caller; busy_reason
    has found the server idle, so it asks nothing. Seam for tests."""
    env = config.passed_environ()
    env.update({"THIMBLE_HOME": str(home()), "THIMBLE_PORT": str(port())})
    return spawn([sys.executable, "-m", "app.cli", "restart", "--keep-vite", "--yes"], cwd=BACKEND_DIR, env=env,
                 log_file=log_path())


def running_work(url: str) -> list[str]:
    """What a restart of the server at `url` would interrupt, one line each: the sessions it runs and the views it builds
    (`GET /api/sessions/running`), then the dev ticket it runs. Empty when nothing runs."""
    lines: list[str] = []
    status, body = _request("GET", f"{url}/api/sessions/running", timeout=5.0)
    if status == 200 and isinstance(body, list):
        for item in body:
            if not isinstance(item, dict):
                continue
            kind = str(item.get("kind") or "")
            what = RUNNING_KINDS.get(kind, kind or "a session")
            if kind == "orient":
                what += f" (follow-up {item['run']})" if int(item.get("run") or 0) > 0 else ""
            elif item.get("title"):
                what += f" \"{item['title']}\""
            lines.append(f"{item.get('workspace')}: {what}{'' if item.get('resumes') else RUNNING_ENDS}")
    else:
        names = _workspace_names(Path(resolve_env()["workspaces_dir"]))
        lines.extend(f"{c}: {RUNNING_KINDS['orient']}" for c in names if orient_status(c) == "running")
    status, body = _request("GET", f"{url}/api/dev/status", timeout=3.0)
    if status == 200 and isinstance(body, dict) and body.get("running"):
        cur = body.get("current") if isinstance(body.get("current"), dict) else {}
        where = f"{cur['workspace']}: " if cur.get("workspace") else ""
        lines.append(f"{where}the dev ticket \"{cur.get('title') or 'untitled'}\"")
    return lines


def confirm(question: str) -> bool | None:
    """The answer to a yes-or-no `question` asked on the terminal: True for y or yes, False for anything else; None when
    stdin is no terminal, so nobody can answer. Seam for tests."""
    if not sys.stdin.isatty():
        return None
    try:
        return input(question).strip().lower() in ("y", "yes")
    except EOFError:
        return False


def wait_restarted(old_pid: int | None, url: str, wait_s: float) -> bool:
    deadline = time.monotonic() + wait_s
    while True:
        pid = read_state().get("pid")
        if pid and pid != old_pid and healthy(url):
            return True
        if time.monotonic() >= deadline:
            return False
        time.sleep(0.1)


def auto_restart(url: str, wait_s: float) -> bool | None:
    """The healthy server's source check. None: nothing to do (unchanged, not comparable, disabled, or busy with a
    NOTICES line saying why). True/False: a restart ran and the new server did or did not answer within `wait_s`."""
    if not autorestart_enabled():
        return None
    with lock():
        st = read_state()
        mark = _restart_under_way(st)
        if mark is None:
            if not owned(st):
                _log(f"server.json names no thimble server of this checkout; the server on {url} is not ours, so it is left alone")
                return None
            if source_changed(st) is not True:
                return None
            reason = busy_reason(url)
            if reason:
                _log(f"source changed since pid {st.get('pid')} started; not restarting: {reason}")
                NOTICES.append(NOT_RESTARTED_LINE.format(reason=reason))
                return None
            _leave_restart_reason(SOURCE_CHANGED)
            mark = {"requested": time.time(), "old_pid": st.get("pid"), "by": os.getpid()}
            st["source_restart"] = mark
            write_state(st)
            child = spawn_restart()
            _log(f"source changed since pid {st.get('pid')} started; restart spawned (pid {child})")
    up = wait_restarted(mark.get("old_pid"), url, wait_s)
    if up:
        NOTICES.append(RESTARTED_LINE)
    else:
        _log(f"the restarted server has not answered within {wait_s:.0f} s")
    return up


# ----------------------------------------------------------------------------- workspace mapping


def known_corpus(cwd: Path, data_dir: Path) -> tuple[str, Path] | None:
    """(name, the folder that claimed it) of the corpus `cwd` is in: DATA_DIR/<c> that is cwd or an ancestor, else a
    registered folder's root or working directory, the most specific claim first (config.sidecar_match). None when neither."""
    for p in (cwd, *cwd.parents):
        if p.parent == data_dir and (p / "manifest.json").is_file():
            return p.name, p
    try:
        sidecars = sorted(data_dir.glob("*.corpus.json"))
    except OSError:
        sidecars = []
    recs: list[dict] = []
    for sc in sidecars:
        try:
            rec = json.loads(sc.read_text("utf-8"))
        except (OSError, ValueError):
            continue
        if isinstance(rec, dict) and isinstance(rec.get("path"), str) and rec["path"]:
            recs.append({**rec, "name": str(rec.get("name") or sc.name[: -len(".corpus.json")])})
    found = config.sidecar_match(cwd, recs)
    return (str(found[0]["name"]), found[1]) if found else None


def workspace_for(cwd: Path, data_dir: Path, url: str | None, *, here: bool = False) -> str | None:
    """The corpus for `cwd`: the folder it is in (known_corpus), else registered through `POST /api/corpora/register`
    when `url` is given. `here` (a session's /thimble) opens the folder itself: under a registered ancestor it is
    registered as its own corpus instead of mapping up. None when nothing matched and nothing was registered."""
    return open_workspace(cwd, data_dir, url, here=here)[0]


def caller_alias(cwd: Path) -> tuple[bool, str | None]:
    """How the analyst named the folder `cwd`: (whether thimble can tell, the path they used when it is another path to
    the folder, through a symlink). plugin/bin/thimble passes the caller's logical working directory ($PWD, which keeps
    the symlink a shell went through) as THIMBLE_CALLER_CWD; when that is not the folder (main's shell moved on), thimble
    cannot tell."""
    raw = os.environ.get("THIMBLE_CALLER_CWD") or ""
    if not os.path.isabs(raw):
        return False, None
    try:
        same = Path(raw).resolve() == cwd.resolve()
    except OSError:
        return False, None
    return (True, config.shown_alias(raw, cwd.resolve())) if same else (False, None)


def _sidecar_shown(data_dir: Path, name: str) -> str | None:
    rec = config.read_sidecar(name, data_dir)
    return rec.get("shown") if rec else None


def open_workspace(cwd: Path, data_dir: Path, url: str | None, *, here: bool = False) -> tuple[str | None, bool]:
    """workspace_for with whether the folder was opened anew: (name, registered just now). A registered folder the
    analyst opened through a symlink, or no longer through one, is registered again so that the dashboard shows the path
    they used (caller_alias)."""
    told, alias = caller_alias(cwd)
    cwd = cwd.resolve()
    data_dir = data_dir.resolve()
    known = known_corpus(cwd, data_dir)
    if known is not None and (known[1] == cwd or not here or known[1].parent == data_dir):
        stale = told and known[1] == cwd and known[1].parent != data_dir and _sidecar_shown(data_dir, known[0]) != alias
        if not (stale and url):
            return known[0], False
    if not url:
        return (known[0] if known else None), False
    body: dict[str, Any] = {"path": str(cwd)}
    if here:
        body["exact"] = True
    if told:
        body["shown"] = alias
    status, resp = _request("POST", f"{url}/api/corpora/register", body)
    if status in (200, 201) and isinstance(resp, dict) and resp.get("name"):
        return str(resp["name"]), known is None or known[0] != str(resp["name"])
    _log(f"register {cwd} → {status} {str(resp)[:200]}")
    return None, False


def ui_url(name: str | None, key: bool = True) -> str:
    """The UI port in dev mode (its own Vite), else the API port where the built UI is served, with `key` the key that
    lets the page answer permission requests and change permission modes (hook_auth.claim)."""
    st = read_state()
    base = str(st.get("url") or api_url())
    k = f"#k={st['ui_key']}" if key and st.get("ui_key") else ""
    return f"{base}/?ws={name}{k}" if name else f"{base}/{k}"


def leave_link(session: str, url: str, notes: "list[str] | tuple[str, ...]" = ()) -> bool:
    """`url` for the session's Stop hook to show under main's reply (LINK_LINE), with `notes` on the lines after it;
    False when it could not be left."""
    name = "".join(ch for ch in session if ch.isalnum() or ch in "-_")
    try:
        d = ensure_home() / LINKS_DIR
        d.mkdir(exist_ok=True)
        (d / name).write_text("\n".join([url, *notes]), "utf-8")
    except OSError as e:
        _log(f"the link for session {session} was not left: {e}")
        return False
    return bool(name)


def to_terminal() -> bool:
    """Whether stdout is a terminal, the analyst's; a command's output read by a program can reach a model's context."""
    return sys.stdout.isatty()


HELD_KEYS = ("cards", "labels", "documents", "chats")  # what `GET /api/tools/holdings` counts (tools.holdings)


def resumes(url: str, name: str | None) -> bool:
    """Whether the workspace holds anything from an earlier run, from `GET /api/tools/holdings`, so /thimble prints
    RESUME_LINE. False when there is no workspace or the server does not answer."""
    if not name:
        return False
    try:
        status, body = _request("GET", f"{url}/api/tools/holdings?" + urllib.parse.urlencode({"workspace": name}), timeout=3.0)
    except Exception as e:  # noqa: BLE001 — never a traceback in the skill text
        _log(f"holdings of {name}: {type(e).__name__}: {e}")
        return False
    if status != 200 or not isinstance(body, dict):
        return False
    return any(body.get(k) for k in HELD_KEYS)


def precached_context(url: str, name: str, session: str) -> str:
    """What a session new to a workspace installed from a pre-cache starts from (`POST /api/ws/{c}/precached/context`,
    precached.take_context): the orientation's cards, views and documents; '' for any other workspace or session, or
    when the server does not answer. A failure is logged, never raised."""
    try:
        status, body = _request("POST", f"{url}/api/ws/{urllib.parse.quote(name)}/precached/context",
                                {"session": session}, timeout=30.0)
    except Exception as e:  # noqa: BLE001 — never a traceback in the skill text
        _log(f"pre-cached context of {name}: {type(e).__name__}: {e}")
        return ""
    if status != 200 or not isinstance(body, dict):
        if status not in (0, 404):
            _log(f"pre-cached context of {name}: {status} {str(body)[:200]}")
        return ""
    return str(body.get("text") or "")


def archive_workspace(url: str, name: str) -> tuple[bool, str | None]:
    """`POST /api/ws/{c}/archive` (ledger.archive_workspace): (whether it answered, the folder the workspace went to,
    None when it had none). A failure is logged, never raised."""
    try:
        status, body = _request("POST", f"{url}/api/ws/{urllib.parse.quote(name)}/archive", {}, timeout=ARCHIVE_TIMEOUT_S)
    except Exception as e:  # noqa: BLE001 — never a traceback in the skill text
        _log(f"archive of {name}: {type(e).__name__}: {e}")
        return False, None
    if status != 200 or not isinstance(body, dict):
        _log(f"archive of {name}: {status} {str(body)[:200]}")
        return False, None
    return True, (str(body["archived"]) if body.get("archived") else None)


def restore_workspace(url: str, name: str, archive: str) -> tuple[int, dict[str, Any]]:
    """`POST /api/ws/{c}/restore {archive}` (ledger.restore_workspace): (status, body); 0 when it did not answer. A
    failure is logged, never raised."""
    try:
        status, body = _request("POST", f"{url}/api/ws/{urllib.parse.quote(name)}/restore", {"archive": archive},
                                timeout=ARCHIVE_TIMEOUT_S)
    except Exception as e:  # noqa: BLE001 — never a traceback in the skill text
        _log(f"restore of {archive} into {name}: {type(e).__name__}: {e}")
        return 0, {}
    if status != 200:
        _log(f"restore of {archive} into {name}: {status} {str(body)[:200]}")
    return status, body if isinstance(body, dict) else {}


def list_archives(url: str, name: str) -> list[str] | None:
    """The names of the workspace's archives, newest first (`GET /api/ws/{c}/archives`); None when the server did not
    answer."""
    try:
        status, body = _request("GET", f"{url}/api/ws/{urllib.parse.quote(name)}/archives", timeout=5.0)
    except Exception as e:  # noqa: BLE001 — never a traceback in the skill text
        _log(f"archives of {name}: {type(e).__name__}: {e}")
        return None
    if status != 200 or not isinstance(body, dict) or not isinstance(body.get("archives"), list):
        _log(f"archives of {name}: {status} {str(body)[:200]}")
        return None
    return [str(a) for a in body["archives"]]


def resume_lines(url: str, name: str | None, archive: str) -> list[str]:
    """The line under the URL for `/thimble restore <archive>`."""
    if not name:
        return [NO_SUCH_ARCHIVE_LINE.format(name=archive)]
    status, body = restore_workspace(url, name, archive)
    if status == 404:
        return [NO_SUCH_ARCHIVE_LINE.format(name=archive)]
    if status != 200:
        return [RESTORE_FAILED_LINE.format(name=archive, log=log_path())]
    replaced = body.get("archived")
    if not replaced:
        return [RESTORED_LINE.format(name=archive)]
    return [RESTORED_REPLACED_LINE.format(name=archive, path=replaced, replaced=Path(str(replaced)).name)]


def monitor_lines(cwd: Path, session: str) -> list[str]:
    """What /thimble prints after the URL where the plugin's hooks are off (cc_plugin.route): the warning, and the
    command main's Monitor runs after MONITOR_MARK; none where the hooks deliver."""
    if cc_plugin.route(cwd, plugin_root()) != cc_plugin.MONITOR:
        return []
    watcher = shlex.join([str(plugin_root() / WATCHER), "--stream", "--cwd", str(cwd), "--session", session])
    fenced = os.environ.get(cc_plugin.FENCE_MARK, "").strip() == "1"
    return [MONITOR_NOTE_FENCED if fenced else MONITOR_NOTE, f"{MONITOR_MARK} {watcher}"]


def launched() -> bool:
    """Whether the `thimble` launcher started this session, and so appended main's prompt to its system prompt: it
    exports LAUNCHED_ENV."""
    return bool(os.environ.get(LAUNCHED_ENV))


def fenced_here(cwd: Path) -> bool:
    """Whether the `claude` process this command runs under (cc_plugin.claude_pid) runs inside thimble's fence, read
    from its command line (cc_plugin.fenced_argv); False when there is none."""
    pid = cc_plugin.claude_pid()
    return bool(pid) and cc_plugin.fenced_argv(procs.argv(pid), procs.cwd(pid) or cwd)


def plugin_root() -> Path:
    """The plugin copy whose bin/thimble ran this command (PLUGIN_ROOT_ENV), else this tree's plugin/."""
    return Path(os.environ.get(PLUGIN_ROOT_ENV) or PLUGIN_DIR).resolve()


PLUGIN_LIST_TIMEOUT_S = 10.0
COPY_IGNORED = ("__pycache__", ".DS_Store")  # what running or browsing a plugin copy adds to it


def _plugin_files(root: Path) -> dict[str, tuple[bytes, bool]]:
    """Each file under `root` but COPY_IGNORED: its path relative to `root` → (its bytes, whether it is executable)."""
    out: dict[str, tuple[bytes, bool]] = {}
    for p in root.rglob("*"):
        rel = p.relative_to(root)
        if p.is_file() and not any(part in COPY_IGNORED for part in rel.parts) and p.suffix != ".pyc":
            out[rel.as_posix()] = (p.read_bytes(), os.access(p, os.X_OK))
    return out


class Installed(NamedTuple):
    """The installed plugin copy main loads (installed_copy): the folder Claude Code runs it from and the marketplace
    it is installed from."""

    root: Path
    marketplace: str


def _claude_json(claude: str, args: list[str], cwd: Path) -> list[Any]:
    """The list a `claude ... --json` listing prints, [] when it fails or prints something else."""
    r = subprocess.run([claude, *args, "--json"], cwd=cwd, capture_output=True, text=True,
                       timeout=PLUGIN_LIST_TIMEOUT_S, stdin=subprocess.DEVNULL, check=False, env=config.launch_environ())
    out = json.loads(r.stdout) if r.returncode == 0 and r.stdout.strip() else []
    return out if isinstance(out, list) else []


def installed_copy(cwd: Path) -> Installed | None:
    """The copy of this tree's plugin that Claude Code has installed and enables for `cwd` (`claude plugin list --json`),
    which every session loads already, so the launcher adds no copy of plugin/ with --plugin-dir. When the marketplace is
    a directory source at this tree, plugin/ itself is the copy; otherwise the cache copy counts when it matches plugin/
    and finds this tree. None when there is no such copy, it is disabled, or anything fails."""
    try:
        name = config.marketplace_name()
        claude = shutil.which("claude")
        if not name or not claude:
            return None
        listed = _claude_json(claude, ["plugin", "list"], cwd)
        if not any(isinstance(p, dict) and p.get("id") == f"{PLUGIN_NAME}@{name}" and p.get("enabled") is True
                   for p in listed):
            return None
        for m in _claude_json(claude, ["plugin", "marketplace", "list"], cwd):
            if isinstance(m, dict) and m.get("name") == name and m.get("source") == "directory":
                source = Path(str(m.get("path") or ""))
                if source.is_absolute() and source.resolve() == config.REPO_ROOT.resolve():
                    return Installed(PLUGIN_DIR.resolve(), name)
        for p in listed:
            if not (isinstance(p, dict) and p.get("id") == f"{PLUGIN_NAME}@{name}" and p.get("enabled") is True):
                continue
            root = Path(str(p.get("installPath") or ""))
            if not (root.is_absolute() and root.is_dir()) or cc_plugin.marketplace(root) != name:
                continue
            found = subprocess.run([str(root / "bin" / "thimble-app-dir")], capture_output=True, text=True,
                                   timeout=PLUGIN_LIST_TIMEOUT_S, stdin=subprocess.DEVNULL, check=False)
            if found.returncode != 0 or Path(found.stdout.strip()).resolve() != config.REPO_ROOT.resolve():
                continue
            if _plugin_files(root) == _plugin_files(PLUGIN_DIR):
                return Installed(root.resolve(), name)
    except (OSError, ValueError, subprocess.SubprocessError):
        return None
    return None


def name_session(url: str, name: str, session: str, cwd: Path) -> str | None:
    """Tell the server which Claude Code session asked (`POST /api/ws/{c}/session`). Returns the session this one took main
    over from while it still runs in another terminal, else None."""
    try:
        status, body = _request("POST", f"{url}/api/ws/{urllib.parse.quote(name)}/session",
                                {"session": session, "cwd": str(cwd)}, timeout=3.0)
        if status != 200:
            _log(f"session {session} for {name}: {status} {str(body)[:200]}")
            return None
        replaced = body.get("replaced") if isinstance(body, dict) else None
        return str(replaced) if replaced else None
    except Exception as e:  # noqa: BLE001 — never a traceback in the skill text
        _log(f"session {session} for {name}: {type(e).__name__}: {e}")
        return None


def agent_definition(name: str) -> tuple[str, dict[str, Any]]:
    """(its name, the definition `--agents` takes) for an agent file among prompts.AGENT_FILES: its description, AGENT_FIELDS,
    its body as prompt, its tools when it names any (with none it has every tool of the session), and its skills
    prefixed with the plugin's name."""
    from . import prompts  # noqa: PLC0415

    front, body = prompts.agent_file(name)
    raw = front.get("tools") or []
    names = [x.strip() for x in (raw.split(",") if isinstance(raw, str) else raw) if str(x).strip()]
    agent: dict[str, Any] = {"description": str(front.get("description") or ""), "prompt": body}
    if names:
        agent["tools"] = names
    for key in AGENT_FIELDS:
        if key in front:
            agent[key] = front[key]
    if front.get("skills"):
        agent["skills"] = [x if ":" in str(x) else f"{PLUGIN_NAME}:{x}" for x in front["skills"]]
    return str(front.get("name") or name), agent


def skill_rules(root: Path | None = None) -> list[str]:
    """The allow rules for the plugin's own skills, one per folder of the plugin copy's skills/ by exact name
    (`Skill(thimble:shared)`). Without the rule Claude Code asks before loading the skill, so a background subagent would
    stop at a prompt nobody sees; a prefix rule `Skill(thimble:*)` would also match other plugins' skills starting with
    "thimble"."""
    skills = (root or plugin_root()) / "skills"
    return [f"Skill({PLUGIN_NAME}:{d.name})" for d in sorted(skills.iterdir()) if (d / "SKILL.md").is_file()]


def last_main(cwd: Path) -> str:
    """The session `thimble --continue` resumes in `cwd`: of the sessions the workspace recorded as main, the one whose
    transcript was written last, when it is under the new session's config dir and not live in another `claude` process.
    '' when there is none."""
    env = resolve_env()
    name = workspace_for(cwd, Path(env["data_dir"]), None)
    if not name:
        return ""
    recs = _read_json(Path(env["workspaces_dir"]) / name / "sessions.json")
    projects = Path(os.environ.get("CLAUDE_CONFIG_DIR") or (Path.home() / ".claude")).expanduser() / "projects"
    here = cwd.expanduser().resolve()
    best: tuple[float, str] | None = None
    for sid, rec in (recs.items() if isinstance(recs, dict) else ()):
        if not isinstance(rec, dict) or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", str(sid)):
            continue
        if not rec.get("transcript_path") or (rec.get("cwd") and Path(str(rec["cwd"])).resolve() != here):
            continue
        t = Path(str(rec["transcript_path"]))
        try:
            if not t.is_file() or not procs.under(t, projects):
                continue
            written = t.stat().st_mtime
        except OSError:
            continue
        pid = rec.get("pid")
        if not rec.get("ended") and pid_alive(pid) and "claude" in _cmdline(int(pid)):
            continue  # the session runs in another terminal: two processes would write one transcript
        if best is None or written > best[0]:
            best = (written, str(sid))
    return best[1] if best else ""


def main_choice(cwd: Path) -> dict[str, Any]:
    """The composer's effort and fast-mode choice for main in the folder's workspace (events.effort_route), kept in the
    workspace's settings.json as models.main; {} for none."""
    c = config.workspace_for_cwd(str(cwd))
    try:
        stored = json.loads((config.workspace_path(c) / "settings.json").read_text("utf-8")) if c else {}
        main = stored.get(config.MODELS_KEY, {}).get("main")
    except (OSError, ValueError, AttributeError):
        return {}
    return main if isinstance(main, dict) else {}


def launch_settings(cwd: Path, given: str = "", fence: dict[str, Any] | None = None,
                    env: Mapping[str, str] | None = None) -> str:
    """The one `--settings` value the launcher passes main, since Claude Code reads only the last one: the analyst's own
    `given` (inline JSON, or a file relative to `cwd`) with thimble's statusline, chained to theirs (from `given`, else
    their own settings, cc_settings.own_statusline) at their refresh interval, and the composer's fast mode and
    ultracode where they name none, and thimble's `fence` joined in (main_fence, with_fence). Its `env` holds UNSET_VARS
    each as '', fenced or not: Claude Code reads an empty value as unset, and --settings rank above the analyst's own
    settings files, so an `env` block there that sets one cannot override the agents' efforts and models either, as the
    launcher's unset line keeps their shell's from it (BLANKED_LINE). `env` joins its `env` too: terminal mode's
    terminal_env. `given` as it is when it cannot be read."""
    from . import cc_settings, tray  # noqa: PLC0415

    own: Any = {}
    if given:
        try:
            own = json.loads(given if given.lstrip().startswith("{") else (cwd / Path(given).expanduser()).read_text("utf-8"))
        except (OSError, ValueError):
            own = None
        if not isinstance(own, dict):
            print(f"thimble: WARNING - --settings {given} could not be read, so thimble's statusline and sandbox are "
                  "left out", file=sys.stderr)
            return given.replace("\n", " ")
    line = own.get("statusLine")
    theirs = line if isinstance(line, dict) and isinstance(line.get("command"), str) else cc_settings.own_statusline()
    out = {**own, "statusLine": {"type": "command", "command": tray.statusline_command(theirs.get("command") or ""),
                                 "refreshInterval": theirs.get("refreshInterval", cc_settings.STATUSLINE_REFRESH_S)}}
    choice = main_choice(cwd)
    if isinstance(choice.get("fast"), bool):
        out.setdefault("fastMode", choice["fast"])
    if choice.get("effort") == cc_settings.ULTRACODE:
        out.setdefault("ultracode", True)
    out["env"] = {**(out.get("env") if isinstance(out.get("env"), dict) else {}), **{name: "" for name in UNSET_VARS},
                  **(env or {})}
    return json.dumps(with_fence(out, fence or {}))


def workspace_name(cwd: Path) -> str:
    """The workspace /thimble opens `cwd` as (open_workspace with `here`), told before anything is registered: the
    corpus that claims `cwd` itself or holds it under the data folder, else the name registering `cwd` gives it
    (config.register_corpus: its basename, config.corpus_name_for, or the next free `-2`, `-3` …, config.free_name)."""
    data_dir = Path(resolve_env()["data_dir"]).resolve()
    here = cwd.expanduser().resolve()
    known = known_corpus(here, data_dir)
    if known is not None and (known[1] == here or known[1].parent == data_dir):
        return known[0]
    return config.free_name(config.corpus_name_for(here), data_dir)


def main_name(cwd: Path) -> str:
    """The name main's session goes by in Claude Code (`claude -n`, config.session_name): `thimble:main · <workspace>`,
    the workspace being workspace_name's."""
    return config.session_name("main", workspace_name(cwd))


# --------------------------------------------------------------------------- main's fence
#
# The launcher starts main inside thimble's fence (main_fence), through main's --settings, and every subagent main
# starts, thimble's agents among them, inherits it, so one fence holds main and its agents: Claude Code's Bash sandbox
# on with no command outside it, writes only in the agents' work folders (write_dirs) and Claude Code's own temp folder,
# the corpus and the workspace's config not writable, thimble's token files and the links folder unreadable, the
# network as the orientation's `network` says, and the permission rules of userconf.main_rules: an edit of the corpus or
# of thimble's config asks, the web tools as `web` says, thimble's records not edited. Installs follow Claude Code's
# permission mode. The fence's `env` carries cc_plugin.FENCE_MARK, which the server reads from main's command line
# (cc_plugin.main_fenced). Every sandbox path is a folder or a file, at most with a trailing `/**`: on Linux Claude Code
# drops any other glob without a warning (spike U19). Without the sandbox (thimble's config's `sandbox.use` "never", or
# a machine where it cannot run) main starts without the fence, and the launch says so (NO_FENCE_LINES).
#
# The launch also writes launch.json in the workspace (LAUNCH_FILE, launch_record): main's session id, whether main is
# fenced, the switches the launcher exports, the variables it unsets, and the launcher's own pid, which the launcher
# replaces with main's `claude` process as it starts it (the mode line names the file). The hooks module's bridge accepts a hello only from that session
# (module_bridge), reading from that pid's command line whether main is fenced, and `doctor` reads it. It also records
# the mode the folder starts in (launch_mode.resolve), which every other process of the session reads from there
# (launch_mode.session_mode).
#
# Terminal mode: the same session, the same fence and main's same prompt, with no server and no first prompt. The
# launcher adds the renderer plugin (TERMINAL_RENDERER), which draws thimble's work in the terminal, and the
# `--allowedTools` rule for the card runner (CARD_RUNNER), which runs a card's code in main's Bash; the fence lets main's
# Bash write the card folders (card_dirs); main's --settings `env` and the launcher's exports carry terminal_env; and
# launch-args writes the hooks module's roles file (write_roles), since no server hands it the roles.

# the folders main's Bash may write, under the workspace (subagents.write_dirs, which this list stands in for until the
# subagent paths are in): the orientation's work folder, the writers', the critics', the checks', the view builders' and
# the workspace's own views. The code tickets' worktrees are outside the workspace (ticket_trees).
WRITE_DIRS = ("orient/work", "writers", "critique-work", "check-work", "views-work", "extension/views")
LAUNCH_FILE = "trusted/launch.json"  # in the workspace (subagent_files): {session, at, fenced, switches, unset, pid, modules_off, mode}
TERMINAL_RENDERER = "mods/thimble-term"  # under the tree: the plugin `thimble-term` that draws thimble's work in the terminal
RENDERER_NAME = "thimble-term"
CARD_RUNNER = "bin/thimble-run"  # under the plugin copy: runs a card's code in the caller's Bash (`thimble-run card <cell>`)
RUNNER_NAME = "thimble-run"  # the card runner by its name on the session's PATH, as the tools give its command
NO_RENDERER_LINE = ("thimble: WARNING - terminal mode's renderer cannot load ({why}), so thimble's cards, citations and "
                    "agents are not drawn in the terminal; `thimble doctor` says more. `thimble mode browser` opens the "
                    "browser workspace instead.")
OPEN_ELSEWHERE_LINE = "thimble: This workspace is open in {mode} mode in another terminal. Quit that session first."
LAUNCH_REFUSED_EXIT = 3  # launch-args' exit when the launch is refused (open_elsewhere); the launcher prints nothing more
# exported into main's environment: no "Move to background" and no ← agent view, the ↓ tray kept (spike U11);
# CLAUDE_DISABLE_ADOPT adds nothing to the first but does no harm
SWITCHES = {"CLAUDE_CODE_DISABLE_AGENT_VIEW": "1", "CLAUDE_DISABLE_ADOPT": "1"}
NO_MODULE_ENV = "THIMBLE_NO_MODULE"  # set, main starts with thimble's hooks module idle (the live checks' switch)
EFFORT_ENV = "CLAUDE_CODE_EFFORT_LEVEL"
# unset for main and so for every agent it starts: the effort variable would override every agent's effort (spike m7),
# the subagent model would replace the model the agents' general-purpose and Explore children inherit (V7), and its
# FORCE companion every registered type's model as well
UNSET_VARS = (EFFORT_ENV, "CLAUDE_CODE_SUBAGENT_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL_FORCE")
UNSET_LINE = "thimble: {name} is unset for this session, so thimble's agents run on the models and efforts Settings name"
UNSET_EFFORT_LINE = ("thimble: CLAUDE_CODE_EFFORT_LEVEL is unset for this session, so thimble's agents run at the efforts "
                     "Settings name; main runs at {effort} (--effort)")
# the same for a variable an `env` block of the analyst's Claude Code settings sets, which main's --settings blank
# (launch_settings)
BLANKED_LINE = ("thimble: {name}, which your Claude Code settings set, is blank in this session, so thimble's agents run "
                "on the models and efforts Settings name")
BLANKED_EFFORT_LINE = ("thimble: CLAUDE_CODE_EFFORT_LEVEL, which your Claude Code settings set, is blank in this session, "
                       "so thimble's agents run at the efforts Settings name; main runs at {effort} (--effort)")
SAFE_MODE_ENV = "CLAUDE_CODE_SAFE_MODE"
SAFE_MODE_LINE = ("thimble: WARNING - Claude Code's safe mode is on (CLAUDE_CODE_SAFE_MODE or --safe-mode), which turns "
                  "thimble's plugin off: this session gets no thimble tools, hooks or /thimble, and thimble's agents "
                  "can't start. Run `thimble` without it.")
MODULES_OFF_LINE = ("thimble's agents can't start in this session: Claude Code's hooks modules are off ({reason}). Main, "
                    "its threads, cards and labels still work.")
NO_FENCE_LINES = {
    "never": "thimble: WARNING - thimble's config turns the sandbox off (sandbox.use \"never\"), so main and thimble's "
             "agents run without thimble's fence and can change your files.",
    "missing": "thimble: WARNING - Claude Code's Bash sandbox can't run on this machine, so main and thimble's agents run "
               "without thimble's fence and can change your files; `thimble doctor` says what is missing.",
    "refused": "thimble: WARNING - thimble does not open this folder as a workspace (your home folder, /, or a folder it "
               "could not register), so main runs without thimble's fence and thimble's agents cannot start here.",
}


def write_dirs(c: str) -> list[Path]:
    """The folders main's Bash may write in workspace `c` (WRITE_DIRS): subagents.write_dirs once the subagent paths
    are in, else this module's own list."""
    try:
        from . import subagents  # noqa: PLC0415 — the subagent paths, which import the session modules
    except ImportError:
        ws = config.WORKSPACES_DIR.resolve() / c
        return [ws / d for d in WRITE_DIRS]
    return [Path(p) for p in subagents.write_dirs(c)]


def card_dirs(c: str) -> list[str]:
    """The folders of workspace `c` the card runner writes in terminal mode (cardrun.write_dirs: the notebooks, their
    outputs' side files, the labels and the card scripts), which main's fence lets main's Bash write there; [] in a
    build without the card runner."""
    try:
        from . import cardrun  # noqa: PLC0415 — the card runner of terminal mode (the backend lane's)
    except ImportError:
        _log("launch-args: this build has no card runner (app/cardrun.py), so main's Bash may not write the card folders")
        return []
    return [str(d) for d in cardrun.write_dirs(c)]


def fence_off(c: str | None) -> str:
    """Why main starts without thimble's fence in workspace `c`: a key of NO_FENCE_LINES, `refused` for a folder `up`
    refuses ($HOME or /) or one that could not be registered, or '' when it starts fenced."""
    from . import cc_settings, userconf  # noqa: PLC0415

    if not c:
        return "refused"
    box = userconf.load_or_defaults(c)[0]["sandbox"]
    if box["use"] == "never":
        return "never"
    return "" if cc_settings.sandbox_ok() else "missing"


def ticket_trees() -> list[Path]:
    """The folder of the code tickets' worktrees in a development install (dev.worktrees_dir's rule, which this module
    does not import), which main's fence lets main's Bash and its subagents write, a ticket's agent among them, and
    which their Edit and Write tools reach (additionalDirectories); none in an installed copy."""
    return [home() / "dev" / "trees"] if (config.REPO_ROOT / ".git").exists() else []


def main_fence(cwd: Path, c: str | None = None, root: Path | None = None, session: str | None = None,
               given: str = "", mode: str = launch_mode.BROWSER) -> dict[str, Any]:
    """The --settings keys that put main, and every subagent it starts, inside thimble's fence for the corpus `cwd`,
    workspace `c` (by default the one `cwd` is registered as), the plugin copy at `root`, main's session `session`
    (module note, main's fence): `sandbox`, `permissions` (userconf.main_rules, and in a development install the code
    tickets' worktrees as additionalDirectories, ticket_trees) and `env` (cc_plugin.FENCE_MARK). With the plugin's hooks off, /thimble's own command for SANDBOX_ACTIONS in that session and
    the Monitor route's watcher command for it are let out of the sandbox, and no other (sandbox_rules, watch_rules);
    `given` is the analyst's own --settings to the launcher, which may turn the hooks off (launch_hooks_blocked). In
    terminal `mode` main's Bash may also write the card folders (card_dirs), where the card runner writes a card's
    outputs. {} when fence_off says so. A config with an error fences main with the defaults' rules."""
    from . import userconf  # noqa: PLC0415

    c = c or config.workspace_for_cwd(str(cwd))
    if fence_off(c):
        return {}
    assert c is not None
    conf, _ = userconf.load_or_defaults(c)
    main = userconf.agent_conf(conf, "orientation")
    ws = config.WORKSPACES_DIR.resolve() / c
    corpus = Path(os.path.realpath(config.corpus_dir(c)))
    root = root or plugin_root()
    excluded: list[str] = []
    if launch_hooks_blocked(cwd, root, given):
        # with the hooks off, the Monitor route's watcher must reach the server (spike U15), and /thimble's own command
        # starts the server
        excluded += [*watch_rules(root, cwd, session), *sandbox_rules(root, cwd, session)]
    trees = [str(d) for d in ticket_trees()]
    for tree in trees:
        # Claude Code drops an additionalDirectories folder that does not exist as main starts, and the first ticket
        # makes this one later, so outside auto mode a ticket's agent was asked about each Read of its worktree (live
        # check L27 on 060-s4): the folder is made first
        try:
            Path(tree).mkdir(parents=True, exist_ok=True)
        except OSError:
            pass
    cards = card_dirs(c) if mode == launch_mode.TERMINAL else []
    fs = {"allowWrite": [*(str(d) for d in write_dirs(c)), *cards, *trees],
          "denyWrite": [str(corpus), str(userconf.workspace_file(c)), str(ws / "settings.json")],
          "denyRead": [*userconf.private_paths(), str(home() / LINKS_DIR)]}
    box: dict[str, Any] = {"enabled": True, "failIfUnavailable": bool(conf["sandbox"]["enforce"]),
                           "autoAllowBashIfSandboxed": False, "allowUnsandboxedCommands": False, "filesystem": fs,
                           "excludedCommands": excluded}
    if main.get("network") == "off":
        box["network"] = {"deniedDomains": ["*"]}
    perms: dict[str, list[str]] = {}
    for rule in userconf.main_rules(c):
        perms.setdefault(rule.behavior, []).append(rule.rule)
    if trees:
        perms["additionalDirectories"] = trees
    return {"sandbox": box, "permissions": perms, "env": {cc_plugin.FENCE_MARK: "1"}}


# the sandbox keys thimble's fence keeps whatever the analyst's own --settings say, since they would open it
FENCE_KEYS = ("enabled", "allowUnsandboxedCommands")


def with_fence(out: dict[str, Any], fence: dict[str, Any]) -> dict[str, Any]:
    """`out` (main's --settings) with main_fence's keys joined in: each permission list and each sandbox list joined, the
    analyst's own sandbox keys kept where they set one but FENCE_KEYS, the fence's `env` over theirs. `out` itself when
    there is no fence."""
    if not fence:
        return out
    merged = dict(out)
    perms = dict(out.get("permissions") or {})
    for key, rules in fence["permissions"].items():
        perms[key] = list(dict.fromkeys([*(perms.get(key) or []), *rules]))
    merged["permissions"] = perms
    own_box = out.get("sandbox") if isinstance(out.get("sandbox"), dict) else {}
    box = {**fence["sandbox"], **{k: v for k, v in own_box.items()
                                  if k not in ("filesystem", "network", "excludedCommands", *FENCE_KEYS)}}
    fs = dict(fence["sandbox"]["filesystem"])
    for key, paths in (own_box.get("filesystem") or {}).items():
        fs[key] = list(dict.fromkeys([*(fs.get(key) or []), *paths])) if isinstance(paths, list) else paths
    box["filesystem"] = fs
    if isinstance(own_box.get("excludedCommands"), list):
        box["excludedCommands"] = list(dict.fromkeys([*own_box["excludedCommands"], *box["excludedCommands"]]))
    if "network" in own_box or "network" in fence["sandbox"]:
        box["network"] = {**(own_box.get("network") or {}), **(fence["sandbox"].get("network") or {})}
    merged["sandbox"] = box
    merged["env"] = {**(out.get("env") or {}), **fence["env"]}
    return merged


def given_settings(cwd: Path, given: str) -> Any:
    """The analyst's own --settings to the launcher, `given` (inline JSON, or a file relative to `cwd`), parsed; None
    when there are none or they cannot be read."""
    if not given:
        return None
    try:
        return json.loads(given if given.lstrip().startswith("{") else (cwd / Path(given).expanduser()).read_text("utf-8"))
    except (OSError, ValueError):
        return None


def launch_hooks_blocked(cwd: Path, root: Path, given: str = "") -> bool:
    """cc_plugin.hooks_blocked for the session the launcher is about to start: its --settings, `given`, rank above the
    analyst's settings files as Claude Code ranks them, but cc_plugin.flag_settings cannot read them while that `claude`
    does not run yet (live check L29: `--settings '{"disableAllHooks": true}'` left /thimble's command in the sandbox,
    so /thimble could not reach the server). The org's managed tier still wins."""
    own = given_settings(cwd, given)
    v = own.get("disableAllHooks") if isinstance(own, dict) else None
    if v is True:
        return True
    if v is False:
        return cc_plugin.managed_blocks(root)
    return cc_plugin.hooks_blocked(cwd, root)


def modules_off(cwd: Path, given: str = "") -> str:
    """Why Claude Code will not load thimble's hooks module in a session the launcher starts in `cwd`, as far as the
    launch can tell: the org's managed settings turn hooks modules off (`disableAllHooks`, or `allowManagedHooksOnly`
    without thimble enabled there), the analyst's settings or `given` --settings set `disableAllHooks`, or NO_MODULE_ENV
    is set; '' otherwise. An untrusted folder or Claude Code's own switch shows only after the launch, as no hello."""
    tier = cc_plugin.managed() or {}
    if tier.get("disableAllHooks") is True:
        return "your organization's managed settings set disableAllHooks"
    if tier.get("allowManagedHooksOnly") is True:
        enabled = tier.get("enabledPlugins")
        if not (isinstance(enabled, dict) and any(str(k).startswith(f"{PLUGIN_NAME}@") and v is True
                                                  for k, v in enabled.items())):
            return "your organization's managed settings set allowManagedHooksOnly"
    if os.environ.get(NO_MODULE_ENV, "").strip():
        return f"{NO_MODULE_ENV} is set"
    own = given_settings(cwd, given)
    if isinstance(own, dict) and isinstance(own.get("disableAllHooks"), bool):
        return "your --settings set disableAllHooks" if own["disableAllHooks"] else ""
    value = None
    for path in (cc_plugin.config_dir() / cc_plugin.USER_SETTINGS, *(cwd / p for p in cc_plugin.PROJECT_SETTINGS)):
        v = (cc_plugin._read(path) or {}).get("disableAllHooks")
        if isinstance(v, bool):
            value = v
    return "your Claude Code settings set disableAllHooks" if value else ""


def register_here(cwd: Path) -> str | None:
    """Register the folder `cwd` as a corpus, as a session's /thimble would (open_workspace with `here`: the folder
    itself, with the path the analyst named it by, caller_alias), so that the fence and launch.json have their workspace
    before main starts; its name. None for a folder `up` refuses ($HOME or /) or one that cannot be registered."""
    if refused(cwd):
        return None
    told, alias = caller_alias(cwd)
    try:
        rec = config.register_corpus(cwd, exact=True, shown=alias if told else config.KEEP_SHOWN)
    except (OSError, ValueError) as e:
        _log(f"launch-args: {cwd} was not registered: {e}")
        return None
    return str(rec.get("name") or "") or None


EXTENSIONS_WAIT_S = 15.0
# the launch starts thimble's server before main (server_for_launch), so the hooks module registers thimble's agent types
# inside main's session start and they are in main's first agent listing; started any later, Claude Code prints "N agent
# type(s) available" when they come
LAUNCH_NO_SERVER_LINE = ("thimble: thimble's server did not start within {wait:.0f} s, so thimble's agents are not "
                         "registered yet; /thimble starts it again. See {log}")


def server_for_launch(c: str) -> list[str]:
    """Start thimble's server for workspace `c` if it is down, and wait for it, before the launcher starts main
    (ensure_running, as `up` does): the note lines to print, the server's own notices among them, FOREIGN_LINE when
    another install's server holds the port, and LAUNCH_NO_SERVER_LINE when it did not answer in time. Never raises:
    the launch goes on, and /thimble starts the server then."""
    try:
        ensure_home()
        url = api_url()
        other = foreign_home(url)
        if other:
            return [FOREIGN_LINE.format(port=port(), other=other)]
        NOTICES.clear()
        try:
            up = ensure_running(WAIT_S)
        except TimeoutError as e:
            _log(str(e))
            up = healthy(url)
        notes = list(NOTICES)
        NOTICES.clear()
        if not up:
            _log(f"launch-args: no server answers at {url} for {c}")
            stuck = stuck_server(url)
            notes.append(f"thimble: {STUCK_LINE.format(pid=stuck)}" if stuck else
                         LAUNCH_NO_SERVER_LINE.format(wait=WAIT_S, log=log_path()))
        return notes
    except Exception as e:  # noqa: BLE001 — the launch goes on without it
        _log(f"launch-args: the server was not started: {type(e).__name__}: {e}")
        return []


def refresh_extensions(c: str) -> None:
    """Find the workspace's extensions again before main starts, so the agent types the hooks module registers at
    session start include the active extensions' agents (extensions become active for a workspace only in a refresh,
    spike U4): through the server when it runs (GET /ws/{c}/extensions refreshes), else here (local_extensions). A
    view's fit check it starts here is left for the server's next refresh. Never raises."""
    url = api_url()
    try:
        if healthy(url) and foreign_home(url) is None:
            _request("GET", f"{url}/api/ws/{urllib.parse.quote(c)}/extensions", timeout=EXTENSIONS_WAIT_S)
            return
    except Exception as e:  # noqa: BLE001 — the session starts on the extensions found last time
        _log(f"launch-args: the extensions of {c} were not found again: {type(e).__name__}: {e}")
        return
    local_extensions(c)


def local_extensions(c: str) -> None:
    """refresh_extensions in this process, with no server: terminal mode's, which asks no server even when one runs.
    Never raises."""
    try:
        import asyncio  # noqa: PLC0415

        from . import extensions  # noqa: PLC0415 — the extensions, needed by this subcommand alone

        async def go() -> None:
            await asyncio.wait_for(extensions.refresh(c), EXTENSIONS_WAIT_S)

        asyncio.run(go())
    except Exception as e:  # noqa: BLE001 — the session starts on the extensions found last time
        _log(f"launch-args: the extensions of {c} were not found again: {type(e).__name__}: {e}")


def renderer_root() -> Path:
    """Terminal mode's renderer plugin in this tree (TERMINAL_RENDERER)."""
    return (config.REPO_ROOT / TERMINAL_RENDERER).resolve()


def renderer_problem(path: Path | None = None) -> str:
    """Why the renderer plugin at `path` (default renderer_root) cannot load: missing, its plugin.json unreadable or
    naming another plugin, or its hooks.json naming a module that is not there; '' when it can."""
    root = path or renderer_root()
    manifest = root / ".claude-plugin" / "plugin.json"
    if not manifest.is_file():
        return f"{root} is missing" if not root.exists() else f"{root} has no .claude-plugin/plugin.json"
    try:
        name = json.loads(manifest.read_text("utf-8")).get("name")
    except (OSError, ValueError, AttributeError):
        return f"{manifest} does not parse"
    if name != RENDERER_NAME:
        return f"{manifest} names the plugin {name!r}, not {RENDERER_NAME!r}"
    hooks = root / "hooks" / "hooks.json"
    try:
        modules = json.loads(hooks.read_text("utf-8")).get("modules") or [] if hooks.is_file() else []
    except (OSError, ValueError, AttributeError):
        return f"{hooks} does not parse"
    gone = [m for m in modules if not isinstance(m, str) or not (hooks.parent / m).is_file()]
    return f"{hooks} names modules that are not there: {', '.join(map(str, gone))}" if gone else ""


def terminal_env(c: str | None) -> dict[str, str]:
    """What a terminal-mode session gets in its environment and its --settings `env` (module note, terminal mode):
    launch_mode.ENV, THIMBLE_HOME, the workspace folder (launch_mode.WS_ENV) when there is a workspace, and the data and
    workspaces folders this launch registered in, so that every process of the session, thimble's backend run in the
    MCP shim among them, finds the same workspace, also where Claude Code dropped the shell's environment. Call it inside
    server_dirs."""
    env = {launch_mode.ENV: launch_mode.TERMINAL, "THIMBLE_HOME": str(home().resolve()),
           "THIMBLE_DATA_DIR": str(config.DATA_DIR), "THIMBLE_WORKSPACES_DIR": str(config.WORKSPACES_DIR)}
    if c:
        env[launch_mode.WS_ENV] = str(config.workspace_path(c).resolve())
    return env


def write_roles(c: str) -> None:
    """Write the hooks module's roles file, trusted/roles.json (module_bridge.roles_file, the agents lane's), before a
    terminal-mode main starts, since no server hands the module its roles there. Never raises: without the file the
    module registers no thimble agent, and the doctor says so."""
    try:
        from . import module_bridge  # noqa: PLC0415 — the session modules, needed by this subcommand alone

        module_bridge.roles_file(c)
    except Exception as e:  # noqa: BLE001 — the launch goes on
        _log(f"launch-args: the roles file of {c} was not written: {type(e).__name__}: {e}")


class LaunchRefused(Exception):
    """launch-args refuses the launch, with the line to print (open_elsewhere)."""


def live_launch(rec: Mapping[str, Any]) -> bool:
    """Whether the process a launch.json record names (`pid`: main's `claude`, which the launcher wrote there as it
    started it) runs now as Claude Code's `claude` (its program, or the script node runs, is named claude), naming the
    record's session when it names one (`--session-id <sid>` or `--resume <sid>`, as the launcher passes it). False
    for a pid that is gone, unreadable, or another process that took the pid later."""
    pid = rec.get("pid")
    if isinstance(pid, bool) or not isinstance(pid, int) or pid <= 1 or pid == os.getpid():
        return False
    argv = procs.argv(pid)
    if not any(Path(a).name.lower() in ("claude", "claude.exe") for a in argv[:2]):
        return False
    sid = str(rec.get("session") or "")
    return not sid or any(a == sid and i and argv[i - 1] in ("--session-id", "--resume", "-r")
                          or a in (f"--session-id={sid}", f"--resume={sid}") for i, a in enumerate(argv))


def open_elsewhere(c: str, mode: str | None = None) -> str | None:
    """The line a launch in `mode` (default: the mode the workspace's folder starts in) refuses with, since a workspace
    is open in one mode at a time: launch.json of workspace `c` names the other mode (no `mode`: browser, a launch from
    before modes) and a session that runs now (live_launch). None when the launch may go on."""
    if mode is None:
        mode = launch_mode.resolve(config.corpus_dir(c))[0]
    rec = read_launch(c)
    other = rec.get("mode") if rec.get("mode") in launch_mode.MODES else launch_mode.BROWSER
    if other == mode or not live_launch(rec):
        return None
    return OPEN_ELSEWHERE_LINE.format(mode=other)


def launch_record(c: str, session: str | None, fenced: bool, switches: dict[str, str], unset: list[str],
                  pid: int | None = None, modules_off: str = "", mode: str = launch_mode.BROWSER) -> None:
    """Write launch.json in workspace `c` (module note, main's fence), with `pid`, the launcher's own process, when the
    launcher names it, which the launcher then replaces with main's `claude` process as it starts it, `modules_off`, why the launch
    found Claude Code's hooks modules off (modules_off), which the browser and the doctor give as the reason, and
    `mode`, the mode the session starts in, which the session's other processes read (launch_mode.session_mode). Never
    raises: a launch that cannot write it starts main, whose hooks module then stays idle."""
    from .ledger import atomic_write_text  # noqa: PLC0415

    from . import subagent_files  # noqa: PLC0415 — standard library only

    try:
        ws = config.workspace_dir(c)
        subagent_files.ensure(ws)  # the trusted folder, in a workspace made before it
        path = ws / LAUNCH_FILE
        rec: dict[str, Any] = {"session": session, "at": _now(), "fenced": fenced, "switches": switches,
                               "unset": unset, "mode": mode}
        if pid and pid > 1:
            rec["pid"] = int(pid)
        if modules_off:
            rec["modules_off"] = modules_off
        atomic_write_text(path, json.dumps(rec, indent=1) + "\n")
    except (OSError, ValueError) as e:
        _log(f"launch-args: {LAUNCH_FILE} of {c} was not written: {e}")


def read_launch(c: str | None) -> dict[str, Any]:
    """launch.json of workspace `c`, {} when there is none."""
    try:
        got = _read_json(config.workspace_path(c) / LAUNCH_FILE) if c else None
    except (OSError, ValueError, KeyError):
        got = None
    return got if isinstance(got, dict) else {}


SESSION_ID_RE = re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")


@contextmanager
def server_dirs() -> Iterator[None]:
    """config's data and workspaces folders set to the ones the server runs with (resolve_env) for the block, and put
    back after it: what the launch registers and writes must be where the server reads it, which this process's own
    defaults need not be."""
    env = resolve_env()
    held = config.DATA_DIR, config.WORKSPACES_DIR
    config.DATA_DIR = Path(env["data_dir"]).expanduser().resolve()
    config.WORKSPACES_DIR = Path(env["workspaces_dir"]).expanduser().resolve()
    try:
        yield
    finally:
        config.DATA_DIR, config.WORKSPACES_DIR = held


def launch_args(cwd: Path, resume: bool = False, settings: str = "", own_session: str | None = None,
                safe_mode: bool = False, launcher_pid: int | None = None) -> str:
    """The launcher's values, one per line: the plugin folder to load with `--plugin-dir` ('' when the plugin copy is
    one Claude Code has installed, installed_copy), the `--allowedTools` line, the `--effort` value ('' for none), the
    `--settings` value (launch_settings, over the analyst's own `settings`, with thimble's fence), the value to export as
    terminal_tools.ENV ('' when the `claude` it starts does not read it), main's `--name` (main_name), the session id to
    pass with `--session-id` ('' when the analyst's own flags name the session, `own_session`, or `resume` continues
    one), the env line (NAME=VALUE words to export: SWITCHES), the unset line (the names of UNSET_VARS the analyst's
    environment sets), the note line (tab-separated lines to print before Claude Code starts), the mode line (the mode
    the folder starts in, launch_mode.resolve, then a tab and in terminal mode the renderer plugin's folder to load with
    `--plugin-dir`, when it can load, then a tab and the workspace's launch.json, whose `pid` the launcher sets to main's
    `claude` process; the empty fields at its end are left out), the export line (tab-separated NAME=VALUE pairs to export: terminal_env and a PATH
    with the plugin copy's bin/ first in terminal mode, else none), with `resume` the session to resume, then main's prompt, whose turn ending follows that
    value.

    Before it prints, it registers the folder (register_here), refuses with LaunchRefused when the workspace is open in
    the other mode (open_elsewhere), starts thimble's server and waits for it (server_for_launch; not in terminal mode),
    finds the workspace's extensions again (refresh_extensions; in terminal mode local_extensions) and writes
    launch.json (launch_record), with `launcher_pid`, the launcher's own pid, until the launcher writes main's `claude`
    process there, and in terminal mode the hooks module's roles file (write_roles). Main's effort is explicit:
    models.main's, else the CLAUDE_CODE_EFFORT_LEVEL it unsets, else cc_settings.main_effort_flag; a stored ultracode
    runs at its level."""
    installed = installed_copy(cwd)
    root = installed.root if installed else plugin_root()
    with server_dirs():
        return _launch_args(cwd, resume, settings, own_session, safe_mode, installed, root, launcher_pid)


def _launch_args(cwd: Path, resume: bool, settings: str, own_session: str | None, safe_mode: bool,
                 installed: Installed | None, root: Path, launcher_pid: int | None = None) -> str:
    """launch_args inside server_dirs."""
    from . import cc_settings, events, terminal_tools  # noqa: PLC0415 — needed by this subcommand alone

    c = register_here(cwd)
    mode = launch_mode.resolve(cwd)[0]
    terminal = mode == launch_mode.TERMINAL
    refusal = open_elsewhere(c, mode) if c else None
    if refusal:
        raise LaunchRefused(refusal)
    notes: list[str] = []
    if c and terminal:
        local_extensions(c)  # terminal mode asks no server, even one that runs
    elif c:
        notes += server_for_launch(c)  # before main, for its first agent listing
        refresh_extensions(c)
    workspaces = Path(resolve_env()["workspaces_dir"]).resolve()
    anchors = workspaces / "*" / ANCHORS_DIR
    # on the Monitor route main arms its Monitor on the watcher again every 30 minutes, which must not wait on a prompt;
    # only --stream, since the watcher's other modes report to the server as main's hooks
    watcher = f"Bash({root / WATCHER} --stream *)"
    # in terminal mode a card's code runs through the card runner in main's Bash, which must not wait on a prompt either,
    # as a browser-mode card's code runs in the kernel unasked: by its name (cardrun.command), with this copy's bin/ first
    # on the session's PATH (the export line), and by its path, as a command from before this release named it
    runner = [f"Bash({RUNNER_NAME} *)", f"Bash({root / CARD_RUNNER} *)"] if terminal else []
    tools_line = ",".join([MCP_TOOLS_RULE, f"Read(/{anchors}/**)", watcher, *runner, *skill_rules(root)])
    last = [last_main(cwd)] if resume else []
    turn_tools = terminal_tools.launch_value()
    # the session main runs as: one this launch names (--session-id) unless the analyst's flags or --continue name it
    if resume and last and last[0]:
        session: str | None = last[0]
        session_id = ""
    elif own_session is not None or resume:
        session = own_session if own_session and SESSION_ID_RE.fullmatch(own_session) else None
        session_id = ""
    else:
        session = session_id = str(uuid.uuid4())
    why_off = fence_off(c)
    fence = {} if why_off else main_fence(cwd, c, root, session, given=settings, mode=mode)
    if why_off in NO_FENCE_LINES:
        notes.append(NO_FENCE_LINES[why_off])
    unset = [name for name in UNSET_VARS if os.environ.get(name, "").strip()]
    # set by an `env` block of the analyst's Claude Code settings: main's --settings blank them (launch_settings)
    blanked = [name for name in UNSET_VARS if name not in unset and (cc_settings.settings_env(cwd, name) or "").strip()]
    chosen = main_choice(cwd).get("effort")
    effort = cc_settings.level_of(chosen) if chosen in (*cc_settings.EFFORTS, cc_settings.ULTRACODE) else ""
    env_effort = (os.environ.get(EFFORT_ENV, "") if EFFORT_ENV in unset else
                  cc_settings.settings_env(cwd, EFFORT_ENV) if EFFORT_ENV in blanked else "").strip().lower()
    if EFFORT_ENV in unset or EFFORT_ENV in blanked:
        effort = effort or (env_effort if env_effort in cc_settings.EFFORTS else "")
        line = UNSET_EFFORT_LINE if EFFORT_ENV in unset else BLANKED_EFFORT_LINE
        notes.append(line.format(effort=effort or "its own settings' effort"))
    else:
        effort = effort or cc_settings.main_effort_flag(cwd)
    notes += [UNSET_LINE.format(name=name) for name in unset if name != EFFORT_ENV]
    notes += [BLANKED_LINE.format(name=name) for name in blanked if name != EFFORT_ENV]
    switches = dict(SWITCHES)
    if os.environ.get(NO_MODULE_ENV, "").strip():
        switches[NO_MODULE_ENV] = os.environ[NO_MODULE_ENV].strip()
    why_idle = modules_off(cwd, settings)
    if why_idle:
        notes.append(MODULES_OFF_LINE.format(reason=why_idle))
    if safe_mode or os.environ.get(SAFE_MODE_ENV, "").strip() not in ("", "0", "false"):
        notes.append(SAFE_MODE_LINE)
    exports = terminal_env(c) if terminal else {}
    renderer = ""
    if terminal:
        why_no_renderer = renderer_problem()
        if why_no_renderer:
            notes.append(NO_RENDERER_LINE.format(why=why_no_renderer))
        else:
            renderer = str(renderer_root())
    # the launcher writes main's `claude` pid into launch.json itself, since it outlives `claude` in both modes to say
    # how to come back with thimble (plugin/bin/thimble)
    launch_file = str(config.workspace_dir(c) / LAUNCH_FILE) if c else ""
    mode_line = "\t".join([mode, renderer, launch_file]) if launch_file else "\t".join([mode, renderer]).rstrip("\t")
    settings_value = launch_settings(cwd, settings, fence, env=exports)
    if c:  # fenced as main's command line will show it (an unreadable --settings of the analyst's carries no fence)
        launch_record(c, session, cc_plugin.fenced_argv(["claude", "--settings", settings_value], cwd), switches, unset,
                      launcher_pid, modules_off=why_idle, mode=mode)
        if terminal:
            write_roles(c)
    load = "" if installed or cc_plugin.marketplace(root) != cc_plugin.INLINE else str(root)
    # main's prompt, rendered once launch.json names the session's mode, in the environment the session gets, so that
    # launch_mode.current finds that mode here as in the session
    with with_environ(exports):
        prompt = events.session_prompt(str(cwd.resolve()), bool(turn_tools))
    # the launcher's exports in terminal mode also put this copy's bin/ first on PATH, so main's Bash, and every agent's,
    # runs the card runner the tools name without its install path (cardrun.command); main's --settings `env` leaves
    # PATH alone
    exported = {**exports, "PATH": os.pathsep.join([str(root / "bin"), os.environ.get("PATH", "")])} if terminal else exports
    return "\n".join([load, tools_line, effort, settings_value, turn_tools,
                      main_name(cwd), session_id, " ".join(f"{k}={v}" for k, v in switches.items()), " ".join(unset),
                      "\t".join(notes), mode_line, "\t".join(f"{k}={v}" for k, v in exported.items()), *last, prompt])


@contextmanager
def with_environ(values: Mapping[str, str]) -> Iterator[None]:
    """This process's environment with `values` set for the block, and put back after it."""
    held = {k: os.environ.get(k) for k in values}
    os.environ.update(values)
    try:
        yield
    finally:
        for k, v in held.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


def cmd_launch_args(args: argparse.Namespace) -> int:
    try:
        out = launch_args(Path(args.cwd or os.environ.get("THIMBLE_CALLER_CWD") or os.getcwd()), bool(args.resume),
                          args.settings or "", own_session=args.own_session, safe_mode=bool(args.safe_mode),
                          launcher_pid=args.launcher_pid)
    except LaunchRefused as e:  # on stderr, which the launcher leaves on the terminal; it starts nothing
        print(str(e), file=sys.stderr)
        return LAUNCH_REFUSED_EXIT
    print(out)
    # on stderr, which the launcher leaves on the terminal, before Claude Code starts
    warning = claude_code_warning(claude_code_version())
    if warning:
        print(warning, file=sys.stderr)
    return 0


def cmd_prompt(args: argparse.Namespace) -> int:
    """Print prompt files for a skill's injected command. A missing file prints the loader's error line. With
    --unless-launched, nothing in a session the launcher started or for an action that opens no workspace. With --if-main
    (the SessionStart hook), nothing unless this runs in main's `claude` process (is_main) and main itself cleared or
    compacted, not one of its subagents (main_itself); --lead is printed first."""
    if getattr(args, "unless_launched", False):
        action = ALIASES.get((args.action or "").strip(), (args.action or "").strip())
        if launched() or action not in OPENING or (action == RESUME and not (args.archive or "").strip()):
            return 0
    cwd = Path(args.cwd or os.environ.get("THIMBLE_CALLER_CWD") or os.getcwd())
    if getattr(args, "if_main", False) and not (is_main(cwd) and main_itself(_hook_input())):
        return 0
    from . import events, prompts  # noqa: PLC0415 — the renderer, needed by this subcommand alone

    try:
        text = events.render_prompts(args.names, str(cwd.resolve()))
    except prompts.PromptError as e:
        print(f"thimble: {e}")
        return 1
    lead = (getattr(args, "lead", None) or "").strip()
    print(f"{lead}\n\n{text}" if lead else text)
    return 0


COMPACT_FRESH_S = 120.0  # a compact_boundary in main's transcript this recent is main's own compaction (main_itself)
COMPACT_TAIL = 262_144  # bytes at the end of main's transcript where main_itself looks for it


def _hook_input() -> dict[str, Any]:
    """The JSON Claude Code gives a hook on stdin, {} when there is none (a terminal) or it does not parse."""
    if sys.stdin is None or sys.stdin.isatty():
        return {}
    try:
        data = json.loads(sys.stdin.read(1_000_000) or "{}")
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def main_itself(hook: dict[str, Any]) -> bool:
    """Whether the SessionStart a hook heard is main's own: a /clear always is, and a compaction is when main's
    transcript ends with a compact_boundary of its own written in the last COMPACT_FRESH_S. A subagent's compaction
    fires SessionStart `compact` with main's session id and no agent id (U2), and writes its boundary into its own
    transcript, not main's. A hook input that names no compaction, or no transcript, counts as main's."""
    if str(hook.get("source") or "") != "compact" or not hook.get("transcript_path"):
        return True
    try:
        path = Path(str(hook["transcript_path"]))
        with path.open("rb") as f:
            f.seek(max(0, path.stat().st_size - COMPACT_TAIL))
            tail = f.read().splitlines()
    except OSError:
        return True
    for line in reversed(tail):
        try:
            rec = json.loads(line)
        except ValueError:
            continue
        if isinstance(rec, dict) and rec.get("subtype") == "compact_boundary" and not rec.get("isSidechain"):
            try:
                at = datetime.fromisoformat(str(rec.get("timestamp") or "").replace("Z", "+00:00"))
            except ValueError:
                return True
            return (datetime.now(timezone.utc) - at).total_seconds() <= COMPACT_FRESH_S
    return False


def is_main(cwd: Path) -> bool:
    """Whether the `claude` process this command runs under (cc_plugin.claude_pid) runs the session that is main in the
    workspace for `cwd`, by the server's record (GET /api/events/main). False when the server is down, the folder is no
    workspace, or another session is main."""
    pid = cc_plugin.claude_pid()
    if not pid:
        return False
    query = urllib.parse.urlencode({"cwd": str(cwd.resolve()), "pid": pid})
    status, body = _request("GET", f"{api_url()}/api/events/main?{query}", timeout=3.0)
    return status == 200 and isinstance(body, dict) and body.get("main") is True


def has_ui_build() -> bool:
    return (Path(config.FRONTEND_DIST) / "index.html").is_file()


# ----------------------------------------------------------------------------- status


def orient_status(name: str | None) -> str:
    if not name:
        return "no workspace"
    p = Path(resolve_env()["workspaces_dir"]) / name / "orient" / "run.json"
    try:
        return str(json.loads(p.read_text("utf-8")).get("status") or "unknown")
    except (OSError, ValueError):
        return "not started"


def queue_depth(url: str, name: str | None) -> str:
    for path in (f"/api/ws/{name}/jobs", "/api/jobs"):
        if not name and path.startswith("/api/ws"):
            continue
        status, body = _request("GET", f"{url}{path}", timeout=2.0)
        if status == 200:
            if isinstance(body, list):
                return str(len(body))
            if isinstance(body, dict):
                for k in ("depth", "queued", "pending"):
                    if k in body:
                        return str(body[k])
                return str(len(body.get("jobs", [])))
    return "n/a"


def status_line(name: str | None) -> str:
    url = api_url()
    up = healthy(url)
    parts = [f"server {'up' if up else 'down'} at {url}", f"orientation: {orient_status(name)}",
             f"queue: {queue_depth(url, name) if up else 'n/a'}"]
    return "thimble: " + "; ".join(parts)


# ----------------------------------------------------------------------------- doctor


def is_git_checkout() -> bool:
    return (config.REPO_ROOT / ".git").exists()


def git_branch() -> str:
    if not is_git_checkout():
        return "?"
    try:
        out = subprocess.run(["git", "rev-parse", "--abbrev-ref", "HEAD"], cwd=config.REPO_ROOT, capture_output=True,
                             text=True, timeout=5)
        return out.stdout.strip() or "?"
    except Exception:  # noqa: BLE001
        return "?"


def _git(*args: str) -> str:
    if not is_git_checkout():
        return ""
    try:
        return subprocess.run(["git", *args], cwd=config.REPO_ROOT, capture_output=True, text=True, timeout=10).stdout.strip()
    except Exception:  # noqa: BLE001
        return ""


def release_line() -> str:
    """`release <version> @ <commit>, <date>` from RELEASE.json, or ''."""
    try:
        r = json.loads((config.REPO_ROOT / "RELEASE.json").read_text("utf-8"))
        return f"release {r.get('version', '?')} @ {r.get('commit', '?')}, {r.get('date', '?')}"
    except (OSError, ValueError, AttributeError):
        return ""


def auth_line(status: dict[str, Any] | None) -> str:
    """The doctor's auth line: the login `claude auth status` reports (config.auth_status), by method and provider."""
    if not config.CLI_PATH:
        return f"no claude CLI: {config.NO_CLAUDE}"
    if status is None:
        return "not known: `claude auth status --json` did not answer"
    if status.get("loggedIn") is False:
        return "not logged in: log in with `claude`; nothing that calls a model runs until then"
    return f"logged in ({status.get('authMethod') or '?'}, {status.get('apiProvider') or '?'}), as `claude auth status` reports"


def _last_jsonl(p: Path) -> dict[str, Any] | None:
    try:
        lines = [ln for ln in p.read_text("utf-8").splitlines() if ln.strip()]
        return json.loads(lines[-1]) if lines else None
    except (OSError, ValueError):
        return None


def dev_dir() -> Path:
    """Where the dev tickets live (dev.DEV_DIR's rule, which this module does not import)."""
    return Path(os.environ.get("THIMBLE_DEV_DIR") or config.REPO_ROOT / "dev")


def _tickets() -> list[dict[str, Any]]:
    try:
        recs = [json.loads(ln) for ln in (dev_dir() / "tickets.jsonl").read_text("utf-8").splitlines() if ln.strip()]
    except (OSError, ValueError):
        return []
    return [r for r in recs if isinstance(r, dict)]


def _last_ticket_error() -> str:
    for rec in reversed(_tickets()):
        if rec.get("error"):
            return f"{rec.get('title') or 'untitled'!r} ({rec.get('status')}): {str(rec['error'])[:200]}"
    return "none"


def tickets_line() -> str:
    """The dev tickets at a glance: how many wait, the one that runs and since when, and the last one's end."""
    recs = _tickets()
    if not recs:
        return "none"
    running = [r for r in recs if r.get("status") == "running"]
    queued = sum(1 for r in recs if r.get("status") == "queued")
    parts = [f"{len(recs)} filed", f"{queued} queued"]
    parts += [f"running {r.get('title')!r} since {r.get('ts_end') or r.get('ts')} (pid {r.get('runner')}, session "
              f"{r.get('session') or '-'})" for r in running]
    done = [r for r in recs if r.get("status") not in ("running", "queued")]
    if done:
        parts.append(f"last {done[-1].get('title')!r} {done[-1].get('status')}")
    return "; ".join(parts)


def source_changed_text(st: dict[str, Any], up: bool) -> str:
    if not up:
        text = "n/a (server down)"
    else:
        changed = source_changed(st)
        text = ("unknown (no fingerprint recorded at this server's start)" if changed is None
                else "yes (the next `/thimble` restarts it when idle)" if changed else "no")
    off = autorestart_off()
    return text + ("" if off is None else f"; auto-restart disabled ({off})")


BROWSER_DEPS = "sudo backend/.venv/bin/python -m playwright install-deps chromium-headless-shell"


def browser_fix() -> str:
    """The doctor's fix for a missing headless Chromium: the installer's answer that downloads it."""
    return f": `bash {config.REPO_ROOT / 'scripts' / 'install.sh'} --browser bundled` downloads it, then `thimble restart`"


def playwright_browsers_dir(environ: Mapping[str, str] | None = None, platform_: str | None = None) -> Path:
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


def headless_fetched(browsers_json: Path) -> bool:
    """Whether the headless Chromium the Playwright with this browsers.json launches is in Playwright's browsers folder;
    with no readable browsers.json, whether any headless Chromium is."""
    browsers = playwright_browsers_dir()
    try:
        data = json.loads(browsers_json.read_text("utf-8"))
        rev = next(str(b["revision"]) for b in data["browsers"] if b.get("name") == "chromium-headless-shell")
    except (OSError, ValueError, KeyError, TypeError, StopIteration):
        return any(browsers.glob("chromium_headless_shell-*"))
    return (browsers / f"chromium_headless_shell-{rev}").is_dir()


def harness_line(url: str, up: bool, commands: bool = True) -> str:
    """Whether the card harness draws cards (render.py's headless Chromium), and with `commands` the command that fixes
    it when it cannot: the running server's own answer, else whether the browser was fetched. Without it no card is
    checked, since the card check reads a card's picture."""
    spec = importlib.util.find_spec("playwright")
    fetched = headless_fetched(Path(spec.origin).parent / "driver" / "package" / "browsers.json" if spec and spec.origin
                               else Path("-"))
    which, what = _browser_choice()
    fetched = fetched or which == "system"
    fix = browser_fix() if commands and what != _browser_off() else ""
    if up:
        status, got = _request("GET", f"{url}/api/render/status")
        if status == 200 and isinstance(got, dict):
            if got.get("ready"):
                return f"ready ({got.get('pages')} pages)"
            why = str(got.get("why") or "starting")
            if commands and why == headless.NO_LIBRARIES:
                fix = f": run `{BROWSER_DEPS}` in {config.REPO_ROOT}, then `thimble restart`"
            return f"not drawing ({why}); cards are not checked" + ("" if fetched and why != headless.NO_LIBRARIES else fix)
    if which == "system":
        return f"the system browser, {what}" + ("" if up else " (the server is down)")
    if which == "off":
        return f"no browser ({what}), so cards are not checked{fix}"
    if fetched:
        return "headless Chromium fetched" + ("" if up else " (the server is down)")
    return f"no headless Chromium in {playwright_browsers_dir()}, so cards are not checked{fix}"


def _browser_choice() -> tuple[str, str]:
    """userconf.browser, or Playwright's own Chromium when the config cannot be read (config_line reports that)."""
    from . import userconf  # noqa: PLC0415

    try:
        return userconf.browser()
    except Exception:  # noqa: BLE001 — the doctor reports; it never fails on one of its lines
        return "bundled", ""


def _browser_off() -> str:
    from . import userconf  # noqa: PLC0415

    return userconf.OFF


def config_line(workspaces: Path) -> str:
    """thimble's config (userconf): its file and whether it is read, each workspace that overrides it, and the first
    error of any of them."""
    from . import userconf  # noqa: PLC0415

    path = userconf.global_file()
    over = sorted(p.parent.name for p in workspaces.glob(f"*/{userconf.FILE}")) if workspaces.is_dir() else []
    errors = [e for e in [userconf.problem(), *(userconf.problem(c) for c in over)] if e]
    text = f"{path} ({'read' if path.is_file() else 'no file, so the defaults'})"
    text += f"; overridden for {', '.join(over)}" if over else ""
    return text + (f"; {errors[0]}, and no agent starts until it is fixed" if errors else "")


def browser_line() -> str:
    """The browser the screenshots and the card harness start (userconf.browser)."""
    from . import userconf  # noqa: PLC0415

    which, what = userconf.browser()
    return {"system": f"the system browser, {what}", "bundled": "Playwright's own Chromium"}.get(which, f"none: {what}")


def pages_line(commands: bool = True) -> str:
    """Whether the frontend's headless Chromium, which loads a view's page for its checks and review and takes the
    screenshots, was fetched, and with `commands` the command that fetches it."""
    browsers_json = FRONTEND_DIR / "node_modules" / "playwright-core" / "browsers.json"
    if not browsers_json.is_file():
        return "n/a (the frontend's packages are not installed)"
    which, what = _browser_choice()
    fix = browser_fix() if commands and what != _browser_off() else ""
    if which == "system":
        return f"the system browser, {what}"
    if which == "off":
        return f"no browser ({what}), so {headless.SKIPPED[headless.PAGES]}{fix}"
    if headless_fetched(browsers_json):
        return "headless Chromium fetched"
    return f"no headless Chromium in {playwright_browsers_dir()}, so {headless.SKIPPED[headless.PAGES]}{fix}"


def sandbox_lines(commands: bool = True) -> list[str]:
    """The doctor's `bash sandbox` line: whether Claude Code's Bash sandbox can run (cc_settings.sandbox_ok), which the
    agents' Bash then uses unless thimble's config says `sandbox.use` "never", and, when it cannot run, what it lacks and
    with `commands` the root commands that install it. Where it runs, the line names the empty `.claude/.cc-writes/`
    folder Claude Code creates in the folder a sandboxed command starts in, which is the agent's own folder."""
    from . import cc_settings, userconf  # noqa: PLC0415

    try:
        missing = cc_settings.sandbox_missing()
        cmds, what = cc_settings.sandbox_setup() if missing else ([], "")
    except Exception as e:  # noqa: BLE001 — the doctor reports; it never fails on one of its lines
        return [f"  bash sandbox: not checked ({type(e).__name__})"]
    try:
        box = userconf.load_or_defaults()[0]["sandbox"]
    except Exception:  # noqa: BLE001
        box = userconf.DEFAULTS["sandbox"]
    if box.get("use") == "never":
        return ["  bash sandbox: off in thimble's config (sandbox.use \"never\"), so "
                + ("thimble's config (sandbox.enforce) refuses to start the agents" if box.get("enforce") else
                   "the agents' Bash runs with your user's access, limited only by each agent's permission mode")]
    if not missing:
        from . import ticket_box  # noqa: PLC0415

        why = ticket_box.problem()
        tickets = ("a code ticket's checks and test server run in thimble's sandbox runtime, and its change reaches "
                   "thimble's own code only once you allow it" if not why else
                   f"a code ticket runs its checks and test server outside it, so it asks you before it starts: {why}")
        return ["  bash sandbox: runs (every agent's Bash runs in it: no writes outside the agent's folder and no "
                f"network unless the agent's network is \"on\"; {tickets}; Claude Code's sandbox adds an empty "
                ".claude/.cc-writes/ folder to the agent's own folder, where its commands start)"]
    after = ("thimble's config (sandbox.enforce) refuses to start the agents" if box.get("enforce") else
             "the agents' Bash runs outside it, under each agent's permission mode")
    head = "  bash sandbox: off, missing " + ", ".join(missing) + "; " + after
    if not cmds or not commands:
        return [head + (f"; {what}" if what else "")]
    return [f"{head}. To turn it on, run these, which {what}, then `thimble restart`:", *(f"    {c}" for c in cmds)]


def own_sandbox_line(cwd: Path) -> str:
    """The doctor's line on the analyst's own Claude Code sandbox for a session in `cwd` (cc_settings.own_sandbox): main's
    Bash runs in that session, so with it on Claude Code adds an empty .claude/.cc-writes/ folder to `cwd`."""
    from . import cc_settings  # noqa: PLC0415

    if not cc_settings.own_sandbox(cwd):
        return "off"
    return (f"on, so main's Bash adds an empty .claude/.cc-writes/ folder to {cwd}. That is Claude Code's sandbox in "
            "your own session, which thimble leaves as it is")


def fence_line(cwd: Path) -> str:
    """The doctor's line on main's fence for a session the launcher starts in `cwd` (main_fence): on, or off and why,
    with what the last launch here recorded (launch.json)."""
    c = config.workspace_for_cwd(str(cwd))
    if refused(cwd):
        return "none: thimble does not open your home folder or / as a workspace"
    if not c:
        return ("on at the first `thimble` here, which registers the folder: main runs in Claude Code's sandbox with the "
                "corpus read-only and writes only in thimble's agents' work folders")
    why = fence_off(c)
    if why == "never":
        return "off: thimble's config turns the sandbox off (sandbox.use \"never\"), so main and its agents can change your files"
    if why == "missing":
        return "off: Claude Code's Bash sandbox can't run on this machine (the bash sandbox line says what is missing)"
    last = read_launch(c)
    seen = (f"; the last launch here ({last.get('at') or '?'}) was {'fenced' if last.get('fenced') else 'not fenced'}"
            if last else "")
    return ("on: main and thimble's agents, its subagents, run in Claude Code's sandbox with the corpus read-only, "
            f"writes only in the agents' work folders, and thimble's token files unreadable{seen}")


def switches_line() -> str:
    """The doctor's line on what the launcher exports and unsets for main (SWITCHES, NO_MODULE_ENV, UNSET_VARS)."""
    out = [f"exports {', '.join(f'{k}={v}' for k, v in SWITCHES.items())} (no Move to background, no ← agent view)"]
    if os.environ.get(NO_MODULE_ENV, "").strip():
        out.append(f"{NO_MODULE_ENV} is set here, so the hooks module stays idle and thimble's agents cannot start")
    held = [n for n in UNSET_VARS if os.environ.get(n, "").strip()]
    out.append(f"unsets {', '.join(held)} (set here)" if held else f"would unset {', '.join(UNSET_VARS)} (none set here)")
    return "; ".join(out)


def safe_mode_line() -> str:
    """The doctor's line on Claude Code's safe mode, which turns thimble's plugin off (spike U3)."""
    if os.environ.get(SAFE_MODE_ENV, "").strip() not in ("", "0", "false"):
        return f"on ({SAFE_MODE_ENV}): Claude Code turns thimble's plugin off in the sessions it starts from here"
    return "off"


def folder_trusted(cwd: Path) -> bool | None:
    """Whether Claude Code trusts the folder `cwd`, itself or a folder above it (its global config's
    `projects.<folder>.hasTrustDialogAccepted`, claude_changes.global_config); None when that config cannot be read."""
    from . import claude_changes  # noqa: PLC0415

    try:
        projects = json.loads(claude_changes.global_config().read_text("utf-8")).get("projects")
    except (OSError, ValueError, AttributeError):
        return None
    if not isinstance(projects, dict):
        return False
    here = cwd.expanduser().resolve()
    return any(isinstance(projects.get(str(p)), dict) and projects[str(p)].get("hasTrustDialogAccepted") is True
               for p in (here, *here.parents))


def module_line(cwd: Path) -> str:
    """The doctor's line on thimble's hooks module for a session the launcher starts in `cwd`: what keeps Claude Code
    from loading it (modules_off, an untrusted folder), else what the last session here recorded (subagents.json's
    `module`: its hello, or why it stayed idle; after a terminal-mode launch, terminal_module_notes). thimble's agents
    cannot start without it."""
    why = modules_off(cwd)
    if why:
        return f"off: Claude Code's hooks modules are off ({why}), so thimble's agents cannot start in this folder"
    notes = []
    c = config.workspace_for_cwd(str(cwd))
    launch = read_launch(c)
    if launch.get("modules_off"):  # what the last launch alone could see, such as its own --settings
        return (f"off in the last launch here ({launch.get('at') or '?'}): Claude Code's hooks modules were off "
                f"({launch['modules_off']}), so thimble's agents could not start in it")
    if folder_trusted(cwd) is False:
        notes.append(f"Claude Code does not trust {cwd} yet; it asks at the first launch, and loads the module only "
                     "in a folder you trust")
    if c and launch.get("mode") == launch_mode.TERMINAL:
        return "; ".join([*terminal_module_notes(config.workspace_path(c)), *notes])
    try:
        from . import subagent_files  # noqa: PLC0415 — standard library only

        rec = (_read_json(subagent_files.state_path(config.workspace_path(c))) or {}).get("module") if c else None
    except (OSError, ValueError, KeyError, AttributeError):
        rec = None
    if isinstance(rec, dict) and rec.get("idle"):
        notes.insert(0, f"it stayed idle in the last session ({rec.get('at') or '?'}): {rec['idle']}; thimble's agents "
                        "cannot start without it")
    elif isinstance(rec, dict) and rec.get("session"):
        notes.insert(0, f"it ran in the last session (hello from {str(rec['session'])[:8]} at {rec.get('at') or '?'}"
                        + (f", version {rec['version']}" if rec.get("version") else "") + ")")
    else:
        notes.insert(0, "no session here has run it yet (it says hello when `thimble` starts main); thimble's agents "
                        "cannot start without it")
    return "; ".join(notes)


MODULE_OUT = "trusted/module.json"  # in the workspace: what the hooks module writes in terminal mode (the agents lane's)
ROLES_FILE = "trusted/roles.json"  # in the workspace: the roles the module registers in terminal mode (write_roles)


def terminal_module_notes(ws: Path) -> list[str]:
    """The module line's notes after a terminal-mode launch in workspace folder `ws`, where the module reads its roles
    from ROLES_FILE and writes its heartbeat to MODULE_OUT, and no server hears from it: its last heartbeat, with its
    version and the problem it reported, else that no session ran it; and a missing roles file."""
    try:
        out = _read_json(ws / MODULE_OUT)
    except (OSError, ValueError):
        out = None
    if isinstance(out, dict) and out.get("session"):
        beat = out.get("beat")
        if isinstance(beat, (int, float)) and not isinstance(beat, bool) and beat > 0:  # the module's milliseconds
            beat = datetime.fromtimestamp(beat / 1000, timezone.utc).isoformat(timespec="seconds")
        note = (f"it ran in the last session (terminal mode; heartbeat from {str(out['session'])[:8]} at "
                f"{beat or '?'}" + (f", version {out['version']}" if out.get("version") else "") + ")")
        notes = [note + (f"; it reported: {out['problem']}" if out.get("problem") else "")]
    else:
        notes = ["no terminal-mode session here has run it yet (it writes trusted/module.json when `thimble` starts "
                 "main); thimble's agents cannot start without it"]
    if not (ws / ROLES_FILE).is_file():
        notes.append("the last launch wrote no roles file (trusted/roles.json), so the module registers none of "
                     "thimble's agents")
    return notes


def mode_line(cwd: Path) -> str:
    """The doctor's line on the mode a session `thimble` starts in `cwd` takes (launch_mode.resolve) and where it comes
    from, with the mode the last launch here recorded when that was another."""
    mode, source = launch_mode.resolve(cwd)
    text = f"{mode} ({launch_mode.source_text(cwd, source)}; `thimble mode` changes it)"
    last = read_launch(config.workspace_for_cwd(str(cwd)))
    if last and (last.get("mode") or launch_mode.BROWSER) != mode:
        text += f"; the last launch here ({last.get('at') or '?'}) ran in {last.get('mode') or launch_mode.BROWSER} mode"
    return text


def renderer_line() -> str:
    """The doctor's line on terminal mode's renderer plugin (TERMINAL_RENDERER, renderer_problem)."""
    why = renderer_problem()
    if why:
        return f"cannot load ({why}), so terminal mode draws none of thimble's work; browser mode does not need it"
    return f"{renderer_root()} ({RENDERER_NAME}), loaded only in terminal mode"


def terminal_card_line() -> str:
    """The doctor's line on where a card's code runs in terminal mode: in main's Bash, through the card runner, inside
    Claude Code's sandbox when it can run (Seatbelt on macOS, bubblewrap and socat on Linux)."""
    from . import cc_settings  # noqa: PLC0415

    engine = "Seatbelt" if sys.platform == "darwin" else "bubblewrap and socat"
    if cc_settings.sandbox_ok():
        return f"runs in main's Bash, inside Claude Code's sandbox ({engine}): it reads the corpus and writes only the card folders"
    missing = cc_settings.sandbox_missing()
    return (f"runs in main's Bash without a sandbox, with your user's access, since Claude Code's sandbox ({engine}) "
            f"can't run here{': missing ' + ', '.join(missing) if missing else ''} (the bash sandbox line says how to fix it)")


def terminal_checks_line() -> str:
    """The doctor's line on terminal mode's card checks and screenshots, which are optional there: they draw a card in
    a headless Chromium with the built frontend (render.py), and are skipped without either."""
    spec = importlib.util.find_spec("playwright")
    which, what = _browser_choice()
    browser = which == "system" or (which != "off" and headless_fetched(
        Path(spec.origin).parent / "driver" / "package" / "browsers.json" if spec and spec.origin else Path("-")))
    lacking = ([] if browser else [f"browser ({what})" if which == "off" else "headless Chromium"]) + \
              ([] if has_ui_build() else ["frontend build"])
    if not lacking:
        return "on: a card is checked, and a screenshot drawn, with the headless Chromium and the built frontend"
    return f"off, since there is no {' and no '.join(lacking)}: cards are not checked and screenshots are not drawn"


# ----------------------------------------------------------------------------- versions and the machine
#
# What the doctor, the startup line of server.log and a failed `server up` say about the machine: the versions in play,
# free disk, who holds the port, how a session started here would hear the browser, and whether the API host answers.
# Each reader returns a short phrase and never raises, since the doctor must print even on a broken machine.

TESTED_CLAUDE_CODE = "2.1.293"  # INSTALL.md and README.md name the same version (test_cli.py)
MODS_CLAUDE_CODE = "2.1.287"  # the first Claude Code that loads plugin mods, thimble's hooks module, by default
CLAUDE_CODE_SEEN_FILE = "claude_code.json"  # in <home>: the newer Claude Codes the analyst was told about
NODE_MIN_MAJOR = 20  # custom views are built with Node 20+ (views.py)
DISK_LOW_BYTES = 1_000_000_000  # under this much free space the doctor says the disk is low
LOG_ROTATE_BYTES = 20_000_000  # a server.log past this size is moved to server.log.1 when a server starts
API_HOST = "api.anthropic.com"
NET_TIMEOUT_S = 3.0
_VERSION_RE = re.compile(r"(?<![\d.])(\d+)\.(\d+)\.(\d+)")  # `2.1.282 (Claude Code)`, Node's `v22.1.0`


def version_tuple(text: str | None) -> tuple[int, int, int] | None:
    m = _VERSION_RE.search(text or "")
    return (int(m[1]), int(m[2]), int(m[3])) if m else None


def claude_code_version() -> str | None:
    """The version `claude --version` prints (`2.1.282`), or None when claude is not on PATH or prints no version."""
    exe = config.CLI_PATH
    if not exe:
        return None
    try:
        out = subprocess.run([exe, "--version"], capture_output=True, text=True, timeout=10, env=config.launch_environ())
    except (OSError, subprocess.SubprocessError):
        return None
    v = version_tuple(out.stdout or out.stderr)
    return ".".join(map(str, v)) if v else None


TOO_OLD_LINE = ("thimble: WARNING - Claude Code {version} does not load plugin mods by default ({mods} or later does), so "
                "thimble's agents cannot start. Run `claude update`, or `claude install latest` if you follow the stable "
                "channel.")
OLDER_LINE = ("thimble: WARNING - Claude Code {version} is older than {tested}, the version thimble is tested with; if "
              "something fails, run `claude update` and start thimble again.")
NEWER_LINE = ("thimble: Claude Code {version} is newer than {tested}, the version {thimble} was tested with. If agents do "
              "not start or their chats stop updating, run `thimble doctor` and report it.")
NEWER_DOCTOR_TAIL = ("run `thimble doctor` and report it.", "report it (`thimble feedback`).")  # the doctor's own words


def _thimble_named() -> str:
    """`thimble 0.6.0`, from plugin.json (the one source a release takes its version from), or `thimble`."""
    rec = _read_json(config.REPO_ROOT / "plugin" / ".claude-plugin" / "plugin.json")
    v = str(rec.get("version") or "") if isinstance(rec, dict) else ""
    return f"thimble {v}" if v else "thimble"


def _first_told(version: str) -> bool:
    """Whether the analyst is told about this newer Claude Code for the first time on this machine, which it records in
    <home>/CLAUDE_CODE_SEEN_FILE. Never raises: a home it cannot write tells them again next time."""
    path = home() / CLAUDE_CODE_SEEN_FILE
    rec = _read_json(path)
    told = [str(v) for v in rec.get("newer_told") or []] if isinstance(rec, dict) else []
    if version in told:
        return False
    try:
        from .ledger import atomic_write_text  # noqa: PLC0415

        ensure_home()
        atomic_write_text(path, json.dumps({"newer_told": [*told, version][-20:]}, indent=1) + "\n")
    except (OSError, ValueError) as e:
        _log(f"{CLAUDE_CODE_SEEN_FILE} was not written: {e}")
    return True


TOO_OLD, OLDER, NEWER = "too old", "older", "newer"  # how a Claude Code's version stands to thimble's (claude_code_case)


def claude_code_case(version: str | None) -> str | None:
    """TOO_OLD below MODS_CLAUDE_CODE, which does not load thimble's hooks module by default, OLDER below the version
    thimble is tested with, NEWER above it; None for that version, or when `version` names none."""
    have, tested, mods = version_tuple(version), version_tuple(TESTED_CLAUDE_CODE), version_tuple(MODS_CLAUDE_CODE)
    if not (have and tested and mods) or have == tested:
        return None
    return TOO_OLD if have < mods else OLDER if have < tested else NEWER


def claude_code_warning(version: str | None, once: bool = True) -> str | None:
    """A line for the analyst about the Claude Code thimble runs with (claude_code_case), shown at launch and in
    /thimble's output; for a newer one a hint that with `once` is given once per version on this machine (_first_told).
    None for the tested version, or when its version is not known (config.auth_problem says when `claude` is missing)."""
    case = claude_code_case(version)
    if case == TOO_OLD:
        return TOO_OLD_LINE.format(version=version, mods=MODS_CLAUDE_CODE)
    if case == OLDER:
        return OLDER_LINE.format(version=version, tested=TESTED_CLAUDE_CODE)
    if case == NEWER and (not once or _first_told(str(version))):
        return NEWER_LINE.format(version=version, tested=TESTED_CLAUDE_CODE, thimble=_thimble_named())
    return None


def claude_code_line(commands: bool = True) -> str:
    """The doctor's Claude Code line: its version and what claude_code_warning says of it, the newer hint each time, in
    the doctor's own words. Without `commands` it names no command to run."""
    v = claude_code_version()
    if v is None:
        return (config.NO_CLAUDE if commands else config.NO_CLAUDE_FOUND) if not config.CLI_PATH else \
            "`claude --version` printed no version"
    case, warning = claude_code_case(v), claude_code_warning(v, once=False)
    if not warning:
        return f"{v} (thimble is tested with {TESTED_CLAUDE_CODE})"
    if commands:
        return warning.removeprefix("thimble: WARNING - ").removeprefix("thimble: ").replace(*NEWER_DOCTOR_TAIL)
    if case == TOO_OLD:
        return (f"{v}, older than {MODS_CLAUDE_CODE}, the first version that loads plugin mods by default, so thimble's "
                "agents cannot start")
    if case == OLDER:
        return f"{v}, older than {TESTED_CLAUDE_CODE}, the version thimble is tested with"
    return f"{v}, newer than {TESTED_CLAUDE_CODE}, the version {_thimble_named()} was tested with"


def _turn_endings_line() -> str:
    from . import terminal_tools  # noqa: PLC0415

    return terminal_tools.line()


NODE_TESTS_FLOOR = "20.19+, 22.13+ or 24+"  # what the frontend's tests need (install.sh's node check)


def node_runs_frontend_tests(v: tuple[int, int, int]) -> bool:
    """Whether a node of version `v` runs the frontend's tests, whose jsdom and the packages it loads require() ES
    modules: their engines (frontend/package-lock.json) are ^20.19.0 || ^22.13.0 || >=24."""
    return v[0] >= 24 or (v[0] == 22 and v[1] >= 13) or (v[0] == 20 and v[1] >= 19)


def node_line(commands: bool = True) -> str:
    """Node's version, which custom views and the sandbox runtime (app/srt.py) need, and with `commands` what to install
    when it is missing or too old. Where the frontend's tests are installed (a code ticket's vitest gate, dev.py), a node
    older than they need is a problem too."""
    exe = shutil.which("node")
    need = (f"custom views and the sandbox card code and code tickets run in need Node {NODE_MIN_MAJOR}+"
            f"{' (https://nodejs.org)' if commands else ''}; everything else works without it")
    if not exe:
        return f"not found; {need}"
    try:
        out = subprocess.run([exe, "--version"], capture_output=True, text=True, timeout=10).stdout.strip()
    except (OSError, subprocess.SubprocessError) as e:
        return f"could not run ({type(e).__name__}); {need}"
    v = version_tuple(out)
    if v and v[0] < NODE_MIN_MAJOR:
        return f"{out}, too old; {need}"
    modules = FRONTEND_DIR / "node_modules"
    fix = f"bash {config.REPO_ROOT / 'scripts' / 'install.sh'}"
    if v and (modules / ".bin" / "vitest").exists() and not node_runs_frontend_tests(v):
        return (f"{out}, older than the frontend's tests need (Node {NODE_TESTS_FLOOR}), so code tickets' vitest checks "
                "fail" + ("; upgrade Node (https://nodejs.org)" if commands else ""))
    return out + ("" if modules.is_dir() else f"; {modules} is missing, so custom views cannot build"
                  + (f" (run `{fix}` again)" if commands else ""))


def kernel_line() -> str:
    """The doctor's `card code` line: the sandbox a notebook kernel starts in where its workspace names none
    (config.resolve_kernel_wrap), and why it is not the sandbox runtime when it is not."""
    from . import srt  # noqa: PLC0415

    wrap, source = config.resolve_kernel_wrap({})
    by = f" ({config.KERNEL_WRAP_ENV})" if source == "env" else ""
    bounds = "it reads the corpus and the workspace, writes only the workspace, and keeps the network"
    if wrap == config.KERNEL_WRAP_SRT:
        engine = "Seatbelt" if sys.platform == "darwin" else "bubblewrap"
        return f"runs in Anthropic's sandbox runtime{by} ({engine}): {bounds}"
    why = "" if by else srt.missing(config.REPO_ROOT, srt.node()) or "the sandbox runtime can't run here"
    if wrap == config.KERNEL_WRAP_BWRAP:
        return f"runs in bubblewrap{by}{f' ({why})' if why else ''}: {bounds}"
    return f"runs unsandboxed, with your user's access{by}{f' ({why})' if why else ''}"


def python_line() -> str:
    """The server's Python: thimble's own backend/.venv, or the environment install.sh --python linked it to, and what
    that lacks of pyproject.toml's requirements (env_check)."""
    from . import env_check  # noqa: PLC0415

    venv = BACKEND_DIR / ".venv"
    whose = f"your environment {venv.resolve()} (install.sh --python)" if venv.is_symlink() else f"{venv}"
    lacking = env_check.missing()
    return f"{whose}, Python {platform.python_version()}" + (f"; lacks {', '.join(lacking)}" if lacking else "")


def human_bytes(n: float) -> str:
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if n < 1000 or unit == "TB":
            return f"{n:.0f} {unit}" if unit in ("B", "KB") else f"{n:.1f} {unit}"
        n /= 1000
    return f"{n:.1f} TB"


def disk_line(paths: list[Path]) -> str:
    """Free space on the filesystem of each path (the nearest existing folder), one entry per filesystem."""
    seen: dict[int, str] = {}
    for p in paths:
        q = Path(p)
        while not q.exists() and q != q.parent:
            q = q.parent
        try:
            dev = q.stat().st_dev
            free = shutil.disk_usage(q).free
        except OSError as e:
            seen.setdefault(-len(seen) - 1, f"{p}: unreadable ({e.strerror})")
            continue
        if dev in seen:
            continue
        low = "; LOW, free some space or writes will fail" if free < DISK_LOW_BYTES else ""
        seen[dev] = f"{human_bytes(free)} free at {q}{low}"
    return "; ".join(seen.values()) or "unknown"


def port_line(p: int, up: bool) -> str:
    """Who holds the server's port: thimble, nobody, or another program, named, with the way around it."""
    if up:
        return f"{p} (thimble answers there)"
    if not listening(p):
        return f"{p} (free)"
    holder = procs.listener(p)
    if holder and is_server(holder, p):
        return f"{p} is held by thimble's server (pid {holder}), which does not answer; restart it with `thimble server restart`"
    who = f"pid {holder}: {procs.cmdline(holder)[:80]}" if holder else "a process this user cannot see"
    return (f"{p} is taken by another program ({who}) and thimble cannot start there; stop that program, or start "
            "thimble on a free port with THIMBLE_PORT=<port> thimble")


def delivery_line(cwd: Path) -> str:
    """How a session the launcher starts in `cwd` would hear the browser (cc_plugin.route): the plugin's hooks, or a
    Monitor where they are off."""
    try:
        route = cc_plugin.route(cwd, plugin_root())
    except Exception as e:  # noqa: BLE001 — the doctor reports; it never fails on one of its lines
        return f"not checked ({type(e).__name__})"
    if route == cc_plugin.HOOK:
        return "the plugin's hooks"
    return "Monitor (Claude Code's settings turn the plugin's hooks off; permission prompts show only in the terminal)"


def api_host() -> str:
    base = os.environ.get("ANTHROPIC_BASE_URL") or ""
    host = urllib.parse.urlparse(base).hostname if base else None
    return host or API_HOST


def network_line(status: dict[str, Any] | None = None, timeout_s: float = NET_TIMEOUT_S) -> str:
    """Whether a TCP connection to the API host on 443 opens within `timeout_s` (a thread bounds the name lookup,
    which has no timeout of its own). Nothing is sent. Not checked for a provider other than Anthropic's API, as
    `status` (config.auth_status) names it."""
    host = api_host()
    provider = (status or {}).get("apiProvider")
    if provider and provider != "firstParty":
        return f"not checked: model calls go to {provider}"
    if in_sandbox():  # the sandbox's own network namespace has no route out, whatever the machine has
        return ("not checked: this runs inside Claude Code's Bash sandbox, which has no network (run `thimble doctor` "
                "in a terminal)")
    result: list[str] = []

    def probe() -> None:
        try:
            socket.create_connection((host, 443), timeout=timeout_s).close()
            result.append("")
        except OSError as e:
            result.append(f"{type(e).__name__}: {e}")

    t = threading.Thread(target=probe, daemon=True)
    t.start()
    t.join(timeout_s + 0.5)
    if result and not result[0]:
        return f"{host} answers"
    why = result[0] if result else f"no answer within {timeout_s:.0f} s"
    return f"cannot reach {host} ({why}); model calls fail until the network is back"


def versions_line() -> str:
    """thimble's version, Python and the OS, for the doctor and the startup line of server.log."""
    rel = release_line()
    if rel:
        ver = rel
    elif is_git_checkout():
        ver = f"git {git_branch()} @ {_git('rev-parse', '--short', 'HEAD') or '?'}"
    else:
        ver = "unknown"
    return f"thimble {ver}; Python {platform.python_version()}; {platform.platform()}"


def rotate_log(p: Path, limit: int = LOG_ROTATE_BYTES) -> bool:
    """Move a log past `limit` bytes to <name>.1 (replacing the one before), so a long-lived install does not fill its
    disk with one file. Called before a server starts, never under a running one."""
    try:
        if p.stat().st_size <= limit:
            return False
        p.replace(p.with_name(p.name + ".1"))
        return True
    except OSError:
        return False


def failure_text(e: BaseException) -> str | None:
    """The plain cause of an error a full or read-only disk raised, naming the path; None for any other error."""
    if not isinstance(e, OSError):
        return None
    where = e.filename or str(home())
    if e.errno in (errno.ENOSPC, errno.EDQUOT):
        return f"the disk that holds {where} is full; free some space, then try again"
    if e.errno in (errno.EACCES, errno.EPERM, errno.EROFS):
        return f"cannot write {where} ({e.strerror})"
    return None


def _checked(fn, *args) -> str:
    """One of the doctor's machine lines, or what stopped it: the doctor prints whatever else it can."""
    try:
        return fn(*args)
    except Exception as e:  # noqa: BLE001
        return f"not checked ({type(e).__name__}: {e})"


def validation_ports() -> tuple[int, int]:
    """The dev agent's validation stack's API and UI ports, as scripts/dev/dev_stack.sh and dev.py read them."""
    out = []
    for name, default in zip(("THIMBLE_STACK_PORT", "THIMBLE_STACK_UI_PORT"), VALIDATION_PORTS):
        v = (os.environ.get(name) or "").strip()
        out.append(int(v) if v.isdigit() else default)
    return out[0], out[1]


# feedback.doctor_summary reads the server, auth, network and card harness lines and the recent errors line by their
# labels, for the one line a problem report's new issue carries.
def extensions_line() -> str:
    from . import extensions  # noqa: PLC0415

    return extensions.doctor_line()


def doctor_text(commands: bool = True) -> str:
    """What `thimble doctor` prints. Without `commands` its lines name no command that installs anything, for a model
    to read (`thimble fix`, `/thimble fix`). The lines only a developer of thimble reads (turn endings, source changed
    since start, the validation stack, the last apply, the dev tickets and their last error) are printed only in a
    development install."""
    st = read_state()
    env = resolve_env()
    p = int(st.get("port") or port())
    url = api_url(p)
    up = healthy(url)
    pid = st.get("pid")
    lines = ["thimble doctor"]
    lines.append(f"  versions: {_checked(versions_line)}")
    lines.append(f"  claude code: {_checked(claude_code_line, commands)}")
    dev = is_git_checkout()  # a development install, the only one whose doctor prints the developer's lines
    if dev:
        lines.append(f"  turn endings: {_checked(_turn_endings_line)}")
    lines.append(f"  node: {_checked(node_line, commands)}")
    lines.append(f"  python: {_checked(python_line)}")
    port_text = _checked(port_line, p, up)
    lines.append(f"  port: {port_text}")
    stuck = None if up or "thimble server restart" in port_text else _checked(stuck_server, url)
    lines.append(f"  server: {'up' if up else 'down'} at {url}; pid {pid or '-'} "
                 f"({'alive' if pid_alive(pid) else 'gone'}); started {st.get('started') or '-'}"
                 + (f"; stopped {st['stopped']}" if st.get("stopped") else "")
                 + (f"; {STUCK_LINE.format(pid=stuck)}" if isinstance(stuck, int) else ""))
    ui = int(st.get("ui_port") or ui_port())
    if env["dev"]:
        lines.append(f"  ui: http://127.0.0.1:{ui} (Vite, {'listening' if listening(ui) else 'not listening'}); dev mode on")
    elif has_ui_build():
        lines.append(f"  ui: {url} (the built UI at {config.FRONTEND_DIST}); dev mode off")
    else:
        lines.append(f"  ui: {config.NO_UI_BUILD_HINT}; dev mode off")
    if dev:
        dirty = _git("status", "--porcelain")
        lines.append(f"  repo: {config.REPO_ROOT} (branch {git_branch()} @ {_git('rev-parse', '--short', 'HEAD') or '?'}, "
                     f"{len(dirty.splitlines())} uncommitted paths)")
    else:
        rel = release_line()
        lines.append(f"  repo: {config.REPO_ROOT} (not a git checkout{'; ' + rel if rel else ''})")
    if dev:
        lines.append(f"  source changed since start: {source_changed_text(st, up)}")
    lines.append(f"  home: {home()} ({'THIMBLE_HOME' if os.environ.get('THIMBLE_HOME') else 'default'}); "
                 f"server.json {'present' if server_json().is_file() else 'absent'}")
    recorded = (st.get("env") or {}).get("data_dir")
    data_src = "THIMBLE_DATA_DIR" if os.environ.get("THIMBLE_DATA_DIR") else "server.json" if recorded else "default $THIMBLE_HOME/data"
    lines.append(f"  data_dir: {env['data_dir']} ({'exists' if Path(env['data_dir']).is_dir() else 'missing'}; {data_src})")
    lines.append(f"  workspaces_dir: {env['workspaces_dir']} ({'exists' if Path(env['workspaces_dir']).is_dir() else 'missing'})")
    lines.append(f"  disk: {_checked(disk_line, [home(), Path(env['workspaces_dir'])])}")
    status = config.auth_status()
    lines.append(f"  auth: {auth_line(status)}")
    lines.append(f"  network: {_checked(network_line, status)}")
    caller = Path(os.environ.get("THIMBLE_CALLER_CWD") or os.getcwd())
    lines.append(f"  delivery (a session `thimble` starts in {caller}): {_checked(delivery_line, caller)}")
    lines.append(f"  your session's bash sandbox: {_checked(own_sandbox_line, caller)}")
    with server_dirs():
        lines.append(f"  main's fence (a session `thimble` starts in {caller}): {_checked(fence_line, caller)}")
        lines.append(f"  launch switches: {_checked(switches_line)}")
        lines.append(f"  safe mode: {_checked(safe_mode_line)}")
        lines.append(f"  hooks module (thimble's agents start through it): {_checked(module_line, caller)}")
        lines.append(f"  mode (a session `thimble` starts in {caller}): {_checked(mode_line, caller)}")
        lines.append(f"  terminal renderer: {_checked(renderer_line)}")
        if launch_mode.resolve(caller)[0] == launch_mode.TERMINAL:
            lines.append(f"  terminal mode's card code: {_checked(terminal_card_line)}")
            lines.append(f"  terminal mode's card checks (optional): {_checked(terminal_checks_line)}")
    lines.append(f"  config: {_checked(config_line, Path(env['workspaces_dir']))}")
    lines.append(f"  browser: {_checked(browser_line)}")
    lines.append(f"  card code: {_checked(kernel_line)}")
    lines.append(f"  card harness: {harness_line(url, up, commands)}")
    lines.append(f"  views and screenshots: {_checked(pages_line, commands)}")
    lines += sandbox_lines(commands)
    lines.append(f"  extensions: {_checked(extensions_line)}")
    if dev:
        lines.append("  validation stack: "
                     + ", ".join(f"{q} {'busy' if listening(q) else 'free'}" for q in validation_ports())
                     + f"; env from server.json: {'yes' if st.get('env') else 'no (defaults)'}")
        la = _last_jsonl(dev_dir() / "applies.jsonl")
        # the last line of applies.jsonl is an apply or a revert (a rollback by the restart watch among them)
        lines.append("  last apply: " + (f"{la.get('ts')} {la.get('kind') or 'apply'} {la.get('title')!r} "
                                         f"{str(la.get('commit') or '')[:7]}{' (' + str(la['why']) + ')' if la.get('why') else ''}"
                                         if la else "none"))
        lines.append(f"  dev tickets: {tickets_line()}")
        lines.append(f"  last ticket error: {_last_ticket_error()}")
    # the log's lines come last, so a problem report sent without the logs cuts them all (feedback.DOCTOR_LOG_MARK)
    lines.append(f"  log tail ({log_path()}):")
    recent = _log_lines(LOG_SCAN_BYTES)
    errors = [ln for ln in recent or [] if _ERROR_LINE.search(ln)][-LOG_ERRORS:]
    tail = recent[-LOG_TAIL:] if recent is not None else ["(no log yet)"]
    if not commands:
        tail, errors = ([LOG_LINE_LEFT_OUT if _INSTALL_COMMAND.search(ln) else ln for ln in part] for part in (tail, errors))
    lines += [f"    {ln}" for ln in tail]
    lines.append(f"  recent errors in the log ({len(errors)} of its last {human_bytes(LOG_SCAN_BYTES)}):"
                 if errors else f"  recent errors in the log: none in its last {human_bytes(LOG_SCAN_BYTES)}")
    lines += [f"    {ln[:400]}" for ln in errors]
    return "\n".join(lines)


# a log line that names a command installing software, which the doctor for a model leaves out
_INSTALL_COMMAND = re.compile(r"\b(apt(-get)?|brew|dnf|yum|pacman|apk|snap|port|pipx?|pip3|npm|pnpm|yarn|playwright|gem|cargo)"
                              r" +(install|ci|add|i)\b|\buv +(pip|sync|add|tool)\b|install-deps|\binstall\.sh\b|\bsudo +\S"
                              r"|`thimble doctor`|\b(curl|wget)\b[^|]*\| *(ba|z)?sh\b", re.I)
LOG_LINE_LEFT_OUT = "(a line that names an install command, left out here)"
LOG_SCAN_BYTES = 2_000_000  # how far back from its end the doctor reads the server log
LOG_ERRORS = 8  # the most recent error lines it lists
# a thimble logger's ERROR or CRITICAL line, uvicorn's `ERROR:` line, or the last line of a traceback
_ERROR_LINE = re.compile(r"^\S+ \S+ (ERROR|CRITICAL) |^(\S+ \S+ )?ERROR: |^[A-Za-z_][\w.]*(Error|Exception)\b: ")


def _log_lines(limit: int) -> list[str] | None:
    """The server log's lines in its last `limit` bytes (the first, cut line dropped); None when there is no log."""
    try:
        with log_path().open("rb") as f:
            size = f.seek(0, os.SEEK_END)
            f.seek(max(0, size - limit))
            raw = f.read()
    except OSError:
        return None
    lines = raw.decode("utf-8", "replace").splitlines()
    return lines[1:] if size > limit else lines


# ----------------------------------------------------------------------------- fix / revert / restart


def restart(*, keep_vite: bool = False) -> list[str]:
    """Stop (the backend only with `keep_vite`; the kernels stay for the new server to reconnect), start, announce."""
    lines = stop(vite=not keep_vite, kernels=False)
    _leave_restart_reason(MANUAL_RESTART)
    with lock():
        if not healthy():
            start()
        up = wait_healthy(api_url(), WAIT_S)
    lines.append(f"server {'up' if up else 'did not come up'} at {api_url()}")
    if up:
        _request("POST", f"{api_url()}/api/dev/announce", {}, timeout=10.0)
    return lines


FIX_NO_TERMINAL = ("thimble fix did not run: it asks you before its change reaches thimble's own code, and only in a "
                   "terminal. Run `thimble fix` in your own terminal.")
FIX_DECLINED = "thimble fix did not run: you did not allow it."


def fix_refusal() -> str:
    """'' when `thimble fix` may start, else why it did not: it needs a terminal to ask in, and where its ticket is not
    contained (dev.fix_contained) the analyst's Allow before it starts (dev.CODE_QUESTION)."""
    from . import dev  # noqa: PLC0415

    if not sys.stdin.isatty():
        return FIX_NO_TERMINAL
    if dev.fix_contained():
        return ""
    try:
        answer = input(f"thimble fix: {dev.CODE_QUESTION} [y/N] ")
    except EOFError:
        answer = ""
    return "" if answer.strip().lower() in ("y", "yes") else FIX_DECLINED


async def fix_approve(_t: dict[str, Any], touched: list[str]) -> bool:
    """The terminal's y/N before `thimble fix`'s change is applied (dev.APPLY_QUESTION)."""
    import asyncio  # noqa: PLC0415

    from . import dev  # noqa: PLC0415

    try:
        answer = await asyncio.to_thread(input, f"thimble fix: {dev.APPLY_QUESTION} It changes "
                                                f"{dev.files_words(touched)}. [y/N] ")
    except EOFError:
        answer = ""
    return answer.strip().lower() in ("y", "yes")


def fix() -> str:
    """Server down: the ticket runner on prompts/dev-fix.md in the live checkout, once fix_refusal passed; its change is
    applied on the analyst's yes (fix_approve). `dev` is imported lazily."""
    import asyncio  # noqa: PLC0415

    from . import dev  # noqa: PLC0415

    return asyncio.run(dev.fix_offline(doctor_text(commands=False), fix_approve))


def revert() -> dict[str, Any]:
    """Revert the last dev apply: through the server when it answers (POST /api/dev/revert, which restarts it when the
    change needs that), else in the checkout here. dev.revert_last_apply's answer, with `error` for a refusal."""
    url = api_url()
    if healthy(url):
        status, body = _request("POST", f"{url}/api/dev/revert", {}, timeout=60.0)
        if isinstance(body, dict) and status == 200:
            return body
        detail = body.get("detail") if isinstance(body, dict) else body
        return {"ok": False, "error": str(detail or f"the server answered {status}")[:300]}
    from . import dev  # noqa: PLC0415

    res = dev.revert_last_apply()
    # with the server down nothing rebuilds the served UI after a revert of a frontend change, so it is done here
    if res.get("ok") and dev.needs_ui_build([str(p) for p in res.get("touched") or []]) and dev.serves_built_ui():
        script = dev.rebuild_ui_script()
        try:
            done = subprocess.run(["bash", str(script), "--frontend", str(FRONTEND_DIR), "--skip-typecheck"],
                                  cwd=str(config.REPO_ROOT), capture_output=True, text=True, timeout=dev.UI_BUILD_TIMEOUT_S)
            res["ui_build"] = "built" if done.returncode == 0 else f"failed: {(done.stderr or done.stdout)[-300:]}"
        except (OSError, subprocess.SubprocessError) as e:
            res["ui_build"] = f"failed: {e}"
    return res


def revert_lines(res: dict[str, Any]) -> list[str]:
    """What `thimble revert` prints for revert()'s answer."""
    if not res.get("ok"):
        why = str(res.get("error") or "the revert failed")
        return ["thimble: nothing to revert" if why == "nothing to revert" else f"thimble: could not revert: {why}"]
    lines = [REVERTED_LINE.format(title=res.get("title") or "the last change", commit=str(res.get("commit") or "")[:7])]
    ui = str(res.get("ui_build") or "")
    if ui.startswith("failed"):
        lines.append(f"thimble: the UI could not be rebuilt ({ui.removeprefix('failed: ')[:200]})")
    restart = {"restarting": "the server restarts with it", "restart_pending": "the server restarts with it once "
               "thimble's agents end", "manual": "restart the server to load it: thimble server restart"}.get(
                   str(res.get("restart") or ""))
    if restart:
        lines.append(f"thimble: {restart}")
    return lines


# ----------------------------------------------------------------------------- commands


def refused(cwd: Path) -> bool:
    """Whether `up` refuses `cwd` as a workspace: the analyst's home directory or the filesystem root."""
    try:
        p = cwd.expanduser().resolve()
    except (OSError, RuntimeError):
        return False
    return p == Path(p.anchor) or p == Path.home().resolve()


def registrable(cwd: Path, session_id: str | None) -> bool:
    """Whether `up` may register `cwd` as a new corpus: a session's /thimble (`--session`) may, whatever the folder
    holds; a bare `thimble server up` from a shell registers nothing."""
    return bool(session_id)


def hook_result_path(session: str) -> Path | None:
    """<home>/up/<session>.json, the session id kept to letters, digits, `-` and `_`; None for an id with none."""
    name = "".join(ch for ch in session if ch.isalnum() or ch in "-_")
    return home() / HOOK_RESULTS_DIR / f"{name}.json" if name else None


def hook_up(raw: str) -> int:
    """`server up --hook`, /thimble's UserPromptExpansion hook (module note, the Bash sandbox): `up` for the hook's
    session, folder and arguments, with what it prints kept for the skill's `up` (take_hook_result). It prints nothing,
    since a hook's output would reach the model beside the skill's."""
    try:
        hook = json.loads(raw)
    except ValueError:
        return 0
    path = hook_result_path(str(hook.get("session_id") or "")) if isinstance(hook, dict) else None
    if path is None:
        return 0
    args = str(hook.get("command_args") or "")
    try:
        words = shlex.split(args)
    except ValueError:
        words = args.split()
    action, archive = (words + ["", ""])[:2]
    cwd = os.environ.get("CLAUDE_PROJECT_DIR") or str(hook.get("cwd") or "") or os.getcwd()
    path.unlink(missing_ok=True)
    out = io.StringIO()
    with redirect_stdout(out):
        cmd_server_up(argparse.Namespace(cwd=cwd, session=str(hook["session_id"]), action=action, archive=archive))
    config.private_dir(path.parent)
    fd, tmp = tempfile.mkstemp(prefix=".up.", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump({"cwd": cwd, "action": action, "archive": archive, "at": time.time(), "text": out.getvalue()}, f)
        os.replace(tmp, path)
    finally:
        Path(tmp).unlink(missing_ok=True)
    return 0


def take_hook_result(session: str, cwd: Path, action: str, archive: str) -> str | None:
    """What the hook's `up` printed for this /thimble: the result it left for `session` within HOOK_RESULT_S, for the
    same folder and arguments, removed once read where the file can be removed; None when there is none."""
    path = hook_result_path(session)
    try:
        result = json.loads(path.read_text("utf-8")) if path else None
        fresh = 0 <= time.time() - float(result.get("at") or 0) <= HOOK_RESULT_S
        same = (Path(str(result.get("cwd"))).resolve() == cwd.resolve() and result.get("action") == action
                and result.get("archive") == archive and isinstance(result.get("text"), str))
    except (OSError, RuntimeError, ValueError, TypeError, AttributeError):
        return None
    if not (fresh and same):
        return None
    with suppress(OSError):  # the sandbox mounts <home> read-only; the next hook removes it
        path.unlink()
    return result["text"]


def terminal_session(cwd: Path, session: str | None) -> bool:
    """Whether this command runs for a session the launcher started in terminal mode: launch_mode.ENV says so (the
    launcher exports it, and main's --settings `env` carries it), or the workspace of `cwd` records terminal mode for
    `session` itself in launch.json, for a session that lost both."""
    if os.environ.get(launch_mode.ENV) == launch_mode.TERMINAL:
        return True
    if not session:
        return False
    with server_dirs():
        rec = read_launch(config.workspace_for_cwd(str(cwd)))
    return rec.get("mode") == launch_mode.TERMINAL and str(rec.get("session") or "") == session


def terminal_home_line() -> str:
    """What /thimble prints in terminal mode: the TERMINAL_HOME_HINT section of prompts/tools.md, else
    TERMINAL_HOME_LINE."""
    try:
        from . import tools  # noqa: PLC0415 — the hints, needed here alone

        return tools.hint(TERMINAL_HOME_HINT).strip() or TERMINAL_HOME_LINE
    except Exception:  # noqa: BLE001 — never a traceback in the skill text
        return TERMINAL_HOME_LINE


def cmd_ensure(args: argparse.Namespace) -> int:
    cwd = Path(args.cwd or os.environ.get("THIMBLE_CALLER_CWD") or os.getcwd())
    if args.session:
        text = take_hook_result(str(args.session), cwd, args.action or "", args.archive or "")
        if text is not None:
            sys.stdout.write(text)
            return 0
    action = ALIASES.get((args.action or "").strip(), (args.action or "").strip())
    if action == "uninstall":
        print(UNINSTALL_SHELL_LINE)
        return 0
    if action == FEEDBACK:  # /thimble feedback: the report needs no server (plugin/bin/thimble runs it before this)
        from . import feedback  # noqa: PLC0415

        return feedback.run("", cwd=cwd, skill=True)
    if terminal_session(cwd, args.session):  # no server in terminal mode: the renderer's panel
        print(terminal_home_line() if action in ("", "on", "status") else TERMINAL_ACTION_LINE.format(action=action))
        return 0
    if args.session and action in OPENING and not refused(cwd):  # one mode per workspace at a time
        with server_dirs():
            c = config.workspace_for_cwd(str(cwd))
            elsewhere = open_elsewhere(c, launch_mode.BROWSER) if c else None
        if elsewhere:
            print(elsewhere)
            return 0
    if refused(cwd) and action != "status":  # $HOME or / as a corpus would index the analyst's whole machine
        print(REFUSED_LINE.format(path=cwd))
        return 0
    if in_sandbox():  # a server started here would die with the command, and the host's is out of reach
        print(fenced_sandbox_line(cwd, (args.action or "").strip(), (getattr(args, "archive", None) or "").strip())
              or sandbox_line(cwd))
        return 0
    ensure_home()
    env = resolve_env()
    data_dir = Path(env["data_dir"])
    url = api_url()
    if refuse_foreign(url):  # another install's server on the port: its workspaces and code are not this install's
        return 0
    if action == "status":
        print(status_line(workspace_for(cwd, data_dir, None)))
        return 0
    archive = (getattr(args, "archive", None) or "").strip()
    listing = action == RESUME and not archive  # `/thimble restore` alone lists the archives and opens nothing
    NOTICES.clear()
    LAST_START.clear()
    try:
        up = ensure_running(WAIT_S)
    except TimeoutError as e:
        _log(str(e))
        up = healthy(url)
    notices = list(NOTICES)
    NOTICES.clear()
    may_register = up and registrable(cwd, args.session)
    name, opened = open_workspace(cwd, data_dir, url if may_register else None, here=bool(args.session))
    if name is None and up:
        _log(f"{cwd} was not registered (a bare `up` registers nothing; a session's /thimble registers its folder)")
    if action not in OPENING:
        return _action(args, up, url)
    if not up:
        why = start_failure(url)
        _log(f"server up: no server answers at {url}" + (f" ({why})" if why else ""))
        print(f"thimble: no server answers: {why}; see {log_path()}" if why else
              f"thimble: the server did not start within {WAIT_S:.0f} s; see {log_path()}")
        print("Say `/thimble` again once that is fixed, or run `thimble doctor` in a shell.")
        print(REPORT_LINE)
        return 0
    if listing:
        found = list_archives(url, name) if name else []
        if found is None:
            print(f"thimble: could not list the archived runs; see {log_path()}")
        else:
            print(ARCHIVES_LINE.format(names=", ".join(found)) if found else NO_ARCHIVES_LINE)
        return 0
    mark: list[str] = []
    given = ""  # the pre-cache's context, for a session new to a workspace installed from one (precached_context)
    if may_register and name is None:
        print(REGISTER_FAILED_LINE.format(path=cwd, log=log_path()))
    else:
        if action == FRESH:
            ok, archived = archive_workspace(url, name) if name else (True, None)
            second = [(FRESH_LINE.format(cwd=cwd, path=archived, name=Path(archived).name) if archived else
                       NOTHING_ARCHIVED_LINE) if ok else ARCHIVE_FAILED_LINE.format(log=log_path())]
        elif action == RESUME:
            second = resume_lines(url, name, archive)
        else:
            given = precached_context(url, name, str(args.session)) if name and args.session else ""
            second = [PRECACHED_LINE] if given else [RESUME_LINE] if not opened and resumes(url, name) else []
        # a plain `claude`: the warning goes under the link too, which the Stop hook shows whatever main's reply holds
        unfenced = bool(args.session) and not launched() and not fenced_here(cwd)
        # with the plugin's hooks off no Stop hook shows the link, so the page opens without the key
        if (args.session and not cc_plugin.hooks_blocked(cwd, plugin_root())
                and leave_link(str(args.session), ui_url(name), [UNFENCED_LINE] if unfenced else [])):
            print(LINK_LINE)
        else:
            print(f"thimble: {ui_url(name, key=not args.session and to_terminal())}")
        for line in second:
            print(line)
        if unfenced:
            print(UNFENCED_LINE)
        status = config.auth_status(cwd=cwd)
        if args.session:
            lines = monitor_lines(cwd, str(args.session))
            mark = [ln for ln in lines if ln.startswith(MONITOR_MARK)]
            for line in lines:
                if line not in mark:
                    print(line)
        if name and args.session:
            replaced = name_session(url, name, str(args.session), cwd)
            if replaced:
                print(TAKEOVER_LINE.format(other=replaced[:8]))
        if not env["dev"] and not has_ui_build():
            _log(config.NO_UI_BUILD_HINT)
            print(NO_UI_LINE)
        problem = config.auth_problem(status)
        if problem:
            print(NO_AUTH_LINE.format(problem=problem))
        if args.session:
            warning = claude_code_warning(claude_code_version())
            if warning:
                print(warning)
    for line in notices + mark:
        print(line)
    if given:
        print("")
        print(given)
    return 0


def _action(args: argparse.Namespace, up: bool, url: str) -> int:
    a = args.action
    if a in ("fix", "repair"):
        if not is_git_checkout():
            print(DEV_ONLY_LINES["fix"])
            return 0
        if up:
            print(doctor_text(commands=False))
            print(FIX_INSTRUCTION)
            return 0
        if refused := fix_refusal():
            print(refused)
            return 0
        try:
            result = fix()
        except Exception as e:  # noqa: BLE001 — never a traceback in the skill text
            result = f"fix failed: {type(e).__name__}: {e}"
        for ln in restart():
            print(ln)
        print(result[:1000])
        return 0
    print(f"thimble: unknown action {a!r}; one of status, fix, fresh, restore, feedback.")
    return 0


def ask_first(args: argparse.Namespace, back: str, question: str, unasked: str, declined: str) -> bool:
    """Whether a stop or a restart goes on: at once with `--yes` or when nothing runs; else after naming what runs and `back`,
    what comes back by itself, when the terminal answers `question` yes."""
    url = api_url()
    work = running_work(url) if not getattr(args, "yes", False) and healthy(url) else []
    if not work:
        return True
    print(RUNNING_HEAD)
    for ln in work:
        print(f"  {ln}")
    print(back)
    answer = confirm(question)
    if not answer:
        print(unasked if answer is None else declined)
        return False
    return True


def cmd_stop(args: argparse.Namespace) -> int:
    """`thimble stop`: names what the stop would interrupt and asks first, unless `--yes`."""
    if not ask_first(args, STOP_BACK_LINE, STOP_QUESTION, STOP_UNASKED_LINE, STOP_DECLINED_LINE):
        return 1
    for ln in stop():
        print(ln)
    return 0


def cmd_restart(args: argparse.Namespace) -> int:
    """`thimble restart`: names what a restart would interrupt and asks first, unless `--yes`."""
    if refuse_foreign():
        return 1
    if not ask_first(args, RUNNING_BACK_LINE, RESTART_QUESTION, RESTART_UNASKED_LINE, RESTART_DECLINED_LINE):
        return 1
    for ln in restart(keep_vite=bool(getattr(args, "keep_vite", False))):
        print(ln)
    return 0 if healthy() else 1


def ship_extensions() -> None:
    """The extensions thimble ships added on its first run (extensions.ship); a failure is said, never raised."""
    from . import extensions  # noqa: PLC0415

    try:
        extensions.ship()
    except Exception as e:  # noqa: BLE001 — the extensions stay as they were
        print(f"thimble: the extensions thimble ships were not added: {type(e).__name__}: {e}", file=sys.stderr)


def cmd_doctor(_: argparse.Namespace) -> int:
    ship_extensions()
    print(doctor_text())
    return 0


def cmd_fix(_: argparse.Namespace) -> int:
    if not is_git_checkout():
        print(DEV_ONLY_LINES["fix"])
        return 1
    if healthy():
        print(doctor_text())
        print(FIX_INSTRUCTION)
        return 0
    if refused := fix_refusal():
        print(refused)
        return 1
    result = fix()
    for ln in restart():
        print(ln)
    print(result[:2000])
    return 0 if healthy() else 1


def cmd_revert(_: argparse.Namespace) -> int:
    """`thimble revert`. With the server down the revert happens in the checkout, and the server is started only when
    a change was taken back, since that change may be what kept it from starting. Only in a development install."""
    if not is_git_checkout():
        print(DEV_ONLY_LINES["revert"])
        return 1
    res = revert()
    for ln in revert_lines(res):
        print(ln)
    if res.get("ok") and not healthy():
        for ln in restart():
            print(ln)
    return 0 if res.get("ok") else 1


# ----------------------------------------------------------------------------- update (INSTALL.md "Update")

RELEASE_ZIP_PATTERN = "thimble-*.zip"
RELEASE_SUMS = "SHA256SUMS"  # the release's digests, which update.sh checks the zip against
DOWNLOAD_TIMEOUT_S = 600.0
UPDATE_NO_GH_LINE = ("thimble update: could not download the latest release of {repo}: the GitHub CLI (gh) is not installed "
                     "(https://cli.github.com).")
UPDATE_FROM_LINE = "Download it from {url} and run: thimble update --from <path to thimble-*.zip>"
# gh answers "release not found" for three different causes, since GitHub returns 404 to all of them: the repo has no
# published release (a pre-release does not count as the latest), the account cannot see the repo, or gh is not logged
# in and the repo is private. download_release asks gh which one it is, so each gets its own line.
UPDATE_FAILED_LINES = {
    "no-gh": (UPDATE_NO_GH_LINE, UPDATE_FROM_LINE),
    "no-release": ("thimble update: {repo} has no published release yet (gh: release not found).",
                   "If you were sent a release zip, run: thimble update --from <path to thimble-*.zip>"),
    "no-login": ("thimble update: gh is not logged in, so it cannot download releases of {repo}. Run `gh auth login`, "
                 "then thimble update again.",
                 "Or, with a release zip: thimble update --from <path to thimble-*.zip>"),
    "no-access": ("thimble update: the GitHub account gh is logged in as cannot see {repo}. Check `gh auth status`.",
                  "Or, with a release zip: thimble update --from <path to thimble-*.zip>"),
    "failed": ("thimble update: could not download the latest release of {repo} with gh ({detail}).",
               UPDATE_FROM_LINE),
    "no-sums": ("thimble update: the latest release of {repo} has no SHA256SUMS, so the downloaded zip cannot be "
                "checked; nothing was installed.", UPDATE_FROM_LINE),
}


def release_repo() -> str:
    """The `owner/name` slug the releases live on: RELEASE.json's `repo` when the install carries one, else the
    `repository` of plugin.json (feedback.repo_slug, which the problem report uses as well)."""
    from . import feedback  # noqa: PLC0415 — imported lazily, as for `thimble feedback`

    return feedback.repo_slug(config.REPO_ROOT)


def releases_url(repo: str | None = None) -> str:
    return f"https://github.com/{repo or release_repo()}/releases/latest"


def update_script() -> Path:
    return config.REPO_ROOT / "scripts" / "update.sh"


# install.sh's answers to its questions, --plugin and --no-plugin, --no-modify-path and --modify-path, and
# --require-pinned, which `thimble update` passes on to it through update.sh; --trust-workspaces and
# --no-trust-workspaces, 0.5.0's, are passed on too for this release, and install.sh ignores them with a line that says so
INSTALL_FLAGS = ("--sandbox-deps", "--no-sandbox-deps", "--plugin", "--no-plugin", "--no-modify-path", "--modify-path",
                 "--trust-workspaces", "--no-trust-workspaces", "--require-pinned")


def _gh_ok(gh: str, *args: str) -> bool:
    """True when `gh args` exits 0; False when it fails, times out or cannot start."""
    try:
        return subprocess.run([gh, *args], capture_output=True, text=True, timeout=60).returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


def download_release(repo: str, into: Path) -> tuple[Path | None, str, str]:
    """`gh release download` of the latest release's zip and its SHA256SUMS into `into`: (the zip, "", "") on success,
    else (None, the cause, a detail). The cause is a key of UPDATE_FAILED_LINES; the detail is gh's first error line, for
    the "failed" line."""
    gh = shutil.which("gh")
    if not gh:
        return None, "no-gh", ""
    cmd = [gh, "release", "download", "--repo", repo, "--pattern", RELEASE_ZIP_PATTERN, "--pattern", RELEASE_SUMS,
           "--dir", str(into)]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=DOWNLOAD_TIMEOUT_S)
    except (OSError, subprocess.TimeoutExpired) as e:
        _log(f"gh release download failed: {type(e).__name__}: {e}")
        return None, "failed", type(e).__name__
    if r.returncode != 0:
        err = (r.stderr or "").strip()
        _log(f"gh release download failed ({r.returncode}): {err[:300]}")
        if "release not found" in err.lower():
            # the repo's host alone, since `gh auth status` without one fails when the token of any host it knows is bad
            host = repo.split("/")[0] if repo.count("/") == 2 else "github.com"
            if not _gh_ok(gh, "auth", "status", "--hostname", host):
                return None, "no-login", ""
            if not _gh_ok(gh, "repo", "view", repo, "--json", "name"):
                return None, "no-access", ""
            return None, "no-release", ""
        return None, "failed", (err.splitlines() or [f"exit code {r.returncode}"])[0][:200]
    zips = sorted(into.glob(RELEASE_ZIP_PATTERN))
    if not zips:
        return None, "failed", f"no {RELEASE_ZIP_PATTERN} in the release"
    if not (into / RELEASE_SUMS).is_file():
        return None, "no-sums", ""
    return zips[-1], "", ""


def run_update_script(*args: str) -> int:
    """scripts/update.sh of this tree with `args`; its output passes through, its exit code is returned."""
    return subprocess.call(["bash", str(update_script()), *args])


def cmd_update(args: argparse.Namespace) -> int:
    """`thimble update [--from <zip>] [--dry-run]`: --from hands the zip to update.sh; no argument downloads the latest
    release and its SHA256SUMS with gh, and update.sh checks the zip against it; a checkout skips the download
    (update.sh pulls). When the download fails: two lines naming the cause and the --from form, and exit 1."""
    extra = ["--dry-run"] if getattr(args, "dry_run", False) else []
    extra += ["--browser", args.browser] if getattr(args, "browser", None) else []
    extra += getattr(args, "install_flags", None) or []
    if getattr(args, "from_", None):
        return run_update_script("--from", args.from_, *extra)
    if is_git_checkout():
        return run_update_script(*extra)
    repo = release_repo()
    with tempfile.TemporaryDirectory(prefix="thimble-update-") as tmp:
        zip_path, cause, detail = download_release(repo, Path(tmp))
        if zip_path is None:
            first, second = UPDATE_FAILED_LINES[cause]
            print(first.format(repo=repo, detail=detail))
            print(second.format(url=releases_url(repo)))
            return 1
        print(f"thimble update: downloaded {zip_path.name}")
        return run_update_script("--from", str(zip_path), "--sums", str(Path(tmp) / RELEASE_SUMS), *extra)


# ----------------------------------------------------------------------------- the `server` group

SERVER_UP_ALIASES = ("ensure",)


def cmd_feedback(args: argparse.Namespace) -> int:
    """The problem report for the workspace of the folder this runs in (feedback.run). plugin/bin/thimble runs
    feedback.py directly rather than this, so a report can be made while this module fails to import."""
    from . import feedback  # noqa: PLC0415

    cwd = Path(os.environ.get("THIMBLE_CALLER_CWD") or os.getcwd())
    return feedback.run(" ".join(args.description), cwd=cwd, logs=not args.no_logs)


ORIENT_HINT = ("{name} {does}. Where an orientation already ran, Settings > Extensions asks whether to run it there "
               "now.")


def orient_hint(name: str, program: bool) -> str:
    """The line `add` and `on` print for an extension that changes the orientation (extensions.orients): `program`
    when its own program runs the orientation."""
    does = "runs the orientation with its own program" if program else "adds to the orientation"
    return ORIENT_HINT.format(name=name, does=does)


def cmd_extension(args: argparse.Namespace) -> int:
    """`thimble extension add | on | off | list | remove`, then every workspace a session has open finds its extensions
    again. The old name of a built-in thimble renamed names the new one (extensions.renamed)."""
    from . import extensions  # noqa: PLC0415

    def now_called(name: str) -> str:
        new = extensions.renamed(name)
        if new != name:
            print(f"{name} is now called {new}.")
        return new

    ship_extensions()
    workspaces = Path(resolve_env()["workspaces_dir"])
    if getattr(args, "name", None):
        args.name = now_called(args.name)
    if args.ext_cmd == "add" and not Path(args.source).expanduser().exists():
        args.source = now_called(args.source)
    if args.ext_cmd == "list":
        for ln in extensions.list_lines(workspaces):
            print(ln)
        return 0
    if args.ext_cmd == "add":
        if not args.yes and not sys.stdin.isatty():
            print("thimble extension add: run it in a terminal to answer its question, or pass --yes", file=sys.stderr)
            return 1
        try:
            names = extensions.add(args.source, yes=args.yes)
        except extensions.AddError as e:
            print(f"thimble extension add: {e}", file=sys.stderr)
            return 1
        if names is None:
            print("Not added.")
            return 0
        name, *more = names
        print(f"{name}{' and ' + ' and '.join(more) if more else ''} {'are' if more else 'is'} on. "
              f"`thimble extension off {name}` switches it off.")
        for n in names:
            if kept := extensions.off_in(n, workspaces):
                print(f"{n} stays off where its switch in Settings keeps it off: {', '.join(kept)}.")
            info = extensions.read_extension(extensions.source_path(n), n)
            if extensions.orients(info):
                print(orient_hint(n, extensions.orient_program(info)))
    elif args.ext_cmd in ("on", "off"):
        try:
            got = extensions.switch(args.name, args.ext_cmd == "on", workspaces)
        except extensions.SwitchError as e:
            print(f"thimble extension {args.ext_cmd}: {e}", file=sys.stderr)
            return 1
        if args.ext_cmd == "on" and got["off_in"]:
            print(f"{args.name} is on, except where its switch in Settings keeps it off: {', '.join(got['off_in'])}.")
        else:
            print(f"{args.name} is {args.ext_cmd} in every workspace.")
        if args.ext_cmd == "on" and got["problem"]:
            print(f"It does not run until this is fixed: {got['problem']}")
        elif args.ext_cmd == "on" and got["orients"]:
            print(orient_hint(args.name, got["orient_program"]))
    else:
        needing = extensions.dependents(args.name)
        if not extensions.remove(args.name):
            print(f"thimble extension remove: no extension {args.name!r} is added", file=sys.stderr)
            return 1
        print(f"Removed {args.name}.")
        if needing:
            print(f"{' and '.join(needing)} {'need' if len(needing) > 1 else 'needs'} it, so "
                  f"{'they do' if len(needing) > 1 else 'it does'} not run until {args.name} is added again: "
                  f"`thimble extension add {args.name}`.")
    url = api_url(int(read_state().get("port") or port()))
    if healthy(url):
        status, body = _request("POST", f"{url}/api/extensions/refresh", {}, timeout=60)
        if status != 200:
            print(f"thimble: the server did not take the change yet ({body}); it will when a session next connects")
    return 0


def cmd_list(_: argparse.Namespace) -> int:
    from . import runs  # noqa: PLC0415

    for ln in runs.list_lines():
        print(ln)
    return 0


def cmd_purge(args: argparse.Namespace) -> int:
    from . import runs  # noqa: PLC0415

    return runs.purge(list(args.ids), yes=bool(args.yes), dry_run=bool(args.dry_run))


def _ensure_namespace(args: argparse.Namespace, action: str | None = None) -> argparse.Namespace:
    return argparse.Namespace(cwd=getattr(args, "cwd", None), session=getattr(args, "session", None),
                              action=action if action is not None else getattr(args, "action", None),
                              archive=getattr(args, "archive", None))


def cmd_server_up(args: argparse.Namespace) -> int:
    """`thimble server up`: start if needed, open this directory, print the URL; exit 0 whatever happens. With `--hook`,
    /thimble's hook (hook_up), which reads Claude Code's hook input on stdin."""
    if getattr(args, "hook", False):
        try:
            return hook_up(sys.stdin.read())
        except Exception as e:  # noqa: BLE001 — the skill's `up` then does the work, or says what is missing
            _log(f"server up --hook failed: {type(e).__name__}: {e}\n{traceback.format_exc()}")
            return 0
    try:
        return cmd_ensure(_ensure_namespace(args))
    except Exception as e:  # noqa: BLE001
        _log(f"server up failed: {type(e).__name__}: {e}\n{traceback.format_exc()}")
        return _failed_up("server up", e)


def _failed_up(what: str, e: BaseException) -> int:
    cause = failure_text(e)
    print(f"thimble: {what} failed: {cause}" if cause else f"thimble: {what} failed ({type(e).__name__}); see {log_path()}")
    return 0


def cmd_server_status(args: argparse.Namespace) -> int:
    return cmd_ensure(_ensure_namespace(args, action="status"))


def cmd_server_repair(args: argparse.Namespace) -> int:
    return cmd_fix(args)


def add_server_group(sub: Any) -> None:
    srv = sub.add_parser("server", help="the server: up (start if needed, open this directory, print the URL) | status | repair | stop | restart")
    ssub = srv.add_subparsers(dest="server_cmd", required=True)
    up = ssub.add_parser("up", aliases=[*SERVER_UP_ALIASES],
                         help="start the server if needed, open this directory as a workspace, print the URL (`ensure` is the old name)")
    up.add_argument("--cwd")
    up.add_argument("--session", help="the Claude Code session asking; its folder is opened as a workspace")
    up.add_argument("--action", help="status | fix | fresh | restore (or resume) | feedback; empty for a bare /thimble")
    up.add_argument("--archive", help="with --action restore: the archived run to restore; none lists them")
    up.add_argument("--hook", action="store_true", help="/thimble's UserPromptExpansion hook: the session, folder and "
                    "arguments from the hook input on stdin, and what up prints kept for the skill's own up")
    up.set_defaults(fn=cmd_server_up)
    st = ssub.add_parser("status", help="one line: server up/down, orientation, queue; starts nothing")
    st.add_argument("--cwd")
    st.set_defaults(fn=cmd_server_status)
    ssub.add_parser("repair", help="server down: run the fix ticket in the live checkout, then restart (= fix)").set_defaults(fn=cmd_server_repair)
    sp = ssub.add_parser("stop", help="stop the server (by pid); asks first while work runs")
    add_yes_flag(sp, "stop")
    sp.set_defaults(fn=cmd_stop)
    rs = ssub.add_parser("restart", help="stop, then start; asks first while work runs")
    add_restart_flags(rs)


def add_yes_flag(p: argparse.ArgumentParser, command: str) -> None:
    p.add_argument("-y", "--yes", action="store_true",
                   help=f"{command} without asking, even while orientations, writers or view builds run")


def add_restart_flags(p: argparse.ArgumentParser) -> None:
    p.add_argument("--keep-vite", action="store_true", help="restart the backend only; a running Vite stays")
    add_yes_flag(p, "restart")
    p.set_defaults(fn=cmd_restart)


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(prog="thimble", description=__doc__.split("\n\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    add_server_group(sub)
    e = sub.add_parser("up", aliases=["ensure"], help="start the server if needed, open this directory, print the URL")
    e.add_argument("--cwd")
    e.add_argument("--session")
    e.add_argument("--action")
    e.add_argument("--archive")
    e.set_defaults(fn=cmd_ensure)
    r = sub.add_parser("restart", help="stop, then start; asks first while work runs")
    add_restart_flags(r)
    sp = sub.add_parser("stop", help="stop the server (by pid); asks first while work runs")
    add_yes_flag(sp, "stop")
    sp.set_defaults(fn=cmd_stop)
    for name, fn, help_ in (("doctor", cmd_doctor, "print the state; works with the server down"),
                            ("fix", cmd_fix, "development install, server down: run the fix ticket in the live checkout, "
                                                    "then restart"),
                            ("revert", cmd_revert, "development install: undo the last change thimble's dev agent applied")):
        sub.add_parser(name, help=help_).set_defaults(fn=fn)
    fb = sub.add_parser("feedback", help="write a problem report (a zip) to send the developer, and say how to send it")
    fb.add_argument("description", nargs="*", help="what went wrong")
    fb.add_argument("--no-logs", action="store_true", help="leave out the server log and the workspace's chats and events")
    fb.set_defaults(fn=cmd_feedback)
    sub.add_parser("list", help="the workspaces by id: each folder's live one and its archived runs, when each was last "
                   "used and the sessions open on it").set_defaults(fn=cmd_list)
    pg = sub.add_parser("purge", help="delete workspaces or archived runs by id (`thimble list`) and print what was deleted")
    pg.add_argument("ids", nargs="+", metavar="id", help="an id `thimble list` shows")
    pg.add_argument("-y", "--yes", action="store_true", help="accepted and ignored (purge does not ask)")
    pg.add_argument("--dry-run", action="store_true", help="print what would be deleted; delete nothing")
    pg.set_defaults(fn=cmd_purge)
    ex = sub.add_parser("extension", help="add, switch on or off, list or remove extensions (views, card types, agents, "
                                          "report types)")
    exs = ex.add_subparsers(dest="ext_cmd", required=True)
    ea = exs.add_parser("add", help="check an extension, show what it gives, ask, then add it and switch it on")
    ea.add_argument("source", help="a local folder (used in place), a git URL, or the name of an extension thimble ships")
    ea.add_argument("-y", "--yes", action="store_true", help="add it without asking")
    for word, what in (("on", "switch an added extension on in every workspace"),
                       ("off", "switch an added extension off in every workspace")):
        exs.add_parser(word, help=what).add_argument("name")
    exs.add_parser("list", help="the extensions added, and whether each runs in each workspace")
    er = exs.add_parser("remove", help="remove an added extension (a folder used in place stays where it is)")
    er.add_argument("name")
    ex.set_defaults(fn=cmd_extension)
    u = sub.add_parser("update", help="bring the install up to date: the latest GitHub release via gh, or --from <zip>")
    u.add_argument("--from", dest="from_", metavar="ZIP", help="a downloaded release zip (thimble-<version>-<sha>.zip)")
    u.add_argument("--dry-run", action="store_true", help="print update.sh's steps; change nothing")
    u.add_argument("--browser", choices=("bundled", "system", "off"), help="passed on to install.sh")
    for flag in INSTALL_FLAGS:
        u.add_argument(flag, dest="install_flags", action="append_const", const=flag, help="passed on to install.sh")
    u.set_defaults(fn=cmd_update)
    la = sub.add_parser("launch-args", help="for plugin/bin/thimble: the plugin folder, the --allowedTools, --effort and --settings values, the tools that end a turn without text, main's --name, the session id, the env, unset and note lines, then main's prompt")
    la.add_argument("--cwd")
    la.add_argument("--resume", action="store_true", help="a line before the prompt: the folder's last main session")
    la.add_argument("--settings", help="the analyst's own --settings, which thimble's are merged into")
    la.add_argument("--own-session", help="the analyst's own flags name main's session (-r, --session-id or "
                                          "--fork-session): its id, or '' when it is not known")
    la.add_argument("--safe-mode", action="store_true", help="the analyst passed Claude Code's --safe-mode")
    la.add_argument("--launcher-pid", type=int, help="the launcher's own pid ($$), which launch.json records until the "
                                                     "launcher writes main's `claude` process there")
    la.set_defaults(fn=cmd_launch_args)
    pr = sub.add_parser("prompt", help="for a plugin skill's injected command: prompt files rendered for a session in --cwd")
    pr.add_argument("names", nargs="+", help="prompt names under prompts/, such as shared")
    pr.add_argument("--cwd")
    pr.add_argument("--unless-launched", action="store_true",
                    help="/thimble's: print nothing in a session the launcher started (it appended main's prompt)")
    pr.add_argument("--action", help="with --unless-launched: /thimble's action; only an opening one prints")
    pr.add_argument("--archive", help="with --action restore: an archive's name; none (a listing) prints nothing")
    pr.add_argument("--if-main", action="store_true",
                    help="the SessionStart hook's: print nothing unless this runs in the `claude` process of the session "
                         "that is main in --cwd's workspace")
    pr.add_argument("--lead", help="text printed before the prompts, when they print")
    pr.set_defaults(fn=cmd_prompt)
    from . import demo  # noqa: PLC0415 — `thimble demo`: the demo datasets and their pre-cached orientations
    demo.add_parser(sub)
    return ap


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return int(args.fn(args) or 0)
    except Exception as e:  # noqa: BLE001
        _log(f"{args.cmd} failed: {type(e).__name__}: {e}\n{traceback.format_exc()}")
        if args.cmd in ("up", "ensure"):
            return _failed_up(args.cmd, e)
        print(f"thimble {args.cmd}: {failure_text(e) or f'{type(e).__name__}: {e}'}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
