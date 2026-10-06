"""thimble's agents as subagents of the analyst's Claude Code session (main): the orientation, its critic, the writers,
the view builders and reviewers (dev.py, view_review.py) and the runs of report checks (checks.py). Each is a named subagent with a fresh context, of a type
thimble's plugin module registers (`thimble:<role>`, roles); the orientation's own subagents run as `thimble:helper`.

Starts. A click in the browser (Start, Write, Start it, …) starts its agent through the plugin's module, with no turn of
main: start_job writes the pending request, then asks the module (module_bridge.request) to spawn it, and the module's
answer ends the request ({agentId}, a deny of thimble's own --agent-check, Claude Code's concurrency limit, or no
module). A follow-on start (a run's own next step, such as the orientation's report pass) goes the same way. A typed
request goes through main: the start tool records the pending request and returns the exact Agent call, which main
makes; the plugin's --agent-check hook lets only that call through, and the mirror watches for a start that does not
happen (R1–R3, session.py). Every click route takes the analyst's browser cookie (hook_auth.analyst), never the server's
token alone, since a start through the module is not judged by auto mode. There is no second route: without the module
thimble's agents cannot start (start-refused-no-module).

Run values. Every run gets exactly the model and effort its arguments or Settings name (values_for). A click registers
the role with them first (the module); a typed start gets them from the module's spawn and step hooks, which read the
request's values (subagents.json) by the request id on the prompt's first line.

The files. subagents.json, callers.jsonl and launch.json hold what the hooks and the module trust (subagent_files.py);
the hooks write them first and post here only when a server runs. Kernels see them read-only (kernel_wrap.TRUSTED_FILES).

Runs and ends. A run is one turn sequence of an agent, from its start or a follow-up to its hand-back. The mirror
(session.py) and the hooks tell run_ended the end once per run, by whichever signal comes first; a SubagentStop alone is
a turn's end, which ends the run only when no child of the agent runs and no hand-back follows within HANDBACK_WAIT_S.
Each role's handlers (Type.started, Type.ended, Type.refused) do what its run's start, end and refusal mean for it.

Attribution. A PreToolUse hook on thimble's tools records which agent makes each call (callers.jsonl); caller() names
the agent, and its key is the session the call runs as (tools.call_route), a descendant's that of its thimble ancestor.
"""
from __future__ import annotations

import asyncio
import contextlib
import importlib
import inspect
import json
import logging
import re
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterator

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from . import agents, config, subagent_files as files, tools

log = logging.getLogger("thimble.subagents")


@contextlib.asynccontextmanager
async def _lifespan(app: Any):
    """At start, in a task: what an earlier version left running in each workspace is stopped (recover_old). The
    module's `ended` posts reach `ended` (module_bridge.on_ended)."""
    _hear_module()
    task = asyncio.get_running_loop().create_task(_recover_logged(), name="subagents-recover-old")
    yield
    task.cancel()


router = APIRouter(lifespan=_lifespan)

PLUGIN = files.PLUGIN
HELPER = files.HELPER
ROLES = files.ROLES
STEP_ROLE = agents.STEP_ROLE
CLICK, FOLLOW_ON, TYPED = "click", "follow-on", "typed"
ROUTES = (CLICK, FOLLOW_ON, TYPED)
# the kinds a start that did not happen has (run.json `refused.kind`, a request's `refused_kind`)
AUTO_MODE, NO_CALL, LIMIT, NOT_LAUNCHED, HOOK, EARLIER, NO_MODULE, ERROR = (
    "auto-mode", "no-call", "limit", "not-launched", "hook", "earlier-session", "no-module", "error")
HANDBACK_WAIT_S = 5.0  # a turn's end with no running child ends the run once no hand-back follows within this
# in auto mode Claude Code makes an agent that ended with text call SubagentHandback, a model step later
AUTO_HANDBACK_WAIT_S = 30.0
CALLER_WAIT_S = 2.0  # how long caller() waits for the caller hook's line before the mirror's transcript search
STOPPED_QUIT = "quit"  # `stopped_by` of a chat that main's quit stopped
STOPPED_ANALYST = "analyst"
STOPPED_REFUSED = "refused"
# `stopped_by` of an agent stopped with Esc in its view: Claude Code marks it stopped by the user and resumes it no
# more ("Agent … was stopped by the user and won't be resumed"), unlike one a TaskStop stopped (live check L9)
STOPPED_USER = "user"
CANCELLED = "stopped-by-user"  # a chat's `continue` then: no follow-up can reach it
USER_STOP_RE = re.compile(r"stopped by (the )?user", re.I)  # Esc's task notification and a SendMessage's error say so
QUIT_LINE = "Stopped when Claude Code quit."  # a chat's end line, its card's text is the browser's (AgentCard)
WORK_DIRS = ("orient/work", "writers", "critique-work", "check-work", "views-work", "extension/views")
LIMIT_RE_WORDS = ("concurrent", "subagents")  # Claude Code's concurrency-limit text holds both (R2, the module's answer)
# the label Claude Code puts before a PreToolUse hook's deny in what $.agent.spawn and $.tool.call answer
HOOK_ERROR_RE = re.compile(r"^\s*PreToolUse:[A-Za-z]+ hook error:\s*")
# $.agent.spawn's own text when as many of the plugin's spawns run as CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS allows
# ("thimble: $.agent.spawn refused: 2 spawns are running at once", 2.1.291; live check L19)
SPAWN_LIMIT_TEXT = "spawns are running at once"


def limit_text(text: str) -> bool:
    """Whether `text` is Claude Code's concurrency-limit text: the Agent tool's (LIMIT_RE_WORDS) or $.agent.spawn's."""
    low = str(text or "").lower()
    return bool(low) and (all(w in low for w in LIMIT_RE_WORDS) or SPAWN_LIMIT_TEXT in low)


def _now() -> str:
    return files.iso()


def _resolve(ref: str) -> Any:
    mod, _, attr = ref.partition(":")
    return getattr(importlib.import_module(mod), attr)


# --------------------------------------------------------------------------- the types


@dataclass(frozen=True)
class Type:
    """One of thimble's agent types. `kind` is the session kind of its key (tools.session_kind), `chat_role` the role
    of its chat (a step of its parent's for the critic; none for the helper, whose calls and transcript are its
    ancestor's), `row` its row of config.models_for and `agent` its row of thimble's config (userconf.AGENTS: web,
    memory). `define`, `own`, `started`, `ended` and `refused` name `module:attr`: the role's definition for a workspace,
    the thimble tools it may call, and its handlers (module note, runs and ends)."""

    role: str
    kind: str | None
    chat_role: str | None
    row: str
    agent: str
    define: str
    own: str = ""
    started: str = ""
    ended: str = ""
    refused: str = ""


TYPES: dict[str, Type] = {
    "orientation": Type("orientation", tools.ORIENT_SESSION, "orient", "orient", "orientation",
                        "app.orient_session:subagent_definition", "app.orient_session:ORIENT_TOOLS",
                        "app.orient_session:subagent_started", "app.orient_session:subagent_ended",
                        "app.orient_session:subagent_refused"),
    "critic": Type("critic", tools.CRITIQUE_SESSION, STEP_ROLE, "critic", "critic",
                   "app.critique_session:definition", "app.critique_session:OWN_TOOLS",
                   "app.critique_session:subagent_started", "app.critique_session:subagent_ended",
                   "app.critique_session:subagent_refused"),
    "writer": Type("writer", tools.WRITER_SESSION, "writer", "writer", "writer",
                   "app.write_session:definition", "app.write_session:OWN_TOOLS",
                   "app.write_session:subagent_started", "app.write_session:subagent_ended",
                   "app.write_session:subagent_refused"),
    "view-builder": Type("view-builder", tools.VIEW_SESSION, "dev", "dev", "dev", "app.view_tools:builder_definition",
                         "app.view_tools:BUILDER_TOOLS", "app.dev:build_started", "app.dev:build_ended",
                         "app.dev:build_refused"),
    "view-reviewer": Type("view-reviewer", tools.REVIEW_SESSION, "dev", "dev", "dev",
                          "app.view_tools:reviewer_definition", "app.view_tools:REVIEWER_TOOLS",
                          "app.view_review:subagent_started", "app.view_review:subagent_ended",
                          "app.view_review:subagent_refused"),
    "check": Type("check", tools.CHECK_SESSION, "check", "checks", "checks", "app.checks:definition",
                  "app.checks:OWN_TOOLS", "app.checks:subagent_started", "app.checks:subagent_ended",
                  "app.checks:subagent_refused"),
    HELPER: Type(HELPER, None, None, "subagents", "orientation", "app.subagents:helper_definition"),
}


