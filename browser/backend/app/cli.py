"""The workbench's command line: `browser` starts the server and opens a folder (thimble-browser runs it), and the
others look after the server and its workspaces from a shell.

    python -m app.cli browser [--cwd <path>] [--detach] [--session new|continue|pick|<chat id>]
    python -m app.cli restart [--keep-vite] [--yes] | stop [--yes]
    python -m app.cli doctor [--verbose] | unpair | fix | revert
    python -m app.cli feedback ["description"] [--no-logs]   (a problem report as a zip; feedback.py)
    python -m app.cli list                    (the workspaces by id, archived runs included; runs.py)
    python -m app.cli purge <id>... [--dry-run]  (delete workspaces or archived runs by id; runs.py)

<home> is `~/.thimble` or THIMBLE_HOME, which thimble-browser sets to its own home. <home>/server.json records {port,
pid, url, repo, env, token}, readable by its owner alone; `token` is new at each start and is what this CLI proves it
holds (hook_auth.py). A browser signs in with the link's key from ui_url(pair=True), the same every time, never with
a value from this file. Only a terminal gets a link with the key: thimble-browser prints it at its start, and again for
a browser that is not signed in and opens the page once the key changed (new_links). `unpair` signs every browser out
and changes the key. Its `pid` is trusted only while it is a thimble server on its port (is_server checks the command
line and working folder, since a pid recorded inside a sandbox's pid namespace can name an unrelated host process).
reconcile makes the record true before a start acts on it. A server whose /api/health names another THIMBLE_HOME belongs to another
install. This install's own server is the one whose /api/health names that pid as its leader (own_server):
thimble-browser prints a link to it alone, and `stop` ends that pid alone. A server server.json does not record is never
taken for it nor stopped, even one of this checkout and THIMBLE_HOME, such as one left running when its home was deleted
under it, which reads the token of the new server.json all the same.

The port: THIMBLE_PORT when the caller sets it, else the one server.json records, else DEFAULT_PORT (8300). Without
THIMBLE_PORT, a start whose port another program, another install's server or a server that answers but is not this
install's own holds starts on a free port instead (pick_port), as does a second start when the server could not bind
its port (lost_port), and server.json records it, so every reader finds the server there: this CLI and the browser link
(ui_url). With THIMBLE_PORT that port alone is used: another install's server there is refused with FOREIGN_LINE, and
any other process there makes the start fail (start_failure). Vite's UI port in dev mode follows the same rule with
THIMBLE_UI_PORT (DEFAULT_UI_PORT, 5300).

`restart` and `stop` name the work they would interrupt (running_work) and ask first unless `--yes`. This module
imports only `config`, `headless`, `procs` and the standard library (others lazily), never `app.notebook`.
"""
from __future__ import annotations

import argparse
import errno
import fcntl
import hashlib
import json
import os
import platform
import re
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterator, NamedTuple

from . import config, headless, procs

DEFAULT_PORT = 8300
DEFAULT_UI_PORT = 5300
VALIDATION_PORTS = (8301, 5301)  # scripts/dev/dev_stack.sh's defaults; THIMBLE_STACK_PORT and _UI_PORT move them
PORT_SCAN = 50  # the ports above a taken one that pick_port tries in turn, before it takes one the system gives
BACKEND_DIR = config.REPO_ROOT / "backend"
FRONTEND_DIR = config.REPO_ROOT / "frontend"
WAIT_S = 20.0  # how long a command waits for a server it started to answer (start_wait_s)
LOCK_WAIT_S = 30.0
STOP_WAIT_S = 6.0
# how long the server has, after its SIGTERM, to stop its agents and end (runtime.stop_all) before what is left of its
# session is signalled (_kill): uvicorn's graceful wait (3 s), the agents' (runtime.STOP_WAIT_S) and the modules' own
SERVER_STOP_S = 15.0
HEALTH_TIMEOUT_S = 1.0  # how long a health probe waits for the server's answer (health_timeout_s)
LOG_TAIL = 15


def start_wait_s() -> float:
    """How long a command waits for a server it started to answer: THIMBLE_START_WAIT_S, as the tests that start real
    servers set it for a machine their parallel runs keep busy, else WAIT_S, also when it is not a positive number."""
    try:
        got = float(os.environ.get("THIMBLE_START_WAIT_S") or WAIT_S)
    except ValueError:
        return WAIT_S
    return got if 0 < got < float("inf") else WAIT_S


def health_timeout_s() -> float:
    """How long a health probe waits for the server's answer: THIMBLE_HEALTH_TIMEOUT_S, as the tests that start real
    servers set it for a machine their parallel runs keep busy, where an answer can take longer than HEALTH_TIMEOUT_S
    and a late one would read as no server or as this install's own; else HEALTH_TIMEOUT_S, also when it is not a
    positive number."""
    try:
        got = float(os.environ.get("THIMBLE_HEALTH_TIMEOUT_S") or HEALTH_TIMEOUT_S)
    except ValueError:
        return HEALTH_TIMEOUT_S
    return got if 0 < got < float("inf") else HEALTH_TIMEOUT_S


FIX_INSTRUCTION = "File a `file_dev_ticket` titled 'fix: …' describing what broke; the dev agent runs it as a ticket."
# `thimble fix` and `thimble revert` change thimble's own code, which only a development install (a git clone of thimble)
# can do: a release install has no dev agent to repair it and no applied change to take back (dev.RELEASE_LINE)
DEV_ONLY_LINES = {
    "fix": ("thimble fix changes thimble's own code, which only a development install (a git clone of thimble) can do, "
            "and this is a release install. Report a problem, in thimble's page, writes a problem report to send the "
            "developer."),
    "revert": ("thimble revert takes back a change thimble's dev agent made to thimble's own code, which happens only in a "
               "development install (a git clone of thimble). This is a release install, so there is nothing to revert."),
}
FINGERPRINT_GLOBS = ("backend/app/**/*.py", "prompts/**/*", "plugin/bin/*", "plugin/.mcp.json")
NO_AUTORESTART_ENV = "THIMBLE_NO_AUTORESTART"
SOURCE_CHANGED = "source changed"  # restart.json's title; dev.PLAIN_REASONS
RESTARTED_LINE = "thimble: server restarted (source changed)"
NOT_RESTARTED_LINE = "thimble: source changed since the server started; not restarting while {reason}"
NO_UI_LINE = ("thimble: the dashboard is not built yet, so its link shows no page; press Ctrl-C, then run "
              "`thimble-browser` again, which builds it first.")
