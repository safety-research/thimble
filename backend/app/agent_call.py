"""A model call as a subagent of the analyst's Claude Code session (main): how thimble asks a model for structured data
now that its server and its MCP shim start no `claude` of their own (NOCLAUDE.md).

A call is a job its caller describes (Spec): instructions, the answer's JSON schema (a call_result.ToolSpec), the model
and effort of its role's row in Settings, and one or more parts, each a text with pictures. The answer to each part is a
JSON object that fits the schema. structured() is a call of one part, in place of model.structured; run() is a call of
many parts, such as a prompt label's batches of records, and hands each answer to the caller as it comes (on_answer).

How it runs. run() writes the call's folder, trusted/calls/<id>/ in the workspace (call.json, each part's text and
pictures, an answer file per part), then starts an agent of the `call` role through thimble's plugin module
(subagents.start_job, a follow-on start), which spawns it with `$.agent.spawn` in main's session as main's subagent, so it
runs under main's permission mode: in Manual mode its permission asks show in main's terminal, as Claude Code shows any
subagent's. The agent's first message (prompts/call-task.md) holds the instructions, the schema and, for a call of one
part, the part's text. It takes parts with read_call, which gives a part's text and its pictures, and answers each with
send_answer, whose answer is checked against the schema here; an answer that does not fit gets the errors back, and the
agent sends it again. Both tools come from the agent's own shim (`thimble-mcp --private call`, subagents.private_server)
and are the only tools its registration gives it (definition). Its hand-back reaches no one: the terminal UI drops it as
it enters main (plugin/hooks/term/register.tsx), with the call's `done` line as the reason Claude Code prints in the row
of the drop, and the module appends no note of its start to main (module_bridge._note).

Files, not memory, carry a call, since on local transport the caller (main's MCP shim, where a card check runs), the
agent's own shim (which serves read_call and send_answer) and the hooks' backend process (local_hooks, which hears the
agent's end) are three processes; after the press all three are the server. call.json is written whole under an flock
on call.lock (_locked), and the caller reads it every POLL_S. The trusted folder is read-only to kernels, so card code
cannot write an answer.

Agents. A call runs at most `agents` agents at once (Spec.agents, 1 by default, MAX_AGENTS at most), each answering one
part at a time until it has read about Spec.budget_chars of part text; read_call then tells it to end, and the caller
starts a fresh agent for the parts left, so no agent's context grows past what one model call would hold. A lazy part
source is read only AHEAD parts ahead of the answers. A start refused at Claude Code's subagent limit waits LIMIT_WAIT_S
and tries again. Any other refusal ends the call: `no_session` when no Claude Code session runs thimble in the folder
(no module answers, such as a browser opened with no session), with NO_SESSION's fix; `error` with the refusal's own
words (main's plan mode, a hook). An agent whose run ends with a part it took and did not answer gives the part back; a
part given back MAX_TRIES times fails with the agent's last words (no_tool_call), or its API error (refused, rate_limited,
error). A run the model's safeguards refused runs again, once, on the refusal row's model (Spec.refusal), as
model.structured did; the result's refused_by names the model that refused.

Stops. A caller cancelled (a card that changed, a check past its time) stops the call: every agent of it is stopped
(subagents.stop, TaskStop through the module) and the call is marked `stopped`, so a late send_answer is refused. A call
with no change for IDLE_S fails its parts left, and its agents are stopped.

How a caller uses it (NOCLAUDE.md has more):

    res = await agent_call.structured(c, prompt, tool=spec, model=role["model"], effort=role["effort"],
                                      system=instructions, images=[(png, "image/png")], refusal=role["refusal"],
                                      what="card check", title="card check: How many …", done="thimble checked …")
    if res.status == "ok": use(res.output)

    outcomes = await agent_call.run(c, Spec(...), parts, on_answer=heard)   # many parts: a list or an async iterator
"""
from __future__ import annotations

import asyncio
import base64
import contextlib
import fcntl
import inspect
import json
import logging
import os
import re
import secrets
import shutil
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, AsyncIterable, Awaitable, Callable, Iterable, Iterator, Sequence

from . import config, tools
from .call_result import CallResult, ToolSpec

log = logging.getLogger("thimble.agent_call")

