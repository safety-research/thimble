"""Workload Identity Federation from a config file the person names: `--wif FILE`, or the path in Settings.

The file is TOML, or plain KEY=VALUE lines. It holds the IDs that `WorkloadIdentityCredentials` takes:

    federation_rule_id   the federation rule (fdrl_...)                          required
    organization_id      the organization's UUID                                 required
    service_account_id   the service account (svac_...)                          optional
    workspace_id         the workspace (wrkspc_..., or "default")                optional

and where the identity token comes from, in `token_source`:

    google    a Google identity token for `audience` (by default https://api.anthropic.com), from the machine's
              metadata server or a Google service account's Application Default Credentials
    file      the token in `token_file`, read again on each refresh (Kubernetes, GitHub Actions and similar)
    command   what `token_command` prints, run again on each refresh

Without `token_source`, a `token_file` means file, a `token_command` means command, and otherwise it is google. The
SDK's environment-variable names (ANTHROPIC_FEDERATION_RULE_ID and the others in ALIASES) are accepted as another
spelling of the keys, read from the file only: the environment is never read. Nothing here prints or logs an ID or a
token. An error names the file and the key, never a value.
"""
from __future__ import annotations

import os
import shlex
import stat
import subprocess
import tomllib
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

DEFAULT_AUDIENCE = "https://api.anthropic.com"
IDS = ("federation_rule_id", "organization_id", "service_account_id", "workspace_id")
REQUIRED = ("federation_rule_id", "organization_id")
SOURCES = ("google", "file", "command")
KEYS = (*IDS, "token_source", "audience", "token_file", "token_command")
# the SDK's own names for the same values, as its environment variables spell them
ALIASES = {
    "ANTHROPIC_FEDERATION_RULE_ID": "federation_rule_id",
    "ANTHROPIC_ORGANIZATION_ID": "organization_id",
    "ANTHROPIC_SERVICE_ACCOUNT_ID": "service_account_id",
    "ANTHROPIC_WORKSPACE_ID": "workspace_id",
    "ANTHROPIC_IDENTITY_TOKEN_FILE": "token_file",
}
COMMAND_TIMEOUT = 60  # seconds a token command may take


class WifError(Exception):
    """The config file cannot be used, in one plain sentence that never holds a value from it."""


@dataclass(frozen=True)
class Config:
    path: Path
    ids: dict[str, str]
    source: str
    audience: str
    token_file: str
    token_command: tuple[str, ...]

    def describe(self) -> str:
        """The token source in words, for Settings and the log: never an ID."""
        if self.source == "file":
            return f"the token file {self.token_file}"
        if self.source == "command":
            return f"the command {Path(self.token_command[0]).name}"
        return f"a Google identity token for {self.audience}"

    def token_provider(self) -> Callable[[], str]:
        return {"google": self._google, "file": self._file, "command": self._command}[self.source]

    def _google(self) -> str:
        import google.auth.exceptions  # noqa: PLC0415
        import google.auth.transport.requests  # noqa: PLC0415
        import google.oauth2.id_token  # noqa: PLC0415

        try:
            return google.oauth2.id_token.fetch_id_token(google.auth.transport.requests.Request(), self.audience)
        except google.auth.exceptions.GoogleAuthError as e:
            raise WifError(f"no Google identity token for {self.audience}: {type(e).__name__}. This source needs a "
                           "Google Cloud machine or a service account's Application Default Credentials") from None

    def _file(self) -> str:
        try:
            got = Path(self.token_file).read_text(encoding="utf-8").strip()
        except OSError as e:
            raise WifError(f"the token file {self.token_file} cannot be read ({e.strerror or type(e).__name__})") from None
        if not got:
            raise WifError(f"the token file {self.token_file} is empty")
        return got

    def _command(self) -> str:
        name = Path(self.token_command[0]).name
        try:
            done = subprocess.run(list(self.token_command), capture_output=True, text=True, timeout=COMMAND_TIMEOUT,
                                  stdin=subprocess.DEVNULL, check=False)
        except FileNotFoundError:
            raise WifError(f"the token command {name} was not found") from None
        except subprocess.TimeoutExpired:
            raise WifError(f"the token command {name} took longer than {COMMAND_TIMEOUT} seconds") from None
        if done.returncode != 0:
            raise WifError(f"the token command {name} failed with exit code {done.returncode}; run it yourself to "
                           "see why")
        got = done.stdout.strip()
        if not got:
            raise WifError(f"the token command {name} printed nothing")
        return got


