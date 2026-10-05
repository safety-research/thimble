"""Prompt capture: THIMBLE_PROMPT_CAPTURE=<dir> writes every model call, as it is sent, to one file, so the prompts of
a run can be reviewed with their templates filled.

Off by default. Set, each call becomes `<dir>/<utc stamp>-<seq>-<caller>.md` with a header (caller, model, effort,
speed, and path), then ## Options, ## System prompt, ## Tools, ## Messages and ## Output sections.
Callers name themselves with `scope(name)` (a contextvar) and `caller(default)` reads it. Writes are small synchronous
appends; the switch is a debugging aid, not for a served deployment.
"""
from __future__ import annotations

import contextvars
import json
import logging
import os
import re
import threading
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

log = logging.getLogger("thimble.capture")

ENV = "THIMBLE_PROMPT_CAPTURE"
# environment variables whose values never reach a capture file
REDACTED_ENV = ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN")
REDACTED = "<redacted>"

_seq = 0
_seq_lock = threading.Lock()
_caller: contextvars.ContextVar[str | None] = contextvars.ContextVar("thimble_capture_caller", default=None)
# the prompt files loaded in this context since the last capture began: ((name, (file, include, ...)), ...) — a tuple, so
# a child task's copy never shares a list with its parent (prompts.load records; begin() takes and clears)
_prompt_files: contextvars.ContextVar[tuple] = contextvars.ContextVar("thimble_capture_prompt_files", default=())
_SLUG_RE = re.compile(r"[^A-Za-z0-9._-]+")


def directory() -> Path | None:
    """The capture directory, or None when the switch is off (THIMBLE_PROMPT_CAPTURE unset or blank; read per call)."""
    raw = os.environ.get(ENV, "").strip()
    return Path(raw).expanduser() if raw else None


def enabled() -> bool:
    return directory() is not None


# --------------------------------------------------------------------------- who is calling


@contextmanager
def scope(name: str | None, *, keep: bool = False) -> Iterator[None]:
    """Name the calls made inside the block (`caller()` reads it). `keep=True` leaves an outer scope in place — a
    module that is sometimes called from a named task and sometimes on its own names itself only when nobody did."""
    if keep and _caller.get() is not None:
        yield
        return
    token = _caller.set(name)
    try:
        yield
    finally:
        _caller.reset(token)


def reset() -> None:
    """Clear the scope — and the prompt files noted — for the current context (jobs.py, at the start of each job: a job
    task is created inside the enqueuing code's context and would otherwise carry both)."""
    _caller.set(None)
    _prompt_files.set(())


def prompt_used(name: str, files: list[str] | tuple[str, ...]) -> None:
    """prompts.load's note that `name` (a prompt file, relative to prompts/) was read in this context, with every file
    it includes (prompts.files): the next capture that begins here lists them as the files that composed the call. Nothing
    is kept when the switch is off."""
    if not enabled():
        return
    entry = (str(name), tuple(str(f) for f in files))
    cur = _prompt_files.get()
    if entry not in cur:
        _prompt_files.set((*cur, entry))


def take_prompt_files() -> tuple:
    """The prompt files noted in this context, cleared."""
    cur = _prompt_files.get()
    _prompt_files.set(())
    return cur


def prompt_files_line(entries: tuple) -> str:
    """One header line's worth: `main.md (includes shared.md); labels.md`."""
    parts = []
    for name, files in entries:
        inc = [f for f in files if f != name and f != f"{name}.md"]
        parts.append(f"{name}" + (f" (includes {', '.join(inc)})" if inc else ""))
    return "; ".join(parts)


def current() -> str | None:
    return _caller.get()


def caller(default: str) -> str:
    """The name for a capture file: the scope set by the caller, else `default` (a structured call's tool name)."""
    return _caller.get() or default


# --------------------------------------------------------------------------- rendering helpers


def _stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%f")[:-3] + "Z"


def _slug(name: str) -> str:
    s = _SLUG_RE.sub("-", name.strip()).strip("-").lower()
    return (s or "call")[:60]


def _jsonable(v: Any) -> Any:
    """`v` as something json.dumps takes: dataclasses, pydantic models, paths, sets and unknown objects reduced."""
    if v is None or isinstance(v, (bool, int, float, str)):
        return v
    if isinstance(v, dict):
        return {str(k): _jsonable(x) for k, x in v.items()}
    if isinstance(v, (list, tuple, set, frozenset)):
        return [_jsonable(x) for x in v]
    if isinstance(v, Path):
        return str(v)
    if hasattr(v, "model_dump"):
        try:
            return _jsonable(v.model_dump(exclude_none=True, by_alias=True))
        except Exception:  # noqa: BLE001
            pass
    if hasattr(v, "__dataclass_fields__"):
        return {k: _jsonable(getattr(v, k)) for k in v.__dataclass_fields__}
    return repr(v)


