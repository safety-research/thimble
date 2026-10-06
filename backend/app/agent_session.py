"""The permission requests of the `claude -p` sessions of an extension's program (harness.py), the helpers `thimble
fix`'s session uses (dev.py), and the card on which a code ticket asks thimble's own questions about its code
(dev.CODE_TOOL). thimble's own agents, the code tickets' among them, are subagents of the analyst's Claude Code session
instead (subagents.py), which asks in its terminal; what stays here is what those jobs need: their fence, their config,
their permission hooks, and the hosting of their asks on a chat's card.

Hosted sessions. A job's session is not followed here, yet ask answers its PermissionRequest hook (permission_hook.py)
the same way for each: host registers one on its chat for the length of its run, with its agent's mode (modes.py, the
dev agent's row for an extension's program that runs the dev agent). A code ticket's chat is hosted for thimble's own
questions alone, which ask with `force`. A --print session has no terminal, so its hook hands each request of the session,
its subagents and workflow agents to ask, which shows it on the chat's card with Allow and Deny. In Bypass ask allows at
once; a request nobody answers is denied after the card's wait, `cardWait` in thimble's config (userconf.card_wait_s),
so no request waits for good. A request denied unanswered stays on the card, marked `expired`, until the analyst
dismisses it or the session ends. thimble's own tools and skills are always allowed (own_rules).

The web. WebFetch and WebSearch follow the mode in every session: in manual mode an `ask` rule sends each call to ask
(web_asks), over the analyst's own allow rules and Claude Code's list of documentation sites it fetches unasked, and in
auto mode the classifier judges them. The card offers "don't ask again" for the site, or for web search, kept for the
workspace in WEB_RULES_FILE in its registry folder, which a kernel cannot write, and which every session's later
request of it meets (web_rules). While a request waits, the session's later requests for the same site or for search
wait on the same card (`groups`), each listed on it whole, up to WEB_ALSO_MAX. The card's answer says how many it listed
(`shown`); a later one it did not list is asked on its own once the answer comes.

Don't ask again. The request's `permission_suggestions` become the card's third choice (offer); chosen, they are sent
as `updatedPermissions` with destination session and kept on the chat's meta (RULES_KEY).

Auto mode. A call auto mode's classifier refuses never reaches the PermissionRequest hook, so the hook also runs on
PermissionDenied: the card asks the analyst, and an allow answers `retry` and is remembered (`grants`, `passes`, for
GRANT_TTL_S) so a PreToolUse hook (before_call) lets the call made again run. A refusal only because the classifier was
unavailable (CLASSIFIER_DOWN) is no verdict: after each of CLASSIFIER_WAITS_S the hook answers `retry` with nothing
remembered, so auto mode judges the call made again, and only then does the card ask.

The fence. A job's caller passes its `work` folder (fence), which keeps the corpus folder read-only and its writes in
that folder: its --settings deny Edit in the corpus and exclude the CLAUDE.md files of the work folder's ancestry
(memory_excludes); where the sandbox can run, it reaches the network only while its agent's `network` is on. A
SubagentStart hook gives each of its subagents its own scratch folder, and a PostToolUse hook tells the session when its
work folder grows past WORK_BUDGET (scratch_hooks, plugin/bin/.thimble-watch --scratch and --work-budget). A caller that
passes `unasked` also auto-allows Bash in the sandbox and edits in the work folder (sandbox_allow.py).

The config. thimble's config (userconf.py) adds its rules to the session's --settings (userconf.Session.settings): the
web tools allowed or taken away, auto memory when it is not inherited, an ask of edits to thimble's config files, and,
where the session's network is off and its Bash runs outside the sandbox, an ask of every Bash command. A command that
ask covers, and an edit of the config's files, goes to the card in every mode, Bypass included
(userconf.Session.verdict), and the call it allowed is let through (`cleared`).
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import re
import shlex
import sys
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from . import agents, cc_settings, config, hook_auth, modes, permission_hook, sandbox_allow, session, tools, \
    userconf
from .ledger import atomic_write_text

log = logging.getLogger("thimble.agent_session")
router = APIRouter()
CLAUDE_BIN = config.CLAUDE_BIN
PLUGIN_DIR = config.REPO_ROOT / "plugin"
SESSION_ENV = "THIMBLE_SESSION"  # the shim's name for the session it serves (plugin/bin/thimble-mcp)
# What the shared skill renders after the preamble, appended here, since Claude Code preloads no skill for the agent a
# session runs as. The preamble is not appended: the agent's own body includes it.
SHARED_PROMPTS = ("shared",)
STEP_ROLE = agents.STEP_ROLE  # a subagent or workflow agent of the session
HOOK_POLL_S = 1.0  # how often a waiting request checks that its hook is still there
# of a request's input the card shows, scrolled; past it the entry's `cut` is the input's length and the card offers
# no "don't ask again"
PERMISSION_INPUT_CHARS = 50_000
# analyst-facing lines, and the deny messages Claude Code passes to the session's model
DENIED_LINE = "Denied from thimble's browser."
CONFIG_DENIED_LINE = "thimble's config refuses this command."  # userconf: `installs` is "deny"
TIMED_OUT_LINE = ("Nobody answered in thimble's browser within {wait}, so the call was denied. Carry on without it, "
                  "or find a way that needs no permission.")
GONE_LINE = "The session ended before it was answered."
NOBODY_WAITS = "none: nothing waits on it any more"  # the permission log's word for a request taken off unanswered
NO_ONE_LINE = ("Nobody can answer this session's requests, since the program that started it has no thread in "
               "thimble's browser, so the call was denied. Carry on without it.")
ALLOWED_LINE = "Allowed in thimble's browser."  # a refused call made again, once allowed (module note, auto mode)
SANDBOX_HOOK = Path(__file__).with_name("sandbox_allow.py")  # module note, the fence
SANDBOX_HOOK_TIMEOUT_S = 10
SCRATCH_PROMPT = "session-scratch"  # prompts/tools.md: the line that names it
WORK_BUDGET = 2 * 1000 ** 3  # bytes
WORK_BUDGET_PROMPT = "work-budget"  # prompts/tools.md: the warning's line
PERMISSION_HOOK = Path(__file__).with_name("permission_hook.py")  # module note, permissions
REQUEST, DENIED, PRE = permission_hook.REQUEST, permission_hook.DENIED, permission_hook.PRE  # its events
# how long the analyst's answer to a call auto mode refused waits for the model to make that call again (module note,
# auto mode)
GRANT_TTL_S = 600.0
# auto mode's reason when its classifier gave no verdict on a call, and the waits before each time the call goes back to
# auto mode (module note, auto mode). Claude Code reads only `retry` from a PermissionDenied hook, so a deny carries no
# message to the model.
CLASSIFIER_DOWN = re.compile(r"\bclassifier\b.*\bunavailable\b|\bno safety verdict\b", re.I)
CLASSIFIER_WAITS_S = (10.0, 30.0, 90.0)
BYPASS = "bypass"
# the answers that allow a request with the "don't ask again" updates Claude Code suggested for it, and a waiting one
# those updates cover (module note, don't ask again)
ALWAYS, COVERED = "always", "covered"
EDIT_MODE = "acceptEdits"  # the one mode a suggestion may switch a session to (offer)
RULES_KEY = "session_rules"  # on the session's chat meta: [{text, update}], the updates the analyst chose
CACHE_DIR = ".cache"  # in the work folder: XDG_CACHE_HOME and MPLCONFIGDIR of a fenced session (module note, the fence)
# The prompts the shared skill's command prints (plugin/skills/shared), rendered for a fenced session into this folder
# of its work folder and named by RENDERED_ENV for plugin/bin/thimble, which prints them from there (module note, the
# fence)
SKILL_PROMPTS = ("preamble", "shared")
RENDERED_DIR = ".thimble-prompts"
RENDERED_ENV = "THIMBLE_RENDERED_PROMPTS"
# Claude Code loads an added directory's CLAUDE.md only with this set: the corpus's own, for a fenced session whose
# process runs in its work folder (module note, the fence)
MEMORY_ENV = "CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD"
# each Bash command starts in the process's own folder, since a `cd` would carry over and Claude Code's sandbox makes a
# folder of its own in whatever folder a sandboxed command starts in, the corpus folder among them
HOME_SHELL_ENV = "CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR"
# the files under a folder that Claude Code loads as memory (claudeMdExcludes takes absolute paths and globs)
MEMORY_FILES = ("CLAUDE.md", "CLAUDE.local.md", ".claude/CLAUDE.md", ".claude/rules/**")
RETRY_BASE_S = 30.0
RETRY_MAX_S = 300.0
RETRY_MIN_S = 1.0  # the shortest base RETRY_BASE_ENV may set, so a long streak never restarts the process at once
RETRY_JITTER = 0.2
RETRY_BASE_ENV = "THIMBLE_SESSION_RETRY_BASE_S"
RETRY_PROMPT = "session-retry"  # prompts/tools.md: the stdin prompt of a session started again after the wait
# A job's session never ends while its own background work runs: the tools that schedule a later turn are taken away,
# since a --print session exits before that turn comes, and --print waits for background agents and workflows however
# long they run (BG_WAIT_ENV).
LATER_TOOLS = ("ScheduleWakeup", "CronCreate", "CronDelete", "CronList")
# The web tools, which ask in a session in manual mode whatever else allows them (module note, the web), the process
# modes they ask in, and the workspace's file of the web rules the analyst kept, {"allow": [rule, ...]}.
WEB_TOOLS = tools.WEB_TOOLS
WEB_ASK_MODES = ("default", "acceptEdits")
WEB_RULES_FILE = "web_rules.json"
WORKSPACE = "workspace"  # the `destination` of a "don't ask again" update kept for the workspace, never sent to Claude Code
WEB_ALSO_MAX = 20  # the later requests that join a waiting web request, each listed on its card (`also`)
ALSO_CHARS = 300  # of a joining request's address or search; a longer one is a request of its own
TIMED_OUT = "timed out"  # the answer of a request nobody answered in time
BG_WAIT_ENV = "CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS"
BG_WAIT_MS = "0"  # no ceiling
# Claude Code aborts an MCP call that sends neither a result nor progress for this long (30 min by default). The shim
# reports progress every minute (plugin/bin/thimble-mcp), and this longer limit covers a Claude Code that ignores it.
IDLE_TIMEOUT_ENV = "CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT"
IDLE_TIMEOUT_MS = "14400000"  # 4 h
RESUMED_PROMPT = "session-resumed"  # prompts/tools.md: the stdin prompt of a session resumed after it ended early
LAUNCHED_AGENT_RE = re.compile(r"\bagentId:\s*(\w+)")  # in a background Agent call's result
LAUNCHED_TASK_RE = re.compile(r"\bTask ID:\s*(\S+)")  # in a Workflow call's result
RESUMED_AGENT_RE = re.compile(r'"resumedAgentId"\s*:\s*"(\w+)"')  # in a SendMessage's result that continued an agent
TASK_ID_RE = re.compile(r"<task-id>\s*(.*?)\s*</task-id>", re.S)  # a notification may name several tasks
# a long call Claude Code let run on, in its own words at the head of the call's result (an MCP tool's), so a result that
# only quotes them (a log, a transcript) is none
MOVED_TASK_RE = re.compile(r'\A\s*MCP tool "[^\n]*?\bmoved to the background as task (\w+)')
STOP_TOOL = "TaskStop"
STOPPED_TASK_RE = re.compile(r'"task_id"\s*:\s*"([^"]+)"')  # in a TaskStop's result, which no notification follows


def _now() -> str:
    return session._now()


@dataclass
class Run:
    """A job's session whose permission requests ask answers (host): its key, chat and mode, and what its requests
    and the analyst's answers left."""

    c: str
    key: str  # its THIMBLE_SESSION: a code ticket's, or an extension's program's
    chat: str
    sid: str
    cwd: Path
    role: str
    waits: dict[str, asyncio.Future] = field(default_factory=dict)  # permission request id -> the analyst's answer
    # (the analyst's excluded commands, their Bash ask rules) of an `unasked` session whose Bash runs in the sandbox,
    # for ask
    sandbox_rule: tuple[list[str], list[str]] | None = None
    config: userconf.Session | None = None  # what thimble's config asks of it (module note, the config)
    # calls the analyst allowed on the card before they ran (module note, the config), by grant_key: when
    cleared: dict[tuple[str | None, str, str], float] = field(default_factory=dict)
    mode: str = "manual"  # the mode it runs in, one of modes.MODES (module note, hosted sessions)
    groups: dict[str, str] = field(default_factory=dict)  # web rule -> the id of the request waiting for it (module note, the web)
    shown: dict[str, int] = field(default_factory=dict)  # answered request id -> how many joined calls its card listed
    asking: dict[str, tuple[str | None, str]] = field(default_factory=dict)  # request id -> (agent that asked, tool)
    forced: set[str] = field(default_factory=set)  # ids of the waiting requests thimble's config sends to the analyst
    # the analyst's answers to calls auto mode refused, by (agent, tool, input): (allowed, time.monotonic() when), which
    # the call made again meets before it runs (module note, auto mode)
    grants: dict[tuple[str | None, str, str], tuple[bool, float]] = field(default_factory=dict)
    # the allows among them by (agent, tool), each by its key in `grants`, which that agent's next call of the tool uses
    # up whatever its input (module note, auto mode)
    passes: dict[tuple[str | None, str], list[tuple[str | None, str, str]]] = field(default_factory=dict)
    # the calls sent back to auto mode after its classifier gave no verdict, by (agent, tool, input): (times, when)
    rechecks: dict[tuple[str | None, str, str], tuple[int, float]] = field(default_factory=dict)
    # the "don't ask again" updates the card offers for each waiting request, by its id, and those the analyst chose
    # (module note, don't ask again)
    offers: dict[str, list[dict[str, Any]]] = field(default_factory=dict)
    rules: list[dict[str, Any]] = field(default_factory=list)