# a server of this install that runs, holding its port, but does not answer (out of file descriptors, or its loop held)
STUCK_LINE = f"thimble's server (pid {{pid}}) is running but does not answer; to restart it, {config.RESTART_HOW}"
STUCK_AFTER_S = 60.0  # a server server.json says started less long ago may still be starting, so is not called stuck
REVERTED_LINE = "thimble: reverted \"{title}\" ({commit})"
ARCHIVE_TIMEOUT_S = 60.0  # the archive stops a writer's session first, a few seconds each
# marks the uvicorn `start` spawns, so a server knows the supervisor started it and may restart itself after a ticket
# applies (dev.supervised); a server started by hand lacks it and is never restarted by a ticket
SUPERVISED_ENV = "THIMBLE_SUPERVISED"
# The agents defined for a session thimble starts with `--agents` (agent_definition: the writer's and the check's), each
# from a prompt file in a plugin agent's form (prompts.agent_file).
AGENT_FIELDS = ("model", "effort", "background")  # the frontmatter fields passed on as they are
PLUGIN_NAME = "thimble"  # the plugin's name, which prefixes its skills (`thimble:shared`) outside a plugin agent's file
RESTART_MARK_S = 60.0  # a `source_restart` mark in server.json younger than this means a restart is under way
FOREIGN_UNNAMED = "<its THIMBLE_HOME>"  # foreign_home's answer for a server that names no home to this install
FOREIGN_LINE = ("thimble: port {port} (set by THIMBLE_PORT) is in use by another program. Set THIMBLE_PORT to a free "
                "port, or unset it and thimble picks one.")
SANDBOX_ENV = "SANDBOX_RUNTIME"  # "1" in a command Claude Code's Bash sandbox runs (module note, the Bash sandbox)
MANUAL_RESTART = "manual restart"  # dev.PLAIN_REASONS
# what `restart` says before it asks (running_work, module note)
RUNNING_HEAD = "thimble: running now:"
RUNNING_BACK_LINE = ("A restart stops them. Once the server is back, the writers resume by themselves, and a view build "
                     "or dev ticket starts again.")
RESTART_QUESTION = "Restart the server now? [y/N] "
RESTART_UNASKED_LINE = "thimble: not restarted, since there is no terminal to ask in; pass --yes to restart anyway."
RESTART_DECLINED_LINE = "thimble: not restarted."
STOP_BACK_LINE = ("A stop ends them. The server's next start resumes the writers, and starts a view build or dev ticket "
                  "again.")
STOP_QUESTION = "Stop the server now? [y/N] "
STOP_UNASKED_LINE = "thimble: not stopped, since there is no terminal to ask in; pass --yes to stop anyway."
STOP_DECLINED_LINE = "thimble: not stopped."
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
    """server.json, written whole into the private home (ensure_home), with the token the file held when `state` names
    none, else a new one (hook_auth.py). The browser key earlier builds kept here is dropped: a browser signs in with
    the link's key (ui_url)."""
    ensure_home()
    held = read_state()
    if not state.get("token"):
        state = {**state, "token": held.get("token") or new_token()}
    state = dict(state)
    state.pop("ui_key", None)
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


STATE_ENV_KEYS = ("data_dir", "workspaces_dir", "home")


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
            "home": str(home()), "dev": dev}


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


def healthy(url: str | None = None, timeout: float | None = None) -> bool:
    try:
        wait = health_timeout_s() if timeout is None else timeout
        with config.LOOPBACK.open(f"{url or api_url()}/api/health", timeout=wait) as r:
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
    """Whether a server of this install holds port `p`, answering or not: the pid server.json names is a thimble server
    on `p`, or the process listening on `p` is a thimble server of this checkout started with this THIMBLE_HOME (or
    whose environment cannot be read). start keeps the port for one that does not answer, so a stuck server is named
    (start_failure) rather than left running beside a new one."""
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
    status, body = _request("GET", f"{url or api_url()}/api/health", timeout=health_timeout_s())
    leader = body.get("leader") if status == 200 and isinstance(body, dict) else None
    return leader if isinstance(leader, int) and not isinstance(leader, bool) and leader > 0 else None


def foreign_home(url: str | None = None) -> str | None:
    """The THIMBLE_HOME of the server answering at `url` when it is another install's; None when it is this install's, or
    nothing answers. Two installs start on the same default port, and the second passes over it (pick_port). A server
    names its home only to a request that proves its token (main's /api/health), so a healthy server that names none
    took this install's proof for no proof: another install's or another account's, whose home is FOREIGN_UNNAMED
    here."""
    status, body = _request("GET", f"{url or api_url()}/api/health", timeout=health_timeout_s())
    if status != 200 or not isinstance(body, dict) or body.get("ok") is not True:
        return None
    other = body.get("home")
    if not isinstance(other, str) or not other:
        return FOREIGN_UNNAMED
    return None if _this_home(other) else other


def serves(url: str | None = None) -> bool:
    """Whether a server of this install answers at `url` (default api_url): healthy, and not another install's
    (foreign_home). It may still be one server.json does not record, which is not this install's own (own_server)."""
    url = url or api_url()
    return healthy(url) and foreign_home(url) is None


def own_server(url: str | None = None, pid: int | None = None) -> bool:
    """Whether this install's own server answers at `url` (default api_url): the server there names as the leader of its
    process session `pid`, the uvicorn `start` just spawned, else the pid server.json records (health_leader, which a
    server names only to a request that proves the token it holds). Not a server of this checkout that server.json does
    not record either, such as one left running when its home was deleted under it, which reads the token of the new
    server.json all the same (module note)."""
    leader = health_leader(url)
    return leader is not None and leader == (pid or read_state().get("pid"))


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
    """server.json made true: a recorded pid that is no thimble server on its port is cleared, unless the server
    answering there names it as its leader (own_server: it is, though its command line could not be read), and a dead
    Vite pid is cleared. A server it does not record is never adopted, as it is not this install's own (module note).
    The state, written back when it changed; {} when there is no record."""
    st = read_state() if st is None else st
    if not st:
        return st
    p = int(st.get("port") or port())
    changed = False
    pid = st.get("pid")
    if pid and not is_server(pid, p, st.get("repo")) and not own_server(api_url(p), pid):
        _log(f"server.json named pid {pid}, which is not a thimble server on port {p}; cleared")
        st["pid"], changed = None, True
    vite = st.get("vite_pid")
    if vite and (not pid_alive(vite) or argv_check("vite")(int(vite)) is not None):
        st["vite_pid"], changed = None, True
    if changed:
        write_state(st)
    return st


def in_sandbox() -> bool:
    """Whether this command runs inside Claude Code's Bash sandbox."""
    return os.environ.get(SANDBOX_ENV, "").strip() == "1"


