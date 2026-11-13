"""Paths, the `claude` thimble runs and its environment, corpora, model defaults."""
from __future__ import annotations

import errno
import hashlib
import json
import logging
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping

log = logging.getLogger("thimble.config")

REPO_ROOT = Path(__file__).resolve().parent.parent.parent


def git_dir(root: Path | None = None) -> Path | None:
    """The `.git` (a folder, or a worktree's file) of the git checkout thimble's browser folder `root` (REPO_ROOT) is
    part of: its own, or that of the repository that holds it as `browser/` beside the terminal plugin's `plugin/`, as
    thimble's repository does. None in a copy that is no checkout, such as an installed release; never the git folder
    of some repository further up that only happens to hold the copy."""
    root = REPO_ROOT if root is None else root
    if (root / ".git").exists():
        return root / ".git"
    top = root.parent
    if root.name == "browser" and (top / "plugin").is_dir() and (top / ".git").exists():
        return top / ".git"
    return None


# new for every start of the server's code, an execv restart and a reload among them: /api/health carries it, so the
# watch over a restart (restart_watch.py) tells the restarted server from the one before it
BOOT_ID = os.urandom(4).hex()


def checkout_head(root: Path | None = None) -> str:
    """The commit the git checkout that holds thimble's browser folder `root` (REPO_ROOT) is at; '' in a copy that is no
    checkout (git_dir), such as an installed release, and when git gives none."""
    if git_dir(root) is None:
        return ""
    try:
        p = subprocess.run(["git", "-c", "core.hooksPath=/dev/null", "--no-optional-locks", "-C",
                            str(REPO_ROOT if root is None else root), "rev-parse", "-q", "--verify", "HEAD^{commit}"],
                           capture_output=True, text=True, timeout=30, check=False)
    except (OSError, subprocess.TimeoutExpired):
        return ""
    return p.stdout.strip() if p.returncode == 0 else ""


# the commit the server's code was at when it started, '' in a copy that is no checkout: a fix that went on after it is
# not in the code this server runs until it starts again (fixes.not_here)
BOOT_COMMIT = checkout_head()
# opens thimble's requests to its own server on 127.0.0.1 without any proxy the shell sets (HTTP_PROXY and the like):
# urllib would send them to that proxy unless no_proxy names the host
LOOPBACK = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def default_data_dir() -> Path:
    """$THIMBLE_HOME/data (THIMBLE_HOME, else ~/.thimble): where the registry of folders lives (the sidecars
    <name>.corpus.json that map a registered folder to its workspace), outside the install tree. THIMBLE_DATA_DIR
    overrides it. Read fresh from the environment, so cli.resolve_env's default and a test's THIMBLE_HOME agree."""
    return (Path(os.environ.get("THIMBLE_HOME") or "~/.thimble").expanduser() / "data").resolve()


DATA_DIR = Path(os.environ.get("THIMBLE_DATA_DIR") or default_data_dir()).resolve()
WORKSPACES_DIR = Path(os.environ.get("THIMBLE_WORKSPACES_DIR") or REPO_ROOT / "workspaces").resolve()
# The built UI (frontend/dist). main.py serves it at / when the server is not in dev mode (a release install has no
# Vite); the server's start and cli.py's doctor print NO_UI_BUILD_HINT when it is missing. Tests point FRONTEND_DIST at
# a scratch dir.
FRONTEND_DIST = Path(os.environ.get("THIMBLE_FRONTEND_DIST") or REPO_ROOT / "frontend" / "dist").resolve()
NO_UI_BUILD_HINT = "no frontend build: run npm run build in frontend/, or start with THIMBLE_DEV=1"
# how a person restarts the server in this version: thimble-browser holds it until Ctrl-C, and --continue brings the
# folder's latest session back (the texts that say to restart it: cli, notices, main)
RESTART_HOW = "press Ctrl-C in the terminal that runs thimble-browser, then run `thimble-browser --continue`"


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


# the models Claude Code runs with no effort (spike m6, Claude Code's documented behaviour): a call on one passes none.
# Haiku 4.5 and the Claude 3 Haikus; Haiku 5.5 is the first Haiku with effort levels (plugin/core/models.js).
NO_EFFORT_MODELS = ("haiku-4", "3-5-haiku", "3-haiku")


def has_effort(model: str | None) -> bool:
    """Whether Claude Code runs `model` at an effort (NO_EFFORT_MODELS, matched in the id as FAST_MODE_MODELS are)."""
    m = (model or "").lower()
    return bool(m) and not any(k in m for k in NO_EFFORT_MODELS)


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


