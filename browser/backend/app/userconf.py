"""thimble's config for its agents: $THIMBLE_HOME/config.json (THIMBLE_HOME, else ~/.thimble), and an optional override
for one workspace, workspaces/<c>/config.json. docs/config.md documents every key.

Layers, lowest first: DEFAULTS, the file, the workspace's override. An object merges key by key (`sandbox`, `agents` and
each agent); any other value replaces the one below it, null included, which stands for thimble's default.

A file that does not parse, or a key or value this module does not know, is a ConfigError that names the file, the key
and what it takes. No agent session starts while the config has one (session); the Settings pane and `thimble doctor`
show it. The models and efforts are read leniently (load_or_defaults), so the pages still show.

Edits of the config. An agent's edit of these files (config_files) goes to the analyst in every permission mode, as an
edit of the corpus does with `data` at "ask" (Session.verdict, ask_cause `config`), so the analyst sees on the card what
an agent would change in its own permissions and decides; a session nobody answers is refused it. main's kept mode
(main_modes_file), which only thimble writes, stays denied.

One fence for main and its agents. thimble's agents are subagents of main and run in main's permission mode; thimble
adds no rule, working directory or sandbox to main's session. So the orientation's `web`, `network` and `data` are
main's keys, which every agent shares; the other agents keep only `web: off`, which keeps that one agent off the web
tools. Code tickets' agents are subagents of main too. The dev agent alone
keeps its own permission mode and fence keys, for `thimble fix`, which stays a job of the server, and its own fast
mode, for its agents and `thimble fix` (subagents.fast_for), which is main's while this file sets none
(config.models_for).
Installs follow Claude Code's permission mode: thimble adds no rule for them. The web tools do too at `web` "ask":
Manual asks for them as Claude Code does, and auto mode's classifier judges them. An `ask` rule would also ask in auto
mode, since Claude Code obeys an explicit ask rule there (live check: the checks asked three times for the web in auto
mode). The keys earlier builds read for this,
`installs`, and each agent's own `fast` and `permissionMode` and `web` other than "off" but the dev agent's, and the
`env`, `sandbox`, `network` and `data` of an agent that shares main's fence or makes one model call (IGNORED_KEYS),
are read and ignored, so an earlier config stays valid; `ignored` lists those a file holds, and a save from the
Settings pane leaves them in the file. `suggest` (the viewer suggestion's call) and `refusal` (the model and effort a
refused classifier call runs again on, which `off` turns off) are classifier rows.
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
AGENTS = ("orientation", "critic", "writer", "checks", "dev", "labels", "cardCheck", "suggest", "refusal")
CALLS = ("labels", "cardCheck")  # one model call each, with no tools
# each agent's role among config.MODEL_ROLES
ROLES = {"orientation": "orient", "critic": "critic", "writer": "writer", "checks": "checks", "dev": "dev",
         "labels": "labels", "cardCheck": "verify", "suggest": "suggest", "refusal": "refusal"}
# each agent's row among modes.AGENTS: the dev agent's alone; every other agent, code tickets' among them, runs in main's
# mode (module note, one fence)
MODE_ROWS = {"dev": "dev"}
SUBAGENT_ROLES = ("orientation", "critic", "writer", "checks")  # the agents that run as subagents of main
# the keys of each agent that earlier builds read and this one reads and ignores (module note, one fence)
IGNORED_KEYS: dict[str, tuple[str, ...]] = {
    "orientation": ("fast", "permissionMode"),
    **{a: ("fast", "permissionMode", "env", "sandbox", "network", "data") for a in ("critic", "writer", "checks")},
    **{a: ("env", "network", "data") for a in CALLS},
}
IGNORED_TOP = ("installs",)  # top-level keys read and ignored
# the prompt file under prompts/ that an agent's `prompt` replaces; the labels agent's is the label classifier's text,
# which the terminal plugin reads too (plugin/prompts/labels.md)
PROMPT_FILES = {"orientation": "orient", "critic": "critic", "writer": "writer", "checks": "check", "dev": "dev",
                "labels": "plugin:labels", "cardCheck": "card-check"}
SANDBOX_USES = ("when-available", "never")
BROWSERS = ("system", "bundled", "off")
# `askKey`: the key held with a click to ask about what it points at in the browser (pointer/CmdPointer), "meta" (⌘, or
# Ctrl off a Mac) or "alt" (⌥, or Alt); the other one places a card freely on the canvas (ask_key)
ASK_KEYS = ("meta", "alt")
WEB = ("ask", "off", "allow")
NETWORK = ("off", "on")
AGENT_SANDBOX = ("on", "off")
DATA = ("ask", "allow", "off")
ENV_NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,127}$")
# `cardWait`: the minutes a permission card waits for the analyst before an unanswered request is declined
# (card_wait_s), at most half a day
CARD_WAIT_MINUTES = 10
CARD_WAIT_MAX = 720
SERVER_JSON = "server.json"  # in thimble's home: the server's address and the token of its local API (hook_auth)
MAIN_MODES = "main-modes.json"  # in thimble's home: the permission mode main last reported, per workspace (session.note_mode)
SESSION_KEY = "session.key"  # in thimble's home: the secret of the sessions' tokens (hook_auth.SESSION_KEY)
LINK_KEY = "link.key"  # in thimble's home: the key the sign-in link carries (hook_auth.LINK_KEY)
PAIRED_JSON = "paired.json"  # in thimble's home: the hashes of the browsers signed in (hook_auth.PAIRED_FILE)
BYPASS_JSON = "bypass.json"  # in thimble's home: the rows the analyst chose Bypass for in Settings (bypass_file)
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
    for main's), its CLAUDE.md files (`memory`) and its prompt."""
    return {"model": None, "effort": None, "web": web, "memory": "inherit", "prompt": None}