def _request(method: str, url: str, body: dict | None = None, timeout: float = 5.0) -> tuple[int, Any]:
    """(status, parsed json | text). Transport failures are (0, message); an HTTP error is (status, its body). The
    request proves the server's token (hook_auth), which the routes of hooks, the plugin and this CLI need. A notebook
    kernel holds none."""
    from . import hook_auth  # noqa: PLC0415

    data = json.dumps(body).encode() if body is not None else None
    headers = {"Content-Type": "application/json"}
    tok = hook_auth.token()
    if tok:  # good only on the port `url` names, for a few minutes, once: a process that holds that port gains nothing
        headers.update(hook_auth.headers(tok, hook_auth.port_of(url)))
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


HOLDERS_LOCK = "holders.lock"  # <home>/: each thimble-browser that holds a terminal holds it shared (hold_server)
HELD: dict[str, int] = {}  # hold_server's file descriptor on HOLDERS_LOCK, open until this process ends


def hold_server() -> None:
    """Hold the server for this thimble-browser. One server serves every folder, so the thimble-browser of a second
    folder uses the server that the first one started, and quitting stops it only when no other thimble-browser holds
    it (last_holder). The hold is a shared lock on <home>/holders.lock, which the system lets go when the process ends,
    however it ends. It waits while a thimble-browser that quit stops the server, so that a start then starts a new
    server. When the lock cannot be taken, this thimble-browser stops the server when it quits."""
    if "fd" in HELD:
        return
    path = home() / HOLDERS_LOCK
    try:
        ensure_home()
        fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o600)
    except OSError as e:
        _log(f"could not open {path}: {e}")
        return
    try:
        fcntl.flock(fd, fcntl.LOCK_SH)
    except OSError as e:
        os.close(fd)
        _log(f"could not lock {path}: {e}")
        return
    HELD["fd"] = fd


def last_holder() -> bool:
    """Whether this thimble-browser is the last that holds the server (hold_server), so that quitting stops it. It lets
    its shared lock go, then takes the lock alone, and keeps it while it stops the server, until the process ends. Of
    two that quit at once, one gets it. False while another thimble-browser holds the server; True when this one holds
    no lock."""
    fd = HELD.get("fd")
    if fd is None:
        return True
    try:
        fcntl.flock(fd, fcntl.LOCK_UN)
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        return False
    except OSError as e:
        _log(f"could not lock {home() / HOLDERS_LOCK}: {e}")
    return True


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
    lock. Without THIMBLE_PORT, when the port is not free, the server starts on a free port instead (pick_port), unless
    a server of this install that does not answer holds it (held_by_this_install): a server that answers there is not
    this install's own, which the caller found not answering (own_server). In dev mode, without THIMBLE_UI_PORT, Vite
    does the same where the UI port is not free and no Vite of this install serves it (own_vite)."""
    if p is None:
        p = port()
        if explicit_port() is None and not port_free(p) and (healthy(api_url(p))
                                                              or not held_by_this_install(p, read_state())):
            q = pick_port(p, (ui_port(),))
            _log(f"port {p} is taken by another program, another install's server or a server that is not this "
                 f"install's own; starting on port {q}, a free one")
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
    """Up to `wait_s` for this install's own server to answer at `url` (own_server): `pid`, the uvicorn just spawned,
    else the server server.json records. Another server that answers there is not it: with `pid` the wait ends as soon
    as that process has exited, since a server that failed at start, as one that could not bind a port another process
    holds, will not answer later."""
    deadline = time.monotonic() + wait_s
    while True:
        if own_server(url, pid):
            return True
        if time.monotonic() >= deadline:
            return False
        if pid is not None and spawned_exited(pid):
            return False
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


def _kill(pid: int | None, check, label: str, settle_s: float = 0.0) -> str:
    """SIGTERM then SIGKILL the session `pid` leads, only while `check(pid)` finds it is still the process server.json
    meant. Never a name pattern, never a port. With `settle_s` (the server), `pid` alone has its SIGTERM first and up to
    that long to end what it runs itself, as the server stops its agents (runtime.stop_all) so each ends `stopped`; the
    rest of its session (what it could not stop) is signalled after."""
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
    if settle_s > 0:
        _signal_all([pid], signal.SIGTERM)
        deadline = time.monotonic() + settle_s
        while pid_alive(pid) and time.monotonic() < deadline:
            time.sleep(0.1)
        if not any(pid_alive(q) for q in victims):
            more = f" ({len(victims)} processes)" if len(victims) > 1 else ""
            return f"{label}: pid {pid} stopped{more}"
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


def _own_conn(rec_path: Path, conn: str) -> bool:
    """Whether `conn` names the connection file of the kernel whose record is `rec_path`, <key>.conn.json beside it, as
    notebook writes it: the record lies in kernels/ of a workspace, which a card's code writes, so the connection file
    it names, which says which process is the kernel and which file goes with it, is checked to be the record's own."""
    p = Path(conn)
    return p.is_absolute() and p.name == rec_path.name[: -len(".json")] + ".conn.json" \
        and os.path.realpath(p.parent) == os.path.realpath(rec_path.parent)


def kernel_processes(ws_dir: Path) -> list[tuple[int, int | None, str, Path | None]]:
    """(pid, pgid, connection file, record) of every kernel of the workspaces under `ws_dir`: the ones the records
    name, plus any live ipykernel of this user no record claims whose connection file or working directory lies under
    a workspace. A record whose pid is dead or another program's, or whose connection file is not its own (_own_conn),
    is listed with pid 0 and no connection file. A kernel leads its own process group (notebook._launch), so the group
    signalled is its pid's, never one a record names."""
    from . import nofollow  # noqa: PLC0415

    out: list[tuple[int, int | None, str, Path | None]] = []
    seen: set[str] = set()
    for rec_path in sorted(ws_dir.glob(f"*/{KERNELS_DIR}/*.json")):
        if rec_path.name.endswith(".conn.json"):
            continue
        try:  # in a workspace a card's code writes: never through a link or a FIFO left there
            rec = json.loads(nofollow.read_text(rec_path, root=ws_dir))
        except (OSError, ValueError):
            continue
        if not isinstance(rec, dict):
            continue
        conn = str(rec.get("connection_file") or "")
        conn = conn if _own_conn(rec_path, conn) else ""
        pid = rec.get("pid")
        pid = pid if isinstance(pid, int) and pid > 0 else 0
        seen.add(conn)
        out.append((pid if conn and _is_kernel(pid, conn) else 0, None, conn, rec_path))
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