_hosted: dict[tuple[str, str], Run] = {}  # by (workspace, key): the hosted sessions (module note, hosted sessions)
_unanswered: set[tuple[str, str]] = set()  # (workspace, key) of sessions nobody can answer, denied with NO_ONE_LINE


def settings_json(effort: str, env: dict[str, str] | None = None, **extra: Any) -> str:
    """The session's --settings: the caller's choices, and the effort as CLAUDE_CODE_EFFORT_LEVEL, which a flag
    setting's env gives over one in the folder's local settings (module note), beside the caller's own `env`."""
    return json.dumps({**extra, "env": {**(env or {}), cc_settings.EFFORT_ENV: effort}})


def with_home_shell(settings: dict[str, Any]) -> dict[str, Any]:
    """`settings` with HOME_SHELL_ENV in its `env`."""
    return {**settings, "env": {**(settings.get("env") or {}), HOME_SHELL_ENV: "1"}}


def role_agent(agent: dict[str, Any], conf: dict[str, Any]) -> dict[str, Any]:
    """An agent definition with the model and effort of its role in the settings popover (config.models_for) in place
    of its file's, where the role names them."""
    out = dict(agent)
    for key in ("model", "effort"):
        if conf.get(key):
            out[key] = conf[key]
    return out


def shared_prompt(cwd: Path) -> str:
    """shared.md rendered for the corpus folder, as main's append and the shared skill render it."""
    from . import events  # noqa: PLC0415 — events imports the views module, which this module does not otherwise need

    return events.render_prompts(SHARED_PROMPTS, str(cwd))


