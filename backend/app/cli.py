"""The supervisor behind `plugin/bin/thimble`: the server's lifecycle from a shell or the /thimble skill.

    thimble server up [--cwd <path>] [--session <id>] [--action status|fix|repair|fresh|restore|feedback]
                      [--archive <name>]
    thimble server status [--cwd <path>] | repair | stop [--yes] | restart [--keep-vite] [--yes]
    thimble doctor | fix | revert | stop [--yes] | restart [--keep-vite] [--yes]
    thimble update [--from <zip>] [--dry-run]
    thimble feedback ["description"] [--no-logs]   (a problem report as a zip; feedback.py)
    thimble list                           (the workspaces by id, archived runs included; runs.py)
    thimble purge <id>… [--dry-run]        (delete workspaces or archived runs by id; runs.py)
    thimble launch-args --cwd <path>       (the launcher's: channel entry, allowed tools, main's effort, turn tools, main's prompt)
    thimble prompt <name>… [--cwd <path>]  (prompt files rendered for a session in <path>, for skills and hooks)

`server up` (alias `ensure`) is the one starter: `GET /api/health`, then under `flock <home>/server.lock` spawn uvicorn
on THIMBLE_PORT (8300) as its own session leader (plus Vite on 5300 when THIMBLE_DEV is on), wait for health, map the
cwd to a workspace, print `thimble: <url>`, and name the session to the server. It always exits 0, since a skill fails
whole when its command exits non-zero. `--action fresh` moves the workspace aside into <workspaces>/.archive/;
`--action restore` restores an archive. /thimble also reports the route browser events take (cc_channel.delivery).

<home> is `~/.thimble` or THIMBLE_HOME. <home>/server.json records {port, pid, url, repo, env}; its `pid` is trusted
only while it is a thimble server on its port (is_server checks the command line and working folder, since a pid
recorded inside a sandbox's pid namespace can name an unrelated host process). reconcile makes the record true before
`up` acts on it. A server whose /api/health names another THIMBLE_HOME belongs to another install and is refused.

Claude Code's Bash sandbox gives each command its own network and pid namespace, so `up` starts nothing there and
prints the `sandbox.excludedCommands` entry that runs it outside (sandbox_rule). `restart` and `stop` name the work
they would interrupt (running_work) and ask first unless `--yes`. In dev mode an `up` that finds the source tree changed
while the server is idle restarts the backend (THIMBLE_NO_AUTORESTART=1 disables it). This module imports only
`config`, `procs`, `cc_channel` and the standard library (others lazily), never `app.notebook`.
"""
from __future__ import annotations

import argparse
import errno
import fcntl
import hashlib
import importlib.util
import json
import os
import platform
import re
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
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator, Mapping, NamedTuple

from . import cc_channel, config, procs

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
FINGERPRINT_GLOBS = ("backend/app/**/*.py", "prompts/**/*", "plugin/bin/*", "plugin/.mcp.json")
NO_AUTORESTART_ENV = "THIMBLE_NO_AUTORESTART"
SOURCE_CHANGED = "source changed"  # restart.json's title; dev.PLAIN_REASONS
RESTARTED_LINE = "thimble: server restarted (source changed)"
NOT_RESTARTED_LINE = "thimble: source changed since the server started; not restarting while {reason}"
REGISTER_FAILED_LINE = "thimble: could not open {path} as a workspace (the server refused to register it); see {log} and say `/thimble` again."
NO_UI_LINE = "thimble: the dashboard is not built yet, so that URL shows no page; run `thimble doctor` in a shell for the fix."
NO_AUTH_LINE = "thimble: no Claude login or API key was found; nothing will run until there is one (`thimble doctor` says how)."
FEEDBACK = "feedback"  # /thimble feedback: the problem report (feedback.py)
# where the server did not start: how to send the developer a problem report, which needs no server
REPORT_LINE = ("thimble: to report it, say `/thimble feedback` or run `thimble feedback \"the server did not start\"` in a "
               "shell; either writes a zip with the logs to send the developer.")
UNINSTALL_SHELL_LINE = "thimble: uninstall is a shell command, not a /thimble action. Run `thimble uninstall` in a terminal; it says what it will remove and asks first."
# What the analyst sees on the hook and Monitor routes. Each note says why channels are off, what differs on the route
# used instead, then the fix, in terms of what the analyst sees. On the Monitor route permission prompts stay in the
# terminal, and after /clear the Monitor is gone, so that note asks for /thimble again. A reason with no fix the analyst
# can act on (Bedrock, Vertex, Foundry, or a login that is not a claude.ai one) gets the generic line.
_NOT_AVAILABLE = "Claude Code channels are not available in this session"
CHANNELS_OFF = {
    cc_channel.SESSION: "Claude Code channels are off because this session was started without them",
    cc_channel.ORG: "Claude Code channels are off because your organization has disabled them",
    cc_channel.PROVIDER: _NOT_AVAILABLE,
    cc_channel.ACCOUNT: _NOT_AVAILABLE,
}
CHANNEL_FIXES = {
    cc_channel.SESSION: " For the direct connection, quit and run `thimble` in this folder, or restart with `{command}`.",
    cc_channel.ORG: " To use channels, ask your admin to enable them.",
    cc_channel.PROVIDER: "",
    cc_channel.ACCOUNT: "",
}
_HOOK_EFFECT = ("so thimble connects through hooks instead. Browser messages arrive as fast as with channels, but "
                "Claude may ask you to confirm here in the terminal what you approved in the browser.")