def _json(v: Any) -> str:
    return json.dumps(_jsonable(v), ensure_ascii=False, indent=2, sort_keys=False)


def fence(body: str, lang: str = "") -> str:
    """A fenced block that survives fences inside the body (the fence grows past the longest run of backticks)."""
    longest = max((len(m.group(0)) for m in re.finditer(r"`+", body)), default=0)
    ticks = "`" * max(3, longest + 1)
    return f"{ticks}{lang}\n{body}\n{ticks}"


def _settings(settings: Any) -> Any:
    if not isinstance(settings, str) or not settings.strip().startswith("{"):
        return settings
    try:
        return json.loads(settings)
    except ValueError:
        return settings


def _redact_env(env: Any) -> Any:
    if not isinstance(env, dict):
        return env
    return {k: (REDACTED if k in REDACTED_ENV else v) for k, v in env.items()}


def _content_text(content: Any) -> str:
    """A tool_result's content as text: a string as it is, a list of blocks by their text (an image by its type)."""
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for b in content:
            if isinstance(b, dict):
                if b.get("type") == "text":
                    parts.append(str(b.get("text", "")))
                else:
                    parts.append(f"<{b.get('type', 'block')}>")
            elif hasattr(b, "text"):
                parts.append(str(getattr(b, "text", "")))
            else:
                parts.append(repr(b))
        return "\n".join(parts)
    return str(content)


async def mcp_tool_defs(server: Any) -> list[dict[str, Any]] | None:
    """[{name, description, input_schema}] of an in-process SDK MCP server (claude_agent_sdk.create_sdk_mcp_server's
    config: {type: sdk, name, instance}), read from the server object's own tools/list handler — the definitions the
    CLI serves the model. None when the shape is not one this knows (the caller says so in the file)."""
    inst = server.get("instance") if isinstance(server, dict) else getattr(server, "instance", None)
    if inst is None:
        return None
    handlers = getattr(inst, "_request_handlers", None) or getattr(inst, "request_handlers", None) or {}
    entry = None
    for key, val in handlers.items():
        if key == "tools/list" or getattr(key, "__name__", "") == "ListToolsRequest":
            entry = val
            break
    if entry is None:
        return None
    handler = getattr(entry, "handler", entry)
    result = None
    for args in ((None, None), (None,), ()):
        try:
            result = await handler(*args)
            break
        except TypeError:
            continue
        except Exception:  # noqa: BLE001 — a handler that wants a real request context: listed as unknown
            log.debug("capture: tools/list handler failed", exc_info=True)
            return None
    if result is None:
        return None
    root = getattr(result, "root", result)
    tools = getattr(root, "tools", None)
    if tools is None:
        return None
    out = []
    for t in tools:
        d = _jsonable(t)
        if isinstance(d, dict):
            out.append({"name": d.get("name"), "description": d.get("description"),
                        "input_schema": d.get("inputSchema", d.get("input_schema"))})
    return out


def options_dict(opts: Any) -> dict[str, Any]:
    """A ClaudeAgentOptions as a JSON-able dict: servers by name and type (their tools are listed under ## Tools),
    hooks by event and matcher, the system prompt's append pointed at its own section, credentials redacted, None
    fields dropped."""
    out: dict[str, Any] = {}
    fields = getattr(opts, "__dataclass_fields__", None)
    names = list(fields) if fields else [k for k in vars(opts)] if hasattr(opts, "__dict__") else []
    for name in names:
        v = getattr(opts, name, None)
        if v is None or v == [] or v == {} or v == "":
            continue
        if name == "mcp_servers" and isinstance(v, dict):
            out[name] = {k: {"type": (s.get("type") if isinstance(s, dict) else type(s).__name__)} for k, s in v.items()}
        elif name == "hooks" and isinstance(v, dict):
            out[name] = {ev: [getattr(m, "matcher", repr(m)) for m in ms] for ev, ms in v.items()}
        elif name == "system_prompt":
            if isinstance(v, dict):
                out[name] = {**{k: x for k, x in v.items() if k != "append"}, "append": "<see ## System prompt>"}
            else:
                out[name] = "<see ## System prompt>"
        elif name == "settings":
            out[name] = _settings(v)
        elif name == "env":
            out[name] = _redact_env(v)
        elif name in ("can_use_tool", "stderr"):
            out[name] = repr(v)
        else:
            out[name] = _jsonable(v)
    return out


