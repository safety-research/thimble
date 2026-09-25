"""A stand-in for the Messages API on model.structured's key path (model._make_api_client), for tests that run a caller
of model.structured whole: each request is answered by `answer(request)`, a tool input returned as the forced tool's
call, or None for a response a safety classifier stopped (`stop_reason: refusal`), each after `delay_s`. No request
leaves the process."""
from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any, Callable

from anthropic.types import Message, TextBlock, ToolUseBlock, Usage

FALLBACK = "claude-opus-4-8"


class _Stream:
    def __init__(self, message: Message, delay_s: float) -> None:
        self._message = message
        self._delay_s = delay_s

    def __aiter__(self):
        return self._events()

    async def _events(self):
        yield {"type": "message_start"}
        await asyncio.sleep(self._delay_s)
        yield {"type": "message_stop"}

    async def get_final_message(self) -> Message:
        return self._message


class _Manager:
    def __init__(self, message: Message, delay_s: float) -> None:
        self._message = message
        self._delay_s = delay_s

    async def __aenter__(self) -> _Stream:
        return _Stream(self._message, self._delay_s)

    async def __aexit__(self, *exc: Any) -> bool:
        return False


class StubMessages:
    """The client: `requests` keeps every request's keyword arguments in order, fast mode's beta ones included."""

    def __init__(self, answer: Callable[[dict[str, Any]], dict | None], delay_s: float = 0.0) -> None:
        self.answer = answer
        self.delay_s = delay_s
        self.requests: list[dict[str, Any]] = []
        self.messages = SimpleNamespace(stream=self._stream)
        self.beta = SimpleNamespace(messages=SimpleNamespace(stream=self._stream))

    def _stream(self, **kwargs: Any) -> _Manager:
        self.requests.append(kwargs)
        got = self.answer(kwargs)
        usage = Usage(input_tokens=10, output_tokens=5)
        if got is None:
            msg = Message(id=f"m{len(self.requests)}", type="message", role="assistant", model=kwargs["model"],
                          stop_reason="refusal", stop_sequence=None, usage=usage,
                          content=[TextBlock(type="text", text="I can't help with that.")])
        else:
            tool = kwargs["tools"][0]["name"]
            msg = Message(id=f"m{len(self.requests)}", type="message", role="assistant", model=kwargs["model"],
                          stop_reason="tool_use", stop_sequence=None, usage=usage,
                          content=[ToolUseBlock(type="tool_use", id=f"t{len(self.requests)}", name=tool, input=got)])
        return _Manager(msg, self.delay_s)


def install(monkeypatch: Any, answer: Callable[[dict[str, Any]], dict | None], delay_s: float = 0.0) -> StubMessages:
    """Route model.structured to the key path with a stub credential and this client, the fallback model FALLBACK."""
    from app import model

    stub = StubMessages(answer, delay_s)
    monkeypatch.setattr(model, "_make_api_client", lambda cred=None: stub)
    monkeypatch.setattr(model.config, "api_credentials", lambda: ("api_key", "sk-test-fake"))
    monkeypatch.setattr(model.config, "FALLBACK_MODEL", FALLBACK)
    monkeypatch.setenv("THIMBLE_MODEL_BACKEND", "api")
    return stub


def refusing(model_name: str, answer: Callable[[dict[str, Any]], dict]) -> Callable[[dict[str, Any]], dict | None]:
    """An `answer` that refuses every request on `model_name` and answers the others with `answer`."""
    return lambda req: None if req["model"] == model_name else answer(req)
