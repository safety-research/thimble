"""thimble's config for its agents: $THIMBLE_HOME/config.json (THIMBLE_HOME, else ~/.thimble), and an optional override
for one workspace, workspaces/<c>/config.json. docs/config.md documents every key.

Layers, lowest first: DEFAULTS, the file, the workspace's override. An object merges key by key (`sandbox`, `agents` and
each agent); any other value replaces the one below it, null included, which stands for thimble's default.

A file that does not parse, or a key or value this module does not know, is a ConfigError that names the file, the key
and what it takes. No agent session starts while the config has one (session); the Settings pane and `thimble doctor`
show it. The models and efforts are read leniently (load_or_defaults), so the pages still show.

Earlier builds kept the agents' models and permission modes in the workspace's settings.json. migrate moves them into
that workspace's override the first time the workspace's config is read, so each workspace runs as it did. The settings
of an extension thimble renamed (RENAMED_EXTENSIONS) are read under its new name, and written so when a file is
rewritten (rename_extensions).

Edits of the config. An agent's edit of these files (config_files) goes to the analyst in every permission mode, as an
edit of the corpus does with `data` at "ask" (Session.verdict, ask_cause `config`), so the analyst sees on the card what
an agent would change in its own permissions and decides; a session nobody answers is refused it. main's kept mode
(main_modes_file), which only thimble writes, stays denied.

One fence for main and its agents. thimble's agents are subagents of main, the analyst's Claude Code session, which the
launcher starts inside thimble's fence (cli.main_fence, its permission rules main_rules): they run in main's permission
mode and share its sandbox, network and rules. So the orientation's `web`, `network` and `data` are main's fence's keys,
which every agent shares; the other agents keep only `web: off`, which keeps that one agent off the web tools. The dev
agent alone keeps its own permission mode, fast mode and fence keys, for code tickets, which stay jobs of the server.
Installs follow Claude Code's permission mode: thimble adds no rule for them. The keys earlier builds read for this,
`installs`, and each agent's own `fast` and `permissionMode` and `web` other than "off" but the dev agent's
(IGNORED_KEYS), are read and ignored, so an earlier config stays valid; `ignored` lists those a file holds, and a save
from the Settings pane drops them. `suggest` (the viewer suggestion's call) and `refusal` (the model and effort a refused classifier call runs
again on, which `off` turns off) are classifier rows.

Extensions' programs. An extension's program that runs an agent or one of its tasks (harness.py) is no subagent of main:
it runs in a box of its own and keeps its power. So it takes its agent's own `env`, `sandbox`, `network` and `data`
(PROGRAM_KEYS; agent_conf with `program`), which thimble's own agent of that role does not read, since it shares main's
fence. Where the agent sets none of them, as for the dev agent and the classifiers, the program's network and sandbox
are on, its edits of the corpus ask, and it gets no variable of the server's.
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
from typing import Any, Callable, NamedTuple

from . import config, permission_hook, sandbox_allow

log = logging.getLogger("thimble.userconf")

FILE = "config.json"
AGENTS = ("orientation", "critic", "writer", "checks", "dev", "labels", "cardCheck", "suggest", "refusal")
CALLS = ("labels", "cardCheck")  # one model call each, with no tools, unless an extension's program runs their tasks
# each agent's role among config.MODEL_ROLES
ROLES = {"orientation": "orient", "critic": "critic", "writer": "writer", "checks": "checks", "dev": "dev",
         "labels": "labels", "cardCheck": "verify", "suggest": "suggest", "refusal": "refusal"}
# each agent's row among modes.AGENTS: the dev agent's alone, whose code tickets run in a mode of their own; every other
# agent runs in main's mode (module note, one fence)
MODE_ROWS = {"dev": "dev"}
SUBAGENT_ROLES = ("orientation", "critic", "writer", "checks")  # the agents that run as subagents of main
# the keys of each agent that earlier builds read and this one reads and ignores (module note, one fence)
IGNORED_KEYS: dict[str, tuple[str, ...]] = {
    **{a: ("fast", "permissionMode") for a in ("orientation", "critic", "writer", "checks")},
}
IGNORED_TOP = ("installs",)  # top-level keys read and ignored
# the keys of an agent that runs as a subagent of main which only an extension's program running the agent reads (module
# note, extensions' programs), and what the program gets where the agent sets none (null in DEFAULTS)
PROGRAM_KEYS = ("env", "sandbox", "network", "data")
PROGRAM_DEFAULTS = {"env": [], "sandbox": "on", "network": "on", "data": "ask"}
# the prompt file under prompts/ that an agent's `prompt` replaces
PROMPT_FILES = {"orientation": "orient", "critic": "critic", "writer": "writer", "checks": "check", "dev": "dev",
                "labels": "labels", "cardCheck": "card-check"}
SANDBOX_USES = ("when-available", "never")
BROWSERS = ("system", "bundled", "off")
WEB = ("ask", "off", "allow")
NETWORK = ("off", "on")
AGENT_SANDBOX = ("on", "off")
DATA = ("ask", "allow", "off")
ENV_NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,127}$")
# `cardWait`: the minutes a permission card waits for the analyst before an unanswered request is declined
# (card_wait_s), at most half the permission hook's own timeout, so the hook is never ended first
CARD_WAIT_MINUTES = 10
CARD_WAIT_MAX = permission_hook.TIMEOUT // 120
SERVER_JSON = "server.json"  # in thimble's home: the server's address and the token of its local API (hook_auth)
MAIN_MODES = "main-modes.json"  # in thimble's home: the permission mode main last reported, per workspace (session.note_mode)
SESSION_KEY = "session.key"  # in thimble's home: the secret of the sessions' tokens (hook_auth.SESSION_KEY)
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


def _subagent(web: str | None) -> dict[str, Any]:
    """An agent that runs as a subagent of main (module note, one fence): its model and effort, `web` ("off", or null
    for main's), its CLAUDE.md files (`memory`) and its prompt, and PROGRAM_KEYS for an extension's program that runs it
    (module note, extensions' programs)."""
    return {"model": None, "effort": None, "web": web, "memory": "inherit", "prompt": None,
            **{k: None for k in PROGRAM_KEYS}}


DEFAULTS: dict[str, Any] = {
    "sandbox": {"use": "when-available", "enforce": True},
    "browser": None,
    "cardWait": CARD_WAIT_MINUTES,
    "extensions": {},
    "agents": {
        # the orientation's web, network and data are main's fence's (module note, one fence); subagentModel and
        # subagentEffort are thimble:helper's, the type of the orientation's own subagents
        "orientation": {**_subagent("ask"), "network": "on", "data": "ask", "subagentModel": None,
                        "subagentEffort": None},
        "critic": _subagent(None),
        "writer": _subagent(None),
        "checks": _subagent(None),
        "dev": _session_agent("off"),  # its `fast` is code tickets' (config.FAST_OF_TICKETS)
        # `network`, `data` and `env` reach only an extension's program that runs one of their tasks (harness.py)
        **{a: {"model": None, "effort": None, "fast": None, "network": "on", "data": "ask", "env": [], "prompt": None}
           for a in CALLS},
        "suggest": {"model": None, "effort": None, "fast": None},
        "refusal": {"model": None, "effort": None, "off": None},
    },
}
# `agents.cardCheck.auto`: whether the card check reads each new card by itself (card_check.auto); null is on
DEFAULTS["agents"]["cardCheck"]["auto"] = None

# An extension's agent, `agents."<extension>:<agent>"` (extensions.agent_definitions), runs as a subagent of the
# orientation's session, under that session's sandbox, installs rules, permission mode, fast mode and memory. Its web
# and network can only take away what the orientation's allow.
EXTENSION_AGENT_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,39}:[a-z0-9][a-z0-9-]{0,39}$")
EXTENSION_AGENT: dict[str, Any] = {"model": None, "effort": None, "web": "off", "network": "on", "prompt": None}
EXTENSION_KEYS = ("enabled",)  # of `extensions.<name>`
EXTENSION_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,39}$")
# the extensions thimble ships under a new name, by their old name: a config's settings of an old name are the new one's
RENAMED_EXTENSIONS = {"swarm": "swarm-orient"}

