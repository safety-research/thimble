"""A sample of each format the sniff reads (fixtures/transcripts/<family>/<format>/, synthetic): a Claude Code session
(a stream), ShareGPT conversations, an ATIF trajectory (a whole-file JSON transcript) and a Codex CLI rollout
(messages). The sniff reads each, and the Transcript mode gets each turn with who speaks, its tool calls (name and
arguments) with their results, its reasoning, and the fields Color by offers. A log of trace spans, whose messages are copies
inside requests, is left for Raw and the Table (EXPECT says None)."""
import collections
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
    "anthropic/claude-code-jsonl/projects/-home-dev-src-inventory-api/e1665325-e620-4455-84d5-b3319689bc30.jsonl":
        ("stream", 32, {"assistant", "user", "summary", "file-history-snapshot"}, 9, 9, 3, None),
    "chat/sharegpt/hermes_function_calling.jsonl": ("conversations", 20, {"system", "human", "gpt", "tool"}, 8, 8, 4, None),
    "evals/harbor-atif/jobs/2026-10-09__08-02-37/build-wordfreq__Lm4R9tw/agent/trajectory.json":
        ("json", 9, {"user", "gpt-5-2025-08-07"}, 8, 8, 7, "source"),
    "openai/agents-sdk-trace/trace.jsonl": None,
    "openai/codex-rollout/sessions/2026/10/12/rollout-2026-10-12T09-41-07-01a130fd-458e-7149-bf00-4bed2b8d2148.jsonl":
        ("messages", 29, {"developer", "user", "assistant", "tool"}, 8, 8, 5, "payload.type"),
}

# JSON lines are kept as `<name>.jsonl.txt`, since no .jsonl file belongs in the tree (scripts/check_content.py), and
# logs as `<name>.log.txt`, since git ignores *.log; both are copied into the corpus under their own names
KEPT = (".jsonl.txt", ".log.txt")


@pytest.fixture()
def formats(tmp_path, monkeypatch, mini_dir):
    """A DATA_DIR whose corpus `formats` (a copy of mini) holds every sample under its own path."""
    from app import config

    data = tmp_path / "data"
    shutil.copytree(mini_dir, data / "formats")
    shutil.copytree(SAMPLES, data / "formats", dirs_exist_ok=True)
    for p in [p for p in (data / "formats").rglob("*.txt") if p.name.endswith(KEPT)]:
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


@pytest.mark.parametrize("rel", sorted(EXPECT))
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
