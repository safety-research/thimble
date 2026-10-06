"""model.structured: one structured call on a model, whose answer is the input of one output tool. Its callers are the
labels classifier (concepts.classify_structured), the label draft, view fit, the card check, view review, the viewer
suggestion and a program's `ask` (harness.ask), each at its role's model, effort and speed (config.call_settings).

Each call is an Agent SDK session on the user's own `claude` (sdk.build) whose one in-process MCP tool's schema is the
output schema. It returns a CallResult status (ok, refused, rate_limited, truncated, no_tool_call, timeout, error) and
follows the retry rules in structured(). A refused call runs again once on config.FALLBACK_MODEL, with `refused_by`
naming the model that refused it.

No time limit bounds a call, since a long generation is normal; instead a call with no sign of life for the idle window
(DEFAULT_IDLE_TIMEOUT_S) is killed and retried once in a fresh session.
"""
from __future__ import annotations

import asyncio
import base64
import copy
import json
import logging
import os
import signal
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, AsyncIterator, Callable, Literal, Sequence, TYPE_CHECKING

import jsonschema

if TYPE_CHECKING:  # annotations only: the names are bound at first use (_bind_sdk, below)
    from claude_agent_sdk import (
        AssistantMessage,
        ClaudeAgentOptions,
        ClaudeSDKClient,
        ClaudeSDKError,
        CLIJSONDecodeError,
        CLINotFoundError,
        ProcessError,
        RateLimitEvent,
        ResultMessage,
        SystemMessage,
        TextBlock,
        ToolResultBlock,
        ToolUseBlock,
        UserMessage,
        create_sdk_mcp_server,
        tool as sdk_tool,
    )

from . import capture, config, retry, sdk
from .sdk import bind_sdk, sdk_attr


log = logging.getLogger("thimble.model")


_SDK_NAMES = {  # bound at first use (sdk.bind_sdk: the SDK's import is deferred to keep the server's start fast)
    "AssistantMessage": "AssistantMessage",
    "ClaudeAgentOptions": "ClaudeAgentOptions",
    "ClaudeSDKClient": "ClaudeSDKClient",
    "ClaudeSDKError": "ClaudeSDKError",
    "CLIJSONDecodeError": "CLIJSONDecodeError",
    "CLINotFoundError": "CLINotFoundError",
    "ProcessError": "ProcessError",
    "RateLimitEvent": "RateLimitEvent",
    "ResultMessage": "ResultMessage",
    "SystemMessage": "SystemMessage",
    "TextBlock": "TextBlock",
    "ToolResultBlock": "ToolResultBlock",
    "ToolUseBlock": "ToolUseBlock",
    "UserMessage": "UserMessage",
    "create_sdk_mcp_server": "create_sdk_mcp_server",
    "sdk_tool": "tool",
}


def _bind_sdk() -> None:
    bind_sdk(globals(), _SDK_NAMES)


def _sdk_bound() -> bool:
    return all(local in globals() for local in _SDK_NAMES)


async def _bind_sdk_off_loop() -> None:
    """_bind_sdk in a worker thread when the SDK is not bound yet, since its first import would stall every route on the
    loop. structured() awaits this first."""
    if not _sdk_bound():
        await asyncio.to_thread(_bind_sdk)


def __getattr__(name: str) -> Any:
    return sdk_attr(globals(), _SDK_NAMES, name)

# Each call is a CLI subprocess, and at most this many run at once. A prompt label runs up to concepts.CONCURRENCY (24)
# of them, which leaves room for card_check.READ_CONCURRENCY (4) card checks.
MODEL_CONCURRENCY = int(os.environ.get("THIMBLE_MODEL_CONCURRENCY", "32"))
# The idle window: a failure detector, not a time limit. The API buffers a tool call's JSON until it is complete, so a
# long silent generation is normal.
DEFAULT_IDLE_TIMEOUT_S = float(os.environ.get("THIMBLE_MODEL_IDLE_TIMEOUT_S", "900"))

Status = Literal["ok", "refused", "rate_limited", "truncated", "no_tool_call", "timeout", "error"]

# The MCP server name is always 'out', so the allowed tool is f"mcp__out__{name}".
_SERVER = "out"
_ERROR_KINDS = ("authentication_failed", "billing_error", "invalid_request", "server_error", "unknown")

# Lazily created on the running loop so tests (each with a fresh loop) and the app (one loop) both work.
_sem: asyncio.Semaphore | None = None
_sem_loop: asyncio.AbstractEventLoop | None = None