def private_paths() -> list[str]:
    """The files no agent thimble starts may read: server.json in thimble's home, which holds the local API's token, and
    the key the sessions' tokens are signed with."""
    return [str(global_file().parent / name) for name in (SERVER_JSON, SESSION_KEY)]


def private_rules() -> list[str]:
    """Claude Code's deny rules for reading and editing private_paths, which also cover Bash commands such as `cat`."""
    return [rule for p in private_paths() for rule in (f"Read(/{p})", f"Edit(/{p})")]


class ConfigError(RuntimeError):
    """thimble's config cannot be used: the message names the file, the key and what it takes."""


# --------------------------------------------------------------------------- files


def global_file() -> Path:
    """$THIMBLE_HOME/config.json, read fresh from the environment."""
    return Path(os.environ.get("THIMBLE_HOME") or "~/.thimble").expanduser() / FILE


def main_modes_file() -> Path:
    """$THIMBLE_HOME/main-modes.json, which every row that follows main reads its mode from after a restart (modes.py)."""
    return global_file().parent / MAIN_MODES


def workspace_file(c: str) -> Path:
    if not config._valid_name(c):
        raise ValueError(f"invalid workspace name: {c!r}")
    return config.WORKSPACES_DIR / c / FILE


_lock = threading.RLock()