HOOK_NOTES = {why: f"thimble: note - {off}, {_HOOK_EFFECT}{CHANNEL_FIXES[why]}" for why, off in CHANNELS_OFF.items()}
_MONITOR_EFFECT = ("and hooks are disabled too, so thimble connects through a Monitor instead. Permission prompts "
                   "appear only here in the terminal, and Claude may ask you to confirm here what you approved in the "
                   "browser. After /clear, say /thimble again.")
MONITOR_NOTES = {why: f"thimble: WARNING - {off}, {_MONITOR_EFFECT}{CHANNEL_FIXES[why]}" for why, off in CHANNELS_OFF.items()}
MONITOR_MARK = "thimble-monitor:"  # then the command main's Monitor runs (plugin/skills/thimble/SKILL.md)
WATCHER = "bin/.thimble-watch"  # the plugin's hidden watcher, under its root
FRESH = "fresh"  # /thimble fresh: the folder's workspace moved aside, an empty one opened
RESUME = "restore"  # /thimble restore [<archive>]: an archive restored in its place, or the archives listed
ALIASES = {"resume": RESUME}  # another name the action takes
OPENING = ("", "on", FRESH, RESUME)  # the actions that open the workspace (and print the delivery note)
RESUME_LINE = "thimble: resuming the dashboard from your last run; `/thimble fresh` starts over"
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
CHANNEL_ENV = cc_channel.ENV  # the launcher exports it (plugin/bin/thimble); Claude Code passes it on to the skill's command
PLUGIN_ROOT_ENV = "THIMBLE_PLUGIN_ROOT"  # bin/thimble exports its plugin copy: the tree's plugin/, or an installed copy
CHANNEL = "plugin:thimble@inline"  # the development channel of this tree's plugin/, loaded with --plugin-dir
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
SANDBOX_LINE = ("thimble: WARNING - Claude Code's Bash sandbox is on in this session and keeps /thimble from reaching "
                "thimble's server, so there is no link. To fix it, add \"{rule}\" to sandbox.excludedCommands in "
                "{settings}, then say /thimble again.")
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
# the caller's Claude Code session leaks into the environment; the server must not inherit a session's identity
_STRIP_PREFIXES = ("CLAUDE_", "CLAUDECODE")
_KEEP = {"CLAUDE_CONFIG_DIR"}
MAIN = "main"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# ----------------------------------------------------------------------------- files under <home>


def home() -> Path:
    """`~/.thimble`, or THIMBLE_HOME, read fresh so tests and scratch stacks can point it away."""
    return Path(os.environ.get("THIMBLE_HOME") or "~/.thimble").expanduser()


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


def write_state(state: dict[str, Any]) -> None:
    p = server_json()
    p.parent.mkdir(parents=True, exist_ok=True)
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
        log_path().parent.mkdir(parents=True, exist_ok=True)
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


def resolve_env() -> dict[str, Any]:
    """The names the server runs with: the caller's THIMBLE_* first, then the last server.json, then the defaults."""
    st = read_state().get("env") or {}
    data_dir = os.environ.get("THIMBLE_DATA_DIR") or st.get("data_dir") or str(config.default_data_dir())
    ws_dir = os.environ.get("THIMBLE_WORKSPACES_DIR") or st.get("workspaces_dir") or str(config.WORKSPACES_DIR)
    # dev mode is the environment's alone, never server.json's, so a later /thimble from any session never spawns Vite
    # unasked
    dev = (os.environ.get("THIMBLE_DEV") or "").strip().lower() in ("1", "true", "yes", "on")
    return {"data_dir": str(Path(data_dir).expanduser()), "workspaces_dir": str(Path(ws_dir).expanduser()),
            "plugin_dir": str(PLUGIN_DIR), "home": str(home()), "dev": dev}


def _server_environ(env: dict[str, Any], p: int, ui: int) -> dict[str, str]:
    base = {k: v for k, v in os.environ.items() if k in _KEEP or not k.startswith(_STRIP_PREFIXES)}
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


def sandbox_rule() -> str:
    """The `sandbox.excludedCommands` entry that runs /thimble's `server up` outside the sandbox: the plugin copy's
    own path, as the skill's command spells it once Claude Code has put in its plugin root."""
    return f"{plugin_root() / 'bin' / 'thimble'} server up *"


def _request(method: str, url: str, body: dict | None = None, timeout: float = 5.0) -> tuple[int, Any]:
    """(status, parsed json | text). Transport failures are (0, message); an HTTP error is (status, its body)."""
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={"Content-Type": "application/json"})
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
    lock_path().parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(lock_path(), os.O_RDWR | os.O_CREAT, 0o644)
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
    log_file.parent.mkdir(parents=True, exist_ok=True)
    with log_file.open("ab") as out:
        proc = subprocess.Popen(cmd, cwd=str(cwd), stdin=subprocess.DEVNULL, stdout=out, stderr=subprocess.STDOUT,
                                env=env, start_new_session=True, preexec_fn=_detach, close_fds=True)
    return proc.pid


