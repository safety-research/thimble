"""The `thimble` module of a program that runs one of thimble's roles or tasks: an Agent SDK program, whose
`run(input)` run_sdk.py calls, or a command harness that calls `thimble.serve(run)`. docs/agents.md documents the
contract.

The program and thimble talk in JSON lines. thimble writes the input on the program's stdin, then the answer to each
request; the program writes its requests, its log lines and its output on stdout. Once this module is set up, anything
else the program prints goes to stderr, so the stream stays clean. A program in another language writes the lines
itself.

  thimble -> program   {"input": {...}}               first
                       {"id": 4, "result": ...}       the answer to request 4, or {"id": 4, "error": "..."}
  program -> thimble   {"id": 4, "tool": {"name", "args"}}                 one of thimble's tools, as the role
                       {"id": 5, "ask": {"prompt", "schema"?, "model"?}}   one model call
                       {"id": 6, "session": {"prompt", "system"?, "tools"?, "agents"?, "model"?}}   a Claude Code
                                                                           session
                       {"id": 7, "default": {"input", "model"?}}           a task: thimble's own implementation
                       {"log": "text"}                                     a line in the agent's thread
                       {"output": ...}                                     last: what the role or task returns
"""
from __future__ import annotations

import asyncio
import inspect
import itertools
import json
import os
import re
import sys
import threading
from pathlib import Path
from typing import Any, Callable

WORK = Path(os.environ.get("THIMBLE_WORK") or ".")  # the folder the program may write in
CORPUS = Path(os.environ.get("THIMBLE_CORPUS") or ".")  # the analyst's corpus, read-only unless they allow edits
ROLE = os.environ.get("THIMBLE_ROLE", "")  # '' for a task
TASK = os.environ.get("THIMBLE_TASK", "")  # '' for a role
AGENT_DIR = Path(os.environ.get("THIMBLE_AGENT_DIR") or ".")  # the folder of the program's agent.json
SLOT_RE = re.compile(r"\{\{([a-z_][a-z0-9_]*)\}\}")


class ThimbleError(RuntimeError):
    """thimble refused or failed a request; the message says why."""


_out: Any = None
_lock = threading.Lock()
_waits: dict[int, tuple[threading.Event, list[Any]]] = {}
_ids = itertools.count(1)
_given = threading.Event()
_input: list[Any] = []
_closed = threading.Event()


def _setup() -> None:
    """Keep the real stdout for the protocol and send everything else written to it to stderr; start reading stdin."""
    global _out
    if _out is not None:
        return
    _out = os.fdopen(os.dup(1), "w", buffering=1, encoding="utf-8")
    os.dup2(2, 1)
    sys.stdout = sys.stderr
    threading.Thread(target=_read, name="thimble-stdin", daemon=True).start()


def _send(obj: dict[str, Any]) -> None:
    _setup()
    line = json.dumps(obj, ensure_ascii=False, default=str)
    with _lock:
        _out.write(line + "\n")
        _out.flush()


def _read() -> None:
    for line in sys.stdin:
        try:
            msg = json.loads(line)
        except ValueError:
            continue
        if not isinstance(msg, dict):
            continue
        if "input" in msg and not _given.is_set():
            _input.append(msg["input"])
            _given.set()
        elif isinstance(msg.get("id"), int) and msg["id"] in _waits:
            done, box = _waits[msg["id"]]
            box.append(msg)
            done.set()
    _closed.set()
    _given.set()
    for done, box in list(_waits.values()):
        box.append({"error": "thimble closed the program's input"})
        done.set()


def get_input() -> Any:
    """The role's or task's input, which thimble sends first."""
    _setup()
    _given.wait()
    if not _input:
        raise ThimbleError("thimble sent no input")
    return _input[0]


def request(kind: str, payload: dict[str, Any]) -> Any:
    """Send one request and wait for its answer; ThimbleError when thimble refuses or fails it."""
    _setup()
    if _closed.is_set():
        raise ThimbleError("thimble closed the program's input")
    rid = next(_ids)
    done, box = threading.Event(), []
    _waits[rid] = (done, box)
    try:
        _send({"id": rid, kind: payload})
        done.wait()
    finally:
        _waits.pop(rid, None)
    answer = box[0] if box else {"error": "no answer"}
    if "error" in answer:
        raise ThimbleError(str(answer["error"]))
    return answer.get("result")


async def arequest(kind: str, payload: dict[str, Any]) -> Any:
    return await asyncio.to_thread(request, kind, payload)


def log(text: Any) -> None:
    """A line in the agent's thread, which the analyst sees."""
    _send({"log": str(text)})


def output(value: Any) -> None:
    """What the role or task returns: for the orientation, the one line main hears; for a task, its output object."""
    _send({"output": value})


async def tool(name: str, args: dict[str, Any] | None = None) -> dict[str, Any]:
    """One of thimble's tools, called as the role calls it: {content, is_error}."""
    return await arequest("tool", {"name": name, "args": args or {}})


def ask(prompt: str, schema: dict[str, Any] | None = None, model: str | None = None) -> Any:
    """One model call on the analyst's own Claude: the object `schema` describes, or text without one."""
    payload: dict[str, Any] = {"prompt": prompt}
    if schema is not None:
        payload["schema"] = schema
    if model:
        payload["model"] = model
    return request("ask", payload)


async def session(prompt: str, system: str | None = None, tools: list[str] | None = None,
                  agents: dict[str, Any] | None = None, model: str | None = None) -> str:
    """A Claude Code session thimble runs as the role or task, in its sandbox and permission mode; its last reply."""
    payload: dict[str, Any] = {"prompt": prompt}
    for k, v in (("system", system), ("tools", tools), ("agents", agents), ("model", model)):
        if v is not None:
            payload[k] = v
    return await arequest("session", payload)


def default(input: Any, model: str | None = None) -> Any:  # noqa: A002 — the protocol's name
    """thimble's own implementation of the task on `input`, on `model` in place of the task's own when given: the
    output it returns. A role has none to lend."""
    return request("default", {"input": input, **({"model": model} if model else {})})


def prompt(path: str, **slots: Any) -> str:
    """The text of `path` (relative to the program's agent folder) with each {{slot}} filled from `slots`."""
    p = Path(path)
    text = (p if p.is_absolute() else AGENT_DIR / p).read_text("utf-8")

    def fill(m: re.Match[str]) -> str:
        if m.group(1) not in slots:
            raise ThimbleError(f"{path}: no value for {{{{{m.group(1)}}}}}")
        return str(slots[m.group(1)])

    return SLOT_RE.sub(fill, text)


def options(**fields: Any) -> Any:
    """ClaudeAgentOptions for query() with `fields`, whose sessions thimble starts on the analyst's own claude, in the
    role's permission mode, sandbox and settings, with thimble's tools."""
    from claude_agent_sdk import ClaudeAgentOptions

    fields.setdefault("cwd", str(WORK))
    fields["cli_path"] = os.environ["THIMBLE_CLAUDE"]
    return ClaudeAgentOptions(**fields)


def serve(run: Callable[[Any], Any]) -> None:
    """Run a command harness: call `run` with the input (awaited when it is a coroutine function), send what it returns
    as the output, and exit."""
    result = run(get_input())
    if inspect.isawaitable(result):
        result = asyncio.run(_wait(result))
    output(result)
    sys.exit(0)


async def _wait(aw: Any) -> Any:
    return await aw
