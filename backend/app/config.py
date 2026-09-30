"""Paths, the `claude` thimble runs and its environment, corpora, model defaults."""
from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping

log = logging.getLogger("thimble.config")

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
# new for every start of the server's code, an execv restart and a reload among them: /api/health carries it, so the
# watch over a restart (restart_watch.py) tells the restarted server from the one before it
BOOT_ID = os.urandom(4).hex()


def default_data_dir() -> Path:
    """$THIMBLE_HOME/data (THIMBLE_HOME, else ~/.thimble): where the registry of folders lives (the sidecars
    <name>.corpus.json that map a registered folder to its workspace), outside the install tree. THIMBLE_DATA_DIR
    overrides it. Read fresh from the environment, so cli.resolve_env's default and a test's THIMBLE_HOME agree."""
    return (Path(os.environ.get("THIMBLE_HOME") or "~/.thimble").expanduser() / "data").resolve()


DATA_DIR = Path(os.environ.get("THIMBLE_DATA_DIR") or default_data_dir()).resolve()
# The install tree's data/: a legacy registry location and where a checkout's own corpora sit as directories
# data/<c>/manifest.json. migrate_registry brings the records it holds into DATA_DIR at server start.
LEGACY_DATA_DIR = REPO_ROOT / "data"
WORKSPACES_DIR = Path(os.environ.get("THIMBLE_WORKSPACES_DIR", REPO_ROOT / "workspaces")).resolve()
# The built UI (frontend/dist). main.py serves it at / when the server is not in dev mode (a release install has no
# Vite); cli.py's ensure and doctor print NO_UI_BUILD_HINT when it is missing. Tests point FRONTEND_DIST at a scratch dir.
FRONTEND_DIST = Path(os.environ.get("THIMBLE_FRONTEND_DIST", REPO_ROOT / "frontend" / "dist")).resolve()
NO_UI_BUILD_HINT = "no frontend build: run scripts/release.sh or npm run build, or start with THIMBLE_DEV=1"


EFFORTS = ("low", "medium", "high", "xhigh")
# Fast mode is the default for every model call thimble makes: THIMBLE_MODEL_SPEED, read by model_speed(). A model
# without fast mode (has_fast_mode) runs standard whatever the knob says.
SPEEDS = ("standard", "fast")
FAST_MODE_MODELS = ("opus-5", "opus-4-8")  # the CLI's own rule: the model id contains one of these


def _speed(env: str, default: str | None, environ: Mapping[str, str] | None = None) -> str | None:
    """A model speed (SPEEDS: standard | fast) from the environment (`environ`; default os.environ). Unset or empty is
    the default; a typo falls back to the default with a warning."""
    src = os.environ if environ is None else environ
    v = str(src.get(env) or "").strip().lower()
    if not v:
        return default
    if v not in SPEEDS:
        log.warning("%s=%r is not one of %s; using %r", env, v, SPEEDS, default)
        return default
    return v


def model_speed() -> str:
    """THIMBLE_MODEL_SPEED, read at call time: the speed of every model call without an override of its own (default
    fast; a typo is fast with a warning)."""
    return _speed("THIMBLE_MODEL_SPEED", "fast") or "fast"


def has_fast_mode(model: str | None) -> bool:
    """Whether fast mode exists for `model` (FAST_MODE_MODELS, matched as the CLI matches: Opus 5 and Opus 4.8, dated
    or [1m] variants included; nothing else)."""
    m = (model or "").lower()
    # `opus` alone is Claude Code's alias for the current Opus, which has fast mode
    return any(k in m for k in FAST_MODE_MODELS) or m.split("[", 1)[0] == "opus"


def fast_mode_for(model: str | None, speed: str | None = None) -> bool:
    """Whether a call on `model` runs in fast mode: `speed` (an override; None = model_speed()) is fast and the model
    has fast mode."""
    return (speed or model_speed()) == "fast" and has_fast_mode(model)


# The `claude` every session and model call runs: THIMBLE_CLAUDE_BIN, else the one on PATH, else ~/.local/bin/claude.
# There is no fallback to the Agent SDK's bundled CLI: without the user's own `claude`, a call fails with NO_CLAUDE.
def _resolve_cli() -> str | None:
    override = os.environ.get("THIMBLE_CLAUDE_BIN")
    if override:
        return shutil.which(override) or override
    found = shutil.which("claude")
    if found:
        return found
    home_bin = os.path.expanduser("~/.local/bin/claude")
    return home_bin if os.path.exists(home_bin) else None


CLI_PATH = _resolve_cli()
CLAUDE_BIN = CLI_PATH or "claude"
NO_CLAUDE_FOUND = "the `claude` CLI was not found (not on PATH, not at ~/.local/bin/claude)"  # what a model call says
NO_CLAUDE = f"{NO_CLAUDE_FOUND}: install Claude Code, or name its path with THIMBLE_CLAUDE_BIN"


# --------------------------------------------------------------------------- the kernel wrapper
#
#   none    the kernel runs backend/.venv's python in the server's scrubbed environment
#   srt     the kernel runs inside Anthropic's sandbox runtime (kernel_wrap.srt_rules, kernel_srt.mjs), on macOS and
#           Linux: it reads the system, the venv and the corpus, writes only the workspace, and keeps the host's network
#   bwrap   the kernel runs inside bubblewrap directly (kernel_wrap.kernel_wrap_argv), on Linux: the same boundary
# A wrapper narrows what a cell sees but is not a boundary against the network. When the one a workspace names cannot
# run (no bwrap on PATH; no node or no sandbox runtime package), the kernel does not start, so a workspace set to a
# wrapper never runs unwrapped unnoticed.
# Resolution, first hit wins: THIMBLE_KERNEL_WRAP, then the workspace's settings.json `kernel_wrap`, then the default:
# srt where it works (kernel_wrap.srt_works), else bwrap on Linux where bubblewrap works (kernel_wrap.works), else none.
# A value that names no wrapper is ignored.
KERNEL_WRAPS = ("none", "bwrap", "srt")
KERNEL_WRAP_ENV = "THIMBLE_KERNEL_WRAP"
KERNEL_WRAP_KEY = "kernel_wrap"  # settings.json: none | bwrap | srt
KERNEL_WRAP_NONE, KERNEL_WRAP_BWRAP, KERNEL_WRAP_SRT = KERNEL_WRAPS
KERNEL_WRAPPED = (KERNEL_WRAP_BWRAP, KERNEL_WRAP_SRT)
NO_WRAP_HINT = "with kernel_wrap: none the kernel runs without it"  # in the server log
_KERNEL_WRAP_WARNED: set[str] = set()


