"""Opening thimble's page in the analyst's browser with a one-time sign-in code that no other account can read
(`thimble open`, app/open_cmd.py; `thimble demo`, app/demo.py).

A sign-in code exists in two places only. On this computer it is in a redirect file, <home>/open/<id>.html (the file
0600, its folder and <home> 0700, write_redirect), which holds a meta refresh and a location.replace to
`http://127.0.0.1:<port>/?ws=<c>&ref=<ref>#p=<code>`; the opener is given the file's path, never the URL, so the code
is in no process's argv (/proc/<pid>/cmdline is readable by every account). For a remote terminal it is in the
one-time link <home>/links/<sid>.json (0600, write_link), which only thimble's terminal panel reads, to copy. The code
is never printed, logged or given to a model. The server deletes the redirect file when the page claims the code and
writes <home>/open/<id>.claimed beside it (claimed), which the terminal watches; sweep deletes what is left after
SWEEP_S. Three cases put the URL in argv, each logged without the code: a default browser that is a snap or a flatpak
(it cannot read a hidden folder such as ~/.thimble), and VS Code's remote browser helper ($BROWSER with
VSCODE_IPC_HOOK_CLI), which forwards the port itself.

The opener runs detached (stdio on /dev/null, its own session, no inherited descriptors), so a browser that keeps
running never holds the caller's pipes: `$BROWSER` (entries split on os.pathsep, `%s` replaced, as Python's webbrowser
reads it), else `open` (macOS), `xdg-open`, `gio open`, `wslview`.

Remote terminals (remote) run no opener: SSH (SSH_CONNECTION or SSH_TTY, also with a DISPLAY, read inside tmux from
`tmux show-environment` at the time of the press, since tmux keeps the values of the first attach), Eternal Terminal
(ET_VERSION, or an `etterminal` ancestor), a Linux session with no display and no $BROWSER, and THIMBLE_NO_BROWSER=1.
The tunnel command names the literal `<your ssh host>` unless THIMBLE_SSH_HOST names the host: the address in
SSH_CONNECTION is often an internal one (IAP, a host alias). The server binds 127.0.0.1 only, so the tunnel is
`ssh -N -L P:127.0.0.1:P <host>` (or `et -t P:P <host>`).
"""
from __future__ import annotations

import contextlib
import hashlib
import html
import json
import logging
import os
import re
import secrets
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Mapping, NamedTuple
from urllib.parse import quote

log = logging.getLogger("thimble.opener")

OPEN_DIR = "open"  # under <home>: the redirect files and their claim marks
LINKS_DIR = "links"  # under <home>: <sid>.json, the one-time link a remote terminal copies
CLAIMED = ".claimed"  # <home>/open/<id>.claimed: the page claimed the code of <id>.html
SWEEP_S = 120.0  # a redirect file, claim mark or press record older than this is deleted (sweep)
REF_MAX = 512  # characters: a longer ref is refused (check_ref)
ID_RE = re.compile(r"[A-Za-z0-9_-]{8,64}")  # an open id as new_id makes it
# what a ref and a workspace name keep unencoded in the page's URL; every other character is percent-encoded, so no
# quote, angle bracket, `#` or `&` from a ref reaches the HTML or splits the URL
URL_SAFE = "-._~:/"
SSH_PLACEHOLDER = "<your ssh host>"
HOST_RE = re.compile(r"[A-Za-z0-9._@:\[\]-]{1,255}")  # a THIMBLE_SSH_HOST thimble puts into the tunnel command
OPENER_TIMEOUT_S = 2.0  # `tmux show-environment` and `xdg-settings` each get this long
SNAP_DESKTOP = Path("/var/lib/snapd/desktop/applications")
FLATPAK_DESKTOPS = (Path("/var/lib/flatpak/exports/share/applications"),
                    Path("~/.local/share/flatpak/exports/share/applications"))
TMUX_VARS = ("SSH_CONNECTION", "SSH_TTY", "DISPLAY")