LINKED_FILE = ("thimble's config {path} is a link or has another name in the workspace, where card code could change "
               "it, so thimble does not read it; replace it with a plain file")


def renamed_extensions() -> dict[str, str]:
    """RENAMED_EXTENSIONS less each old name that an extension of the analyst's own still has (extensions.foreign)."""
    from . import extensions  # noqa: PLC0415 — extensions imports this module

    return {old: new for old, new in RENAMED_EXTENSIONS.items() if not extensions.foreign(old)}


def _renamed(data: dict[str, Any]) -> dict[str, Any]:
    """A file's object with the settings of each renamed extension (renamed_extensions) under its new name,
    `extensions.<old>` and `agents."<old>:<agent>"`; where the new name has a setting of its own, that one stays."""
    exts, agents = data.get("extensions"), data.get("agents")
    named = [*(exts if isinstance(exts, dict) else ()), *(k.partition(":")[0] for k in
                                                          (agents if isinstance(agents, dict) else ()))]
    if not any(n in RENAMED_EXTENSIONS for n in named) or not (names := renamed_extensions()):
        return data

    def rename(obj: dict[str, Any], new_key: Callable[[str], str]) -> dict[str, Any]:
        return {new_key(k): v for k, v in obj.items() if new_key(k) == k or new_key(k) not in obj}

    def agent_key(k: str) -> str:
        ext, sep, agent = k.partition(":")
        return f"{names[ext]}:{agent}" if sep and ext in names else k

    out = dict(data)
    if isinstance(exts, dict):
        out["extensions"] = rename(exts, lambda k: names.get(k, k))
    if isinstance(agents, dict):
        out["agents"] = rename(agents, agent_key)
    return out


def _raw(path: Path) -> dict[str, Any]:
    """The file's object (_written) with each renamed extension's settings under its new name (_renamed)."""
    return _renamed(_written(path))


def rename_extensions(path: Path) -> bool:
    """Write the config file at `path` with each renamed extension's settings under its new name (_renamed); True when
    it changed. A file that cannot be read or written is left as it is, and _raw still reads it under the new names."""
    with _lock:
        try:
            data = _written(path)
        except ConfigError:
            return False
        got = _renamed(data)
        if got == data:
            return False
        try:
            _write(path, got)
        except OSError as e:
            log.warning("thimble's config %s keeps the old names of renamed extensions: %s", path, e)
            return False
    log.info("thimble's config %s: the settings of renamed extensions are under their new names", path)
    return True


def _written(path: Path) -> dict[str, Any]:
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


def _card_wait(value: Any) -> float | None:
    """A `cardWait` value in minutes, None when it is not a number above 0 and up to CARD_WAIT_MAX."""
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not 0 < value <= CARD_WAIT_MAX:
        return None
    return float(value)


