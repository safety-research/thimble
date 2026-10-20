"""thimble browser's agents: each is one loop the server runs itself on the Messages API.

An agent is a system prompt and a fixed set of tools (AGENTS). Its turn is a loop:

1. send the conversation to the Messages API, streaming;
2. write each piece of the reply into the chat's log as it arrives, so the page shows it;
3. when Claude calls tools, run them as the server's own Python functions (tools.py), add their results, and go
   back to 1;
4. when Claude ends its turn, write a `done` record with the turn's token usage.

The conversation is kept, append-only, in `chats/<id>.messages.json`, so a chat goes on where it left off after a
restart, and a thread starts from a copy of main's. The system prompt and the tool list never change within a chat, and
both carry a cache breakpoint, so each request reads the conversation so far from the prompt cache.

Stop ends a turn cleanly: the reply in progress is dropped, and a tool call left without its result gets a result that
says the analyst stopped it, so the conversation stays valid for the next message.

No process is started for an agent, and no tool reaches past what tools.py allows: an agent can read the folder, run
Python in the sandbox and change the workspace's own store, nothing more.

There are two agents. The chat agent, `main`, answers in main and in each thread; its tools and its prompt are the
core's and those of the features that are on (features/). The views feature adds a view's builder, which starts only
when the analyst asks for a view. Nothing else runs an agent.
"""
from __future__ import annotations

import asyncio
import logging
import secrets
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

import anthropic

from . import chats, features, home, llm, prompts, settings
from .tools import Tools, definitions

log = logging.getLogger("thimble_browser.agent")

MAX_TOKENS = 64000
NOTIFY_S = 0.25  # the page hears that a chat changed at most this often while a reply streams
STREAM_RETRIES = 3  # a stream the API breaks off (overloaded, a dropped connection) is sent again this many times
READ = ("Read", "Grep", "Glob")


@dataclass
class AgentDef:
    """What an agent is: its prompt (from the folder) and the tools it may call, each a value or a function read at each
    request (the chat agent's change with the features that are on). `finished(session, result)` runs after each of its
    turns (result: None when the turn ended normally, else stopped, failed or refused). The views feature adds its
    builder to AGENTS."""
    prompt: Callable[[Path], str]
    tools: tuple[str, ...] | Callable[[], tuple[str, ...]]
    extra_roots: tuple[Path, ...] = ()
    finished: Callable[["Session", str | None], None] | None = None

    def tool_names(self) -> tuple[str, ...]:
        return self.tools() if callable(self.tools) else self.tools


CORE_TOOLS = READ + ("run_python",)


def _main_prompt(folder: Path) -> str:
    """The chat agent's prompt: its core (prompts/main.md), then the part of each feature that is on."""
    parts = "\n\n".join(prompts.render(name, {"workdir": str(folder)}) for name in features.main_prompt_parts())
    return prompts.render("main.md", {"workdir": str(folder), "features": parts})


AGENTS: dict[str, AgentDef] = {
    "main": AgentDef(_main_prompt, lambda: CORE_TOOLS + features.main_tools()),
}

# what runs after each turn of the chat agent, in main or a thread: fn(session, answer, result), `answer` the turn's
# text and `result` None when the turn ended normally. A feature adds its own (the lenses' one look after a turn); it
# must not wait (start a task for work that takes time) and must not raise.
AFTER_TURN: list[Callable[["Session", str, str | None], None]] = []


def role_of(meta: dict[str, Any]) -> str:
    """The agent a chat runs: its meta's `role` when it names one of AGENTS (a view's builder), else main (main and its
    threads)."""
    r = meta.get("agent") or meta.get("role")
    return r if r in AGENTS else "main"


# ---- the conversation on disk

def _messages_path(ws: str, chat: str) -> Path:
    return home.workspace_dir(ws) / "chats" / f"{chat}.messages.json"


def load_messages(ws: str, chat: str) -> list[dict[str, Any]]:
    got = home.read_json(_messages_path(ws, chat), [])
    return got if isinstance(got, list) else []


def save_messages(ws: str, chat: str, messages: list[dict[str, Any]]) -> None:
    home.write_json(_messages_path(ws, chat), messages)


