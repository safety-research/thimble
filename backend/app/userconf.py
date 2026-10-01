"""thimble's config for its agents: $THIMBLE_HOME/config.json (THIMBLE_HOME, else ~/.thimble), and an optional override
for one workspace, workspaces/<c>/config.json. docs/config.md documents every key.

Layers, lowest first: DEFAULTS, the file, the workspace's override. An object merges key by key (`sandbox`, `agents` and
each agent); any other value replaces the one below it, null included, which stands for thimble's default.

A file that does not parse, or a key or value this module does not know, is a ConfigError that names the file, the key
and what it takes. No agent session starts while the config has one (session); the Settings pane and `thimble doctor`
show it. The models and efforts are read leniently (load_or_defaults), so the pages still show.

Earlier builds kept the agents' models and permission modes in the workspace's settings.json. migrate moves them into
that workspace's override the first time the workspace's config is read, so each workspace runs as it did.
"""
from __future__ import annotations

import copy
import json
import logging
import os
import re
import shutil
import sys
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from . import config, sandbox_allow

log = logging.getLogger("thimble.userconf")

FILE = "config.json"
AGENTS = ("orientation", "critic", "writer", "checks", "dev", "labels", "cardCheck")
CALLS = ("labels", "cardCheck")  # one model call each, with no tools
# each agent's role among config.MODEL_ROLES, and its row among modes.AGENTS
ROLES = {"orientation": "orient", "critic": "critic", "writer": "writer", "checks": "checks", "dev": "dev",
         "labels": "labels", "cardCheck": "verify"}
MODE_ROWS = {"orientation": "orient", "writer": "writer", "critic": "critic", "checks": "checks", "dev": "dev"}
# the prompt file under prompts/ that an agent's `prompt` replaces
PROMPT_FILES = {"orientation": "orient", "critic": "critic", "writer": "writer", "checks": "check", "dev": "dev",
                "labels": "labels", "cardCheck": "card-check"}
INSTALLS = ("ask", "deny", "allow")
SANDBOX_USES = ("when-available", "never")
BROWSERS = ("system", "bundled", "off")
WEB = ("ask", "off", "allow")
NETWORK = ("off", "on")
AGENT_SANDBOX = ("on", "off")
DATA = ("ask", "allow", "off")
ENV_NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,127}$")
SERVER_JSON = "server.json"  # in thimble's home: the server's address and the token of its local API (hook_auth)
EDIT_TOOLS = ("Edit", "MultiEdit", "Write", "NotebookEdit")
MEMORY = ("inherit", "on", "off")
PERMISSION_MODES = ("manual", "auto", "bypass")  # modes.MODES
WEB_TOOLS = ("WebFetch", "WebSearch")
# The agents whose Bash goes to the analyst while their network is off and their Bash runs outside the sandbox
# (Session.bash_asks): the dev agent, whose view builds run unwatched. The others' Bash follows their permission mode.
ASK_WITHOUT_SANDBOX = ("dev",)


def _session_agent(web: str, network: str = "on") -> dict[str, Any]:
    return {"model": None, "effort": None, "fast": None, "permissionMode": None, "web": web, "network": network,
            "sandbox": "on", "data": "ask", "env": [], "memory": "inherit", "prompt": None}


DEFAULTS: dict[str, Any] = {
    "installs": "ask",
    "sandbox": {"use": "when-available", "enforce": True},
    "browser": None,
    "extensions": {},
    "agents": {
        "orientation": {**_session_agent("ask"), "subagentModel": None},
        "critic": _session_agent("ask"),
        "writer": _session_agent("ask"),
        "checks": _session_agent("ask"),
        "dev": _session_agent("off", network="off"),
        **{a: {"model": None, "effort": None, "fast": None, "prompt": None} for a in CALLS},
    },
}

# An extension's agent, `agents."<extension>:<agent>"` (extensions.agent_definitions), runs as a subagent of the
# orientation's session, under that session's sandbox, installs rules, permission mode, fast mode and memory. Its web
# and network can only take away what the orientation's allow.
EXTENSION_AGENT_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,39}:[a-z0-9][a-z0-9-]{0,39}$")
EXTENSION_AGENT: dict[str, Any] = {"model": None, "effort": None, "web": "off", "network": "on", "prompt": None}
EXTENSION_KEYS = ("enabled",)  # of `extensions.<name>`
EXTENSION_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,39}$")