def resolve_kernel_wrap(settings: Mapping[str, Any] | None = None,
                        environ: Mapping[str, str] | None = None) -> tuple[str, str]:
    """(wrap, source) of the kernel wrapper: source is `env` (THIMBLE_KERNEL_WRAP), `settings` (the workspace's
    settings.json, passed in as a dict) or `default`. The default may probe the machine (default_kernel_wrap)."""
    src = os.environ if environ is None else environ
    raw = str(src.get(KERNEL_WRAP_ENV, "") or "").strip().lower()
    if raw in KERNEL_WRAPS:
        return raw, "env"
    if raw and raw not in _KERNEL_WRAP_WARNED:
        _KERNEL_WRAP_WARNED.add(raw)
        log.warning("%s=%r is not one of %s; ignored", KERNEL_WRAP_ENV, raw, KERNEL_WRAPS)
    s = settings if isinstance(settings, Mapping) else {}
    v = s.get(KERNEL_WRAP_KEY)
    if isinstance(v, str) and v.strip().lower() in KERNEL_WRAPS:
        return v.strip().lower(), "settings"
    return default_kernel_wrap(), "default"


def default_kernel_wrap() -> str:
    """The kernel wrapper where nothing names one: srt where it works, else bwrap on Linux where bubblewrap works, else
    none. Each probe runs once per process."""
    from . import kernel_wrap  # noqa: PLC0415

    if kernel_wrap.srt_works(kernel_wrap.node(), kernel_wrap.srt_package(REPO_ROOT)):
        return KERNEL_WRAP_SRT
    return KERNEL_WRAP_BWRAP if sys.platform.startswith("linux") and kernel_wrap.works() else KERNEL_WRAP_NONE


def kernel_wrap(settings: Mapping[str, Any] | None = None, environ: Mapping[str, str] | None = None) -> str:
    """The resolved kernel wrapper, one of KERNEL_WRAPS (resolve_kernel_wrap without the source)."""
    return resolve_kernel_wrap(settings, environ)[0]


# --------------------------------------------------------------------------- Claude Code's environment and login
#
# thimble never handles credentials: every model call runs the user's own `claude` in their config dir with their
# settings, so it authenticates and bills as `claude` does. THIMBLE_SKIP_KEY=1 (tests) makes auth_status answer None.


def _skip() -> bool:
    return os.environ.get("THIMBLE_SKIP_KEY") == "1"


# The CLAUDE_* variables a `claude` thimble starts takes from this process: those naming the config dir, a provider, a
# login or a network setting. Every other one (CLAUDECODE, CLAUDE_CODE_SESSION_ID, CLAUDE_CODE_ENTRYPOINT and the rest of
# the calling session's identity) stays out. A variable naming a file descriptor stays out too, since the server
# starts with its descriptors closed.
_CLAUDE_PASS = re.compile(r"CLAUDE_CONFIG_DIR|CLAUDE_CODE_(USE_\w+|SKIP_\w+_AUTH|OAUTH_(TOKEN|REFRESH_TOKEN|SCOPES)|"
                          r"CLIENT_\w+|API_KEY_HELPER_TTL_MS|DISABLE_NONESSENTIAL_TRAFFIC)")


def passes(name: str) -> bool:
    """Whether the environment variable `name` passes to a `claude` thimble starts (_CLAUDE_PASS)."""
    if not name.startswith("CLAUDE"):
        return True
    return not name.endswith("_FILE_DESCRIPTOR") and _CLAUDE_PASS.fullmatch(name) is not None


def passed_environ(environ: Mapping[str, str] | None = None) -> dict[str, str]:
    """`environ` (default this process's) with only the variables that pass (passes)."""
    return {k: v for k, v in (os.environ if environ is None else environ).items() if passes(k)}


AUTH_STATUS_TIMEOUT_S = 20.0


def auth_status(env: Mapping[str, str] | None = None, cwd: str | Path | None = None) -> dict[str, Any] | None:
    """What `claude auth status --json` reports for the login a `claude` thimble starts would use (`env`, default
    claude_env(passed_environ())), in the folder `cwd` (a temporary one when it is none): loggedIn, authMethod,
    apiKeySource, apiProvider and the like. None when `claude` is missing, the command fails to print an object, or
    under THIMBLE_SKIP_KEY. loggedIn means a login is configured, not that it works."""
    if _skip() or not CLI_PATH:
        return None
    try:
        r = subprocess.run([CLI_PATH, "auth", "status", "--json"], capture_output=True, text=True,
                           env=dict(env) if env is not None else claude_env(passed_environ()),
                           cwd=str(cwd) if cwd and Path(cwd).is_dir() else tempfile.gettempdir(),
                           stdin=subprocess.DEVNULL, timeout=AUTH_STATUS_TIMEOUT_S)
        d = json.loads(r.stdout)
    except (OSError, subprocess.SubprocessError, ValueError):
        return None
    return d if isinstance(d, dict) else None


