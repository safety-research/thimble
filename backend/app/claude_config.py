"""A Claude Code config dir of thimble's own (workspaces/<c>/.claude-config) with the CLI's login reachable from it.

Without an API key the CLI authenticates with the credentials file in its config dir. link_credentials links the login
file into the dir (copying a rotated token back first, so every dir keeps a valid pair); seed_account copies the account
and model-entitlement cache, without which the CLI refuses the requested model. Nothing here logs a file's contents.

On macOS the login lives in the Keychain under an item named for the config dir, so a CLI in a dir of thimble's own
finds no login. login_linkable tells the cases apart; agents.call_env then runs model calls in the served config dir.
"""
from __future__ import annotations

import json
import logging
import os
import tempfile
from pathlib import Path

from . import config

log = logging.getLogger("thimble.claude_config")

CREDENTIALS = config.CREDENTIALS_FILE  # where the CLI keeps its OAuth tokens inside its config dir
# Account state the CLI needs to know which models it may use. Everything else in its .claude.json (the project list,
# onboarding flags, prompt history) stays out of an analyst session.
ACCOUNT_KEYS = ("oauthAccount", "userID", "modelAccessCache", "orgModelDefaultCache")


def default_config_dir() -> Path:
    """The config dir of the Claude Code thimble serves (config.claude_config_dir): where the login file is."""
    return config.claude_config_dir()


def link_credentials(cfg: Path, who: str) -> None:
    """Make the CLI's own credentials reachable from `cfg` when there is no API key (module docstring). `who` names the
    caller in the log. A regular file at the link's path is synced back to the login first; the
    path is a symlink again afterwards. Never raises: a failure is one warning line."""
    if config.HAS_API_KEY:
        return
    if config.api_key_helper() is not None:
        # the CLI runs the user's apiKeyHelper itself, so the login file is not what authenticates
        return
    if config.oauth_token_set():
        return
    src, link = default_config_dir() / CREDENTIALS, cfg / CREDENTIALS
    try:
        if src.resolve() == link.resolve():  # the default config dir IS this dir
            return
        if link.is_file() and not link.is_symlink():
            sync_rotated_credentials(who, src, link)
        if not src.is_file():
            log.warning("%s: no env credential, no apiKeyHelper in the Claude settings and no %s "
                        "(the CLI will report it is not logged in)", who, src)
            return
        if link.is_symlink() and link.resolve() == src.resolve():
            return
        if link.exists() or link.is_symlink():
            link.unlink()
        link.symlink_to(src)
        log.info("%s: linked the CLI credentials %s into %s (no API key; running on its own auth)", who, src, cfg)
    except OSError as e:
        log.warning("%s: could not link %s into %s: %s", who, src, cfg, e)


def login_linkable() -> bool:
    """Whether a CLI in a config dir of thimble's own authenticates: an env credential, an apiKeyHelper or
    CLAUDE_CODE_OAUTH_TOKEN (the CLI resolves each wherever it runs), or a login file link_credentials links in. False for
    a login kept only in the macOS Keychain (module docstring), and when there is no login at all. Reads no secret."""
    if config.HAS_API_KEY or config.api_key_helper() is not None or config.oauth_token_set():
        return True
    try:
        return (default_config_dir() / CREDENTIALS).is_file()
    except OSError:
        return False


USER_SETUP = ("CLAUDE.md", "skills")  # what of the analyst's own config dir a thimble session inherits (link_user_setup)


def link_user_setup(cfg: Path, who: str) -> None:
    """Link the analyst's own CLAUDE.md and skills/ (USER_SETUP, from default_config_dir()) into `cfg`, each when it
    exists, so a session built with `setting_sources=["user"]` on `cfg` reads their instructions and skills and nothing
    else of theirs: settings.json (hooks under bypassPermissions), plugins and memory stay out because they are not
    linked. A link that points elsewhere or dangles is replaced; a regular file of the same name is left alone. Never
    raises: a failure is one warning line."""
    src_dir = default_config_dir()
    try:
        if src_dir.resolve() == cfg.resolve():  # the default config dir IS this dir
            return
    except OSError:
        return
    for name in USER_SETUP:
        src, link = src_dir / name, cfg / name
        try:
            if not src.exists():
                continue
            if link.is_symlink():
                if link.resolve() == src.resolve():
                    continue
                link.unlink()
            elif link.exists():
                continue
            link.symlink_to(src)
            log.info("%s: linked %s into %s", who, src, cfg)
        except OSError as e:
            log.warning("%s: could not link %s into %s: %s", who, src, cfg, e)