def install_rules() -> list[str]:
    """The contents of Claude Code's Bash rules for every install or download command (sandbox_allow.INSTALL_*), a
    program's also at a path, a command's also with options before its subcommand. Claude Code's matching misses a
    command behind `sh -c` or a path it does not know, which Session.verdict catches."""
    def spread(c: str) -> list[str]:
        head, _, rest = c.partition(" ")
        return [f"{c}:*", f"{head} * {rest} *"] if rest else [f"{c}:*"]

    return [*(r for p in sandbox_allow.INSTALL_PROGRAMS for r in (f"{p}:*", f"*/{p} *")),
            *(r for c in sandbox_allow.INSTALL_COMMANDS for r in spread(c)),
            *(r for m in sandbox_allow.INSTALL_MODULES for r in (f"* -m {m} *", *[f"* -m {x}" for x in spread(m)[1:]])),
            "pip3.*", "uv run --with *", "uv run * --with *", "uv run --script *", "uv run * --script *"]


def private_paths() -> list[str]:
    """The files no agent thimble starts may read: server.json in thimble's home, which holds the local API's token."""
    return [str(global_file().parent / SERVER_JSON)]


def private_rules() -> list[str]:
    """Claude Code's deny rules for reading and editing private_paths, which also cover Bash commands such as `cat`."""
    return [rule for p in private_paths() for rule in (f"Read(/{p})", f"Edit(/{p})")]


class ConfigError(RuntimeError):
    """thimble's config cannot be used: the message names the file, the key and what it takes."""


# --------------------------------------------------------------------------- files


def global_file() -> Path:
    """$THIMBLE_HOME/config.json, read fresh from the environment."""
    return Path(os.environ.get("THIMBLE_HOME") or "~/.thimble").expanduser() / FILE


def workspace_file(c: str) -> Path:
    if not config._valid_name(c):
        raise ValueError(f"invalid workspace name: {c!r}")
    return config.WORKSPACES_DIR / c / FILE


_lock = threading.RLock()


LINKED_FILE = ("thimble's config {path} is a link or has another name in the workspace, where card code could change "
               "it, so thimble does not read it; replace it with a plain file")


def _raw(path: Path) -> dict[str, Any]:
    """The file's object as written, {} when there is none; ConfigError when it cannot be read or is not an object, or
    is a workspace's file that another name can change (config.linked)."""
    if path.parent.parent == config.WORKSPACES_DIR and config.linked(path):
        raise ConfigError(LINKED_FILE.format(path=path))
    try:
        text = path.read_text("utf-8")
    except FileNotFoundError:
        return {}
    except OSError as e:
        raise ConfigError(f"thimble's config {path} cannot be read: {e}") from e
    if not text.strip():
        return {}
    try:
        data = json.loads(text)
    except ValueError as e:
        raise ConfigError(f"thimble's config {path} is not valid JSON: {e}") from e
    if not isinstance(data, dict):
        raise ConfigError(f"thimble's config {path} must hold one JSON object")
    return data


def _words(values: tuple[str, ...]) -> str:
    quoted = [f'"{v}"' for v in values]
    return ", ".join(quoted[:-1]) + f" or {quoted[-1]}" if len(quoted) > 1 else quoted[0]