def type_name(role: str) -> str:
    return files.type_name(role)


def role_of(agent_type: Any) -> str | None:
    """The role of one of thimble's role types, else None (the helper is no role: module note)."""
    return files.role_of(agent_type)


def kind_of(key: str | None) -> str | None:
    return tools.session_kind(key)


def role_of_key(key: str | None) -> str | None:
    kind = kind_of(key)
    return next((t.role for t in TYPES.values() if t.kind is not None and t.kind == kind), None)


def own_tools(role: str) -> tuple[str, ...] | None:
    t = TYPES.get(role)
    return tuple(_resolve(t.own)) if t is not None and t.own else None


def helper_definition(c: str) -> dict[str, Any]:
    """thimble:helper, the type of the orientation's own subagents (Q10): general-purpose tools, and the fixed
    description and short prompt of prompts/helper.md (its frontmatter and body)."""
    from . import prompts  # noqa: PLC0415

    front, body = prompts.frontmatter("helper")
    return {"description": str(front.get("description") or "").strip(), "prompt": body.strip()}


def values_for(c: str, role: str, args: dict[str, Any] | None = None) -> dict[str, str]:
    """{model, effort} of a run of `role`: those its arguments name, else Settings' row for the role
    (config.models_for). A model alias is written as its full id, the orientation's with `[1m]` where the model has
    the 1M window, as Settings shows it; Ultracode's effort is xhigh (config.effort_level). An effort that is none of
    the levels Claude Code takes is not passed on, since the registration would then carry a value Claude Code does not
    run at: Settings' effort stands. A model Claude Code runs with no effort (config.has_effort) gets none."""
    args = args or {}
    conf = config.models_for(c)[TYPES[role].row]
    model = config.exact_model(str(args.get("model") or "").strip()) or str(conf.get("model") or "")
    if role == "orientation":
        model = config.long_context(model)
    asked = str(args.get("effort") or "").strip()
    effort = config.effort_level(asked) or str(conf.get("effort") or "")
    if asked and not config.effort_level(asked):
        log.warning("%s: a run of the %s named the effort %r, which Claude Code does not take; it runs at %s",
                    c, role, asked, effort)
    if not config.has_effort(model):
        effort = ""
    return {"model": model, "effort": effort}


def _agent_conf(c: str, agent: str) -> dict[str, Any]:
    from . import userconf  # noqa: PLC0415

    try:
        return dict((userconf.load_or_defaults(c)[0].get("agents") or {}).get(agent) or {})
    except Exception:  # noqa: BLE001 — a config that cannot be read keeps the defaults
        return {}


Role = dict  # one type's registration: name, type, description, prompt, model, effort, background, and the rest


def roles(c: str) -> dict[str, Role]:
    """Every type's definition for workspace `c`, which the module registers as `thimble:<name>` (GET
    /api/module/roles): each of TYPES's with its fixed prompt and description, the full model id and explicit effort of
    Settings (values_for), `background: true`, `disallowedTools` with the web tools when its agent's `web` is off and
    `omitClaudeMd` when its `memory` is off; then the extensions' agents (extension_types)."""
    out: dict[str, Role] = {}
    for role, t in TYPES.items():
        try:
            d = dict(_resolve(t.define)(c))
        except Exception:  # noqa: BLE001 — one type that cannot render leaves the others registered
            log.exception("%s: the %s's definition did not render", c, role)
            continue
        d.update(values_for(c, role))
        d.update(name=role, type=type_name(role), background=True)
        conf = _agent_conf(c, t.agent)
        denied = list(d.get("disallowedTools") or [])
        if conf.get("web") == "off":
            denied += list(tools.WEB_TOOLS)
        if denied:
            d["disallowedTools"] = list(dict.fromkeys(denied))
        if conf.get("memory") == "off":
            d["omitClaudeMd"] = True
        d.pop("hooks", None)  # module note: none, since a definition's hooks miss its nested agents (U3)
        out[role] = d
    for name, d in extension_types(c).items():
        if name not in out:
            out[name] = {**d, "name": name, "type": type_name(name), "background": True}
    return out


def extension_types(c: str) -> dict[str, dict[str, Any]]:
    """The active extensions' agents (extensions.agent_definitions, and roles.subagents of the orientation, the critic
    and the writer), by the name the orientation's session gave them; a web that is off already takes the web tools."""
    from . import extensions, roles as role_parts  # noqa: PLC0415

    out: dict[str, dict[str, Any]] = {}
    try:
        out.update(extensions.agent_definitions(c))
        for role in ("orientation", "critic", "writer"):
            out.update(role_parts.subagents(c, role))
    except Exception:  # noqa: BLE001
        log.exception("%s: the extensions' agents were not read", c)
    return out


def write_dirs(c: str) -> list[Path]:
    """The folders main's Bash may write in workspace `c`, its agents' work folders: orient/work, writers,
    critique-work, check-work, views-work and the local extension's views. They need not exist yet."""
    ws = config.workspace_path(c)
    return [ws / d for d in WORK_DIRS]


# --------------------------------------------------------------------------- the files


def ws(c: str) -> Path:
    return config.workspace_dir(c)


def ensure_files(c: str) -> None:
    """subagents.json, callers.jsonl and launch.json made in the workspace when missing (subagent_files.ensure)."""
    files.ensure(ws(c))


def read(c: str) -> dict[str, Any]:
    return files.read(ws(c))


@contextlib.contextmanager
def update(c: str) -> Iterator[dict[str, Any]]:
    with files.update(ws(c)) as state:
        yield state


def request(c: str, rid: str) -> dict[str, Any] | None:
    r = files.requests(read(c)).get(rid)
    return dict(r) if isinstance(r, dict) else None


def agent(c: str, agent_id: str | None) -> dict[str, Any] | None:
    a = files.registry(read(c)).get(str(agent_id or ""))
    return dict(a) if isinstance(a, dict) else None


def message_run(c: str, agent_id: str | None) -> int | None:
    """The run a message to one of thimble's agents belongs to, which its chat's `user` record names (`run`) so the
    browser shows each follow-up as its own run: the run going on while the agent runs (a queued message joins it),
    else the next one, whether or not the mirror has seen that run begin yet (run_again). None for an agent not in the
    registry."""
    a = agent(c, agent_id)
    if a is None or a.get("role") not in TYPES:
        return None
    k = int(a.get("run") or 0)
    return k if a.get("status") in ("running", "waiting") else k + 1


def agents_of(c: str, role: str | None = None, key: str | None = None) -> dict[str, dict[str, Any]]:
    """The registered agents of `role` (and `key`), by id, newest last."""
    out = {k: dict(a) for k, a in files.registry(read(c)).items() if isinstance(a, dict)
           and (role is None or a.get("role") == role) and (key is None or a.get("key") == key)}
    return dict(sorted(out.items(), key=lambda kv: float(kv[1].get("started") or 0)))


def module_state(c: str) -> dict[str, Any]:
    """What the module refetches at session start and after a change of session id (GET /api/module/state): the running
    agents, the per-run efforts its step hook applies, and the values of the typed starts that are pending."""
    state = read(c)
    running = {k: {"role": a.get("role"), "type": a.get("type"), "key": a.get("key"), "plugin_started": a.get("plugin_started")}
               for k, a in files.registry(state).items() if isinstance(a, dict) and a.get("status") in ("running", "waiting")}
    typed = {rid: {"values": r.get("values"), "input": r.get("input"), "role": r.get("role")}
             for rid, r in files.requests(state).items() if isinstance(r, dict) and r.get("route") == TYPED
             and r.get("kind") == "start" and r.get("state") in files.OPEN}
    return {"agents": running, "efforts": dict(files.efforts(state)), "typed": typed, "main": state.get("main") or {}}


# --------------------------------------------------------------------------- answers


class Answer(dict):
    """What a start, a follow-up or a stop answers, as a dict: {agentId} (started), {deny} (thimble's own refusal, kind
    hook), {limit} (Claude Code's concurrency limit), {error}, {"no-module": reason}, or for a typed start {request,
    input}: the request id and the exact call main makes. `kind` and `reason` name a refusal."""

    @property
    def agent_id(self) -> str | None:
        return self.get("agentId")

    @property
    def started(self) -> bool:
        return bool(self.get("agentId"))

    @property
    def typed(self) -> bool:
        return "input" in self and not self.refused

    @property
    def refused(self) -> bool:
        return self.kind is not None

    @property
    def kind(self) -> str | None:
        if self.get("kind"):
            return str(self["kind"])
        if "deny" in self:
            return HOOK
        if "limit" in self:
            return LIMIT
        if NO_MODULE in self:
            return NO_MODULE
        if "error" in self and self.get("gone"):
            return EARLIER  # the agent had ended, or belongs to another session (module_bridge's `gone`)
        if "error" in self:
            return ERROR
        return None

    @property
    def reason(self) -> str:
        for k in ("reason", "deny", "limit", NO_MODULE, "error"):
            if self.get(k):
                return str(self[k])
        return ""