def system_append_of(opts: Any) -> str:
    sp = getattr(opts, "system_prompt", None)
    if isinstance(sp, dict):
        return str(sp.get("append") or "")
    return str(sp or "")


# --------------------------------------------------------------------------- one call's file


class Call:
    """One capture file, appended to as the call proceeds. `on` is False for the no-op instance every entry point
    returns when the switch is off: every method returns at once, so callers never branch."""

    def __init__(self, path: Path | None) -> None:
        self.path = path
        self.on = path is not None
        self.t0 = time.monotonic()
        self._events = 0

    def _append(self, text: str) -> None:
        if not self.on or self.path is None:
            return
        try:
            with open(self.path, "a", encoding="utf-8") as fh:
                fh.write(text)
        except OSError as e:
            log.warning("capture: could not append to %s: %s", self.path, e)
            self.on = False

    def section(self, title: str, body: str = "") -> None:
        self._append(f"\n## {title}\n\n{body.rstrip()}\n" if body else f"\n## {title}\n")

    def sub(self, title: str, body: str = "") -> None:
        self._append(f"\n### {title}\n\n{body.rstrip()}\n" if body else f"\n### {title}\n")

    def fenced(self, title: str, obj: Any, lang: str = "json", *, sub: bool = False) -> None:
        body = obj if isinstance(obj, str) else _json(obj)
        (self.sub if sub else self.section)(title, fence(body, lang))

    def text(self, title: str, body: str, *, sub: bool = False) -> None:
        """Free text (a prompt, a message, an answer) in a `text` fence: verbatim, and a `##` line inside it can never
        read as one of this file's own headings (the page's parser is fence-aware)."""
        (self.sub if sub else self.section)(title, fence(body, "text"))

    def note(self, text: str) -> None:
        self._append(f"\n_{text}_\n")

    # --- what is sent ---------------------------------------------------------------------------------------

    async def sdk_options(self, opts: Any, *, out_tool: Any = None, builtin: list[str] | None = None) -> None:
        """The Agent SDK path: the options (redacted), the system append verbatim, and every tool the model is
        offered — the structured call's output tool (`out_tool`, a model.ToolSpec) first, then the in-process
        servers' tools as their objects list them, then the built-in tools by name."""
        if not self.on:
            return
        self.fenced("Options (ClaudeAgentOptions as thimble builds them; sdk.build)", options_dict(opts))
        self.text("System prompt (the append; the CLI prepends its claude_code preset)", system_append_of(opts))
        tools: list[dict[str, Any]] = []
        if out_tool is not None:
            tools.append({"server": "out", "name": getattr(out_tool, "name", None), "description": getattr(out_tool, "description", None),
                          "input_schema": getattr(out_tool, "input_schema", None)})
        unknown: list[str] = []
        for sname, server in (getattr(opts, "mcp_servers", None) or {}).items():
            if out_tool is not None and sname == "out":
                continue
            defs = await mcp_tool_defs(server)
            if defs is None:
                unknown.append(sname)
                continue
            for d in defs:
                tools.append({"server": sname, **d})
        allowed = [str(t) for t in (getattr(opts, "allowed_tools", None) or [])]
        builtins = builtin if builtin is not None else [t for t in allowed if not t.startswith("mcp__")]
        head = (f"The model calls an MCP tool as `mcp__<server>__<name>`; `allowed_tools` names {len(allowed)} tool(s), "
                f"`disallowed_tools` {len(getattr(opts, 'disallowed_tools', None) or [])}. Built-in tools: "
                f"{', '.join(builtins) or 'none'}.")
        if unknown:
            head += f" Servers whose tool list could not be read from the object: {', '.join(unknown)}."
        self.section("Tools (as the CLI serves them to the model)", head + "\n\n" + fence(_json(tools), "json"))
        self.section("Messages (as sent)")

    def user(self, text: str, *, role: str = "user", label: str = "") -> None:
        if not self.on:
            return
        self.text(f"{role}{' (' + label + ')' if label else ''}", text, sub=True)

    # --- what comes back --------------------------------------------------------------------------------------

    def output_start(self) -> None:
        if self.on and not self._events:
            self.section("Output (the transcript as it arrived)")

    def assistant(self, blocks: list[Any]) -> None:
        """An assistant message's blocks: text verbatim, tool_use with name, id and full input, anything else by type."""
        if not self.on:
            return
        self.output_start()
        self._events += 1
        parts: list[str] = []
        for b in blocks:
            kind = getattr(b, "type", None) or (b.get("type") if isinstance(b, dict) else type(b).__name__)
            if kind == "text" or type(b).__name__ == "TextBlock":
                parts.append(fence(str(getattr(b, "text", b.get("text", "") if isinstance(b, dict) else "")), "text"))
            elif kind == "tool_use" or type(b).__name__ == "ToolUseBlock":
                name = getattr(b, "name", b.get("name") if isinstance(b, dict) else "")
                tid = getattr(b, "id", b.get("id") if isinstance(b, dict) else "")
                inp = getattr(b, "input", b.get("input") if isinstance(b, dict) else None)
                parts.append(f"**tool_use** `{name}` (id {tid})\n\n" + fence(_json(inp), "json"))
            elif kind == "thinking" or type(b).__name__ == "ThinkingBlock":
                parts.append("_(thinking block)_")
            else:
                parts.append(f"_({kind} block)_")
        self.sub("assistant", "\n\n".join(parts))

    def tool_result(self, tool_use_id: str, content: Any, is_error: bool = False) -> None:
        if not self.on:
            return
        self.output_start()
        self._events += 1
        self.sub(f"user (tool_result for {tool_use_id}{'; is_error' if is_error else ''})", fence(_content_text(content)))

    def result(self, msg: Any) -> None:
        """A ResultMessage (sdk): subtype, error flags, num_turns, cost, usage, model usage, duration."""
        if not self.on or msg is None:
            return
        self.output_start()
        self._events += 1
        keep = ("subtype", "is_error", "num_turns", "duration_ms", "duration_api_ms", "total_cost_usd", "usage",
                "model_usage", "stop_reason", "session_id", "api_error_status", "errors", "result")
        d = {k: _jsonable(getattr(msg, k)) for k in keep if getattr(msg, k, None) is not None}
        self.fenced("result", d, sub=True)

    def finish(self, status: str, detail: str = "", **extra: Any) -> None:
        if not self.on:
            return
        self.output_start()
        fields = {"status": status, "detail": detail, "duration_s": round(time.monotonic() - self.t0, 2), **extra}
        body = "\n".join(f"- {k}: {v}" for k, v in fields.items() if v not in (None, ""))
        self.section("Status", body)