DEFAULTS: dict[str, Any] = {
    "sandbox": {"use": "when-available", "enforce": False},
    "browser": None,
    "cardWait": CARD_WAIT_MINUTES,
    "askKey": None,
    "agents": {
        # the orientation's web, network and data are main's fence's (module note, one fence); subagentModel and
        # subagentEffort are thimble:orient-helper's, the type of the orientation's own subagents
        "orientation": {**_subagent("ask"), "network": "on", "data": "ask", "subagentModel": None,
                        "subagentEffort": None},
        "critic": _subagent(None),
        "writer": _subagent(None),
        "checks": _subagent(None),
        # its `fast` is its agents' and `thimble fix`'s (subagents.fast_for); null follows main's fast mode
        "dev": _session_agent("off"),
        **{a: {"model": None, "effort": None, "fast": None, "prompt": None} for a in CALLS},
        "suggest": {"model": None, "effort": None, "fast": None},
        "refusal": {"model": None, "effort": None, "off": None},
    },
    # `views.propose`: whether thimble shows the analyst view proposals, after a turn and for a file type
    # (propose_views); null is on, and the view proposal card's Don't ask again sets it false
    "views": {"propose": None},
}
# `agents.cardCheck.auto`: whether the card check reads each new card by itself (card_check.auto); null is on
DEFAULTS["agents"]["cardCheck"]["auto"] = None


def private_paths() -> list[str]:
    """The files a session thimble starts may not read or edit (private_rules, Session.settings): the local API's token,
    the key the sessions' tokens are signed with, the key the sign-in link carries, the hashes of the browsers signed in
    (hook_auth.PAIRED_FILE), and how the workbench reaches Claude."""
    return [str(global_file().parent / name) for name in (SERVER_JSON, SESSION_KEY, LINK_KEY, PAIRED_JSON,
                                                          "claude-access.json", "anthropic-api-key")]


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


def bypass_file() -> Path:
    """$THIMBLE_HOME/bypass.json, {"rows": [row], "at": iso}: the rows the analyst chose Bypass for in Settings, which
    only modes.choose writes (from the settings PUT, which only the analyst's browser may make). Server jobs' settings
    deny file tools any edit of it (Session.settings)."""
    return global_file().parent / BYPASS_JSON


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


def ask_key() -> str:
    """The key held with a click to ask in the browser: `askKey` of the file in thimble's home, else "meta", also when
    the file has an error."""
    try:
        got = _raw(global_file()).get("askKey")
    except ConfigError:
        got = None
    return got if got in ASK_KEYS else ASK_KEYS[0]