def _problems(data: dict[str, Any], scope: str, base: Path) -> list[str]:
    """What is wrong with a file's object, each naming its key; `scope` is `global` or `workspace`."""
    out: list[str] = []

    def one_of(where: str, value: Any, values: tuple[str, ...], null: bool = False) -> None:
        if value is None and null:
            return
        if value not in values:
            out.append(f"{where} is {json.dumps(value)}; it takes {_words(values)}{' or null' if null else ''}")

    def keys(where: str, obj: Any, known: tuple[str, ...], also: "re.Pattern[str] | None" = None, more: str = "") -> bool:
        if not isinstance(obj, dict):
            out.append(f"{where} must be an object")
            return False
        for k in obj:
            if k not in known and not (also and also.match(k)):
                out.append(f"{where + '.' if where else ''}{k} is not a setting; {where or 'the file'} takes "
                           f"{', '.join(known)}{more}")
        return True

    keys("", data, ("installs", "sandbox", "browser", "extensions", "agents"))
    if "installs" in data:
        one_of("installs", data["installs"], INSTALLS)
    if "browser" in data:
        if scope != "global":
            out.append("browser is set for the whole machine, in the config in thimble's home, not per workspace")
        else:
            one_of("browser", data["browser"], BROWSERS, null=True)
    box = data.get("sandbox")
    if "sandbox" in data and keys("sandbox", box, ("use", "enforce")):
        if "use" in box:
            one_of("sandbox.use", box["use"], SANDBOX_USES)
        if "enforce" in box and not isinstance(box["enforce"], bool):
            out.append(f"sandbox.enforce is {json.dumps(box['enforce'])}; it takes true or false")
        if box.get("use") == "never" and box.get("enforce") is True:
            out.append('sandbox.enforce is true while sandbox.use is "never", so no agent could run')
    exts = data.get("extensions")
    if "extensions" in data:
        if scope != "global":
            out.append("extensions are switched off for every workspace in the config in thimble's home; Settings "
                       "switches one off for a single workspace")
        elif keys("extensions", exts, (), EXTENSION_NAME_RE, "the names of extensions (lower-case letters, digits and "
                  "hyphens)"):
            for name, conf in exts.items():
                if EXTENSION_NAME_RE.match(name) and keys(f"extensions.{name}", conf, EXTENSION_KEYS):
                    if conf.get("enabled") is not None and not isinstance(conf["enabled"], bool):
                        out.append(f"extensions.{name}.enabled is {json.dumps(conf['enabled'])}; it takes true, false "
                                   f"or null")
    agents = data.get("agents")
    if "agents" in data and keys("agents", agents, AGENTS, EXTENSION_AGENT_RE, ', or an extension\'s agent as '
                                 '"<extension>:<agent>"'):
        for name, conf in agents.items():
            if name in AGENTS or EXTENSION_AGENT_RE.match(name):
                out.extend(_agent_problems(name, conf, base))
    return out


def _agent_problems(name: str, conf: Any, base: Path) -> list[str]:
    where = f"agents.{name}"
    known = tuple(DEFAULTS["agents"][name] if name in AGENTS else EXTENSION_AGENT)
    if not isinstance(conf, dict):
        return [f"{where} must be an object"]
    out: list[str] = []
    for k, v in conf.items():
        at = f"{where}.{k}"
        if k not in known:
            extra = (f"; {name} is one model call with no tools, so it takes only {', '.join(known)}" if name in CALLS
                     else f"; it takes {', '.join(known)}" if name in AGENTS else
                     f"; an extension's agent runs in the orientation's session, whose permission mode, fast mode and "
                     f"memory it shares, so it takes only {', '.join(known)}")
            out.append(f"{at} is not a setting{extra}")
        elif v is None:
            continue
        elif k in ("model", "subagentModel"):
            if not isinstance(v, str) or not v.strip():
                out.append(f"{at} must be a model id, such as \"claude-opus-5-5\", or null")
        elif k == "effort":
            efforts = config.role_efforts(ROLES[name]) if name in ROLES else config.ROLE_EFFORTS
            if v not in efforts:
                out.append(f"{at} is {json.dumps(v)}; it takes {_words(tuple(e for e in efforts if e))} or null")
        elif k == "fast":
            if not isinstance(v, bool):
                out.append(f"{at} is {json.dumps(v)}; it takes true, false or null")
        elif k == "permissionMode":
            if v not in PERMISSION_MODES:
                out.append(f"{at} is {json.dumps(v)}; it takes {_words(PERMISSION_MODES)} or null")
        elif k == "web":
            if v not in WEB:
                out.append(f"{at} is {json.dumps(v)}; it takes {_words(WEB)}")
        elif k == "network":
            if v not in NETWORK:
                out.append(f"{at} is {json.dumps(v)}; it takes {_words(NETWORK)}")
        elif k == "memory":
            if v not in MEMORY:
                out.append(f"{at} is {json.dumps(v)}; it takes {_words(MEMORY)}")
        elif k == "sandbox":
            if v not in AGENT_SANDBOX:
                out.append(f"{at} is {json.dumps(v)}; it takes {_words(AGENT_SANDBOX)}")
        elif k == "data":
            if v not in DATA:
                out.append(f"{at} is {json.dumps(v)}; it takes {_words(DATA)}")
        elif k == "env":
            if not isinstance(v, list) or not all(isinstance(n, str) and ENV_NAME_RE.match(n) for n in v):
                out.append(f"{at} must be a list of environment variable names, such as [\"OPENAI_API_KEY\"]")
        elif k == "prompt":
            if not isinstance(v, str) or not v.strip():
                out.append(f"{at} must be the path of a prompt file, or null")
            elif not _prompt_path(v, base).is_file():
                out.append(f"{at} names {v}, and there is no file at {_prompt_path(v, base)}")
    return out