def refusal(kind: str, reason: str) -> Answer:
    return Answer({"kind": kind, "reason": reason})


def _from_module(raw: Any, why: Callable[[], str] = lambda: "") -> Answer:
    """The module's answer (module_bridge.request) as an Answer: {agentId}, {deny}, {limit}, {error}, or `no-module` as
    the string, or a dict naming it (`why` gives its reason when the answer has none); Claude Code's concurrency-limit
    text in an error is a limit."""
    if isinstance(raw, Answer):
        return raw
    if raw is None or raw == NO_MODULE:
        return Answer({NO_MODULE: why()})
    if not isinstance(raw, dict):
        return Answer({"error": str(raw)})
    for k in (NO_MODULE, "no_module", "noModule"):
        if k in raw:
            return Answer({NO_MODULE: str(raw.get(k) or "") or why()})
    ans = Answer(raw)
    if isinstance(ans.get("deny"), str):  # thimble's own reason, as the analyst reads it, without Claude Code's label
        ans["deny"] = HOOK_ERROR_RE.sub("", ans["deny"]) or ans["deny"]
    text = str(ans.get("error") or ans.get("deny") or "")
    if "limit" not in ans and limit_text(text):
        return Answer({"limit": text})
    return ans


async def _bridge(c: str, op: str, **args: Any) -> Answer:
    """module_bridge.request(c, op, **args) as an Answer (lane M owns the bridge); `no-module` when it is not live, and
    `no-module` marked `expired` when a module that holds the long-poll did not answer within the bridge's wait."""
    from . import module_bridge  # noqa: PLC0415

    def why() -> str:
        return str(module_bridge.why_not(c) or "")

    if not module_bridge.live(c):
        return Answer({NO_MODULE: why()})
    raw = module_bridge.request(c, op, **args)
    if inspect.isawaitable(raw):
        raw = await raw
    ans = _from_module(raw, why)
    if ans.kind == NO_MODULE:  # a module that held the long-poll and did not answer in time: the request expired
        ans["expired"] = True
    return ans


# --------------------------------------------------------------------------- pending requests


def new_request(c: str, kind: str, key: str | None, input: dict[str, Any], values: dict[str, Any] | None, route: str,
                *, role: str | None = None, rid: str | None = None, **fields: Any) -> str:
    """Record a pending request in subagents.json: a start, a message or a stop (`kind`) of `role` for the agent of
    `key`, with the exact call it stands for (`input`) and the run's values. Its id is `rid` (request_id) when given."""
    if route not in ROUTES:
        raise ValueError(f"route {route!r}")
    rid = rid or files.request_id()
    t = files.now()
    rec = {"kind": kind, "route": route, "role": role or role_of_key(key), "key": key, "input": input,
           "values": dict(values or {}), "created": t, "claimed_by": None, "state": "pending", **fields}
    with update(c) as state:
        files.requests(state)[rid] = rec
    return rid


def request_id() -> str:
    return files.request_id()


def with_request_line(prompt: str, rid: str) -> str:
    """`prompt` whose first line names the request `rid`, which the module's spawn hook finds a typed start by: as it
    is when its first line carries the id already (the orientation's prompt does, orient-subagent-prompt), else with
    the line `## subagent-request` gives it (`[thimble request <id>]`) before it."""
    first = prompt.split("\n", 1)[0]
    return prompt if rid in first else f"{tools.hint('subagent-request', request_id=rid) or rid}\n{prompt}"


def _set(c: str, rid: str, **fields: Any) -> dict[str, Any] | None:
    with update(c) as state:
        r = files.requests(state).get(rid)
        if not isinstance(r, dict):
            return None
        r.update(fields)
        return dict(r)


def claim(c: str, tool_use_id: str, input: dict[str, Any], *, tool_name: str = "Agent", caller: str | None = None,
          permission_mode: str = "") -> str | None:
    """The server's own use of the --agent-check decision (subagent_files.check_call): the reason a call must not run,
    or None, the matching request then claimed by `tool_use_id`."""
    with update(c) as state:
        return files.check_call(state, {"tool_name": tool_name, "tool_input": input, "tool_use_id": tool_use_id,
                                        "agent_id": caller, "permission_mode": permission_mode})


def refuse(c: str, rid: str, reason: str, kind: str) -> dict[str, Any] | None:
    """A request ends as a start or message that did not happen: its state `refused`, with the reason and the kind, and
    its role's refusal handler (Type.refused) tells the run record and the browser. A request that ended already is
    left alone."""
    with update(c) as state:
        r = files.requests(state).get(rid)
        if not isinstance(r, dict) or r.get("state") in ("started", "done"):
            return None
        if r.get("state") == "refused" and r.get("refused_kind") == kind and r.get("reason") == reason:
            return None
        r.update(state="refused", reason=reason, refused_kind=kind, at=files.now())
        rec = {**r, "id": rid}
    log.info("%s: %s request %s (%s) refused, %s: %s", c, rec.get("kind"), rid, rec.get("role"), kind, reason[:200])
    _refused(c, rec)
    return rec


def _refused(c: str, rec: dict[str, Any]) -> None:
    t = TYPES.get(str(rec.get("role") or ""))
    if t is None or not t.refused:
        return
    try:
        _resolve(t.refused)(c, rec)
    except Exception:  # noqa: BLE001 — the request is refused either way
        log.exception("%s: the %s's refusal handler failed", c, rec.get("role"))


def expire(c: str, rid: str) -> dict[str, Any] | None:
    """A click the module did not answer within module_bridge's wait: the request expires, so --agent-check denies a
    late spawn of it, and it is refused as `no-module`, marked `expired` (the browser's no-answer text and Try
    again)."""
    from . import module_bridge  # noqa: PLC0415

    rec = _set(c, rid, state="expired", at=files.now(), refused_kind=NO_MODULE, expired=True)
    if rec is not None:
        _refused(c, {**rec, "id": rid, "reason": str(module_bridge.why_not(c) or ""), "refused_kind": NO_MODULE,
                     "expired": True})
    return rec


async def start_it(c: str, rid: str) -> Answer:
    """Start it on a refused typed start: the same request, with the same values and the same call, started through
    the module as a click (the caller checked the analyst's cookie)."""
    r = request(c, rid)
    if r is None or r.get("kind") != "start":
        return refusal(ERROR, "no such request")
    if r.get("state") not in ("refused", "expired"):
        return refusal(HOOK, "this request is not refused")
    if r.get("caller_role"):  # the critic: the module would start it as main's subagent, not its orientation's
        return refusal(HOOK, "an agent's own start (the orientation's critic) can't be started from the browser")
    if (before := refusal_before(c, click=True)) is not None:  # as every click: unfenced or no module
        return before
    _set(c, rid, route=CLICK, state="pending", claimed_by=None, reason=None, refused_kind=None, again=files.now())
    return await _spawn(c, rid, r)


async def again(c: str, rid: str) -> Answer:
    """Try again, Send again or Write again: a refused or stopped request made anew as a click (the caller checked the
    analyst's cookie)."""
    r = request(c, rid)
    if r is None:
        return refusal(ERROR, "no such request")
    if r.get("kind") == "message":
        return await send(c, str(r.get("agent") or ""), str((r.get("input") or {}).get("message") or ""),
                          values=r.get("values"))
    return await start_it(c, rid) if r.get("state") in ("refused", "expired") else refusal(HOOK, "the request runs")


# --------------------------------------------------------------------------- refusals before a start