ROLE = "call"  # the agent type `thimble:call` (subagents.TYPES)
KIND = tools.CALL_SESSION  # an agent's key, `call:<id>`: the session its tool calls run as
OWN_TOOLS = ("read_call", "send_answer")  # its thimble tools, from its own shim (subagents.private_server)
PROMPT = "call"  # prompts/call.md: the role's description and system prompt
TASK_PROMPT = "call-task"  # prompts/call-task.md: the agent's first message
DIR = "calls"  # in the workspace's trusted folder
CALL_FILE = "call.json"
LOCK_FILE = "call.lock"
POLL_S = 0.2  # how often the caller reads call.json
PART_WAIT_S = 20.0  # how long read_call waits for a part a lazy source has not given yet
BUDGET_CHARS = 200_000  # the part text one agent reads before a fresh agent takes the rest (Spec.budget_chars)
MAX_AGENTS = 4  # a call's agents at once, at most
AHEAD = 2  # parts of a lazy source written ahead of the answers, per agent
MAX_TRIES = 2  # an agent that ends without the answer gives its part back; past this many tries the part fails
LIMIT_WAIT_S = 5.0  # a start refused at Claude Code's subagent limit is tried again after this
END_GRACE_S = 3.0  # how long after the registry heard an agent's end its call takes the end from there (_Call._running)
IDLE_S = float(os.environ.get("THIMBLE_CALL_IDLE_S", "900"))  # a call with no change this long fails its parts left
KEEP_S = 24 * 3600.0  # a call's folder is removed this long after it ended (_prune)
PICTURE_TYPES = {"image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp"}
TITLE_CHARS = 72  # of the agent's description, which Claude Code's task list shows
OPEN = ("queued", "given")  # the states of a part without an outcome
# the reason a dropped hand-back's row gives when the caller named none (Spec.done)
DONE_DEFAULT = "thimble finished a task"
# why a call could not start when no Claude Code session runs thimble in the folder (no module): the feature's notice
NO_SESSION = ("no Claude Code session runs thimble in this folder. Run `thimble` in the corpus folder, or open Claude "
              "Code there and type /thimble")


@dataclass(frozen=True)
class Part:
    """One part of a call: its text and its pictures, (bytes, media type) pairs of PICTURE_TYPES."""

    text: str
    images: Sequence[tuple[bytes, str]] = ()


@dataclass
class Spec:
    """A call: what it is for (`what`, for logs), the instructions every part shares, the answer's schema (`tool`), the
    model and effort it runs on, the agent's description in Claude Code's task list (`title`) and the reason the row of
    its dropped hand-back gives (`done`), the refusal row's {model, effort} (None when that row is off), how many agents
    at once and how much part text one agent reads."""

    what: str
    instructions: str
    tool: ToolSpec
    model: str
    effort: str
    title: str = ""
    done: str = ""
    refusal: dict[str, str] | None = None
    agents: int = 1
    budget_chars: int = BUDGET_CHARS


@dataclass
class Outcome:
    """A part's outcome: `ok` with its answer (`output`), else a call_result Status with why (`detail`)."""

    part: int
    status: str
    output: dict[str, Any] | None = None
    detail: str = ""
    agent: str = ""
    model: str = ""
    refused_by: str = ""
    text: str = ""


class Refused(Exception):
    """A tool call that may not run: its message is the tool's error result."""


# --------------------------------------------------------------------------- the files


def calls_dir(c: str) -> Path:
    from . import subagent_files as sf  # noqa: PLC0415

    return sf.trusted_dir(config.workspace_dir(c)) / DIR


def call_dir(c: str, cid: str) -> Path:
    if not re.fullmatch(r"[a-z0-9]{6,32}", cid or ""):
        raise ValueError(f"no call {cid!r}")
    return calls_dir(c) / cid


def _read_file(path: Path) -> dict[str, Any]:
    try:
        d = json.loads(path.read_text("utf-8") or "{}")
    except (OSError, ValueError):
        return {}
    return d if isinstance(d, dict) else {}


def read(c: str, cid: str) -> dict[str, Any]:
    """call.json of call `cid`, {} when there is none."""
    return _read_file(call_dir(c, cid) / CALL_FILE)


@contextlib.contextmanager
def _locked(c: str, cid: str) -> Iterator[dict[str, Any]]:
    """call.json of call `cid` to change in place under the call's flock, written back whole (an atomic replace) when the
    block changed it and ended without an exception."""
    from . import subagent_files as sf  # noqa: PLC0415

    d = call_dir(c, cid)
    d.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd = os.open(d / LOCK_FILE, os.O_RDONLY | os.O_CREAT, 0o600)
    try:
        sf._flock(fd, sf.LOCK_WAIT_S * 5)
        rec = _read_file(d / CALL_FILE)
        before = json.dumps(rec, sort_keys=True)
        yield rec
        if json.dumps(rec, sort_keys=True) != before:
            rec["touched"] = time.time()
            sf._replace(d / CALL_FILE, rec)
    finally:
        os.close(fd)


def _text_path(c: str, cid: str, n: int) -> Path:
    return call_dir(c, cid) / f"p{n}.txt"


def _answer_path(c: str, cid: str, n: int) -> Path:
    return call_dir(c, cid) / f"a{n}.json"