def card_wait_s() -> float:
    """How long a permission card waits for the analyst before an unanswered request is declined, in seconds:
    `cardWait` of the file in thimble's home, else CARD_WAIT_MINUTES, also when the file has an error."""
    try:
        got = _card_wait(_raw(global_file()).get("cardWait"))
    except ConfigError:
        got = None
    return (got if got is not None else CARD_WAIT_MINUTES) * 60.0


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

    keys("", data, (*IGNORED_TOP, "sandbox", "browser", "cardWait", "extensions", "agents"))
    if "browser" in data:
        if scope != "global":
            out.append("browser is set for the whole machine, in the config in thimble's home, not per workspace")
        else:
            one_of("browser", data["browser"], BROWSERS, null=True)
    if "cardWait" in data:
        if scope != "global":
            out.append("cardWait is set for the whole machine, in the config in thimble's home, not per workspace")
        elif data["cardWait"] is not None and _card_wait(data["cardWait"]) is None:
            out.append(f"cardWait is {json.dumps(data['cardWait'])}; it takes a number of minutes above 0 and up to "
                       f"{CARD_WAIT_MAX}, or null")
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
        if k in IGNORED_KEYS.get(name, ()):
            continue  # read and ignored (module note, one fence)
        if k not in known:
            extra = (f"; {name} runs one model call with no tools, or an extension's program, so it takes only "
                     f"{', '.join(known)}" if name in CALLS
                     else f"; it takes {', '.join(known)}" if name in AGENTS else
                     f"; an extension's agent runs in the orientation's session, whose permission mode, fast mode and "
                     f"memory it shares, so it takes only {', '.join(known)}")
            out.append(f"{at} is not a setting{extra}")
        elif v is None:
            continue
        elif k in ("model", "subagentModel"):
            if not isinstance(v, str) or not v.strip():
                out.append(f"{at} must be a model id, such as \"claude-opus-5-5\", or null")
        elif k in ("effort", "subagentEffort"):
            efforts = config.role_efforts(ROLES[name]) if name in ROLES and k == "effort" else config.ROLE_EFFORTS
            if v not in efforts and not (name == "orientation" and k == "effort" and v in config.LEGACY_EFFORTS):
                out.append(f"{at} is {json.dumps(v)}; it takes {_words(tuple(e for e in efforts if e))} or null")
        elif k in ("fast", "auto", "off"):
            if not isinstance(v, bool):
                out.append(f"{at} is {json.dumps(v)}; it takes true, false or null")
        elif k == "permissionMode":
            if v not in PERMISSION_MODES:
                out.append(f"{at} is {json.dumps(v)}; it takes {_words(PERMISSION_MODES)} or null")
        elif k == "web":
            if v not in WEB:
                out.append(f"{at} is {json.dumps(v)}; it takes {_words(WEB)}"
                           + (" or null" if name in SUBAGENT_ROLES and name != "orientation" else ""))
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
    """The file's object, validated, with each agent's `prompt` resolved to an absolute path and the keys it reads and
    ignores left out (without_ignored); {} when there is none."""
    data = _raw(path)
    problems = _problems(data, scope, path.parent)
    if problems:
        raise ConfigError(f"thimble's config {path}: " + "; ".join(problems))
    data = without_ignored(data)
    for conf in (data.get("agents") or {}).values():
        if isinstance(conf, dict) and isinstance(conf.get("prompt"), str):
            conf["prompt"] = str(_prompt_path(conf["prompt"], path.parent).resolve())
    return data


def _ignored_paths(data: dict[str, Any]) -> list[tuple[str, ...]]:
    """The paths in a file's object that are read and ignored (module note, one fence): IGNORED_TOP, IGNORED_KEYS, and
    a `web` other than "off" of an agent other than the orientation that runs as a subagent."""
    out = [(k,) for k in IGNORED_TOP if k in data]
    agents = data.get("agents") if isinstance(data.get("agents"), dict) else {}
    for name, conf in agents.items():
        if not isinstance(conf, dict):
            continue
        out += [("agents", name, k) for k in IGNORED_KEYS.get(name, ()) if k in conf]
        if name in SUBAGENT_ROLES and name != "orientation" and conf.get("web") not in (None, "off"):
            out.append(("agents", name, "web"))
    return out


def without_ignored(data: dict[str, Any]) -> dict[str, Any]:
    """A copy of a file's object without the keys it reads and ignores (_ignored_paths), and without an agent object
    that leaves empty."""
    out = copy.deepcopy(data)
    for path in _ignored_paths(data):
        _put(out, path, _MISSING)
    return out


def ignored(c: str | None = None) -> list[str]:
    """The keys the config files of workspace `c` (thimble's home's alone without one) hold and this build reads and
    ignores, each as `<key path>` (module note, one fence); a file that cannot be read adds none."""
    out: list[str] = []
    for path in [global_file(), *([workspace_file(c)] if c else [])]:
        try:
            data = _raw(path)
        except (ConfigError, ValueError):
            continue
        out += [".".join(p) for p in _ignored_paths(data) if ".".join(p) not in out]
    return out


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