def own_rules() -> list[str]:
    """The --allowedTools of every session thimble starts (module note, permissions): every tool of the plugin's thimble
    server, by the server's rule main's launcher passes too (cli.MCP_TOOLS_RULE), and each of the plugin's own skills by
    its exact name, for the plugin copy the session loads (cli.skill_rules)."""
    from . import cli  # noqa: PLC0415 — cli is large, and the rules are the launcher's

    return [cli.MCP_TOOLS_RULE, *cli.skill_rules(PLUGIN_DIR)]


def web_asks(process_mode: str) -> list[str]:
    """The `permissions.ask` rules of a session whose process runs in Claude Code's `process_mode`: WEB_TOOLS in manual
    mode, none in auto mode, whose classifier judges them, or in bypassPermissions (module note, the web)."""
    return list(WEB_TOOLS) if process_mode in WEB_ASK_MODES else []


def with_web_asks(settings: dict[str, Any], process_mode: str) -> dict[str, Any]:
    """`settings` with its `permissions.ask` holding web_asks(process_mode) and no other web tool."""
    perms = dict(settings.get("permissions") or {})
    asks = [a for a in perms.get("ask") or [] if a not in WEB_TOOLS] + web_asks(process_mode)
    if asks:
        perms["ask"] = asks
    else:
        perms.pop("ask", None)
    return {**settings, "permissions": perms} if perms or "permissions" in settings else settings


thimble_tool = tools.thimble_tool  # a thimble tool's name as a session sees it
not_own = tools.not_own  # the session's --disallowedTools of thimble's tools, which leave it its own


def environ() -> dict[str, str]:
    """The environment of the session's `claude` process: config.launch_environ, the server's less the Claude Code
    session identity it may carry and thimble's own variables, with main's CLAUDE_CONFIG_DIR. Nothing of the session's
    own goes here: that goes in its --settings `env` (settings_env)."""
    return config.launch_environ()


def settings_env(c: str, key: str, extra: dict[str, str] | None = None) -> dict[str, str]:
    """The --settings `env` of the session `key` of workspace `c` (config.session_env): the server's THIMBLE_* values,
    `key` as THIMBLE_SESSION with a token that proves it (hook_auth.session_token), no THIMBLE_LAUNCHED, since the
    launcher started no such session, no ceiling on --print's background wait (BG_WAIT_ENV), a 4 h idle limit on a
    thimble call (IDLE_TIMEOUT_ENV), and `extra` on top."""
    return config.session_env({SESSION_ENV: key, hook_auth.SESSION_TOKEN_ENV: hook_auth.session_token(c, key),
                               BG_WAIT_ENV: BG_WAIT_MS, IDLE_TIMEOUT_ENV: IDLE_TIMEOUT_MS, **(extra or {})})


def _venv() -> Path:
    """The folder of the interpreter this server runs in (the backend's venv), whose bin goes first on a fenced
    session's PATH so Bash finds the same Python and libraries the cards use."""
    return Path(sys.prefix)


def memory_excludes(corpus: Path, work: Path, home: Path | None = None) -> list[str]:
    """claudeMdExcludes for a session whose process runs in `work`: the memory files of the work folder and of each folder
    above it up to the first that is also above the corpus folder. The walk stops below the home folder, whose
    `.claude/CLAUDE.md` is the analyst's own memory."""
    home = home if home is not None else Path.home()
    stop = {corpus, *corpus.parents, home, *home.parents}
    out: list[str] = []
    for folder in (work, *work.parents):
        if folder in stop:
            break
        out.extend(f"{folder}/{name}" for name in MEMORY_FILES)
    return out


def fence(corpus: Path, work: Path, sandbox: bool | None = None, unasked: bool = False, network: bool = False,
          auto_allow: bool = True, required: bool = False, data: str = "off") -> dict[str, Any]:
    """The --settings keys that keep the corpus folder as `data` (userconf.Session.data) says to a session whose process
    runs in its work folder `work`: the permissions and memory excludes always, and the sandbox, with no network unless
    `network`, where it runs (`sandbox` None asks cc_settings.sandbox_ok). `data` "off" denies edits of the corpus,
    "ask" asks about each (and its sandbox keeps Bash from writing it), "allow" lets the sandbox's Bash write it too.
    `unasked` adds the allows of the session's work in its own folder: edits in the work folder and Bash in the
    sandbox, by Claude Code itself too unless `auto_allow` is False; `required` as cc_settings.offline_sandbox takes
    it."""
    rule = f"Edit(/{corpus}/**)"
    perms: dict[str, Any] = {"additionalDirectories": [str(corpus)]}
    if data == "ask":
        perms["ask"] = [rule]
    elif data != "allow":
        perms["deny"] = [rule]
    if unasked:
        perms["allow"] = [f"Edit(/{work}/**)"]
    out: dict[str, Any] = {"permissions": perms, "claudeMdExcludes": memory_excludes(corpus, work)}
    if sandbox if sandbox is not None else cc_settings.sandbox_ok():
        box = cc_settings.offline_sandbox(auto_allow=unasked and auto_allow, network=network, required=required)
        if data == "ask":
            box["filesystem"] = {"denyWrite": [str(corpus)]}
        elif data == "allow":
            box["filesystem"] = {"allowWrite": [str(corpus)]}
        out["sandbox"] = box
    return out


def with_config(settings: dict[str, Any], conf: dict[str, Any]) -> dict[str, Any]:
    """`settings` with thimble's config's keys (userconf.Session.settings) added, each permission list joined, and its
    sandbox's read denies joined to the sandbox of `settings` when it has one."""
    perms = dict(settings.get("permissions") or {})
    for key, rules in (conf.get("permissions") or {}).items():
        perms[key] = list(dict.fromkeys([*(perms.get(key) or []), *rules]))
    out = {**settings, **{k: v for k, v in conf.items() if k not in ("permissions", "sandbox")}, "permissions": perms}
    reads = ((conf.get("sandbox") or {}).get("filesystem") or {}).get("denyRead") or []
    if reads and isinstance(settings.get("sandbox"), dict):
        box = dict(settings["sandbox"])
        fs = dict(box.get("filesystem") or {})
        fs["denyRead"] = list(dict.fromkeys([*(fs.get("denyRead") or []), *reads]))
        out["sandbox"] = {**box, "filesystem": fs}
    return out


def fence_env(work: Path) -> dict[str, str]:
    """A fenced session's environment on top of environ's: the venv's bin first on PATH, the caches in the work
    folder, since the home folder is not writable in the sandbox, and MEMORY_ENV, so the corpus's CLAUDE.md is read."""
    cache = work / CACHE_DIR
    with contextlib.suppress(OSError):
        cache.mkdir(parents=True, exist_ok=True)
    path = os.environ.get("PATH", "")
    return {"PATH": os.pathsep.join([str(_venv() / "bin"), *[p for p in path.split(os.pathsep) if p]]),
            "XDG_CACHE_HOME": str(cache), "MPLCONFIGDIR": str(cache / "matplotlib"), MEMORY_ENV: "1"}


def skill_prompts_env(corpus: Path, work: Path) -> dict[str, str]:
    """RENDERED_ENV for a fenced session: each of SKILL_PROMPTS rendered for the corpus folder `corpus` into
    `<work>/RENDERED_DIR/<name>.md`, the text `thimble prompt <name>` prints, which plugin/bin/thimble prints from there
    in that session (module note, the fence)."""
    from . import events  # noqa: PLC0415 — as in shared_prompt

    folder = work / RENDERED_DIR
    folder.mkdir(parents=True, exist_ok=True)
    for name in SKILL_PROMPTS:
        (folder / f"{name}.md").write_text(events.render_prompts([name], str(corpus)) + "\n", encoding="utf-8")
    return {RENDERED_ENV: str(folder)}


def sandbox_rule(cwd: Path) -> tuple[list[str], list[str]]:
    """What sandbox_allow leaves to the analyst's mode for a session in `cwd`: the commands their settings run outside
    the sandbox, and the contents of their Bash ask rules."""
    return cc_settings.sandbox_excluded(cwd), cc_settings.bash_ask_rules(cwd)