def _write_part(c: str, cid: str, n: int, part: Part) -> dict[str, Any]:
    """The part's text and pictures written into the call's folder; its entry for call.json."""
    d = call_dir(c, cid)
    _text_path(c, cid, n).write_text(part.text, "utf-8")
    pictures = []
    for k, (data, mime) in enumerate(part.images, 1):
        ext = PICTURE_TYPES.get(str(mime).lower())
        if ext is None:
            raise ValueError(f"a picture of type {mime!r}: a call takes {', '.join(PICTURE_TYPES)}")
        name = f"p{n}-{k}.{ext}"
        (d / name).write_bytes(bytes(data))
        pictures.append({"file": name, "type": str(mime).lower()})
    return {"state": "queued", "agent": "", "tries": 0, "chars": len(part.text), "pictures": pictures}


def _new_id() -> str:
    return secrets.token_hex(6)


def _prune(c: str) -> None:
    """The folders of calls that ended more than KEEP_S ago go (their answers reached their callers long since)."""
    root = calls_dir(c)
    if not root.is_dir():
        return
    cut = time.time() - KEEP_S
    for d in root.iterdir():
        rec = _read_file(d / CALL_FILE)
        if rec.get("status") not in (None, "running") and float(rec.get("touched") or 0) < cut:
            shutil.rmtree(d, ignore_errors=True)


# --------------------------------------------------------------------------- the role


def definition(c: str) -> dict[str, Any]:
    """The registration of `thimble:call` for workspace `c` (subagents.roles adds its model, effort, `background` and its
    own shim): prompts/call.md's description and body, read_call and send_answer from its own shim as its only tools,
    and no CLAUDE.md, since its task holds all it needs."""
    from . import prompts  # noqa: PLC0415

    front, body = prompts.frontmatter(PROMPT)
    return {"description": " ".join(str(front.get("description") or "").split()), "prompt": body,
            "tools": [f"mcp__thimble-{ROLE}__{n}" for n in OWN_TOOLS], "omitClaudeMd": True}


def _key(cid: str) -> str:
    return f"{KIND}:{cid}"


def _cid_of(key: str | None) -> str | None:
    parts = str(key or "").split(":")
    return parts[1] if len(parts) == 2 and parts[0] == KIND and parts[1] else None


def subagent_ended(c: str, run: Any, status: str, report: str) -> None:
    """A call's agent's run ended (subagents.Type.ended): its record says so, and a part it took without an answer goes
    back to the queue, or fails once it was tried MAX_TRIES times (_agent_ended)."""
    cid = _cid_of(run.key)
    if cid:
        with contextlib.suppress(ValueError):
            _agent_ended(c, cid, run.agent_id, status, report)


def subagent_refused(c: str, req: dict[str, Any]) -> None:
    """A start of a call's agent that did not happen after its request was made (subagents.Type.refused): the caller
    reads the module's answer itself (_start), so only a late refusal, such as an expired request, is noted."""
    cid = _cid_of(str(req.get("key") or ""))
    if cid:
        log.info("%s: the start of an agent of call %s was refused (%s): %s", c, cid, req.get("refused_kind"),
                 str(req.get("reason") or "")[:200])


def _failure(report: str) -> tuple[str, str]:
    """(status, detail) of a part whose agent ended without its answer, from the agent's last words: refused,
    rate_limited or error for an API error, else no_tool_call."""
    from . import notices  # noqa: PLC0415

    cls = notices.failure_class(report) if report else None
    if cls == "refused":
        return "refused", report
    if cls in ("rate_limited", "overloaded"):
        return "rate_limited" if cls == "rate_limited" else "error", report
    if cls is not None:
        return "error", report
    words = " ".join(str(report or "").split())[:300]
    return "no_tool_call", (f"the agent ended without an answer: {words}" if words else
                            "the agent ended without an answer")


def _agent_ended(c: str, cid: str, agent_id: str, status: str, report: str) -> None:
    from . import notices  # noqa: PLC0415

    with _locked(c, cid) as rec:
        if not rec:
            return
        a = (rec.setdefault("agents", {})).setdefault(agent_id, {"state": "running", "chars": 0})
        if a.get("state") == "ended":
            return
        a.update(state="ended", status=status, report=str(report or "")[:2000], ended=time.time())
        refused = notices.failure_class(report) == "refused" if report else False
        fallback = (rec.get("refusal") or {}).get("model") if refused else None
        if fallback and not rec.get("refused_by") and not str(rec.get("model") or "").startswith(str(fallback)):
            rec["refused_by"] = str(rec.get("model") or "")
            rec["model"], rec["effort"] = str(fallback), str((rec.get("refusal") or {}).get("effort") or "")
            log.warning("%s: call %s (%s): %s refused it; it runs again on %s", c, cid, rec.get("what"),
                        rec["refused_by"], fallback)
        else:
            fallback = None
        for n, p in (rec.get("parts") or {}).items():
            if p.get("state") != "given" or p.get("agent") != agent_id:
                continue
            if fallback or int(p.get("tries") or 0) < MAX_TRIES:
                p.update(state="queued", agent="")
                if fallback:
                    p["tries"] = 0
            else:
                st, detail = _failure(report)
                p.update(state="failed", status=st, detail=detail)
            log.info("%s: call %s part %s %s after agent %s ended %s", c, cid, n, p["state"], agent_id, status)