def propose_views(c: str | None) -> bool:
    """Whether thimble shows the analyst view proposals in workspace `c` (views.propose_enabled): on unless
    `views.propose` is false, and on while the config has an error, as the other keys then take their defaults
    (load_or_defaults)."""
    return load_or_defaults(c)[0]["views"].get("propose") is not False


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

    keys("", data, (*IGNORED_TOP, "sandbox", "browser", "cardWait", "askKey", "agents", "views"))
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
    if "askKey" in data:
        if scope != "global":
            out.append("askKey is set for the whole machine, in the config in thimble's home, not per workspace")
        else:
            one_of("askKey", data["askKey"], ASK_KEYS, null=True)
    box = data.get("sandbox")
    if "sandbox" in data and keys("sandbox", box, ("use", "enforce")):
        if "use" in box:
            one_of("sandbox.use", box["use"], SANDBOX_USES)
        if "enforce" in box and not isinstance(box["enforce"], bool):
            out.append(f"sandbox.enforce is {json.dumps(box['enforce'])}; it takes true or false")
        if box.get("use") == "never" and box.get("enforce") is True:
            out.append('sandbox.enforce is true while sandbox.use is "never", so no agent could run')
    if "views" in data and keys("views", data["views"], tuple(DEFAULTS["views"])):
        if "propose" in data["views"] and not isinstance(data["views"]["propose"], (bool, type(None))):
            out.append(f"views.propose is {json.dumps(data['views']['propose'])}; it takes true, false or null")
    agents = data.get("agents")
    if "agents" in data and keys("agents", agents, AGENTS):
        for name, conf in agents.items():
            if name in AGENTS:
                out.extend(_agent_problems(name, conf, base))
    return out


def _agent_problems(name: str, conf: Any, base: Path) -> list[str]:
    where = f"agents.{name}"
    known = tuple(DEFAULTS["agents"][name])
    if not isinstance(conf, dict):
        return [f"{where} must be an object"]
    out: list[str] = []
    for k, v in conf.items():
        at = f"{where}.{k}"
        if k in IGNORED_KEYS.get(name, ()):
            continue  # read and ignored (module note, one fence)
        if k not in known:
            extra = (f"; {name} runs one model call with no tools, so it takes only {', '.join(known)}" if name in CALLS
                     else f"; it takes {', '.join(known)}")
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
    """The config's error for workspace `c`, '' when it has none, each path in the home folder written from ~
    (home_as_tilde), as Settings, `thimble doctor` and the server's start line show it."""
    return home_as_tilde(load_or_defaults(c)[1])


def home_as_tilde(text: str) -> str:
    """`text` with each path that starts in the home folder written from ~ (`/home/me/.thimble` as `~/.thimble`)."""
    home = str(Path.home()).rstrip(os.sep)
    return text.replace(home + os.sep, "~" + os.sep) if home else text


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
    """Each (path, value) of a nested patch; an object under `agents.<name>`, `sandbox` or `views` is walked, any other
    value is a leaf."""
    out: list[tuple[tuple[str, ...], Any]] = []
    for k, v in patch.items():
        if isinstance(v, dict) and (len(at) < 2 and k in ("agents", "sandbox", "views") or at == ("agents",)):
            out.extend(leaves(v, (*at, k)))
        else:
            out.append(((*at, k), v))
    return out


def _write(path: Path, data: dict[str, Any]) -> None:
    """A config file written whole, in place (ledger.rewrite_text): a kernel wrapper hides a workspace's config.json
    and settings.json by a mount on each, which a new file renamed over it would take off inside a running kernel."""
    from .ledger import rewrite_text  # noqa: PLC0415 — ledger imports config, which imports this module lazily

    path.parent.mkdir(parents=True, exist_ok=True)
    rewrite_text(path, json.dumps(data, indent=2, ensure_ascii=False) + "\n")


def save(c: str | None, patch: dict[str, Any]) -> None:
    """Write a nested patch of settings, None for a value that goes back to the one below it. Each value goes where the
    value the Settings pane shows came from: the workspace's override when it sets that key, else the file in thimble's
    home. Only the patch's keys change: every other key stays as the file has it, the keys this build reads and ignores
    among them (module note, one fence). ConfigError, writing nothing, when either file has an error or the result
    would."""
    with _lock:
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


# --------------------------------------------------------------------------- the Settings pane's changes