def sandbox_hooks(rule: tuple[list[str], list[str]], installs: bool = False) -> dict[str, Any]:
    """The `hooks` that allow a fenced session's Bash calls where they run in the sandbox (module note, the fence):
    sandbox_allow.py before every Bash call and on every Bash permission request, told `rule` (sandbox_rule) and with
    `installs`, to leave install commands to the permission flow (module note, the config)."""
    names, asks = rule
    flags = "".join(f" --exclude {shlex.quote(n)}" for n in names) + "".join(f" --ask {shlex.quote(a)}" for a in asks)
    flags += " --installs" if installs else ""
    command = f"{shlex.quote(sys.executable)} -S {shlex.quote(str(SANDBOX_HOOK))}{flags}"
    entry = [{"matcher": "Bash", "hooks": [{"type": "command", "command": command, "timeout": SANDBOX_HOOK_TIMEOUT_S}]}]
    return {event: entry for event in sandbox_allow.EVENTS}


def scratch_hooks(work: Path) -> dict[str, Any]:
    """The `hooks` that give each subagent of a fenced session a scratch folder of its own in the work folder, with
    `## session-scratch` of prompts/tools.md as the line naming it, and that warn the session after a Bash call once
    the work folder holds more than WORK_BUDGET (the plugin's watcher, --scratch and --work-budget)."""
    watcher = shlex.quote(str(PLUGIN_DIR / "bin" / ".thimble-watch"))
    text = tools.hint(SCRATCH_PROMPT, folder="{folder}")
    command = f"{watcher} --scratch --work {shlex.quote(str(work))} --text {shlex.quote(text)}"
    warn = tools.hint(WORK_BUDGET_PROMPT, folder="{folder}", size="{size}", budget="{budget}")
    budget = f"{watcher} --work-budget --work {shlex.quote(str(work))} --budget {WORK_BUDGET} --text {shlex.quote(warn)}"
    return {"SubagentStart": [{"matcher": "*", "hooks": [{"type": "command", "command": command,
                                                          "timeout": SANDBOX_HOOK_TIMEOUT_S}]}],
            "PostToolUse": [{"matcher": "Bash", "hooks": [{"type": "command", "command": budget,
                                                           "timeout": SANDBOX_HOOK_TIMEOUT_S}]}]}


def permission_hooks(c: str, auto: bool = False, session: str = "", home: str = "", wait: bool = False) -> dict[str, Any]:
    """The `hooks` that hand every permission request of a session, its subagents and its workflow agents to ask, and every
    call auto mode refused: permission_hook.py, run without site-packages, with a day to wait for the analyst. `auto` adds
    it before each call, where the server answers whether the analyst allowed that call after a refusal, or with `wait`,
    for a call thimble's config sends to the analyst, after the analyst answered (module note, the config). `session` and
    `home` name the session and thimble's home (where server.json is) on the hook's command line, for a session whose
    environment does not."""
    command = f"{shlex.quote(sys.executable)} -S {shlex.quote(str(PERMISSION_HOOK))} --ws {shlex.quote(c)}"
    command += f" --session {shlex.quote(session)}" if session else ""
    command += f" --home {shlex.quote(home)}" if home else ""

    def entry(timeout: int, flag: str = "") -> list[dict[str, Any]]:
        return [{"matcher": "*", "hooks": [{"type": "command", "command": command + flag, "timeout": timeout}]}]

    out = {REQUEST: entry(permission_hook.TIMEOUT), DENIED: entry(permission_hook.TIMEOUT)}
    if auto:
        out[PRE] = entry(permission_hook.TIMEOUT, " --wait") if wait else entry(permission_hook.PRE_TIMEOUT)
    return out


def retry_base(environ_: "dict[str, str] | None" = None) -> float:
    """The first wait of a streak (module note, retry): RETRY_BASE_ENV where it is set, at least RETRY_MIN_S, else
    RETRY_BASE_S; a value that is not a number is the default, with a log line."""
    src = os.environ if environ_ is None else environ_
    raw = str(src.get(RETRY_BASE_ENV, "") or "").strip()
    if not raw:
        return RETRY_BASE_S
    try:
        return max(RETRY_MIN_S, float(raw))
    except ValueError:
        log.warning("%s=%r is not a number; using %g", RETRY_BASE_ENV, raw, RETRY_BASE_S)
        return RETRY_BASE_S


def retry_wait(n: int, base_s: float | None = None, max_s: float = RETRY_MAX_S) -> float:
    """The wait before retry `n` (from 0) of a streak, without jitter: doubling from `base_s` (retry_base when None),
    each at most `max_s`. The schedule has no end."""
    base = retry_base() if base_s is None else base_s
    return min(base * 2 ** min(n, 32), max_s)


def _pending(c: str, chat: str) -> list[dict[str, Any]]:
    meta = agents.meta_or_none(c, chat) or {}
    return [p for p in meta.get("permissions") or [] if isinstance(p, dict)]


def _what(tool_name: str, inp: Any) -> str:
    """What a call would do, for the analyst: its own description when it gave one, else its command, file or pattern."""
    d = inp if isinstance(inp, dict) else {}
    for key in ("description", "command", "file_path", "path", "pattern", "url", "query", "prompt"):
        if isinstance(d.get(key), str) and d[key].strip():
            return " ".join(d[key].split())[:300]
    return tool_name


def asker(c: str, key: str | None) -> Run | None:
    """The hosted session whose requests ask answers for `key`."""
    return _hosted.get((c, key or ""))


def _by_chat(c: str, chat: str) -> Run | None:
    """The hosted session whose chat is `chat`."""
    return next((r for (cc, _), r in list(_hosted.items()) if cc == c and r.chat == chat), None)


def host(c: str, key: str, chat: str, *, agent: str,
         sandbox: "tuple[list[str], list[str]] | None" = None, conf: userconf.Session | None = None) -> Run:
    """Answer the permission hook's requests of the session `key`, which this module does not follow, on the chat `chat`
    (module note, hosted sessions): by the mode of the row `agent` (modes.AGENTS), each denied after the card's wait
    unanswered. With `sandbox` (sandbox_rule) a Bash call that runs in the sandbox is
    allowed at once; `conf` is what thimble's config asks of it (module note, the config)."""
    run = Run(c, key, chat, "", config.corpus_dir(c), "dev", mode=modes.mode_for(c, agent),
              sandbox_rule=sandbox, config=conf)
    _hosted[(c, key)] = run
    return run


def unanswered(c: str, key: str, on: bool) -> None:
    """Mark the sessions of `key` as ones nobody can answer (a program's run with no chat), or no longer."""
    if on:
        _unanswered.add((c, key))
    else:
        _unanswered.discard((c, key))


def unhost(c: str, key: str) -> None:
    """The hosted session `key`'s run is over: what still waits is denied, and its chat's card is cleared."""
    run = _hosted.pop((c, key), None)
    if run is None:
        return
    for fut in list(run.waits.values()):
        if not fut.done():
            fut.set_result(None)
    with contextlib.suppress(Exception):
        agents.update_agent(run.c, run.chat, permissions=[])


def web_rule(tool_name: str, inp: Any) -> str | None:
    """The web rule a call falls under, as Claude Code writes it: `WebFetch(domain:<host>)` for a fetch, `WebSearch` for a
    search; None for any other call, and for a fetch whose address is not a plain http(s) host with an optional port
    (a user part, a backslash or a percent escape make Claude Code read another host than Python), which is then asked
    on its own."""
    if tool_name == "WebSearch":
        return "WebSearch"
    url = inp.get("url") if tool_name == "WebFetch" and isinstance(inp, dict) else None
    try:
        parts = urlsplit(url) if isinstance(url, str) and "\\" not in url else None
    except ValueError:
        parts = None
    if parts is None or parts.scheme not in ("http", "https") or not re.fullmatch(r"[A-Za-z0-9_.-]+(:\d+)?", parts.netloc):
        return None
    return f"WebFetch(domain:{parts.hostname})"