def _semaphore() -> asyncio.Semaphore:
    global _sem, _sem_loop
    loop = asyncio.get_running_loop()
    if _sem is None or _sem_loop is not loop:
        _sem = asyncio.Semaphore(MODEL_CONCURRENCY)
        _sem_loop = loop
    return _sem


@dataclass(frozen=True)
class ToolSpec:
    """The output schema, presented to the model as an in-process MCP tool."""

    name: str
    description: str
    input_schema: dict


@dataclass
class CallResult:
    """What one structured call returned and what actually happened. structured() NEVER raises; read `status`."""

    status: Status
    output: dict | None = None  # jsonschema-validated input of the model's LAST tool call; None unless status == "ok"
    model_requested: str = ""  # what the CLI was asked for
    model_used: str | None = None  # from ResultMessage.model_usage keys
    fallback_note: str = ""  # "" when the requested model really ran
    duration_s: float = 0.0  # wall, retries included
    cost_usd: float | None = None  # ResultMessage.total_cost_usd
    session_id: str | None = None
    attempts: int = 0  # turns sent
    detail: str = ""  # one plain sentence for run.json and logs; "" when ok
    text: str = ""  # assistant prose from the final attempt, for no_tool_call/refused diagnostics
    # status == "truncated" only: the output tool's last call as far as it got before the cut (a cut-off tool_use is
    # parsed leniently); None when no tool call had started
    partial: dict | None = None
    # {input_tokens, output_tokens, …} as the CLI reported them; None when it did not say
    usage: dict | None = None
    # the model that refused the call when this result is its rerun on config.FALLBACK_MODEL; "" otherwise
    refused_by: str = ""


class CallState:
    """Capture of the model's tool calls for one session: last valid call wins, violations are kept for retries."""

    def __init__(self, spec: ToolSpec) -> None:
        self.spec = spec
        self.validator = jsonschema.Draft202012Validator(spec.input_schema)
        self.captured: dict | None = None
        self.violations: list[str] = []
        self._verdicts: dict[str, str] = {}  # args (canonical json) -> verdict, so handler + stream scan agree
        self._lock: asyncio.Lock | None = None  # offer_async: one validation at a time per state

    def offer(self, args: Any) -> str:
        """Validate one tool call. Valid -> capture (last call wins) and 'recorded'; invalid -> the violation text."""
        try:
            key = json.dumps(args, sort_keys=True, default=str)
        except Exception:
            key = repr(args)
        if key in self._verdicts:
            if self._verdicts[key] == "recorded" and isinstance(args, dict):
                self.captured = copy.deepcopy(args)  # last call wins, even when repeated
            return self._verdicts[key]
        if not isinstance(args, dict):
            errors, text = True, f"$: the tool arguments must be an object, got {type(args).__name__}"
        else:
            found = sorted(self.validator.iter_errors(args), key=str)
            errors = bool(found)
            text = "; ".join(f"{e.json_path}: {e.message}" for e in found[:5])
        if errors:
            self.violations.append(text)
            verdict = f"The arguments do not match the {self.spec.name} schema — {text}. Call the tool again, corrected."
        else:
            self.captured = copy.deepcopy(args)
            verdict = "recorded"
        self._verdicts[key] = verdict
        return verdict

    async def offer_async(self, args: Any) -> str:
        """offer() in a worker thread, one at a time per state, so validating a large tool call stays off the loop."""
        if self._lock is None:
            self._lock = asyncio.Lock()
        async with self._lock:
            return await asyncio.to_thread(self.offer, args)


@dataclass
class _Turn:
    """What one turn's message stream contained, for classification."""

    assistant: AssistantMessage | None = None  # the final AssistantMessage
    result: ResultMessage | None = None
    rate_limited: bool = False
    resets_at: int | None = None
    text_parts: list[str] = field(default_factory=list)
    out_inputs: list[Any] = field(default_factory=list)  # the output tool's calls' inputs, in order (a cut-off one included)
    recorded_by: str | None = None  # the model named on the message that made the first recorded call
    interrupted: bool = False  # the turn was interrupted once the CLI returned that call's result


class _Stalled(Exception):
    """No sign of life for the idle limit. The session loop decides whether the one stall retry is left.

    `came_up=False` marks a stall before the session came up (the SDK bounds its own initialize handshake at >=60 s,
    which can be shorter than the idle limit).
    """

    def __init__(self, came_up: bool = True) -> None:
        super().__init__()
        self.came_up = came_up