# --------------------------------------------------------------------------- the tools


async def _who(ctx: Any, tool: str) -> tuple[str, str]:
    """(call id, agent id) of a call of `tool`: an agent of the call role whose key names its call. Refused otherwise."""
    from . import subagents  # noqa: PLC0415

    cid = _cid_of(ctx.session)
    who = await subagents.caller(ctx.c, ctx.tool_use_id) if ctx.tool_use_id else None
    if not cid or who is None or who.role != ROLE or _cid_of(who.key) != cid:
        raise Refused(tools.hint("call-not-yours", tool=tool) or f"{tool} is only for a thimble task's agent")
    return cid, who.agent_id


def _held(rec: dict[str, Any], agent_id: str) -> list[int]:
    """The parts `agent_id` holds without an answer, in order. A part given in an agent's first message before the
    module named the agent (an unowned `given` part, _Call._start) is this agent's: a call puts a part in the first
    message of one agent at a time."""
    parts = rec.get("parts") or {}
    for p in parts.values():
        if p.get("state") == "given" and not p.get("agent"):
            p["agent"] = agent_id
    return sorted(int(n) for n, p in parts.items() if p.get("state") == "given" and p.get("agent") == agent_id)


def _pictures_word(n: int) -> str:
    return f"{n} picture" if n == 1 else f"{n} pictures"


def _take(c: str, cid: str, agent_id: str) -> tuple[str, int | None]:
    """read_call's choice for `agent_id`, under the call's lock: ("part", n) for the part it holds without an answer, else
    the next part in the queue, now given to it; ("share", None) once it read its share; ("none", None) when no part is
    left; ("wait", None) while a lazy source has not given the next; ("stopped", None) for a call that ended."""
    with _locked(c, cid) as rec:
        if rec.get("status") != "running":
            return "stopped", None
        parts = rec.get("parts") or {}
        a = rec.setdefault("agents", {}).setdefault(agent_id, {"state": "running", "chars": 0, "started": time.time()})
        held = _held(rec, agent_id)
        if held:
            return "part", held[0]
        if int(a.get("chars") or 0) >= int(rec.get("budget") or BUDGET_CHARS):
            return "share", None
        queued = sorted(int(n) for n, p in parts.items() if p.get("state") == "queued")
        if queued:
            n = queued[0]
            p = parts[str(n)]
            p.update(state="given", agent=agent_id, tries=int(p.get("tries") or 0) + 1, given=time.time())
            a["chars"] = int(a.get("chars") or 0) + int(p.get("chars") or 0)
            return "part", n
        return ("none", None) if rec.get("closed") else ("wait", None)


def _part_result(c: str, cid: str, n: int) -> Any:
    rec = read(c, cid)
    p = (rec.get("parts") or {}).get(str(n)) or {}
    try:
        text = _text_path(c, cid, n).read_text("utf-8")
    except OSError:
        text = ""
    pics = [x for x in p.get("pictures") or [] if isinstance(x, dict)]
    body = tools.hint("read_call-part", part=n, text=text) or f"# Part {n}\n\n{text}"
    if pics:
        body += "\n\n" + (tools.hint("read_call-pictures", count=_pictures_word(len(pics)), part=n) or "")
    content: list[dict[str, Any]] = [{"type": "text", "text": body.strip()}]
    for pic in pics:
        try:
            data = (call_dir(c, cid) / str(pic["file"])).read_bytes()
        except OSError:
            continue
        content.append({"type": "image", "data": base64.b64encode(data).decode("ascii"), "mimeType": pic["type"]})
    return tools.ToolResult(content)


async def tool_read_call(ctx: Any, args: dict[str, Any]) -> Any:
    """`read_call`: the part the caller holds without an answer, else the next part of its call (_take), with its
    pictures; or what to do when there is none."""
    try:
        cid, agent_id = await _who(ctx, "read_call")
    except Refused as e:
        return tools.err(str(e))
    end = time.monotonic() + PART_WAIT_S
    while True:
        what, n = await asyncio.to_thread(_take, ctx.c, cid, agent_id)
        if what != "wait" or time.monotonic() >= end:
            break
        await asyncio.sleep(POLL_S)
    if what == "part" and n is not None:
        return await asyncio.to_thread(_part_result, ctx.c, cid, n)
    hint = {"stopped": "call-stopped", "share": "read_call-share", "none": "read_call-none", "wait": "read_call-wait"}
    return tools.ok(tools.hint(hint[what]) or what)