def refusal_before(c: str, click: bool = False) -> Answer | None:
    """Why no agent of thimble's can start now in workspace `c`, before any request is made: main was not started by
    `thimble` (not-launched), main is in plan mode (hook, start-plan-mode), or the module does not hold the long-poll
    (no-module). None when nothing stands in the way. A `click` leaves plan mode to --agent-check, which reads main's mode
    as the module's call runs: thimble hears main's mode only at main's turns, so after a shift+tab while main is idle
    the mode it keeps is stale (live check L21), and the click would stay refused after the analyst left plan mode."""
    from . import cc_plugin, module_bridge, session  # noqa: PLC0415

    if not cc_plugin.main_fenced(c):
        return refusal(NOT_LAUNCHED, tools.hint("start-refused-not-launched"))
    if not click and session.main_mode(c) == files.PLAN_MODE:
        return refusal(HOOK, tools.hint("start-plan-mode"))
    if not module_bridge.live(c):
        return refusal(NO_MODULE, tools.hint("start-refused-no-module", reason=str(module_bridge.why_not(c) or "")))
    return None


# --------------------------------------------------------------------------- starts


def call_input(role: str, prompt: str, description: str) -> dict[str, Any]:
    """The exact Agent call of a start: the type, its description and its prompt; no `run_in_background`, which an
    interactive Agent tool does not have (F1), and no `model`, since the run's values reach the module instead."""
    return {"subagent_type": type_name(role), "description": description, "prompt": prompt}


async def start_job(c: str, role: str, key: str, task: str, values: dict[str, Any], route: str, *,
                    description: str = "", request_id: str | None = None, chat: dict[str, Any] | None = None,
                    work: Path | str | None = None, call: str | None = None, caller_role: str | None = None,
                    check: bool = True) -> Answer:
    """One start of any role, for the agent of `key`, with the prompt `task` and the run's values. A click or a
    follow-on start writes the pending request, then asks the module to spawn it, and answers what the module did
    (Answer); a typed one records the request and answers the exact Agent call for the start tool's result. Without a
    live module, or while main is in plan mode or not fenced, it refuses before making the request (refusal_before;
    `check` False skips that, for a caller that checked). `request_id` is the request's id when the caller made it
    (request_id), for a prompt that names it. `chat` holds the fields of the agent's chat (its title, a
    writer's document), `work` its work folder (the scratch folders of its subagents), `call` the start tool's call
    in main (R3), and `caller_role` the role of the agent that makes a typed call itself (the critic's start, made by
    the orientation)."""
    if role not in TYPES or role == HELPER:
        raise ValueError(f"no role {role!r}")
    if check and not caller_role:
        before = refusal_before(c, click=route == CLICK)
        if before is not None:
            return before
    rid = request_id or files.request_id()
    prompt = with_request_line(task, rid) if route == TYPED else task
    inp = call_input(role, prompt, description or role)
    rid = new_request(c, "start", key, inp, values, route, role=role, rid=rid, chat=dict(chat or {}),
                      work=str(work) if work else None, call=call, caller_role=caller_role)
    if route == TYPED:
        if work:
            make_work(c, Path(work))
        return Answer({"request": rid, "input": inp})
    return await _spawn(c, rid, request(c, rid) or {})


def make_work(c: str, work: Path) -> None:
    """The agent's work folder made before it starts, as agent_session made a session's: main's sandbox lets Bash write
    in the work folders (write_dirs) but not in the workspace around them, so an agent cannot make its own folder.
    Only a folder inside the workspace."""
    root = ws(c).resolve()
    try:
        if root not in work.resolve().parents:
            log.warning("%s: the work folder %s is outside the workspace; not made", c, work)
            return
        work.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        log.warning("%s: the work folder %s was not made: %s", c, work, e)


async def _spawn(c: str, rid: str, r: dict[str, Any]) -> Answer:
    if r.get("work"):
        make_work(c, Path(str(r["work"])))
    inp = r.get("input") or {}
    ans = await _bridge(c, "spawn", role=r.get("role"), values=r.get("values") or {}, prompt=inp.get("prompt"),
                        description=inp.get("description"), request=rid, what=_what(r))
    if ans.started:
        bind(c, str(ans.agent_id), rid)
        return Answer({**ans, "request": rid})
    if ans.get("expired"):
        expire(c, rid)
    else:
        refuse(c, rid, ans.reason, ans.kind or ERROR)
    return Answer({**ans, "request": rid})


def _what(r: dict[str, Any]) -> str:
    """The server-checked name a module note gives (module-started-note's {what}): a writer's document, a view's slug, a
    check's id and its document; never text an agent wrote."""
    key = str(r.get("key") or "")
    return key.split(":", 1)[1].replace(":", " on ") if ":" in key else ""


def bind(c: str, agent_id: str, rid: str) -> dict[str, Any] | None:
    """The agent `agent_id` takes up the start `rid` in the registry, unless its SubagentStart did first: the module
    answered a click with it, or the mirror found a typed start's agent whose call claimed the request. Its chat is made
    (ensure_chat)."""
    from . import session  # noqa: PLC0415

    lv = session.current(c)
    with update(c) as state:
        r = files.requests(state).get(rid)
        if not isinstance(r, dict):
            return None
        reg = files.registry(state)
        if agent_id not in reg:
            plugin = r.get("route") in (CLICK, FOLLOW_ON) or str(r.get("claimed_by") or "").startswith(files.PLUGIN_CALL)
            reg[agent_id] = {"key": r.get("key"), "type": (r.get("input") or {}).get("subagent_type"),
                             "role": r.get("role"), "request": rid, "parent": r.get("caller"), "run": 0,
                             "values": r.get("values") or {}, "route": r.get("route"), "plugin_started": plugin,
                             "sessions": [lv.sid] if lv is not None else [], "started": files.now(),
                             "last_start": files.now(), "starts": 1,
                             "status": "running", "work": r.get("work"), "handed_back": False}
        r.update(state="started", agent=agent_id, at=files.now())
    return ensure_chat(c, agent_id)


# --------------------------------------------------------------------------- follow-ups and stops


def message_input(agent_id: str, text: str) -> dict[str, Any]:
    return {"to": agent_id, "message": text}


def message_request(c: str, agent_id: str, text: str, *, call: str | None = None) -> Answer:
    """A follow-up typed to main (message_orientation): the pending message request and the exact SendMessage."""
    a = agent(c, agent_id) or {}
    inp = message_input(agent_id, text)
    rid = new_request(c, "message", a.get("key"), inp, a.get("values"), TYPED, role=a.get("role"), agent=agent_id,
                      call=call)
    return Answer({"request": rid, "input": inp})


async def send(c: str, agent_id: str, text: str, *, values: dict[str, Any] | None = None, route: str = CLICK) -> Answer:
    """A follow-up sent from the browser: the pending message request, then the module's SendMessage, after it
    registers the run's own values when they differ from the role's latest registration (V1). Refused, with the text
    kept, when the module is not live."""
    a = agent(c, agent_id)
    if a is None:
        return refusal(EARLIER, tools.hint("orient-continue-earlier-session", resume=""))
    before = refusal_before(c, click=route == CLICK)
    if before is not None:
        return before
    vals = dict(values or a.get("values") or {})
    rid = new_request(c, "message", a.get("key"), message_input(agent_id, text), vals, route, role=a.get("role"),
                      agent=agent_id)
    ans = await _bridge(c, "send", agent=agent_id, text=text, values=vals, role=a.get("role"), request=rid)
    if ans.started or (not ans.refused and "error" not in ans):
        _set(c, rid, state="done", at=files.now())
        return Answer({**ans, "agentId": agent_id, "request": rid})
    if USER_STOP_RE.search(ans.reason):  # stopped with Esc in its view, though no notification said so here
        mark_cancelled(c, agent_id)
    if ans.get("expired"):
        expire(c, rid)
    else:
        refuse(c, rid, ans.reason, ans.kind or ERROR)
    return Answer({**ans, "request": rid})


def stop_done(text: str) -> bool:
    """Whether a failed TaskStop says its agent had ended already, so the stop counts as done (U5)."""
    low = text.lower()
    return "is not running" in low or "no task found" in low


async def stop(c: str, agent_id: str) -> Answer:
    """Stop an agent through the module (TaskStop). Refused when the module is not live: the card then says to press
    Esc in the agent's view. An agent that had ended already counts as stopped."""
    from . import module_bridge  # noqa: PLC0415

    a = agent(c, agent_id) or {}
    if not module_bridge.live(c):
        return refusal(NO_MODULE, str(module_bridge.why_not(c) or ""))
    rid = new_request(c, "stop", a.get("key"), {"task_id": agent_id}, None, CLICK, role=a.get("role"), agent=agent_id)
    ans = await _bridge(c, "stop", agent=agent_id, request=rid)
    if ans.refused and (ans.get("gone") or stop_done(ans.reason)):
        ans = Answer({"agentId": agent_id, "done": True})
    _set(c, rid, state="done" if not ans.refused else "refused", at=files.now(), reason=ans.reason or None)
    if not ans.refused:
        mark_stopped_by(c, agent_id, STOPPED_ANALYST)
    return Answer({**ans, "request": rid})