class _Transient(Exception):
    """A session or conversation ended on a transient failure (retry.transient_class: 5xx/529, 429, or an overloaded or
    connection error in the body or stream). `result` is the CallResult the call would have returned; `cls` its class;
    `with_backoff` runs the loop again on retry.model_knobs()'s schedule."""

    def __init__(self, result: CallResult, cls: str) -> None:
        super().__init__(f"{cls}: {result.detail}")
        self.result = result
        self.cls = cls


class _Life:
    """Signs of life across one whole structured() call, read when a clock fires.

    beat() runs for every SDK message, partial StreamEvents included. stall_retried records that the one fresh-session
    stall retry was spent.
    """

    def __init__(self) -> None:
        self.n = 0
        self.t = time.monotonic()
        self.stall_retried = False

    def beat(self) -> None:
        self.n += 1
        self.t = time.monotonic()


def _stall_detail(idle_s: float, *, retried: bool, came_up: bool = True) -> str:
    """The timeout detail when the idle clock fired."""
    what = f"stalled: no output for {idle_s:g} s" if came_up else "stalled: the session never came up"
    base = f"{what} (idle limit {idle_s:g} s; no wall-clock ceiling)"
    return base + ("; retried once in a fresh session and it stalled again" if retried else "")


# claude_agent_sdk 0.2.144 reports a CLI wedged at startup as a bare Exception with this message. Matching it is brittle
# across SDK versions but fails safe: an unmatched wedge becomes an error result rather than a retry.
_CLI_INIT_TIMEOUT = "Control request timeout: initialize"


def _make_client(opts: ClaudeAgentOptions) -> ClaudeSDKClient:
    """Seam for tests: monkeypatch this to script the SDK message stream."""
    _bind_sdk()
    return ClaudeSDKClient(opts)


_FAST_MODE_NOTED: set[str] = set()  # models whose lack of fast mode this process has logged (once each)


def _resolve_speed(speed: str | None) -> str:
    """The speed one call asks for: the caller's `speed` when given, else config.model_speed() (THIMBLE_MODEL_SPEED,
    default fast); an invalid value runs the default with a warning."""
    if speed is None:
        return config.model_speed()
    v = str(speed).strip().lower()
    if v not in config.SPEEDS:
        log.warning("structured: speed=%r is not one of %s; using the default (%s)", speed, config.SPEEDS, config.model_speed())
        return config.model_speed()
    return v

def _instruction(spec: ToolSpec) -> str:
    return f"Return the output ONLY via the `{spec.name}` tool; call it exactly once and write no prose."


def _out_server(spec: ToolSpec, state: CallState) -> Any:
    """The output tool's server: one MCP tool, the spec's schema, the state's validator behind it."""
    _bind_sdk()

    async def out(args: dict[str, Any]) -> dict[str, Any]:
        return {"content": [{"type": "text", "text": await state.offer_async(args)}]}

    return create_sdk_mcp_server(_SERVER, tools=[sdk_tool(spec.name, spec.description, spec.input_schema)(out)])


def _options(spec: ToolSpec, state: CallState, *, model: str | None, effort: str | None, system: str,
             cwd: str | Path, speed: str = "standard") -> ClaudeAgentOptions:
    """The SDK options for one structured call (sdk.build): the output tool's server under `out`, in the served config
    dir (config.claude_env), and the caller's `system` followed by the output tool's instruction as the whole system
    prompt. No transcript is kept."""
    instruction = _instruction(spec)
    return sdk.build(
        cwd=cwd,
        tools=[f"mcp__{_SERVER}__{spec.name}"],
        mcp_servers={_SERVER: _out_server(spec, state)},
        system=f"{system}\n\n{instruction}" if system else instruction,
        model=model,
        effort=effort,
        env=config.claude_env({}),
        speed=speed,
        persist=False,
    )


def is_rate_limit_rejection(msg: Any) -> bool:
    """A rate-limit message saying the limit is hit, from either shape the CLI emits."""
    _bind_sdk()
    if isinstance(msg, RateLimitEvent):
        info = msg.rate_limit_info
        return getattr(info, "status", None) == "rejected"
    if isinstance(msg, SystemMessage):
        data = msg.data if isinstance(getattr(msg, "data", None), dict) else {}
        info = data.get("rate_limit_info") or data.get("rateLimitInfo")
        if isinstance(info, dict):
            return info.get("status") == "rejected"
    return False