def _kernel_file(conn: str, ws_dir: Path) -> bool:
    """Whether `conn` is a kernel's connection file in kernels/ of a workspace under `ws_dir`
    (<ws>/kernels/<key>.conn.json), the only file a kernel's command line names that thimble removes."""
    p = Path(conn)
    return p.is_absolute() and p.name.endswith(".conn.json") and p.parent.name == KERNELS_DIR \
        and os.path.realpath(p.parent.parent.parent) == os.path.realpath(ws_dir)


def stop_kernels(ws_dir: Path | None = None) -> str:
    """End every notebook kernel of the workspaces under `ws_dir` and drop their records and connection files."""
    from . import nofollow  # noqa: PLC0415

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
        # a record and the connection file a kernel was started on (`-f`) when it is one of kernels/ of a workspace,
        # each removed as nofollow removes it, never through a link
        for f in (rec_path, Path(conn) if conn and _kernel_file(conn, ws_dir) else None):
            if f is not None and f.is_file():
                try:
                    nofollow.unlink(f, root=ws_dir, missing_ok=False)
                    dropped += 1
                except (OSError, ValueError):
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
    """Stop the kernels, the backend recorded in server.json (by pid: the server this install started, never one found
    on its port, module note), Vite unless `vite=False`, then the kernels once more. With `kernels=False` (a restart)
    they stay for the next server to reconnect: the hand-off tells the server so before it gets its SIGTERM
    (hand_over_kernels)."""
    st = read_state()
    p = int(st.get("port") or port())
    lines = [stop_kernels()] if kernels else []
    if not kernels and st.get("pid") and pid_alive(st.get("pid")):
        hand_over_kernels(int(st["pid"]))
    lines.append(_kill(st.get("pid"), server_check(p, st.get("repo")), "server", SERVER_STOP_S))
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
    """This install's own server answering (own_server), else under the lock a start if it still does not, and a wait
    until it does. Restarts Vite in dev mode when only it is down, and a healthy server whose source changed since it
    started (auto_restart). Another server on the port, another install's or one server.json does not record, is not
    this install's own: start passes over the port then, and once more when the server it spawned could not bind the
    port it chose (lost_port). The server is at api_url() after it returns."""
    url = api_url()
    if own_server(url):
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
        if not own_server(url) and not starting(url):
            spawned = start().get("pid")
            url = api_url()
        up = wait_healthy(url, wait_s, spawned)
        if not up and spawned and lost_port(int(spawned)):
            _log(f"another process holds port {LAST_START.get('port')}, which the server could not bind; starting anew")
            spawned = start().get("pid")
            url = api_url()
            up = wait_healthy(url, wait_s, spawned)
        reconcile()  # a uvicorn that could not bind its port leaves its dead pid, which is cleared
        return up


def lost_port(spawned: int) -> bool:
    """Whether the server `start` spawned as `spawned` exited because another process holds its port: one that took it
    after start looked (a second install starting at the same moment), or a server that did not answer start's look.
    Without THIMBLE_PORT a second start then picks again, and passes over the port when that server answers now."""
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
    """Called by the server at start-up: when server.json is about this process, refresh its fingerprint and the tree
    it runs from (repo). A restart under the same pid may start it in another tree (a thimble fix that goes on starts
    it from the checkout of the person's fixes, fixes.restart), and stop finds it there by that record."""
    st = read_state()
    if not st or st.get("pid") != (pid or os.getpid()):
        return False
    fp, repo = source_fingerprint(), str(config.REPO_ROOT)
    if st.get("source_fingerprint") == fp and st.get("repo") == repo:
        return False
    st.update(source_fingerprint=fp, repo=repo)
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
    """Why the server must not be restarted now: a job, ticket, report generation, or any other session or view build its
    stop would end (running_work). None when idle; a server that does not answer is a reason."""
    names = _workspace_names(Path(resolve_env()["workspaces_dir"]))
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
    """What a restart of the server at `url` would interrupt, one line each: the dev ticket the server runs (`GET
    /api/dev/status`). Empty when nothing runs."""
    lines: list[str] = []
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
UNPAIRED_LINE = ("thimble: every browser is signed out of thimble, and the sign-in links printed before no longer "
                 "work. The new link shows in the terminal where `thimble-browser` runs, or at its next start.")
UNPAIR_FAILED_LINE = ("thimble: the server did not sign the browsers out ({why}), so they stay signed in until it "
                      f"restarts. To restart it, {config.RESTART_HOW}.")


def pair_code(api: str) -> str:
    """The sign-in link's key from the server at `api` (`POST /api/ui/pair`, which needs the token: hook_auth.link_key),
    the same every time until `thimble-browser --unpair`. '' when the server gives none, which is logged."""
    status, body = _request("POST", f"{api}/api/ui/pair", {}, timeout=PAIR_TIMEOUT_S)
    code = body.get("code") if status == 200 and isinstance(body, dict) else None
    if isinstance(code, str) and code:
        return code
    _log(f"no sign-in key from {api}: {status} {str(body)[:200]}")
    return ""


def ui_url(name: str | None, pair: bool = False) -> str:
    """The UI port in dev mode (its own Vite), else the API port where the built UI is served, and with `pair` the
    link's key after `#p=` (hook_auth.link_key, pair_code), which the page trades for the browser's cookie. The URL
    without a key when the server gives none."""
    st = read_state()
    base = str(st.get("url") or api_url())
    url = f"{base}/?ws={name}" if name else f"{base}/"
    code = pair_code(str(st.get("api") or api_url())) if pair else ""
    return f"{url}#p={code}" if code else url


def to_terminal() -> bool:
    """Whether stdout is a terminal, the analyst's; a command's output read by a program can reach a model's context."""
    return sys.stdout.isatty()


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


def has_ui_build() -> bool:
    return (Path(config.FRONTEND_DIST) / "index.html").is_file()


# ----------------------------------------------------------------------------- status


# ----------------------------------------------------------------------------- doctor


def is_git_checkout() -> bool:
    return config.git_dir() is not None


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


def browser_fix(kind: str) -> str:
    """The doctor's fix for `kind`'s missing headless Chromium: the command that fetches it (headless.fetch_command),
    then a new start of the server."""
    return f": `{headless.fetch_command(kind)}` fetches it; then {config.RESTART_HOW}"