def sync_back(cfg: Path, who: str) -> None:
    """link_credentials once a CLI in `cfg` has ended, so a token it rotated reaches the login file now rather than at
    the next call in that dir, which may never come. Never raises."""
    try:
        if not cfg.is_dir():
            return
    except OSError:
        return
    link_credentials(cfg, who)


def _has_tokens(data: bytes) -> bool:
    """Whether a credentials blob carries an OAuth token. A file with neither token is what the CLI leaves after a failed
    login or refresh, and copying it over the login would log every session out."""
    try:
        o = json.loads(data).get("claudeAiOauth")
    except (ValueError, TypeError):
        return False
    return isinstance(o, dict) and bool(o.get("accessToken") or o.get("refreshToken"))


def _write_login(src: Path, data: bytes, atime_ns: int, mtime_ns: int) -> None:
    """`data` over `src` atomically, mode 0600, stamped with the rotation's own times so a later rotation elsewhere
    still compares newer. Raises OSError; the temp file is removed then."""
    src.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(dir=src.parent, prefix=src.name + ".")
    tmp = Path(tmp_name)
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
            fh.flush()
            os.fsync(fh.fileno())
        os.chmod(tmp, 0o600)
        os.utime(tmp, ns=(atime_ns, mtime_ns))
        os.replace(tmp, src)
    except OSError:
        try:
            tmp.unlink()
        except OSError:
            pass
        raise


def sync_rotated_credentials(who: str, src: Path, copy: Path) -> None:
    """`copy` is a regular file where the symlink to `src` was (a CLI rotated the token and renamed a new file over
    the link). Copy it over `src` when `src` is missing, or when `copy` is newer and its bytes differ; leave `src`
    alone when `copy` is older or identical. The write is _write_login's (atomic, 0600, the rotation's own mtime).
    Contents are compared and copied, never logged. The caller re-links."""
    data = copy.read_bytes()
    cst = copy.stat()
    if not _has_tokens(data):  # a failed login/refresh, not a real rotation: never overwrite the login with it
        log.warning("%s: %s holds no OAuth token (a failed login or refresh wrote it); kept %s and re-linking", who, copy, src)
        return
    if src.is_file():
        if data == src.read_bytes():
            log.info("%s: %s held a copy identical to %s; re-linking", who, copy, src)
            return
        if cst.st_mtime_ns <= src.stat().st_mtime_ns:
            log.info("%s: %s held an older copy than %s; dropped, re-linking", who, copy, src)
            return
    _write_login(src, data, cst.st_atime_ns, cst.st_mtime_ns)
    log.info("%s: a CLI rotated the token in %s; copied it back over %s (mode 600)", who, copy, src)


def seed_account(cfg: Path, who: str) -> None:
    """Copy the account and model-entitlement cache (ACCOUNT_KEYS) from the CLI's own state file into `cfg`/.claude.json
    when that file does not exist yet (no API key only). A config dir with credentials but no entitlement cache makes
    the CLI refuse the requested model outright on its first call, and substitute silently on later ones."""
    if config.HAS_API_KEY:
        return
    dst = cfg / ".claude.json"
    if dst.exists():
        return
    try:
        state = json.loads(config.cli_state_file().read_text("utf-8"))
    except Exception as e:  # noqa: BLE001 — no state to seed is not an error
        log.info("%s: no CLI account state to seed (%s)", who, e)
        return
    seed = {k: state[k] for k in ACCOUNT_KEYS if k in state}
    if not seed:
        return
    try:
        dst.write_text(json.dumps(seed, indent=1), "utf-8")
        log.info("%s: seeded %s with the account and model entitlements", who, dst)
    except OSError as e:
        log.warning("%s: could not seed %s: %s", who, dst, e)
