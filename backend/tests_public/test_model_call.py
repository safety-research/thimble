"""model_call.py: thimble's model calls through the analyst's own Claude Code session. A completion carries its
instructions and schema as a system prompt marked for the prompt cache and its part as its one message; its reply's
JSON object is checked against the schema and asked for once more when it does not fit; a reply with no text runs again
on the refusal row's model; an API error, no session and a fork each give their status; at most `modelCalls` calls run
at once. The fake bridge (subagent_fakes) plays the plugin module's $.model.complete and $.model.fork."""
from __future__ import annotations

import asyncio
import json

import pytest

from app import model_call, notices, userconf
from app.call_result import NO_SESSION, ToolSpec
from subagent_fakes import bridge  # noqa: F401 — a fixture
from terminal_fakes import terminal_ws  # noqa: F401 — a fixture

CORPUS = "mini"
OPUS, FALLBACK = "claude-opus-5-5", "claude-opus-4-8"
TOOL = ToolSpec("verdict", "Your verdict on the post.",
                {"type": "object", "properties": {"fits": {"type": "boolean"}}, "required": ["fits"],
                 "additionalProperties": False})


def replies(*answers):
    """The module's answers to the calls, in order."""
    it = iter(answers)
    return lambda op, args: next(it)


async def _ask(**kw):
    return await model_call.structured(CORPUS, "Post 7 by quill-otter: is this the release?", tool=TOOL, model=OPUS,
                                       effort="low", system="Judge whether the post is about a release.", **kw)


async def test_a_completion_carries_a_cached_system_prompt_and_its_part_and_reads_the_json_in_the_reply(bridge):
    bridge.respond = replies({"text": 'Here it is:\n```json\n{"fits": true}\n```',
                              "usage": {"input_tokens": 12, "output_tokens": 5, "cache_read_input_tokens": 900}})
    res = await _ask()
    assert res.status == "ok" and res.output == {"fits": True} and res.attempts == 1, res
    assert res.model_used == OPUS and res.usage["cache_read_input_tokens"] == 900
    [(op, args)] = bridge.calls
    assert op == "complete" and args["model"] == OPUS and args["effort"] == "low"
    [system] = args["system"]
    assert system["cache"] is True
    assert "Judge whether the post is about a release." in system["text"]
    assert "Your verdict on the post." in system["text"] and '"fits"' in system["text"]
    assert args["prompt"] == [{"text": "Post 7 by quill-otter: is this the release?"}]
    assert args["maxTokens"] == model_call.MAX_TOKENS and args["timeoutMs"] == int(model_call.TIMEOUT_S * 1000)


async def test_an_answer_that_does_not_fit_is_asked_for_once_more_with_what_is_wrong(bridge):
    bridge.respond = replies({"text": '{"fits": "maybe"}'}, {"text": '{"fits": false}'})
    res = await _ask()
    assert res.status == "ok" and res.output == {"fits": False} and res.attempts == 2
    again = bridge.calls[1][1]
    assert again["system"] == bridge.calls[0][1]["system"], "the cached system prompt again"
    text = again["prompt"][0]["text"]
    assert "Post 7 by quill-otter" in text and '{"fits": "maybe"}' in text and "does not agree with the schema" in text
    bridge.calls.clear()
    bridge.respond = replies({"text": "It is about a release."}, {"text": '{"verdict": "yes"}'})
    res = await _ask()
    assert res.status == "no_tool_call" and res.attempts == 2 and len(bridge.calls) == 2
    assert "did not agree with the schema" in res.detail and res.output is None


async def test_a_reply_with_no_text_runs_once_more_on_the_refusal_row_s_model(bridge):
    bridge.respond = replies({"failed": "empty-reply"}, {"text": '{"fits": true}'})
    res = await _ask(refusal={"model": FALLBACK, "effort": "high"})
    assert res.status == "ok" and res.refused_by == OPUS and res.model_used == FALLBACK
    assert [(a["model"], a["effort"]) for _, a in bridge.calls] == [(OPUS, "low"), (FALLBACK, "high")]
    bridge.calls.clear()
    bridge.respond = replies({"failed": "empty-reply"})
    res = await _ask(refusal=None)
    assert res.status == "refused" and len(bridge.calls) == 1 and not res.refused_by
    assert notices.failure_class(res.detail) == "refused", "the notices say Claude's safeguards"


@pytest.mark.parametrize("answer,status,cls", [
    ({"failed": "api-error", "status": 429, "kind": "rate_limit"}, "rate_limited", "rate_limited"),
    ({"failed": "api-error", "status": 529, "kind": "overloaded"}, "rate_limited", "overloaded"),
    ({"failed": "api-error", "status": 401, "kind": "authentication_failed"}, "error", "auth"),
    ({"failed": "api-error", "status": 400, "kind": "billing_error"}, "error", "billing"),
    ({"failed": "api-error", "status": None, "kind": "unknown"}, "error", None),
    ({"error": "thimble: $.model.complete: model \"x\" is not in this organization's allowlist"}, "error", None),
])
async def test_an_api_error_gives_its_status_and_words_the_notices_read(bridge, answer, status, cls):
    bridge.respond = replies(answer)
    res = await _ask(refusal={"model": FALLBACK, "effort": "high"})
    assert res.status == status and len(bridge.calls) == 1, res
    if cls is not None:
        assert notices.failure_class(res.detail) == cls, res.detail


