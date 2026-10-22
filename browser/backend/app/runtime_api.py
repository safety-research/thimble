"""One turn of an agent on the Messages API, run in this process (runtime.py's `api` engine): for an API key or
Workload Identity Federation, with no `claude` process.

The loop: send the conversation, streaming; write the reply into the agent's transcript (Conv.emit_assistant); run the
tools it called (thimble's through Conv.call_thimble, the built-in ones through runtime_tools) and write their results;
go on until the reply calls no tool. The conversation is kept in <workspace>/runtime/convs/<id>.api.json, so it goes on
after a restart; a fork starts from a copy of main's, up to main's last finished turn. A stopped turn gives every call
left without a result one that says so, so the conversation stays valid.
"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

from . import llm, runtime_tools

log = logging.getLogger("thimble.runtime_api")

MAX_TOKENS = 64000
STREAM_RETRIES = 3
STOPPED = "The analyst stopped this before it ran."


def _load(path: Any) -> list[dict[str, Any]]:
    try:
        got = json.loads(path.read_text("utf-8"))
    except (OSError, ValueError):
        return []
    return got if isinstance(got, list) else []


def _save(path: Any, messages: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(messages, ensure_ascii=False), encoding="utf-8")
    tmp.replace(path)


def complete_prefix(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The longest start of `messages` that ends with an assistant turn calling no tool: what a fork copies."""
    out = list(messages)
    while out:
        last = out[-1]
        open_call = last["role"] == "assistant" and any(
            isinstance(b, dict) and b.get("type") == "tool_use" for b in last.get("content") or [])
        if last["role"] == "assistant" and not open_call:
            break
        out.pop()
    return out


def close_open_calls(messages: list[dict[str, Any]]) -> None:
    if messages and messages[-1]["role"] == "assistant":
        calls = [b for b in messages[-1].get("content") or [] if isinstance(b, dict) and b.get("type") == "tool_use"]
        if calls:
            messages.append({"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": b["id"], "is_error": True, "content": STOPPED} for b in calls]})