def web_offer(rule: str) -> list[dict[str, Any]]:
    """The card's "don't ask again" for a web rule, kept for the workspace (module note, the web)."""
    tool, _, content = rule.partition("(")
    kept = {"toolName": tool, **({"ruleContent": content[:-1]} if content else {})}
    return [{"type": "addRules", "rules": [kept], "behavior": "allow", "destination": WORKSPACE}]


def web_rules(c: str) -> list[str]:
    """The web rules the analyst kept for workspace `c`."""
    try:
        data = json.loads((config.registry_dir(c) / WEB_RULES_FILE).read_text("utf-8"))
    except (OSError, ValueError):
        return []
    rules = data.get("allow") if isinstance(data, dict) else None
    return [r for r in rules if isinstance(r, str)] if isinstance(rules, list) else []


def keep_web_rule(c: str, rule: str) -> None:
    """Keep `rule` for workspace `c`, so no session of it asks for it again."""
    rules = web_rules(c)
    if rule not in rules:
        atomic_write_text(config.registry_dir(c) / WEB_RULES_FILE, json.dumps({"allow": [*rules, rule]}, indent=1) + "\n")


def wait_words(seconds: float) -> str:
    """A wait in words: `a minute`, `10 minutes`, or `90 seconds` for one that is no whole number of minutes."""
    if seconds < 60 or seconds % 60:
        return f"{seconds:g} seconds"
    return "a minute" if seconds == 60 else f"{seconds / 60:g} minutes"


def timed_out_line(seconds: float) -> str:
    """TIMED_OUT_LINE for a wait of `seconds`."""
    return TIMED_OUT_LINE.format(wait=wait_words(seconds))


def timed_out(answer: dict[str, Any]) -> bool:
    """Whether `answer`, what ask returned, denies the call because nobody answered in time (TIMED_OUT_LINE)."""
    head = TIMED_OUT_LINE.split("{wait}", 1)[0]
    return answer.get("behavior") == "deny" and str(answer.get("message") or "").startswith(head)


async def ask(c: str, key: str | None, tool_name: str, inp: Any, agent_id: str | None = None,
              agent_type: str | None = None, event: str = REQUEST, reason: str = "",
              tool_use_id: str | None = None, suggestions: Any = None, force: bool = False,
              why: str = "") -> dict[str, Any]:
    """One permission request of the session `key` or of its subagent or workflow agent `agent_id`, or with `event` DENIED a
    call auto mode refused for `reason`; the answer as Claude Code reads it. In Bypass it is allowed at once, as is a
    Bash call the sandbox rule allows and a web call the workspace's kept rules allow; during a switch pause it is denied
    at once; a call auto mode gave no verdict on goes back to it first (_recheck); a web call joins a waiting request for
    the same site or for search; otherwise it waits on the chat until the analyst answers or the card's wait passes
    (userconf.card_wait_s). `suggestions` become the card's "don't ask again" choice, and a web call's is the site's
    rule, or web search's, for the workspace. `force` asks the analyst in every mode, as a call thimble's config sends
    to them, with `why` as the card's reason, and nothing noted when it is denied unanswered (dev's code-ticket
    question)."""
    run = asker(c, key)
    if run is None:
        return {"behavior": "deny", "message": NO_ONE_LINE if (c, key or "") in _unanswered else GONE_LINE}
    granted = {"behavior": "allow", "updatedInput": inp if isinstance(inp, dict) else {}}
    verdict = "ask" if force else run.config.verdict(tool_name, inp) if run.config is not None else ""
    if verdict == "deny":
        agents.log_permission(c, "answered", chat=run.chat, session=key, tool=tool_name, what=_what(tool_name, inp),
                              agent_id=agent_id, answer="deny: thimble's config")
        return {"behavior": "deny", "message": CONFIG_DENIED_LINE}
    if verdict == "own" or (not force and _cleared(run, agent_id, tool_name, inp)):
        return granted
    if verdict != "ask" and run.sandbox_rule is not None and sandbox_allow.allows(tool_name, inp, *run.sandbox_rule):
        return granted
    web = web_rule(tool_name, inp)

    def at_once() -> dict[str, Any] | None:
        """granted in Bypass or for a web call the workspace's kept rules allow, else None; never for a call thimble's
        config sends to the analyst."""
        kept = web is not None and web in web_rules(c)
        if verdict == "ask" or not (kept or run.mode == BYPASS):
            return None
        if event == DENIED:
            _remember(run, agent_id, tool_name, inp, True, tool_use_id)
        agents.log_permission(c, "answered", chat=run.chat, session=key, tool=tool_name, what=_what(tool_name, inp),
                              agent_id=agent_id, answer="allow: kept for the workspace" if kept else "allow: Bypass")
        return granted

    if (now := at_once()) is not None:
        return now
    unjudged = event == DENIED and bool(CLASSIFIER_DOWN.search(reason or ""))
    if unjudged and (again := await _recheck(run, agent_id, tool_name, inp, reason, tool_use_id)) is not None:
        return again
    also, tried = _also_text(tool_name, inp), set()
    while (also is not None and (first := run.groups.get(web) if web else None) is not None and first not in tried
           and first in run.waits and not run.waits[first].done() and len(_also(run, first)) < WEB_ALSO_MAX):
        tried.add(first)
        if (joined := await _join(run, first, also, tool_name, inp, agent_id, event, tool_use_id, granted)) is not None:
            return joined
    # a joined call asked on its own: the switch to Bypass or the kept rule that allowed its request may cover it
    if tried and (now := at_once()) is not None:
        return now
    rid = uuid.uuid4().hex[:10]
    whole = json.dumps(inp, ensure_ascii=False, default=str) if inp is not None else ""
    command = _command(tool_name, inp)
    cut = _cut(tool_name, inp, whole)
    updates = [] if cut else web_offer(web) if web else offer(suggestions) if event == REQUEST else []
    limit = userconf.card_wait_s()
    entry = {"id": rid, "tool": tool_name, "what": _what(tool_name, inp), "input": whole[:PERMISSION_INPUT_CHARS],
             "since": _now(), **command, **({"cut": cut} if cut else {}),
             **(_asker(run, agent_id, agent_type) if agent_id else {}),
             **({"refused": " ".join(reason.split())[:200] or "no reason given"} if event == DENIED else {}),
             **({"rechecked": len(CLASSIFIER_WAITS_S)} if unjudged else {}),
             **({"deny_after_s": limit} if unjudged else {}),
             **_offered(updates), "wait_s": limit, **({"why": why} if why else {}),
             **({"asked_by": run.config.ask_cause(tool_name, inp)} if verdict == "ask" and not force
                and run.config is not None else {}),
             "mode": run.mode}
    fut: asyncio.Future = asyncio.get_running_loop().create_future()
    run.waits[rid] = fut
    run.asking[rid] = (agent_id or None, tool_name)
    if verdict == "ask":
        run.forced.add(rid)
    if web:
        run.groups[web] = rid
    if updates:
        run.offers[rid] = updates
    agents.update_agent(c, run.chat, permissions=[*_pending(c, run.chat), entry])
    agents.log_permission(c, "asked", chat=run.chat, session=key, **entry)
    chosen: list[dict[str, Any]] | None = None
    try:
        try:
            allow = await asyncio.wait_for(asyncio.shield(fut), limit)
        except asyncio.TimeoutError:
            allow = TIMED_OUT
            if not fut.done():
                fut.set_result(TIMED_OUT)
    except asyncio.CancelledError:  # its hook went away, or the server stops
        agents.log_permission(c, "answered", id=rid, chat=run.chat, answer=NOBODY_WAITS)
        raise
    finally:
        if not fut.done():
            fut.set_result(None)
        run.waits.pop(rid, None)
        run.asking.pop(rid, None)
        run.forced.discard(rid)
        chosen = run.offers.pop(rid, None)
        if web and run.groups.get(web) == rid:
            run.groups.pop(web, None)
        with contextlib.suppress(Exception):
            _off_card(run, rid, fut.result() == TIMED_OUT)
    message = _deny_message(run, allow, limit)
    if allow == ALWAYS and chosen:
        told = _add_rules(run, chosen)
        agents.log_permission(c, "answered", id=rid, chat=run.chat,
                              answer=f"allow, don't ask again: {offer_text(chosen)}")
        return {**granted, "updatedPermissions": told} if told else granted
    agents.log_permission(c, "answered", id=rid, chat=run.chat, answer=_answer_word(allow))
    if event == DENIED and isinstance(allow, bool):
        _remember(run, agent_id, tool_name, inp, allow, tool_use_id)
    return granted if allow in (True, ALWAYS, COVERED) else {"behavior": "deny", "message": message}