def home() -> Path:
    """thimble's home: THIMBLE_HOME, else ~/.thimble, read fresh."""
    return Path(os.environ.get("THIMBLE_HOME") or "~/.thimble").expanduser()


def private_dir(p: Path) -> Path:
    """`p` made if missing, with <home> and `p` readable by their owner alone (0700)."""
    h = home()
    for d in (h, p):
        d.mkdir(mode=0o700, parents=True, exist_ok=True)
        with contextlib.suppress(OSError):
            if d.stat().st_mode & 0o077:
                os.chmod(d, 0o700)
    return p


def open_dir() -> Path:
    return home() / OPEN_DIR


def new_id() -> str:
    """A fresh open id: names the redirect file and its claim mark, and goes to the server with the code (the pair
    route's `open`), so the claim knows which file to delete."""
    return secrets.token_urlsafe(12)


def valid_id(open_id: object) -> bool:
    return isinstance(open_id, str) and ID_RE.fullmatch(open_id) is not None


def claim_path(open_id: str) -> Path:
    """<home>/open/<id>.claimed, which the server writes when the page claims the code (claimed)."""
    return open_dir() / f"{open_id}{CLAIMED}"


def check_ref(ref: str) -> str | None:
    """Why the ref `ref` is refused, None when it is not: longer than REF_MAX characters, or holding a control
    character (C0, DEL, C1, or a line or paragraph separator)."""
    if len(ref) > REF_MAX:
        return f"the ref is longer than {REF_MAX} characters"
    if any(ord(ch) < 0x20 or 0x7F <= ord(ch) <= 0x9F or ch in "  " for ch in ref):
        return "the ref holds a control character"
    return None


def page_url(base: str, ws: str | None, ref: str | None) -> str:
    """The page's URL on the server at `base` (`http://127.0.0.1:<port>`), on workspace `ws` at `ref`, each
    percent-encoded but for URL_SAFE; no code."""
    params = [f"ws={quote(ws, safe=URL_SAFE)}"] if ws else []
    if ref and ref != "home":
        params.append(f"ref={quote(ref, safe=URL_SAFE)}")
    return base.rstrip("/") + "/" + (f"?{'&'.join(params)}" if params else "")


def with_code(url: str, code: str) -> str:
    """`url` with the sign-in code after `#p=` (the page claims it and takes it out of its address)."""
    return f"{url}#p={quote(code, safe='-_')}" if code else url


def redirect_html(url: str) -> str:
    """The redirect file's page: one meta refresh to `url` and a location.replace, the URL HTML-escaped in the
    attribute and JSON-encoded (with `<` escaped) in the script. No referrer leaves it."""
    attr = html.escape(url, quote=True)
    script = json.dumps(url).replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")
    return ("<!doctype html>\n<html><head><meta charset=\"utf-8\"><meta name=\"referrer\" content=\"no-referrer\">\n"
            f"<meta http-equiv=\"refresh\" content=\"0;url={attr}\">\n<title>thimble</title></head>\n"
            f"<body><script>location.replace({script})</script>\n"
            "<p>Opening thimble's page.</p></body></html>\n")


def write_private(path: Path, text: str) -> Path:
    """`text` at `path`, written whole through a temporary file made 0600 (mkstemp), in a 0700 folder."""
    private_dir(path.parent)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".tmp-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    finally:
        with contextlib.suppress(OSError):
            os.unlink(tmp)
    return path


def write_redirect(url: str, open_id: str | None = None) -> Path:
    """<home>/open/<id>.html, the redirect page to `url` (which carries the code), 0600 in a 0700 folder."""
    oid = open_id if valid_id(open_id) else new_id()
    return write_private(open_dir() / f"{oid}.html", redirect_html(url))


def claimed(open_id: object) -> bool:
    """The page claimed the code of the open `open_id`: its redirect file goes, and <id>.claimed is written (0600).
    Whether the id was one new_id makes. Never raises."""
    if not valid_id(open_id):
        return False
    try:
        (open_dir() / f"{open_id}.html").unlink(missing_ok=True)
        write_private(claim_path(str(open_id)), json.dumps({"at": time.time()}))
    except OSError as e:
        log.warning("the claim mark of an open was not written: %s", e)
    return True


