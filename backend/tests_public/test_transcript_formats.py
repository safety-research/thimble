"""Every sample transcript format (fixtures/transcripts/<family>/<format>/, synthetic): the sniff reads it, and the
Transcript mode gets each turn with who speaks, its tool calls (name and arguments) with their results, its reasoning,
and the fields Color by offers. A few formats are left for Raw and the Table (EXPECT says None): a log of tasks, of API
calls or of trace spans, whose messages, where it holds any, are copies inside requests."""
import collections
import json
import shutil
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import transcripts
from app.main import app

client = TestClient(app)
SAMPLES = Path(__file__).parent / "fixtures" / "transcripts"
API = "/api/corpora/formats"

# file -> (the sniff's format, turns, who speaks among them, tool calls, tool results, reasoning blocks, a field Color by
# offers), or None for a file the sniff leaves to Raw. A stream's turns are its records; its blocks are made by the view
# (transcript.tsx streamBlocks), so they count its content blocks.
EXPECT: dict[str, tuple | None] = {
    "anthropic/agent-sdk-stream/stream-json-partial.jsonl": ("stream", 90, {"assistant", "user", "stream_event", "result"}, 6, 6, 3, None),
    "anthropic/agent-sdk-stream/stream-json.jsonl": ("stream", 34, {"assistant", "user", "system", "result"}, 8, 8, 3, None),
    "anthropic/claude-code-jsonl/projects/-home-dev-src-inventory-api/e1665325-e620-4455-84d5-b3319689bc30.jsonl":
        ("stream", 32, {"assistant", "user", "summary", "file-history-snapshot"}, 9, 9, 3, None),
    "anthropic/claude-code-jsonl/projects/-home-dev-src-inventory-api/e1665325-e620-4455-84d5-b3319689bc30/subagents/agent-6bb094a541da4013.jsonl":
        ("stream", 9, {"assistant", "user"}, 3, 3, 0, None),
    "anthropic/messages-api-json/browsing-agent.json": ("json", 9, {"system", "user", "assistant"}, 5, 5, 3, "tool"),
    "anthropic/messages-api-json/coding-agent.json": ("json", 11, {"system", "user", "assistant"}, 5, 5, 4, "tool"),
    "chat/autogen/autogen_logs/runtime.log": None,
    "chat/autogen/team_state.json": ("json", 34, {"user", "coder", "reviewer", "FunctionExecutionResultMessage"}, 10, 10, 10, "source"),
    "chat/chatgpt-export/conversations.json": ("json", 19, {"user", "assistant", "browser", "python"}, 6, 6, 1, "recipient"),
    "chat/crewai/crew_log.json": None,
    "chat/crewai/logs.txt": None,
    "chat/gemini-contents/checkpoint-fix-parse-amount.json": ("json", 14, {"user", "model"}, 6, 6, 0, "role"),
    "chat/gemini-contents/release_researcher/c01793d5-3a2a-4327-af5a-2be7cd260638.session.json":
        ("json", 10, {"user", "coordinator", "researcher"}, 4, 4, 3, "modelVersion"),
    "chat/hf-messages/agent_trajectories.jsonl": ("conversations", 21, {"system", "user", "assistant", "tool"}, 8, 8, 7, None),
    "chat/hf-messages/tool_use_conversations.json": ("json", 18, {"developer", "user", "assistant", "tool"}, 6, 6, 7, "tool"),
    "chat/langchain-langsmith/chat_history.json": ("json", 8, {"system", "human", "ai", "tool"}, 3, 3, 1, "type"),
    "chat/langchain-langsmith/runs.jsonl": None,
    "chat/sharegpt/hermes_function_calling.jsonl": ("conversations", 20, {"system", "human", "gpt", "tool"}, 8, 8, 4, None),
    "chat/sharegpt/llamafactory_toolcall.json": ("json", 22, {"human", "function_call", "observation", "gpt"}, 8, 8, 2, "from"),
    "evals/harbor-atif/jobs/2026-10-08__16-40-51/csv-dedupe__7pQmX2k/agent/trajectory.json":
        ("json", 12, {"system", "user", "claude-sonnet-4-5-20250929"}, 10, 10, 5, "source"),
    "evals/harbor-atif/jobs/2026-10-09__08-02-37/build-wordfreq__Lm4R9tw/agent/trajectory.json":
        ("json", 9, {"user", "gpt-5-2025-08-07"}, 8, 8, 7, "source"),
    "evals/inspect-ai-json/2026-10-12T20-04-12-00-00_fix-slugify_2XgA6yxF3UkFA7SyxZYe7Y.json":
        ("json", 17, {"system", "user", "assistant", "tool"}, 7, 7, 5, "tool"),
    "evals/inspect-ai-json/2026-10-12T20-04-36-00-00_lighthouse-qa_k6jhqffMghXNssuG9AVvTN.json":
        ("json", 23, {"system", "user", "assistant", "tool"}, 9, 9, 0, "tool"),
    "evals/swe-agent-traj/trajectories/evaluser/anthropic_filemap__claude-sonnet-4-5-20250929__t-0.00__p-1.00__c-3.00___textkit__textkit-42/textkit__textkit-42/textkit__textkit-42.traj":
        ("json", 22, {"system", "user", "assistant", "tool"}, 10, 10, 4, "message_type"),
    # SWE-agent without function calls: each command is in the assistant's words, its output a user turn
    "evals/swe-agent-traj/trajectories/evaluser/gpt4__pyconfigkit__default__t-0.00__p-0.95__c-3.00__install-1/pyconfigkit__pyconfigkit-17.traj":
        ("json", 22, {"system", "user", "assistant"}, 0, 0, 0, "message_type"),
    "openai/agents-sdk-trace/ingest-batch.json": ("json", 11, {"assistant"}, 2, 0, 0, None),
    "openai/agents-sdk-trace/trace.jsonl": None,
    "openai/chat-completions/messages.json": ("json", 13, {"system", "user", "assistant", "tool"}, 5, 5, 1, "name"),
    "openai/chat-completions/train.jsonl": ("conversations", 19, {"system", "developer", "user", "assistant", "tool"}, 4, 4, 0, None),
    "openai/codex-rollout/sessions/2025/10/06/rollout-2025-10-06T16-42-10-0199bb42-a31b-7542-8c5f-b7a0d396b3a5.jsonl":
        ("messages", 15, {"user", "assistant", "tool"}, 4, 4, 3, "payload.type"),
    "openai/codex-rollout/sessions/2026/10/12/rollout-2026-10-12T09-41-07-01a130fd-458e-7149-bf00-4bed2b8d2148.jsonl":
        ("messages", 29, {"developer", "user", "assistant", "tool"}, 8, 8, 5, "payload.type"),
    "openai/responses-api/items.json": ("json", 19, {"developer", "user", "assistant", "tool"}, 4, 4, 5, "type"),
    "openai/responses-api/responses.jsonl": ("conversations", 12, {"assistant"}, 4, 0, 5, None),
}

