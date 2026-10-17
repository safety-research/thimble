"""thimble's model calls through the analyst's own Claude Code session: a completion ($.model.complete) or a fork of
main's conversation ($.model.fork), which thimble's plugin module makes in main's `claude` process with the session's
own API client and sign-in (module_bridge.model, plugin/hooks/thimble.ts). thimble starts no `claude` of its own.

Neither is a subagent: a call has no tools, leaves no row in main's terminal, and asks nothing, in Manual mode too. The
long-running work the analyst may want to look into (the orientation, its critic, the writers, view builds and reviews,
code tickets, the checks) stays as subagents of main, and so does the card check, which reads a card's picture
(agent_call.py); every other call is one of these:
- structured(): one completion whose answer is a JSON object that fits a schema. Its system prompt is
  prompts/complete.md `system`: the call's instructions, then the schema, marked for the prompt cache, so the calls of a
  prompt label's run read it from there; its one message is the part to answer. The module gives back the reply's text;
  this module reads the JSON object in it (call_result.json_object) and checks it against the schema, and an answer
  that does not fit is asked for once more with what is wrong (`again`), else the call ends `no_tool_call`. A reply with
  no text, as when Claude's safeguards stop one, is `refused`, and runs once more on the refusal row's model and effort
  (the result's refused_by names the model that refused). Callers: a prompt label's batches (concepts.labels_task), the
  label draft, the view fit, the viewer suggestion and a program's ask without pictures.
- fork(): one completion over main's own transcript, which the API serves from main's prompt cache, with
  prompts/complete.md `fork` as its message: the view proposer's (proposer.py). It runs on main's model and effort, and
  is checked against its schema as a completion is.

At most userconf.model_calls() calls run at once in a process (slot); a prompt label's run asks as many batches at once
(concepts). A caller's cancel aborts the call in the module (its AbortSignal); a fork runs to its end. With no Claude
Code session that runs thimble in the folder a call ends `no_session`, its detail the fix (call_result.NO_SESSION).
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import re
import time
import weakref
from collections import deque
from typing import Any, AsyncIterator

from . import config
from .call_result import NO_SESSION, CallResult, ToolSpec, json_object, schema_errors

log = logging.getLogger("thimble.model_call")

PROMPT = "complete"  # prompts/complete.md: the templates of the calls
MAX_TOKENS = 16_000  # a reply's cap, unless the caller names another ($.model.complete takes up to 64,000)
TIMEOUT_S = 600.0  # a call's time, unless the caller names another: a provider ends an unstreamed request at ten minutes
# why a call ended without an answer, for its notice
EMPTY = "{model} replied with no text, as when Claude's safeguards stop a reply"
CUT = "Claude Code cut the model call short"
NOTHING_TO_FORK = "main's session has no finished turn to fork yet"
NOT_ANSWERING = "Your Claude Code session's thimble module did not take the model call"


# --------------------------------------------------------------------------- the slots


class _Slots:
    """The model calls of one event loop that run now, and the calls that wait for a slot, first come first served."""

    def __init__(self) -> None:
        self.running = 0
        self.waiting: deque[asyncio.Future] = deque()


_slots: weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, _Slots] = weakref.WeakKeyDictionary()


def parallel() -> int:
    """How many calls run at once, at most: thimble's config `modelCalls` (userconf.model_calls)."""
    from . import userconf  # noqa: PLC0415

    return max(1, userconf.model_calls())


@contextlib.asynccontextmanager
async def slot() -> AsyncIterator[None]:
    """One of parallel() slots of this event loop (module note), held while the block runs."""
    loop = asyncio.get_running_loop()
    s = _slots.get(loop)
    if s is None:
        s = _slots[loop] = _Slots()
    while s.running >= parallel():
        fut = loop.create_future()
        s.waiting.append(fut)
        try:
            await fut
        finally:
            with contextlib.suppress(ValueError):
                s.waiting.remove(fut)
    s.running += 1
    try:
        yield
    finally:
        s.running -= 1
        while s.waiting:
            nxt = s.waiting.popleft()
            if not nxt.done():
                nxt.set_result(None)
                break