def auth_problem(status: dict[str, Any] | None = None) -> str:
    """The alert when a model call cannot run: no `claude`, or `claude auth status` reporting no login; '' otherwise,
    when the status cannot be read (the call itself then says what failed), and under THIMBLE_SKIP_KEY."""
    if _skip():
        return ""
    if not CLI_PATH:
        return NO_CLAUDE
    st = auth_status() if status is None else status
    if st is not None and st.get("loggedIn") is False:
        return "Claude Code is not logged in (`claude auth status`): log in with `claude`, then try again"
    return ""


# The model a session (agent_session) or a structured call (model.structured) runs on again, once, when a safety
# classifier stopped its model's response (`stop_reason: refusal`); THIMBLE_FALLBACK_MODEL names another, '' turns it off.
FALLBACK_MODEL = os.environ.get("THIMBLE_FALLBACK_MODEL", "claude-opus-4-8").strip()


# Claude Code's config dir: CLAUDE_CONFIG_DIR, else ~/.claude (transcripts, sessions/<pid>.json, settings.json, the
# login). The one that counts is the one the served `claude` process runs with, which need not be this server's, so
# the session's shim reports it in its signed subscription (session.connected), and claude_config_dir() answers with it
# from then on (serve_claude_config), while this server's own CLAUDE_CONFIG_DIR is unchanged. Sessions this server
# starts get the same value (claude_env).
CONFIG_DIR_ENV = "CLAUDE_CONFIG_DIR"
_served_config: tuple[str | None, str | None] | None = None  # (our own value when learned, the served process's value)


def own_claude_config() -> str | None:
    """This process's CLAUDE_CONFIG_DIR; None when it is unset."""
    return os.environ.get(CONFIG_DIR_ENV) or None


def claude_config_env() -> str | None:
    """CLAUDE_CONFIG_DIR as the Claude Code thimble serves has it: the served process's value once a session told this
    server, else this process's own; None when it is unset (Claude Code's default)."""
    own = own_claude_config()
    if _served_config is not None and _served_config[0] == own:
        return _served_config[1]
    return own


def claude_config_dir() -> Path:
    """The config dir of the Claude Code thimble serves (claude_config_env): CLAUDE_CONFIG_DIR, else ~/.claude."""
    value = claude_config_env()
    return Path(value) if value else Path.home() / ".claude"


def config_dir_of(value: str | None) -> Path:
    """The config dir a CLAUDE_CONFIG_DIR value names: the value, or ~/.claude when it is unset."""
    return Path(value) if value else Path.home() / ".claude"


def serve_claude_config(value: str | None, who: str = "") -> bool:
    """Record the CLAUDE_CONFIG_DIR of the `claude` process this server serves (None: unset), so claude_config_dir() answers
    with it; True when that changed what it answers. `who` names the session in the log line."""
    global _served_config
    before = claude_config_dir()
    own = own_claude_config()
    _served_config = None if value == own else (own, value)
    after = claude_config_dir()
    if after != before:
        log.info("serving %s, whose Claude Code config dir is %s (this server's own is %s): Claude Code's files are read "
                 "there from now on", who or "a session", after, config_dir_of(own))
    return after != before


def claude_env(env: dict[str, str]) -> dict[str, str]:
    """`env`, a Claude Code process's environment built from this server's, with the served CLAUDE_CONFIG_DIR in it (or
    none, when the served process runs on the default), so the sessions this server starts use main's config dir."""
    value = claude_config_env()
    out = dict(env)
    if value:
        out[CONFIG_DIR_ENV] = value
    else:
        out.pop(CONFIG_DIR_ENV, None)
    return out


# --------------------------------------------------------------------------- corpora: DATA_DIR dirs and registered sidecars
#
# A corpus is either a directory DATA_DIR/<name>/ holding a manifest.json, or a directory anywhere on disk registered
# through a sidecar file DATA_DIR/<name>.corpus.json {name, root, path, registered_at, manifest}: `/thimble` posts the
# session's cwd to POST /api/corpora/register, and nothing is ever written into that directory. `root` is the folder the
# Claude Code session runs in and `path` the working directory everything reads as the corpus; they are equal unless the
# working directory was narrowed. A cwd maps to the workspace when it is root or path or a descendant of either
# (workspace_for_cwd).

NAME_RE = re.compile(r"[A-Za-z0-9._-]+")
SIDECAR_SUFFIX = ".corpus.json"


def _valid_name(name: str) -> bool:
    return bool(name) and NAME_RE.fullmatch(name) is not None and name not in {".", ".."}


def sidecar_path(name: str) -> Path:
    return DATA_DIR / f"{name}{SIDECAR_SUFFIX}"