async def _recheck(run: Run, agent_id: str | None, tool_name: str, inp: Any, reason: str,
                   tool_use_id: str | None) -> dict[str, Any] | None:
    """A call auto mode refused because its classifier gave no verdict, sent back to auto mode: after the next of
    CLASSIFIER_WAITS_S for this call, a `retry` with nothing remembered, so before_call leaves the call made again to auto
    mode's classifier and the refused call shows as not run. None once this call's waits are spent, when the analyst is
    asked. A switch of mode or the session's end during the wait answers it as it answers a request on the card."""
    k = grant_key(agent_id, tool_name, inp)
    now = time.monotonic()
    for old in [x for x, (_, when) in run.rechecks.items() if now - when > GRANT_TTL_S]:
        run.rechecks.pop(old, None)
    n = run.rechecks.get(k, (0, now))[0]
    if n >= len(CLASSIFIER_WAITS_S):
        run.rechecks.pop(k, None)
        return None
    run.rechecks[k] = (n + 1, now)
    what = _what(tool_name, inp)
    agents.log_permission(run.c, "rechecked", chat=run.chat, session=run.key, tool=tool_name, what=what,
                          agent_id=agent_id, refused=" ".join(reason.split())[:200], attempt=n + 1,
                          wait_s=CLASSIFIER_WAITS_S[n])
    rid = uuid.uuid4().hex[:10]
    fut: asyncio.Future = asyncio.get_running_loop().create_future()
    run.waits[rid] = fut
    run.asking[rid] = (agent_id or None, tool_name)
    if run.config is not None and run.config.verdict(tool_name, inp) == "ask":
        run.forced.add(rid)
    try:
        got = await asyncio.wait_for(fut, CLASSIFIER_WAITS_S[n])
    except asyncio.TimeoutError:
        got = "again"
    finally:
        run.waits.pop(rid, None)
        run.asking.pop(rid, None)
        run.forced.discard(rid)
    if got == "again":
        if tool_use_id:
            session.not_run(tool_use_id)
        return {"behavior": "allow"}
    return {"behavior": "deny", "message": GONE_LINE}


def _also_text(tool_name: str, inp: Any) -> str | None:
    """A web call's address, or its search, whole, as the card lists a call that joins a waiting request; None for one
    past ALSO_CHARS."""
    text = (inp if isinstance(inp, dict) else {}).get("url" if tool_name == "WebFetch" else "query")
    return text if isinstance(text, str) and text.strip() and len(text) <= ALSO_CHARS else None


def _also(run: Run, rid: str) -> list[str]:
    """The later calls listed on the card of the waiting request `rid`."""
    return next((p.get("also") or [] for p in _pending(run.c, run.chat) if p.get("id") == rid), [])


async def _join(run: Run, first: str, what: str, tool_name: str, inp: Any, agent_id: str | None, event: str,
                tool_use_id: str | None, granted: dict[str, Any]) -> dict[str, Any] | None:
    """A web call whose site, or search, a waiting request `first` of the same session asks for already: `what` is
    listed on that request's card (`also`) and the call gets its answer. None when it must be asked on its own: it could
    not be listed, or the analyst allowed `first` before the card showed it."""
    fut = run.waits[first]
    at = len(_also(run, first))
    wait = next((p.get("wait_s") for p in _pending(run.c, run.chat) if p.get("id") == first), None)
    try:
        agents.update_agent(run.c, run.chat, permissions=[
            {**p, "also": [*(p.get("also") or []), what]} if p.get("id") == first else p
            for p in _pending(run.c, run.chat)])
    except Exception:  # noqa: BLE001 — unlisted, it is asked on its own
        return None
    agents.log_permission(run.c, "asked", chat=run.chat, session=run.key, tool=tool_name, what=what, agent_id=agent_id,
                          joined=first)
    allow = await asyncio.shield(fut)
    allow = True if allow in (ALWAYS, COVERED) else allow
    if allow is True and at >= run.shown.get(first, 0):
        return None
    if event == DENIED and isinstance(allow, bool):
        _remember(run, agent_id, tool_name, inp, allow, tool_use_id)
    return granted if allow is True else {"behavior": "deny",
                                          "message": _deny_message(run, allow, wait or userconf.card_wait_s())}


def _deny_message(run: Run, allow: Any, wait_s: float) -> str:
    """What Claude Code tells the model of a request that ended with `allow` (when it is a deny), one that waited
    `wait_s` when nobody answered it in time."""
    if allow == TIMED_OUT:
        return timed_out_line(wait_s)
    return GONE_LINE if allow is None else DENIED_LINE


def _off_card(run: Run, rid: str, expired: bool) -> None:
    """The request `rid` leaves the chat's card, or stays on it marked `expired` when nobody answered it in time."""
    pending = _pending(run.c, run.chat)
    if expired:
        pending = [{**p, "expired": _now()} if p.get("id") == rid else p for p in pending]
    else:
        pending = [p for p in pending if p.get("id") != rid]
    agents.update_agent(run.c, run.chat, permissions=pending)


def _command(tool_name: str, inp: Any) -> dict[str, str]:
    """A Bash request's command whole, up to PERMISSION_INPUT_CHARS, which the card shows as code rather than the
    input's JSON; {} for any other call."""
    cmd = inp.get("command") if tool_name == "Bash" and isinstance(inp, dict) else None
    return {"command": cmd[:PERMISSION_INPUT_CHARS]} if isinstance(cmd, str) and cmd.strip() else {}


def _cut(tool_name: str, inp: Any, whole: str) -> int:
    """The length of what the card shows of a request when PERMISSION_INPUT_CHARS cuts it (a Bash request's command,
    else the input's JSON `whole`), 0 when it shows all of it."""
    shown = (inp.get("command") if _command(tool_name, inp) else None) or whole
    return len(shown) if len(shown) > PERMISSION_INPUT_CHARS else 0


def _asker(run: Run, agent_id: str, agent_type: str | None) -> dict[str, Any]:
    """Who asks, when a subagent or a workflow agent of the session does: its id and type as the hook gives them."""
    return {"agent_id": agent_id, "agent_type": agent_type}


def offer(suggestions: Any) -> list[dict[str, Any]]:
    """The updates of a request's permission_suggestions the card offers as "don't ask again": its allow rules, working
    directories and a switch to acceptEdits, each for the session alone (`destination` session); [] when it suggests none."""
    out: list[dict[str, Any]] = []
    for s in suggestions if isinstance(suggestions, list) else []:
        kind = s.get("type") if isinstance(s, dict) else None
        if kind == "addRules" and s.get("behavior") == "allow":
            rules = [{"toolName": r["toolName"], **({"ruleContent": r["ruleContent"]} if r.get("ruleContent") else {})}
                     for r in s.get("rules") or [] if isinstance(r, dict) and isinstance(r.get("toolName"), str)
                     and r["toolName"] and isinstance(r.get("ruleContent", ""), str)]
            if rules:
                out.append({"type": "addRules", "rules": rules, "behavior": "allow", "destination": "session"})
        elif kind == "addDirectories":
            dirs = [d for d in s.get("directories") or [] if isinstance(d, str) and d]
            if dirs:
                out.append({"type": "addDirectories", "directories": dirs, "destination": "session"})
        elif kind == "setMode" and s.get("mode") == EDIT_MODE:
            out.append({"type": "setMode", "mode": EDIT_MODE, "destination": "session"})
    return out