def set_extension_enabled(name: str, on: bool) -> None:
    """`thimble extension on | off <name>`: `extensions.<name>.enabled: false` in the file in thimble's home for off,
    the key taken out for on, since an added extension is on. ConfigError when the file cannot be read."""
    with _lock:
        data = _raw(global_file())
        before = copy.deepcopy(data)
        _put(data, ("extensions", name, "enabled"), _MISSING if on else False)
        if data != before:
            _write(global_file(), data)


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
        for p, _ in files:  # a save from the Settings pane drops the keys this build ignores (module note, one fence)
            if held[p] != before[p]:
                held[p] = without_ignored(held[p])
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
    """An earlier build's `models` (less main's) and `permission_modes` as settings of this file: each role's model and
    effort, and its fast mode where the agent still takes one, the orientation subagents' model and effort as the
    orientation's subagentModel and subagentEffort, and the dev agent's row, or `views` where its own row is not set, the
    stricter of the two when both are. The other agents' rows are left out: they run in main's mode now (module note, one
    fence)."""
    by_role = {role: name for name, role in ROLES.items()}
    agents: dict[str, dict[str, Any]] = {}
    for role, conf in models.items():
        if not isinstance(conf, dict):
            continue
        effort = str(conf.get("effort") or "").strip().lower()
        if role in ("subagents", "readers"):
            model = conf.get("model")
            if isinstance(model, str) and model.strip():
                agents.setdefault("orientation", {})["subagentModel"] = model.strip()
            if effort in config.ROLE_EFFORTS:
                agents.setdefault("orientation", {})["subagentEffort"] = effort
            continue
        name = by_role.get(role)
        if name is None:
            continue
        mine: dict[str, Any] = {}
        if isinstance(conf.get("model"), str) and conf["model"].strip():
            mine["model"] = conf["model"].strip()
        if effort and (effort in config.role_efforts(role) or role == "orient" and effort in config.LEGACY_EFFORTS):
            mine["effort"] = effort
        if isinstance(conf.get("fast"), bool) and "fast" in DEFAULTS["agents"][name]:
            mine["fast"] = conf["fast"]
        if mine:
            agents.setdefault(name, {}).update(mine)
    got = {a: m for a, m in rows.items() if m in PERMISSION_MODES and a in ("dev", "views")}
    if "views" in got:
        view = got.pop("views")
        got["dev"] = min(got.get("dev", view), view, key=_STRICT.__getitem__)
    if "dev" in got:
        agents.setdefault("dev", {})["permissionMode"] = got["dev"]
    return {"agents": agents} if agents else {}


def pane_patch(models: dict[str, Any] | None, rows: dict[str, Any] | None) -> dict[str, Any]:
    """The Settings pane's changes as settings of this file: `models` {role: {model?, effort?, fast?, off?}} (main's left
    out, '' for back to the default; `subagents` is thimble:helper's row, the orientation's subagentModel and
    subagentEffort; `fast` only for an agent that takes it, `off` only for the refusal row; an extension's agent,
    "<ext>:<name>", takes its model and effort only) and `rows` {row of modes.AGENTS: mode, None for main's}, `views`
    being the dev agent's row of earlier builds. A row of an agent that runs in main's mode now, which an earlier tab may
    send, is left out (modes.IGNORED_ROWS)."""
    from . import modes  # noqa: PLC0415 — modes imports this module

    by_role = {role: name for name, role in ROLES.items()}
    agents: dict[str, dict[str, Any]] = {}
    for role, conf in (models or {}).items():
        if not isinstance(conf, dict) or role == "main":
            continue
        if role in ("subagents", "readers"):
            for k, key in (("model", "subagentModel"), ("effort", "subagentEffort")):
                if k in conf:
                    agents.setdefault("orientation", {})[key] = str(conf[k] or "").strip() or None
            continue
        name = by_role.get(role)
        if name is None and EXTENSION_AGENT_RE.match(role):
            for k in ("model", "effort"):
                if k in conf:
                    agents.setdefault(role, {})[k] = str(conf[k] or "").strip() or None
            continue
        if name is None:
            raise ConfigError(f"no role {role!r}; one of {', '.join(by_role)}, or an extension's agent")
        for k in ("model", "effort", "fast", "off"):
            if k in conf and k in DEFAULTS["agents"][name]:
                v = conf[k]
                agents.setdefault(name, {})[k] = (str(v).strip() or None) if k in ("model", "effort") and v is not None else v
    for row, mode in (rows or {}).items():
        if row in modes.IGNORED_ROWS:
            continue
        agents.setdefault(agent_of_row("dev" if row == "views" else row), {})["permissionMode"] = mode
    return {"agents": agents} if agents else {}