def backend_cmd(p: int, dev: bool = False) -> list[str]:
    """In dev mode the backend reloads on edits to app/, as Vite does for the frontend; THIMBLE_NO_AUTORESTART turns
    it off."""
    cmd = [sys.executable, "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", str(p),
           "--timeout-graceful-shutdown", "3"]
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
    _log(f"started uvicorn pid {pid} on {p} (data_dir {env['data_dir']}, workspaces_dir {env['workspaces_dir']}, "
         f"auth {config.auth_path()[0]})")
    vite_pid = read_state().get("vite_pid") if listening(ui) else None
    if env["dev"] and not listening(ui):
        vite_pid = start_vite(ui, p, environ)
    state = {
        "port": p, "pid": pid, "url": f"http://127.0.0.1:{ui}" if env["dev"] else api_url(p),
        "api": api_url(p), "ui_port": ui, "vite_pid": vite_pid, "dev": env["dev"], "repo": str(config.REPO_ROOT),
        "branch": git_branch(), "started": _now(), "stopped": None,
        "source_fingerprint": source_fingerprint(),
        "env": {k: env[k] for k in STATE_ENV_KEYS},
    }
    write_state(state)
    return state


def start_vite(ui: int, p: int, environ: dict[str, str] | None = None) -> int | None:
    if not (FRONTEND_DIR / "node_modules").is_dir():
        _log(f"not starting Vite: {FRONTEND_DIR / 'node_modules'} is missing (run `npm ci` in frontend/)")
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
    """Why the server `start` spawned in this process is not answering at `url`: another program on the port, the
    error it exited with, or that it is still starting. '' when this process started nothing."""
    p = int(LAST_START.get("port") or port())
    pid = LAST_START.get("pid")
    if listening(p) and not healthy(url):
        holder = procs.listener(p)
        if holder != pid and not (holder and is_server(holder, p)):
            return port_line(p, False)
    if pid and spawned_exited(pid):
        err = start_error(int(LAST_START.get("log_offset") or 0))
        return f"the server exited while starting{': ' + err if err else ''}"
    if pid:
        return f"the server (pid {pid}) is still starting; this machine may be slow"
    return ""


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
        path.parent.mkdir(parents=True, exist_ok=True)
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
        rf.parent.mkdir(parents=True, exist_ok=True)
        rf.write_text(json.dumps({"title": title, "ts": _now()}) + "\n", "utf-8")
    except OSError as e:
        _log(f"could not write {rf}: {e}")


def spawn_restart() -> int:
    """`thimble restart --keep-vite --yes` as a detached session leader, so the restart outlives the caller; busy_reason
    has found the server idle, so it asks nothing. Seam for tests."""
    env = {k: v for k, v in os.environ.items() if k in _KEEP or not k.startswith(_STRIP_PREFIXES)}
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


def open_workspace(cwd: Path, data_dir: Path, url: str | None, *, here: bool = False) -> tuple[str | None, bool]:
    """workspace_for with whether the folder was opened anew: (name, registered just now)."""
    cwd = cwd.resolve()
    data_dir = data_dir.resolve()
    known = known_corpus(cwd, data_dir)
    if known is not None and (known[1] == cwd or not here or known[1].parent == data_dir):
        return known[0], False
    if not url:
        return (known[0] if known else None), False
    body: dict[str, Any] = {"path": str(cwd)}
    if here:
        body["exact"] = True
    status, resp = _request("POST", f"{url}/api/corpora/register", body)
    if status in (200, 201) and isinstance(resp, dict) and resp.get("name"):
        return str(resp["name"]), True
    _log(f"register {cwd} → {status} {str(resp)[:200]}")
    return None, False


def ui_url(name: str | None) -> str:
    """The UI port in dev mode (its own Vite), else the API port where the built UI is served."""
    st = read_state()
    base = str(st.get("url") or api_url())
    return f"{base}/?ws={name}" if name else f"{base}/"


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


def delivery_lines(route: cc_channel.Delivery, cwd: Path, session: str) -> list[str]:
    """The lines after the URL that say how the browser reaches this session: none on the channel, a note on the hook route,
    the warning and the Monitor's command on the Monitor route."""
    command = channel_command()
    if route.mode == cc_channel.HOOK:
        return [HOOK_NOTES[route.reason].format(command=command)]
    if route.mode == cc_channel.MONITOR:
        watcher = shlex.join([str(plugin_root() / WATCHER), "--stream", "--cwd", str(cwd), "--session", session])
        return [MONITOR_NOTES[route.reason].format(command=command), f"{MONITOR_MARK} {watcher}"]
    return []


def launched() -> bool:
    """Whether the `thimble` launcher started this session, and so appended main's prompt to its system prompt: it
    exports THIMBLE_CHANNEL."""
    return bool(os.environ.get(CHANNEL_ENV))


def plugin_root() -> Path:
    """The plugin copy whose bin/thimble ran this command (PLUGIN_ROOT_ENV), else this tree's plugin/."""
    return Path(os.environ.get(PLUGIN_ROOT_ENV) or PLUGIN_DIR).resolve()