# --------------------------------------------------------------------------- the module's answer


def _sum(a: dict | None, b: dict | None) -> dict | None:
    if a is None or b is None:
        return a if b is None else b
    return {k: int(a.get(k) or 0) + int(b.get(k) or 0) for k in {*a, *b}}


def _read(ans: dict[str, Any], model: str, elapsed: float, timeout_s: float) -> tuple[str, str]:
    """(status, detail) of the module's answer (module_bridge.model): `ok` for a reply's text, else a call_result
    Status and why."""
    from . import module_bridge, notices  # noqa: PLC0415

    if module_bridge.NO_MODULE in ans:
        return ("error", NOT_ANSWERING) if ans.get("expired") else ("no_session", NO_SESSION)
    if isinstance(ans.get("text"), str):
        return "ok", ""
    if ans.get("error"):
        return "error", str(ans["error"])
    failed = str(ans.get("failed") or "")
    if failed == "api-error":
        st, kind = ans.get("status"), str(ans.get("kind") or "unknown")
        detail = f"API Error: {st} ({kind})" if st else f"API Error: no response ({kind})"
        cls = notices.failure_class(detail, status=st, error=kind)
        if cls in ("rate_limited", "overloaded"):
            return "rate_limited", detail
        return ("refused" if cls == "refused" else "error"), detail
    if failed == "empty-reply":
        return "refused", EMPTY.format(model=model or "The model")
    if failed == "aborted":
        if ans.get("timeout") or elapsed >= timeout_s - 1:
            return "timeout", f"the call ran past {timeout_s:.0f} s"
        return "error", CUT
    if failed == "nothing-to-fork":
        return "stopped", NOTHING_TO_FORK
    return "error", failed or "the module gave no answer"


def _fit(text: str, tool: ToolSpec) -> tuple[dict[str, Any] | None, str]:
    """The JSON object `text` holds when it fits the tool's schema, else (None, what is wrong)."""
    got, why = json_object(text)
    if got is None:
        return None, why
    why = schema_errors(tool.input_schema or {"type": "object"}, got)
    return (None, why) if why else (got, "")


def _schema_text(tool: ToolSpec) -> str:
    return json.dumps(tool.input_schema, indent=2, ensure_ascii=False)


# --------------------------------------------------------------------------- the calls


async def _ask(c: str, op: str, args: dict[str, Any], timeout_s: float) -> dict[str, Any]:
    from . import module_bridge, subagents  # noqa: PLC0415

    await subagents.module_settled(c)
    return await module_bridge.model(c, op, args, timeout_s=timeout_s)


async def _answered(c: str, op: str, first: dict[str, Any], again: Any, tool: ToolSpec, model: str,
                    timeout_s: float, what: str) -> CallResult:
    """One call `op` with the arguments `first`, and once more with `again(text, why)`'s when its answer does not fit
    the schema: the CallResult (status ok with the object, or why not)."""
    t0 = time.monotonic()
    usage: dict | None = None
    args, text = first, ""
    for attempt in (1, 2):
        ans = await _ask(c, op, args, timeout_s)
        usage = _sum(usage, ans.get("usage") if isinstance(ans.get("usage"), dict) else None)
        status, detail = _read(ans, model, time.monotonic() - t0, timeout_s)
        if status != "ok":
            return CallResult(status=status, model_requested=model, detail=detail, usage=usage,  # type: ignore[arg-type]
                              attempts=attempt, text=text)
        text = str(ans["text"])
        got, why = _fit(text, tool)
        if got is not None:
            return CallResult(status="ok", output=got, model_requested=model, model_used=model or None, usage=usage,
                              attempts=attempt)
        log.info("%s: a %s call's answer did not fit its schema (%s)%s", c, what or tool.name, why,
                 "; asked again" if attempt == 1 else "")
        args = again(text, why)
    return CallResult(status="no_tool_call", model_requested=model, usage=usage, attempts=2, text=text[:2000],
                      detail=f"the answer did not agree with the schema ({why})")