def linked(path: Path) -> bool:
    """Whether the file at `path` is a symbolic link or has more than one hard link, so that another name can change it.
    A workspace's settings.json and config.json are hidden from the kernel by name (kernel_wrap.HIDDEN_FILES), so the
    server reads no settings from such a file."""
    try:
        st = os.lstat(path)
    except OSError:
        return False
    return stat.S_ISLNK(st.st_mode) or st.st_nlink > 1


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
    from . import kernel_wrap, srt  # noqa: PLC0415

    if kernel_wrap.srt_works(srt.node(), srt.package(REPO_ROOT)):
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


def keep_local_off_proxy(env: dict[str, str] | None = None) -> None:
    """Add 127.0.0.1 and localhost to NO_PROXY / no_proxy in `env` (default os.environ), so that thimble's calls to its
    own server on 127.0.0.1 never go through an HTTP proxy the shell sets. urllib and httpx read these variables, and
    every process thimble starts inherits them."""
    env = os.environ if env is None else env
    for name in ("NO_PROXY", "no_proxy"):
        cur = env.get(name, "")
        if "127.0.0.1" not in [x.strip() for x in cur.split(",")]:
            env[name] = f"{cur},127.0.0.1,localhost" if cur else "127.0.0.1,localhost"


keep_local_off_proxy()