def channel_command(root: Path | None = None) -> str:
    """The `claude` command line that loads the plugin copy at `root` as a development channel, for the delivery notes:
    `--plugin-dir` and `plugin:thimble@inline` for a folder, `plugin:thimble@<marketplace>` for an installed copy."""
    root = root or plugin_root()
    flag = f"--dangerously-load-development-channels {cc_channel.channel(root)}"
    if cc_channel.marketplace(root) != cc_channel.INLINE:
        return f"claude {flag}"
    return f"claude --plugin-dir {shlex.quote(str(root))} {flag}"


MARKETPLACE_FILE = config.REPO_ROOT / ".claude-plugin" / "marketplace.json"  # the marketplace install.sh registers
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
    its channel entry names."""

    root: Path
    marketplace: str

    @property
    def channel(self) -> str:
        return f"plugin:{PLUGIN_NAME}@{self.marketplace}"


def _claude_json(claude: str, args: list[str], cwd: Path) -> list[Any]:
    """The list a `claude ... --json` listing prints, [] when it fails or prints something else."""
    r = subprocess.run([claude, *args, "--json"], cwd=cwd, capture_output=True, text=True,
                       timeout=PLUGIN_LIST_TIMEOUT_S, stdin=subprocess.DEVNULL, check=False)
    out = json.loads(r.stdout) if r.returncode == 0 and r.stdout.strip() else []
    return out if isinstance(out, list) else []


def installed_copy(cwd: Path) -> Installed | None:
    """The copy of this tree's plugin that Claude Code has installed and enables for `cwd` (`claude plugin list --json`),
    which the launcher loads rather than plugin/ with --plugin-dir, since Claude Code's startup notice lists a --plugin-dir
    plugin's channel as `plugin not installed` although it works. When the marketplace is a directory source at this tree,
    plugin/ itself is the copy; otherwise the cache copy counts when it matches plugin/ and finds this tree. None when
    there is no such copy, it is disabled, or anything fails."""
    try:
        name = json.loads(MARKETPLACE_FILE.read_text("utf-8")).get("name")
        claude = shutil.which("claude")
        if not isinstance(name, str) or not name or not claude:
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
            if not (root.is_absolute() and root.is_dir()) or cc_channel.marketplace(root) != name:
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
    """Tell the server which Claude Code session asked (`POST /api/ws/{c}/session`), with this process's pid, whose
    environment the server reads for the CLAUDE_CONFIG_DIR the session runs under. Returns the session this one took main
    over from while it still runs in another terminal, else None."""
    try:
        status, body = _request("POST", f"{url}/api/ws/{urllib.parse.quote(name)}/session",
                                {"session": session, "cwd": str(cwd), "env_pid": os.getpid()}, timeout=3.0)
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


def launch_args(cwd: Path, resume: bool = False) -> str:
    """The launcher's values, one per line: the channel entry of the plugin copy to load, the `--allowedTools` line, the
    `--effort` value ('' for none), the value to export as terminal_tools.ENV ('' when the `claude` it starts does not
    read it), with `resume` the session to resume, then main's prompt, whose turn ending follows that value. An effort
    key the composer's chip wrote into the folder's local settings is removed first (cc_settings)."""
    from . import cc_settings, channel, terminal_tools  # noqa: PLC0415 — needed by this subcommand alone

    installed = installed_copy(cwd)
    root = installed.root if installed else plugin_root()
    workspaces = Path(resolve_env()["workspaces_dir"]).resolve()
    anchors = workspaces / "*" / ANCHORS_DIR
    # the prompt the orientation's subagent reads first in terminal-first mode (orientation.subagent_prompt_file), and
    # the instructions of a background session's tray entry (bg_session.proxy_file)
    orient_prompt = workspaces / "*" / "orient" / "subagent-prompt.md"
    tray_prompts = workspaces / "*" / "bg" / "*.md"
    # on the Monitor route main arms its Monitor on the watcher again every 30 minutes, which must not wait on a prompt
    watcher = f"Bash({root / WATCHER} *)"
    tools_line = ",".join([MCP_TOOLS_RULE, f"Read(/{anchors}/**)", f"Read(/{orient_prompt})", f"Read(/{tray_prompts})",
                           watcher, *skill_rules(root)])
    cc_settings.clear_override(cwd)
    _sync_statusline(cwd)
    last = [last_main(cwd)] if resume else []
    turn_tools = terminal_tools.launch_value()
    return "\n".join([installed.channel if installed else cc_channel.channel(root), tools_line, cc_settings.main_effort_flag(cwd),
                      turn_tools, *last, channel.session_prompt(str(cwd.resolve()), bool(turn_tools))])


def _sync_statusline(cwd: Path) -> None:
    """The folder's statusline, set for terminal-first mode or put back (bg_session.sync_statusline)."""
    from . import bg_session  # noqa: PLC0415

    c = config.workspace_for_cwd(str(cwd))
    if c:
        bg_session.sync_statusline(c)


