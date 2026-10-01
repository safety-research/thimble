"""The problem report: one zip a tester attaches to a GitHub issue, or sends the maintainer privately.

`build` writes <Downloads>/thimble-feedback-<YYYYMMDD-HHMMSS>.zip (else <home>, else the temp folder) holding
contents.txt, description.txt, an optional screenshot, versions.txt, doctor.txt, import-error.txt when the supervisor
could not be imported, and, unless the tester leaves the logs out: server and install log tails, the browser's recent
errors, and the workspace's permissions, orientation record, checks, views, dev tickets, events, background sessions'
transcripts and chats.

Only thimble's own files and the workspace's state are read, and transcripts only under a Claude Code projects folder;
symlinks, files resolving outside their folder, and the corpus's files are never read. The content stays under MAX_BYTES
(text only, each part a tail within its cap), with the chats a failure or the description names taken first. Every text
part is scanned for secrets (redact), replaced by `[redacted:<kind>]`.

The module imports only the standard library, so `python -m app.feedback` runs with the server down; cli.py and
config.py are imported lazily with file-reading fallbacks, and each part is gathered on its own so a failing part
becomes a line in contents.txt. The dialog (POST /api/ws/{c}/feedback), `thimble feedback` and `/thimble feedback` build
the same zip and offer a prefilled public issue (issue_url) that never carries the logs.
"""
from __future__ import annotations

import argparse
import base64
import binascii
import importlib
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import traceback
import urllib.request
import zipfile
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Iterable
from urllib.parse import quote, urlencode

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
CONTACT = "@mjoerke"
CONTACT_URL = "https://github.com/mjoerke"
SHOT_MISSING = (f"{'screenshot':<32}asked for but not captured: the browser could not capture the tab, or the "
                "capture was declined")
DEFAULT_PORT = 8300  # cli.DEFAULT_PORT, for when cli.py cannot be imported

MAX_BYTES = 10_000_000  # the zip's content, uncompressed, so the file itself is smaller still
SHOT_MAX = 5_000_000
LOG_MAX = 1_000_000
ROTATED_LOG_MAX = 300_000  # of server.log.1, the log before a start rotated it
LOG_SCAN_MAX = 40_000_000  # how far back from its end a server log is read for its tail and its earlier errors
EARLY_ERRORS_MAX = 200_000  # of a server log's warnings and errors from before its tail
INSTALL_LOG_MAX = 200_000
BROWSER_MAX = 300_000
BROWSER_ENTRIES = 300
PERMISSIONS_MAX = 300_000
STATE_MAX = 300_000  # each of the orientation, card checks, report checks, view proposals, dev tickets and sessions
VIEWS_MAX = 1_000_000  # the view proposals and the views' own code
VIEW_FILE_MAX = 200_000
VIEW_SUFFIXES = (".py", ".json", ".js", ".mjs", ".ts", ".tsx", ".html", ".css", ".md", ".txt")
EVENTS_MAX = 1_000_000
TRANSCRIPT_MAX = 600_000  # one session's own transcript
SUBAGENT_MAX = 200_000  # one subagent's or workflow agent's transcript
TRANSCRIPTS_MAX = 3_000_000
INDEX_ROOM = 60_000  # kept back from the transcripts for sessions.jsonl
MAX_SESSIONS = 30
CHAT_MAX = 1_000_000
CHATS_MAX = 3_000_000
MAX_CHATS = 40
MAX_TICKETS = 20
FIELD_MAX = 4000  # a string in a state record
DESCRIPTION_MAX = 20_000
CONTENTS_ROOM = 4000  # kept back for contents.txt
BLOB_CHARS = 2000
DOCTOR_TIMEOUT_S = 30.0
HEALTH_TIMEOUT_S = 2.0
CLAUDE_TIMEOUT_S = 10.0
ISSUE_TEXT_MAX = 1500  # of the description in the new-issue link, so the URL stays well under what GitHub accepts
ISSUE_VERSIONS = ("thimble", "Claude Code", "OS")  # the versions.txt lines a new issue carries, each without its path

NAME_RE = re.compile(r"^thimble-feedback-\d{8}-\d{6}(-\d+)?\.zip$")
# uvicorn's access line of a successful GET/HEAD or telemetry POST: the browser's polling, most of a long server log
POLL_LINE_RE = re.compile(r'^(?:\S+ \S+ )?INFO:\s+\S+ - "(?:(?:GET|HEAD) [^"]*|POST [^"?]*/telemetry(?:\?[^"]*)? '
                          r'[^"]*)" [23]\d\d\b')
STAMP_RE = re.compile(r"^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d")  # a log line's own start; any other line continues one
# a warning or an error of thimble's loggers or of uvicorn's, or a traceback, whose unstamped lines go with it
ALERT_RE = re.compile(r"^\S+ \S+ (?:WARNING|ERROR|CRITICAL) |^(?:\S+ \S+ )?(?:ERROR|WARNING|CRITICAL):|"
                      r"^Traceback \(most recent call last\):")
BLOB_RE = re.compile(r"[A-Za-z0-9+/]{%d,}={0,2}" % BLOB_CHARS)
SID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
DOCTOR_LOG_MARK = "  log tail ("  # where cli.doctor_text's tail of the server log starts
# the chats of the sessions thimble starts beside main: a step with a session and no agent id is a session started as a
# step of another; a step with an agent id is a subagent, whose transcript lies under its parent's
BACKGROUND_ROLES = ("orient", "writer", "check", "step", "dev")
NAME_MIN = 4  # the shortest chat title or slug, in letters and digits, a description is taken to name