def complete_prefix(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The longest start of `messages` that ends with a finished assistant turn (no tool call left open), which a new
    user message can follow: what a thread copies from main."""
    out = list(messages)
    while out:
        last = out[-1]
        open_call = last["role"] == "assistant" and any(
            isinstance(b, dict) and b.get("type") == "tool_use" for b in last.get("content") or [])
        if last["role"] == "assistant" and not open_call:
            break
        out.pop()
    return out


def _result_content(r: Any, text: str | None = None) -> Any:
    """A tool's result as the Messages API takes it: its text (`text` in place of r.text when given), and its pictures
    as image blocks after the text."""
    import base64  # noqa: PLC0415

    text = r.text if text is None else text
    images = [p for p in (r.images or []) if p.is_file()]
    if not images:
        return text
    return [{"type": "text", "text": text}] + [
        {"type": "image", "source": {"type": "base64", "media_type": "image/png",
                                     "data": base64.b64encode(p.read_bytes()).decode("ascii")}} for p in images]


def count_calls(messages: list[dict[str, Any]]) -> int:
    """How many tool calls the conversation holds: call n of a chat is its n-th tool_use block (calls.py)."""
    return sum(1 for m in messages if m.get("role") == "assistant" for b in m.get("content") or []
               if isinstance(b, dict) and b.get("type") == "tool_use")


def _block(b: Any) -> dict[str, Any]:
    """A content block of a reply as the next request sends it back: unchanged (thinking blocks keep their
    signatures)."""
    return b.model_dump(mode="json", exclude_none=True)


@dataclass
class Usage:
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_input_tokens: int = 0
    cache_creation_input_tokens: int = 0
    requests: int = 0
    fast_requests: int = 0  # the requests that ran in fast mode, as the API reports (usage.speed)

    def add(self, u: Any) -> None:
        self.requests += 1
        for k in ("input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"):
            setattr(self, k, getattr(self, k) + int(getattr(u, k, 0) or 0))
        if getattr(u, "speed", None) == "fast":
            self.fast_requests += 1

    def record(self) -> dict[str, int]:
        return {k: v for k, v in self.__dict__.items() if v or k != "fast_requests"}


class Session:
    """One agent's loop for one chat."""

    def __init__(self, ws: str, chat: str, folder: Path, *, unsandboxed: bool = False,
                 manager: "Sessions | None" = None) -> None:
        self.ws, self.chat, self.folder = ws, chat, folder
        self.manager = manager
        self.unsandboxed = unsandboxed
        meta = chats.meta(ws, chat)
        self.role = role_of(meta)
        self.defn = AGENTS[self.role]
        self.task: asyncio.Task | None = None
        self.running = False
        self.started_at: str | None = None  # when the turn running now, or the last one, started
        self.cards: list[str] = []
        self._last_notify = 0.0
        self._pending_notify: asyncio.TimerHandle | None = None
        self.meta = meta
        self.tools = Tools(ws, chat, folder, read_roots=[folder, *self.defn.extra_roots], unsandboxed=unsandboxed,
                           on_card=self.cards.append, view=meta.get("view"))
        self.tools.session = self

    # ---- the request

    def effort(self) -> str:
        """The analyst's effort: the composer's chip for this workspace, else Settings."""
        e = (home.read_json(home.workspace_dir(self.ws) / "session.json", {}) or {}).get("effort")
        return {"ultracode": "xhigh"}.get(e, e) if e in settings.EFFORTS + ("ultracode",) else settings.read()["effort"]

    def fast(self) -> bool:
        """Fast mode for the chat agent, in main and its threads: the composer's bolt for this workspace, off unless the
        analyst turned it on. A view's builder runs at standard speed."""
        return self.role == "main" and (home.read_json(home.workspace_dir(self.ws) / "session.json", {}) or {}).get(
            "fast") is True

    def request(self, messages: list[dict[str, Any]]) -> dict[str, Any]:
        tools = definitions(self.defn.tool_names())
        tools[-1] = {**tools[-1], "cache_control": {"type": "ephemeral"}}
        return {"max_tokens": MAX_TOKENS, "thinking": {"type": "adaptive"},
                "system": [{"type": "text", "text": self.defn.prompt(self.folder), "cache_control": {"type": "ephemeral"}}],
                "tools": tools, "messages": messages, "cache_control": {"type": "ephemeral"},
                **llm.request_args(effort=self.effort(), fast=self.fast())}

    # ---- the log

    def _notify(self) -> None:
        loop = asyncio.get_running_loop()
        now = loop.time()
        if now - self._last_notify >= NOTIFY_S:
            self._last_notify = now
            chats.hub.publish(self.ws, {"type": "chat", "chat": self.chat})
        elif self._pending_notify is None:
            def fire() -> None:
                self._pending_notify = None
                self._last_notify = loop.time()
                chats.hub.publish(self.ws, {"type": "chat", "chat": self.chat})
            self._pending_notify = loop.call_later(NOTIFY_S, fire)

    def _append(self, rec: dict[str, Any]) -> None:
        chats.append(self.ws, self.chat, rec, notify=False)
        self._notify()

    # ---- a turn

    async def send(self, text: str, *, shown: str | None = None, record: dict[str, Any] | None = None) -> None:
        """Start a turn on the analyst's message `text` (`shown` is what the chat shows of it, when that differs, and
        `record` more fields of its row)."""
        if self.running:
            raise RuntimeError("Claude is still answering the last message in this chat")
        chats.append(self.ws, self.chat, {"type": "user", "text": shown if shown is not None else text, "by": "browser",
                                          **(record or {})})
        messages = load_messages(self.ws, self.chat)
        self._close_open_calls(messages)  # a turn a server that stopped left open
        messages.append({"role": "user", "content": text})
        save_messages(self.ws, self.chat, messages)
        self.running = True
        self.started_at = home.now()
        chats.hub.publish(self.ws, {"type": "chat", "chat": self.chat})
        self.task = asyncio.create_task(self._turn())

    async def _stream_once(self, messages: list[dict[str, Any]], usage: Usage) -> Any:
        """One request, streamed into the log; the final message."""
        client = llm.client()
        n = count_calls(messages)
        async with client.beta.messages.stream(**self.request(messages)) as stream:
            async for ev in stream:
                t = ev.type
                if t == "text":
                    if ev.text:
                        self._append({"type": "text", "delta": ev.text})
                elif t == "content_block_stop" and getattr(ev.content_block, "type", "") == "tool_use":
                    b = ev.content_block
                    n += 1
                    self._append({"type": "tool_use", "id": b.id, "name": b.name, "input": b.input, "n": n})
            final = await stream.get_final_message()
        usage.add(final.usage)
        return final

    async def _turn(self) -> None:
        usage = Usage()
        reply: list[str] = []
        self.cards.clear()
        result: str | None = None
        messages = load_messages(self.ws, self.chat)
        try:
            retries = 0
            while True:
                try:
                    final = await self._stream_once(messages, usage)
                except ValueError as e:  # a tool input that streamed in as JSON the SDK could not read
                    retries += 1
                    if retries > STREAM_RETRIES:
                        raise RuntimeError("Claude's tool input could not be read") from e
                    continue
                except (anthropic.APIConnectionError, anthropic.InternalServerError) as e:
                    retries += 1
                    if retries > STREAM_RETRIES:
                        raise
                    self._append({"type": "notice", "kind": "retry", "text": "The connection to Claude broke off; "
                                  "it starts that step again."})
                    await asyncio.sleep(2 ** retries)
                    continue
                except anthropic.APIStatusError as e:
                    if e.status_code in (429, 529) and retries < STREAM_RETRIES:
                        retries += 1
                        await asyncio.sleep(5 * 2 ** retries)
                        continue
                    raise
                retries = 0
                for b in final.content:
                    if b.type == "text":
                        reply.append(b.text)
                messages.append({"role": "assistant", "content": [_block(b) for b in final.content]})
                save_messages(self.ws, self.chat, messages)
                if final.stop_reason == "refusal":
                    cat = getattr(getattr(final, "stop_details", None), "category", None)
                    self._append({"type": "error", "kind": "refusal",
                                  "message": "Claude declined this request" + (f" ({cat})." if cat else ".")})
                    result = "refused"
                    break
                if final.stop_reason == "pause_turn":
                    continue
                calls = [b for b in final.content if b.type == "tool_use"]
                if not calls:
                    break
                if final.stop_reason == "max_tokens":
                    messages.append({"role": "user", "content": [
                        {"type": "tool_result", "tool_use_id": b.id, "is_error": True,
                         "content": "The reply hit its length limit before this call was complete."} for b in calls]})
                    save_messages(self.ws, self.chat, messages)
                    continue
                results = await asyncio.gather(*(self.tools.call(b.name, b.input) for b in calls))
                blocks = []
                for b, r in zip(calls, results):
                    rec: dict[str, Any] = {"type": "tool_result", "id": b.id, "summary": r.text[:4000],
                                           "is_error": r.is_error}
                    if r.extra:
                        rec.update(r.extra)
                    if r.cell_id:
                        rec["cell_id"] = r.cell_id
                        try:
                            from . import canvas  # noqa: PLC0415

                            rec["notebook"] = canvas.find(self.ws, r.cell_id)[0]["id"]
                        except KeyError:
                            pass
                    self._append(rec)
                    blocks.append({"type": "tool_result", "tool_use_id": b.id, "content": _result_content(r),
                                   **({"is_error": True} if r.is_error else {})})
                messages.append({"role": "user", "content": blocks})
                save_messages(self.ws, self.chat, messages)
        except asyncio.CancelledError:
            self._close_open_calls(messages)
            result = "stopped"
            self._append({"type": "done", "result": "stopped", "usage": usage.record(), "model": self._model()})
            self.running = False
            chats.hub.publish(self.ws, {"type": "chat", "chat": self.chat})
            self.finished(result)
            raise
        except Exception as e:  # noqa: BLE001 — every failure is a row the analyst sees
            log.warning("turn failed: %s", type(e).__name__)
            self._close_open_calls(messages)
            self._append({"type": "error", "kind": "api", "message": llm.failure(e, fast=self.fast())})
            result = "failed"
        self._append({"type": "done", "result": result, "cells": list(dict.fromkeys(self.cards)),
                      "usage": usage.record(), "model": self._model()})
        self.running = False
        chats.hub.publish(self.ws, {"type": "chat", "chat": self.chat})
        self.finished(result)
        if self.role == "main":
            text_out = "".join(reply).strip()
            for fn in AFTER_TURN:
                try:
                    fn(self, text_out, result)
                except Exception:  # noqa: BLE001 — a feature's follow-up never fails the turn
                    log.exception("an after-turn hook failed")

    def _model(self) -> str:
        return settings.read()["model"]

    def _close_open_calls(self, messages: list[dict[str, Any]]) -> None:
        """Give a tool call left without its result a result, so the conversation stays valid."""
        if messages and messages[-1]["role"] == "assistant":
            open_calls = [b for b in messages[-1].get("content") or [] if b.get("type") == "tool_use"]
            if open_calls:
                messages.append({"role": "user", "content": [
                    {"type": "tool_result", "tool_use_id": b["id"], "is_error": True,
                     "content": "The analyst stopped this before it ran."} for b in open_calls]})
        save_messages(self.ws, self.chat, messages)

    def finished(self, result: str | None) -> None:
        """After a turn: the agent's own `finished`, such as a view builder's record of how it ended."""
        if self.defn.finished:
            try:
                self.defn.finished(self, result)
            except Exception:  # noqa: BLE001
                log.exception("finished() of %s failed", self.role)

    async def interrupt(self) -> bool:
        if not self.running or self.task is None:
            return False
        self.task.cancel()
        try:
            await self.task
        except (asyncio.CancelledError, Exception):  # noqa: BLE001
            pass
        return True

    async def close(self) -> None:
        await self.interrupt()


class Sessions:
    def __init__(self, *, unsandboxed: bool = False) -> None:
        self._s: dict[tuple[str, str], Session] = {}
        self.unsandboxed = unsandboxed

    def get(self, ws: str, chat: str) -> Session:
        key = (ws, chat)
        if key not in self._s:
            self._s[key] = Session(ws, chat, home.corpus_of(ws), unsandboxed=self.unsandboxed, manager=self)
        return self._s[key]

    def running(self, ws: str) -> set[str]:
        return {c for (w, c), s in self._s.items() if w == ws and s.running}

    def fork(self, ws: str, chat: str) -> None:
        """A new thread's conversation: a copy of main's, up to its last finished turn."""
        save_messages(ws, chat, complete_prefix(load_messages(ws, "main")))

    async def restart_idle(self, ws: str) -> None:
        """Nothing to restart: each request reads the settings anew."""

    async def close_all(self) -> None:
        for s in list(self._s.values()):
            await s.close()