def resets_at(msg: Any) -> int | None:
    """The epoch at which a rejected rate limit resets, from either message shape; None when it does not say."""
    _bind_sdk()
    if isinstance(msg, RateLimitEvent):
        return getattr(msg.rate_limit_info, "resets_at", None)
    if isinstance(msg, SystemMessage):
        data = msg.data if isinstance(getattr(msg, "data", None), dict) else {}
        info = data.get("rate_limit_info") or data.get("rateLimitInfo") or {}
        if isinstance(info, dict):
            return info.get("resets_at") or info.get("resetsAt")
    return None


async def _drain(client: Any, state: CallState, tool_name: str, idle_s: float, life: _Life,
                 cap: capture.Call = capture.NULL) -> _Turn:
    """Consume one turn's messages, offering every `out` tool call to `state` (idempotent; this scan is what fake
    clients in tests exercise). `cap` gets every assistant block, tool result and result message as they arrive.

    Once the CLI has returned a recorded call's result, the turn is interrupted, so the model does not answer it, and read
    on to its result message. Every message, partial StreamEvents included, resets the idle clock; a gap of idle_s raises
    _Stalled.
    """
    _bind_sdk()
    turn = _Turn()
    full = f"mcp__{_SERVER}__{tool_name}"
    it = aiter(client.receive_response())
    recorded: str | None = None  # the id of the first call recorded
    while True:
        try:
            async with asyncio.timeout(idle_s):
                msg = await anext(it)
        except StopAsyncIteration:
            break
        except TimeoutError:
            raise _Stalled() from None
        life.beat()
        if isinstance(msg, AssistantMessage):
            turn.assistant = msg
            cap.assistant(msg.content)
            for block in msg.content:
                if isinstance(block, TextBlock):
                    turn.text_parts.append(block.text)
                elif isinstance(block, ToolUseBlock) and block.name == full:
                    turn.out_inputs.append(block.input)
                    if await state.offer_async(block.input) == "recorded" and recorded is None:
                        recorded, turn.recorded_by = block.id, msg.model
            if msg.error == "rate_limit":
                turn.rate_limited = True
        elif isinstance(msg, ResultMessage):
            turn.result = msg
            cap.result(msg)
        elif isinstance(msg, UserMessage):
            for block in (msg.content if isinstance(msg.content, list) else []):
                if isinstance(block, ToolResultBlock):
                    cap.tool_result(block.tool_use_id, block.content, bool(block.is_error))
                    if block.tool_use_id == recorded and not turn.interrupted:
                        turn.interrupted = True
                        await _interrupt(client)
        elif is_rate_limit_rejection(msg):
            turn.rate_limited = True
            turn.resets_at = resets_at(msg)
        # Anything else — StreamEvent partials, system chatter — carries no classification weight; it already
        # counted as the sign of life above.
    return turn


INTERRUPT_WAIT_S = 10.0


async def _interrupt(client: Any) -> None:
    """Ask the CLI to end the turn. A failed interrupt only means the rest of the turn is read as it comes."""
    try:
        async with asyncio.timeout(INTERRUPT_WAIT_S):
            await client.interrupt()
    except Exception:  # noqa: BLE001
        log.debug("structured: the interrupt after the recorded call failed", exc_info=True)


# CLI children that outlive their call. Every client's CLI child is recorded on connect and killed on close when it
# survived, and a recorded child older than REAP_AGE_S is reaped at the next call, since a dropped coroutine never
# closes its client. This never ends a live call.
_STRUCTURED_CHILDREN: dict[int, float] = {}  # child pid -> monotonic start
REAP_AGE_S = float(os.environ.get("THIMBLE_CLI_REAP_AGE_S", str(6 * 3600)))


def _child_pid(client: Any) -> int | None:
    try:
        return int(client._transport._process.pid)  # noqa: SLF001 — the SDK exposes no public handle
    except Exception:  # noqa: BLE001
        return None


def _looks_like_cli(pid: int) -> bool:
    """True when /proc says the pid is a `claude` CLI (a pid can be reused by an unrelated process)."""
    try:
        with open(f"/proc/{pid}/cmdline", "rb") as fh:
            return b"claude" in fh.read(4096)
    except OSError:
        return False


def _kill_child(pid: int | None, *, why: str) -> bool:
    """SIGKILL a CLI child that is still alive; True when something was killed."""
    if not pid or not _looks_like_cli(pid):
        _STRUCTURED_CHILDREN.pop(pid or -1, None)
        return False
    try:
        os.kill(pid, signal.SIGKILL)
    except OSError:
        _STRUCTURED_CHILDREN.pop(pid, None)
        return False
    log.warning("killed CLI child %d (%s)", pid, why)
    _STRUCTURED_CHILDREN.pop(pid, None)
    return True