# (kind, pattern, bounded): the whole match is replaced, or only the group `v` when present. A bounded pattern counts
# only where the preceding character is no letter or digit, or is the n, r or t of an escaped `\n` in JSON. The boundary
# is checked in redact so each pattern starts with its literal prefix, which the regex engine finds fast.
SECRET_PATTERNS: list[tuple[str, re.Pattern[str], bool]] = [
    ("private-key", re.compile(r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----.*?-----END [A-Z0-9 ]*PRIVATE KEY-----", re.S),
     False),
    ("anthropic-key", re.compile(r"sk-ant-[A-Za-z0-9_\-]{20,}"), True),
    ("openai-key", re.compile(r"sk-(?:proj-|svcacct-)?[A-Za-z0-9_\-]{32,}"), True),
    ("github-token", re.compile(r"(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})"), True),
    ("aws-key", re.compile(r"(?:AKIA|ASIA)[0-9A-Z]{16}(?![0-9A-Za-z])"), True),
    ("slack-token", re.compile(r"xox[abprs]-[A-Za-z0-9\-]{10,}"), True),
    ("google-key", re.compile(r"AIza[0-9A-Za-z_\-]{35}"), True),
    ("jwt", re.compile(r"eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}"), True),
    ("bearer-token", re.compile(r"(?i)bearer\s+(?P<v>[A-Za-z0-9._~+/\-]{20,}=*)"), True),
    ("url-password", re.compile(r"://[^/\s:@\"']+:(?P<v>[^/\s@\"']+)@"), False),
    # a value assigned to a name that says it is secret, in code, an env line or JSON (its quotes escaped once or more)
    ("secret", re.compile(
        r"(?i)(?:api[_\-]?key|apikey|secret|password|passwd|access[_\-]?key|private[_\-]?key|credential|"
        r"(?:access|refresh|auth|api|bot|session|id)[_\-]?token)[A-Za-z0-9_\-]*\\*[\"']?\s*[:=]\s*\\*[\"']?"
        r"(?P<v>[A-Za-z0-9][^\s\"'`,;\\]{15,})"), False),
]


def issues_url(repo: str | None = None) -> str:
    return f"https://github.com/{repo or release_repo()}/issues/new"


def instructions() -> str:
    """The one sentence the dialog and the CLI both print under the bundle's path."""
    return (f"Attach the zip to a GitHub issue only if you are happy to share it publicly; otherwise reach {CONTACT} on "
            "GitHub for private logs.")


# ----------------------------------------------------------------------------- the supervisor, imported lazily

_import_errors: dict[str, str] = {}


def _lazy(name: str) -> Any:
    """app.<name>, or None when it cannot be imported, with the traceback kept for import-error.txt."""
    if name in _import_errors:
        return None
    try:
        if not __package__:
            raise ImportError("feedback.py runs outside the app package")
        return importlib.import_module(f"{__package__}.{name}")
    except Exception:  # noqa: BLE001 — a module that fails to import is what the report is for
        _import_errors[name] = traceback.format_exc()
        return None


def home() -> Path:
    """`~/.thimble`, or THIMBLE_HOME, as cli.home reads it."""
    return Path(os.environ.get("THIMBLE_HOME") or "~/.thimble").expanduser()


def _read_json(p: Path) -> Any:
    try:
        return json.loads(p.read_text("utf-8"))
    except (OSError, ValueError):
        return None


def server_state() -> dict[str, Any]:
    st = _read_json(home() / "server.json")
    return st if isinstance(st, dict) else {}


def env_dirs() -> tuple[Path, Path]:
    """(data_dir, workspaces_dir) as cli.resolve_env resolves them: the THIMBLE_* variables, then the last server.json,
    then the defaults."""
    st = server_state().get("env")
    st = st if isinstance(st, dict) else {}
    data = os.environ.get("THIMBLE_DATA_DIR") or st.get("data_dir") or str(home() / "data")
    wsd = os.environ.get("THIMBLE_WORKSPACES_DIR") or st.get("workspaces_dir") or str(REPO_ROOT / "workspaces")
    return Path(data).expanduser(), Path(wsd).expanduser()


def workspace_for(cwd: Path) -> tuple[str, Path] | None:
    """(name, folder) of the workspace for the corpus `cwd` is in: cli.known_corpus when cli.py imports, else the same
    rule read from the files."""
    data_dir, ws_dir = env_dirs()
    data_dir = data_dir.resolve()
    cwd = cwd.expanduser().resolve()
    cli = _lazy("cli")
    if cli is not None:
        try:
            found = cli.known_corpus(cwd, data_dir)
            return (found[0], ws_dir / found[0]) if found else None
        except Exception:  # noqa: BLE001 — the files answer instead
            pass
    for p in (cwd, *cwd.parents):
        if p.parent == data_dir and (p / "manifest.json").is_file():
            return p.name, ws_dir / p.name
    best: tuple[int, str] | None = None
    for sc in sorted(data_dir.glob("*.corpus.json")) if data_dir.is_dir() else []:
        rec = _read_json(sc)
        if not isinstance(rec, dict) or not isinstance(rec.get("path"), str) or not rec["path"]:
            continue
        root = Path(rec["path"]).expanduser().resolve()
        if (cwd == root or root in cwd.parents) and (best is None or len(root.parts) > best[0]):
            best = (len(root.parts), str(rec.get("name") or sc.name[: -len(".corpus.json")]))
    return (best[1], ws_dir / best[1]) if best else None


def repo_slug(root: Path) -> str:
    """The `owner/name` of the GitHub repo releases and issues live on: RELEASE.json's `repo` in a release install, else
    the `repository` URL of plugin/.claude-plugin/plugin.json."""
    rel = _read_json(root / "RELEASE.json")
    slug = str(rel.get("repo") or "").strip() if isinstance(rel, dict) else ""
    if slug:
        return slug
    plugin = _read_json(root / "plugin" / ".claude-plugin" / "plugin.json")
    url = str(plugin.get("repository") or "").strip() if isinstance(plugin, dict) else ""
    return re.sub(r"^(?:https?://)?(?:www\.)?github\.com/", "", url).removesuffix(".git").strip("/")


def release_repo() -> str:
    return repo_slug(REPO_ROOT)


def api_url() -> str:
    v = os.environ.get("THIMBLE_PORT") or ""
    try:
        port = int(v) if v.isdigit() else int(server_state().get("port") or DEFAULT_PORT)
    except (TypeError, ValueError):
        port = DEFAULT_PORT
    return f"http://127.0.0.1:{port}"


def server_answers(url: str) -> bool:
    try:
        with urllib.request.urlopen(f"{url}/api/health", timeout=HEALTH_TIMEOUT_S) as r:
            return r.status == 200 and bool(json.loads(r.read() or b"{}").get("ok"))
    except Exception:  # noqa: BLE001
        return False


# ----------------------------------------------------------------------------- text


def text_only(s: str) -> str:
    return BLOB_RE.sub(lambda m: f"[{len(m.group())} characters of binary data left out]", s)


def redact(s: str) -> tuple[str, int]:
    """`s` with every value that looks like a key, token or password replaced by `[redacted:<kind>]`, and how many."""
    count = 0

    def replacer(kind: str, bounded: bool) -> Callable[[re.Match[str]], str]:
        def one(m: re.Match[str]) -> str:
            nonlocal count
            at, text = m.start(), m.string
            escaped = at > 1 and text[at - 2] == "\\" and text[at - 1] in "nrt"  # `\n` in JSON
            if bounded and at and text[at - 1].isalnum() and not escaped:
                return m.group(0)
            count += 1
            if "v" not in m.re.groupindex:
                return f"[redacted:{kind}]"
            whole = m.group(0)
            return whole[: m.start("v") - at] + f"[redacted:{kind}]" + whole[m.end("v") - at:]
        return one

    for kind, rx, bounded in SECRET_PATTERNS:
        s = rx.sub(replacer(kind, bounded), s)
    return s, count


def log_tail(p: Path, limit: int) -> tuple[str, str]:
    """A server log for the report, within `limit` bytes, and the words contents.txt says about it. Polling lines are
    dropped; when the rest does not fit, its tail is kept after the warnings and errors from before it, so an early
    error still shows. Only the last LOG_SCAN_MAX bytes are read."""
    size = p.stat().st_size
    window = min(size, LOG_SCAN_MAX)
    with p.open("rb") as f:
        f.seek(size - window)
        raw = f.read()
    if window < size:
        raw = raw[raw.find(b"\n") + 1:]
    lines = text_only(raw.decode("utf-8", "replace")).splitlines()
    kept = [ln for ln in lines if not POLL_LINE_RE.match(ln)]
    dropped = len(lines) - len(kept)
    words = [f"without its {dropped:,} lines of GET polling and telemetry"] if dropped else []
    sizes = [len(ln.encode("utf-8")) + 1 for ln in kept]
    if sum(sizes) <= limit:
        return "".join(ln + "\n" for ln in kept), ", ".join(words)
    room, n = max(0, limit - EARLY_ERRORS_MAX), 0
    start = len(kept)
    while start > 0 and n + sizes[start - 1] <= room:
        start -= 1
        n += sizes[start]
    early: list[str] = []
    used, alert = 0, False
    for ln in kept[:start]:
        if ALERT_RE.match(ln):
            alert = True
        elif STAMP_RE.match(ln):
            alert = False
        if alert:
            if used + len(ln.encode("utf-8")) + 1 > EARLY_ERRORS_MAX:
                break
            early.append(ln)
            used += len(ln.encode("utf-8")) + 1
    tail_text = "".join(ln + "\n" for ln in kept[start:])
    words.insert(0, f"its last {human(len(tail_text.encode('utf-8')))}")
    if not early:
        return tail_text, ", ".join(words)
    words.append(f"after {len(early):,} lines of warnings and errors from before that")
    head = (f"---- {len(early):,} lines of warnings and errors from before the tail below ----\n"
            + "".join(ln + "\n" for ln in early) + "---- the tail of the log ----\n")
    return head + tail_text, ", ".join(words)


def tail(p: Path, limit: int) -> tuple[str, bool]:
    """The last `limit` bytes of `p` as text only, starting at a line, and whether anything was cut. A window four times
    the limit is read first, since the binary runs it drops shrink it."""
    size = p.stat().st_size
    window = min(size, limit * 4)
    with p.open("rb") as f:
        f.seek(size - window)
        raw = f.read()
    if window < size:
        nl = raw.find(b"\n")
        raw = raw[nl + 1:] if 0 <= nl < len(raw.rstrip(b"\n")) else raw
    data = text_only(raw.decode("utf-8", "replace")).encode("utf-8")
    cut = window < size
    if len(data) > limit:
        data = data[-limit:]
        nl = data.find(b"\n")
        data = data[nl + 1:] if 0 <= nl < len(data) - 1 else data
        cut = True
    return data.decode("utf-8", "ignore"), cut


def trimmed(v: Any, field_max: int = FIELD_MAX) -> Any:
    """A JSON value with each long string cut to `field_max` characters and binary runs left out."""
    if isinstance(v, str):
        v = text_only(v)
        return v if len(v) <= field_max else v[:field_max] + f"… [{len(v) - field_max} more characters]"
    if isinstance(v, dict):
        return {str(k): trimmed(x, field_max) for k, x in v.items()}
    if isinstance(v, list):
        return [trimmed(x, field_max) for x in v]
    return v


def _read_jsonl(p: Path) -> Iterable[dict[str, Any]]:
    try:
        f = p.open(encoding="utf-8", errors="replace")
    except OSError:
        return
    with f:
        for line in f:
            try:
                rec = json.loads(line)
            except ValueError:
                continue
            if isinstance(rec, dict):
                yield rec


def _own_file(p: Path, root: Path) -> bool:
    """A regular file that is no symlink and resolves inside `root`."""
    try:
        return p.is_file() and not p.is_symlink() and p.resolve().is_relative_to(root.resolve())
    except (OSError, ValueError):
        return False


def human(n: int) -> str:
    """A size in decimal units, as a file manager shows it: 310 KB, 4.2 MB."""
    if n < 1000:
        return f"{n} B"
    if n < 1_000_000:
        return f"{n / 1000:.0f} KB"
    return f"{n / 1_000_000:.1f} MB"


def plural(n: int, word: str) -> str:
    return f"{n} {word}{'' if n == 1 else 's'}"


# ----------------------------------------------------------------------------- the fixed parts


def claude_version() -> str:
    """`claude --version` of the `claude` thimble runs (config.CLI_PATH; PATH's when config cannot be imported)."""
    cfg = _lazy("config")
    exe = cfg.CLI_PATH if cfg is not None else shutil.which("claude")
    if not exe:
        return "not found"
    try:
        out = subprocess.run([exe, "--version"], capture_output=True, text=True, timeout=CLAUDE_TIMEOUT_S)
    except (OSError, subprocess.SubprocessError) as e:
        return f"? ({type(e).__name__})"
    lines = (out.stdout or out.stderr).strip().splitlines()
    return lines[0] if lines else "?"


def _git(*args: str) -> str:
    try:
        return subprocess.run(["git", *args], cwd=REPO_ROOT, capture_output=True, text=True, timeout=10).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return ""


def install_kind() -> tuple[str, str]:
    """(`release`, `checkout` or `unknown`, the line versions.txt shows) from RELEASE.json or the git checkout's state.
    """
    rel = _read_json(REPO_ROOT / "RELEASE.json")
    if isinstance(rel, dict):
        return "release", (f"release {rel.get('version', '?')} @ {rel.get('commit', '?')}, {rel.get('date', '?')}, "
                           f"at {REPO_ROOT}")
    if (REPO_ROOT / ".git").exists():
        dirty = _git("status", "--porcelain")
        return "checkout", (f"git {_git('rev-parse', '--abbrev-ref', 'HEAD') or '?'} @ "
                            f"{_git('rev-parse', '--short', 'HEAD') or '?'} ({len(dirty.splitlines())} uncommitted "
                            f"paths), at {REPO_ROOT}")
    return "unknown", f"no RELEASE.json and not a git checkout, at {REPO_ROOT}"


def versions(user_agent: str = "", workspace: str | None = None) -> dict[str, str]:
    os_name = platform.platform()
    mac = platform.mac_ver()[0]
    if mac:
        os_name = f"macOS {mac} ({os_name})"
    url = api_url()
    kind, line = install_kind()
    out = {"thimble": line, "install": kind,
           "server": f"{'answering' if server_answers(url) else 'not answering'} at {url}",
           "OS": os_name, "Python": platform.python_version(), "Claude Code": claude_version()}
    if user_agent:
        out["browser"] = user_agent[:300]
    if workspace:
        out["workspace"] = workspace
    return out


def doctor() -> str:
    """`thimble doctor`, within DOCTOR_TIMEOUT_S; a line that says why when cli.py cannot be imported or it fails."""
    cli = _lazy("cli")
    if cli is None:
        return "thimble doctor could not run: cli.py failed to import (import-error.txt)"
    box: dict[str, str] = {}

    def run() -> None:
        try:
            box["text"] = cli.doctor_text()
        except Exception as e:  # noqa: BLE001 — the report goes out with what could be gathered
            box["text"] = f"thimble doctor failed: {type(e).__name__}: {e}"

    t = threading.Thread(target=run, daemon=True)
    t.start()
    t.join(DOCTOR_TIMEOUT_S)
    return box.get("text") or f"thimble doctor did not finish within {DOCTOR_TIMEOUT_S:.0f} s"


def without_log(text: str) -> str:
    """The doctor's output without its lines of the server log (DOCTOR_LOG_MARK and after), for a report without logs."""
    if DOCTOR_LOG_MARK not in text:
        return text
    return text[: text.index(DOCTOR_LOG_MARK)].rstrip() + "\n  log tail: left out with the logs"


# What doctor_summary makes of a doctor line, by the start of its value: a word or two, so no path, host, variable or
# log line reaches a public issue.
SUMMARY_WORDS = {
    "auth": (("logged in", "logged in"), ("not logged in", "not logged in"), ("not known", "not known"),
             ("no claude", "no claude")),
    "network": (("not checked", "not checked"), ("cannot reach", "unreachable")),
    "card harness": (("ready", "ready"), ("not drawing", "not drawing"), ("headless Chromium fetched", "Chromium fetched"),
                     ("no headless Chromium", "no Chromium")),
}
DOCTOR_LINE_RE = re.compile(r"^  (server|auth|network|card harness): (.*)$")
DOCTOR_ERRORS_RE = re.compile(r"^  recent errors in the log(?: \((\d+) of|: none)")


def doctor_summary(text: str) -> str:
    """The doctor's output as one line for a public issue, each value as SUMMARY_WORDS names it; the first line of
    `text` when it holds none of those lines."""
    found: dict[str, str] = {}
    errors: int | None = None
    for line in text.splitlines():
        m = DOCTOR_LINE_RE.match(line)
        if m:
            found[m.group(1)] = m.group(2)
        m = DOCTOR_ERRORS_RE.match(line)
        if m:
            errors = int(m.group(1) or 0)
    if not found and errors is None:
        return next((ln.strip() for ln in text.splitlines() if ln.strip()), "")
    parts = []
    for key, value in found.items():
        if key == "server":
            word = value.split(" ", 1)[0]
        elif key == "network" and value.endswith(" answers"):
            word = "reachable"
        else:
            word = next((w for start, w in SUMMARY_WORDS[key] if value.startswith(start)), "unknown")
        parts.append(f"{key} {word}")
    if errors is not None:
        parts.append(f"{errors} recent error{'' if errors == 1 else 's'} in the log")
    return "; ".join(parts)


def screenshot_bytes(data_url: str | None) -> tuple[bytes, str] | None:
    """A PNG or JPEG from the dialog's data URL, with its extension; None for anything else or anything over
    SHOT_MAX."""
    if not data_url:
        return None
    b64 = data_url.split(",", 1)[1] if data_url.startswith("data:") and "," in data_url else data_url
    try:
        raw = base64.b64decode(b64, validate=True)
    except (binascii.Error, ValueError):
        return None
    if len(raw) > SHOT_MAX:
        return None
    if raw.startswith(b"\x89PNG\r\n\x1a\n"):
        return raw, "png"
    if raw.startswith(b"\xff\xd8\xff"):
        return raw, "jpg"
    return None


def browser_rows(entries: Any) -> list[dict[str, Any]]:
    """The browser's ring buffer as the dialog sent it: the last BROWSER_ENTRIES objects, each string cut."""
    rows = [e for e in entries if isinstance(e, dict)] if isinstance(entries, list) else []
    return [trimmed(e) for e in rows[-BROWSER_ENTRIES:]]


# ----------------------------------------------------------------------------- the bundle


class Bundle:
    """The parts in order, each redacted as it is added, the lines contents.txt says about them, and the budget left."""

    def __init__(self, budget: int) -> None:
        self.entries: list[tuple[str, bytes]] = []
        self.notes: list[str] = []
        self.left = budget
        self.redacted = 0

    def text(self, name: str, text: str, note: str | None = None) -> int:
        text, n = redact(text)
        self.redacted += n
        data = text.encode("utf-8")
        self.entries.append((name, data))
        self.left -= len(data)
        if note:
            self.notes.append(f"{name:<32}{note}")
        return len(data)

    def binary(self, name: str, data: bytes, note: str) -> None:
        self.entries.append((name, data))
        self.left -= len(data)
        self.notes.append(f"{name:<32}{note}")

    def file_tail(self, name: str, p: Path, cap: int, what: str) -> int:
        """The tail of `p` within `cap` and the budget; 0 when there is no room or no file."""
        room = min(cap, self.left)
        if room <= 0 or not p.is_file():
            return 0
        text, cut = tail(p, room)
        return self.text(name, text, what + (f", its last {human(len(text.encode('utf-8')))}" if cut else ""))

    def log(self, name: str, p: Path, cap: int, what: str) -> int:
        """A server log within `cap` and the budget (log_tail); 0 when there is no room or no file."""
        room = min(cap, self.left)
        if room <= 0 or not p.is_file():
            return 0
        text, words = log_tail(p, room)
        return self.text(name, text, what + (f", {words}" if words else ""))

    def rows(self, name: str, rows: list[Any], cap: int, what: str) -> int:
        """`rows` as JSONL within `cap` and the budget, the last ones kept when they do not all fit."""
        room = min(cap, self.left)
        lines = [json.dumps(r, ensure_ascii=False, default=str) + "\n" for r in rows]
        kept: list[str] = []
        size = 0
        for line in reversed(lines):
            n = len(line.encode("utf-8"))
            if size + n > room:
                break
            kept.append(line)
            size += n
        if not kept:
            return 0
        more = f"; the last {len(kept)} of {len(lines)}" if len(kept) < len(lines) else ""
        return self.text(name, "".join(reversed(kept)), what + more)

    def part(self, what: str, fn: Callable[..., Any], *args: Any) -> Any:
        """Gather one part; a failure becomes a line in contents.txt, never a failed report."""
        try:
            return fn(*args)
        except Exception as e:  # noqa: BLE001
            self.notes.append(f"{what} could not be read ({type(e).__name__}: {e})")
            return None


def _chat_metas(ws: Path) -> list[tuple[Path, dict[str, Any]]]:
    d = ws / "chats"
    out = []
    for p in sorted(d.glob("*.meta.json")) if d.is_dir() else []:
        meta = _read_json(p) if _own_file(p, ws) else None
        if isinstance(meta, dict):
            out.append((p, meta))
    return out


def _proposals(ws: Path) -> list[dict[str, Any]]:
    p = ws / "views" / "proposals.json"
    rows = _read_json(p) if _own_file(p, ws) else None
    return [r for r in rows if isinstance(r, dict)] if isinstance(rows, list) else []


def dev_tickets(c: str) -> list[dict[str, Any]]:
    """The rows of dev/tickets.jsonl filed from workspace `c`, oldest first."""
    p = Path(os.environ.get("THIMBLE_DEV_DIR") or REPO_ROOT / "dev") / "tickets.jsonl"
    return [r for r in _read_jsonl(p) if r.get("workspace") == c] if p.is_file() and not p.is_symlink() else []


def transcript_roots(ws: Path) -> list[Path]:
    """The Claude Code projects folders a background session's transcript may be in. sessions.json's `config_dir` is
    not read, since a cell can write that file."""
    dirs: list[Path] = []
    cfg = _lazy("config")
    if cfg is not None:
        try:
            dirs.append(cfg.claude_config_dir())
        except Exception:  # noqa: BLE001
            pass
    if os.environ.get("CLAUDE_CONFIG_DIR"):
        dirs.append(Path(os.environ["CLAUDE_CONFIG_DIR"]))
    dirs.append(Path.home() / ".claude")
    return list(dict.fromkeys(d.expanduser() / "projects" for d in dirs))


def find_transcript(sid: str, roots: list[Path]) -> tuple[Path, Path] | None:
    """(transcript, the projects folder it is in) of session `sid`, the newest when there are several."""
    if not SID_RE.match(sid):
        return None
    for root in roots:
        try:
            hits = [p for p in root.glob(f"*/{sid}.jsonl") if _own_file(p, root)]
        except OSError:
            continue
        if hits:
            return max(hits, key=lambda p: p.stat().st_mtime), root
    return None


def _words(s: str) -> str:
    """`s` in lower case with each run of characters other than letters and digits made one space, padded by spaces."""
    return " " + " ".join(re.findall(r"[0-9a-z]+", s.lower())) + " "


def first_chats(c: str, ws: Path, metas: list[tuple[Path, dict[str, Any]]], description: str,
                focus: list[str]) -> list[str]:
    """The chats the report takes first, in order: those a failure names (`focus`), those the description names (whole
    words of NAME_MIN characters or more), the view builds' and dev tickets' newest first, and main."""
    said = _words(description)

    def names(*values: Any) -> bool:
        return any(len(w.strip()) >= NAME_MIN and w in said for w in (_words(str(v)) for v in values if v))

    named: list[str] = []
    dev: list[str] = []
    mtimes: dict[str, float] = {}
    for p, m in metas:
        cid = str(m.get("id") or p.name[: -len(".meta.json")])
        mtimes[cid] = p.stat().st_mtime
        title = str(m.get("title") or "")
        if names(title, title.split(":", 1)[-1], m.get("view"), m.get("slug")):
            named.append(cid)
        if m.get("role") == "dev":
            dev.append(cid)
    for prop in _proposals(ws):
        if prop.get("chat"):
            (named if names(prop.get("name"), prop.get("slug")) else dev).append(str(prop["chat"]))
    dev += [str(t["chat"]) for t in dev_tickets(c) if t.get("chat")]
    dev.sort(key=lambda cid: -mtimes.get(cid, 0))
    return list(dict.fromkeys([*focus, *named, *dev, "main"]))


def background_sessions(c: str, ws: Path, metas: list[tuple[Path, dict[str, Any]]],
                        first: list[str]) -> list[dict[str, Any]]:
    """Every session thimble started for the workspace, those of the `first` chats first, then the most recent. A row of
    the `first` chats is marked `_first`."""
    rows: dict[str, dict[str, Any]] = {}
    mtimes = {str(m.get("id") or p.name[: -len(".meta.json")]): p.stat().st_mtime for p, m in metas}

    def put(sid: Any, **info: Any) -> None:
        sid = str(sid or "")
        if SID_RE.match(sid) and sid not in rows:
            rows[sid] = {"session": sid, **{k: v for k, v in info.items() if v is not None},
                         "_mtime": mtimes.get(str(info.get("chat")), 0)}

    for p, m in metas:
        if m.get("role") in BACKGROUND_ROLES and m.get("session") and not m.get("agent_id"):
            put(m.get("session"), role=m.get("role"), chat=m.get("id") or p.name[: -len(".meta.json")],
                title=m.get("title"), status=m.get("status"), created_at=m.get("created_at"),
                result=trimmed(m.get("result"), 1000))
    for prop in _proposals(ws):
        put(prop.get("session_id"), role="view", chat=prop.get("chat"), title=prop.get("name") or prop.get("slug"),
            status=prop.get("status"), result=trimmed(prop.get("error"), 1000))
    for t in dev_tickets(c)[-MAX_TICKETS:]:
        put(t.get("session_id") or t.get("sdk_session_id"), role="dev", chat=t.get("chat"), title=t.get("title"),
            status=t.get("status"), created_at=t.get("ts"))
    rank = {cid: i for i, cid in enumerate(first)}
    out = list(rows.values())
    for r in out:
        r["_first"] = str(r.get("chat")) in rank
    out.sort(key=lambda r: (rank.get(str(r.get("chat")), len(rank)), -r["_mtime"]))
    return out


def _side_files(path: Path, root: Path) -> list[tuple[Path, str]]:
    """The subagents' and workflow agents' transcripts and metas beside a session's transcript, newest first."""
    side = path.with_suffix("")  # <projects>/<slug>/<sid>/
    subs = []
    for p in side.rglob("*") if side.is_dir() else []:
        rel = p.relative_to(side).as_posix()
        if not rel.startswith("tool-results/") and rel.endswith((".jsonl", ".meta.json")) and _own_file(p, root):
            subs.append((p, rel))
    subs.sort(key=lambda pr: pr[0].stat().st_mtime, reverse=True)
    return subs


def _transcripts(b: Bundle, ws: Path, sessions: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The sessions' transcript tails within TRANSCRIPTS_MAX and half the budget left: the first chats' sessions whole,
    then the other sessions' own transcripts, then their subagents'. Returns the rows of sessions.jsonl."""
    roots = transcript_roots(ws)
    room = min(TRANSCRIPTS_MAX, (b.left - INDEX_ROOM) // 2)
    shown = sessions[:MAX_SESSIONS]
    found = {info["session"]: find_transcript(info["session"], roots) for info in shown}
    files: dict[str, list[str]] = {info["session"]: [] for info in shown}
    subs = {sid: _side_files(*hit) if hit else [] for sid, hit in found.items()}

    def take(sid: str, p: Path, name: str, cap: int) -> None:
        nonlocal room
        if min(cap, room) <= 0:
            return
        text, _ = tail(p, min(cap, room))
        if text:
            files[sid].append(name)
            room -= b.text(name, text)

    def own(sid: str) -> None:
        hit = found[sid]
        if hit:
            take(sid, hit[0], f"workspace/transcripts/{sid}.jsonl", TRANSCRIPT_MAX)

    def side(sid: str) -> None:
        for p, rel in subs[sid]:
            take(sid, p, f"workspace/transcripts/{sid}/{rel}", SUBAGENT_MAX)

    rest = [info["session"] for info in shown if not info.get("_first")]
    for info in shown:
        if info.get("_first"):
            own(info["session"])
            side(info["session"])
    for sid in rest:
        own(sid)
    for sid in rest:
        side(sid)
    index = []
    for info in shown:
        sid = info["session"]
        row = {k: v for k, v in info.items() if not k.startswith("_")}
        if found[sid] is None:
            index.append({**row, "transcript": "not found"})
        else:
            index.append({**row, "transcript": "found", "files": files[sid],
                          "left_out": len(subs[sid]) + 1 - len(files[sid])})
    kept = sum(1 for r in index if r.get("files"))
    if kept:
        b.notes.append(f"{'workspace/transcripts/':<32}the Claude Code transcripts of {kept} of the workspace's "
                       f"{len(sessions)} background sessions and of their subagents, in the order of their chats "
                       f"(each cut to its last {human(TRANSCRIPT_MAX)}, a subagent's to {human(SUBAGENT_MAX)}); images "
                       "left out")
    return index


def _chats(b: Bundle, ws: Path, first: list[str]) -> None:
    """The chats, the `first` ones in that order and then the newest, each cut to CHAT_MAX, within CHATS_MAX and the
    budget."""
    chats_dir = ws / "chats"
    chats = [p for p in chats_dir.glob("*.jsonl") if _own_file(p, ws)] if chats_dir.is_dir() else []
    rank = {cid: i for i, cid in enumerate(first)}
    chats.sort(key=lambda p: (rank.get(p.stem, len(rank)), -p.stat().st_mtime))
    room = min(CHATS_MAX, b.left)
    kept = 0
    for p in chats[:MAX_CHATS]:
        meta = p.with_name(p.stem + ".meta.json")
        meta_text = text_only(meta.read_text("utf-8", "replace")) if _own_file(meta, ws) else ""
        limit = min(CHAT_MAX, room - len(meta_text.encode("utf-8")))
        if limit <= 0:
            break
        text, cut = tail(p, limit)
        room -= b.text(f"workspace/chats/{p.name}", text)
        if meta_text:
            room -= b.text(f"workspace/chats/{meta.name}", meta_text)
        kept += 1
        # a chat cut to the room that was left is the last one: the older ones are left out whole
        if cut and limit < CHAT_MAX:
            break
    if chats:
        b.notes.append(f"{'workspace/chats/':<32}{kept} of the workspace's {len(chats)} chats: those the report names, "
                       f"the view builds', the dev tickets' and main first, then the newest (a longer one keeps its "
                       f"last {human(CHAT_MAX)}); images left out")


def _card_checks(ws: Path) -> list[dict[str, Any]]:
    rows = []
    d = ws / "notebooks"
    for p in sorted(d.glob("*.json")) if d.is_dir() else []:
        nb = _read_json(p) if _own_file(p, ws) else None
        cells = nb.get("cells") if isinstance(nb, dict) else None
        for cell in cells if isinstance(cells, list) else []:
            if isinstance(cell, dict) and (cell.get("check") or cell.get("fixes")):
                rows.append(trimmed({"card": cell.get("id"), "group": p.stem, "title": cell.get("title"),
                                     "check": cell.get("check"), "fixes": cell.get("fixes")}))
    return rows


def _count(v: Any) -> int:
    """A report check run's `comments`: the count it stores, or the length of a list of them."""
    if isinstance(v, bool):
        return 0
    if isinstance(v, int):
        return v
    return len(v) if isinstance(v, (list, dict)) else 0


def _report_checks(ws: Path) -> list[dict[str, Any]]:
    rows = []
    d = ws / "checks"
    for p in sorted(d.glob("*.json")) if d.is_dir() else []:
        chk = _read_json(p) if _own_file(p, ws) else None
        if not isinstance(chk, dict):
            continue
        runs = chk.get("runs") if isinstance(chk.get("runs"), dict) else {}
        # a run's comments quote the document, and covered and seen only list its passages: the count is enough
        runs = {doc: {**{k: v for k, v in run.items() if k not in ("comments", "covered", "seen")},
                      "comments": _count(run.get("comments"))} for doc, run in runs.items() if isinstance(run, dict)}
        rows.append(trimmed({"id": chk.get("id"), "name": chk.get("name"), "shown": chk.get("shown"),
                             "builtin": chk.get("builtin"), "runs": runs}))
    return rows


def _views(b: Bundle, ws: Path) -> None:
    """The proposals, then the views' own files (the reader and definition a build wrote), within VIEWS_MAX."""
    room = min(VIEWS_MAX, b.left)
    props = _proposals(ws)
    if props:
        room -= b.rows("workspace/views.jsonl", [trimmed(r) for r in props], min(STATE_MAX, room),
                       "the view proposals and their builds")
    d = ws / "extension" / "views"  # the workspace's local extension (views.views_dir)
    files, views = 0, set()
    for p in sorted(d.glob("*/*")) if d.is_dir() else []:
        if p.suffix not in VIEW_SUFFIXES or not _own_file(p, ws):
            continue
        if min(VIEW_FILE_MAX, room) <= 0:
            break
        text, _ = tail(p, min(VIEW_FILE_MAX, room))
        room -= b.text(f"workspace/views/{p.parent.name}/{p.name}", text)
        files += 1
        views.add(p.parent.name)
    if files:
        b.notes.append(f"{'workspace/views/':<32}the {plural(files, 'file')} of the corpus's "
                       f"{plural(len(views), 'view')}, without their caches")


def _workspace(b: Bundle, c: str, ws: Path, description: str, focus: list[str]) -> None:
    perms = ws / "permissions.jsonl"
    if _own_file(perms, ws):
        b.part("workspace/permissions.jsonl", b.file_tail, "workspace/permissions.jsonl", perms, PERMISSIONS_MAX,
               "the permission requests of the workspace's sessions and their answers")
    run = ws / "orient" / "run.json"
    if _own_file(run, ws):
        record = json.dumps(trimmed(_read_json(run)), indent=1, ensure_ascii=False)[:STATE_MAX]
        b.part("workspace/orientation.json", b.text, "workspace/orientation.json", record, "the orientation's record")
    b.part("workspace/card-checks.jsonl", lambda: b.rows(
        "workspace/card-checks.jsonl", _card_checks(ws), STATE_MAX, "each card's latest check and its fixes"))
    times = ws / "card-checks" / "timings.jsonl"
    if _own_file(times, ws):
        b.part("workspace/check-timings.jsonl", b.file_tail, "workspace/check-timings.jsonl", times, STATE_MAX,
               "each card check's times and how it ended")
    b.part("workspace/report-checks.jsonl", lambda: b.rows(
        "workspace/report-checks.jsonl", _report_checks(ws), STATE_MAX, "each report check's runs"))
    b.part("workspace/views", _views, b, ws)
    b.part("workspace/dev-tickets.jsonl", lambda: b.rows(
        "workspace/dev-tickets.jsonl", [trimmed(t) for t in dev_tickets(c)[-MAX_TICKETS:]], STATE_MAX,
        "the dev agent's most recent tickets for the workspace"))
    events = ws / "investigations" / "main" / "events.jsonl"
    if _own_file(events, ws):
        b.part("workspace/events.jsonl", b.file_tail, "workspace/events.jsonl", events, EVENTS_MAX,
               "the workspace event stream")
    metas = b.part("the chats' records", _chat_metas, ws) or []
    first = b.part("the chats the report names", first_chats, c, ws, metas, description, focus) or [*focus, "main"]
    sessions = b.part("the background sessions", background_sessions, c, ws, metas, first) or []
    index = b.part("workspace/transcripts", _transcripts, b, ws, sessions) or []
    if index:
        b.rows("workspace/sessions.jsonl", [trimmed(r, 1000) for r in index], STATE_MAX,
               "each background session: role, chat, state and the transcript files taken")
    b.part("workspace/chats", _chats, b, ws, first)


def bundle_dirs() -> list[Path]:
    """Where the zip may go, in order: ~/Downloads, <home>, the system's temp folder."""
    dl = Path.home() / "Downloads"
    return [*([dl] if dl.is_dir() else []), home(), Path(tempfile.gettempdir())]


def bundle_dir() -> Path:
    return bundle_dirs()[0]


def _target(out_dir: Path, now: datetime) -> Path:
    stem = f"thimble-feedback-{now.strftime('%Y%m%d-%H%M%S')}"
    p = out_dir / f"{stem}.zip"
    k = 2
    while p.exists():
        p = out_dir / f"{stem}-{k}.zip"
        k += 1
    return p


def _write(entries: list[tuple[str, bytes]], dirs: list[Path], now: datetime) -> Path:
    """The zip in the first of `dirs` that takes it; OSError naming every folder tried when none does."""
    errors = []
    for out in dirs:
        try:
            out.mkdir(parents=True, exist_ok=True)
            path = _target(out, now)
            tmp = path.with_name(f".{path.name}.tmp")
            try:
                # readable by its owner alone: it holds logs, transcripts and chats, and may land in a shared temp folder
                fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
                os.fchmod(fd, 0o600)
                with os.fdopen(fd, "wb") as raw, zipfile.ZipFile(raw, "w", zipfile.ZIP_DEFLATED) as z:
                    for name, data in entries:
                        # a PNG or JPEG is compressed already
                        kind = zipfile.ZIP_STORED if name.startswith("screenshot.") else zipfile.ZIP_DEFLATED
                        z.writestr(name, data, compress_type=kind)
                tmp.replace(path)
            finally:
                tmp.unlink(missing_ok=True)
            return path
        except OSError as e:
            errors.append(f"{out}: {e.strerror or e}")
    raise OSError("the bundle could not be written: " + "; ".join(errors))


def build(description: str = "", *, workspace: tuple[str, Path] | None = None, screenshot: str | None = None,
          logs: bool = True, user_agent: str = "", browser: Any = None, focus: Iterable[str] = (),
          out_dir: Path | None = None, now: datetime | None = None, shot_asked: bool = False) -> dict[str, Any]:
    """Write the zip and answer where it is, its size, what it holds and the links to send it by. `workspace` is (name,
    folder) or None; `browser` the tab's ring buffer; `focus` the chat ids taken first; `shot_asked` that a screenshot
    was asked for."""
    now = now or datetime.now().astimezone()
    description = str(description or "").strip()[:DESCRIPTION_MAX]
    focus = [str(f) for f in focus if f]
    vers = versions(user_agent, workspace[0] if workspace else None)
    b = Bundle(MAX_BYTES - CONTENTS_ROOM)
    b.text("description.txt", (description or "(no description)") + "\n", "what went wrong, in the reporter's words")
    shot = screenshot_bytes(screenshot)
    if shot:
        b.binary(f"screenshot.{shot[1]}", shot[0], "the tab when the report was made (not scanned for secrets)")
    elif shot_asked:
        b.notes.append(SHOT_MISSING)
    b.text("versions.txt", "".join(f"{k}: {v}\n" for k, v in vers.items()),
           "thimble and its install, whether the server answers, the OS, Python, Claude Code and the browser")
    doc = doctor()
    b.text("doctor.txt", (doc if logs else without_log(doc)) + "\n",
           "`thimble doctor` (it names the auth path in use, never a secret)")
    if _import_errors:
        b.text("import-error.txt", "\n".join(f"app.{k}:\n{v}" for k, v in _import_errors.items()),
               "why a module of the supervisor could not be imported")
    if logs:
        b.part("server-log.txt", b.log, "server-log.txt", home() / "server.log", LOG_MAX, "the server log")
        b.part("server-log.1.txt", b.log, "server-log.1.txt", home() / "server.log.1", ROTATED_LOG_MAX,
               "the server log before a start rotated it")
        b.part("install-log.txt", b.file_tail, "install-log.txt", home() / "install.log", INSTALL_LOG_MAX,
               "the last run of scripts/install.sh")
        rows = browser_rows(browser)
        if rows:
            b.part("browser-log.jsonl", b.rows, "browser-log.jsonl", rows, BROWSER_MAX,
                   "the tab's recent console errors and failed requests")
        if workspace and workspace[1].is_dir():
            _workspace(b, workspace[0], workspace[1], description, focus)
    else:
        b.notes.append("The logs (the server's and the browser's, and the workspace's sessions, transcripts and chats) "
                       "were left out.")
    if b.redacted:
        b.notes.append(f"{b.redacted} values that looked like keys, tokens or passwords were replaced by "
                       "[redacted:<kind>].")
    contents = f"thimble problem report, written {now.isoformat(timespec='seconds')}\n\n" + "\n".join(b.notes) + "\n"
    entries = [("contents.txt", contents.encode("utf-8")), *b.entries]
    path = _write(entries, [out_dir] if out_dir else bundle_dirs(), now)
    size = path.stat().st_size
    shared = redact(description)[0]  # the new issue carries the description too, and an issue is public
    return {"path": str(path), "name": path.name, "bytes": size, "size": human(size),
            "files": [name for name, _ in entries], "can_reveal": reveal_command(path) is not None,
            "screenshot_missing": bool(shot_asked and not shot),
            "contact": CONTACT, "contact_url": CONTACT_URL, "instructions": instructions(), "redacted": b.redacted,
            "issue_url": issue_url(shared, vers, doctor_summary(doc), path.name)}


# ----------------------------------------------------------------------------- sending it


def _first_line(description: str) -> str:
    line = next((ln.strip() for ln in description.splitlines() if ln.strip()), "")
    return line if len(line) <= 80 else line[:79].rstrip() + "…"


def issue_note(bundle: str = "") -> str:
    """The new issue's last paragraph: what to do with the zip."""
    name = f" ({bundle})" if bundle else ""
    return (f"The problem report zip{name}: attach it here only if you are happy to share it publicly, since issues are "
            f"public. Otherwise leave it out and reach {CONTACT} ({CONTACT_URL}) for private logs.\n")


def issue_url(description: str, vers: dict[str, str], doctor_line: str = "", bundle: str = "") -> str:
    """The prefilled new issue, which is public: a title, the description, versions without paths, the doctor's summary
    and issue_note. Nothing of the logs, workspace or corpus."""
    title = _first_line(description) or "Problem report"
    text = description if len(description) <= ISSUE_TEXT_MAX else description[:ISSUE_TEXT_MAX].rstrip() + "…"
    facts = {k: vers[k].split(", at ")[0] for k in ISSUE_VERSIONS if vers.get(k)}
    if doctor_line:
        facts["doctor"] = doctor_line
    body = ((text or "(describe what went wrong)") + "\n\n" + "".join(f"- {k}: {v}\n" for k, v in facts.items())
            + "\n" + issue_note(bundle))
    return f"{issues_url()}?{urlencode({'title': title, 'body': body}, quote_via=quote)}"


def cli_text(out: dict[str, Any], skill: bool = False) -> str:
    """What `thimble feedback` prints. For /thimble's skill every line starts `thimble:` and the issue link is the plain
    new-issue page."""
    files = out["files"]
    grouped = ("workspace/chats/", "workspace/transcripts/", "workspace/views/")
    chats = sum(1 for f in files if f.startswith("workspace/chats/") and f.endswith(".jsonl"))
    trans = sum(1 for f in files if f.startswith("workspace/transcripts/") and f.endswith(".jsonl"))
    shown = [f for f in files if not f.startswith(grouped)]
    shown += [f"{n} {word}{'' if n == 1 else 's'}" for n, word in ((chats, "chat"), (trans, "transcript")) if n]
    first = f"thimble: wrote {out['path']} ({out['size']})"
    holds = f"It holds: {', '.join(shown)}."
    contact = f"{out['contact']} on GitHub: {out['contact_url']}"
    if skill:
        return "\n".join([first, f"thimble: {holds}", f"thimble: {out['instructions']}",
                          f"thimble: Open a GitHub issue: {out['issue_url'].split('?', 1)[0]}", f"thimble: {contact}"])
    return "\n".join([first, holds, out["instructions"], f"Open a GitHub issue: {out['issue_url']}", contact])


def reveal_command(path: Path) -> list[str] | None:
    """The command that shows `path` in the server machine's file manager, or None where there is none."""
    if sys.platform == "darwin":
        return ["open", "-R", str(path)] if shutil.which("open") else None
    if sys.platform.startswith("win"):
        return ["explorer", f"/select,{path}"]
    if shutil.which("xdg-open") and (os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY")):
        return ["xdg-open", str(path.parent)]
    return None


def own_bundle(path: str) -> Path:
    """`path` when it is a bundle this module wrote (its name, in one of bundle_dirs); ValueError for any other."""
    p = Path(path)
    if not NAME_RE.match(p.name) or not p.is_file() or p.parent.resolve() not in {d.resolve() for d in bundle_dirs()}:
        raise ValueError("not a problem report bundle")
    return p


def reveal(path: str) -> None:
    """Show a bundle this module wrote. Raises ValueError for any other path, LookupError where nothing can show it."""
    p = own_bundle(path)
    cmd = reveal_command(p)
    if cmd is None:
        raise LookupError("this machine has no file manager to show it in")
    subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                     start_new_session=True)


# ----------------------------------------------------------------------------- the command


NOT_A_WORKSPACE_LINE = ("{cwd} is not a thimble workspace, so the report holds no workspace's chats or sessions; run "
                        "it in the corpus folder for those.")


def run(description: str, *, cwd: Path, logs: bool = True, skill: bool = False) -> int:
    """`thimble feedback`: the report for the workspace of `cwd`, printed as cli_text. Exits 0 once written, else 1; for
    the skill always 0 with a thimble: line saying what failed, since a skill fails whole on a non-zero exit."""
    try:
        ws = workspace_for(cwd)
    except Exception:  # noqa: BLE001 — a report without the workspace is still a report
        ws = None
    try:
        out = build(description, workspace=ws, logs=logs)
    except Exception as e:  # noqa: BLE001 — never a traceback in the skill's text
        print(f"thimble: the problem report could not be written: {type(e).__name__}: {e}")
        return 0 if skill else 1
    print(cli_text(out, skill=skill))
    if ws is None:
        print(("thimble: " if skill else "") + NOT_A_WORKSPACE_LINE.format(cwd=cwd))
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="thimble feedback", description=(
        "write a problem report (a zip) to send the developer, and say how to send it"))
    ap.add_argument("description", nargs="*", help="what went wrong")
    ap.add_argument("--no-logs", action="store_true",
                    help="leave out the logs: the server log and the workspace's sessions, transcripts and chats")
    ap.add_argument("--cwd", help="the folder whose workspace the report is for (default: the current folder)")
    ap.add_argument("--skill", action="store_true", help=argparse.SUPPRESS)  # /thimble's: every line starts thimble:
    args = ap.parse_args(argv)
    cwd = Path(args.cwd or os.environ.get("THIMBLE_CALLER_CWD") or os.getcwd())
    return run(" ".join(args.description), cwd=cwd, logs=not args.no_logs, skill=args.skill)


if __name__ == "__main__":
    sys.exit(main())