def rule_text(rule: dict[str, Any]) -> str:
    """A permission rule as Claude Code writes it in its settings and in /permissions: `Bash(npm test *)`, or the tool
    alone."""
    return f"{rule['toolName']}({rule['ruleContent']})" if rule.get("ruleContent") else str(rule["toolName"])


def offer_text(updates: list[dict[str, Any]]) -> str:
    """What a "don't ask again" adds, in Claude Code's terms: its rules, `all edits` for acceptEdits (Claude Code's
    "allow all edits during this session") and `files in <folder>/` for a working directory, named by its last part as
    Claude Code's dialog names it; a web rule kept for the workspace by its site, or as web search."""
    parts = [web_text(r) if u.get("destination") == WORKSPACE else rule_text(r)
             for u in updates if u["type"] == "addRules" for r in u["rules"]]
    parts += [f"files in {Path(d).name or d}/"
              for u in updates if u["type"] == "addDirectories" for d in u["directories"]]
    parts += ["all edits" for u in updates if u["type"] == "setMode"]
    return ", ".join(parts)


def _offered(updates: list[dict[str, Any]]) -> dict[str, str]:
    """The card's words for a request's "don't ask again": `keep`, the site or `web search`, for a web rule kept for the
    workspace, else `always`, what it adds for the session (offer_text); {} for none."""
    if not updates:
        return {}
    if all(u.get("destination") == WORKSPACE for u in updates):
        rule = updates[0]["rules"][0]
        return {"keep": str(rule.get("ruleContent") or "").removeprefix("domain:") or "web search"}
    return {"always": offer_text(updates)}


def web_text(rule: dict[str, Any]) -> str:
    """A web rule kept for the workspace, in the card's words: `<site> in this workspace`, `web search in this
    workspace`."""
    site = str(rule.get("ruleContent") or "").removeprefix("domain:")
    return f"{site or 'web search'} in this workspace"


def with_rules(argv: list[str], rules: list[dict[str, Any]]) -> list[str]:
    """`argv` with the "don't ask again" updates `rules` in it: each allow rule in --settings' `permissions.allow`, each folder in
    `permissions.additionalDirectories`, and acceptEdits as its --permission-mode where that would be manual mode."""
    out = list(argv)
    allow = [rule_text(r) for u in rules if u["type"] == "addRules" for r in u["rules"]]
    dirs = [d for u in rules if u["type"] == "addDirectories" for d in u["directories"]]
    if (allow or dirs) and "--settings" in out:
        at = out.index("--settings") + 1
        given = json.loads(out[at])
        perms = dict(given.get("permissions") or {})
        if allow:
            perms["allow"] = list(dict.fromkeys([*(perms.get("allow") or []), *allow]))
        if dirs:
            perms["additionalDirectories"] = list(dict.fromkeys([*(perms.get("additionalDirectories") or []), *dirs]))
        out[at] = json.dumps({**given, "permissions": perms})
    if any(u["type"] == "setMode" for u in rules) and "--permission-mode" in out:
        at = out.index("--permission-mode") + 1
        out[at] = EDIT_MODE if out[at] == "default" else out[at]
    return out


def dismiss(c: str, chat: str, request_id: str) -> bool:
    """Take a request no session waits on off the card of the chat `chat`: True for one denied unanswered, False for one
    whose wait is gone (module note, permissions), which no answer reaches, and for none by that id."""
    pending = _pending(c, chat)
    hit = next((p for p in pending if p.get("id") == request_id), None)
    if hit is None:
        return False
    agents.update_agent(c, chat, permissions=[p for p in pending if p.get("id") != request_id])
    if not hit.get("expired"):
        agents.log_permission(c, "answered", id=request_id, chat=chat, answer=NOBODY_WAITS)
    return bool(hit.get("expired"))


def _add_rules(run: Run, updates: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The analyst chose a request's "don't ask again": a web rule is kept for the workspace (keep_web_rule), and each
    other update is the session's from now on (its chat's meta); each other waiting request with the same
    offered updates is allowed, in every session of the workspace for a web rule. Returns the session's updates, which
    Claude Code is told."""
    kept = [u for u in updates if u.get("destination") == WORKSPACE]
    told = [u for u in updates if u.get("destination") != WORKSPACE]
    for rule in (r for u in kept for r in u["rules"]):
        keep_web_rule(run.c, rule_text(rule))
    if told:
        run.rules.extend(u for u in told if u not in run.rules)
        with contextlib.suppress(Exception):
            agents.update_agent(run.c, run.chat, **{RULES_KEY: [{"text": offer_text([u]), "update": u} for u in run.rules]})
    others = [r for (cc, _), r in list(_hosted.items()) if cc == run.c and r is not run] if kept else []
    for r in [run, *others]:
        for rid, offered in list(r.offers.items()):
            fut = r.waits.get(rid)
            if offered == updates and fut is not None and not fut.done():
                fut.set_result(COVERED)
    return told


def kept_rules(c: str, chat: str | None) -> list[dict[str, Any]]:
    """The "don't ask again" updates the analyst chose in the session whose chat is `chat`, for a process that resumes
    it (start)."""
    meta = agents.meta_or_none(c, chat) if chat else None
    kept = (meta or {}).get(RULES_KEY)
    if not isinstance(kept, list):
        return []
    return [r["update"] for r in kept if isinstance(r, dict) and isinstance(r.get("update"), dict)]


def _answer_word(allow: Any) -> str:
    """How a request ended, for the permission log (agents.log_permission)."""
    if allow is True:
        return "allow"
    if allow == COVERED:
        return "allow: covered by a rule added for this session"
    if allow == TIMED_OUT:
        return "deny: nobody answered in time"
    if allow is None:
        return "none: the session ended"
    return "deny"


def grant_key(agent_id: str | None, tool_name: str, inp: Any) -> tuple[str | None, str, str]:
    """What a call made again must share with the call auto mode refused (module note, auto mode): its agent, its tool
    and its input, less the `description`, which only labels the call and which the model may word anew."""
    d = {k: v for k, v in inp.items() if k != "description"} if isinstance(inp, dict) else inp
    return agent_id or None, tool_name, json.dumps(d, sort_keys=True, ensure_ascii=False, default=str)


def _remember(run: Run, agent_id: str | None, tool_name: str, inp: Any, allow: bool, tool_use_id: str | None) -> None:
    """The analyst's answer to a call auto mode refused, for the call made again (before_call); an allowed call shows
    as not run rather than failed, since it is made again (session.not_run)."""
    now = time.monotonic()
    for k in [k for k, (_, when) in run.grants.items() if now - when > GRANT_TTL_S]:
        run.grants.pop(k, None)
    run.grants[grant_key(agent_id, tool_name, inp)] = (allow, now)
    if allow:
        run.passes.setdefault((agent_id or None, tool_name), []).append(grant_key(agent_id, tool_name, inp))
        if tool_use_id:
            session.not_run(tool_use_id)


def _use_pass(run: Run, agent_id: str | None, tool_name: str, exact: tuple[str | None, str, str] | None = None) -> bool:
    """Use up an allow the agent has left for the tool within GRANT_TTL_S, the one for the call `exact` when it is
    given, else the oldest, whose remembered call it takes with it, so one allow lets one call run; False when none is
    left."""
    key = (agent_id or None, tool_name)
    now = time.monotonic()
    left = [k for k in run.passes.get(key, [])
            if k in run.grants and run.grants[k][0] and now - run.grants[k][1] <= GRANT_TTL_S]
    pick = exact if exact in left else (left[0] if left and exact is None else None)
    if pick is not None:
        left.remove(pick)
        run.grants.pop(pick, None)
    if left:
        run.passes[key] = left
    else:
        run.passes.pop(key, None)
    return pick is not None


def before_call(c: str, key: str | None, tool_name: str, inp: Any, agent_id: str | None = None) -> dict[str, Any]:
    """The permission hook before a call of a session in auto mode: `allow` when the analyst allowed this call (or a reworded
    call of the same tool by the same agent) after auto mode refused it, `deny` when they denied it, each once; {} for any
    other call."""
    run = asker(c, key)
    if run is None:
        return {}
    exact = grant_key(agent_id, tool_name, inp)
    allowed = {"behavior": "allow", "message": ALLOWED_LINE}
    hit = run.grants.get(exact)
    if hit is not None and time.monotonic() - hit[1] <= GRANT_TTL_S:
        if hit[0]:
            _use_pass(run, agent_id, tool_name, exact)
            return allowed
        run.grants.pop(exact, None)
        return {"behavior": "deny", "message": DENIED_LINE}
    run.grants.pop(exact, None)  # expired
    return allowed if _use_pass(run, agent_id, tool_name) else {}


def _cleared(run: Run, agent_id: str | None, tool_name: str, inp: Any) -> bool:
    """Whether the analyst allowed this call on the card before it ran, within GRANT_TTL_S (module note, the config); the
    allow is used up."""
    when = run.cleared.pop(grant_key(agent_id, tool_name, inp), None)
    return when is not None and time.monotonic() - when <= GRANT_TTL_S


def answer(c: str, chat: str, request_id: str, allow: bool, always: bool = False, shown: int = 0) -> bool:
    """The analyst's answer to a pending request of the session whose chat is `chat`, `always` for the card's "don't
    ask again", which allows it with the updates offered for it (module note, don't ask again), covering the first
    `shown` calls that joined it (module note, the web); for a request no session waits on, its removal from the card
    (dismiss). False when no session waits on a request by that id."""
    run = _by_chat(c, chat)
    fut = run.waits.get(request_id) if run is not None else None
    if run is None or fut is None or fut.done():
        return dismiss(c, chat, request_id)
    run.shown[request_id] = shown
    fut.set_result(ALWAYS if allow and always and run.offers.get(request_id) else bool(allow))
    return True


class PermissionAnswer(BaseModel):
    id: str
    allow: bool
    always: bool = False  # the card's "don't ask again"
    shown: int = 0  # how many of the calls that joined it the card listed


@router.post("/ws/{c}/chats/{chat}/permission")
async def permission_route(c: str, chat: str, body: PermissionAnswer, request: Request) -> dict[str, Any]:
    """The analyst's answer on a session's card: answer. 403 for a request that is not the analyst's browser's
    (hook_auth.analyst), 404 when no such request waits."""
    if not hook_auth.analyst(request):
        raise HTTPException(403, hook_auth.ANALYST_ONLY)
    if not answer(c, chat, body.id, body.allow, body.always, body.shown):
        raise HTTPException(404, "no such permission request is waiting")
    return {"answered": body.id, "allow": body.allow}


class PermissionRequestBody(BaseModel):
    session: str
    event: str = REQUEST
    tool_name: str
    tool_input: Any = None
    agent_id: str | None = None
    agent_type: str | None = None
    tool_use_id: str | None = None
    reason: str = ""
    suggestions: Any = None  # a request's permission_suggestions


@router.post("/ws/{c}/sessions/permission")
async def permission_request_route(c: str, body: PermissionRequestBody, request: Request) -> dict[str, Any]:
    """A session's permission hook (permission_hook.py): hook_request. A hook that goes away while its request waits
    (its process was killed) takes the request off the card, as the session's end does."""
    task = asyncio.ensure_future(hook_request(c, body))
    try:
        while not (await asyncio.wait({task}, timeout=HOOK_POLL_S))[0]:
            if await request.is_disconnected():
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await task
                return {"behavior": "deny", "message": GONE_LINE}
        return task.result()
    finally:
        task.cancel()