def reap_stale_children(max_age_s: float | None = None) -> int:
    """Kill recorded structured() children older than `max_age_s` (default REAP_AGE_S, 6 h): leak hygiene for
    children whose caller was dropped, never a limit on a running call. Returns how many were killed."""
    limit = REAP_AGE_S if max_age_s is None else max_age_s
    now = time.monotonic()
    killed = 0
    for pid, started in list(_STRUCTURED_CHILDREN.items()):
        if now - started > limit:
            killed += 1 if _kill_child(pid, why=f"outlived the call by {now - started - limit:.0f} s") else 0
    return killed


RATE_LIMIT_RETRY_S = float(os.environ.get("THIMBLE_RATE_LIMIT_RETRY_S", "45"))
RATE_LIMIT_RETRY_MAX_S = 300.0


def _rate_limit_wait(resets_at: Any) -> float:
    """Seconds to wait before the one 429 retry: until the API's reset when it is an epoch within five minutes,
    else RATE_LIMIT_RETRY_S; never more than RATE_LIMIT_RETRY_MAX_S."""
    wait = RATE_LIMIT_RETRY_S
    if isinstance(resets_at, (int, float)) and not isinstance(resets_at, bool):
        until = float(resets_at) - time.time() + 2.0
        if 0 < until <= RATE_LIMIT_RETRY_MAX_S:
            wait = max(wait, until)
    return min(wait, RATE_LIMIT_RETRY_MAX_S)


def _partial_of(inputs: list[Any]) -> dict | None:
    """CallResult.partial: the output tool's last call's input when it is an object, else None."""
    last = inputs[-1] if inputs else None
    return last if isinstance(last, dict) else None


def _classify(turn: _Turn, state: CallState) -> tuple[Status, str]:
    """(status, one plain sentence), each read from SDK objects, never guessed."""
    if state.captured is not None:
        return "ok", ""  # a valid capture is ok even when prose accompanied it
    a, r = turn.assistant, turn.result
    if a is not None and a.stop_reason == "refusal":
        return "refused", "the model refused the request (stop_reason refusal)"
    if turn.rate_limited or (a is not None and a.error == "rate_limit") or (
        r is not None and r.is_error and r.api_error_status == 429
    ):
        when = f"; the limit resets at {turn.resets_at}" if turn.resets_at else ""
        return "rate_limited", f"the subscription's rate limit is exhausted{when}"
    if a is not None and a.stop_reason == "max_tokens":
        return "truncated", "the response hit max_tokens before a valid tool call"
    if a is not None and a.error in _ERROR_KINDS:
        return "error", f"the model call failed ({a.error})"
    if r is not None and (r.is_error or r.errors):
        status_part = f" (HTTP {r.api_error_status})" if r.api_error_status else ""
        # the CLI's `errors`, else its result text: an error the API streamed inside a 200 is named only there, and
        # retry.transient_class reads this sentence
        errs = "; ".join(str(e) for e in (r.errors or [])[:3]) or str(r.result or "").strip()[:300]
        return "error", f"the session reported an error{status_part}{': ' + errs if errs else ''}"
    if r is not None:
        if state.violations:
            return "no_tool_call", f"the {state.spec.name} tool was called but its arguments never matched the schema ({state.violations[-1]})"
        return "no_tool_call", f"the model answered in prose without calling the {state.spec.name} tool"
    return "error", "the session ended without a result message"


def _corrective(tool_name: str, state: CallState) -> str:
    correcting = f", correcting: {state.violations[-1]}" if state.violations else ""
    return f"Return the output by calling the `{tool_name}` tool exactly once{correcting}. Do not answer in prose."


def model_used(requested: str | None, result: ResultMessage | None, ran: str | None = None) -> tuple[str | None, str]:
    """(model that actually ran, runtime substitution note or ''). The CLI's model_usage also lists its helper calls, so
    the test is whether the requested model is among the keys. `ran`, the model named on the message that made the call,
    is read in place of model_usage when given."""
    used = [ran] if ran else sorted(k for k in (getattr(result, "model_usage", None) or {}) if isinstance(k, str))
    if not used:
        return None, ""
    if requested:
        match = next((u for u in used if u == requested or u.startswith(requested)), None)
        if match:
            return match, ""
        return ", ".join(used), f"ran on {', '.join(used)}, not the {requested} it asked for"
    return ", ".join(used), ""