def pane_patch(models: dict[str, Any] | None, rows: dict[str, Any] | None) -> dict[str, Any]:
    """The Settings pane's changes as settings of this file: `models` {role: {model?, effort?, fast?, off?}} (main's left
    out, '' for back to the default; `subagents` is thimble:orient-helper's row, the orientation's subagentModel and
    subagentEffort; `fast` only for an agent that takes it, `off` only for the refusal row) and `rows` {row of
    modes.AGENTS: mode, None for main's}, `views`
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
        if name is None:
            raise ConfigError(f"no role {role!r}; one of {', '.join(by_role)}")
        for k in ("model", "effort", "fast", "off"):
            if k in conf and k in DEFAULTS["agents"][name]:
                v = conf[k]
                agents.setdefault(name, {})[k] = (str(v).strip() or None) if k in ("model", "effort") and v is not None else v
    for row, mode in (rows or {}).items():
        if row in modes.IGNORED_ROWS:
            continue
        agents.setdefault(agent_of_row("dev" if row == "views" else row), {})["permissionMode"] = mode
    return {"agents": agents} if agents else {}



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
        perms: dict[str, list[str]] = {"deny": [f"Edit(/{main_modes_file()})", f"Edit(/{bypass_file()})",
                                                *private_rules()]}
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
# so the fix names no install command
NO_SANDBOX = "This agent's session runs only in Claude Code's Bash sandbox (sandbox.enforce), and {why}, so the {agent} agent did not start. {fix}"
NO_SANDBOX_WHY = {
    "outside": ("this agent's sessions run outside it", ""),
    "never": ('thimble\'s config turns it off (sandbox.use "never")',
              "To run the agents without it, set sandbox.enforce to false in thimble's config as well."),
    "env": ("THIMBLE_SANDBOX=0 turns it off", "Unset THIMBLE_SANDBOX and restart thimble to use it."),
    "missing": ("it can't run on this machine", ""),
}


def agent_conf(conf: dict[str, Any], agent: str) -> dict[str, Any]:
    """The settings a session of `agent` runs with, from a loaded config: an agent that runs as a subagent of main takes
    main's fence's `network`, `data` and `web` (the orientation's), and its own `web` only when that is "off" (module
    note, one fence); the dev agent and the classifiers keep their own."""
    mine = dict(conf["agents"][agent])
    if agent not in SUBAGENT_ROLES:
        return mine
    main = conf["agents"]["orientation"]
    own_web = mine.get("web")
    mine.update(network=main.get("network") or "on", data=main.get("data") or "ask",
                web="off" if own_web == "off" else main.get("web") or "ask")
    return mine


def session(c: str | None, agent: str, *, sandbox: bool = True) -> Session:
    """What the config asks of a session of `agent` in workspace `c` (agent_conf); `sandbox` False for a session the
    caller runs outside the sandbox. The dev agent runs outside the sandbox when its own `sandbox` is "off". ConfigError
    when the config has an error, or requires the sandbox (`sandbox.enforce`, off by default) and the session of an
    agent whose sandbox is on would run outside it (NO_SANDBOX)."""
    conf = load(c)
    box = conf["sandbox"]
    mine = agent_conf(conf, agent)
    if agent not in SUBAGENT_ROLES and mine.get("sandbox") == "off":
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


def config_files(c: str | None) -> list[Path]:
    """thimble's config files, whose edits ask (module note, edits of the config): the one in thimble's home and the
    workspace's."""
    return [global_file(), *([workspace_file(c)] if c else [])]


def main_web_off(c: str | None) -> bool:
    """Whether Settings has main's web off: the orientation's `web` in thimble's config, which is main's fence's (module
    note, one fence), as Settings' row for main shows it (ledger.agent_rows). Then the server's runtime gives its main
    neither WebFetch nor WebSearch (runtime.Space.spec_of), and main's prompt names neither (events.network_words). A
    config with an error gives the defaults'."""
    return agent_conf(load_or_defaults(c)[0], "orientation").get("web") == "off"


# --------------------------------------------------------------------------- prompts


def prompt_files(c: str | None, agent: str) -> dict[str, Path]:
    """{prompt file: the file that replaces it} for `agent` in workspace `c` (prompts.custom): the config's `prompt`;
    {} for none."""
    value = load_or_defaults(c)[0]["agents"][agent].get("prompt")
    if isinstance(value, str) and value:
        return {PROMPT_FILES[agent]: Path(value)}
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