def migrate(c: str) -> bool:
    """Bring workspace `c`'s config up to date: each renamed extension's settings in its override under the new name
    (rename_extensions), and an earlier build's models and permission modes moved into it (_move_settings). True when
    something moved."""
    if not config._valid_name(c):
        return False
    renamed = rename_extensions(workspace_file(c))
    return _move_settings(c) or renamed


def _move_settings(c: str) -> bool:
    """Move an earlier build's models and permission modes out of workspaces/<c>/settings.json into the workspace's
    override (legacy_patch), where a value the override already holds stays; True when something moved. A settings
    file that cannot be read, or an override with an error, is left for a later read."""
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
    """The agent of a row of modes.AGENTS, or of one of an earlier build's rows (modes.IGNORED_ROWS), which name the
    agent's role."""
    return next(name for name, r in {**ROLES, **MODE_ROWS}.items() if r == row)


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
    conf: dict[str, Any]  # the agent's settings, with main's fence's keys for an agent that shares them (agent_conf)
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

    @staticmethod
    def _edited(tool: str, inp: Any) -> Path | None:
        """The file a call of `tool` writes, resolved, when it is an edit tool's call with an absolute path; else None."""
        if tool not in EDIT_TOOLS or not isinstance(inp, dict):
            return None
        target = inp.get("notebook_path" if tool == "NotebookEdit" else "file_path")
        if not isinstance(target, str) or not target.strip():
            return None
        path = Path(target.strip()).expanduser()
        return Path(os.path.realpath(path)) if path.is_absolute() else None

    def edits_corpus(self, tool: str, inp: Any) -> bool:
        """Whether a call of `tool` writes a file in the corpus folder."""
        real, corpus = self._edited(tool, inp), self.corpus()
        if real is None or corpus is None:
            return False
        return real == corpus or corpus in real.parents

    def config_files(self) -> list[Path]:
        """thimble's config files, whose edits ask (config_files)."""
        return config_files(self.c)

    def edits_config(self, tool: str, inp: Any) -> bool:
        """Whether a call of `tool` writes one of thimble's config files (config_files)."""
        real = self._edited(tool, inp)
        return real is not None and any(real == Path(os.path.realpath(f)) for f in self.config_files())

    @property
    def bash_asks(self) -> bool:
        """Whether every Bash command goes to the analyst: an agent of ASK_WITHOUT_SANDBOX whose network is off and whose
        Bash runs outside the sandbox, in a session somebody answers."""
        return self.agent in ASK_WITHOUT_SANDBOX and not self.network and not self.sandboxed and self.hosted

    def settings(self) -> dict[str, Any]:
        """The --settings keys of the config for the session: Bash asked when bash_asks, the web allowed or denied, auto
        memory when not inherited, an ask of edits to the config's files (a deny in a session nobody answers), and a deny
        of edits to main's kept mode (main_modes_file). No rule for installs, which follow the session's permission mode
        (module note, one fence)."""
        config_rules = [f"Edit(/{f})" for f in self.config_files()]
        perms: dict[str, list[str]] = {"deny": [f"Edit(/{main_modes_file()})", *private_rules()]}
        if self.hosted:
            perms["ask"] = config_rules
        else:
            perms["deny"] += config_rules
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

    def may_ask(self) -> bool:
        """Whether a call can go to the analyst whatever the permission mode (verdict): in any session somebody answers,
        since an edit of the config's files always does."""
        return self.hosted or self.bash_asks or self.data == "ask"

    def verdict(self, tool: str, inp: Any) -> str:
        """`deny` or `ask` when the config refuses a call or sends it to the analyst whatever the permission mode: an
        edit of the config's files (module note, edits of the config), refused in a session nobody answers; an edit of
        the corpus by `data`; for a Bash call, an install command refused when offline (a view build with no network)
        and, when bash_asks, any other command; `own` for one of the session's own commands then, which runs unasked; ''
        for any other call, an install among them, which the permission mode decides (module note, one fence)."""
        if self.edits_config(tool, inp):
            return "ask" if self.hosted else "deny"
        if self.data != "allow" and self.edits_corpus(tool, inp):
            return "deny" if self.data == "off" else "ask"
        command = inp.get("command") if tool == "Bash" and isinstance(inp, dict) else None
        if not isinstance(command, str):
            return ""
        if self.offline and sandbox_allow.installs(command):
            return "deny"
        if self.bash_asks:
            return "own" if allow_own(command, self.own_bash) else "ask"
        return ""

    def ask_cause(self, tool: str, inp: Any) -> str:
        """What makes verdict() send a call to the analyst: `config` for an edit of the config's files, `data` for an
        edit of the corpus, `commands` for a command while bash_asks."""
        if self.edits_config(tool, inp):
            return "config"
        if self.data != "allow" and self.edits_corpus(tool, inp):
            return "data"
        return "commands"


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