def _api_content(content: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """A thimble tool's MCP content as the Messages API takes a tool result: text, and images as base64 sources."""
    out: list[dict[str, Any]] = []
    for b in content:
        if b.get("type") == "image" and b.get("data"):
            out.append({"type": "image", "source": {"type": "base64", "media_type": b.get("mimeType") or "image/png",
                                                     "data": b["data"]}})
        elif b.get("type") == "text":
            out.append({"type": "text", "text": str(b.get("text") or "") or "(no output)"})
    return out or [{"type": "text", "text": "(no output)"}]


def tool_entries(spec: Any) -> list[dict[str, Any]]:
    from . import tools  # noqa: PLC0415

    secs = tools.tool_sections(spec.thimble)
    out = [{"name": n, "description": secs[n][0], "input_schema": secs[n][1]} for n in spec.thimble if n in secs]
    out += runtime_tools.definitions(spec.builtins)
    if out:
        out[-1] = {**out[-1], "cache_control": {"type": "ephemeral"}}
    return out


def request(spec: Any, messages: list[dict[str, Any]]) -> dict[str, Any]:
    args = llm.request_args(model=spec.model, effort=spec.effort, fast=spec.fast)
    if "WebFetch" in spec.builtins:
        args["betas"] = [*args.get("betas", []), runtime_tools.WEB_FETCH_BETA]
    body: dict[str, Any] = {"max_tokens": MAX_TOKENS, "messages": messages, "tools": tool_entries(spec),
                            "system": [{"type": "text", "text": spec.system, "cache_control": {"type": "ephemeral"}}],
                            "cache_control": {"type": "ephemeral"}, **args}
    if not str(args["model"]).startswith("claude-haiku"):
        body["thinking"] = {"type": "adaptive"}
    return body


async def _stream(client: Any, body: dict[str, Any]) -> Any:
    async with client.beta.messages.stream(**body) as stream:
        async for _ in stream:
            pass
        return await stream.get_final_message()


async def _call(conv: Any, box: runtime_tools.Box, block: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    """Run one tool call: (the result as the transcript writes it, the result as the conversation sends it)."""
    from . import tools  # noqa: PLC0415

    name, args, tid = str(block["name"]), block.get("input") or {}, str(block["id"])
    if tools.known(name):
        res = await conv.call_thimble(name, args if isinstance(args, dict) else {}, tid)
        content = [b for b in res.content if isinstance(b, dict)]
        api = _api_content(content)
        rec_content: Any = [b if b.get("type") == "text" else {"type": "image", "source": {
            "type": "base64", "media_type": b.get("mimeType") or "image/png", "data": b.get("data")}}
            for b in content if b.get("type") in ("text", "image")]
        is_error = bool(res.is_error)
    else:
        out = await runtime_tools.call(box, name, args if isinstance(args, dict) else {})
        api, rec_content, is_error = out.text or "(no output)", out.text, out.is_error
    rec = {"type": "tool_result", "tool_use_id": tid, "content": rec_content, **({"is_error": True} if is_error else {})}
    msg = {"type": "tool_result", "tool_use_id": tid, "content": api, **({"is_error": True} if is_error else {})}
    return rec, msg


async def turn(conv: Any, text: str) -> Any:
    from . import runtime  # noqa: PLC0415

    spec = conv.spec()
    path = conv.state_path("api")
    messages = _load(path)
    if not messages and conv.base:
        base = conv.space.main if conv.base == runtime.MAIN else conv.space.convs.get(conv.base)
        if base is not None:
            messages = complete_prefix(_load(base.state_path("api")))
    close_open_calls(messages)
    messages.append({"role": "user", "content": text})
    _save(path, messages)
    box = runtime_tools.Box(cwd=spec.cwd, workspace=spec.workspace, read_roots=spec.read_roots,
                            write_roots=spec.write_roots, private=spec.private, home=spec.home)
    client = llm.client()
    reply = ""
    try:
        retries = 0
        while True:
            body = request(spec, messages)
            try:
                final = await _stream(client, body)
            except Exception as e:  # noqa: BLE001 — a broken stream is sent again a few times
                import anthropic  # noqa: PLC0415

                transient = isinstance(e, (anthropic.APIConnectionError, anthropic.InternalServerError)) or (
                    isinstance(e, anthropic.APIStatusError) and e.status_code in (429, 529))
                if not transient or retries >= STREAM_RETRIES:
                    raise
                retries += 1
                await asyncio.sleep(2 ** retries)
                continue
            retries = 0
            content = [b.model_dump(mode="json", exclude_none=True) for b in final.content]
            messages.append({"role": "assistant", "content": content})
            _save(path, messages)
            blocks, server_results = runtime_tools.server_blocks_to_records(content)
            usage = final.usage.model_dump(mode="json", exclude_none=True) if getattr(final, "usage", None) else {}
            conv.emit_assistant(blocks, str(getattr(final, "model", "") or spec.model), usage)
            conv.emit_results(server_results)
            said = "".join(b.get("text", "") for b in blocks if b.get("type") == "text").strip()
            if said:
                reply = said
            if final.stop_reason == "refusal":
                raise runtime.Refused("Claude's safeguards declined this request. Rephrase or narrow it, or choose "
                                      "another model in Settings.")
            if final.stop_reason == "pause_turn":
                continue
            calls = [b for b in content if b.get("type") == "tool_use"]
            if not calls:
                break
            if final.stop_reason == "max_tokens":
                cut = [{"type": "tool_result", "tool_use_id": b["id"], "is_error": True,
                        "content": "The reply hit its length limit before this call was complete."} for b in calls]
                messages.append({"role": "user", "content": cut})
                _save(path, messages)
                conv.emit_results(cut)
                continue
            done = await asyncio.gather(*(_call(conv, box, b) for b in calls))
            conv.emit_results([r for r, _ in done])
            messages.append({"role": "user", "content": [m for _, m in done]})
            _save(path, messages)
    except asyncio.CancelledError:
        close_open_calls(messages)
        _save(path, messages)
        raise
    return runtime.TurnEnd("done", text=reply)