async def hook_request(c: str, body: PermissionRequestBody) -> dict[str, Any]:
    """A permission hook's event, for the session its THIMBLE_SESSION names: a request or a call auto mode refused,
    answered by ask once the analyst answers or its wait passes, or a call about to run, answered by before_call at
    once."""
    if body.event == PRE:
        got = before_call(c, body.session, body.tool_name, body.tool_input, body.agent_id)
        run = asker(c, body.session)
        verdict = run.config.verdict(body.tool_name, body.tool_input) if not got and run and run.config else ""
        if verdict == "deny":
            return {"behavior": "deny", "message": CONFIG_DENIED_LINE}
        if verdict != "ask" or run is None:
            return got
        answered = await ask(c, body.session, body.tool_name, body.tool_input, body.agent_id, body.agent_type)
        if answered.get("behavior") != "allow":
            return {"behavior": "deny", "message": answered.get("message") or DENIED_LINE}
        run.cleared[grant_key(body.agent_id, body.tool_name, body.tool_input)] = time.monotonic()
        return {"behavior": "allow", "message": ALLOWED_LINE}
    return await ask(c, body.session, body.tool_name, body.tool_input, body.agent_id, body.agent_type,
                     event=DENIED if body.event == DENIED else REQUEST, reason=body.reason, tool_use_id=body.tool_use_id,
                     suggestions=body.suggestions)


async def shutdown() -> None:
    """The server is going down: what each hosted session's hook waits on ends unanswered."""
    for key in list(_hosted):
        unhost(*key)


def _clear_left(c: str, metas: "list[dict[str, Any]]") -> list[str]:
    """Take the requests a previous server left waiting off the chats `metas` of workspace `c` (module note, hosted
    sessions): their hooks lost the connection, so Claude Code went on without an answer. A request a session of this
    server waits on stays, a request denied unanswered stays until dismissed, and main's stay, which events.py relays
    and drops. Returns their ids."""
    live = {rid for r in _hosted.values() for rid in r.waits}
    gone: list[str] = []
    for meta in metas:
        if meta.get("kind") == agents.KIND_MAIN or meta.get("id") == agents.MAIN_ID:
            continue
        if not any(isinstance(p, dict) and not p.get("expired") for p in meta.get("permissions") or []):
            continue
        chat = str(meta["id"])
        pending = _pending(c, chat)
        left = [p for p in pending if p.get("expired") or p.get("id") in live]
        if len(left) == len(pending):
            continue
        agents.update_agent(c, chat, permissions=left)
        for p in pending:
            if p not in left:
                gone.append(str(p.get("id")))
                agents.log_permission(c, "answered", id=p.get("id"), chat=chat, answer=NOBODY_WAITS)
    return gone


async def recover() -> list[str]:
    """Server start: the requests a previous server left waiting on the chats of every workspace are taken off
    (_clear_left). Returns `<workspace>/<request id>` per request."""
    out: list[str] = []
    root = config.WORKSPACES_DIR
    for folder in sorted(root.iterdir()) if root.is_dir() else []:
        if not folder.is_dir() or folder.name.startswith("."):
            continue
        try:
            out += [f"{folder.name}/{x}" for x in _clear_left(folder.name, agents.list_chats(folder.name))]
        except Exception:  # noqa: BLE001 — a workspace whose corpus is gone, or one that cannot be read
            log.debug("%s: its chats' requests were not checked at start", folder.name, exc_info=True)
    return out


@contextlib.asynccontextmanager
async def _lifespan(app: Any):
    """The router's lifespan: at start a task takes off the requests a previous server left waiting (recover)."""
    task = asyncio.get_running_loop().create_task(_recover_logged(), name="agent-session-recover")
    try:
        yield
    finally:
        task.cancel()


async def _recover_logged() -> None:
    try:
        gone = await recover()
        if gone:
            log.info("permission requests a previous server left waiting, taken off: %s", ", ".join(gone))
    except Exception:  # noqa: BLE001 — never fails the start
        log.exception("taking off the requests a previous server left waiting failed")


router.lifespan_context = _lifespan