def mark_stopped_by(c: str, agent_id: str, who: str) -> None:
    with update(c) as state:
        a = files.registry(state).get(agent_id)
        if isinstance(a, dict):
            a["stopped_by"] = who


def mark_cancelled(c: str, agent_id: str) -> None:
    """An agent stopped with Esc in its view (STOPPED_USER), which Claude Code resumes no more: the registry and its chat
    say so (`continue: stopped-by-user`), so the browser offers a new start in place of a follow-up that cannot work."""
    with update(c) as state:
        a = files.registry(state).get(agent_id)
        if not isinstance(a, dict):
            return
        a.update(stopped_by=STOPPED_USER, cancelled=True)
        chat = str(a.get("chat") or "")
    if chat:
        with contextlib.suppress(Exception):
            agents.update_agent(c, chat, stopped_by=STOPPED_USER, **{"continue": CANCELLED})


def cancelled(c: str, agent_id: str | None) -> bool:
    """Whether Claude Code resumes `agent_id` no more, since it was stopped with Esc in its view (mark_cancelled)."""
    return bool((agent(c, agent_id) or {}).get("cancelled"))


# --------------------------------------------------------------------------- runs


@dataclass
class Run:
    """A registered agent of one of thimble's roles as its handlers see it: its key, chat, agent id, run (0 the first,
    then one per follow-up), main's session, and the chat whose call store numbers its calls (`calls`, the
    orientation's)."""

    c: str
    key: str
    role: str
    chat: str
    agent_id: str
    k: int = 0
    sid: str = ""
    values: dict[str, Any] | None = None
    plugin_started: bool = False
    route: str = ""
    request: str = ""
    interrupted: bool = False

    @property
    def calls(self) -> str | None:
        return self.chat if self.role == "orientation" else None


def _run(c: str, agent_id: str, a: dict[str, Any]) -> Run | None:
    if not a.get("chat") or a.get("role") not in TYPES:
        return None
    sessions = a.get("sessions") or []
    return Run(c, str(a.get("key") or ""), str(a["role"]), str(a["chat"]), agent_id, int(a.get("run") or 0),
               str(sessions[-1]) if sessions else "", dict(a.get("values") or {}), bool(a.get("plugin_started")),
               str(a.get("route") or ""), str(a.get("request") or ""))


def current(c: str, key: str | None) -> Run | None:
    """The run of the agent of `key` that goes now (running, or waiting for its child), else None."""
    if not key:
        return None
    for agent_id, a in reversed(list(agents_of(c, key=key).items())):
        if a.get("status") in ("running", "waiting"):
            return _run(c, agent_id, a)
    return None


def running(c: str, key: str | None) -> bool:
    return current(c, key) is not None


def latest(c: str, key: str) -> Run | None:
    """The latest agent of `key`, running or not."""
    found = list(agents_of(c, key=key).items())
    return _run(c, *found[-1]) if found else None


def by_chat(c: str, chat: str) -> Run | None:
    for agent_id, a in files.registry(read(c)).items():
        if isinstance(a, dict) and a.get("chat") == chat:
            return _run(c, agent_id, dict(a))
    return None


def ensure_chat(c: str, agent_id: str) -> dict[str, Any] | None:
    """The chat of a registered agent of one of thimble's roles, made on the first of its signs (the module's answer,
    its SubagentStart, the mirror finding its transcript): a chat of its type's chat role with the request's fields,
    `route: subagent`, its agent id, values and main's session. The role's start handler (Type.started) runs once, when
    the chat is made. The chat's meta, or None for an agent with no chat of its own."""
    from . import session  # noqa: PLC0415

    a = agent(c, agent_id)
    if a is None or a.get("role") not in TYPES:
        return None
    t = TYPES[str(a["role"])]
    if t.chat_role is None:
        return None
    if a.get("chat"):
        meta = agents.meta_or_none(c, str(a["chat"]))
        if meta is not None:
            return meta
    r = request(c, str(a.get("request") or "")) or {}
    fields = dict(r.get("chat") or {})
    title = str(fields.pop("title", "") or t.role)
    parent = str(fields.pop("parent", "") or agents.MAIN_ID)
    sid = (a.get("sessions") or [""])[-1] or (session.current(c).sid if session.current(c) is not None else "")
    meta = agents.new_agent(c, t.chat_role, title, parent=parent, by=agents.TERMINAL, route="subagent",
                            agent_id=agent_id, agent_type=type_name(t.role), values=a.get("values") or {},
                            session=sid, sessions=[sid] if sid else [], key=a.get("key"), request=a.get("request"),
                            started_by=CLICK if a.get("route") in (CLICK, FOLLOW_ON) else TYPED, run=0,
                            tool_use_id=r.get("claimed_by"), **fields)
    with update(c) as state:
        reg = files.registry(state)
        if isinstance(reg.get(agent_id), dict):
            reg[agent_id]["chat"] = meta["id"]
    run = _run(c, agent_id, {**a, "chat": meta["id"]})
    with contextlib.suppress(Exception):
        session.expect_agent(c, agent_id, str(meta["id"]), t.chat_role)
    if run is not None and t.started:
        try:
            _resolve(t.started)(c, run, r)
        except Exception:  # noqa: BLE001 — the chat is made either way
            log.exception("%s: the %s's start handler failed", c, t.role)
    return meta


def run_again(c: str, agent_id: str, by: str = "") -> Run | None:
    """A finished agent was sent a message (a follow-up from main or the module, `by` coordinator) or typed to in the
    agent tray (`by` human): run k+1 begins. The role's start handler sees it as run.k > 0."""
    with update(c) as state:
        a = files.registry(state).get(agent_id)
        if not isinstance(a, dict) or a.get("role") not in TYPES:
            return None
        if a.get("status") in ("running", "waiting"):
            return _run(c, agent_id, dict(a))
        was_cancelled = bool(a.get("cancelled"))
        a.update(run=int(a.get("run") or 0) + 1, status="running", handed_back=False, by=by or None,
                 stopped_by=None, run_started=files.now(), cancelled=None)
        snap = dict(a)
    if snap.get("chat"):
        with contextlib.suppress(Exception):
            agents.update_agent(c, str(snap["chat"]), status="running", ts_end=None, result=None, run=snap["run"],
                                stopped_by=None, typed_in_tray=by == "human" or None, paused=None,
                                **({"continue": None} if was_cancelled else {}))
    run = _run(c, agent_id, snap)
    t = TYPES[str(snap["role"])]
    if run is not None and t.started:
        try:
            _resolve(t.started)(c, run, request(c, str(snap.get("request") or "")) or {})
        except Exception:  # noqa: BLE001
            log.exception("%s: the %s's start handler failed for run %s", c, t.role, run.k)
    return run


def _bare(model: str) -> str:
    """A model id without its context-window suffix (`[1m]`), which transcripts leave out."""
    return str(model or "").split("[", 1)[0].strip()


def ran_on(c: str, agent_id: str, model: str, effort: str | None = None) -> bool:
    """The model (and the effort, when the transcript names one) the current run of a registered agent ran on, read
    from the first reply of that run in its transcript: kept by run in the registry and on its chat (`ran`). For a
    follow-up main sent (a typed SendMessage, which runs on the role's registration in force, not on the run's values),
    a model other than the run's shows hint `follow-up-ran-on` in main's chat. True when this run's was new."""
    if not model or model.startswith("<"):
        return False
    with update(c) as state:
        a = files.registry(state).get(agent_id)
        if not isinstance(a, dict) or a.get("role") not in TYPES:
            return False
        k = str(int(a.get("run") or 0))
        ran = a.get("ran") if isinstance(a.get("ran"), dict) else {}
        if k in ran:
            return False
        a["ran"] = {**ran, k: {"model": model, **({"effort": effort} if effort else {})}}
        snap = dict(a)
        msgs = [r for r in files.requests(state).values() if isinstance(r, dict) and r.get("kind") == "message"
                and r.get("agent") == agent_id and r.get("state") in ("claimed", "done")]
    chat = str(snap.get("chat") or "")
    if chat:
        with contextlib.suppress(Exception):
            agents.update_agent(c, chat, ran=snap["ran"])
    want = str((snap.get("values") or {}).get("model") or "")
    typed = bool(msgs) and max(msgs, key=lambda r: float(r.get("created") or 0)).get("route") == TYPED
    if int(k) > 0 and typed and want and _bare(want) != _bare(model):
        with contextlib.suppress(Exception):
            agents.chip(c, "follow_up_ran_on", tools.hint("follow-up-ran-on", model=model, effort=effort or ""),
                        chat=chat or None)
    return True