# JSON lines are kept as `<name>.jsonl.txt`, since no .jsonl file belongs in the tree (scripts/check_content.py), and
# copied into the corpus under their own names
KEPT = ".jsonl.txt"
FILES = sorted(str(p.relative_to(SAMPLES)).removesuffix(".txt") if p.name.endswith(KEPT) else str(p.relative_to(SAMPLES))
               for p in SAMPLES.rglob("*") if p.is_file())


@pytest.fixture()
def formats(tmp_path, monkeypatch, mini_dir):
    """A DATA_DIR whose corpus `formats` (a copy of mini) holds every sample under its own path."""
    from app import config

    data = tmp_path / "data"
    shutil.copytree(mini_dir, data / "formats")
    shutil.copytree(SAMPLES, data / "formats", dirs_exist_ok=True)
    for p in (data / "formats").rglob(f"*{KEPT}"):
        p.rename(p.with_name(p.name.removesuffix(".txt")))
    monkeypatch.setattr(config, "DATA_DIR", data.resolve())
    monkeypatch.setattr(transcripts, "_SNIFFS", type(transcripts._SNIFFS)())
    monkeypatch.setattr(transcripts, "_TURNS", type(transcripts._TURNS)())
    return data / "formats"


def _content_kinds(rec: dict) -> list[str]:
    """A stream record's content blocks' kinds, as the view makes its blocks."""
    content = (rec.get("message") or {}).get("content") if isinstance(rec.get("message"), dict) else None
    return [b["type"] for b in content if isinstance(b, dict) and b.get("type") in ("tool_use", "tool_result", "thinking", "text")] if isinstance(content, list) else []