def harness_line(url: str, up: bool, commands: bool = True) -> str:
    """Whether the card harness draws cards (render.py's headless Chromium), and with `commands` the command that fixes
    it when it cannot: the running server's own answer, else whether the browser was fetched. Without it no card is
    checked, since the card check reads a card's picture."""
    fetched = headless.fetched(headless.browsers_json(headless.HARNESS) or Path("-"))
    which, what = _browser_choice()
    fetched = fetched or which == "system"
    fix = browser_fix(headless.HARNESS) if commands and what != _browser_off() else ""
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
    return f"no headless Chromium in {headless.browsers_dir()}, so cards are not checked{fix}"


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
    fix = browser_fix(headless.PAGES) if commands and what != _browser_off() else ""
    if which == "system":
        return f"the system browser, {what}"
    if which == "off":
        return f"no browser ({what}), so {headless.SKIPPED[headless.PAGES]}{fix}"
    if headless.fetched(browsers_json):
        return "headless Chromium fetched"
    return f"no headless Chromium in {headless.browsers_dir()}, so {headless.SKIPPED[headless.PAGES]}{fix}"


def sandbox_lines(commands: bool = True) -> list[str]:
    """The doctor's `bash sandbox` line: whether Claude Code's Bash sandbox can run (cc_settings.sandbox_ok), which
    `thimble fix` runs its Bash in where it runs, unless thimble's config says `sandbox.use` "never"; when it cannot
    run, what it lacks and with `commands` the root commands that install it. Without it `thimble fix` asks first
    (dev.FIX_QUESTION), unless `sandbox.enforce` refuses it."""
    from . import cc_settings, userconf  # noqa: PLC0415

    head = "  bash sandbox (thimble fix): "
    try:
        missing = cc_settings.sandbox_missing()
        cmds, what = cc_settings.sandbox_setup() if missing else ([], "")
    except Exception as e:  # noqa: BLE001 — the doctor reports; it never fails on one of its lines
        return [f"{head}not checked ({type(e).__name__})"]
    try:
        box = userconf.load_or_defaults()[0]["sandbox"]
    except Exception:  # noqa: BLE001
        box = userconf.DEFAULTS["sandbox"]
    without = ("thimble's config (sandbox.enforce) refuses to start it without it" if box.get("enforce") else
               "it runs without it and asks you first")
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


# ----------------------------------------------------------------------------- versions and the machine
#
# What the doctor, the startup line of server.log and a failed start say about the machine: the versions in play, free
# disk, who holds the port, and whether the API host answers. Each reader returns a short phrase and never raises,
# since the doctor must print even on a broken machine.

TESTED_CLAUDE_CODE = "2.1.307"  # INSTALL.md and CI (.github/workflows/ci.yml) name the same version
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


OLDER_LINE = ("thimble: WARNING - Claude Code {version} is older than {tested}, the version thimble is tested with; if "
              "something fails, run `claude update` and start thimble again.")
NEWER_LINE = ("thimble: Claude Code {version} is newer than {tested}, the version {thimble} was tested with. If agents do "
              "not start or their chats stop updating, report it with Report a problem in thimble's page.")


def _thimble_named() -> str:
    """`thimble 0.10.10`, from the tag of the release this install came from, which the release record names
    (release.json in fixes.fixes_home), or `thimble` when no record names one, as in a git checkout."""
    from . import fixes  # noqa: PLC0415 — fixes imports more than the doctor's other lines need

    rec = _read_json(fixes.fixes_home() / "release.json")
    tag = str(rec.get("tag") or "") if isinstance(rec, dict) else ""
    return f"thimble {tag.removeprefix('v')}" if tag else "thimble"


OLDER, NEWER = "older", "newer"  # how a Claude Code's version stands to thimble's (claude_code_case)


def claude_code_case(version: str | None) -> str | None:
    """OLDER below the version thimble is tested with, NEWER above it; None for that version, or when `version` names
    none."""
    have, tested = version_tuple(version), version_tuple(TESTED_CLAUDE_CODE)
    if not (have and tested) or have == tested:
        return None
    return OLDER if have < tested else NEWER


def claude_code_warning(version: str | None) -> str | None:
    """A line for the analyst about the Claude Code thimble runs with (claude_code_case). None for the tested version,
    or when its version is not known (config.auth_problem says when `claude` is missing)."""
    case = claude_code_case(version)
    if case == OLDER:
        return OLDER_LINE.format(version=version, tested=TESTED_CLAUDE_CODE)
    if case == NEWER:
        return NEWER_LINE.format(version=version, tested=TESTED_CLAUDE_CODE, thimble=_thimble_named())
    return None


def claude_code_line(commands: bool = True) -> str:
    """The doctor's Claude Code line: its version and what claude_code_warning says of it, in the doctor's own words.
    Without `commands` it names no command to run."""
    v = claude_code_version()
    if v is None:
        return (config.NO_CLAUDE if commands else config.NO_CLAUDE_FOUND) if not config.CLI_PATH else \
            "`claude --version` printed no version"
    case, warning = claude_code_case(v), claude_code_warning(v)
    if not warning:
        return f"{v} (thimble is tested with {TESTED_CLAUDE_CODE})"
    if commands:
        return warning.removeprefix("thimble: WARNING - ").removeprefix("thimble: ")
    if case == OLDER:
        return f"{v}, older than {TESTED_CLAUDE_CODE}, the version thimble is tested with"
    return f"{v}, newer than {TESTED_CLAUDE_CODE}, the version {_thimble_named()} was tested with"


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


PORT_STUCK_LINE = (f"{{p}} is held by thimble's server (pid {{pid}}), which does not answer; to restart it, "
                   f"{config.RESTART_HOW}")
PORT_TAKEN_LINE = ("{p} is taken by another program ({who}) and thimble cannot start there; stop that program, or start "
                   "thimble-browser on a free port with `thimble-browser --port <port>`")


def port_line(p: int, up: bool) -> str:
    """Who holds the server's port: thimble, nobody, or another program, named, with the way around it."""
    if up:
        return f"{p} (thimble answers there)"
    if not listening(p):
        return f"{p} (free)"
    holder = procs.listener(p)
    if holder and is_server(holder, p):
        return PORT_STUCK_LINE.format(p=p, pid=holder)
    who = f"pid {holder}: {procs.cmdline(holder)[:80]}" if holder else "a process this user cannot see"
    return PORT_TAKEN_LINE.format(p=p, who=who)


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
    if is_git_checkout():
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
def doctor_text(commands: bool = True) -> str:
    """What `thimble doctor` prints. Without `commands` its lines name no command that installs anything, for a model
    to read (`thimble fix`, `/thimble fix`). The lines only a developer of thimble reads (source changed since start,
    the validation stack, the last apply, the dev tickets and their last error) are printed only in a development
    install."""
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
    lines.append(f"  node: {_checked(node_line, commands)}")
    lines.append(f"  python: {_checked(python_line)}")
    port_text = _checked(port_line, p, up)
    lines.append(f"  port: {port_text}")
    stuck = None if up or config.RESTART_HOW in port_text else _checked(stuck_server, url)
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
        lines.append(f"  repo: {config.REPO_ROOT} (not a git checkout)")
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
    lines.append(f"  config: {_checked(config_line, Path(env['workspaces_dir']))}")
    lines.append(f"  browser: {_checked(browser_line)}")
    lines.append(f"  card code: {_checked(kernel_line, commands)}")
    lines.append(f"  card harness: {harness_line(url, up, commands)}")
    lines.append(f"  views and screenshots: {_checked(pages_line, commands)}")
    lines += sandbox_lines(commands)
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
    return Check(True, "Server not running (it starts with thimble-browser)")


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
    got = headless.check() if which != "system" else {"ok": True}
    if not got["ok"]:
        return Check(False, "No browser for screenshots", got["fix"])
    return Check(True, "Views and screenshots ready")