def _prompt_path(value: str, base: Path) -> Path:
    """A `prompt` value as a path: `~` expanded, relative to the folder of the file that names it."""
    p = Path(value.strip()).expanduser()
    return p if p.is_absolute() else (base / p)


def read(path: Path, scope: str) -> dict[str, Any]:
    """The file's object, validated, with each agent's `prompt` resolved to an absolute path; {} when there is none."""
    data = _raw(path)
    problems = _problems(data, scope, path.parent)
    if problems:
        raise ConfigError(f"thimble's config {path}: " + "; ".join(problems))
    for conf in (data.get("agents") or {}).values():
        if isinstance(conf, dict) and isinstance(conf.get("prompt"), str):
            conf["prompt"] = str(_prompt_path(conf["prompt"], path.parent).resolve())
    return data


def _merge(low: dict[str, Any], high: dict[str, Any]) -> dict[str, Any]:
    out = copy.deepcopy(low)
    for k, v in high.items():
        out[k] = _merge(out[k], v) if isinstance(v, dict) and isinstance(out.get(k), dict) else copy.deepcopy(v)
    return out


def load(c: str | None = None) -> dict[str, Any]:
    """The config of workspace `c` (the file alone without one): DEFAULTS, the file, the workspace's override.
    ConfigError when either file has an error."""
    if c:
        migrate(c)
    merged = _merge(DEFAULTS, read(global_file(), "global"))
    if c:
        merged = _merge(merged, read(workspace_file(c), "workspace"))
    return merged


def load_or_defaults(c: str | None = None) -> tuple[dict[str, Any], str]:
    """(load(c), '') or, when the config has an error, (DEFAULTS, the error)."""
    try:
        return load(c), ""
    except ConfigError as e:
        return copy.deepcopy(DEFAULTS), str(e)


def problem(c: str | None = None) -> str:
    """The config's error for workspace `c`, '' when it has none."""
    return load_or_defaults(c)[1]


def extension_agent(conf: dict[str, Any], key: str) -> dict[str, Any]:
    """The settings of the extension agent `key` ("<extension>:<agent>") in a loaded config: EXTENSION_AGENT under what
    the config sets, a null at its default."""
    got = (conf.get("agents") or {}).get(key)
    got = got if isinstance(got, dict) else {}
    return {k: v if got.get(k) is None else got[k] for k, v in EXTENSION_AGENT.items()}


def extensions_off() -> set[str] | None:
    """The extensions the file in thimble's home switches off (`extensions.<name>.enabled: false`), read even when
    another key of the file has an error; None when the file cannot be read, so no extension can be known to be on."""
    try:
        exts = _raw(global_file()).get("extensions")
    except ConfigError:
        return None
    if not isinstance(exts, dict):
        return set()
    return {n for n, e in exts.items() if isinstance(e, dict) and e.get("enabled") is False}


# --------------------------------------------------------------------------- writing, for the Settings pane

_MISSING = object()


def _get(d: dict[str, Any], path: tuple[str, ...]) -> Any:
    for k in path:
        if not isinstance(d, dict) or k not in d:
            return _MISSING
        d = d[k]
    return d


def _put(d: dict[str, Any], path: tuple[str, ...], value: Any) -> None:
    """Set the leaf at `path`, making the objects above it; _MISSING removes it and any object it leaves empty."""
    if value is _MISSING:
        chain = [d]
        for k in path[:-1]:
            if not isinstance(chain[-1].get(k), dict):
                return
            chain.append(chain[-1][k])
        chain[-1].pop(path[-1], None)
        for parent, k in zip(reversed(chain[:-1]), reversed(path[:-1])):
            if parent.get(k) == {}:
                parent.pop(k)
        return
    for k in path[:-1]:
        if not isinstance(d.get(k), dict):
            d[k] = {}
        d = d[k]
    d[path[-1]] = value


def leaves(patch: dict[str, Any], at: tuple[str, ...] = ()) -> list[tuple[tuple[str, ...], Any]]:
    """Each (path, value) of a nested patch; an object under `agents.<name>` is walked, any other value is a leaf."""
    out: list[tuple[tuple[str, ...], Any]] = []
    for k, v in patch.items():
        if isinstance(v, dict) and (len(at) < 2 and k in ("agents", "sandbox") or at == ("agents",)):
            out.extend(leaves(v, (*at, k)))
        else:
            out.append(((*at, k), v))
    return out