def api_error(c: str, agent_id: str) -> str | None:
    """Claude Code's error line when the latest reply of the agent's current run is an API error (session.agent_error),
    else None."""
    from . import session  # noqa: PLC0415

    try:
        return session.agent_error(c, agent_id)
    except Exception:  # noqa: BLE001 — a transcript that cannot be read says nothing of the run's end
        log.debug("%s: the reply of %s was not read", c, agent_id, exc_info=True)
        return None


def run_ended(c: str, agent_id: str, status: str, report: str | None, *, source: str = "",
              interrupted: bool = False) -> bool:
    """End the current run of a registered agent once: its status, its chat ended with the report, and its role's end
    handler (Type.ended). A run whose latest reply is an API error (api_error: a refusal by the model's safeguards,
    retries run out) failed, with Claude Code's error line as its report, whichever signal ends it, unless the agent
    handed back or was stopped. A run that ended already (another signal of the same end) is left alone. True when this
    call ended it."""
    if source != "handback" and status != "stopped":
        error = api_error(c, agent_id)  # read first: the transcript's tail may hold the run's hand-back, which ends it
        if error:
            status, report = "failed", error
    with update(c) as state:
        a = files.registry(state).get(agent_id)
        if not isinstance(a, dict):
            return False
        k = int(a.get("run") or 0)
        if a.get("ended_run") == k and a.get("status") not in ("running", "waiting"):
            return False
        status = status if status in ("done", "stopped", "failed") else "done"
        a.update(status=status, ended_run=k, ended=files.now(), handed_back=source == "handback" or a.get("handed_back"),
                 waiting_since=None)
        snap = dict(a)
    log.info("%s: %s %s run %s ended %s (%s)", c, snap.get("role") or "agent", agent_id, snap.get("run"), status,
             source or "?")
    t = TYPES.get(str(snap.get("role") or ""))
    if snap.get("chat"):
        try:
            fields = {"stopped_by": snap.get("stopped_by")} if status == "stopped" and snap.get("stopped_by") else {}
            agents.finish_agent(c, str(snap["chat"]), status, (report or "")[:400] or None, paused=None, **fields)
        except Exception:  # noqa: BLE001 — a chat deleted under the run
            log.debug("%s: the chat of %s was not ended", c, agent_id, exc_info=True)
    run = _run(c, agent_id, snap)
    if run is not None:
        run.interrupted = interrupted
    if run is not None and t is not None and t.ended:
        try:
            _resolve(t.ended)(c, run, status, report or "")
        except Exception:  # noqa: BLE001 — the run has ended either way
            log.exception("%s: the %s's end handler failed", c, t.role)
    return True


def children_running(state: dict[str, Any], agent_id: str) -> bool:
    return any(isinstance(a, dict) and a.get("parent") == agent_id and a.get("status") in ("running", "waiting")
               for a in files.registry(state).values())


def set_paused(c: str, agent_id: str, paused: str | None) -> None:
    """The chat of `agent_id` marked `paused` (the orientation while it waits for its critic), or no longer."""
    a = agent(c, agent_id)
    if a and a.get("chat"):
        with contextlib.suppress(Exception):
            agents.update_agent(c, str(a["chat"]), paused=paused)


_waits: dict[tuple[str, str], asyncio.TimerHandle] = {}


def stopped(c: str, agent_id: str, last_stop: float | None = None) -> None:
    """A SubagentStop of a registered agent: its turn ended. With a child running it waits for it (the orientation for
    its critic); otherwise the run ends with that turn's answer (session.agent_answer) unless a hand-back follows within
    HANDBACK_WAIT_S (AUTO_HANDBACK_WAIT_S in auto mode)."""
    from . import session  # noqa: PLC0415

    state = read(c)
    a = files.registry(state).get(agent_id)
    if not isinstance(a, dict) or a.get("status") not in ("running", "waiting"):
        return
    if children_running(state, agent_id):
        with update(c) as st:
            if isinstance(files.registry(st).get(agent_id), dict):
                files.registry(st)[agent_id].update(status="waiting", waiting_since=files.now())
        return
    wait = AUTO_HANDBACK_WAIT_S if session.main_mode(c) == "auto" else HANDBACK_WAIT_S
    k = int(a.get("run") or 0)

    def check() -> None:
        _waits.pop((c, agent_id), None)
        now_a = agent(c, agent_id) or {}
        if now_a.get("ended_run") == k or int(now_a.get("run") or 0) != k or children_running(read(c), agent_id):
            return
        run_ended(c, agent_id, "done", session.agent_answer(c, agent_id), source="turn")

    old = _waits.pop((c, agent_id), None)
    if old is not None:
        old.cancel()
    try:
        _waits[(c, agent_id)] = asyncio.get_running_loop().call_later(wait, check)
    except RuntimeError:  # no loop (a synchronous test): at once
        check()


STOPPED_REASONS = ("abort", "interrupt", "cancel", "kill", "stop")  # a turn.complete reason that means the turn was cut off
# a turn.complete reason that means the run failed: an API error ended it (`error`), or the model refused with no fallback
# model to retry on (`refusal`)
FAILED_REASONS = ("error", "fail", "refus")
NO_ERROR_TEXT = "Claude Code ended the run ({reason}) and gave no error text"  # a failed run's report when none came


def ended(c: str, agent_id: str, answer: str | None = None, reason: str = "") -> bool:
    """The module's `ended {agentId, answer, reason}` (its turn.complete, which reaches it for the agents it started
    although its other hooks skip them): a turn's end with its answer, which ends the run once when no child of the
    agent runs; stopped or failed when the reason says so (`aborted`; `error`, `refusal`), a failure with the API's
    error line as its report (run_ended)."""
    state = read(c)
    a = files.registry(state).get(agent_id)
    if not isinstance(a, dict) or children_running(state, agent_id):
        return False
    why = str(reason or "").lower()
    status = "stopped" if any(w in why for w in STOPPED_REASONS) else "failed" if any(
        w in why for w in FAILED_REASONS) else "done"
    if status == "failed" and not str(answer or "").strip():
        answer = NO_ERROR_TEXT.format(reason=why)
    return run_ended(c, agent_id, status, answer, source="module")


def _hear_module() -> None:
    """Register `ended` for the module's ended posts (module_bridge.on_ended), once; nothing without the bridge."""
    try:
        from . import module_bridge  # noqa: PLC0415
    except ImportError:
        return
    hear = getattr(module_bridge, "on_ended", None)
    if callable(hear):
        hear(ended)


def child_ended(c: str, agent_id: str) -> None:
    """A child of a registered agent ended (the critic's hand-back to the orientation): the parent goes on in its run,
    no longer paused."""
    a = agent(c, agent_id)
    if a and a.get("status") == "waiting":
        with update(c) as st:
            if isinstance(files.registry(st).get(agent_id), dict):
                files.registry(st)[agent_id].update(status="running", waiting_since=None)
    set_paused(c, agent_id, None)


def tell_main(c: str, kind: str, payload: dict[str, Any]) -> bool:
    """A browser event for main from server code (an `orient` or `written` end line): posted, or, with no session
    listening, logged and dropped, since thimble's agents end with main. False when no session heard it."""
    from . import events  # noqa: PLC0415

    try:
        events.post(c, kind, payload, check_kind=False)
    except HTTPException as e:
        if e.status_code != 409:
            raise
        log.info("%s: no session heard the %s event", c, kind)
        return False
    return True


async def out_of_plan(c: str, poll_s: float = 2.0) -> None:
    """Wait while main is in plan mode, where a subagent would ask before every call (U20): a follow-on start waits
    rather than being refused."""
    from . import session  # noqa: PLC0415

    while session.main_mode(c) == files.PLAN_MODE and session.current(c) is not None:
        await asyncio.sleep(poll_s)


# --------------------------------------------------------------------------- main's quit and moves


def close_running(c: str, why: str = STOPPED_QUIT) -> list[str]:
    """Main quit (any SessionEnd reason but clear and resume): every running agent of thimble's ends stopped, its chat
    `stopped_by: quit` (`why`) and `continue: here`, so a follow-up after `thimble --continue` resumes it; nothing
    restarts it. The ids stopped."""
    gone = [k for k, a in agents_of(c).items() if a.get("status") in ("running", "waiting")]
    for agent_id in gone:
        mark_stopped_by(c, agent_id, why)
        run_ended(c, agent_id, "stopped", QUIT_LINE, source="quit", interrupted=True)
        a = agent(c, agent_id) or {}
        if a.get("chat"):
            with contextlib.suppress(Exception):
                agents.update_agent(c, str(a["chat"]), stopped_by=why, **{"continue": "here"})
    return gone