def cmd_launch_args(args: argparse.Namespace) -> int:
    print(launch_args(Path(args.cwd or os.environ.get("THIMBLE_CALLER_CWD") or os.getcwd()), bool(args.resume)))
    # on stderr, which the launcher leaves on the terminal, before Claude Code starts
    warning = claude_code_warning(claude_code_version())
    if warning:
        print(warning, file=sys.stderr)
    return 0


def cmd_prompt(args: argparse.Namespace) -> int:
    """Print prompt files for a skill's injected command. A missing file prints the loader's error line. With
    --unless-launched, nothing in a session the launcher started or for an action that opens no workspace. With --if-main
    (the SessionStart hook), nothing unless this runs in main's `claude` process (is_main); --lead is printed first."""
    if getattr(args, "unless_launched", False):
        action = ALIASES.get((args.action or "").strip(), (args.action or "").strip())
        if launched() or action not in OPENING or (action == RESUME and not (args.archive or "").strip()):
            return 0
    cwd = Path(args.cwd or os.environ.get("THIMBLE_CALLER_CWD") or os.getcwd())
    if getattr(args, "if_main", False) and not is_main(cwd):
        return 0
    from . import channel, prompts  # noqa: PLC0415 — the renderer, needed by this subcommand alone

    try:
        text = channel.render_prompts(args.names, str(cwd.resolve()))
    except prompts.PromptError as e:
        print(f"thimble: {e}")
        return 1
    lead = (getattr(args, "lead", None) or "").strip()
    print(f"{lead}\n\n{text}" if lead else text)
    return 0


def is_main(cwd: Path) -> bool:
    """Whether the `claude` process this command runs under (cc_channel.claude_pid) runs the session that is main in the
    workspace for `cwd`, by the server's record (GET /api/channel/main). False when the server is down, the folder is no
    workspace, or another session is main."""
    pid = cc_channel.claude_pid()
    if not pid:
        return False
    query = urllib.parse.urlencode({"cwd": str(cwd.resolve()), "pid": pid})
    status, body = _request("GET", f"{api_url()}/api/channel/main?{query}", timeout=3.0)
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


ENV_KEY_WARNING = ("Warning: {names} is set alongside {other}. The environment key takes precedence. Unset it to bill "
                   "the login.")


def auth_line(path: tuple[str, str] | None = None) -> str:
    """The auth path this process would take (config.auth_path, or `path` when the caller has it), named by kind and
    never by value; with the warning when an environment credential sits beside an apiKeyHelper or a CLI login."""
    kind, line = path or config.auth_path()
    if kind != "env":
        return line
    others = []
    if config.api_key_helper_source() is not None:
        others.append("an apiKeyHelper in the Claude settings")
    if (config.claude_config_dir() / config.CREDENTIALS_FILE).is_file() or config.keychain_login():
        others.append("a CLI login")
    if not others:
        return line
    return f"{line}. " + ENV_KEY_WARNING.format(names=" and ".join(config.env_credential_names()), other=" and ".join(others))


def model_calls_line(kind: str) -> str:
    """How the server's own model calls (the card check's reading, the labels classifier, a label's draft:
    model.structured) authenticate on the auth path of `kind` (config.auth_path), and "fail: ..." when they cannot. A
    CLI login in the macOS Keychain reaches no config dir but the served one, so they run there (agents.call_env)."""
    from . import claude_config  # noqa: PLC0415

    if kind in ("env", "helper"):
        return "the Messages API, on the credential above"
    if kind == "oauth_token":
        return f"the CLI, on {config.ENV_OAUTH_TOKEN}"
    if kind == "cli":
        if claude_config.login_linkable():
            return "the CLI, in each workspace's own config dir with the login file linked in"
        return (f"the CLI, in {config.claude_config_dir()} (its login is in the macOS Keychain, which a workspace's own "
                "config dir cannot reach)")
    return "fail: no login, so the card check, the labels classifier and a label's draft cannot run"


def auth_missing() -> bool:
    """Whether no auth path is known at all; False under THIMBLE_SKIP_KEY."""
    return not config._skip() and config.auth_path()[0] == "none"


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


BROWSER_FETCH = "backend/.venv/bin/python -m playwright install chromium-headless-shell"


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


def harness_line(url: str, up: bool) -> str:
    """Whether the card harness draws cards (render.py's headless Chromium), and the command that fixes it when it
    cannot: the running server's own answer, else whether the browser was fetched. Without it no card is checked, since
    the card check reads a card's picture."""
    if up:
        status, got = _request("GET", f"{url}/api/render/status")
        if status == 200 and isinstance(got, dict):
            if got.get("ready"):
                return f"ready ({got.get('pages')} pages)"
            return f"not drawing ({got.get('why') or 'starting'}); cards are not checked"
    browsers = playwright_browsers_dir()
    if any(browsers.glob("chromium_headless_shell-*")):
        return "headless Chromium fetched" + ("" if up else " (the server is down)")
    return f"no headless Chromium in {browsers}, so cards are not checked: run `{BROWSER_FETCH}` in {config.REPO_ROOT}"