def usage_of(obj: Any) -> dict | None:
    """{input_tokens, output_tokens, cache_read_input_tokens?, cache_creation_input_tokens?} from a usage dict or
    object; None when the first two are absent. Cache keys are kept because with caching `input_tokens` is only the
    uncached remainder."""
    u = getattr(obj, "usage", None) if obj is not None else None
    if u is None:
        return None
    get = u.get if isinstance(u, dict) else (lambda k, d=None: getattr(u, k, d))
    out = {}
    for k in ("input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"):
        v = get(k)
        if isinstance(v, int) and not isinstance(v, bool) and (k in ("input_tokens", "output_tokens") or v):
            out[k] = v
    if "input_tokens" not in out and "output_tokens" not in out:
        return None
    return out


def _image_blocks(images: Sequence[tuple[bytes, str]]) -> list[dict[str, Any]]:
    """The Messages API's image blocks for (bytes, media type) pairs, base64 inline."""
    return [{"type": "image", "source": {"type": "base64", "media_type": mime, "data": base64.b64encode(data).decode("ascii")}}
            for data, mime in images]


async def _with_images(text: str, images: Sequence[tuple[bytes, str]]) -> AsyncIterator[dict[str, Any]]:
    """The CLI's first user message with images, in stream-json form: the image blocks then the text."""
    yield {"type": "user", "message": {"role": "user", "content": [*_image_blocks(images), {"type": "text", "text": text}]},
           "parent_tool_use_id": None}


async def structured(
    prompt: str,
    *,
    tool: ToolSpec,
    model: str,
    effort: str,
    speed: str,
    system: str = "",
    cwd: str | Path,
    idle_timeout_s: float = DEFAULT_IDLE_TIMEOUT_S,
    corrective_retries: int = 1,
    images: Sequence[tuple[bytes, str]] = (),
    on_retry: Callable[[int, float, str, BaseException | None], Any] | None = None,
    on_fallback: Callable[[float], Any] | None = None,
) -> CallResult:
    """One structured call. Never raises; every failure is a CallResult.

    `model`, `effort` and `speed` are the caller's role's (config.call_settings), always given, so nothing comes from
    the analyst's Claude Code settings; a call without a model or an effort ends `error` before it starts. `speed` fast
    runs the call in fast mode on a model that has it. `system` is the call's own system prompt, sent whole with the
    output tool's instruction after it (no Claude Code preset). `images` are (bytes, media type) pairs sent before the
    prompt's text. `on_retry(n, wait_s, error_class, exc)` hears each wait before a rule 2 or 4 retry and
    `on_fallback(spent_s)` the time a refused call took, so a caller's own time limit can exclude them.

    Retry rules: (1) no_tool_call or schema-invalid: up to `corrective_retries` extra turns
    saying what was wrong; (2) a transient failure: a fresh conversation after each wait of retry.model_knobs()'s
    schedule; (3) a stall: one immediate retry in a fresh session; (4) a 429: one wait until the reset (at most
    RATE_LIMIT_RETRY_MAX_S), then rate_limited; (5) refused: once more on config.FALLBACK_MODEL. Truncated and auth
    errors are never retried here.
    """
    await _bind_sdk_off_loop()
    kw: dict[str, Any] = dict(tool=tool, effort=effort, system=system, cwd=cwd,
                              idle_timeout_s=idle_timeout_s, corrective_retries=corrective_retries, speed=speed,
                              images=images, on_retry=on_retry)
    res = await _structured(prompt, model=model, **kw)
    fallback = config.FALLBACK_MODEL
    refused = res.model_requested
    if res.status != "refused" or not fallback or refused.startswith(fallback):
        return res
    log.warning("structured %s: %s refused the call (%s); running it again on %s", tool.name, refused, res.detail,
                fallback)
    if on_fallback is not None:
        try:
            on_fallback(res.duration_s)
        except Exception:  # noqa: BLE001 — a listener never stops the fallback
            log.debug("structured %s: on_fallback raised", tool.name, exc_info=True)
    again = await _structured(prompt, model=fallback, **kw)
    again.refused_by = refused
    again.duration_s = round(res.duration_s + again.duration_s, 2)
    again.attempts += res.attempts
    return again