def rekey(c: str, old: str, new: str) -> list[str]:
    """After /clear or an in-session /resume: the running agents move from main's session `old` to `new` in the registry
    and their chats (`session`, `sessions`), and the mirror follows their transcripts in the new session's folder from
    offset 0 (session.rekeyed). Either order with the module's new hello works (V2)."""
    from . import session  # noqa: PLC0415

    with update(c) as state:
        files.rekey(state, old, new)  # the --rekey hook moved them in the file already, or not yet
        moved = [k for k, a in files.registry(state).items() if isinstance(a, dict) and a.get("status") == "running"
                 and (a.get("sessions") or [""])[-1] == new and old in (a.get("sessions") or [])]
        snaps = {k: dict(files.registry(state)[k]) for k in moved}
    for agent_id, a in snaps.items():
        if a.get("chat"):
            with contextlib.suppress(Exception):
                agents.update_agent(c, str(a["chat"]), session=new, sessions=list(a.get("sessions") or []))
    with contextlib.suppress(Exception):
        session.rekeyed(c, old, new, moved)
    return moved


# --------------------------------------------------------------------------- the caller of a thimble tool


@dataclass(frozen=True)
class Caller:
    """The agent that made a thimble call: its id and type, and the agent of thimble's whose session it runs as (itself
    for one of the roles, its ancestor for a descendant), with that agent's key and chat."""

    agent_id: str
    agent_type: str
    key: str
    role: str
    chat: str | None
    root: str


def caller_of(c: str, agent_id: str, agent_type: str = "") -> Caller | None:
    """The Caller of `agent_id` from the registry; None for an agent that is no business of thimble's."""
    reg = files.registry(read(c))
    a = reg.get(agent_id)
    if not isinstance(a, dict):
        return None
    root_id = agent_id if a.get("role") in ROLES else str(a.get("root") or "")
    root = reg.get(root_id) if root_id else None
    if not isinstance(root, dict) or not root.get("key"):
        return None
    return Caller(agent_id, agent_type or str(a.get("type") or ""), str(root["key"]), str(root.get("role") or ""),
                  str(root.get("chat") or "") or None, root_id)


async def caller(c: str, tool_use_id: str | None) -> Caller | None:
    """The agent that made the thimble call `tool_use_id`, from the caller hook's line (callers.jsonl), waiting up to
    CALLER_WAIT_S for it; then from the mirror's search of the transcripts (session.caller_sub). None for main's own call
    and for a call of an agent that is not thimble's."""
    from . import session  # noqa: PLC0415

    if not tool_use_id:
        return None
    end = time.monotonic() + CALLER_WAIT_S
    while True:
        line = files.find_caller(ws(c), tool_use_id)
        if line is not None:
            return caller_of(c, str(line.get("agent_id") or ""), str(line.get("agent_type") or ""))
        if time.monotonic() >= end:
            break
        await asyncio.sleep(0.05)
    sub = await session.caller_sub(c, tool_use_id)
    if sub is None or not sub.agent_id:
        return None
    return caller_of(c, sub.agent_id)


def allowed(who: Caller, name: str) -> bool:
    """Whether the agent `who` may call the thimble tool `name`: one of its role's own tools, and its session kind among
    those the tool's Spec names."""
    spec = tools.REGISTRY.get(tools.canonical(name))
    if spec is None:
        return False
    own = own_tools(who.role)
    if own is not None and spec.name not in own:
        return False
    return not spec.sessions or kind_of(who.key) in spec.sessions


# --------------------------------------------------------------------------- routes (the hooks' fast path)


class HookBody(BaseModel):
    """A hook's input with its folder: what the hook already wrote to the workspace's files, posted when a server runs."""

    cwd: str
    hook: dict[str, Any] = {}


def _workspace(body: HookBody) -> str:
    c = config.workspace_for_cwd(body.cwd)
    if not c:
        raise HTTPException(404, f"{body.cwd} is not a thimble workspace")
    return c


@router.post("/subagents/started")
async def started_route(body: HookBody) -> dict[str, Any]:
    """SubagentStart: an agent the hook registered gets its chat (ensure_chat); a child of a waiting agent wakes nothing.
    {agent, chat}."""
    c = _workspace(body)
    agent_id = str(body.hook.get("agent_id") or "")
    a = agent(c, agent_id)
    if a is None:
        return {"agent": None}
    meta = ensure_chat(c, agent_id) if a.get("role") in ROLES else None
    if a.get("parent") and a.get("role") in ROLES:
        set_paused(c, str(a["parent"]), "critique" if a.get("role") == "critic" else None)
    return {"agent": agent_id, "chat": (meta or {}).get("id")}


@router.post("/subagents/caller")
async def caller_route(body: HookBody) -> dict[str, Any]:
    """PreToolUse on thimble's tools: the caller hook wrote its line; nothing more is needed here."""
    return {}


@router.post("/subagents/denied")
async def denied_route(body: HookBody) -> dict[str, Any]:
    """PermissionDenied: R1. The hook refused the request in subagents.json; here its role's refusal handler tells
    the run record and the browser."""
    c = _workspace(body)
    rid = str(body.hook.get("request") or "")
    r = request(c, rid) if rid else None
    if r is not None and r.get("state") == "refused":
        _refused(c, {**r, "id": rid})
    return {"request": rid or None}


@router.post("/subagents/stopped")
async def stopped_route(body: HookBody) -> dict[str, Any]:
    """SubagentStop: a turn's end of a registered agent (stopped)."""
    c = _workspace(body)
    if body.hook.get("stop_hook_active") or not str(body.hook.get("agent_type") or ""):
        return {}
    stopped(c, str(body.hook.get("agent_id") or ""))
    return {}


@router.post("/subagents/end")
async def end_route(body: HookBody) -> dict[str, Any]:
    """SessionEnd: main quit, so its thimble agents' chats close (close_running) and the server's jobs stop at once
    (agents.stop_all); on `clear` and `resume` only the record, which the hook made."""
    from . import session  # noqa: PLC0415

    c = _workspace(body)
    reason = str(body.hook.get("reason") or "")
    sid = str(body.hook.get("session_id") or "")
    lv = session.current(c)
    if reason in ("clear", "resume") or (lv is not None and sid and lv.sid != sid):
        return {"closed": []}
    closed = close_running(c, STOPPED_QUIT)
    session.main_quit(c, sid)
    return {"closed": closed}


@router.post("/subagents/rekey")
async def rekey_route(body: HookBody) -> dict[str, Any]:
    """SessionStart `clear` or `resume`: the hook moved the agents to the new session in subagents.json (its `old`); the
    chats and the mirror follow (rekey)."""
    c = _workspace(body)
    old, new = str(body.hook.get("old") or ""), str(body.hook.get("session_id") or "")
    if old and new:
        try:
            from . import module_bridge  # noqa: PLC0415

            move = getattr(module_bridge, "rekey", None)
            if callable(move):
                move(c, old, new)  # a hello from `new` is accepted, whichever came first
        except ImportError:
            pass
    return {"moved": rekey(c, old, new) if old and new else []}


FORK_DEDUPE_S = 600.0  # how long a thread's fork counts as starting, until the mirror sees it finish
_forking: dict[tuple[str, str], float] = {}  # (workspace, thread) -> time.monotonic() when its fork's Agent call ran


def fork_check(c: str, tool_input: dict[str, Any]) -> str | None:
    """Main's Agent call that would start a second fork of a thread whose fork runs or is starting: why it must not
    run, else None (the --agent-check hook asks the server this, since it needs the threads)."""
    from . import session  # noqa: PLC0415

    if str(tool_input.get("subagent_type") or "") != "fork":
        return None
    tid = session.thread_for(c, tool_input.get("description"))
    if not tid:
        return None
    started = _forking.get((c, tid))
    if started is not None and time.monotonic() - started < FORK_DEDUPE_S:
        name = str(tool_input.get("description") or "").removeprefix("thread:")
        return f"The fork of thread {name} is running already; it answers in the thread."
    _forking[(c, tid)] = time.monotonic()
    return None


def fork_ended(c: str, thread_id: str) -> None:
    """A thread's fork stopped, so a new Agent call may fork it again (fork_check)."""
    _forking.pop((c, thread_id), None)