NULL = Call(None)


def begin(name: str, *, model: str | None = None, effort: str | None = None, path: str = "", speed: str | None = None,
          note: str = "", **fields: Any) -> Call:
    """Open a call's file (NULL when the switch is off): the header names the caller, model, effort, speed and path,
    and says what is exact about the file. `fields` are more header lines (workspace, chat id, …)."""
    d = directory()
    if d is None:
        return NULL
    global _seq
    with _seq_lock:
        _seq += 1
        seq = _seq
    try:
        d.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        log.warning("capture: cannot create %s: %s", d, e)
        return NULL
    p = d / f"{_stamp()}-{seq:04d}-{_slug(name)}.md"
    cap = Call(p)
    paths = {
        "sdk": ("sdk — an Agent SDK session (ClaudeSDKClient over the `claude` CLI). The CLI builds the system prompt from "
                "its claude_code preset plus the append below and manages the conversation, so this file holds what "
                "thimble passes (options, append, tool definitions, the messages it sends) and the transcript the CLI "
                "streamed back — not the exact request bytes."),
        "message": "message — text the server hands a terminal Claude Code session (browser event, inbox or the next prompt's status block); exact.",
        "note": "note — rendered outside a live call.",
    }
    head = [f"# {name}", "", f"- caller: {name}", f"- when: {datetime.now(timezone.utc).isoformat(timespec='seconds')}"]
    if model:
        head.append(f"- model: {model}")
    if effort:
        head.append(f"- effort: {effort}")
    if speed:
        head.append(f"- speed: {speed}")
    for k, v in fields.items():
        if v not in (None, ""):
            head.append(f"- {k}: {v}")
    used = take_prompt_files()
    if used:
        head.append(f"- prompt_files: {prompt_files_line(used)}")
    if path:
        head.append(f"- path: {paths.get(path, path)}")
    if note:
        head.append(f"- note: {note}")
    cap._append("\n".join(head) + "\n")
    log.info("capture: %s -> %s", name, p.name)
    return cap