# The CLAUDE_* variables a `claude` thimble starts takes from this process: those naming the config dir, a provider, a
# network setting (a proxy, a certificate, the client certificate's CLIENT_* among them, or an LLM gateway) and every
# one Claude Code reads to sign in, so the child signs in as the analyst's session does and keeps its tokens where
# that session keeps them: the federation token cache, the credential store (its folder, the Windows credential
# manager, the refresh lock), OAuth (its endpoints, client ids and timing), the account, organization and plan of a
# token given in the environment, the cloud providers' credential settings, a host's credentials file and provider,
# and the managed settings files, which can choose the login. Every other one (CLAUDECODE, CLAUDE_CODE_SESSION_ID,
# CLAUDE_CODE_ENTRYPOINT and the rest of the calling session's identity) stays out, as do the calling cloud session's
# own tokens (CLAUDE_CODE_SESSION_ACCESS_TOKEN, CLAUDE_SESSION_INGRESS_TOKEN_FILE) and the variables that say an SDK
# host refreshes the login (CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH, CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH and its timeout):
# that host answers main alone, and Claude Code also drops the first from the sessions it starts in the background. A
# variable naming a file descriptor stays out too, since the server starts with its descriptors closed. Variables
# that do not start with CLAUDE (ANTHROPIC_*, AWS_*, HTTPS_PROXY, NODE_EXTRA_CA_CERTS, …) pass.
_CLAUDE_PASS = re.compile(r"CLAUDE_CONFIG_DIR|CLAUDE_SECURESTORAGE_CONFIG_DIR|CLAUDE_TRUSTED_DEVICE_TOKEN|"
                          r"CLAUDE_LOCAL_OAUTH_(API|APPS|CONSOLE)_BASE|"
                          r"CLAUDE_CODE_(USE_\w+|SKIP_\w+_AUTH|SKIP_AWS_CRED_CACHE|AWS_CHAIN_RESOLVE_TIMEOUT_MS|"
                          r"OAUTH_(TOKEN|REFRESH_TOKEN|SCOPES|CLIENT_ID|401_WAIT_MS)|CUSTOM_OAUTH_URL|"
                          r"DESIGN_OAUTH_CLIENT_ID|AUTH_FAIL_EXIT_MS|FEDERATION_CACHE_DIR|FORCE_WINDOWS_CREDMAN|"
                          r"DISABLE_AUTH_REFRESH_LOCK|ACCOUNT_UUID|ACCOUNT_TAGGED_ID|ORGANIZATION_UUID|USER_EMAIL|"
                          r"SUBSCRIPTION_TYPE|RATE_LIMIT_TIER|HFI_BEARER_TOKEN|PROVIDER_MANAGED_BY_HOST|HOST_CREDS_FILE|"
                          r"HOST_AUTH_ENV_VAR|HOST_GATEWAY_LINEAGE|MANAGED_SETTINGS_PATH|REMOTE_SETTINGS_PATH|"
                          r"CLIENT_\w+|API_KEY_HELPER_TTL_MS|DISABLE_NONESSENTIAL_TRAFFIC|"
                          r"HTTPS?_PROXY|PROXY_(URL|AUTHENTICATE|AUTH_HELPER_TTL_MS|RESOLVES_HOSTS)|ENABLE_PROXY_AUTH_HELPER|"
                          r"CERT_STORE|GATEWAY_TOKEN|API_BASE_URL|ASSUME_FIRST_PARTY_BASE_URL|DISABLE_EXPERIMENTAL_BETAS)")


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
    launch_environ()), in the folder `cwd` (a temporary one when it is none): loggedIn, authMethod,
    apiKeySource, apiProvider and the like. None when `claude` is missing, the command fails to print an object, or
    under THIMBLE_SKIP_KEY. loggedIn means a login is configured, not that it works."""
    if _skip() or not CLI_PATH:
        return None
    try:
        r = subprocess.run([CLI_PATH, "auth", "status", "--json"], capture_output=True, text=True,
                           env=dict(env) if env is not None else launch_environ(),
                           cwd=str(cwd) if cwd and Path(cwd).is_dir() else tempfile.gettempdir(),
                           stdin=subprocess.DEVNULL, timeout=AUTH_STATUS_TIMEOUT_S)
        d = json.loads(r.stdout)
    except (OSError, subprocess.SubprocessError, ValueError):
        return None
    return d if isinstance(d, dict) else None


# how to give Claude Code a login, for every "not logged in" message
AUTH_HELP = "log in with `claude auth login`"


def auth_problem() -> str:
    """The alert when a model call cannot run: what keeps the way to reach Claude the person chose from working
    (claude_access.problem_line), '' when nothing does."""
    from . import claude_access  # noqa: PLC0415

    return claude_access.problem_line()


# The default model of the `refusal` row (models_for): the model a structured call (model.structured) runs on again, once,
# when a safety classifier stopped its model's response (`stop_reason: refusal`). THIMBLE_FALLBACK_MODEL names another,
# '' turns the rerun off; Settings' refusal row does the same per workspace. A session thimble still runs itself
# (agent_session) reruns on this model.
FALLBACK_MODEL = os.environ.get("THIMBLE_FALLBACK_MODEL", "claude-opus-4-8").strip()
FALLBACK_EFFORT = "high"  # the refusal row's default effort


# Claude Code's config dir: CLAUDE_CONFIG_DIR, else ~/.claude (transcripts, sessions/<pid>.json, settings.json, the
# login). The one that counts is the one the served `claude` process runs with, which need not be this server's: once
# the mirror learns it (session._learn_config), claude_config_dir() answers with it (serve_claude_config), while this
# server's own CLAUDE_CONFIG_DIR is unchanged. Sessions this server
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


# A `claude` thimble runs has none of thimble's variables in its own environment (launch_environ), and a session
# thimble starts gets them in its --settings `env` (session_env), which reaches that session alone. There every name
# below that the session does not set is given this server's value or "", so a value meant for another session or
# another thimble never reaches it.
# The names thimble sets for one session: a THIMBLE_* one is "" unless the session sets it; another is the server's
# own value, else "".
SESSION_VARS = ("THIMBLE_SESSION", "THIMBLE_CALLER_CWD", "XDG_CACHE_HOME", "MPLCONFIGDIR",
                "CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD")
# The names that place a stack and tune its plugin and hooks, which the code a session runs reads: the server's value
# in a session that talks to this server (session_env's `stack`), else "". Every reader takes "" as unset.
STACK_VARS = ("THIMBLE_HOME", "THIMBLE_PORT", "THIMBLE_UI_PORT", "THIMBLE_WORKSPACES_DIR", "THIMBLE_DATA_DIR",
              "THIMBLE_DEV_DIR", "THIMBLE_PLUGIN_ROOT", "THIMBLE_FRONTEND_URL",
              "THIMBLE_FRONTEND_DIST", "THIMBLE_DEV", "THIMBLE_SUPERVISED", "THIMBLE_STACK_PORT",
              "THIMBLE_STACK_UI_PORT", "THIMBLE_CLAUDE_BIN", "THIMBLE_SKIP_KEY", "THIMBLE_PROMPTS_DIR",
              "THIMBLE_PROMPT_CAPTURE", "THIMBLE_KERNEL_WRAP", "THIMBLE_MODEL_SPEED",
              "THIMBLE_BROWSER_PATH", "THIMBLE_INDEX_CACHE_MB")
OWN_PREFIX = "THIMBLE_"


def launch_environ(environ: Mapping[str, str] | None = None) -> dict[str, str]:
    """The environment of every `claude` thimble runs: `environ` (default this process's) with only the variables that
    pass (passes), none of thimble's own, and the served CLAUDE_CONFIG_DIR (claude_env)."""
    return claude_env({k: v for k, v in passed_environ(environ).items() if not k.startswith(OWN_PREFIX)})


def session_env(own: Mapping[str, str], *, stack: bool = True,
                environ: Mapping[str, str] | None = None) -> dict[str, str]:
    """The --settings `env` of a session thimble starts: `own`, its own values, over every name of SESSION_VARS and
    STACK_VARS as the note above says. With `stack` the session also gets this process's other THIMBLE_* values."""
    env = os.environ if environ is None else environ
    out: dict[str, str] = {}
    if stack:
        out.update({k: v for k, v in env.items() if k.startswith(OWN_PREFIX) and k not in SESSION_VARS})
    for name in STACK_VARS:
        out[name] = env.get(name, "") if stack else ""
    for name in SESSION_VARS:
        out[name] = "" if name.startswith(OWN_PREFIX) else env.get(name, "")
    out.update(own)
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


OUT_OF_FILES = (errno.EMFILE, errno.ENFILE)  # a process, or the machine, at its limit of open files


def sidecar_path(name: str) -> Path:
    return DATA_DIR / f"{name}{SIDECAR_SUFFIX}"


def read_sidecar(name: str, data_dir: Path | None = None) -> dict | None:
    """The registration record {name, root, path, registered_at, manifest} of a registered corpus, else None: under
    DATA_DIR, or under `data_dir` for a caller that resolves the data folder itself (cli). A record without `root` reads
    root as the path. A process out of file descriptors raises (OUT_OF_FILES) rather than taking the corpus for one
    that is not registered."""
    if not _valid_name(name):
        return None
    try:
        path = sidecar_path(name) if data_dir is None else data_dir / f"{name}{SIDECAR_SUFFIX}"
        rec = json.loads(path.read_text("utf-8"))
    except OSError as e:
        if e.errno in OUT_OF_FILES:
            raise
        return None
    except ValueError:
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
    """The name a Claude Code session thimble starts goes by: main's (`claude -n`), as `claude agents`, the /resume
    picker and SendMessage's `to` know it, and each agent's in the agent tray: `thimble:<role> · <workspace>`,
    such as `thimble:main · logs-2` or `thimble:dev · logs-2`, since those lists hold the sessions of every
    folder, so two workspaces must not share a name; `thimble:<role>` alone for a session of no workspace (`thimble fix`'s code ticket). A name is at most
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
    # a session that runs beside the folder's own (add_session) names the same folder, which maps to the folder's own
    bases = [(rec, _sidecar_bases(rec)) for rec in recs if not rec.get(SESSION_OF)]
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


KEEP_SHOWN = object()  # register_corpus: leave the record's `shown` as it is


def shown_alias(shown: object, p: Path) -> str | None:
    """`shown` when it is another absolute path to the folder `p` (through a symlink), else None."""
    if not isinstance(shown, str) or not os.path.isabs(shown):
        return None
    alias = os.path.normpath(shown)
    try:
        return alias if alias != str(p) and Path(alias).resolve() == p else None
    except OSError:
        return None


def register_corpus(path: str | Path, *, exact: bool = False, shown: object = KEEP_SHOWN) -> dict:
    """Register a directory as a corpus and return its record {name, root, path, registered_at, manifest, shown?}.
    `shown` is the folder as the analyst named it when that was another path to it, through a symlink (shown_alias),
    which the dashboard shows in place of `path`: a string records it, None clears it, KEEP_SHOWN leaves it. A folder
    registered already keeps its own name.

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
    alias = shown_alias((prev or {}).get("shown"), p) if shown is KEEP_SHOWN else shown_alias(shown, p)
    if alias:
        rec["shown"] = alias
    _write_sidecar(rec)
    log.info("registered corpus %r at %s (sidecar %s)", name, p, sidecar_path(name))
    return rec


# --------------------------------------------------------------------------- a folder's sessions open at once
#
# Two shells can run thimble-browser in one folder at once, each on a session of its own (folder_sessions.py). Each such
# session is a workspace: the folder's own `c`, and `c.2`, `c.3` … for those that run beside it, each a sidecar like a
# registered folder's, which names the same folder and `session_of: c`. So every route, tool and kernel of each reads
# the folder's files, and what thimble keeps (its chats, cards, labels, documents and settings) is each workspace's own.
# Only `c` maps a path to its workspace (sidecar_match), so a folder opens as `c`, as before.

SESSION_OF = "session_of"


def session_of(name: str) -> str:
    """The workspace of the folder that workspace `name` is a session of (module note above): its sidecar's
    `session_of`, else `name` itself."""
    rec = read_sidecar(name) if _dir_corpus(name) is None else None
    of = rec.get(SESSION_OF) if rec else None
    return of if isinstance(of, str) and _valid_name(of) else name


def _session_number(c: str, name: str) -> int | None:
    m = re.fullmatch(rf"{re.escape(c)}\.([1-9][0-9]*)", name)
    return int(m.group(1)) if m and int(m.group(1)) >= 2 else None


def sessions_of(c: str) -> list[str]:
    """Folder workspace `c` and the workspaces of its sessions that run beside it (add_session), by number: `c`,
    `c.2`, `c.3` …"""
    found: list[tuple[int, str]] = []
    for rec in registered_corpora():
        n = _session_number(c, str(rec["name"]))
        if rec.get(SESSION_OF) == c and n is not None:
            found.append((n, str(rec["name"])))
    return [c, *(name for _, name in sorted(found))]


def session_number(name: str) -> int:
    """The number of workspace `name` among its folder's sessions (sessions_of): 1 for the folder's own."""
    return _session_number(session_of(name), name) or 1


def add_session(c: str, name: str | None = None) -> dict:
    """The record of a session of folder workspace `c` that runs beside the open one (module note above): `name` when
    it is one already, else a sidecar written under `name` (`c.<n>`, n >= 2) or, without one or when another corpus
    holds it, the next free `c.<n>`. Raises ValueError for a `c` that is no folder's workspace and for a `name` that is
    not of the form `c.<n>`."""
    if session_of(c) != c:
        raise ValueError(f"{c!r} is a session of {session_of(c)!r}, not a folder's workspace")
    here = corpus_dir(c)
    if name is not None:
        if _session_number(c, name) is None:
            raise ValueError(f"{name!r} is not a session of {c!r} (its name is {c}.<n>, n from 2)")
        if name in sessions_of(c):
            return read_sidecar(name) or {}
    if name is None or name_taken(name):
        n = 2
        while name_taken(f"{c}.{n}"):
            n += 1
        name = f"{c}.{n}"
    own = read_sidecar(c) if _dir_corpus(c) is None else None
    rec = {"name": name, "root": str((own or {}).get("root") or here), "path": str(here),
           "registered_at": _now(), "manifest": corpus_manifest(c), SESSION_OF: c}
    if own and own.get("shown"):
        rec["shown"] = own["shown"]
    _write_sidecar(rec)
    log.info("session %r of %r registered at %s", name, c, here)
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


def name_taken(name: str) -> bool:
    """Whether a corpus of DATA_DIR holds `name`: a corpus directory DATA_DIR/<name>, or a sidecar, readable or not."""
    return _dir_corpus(name) is not None or sidecar_path(name).exists()


def workspace_path(name: str) -> Path:
    """Where a corpus's analyst state lives, validated (corpus_dir raises for a bad or missing corpus) and NOT created:
    a read (the holdings and instructions GETs) never leaves an empty workspace dir behind."""
    corpus_dir(name)
    return WORKSPACES_DIR / name


def private_dir(p: Path, *, no_link: bool = False) -> Path:
    """`p`, made if missing, readable by its owner alone (0700), since it holds what thimble read and wrote; the folders
    above it are made as usual. `no_link` for a folder of a workspace, where a card's code can put a link or a file in
    its place (the kernels write the workspace): that is removed first, and the folder and those above it in the
    workspace are opened and their mode set as nofollow does (own_folder), never through a link, so nothing thimble does
    with `p` reaches the folder a link points to. thimble's later opens there go through nofollow too, so a link put
    there after this fails them rather than lead anywhere."""
    if no_link:
        from . import nofollow  # noqa: PLC0415

        os.close(nofollow.own_folder(p))
        return p
    p.parent.mkdir(parents=True, exist_ok=True)
    p.mkdir(mode=0o700, exist_ok=True)
    try:
        if p.stat().st_mode & 0o077:
            os.chmod(p, 0o700)
    except OSError:  # a folder of another owner keeps its mode
        pass
    return p


def workspace_dir(name: str) -> Path:
    """workspace_path, created on demand, private (private_dir): for the writers. A workspace made here has the files
    thimble's agents' hooks trust from the start (subagent_files.ensure), so no kernel starts before them."""
    p = workspace_path(name)
    if not p.is_dir():
        private_dir(WORKSPACES_DIR)
        p.mkdir(mode=0o700, exist_ok=True)
        from . import subagent_files  # noqa: PLC0415 — standard library only

        subagent_files.ensure(p)
    return p


def registry_dir(name: str) -> Path:
    """The workspace's registry folder, created on demand (private_dir): the web rules the analyst kept, which a
    wrapped kernel may only read (kernel_wrap.READ_ONLY_DIRS)."""
    from . import kernel_wrap  # noqa: PLC0415

    return private_dir(workspace_dir(name) / kernel_wrap.REGISTRY_DIR)


def temp_dir(name: str) -> Path:
    """The workspace's temp folder, created on demand (private_dir), never a link (`no_link`): on the Messages API the
    TMPDIR of every kernel and of main's and its thread forks' shell commands (kernel_wrap.TEMP_DIR, runtime.shell_temp),
    and a temp folder the citations' validator reads as the session's (marks)."""
    from . import kernel_wrap  # noqa: PLC0415

    return private_dir(workspace_dir(name) / kernel_wrap.TEMP_DIR, no_link=True)


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
# Every role that runs a model, with exactly the model and effort it runs on. main's model, effort and fast mode are the
# composer's, kept as settings.json `models.main` and read at main's next turn (runtime.Space.spec_of), so main is not
# a role here. Every other role is set in thimble's config
# (userconf: `agents.<agent>.model` and `effort`, and `fast` for a classifier and the dev row; userconf.ROLES naming
# each agent's role), applied to the next start:
#   orient     the orientation, a subagent of main (thimble:orientation)
#   subagents  the orientation's own subagents, which it starts as thimble:orient-helper; by default the orientation's model
#              without the 1M tag, at its effort
#   critic     the critic, a subagent of the orientation (thimble:critic)
#   writer     a writer, a subagent of main (thimble:writer)
#   checks     each run of a report check (thimble:check)
#   dev        a view build or review (thimble:view-builder, thimble:view-reviewer) and `thimble fix`'s session
#              (dev.py)
#   verify     the card check's reading of a card's picture (card_check), a classifier
#   labels     the labels classifier (concepts), the label draft and the view fit
#   suggest    the view proposals after a turn (proposer.py) and for a file type (views.suggest), a classifier
#   refusal    the model and effort a classifier's call runs on again once its model refused it (model.structured);
#              `off` turns the rerun off
# Layered: the role's default (ROLE_MODELS_DEFAULT; an agent file's frontmatter where it names one, ROLE_AGENTS; for the
# orientation the analyst's own model setting, else ORIENT_DEFAULT_MODEL, at ORIENT_DEFAULT_EFFORT), then
# THIMBLE_<ROLE>_MODEL / _EFFORT / _FAST, then thimble's config. Every role resolves to a model id (exact_model) and an
# effort, never '' (models_for); the orientation's model carries `[1m]` where the model has a 1M-token window
# (long_context). A stored `ultracode` (LEGACY_EFFORTS) runs at xhigh. `fast` is kept only on a model that has fast mode,
# and only for ROLES_WITH_FAST: the classifiers, and the dev row, for `thimble fix`, the one `claude -p` job of the
# server (dev.py), and for the row's agents, which the server runs itself: a view build and a review
# run with the row's fast mode (subagents.fast_for). A writer and a check have none. The dev row's fast mode has
# no default of its own: while neither THIMBLE_DEV_FAST nor thimble's config sets it, it is main's (main_fast), read
# when a job starts, and the row says so with `fast_follows: main`. Once the analyst sets it, on or off, it stays as
# set whatever main's is. Without a workspace there is no main: the unset row's `fast` is then None, which leaves
# `thimble fix` to the analyst's Claude Code settings (dev.py).
MODEL_ROLES = ("orient", "subagents", "critic", "writer", "checks", "verify", "labels", "dev", "suggest", "refusal")
ROLE_MODELS_DEFAULT: dict[str, dict[str, Any]] = {
    "subagents": {"model": "", "effort": "", "fast": False},  # '' is the orientation's model and effort (models_for)
    "critic": {"model": "claude-opus-5-5", "effort": "xhigh", "fast": False},
    "writer": {"model": "claude-opus-5-5", "effort": "xhigh", "fast": False},  # under prompts/writer.md's frontmatter
    "checks": {"model": "claude-opus-5-5", "effort": "high", "fast": False},  # under prompts/check.md's
    "labels": {"model": "claude-opus-5-5", "effort": "low", "fast": False},
    "dev": {"model": "claude-opus-5-5", "effort": "high", "fast": None},  # None: main's fast mode (models_for)
    "verify": {"model": "claude-opus-5-5", "effort": "high", "fast": True},
    "suggest": {"model": "claude-opus-5-5", "effort": "medium", "fast": False},
    "refusal": {"model": FALLBACK_MODEL, "effort": FALLBACK_EFFORT, "fast": False, "off": not FALLBACK_MODEL},
}
ORIENT_DEFAULT_MODEL = "claude-opus-5-5"  # the orientation's model when the analyst's own settings name none
# Claude Code's model aliases and the ids they stand for: `opus` as Claude Code 2.1.282 resolves it, `sonnet` and
# `haiku` as the plugin has them (plugin/core/models.js). A role whose model is an alias is kept as the id, so the
# popover names the version and the session runs the model shown.
MODEL_ALIASES = {"opus": "claude-opus-5-5", "sonnet": "claude-sonnet-5-5", "haiku": "claude-haiku-5-5"}
# The agent file a role's defaults come from: prompts/<name>.md (prompts.AGENT_FILES).
ROLE_AGENTS: dict[str, str] = {"writer": "writer", "checks": "check"}
# the classifiers, each a call the server makes, which runs at its own speed, and the dev row: its agents (a view's
# builder and reviewer) and `thimble fix`, the one `claude -p` job of the server (main's fast
# mode until the analyst sets the row's)
ROLES_WITH_FAST = ("labels", "verify", "suggest", "dev")
ROLE_EFFORTS = ("low", "medium", "high", "xhigh", "max")  # the levels Claude Code takes (cc_settings.EFFORTS)
# efforts earlier builds stored, read as the level they ran at: Ultracode ran at xhigh (cc_settings.ULTRACODE_EFFORT)
LEGACY_EFFORTS = {"ultracode": "xhigh"}
# The orientation's effort until the analyst picks one for its role, whatever their own Claude Code settings name:
# xhigh, the level Ultracode ran at (cc_settings.ULTRACODE_EFFORT), which is an ordinary effort now.
ORIENT_DEFAULT_EFFORT = "xhigh"
SUBAGENT_MODEL_ENV = "CLAUDE_CODE_SUBAGENT_MODEL"
MODELS_KEY = "models"  # settings.json: models.main
# The models with a 1M-token context window, as parts of their ids; Claude Code gives a model id with `[1m]` after it
# that window. Haiku has none.
LONG_CONTEXT_MODELS = ("opus-5", "opus-4-8", "opus-4-7", "opus-4-6", "sonnet-5", "sonnet-4-6", "sonnet-4-5", "fable-5")


def role_efforts(role: str) -> tuple[str, ...]:
    """The efforts a role takes: the levels Claude Code takes, for every role (a stored LEGACY_EFFORTS value is read as
    its level)."""
    return ROLE_EFFORTS


def effort_level(effort: Any) -> str:
    """A stored effort as the level it runs at: a level as it is, a LEGACY_EFFORTS value as its level, '' for anything
    else."""
    e = str(effort or "").strip().lower()
    return LEGACY_EFFORTS.get(e, e) if e in (*ROLE_EFFORTS, *LEGACY_EFFORTS) else ""


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


def same_model(a: str, b: str) -> bool:
    """Whether two names are of the same model: an alias as its id (exact_model), without a `[…]` tag or a date
    (`claude-haiku-4-5-20251001` is `claude-haiku-4-5`)."""
    def key(m: str) -> str:
        return re.sub(r"-\d{8}$", "", base_model(exact_model(m)))

    return bool(key(a)) and key(a) == key(b)


def long_context(model: str) -> str:
    """`model` with Claude Code's `[1m]` tag when it has a 1M-token context window (LONG_CONTEXT_MODELS, matched in the
    id as FAST_MODE_MODELS are), else as it is; a model that carries a tag already keeps it."""
    m = (model or "").strip()
    if not m or "[" in m or not any(k in m.lower() for k in LONG_CONTEXT_MODELS):
        return m
    return f"{m}[1m]"


CONTEXT_TOKENS = 200_000  # the context window of a model without a 1M-token one (LONG_CONTEXT_MODELS), as Haiku's
LONG_CONTEXT_TOKENS = 1_000_000


def context_tokens(model: str) -> int:
    """The context window, in tokens, of `model` (an alias read as its id) run on long_context(model):
    LONG_CONTEXT_TOKENS for a model with a 1M-token window, else CONTEXT_TOKENS."""
    return LONG_CONTEXT_TOKENS if long_context(exact_model(model)).lower().endswith("[1m]") else CONTEXT_TOKENS


def agent_front(name: str) -> dict[str, Any]:
    """The frontmatter of an agent file (ROLE_AGENTS' names); {} when it cannot be read."""
    try:
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
    if role == "orient":
        own_model = _analyst_default(c, "model")
        return {"model": str(own_model or ORIENT_DEFAULT_MODEL), "effort": ORIENT_DEFAULT_EFFORT, "fast": False}
    base = dict(ROLE_MODELS_DEFAULT[role])
    if role in ROLE_AGENTS:
        front = agent_front(ROLE_AGENTS[role])
        model, effort = str(front.get("model") or "").strip(), effort_level(front.get("effort"))
        base.update({"model": model} if model else {}, **({"effort": effort} if effort else {}))
    return base


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
    """{role: {model, effort, fast, off}} as thimble's config sets them for workspace `c`, each field it leaves unset
    left out; thimble:orient-helper's model and effort (the orientation's subagentModel and subagentEffort) under `subagents`. A
    config with an error sets none (userconf.load_or_defaults)."""
    from . import userconf  # noqa: PLC0415 — userconf imports this module

    agents = userconf.load_or_defaults(c)[0]["agents"]
    out: dict[str, dict[str, Any]] = {}
    for name, role in userconf.ROLES.items():
        out[role] = {k: agents[name][k] for k in ("model", "effort", "fast", "off") if agents[name].get(k) is not None}
    orient = agents["orientation"]
    out["subagents"] = {k: orient[key] for k, key in (("model", "subagentModel"), ("effort", "subagentEffort"))
                        if orient.get(key)}
    return out


def chosen(c: str | None, role: str) -> set[str]:
    """The fields of a role (model, effort, fast) set for workspace `c` in thimble's config or with
    THIMBLE_<ROLE>_MODEL / _EFFORT / _FAST, as models_for reads them."""
    out = set(_configured(c).get(role) or {})
    env = {f for f in ("model", "effort", "fast") if os.environ.get(f"THIMBLE_{role.upper()}_{f.upper()}", "").strip()}
    return out | env


def main_fast(c: str) -> bool:
    """Main's fast mode in workspace `c`, as the composer has it (settings.json `models.main.fast`, events._choose): off
    until the analyst turns it on, and off where the file holds none or cannot be read."""
    from . import nofollow  # noqa: PLC0415

    try:  # in the workspace, which a card's code writes: never read through a link left there (nofollow)
        held = json.loads(nofollow.read_text(workspace_path(c) / "settings.json"))
        return bool(held[MODELS_KEY]["main"]["fast"])
    except (OSError, ValueError, LookupError, TypeError):
        return False


def models_for(c: str | None = None) -> dict[str, dict[str, Any]]:
    """{role: {model, effort, fast}} for a workspace, every role of MODEL_ROLES: its default under the environment under
    thimble's config, with a full model id and an explicit effort, never '' (module note above): thimble:orient-helper's
    (`subagents`) take the orientation's where nothing sets them, with `follows: orient`, and a stored LEGACY_EFFORTS
    value its level. The dev row's fast mode is main's where nothing sets it, with `fast_follows: main`, and None
    without a workspace. The `refusal` row adds `off`. The orientation's default reads the analyst's settings for the
    folder of `c` when it is given."""
    over = _configured(c)
    out: dict[str, dict[str, Any]] = {}
    for role in MODEL_ROLES:
        conf = _env_role(role, role_default(role, c))
        conf.update(over.get(role) or {})
        conf["effort"] = effort_level(conf.get("effort"))
        if role == "subagents":
            if not conf["model"]:
                conf["model"], conf["follows"] = base_model(out["orient"]["model"]), "orient"
            conf["effort"] = conf["effort"] or out["orient"]["effort"]
        conf["model"] = exact_model(conf["model"]) or ROLE_MODELS_DEFAULT.get(role, {}).get("model") or ORIENT_DEFAULT_MODEL
        conf["effort"] = conf["effort"] or ROLE_MODELS_DEFAULT.get(role, {}).get("effort") or ORIENT_DEFAULT_EFFORT
        if role == "orient":
            conf["model"] = long_context(conf["model"])
        if role == "dev" and conf.get("fast") is None and c:
            # nothing sets the row's fast mode, so it is main's as it is now: the next job runs as main's next turn does
            conf["fast"], conf["fast_follows"] = main_fast(c), "main"
        if not (role == "dev" and conf.get("fast") is None):  # the unset dev row without a workspace stays None
            conf["fast"] = role in ROLES_WITH_FAST and bool(conf.get("fast")) and has_fast_mode(conf["model"])
        if role == "refusal":
            conf["off"] = bool(conf.get("off")) or not conf["model"]
        else:
            conf.pop("off", None)
        out[role] = conf
    return out


def call_settings(c: str | None, role: str) -> dict[str, Any]:
    """The model, effort and speed of a structured call (model.structured) made for `role` in workspace `c`, and the
    `refusal` row's model and effort it runs on again when its model refuses it (None when that row is off): the values
    models_for resolves and GET /settings reports, so a call takes none of them from the analyst's Claude Code settings.
    Every caller passes them all, and model.structured refuses a call without a model or an effort."""
    models = models_for(c)
    conf, again = models[role], models["refusal"]
    return {"model": str(conf["model"]), "effort": str(conf["effort"]),
            "speed": "fast" if conf.get("fast") else "standard",
            "refusal": None if again.get("off") else {"model": str(again["model"]), "effort": str(again["effort"])}}