def agent_conf(conf: dict[str, Any], agent: str, *, program: bool = False) -> dict[str, Any]:
    """The settings a session of `agent` runs with, from a loaded config: an agent that runs as a subagent of main takes
    main's fence's `network`, `data` and `web` (the orientation's), and its own `web` only when that is "off" (module
    note, one fence); the dev agent and the classifiers keep their own. With `program`, for an extension's program that
    runs the agent, the agent's own PROGRAM_KEYS, each PROGRAM_DEFAULTS' where it sets none (module note, extensions'
    programs)."""
    mine = dict(conf["agents"][agent])
    if agent not in SUBAGENT_ROLES:
        return mine
    own = {k: copy.deepcopy(mine[k]) if mine.get(k) is not None else copy.deepcopy(v) for k, v in PROGRAM_DEFAULTS.items()}
    main = conf["agents"]["orientation"]
    own_web = mine.get("web")
    mine.update(network=main.get("network") or "on", data=main.get("data") or "ask",
                web="off" if own_web == "off" else main.get("web") or "ask")
    return {**mine, **own} if program else mine


def session(c: str | None, agent: str, *, sandbox: bool = True, program: bool = False) -> Session:
    """What the config asks of a session of `agent` in workspace `c` (agent_conf); `sandbox` False for a session the
    caller runs outside the sandbox, `program` for an extension's program that runs the agent or one of its tasks
    (module note, extensions' programs). The dev agent, or a program, runs outside the sandbox when its own `sandbox` is
    "off". ConfigError when the config has an error, or requires the sandbox (`sandbox.enforce`, on by default) and the
    session of an agent whose sandbox is on would run outside it (NO_SANDBOX)."""
    conf = load(c)
    box = conf["sandbox"]
    mine = agent_conf(conf, agent, program=program)
    if (program or agent not in SUBAGENT_ROLES) and mine.get("sandbox") == "off":
        return Session(c, agent, mine, False)
    runs = box["use"] != "never" and sandbox_runs()
    if box["enforce"] and sandbox and not runs and box["use"] != "never":
        runs = sandbox_runs(refresh=True)  # the analyst may have installed what it needs since the last check
    if box["enforce"] and not (sandbox and runs):
        key = ("outside" if not sandbox else "never" if box["use"] == "never" else
               "env" if os.environ.get("THIMBLE_SANDBOX", "").strip() == "0" else "missing")
        why, fix = NO_SANDBOX_WHY[key]
        raise ConfigError(NO_SANDBOX.format(why=why, agent=agent, fix=fix).strip())
    return Session(c, agent, mine, sandbox and runs, enforced=bool(box["enforce"]))


# --------------------------------------------------------------------------- main's fence


def config_files(c: str | None) -> list[Path]:
    """thimble's config files, whose edits ask (module note, edits of the config): the one in thimble's home and the
    workspace's."""
    return [global_file(), *([workspace_file(c)] if c else [])]


class Rule(NamedTuple):
    """One permission rule of main's fence (main_rules): Claude Code's `behavior` list it goes in (ask, deny or allow),
    the rule, and its `cause`: `data` (an edit of the corpus), `config` (an edit of thimble's config), `web` (the web
    tools), `private` (thimble's token files and the links folder) or `state` (the files thimble keeps its records in)."""

    behavior: str
    rule: str
    cause: str