def _when_wrong_checks() -> list[Check]:
    """The areas the checklist names only when something is wrong: thimble's config and the disk."""
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
    return out


def _checked_check(area: str, fn, *args) -> list[Check]:
    """A check's lines, or one line that says it could not be checked: the checklist prints whatever else it can."""
    try:
        got = fn(*args)
    except Exception as e:  # noqa: BLE001 — the doctor reports; it never fails on one of its lines
        return [Check(False, f"{area} not checked ({type(e).__name__})", f"{VERBOSE_FIX} has details")]
    return got if isinstance(got, list) else [got]


def doctor_checks(cwd: Path) -> list[Check]:
    """The doctor's checklist, in order: versions, sign-in, server, card code, views and screenshots, then only what is
    wrong of the config and the disk."""
    out = [*_checked_check("Versions", _version_check), *_checked_check("Sign-in", _sign_in_check),
           *_checked_check("Server", _server_check), *_checked_check("Card code", _card_code_check),
           *_checked_check("Views", _views_check)]
    with server_dirs():
        out += _checked_check("Setup", _when_wrong_checks)
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
        if not own_server():
            start()
        up = wait_healthy(api_url(), start_wait_s())
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


def cmd_doctor(args: argparse.Namespace) -> int:
    """`thimble doctor`: the checklist (doctor_check_text) for the folder it runs in; with `--verbose` the full text
    (doctor_text)."""
    caller = Path(os.environ.get("THIMBLE_CALLER_CWD") or os.getcwd())
    print(doctor_text() if getattr(args, "verbose", False) else doctor_check_text(caller))
    return 0


def cmd_unpair(_: argparse.Namespace) -> int:
    """`thimble-browser --unpair`: every browser signed out (`POST /api/ui/unpair` when the server answers, which forgets them at
    once), and <home>/paired.json removed, so a server that starts later knows none either; and the link's key changed
    (hook_auth.rotate_link_key), so no link printed before signs a browser in. A server that answers changes the key
    itself, and this CLI then leaves it, so the link thimble-browser prints for a page signed out at that moment is not
    changed a second time under it."""
    from . import hook_auth  # noqa: PLC0415

    url = api_url()
    why = ""
    rotated = False
    if healthy(url):
        status, body = _request("POST", f"{url}/api/ui/unpair", {})
        rotated = status in (200, 204)
        if not rotated:
            why = f"it answered {status or str(body)[:120]}"
            _log(f"unpair: {status} {str(body)[:200]}")
    try:
        (home() / PAIRED_FILE).unlink(missing_ok=True)
    except OSError as e:
        why = why or f"{home() / PAIRED_FILE} could not be removed: {e.strerror}"
    try:
        if not rotated:
            hook_auth.rotate_link_key()
    except OSError as e:
        why = why or f"{home() / hook_auth.LINK_KEY} could not be changed: {e.strerror}"
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


# ----------------------------------------------------------------------------- feedback, list and purge


def cmd_feedback(args: argparse.Namespace) -> int:
    """The problem report for the workspace of the folder this runs in (feedback.run)."""
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


BROWSER_LINE = "thimble browser: {what}"
NEW_LINK_LINE = "new sign-in link: {link}"  # new_links: its key changed, and a browser not signed in opened the page
LINK_RETRY_S = 2.0  # how long new_links waits before it asks again a server that did not answer


SESSION_NONE_LINE = {"continue": "no earlier session in {cwd} to continue.",
                     "pick": "no earlier session in {cwd} to resume."}
SESSION_UNKNOWN_LINE = "no session with chat {id} in {cwd} (thimble-browser --resume lists the sessions)."
PICK_HEAD = "Sessions in {cwd}, the latest first:"
PICK_ASK = "Number to resume (Enter to cancel): "
# pick_session's answer for a new session, which alone moves the open one aside (open_session): a session picked that
# holds no chat of main with a turn gets chat "new" too, and stays
NEW_SESSION = {"archive": None, "chat": "new", "new": True}
SET_ASIDE_FAILED_LINE = ("the last session was not moved aside ({why}), so the page opens it with a new chat; "
                         "see {log}")
BACK_FAILED_LINE = "the session was not brought back ({why}); see {log}"


def _ago(at: float, now: float | None = None) -> str:
    """How long ago, as Claude Code's picker says it: `just now`, `5 minutes ago`, `2 hours ago`, `3 days ago`."""
    s = max(0, int((now or time.time()) - at))
    for unit, n in (("day", 86400), ("hour", 3600), ("minute", 60)):
        if s >= n:
            k = s // n
            return f"{k} {unit}{'' if k == 1 else 's'} ago"
    return "just now"


def _counted(n: int, noun: str) -> str:
    return f"{n} {noun}{'' if n == 1 else 's'}"


def session_lines(rows: list[dict[str, Any]], width: int = 100, now: float | None = None) -> list[str]:
    """The picker's rows, numbered from 1: when, the number of turns and of cards, and the first message, cut to
    `width`."""
    out = []
    for i, r in enumerate(rows, 1):
        turns, cards = _counted(r["turns"], "turn"), _counted(r["cards"], "card")
        head = f"{i:>3}. {_ago(r['at'], now):<16} {turns:>9}  {cards:>9}  "
        first = r["first"] or "(no message)"
        room = max(10, width - len(head))
        out.append(head + (first if len(first) <= room else first[: room - 1] + "…"))
    return out


def _chosen(row: dict[str, Any], chat: str | None = None) -> dict[str, Any]:
    return {"archive": row["archive"], "chat": chat or row["chat"] or "new"}