def read_sidecar(name: str, data_dir: Path | None = None) -> dict | None:
    """The registration record {name, root, path, registered_at, manifest} of a registered corpus, else None: under
    DATA_DIR, or under `data_dir` for a caller that resolves the data folder itself (cli). A record without `root` reads
    root as the path."""
    if not _valid_name(name):
        return None
    try:
        path = sidecar_path(name) if data_dir is None else data_dir / f"{name}{SIDECAR_SUFFIX}"
        rec = json.loads(path.read_text("utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(rec, dict) or not isinstance(rec.get("path"), str):
        return None
    rec.setdefault("name", name)
    if not isinstance(rec.get("root"), str) or not rec["root"]:
        rec["root"] = rec["path"]
    if not isinstance(rec.get("manifest"), dict):
        rec["manifest"] = {"name": rec["name"], "description": ""}
    return rec


def registered_corpora() -> list[dict]:
    """Every readable sidecar under DATA_DIR, by name."""
    out: list[dict] = []
    if DATA_DIR.is_dir():
        for p in sorted(DATA_DIR.glob(f"*{SIDECAR_SUFFIX}")):
            rec = read_sidecar(p.name[: -len(SIDECAR_SUFFIX)])
            if rec is not None:
                out.append(rec)
    return out


def _dir_corpus(name: str) -> Path | None:
    """DATA_DIR/<name> when it is a corpus directory (a manifest.json inside), else None."""
    p = (DATA_DIR / name).resolve()
    if p.parent == DATA_DIR and p.is_dir() and (p / "manifest.json").is_file():
        return p
    return None


def corpus_dir(name: str) -> Path:
    """Validated absolute path of a corpus: DATA_DIR/<name> with its manifest.json, else the directory a sidecar
    registered under that name. Raises ValueError for bad names, missing corpora and a registered directory that is
    gone."""
    if not _valid_name(name):
        raise ValueError(f"invalid corpus name: {name!r}")
    p = _dir_corpus(name)
    if p is not None:
        return p
    rec = read_sidecar(name)
    if rec is not None:
        reg = Path(rec["path"]).resolve()
        if reg.is_dir():
            return reg
        raise ValueError(f"registered corpus {name!r}: its directory {rec['path']} is gone")
    raise ValueError(f"no such corpus: {name!r}")


def corpus_manifest(name: str) -> dict:
    """The corpus's manifest: a registered corpus's sidecar manifest first (synthesized at registration when the
    directory had none), else DATA_DIR/<name>/manifest.json. An unreadable file is reported inside the dict, never
    raised (the corpora list must still render)."""
    if _dir_corpus(name) is None:
        rec = read_sidecar(name)
        if rec is not None:
            return dict(rec["manifest"])
    mf = corpus_dir(name) / "manifest.json"
    try:
        m = json.loads(mf.read_text("utf-8"))
    except OSError:
        return {"name": name, "description": ""}
    except ValueError as e:
        return {"name": name, "error": f"manifest.json unreadable: {e}"}
    return m if isinstance(m, dict) else {"name": name, "error": "manifest.json is not an object"}


def corpus_name_for(path: Path) -> str:
    """The corpus name a directory registers under: its basename with anything outside NAME_RE replaced by '-'."""
    name = re.sub(r"[^A-Za-z0-9._-]+", "-", path.name).strip("-.")
    return name if _valid_name(name) else "corpus"


SESSION_PREFIX = "thimble:"  # of every Claude Code session's name thimble gives (session_name)
SESSION_SEP = " · "  # between a session's role and its workspace in its name
SESSION_NAME_MAX = 80  # a name's length at most, as dev.py kept its sessions' names before names carried the workspace
SESSION_PART_MIN = 16  # what a long name keeps of its workspace, and of its role, at least (session_name)


def _shortened(part: str, n: int) -> str:
    """`part` when it has at most `n` characters, else its start, `~` and six hex digits of a hash of the whole of it, `n`
    characters in all, so two long parts that share a start stay apart."""
    if len(part) <= n:
        return part
    return f"{part[:n - 7]}~{hashlib.sha1(part.encode()).hexdigest()[:6]}"


def session_name(role: str, workspace: str | None) -> str:
    """The name a Claude Code session thimble starts goes by (`claude -n`), as `claude agents`, the agent view, the
    /resume picker and SendMessage's `to` know it: `thimble:<role> · <workspace>`, such as `thimble:main · logs-2` or
    `thimble:writer-story · logs-2`, since those lists hold the sessions of every folder, so two workspaces must not share
    a name; `thimble:<role>` alone for a session of no workspace (`thimble fix`'s code ticket). A name is at most
    SESSION_NAME_MAX characters: a longer one shortens its workspace first, down to SESSION_PART_MIN characters, then its
    role (_shortened), so distinct roles and workspaces keep distinct names."""
    room = SESSION_NAME_MAX - len(SESSION_PREFIX) - (len(SESSION_SEP) if workspace else 0)
    if workspace:
        workspace = _shortened(workspace, max(SESSION_PART_MIN, room - len(role)))
        role = _shortened(role, room - len(workspace))
        return f"{SESSION_PREFIX}{role}{SESSION_SEP}{workspace}"
    return SESSION_PREFIX + _shortened(role, room)


def session_role(name: str) -> str:
    """A session name of thimble's without its workspace (`thimble:writer · logs` → `thimble:writer`), as the lines of
    that workspace's own views show it (the statusline, a tray entry's news); any other name as it is."""
    return name.partition(SESSION_SEP)[0] if name.startswith(SESSION_PREFIX) else name


def _under(p: Path, base: Path) -> bool:
    """Whether `p` is `base` or a descendant of it (both resolved). On macOS the default disk folds case and
    Path.resolve() does not, so a folder typed with another case is checked by identity too: base's inode against p's
    and each of its parents'."""
    if p == base or base in p.parents:
        return True
    if sys.platform != "darwin":
        return False
    try:
        b = base.stat()
        return any(os.path.samestat(q.stat(), b) for q in (p, *p.parents))
    except OSError:
        return False


def _sidecar_bases(rec: dict) -> dict[str, Path]:
    """A sidecar record's `root` and `path`, resolved, by key; one that is missing or unusable is left out."""
    out: dict[str, Path] = {}
    for key in ("root", "path"):
        raw = rec.get(key)
        if not isinstance(raw, str) or not raw:
            continue
        try:
            out[key] = Path(raw).resolve()
        except (OSError, RuntimeError):
            continue
    if "path" in out and "root" not in out:  # a record without `root` (read_sidecar backfills the same)
        out["root"] = out["path"]
    return out


def sidecar_match(p: Path, recs: list[dict] | None = None) -> tuple[dict, Path] | None:
    """(the registered corpus a resolved path belongs to, the folder of it that claimed the path): the most specific claim
    first. Pass 1: the sidecar whose working directory is the folder, a narrowed one first; pass 2: the one whose root is
    the folder; pass 3: the deepest root or path that contains it. So a corpus registered under a registered ancestor wins
    for its own folder and everything below it. None when no sidecar holds it."""
    recs = registered_corpora() if recs is None else recs
    bases = [(rec, _sidecar_bases(rec)) for rec in recs]
    exact = [(rec, b) for rec, b in bases if b.get("path") == p]
    if exact:
        return next((rec for rec, b in exact if b.get("root") != p), exact[0][0]), p
    for rec, b in bases:
        if b.get("root") == p:
            return rec, p
    best: tuple[dict, Path] | None = None
    for rec, b in bases:
        for base in b.values():
            if _under(p, base) and (best is None or len(base.parts) > len(best[1].parts)):
                best = (rec, base)
    return best


def corpus_root_for_dir(path: str | Path) -> Path | None:
    """The registered root of the corpus whose working directory is `path`, when that directory was narrowed under it
    (root != path); None otherwise. refs._locate reads it to accept a root-relative path the session (which runs in the
    root) cited."""
    try:
        p = Path(path).resolve()
    except (OSError, RuntimeError):
        return None
    for rec in registered_corpora():
        b = _sidecar_bases(rec)
        if b.get("path") == p and "root" in b and b["root"] != p:
            return b["root"]
    return None


def corpus_root_for(path: str | Path) -> tuple[str, Path] | None:
    """(name, the folder that claimed it) of the corpus `path` is in: a corpus directory DATA_DIR/<c> the path is in
    (these come first, so a registration of a checkout whose data/ is DATA_DIR never claims them), else the registered
    corpus whose root or working directory holds it (sidecar_match). None when the path is in neither."""
    try:
        p = Path(path).expanduser().resolve()
    except (OSError, RuntimeError):
        return None
    for cand in (p, *p.parents):
        if cand.parent == DATA_DIR and _valid_name(cand.name) and _dir_corpus(cand.name) is not None:
            return cand.name, cand  # walking up: the first is the deepest
    found = sidecar_match(p)
    return (found[0]["name"], found[1]) if found else None


def workspace_for_cwd(path: str | Path) -> str | None:
    """The corpus name for a path inside DATA_DIR/<c> or inside a registered directory (corpus_root_for); None when the
    path is in neither."""
    found = corpus_root_for(path)
    return found[0] if found else None


def workspace_for_folder(path: str | Path | None) -> str | None:
    """The workspace whose folder, WORKSPACES_DIR/<c>, holds `path`, such as the orientation's work folder, which its
    session runs in (agent_session, the fence), so its thimble tools find their workspace from its shim's cwd; None
    for a path outside WORKSPACES_DIR or a folder of no corpus."""
    if not path:
        return None
    try:
        rel = Path(path).resolve().relative_to(WORKSPACES_DIR)
    except (OSError, ValueError):
        return None
    name = rel.parts[0] if rel.parts else ""
    try:
        corpus_dir(name)
    except ValueError:
        return None
    return name


def workspace_for_corpus_dir(path: str | Path) -> str:
    """The workspace (= corpus) name a corpus directory is served under: DATA_DIR/<c> is `c`; a registered directory is
    its sidecar's name, which need not be the basename; a directory that is neither falls back to its basename. Never
    derive a workspace from `corpus_dir.name` directly."""
    p = Path(path)
    known = workspace_for_cwd(p)
    return known if known is not None else p.name


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def free_name(base: str, data_dir: Path | None = None) -> str:
    """`base` when no corpus of the data folder (DATA_DIR, or `data_dir`) and no readable sidecar holds it, else base-2,
    base-3 …: two folders called logs/ are two workspaces, `logs` and `logs-2`."""
    d = DATA_DIR if data_dir is None else data_dir.resolve()
    n = 1
    while True:
        name = base if n == 1 else f"{base}-{n}"
        taken = (d / name / "manifest.json").is_file() if data_dir is not None else _dir_corpus(name) is not None
        if not taken and read_sidecar(name, None if data_dir is None else d) is None:
            return name
        n += 1


def register_corpus(path: str | Path, *, exact: bool = False) -> dict:
    """Register a directory as a corpus and return its record {name, root, path, registered_at, manifest}.

    A path inside DATA_DIR/<c> is corpus c: nothing written. A path inside (not at) a registered directory is that
    directory's corpus unless `exact`, which registers the folder itself. Exactly a registered working directory refreshes
    its sidecar; exactly a root writes nothing. Otherwise the sidecar DATA_DIR/<name>.corpus.json is written atomically,
    <name> being the basename or the next free `-2`, `-3` …. Raises ValueError for a path that is not a directory."""
    p = Path(path).expanduser().resolve()
    if not p.is_dir():
        raise ValueError(f"not a directory: {path}")
    prev: dict | None = None
    known = corpus_root_for(p)
    if known is not None:
        kname, kbase = known
        rec = read_sidecar(kname)
        if rec is None:
            # inside DATA_DIR/<c>, `exact` or not (a corpus directory is one unit): that corpus, nothing written
            here = str(corpus_dir(kname))
            return {"name": kname, "root": here, "path": here, "registered_at": None, "manifest": corpus_manifest(kname)}
        bases = _sidecar_bases(rec)
        if bases.get("path") == p:
            # exactly the registered working directory: refresh its sidecar under the name it has (a narrowed working
            # directory's basename is not the corpus's name)
            prev = rec
        elif bases.get("root") == p or not exact:
            # the root of a corpus whose working directory was narrowed (a second sidecar naming the root would make
            # the mapping ambiguous), or inside (not at) a registered directory without `exact`: that corpus, nothing
            # written
            return {"name": kname, "root": str(bases.get("root", kbase)), "path": str(corpus_dir(kname)),
                    "registered_at": rec.get("registered_at"), "manifest": corpus_manifest(kname)}
        # inside (not at) a registered directory with `exact`: the folder becomes a corpus of its own
    name = prev["name"] if prev else free_name(corpus_name_for(p))
    # the working directory again: the root stays what the first registration recorded
    root = str(_sidecar_bases(prev).get("root", p)) if prev is not None else str(p)
    rec = {"name": name, "root": root, "path": str(p), "registered_at": (prev or {}).get("registered_at") or _now(),
           "manifest": _scan_manifest(p)}
    _write_sidecar(rec)
    log.info("registered corpus %r at %s (sidecar %s)", name, p, sidecar_path(name))
    return rec


def _scan_manifest(p: Path) -> dict:
    """The directory's own manifest.json when it has a readable object one, else {name: <basename>, description: ""}."""
    mf = p / "manifest.json"
    if mf.is_file():
        try:
            loaded = json.loads(mf.read_text("utf-8"))
            if isinstance(loaded, dict):
                return loaded
        except (OSError, ValueError):
            pass
    return {"name": p.name, "description": ""}


def _write_sidecar(rec: dict) -> None:
    """DATA_DIR/<name>.corpus.json, written atomically."""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    target = sidecar_path(rec["name"])
    # a temp of the writer's own (ledger._own_tmp's rule, inlined: ledger imports this module): two sessions
    # registering the same folder at once never share one
    fd, tmp = tempfile.mkstemp(prefix=f".{target.name}.", suffix=".tmp", dir=str(DATA_DIR))
    os.close(fd)
    try:
        Path(tmp).write_text(json.dumps(rec, indent=1, ensure_ascii=False) + "\n", "utf-8")
        os.replace(tmp, target)
    except BaseException:  # a failed write (a folder name that is not valid text, a full disk) leaves no temp behind
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _registry_holds(data_dir: Path, name: str) -> str | None:
    """The folder the registry `data_dir` maps `name` to — a corpus directory of that name, else the path a sidecar
    records (the sidecar itself, marked unreadable, when it does not parse) — or None when the name is free."""
    if (data_dir / name / "manifest.json").is_file():
        return str(data_dir / name)
    sidecar = data_dir / f"{name}{SIDECAR_SUFFIX}"
    if not sidecar.exists():
        return None
    try:
        cur = json.loads(sidecar.read_text("utf-8"))
    except (OSError, ValueError):
        cur = None
    return cur["path"] if isinstance(cur, dict) and isinstance(cur.get("path"), str) else f"{sidecar} (unreadable)"


def migrate_registry(data_dir: Path | None = None, legacy: Path | None = None,
                     workspaces: Path | None = None) -> list[Path]:
    """At server start: bring the records the install tree's data/ (`legacy`) holds into the registry `data_dir`, so every
    folder the install knew stays mapped. Idempotent: writes only names `data_dir` does not have, and only for names with a
    workspace under `workspaces` (a record with no workspace holds no state, and would take the name from the analyst's own
    folder of that name). A name held for another folder is skipped with a warning. Runs only when `data_dir` is
    $THIMBLE_HOME/data and `legacy` is another, existing directory. Returns the paths written."""
    target = (DATA_DIR if data_dir is None else Path(data_dir)).resolve()
    source = (LEGACY_DATA_DIR if legacy is None else Path(legacy)).resolve()
    ws_root = (WORKSPACES_DIR if workspaces is None else Path(workspaces)).resolve()
    if target != default_data_dir() or source == target or not source.is_dir():
        return []
    try:
        entries = sorted(source.iterdir())
    except OSError:
        return []
    written: list[Path] = []
    for entry in entries:
        if entry.name.endswith(SIDECAR_SUFFIX) and entry.is_file():
            name = entry.name[: -len(SIDECAR_SUFFIX)]
            try:
                text = entry.read_text("utf-8")
                rec = json.loads(text)
            except (OSError, ValueError):
                continue
            if not isinstance(rec, dict) or not isinstance(rec.get("path"), str):
                continue
            folder = rec["path"]
            what = f"copied the registration of {folder}"
        elif entry.is_dir() and (entry / "manifest.json").is_file():
            name = entry.name
            folder = str(entry)
            text = json.dumps({"name": name, "root": folder, "path": folder, "registered_at": _now(),
                               "manifest": _scan_manifest(entry)}, indent=1, ensure_ascii=False) + "\n"
            what = f"registered the corpus directory {entry}"
        else:
            continue
        if not _valid_name(name) or not (ws_root / name).is_dir():
            continue
        held = _registry_holds(target, name)
        if held is not None:
            if Path(held).expanduser().resolve() != Path(folder).expanduser().resolve():
                log.warning("registry: the name %r in %s is held for %s; the record for %s in %s was not brought along "
                            "(a /thimble there registers the folder under the next free name)", name, target, held, folder, source)
            continue
        target.mkdir(parents=True, exist_ok=True)
        dest = target / f"{name}{SIDECAR_SUFFIX}"
        fd, tmp = tempfile.mkstemp(prefix=f".{dest.name}.", suffix=".tmp", dir=str(target))
        os.close(fd)
        Path(tmp).write_text(text, "utf-8")
        os.replace(tmp, dest)
        log.info("registry: %s as %r in %s (from %s)", what, name, target, source)
        written.append(dest)
    return written


def workspace_path(name: str) -> Path:
    """Where a corpus's analyst state lives, validated (corpus_dir raises for a bad or missing corpus) and NOT created:
    a read (the holdings and instructions GETs) never leaves an empty workspace dir behind."""
    corpus_dir(name)
    return WORKSPACES_DIR / name


def private_dir(p: Path) -> Path:
    """`p`, made if missing, readable by its owner alone (0700), since it holds what thimble read and wrote; the folders
    above it are made as usual."""
    p.parent.mkdir(parents=True, exist_ok=True)
    p.mkdir(mode=0o700, exist_ok=True)
    try:
        if p.stat().st_mode & 0o077:
            os.chmod(p, 0o700)
    except OSError:  # a folder of another owner keeps its mode
        pass
    return p


def workspace_dir(name: str) -> Path:
    """workspace_path, created on demand, private (private_dir): for the writers."""
    p = workspace_path(name)
    if not p.is_dir():
        private_dir(WORKSPACES_DIR)
        p.mkdir(mode=0o700, exist_ok=True)
    return p


def safe_corpus_path(corpus: Path, rel: str) -> Path:
    """Resolve a corpus-relative path and refuse anything outside the corpus dir."""
    p = (corpus / rel).resolve()
    if corpus not in p.parents and p != corpus:
        # a link the corpus holds that points outside it gets its own sentence, since the file is listed in Files
        lexical = Path(os.path.normpath(corpus / rel))
        if corpus in lexical.parents:
            raise ValueError(f"path escapes corpus: {rel!r} is a link to {p}, outside the corpus folder, and thimble "
                             "opens only files inside the folder it was started in (Claude can still read it in the "
                             "terminal)")
        raise ValueError(f"path escapes corpus: {rel!r}")
    return p


# --------------------------------------------------------------------------- models per role
#
# Every role that runs a model, with its model, effort and fast mode. main is the analyst's own session: its model is the
# session's, and the composer chip's effort and fast mode for it are kept as settings.json `models.main` and applied at
# its next launch (cli.launch_args), so main is not a role here. Every other role is set in thimble's config
# (userconf: `agents.<agent>.model`, `effort` and `fast`, userconf.ROLES naming each agent's role), applied to the next
# session:
#   orient     the orientation's session (orient_session)
#   subagents  the orientation's subagents and workflow agents (CLAUDE_CODE_SUBAGENT_MODEL); by default the
#              orientation's model without the 1M tag, at its effort and speed
#   critic     a critique's session (critique_session)
#   writer     a writer's session (write_session)
#   checks     each run of a report check (checks.py)
#   verify     the card check's reading of a card's picture (card_check)
#   labels     the labels classifier (concepts)
#   dev        a dev ticket's session (dev.py)
# Layered: the role's default (ROLE_MODELS_DEFAULT; an agent file's frontmatter, ROLE_AGENTS; for the orientation the
# analyst's own settings, else ORIENT_DEFAULT_MODEL at ORIENT_DEFAULT_EFFORT), then THIMBLE_<ROLE>_MODEL / _EFFORT / _FAST,
# then thimble's config. Every role resolves to a model id (exact_model); the orientation's carries `[1m]` where
# the model has a 1M-token window (long_context). An effort of '' is the level of the session the agent runs in. `fast`
# is kept only on a model that has fast mode, and only for ROLES_WITH_FAST.
MODEL_ROLES = ("orient", "subagents", "critic", "writer", "checks", "verify", "labels", "dev")
ROLE_MODELS_DEFAULT: dict[str, dict[str, Any]] = {
    "subagents": {"model": "", "effort": "", "fast": False},  # '' is the orientation's model (models_for)
    "labels": {"model": "claude-opus-5-5", "effort": "low", "fast": False},
    "dev": {"model": "claude-opus-5-5", "effort": "high", "fast": True},
    "verify": {"model": "claude-opus-5-5", "effort": "high", "fast": True},
}
ORIENT_DEFAULT_MODEL = "claude-opus-5-5"  # the orientation's model when the analyst's own settings name none
# Claude Code's model aliases and the ids they stand for, as Claude Code 2.1.282 resolves them. A role whose model is an
# alias is kept as the id, so the popover names the version and the session runs the model shown.
MODEL_ALIASES = {"opus": "claude-opus-5-5", "sonnet": "claude-sonnet-5", "haiku": "claude-haiku-4-5-20251001"}
# The agent file a role's defaults come from: prompts/<name>.md (prompts.AGENT_FILES), or a plugin agent's file
# (plugin/agents/<name>.md) for `plugin:<name>`.
ROLE_AGENTS: dict[str, str] = {"critic": "critic", "writer": "writer", "checks": "check"}
PLUGIN_AGENTS_DIR = REPO_ROOT / "plugin" / "agents"
# `verify` is here because its card check is a call the server makes, which runs at its own speed; without it models_for
# would turn its fast mode off
ROLES_WITH_FAST = ("orient", "critic", "writer", "checks", "labels", "dev", "verify")
ROLE_EFFORTS = ("low", "medium", "high", "xhigh", "max")  # the levels Claude Code takes (cc_settings.EFFORTS)
ORIENT_EFFORTS = (*ROLE_EFFORTS, "ultracode")  # the orientation also runs with Ultracode (orient_session)
# The orientation's effort until the analyst picks one for its role, whatever their own Claude Code settings name.
ORIENT_DEFAULT_EFFORT = "ultracode"
SUBAGENT_MODEL_ENV = "CLAUDE_CODE_SUBAGENT_MODEL"
MODELS_KEY = "models"  # settings.json: models.main
# The models with a 1M-token context window, as parts of their ids; Claude Code gives a model id with `[1m]` after it
# that window. Haiku has none.
LONG_CONTEXT_MODELS = ("opus-5", "opus-4-8", "opus-4-7", "opus-4-6", "sonnet-5", "sonnet-4-6", "sonnet-4-5", "fable-5")


def role_efforts(role: str) -> tuple[str, ...]:
    """The efforts a role takes: the levels, Ultracode for the orientation, and '' (the session's) for a subagent."""
    if role == "orient":
        return ORIENT_EFFORTS
    return ("", *ROLE_EFFORTS) if role == "subagents" else ROLE_EFFORTS


def exact_model(model: str) -> str:
    """`model` with an alias written as the id it stands for (MODEL_ALIASES), a `[1m]` tag kept: `opus[1m]` is
    `claude-opus-5-5[1m]`. Any other name is returned as it is."""
    m = (model or "").strip()
    core, sep, tag = m.partition("[")
    full = MODEL_ALIASES.get(core.lower())
    return f"{full}{sep}{tag}" if full else m


def base_model(model: str) -> str:
    """`model` without a `[…]` tag: `claude-opus-5-5[1m]` is `claude-opus-5-5`."""
    return (model or "").strip().partition("[")[0]


def long_context(model: str) -> str:
    """`model` with Claude Code's `[1m]` tag when it has a 1M-token context window (LONG_CONTEXT_MODELS, matched in the
    id as FAST_MODE_MODELS are), else as it is; a model that carries a tag already keeps it."""
    m = (model or "").strip()
    if not m or "[" in m or not any(k in m.lower() for k in LONG_CONTEXT_MODELS):
        return m
    return f"{m}[1m]"


def agent_front(name: str) -> dict[str, Any]:
    """The frontmatter of an agent file (ROLE_AGENTS' names); {} when it cannot be read."""
    import yaml  # noqa: PLC0415 — only the agent files need it

    try:
        if name.startswith("plugin:"):
            text = (PLUGIN_AGENTS_DIR / f"{name.split(':', 1)[1]}.md").read_text("utf-8")
            head, sep, _ = text.removeprefix("---\n").partition("\n---\n")
            front = yaml.safe_load(head) if sep else None
        else:
            from . import prompts  # noqa: PLC0415 — prompts imports config

            front = prompts.agent_file(name)[0]
    except Exception:  # noqa: BLE001 — a missing or broken file leaves the role on Claude Code's own defaults
        return {}
    return front if isinstance(front, dict) else {}


def _analyst_cwd(c: str | None) -> Path:
    """The folder whose settings Claude Code would read for a session of `c`: its corpus folder; without one a path
    that holds none, so only the user's own settings count."""
    if c:
        try:
            return corpus_dir(c)
        except Exception:  # noqa: BLE001
            pass
    return Path(os.devnull)


def _analyst_default(c: str | None, key: str) -> Any:
    """What the analyst's own Claude Code settings say about `key` for a session in the corpus folder of `c` (the
    user's settings alone without one), the highest file that says anything winning; None when none does."""
    from . import cc_settings  # noqa: PLC0415 — cc_settings imports ledger, which imports config

    found = None
    for path in cc_settings.sources(_analyst_cwd(c)):
        d = cc_settings._read(path)
        if d.get(key) not in (None, ""):
            found = d[key]
    return found


def role_default(role: str, c: str | None = None) -> dict[str, Any]:
    """A role's model, effort and fast mode before the environment and the workspace's settings."""
    fast = model_speed() == "fast"
    if role == "orient":
        own_fast = _analyst_default(c, "fastMode")
        own_model = _analyst_default(c, "model")
        return {"model": str(own_model or ORIENT_DEFAULT_MODEL), "effort": ORIENT_DEFAULT_EFFORT,
                "fast": own_fast if isinstance(own_fast, bool) else fast}
    if role in ROLE_AGENTS:
        front = agent_front(ROLE_AGENTS[role])
        effort = str(front.get("effort") or "").strip().lower()
        return {"model": str(front.get("model") or "").strip(), "effort": effort if effort in role_efforts(role) else "",
                "fast": fast}
    return dict(ROLE_MODELS_DEFAULT[role])


def _env_role(role: str, base: dict[str, Any]) -> dict[str, Any]:
    out = dict(base)
    up = role.upper()
    m = os.environ.get(f"THIMBLE_{up}_MODEL", "").strip()
    if m:
        out["model"] = m
    e = os.environ.get(f"THIMBLE_{up}_EFFORT", "").strip().lower()
    if e and e in role_efforts(role):
        out["effort"] = e
    f = os.environ.get(f"THIMBLE_{up}_FAST", "").strip().lower()
    if f:
        out["fast"] = f not in ("0", "false", "no", "off")
    return out


def _configured(c: str | None) -> dict[str, dict[str, Any]]:
    """{role: {model, effort, fast}} as thimble's config sets them for workspace `c`, each field it leaves unset left
    out; the orientation subagents' model under `subagents`. A config with an error sets none (userconf.load_or_defaults)."""
    from . import userconf  # noqa: PLC0415 — userconf imports this module

    agents = userconf.load_or_defaults(c)[0]["agents"]
    out: dict[str, dict[str, Any]] = {}
    for name, role in userconf.ROLES.items():
        out[role] = {k: agents[name][k] for k in ("model", "effort", "fast") if agents[name].get(k) is not None}
    sub = agents["orientation"].get("subagentModel")
    out["subagents"] = {"model": sub} if sub else {}
    return out


def chosen(c: str | None, role: str) -> set[str]:
    """The fields of a role (model, effort, fast) set for workspace `c` in thimble's config or with
    THIMBLE_<ROLE>_MODEL / _EFFORT / _FAST, as models_for reads them."""
    out = set(_configured(c).get(role) or {})
    env = {f for f in ("model", "effort", "fast") if os.environ.get(f"THIMBLE_{role.upper()}_{f.upper()}", "").strip()}
    return out | env


def models_for(c: str | None = None) -> dict[str, dict[str, Any]]:
    """{role: {model, effort, fast}} for a workspace, every role of MODEL_ROLES: its default under the environment under
    thimble's config. The orientation's default reads the analyst's settings for the folder of `c` when it is given."""
    over = _configured(c)
    out: dict[str, dict[str, Any]] = {}
    for role in MODEL_ROLES:
        conf = _env_role(role, role_default(role, c))
        conf.update(over.get(role) or {})
        if role == "subagents" and not conf["model"]:
            conf["model"], conf["follows"] = base_model(out["orient"]["model"]), "orient"
        conf["model"] = exact_model(conf["model"])
        if role == "orient":
            conf["model"] = long_context(conf["model"])
        conf["fast"] = role in ROLES_WITH_FAST and bool(conf.get("fast")) and has_fast_mode(conf["model"])
        out[role] = conf
    return out