async def test_with_no_claude_code_session_a_call_says_how_to_start_one(bridge):
    bridge.is_live = False
    res = await _ask()
    assert res.status == "no_session" and res.detail == NO_SESSION and "type /thimble" in res.detail


async def test_at_most_model_calls_run_at_once(bridge):
    path = userconf.global_file()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"modelCalls": 3}))
    assert model_call.parallel() == 3

    async def slow(op, args):
        await asyncio.sleep(0.02)
        return {"text": '{"fits": true}'}

    bridge.respond = slow
    got = await asyncio.gather(*(_ask() for _ in range(8)))
    assert all(r.status == "ok" for r in got) and bridge.most == 3 and len(bridge.calls) == 8
    path.write_text(json.dumps({"modelCalls": 0}))
    assert model_call.parallel() == userconf.MODEL_CALLS, "a value out of range is the default"


def test_model_calls_is_a_whole_number_set_in_thimble_s_home(tmp_path):
    def problems(data, scope="global"):
        return userconf._problems(data, scope, tmp_path)

    assert problems({"modelCalls": 24}) == [] and problems({"modelCalls": None}) == []
    assert "it takes a whole number from 1 to 64" in problems({"modelCalls": 0})[0]
    assert problems({"modelCalls": 2.5}) and problems({"modelCalls": True})
    assert "not per workspace" in problems({"modelCalls": 8}, "workspace")[0]


async def test_a_cancelled_call_is_cancelled_in_the_module(bridge):
    started = asyncio.Event()

    async def hang(op, args):
        started.set()
        await asyncio.sleep(30)

    bridge.respond = hang
    task = asyncio.create_task(_ask())
    await asyncio.wait_for(started.wait(), 5)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert bridge.running == 0


async def test_a_fork_asks_over_main_s_conversation_with_the_schema_and_says_when_there_is_nothing_to_fork(bridge):
    bridge.respond = replies({"text": '{"fits": true}', "usage": {"cache_read_input_tokens": 23000}})
    res = await model_call.fork(CORPUS, "Would a view of the board help?", tool=TOOL, model=OPUS)
    assert res.status == "ok" and res.output == {"fits": True} and res.usage["cache_read_input_tokens"] == 23000
    [(op, args)] = bridge.calls
    assert op == "fork" and set(args) == {"prompt", "timeout_s"}
    assert args["prompt"].startswith("Would a view of the board help?")
    assert "You have no tools" in args["prompt"] and '"fits"' in args["prompt"]
    bridge.respond = replies({"failed": "nothing-to-fork"})
    res = await model_call.fork(CORPUS, "Would a view of the board help?", tool=TOOL)
    assert res.status == "stopped" and res.detail == model_call.NOTHING_TO_FORK


async def test_on_local_transport_a_model_call_s_request_and_answer_are_files_of_their_own(terminal_ws, monkeypatch):
    """No prompt goes through subagents.json or module.json: the entry names the request's file, the module writes the
    answer's file, and both, and the entry, go once the answer is read."""
    from app import config, module_bridge, subagent_files as sf
    from terminal_fakes import FileModule

    long_part = "quill-otter wrote: " + "the release slipped again. " * 2000
    seen_entries: list[dict] = []

    def answer(op, args):
        seen_entries.extend(r for r in sf.requests(sf.read(terminal_ws)).values() if r.get("op") == op)
        return {"text": '{"fits": true}', "usage": {"output_tokens": 4}}

    mod = FileModule(terminal_ws, answer=answer).start()
    try:
        res = await model_call.structured(CORPUS, long_part, tool=TOOL, model=OPUS, effort="low", system="Judge it.")
    finally:
        mod.stop()
    assert res.status == "ok" and res.output == {"fits": True}, res
    [(_rid, op, args)] = mod.seen
    assert op == "complete" and args["prompt"] == [{"text": long_part}] and args["model"] == OPUS
    assert [list(e["args"]) for e in seen_entries] == [["call"]], "the entry names the request's file alone"
    assert not [r for r in sf.requests(sf.read(terminal_ws)).values() if r.get("op") == "complete"]
    assert not list((sf.trusted_dir(config.workspace_dir(CORPUS)) / module_bridge.COMPLETIONS).iterdir())
    assert "quill-otter" not in sf.state_path(terminal_ws).read_text() + sf.module_path(terminal_ws).read_text()


async def test_on_local_transport_a_model_call_no_module_takes_expires(terminal_ws, monkeypatch):
    from app import module_bridge
    from terminal_fakes import FileModule

    monkeypatch.setattr(module_bridge, "REQUEST_TIMEOUT_S", 0.3)
    mod = FileModule(terminal_ws, answer=lambda op, args: None)
    mod.write()  # a heartbeat, and no module that takes anything
    res = await _ask()
    assert res.status == "error" and res.detail == model_call.NOT_ANSWERING
    assert not mod.seen