LINKS_DIR = "links"  # under thimble's home: the dashboard link with its key, briefly (cli.LINKS_DIR)
# the workspace's files and folders main and its agents may not edit, since thimble keeps its records there: the checks,
# the chats, the extensions' state, the run record, the files the hooks trust (subagents.json, callers.jsonl,
# launch.json) and the views' state (proposals with their attempt counts, the versions readers are served)
STATE_PATHS = ("checks/**", "chats/**", "extensions/**", "extension/extension.json", "orient/run.json",
               "subagents.json", "callers.jsonl", "launch.json", "views/**")
TICKET_FILES = ("tickets.jsonl", "applies.jsonl")  # in a development install's dev folder: the code tickets' records


def dev_files() -> list[Path]:
    """The code tickets' records main may not edit in a development install (dev.DEV_DIR's rule, which this module does
    not import), which hold the change their checks passed; none in an installed copy."""
    if not (config.REPO_ROOT / ".git").exists():
        return []
    folder = Path(os.environ.get("THIMBLE_DEV_DIR") or config.REPO_ROOT / "dev")
    return [folder / name for name in TICKET_FILES]


def main_rules(c: str) -> list[Rule]:
    """The permission rules of main's fence for workspace `c` (cli.main_fence; module note, one fence), each with its
    cause: an edit of the corpus asks, or is denied or left to the mode, by the orientation's `data`; an edit of
    thimble's config files or the workspace's settings.json asks; the web tools ask, are denied or are allowed by its
    `web`; main's kept mode, the workspace's records (STATE_PATHS) and the code tickets' (dev_files) are not edited; the
    token files and the links folder are neither read nor edited; the critique folder is read unasked, since the critic
    reads its digest and brief there. No rule for installs, which follow Claude Code's permission mode. A config with an
    error gives the defaults' rules."""
    conf = agent_conf(load_or_defaults(c)[0], "orientation")
    ws = config.WORKSPACES_DIR.resolve() / c
    out: list[Rule] = []
    corpus = f"Edit(/{Path(os.path.realpath(config.corpus_dir(c)))}/**)"
    if conf["data"] == "ask":
        out.append(Rule("ask", corpus, "data"))
    elif conf["data"] == "off":
        out.append(Rule("deny", corpus, "data"))
    out += [Rule("ask", f"Edit(/{f})", "config") for f in [*config_files(c), ws / "settings.json"]]
    web = {"ask": "ask", "off": "deny", "allow": "allow"}[conf["web"] if conf["web"] in WEB else "ask"]
    out += [Rule(web, t, "web") for t in WEB_TOOLS]
    out.append(Rule("deny", f"Edit(/{main_modes_file()})", "state"))
    out += [Rule("deny", f"Edit(/{ws / p})", "state") for p in STATE_PATHS]
    out += [Rule("deny", f"Edit(/{f})", "state") for f in dev_files()]
    out += [Rule("deny", r, "private") for r in private_rules()]
    links = global_file().parent / LINKS_DIR
    out += [Rule("deny", f"Read(/{links}/**)", "private"), Rule("deny", f"Edit(/{links}/**)", "private")]
    out.append(Rule("allow", f"Read(/{ws / 'critique'}/**)", "state"))
    return out


# --------------------------------------------------------------------------- prompts


# the agents whose prompt file is a task's (tasks.TASK_PROMPTS), which the active extensions' tasks change
TASK_AGENTS = ("labels", "cardCheck", "checks")


def prompt_files(c: str | None, agent: str) -> dict[str, Path]:
    """{prompt file: the file that replaces it} for `agent` in workspace `c` (prompts.custom): the config's `prompt`,
    else the role's prompt, or the task's, as the active extensions change it (roles.prompt_file, tasks.files); {} for
    none."""
    value = load_or_defaults(c)[0]["agents"][agent].get("prompt")
    if isinstance(value, str) and value:
        return {PROMPT_FILES[agent]: Path(value)}
    from . import roles, tasks  # noqa: PLC0415 — roles reads the extensions, which import this module

    if agent in TASK_AGENTS:
        return tasks.files(c, PROMPT_FILES[agent])
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