def _write(path: Path, data: dict[str, Any]) -> None:
    from .ledger import atomic_write_text  # noqa: PLC0415 — ledger imports config, which imports this module lazily

    path.parent.mkdir(parents=True, exist_ok=True)
    atomic_write_text(path, json.dumps(data, indent=2, ensure_ascii=False) + "\n")


def save(c: str | None, patch: dict[str, Any]) -> None:
    """Write a nested patch of settings, None for a value that goes back to the one below it. Each value goes where the
    value the Settings pane shows came from: the workspace's override when it sets that key, else the file in thimble's
    home. ConfigError, writing nothing, when either file has an error or the result would."""
    with _lock:
        if c:
            migrate(c)
        files = [(workspace_file(c), "workspace")] if c else []
        files.append((global_file(), "global"))
        held = {p: _raw(p) for p, _ in files}
        for p, scope in files:
            if problems := _problems(held[p], scope, p.parent):
                raise ConfigError(f"thimble's config {p}: " + "; ".join(problems))
        before = copy.deepcopy(held)
        for path, value in leaves(patch):
            target = next(p for p, _ in files if _get(held[p], path) is not _MISSING or p == global_file())
            _put(held[target], path, _MISSING if value is None else value)
        for p, scope in files:
            if held[p] != before[p]:
                if problems := _problems(held[p], scope, p.parent):
                    raise ConfigError("; ".join(problems))
        for p, _ in files:
            if held[p] != before[p]:
                _write(p, held[p])


# --------------------------------------------------------------------------- the settings.json of earlier builds

LEGACY_MODELS = "models"  # config.MODELS_KEY: models.main stays, since it is main's, kept for its next launch
LEGACY_MODES = "permission_modes"
_STRICT = {"manual": 0, "auto": 1, "bypass": 2}


def legacy_patch(models: dict[str, Any], rows: dict[str, Any]) -> dict[str, Any]:
    """An earlier build's `models` (less main's) and `permission_modes` as settings of this file: each role's model,
    effort and fast mode, the orientation subagents' model as the orientation's subagentModel, and the rows by agent,
    `critic` for the critic and the checks alike and `views` for the dev agent where its own row is not set, the
    stricter of the two when both are."""
    by_role = {role: name for name, role in ROLES.items()}
    agents: dict[str, dict[str, Any]] = {}
    for role, conf in models.items():
        if not isinstance(conf, dict):
            continue
        if role in ("subagents", "readers"):
            model = conf.get("model")
            if isinstance(model, str) and model.strip():
                agents.setdefault("orientation", {})["subagentModel"] = model.strip()
            continue
        name = by_role.get(role)
        if name is None:
            continue
        mine: dict[str, Any] = {}
        if isinstance(conf.get("model"), str) and conf["model"].strip():
            mine["model"] = conf["model"].strip()
        effort = str(conf.get("effort") or "").strip().lower()
        if effort and effort in config.role_efforts(role):
            mine["effort"] = effort
        if isinstance(conf.get("fast"), bool):
            mine["fast"] = conf["fast"]
        if mine:
            agents.setdefault(name, {}).update(mine)
    got = {a: m for a, m in rows.items() if m in PERMISSION_MODES}
    if "views" in got:
        view = got.pop("views")
        got["dev"] = min(got.get("dev", view), view, key=_STRICT.__getitem__)
    by_row = {"orient": ("orientation",), "writer": ("writer",), "critic": ("critic", "checks"), "dev": ("dev",),
              "checks": ("checks",)}
    for row, mode in got.items():
        for name in by_row.get(row, ()):
            agents.setdefault(name, {})["permissionMode"] = mode
    return {"agents": agents} if agents else {}


def pane_patch(models: dict[str, Any] | None, rows: dict[str, Any] | None) -> dict[str, Any]:
    """The Settings pane's changes as settings of this file: `models` {role: {model?, effort?, fast?}} (main's left
    out, '' for back to the default; an extension's agent, "<ext>:<name>", takes its model and effort only) and `rows`
    {row of modes.AGENTS: mode, None for main's}, `views` being the dev agent's row of earlier builds."""
    by_role = {role: name for name, role in ROLES.items()}
    agents: dict[str, dict[str, Any]] = {}
    for role, conf in (models or {}).items():
        if not isinstance(conf, dict) or role == "main":
            continue
        if role in ("subagents", "readers"):
            if "model" in conf:
                agents.setdefault("orientation", {})["subagentModel"] = str(conf["model"] or "").strip() or None
            continue
        name = by_role.get(role)
        if name is None and EXTENSION_AGENT_RE.match(role):
            for k in ("model", "effort"):
                if k in conf:
                    agents.setdefault(role, {})[k] = str(conf[k] or "").strip() or None
            continue
        if name is None:
            raise ConfigError(f"no role {role!r}; one of {', '.join(by_role)}, or an extension's agent")
        for k in ("model", "effort", "fast"):
            if k in conf:
                v = conf[k]
                agents.setdefault(name, {})[k] = (str(v).strip() or None) if k != "fast" and v is not None else v
    for row, mode in (rows or {}).items():
        agents.setdefault(agent_of_row("dev" if row == "views" else row), {})["permissionMode"] = mode
    return {"agents": agents} if agents else {}


