"""A stand-in for the Messages API client, so the agents' loops run in tests without calling Claude.

`ScriptedClient(script)` answers each request with `script(request)`: a list of blocks, each a str (text) or a dict
{"tool": name, "input": {...}} (a tool call), or an awaitable of one. `complete` replies come from `answer(system,
user)`.
"""
from __future__ import annotations

import inspect
import secrets
from types import SimpleNamespace
from typing import Any, Callable


class Block(SimpleNamespace):
    def model_dump(self, mode: str = "json", exclude_none: bool = True) -> dict[str, Any]:
        return {k: v for k, v in self.__dict__.items() if v is not None}


def blocks_of(items: list[Any]) -> list[Block]:
    out = []
    for it in items:
        if isinstance(it, str):
            out.append(Block(type="text", text=it))
        else:
            out.append(Block(type="tool_use", id="toolu_" + secrets.token_hex(6), name=it["tool"],
                             input=it.get("input") or {}))
    return out


class Stream:
    def __init__(self, items: Any) -> None:
        self.items = items
        self.final: Any = None

    async def __aenter__(self) -> "Stream":
        items = self.items
        if inspect.isawaitable(items):
            items = await items
        content = blocks_of(items)
        stop = "tool_use" if any(b.type == "tool_use" for b in content) else "end_turn"
        self.final = SimpleNamespace(content=content, stop_reason=stop,
                                     usage=SimpleNamespace(input_tokens=10, output_tokens=5,
                                                           cache_read_input_tokens=0, cache_creation_input_tokens=0))
        return self

    async def __aexit__(self, *exc: Any) -> bool:
        return False

    def __aiter__(self) -> Any:
        return self._events()

    async def _events(self) -> Any:
        for b in self.final.content:
            if b.type == "text":
                yield SimpleNamespace(type="text", text=b.text)
            else:
                yield SimpleNamespace(type="content_block_stop", content_block=b)

    async def get_final_message(self) -> Any:
        return self.final


class ScriptedClient:
    def __init__(self, script: Callable[[dict[str, Any]], Any] | None = None,
                 answer: Callable[[str, Any], str] | None = None) -> None:
        self.script = script
        self.answer = answer
        self.requests: list[dict[str, Any]] = []
        self.completions: list[dict[str, Any]] = []
        self.beta = SimpleNamespace(messages=SimpleNamespace(stream=self._stream, create=self._create))

    def _stream(self, **req: Any) -> Stream:
        self.requests.append(req)
        assert self.script is not None, "no script for an agent's request"
        return Stream(self.script(req))

    async def _create(self, **req: Any) -> Any:
        self.completions.append(req)
        assert self.answer is not None, "no answer for a one-shot call"
        text = self.answer(req["system"], req["messages"][0]["content"])
        return SimpleNamespace(stop_reason="end_turn", content=[SimpleNamespace(type="text", text=text)])


def turns(req: dict[str, Any]) -> int:
    """How many replies the agent gave before this request."""
    return sum(1 for m in req["messages"] if m["role"] == "assistant")


def last_result(req: dict[str, Any]) -> str:
    """The text of the last tool result the request carries."""
    for m in reversed(req["messages"]):
        if m["role"] == "user" and isinstance(m["content"], list):
            for b in m["content"]:
                if b.get("type") == "tool_result":
                    return str(b.get("content"))
    return ""