def sandbox_lines() -> list[str]:
    """The doctor's `bash sandbox` line: whether Claude Code's Bash sandbox can run for the orientation (cc_settings.sandbox_ok)
    and, when not, what it lacks and the root commands that install it. Where it runs, the line names the empty
    `.claude/.cc-writes/` folder Claude Code creates in the folder a sandboxed command runs in."""
    from . import cc_settings  # noqa: PLC0415

    try:
        missing = cc_settings.sandbox_missing()
        cmds, what = cc_settings.sandbox_setup() if missing else ([], "")
    except Exception as e:  # noqa: BLE001 — the doctor reports; it never fails on one of its lines
        return [f"  bash sandbox: not checked ({type(e).__name__})"]
    if not missing:
        return ["  bash sandbox: runs (the orientation's and the view builds' Bash is sandboxed, with no network and no "
                "change to the corpus's files; Claude Code's sandbox adds an empty .claude/.cc-writes/ folder where its "
                "commands run, the corpus folder among them)"]
    head = "  bash sandbox: off, missing " + ", ".join(missing) + "; the orientation's Bash asks under your permission mode"
    if not cmds:
        return [head + (f"; {what}" if what else "")]
    return [f"{head}. To turn it on, run these, which {what}, then `thimble restart`:", *(f"    {c}" for c in cmds)]


# ----------------------------------------------------------------------------- versions and the machine
#
# What the doctor, the startup line of server.log and a failed `server up` say about the machine: the versions in play,
# free disk, who holds the port, how a session started here would hear the browser, and whether the API host answers.
# Each reader returns a short phrase and never raises, since the doctor must print even on a broken machine.