def _invalid(schema: dict[str, Any], answer: Any) -> str:
    """What about `answer` does not fit `schema`, '' when it fits."""
    import jsonschema  # noqa: PLC0415

    if not isinstance(answer, dict):
        return f"$: the answer must be a JSON object, not {type(answer).__name__}"
    found = sorted(jsonschema.Draft202012Validator(schema).iter_errors(answer), key=str)
    return "; ".join(f"{e.json_path}: {e.message}" for e in found[:5])


def _record(c: str, cid: str, agent_id: str, part: int | None, answer: dict[str, Any]) -> tuple[str, Any]:
    """send_answer's record of a fitting answer under the call's lock: ("more" | "last", n) once recorded, ("which",
    held) when the agent holds several parts and named none, ("not-held", n) for a part it does not hold, ("stopped",
    None) for a call that ended."""
    with _locked(c, cid) as rec:
        if rec.get("status") != "running":
            return "stopped", None
        parts = rec.get("parts") or {}
        held = _held(rec, agent_id)
        if part is None:
            if len(held) > 1:
                return "which", held
            part = held[0] if held else None
        if part is None or part not in held:
            return "not-held", part
        _answer_path(c, cid, part).write_text(json.dumps(answer, ensure_ascii=False), "utf-8")
        parts[str(part)].update(state="answered", answered=time.time(), model=str(rec.get("model") or ""))
        a = rec.setdefault("agents", {}).setdefault(agent_id, {"state": "running", "chars": 0})
        a["answered"] = int(a.get("answered") or 0) + 1
        more = (not rec.get("closed") or any(p.get("state") == "queued" for p in parts.values()))
        spent = int(a.get("chars") or 0) >= int(rec.get("budget") or BUDGET_CHARS)
        return ("more" if more and not spent else "last"), part


async def tool_send_answer(ctx: Any, args: dict[str, Any]) -> Any:
    """`send_answer`: the answer to a part the caller holds, checked against its call's schema; the errors when it does
    not fit, so the agent sends it again."""
    try:
        cid, agent_id = await _who(ctx, "send_answer")
    except Refused as e:
        return tools.err(str(e))
    rec = await asyncio.to_thread(read, ctx.c, cid)
    if rec.get("status") != "running":
        return tools.ok(tools.hint("call-stopped") or "stopped")
    answer = args.get("answer")
    if isinstance(answer, str):  # an answer sent as JSON text
        with contextlib.suppress(ValueError):
            answer = json.loads(answer)
    why = await asyncio.to_thread(_invalid, (rec.get("tool") or {}).get("schema") or {"type": "object"}, answer)
    if why:
        return tools.err(tools.hint("send_answer-invalid", errors=why) or why)
    raw = args.get("part")
    try:
        part = int(raw) if raw not in (None, "") else None
    except (TypeError, ValueError):
        part = -1
    what, n = await asyncio.to_thread(_record, ctx.c, cid, agent_id, part, answer)
    if what == "stopped":
        return tools.ok(tools.hint("call-stopped") or "stopped")
    if what == "which":
        return tools.err(tools.hint("send_answer-which", parts=", ".join(map(str, n))) or "which part?")
    if what == "not-held":
        return tools.err(tools.hint("send_answer-not-held", part="" if n is None else n) or "not your part")
    return tools.ok(tools.hint(f"send_answer-{what}", part=n) or "recorded")


# --------------------------------------------------------------------------- the caller's side


def _schema_text(schema: dict[str, Any]) -> str:
    return json.dumps(schema, indent=2, ensure_ascii=False)


def task_text(cid: str, spec: Spec, first: Part | None) -> str:
    """The agent's first message (prompts/call-task.md): the call's id, the instructions, the answer's schema, then the
    part itself for a call of one part (`first`), with a line to read its pictures when it has some, else how to take
    the parts."""
    from . import prompts  # noqa: PLC0415

    if first is not None:
        parts = prompts.render_section(TASK_PROMPT, "one-part", {"text": first.text.strip()})
        if first.images:
            parts += "\n\n" + prompts.render_section(TASK_PROMPT, "pictures",
                                                     {"count": _pictures_word(len(first.images))})
    else:
        parts = prompts.render_section(TASK_PROMPT, "many-parts", {})
    return prompts.render_section(TASK_PROMPT, "task", {
        "call": cid, "instructions": spec.instructions.strip(), "tool": spec.tool.description.strip(),
        "schema": _schema_text(spec.tool.input_schema), "parts": parts.strip()}).strip()