def _again_text(prompt: str, text: str, why: str) -> str:
    from . import prompts  # noqa: PLC0415

    return prompts.render_section(PROMPT, "again", {"text": prompt.strip(), "answer": text.strip(), "errors": why})


def system_text(instructions: str, tool: ToolSpec) -> str:
    """A completion's system prompt (prompts/complete.md `system`): the instructions, then the answer's schema."""
    from . import prompts  # noqa: PLC0415

    text = prompts.render_section(PROMPT, "system", {"instructions": instructions.strip(),
                                                     "tool": tool.description.strip(), "schema": _schema_text(tool)})
    return re.sub(r"\n{3,}", "\n\n", text).strip()  # a call with no instructions leaves no gap


async def _complete(c: str, prompt: str, *, tool: ToolSpec, model: str, effort: str, system: str, what: str,
                    timeout_s: float, max_tokens: int) -> CallResult:
    sys_text = system_text(system, tool)

    def args(text: str) -> dict[str, Any]:
        return {"model": model, "effort": effort, "system": [{"text": sys_text, "cache": True}],
                "prompt": [{"text": text}], "maxTokens": int(max_tokens), "timeoutMs": int(timeout_s * 1000)}

    async with slot():
        return await _answered(c, "complete", args(prompt), lambda text, why: args(_again_text(prompt, text, why)),
                               tool, model, timeout_s, what)


async def structured(c: str, prompt: str, *, tool: ToolSpec, model: str, effort: str, system: str = "",
                     refusal: dict[str, str] | None = None, what: str = "", timeout_s: float | None = None,
                     max_tokens: int = MAX_TOKENS) -> CallResult:
    """One completion (module note): `system` the instructions, `prompt` the part to answer, the answer's schema `tool`,
    on `model` at `effort`, once more on `refusal`'s model and effort when the model refused (`refusal` None: the
    refusal row is off). Never raises but for the caller's cancel; read the CallResult's status (`no_session`: no Claude
    Code session runs thimble here, its detail the fix)."""
    if not str(model or "").strip() or not str(effort or "").strip():
        return CallResult(status="error", detail=f"the {tool.name} call names no model or no effort",
                          model_requested=model)
    t0 = time.monotonic()
    timeout = TIMEOUT_S if timeout_s is None else float(timeout_s)
    res = await _complete(c, prompt, tool=tool, model=model, effort=effort, system=system, what=what,
                          timeout_s=timeout, max_tokens=max_tokens)
    again = str((refusal or {}).get("model") or "")
    if res.status == "refused" and again and config.base_model(again) != config.base_model(model):
        log.warning("%s: a %s call: %s refused it (%s); it runs again on %s", c, what or tool.name, model,
                    res.detail[:200], again)
        res = await _complete(c, prompt, tool=tool, model=again, effort=str((refusal or {}).get("effort") or effort),
                              system=system, what=what, timeout_s=timeout, max_tokens=max_tokens)
        res.refused_by = model
    res.duration_s = round(time.monotonic() - t0, 2)
    return res


async def fork(c: str, prompt: str, *, tool: ToolSpec, model: str = "", what: str = "",
               timeout_s: float | None = None) -> CallResult:
    """One completion over main's own transcript (module note): `prompt` with the answer's schema (prompts/complete.md
    `fork`), on main's model and effort, which `model` only names. Never raises but for the caller's cancel; read the
    CallResult's status (`stopped`: main has no finished turn to fork yet)."""
    from . import prompts  # noqa: PLC0415

    t0 = time.monotonic()
    timeout = TIMEOUT_S if timeout_s is None else float(timeout_s)
    text = prompts.render_section(PROMPT, "fork", {"text": prompt.strip(), "tool": tool.description.strip(),
                                                   "schema": _schema_text(tool)}).strip()
    async with slot():
        res = await _answered(c, "fork", {"prompt": text},
                              lambda reply, why: {"prompt": _again_text(text, reply, why)}, tool, model, timeout,
                              what or "fork")
    res.duration_s = round(time.monotonic() - t0, 2)
    return res