def sweep(max_age: float = SWEEP_S, now: float | None = None) -> int:
    """Delete what an open left in <home>/open (redirect files, claim marks, press records) older than `max_age`
    seconds; how many went. At each open and at the server's start. Never raises."""
    d = open_dir()
    now = time.time() if now is None else now
    gone = 0
    try:
        entries = list(d.iterdir())
    except OSError:
        return 0
    for p in entries:
        if p.suffix not in (".html", CLAIMED, ".last") and not p.name.startswith(".tmp-"):
            continue
        with contextlib.suppress(OSError):
            if now - p.stat().st_mtime > max_age:
                p.unlink()
                gone += 1
    return gone


class Remote(NamedTuple):
    """Where the terminal runs, as the press sees it (remote)."""
    remote: bool  # no opener runs: the page needs a tunnel or a copied link
    ssh: bool  # an SSH session (the tunnel row)
    et: bool  # an Eternal Terminal session (the et row)
    vscode: bool  # VS Code's remote helper is $BROWSER: it opens the URL on the analyst's computer
    rows: bool  # whether the tunnel rows are shown (not with THIMBLE_NO_BROWSER=1)
    why: str  # one line for the log and the doctor


def tmux_env(env: Mapping[str, str]) -> dict[str, str | None]:
    """Inside tmux ($TMUX), what `tmux show-environment` says now of SSH_CONNECTION, SSH_TTY and DISPLAY: a value, or
    None for a variable tmux removed (`-NAME`). SSH_TTY, which tmux does not update by default, counts as removed when
    tmux does not list it. {} outside tmux or when tmux does not answer."""
    if not env.get("TMUX") or not shutil.which("tmux", path=env.get("PATH")):
        return {}
    try:
        out = subprocess.run(["tmux", "show-environment"], capture_output=True, text=True, timeout=OPENER_TIMEOUT_S,
                             env=dict(env), stdin=subprocess.DEVNULL).stdout
    except (OSError, subprocess.SubprocessError):
        return {}
    got: dict[str, str | None] = {"SSH_TTY": None}
    for line in out.splitlines():
        if line.startswith("-") and line[1:] in TMUX_VARS:
            got[line[1:]] = None
        else:
            name, eq, value = line.partition("=")
            if eq and name in TMUX_VARS:
                got[name] = value
    return got


def _ancestors(pid: int, limit: int = 64) -> list[str]:
    """The command names (/proc/<pid>/comm) of `pid`'s ancestors, nearest first; [] where /proc is not there."""
    names: list[str] = []
    for _ in range(limit):
        try:
            stat = Path(f"/proc/{pid}/stat").read_text()
            pid = int(stat.rsplit(")", 1)[1].split()[1])
            if pid <= 1:
                break
            names.append(Path(f"/proc/{pid}/comm").read_text().strip())
        except (OSError, ValueError, IndexError):
            break
    return names


def et_session(env: Mapping[str, str]) -> bool:
    """Whether this runs in an Eternal Terminal session: ET_VERSION, or an `etterminal` process above this one."""
    return bool(env.get("ET_VERSION")) or "etterminal" in _ancestors(os.getpid())


def remote(env: Mapping[str, str] | None = None, platform: str | None = None) -> Remote:
    """Where the terminal runs (module note), with SSH_CONNECTION, SSH_TTY and DISPLAY read from tmux at this time."""
    env = dict(os.environ if env is None else env)
    for name, value in tmux_env(env).items():
        if value is None:
            env.pop(name, None)
        else:
            env[name] = value
    platform = platform or sys.platform
    if env.get("THIMBLE_NO_BROWSER", "").strip() == "1":
        return Remote(True, False, False, False, False, "THIMBLE_NO_BROWSER=1")
    if env.get("VSCODE_IPC_HOOK_CLI") and env.get("BROWSER"):
        return Remote(False, False, False, True, False, "VS Code remote: its browser helper opens the page")
    ssh = bool(env.get("SSH_CONNECTION") or env.get("SSH_TTY"))
    et = et_session(env)
    if ssh or et:
        return Remote(True, ssh, et, False, True, "an Eternal Terminal session" if et and not ssh else "an SSH session")
    if (platform.startswith("linux") and not env.get("DISPLAY") and not env.get("WAYLAND_DISPLAY")
            and not env.get("BROWSER")):
        return Remote(True, False, False, False, True, "no display and no $BROWSER")
    return Remote(False, False, False, False, False, "a desktop session")