class AgentCheckBody(BaseModel):
    cwd: str
    agent_id: str | None = None
    tool_use_id: str | None = None
    tool_input: dict[str, Any] = {}


@router.post("/bg/agent-check")
async def agent_check_route(body: AgentCheckBody) -> dict[str, Any]:
    """The --agent-check hook, for main's Agent call, once it found nothing to deny in subagents.json: {deny, reason}
    for a second fork of a thread (fork_check)."""
    c = config.workspace_for_cwd(body.cwd)
    reason = fork_check(c, body.tool_input) if c and not body.agent_id else None
    if reason:
        log.info("%s: an Agent call is refused: %s", c, reason)
    return {"deny": bool(reason), "reason": reason or ""}


# --------------------------------------------------------------------------- the analyst's clicks


def analyst_only(request: Request) -> None:
    """403 unless the request carries the analyst's browser cookie (hook_auth.analyst): a click starts, sends or stops
    an agent that auto mode does not judge, so the server's token, which the shim, the hooks and the CLI hold, is not
    enough."""
    from . import hook_auth  # noqa: PLC0415

    if not hook_auth.analyst(request):
        raise HTTPException(403, hook_auth.ANALYST_ONLY)


class RequestBody(BaseModel):
    request: str


@router.post("/ws/{c}/subagents/start-it")
async def start_it_route(c: str, body: RequestBody, http: Request) -> dict[str, Any]:
    """Start it: a refused typed start, started through the module with the same request and values."""
    analyst_only(http)
    config.workspace_dir(c)
    return _answered(await start_it(c, body.request))


@router.post("/ws/{c}/subagents/again")
async def again_route(c: str, body: RequestBody, http: Request) -> dict[str, Any]:
    """Try again, Send again and Write again: the request made anew as a click."""
    analyst_only(http)
    config.workspace_dir(c)
    return _answered(await again(c, body.request))


def _answered(ans: Answer) -> dict[str, Any]:
    """A click route's answer as /start and /write give it: the module's answer, with {kind, reason} when refused."""
    return {**dict(ans), **({"kind": ans.kind, "reason": ans.reason} if ans.refused else {})}


@router.get("/ws/{c}/subagents/requests/{rid}")
async def request_route(c: str, rid: str) -> dict[str, Any]:
    """A request as the refused card shows it before Start it: its role, its exact call, its values and its state."""
    config.workspace_dir(c)
    r = request(c, rid)
    if r is None:
        raise HTTPException(404, "no such request")
    return {"id": rid, **{k: r.get(k) for k in ("kind", "route", "role", "key", "input", "values", "state", "reason",
                                                 "refused_kind")}}


CLICK_ROUTES: tuple[Callable[..., Any], ...] = (start_it_route, again_route)  # the module's routes here (a test walks them)


# --------------------------------------------------------------------------- older workspaces


OLD_BG_FILE = "bg-sessions.json"  # in the workspace: the background sessions thimble 0.5.0 started
ORPHAN_WAIT_S = 3.0  # after SIGTERM to a process an earlier version left, before SIGKILL
EARLIER_VERSION = "earlier-version"  # a chat's `continue` when an earlier version of thimble ran its agent


def _stop_background(short: str) -> None:
    """`claude stop <short>`: the end of an earlier version's background session, with its conversation kept. Blocking;
    never raises."""
    import subprocess  # noqa: PLC0415

    try:
        subprocess.run([config.CLAUDE_BIN, "stop", short], capture_output=True, text=True, timeout=30,
                       env=config.launch_environ())
    except (OSError, subprocess.SubprocessError):
        log.debug("background session %s was not stopped", short, exc_info=True)


def stop_old_background(c: str) -> list[str]:
    """The background sessions thimble 0.5.0 started in workspace `c` (OLD_BG_FILE, and the chats whose meta keeps a
    `bg` short id) end with `claude stop`, their conversations kept, so an orientation or a writer that sat idle in
    Claude Code's background service across the update does not run on beside a new one. The file is renamed once read,
    so this runs once. Blocking; returns the short ids stopped."""
    path = config.workspace_dir(c) / OLD_BG_FILE
    shorts: list[str] = []
    try:
        rows = json.loads(path.read_text("utf-8"))
    except (OSError, ValueError):
        rows = []
    for row in rows if isinstance(rows, list) else []:
        if isinstance(row, dict) and str(row.get("short") or "").strip():
            shorts.append(str(row["short"]).strip())
    chats = [m for m in agents.list_chats(c) if m.get("bg")]
    shorts.extend(str(m["bg"]) for m in chats)
    shorts = list(dict.fromkeys(shorts))
    for short in shorts:
        _stop_background(short)
    for meta in chats:
        with contextlib.suppress(Exception):
            agents.update_agent(c, str(meta["id"]), bg=None)
    if path.exists():
        with contextlib.suppress(OSError):
            path.rename(path.with_name(OLD_BG_FILE + ".stopped"))
    if shorts:
        log.info("%s: an earlier version's background sessions were stopped: %s", c, ", ".join(shorts))
    return shorts


def kill_left(meta: dict[str, Any]) -> None:
    """End the process of a run an earlier version left (a chat whose meta keeps its `pid`), when it still runs and is
    that session's own (its argv names the session id, so a reused pid is left alone): SIGTERM to its process group,
    SIGKILL after ORPHAN_WAIT_S, then SIGKILL to what is left of the processes it started. Blocking."""
    import os  # noqa: PLC0415
    import signal  # noqa: PLC0415

    from . import procs  # noqa: PLC0415

    if meta.get("background") and meta.get("bg"):
        _stop_background(str(meta["bg"]))
    pid, sid = meta.get("pid"), str(meta.get("session") or "")
    if not isinstance(pid, int) or pid <= 0 or not sid or not procs.alive(pid) or sid not in procs.argv(pid):
        return
    tree = procs.descendants(pid)
    for sig in (signal.SIGTERM, signal.SIGKILL):
        with contextlib.suppress(ProcessLookupError, PermissionError):
            os.killpg(pid, sig)
        deadline = time.monotonic() + ORPHAN_WAIT_S
        while procs.alive(pid) and time.monotonic() < deadline:
            time.sleep(0.1)
        if not procs.alive(pid):
            break
    for p in tree:
        with contextlib.suppress(ProcessLookupError, PermissionError):
            os.kill(p, signal.SIGKILL)
    log.info("session %s (pid %s), left running by an earlier version, was ended", sid, pid)


def close_old(c: str) -> list[str]:
    """The chats an earlier version's own sessions left running in workspace `c` (a `pid` on the meta and no
    `route: subagent`) have their processes ended (kill_left) and end stopped, `continue: earlier-version`: a message to
    such an orientation gets the earlier-version text (orient_session.latest). The chats closed. Blocking."""
    closed = []
    for meta in agents.list_chats(c):
        if meta.get("route") == "subagent" or meta.get("status") != "running" or "pid" not in meta:
            continue
        try:
            kill_left(meta)
            agents.update_agent(c, str(meta["id"]), pid=None, parked=None, permissions=[],
                                **{"continue": EARLIER_VERSION})
            agents.finish_agent(c, str(meta["id"]), "stopped", QUIT_LINE)
            closed.append(str(meta["id"]))
        except Exception:  # noqa: BLE001 — never fails the start
            log.exception("%s: chat %s, left running by an earlier version, was not closed", c, meta.get("id"))
    return closed


async def recover_old() -> list[str]:
    """Server start: in every workspace, an earlier version's background sessions stop (stop_old_background) and the
    chats its own sessions left running close (close_old). `<workspace>/<chat>` of each chat closed."""
    out: list[str] = []
    root = config.WORKSPACES_DIR
    for folder in sorted(root.iterdir()) if root.is_dir() else []:
        if not folder.is_dir() or folder.name.startswith("."):
            continue
        c = folder.name
        try:
            config.corpus_dir(c)
        except ValueError:
            continue
        for fn in (stop_old_background, close_old):
            try:
                got = await asyncio.to_thread(fn, c)
            except Exception:  # noqa: BLE001 — never fails the start
                log.exception("%s: %s failed", c, fn.__name__)
                continue
            if fn is close_old:
                out += [f"{c}/{x}" for x in got]
    return out


async def _recover_logged() -> None:
    try:
        closed = await recover_old()
    except Exception:  # noqa: BLE001
        log.exception("closing what an earlier version left running failed")
        return
    if closed:
        log.info("chats an earlier version left running, closed: %s", ", ".join(closed))