def pick_session(cwd: Path, data_dir: Path, how: str) -> dict[str, Any] | None:
    """The session of the folder thimble-browser opens (folder_sessions.py): NEW_SESSION for `new`; else the latest
    (`continue`), one picked by number from a list printed here (`pick`), or the one that holds the chat of main with
    that id (or the start of one), as {archive: the name of its folder in the archive, None for the session open now;
    chat: the chat of main to open, "new" for a session with no chat of main that holds a turn}. None, with a line that
    says why, when there is no such session or the pick was cancelled."""
    from . import folder_sessions  # noqa: PLC0415

    if how == "new":
        return dict(NEW_SESSION)
    here = cwd.resolve()
    known = known_corpus(here, data_dir.resolve())
    mine = known is not None and (known[1] == here or known[1].parent == data_dir.resolve())
    rows = folder_sessions.listing(known[0]) if known is not None and mine else []
    if how in SESSION_NONE_LINE and not rows:
        print(BROWSER_LINE.format(what=SESSION_NONE_LINE[how].format(cwd=cwd)))
        return None
    if how == "continue":
        return _chosen(rows[0])
    if how != "pick":
        hit = ([(r, how) for r in rows if how in r["chats"]]
               or [(r, c) for r in rows for c in r["chats"] if c.startswith(how)])
        if len(hit) != 1:
            print(BROWSER_LINE.format(what=SESSION_UNKNOWN_LINE.format(id=how, cwd=cwd)))
            return None
        return _chosen(*hit[0])
    print(PICK_HEAD.format(cwd=cwd))
    for ln in session_lines(rows, shutil.get_terminal_size((100, 24)).columns - 1):
        print(ln)
    while True:
        try:
            got = input(PICK_ASK).strip()
        except (EOFError, KeyboardInterrupt):
            print("")
            return None
        if not got:
            return None
        if got.isdigit() and 1 <= int(got) <= len(rows):
            return _chosen(rows[int(got) - 1])
        print(f"  a number from 1 to {len(rows)}, or Enter to cancel")


def open_session(url: str, name: str, cwd: Path, chosen: dict[str, Any]) -> bool:
    """Put the session pick_session chose in place in workspace `name`, then open its chat of main (the register
    route's `chat`). A new session (NEW_SESSION) moves the open one aside when it holds anything (`POST
    /api/ws/{c}/archive`); an earlier one comes back from the archive (`POST /api/ws/{c}/restore`), the open one going
    there; the open one picked stays, with a new chat when it holds no chat of main with a turn. False, with a line that
    says why, when the session was not brought back; a session that was not moved aside stays open, with a new chat and
    a line that says so."""
    from . import folder_sessions  # noqa: PLC0415

    chat = str(chosen.get("chat") or "new")
    if chosen.get("archive"):
        status, body = restore_workspace(url, name, str(chosen["archive"]))
        if status != 200:
            print(BROWSER_LINE.format(what=BACK_FAILED_LINE.format(why=body.get("detail") or status or "no answer",
                                                                    log=log_path())))
            return False
    elif chosen.get("new"):
        ws = Path(resolve_env()["workspaces_dir"]) / name
        if ws.is_dir() and folder_sessions.holds(folder_sessions.summary(ws)):
            answered, moved = archive_workspace(url, name)
            if not moved:
                why = "the server found no workspace to move" if answered else "the server did not move it"
                print(BROWSER_LINE.format(what=SET_ASIDE_FAILED_LINE.format(why=why, log=log_path())))
    status, resp = _request("POST", f"{url}/api/corpora/register", {"path": str(cwd.resolve()), "exact": True,
                                                                     "chat": chat})
    if status not in (200, 201):
        why = resp.get("detail") if isinstance(resp, dict) else None
        print(BROWSER_LINE.format(what=f"the chat was not opened ({why or status}); see {log_path()}"))
    return True


def cmd_browser(args: argparse.Namespace) -> int:
    """`thimble-browser [FOLDER]` (browser/scripts/thimble-browser): start the server unless this install's own server
    answers (ensure_running, own_server), open the folder as a workspace, print the page's sign-in link to that server
    and how thimble reaches Claude (claude_access.py), then hold the terminal until Ctrl-C, which stops the server
    unless a thimble-browser in another terminal holds it too (hold_server). No Claude
    Code session starts here: the server runs main and every agent itself (runtime.py). `--session` says which session
    of the folder the page opens (pick_session, open_session): a new one, as each `claude` starts a new session, as
    empty as the folder's first; the latest (`--continue`); one picked from a list (`--resume`); or the one that holds a
    chat of main by id. While it holds the terminal, a browser that is not signed in and opens the page gets the new
    link there once `thimble-browser --unpair` changed its key (watch_links). With `--detach` it returns once the link is printed and
    the server keeps running."""
    from . import claude_access  # noqa: PLC0415

    cwd = Path(args.cwd or os.environ.get("THIMBLE_CALLER_CWD") or os.getcwd())
    if refused(cwd):
        print(BROWSER_LINE.format(what=f"{cwd} is not a folder to open as a workspace; start thimble-browser in the "
                                       "folder that holds your files."))
        return 1
    ensure_home()
    env = resolve_env()
    data_dir = Path(env["data_dir"])
    with server_dirs():
        chosen = pick_session(cwd, data_dir, getattr(args, "session", None) or "new")
    if chosen is None:
        return 1
    if refuse_foreign(api_url()):
        return 1
    if not getattr(args, "detach", False):
        hold_server()
    try:
        up: bool | None = ensure_running(start_wait_s())
    except TimeoutError as e:
        _log(str(e))
        up = None
    url = api_url()
    if not up and not own_server(url):
        why = start_failure(url)
        print(BROWSER_LINE.format(what=f"the server did not start: {why or 'see ' + str(log_path())}"))
        return 1
    name, opened = open_workspace(cwd.resolve(), data_dir, url, here=True)
    if not name:
        print(BROWSER_LINE.format(what=f"could not open {cwd} as a workspace; see {log_path()}"))
        return 1
    if not opened:  # a folder opened before: its session is put in place, and its chat of main opened, at once
        with server_dirs():
            if not open_session(url, name, cwd, chosen):
                return 1
    link = ui_url(name, pair=to_terminal())
    print(BROWSER_LINE.format(what=link), flush=True)
    print(BROWSER_LINE.format(what=claude_access.start_line()), flush=True)
    if not env["dev"] and not has_ui_build():
        print(NO_UI_LINE, flush=True)
    if getattr(args, "detach", False):
        return 0
    stop = watch_links(name, link)
    try:
        hold_until_quit()
    finally:
        stop.set()
    return 0