def ssh_host(env: Mapping[str, str] | None = None) -> str:
    """THIMBLE_SSH_HOST when it is a host name thimble puts into a command as it is, else SSH_PLACEHOLDER."""
    got = (os.environ if env is None else env).get("THIMBLE_SSH_HOST", "").strip()
    return got if HOST_RE.fullmatch(got) else SSH_PLACEHOLDER


def tunnels(port: int, where: Remote, env: Mapping[str, str] | None = None) -> tuple[str | None, str | None]:
    """(the ssh tunnel command, the et command or None) for a remote terminal's row; (None, None) without rows."""
    if not where.remote or not where.rows:
        return None, None
    host = ssh_host(env)
    p = int(port)
    return f"ssh -N -L {p}:127.0.0.1:{p} {host}", (f"et -t {p}:{p} {host}" if where.et else None)


def safe_name(sid: str) -> str:
    return "".join(ch for ch in sid if ch.isalnum() or ch in "-_")[:128]


def link_path(sid: str) -> Path | None:
    """<home>/links/<sid>.json, None for a session id with no letter or digit."""
    name = safe_name(sid)
    return home() / LINKS_DIR / f"{name}.json" if name else None


def write_link(sid: str, url: str, *, tunnel: str | None, et: str | None, ttl: float, port: int) -> Path | None:
    """The one-time link `url` (with its code) for session `sid`'s terminal to copy, with the tunnel rows and when it
    expires: <home>/links/<sid>.json, 0600 in a 0700 folder. None when the session id names no file."""
    path = link_path(sid)
    if path is None:
        return None
    body = {"url": url, "url_with_code": url, "tunnel": tunnel, "et": et, "port": int(port),
            "expires": time.time() + float(ttl)}
    return write_private(path, json.dumps(body))


class Opener(NamedTuple):
    argv: list[str]  # the command, with `%s` where the target goes (appended when absent)
    direct: bool  # it gets the URL itself, not the redirect file's path (module note: snap, flatpak, VS Code)
    name: str  # for the log and the doctor
    why: str  # why it gets the URL, '' when it gets the file


def _default_browser(env: Mapping[str, str]) -> str:
    """The desktop file of the default browser `xdg-settings` names, '' when it names none."""
    if not shutil.which("xdg-settings", path=env.get("PATH")):
        return ""
    try:
        return subprocess.run(["xdg-settings", "get", "default-web-browser"], capture_output=True, text=True,
                              timeout=OPENER_TIMEOUT_S, env=dict(env), stdin=subprocess.DEVNULL).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return ""


def sandboxed_browser(env: Mapping[str, str], desktop: str | None = None) -> str:
    """'snap' or 'flatpak' when the default browser is one (it cannot read a hidden folder), else ''."""
    desktop = _default_browser(env) if desktop is None else desktop
    if not desktop or "/" in desktop:
        return ""
    if (SNAP_DESKTOP / desktop).exists() or re.fullmatch(r"[a-z0-9-]+_[A-Za-z0-9-]+\.desktop", desktop):
        return "snap"
    if any((d.expanduser() / desktop).exists() for d in FLATPAK_DESKTOPS):
        return "flatpak"
    return ""