def shown(rel: str) -> tuple[dict, list[tuple[str, list[str], dict]]]:
    """The sniff of a file and the turns its Transcript mode shows: (who speaks, the kinds of its blocks, its fields)."""
    page = client.get(f"{API}/source", params={"path": rel, "count": 500}).json()
    hint = page.get("transcript")
    if not hint:
        return {}, []
    if hint["format"] == "json":
        turns = client.get(f"{API}/source/turns", params={"path": rel, "count": 500}).json()["turns"]
        return hint, [(t["speaker"], [b["kind"] for b in t.get("blocks") or []], t.get("fields") or {}) for t in turns]
    out = []
    for r in page["records"]:
        rec, meta = r["record"], r["meta"]
        if hint["format"] == "stream":
            out.append((rec.get("type") or "", _content_kinds(rec), meta.get("fields") or {}))
        elif hint["format"] == "conversations":
            # the server gives a line's turns where one holds more than words, else the view reads them itself
            for t in meta.get("turns") or transcripts.conversation_of(rec) or []:
                out.append((t["speaker"], [b["kind"] for b in t.get("blocks") or []], {}))
        elif (m := transcripts.message_of(rec)) is not None:
            out.append((meta.get("speaker") or m["speaker"], [b["kind"] for b in meta.get("blocks") or []],
                        {**{k: v for k, v in rec.items() if not isinstance(v, (dict, list))}, **(meta.get("fields") or {})}))
    return hint, out


def test_every_sample_has_its_expectation():
    assert sorted(EXPECT) == FILES


@pytest.mark.parametrize("rel", FILES)
def test_each_format_shows_its_turns_speakers_tool_calls_results_and_reasoning(formats, rel):
    hint, turns = shown(rel)
    want = EXPECT[rel]
    if want is None:
        assert not hint, f"{rel} is left to Raw, but the sniff reads it: {hint}"
        return
    fmt, n, speakers, calls, results, thinking, field = want
    assert hint["format"] == fmt and hint["score"] in (transcripts.STRONG, 1.0), hint
    assert len(turns) == n
    assert speakers <= {s for s, _, _ in turns}, sorted({s for s, _, _ in turns})
    kinds = collections.Counter(k for _, ks, _ in turns for k in ks)
    assert (kinds["tool_use"], kinds["tool_result"], kinds["thinking"]) == (calls, results, thinking), dict(kinds)
    if field:
        assert any(field in f for _, _, f in turns), f"no turn offers {field!r} to Color by"


def test_a_tool_call_shows_its_name_and_arguments_and_its_result_its_output(formats):
    """In each family, a tool call's block reads `<name>` over its arguments as indented JSON, and its result's block its
    output, cleaned of the envelope a format keeps it in (an ATIF observation, Codex CLI's JSON string)."""
    atif = "evals/harbor-atif/jobs/2026-10-09__08-02-37/build-wordfreq__Lm4R9tw/agent/trajectory.json"
    turns = client.get(f"{API}/source/turns", params={"path": atif}).json()["turns"]
    step = next(t for t in turns if t["n"] == 3)  # step_id 3: one call, its result naming it
    *_, call, result = step["blocks"]
    name, _, args = call["text"].partition("\n")
    assert (call["kind"], name, json.loads(args)["keystrokes"]) == ("tool_use", "bash_command", "make\n")
    assert result["kind"] == "tool_result" and "cannot open output file" in result["text"]
    two = next(t for t in turns if t["n"] == 2)  # two calls answered by one result that names neither: after both
    assert [b["kind"] for b in two["blocks"]][-3:] == ["tool_use", "tool_use", "tool_result"]
    codex = "openai/codex-rollout/sessions/2025/10/06/rollout-2025-10-06T16-42-10-0199bb42-a31b-7542-8c5f-b7a0d396b3a5.jsonl"
    page = client.get(f"{API}/source", params={"path": codex}).json()
    result = next(b for r in page["records"] for b in r["meta"].get("blocks") or [] if b["kind"] == "tool_result")
    assert not result["text"].startswith('{"output"'), "the output, not the JSON string around it"