def _parse(text: str) -> dict[str, Any]:
    """The file's keys: TOML, or KEY=VALUE lines (quotes around a value are dropped, # starts a comment line)."""
    try:
        return tomllib.loads(text)
    except tomllib.TOMLDecodeError:
        pass
    got: dict[str, Any] = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export "):].lstrip()
        if "=" not in line:
            raise WifError("is neither TOML nor KEY=VALUE lines")
        k, v = line.split("=", 1)
        v = v.strip()
        if len(v) >= 2 and v[0] == v[-1] and v[0] in "'\"":
            v = v[1:-1]
        got[k.strip()] = v
    return got


def _check_owner(p: Path) -> None:
    """A file that may name a command to run is refused when someone other than this user (or root) can change it."""
    st = p.stat()
    if hasattr(os, "getuid") and st.st_uid not in (os.getuid(), 0):
        raise WifError(f"{p} belongs to another user; use a file of your own")
    if st.st_mode & (stat.S_IWGRP | stat.S_IWOTH):
        raise WifError(f"{p} can be changed by other users; run chmod go-w on it")


def resolve(path: str) -> Path:
    """The file's absolute path, ~ expanded; a relative path is taken from the current folder."""
    if not isinstance(path, str) or not path.strip():
        raise WifError("name the Workload Identity Federation config file")
    return Path(path.strip()).expanduser().absolute()


def load(path: str) -> Config:
    """The config in the file at `path`; WifError, in words that hold no value from the file, when it cannot be used."""
    p = resolve(path)
    try:
        text = p.read_text(encoding="utf-8")
        _check_owner(p)
    except IsADirectoryError:
        raise WifError(f"{p} is a folder, not a config file") from None
    except FileNotFoundError:
        raise WifError(f"there is no file {p}") from None
    except (OSError, UnicodeDecodeError) as e:
        raise WifError(f"{p} cannot be read ({getattr(e, 'strerror', None) or type(e).__name__})") from None
    try:
        raw = _parse(text)
    except WifError as e:
        raise WifError(f"{p} {e}") from None
    vals: dict[str, Any] = {}
    for k, v in raw.items():
        key = ALIASES.get(k, k)
        if key in KEYS and key not in vals:
            vals[key] = v
    for k in vals:
        if k != "token_command" and not isinstance(vals[k], str):
            raise WifError(f"{p}: {k} is not a string")
    missing = [k for k in REQUIRED if not str(vals.get(k) or "").strip()]
    if missing:
        raise WifError(f"{p} has no {' and no '.join(missing)}")
    source = str(vals.get("token_source") or "").strip().lower()
    if not source:
        source = "file" if vals.get("token_file") else "command" if vals.get("token_command") else "google"
    if source not in SOURCES:
        raise WifError(f"{p}: token_source is one of {', '.join(SOURCES)}")
    token_file = str(vals.get("token_file") or "").strip()
    if source == "file":
        if not token_file:
            raise WifError(f"{p}: the file source needs token_file, the path of the token")
        token_file = str(Path(token_file).expanduser())
    command: tuple[str, ...] = ()
    if source == "command":
        c = vals.get("token_command")
        if isinstance(c, str):
            command = tuple(shlex.split(c))
        elif isinstance(c, list) and all(isinstance(x, str) for x in c):
            command = tuple(c)
        if not command:
            raise WifError(f"{p}: the command source needs token_command, a command line or a list of its words")
    audience = str(vals.get("audience") or DEFAULT_AUDIENCE).strip()
    ids = {k: str(vals[k]).strip() for k in IDS if str(vals.get(k) or "").strip()}
    return Config(p, ids, source, audience, token_file, command)


def stamp(path: str) -> str:
    """What changes when the file does, so a client built from it is built again: its mtime and size."""
    try:
        st = resolve(path).stat()
    except (OSError, WifError):
        return ""
    return f"{st.st_mtime_ns}:{st.st_size}"
