"""The supervisor behind `plugin/bin/thimble`: the server's lifecycle from a shell or the /thimble skill.

    thimble server up [--cwd <path>] [--session <id>] [--action status|fix|repair|fresh|restore|feedback]
                      [--archive <name>]
    thimble server status [--cwd <path>] | repair | stop [--yes] | restart [--keep-vite] [--yes]
    thimble doctor [--verbose] | unpair | fix | revert | stop [--yes] | restart [--keep-vite] [--yes]
    thimble update [--from <zip>] [--dry-run]
    thimble feedback ["description"] [--no-logs]   (a problem report as a zip; feedback.py)
    thimble list                           (the workspaces by id, archived runs included; runs.py)
    thimble purge <id>… [--dry-run]        (delete workspaces or archived runs by id; runs.py)
    thimble launch-args --cwd <path>       (the launcher's: the plugin folder to load, the tools that end a turn without
                                           text, and why the hooks module is off; kept in <home>/launcher.json)
    thimble prompt <name>… [--cwd <path>]  (prompt files rendered for a session in <path>, for skills and hooks)
    thimble prompt main --if-active --unless-mod --session <sid>
                                           (the guide again after /clear or /compact, for a session without the mod)
    thimble extension add <folder | git URL | built-in name> [--yes] | on <name> | off <name> | list | remove <name>
                                                                                              (extensions.py)

`server up` (alias `ensure`) starts the server from a shell or for a /thimble action that needs it (fresh, restore,
status, fix, feedback): `GET /api/health`, then under `flock <home>/server.lock` spawn uvicorn on the server's port
(port) as its own session leader (plus Vite on 5300 when THIMBLE_DEV is on), wait for health, map the cwd to a
workspace, print `thimble: <url>` (LINK_LINE in a session), and name the session to the server. /thimble alone starts
no server: its hook and the skill's own commands turn thimble on in the session (app/activate.py), and `up` prints the
line that says so (on_here). A press of the browser workbench (`thimble open`, app/open_cmd.py; /thimble open, run_open)
is the session's way to start the server; it makes the session main on the server (made_main), which switches its
transport to the server for the rest of the session (subagent_files.transport). It always exits 0, since a skill fails
whole when its command exits non-zero. `--action fresh` moves the workspace aside into <workspaces>/.archive/;
`--action restore` restores an archive. Where the plugin's hooks are off, /thimble also prints the command main's
Monitor runs (cc_plugin.route, monitor_lines).

<home> is `~/.thimble` or THIMBLE_HOME. <home>/server.json records {port, pid, url, repo, env, token}, written 0600
(write_state) in the 0700 home, readable by its owner alone; `token` is new at each start and is what the plugin's
hooks and this CLI prove they hold (hook_auth.py). A browser signs in with a one-time code from ui_url(pair=True), never
with a value from this file. Only a terminal gets a link with a code: `up` from a shell prints one, and /thimble fresh
and restore print LINK_LINE for main's Stop hook to show the link, which gets its code as the hook shows it
(leave_link). `thimble unpair` signs every browser out. Its `pid` is trusted
only while it is a thimble server on its port (is_server checks the command line and working folder, since a pid
recorded inside a sandbox's pid namespace can name an unrelated host process). reconcile makes the record true before
`up` acts on it. A server whose /api/health names another THIMBLE_HOME belongs to another install.

The port: THIMBLE_PORT when the caller sets it, else the one server.json records, else DEFAULT_PORT (8300). Without
THIMBLE_PORT, a start whose port another program or another install's server holds starts on a free port instead
(pick_port), and server.json records it, so every reader finds the server there: this CLI, the launcher, the plugin's
shim, hooks and hooks module, and the browser link (ui_url). With THIMBLE_PORT that port alone is used: another
install's server there is refused with FOREIGN_LINE, and another program there makes the start fail (port_line). Vite's
UI port in dev mode follows the same rule with THIMBLE_UI_PORT (DEFAULT_UI_PORT, 5300).

Claude Code's Bash sandbox gives each command its own network and pid namespace, where a server would die with the
command and the host's cannot be reached. So /thimble's work runs in the plugin's UserPromptExpansion hook, which Claude
Code runs outside the sandbox just before the skill's commands (`server up --hook`, hook_up): `/thimble` alone turns
thimble on in the session (app/activate.py, no server), `/thimble open` opens the browser workbench (app/open_cmd.py),
and an action that needs the server runs `up` and keeps what it printed in <home>/up/<session>.json, which the skill's
`up` prints (take_hook_result), or does the work itself when the hook left nothing. In the sandbox without the hook's
result `up` starts nothing and prints the `sandbox.excludedCommands` entries that would run it outside (sandbox_line).
`restart` and `stop` name the work they would interrupt (running_work) and ask first unless `--yes`. In dev mode an
`up` that finds the source tree changed while the server is idle restarts the backend (THIMBLE_NO_AUTORESTART=1
disables it). This module imports only `config`, `procs`, `cc_plugin` and the standard library (others lazily), never
`app.notebook`.

thimble has no modes: every Claude Code session loads the plugin, turns thimble on at its first data read, `/thimble`
or a call of `load_thimble` (app/activate.py), works on local transport until a press, and on the server after it. The
`thimble` command is `claude` with THIMBLE_OPEN=1, which presses home at the session's start (launch_args).
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
from contextlib import contextmanager, redirect_stdout, suppress
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator, Mapping, NamedTuple

from . import cc_plugin, config, headless, procs

DEFAULT_PORT = 8300
DEFAULT_UI_PORT = 5300
VALIDATION_PORTS = (8301, 5301)  # scripts/dev/dev_stack.sh's defaults; THIMBLE_STACK_PORT and _UI_PORT move them
PORT_SCAN = 50  # the ports above a taken one that pick_port tries in turn, before it takes one the system gives
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
NO_UI_LINE = ("thimble: the dashboard is not built yet, so its link shows no page; run `thimble doctor --verbose` in a "
              "shell for the fix.")
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
MONITOR_MARK = "thimble-monitor:"  # then the command main's Monitor runs (plugin/skills/thimble/SKILL.md)
WATCHER = "bin/.thimble-watch"  # the plugin's hidden watcher, under its root
FRESH = "fresh"  # /thimble fresh: the folder's workspace moved aside, an empty one opened
RESUME = "restore"  # /thimble restore [<archive>]: an archive restored in its place, or the archives listed
OPEN = "open"  # /thimble open: the browser workbench (app/open_cmd.py), which hook_up runs outside the Bash sandbox
ALIASES = {"resume": RESUME}  # another name the action takes
OPENING = ("", "on", FRESH, RESUME)  # the actions that open the workspace (and arm the Monitor where hooks are off)
RESUME_LINE = "thimble: resuming the dashboard from your last run; `/thimble fresh` starts over"
# /thimble in a session new to a workspace `thimble demo` installed from a pre-cache, which then gives the session what
# the orientation left as context (precached.py)
PRECACHED_LINE = ("thimble: opening the orientation that ran in advance on these files; this session starts fresh, "
                  "from its cards and report; `/thimble fresh` starts over")
# what /thimble prints in place of the link: main's Stop hook shows the link under the reply with a sign-in code it gets
# as it shows it (leave_link, plugin/bin/.thimble-watch link_lines), outside the model's context
LINK_LINE = "thimble: the dashboard link is under this reply (or run `thimble up` in a shell)"
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
PLUGIN_ROOT_ENV = "THIMBLE_PLUGIN_ROOT"  # bin/thimble exports its plugin copy: the tree's plugin/, or an installed copy
MCP_TOOLS_RULE = "mcp__plugin_thimble_thimble"  # every tool of the plugin's thimble server, in a permission rule
# The agents defined for a session thimble starts with `--agents` (agent_definition: the writer's, the orientation's and
# the critic's own sessions), each from a prompt file in a plugin agent's form (prompts.agent_file).
AGENT_FIELDS = ("model", "effort", "background")  # the frontmatter fields passed on as they are
PLUGIN_NAME = "thimble"  # the plugin's name, which prefixes its skills (`thimble:shared`) outside a plugin agent's file
RESTART_MARK_S = 60.0  # a `source_restart` mark in server.json younger than this means a restart is under way
REFUSED_LINE = "thimble: {path} is not a folder to open as a workspace; say /thimble from the folder that holds the corpus."
TAKEOVER_LINE = ("thimble: this session is main now. The session {other} in another terminal no longer hears the "
                 "browser, and is main again once this one exits.")
FOREIGN_UNNAMED = "<its THIMBLE_HOME>"  # foreign_home's answer for a server that names no home to this install
FOREIGN_LINE = ("thimble: port {port} (set by THIMBLE_PORT) is in use by another program. Set THIMBLE_PORT to a free "
                "port, or unset it and thimble picks one.")
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
HOOK_RESULTS_DIR = "up"  # under <home>: what /thimble's hook left for the skill's command to print (hook_up)
# beside a result: the session marker activation writes (app/activate.py), which the plugin's hooks and its hooks module
# look for (plugin/bin/.thimble-watch's second line)
HOOK_MARKER_SUFFIX = ".active"
# under <home>: an empty file for each folder thimble opened (mark_active), which the plugin's watcher looks for before it
# starts Python where Claude Code gives a hook no session id, so hooks in a folder thimble never opened exit at once
# (plugin/bin/.thimble-watch's second line)
ACTIVE_DIR = "active"
ACTIVE_KEY_MAX = 200  # a marker's name longer than this is not written; the watcher starts Python for such a folder
HOOK_RESULT_S = 60.0  # a result older than this is not the one the hook left for this /thimble
MANUAL_RESTART = "manual restart"  # dev.PLAIN_REASONS
# what `restart` says before it asks (running_work, module note)
RUNNING_HEAD = "thimble: running now:"
RUNNING_BACK_LINE = ("A restart stops them. Once the server is back, the orientations and writers resume by themselves, "
                     "and a view build or dev ticket starts again.")
RESTART_QUESTION = "Restart the server now? [y/N] "
RESTART_UNASKED_LINE = "thimble: not restarted, since there is no terminal to ask in; pass --yes to restart anyway."
RESTART_DECLINED_LINE = "thimble: not restarted."
STOP_BACK_LINE = ("A stop ends them. The server's next start resumes the orientations and writers, and starts a view "
                  "build or dev ticket again.")
STOP_QUESTION = "Stop the server now? [y/N] "
STOP_UNASKED_LINE = "thimble: not stopped, since there is no terminal to ask in; pass --yes to stop anyway."
STOP_DECLINED_LINE = "thimble: not stopped."
RUNNING_ORIENT = "the orientation"
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
    """server.json, written whole into the private home (ensure_home), 0600 from its first byte (a mkstemp file renamed
    over it), with the token the file held when `state` names none, else a new one (hook_auth.py). The browser key
    earlier builds kept here is dropped: a browser signs in with a one-time code (ui_url)."""
    ensure_home()
    held = read_state()
    if not state.get("token"):
        state = {**state, "token": held.get("token") or new_token()}
    state = dict(state)
    state.pop("ui_key", None)
    p = server_json()
    fd, tmp = tempfile.mkstemp(prefix=".server.", suffix=".json.tmp", dir=str(p.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(json.dumps(state, indent=2) + "\n")
        os.replace(tmp, p)
    finally:
        Path(tmp).unlink(missing_ok=True)


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


def explicit_port() -> int | None:
    """THIMBLE_PORT when the caller set it to a port: the one port thimble then uses, or says is taken (module note).
    None without it."""
    v = (os.environ.get("THIMBLE_PORT") or "").strip()
    return int(v) if v.isdigit() and 0 < int(v) < 65536 else None


def port() -> int:
    """THIMBLE_PORT, else the port server.json records (the one the last start bound, maybe one pick_port chose), else
    DEFAULT_PORT."""
    return explicit_port() or int(read_state().get("port") or DEFAULT_PORT)


def explicit_ui_port() -> int | None:
    """THIMBLE_UI_PORT when the caller set it to a port: the one port Vite then uses in dev mode. None without it."""
    v = (os.environ.get("THIMBLE_UI_PORT") or "").strip()
    return int(v) if v.isdigit() and 0 < int(v) < 65536 else None


def ui_port() -> int:
    """THIMBLE_UI_PORT, else the UI port server.json records (maybe one start chose, as for the server's port), else
    DEFAULT_UI_PORT."""
    return explicit_ui_port() or int(read_state().get("ui_port") or DEFAULT_UI_PORT)


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
        with config.LOOPBACK.open(f"{url or api_url()}/api/health", timeout=timeout) as r:
            return r.status == 200 and bool(json.loads(r.read() or b"{}").get("ok"))
    except Exception:  # noqa: BLE001
        return False


def listening(p: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.3)
        return s.connect_ex(("127.0.0.1", p)) == 0


def port_free(p: int) -> bool:
    """Whether the server could bind 127.0.0.1:`p` now: nothing answers there and a bind succeeds, with SO_REUSEADDR as
    uvicorn binds. Seam for tests."""
    if listening(p):
        return False
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind(("127.0.0.1", p))
        except OSError:
            return False
    return True


def pick_port(taken: int, avoid: tuple[int, ...] = ()) -> int:
    """A free port where `taken` is not free (port_free): the first free one of the PORT_SCAN ports above it, passing
    over the validation stack's ports and `avoid`, else one the system gives."""
    skip = {*validation_ports(), *avoid}
    for q in range(taken + 1, min(taken + 1 + PORT_SCAN, 65536)):
        if q not in skip and port_free(q):
            return q
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def _this_home(other: Any) -> bool:
    """Whether the path `other` is this install's THIMBLE_HOME."""
    if not isinstance(other, str) or not other:
        return False
    try:
        return Path(other).expanduser().resolve() == home().expanduser().resolve()
    except OSError:
        return other == str(home())


def held_by_this_install(p: int, st: dict[str, Any]) -> bool:
    """Whether this install's own server holds port `p`, answering or not: the pid server.json names is a thimble server
    on `p`, or the process listening on `p` is a thimble server of this checkout started with this THIMBLE_HOME (or
    whose environment cannot be read). start then keeps the port, so a stuck server is named (start_failure) rather
    than left running beside a new one."""
    if st.get("pid") and is_server(st.get("pid"), p, st.get("repo")):
        return True
    holder = procs.listener(p)
    if not holder or not is_server(holder, p, st.get("repo")):
        return False
    env = procs.environ(holder)
    return env is None or _this_home(env.get("THIMBLE_HOME") or os.path.join(env.get("HOME") or "~", ".thimble"))


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
    """The THIMBLE_HOME of the server answering at `url` when it is another install's; None when it is this install's, or
    nothing answers. Two installs start on the same default port, and the second passes over it (pick_port). A server
    names its home only to a request that proves its token (main's /api/health), so a healthy server that names none
    took this install's proof for no proof: another install's or another account's, whose home is FOREIGN_UNNAMED
    here."""
    status, body = _request("GET", f"{url or api_url()}/api/health", timeout=HEALTH_TIMEOUT_S)
    if status != 200 or not isinstance(body, dict) or body.get("ok") is not True:
        return None
    other = body.get("home")
    if not isinstance(other, str) or not other:
        return FOREIGN_UNNAMED
    return None if _this_home(other) else other


def serves(url: str | None = None) -> bool:
    """Whether this install's server answers at `url` (default api_url): healthy, and not another install's
    (foreign_home)."""
    url = url or api_url()
    return healthy(url) and foreign_home(url) is None


def refuse_foreign(url: str | None = None) -> bool:
    """Print FOREIGN_LINE and return True when THIMBLE_PORT names the port and another install's server holds it
    (foreign_home). Without THIMBLE_PORT nothing is refused: start passes over the port (pick_port)."""
    if explicit_port() is None:
        return False
    other = foreign_home(url)
    if other:
        _log(f"port {port()} is held by the thimble server of {other}; not used")
        print(FOREIGN_LINE.format(port=port()))
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


def watch_rule(root: Path | None = None) -> str:
    """The `sandbox.excludedCommands` entry that runs the Monitor route's watcher of the plugin copy at `root` (by
    default plugin_root) outside the sandbox, for a session whose plugin hooks are off (sandbox_line)."""
    return f"{(root or plugin_root()) / WATCHER} --stream *"


def sandbox_line(cwd: Path) -> str:
    """What /thimble prints in the sandbox when the hook left no result (module note, the Bash sandbox): with the
    plugin's hooks off, the Monitor route's watcher needs an entry too."""
    from . import cc_settings  # noqa: PLC0415 — the settings' path, needed on this path alone

    settings = cc_settings.config_dir() / "settings.json"
    if cc_plugin.hooks_blocked(cwd, plugin_root()):
        return SANDBOX_NO_HOOKS_LINE.format(rule=sandbox_rule(), watch=watch_rule(), settings=settings)
    return SANDBOX_LINE.format(rule=sandbox_rule(), settings=settings, log=log_path())


def browser_request(url: str, cookie: str) -> tuple[str, str]:
    """(the URL, the Cookie header) of a request a signed-in browser makes, for a script holding browser_cookie's
    `cookie` (`name=value; Path=/b/<key>/api/`): `url`, a URL of the server's API (/api/...), moved under the cookie's
    path, where the server counts it (hook_auth.browser_path), and the cookie's `name=value`. A cookie that names no
    such path leaves `url` as it is."""
    pair, _, attrs = cookie.partition(";")
    path = next((a.strip()[5:] for a in attrs.split(";") if a.strip().lower().startswith("path=")), "")
    u = urllib.parse.urlsplit(url)
    if path.startswith("/b/") and path.endswith("/api/") and (u.path == "/api" or u.path.startswith("/api/")):
        url = urllib.parse.urlunsplit(u._replace(path=path[:-len("/api/")] + u.path))
    return url, pair.strip()


def _request(method: str, url: str, body: dict | None = None, timeout: float = 5.0,
             cookie: str | None = None) -> tuple[int, Any]:
    """(status, parsed json | text). Transport failures are (0, message); an HTTP error is (status, its body). The
    request proves the server's token (hook_auth), which the routes of hooks, the plugin and this CLI need; a write the
    analyst's browser makes needs a signed-in browser's `cookie` (browser_cookie), sent as the Cookie header on the path
    the cookie is scoped to (browser_request). A notebook kernel holds neither."""
    from . import hook_auth  # noqa: PLC0415

    data = json.dumps(body).encode() if body is not None else None
    headers = {"Content-Type": "application/json"}
    tok = hook_auth.token()
    if tok:  # good only on the port `url` names, for a few minutes, once: a process that holds that port gains nothing
        headers.update(hook_auth.headers(tok, hook_auth.port_of(url)))
    if cookie:
        url, headers["Cookie"] = browser_request(url, cookie)
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with config.LOOPBACK.open(req, timeout=timeout) as r:  # never through the shell's proxy
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
    """Spawn the backend (and Vite in dev mode) and write server.json, which records the port. The caller holds the
    lock. Without THIMBLE_PORT, when the port is not free and this install's own server does not hold it
    (held_by_this_install), the server starts on a free port instead (pick_port); in dev mode, without THIMBLE_UI_PORT,
    Vite does the same where the UI port is not free and no Vite of this install serves it (own_vite)."""
    if p is None:
        p = port()
        if explicit_port() is None and not port_free(p) and not held_by_this_install(p, read_state()):
            q = pick_port(p, (ui_port(),))
            _log(f"port {p} is taken by another program or another install's server; starting on port {q}, a free one")
            p = q
    ui = ui_port()
    env = resolve_env()
    if env["dev"] and explicit_ui_port() is None and not port_free(ui) and not own_vite(read_state(), ui):
        q = pick_port(ui, (p,))
        _log(f"UI port {ui} is taken by another program or another install's Vite; Vite starts on port {q}, a free one")
        ui = q
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


def own_vite(st: dict[str, Any], ui: int) -> bool:
    """Whether the Vite server.json names runs on port `ui` (its command line names `vite` and `--port <ui>`): start
    keeps that port and that Vite."""
    vite = st.get("vite_pid")
    return bool(vite) and pid_alive(vite) and argv_check("vite", f"--port {ui}")(int(vite)) is None


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
    and a healthy server whose source changed since it started (auto_restart). Another install's server on the port is
    not this install's (serves): start passes over the port then, and once more when another server took the free port
    it chose before the new server bound it. The server is at api_url() after it returns."""
    url = api_url()
    if serves(url):
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
        url = api_url()
        spawned = None
        if not serves(url) and not starting(url):
            spawned = start().get("pid")
            url = api_url()
        up = wait_healthy(url, wait_s, spawned)
        if not up and spawned and lost_port(int(spawned)):
            _log(f"another process took port {LAST_START.get('port')} before the server bound it; starting again")
            spawned = start().get("pid")
            url = api_url()
            up = wait_healthy(url, wait_s, spawned)
        reconcile()  # a uvicorn that could not bind the port leaves no dead pid; the server answering is adopted
        return up


def lost_port(spawned: int) -> bool:
    """Whether the server `start` spawned as `spawned` exited because another process took its port, a free one when
    start looked (a second install starting at the same moment): without THIMBLE_PORT a second start then picks again."""
    p = int(LAST_START.get("port") or 0)
    if explicit_port() is not None or not p or LAST_START.get("pid") != spawned or not spawned_exited(spawned):
        return False
    return listening(p) and procs.listener(p) != spawned


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
    env["THIMBLE_HOME"] = str(home())
    if explicit_port() is not None:  # else the restart reads the port from server.json, and may pass over it (start)
        env["THIMBLE_PORT"] = str(explicit_port())
    return spawn([sys.executable, "-m", "app.cli", "restart", "--keep-vite", "--yes"], cwd=BACKEND_DIR, env=env,
                 log_file=log_path())


def running_work(url: str) -> list[str]:
    """What a restart of the server at `url` would interrupt, one line each: the orientations whose run.json says they
    run, then the dev ticket the server runs (`GET /api/dev/status`). Empty when nothing runs."""
    names = _workspace_names(Path(resolve_env()["workspaces_dir"]))
    lines = [f"{c}: {RUNNING_ORIENT}" for c in names if orient_status(c) == "running"]
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


PAIR_TIMEOUT_S = 3.0
PAIRED_FILE = "paired.json"  # in <home>: the hashes of the browsers signed in (hook_auth.PAIRED_FILE)
NO_CODE_LINE = ("thimble: the server gave no sign-in code, so this link opens thimble read-only in a browser that is "
                "not signed in yet; see {log}.")
UNPAIRED_LINE = ("thimble: every browser is signed out of thimble. To sign one in again, open the link /thimble shows, "
                 "or run `thimble up` in a shell.")
UNPAIR_FAILED_LINE = ("thimble: the server did not sign the browsers out ({why}), so they stay signed in until it "
                      "restarts. In a shell: thimble server restart")


def pair_code(api: str, name: str | None) -> str:
    """A one-time sign-in code for a browser from the server at `api` (`POST /api/ui/pair`, which needs the token:
    hook_auth.mint), for workspace `name`; a newer code for the same workspace voids it. '' when the server gives none,
    which is logged."""
    status, body = _request("POST", f"{api}/api/ui/pair", {"ws": name} if name else {}, timeout=PAIR_TIMEOUT_S)
    code = body.get("code") if status == 200 and isinstance(body, dict) else None
    if isinstance(code, str) and code:
        return code
    _log(f"no sign-in code from {api}: {status} {str(body)[:200]}")
    return ""


def ui_url(name: str | None, pair: bool = False) -> str:
    """The UI port in dev mode (its own Vite), else the API port where the built UI is served, and with `pair` a
    one-time sign-in code after `#p=` (hook_auth.mint, pair_code), which the page trades for the browser's cookie. The
    URL without a code when the server gives none."""
    st = read_state()
    base = str(st.get("url") or api_url())
    url = f"{base}/?ws={name}" if name else f"{base}/"
    code = pair_code(str(st.get("api") or api_url()), name) if pair else ""
    return f"{url}#p={code}" if code else url


def browser_cookie(url: str | None = None) -> str:
    """A browser's sign-in, for scripts (scripts/dev/precache_orientation.py, scripts/e2e): a code from the server at
    `url` (pair_code), traded at `POST /api/ui/key` with no token, as a browser trades it; the cookie it sets with the
    path of the browser's key it is scoped to (hook_auth.browser_path), as `name=value; Path=/b/<key>/api/` for
    _request's `cookie` (browser_request). Each call is a new sign-in, with its terminal line and notice. RuntimeError
    when the server gives no code or no cookie."""
    base = url or api_url()
    code = pair_code(base, None)
    if not code:
        raise RuntimeError(f"the server at {base} gave no sign-in code; see {log_path()}")
    req = urllib.request.Request(f"{base}/api/ui/key", data=json.dumps({"code": code}).encode(), method="POST",
                                 headers={"Content-Type": "application/json"})
    try:
        with config.LOOPBACK.open(req, timeout=PAIR_TIMEOUT_S) as r:
            set_cookies = r.headers.get_all("Set-Cookie") or []
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"the server at {base} refused the sign-in code ({e.code})") from None
    except OSError as e:
        raise RuntimeError(f"the server at {base} did not answer the sign-in: {e}") from None
    for raw in set_cookies:  # the cookie, beside the deletion of one an earlier build scoped to /api/
        pair, _, attrs = raw.partition(";")
        name, _, value = pair.strip().partition("=")
        path = next((a.strip()[5:] for a in attrs.split(";") if a.strip().lower().startswith("path=")), "")
        if name and value and path.startswith("/b/"):
            return f"{name}={value}; Path={path}"
    raise RuntimeError(f"the server at {base} set no cookie for the sign-in")


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


def active_keys(cwd: Path | str) -> list[str]:
    """The marker names of the folder `cwd` (mark_active): its path as given and its real path, each with every `/`
    replaced by `%`, as the watcher spells $CLAUDE_PROJECT_DIR; a name longer than ACTIVE_KEY_MAX is left out."""
    given = os.path.abspath(str(cwd))
    paths = dict.fromkeys([given, os.path.realpath(given)])
    return [k for k in (p.replace("/", "%") for p in paths) if len(k) <= ACTIVE_KEY_MAX]


def mark_active(cwd: Path | str) -> None:
    """Mark the folder `cwd` as one thimble opened: an empty file, mode 600, for each of active_keys in <home>/active
    (config.private_dir), which the plugin's watcher looks for. Never raises; a failure is logged."""
    try:
        d = config.private_dir(ensure_home() / ACTIVE_DIR)
        for key in active_keys(cwd):
            fd = os.open(d / key, os.O_WRONLY | os.O_CREAT, 0o600)
            os.close(fd)
            os.chmod(d / key, 0o600)
    except OSError as e:
        _log(f"the folder {cwd} was not marked active: {e}")


def unmark_active(cwd: Path | str) -> None:
    """Remove the folder `cwd`'s markers (mark_active), as `thimble purge` does. Never raises; a failure is logged."""
    try:
        for key in active_keys(cwd):
            (home() / ACTIVE_DIR / key).unlink(missing_ok=True)
    except OSError as e:
        _log(f"the folder {cwd}'s active marker was not removed: {e}")


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
    return [MONITOR_NOTE, f"{MONITOR_MARK} {watcher}"]


def plugin_root() -> Path:
    """The plugin copy whose bin/thimble ran this command (PLUGIN_ROOT_ENV), else this tree's plugin/."""
    return Path(os.environ.get(PLUGIN_ROOT_ENV) or PLUGIN_DIR).resolve()


PLUGIN_LIST_TIMEOUT_S = 10.0
COPY_IGNORED = ("__pycache__", ".DS_Store")  # what running or browsing a plugin copy adds to it
# files of plugin/ a release leaves out of the plugin's copy (scripts/release.sh not_shipped: the hooks module's tests),
# or Claude Code's cache does not keep, which say nothing of whether two copies run the same code: the terminal UI's
# type declarations and the TypeScript config Claude Code writes beside a module it loads from a folder
COPY_LEFT_OUT = ("hooks/tests", "hooks/term/tests", "hooks/term/types", "hooks/term/tsconfig.json", ".claude-plugin/types",
                 "tsconfig.json")
COPY_LEFT_OUT_SUFFIX = ".test.ts"  # every test file of the hooks module, wherever it is
PLUGIN_DIFFERS_LINE = ("thimble: Claude Code's thimble plugin (thimble@{name} {version}) differs from this install's, so "
                       "this session also loads this install's copy. To update it: claude plugin marketplace update "
                       "{name} && claude plugin update thimble@{name}")
LAUNCH_NOTES: list[str] = []  # lines installed_copy leaves for the launch's note line


def _plugin_files(root: Path) -> dict[str, tuple[bytes, bool]]:
    """Each file under `root` but COPY_IGNORED and COPY_LEFT_OUT: its path relative to `root` → (its bytes, whether it
    is executable)."""
    out: dict[str, tuple[bytes, bool]] = {}
    for p in root.rglob("*"):
        rel = p.relative_to(root)
        name = rel.as_posix()
        if (not p.is_file() or any(part in COPY_IGNORED for part in rel.parts) or p.suffix == ".pyc"
                or name.endswith(COPY_LEFT_OUT_SUFFIX)
                or any(name == x or name.startswith(f"{x}/") for x in COPY_LEFT_OUT)):
            continue
        out[name] = (p.read_bytes(), os.access(p, os.X_OK))
    return out


class Installed(NamedTuple):
    """The installed plugin copy main loads (installed_copy): the folder Claude Code runs it from and the marketplace
    it is installed from."""

    root: Path
    marketplace: str


class PluginFacts(NamedTuple):
    """The thimble plugin Claude Code has (plugin_facts): its marketplace ('' when none is added), its version, whether
    it is on, whether it is this install's (a directory marketplace at this tree, or a cache copy that finds this tree),
    the folder it runs from, whether its files equal this tree's plugin/, and the folder of the install it finds when it
    is another's."""

    marketplace: str = ""
    version: str = ""
    enabled: bool = False
    ours: bool = False
    root: Path | None = None
    same: bool = False
    other: str = ""


def _claude_json(claude: str, args: list[str], cwd: Path) -> list[Any]:
    """The list a `claude ... --json` listing prints, [] when it fails or prints something else."""
    r = subprocess.run([claude, *args, "--json"], cwd=cwd, capture_output=True, text=True,
                       timeout=PLUGIN_LIST_TIMEOUT_S, stdin=subprocess.DEVNULL, check=False, env=config.launch_environ())
    out = json.loads(r.stdout) if r.returncode == 0 and r.stdout.strip() else []
    return out if isinstance(out, list) else []


def _app_dir(root: Path) -> str:
    """The thimble folder a plugin copy at `root` finds (its bin/thimble-app-dir), '' when it finds none."""
    found = subprocess.run([str(root / "bin" / "thimble-app-dir")], capture_output=True, text=True,
                           timeout=PLUGIN_LIST_TIMEOUT_S, stdin=subprocess.DEVNULL, check=False)
    return found.stdout.strip() if found.returncode == 0 else ""


def own_version() -> str:
    """This install's plugin version (plugin/.claude-plugin/plugin.json), '' when it cannot be read."""
    rec = _read_json(PLUGIN_DIR / ".claude-plugin" / "plugin.json")
    return str(rec.get("version") or "") if isinstance(rec, dict) else ""


def plugin_facts(cwd: Path) -> PluginFacts | None:
    """Which thimble plugin Claude Code has for `cwd` (`claude plugin list --json` and `claude plugin marketplace list
    --json`), any `thimble@*`: this install's that is on first, then another's that is on, then this install's, then
    another's; PluginFacts() when none is added. None when `claude` is not found or the listing fails."""
    claude = shutil.which("claude")
    if not claude:
        return None
    try:
        listed = [p for p in _claude_json(claude, ["plugin", "list"], cwd)
                  if isinstance(p, dict) and str(p.get("id") or "").startswith(f"{PLUGIN_NAME}@")]
        if not listed:
            return PluginFacts()
        dirs = {str(m.get("name")): Path(str(m.get("path") or "")) for m in
                _claude_json(claude, ["plugin", "marketplace", "list"], cwd)
                if isinstance(m, dict) and m.get("source") == "directory"}
        here = config.REPO_ROOT.resolve()
        found: list[PluginFacts] = []
        for p in listed:
            mp = str(p["id"]).split("@", 1)[1]
            facts = {"marketplace": mp, "version": str(p.get("version") or ""), "enabled": p.get("enabled") is True}
            source = dirs.get(mp)
            if source is not None and source.is_absolute() and source.resolve() == here:
                found.append(PluginFacts(**facts, ours=True, root=PLUGIN_DIR.resolve(), same=True))
                continue
            root = Path(str(p.get("installPath") or ""))
            app = _app_dir(root) if root.is_absolute() and root.is_dir() else ""
            if app and Path(app).resolve() == here:
                found.append(PluginFacts(**facts, ours=True, root=root.resolve(),
                                         same=_plugin_files(root) == _plugin_files(PLUGIN_DIR)))
            else:
                found.append(PluginFacts(**facts, root=root if root.is_absolute() else None,
                                         other=app or (str(source) if source else str(root))))
    except (OSError, ValueError, subprocess.SubprocessError):
        return None
    return min(found, key=lambda f: (not f.enabled, not f.ours))


def installed_copy(cwd: Path) -> Installed | None:
    """The copy of this tree's plugin that Claude Code has installed and enables for `cwd` (plugin_facts), which every
    session loads already, so the launcher adds no copy of plugin/ with --plugin-dir: plugin/ itself for a directory
    marketplace at this tree, else a cache copy that finds this tree and whose files equal plugin/'s. When that copy's
    files differ it returns None, so the launcher loads plugin/ too, and leaves PLUGIN_DIFFERS_LINE in LAUNCH_NOTES.
    None when there is no such copy, it is off, or anything fails."""
    facts = plugin_facts(cwd)
    if facts is None or not (facts.ours and facts.enabled and facts.root is not None):
        return None
    if facts.same:
        return Installed(facts.root, facts.marketplace)
    LAUNCH_NOTES.append(PLUGIN_DIFFERS_LINE.format(name=facts.marketplace, version=facts.version or "?"))
    return None


def plugin_add_commands() -> str:
    """The commands that add this install's plugin to Claude Code, as install.sh runs them."""
    return (f"claude plugin marketplace add {config.REPO_ROOT} && claude plugin install --scope user "
            f"{PLUGIN_NAME}@{config.marketplace_name() or PLUGIN_NAME}")


def plugin_line(cwd: Path, commands: bool = True, facts: PluginFacts | None = None) -> str:
    """The doctor's plugin line: which thimble plugin Claude Code has (plugin_facts), and with `commands` the commands
    that fix it."""
    facts = plugin_facts(cwd) if facts is None else facts
    if facts is None:
        return "not checked: `claude plugin list --json` did not answer"
    if not facts.marketplace:
        return (f"not added: bash {config.REPO_ROOT / 'scripts' / 'install.sh'}, or {plugin_add_commands()}" if commands
                else "not added to Claude Code")
    name = f"{PLUGIN_NAME}@{facts.marketplace} {facts.version}".rstrip()
    if not facts.ours:
        switch = (f"; to use this install's: claude plugin uninstall {PLUGIN_NAME}@{facts.marketplace} && "
                  f"{plugin_add_commands()}" if commands else "")
        return f"{name}, {'on' if facts.enabled else 'off'}, from another install ({facts.other}){switch}"
    if not facts.same:
        mine = own_version()
        what = (f"version {facts.version} differs from this install's {mine}" if facts.version != mine else
                f"{name}'s files differ from this install's")
        return (f"{what}: claude plugin marketplace update {facts.marketplace} && claude plugin update "
                f"{PLUGIN_NAME}@{facts.marketplace}" if commands else what)
    return f"{name}, on, this install's" if facts.enabled else f"{name}, off (/plugin turns it on)"


def name_session(url: str, name: str, session: str, cwd: Path, sandbox: bool | None = None,
                 warnings: "list[str] | tuple[str, ...]" = ()) -> str | None:
    """Tell the server which Claude Code session asked (`POST /api/ws/{c}/session`), whether Claude Code's own sandbox
    is on in it (`sandbox`, own_sandbox_here; None when not known) and the keys of what its environment lacks
    (`warnings`, setup_warnings), whose words the server writes. Returns the session this one took main over from while
    it still runs in another terminal, else None."""
    body: dict[str, Any] = {"session": session, "cwd": str(cwd), "warnings": list(warnings)}
    if sandbox is not None:
        body["sandbox"] = sandbox
    try:
        status, body = _request("POST", f"{url}/api/ws/{urllib.parse.quote(name)}/session", body, timeout=3.0)
        if status != 200:
            _log(f"session {session} for {name}: {status} {str(body)[:200]}")
            return None
        replaced = body.get("replaced") if isinstance(body, dict) else None
        return str(replaced) if replaced else None
    except Exception as e:  # noqa: BLE001 — never a traceback in the skill text
        _log(f"session {session} for {name}: {type(e).__name__}: {e}")
        return None


# What /thimble says about a session the launcher did not start, which lacks what the launcher gives main: a line for
# each of UNSET_VARS its environment or its Claude Code settings set, and one for a shell proxy that no NO_PROXY keeps
# off 127.0.0.1. The model relays these lines, and the Stop hook shows them under the reply too (leave_link's notes);
# the server posts a `setup` notice for each key (setup_warnings), in words it writes itself (notices.setup_text).
SETUP_ENV_LINE = ("thimble: {name} is set in this session, so thimble's agents may not run on the models and efforts "
                  "Settings name. To fix it, quit, unset it and start claude again, or start with `thimble`, which "
                  "unsets it.")
SETUP_PROXY_LINE = ("thimble: your shell sets a proxy, so thimble's plugin may not reach thimble's server. Quit, add "
                    "127.0.0.1 and localhost to NO_PROXY, and start claude again.")
PROXY_VARS = ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy")
NO_PROXY_VARS = ("NO_PROXY", "no_proxy")
LOOPBACK_NAMES = ("127.0.0.1", "localhost", "*")  # a NO_PROXY entry that keeps thimble's requests off the proxy
PROXY_KEY = "proxy"  # setup_warnings' key for the proxy; `env:<NAME>` for a variable


def env_set_here(cwd: Path) -> list[str]:
    """The UNSET_VARS a session in `cwd` has: set in this process's environment (the session's), or by an `env` block
    of the analyst's Claude Code settings (cc_settings.settings_env), '' counting as unset."""
    from . import cc_settings  # noqa: PLC0415

    return [name for name in UNSET_VARS
            if os.environ.get(name, "").strip() or (cc_settings.settings_env(cwd, name) or "").strip()]


def proxy_unsafe() -> bool:
    """Whether this session's environment sets an HTTP proxy and no NO_PROXY or no_proxy names 127.0.0.1 or localhost,
    so a request of the plugin's to thimble's server could go to the proxy. NO_PROXY and no_proxy are read as the
    session gave them to this process (config.GIVEN_NO_PROXY), since config adds 127.0.0.1 to both as it loads."""
    if not any(os.environ.get(name, "").strip() for name in PROXY_VARS):
        return False
    named = {part.strip().lower() for name in NO_PROXY_VARS for part in config.GIVEN_NO_PROXY.get(name, "").split(",")}
    return not named & set(LOOPBACK_NAMES)


def setup_warnings(cwd: Path) -> list[str]:
    """The keys of setup_lines' cases for the server's `setup` notices: `env:<NAME>` and `proxy`."""
    return [*(f"env:{name}" for name in env_set_here(cwd)), *([PROXY_KEY] if proxy_unsafe() else [])]


def setup_lines(cwd: Path) -> list[str]:
    """What /thimble prints, and leaves for the Stop hook, for setup_warnings' cases."""
    return [*(SETUP_ENV_LINE.format(name=name) for name in env_set_here(cwd)),
            *([SETUP_PROXY_LINE] if proxy_unsafe() else [])]


def _sandbox_on(d: Any) -> bool:
    box = d.get("sandbox") if isinstance(d, dict) else None
    return isinstance(box, dict) and box.get("enabled") is True


def own_sandbox_set(cwd: Path) -> bool:
    """Whether Claude Code's own sandbox is turned on for the session this command runs in, or for a session in `cwd`:
    by the analyst's settings for `cwd` (cc_settings.own_sandbox), the `--settings` of this session's `claude`
    (cc_plugin.settings_arg) or the org's managed settings (cc_plugin.managed)."""
    from . import cc_settings  # noqa: PLC0415

    if cc_settings.own_sandbox(cwd):
        return True
    pid = cc_plugin.claude_pid()
    flags = cc_plugin.settings_arg(procs.argv(pid), cwd) if pid else None
    return _sandbox_on(flags) or _sandbox_on(cc_plugin.managed())


def own_sandbox_here(cwd: Path) -> bool:
    """Whether Claude Code's own sandbox runs in this session: it can run on this machine (cc_settings.sandbox_ok) and
    it is turned on (own_sandbox_set). thimble neither needs it nor turns it on; Settings and the doctor say which."""
    from . import cc_settings  # noqa: PLC0415

    return cc_settings.sandbox_ok() and own_sandbox_set(cwd)


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


# --------------------------------------------------------------------------- launch.json and the launcher
#
# launch.json in the workspace (LAUNCH_FILE) names main, its transport, its peers and the sessions moved from main:
# {session, pid, config_dir, via, transport, at, peers, moved}. Activation alone writes it (app/activate.py
# write_launch); a press of the browser workbench makes the pressing session main with transport `server` (made_main).
# The hooks module's bridge accepts a hello only from main (module_bridge), and `doctor` reads it.
#
# The `thimble` command is `claude` itself (plugin/bin/thimble): it exports THIMBLE_OPEN=1, which presses home at the
# session's start, NO_PROXY for 127.0.0.1, and the tools that end a turn without text (terminal_tools.ENV), loads this
# install's plugin with --plugin-dir when Claude Code has not installed it, and gives `/thimble open` as the first prompt
# where Claude Code will not load the hooks module (modules_off). launch_args finds those values; the launcher keeps
# them in <home>/launcher.json under a key of the files they depend on, so a launch whose files did not change starts
# `claude` without starting this Python.

LAUNCH_FILE = "trusted/launch.json"  # in the workspace (subagent_files): {session, pid, config_dir, via, transport, at, peers, moved}
CARD_RUNNER = "bin/thimble-run"  # under the plugin copy: runs a card's code in the caller's Bash (`thimble-run card <cell>`)
RUNNER_NAME = "thimble-run"  # the card runner by its name on the session's PATH, as the tools give its command
NO_MODULE_ENV = "THIMBLE_NO_MODULE"  # set, main starts with thimble's hooks module idle (the live checks' switch)
EFFORT_ENV = "CLAUDE_CODE_EFFORT_LEVEL"
# the variables of a shell that override the models and efforts thimble's agents run on: the effort variable would
# override every agent's effort (spike m7), the subagent model would replace the model the agents' general-purpose and
# Explore children inherit (V7), and its FORCE companion every registered type's model as well; /thimble's setup
# warnings name each one set (setup_warnings, notices.setup_text)
UNSET_VARS = (EFFORT_ENV, "CLAUDE_CODE_SUBAGENT_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL_FORCE")
SAFE_MODE_ENV = "CLAUDE_CODE_SAFE_MODE"
SAFE_MODE_LINE = ("thimble: WARNING - Claude Code's safe mode is on (CLAUDE_CODE_SAFE_MODE or --safe-mode), which turns "
                  "thimble's plugin off: this session gets no thimble tools, hooks or /thimble, and thimble's agents "
                  "can't start. Run `thimble` without it.")
MODULES_OFF_LINE = ("thimble's agents can't start in this session: Claude Code's hooks modules are off ({reason}). Main, "
                    "its threads, cards and labels still work.")
LAUNCHER_FILE = "launcher.json"  # in <home>: {key: {load, turn_tools, modules_off, notes, at}} (launch_args)
LAUNCHER_KEPT = 32  # the keys launcher.json keeps, the newest


def given_settings(cwd: Path, given: str) -> Any:
    """The analyst's own --settings to the launcher, `given` (inline JSON, or a file relative to `cwd`), parsed; None
    when there are none or they cannot be read."""
    if not given:
        return None
    try:
        return json.loads(given if given.lstrip().startswith("{") else (cwd / Path(given).expanduser()).read_text("utf-8"))
    except (OSError, ValueError):
        return None


def modules_off(cwd: Path, given: str = "") -> str:
    """Why Claude Code will not load thimble's hooks module in a session in `cwd`, as far as a command can tell: the
    org's managed settings turn hooks modules off (`disableAllHooks`, or `allowManagedHooksOnly` without thimble
    enabled there, or the security plugin's `allowManagedModsOnly`, cc_plugin.managed_mods_only), the analyst's settings
    or `given` --settings set `disableAllHooks`, or NO_MODULE_ENV is set; '' otherwise. An untrusted folder or Claude
    Code's own switch shows only in the session."""
    tier = cc_plugin.managed() or {}
    if tier.get("disableAllHooks") is True:
        return "your organization's managed settings set disableAllHooks"
    if tier.get("allowManagedHooksOnly") is True:
        enabled = tier.get("enabledPlugins")
        if not (isinstance(enabled, dict) and any(str(k).startswith(f"{PLUGIN_NAME}@") and v is True
                                                  for k, v in enabled.items())):
            return "your organization's managed settings set allowManagedHooksOnly"
    if cc_plugin.managed_mods_only():
        return f"your organization's managed settings set {cc_plugin.MODS_ONLY}"
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
    """Register the folder `cwd` as a corpus, as activation does (open_workspace with `here`: the folder itself, with
    the path the analyst named it by, caller_alias); its name. None for a folder `up` refuses ($HOME or /) or one that
    cannot be registered."""
    if refused(cwd):
        return None
    told, alias = caller_alias(cwd)
    try:
        rec = config.register_corpus(cwd, exact=True, shown=alias if told else config.KEEP_SHOWN)
    except (OSError, ValueError) as e:
        _log(f"activation: {cwd} was not registered: {e}")
        return None
    return str(rec.get("name") or "") or None


EXTENSIONS_WAIT_S = 15.0


def local_extensions(c: str) -> None:
    """Find the workspace's extensions again in this process, with no server, so the agent types the hooks module
    registers include the active extensions' agents (extensions become active for a workspace only in a refresh, spike
    U4); activation runs it. Never raises."""
    try:
        import asyncio  # noqa: PLC0415

        from . import extensions  # noqa: PLC0415 — the extensions, needed by this subcommand alone

        async def go() -> None:
            await asyncio.wait_for(extensions.refresh(c), EXTENSIONS_WAIT_S)

        asyncio.run(go())
    except Exception as e:  # noqa: BLE001 — the session starts on the extensions found last time
        _log(f"activation: the extensions of {c} were not found again: {type(e).__name__}: {e}")


def write_roles(c: str) -> None:
    """Write the hooks module's roles file, trusted/roles.json (module_bridge.roles_file), which the module registers
    thimble's agent types from on local transport; activation runs it. Never raises: without the file the module
    registers no thimble agent, and the doctor says so."""
    try:
        from . import module_bridge  # noqa: PLC0415 — the session modules, needed by this subcommand alone

        module_bridge.roles_file(c)
    except Exception as e:  # noqa: BLE001 — activation goes on
        _log(f"activation: the roles file of {c} was not written: {type(e).__name__}: {e}")


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
    back after it: what activation registers and writes must be where the server reads it, which this process's own
    defaults need not be."""
    env = resolve_env()
    held = config.DATA_DIR, config.WORKSPACES_DIR
    config.DATA_DIR = Path(env["data_dir"]).expanduser().resolve()
    config.WORKSPACES_DIR = Path(env["workspaces_dir"]).expanduser().resolve()
    try:
        yield
    finally:
        config.DATA_DIR, config.WORKSPACES_DIR = held


def launch_args(cwd: Path, key: str = "", settings: str = "", safe_mode: bool = False) -> str:
    """The launcher's values, one per line: the plugin folder to load with `--plugin-dir` ('' when the plugin copy is
    one Claude Code has installed and enables, installed_copy), the value to export as terminal_tools.ENV ('' when the
    `claude` it starts does not read it), why Claude Code will not load thimble's hooks module in a session in `cwd`
    (modules_off; '' when it will), and the note lines to print before Claude Code starts (tab-separated). With `key`
    (the launcher's key of the files these depend on) they are kept in <home>/launcher.json under it. No folder is
    registered and no server starts: the session turns thimble on itself (THIMBLE_OPEN)."""
    from . import terminal_tools  # noqa: PLC0415 — needed by this subcommand alone

    LAUNCH_NOTES.clear()
    installed = installed_copy(cwd)
    root = installed.root if installed else plugin_root()
    load = "" if installed or cc_plugin.marketplace(root) != cc_plugin.INLINE else str(root)
    notes: list[str] = list(LAUNCH_NOTES)
    LAUNCH_NOTES.clear()
    why_idle = modules_off(cwd, settings)
    if why_idle:
        notes.append(MODULES_OFF_LINE.format(reason=why_idle))
    if safe_mode or os.environ.get(SAFE_MODE_ENV, "").strip() not in ("", "0", "false"):
        notes.append(SAFE_MODE_LINE)
    warning = claude_code_warning(claude_code_version())
    if warning:
        notes.append(warning)
    values = {"load": load, "turn_tools": terminal_tools.launch_value(), "modules_off": why_idle,
              "notes": [" ".join(n.split()) for n in notes]}
    if key:
        _keep_launch(key, values)
    return "\n".join([values["load"], values["turn_tools"], values["modules_off"], "\t".join(values["notes"])])


def _keep_launch(key: str, values: dict[str, Any]) -> None:
    """`values` kept in <home>/launcher.json under `key`, with the LAUNCHER_KEPT newest others. Never raises."""
    path = home() / LAUNCHER_FILE
    try:
        ensure_home()
        held = _read_json(path)
        held = held if isinstance(held, dict) else {}
        held.pop(key, None)
        kept = dict(list(held.items())[-(LAUNCHER_KEPT - 1):])
        kept[key] = {**values, "at": _now()}
        _write_private(path, kept)
    except OSError as e:
        _log(f"launch-args: {path} was not written: {e}")


def cmd_launch_args(args: argparse.Namespace) -> int:
    print(launch_args(Path(args.cwd or os.environ.get("THIMBLE_CALLER_CWD") or os.getcwd()), args.key or "",
                      args.settings or "", safe_mode=bool(args.safe_mode)))
    return 0


# the SessionStart hook's lead before main's guide, after /clear or /compact, in a session without the terminal UI
# (the hooks module): Claude Code shows a hook's output of more than about 10,000 characters only in part, with the file
# that holds all of it
def session_marker(session: str) -> dict[str, Any] | None:
    """The session marker activation writes, <home>/up/<session>.active (C1: {cwd, ws, path, via, role, mod, at}); None
    when the session never turned thimble on, or the file cannot be read."""
    path = hook_marker_path(session)
    if path is None:
        return None
    got = _read_json(path)
    return got if isinstance(got, dict) else None


def cmd_prompt(args: argparse.Namespace) -> int:
    """Print prompt files for a skill's injected command. A missing file prints the loader's error line; --lead is
    printed first. `prompt main --if-active --unless-mod --session <sid>` is the SessionStart hook's for /clear and
    /compact (3.4, point 9): main's guide (guide.render, checked and marked sent in one step: guide.take_if_owed, made
    owed again first after a compaction), only for a session whose marker says thimble is on there and that no mod ran
    activation in (`mod`), and only when main itself cleared or compacted, not one of its subagents (main_itself). With
    the terminal UI the mod delivers the guide itself, and this prints nothing."""
    cwd = Path(args.cwd or os.environ.get("THIMBLE_CALLER_CWD") or os.getcwd())
    lead = (getattr(args, "lead", None) or "").strip()
    if getattr(args, "if_active", False):
        session = (getattr(args, "session", None) or os.environ.get("CLAUDE_CODE_SESSION_ID") or "").strip()
        marker = session_marker(session) if session else None
        if marker is None or (getattr(args, "unless_mod", False) and marker.get("mod") is True):
            return 0
        hook = _hook_input()
        if not main_itself(hook) or list(args.names) != ["main"]:
            return 0
        from . import guide  # noqa: PLC0415 — the guide, needed by this subcommand alone

        folder = str(Path(str(marker.get("cwd") or cwd)).resolve())
        try:
            if str(hook.get("source") or "") == "compact":
                guide.unmark(folder, session)
            text = guide.take_if_owed(folder, session)
        except Exception as e:  # noqa: BLE001 — the hook prints nothing rather than a traceback
            _log(f"prompt main: the guide for session {session} was not printed: {type(e).__name__}: {e}")
            return 0
        if text:
            print(f"{lead}\n\n{text}" if lead else text)
        return 0
    from . import events, prompts  # noqa: PLC0415 — the renderer, needed by this subcommand alone

    try:
        text = events.render_prompts(args.names, str(cwd.resolve()))
    except prompts.PromptError as e:
        print(f"thimble: {e}")
        return 1
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
    up = serves(url)
    parts = [f"server {'up' if up else 'down'} at {url}", f"orientation: {orient_status(name)}",
             f"queue: {queue_depth(url, name) if up else 'n/a'}"]
    return "thimble: " + "; ".join(parts)


# ----------------------------------------------------------------------------- doctor


def is_git_checkout() -> bool:
    """Whether this tree is a development install, a git clone of thimble. A release install is a git repository too
    (install.sh's baseline, so code tickets run in it) and carries RELEASE.json."""
    return (config.REPO_ROOT / ".git").exists() and not (config.REPO_ROOT / "RELEASE.json").is_file()


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
        return f"not logged in: {config.AUTH_HELP}; nothing that calls a model runs until then"
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
    """The doctor's `bash sandbox` line: whether Claude Code's Bash sandbox can run (cc_settings.sandbox_ok), which
    `thimble fix` and extension programs run their Bash in where it runs, unless thimble's config says `sandbox.use`
    "never"; when it cannot run, what it lacks and with `commands` the root commands that install it. Without it they
    run as they are: `thimble fix` asks first (dev.FIX_QUESTION) and an extension program posts a notice, unless
    `sandbox.enforce` refuses them."""
    from . import cc_settings, userconf  # noqa: PLC0415

    head = "  bash sandbox (thimble fix and extension programs): "
    try:
        missing = cc_settings.sandbox_missing()
        cmds, what = cc_settings.sandbox_setup() if missing else ([], "")
    except Exception as e:  # noqa: BLE001 — the doctor reports; it never fails on one of its lines
        return [f"{head}not checked ({type(e).__name__})"]
    try:
        box = userconf.load_or_defaults()[0]["sandbox"]
    except Exception:  # noqa: BLE001
        box = userconf.DEFAULTS["sandbox"]
    without = ("thimble's config (sandbox.enforce) refuses to start them without it" if box.get("enforce") else
               "they run without it (thimble fix asks you first; an extension program's notice says so)")
    if box.get("use") == "never":
        return [f"{head}off in thimble's config (sandbox.use \"never\"); {without}"]
    if not missing:
        from . import ticket_box  # noqa: PLC0415

        why = ticket_box.problem()
        tickets = ("a code ticket's checks and test server run in thimble's sandbox runtime, and its change reaches "
                   "thimble's own code only once you allow it" if not why else
                   f"a code ticket runs its checks and test server outside it, so it asks you before it starts: {why}")
        return [f"{head}runs; {tickets}"]
    line = f"{head}off, missing " + ", ".join(missing) + f"; {without}"
    if not cmds or not commands:
        return [line + (f"; {what}" if what else "")]
    return [f"{line}. To turn it on, run these, which {what}, then `thimble restart`:", *(f"    {c}" for c in cmds)]


def own_sandbox_line(cwd: Path) -> str:
    """The doctor's line on Claude Code's own sandbox for a session in `cwd` (own_sandbox_here), which thimble neither
    needs nor turns on: main's Bash runs in it when the analyst turns it on, and Claude Code then adds an empty
    .claude/.cc-writes/ folder to `cwd`."""
    from . import cc_settings  # noqa: PLC0415

    if own_sandbox_here(cwd):
        return (f"on, so main's Bash adds an empty .claude/.cc-writes/ folder to {cwd}. That is Claude Code's sandbox in "
                "your own session, which thimble leaves as it is")
    if own_sandbox_set(cwd):
        missing = cc_settings.sandbox_missing()
        return ("on in your settings, but it can't run here" + (f" (missing: {', '.join(missing)})" if missing else "")
                + "; the bash sandbox line says what installs it")
    return "off (optional: INSTALL.md shows the settings that turn it on)"


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
    """The doctor's line on thimble's hooks module for a session in `cwd`: what keeps Claude Code
    from loading it (modules_off, an untrusted folder), else what the last session here recorded (subagents.json's
    `module`: its hello, or why it stayed idle; on local transport, before a press, local_module_notes). thimble's
    agents cannot start without it."""
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
    if c and launch.get("transport") != "server" and launch.get("mode") != "browser" and launch:
        return "; ".join([*local_module_notes(config.workspace_path(c)), *notes])
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
        notes.insert(0, "no session here has run it yet (it starts once thimble is on in a session here); "
                        "thimble's agents cannot start without it")
    return "; ".join(notes)


MODULE_OUT = "trusted/module.json"  # in the workspace: what the hooks module writes on local transport
ROLES_FILE = "trusted/roles.json"  # in the workspace: the roles the module registers on local transport (write_roles)


def local_module_notes(ws: Path) -> list[str]:
    """The module line's notes for a workspace folder `ws` whose main runs on local transport, where the module reads
    its roles from ROLES_FILE and writes its heartbeat to MODULE_OUT, and no server hears from it: its last heartbeat,
    with its version and the problem it reported, else that no session ran it; and a missing roles file."""
    try:
        out = _read_json(ws / MODULE_OUT)
    except (OSError, ValueError):
        out = None
    if isinstance(out, dict) and out.get("session"):
        beat = out.get("beat")
        if isinstance(beat, (int, float)) and not isinstance(beat, bool) and beat > 0:  # the module's milliseconds
            beat = datetime.fromtimestamp(beat / 1000, timezone.utc).isoformat(timespec="seconds")
        note = (f"it ran in the last session (heartbeat from {str(out['session'])[:8]} at {beat or '?'}"
                + (f", version {out['version']}" if out.get("version") else "") + ")")
        notes = [note + (f"; it reported: {out['problem']}" if out.get("problem") else "")]
    else:
        notes = ["no session here has run it yet (it writes trusted/module.json once thimble is on in a session "
                 "here); thimble's agents cannot start without it"]
    if not (ws / ROLES_FILE).is_file():
        notes.append("activation wrote no roles file (trusted/roles.json), so the module registers none of thimble's "
                     "agents")
    return notes


def server_json_line() -> str:
    """The doctor's line on server.json's permissions: 0600 (write_state), else a warning with the fix, since it holds
    the token that proves thimble's own requests."""
    p = server_json()
    try:
        mode = p.stat().st_mode & 0o777
    except OSError:
        return "absent"
    if mode & 0o077:
        return f"WARNING - {p} is readable by others ({oct(mode)}); run: chmod 600 {p}"
    return f"present, {oct(mode)}"


def markers_line() -> str:
    """The doctor's line on the markers thimble keeps under its home: the sessions turned on (up/<sid>.active) and the
    folders opened (active/<folder>, which 0.8.0 wrote and activation still writes for a hook that gets no session
    id)."""
    sessions = len(list((home() / HOOK_RESULTS_DIR).glob(f"*{HOOK_MARKER_SUFFIX}"))) if (home() / HOOK_RESULTS_DIR).is_dir() else 0
    folders = len(list((home() / ACTIVE_DIR).iterdir())) if (home() / ACTIVE_DIR).is_dir() else 0
    return f"{sessions} session marker{'' if sessions == 1 else 's'}, {folders} folder marker{'' if folders == 1 else 's'}"


def opener_lines() -> list[str]:
    """The doctor's lines on how a press opens the browser (opener.doctor_lines: the opener, or the SSH tunnel line in a
    remote session); none in a tree without the press."""
    if importlib.util.find_spec(f"{__package__}.opener") is None:
        return []
    from . import opener  # noqa: PLC0415

    got = opener.doctor_lines()
    return [str(x) for x in got] if isinstance(got, (list, tuple)) else [str(got)]


def transport_line(cwd: Path) -> str:
    """The doctor's line on how a session in `cwd` reaches thimble (subagent_files.transport): local until a press of the
    browser workbench, the server after it, and the peers and moved sessions launch.json names."""
    from . import subagent_files  # noqa: PLC0415 — standard library only

    c = config.workspace_for_cwd(str(cwd))
    if not c:
        return "thimble is not on in this folder yet (a data read, /thimble or load_thimble turns it on)"
    ws = config.workspace_path(c)
    rec = read_launch(c)
    kind = subagent_files.transport(ws)
    main = subagent_files.main_session(ws)
    text = (f"{kind} for main {main[:8]}" if main else kind) + (" (after a press of the browser workbench)"
                                                                if kind == subagent_files.SERVER else " (no server)")
    peers, moved = subagent_files.peers(ws), subagent_files.moved(ws)
    if peers:
        text += f"; {len(peers)} peer session{'' if len(peers) == 1 else 's'}, local"
    if moved:
        text += f"; {len(moved)} session{'' if len(moved) == 1 else 's'} moved from main"
    if "transport" not in rec and rec.get("mode"):
        text += f"; launch.json is 0.8.0's ({rec['mode']} mode)"
    return text


def bash_card_line() -> str:
    """The doctor's line on where a card's code runs: in main's Bash, through the card runner, which the permission mode
    decides on, before and after a press; a card check's trial in the sandbox runtime where it runs
    (cardrun.trial_sandbox)."""
    return ("runs in main's Bash with your user's access; Claude Code asks about or judges each thimble-run command, as "
            "for any command; a card check's trial runs in the sandbox runtime where it can run")


def terminal_views_wrap() -> str:
    """The sandbox the terminal's views run in (term_views.sandbox_argv's choice): `srt`, `bubblewrap`, or '' where
    neither runs, which leaves the terminal without views."""
    from . import kernel_wrap, srt  # noqa: PLC0415

    node = srt.node()
    if not node:
        return ""
    if kernel_wrap.srt_works(node, srt.package(config.REPO_ROOT)):
        return "srt"
    return "bubblewrap" if sys.platform.startswith("linux") and kernel_wrap.works() else ""


def terminal_views_line(commands: bool = True) -> str:
    """The doctor's line on the terminal's views: the sandbox they run in, or that they can't run, and with `commands`
    the commands that add bubblewrap."""
    from . import cc_settings, srt  # noqa: PLC0415

    wrap = terminal_views_wrap()
    if wrap:
        return wrap
    if not srt.node():
        return f"can't run (Node is not installed, and a terminal view runs in Node {NODE_MIN_MAJOR}+)"
    cmds, what = cc_settings.kernel_setup() if commands else ([], "")
    fix = f"; to add bubblewrap, run: {' && '.join(cmds)}" if cmds else (f"; {what}" if what else "")
    return f"can't run (neither the sandbox runtime nor bubblewrap runs here){fix}"


def terminal_checks_line() -> str:
    """The doctor's line on the card checks and screenshots of a session on local transport, which are optional there:
    they draw a card in a headless Chromium with the built frontend (render.py), and are skipped without either."""
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

TESTED_CLAUDE_CODE = "2.1.300"  # INSTALL.md and README.md name the same version (test_cli.py)
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


KERNEL_REACH = ("code from main and thimble's agents reaches it through a thimble tool call, which follows your "
                "permission mode, and a card check's revision runs on it unasked")


def kernel_line(commands: bool = True) -> str:
    """The doctor's `card code` line: the sandbox a notebook kernel starts in where its workspace names none
    (config.resolve_kernel_wrap), why it is not the sandbox runtime when it is not, on Linux without one and with
    `commands` the commands that add bubblewrap (cc_settings.kernel_setup), and what reaches the kernel
    (KERNEL_REACH)."""
    from . import cc_settings, srt  # noqa: PLC0415

    wrap, source = config.resolve_kernel_wrap({})
    by = f" ({config.KERNEL_WRAP_ENV})" if source == "env" else ""
    bounds = "it reads the corpus and the workspace, writes only the workspace, and keeps the network"
    if wrap == config.KERNEL_WRAP_SRT:
        engine = "Seatbelt" if sys.platform == "darwin" else "bubblewrap"
        return f"runs in Anthropic's sandbox runtime{by} ({engine}): {bounds}; {KERNEL_REACH}"
    why = "" if by else srt.missing(config.REPO_ROOT, srt.node()) or "the sandbox runtime can't run here"
    if wrap == config.KERNEL_WRAP_BWRAP:
        return f"runs in bubblewrap{by}{f' ({why})' if why else ''}: {bounds}; {KERNEL_REACH}"
    cmds = cc_settings.kernel_setup()[0] if commands and sys.platform.startswith("linux") else []
    fix = f"; to sandbox it, run: {' && '.join(cmds)}" if cmds else ""
    return f"runs unsandboxed, with your user's access{by}{f' ({why})' if why else ''}{fix}; {KERNEL_REACH}"


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


def network_probe(status: dict[str, Any] | None = None, timeout_s: float = NET_TIMEOUT_S) -> tuple[bool | None, str]:
    """(whether a TCP connection to the API host on 443 opens within `timeout_s`, why not), with a thread bounding the
    name lookup, which has no timeout of its own. Nothing is sent. (None, why) when it is not checked: for a provider
    other than Anthropic's API, as `status` (config.auth_status) names it, or inside Claude Code's Bash sandbox."""
    host = api_host()
    provider = (status or {}).get("apiProvider")
    if provider and provider != "firstParty":
        return None, f"model calls go to {provider}"
    if in_sandbox():  # the sandbox's own network namespace has no route out, whatever the machine has
        return None, "this runs inside Claude Code's Bash sandbox, which has no network (run `thimble doctor` in a terminal)"
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
        return True, ""
    return False, result[0] if result else f"no answer within {timeout_s:.0f} s"


def network_line(status: dict[str, Any] | None = None, timeout_s: float = NET_TIMEOUT_S) -> str:
    """The doctor's network line (network_probe)."""
    ok, why = network_probe(status, timeout_s)
    if ok is None:
        return f"not checked: {why}"
    host = api_host()
    return f"{host} answers" if ok else f"cannot reach {host} ({why}); model calls fail until the network is back"


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
    lines.append(f"  delivery (a session in {caller}): {_checked(delivery_line, caller)}")
    lines.append(f"  your session's bash sandbox: {_checked(own_sandbox_line, caller)}")
    lines.append(f"  plugin: {_checked(plugin_line, caller, commands)}")
    with server_dirs():
        lines.append(f"  safe mode: {_checked(safe_mode_line)}")
        lines.append(f"  hooks module (thimble's agents start through it): {_checked(module_line, caller)}")
        lines.append(f"  transport (a session in {caller}): {_checked(transport_line, caller)}")
        lines.append(f"  card code in main's Bash: {_checked(bash_card_line)}")
        lines.append(f"  card checks in the terminal (optional): {_checked(terminal_checks_line)}")
        lines.append(f"  views in the terminal: {_checked(terminal_views_line, commands)}")
    lines.append(f"  server.json: {_checked(server_json_line)}")
    lines.append(f"  markers: {_checked(markers_line)}")
    try:
        lines += [f"  {ln}" for ln in opener_lines()]
    except Exception as e:  # noqa: BLE001 — the doctor reports; it never fails on one of its lines
        lines.append(f"  browser opener: not checked ({type(e).__name__})")
    lines.append(f"  config: {_checked(config_line, Path(env['workspaces_dir']))}")
    lines.append(f"  browser: {_checked(browser_line)}")
    lines.append(f"  card code: {_checked(kernel_line, commands)}")
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


# ----------------------------------------------------------------------------- the doctor's checklist
#
# `thimble doctor` prints a checklist a person reads (doctor_check_text): one line per area, ✓ or !, in plain words, and
# under a problem one line with its fix and where to run it. The checks (doctor_checks) are built from the same facts as
# the verbose lines above, never from their text; `thimble doctor --verbose`, `thimble feedback` and `thimble fix` keep
# doctor_text.

CHECK_LINE_MAX = 80  # a ✓ or ! line, its mark included
FIX_LINE_MAX = 100  # a fix line, its indent included
DETAILS_LINE = "Details: thimble doctor --verbose"
VERBOSE_FIX = "thimble doctor --verbose"  # where a fix line sends the analyst for what the checklist leaves out


class Check(NamedTuple):
    """One line of the doctor's checklist: fine or not, what it says, and under a problem the fix with where it runs."""

    ok: bool
    line: str
    fix: str = ""


def _fit(text: str, limit: int) -> str:
    """`text` cut at a word to at most `limit` characters, with "…" where it was cut."""
    text = " ".join(text.split())
    if len(text) <= limit:
        return text
    cut = text[: limit - 1].rsplit(" ", 1)[0].rstrip(",;:")
    return f"{cut}…"


def _tilde(path: Path | str) -> str:
    """`path` with the home folder written `~`."""
    p, h = str(path), str(Path.home())
    return "~" + p[len(h):] if p == h or p.startswith(h + os.sep) else p


def _version_check() -> Check:
    v = claude_code_version()
    head = _thimble_named()
    if v is None:
        return Check(True, head)
    case = claude_code_case(v)
    if case == TOO_OLD:
        return Check(False, f"Claude Code {v} is older than thimble needs ({MODS_CLAUDE_CODE})",
                     "In a shell: claude update")
    note = {NEWER: f" (newer than the tested {TESTED_CLAUDE_CODE})",
            OLDER: f" (older than the tested {TESTED_CLAUDE_CODE})"}.get(case or "", "")
    return Check(True, f"{head} · Claude Code {v}{note}")


def _sign_in_check() -> Check:
    if not config.CLI_PATH:
        return Check(False, "Claude Code is not installed", "Install Claude Code, or name its path with THIMBLE_CLAUDE_BIN")
    status = config.auth_status()
    if status is None:
        return Check(False, "Claude Code did not say whether you are signed in", "In a shell: claude auth status")
    if status.get("loggedIn") is False:
        return Check(False, "Not signed in to Claude", "In a shell: claude auth login")
    if network_probe(status)[0] is False:
        return Check(False, "Claude's API doesn't answer from here",
                     f"Check your network or proxy; {VERBOSE_FIX} has details")
    return Check(True, "Signed in to Claude")


def _server_check() -> Check:
    st = read_state()
    p = int(st.get("port") or port())
    url = api_url(p)
    if serves(url):
        return Check(True, "Server running")
    stuck = stuck_server(url)
    if stuck:
        return Check(False, f"The server is stuck (pid {stuck})", "In a shell: thimble server restart")
    if listening(p) and explicit_port() is not None:  # without THIMBLE_PORT the next start passes over it (pick_port)
        return Check(False, f"Port {p} is taken by another program",
                     "In a shell: stop that program, then thimble server restart")
    return Check(True, "Server not running (it starts when you press ↗ or type /thimble open)")


def _plugin_check(cwd: Path) -> Check:
    facts = plugin_facts(cwd)
    if facts is None:
        if not config.CLI_PATH:
            return Check(False, "Plugin not checked, since Claude Code is not installed",
                         "Install Claude Code, then run thimble doctor again")
        return Check(False, "Plugin not checked: Claude Code did not list its plugins", "In a shell: claude plugin list")
    if not facts.marketplace or not (facts.ours or facts.enabled):
        fix = f"In a shell: bash {_tilde(config.REPO_ROOT / 'scripts' / 'install.sh')}"
        return Check(False, "Plugin not added to Claude Code",
                     fix if len(fix) + 2 <= FIX_LINE_MAX else f"{VERBOSE_FIX} names the commands that add it")
    if not facts.ours:
        return Check(False, "Another install's plugin is on", f"{VERBOSE_FIX} names the commands that switch it")
    if not facts.enabled:
        return Check(False, "Plugin is off in Claude Code", "In the Claude Code terminal: /plugin, then turn thimble on")
    if not facts.same:
        mine = own_version()
        what = f"Plugin {facts.version} differs from this install's {mine}" if facts.version != mine else \
            "Plugin differs from this install's files"
        return Check(False, what, f"In a shell: claude plugin update {PLUGIN_NAME}@{facts.marketplace}")
    return Check(True, "Plugin on in Claude Code")


def _sandbox_check(cwd: Path) -> Check:
    if own_sandbox_here(cwd):
        return Check(True, "Claude Code's sandbox: on")
    if own_sandbox_set(cwd):
        return Check(False, "Claude Code's sandbox is on in your settings but can't run here",
                     f"{VERBOSE_FIX} names what to install")
    return Check(True, "Claude Code's sandbox: off (optional)")


def _card_code_check() -> Check:
    wrap, source = config.resolve_kernel_wrap({})
    if wrap in (config.KERNEL_WRAP_SRT, config.KERNEL_WRAP_BWRAP):
        return Check(True, "Card code runs in a sandbox")
    if source == "env":
        why = f"{config.KERNEL_WRAP_ENV} says so"
    elif sys.platform.startswith("linux"):
        why = "no bubblewrap" if not shutil.which("bwrap") else "bubblewrap can't make one here"
    else:
        why = "the sandbox runtime can't run here"
    return Check(True, f"Card code runs without a sandbox ({why})")


def _views_check() -> Check:
    exe = shutil.which("node")
    v = None
    if exe:
        try:
            v = version_tuple(subprocess.run([exe, "--version"], capture_output=True, text=True, timeout=10).stdout)
        except (OSError, subprocess.SubprocessError):
            v = None
    fix_node = f"Install Node {NODE_MIN_MAJOR} or later, then in a shell: thimble server restart"
    if not exe:
        return Check(False, "Node not found, so custom views can't run", fix_node)
    if v and v[0] < NODE_MIN_MAJOR:
        return Check(False, f"Node {'.'.join(map(str, v))} is too old, so custom views can't run", fix_node)
    which, _ = _browser_choice()
    if which == "off":
        return Check(True, "Views ready; screenshots off (no browser chosen)")
    if which != "system":
        spec = importlib.util.find_spec("playwright")
        backend = headless_fetched(Path(spec.origin).parent / "driver" / "package" / "browsers.json" if spec and
                                   spec.origin else Path("-"))
        front_json = FRONTEND_DIR / "node_modules" / "playwright-core" / "browsers.json"
        front = not front_json.is_file() or headless_fetched(front_json)
        if not (backend and front):
            return Check(False, "No browser for screenshots", "In a shell: thimble update --browser bundled")
    return Check(True, "Views and screenshots ready")


def _hooks_fix(why: str) -> str:
    """The fix line for modules_off's reason `why`."""
    if why.startswith(NO_MODULE_ENV):
        return f"In a shell: unset {NO_MODULE_ENV}, then restart claude"
    setting = next((s for s in ("allowManagedHooksOnly", cc_plugin.MODS_ONLY) if s in why), "disableAllHooks")
    if "organization" in why:
        return f"Ask your administrator: your organization's Claude Code settings set {setting}"
    return f"In your Claude Code settings: remove {setting}, then restart claude"


def _agents_check(cwd: Path) -> Check:
    why = modules_off(cwd)
    if why:
        return Check(False, "thimble's agents can't start: Claude Code's hooks are off", _hooks_fix(why))
    c = config.workspace_for_cwd(str(cwd))
    if c and folder_trusted(cwd) is False:  # a folder thimble never opened: Claude Code asks when claude starts there
        return Check(False, "Claude Code doesn't trust this folder yet", "In a shell: run claude here and accept the prompt")
    launch = read_launch(c)
    again = "In the Claude Code terminal: /thimble"
    if launch.get("modules_off"):
        return Check(False, "thimble's agents didn't start in the last session: hooks were off", _hooks_fix(
            str(launch["modules_off"])))
    from . import subagent_files  # noqa: PLC0415 — standard library only

    if c and launch and subagent_files.transport(config.workspace_path(c)) == subagent_files.LOCAL:
        out = _read_json(config.workspace_path(c) / MODULE_OUT)
        if isinstance(out, dict) and out.get("problem"):
            return Check(False, "thimble's agents reported a problem in the last session",
                         f"{again}, then see {VERBOSE_FIX}")
        if isinstance(out, dict) and out.get("session"):
            return Check(True, "thimble's agents can start in this folder")
        return Check(True, "thimble's agents start once thimble is on here")
    try:
        from . import subagent_files  # noqa: PLC0415 — standard library only

        rec = (_read_json(subagent_files.state_path(config.workspace_path(c))) or {}).get("module") if c else None
    except (OSError, ValueError, KeyError, AttributeError):
        rec = None
    if isinstance(rec, dict) and rec.get("idle"):
        return Check(False, "thimble's agents didn't start in the last session", f"{again}; {VERBOSE_FIX} says why")
    if isinstance(rec, dict) and rec.get("session"):
        return Check(True, "thimble's agents can start in this folder")
    return Check(True, "thimble's agents start after /thimble here")


def _extension_checks() -> list[Check]:
    """A problem line for each added extension that can't load, and for each thing two extensions both give."""
    from . import extensions, userconf  # noqa: PLC0415

    got = extensions.added()
    if not got:
        return []
    off = userconf.extensions_off()
    out: list[Check] = []
    loadable: dict[str, dict[str, Any]] = {}
    for name, root in got.items():
        info = extensions.read_extension(root, name, set(got))
        if info["problems"]:
            out.append(Check(False, f"Extension {name} isn't loaded: {info['problems'][0]}",
                             f"In Settings, turn it off, or fix it; {VERBOSE_FIX} has details"))
        elif not extensions.config_off(name, off):
            loadable[name] = {**info, "active": True}
    what = {"view": "the view {slug}", "card": "the card type {slug}", "block": "the orientation's instructions",
            "role": "{role}", "task": "the {slug} task"}
    for kind, clash in extensions.conflicts(loadable).items():
        for slug, names in clash.items():
            both = ", ".join(names[:-1]) + f" and {names[-1]}"
            gives = what.get(kind, "{slug}").format(slug=slug, role=extensions.ROLE_NAMES.get(slug, f"the {slug}"))
            out.append(Check(False, f"Extensions {both} both give {gives}",
                             f"In Settings, turn one off; {VERBOSE_FIX} lists them"))
    return out


def _when_wrong_checks(cwd: Path) -> list[Check]:
    """The areas the checklist names only when something is wrong: thimble's config, the disk, the extensions, and
    server.json's permissions."""
    from . import userconf  # noqa: PLC0415

    out: list[Check] = []
    env = resolve_env()
    workspaces = Path(env["workspaces_dir"])
    over = sorted(q.parent.name for q in workspaces.glob(f"*/{userconf.FILE}")) if workspaces.is_dir() else []
    errors = [e for e in [userconf.problem(), *(userconf.problem(c) for c in over)] if e]
    if errors:
        out.append(Check(False, f"thimble's config has an error: {errors[0]}",
                         "Fix the file it names; no agent starts until then"))
    for q in (home(), workspaces):
        while not q.exists() and q != q.parent:
            q = q.parent
        try:
            free = shutil.disk_usage(q).free
        except OSError:
            continue
        if free < DISK_LOW_BYTES:
            out.append(Check(False, f"Low disk space: {human_bytes(free)} free at {_tilde(q)}",
                             "Free some space there; writes fail when the disk is full"))
            break
    out += _extension_checks()
    if server_json().is_file() and server_json().stat().st_mode & 0o077:
        # a restart writes the file again, 0600 (write_state)
        out.append(Check(False, "thimble's token file is readable by other accounts", "In a shell: thimble server restart"))
    return out


def _checked_check(area: str, fn, *args) -> list[Check]:
    """A check's lines, or one line that says it could not be checked: the checklist prints whatever else it can."""
    try:
        got = fn(*args)
    except Exception as e:  # noqa: BLE001 — the doctor reports; it never fails on one of its lines
        return [Check(False, f"{area} not checked ({type(e).__name__})", f"{VERBOSE_FIX} has details")]
    return got if isinstance(got, list) else [got]


def doctor_checks(cwd: Path) -> list[Check]:
    """The doctor's checklist for a session in `cwd`, in order: versions, sign-in, server, plugin, Claude Code's
    sandbox, card code, views and screenshots, thimble's agents, then only what is wrong of the config, the disk, the
    extensions and server.json."""
    out = [*_checked_check("Versions", _version_check), *_checked_check("Sign-in", _sign_in_check),
           *_checked_check("Server", _server_check), *_checked_check("Plugin", _plugin_check, cwd),
           *_checked_check("Claude Code's sandbox", _sandbox_check, cwd),
           *_checked_check("Card code", _card_code_check), *_checked_check("Views", _views_check)]
    with server_dirs():
        out += [*_checked_check("thimble's agents", _agents_check, cwd),
                *_checked_check("Setup", _when_wrong_checks, cwd)]
    return out


def doctor_check_text(cwd: Path) -> str:
    """What `thimble doctor` prints: `thimble doctor`, one `✓` or `!` line per check (doctor_checks), each at most
    CHECK_LINE_MAX characters, a fix line under each problem, at most FIX_LINE_MAX, then DETAILS_LINE."""
    lines = ["thimble doctor"]
    for check in doctor_checks(cwd):
        lines.append(_fit(f"{'✓' if check.ok else '!'} {check.line}", CHECK_LINE_MAX))
        if not check.ok and check.fix:
            lines.append("  " + _fit(check.fix, FIX_LINE_MAX - 2))
    lines.append(DETAILS_LINE)
    return "\n".join(lines)


# ----------------------------------------------------------------------------- fix / revert / restart


def restart(*, keep_vite: bool = False) -> list[str]:
    """Stop (the backend only with `keep_vite`; the kernels stay for the new server to reconnect), start, announce."""
    lines = stop(vite=not keep_vite, kernels=False)
    _leave_restart_reason(MANUAL_RESTART)
    with lock():
        if not serves():
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
    contained (dev.fix_contained) the analyst's Allow before it starts (dev.FIX_QUESTION)."""
    from . import dev  # noqa: PLC0415

    if not sys.stdin.isatty():
        return FIX_NO_TERMINAL
    if dev.fix_contained():
        return ""
    try:
        answer = input(f"thimble fix: {dev.FIX_QUESTION} [y/N] ")
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


def hook_marker_path(session: str) -> Path | None:
    """<home>/up/<session>.active, named as hook_result_path names the result; None for an id it gives no name."""
    path = hook_result_path(session)
    return path.with_suffix(HOOK_MARKER_SUFFIX) if path else None


def _write_private(path: Path, data: dict[str, Any]) -> None:
    """`data` as JSON at `path`, written whole (a temporary file, then a rename) in a folder only its owner reads."""
    config.private_dir(path.parent)
    fd, tmp = tempfile.mkstemp(prefix=".up.", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f)
        os.replace(tmp, path)
    finally:
        Path(tmp).unlink(missing_ok=True)


def hook_up(raw: str) -> int:
    """`server up --hook`, /thimble's UserPromptExpansion hook (module note, the Bash sandbox), which runs outside the
    sandbox for the hook's session and folder: `/thimble` alone turns thimble on in the session (activate.main, no
    server); `/thimble open` opens the browser workbench (run_open), which starts the server; any other action runs
    `up`. What `open` and `up` print is kept for the skill's `up` (take_hook_result). It prints nothing, since a hook's
    output would reach the model beside the skill's."""
    try:
        hook = json.loads(raw)
    except ValueError:
        return 0
    session = str(hook.get("session_id") or "") if isinstance(hook, dict) else ""
    path = hook_result_path(session)
    if path is None:
        return 0
    args = str(hook.get("command_args") or "")
    try:
        words = shlex.split(args)
    except ValueError:
        words = args.split()
    action, archive = (words + ["", ""])[:2]
    action = ALIASES.get(action, action)
    cwd = os.environ.get("CLAUDE_PROJECT_DIR") or str(hook.get("cwd") or "") or os.getcwd()
    path.unlink(missing_ok=True)
    if action in ("", "on"):
        with redirect_stdout(io.StringIO()):
            try:
                from . import activate  # noqa: PLC0415

                activate.main(["activate", "--cwd", cwd, "--session", session, "--via", "command", "--hook"])
            except SystemExit:
                pass
            except Exception as e:  # noqa: BLE001 — the skill's own commands say what is wrong
                _log(f"/thimble: the hook for session {session} failed: {type(e).__name__}: {e}")
        return 0
    if action == OPEN:
        text = "\n".join(open_lines(run_open(session, cwd, hook=True))) + "\n"
        _write_private(path, {"cwd": cwd, "action": action, "archive": archive, "at": time.time(), "text": text})
        return 0
    out = io.StringIO()
    with redirect_stdout(out):
        cmd_server_up(argparse.Namespace(cwd=cwd, session=session, action=action, archive=archive))
    _write_private(path, {"cwd": cwd, "action": action, "archive": archive, "at": time.time(), "text": out.getvalue()})
    return 0


OPEN_NOT_BUILT = {"ok": False, "error": {"code": "NOT_BUILT", "message": "thimble open is not built yet",
                                         "fix": "wait for the browser lane"}}  # the C12 stand-in's answer


def run_open(session: str, cwd: str, *, hook: bool = False) -> dict[str, Any]:
    """`thimble open` (app/open_cmd.py, C12) for the session and folder, run in this process: its JSON answer, or an
    error of the same form when it printed none."""
    if importlib.util.find_spec(f"{__package__}.open_cmd") is None:
        return OPEN_NOT_BUILT
    from . import open_cmd  # noqa: PLC0415 — the press, needed here alone

    out = io.StringIO()
    with redirect_stdout(out):
        try:
            open_cmd.main(["--session", session, "--cwd", cwd, *(["--hook"] if hook else []), "--json"])
        except SystemExit:
            pass
        except Exception as e:  # noqa: BLE001 — the skill says what is wrong, never a traceback
            _log(f"/thimble open: session {session}: {type(e).__name__}: {e}\n{traceback.format_exc()}")
            return {"ok": False, "error": {"code": "START", "message": f"thimble open failed ({type(e).__name__})",
                                           "fix": f"see {log_path()}"}}
    for line in reversed(out.getvalue().splitlines()):
        try:
            got = json.loads(line)
        except ValueError:
            continue
        if isinstance(got, dict):
            return got
    return {"ok": False, "error": {"code": "START", "message": "thimble open said nothing", "fix": f"see {log_path()}"}}


OPENED_LINE = "thimble: opened in the browser · 127.0.0.1:{port}"
REMOTE_LINE = ("thimble: thimble's page runs on this machine at 127.0.0.1:{port}. On your own computer, run `{tunnel}`, "
               "then open the one-time link in {link_file} there (it works once, for 5 minutes).")


def open_lines(result: dict[str, Any]) -> list[str]:
    """What /thimble open prints of `thimble open`'s JSON (C12): status only, never a code."""
    if not result.get("ok"):
        err = result.get("error") if isinstance(result.get("error"), dict) else {}
        return [" ".join(x for x in ("thimble:", str(err.get("message") or "thimble open failed."),
                                     str(err.get("fix") or "")) if x)]
    if result.get("remote"):
        tunnel = result.get("et") or result.get("tunnel") or "ssh -N -L {0}:127.0.0.1:{0} <your ssh host>".format(
            result.get("port"))
        return [REMOTE_LINE.format(port=result.get("port"), tunnel=tunnel, link_file=result.get("link_file") or "")]
    return [OPENED_LINE.format(port=result.get("port"))]


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


def made_main(name: str, session: str, cwd: Path, via: str = "press") -> None:
    """After a press (`thimble open`, H1) or /thimble's `up` made `session` main of workspace `name` on the server: the
    folder marked active for the plugin's hooks (mark_active), thimble on in the session if it was not (activation, so
    that a later one finds the session marked and keeps its transport), and launch.json written for it through
    activation's one writer (activate.take_main, then activate.write_launch with transport `server`): from now on the
    session runs on the server, one way (subagent_files.transport). Never raises."""
    mark_active(cwd)
    try:
        from . import activate  # noqa: PLC0415 — activation's, needed here alone

        if session_marker(session) is None:
            activate.activate(str(cwd), session, via)
        with server_dirs():
            activate.take_main(name, session, via)
            activate.write_launch(name, session, role="main", transport="server", via=via)
    except Exception as e:  # noqa: BLE001 — never a traceback in the skill text
        _log(f"launch.json of {name} for session {session} was not written: {type(e).__name__}: {e}")


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
    if refused(cwd) and action != "status":  # $HOME or / as a corpus would index the analyst's whole machine
        print(REFUSED_LINE.format(path=cwd))
        return 0
    if args.session and action in ("", "on"):  # /thimble alone: thimble on in the session, no server
        return on_here(cwd, str(args.session))
    if action == OPEN and not in_sandbox():  # in the sandbox the hook's open (take_hook_result, above) is the one
        for line in open_lines(run_open(str(args.session or ""), str(cwd))):
            print(line)
        return 0
    if in_sandbox():  # a server started here would die with the command, and the host's is out of reach
        print(sandbox_line(cwd))
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
        up: bool | None = ensure_running(WAIT_S)
    except TimeoutError as e:
        _log(str(e))
        up = None
    url = api_url()  # where the server runs: start passes over a port that is not free (pick_port)
    if up is None:
        up = serves(url)
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
        # a plain `claude`: what its environment lacks goes under the link too, which the Stop hook shows whatever
        # main's reply holds
        setup = setup_lines(cwd) if args.session else []
        # with the plugin's hooks off no Stop hook shows the link, so the page opens without a sign-in code; a link
        # printed here reaches the model, so only a shell's own terminal gets one with a code
        if (args.session and not cc_plugin.hooks_blocked(cwd, plugin_root())
                and leave_link(str(args.session), ui_url(name), setup)):
            print(LINK_LINE)
        else:
            pair = not args.session and to_terminal()
            link = ui_url(name, pair=pair)
            print(f"thimble: {link}")
            if pair and "#p=" not in link:
                print(NO_CODE_LINE.format(log=log_path()))
        for line in [*second, *setup]:
            print(line)
        status = config.auth_status(cwd=cwd)
        if args.session:
            lines = monitor_lines(cwd, str(args.session))
            mark = [ln for ln in lines if ln.startswith(MONITOR_MARK)]
            for line in lines:
                if line not in mark:
                    print(line)
        if name and args.session:
            replaced = name_session(url, name, str(args.session), cwd, sandbox=own_sandbox_here(cwd),
                                    warnings=setup_warnings(cwd))
            if replaced:
                print(TAKEOVER_LINE.format(other=replaced[:8]))
            made_main(name, str(args.session), cwd)
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


ON_LINE = "thimble: thimble is on in this folder. /thimble open opens the browser workbench."


def on_here(cwd: Path, session: str) -> int:
    """/thimble alone, the skill's `up` after its activate and guide commands, with no server: the line that says
    thimble is on in the session, or why activation refused the folder; then, as 0.8.0's /thimble printed them under the
    link, the pre-cache's line, what the session's environment lacks (setup_lines), a missing sign-in and the Claude
    Code version's line; where the plugin's hooks are off the Monitor's lines (the command after MONITOR_MARK last);
    and for a session new to a workspace installed from a pre-cache, what its orientation left (precached.take_context)."""
    marker = session_marker(session)
    if marker is None:
        from . import activate  # noqa: PLC0415 — activation (idempotent), here for its answer

        got = activate.activate(str(cwd), session, "command")
        if not got.get("ok"):
            err = got.get("error") if isinstance(got.get("error"), dict) else {}
            print(" ".join(x for x in ("thimble:", str(err.get("message") or "thimble did not turn on here."),
                                       str(err.get("fix") or "")) if x))
            return 0
        marker = {"ws": got.get("ws")}
    given = ""
    if marker.get("ws"):
        from . import precached  # noqa: PLC0415

        with server_dirs():
            try:
                given = precached.take_context(str(marker["ws"]), session)
            except Exception as e:  # noqa: BLE001 — never a traceback in the skill text
                _log(f"pre-cached context of {marker['ws']}: {type(e).__name__}: {e}")
    print(ON_LINE)
    for line in [*([PRECACHED_LINE] if given else []), *setup_lines(cwd)]:
        print(line)
    problem = config.auth_problem(config.auth_status(cwd=cwd))
    if problem:
        print(NO_AUTH_LINE.format(problem=problem))
    warning = claude_code_warning(claude_code_version())
    if warning:
        print(warning)
    for line in sorted(monitor_lines(cwd, session), key=lambda ln: ln.startswith(MONITOR_MARK)):
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


def cmd_doctor(args: argparse.Namespace) -> int:
    """`thimble doctor`: the checklist (doctor_check_text) for the folder it runs in; with `--verbose` the full text
    (doctor_text)."""
    ship_extensions()
    caller = Path(os.environ.get("THIMBLE_CALLER_CWD") or os.getcwd())
    print(doctor_text() if getattr(args, "verbose", False) else doctor_check_text(caller))
    return 0


def cmd_unpair(_: argparse.Namespace) -> int:
    """`thimble unpair`: every browser signed out (`POST /api/ui/unpair` when the server answers, which forgets them at
    once), and <home>/paired.json removed, so a server that starts later knows none either."""
    url = api_url()
    why = ""
    if healthy(url):
        status, body = _request("POST", f"{url}/api/ui/unpair", {})
        if status not in (200, 204):
            why = f"it answered {status or str(body)[:120]}"
            _log(f"unpair: {status} {str(body)[:200]}")
    try:
        (home() / PAIRED_FILE).unlink(missing_ok=True)
    except OSError as e:
        why = why or f"{home() / PAIRED_FILE} could not be removed: {e.strerror}"
    print(UNPAIR_FAILED_LINE.format(why=why) if why else UNPAIRED_LINE)
    return 1 if why else 0


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


# the flags `thimble update` passes on to install.sh through update.sh: for 0.8.x install.sh ignores all but --no-plugin
# and --require-pinned, with a line that says so (0.7's sandbox, plugin and startup-file flags)
INSTALL_FLAGS = ("--sandbox-deps", "--no-sandbox-deps", "--plugin", "--no-plugin", "--no-modify-path", "--modify-path",
                 "--require-pinned")


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


UPDATE_RESTART_KEY = "update:restart"  # the notice each workspace with a live session gets after an update (3.20)
UPDATE_RESTART_TEXT = "thimble was updated while this session ran. Restart Claude Code to use the new version."


def tell_restart() -> list[str]:
    """After an update: the `update:restart` notice posted into each workspace whose main's `claude` process still runs
    (launch.json's pid), since that session runs the code it started with (notices.post: a band row and one toast in
    its terminal, a strip in its browser). The workspaces told. Never raises."""
    told: list[str] = []
    try:
        from . import notices, subagent_files  # noqa: PLC0415

        with server_dirs():
            root = config.WORKSPACES_DIR
            for ws in sorted(root.iterdir()) if root.is_dir() else []:
                if not ws.is_dir() or ws.name.startswith(".") or subagent_files.main_pid(ws) is None:
                    continue
                notices.post(ws.name, kind="update", key=UPDATE_RESTART_KEY, text=UPDATE_RESTART_TEXT)
                told.append(ws.name)
    except Exception as e:  # noqa: BLE001 — the update is done either way
        _log(f"update: the sessions that run were not told to restart: {type(e).__name__}: {e}")
    return told


def cmd_update(args: argparse.Namespace) -> int:
    """`thimble update [--from <zip>] [--dry-run]`: --from hands the zip to update.sh; no argument downloads the latest
    release and its SHA256SUMS with gh, and update.sh checks the zip against it; a checkout skips the download
    (update.sh pulls). When the download fails: two lines naming the cause and the --from form, and exit 1. After an
    update each workspace with a live session gets the `update:restart` notice (tell_restart)."""
    dry = getattr(args, "dry_run", False)
    extra = ["--dry-run"] if dry else []
    extra += ["--browser", args.browser] if getattr(args, "browser", None) else []
    extra += getattr(args, "install_flags", None) or []
    if getattr(args, "from_", None):
        return _updated(run_update_script("--from", args.from_, *extra), dry)
    if is_git_checkout():
        return _updated(run_update_script(*extra), dry)
    repo = release_repo()
    with tempfile.TemporaryDirectory(prefix="thimble-update-") as tmp:
        zip_path, cause, detail = download_release(repo, Path(tmp))
        if zip_path is None:
            first, second = UPDATE_FAILED_LINES[cause]
            print(first.format(repo=repo, detail=detail))
            print(second.format(url=releases_url(repo)))
            return 1
        print(f"thimble update: downloaded {zip_path.name}")
        return _updated(run_update_script("--from", str(zip_path), "--sums", str(Path(tmp) / RELEASE_SUMS), *extra), dry)


def _updated(rc: int, dry: bool) -> int:
    """update.sh's exit code `rc`, the sessions that run told to restart first when it updated (tell_restart)."""
    if rc == 0 and not dry:
        tell_restart()
    return rc


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
    dr = sub.add_parser("doctor", help="a checklist of what works, with the fix for each problem; works with the "
                                       "server down")
    dr.add_argument("--verbose", action="store_true", help="the full detail: paths, pids, ports, every switch, the log")
    dr.set_defaults(fn=cmd_doctor)
    for name, fn, help_ in (("unpair", cmd_unpair, "sign out every browser"),
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
    la = sub.add_parser("launch-args", help="for plugin/bin/thimble: the plugin folder to load, the tools that end a "
                                            "turn without text, why the hooks module is off, and the note lines")
    la.add_argument("--cwd")
    la.add_argument("--key", help="the launcher's key of the files these depend on: they are kept under it in "
                                  "<home>/launcher.json")
    la.add_argument("--settings", help="the analyst's own --settings, for whether they turn hooks off")
    la.add_argument("--safe-mode", action="store_true", help="the analyst passed Claude Code's --safe-mode")
    la.set_defaults(fn=cmd_launch_args)
    pr = sub.add_parser("prompt", help="for a plugin skill's injected command: prompt files rendered for a session in --cwd")
    pr.add_argument("names", nargs="+", help="prompt names under prompts/, such as shared")
    pr.add_argument("--cwd")
    pr.add_argument("--if-active", action="store_true",
                    help="the SessionStart hook's, for `main`: main's guide, only for a session thimble is on in (its "
                         "marker), once main itself cleared or compacted, marked sent")
    pr.add_argument("--unless-mod", action="store_true",
                    help="with --if-active: nothing for a session whose marker says the terminal UI ran activation")
    pr.add_argument("--session", help="with --if-active: the session (else CLAUDE_CODE_SESSION_ID)")
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