async def _structured(
    prompt: str,
    *,
    tool: ToolSpec,
    model: str,
    effort: str,
    speed: str,
    system: str = "",
    cwd: str | Path,
    idle_timeout_s: float = DEFAULT_IDLE_TIMEOUT_S,
    corrective_retries: int = 1,
    images: Sequence[tuple[bytes, str]] = (),
    on_retry: Callable[[int, float, str, BaseException | None], Any] | None = None,
) -> CallResult:
    """structured() past the SDK's off-loop bind: the whole call. NEVER raises."""
    _bind_sdk()
    t0 = time.monotonic()
    requested = model
    speed = _resolve_speed(speed)
    fast = speed == "fast" and config.has_fast_mode(requested)
    if speed == "fast" and not fast and requested not in _FAST_MODE_NOTED:
        _FAST_MODE_NOTED.add(requested)  # once per model per process, not once per call
        log.info("structured: no fast mode on %s; its calls run at standard speed", requested)
    attempts = 0
    cap = capture.NULL  # the call's capture file (THIMBLE_PROMPT_CAPTURE), opened once the call starts

    def finish(res: CallResult) -> CallResult:
        res.duration_s = round(time.monotonic() - t0, 2)
        res.model_requested = requested
        res.attempts = attempts
        cap.finish(res.status, res.detail, attempts=attempts, model_used=res.model_used, cost_usd=res.cost_usd,
                   fallback_note=res.fallback_note)
        log.info("structured %s: %s after %.2f s (%s, effort %s%s; %d attempt(s))", tool.name, res.status,
                 res.duration_s, res.model_used or requested, effort or "default", ", fast mode" if fast else "",
                 attempts)
        if res.status != "ok" and res.detail:
            log.warning("structured %s: %s (%s)", tool.name, res.status, res.detail)
        return res

    if not config.CLI_PATH:
        return finish(CallResult(status="error", detail=config.NO_CLAUDE_FOUND))
    if not str(requested or "").strip() or not str(effort or "").strip():
        return finish(CallResult(status="error", detail=f"the {tool.name} call names no model or no effort, which "
                                                        "it would take from Claude Code's settings (config.call_settings)"))
    try:
        # the metaschema walk, off the loop
        await asyncio.to_thread(jsonschema.Draft202012Validator.check_schema, tool.input_schema)
    except jsonschema.SchemaError as e:
        return finish(CallResult(status="error", detail=f"the {tool.name} tool's input_schema is invalid: {e.message}"))

    log.info("structured %s: %s at effort %s%s", tool.name, requested, effort or "default", " in fast mode" if fast else "")
    cap = capture.begin(capture.caller(tool.name), model=requested, effort=effort, path="sdk",
                        speed="fast" if fast else "standard", output_tool=tool.name, cwd=str(cwd))

    async def run(life: _Life) -> CallResult:
        nonlocal attempts
        last: CallResult | None = None
        # rule 2 is with_backoff's; rule 3's stall flag lives on `life`, across sessions
        rate_retry_used = False  # one wait-and-retry on a 429 before it is terminal
        while True:  # each flag is set at most once, so at most three sessions run per with_backoff attempt
            state = CallState(tool)
            opts = _options(tool, state, model=requested, effort=effort, system=system, cwd=cwd,
                            speed="fast" if fast else "standard")
            retry_note, retry_sleep = "", 0.0
            if attempts:
                cap.note("a fresh session (a stall or a rate-limit retry); the options below are the new session's")
            await cap.sdk_options(opts, out_tool=tool)
            reap_stale_children()
            client_cm = _make_client(opts)
            entered = False
            child_pid: int | None = None
            try:
                try:
                    # The connect shares the idle clock: a CLI wedged before the session is up is a stall too. The SDK
                    # reports its own initialize-handshake timeout as a bare Exception, mapped to the same stall.
                    async with asyncio.timeout(idle_timeout_s):
                        client = await client_cm.__aenter__()
                    entered = True
                    child_pid = _child_pid(client)
                    if child_pid:
                        _STRUCTURED_CHILDREN[child_pid] = time.monotonic()
                except TimeoutError:
                    raise _Stalled(came_up=False) from None
                except Exception as e:
                    if _CLI_INIT_TIMEOUT in str(e):
                        raise _Stalled(came_up=False) from e
                    raise
                pending = prompt
                corrective_used = 0
                while True:
                    attempts += 1
                    cap.user(pending, label="corrective turn" if corrective_used else "")
                    try:
                        # The write shares the idle clock: a CLI wedged before it echoes anything is a stall too.
                        async with asyncio.timeout(idle_timeout_s):
                            if images and not corrective_used:
                                await client.query(_with_images(pending, images))
                            else:
                                await client.query(pending)
                    except TimeoutError:
                        raise _Stalled() from None
                    turn = await _drain(client, state, tool.name, idle_timeout_s, life, cap)
                    status, detail = _classify(turn, state)
                    used, run_note = model_used(requested, turn.result)
                    cost = getattr(turn.result, "total_cost_usd", None)
                    if run_note and turn.interrupted and turn.recorded_by:
                        # the interrupt can end the turn before its result counts the model's usage, leaving the CLI's
                        # helper calls alone in model_usage and in the cost
                        (used, run_note), cost = model_used(requested, None, turn.recorded_by), None
                    last = CallResult(
                        status=status,
                        output=state.captured if status == "ok" else None,
                        model_used=used,
                        fallback_note=run_note,
                        cost_usd=cost,
                        usage=usage_of(turn.result),
                        session_id=(turn.result.session_id if turn.result is not None
                                    else getattr(turn.assistant, "session_id", None)),
                        detail=detail,
                        text="\n".join(turn.text_parts),
                        partial=_partial_of(turn.out_inputs) if status == "truncated" else None,
                    )
                    if status == "ok":
                        return last
                    if status == "error":
                        r = turn.result
                        cls = retry.transient_class(r.api_error_status if r is not None and r.is_error else None, detail)
                        if cls:
                            raise _Transient(last, cls)  # rule 2: with_backoff runs a fresh session after the wait
                    if status == "rate_limited" and not rate_retry_used:
                        # a 429 is usually over within a minute: wait once (until the reset when named soon, else
                        # RATE_LIMIT_RETRY_S) and retry in a fresh session
                        rate_retry_used = True
                        retry_note, retry_sleep = last.detail, _rate_limit_wait(turn.resets_at)
                        break
                    if status == "no_tool_call" and corrective_used < corrective_retries:
                        corrective_used += 1
                        pending = _corrective(tool.name, state)
                        continue
                    return last
            except _Stalled as stall:
                last = CallResult(status="timeout", detail=_stall_detail(idle_timeout_s, retried=life.stall_retried,
                                                                         came_up=stall.came_up))
                if not life.stall_retried:
                    life.stall_retried = True
                    retry_note = ((f"no output for {idle_timeout_s:g} s" if stall.came_up
                                   else "the session never came up")
                                  + "; a wedged session does not recover")
            finally:
                # A stall exits through here: the SDK's close() is a bounded terminate/kill escalation. A failed connect
                # cleans up after itself, so only an entered session is closed.
                if entered:
                    await client_cm.__aexit__(None, None, None)
                    _kill_child(child_pid, why="survived the client's close")
            if not retry_note:
                return last
            log.info("structured %s: %s; retrying once in a fresh session", tool.name, retry_note)
            if retry_sleep:  # the rate-limit wait after a 429; a stall retries at once
                if on_retry is not None:
                    try:
                        on_retry(0, retry_sleep, "rate_limited", None)
                    except Exception:  # noqa: BLE001 — a listener never stops the retry
                        log.debug("structured %s: on_retry raised", tool.name, exc_info=True)
                await asyncio.sleep(retry_sleep)

    async def with_backoff() -> CallResult:
        """Rule 2: the whole session loop, again in a fresh one after each transient failure on retry.model_knobs()'s
        schedule. The wait is spent outside the semaphore; the failure that outlives the schedule is the result."""
        retries, base_s = retry.model_knobs()

        async def attempt() -> CallResult:
            async with _semaphore():
                return await run(life)

        try:
            return await retry.with_retries(attempt, retries=retries, base_s=base_s, what=f"structured {tool.name}",
                                            classify=lambda e: e.cls if isinstance(e, _Transient) else None,
                                            on_retry=on_retry)
        except _Transient as e:
            return e.result

    life = _Life()  # signs of life across the whole call (the stall retry flag lives here)
    try:
        # No wall-clock ceiling: the idle clock inside run() detects a stopped call, never a long one.
        return finish(await with_backoff())
    except CLINotFoundError as e:
        return finish(CallResult(status="error", detail=f"the claude CLI was not found ({e})"))
    except (ProcessError, CLIJSONDecodeError, ClaudeSDKError) as e:
        return finish(CallResult(status="error", detail=f"the claude CLI session failed ({type(e).__name__}: {str(e)[:300]})"))
    except Exception as e:  # noqa: BLE001 — structured() never raises
        log.exception("structured %s: unexpected failure", tool.name)
        return finish(CallResult(status="error", detail=f"unexpected failure ({type(e).__name__}: {str(e)[:300]})"))