def choose(env: Mapping[str, str] | None = None, platform: str | None = None) -> Opener | None:
    """The opener for this terminal (module note), None when there is none."""
    env = dict(os.environ if env is None else env)
    platform = platform or sys.platform
    path = env.get("PATH")
    browser = env.get("BROWSER", "").strip()
    if browser:
        for entry in browser.split(os.pathsep):
            try:
                argv = shlex.split(entry)
            except ValueError:
                continue
            if argv and shutil.which(argv[0], path=path):
                if env.get("VSCODE_IPC_HOOK_CLI"):
                    return Opener(argv, True, Path(argv[0]).name, "VS Code's remote browser helper")
                return Opener(argv, False, Path(argv[0]).name, "")
    if platform == "darwin" and shutil.which("open", path=path):
        return Opener(["open"], False, "open", "")
    for argv in (["xdg-open"], ["gio", "open"], ["wslview"]):
        if shutil.which(argv[0], path=path):
            kind = sandboxed_browser(env) if argv[0] in ("xdg-open", "gio") else ""
            return Opener(argv, bool(kind), " ".join(argv), f"the default browser is a {kind}" if kind else "")
    return None


def launch(argv: list[str], env: Mapping[str, str] | None = None) -> bool:
    """Start `argv` detached (module note) and return at once; whether it started."""
    try:
        subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         start_new_session=True, close_fds=True, env=dict(env) if env is not None else None)
    except OSError as e:
        log.warning("the browser opener %s did not start: %s", argv[0] if argv else "?", e)
        return False
    return True


def command(op: Opener, target: str) -> list[str]:
    """The opener's argv for `target`: `%s` replaced, or the target appended."""
    if any("%s" in a for a in op.argv):
        return [a.replace("%s", target) for a in op.argv]
    return [*op.argv, target]


class Opened(NamedTuple):
    opened: bool  # an opener started
    how: str  # the opener's name, '' when none ran
    file: Path | None  # the redirect file, None when the opener got the URL
    direct: bool  # the opener got the URL (logged)


def open_url(url: str, *, open_id: str | None = None, env: Mapping[str, str] | None = None) -> Opened:
    """Open `url` (which may carry the sign-in code after `#p=`) in the browser through a redirect file (module note):
    the opener gets the file's path, or the URL itself for a snap or flatpak browser and VS Code's helper, which is
    logged without the code. Sweeps old files first. Opened(False, …) when there is no opener."""
    env = dict(os.environ if env is None else env)
    sweep()
    op = choose(env)
    if op is None:
        return Opened(False, "", None, False)
    if op.direct:
        log.info("thimble's page opens with its URL in the argv of %s (%s); its code works once, for at most 300 s",
                 op.name, op.why)
        return Opened(launch(command(op, url), env), op.name, None, True)
    path = write_redirect(url, open_id)
    ok = launch(command(op, str(path)), env)
    if not ok:
        with contextlib.suppress(OSError):
            path.unlink()
    return Opened(ok, op.name, path if ok else None, False)


def doctor_lines(env: Mapping[str, str] | None = None) -> list[str]:
    """What `thimble doctor` says about opening the page: the opener `thimble open` would run, or why it shows a
    tunnel command or a link instead. Plain lines, no code."""
    env = dict(os.environ if env is None else env)
    where = remote(env)
    if where.remote:
        how = ("a tunnel command and a one-time link (5 minutes)" if where.rows else "a one-time link (5 minutes)")
        return [f"browser: this terminal is remote ({where.why}), so `thimble open` shows {how}"]
    op = choose(env)
    if op is None:
        return ["browser: no opener found ($BROWSER, open, xdg-open, gio, wslview), so `thimble open` shows a one-time "
                "link to copy"]
    if op.direct:
        return [f"browser: `thimble open` runs {op.name}, which gets the page's URL itself ({op.why})"]
    return [f"browser: `thimble open` runs {op.name} on a redirect file that only you can read"]


def press_record(sid: str, ref: str) -> Path:
    """<home>/open/<hash>.last: the last press's status for session `sid` at `ref` (open_cmd's debounce)."""
    digest = hashlib.sha256(f"{sid}\0{ref}".encode("utf-8", "surrogateescape")).hexdigest()[:20]
    return open_dir() / f"{digest}.last"