def watch_links(name: str, printed: str) -> threading.Event:
    """new_links for workspace `name` after the link `printed`, in a thread of its own, when stdout is the terminal
    (to_terminal), which alone gets the key, as with the start's link. The event that ends it."""
    stop = threading.Event()
    if to_terminal():
        threading.Thread(target=new_links, args=(name, stop, printed), name="thimble-new-links", daemon=True).start()
    return stop


def new_links(name: str, stop: threading.Event, printed: str) -> None:
    """Until `stop` is set: each time a browser that is not signed in opens the page (hook_auth.want_link, at most once
    a minute), the sign-in link for workspace `name` (ui_url), printed as at the start (NEW_LINK_LINE) when it differs
    from the one printed last (`printed` at first): its key changed (`thimble-browser --unpair`). It waits for one at GET
    /api/ui/link-wanted, which answers once the count or the server's start differs from the last answer; a server that
    started again counts from 0. A server that does not answer is asked again LINK_RETRY_S later, and a link the server
    gives no key for is not printed (pair_code logs why)."""
    from . import hook_auth  # noqa: PLC0415

    seen: dict[str, Any] = {}
    while not stop.is_set():
        api = str(read_state().get("api") or api_url())
        status, got = _request("GET", f"{api}/api/ui/link-wanted?{urllib.parse.urlencode(seen)}",
                               timeout=hook_auth.LINK_WAIT_S + 10)
        wanted = got.get("wanted") if status == 200 and isinstance(got, dict) else None
        if not isinstance(wanted, int) or isinstance(wanted, bool):
            stop.wait(LINK_RETRY_S)
            continue
        boot = str(got.get("boot") or "")
        before = seen["wanted"] if seen and seen["boot"] == boot else 0
        if seen and wanted > before and not stop.is_set():
            link = ui_url(name, pair=True)
            if "#p=" in link and link != printed:
                _say(BROWSER_LINE.format(what=NEW_LINK_LINE.format(link=link)))
                printed = link
        seen = {"boot": boot, "wanted": wanted}


class Quit(Exception):
    """The terminal that holds thimble-browser closed (SIGHUP), or the launcher was told to end (SIGTERM)."""


def _quit(signum: int, _frame: Any) -> None:
    raise Quit(signum)


STOPPING_LINE = BROWSER_LINE.format(what="stopping the server and its agents...")
KEPT_LINE = BROWSER_LINE.format(what="another thimble-browser still uses the server, so it keeps running; Ctrl-C in "
                                     "the last one stops it.")
INTERRUPTED_LINE = "thimble {cmd}: interrupted"


def _say(*lines: str) -> None:
    """Print `lines`, dropping those a closed terminal can no longer take."""
    for ln in lines:
        try:
            print(ln, flush=True)
        except OSError:  # the terminal is gone
            pass


def hold_until_quit(sleep: Callable[[float], None] = time.sleep) -> None:
    """Hold the terminal until Ctrl-C, or until the terminal closes or the launcher is told to end, then say at once
    that the server stops and stop it (stop), which stops every agent it runs first (runtime.stop_all) and takes some
    seconds. While a thimble-browser in another terminal holds the server too (last_holder), the server keeps running
    and a line says so. A second signal does not cut that stop short, and lines a closed terminal can no longer take are
    dropped. `sleep` is a seam for tests."""
    sigs = (signal.SIGINT, signal.SIGHUP, signal.SIGTERM)
    before = {sig: signal.getsignal(sig) for sig in sigs}
    for sig in (signal.SIGHUP, signal.SIGTERM):
        signal.signal(sig, _quit)
    try:
        while True:
            sleep(3600)
    except (KeyboardInterrupt, Quit):
        for sig in sigs:
            signal.signal(sig, signal.SIG_IGN)
        if last_holder():
            _say("", STOPPING_LINE)
            _say(*stop())
        else:
            _say("", KEPT_LINE)
    finally:
        for sig, handler in before.items():
            signal.signal(sig, handler)


def interrupted(args: argparse.Namespace) -> int:
    """Ctrl-C before a command was done (for thimble-browser, before it held the terminal: hold_until_quit): one line in
    place of Python's traceback, and 130, as a shell gives a command that Ctrl-C ended. A server thimble-browser started
    on this run is stopped, since no terminal holds it any more, unless a thimble-browser in another terminal holds it
    already (last_holder); one that ran before it is left running."""
    _say("", INTERRUPTED_LINE.format(cmd=args.cmd))
    started = LAST_START.get("pid")
    if args.cmd == "browser" and not getattr(args, "detach", False) and started and pid_alive(started):
        before = signal.signal(signal.SIGINT, signal.SIG_IGN)  # a second Ctrl-C does not cut the stop short
        try:
            if last_holder():
                _say(STOPPING_LINE)
                _say(*stop())
            else:
                _say(KEPT_LINE)
        finally:
            signal.signal(signal.SIGINT, before)
    return 130


def add_yes_flag(p: argparse.ArgumentParser, command: str) -> None:
    p.add_argument("-y", "--yes", action="store_true",
                   help=f"{command} without asking, even while writers or view builds run")


def add_restart_flags(p: argparse.ArgumentParser) -> None:
    p.add_argument("--keep-vite", action="store_true", help="restart the backend only; a running Vite stays")
    add_yes_flag(p, "restart")
    p.set_defaults(fn=cmd_restart)


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(prog="thimble", description=__doc__.split("\n\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("browser", help="thimble-browser: start the server, open this folder, print the sign-in link")
    b.add_argument("--cwd")
    b.add_argument("--detach", action="store_true")
    b.add_argument("--session", default="new",
                   help="new | continue | pick | a chat's id: the session of the folder to open (pick_session)")
    b.set_defaults(fn=cmd_browser)
    r = sub.add_parser("restart", help="stop, then start; asks first while work runs")
    add_restart_flags(r)
    sp = sub.add_parser("stop", help="stop the server (by pid); asks first while work runs")
    add_yes_flag(sp, "stop")
    sp.set_defaults(fn=cmd_stop)
    dr = sub.add_parser("doctor", help="a checklist of what works, with the fix for each problem; works with the "
                                       "server down")
    dr.add_argument("--verbose", action="store_true", help="the full detail: paths, pids, ports, every switch, the log")
    dr.set_defaults(fn=cmd_doctor)
    for name, fn, help_ in (("unpair", cmd_unpair, "sign out every browser and change the sign-in link"),
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
    return ap


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return int(args.fn(args) or 0)
    except KeyboardInterrupt:
        return interrupted(args)
    except Exception as e:  # noqa: BLE001
        _log(f"{args.cmd} failed: {type(e).__name__}: {e}\n{traceback.format_exc()}")
        print(f"thimble {args.cmd}: {failure_text(e) or f'{type(e).__name__}: {e}'}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