TESTED_CLAUDE_CODE = "2.1.281"  # INSTALL.md names the same version
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
    exe = os.environ.get("THIMBLE_CLAUDE_BIN") or shutil.which("claude")
    if not exe:
        return None
    try:
        out = subprocess.run([exe, "--version"], capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return None
    v = version_tuple(out.stdout or out.stderr)
    return ".".join(map(str, v)) if v else None


def claude_code_warning(version: str | None) -> str | None:
    """A line for the analyst when Claude Code is missing or older than the version thimble is tested with; None when
    it is that version or newer."""
    if version is None:
        return "thimble: WARNING - the `claude` CLI was not found on PATH; thimble runs inside Claude Code, so install it first."
    have, tested = version_tuple(version), version_tuple(TESTED_CLAUDE_CODE)
    if have and tested and have < tested:
        return (f"thimble: WARNING - Claude Code {version} is older than {TESTED_CLAUDE_CODE}, the version thimble is tested "
                "with; if something fails, run `claude update` and start thimble again.")
    return None


def claude_code_line() -> str:
    v = claude_code_version()
    warning = claude_code_warning(v)
    if warning:
        return warning.removeprefix("thimble: WARNING - ")
    return f"{v} (thimble is tested with {TESTED_CLAUDE_CODE})"


def _turn_endings_line() -> str:
    from . import terminal_tools  # noqa: PLC0415

    return terminal_tools.line()


def node_line() -> str:
    """Node's version, which only custom views need, with what to install when it is missing or too old."""
    exe = shutil.which("node")
    need = f"custom views need Node {NODE_MIN_MAJOR}+ (https://nodejs.org); everything else works without it"
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
    return out + ("" if modules.is_dir() else f"; {modules} is missing, so custom views cannot build (run `npm ci` in {FRONTEND_DIR})")


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
    who = f"pid {holder}: {procs.cmdline(holder)[:80]}" if holder else "a process this user cannot see"
    return (f"{p} is taken by another program ({who}) and thimble cannot start there; stop that program, or start "
            "thimble on a free port with THIMBLE_PORT=<port> thimble")


def delivery_line(cwd: Path) -> str:
    """How a session the launcher starts in `cwd` would hear the browser (cc_channel.delivery with the launcher's
    signal set): the channel, the plugin's hooks, or a Monitor, and why channels are off."""
    try:
        route = cc_channel.delivery(None, plugin_root(), cwd, {**os.environ, cc_channel.ENV: CHANNEL})
    except Exception as e:  # noqa: BLE001 — the doctor reports; it never fails on one of its lines
        return f"not checked ({type(e).__name__})"
    if route.mode == cc_channel.CHANNEL:
        return "channel (browser messages reach the session directly)"
    why = DOCTOR_CHANNELS_OFF.get(route.reason, route.reason)
    if route.mode == cc_channel.HOOK:
        return f"hooks ({why}; browser messages still arrive)"
    return f"Monitor ({why}, and hooks are off too; permission prompts show only in the terminal)"


DOCTOR_CHANNELS_OFF = {
    cc_channel.SESSION: "the session is started without channels",
    cc_channel.ORG: "your organization has turned Claude Code channels off",
    cc_channel.PROVIDER: "channels are not available with Bedrock, Vertex or Foundry",
    cc_channel.ACCOUNT: "channels need a claude.ai login, and this setup uses an API key, auth token or apiKeyHelper",
}


def api_host() -> str:
    base = os.environ.get("ANTHROPIC_BASE_URL") or ""
    host = urllib.parse.urlparse(base).hostname if base else None
    return host or API_HOST


def network_line(timeout_s: float = NET_TIMEOUT_S) -> str:
    """Whether a TCP connection to the API host on 443 opens within `timeout_s` (a thread bounds the name lookup,
    which has no timeout of its own). Nothing is sent."""
    host = api_host()
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
def doctor_text() -> str:
    st = read_state()
    env = resolve_env()
    p = int(st.get("port") or port())
    url = api_url(p)
    up = healthy(url)
    pid = st.get("pid")
    lines = ["thimble doctor"]
    lines.append(f"  versions: {_checked(versions_line)}")
    lines.append(f"  claude code: {_checked(claude_code_line)}")
    lines.append(f"  turn endings: {_checked(_turn_endings_line)}")
    lines.append(f"  node: {_checked(node_line)}")
    lines.append(f"  port: {_checked(port_line, p, up)}")
    lines.append(f"  server: {'up' if up else 'down'} at {url}; pid {pid or '-'} "
                 f"({'alive' if pid_alive(pid) else 'gone'}); started {st.get('started') or '-'}"
                 + (f"; stopped {st['stopped']}" if st.get("stopped") else ""))
    ui = int(st.get("ui_port") or ui_port())
    if env["dev"]:
        lines.append(f"  ui: http://127.0.0.1:{ui} (Vite, {'listening' if listening(ui) else 'not listening'}); dev mode on")
    elif has_ui_build():
        lines.append(f"  ui: {url} (the built UI at {config.FRONTEND_DIST}); dev mode off")
    else:
        lines.append(f"  ui: {config.NO_UI_BUILD_HINT}; dev mode off")
    if is_git_checkout():
        dirty = _git("status", "--porcelain")
        lines.append(f"  repo: {config.REPO_ROOT} (branch {git_branch()} @ {_git('rev-parse', '--short', 'HEAD') or '?'}, "
                     f"{len(dirty.splitlines())} uncommitted paths)")
    else:
        rel = release_line()
        lines.append(f"  repo: {config.REPO_ROOT} (not a git checkout{'; ' + rel if rel else ''})")
    lines.append(f"  source changed since start: {source_changed_text(st, up)}")
    lines.append(f"  home: {home()} ({'THIMBLE_HOME' if os.environ.get('THIMBLE_HOME') else 'default'}); "
                 f"server.json {'present' if server_json().is_file() else 'absent'}")
    recorded = (st.get("env") or {}).get("data_dir")
    data_src = "THIMBLE_DATA_DIR" if os.environ.get("THIMBLE_DATA_DIR") else "server.json" if recorded else "default $THIMBLE_HOME/data"
    lines.append(f"  data_dir: {env['data_dir']} ({'exists' if Path(env['data_dir']).is_dir() else 'missing'}; {data_src})")
    lines.append(f"  workspaces_dir: {env['workspaces_dir']} ({'exists' if Path(env['workspaces_dir']).is_dir() else 'missing'})")
    lines.append(f"  disk: {_checked(disk_line, [home(), Path(env['workspaces_dir'])])}")
    path = config.auth_path()
    lines.append(f"  auth: {auth_line(path)}")
    lines.append(f"  server's model calls: {model_calls_line(path[0])}")
    lines.append(f"  network: {_checked(network_line)}")
    caller = Path(os.environ.get("THIMBLE_CALLER_CWD") or os.getcwd())
    lines.append(f"  delivery (a session `thimble` starts in {caller}): {_checked(delivery_line, caller)}")
    lines.append(f"  card harness: {harness_line(url, up)}")
    lines += sandbox_lines()
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
    lines += [f"    {ln}" for ln in (recent[-LOG_TAIL:] if recent is not None else ["(no log yet)"])]
    errors = [ln for ln in recent or [] if _ERROR_LINE.search(ln)][-LOG_ERRORS:]
    lines.append(f"  recent errors in the log ({len(errors)} of its last {human_bytes(LOG_SCAN_BYTES)}):"
                 if errors else f"  recent errors in the log: none in its last {human_bytes(LOG_SCAN_BYTES)}")
    lines += [f"    {ln[:400]}" for ln in errors]
    return "\n".join(lines)


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


def fix() -> str:
    """Server down: the ticket runner on prompts/dev-fix.md in the live checkout. `dev` is imported lazily."""
    import asyncio  # noqa: PLC0415

    from . import dev  # noqa: PLC0415

    return asyncio.run(dev.fix_offline(doctor_text()))


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
    restart = {"restarting": "the server restarts with it", "restart_pending": "the server restarts with it once the "
               "orientation ends", "manual": "restart the server to load it: thimble server restart"}.get(
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


def cmd_ensure(args: argparse.Namespace) -> int:
    home().mkdir(parents=True, exist_ok=True)
    action = ALIASES.get((args.action or "").strip(), (args.action or "").strip())
    cwd = Path(args.cwd or os.environ.get("THIMBLE_CALLER_CWD") or os.getcwd())
    env = resolve_env()
    data_dir = Path(env["data_dir"])
    url = api_url()
    if action == "uninstall":
        print(UNINSTALL_SHELL_LINE)
        return 0
    if action == FEEDBACK:  # /thimble feedback: the report needs no server (plugin/bin/thimble runs it before this)
        from . import feedback  # noqa: PLC0415

        return feedback.run("", cwd=cwd, skill=True)
    if refused(cwd) and action != "status":  # $HOME or / as a corpus would index the analyst's whole machine
        print(REFUSED_LINE.format(path=cwd))
        return 0
    if in_sandbox():  # a server started here would die with the command, and the host's is out of reach
        from . import cc_settings  # noqa: PLC0415 — the settings' path, needed on this path alone

        print(SANDBOX_LINE.format(rule=sandbox_rule(), settings=cc_settings.config_dir() / "settings.json"))
        return 0
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
        print(f"thimble: the server did not start: {why}; see {log_path()}" if why else
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
            second = [RESUME_LINE] if not opened and resumes(url, name) else []
        print(f"thimble: {ui_url(name)}")
        for line in second:
            print(line)
        if args.session:
            route = cc_channel.delivery(cc_channel.claude_pid(), plugin_root(), cwd)
            lines = delivery_lines(route, cwd, str(args.session))
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
        if auth_missing():
            print(NO_AUTH_LINE)
        if args.session:
            warning = claude_code_warning(claude_code_version())
            if warning:
                print(warning)
    for line in notices + mark:
        print(line)
    return 0


def _action(args: argparse.Namespace, up: bool, url: str) -> int:
    a = args.action
    if a in ("fix", "repair"):
        if up:
            print(doctor_text())
            print(FIX_INSTRUCTION)
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


def cmd_doctor(_: argparse.Namespace) -> int:
    print(doctor_text())
    return 0


def cmd_fix(_: argparse.Namespace) -> int:
    if healthy():
        print(doctor_text())
        print(FIX_INSTRUCTION)
        return 0
    result = fix()
    for ln in restart():
        print(ln)
    print(result[:2000])
    return 0 if healthy() else 1


def cmd_revert(_: argparse.Namespace) -> int:
    """`thimble revert`. With the server down the revert happens in the checkout, and the server is started only when
    a change was taken back, since that change may be what kept it from starting."""
    res = revert()
    for ln in revert_lines(res):
        print(ln)
    if res.get("ok") and not healthy():
        for ln in restart():
            print(ln)
    return 0 if res.get("ok") else 1


# ----------------------------------------------------------------------------- update (INSTALL.md "Update")

RELEASE_ZIP_PATTERN = "thimble-*.zip"
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


def _gh_ok(gh: str, *args: str) -> bool:
    """True when `gh args` exits 0; False when it fails, times out or cannot start."""
    try:
        return subprocess.run([gh, *args], capture_output=True, text=True, timeout=60).returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


def download_release(repo: str, into: Path) -> tuple[Path | None, str, str]:
    """`gh release download` of the latest release's zip into `into`: (the file, "", "") on success, else (None, the
    cause, a detail). The cause is a key of UPDATE_FAILED_LINES; the detail is gh's first error line, for the "failed"
    line."""
    gh = shutil.which("gh")
    if not gh:
        return None, "no-gh", ""
    cmd = [gh, "release", "download", "--repo", repo, "--pattern", RELEASE_ZIP_PATTERN, "--dir", str(into)]
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
    return zips[-1], "", ""


def run_update_script(*args: str) -> int:
    """scripts/update.sh of this tree with `args`; its output passes through, its exit code is returned."""
    return subprocess.call(["bash", str(update_script()), *args])


def cmd_update(args: argparse.Namespace) -> int:
    """`thimble update [--from <zip>] [--dry-run]`: --from hands the zip to update.sh; no argument downloads the latest
    release with gh; a checkout skips the download (update.sh pulls). When the download fails: two lines naming the
    cause and the --from form, and exit 1."""
    extra = ["--dry-run"] if getattr(args, "dry_run", False) else []
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
        return run_update_script("--from", str(zip_path), *extra)


# ----------------------------------------------------------------------------- the `server` group

SERVER_UP_ALIASES = ("ensure",)


def cmd_feedback(args: argparse.Namespace) -> int:
    """The problem report for the workspace of the folder this runs in (feedback.run). plugin/bin/thimble runs
    feedback.py directly rather than this, so a report can be made while this module fails to import."""
    from . import feedback  # noqa: PLC0415

    cwd = Path(os.environ.get("THIMBLE_CALLER_CWD") or os.getcwd())
    return feedback.run(" ".join(args.description), cwd=cwd, logs=not args.no_logs)


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
    """`thimble server up`: start if needed, open this directory, print the URL; exit 0 whatever happens."""
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
                            ("fix", cmd_fix, "server down: run the fix ticket in the live checkout, then restart"),
                            ("revert", cmd_revert, "undo the last change thimble's dev agent applied")):
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
    u = sub.add_parser("update", help="bring the install up to date: the latest GitHub release via gh, or --from <zip>")
    u.add_argument("--from", dest="from_", metavar="ZIP", help="a downloaded release zip (thimble-<version>-<sha>.zip)")
    u.add_argument("--dry-run", action="store_true", help="print update.sh's steps; change nothing")
    u.set_defaults(fn=cmd_update)
    la = sub.add_parser("launch-args", help="for plugin/bin/thimble: the channel entry, the --allowedTools and --effort values, the tools that end a turn without text, then main's prompt")
    la.add_argument("--cwd")
    la.add_argument("--resume", action="store_true", help="a line before the prompt: the folder's last main session")
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