def _short(text: str, limit: int) -> str:
    t = " ".join(str(text or "").split())
    return t if len(t) <= limit else t[: limit - 1].rsplit(" ", 1)[0] + "…"


class _Call:
    """One run of a call in its caller's process (run): its folder, its part source, its agents, the outcomes heard."""

    def __init__(self, c: str, spec: Spec, parts: Iterable[Part] | AsyncIterable[Part],
                 on_answer: Callable[[Outcome], Any] | None) -> None:
        self.c, self.spec, self.on_answer = c, spec, on_answer
        self.cid = _new_id()
        self.source = parts
        self.iter: Any = None
        self.exhausted = False
        self.n = 0  # parts written
        self.outcomes: dict[int, Outcome] = {}
        self.agents: set[str] = set()  # the agents started for it
        self.starts = 0
        self.retry_at = 0.0  # after a start refused at the subagent limit
        self.ended: Outcome | None = None  # set when a start's refusal ends the call
        self.t0 = time.monotonic()

    # the parts

    async def _next(self) -> Part | None:
        if self.exhausted:
            return None
        if self.iter is None:
            self.iter = self.source.__aiter__() if hasattr(self.source, "__aiter__") else iter(self.source)
        try:
            part = await self.iter.__anext__() if hasattr(self.iter, "__anext__") else next(self.iter)
        except (StopIteration, StopAsyncIteration):
            self.exhausted = True
            return None
        return part

    async def _top_up(self, rec: dict[str, Any]) -> None:
        """Parts written until AHEAD per agent wait without an answer, or the source is spent; then the call is
        closed."""
        open_ = sum(1 for p in (rec.get("parts") or {}).values() if p.get("state") in OPEN)
        want = max(1, AHEAD * max(1, self.spec.agents))
        added: dict[int, dict[str, Any]] = {}
        while not self.exhausted and open_ + len(added) < want:
            part = await self._next()
            if part is None:
                break
            self.n += 1
            added[self.n] = await asyncio.to_thread(_write_part, self.c, self.cid, self.n, part)
        if added or self.exhausted:
            with _locked(self.c, self.cid) as now:
                now.setdefault("parts", {}).update({str(k): v for k, v in added.items()})
                if self.exhausted:
                    now["closed"] = True

    # the start

    async def open(self) -> Part | None:
        """The call's folder and call.json; the first part, which a call of one part puts in its agent's first message
        (task_text), when the source is a list or tuple of one part."""
        await asyncio.to_thread(_prune, self.c)
        spec = self.spec
        with _locked(self.c, self.cid) as rec:
            rec.update(id=self.cid, what=spec.what, title=spec.title, done=spec.done, status="running", closed=False,
                       created=time.time(), model=spec.model, effort=spec.effort, refusal=spec.refusal,
                       budget=spec.budget_chars, refused_by="",
                       tool={"name": spec.tool.name, "description": spec.tool.description,
                             "schema": spec.tool.input_schema},
                       parts={}, agents={})
        single = list(self.source) if isinstance(self.source, (list, tuple)) and len(self.source) == 1 else None
        await self._top_up(read(self.c, self.cid))
        return single[0] if single else None

    async def _start(self, first: Part | None) -> None:
        """One agent started through the module (subagents.start_job, a follow-on start), on the call's model now (the
        refusal row's once a run was refused). A refusal at the subagent limit waits; any other ends the call
        (self.ended)."""
        from . import subagents  # noqa: PLC0415

        rec = read(self.c, self.cid)
        inline = first  # a call of one part gives it in the first message of each agent it starts
        prompt = task_text(self.cid, self.spec, inline)
        values = subagents.values_for(self.c, ROLE, {"model": rec.get("model") or self.spec.model,
                                                     "effort": rec.get("effort") or self.spec.effort})
        if inline is not None:  # the part in its first message is given to the agent it starts
            with _locked(self.c, self.cid) as now:
                p = (now.get("parts") or {}).get("1")
                if p and p.get("state") == "queued":
                    p.update(state="given", agent="", tries=int(p.get("tries") or 0) + 1, given=time.time())
        self.starts += 1
        title = _short(self.spec.title or f"thimble: {self.spec.what}", TITLE_CHARS)
        ans = await subagents.start_job(self.c, ROLE, _key(self.cid), prompt, values, subagents.FOLLOW_ON,
                                        description=title, fields={"drop": self.spec.done or DONE_DEFAULT})
        if ans.started:
            aid = str(ans.agent_id)
            self.agents.add(aid)
            with _locked(self.c, self.cid) as now:
                now.setdefault("agents", {}).setdefault(aid, {"state": "running", "chars": 0, "started": time.time()})
                p = (now.get("parts") or {}).get("1")
                if inline is not None and p and p.get("state") == "given" and not p.get("agent"):
                    p["agent"] = aid
                    now["agents"][aid]["chars"] = int(p.get("chars") or 0)
            log.info("%s: call %s (%s) started agent %s on %s", self.c, self.cid, self.spec.what, aid, values.get("model"))
            return
        with _locked(self.c, self.cid) as now:  # the part given to no agent goes back
            for p in (now.get("parts") or {}).values():
                if p.get("state") == "given" and not p.get("agent"):
                    p.update(state="queued", tries=max(0, int(p.get("tries") or 1) - 1))
        if ans.kind == subagents.LIMIT:
            self.retry_at = time.monotonic() + LIMIT_WAIT_S
            log.info("%s: call %s waits for a place under Claude Code's subagent limit", self.c, self.cid)
            return
        if ans.kind == subagents.NO_MODULE:
            self.ended = Outcome(0, "no_session", detail=NO_SESSION)
        else:
            self.ended = Outcome(0, "error", detail=ans.reason or f"its agent did not start ({ans.kind})")
        log.warning("%s: call %s (%s) could not start its agent: %s", self.c, self.cid, self.spec.what,
                    self.ended.detail)

    # the loop

    def _hear(self, rec: dict[str, Any]) -> list[Outcome]:
        """The outcomes call.json holds that were not heard yet."""
        out = []
        for key, p in (rec.get("parts") or {}).items():
            n = int(key)
            if n in self.outcomes or p.get("state") in OPEN:
                continue
            if p.get("state") == "answered":
                raw = _read_file(_answer_path(self.c, self.cid, n))
                o = Outcome(n, "ok", raw, agent=str(p.get("agent") or ""), model=str(p.get("model") or ""),
                            refused_by=str(rec.get("refused_by") or ""))
            else:
                o = Outcome(n, str(p.get("status") or "error"), detail=str(p.get("detail") or ""),
                            agent=str(p.get("agent") or ""), refused_by=str(rec.get("refused_by") or ""))
            self.outcomes[n] = o
            out.append(o)
        return out

    def _running(self, rec: dict[str, Any]) -> list[str]:
        """The call's agents that run now: started and not ended, by call.json and by the agents' registry (a run's
        end that call.json missed is taken from there)."""
        from . import subagents  # noqa: PLC0415

        out = []
        for aid, a in (rec.get("agents") or {}).items():
            if a.get("state") == "ended":
                continue
            reg = subagents.agent(self.c, aid) or {}
            # an end the registry holds and call.json missed: its end handler writes call.json just after the registry,
            # in another process on local transport, so the end is taken from here only after END_GRACE_S
            if (reg.get("status") in ("done", "failed", "stopped") and reg.get("ended_run") is not None
                    and time.time() - float(reg.get("ended") or 0) > END_GRACE_S):
                _agent_ended(self.c, self.cid, aid, str(reg["status"]), "")
                continue
            out.append(aid)
        return out

    async def go(self, first: Part | None, timeout_s: float | None) -> list[Outcome]:
        last = time.monotonic()
        seen_touch = None
        while True:
            rec = read(self.c, self.cid)
            for o in self._hear(rec):
                await self._tell(o)
            if rec.get("touched") != seen_touch:
                seen_touch, last = rec.get("touched"), time.monotonic()
            if self.ended is not None:
                self._end_open("failed", self.ended.status, self.ended.detail)
                break
            parts = rec.get("parts") or {}
            if rec.get("closed") and parts and all(p.get("state") not in OPEN for p in parts.values()):
                break
            if rec.get("closed") and not parts:
                break
            await self._top_up(rec)
            rec = read(self.c, self.cid)
            running = self._running(rec)
            queued = any(p.get("state") == "queued" for p in (rec.get("parts") or {}).values())
            want = max(1, min(MAX_AGENTS, self.spec.agents))
            if queued and len(running) < want and time.monotonic() >= self.retry_at:
                await self._start(first)
                continue
            if timeout_s is not None and time.monotonic() - self.t0 > timeout_s:
                self._end_open("failed", "timeout", f"the call ran past {timeout_s:.0f} s")
                await self._stop_agents()
                break
            if time.monotonic() - last > IDLE_S:
                self._end_open("failed", "timeout", f"nothing happened in the call for {IDLE_S:.0f} s")
                await self._stop_agents()
                break
            await asyncio.sleep(POLL_S)
        for o in self._hear(read(self.c, self.cid)):
            await self._tell(o)
        return [self.outcomes[n] for n in sorted(self.outcomes)]

    async def _tell(self, o: Outcome) -> None:
        if self.on_answer is None:
            return
        try:
            got = self.on_answer(o)
            if inspect.isawaitable(got):
                await got
        except Exception:  # noqa: BLE001 — a caller's listener never stops the call
            log.exception("%s: call %s: on_answer failed for part %s", self.c, self.cid, o.part)

    def _end_open(self, status: str, part_status: str, detail: str) -> None:
        """The call ends `status`: each part without an outcome takes `part_status` and `detail`."""
        with _locked(self.c, self.cid) as rec:
            if rec.get("status") == "running":
                rec["status"] = status
            for p in (rec.get("parts") or {}).values():
                if p.get("state") in OPEN:
                    p.update(state="failed", status=part_status, detail=detail)
            if not self.exhausted:
                rec["closed"] = True

    def finish(self) -> None:
        with _locked(self.c, self.cid) as rec:
            if rec.get("status") == "running":
                rec["status"] = "done"

    async def _stop_agents(self) -> None:
        """Every agent of the call that runs is stopped through the module (TaskStop)."""
        from . import subagents  # noqa: PLC0415

        for aid in self._running(read(self.c, self.cid)):
            try:
                await subagents.stop(self.c, aid)
            except Exception:  # noqa: BLE001 — a stop that fails leaves an agent whose answers are refused
                log.exception("%s: call %s: agent %s was not stopped", self.c, self.cid, aid)

    def stopped(self) -> None:
        """The caller cancelled: the call is marked stopped (a late send_answer is refused) and its agents are stopped in
        the background."""
        with contextlib.suppress(Exception):
            self._end_open("stopped", "stopped", "the caller stopped the call")
        task = asyncio.get_running_loop().create_task(self._stop_agents(), name=f"call-stop-{self.cid}")
        _cleanup.add(task)
        task.add_done_callback(_cleanup.discard)