def migrate(c: str) -> bool:
    """Move an earlier build's models and permission modes out of workspaces/<c>/settings.json into the workspace's
    override (legacy_patch), where a value the override already holds stays; True when something moved. A settings
    file that cannot be read, or an override with an error, is left for a later read."""
    if not config._valid_name(c):
        return False
    settings = config.WORKSPACES_DIR / c / "settings.json"
    try:
        stored = json.loads(settings.read_text("utf-8"))
    except (OSError, ValueError):
        return False
    if not isinstance(stored, dict):
        return False
    models = stored.get(LEGACY_MODELS) if isinstance(stored.get(LEGACY_MODELS), dict) else {}
    roles = {k: v for k, v in models.items() if k != "main"}
    if not roles and LEGACY_MODES not in stored:
        return False
    with _lock:
        target = workspace_file(c)
        try:
            held = _raw(target)
        except ConfigError as e:
            log.warning("%s: settings of an earlier build stay in %s until this is fixed: %s", c, settings, e)
            return False
        patch = legacy_patch(roles, stored.get(LEGACY_MODES) if isinstance(stored.get(LEGACY_MODES), dict) else {})
        moved = copy.deepcopy(held)
        for path, value in leaves(patch):
            if _get(moved, path) is _MISSING:
                _put(moved, path, value)
        if moved != held:
            _write(target, moved)
        rest = {k: v for k, v in stored.items() if k != LEGACY_MODES}
        if LEGACY_MODELS in rest:
            main = models.get("main")
            rest[LEGACY_MODELS] = {"main": main} if isinstance(main, dict) else {}
            if not rest[LEGACY_MODELS]:
                rest.pop(LEGACY_MODELS)
        _write(settings, rest)
    log.info("%s: moved the agents' models and permission modes from %s to %s", c, settings, target)
    return True


# --------------------------------------------------------------------------- what a session gets


def agent_of_row(row: str) -> str:
    """The agent of a row of modes.AGENTS."""
    return next(name for name, r in MODE_ROWS.items() if r == row)


def mode_rows(c: str) -> dict[str, str]:
    """The permission modes the config sets, by row of modes.AGENTS."""
    agents = load_or_defaults(c)[0]["agents"]
    return {row: agents[name]["permissionMode"] for name, row in MODE_ROWS.items()
            if agents[name].get("permissionMode") in PERMISSION_MODES}


def sandbox_runs(refresh: bool = False) -> bool:
    from . import cc_settings  # noqa: PLC0415 — cc_settings imports ledger, which imports config

    return cc_settings.sandbox_ok(refresh=refresh)


@dataclass
class Session:
    """What the config asks of one session of an agent (session)."""

    c: str | None
    agent: str
    conf: dict[str, Any]  # the agent's settings
    installs: str
    sandboxed: bool  # its Bash runs in Claude Code's sandbox
    own_bash: list[str] = field(default_factory=list)  # commands it runs unasked in every case (allow_own)
    hosted: bool = True  # False for a session nobody can answer, which is refused what it would ask for
    offline: bool = False  # a view build whose network is off, whose deny rules refuse every install (dev.view_fence)
    enforced: bool = False  # sandbox.enforce: Claude Code refuses to start the session when its sandbox can't run

    @property
    def network(self) -> bool:
        return self.conf.get("network", "on") == "on"

    @property
    def web(self) -> str:
        return str(self.conf.get("web") or "ask")

    @property
    def data(self) -> str:
        """What happens to an edit of the corpus: `ask` sends it to the analyst in every mode, `allow` leaves it to the
        permission mode, `off` refuses it."""
        value = self.conf.get("data")
        return value if value in DATA else "ask"

    def corpus(self) -> Path | None:
        if not self.c:
            return None
        try:
            return Path(os.path.realpath(config.corpus_dir(self.c)))
        except (OSError, ValueError, KeyError):
            return None

    def edits_corpus(self, tool: str, inp: Any) -> bool:
        """Whether a call of `tool` writes a file in the corpus folder."""
        if tool not in EDIT_TOOLS or not isinstance(inp, dict):
            return False
        target = inp.get("notebook_path" if tool == "NotebookEdit" else "file_path")
        corpus = self.corpus()
        if not isinstance(target, str) or not target.strip() or corpus is None:
            return False
        path = Path(target.strip()).expanduser()
        if not path.is_absolute():
            return False
        real = Path(os.path.realpath(path))
        return real == corpus or corpus in real.parents

    @property
    def bash_asks(self) -> bool:
        """Whether every Bash command goes to the analyst: an agent of ASK_WITHOUT_SANDBOX whose network is off and whose
        Bash runs outside the sandbox, in a session somebody answers."""
        return self.agent in ASK_WITHOUT_SANDBOX and not self.network and not self.sandboxed and self.hosted

    def settings(self) -> dict[str, Any]:
        """The --settings keys of the config for the session: the install rules, Bash asked when bash_asks, the web
        allowed or denied, auto memory when not inherited, and a deny of edits to the config's files."""
        files = [global_file(), *([workspace_file(self.c)] if self.c else [])]
        perms: dict[str, list[str]] = {"deny": [*(f"Edit(/{f})" for f in files), *private_rules()]}
        rules = [f"Bash({r})" for r in install_rules()]
        if self.installs == "ask" and self.hosted:
            perms["ask"] = rules
        elif self.installs != "allow":
            perms["deny"] += rules
        if self.bash_asks:
            perms["ask"] = [*perms.get("ask", []), "Bash"]
        if self.web == "off":
            perms["deny"] += list(WEB_TOOLS)
        elif self.web == "allow":
            perms["allow"] = list(WEB_TOOLS)
        out: dict[str, Any] = {"permissions": perms, "sandbox": {"filesystem": {"denyRead": private_paths()}}}
        memory = self.conf.get("memory")
        if memory in ("on", "off"):
            out["autoMemoryEnabled"] = memory == "on"
        return out

    def install_asks(self) -> bool:
        """Whether the sandbox hook leaves install commands to the permission flow (sandbox_allow's --installs)."""
        return self.installs != "allow"

    def may_ask(self) -> bool:
        """Whether a call can go to the analyst whatever the permission mode (verdict)."""
        return self.installs != "allow" or self.bash_asks or self.data == "ask"

    def verdict(self, tool: str, inp: Any) -> str:
        """`deny` or `ask` when the config refuses a call or sends it to the analyst whatever the permission mode: an
        edit of the corpus by `data`; for a Bash call, an install command by `installs`, or refused when offline, and,
        when bash_asks, any other command; `own` for one of the session's own commands then, which runs unasked; ''
        for any other call."""
        if self.data != "allow" and self.edits_corpus(tool, inp):
            return "deny" if self.data == "off" else "ask"
        command = inp.get("command") if tool == "Bash" and isinstance(inp, dict) else None
        if not isinstance(command, str):
            return ""
        if (self.offline or self.installs != "allow") and sandbox_allow.installs(command):
            return "deny" if self.offline else self.installs
        if self.bash_asks:
            return "own" if allow_own(command, self.own_bash) else "ask"
        return ""


_CONTROL = re.compile(r"[;&|`$<>(){}\n\\]")


def allow_own(command: str, own: list[str]) -> bool:
    """Whether a command line is one of `own` alone, or one with plain arguments after it."""
    line = command.strip()
    return any(line == o or (line.startswith(o + " ") and not _CONTROL.search(line[len(o):])) for o in own)


# why an agent did not start while thimble's config requires the sandbox (session), read by the analyst and by models,
# so the fix names no command
NO_SANDBOX = "thimble's agents run only in Claude Code's Bash sandbox (sandbox.enforce), and {why}, so the {agent} agent did not start. {fix}"
NO_SANDBOX_WHY = {
    "outside": ("this agent's sessions run outside it", ""),
    "never": ('thimble\'s config turns it off (sandbox.use "never")',
              "To run the agents without it, set sandbox.enforce to false in thimble's config as well."),
    "env": ("THIMBLE_SANDBOX=0 turns it off", "Unset THIMBLE_SANDBOX and restart thimble to use it."),
    "missing": ("it can't run on this machine",
                "The analyst installs what it needs by running thimble's installer again in their own terminal with "
                "--sandbox-deps; `thimble doctor` says what is missing."),
}