_cleanup: set[asyncio.Task] = set()  # the stops of cancelled calls, which outlive them


async def run(c: str, spec: Spec, parts: Iterable[Part] | AsyncIterable[Part], *,
              on_answer: Callable[[Outcome], Any] | None = None, timeout_s: float | None = None) -> list[Outcome]:
    """Run call `spec` on `parts` in workspace `c` (module note): each part's Outcome in part order, each also handed to
    `on_answer` as it comes. Never raises for the call's sake; a cancel of the caller stops the call and is raised."""
    call = _Call(c, spec, parts, on_answer)
    try:
        first = await call.open()
        out = await call.go(first, timeout_s)
        call.finish()
        return out
    except asyncio.CancelledError:
        call.stopped()
        raise
    except Exception as e:  # noqa: BLE001 — every failure is an outcome
        log.exception("%s: call %s (%s) failed", c, call.cid, spec.what)
        call.stopped()
        return [Outcome(0, "error", detail=f"{type(e).__name__}: {e}")]


async def structured(c: str, prompt: str, *, tool: ToolSpec, model: str, effort: str, system: str = "",
                     images: Sequence[tuple[bytes, str]] = (), refusal: dict[str, str] | None = None,
                     what: str = "", title: str = "", done: str = "", timeout_s: float | None = None,
                     **_ignored: Any) -> CallResult:
    """One structured call of one part, as model.structured made it: `system` the instructions, `prompt` the part's
    text, `images` its pictures, the answer's schema `tool`, on `model` at `effort`, again on `refusal`'s model when
    the model refused. Never raises but for the caller's cancel; read the CallResult's status (call_result.Status:
    `no_session` when no Claude Code session runs thimble here, its detail the fix). Arguments only an Agent SDK
    session took (speed, cwd, idle_timeout_s, on_retry, on_fallback) are ignored: Claude Code retries the API itself
    and runs a subagent at main's speed."""
    if not str(model or "").strip() or not str(effort or "").strip():
        return CallResult(status="error", detail=f"the {tool.name} call names no model or no effort",
                          model_requested=model)
    t0 = time.monotonic()
    spec = Spec(what=what or tool.name, instructions=system, tool=tool, model=model, effort=effort, title=title,
                done=done, refusal=refusal)
    outs = await run(c, spec, [Part(prompt, tuple(images))], timeout_s=timeout_s)
    o = outs[0] if outs else Outcome(1, "error", detail="the call gave no outcome")
    used = o.model or (str((refusal or {}).get("model") or model) if o.refused_by else model)
    return CallResult(status=o.status if o.status != "ok" or o.output is not None else "error",  # type: ignore[arg-type]
                      output=o.output if o.status == "ok" else None, model_requested=used,
                      model_used=used if o.status == "ok" else None, duration_s=round(time.monotonic() - t0, 2),
                      session_id=o.agent or None, attempts=1, detail=o.detail, refused_by=o.refused_by)


def tasks_running(c: str) -> list[str]:
    """The ids of the calls of workspace `c` that run now, for tests and `thimble state`."""
    root = calls_dir(c)
    return sorted(d.name for d in root.iterdir() if _read_file(d / CALL_FILE).get("status") == "running") \
        if root.is_dir() else []