def session(c: str | None, agent: str, *, sandbox: bool = True) -> Session:
    """What the config asks of a session of `agent` in workspace `c`; `sandbox` False for a session the caller runs
    outside the sandbox. An agent whose own `sandbox` is "off" runs outside it. ConfigError when the config has an
    error, or requires the sandbox (`sandbox.enforce`, on by default) and the session of an agent whose sandbox is on
    would run outside it (NO_SANDBOX)."""
    conf = load(c)
    box = conf["sandbox"]
    if conf["agents"][agent].get("sandbox") == "off":
        return Session(c, agent, conf["agents"][agent], conf["installs"], False)
    runs = box["use"] != "never" and sandbox_runs()
    if box["enforce"] and sandbox and not runs and box["use"] != "never":
        runs = sandbox_runs(refresh=True)  # the analyst may have installed what it needs since the last check
    if box["enforce"] and not (sandbox and runs):
        key = ("outside" if not sandbox else "never" if box["use"] == "never" else
               "env" if os.environ.get("THIMBLE_SANDBOX", "").strip() == "0" else "missing")
        why, fix = NO_SANDBOX_WHY[key]
        raise ConfigError(NO_SANDBOX.format(why=why, agent=agent, fix=fix).strip())
    return Session(c, agent, conf["agents"][agent], conf["installs"], sandbox and runs, enforced=bool(box["enforce"]))


# --------------------------------------------------------------------------- prompts


def prompt_files(c: str | None, agent: str) -> dict[str, Path]:
    """{prompt file: the file that replaces it} for `agent` in workspace `c` (prompts.custom): the config's `prompt`,
    else the role's prompt as the active extensions change it (roles.prompt_file); {} for none."""
    value = load_or_defaults(c)[0]["agents"][agent].get("prompt")
    if isinstance(value, str) and value:
        return {PROMPT_FILES[agent]: Path(value)}
    from . import roles  # noqa: PLC0415 — roles reads the extensions, which import this module

    if agent in roles.SESSION_ROLES:
        try:
            made = roles.prompt_file(c, agent)
        except Exception:  # noqa: BLE001 — an extension's broken prompt leaves the role on thimble's own
            log.exception("%s: the %s prompt of the active extensions could not be made", c, agent)
            made = None
        if made is not None:
            return {PROMPT_FILES[agent]: made}
    return {}


# --------------------------------------------------------------------------- the browser

# The browsers `system` looks for, by platform: Chrome, Edge and Chromium, on PATH or where they install.
SYSTEM_BROWSERS = {
    "linux": ("google-chrome", "google-chrome-stable", "microsoft-edge", "microsoft-edge-stable", "chromium",
              "chromium-browser", "/opt/google/chrome/chrome", "/opt/microsoft/msedge/msedge"),
    "darwin": ("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
               "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
               "/Applications/Chromium.app/Contents/MacOS/Chromium",
               "~/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
               "~/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"),
}
BROWSER_ENV = "THIMBLE_BROWSER_PATH"  # read by scripts/ui_shot.mjs and scripts/view_shot.mjs
OFF = "the browser is off in thimble's config"
NO_SYSTEM = "thimble's config names the system browser, and no Chrome, Edge or Chromium was found"


def system_browser() -> str:
    """The first of SYSTEM_BROWSERS for this platform that is there, as a path; '' for none."""
    plat = "linux" if sys.platform.startswith("linux") else sys.platform
    for name in SYSTEM_BROWSERS.get(plat, ()):
        if "/" in name:
            p = Path(name).expanduser()
            if p.is_file() and os.access(p, os.X_OK):
                return str(p)
        elif found := shutil.which(name):
            return found
    return ""


def browser(bundled: Callable[[], bool] = lambda: True) -> tuple[str, str]:
    """(the browser screenshots use, its path or why there is none): (`system`, its path), (`bundled`, '') or (`off`,
    why). Without a setting: the system one when found, else the bundled one when `bundled()` says it is installed, else
    off."""
    value = load_or_defaults()[0].get("browser")
    if value == "off":
        return "off", OFF
    if value == "bundled":
        return "bundled", ""
    found = system_browser()
    if found:
        return "system", found
    if value == "system":
        return "off", NO_SYSTEM
    return ("bundled", "") if bundled() else ("off", "no browser is installed")


def browser_env() -> dict[str, str]:
    """BROWSER_ENV for a screenshot script: the system browser's path, else {} (Playwright's own Chromium)."""
    kind, path = browser()
    return {BROWSER_ENV: path} if kind == "system" else {}
